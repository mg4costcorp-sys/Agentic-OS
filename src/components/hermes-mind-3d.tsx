import { memo, useEffect, useMemo, useRef, useState } from "react";
import { workspaces, memorySources } from "@/lib/mock-data";

// Hermes's mind as a living force-directed graph — the SAME glowing knowledge-node
// engine used in the Memory view (react-force-graph-3d + emissive spheres + bloom +
// flow particles). A thick HERMES core sits in the middle and bops; around it a BLEND
// of capability nodes (its tools/skills) and knowledge nodes (its memory) — every node
// wired to something. When a capability fires, its branch lights and the core floods
// to that colour.
type ForceGraphModule = typeof import("react-force-graph-3d").default;
type ThreeModule = typeof import("three");
type UnrealBloomPassCtor = typeof import("three/examples/jsm/postprocessing/UnrealBloomPass.js").UnrealBloomPass;

export type CoreMode = "dormant" | "listening" | "thinking" | "talking" | "working";

export const CL = [
  { key: "research",  label: "Research",  color: "#60a5fa" },
  { key: "knowledge", label: "Knowledge", color: "#7be0c8" },
  { key: "memory",    label: "Memory",    color: "#ff9da7" },
  { key: "thinking",  label: "Thinking",  color: "#b9a6ff" },
  { key: "creation",  label: "Creation",  color: "#ff5a7a" },
  { key: "comms",     label: "Comms",     color: "#46e0a0" },
  { key: "action",    label: "Action",    color: "#ff8a3c" },
] as const;

const TOOLS: Record<string, string[]> = {
  research: ["GitHub", "Reddit", "LinkedIn", "X", "Clay", "Web Search", "YouTube"],
  knowledge: ["Notion", "Drive", "Obsidian", "Supabase", "Granola"],
  memory: ["Memory Core", "Pinecone"],
  thinking: ["Claude", "Gemini", "Codex", "Sub-agents"],
  creation: ["Writing", "ElevenLabs", "Higgsfield", "NotebookLM"],
  comms: ["Telegram", "Gmail", "Calendar", "Slack"],
  action: ["Code", "Schedule", "n8n", "Zapier", "MCP", "Skills"],
};

const ASPECTS: Record<string, number> = { research: 16, knowledge: 16, memory: 12, thinking: 16, creation: 14, comms: 14, action: 16 };

const HUB = "#eafff8";

function buildGraph() {
  const nodes: any[] = [];
  const links: any[] = [];
  nodes.push({ id: "hermes", name: "Hermes", kind: "hub", cluster: "hermes", color: HUB, val: 60 });
  CL.forEach((c) => {
    nodes.push({ id: `cl-${c.key}`, name: c.label, kind: "cluster", cluster: c.key, color: c.color, val: 24 });
    links.push({ source: "hermes", target: `cl-${c.key}`, kind: "core", cluster: c.key });
    (TOOLS[c.key] || []).forEach((t, i) => {
      const id = `t-${c.key}-${i}`;
      nodes.push({ id, name: t, kind: "tool", cluster: c.key, color: c.color, val: 7 });
      links.push({ source: `cl-${c.key}`, target: id, kind: "tool", cluster: c.key });
    });
    const n = ASPECTS[c.key] || 8;
    for (let i = 0; i < n; i++) {
      const id = `a-${c.key}-${i}`;
      nodes.push({ id, name: "memory thread", kind: "aspect", cluster: c.key, color: c.color, val: 2 + (i % 3) });
      // wire to the cluster, or to one of its tools — never floating
      const tCount = (TOOLS[c.key] || []).length;
      const anchor = i % 3 === 0 || tCount === 0 ? `cl-${c.key}` : `t-${c.key}-${i % tCount}`;
      links.push({ source: anchor, target: id, kind: "aspect", cluster: c.key });
    }
  });
  // overlay the REAL memory system around the Memory branch → denser bulb field
  workspaces.forEach((w: any, wi: number) => {
    const wid = `mw-${wi}`;
    nodes.push({ id: wid, name: w.name, kind: "memnode", cluster: "memory", color: "#e6ebf2", val: 5 });
    links.push({ source: "cl-memory", target: wid, kind: "aspect", cluster: "memory" });
    (w.memoryFiles || []).slice(0, 6).forEach((f: any, fi: number) => {
      const fid = `mf-${wi}-${fi}`;
      nodes.push({ id: fid, name: f.name, kind: "memnode", cluster: "memory", color: "#ff9da7", val: 2 });
      links.push({ source: wid, target: fid, kind: "aspect", cluster: "memory" });
      if (fi % 2 === 0) { for (let k = 0; k < 2; k++) nodes.push({ id: `${fid}-x${k}`, name: "memory", kind: "aspect", cluster: "memory", color: "#ff9da7", val: 1 }), links.push({ source: fid, target: `${fid}-x${k}`, kind: "aspect", cluster: "memory" }); }
    });
  });
  (memorySources || []).filter((s: any) => s.kind === "vector").forEach((s: any, si: number) => {
    const vid = `mv-${si}`;
    nodes.push({ id: vid, name: s.label, kind: "vector", cluster: "memory", color: s.color || "#ff9da7", val: 12 });
    links.push({ source: "cl-memory", target: vid, kind: "core", cluster: "memory" });
    links.push({ source: "hermes", target: vid, kind: "cross", cluster: "memory" });
  });
  // organic cross-links between neighbouring clusters
  for (let i = 0; i < CL.length; i++) {
    links.push({ source: `cl-${CL[i].key}`, target: `cl-${CL[(i + 1) % CL.length].key}`, kind: "cross", cluster: CL[i].key });
  }
  return { nodes, links };
}

