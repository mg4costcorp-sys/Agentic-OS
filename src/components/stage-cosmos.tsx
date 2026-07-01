// V2 "COSMOS" — the cosmic, awe-scale living-mind stage (Cosmos art-direction).
// Hermes as a field of intelligence at galactic scale: a tilted accretion disk
// of thousands of additive particles (Keplerian — faster inner, colour-graded
// white-hot→violet) spiralling a singularity core, passing BEHIND it for the
// black-hole read; a parallax starfield + slow nebula; the 7 capability clusters
// as distant constellation-stars that flare and fire a signal-streak inward when
// they activate; gravitational ripples + an aurora when it speaks. Voice level
// surges the disk. Pure 2D canvas, additive compositing, DPR-aware, paused hidden.
import { useEffect, useRef } from "react";
import { CLUSTERS, STATE_COLOR, rgba, mix, clamp, damp, hexToRgb } from "@/lib/mind-map";
import { SyntheticVoice } from "@/lib/synthetic-voice";
import type { StageProps } from "@/components/stage-aurora";

type P = { rad: number; ang: number; sp: number; size: number; r: number; g: number; b: number; tw: number };

export function StageCosmos(props: StageProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef(props);
  liveRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0, h = 0, dpr = 1;
    let disk: P[] = [];
    let innerR = 60, outerR = 300;
    const build = () => {
      const baseR = Math.max(26, Math.min(w, h) * 0.05);
      innerR = baseR * 1.3; outerR = Math.min(w, h) * 0.46;
      const N = Math.round(clamp((w * h) / 560, 1100, 2600));
      disk = new Array(N);
      for (let i = 0; i < N; i++) {
        const norm = Math.pow(Math.random(), 0.62);        // bias inward → dense hot core edge
        const rad = innerR + (outerR - innerR) * norm;
        const inner = 1 - norm;                            // 1 inner, 0 outer
        // colour: white-hot → cyan → violet outward
        const c = inner > 0.5 ? mix("#5ad7ff", "#ffffff", (inner - 0.5) * 2) : mix("#7a4bff", "#5ad7ff", inner * 2);
        disk[i] = { rad, ang: Math.random() * 6.2832, sp: (0.05 + Math.pow(innerR / rad, 1.5) * 0.5), size: 0.6 + inner * 1.5, r: c[0], g: c[1], b: c[2], tw: Math.random() * 6.28 };
      }
    };
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      w = Math.max(2, r.width); h = Math.max(2, r.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
      build();
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(wrap);

    // parallax starfield (two layers)
    const stars = Array.from({ length: 420 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random() < 0.66 ? 0.4 : 1, ph: Math.random() * 6.28 }));
    const act = new Float32Array(CLUSTERS.length);
    const synth = new SyntheticVoice();
    const t0 = performance.now();
    let prev = t0, raf = 0, lv = 0; let lastMode = "";
    const tilt = 0.42;
    // eased state colour → crossfades on mode changes instead of snapping (no colour strobe = no "spasm")
    let scr = 123, scg = 224, scb = 200;
    const hx = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

    const glow = (x: number, y: number, r: number, col: string, a: number) => {
      if (a <= 0 || r <= 0) return;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(col, a)); g.addColorStop(0.45, rgba(col, a * 0.4)); g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
    };

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) { prev = now; return; }
      const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
      const t = (now - t0) / 1000;
      const p = liveRef.current;
      let mode = p.mode, level = p.level;
      if (p.attract) { const s = synth.tick(dt); mode = s.mode; level = s.level; }
      if (p.attract && mode !== lastMode) { lastMode = mode; p.onState?.(mode); }
      const boot = clamp((now - t0) / 2000);
      const bootE = 1 - Math.pow(1 - boot, 3);
      const tau = level > lv ? 0.05 : 0.17;
      lv = damp(lv, clamp(level), tau, dt);
      const [tr, tg, tb] = hexToRgb(STATE_COLOR[mode]);
      scr = damp(scr, tr, 0.14, dt); scg = damp(scg, tg, 0.14, dt); scb = damp(scb, tb, 0.14, dt);
      const col = `#${hx(scr)}${hx(scg)}${hx(scb)}`;
      const cx = w / 2, cy = h * 0.47;
      const baseR = Math.max(26, Math.min(w, h) * 0.05);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#03070d"; ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = "lighter";
      // nebula
      glow(cx + Math.cos(t * 0.03) * w * 0.22, cy - h * 0.12 + Math.sin(t * 0.04) * h * 0.1, Math.max(w, h) * 0.45, "#3a1f6e", 0.16 * bootE);
      glow(cx + Math.cos(t * 0.05 + 2) * w * 0.24, cy + h * 0.16, Math.max(w, h) * 0.4, "#0c4a52", 0.14 * bootE);
      glow(cx - w * 0.2, cy + h * 0.05, Math.max(w, h) * 0.3, "#5a2a10", 0.08 * bootE);

      // starfield
      for (const s of stars) {
        s.ph += dt * (0.5 + s.z);
        const px = ((s.x + t * 0.005 * s.z) % 1) * w;
        const py = s.y * h;
        const tw = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(s.ph));
        ctx.fillStyle = rgba("#dfeaff", tw * (s.z < 1 ? 0.4 : 0.85) * bootE);
        const sz = s.z < 1 ? 1 : 1.6; ctx.fillRect(px, py, sz, sz);
      }

      const dopp = t * 0.6;                  // rotational sheen direction
      const spinBoost = 1 + lv * 1.1;
      // advance every particle ONCE per frame, then split front/back consistently
      for (let i = 0; i < disk.length; i++) disk[i].ang += disk[i].sp * dt * spinBoost;
      // ---- accretion disk, split front/back around the core ----
      const drawDisk = (front: boolean) => {
        for (let i = 0; i < disk.length; i++) {
          const d = disk[i];
          if ((Math.sin(d.ang) >= 0) !== front) continue;
          const x = cx + Math.cos(d.ang) * d.rad;
          const y = cy + Math.sin(d.ang) * d.rad * tilt;
          const inner = clamp(1 - (d.rad - innerR) / (outerR - innerR));
          const sheen = 0.7 + 0.4 * (0.5 + 0.5 * Math.cos(d.ang - dopp));
          const tw = 0.55 + 0.45 * Math.sin(d.tw + t * 2.2);
          const a = clamp((0.5 + inner * 0.5) * sheen * tw * (0.45 + lv * 0.6) * bootE);
          // hot inner edge tints toward state colour as it speaks
          const rr = d.r, gg = d.g, bb = d.b;
          ctx.fillStyle = `rgba(${rr | 0},${gg | 0},${bb | 0},${a})`;
          const sz = d.size * (1 + lv * 0.5);
          ctx.fillRect(x, y, sz, sz);
        }
      };
      // back half first (behind the core), then the core, then the front half
      drawDisk(false);

      // ===== blazing singularity core — the epic centrepiece (additive throughout) =====
      const R = baseR * 1.5;
      // layered corona, colour-graded to white-hot
      glow(cx, cy, R * (7 + lv * 3), col, (0.16 + lv * 0.2) * bootE);
      glow(cx, cy, R * 3.4, col, (0.32 + lv * 0.25) * bootE);
      glow(cx, cy, R * 1.8, "#cfe7ff", (0.4 + lv * 0.28) * bootE);
      // slow rotating corona flares (lens-flare drama)
      for (let f = 0; f < 6; f++) {
        const fa = t * 0.25 + f * 1.047;
        glow(cx + Math.cos(fa) * R * 0.5, cy + Math.sin(fa) * R * 0.5, R * 2.1, col, 0.07 * bootE);
      }
      // brilliant photon ring (the disk's blazing inner edge)
      ctx.strokeStyle = rgba(col, 0.5 * bootE); ctx.lineWidth = 6 + lv * 4;
      ctx.beginPath(); ctx.ellipse(cx, cy, innerR, innerR * tilt, 0, 0, 6.2832); ctx.stroke();
      ctx.strokeStyle = rgba("#eaf6ff", (0.7 + lv * 0.3) * bootE); ctx.lineWidth = 2.5 + lv * 3;
      ctx.beginPath(); ctx.ellipse(cx, cy, innerR, innerR * tilt, 0, 0, 6.2832); ctx.stroke();
      // white-hot blazing core body (not a dark planet)
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      core.addColorStop(0, rgba("#ffffff", 0.98 * bootE));
      core.addColorStop(0.4, rgba("#dff1ff", 0.85 * bootE));
      core.addColorStop(0.75, rgba(col, 0.5 * bootE));
      core.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = core; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.2832); ctx.fill();
      glow(cx, cy, R * 0.5, "#ffffff", (0.7 + lv * 0.3) * bootE);
      // bright diffraction spikes (star flare)
      ctx.strokeStyle = rgba("#eaf6ff", (0.28 + lv * 0.3) * bootE); ctx.lineWidth = 1.2;
      for (const ang of [0, Math.PI / 2]) {
        const len = R * (3.5 + lv * 2);
        ctx.beginPath(); ctx.moveTo(cx - Math.cos(ang) * len, cy - Math.sin(ang) * len); ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len); ctx.stroke();
      }

      drawDisk(true);

      // ---- capability constellation-stars (outer wide ring) ----
      const cr = Math.min(w, h) * 0.45;
      for (let i = 0; i < CLUSTERS.length; i++) {
        const c = CLUSTERS[i];
        const ang = -Math.PI / 2 + (i / CLUSTERS.length) * Math.PI * 2 + t * 0.012;
        const sx = cx + Math.cos(ang) * cr, sy = cy + Math.sin(ang) * cr * 0.82;
        const appear = clamp((boot - 0.3 - i * 0.05) / 0.4);
        if (appear <= 0.01) continue;
        const on = p.activeClusters.includes(c.key) ? 1 : 0;
        act[i] = damp(act[i], on, on ? 0.08 : 0.6, dt);
        const a = act[i];
        // tool mini-stars
        for (let s = 0; s < c.tools.length; s++) {
          const aa = ang + (s - c.tools.length / 2) * 0.12;
          const rr = cr + (s % 2 ? 16 : -16);
          ctx.fillStyle = rgba(c.color, (0.3 + a * 0.5) * appear);
          ctx.fillRect(cx + Math.cos(aa) * rr - 0.5, cy + Math.sin(aa) * rr * 0.82 - 0.5, 1.6, 1.6);
        }
        // signal streak inward (or outward when speaking)
        if (a > 0.04) {
          const out = mode === "talking";
          for (let k = 0; k < 3; k++) {
            const u0 = (t * 0.6 + k / 3) % 1;
            const u = out ? u0 : 1 - u0;
            const bx = sx + (cx - sx) * (1 - u), by = sy + (cy - sy) * (1 - u);
            glow(bx, by, 7 * a, c.color, 0.45 * a);
          }
          ctx.strokeStyle = rgba(c.color, 0.12 * a); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(cx, cy); ctx.stroke();
        }
        glow(sx, sy, (10 + a * 16) * appear, c.color, (0.4 + a * 0.5) * appear);
        ctx.fillStyle = rgba("#ffffff", (0.6 + a * 0.4) * appear);
        ctx.fillRect(sx - 1.4, sy - 1.4, 2.8, 2.8);
        ctx.globalCompositeOperation = "source-over";
        ctx.font = "600 8.5px ui-monospace, monospace"; ctx.textAlign = "center";
        ctx.fillStyle = rgba("#cfe0ff", (0.3 + a * 0.6) * appear);
        ctx.fillText(c.label.toUpperCase(), sx, sy + 18);
        ctx.globalCompositeOperation = "lighter";
      }

      // ---- speaking: gravitational ripples + aurora ----
      if (mode === "talking") {
        const ph = (t * 0.25) % 1;
        ctx.strokeStyle = rgba(col, (1 - ph) * 0.18 * (0.4 + lv)); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(cx, cy, innerR + ph * outerR, (innerR + ph * outerR) * tilt, 0, 0, 6.2832); ctx.stroke();
        for (let b = 0; b < 4; b++) {
          const bx = (b + 0.5) / 4 * w + Math.sin(t * 0.4 + b) * 30;
          const g = ctx.createLinearGradient(bx, 0, bx, h * 0.36);
          const ac = [col, "#7be0c8", "#a78bff", "#ffd21e"][b];
          g.addColorStop(0, rgba(ac, 0)); g.addColorStop(0.5, rgba(ac, 0.06 * lv)); g.addColorStop(1, rgba(ac, 0));
          ctx.fillStyle = g; ctx.fillRect(bx - 60, 0, 120, h * 0.36);
        }
      }

      ctx.globalCompositeOperation = "source-over";
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return (
    <div ref={wrapRef} className="w-full h-full relative" style={{ cursor: "pointer" }} onClick={() => liveRef.current.onTap?.()}>
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  );
}

export default StageCosmos;
