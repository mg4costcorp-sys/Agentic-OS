import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// graphify graph.json (NetworkX node-link):
//   nodes: { id, label, file_type, community, source_file }
//   links: { source, target, relation, confidence (EXTRACTED|INFERRED|AMBIGUOUS), weight }
export type GNode = {
  id: string;
  label?: string;
  norm_label?: string;
  file_type?: string;
  community?: number;
  source_file?: string;
};
export type GLink = {
  source: string;
  target: string;
  relation?: string;
  confidence?: string;
  weight?: number;
};
export type GraphData = { nodes: GNode[]; links: GLink[] };

export const PALETTE = [
  "#3ddc97", "#60a5fa", "#a78bfa", "#f472b6", "#f5b14c", "#7be0c8",
  "#ef5a5a", "#e6ebf2", "#fbbf24", "#34d399", "#818cf8", "#fb7185",
  "#22d3ee", "#c084fc", "#4ade80", "#fda4af",
];

type ForceGraphModule = typeof import("react-force-graph-3d").default;
type ThreeModule = typeof import("three");
type UnrealBloomPassCtor =
  typeof import("three/examples/jsm/postprocessing/UnrealBloomPass.js").UnrealBloomPass;

const esc = (s: string) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const idOf = (v: any) => (typeof v === "object" && v ? v.id : v);
const shortPath = (p: string) => String(p).replace(/^.*\/(?=[^/]+\/[^/]+$)/, "…/");
export const colorForCommunity = (community: number, accent: string) =>
  community === 0 ? accent : PALETTE[community % PALETTE.length];

const DIM = 0.32;

