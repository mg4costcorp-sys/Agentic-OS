import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Brain,
  Check,
  Copy as CopyIcon,
  ChevronDown,
  Columns2,
  Loader2,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pencil,
  Plus,
  Rows2,
  Square,
  Terminal as TerminalIcon,
  Wrench,
  X,
} from "lucide-react";
import { useLiveData } from "@/lib/use-live-data";
import {
  buildCtxBreakdown,
  ctxFromTable,
  estTextTokens,
  fmtCtxTokens,
  type CtxManifest,
  type CtxUsage,
} from "@/lib/ctx-window";
// One answer to "who is paying for this turn", shared with the dev server so
// the two can never disagree. Same module backs the picker's hiding of a
// metered model the user's plan already covers.
import {
  laneFor,
  markMeteredDuplicates,
  modelIdentity,
  payerLabel,
  supersededNote,
  type LaneHealth,
} from "@/lib/model-lane";
import { knowledgeDemo } from "@/lib/mock-data";
import type { KnowledgeGraph } from "@/components/knowledge-explorer";
import type { MemNode } from "@/components/memory-graph-3d";
import { MemoryGraphLoader } from "@/components/memory-graph-loader";
import { MemoryBrain } from "@/components/memory-brain";
import { ContextBreakdown } from "@/components/context-breakdown";
import { ChatMd } from "@/components/chat-md";
import claudeLogo from "@/assets/claude-logo.png";
import hermesPortrait from "@/assets/hermes-portrait-v2.png";
import labyrinthBg from "@/assets/hermes-art/mission-labyrinth.webp";
import oracleBg from "@/assets/hermes-art/02-oracle-delphi.webp";
import athenaBg from "@/assets/hermes-art/03-athena-owl.webp";
import orpheusBg from "@/assets/hermes-art/05-orpheus-lyre.webp";
import claudeVideoBg from "@/assets/claude-art/mission-claude.mp4";
import artKimi from "@/assets/model-art/kimi.webp";
import artZai from "@/assets/model-art/zai.webp";
import artMinimax from "@/assets/model-art/minimax.webp";
import artGemini from "@/assets/model-art/gemini.webp";
import artGrok from "@/assets/model-art/grok.webp";
import artDeepseek from "@/assets/model-art/deepseek.webp";
import artQwen from "@/assets/model-art/qwen.webp";
import artMeta from "@/assets/model-art/meta.webp";
import artOpenai from "@/assets/model-art/openai.webp";
import logoClaude from "@/assets/logo-claude.svg";
import logoOpenAI from "@/assets/logo-openai.svg";
import logoGemini from "@/assets/logo-gemini.svg";
import logoGrok from "@/assets/logo-grok.svg";
import logoDeepseek from "@/assets/logo-deepseek.svg";
import logoMeta from "@/assets/logo-meta.svg";
import logoMinimax from "@/assets/logo-minimax.svg";
import logoMistral from "@/assets/logo-mistral.svg";
import logoMoonshot from "@/assets/logo-moonshot.svg";
import logoQwen from "@/assets/logo-qwen.svg";
import logoZai from "@/assets/logo-zai.svg";
import logoCohere from "@/assets/logo-cohere.svg";
import logoCodex from "@/assets/logos/codex.png";

const BrainGraph3D = lazy(() => import("@/components/brain-graph-3d"));
// The full Hermes voice system (clusters, oracle, voices, activity dock) —
// one system with the memory brain, two doors in the rail footer.
const IntelligencePortal = lazy(() =>
  import("@/components/intelligence-portal").then((m) => ({ default: m.IntelligencePortal })),
);

// ── Hermes design language (mirrors agents.hermes.tsx) ─────────────────────
const BG = "#071D1C";
const CREAM = "#FFE6CB";
const AMBER = "#FFD21E";
const CLAUDE_ORANGE = "#D97757";
const MD_SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const HAIR = "rgba(255,230,203,0.26)";
const HAIR_SOFT = "rgba(255,230,203,0.18)";

type BackendId = "hermes" | "claude";

const BACKENDS: Array<{
  id: BackendId;
  label: string;
  logo: string;
  endpoint: string;
  tone: string;
}> = [
  { id: "hermes", label: "Hermes", logo: hermesPortrait, endpoint: "/__hermes_chat", tone: AMBER },
  { id: "claude", label: "Claude Code", logo: claudeLogo, endpoint: "/__claude_chat", tone: CLAUDE_ORANGE },
];

// Each pane gets its own pantheon piece; Claude panes swap to the film.
const PANE_ART = [labyrinthBg, oracleBg, athenaBg, orpheusBg];

// Model-branded superhero stills (same engraving style as the Claude film,
// each with the brand's mark on the chest). Claude-backend panes swap art to
// match the selected model; Anthropic models keep the film.
const MODEL_ART_RULES: Array<[RegExp, string]> = [
  [/kimi|moonshot/i, artKimi],
  [/glm|z-ai|zai/i, artZai],
  [/minimax/i, artMinimax],
  [/gemini/i, artGemini],
  [/grok|x-ai|xai/i, artGrok],
  [/deepseek/i, artDeepseek],
  [/qwen/i, artQwen],
  [/llama|meta/i, artMeta],
  [/gpt|openai|codex/i, artOpenai],
];
function modelArt(name: string): string | null {
  for (const [re, src] of MODEL_ART_RULES) if (re.test(name)) return src;
  return null;
}

interface ModelOption {
  name: string;
  provider?: string;
  tier?: string;
  /** Set when this metered entry is the redundant twin of a model the user's
      subscription/OAuth already covers — the picker folds it away behind one
      line rather than deleting it, so it is still reachable if the paid lane
      turns out not to work. See markMeteredDuplicates. */
  supersededBy?: string;
}

/** One tool call the CLI is waiting on us to approve. Arrives as a `permission`
    SSE event, lives in the thread as its own bubble, and collapses to a
    one-line receipt once answered. */
interface PermissionCard {
  id: string;
  tool: string;
  input: Record<string, any>;
  /** "<tool>:<first argv token>" — the scope option 2 ("don't ask again") remembers. */
  scope: string;
  /** Unset while the card is live. */
  outcome?: "allow" | "always" | "deny" | "timeout" | "abandoned";
}

/** One question the agent is asking the operator. Arrives as a `question` SSE
    event — either from our own `ask_user_question` MCP tool, or from the CLI's
    built-in AskUserQuestion coming through the permission path. */
interface AskedQuestion {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}
interface QuestionCard {
  id: string;
  /** "ask_user_question" (ours) or "AskUserQuestion" (the CLI's own). */
  tool?: string;
  questions: AskedQuestion[];
  /** Unset while the card is live. */
  outcome?: "answered" | "timeout" | "abandoned";
  /** What the operator picked, per question — kept for the receipt. */
  picked?: string[][];
}

/** 24-hour wall clock. Deliberately not relative ("2m ago"): when a build has
    been quiet you want the actual moment it last moved, to line up against
    logs and generator timestamps. */
const clockTime = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/** A file size that was MEASURED — never an estimate, so it is never rounded
    into a claim. Under 1 KB it says the exact byte count rather than "0.4 KB",
    because a 12-byte file and a 900-byte file are different news. */
const fmtBytes = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return "size unknown";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** When set, this bubble IS an approval card rather than a reply. */
  permission?: PermissionCard;
  /** When set, this bubble IS a question the agent is asking the operator. */
  question?: QuestionCard;
  /** When set, this bubble is a system note (a failover, a resume) — a thin
      centred chip in the thread, not a message from anybody. */
  note?: string;
  streaming?: boolean;
  error?: boolean;
  /** Harness activity for this turn (tool calls, compactions) — kept after the reply lands. */
  steps?: string[];
  /** Extended-thinking / reasoning text, streamed live while the model works. */
  thinking?: string;
  /** Completed narration segments from earlier in the turn — interim status
      talk that collapses into the trace; only the final segment stays as the reply. */
  segments?: string[];
  /** User message waiting for the current turn to finish — visibly queued, never interrupts. */
  queued?: boolean;
  /** Wall-clock seconds the turn took (for the worked-for pill). */
  elapsedS?: number;
  /** When this message was sent / when its turn began. A long-running chat with
      no timestamps gives you no way to tell a turn that is thinking from one
      that died twenty minutes ago — you cannot even say when it last moved. */
  ts?: number;
  /** The user intent behind this reply — what ↻ retry / ↻ resume re-sends.
      Kept on the assistant bubble so a failed turn always has a way forward. */
  retryText?: string;
  /** The turn stopped mid-work rather than finishing — offers ↻ resume. */
  interrupted?: boolean;
  /** A queued message that is steering the run rather than waiting for it. */
  steering?: boolean;
  /** The model the harness reported actually answering — shown on the pill so
      the picker can never quietly disagree with reality. */
  actualModel?: string;
  /** ccr routes that will answer with something other than the selected model. */
  routerMismatch?: { selected: string; routes: Array<{ route: string; model: string }> };
  /** How many times the server auto-resumed this turn after it stopped without
      finishing. Shown in the header because a reply stitched from four
      attempts must never be presented as one clean run. */
  resumes?: number;
  /** Files this turn said it wrote AND that were then found on disk. Never a
      claim — the server stat'd every one of these after the turn ended, and
      anything it could not find simply isn't here. */
  files?: WrittenFile[];
}

/** One verified deliverable. `bytes` is the measured size at the moment the
    turn ended; `href` is already URL-encoded, because half the files a design
    turn writes have spaces in their names and a raw href truncates at the
    first one. */
interface WrittenFile {
  path: string;
  bytes: number;
  href: string;
}

interface HermesSessionRow {
  id: string;
  model: string | null;
  messageCount: number;
  startedAt: string | null;
  lastUpdated: string | null;
  firstUserMessage: string | null;
}

interface Attachment {
  path: string;
  name: string;
  /** dataURL thumbnail for images; empty for documents */
  preview: string;
  kind: "image" | "file";
  size: number;
}

interface ClaudeChatRow {
  id: string;
  title: string;
  ts: number;
  model?: string;
  /** Approval stance the chat was last using — restored with the model. */
  toolMode?: ToolMode;
  /** The pane's per-chat id, when the row came from the server registry. */
  chatId?: string;
  /** Who started the last turn. Script-started chats wear a chip in the rail —
      before the registry existed they were invisible here entirely. */
  origin?: "ui" | "headless";
}

/** One row of ~/.claude-os/claude-chats.json, as GET /__claude_chats serves it. */
interface ServerChatRow {
  chatId: string;
  sessionId: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  origin: "ui" | "headless";
  lastPrompt: string;
}

// The pane's three permission stances, mirroring Claude Code's own: cards for
// everything, cards for everything except file edits, or no cards at all.
type ToolMode = "ask" | "acceptEdits" | "yolo";
const TOOL_MODE_LABEL: Record<ToolMode, string> = {
  ask: "ask",
  acceptEdits: "auto-edits",
  yolo: "yolo",
};

const CLAUDE_FALLBACK: ModelOption[] = [
  { name: "claude-opus-5", tier: "top" },
  { name: "claude-fable-5", tier: "top" },
  { name: "claude-opus-4-8", tier: "top" },
  { name: "claude-sonnet-5", tier: "mid" },
  { name: "claude-haiku-4-5-20251001", tier: "fast" },
];

// Claude Code-style subtitles, mirrored from the CLI's own /model picker.
const MODEL_DESC: Record<string, string> = {
  "opus-5": "Current flagship · the OS default",
  "fable-5": "Most intelligent model · frontier tier",
  "opus-4-8": "Most capable Opus · daily driver",
  "sonnet-5": "Best mix of capability and speed",
  "haiku-4-5": "Fastest · light tasks",
};
function modelDesc(name: string): string | null {
  const s = shortModel(name);
  for (const [k, d] of Object.entries(MODEL_DESC)) if (s.startsWith(k)) return d;
  return null;
}

// ── Brand + provider logos ──────────────────────────────────────────────────
// A model's BRAND (what authored it) beats its provider (what serves it) —
// openrouter/anthropic/claude-fable-5 shows the Claude mark, not OpenRouter's.
const BRAND_RULES: Array<[RegExp, string]> = [
  [/claude|anthropic/i, logoClaude],
  [/gpt|openai|codex|o[0-9]/i, logoOpenAI],
  [/gemini/i, logoGemini],
  [/grok|x-ai|xai/i, logoGrok],
  [/deepseek/i, logoDeepseek],
  [/llama|meta/i, logoMeta],
  [/minimax/i, logoMinimax],
  [/mistral/i, logoMistral],
  [/kimi|moonshot/i, logoMoonshot],
  [/qwen/i, logoQwen],
  [/glm|z-ai|zai/i, logoZai],
  [/command|cohere/i, logoCohere],
];

const PROVIDER_LOGOS: Record<string, string> = {
  anthropic: logoClaude,
  claude: logoClaude,
  openai: logoOpenAI,
  "openai-codex": logoCodex,
  openrouter: logoOpenAI,
  googlegemini: logoGemini,
  google: logoGemini,
  xai: logoGrok,
  "xai-oauth": logoGrok,
  minimax: logoMinimax,
  mistral: logoMistral,
  cohere: logoCohere,
  groq: logoMeta,
  ollama: logoMeta,
};

function brandLogo(name: string): string | null {
  for (const [re, src] of BRAND_RULES) if (re.test(name)) return src;
  return null;
}

// These marks ship as currentColor/black glyphs — invisible on the teal
// surface without an invert.
const DARK_GLYPHS = new Set([logoOpenAI, logoGrok, logoMoonshot]);

// Hover copy chip on every message bubble.
function MsgCopy({ text, align }: { text: string; align?: "right" }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={() => {
        try {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable */
        }
      }}
      title="Copy message"
      className={`absolute -top-2 ${align === "right" ? "left-1" : "right-1"} z-10 hidden group-hover:flex h-6 w-6 items-center justify-center rounded-md`}
      style={{ background: "rgba(4,16,15,0.85)", border: `1px solid ${HAIR}`, color: copied ? "#7be0c8" : "rgba(255,230,203,0.7)" }}
    >
      {copied ? <Check className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
    </button>
  );
}

function LogoChip({ src, size = 16 }: { src: string | null; size?: number }) {
  if (!src)
    return (
      <span
        className="hermes-mono inline-flex items-center justify-center shrink-0"
        style={{ width: size, height: size, color: "rgba(255,230,203, 0.88)", fontSize: size * 0.6 }}
      >
        ❯
      </span>
    );
  return (
    <span className="inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <img
        src={src}
        alt=""
        className="object-contain"
        style={{
          width: size,
          height: size,
          filter: DARK_GLYPHS.has(src) ? "invert(0.92) sepia(0.15) brightness(1.05)" : undefined,
        }}
        loading="lazy"
      />
    </span>
  );
}

// Reasoning-effort dial — Hermes' canonical levels; the Claude adapter maps
// them onto MAX_THINKING_TOKENS so one dial drives both backends.
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

// Context-window fallbacks when the live catalog doesn't know a model come
// from the shared CTX_TABLE in @/lib/ctx-window — the Hermes page reads the
// same rules, so the two panes can never disagree about a model's window.

// Real per-model context windows + reasoning support from OpenRouter's public
// catalog (keyless, CORS-open). Fetched once per session; names resolve by
// exact id then by the id's tail ("moonshotai/kimi-k3" ↔ "kimi-k3").
interface ModelCatalog {
  ctx: Record<string, number>;
  reasoning: Record<string, boolean>;
}
function useCtxMap() {
  return useQuery<ModelCatalog>({
    queryKey: ["openrouter-ctx-map"],
    queryFn: async () => {
      const r = await fetch("https://openrouter.ai/api/v1/models");
      if (!r.ok) throw new Error(`status ${r.status}`);
      const j = await r.json();
      const ctx: Record<string, number> = {};
      const reasoning: Record<string, boolean> = {};
      for (const m of j?.data ?? []) {
        const id = String(m?.id ?? "").toLowerCase();
        const c = Number(m?.context_length ?? 0);
        if (!id || !Number.isFinite(c) || c <= 0) continue;
        const reasons = (m?.supported_parameters ?? []).some(
          (p: unknown) => p === "reasoning" || p === "include_reasoning",
        );
        const tail = id.split("/").pop()!;
        ctx[id] = c;
        reasoning[id] = reasons;
        if (!ctx[tail] || c > ctx[tail]) {
          ctx[tail] = c;
          reasoning[tail] = reasons;
        }
      }
      return { ctx, reasoning };
    },
    staleTime: Infinity,
    retry: 1,
  });
}

function ctxFor(name: string, catalog?: ModelCatalog): number {
  const key = name.toLowerCase();
  const ctxMap = catalog?.ctx;
  if (ctxMap) {
    if (ctxMap[key]) return ctxMap[key];
    const tail = key.split("/").pop()!;
    if (ctxMap[tail]) return ctxMap[tail];
  }
  return ctxFromTable(name) ?? 262_144;
}

// Does this OpenRouter-routed model actually take a reasoning/thinking knob?
// Claude + Codex lanes always do; unknown ccr models default to yes so the
// dial never vanishes on a catalog hiccup.
function supportsReasoning(name: string, catalog?: ModelCatalog): boolean {
  if (!name || !name.includes("/")) return true;
  const map = catalog?.reasoning;
  if (!map) return true;
  const key = name.toLowerCase();
  if (key in map) return map[key];
  const tail = key.split("/").pop()!;
  if (tail in map) return map[tail];
  return true;
}

function useBackendModels(backend: BackendId) {
  return useQuery<ModelOption[]>({
    queryKey: ["home-models", backend],
    queryFn: async () => {
      if (backend === "hermes") {
        const res = await fetch("/__hermes_models");
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        const opts: ModelOption[] = [];
        for (const group of data?.catalog ?? []) {
          for (const m of group?.models ?? []) {
            opts.push({ name: m.name, provider: group.provider, tier: m.tier });
          }
        }
        // Hermes' configured default leads the list — models[0] is what a
        // fresh chat sends, and an arbitrary catalog entry may name a
        // provider the local install hasn't configured.
        const defName = data?.default?.name;
        const defProv = data?.default?.provider;
        const di = opts.findIndex(
          (o) => o.name === defName && (!defProv || o.provider === defProv),
        );
        if (di > 0) opts.unshift(...opts.splice(di, 1));
        // `gpt-5.6-sol` is in this catalog three times over — under `openai`
        // and `openrouter` (both metered) and under `openai-codex` (the user's
        // ChatGPT plan). Identical rows, and picking the wrong one is how a
        // model the subscription already covers got billed to OpenRouter. Mark
        // the metered twins; only against a lane the server reports HEALTHY,
        // so an expired login brings them straight back.
        return markMeteredDuplicates(opts, data?.laneHealth as LaneHealth | undefined);
      }
      try {
        const res = await fetch("/__claude_models");
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        const opts: ModelOption[] = [];
        for (const group of data?.catalog ?? []) {
          for (const m of group?.models ?? []) {
            opts.push({ name: m.name, provider: group.provider, tier: m.tier });
          }
        }
        if (opts.length === 0) return CLAUDE_FALLBACK;
        // Same rule on this backend: the ccr group reaches Fable/Opus through
        // OpenRouter at list price while the claude-code group reaches the same
        // model on the subscription.
        return markMeteredDuplicates(opts, data?.laneHealth as LaneHealth | undefined);
      } catch {
        return CLAUDE_FALLBACK;
      }
    },
    staleTime: 60_000,
  });
}

