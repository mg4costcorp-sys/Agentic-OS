import { useEffect, useRef } from "react";

/**
 * OraclePlasma — a living plasma / liquid-light core for the Oracle view.
 *
 * A luminous circular membrane containing slow-swirling volumetric plasma:
 * layered flowing value-noise, drifting metaball-like blobs of light and gentle
 * caustics, with a bright breathing nucleus that flares and swells with `level`.
 * Arc-reactor meets a contained nebula, behind a faint glass rim with a soft
 * specular highlight. Everything is clipped to the circle so nothing spills out.
 *
 * Self-contained: imports only from "react", uses <canvas> + requestAnimationFrame.
 * Looks alive at level=0 (idle ambient drift); `level` is eased internally so it
 * never jolts.
 */

type RGB = { r: number; g: number; b: number };

function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || (h.length !== 6 && h.length !== 8)) {
    return { r: 123, g: 224, b: 200 }; // fallback teal #7be0c8
  }
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function rgba({ r, g, b }: RGB, a: number): string {
  return `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${a})`;
}

// Cheap, smooth pseudo-noise: layered sines hashed by index. Deterministic,
// no allocations, good enough to drive organic drift of the plasma blobs.
function fnoise(x: number, y: number, t: number): number {
  const a =
    Math.sin(x * 1.7 + t * 0.9) +
    Math.sin(y * 2.1 - t * 0.7) +
    Math.sin((x + y) * 1.3 + t * 0.5) +
    Math.sin((x - y) * 0.9 - t * 0.35);
  return a / 4; // ~[-1, 1]
}

const ACCENT_CREAM: RGB = { r: 255, g: 230, b: 203 }; // #FFE6CB
const ACCENT_ORANGE: RGB = { r: 255, g: 138, b: 60 }; // #ff8a3c

interface Blob {
  // Each blob orbits + morphs via its own phase offsets.
  baseAngle: number;
  radius: number; // fraction of core radius for orbit distance
  speed: number;
  size: number; // fraction of core radius
  phase: number;
  hueT: number; // 0 = accent, 1 = cream, with a touch of orange
  wobble: number;
}

