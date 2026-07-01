import { useEffect, useRef } from "react";

/**
 * OracleSonar — a full-bleed 2D circular "Sonar" orb for the Oracle view of Claude OS.
 *
 * A cinematic observatory dial: concentric sonar rings ripple outward from the
 * centre on a cadence that quickens with voice energy, a constellation of fine
 * particles drifts on slow elliptical orbits inside the disc, a faint reticle of
 * tick marks rotates around the rim, and a glowing nucleus breathes at the core.
 * Everything is clipped to the circle and finished with a soft glass rim.
 *
 * Self-contained: imports only from "react", uses <canvas> + requestAnimationFrame,
 * a ResizeObserver for crisp DPR-aware sizing, and additive ('lighter') glow.
 * The canvas stays transparent so it sits on the page's near-black background.
 */

type Mode = "idle" | "listening" | "thinking" | "talking" | "working" | string;

interface OracleSonarProps {
  /** 0..1 live voice energy. Eased internally so motion never jolts. */
  level?: number;
  /** Visual behaviour hint. */
  mode?: Mode;
  /** Accent hex colour. */
  color?: string;
}

/* ----------------------------- colour helpers ----------------------------- */

interface RGB {
  r: number;
  g: number;
  b: number;
}

const CREAM: RGB = { r: 255, g: 230, b: 203 }; // #FFE6CB
const ORANGE: RGB = { r: 255, g: 138, b: 60 }; // #ff8a3c

