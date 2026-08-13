/**
 * ctx-window — the OS's single source of truth for "how big is this model's
 * context window, and roughly how much of it are we using".
 *
 * Lifted out of agents.hermes.tsx so the Hermes page and the home command bar
 * share ONE table instead of drifting apart. Nothing here is exact: token
 * counts are estimates and every surface that shows them must say so.
 */

// Per-model context windows, verified against the live OpenRouter catalog
// (2026-06). Order matters — first match wins, so put specific ids before
// family fallbacks (e.g. glm-5.2 = 1M but glm-5.1/4.x = ~203K).
export const CTX_TABLE: Array<[RegExp, number]> = [
  [/glm-5\.2/, 1_048_576],
  [/glm-(5\.1|5v|5-turbo|5\b|4\.7|4\.6|4\.5)/, 202_752],
  [/haiku/, 200_000],
  // Legacy Anthropic ids are genuinely 200K — they must be matched BEFORE the
  // frontier rule below, which would otherwise promise them a 1M window.
  [/claude-[23]\b|claude-instant|(sonnet|opus)-3/, 200_000],
  [/fable|opus|sonnet|claude/, 1_000_000],
  [/gpt-5\.5|gpt-chat/, 1_050_000],
  [/gpt-5|gpt-4\.1|o[34]\b/, 400_000],
  [/gemini/, 1_048_576],
  [/grok-4\.20/, 2_000_000],
  [/grok-4/, 1_000_000],
  [/deepseek-v4/, 1_048_576],
  [/deepseek/, 131_072],
  [/minimax-m3/, 1_048_576],
  [/minimax/, 204_800],
  [/qwen3\.7|qwen3\.5|qwen3-max/, 1_000_000],
  [/kimi-k3/, 1_048_576], // K3 = 1M (verified OpenRouter 2026-07-18); K2 line stays 262K
  [/kimi|moonshot/, 262_144],
  [/llama-4/, 1_048_576],
  [/llama-3|llama3/, 131_072],
  [/nemotron/, 1_000_000],
  [/mistral|command|devstral/, 262_144],
  [/fugu|sakana/, 1_000_000],
];

/** First CTX_TABLE rule that matches this model id, or null if none does. */
export function ctxFromTable(name: string): number | null {
  const n = (name ?? "").toLowerCase();
  if (!n) return null;
  for (const [re, ctx] of CTX_TABLE) if (re.test(n)) return ctx;
  return null;
}

/**
 * ESTIMATE ONLY. Tokenizers are model-specific and none of them are available
 * in the browser, so every token figure in the OS is chars ÷ this constant.
 * 0.25 tok/char (≈4 chars per token) is the long-standing rule of thumb for
 * English prose across the GPT/Claude BPE families; code and JSON tokenize
 * hotter (closer to 3.5 chars/token), which `estTokens` accounts for when the
 * text looks code-dense. Treat everything derived from this as ±20%, and never
 * present it to the user without saying it is an estimate.
 */
export const TOKENS_PER_CHAR = 0.25;
/** Code/JSON packs more tokens per character than prose. Same caveat applies. */
export const TOKENS_PER_CHAR_CODE = 1 / 3.5;

/** chars → estimated tokens. `codeish` switches to the denser ratio. */
export function estTokens(chars: number, codeish = false): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars * (codeish ? TOKENS_PER_CHAR_CODE : TOKENS_PER_CHAR));
}