function useHermesSessionList() {
  return useQuery<{ sessions: HermesSessionRow[] }>({
    queryKey: ["home-hermes-sessions"],
    queryFn: async () => {
      const res = await fetch("/__hermes_sessions");
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    },
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

const ANSI_RE = /\x1b?\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

// Hermes's CLI interleaves plumbing lines into its replies — resuming
// banners, job/session ids. Filter them at display time (raw text stays in
// state, so nothing is lost if we ever need it).
const NOISE_LINE = /^\s*(?:[❯>›]\s*)?(?:RESUMING\b|Resuming session\b|Job ID:\s*\S|session_id:\s*\S)/i;
// OpenRouter billing failures → a clean actionable card instead of a raw
// stack trace in the bubble (the key's own cap is the usual culprit).
function billingIssue(text: string): { title: string; body: string } | null {
  if (/Key limit exceeded/i.test(text))
    return {
      title: "OpenRouter key cap hit",
      body: "This key's total spending limit is exhausted — the account balance can still look healthy while every call fails. Raise or remove the key's limit, then send “continue”.",
    };
  if (/requires more credits/i.test(text))
    return {
      title: "OpenRouter credits too low for this turn",
      body: "The key can't reserve enough output tokens for a reply. Raise the key's limit or top up credits, then send “continue”.",
    };
  return null;
}

function stripNoise(s: string): string {
  if (!NOISE_LINE.test(s) && !s.includes("Job ID")) return s;
  return s
    .split("\n")
    .filter((l) => !NOISE_LINE.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function shortModel(name: string): string {
  return name
    .replace(/^.*\//, "")
    .replace("claude-", "")
    .replace("-20251001", "");
}

// ── Live turn telemetry ─────────────────────────────────────────────────────
// The OS already rendered elapsed time and a tool count — but only once the
// turn was OVER. While it ran there was a half-finished sentence and nothing
// else, so "is this alive?" could only be answered by running `ps` and
// sampling CPU time. Everything below is the live twin of the finished-turn
// header, built from the SSE stream that was already arriving.

/** 754 → "12m 34s". Coarse on purpose — this is glanced at, not read. */
function fmtDur(s: number): string {
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

/**
 * Everything the strip needs, held in a REF rather than state. A turn clock in
 * component state re-renders the whole transcript once a second; the strip
 * ticks itself instead and reads these fields on each tick.
 */
interface LiveTurn {
  /** Wall-clock ms when this turn started. */
  startedAt: number;
  /** Last chunk / info / think / tool — i.e. the last REAL output. */
  lastEventAt: number;
  /** Last anything off the socket, `:keepalive` comments included. */
  lastByteAt: number;
  phase: "thinking" | "tool" | "text" | "waiting";
  /** The tool now running, from the structured `tool` event (never regexed
      back out of the "⚙ Bash: …" display label). */
  tool: { name: string; target: string } | null;
  toolStartedAt: number;
  tools: number;
  /** How many times the server has auto-resumed this turn, and its cap. */
  resumes: number;
  maxResumes: number;
  /** A resume is in flight right now — the quiet "reconnecting 2/5" state. */
  recovering: boolean;
  /** Automatic recovery gave up (bounds hit, or a loop it refused to feed).
      Only from here on is a stall worth shouting about: before it, silence is
      something the server is already doing something about. */
  recoveryExhausted: boolean;
}

function freshLiveTurn(startedAt: number): LiveTurn {
  return {
    startedAt,
    lastEventAt: startedAt,
    lastByteAt: startedAt,
    phase: "waiting",
    tool: null,
    toolStartedAt: 0,
    tools: 0,
    resumes: 0,
    maxResumes: 5,
    recovering: false,
    recoveryExhausted: false,
  };
}

/** No output at all for this long and the strip stops saying "working". */
const STALL_MS = 90_000;
/** Server heartbeats every 15s, so ~3 missed beats means the stream is gone. */
const FLATLINE_MS = 45_000;

/** Re-render this component (and only this component) once a second. */
function useSecondHand() {
  const [, bump] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => bump((n) => (n + 1) % 3600), 1000);
    return () => clearInterval(iv);
  }, []);
}

/** A ticking "how long since" readout that costs one node, not a transcript. */
function SinceLabel({
  since,
  render,
}: {
  since: React.MutableRefObject<number>;
  render: (seconds: number) => string;
}) {
  useSecondHand();
  const s = since.current ? Math.max(0, Math.floor((Date.now() - since.current) / 1000)) : 0;
  return <>{render(s)}</>;
}

/**
 * The composer's turn line: what it's doing, and — once a step has been
 * running a while — that it is STILL on that step. Its own component purely so
 * the second hand stops here instead of reaching the transcript.
 */
function WorkingLine({
  activity,
  turnStart,
  stepStart,
}: {
  activity: string;
  turnStart: React.MutableRefObject<number>;
  stepStart: React.MutableRefObject<number>;
}) {
  useSecondHand();
  const now = Date.now();
  const elapsed = turnStart.current ? Math.floor((now - turnStart.current) / 1000) : 0;
  const step = stepStart.current ? Math.floor((now - stepStart.current) / 1000) : 0;
  return (
    <>
      {activity || (elapsed > 20 ? "background agent working…" : "working…")}
      {step >= 25 ? `  — still on this step ${fmtDur(step)}` : ""}
    </>
  );
}

/**
 * The in-flight header. Deliberately the same pill as the finished-turn
 * `✓ worked … · N tools · view trace` summary — same mono face, same 11px
 * uppercase tracking, same hairline border — so when the turn lands the header
 * swaps in place rather than the row changing shape.
 *
 * The stall line is the point of the whole thing. A spinner looks identical
 * whether a model is thinking hard or the child process has died, which is
 * exactly the failure this replaces: keepalives still arriving but no output
 * for minutes means "thinking or wedged"; keepalives stopping too means the
 * stream itself is gone. Those are different sentences.
 */
function LiveTurnStrip({
  live,
  ts,
  toolCount,
  model,
  tone,
  paused,
}: {
  live: React.MutableRefObject<LiveTurn>;
  ts?: number;
  toolCount: number;
  model?: string;
  tone: string;
  /** Parked on an approval/question card — nothing is running, so no stall. */
  paused?: boolean;
}) {
  useSecondHand();
  const L = live.current;
  const now = Date.now();
  const elapsed = Math.max(0, Math.floor((now - (L.startedAt || now)) / 1000));
  const quiet = L.lastEventAt ? now - L.lastEventAt : 0;
  const silence = L.lastByteAt ? now - L.lastByteAt : 0;
  const toolAge = L.toolStartedAt ? Math.floor((now - L.toolStartedAt) / 1000) : 0;

  // ── When the strip is allowed to shout ────────────────────────────────
  // It used to shout at 90 seconds of quiet, which is how the user came to
  // see "⚠ NO OUTPUT FOR 1M 47S" on a turn that was merely thinking — a
  // warning that neither told them anything nor did anything about it.
  //
  // flatline (no bytes at all, keepalives included) still shouts, because that
  // means the STREAM is gone: the server can't recover a turn it can no longer
  // talk to us about, so this is the "genuinely impossible" case.
  //
  // stalled (keepalives fine, no real output) is now quiet until the server
  // says automatic recovery is spent. Until then, silence is either a model
  // thinking or a resume already in flight, and both are normal.
  const recovering = !paused && L.recovering;
  const flatline = !paused && silence > FLATLINE_MS;
  const stalled = !paused && !flatline && !recovering && quiet > STALL_MS;
  const loudStall = stalled && L.recoveryExhausted;

  // A tool that has been running for two minutes is not "waiting on the
  // model" — the model already spoke and something else is slow. Keep the two
  // apart, because they send you to different places to look.
  const state = paused
    ? "waiting on you"
    : recovering
      ? "reconnecting"
      : L.phase === "tool"
      ? "running"
      : quiet > 10_000
        ? "waiting on the model"
        : L.phase === "thinking"
          ? "thinking"
          : L.phase === "text"
            ? "writing"
            : "waiting on the model";

  const detail = L.tool ? `${L.tool.name}${L.tool.target ? `: ${L.tool.target}` : ""}` : "";
  // The loud line — reserved for the two states nothing is being done about.
  const stallText = flatline
    ? `stream silent ${fmtDur(Math.floor(silence / 1000))} — no keepalive either`
    : loudStall
      ? `no output for ${fmtDur(Math.floor(quiet / 1000))}`
      : "";
  const stallTone = flatline ? "#ff9d8f" : AMBER;
  // The quiet line — recovery in progress, or a long think that the server is
  // still watching. Same information, none of the alarm.
  const calmText = recovering
    ? `reconnecting ${L.resumes}/${L.maxResumes}`
    : stalled
      ? `quiet ${fmtDur(Math.floor(quiet / 1000))}`
      : L.resumes > 0
        ? `${L.resumes} resume${L.resumes === 1 ? "" : "s"}`
        : "";

  return (
    <div
      // Fixed height + overflow-hidden: this row updates every second inside a
      // live message, and it must never reflow the transcript under the
      // reader's eyes. The one growable cell truncates.
      className="hermes-mono mb-2 flex h-[26px] items-center gap-1.5 overflow-hidden rounded-full px-2.5 text-[11px] uppercase tracking-[0.16em]"
      style={{
        color: "rgba(255,230,203, 0.75)",
        border: `1px solid ${stallText ? `${stallTone}66` : "rgba(255,230,203,0.14)"}`,
        // Tabular figures so a ticking clock can't change the row's width.
        fontVariantNumeric: "tabular-nums",
      }}
      aria-live="off"
      title={
        `Turn started ${ts ? clockTime(ts) : "just now"} · running ${fmtDur(elapsed)} · ${toolCount} tool${toolCount === 1 ? "" : "s"}` +
        (L.resumes ? ` · ${L.resumes} automatic resume${L.resumes === 1 ? "" : "s"}` : "") +
        (detail ? ` · ${detail}` : "") +
        (calmText ? ` · ${calmText}` : "") +
        (stallText ? ` · ${stallText}` : "")
      }
    >
      {flatline ? (
        // No pulse when the stream is gone — a heartbeat would be a lie.
        <span
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: "#ff9d8f" }}
        />
      ) : (
        // Still pulsing while reconnecting: the turn IS alive, and a frozen
        // dot would say the opposite.
        <span className="hc-pulse shrink-0" style={{ background: loudStall ? AMBER : tone }} />
      )}
      {ts && <span className="shrink-0 whitespace-nowrap">{clockTime(ts)} ·</span>}
      <span className="shrink-0 whitespace-nowrap" style={{ color: CREAM }}>
        {fmtDur(elapsed)}
      </span>
      <span className="shrink-0 whitespace-nowrap">
        · {toolCount} tool{toolCount === 1 ? "" : "s"} ·
      </span>
      <span className="shrink-0 whitespace-nowrap" style={{ color: stallText ? stallTone : CREAM }}>
        {state}
      </span>
      <span
        className="min-w-0 flex-1 truncate normal-case tracking-normal"
        style={{ color: "rgba(243,233,218,0.62)", fontFamily: MD_SANS, fontSize: 11.5 }}
      >
        {detail}
        {L.phase === "tool" && toolAge > 3 ? `  ${fmtDur(toolAge)}` : ""}
      </span>
      {calmText && !stallText && (
        <span
          className="shrink-0 whitespace-nowrap"
          style={{ color: "rgba(243,233,218,0.55)" }}
        >
          {calmText}
        </span>
      )}
      {stallText && (
        <span className="shrink-0 whitespace-nowrap" style={{ color: stallTone }}>
          ⚠ {stallText}
        </span>
      )}
      {model && (
        <span
          className="ml-0.5 shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 tracking-normal"
          style={{ border: "1px solid rgba(255,230,203,0.2)", color: "rgba(255,230,203, 0.88)" }}
        >
          {shortModel(model)}
        </span>
      )}
    </div>
  );
}

// Session titles come from the first user message, which often opens with
// injected context blocks ("[IMPORTANT: …]", "[How to answer …]"). Show the
// human part.
function cleanTitle(raw: string | null): string {
  let s = (raw ?? "").trim();
  for (let i = 0; i < 4 && s.startsWith("["); i++) {
    const close = s.indexOf("]");
    if (close === -1) break;
    s = s.slice(close + 1).trim();
  }

  // A skill invocation opens with the skill file's YAML frontmatter, so the
  // raw first message reads "---\nname: strategic-morning-brief\ndescription:
  // …". Stripping only the "---" left the literal "name: …" as the title.
  // When frontmatter is present the skill's own name IS the title — nothing
  // after it describes this particular run any better.
  const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(s);
  const named = /^\s*name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(
    fm ? fm[1] : s.startsWith("name:") ? s : "",
  );
  if (named?.[1]) return named[1].trim();

  s = s.replace(/^---\s*/g, "").replace(/\s+/g, " ").trim();
  return s.length > 0 ? s : "Untitled chat";
}

/**
 * "resets 21:21", or null when there is nothing trustworthy to print.
 *
 * The two lanes report this stamp in two different shapes, and the panel used
 * to assume one of them: Codex sends epoch SECONDS (1785612074, see
 * scripts/aggregate.ts:3528) while the Claude subscription sends an ISO string
 * ("2026-07-26T00:50:00.896595+00:00", aggregate.ts:3438 — it is passed through
 * verbatim from the plan-usage API). `resetsAt * 1000` on the string is NaN, so
 * every Claude Max user read "resets Invalid Date · 6%" in the usage popover.
 * An unparseable stamp now prints nothing at all, which is the honest fallback.
 */
function resetClock(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = typeof v === "number" ? new Date(v * 1000) : new Date(String(v));
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function relTime(input: string | number | null): string {
  if (input === null || input === undefined) return "";
  const t = typeof input === "number" ? input : new Date(input).getTime();
  const d = Date.now() - t;
  const mins = Math.floor(d / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// Per-chat display titles: manual renames win over AI-generated ones.
const TITLES_KEY = "claude-os.chat-titles.v1";
function readTitles(): Record<string, { t: string; manual?: boolean }> {
  try {
    const raw = localStorage.getItem(TITLES_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}
function saveTitle(key: string, t: string, manual: boolean) {
  try {
    const map = readTitles();
    if (!manual && map[key]?.manual) return; // never clobber a manual rename
    map[key] = { t: t.slice(0, 60), manual };
    localStorage.setItem(TITLES_KEY, JSON.stringify(map));
  } catch {
    /* localStorage unavailable */
  }
}

// Chats deleted from the rail. Hermes sessions belong to the Hermes CLI and
// Claude transcripts to ~/.claude — deleting here removes them from the OS
// list without destroying the underlying agent history.
const HIDDEN_KEY = "claude-os.hidden-chats.v1";
function readHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function hideChat(key: string) {
  try {
    const set = readHidden();
    set.add(key);
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set].slice(-500)));
  } catch {
    /* localStorage unavailable */
  }
}
function removeClaudeChat(id: string) {
  try {
    const raw = localStorage.getItem("claude-os.claude-chats.v1");
    const arr = raw ? JSON.parse(raw) : [];
    localStorage.setItem(
      "claude-os.claude-chats.v1",
      JSON.stringify(Array.isArray(arr) ? arr.filter((r: any) => r?.id !== id) : []),
    );
  } catch {
    /* localStorage unavailable */
  }
}

const CLAUDE_CHATS_KEY = "claude-os.claude-chats.v1";
function readClaudeChats(): ClaudeChatRow[] {
  try {
    const raw = localStorage.getItem(CLAUDE_CHATS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function rememberClaudeChat(row: ClaudeChatRow) {
  try {
    const arr = readClaudeChats().filter((r) => r.id !== row.id);
    arr.unshift(row);
    localStorage.setItem(CLAUDE_CHATS_KEY, JSON.stringify(arr.slice(0, 30)));
  } catch {
    /* localStorage may be disabled */
  }
}

// ── Model picker (logo-rich popover, grouped by provider) ───────────────────
// ── Approval cards ──────────────────────────────────────────────────────────
// Claude Code's terminal permission prompt, rendered in the pane. The CLI's
// own titling: it never says "Bash tool", it says "Bash command".
const TOOL_TITLES: Record<string, string> = {
  Bash: "Bash command",
  BashOutput: "Read command output",
  Edit: "Edit file",
  MultiEdit: "Edit file",
  NotebookEdit: "Edit notebook",
  Write: "Write file",
  Read: "Read file",
  WebFetch: "Fetch URL",
  WebSearch: "Web search",
  Glob: "Find files",
  Grep: "Search files",
  Task: "Run agent",
  KillShell: "Kill shell",
};
function toolTitle(tool: string): string {
  if (TOOL_TITLES[tool]) return TOOL_TITLES[tool];
  // MCP tools arrive as mcp__<server>__<tool> — read better split up.
  const mcp = tool.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (mcp) return `${mcp[1]} · ${mcp[2].replace(/_/g, " ")}`;
  return `${tool} tool`;
}

/** The wording on option 2, derived from the scope the server will remember. */
function alwaysLabel(card: PermissionCard): string {
  const [tool, token] = card.scope.split(/:(.*)/s);
  if (tool === "Bash") return `Yes, and don't ask again for ${token || "these"} commands in ~`;
  if (token && token !== "*") return `Yes, and don't ask again for ${tool} in ${token}`;
  return `Yes, and don't ask again for ${tool}`;
}

/** Line-level diff for Edit/Write cards. Classic LCS table — the strings a
    single tool call carries are small, and anything genuinely huge falls back
    to a flat remove-then-add block rather than allocating an n×m matrix. */
function lineDiff(before: string, after: string): Array<{ k: " " | "-" | "+"; t: string }> {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > 400 || b.length > 400)
    return [
      ...a.map((t) => ({ k: "-" as const, t })),
      ...b.map((t) => ({ k: "+" as const, t })),
    ];
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Array<{ k: " " | "-" | "+"; t: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) out.push({ k: " ", t: a[i++] }), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ k: "-", t: a[i++] });
    else out.push({ k: "+", t: b[j++] });
  }
  while (i < a.length) out.push({ k: "-", t: a[i++] });
  while (j < b.length) out.push({ k: "+", t: b[j++] });
  return out;
}

function DiffView({ before, after }: { before: string; after: string }) {
  const rows = lineDiff(before, after);
  // Unchanged runs longer than six lines collapse to a "⋯" marker so a
  // one-line edit in a big file doesn't bury the actual change.
  const keep = new Set<number>();
  rows.forEach((r, i) => {
    if (r.k === " ") return;
    for (let d = -3; d <= 3; d++) keep.add(i + d);
  });
  const shown: Array<{ k: " " | "-" | "+" | "~"; t: string }> = [];
  let skipping = false;
  rows.forEach((r, i) => {
    if (r.k !== " " || keep.has(i)) {
      shown.push(r);
      skipping = false;
    } else if (!skipping) {
      shown.push({ k: "~", t: "⋯" });
      skipping = true;
    }
  });
  return (
    <div className="hermes-mono mt-2 max-h-[300px] overflow-auto rounded-lg py-1.5 text-[11px] leading-[1.55]"
      style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,230,203,0.1)" }}>
      {shown.map((r, i) => (
        <div
          key={i}
          className="whitespace-pre px-2.5"
          style={{
            background: r.k === "+" ? "rgba(94,214,150,0.13)" : r.k === "-" ? "rgba(255,110,90,0.13)" : "transparent",
            color:
              r.k === "+" ? "#8ee6b4" : r.k === "-" ? "#ff9d8f" : r.k === "~" ? "rgba(255,230,203,0.3)" : "rgba(243,233,218,0.55)",
            borderLeft: `2px solid ${r.k === "+" ? "#5ed696" : r.k === "-" ? "#ff6e5a" : "transparent"}`,
          }}
        >
          {r.k === "~" ? "  ⋯" : `${r.k} ${r.t}`}
        </div>
      ))}
    </div>
  );
}

function PermissionPrompt({
  card,
  onDecide,
}: {
  card: PermissionCard;
  onDecide: (d: "allow" | "always" | "deny", message?: string) => void;
}) {
  const [denyOpen, setDenyOpen] = useState(false);
  const [denyText, setDenyText] = useState("");
  const [showAll, setShowAll] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const denyRef = useRef<HTMLInputElement>(null);
  // A live card takes focus so 1/2/3 work the instant it appears, exactly
  // like the CLI's own prompt owning the terminal.
  useEffect(() => {
    if (!card.outcome) boxRef.current?.focus();
  }, [card.outcome]);
  useEffect(() => {
    if (denyOpen) denyRef.current?.focus();
  }, [denyOpen]);

  if (card.outcome) {
    // Resolved → a one-line receipt, the way the CLI leaves a single line
    // behind once you answer.
    const allowed = card.outcome === "allow" || card.outcome === "always";
    const hint =
      card.tool === "Bash"
        ? String(card.input.command ?? "")
        : String(card.input.file_path ?? card.input.path ?? card.input.url ?? card.input.pattern ?? "");
    return (
      <div
        className="hermes-mono flex items-center gap-2 rounded-lg px-3 py-1.5 text-[10.5px]"
        style={{
          border: `1px solid ${allowed ? "rgba(94,214,150,0.3)" : "rgba(255,157,143,0.3)"}`,
          color: allowed ? "rgba(142,230,180,0.85)" : "rgba(255,157,143,0.85)",
          background: "rgba(0,0,0,0.25)",
        }}
      >
        {allowed ? "✓ allowed" : "✗ denied"} {card.tool}
        {hint ? `(${hint.replace(/\s+/g, " ").slice(0, 60)}${hint.length > 60 ? "…" : ""})` : ""}
        {card.outcome === "always" && <span style={{ opacity: 0.6 }}>· won't ask again</span>}
        {card.outcome === "timeout" && <span style={{ opacity: 0.6 }}>· no answer in 10 min</span>}
        {card.outcome === "abandoned" && <span style={{ opacity: 0.6 }}>· turn ended first</span>}
      </div>
    );
  }

  const body = (() => {
    if (card.tool === "Bash") {
      const cmd = String(card.input.command ?? "");
      const desc = String(card.input.description ?? "");
      return (
        <>
          <div
            className="hermes-mono mt-2 whitespace-pre-wrap rounded-lg px-3 py-2 text-[12px]"
            style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,230,203,0.1)", color: CREAM }}
          >
            {cmd}
          </div>
          {desc && (
            <div className="mt-1.5 text-[11.5px]" style={{ color: "rgba(243,233,218,0.65)", fontFamily: MD_SANS }}>
              {desc}
            </div>
          )}
        </>
      );
    }
    if (card.tool === "Edit" || card.tool === "MultiEdit" || card.tool === "NotebookEdit") {
      return (
        <DiffView
          before={String(card.input.old_string ?? card.input.old_source ?? "")}
          after={String(card.input.new_string ?? card.input.new_source ?? "")}
        />
      );
    }
    if (card.tool === "Write") {
      return <DiffView before="" after={String(card.input.content ?? "")} />;
    }
    // Everything else: the input as the CLI would print it, capped so a
    // giant payload can't push the buttons off screen.
    const json = JSON.stringify(card.input, null, 2);
    const lines = json.split("\n");
    const truncated = !showAll && lines.length > 40;
    return (
      <>
        <div
          className="hermes-mono mt-2 max-h-[300px] overflow-auto whitespace-pre rounded-lg px-3 py-2 text-[11px]"
          style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,230,203,0.1)", color: "rgba(243,233,218,0.75)" }}
        >
          {truncated ? lines.slice(0, 40).join("\n") : json}
        </div>
        {truncated && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="hermes-mono mt-1 text-[11px] uppercase tracking-wider"
            style={{ color: AMBER }}
          >
            show all {lines.length} lines
          </button>
        )}
      </>
    );
  })();

  const filePath = String(card.input.file_path ?? card.input.path ?? card.input.notebook_path ?? "");
  const options: Array<{ n: number; label: string; run: () => void; tone?: string }> = [
    { n: 1, label: "Yes", run: () => onDecide("allow") },
    { n: 2, label: alwaysLabel(card), run: () => onDecide("always") },
    {
      n: 3,
      label: "No, and tell Claude what to do differently (esc)",
      run: () => setDenyOpen(true),
      tone: "#ff9d8f",
    },
  ];

  return (
    <div
      ref={boxRef}
      tabIndex={0}
      onKeyDown={(e) => {
        if (denyOpen) return;
        if (e.key === "1" || e.key === "Enter") {
          e.preventDefault();
          onDecide("allow");
        } else if (e.key === "2") {
          e.preventDefault();
          onDecide("always");
        } else if (e.key === "3" || e.key === "Escape") {
          e.preventDefault();
          setDenyOpen(true);
        }
      }}
      className="rounded-xl px-4 py-3.5 focus:outline-none"
      style={{
        border: `1px solid ${CLAUDE_ORANGE}66`,
        background: "rgba(217,119,87,0.07)",
        boxShadow: `0 0 0 1px ${CLAUDE_ORANGE}18, 0 14px 40px rgba(0,0,0,0.4)`,
      }}
    >
      <div
        className="text-[12.5px] font-semibold"
        style={{ color: CLAUDE_ORANGE, fontFamily: MD_SANS }}
      >
        {toolTitle(card.tool)}
        {filePath && (
          <span className="hermes-mono ml-2 text-[11px] font-normal" style={{ color: "rgba(243,233,218,0.6)" }}>
            {filePath}
          </span>
        )}
      </div>
      {body}
      <div className="mt-3 text-[11.5px]" style={{ color: "rgba(243,233,218,0.7)", fontFamily: MD_SANS }}>
        Do you want to proceed?
      </div>
      {denyOpen ? (
        <div className="mt-2 flex items-center gap-2">
          <input
            ref={denyRef}
            value={denyText}
            onChange={(e) => setDenyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onDecide("deny", denyText.trim());
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDenyOpen(false);
              }
            }}
            placeholder="What should Claude do instead?"
            className="flex-1 rounded-lg bg-transparent px-3 py-1.5 text-[12px] focus:outline-none"
            style={{ border: "1px solid rgba(255,157,143,0.4)", color: CREAM, fontFamily: MD_SANS }}
          />
          <button
            type="button"
            onClick={() => onDecide("deny", denyText.trim())}
            className="hermes-mono rounded-lg px-3 py-1.5 text-[11px] uppercase tracking-wider"
            style={{ border: "1px solid rgba(255,157,143,0.5)", color: "#ff9d8f" }}
          >
            send
          </button>
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          {options.map((o) => (
            <button
              key={o.n}
              type="button"
              onClick={o.run}
              className="flex items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-white/5"
              style={{ color: o.tone ?? CREAM, fontFamily: MD_SANS }}
            >
              <span className="hermes-mono text-[11px]" style={{ color: AMBER }}>
                {o.n}.
              </span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The agent asking the operator something. Deliberately the same silhouette as
// the approval card above — orange hairline, dark body — because they are the
// same moment from two directions: the run has stopped and it is your turn.
function QuestionPrompt({
  card,
  onAnswer,
}: {
  card: QuestionCard;
  onAnswer: (picks: string[][]) => void;
}) {
  const [picks, setPicks] = useState<string[][]>(() => card.questions.map(() => []));
  const [otherOpen, setOtherOpen] = useState<number | null>(null);
  const [otherText, setOtherText] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!card.outcome) boxRef.current?.focus();
  }, [card.outcome]);
  useEffect(() => {
    if (otherOpen !== null) otherRef.current?.focus();
  }, [otherOpen]);

  if (card.outcome) {
    // Resolved → the same one-line receipt an answered approval leaves behind.
    const answered = card.outcome === "answered";
    const summary = (card.picked ?? [])
      .map((p, i) => `${card.questions[i]?.header ?? ""}: ${p.join(", ")}`)
      .filter((s) => !/: $/.test(s))
      .join(" · ");
    return (
      <div
        className="hermes-mono flex items-center gap-2 rounded-lg px-3 py-1.5 text-[10.5px]"
        style={{
          border: `1px solid ${answered ? "rgba(94,214,150,0.3)" : "rgba(255,157,143,0.3)"}`,
          color: answered ? "rgba(142,230,180,0.85)" : "rgba(255,157,143,0.85)",
          background: "rgba(0,0,0,0.25)",
        }}
      >
        {answered ? `✓ answered${summary ? ` — ${summary}` : ""}` : "✗ unanswered"}
        {card.outcome === "timeout" && <span style={{ opacity: 0.6 }}>· no answer in 10 min</span>}
        {card.outcome === "abandoned" && <span style={{ opacity: 0.6 }}>· turn ended first</span>}
      </div>
    );
  }

  const singleShot = card.questions.length === 1 && !card.questions[0].multiSelect;
  const ready = card.questions.every((_, i) => (picks[i] ?? []).length > 0);
  const setPick = (qi: number, next: string[]) =>
    setPicks((p) => p.map((v, i) => (i === qi ? next : v)));
  const submit = (override?: string[][]) => onAnswer(override ?? picks);

  return (
    <div
      ref={boxRef}
      tabIndex={0}
      className="rounded-xl px-4 py-3.5 focus:outline-none"
      style={{
        border: `1px solid ${CLAUDE_ORANGE}66`,
        background: "rgba(217,119,87,0.07)",
        boxShadow: `0 0 0 1px ${CLAUDE_ORANGE}18, 0 14px 40px rgba(0,0,0,0.4)`,
      }}
    >
      {card.questions.map((q, qi) => {
        const chosen = picks[qi] ?? [];
        return (
          <div key={qi} className={qi > 0 ? "mt-4 border-t pt-3" : ""} style={qi > 0 ? { borderColor: "rgba(255,230,203,0.12)" } : undefined}>
            <div className="flex items-center gap-2">
              <span
                className="hermes-mono rounded px-1.5 py-[2px] text-[10.5px] uppercase tracking-wider"
                style={{ background: `${CLAUDE_ORANGE}22`, color: CLAUDE_ORANGE }}
              >
                {q.header}
              </span>
              {q.multiSelect && (
                <span className="hermes-mono text-[10.5px] uppercase tracking-wider" style={{ color: "rgba(255,230,203, 0.62)" }}>
                  pick any
                </span>
              )}
            </div>
            <div className="mt-1.5 text-[13px] leading-snug" style={{ color: CREAM, fontFamily: MD_SANS }}>
              {q.question}
            </div>
            <div className="mt-2 flex flex-col gap-1">
              {q.options.map((o) => {
                const on = chosen.includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => {
                      if (q.multiSelect) {
                        setPick(qi, on ? chosen.filter((c) => c !== o.label) : [...chosen, o.label]);
                        return;
                      }
                      const next = picks.map((v, i) => (i === qi ? [o.label] : v));
                      setPicks(next);
                      // One single-select question is the common case, and it
                      // should feel like a button, not a form: click, done.
                      if (singleShot) submit(next);
                    }}
                    className="flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/5"
                    style={{
                      border: `1px solid ${on ? CLAUDE_ORANGE : "rgba(255,230,203,0.16)"}`,
                      background: on ? "rgba(217,119,87,0.14)" : "rgba(0,0,0,0.25)",
                    }}
                  >
                    {q.multiSelect && (
                      <span
                        className="mt-[2px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px]"
                        style={{
                          border: `1px solid ${on ? CLAUDE_ORANGE : "rgba(255,230,203,0.35)"}`,
                          background: on ? CLAUDE_ORANGE : "transparent",
                          color: BG,
                        }}
                      >
                        {on && <Check className="h-2.5 w-2.5" />}
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="block text-[12.5px]" style={{ color: CREAM, fontFamily: MD_SANS }}>
                        {o.label}
                      </span>
                      {o.description && (
                        <span
                          className="mt-0.5 block text-[11px] leading-snug"
                          style={{ color: "rgba(243,233,218,0.55)", fontFamily: MD_SANS }}
                        >
                          {o.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
              {otherOpen === qi ? (
                <div className="mt-0.5 flex items-center gap-2">
                  <input
                    ref={otherRef}
                    value={otherText}
                    onChange={(e) => setOtherText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const t = otherText.trim();
                        if (!t) return;
                        const next = picks.map((v, i) => (i === qi ? [t] : v));
                        setPicks(next);
                        setOtherOpen(null);
                        setOtherText("");
                        if (singleShot) submit(next);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setOtherOpen(null);
                      }
                    }}
                    placeholder="Something else…"
                    className="flex-1 rounded-lg bg-transparent px-3 py-1.5 text-[12px] focus:outline-none"
                    style={{ border: `1px solid ${CLAUDE_ORANGE}66`, color: CREAM, fontFamily: MD_SANS }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const t = otherText.trim();
                      if (!t) return;
                      const next = picks.map((v, i) => (i === qi ? [t] : v));
                      setPicks(next);
                      setOtherOpen(null);
                      setOtherText("");
                      if (singleShot) submit(next);
                    }}
                    className="hermes-mono rounded-lg px-3 py-1.5 text-[11px] uppercase tracking-wider"
                    style={{ border: `1px solid ${CLAUDE_ORANGE}88`, color: CLAUDE_ORANGE }}
                  >
                    send
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setOtherOpen(qi);
                    setOtherText(chosen.length && !q.options.some((o) => o.label === chosen[0]) ? chosen[0] : "");
                  }}
                  className="hermes-mono mt-0.5 self-start rounded-lg px-2.5 py-1 text-[11px] uppercase tracking-wider transition-colors hover:bg-white/5"
                  style={{ border: "1px dashed rgba(255,230,203,0.25)", color: "rgba(255,230,203, 0.75)" }}
                >
                  other…
                </button>
              )}
            </div>
            {chosen.length > 0 && !q.options.some((o) => o.label === chosen[0]) && (
              <div className="mt-1.5 text-[11px]" style={{ color: "rgba(243,233,218,0.6)", fontFamily: MD_SANS }}>
                you said: <span style={{ color: CREAM }}>{chosen[0]}</span>
              </div>
            )}
          </div>
        );
      })}
      {!singleShot && (
        <button
          type="button"
          disabled={!ready}
          onClick={() => submit()}
          className="mt-3 w-full rounded-lg px-3 py-2 text-[12px] transition-opacity disabled:opacity-30"
          style={{ background: CLAUDE_ORANGE, color: BG, fontFamily: MD_SANS }}
        >
          Send answer{card.questions.length > 1 ? "s" : ""}
        </button>
      )}
    </div>
  );
}

// The router-integrity warning. Reads as a fact plus a fix, because the
// failure it describes is silent by nature: the chat looks fine, the model
// chip says what you picked, and a different model wrote the code.
function RouterMismatchCard({
  info,
  onPinned,
}: {
  info: { selected: string; routes: Array<{ route: string; model: string }> };
  onPinned: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ROUTE_MEANING: Record<string, string> = {
    default: "ordinary turns",
    background: "background work",
    think: "thinking requests",
    longContext: "anything past the long-context threshold",
    webSearch: "web searches",
  };
  return (
    <div
      className="rounded-xl px-4 py-3"
      style={{ border: "1px solid rgba(255,210,30,0.45)", background: "rgba(255,210,30,0.06)" }}
    >
      <div className="mb-1.5 text-[12.5px] font-semibold" style={{ color: AMBER, fontFamily: MD_SANS }}>
        ⚠ the router won't use {shortModel(info.selected)} for everything
      </div>
      <div className="space-y-0.5">
        {info.routes.map((r) => (
          <div key={r.route} className="text-[11.5px]" style={{ color: "rgba(243,233,218,0.8)", fontFamily: MD_SANS }}>
            router will answer <b>{ROUTE_MEANING[r.route] ?? r.route}</b> with{" "}
            <span style={{ color: "#ff9d8f" }}>{shortModel(r.model)}</span>, not {shortModel(info.selected)}
          </div>
        ))}
      </div>
      <div className="mt-1.5 text-[11px]" style={{ color: "rgba(255,230,203, 0.75)", fontFamily: MD_SANS }}>
        Ordinary turns still use {shortModel(info.selected)} — the chat pins it explicitly. These are
        the requests the router picks a model for on its own, so they escape that pin.
      </div>
      <div className="mt-2 text-[11px]" style={{ color: "rgba(255,230,203, 0.75)", fontFamily: MD_SANS }}>
        Pinning rewrites ~/.claude-code-router/config.json (a timestamped backup is written first)
        and restarts the router — any run currently streaming through it is interrupted.
      </div>
      {err && (
        <div className="mt-1.5 text-[11px]" style={{ color: "#ff9d8f", fontFamily: MD_SANS }}>
          {err}
        </div>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setErr(null);
          void (async () => {
            try {
              const t = await fetch("/__token").then((r) => r.json());
              const r = await fetch("/__ccr_pin_routes", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Claude-OS-Token": t.token },
                body: JSON.stringify({ model: info.selected }),
              });
              const j = await r.json();
              if (!r.ok || j?.error) throw new Error(j?.error ?? `status ${r.status}`);
              onPinned();
            } catch (e: any) {
              setErr(String(e?.message ?? e));
            } finally {
              setBusy(false);
            }
          })();
        }}
        className="hermes-mono mt-2 rounded-full px-3 py-1 text-[11px] uppercase tracking-wider disabled:opacity-60"
        style={{ border: `1px solid ${AMBER}88`, color: AMBER }}
      >
        {busy ? "pinning…" : `pin all routes to ${shortModel(info.selected)}`}
      </button>
    </div>
  );
}

function ModelPicker({
  models,
  model,
  onPick,
  backend,
  effort,
  onEffort,
  showEffort = true,
  effortChoices = EFFORT_LEVELS,
}: {
  models: ModelOption[];
  model: ModelOption | null;
  onPick: (key: string) => void;
  backend: BackendId;
  effort: EffortLevel;
  onEffort: (e: EffortLevel) => void;
  showEffort?: boolean;
  effortChoices?: readonly EffortLevel[];
}) {
  const [open, setOpen] = useState(false);
  // Metered duplicates of models the user's plan already covers are folded
  // away, not deleted — this reveals them. Off by default, because the whole
  // point is that the paid entry is the one to pick.
  const [showSuperseded, setShowSuperseded] = useState(false);
  const groups = useMemo(() => {
    const by = new Map<string, { shown: ModelOption[]; hidden: ModelOption[] }>();
    for (const m of models) {
      const k = m.provider ?? "claude code";
      if (!by.has(k)) by.set(k, { shown: [], hidden: [] });
      // The currently-selected model is never folded away: if the user is
      // already on it, a row that silently disappears from under them is the
      // mystery this feature exists to remove.
      const isCurrent = !!model && m.name === model.name && (m.provider ?? "") === (model.provider ?? "");
      if (m.supersededBy && !isCurrent) by.get(k)!.hidden.push(m);
      else by.get(k)!.shown.push(m);
    }
    return [...by.entries()];
  }, [models, model]);

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg pl-2.5 pr-2 py-1.5 text-[12px] hermes-mono max-w-[220px]"
        style={{ background: "rgba(255,230,203,0.06)", border: `1px solid ${HAIR}`, color: CREAM }}
      >
        <LogoChip src={model ? brandLogo(model.name) : null} size={15} />
        <span className="truncate">{model ? shortModel(model.name) : "…"}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: "rgba(255,230,203, 0.75)" }} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute left-0 top-full mt-2 z-50 w-[300px] max-h-[52vh] overflow-y-auto rounded-xl py-1"
            style={{
              background: "rgba(6,24,23,0.98)",
              border: `1px solid rgba(255,230,203,0.2)`,
              boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
              backdropFilter: "blur(12px)",
            }}
          >
            {groups.map(([provider, { shown, hidden }]) => (
              <div key={provider}>
                <div
                  className="flex items-center gap-2 px-3 pt-2.5 pb-1 text-[11px] uppercase tracking-[0.2em] hermes-mono"
                  style={{ color: "rgba(255,230,203, 0.62)" }}
                >
                  <LogoChip src={PROVIDER_LOGOS[provider.toLowerCase()] ?? null} size={13} />
                  {provider}
                </div>
                {/* The one quiet line. A row vanishing from a list with no
                    explanation is worse than the duplicate it removed, so the
                    count, the payer and a way back are all stated. */}
                {hidden.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowSuperseded((v) => !v)}
                    className="block w-full px-3 pb-1 text-left text-[10.5px] hermes-mono"
                    style={{ color: "rgba(255,230,203, 0.45)" }}
                  >
                    {showSuperseded
                      ? "hide the metered duplicates again"
                      : `${supersededNote(hidden.length, hidden[0].supersededBy ?? "a plan you already pay for")} · show`}
                  </button>
                )}
                {(showSuperseded ? [...shown, ...hidden] : shown).map((m) => {
                  const key = `${m.provider ?? ""}/${m.name}`;
                  const active = model && key === `${model.provider ?? ""}/${model.name}`;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => {
                        onPick(key);
                        setOpen(false);
                      }}
                      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors"
                      style={{
                        background: active ? "rgba(255,230,203,0.1)" : "transparent",
                        fontFamily: MD_SANS,
                      }}
                      onMouseEnter={(e) => {
                        if (!active) e.currentTarget.style.background = "rgba(255,230,203,0.05)";
                      }}
                      onMouseLeave={(e) => {
                        if (!active) e.currentTarget.style.background = active ? "rgba(255,230,203,0.1)" : "transparent";
                      }}
                    >
                      <LogoChip src={brandLogo(m.name)} size={16} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px]" style={{ color: CREAM }}>
                          {shortModel(m.name)}
                        </span>
                        {backend === "claude" && modelDesc(m.name) && (
                          <span
                            className="block truncate text-[10.5px]"
                            style={{ color: "rgba(255,230,203, 0.62)" }}
                          >
                            {modelDesc(m.name)}
                          </span>
                        )}
                      </span>
                      {/* A revealed duplicate must never look like the paid
                          one. It is the same model on someone else's meter. */}
                      {m.supersededBy && (
                        <span
                          className="hermes-mono shrink-0 rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em]"
                          style={{ border: "1px solid rgba(255,230,203,0.3)", color: "rgba(255,230,203,0.6)" }}
                        >
                          metered
                        </span>
                      )}
                      {/* The one model the whole OS defaults to — worth saying
                          out loud in the list rather than implying by order. */}
                      {m.name === "claude-opus-5" && (
                        <span
                          className="hermes-mono shrink-0 rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em]"
                          style={{ border: `1px solid ${CLAUDE_ORANGE}66`, color: CLAUDE_ORANGE }}
                        >
                          flagship
                        </span>
                      )}
                      {active && (
                        <span className="hermes-mono text-[10.5px]" style={{ color: AMBER }}>
                          ●
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
            {/* Effort dial — sticky footer of the picker; hidden for models
                with no reasoning knob. */}
            {showEffort && (
            <div
              className="sticky bottom-0 mt-1 px-3 pt-2 pb-2.5"
              style={{ background: "rgba(6,24,23,0.98)", borderTop: `1px solid ${HAIR_SOFT}` }}
            >
              <div
                className="pb-1.5 text-[11px] uppercase tracking-[0.2em] hermes-mono"
                style={{ color: "rgba(255,230,203, 0.62)" }}
              >
                Effort
              </div>
              <div className="flex gap-1">
                {effortChoices.map((lvl) => {
                  const active = (effortChoices.includes(effort) ? effort : effortChoices[0]) === lvl;
                  return (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => onEffort(lvl)}
                    className="flex-1 rounded-md px-1 py-1 text-[11px] hermes-mono uppercase tracking-wide transition-colors"
                    style={{
                      border: `1px solid ${active ? AMBER : HAIR}`,
                      color: active ? AMBER : "rgba(255,230,203,0.6)",
                      background: active ? "rgba(255,210,30,0.08)" : "transparent",
                    }}
                  >
                    {lvl}
                  </button>
                  );
                })}
              </div>
            </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── One self-contained chat pane (its own backend, model, session, stream) ──
function ChatPane({
  paneIndex,
  focused,
  showClose,
  onFocus,
  onClose,
  onStreamText,
  onSessionsChanged,
  loadReq,
}: {
  paneIndex: number;
  focused: boolean;
  showClose: boolean;
  onFocus: () => void;
  onClose: () => void;
  onStreamText: (text: string) => void;
  onSessionsChanged: () => void;
  loadReq: { nonce: number; backend: BackendId; sessionId: string; title: string; model?: string; toolMode?: ToolMode } | null;
}) {
  const [backend, setBackend] = useState<BackendId>("hermes");
  const modelsQ = useBackendModels(backend);
  const [modelKey, setModelKey] = useState<string>("");
  useEffect(() => {
    setModelKey("");
    setExtraModels([]);
  }, [backend]);
  // Models the catalog doesn't list but this pane is nonetheless using — a
  // failover target, most often. Merged in so the chip, the logo, the
  // remembered model and the next turn's request all follow the real model.
  const [extraModels, setExtraModels] = useState<ModelOption[]>([]);
  const models = [
    ...(modelsQ.data ?? (backend === "claude" ? CLAUDE_FALLBACK : [])),
    ...extraModels,
  ];
  // Resolving the pick is where the money actually moves, so the metered twin
  // is stepped over twice here:
  //   • the DEFAULT (models[0]) — the Hermes catalog opens with the metered
  //     `openai` group, so a fresh chat's first turn was billed to a vendor for
  //     a model the user's ChatGPT plan covers, without anyone picking it.
  //   • a REMEMBERED key from before this rule existed, which would otherwise
  //     keep paying twice forever.
  // In both cases the paid entry for the same model is chosen instead; if there
  // isn't one (the paid lane is unhealthy) nothing is marked and this is a
  // no-op.
  const preferPaid = (m: ModelOption | undefined | null): ModelOption | null => {
    if (!m) return null;
    if (!m.supersededBy) return m;
    const id = modelIdentity(m.name);
    return models.find((c) => !c.supersededBy && modelIdentity(c.name) === id) ?? m;
  };
  const model =
    preferPaid(models.find((m) => `${m.provider ?? ""}/${m.name}` === modelKey)) ??
    preferPaid(models.find((m) => !m.supersededBy)) ??
    models[0] ??
    null;
  const backendCfg = BACKENDS.find((b) => b.id === backend)!;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  useEffect(() => {
    if (paneIndex !== 0) return;
    try {
      const draft = sessionStorage.getItem("website-os.agent-request.v1");
      if (draft && draft.length <= 12000) {
        setInput(draft);
        sessionStorage.removeItem("website-os.agent-request.v1");
      }
    } catch { /* The normal composer works without storage. */ }
  }, [paneIndex]);

  const [sending, setSending] = useState(false);
  const [activity, setActivity] = useState<string>("");
  const [loadingSession, setLoadingSession] = useState(false);
  // Default "high", not "medium". This dial sets MAX_THINKING_TOKENS on the
  // child (medium = 10,000; high = 20,000; xhigh = 31,999), and the terminal
  // sets no cap at all — so the OS was quietly giving every chat LESS room to
  // think than the same model gets from a plain `claude` prompt. On taste-heavy
  // work (design, art direction, copy) that difference is the whole output, and
  // nothing on screen said the reasoning had been capped. A fresh window should
  // start at the setting the work actually needs; turning it DOWN to save
  // tokens is a deliberate choice, not a default someone inherits unknowingly.
  const [effort, setEffort] = useState<EffortLevel>("high");
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const [lastCost, setLastCost] = useState<string | null>(null);
  // Set to the lane's name when a turn ends with no cost figure at all. The
  // ccr → OpenRouter lane does this whenever its last provider call errors:
  // the harness prints `total_cost_usd: 0`, which is not "free", it is "we
  // never got told". Rendered as "$—", never as $0.0000.
  const [costUnreported, setCostUnreported] = useState<string | null>(null);
  // What the harness reported it loaded into the window (`ctx_manifest`, sent
  // on the CLI's system/init) and what the API actually billed as prompt
  // (`ctx_usage`, sent on the turn's result). Together they drive the context
  // breakdown behind the ctx pill.
  const [ctxManifest, setCtxManifest] = useState<CtxManifest | null>(null);
  const [ctxUsage, setCtxUsage] = useState<CtxUsage | null>(null);
  // Approval stance for this chat: cards for everything (Claude's default),
  // cards for everything but file edits, or no cards at all.
  const [toolMode, setToolMode] = useState<ToolMode>("ask");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const sessionRef = useRef<Partial<Record<BackendId, string>>>({});
  // Stable identity for this CHAT (not this turn, and not the CLI's session id
  // — that doesn't exist until the first turn's `init` line). The approvals
  // server keys pending cards and "don't ask again" grants on it.
  const chatIdRef = useRef<string>(crypto.randomUUID());
  const abortRef = useRef<AbortController | null>(null);
  // The composer's height changes with state (sending banner, attachments, a
  // grown textarea, the telemetry strip wrapping onto two lines). The thread's
  // bottom padding tracks it so the newest message is never hidden underneath.
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [composerH, setComposerH] = useState(176);
  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const h = Math.round(entry.contentRect.height);
      // Ignore sub-pixel churn — this drives layout.
      setComposerH((prev) => (Math.abs(prev - h) > 2 ? h : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const threadRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Auto-grow the composer with the prompt — up to ~10 lines, then scroll.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 230)}px`;
  }, [input]);
  const lastLoadNonce = useRef(0);
  const firstUserTextRef = useRef<string>("");
  // Model to re-select once the backend's model list arrives (chat restore).
  const pendingModelRef = useRef<string | null>(null);
  useEffect(() => {
    const want = pendingModelRef.current;
    if (!want || models.length === 0) return;
    const hit = models.find((m) => m.name === want);
    if (hit) {
      setModelKey(`${hit.provider ?? ""}/${hit.name}`);
      pendingModelRef.current = null;
    }
  }, [models]);

  // A rail click targets the focused pane via loadReq.
  useEffect(() => {
    if (!loadReq || loadReq.nonce === lastLoadNonce.current) return;
    lastLoadNonce.current = loadReq.nonce;
    if (loadReq.backend === "hermes") {
      void (async () => {
        if (sending) return;
        setLoadingSession(true);
        try {
          const res = await fetch(`/__hermes_session?id=${encodeURIComponent(loadReq.sessionId)}`);
          if (!res.ok) throw new Error(`status ${res.status}`);
          const j = (await res.json()) as {
            sessionId: string;
            messages: Array<{ role: string; content: string; ts: string | null }>;
          };
          setBackend("hermes");
          sessionRef.current.hermes = j.sessionId;
          setMessages(
            j.messages
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m, i) => ({
                id: `${j.sessionId}-${i}`,
                role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
                content: m.content,
              })),
          );
        } catch {
          /* keep pane as-is */
        } finally {
          setLoadingSession(false);
        }
      })();
    } else {
      // Claude Code writes session transcripts to ~/.claude/projects — read
      // the real history back, and restore the model the chat was using.
      setBackend("claude");
      sessionRef.current.claude = loadReq.sessionId;
      // A resumed chat keeps its identity, so "don't ask again" grants and any
      // still-pending cards from a detached run find their way back here.
      chatIdRef.current = loadReq.sessionId;
      if (loadReq.model) pendingModelRef.current = loadReq.model;
      if (loadReq.toolMode) setToolMode(loadReq.toolMode);
      void (async () => {
        setLoadingSession(true);
        try {
          const res = await fetch(`/__claude_session?id=${encodeURIComponent(loadReq.sessionId)}`);
          if (!res.ok) throw new Error(`status ${res.status}`);
          const j = (await res.json()) as { messages: Array<{ role: string; content: string }> };
          if (j.messages.length > 0) {
            setMessages(
              j.messages.map((m, i) => ({
                id: `${loadReq.sessionId}-${i}`,
                role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
                content: m.content,
              })),
            );
            return;
          }
          throw new Error("empty");
        } catch {
          setMessages([
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: `Resumed "${loadReq.title}" — the context is carried, ask away.`,
            },
          ]);
        } finally {
          setLoadingSession(false);
          // If this chat's child is still working, re-join it rather than
          // presenting a finished-looking transcript of a live conversation.
          try {
            const live = (await fetch("/__sessions_live").then((r) => r.json())) as {
              runs: Array<{ chatId: string; sessionId: string }>;
            };
            const hit = live.runs.find(
              (r) => r.chatId === loadReq.sessionId || r.sessionId === loadReq.sessionId,
            );
            if (hit) void attachLive(hit.chatId);
          } catch {
            /* no live-run info — the transcript stands on its own */
          }
        }
      })();
    }
  }, [loadReq, sending]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activity]);

  async function uploadFile(file: File): Promise<Attachment | null> {
    setUploading(true);
    try {
      const t = await fetch("/__token").then((r) => r.json());
      const res = await fetch("/__hermes_image_upload", {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
          "X-Claude-OS-Token": t.token,
        },
        body: file,
      });
      if (!res.ok) throw new Error(`upload failed: ${res.status}`);
      const j = (await res.json()) as { path: string };
      const isImage = file.type.startsWith("image/");
      const preview = isImage
        ? await new Promise<string>((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result ?? ""));
            r.readAsDataURL(file);
          })
        : "";
      return { path: j.path, name: file.name, preview, kind: isImage ? "image" : "file", size: file.size };
    } catch {
      return null;
    } finally {
      setUploading(false);
    }
  }

  async function handleFiles(files: FileList | File[] | null) {
    if (!files) return;
    const arr = Array.from(files);
    if (arr.length === 0) return;
    const uploaded = await Promise.all(arr.map(uploadFile));
    setAttachments((prev) => [...prev, ...(uploaded.filter(Boolean) as Attachment[])]);
  }

  function newChat() {
    if (sending) return;
    setMessages([]);
    setAttachments([]);
    // Last chat's window inventory says nothing about this one — a stale
    // baseline would have the pill claiming 40k used on an empty transcript.
    setCtxManifest(null);
    setCtxUsage(null);
    sessionRef.current[backend] = undefined;
    // Fresh chat, fresh approval identity — "don't ask again" never leaks
    // from one conversation into the next.
    chatIdRef.current = crypto.randomUUID();
  }

  // Answer one approval card. The server holds the CLI's tool call open until
  // this lands, so the optimistic local update and the POST must agree.
  async function decidePermission(card: PermissionCard, d: "allow" | "always" | "deny", message?: string) {
    setMessages((m) =>
      m.map((msg) =>
        msg.permission?.id === card.id ? { ...msg, permission: { ...msg.permission, outcome: d } } : msg,
      ),
    );
    try {
      const t = await fetch("/__token").then((r) => r.json());
      await fetch("/__permission_decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-OS-Token": t.token },
        body: JSON.stringify({ id: card.id, decision: d, message, scope: card.scope }),
      });
    } catch {
      /* the server's own 10-minute timeout is the backstop */
    }
  }

  // Answer one question card. Same contract as decidePermission: the CLI's call
  // is parked on the server until this lands.
  async function answerQuestion(card: QuestionCard, picks: string[][]) {
    setMessages((m) =>
      m.map((msg) =>
        msg.question?.id === card.id
          ? { ...msg, question: { ...msg.question, outcome: "answered" as const, picked: picks } }
          : msg,
      ),
    );
    try {
      const t = await fetch("/__token").then((r) => r.json());
      await fetch("/__question_answer", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-OS-Token": t.token },
        body: JSON.stringify({
          id: card.id,
          answers: card.questions.map((q, i) => ({
            header: q.header,
            question: q.question,
            answers: picks[i] ?? [],
          })),
        }),
      });
    } catch {
      /* the server's own 10-minute timeout is the backstop */
    }
  }

  // Hermes' effort knob is global config (re-read per message) — push the
  // dial server-side when it changes. Claude's rides along in the request.
  function pickEffort(lvl: EffortLevel) {
    setEffort(lvl);
    if (backend === "hermes") {
      void (async () => {
        try {
          const t = await fetch("/__token").then((r) => r.json());
          await fetch("/__hermes_effort", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Claude-OS-Token": t.token },
            body: JSON.stringify({ effort: lvl }),
          });
        } catch {
          /* dial stays optimistic */
        }
      })();
    }
  }

  // Live usage readout — chars/4 across the visible thread (recomputed every
  // streamed chunk, so it counts up in real time) vs the model's real
  // context window from the live catalog. An estimate, not billing truth.
  const ctxMapQ = useCtxMap();
  const paneLive = useLiveData() as any;
  const [usageOpen, setUsageOpen] = useState(false);
  // Slash-command autocomplete — opens the moment input starts with "/".
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const customCmdsQ = useQuery<{ commands: Array<{ name: string; description: string }> }>({
    queryKey: ["claude-commands"],
    queryFn: async () => {
      const r = await fetch("/__claude_commands");
      if (!r.ok) throw new Error(`status ${r.status}`);
      return r.json();
    },
    enabled: backend === "claude",
    staleTime: 5 * 60_000,
    retry: 0,
  });
  // Which wallet this model bills: ccr → OpenRouter credit, codex → ChatGPT
  // plan, everything else → the Claude subscription.
  // Which account pays for this turn — from the shared module, so the pane and
  // the server cannot disagree about it. PROVIDER FIRST: `gpt-5.6-sol` exists
  // on the user's ChatGPT OAuth and on a metered vendor with the same id, and
  // the name alone is a coin flip between them. The name stays only as the
  // fallback for a failover target grafted on mid-turn, which has no provider.
  const lane = model ? laneFor(model.name, model.provider) : "sub";
  // Model-aware capability flags — the chips only show what the SELECTED
  // model/lane can actually do. Permission modes are a Claude-CLI feature
  // (sub + ccr lanes); the effort dial needs real reasoning support; Codex
  // has no "thinking off", so its dial starts at low.
  const canPermMode = backend === "claude" && lane !== "codex";
  const canEffort =
    backend !== "claude" || lane !== "ccr" || supportsReasoning(model?.name ?? "", ctxMapQ.data);
  const effortLevels: readonly EffortLevel[] =
    lane === "codex" && backend === "claude" ? (["low", "medium", "high", "xhigh"] as const) : EFFORT_LEVELS;
  const effortShown: EffortLevel = effortLevels.includes(effort) ? effort : effortLevels[0];
  const orCreditsQ = useQuery<{ remaining: number }>({
    queryKey: ["openrouter-credits"],
    queryFn: async () => {
      const r = await fetch("/__openrouter_credits");
      if (!r.ok) throw new Error(`status ${r.status}`);
      return r.json();
    },
    enabled: lane === "ccr" && usageOpen,
    staleTime: 5 * 60_000,
    retry: 0,
  });

  // Slash-command catalog for this lane + live matches for the menu.
  const slashCommands = (() => {
    const base = [
      { name: "/new", description: "Start a fresh chat" },
      { name: "/help", description: "What works here" },
    ];
    if (backend === "claude" && lane !== "codex") {
      base.push({ name: "/compact", description: "Compact this session's context" });
      for (const c of customCmdsQ.data?.commands ?? [])
        if (!base.some((b) => b.name === c.name)) base.push(c);
    }
    return base;
  })();
  const slashQuery = input.startsWith("/") && !/\s/.test(input) ? input.toLowerCase() : null;
  const slashMatches =
    slashQuery && !slashDismissed
      ? slashCommands.filter((c) => c.name.toLowerCase().startsWith(slashQuery)).slice(0, 8)
      : [];
  const slashOpen = slashMatches.length > 0;
  const slashSel = slashMatches[Math.min(slashIdx, Math.max(0, slashMatches.length - 1))];

  // Plan mode — orthogonal to the approval stance in the pane header (which
  // now owns ask / auto-accept edits / yolo), so this picker is down to the two
  // choices that aren't about permissions: work normally, or plan first.
  const [permMode, setPermMode] = useState<"default" | "plan">("default");
  // Autopilot — when a turn ends, the pane itself sends the next "continue"
  // so long agentic builds keep rolling without the user driving. Capped per
  // engagement; any manual send resets the cap. Stops on errors, on "BLOCKED",
  // or when the agent ends with a question for the human.
  const [autoPilot, setAutoPilot] = useState(false);
  const autoPilotRef = useRef(false);
  const autoCountRef = useRef(0);
  const lastBotTextRef = useRef("");
  const sawErrorRef = useRef<string | null>(null);
  const [permOpen, setPermOpen] = useState(false);
  const PERM_LABELS: Record<string, string> = {
    default: "Normal",
    plan: "Plan",
  };


  // A card still on screen means the run is parked on the user, not thinking —
  // the harness bar says so, and the queue can't fire while the turn is held.
  const awaitingApproval = messages.some(
    (m) => (m.permission && !m.permission.outcome) || (m.question && !m.question.outcome),
  );
  // Which of the two it is — the harness bar should name the thing on screen.
  const awaitingQuestion = messages.some((m) => m.question && !m.question.outcome);
  // Transcript-only estimate (chars ÷ 4 — see TOKENS_PER_CHAR). The full
  // breakdown adds the harness's own baseline on top of it.
  const approxTokens = messages.reduce(
    (a, m) => a + estTextTokens(m.content) + estTextTokens(m.segments?.join("") ?? ""),
    0,
  );
  const ctxTokens = model ? ctxFor(model.name, ctxMapQ.data) : 262_144;
  const ctxBreakdown = useMemo(
    () =>
      buildCtxBreakdown({
        manifest: ctxManifest,
        usage: ctxUsage,
        messageTokens: approxTokens,
        limit: ctxTokens,
      }),
    [ctxManifest, ctxUsage, approxTokens, ctxTokens],
  );
  // The pill reflects EVERYTHING in the window, not just the transcript — the
  // old "≈2%" on a fresh chat was hiding ~40k of system prompt and tools.
  const ctxUsedTokens = ctxBreakdown.used;
  const ctxPct = Math.min(100, Math.round((ctxUsedTokens / ctxTokens) * 100));
  // One pressure ladder for every context readout — the same teal → amber →
  // coral the plan-usage bars use, so the live strip and the ctx pill can
  // never disagree about how full the window is.
  const ctxTone = ctxPct > 80 ? "#ff9d8f" : ctxPct > 55 ? AMBER : "#7be0c8";
  // Tooltip text shared by the strip meter and the pill: the precise numbers,
  // and honest about which of them is measured. `reported === null` means the
  // harness has not billed a prompt count yet and the figure is chars ÷ 4.
  const ctxTitle = `${ctxBreakdown.reported === null ? "≈" : ""}${ctxUsedTokens.toLocaleString()} of ~${ctxTokens.toLocaleString()} context tokens · ${ctxPct}% full${
    ctxBreakdown.reported === null
      ? ctxBreakdown.unreportedLane
        ? // The lane answered and then reported nothing — a different thing
          // from "hasn't finished a turn yet", and worth naming, because it is
          // usually the tell that the turn's last provider call errored.
          ` (estimated — the ${ctxBreakdown.unreportedLane} lane reported no token count for the last turn)`
        : " (estimated — no prompt count from the harness yet)"
      : " (counted by the harness)"
  } — click for the breakdown`;

  // Send-while-working — messages typed mid-turn queue up (visibly, never
  // interrupting the run) and fire the moment the current turn ends,
  // mirroring Claude Code's own mid-turn message behavior.
  const sendingRef = useRef(false);
  const queueRef = useRef<Array<{ id: string; text: string; prefix: string }>>([]);
  const turnStartRef = useRef(0);
  // Live telemetry for the in-flight message's status strip. A ref, not state:
  // the strip re-renders itself once a second, and putting a clock in this
  // component's state would re-render the whole transcript on every tick.
  const liveRef = useRef<LiveTurn>(freshLiveTurn(0));
  const turnTokBaseRef = useRef(0);
  // Seconds the CURRENT step has been running, which is a different number from
  // the turn's age and the more useful one. A turn that has been going twelve
  // minutes while steps tick past every few seconds is healthy; a turn at the
  // same twelve minutes stuck on one `codex exec` is not, and the turn timer
  // cannot tell you which you are looking at. Watching a frozen transcript with
  // only a total climbing reads as a crash — so name the stall.
  //
  // Both clocks used to be component STATE driven by a 1s interval here, which
  // meant every second re-rendered this whole pane — transcript, every message
  // body, every code block — for the sake of two changing digits. They are refs
  // now, and the handful of leaves that actually display a clock tick
  // themselves via useSecondHand().
  const stepStartRef = useRef(Date.now());
  useEffect(() => {
    stepStartRef.current = Date.now();
  }, [activity]);
  function cancelQueued(id: string) {
    queueRef.current = queueRef.current.filter((q) => q.id !== id);
    setMessages((m) => m.filter((msg) => msg.id !== id));
  }

  // The SSE vocabulary both /__claude_chat and /__claude_attach speak, pumped
  // into one assistant bubble. Shared between the two on purpose: re-joining a
  // run that started in another tab has to be the same experience as having
  // started it here, down to the tool steps and the approval cards.
  async function pumpStream(
    body: ReadableStream<Uint8Array>,
    botId: string,
    onText?: (t: string) => void,
  ): Promise<{ error: string | null; terminal: boolean }> {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawError: string | null = null;
      // `done` and `error` are the server's only terminals. A stream that ends
      // without one did not finish — the server went away underneath it, which
      // is exactly what an SSR reload does. Nothing used to record that, so a
      // turn the dev server killed rendered as a completed reply that simply
      // stopped mid-sentence: identical on screen to a hang, and the honest
      // response to a hang (wait) is the wrong one here.
      let sawTerminal = false;
      const appendBot = (chunk: string) =>
        setMessages((m) =>
          m.map((msg) => (msg.id === botId ? { ...msg, content: msg.content + chunk } : msg)),
        );
      // "Something arrived" vs "something arrived that MEANS something". The
      // server's 15s `:keepalive` comment proves the stream is alive but says
      // nothing about the model; real output is what tells you work is
      // happening. The strip needs both clocks to tell a hard think apart
      // from a dead child.
      const markOutput = (phase?: LiveTurn["phase"]) => {
        liveRef.current.lastEventAt = Date.now();
        if (phase) {
          liveRef.current.phase = phase;
          // Real model output — text, a tool call, a thought — is the proof
          // that the resumed session actually took over. "reconnecting" ends
          // here, not when the resume was merely requested.
          liveRef.current.recovering = false;
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        // Set BEFORE the done check: keepalives land here too, and this is the
        // only heartbeat the client can observe.
        liveRef.current.lastByteAt = Date.now();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const evt of events) {
          let eventName = "chunk";
          const dataLines: string[] = [];
          for (const line of evt.split("\n")) {
            if (line.startsWith("event: ")) eventName = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
          }
          const data = stripAnsi(dataLines.join("\n"));
          if (eventName === "chunk" && data.length > 0) {
            markOutput("text");
            appendBot(data + "\n");
            onText?.(data + "\n");
            onStreamText(data);
          } else if (eventName === "tool" && data) {
            // The structured twin of the "⚙ Bash: …" info line. Parsing the
            // label back apart would break on any target containing a colon,
            // which is most shell commands — so the server sends fields.
            markOutput("tool");
            try {
              const t = JSON.parse(data) as { name?: string; target?: string };
              liveRef.current.tool = {
                name: String(t.name ?? "tool"),
                target: String(t.target ?? ""),
              };
            } catch {
              liveRef.current.tool = { name: "tool", target: "" };
            }
            liveRef.current.toolStartedAt = Date.now();
            liveRef.current.tools += 1;
          } else if (eventName === "cost_unreported" && data) {
            // This lane closed the turn without a cost. Say so; never $0.0000.
            setLastCost(null);
            setCostUnreported(data.trim());
          } else if (eventName === "seg") {
            markOutput();
            // New narration segment: bank the current one into the trace and
            // start clean — only the final segment survives as the reply.
            setMessages((m) =>
              m.map((msg) =>
                msg.id === botId && msg.content.trim()
                  ? { ...msg, segments: [...(msg.segments ?? []), msg.content], content: "" }
                  : msg,
              ),
            );
          } else if (eventName === "think" && data) {
            markOutput("thinking");
            // Live reasoning stream — shown in the working panel while the
            // model thinks, kept on the message for the expandable trace.
            setMessages((m) =>
              m.map((msg) =>
                msg.id === botId
                  ? { ...msg, thinking: ((msg.thinking ?? "") + data + "\n").slice(-12_000) }
                  : msg,
              ),
            );
          } else if (eventName === "info" && data) {
            markOutput();
            const mm = data.match(/session_id:\s*([A-Za-z0-9_-]{6,})/);
            if (mm?.[1]) {
              sessionRef.current[backend] = mm[1];
              if (backend === "claude") {
                rememberClaudeChat({
                  id: mm[1],
                  title: cleanTitle(firstUserTextRef.current).slice(0, 60),
                  ts: Date.now(),
                  model: model?.name,
                  toolMode,
                });
                onSessionsChanged();
              }
            }
            const cm = data.match(/cost_usd:\s*([0-9.]+)/);
            if (cm?.[1]) {
              setLastCost(cm[1]);
              setCostUnreported(null);
            }
            const line = data.split("\n").find((l) => l.trim().length > 3);
            if (line && !/session_id/.test(line)) {
              setActivity(line.trim().slice(0, 120));
              // Harness steps (tool calls ⚙ / compactions ⚡) persist on the
              // message so the work stays inspectable after the reply lands.
              if (/^[⚙⚡]/.test(line.trim())) {
                const step = line.trim().slice(0, 140);
                setMessages((m) =>
                  m.map((msg) =>
                    msg.id === botId ? { ...msg, steps: [...(msg.steps ?? []), step].slice(-30) } : msg,
                  ),
                );
              }
            }
          } else if (eventName === "model_used" && data) {
            setMessages((m) =>
              m.map((msg) => (msg.id === botId ? { ...msg, actualModel: data.trim() } : msg)),
            );
          } else if (eventName === "ctx_manifest" && data) {
            // The harness' own inventory of what's resident in the window.
            try {
              setCtxManifest(JSON.parse(data) as CtxManifest);
            } catch {
              /* a missing breakdown is not worth breaking the stream over */
            }
          } else if (eventName === "ctx_usage" && data) {
            try {
              setCtxUsage(JSON.parse(data) as CtxUsage);
            } catch {
              /* ditto */
            }
          } else if (eventName === "router_mismatch" && data) {
            // The router will answer some categories with a different model.
            // Say so before the reply lands, not after the user notices.
            try {
              const rm = JSON.parse(data) as ChatMessage["routerMismatch"];
              setMessages((m) => {
                const at = m.findIndex((msg) => msg.id === botId);
                const card: ChatMessage = {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "",
                  routerMismatch: rm,
                };
                if (at < 0) return [...m, card];
                return [...m.slice(0, at), card, ...m.slice(at)];
              });
            } catch {
              /* nothing to warn about */
            }
          } else if (eventName === "failover" && data) {
            // The turn is continuing on a different model. Say so in the
            // thread and move the pane's own chip, so the header never claims
            // a model that isn't the one answering.
            try {
              const f = JSON.parse(data) as { from: string; to: string; reason: string };
              setMessages((m) => {
                const at = m.findIndex((msg) => msg.id === botId);
                const note: ChatMessage = {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "",
                  note: `⚠ failed over ${shortModel(f.from)} → ${shortModel(f.to)} (${f.reason})`,
                };
                if (at < 0) return [...m, note];
                return [...m.slice(0, at), note, ...m.slice(at)];
              });
              // The failover target may not be in this backend's catalog (a
              // ccr model while the picker lists the Anthropic lane, say) —
              // graft it on so the chip, logo and next turn all agree.
              const known = models.find((mm) => mm.name === f.to);
              if (!known) setExtraModels((prev) => [...prev, { name: f.to }]);
              setModelKey(`${known?.provider ?? ""}/${f.to}`);
            } catch {
              /* a malformed note is not worth breaking the stream over */
            }
          } else if (eventName === "resume" && data) {
            // The turn ended without finishing and the server is continuing it
            // in the same session. Deliberately NOT a thread note: this is meant
            // to read as one continuous answer, not as an incident. The strip
            // says "reconnecting 2/5" while it happens and the finished header
            // discloses the count afterwards.
            try {
              const r = JSON.parse(data) as { attempt: number; max: number; reason: string };
              liveRef.current.resumes = r.attempt;
              liveRef.current.maxResumes = r.max || 5;
              liveRef.current.recovering = true;
              liveRef.current.lastEventAt = Date.now();
              setActivity(`reconnecting ${r.attempt}/${r.max} — ${r.reason}`);
              setMessages((m) =>
                m.map((msg) => (msg.id === botId ? { ...msg, resumes: r.attempt } : msg)),
              );
            } catch {
              liveRef.current.recovering = true;
            }
          } else if (eventName === "turn_note" && data) {
            // A fact about this chat that must survive the turn — currently
            // only "your last turn was killed by a server restart". Pinned as
            // its own chip rather than an activity line, because the activity
            // line is overwritten by the next event and the whole defect this
            // reports is a turn disappearing without a trace.
            markOutput();
            setMessages((m) => {
              const at = m.findIndex((msg) => msg.id === botId);
              const note: ChatMessage = {
                id: crypto.randomUUID(),
                role: "assistant",
                content: "",
                note: data,
              };
              if (at < 0) return [...m, note];
              return [...m.slice(0, at), note, ...m.slice(at)];
            });
          } else if (eventName === "files_written" && data) {
            // Files this turn claimed to write AND that the server then found
            // on disk, with their real size. "Saved to your Desktop as Kola
            // Deck.html" was true and unverifiable; this is the verified half,
            // with a link, so nobody has to go hunting for a file that exists.
            try {
              const files = JSON.parse(data) as WrittenFile[];
              if (Array.isArray(files) && files.length)
                setMessages((m) =>
                  m.map((msg) => (msg.id === botId ? { ...msg, files } : msg)),
                );
            } catch {
              /* the reply itself still names the paths — a missing link is not
                 worth breaking the stream over */
            }
          } else if (eventName === "resumed_total" && data) {
            const n = Number(data.trim());
            if (Number.isFinite(n) && n > 0)
              setMessages((m) => m.map((msg) => (msg.id === botId ? { ...msg, resumes: n } : msg)));
          } else if (eventName === "recovery_exhausted") {
            // Automatic recovery is spent. From here the loud stall states are
            // honest again, because nothing is coming to fix it — and the
            // reason goes in the thread as a note, not just into the activity
            // line where it vanishes the moment the turn ends.
            liveRef.current.recovering = false;
            liveRef.current.recoveryExhausted = true;
            try {
              const r = JSON.parse(data) as { stopReason?: string; message?: string };
              if (r.message)
                setMessages((m) => {
                  const at = m.findIndex((msg) => msg.id === botId);
                  const note: ChatMessage = {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    content: "",
                    note: r.message,
                  };
                  if (at < 0) return [...m, note];
                  return [...m.slice(0, at), note, ...m.slice(at)];
                });
            } catch {
              /* older payload was a bare reason string — the flag above is the
                 part that matters */
            }
          } else if (eventName === "permission" && data) {
            // The CLI wants to run a tool. Drop the card ABOVE the streaming
            // bubble so the reply keeps growing underneath once it's answered.
            try {
              const card = JSON.parse(data) as PermissionCard;
              setMessages((m) => {
                const at = m.findIndex((msg) => msg.id === botId);
                const bubble: ChatMessage = {
                  id: `perm-${card.id}`,
                  role: "assistant",
                  content: "",
                  permission: card,
                };
                if (at < 0) return [...m, bubble];
                return [...m.slice(0, at), bubble, ...m.slice(at)];
              });
            } catch {
              /* malformed card — the server's timeout still frees the CLI */
            }
          } else if (eventName === "question" && data) {
            // The agent is asking US something. Same placement as an approval
            // card — above the streaming bubble, which keeps growing under it
            // once the answer goes back.
            try {
              const card = JSON.parse(data) as QuestionCard;
              setMessages((m) => {
                const at = m.findIndex((msg) => msg.id === botId);
                const bubble: ChatMessage = {
                  id: `ask-${card.id}`,
                  role: "assistant",
                  content: "",
                  question: card,
                };
                if (at < 0) return [...m, bubble];
                return [...m.slice(0, at), bubble, ...m.slice(at)];
              });
            } catch {
              /* malformed card — the server's timeout still frees the CLI */
            }
          } else if (eventName === "permission_done" && data) {
            // Settled somewhere other than this tab (timeout, always-grant,
            // the turn ending) — reflect it so no card sits live forever.
            try {
              const { id, outcome } = JSON.parse(data) as { id: string; outcome: string };
              setMessages((m) =>
                m.map((msg) => {
                  // Question cards settle through the same server-side path,
                  // so they reconcile here too.
                  if (msg.question?.id === id && !msg.question.outcome)
                    return {
                      ...msg,
                      question: {
                        ...msg.question,
                        outcome: outcome === "answered" ? ("answered" as const) : outcome === "timeout" ? ("timeout" as const) : ("abandoned" as const),
                      },
                    };
                  if (msg.permission?.id === id && !msg.permission.outcome)
                    return {
                      ...msg,
                      permission: { ...msg.permission, outcome: outcome as PermissionCard["outcome"] },
                    };
                  return msg;
                }),
              );
            } catch {
              /* nothing to reconcile */
            }
          } else if (eventName === "error" && data) {
            sawError = data;
            sawTerminal = true;
          } else if (eventName === "done") {
            sawTerminal = true;
          }
        }
      }
    return { error: sawError, terminal: sawTerminal };
  }

  // Close out a streaming bubble: promote the last narration segment if the
  // model ended on a tool, stamp how long it took, and decide whether this was
  // a finish, a failure, or an interruption that deserves a resume chip.
  function finalizeBot(
    botId: string,
    t0: number,
    sawError: string | null,
    aborted: boolean,
    /** Did the server actually close the turn (done/error)? A stream that ends
        with neither is the server having gone away — an SSR reload tears down
        the module holding the live-run registry and SIGKILLs the child, and
        this is the only moment the browser can notice. Optional so the
        attach/replay path, which has its own ending, is unaffected. */
    terminal = true,
  ) {
    // The registry knows WHY, but only after the next boot's reaper has run and
    // only for the chat's own next turn. Right here the honest statement is the
    // one thing that is certain: the connection ended without the turn ending.
    const lostStream = !terminal && !aborted;
    setMessages((m) =>
      m.map((msg) => {
        if (msg.id !== botId) return msg;
        // If the model ended on a tool (empty live segment), promote the
        // last banked narration segment as the reply.
        let content = msg.content;
        let segments = msg.segments;
        if (!content.trim() && segments?.length) {
          content = segments[segments.length - 1];
          segments = segments.slice(0, -1);
        }
        // Autopilot reads this to decide whether to keep going: it stops on a
        // question or on BLOCKED. It used to be set by the inline reader loop
        // that pumpStream replaced, so it has to be set here or autopilot
        // decides against a stale turn.
        lastBotTextRef.current = content;
        // "Stopped mid-work" is a different animal from "failed": the work so
        // far is real and worth continuing, so it gets ↻ resume rather than a
        // dead bubble. The CLI's own marker, the watchdog's wording, and a
        // user abort all mean the same thing here.
        const interrupted =
          aborted ||
          lostStream ||
          /\[Tool use interrupted\]|\[Request interrupted/.test(`${content}${segments?.join("") ?? ""}`) ||
          (sawError != null && /went silent|stopped it|didn't respond|interrupt/i.test(sawError));
        return {
          ...msg,
          content,
          segments,
          streaming: false,
          interrupted,
          elapsedS: Math.max(1, Math.round((Date.now() - t0) / 1000)),
          ...(content.trim().length === 0
            ? {
                content:
                  sawError ??
                  (aborted
                    ? "Stopped."
                    : lostStream
                      ? "The turn ended when the connection to the agent dropped."
                      : "No reply came back."),
                error: true,
              }
            : {}),
        };
      }),
    );
    // As its own chip AFTER the bubble, never as a field on it: `note` on a
    // message replaces the message, so folding this into the reply would have
    // deleted the partial answer it exists to preserve.
    if (lostStream)
      setMessages((m) => {
        const at = m.findIndex((msg) => msg.id === botId);
        const chip: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          // Claims only what the browser can actually see: the connection ended
          // before the turn did. Whether that was a restart is the SERVER's to
          // confirm, and it does, on this chat's next turn.
          note: "⏹ the connection to the agent ended before this turn finished — a dev-server restart does this. Everything above is kept; send again to carry on.",
        };
        if (at < 0) return [...m, chip];
        return [...m.slice(0, at + 1), chip, ...m.slice(at + 1)];
      });
  }

  // Re-join a run that's already in flight — started in another tab, or in this
  // one before a reload. The server replays everything the turn has emitted so
  // far, so the thread catches up mid-sentence instead of rendering as dead.
  async function attachLive(liveChatId: string) {
    if (sendingRef.current) return false;
    // A reattached run shows the same Stop button as a live one, but this path
    // never registered an AbortController — so Stop had nothing local to tear
    // down and the replay stream kept rendering after the child was gone.
    const ac = new AbortController();
    let res: Response;
    try {
      res = await fetch(`/__claude_attach?chatId=${encodeURIComponent(liveChatId)}`, {
        signal: ac.signal,
      });
    } catch {
      return false;
    }
    abortRef.current = ac;
    if (!res.ok || !res.body) return false;
    const botId = crypto.randomUUID();
    const t0 = Date.now();
    setMessages((m) => [
      ...m,
      { id: crypto.randomUUID(), role: "assistant", content: "", note: "⇢ reattached to the run in progress" },
      { id: botId, role: "assistant", content: "", streaming: true, ts: Date.now() },
    ]);
    setSending(true);
    sendingRef.current = true;
    turnStartRef.current = t0;
    liveRef.current = freshLiveTurn(t0);
    turnTokBaseRef.current = approxTokens;
    try {
      const { error, terminal } = await pumpStream(res.body, botId);
      finalizeBot(botId, t0, error, false, terminal);
    } catch {
      // Stopping a run you were watching is not "lost the connection".
      if (ac.signal.aborted) finalizeBot(botId, t0, null, true);
      else finalizeBot(botId, t0, "Lost the connection to the run in progress.", true);
    } finally {
      setSending(false);
      sendingRef.current = false;
      setActivity("");
      if (abortRef.current === ac) abortRef.current = null;
    }
    return true;
  }

  // Mid-turn steering (⌘⏎): instead of waiting in the queue, stop the running
  // child and hand it the interjection immediately. Implemented as
  // abort-then-queue so it rides the proven queue drain — the abort is what
  // makes the turn end now, and the queued message fires the instant it does.
  async function steer() {
    const text = input.trim();
    if (!text || !sendingRef.current) return;
    const qid = crypto.randomUUID();
    queueRef.current.push({
      id: qid,
      text: `The user interjected mid-turn: ${text}. Fold this in and continue.`,
      prefix: "",
    });
    setMessages((m) => [...m, { id: qid, role: "user", content: text, queued: true, steering: true, ts: Date.now() }]);
    setInput("");
    try {
      const t = await fetch("/__token").then((r) => r.json());
      await fetch("/__claude_abort", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-OS-Token": t.token },
        body: JSON.stringify({ chatId: chatIdRef.current }),
      });
    } catch {
      /* if the abort doesn't land, the interjection still fires as a queued turn */
    }
  }

  // Stop has to reach the SERVER, not just this fetch.
  //
  // The old button did exactly one thing: `abortRef.current?.abort()`. That
  // closes the SSE stream — and the server reads a closed stream as "the browser
  // went away", so it DETACHES and runs the turn to completion headless. The
  // Stop button was, functionally, a Keep Going Without Me button: the UI said
  // Stopped while the agent carried on editing files, calling APIs and spending
  // credits, with nothing on screen to prove it. That is the whole of "I'm
  // hitting stop and it's still going on".
  //
  // Order matters: cancel server-side FIRST, then tear down the local stream.
  const [stopping, setStopping] = useState(false);
  async function stopTurn(all = false) {
    if (!sendingRef.current && !all) return;
    setStopping(true);
    // Local intent is recorded immediately so the queue-drain in `finally`
    // can't fire even if the network call is slow or fails.
    autoPilotRef.current = false;
    setAutoPilot(false);
    try {
      const t = await fetch("/__token").then((r) => r.json());
      await fetch(all ? "/__claude_abort_all" : "/__claude_abort", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-OS-Token": t.token },
        body: JSON.stringify({ chatId: chatIdRef.current }),
      });
    } catch {
      /* the local abort below still ends this stream */
    } finally {
      abortRef.current?.abort();
      setStopping(false);
    }
  }

  // Esc anywhere in the app stops the turn, not just Esc inside the composer —
  // the moment you want to stop something is rarely the moment your cursor
  // happens to be in the text box. ⌘⇧⌫ stops every chat at once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && sendingRef.current) {
        void stopTurn();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "Backspace" || e.key === "Delete")) {
        e.preventDefault();
        void stopTurn(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function handleSend(
    forced?: string,
    opts?: { fromQueueId?: string; prefix?: string; auto?: boolean },
  ) {
    const text = (forced ?? input).trim();
    if (!text && attachments.length === 0) return;
    // A real human send re-arms the autopilot budget.
    if (!opts?.auto) autoCountRef.current = 0;
    sawErrorRef.current = null;
    if (sendingRef.current && !opts?.fromQueueId) {
      const prefix =
        attachments.length > 0
          ? attachments.map((a) => `[${a.kind === "image" ? "Image" : "File"}: ${a.path}]`).join("\n") + "\n\n"
          : "";
      const display =
        attachments.length > 0
          ? `${text}${text ? "\n" : ""}📎 ${attachments.length} file${attachments.length === 1 ? "" : "s"} attached`
          : text;
      const qid = crypto.randomUUID();
      queueRef.current.push({ id: qid, text, prefix });
      setMessages((m) => [...m, { id: qid, role: "user", content: display, queued: true, ts: Date.now() }]);
      setInput("");
      setAttachments([]);
      return;
    }
    // Slash commands. Claude Code handles its own headlessly (/compact etc.
    // pass straight through). Hermes' slash commands are interactive-CLI
    // features that don't exist in single-query mode — handle the useful
    // ones here instead of silently sending them as chat text.
    if (text.startsWith("/")) {
      const cmd = text.split(/\s+/)[0].toLowerCase();
      if (cmd === "/new" || cmd === "/clear") {
        setInput("");
        newChat();
        return;
      }
      const interactiveOnly = ["/model", "/models", "/compact", "/approvals", "/status"];
      if (
        cmd === "/help" ||
        (backend === "hermes" && interactiveOnly.includes(cmd)) ||
        (backend === "claude" && lane === "codex" && interactiveOnly.includes(cmd))
      ) {
        setInput("");
        const help =
          backend === "hermes"
            ? "**Commands here:**\n- `/new` — start a fresh chat\n- `/help` — this message\n\nModel and effort live in the picker above (logo chip). Hermes auto-compresses long conversations on its own — no `/compact` needed. Hermes' own slash commands (like `/learn`) belong to its terminal and messaging gateways."
            : lane === "codex"
              ? "**Commands here (Codex lane):**\n- `/new` — start a fresh chat\n- `/help` — this message\n\nThis chat runs the real Codex CLI headless on your ChatGPT plan. Codex manages its own context automatically — no `/compact` needed. Model and reasoning effort live in the picker above."
              : "**Commands here (Claude Code):**\n- `/new` — start a fresh chat\n- `/compact` — compact this session's context (runs in the real CLI)\n- your custom `.claude/commands` work too\n\nModel and effort live in the picker above.";
        setMessages((m) => [
          ...m,
          { id: crypto.randomUUID(), role: "user", content: text, ts: Date.now() },
          { id: crypto.randomUUID(), role: "assistant", content: help },
        ]);
        return;
      }
      // anything else falls through to the agent (Claude Code runs its own)
    }
    setInput("");
    setSending(true);
    sendingRef.current = true;
    turnStartRef.current = Date.now();
    liveRef.current = freshLiveTurn(turnStartRef.current);
    turnTokBaseRef.current = approxTokens;
    const t0 = Date.now();
    setActivity("");
    const ac = new AbortController();
    abortRef.current = ac;

    const imagePrefix =
      opts?.prefix ??
      (attachments.length > 0
        ? attachments.map((a) => `[${a.kind === "image" ? "Image" : "File"}: ${a.path}]`).join("\n") + "\n\n"
        : "");
    const displayText =
      !opts?.prefix && attachments.length > 0
        ? `${text}${text ? "\n" : ""}📎 ${attachments.length} file${attachments.length === 1 ? "" : "s"} attached`
        : text;
    if (!opts?.fromQueueId) setAttachments([]);
    if (!firstUserTextRef.current) firstUserTextRef.current = text || "Image chat";

    const wasNewChat = messages.length === 0;
    let accumulatedForTitle = "";
    const botId = crypto.randomUUID();
    if (opts?.fromQueueId) {
      // The queued bubble is already in the thread — flip it live and add
      // the streaming placeholder after it.
      setMessages((m) => [
        ...m.map((msg) => (msg.id === opts.fromQueueId ? { ...msg, queued: false } : msg)),
        { id: botId, role: "assistant" as const, content: "", streaming: true, retryText: text, ts: Date.now() },
      ]);
    } else {
      const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content: displayText, ts: Date.now() };
      setMessages((m) => [
        ...m,
        userMsg,
        { id: botId, role: "assistant", content: "", streaming: true, retryText: text, ts: Date.now() },
      ]);
    }

    const appendBot = (chunk: string) =>
      setMessages((m) =>
        m.map((msg) => (msg.id === botId ? { ...msg, content: msg.content + chunk } : msg)),
      );
    const failBot = (text: string) =>
      setMessages((m) =>
        m.map((msg) =>
          msg.id === botId ? { ...msg, content: text, streaming: false, error: true } : msg,
        ),
      );

    try {
      const token = await fetch("/__token")
        .then((r) => r.json())
        .then((t) => t?.token as string | undefined)
        .catch(() => undefined);
      const sid = sessionRef.current[backend];
      const body: Record<string, unknown> = { prompt: `${imagePrefix}${text}`.trim() };
      if (sid) body.sessionId = sid;
      if (model) {
        body.model = model.name;
        // The lane the user actually PICKED, on both backends. Hermes has
        // always needed it as an argv flag; /__claude_chat needs it for the
        // lane decision, and until now never got it — so the server fell back
        // to guessing from the id, which is how a model the ChatGPT plan covers
        // was spawned on the metered lane. The server validates and ignores it
        // for anything it doesn't recognise.
        if (model.provider) body.provider = model.provider;
      }
      if (backend === "claude") {
        if (canEffort) body.effort = effortShown;
        if (canPermMode && permMode !== "default") body.permissionMode = permMode;
        // Approval stance + the chat identity the cards come back on.
        body.chatId = chatIdRef.current;
        body.toolMode = toolMode;
        if (toolMode === "yolo") body.yolo = true;
        // The selected model's real context window → server sizes the
        // auto-compact threshold to ~85% of it (ccr lane).
        if (lane === "ccr") body.ctxWindow = ctxTokens;
      }
      const response = await fetch(backendCfg.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Claude-OS-Token": token } : {}),
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!response.ok || !response.body) {
        failBot("The agent endpoint returned an error.");
        return;
      }
      const { error: sawError, terminal } = await pumpStream(response.body, botId, (t) => {
        accumulatedForTitle += t;
      });
      // Autopilot refuses to continue past an error. The inline reader that
      // pumpStream replaced set this as it went; pumpStream returns it instead,
      // so hand it over here — otherwise autopilot happily drives into a wall.
      sawErrorRef.current = sawError;
      // `terminal` is how a turn the dev server took down with it stops looking
      // like a completed reply that trailed off.
      finalizeBot(botId, t0, sawError, ac.signal.aborted, terminal);
      // First exchange of a fresh chat → ask Haiku for a 3-5 word title.
      if (wasNewChat) {
        const sid = sessionRef.current[backend];
        if (sid) {
          void (async () => {
            try {
              const r = await fetch("/__chat_title", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user: text, assistant: accumulatedForTitle.slice(0, 600) }),
              });
              if (!r.ok) return;
              const j = await r.json();
              if (j?.title) {
                saveTitle(`${backend}-${sid}`, j.title, false);
                onSessionsChanged();
              }
            } catch {
              /* title stays as first-message fallback */
            }
          })();
        }
      }
      onSessionsChanged();
    } catch (err) {
      // A bare catch here reported "Couldn't reach the agent just now" for
      // EVERY failure — including the AbortError thrown when the user presses
      // Stop or steers. Stopping your own run is not a transport failure, and
      // labelling it one (with a Retry button) makes a working app look broken:
      // observed as three stacked red errors in a row on a healthy chat.
      const aborted =
        ac.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError") ||
        (err as { name?: string })?.name === "AbortError";
      if (aborted) {
        setMessages((m) =>
          m.map((msg) =>
            msg.id === botId
              ? { ...msg, content: "Stopped.", streaming: false, error: false }
              : msg,
          ),
        );
      } else {
        const why = (err as { message?: string })?.message;
        failBot(why ? `Couldn't reach the agent — ${why}` : "Couldn't reach the agent just now.");
      }
    } finally {
      setSending(false);
      sendingRef.current = false;
      setActivity("");
      abortRef.current = null;
      // Fire the next queued message, if any — same session, in order.
      const next = queueRef.current.shift();
      // A user abort must win. `finally` runs on abort too, so without this the
      // queue drains and autopilot re-sends "Continue autonomously…" 500ms after
      // every Stop — the agent restarts itself and Stop appears to do nothing.
      // Stopping is also an instruction: it turns autopilot OFF and discards
      // anything queued, rather than leaving a loop armed behind the scenes.
      if (ac.signal.aborted) {
        autoPilotRef.current = false;
        setAutoPilot(false);
        if (queueRef.current.length) {
          const dropped = queueRef.current.map((q) => q.id);
          queueRef.current = [];
          setMessages((m) => m.filter((msg) => !dropped.includes(msg.id)));
        }
        return;
      }
      if (next) {
        setTimeout(() => void handleSend(next.text, { fromQueueId: next.id, prefix: next.prefix }), 80);
      } else if (autoPilotRef.current && !sawErrorRef.current) {
        // Autopilot continue — visible in the thread like a typed message.
        const last = lastBotTextRef.current.trim();
        const needsHuman = /BLOCKED/i.test(last.slice(-500)) || /\?\s*$/.test(last);
        if (!needsHuman && autoCountRef.current < 12) {
          autoCountRef.current += 1;
          setTimeout(
            () =>
              void handleSend(
                "Continue autonomously with the plan, stage by stage — don't wait for me. Print a one-line status every few minutes while working. Only stop if truly blocked, and then say BLOCKED plus what you need.",
                { auto: true },
              ),
            500,
          );
        }
      }
    }
  }

  return (
    <div
      className="relative flex flex-1 min-w-0 flex-col overflow-hidden"
      style={{
        outline: focused && showClose ? `1px solid rgba(255,230,203,0.25)` : "none",
        outlineOffset: -1,
      }}
      onMouseDown={onFocus}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          e.preventDefault();
          void handleFiles(e.dataTransfer.files);
        }
      }}
    >
      {/* Pane top bar */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 border-b" style={{ borderColor: HAIR_SOFT }}>
        <div className="flex items-center gap-1.5">
          {BACKENDS.map((b) => {
            const active = backend === b.id;
            return (
              <button
                key={b.id}
                type="button"
                title={b.label}
                aria-label={b.label}
                onClick={() => setBackend(b.id)}
                className="relative h-9 w-9 rounded-xl overflow-hidden transition-all"
                style={{
                  border: active ? `2px solid ${b.tone}` : "2px solid rgba(255,230,203,0.32)",
                  boxShadow: active ? `0 0 14px ${b.tone}55` : "none",
                  opacity: active ? 1 : 0.55,
                  transform: active ? "scale(1)" : "scale(0.92)",
                }}
              >
                {(() => {
                  const brand =
                    b.id === "claude" && model && !/^claude/.test(model.name)
                      ? brandLogo(model.name)
                      : null;
                  return brand ? (
                    <span className="flex h-full w-full items-center justify-center" style={{ background: "rgba(4,16,15,0.85)" }}>
                      <img
                        src={brand}
                        alt={b.label}
                        className="h-[65%] w-[65%] object-contain"
                        style={{ filter: DARK_GLYPHS.has(brand) ? "invert(0.92) sepia(0.15) brightness(1.05)" : undefined }}
                      />
                    </span>
                  ) : (
                    <img src={b.logo} alt={b.label} className="h-full w-full object-cover" />
                  );
                })()}
              </button>
            );
          })}
        </div>
        <ModelPicker
          models={models}
          model={model}
          onPick={setModelKey}
          backend={backend}
          effort={effort}
          onEffort={pickEffort}
          showEffort={canEffort}
          effortChoices={effortLevels}
        />
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              setToolMode((v) => (v === "ask" ? "acceptEdits" : v === "acceptEdits" ? "yolo" : "ask"))
            }
            title={
              toolMode === "ask"
                ? "Ask — every tool call raises an approval card (click for auto-accept edits)"
                : toolMode === "acceptEdits"
                  ? "Auto-accept edits — file edits go through, everything else still asks (click for yolo)"
                  : "Yolo — nothing is ever asked, the agent runs unattended (click to go back to Ask)"
            }
            className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] hermes-mono uppercase tracking-wider transition-colors"
            style={{
              border: `1px solid ${toolMode === "yolo" ? "rgba(255,157,143,0.6)" : toolMode === "acceptEdits" ? backendCfg.tone : HAIR}`,
              color: toolMode === "yolo" ? "#ff9d8f" : toolMode === "acceptEdits" ? backendCfg.tone : "rgba(255,230,203,0.55)",
              background: toolMode === "ask" ? "transparent" : "rgba(255,210,30,0.08)",
            }}
          >
            <Wrench className="h-3 w-3" /> {TOOL_MODE_LABEL[toolMode]}
          </button>
          <button
            type="button"
            onClick={newChat}
            title="New chat in this pane"
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
            style={{ border: `1px solid ${HAIR}`, color: "rgba(255,230,203, 0.88)" }}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          {showClose && (
            <button
              type="button"
              onClick={onClose}
              title="Close pane"
              className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
              style={{ border: `1px solid ${HAIR}`, color: "rgba(255,230,203, 0.88)" }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Thread — pantheon art (or Claude's film) pinned behind a wash that
          never scrolls away: bg + wash live on the non-scrolling parent, the
          scroll container sits above them. */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        {backend === "claude" && model && modelArt(model.name) ? (
          <img
            src={modelArt(model.name)!}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            style={{ objectPosition: "center 12%" }}
          />
        ) : backend === "claude" ? (
          <video
            src={claudeVideoBg}
            autoPlay
            muted
            loop
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
            style={{ objectPosition: "center 18%" }}
          />
        ) : (
          <img
            src={PANE_ART[paneIndex % PANE_ART.length]}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              backend === "claude"
                ? "linear-gradient(180deg, rgba(26,13,7,0.78) 0%, rgba(16,8,4,0.86) 100%)"
                : "linear-gradient(180deg, rgba(7,29,28,0.78) 0%, rgba(5,20,19,0.86) 100%)",
          }}
        />
        <div ref={threadRef} className="absolute inset-0 overflow-y-auto">
        {/* Bottom padding is MEASURED from the composer, not guessed. The old
            fixed pb-44 (176px) was fine for an idle composer (~138px) and wrong
            for every other state: sending ≈185px, sending + attachments ≈249px,
            and a grown textarea ≈332px — at which point 156px of the newest
            message sat permanently underneath the composer with no way to
            scroll to it. */}
        <div
          className="relative mx-auto max-w-4xl 2xl:max-w-5xl px-5 pt-6 space-y-5"
          style={{ paddingBottom: composerH + 28 }}
        >
          {messages.length === 0 && !loadingSession && (
            <div className="pt-[10vh] text-center select-none">
              <div
                className="text-[30px] md:text-[38px] leading-tight"
                style={{ color: CREAM, fontFamily: '"Fraunces", serif', fontWeight: 500 }}
              >
                What are we building today?
              </div>
              <div
                className="mt-3 flex items-center justify-center gap-2 text-[12px] hermes-mono uppercase tracking-[0.18em]"
                style={{ color: "rgba(255,230,203, 0.75)" }}
              >
                <img
                  src={backendCfg.logo}
                  alt=""
                  className="h-[18px] w-[18px] rounded object-cover"
                />
                {backendCfg.label}
                {model && (
                  <>
                    <span style={{ opacity: 0.45 }}>·</span>
                    <LogoChip src={brandLogo(model.name)} size={16} />
                    {shortModel(model.name)}
                  </>
                )}
              </div>

            </div>
          )}

          {loadingSession && (
            <div
              className="flex items-center gap-2 text-[12px] hermes-mono"
              style={{ color: "rgba(255,230,203, 0.75)" }}
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading chat…
            </div>
          )}

          {messages.map((m) =>
            m.routerMismatch ? (
              <div key={m.id} className="flex justify-start">
                <div className="max-w-[88%] min-w-0 flex-1">
                  <RouterMismatchCard
                    info={m.routerMismatch}
                    onPinned={() =>
                      setMessages((mm) =>
                        mm.map((x) => (x.id === m.id ? { ...x, routerMismatch: undefined, note: "✓ every ccr route now pinned to the selected model" } : x)),
                      )
                    }
                  />
                </div>
              </div>
            ) : m.note ? (
              <div key={m.id} className="flex justify-center">
                <div
                  className="hermes-mono rounded-full px-3 py-1 text-[11px] uppercase tracking-[0.14em]"
                  style={{ border: "1px solid rgba(255,210,30,0.35)", color: "rgba(255,210,30,0.85)" }}
                >
                  {m.note}
                </div>
              </div>
            ) : m.permission ? (
              <div key={m.id} className="flex justify-start">
                <div className="max-w-[88%] min-w-0 flex-1">
                  <PermissionPrompt
                    card={m.permission}
                    onDecide={(d, msg) => void decidePermission(m.permission!, d, msg)}
                  />
                </div>
              </div>
            ) : m.question ? (
              <div key={m.id} className="flex justify-start">
                <div className="max-w-[88%] min-w-0 flex-1">
                  <QuestionPrompt
                    card={m.question}
                    onAnswer={(picks) => void answerQuestion(m.question!, picks)}
                  />
                </div>
              </div>
            ) : m.role === "user" ? (
              <div key={m.id} className="group relative flex flex-col items-end">
                <div className="relative flex w-full justify-end">
                  <MsgCopy text={m.content} align="right" />
                  <div
                    className="max-w-[78%] px-5 py-3.5 text-[13.5px] leading-relaxed"
                    style={{
                      background: "linear-gradient(180deg, #FFF2DE 0%, #FFE6CB 100%)",
                      color: BG,
                      borderRadius: "16px 4px 16px 16px",
                      boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontFamily: MD_SANS,
                      opacity: m.queued ? 0.6 : 1,
                    }}
                  >
                    {m.content}
                  </div>
                </div>
                {!m.queued && m.ts && (
                  <div
                    className="hermes-mono mt-1 pr-1 text-[10.5px]"
                    style={{ color: "rgba(255,230,203, 0.62)" }}
                    title={new Date(m.ts).toLocaleString()}
                  >
                    {clockTime(m.ts)}
                  </div>
                )}
                {m.queued && (
                  <div
                    className="hermes-mono mt-1.5 flex items-center gap-2 rounded-full px-3 py-1 text-[10.5px] uppercase tracking-[0.14em]"
                    style={{ border: "1px solid rgba(255,210,30,0.4)", color: "rgba(255,210,30,0.85)" }}
                  >
                    {m.steering ? "⇢ steering — folding into the run now" : "⏳ queued — hasn't interrupted the run"}
                    <button
                      type="button"
                      title="Cancel this queued message"
                      onClick={() => cancelQueued(m.id)}
                      style={{ color: "rgba(255,157,143,0.9)" }}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div key={m.id} className="group relative flex justify-start">
                <MsgCopy text={m.content} />
                <div
                  className="max-w-[88%] px-6 py-5 text-[13.5px] leading-relaxed"
                  style={{
                    background:
                      "linear-gradient(165deg, rgba(10,32,31,0.97) 0%, rgba(5,18,18,0.97) 100%)",
                    color: m.error ? "#ff9d8f" : "#F3E9DA",
                    border: "1px solid rgba(255,230,203,0.16)",
                    borderTop: "1px solid rgba(255,230,203,0.28)",
                    borderRadius: "4px 18px 18px 18px",
                    boxShadow: "0 14px 44px rgba(0,0,0,0.5)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: MD_SANS,
                    backdropFilter: "blur(10px)",
                  }}
                >
                  {/* `m.resumes` is in this condition on purpose: a turn that
                      ran no tools and banked no segments would otherwise render
                      no header at all, and a reply stitched from three attempts
                      would look like one clean run. Disclosure can't be
                      conditional on the turn having also used a tool. */}
                  {((m.steps?.length ?? 0) > 0 || m.thinking || (m.segments?.length ?? 0) > 0 || !!m.resumes) &&
                    !m.streaming && (
                    <details className="mb-2">
                      <summary
                        className="hermes-mono inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] uppercase tracking-[0.16em]"
                        style={{ color: "rgba(255,230,203, 0.75)", border: "1px solid rgba(255,230,203,0.14)" }}
                      >
                        {m.ts ? `${clockTime(m.ts)} · ` : ""}✓ worked
                        {m.elapsedS ? ` ${m.elapsedS >= 60 ? `${Math.floor(m.elapsedS / 60)}m ${m.elapsedS % 60}s` : `${m.elapsedS}s`}` : ""} ·{" "}
                        {m.steps?.length ?? 0} tool{(m.steps?.length ?? 0) === 1 ? "" : "s"}
                        {m.resumes ? (
                          <span
                            title={`This turn stopped before finishing ${m.resumes} time${m.resumes === 1 ? "" : "s"} and was automatically resumed in the same session. The reply above is stitched from ${m.resumes + 1} attempts.`}
                            style={{ color: "rgba(255,210,30,0.8)" }}
                          >
                            {" "}· {m.resumes} resume{m.resumes === 1 ? "" : "s"}
                          </span>
                        ) : null}{" "}
                        · view trace
                        {m.actualModel && (
                          <span
                            className="ml-1 rounded-full px-1.5 py-0.5 tracking-normal"
                            style={{ border: "1px solid rgba(255,230,203,0.2)", color: "rgba(255,230,203, 0.88)" }}
                            title={`The harness reported ${m.actualModel} as the model that answered this turn`}
                          >
                            {shortModel(m.actualModel)}
                          </span>
                        )}
                      </summary>
                      <div
                        className="hermes-mono mt-1.5 space-y-0.5 rounded-lg px-2.5 py-2 text-[10.5px]"
                        style={{ background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,230,203,0.1)", color: "rgba(243,233,218,0.6)" }}
                      >
                        {m.thinking && (
                          <div
                            className="mb-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap italic"
                            style={{ color: "rgba(243,233,218,0.5)", fontFamily: MD_SANS, fontSize: 11 }}
                          >
                            {m.thinking.trim()}
                          </div>
                        )}
                        {(m.segments ?? []).map((sg, si) => (
                          <div
                            key={`sg${si}`}
                            className="mb-1.5 whitespace-pre-wrap"
                            style={{ color: "rgba(243,233,218,0.55)", fontFamily: MD_SANS, fontSize: 11.5 }}
                          >
                            {stripNoise(sg)}
                          </div>
                        ))}
                        {(m.steps ?? []).map((st, si) => (
                          <div key={si} className="truncate">{st}</div>
                        ))}
                      </div>
                    </details>
                  )}
                  {m.streaming && (
                    <div className="flex flex-col gap-2">
                      {/* Unconditional, unlike the working panel below it: the
                          exact failure being fixed was a turn that showed a
                          half-finished sentence and NOTHING else for minutes.
                          The strip is up from the first frame of the turn. */}
                      <LiveTurnStrip
                        live={liveRef}
                        ts={m.ts}
                        toolCount={m.steps?.length ?? 0}
                        model={m.actualModel ?? model?.name}
                        tone={backendCfg.tone}
                        paused={awaitingApproval || awaitingQuestion}
                      />
                      {(m.thinking || (m.steps?.length ?? 0) > 0 || m.content.trim() || (m.segments?.length ?? 0) > 0) && (
                        <div
                          className="rounded-lg px-3 py-2"
                          style={{ background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,230,203,0.1)" }}
                        >
                          {m.thinking && (
                            <>
                              <div
                                className="hermes-mono mb-1 text-[10.5px] uppercase tracking-[0.16em]"
                                style={{ color: "rgba(255,210,30, 0.75)" }}
                              >
                                thinking…
                              </div>
                              <div
                                className="mb-1.5 whitespace-pre-wrap italic leading-relaxed"
                                style={{ color: "rgba(243,233,218,0.55)", fontSize: 11 }}
                              >
                                {m.thinking.length > 360 ? `…${m.thinking.slice(-360)}` : m.thinking}
                              </div>
                            </>
                          )}
                          {/* The whole trail, not the last four.
                              This panel used to show `.slice(-4)`, so a turn
                              that ran a dozen tools scrolled its own history off
                              the top while it worked — the one moment you most
                              want to see what it has been doing. Everything is
                              here now, in a scroll box so it can't wall up the
                              thread, pinned to the newest line. */}
                          {(m.steps?.length ?? 0) > 0 && (
                            <div
                              className="mb-1 max-h-[168px] overflow-y-auto pr-1"
                              ref={(el) => {
                                if (el) el.scrollTop = el.scrollHeight;
                              }}
                            >
                              {(m.steps ?? []).map((st, si, arr) => {
                                const running = si === arr.length - 1;
                                return (
                                  <div
                                    key={si}
                                    className="hermes-mono truncate text-[10.5px]"
                                    style={{
                                      color: running
                                        ? "rgba(255,210,30,0.92)"
                                        : "rgba(243,233,218,0.6)",
                                    }}
                                    title={st}
                                  >
                                    {running ? "▸ " : "  "}
                                    {st}
                                    {/* A step that has been running for a while
                                        is the difference between "thinking" and
                                        "dead". A sub-agent emits ONE line and
                                        then nothing for its entire run — eight
                                        silent minutes that looked like a hang. */}
                                    {running && (
                                      <SinceLabel
                                        since={stepStartRef}
                                        render={(s) => (s > 3 ? `  ${s}s` : "")}
                                      />
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {(() => {
                            // Live narration tail — the model's latest words,
                            // windowed so long agentic turns never wall up.
                            const live = m.content.trim() || m.segments?.[m.segments.length - 1] || "";
                            if (!live.trim()) return null;
                            const tail = live.length > 420 ? `…${live.slice(-420)}` : live;
                            return (
                              <div
                                className="mt-1 whitespace-pre-wrap leading-relaxed"
                                style={{ color: "rgba(243,233,218,0.8)", fontSize: 12.5 }}
                              >
                                {stripNoise(tail)}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                      <span className="flex items-center gap-2.5">
                        <span className="hc-eq" style={{ color: backendCfg.tone }}>
                          {[0, 1, 2, 3, 4].map((i) => (
                            <span key={i} style={{ animationDelay: `${i * 120}ms` }} />
                          ))}
                        </span>
                        <span
                          className="hermes-mono truncate text-[10.5px] uppercase tracking-wider"
                          style={{ color: "rgba(255,230,203, 0.75)" }}
                        >
                          {activity || `${model ? shortModel(model.name) : backendCfg.label} is thinking`}
                        </span>
                      </span>
                    </div>
                  )}
                  {!m.streaming && (() => {
                    const bill = m.error ? billingIssue(m.content) : null;
                    if (bill)
                      return (
                        <div
                          className="rounded-xl px-4 py-3"
                          style={{ border: "1px solid rgba(255,157,143,0.45)", background: "rgba(255,90,70,0.08)" }}
                        >
                          <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold" style={{ color: "#ff9d8f" }}>
                            💳 {bill.title}
                          </div>
                          <div className="text-[12px] leading-relaxed" style={{ color: "rgba(243,233,218,0.8)" }}>
                            {bill.body}
                          </div>
                          <a
                            href="https://openrouter.ai/settings/keys"
                            target="_blank"
                            rel="noreferrer"
                            className="hermes-mono mt-2 inline-block rounded-full px-3 py-1 text-[11px] uppercase tracking-wider"
                            style={{ border: "1px solid rgba(255,210,30,0.5)", color: AMBER }}
                          >
                            Open key settings ↗
                          </a>
                        </div>
                      );
                    const body = stripNoise(m.content);
                    return body ? <ChatMd text={body} /> : "";
                  })()}
                  {!m.streaming && (m.files?.length ?? 0) > 0 && (
                    // ── The deliverables, checked ────────────────────────
                    // A turn said "saved to your Desktop as Kola Deck.html".
                    // It was true, and it was also unverifiable from the chat,
                    // so the user went hunting for a file that already existed.
                    // Every path here was stat'd by the server AFTER the turn
                    // ended: it exists, and the byte count is what was on disk
                    // at that moment — measured, not estimated. Paths the turn
                    // named and did not produce are simply absent.
                    <div className="mt-3">
                      <div
                        className="hermes-mono mb-1.5 text-[10.5px] uppercase tracking-[0.16em]"
                        style={{ color: "rgba(255,230,203, 0.62)" }}
                      >
                        ✓ written to disk — verified after the turn
                      </div>
                      <div className="flex flex-col gap-1">
                        {(m.files ?? []).map((f) => (
                          <a
                            key={f.path}
                            // Already URL-encoded by the server: "Kola Deck.html"
                            // has a space in it, and a raw href stops at it.
                            href={f.href}
                            target="_blank"
                            rel="noreferrer"
                            title={f.path}
                            className="hermes-mono flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11px]"
                            style={{
                              border: "1px solid rgba(255,230,203,0.16)",
                              background: "rgba(0,0,0,0.28)",
                              color: "rgba(243,233,218,0.85)",
                            }}
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {f.path.split("/").pop() || f.path}
                            </span>
                            <span style={{ color: "rgba(255,230,203,0.5)" }}>{fmtBytes(f.bytes)}</span>
                            <span style={{ color: AMBER }}>open ↗</span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                  {!m.streaming && m.interrupted && m.retryText && (
                    // Interrupted is not failed: the work so far is real, so
                    // the way forward is "carry on", not "start again".
                    <button
                      type="button"
                      onClick={() =>
                        void handleSend(
                          `You were interrupted mid-work — continue exactly where you left off, do not restart.\n\n${m.retryText}`,
                        )
                      }
                      disabled={sending}
                      className="hermes-mono mt-2.5 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] uppercase tracking-wider disabled:opacity-60"
                      style={{ border: "1px solid rgba(255,210,30,0.45)", color: AMBER }}
                    >
                      ↻ resume this turn
                    </button>
                  )}
                  {!m.streaming && m.error && !m.interrupted && m.retryText && (
                    // Never a silent stop: every failed turn keeps one obvious
                    // way forward, even when the whole failover chain is spent.
                    <button
                      type="button"
                      onClick={() => void handleSend(m.retryText)}
                      disabled={sending}
                      className="hermes-mono mt-2.5 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] uppercase tracking-wider disabled:opacity-60"
                      style={{ border: "1px solid rgba(255,230,203,0.3)", color: CREAM }}
                    >
                      ↻ retry
                    </button>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
        </div>

      {/* Composer — floats on glass over the art; the gradient melts the
          hard seam the old solid block created. */}
      <div
        ref={composerRef}
        className="absolute inset-x-0 bottom-0 z-10 px-4 pt-10"
        style={{
          background: "linear-gradient(180deg, transparent 0%, rgba(5,20,19,0.9) 55%)",
          // Respect the home indicator / notch on installed PWAs and iPads;
          // there was no safe-area handling anywhere, so the telemetry strip
          // sat underneath it.
          paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))",
        }}
      >
        {sending && (
          <div
            className="mx-auto mb-2 max-w-4xl 2xl:max-w-5xl rounded-lg px-3.5 pb-0 pt-2"
            style={{
              background: "rgba(6,24,23,0.92)",
              border: `1px solid ${awaitingApproval ? "rgba(255,210,30,0.55)" : HAIR}`,
            }}
          >
            <div
              className="flex items-center gap-3 hermes-mono text-[11px] uppercase tracking-wider"
              style={{ color: awaitingApproval ? AMBER : "rgba(255,230,203,0.82)" }}
            >
              {awaitingApproval ? (
                // Parked on a decision — a steady amber dot, no pulse: nothing
                // is running, so a heartbeat would be a lie.
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: AMBER }}
                />
              ) : (
                <span className="hc-pulse" style={{ background: backendCfg.tone }} />
              )}
              <span style={{ color: CREAM, fontVariantNumeric: "tabular-nums" }}>
                <SinceLabel since={turnStartRef} render={fmtDur} />
              </span>
              <span>
                ≈{Math.max(0, approxTokens - turnTokBaseRef.current) >= 1000
                  ? `${(Math.max(0, approxTokens - turnTokBaseRef.current) / 1000).toFixed(1)}k`
                  : Math.max(0, approxTokens - turnTokBaseRef.current)}{" "}
                tok
              </span>
              {/* How full the window is, as a shape rather than a number to
                  squint at: ten cells fill left→right, coloured by pressure.
                  Same source as the ctx pill below — `ctxBreakdown.used`
                  against the model's real window — and clicking it opens the
                  same breakdown, so the strip is a shortcut to the panel and
                  not a second, disagreeing readout. */}
              <button
                type="button"
                onClick={() => setUsageOpen((v) => !v)}
                className="flex shrink-0 items-center gap-1.5"
                title={ctxTitle}
                aria-label={ctxTitle}
                aria-expanded={usageOpen}
              >
                <span className="flex items-center gap-[2px]">
                  {Array.from({ length: 10 }, (_, i) => (
                    <span
                      key={i}
                      className="inline-block h-[9px] w-[4px] rounded-[1px]"
                      style={{ background: i * 10 < ctxPct ? ctxTone : "rgba(255,230,203,0.36)" }}
                    />
                  ))}
                </span>
                <span style={{ color: ctxTone }}>{ctxPct}% ctx</span>
              </button>
              {lastCost ? (
                <span style={{ color: "rgba(255,210,30,0.85)" }}>${lastCost}</span>
              ) : costUnreported ? (
                <span
                  style={{ color: "rgba(255,230,203,0.5)" }}
                  title={`The ${costUnreported} lane closed the last turn without a cost figure — this is unknown, not zero.`}
                >
                  $—
                </span>
              ) : null}
              <span
                className="min-w-0 flex-1 truncate normal-case tracking-normal"
                style={{ color: "rgba(255,230,203, 0.88)", fontFamily: MD_SANS, fontSize: 12 }}
              >
                {awaitingQuestion
                  ? "⏸ waiting on you — the agent asked you a question above"
                  : awaitingApproval
                    ? "⏸ waiting on you — answer the approval card above"
                    : (
                        <WorkingLine
                          activity={activity}
                          turnStart={turnStartRef}
                          stepStart={stepStartRef}
                        />
                      )}
              </span>
              {queueRef.current.length > 0 && (
                <span className="shrink-0" style={{ color: "rgba(255,210,30,0.9)" }}>
                  {queueRef.current.length} queued
                </span>
              )}
              <span className="shrink-0" style={{ color: "rgba(255,230,203, 0.88)" }}>⌘⏎ steer</span>
            </div>
            <div className="hc-track mt-1.5">
              {awaitingApproval ? (
                <div className="h-full w-full" style={{ background: "rgba(255,210,30,0.35)" }} />
              ) : (
                <div className="hc-slide" style={{ background: backendCfg.tone }} />
              )}
            </div>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="mx-auto max-w-4xl 2xl:max-w-5xl mb-2 flex flex-wrap gap-2">
            {attachments.map((a, i) =>
              a.kind === "image" ? (
                <div
                  key={`${a.path}-${i}`}
                  className="relative h-14 w-14 rounded-lg overflow-hidden"
                  style={{ border: `1px solid ${HAIR}` }}
                >
                  <img src={a.preview} alt={a.name} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    className="absolute top-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded-full"
                    style={{ background: "rgba(4,16,15,0.8)", color: CREAM }}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ) : (
                <div
                  key={`${a.path}-${i}`}
                  className="relative flex h-14 items-center gap-2.5 rounded-lg pl-2.5 pr-7"
                  style={{ border: `1px solid ${HAIR}`, background: "rgba(7,29,28,0.7)", maxWidth: 220 }}
                >
                  <span
                    className="hermes-mono flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[10px] font-bold uppercase"
                    style={{
                      background:
                        /pdf$/i.test(a.name) ? "rgba(252,110,110,0.18)" :
                        /docx?$/i.test(a.name) ? "rgba(96,165,250,0.18)" :
                        /xlsx|csv$/i.test(a.name) ? "rgba(134,239,172,0.16)" :
                        "rgba(255,230,203,0.12)",
                      color:
                        /pdf$/i.test(a.name) ? "#fca5a5" :
                        /docx?$/i.test(a.name) ? "#93c5fd" :
                        /xlsx|csv$/i.test(a.name) ? "#86efac" :
                        "rgba(255,230,203,0.8)",
                    }}
                  >
                    {(a.name.split(".").pop() ?? "file").slice(0, 4)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[11.5px]" style={{ color: CREAM, fontFamily: MD_SANS }}>
                      {a.name}
                    </span>
                    <span className="hermes-mono block text-[10.5px]" style={{ color: "rgba(255,230,203, 0.62)" }}>
                      {a.size >= 1048576 ? `${(a.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full"
                    style={{ background: "rgba(4,16,15,0.8)", color: CREAM }}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ),
            )}
          </div>
        )}
        <div
          className="relative mx-auto max-w-4xl 2xl:max-w-5xl flex items-end gap-2 rounded-2xl px-3.5 py-2.5"
          style={{
            background: "rgba(7,29,28,0.72)",
            border: `1px solid ${HAIR}`,
            backdropFilter: "blur(14px)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
          }}
        >
          {slashOpen && (
            <div
              className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl"
              style={{ background: "rgba(6,24,23,0.98)", border: "1px solid rgba(255,230,203,0.2)", boxShadow: "0 -12px 44px rgba(0,0,0,0.55)" }}
            >
              <div className="hermes-mono px-3 pt-2 pb-1 text-[10.5px] uppercase tracking-[0.2em]" style={{ color: "rgba(255,230,203, 0.62)" }}>
                Commands
              </div>
              {slashMatches.map((c, ci) => (
                <button
                  key={c.name}
                  type="button"
                  onMouseEnter={() => setSlashIdx(ci)}
                  onClick={() => {
                    setInput(c.name);
                    setSlashDismissed(true);
                  }}
                  className="flex w-full items-baseline gap-3 px-3 py-1.5 text-left"
                  style={{ background: ci === slashIdx ? "rgba(255,230,203,0.1)" : "transparent" }}
                >
                  <span className="hermes-mono text-[12px]" style={{ color: AMBER }}>{c.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: "rgba(255,230,203, 0.75)", fontFamily: MD_SANS }}>
                    {c.description}
                  </span>
                </button>
              ))}
              <div className="hermes-mono px-3 pb-2 pt-1 text-[10px] uppercase tracking-wider" style={{ color: "rgba(255,230,203, 0.62)" }}>
                ↑↓ navigate · tab/enter complete · esc dismiss
              </div>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*,.pdf,.txt,.md,.csv,.json,.html,.docx,.xlsx,.pptx"
            multiple
            className="hidden"
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            title="Attach files — images, PDFs, documents"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-30"
            style={{ color: "rgba(255,230,203, 0.88)" }}
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
          </button>
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setSlashDismissed(false);
              setSlashIdx(0);
            }}
            onKeyDown={(e) => {
              if (slashOpen) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashIdx((i) => (i + 1) % slashMatches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSlashDismissed(true);
                  return;
                }
                if ((e.key === "Tab" || e.key === "Enter") && slashSel && input.trim() !== slashSel.name) {
                  e.preventDefault();
                  setInput(slashSel.name);
                  return;
                }
              }
              // Esc stops the running turn. The universal cancel key did
              // nothing here, so the only way to stop was to find and click a
              // 36px square.
              if (e.key === "Escape" && sendingRef.current) {
                e.preventDefault();
                void stopTurn();
                return;
              }
              // ⌘⏎ mid-turn steers the running turn instead of queueing
              // behind it — the queue stays the default, this is the explicit
              // "no, do it differently, now" alternative.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && sendingRef.current) {
                e.preventDefault();
                void steer();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            rows={1}
            placeholder={`Message ${backend === "claude" && model && !/^claude/.test(model.name) ? shortModel(model.name) : backendCfg.label}…`}
            className="flex-1 resize-none bg-transparent text-[13.5px] focus:outline-none max-h-[230px] overflow-y-auto py-1"
            style={{ color: CREAM, fontFamily: MD_SANS }}
          />
          {sending ? (
            <button
              type="button"
              onClick={() => void stopTurn()}
              title="Stop (Esc) — shift-click to stop every chat"
              onMouseDown={(e) => {
                if (e.shiftKey) {
                  e.preventDefault();
                  void stopTurn(true);
                }
              }}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors"
              style={{
                // Stopping is a real state with real latency (signal the group,
                // wait for the tree to die). Showing it beats a button that
                // looks inert while the kill is in flight — the ambiguity is
                // what made people press Stop again and assume it was broken.
                border: `1px solid ${stopping ? "rgba(255,120,90,0.75)" : "rgba(255,230,203,0.25)"}`,
                color: stopping ? "rgba(255,150,120,0.95)" : CREAM,
                opacity: stopping ? 0.75 : 1,
              }}
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!input.trim() && attachments.length === 0}
              title="Send"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-opacity disabled:opacity-25"
              style={{ background: backendCfg.tone, color: BG }}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Telemetry strip — effort dial · context ring · token estimate */}
        <div
          // flex-wrap + gap-y: without it this row could neither wrap nor
          // scroll, and flex items default to min-width:auto so they refuse to
          // shrink. In a narrow or multi-pane layout the row simply overflowed
          // and was hard-clipped by the pane's overflow-hidden — the model name
          // and the turn cost were cut off the right edge entirely. That is the
          // literal reason you "can't see all the things at the bottom": they
          // were not dim, they were not on screen.
          className="mx-auto mt-1.5 flex max-w-4xl 2xl:max-w-5xl flex-wrap items-center gap-x-3 gap-y-1.5 px-1 hermes-mono text-[11px] uppercase"
          style={{ color: "rgba(255,230,203, 0.72)" }}
        >
          {canEffort && (
          <div className="relative">
          {effortMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setEffortMenuOpen(false)} />
              <div
                className="absolute bottom-full left-0 z-50 mb-1.5 flex flex-col rounded-lg py-1"
                style={{ background: "rgba(6,24,23,0.98)", border: `1px solid rgba(255,230,203,0.2)`, boxShadow: "0 -12px 40px rgba(0,0,0,0.5)" }}
              >
                {effortLevels.map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => { pickEffort(lvl); setEffortMenuOpen(false); }}
                    className="px-4 py-1.5 text-left text-[10px] hermes-mono uppercase tracking-wider transition-colors"
                    style={{ color: effortShown === lvl ? AMBER : "rgba(255,230,203,0.65)", background: effortShown === lvl ? "rgba(255,210,30,0.08)" : "transparent" }}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
            </>
          )}
          <button
            type="button"
            onClick={() => setEffortMenuOpen((v) => !v)}
            title="Reasoning effort — pick a level"
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-colors"
            style={{ border: `1px solid ${HAIR}` }}
          >
            <span className="flex items-center gap-0.5">
              {effortLevels.map((lvl, i) => (
                <span
                  key={lvl}
                  className="h-2 w-1 rounded-sm"
                  style={{
                    background:
                      i <= effortLevels.indexOf(effortShown) ? AMBER : "rgba(255,230,203,0.34)",
                  }}
                />
              ))}
            </span>
            {effortShown}
          </button>
          </div>
          )}
          {canPermMode && (
            <span className="relative">
              {permOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setPermOpen(false)} />
                  <div
                    className="absolute bottom-full left-0 z-50 mb-2 w-[210px] overflow-hidden rounded-xl normal-case tracking-normal"
                    style={{ background: "rgba(6,24,23,0.98)", border: "1px solid rgba(255,230,203,0.2)", boxShadow: "0 -12px 44px rgba(0,0,0,0.55)", fontFamily: MD_SANS }}
                  >
                    <div className="hermes-mono px-3 pt-2 pb-1 text-[10.5px] uppercase tracking-[0.2em]" style={{ color: "rgba(255,230,203, 0.62)" }}>
                      Session mode
                    </div>
                    {(["default", "plan"] as const).map((pm) => (
                      <button
                        key={pm}
                        type="button"
                        onClick={() => {
                          setPermMode(pm);
                          setPermOpen(false);
                        }}
                        className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px]"
                        style={{
                          background: permMode === pm ? "rgba(255,230,203,0.1)" : "transparent",
                          color: CREAM,
                        }}
                      >
                        {PERM_LABELS[pm]}
                        {permMode === pm && <span style={{ color: AMBER }}>✓</span>}
                      </button>
                    ))}
                    <div className="px-3 pb-2 pt-1 text-[11px]" style={{ color: "rgba(255,230,203, 0.62)" }}>
                      Plan mode researches and proposes without touching anything. Who gets asked about
                      tools is the {TOOL_MODE_LABEL[toolMode]} switch up in the header.
                    </div>
                  </div>
                </>
              )}
              <button
                type="button"
                onClick={() => setPermOpen((v) => !v)}
                title="Session mode — work normally, or plan first without touching anything"
                className="hermes-mono flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] uppercase tracking-wider transition-colors"
                style={{
                  border: `1px solid ${permMode === "plan" ? "rgba(255,210,30,0.5)" : HAIR}`,
                  color: permMode === "plan" ? AMBER : "rgba(255,230,203,0.45)",
                }}
              >
                {PERM_LABELS[permMode]}
              </button>
            </span>
          )}
          {backend === "claude" && (
            <button
              type="button"
              onClick={() => {
                setAutoPilot((v) => {
                  autoPilotRef.current = !v;
                  return !v;
                });
                autoCountRef.current = 0;
              }}
              title="Autopilot — when a turn ends, this pane automatically sends the next 'continue' so long builds keep rolling without you. Stops on errors, BLOCKED, or a question for you."
              className="hermes-mono flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] uppercase tracking-wider transition-colors"
              style={{
                border: `1px solid ${autoPilot ? "rgba(255,210,30,0.55)" : HAIR}`,
                color: autoPilot ? AMBER : "rgba(255,230,203,0.45)",
                background: autoPilot ? "rgba(255,210,30,0.08)" : "transparent",
              }}
            >
              {autoPilot ? "⚡ auto: on" : "auto"}
            </button>
          )}
          <span className="flex-1" />
          <span className="relative flex items-center">
          {usageOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setUsageOpen(false)} />
              <div
                className="absolute bottom-full right-0 z-50 mb-2 max-h-[70vh] w-[340px] overflow-y-auto rounded-xl p-3.5 normal-case tracking-normal"
                style={{ background: "rgba(6,24,23,0.98)", border: "1px solid rgba(255,230,203,0.2)", boxShadow: "0 -12px 44px rgba(0,0,0,0.55)", fontFamily: MD_SANS }}
              >
                <div className="hermes-mono mb-2 text-[10.5px] uppercase tracking-[0.2em]" style={{ color: "rgba(255,230,203, 0.75)" }}>
                  Usage · {model ? shortModel(model.name) : ""}
                </div>
                <ContextBreakdown
                  breakdown={ctxBreakdown}
                  modelLabel={model ? shortModel(model.name) : ""}
                  // Codex manages its own context and never auto-compacts.
                  compactAt={lane === "codex" ? undefined : 0.72}
                />
                <div className="mt-3 space-y-1.5 border-t pt-2.5 text-[11px]" style={{ borderColor: "rgba(255,230,203,0.12)", color: "rgba(255,230,203, 0.88)" }}>
                  {!lastCost && costUnreported && (
                    <div className="flex justify-between">
                      <span>Last turn</span>
                      <span
                        style={{ color: "rgba(255,230,203,0.5)" }}
                        title={`No usage came back from the ${costUnreported} lane on the last turn.`}
                      >
                        not reported ({costUnreported})
                      </span>
                    </div>
                  )}
                  {lastCost && (
                    <div className="flex justify-between">
                      <span>Last turn</span>
                      <span style={{ color: "rgba(255,210,30,0.85)" }}>${lastCost}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span>Billed to</span>
                    <span style={{ color: CREAM }}>
                      {/* Only names a payer it can actually derive. The old
                          ternary fell through to "Claude subscription" for
                          every unrecognised lane, so a chat on the user's own
                          Grok/xAI OAuth reported that Anthropic was paying for
                          it. Naming the wrong payer is worse than admitting we
                          do not know — payerLabel says "unknown" rather than
                          guessing. */}
                      {payerLabel(lane, model?.provider)}
                    </span>
                  </div>
                  {lane === "ccr" && (
                    <div className="flex justify-between">
                      <span>OpenRouter balance</span>
                      <span style={{ color: "#7be0c8" }}>
                        {orCreditsQ.data ? `$${orCreditsQ.data.remaining.toFixed(2)}` : orCreditsQ.isError ? "unavailable" : "…"}
                      </span>
                    </div>
                  )}
                  {(() => {
                    const win = lane === "codex" ? paneLive?.usage?.chatgptWindow : lane === "sub" ? paneLive?.usage?.claudeWindow : null;
                    if (!win?.windows?.length) return null;
                    return (
                      <div className="mt-1 border-t pt-2" style={{ borderColor: "rgba(255,230,203,0.12)" }}>
                        <div className="hermes-mono mb-1.5 text-[10.5px] uppercase tracking-[0.2em]" style={{ color: "rgba(255,230,203, 0.75)" }}>
                          Plan usage · {win.plan ?? (lane === "codex" ? "ChatGPT" : "Claude")}
                        </div>
                        {win.windows.map((w: any, wi: number) => {
                          // `source` is "oauth" when this is the real
                          // server-side number and "estimate" when it is a guess
                          // derived from counting local log lines against an
                          // assumed cap. Those two were rendered identically —
                          // same bar, same percentage, no qualifier — so a guess
                          // of 54% (or a saturated 100%) looked exactly like
                          // fact while the CLI was truthfully reporting 13%.
                          // The stored OAuth token had been expired since June,
                          // every refresh 401'd, and nothing anywhere said so.
                          // An estimate now looks like an estimate.
                          const live = w.source === "oauth";
                          const pct = Number(w.pct) || 0;
                          return (
                          <div key={wi} className="mb-1.5">
                            <div className="flex justify-between text-[10.5px]" style={{ color: "rgba(255,230,203, 0.88)" }}>
                              <span>{w.label}</span>
                              <span>
                                {resetClock(w.resetsAt) ? `resets ${resetClock(w.resetsAt)} · ` : ""}
                                {typeof w.pct === "number" ? `${live ? "" : "≈"}${w.pct}%` : ""}
                                {!live && (
                                  <span
                                    title="Not a real reading — the plan-usage API rejected the stored token, so this is counted from local logs against an assumed cap. Run `claude login`, then re-run the aggregator."
                                    style={{ color: "rgba(255,210,30,0.88)" }}
                                  >
                                    {" "}guess
                                  </span>
                                )}
                              </span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(255,230,203,0.12)" }}>
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${Math.min(100, Math.max(1, pct))}%`,
                                  // A guess gets a flat, unalarming fill: an
                                  // estimate crossing 80% must not paint the
                                  // same red panic as a measured 80%.
                                  background: !live
                                    ? "rgba(255,230,203,0.30)"
                                    : pct > 80
                                      ? "#ff9d8f"
                                      : pct > 55
                                        ? AMBER
                                        : "#7be0c8",
                                }}
                              />
                            </div>
                          </div>
                          );
                        })}
                        <div className="text-[10.5px]" style={{ color: "rgba(255,230,203, 0.62)" }}>
                          synced by the aggregator — refresh on Dashboard for live numbers
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            </>
          )}
          <button
            type="button"
            onClick={() => setUsageOpen((v) => !v)}
            className="flex items-center gap-1.5"
            title={ctxTitle}
            aria-expanded={usageOpen}
          >
            {sending && (
              <span
                className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
                style={{ background: backendCfg.tone }}
              />
            )}
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6.2" fill="none" stroke="rgba(255,230,203,0.32)" strokeWidth="2" />
              <circle
                cx="8"
                cy="8"
                r="6.2"
                fill="none"
                stroke={ctxTone}
                strokeWidth="2"
                strokeDasharray={`${(ctxPct / 100) * 38.9} 38.9`}
                strokeLinecap="round"
                transform="rotate(-90 8 8)"
              />
            </svg>
            {ctxBreakdown.reported === null ? "≈" : ""}
            {ctxUsedTokens >= 1000 ? `${(ctxUsedTokens / 1000).toFixed(1)}k` : ctxUsedTokens} tok ·{" "}
            {/* Same formatter as the panel this button opens. It used to divide
                by 1,048,576 — a BYTE constant applied to a token count — so a
                1,050,000-token window read "1M" on the pill and "1.1M" two
                lines below it, in the same view, for the same number. */}
            {fmtCtxTokens(ctxTokens)} ctx · {ctxPct}%
            <ChevronDown
              className="h-3 w-3 transition-transform"
              style={{ transform: usageOpen ? "rotate(180deg)" : "none" }}
            />
          </button>
          </span>
          <span>{model ? shortModel(model.name) : ""}</span>
          {!lastCost && costUnreported && (
            // Never $0.0000. A turn whose final provider call errored comes
            // back with every usage field zeroed, and a confident zero is a
            // worse lie than an honest blank.
            <span
              title={`The ${costUnreported} lane reported no cost for the last turn — unknown, not free.`}
              style={{ color: "rgba(255,230,203, 0.5)" }}
            >
              $—
            </span>
          )}
          {lastCost && (
            <span title="Cost of the last turn (reported by the harness)" style={{ color: "rgba(255,210,30, 0.88)" }}>
              ${lastCost}
            </span>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

// ── Shell: sessions rail + up to 3 panes + brain overlay + voice ────────────
export function HomeCommand() {
  const liveData = useLiveData();
  const ld = liveData as any;
  const queryClient = useQueryClient();

  const liveGraphs: KnowledgeGraph[] = Array.isArray(ld?.memory?.knowledge?.graphs)
    ? ld.memory.knowledge.graphs.filter((g: KnowledgeGraph) => g?.notes?.length > 0)
    : [];
  const graphs = liveGraphs.length > 0 ? liveGraphs : [knowledgeDemo as KnowledgeGraph];
  const isDemo = liveGraphs.length === 0;
  const hasPinecone =
    (ld?.memory?.stats?.pineconeIndexes ?? 0) > 0 ||
    ld?.detection?.memoryStores?.pinecone?.hasKey === true;

  const [railOpen, setRailOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return localStorage.getItem("claude-os.home.rail-open") !== "false";
    } catch {
      return true;
    }
  });
  const sessionsQ = useHermesSessionList();
  const [claudeChats, setClaudeChats] = useState<ClaudeChatRow[]>([]);
  useEffect(() => {
    setClaudeChats(readClaudeChats());
  }, []);
  // The server-side registry. Every /__claude_chat turn writes a row there,
  // including the ones a script started — which is the whole point: those runs
  // used to complete perfectly and leave no trace anywhere in the UI.
  const [serverChats, setServerChats] = useState<ServerChatRow[]>([]);
  const loadServerChats = useCallback(async () => {
    try {
      const t = await fetch("/__token").then((r) => r.json());
      const r = await fetch("/__claude_chats", { headers: { "X-Claude-OS-Token": t?.token ?? "" } });
      if (!r.ok) return;
      const j = (await r.json()) as { chats?: ServerChatRow[] };
      if (Array.isArray(j.chats)) setServerChats(j.chats);
    } catch {
      /* the rail still has its local rows */
    }
  }, []);
  useEffect(() => {
    void loadServerChats();
    const iv = setInterval(() => void loadServerChats(), 10_000);
    return () => clearInterval(iv);
  }, [loadServerChats]);
  const refreshSessions = () => {
    setTitlesTick((n) => n + 1);
    setClaudeChats(readClaudeChats());
    void loadServerChats();
    void queryClient.invalidateQueries({ queryKey: ["home-hermes-sessions"] });
  };

  const [titlesTick, setTitlesTick] = useState(0);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; key: string; backend: BackendId; id: string; title: string } | null>(null);
  // Which chats have a child process alive right now. A chat whose agent is
  // still working must never render as idle — including chats nobody has open.
  const liveRunsQ = useQuery<{ runs: Array<{ chatId: string; sessionId: string; startedAt: number }> }>({
    queryKey: ["sessions-live"],
    queryFn: async () => {
      const r = await fetch("/__sessions_live");
      if (!r.ok) throw new Error(`status ${r.status}`);
      return r.json();
    },
    refetchInterval: 5_000,
    staleTime: 0,
    retry: 0,
  });
  // "working — 12m" has to keep counting between polls, so the rail carries its
  // own half-minute clock rather than freezing at whatever the last fetch said.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(iv);
  }, []);
  const liveById = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of liveRunsQ.data?.runs ?? []) {
      if (r.sessionId) m.set(r.sessionId, r.startedAt);
      if (r.chatId) m.set(r.chatId, r.startedAt);
    }
    return m;
  }, [liveRunsQ.data]);
  // A rail row is keyed by "session id if there is one, chat id otherwise", but
  // cancelling needs the real chatId — that's what the server files runs under.
  // /__sessions_live reports both, so resolve rather than guess.
  const chatIdForRow = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of liveRunsQ.data?.runs ?? []) {
      if (!r.chatId) continue;
      if (r.sessionId) m.set(r.sessionId, r.chatId);
      m.set(r.chatId, r.chatId);
    }
    return m;
  }, [liveRunsQ.data]);
  // Stop a chat this pane may never have been attached to — a script-started
  // run, or one wedged mid-turn. Before this, the only Stop in the whole app
  // lived inside an open chat's composer.
  const stopChat = useCallback(
    async (rowId: string) => {
      const target = chatIdForRow.get(rowId) ?? rowId;
      try {
        const t = await fetch("/__token").then((r) => r.json());
        await fetch("/__claude_abort", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Claude-OS-Token": t?.token ?? "" },
          body: JSON.stringify({ chatId: target }),
        });
      } catch {
        /* the rail refetch below shows whatever actually happened */
      }
      setTimeout(() => void liveRunsQ.refetch(), 400);
    },
    [chatIdForRow, liveRunsQ],
  );

  // Server rows + local rows, deduped. A chat is the same chat whether the
  // server knows it by session id or the browser banked it by session id, so
  // the merge key is "session id if there is one, chat id otherwise". The
  // server wins on conflict — it saw the turn, localStorage only saw this tab —
  // except for the approval stance, which only the pane ever knew.
  const mergedClaudeChats = useMemo<ClaudeChatRow[]>(() => {
    const byKey = new Map<string, ClaudeChatRow>();
    const knownChatIds = new Set<string>();
    for (const s of serverChats) {
      const id = s.sessionId || s.chatId;
      if (!id) continue;
      knownChatIds.add(s.chatId);
      byKey.set(id, {
        id,
        chatId: s.chatId,
        title: s.title || s.lastPrompt || "Untitled chat",
        ts: s.updatedAt || s.createdAt || 0,
        model: s.model || undefined,
        origin: s.origin,
      });
    }
    for (const c of claudeChats) {
      const existing = byKey.get(c.id);
      if (existing) {
        // Keep what only the browser knows.
        if (!existing.toolMode && c.toolMode) existing.toolMode = c.toolMode;
        if (!existing.model && c.model) existing.model = c.model;
        continue;
      }
      if (knownChatIds.has(c.id)) continue;
      byKey.set(c.id, c);
    }
    return [...byKey.values()];
  }, [claudeChats, serverChats]);

  const rail = useMemo(() => {
    const overrides = readTitles();
    const withTitle = (key: string, fallback: string) => overrides[key]?.t ?? fallback;
    const hermes = (sessionsQ.data?.sessions ?? []).map((s) => ({
      backend: "hermes" as BackendId,
      id: s.id,
      title: withTitle(`hermes-${s.id}`, cleanTitle(s.firstUserMessage)),
      seed: s.firstUserMessage ?? "",
      sub: `${relTime(s.lastUpdated)} · ${s.messageCount} msgs${s.model ? ` · ${shortModel(s.model)}` : ""}`,
      ts: s.lastUpdated ? new Date(s.lastUpdated).getTime() : 0,
    }));
    const claude = mergedClaudeChats.map((c) => ({
      backend: "claude" as BackendId,
      id: c.id,
      // Titles banked BEFORE cleanTitle learned to read YAML frontmatter are
      // still on disk as the raw "name: <slug>" line, so sanitize on the way
      // out too. A title the user typed themselves still wins — overrides are
      // checked first and never rewritten.
      title: withTitle(`claude-${c.id}`, cleanTitle(c.title)),
      seed: c.title,
      model: c.model,
      toolMode: c.toolMode,
      origin: c.origin,
      sub: `${relTime(c.ts)} · resumable`,
      ts: c.ts,
    }));
    const hidden = readHidden();
    return [...hermes, ...claude]
      .filter((r) => !hidden.has(`${r.backend}-${r.id}`))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 40);
  }, [sessionsQ.data, mergedClaudeChats, titlesTick]);

  // One-off housekeeping (Jul 2026): drop conversations older than three days
  // from the rail. Runs once per browser (flagged), leaves on-disk agent
  // history untouched — same semantics as right-click → Delete.
  useEffect(() => {
    if (!sessionsQ.data) return;
    try {
      if (localStorage.getItem("claude-os.prune-3d.v1")) return;
      const cutoff = Date.now() - 3 * 86_400_000;
      let pruned = 0;
      for (const s of sessionsQ.data.sessions ?? []) {
        const ts = s.lastUpdated ? new Date(s.lastUpdated).getTime() : 0;
        if (ts && ts < cutoff) {
          hideChat(`hermes-${s.id}`);
          pruned++;
        }
      }
      for (const c of readClaudeChats()) {
        if (c.ts && c.ts < cutoff) {
          hideChat(`claude-${c.id}`);
          removeClaudeChat(c.id);
          pruned++;
        }
      }
      localStorage.setItem("claude-os.prune-3d.v1", "1");
      if (pruned > 0) {
        setClaudeChats(readClaudeChats());
        setTitlesTick((n) => n + 1);
      }
    } catch {
      /* localStorage may be disabled */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsQ.data]);

  // Background retitler — every rail chat still wearing its first sentence
  // gets a real 3-5 word AI summary (Haiku, Kimi fallback), saved as a
  // non-manual override so a hand-rename always wins.
  const titledRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const overrides = readTitles();
    const todo = rail
      .filter((r) => !overrides[`${r.backend}-${r.id}`] && !titledRef.current.has(`${r.backend}-${r.id}`))
      .slice(0, 15);
    if (todo.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const r of todo) {
        if (cancelled) return;
        const key = `${r.backend}-${r.id}`;
        titledRef.current.add(key);
        try {
          let user = (r as { seed?: string }).seed ?? "";
          let assistant = "";
          if (r.backend === "claude") {
            // Pull the real first exchange from the on-disk transcript so the
            // summary reflects the conversation, not just the opener.
            const s = await fetch(`/__claude_session?id=${encodeURIComponent(r.id)}`)
              .then((x) => (x.ok ? x.json() : null))
              .catch(() => null);
            const msgs: Array<{ role: string; content: string }> = s?.messages ?? [];
            user = msgs.find((m) => m.role === "user")?.content ?? user;
            assistant = msgs.find((m) => m.role === "assistant")?.content ?? "";
          }
          if (!user.trim()) continue;
          const t = await fetch("/__chat_title", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user: user.slice(0, 600), assistant: assistant.slice(0, 600) }),
          })
            .then((x) => (x.ok ? x.json() : null))
            .catch(() => null);
          if (cancelled) return;
          if (t?.title) {
            saveTitle(key, t.title, false);
            setTitlesTick((n) => n + 1);
          }
        } catch {
          /* keep the fallback title */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsQ.data, mergedClaudeChats]);

  // Panes — up to 4. Two panes honour the chosen orientation (side-by-side
  // or stacked); three-plus snap to a 2×2 grid.
  const [paneCount, setPaneCount] = useState(1);
  const [orient, setOrient] = useState<"cols" | "rows">("cols");
  const [focusedPane, setFocusedPane] = useState(0);
  const [loadReqs, setLoadReqs] = useState<
    Array<{ nonce: number; backend: BackendId; sessionId: string; title: string; model?: string; toolMode?: ToolMode } | null>
  >([null, null, null, null]);
  const loadNonce = useRef(0);

  function openSession(backend: BackendId, sessionId: string, title: string, model?: string, toolMode?: ToolMode) {
    loadNonce.current += 1;
    const target = Math.min(focusedPane, paneCount - 1);
    setLoadReqs((prev) => {
      const next = [...prev];
      next[target] = { nonce: loadNonce.current, backend, sessionId, title, model, toolMode };
      return next;
    });
  }

  // Jarvis — voice + memory as one system. `jarvisMode` picks the lens.
  const [jarvis, setJarvis] = useState(false);
  const [jarvisMode, setJarvisMode] = useState<"voice" | "memory">("memory");
  const [jarvisState, setJarvisState] = useState<"idle" | "thinking" | "responding">("idle");
  const [pulledNotes, setPulledNotes] = useState<Array<{ title: string; id: string; vault: string }>>([]);
  const voiceSessionRef = useRef<string | null>(null);
  const [focusQuery, setFocusQuery] = useState("");
  const [focusNonce, setFocusNonce] = useState(0);
  const lastFlyRef = useRef(0);
  const [selNode, setSelNode] = useState<MemNode | null>(null);
  const [noteBody, setNoteBody] = useState<string | null>(null);
  const lexicon = useMemo(() => {
    const out: Array<{ title: string; lower: string; id: string; vault: string }> = [];
    for (const g of graphs) {
      for (const n of g.notes ?? []) {
        if (n.title && n.title.length >= 4)
          out.push({
            title: n.title,
            lower: n.title.toLowerCase(),
            id: (n as any).id ?? n.title,
            vault: (g as any).vault ?? "",
          });
      }
    }
    return out;
  }, [graphs]);

  // Voice request → Hermes, with its own persistent session + yolo so it can
  // actually act. On completion the reply is mined for real note titles —
  // those become the "pulled up" file chips and drive brain fly-bys.
  async function voiceAsk(request: string): Promise<string> {
    setJarvisState("thinking");
    try {
      let token: string | undefined;
      try {
        token = (await fetch("/__token").then((r) => r.json()))?.token;
      } catch {
        /* loopback token optional */
      }
      const response = await fetch("/__hermes_chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "X-Claude-OS-Token": token } : {}) },
        body: JSON.stringify({
          prompt: request,
          yolo: true,
          ...(voiceSessionRef.current ? { sessionId: voiceSessionRef.current } : {}),
        }),
      });
      if (!response.ok || !response.body) return "The agent endpoint returned an error.";
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const evt of events) {
          let eventName = "chunk";
          const dataLines: string[] = [];
          for (const line of evt.split("\n")) {
            if (line.startsWith("event: ")) eventName = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
          }
          const data = stripAnsi(dataLines.join("\n"));
          if (eventName === "chunk" && data.length > 0) accumulated += data + "\n";
          else if (eventName === "info" && data) {
            const mm = data.match(/session_id:\s*([A-Za-z0-9_-]{6,})/);
            if (mm?.[1]) voiceSessionRef.current = mm[1];
          }
        }
      }
      setJarvisState("responding");
      window.setTimeout(() => setJarvisState("idle"), 2500);
      const hay = accumulated.toLowerCase();
      const hits = lexicon.filter((e) => hay.includes(e.lower)).slice(0, 4);
      if (hits.length > 0) {
        setPulledNotes(hits.map(({ title, id, vault }) => ({ title, id, vault })));
        setFocusQuery(hits.map((h) => h.title).join(" | "));
        setFocusNonce((n) => n + 1);
      }
      return stripNoise(accumulated) || "Done.";
    } catch {
      setJarvisState("idle");
      return "I couldn't reach the agent just now.";
    }
  }

  const flyForText = (text: string) => {
    const now = Date.now();
    if (now - lastFlyRef.current < 2500) return;
    const hay = text.slice(-400).toLowerCase();
    const hits: string[] = [];
    for (const entry of lexicon) {
      if (hits.length >= 3) break;
      if (hay.includes(entry.lower)) hits.push(entry.title);
    }
    if (hits.length === 0) return;
    lastFlyRef.current = now;
    setFocusQuery(hits.join(" | "));
    setFocusNonce((n) => n + 1);
  };

  useEffect(() => {
    setNoteBody(null);
    const id = ((((selNode as any)?.noteId as string) ?? (selNode as any)?.name ?? "") as string).replace(/\.md$/i, "");
    const vault = ((selNode as any)?.vault as string) ?? "";
    if (!id) return;
    let cancelled = false;
    fetch(`/__memory_note?vault=${encodeURIComponent(vault)}&id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setNoteBody(typeof d?.content === "string" ? d.content : null);
      })
      .catch(() => {
        if (!cancelled) setNoteBody(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selNode]);

  useEffect(() => {
    if (!jarvis) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setJarvis(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jarvis]);

  function openJarvis(mode: "voice" | "memory") {
    setJarvisMode(mode);
    setJarvis(true);
  }

  return (
    <div
      className="hermes-skin relative flex overflow-hidden h-full min-h-[540px]"
      style={{ background: `linear-gradient(180deg, ${BG} 0%, #04100F 100%)` }}
    >
      {/* ── Sessions rail (collapsible) ───────────────────────────────── */}
      <aside
        className={`hidden md:flex ${railOpen ? "w-60" : "w-11"} shrink-0 flex-col border-r transition-all`}
        style={{ borderColor: HAIR_SOFT }}
      >
        <div className={`${railOpen ? "px-4" : "px-0 justify-center"} pt-4 pb-2 flex items-center`}>
          {railOpen && (
            <span
              className="flex-1 text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "rgba(255,230,203, 0.75)" }}
            >
              Chats
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              setRailOpen((v) => {
                try {
                  localStorage.setItem("claude-os.home.rail-open", String(!v));
                } catch {
                  /* localStorage may be disabled */
                }
                return !v;
              });
            }}
            title={railOpen ? "Minimise chats" : "Show chats"}
            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors"
            style={{ color: "rgba(255,230,203, 0.75)" }}
          >
            {railOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div
          className={`flex-1 overflow-y-auto px-2 pb-3 space-y-0.5 ${railOpen ? "" : "hidden"}`}
          style={{ fontFamily: MD_SANS }}
        >
          {rail.map((s) => (
            <button
              key={`${s.backend}-${s.id}`}
              type="button"
              onClick={() => openSession(s.backend, s.id, s.title, (s as any).model, (s as any).toolMode)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu({ x: e.clientX, y: e.clientY, key: `${s.backend}-${s.id}`, backend: s.backend, id: s.id, title: s.title });
              }}
              className="group w-full text-left rounded-lg px-2 py-[7px] transition-colors flex items-center gap-2"
              style={{ background: "transparent" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,230,203,0.05)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {(() => {
                const brand =
                  s.backend === "claude" && (s as any).model && !/^claude/.test((s as any).model)
                    ? brandLogo((s as any).model)
                    : null;
                return brand ? (
                  <span
                    className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded"
                    style={{ background: "rgba(255,230,203,0.1)" }}
                  >
                    <img
                      src={brand}
                      alt=""
                      className="h-[11px] w-[11px] object-contain"
                      style={{ filter: DARK_GLYPHS.has(brand) ? "invert(0.92) sepia(0.15) brightness(1.05)" : undefined }}
                    />
                  </span>
                ) : (
                  <img
                    src={s.backend === "hermes" ? hermesPortrait : claudeLogo}
                    alt={s.backend}
                    className="h-[15px] w-[15px] rounded object-cover shrink-0"
                    style={{ opacity: 0.85 }}
                  />
                );
              })()}
              {renamingKey === `${s.backend}-${s.id}` ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      saveTitle(`${s.backend}-${s.id}`, renameDraft.trim() || s.title, true);
                      setRenamingKey(null);
                      setTitlesTick((n) => n + 1);
                    }
                    if (e.key === "Escape") setRenamingKey(null);
                  }}
                  onBlur={() => {
                    saveTitle(`${s.backend}-${s.id}`, renameDraft.trim() || s.title, true);
                    setRenamingKey(null);
                    setTitlesTick((n) => n + 1);
                  }}
                  className="min-w-0 flex-1 rounded bg-transparent text-[11.5px] leading-tight outline-none"
                  style={{ color: CREAM, border: `1px solid rgba(255,230,203,0.3)`, padding: "1px 4px" }}
                />
              ) : (
                <span
                  className="min-w-0 flex-1 truncate text-[11.5px] leading-tight"
                  style={{ color: "rgba(255,230,203, 0.88)" }}
                  title={s.title}
                >
                  {s.title}
                </span>
              )}
              {(s as { origin?: string }).origin === "headless" && (
                <span
                  className="hermes-mono flex shrink-0 items-center gap-[3px] rounded px-1 py-[1px] text-[10px] uppercase tracking-wider"
                  style={{
                    border: "1px solid rgba(255,230,203,0.22)",
                    color: "rgba(255,230,203, 0.75)",
                  }}
                  title="Started by a script, not from this window — it ran headless and the server logged it here"
                >
                  <TerminalIcon className="h-2 w-2" /> cli
                </span>
              )}
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  setRenamingKey(`${s.backend}-${s.id}`);
                  setRenameDraft(s.title);
                }}
                title="Rename chat"
                className="hidden shrink-0 group-hover:flex h-4 w-4 items-center justify-center rounded"
                style={{ color: "rgba(255,230,203, 0.75)" }}
              >
                <Pencil className="h-2.5 w-2.5" />
              </span>
              {(() => {
                const startedAt = liveById.get(s.id);
                if (startedAt === undefined)
                  return (
                    <span className="hermes-mono shrink-0 text-[10.5px] group-hover:hidden" style={{ color: "rgba(255,230,203, 0.62)" }}>
                      {relTime(s.ts)}
                    </span>
                  );
                const mins = Math.max(0, Math.floor((nowTick - startedAt) / 60_000));
                return (
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span
                      className="hermes-mono flex shrink-0 items-center gap-1 text-[10.5px]"
                      style={{ color: "rgba(255,210,30,0.9)" }}
                      title="This chat's agent is still working — click to re-join it"
                    >
                      <span className="hc-pulse" style={{ background: AMBER }} />
                      working — {mins}m
                    </span>
                    {/* Stopping a run used to require opening it first. A chat a
                        script started, or one wedged mid-turn, could be sitting
                        here burning credits with no control anywhere on screen.
                        A span, not a button: this row IS a button already. */}
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label="Stop this chat's agent"
                      title="Stop this agent now"
                      onClick={(e) => {
                        e.stopPropagation();
                        void stopChat(s.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          void stopChat(s.id);
                        }
                      }}
                      className="hidden shrink-0 group-hover:flex h-4 w-4 items-center justify-center rounded"
                      style={{ color: "rgba(255,150,120,0.9)" }}
                    >
                      <Square className="h-2 w-2" />
                    </span>
                  </span>
                );
              })()}
            </button>
          ))}
          {rail.length === 0 && (
            <div className="px-2.5 py-2 text-[11.5px]" style={{ color: "rgba(255,230,203, 0.62)" }}>
              No chats yet — say something.
            </div>
          )}
        </div>
        {/* Rail footer — brain · voice · split */}
        <div
          className={`${railOpen ? "flex" : "hidden"} items-center gap-1.5 px-3 py-3 border-t`}
          style={{ borderColor: HAIR_SOFT }}
        >
          <button
            type="button"
            onClick={() => openJarvis("memory")}
            title="Jarvis — memory brain"
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-[10.5px] hermes-mono uppercase tracking-wider transition-colors"
            style={{ border: `1px solid ${HAIR}`, color: "rgba(255,230,203, 0.88)" }}
          >
            <Brain className="h-3.5 w-3.5" /> Brain
          </button>
          <button
            type="button"
            onClick={() => openJarvis("voice")}
            title="Jarvis — voice mode"
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-[10.5px] hermes-mono uppercase tracking-wider transition-colors"
            style={{ border: `1px solid ${HAIR}`, color: "rgba(255,230,203, 0.88)" }}
          >
            <Mic className="h-3.5 w-3.5" /> Voice
          </button>
          <button
            type="button"
            onClick={() => {
              setOrient("cols");
              setPaneCount((c) => (c >= 4 ? 4 : c + 1));
            }}
            disabled={paneCount >= 4}
            title="Split right — run another agent side by side"
            className="flex h-8 w-9 items-center justify-center rounded-lg transition-colors disabled:opacity-30"
            style={{ border: `1px solid ${HAIR}`, color: "rgba(255,230,203, 0.88)" }}
          >
            <Columns2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setOrient("rows");
              setPaneCount((c) => (c >= 4 ? 4 : c + 1));
            }}
            disabled={paneCount >= 4}
            title="Split down — stack another agent below"
            className="flex h-8 w-9 items-center justify-center rounded-lg transition-colors disabled:opacity-30"
            style={{ border: `1px solid ${HAIR}`, color: "rgba(255,230,203, 0.88)" }}
          >
            <Rows2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </aside>

      {/* ── Panes ─────────────────────────────────────────────────────── */}
      <div
        className={
          paneCount >= 3
            ? "grid flex-1 min-w-0 grid-cols-2 grid-rows-2"
            : orient === "rows"
              ? "flex flex-1 min-w-0 flex-col"
              : "flex flex-1 min-w-0"
        }
      >
        {Array.from({ length: paneCount }, (_, i) => (
          <div
            key={i}
            className="flex flex-1 min-w-0 min-h-0"
            style={{
              borderLeft:
                (paneCount >= 3 && i % 2 === 1) || (paneCount < 3 && orient === "cols" && i > 0)
                  ? `1px solid ${HAIR_SOFT}`
                  : "none",
              borderTop:
                (paneCount >= 3 && i >= 2) || (paneCount < 3 && orient === "rows" && i > 0)
                  ? `1px solid ${HAIR_SOFT}`
                  : "none",
            }}
          >
            <ChatPane
              paneIndex={i}
              focused={focusedPane === i}
              showClose={paneCount > 1}
              onFocus={() => setFocusedPane(i)}
              onClose={() => {
                setPaneCount((c) => Math.max(1, c - 1));
                setFocusedPane(0);
              }}
              onStreamText={(t) => {
                if (jarvis) flyForText(t);
              }}
              onSessionsChanged={refreshSessions}
              loadReq={loadReqs[i]}
            />
          </div>
        ))}
      </div>

      {/* ── Rail context menu (right-click on a chat) ─────────────────── */}
      {ctxMenu &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[10000]" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }} />
            <div
              className="fixed z-[10001] w-[180px] overflow-hidden rounded-xl py-1"
              style={{
                left: Math.min(ctxMenu.x, window.innerWidth - 190),
                top: Math.min(ctxMenu.y, window.innerHeight - 110),
                background: "rgba(6,24,23,0.98)",
                border: "1px solid rgba(255,230,203,0.2)",
                boxShadow: "0 18px 50px rgba(0,0,0,0.6)",
                fontFamily: MD_SANS,
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setRenamingKey(ctxMenu.key);
                  setRenameDraft(ctxMenu.title);
                  setCtxMenu(null);
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-white/5"
                style={{ color: CREAM }}
              >
                <Pencil className="h-3 w-3" /> Rename
              </button>
              <button
                type="button"
                onClick={() => {
                  hideChat(ctxMenu.key);
                  if (ctxMenu.backend === "claude") removeClaudeChat(ctxMenu.id);
                  setCtxMenu(null);
                  refreshSessions();
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-white/5"
                style={{ color: "#ff9d8f" }}
              >
                <X className="h-3 w-3" /> Delete chat
              </button>
              <div className="px-3 pb-1.5 pt-0.5 text-[10.5px]" style={{ color: "rgba(255,230,203, 0.62)" }}>
                Removes it from this list — agent history on disk is untouched.
              </div>
            </div>
          </>,
          document.body,
        )}

      {/* ── Jarvis brain overlay ──────────────────────────────────────────
          Portaled to <body>: .hermes-skin > * forces position:relative on
          direct children, which silently defeats `fixed` and traps the
          overlay inside the pane column. */}
      {jarvis &&
        typeof document !== "undefined" &&
        createPortal(
        <div className="fixed inset-0 z-[9990]" style={{ background: "#04100F" }}>
          {jarvisMode === "memory" ? (
            /* The full Brain system — its own search, layer pills (every
               vault + Claude + Pinecone), knowledge-explorer rail and
               inspector. It portals itself fullscreen; its exit closes
               Jarvis. */
            <MemoryBrain
              graphs={graphs}
              isDemo={isDemo}
              hasPinecone={hasPinecone}
              focusQuery={focusQuery}
              focusNonce={focusNonce}
              onClose={() => setJarvis(false)}
            />
          ) : (
            <Suspense fallback={<MemoryGraphLoader height={560} />}>
              <IntelligencePortal
                state={jarvisState}
                demo={false}
                onVoiceRequest={(request: string) => voiceAsk(request)}
                onClose={() => setJarvis(false)}
              />
            </Suspense>
          )}

          {/* Mode switch + exit — always visible. In voice mode it drops
              below the portal's own header row (design/stage selectors) so
              the two never overlap. */}
          <div
            className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full p-1"
            style={{
              top: jarvisMode === "voice" ? 62 : 16,
              background: "rgba(4,16,15,0.75)",
              border: `1px solid ${HAIR}`,
              backdropFilter: "blur(8px)",
              zIndex: 300,
            }}
          >
            {(
              [
                { id: "voice" as const, label: "Voice", Icon: Mic },
                { id: "memory" as const, label: "Memory", Icon: Brain },
              ]
            ).map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setJarvisMode(id)}
                className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[10.5px] hermes-mono uppercase tracking-wider transition-colors"
                style={{
                  background: jarvisMode === id ? "rgba(255,230,203,0.14)" : "transparent",
                  color: jarvisMode === id ? CREAM : "rgba(255,230,203,0.55)",
                }}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setJarvis(false)}
              className="ml-1 flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[10.5px] hermes-mono uppercase tracking-wider transition-colors"
              style={{ border: `1px solid rgba(255,230,203,0.3)`, color: CREAM }}
            >
              <X className="h-3.5 w-3.5" /> Exit · Esc
            </button>
          </div>

          {/* Files Jarvis pulled up while talking — click to open */}
          {pulledNotes.length > 0 && (
            <div className="absolute bottom-5 left-5 z-20 flex max-w-[320px] flex-col gap-1.5">
              <div
                className="hermes-mono text-[10.5px] uppercase tracking-[0.22em]"
                style={{ color: "rgba(255,230,203, 0.75)" }}
              >
                Pulled from memory
              </div>
              {pulledNotes.map((n) => (
                <button
                  key={`${n.vault}-${n.id}`}
                  type="button"
                  onClick={() => setSelNode({ name: n.title, noteId: n.id, vault: n.vault } as any)}
                  className="truncate rounded-lg px-3 py-2 text-left text-[12px] transition-colors"
                  style={{
                    background: "rgba(4,16,15,0.8)",
                    border: `1px solid ${HAIR}`,
                    color: "rgba(255,230,203,0.85)",
                    backdropFilter: "blur(8px)",
                  }}
                >
                  {n.title}
                </button>
              ))}
            </div>
          )}

          {selNode && (
            <div
              className="absolute top-0 right-0 bottom-0 z-30 w-[min(380px,90%)] border-l flex flex-col"
              style={{
                borderColor: HAIR,
                background: "rgba(4,16,15,0.85)",
                backdropFilter: "blur(10px)",
              }}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: HAIR_SOFT }}>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium truncate" style={{ color: CREAM }}>
                    {(selNode as any).name ?? (selNode as any).id}
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.18em]" style={{ color: "rgba(255,230,203, 0.62)" }}>
                    {(selNode as any).vault ?? "memory"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelNode(null)}
                  className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
                  style={{ color: "rgba(255,230,203, 0.75)" }}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-3">
                {noteBody === null ? (
                  <div className="flex items-center gap-2 text-[12px]" style={{ color: "rgba(255,230,203, 0.75)" }}>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading note…
                  </div>
                ) : (
                  <pre
                    className="whitespace-pre-wrap text-[12.5px] leading-relaxed font-sans"
                    style={{ color: "rgba(243,233,218,0.88)" }}
                  >
                    {noteBody}
                  </pre>
                )}
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}

    </div>
  );
}
