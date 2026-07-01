import { useEffect, useRef } from "react";

// Hermes's mind as ONE living network. A central orb sits at the core; every
// real tool is a NODE laid out in its capability ZONE and wired back to the orb.
// BEHIND the tools, each zone breathes a dense field of glowing "memory motes"
// (the little nodes) woven into one nebula — so even at rest it feels alive.
// When Hermes USES a capability, that zone lights, packets flow, and the orb
// itself floods to that zone's colour.
export type CoreMode = "dormant" | "listening" | "thinking" | "talking" | "working";

// key, label, colour, flow (in→orb / out←orb / core=both), ring angle (deg, -90=top)
export const CLUSTERS = [
  { key: "research",  label: "Research",  color: "#60a5fa", flow: "in",   ang: -90 },
  { key: "knowledge", label: "Knowledge", color: "#7be0c8", flow: "in",   ang: -38.6 },
  { key: "thinking",  label: "Thinking",  color: "#b9a6ff", flow: "core", ang: 12.9 },
  { key: "action",    label: "Action",    color: "#ff8a3c", flow: "out",  ang: 64.3 },
  { key: "comms",     label: "Comms",     color: "#46e0a0", flow: "out",  ang: 115.7 },
  { key: "creation",  label: "Creation",  color: "#ff5a7a", flow: "out",  ang: 167.1 },
  { key: "memory",    label: "Memory",    color: "#ff9da7", flow: "core", ang: 218.6 },
] as const;

export type CoreNode = { key: string; cluster: string; color: string };