function HermesMind3DInner({ mode = "dormant", breath = 0, voiceLevel = 0, activeClusters = [], solo = false, onTapHub }: {
  mode?: CoreMode; breath?: number; voiceLevel?: number; activeClusters?: string[]; solo?: boolean; onTapHub?: () => void;
}) {
  // Oracle mode → just the lone glowing core (+ its voice crown), alone in the starfield
  const data = useMemo(() => solo ? { nodes: [{ id: "hermes", name: "Hermes", kind: "hub", cluster: "hermes", color: HUB, val: 60 }], links: [] } : buildGraph(), [solo]);
  const fgRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [Graph, setGraph] = useState<ForceGraphModule | null>(null);
  const [THREE, setThree] = useState<ThreeModule | null>(null);
  const [BloomPass, setBloomPass] = useState<UnrealBloomPassCtor | null>(null);
  const [graphReady, setGraphReady] = useState(false);

  const live = useRef({ mode, breath, voiceLevel, activeClusters });
  live.current = { mode, breath, voiceLevel, activeClusters };
  const onTapRef = useRef(onTapHub); onTapRef.current = onTapHub;  // read latest via ref so memo can ignore its identity churn
  const meshes = useRef<Map<string, any>>(new Map());
  const glowTexRef = useRef<any>(null);
  const hoverRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      import("react-force-graph-3d"),
      import("three"),
      import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
    ]).then(([g, t, b]) => { if (!alive) return; setGraph(() => g.default); setThree(t); setBloomPass(() => b.UnrealBloomPass); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((e) => { for (const x of e) setSize({ w: x.contentRect.width, h: x.contentRect.height }); });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // wait for the force-graph instance, then signal ONCE — so the heavy scene/tick
  // setup runs once and is never restarted on resize (the cause of the flashing glitch).
  useEffect(() => {
    let raf = 0, cancelled = false;
    const check = () => { if (cancelled) return; if (fgRef.current) setGraphReady(true); else raf = requestAnimationFrame(check); };
    check();
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, []);

  useEffect(() => {
    if (!fgRef.current || !THREE) return;
    const fg = fgRef.current;
    try { const c = fg.controls?.(); if (c) { c.enableZoom = true; c.enablePan = false; c.autoRotate = true; c.autoRotateSpeed = 0.5; c.minDistance = 130; c.maxDistance = 950; } } catch {}
    try { fg.cameraPosition({ x: 0, y: 40, z: 480 }); } catch {}
    try {
      const charge = fg.d3Force("charge"); if (charge) charge.strength(-110);
      const lf = fg.d3Force("link");
      if (lf) lf.distance((l: any) => l.kind === "core" ? 95 : l.kind === "tool" ? 34 : l.kind === "aspect" ? 22 : 150);
    } catch {}

    const scene = fg.scene();
    if (!scene.userData.__hm) {
      scene.userData.__hm = true;
      scene.fog = new THREE.FogExp2(0x05140f, 0.0016);
      scene.add(new THREE.AmbientLight(0xffffff, 0.4));
      const k = new THREE.PointLight(0x7be0c8, 1.3, 1400); k.position.set(140, 200, 240); scene.add(k);
      const r = new THREE.PointLight(0x60a5fa, 0.8, 1100); r.position.set(-240, -140, -180); scene.add(r);
      // starfield
      const sg = new THREE.BufferGeometry(); const N = 1300; const pos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) { const rr = 800 + Math.random() * 700, th = Math.random() * 6.283, ph = Math.acos(2 * Math.random() - 1); pos[i * 3] = rr * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = rr * Math.sin(ph) * Math.sin(th); pos[i * 3 + 2] = rr * Math.cos(ph); }
      sg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0x9fb4c2, size: 1.3, transparent: true, opacity: 0.62, depthWrite: false }));
      stars.userData.__stars = true; scene.add(stars);
    }
    if (BloomPass && !scene.userData.__bloom && typeof fg.postProcessingComposer === "function") {
      try { const comp = fg.postProcessingComposer(); const bloom = new BloomPass(new THREE.Vector2(size.w, size.h), 0.5, 0.66, 0.42); comp.addPass(bloom); scene.userData.__bloom = bloom; } catch {}
    }

    const C = (h: string) => new THREE.Color(h);
    const NEUTRAL = C("#cfe9e0"), DORMANT = C("#aee0d6"), WHITE = C("#fff");  // dormant stays luminous — core always glows
    const cur = C("#7be0c8"), tmp = C("#fff"), acc = C("#fff");
    const clById: Record<string, any> = {}; CL.forEach((c) => (clById[c.key] = c));
    const L = (a: number, b: number, t: number) => a + (b - a) * t;
    let raf = 0;
    const tick = () => {
      const { mode: md, activeClusters: act } = live.current;  // STATE drives the core, never raw voice → can't spasm
      const t = performance.now() * 0.001;
      // camera orbit + zoom handled by OrbitControls (autoRotate); tick only drives node life

      // active colour = blend of firing zones; else neutral / dormant
      acc.setRGB(0, 0, 0); let na = 0;
      for (const k of act) { const c = clById[k]; if (c) { tmp.set(c.color); acc.add(tmp); na++; } }
      const target = na ? acc.multiplyScalar(1 / na) : (md === "dormant" ? DORMANT : NEUTRAL);
      cur.lerp(target, 0.045);

      meshes.current.forEach((m, id) => {
        if (!m.group.parent) return;  // skip meshes removed when graph data changed (e.g. Atlas⇄Oracle toggle)
        const on = act.includes(m.cluster);
        const hov = id === hoverRef.current;
        if (m.kind === "hub") {
          // Smooth STATE-driven "energy" envelope — a calm glow that brightens when the agent is
          // active. Driven ONLY by state (never the raw per-frame voice level), so it can't
          // jitter/spasm, and capped well below blow-out so it stays a COLOURED orb, not white.
          // ENGAGED (in a call / active) = a STEADY bright glow; dormant = calm. We deliberately do
          // NOT brighten per micro-state (talking vs listening) — that flag flickers many times per
          // sentence and was spasming the core. Steady energy + a slow fixed breath = alive, not jittery.
          // The core is ALWAYS a steady, bright, LIT orb (like the Memory hub) — it just breathes.
          // It does NOT dim/brighten with talking-state; that cycling is what read as glitchy + faded.
          // CONSTANT, and tuned to bloom CLEANLY — no bright-edge ring, no size-pulse, no crown.
          const bop = 1 + Math.sin(t * 1.3) * 0.007;  // barely-there breath → no halo flicker
          m.group.scale.setScalar(bop);
          m.mat.color.setRGB(0, 0, 0);  // black base → glows EVENLY from emissive alone
          m.mat.emissive.setHSL(0.47, 0.55, 0.6);  // lit teal, FIXED
          m.mat.emissiveIntensity = L(m.mat.emissiveIntensity, 1.45, 0.04);  // moderate → blooms cleanly (no perforated ring)
          if (m.glow) {
            if (m.glowBase === undefined) m.glowBase = m.glow.scale.x;
            m.glow.material.color.setHSL(0.47, 0.7, 0.55);
            m.glow.material.opacity = L(m.glow.material.opacity, 0.3, 0.05);  // soft halo, below the bloom-ring threshold
            const gs = m.glowBase * 1.2; m.glow.scale.set(gs, gs, 1);
          }
          if (m.ringGroup) m.ringGroup.visible = false;  // crown GONE — hide the whole group, definitively
          // faint static crown halo
          // crown removed entirely — it read as glitchy radial spikes around the core
          if (m.ring) { for (let i = 0; i < m.ring.length; i++) m.ring[i].material.opacity = 0; }
        } else {
          // hover → fluorescent pop (brighten + swell), like the knowledge-graph hover
          const tgtI = m.base * (on ? 2.5 : 1) * (hov ? 4 : 1);
          m.mat.emissiveIntensity = L(m.mat.emissiveIntensity, tgtI, hov ? 0.25 : 0.05);  // gentle ramp, not a snap-flash
          const s = L(m.group.scale.x, (on ? 1.2 : 1) * (hov ? 1.5 : 1), 0.1); m.group.scale.setScalar(s);
          if (m.halo) m.halo.material.opacity = (on ? 0.32 : 0.05) + (hov ? 0.3 : 0);
          if ((m.kind === "aspect" || m.kind === "memnode") && !hov) { const tw = 0.8 + 0.2 * Math.sin(t * 1.3 + m.phase); m.mat.emissiveIntensity = m.base * tw * (on ? 2.5 : 1); }
        }
      });

      scene.children.forEach((o: any) => { if (o.userData.__stars) o.rotation.y = t * 0.008; });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [BloomPass, THREE, graphReady]);  // NOT size → resizing never restarts the scene/tick (was the flash)

  // keep bloom resolution synced to size without restarting the scene
  useEffect(() => {
    try { const b = (fgRef.current as any)?.scene?.()?.userData?.__bloom; if (b?.resolution) b.resolution.set(size.w, size.h); } catch { /* not ready */ }
  }, [size.w, size.h]);

  const linkActive = (l: any) => activeClusters.includes(l.cluster);

  return (
    <div ref={wrapRef} className="w-full h-full relative">
      {Graph && THREE ? (
        <Graph
          ref={fgRef}
          controlType="orbit"
          width={size.w}
          height={size.h}
          graphData={data as any}
          backgroundColor="rgba(0,0,0,0)"
          showNavInfo={false}
          warmupTicks={90}
          cooldownTicks={220}
          nodeRelSize={6}
          enableNodeDrag={false}
          nodeLabel={(n: any) => `<div style="font:600 11px ui-monospace,monospace;padding:6px 9px;background:rgba(6,18,17,.94);border:1px solid #2a3f3a;border-radius:8px;color:#fff;letter-spacing:.04em">${n.kind === "hub" ? "HERMES" : n.name}</div>`}
          nodeThreeObject={(n: any) => {
            const THREEm = THREE!;
            const group = new THREEm.Group();
            const r = n.kind === "hub" ? 44 : n.kind === "cluster" ? 12 : n.kind === "vector" ? 9 : n.kind === "tool" ? 5.5 : 2 + (n.val || 2) * 0.5;
            // brighter at rest now (the stronger bloom does the rest) — glows like the Memory view
            const base = n.kind === "hub" ? 1.4 : n.kind === "cluster" ? 0.55 : n.kind === "vector" ? 0.8 : n.kind === "tool" ? 0.34 : 0.22;
            const mat = new THREEm.MeshStandardMaterial({ color: n.color, emissive: n.color, emissiveIntensity: base, roughness: 0.3, metalness: 0.12, transparent: true, opacity: n.kind === "aspect" ? 0.85 : 1 });
            // varied SHAPES per kind (like the Memory graph): clusters & memory-vectors are gem
            // diamonds, memory threads are icosahedra, everything else stays a sphere.
            const geom = (n.kind === "cluster" || n.kind === "vector") ? new THREEm.OctahedronGeometry(r, 0)
              : n.kind === "memnode" ? new THREEm.IcosahedronGeometry(r, 0)
              : new THREEm.SphereGeometry(r, n.kind === "aspect" ? 10 : 26, n.kind === "aspect" ? 10 : 26);
            const mesh = new THREEm.Mesh(geom, mat);
            group.add(mesh);
            let halo: any = null, glow: any = null, ring: any = null, ringGroup: any = null;
            if (n.kind === "hub") {
              // soft radial-gradient billboard → real phosphor glow with NO hard edge
              if (!glowTexRef.current) {
                const gc = document.createElement("canvas"); gc.width = gc.height = 128;
                const gx = gc.getContext("2d")!; const gg = gx.createRadialGradient(64, 64, 0, 64, 64, 64);
                gg.addColorStop(0, "rgba(255,255,255,1)"); gg.addColorStop(0.2, "rgba(255,255,255,0.5)"); gg.addColorStop(0.5, "rgba(255,255,255,0.12)"); gg.addColorStop(1, "rgba(255,255,255,0)");
                gx.fillStyle = gg; gx.fillRect(0, 0, 128, 128); glowTexRef.current = new THREEm.CanvasTexture(gc);
              }
              glow = new THREEm.Sprite(new THREEm.SpriteMaterial({ map: glowTexRef.current, color: n.color, transparent: true, opacity: 0.42, blending: THREEm.AdditiveBlending, depthWrite: false }));
              glow.scale.set(r * 3.8, r * 3.8, 1); group.add(glow);
              // voice crown — a ring of radial bars hugging the core, growing outward as a circular waveform when anyone speaks
              ringGroup = new THREEm.Group(); ring = [];
              const NB = 72, BH = 11, barGeo = new THREEm.PlaneGeometry(1.5, BH); barGeo.translate(0, BH / 2, 0); // pivot at inner end → grows outward
              const rad = r * 1.04;
              for (let i = 0; i < NB; i++) {
                const ang = (i / NB) * Math.PI * 2;
                const bar = new THREEm.Mesh(barGeo, new THREEm.MeshBasicMaterial({ color: n.color, transparent: true, opacity: 0.16, blending: THREEm.AdditiveBlending, depthWrite: false, side: THREEm.DoubleSide }));
                bar.position.set(Math.cos(ang) * rad, Math.sin(ang) * rad, 0);
                bar.rotation.z = ang - Math.PI / 2;  // local +Y points radially outward
                bar.userData.phase = i * 0.5;
                ringGroup.add(bar); ring.push(bar);
              }
              group.add(ringGroup);
            } else if (n.kind === "cluster" || n.kind === "vector") {
              halo = new THREEm.Mesh(new THREEm.SphereGeometry(r * 1.7, 24, 24), new THREEm.MeshBasicMaterial({ color: n.color, transparent: true, opacity: n.kind === "vector" ? 0.22 : 0.15, side: THREEm.BackSide, blending: THREEm.AdditiveBlending, depthWrite: false }));
              group.add(halo);
            }
            meshes.current.set(n.id, { group, mat, halo, glow, ring, ringGroup, base, kind: n.kind, cluster: n.cluster, phase: Math.random() * 6.28 });
            return group;
          }}
          linkColor={(l: any) => {
            if (linkActive(l)) { const c = CL.find((x) => x.key === l.cluster); return c ? c.color : "#9fe"; }
            if (l.kind === "core") return "rgba(123,224,200,0.4)";
            if (l.kind === "cross") return "rgba(150,170,190,0.16)";
            if (l.kind === "tool") return "rgba(180,190,210,0.22)";
            return "rgba(150,170,190,0.12)";
          }}
          linkWidth={(l: any) => (linkActive(l) ? 1.8 : l.kind === "core" ? 0.7 : 0.4)}
          linkOpacity={0.7}
          linkDirectionalParticles={(l: any) => (linkActive(l) ? 4 : l.kind === "core" ? 2 : l.kind === "cross" ? 2 : 1)}
          linkDirectionalParticleSpeed={(l: any) => (linkActive(l) ? 0.012 : 0.0035)}
          linkDirectionalParticleWidth={(l: any) => (linkActive(l) ? 2.4 : 1.3)}
          linkDirectionalParticleColor={(l: any) => { const c = CL.find((x) => x.key === l.cluster); return c ? c.color : "#7be0c8"; }}
          linkCurvature={(l: any) => (l.kind === "cross" ? 0.4 : l.kind === "aspect" ? 0.2 : 0)}
          onNodeHover={(n: any) => { hoverRef.current = n ? n.id : null; if (wrapRef.current) wrapRef.current.style.cursor = n ? "pointer" : ""; }}
          onNodeClick={(n: any) => { if (n.id === "hermes") onTapRef.current?.(); }}
        />
      ) : (
        <div className="w-full h-full grid place-items-center"><div className="hermes-mono text-[11px] uppercase tracking-[0.25em]" style={{ color: "rgba(123,224,200,0.6)" }}>waking the mind…</div></div>
      )}
    </div>
  );
}

// Re-render ONLY on state the 3D scene actually uses (mode / activeClusters / solo). breath &
// voiceLevel arrive at 60fps during a call but the scene reads NOTHING from them (the RAF tick
// reads live.current.{mode,activeClusters}); re-rendering on them made react-force-graph rebuild
// every node mesh each frame — THAT was the orb "flashing" while talking. onTapHub is read via a
// ref (onTapRef) so the comparator can ignore its per-render identity churn from the parent.
export const HermesMind3D = memo(HermesMind3DInner, (a, b) =>
  a.mode === b.mode && a.solo === b.solo &&
  (a.activeClusters || []).join("|") === (b.activeClusters || []).join("|"));
export default HermesMind3D;
