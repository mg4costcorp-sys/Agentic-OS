/*
 * BrainGraph3D — the Brain's own knowledge universe, rebuilt from REAL notes.
 *
 * The old Brain reused the workspace/file memory graph: anonymous glowing
 * spheres with no labels and nothing behind a click. This graph is built from
 * the user's actual knowledge instead — every node IS a note (concept, source,
 * person, topic) from their vaults, clustered around labeled #topic hubs,
 * wired with their real wikilinks, plus the Claude memory layer. Every node
 * carries a readable label and clicking ANY note opens the real document.
 *
 * Design language:
 *   - Obsidian-graph legibility: small matte nodes, thin links, text-first.
 *   - Color = meaning, same as the rail legend: concepts green, sources amber,
 *     people violet, topics cyan, Claude memory orange.
 *   - Restrained glow: soft bloom on hubs only, no blown-out orange suns.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveData } from "@/lib/use-live-data";
import { MemoryGraphLoader } from "@/components/memory-graph-loader";
import type { KnowledgeGraph } from "@/components/knowledge-explorer";
import type { MemNode } from "@/components/memory-graph-3d";

type ForceGraphModule = typeof import("react-force-graph-3d").default;
type ThreeModule = typeof import("three");
type UnrealBloomPassCtor =
  typeof import("three/examples/jsm/postprocessing/UnrealBloomPass.js").UnrealBloomPass;

const ACCENT = "#3ddc97";
const COL = {
  core: "#3ddc97",
  hub: "#22d3ee",
  concept: "#3ddc97",
  source: "#f5b14c",
  person: "#a78bfa",
  topic: "#22d3ee",
  report: "#f472b6",
  note: "#aab4c2",
  claude: "#FF7A3D",
  vector: "#7dd3fc",
};

function colorForType(type: string): string {
  if (type === "source" || type === "reference") return COL.source;
  if (type === "entity" || type === "person") return COL.person;
  if (type === "topic" || type === "moc") return COL.topic;
  if (type === "report") return COL.report;
  if (type === "concept") return COL.concept;
  return COL.note;
}

interface BNode {
  id: string;
  name: string;
  kind: "core" | "hub" | "note" | "claude" | "vector";
  vault?: string;
  noteId?: string;
  type?: string;
  tags?: string[];
  excerpt?: string;
  updated?: string;
  color: string;
  r: number;
  labelSize: number;
  val: number;
}
interface BLink { source: string; target: string; kind: "core" | "tag" | "wiki" | "claude" }

function buildBrainData(graphs: KnowledgeGraph[], liveData: any, hasPinecone: boolean) {
  const nodes: BNode[] = [];
  const links: BLink[] = [];
  const byId = new Set<string>();
  const add = (n: BNode) => { if (!byId.has(n.id)) { byId.add(n.id); nodes.push(n); } };

  add({ id: "core", name: "Your Memory", kind: "core", color: COL.core, r: 9, labelSize: 1.15, val: 20 });

  for (const g of graphs) {
    const vault = g.vault;
    // Topic hubs — the tags that actually organize this vault.
    const tagCount = new Map<string, number>();
    for (const n of g.notes) for (const t of n.tags ?? []) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    const hubTags = [...tagCount.entries()]
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([t]) => t);
    const hubId = (t: string) => `hub:${vault}:${t}`;
    for (const t of hubTags) {
      add({ id: hubId(t), name: `#${t}`, kind: "hub", vault, color: COL.hub, r: 5.2, labelSize: 1.0, val: 10 });
      links.push({ source: "core", target: hubId(t), kind: "core" });
    }
    const miscId = `hub:${vault}:__misc`;
    let miscUsed = false;

    const noteId = (id: string) => `n:${vault}:${id}`;
    for (const n of g.notes) {
      const degree = (n.out?.length ?? 0) + (n.sourceCount ?? 0);
      add({
        id: noteId(n.id),
        name: n.title || n.id,
        kind: "note",
        vault,
        noteId: n.id,
        type: n.type,
        tags: n.tags,
        excerpt: n.excerpt,
        updated: n.updated,
        color: colorForType(n.type),
        r: 2.2 + Math.min(2.6, degree * 0.22),
        labelSize: 0.62,
        val: 3,
      });
      const anchors = (n.tags ?? []).filter((t) => hubTags.includes(t)).slice(0, 2);
      if (anchors.length) {
        for (const t of anchors) links.push({ source: hubId(t), target: noteId(n.id), kind: "tag" });
      } else {
        if (!miscUsed) {
          add({ id: miscId, name: vault, kind: "hub", vault, color: COL.hub, r: 5.2, labelSize: 1.0, val: 10 });
          links.push({ source: "core", target: miscId, kind: "core" });
          miscUsed = true;
        }
        links.push({ source: miscId, target: noteId(n.id), kind: "tag" });
      }
    }
    // Real wikilink topology.
    for (const l of g.links ?? []) {
      const s = noteId(l.s), t = noteId(l.t);
      if (byId.has(s) && byId.has(t)) links.push({ source: s, target: t, kind: "wiki" });
    }
  }

  // Claude memory layer — kept LEAN so it reads as a layer of the same brain,
  // not a second galaxy dragging the frame apart: top workspaces, a few files
  // each, no cross-link web.
  const memNodes: any[] = liveData?.memory?.nodes ?? [];
  const claudeWs = memNodes.filter((n) => n.source === "claude" && n.kind === "workspace").slice(0, 8);
  for (const w of claudeWs) {
    add({
      id: `c:${w.id}`,
      name: w.name,
      kind: "claude",
      excerpt: w.preview,
      updated: w.updated,
      color: COL.claude,
      r: 4.2,
      labelSize: 0.85,
      val: 8,
    });
    links.push({ source: "core", target: `c:${w.id}`, kind: "core" });
    const files = memNodes.filter((n) => n.source === "claude" && n.kind === "file" && n.workspaceId === w.workspaceId).slice(0, 4);
    for (const f of files) {
      add({
        id: `c:${f.id}`,
        name: f.name,
        kind: "claude",
        noteId: String(f.name ?? "").replace(/\.md$/i, ""),
        excerpt: f.preview,
        updated: f.updated,
        color: COL.claude,
        r: 2.2,
        labelSize: 0.58,
        val: 3,
      });
      links.push({ source: `c:${w.id}`, target: `c:${f.id}`, kind: "claude" });
    }
  }

  // Pinecone indexes as satellite stores.
  if (hasPinecone) {
    for (const n of memNodes) {
      if (n.kind !== "vector_store") continue;
      add({ id: `v:${n.id}`, name: n.name, kind: "vector", color: COL.vector, r: 4.2, labelSize: 0.85, val: 7 });
      links.push({ source: "core", target: `v:${n.id}`, kind: "core" });
    }
  }

  return { nodes, links };
}

// ── crisp text label sprites (canvas-backed, cached by text+color+dim) ──────
const labelCache = new Map<string, any>();
function makeLabel(THREE: ThreeModule, text: string, color: string, dim: boolean, size: number) {
  const t = text.length > 30 ? text.slice(0, 29) + "…" : text;
  const key = `${t}|${color}|${dim ? 1 : 0}|${size}`;
  const cached = labelCache.get(key);
  if (cached) return cached.clone();
  const font = `500 44px ui-sans-serif, -apple-system, system-ui`;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(t).width) + 24;
  const h = 64;
  canvas.width = w; canvas.height = h;
  const c2 = canvas.getContext("2d")!;
  c2.font = font;
  c2.textAlign = "center"; c2.textBaseline = "middle";
  c2.shadowColor = "rgba(0,0,0,0.9)"; c2.shadowBlur = 8;
  c2.fillStyle = color;
  c2.fillText(t, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: dim ? 0.08 : 0.92, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const scale = size * 3.4;
  sprite.scale.set((w / h) * scale, scale, 1);
  labelCache.set(key, sprite);
  const out = sprite.clone();
  // Labels must be invisible to the raycaster — Sprite.raycast without a
  // raycaster camera THROWS inside the picking pass and silently kills
  // hover + click for the entire graph.
  out.raycast = () => {};
  return out;
}

export function BrainGraph3D({
  graphs,
  hasPinecone = false,
  onSelect,
  sourceFilter = "all",
  focusQuery = "",
  focusNonce = 0,
}: {
  graphs: KnowledgeGraph[];
  hasPinecone?: boolean;
  onSelect: (node: MemNode) => void;
  /** "all" | a vault name | "claude" | "pinecone" */
  sourceFilter?: string;
  focusQuery?: string;
  focusNonce?: number;
}) {
  const liveData = useLiveData();
  const fullData = useMemo(() => buildBrainData(graphs, liveData, hasPinecone), [graphs, liveData, hasPinecone]);

  const fgRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [Graph, setGraph] = useState<ForceGraphModule | null>(null);
  const [THREE, setThree] = useState<ThreeModule | null>(null);
  const [BloomPass, setBloomPass] = useState<UnrealBloomPassCtor | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusedIds, setFocusedIds] = useState<Set<string>>(() => new Set());
  const focusedRef = useRef(focusedIds); focusedRef.current = focusedIds;
  const hoverRef = useRef<string | null>(null); hoverRef.current = hoverId;
  const [rotating, setRotating] = useState(true);
  const rotatingRef = useRef(rotating); rotatingRef.current = rotating;
  // Orbit frame — centroid + radius of the settled layout, so the camera
  // always circles what actually exists instead of a fixed origin/distance.
  const frameRef = useRef({ cx: 0, cy: 0, cz: 0, dist: 420 });
  const dataRef = useRef(fullData); dataRef.current = fullData;
  const reframe = () => {
    const pts = (dataRef.current.nodes as any[]).filter((n) => typeof n.x === "number");
    if (pts.length < 4) return;
    const cx = pts.reduce((a, n) => a + n.x, 0) / pts.length;
    const cy = pts.reduce((a, n) => a + n.y, 0) / pts.length;
    const cz = pts.reduce((a, n) => a + n.z, 0) / pts.length;
    let r = 0;
    for (const n of pts) r = Math.max(r, Math.hypot(n.x - cx, n.y - cy, n.z - cz));
    frameRef.current = { cx, cy, cz, dist: Math.min(760, Math.max(300, r * 2.1)) };
  };

  useEffect(() => {
    let alive = true;
    Promise.all([
      import("react-force-graph-3d"),
      import("three"),
      import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
    ]).then(([graphMod, threeMod, bloomMod]) => {
      if (!alive) return;
      setGraph(() => graphMod.default);
      setThree(threeMod);
      setBloomPass(() => bloomMod.UnrealBloomPass);
    });
    return () => { alive = false; };
  }, []);

  // Layer filter — a vault name keeps that vault's hubs+notes, "claude" the
  // Claude layer, "pinecone" the vector stores. Core always stays.
  const data = useMemo(() => {
    if (!sourceFilter || sourceFilter === "all") return fullData;
    const keep = (n: BNode): boolean => {
      if (n.id === "core") return true;
      if (sourceFilter === "claude") return n.kind === "claude";
      if (sourceFilter === "pinecone") return n.kind === "vector";
      return n.vault === sourceFilter;
    };
    const allow = new Set(fullData.nodes.filter(keep).map((n) => n.id));
    return {
      nodes: fullData.nodes.filter((n) => allow.has(n.id)),
      links: fullData.links.filter((l) => {
        const s = typeof l.source === "object" ? (l.source as any).id : l.source;
        const t = typeof l.target === "object" ? (l.target as any).id : l.target;
        return allow.has(s) && allow.has(t);
      }),
    };
  }, [fullData, sourceFilter]);

  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>();
    data.links.forEach((l) => {
      const s = typeof l.source === "object" ? (l.source as any).id : l.source;
      const t = typeof l.target === "object" ? (l.target as any).id : l.target;
      if (!m.has(s)) m.set(s, new Set());
      if (!m.has(t)) m.set(t, new Set());
      m.get(s)!.add(t); m.get(t)!.add(s);
    });
    return m;
  }, [data]);

  const isLit = (id: string) => {
    if (focusedRef.current.size > 0) return focusedRef.current.has(id);
    const hv = hoverRef.current;
    if (!hv) return true;
    if (id === hv) return true;
    return adjacency.get(hv)?.has(id) ?? false;
  };

  // Multi-term focus: "a | b | c" lights every match, camera flies to centroid.
  useEffect(() => {
    const fq = focusQuery.trim().toLowerCase();
    if (!fq || focusNonce <= 0 || !fgRef.current) return;
    const fg = fgRef.current;
    const terms = fq.split("|").map((s) => s.trim()).filter(Boolean);
    const matches = (data.nodes as any[]).filter((n) => {
      const hay = `${n.name ?? ""} ${n.noteId ?? ""} ${(n.tags ?? []).join(" ")}`.toLowerCase();
      return terms.some((t) => hay.includes(t));
    });
    if (!matches.length) return;
    const ids = new Set(matches.map((n) => String(n.id)));
    // Freeze the orbit via the ref IMMEDIATELY — the raf tick would otherwise
    // stamp the camera for another frame or two and cancel the fly tween.
    rotatingRef.current = false;
    setRotating(false);
    focusedRef.current = ids;
    setFocusedIds(ids);
    const positioned = matches.filter((n) => typeof n.x === "number");
    if (positioned.length) {
      const cx = positioned.reduce((a, n) => a + n.x, 0) / positioned.length;
      const cy = positioned.reduce((a, n) => a + n.y, 0) / positioned.length;
      const cz = positioned.reduce((a, n) => a + n.z, 0) / positioned.length;
      try { fg.cameraPosition({ x: cx + 60, y: cy + 40, z: cz + 150 }, { x: cx, y: cy, z: cz }, 1400); } catch { /* not ready */ }
    }
    try { fg.refresh?.(); } catch { /* restyle */ }
    const release = window.setTimeout(() => {
      focusedRef.current = new Set();
      setFocusedIds(new Set());
      rotatingRef.current = true;
      setRotating(true);
      try { fgRef.current?.refresh?.(); } catch { /* */ }
    }, 8000);
    return () => window.clearTimeout(release);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce, focusQuery]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((es) => { for (const e of es) setSize({ w: e.contentRect.width, h: e.contentRect.height }); });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // Forces, atmosphere, restrained bloom, slow orbit.
  useEffect(() => {
    if (!fgRef.current || !THREE) return;
    const fg = fgRef.current;
    try {
      fg.d3Force("charge")?.strength(-46);
      fg.d3Force("link")?.distance((l: any) =>
        l.kind === "core" ? 120 : l.kind === "tag" ? 44 : l.kind === "wiki" ? 34 : 30,
      );
    } catch { /* forces not ready */ }

    const scene = fg.scene();
    if (!scene.userData.__brainEnhanced) {
      scene.userData.__brainEnhanced = true;
      scene.fog = new THREE.FogExp2(0x000000, 0.0016);
      scene.add(new THREE.AmbientLight(0xffffff, 0.85));
      const key = new THREE.PointLight(0x3ddc97, 0.5, 1400);
      key.position.set(140, 220, 240);
      scene.add(key);
      // Sparse, dim starfield — atmosphere, not confetti.
      const geom = new THREE.BufferGeometry();
      const N = 500;
      const pos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const r = 800 + Math.random() * 700;
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
        pos[i * 3 + 2] = r * Math.cos(ph);
      }
      geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const stars = new THREE.Points(geom, new THREE.PointsMaterial({
        color: 0x8a93a3, size: 1.0, transparent: true, opacity: 0.3, sizeAttenuation: true, depthWrite: false,
      }));
      stars.userData.__stars = true;
      scene.add(stars);
    }
    if (BloomPass && !scene.userData.__bloom && typeof fg.postProcessingComposer === "function") {
      try {
        const composer = fg.postProcessingComposer();
        const bloom = new BloomPass(new THREE.Vector2(size.w, size.h), 0.32, 0.5, 0.6);
        composer.addPass(bloom);
        scene.userData.__bloom = bloom;
      } catch { /* no composer */ }
    }

    let raf = 0, angle = 0, frames = 0;
    const tick = () => {
      frames++;
      if (frames % 120 === 0) reframe(); // track the layout as it settles
      if (rotatingRef.current) {
        angle += 0.00055;
        const { cx, cy, cz, dist } = frameRef.current;
        fg.cameraPosition(
          { x: cx + dist * Math.sin(angle), y: cy + 40 + Math.sin(angle * 0.6) * 20, z: cz + dist * Math.cos(angle) },
          { x: cx, y: cy, z: cz },
        );
      }
      const t = performance.now() * 0.001;
      fg.scene().children.forEach((o: any) => { if (o.userData.__stars) o.rotation.y = t * 0.006; });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [BloomPass, THREE, size.w, size.h]);

  if (!Graph || !THREE) {
    return <div ref={wrapRef} className="w-full h-full"><MemoryGraphLoader height={size.h} /></div>;
  }

  return (
    <div
      ref={wrapRef}
      className="w-full h-full"
      // Grabbing the scene is a takeover: the auto-orbit otherwise fights
      // every drag (the "jitters, can't manipulate it" report). One pointer
      // press hands the camera to the user for good.
      onPointerDown={() => {
        rotatingRef.current = false;
        setRotating(false);
      }}
    >
      <Graph
        ref={fgRef}
        width={size.w}
        height={size.h}
        graphData={data as any}
        backgroundColor="rgba(0,0,0,0)"
        showNavInfo={false}
        warmupTicks={90}
        cooldownTicks={200}
        nodeRelSize={4}
        nodeLabel={(n: any) => {
          const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
          const cap = n.kind === "core" ? "MEMORY CORE"
            : n.kind === "hub" ? "TOPIC"
            : n.kind === "claude" ? "CLAUDE MEMORY"
            : n.kind === "vector" ? "PINECONE INDEX"
            : String(n.type ?? "note").toUpperCase();
          const line2 = n.kind === "note"
            ? `${n.vault ?? ""}${n.updated ? ` · edited ${n.updated}` : ""}`
            : n.kind === "hub" ? `${adjacency.get(n.id)?.size ?? 0} notes filed here` : "";
          const line3 = n.excerpt ? `“${String(n.excerpt).slice(0, 110)}”` : n.kind === "note" ? "Click to open the document" : "";
          return `<div style="font:500 11px ui-sans-serif,system-ui;padding:9px 11px;background:rgba(8,12,16,0.95);border:1px solid #26303c;border-radius:10px;color:#fff;box-shadow:0 10px 28px rgba(0,0,0,.5);max-width:280px">
            <div style="font-size:9px;letter-spacing:.18em;color:#8a93a3;margin-bottom:3px">${cap}</div>
            <div style="font-weight:600">${esc(n.name)}</div>
            ${line2 ? `<div style="color:#9aa3b0;margin-top:3px;font-size:10px">${esc(line2)}</div>` : ""}
            ${line3 ? `<div style="color:#c7cdd6;margin-top:3px;font-size:10px;font-style:italic">${esc(line3)}</div>` : ""}
          </div>`;
        }}
        nodeThreeObject={(n: any) => {
          const group = new THREE.Group();
          const lit = isLit(n.id);
          const focused = focusedRef.current.size > 0 && focusedRef.current.has(n.id);
          const hovered = hoverRef.current === n.id;
          const opacity = lit ? 1 : 0.1;
          const mat = new THREE.MeshStandardMaterial({
            color: n.color,
            emissive: n.color,
            emissiveIntensity: focused ? 2.0 : n.kind === "core" ? 1.5 : n.kind === "hub" || n.kind === "vector" ? 1.0 : hovered ? 1.1 : 0.42,
            roughness: 0.45,
            metalness: 0.05,
            transparent: true,
            opacity,
          });
          const geom = n.kind === "hub"
            ? new THREE.OctahedronGeometry(n.r, 1)
            : new THREE.SphereGeometry(n.r, 20, 20);
          group.add(new THREE.Mesh(geom, mat));
          if (n.kind === "core") {
            const halo = new THREE.Mesh(
              new THREE.SphereGeometry(n.r * 1.7, 24, 24),
              new THREE.MeshBasicMaterial({ color: n.color, transparent: true, opacity: 0.1 * opacity, side: THREE.BackSide }),
            );
            group.add(halo);
          }
          const label = makeLabel(THREE, n.name, lit ? (n.kind === "note" ? "#dfe6ee" : "#ffffff") : "#6b7482", !lit, (hovered || focused) ? n.labelSize * 1.35 : n.labelSize);
          label.position.set(0, -(n.r + 4.5), 0);
          group.add(label);
          return group;
        }}
        linkColor={(l: any) => {
          const s = typeof l.source === "object" ? l.source.id : l.source;
          const t = typeof l.target === "object" ? l.target.id : l.target;
          const hv = hoverRef.current;
          if (hv && (s === hv || t === hv)) return ACCENT;
          if (l.kind === "core") return "rgba(61,220,151,0.28)";
          if (l.kind === "wiki") return "rgba(150,170,200,0.22)";
          if (l.kind === "claude") return "rgba(255,122,61,0.2)";
          return "rgba(120,140,165,0.14)";
        }}
        linkWidth={(l: any) => {
          const s = typeof l.source === "object" ? l.source.id : l.source;
          const t = typeof l.target === "object" ? l.target.id : l.target;
          if (hoverRef.current && (s === hoverRef.current || t === hoverRef.current)) return 1.4;
          return l.kind === "core" ? 0.7 : 0.35;
        }}
        linkOpacity={0.5}
        linkCurvature={(l: any) => (l.kind === "wiki" ? 0.22 : 0.04)}
        linkDirectionalParticles={(l: any) => (l.kind === "core" ? 2 : 0)}
        linkDirectionalParticleSpeed={0.0028}
        linkDirectionalParticleColor={() => ACCENT}
        linkDirectionalParticleWidth={1.1}
        onNodeHover={(n: any) => setHoverId(n?.id ?? null)}
        onNodeClick={(n: any) => {
          if (n.kind === "hub" || n.kind === "core") return; // hubs organize; notes open
          onSelect({
            id: n.id,
            name: n.name,
            kind: "file",
            val: 5,
            color: n.color,
            preview: n.excerpt,
            updated: n.updated,
            ...(n.noteId ? ({ noteId: n.noteId, vault: n.vault ?? "" } as any) : {}),
          } as MemNode);
        }}
        enableNodeDrag={false}
      />
    </div>
  );
}

export default BrainGraph3D;
