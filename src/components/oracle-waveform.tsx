import { useEffect, useRef } from "react";

/**
 * OracleWaveform — a full-bleed 2D circular voice visualizer for the Oracle view.
 *
 * A continuous, closed audio waveform wrapped around the centre of a softly glowing
 * glass disc. The radius at each angular sample is the sum of a few animated sine
 * harmonics scaled by the (internally eased) voice `level`, layered 2–3x in slightly
 * offset hues for depth, with a breathing radial core and a faint drifting particle haze.
 *
 * Pure React + canvas. No external libraries, no project imports.
 */

type RGB = { r: number; g: number; b: number };

function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace("#", "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const n = parseInt(h.length >= 6 ? h.slice(0, 6) : "7be0c8", 16);
  if (Number.isNaN(n)) return { r: 123, g: 224, b: 200 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgba({ r, g, b }: RGB, a: number): string {
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

const CREAM: RGB = { r: 255, g: 230, b: 203 }; // #FFE6CB
const ORANGE: RGB = { r: 255, g: 138, b: 60 }; // #ff8a3c

type Particle = {
  ang: number; // angle around the disc
  rad: number; // 0..1 radius fraction
  size: number;
  drift: number; // angular drift speed
  vr: number; // radial velocity
  twPhase: number; // twinkle phase
  twSpeed: number;
};

export function OracleWaveform({
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

  // Live props mirrored into refs so the rAF loop always reads the latest
  // without re-subscribing / restarting the animation.
  const levelRef = useRef(level);
  const modeRef = useRef(mode);
  const accentRef = useRef<RGB>(hexToRgb(color));

  useEffect(() => {
    levelRef.current = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
  }, [level]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    accentRef.current = hexToRgb(color);
  }, [color]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let raf = 0;
    let running = true;

    // CSS-pixel size of the parent, tracked by ResizeObserver.
    let cssW = wrap.clientWidth || 1;
    let cssH = wrap.clientHeight || 1;

    const setSize = () => {
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2.5));
      cssW = Math.max(1, wrap.clientWidth);
      cssH = Math.max(1, wrap.clientHeight);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    setSize();

    const ro = new ResizeObserver(() => setSize());
    ro.observe(wrap);

    // Eased state — nothing jolts.
    let smoothed = levelRef.current; // smoothed voice energy
    let modePulse = 0; // smoothed mode-driven intensity

    // Particles live in disc-relative polar space, scale-independent.
    const PARTICLE_COUNT = 64;
    const particles: Particle[] = Array.from({ length: PARTICLE_COUNT }, () => ({
      ang: Math.random() * Math.PI * 2,
      rad: 0.12 + Math.random() * 0.78,
      size: 0.6 + Math.random() * 1.8,
      drift: (Math.random() - 0.5) * 0.18,
      vr: (Math.random() - 0.5) * 0.012,
      twPhase: Math.random() * Math.PI * 2,
      twSpeed: 0.6 + Math.random() * 1.6,
    }));

    // Harmonic ring: radius = base + sum of sines; each layer gets a hue + phase offset.
    // [freq (lobes), speed, weight]
    const HARMONICS: Array<[number, number, number]> = [
      [2, 0.55, 1.0],
      [3, -0.42, 0.62],
      [5, 0.33, 0.42],
      [7, -0.27, 0.26],
      [11, 0.2, 0.15],
    ];

    const SAMPLES = 168; // angular resolution of the waveform path

    // mode → intensity (calm idle, lively talking/working) and tint blend.
    const modeIntensity = (m: string): number => {
      switch (m) {
        case "talking":
          return 1.0;
        case "listening":
          return 0.62;
        case "thinking":
          return 0.5;
        case "working":
          return 0.78;
        default:
          return 0.34; // idle
      }
    };

    let start = performance.now();
    let last = start;

    const draw = (now: number) => {
      if (!running) return;
      const dt = Math.min(0.05, (now - last) / 1000); // clamp big gaps (tab switches)
      last = now;
      const t = (now - start) / 1000;

      // --- ease inputs ---------------------------------------------------
      const target = Math.max(0, Math.min(1, levelRef.current));
      smoothed += (target - smoothed) * 0.14; // snappier — react quickly as Jack talks
      const targetPulse = modeIntensity(modeRef.current);
      modePulse += (targetPulse - modePulse) * 0.04;

      const accent = accentRef.current;
      // Layer hues: accent, accent→cream, accent→orange (subtle).
      const hueCream = mix(accent, CREAM, 0.55);
      const hueWarm = mix(accent, ORANGE, 0.4);

      const W = cssW;
      const H = cssH;
      const cx = W / 2;
      const cy = H / 2;

      // Disc sizing with breathing room.
      const minDim = Math.min(W, H);
      const discR = minDim * 0.42;
      // Base ring radius sits a little inside the glass disc.
      const baseR = discR * 0.6;

      // Idle breathing + voice-driven swell.
      const breath = 0.5 + 0.5 * Math.sin(t * 0.9);
      const energy = smoothed * (0.55 + 0.45 * modePulse); // 0..~1
      const ampPx =
        discR *
        (0.045 + // idle ripple floor
          0.03 * breath * (0.4 + modePulse) +
          0.34 * energy); // voice swell

      ctx.clearRect(0, 0, W, H);
      ctx.save();
      // Clip everything to the disc.
      ctx.beginPath();
      ctx.arc(cx, cy, discR, 0, Math.PI * 2);
      ctx.clip();

      // --- glass disc backing -------------------------------------------
      const glass = ctx.createRadialGradient(cx, cy, 0, cx, cy, discR);
      glass.addColorStop(0, rgba(mix(accent, CREAM, 0.2), 0.1));
      glass.addColorStop(0.55, rgba(accent, 0.05));
      glass.addColorStop(1, rgba(accent, 0.012));
      ctx.fillStyle = glass;
      ctx.fillRect(cx - discR, cy - discR, discR * 2, discR * 2);

      // --- particle haze (drifting) -------------------------------------
      ctx.globalCompositeOperation = "lighter";
      for (const p of particles) {
        p.ang += p.drift * dt;
        p.rad += p.vr * dt;
        if (p.rad < 0.08) {
          p.rad = 0.08;
          p.vr = Math.abs(p.vr);
        }
        if (p.rad > 0.95) {
          p.rad = 0.95;
          p.vr = -Math.abs(p.vr);
        }
        const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * p.twSpeed + p.twPhase));
        const pr = p.rad * discR;
        const px = cx + Math.cos(p.ang) * pr;
        const py = cy + Math.sin(p.ang) * pr;
        const sz = p.size * (1 + energy * 0.8);
        const a = (0.05 + 0.16 * tw) * (0.5 + 0.5 * modePulse);
        const pg = ctx.createRadialGradient(px, py, 0, px, py, sz * 3);
        const pcol = mix(accent, CREAM, p.twPhase % 1 > 0.6 ? 0.6 : 0.15);
        pg.addColorStop(0, rgba(pcol, a));
        pg.addColorStop(1, rgba(pcol, 0));
        ctx.fillStyle = pg;
        ctx.beginPath();
        ctx.arc(px, py, sz * 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // --- waveform ring layers -----------------------------------------
      // Each layer: a slightly different phase, hue, radius and amplitude so
      // they overlap with depth. Additive ('lighter') glow already set.
      type Layer = {
        col: RGB;
        rMul: number; // base-radius multiplier
        aMul: number; // amplitude multiplier
        phase: number; // time phase offset
        rot: number; // angular rotation offset
        lineGlow: number; // shadowBlur
        lineA: number; // stroke alpha
        fillA: number; // soft fill alpha
        width: number;
        wobble: number; // per-point noise scale
      };

      const layers: Layer[] = [
        {
          col: accent,
          rMul: 1.0,
          aMul: 1.0,
          phase: 0,
          rot: 0,
          lineGlow: 26,
          lineA: 0.95,
          fillA: 0.07,
          width: 2.4,
          wobble: 1.0,
        },
        {
          col: hueCream,
          rMul: 0.86,
          aMul: 0.78,
          phase: 1.7,
          rot: 0.5,
          lineGlow: 18,
          lineA: 0.6,
          fillA: 0.04,
          width: 1.6,
          wobble: 0.7,
        },
        {
          col: hueWarm,
          rMul: 1.12,
          aMul: 0.62,
          phase: 3.4,
          rot: -0.4,
          lineGlow: 22,
          lineA: 0.4 + 0.25 * modePulse, // warm accent grows when active
          fillA: 0.03,
          width: 1.3,
          wobble: 0.85,
        },
      ];

      // Smooth per-point pseudo-noise (sum of two slow sines per index).
      const noiseAt = (i: number, seed: number) =>
        Math.sin(i * 0.7 + t * 1.3 + seed) * 0.6 +
        Math.sin(i * 1.9 - t * 0.8 + seed * 2.1) * 0.4;

      for (const layer of layers) {
        const pts: Array<[number, number]> = [];
        for (let i = 0; i <= SAMPLES; i++) {
          const a = (i / SAMPLES) * Math.PI * 2 + layer.rot;
          let harm = 0;
          for (const [freq, speed, weight] of HARMONICS) {
            harm += Math.sin(a * freq + t * speed + layer.phase) * weight;
          }
          // Normalize harmonic sum roughly into -1..1 range.
          harm /= 2.4;
          const wob = noiseAt(i, layer.phase) * 0.18 * layer.wobble * (0.4 + energy);
          const r =
            baseR * layer.rMul +
            (ampPx * layer.aMul) * harm +
            ampPx * 0.5 * wob;
          pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
        }

        // Build a smooth closed path through the points (Catmull-Rom-ish via midpoints).
        ctx.beginPath();
        ctx.moveTo((pts[0][0] + pts[pts.length - 2][0]) / 2, (pts[0][1] + pts[pts.length - 2][1]) / 2);
        for (let i = 0; i < pts.length - 1; i++) {
          const cur = pts[i];
          const nxt = pts[i + 1];
          const mx = (cur[0] + nxt[0]) / 2;
          const my = (cur[1] + nxt[1]) / 2;
          ctx.quadraticCurveTo(cur[0], cur[1], mx, my);
        }
        ctx.closePath();

        // Soft fill.
        if (layer.fillA > 0) {
          ctx.fillStyle = rgba(layer.col, layer.fillA + energy * 0.05);
          ctx.fill();
        }

        // Glowing stroke.
        ctx.shadowColor = rgba(layer.col, 0.9);
        ctx.shadowBlur = layer.lineGlow * (0.6 + 0.6 * (0.5 + energy));
        ctx.strokeStyle = rgba(layer.col, layer.lineA);
        ctx.lineWidth = layer.width;
        ctx.lineJoin = "round";
        ctx.stroke();
      }
      ctx.shadowBlur = 0;

      // --- breathing core -----------------------------------------------
      const coreBreath = 0.5 + 0.5 * Math.sin(t * 1.4 + 0.6);
      const coreR = baseR * (0.34 + 0.05 * coreBreath + 0.22 * energy);
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      const coreHue = mix(accent, CREAM, 0.35);
      core.addColorStop(0, rgba(CREAM, 0.55 + 0.35 * energy));
      core.addColorStop(0.25, rgba(coreHue, 0.4 + 0.3 * energy));
      core.addColorStop(0.7, rgba(accent, 0.16 + 0.18 * energy));
      core.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      // Tiny hot center.
      const hotR = coreR * 0.32;
      const hot = ctx.createRadialGradient(cx, cy, 0, cx, cy, hotR);
      hot.addColorStop(0, rgba(CREAM, 0.85));
      hot.addColorStop(1, rgba(CREAM, 0));
      ctx.fillStyle = hot;
      ctx.beginPath();
      ctx.arc(cx, cy, hotR, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore(); // end clip

      // --- rim glow (drawn outside the clip so it can bloom past the edge) ---
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const rimW = discR * (0.16 + 0.06 * energy);
      const rim = ctx.createRadialGradient(
        cx,
        cy,
        Math.max(0, discR - rimW),
        cx,
        cy,
        discR + rimW * 0.6,
      );
      rim.addColorStop(0, rgba(accent, 0));
      rim.addColorStop(0.6, rgba(accent, 0.12 + 0.12 * energy));
      rim.addColorStop(0.82, rgba(mix(accent, CREAM, 0.3), 0.22 + 0.18 * energy));
      rim.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = rim;
      ctx.beginPath();
      ctx.arc(cx, cy, discR + rimW * 0.6, 0, Math.PI * 2);
      ctx.fill();

      // Crisp thin rim line.
      ctx.strokeStyle = rgba(mix(accent, CREAM, 0.2), 0.32 + 0.2 * energy);
      ctx.lineWidth = 1.25;
      ctx.shadowColor = rgba(accent, 0.8);
      ctx.shadowBlur = 14 * (0.5 + energy);
      ctx.beginPath();
      ctx.arc(cx, cy, discR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []); // mount once; live values flow through refs

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: "transparent",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          display: "block",
          width: "100%",
          height: "100%",
        }}
      />
    </div>
  );
}

export default OracleWaveform;