export function OraclePlasma({
  level = 0,
  mode = "idle",
  color = "#7be0c8",
}: {
  level?: number;
  mode?: string;
  color?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Live props mirrored into refs so the RAF loop always reads fresh values
  // without re-subscribing or restarting the animation.
  const levelRef = useRef(level);
  const modeRef = useRef(mode);
  const colorRef = useRef(color);
  levelRef.current = level;
  modeRef.current = mode;
  colorRef.current = color;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let cssW = 0;
    let cssH = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Offscreen buffer for the soft noise field (rendered small, scaled up for
    // a cheap volumetric look). Reused every frame.
    const fieldCanvas = document.createElement("canvas");
    const fieldCtx = fieldCanvas.getContext("2d", { alpha: true })!;
    const FIELD = 64; // low-res field grid; upscaled with blur
    fieldCanvas.width = FIELD;
    fieldCanvas.height = FIELD;
    const fieldImg = fieldCtx.createImageData(FIELD, FIELD);
    const fieldData = fieldImg.data;

    // Stable set of orbiting blobs (capped for performance).
    const blobs: Blob[] = [];
    const BLOB_COUNT = 8;
    for (let i = 0; i < BLOB_COUNT; i++) {
      blobs.push({
        baseAngle: (i / BLOB_COUNT) * Math.PI * 2 + Math.random() * 0.6,
        radius: 0.18 + Math.random() * 0.5,
        speed: (0.05 + Math.random() * 0.16) * (i % 2 === 0 ? 1 : -1),
        size: 0.22 + Math.random() * 0.34,
        phase: Math.random() * Math.PI * 2,
        hueT: Math.random() * 0.55,
        wobble: 0.4 + Math.random() * 0.9,
      });
    }

    const resize = () => {
      const rect = container.getBoundingClientRect();
      cssW = Math.max(1, rect.width);
      cssH = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
    };
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let smoothed = level; // eased voice energy
    let raf = 0;
    let start = performance.now();

    // Mode → subtle tint target & behaviour multipliers.
    const modeTint = (m: string): { tint: RGB; amt: number; speed: number } => {
      switch (m) {
        case "listening":
          return { tint: ACCENT_CREAM, amt: 0.12, speed: 1.05 };
        case "thinking":
          return { tint: ACCENT_ORANGE, amt: 0.1, speed: 0.8 };
        case "talking":
          return { tint: ACCENT_CREAM, amt: 0.18, speed: 1.25 };
        case "working":
          return { tint: ACCENT_ORANGE, amt: 0.16, speed: 1.15 };
        default:
          return { tint: ACCENT_CREAM, amt: 0.05, speed: 1 };
      }
    };

    // Eased mode tint so switching modes also crossfades rather than snapping.
    let tintMix = 0;
    let speedMix = 1;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const t = (now - start) / 1000;

      // keep the canvas synced to its container every frame — robust against
      // ResizeObserver timing so it never renders a stale/squished size on mount
      const _r = container.getBoundingClientRect();
      if (_r.width > 0 && _r.height > 0 && (Math.abs(_r.width - cssW) > 0.5 || Math.abs(_r.height - cssH) > 0.5)) {
        cssW = _r.width; cssH = _r.height;
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = cssW + "px";
        canvas.style.height = cssH + "px";
      }

      // --- ease inputs ---
      const target = Math.max(0, Math.min(1, levelRef.current));
      smoothed += (target - smoothed) * 0.14;  // snappier — react quickly as Jack talks
      const lvl = smoothed;

      const accent = hexToRgb(colorRef.current);
      const md = modeTint(modeRef.current);
      tintMix += (md.amt - tintMix) * 0.04;
      speedMix += (md.speed - speedMix) * 0.04;
      const tinted = mix(accent, md.tint, tintMix);
      const tScaled = t * speedMix;

      const w = cssW;
      const h = cssH;
      const minSide = Math.min(w, h);
      const cx = w / 2;
      const cy = h / 2;
      // Circle sized to fill with breathing room; gently breathes with level.
      const baseR = minSide * 0.42;
      const R = baseR * (1 + lvl * 0.04 + Math.sin(tScaled * 0.6) * 0.012);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // ============ 1) Outer atmospheric bloom (outside the rim) ============
      const halo = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.7);
      halo.addColorStop(0, rgba(tinted, 0.22 + lvl * 0.16));
      halo.addColorStop(0.5, rgba(tinted, 0.07 + lvl * 0.05));
      halo.addColorStop(1, rgba(tinted, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);

      // ============ 2) Build the low-res flowing noise field ============
      // Two layers of fnoise at different scales + a swirl, mapped to alpha.
      const flow = tScaled * 0.5;
      let p = 0;
      for (let yy = 0; yy < FIELD; yy++) {
        const ny = (yy / FIELD) * 2 - 1;
        for (let xx = 0; xx < FIELD; xx++, p += 4) {
          const nx = (xx / FIELD) * 2 - 1;
          const d = Math.sqrt(nx * nx + ny * ny);
          // swirl coordinates
          const ang = Math.atan2(ny, nx) + d * 1.6 + flow * 0.4;
          const sx = Math.cos(ang) * d;
          const sy = Math.sin(ang) * d;
          let v =
            fnoise(sx * 2.4, sy * 2.4, flow) * 0.6 +
            fnoise(nx * 5.0 + 3.1, ny * 5.0 - 1.7, flow * 1.7) * 0.4;
          v = v * 0.5 + 0.5; // [0,1]
          // radial falloff so the field fades before the rim
          const fall = Math.max(0, 1 - d * d * 1.05);
          let a = Math.pow(v, 2.2) * fall;
          a *= 0.55 + lvl * 0.6;
          const alpha = Math.max(0, Math.min(1, a)) * 255;
          // color the field: blend accent → cream by intensity
          const c = mix(tinted, ACCENT_CREAM, Math.min(1, v * 0.5));
          fieldData[p] = c.r;
          fieldData[p + 1] = c.g;
          fieldData[p + 2] = c.b;
          fieldData[p + 3] = alpha;
        }
      }
      fieldCtx.putImageData(fieldImg, 0, 0);

      // ============ 3) Clip to the circle and paint the plasma ============
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();

      // Deep base wash inside the membrane so the core reads as volumetric.
      const base = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      base.addColorStop(0, rgba(mix(tinted, ACCENT_CREAM, 0.2), 0.5 + lvl * 0.2));
      base.addColorStop(0.45, rgba(tinted, 0.16));
      base.addColorStop(1, "rgba(3, 14, 12, 0.0)");
      ctx.fillStyle = base;
      ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

      // Additive layer for all glowing elements.
      ctx.globalCompositeOperation = "lighter";

      // Upscaled, blurred noise field → soft caustic plasma.
      ctx.save();
      ctx.filter = "blur(" + (minSide * 0.012).toFixed(2) + "px)";
      ctx.globalAlpha = 0.55;
      ctx.imageSmoothingEnabled = true;
      // draw twice, slightly offset/rotated, for layered depth
      for (let layer = 0; layer < 2; layer++) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((layer === 0 ? 1 : -1) * tScaled * 0.05 + layer * 0.7);
        const s = R * (layer === 0 ? 2.05 : 1.7);
        ctx.drawImage(fieldCanvas, -s / 2, -s / 2, s, s);
        ctx.restore();
      }
      ctx.restore();
      ctx.filter = "none";
      ctx.globalAlpha = 1;

      // ============ 4) Drifting metaball-like blobs of light ============
      for (let i = 0; i < blobs.length; i++) {
        const b = blobs[i];
        const orbit =
          b.baseAngle + tScaled * b.speed + Math.sin(tScaled * 0.3 + b.phase) * 0.5;
        const wob =
          1 + Math.sin(tScaled * b.wobble + b.phase) * 0.18 + lvl * 0.12;
        const rr = b.radius * R * wob;
        const bx = cx + Math.cos(orbit) * rr;
        const by = cy + Math.sin(orbit) * rr;
        const bs =
          b.size * R * (0.85 + Math.sin(tScaled * b.wobble * 0.7 + b.phase) * 0.25) *
          (0.9 + lvl * 0.5);

        // hue: mostly accent/cream, faint orange flicker on a couple blobs
        let bc = mix(tinted, ACCENT_CREAM, b.hueT);
        if (i % 4 === 0) {
          bc = mix(bc, ACCENT_ORANGE, 0.12 + lvl * 0.1);
        }
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, bs);
        g.addColorStop(0, rgba(bc, 0.42 + lvl * 0.25));
        g.addColorStop(0.4, rgba(bc, 0.16));
        g.addColorStop(1, rgba(bc, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(bx, by, bs, 0, Math.PI * 2);
        ctx.fill();
      }

      // ============ 5) Breathing nucleus ============
      const pulse =
        0.5 +
        0.5 * Math.sin(tScaled * 1.6) * (0.35 + lvl * 0.65) +
        lvl * 0.5;
      const coreR = R * (0.16 + lvl * 0.22 + pulse * 0.06);

      // soft inner glow
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3.2);
      glow.addColorStop(0, rgba(mix(tinted, ACCENT_CREAM, 0.45), 0.5 + lvl * 0.3));
      glow.addColorStop(0.4, rgba(tinted, 0.22 + lvl * 0.18));
      glow.addColorStop(1, rgba(tinted, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 3.2, 0, Math.PI * 2);
      ctx.fill();

      // hot white-cream center
      const hot = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      hot.addColorStop(0, rgba({ r: 255, g: 250, b: 240 }, 0.9));
      hot.addColorStop(0.35, rgba(mix(ACCENT_CREAM, tinted, 0.35), 0.7 + lvl * 0.2));
      hot.addColorStop(1, rgba(tinted, 0));
      ctx.fillStyle = hot;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      // a few flaring rays from the nucleus on loud moments
      if (lvl > 0.02) {
        const rays = 5;
        for (let i = 0; i < rays; i++) {
          const ra = (i / rays) * Math.PI * 2 + tScaled * 0.25;
          const len = coreR * (2.2 + Math.sin(tScaled * 2 + i) * 0.6) * (0.6 + lvl);
          const ex = cx + Math.cos(ra) * len;
          const ey = cy + Math.sin(ra) * len;
          const rg = ctx.createRadialGradient(cx, cy, coreR * 0.3, ex, ey, len);
          rg.addColorStop(0, rgba(ACCENT_CREAM, 0.0));
          rg.addColorStop(0.2, rgba(ACCENT_CREAM, 0.12 * lvl));
          rg.addColorStop(1, rgba(tinted, 0));
          ctx.strokeStyle = rg;
          ctx.lineWidth = coreR * 0.5;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(ex, ey);
          ctx.stroke();
        }
      }

      ctx.globalCompositeOperation = "source-over";
      ctx.restore(); // remove circle clip

      // ============ 6) Glass rim + specular highlight + vignette ============
      // faint inner vignette to seat the plasma into the membrane
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();
      const vig = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
      vig.addColorStop(0, "rgba(0,0,0,0)");
      vig.addColorStop(1, "rgba(2, 10, 9, 0.55)");
      ctx.fillStyle = vig;
      ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
      ctx.restore();

      // rim stroke
      ctx.lineWidth = Math.max(1, minSide * 0.004);
      const rim = ctx.createLinearGradient(cx, cy - R, cx, cy + R);
      rim.addColorStop(0, rgba(mix(tinted, ACCENT_CREAM, 0.5), 0.55));
      rim.addColorStop(0.5, rgba(tinted, 0.2));
      rim.addColorStop(1, rgba(tinted, 0.45));
      ctx.strokeStyle = rim;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();

      // outer thin bright edge (glass)
      ctx.lineWidth = Math.max(1, minSide * 0.0016);
      ctx.strokeStyle = rgba(ACCENT_CREAM, 0.25);
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.004, 0, Math.PI * 2);
      ctx.stroke();

      // top-left specular highlight arc
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = Math.max(1, minSide * 0.006);
      ctx.lineCap = "round";
      const spec = ctx.createLinearGradient(
        cx - R,
        cy - R,
        cx - R * 0.2,
        cy - R * 0.2,
      );
      spec.addColorStop(0, rgba(ACCENT_CREAM, 0.5));
      spec.addColorStop(1, rgba(ACCENT_CREAM, 0));
      ctx.strokeStyle = spec;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.985, Math.PI * 1.05, Math.PI * 1.5);
      ctx.stroke();
      ctx.restore();
    };

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
        background: "transparent",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          display: "block",
        }}
      />
    </div>
  );
}