/** Same estimate, straight from a string (auto-detects code-ish text). */
export function estTextTokens(text: string): number {
  if (!text) return 0;
  return estTokens(text.length, /[{}();=<>[\]]|```/.test(text));
}

// ── The context-manifest the dev server streams on `system/init` ───────────
// Everything in `measured` is a REAL character count read off disk; everything
// else is a real name/id list reported by the Claude CLI itself. Token numbers
// are derived client-side and are always estimates.
export interface CtxManifestFile {
  /** Display label — a ~-relative path or a skill/agent id. */
  label: string;
  /** Real character count of what the harness loads for this entry. */
  chars: number;
}
export interface CtxManifest {
  /** Every tool name the CLI reported, `mcp__…` ones included. */
  tools: string[];
  /** MCP servers the CLI connected (or tried to). */
  mcpServers: Array<{ name: string; status: string }>;
  /** Slash commands resident in this session. */
  slashCommands: string[];
  /** Subagent ids the CLI exposed. */
  agents: string[];
  /** Skill ids the CLI exposed. */
  skills: string[];
  /** CLAUDE.md / memory files actually loaded, with real char counts. */
  memoryFiles: CtxManifestFile[];
  /** Real chars of the skill listing (name + description per skill). */
  skillChars: number;
  /** Real chars of the subagent listing (name + description per agent). */
  agentChars: number;
  /** Working directory the harness started in. */
  cwd?: string;
}

/**
 * Harness-reported token usage — the one number here that is NOT an estimate.
 *
 * These fields describe ONE API call: the last one the turn made. The CLI's
 * `result` line reports a turn TOTAL instead, which re-counts the whole cached
 * prompt on every round-trip and therefore over-reads occupancy by the number
 * of tool calls (measured at 179× on a 258-message turn). The dev server
 * deliberately forwards the per-call figure — see `lastAsstPrompt` in
 * vite.config.ts — so "used" means "in the window", not "billed this turn".
 */
export interface CtxUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /**
   * false when the harness closed the turn without any usage at all — the
   * ccr → OpenRouter lane does this whenever the final provider call errors,
   * zeroing every field. An all-zero payload must never be shown as a
   * measurement, so this flag demotes it back to "we don't know".
   */
  reported?: boolean;
  /** Which lane answered: "anthropic" | "openrouter" | "codex". */
  lane?: string;
}
/** Everything the model actually read on the last turn. */
export function usagePromptTokens(u: CtxUsage): number {
  return (u.inputTokens || 0) + (u.cacheCreationTokens || 0) + (u.cacheReadTokens || 0);
}
/** True only when the harness gave us a real, non-zero prompt count. */
export function usageIsMeasured(u: CtxUsage | null): u is CtxUsage {
  return !!u && u.reported !== false && usagePromptTokens(u) > 0;
}

/** The MCP server a tool belongs to: `mcp__<server>__<tool>`. */
export function mcpServerOf(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice(5);
  const cut = rest.indexOf("__");
  return cut > 0 ? rest.slice(0, cut) : rest;
}

const CTX_NUM_FMT = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
/** 158432 → "158.4K". Compact, tabular-friendly. */
export function fmtCtxTokens(n: number): string {
  return CTX_NUM_FMT.format(Math.max(0, Math.round(n)));
}

export interface CtxSlice {
  key: string;
  label: string;
  tokens: number;
  color: string;
  /** true when the figure comes from a real measurement, not a char estimate */
  measured: boolean;
}

export interface CtxBreakdown {
  slices: CtxSlice[];
  free: number;
  used: number;
  limit: number;
  /** the harness's own prompt-token count for the last turn, when known */
  reported: number | null;
  /**
   * Set when the last turn closed WITHOUT a usable token count, to the lane
   * that stayed silent ("openrouter", "codex", …). Lets the UI say which
   * lane didn't report rather than implying the number is simply missing.
   */
  unreportedLane: string | null;
  systemTools: string[];
  mcpByServer: Array<{ server: string; tools: string[] }>;
  memoryFiles: Array<{ label: string; chars: number }>;
  slashCommands: string[];
}

// Segment colours — five distinct values from the OS palette, ordered so the
// bar reads warm→cool as it moves from "your conversation" to "the harness".
export const C_MESSAGES = "#FFD21E";
export const C_HARNESS = "#F5A623";
export const C_MEMORY = "#7BE0C8";
export const C_SKILLS = "#A78BFA";
export const C_AGENTS = "#D97757";

/**
 * Assemble the breakdown. `messageTokens` is the caller's estimate of the
 * transcript; everything else comes from the manifest and the harness usage.
 */
export function buildCtxBreakdown(args: {
  manifest: CtxManifest | null;
  usage: CtxUsage | null;
  messageTokens: number;
  limit: number;
}): CtxBreakdown {
  const { manifest, usage, messageTokens, limit } = args;
  const memoryFiles = manifest?.memoryFiles ?? [];
  const memoryTokens = estTokens(memoryFiles.reduce((a, f) => a + f.chars, 0));
  const skillTokens = estTokens(manifest?.skillChars ?? 0);
  const agentTokens = estTokens(manifest?.agentChars ?? 0);

  const tools = manifest?.tools ?? [];
  const systemTools = tools.filter((t) => !t.startsWith("mcp__"));
  const byServer = new Map<string, string[]>();
  for (const t of tools) {
    const s = mcpServerOf(t);
    if (!s) continue;
    if (!byServer.has(s)) byServer.set(s, []);
    byServer.get(s)!.push(t);
  }
  const mcpByServer = [...byServer.entries()]
    .map(([server, list]) => ({ server, tools: list.sort() }))
    .sort((a, b) => b.tools.length - a.tools.length);

  // Only a REAL count counts. A usage payload of all zeros means the lane
  // told us nothing (see CtxUsage.reported) — falling back to the estimate,
  // clearly marked "≈", is honest; printing "0 tok · 0%" is not.
  const reported = usageIsMeasured(usage) ? usagePromptTokens(usage) : null;
  // The part of the harness's REAL prompt count we did not measure ourselves:
  // the system prompt, every tool schema, and the CLI's own scaffolding.
  const harness =
    reported === null
      ? null
      : Math.max(0, reported - messageTokens - memoryTokens - skillTokens - agentTokens);

  const slices: CtxSlice[] = [
    {
      key: "messages",
      label: "Messages",
      tokens: messageTokens,
      color: C_MESSAGES,
      measured: false,
    },
  ];
  if (harness !== null)
    slices.push({
      key: "harness",
      label: "System prompt + tools",
      tokens: harness,
      color: C_HARNESS,
      measured: true,
    });
  if (memoryTokens > 0)
    slices.push({
      key: "memory",
      label: "Memory files",
      tokens: memoryTokens,
      color: C_MEMORY,
      measured: false,
    });
  if (skillTokens > 0)
    slices.push({
      key: "skills",
      label: "Skills",
      tokens: skillTokens,
      color: C_SKILLS,
      measured: false,
    });
  if (agentTokens > 0)
    slices.push({
      key: "agents",
      label: "Custom agents",
      tokens: agentTokens,
      color: C_AGENTS,
      measured: false,
    });

  // With a real reported count in hand, THAT is what's in the window — using
  // anything else would let the panel disagree with the harness.
  const used = reported ?? slices.reduce((a, s) => a + s.tokens, 0);
  return {
    slices,
    free: Math.max(0, limit - used),
    used,
    limit,
    reported,
    unreportedLane: reported === null && usage ? (usage.lane ?? "this lane") : null,
    systemTools,
    mcpByServer,
    memoryFiles,
    slashCommands: manifest?.slashCommands ?? [],
  };
}