export function GraphifyGraph3D({
  graph,
  accent = "#3ddc97",
  embedded = false,
  maxNodes = 1000,
  onSelect,
  onMeta,
  pinnedId = null,
  tooltip,
  hideLegend = false,
  onBackground,
  spread = 1,
  bloomStrength = 0.78,
}: {
  graph: GraphData;
  accent?: string;
  embedded?: boolean;
  maxNodes?: number;
  onSelect?: (n: any) => void;
  onMeta?: (m: { shown: number; total: number; capped: boolean }) => void;
  pinnedId?: string | null;
  /** Custom hover-tooltip HTML — defaults to the graphify file/cluster card. */
  tooltip?: (n: any) => string;
  /** Hide the EXTRACTED/INFERRED legend (for callers with their own key). */
  hideLegend?: boolean;
  /** Fired when the user clicks empty space (useful to release a pin). */
  onBackground?: () => void;
  /**
   * Layout scale multiplier. 1 = the dense code-graph tuning; raise it
   * (~2.5) for small graphs (e.g. a personal vault) so nodes separate
   * enough to read instead of collapsing into one bloomed ball.
   */
  spread?: number;
  /** Bloom pass strength — lower it for small bright graphs (default 0.78). */
  bloomStrength?: number;
}) {
  const [Graph, setGraph] = useState<ForceGraphModule | null>(null);
  const [THREE, setTHREE] = useState<ThreeModule | null>(null);
  const [BloomPass, setBloomPass] = useState<UnrealBloomPassCtor | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const [hoverId, setHoverId] = useState<string | null>(null);
  const hoverIdRef = useRef<string | null>(null);
  hoverIdRef.current = hoverId;
  const pinnedIdRef = useRef<string | null>(pinnedId);
  pinnedIdRef.current = pinnedId;
  const [rotating, setRotating] = useState(true);
  // View density. "full" (default) = the whole connected web — the gorgeous
  // dense view. "core" = only the most-connected load-bearing nodes, for a
  // cleaner read of the skeleton. Mirrors the Memory section's full/lite.
  const [density, setDensity] = useState<"full" | "core">("full");
  const densityRef = useRef(density);
  densityRef.current = density;
  const rotatingRef = useRef(rotating);
  rotatingRef.current = rotating;

  const angleRef = useRef(0);
  const orbitDistRef = useRef(embedded ? 280 : 400); // fitted TARGET distance
  const orbitDistCurRef = useRef(embedded ? 280 : 400); // eased CURRENT distance
  // Timestamp of the last user camera drag. While dragging (and for a
  // moment after), we suspend the auto-orbit so the user's rotation isn't
  // fought by the per-frame cameraPosition() call — makes manual rotate
  // feel responsive instead of "sticky".
  const lastDragRef = useRef(0);
  const nodeMatsRef = useRef<Map<string, { m: any; base: number }[]>>(new Map());
  const lastHiRef = useRef<string | null | undefined>(undefined);
  const pendingFlyRef = useRef<string | null>(null);

  // active highlight = hovered node, else pinned (god-node click)
  const activeHi = () => hoverIdRef.current ?? pinnedIdRef.current;

  useEffect(() => {
    let alive = true;
    Promise.all([
      import("react-force-graph-3d"),
      import("three"),
      import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
    ]).then(([g, t, b]) => {
      if (!alive) return;
      setGraph(() => g.default);
      setTHREE(t);
      setBloomPass(() => b.UnrealBloomPass);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const data = useMemo(() => {
    const nodesRaw = graph?.nodes ?? [];
    const linksRaw = graph?.links ?? [];
    const deg = new Map<string, number>();
    for (const l of linksRaw) {
      const s = idOf(l.source);
      const t = idOf(l.target);
      deg.set(s, (deg.get(s) ?? 0) + 1);
      deg.set(t, (deg.get(t) ?? 0) + 1);
    }
    let nodes = nodesRaw;
    let capped = false;
    if (nodes.length > maxNodes) {
      nodes = [...nodesRaw]
        .sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0))
        .slice(0, maxNodes);
      capped = true;
    }
    // "core" density → keep only the most-connected skeleton (top ~35%,
    // and always at least degree-2 nodes) so the load-bearing structure is
    // readable without the long tail of leaf files. "full" keeps everything.
    if (density === "core" && nodes.length > 24) {
      const ranked = [...nodes].sort(
        (a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0),
      );
      const keepN = Math.max(24, Math.round(ranked.length * 0.35));
      nodes = ranked.slice(0, keepN).filter((n) => (deg.get(n.id) ?? 0) >= 2);
      capped = true;
    }
    const keep = new Set(nodes.map((n) => n.id));
    const godSet = new Set(
      [...nodes].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0)).slice(0, 6).map((n) => n.id),
    );
    const vnodes = nodes.map((n) => ({
      id: n.id,
      name: n.label || n.norm_label || n.id,
      fileType: n.file_type || "concept",
      community: n.community ?? 0,
      degree: deg.get(n.id) ?? 0,
      sourceFile: n.source_file,
      god: godSet.has(n.id),
    }));
    const vlinks = linksRaw
      .filter((l) => keep.has(idOf(l.source)) && keep.has(idOf(l.target)))
      .map((l) => ({ ...l }));
    return { nodes: vnodes, links: vlinks, capped, total: nodesRaw.length, shown: vnodes.length };
  }, [graph, maxNodes, density]);

  useEffect(() => {
    nodeMatsRef.current = new Map();
    lastHiRef.current = undefined;
  }, [data]);

  useEffect(() => {
    onMeta?.({ shown: data.shown, total: data.total, capped: data.capped });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.shown, data.total, data.capped]);

  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>();
    data.links.forEach((l: any) => {
      const s = idOf(l.source);
      const t = idOf(l.target);
      if (!m.has(s)) m.set(s, new Set());
      if (!m.has(t)) m.set(t, new Set());
      m.get(s)!.add(t);
      m.get(t)!.add(s);
    });
    return m;
  }, [data]);
  const adjacencyRef = useRef(adjacency);
  adjacencyRef.current = adjacency;

  const isLit = (id: string) => {
    const h = activeHi();
    if (!h) return true;
    if (id === h) return true;
    return adjacencyRef.current.get(h)?.has(id) ?? false;
  };

  // Scene: fog, project-tinted light, starfield, bloom (always — the glow), gentle orbit, hover dim
  useEffect(() => {
    if (!fgRef.current || !THREE) return;
    const fg = fgRef.current;
    const { r, g, b } = ((hex: string) => {
      const n = parseInt(hex.replace("#", ""), 16);
      return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
    })(accent);

    if (embedded) {
      try {
        const c = fg.controls?.();
        if (c) {
          c.enableZoom = false;
          c.enablePan = false;
        }
      } catch {}
    }

    // Clamp zoom on the main (non-embedded) graph so you can't zoom out into
    // the black void or clip through the centre. Bounds are re-applied in
    // fitCamera relative to each graph's fitted distance.
    if (!embedded) {
      try {
        const c = fg.controls?.();
        if (c) {
          c.minDistance = 40;
          c.maxDistance = orbitDistRef.current * 1.8;
        }
      } catch {}
    }

    const scene = fg.scene();
    if (!scene.userData.__gfxEnhanced) {
      scene.userData.__gfxEnhanced = true;
      scene.fog = new THREE.FogExp2(0x000000, 0.0021);
      scene.add(new THREE.AmbientLight(0xffffff, 0.34));
      const key = new THREE.PointLight(0xffffff, 1.5, 1400);
      key.position.set(140, 200, 220);
      scene.add(key);
      scene.userData.__keyLight = key;
      const rim = new THREE.PointLight(0x6366f1, 0.8, 1100);
      rim.position.set(-240, -140, -180);
      scene.add(rim);
      const geo = new THREE.BufferGeometry();
      const N = 1100;
      const pos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const rad = 760 + Math.random() * 620;
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        pos[i * 3] = rad * Math.sin(ph) * Math.cos(th);
        pos[i * 3 + 1] = rad * Math.sin(ph) * Math.sin(th);
        pos[i * 3 + 2] = rad * Math.cos(ph);
      }
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const stars = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          color: 0xa9b4c2, size: 1.1, transparent: true, opacity: 0.5,
          sizeAttenuation: true, depthWrite: false,
        }),
      );
      stars.userData.__stars = true;
      scene.add(stars);
    }
    if (scene.userData.__keyLight) scene.userData.__keyLight.color.setRGB(r, g, b);

    if (BloomPass && typeof fg.postProcessingComposer === "function") {
      try {
        const composer = fg.postProcessingComposer();
        if (!scene.userData.__bloom) {
          const bp = new BloomPass(
            new THREE.Vector2(sizeRef.current.w, sizeRef.current.h),
            bloomStrength,
            0.64,
            0.3,
          );
          composer.addPass(bp);
          scene.userData.__bloom = bp;
        } else {
          scene.userData.__bloom.setSize(sizeRef.current.w, sizeRef.current.h);
          scene.userData.__bloom.strength = bloomStrength;
        }
      } catch {}
    }

    let raf = 0;
    const tick = () => {
      // Keep orbiting even while hovering — hover only DIMS neighbours
      // (highlight), it should NOT freeze the whole graph. We pause while a
      // node is PINNED (fly-to) AND while the user is actively dragging the
      // camera (or just did, within 1.2s) so manual rotation feels
      // responsive instead of being fought by the auto-orbit.
      const userDragging = performance.now() - lastDragRef.current < 1200;
      if (userDragging) {
        // Re-sync the orbit angle to wherever the user left the camera, so
        // when auto-orbit resumes it continues smoothly from there (no snap).
        try {
          const cam = fg.camera?.();
          if (cam) angleRef.current = Math.atan2(cam.position.x, cam.position.z);
        } catch {}
      }
      if (rotatingRef.current && !pinnedIdRef.current && !userDragging) {
        angleRef.current += 0.0009;
        const a = angleRef.current;
        // Ease current orbit distance toward the fitted target (no snap).
        const target = orbitDistRef.current;
        orbitDistCurRef.current += (target - orbitDistCurRef.current) * 0.06;
        const dist = orbitDistCurRef.current;
        fg.cameraPosition({
          x: dist * Math.sin(a),
          y: dist * 0.16 + Math.sin(a * 0.6) * dist * 0.05,
          z: dist * Math.cos(a),
        });
      }
      const t = performance.now() * 0.001;
      scene.children.forEach((o: any) => {
        if (o.userData.__stars) o.rotation.y = t * 0.01;
        if (o.userData.__pulse) {
          const s = 1 + Math.sin(t * 2 + (o.userData.__seed ?? 0)) * 0.08;
          o.scale.set(s, s, s);
        }
      });
      const hi = activeHi();
      if (lastHiRef.current !== hi) {
        lastHiRef.current = hi;
        nodeMatsRef.current.forEach((mats, id) => {
          const f = isLit(id) ? 1 : DIM;
          mats.forEach(({ m, base: bo }) => {
            m.opacity = bo * f;
          });
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [THREE, BloomPass, accent, embedded]);

  // Keep bloom sharp on resize
  useEffect(() => {
    try {
      const bloom = fgRef.current?.scene?.()?.userData?.__bloom;
      if (bloom) bloom.setSize(size.w, size.h);
    } catch {}
  }, [size.w, size.h]);

  // Community-cluster force → distinct "sections" + a compact graph (no drift)
  useEffect(() => {
    if (!Graph || !fgRef.current) return;
    const fg = fgRef.current;
    const nodes = data.nodes as any[];
    if (!nodes.length) return;
    const comms = [...new Set(nodes.map((n) => n.community))];
    const numC = comms.length || 1;
    // Smaller anchor radius → communities sit closer to the centre, so the
    // graph is a filled ball (links cross the middle) not a hollow shell.
    const R = Math.min(320, (60 + numC * 6) * spread);
    const anchor = new Map<number, { x: number; y: number; z: number }>();
    comms.forEach((c, i) => {
      const t = (i + 0.5) / numC;
      const phi = Math.acos(1 - 2 * t);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      anchor.set(c, {
        x: R * Math.sin(phi) * Math.cos(theta),
        y: R * Math.sin(phi) * Math.sin(theta),
        z: R * Math.cos(phi),
      });
    });
    try {
      const charge = fg.d3Force("charge");
      if (charge) charge.strength((embedded ? -22 : -30) * spread);
      // Stronger link attraction → connected files pull TOGETHER, so the
      // lines between them are visible and the graph reads as a connected
      // web instead of nodes floating alone. Shorter distances = denser,
      // fuller body (fills the hollow middle).
      const link = fg.d3Force("link");
      if (link)
        link
          .distance((l: any) => (l.confidence === "EXTRACTED" ? 12 : 26) * spread)
          .strength(0.7);
      // A weak pull toward the GRAPH CENTRE (origin) so detached / tiny
      // communities don't fly out to the shell and leave the middle empty
      // — keeps the whole thing a cohesive ball, not a hollow sphere.
      const centerForce = fg.d3Force("center");
      if (centerForce?.strength) centerForce.strength(0.04);
      // Cluster pull eased down — communities still group into regions but
      // don't get slammed onto a sphere surface, so the body stays filled.
      const CL = 0.18;
      fg.d3Force("cluster", (alpha: number) => {
        for (const n of nodes) {
          const a = anchor.get(n.community);
          if (!a) continue;
          n.vx = (n.vx || 0) + (a.x - (n.x || 0)) * CL * alpha;
          n.vy = (n.vy || 0) + (a.y - (n.y || 0)) * CL * alpha;
          n.vz = (n.vz || 0) + (a.z - (n.z || 0)) * CL * alpha;
        }
      });
      // Reheat only once the force layout actually exists. Calling this
      // before three-forcegraph has assigned its internal `state.layout`
      // makes the engine's tickFrame() call `layout.tick()` on undefined
      // → "Cannot read properties of undefined (reading 'tick')" → the
      // render loop dies and the canvas goes black. Guarding on a laid-out
      // graphData (nodes given x coords, i.e. layout initialised) avoids
      // the race while keeping the reheat for settled graphs.
      const gd = fg.graphData?.();
      const layoutReady = gd?.nodes?.length ? gd.nodes[0].x != null : false;
      if (layoutReady && !pinnedIdRef.current) fg.d3ReheatSimulation?.();
    } catch {}
  }, [Graph, data, embedded, spread]);

  // Fly the camera to a node (god-node click). Defers if coords aren't laid out
  // yet (flushed in fitCamera/onEngineStop) and freezes the target so a
  // simulation reheat can't drift it out of frame.
  function flyTo(id: string) {
    const fg = fgRef.current;
    const n = (data.nodes as any[]).find((x) => x.id === id);
    if (!fg || !n) return;
    if (n.x == null) {
      pendingFlyRef.current = id;
      return;
    }
    n.fx = n.x;
    n.fy = n.y;
    n.fz = n.z;
    // Back off further on spread-out graphs so the fly-to frames the node's
    // neighbourhood instead of parking inside its bloom halo.
    const d = 130 * Math.min(2, Math.max(1, spread * 0.75));
    try {
      fg.cameraPosition({ x: n.x + d, y: n.y + d * 0.4, z: n.z + d }, { x: n.x, y: n.y, z: n.z }, 900);
    } catch {}
    lastHiRef.current = "__force__";
  }

  // Fit orbit distance to the graph's spread (fills the frame); also flush any
  // deferred fly-to and refresh dimming once coordinates exist.
  const fitCamera = () => {
    try {
      const ns = data.nodes as any[];
      let max = 0;
      for (const n of ns) {
        const d = Math.hypot(n.x ?? 0, n.y ?? 0, n.z ?? 0);
        if (d > max) max = d;
      }
      // Raised cap (1400) so a huge graph like hermes-agent (2,983 nodes)
      // can actually be framed from OUTSIDE rather than the camera sitting
      // inside it. *1.7 leaves comfortable margin around the ball.
      orbitDistRef.current = Math.max(embedded ? 150 : 220, Math.min(1400, max * 1.7 + 50));
      // If the current (eased) distance is INSIDE the graph, jump it out to
      // the target's edge first so we always ease IN from outside — never
      // boot the viewer into the middle of a big graph on first load.
      if (orbitDistCurRef.current < orbitDistRef.current * 0.6) {
        orbitDistCurRef.current = orbitDistRef.current * 1.15;
      }
      // Re-clamp zoom-out to this graph's fitted size so you can't scroll
      // out far enough that everything goes black.
      if (!embedded) {
        const c = fgRef.current?.controls?.();
        if (c) {
          c.minDistance = 40;
          c.maxDistance = orbitDistRef.current * 1.8;
        }
      }
    } catch {}
    if (pendingFlyRef.current) {
      const id = pendingFlyRef.current;
      pendingFlyRef.current = null;
      flyTo(id);
    }
    lastHiRef.current = "__force__";
  };

  // Custom node meshes — memoised so hovering/re-render doesn't regenerate every node.
  const makeNode = useCallback(
    (n: any) => {
      if (!THREE) return undefined as any;
      const group = new THREE.Group();
      const lit = isLit(n.id);
      const color = colorForCommunity(n.community, accent);
      // "Airy" (spread) graphs are read up close — cooler emissives and
      // gentler size scaling so hub nodes stay coloured spheres instead of
      // saturating into white bloom balls.
      const airy = spread > 1.5;
      const r = n.god
        ? airy
          ? 4.5 + Math.min(5, n.degree * 0.18)
          : 6 + Math.min(8, n.degree * 0.5)
        : airy
          ? 2.2 + Math.min(3.5, n.degree * 0.22)
          : 2.4 + Math.min(5, n.degree * 0.4);
      const mat = new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: n.god ? (airy ? 1.1 : 2.2) : airy ? 0.65 : 0.8,
        roughness: 0.35, metalness: 0.1, transparent: true, opacity: lit ? 1 : DIM,
      });
      const mats: { m: any; base: number }[] = [{ m: mat, base: 1 }];
      let geom: any;
      const ft = String(n.fileType);
      if (ft === "doc" || ft === "markdown") geom = new THREE.OctahedronGeometry(r, 0);
      else if (ft === "image") geom = new THREE.IcosahedronGeometry(r, 0);
      else geom = new THREE.SphereGeometry(r, n.god ? 28 : 16, n.god ? 28 : 16);
      group.add(new THREE.Mesh(geom, mat));
      if (n.god) {
        const haloBase = airy ? 0.09 : 0.16;
        const haloMat = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: (lit ? 1 : DIM) * haloBase, side: THREE.BackSide,
        });
        group.add(new THREE.Mesh(new THREE.SphereGeometry(r * 1.6, 20, 20), haloMat));
        mats.push({ m: haloMat, base: haloBase });
        group.userData.__pulse = true;
        group.userData.__seed = (n.id.length * 7 + n.community) % 100;
      }
      nodeMatsRef.current.set(n.id, mats);
      return group;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accent, THREE, spread],
  );

  // Fly to a node when it's pinned (god-node click); release any prior freeze.
  useEffect(() => {
    const ns = data.nodes as any[];
    for (const n of ns) if (n.fx != null && n.id !== pinnedId) (n.fx = n.fy = n.fz = null);
    if (!pinnedId) {
      pendingFlyRef.current = null;
      return;
    }
    flyTo(pinnedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedId, data]);

  return (
    <div
      ref={wrapRef}
      className={`w-full h-full relative ${embedded ? "min-h-[300px]" : "min-h-[560px]"}`}
      // Mark user interaction so the auto-orbit yields to manual rotation.
      onPointerDown={() => { lastDragRef.current = performance.now(); }}
      onPointerMove={(e) => { if (e.buttons) lastDragRef.current = performance.now(); }}
      onWheel={() => { lastDragRef.current = performance.now(); }}
    >
      {Graph && THREE ? (
        <Graph
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={data as any}
          backgroundColor="rgba(0,0,0,0)"
          showNavInfo={false}
          warmupTicks={data.shown > 500 ? 25 : 60}
          cooldownTicks={data.shown > 500 ? 100 : 170}
          onEngineStop={fitCamera}
          nodeRelSize={5}
          nodeLabel={(n: any) =>
            tooltip
              ? tooltip(n)
              : `<div style="font:500 11px ui-sans-serif,system-ui;padding:8px 11px;background:rgba(11,14,19,0.95);border:1px solid #2a2f3a;border-radius:10px;color:#fff;max-width:300px;box-shadow:0 10px 28px rgba(0,0,0,.5)">
               <div style="font-weight:600">${esc(n.name)}</div>
               <div style="color:#9aa3b0;margin-top:3px;font-size:10px">${esc(n.fileType)} · cluster ${n.community} · ${n.degree} links${n.god ? " · ★ god node" : ""}</div>
               ${n.sourceFile ? `<div style="color:#c7cdd6;margin-top:2px;font-size:10px;font-style:italic">${esc(shortPath(n.sourceFile))}</div>` : ""}
             </div>`
          }
          nodeThreeObject={makeNode}
          linkColor={(l: any) => {
            const h = activeHi();
            const active = h && (idOf(l.source) === h || idOf(l.target) === h);
            if (active) return accent;
            return l.confidence === "EXTRACTED" ? "rgba(120,224,200,0.42)" : "rgba(167,139,250,0.22)";
          }}
          linkWidth={(l: any) => {
            const h = activeHi();
            if (h && (idOf(l.source) === h || idOf(l.target) === h)) return 1.5;
            return l.confidence === "EXTRACTED" ? 0.6 : 0.35;
          }}
          linkDirectionalParticles={(l: any) => (data.shown <= 500 && l.confidence === "EXTRACTED" ? 2 : 0)}
          linkDirectionalParticleSpeed={0.004}
          linkDirectionalParticleWidth={1.1}
          linkDirectionalParticleColor={() => accent}
          linkCurvature={0.08}
          onNodeHover={(n: any) => setHoverId(n?.id ?? null)}
          onNodeClick={(n: any) => onSelect?.(n)}
          onBackgroundClick={() => onBackground?.()}
          enableNodeDrag={!embedded}
        />
      ) : (
        <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
          Loading knowledge graph…
        </div>
      )}

      {!embedded && (
        <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
          {/* Density toggle — Full (whole web) vs Core (load-bearing skeleton) */}
          <div className="flex rounded-lg border border-border/60 bg-black/70 backdrop-blur overflow-hidden text-[10px] uppercase tracking-wider">
            <button
              onClick={() => setDensity("full")}
              className={`px-2.5 py-1 transition-colors ${density === "full" ? "text-foreground" : "text-muted-foreground hover:text-foreground/80"}`}
              style={density === "full" ? { background: `${accent}22`, color: accent } : undefined}
              title="Full graph — every file and connection"
            >
              Full
            </button>
            <button
              onClick={() => setDensity("core")}
              className={`px-2.5 py-1 transition-colors border-l border-border/60 ${density === "core" ? "text-foreground" : "text-muted-foreground hover:text-foreground/80"}`}
              style={density === "core" ? { background: `${accent}22`, color: accent } : undefined}
              title="Core — only the most-connected, load-bearing files"
            >
              Core
            </button>
          </div>
          <button
            onClick={() => setRotating((r) => !r)}
            className="rounded-lg border border-border/60 bg-black/70 backdrop-blur px-2.5 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
            title="Pause / resume orbit"
          >
            {rotating ? "Pause" : "Play"}
          </button>
        </div>
      )}

      {data.capped && (
        <div className="absolute bottom-3 right-3 z-10 rounded-md border border-border/60 bg-black/70 backdrop-blur px-2.5 py-1 text-[10px] text-muted-foreground pointer-events-none">
          densest {data.shown.toLocaleString()} of {data.total.toLocaleString()} nodes
        </div>
      )}

      {!embedded && !hideLegend && (
        <div className="absolute bottom-3 left-3 flex flex-wrap gap-3 rounded-lg border border-border/70 bg-background/70 backdrop-blur px-3 py-2 text-[10px] text-muted-foreground pointer-events-none">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-3 rounded-full" style={{ background: "rgba(120,224,200,0.85)" }} />
            EXTRACTED
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-3 rounded-full" style={{ background: "rgba(167,139,250,0.6)" }} />
            INFERRED
          </span>
          <span className="opacity-70">size = connectivity · ★ = god node · colour = cluster</span>
        </div>
      )}
    </div>
  );
}

export default GraphifyGraph3D;
