// Synthetic voice/state generator for the Intelligence view's DEMO / ATTRACT
// mode — so the mind looks ALIVE on a big screen without a live mic session.
// Produces a believable speech-cadence "level" (0..1) + a cycling state, using
// layered oscillators at physiologically accurate speech frequencies (3/8/12 Hz
// syllable + formant rates) and an idle→listening→thinking→speaking machine.
// Mirrors the same envelope-follower smoothing the real pumpVoice loop uses.

import type { CoreMode } from "@/lib/mind-map";

type Phase = "idle" | "listening" | "thinking" | "speaking";

const CFG: Record<Phase, { base: number; variance: number; bursts: boolean; hold: [number, number] }> = {
  idle:      { base: 0.015, variance: 0.02, bursts: false, hold: [2600, 5200] },
  listening: { base: 0.06,  variance: 0.10, bursts: false, hold: [2400, 4800] },
  thinking:  { base: 0.03,  variance: 0.03, bursts: false, hold: [1600, 3600] },
  speaking:  { base: 0.12,  variance: 0.14, bursts: true,  hold: [3400, 7200] },
};
const NEXT: Record<Phase, Phase[]> = {
  idle:      ["listening", "listening", "idle"],
  listening: ["thinking"],
  thinking:  ["speaking", "speaking", "idle"],
  speaking:  ["idle", "listening"],
};
const TO_MODE: Record<Phase, CoreMode> = { idle: "dormant", listening: "listening", thinking: "thinking", speaking: "talking" };

export class SyntheticVoice {
  private phase: Phase = "idle";
  private held = 0;
  private target = 3400;
  private burst = 0;
  private smoothed = 0;
  // deterministic-ish pseudo-random so we never call Math.random in a hot path more than needed
  private osc = [
    { f: 3.1, a: 0.30, p: 0.0 },   // breath / syllable envelope
    { f: 7.8, a: 0.20, p: 1.2 },   // vocal tremor
    { f: 12.4, a: 0.10, p: 2.7 },  // consonant-rate energy
    { f: 0.4, a: 0.16, p: 0.5 },   // slow breath modulation
  ];

  /** advance by dt seconds → current synthetic level + mapped core mode */
  tick(dt: number): { level: number; mode: CoreMode } {
    this.held += dt * 1000;
    if (this.held > this.target) this.transition();
    const cfg = CFG[this.phase];

    let raw = cfg.base;
    for (const o of this.osc) { o.p += o.f * dt * Math.PI * 2; raw += Math.abs(Math.sin(o.p)) * o.a * cfg.variance; }

    if (cfg.bursts) {
      // syllabic bursts ~3.5–5 Hz → looks like words landing
      this.burst += dt * (3.5 + Math.sin(this.burst * 0.3) * 1.4);
      const syllable = Math.max(0, Math.sin(this.burst * Math.PI * 2 * 0.22));
      raw += syllable * 0.34;
    }
    raw = Math.max(0, Math.min(1, raw));

    // asymmetric envelope follower: fast attack (20ms), slow release (160ms)
    const tau = raw > this.smoothed ? 0.02 : 0.16;
    this.smoothed += (raw - this.smoothed) * (1 - Math.exp(-dt / tau));
    return { level: this.smoothed, mode: TO_MODE[this.phase] };
  }

  private transition() {
    const opts = NEXT[this.phase];
    this.phase = opts[Math.floor(Math.random() * opts.length)];
    const [lo, hi] = CFG[this.phase].hold;
    this.target = lo + Math.random() * (hi - lo);
    this.held = 0;
    this.burst = Math.random() * 10;
  }
}
