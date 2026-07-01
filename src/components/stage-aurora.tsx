// V1 "AURORA" — the warm, organic living-mind stage (Oracle art-direction).
// Hermes as a divine amber intelligence: a breathing singularity core ringed by
// a circular voice-crown, a slowly-revolving constellation of the 7 capability
// clusters (each with orbiting tool-satellites), energy streaming inward along
// active links, spoken-word ripples when it talks, and a cool focus-ring when it
// listens. Pure 2D canvas, additive ('lighter') compositing, DPR-aware, paused
// when hidden. Voice level is double-smoothed (fast attack / slow release) so it
// blooms intentionally and never spasms.
import { useEffect, useRef } from "react";
import { CLUSTERS, STATE_COLOR, rgba, lerp, clamp, damp, hexToRgb, type CoreMode } from "@/lib/mind-map";
import { SyntheticVoice } from "@/lib/synthetic-voice";

export type StageProps = {
  mode: CoreMode;
  level: number;             // 0..1 voice / activity
  activeClusters: string[];  // cluster keys currently firing
  attract?: boolean;         // demo/attract mode → drive level+state synthetically
  onState?: (m: CoreMode) => void;  // report synthetic state up (keeps the HUD coherent)
  onTap?: () => void;        // tap stage → start / stop the call
};

