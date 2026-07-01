import { useEffect, useRef } from "react";

/**
 * OracleRider — the epic Knight-Rider voice meter, reimagined big.
 * A horizontal field of mirrored bars with a classic KITT scanner sweeping
 * left<->right; the whole field swells with the voice. Alive even at idle
 * (the scanner keeps sweeping). Self-contained: react + <canvas> only.
 */
export function OracleRider({
  level = 0,
  mode = "idle",
  color = "#7be0c8",
}: {
  level?: number;
  mode?: string;
  color?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelRef = useRef(level);
  const modeRef = useRef(mode);
  levelRef.current = level;
  modeRef.current = mode;

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let cssW = 0, cssH = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      cssW = Math.max(1, r.width); cssH = Math.max(1, r.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + "px"; canvas.style.height = cssH + "px";
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(wrap);

    const N = 56;
    const phase = Array.from({ length: N }, (_, i) => i * 0.6 + Math.sin(i) * 0.4);
    let smoothed = level;
    let raf = 0; const start = performance.now();

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const rr = wrap.getBoundingClientRect();
      if (rr.width > 0 && (Math.abs(rr.width - cssW) > 0.5 || Math.abs(rr.height - cssH) > 0.5)) resize();

      const t = (now - start) / 1000;
      const target = Math.max(0, Math.min(1, levelRef.current));
      smoothed += (target - smoothed) * 0.16; // snappy — this mode IS the meter
      const lvl = smoothed;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const cx = cssW / 2, cy = cssH / 2;
      const fieldW = cssW * 0.86;
      const x0 = cx - fieldW / 2;
      const gap = fieldW / N;
      const barW = Math.max(2, gap * 0.46);
      const maxH = cssH * 0.36;

      // NO left-right sweep — the red bar reacts to YOUR voice, swelling from the centre.
      ctx.lineCap = "round";
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < N; i++) {
        const x = x0 + gap * i + gap / 2;
        const c = (i / (N - 1)) * 2 - 1;                         // -1..1
        const bell = Math.pow(Math.max(0, Math.cos(c * 1.15)), 1.2); // taller centre
        const wob = 0.6 + 0.4 * Math.sin(t * 7 + phase[i]);      // gentle shimmer
        const idle = 0.06 + 0.035 * Math.sin(t * 2.2 + phase[i]); // alive at rest, no sweep
        const amp = idle + lvl * 1.3 * bell * wob;               // swells with the voice
        const h = Math.max(cssH * 0.012, Math.min(maxH, amp * maxH));
        const hot = Math.min(1, lvl * bell * 1.15 + idle * 0.4); // hotter with voice + at the centre

        // KITT red → hot amber/white at loud peaks
        const r = 255;
        const g = Math.round(34 + hot * 200);
        const b = Math.round(30 + hot * 150);
        const grad = ctx.createLinearGradient(x, cy - h, x, cy + h);
        grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
        grad.addColorStop(0.5, `rgba(${r},${g},${b},${0.55 + hot * 0.4})`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);

        // glow pass (wide, faint) + core pass (narrow, bright) → bloom without shadowBlur
        ctx.strokeStyle = grad;
        ctx.lineWidth = barW * (2.4 + hot * 1.6);
        ctx.globalAlpha = 0.18 + hot * 0.22;
        ctx.beginPath(); ctx.moveTo(x, cy - h); ctx.lineTo(x, cy + h); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = barW;
        ctx.beginPath(); ctx.moveTo(x, cy - h); ctx.lineTo(x, cy + h); ctx.stroke();
      }

      // centre glow that swells with the voice (replaces the sweeping scanner spot)
      const glowR = maxH * (1.2 + lvl * 1.3);
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
      core.addColorStop(0, `rgba(255,225,200,${0.22 + lvl * 0.5})`);
      core.addColorStop(0.5, `rgba(255,70,60,${0.1 + lvl * 0.2})`);
      core.addColorStop(1, "rgba(255,60,60,0)");
      ctx.fillStyle = core;
      ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);

      // thin centre baseline
      ctx.globalAlpha = 0.5 + lvl * 0.3;
      const base = ctx.createLinearGradient(x0, 0, x0 + fieldW, 0);
      base.addColorStop(0, "rgba(255,60,60,0)");
      base.addColorStop(0.5, `rgba(255,90,80,${0.5})`);
      base.addColorStop(1, "rgba(255,60,60,0)");
      ctx.strokeStyle = base; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x0, cy); ctx.lineTo(x0 + fieldW, cy); ctx.stroke();

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return (
    <div ref={wrapRef} style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden", background: "transparent" }}>
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} />
    </div>
  );
}

export default OracleRider;
