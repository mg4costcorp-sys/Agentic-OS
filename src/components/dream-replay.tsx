/**
 * DreamReplay — full-screen cinematic replay of last night's Dream run.
 *
 * Four acts, all driven by REAL aggregated data (no invented numbers):
 *   1. INGEST      — the live source streams pour particles into a core,
 *                    while real counters (events, sessions, files) tick up.
 *   2. PATTERN HUNT— candidate fragments orbit the core; most burn away,
 *                    the surviving four flare in their category colors.
 *   3. PRESCRIBE   — each prescription materializes center-screen with its
 *                    top evidence line and impact counter.
 *   4. WAKE        — summary frame: date, engine, totals. Camera-ready.
 *
 * Zero dependencies beyond React — canvas 2D + CSS. Space/→ advances,
 * Esc closes, click on the backdrop advances. Honors prefers-reduced-motion
 * by skipping the particle field (text acts still play).
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { X, Moon, Sparkles, ChevronRight } from "lucide-react";

export interface ReplaySource {
  name: string;
  color: string; // hex with #
  live: boolean;
}

export interface ReplayPrescription {
  id?: string;
  cat: string;
  tone: "pink" | "orange" | "blue" | "yellow";
  headline: string;
  evidence: string[];
  dollarImpact: number | null;
  timeImpactMins: number | null;
}

export interface ReplayStats {
  /** Real counters for act 1 — label + final value pairs. */
  counters: Array<{ label: string; value: number }>;
  /** Total candidate findings considered (metadata.totalCandidates). */
  candidates: number;
}

const TONE_HEX: Record<string, string> = {
  pink: "#f472b6",
  orange: "#fb923c",
  blue: "#60a5fa",
  yellow: "#facc15",
};

// Act lengths in ms. Act 2 (index 1) covers the burn-away; act 2+n is one
// per prescription; final act holds until dismissed.
const ACT_INGEST = 9000;
const ACT_HUNT = 6500;
const ACT_PER_RX = 5000;

interface Particle {
  sx: number; // origin 0..1
  sy: number;
  t: number; // progress 0..1
  speed: number;
  color: string;
  size: number;
  curve: number; // perpendicular bow
}

interface Fragment {
  angle: number;
  radius: number;
  speed: number;
  color: string;
  survives: boolean;
  deathAt: number; // 0..1 point in act 2 when it fades (non-survivors)
}

function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}

/** Animated integer counter — counts to `target` over `duration` ms. */
function TickCounter({ target, duration = 2400 }: { target: number; duration?: number }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      setV(Math.round(easeOutCubic(p) * target));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return <span className="tabular-nums">{v.toLocaleString()}</span>;
}