function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || h.length !== 6) {
    return { r: 123, g: 224, b: 200 }; // fallback teal #7be0c8
  }
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgba(c: RGB, a: number): string {
  return `rgba(${c.r | 0}, ${c.g | 0}, ${c.b | 0}, ${a})`;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

/* --------------------------------- types ---------------------------------- */

interface Ring {
  /** 0..1 progress from core to rim. */
  p: number;
  /** growth per second (in progress units). */
  speed: number;
  /** birth intensity 0..1. */
  power: number;
}

interface Particle {
  /** orbit semi-major axis as a fraction of the disc radius. */
  a: number;
  /** ellipse flattening 0..1 (b = a * (1 - flat)). */
  flat: number;
  /** orbit tilt in radians. */
  tilt: number;
  /** current angle along the orbit. */
  ang: number;
  /** angular velocity, rad/s. */
  vel: number;
  /** base radius in px (scaled by disc). */
  size: number;
  /** twinkle phase. */
  tw: number;
  /** twinkle speed. */
  twSpeed: number;
  /** 0 = accent, 1 = cream tint pick. */
  hueT: number;
}

/* ------------------------------- the component ----------------------------- */

export function OracleSonar({
  level = 0,
  mode = "idle",
  color = "#7be0c8",
}: OracleSonarProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Live prop mirrors so the animation loop always reads the latest value
  // without re-subscribing the RAF on every render.
  const levelRef = useRef(level);
  const modeRef = useRef<Mode>(mode);
  const accentRef = useRef<RGB>(hexToRgb(color));

  useEffect(() => {
    levelRef.current = Math.max(0, Math.min(1, level || 0));
  }, [level]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    accentRef.current = hexToRgb(color);
  }, [color]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    /* --------------------------- sizing / DPR ---------------------------- */
    let cssW = 0;
    let cssH = 0;
    let dpr = 1;

    const applySize = () => {
      const rect = wrap.getBoundingClientRect();
      cssW = Math.max(1, rect.width);
      cssH = Math.max(1, rect.height);
      // Cap DPR so very high-density displays don't tank the framerate.
      dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    };
    applySize();

    const ro = new ResizeObserver(() => applySize());
    ro.observe(wrap);

    /* ----------------------------- ring pool ----------------------------- */
    const rings: Ring[] = [];
    const MAX_RINGS = 14;
    let ringTimer = 0; // seconds until the next emission

    const spawnRing = (power: number) => {
      if (rings.length >= MAX_RINGS) rings.shift();
      rings.push({
        p: 0.06,
        // Faster, more energetic ripples as the voice gets louder.
        speed: 0.16 + power * 0.36,
        power: 0.45 + power * 0.55,
      });
    };

    /* -------------------------- particle field --------------------------- */
    const PARTICLES = 64;
    const particles: Particle[] = [];
    let pseed = 0x1a2b3c;
    const rnd = () => {
      // Tiny deterministic PRNG so the field is stable but varied.
      pseed = (pseed * 1664525 + 1013904223) & 0x7fffffff;
      return pseed / 0x7fffffff;
    };
    for (let i = 0; i < PARTICLES; i++) {
      const a = 0.16 + rnd() * 0.74;
      particles.push({
        a,
        flat: 0.18 + rnd() * 0.5,
        tilt: rnd() * Math.PI,
        ang: rnd() * Math.PI * 2,
        // Inner particles sweep faster than the outer ones (Keplerian feel).
        vel: (0.04 + rnd() * 0.16) * (1.15 - a) * (rnd() > 0.5 ? 1 : -1),
        size: 0.9 + rnd() * 1.8,
        tw: rnd() * Math.PI * 2,
        twSpeed: 0.6 + rnd() * 1.6,
        hueT: rnd() < 0.18 ? 0.55 + rnd() * 0.45 : rnd() * 0.12,
      });
    }

    /* ------------------------------ state -------------------------------- */
    let raf = 0;
    let last = performance.now();
    let smoothed = 0; // eased level
    let rimRot = 0; // tick-ring rotation
    let coreBreath = 0; // ambient core phase

    /* ------------------------------ render ------------------------------- */
    const draw = (now: number) => {
      let dt = (now - last) / 1000;
      last = now;
      // Guard against tab-switch hitches producing huge dt jumps.
      if (dt > 0.05) dt = 0.05;

      // Ease the incoming level — Jack hates spasming.
      const target = levelRef.current;
      smoothed += (target - smoothed) * 0.06;
      // A floor of ambient life so it breathes even at level 0.
      const energy = Math.min(1, Math.max(smoothed, 0));

      const accent = accentRef.current;
      const md = modeRef.current;

      // Mode-driven tint: blend the accent toward cream/orange a touch.
      let tint = accent;
      if (md === "thinking") tint = mix(accent, CREAM, 0.22);
      else if (md === "working") tint = mix(accent, ORANGE, 0.16);
      else if (md === "talking") tint = mix(accent, CREAM, 0.12);

      const w = canvas.width;
      const h = canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cx = cssW / 2;
      const cy = cssH / 2;
      // Disc radius with breathing room inside the parent.
      const R = Math.min(cssW, cssH) * 0.5 - Math.min(cssW, cssH) * 0.06;
      if (R <= 2) {
        raf = requestAnimationFrame(draw);
        return;
      }

      coreBreath += dt * (0.9 + energy * 1.6);
      rimRot += dt * (0.05 + energy * 0.22);

      // ---- Ring emission cadence (quickens with energy) ----
      ringTimer -= dt;
      const interval = 2.6 - energy * 2.05; // ~2.6s idle -> ~0.55s loud
      if (ringTimer <= 0) {
        spawnRing(energy);
        ringTimer = interval * (0.8 + Math.random() * 0.4);
      }

      /* ---------- 1. soft inner atmosphere (sits behind everything) ---------- */
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();

      const atmo = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      atmo.addColorStop(0, rgba(tint, 0.16 + energy * 0.14));
      atmo.addColorStop(0.45, rgba(tint, 0.05 + energy * 0.05));
      atmo.addColorStop(1, rgba(tint, 0));
      ctx.fillStyle = atmo;
      ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

      // Everything inside the disc glows additively.
      ctx.globalCompositeOperation = "lighter";

      /* --------------------------- 2. sonar rings --------------------------- */
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i];
        ring.p += ring.speed * dt;
        if (ring.p >= 1.04) {
          rings.splice(i, 1);
          continue;
        }
        const rr = ring.p * R;
        // Fade out toward the rim; brightest just after birth.
        const fade = Math.pow(1 - ring.p, 1.7) * ring.power;
        if (fade <= 0.003) continue;

        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(tint, 0.5 * fade);
        ctx.lineWidth = 1.4 + energy * 1.1;
        ctx.shadowColor = rgba(tint, 0.6 * fade);
        ctx.shadowBlur = (10 + energy * 16) * dpr;
        ctx.stroke();

        // A brighter leading edge wisp.
        ctx.beginPath();
        ctx.arc(cx, cy, rr, -0.9, 0.9);
        ctx.strokeStyle = rgba(mix(tint, CREAM, 0.5), 0.45 * fade);
        ctx.lineWidth = 0.8 + energy * 0.6;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;

      /* ------------------------- 3. faint sweep arm ------------------------- */
      // A slow radar sweep that brightens a wedge as it passes.
      const sweepAng = -rimRot * 2.0;
      const sweepGrad = ctx.createLinearGradient(
        cx,
        cy,
        cx + Math.cos(sweepAng) * R,
        cy + Math.sin(sweepAng) * R,
      );
      sweepGrad.addColorStop(0, rgba(tint, 0.0));
      sweepGrad.addColorStop(0.7, rgba(tint, 0.04 + energy * 0.05));
      sweepGrad.addColorStop(1, rgba(mix(tint, CREAM, 0.4), 0.1 + energy * 0.12));
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, sweepAng - 0.42, sweepAng + 0.02);
      ctx.closePath();
      ctx.fillStyle = sweepGrad;
      ctx.fill();
      ctx.restore();

      /* -------------------------- 4. orbiting motes ------------------------- */
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.ang += p.vel * dt;
        p.tw += p.twSpeed * dt;

        const ax = p.a * R;
        const bx = p.a * R * (1 - p.flat);
        const lx = Math.cos(p.ang) * ax;
        const ly = Math.sin(p.ang) * bx;
        const cosT = Math.cos(p.tilt);
        const sinT = Math.sin(p.tilt);
        const px = cx + lx * cosT - ly * sinT;
        const py = cy + lx * sinT + ly * cosT;

        const twinkle = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(p.tw));
        const sz = (p.size + energy * 1.3) * dpr * 0.6;
        const col = mix(tint, CREAM, p.hueT);
        const alpha = (0.3 + energy * 0.45) * twinkle;

        const g = ctx.createRadialGradient(px, py, 0, px, py, sz * 3.2);
        g.addColorStop(0, rgba(col, alpha));
        g.addColorStop(0.4, rgba(col, alpha * 0.45));
        g.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, sz * 3.2, 0, Math.PI * 2);
        ctx.fill();

        // crisp centre
        ctx.fillStyle = rgba(mix(col, CREAM, 0.4), Math.min(1, alpha * 1.4));
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.4, sz * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }

      /* ----------------------------- 5. nucleus ----------------------------- */
      const pulse = 0.5 + 0.5 * Math.sin(coreBreath);
      const coreR = R * (0.1 + 0.03 * pulse + energy * 0.07);

      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 4.2);
      halo.addColorStop(0, rgba(mix(tint, CREAM, 0.3), 0.7 + energy * 0.3));
      halo.addColorStop(0.18, rgba(tint, 0.42 + energy * 0.3));
      halo.addColorStop(0.55, rgba(tint, 0.1 + energy * 0.12));
      halo.addColorStop(1, rgba(tint, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 4.2, 0, Math.PI * 2);
      ctx.fill();

      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      core.addColorStop(0, rgba(CREAM, 0.95));
      core.addColorStop(0.5, rgba(mix(tint, CREAM, 0.5), 0.85));
      core.addColorStop(1, rgba(tint, 0.12));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore(); // end disc clip + lighter composite

      /* -------------------- 6. rim reticle / tick marks --------------------- */
      // Drawn outside the clip so the ticks live exactly on the rim.
      ctx.save();
      ctx.translate(cx, cy);

      // Major + minor ticks rotating slowly around the rim.
      const majorTicks = 48;
      ctx.lineCap = "round";
      for (let i = 0; i < majorTicks; i++) {
        const ang = rimRot + (i / majorTicks) * Math.PI * 2;
        const isMajor = i % 4 === 0;
        const len = isMajor ? R * 0.05 : R * 0.025;
        const r0 = R * 0.985;
        const r1 = r0 - len;
        const a = isMajor ? 0.32 + energy * 0.25 : 0.16 + energy * 0.12;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0);
        ctx.lineTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
        ctx.strokeStyle = rgba(tint, a);
        ctx.lineWidth = isMajor ? 1.4 : 0.8;
        ctx.stroke();
      }

      // A counter-rotating sparse marker ring for instrument depth.
      const markers = 3;
      for (let i = 0; i < markers; i++) {
        const ang = -rimRot * 1.6 + (i / markers) * Math.PI * 2;
        const mr = R * 0.93;
        const mx = Math.cos(ang) * mr;
        const my = Math.sin(ang) * mr;
        ctx.beginPath();
        ctx.arc(mx, my, 1.8 + energy * 1.2, 0, Math.PI * 2);
        ctx.fillStyle = rgba(mix(tint, ORANGE, 0.25), 0.5 + energy * 0.3);
        ctx.fill();
      }
      ctx.restore();

      /* ----------------------------- 7. glass rim --------------------------- */
      // Inner soft edge falloff.
      ctx.save();
      const edge = ctx.createRadialGradient(cx, cy, R * 0.82, cx, cy, R);
      edge.addColorStop(0, rgba(tint, 0));
      edge.addColorStop(0.86, rgba(tint, 0.04));
      edge.addColorStop(1, rgba(tint, 0.14 + energy * 0.1));
      ctx.fillStyle = edge;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Crisp rim stroke + outer bloom.
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(mix(tint, CREAM, 0.25), 0.5 + energy * 0.3);
      ctx.lineWidth = 1.2;
      ctx.shadowColor = rgba(tint, 0.6);
      ctx.shadowBlur = (12 + energy * 18) * dpr;
      ctx.stroke();

      // A bright top-left specular highlight on the glass.
      ctx.beginPath();
      ctx.arc(cx, cy, R, Math.PI * 1.05, Math.PI * 1.5);
      ctx.strokeStyle = rgba(CREAM, 0.22 + energy * 0.12);
      ctx.lineWidth = 1.6;
      ctx.shadowBlur = 0;
      ctx.stroke();
      ctx.restore();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame((t) => {
      last = t;
      draw(t);
    });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      ref={wrapRef}
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
          display: "block",
        }}
      />
    </div>
  );
}

export default OracleSonar;