export function AgentCore3D({ mode = "dormant", breath = 0, activeClusters = [], nodes = [] }: {
  mode?: CoreMode; breath?: number; activeClusters?: string[]; nodes?: CoreNode[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const live = useRef({ mode, breath, activeClusters });
  live.current = { mode, breath, activeClusters };

  useEffect(() => {
    let alive = true;
    let cleanup = () => {};
    Promise.all([
      import("three"),
      import("three/examples/jsm/postprocessing/EffectComposer.js"),
      import("three/examples/jsm/postprocessing/RenderPass.js"),
      import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
    ]).then(([THREE, { EffectComposer }, { RenderPass }, { UnrealBloomPass }]) => {
      if (!alive || !host.current) return;
      const el = host.current;
      let W = el.clientWidth || 800, H = el.clientHeight || 600;
      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x05140f, 0.0013);
      const camera = new THREE.PerspectiveCamera(50, W / H, 1, 4000); camera.position.z = 340;
      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setSize(W, H); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      el.appendChild(renderer.domElement);

      const cv = document.createElement("canvas"); cv.width = cv.height = 64;
      const cx = cv.getContext("2d")!; const grd = cx.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, "#fff"); grd.addColorStop(0.25, "rgba(255,255,255,.9)"); grd.addColorStop(1, "rgba(255,255,255,0)");
      cx.fillStyle = grd; cx.fillRect(0, 0, 64, 64); const sprite = new THREE.CanvasTexture(cv);
      const C = (h: string) => new THREE.Color(h);
      const clById: Record<string, any> = {}; CLUSTERS.forEach((c) => (clById[c.key] = c));
      const clIdx: Record<string, number> = {}; CLUSTERS.forEach((c, i) => (clIdx[c.key] = i));

      const NODE_R = 150, XS = 1.34;   // widen X so the network fills the wide panel

      // ---- zone centres ----
      const zone = CLUSTERS.map((cl) => { const a = (cl.ang * Math.PI) / 180; return { cl, x: NODE_R * Math.cos(a) * XS, y: NODE_R * Math.sin(a), col: C(cl.color) }; });

      // ---- dense memory motes: the living "little nodes" behind each zone ----
      const MPER = 52, MN = MPER * CLUSTERS.length;
      const mpos = new Float32Array(MN * 3), mcol = new Float32Array(MN * 3);
      const mhome = new Float32Array(MN * 3), mbase = new Float32Array(MN), mphase = new Float32Array(MN), mcl = new Int32Array(MN), msz = new Float32Array(MN);
      let mi = 0;
      zone.forEach((z, ci) => {
        for (let i = 0; i < MPER; i++) {
          const rr = Math.pow(Math.random(), 0.65) * 96;     // bloom out from the zone, denser at centre
          const aa = Math.random() * Math.PI * 2;
          const x = z.x + Math.cos(aa) * rr * 1.05, y = z.y + Math.sin(aa) * rr, zz = (Math.random() - 0.5) * 86;
          mhome[mi * 3] = x; mhome[mi * 3 + 1] = y; mhome[mi * 3 + 2] = zz;
          mpos[mi * 3] = x; mpos[mi * 3 + 1] = y; mpos[mi * 3 + 2] = zz;
          mbase[mi] = 0.12 + Math.random() * 0.22; mphase[mi] = Math.random() * 6.28; mcl[mi] = ci; msz[mi] = 1.6 + Math.random() * 2.6;
          mi++;
        }
      });
      const moteGeo = new THREE.BufferGeometry();
      moteGeo.setAttribute("position", new THREE.BufferAttribute(mpos, 3));
      moteGeo.setAttribute("color", new THREE.BufferAttribute(mcol, 3));
      const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({ size: 3.4, map: sprite, vertexColors: true, transparent: true, opacity: 0.92, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
      scene.add(motes);

      // ---- mote web: faint neuron links woven through the field (one organism) ----
      const wl: number[] = [];
      for (let i = 0; i < MN; i++) { let made = 0; for (let k = 1; k <= 40 && made < 2; k++) { const j = (i + k * 7) % MN; if (j === i) continue; const dx = mhome[i * 3] - mhome[j * 3], dy = mhome[i * 3 + 1] - mhome[j * 3 + 1], dz = mhome[i * 3 + 2] - mhome[j * 3 + 2]; if (dx * dx + dy * dy + dz * dz < 2600) { wl.push(mhome[i * 3], mhome[i * 3 + 1], mhome[i * 3 + 2], mhome[j * 3], mhome[j * 3 + 1], mhome[j * 3 + 2]); made++; } } }
      const webGeo = new THREE.BufferGeometry(); webGeo.setAttribute("position", new THREE.Float32BufferAttribute(wl, 3));
      const web = new THREE.LineSegments(webGeo, new THREE.LineBasicMaterial({ color: C("#7fa8b8"), transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false }));
      scene.add(web);

      // ---- per-zone nebula glow ----
      const nebulae = zone.map((z) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: sprite, color: z.col.clone(), transparent: true, opacity: 0.05, depthWrite: false, blending: THREE.AdditiveBlending })); s.position.set(z.x, z.y, -46); s.scale.set(240, 240, 1); scene.add(s); return { z, s }; });

      // ---- the real tool nodes (logo anchors) ----
      const byCl: Record<string, CoreNode[]> = {}; CLUSTERS.forEach((c) => (byCl[c.key] = []));
      nodesRef.current.forEach((n) => { (byCl[n.cluster] ||= []).push(n); });
      const nodeObjs: any[] = [];
      zone.forEach((z) => {
        const list = byCl[z.cl.key] || [];
        const base = (z.cl.ang * Math.PI) / 180;
        list.forEach((nd, j) => {
          const ro = 26 * Math.sqrt(j), ao = j * 2.399;
          const ax = (NODE_R * Math.cos(base) + ro * Math.cos(ao)) * XS;
          const ay = NODE_R * Math.sin(base) + ro * Math.sin(ao);
          const az = ((j % 3) - 1) * 15;
          nodeObjs.push({ ...nd, anchor: [ax, ay, az], chip: null as any, b: 0.12 });
        });
      });
      const NN = nodeObjs.length;

      // orb→node spokes (vertex-coloured so active zones brighten)
      const spos = new Float32Array(NN * 6), scol = new Float32Array(NN * 6);
      nodeObjs.forEach((n, i) => { spos[i * 6 + 3] = n.anchor[0]; spos[i * 6 + 4] = n.anchor[1]; spos[i * 6 + 5] = n.anchor[2]; });
      const spokeGeo = new THREE.BufferGeometry();
      spokeGeo.setAttribute("position", new THREE.BufferAttribute(spos, 3));
      spokeGeo.setAttribute("color", new THREE.BufferAttribute(scol, 3));
      const spokes = new THREE.LineSegments(spokeGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.62, blending: THREE.AdditiveBlending, depthWrite: false }));
      scene.add(spokes);

      // info packets — one per node; flows fast+bright when its zone is active, slow+dim at rest (ambient life)
      const ppos = new Float32Array(NN * 3), pcol = new Float32Array(NN * 3), pprog = new Float32Array(NN), pspd = new Float32Array(NN);
      nodeObjs.forEach((n, i) => { pprog[i] = Math.random(); pspd[i] = 0.006 + Math.random() * 0.012; });
      const pkGeo = new THREE.BufferGeometry(); pkGeo.setAttribute("position", new THREE.BufferAttribute(ppos, 3)); pkGeo.setAttribute("color", new THREE.BufferAttribute(pcol, 3));
      const packets = new THREE.Points(pkGeo, new THREE.PointsMaterial({ size: 6, map: sprite, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }));
      scene.add(packets);

      // central Hermes orb (the chameleon)
      const orb = new THREE.Mesh(new THREE.SphereGeometry(15, 40, 40), new THREE.MeshBasicMaterial({ color: C("#eafff8") }));
      const halo = new THREE.Mesh(new THREE.SphereGeometry(46, 32, 32), new THREE.MeshBasicMaterial({ color: C("#7be0c8"), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, side: THREE.BackSide }));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(27, 0.7, 12, 84), new THREE.MeshBasicMaterial({ color: C("#7be0c8"), transparent: true, opacity: 0, blending: THREE.AdditiveBlending }));
      ring.rotation.x = 1.12;
      scene.add(orb); scene.add(halo); scene.add(ring);

      // projected zone labels
      const labs = zone.map((z) => {
        const a = (z.cl.ang * Math.PI) / 180; const lr = NODE_R + 34;
        const lab = document.createElement("div"); lab.textContent = z.cl.label;
        lab.style.cssText = "position:absolute;transform:translate(-50%,-50%);font:600 9px ui-monospace,monospace;letter-spacing:1.6px;text-transform:uppercase;pointer-events:none;white-space:nowrap;transition:color .4s,opacity .4s;text-shadow:0 1px 8px #000;z-index:3";
        el.appendChild(lab);
        return { cl: z.cl, lpos: [lr * Math.cos(a) * XS, lr * Math.sin(a), 0], lab };
      });

      const composer = new EffectComposer(renderer); composer.addPass(new RenderPass(scene, camera));
      const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 1.05, 0.62, 0.0); composer.addPass(bloom);
      const ro = new ResizeObserver(() => { W = el.clientWidth || W; H = el.clientHeight || H; renderer.setSize(W, H); composer.setSize(W, H); bloom.setSize(W, H); camera.aspect = W / H; camera.updateProjectionMatrix(); });
      ro.observe(el);

      const MODES: Record<string, { bloom: number; orb: number; halo: number }> = {
        dormant:   { bloom: 0.62, orb: 0.8,  halo: 0.4 },
        listening: { bloom: 0.95, orb: 1.0,  halo: 0.64 },
        thinking:  { bloom: 1.1,  orb: 1.04, halo: 0.7 },
        talking:   { bloom: 1.25, orb: 1.14, halo: 0.78 },
        working:   { bloom: 1.1,  orb: 1.06, halo: 0.68 },
      };
      const NEUTRAL = C("#cfe9e0"), DORMANT = C("#6f7976"), WHITE = C("#ffffff");
      let bl = 0.9, os = 0.85, ho = 0.4;
      const curCol = C("#7be0c8"), tmp = C("#fff"), acc = C("#fff");
      const L = (a: number, b: number, t: number) => a + (b - a) * t;
      const v3 = new THREE.Vector3();

      let raf = 0;
      const tick = () => {
        camera.updateMatrixWorld();  // keep matrixWorldInverse current so project() is accurate from frame 1
        const { mode: md, breath: br, activeClusters: act } = live.current;
        const T = MODES[md] || MODES.listening;
        bl = L(bl, T.bloom, 0.05); os = L(os, T.orb, 0.06); ho = L(ho, T.halo, 0.06);
        const t = performance.now();
        const wob = 1 + Math.sin(t * 0.0015) * 0.02;

        // active colour = average of the firing zones' colours; else neutral/dormant
        acc.setRGB(0, 0, 0); let na = 0;
        for (const k of act) { const c = clById[k]; if (c) { tmp.set(c.color); acc.add(tmp); na++; } }
        const target = na ? acc.multiplyScalar(1 / na) : (md === "dormant" ? DORMANT : NEUTRAL);
        curCol.lerp(target, 0.09);

        const oscale = (os + br * 0.5) * (1 + Math.sin(t * 0.002) * 0.03);
        (orb.material as any).color.copy(curCol).lerp(WHITE, 0.3);
        orb.scale.setScalar(oscale);
        halo.material.color.copy(curCol); halo.material.opacity = ho + br * 0.4; halo.scale.setScalar(oscale);
        ring.material.color.copy(curCol); (ring.material as any).opacity = na ? 0.45 + 0.3 * Math.abs(Math.sin(t * 0.005)) : 0; ring.scale.setScalar(oscale * 1.04); ring.rotation.z += 0.008;
        bloom.strength = bl + br * 0.7;
        web.material.opacity = 0.06 + 0.03 * (0.5 + 0.5 * Math.sin(t * 0.0012)) + br * 0.04;

        // motes — twinkle + gentle drift; brighten when their zone is active
        for (let i = 0; i < MN; i++) {
          const ci = mcl[i], on = act.includes(CLUSTERS[ci].key);
          const tw = mbase[i] * (0.5 + 0.5 * Math.sin(t * 0.0016 + mphase[i]));
          const f = Math.min(1, tw * (on ? 6.5 : 1.9));
          const z = zone[ci];
          mcol[i * 3] = z.col.r * f; mcol[i * 3 + 1] = z.col.g * f; mcol[i * 3 + 2] = z.col.b * f;
          const dr = on ? 7 : 3.5;
          mpos[i * 3] = mhome[i * 3] + Math.sin(t * 0.0007 + mphase[i]) * dr;
          mpos[i * 3 + 1] = mhome[i * 3 + 1] + Math.cos(t * 0.0006 + mphase[i] * 1.3) * dr;
        }
        moteGeo.attributes.color.needsUpdate = true; moteGeo.attributes.position.needsUpdate = true;

        // nebula breathing
        nebulae.forEach(({ z, s }) => { const on = act.includes(z.cl.key); s.material.opacity = (on ? 0.2 : 0.045) * (0.8 + 0.2 * Math.sin(t * 0.0014)); });

        // tool spokes — colour brightens with the zone
        const flash = 1 + Math.sin(t * 0.008) * 0.25;
        for (let i = 0; i < NN; i++) {
          const n = nodeObjs[i]; const on = act.includes(n.cluster);
          n.b = L(n.b, on ? 1 : 0.13, 0.1);
          tmp.set(n.color).multiplyScalar(n.b * (on ? flash : 1));
          scol[i * 6] = scol[i * 6 + 3] = tmp.r; scol[i * 6 + 1] = scol[i * 6 + 4] = tmp.g; scol[i * 6 + 2] = scol[i * 6 + 5] = tmp.b;
          if (!n.chip) n.chip = document.getElementById("ip-node-" + n.key);
          if (n.chip) {
            v3.set(n.anchor[0] * wob, n.anchor[1] * wob, n.anchor[2]).project(camera);
            const sx = (v3.x * 0.5 + 0.5) * W, sy = (-v3.y * 0.5 + 0.5) * H;
            n.chip.style.transform = `translate(-50%,-50%) translate(${sx}px,${sy}px) scale(${on ? 1.12 : 1})`;
          }
        }
        spokeGeo.attributes.color.needsUpdate = true;

        // packets — always flowing; fast & bright on active zones, slow & dim at rest
        for (let i = 0; i < NN; i++) {
          const n = nodeObjs[i]; const cl = clById[n.cluster]; const on = act.includes(n.cluster);
          pprog[i] += pspd[i] * (on ? 2.6 : 0.55); if (pprog[i] >= 1) pprog[i] = 0;
          let e = pprog[i];
          if (cl.flow === "out") e = 1 - e; else if (cl.flow === "core") e = 0.5 + 0.5 * Math.sin(pprog[i] * Math.PI);
          ppos[i * 3] = n.anchor[0] * e * wob; ppos[i * 3 + 1] = n.anchor[1] * e * wob; ppos[i * 3 + 2] = n.anchor[2] * e;
          const dim = on ? 1 : 0.22; tmp.set(n.color).multiplyScalar(dim);
          pcol[i * 3] = tmp.r; pcol[i * 3 + 1] = tmp.g; pcol[i * 3 + 2] = tmp.b;
        }
        pkGeo.attributes.position.needsUpdate = true; pkGeo.attributes.color.needsUpdate = true;

        labs.forEach(({ cl, lpos, lab }) => {
          const on = act.includes(cl.key);
          v3.set(lpos[0] * wob, lpos[1] * wob, lpos[2]).project(camera);
          lab.style.left = ((v3.x * 0.5 + 0.5) * W) + "px";
          lab.style.top = ((-v3.y * 0.5 + 0.5) * H) + "px";
          lab.style.color = on ? cl.color : "rgba(255,230,203,0.4)";
          lab.style.opacity = on ? "1" : "0.55";
        });

        composer.render(); raf = requestAnimationFrame(tick);
      };
      tick();

      cleanup = () => { cancelAnimationFrame(raf); ro.disconnect(); labs.forEach((l) => l.lab.remove()); try { el.removeChild(renderer.domElement); } catch {} renderer.dispose(); };
    });
    return () => { alive = false; cleanup(); };
  }, []);

  return <div ref={host} className="w-full h-full relative" />;
}

export default AgentCore3D;