export function StageAurora(props: StageProps) {
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
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      w = Math.max(2, r.width); h = Math.max(2, r.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(wrap);

    const t0 = performance.now();
    let prev = t0, raf = 0, lv = 0; let lastMode: CoreMode | null = null;
    // eased state colour → crossfades on mode changes instead of snapping (no colour strobe = no "spasm")
    let cr = 123, cg = 224, cb = 200;
    const hx = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    const NB = 76; const crown = new Float32Array(NB);
    const DUST = 150;
    const dust = Array.from({ length: DUST }, () => ({ x: Math.random(), y: Math.random(), z: 0.3 + Math.random() * 0.7, ph: Math.random() * 6.28, sp: 0.2 + Math.random() * 0.5 }));
    const ripples: { r: number; a: number }[] = [];
    let rippleClock = 0;
    const act = new Float32Array(CLUSTERS.length);
    const synth = new SyntheticVoice();

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
      const boot = clamp((now - t0) / 1700);
      const bootE = 1 - Math.pow(1 - boot, 3);

      const tau = level > lv ? 0.05 : 0.16;
      lv = damp(lv, clamp(level), tau, dt);
      const [tr, tg, tb] = hexToRgb(STATE_COLOR[mode]);
      cr = damp(cr, tr, 0.14, dt); cg = damp(cg, tg, 0.14, dt); cb = damp(cb, tb, 0.14, dt);
      const col = `#${hx(cr)}${hx(cg)}${hx(cb)}`;
      const cx = w / 2, cy = h * 0.46;
      const baseR = Math.max(34, Math.min(w, h) * 0.085);
      const orbit = Math.min(w, h) * 0.34;
      const tilt = 0.58;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.75);
      bg.addColorStop(0, "#08201c"); bg.addColorStop(0.55, "#061613"); bg.addColorStop(1, "#03100e");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = "lighter";
      glow(cx + Math.cos(t * 0.06) * w * 0.18, cy + Math.sin(t * 0.05) * h * 0.12, Math.max(w, h) * 0.4, "#ff8a3c", 0.05 * bootE);
      glow(cx + Math.cos(t * 0.04 + 2) * w * 0.2, cy + Math.sin(t * 0.07 + 1) * h * 0.14, Math.max(w, h) * 0.42, "#7be0c8", 0.05 * bootE);

      for (const d of dust) {
        d.ph += dt * d.sp;
        const px = ((d.x + t * 0.004 * d.z) % 1) * w;
        const py = ((d.y + Math.sin(d.ph) * 0.01) % 1 + 1) % 1 * h;
        const tw = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(d.ph * 2));
        ctx.fillStyle = rgba("#ffe6cb", tw * 0.5 * d.z * bootE);
        const s = d.z * 1.5; ctx.fillRect(px, py, s, s);
      }

      const spin = t * 0.045;
      const order = CLUSTERS.map((c, i) => {
        const ang = spin + (i / CLUSTERS.length) * Math.PI * 2;
        return { c, i, x: cx + Math.cos(ang) * orbit, y: cy + Math.sin(ang) * orbit * tilt, depth: (Math.sin(ang) + 1) / 2 };
      }).sort((a, b) => a.depth - b.depth);

      for (const o of order) {
        const on = p.activeClusters.includes(o.c.key) ? 1 : 0;
        act[o.i] = damp(act[o.i], on, on ? 0.08 : 0.5, dt);
        const a = act[o.i];
        const rev = 0.4 + o.depth * 0.6;
        const appear = clamp((boot - 0.15 - o.i * 0.04) / 0.4);
        const vis = rev * appear;
        if (vis <= 0.01) continue;

        const mx = (cx + o.x) / 2, my = (cy + o.y) / 2 - 14 * (1 - o.depth);
        ctx.strokeStyle = rgba(o.c.color, (0.06 + a * 0.28) * vis);
        ctx.lineWidth = 0.8 + a * 1.6;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(mx, my, o.x, o.y); ctx.stroke();

        if (a > 0.05) {
          for (let k = 0; k < 4; k++) {
            const u = 1 - ((t * 0.5 + k / 4) % 1);
            const bx = (1 - u) * (1 - u) * o.x + 2 * (1 - u) * u * mx + u * u * cx;
            const by = (1 - u) * (1 - u) * o.y + 2 * (1 - u) * u * my + u * u * cy;
            glow(bx, by, 9 * a, o.c.color, 0.5 * a);
          }
        }

        const sr = baseR * (0.5 + a * 0.18) * (0.5 + o.depth * 0.5);
        for (let s = 0; s < o.c.tools.length; s++) {
          const sa = t * (0.25 + (s % 3) * 0.05) + (s / o.c.tools.length) * Math.PI * 2;
          ctx.fillStyle = rgba(o.c.color, (0.3 + a * 0.5) * vis);
          ctx.fillRect(o.x + Math.cos(sa) * sr * 1.7 - 1, o.y + Math.sin(sa) * sr * 1.7 * tilt - 1, 2.2, 2.2);
        }

        const br = sr * (1 + a * 0.4);
        glow(o.x, o.y, br * 3.2, o.c.color, (0.12 + a * 0.34) * vis);
        glow(o.x, o.y, br, o.c.color, (0.5 + a * 0.4) * vis);
        ctx.fillStyle = rgba("#ffffff", (0.4 + a * 0.5) * vis);
        ctx.beginPath(); ctx.arc(o.x, o.y, Math.max(1.5, br * 0.32), 0, 6.2832); ctx.fill();

        if (a > 0.4) {
          const ph = (t * 0.8) % 1;
          ctx.strokeStyle = rgba(o.c.color, (1 - ph) * 0.4 * a); ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.arc(o.x, o.y, br * (1.5 + ph * 2.4), 0, 6.2832); ctx.stroke();
        }

        if (o.depth > 0.32) {
          ctx.globalCompositeOperation = "source-over";
          ctx.font = "600 9px ui-monospace, monospace"; ctx.textAlign = "center";
          ctx.fillStyle = rgba("#ffe6cb", (0.25 + a * 0.6) * o.depth * appear);
          ctx.fillText(o.c.label.toUpperCase(), o.x, o.y + br + 13);
          ctx.globalCompositeOperation = "lighter";
        }
      }

      // ===== core =====
      const breath = 1 + Math.sin(t * 1.6) * 0.018 + Math.sin(t * 0.9) * 0.012;
      const R = baseR * breath * (1 + lv * 0.16) * (0.7 + 0.3 * bootE);
      glow(cx, cy, R * (4.2 + lv * 1.5), col, (0.18 + lv * 0.22) * bootE);
      glow(cx, cy, R * 2.2, col, (0.3 + lv * 0.25) * bootE);
      for (let pp = 0; pp < 5; pp++) {
        const pa = t * (0.3 + pp * 0.04) + pp * 1.257;
        glow(cx + Math.cos(pa) * R * 0.5, cy + Math.sin(pa) * R * 0.5, R * 1.5, col, 0.1 * bootE);
      }
      const body = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      body.addColorStop(0, rgba("#ffffff", 0.95 * bootE));
      body.addColorStop(0.35, rgba(col, 0.85 * bootE));
      body.addColorStop(0.75, rgba(col, 0.4 * bootE));
      body.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.2832); ctx.fill();
      glow(cx - R * 0.28, cy - R * 0.3, R * 0.7, "#ffffff", 0.3 * bootE);

      // crown
      const crownR = R * 1.18;
      for (let i = 0; i < NB; i++) {
        const ang = (i / NB) * Math.PI * 2 + t * 0.05;
        const bell = 0.6 + 0.4 * Math.sin(i * 0.5 + t * 3);
        crown[i] = lerp(crown[i], 0.04 + lv * bell * 0.9, 0.25);
        const len = R * crown[i] * 1.6;
        ctx.strokeStyle = rgba(col, (0.12 + crown[i] * 0.8) * bootE); ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * crownR, cy + Math.sin(ang) * crownR);
        ctx.lineTo(cx + Math.cos(ang) * (crownR + len), cy + Math.sin(ang) * (crownR + len));
        ctx.stroke();
      }

      // ripples + state rings
      rippleClock += dt;
      if (mode === "talking" && lv > 0.12 && rippleClock > 0.42) { ripples.push({ r: R * 1.2, a: 0.5 }); rippleClock = 0; }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i]; rp.r += dt * 120; rp.a -= dt * 0.5;
        if (rp.a <= 0) { ripples.splice(i, 1); continue; }
        ctx.strokeStyle = rgba(col, rp.a * 0.5); ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(cx, cy, rp.r, 0, 6.2832); ctx.stroke();
      }
      if (mode === "listening") {
        const ph = (t * 0.4) % 1;
        ctx.strokeStyle = rgba("#7be0c8", (0.5 - ph * 0.4) * bootE); ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(cx, cy, R * (1.6 - ph * 0.5), 0, 6.2832); ctx.stroke();
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

export default StageAurora;