export default function DreamReplay({
  sources,
  prescriptions,
  stats,
  date,
  engineName,
  engineAccent,
  onClose,
}: {
  sources: ReplaySource[];
  prescriptions: ReplayPrescription[];
  stats: ReplayStats;
  date: string | null;
  engineName: string;
  /** Chip accent — pass the frontier fuchsia (#f0abfc) for Fable 5 dreams. */
  engineAccent?: string;
  onClose: () => void;
}) {
  const totalActs = 2 + prescriptions.length + 1;
  const [act, setAct] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const actRef = useRef(0);
  actRef.current = act;

  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const liveSources = useMemo(() => sources.filter((s) => s.live), [sources]);

  const totals = useMemo(() => {
    const dollars = prescriptions.reduce((a, p) => a + (p.dollarImpact ?? 0), 0);
    const mins = prescriptions.reduce((a, p) => a + (p.timeImpactMins ?? 0), 0);
    return { dollars, mins };
  }, [prescriptions]);

  // ── Act auto-advance ────────────────────────────────────────────────────
  useEffect(() => {
    if (act >= totalActs - 1) return; // final act holds
    const len = act === 0 ? ACT_INGEST : act === 1 ? ACT_HUNT : ACT_PER_RX;
    const t = setTimeout(() => setAct((a) => Math.min(a + 1, totalActs - 1)), len);
    return () => clearTimeout(t);
  }, [act, totalActs]);

  const advance = () => setAct((a) => Math.min(a + 1, totalActs - 1));

  // ── Keyboard ────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === " " || e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        advance();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock page scroll while the theater is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // ── Canvas: starfield + particle streams + core + fragments ────────────
  useEffect(() => {
    if (reducedMotion) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const fit = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    window.addEventListener("resize", fit);

    // Static starfield (twinkle via alpha wobble).
    const stars = Array.from({ length: 140 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: Math.random() * 1.3 + 0.3,
      ph: Math.random() * Math.PI * 2,
    }));

    // Source anchor points — spread around an ellipse ring.
    const n = Math.max(1, liveSources.length);
    const anchors = liveSources.map((s, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      return { x: 0.5 + 0.42 * Math.cos(a), y: 0.5 + 0.4 * Math.sin(a), color: s.color };
    });

    const particles: Particle[] = [];
    const spawn = () => {
      if (anchors.length === 0) return;
      const a = anchors[Math.floor(Math.random() * anchors.length)];
      particles.push({
        sx: a.x,
        sy: a.y,
        t: 0,
        speed: 0.004 + Math.random() * 0.007,
        color: a.color,
        size: 0.8 + Math.random() * 1.7,
        curve: (Math.random() - 0.5) * 0.25,
      });
    };

    // Candidate fragments for act 2 — real candidate count, 4 survivors.
    const survivors = prescriptions.map((p) => TONE_HEX[p.tone] ?? "#a78bfa");
    const fragments: Fragment[] = Array.from(
      { length: Math.max(stats.candidates, prescriptions.length) },
      (_, i) => ({
        angle: Math.random() * Math.PI * 2,
        radius: 90 + Math.random() * 110,
        speed: 0.004 + Math.random() * 0.01,
        color: i < prescriptions.length ? survivors[i] : "#8b8fa8",
        survives: i < prescriptions.length,
        deathAt: 0.25 + Math.random() * 0.55,
      }),
    );

    let act2Start = 0;
    let raf = 0;
    const t0 = performance.now();

    const frame = (now: number) => {
      const elapsed = now - t0;
      const a = actRef.current;
      ctx.clearRect(0, 0, w, h);

      // Starfield
      for (const st of stars) {
        const tw = 0.35 + 0.65 * Math.abs(Math.sin(elapsed / 1400 + st.ph));
        ctx.globalAlpha = tw * 0.8;
        ctx.fillStyle = "#cdd3ff";
        ctx.beginPath();
        ctx.arc(st.x * w, st.y * h, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      const cx = w / 2;
      const cy = h / 2;

      // Breathing core — intensifies with each act.
      const breathe = 1 + 0.08 * Math.sin(elapsed / 700);
      const coreR = (a === 0 ? 46 : a === 1 ? 60 : 40) * breathe;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3.4);
      grad.addColorStop(0, "rgba(196,181,253,0.85)");
      grad.addColorStop(0.25, "rgba(139,92,246,0.4)");
      grad.addColorStop(1, "rgba(139,92,246,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 3.4, 0, Math.PI * 2);
      ctx.fill();

      // ACT 1: streams from sources → core
      if (a === 0) {
        for (let k = 0; k < 3; k++) spawn();
        for (const s of anchors) {
          // Anchor glow dot
          ctx.fillStyle = s.color;
          ctx.shadowColor = s.color;
          ctx.shadowBlur = 14;
          ctx.beginPath();
          ctx.arc(s.x * w, s.y * h, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.t += p.speed;
        if (p.t >= 1) {
          particles.splice(i, 1);
          continue;
        }
        const px = p.sx * w + (cx - p.sx * w) * easeOutCubic(p.t);
        const py = p.sy * h + (cy - p.sy * h) * easeOutCubic(p.t);
        // Perpendicular bow for a comet-trail arc
        const dx = cx - p.sx * w;
        const dy = cy - p.sy * h;
        const bow = Math.sin(p.t * Math.PI) * p.curve;
        const bx = px - dy * bow;
        const by = py + dx * bow;
        ctx.globalAlpha = 0.9 * (1 - p.t * 0.5);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(bx, by, p.size * (1 - p.t * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // ACT 2: orbiting fragments, most burn away
      if (a === 1) {
        if (act2Start === 0) act2Start = now;
        const ap = Math.min(1, (now - act2Start) / ACT_HUNT);
        for (const f of fragments) {
          f.angle += f.speed;
          const dying = !f.survives && ap > f.deathAt;
          const fade = dying ? Math.max(0, 1 - (ap - f.deathAt) * 6) : 1;
          if (fade <= 0) continue;
          const pull = f.survives ? 1 - 0.45 * easeOutCubic(ap) : 1;
          const fx = cx + Math.cos(f.angle) * f.radius * pull;
          const fy = cy + Math.sin(f.angle) * f.radius * pull * 0.72;
          ctx.globalAlpha = fade * (f.survives ? 1 : 0.55);
          ctx.fillStyle = f.color;
          ctx.shadowColor = f.color;
          ctx.shadowBlur = f.survives ? 16 : 4;
          ctx.beginPath();
          ctx.arc(fx, fy, f.survives ? 5 + 2 * Math.sin(elapsed / 300) : 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
        ctx.globalAlpha = 1;
      }

      // ACT 3+: four survivor stars parked in corners of the core
      if (a >= 2) {
        prescriptions.forEach((p, i) => {
          const ang = -Math.PI / 2 + (i / prescriptions.length) * Math.PI * 2;
          const fx = cx + Math.cos(ang) * 70;
          const fy = cy + Math.sin(ang) * 52;
          const active = a - 2 === i;
          ctx.globalAlpha = active ? 1 : 0.5;
          ctx.fillStyle = TONE_HEX[p.tone] ?? "#a78bfa";
          ctx.shadowColor = TONE_HEX[p.tone] ?? "#a78bfa";
          ctx.shadowBlur = active ? 22 : 8;
          ctx.beginPath();
          ctx.arc(fx, fy, active ? 7 : 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        });
        ctx.globalAlpha = 1;
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
    };
  }, [liveSources, prescriptions, stats.candidates, reducedMotion]);

  const rxIdx = act - 2; // which prescription act we're on
  const isFinal = act === totalActs - 1;

  return (
    <div
      className="fixed inset-0 z-[90] overflow-hidden"
      style={{
        background:
          "radial-gradient(ellipse 90% 70% at 50% 115%, rgba(139,92,246,0.35) 0%, transparent 60%)," +
          "linear-gradient(180deg, #030210 0%, #070420 55%, #0d0728 100%)",
      }}
      onClick={advance}
      role="dialog"
      aria-label="Dream replay"
    >
      <canvas ref={canvasRef} className="absolute inset-0" aria-hidden />

      {/* Top chrome */}
      <div className="absolute top-0 inset-x-0 flex items-center justify-between px-6 py-4 z-10">
        <div className="inline-flex items-center gap-2 text-violet-200/80">
          <Moon className="h-4 w-4" />
          <span className="text-[11px] uppercase tracking-[0.3em]">
            Dream Replay {date ? `· ${date}` : ""}
          </span>
          <span
            className="text-[10px] px-2 py-0.5 rounded-full border uppercase tracking-wider"
            style={
              engineAccent
                ? {
                    color: engineAccent,
                    borderColor: `${engineAccent}66`,
                    background: `${engineAccent}1a`,
                    boxShadow: `0 0 12px ${engineAccent}44`,
                  }
                : {
                    color: "inherit",
                    borderColor: "rgba(196,181,253,0.3)",
                    background: "rgba(139,92,246,0.15)",
                  }
            }
          >
            {engineName}
          </span>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="h-9 w-9 rounded-lg border border-white/15 bg-white/5 text-violet-100 hover:bg-white/15 transition-colors flex items-center justify-center"
          aria-label="Close replay"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* ACT 1 — ingest */}
      {act === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-between pointer-events-none py-24 px-6">
          <div className="text-center animate-in fade-in duration-1000">
            <div className="text-[11px] uppercase tracking-[0.35em] text-violet-300/70 mb-3">
              Act I · While you slept
            </div>
            <div className="text-3xl md:text-5xl font-semibold tracking-tight text-violet-50">
              {liveSources.length} data streams flowed in
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-10 gap-y-4 text-center">
            {stats.counters.slice(0, 4).map((c) => (
              <div key={c.label}>
                <div className="text-2xl md:text-4xl font-semibold text-violet-50">
                  <TickCounter target={c.value} />
                </div>
                <div className="text-[10px] uppercase tracking-[0.24em] text-violet-300/60 mt-1">
                  {c.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ACT 2 — pattern hunt */}
      {act === 1 && (
        <div className="absolute inset-0 flex flex-col items-center justify-end pb-28 pointer-events-none px-6">
          <div className="text-center animate-in fade-in duration-700">
            <div className="text-[11px] uppercase tracking-[0.35em] text-violet-300/70 mb-3">
              Act II · The pattern hunt
            </div>
            <div className="text-2xl md:text-4xl font-semibold tracking-tight text-violet-50 max-w-[26ch]">
              {stats.candidates} candidate patterns found. {prescriptions.length} survived.
            </div>
          </div>
        </div>
      )}

      {/* ACT 3..n — one prescription at a time */}
      {rxIdx >= 0 && rxIdx < prescriptions.length && (
        <div
          key={rxIdx}
          className="absolute inset-0 flex items-end md:items-center justify-center pointer-events-none px-6 pb-24 md:pb-0"
        >
          <div
            className="w-full max-w-2xl rounded-2xl border p-6 md:p-8 backdrop-blur-md animate-in fade-in slide-in-from-bottom-4 duration-700"
            style={{
              background: "rgba(8,4,26,0.78)",
              borderColor: `${TONE_HEX[prescriptions[rxIdx].tone]}55`,
              boxShadow: `0 24px 80px -24px ${TONE_HEX[prescriptions[rxIdx].tone]}66`,
            }}
          >
            <div className="flex items-center gap-2.5 mb-4">
              <span
                className="text-[10px] tracking-[0.24em] px-2 py-1 rounded border uppercase"
                style={{
                  color: TONE_HEX[prescriptions[rxIdx].tone],
                  borderColor: `${TONE_HEX[prescriptions[rxIdx].tone]}66`,
                  background: `${TONE_HEX[prescriptions[rxIdx].tone]}14`,
                }}
              >
                {prescriptions[rxIdx].cat}
              </span>
              <span className="text-[10px] uppercase tracking-[0.24em] text-violet-300/60">
                Prescription {rxIdx + 1} of {prescriptions.length}
              </span>
            </div>
            <div className="text-xl md:text-3xl font-semibold tracking-tight text-violet-50 leading-snug mb-4">
              {prescriptions[rxIdx].headline}
            </div>
            {prescriptions[rxIdx].evidence[0] && (
              <div className="text-[12px] md:text-[13px] text-violet-200/75 font-mono border-l-2 pl-3 mb-5"
                style={{ borderColor: `${TONE_HEX[prescriptions[rxIdx].tone]}88` }}
              >
                {prescriptions[rxIdx].evidence[0]}
              </div>
            )}
            <div className="flex items-center gap-5">
              {typeof prescriptions[rxIdx].dollarImpact === "number" &&
                prescriptions[rxIdx].dollarImpact! > 0 && (
                  <div>
                    <div className="text-2xl md:text-3xl font-semibold text-emerald-300">
                      $<TickCounter target={prescriptions[rxIdx].dollarImpact!} duration={1600} />
                      <span className="text-sm text-emerald-300/70">/mo</span>
                    </div>
                    <div className="text-[9px] uppercase tracking-[0.24em] text-violet-300/50 mt-0.5">
                      Est. impact
                    </div>
                  </div>
                )}
              {typeof prescriptions[rxIdx].timeImpactMins === "number" &&
                prescriptions[rxIdx].timeImpactMins! > 0 && (
                  <div>
                    <div className="text-2xl md:text-3xl font-semibold text-violet-100">
                      <TickCounter target={prescriptions[rxIdx].timeImpactMins!} duration={1600} />
                      <span className="text-sm text-violet-200/60"> min</span>
                    </div>
                    <div className="text-[9px] uppercase tracking-[0.24em] text-violet-300/50 mt-0.5">
                      Saved / month
                    </div>
                  </div>
                )}
            </div>
          </div>
        </div>
      )}

      {/* FINAL ACT — wake */}
      {isFinal && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-6">
          <div className="text-center animate-in fade-in zoom-in-95 duration-1000">
            <div className="text-[11px] uppercase tracking-[0.35em] text-violet-300/70 mb-4 inline-flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5" /> Good morning
            </div>
            <div className="text-4xl md:text-6xl font-semibold tracking-tight text-violet-50 mb-6">
              {prescriptions.length} prescriptions, ready.
            </div>
            <div className="flex items-center justify-center gap-8 md:gap-12 mb-10">
              {totals.dollars > 0 && (
                <div>
                  <div className="text-3xl md:text-4xl font-semibold text-emerald-300">
                    $<TickCounter target={totals.dollars} duration={1800} />
                    <span className="text-base text-emerald-300/70">/mo</span>
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.24em] text-violet-300/50 mt-1">
                    Combined impact
                  </div>
                </div>
              )}
              {totals.mins > 0 && (
                <div>
                  <div className="text-3xl md:text-4xl font-semibold text-violet-100">
                    <TickCounter target={totals.mins} duration={1800} />
                    <span className="text-base text-violet-200/60"> min</span>
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.24em] text-violet-300/50 mt-1">
                    Time back / month
                  </div>
                </div>
              )}
              <div>
                <div className="text-3xl md:text-4xl font-semibold text-violet-100">
                  {stats.candidates}
                  <span className="text-base text-violet-200/60"> → {prescriptions.length}</span>
                </div>
                <div className="text-[10px] uppercase tracking-[0.24em] text-violet-300/50 mt-1">
                  Patterns distilled
                </div>
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="pointer-events-auto inline-flex items-center gap-2 px-6 py-3 rounded-xl border border-violet-300/40 bg-violet-500/20 text-violet-50 text-[12px] uppercase tracking-[0.24em] hover:bg-violet-500/35 transition-colors backdrop-blur"
              style={{ boxShadow: "0 12px 40px -12px rgba(167,139,250,0.6)" }}
            >
              Enter the day <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Progress dots + hint */}
      <div className="absolute bottom-5 inset-x-0 flex flex-col items-center gap-2 z-10 pointer-events-none">
        <div className="flex items-center gap-1.5">
          {Array.from({ length: totalActs }).map((_, i) => (
            <span
              key={i}
              className="h-1.5 rounded-full transition-all duration-500"
              style={{
                width: i === act ? 18 : 6,
                background: i <= act ? "#c4b5fd" : "rgba(255,255,255,0.18)",
                boxShadow: i === act ? "0 0 8px #c4b5fd" : undefined,
              }}
            />
          ))}
        </div>
        <div className="text-[9px] uppercase tracking-[0.3em] text-violet-300/40">
          Click / space to advance · esc to close
        </div>
      </div>
    </div>
  );
}
