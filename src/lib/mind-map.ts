// Canonical capability map for the Intelligence-view "design" stages (Aurora,
// Singularity). Kept separate from hermes-mind-3d.tsx so the new cinematic
// stages share ONE source of truth without touching the proven Atlas graph.
// Mirrors the clusters/tools the nerve-strip + 3D mind already use.

export type CoreMode = "dormant" | "listening" | "thinking" | "talking" | "working";

export type ClusterDef = { key: string; label: string; color: string; tools: string[] };

export const CLUSTERS: ClusterDef[] = [
  { key: "research",  label: "Research",  color: "#60a5fa", tools: ["GitHub", "Reddit", "LinkedIn", "X", "Clay", "Web", "YouTube"] },
  { key: "knowledge", label: "Knowledge", color: "#7be0c8", tools: ["Notion", "Drive", "Obsidian", "Supabase", "Granola"] },
  { key: "memory",    label: "Memory",    color: "#ff9da7", tools: ["Memory Core", "Pinecone"] },
  { key: "thinking",  label: "Thinking",  color: "#b9a6ff", tools: ["Claude", "Gemini", "Codex", "Sub-agents"] },
  { key: "creation",  label: "Creation",  color: "#ff5a7a", tools: ["Writing", "ElevenLabs", "Higgsfield", "NotebookLM"] },
  { key: "comms",     label: "Comms",     color: "#46e0a0", tools: ["Telegram", "Gmail", "Calendar", "Slack"] },
  { key: "action",    label: "Action",    color: "#ff8a3c", tools: ["Code", "Schedule", "n8n", "Zapier", "MCP", "Skills"] },
];

export const TOTAL_CAPS = CLUSTERS.reduce((n, c) => n + c.tools.length, 0);

// State → the colour the core / disk glows. Dormant stays warmly luminous so
// the mind never looks "dead" on stage.
export const STATE_COLOR: Record<CoreMode, string> = {
  dormant:   "#ffd2a3",
  listening: "#7be0c8",
  thinking:  "#ffd21e",
  talking:   "#aef3dd",
  working:   "#ff8a3c",
};

export const STATE_LABEL: Record<CoreMode, string> = {
  dormant: "DORMANT", listening: "LISTENING", thinking: "THINKING", talking: "SPEAKING", working: "WORKING",
};

// ---- tiny colour + math helpers shared by the canvas stages ----
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
// blend two hex colours → "r,g,b" channels (for additive fills)
export function mix(hexA: string, hexB: string, t: number): [number, number, number] {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
// frame-rate-independent exponential smoothing toward target with time-constant tau (s)
export const damp = (cur: number, target: number, tau: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-dt / Math.max(0.0001, tau)));
