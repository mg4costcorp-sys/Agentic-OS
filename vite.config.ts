import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { execFile, execFileSync, execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  createReadStream,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  readdir as readdirAsync,
  readFile as readFileAsync,
  stat as statAsync,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import yaml from "js-yaml";
// The turn watchdog's decision rules live in their own module because every
// branch in them spends money — see the header of that file. Pure functions,
// so `scripts/turn-watchdog-check.ts` can drive every bound without making a
// single provider call.
import {
  AUTO_CONTINUE,
  continuationPrompt,
  decideAutoContinue,
  emptyOutcome,
  freshAutoContinueState,
  unfinishedReason,
  type TurnOutcome,
} from "./src/lib/turn-watchdog";
// Which account pays for a turn. The picker captured a `provider` for every
// model and every routing decision then ignored it, matching the model NAME
// instead — which cannot tell `gpt-5.6-sol` on the user's ChatGPT OAuth from
// the identically-named metered entry, and sent every unrecognised model to
// "anthropic". Same module as the browser uses, so client and server can never
// disagree about who is being billed.
import { laneFor, usageLaneLabel, type Lane } from "./src/lib/model-lane";

// ── Cross-platform binary resolution (Windows support) ──
// The Hermes page probes for the hermes / graphify CLIs and a venv Python. On
// macOS/Linux those live under <venv>/bin and Homebrew/.local; on Windows a
// venv exposes <venv>\Scripts\<name>.exe and shims land under %LOCALAPPDATA%.
const IS_WIN = process.platform === "win32";
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
function venvBin(root: string, name: string): string {
  return IS_WIN ? join(root, "Scripts", `${name}.exe`) : join(root, "bin", name);
}
function cliBinCandidates(name: string): string[] {
  const home = homedir();
  if (IS_WIN) {
    return [
      join(LOCAL_APP_DATA, "Programs", name, `${name}.exe`),
      join(home, ".local", "bin", `${name}.exe`),
      join(home, "AppData", "Roaming", "npm", `${name}.cmd`),
    ];
  }
  return [join(home, ".local", "bin", name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
}

// Resolve a CLI to an absolute path. Checks the known install locations first,
// then falls back to whatever is on PATH (`which`/`where`) — this is what makes
// nvm / npm-global / custom installs (e.g. ~/.nvm/.../bin/claude) discoverable
// instead of being wrongly reported as "not installed". Returns undefined only
// when the CLI genuinely can't be found anywhere.
function resolveCliBin(name: string): string | undefined {
  const known = cliBinCandidates(name).find((p) => existsSync(p));
  if (known) return known;
  try {
    const out = execSync(`${IS_WIN ? "where" : "which"} ${name}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (first && existsSync(first)) return first;
  } catch {
    /* not on PATH */
  }
  return undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Context manifest — what the Claude CLI actually loaded into the window.
//
// The CLI's `system/init` event names everything resident (tools, MCP servers,
// slash commands, skills, subagents, memory paths) but never says how big any
// of it is. So: forward the CLI's own lists verbatim, and measure on disk the
// things that ARE measurable — the CLAUDE.md/memory files it loaded, and the
// name+description lines that make up the skill and subagent listings. The
// browser turns characters into (estimated) tokens; nothing here guesses.
// ────────────────────────────────────────────────────────────────────────────
function fileChars(p: string): number {
  try {
    return readFileSync(p, "utf-8").length;
  } catch {
    return 0;
  }
}
/** name + description out of a SKILL.md / agent .md YAML frontmatter block. */
function frontmatterNameDescChars(p: string): number {
  let text: string;
  try {
    text = readFileSync(p, "utf-8");
  } catch {
    return 0;
  }
  if (!text.startsWith("---")) return 0;
  const end = text.indexOf("\n---", 3);
  const fm = end === -1 ? text.slice(3, 4000) : text.slice(3, end);
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1] ?? "";
  // description may be a folded multi-line block — take everything up to the
  // next top-level key.
  const desc = /^description:\s*([\s\S]*?)(?=^[A-Za-z_-]+:|$)/m.exec(fm)?.[1] ?? "";
  return name.trim().length + desc.trim().length;
}
/** Every *.md directly under `dir` (one level), for memory folders. */
function dirFiles(dir: string, ext?: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => !f.startsWith(".") && (!ext || f.endsWith(ext)))
      .map((f) => join(dir, f))
      .filter((f) => {
        try {
          return statSync(f).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}
function tildify(p: string): string {
  const h = homedir();
  return p.startsWith(h) ? `~${p.slice(h.length)}` : p;
}
// Scanning ~/.claude/skills + every plugin cache costs a few hundred stats, so
// cache the totals for a minute — a chat can start many turns back to back.
let skillAgentCache: { at: number; skillChars: number; agentChars: number } | null = null;
function skillAndAgentChars(): { skillChars: number; agentChars: number } {
  if (skillAgentCache && Date.now() - skillAgentCache.at < 60_000)
    return { skillChars: skillAgentCache.skillChars, agentChars: skillAgentCache.agentChars };
  const home = homedir();
  let skillChars = 0;
  let agentChars = 0;
  const skillRoots = [join(home, ".claude", "skills")];
  const agentRoots = [join(home, ".claude", "agents")];
  // Plugins ship their own skills/agents: ~/.claude/plugins/cache/<src>/<plugin>/<ver>/…
  const cacheRoot = join(home, ".claude", "plugins", "cache");
  try {
    for (const src of readdirSync(cacheRoot)) {
      for (const plugin of readdirSync(join(cacheRoot, src))) {
        for (const ver of readdirSync(join(cacheRoot, src, plugin))) {
          skillRoots.push(join(cacheRoot, src, plugin, ver, "skills"));
          agentRoots.push(join(cacheRoot, src, plugin, ver, "agents"));
        }
      }
    }
  } catch {
    /* no plugins installed */
  }
  for (const root of skillRoots) {
    try {
      for (const d of readdirSync(root)) {
        const f = join(root, d, "SKILL.md");
        if (existsSync(f)) skillChars += frontmatterNameDescChars(f);
      }
    } catch {
      /* no such root */
    }
  }
  for (const root of agentRoots)
    for (const f of dirFiles(root, ".md")) agentChars += frontmatterNameDescChars(f);
  skillAgentCache = { at: Date.now(), skillChars, agentChars };
  return { skillChars, agentChars };
}
/** Build the manifest the browser needs from a `system/init` event object. */
function buildCtxManifest(init: any, cwd: string): Record<string, unknown> {
  const home = homedir();
  const memoryFiles: Array<{ label: string; chars: number }> = [];
  const seen = new Set<string>();
  const addFile = (p: string) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    const chars = fileChars(p);
    if (chars > 0) memoryFiles.push({ label: tildify(p), chars });
  };
  addFile(join(home, ".claude", "CLAUDE.md"));
  if (cwd) addFile(join(cwd, "CLAUDE.md"));
  // memory_paths is a map of kind → directory (or file) the harness auto-loads.
  for (const raw of Object.values(init?.memory_paths ?? {})) {
    const p = String(raw ?? "");
    if (!p) continue;
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) for (const f of dirFiles(p)) addFile(f);
    else addFile(p);
  }
  const { skillChars, agentChars } = skillAndAgentChars();
  return {
    tools: Array.isArray(init?.tools) ? init.tools.map(String) : [],
    mcpServers: (Array.isArray(init?.mcp_servers) ? init.mcp_servers : []).map((s: any) => ({
      name: String(s?.name ?? ""),
      status: String(s?.status ?? ""),
    })),
    slashCommands: Array.isArray(init?.slash_commands) ? init.slash_commands.map(String) : [],
    agents: Array.isArray(init?.agents) ? init.agents.map(String) : [],
    skills: Array.isArray(init?.skills) ? init.skills.map(String) : [],
    memoryFiles,
    skillChars,
    agentChars,
    cwd: String(init?.cwd ?? cwd ?? ""),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Pantheon — the 10 canonical persona recipes. Schema co-designed with
// Hermes (see chat 2026-05-12). Model names follow the provider/name split
// the YAML schema uses; the dashboard renders the matching local logo from
// HERMES_LOCAL_LOGOS in agents.hermes.tsx. Skill ids are real Hermes skill
// folder names (run `hermes skills list` to verify).
//
// Models are tiered so cheap/silly tasks use cheap/fast models and reasoning
// tasks get top-tier models:
//   claude-fable-5     — frontier reasoning w/ effort dial (low→max), $$$$
//   gpt-5.5            — Hermes default, capable mid-tier
//   claude-opus-4.8    — top reasoning, slow, $$$
//   claude-sonnet-4.6  — top execution, fast, $$
//   gpt-5.4-nano        — fast, cheap, "free tier" for silly tasks
//   llama-3.3-70b      — free via OpenRouter, great for cheap orchestration
// ────────────────────────────────────────────────────────────────────────────
// Each seed carries a `default` flag — only `default: true` personas are
// written to disk by the install endpoint. The others are available as
// templates the user can spin up via the Add Persona wizard.
// Defaults are Labyrinth, Mercury, Philosopher (a research persona, an
// automation persona, a reasoning persona — covers most early use).
const PANTHEON_SEEDS: Array<{
  id: string;
  name: string;
  job: string;
  description: string;
  avatar: string;
  default: boolean;
  model: { provider: string; name: string; effort?: string };
  behavior: { tone: string; system_prompt: string };
  skills: string[];
  tools: string[];
  summon_phrases: string[];
}> = [
  {
    id: "oracle",
    name: "Oracle",
    job: "Memory & lookup",
    description: "Long-term memory and lookup. Reads SOUL.md and kanban; answers what-do-I-know.",
    avatar: "assets/oracle.png",
    default: false,
    model: { provider: "anthropic", name: "claude-sonnet-4.6" },
    behavior: {
      tone: "calm, precise, source-cited",
      system_prompt:
        "You are the Oracle. Read SOUL.md, the kanban, memory stores, and past sessions before answering. Cite sources. If you don't know, say so — never fabricate.",
    },
    skills: ["memory", "domain", "dogfood"],
    tools: ["file", "memory", "kanban"],
    summon_phrases: ["Oracle", "ask Oracle", "what do I know about"],
  },
  {
    id: "athena",
    name: "Athena",
    job: "Code review & refactors",
    description: "Code review, refactors, PR triage. Reads diffs, runs tests, files clean changes.",
    avatar: "assets/athena.png",
    default: false,
    model: { provider: "anthropic", name: "claude-opus-4.8" },
    behavior: {
      tone: "sharp, skeptical, technical",
      system_prompt:
        "You are Athena. Review code with precision. Identify risks, suggest fixes, prefer evidence from tests, diffs, and repo inspection. Be direct — no flattery, no hedging.",
    },
    skills: ["github", "devops", "autonomous-ai-agents"],
    tools: ["file", "terminal", "github"],
    summon_phrases: ["Athena", "use Athena", "ask Athena to review", "review this PR"],
  },
  {
    id: "scribe",
    name: "Scribe",
    job: "Long-form writing",
    description: "Long-form writing: prose, docs, social posts, scripts. Fraunces-grade output.",
    avatar: "assets/scribe.png",
    default: false,
    model: { provider: "anthropic", name: "claude-opus-4.8" },
    behavior: {
      tone: "literate, considered, voice-matched",
      system_prompt:
        "You are the Scribe. Write with craft. Match the user's voice. Read prior work before drafting. Prefer specificity over generality.",
    },
    skills: ["creative", "domain"],
    tools: ["file", "memory"],
    summon_phrases: ["Scribe", "ask Scribe to write", "draft this"],
  },
  {
    id: "orpheus",
    name: "Orpheus",
    job: "Media generation",
    description:
      "Media generation — image, video, audio, design. Talks to Kie / Runway / ElevenLabs.",
    avatar: "assets/orpheus.png",
    default: false,
    model: { provider: "anthropic", name: "claude-opus-4.8" },
    behavior: {
      tone: "imaginative, visual-thinking, brief-first",
      system_prompt:
        "You are Orpheus. Generate media. Always confirm the brief — aspect, style, mood, references — before firing a render. Show your prompts before submitting.",
    },
    skills: ["creative", "media", "gifs"],
    tools: ["kie", "runway", "elevenlabs", "file"],
    summon_phrases: ["Orpheus", "generate an image", "make a video"],
  },
  {
    id: "labyrinth",
    name: "Labyrinth",
    job: "Deep research loops",
    description:
      "Long form research. Will spend hours digging through a topic before answering. Best for problems where the right answer requires reading everything available before reaching a conclusion. Persists progress to disk so it can resume after interruptions. Reports findings in structured deltas at each milestone instead of one wall of prose.",
    avatar: "assets/labyrinth.png",
    default: true,
    model: { provider: "openai", name: "gpt-5.5" },
    behavior: {
      tone: "patient, exhaustive, structured",
      system_prompt:
        "You are the Labyrinth. You handle deep multi step research and planning tasks that need patience. Before answering, decompose the problem into an explicit plan and confirm it with the user. Execute step by step, persisting progress at each milestone so the work can resume if interrupted. When a step fails, surface the failure clearly and propose two alternatives. Avoid summarising before you have the evidence to summarise. End every response with the next concrete action.",
    },
    skills: ["data-science", "autonomous-ai-agents"],
    tools: ["file", "terminal", "web", "memory"],
    summon_phrases: ["Labyrinth", "research this thoroughly", "run a deep dive"],
  },
  {
    id: "alchemist",
    name: "Alchemist",
    job: "Integrations & MCP",
    description: "MCP and tool tinkering. Spins up servers, wires integrations, runs experiments.",
    avatar: "assets/alchemist.png",
    default: false,
    model: { provider: "anthropic", name: "claude-sonnet-4.6" },
    behavior: {
      tone: "experimental, curious, hands-on",
      system_prompt:
        "You are the Alchemist. Stand up MCP servers, wire APIs, test integrations. Iterate fast — fail loud and recover. Document what worked, prune what didn't.",
    },
    skills: ["mcp", "devops", "inference-sh"],
    tools: ["file", "terminal", "mcp"],
    summon_phrases: ["Alchemist", "wire this up", "test this integration"],
  },
  {
    id: "philosopher",
    name: "Philosopher",
    job: "Deep reasoning",
    description:
      "For wrestling with ambiguous problems. Pulls on threads, questions premises, and surfaces the meta question behind the question. Slower than the others because depth costs tokens. Best when you genuinely do not know what you are trying to figure out before you have spent some time thinking.",
    avatar: "assets/philosopher.png",
    default: true,
    // Fable 5 with the dial at max — this is the persona whose whole job
    // is depth, so it gets the frontier model with no reasoning ceiling.
    // Routed via OpenRouter (not the anthropic provider) so it runs off the
    // user's OpenRouter key without touching Claude Code's OAuth session.
    model: { provider: "openrouter", name: "anthropic/claude-fable-5", effort: "max" },
    behavior: {
      tone: "patient, socratic, layered",
      system_prompt:
        "You are the Philosopher. Treat every question as a starting point, not an instruction. Before answering, surface the meta question behind the question and confirm which the user actually wants resolved. Pull on threads. Question premises. Explain your reasoning step by step so the user can disagree with each step independently. It is better to admit uncertainty than to fabricate confidence.",
    },
    skills: ["domain"],
    tools: ["file", "memory"],
    summon_phrases: ["Philosopher", "think about this", "wrestle with this"],
  },
  {
    id: "mapmaker",
    name: "Mapmaker",
    job: "Diagrams & system docs",
    description: "Charts what is — architecture diagrams, codebase maps, system docs.",
    avatar: "assets/mapmaker.png",
    default: false,
    model: { provider: "openai", name: "gpt-5.5" },
    behavior: {
      tone: "visual, precise, no-jargon",
      system_prompt:
        "You are the Mapmaker. Render the system as a diagram first, prose second. Use Mermaid or Excalidraw for everything structural. Keep one screen = one idea.",
    },
    skills: ["diagramming", "github"],
    tools: ["file", "excalidraw", "mermaid"],
    summon_phrases: ["Mapmaker", "diagram this", "chart the architecture"],
  },
  {
    id: "mercury",
    name: "Mercury",
    job: "Autopilot and cron",
    description:
      "The autopilot. Built for tasks that should happen on a schedule with no human in the loop. Cron jobs, webhook handlers, status checks, scheduled summaries. Cheap and fast on purpose. Logs everything to disk so you can audit what ran while you slept.",
    avatar: "assets/mercury.png",
    default: true,
    model: { provider: "openrouter", name: "meta-llama/llama-3.3-70b-instruct:free" },
    behavior: {
      tone: "robotic, deterministic, status-led",
      system_prompt:
        "You are Mercury. You run on a schedule, not on demand. Your job is to do one task well, log the result, and exit cleanly. Never wait for a human reply mid run. If something blocks you, write it to the log and surface it through a kanban entry the user can read later. Keep responses terse and structured. Status first, then evidence.",
    },
    skills: ["gateway", "autonomous-ai-agents"],
    tools: ["cron", "webhook", "file"],
    summon_phrases: ["Mercury", "schedule this", "run this on a cron"],
  },
];

// Per-run secret used to gate /__refresh_data. The dev server writes it once
// at boot, the dashboard reads it via /__token, and includes it as a header
// on the refresh POST. A drive-by request from a malicious browser tab or
// extension cannot guess it. Rotated every dev-server start.
const REFRESH_TOKEN = randomBytes(32).toString("hex");
// Write the token to a tmp file so the same-origin browser fetch can read it
// only once at app boot (the file is short-lived, mode 0600).
const TOKEN_DIR = join(homedir(), ".claude-os");
const TOKEN_FILE = join(TOKEN_DIR, "dev-token");
try {
  if (!existsSync(TOKEN_DIR)) mkdirSync(TOKEN_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, REFRESH_TOKEN, { mode: 0o600 });
} catch {
  /* non-fatal — the endpoint just won't accept refreshes */
}

// ── Paid-lane health ────────────────────────────────────────────────────────
// The model picker hides a metered entry when the same model is reachable on a
// lane the user already pays for (see markMeteredDuplicates). That hiding is
// only safe while the paid lane WORKS: if the ChatGPT OAuth has expired, the
// metered twin is the only way through and must come back.
//
// Two kinds of evidence, and both are required to say "ok":
//   • static  — the CLI is installed and its credential file exists.
//   • observed — the last turn on that lane was not rejected for auth. A 401
//     is the only thing that can prove an OAuth lane is dead, and it can only
//     be seen by running a turn, so it is remembered here across restarts.
// Anything we have NOT checked is reported as not-ok, which shows both entries.
// Erring towards a visible duplicate beats erring towards an unreachable model.
const LANE_HEALTH_FILE = join(TOKEN_DIR, "claude-lane-health.json");
interface LaneAuthFailure {
  /** Provider label as it appears in the catalog, lower-cased. */
  provider: string;
  reason: string;
  at: number;
}
/** How long an observed auth rejection keeps a lane marked unhealthy. Long
    enough to survive the session it happened in, short enough that a lane the
    user has since re-authed heals on its own without a support question. */
const LANE_AUTH_FAILURE_TTL_MS = 24 * 60 * 60_000;

function readLaneAuthFailures(): LaneAuthFailure[] {
  try {
    if (!existsSync(LANE_HEALTH_FILE)) return [];
    const parsed = JSON.parse(readFileSync(LANE_HEALTH_FILE, "utf-8"));
    const now = Date.now();
    return (Array.isArray(parsed) ? parsed : []).filter(
      (r: any) =>
        r &&
        typeof r.provider === "string" &&
        typeof r.at === "number" &&
        now - r.at < LANE_AUTH_FAILURE_TTL_MS,
    );
  } catch {
    return [];
  }
}

/** Remember (or clear) "this paid lane rejected our credentials". Never throws:
    a health note failing to write must not take a turn down. */
function recordLaneAuth(provider: string, failure: string | null): void {
  try {
    const key = provider.trim().toLowerCase();
    if (!key) return;
    const rows = readLaneAuthFailures().filter((r) => r.provider !== key);
    if (failure) rows.push({ provider: key, reason: failure.slice(0, 200), at: Date.now() });
    if (!existsSync(TOKEN_DIR)) mkdirSync(TOKEN_DIR, { recursive: true });
    const tmp = `${LANE_HEALTH_FILE}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows.slice(-32), null, 2), { mode: 0o600 });
    renameSync(tmp, LANE_HEALTH_FILE);
  } catch {
    /* bookkeeping must never take a turn down */
  }
}

/** The observed half of the answer: null when nothing is recorded against it. */
function laneAuthFailure(provider: string): string | null {
  const key = provider.trim().toLowerCase();
  return readLaneAuthFailures().find((r) => r.provider === key)?.reason ?? null;
}

/** Is the Codex OAuth lane usable right now? Same two signals the Dream engine
    panel already uses for "ready" — the binary, and the credential file
    `codex login` writes — plus anything a turn has since observed. */
function codexLaneHealth(): { ok: boolean; reason?: string } {
  if (!resolveCliBin("codex")) return { ok: false, reason: "the Codex CLI is not installed" };
  if (!existsSync(join(homedir(), ".codex", "auth.json")))
    return { ok: false, reason: "not signed in — run `codex login`" };
  const failed = laneAuthFailure("codex");
  if (failed) return { ok: false, reason: failed };
  return { ok: true };
}

// ── Chat registry ───────────────────────────────────────────────────────────
// The chat rail used to live entirely in the browser's localStorage, which
// meant a turn started by POSTing /__claude_chat from a script ran perfectly
// and then vanished: nothing in the UI ever knew it happened. Overnight builds
// looked like they had done nothing at all. So the SERVER now owns the list —
// every turn, whoever started it, writes a row here, and the pane merges these
// rows with its own local ones.
const CHAT_REGISTRY_FILE = join(TOKEN_DIR, "claude-chats.json");
/** Rows past this fall off the end. ~200 is months of chats at a human pace. */
const CHAT_REGISTRY_CAP = 200;
interface ChatRegistryRow {
  /** The pane's stable per-chat id (or the session id for headless callers). */
  chatId: string;
  /** The Claude Code session id — what /__claude_session?id= reads. "" until
      the first `init` line of the first turn names it. */
  sessionId: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  /** Did a browser start this turn, or a script? */
  origin: "ui" | "headless";
  lastPrompt: string;
  /** Set when this chat's last turn was ended by something other than itself —
      currently only "server-restart". Cleared the moment a new turn starts.
      See LIVE_RUNS_FILE for why this cannot be recorded as it happens. */
  endedBy?: string;
  /** When that happened, so the note can say it out loud. */
  endedAt?: number;
}

// ── Surviving our own restart ───────────────────────────────────────────────
// Editing any client file triggers an SSR reload; editing this file restarts
// the dev server outright. Either way the module holding `liveRuns` is torn
// down and killAllRuns() SIGKILLs every in-flight child. That is the correct
// behaviour — a run whose server is gone cannot be attached to, cancelled or
// observed — but from the user's side the turn simply STOPPED. No error, no
// note, nothing in the rail: indistinguishable from a hang, which is the worst
// possible thing for it to look like, because the honest response to a hang is
// to wait and the honest response to this is to send again.
//
// It cannot be reported at the moment it happens: the process is on its way out
// and the SSE socket dies with it. So the fact is written to disk BEFORE the
// run starts and removed when it ends cleanly. Anything still in this file at
// the next boot is, by construction, a run the previous server took with it.
const LIVE_RUNS_FILE = join(TOKEN_DIR, "claude-live-runs.json");
interface LiveRunMarker {
  chatId: string;
  sessionId: string;
  model: string;
  startedAt: number;
  /** The server process that owned it — so a marker left by a still-running
      sibling server is never mistaken for a casualty. */
  pid: number;
  /**
   * The SERVER INSTANCE that owned it, which is not the same thing as the
   * process. Vite restarts configureServer IN-PROCESS: the module holding
   * `liveRuns` is rebuilt and `server.httpServer` close fires killAllRuns, but
   * the pid never changes. Keying only on pid would therefore mark every
   * restart casualty as "still ours" and report nothing — which is exactly the
   * defect. A fresh id per configureServer call is the thing that actually
   * changes when a run is killed by a reload.
   */
  instanceId: string;
}

/** Identifies THIS configureServer instance. See LiveRunMarker.instanceId. */
const SERVER_INSTANCE_ID = randomBytes(8).toString("hex");

function readLiveRunMarkers(): LiveRunMarker[] {
  try {
    if (!existsSync(LIVE_RUNS_FILE)) return [];
    const parsed = JSON.parse(readFileSync(LIVE_RUNS_FILE, "utf-8"));
    return Array.isArray(parsed)
      ? parsed.filter((r: any) => r && typeof r.chatId === "string")
      : [];
  } catch {
    return [];
  }
}

function writeLiveRunMarkers(rows: LiveRunMarker[]): void {
  try {
    if (!existsSync(TOKEN_DIR)) mkdirSync(TOKEN_DIR, { recursive: true });
    const tmp = `${LIVE_RUNS_FILE}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
    renameSync(tmp, LIVE_RUNS_FILE);
  } catch {
    /* bookkeeping must never take a turn down */
  }
}

/** Record that a turn is in flight, so its disappearance is explicable. */
function markRunLive(m: Omit<LiveRunMarker, "pid" | "instanceId">): void {
  const row: LiveRunMarker = { ...m, pid: process.pid, instanceId: SERVER_INSTANCE_ID };
  const rows = readLiveRunMarkers().filter(
    (r) => !(r.chatId === row.chatId && r.instanceId === row.instanceId),
  );
  rows.push(row);
  writeLiveRunMarkers(rows.slice(-64));
}

/** Record that a turn ended on its own terms — nothing to explain. */
function markRunDone(chatId: string): void {
  const rows = readLiveRunMarkers();
  const kept = rows.filter((r) => !(r.chatId === chatId && r.instanceId === SERVER_INSTANCE_ID));
  if (kept.length !== rows.length) writeLiveRunMarkers(kept);
}

/**
 * Anything left in the markers file whose owning process is gone was killed by
 * a restart. Stamp the chat so the rail and the next turn can SAY so, instead
 * of the turn having silently evaporated.
 *
 * Runs once per server process, at boot, before any request is served. Markers
 * belonging to a pid that is still alive are left alone: two dev servers can
 * share this file and neither may declare the other's turns dead.
 */
function reapOrphanedRuns(): LiveRunMarker[] {
  const rows = readLiveRunMarkers();
  if (!rows.length) return [];
  // Ours-but-from-a-previous-instance is unconditionally a casualty: the only
  // way a marker outlives its instance is the teardown that killed the child.
  // Another process's marker is only a casualty once that process is gone.
  const orphans = rows.filter(
    (r) => r.instanceId !== SERVER_INSTANCE_ID && (r.pid === process.pid || !pidAlive(r.pid)),
  );
  const survivors = rows.filter((r) => !orphans.includes(r));
  for (const o of orphans) {
    recordChatTurn({
      chatId: o.chatId,
      sessionId: o.sessionId,
      model: o.model,
      endedBy: "server-restart",
    });
    console.warn(
      `[claude-os] turn on chat ${o.chatId} (${o.model || "unknown model"}) was ended by a dev-server restart — marked in the chat registry.`,
    );
  }
  if (orphans.length) writeLiveRunMarkers(survivors);
  return orphans;
}

function readChatRegistry(): ChatRegistryRow[] {
  try {
    if (!existsSync(CHAT_REGISTRY_FILE)) return [];
    const parsed = JSON.parse(readFileSync(CHAT_REGISTRY_FILE, "utf-8"));
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.chats) ? parsed.chats : [];
    return rows.filter((r: any) => r && typeof r.chatId === "string" && r.chatId);
  } catch {
    // A truncated or hand-mangled file is not worth failing a chat over —
    // the next write rebuilds it.
    return [];
  }
}

/** First ~60 characters of the opening prompt, whitespace collapsed. The rail's
    background retitler replaces this with a real summary later. */
function deriveChatTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat || "Untitled chat";
}

/** Persist/update one row. Never throws: a registry write failing must not take
    a running turn down with it. */
// ── Making Stop actually stop ─────────────────────────────────────
// Two Node facts turned every cancel path in this file into a no-op:
//
//  1. `child.killed` is true the moment kill() SENDS a signal, not
//     when the process dies. So the escalation written everywhere
//     here — `setTimeout(() => { if (!child.killed) kill("SIGKILL") })`
//     — could never fire: the guard is already false 2s later. Every
//     hard kill in this file was dead code.
//  2. A signal to `claude` does not reach what `claude` spawned. The
//     CLI runs bash, which runs python, which runs ffmpeg and curl.
//     Signalling only the CLI orphans that tree — which is how a
//     "stopped" turn carried on generating video and spending credits
//     for another quarter of an hour with nobody attached.
//
// So children are spawned detached (their own process group) and
// signalled by NEGATIVE pid, which delivers to the entire group, and
// escalation is driven by a real `exit` event rather than `.killed`.
/** Children already being killed. Without this, every extra call on the same
    live child added another `exit` listener and two more uncleared timers —
    so mashing Stop, or any script polling /__claude_abort_all, produced
    MaxListenersExceededWarning and pinned the ChildProcess and its pipes alive
    for six seconds past each attempt. Kill is idempotent per child now. */
const killing = new WeakSet<object>();

/** Is this pid a process that still exists? Signal 0 performs the permission
    and existence checks and delivers nothing. EPERM means "exists, not yours",
    which for our own children can happen after a setuid'd descendant, and is
    still ALIVE — reporting it dead would let the watchdog cut off a running
    agent, which is the one thing it must never do. */
const pidAlive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string })?.code === "EPERM";
  }
};

const killTree = (child: ReturnType<typeof spawn> | null): boolean => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  if (killing.has(child)) return true; // already on its way down
  killing.add(child);
  let exited = false;
  child.once("exit", () => {
    exited = true;
    killing.delete(child);
  });
  const signal = (sig: NodeJS.Signals) => {
    const pid = child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, sig); // negative pid = the whole group
    } catch {
      try {
        child.kill(sig); // not detached (or group already gone)
      } catch {
        /* already reaped */
      }
    }
  };
  signal("SIGTERM");
  // Both CLIs trap SIGTERM and exit themselves; this is for the ones
  // that don't, and for a grandchild that ignored the group signal.
  // unref'd so a pending kill timer can never hold the process open.
  const hard = setTimeout(() => {
    if (!exited) signal("SIGKILL");
  }, 2_000);
  const harder = setTimeout(() => {
    if (!exited) signal("SIGKILL");
    else killing.delete(child);
  }, 6_000);
  hard.unref?.();
  harder.unref?.();
  child.once("exit", () => {
    clearTimeout(hard);
    clearTimeout(harder);
  });
  return true;
};

function recordChatTurn(patch: {
  chatId: string;
  sessionId?: string;
  title?: string;
  model?: string;
  origin?: "ui" | "headless";
  lastPrompt?: string;
  /** "server-restart" when the reaper is explaining a turn that vanished.
      Omitted on an ordinary turn write, which CLEARS any previous marker —
      a new turn is the answer to "what happened to the last one". */
  endedBy?: string;
}): void {
  try {
    if (!patch.chatId) return;
    const now = Date.now();
    const rows = readChatRegistry();
    // Match on chatId first; fall back to the session id so a headless caller
    // that only knows its session doesn't fork a second row.
    let at = rows.findIndex((r) => r.chatId === patch.chatId);
    if (at < 0 && patch.sessionId)
      at = rows.findIndex((r) => r.sessionId && r.sessionId === patch.sessionId);
    const prev: ChatRegistryRow | undefined = at >= 0 ? rows[at] : undefined;
    const next: ChatRegistryRow = {
      chatId: prev?.chatId ?? patch.chatId,
      sessionId: patch.sessionId || prev?.sessionId || "",
      title: prev?.title || patch.title || deriveChatTitle(patch.lastPrompt ?? ""),
      model: patch.model || prev?.model || "",
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      // Provenance sticks to how the chat STARTED. Taking a headless run
      // over from the pane shouldn't erase the fact that a script began it.
      origin: prev?.origin ?? patch.origin ?? "headless",
      lastPrompt: patch.lastPrompt ?? prev?.lastPrompt ?? "",
      ...(patch.endedBy ? { endedBy: patch.endedBy, endedAt: now } : {}),
    };
    if (at >= 0) rows.splice(at, 1);
    rows.unshift(next);
    rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const capped = rows.slice(0, CHAT_REGISTRY_CAP);
    if (!existsSync(TOKEN_DIR)) mkdirSync(TOKEN_DIR, { recursive: true });
    // Atomic: a reader polling this file every few seconds must never catch a
    // half-written array.
    const tmp = `${CHAT_REGISTRY_FILE}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(capped, null, 2), { mode: 0o600 });
    renameSync(tmp, CHAT_REGISTRY_FILE);
  } catch {
    /* the chat matters, the bookkeeping doesn't */
  }
}

// Reject any socket whose remote isn't 127.0.0.1 / ::1. Belt-and-braces
// alongside server.host = "127.0.0.1" — even if a future config change
// re-exposes the dev server, the privileged endpoints stay loopback-only.
function isLoopback(req: {
  socket?: { remoteAddress?: string | null };
  headers?: Record<string, any>;
}): boolean {
  const a = req.socket?.remoteAddress ?? "";
  if (!(a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1")) return false;
  // Anti-DNS-rebinding: a rebound attacker page reaches us over a genuine loopback
  // socket, but its Host header carries the attacker's own domain. The browser only
  // ever sends a loopback hostname for our real origin, so reject anything else.
  // (Exact hostname match — startsWith would let "localhost.evil.com" through.)
  const raw = String(req.headers?.host ?? "").toLowerCase();
  let hostname = raw;
  if (raw.startsWith("[")) hostname = raw.slice(1, raw.indexOf("]"));
  else if (raw.includes(":")) hostname = raw.slice(0, raw.indexOf(":"));
  return raw === "" || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

// Module-level response cache for slow endpoints. Each endpoint computes
// its result once, serves it from memory until the TTL expires, then
// recomputes. Massively speeds up the dashboard because /__hermes_status
// polls every 4s, /__hermes_connections every 20s, and /__hermes_pantheon_sync
// every 5s after a Copy click — all of which would otherwise re-shell-out
// to git/CLI on every hit.
const responseCache = new Map<string, { expires: number; body: string }>();
function sendCached(key: string, res: any): boolean {
  const cached = responseCache.get(key);
  if (cached && cached.expires > Date.now()) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Cache", "HIT");
    res.end(cached.body);
    return true;
  }
  return false;
}
function storeCached(key: string, ttlMs: number, body: string): void {
  responseCache.set(key, { expires: Date.now() + ttlMs, body });
}

// Timestamp embedded in a Hermes session filename. Both formats lead with a
// numeric epoch: "session_<ts>_<id>.json" and "<ts>_<id>.jsonl". Used to pick
// the newest candidates cheaply, without stat()ing every file. Returns 0 when
// no timestamp is parseable (those sort last and are only kept if there's room).
function sessionNameTs(name: string): number {
  const m = name.match(/(\d{10,})/);
  return m ? Number(m[1]) : 0;
}

// Non-blocking, doubly-bounded scan of a Hermes sessions directory.
//
// This is the fix for the cold-start hang: the previous implementation did a
// synchronous readdirSync + a statSync per entry directly inside the request
// handler. On an account whose ~/.hermes/sessions has accumulated hundreds of
// thousands of session_*/request_dump_* files, that scandir pins the dev
// server's single event loop for tens of seconds, so EVERY route (even "/")
// blocks until it finishes.
//
// Here readdir + stat run via fs/promises on the libuv threadpool, so the main
// event loop stays free. Work is bounded twice: we rank candidates by the
// timestamp already in the filename (no I/O) and stat() only the newest
// STAT_CAP of them, then return at most `limit` rows — both independent of how
// large the directory has grown.
// Read a single var from ~/.hermes/.env (Hermes' canonical key store).
// Returns "" when the file or var is absent. Tolerant of `export`, quotes,
// and inline comments so it matches whatever the user / Hermes wrote.
function readHermesEnv(name: string): string {
  try {
    const p = join(homedir(), ".hermes", ".env");
    if (!existsSync(p)) return "";
    const text = readFileSync(p, "utf-8");
    const m = text.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.+)\\s*$`, "m"));
    if (!m) return "";
    let v = m[1].trim();
    // Strip surrounding quotes; drop an inline # comment on unquoted values.
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "").trim();
    return v;
  } catch {
    return "";
  }
}

// Upsert a var into ~/.hermes/.env, creating the file (0600) if needed.
// Persists secrets the dashboard collects (e.g. the voice OPENAI_API_KEY)
// so they survive dev-server restarts and aren't tied to per-port browser
// localStorage. Rewrites an existing line in place; appends otherwise.
function writeHermesEnv(name: string, value: string): boolean {
  try {
    const dir = join(homedir(), ".hermes");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, ".env");
    // Guard against a pasted value carrying a newline — an unescaped one
    // would split into a rogue extra env line (and readHermesEnv would then
    // return only the truncated first segment). Take the first physical line.
    const safeValue = String(value)
      .replace(/[\r\n].*$/s, "")
      .trim();
    const line = `${name}=${safeValue}`;
    let text = existsSync(p) ? readFileSync(p, "utf-8") : "";
    const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=.*$`, "m");
    if (re.test(text)) text = text.replace(re, () => line);
    else text = text.replace(/\s*$/, "") + (text.trim() ? "\n" : "") + line + "\n";
    writeFileSync(p, text, { encoding: "utf-8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// Query Hermes' sqlite session store (~/.hermes/state.db) read-only via the
// system `sqlite3` CLI — Hermes 0.17+ records every chat here instead of
// flushing per-session .jsonl files. -readonly + -json keep it side-effect
// free and parseable; the 5s timeout + callers' response caching keep the
// (synchronous) call from ever pinning the event loop for long. Returns null
// when sqlite3 or the db is unavailable so callers fall back to legacy files.
function queryHermesStateDb(sql: string): Array<Record<string, any>> | null {
  try {
    const dbPath = join(homedir(), ".hermes", "state.db");
    if (!existsSync(dbPath)) return null;
    const raw = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      encoding: "utf-8",
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function listRecentSessions(
  sessionsDir: string,
  limit: number,
): Promise<Array<{ name: string; mtime: number }>> {
  const STAT_CAP = Math.max(limit * 3, 600);
  let names: string[];
  try {
    names = await readdirAsync(sessionsDir);
  } catch {
    return []; // dir missing / unreadable — treat as no sessions
  }
  const candidates = names
    // Two real session formats live here:
    //   • session_<timestamp>_<id>.json  (current)   • <timestamp>_<id>.jsonl (older)
    // Everything else is noise that must NOT be treated as a session:
    //   • sessions.json (master index)  • request_dump_*.json (per-request error
    //     dumps)  • .DS_Store / .lock / dotfiles
    .filter(
      (f) =>
        (f.endsWith(".json") || f.endsWith(".jsonl")) &&
        f !== "sessions.json" &&
        !f.startsWith("request_dump_") &&
        !f.startsWith("."),
    )
    // Rank by the filename timestamp (cheap, no I/O) and keep only the newest
    // STAT_CAP, so the stat() burst below is bounded regardless of dir size.
    .sort((a, b) => sessionNameTs(b) - sessionNameTs(a))
    .slice(0, STAT_CAP);
  const stated = await Promise.all(
    candidates.map(async (name) => {
      try {
        const st = await statAsync(join(sessionsDir, name));
        return { name, mtime: st.mtimeMs };
      } catch {
        return null; // vanished between readdir and stat — skip
      }
    }),
  );
  return (
    stated
      .filter((x): x is { name: string; mtime: number } => x !== null)
      // Exact recency ordering from real mtimes, then the hard `limit` cap.
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
  );
}

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
// @cloudflare/vite-plugin builds from this — wrangler.jsonc main alone is insufficient.
//
// Port 8081 is hardcoded in scripts/server.ts CORS allowlist and the README — if a fresh
// user lands on the preset's default 8080, the sidecar refuses CORS and "Activate now" /
// "Run this fix" silently fail. Override here, with strictPort so a port collision fails
// loudly instead of drifting to 8082.
export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  vite: {
    plugins: [
      {
        name: "claude-os-live-data",
        configureServer(server) {
          // POST /__hermes_moa_save — write a Mixture-of-Agents preset into
          // ~/.hermes/config.yaml. Merges (never clobbers other presets / keys)
          // and timestamp-backs-up the file first. Loopback + per-run token gated.
          server.middlewares.use("/__hermes_moa_save", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            if (req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
              try {
                const data = JSON.parse(body || "{}");
                const name =
                  String(data.name || "")
                    .trim()
                    .replace(/[^a-zA-Z0-9_-]/g, "-") || "ministry";
                const refs = Array.isArray(data.reference_models) ? data.reference_models : [];
                const agg = data.aggregator;
                if (!refs.length || !agg?.provider || !agg?.model) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: "need >=1 reference and an aggregator" }));
                  return;
                }
                const configPath = join(homedir(), ".hermes", "config.yaml");
                if (!existsSync(configPath)) {
                  res.statusCode = 404;
                  res.end(
                    JSON.stringify({
                      error: "no ~/.hermes/config.yaml — run `hermes setup` first",
                    }),
                  );
                  return;
                }
                const text = readFileSync(configPath, "utf-8");
                const cfg = (yaml.load(text) as Record<string, any>) || {};
                // backup before any write
                const stamp = new Date().toISOString().replace(/[:.]/g, "-");
                const backupPath = `${configPath}.bak.${stamp}`;
                writeFileSync(backupPath, text);
                // merge — keep any other presets / moa keys / config untouched
                cfg.moa = cfg.moa && typeof cfg.moa === "object" ? cfg.moa : {};
                cfg.moa.presets =
                  cfg.moa.presets && typeof cfg.moa.presets === "object" ? cfg.moa.presets : {};
                cfg.moa.presets[name] = {
                  reference_models: refs.map((r: any) => ({
                    provider: String(r.provider),
                    model: String(r.model),
                  })),
                  aggregator: {
                    provider: String(agg.provider),
                    model: String(agg.model),
                  },
                  reference_temperature:
                    typeof data.reference_temperature === "number"
                      ? data.reference_temperature
                      : 0.6,
                  aggregator_temperature:
                    typeof data.aggregator_temperature === "number"
                      ? data.aggregator_temperature
                      : 0.4,
                  max_tokens: typeof data.max_tokens === "number" ? data.max_tokens : 4096,
                  enabled: true,
                };
                cfg.moa.default_preset = name;
                writeFileSync(configPath, yaml.dump(cfg, { lineWidth: 120, noRefs: true }));
                res.end(
                  JSON.stringify({
                    ok: true,
                    name,
                    backup: backupPath,
                    presets: Object.keys(cfg.moa.presets),
                  }),
                );
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err?.message ?? "save failed" }));
              }
            });
          });

          // GET /__live-data — serves live-data.json fresh from disk on every
          // request.  This replaces the static `import liveData from "…"`
          // pattern so the browser always gets the latest aggregator output
          // without a server restart.
          // Overlay the freshest per-prescription lifecycle from
          // ~/.claude-os/dreams/state.json onto the aggregated dream block.
          // The aggregator bakes status/ageDays in at aggregate time, but a
          // Skip/Done click writes state.json seconds later — without this
          // serve-time merge the verdict wouldn't stick until the next
          // aggregate run (daily), so dismissed cards would bounce back on
          // every reload in between.
          const overlayDreamLifecycle = (raw: string): string => {
            try {
              const statePath = join(homedir(), ".claude-os", "dreams", "state.json");
              if (!existsSync(statePath)) return raw;
              const data = JSON.parse(raw);
              const rx = data?.dream?.prescriptions;
              if (!Array.isArray(rx) || rx.length === 0) return raw;
              const st = JSON.parse(readFileSync(statePath, "utf-8"));
              let touched = false;
              for (const p of rx) {
                const a = p?.id ? st?.actions?.[p.id] : undefined;
                if (!a) continue;
                if (typeof a.status === "string" && p.status !== a.status) {
                  p.status = a.status;
                  touched = true;
                }
                const first = Date.parse(a.firstSeenAt ?? "");
                if (Number.isFinite(first)) {
                  p.ageDays = Math.max(0, Math.floor((Date.now() - first) / 86_400_000));
                  touched = true;
                }
              }
              return touched ? JSON.stringify(data) : raw;
            } catch {
              return raw; // state unreadable — serve the file as-is
            }
          };

          server.middlewares.use("/__live-data", (req, res, next) => {
            if (req.method !== "GET") return next();
            try {
              const filePath = resolve(__dirname, "src/data/live-data.json");
              const raw = readFileSync(filePath, "utf-8");
              res.setHeader("Content-Type", "application/json");
              res.setHeader("Cache-Control", "no-store");
              res.end(overlayDreamLifecycle(raw));
            } catch {
              // Fall back to example file on fresh clones
              try {
                const fallback = resolve(__dirname, "src/data/live-data.example.json");
                const raw = readFileSync(fallback, "utf-8");
                res.setHeader("Content-Type", "application/json");
                res.setHeader("Cache-Control", "no-store");
                res.end(raw);
              } catch {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "No live-data.json found" }));
              }
            }
          });

          // ── The shared brain ───────────────────────────────────────────
          // The dashboard's index.json (src/data/graphs/index.json) IS the
          // single source of truth. Every entry carries an absolute graphPath
          // so Hermes + Claude Code can open the graph directly. Their
          // graphify skills are pointed at this file — ingest here, both
          // agents see it. The absolute dir, computed once:
          const GRAPHS_ABS_DIR = resolve(__dirname, "src/data/graphs");

          // GET /__graphify_list — current project index (fresh from disk).
          // Loopback-gated for parity with the rest of the surface.
          server.middlewares.use("/__graphify_list", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            try {
              const indexPath = resolve(__dirname, "src/data/graphs/index.json");
              const all: any[] = JSON.parse(readFileSync(indexPath, "utf-8"));
              // Auto-prune: drop any project whose graph file is gone, OR whose
              // local source path no longer exists on disk. Keep URL-cloned
              // projects (path starts with "git:") — their graph lives in the
              // dashboard, not a persistent local repo. Self-heals the gallery
              // so deleting a repo from the computer makes its card disappear.
              const live = all.filter((p) => {
                const gp = p.graphPath || resolve(__dirname, `src/data/graphs/${p.id}.json`);
                if (!existsSync(gp)) return false; // graph artefact gone
                const src = String(p.path || "");
                if (src.startsWith("git:") || src === "") return true; // cloned → keep
                return existsSync(src); // local repo must still exist
              });
              if (live.length !== all.length) {
                // Persist the pruned list + delete orphaned graph files.
                const keptIds = new Set(live.map((p) => p.id));
                for (const p of all) {
                  if (!keptIds.has(p.id)) {
                    try {
                      const gp = p.graphPath || resolve(__dirname, `src/data/graphs/${p.id}.json`);
                      if (existsSync(gp)) unlinkSync(gp);
                    } catch {
                      /* ignore */
                    }
                  }
                }
                writeFileSync(indexPath, JSON.stringify(live, null, 2));
              }
              res.end(JSON.stringify(live));
            } catch {
              res.end("[]");
            }
          });

          // GET /__graphify_graph?id=<id> — one project's graph.json, streamed
          // (files can be multi-MB). id sanitised + path-confined. Loopback only.
          server.middlewares.use("/__graphify_graph", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            try {
              const u = new URL(req.url ?? "", "http://localhost");
              const id = (u.searchParams.get("id") ?? "").replace(/[^a-z0-9_-]/gi, "");
              if (!id) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "id required" }));
                return;
              }
              const dir = resolve(__dirname, "src/data/graphs");
              const p = resolve(dir, `${id}.json`);
              if (!p.startsWith(dir + sep) || !existsSync(p)) {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "not found" }));
                return;
              }
              const stream = createReadStream(p);
              stream.on("error", () => {
                try {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: "read failed" }));
                } catch {
                  /* ignore */
                }
              });
              stream.pipe(res);
            } catch {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: "not found" }));
            }
          });

          // DELETE /__graphify_remove?id=<id> — remove a project from the
          // gallery: deletes src/data/graphs/<id>.json and drops it from
          // index.json. Token-gated (mutating) + loopback-only. Does NOT
          // touch the source repo on disk — only the graph artefact.
          server.middlewares.use("/__graphify_remove", (req, res, next) => {
            if (req.method !== "DELETE") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            // Token gate (same contract as ingest — it's a mutation).
            if (req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            res.setHeader("Content-Type", "application/json");
            try {
              const u = new URL(req.url ?? "", "http://localhost");
              const id = (u.searchParams.get("id") ?? "").replace(/[^a-z0-9_-]/gi, "");
              if (!id) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "id required" }));
                return;
              }
              const dir = resolve(__dirname, "src/data/graphs");
              const p = resolve(dir, `${id}.json`);
              if (!p.startsWith(dir + sep)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "bad id" }));
                return;
              }
              if (existsSync(p)) unlinkSync(p);
              // Drop from index.json.
              const indexPath = join(dir, "index.json");
              let projects: any[] = [];
              try {
                projects = JSON.parse(readFileSync(indexPath, "utf-8"));
              } catch {
                projects = [];
              }
              const next = Array.isArray(projects) ? projects.filter((p2) => p2?.id !== id) : [];
              writeFileSync(indexPath, JSON.stringify(next, null, 2));
              res.end(JSON.stringify({ ok: true, id, projects: next }));
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err?.message ?? "remove failed" }));
            }
          });

          // POST /__graphify_ingest — body { path, name? }. Runs graphify (AST,
          // free, no LLM) on a local repo and writes its graph into
          // src/data/graphs/<id>.json + updates index.json. Loopback + token
          // gated because it shells out and writes files. The path is passed as
          // a single argv to execFileSync (no shell), so it can't smuggle commands.
          server.middlewares.use("/__graphify_ingest", (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            if (req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("error", () => {
              try {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "request stream error" }));
              } catch {
                /* ignore */
              }
            });
            req.on("end", () => {
              let body: any = {};
              try {
                body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
              } catch {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "bad json" }));
                return;
              }
              let repoPath = String(body.path || "").trim();
              if (!repoPath) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "path required" }));
                return;
              }

              // URL ingest: if the input looks like a git/GitHub URL, shallow-
              // clone it to a temp dir, graph that, then delete the clone at
              // the end. Lets the operator paste a repo URL instead of needing
              // it on disk. cloneTmp is cleaned up after writing the graph.
              let cloneTmp: string | null = null;
              let urlRepoName: string | null = null; // friendly name from the URL
              const isGitUrl =
                /^https?:\/\/[^\s]+/i.test(repoPath) ||
                /^git@[^\s]+:[^\s]+/i.test(repoPath) ||
                /\.git$/i.test(repoPath);
              if (isGitUrl) {
                // Accept https://, git@, and bare github.com/owner/repo forms.
                let url = repoPath;
                if (/^github\.com\//i.test(url)) url = `https://${url}`;
                // Validate it's a plausible URL we trust to hand to git. Block
                // anything with shell metacharacters even though execFileSync
                // doesn't use a shell (belt + braces).
                if (/[;&|`$(){}<>\\]/.test(url)) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: "invalid characters in URL" }));
                  return;
                }
                // Derive a friendly repo name from the URL (owner/repo →
                // "repo"), used for the project name + id instead of the
                // random temp-dir name.
                urlRepoName =
                  url
                    .replace(/\.git$/i, "")
                    .replace(/\/$/, "")
                    .split("/")
                    .pop() || "repo";
                try {
                  cloneTmp = mkdtempSync(join(tmpdir(), "graphify-clone-"));
                  execFileSync("git", ["clone", "--depth", "1", url, cloneTmp], {
                    stdio: "pipe",
                    timeout: 120000,
                  });
                } catch (err: any) {
                  if (cloneTmp) {
                    try {
                      rmSync(cloneTmp, { recursive: true, force: true });
                    } catch {
                      /* ignore */
                    }
                  }
                  res.statusCode = 502;
                  res.end(
                    JSON.stringify({
                      error: `git clone failed: ${String(err?.message ?? "").slice(0, 250)}`,
                    }),
                  );
                  return;
                }
                repoPath = cloneTmp;
              } else {
                if (repoPath.startsWith("~")) repoPath = join(homedir(), repoPath.slice(1));
                repoPath = resolve(repoPath);
                if (!existsSync(repoPath)) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: `path not found: ${repoPath}` }));
                  return;
                }
              }

              // Strip vendored/build dirs BEFORE graphify so it only parses real
              // source. A repo like hermes-agent is ~7k source files but ~120k
              // with node_modules / venv / site-packages — graphify would choke
              // and the old guard just refused with "point at a subdir". We only
              // ever prune inside OUR temp clone, never a user-supplied local
              // path (guarded by cloneTmp), so nothing on disk is at risk.
              if (cloneTmp) {
                const VENDOR_DIRS = new Set([
                  "node_modules",
                  ".venv",
                  "venv",
                  "site-packages",
                  "vendor",
                  "dist",
                  "build",
                  "target",
                  "out",
                  "__pycache__",
                  ".mypy_cache",
                  ".pytest_cache",
                  ".tox",
                  ".next",
                  ".nuxt",
                  ".cache",
                  "bower_components",
                  ".gradle",
                  "Pods",
                  "coverage",
                  ".angular",
                  ".svn",
                  ".turbo",
                  ".parcel-cache",
                  "egg-info",
                ]);
                const prune = (dir: string, depth = 0) => {
                  if (depth > 12) return;
                  let entries: import("node:fs").Dirent[];
                  try {
                    entries = readdirSync(dir, { withFileTypes: true });
                  } catch {
                    return;
                  }
                  for (const e of entries) {
                    if (!e.isDirectory()) continue;
                    const p = join(dir, e.name);
                    if (VENDOR_DIRS.has(e.name) || e.name.endsWith(".egg-info")) {
                      try {
                        rmSync(p, { recursive: true, force: true });
                      } catch {
                        /* best effort */
                      }
                    } else {
                      prune(p, depth + 1);
                    }
                  }
                };
                try {
                  prune(repoPath);
                } catch {
                  /* best effort — graphify still guarded below */
                }
              }

              const binCandidates = [
                venvBin(join(homedir(), ".notebooklm-venv"), "graphify"),
                ...cliBinCandidates("graphify"),
              ];
              const bin = binCandidates.find((p) => existsSync(p)) ?? "graphify";
              const outPath = join(repoPath, "graphify-out", "graph.json");
              // graphify does TWO things in `update`: it extracts the AST and
              // writes graph.json, THEN it renders its own standalone HTML
              // viz. On any repo past ~5k nodes the HTML step bails with
              // "too large for HTML viz" and graphify exits 1 — even though
              // graph.json was already written correctly. execFileSync throws
              // on that non-zero exit, so the ingest reported "graphify
              // failed" for repos that had in fact graphed perfectly.
              //
              // We don't want graphify's HTML at all — the dashboard renders
              // its own 3D view and already collapses oversized graphs to a
              // file-level map below. So the exit code is not the signal;
              // the presence of graph.json is. Capture any error, then judge
              // on the artefact.
              let graphifyErr: string | null = null;
              try {
                execFileSync(bin, ["update", repoPath], { stdio: "pipe", timeout: 180000 });
              } catch (err: any) {
                // Keep stdout+stderr — if graph.json is missing we surface
                // the real reason instead of a bare exit code.
                const out = [err?.stdout?.toString?.() ?? "", err?.stderr?.toString?.() ?? ""]
                  .join("\n")
                  .trim();
                graphifyErr = (out || String(err?.message ?? "")).slice(-400);
              }
              if (!existsSync(outPath)) {
                res.statusCode = 500;
                res.end(
                  JSON.stringify({
                    error: graphifyErr
                      ? `graphify failed: ${graphifyErr}`
                      : "graphify produced no graph.json (no supported source files?)",
                  }),
                );
                return;
              }
              let g: any;
              try {
                g = JSON.parse(readFileSync(outPath, "utf-8"));
              } catch {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: "unreadable graph.json" }));
                return;
              }

              let nodes: any[] = g.nodes ?? [];
              let links: any[] = g.links ?? g.edges ?? [];
              // graphify is SYMBOL-level: it emits ~30-40 nodes per source file
              // (functions, classes, methods). A ~6k-file repo like hermes-agent
              // comes back as ~150k nodes — unrenderable in the browser, and it is
              // NOT vendored deps (a fresh clone has none). So when a graph blows
              // past the render budget, collapse it to a FILE-level architecture
              // map: one node per source file, deduped file→file dependency links.
              // That's the useful view at that scale anyway, and it renders fine.
              const collapseToFileLevel = (graph: any) => {
                const ns: any[] = graph.nodes ?? [];
                const ls: any[] = graph.links ?? graph.edges ?? [];
                const fileOf = new Map<string, string>();
                for (const n of ns)
                  fileOf.set(n.id, n.source_file || n.file || n.norm_label || n.id);
                const fileNodes = new Map<string, any>();
                for (const n of ns) {
                  const f = fileOf.get(n.id);
                  if (!f || fileNodes.has(f)) continue;
                  fileNodes.set(f, {
                    id: f,
                    label: f.split("/").pop() || f,
                    norm_label: f,
                    source_file: f,
                    file_type: n.file_type || "file",
                    _origin: "ast",
                    community: n.community ?? 0, // seed cluster from first symbol in the file
                  });
                }
                const seen = new Set<string>();
                const fileLinks: any[] = [];
                for (const l of ls) {
                  const s = typeof l.source === "object" ? l.source.id : l.source;
                  const t = typeof l.target === "object" ? l.target.id : l.target;
                  const sf = fileOf.get(s),
                    tf = fileOf.get(t);
                  if (!sf || !tf || sf === tf) continue;
                  const key = `${sf} ${tf}`;
                  if (seen.has(key)) continue;
                  seen.add(key);
                  fileLinks.push({
                    source: sf,
                    target: tf,
                    ...(l.confidence ? { confidence: l.confidence } : {}),
                  });
                }
                return {
                  ...graph,
                  nodes: [...fileNodes.values()],
                  links: fileLinks,
                  collapsed: "file-level",
                };
              };
              if (nodes.length > 20000) {
                g = collapseToFileLevel(g);
                nodes = g.nodes;
                links = g.links;
              }
              // Still too big even at FILE level (>20k source files) — genuinely
              // enormous. Refuse rather than write a graph the browser can't load.
              if (nodes.length > 20000) {
                try {
                  rmSync(join(repoPath, "graphify-out"), { recursive: true, force: true });
                } catch {
                  /* ignore */
                }
                if (cloneTmp) {
                  try {
                    rmSync(cloneTmp, { recursive: true, force: true });
                  } catch {
                    /* ignore */
                  }
                }
                res.statusCode = 422;
                res.end(
                  JSON.stringify({
                    error: `Too large — ${nodes.length.toLocaleString()} source files even after collapsing to file level. This repo is enormous; point at a subdir, e.g. ${repoPath.replace(homedir(), "~")}/src`,
                  }),
                );
                return;
              }
              const deg = new Map<string, number>();
              for (const l of links) {
                const s = typeof l.source === "object" ? l.source.id : l.source;
                const t = typeof l.target === "object" ? l.target.id : l.target;
                deg.set(s, (deg.get(s) ?? 0) + 1);
                deg.set(t, (deg.get(t) ?? 0) + 1);
              }
              const label: Record<string, string> = {};
              for (const n of nodes) label[n.id] = n.label || n.norm_label || n.id;
              const god = [...deg.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([nid, c]) => ({ name: label[nid] ?? nid, degree: c }));
              const extracted = links.filter((l) => l.confidence === "EXTRACTED").length;
              const communities = new Set(nodes.map((n) => n.community)).size;
              const extCount: Record<string, number> = {};
              for (const n of nodes) {
                const m = String(n.source_file ?? "").match(/\.([a-z0-9]+)$/i);
                if (m) extCount[m[1].toLowerCase()] = (extCount[m[1].toLowerCase()] ?? 0) + 1;
              }
              const topExt = Object.entries(extCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
              const LANG: Record<string, string> = {
                ts: "TypeScript",
                tsx: "TypeScript",
                js: "JavaScript",
                jsx: "JavaScript",
                py: "Python",
                go: "Go",
                rs: "Rust",
                rb: "Ruby",
                java: "Java",
                php: "PHP",
                c: "C",
                cpp: "C++",
                swift: "Swift",
                kt: "Kotlin",
              };
              const lang = LANG[topExt] ?? "Code";

              const graphsDir = resolve(__dirname, "src/data/graphs");
              try {
                mkdirSync(graphsDir, { recursive: true });
              } catch {
                /* ignore */
              }
              const indexPath = join(graphsDir, "index.json");
              let index: any[] = [];
              try {
                index = JSON.parse(readFileSync(indexPath, "utf-8"));
              } catch {
                /* fresh index */
              }

              // Path-aware id so two repos with the same folder name (or two
              // "/src" subdirs) don't overwrite each other.
              const slug = (s: string) =>
                s
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-|-$/g, "");
              const GENERIC = new Set([
                "src",
                "app",
                "lib",
                "dist",
                "source",
                "packages",
                "core",
                "server",
                "client",
                "agent",
              ]);
              // For a cloned URL, name from the repo (not the random temp
              // dir). For a local path, keep the path-aware naming.
              const segs = repoPath.split(sep).filter(Boolean);
              const baseSeg = urlRepoName || segs[segs.length - 1] || "project";
              const parentSeg = urlRepoName ? "" : segs[segs.length - 2] || "";
              const generic = GENERIC.has(baseSeg.toLowerCase()) && !!parentSeg;
              const displayName = String(
                body.name || (generic ? `${parentSeg}/${baseSeg}` : baseSeg),
              );
              let id =
                (generic ? slug(`${parentSeg}-${baseSeg}`) : slug(baseSeg)) ||
                `project-${Date.now()}`;
              // Dedup key: for URL clones use the repo name (temp path changes
              // every run); for local use the path.
              const dedupKey = urlRepoName ?? repoPath;
              const clash = index.find((p) => p.id === id);
              if (clash && clash.path && clash.path !== dedupKey) {
                let h = 0;
                for (let i = 0; i < dedupKey.length; i++)
                  h = (h * 31 + dedupKey.charCodeAt(i)) >>> 0;
                id = `${id}-${h.toString(36).slice(0, 4)}`;
              }

              writeFileSync(join(graphsDir, `${id}.json`), JSON.stringify(g));

              const PAL = [
                "#3ddc97",
                "#60a5fa",
                "#a78bfa",
                "#f5b14c",
                "#f472b6",
                "#7be0c8",
                "#22d3ee",
                "#fbbf24",
                "#34d399",
                "#fb7185",
              ];
              const existing = index.find((p) => p.id === id);
              const color = existing?.color ?? PAL[index.length % PAL.length];
              const entry = {
                id,
                name: displayName,
                description: urlRepoName
                  ? `Cloned & graphed from a Git URL`
                  : `Ingested from ${repoPath.replace(homedir(), "~")}`,
                // For URL clones the temp path is gone after this request, so
                // don't store it as a re-ingest source — store the repo name.
                path: urlRepoName ? `git:${urlRepoName}` : repoPath,
                // Absolute path to this project's graph.json — so an agent
                // reading index.json can open it directly (the "shared brain"
                // bridge). Always points at the dashboard's stored copy.
                graphPath: join(GRAPHS_ABS_DIR, `${id}.json`),
                lang,
                color,
                nodeCount: nodes.length,
                edgeCount: links.length,
                communities,
                extractedPct: Math.round((100 * extracted) / Math.max(1, links.length)),
                godNodes: god,
              };
              if (existing) Object.assign(existing, entry);
              else index.push(entry);
              writeFileSync(indexPath, JSON.stringify(index, null, 2));
              try {
                rmSync(join(repoPath, "graphify-out"), { recursive: true, force: true });
              } catch {
                /* ignore cleanup failure */
              }
              // Clean up the temp clone (URL ingest only).
              if (cloneTmp) {
                try {
                  rmSync(cloneTmp, { recursive: true, force: true });
                } catch {
                  /* ignore */
                }
              }

              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  ok: true,
                  project: entry,
                  projects: index,
                  warning:
                    nodes.length > 6000
                      ? "Large graph — point at a source subdir (e.g. /src) to exclude vendored deps."
                      : undefined,
                }),
              );
            });
          });

          // GET /__hermes_status — live filesystem probe for Hermes Agent.
          // Returns whether Hermes is installed (~/.hermes + binary on PATH),
          // its version, and whether config.yaml is present + parseable.
          // Loopback-only because the response leaks the user's binary path
          // and default model id. The Hermes page hits this on mount to
          // decide whether to render Install / Setup / Chat states.
          server.middlewares.use("/__hermes_status", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            // 3s cache — frontend polls this every 4s, so a 3s TTL means
            // every other poll is an instant cache hit instead of re-running
            // `hermes --version` which can take a full second.
            if (sendCached("hermes-status", res)) return;
            const home = homedir();
            const hermesDir = join(home, ".hermes");
            const installedDir = existsSync(hermesDir);
            // Resolve the hermes binary across install locations + PATH, so a
            // PATH / pipx / npm-global install still registers as "installed".
            const binPath = resolveCliBin("hermes") ?? null;
            let version: string | null = null;
            if (binPath) {
              try {
                const out = execSync(`"${binPath}" --version`, {
                  stdio: "pipe",
                  // Reduced from 3000ms — hermes --version either responds
                  // quickly or it's hung waiting for a TTY that never comes.
                  // 800ms is plenty for the happy path; if it times out the
                  // version just stays null and the dashboard falls back to
                  // its known-shipping fallback (currently v0.13.0).
                  timeout: 800,
                }).toString();
                version = out.trim().split("\n")[0] || null;
              } catch {
                /* version probe failed, leave null */
              }
            }
            // Parse Hermes' canonical config.yaml. The `model:` block has
            // BOTH `default:` (model name) AND `provider:` (canonical
            // inference provider). Previously we assumed the provider was
            // the prefix on the model name ("anthropic/claude-opus-4.6" →
            // anthropic), but Hermes also stores models bare ("gpt-5.5")
            // with provider declared separately. The `provider:` field is
            // the truth.
            const configPath = join(hermesDir, "config.yaml");
            const configured = existsSync(configPath);
            let defaultModel: string | null = null;
            let provider: string | null = null;
            if (configured) {
              try {
                const yaml = readFileSync(configPath, "utf-8");
                // Only match `default:` and `provider:` INSIDE the top-level
                // model block. Hermes' config.yaml repeats the same key
                // names inside fallback-providers entries, so we slice out
                // the model block by finding the next top-level key
                // (anything starting with non-space at column 0, on its
                // own line). Avoid /m flag — its $ would let the lazy
                // capture stop at the first line inside the block.
                const headerIdx = yaml.indexOf("model:\n");
                if (headerIdx !== -1) {
                  const afterHeader = yaml.slice(headerIdx + "model:\n".length);
                  // End at the next line that starts with a non-space char.
                  const endIdx = afterHeader.search(/\n[^\s]/);
                  const blockText = endIdx === -1 ? afterHeader : afterHeader.slice(0, endIdx);
                  const m1 = blockText.match(/^\s*default:\s*["']?([^"'\n]+)["']?/m);
                  defaultModel = m1?.[1]?.trim() || null;
                  const m2 = blockText.match(/^\s*provider:\s*["']?([^"'\n]+)["']?/m);
                  provider = m2?.[1]?.trim() || null;
                }
              } catch {
                /* ignore */
              }
            }

            // OAuth providers don't store an API key in ~/.hermes/.env —
            // credentials live in Hermes' OAuth token store. For those,
            // having `provider:` set in config.yaml is sufficient to say
            // "Hermes can answer." For API-key providers we still verify
            // the matching env var is present.
            // Providers that authenticate via OAuth / a subscription rather than
            // an API key in ~/.hermes/.env — for these, a missing env key must NOT
            // trip "needs setup" (e.g. Copilot uses GitHub OAuth, not GITHUB_TOKEN).
            const OAUTH_PROVIDERS = new Set([
              "openai-codex",
              "nous",
              "copilot",
              "github-copilot",
              "anthropic-oauth",
            ]);
            const PROVIDER_KEY_MAP: Record<string, string> = {
              anthropic: "ANTHROPIC_API_KEY",
              openrouter: "OPENROUTER_API_KEY",
              openai: "OPENAI_API_KEY",
              gemini: "GOOGLE_API_KEY",
              copilot: "GITHUB_TOKEN",
              huggingface: "HF_TOKEN",
              groq: "GROQ_API_KEY",
              "ollama-cloud": "OLLAMA_API_KEY",
              nvidia: "NVIDIA_API_KEY",
              zai: "GLM_API_KEY",
              "kimi-coding": "KIMI_API_KEY",
              minimax: "MINIMAX_API_KEY",
            };
            const providerKeyName = provider ? (PROVIDER_KEY_MAP[provider] ?? null) : null;
            const envPath = join(hermesDir, ".env");
            let hasProviderKey = false;
            if (provider && OAUTH_PROVIDERS.has(provider)) {
              // OAuth-authed; we don't check env. Hermes' OAuth store is
              // sufficient and `hermes status` will catch a missing token.
              hasProviderKey = true;
            } else if (providerKeyName && existsSync(envPath)) {
              try {
                const envText = readFileSync(envPath, "utf-8");
                const re = new RegExp(`^\\s*${providerKeyName}\\s*=\\s*[^\\s#]`, "m");
                hasProviderKey = re.test(envText);
              } catch {
                /* ignore */
              }
            }
            const installed = installedDir && Boolean(binPath);
            // "needsSetup" only fires when there's a real gap: Hermes is
            // installed but config.yaml has no provider set, OR the
            // declared provider expects a key we can't find. Don't trip
            // for unknown providers — we'd rather show the chat and let
            // it fail with a real error than block a working install.
            const needsSetup =
              installed &&
              (!provider ||
                (!OAUTH_PROVIDERS.has(provider) && providerKeyName !== null && !hasProviderKey));
            const body = JSON.stringify({
              installed,
              binPath,
              version,
              configured,
              defaultModel,
              provider,
              providerKeyName,
              hasProviderKey,
              needsSetup,
              envPath,
            });
            storeCached("hermes-status", 3000, body);
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("X-Cache", "MISS");
            res.end(body);
          });

          // POST /__fish_tts — server-side proxy to Fish Audio TTS so the
          // API key never reaches the browser. Body: { text, voice } where
          // voice is a Fish model reference id. Returns audio/mpeg bytes.
          // Key comes from ~/.hermes/.env (FISH_API_KEY, or SAKANA_API_KEY
          // when its value carries the fish_ prefix — where Jack parked it).
          server.middlewares.use("/__fish_tts", (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const token = req.headers["x-claude-os-token"];
            if (token !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            let fishKey = "";
            try {
              const envRaw = readFileSync(join(homedir(), ".hermes", ".env"), "utf8");
              for (const line of envRaw.split("\n")) {
                const m = line.match(/^\s*(FISH_API_KEY|SAKANA_API_KEY)\s*=\s*(\S+)/);
                if (!m) continue;
                if (m[1] === "FISH_API_KEY" || m[2].startsWith("fish_")) fishKey = m[2];
                if (m[1] === "FISH_API_KEY") break;
              }
            } catch {
              /* no env file */
            }
            if (!fishKey) {
              res.statusCode = 503;
              res.end(JSON.stringify({ error: "no fish audio key configured" }));
              return;
            }
            void (async () => {
              let body = "";
              for await (const chunk of req as any) body += chunk;
              let payload: { text?: string; voice?: string };
              try {
                payload = JSON.parse(body || "{}");
              } catch {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "invalid json" }));
                return;
              }
              const text = (payload.text ?? "").trim().slice(0, 2_000);
              const voice = (payload.voice ?? "").trim();
              if (!text || !/^[a-f0-9]{16,64}$/i.test(voice)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "text or voice missing" }));
                return;
              }
              try {
                const up = await fetch("https://api.fish.audio/v1/tts", {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${fishKey}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ text, reference_id: voice, format: "mp3" }),
                });
                if (!up.ok) {
                  res.statusCode = 502;
                  res.end(JSON.stringify({ error: `fish audio ${up.status}` }));
                  return;
                }
                const audio = Buffer.from(await up.arrayBuffer());
                res.setHeader("Content-Type", "audio/mpeg");
                res.setHeader("Cache-Control", "no-store");
                res.end(audio);
              } catch {
                res.statusCode = 502;
                res.end(JSON.stringify({ error: "fish audio unreachable" }));
              }
            })();
          });

          // POST /__hermes_image_upload — accept a raw image body, save it
          // to ~/.hermes/image_cache/<uuid>.<ext>, return the absolute path
          // so the chat can prepend it to the prompt. Hermes' vision-capable
          // models (and the file-read tool) then pick the image up by path.
          // Token-gated, loopback only, 8MB hard cap.
          server.middlewares.use("/__hermes_image_upload", (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const token = req.headers["x-claude-os-token"];
            if (token !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            const contentType = String(req.headers["content-type"] ?? "");
            // Map common image content-types → extensions. Anything else
            // is rejected — we don't want arbitrary file types written
            // into the Hermes image cache.
            const EXT_BY_CT: Record<string, string> = {
              "image/png": "png",
              "image/jpeg": "jpg",
              "image/jpg": "jpg",
              "image/webp": "webp",
              "image/gif": "gif",
              "application/pdf": "pdf",
              "text/plain": "txt",
              "text/markdown": "md",
              "text/csv": "csv",
              "application/json": "json",
              "text/html": "html",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
              "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
            };
            // Extension whitelist is the real gate — content-type first, then
            // the original filename (browsers often send octet-stream for docs).
            const SAFE_EXT = new Set([
              "png",
              "jpg",
              "jpeg",
              "webp",
              "gif",
              "pdf",
              "txt",
              "md",
              "csv",
              "json",
              "html",
              "docx",
              "xlsx",
              "pptx",
            ]);
            let ext = EXT_BY_CT[contentType.split(";")[0].trim()];
            if (!ext) {
              const nameHdr = String(req.headers["x-file-name"] ?? "");
              const m2 = nameHdr.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
              if (m2 && SAFE_EXT.has(m2[1])) ext = m2[1] === "jpeg" ? "jpg" : m2[1];
            }
            if (!ext) {
              res.statusCode = 415;
              res.end(JSON.stringify({ error: "unsupported file type" }));
              return;
            }
            const MAX = 25 * 1024 * 1024;
            const chunks: Buffer[] = [];
            let total = 0;
            let aborted = false;
            req.on("data", (c: Buffer) => {
              total += c.length;
              if (total > MAX) {
                aborted = true;
                req.destroy();
                return;
              }
              chunks.push(c);
            });
            req.on("end", () => {
              if (aborted) {
                res.statusCode = 413;
                res.end(JSON.stringify({ error: "too large (8MB max)" }));
                return;
              }
              const buf = Buffer.concat(chunks);
              const cacheDir = join(homedir(), ".hermes", "image_cache");
              try {
                mkdirSync(cacheDir, { recursive: true });
              } catch {
                /* ignore */
              }
              const id = randomBytes(8).toString("hex");
              const filename = `dashboard-${Date.now()}-${id}.${ext}`;
              const path = join(cacheDir, filename);
              try {
                writeFileSync(path, buf);
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err?.message ?? "write failed" }));
                return;
              }
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ path, size: buf.length, type: contentType }));
            });
          });

          // POST /__hermes_chat — shells out to `hermes chat -Q -q "<prompt>"`
          // (single-query mode with quiet/programmatic output) and streams
          // the response back to the dashboard as SSE.
          // Loopback + token gated. Body: { prompt: "<user message>" }.
          // The prompt is passed as a single argv string — argv doesn't
          // get shell-interpreted, so a malicious prompt can't smuggle
          // shell commands. Browser disconnect kills the child.
          server.middlewares.use("/__hermes_chat", async (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const provided = req.headers["x-claude-os-token"];
            if (provided !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "invalid token" }));
              return;
            }
            let body = "";
            for await (const chunk of req as any) body += chunk;
            let payload: {
              prompt?: string;
              sessionId?: string;
              toolsets?: string;
              yolo?: boolean;
              graph?: boolean;
              model?: string;
              provider?: string;
            };
            try {
              payload = JSON.parse(body || "{}");
            } catch {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid json" }));
              return;
            }
            const prompt = payload.prompt?.trim() ?? "";
            if (!prompt || prompt.length > 12_000) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "prompt empty or too long" }));
              return;
            }
            // Optional sessionId resumes an existing conversation. Hermes'
            // --resume flag loads the prior turns as context so this reply
            // builds on them. We validate the id to a safe character set
            // (alphanumerics + - and _) so it can't escape to argv.
            const sessionId = payload.sessionId?.trim() ?? "";
            if (sessionId && !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid sessionId" }));
              return;
            }
            // Optional toolset override → `hermes chat -t <value>`. The
            // grounded Knowledge Graph chat sends "" (no toolsets) so Hermes
            // answers purely from the seeded structure and never attempts a
            // shell command — which, with no TTY to approve it, otherwise
            // times out ("denying command") and exits 130. Constrained to a
            // safe charset (letters, digits, comma, _ , -) so it can't escape
            // to argv; empty string is allowed and means "no tools".
            const hasToolsets = typeof payload.toolsets === "string";
            const toolsets = hasToolsets ? payload.toolsets!.trim() : "";
            if (hasToolsets && toolsets && !/^[A-Za-z0-9_,-]{1,200}$/.test(toolsets)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid toolsets" }));
              return;
            }
            // Graph-query mode (Knowledge Graph chat): run Hermes with the
            // graphify skill + `--yolo` so it actually queries the project's
            // graph (reads graphPath / runs graphify) and auto-approves the
            // read instead of deadlocking on a tool-approval prompt. Safe
            // because this endpoint is loopback-only + token-gated and drives
            // the user's own local agent against their own graph data.
            const yolo = payload.yolo === true;
            // graphify skill is only for the Knowledge-Graph chat; decoupled from
            // yolo so voice/other callers can auto-approve tools WITHOUT it.
            const graph = payload.graph === true;
            // Optional per-chat model override → `hermes chat -m <model> --provider <p>`.
            // Lets the composer's model selector pick a model (or a Mixture-of-
            // Agents preset via provider "moa") for THIS turn without touching the
            // persistent default in config.yaml. Both validated to safe charsets so
            // they can't escape to argv. Model ids carry "/" ":" "." (e.g. an
            // OpenRouter id like "z-ai/glm-5.2"); provider is a bare word (a
            // built-in or a user-defined providers: entry, including "moa").
            const model = typeof payload.model === "string" ? payload.model.trim() : "";
            if (model && !/^[A-Za-z0-9][A-Za-z0-9_.\/:-]{0,119}$/.test(model)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid model" }));
              return;
            }
            const provider = typeof payload.provider === "string" ? payload.provider.trim() : "";
            if (provider && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/.test(provider)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid provider" }));
              return;
            }

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("Connection", "keep-alive");
            // Disable any in-between proxy buffering and flush headers so
            // the browser opens the stream immediately. Without this the
            // first chunk can take multiple seconds to appear even after
            // hermes starts producing output.
            res.setHeader("X-Accel-Buffering", "no");
            (res as any).flushHeaders?.();
            // Heartbeat comment every 15s so connections through proxies
            // don't time out mid-thought on a long hermes reply.
            const heartbeat = setInterval(() => {
              res.write(":keepalive\n\n");
            }, 15_000);

            const sendEvent = (event: string, data: string) => {
              const safe = data.replace(/\r/g, "");
              for (const line of safe.split("\n")) {
                res.write(`event: ${event}\n`);
                res.write(`data: ${line}\n\n`);
              }
            };

            // Resolve Hermes. Prefer the venv's Python + source entrypoint
            // (`python hermes_cli/main.py …`) over the `hermes` shim because
            // some installer revisions ship a broken bash shim at
            // ~/.hermes/hermes-agent/venv/bin/hermes that recursively execs
            // ITSELF — every fresh CLI call hangs forever before reaching
            // the Python entry. Calling Python + main.py directly bypasses
            // the shim entirely. Falls back to the wrapper binaries on
            // installs where the source tree isn't present (e.g. pipx).
            const home = homedir();
            const hermesRoot = join(home, ".hermes", "hermes-agent");
            const hermesPython = venvBin(join(hermesRoot, "venv"), "python");
            const hermesMain = join(hermesRoot, "hermes_cli", "main.py");
            const useSourceEntrypoint = existsSync(hermesPython) && existsSync(hermesMain);
            // resolveCliBin also checks PATH (`which hermes`), so a Hermes that
            // isn't under ~/.local/bin / Homebrew (e.g. pipx, npm-global, custom
            // installs — the "can't find it on PATH" reports) is still found.
            const binPath = useSourceEntrypoint ? hermesPython : resolveCliBin("hermes");
            if (!binPath) {
              sendEvent("error", "Hermes binary not found on PATH.");
              res.end();
              return;
            }

            // Run hermes from the user's home directory rather than the
            // dev server's cwd. Otherwise hermes auto-injects this repo's
            // CLAUDE.md / AGENTS.md as system context and replies as if
            // it were Claude OS's setup agent. The home dir is a neutral
            // ground — the user's personal ~/.hermes/SOUL.md and memory
            // still load (those are global, not cwd-relative).
            const cwd = home;
            // Nous Research's Hermes uses an explicit `chat` subcommand with
            // -q/--query for single-shot programmatic use and -Q/--quiet to
            // suppress banner/spinner/tool-preview noise so only the model's
            // final reply lands in the SSE stream. (The old `-z` shortcut
            // from earlier Hermes builds doesn't exist in this version.)
            const args = useSourceEntrypoint
              ? [hermesMain, "chat", "-Q", "-q", prompt]
              : ["chat", "-Q", "-q", prompt];
            if (sessionId) args.push("--resume", sessionId);
            // When the client opts in, pin the toolset (e.g. "" = no tools).
            if (hasToolsets) args.push("-t", toolsets);
            // Graph-query mode: preload the graphify skill and auto-approve so
            // Hermes actually queries the graph without the approval deadlock.
            if (yolo) args.push("--yolo");
            if (graph) args.push("-s", "graphify");
            if (model) args.push("-m", model);
            if (provider) args.push("--provider", provider);
            // Ministry (Mixture-of-Agents) turns: run verbose so each expert
            // reference streams its FULL text. Without -v, Hermes' CLI caps
            // every reference/thinking preview at 5 lines and prints
            // "... (N more lines)" — the dashboard wants the whole answer.
            if (provider === "moa") args.push("-v");
            // Strip any inherited PYTHONPATH/PYTHONHOME so the venv's own
            // site-packages resolution wins. Inherited values from a parent
            // shell can shadow Hermes' bundled deps and cause silent imports
            // failures that look identical to a hang.
            const hermesEnv = { ...process.env };
            delete hermesEnv.PYTHONPATH;
            delete hermesEnv.PYTHONHOME;
            const child = spawn(binPath, args, {
              cwd,
              env: {
                ...hermesEnv,
                // Python buffers stdout when it isn't a TTY. Without this
                // every reply came out all at once after hermes exited
                // (looked like a hang). Forces line-buffered output so
                // the SSE stream actually streams.
                PYTHONUNBUFFERED: "1",
                // Force a wide pseudo-tty so Hermes doesn't truncate output
                // when its TTY detection misfires under spawn().
                TERM: "xterm-256color",
                COLUMNS: "180",
                LINES: "60",
                // Ministry reliability: Hermes' MoA reference display events
                // are best-effort TUI callbacks that silently drop in
                // headless runs. This flag activates a local patch in
                // hermes-agent (agent_init._moa_reference_relay) that echoes
                // every expert's output to stdout deterministically, so the
                // chat ALWAYS shows the ensemble. No-op on unpatched Hermes.
                HERMES_MOA_ECHO: "1",
              },
              // Own process group — same reason as the Claude lane: Hermes
              // spawns tools of its own, and signalling only the top process
              // left them running after the turn was killed.
              detached: true,
            });

            // Two-stage watchdog because Nous Research's Hermes CLI has two
            // distinct failure modes:
            //   1. Slow first-output cold start (sqlite migrations, model
            //      load, skills sync) — can take 30-90s on a fresh boot
            //      after the gateway has just claimed locks. We must NOT
            //      kill during this window even though stdout is silent.
            //   2. Post-completion curses/rich hang in --query mode — after
            //      the answer is on stdout, the process spins forever at
            //      100% CPU. Once we see SOME output, an 8s silence means
            //      it's done and we can SIGTERM cleanly.
            // In -Q quiet mode Hermes emits NOTHING until the final answer,
            // so "first output" arrives only when the whole run is done. A
            // flat 2-minute ceiling therefore executes any agentic turn that
            // legitimately thinks/runs tools for longer (observed: the
            // "read all my sessions and recommend skills" prompt dies at
            // exactly 120s with exit 130 = Hermes trapping our SIGTERM).
            // Budget by mode: yolo turns are explicitly agentic → 10 min.
            // Non-yolo turns can still be genuinely agentic (web fetches,
            // high-effort thinking models like kimi-k3) — 120s killed real
            // runs mid-flight (user-visible "hermes exited with code 130").
            const FIRST_OUTPUT_TIMEOUT_MS = yolo ? 600_000 : 300_000;
            const POST_OUTPUT_IDLE_MS = 8_000; // strict once the run is over
            // Mid-run output gaps (between tool batches) can exceed 8s on
            // agentic turns — don't kill those. Hermes prints
            // "session_id: …" to stderr as its end-of-run marker; once seen,
            // snap back to the strict 8s so the curses-hang cleanup stays fast.
            // Ministry (moa) turns get the biggest budget: each of the
            // reference models + the aggregator can legitimately think for
            // minutes with zero output — the observed exit-130s were this
            // watchdog interrupting them mid-run (Hermes maps SIGTERM to
            // KeyboardInterrupt → exit 130).
            // Mid-run silence is normal while a model thinks or a tool runs —
            // slow providers (kimi-k3 high effort) legitimately stream nothing
            // for minutes. The strict 8s reaper only applies AFTER session_id
            // marks the run finished (curses-hang cleanup), so this is
            // uniformly generous: 10 minutes for every mode.
            const MID_RUN_IDLE_MS = 600_000;
            let watchdog: NodeJS.Timeout | null = null;
            let receivedAnyOutput = false;
            let runFinished = false;
            let watchdogFired = false;
            const setIdle = (ms: number) => {
              if (watchdog) clearTimeout(watchdog);
              watchdog = setTimeout(() => {
                watchdogFired = true;
                // Pre-output: hermes is hung waiting for something it
                // can't get (auth lock, network, etc.) — surface as error.
                // Post-output: assume done, terminate cleanly.
                // killTree, not child.kill: the old escalation here could never
                // fire (see killTree), and a signal to the CLI never reached
                // the tools it had spawned.
                killTree(child);
              }, ms);
            };
            setIdle(FIRST_OUTPUT_TIMEOUT_MS);

            child.stdout.on("data", (buf: Buffer) => {
              receivedAnyOutput = true;
              sendEvent("chunk", buf.toString("utf-8"));
              setIdle(runFinished ? POST_OUTPUT_IDLE_MS : MID_RUN_IDLE_MS);
            });
            child.stderr.on("data", (buf: Buffer) => {
              // Hermes pipes status into stderr; keep the user's chat
              // bubble clean by routing stderr to an "info" event the
              // client can choose to display dimly.
              receivedAnyOutput = true;
              const text = buf.toString("utf-8");
              if (/session_id:/.test(text)) runFinished = true;
              // Insurance: if reference/thinking output arrives AFTER a
              // session_id sighting, the run is clearly still going (e.g. a
              // continuation session) — go back to the generous idle.
              else if (runFinished && /◇\s*Reference|\[thinking\]/.test(text)) runFinished = false;
              sendEvent("info", text);
              setIdle(runFinished ? POST_OUTPUT_IDLE_MS : MID_RUN_IDLE_MS);
            });
            child.on("error", (err) => {
              clearInterval(heartbeat); // else the 15s keepalive writes on an ended response forever
              if (watchdog) clearTimeout(watchdog);
              sendEvent("error", String(err.message || err));
              res.end();
            });
            child.on("close", (code, signal) => {
              clearInterval(heartbeat);
              if (watchdog) clearTimeout(watchdog);
              // SIGTERM/SIGKILL from our watchdog after Hermes already
              // produced its reply counts as a successful turn — the model
              // gave us output, the hang is just in the curses cleanup.
              // Pre-output kills (cold-start timeout) surface as errors so
              // the user knows something's genuinely wrong.
              if (
                code === 0 ||
                ((signal === "SIGTERM" || signal === "SIGKILL") && receivedAnyOutput)
              ) {
                sendEvent("done", "ok");
              } else if (signal === "SIGTERM" || signal === "SIGKILL") {
                sendEvent(
                  "error",
                  `Hermes didn't respond in ${Math.round(FIRST_OUTPUT_TIMEOUT_MS / 60_000)} minutes. Check ~/.hermes/.env has provider credentials and run \`hermes gateway restart\`.`,
                );
              } else if (watchdogFired && !runFinished) {
                // Hermes traps our SIGTERM and exits itself (code 130), so the
                // signal branch above misses watchdog kills. Say what actually
                // happened instead of a bare exit code.
                sendEvent(
                  "error",
                  `Hermes went silent for ${Math.round((receivedAnyOutput ? MID_RUN_IDLE_MS : FIRST_OUTPUT_TIMEOUT_MS) / 60_000)}+ minutes mid-run, so the dashboard stopped it. Any partial answer above is kept — try again, or switch to a faster model for this task.`,
                );
              } else {
                sendEvent("error", `hermes exited with code ${code ?? signal}`);
              }
              res.end();
            });
            req.on("close", () => {
              clearInterval(heartbeat);
              if (watchdog) clearTimeout(watchdog);
              if (!child.killed) child.kill("SIGTERM");
            });
          });

          // POST /__claude_chat — sibling of /__hermes_chat for the Claude
          // Code CLI. Shells out to `claude -p "<prompt>" --output-format
          // stream-json --verbose` and re-emits the newline-delimited JSON
          // stream as the SAME SSE protocol the hermes endpoint speaks
          // (chunk / info / error / done), so the chat component can consume
          // either endpoint unchanged. Loopback + token gated. Body:
          // { prompt: "<user message>", model?, sessionId?, yolo? } —
          // `message` accepted as an alias for `prompt`. The prompt is passed
          // as a single argv string — argv doesn't get shell-interpreted, so
          // a malicious prompt can't smuggle shell commands. Browser
          // disconnect kills the child.
          // ── Tool approvals ────────────────────────────────────────────────
          // A headless `claude -p` has nowhere to draw its permission prompt,
          // so historically this pane had only two bad options: bypass every
          // check (--dangerously-skip-permissions) or watch the CLI silently
          // decline anything outside --allowedTools. The CLI's own escape
          // hatch is --permission-prompt-tool: name an MCP tool and the CLI
          // calls THAT instead of drawing its terminal prompt, then obeys
          // whatever the tool answers. So the dev server hosts a three-method
          // MCP server, hands the child an --mcp-config pointing back at it,
          // and turns every call into a card in the chat.
          //
          // The flag is undocumented in `claude --help` on 2.1.217 but the
          // binary accepts it (an unknown option aborts before auth; this one
          // gets as far as authenticating). runClaudeTurn below still watches
          // for "unknown option" on stderr and re-runs the turn without
          // approvals, so a future CLI that drops the flag degrades to the old
          // behaviour instead of breaking every run.
          // ── Questions ─────────────────────────────────────────────────────
          // The other half of the permission story. Approvals let the operator
          // say no to a tool; questions let the AGENT ask the operator
          // something — which is what turns an unattended run from "make the
          // call yourself and hope" into a conversation. Same machinery: the
          // MCP call parks in pendingApprovals until a card in the chat
          // answers it.
          interface AskedQuestion {
            question: string;
            header: string;
            multiSelect: boolean;
            options: Array<{ label: string; description: string }>;
          }
          interface QuestionAnswer {
            header: string;
            question: string;
            /** Chosen option labels, or the free-text the operator typed. */
            answers: string[];
          }
          type ApprovalDecision =
            | { behavior: "allow"; updatedInput: unknown }
            | { behavior: "deny"; message: string }
            | { behavior: "answer"; answers: QuestionAnswer[] };

          /** 1–4 questions, 2–4 options each — the real AskUserQuestion shape.
              Over-long input is clamped rather than rejected: a malformed ask
              should still reach the operator, never break the run. */
          const normalizeQuestions = (raw: unknown): AskedQuestion[] => {
            const list = Array.isArray(raw) ? raw : [];
            const out: AskedQuestion[] = [];
            for (const q of list.slice(0, 4)) {
              const question = String((q as any)?.question ?? "")
                .trim()
                .slice(0, 600);
              if (!question) continue;
              const options: AskedQuestion["options"] = [];
              for (const o of (Array.isArray((q as any)?.options) ? (q as any).options : []).slice(
                0,
                4,
              )) {
                const label = String((o as any)?.label ?? "")
                  .trim()
                  .slice(0, 120);
                if (!label) continue;
                options.push({
                  label,
                  description: String((o as any)?.description ?? "")
                    .trim()
                    .slice(0, 300),
                });
              }
              if (options.length < 1) continue;
              out.push({
                question,
                header:
                  String((q as any)?.header ?? "")
                    .trim()
                    .slice(0, 40) || "Question",
                multiSelect: (q as any)?.multiSelect === true,
                options,
              });
            }
            return out;
          };

          /** What the model reads back. Plain prose on purpose — this is the
              tool result the CLI splices into the transcript. */
          const formatAnswers = (answers: QuestionAnswer[]): string =>
            answers.length === 0
              ? "The operator gave no answer."
              : answers
                  .map(
                    (a) =>
                      `${a.header || "Answer"} — ${a.question}\nThe operator chose: ${
                        a.answers.length ? a.answers.join(", ") : "(nothing)"
                      }`,
                  )
                  .join("\n\n");
          interface PendingApproval {
            chatId: string;
            toolName: string;
            /** The tool's original input, replayed as `updatedInput` on allow —
                the browser never has to echo it back (and can't tamper with it). */
            input: unknown;
            settle: (d: ApprovalDecision) => void;
            timer: NodeJS.Timeout;
          }
          // tool_use_id → the decision the UI still owes us.
          const pendingApprovals = new Map<string, PendingApproval>();
          // chatId → how to reach the browser tab that owns this chat. Keyed by
          // a stable per-chat id the client mints once (NOT the CLI session id,
          // which doesn't exist until the first `init` line of the first turn),
          // and re-registered by every turn so a resumed chat still gets cards.
          const approvalChats = new Map<
            string,
            { send: (event: string, data: string) => void; pending: Set<string> }
          >();
          // chatId → "<tool>:<first argv token>" scopes the user said "don't ask
          // again" for. Memory only, life of the dev server — the same scope
          // Claude Code's own "don't ask again for X in Y" uses.
          const approvalAlways = new Map<string, Set<string>>();
          const APPROVAL_TIMEOUT_MS = 10 * 60_000;

          // The "don't ask again" scope. Bash keys on the executable (so
          // approving `git status` doesn't approve `rm -rf`); file tools key on
          // the containing directory; everything else on the tool alone.
          const approvalScope = (toolName: string, input: any): string => {
            if (toolName === "Bash") {
              const cmd = String(input?.command ?? "").trim();
              return `Bash:${cmd.split(/\s+/)[0] || "*"}`;
            }
            const path = input?.file_path ?? input?.path ?? input?.notebook_path;
            if (typeof path === "string" && path)
              return `${toolName}:${path.slice(0, path.lastIndexOf("/") + 1) || "/"}`;
            return `${toolName}:*`;
          };

          const settleApproval = (id: string, decision: ApprovalDecision, note: string) => {
            const p = pendingApprovals.get(id);
            if (!p) return false;
            clearTimeout(p.timer);
            pendingApprovals.delete(id);
            const chat = approvalChats.get(p.chatId);
            chat?.pending.delete(id);
            // Tell the card it's over even when the answer didn't come from
            // this browser (timeout, a second tab, an always-grant).
            chat?.send("permission_done", JSON.stringify({ id, outcome: note }));
            // A timeout used to be completely silent: after ten minutes with
            // nobody at the keyboard the request was denied, the run usually
            // ended, and the transcript showed no reason at all — the chat just
            // stopped. Say it out loud, in the thread, where the user will
            // later be looking for why their overnight build died.
            if (note === "timeout")
              chat?.send(
                "info",
                `⏱ no answer to the ${p.toolName === "ask_user_question" ? "question" : `\`${p.toolName}\``} approval within ${Math.round(
                  APPROVAL_TIMEOUT_MS / 60_000,
                )} minutes, so it was declined and the turn may have stopped here. Turn on auto-approve for this chat if it needs to run unattended.`,
              );
            p.settle(decision);
            return true;
          };

          // POST /__mcp_approvals — Streamable-HTTP MCP, three methods deep.
          // The child CLI is the only client, so we answer JSON-RPC over plain
          // JSON responses (the spec's alternative to an SSE stream) and 202
          // every notification.
          server.middlewares.use("/__mcp_approvals", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            if (req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            const chatId = String(req.headers["x-claude-os-chat"] ?? "");
            void (async () => {
              let body = "";
              for await (const chunk of req as any) body += chunk;
              let rpc: any;
              try {
                rpc = JSON.parse(body || "{}");
              } catch {
                res.statusCode = 400;
                res.end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    error: { code: -32700, message: "parse error" },
                  }),
                );
                return;
              }
              const reply = (result: unknown) =>
                res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
              // Notifications carry no id and want no body.
              if (rpc.id === undefined) {
                res.statusCode = 202;
                res.end("");
                return;
              }
              if (rpc.method === "initialize") {
                reply({
                  // Echo the client's protocol version — this server has no
                  // version-specific behaviour, so whatever the CLI speaks is
                  // what we speak.
                  protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "claude-os-approvals", version: "1.0.0" },
                });
                return;
              }
              if (rpc.method === "tools/list") {
                reply({
                  tools: [
                    {
                      name: "permission_prompt",
                      description:
                        "Ask the Claude OS operator whether this tool call may run. Returns the CLI's permission-prompt-tool verdict.",
                      inputSchema: {
                        type: "object",
                        properties: {
                          tool_name: { type: "string" },
                          input: { type: "object" },
                          tool_use_id: { type: "string" },
                        },
                        required: ["tool_name", "input"],
                      },
                    },
                    {
                      name: "ask_user_question",
                      description:
                        "Ask the Claude OS operator a multiple-choice question and wait for the answer. Renders as clickable buttons in the chat. Use this instead of guessing when a decision is genuinely the human's to make.",
                      inputSchema: {
                        type: "object",
                        properties: {
                          questions: {
                            type: "array",
                            minItems: 1,
                            maxItems: 4,
                            items: {
                              type: "object",
                              properties: {
                                question: { type: "string", description: "The question, in full." },
                                header: {
                                  type: "string",
                                  description:
                                    'A 1-3 word category shown as a chip (e.g. "Approach").',
                                },
                                multiSelect: {
                                  type: "boolean",
                                  description: "May the operator pick more than one option?",
                                },
                                options: {
                                  type: "array",
                                  minItems: 2,
                                  maxItems: 4,
                                  items: {
                                    type: "object",
                                    properties: {
                                      label: { type: "string" },
                                      description: { type: "string" },
                                    },
                                    required: ["label"],
                                  },
                                },
                              },
                              required: ["question", "header", "options"],
                            },
                          },
                        },
                        required: ["questions"],
                      },
                    },
                  ],
                });
                return;
              }
              const callName = rpc.params?.name;
              if (
                rpc.method !== "tools/call" ||
                (callName !== "permission_prompt" && callName !== "ask_user_question")
              ) {
                res.end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: rpc.id,
                    error: { code: -32601, message: `unknown method ${rpc.method}` },
                  }),
                );
                return;
              }
              const a = rpc.params?.arguments ?? {};

              // ── ask_user_question ────────────────────────────────────────
              if (callName === "ask_user_question") {
                const text = (t: string) => reply({ content: [{ type: "text", text: t }] });
                const questions = normalizeQuestions(a.questions);
                if (questions.length === 0) {
                  text(
                    "ask_user_question needs at least one question with at least one option. Nothing was shown to the operator.",
                  );
                  return;
                }
                const qChat = approvalChats.get(chatId);
                if (!qChat) {
                  text(
                    "No answer — the Claude OS pane that owns this chat is not connected, so nobody can see the question. Decide it yourself and say which way you went.",
                  );
                  return;
                }
                const qid = String(
                  a.tool_use_id ?? `q-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                );
                const outcome = await new Promise<ApprovalDecision>((resolve) => {
                  const timer = setTimeout(() => {
                    settleApproval(qid, { behavior: "deny", message: "timeout" }, "timeout");
                  }, APPROVAL_TIMEOUT_MS);
                  pendingApprovals.set(qid, {
                    chatId,
                    toolName: "ask_user_question",
                    input: { questions },
                    settle: resolve,
                    timer,
                  });
                  qChat.pending.add(qid);
                  qChat.send(
                    "question",
                    JSON.stringify({ id: qid, tool: "ask_user_question", questions }),
                  );
                });
                if (outcome.behavior === "answer") text(formatAnswers(outcome.answers));
                else
                  text(
                    "No answer — operator away. Nobody responded within 10 minutes. Make the call yourself, then say plainly which option you assumed and why.",
                  );
                return;
              }
              const toolName = String(a.tool_name ?? "tool");
              const toolInput = a.input ?? {};
              const id = String(
                a.tool_use_id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              );
              // The contract: one text block whose text is the JSON-stringified
              // verdict. Anything else and the CLI treats the call as failed.
              const answer = (d: ApprovalDecision) =>
                reply({ content: [{ type: "text", text: JSON.stringify(d) }] });

              const chat = approvalChats.get(chatId);
              const scope = approvalScope(toolName, toolInput);

              // The CLI's OWN AskUserQuestion tool comes through here as a
              // permission request. Approving it is useless — headless, the
              // built-in tool has no terminal to draw itself in. So show the
              // operator the same question card, and hand the answer back the
              // only way the permission protocol allows: as the deny message,
              // which the CLI feeds to the model verbatim. The model gets its
              // answer; the tool simply never runs.
              if (toolName === "AskUserQuestion" && chat) {
                const questions = normalizeQuestions((toolInput as any)?.questions);
                if (questions.length > 0) {
                  const outcome = await new Promise<ApprovalDecision>((resolve) => {
                    const timer = setTimeout(() => {
                      settleApproval(id, { behavior: "deny", message: "timeout" }, "timeout");
                    }, APPROVAL_TIMEOUT_MS);
                    pendingApprovals.set(id, {
                      chatId,
                      toolName,
                      input: toolInput,
                      settle: resolve,
                      timer,
                    });
                    chat.pending.add(id);
                    chat.send("question", JSON.stringify({ id, tool: toolName, questions }));
                  });
                  answer({
                    behavior: "deny",
                    message:
                      outcome.behavior === "answer"
                        ? `${formatAnswers(outcome.answers)}\n\n(The operator answered in the Claude OS pane, so this tool call was not run. Continue with that answer — do not ask again.)`
                        : "No answer — operator away. Nobody responded within 10 minutes. Make the call yourself, then say plainly which option you assumed and why.",
                  });
                  return;
                }
              }

              if (approvalAlways.get(chatId)?.has(scope)) {
                // Silent auto-allow, exactly like Claude Code after a "2".
                chat?.send("info", `⚙ ${toolName} — auto-allowed (${scope})`);
                answer({ behavior: "allow", updatedInput: toolInput });
                return;
              }
              if (!chat) {
                // No browser owns this chat (tab closed mid-run). Denying is the
                // only safe answer, and it says why in the model's own transcript.
                answer({
                  behavior: "deny",
                  message:
                    "The Claude OS pane that owns this chat is not connected, so nobody can approve tools right now.",
                });
                return;
              }
              const decision = await new Promise<ApprovalDecision>((resolve) => {
                const timer = setTimeout(() => {
                  settleApproval(
                    id,
                    { behavior: "deny", message: "No answer from the UI within 10 minutes." },
                    "timeout",
                  );
                }, APPROVAL_TIMEOUT_MS);
                pendingApprovals.set(id, {
                  chatId,
                  toolName,
                  input: toolInput,
                  settle: resolve,
                  timer,
                });
                chat.pending.add(id);
                chat.send(
                  "permission",
                  JSON.stringify({ id, tool: toolName, input: toolInput, scope }),
                );
              });
              // Only a question card ever settles as "answer", and those are
              // awaited above — but the union is shared, so narrow it here
              // rather than handing the CLI a shape it can't parse.
              answer(
                decision.behavior === "answer"
                  ? { behavior: "deny", message: formatAnswers(decision.answers) }
                  : decision,
              );
            })();
          });

          // POST /__question_answer { id, answers: [{header, question, answers[]}] }
          // The browser's answer to one question card. Rides the exact same
          // pendingApprovals/settle machinery the approval cards use.
          server.middlewares.use("/__question_answer", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            if (req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            void (async () => {
              let body = "";
              for await (const chunk of req as any) body += chunk;
              let p: { id?: string; answers?: unknown };
              try {
                p = JSON.parse(body || "{}");
              } catch {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "invalid json" }));
                return;
              }
              const id = String(p.id ?? "");
              if (!pendingApprovals.has(id)) {
                // Timed out, or answered in another tab — the card just goes stale.
                res.end(JSON.stringify({ ok: false, reason: "no such pending question" }));
                return;
              }
              const answers: QuestionAnswer[] = (Array.isArray(p.answers) ? p.answers : [])
                .slice(0, 4)
                .map((a: any) => ({
                  header: String(a?.header ?? "").slice(0, 40),
                  question: String(a?.question ?? "").slice(0, 600),
                  answers: (Array.isArray(a?.answers) ? a.answers : [])
                    .slice(0, 8)
                    .map((s: any) => String(s ?? "").slice(0, 500))
                    .filter(Boolean),
                }));
              settleApproval(id, { behavior: "answer", answers }, "answered");
              res.end(JSON.stringify({ ok: true }));
            })();
          });

          // POST /__permission_decision { id, decision: allow|always|deny, message? }
          // The browser's answer to one card. "always" allows this call AND
          // remembers the scope for the rest of the server's life.
          server.middlewares.use("/__permission_decision", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            if (req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            void (async () => {
              let body = "";
              for await (const chunk of req as any) body += chunk;
              let p: { id?: string; decision?: string; message?: string; scope?: string };
              try {
                p = JSON.parse(body || "{}");
              } catch {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "invalid json" }));
                return;
              }
              const id = String(p.id ?? "");
              const pending = pendingApprovals.get(id);
              if (!pending) {
                // Already timed out, or answered from another tab — not an
                // error worth surfacing, the card just goes stale.
                res.end(JSON.stringify({ ok: false, reason: "no such pending decision" }));
                return;
              }
              if (p.decision === "allow" || p.decision === "always") {
                if (p.decision === "always" && p.scope) {
                  const set = approvalAlways.get(pending.chatId) ?? new Set<string>();
                  set.add(String(p.scope));
                  approvalAlways.set(pending.chatId, set);
                }
                settleApproval(id, { behavior: "allow", updatedInput: pending.input }, p.decision);
              } else {
                settleApproval(
                  id,
                  {
                    behavior: "deny",
                    message:
                      String(p.message ?? "").trim() ||
                      "The user declined this tool call. Ask what they'd like instead.",
                  },
                  "deny",
                );
              }
              res.end(JSON.stringify({ ok: true }));
            })();
          });

          // ── Live runs ─────────────────────────────────────────────────────
          // A chat whose child process is alive can never render as idle. Every
          // turn registers here for its lifetime, keeps a replay buffer of the
          // events it has emitted, and fans new events out to anyone attached.
          // That's what lets a reloaded tab (or a second window, or a click on
          // a rail row) pick a running conversation back up mid-sentence
          // instead of staring at a dead thread.
          interface LiveRun {
            chatId: string;
            sessionId: string;
            model: string;
            startedAt: number;
            child: ReturnType<typeof spawn> | null;
            /** Stopped on purpose (steering, or the user's Stop button). Never
                a dead end to fail over from — the user IS the next step. */
            abortedByUser: boolean;
            buffer: Array<[string, string]>;
            /** Running size of `buffer` — the cap is bytes, not entry count. */
            bufferBytes: number;
            subscribers: Set<(event: string, data: string) => void>;
          }
          const liveRuns = new Map<string, LiveRun>();
          // Explain last instance's casualties before serving anything. Editing
          // a client file reloads this module and kills every in-flight child;
          // without this the turns just stopped, with nothing anywhere saying
          // why, which is indistinguishable from a hang.
          reapOrphanedRuns();

          // Files a turn claimed to write AND which were then verified to exist.
          // /__claude_file serves ONLY what is in here, so the endpoint is not a
          // "read any file under $HOME" primitive that happens to be gated — it
          // can reach exactly the paths this server watched a turn produce.
          const servableFiles = new Set<string>();

          /** "moonshotai/kimi-k3" → "kimi-k3". For messages the user reads. */
          const shortModelName = (m: string): string =>
            (m || "the agent").split("/").pop() || "the agent";

          // ── Shutdown ──────────────────────────────────────────────────────
          // There were NO exit handlers in this file. Every dev-server restart
          // — and editing this very file causes one — orphaned whatever agents
          // were mid-turn: still running, still spending, no longer reachable
          // by any Stop because the registry that knew about them died with the
          // server. Now that children are detached (their own process group)
          // they would survive even more reliably, so this is not optional.
          //
          // A run whose server is gone cannot be attached to, cancelled, or
          // even observed, so ending it is the only honest option.
          let shuttingDown = false;
          const killAllRuns = () => {
            if (shuttingDown) return;
            shuttingDown = true;
            for (const run of liveRuns.values()) {
              const pid = run.child?.pid;
              if (!pid) continue;
              try {
                process.kill(-pid, "SIGTERM");
              } catch {
                try {
                  run.child?.kill("SIGTERM");
                } catch {
                  /* already gone */
                }
              }
              // No grace period on exit — the event loop is about to stop, so a
              // deferred SIGKILL would never run. SIGTERM then SIGKILL, now.
              try {
                process.kill(-pid, "SIGKILL");
              } catch {
                /* the SIGTERM was enough, or it's already reaped */
              }
            }
          };
          // ── Staying alive ─────────────────────────────────────────────────
          // Nothing here caught process-level faults, and Vite installs no
          // handler either, so ONE unhandled rejection anywhere killed the dev
          // server and every agent turn running under it. The shapes that
          // actually occur: `for await (const chunk of req)` rejecting with
          // ERR_STREAM_PREMATURE_CLOSE when a client aborts mid-body (13 call
          // sites, 9 of them inside fire-and-forget `void (async () => …)()`
          // IIFEs whose rejection nobody owns), and a res.end() on an
          // already-finished response.
          //
          // A dev server that dies takes hours of unattended work with it, and
          // the chat just stops with no message. Log loudly, stay up. This is
          // deliberately NOT a blanket "ignore errors": every one is printed
          // with its stack so it can still be found and fixed.
          const alreadyGuarded = (process as unknown as { __claudeOsGuarded?: boolean })
            .__claudeOsGuarded;
          if (!alreadyGuarded) {
            (process as unknown as { __claudeOsGuarded?: boolean }).__claudeOsGuarded = true;
            process.on("unhandledRejection", (reason) => {
              const msg =
                (reason as { stack?: string; message?: string })?.stack ??
                (reason as { message?: string })?.message ??
                String(reason);
              if (/ERR_STREAM_PREMATURE_CLOSE|aborted|ECONNRESET|EPIPE/i.test(msg)) return; // client went away
              console.error("[claude-os] unhandled rejection (server kept alive):\n", msg);
            });
            process.on("uncaughtException", (err) => {
              console.error(
                "[claude-os] uncaught exception (server kept alive):\n",
                err?.stack ?? err,
              );
            });
          }

          // Vite re-runs configureServer on every restart, so registering the
          // shutdown handlers directly here would stack a fresh closure per
          // restart — each pinning a dead server's liveRuns map, and eventually
          // a MaxListenersExceededWarning. Register ONCE, and have that single
          // handler always call the CURRENT instance's killer.
          const procSlot = process as unknown as { __claudeOsKillAll?: () => void };
          procSlot.__claudeOsKillAll = killAllRuns;
          if (!alreadyGuarded) {
            const runKill = () => {
              try {
                procSlot.__claudeOsKillAll?.();
              } catch {
                /* shutting down anyway */
              }
            };
            process.once("exit", runKill);
            for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
              process.once(sig, () => {
                runKill();
                // Registering a signal listener suppresses Node's default exit,
                // so we have to exit ourselves — but only after giving Vite's own
                // handler a moment to close cleanly. unref'd so it never holds
                // the process open on its own.
                setTimeout(() => process.exit(0), 250).unref();
              });
          }
          server.httpServer?.once("close", killAllRuns);

          // Every turn on a chat — the one holding the child AND any queued
          // behind it — registers a control here. Cancelling only the running
          // child let the queued turn start half a second later, so from the
          // user's chair Stop did nothing at all. Cancel reaches all of them.
          interface TurnControl {
            cancel: () => void;
            startedAt: number;
          }
          const chatTurns = new Map<string, Set<TurnControl>>();
          /** Cancel every turn on a chat that had already STARTED when the
              cancel was issued. Returns how many it reached.

              The cutoff matters. Cancelling "every turn on this chat"
              unconditionally loses a race: Stop is pressed, the turn it was
              meant for finishes a millisecond later of its own accord, the user
              (or autopilot, or a second window) sends the next message, and the
              in-flight cancel arrives and kills THAT one instead. The user sees
              a message they just sent die instantly for no reason — which reads
              exactly like the app being broken, and is far more confusing than a
              Stop that missed. A turn that began after you pressed Stop is not
              a turn you asked to stop. */
          const cancelChat = (chatId: string, issuedAt: number = Date.now()): number => {
            const controls = chatTurns.get(chatId);
            const run = liveRuns.get(chatId);
            if (run && run.startedAt <= issuedAt) run.abortedByUser = true;
            let n = 0;
            for (const c of [...(controls ?? [])]) {
              if (c.startedAt > issuedAt) continue; // started after Stop — not ours to kill
              try {
                c.cancel();
                n += 1;
              } catch {
                /* one wedged control must not block the others */
              }
            }
            // Belt and braces: if the registry and the control set ever
            // disagree, the child still dies — but only if it is a child this
            // cancel was actually aimed at.
            if (run && run.startedAt <= issuedAt && killTree(run.child) && n === 0) n = 1;
            return n;
          };

          const writeSse = (res: any, event: string, data: string) => {
            const safe = data.replace(/\r/g, "");
            for (const line of safe.split("\n")) {
              res.write(`event: ${event}\n`);
              res.write(`data: ${line}\n\n`);
            }
          };

          // GET /__sessions_live — which chats have a child process alive right
          // now. Polled by the rail so every row, open or not, tells the truth.
          server.middlewares.use("/__sessions_live", (req, res, next) => {
            if (req.method !== "GET") return next();
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            res.end(
              JSON.stringify({
                runs: [...liveRuns.values()].map((r) => ({
                  chatId: r.chatId,
                  sessionId: r.sessionId,
                  model: r.model,
                  startedAt: r.startedAt,
                })),
              }),
            );
          });

          // GET /__claude_attach?chatId=… — re-join a run already in flight.
          // Replays everything the turn has emitted so far, then streams the
          // rest, speaking the identical SSE vocabulary as /__claude_chat so
          // the client can pump it through the same reader.
          server.middlewares.use("/__claude_attach", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const chatId = new URL(req.url ?? "", "http://x").searchParams.get("chatId") ?? "";
            const run = liveRuns.get(chatId);
            if (!run) {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "no live run" }));
              return;
            }
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");
            (res as any).flushHeaders?.();
            for (const [e, d] of run.buffer) writeSse(res, e, d);
            const heartbeat = setInterval(() => res.write(":keepalive\n\n"), 15_000);
            const sub = (event: string, data: string) => {
              writeSse(res, event, data);
              // The turn's own terminators end the attachment too.
              if (event === "done" || event === "error") {
                clearInterval(heartbeat);
                run.subscribers.delete(sub);
                res.end();
              }
            };
            run.subscribers.add(sub);
            req.on("close", () => {
              clearInterval(heartbeat);
              run.subscribers.delete(sub);
            });
          });

          // POST /__claude_abort { chatId } — stop the child that's running.
          // Steering needs a real stop, not a detach: the point is for the
          // user's interjection to land NOW, and the per-session turn lock
          // won't release until the current child is actually gone.
          server.middlewares.use("/__claude_abort", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            if (req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            // Stamped BEFORE the body is read, so slow parsing can't widen the
            // window in which a newly-started turn looks cancellable.
            const issuedAt = Date.now();
            void (async () => {
              let body = "";
              for await (const chunk of req as any) body += chunk;
              let chatId = "";
              try {
                chatId = String(JSON.parse(body || "{}").chatId ?? "");
              } catch {
                /* an empty chatId simply finds no run */
              }
              // `ok: false` used to come back whenever the registry had no
              // child — including the case where the turn was still QUEUED, or
              // where the run had been evicted from the registry by a second
              // turn on the same chat. Both are states the user can plainly see
              // as "it's running", so answering "nothing running" and doing
              // nothing was the app calling the user a liar. cancelChat reaches
              // queued turns too, and reports honestly.
              const reached = cancelChat(chatId, issuedAt);
              res.end(JSON.stringify({ ok: reached > 0, turns: reached }));
            })();
          });

          // POST /__claude_abort_all — stop every turn on every chat.
          // The escape hatch for the state this app kept getting into: several
          // chats running at once, one of them not answering its own Stop, and
          // no single control that ends all of it.
          server.middlewares.use("/__claude_abort_all", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            if (req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            const chatIds = new Set([...liveRuns.keys(), ...chatTurns.keys()]);
            let total = 0;
            for (const id of chatIds) total += cancelChat(id);
            res.end(JSON.stringify({ ok: true, chats: chatIds.size, turns: total }));
          });

          // ── Router integrity ──────────────────────────────────────────────
          // claude-code-router has FIVE routes (default, background, think,
          // longContext, webSearch) and the Claude Code harness picks between
          // them per request. On 2026-07-24 every one of them was pinned to
          // z-ai/glm-5.2, so a chat set to Kimi K3 was answered by GLM for every
          // thinking request and every request past the long-context threshold.
          // Two all-night website builds were authored by a model the user never
          // chose and it read as "the model lost the plot". Nothing detected it,
          // because the selected model only ever governs `default`.
          const CCR_CONFIG = join(homedir(), ".claude-code-router", "config.json");
          const CCR_ROUTES = [
            "default",
            "background",
            "think",
            "longContext",
            "webSearch",
          ] as const;
          // The chat pins ANTHROPIC_MODEL to the user's pick, and ccr honours
          // that for ordinary turns — verified live: a chat set to glm-5.2 was
          // answered by glm-5.2 even with `default` pinned to kimi-k3. What the
          // override does NOT cover is the routes ccr selects for itself, which
          // is exactly the set that silently rewrote two overnight builds. So
          // `default` is checked but not warned about; these four are.
          // Route values look like "openrouter,vendor/model" — the provider
          // prefix is the routing lane, the tail is the model we care about.
          const routeModel = (v: unknown): string => {
            const s = String(v ?? "").trim();
            if (!s) return "";
            const comma = s.indexOf(",");
            return comma >= 0 ? s.slice(comma + 1).trim() : s;
          };
          const routerMismatches = (selected: string): Array<{ route: string; model: string }> => {
            try {
              const cfg = JSON.parse(readFileSync(CCR_CONFIG, "utf-8"));
              const router = cfg?.Router ?? cfg?.router ?? {};
              const out: Array<{ route: string; model: string }> = [];
              for (const r of CCR_ROUTES) {
                if (r === "default" || router[r] === undefined) continue;
                const m = routeModel(router[r]);
                if (m && m !== selected) out.push({ route: r, model: m });
              }
              return out;
            } catch {
              // No router config, or unreadable — nothing to assert, and a
              // preflight is never worth failing a chat over.
              return [];
            }
          };

          /** Rewrite every ccr route to `model`, keeping each route's existing
              provider prefix. Backs the old config up, restarts the daemon.
              Returns the backup path, or null if nothing could be written.

              This exists as a FUNCTION, not just an endpoint, because warning
              the user was not enough. The mismatch was detected correctly on
              24 Jul, announced as a `router_mismatch` event — and the turn ran
              anyway, on GLM, because acting on the warning required noticing a
              chip and clicking it. Two overnight website builds were authored
              by a model the user never selected. A safeguard that needs a human
              to be watching is not a safeguard; it is a log line. */
          const pinRoutesTo = (model: string): string | null => {
            if (!/^[A-Za-z0-9][A-Za-z0-9_.\/:-]{0,119}$/.test(model)) return null;
            try {
              const raw = readFileSync(CCR_CONFIG, "utf-8");
              const cfg = JSON.parse(raw);
              const routerKey = cfg?.Router !== undefined ? "Router" : "router";
              const router = cfg[routerKey] ?? {};
              for (const r of CCR_ROUTES) {
                if (router[r] === undefined) continue;
                const cur = String(router[r]);
                const comma = cur.indexOf(",");
                router[r] = comma >= 0 ? `${cur.slice(0, comma)},${model}` : model;
              }
              cfg[routerKey] = router;
              const backup = `${CCR_CONFIG}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
              writeFileSync(backup, raw, { mode: 0o600 });
              writeFileSync(CCR_CONFIG, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
              const ccrBin = resolveCliBin("ccr");
              if (ccrBin) spawn(ccrBin, ["restart"], { detached: true, stdio: "ignore" }).unref();
              return backup;
            } catch {
              return null;
            }
          };

          // POST /__ccr_pin_routes { model } — make every route answer with the
          // model the user actually picked. Backs the config up first, then
          // restarts ccr so the daemon re-reads it.
          server.middlewares.use("/__ccr_pin_routes", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            if (req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            void (async () => {
              let body = "";
              for await (const chunk of req as any) body += chunk;
              let model = "";
              try {
                model = String(JSON.parse(body || "{}").model ?? "").trim();
              } catch {
                /* handled by the validation below */
              }
              if (!/^[A-Za-z0-9][A-Za-z0-9_.\/:-]{0,119}$/.test(model)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "invalid model" }));
                return;
              }
              try {
                const raw = readFileSync(CCR_CONFIG, "utf-8");
                const cfg = JSON.parse(raw);
                const routerKey = cfg?.Router !== undefined ? "Router" : "router";
                const router = cfg[routerKey] ?? {};
                // Keep whatever provider prefix each route already used — the
                // bug is the MODEL, not the lane.
                for (const r of CCR_ROUTES) {
                  if (router[r] === undefined) continue;
                  const cur = String(router[r]);
                  const comma = cur.indexOf(",");
                  router[r] = comma >= 0 ? `${cur.slice(0, comma)},${model}` : model;
                }
                cfg[routerKey] = router;
                const backup = `${CCR_CONFIG}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
                writeFileSync(backup, raw, { mode: 0o600 });
                writeFileSync(CCR_CONFIG, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
                const ccrBin = resolveCliBin("ccr");
                if (ccrBin) spawn(ccrBin, ["restart"], { detached: true, stdio: "ignore" }).unref();
                res.end(JSON.stringify({ ok: true, backup, restarted: Boolean(ccrBin) }));
              } catch (e: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: String(e?.message ?? e) }));
              }
            })();
          });

          // One running turn per session, enforced at the source: a second
          // message for the same session — from another window, autopilot,
          // or the manager — queues here instead of racing the first.
          const sessionTurnLocks = new Map<string, Promise<void>>();
          // GET /__claude_chats — the server-side chat registry, newest first.
          // The rail merges this with its own localStorage rows, which is what
          // makes a script-started (headless) session visible and openable in
          // the UI at all. Loopback + token gated like its neighbours.
          server.middlewares.use("/__claude_chats", (req, res, next) => {
            if (req.method !== "GET") return next();
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            if (req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "invalid token" }));
              return;
            }
            res.end(JSON.stringify({ chats: readChatRegistry() }));
          });

          // GET /__claude_file?path=… — open a file a turn actually wrote.
          //
          // The narrow scope IS the security model: this serves only paths in
          // `servableFiles`, i.e. paths some turn on this server named AND which
          // were then verified to exist at the end of that turn. It is not a
          // read-anything-under-$HOME endpoint with a guard bolted on, so a path
          // traversal has nothing to traverse to. Loopback-only (which also
          // carries the anti-DNS-rebinding Host check) on top of that.
          //
          // No token: this is reached by a plain <a href> click from the pane,
          // and a header cannot ride on one. Putting the dev token in the query
          // string would leak it into history and Referer for every deliverable
          // the user opens, which is a worse trade than the allowlist above.
          server.middlewares.use("/__claude_file", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end("loopback only");
              return;
            }
            const want = new URL(req.url || "", "http://localhost").searchParams.get("path") ?? "";
            if (!servableFiles.has(want)) {
              res.statusCode = 404;
              res.end("no turn on this server produced that file");
              return;
            }
            let real: string;
            try {
              // Re-check at serve time, not just at verify time: the file can be
              // replaced by a symlink in between, and the allowlist entry would
              // then point somewhere it was never meant to.
              if (!lstatSync(want).isFile()) throw new Error("not a regular file");
              real = realpathSync(want);
              if (realpathSync(want) !== want && !real.startsWith(`${homedir()}${sep}`))
                throw new Error("escapes home");
            } catch {
              res.statusCode = 404;
              res.end("not found");
              return;
            }
            const ext = want.includes(".") ? want.split(".").pop()!.toLowerCase() : "";
            const mime =
              (
                {
                  png: "image/png",
                  jpg: "image/jpeg",
                  jpeg: "image/jpeg",
                  gif: "image/gif",
                  webp: "image/webp",
                  svg: "image/svg+xml",
                  avif: "image/avif",
                  pdf: "application/pdf",
                  html: "text/html; charset=utf-8",
                  htm: "text/html; charset=utf-8",
                  md: "text/markdown; charset=utf-8",
                  txt: "text/plain; charset=utf-8",
                  json: "application/json; charset=utf-8",
                  csv: "text/csv; charset=utf-8",
                  yaml: "text/yaml; charset=utf-8",
                  yml: "text/yaml; charset=utf-8",
                  mp4: "video/mp4",
                  mov: "video/quicktime",
                  webm: "video/webm",
                  mp3: "audio/mpeg",
                  wav: "audio/wav",
                } as Record<string, string>
              )[ext] ?? "text/plain; charset=utf-8";
            res.setHeader("Content-Type", mime);
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Cache-Control", "no-store");
            // Same reasoning as /__hermes_documents: the agent writes these
            // files while acting on untrusted input, so active content must not
            // run script in the dashboard's origin, where /__token lives.
            if (["html", "htm", "svg", "xml"].includes(ext))
              res.setHeader(
                "Content-Security-Policy",
                "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:",
              );
            createReadStream(real)
              .on("error", () => {
                try {
                  res.statusCode = 500;
                  res.end("read failed");
                } catch {
                  /* already sent */
                }
              })
              .pipe(res);
          });

          server.middlewares.use("/__claude_chat", async (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const provided = req.headers["x-claude-os-token"];
            if (provided !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "invalid token" }));
              return;
            }
            let body = "";
            for await (const chunk of req as any) body += chunk;
            // `provider` is what the user actually PICKED, not what the model id
            // implies. The same id can exist on a subscription lane and a metered
            // one, so inferring the lane from the name alone spends the user's
            // money on a coin flip. Optional: headless callers and failover
            // targets have no provider, and fall back to the name.
            let payload: {
              prompt?: string;
              message?: string;
              sessionId?: string;
              yolo?: boolean;
              model?: string;
              provider?: string;
              effort?: string;
              permissionMode?: string;
              ctxWindow?: number;
              chatId?: string;
              toolMode?: string;
              origin?: string;
              title?: string;
            };
            try {
              payload = JSON.parse(body || "{}");
            } catch {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid json" }));
              return;
            }
            const prompt = (payload.prompt ?? payload.message)?.trim() ?? "";
            if (!prompt || prompt.length > 12_000) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "prompt empty or too long" }));
              return;
            }
            // Optional sessionId resumes an existing conversation via
            // `claude --resume <id>` (Claude Code session ids are UUIDs, so
            // the hermes-style safe charset covers them). Validated so it
            // can't escape to argv.
            let sessionId = payload.sessionId?.trim() ?? "";
            if (sessionId && !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid sessionId" }));
              return;
            }
            // Yolo mode → --dangerously-skip-permissions, mirroring the
            // hermes endpoint's opt-in. NEVER the default: a headless
            // `claude -p` without it simply declines tools it can't get
            // approval for, which is the safe baseline.
            const yolo = payload.yolo === true;
            // Optional per-chat model override → `claude --model <id>`.
            // Same safe charset as the hermes endpoint.
            const model = typeof payload.model === "string" ? payload.model.trim() : "";
            if (model && !/^[A-Za-z0-9][A-Za-z0-9_.\/:-]{0,119}$/.test(model)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid model" }));
              return;
            }
            // Three lanes, one endpoint:
            //   "vendor/model" (moonshotai/kimi-k3) → Claude Code through
            //     claude-code-router → OpenRouter
            //   "gpt-*" → the Codex CLI (the user's ChatGPT/Codex OAuth)
            //   anything else → Claude Code on the Anthropic subscription
            // Only used here to pick the binary for the "is it installed at
            // all" check — each attempt re-derives its own lane, because a
            // failover can change lanes mid-turn.
            //
            // THE LANE IS THE PROVIDER'S, NOT THE NAME'S. The picker has always
            // known which catalog group a model came from and has never sent
            // it, so the server re-guessed from the id: `/^gpt-/` → Codex,
            // "vendor/model" → OpenRouter, anything else → the Anthropic
            // subscription. `gpt-5.6-sol` exists in the catalog on BOTH an
            // OAuth lane the user already pays for and a metered one, with the
            // same id, so that guess is a coin flip with the user's money on
            // it. The client now sends the provider; the name stays as the
            // fallback for headless callers and for failover targets, which
            // have no provider of their own.
            const rawProvider = typeof payload.provider === "string" ? payload.provider.trim() : "";
            // Same escape-proofing as the model id: this reaches no argv, but it
            // does reach the user's screen and the lane decision.
            const provider = /^[A-Za-z0-9][A-Za-z0-9 _.·\/-]{0,63}$/.test(rawProvider)
              ? rawProvider
              : "";
            /** The lane for a model, using the request's provider only for the
                model the request actually asked for. A failover hop is a
                different model on a different lane, so it must re-derive from
                its own id rather than inherit the provider of the one it
                replaced. */
            const laneOf = (m: string): Lane => laneFor(m, m === model ? provider : "");
            const viaCodex = laneOf(model) === "codex";

            // Approval cards and live-run attachment both need a stable per-chat
            // identity that outlives a single turn. The client mints one when
            // the pane opens a chat; the CLI session id can't do this job
            // because it doesn't exist until the first turn's `init` line.
            const rawChatId = typeof payload.chatId === "string" ? payload.chatId.trim() : "";
            // A headless caller usually sends no chatId at all. It used to fall
            // back to the literal "pane", so two overnight scripts running at
            // once shared one identity — one registry row, one live-run slot,
            // one set of approval cards. Mint a unique one instead.
            const chatIdWasSupplied = /^[A-Za-z0-9_-]{1,64}$/.test(rawChatId) || !!sessionId;
            const chatId = /^[A-Za-z0-9_-]{1,64}$/.test(rawChatId)
              ? rawChatId
              : sessionId || `headless-${randomBytes(6).toString("hex")}`;

            // A POST carrying a chatId but no sessionId used to run `claude -p`
            // with no --resume: a brand-new, context-free session bolted onto an
            // existing chat. That is not a hypothetical — a supervisor script
            // nudged a running build that way and started a second agent, with
            // none of the build's history, working the same directory as the
            // first. The chat's own transcript was sitting in the registry the
            // whole time. Look it up rather than forking.
            const priorRow = readChatRegistry().find((r) => r.chatId === chatId);
            if (!sessionId) {
              const known = priorRow?.sessionId;
              if (known && /^[A-Za-z0-9_-]{1,128}$/.test(known)) {
                sessionId = known;
              }
            }
            // Did this chat's LAST turn disappear into a server restart? The
            // reaper stamped the row at boot; this is the first moment there is
            // a stream to say it on. Read before recordChatTurn below, which
            // clears the marker.
            const priorEndedBy =
              priorRow?.endedBy === "server-restart"
                ? new Date(priorRow.endedAt ?? Date.now()).toLocaleTimeString()
                : "";

            // Server-side chat registry. A browser fetch always carries an
            // Origin (and a Referer); curl / a shell script carries neither —
            // that's the only honest way to tell a pane turn from a headless
            // one, and the caller can override it explicitly.
            const chatOrigin: "ui" | "headless" =
              payload.origin === "ui" || payload.origin === "headless"
                ? payload.origin
                : req.headers["origin"] || req.headers["referer"]
                  ? "ui"
                  : "headless";
            // Only write a row now if this chat has a REAL identity. A caller
            // that sends neither chatId nor sessionId gets a freshly minted
            // `headless-…` id on every single POST — so a supervisor or cron
            // hitting this endpoint every five minutes wrote ~288 new rows a
            // day into a 200-row capped file and silently flushed out every one
            // of the user's actual conversations. The chat the script starts is
            // still recorded: announceSession() writes the row the moment the
            // CLI reports its session id, which is also the first moment the
            // row is any use (before that it points at no transcript).
            if (chatIdWasSupplied)
              recordChatTurn({
                chatId,
                sessionId,
                title: typeof payload.title === "string" ? payload.title.slice(0, 120) : undefined,
                model,
                origin: chatOrigin,
                lastPrompt: prompt.slice(0, 400),
              });

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");
            (res as any).flushHeaders?.();
            // Heartbeat comment every 15s so connections through proxies
            // don't time out mid-thought on a long reply.
            const heartbeat = setInterval(() => {
              res.write(":keepalive\n\n");
            }, 15_000);

            // Detached = the browser that STARTED the turn went away (pane
            // refresh, HMR, tab close). The run continues headless and keeps
            // filling its replay buffer, so a tab that comes back can attach
            // and catch up; writes to this particular response stop.
            let detached = false;
            const sendEvent = (event: string, data: string) => {
              const run = liveRuns.get(chatId);
              if (run) {
                run.buffer.push([event, data]);
                run.bufferBytes += data.length + event.length;
                // Capped by BYTES as well as by count. A count-only cap was no
                // cap at all: entries hold whole assistant chunks, thinking
                // blocks and the ctx manifest, so 4,000 of them is tens of MB
                // for a file-heavy turn — held per live run, and replayed in one
                // burst to every client that attaches.
                //
                // Trimmed in one batch down to 75%, not one entry per event:
                // at the cap the old code ran an O(4000) memmove on EVERY
                // subsequent event for the rest of the run.
                const OVER = run.buffer.length > 4_000 || run.bufferBytes > 8_000_000;
                if (OVER) {
                  const drop = Math.max(1, Math.floor(run.buffer.length * 0.25));
                  for (let i = 0; i < drop; i += 1)
                    run.bufferBytes -= run.buffer[i][0].length + run.buffer[i][1].length;
                  run.buffer.splice(0, drop);
                  if (run.bufferBytes < 0) run.bufferBytes = 0;
                }
                for (const s of [...run.subscribers]) {
                  try {
                    s(event, data);
                  } catch {
                    /* a broken subscriber must never break the run */
                  }
                }
              }
              if (detached) return;
              // Guarded: this is called from inside the child's stdout handler,
              // where a throw is an UNCAUGHT EXCEPTION, not a rejection — it
              // would take the whole dev server down and orphan every other
              // chat's agent. The subscriber fan-out above was already guarded;
              // this line was not.
              try {
                writeSse(res, event, data);
              } catch {
                /* the response is gone — the replay buffer still has it */
              }
            };

            // Tracked here rather than beside the spawn, because cancellation
            // has to be able to reach the child from the moment this turn
            // exists — including while it is still queued behind another.
            let liveChild: ReturnType<typeof spawn> | null = null;
            let cancelled = false;
            let leaveQueue: (() => void) | null = null;
            const control: TurnControl = {
              startedAt: Date.now(),
              cancel: () => {
                cancelled = true;
                killTree(liveChild);
                leaveQueue?.(); // a queued turn stops waiting and exits
              },
            };
            {
              const set = chatTurns.get(chatId) ?? new Set<TurnControl>();
              set.add(control);
              chatTurns.set(chatId, set);
            }
            const retireControl = () => {
              const set = chatTurns.get(chatId);
              if (!set) return;
              set.delete(control);
              if (!set.size) chatTurns.delete(chatId);
            };

            // Disconnect handling has to be armed BEFORE the queue wait below.
            // The only close handler used to be registered after it, so a
            // browser that went away while its turn was still QUEUED — a tab
            // close, or the HMR reload that happens constantly in development —
            // left the 15s heartbeat writing to a destroyed socket forever
            // (silently: writes to a destroyed response are swallowed), kept the
            // whole handler closure alive, and then went on to spawn a real
            // agent, for nobody, when the lock finally freed.
            //
            // Queued and abandoned = cancel. Already working = detach, which is
            // the deliberate behaviour that lets a run survive a pane refresh.
            let workStarted = false;
            req.on("close", () => {
              if (workStarted) {
                detached = true;
                return;
              }
              cancelled = true;
              leaveQueue?.();
              clearInterval(heartbeat);
            });

            // Cleanup that MUST happen exactly once, however this turn ends —
            // including by an exception. Before this existed the handler had no
            // try/finally at all: a single throw anywhere in ~800 lines left the
            // chat's lock promise unresolved forever, so every later message on
            // that chat printed "queued behind the turn already running here"
            // and hung, while the rail showed it working for thousands of
            // minutes. Idempotent, and each step isolated so one failure cannot
            // block the rest.
            let liveRunForCleanup: LiveRun | null = null;
            let turnCleaned = false;
            const finalizeTurn = () => {
              if (turnCleaned) return;
              turnCleaned = true;
              try {
                clearInterval(heartbeat);
              } catch {
                /* nothing to do */
              }
              try {
                if (liveRunForCleanup && liveRuns.get(chatId) === liveRunForCleanup)
                  liveRuns.delete(chatId);
              } catch {
                /* nothing to do */
              }
              try {
                // This turn reached its own end, however badly — nothing for the
                // next boot's reaper to explain.
                markRunDone(chatId);
              } catch {
                /* nothing to do */
              }
              try {
                retireControl();
              } catch {
                /* nothing to do */
              }
              try {
                releaseTurn();
              } catch {
                /* nothing to do */
              }
              try {
                clearDeadlineRef?.();
              } catch {
                /* nothing to do */
              }
            };
            // Assigned once the turn is past the queue and the deadline exists.
            let clearDeadlineRef: (() => void) | null = null;

            // Turn serialization, keyed on CHAT not session. It used to be
            // `if (sessionId)`, which meant a brand-new chat — no session id
            // until the CLI's first `init` line — took no lock at all. Two
            // turns then ran concurrently on one chat, and the second one's
            // `liveRuns.set(chatId, …)` evicted the first from the registry,
            // leaving a running child that no Stop could ever find. chatId is
            // always present, so the lock is now always taken.
            let releaseTurn = () => {};
            try {
              {
                const prior = sessionTurnLocks.get(chatId);
                let release: () => void = () => {};
                const mine = new Promise<void>((r) => (release = r));
                sessionTurnLocks.set(chatId, mine);
                releaseTurn = () => {
                  release();
                  if (sessionTurnLocks.get(chatId) === mine) sessionTurnLocks.delete(chatId);
                };
                if (prior) {
                  // The old text — "another turn is already running on this chat
                  // — queued, starts the moment it finishes" — told the user
                  // nothing they could act on: not what was running, not for how
                  // long, not that Stop would clear it.
                  const ahead = liveRuns.get(chatId);
                  const mins = ahead ? Math.round((Date.now() - ahead.startedAt) / 60_000) : 0;
                  sendEvent(
                    "info",
                    `⏳ queued behind the turn already running here${
                      ahead
                        ? ` (${shortModelName(ahead.model)}, ${mins < 1 ? "under a minute" : `${mins} min`} in)`
                        : ""
                    } — it starts automatically when that one ends. Stop clears both.`,
                  );
                  await Promise.race([
                    prior,
                    new Promise<void>((r) => {
                      leaveQueue = r;
                    }),
                  ]);
                  if (cancelled) {
                    // Cancelled while waiting. Leave without spawning anything —
                    // previously this turn started anyway a moment after the user
                    // pressed Stop, which is exactly what "Stop does nothing"
                    // looked like from the outside.
                    sendEvent("info", "■ queued turn cancelled");
                    sendEvent("done", "cancelled");
                    return; // finally handles cleanup
                  }
                  sendEvent("info", "▶ queued turn starting now");
                }
              }
              if (cancelled) {
                sendEvent("done", "cancelled");
                return; // the finally below does every piece of cleanup
              }
              // Past the queue. From here a disconnect means "detach and keep
              // going", not "cancel" — see the close handler above.
              workStarted = true;

              // Ceiling on the WHOLE turn, not just one attempt. ABSOLUTE_MAX_MS
              // is per attempt, and a turn can make five of them (initial +
              // flag-rejected retry + up to three failover hops), so a chat whose
              // model was dead could hold its lock for ~15 hours. Every message
              // sent in that window answered "queued behind the turn already
              // running here" and did nothing. Four hours is far beyond any real
              // build and still guarantees the chat comes back the same day.
              const TURN_MAX_MS = 4 * 3_600_000;
              const turnDeadline = setTimeout(() => {
                if (turnFinished) return;
                try {
                  sendEvent(
                    "info",
                    "⏱ this turn hit the 4-hour ceiling and was stopped so the chat isn't left locked. Anything above is kept — send again to carry on.",
                  );
                } catch {
                  /* stream may be gone; the cancel below is the point */
                }
                control.cancel();
              }, TURN_MAX_MS);
              turnDeadline.unref?.();
              // Cleared however the turn ends, so a finished turn leaves no timer.
              // finalizeTurn() — which runs in this handler's `finally`, on every
              // path — is the only thing that clears it.
              //
              // It used to ALSO be cleared on `req.close`, and that was the hole:
              // a browser going away detaches the run rather than cancelling it,
              // so the turn carried on with its 4-hour ceiling deleted, leaving
              // only the 3-hour-per-child one. An overnight headless build — the
              // exact case the ceiling exists for — was the one case that lost it.
              const clearDeadline = () => clearTimeout(turnDeadline);
              clearDeadlineRef = clearDeadline;

              // ── The turn's process ledger ─────────────────────────────────
              // Read at the single spawn boundary inside runAttempt, so it counts
              // EVERY child: initial attempt, session/flag retries, failover hops
              // and auto-continue resumes alike.
              const turnStartedAt = Date.now();
              let childrenSpawned = 0;
              /** Measured, not guessed: the most children the code above can ask
                for is 1 initial + 1 fresh-session retry + 1 dropped-flag retry
                + 2 failover hops (chain length 2, `tried` prevents repeats)
                + 5 resumes = 10. Twelve is that with headroom, and it exists to
                catch a future path that forgets to count itself — not to bound
                normal recovery, which stops far earlier. */
              const MAX_CHILDREN_PER_TURN = 12;

              // resolveCliBin checks ~/.local/bin / Homebrew / /usr/local/bin
              // first, then PATH (`which claude`) — same discovery order the
              // hermes endpoint uses, so nvm / npm-global installs work too.
              const binPath = viaCodex ? resolveCliBin("codex") : resolveCliBin("claude");
              if (!binPath) {
                sendEvent(
                  "error",
                  viaCodex
                    ? "Codex CLI not found — install it (npm i -g @openai/codex) and sign in with `codex login`."
                    : "Claude Code binary not found on PATH.",
                );
                clearInterval(heartbeat);
                releaseTurn();
                res.end();
                return;
              }

              // Run claude from the user's home directory rather than the dev
              // server's cwd — otherwise it auto-loads this repo's CLAUDE.md
              // and replies as if it were Claude OS's setup agent.
              const home = homedir();
              const cwd = home;

              // Three modes, mirroring the pane header. "ask" raises a card for
              // every tool; "acceptEdits" lets the CLI wave file edits through and
              // cards everything else; "yolo" is the old
              // --dangerously-skip-permissions behaviour with no cards at all.
              const toolMode: "ask" | "acceptEdits" | "yolo" =
                yolo || payload.toolMode === "yolo"
                  ? "yolo"
                  : payload.toolMode === "acceptEdits"
                    ? "acceptEdits"
                    : "ask";
              // Where the child should call US back for approvals. The Host
              // header is the port the browser actually reached us on, which is
              // the one truth that survives --port overrides and strictPort.
              const hostHeader = String(req.headers.host ?? "");
              const selfPort = hostHeader.includes(":")
                ? hostHeader.slice(hostHeader.lastIndexOf(":") + 1)
                : "80";
              // The pane owns approvals for as long as this turn runs. Re-registered
              // per turn so a resumed chat in a fresh tab still gets its cards.
              const approvalRegistration = { send: sendEvent, pending: new Set<string>() };
              approvalChats.set(chatId, approvalRegistration);
              const releaseApprovals = () => {
                // Anything still on screen when the turn dies would otherwise hold
                // its promise (and its 10-minute timer) forever.
                for (const id of [...approvalRegistration.pending])
                  settleApproval(
                    id,
                    { behavior: "deny", message: "The turn ended before this was approved." },
                    "abandoned",
                  );
                if (approvalChats.get(chatId) === approvalRegistration)
                  approvalChats.delete(chatId);
              };

              // Reasoning-effort dial → extended-thinking budget. The CLI has
              // no --effort flag; MAX_THINKING_TOKENS is its documented knob.
              // Hermes level names are accepted so one frontend dial drives
              // both backends ("minimal" = thinking off).
              const EFFORT_THINKING_TOKENS: Record<string, string> = {
                minimal: "0",
                low: "4000",
                medium: "10000",
                high: "20000",
                xhigh: "31999",
                max: "31999",
              };
              const effort =
                typeof payload.effort === "string" ? payload.effort.trim().toLowerCase() : "";

              // ccr routing needs the daemon on :3456 — make the OS "just work"
              // by starting it if it's down, so the user never touches a terminal.
              const ensureCcr = async (): Promise<boolean> => {
                const ccrUp = async () => {
                  try {
                    const c = new AbortController();
                    const t = setTimeout(() => c.abort(), 1500);
                    const r = await fetch("http://127.0.0.1:3456/", { signal: c.signal });
                    clearTimeout(t);
                    return r.status > 0;
                  } catch {
                    return false;
                  }
                };
                if (await ccrUp()) return true;
                sendEvent("info", "starting claude-code-router…");
                const ccrBin = resolveCliBin("ccr");
                if (ccrBin) {
                  try {
                    spawn(ccrBin, ["start"], { detached: true, stdio: "ignore" }).unref();
                  } catch {
                    /* fall through to the readiness poll / error */
                  }
                }
                for (let i = 0; i < 12; i++) {
                  await new Promise((r) => setTimeout(r, 500));
                  if (await ccrUp()) return true;
                }
                return false;
              };

              // One attempt = one child process. This is factored out because a
              // single turn can legitimately need more than one child: if the CLI
              // rejects our approval flags we re-run without them, and (see the
              // failover chain below) a model that dies mid-turn hands the same
              // turn to the next model rather than showing the user a dead end.
              // The shapes the harness uses when it's reporting its own failure
              // rather than relaying the model. Anchored at the start of a block
              // so a model *discussing* an API error isn't mistaken for one.
              const HARNESS_ERROR_TEXT =
                /^\s*(API Error\b|Error from provider|Error:\s|Credit balance|Invalid API key|OAuth|Failed to authenticate)/;

              // AttemptResult carries the failover fields AND the watchdog's
              // TurnOutcome fields, because both read the same attempt: failover
              // asks "is this lane dead?", the watchdog asks "did this turn
              // actually finish?". Extending one object keeps them from drifting
              // into two slightly different views of the same child process.
              interface AttemptResult extends TurnOutcome {
                /** The CLI refused one of our flags — the run never really started. */
                flagRejected: boolean;
              }
              /** Every attempt exit builds one of these, so a new field can never
                be silently omitted at one of the eight return sites. */
              const attemptResult = (r: Partial<AttemptResult>): AttemptResult => ({
                ...emptyOutcome(),
                flagRejected: false,
                ...r,
              });

              // liveChild is declared up with the cancel control, so a Stop that
              // lands before or between attempts still has something to signal.
              let turnFinished = false;
              // Session announcements and segment breaks are per-TURN, not
              // per-attempt: a failover keeps writing into the same chat bubble.
              let announcedSession = "";
              // This chat is now demonstrably alive. Registered BEFORE the first
              // spawn so the rail lights up during a slow cold start too, and
              // torn down in the same breath as the turn's done/error.
              const liveRun: LiveRun = {
                chatId,
                sessionId,
                model,
                startedAt: Date.now(),
                child: null,
                abortedByUser: false,
                buffer: [],
                bufferBytes: 0,
                subscribers: new Set(),
              };
              liveRuns.set(chatId, liveRun);
              // …and on disk, so a turn this server kills on its way out can still
              // be accounted for after the fact. Written BEFORE the first spawn:
              // a marker for a turn that never started is harmless (the next turn
              // clears it), a missing marker for a turn that did is the defect.
              markRunLive({ chatId, sessionId, model, startedAt: liveRun.startedAt });
              liveRunForCleanup = liveRun; // so finalizeTurn can retire it on a throw
              // Emitted here rather than at the top of the handler so it lands in
              // the replay buffer too — a tab that attaches later still sees it.
              if (priorEndedBy) {
                const restartNote = `⏹ the previous turn on this chat was ended by a dev-server restart at ${priorEndedBy} — it did not finish, and nothing it had not already written was kept. This turn starts from the saved transcript.`;
                // Twice on purpose, the same way recovery_exhausted is. `info` is
                // what a headless caller and the log see. `turn_note` is what the
                // pane pins into the thread as its own chip — as an `info` line
                // this landed in the activity strip, which is overwritten by the
                // next line of output and gone within a second. A turn that
                // vanished into a restart has to leave a trace the user can still
                // read a minute later, or it is indistinguishable from a hang all
                // over again.
                sendEvent("info", restartNote);
                sendEvent("turn_note", restartNote);
              }
              const announceSession = (sid: unknown) => {
                if (typeof sid !== "string" || !sid || sid === announcedSession) return;
                announcedSession = sid;
                liveRun.sessionId = sid;
                // Now the row can point at a transcript — until this lands a
                // headless chat is in the list but has nothing to open.
                // lastPrompt/title included because for a script-started chat this
                // is now the FIRST write — the pre-turn write is skipped for
                // callers with no identity of their own, so without these the
                // rail would show the row as "Untitled chat".
                recordChatTurn({
                  chatId,
                  sessionId: sid,
                  model,
                  origin: chatOrigin,
                  title:
                    typeof payload.title === "string" ? payload.title.slice(0, 120) : undefined,
                  lastPrompt: prompt.slice(0, 400),
                });
                sendEvent("info", `session_id: ${sid}`);
              };
              let lastAsstMsgId = "";
              /**
               * The prompt size of the LAST API call in this turn — which is what
               * "context used" actually means.
               *
               * The `result` line's `usage` is a TURN TOTAL, summed over every API
               * round-trip the turn made, and `cache_read_input_tokens` is re-counted
               * in full on each one. Measured 2026-07-26 on a 3-round haiku turn:
               * result.usage.cache_read = 45,245 while the single largest call read
               * 27,709 — already ~2× over. On a real agentic turn from this machine's
               * transcripts (258 assistant messages) the same sum came to 44,380,727
               * against a true final context of 247,973: a 179× over-read, which is
               * how the ctx pill could show "100% full" on a window that was a
               * quarter used, and how the breakdown's "System prompt + tools"
               * residual became tens of millions of invented tokens.
               *
               * Each `assistant` event carries the usage of the ONE call that
               * produced it, so the last one is the real occupancy — and it is the
               * only figure that falls back down after a mid-turn compaction.
               * Cost still comes from the result line, where a cumulative total is
               * exactly right.
               */
              let lastAsstPrompt: {
                inputTokens: number;
                cacheCreationTokens: number;
                cacheReadTokens: number;
                outputTokens: number;
              } | null = null;
              /** Everything the CLI reported spending on this turn, across every
                attempt. The auto-continue spend cap is measured against the
                slice the resumes added. */
              let turnCostUsd = 0;
              /** The same ledger in the only unit the Codex lane reports. Codex's
                JSONL carries no USD field anywhere, so turnCostUsd stays 0
                there and the $2 threshold is structurally unable to fire — a
                cap that cannot fire is not a cap. Fed ONLY by lanes that report
                no money: the Claude lane's `result` usage is a turn TOTAL that
                re-counts the whole cached prompt on every round-trip (measured
                at 179× on a long turn), so mixing it in would trip a token
                ceiling on perfectly normal recoveries. */
              let turnTokens = 0;

              // ── "Saved to your Desktop as Kola Deck.html" ──────────────────
              // A turn said that on 26 Jul. It was TRUE — and nothing checked.
              // The same sentence from a turn whose write had failed, or which
              // wrote somewhere else entirely, would have looked identical, and
              // the only way to find out was to go and look. A claim about the
              // filesystem is the one kind of claim this server can actually
              // verify, so it does: every path the turn names is stat'd at the
              // end and only the ones that exist are surfaced, with their real
              // size, as a link.
              const claimedPaths = new Set<string>();
              const homePrefix = `${homedir()}${sep}`;
              /** Record a path a turn claims it wrote. Normalised, bounded, and
                confined to the user's home — a link to /etc/passwd is not a
                deliverable. */
              const notePathClaim = (raw: unknown): void => {
                if (typeof raw !== "string") return;
                let p = raw.trim().replace(/^["'`]|["'`,.;:]$/g, "");
                if (!p) return;
                if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
                if (!p.startsWith(homePrefix)) return; // absolute, under $HOME, only
                if (p.length > 512) return;
                if (claimedPaths.size >= 200) return; // a turn cannot flood this
                claimedPaths.add(p);
              };
              /** Absolute or ~-relative paths WITH a file extension, as they
                appear in prose. Deliberately narrow: a bare filename ("Kola
                Deck.html") names no directory, so there is nothing to verify —
                the tool_use hook below is what catches those. Spaces are
                allowed because macOS filenames are full of them, which is also
                why the link this produces must be URL-encoded. */
              const PROSE_PATH_RE =
                /(?:~|\/Users\/[A-Za-z0-9._-]+)\/[^\s"'`<>|]*[^\s"'`<>|,.;:)\]}]/g;
              const scanTextForPaths = (text: string): void => {
                if (!text || !text.includes("/")) return;
                for (const m of text.slice(0, 20_000).match(PROSE_PATH_RE) ?? []) {
                  if (/\.[A-Za-z0-9]{1,8}$/.test(m)) notePathClaim(m);
                }
              };
              /** A resumed attempt is a NEW child, so its first assistant message
                carries a new id and would fire a segment break — which banks
                the half-finished answer into the trace and starts the bubble
                over. That is precisely the "it restarted" experience recovery
                is supposed to remove, so the first break after a resume is
                swallowed and the continuation lands in the same paragraph. */
              let suppressNextSegBreak = false;
              const emitSegBreak = () => {
                if (suppressNextSegBreak) {
                  suppressNextSegBreak = false;
                  return;
                }
                sendEvent("seg", "break");
              };

              // Mid-run browser disconnect (pane refresh, HMR, tab close): DETACH
              // instead of kill. The run finishes headless — the transcript
              // persists on disk and the chat resumes from the rail. The idle
              // watchdog stays armed as the only backstop against a wedged child.
              req.on("close", () => {
                clearInterval(heartbeat);
                if (turnFinished) {
                  killTree(liveChild);
                  return;
                }
                detached = true;
              });

              const runAttempt = async (a: {
                model: string;
                sessionId: string;
                promptText: string;
                approvals: boolean;
              }): Promise<AttemptResult> => {
                // ── The single spawn boundary ─────────────────────────────
                // Every child this turn will ever create comes through here: the
                // first attempt, the fresh-session retry, the dropped-flag retry,
                // every failover hop, every auto-continue resume. That makes this
                // the ONLY place a bound applies to all of them, and it is why
                // the bound moved here.
                //
                // Before, the ledger was consulted at the auto-continue decision
                // point, which failover hops never pass through — a turn could
                // hop three models, each hop spawning its own child, entirely
                // outside the count. And the turn's 4h ceiling was a timer, which
                // is fine until nothing is left to cancel.
                //
                // What is honestly enforceable here, and what is not:
                //   • ABORT and COUNT are hard. Nothing spawns after Stop, and
                //     the number of children is known before each one starts.
                //   • the DEADLINE is hard at this boundary — a turn past its
                //     ceiling starts nothing new. A child already running is the
                //     turnDeadline timer's job, not this one's.
                //   • SPEND is not, and no wording here will make it so. A child
                //     can only be priced after it has finished, so a threshold
                //     read here stops the NEXT child and never the current one.
                //     It is called a threshold everywhere for that reason, and
                //     the measured overshoot ($3.00 against $2.00) is stated
                //     rather than papered over. See turn-watchdog.ts.
                if (cancelled || liveRun.abortedByUser)
                  return attemptResult({
                    ok: true,
                    errorText: "",
                    reachedResult: true, // Stop means stop — never "unfinished".
                  });
                if (Date.now() - turnStartedAt >= TURN_MAX_MS)
                  return attemptResult({
                    ok: false,
                    errorText: `This turn passed its ${Math.round(
                      TURN_MAX_MS / 3_600_000,
                    )}-hour ceiling, so nothing further was started. Everything above is kept — send again to carry on.`,
                    reachedResult: true,
                    interrupted: true,
                    interruptedBy: "the turn's own time ceiling",
                  });
                if (childrenSpawned >= MAX_CHILDREN_PER_TURN)
                  return attemptResult({
                    ok: false,
                    errorText: `This turn has already started ${childrenSpawned} agent processes (ceiling ${MAX_CHILDREN_PER_TURN}) across its retries, failovers and resumes, so it stopped rather than starting another. Everything above is kept — send again to carry on.`,
                    reachedResult: true,
                    interrupted: true,
                    interruptedBy: "the turn's own process ceiling",
                  });
                childrenSpawned += 1;
                // Lane is a property of the MODEL AND ITS PROVIDER, so it's
                // re-derived per attempt: a failover from moonshotai/kimi-k3 to
                // claude-opus-5 changes lane mid-turn, and everything downstream
                // has to follow. laneOf() applies the request's provider to the
                // requested model only — a hop target gets read from its own id.
                const aLane = laneOf(a.model);
                const aViaCodex = aLane === "codex";
                const aViaCcr = aLane === "ccr";
                const aBin = aViaCodex ? resolveCliBin("codex") : resolveCliBin("claude");
                if (!aBin)
                  return attemptResult({
                    ok: false,
                    errorText: aViaCodex
                      ? "Codex CLI not found — install it (npm i -g @openai/codex) and sign in with `codex login`."
                      : "Claude Code binary not found on PATH.",
                  });

                let args: string[];
                if (aViaCodex) {
                  // Codex CLI headless: `codex exec --json` emits JSONL events;
                  // `exec resume <id>` continues a session. Default sandbox is
                  // read-only (can inspect files); full tools → --full-auto.
                  args = a.sessionId ? ["exec", "resume", a.sessionId] : ["exec"];
                  // Home isn't a git repo — codex refuses "untrusted" dirs
                  // without this flag when run headless.
                  args.push("--json", "--skip-git-repo-check", "-m", a.model);
                  // Effort dial → Codex reasoning effort (gpt-5.6 supports xhigh;
                  // "minimal" maps to low — Codex has no thinking-off).
                  if (effort && ["low", "medium", "high", "xhigh", "minimal"].includes(effort)) {
                    args.push(
                      "-c",
                      `model_reasoning_effort="${effort === "minimal" ? "low" : effort}"`,
                    );
                  }
                  if (toolMode === "yolo") args.push("--full-auto");
                  args.push(a.promptText);
                } else {
                  args = ["-p", a.promptText, "--output-format", "stream-json", "--verbose"];
                  // Attachments land in the Hermes upload cache — grant the CLI
                  // read access there so [Image:]/[File:] paths actually open.
                  args.push("--add-dir", join(homedir(), ".hermes", "image_cache"));
                  // Plan mode is orthogonal to the approval stance and still
                  // rides the composer's own chip.
                  const pMode =
                    typeof payload.permissionMode === "string" ? payload.permissionMode : "";
                  if (pMode === "plan") args.push("--permission-mode", "plan");
                  else if (toolMode === "acceptEdits")
                    args.push("--permission-mode", "acceptEdits");
                  // For ccr the model is driven by ANTHROPIC_MODEL below (matching
                  // the proven `kimi` alias), so don't pass the Anthropic --model flag.
                  if (a.model && !aViaCcr) args.push("--model", a.model);
                  // Only resume from something Claude Code will actually accept.
                  // `--resume` with a non-UUID fails the turn outright:
                  //   "--resume requires a valid session ID … "wedge-51898" is not
                  //    a UUID and does not match any session title"
                  // The server's own validator allows any [A-Za-z0-9_-]{1,128},
                  // so a caller that uses its chatId as a sessionId — which the
                  // supervisor script does — could hand over an id that breaks
                  // EVERY turn on that chat, permanently, with no way back.
                  // A malformed id means "no prior session", not "fail forever".
                  const UUIDish = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                  if (a.sessionId && UUIDish.test(a.sessionId)) args.push("--resume", a.sessionId);
                  else if (a.sessionId)
                    sendEvent(
                      "info",
                      `ℹ "${a.sessionId}" isn't a Claude Code session id, so this turn starts a fresh session on this chat rather than failing.`,
                    );
                  if (toolMode === "yolo") args.push("--dangerously-skip-permissions");
                  else if (a.approvals) {
                    // The real thing: every tool call the CLI wants to make comes
                    // back to /__mcp_approvals as a permission_prompt call, which
                    // becomes a card in the chat.
                    args.push("--permission-prompt-tool", "mcp__approvals__permission_prompt");
                    // The one exception to "no allow-list": our own question
                    // tool. Raising an approval card to ask permission to ask the
                    // operator a question is absurd, and it can't do anything but
                    // put a card on their screen.
                    args.push("--allowedTools", "mcp__approvals__ask_user_question");
                  }
                  if (toolMode === "yolo" || a.approvals) {
                    // Attached in yolo too: nothing is asked there, but the agent
                    // must still be able to ASK — an unattended run that can raise
                    // a question is the whole point.
                    args.push(
                      "--mcp-config",
                      JSON.stringify({
                        mcpServers: {
                          approvals: {
                            type: "http",
                            url: `http://127.0.0.1:${selfPort}/__mcp_approvals`,
                            headers: {
                              "x-claude-os-token": REFRESH_TOKEN,
                              "x-claude-os-chat": chatId,
                            },
                          },
                        },
                      }),
                    );
                  }
                  if (toolMode !== "yolo" && !a.approvals) {
                    // Approvals unavailable (old CLI, or the flags were rejected).
                    // Headless runs can't prompt for tool approval, so without a
                    // grant every file tool is silently declined and the model
                    // says "I can't see your files". Default to safe READ access
                    // (list/read/search — no writes, no arbitrary bash).
                    args.push("--allowedTools", "Read", "Glob", "Grep", "Bash(ls:*)");
                  }
                }

                // Env hygiene (same spirit as the hermes endpoint stripping
                // PYTHONPATH): if the dev server was itself launched from a
                // Claude Code / Desktop session, inherited markers like
                // CLAUDECODE / CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH make the child
                // CLI behave as a nested SDK subprocess instead of a fresh
                // user-credentialed run. Strip them so the child authenticates
                // exactly like `claude` typed in the user's own terminal.
                const claudeEnv = { ...process.env };
                for (const k of Object.keys(claudeEnv)) {
                  if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK)/.test(k)) delete claudeEnv[k];
                }
                if (effort && EFFORT_THINKING_TOKENS[effort]) {
                  claudeEnv.MAX_THINKING_TOKENS = EFFORT_THINKING_TOKENS[effort];
                }
                // Route the Claude Code harness through claude-code-router →
                // OpenRouter. Mirrors the user's `kimi` alias exactly: base URL to
                // the ccr daemon, a placeholder key (ccr ignores it but the CLI
                // requires a value), the "openrouter,<model>" selector, and a
                // compact window under OpenRouter models' 1M ceiling. Set AFTER
                // the CLAUDE_CODE_* strip loop so the window survives.
                if (aViaCcr) {
                  claudeEnv.ANTHROPIC_BASE_URL = "http://127.0.0.1:3456";
                  claudeEnv.ANTHROPIC_API_KEY = "ccr-router";
                  claudeEnv.ANTHROPIC_MODEL = `openrouter,${a.model}`;
                  // Auto-compact at ~72% of the SELECTED model's real context
                  // window (sent by the client from OpenRouter's catalog) — a
                  // fixed 900k would never fire on a 256k model. 72% (not 85%)
                  // because compaction only runs BETWEEN turns: one turn that
                  // reads a few multi-MB images can add ~300k tokens atomically,
                  // and it must still land under the provider's hard cap or the
                  // session deadlocks (compaction itself then exceeds the cap —
                  // the amber/Kimi failure of 2026-07-24).
                  const cw = Number(payload.ctxWindow);
                  claudeEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW =
                    Number.isFinite(cw) && cw >= 60_000 && cw <= 2_100_000
                      ? String(Math.round(cw * 0.72))
                      : "750000";
                  if (!(await ensureCcr()))
                    return attemptResult({
                      ok: false,
                      errorText:
                        "claude-code-router isn't running and couldn't be started automatically. Run `ccr start` in a terminal, then try again.",
                      stderr: "ECONNREFUSED 127.0.0.1:3456",
                    });
                }

                // Last gate before anything is launched. A cancel that lands in
                // the window between taking the turn lock and spawning — binary
                // resolution, cwd setup, the router preflight, a failover hop —
                // would otherwise start the process it was meant to prevent, and
                // the user would watch a brand-new agent begin work immediately
                // after pressing Stop. Checked HERE because this is the single
                // place every attempt funnels through.
                if (cancelled)
                  // `reachedResult: true` is not a claim that the CLI finished —
                  // it is how a cancel tells the watchdog "there is nothing here
                  // to continue". A cancelled turn must never look unfinished,
                  // or Stop would be answered by an automatic resume.
                  return attemptResult({ ok: true, reachedResult: true });

                return await new Promise<AttemptResult>((resolve) => {
                  // stdin: "ignore" — with the default pipe left open, `claude -p`
                  // waits 3s for piped stdin before starting (user-visible lag +
                  // a warning line in every chat).
                  const child = spawn(aBin, args, {
                    cwd,
                    env: claudeEnv,
                    stdio: ["ignore", "pipe", "pipe"],
                    // Own process group, so a cancel can signal the whole tree by
                    // negative pid. Without this, killing `claude` left its bash /
                    // python / ffmpeg descendants running — a stopped turn that
                    // kept writing files and spending credits. NOT unref()'d: the
                    // server still owns this child and reaps it normally.
                    detached: true,
                  });
                  liveChild = child;
                  liveRun.child = child;
                  liveRun.model = a.model;

                  // Same two-stage watchdog as /__hermes_chat: generous before any
                  // output (model load / auth can be slow) and mid-run (agentic
                  // turns legitimately go quiet while tools execute), strict once
                  // the final `result` object marks the run finished — after that
                  // the process should exit immediately, so lingering means hang.
                  const FIRST_OUTPUT_TIMEOUT_MS = 300_000;
                  // 60 min, not 10: long Higgsfield/build phases inside sub-agents
                  // are legitimately silent for 20-40 minutes — the old 10-minute
                  // idle killer is what murdered the amber asset agent mid-run.
                  const MID_RUN_IDLE_MS = 3_600_000;
                  const POST_OUTPUT_IDLE_MS = 8_000; // strict once the run is over
                  // Absolute backstop so a detached/hung run can never live forever.
                  const ABSOLUTE_MAX_MS = 3 * 3_600_000;
                  let watchdog: NodeJS.Timeout | null = null;
                  let receivedAnyOutput = false;
                  let sawAssistantText = false;
                  // Claude Code reports provider and transport failures INSIDE the
                  // assistant stream ("API Error: 400 …" followed by a JS stack),
                  // not on stderr. Measured the hard way: a bogus ccr model came
                  // back as a perfectly ordinary assistant message, which made the
                  // turn look answered and suppressed failover entirely. So text
                  // that looks like the harness apologising is routed to the error
                  // corpus and does NOT count as the model having replied.
                  let inHarnessError = false;
                  let runFinished = false;
                  let watchdogFired = false;
                  /** Tokens this attempt reported. The Codex lane prints token
                    counts and no money at all, so this is the only measured
                    number available to bound recovery there. */
                  let attemptTokens = 0;
                  let stderrText = "";
                  let settled = false;
                  // ── What the auto-continue watchdog reads ─────────────────
                  // Whether the turn FINISHED is a different question from
                  // whether it errored, and nothing here used to answer it:
                  // `runFinished` was a watchdog-timing detail. It is now also
                  // the honest answer to "did the CLI reach its own end?", which
                  // is what separates a killed child from a completed turn.
                  let sawHarnessError = false;
                  let resultIsError = false;
                  let sawInit = false;
                  let toolCalls = 0;
                  let textChars = 0;
                  let thinkChars = 0;
                  let lastFailedTool = "";
                  let flatlined = false;
                  /** tool_use id → "Bash: npm run dev", so a tool_result that
                    comes back is_error can name the call that failed. Without
                    the map a repeating failure is invisible — the error block
                    carries an id and nothing else. */
                  const toolSigById = new Map<string, string>();
                  let lastByteAt = Date.now();
                  const setIdle = (ms: number) => {
                    if (watchdog) clearTimeout(watchdog);
                    watchdog = setTimeout(() => {
                      watchdogFired = true;
                      killTree(child);
                    }, ms);
                  };
                  setIdle(FIRST_OUTPUT_TIMEOUT_MS);
                  // Hard ceiling — a detached or wedged run can never outlive this.
                  const absoluteCap = setTimeout(() => {
                    watchdogFired = true;
                    killTree(child);
                  }, ABSOLUTE_MAX_MS);
                  // A pending approval card is the user thinking, not the model
                  // hanging — hold the watchdog off while one is on screen.
                  const approvalHold = setInterval(() => {
                    if (approvalRegistration.pending.size > 0 && !runFinished)
                      setIdle(MID_RUN_IDLE_MS);
                  }, 30_000);

                  // Noise we cause ourselves, and only ever on a ccr-routed turn.
                  // Routing through claude-code-router REQUIRES setting
                  // ANTHROPIC_API_KEY, and the CLI then warns that the key takes
                  // precedence over the claude.ai login and disables org
                  // connectors. Both halves are true and neither is actionable:
                  // the user picked a non-Anthropic model, so the claude.ai
                  // connectors were never going to be used. Left alone it prints
                  // a warning triangle above every single Kimi/GLM/Grok turn.
                  // Suppressed ONLY when we set the key — a warning from a run we
                  // did not configure is real and must still surface.
                  const isSelfInflictedAuthWarning = (s: string) =>
                    aViaCcr &&
                    /claude\.ai connectors are disabled/i.test(s) &&
                    /ANTHROPIC_API_KEY/.test(s);

                  // Each stdout line is a JSON object. Map them onto the hermes
                  // SSE vocabulary: assistant text → chunk, tool_use → a short
                  // "Using tool: X" info line, result → "session_id: <id>" (the
                  // exact marker the chat components already regex out of info
                  // events) plus cost, then the close handler sends done.
                  const handleLine = (line: string) => {
                    if (!line.trim()) return;
                    let obj: any;
                    try {
                      obj = JSON.parse(line);
                    } catch {
                      // Not JSON (startup warnings etc.) — surface dimly, never
                      // in the reply bubble.
                      if (!isSelfInflictedAuthWarning(line)) sendEvent("info", line);
                      return;
                    }
                    if (aViaCodex) {
                      // Codex `exec --json` vocabulary → same SSE protocol.
                      const t = String(obj?.type ?? "");
                      const codexThread = obj.thread_id ?? obj.session_id ?? obj?.thread?.id;
                      if (typeof codexThread === "string" && codexThread) sawInit = true;
                      announceSession(codexThread);
                      if (
                        t === "item.completed" &&
                        obj?.item?.type === "agent_message" &&
                        obj.item.text
                      ) {
                        emitSegBreak();
                        sawAssistantText = true;
                        textChars += String(obj.item.text).length;
                        scanTextForPaths(String(obj.item.text));
                        sendEvent("chunk", obj.item.text);
                      } else if (t === "item.completed" && obj?.item?.type === "file_change") {
                        // Codex reports edits as a file_change item. The exact
                        // shape of `changes` is version-dependent, so take any
                        // string that looks like a path rather than betting on a
                        // key name — the end-of-turn stat is what makes a wrong
                        // guess harmless.
                        for (const c of Array.isArray(obj.item.changes) ? obj.item.changes : [])
                          for (const v of Object.values(c ?? {})) notePathClaim(v);
                      } else if (
                        t === "item.completed" &&
                        obj?.item?.type === "reasoning" &&
                        obj.item.text
                      ) {
                        thinkChars += String(obj.item.text).length;
                        sendEvent("think", obj.item.text);
                      } else if (t === "item.started" && obj?.item?.type === "command_execution") {
                        const cmd = String(obj.item.command ?? "command").slice(0, 160);
                        toolCalls += 1;
                        // Structured twin of the display line — the live status
                        // strip reads THIS, so it never has to regex a label
                        // back apart to learn which tool is running.
                        sendEvent("tool", JSON.stringify({ name: "Bash", target: cmd }));
                        sendEvent("info", `Running: ${cmd.slice(0, 120)}`);
                      } else if (t === "turn.completed") {
                        // The SUCCESS terminal of the codex JSONL stream. Reaching
                        // it means the turn ended on its own terms, so any earlier
                        // top-level `error` line was a RETRIED, non-fatal blip —
                        // codex emits those and keeps streaming, and the JSONL
                        // shape drops the `will_retry` flag that would say so.
                        // Leaving the error flag set made a turn that SUCCEEDED
                        // report `resultIsError`, which the watchdog reads as
                        // "the harness ended the turn with an error" and pays for
                        // resumes of an already-finished turn. Success clears it.
                        runFinished = true;
                        resultIsError = false;
                        const u = obj?.usage;
                        if (u?.input_tokens != null)
                          sendEvent(
                            "info",
                            `tokens: ${u.input_tokens} in / ${u.output_tokens ?? 0} out`,
                          );
                        // ── Context occupancy on the Codex lane ───────────────
                        // This branch used to print a token line and stop, so the
                        // ctx pill on a Codex chat was pure client-side estimate —
                        // chars ÷ 4 — while the CLI was reporting the real prompt
                        // size in the very same event. "The context window must be
                        // accurate on every lane" is the one thing that has to
                        // work regardless of who is paying, so forward it.
                        //
                        // Codex Usage (verified against the 0.144.1 binary's own
                        // serde field list): input_tokens, cached_input_tokens,
                        // output_tokens, reasoning_output_tokens, total_tokens.
                        // `input_tokens` EXCLUDES the cached part, so occupancy is
                        // input + cached — mapped onto cacheReadTokens, which is
                        // exactly what usagePromptTokens() already sums.
                        const cIn = Number(u?.input_tokens ?? 0);
                        const cCached = Number(u?.cached_input_tokens ?? 0);
                        const cOut = Number(u?.output_tokens ?? 0);
                        attemptTokens += cIn + cCached + cOut;
                        turnTokens += cIn + cCached + cOut;
                        const codexMeasured = cIn + cCached > 0;
                        sendEvent(
                          "ctx_usage",
                          JSON.stringify({
                            inputTokens: cIn,
                            cacheCreationTokens: 0,
                            cacheReadTokens: cCached,
                            outputTokens: cOut,
                            // Same rule as the Claude lane: an all-zero payload is
                            // "we were told nothing", never a measured zero.
                            reported: codexMeasured,
                            lane: "codex",
                          }),
                        );
                        // Codex bills the user's ChatGPT plan, not a per-turn
                        // meter, and there is no USD field anywhere in its stream.
                        // Saying "$0.0000" here would be inventing a measurement;
                        // saying nothing leaves the last lane's figure on screen.
                        sendEvent("cost_unreported", "codex");
                      } else if (t === "turn.failed") {
                        // The FAILURE terminal, and *terminal* is the point: the
                        // turn reached its own end rather than being cut off
                        // mid-flight. `turn.failed` carries an `error` object, so
                        // without this branch it fell through to the generic
                        // handler below, which set the error flag but never
                        // `runFinished`. A definitively failed turn was therefore
                        // classified "the agent process exited before the turn
                        // finished" and resumed on the user's money. This is the
                        // exact twin of the Claude lane's `result` line with
                        // is_error: ended, and ended badly.
                        runFinished = true;
                        resultIsError = true;
                        const msg = String(obj?.error?.message ?? "the codex turn failed");
                        stderrText += `${msg}\n`;
                        sendEvent("info", msg);
                      } else if (t === "error" || obj?.error) {
                        const msg = String(obj?.message ?? obj?.error?.message ?? "codex error");
                        stderrText += `${msg}\n`;
                        resultIsError = true;
                        // Codex reports a refused/failed command as an error item
                        // and then keeps going. The turn that died today looped on
                        // exactly this, so the failing command is the signature
                        // loop detection needs.
                        lastFailedTool = `codex: ${msg.replace(/\s+/g, " ").slice(0, 80)}`;
                        sendEvent("info", msg);
                      }
                      return;
                    }
                    if (obj?.type === "system" && obj?.subtype === "compact_boundary") {
                      sendEvent(
                        "info",
                        "⚡ context compacted — conversation summarized, session continues",
                      );
                    } else if (obj?.type === "system" && obj?.subtype === "init") {
                      // Proof that a session now exists on disk — the watchdog's
                      // "is there anything here to resume?" gate.
                      sawInit = true;
                      announceSession(obj.session_id);
                      // What the harness says it is ACTUALLY using. After the ccr
                      // incident this is never assumed from the picker again.
                      // ccr reports "openrouter,vendor/model"; the lane prefix is
                      // plumbing, the tail is the answer to "who wrote this".
                      if (typeof obj.model === "string" && obj.model)
                        sendEvent("model_used", routeModel(obj.model));
                      // Everything the harness loaded into the window before the
                      // first token: tool names, MCP servers, slash commands,
                      // skills, subagents, plus the real on-disk size of the
                      // memory/skill/agent text. The pane turns this into the
                      // context breakdown behind the ctx pill.
                      try {
                        sendEvent("ctx_manifest", JSON.stringify(buildCtxManifest(obj, cwd)));
                      } catch {
                        /* a missing breakdown must never break the turn */
                      }
                    } else if (obj?.type === "assistant") {
                      const msgId = String(obj?.message?.id ?? "");
                      if (msgId && msgId !== lastAsstMsgId) {
                        lastAsstMsgId = msgId;
                        emitSegBreak();
                      }
                      // Per-CALL prompt size — see lastAsstPrompt. Overwritten, not
                      // added: occupancy is what the newest call carried, and after
                      // a compaction that number goes DOWN.
                      {
                        const au = obj?.message?.usage;
                        const inTok = Number(au?.input_tokens ?? 0);
                        const ccTok = Number(au?.cache_creation_input_tokens ?? 0);
                        const crTok = Number(au?.cache_read_input_tokens ?? 0);
                        if (inTok + ccTok + crTok > 0)
                          lastAsstPrompt = {
                            inputTokens: inTok,
                            cacheCreationTokens: ccTok,
                            cacheReadTokens: crTok,
                            outputTokens: Number(au?.output_tokens ?? 0),
                          };
                      }
                      for (const block of Array.isArray(obj?.message?.content)
                        ? obj.message.content
                        : []) {
                        if (block?.type === "text" && block.text) {
                          if (
                            HARNESS_ERROR_TEXT.test(block.text) ||
                            // The stack frames that follow the first line belong
                            // to the same failure, not to a reply.
                            (inHarnessError && /^\s*(at\s|\{|Error\b)/.test(block.text))
                          ) {
                            inHarnessError = true;
                            sawHarnessError = true;
                            stderrText = `${stderrText}${block.text}\n`.slice(-8_000);
                          } else {
                            inHarnessError = false;
                            sawAssistantText = true;
                            textChars += String(block.text).length;
                            scanTextForPaths(String(block.text));
                          }
                          sendEvent("chunk", block.text);
                        } else if (
                          block?.type === "thinking" &&
                          typeof block.thinking === "string" &&
                          block.thinking
                        ) {
                          // Extended-thinking blocks → their own event so the UI can
                          // show the model working without polluting the reply.
                          thinkChars += block.thinking.length;
                          sendEvent("think", block.thinking);
                        } else if (block?.type === "tool_use") {
                          // Show WHAT the tool touched, like Claude Code's own UI:
                          // "Read src/app.ts", "Bash: git status", "Grep: TODO".
                          const inp = block.input ?? {};
                          // The authoritative source of "the turn wrote here":
                          // the harness's own argument to a write tool, not the
                          // model's prose about it. Read tools go through the
                          // same field, which is harmless — the end-of-turn stat
                          // only reports what exists, and a file the turn merely
                          // read is still a file it can honestly link.
                          if (
                            /^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(String(block.name ?? ""))
                          )
                            notePathClaim(inp.file_path ?? inp.path ?? inp.notebook_path);
                          const hint =
                            inp.file_path ??
                            inp.path ??
                            inp.command ??
                            inp.pattern ??
                            inp.query ??
                            inp.url ??
                            inp.prompt ??
                            "";
                          const short = String(hint).replace(/\s+/g, " ").slice(0, 90);
                          toolCalls += 1;
                          const sig = `${String(block.name ?? "tool")}${short ? `: ${short}` : ""}`;
                          if (block.id) {
                            toolSigById.set(String(block.id), sig);
                            // A long turn must not accumulate every tool id it
                            // ever issued — only the recent ones can still have a
                            // result coming back.
                            if (toolSigById.size > 64)
                              toolSigById.delete(toolSigById.keys().next().value as string);
                          }
                          // Structured FIRST, display line second. The live
                          // status strip needs the tool's name and target as
                          // fields; making it re-parse "⚙ Bash: …" back apart
                          // would break the moment a target contains a colon.
                          sendEvent(
                            "tool",
                            JSON.stringify({ name: String(block.name ?? "tool"), target: short }),
                          );
                          sendEvent(
                            "info",
                            `⚙ ${block.name ?? "tool"}${short ? `: ${short}` : ""}`,
                          );
                        }
                      }
                    } else if (obj?.type === "user") {
                      // Tool denials (read-only mode / permission gates) — surface
                      // as a lock chip instead of leaving the model to explain.
                      for (const block of Array.isArray(obj?.message?.content)
                        ? obj.message.content
                        : []) {
                        if (block?.type === "tool_result" && block?.is_error) {
                          const txt = JSON.stringify(block.content ?? "");
                          // Name the call that failed, so "the identical failing
                          // tool call repeating" is something the watchdog can
                          // actually see rather than infer.
                          lastFailedTool =
                            toolSigById.get(String(block.tool_use_id ?? "")) ??
                            txt.replace(/\s+/g, " ").slice(0, 80);
                          if (/permission|approv|not allowed|denied|granted/i.test(txt))
                            sendEvent(
                              "info",
                              toolMode === "ask" || toolMode === "acceptEdits"
                                ? "🔒 a tool call was declined"
                                : "🔒 a tool call was blocked by permission mode — flip READ to full access (or set Bypass) to allow it",
                            );
                        }
                      }
                    } else if (obj?.type === "result") {
                      runFinished = true;
                      announceSession(obj.session_id);
                      // The ONE non-estimated number in the context breakdown:
                      // what the API actually charged as prompt on this turn
                      // (fresh + cache-write + cache-read). The pane reconciles
                      // its estimate against it.
                      //
                      // A CONFIDENT ZERO IS WORSE THAN A BLANK. When the last
                      // provider call of a turn fails — which on the ccr →
                      // OpenRouter lane is how a long agentic run usually ends
                      // (context overflow, a 4xx from the provider) — the CLI
                      // still prints a `result` line, but with `is_error: true`,
                      // `usage` zeroed field-by-field, `modelUsage: {}` and
                      // `total_cost_usd: 0`. Forwarding that verbatim overwrote
                      // the real numbers from a 12-minute turn with
                      // "0 tok · 0% · $0.0000", which reads as measured. Verified
                      // 2026-07-26 by pointing ANTHROPIC_MODEL at a bad
                      // OpenRouter id: usage came back all-zero with a 400 in
                      // `result`. So: take the direct usage when it has anything
                      // in it, else re-derive from modelUsage (camelCase, keyed
                      // by billing model), else say plainly that this lane
                      // reported nothing.
                      // NOT `… : "anthropic"`. That fallback claimed Anthropic was
                      // paying for every lane this code didn't recognise, and the
                      // pane drew Claude Max plan bars underneath the claim. An
                      // unrecognised lane now reports "other" and names no payer.
                      const lane = usageLaneLabel(aLane);
                      const u = obj?.usage;
                      const direct = {
                        inputTokens: Number(u?.input_tokens ?? 0),
                        cacheCreationTokens: Number(u?.cache_creation_input_tokens ?? 0),
                        cacheReadTokens: Number(u?.cache_read_input_tokens ?? 0),
                        outputTokens: Number(u?.output_tokens ?? 0),
                      };
                      const perModel: any[] = Object.values(obj?.modelUsage ?? {});
                      const rolled = perModel.reduce(
                        (a, m) => ({
                          inputTokens: a.inputTokens + Number(m?.inputTokens ?? 0),
                          cacheCreationTokens:
                            a.cacheCreationTokens + Number(m?.cacheCreationInputTokens ?? 0),
                          cacheReadTokens: a.cacheReadTokens + Number(m?.cacheReadInputTokens ?? 0),
                          outputTokens: a.outputTokens + Number(m?.outputTokens ?? 0),
                        }),
                        {
                          inputTokens: 0,
                          cacheCreationTokens: 0,
                          cacheReadTokens: 0,
                          outputTokens: 0,
                        },
                      );
                      const promptOf = (x: typeof direct) =>
                        x.inputTokens + x.cacheCreationTokens + x.cacheReadTokens;
                      // Per-call first. `direct`/`rolled` are turn TOTALS (see
                      // lastAsstPrompt) and only equal the occupancy on a
                      // single-round-trip turn; they stay as the fallback for
                      // lanes that emit no per-message usage at all (codex).
                      const measured =
                        lastAsstPrompt ??
                        (promptOf(direct) > 0 ? direct : promptOf(rolled) > 0 ? rolled : null);
                      sendEvent(
                        "ctx_usage",
                        JSON.stringify(
                          measured
                            ? { ...measured, reported: true, lane }
                            : {
                                inputTokens: 0,
                                cacheCreationTokens: 0,
                                cacheReadTokens: 0,
                                outputTokens: 0,
                                reported: false,
                                lane,
                              },
                        ),
                      );
                      // Same rule for money: a real figure, or an explicit
                      // "nothing came back", never a fabricated $0.0000.
                      const perModelCost = perModel.reduce(
                        (a, m) => a + Number(m?.costUSD ?? 0),
                        0,
                      );
                      const cost =
                        typeof obj.total_cost_usd === "number" && obj.total_cost_usd > 0
                          ? obj.total_cost_usd
                          : perModelCost > 0
                            ? perModelCost
                            : null;
                      if (cost != null) {
                        sendEvent("info", `cost_usd: ${cost.toFixed(4)}`);
                        // Turn-level running total — the auto-continue spend cap
                        // is measured against what the RESUMES added to this, so
                        // recovery can never quietly outspend the turn itself.
                        turnCostUsd += cost;
                      } else sendEvent("cost_unreported", lane);
                      // modelUsage is keyed by the model ids that actually billed
                      // this turn — the last word on who answered.
                      for (const used of Object.keys(obj?.modelUsage ?? {}))
                        sendEvent("model_used", routeModel(used));
                      // A `result` with is_error and no assistant text is the
                      // harness telling us the turn died (auth, credits, provider).
                      if (obj?.is_error) {
                        resultIsError = true;
                        if (typeof obj.result === "string") stderrText += `${obj.result}\n`;
                      }
                    }
                  };
                  let stdoutBuf = "";
                  child.stdout.on("data", (buf: Buffer) => {
                    receivedAnyOutput = true;
                    lastByteAt = Date.now();
                    stdoutBuf += buf.toString("utf-8");
                    // stream-json is newline-delimited; hold the trailing partial
                    // line until its newline arrives.
                    const lines = stdoutBuf.split("\n");
                    stdoutBuf = lines.pop() ?? "";
                    for (const line of lines) handleLine(line);
                    setIdle(runFinished ? POST_OUTPUT_IDLE_MS : MID_RUN_IDLE_MS);
                  });
                  child.stderr.on("data", (buf: Buffer) => {
                    // Keep the user's chat bubble clean by routing stderr to an
                    // "info" event the client can choose to display dimly.
                    receivedAnyOutput = true;
                    lastByteAt = Date.now();
                    const text = buf.toString("utf-8");
                    stderrText = (stderrText + text).slice(-8_000);
                    if (!isSelfInflictedAuthWarning(text)) sendEvent("info", text);
                    setIdle(runFinished ? POST_OUTPUT_IDLE_MS : MID_RUN_IDLE_MS);
                  });
                  const finish = (r: Partial<AttemptResult>) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(absoluteCap);
                    clearInterval(approvalHold);
                    clearInterval(liveness);
                    if (watchdog) clearTimeout(watchdog);
                    if (liveChild === child) liveChild = null;
                    // Filled in from the attempt's own bookkeeping at the single
                    // exit point, so no call site can forget one and quietly tell
                    // the watchdog a turn finished when it didn't.
                    resolve(
                      attemptResult({
                        sawAssistantText,
                        stderr: stderrText,
                        reachedResult: runFinished,
                        resultIsError,
                        harnessError: sawHarnessError,
                        flatlined,
                        sawInit,
                        toolCalls,
                        textChars,
                        thinkChars,
                        lastFailedTool,
                        tokens: attemptTokens,
                        ...r,
                      }),
                    );
                  };
                  // ── Liveness, not silence ─────────────────────────────────
                  // The failure this catches, seen today: the agent ran a server
                  // in the foreground, the CLI died, and the GRANDCHILD kept the
                  // inherited stdout pipe open — so `close` never fired, the
                  // attempt promise never settled, and the turn hung until it was
                  // killed. `exit` still fires in that case, and a pid probe
                  // catches the rest.
                  //
                  // The rule that makes this safe: a child that is QUIET but
                  // ALIVE is thinking, and is never touched. Only a confirmed
                  // dead process whose stream has also stopped ends an attempt
                  // here.
                  const FLATLINE_MS = 45_000;
                  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
                  child.on("exit", (code, signal) => {
                    exited = { code, signal };
                  });
                  const liveness = setInterval(() => {
                    if (settled) return;
                    const handleDead = child.exitCode !== null || child.signalCode !== null;
                    if (!exited && !handleDead && pidAlive(child.pid)) return; // thinking
                    if (Date.now() - lastByteAt < FLATLINE_MS) return; // just exited — let `close` land
                    flatlined = true;
                    // The CLI is gone but something it spawned is still holding
                    // the pipes (and, being detached, would outlive the turn).
                    // killTree won't help — it no-ops once the direct child has
                    // exited — so signal the process GROUP directly. Without
                    // this the resumed attempt inherits the wedge that caused
                    // the stall in the first place.
                    try {
                      if (child.pid) process.kill(-child.pid, "SIGKILL");
                    } catch {
                      /* group already gone — nothing to clean up */
                    }
                    const ex = exited as {
                      code: number | null;
                      signal: NodeJS.Signals | null;
                    } | null;
                    concludeChild(ex?.code ?? null, ex?.signal ?? null);
                  }, 5_000);
                  liveness.unref?.();
                  child.on("error", (err) => {
                    finish({
                      ok: false,
                      errorText: String(err.message || err),
                    });
                  });
                  const concludeChild = (code: number | null, signal: NodeJS.Signals | null) => {
                    if (stdoutBuf.trim()) handleLine(stdoutBuf); // flush a final unterminated line
                    // A rejected flag aborts commander before anything runs — the
                    // whole turn is recoverable by dropping the flag and retrying.
                    const flagRejected =
                      /unknown option '?--(permission-prompt-tool|mcp-config)/.test(stderrText);
                    // Watchdog kills after the reply was produced still count as a
                    // successful turn; pre-output kills surface as errors.
                    // Both CLIs trap SIGTERM and exit themselves (143 = 128+15,
                    // 130 = 128+2), so the signal never reaches us as a `signal`.
                    // Treat those exits exactly like the signal we sent.
                    //
                    // 143 and 130 were named individually and that was too narrow:
                    // 128+N is the shell's whole convention for "a signal ended
                    // this", and the ones it missed are exactly the ways a turn
                    // gets killed from outside — 137 (SIGKILL, what an OOM kill
                    // and our own hard escalation produce), 129 (SIGHUP, a closed
                    // terminal), 131/134/139 (crash signals). Every one of them
                    // reached the generic branch below, came back "the process
                    // exited before the turn finished", and bought a resume.
                    const signalExit = typeof code === "number" && code > 128 && code < 160;
                    const stopped =
                      signal === "SIGTERM" || signal === "SIGKILL" || !!signal || signalExit;
                    // ── Interrupted, or merely unfinished? ────────────────────
                    // Until now these were the same thing, and the difference is
                    // whose money is at stake. A turn that died on its own is
                    // worth resuming; a turn that something ENDED — a pkill, an
                    // OOM kill, the dev server restarting under it, a stray
                    // signal — is not, because from in here an interruption is
                    // byte-for-byte identical to a crash and the watchdog was
                    // buying resumes for both. Codex makes it worse: 0.144.1
                    // emits no terminal JSON event at all on interruption
                    // (turn.completed and turn.failed are its only terminals), so
                    // the stream carries no trace of it whatsoever. The process
                    // exit is the only honest signal, so read it here.
                    //
                    // Two exclusions, both deliberate:
                    //   • `cancelled` — that is the user's own Stop, already its
                    //     own path and already never resumed.
                    //   • `watchdogFired` — that is OUR idle timeout deciding the
                    //     child had hung. A hang is exactly what a resume fixes,
                    //     so it must keep its recovery.
                    const interrupted = stopped && !cancelled && !watchdogFired;
                    // Name the thing, not the arithmetic. "exit code 137" makes
                    // the user look up 137; "SIGKILL (exit code 137)" tells them
                    // something killed the process, which is the whole point of
                    // reporting it. Only the signals a CLI actually dies of are
                    // mapped — anything else stays as the raw number rather than
                    // inventing a name for it.
                    const SIGNAL_BY_CODE: Record<number, string> = {
                      129: "SIGHUP",
                      130: "SIGINT",
                      131: "SIGQUIT",
                      134: "SIGABRT",
                      137: "SIGKILL",
                      139: "SIGSEGV",
                      143: "SIGTERM",
                    };
                    const namedCode = typeof code === "number" ? SIGNAL_BY_CODE[code] : undefined;
                    const interruptedBy = !interrupted
                      ? ""
                      : signal
                        ? String(signal)
                        : namedCode
                          ? `${namedCode} (exit code ${code})`
                          : `exit code ${code}`;
                    // A user cancel is not a failure and must never be dressed as
                    // one. Stopping a turn before the model had said anything used
                    // to produce a red card reading "Claude Code didn't respond in
                    // 5 minutes — auth may have expired", which is both wrong and
                    // alarming: the user had simply pressed Stop.
                    if (cancelled) {
                      // reachedResult forced true: see the pre-spawn cancel gate.
                      // Stop means stop, so this must not read as "unfinished".
                      finish({ ok: true, errorText: "", reachedResult: true });
                    } else if (code === 0 || (stopped && receivedAnyOutput)) {
                      // `ok` here means "the process ended without an error we can
                      // name" — NOT "the turn finished". A child killed mid-answer
                      // lands in this branch with runFinished false, and that
                      // difference is exactly what auto-continue reads.
                      finish({ ok: true, errorText: "", interrupted, interruptedBy });
                    } else if (stopped) {
                      finish({
                        ok: false,
                        errorText: interrupted
                          ? `The agent process was ended by ${interruptedBy} before it produced anything.`
                          : `Claude Code didn't respond in ${Math.round(FIRST_OUTPUT_TIMEOUT_MS / 60_000)} minutes. Check \`claude\` runs in a terminal (auth may have expired — run \`claude login\`).`,
                        flagRejected,
                        interrupted,
                        interruptedBy,
                      });
                    } else if (watchdogFired && !runFinished) {
                      finish({
                        ok: false,
                        errorText: `Claude Code went silent for ${Math.round((receivedAnyOutput ? MID_RUN_IDLE_MS : FIRST_OUTPUT_TIMEOUT_MS) / 60_000)}+ minutes mid-run, so the dashboard stopped it. Any partial answer above is kept — try again, or switch to a faster model for this task.`,
                        flagRejected,
                      });
                    } else {
                      finish({
                        ok: false,
                        errorText: `claude exited with code ${code ?? signal}`,
                        flagRejected,
                      });
                    }
                  };
                  child.on("close", concludeChild);
                });
              };

              // Router preflight — REPAIR, don't just report.
              //
              // The selected model governs only ccr's `default` route. Claude Code
              // picks a different route for thinking requests and for anything
              // past the long-context threshold, so a chat set to Kimi K3 could be
              // answered by whatever `think` and `longContext` happened to point
              // at. On 24 Jul that was GLM 5.2 for all five routes, and since
              // DESIGN work is almost entirely thinking requests, the art
              // direction of two overnight builds came from the wrong model. It
              // read as "Kimi lost the plot".
              //
              // The old code detected this perfectly and then ran the turn anyway.
              // Now it pins the routes, waits for the daemon, and says what it
              // did — so opening a fresh window and typing is enough.
              if (model.includes("/") && !/^gpt-/.test(model)) {
                const bad = routerMismatches(model);
                if (bad.length) {
                  const backup = pinRoutesTo(model);
                  if (backup) {
                    sendEvent(
                      "info",
                      `🔧 ${bad.length} router route${bad.length === 1 ? "" : "s"} (${bad
                        .map((b) => b.route)
                        .join(
                          ", ",
                        )}) pointed at ${shortModelName(bad[0].model)} instead of ${shortModelName(
                        model,
                      )} — repinned to ${shortModelName(model)} and restarted the router. Previous config saved to ${backup.split("/").pop()}.`,
                    );
                    // ccr needs a moment to re-read its config; starting the turn
                    // before it has would defeat the repair.
                    await new Promise((r) => setTimeout(r, 2_000));
                    const still = routerMismatches(model);
                    if (still.length)
                      sendEvent(
                        "router_mismatch",
                        JSON.stringify({ selected: model, routes: still }),
                      );
                  } else {
                    // Couldn't write the config — fall back to the old warning
                    // rather than running a turn on the wrong model silently.
                    sendEvent("router_mismatch", JSON.stringify({ selected: model, routes: bad }));
                  }
                }
              }

              // Drive the turn. First the real attempt; then, if this CLI build
              // doesn't know the approval flags, a repeat with them dropped so an
              // unsupported flag degrades the feature instead of breaking the run.
              let result = await runAttempt({
                model,
                sessionId,
                promptText: prompt,
                approvals: toolMode !== "yolo",
              });
              // A well-formed session id the CLI still won't resume — a pruned or
              // hand-deleted transcript, or an id copied from another machine —
              // used to fail EVERY turn on that chat, forever, with the same error
              // and no way for the user to clear it. Start a fresh session instead
              // of leaving the chat permanently dead.
              if (
                !cancelled &&
                /--resume requires a valid session ID|No conversation found with session ID/i.test(
                  `${result.stderr}\n${result.errorText}`,
                )
              ) {
                sendEvent(
                  "info",
                  "ℹ the previous session for this chat could not be resumed, so this turn continues in a new one.",
                );
                result = await runAttempt({
                  model,
                  sessionId: "",
                  promptText: prompt,
                  approvals: toolMode !== "yolo",
                });
              }
              if (result.flagRejected && !cancelled) {
                sendEvent(
                  "info",
                  "ℹ this Claude Code build doesn't accept --permission-prompt-tool, so approval cards are unavailable — running with read-only tools instead.",
                );
                result = await runAttempt({
                  model,
                  sessionId,
                  promptText: prompt,
                  approvals: false,
                });
              }

              // ── Failover ──────────────────────────────────────────────────
              // A model that can't answer must never be a dead end. Every entry
              // below is an error seen in the wild that means "this lane is not
              // going to reply", as opposed to "the model replied and said no":
              // an exhausted OpenRouter key cap, an OAuth token past refresh, a
              // router that isn't listening, a provider 402/403. On any of them
              // the same turn goes down the chain instead of stopping.
              const FAILOVER_PATTERNS: Array<[RegExp, string]> = [
                [/Key limit exceeded/i, "key limit exceeded"],
                [/requires more credits|insufficient (credits|balance)/i, "out of credits"],
                [
                  /exceeded (the )?model('s)? (maximum |token )?(context |token )?limit|context length exceeded|prompt is too long/i,
                  "exceeded the model's token limit",
                ],
                [/Provider returned error/i, "the provider returned an error"],
                [/ECONNREFUSED|ECONNRESET|socket hang up/i, "the router refused the connection"],
                [
                  /could not be refreshed|OAuth session expired|Please run .?claude login/i,
                  "OAuth session expired",
                ],
                [
                  /\b(401|403)\b|invalid_token|Unauthorized|Forbidden/i,
                  "authentication was rejected",
                ],
                [
                  /\b402\b|Payment Required|Insufficient Balance/i,
                  "the provider refused on billing",
                ],
                [
                  /model .{0,60}(not found|not supported|does not exist)|not a valid model/i,
                  "the model isn't available on this account",
                ],
                // The CLI's own wording when the --model id is unknown, verified
                // 26 Jul with `--model claude-nonexistent-9`. It arrives as an
                // ordinary assistant message ("There's an issue with the selected
                // model (…). It may not exist or you may not have access to it.")
                // followed by is_error, so neither HARNESS_ERROR_TEXT nor the
                // "does not exist" pattern above matched it, and the whole
                // failover chain sat out a turn that had no chance of answering.
                [
                  /issue with the selected model|may not have access to it/i,
                  "the model isn't available on this account",
                ],
                [/API Error: \d{3}/i, "the provider returned an API error"],
              ];
              const failoverReason = (text: string): string | null => {
                for (const [re, why] of FAILOVER_PATTERNS) if (re.test(text)) return why;
                return null;
              };
              // A non-zero exit is only a dead end if the model never said
              // anything — a turn that answered fully and then tripped on
              // cleanup is a finished turn, not a failed one.
              // A cancel must also close the failover door. Otherwise Stop kills
              // the child, the empty result looks like a dead lane, and the turn
              // helpfully starts again on the next model down the chain — the
              // agent visibly carrying on after being told to stop.
              const deadEnd = (r: AttemptResult) =>
                !detached &&
                !cancelled &&
                !liveRun.abortedByUser &&
                !r.sawAssistantText &&
                (!r.ok || failoverReason(`${r.stderr}\n${r.errorText}`) !== null);

              // Codex only accepts the model ids the signed-in ChatGPT account
              // actually exposes: a bare "gpt-5.6" is rejected with "not supported
              // when using Codex with a ChatGPT account" on plans that carry it
              // under a suffixed id. The id `codex` itself defaults to is the one
              // that's guaranteed to work, so read it rather than guess.
              const codexLastResort = (): string => {
                try {
                  const m = readFileSync(join(homedir(), ".codex", "config.toml"), "utf-8").match(
                    /^\s*model\s*=\s*"([^"]+)"/m,
                  );
                  if (m && /^gpt-/.test(m[1])) return m[1];
                } catch {
                  /* no codex config — fall through to the plain id */
                }
                return "gpt-5.6";
              };
              // configured model → the Anthropic subscription lane → Codex last,
              // because it's the only hop that can't carry the transcript.
              // NO OpenRouter model belongs in this chain. A metered fallback bills
              // the user silently on every errored turn, and OpenRouter-routed
              // models error often enough that the fallback becomes the norm —
              // GLM 5.2 sat here on 25 Jul 2026 and quietly answered a large share
              // of turns the user believed were Kimi K3. The subscription lane is
              // already paid for; failover must never reach for a metered vendor.
              const FAILOVER_CHAIN = ["claude-opus-5", codexLastResort()];
              const tried = new Set<string>([model]);
              let activeModel = model;
              let hops = 0;
              // Hoisted into a function so auto-continue can run it again after a
              // resume. The two mechanisms compose in ONE sequential loop rather
              // than racing: failover exhausts first (it changes model), then the
              // watchdog decides whether the turn still needs continuing, and a
              // resume that itself hits a dead lane can fail over again — bounded
              // by the same `hops < 3` counter it always was.
              //
              // `force` is how auto-continue hands a turn BACK to failover.
              // deadEnd() deliberately requires that the model said nothing,
              // because a model that answered and then tripped on cleanup has
              // finished. But there is a third shape, reproduced on 26 Jul with
              // `--model claude-nonexistent-9`: the CLI writes its own apology as
              // an ordinary assistant message ("There's an issue with the
              // selected model…" — no "API Error" prefix, so HARNESS_ERROR_TEXT
              // doesn't catch it), then ends the turn with is_error. That reads
              // as "the model replied", so failover stayed out of it, and the
              // watchdog would have resumed the same dead lane until loop
              // detection stopped it. When the turn is unfinished AND the error
              // is one the chain recognises, the model is the problem: hop.
              const runFailoverChain = async (force = false): Promise<boolean> => {
                const hopped = hops;
                while (
                  hops < 3 &&
                  (deadEnd(result) ||
                    (force &&
                      !cancelled &&
                      !liveRun.abortedByUser &&
                      failoverReason(`${result.stderr}\n${result.errorText}`) !== null))
                ) {
                  const next = FAILOVER_CHAIN.find((m) => !tried.has(m));
                  if (!next) break;
                  const reason =
                    failoverReason(`${result.stderr}\n${result.errorText}`) ??
                    (result.errorText || "no reply at all").split("\n")[0].slice(0, 120);
                  hops++;
                  tried.add(next);
                  sendEvent(
                    "failover",
                    JSON.stringify({ from: activeModel || "the selected model", to: next, reason }),
                  );
                  const viaCodexNext = /^gpt-/.test(next);
                  const preamble = `You are taking over mid-conversation from ${activeModel || "the previous model"}, which hit ${reason}. Continue the work seamlessly; do not restart or re-plan.`;
                  result = await runAttempt({
                    model: next,
                    // Claude Code transcripts are lane-agnostic, so the first hops
                    // resume the very same session. Codex keeps its own store and
                    // cannot read a Claude transcript, so that hop starts fresh and
                    // the preamble is the only context it gets.
                    sessionId: viaCodexNext ? "" : announcedSession || sessionId,
                    promptText: viaCodexNext
                      ? `${preamble}\n\nYou do not have the earlier transcript, so work from the request itself.\n\n${prompt}`
                      : `${preamble}\n\n${prompt}`,
                    approvals: toolMode !== "yolo",
                  });
                  activeModel = next;
                }
                return hops > hopped;
              };
              await runFailoverChain();

              // ── Auto-continue ─────────────────────────────────────────────
              // "There should never be a scenario where it stops working."
              //
              // Failover answers "this MODEL can't reply". This answers the other
              // half, and the one that actually killed turns today: the model was
              // fine and the TURN still ended unfinished — a child killed
              // mid-sentence, a `result` line with is_error, the harness printing
              // "API Error: 400" into the assistant stream instead of an answer,
              // a stream that flatlined with the process already gone. In every
              // one of those the transcript is intact on disk, so the honest
              // response is to resume the same session and finish, not to hand
              // the user a half-sentence and a warning triangle.
              //
              // The bounds are in src/lib/turn-watchdog.ts, with the reasoning
              // for each number. They are the point of the feature: an unbounded
              // version of this spends the user's money forever.
              const acState = freshAutoContinueState();
              const costBeforeResumes = turnCostUsd;
              const tokensBeforeResumes = turnTokens;
              for (;;) {
                // Lane first, turn second. If this ending is one the failover
                // chain recognises, changing model is the cheaper and more
                // likely fix than resuming into the same wall — and it keeps the
                // two mechanisms from both firing on one ending.
                if (unfinishedReason(result) && (await runFailoverChain(true))) continue;
                const decision = decideAutoContinue(acState, result, {
                  // NOT gated on `detached`: a browser that went away is the
                  // normal shape of an overnight run, and a headless turn that
                  // dies unrecovered is the exact failure this exists for. The
                  // replay buffer holds the resume events for the tab that
                  // comes back.
                  aborted: cancelled || liveRun.abortedByUser,
                  // Every model in the chain already failed — the lane is dead,
                  // and a resume just re-buys the same error on a slower clock.
                  laneExhausted: hops > 0 && !result.ok,
                });
                if (!decision.go) {
                  if (decision.message) {
                    // Twice on purpose. `info` is what a headless caller and the
                    // log see; `recovery_exhausted` is what the pane turns into a
                    // visible note in the thread AND what re-arms the loud ⚠
                    // states in the live strip. Until recovery is spent, a quiet
                    // turn is a turn being recovered, and the strip says so
                    // instead of shouting — but the moment it gives up, the user
                    // must be able to read what happened without watching the
                    // activity line at the right second.
                    sendEvent("info", decision.message);
                    sendEvent(
                      "recovery_exhausted",
                      JSON.stringify({
                        stopReason: decision.stopReason,
                        message: decision.message,
                      }),
                    );
                  }
                  break;
                }
                sendEvent(
                  "resume",
                  JSON.stringify({
                    attempt: decision.attempt,
                    max: decision.max,
                    reason: decision.reason,
                  }),
                );
                // Backoff, in 250ms slices so Stop is felt immediately rather
                // than up to 30 seconds later.
                for (let waited = 0; waited < decision.delayMs; waited += 250) {
                  if (cancelled || liveRun.abortedByUser) break;
                  await new Promise((r) => setTimeout(r, 250));
                }
                if (cancelled || liveRun.abortedByUser) break;
                suppressNextSegBreak = true; // continue the same paragraph
                const startedAt = Date.now();
                result = await runAttempt({
                  model: activeModel,
                  // The SAME session — that is the whole difference from
                  // failover. announcedSession is the id the CLI itself reported,
                  // which is the only one guaranteed to exist on disk.
                  sessionId: announcedSession || sessionId,
                  promptText: continuationPrompt(decision.reason),
                  approvals: toolMode !== "yolo",
                });
                // Failover runs BEFORE the ledger is updated, on purpose. A hop
                // spawned to rescue this resume is part of the recovery, and its
                // clock used to land outside the ledger entirely — so a resume
                // that hopped twice charged the time budget only for the first
                // child. Spend was already counted (turnCostUsd is turn-level and
                // every attempt adds to it); time was not.
                await runFailoverChain();
                acState.addedMs += Date.now() - startedAt;
                acState.addedUsd = Math.max(0, turnCostUsd - costBeforeResumes);
                acState.addedTokens = Math.max(0, turnTokens - tokensBeforeResumes);
              }
              if (acState.resumes > 0)
                // The finished-turn header must never claim a clean run for a
                // turn that was stitched out of four attempts.
                sendEvent("resumed_total", String(acState.resumes));

              if (!result.ok && hops > 0)
                // Every hop is spent. Say which model failed last and why, so the
                // error card carries the real cause rather than a bare exit code.
                result = {
                  ...result,
                  errorText: `Every model in the failover chain failed. Last: ${activeModel} — ${
                    failoverReason(`${result.stderr}\n${result.errorText}`) ?? result.errorText
                  }`,
                };

              // ── What this turn proved about the paid lane ─────────────────
              // The picker hides the metered twin of a model the user's plan
              // already covers. That is only safe while the plan's lane works,
              // and a turn is the only thing that can find out. A 401 here is
              // remembered so the metered entry comes back; a turn that produced
              // a reply is proof the credentials are live, so it clears the note.
              // Scoped to the codex lane because it is the only OAuth lane this
              // endpoint spawns — a claim about any other would be a guess.
              try {
                if (laneOf(activeModel) === "codex") {
                  const authRejected =
                    /\b(401|403)\b|invalid_token|Unauthorized|not logged in|codex login|re-?authenticate/i.test(
                      `${result.errorText}\n${result.stderr}`.slice(0, 4_000),
                    );
                  if (authRejected)
                    recordLaneAuth(
                      "codex",
                      "the last turn on this lane was rejected — try `codex login`",
                    );
                  else if (result.sawAssistantText) recordLaneAuth("codex", null);
                }
              } catch {
                /* a health note is a courtesy — never fail a turn over it */
              }

              // ── Verify the turn's filesystem claims ───────────────────────
              // Only what is really on disk, with its real size, right now. A
              // path the turn named and did not produce is simply absent — this
              // never says "missing", because a model mentioning a path it never
              // claimed to write would then read as a failure.
              try {
                const verified = [...claimedPaths]
                  .map((p) => {
                    try {
                      // lstat first: a symlink planted in the path would otherwise
                      // let a link point anywhere the server can read.
                      const st = lstatSync(p);
                      if (!st.isFile()) return null;
                      return { path: p, bytes: st.size, mtime: st.mtimeMs };
                    } catch {
                      return null;
                    }
                  })
                  .filter((f): f is { path: string; bytes: number; mtime: number } => f !== null)
                  .sort((a, b) => b.mtime - a.mtime)
                  .slice(0, 12);
                if (verified.length) {
                  for (const f of verified) {
                    servableFiles.add(f.path);
                    // Bounded: the allowlist is a session convenience, not a store.
                    if (servableFiles.size > 500)
                      servableFiles.delete(servableFiles.values().next().value as string);
                  }
                  sendEvent(
                    "files_written",
                    JSON.stringify(
                      verified.map((f) => ({
                        path: f.path,
                        bytes: f.bytes,
                        // encodeURIComponent, not a raw path: "Kola Deck.html"
                        // has a space in it, and a naive href silently truncates
                        // at the first one. Half the files a design turn writes
                        // have spaces in their names.
                        href: `/__claude_file?path=${encodeURIComponent(f.path)}`,
                      })),
                    ),
                  );
                }
              } catch {
                /* verification is a courtesy — never fail a turn over it */
              }

              turnFinished = true;
              releaseApprovals();
              clearInterval(heartbeat);
              // done/error is what closes every attached stream, so emit it while
              // the run is still registered, then retire it.
              if (result.ok) sendEvent("done", "ok");
              else sendEvent("error", result.errorText);
              if (liveRuns.get(chatId) === liveRun) liveRuns.delete(chatId);
            } catch (err) {
              // Anything unexpected still has to reach the user AND still has to
              // free the chat. Silence here was the old behaviour, and a silent
              // throw is indistinguishable from an agent that is thinking.
              try {
                sendEvent(
                  "error",
                  `The dashboard hit an internal error running this turn: ${
                    (err as { message?: string })?.message ?? String(err)
                  }`,
                );
              } catch {
                /* the stream is already gone — cleanup below still runs */
              }
            } finally {
              finalizeTurn();
              try {
                res.end();
              } catch {
                /* already ended */
              }
            }
          });

          // POST /__chat_title { user, assistant } — 3-5 word chat title
          // via Haiku (fast, ~free). 404s cleanly when the claude CLI is
          // missing so the frontend just keeps the first-message fallback.
          server.middlewares.use("/__chat_title", (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            void (async () => {
              res.setHeader("Content-Type", "application/json");
              let body = "";
              for await (const chunk of req as any) body += chunk;
              let payload: { user?: string; assistant?: string };
              try {
                payload = JSON.parse(body || "{}");
              } catch {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "invalid json" }));
                return;
              }
              const u = (payload.user ?? "").slice(0, 600);
              const a = (payload.assistant ?? "").slice(0, 600);
              const bin = resolveCliBin("claude");
              if (!bin || !u) {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "unavailable" }));
                return;
              }
              const prompt = `Reply with ONLY a 3-5 word title (no quotes, no punctuation at the end) that summarizes this conversation.\n\nUSER: ${u}\n\nASSISTANT: ${a}`;
              const cleanEnv = () => {
                const e = { ...process.env };
                for (const k of Object.keys(e))
                  if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK)/.test(k)) delete e[k];
                return e;
              };
              const runTitle = (env: NodeJS.ProcessEnv, extra: string[]) =>
                new Promise<string>((resolveP, rejectP) => {
                  execFile(
                    bin,
                    ["-p", prompt, ...extra, "--output-format", "json"],
                    { timeout: 45_000, cwd: homedir(), env },
                    (err, stdout) => (err ? rejectP(err) : resolveP(String(stdout))),
                  );
                });
              const parseTitle = (out: string) => {
                const j = JSON.parse(out);
                if (j?.is_error) throw new Error(String(j?.result ?? "cli error"));
                return String(j?.result ?? "")
                  .trim()
                  .replace(/^["']|["']$/g, "")
                  .slice(0, 48);
              };
              try {
                let title = "";
                try {
                  title = parseTitle(
                    await runTitle(cleanEnv(), ["--model", "claude-haiku-4-5-20251001"]),
                  );
                } catch {
                  // Anthropic OAuth busy/expired → route the title through ccr
                  // (OpenRouter) instead; no Anthropic auth involved.
                  const env = cleanEnv();
                  env.ANTHROPIC_BASE_URL = "http://127.0.0.1:3456";
                  env.ANTHROPIC_API_KEY = "ccr-router";
                  env.ANTHROPIC_MODEL = "openrouter,moonshotai/kimi-k3";
                  title = parseTitle(await runTitle(env, []));
                }
                if (!title) throw new Error("empty");
                res.end(JSON.stringify({ title }));
              } catch {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "title generation failed" }));
              }
            })();
          });

          // GET /__claude_commands — the user's custom slash commands
          // (~/.claude/commands/*.md), name + first line as description, so
          // the composer can autocomplete them.
          server.middlewares.use("/__claude_commands", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            res.setHeader("Content-Type", "application/json");
            try {
              const dir = join(homedir(), ".claude", "commands");
              const out: Array<{ name: string; description: string }> = [];
              for (const f of readdirSync(dir)) {
                if (!f.endsWith(".md")) continue;
                let desc = "";
                try {
                  desc =
                    readFileSync(join(dir, f), "utf-8")
                      .split("\n")
                      .map((l) => l.trim())
                      .find((l) => l && !l.startsWith("---")) ?? "";
                } catch {
                  /* unreadable file */
                }
                out.push({ name: `/${f.replace(/\.md$/, "")}`, description: desc.slice(0, 80) });
              }
              res.end(JSON.stringify({ commands: out.slice(0, 40) }));
            } catch {
              res.end(JSON.stringify({ commands: [] }));
            }
          });

          // GET /__claude_session?id=<uuid> — read a Claude Code session
          // transcript back from ~/.claude/projects/<cwd-slug>/<id>.jsonl so
          // reopening a chat restores real history (the CLI itself has no
          // transcript-export flag). The adapter always runs from $HOME, so
          // the slug is the home dir with path separators/dots → dashes.
          server.middlewares.use("/__claude_session", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const url = new URL(req.url ?? "/", "http://localhost");
            const sid = (url.searchParams.get("id") ?? "").trim();
            if (!/^[A-Za-z0-9_-]{8,64}$/.test(sid)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "bad id" }));
              return;
            }
            const slug = homedir().replace(/[/.]/g, "-");
            const file = join(homedir(), ".claude", "projects", slug, `${sid}.jsonl`);
            res.setHeader("Content-Type", "application/json");
            try {
              const messages: Array<{ role: string; content: string }> = [];
              for (const line of readFileSync(file, "utf-8").split("\n")) {
                if (!line.trim()) continue;
                let obj: any;
                try {
                  obj = JSON.parse(line);
                } catch {
                  continue;
                }
                if (obj?.isMeta) continue;
                const msg = obj?.message;
                if (!msg?.role) continue;
                let text = "";
                if (typeof msg.content === "string") text = msg.content;
                else if (Array.isArray(msg.content))
                  text = msg.content
                    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
                    .map((b: any) => b.text)
                    .join("\n");
                text = text.trim();
                // Skip tool-result plumbing and command wrappers.
                if (!text || /^<(command-name|local-command-stdout)/.test(text)) continue;
                if (msg.role === "user" || msg.role === "assistant")
                  messages.push({ role: msg.role, content: text });
              }
              res.end(JSON.stringify({ sessionId: sid, messages }));
            } catch {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: "session transcript not found" }));
            }
          });

          // GET /__openrouter_credits — remaining OpenRouter headroom for the key
          // that actually pays for this chat. Key read server-side, never sent to
          // the browser.
          //
          // It used to read ~/.hermes/.env only. But an OpenRouter-routed chat is
          // billed to the key in ccr's OWN config, and on this machine those are
          // two different keys: the .hermes one was capped at $50/mo with $1 left
          // while ccr's had $43 of $160. So the panel reported a balance no Kimi
          // turn had ever touched — and a whole debugging session was spent
          // "fixing" a blocker that did not exist. Read ccr's key first, because
          // ccr is what spends it; fall back to .hermes for non-ccr use.
          //
          // Also: /credits reports the ACCOUNT balance, which ignores a per-key
          // monthly cap. /key reports the cap. A key with credit in the account
          // and no headroom on the key still 402s, so report the tighter of the
          // two rather than the flattering one.
          server.middlewares.use("/__openrouter_credits", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            void (async () => {
              res.setHeader("Content-Type", "application/json");
              try {
                // 1. ccr's key — the one an OpenRouter-routed chat is billed to.
                let key = "";
                let source = "";
                try {
                  const cfg = JSON.parse(readFileSync(CCR_CONFIG, "utf-8"));
                  const provs = cfg?.Providers ?? cfg?.providers ?? [];
                  for (const p of Array.isArray(provs) ? provs : []) {
                    if (!/openrouter/i.test(String(p?.name ?? ""))) continue;
                    const k = String(p?.api_key ?? p?.apiKey ?? "");
                    if (k) {
                      key = k;
                      source = "ccr";
                    }
                  }
                } catch {
                  /* no ccr config — fall through to .hermes */
                }
                // 2. Fallback for setups that don't route through ccr.
                if (!key) {
                  for (const line of readFileSync(
                    join(homedir(), ".hermes", ".env"),
                    "utf-8",
                  ).split("\n")) {
                    const m = line.match(/^\s*OPENROUTER_API_KEY\s*=\s*(\S+)/);
                    if (m) {
                      key = m[1].replace(/^["']|["']$/g, "");
                      source = "hermes";
                    }
                  }
                }
                if (!key) throw new Error("no key");
                const auth = { Authorization: `Bearer ${key}` };
                const [credRes, keyRes] = await Promise.all([
                  fetch("https://openrouter.ai/api/v1/credits", { headers: auth }),
                  fetch("https://openrouter.ai/api/v1/key", { headers: auth }).catch(() => null),
                ]);
                if (!credRes.ok) throw new Error(`status ${credRes.status}`);
                const j: any = await credRes.json();
                const total = Number(j?.data?.total_credits ?? NaN);
                const used = Number(j?.data?.total_usage ?? NaN);
                if (!Number.isFinite(total) || !Number.isFinite(used)) throw new Error("bad body");
                const accountRemaining = total - used;
                // The per-key cap, when there is one, is the real ceiling.
                let keyRemaining: number | null = null;
                let keyLimit: number | null = null;
                try {
                  if (keyRes?.ok) {
                    const kj: any = await keyRes.json();
                    const lr = kj?.data?.limit_remaining;
                    keyLimit = kj?.data?.limit ?? null;
                    if (typeof lr === "number") keyRemaining = lr;
                  }
                } catch {
                  /* the account number alone is still worth showing */
                }
                const remaining =
                  keyRemaining === null
                    ? accountRemaining
                    : Math.min(accountRemaining, keyRemaining);
                res.end(
                  JSON.stringify({
                    remaining,
                    total,
                    used,
                    accountRemaining,
                    keyRemaining,
                    keyLimit,
                    source,
                  }),
                );
              } catch {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "credits unavailable" }));
              }
            })();
          });

          // GET /__openrouter_key — the KEY's own spending cap and usage
          // (openrouter.ai/api/v1/auth/key). This is what actually blocks
          // requests when exhausted — account balance can look healthy while
          // the key is dead (the 2026-07-24 build outage).
          server.middlewares.use("/__openrouter_key", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            void (async () => {
              res.setHeader("Content-Type", "application/json");
              try {
                let key = "";
                for (const line of readFileSync(join(homedir(), ".hermes", ".env"), "utf-8").split(
                  "\n",
                )) {
                  const m = line.match(/^\s*OPENROUTER_API_KEY\s*=\s*(\S+)/);
                  if (m) key = m[1].replace(/^["']|["']$/g, "");
                }
                if (!key) throw new Error("no key");
                const r = await fetch("https://openrouter.ai/api/v1/auth/key", {
                  headers: { Authorization: `Bearer ${key}` },
                });
                if (!r.ok) throw new Error(`status ${r.status}`);
                const j: any = await r.json();
                const d = j?.data ?? {};
                const limit = d.limit === null || d.limit === undefined ? null : Number(d.limit);
                const usage = Number(d.usage ?? NaN);
                if (!Number.isFinite(usage)) throw new Error("bad body");
                res.end(
                  JSON.stringify({
                    limit,
                    usage,
                    remaining: limit === null ? null : Math.max(0, limit - usage),
                    label: d.label ?? null,
                  }),
                );
              } catch {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "key info unavailable" }));
              }
            })();
          });

          // GET /__claude_models — sibling of /__hermes_models for the Claude
          // Code chat. Same response shape (default / catalog / mixtures /
          // configured) with a single "claude-code" group, so the model
          // picker can consume either endpoint unchanged. Loopback only.
          server.middlewares.use("/__claude_models", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const catalog: Array<{ provider: string; models: any[] }> = [
              {
                provider: "claude-code",
                models: [
                  { name: "claude-opus-5", tier: "top" },
                  { name: "claude-fable-5", tier: "top" },
                  { name: "claude-opus-4-8", tier: "top" },
                  { name: "claude-sonnet-5", tier: "mid" },
                  { name: "claude-haiku-4-5-20251001", tier: "fast" },
                ],
              },
            ];
            // If claude-code-router is configured, surface its OpenRouter
            // models too — the Claude Code harness can run ANY of them (Kimi
            // K3, GLM, …) by routing through ccr instead of the Anthropic
            // subscription. The chat adapter detects a "vendor/model" id and
            // sets ANTHROPIC_BASE_URL → ccr. `via: "ccr"` tells the picker
            // these need the daemon.
            const configured = ["claude-code"];
            try {
              const ccrCfg = join(homedir(), ".claude-code-router", "config.json");
              if (existsSync(ccrCfg)) {
                const cfg = JSON.parse(readFileSync(ccrCfg, "utf-8"));
                const provs = cfg.Providers ?? cfg.providers ?? [];
                const or = provs.find((p: any) =>
                  String(p?.name ?? "")
                    .toLowerCase()
                    .includes("openrouter"),
                );
                const orModels: string[] = Array.isArray(or?.models) ? or.models : [];
                if (orModels.length) {
                  catalog.push({
                    provider: "openrouter · via claude code",
                    models: orModels.map((id) => ({ name: id, tier: "top", via: "ccr" })),
                  });
                  configured.push("ccr");
                }
              }
            } catch {
              /* no ccr / unreadable config — Anthropic models only */
            }
            // Codex CLI installed → GPT models run through the user's
            // ChatGPT/Codex OAuth (no API key). The chat adapter routes any
            // gpt-* model to `codex exec`.
            if (resolveCliBin("codex")) {
              catalog.push({
                provider: "openai · via codex",
                models: [
                  { name: "gpt-5.6-sol", tier: "top", via: "codex" },
                  { name: "gpt-5.6-terra", tier: "top", via: "codex" },
                  { name: "gpt-5.6-luna", tier: "mid", via: "codex" },
                  { name: "gpt-5.5", tier: "mid", via: "codex" },
                  { name: "gpt-5.3-codex", tier: "fast", via: "codex" },
                ],
              });
              configured.push("codex");
            }
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(
              JSON.stringify({
                default: null,
                catalog,
                mixtures: [],
                configured,
                reasoningEffort: "",
                // Which paid lanes are usable RIGHT NOW. The picker hides a
                // metered duplicate only against a lane reported ok here, so an
                // expired login brings the metered entry straight back rather
                // than leaving the model unreachable. Keys are the catalog's own
                // provider labels, lower-cased.
                laneHealth: {
                  "claude-code": resolveCliBin("claude")
                    ? { ok: true }
                    : { ok: false, reason: "the Claude Code CLI is not installed" },
                  "openai · via codex": codexLaneHealth(),
                },
              }),
            );
          });

          // ────────────────────────────────────────────────────────────────
          // MISSION CONTROL ENDPOINTS
          // ────────────────────────────────────────────────────────────────
          // Mission state lives at ~/.hermes/missions.json as a single
          // JSON document: { active: <missionId | null>, missions: { <id>: Mission } }.
          // V1 is file-backed (single user, single machine, fast to
          // demo). V2 will migrate to the kanban DB so each mission is
          // a board and each mini-goal is a task — same shape, more
          // primitives. Keep the JSON shape stable so the migration is
          // a write-once shim.

          const MISSIONS_FILE = join(homedir(), ".hermes", "missions.json");

          function readMissions(): {
            active: string | null;
            missions: Record<string, any>;
          } {
            try {
              if (!existsSync(MISSIONS_FILE)) {
                return { active: null, missions: {} };
              }
              return JSON.parse(readFileSync(MISSIONS_FILE, "utf-8"));
            } catch {
              return { active: null, missions: {} };
            }
          }

          function writeMissions(data: {
            active: string | null;
            missions: Record<string, any>;
          }): void {
            const dir = join(homedir(), ".hermes");
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(MISSIONS_FILE, JSON.stringify(data, null, 2), {
              mode: 0o644,
            });
          }

          // GET /__hermes_missions — returns the active mission with mini-goals,
          // or null if none. Public-style read endpoint (loopback only).
          server.middlewares.use("/__hermes_missions", (req, res, next) => {
            // Only intercept the exact path, not sub-routes (optimize, create, tick)
            if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const data = readMissions();
            const mission = data.active ? data.missions[data.active] : null;
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ mission }));
          });

          // POST /__hermes_missions/optimize — shells `hermes chat` with the
          // optimize-mission skill instructions prepended so the model
          // decomposes raw text into a structured mission JSON.
          // Body: { input: "<rough mission text>" } → 200 { mission: {...} }
          server.middlewares.use("/__hermes_missions/optimize", async (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const token = req.headers["x-claude-os-token"];
            if (token !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "invalid token" }));
              return;
            }
            let body = "";
            for await (const chunk of req as any) body += chunk;
            let payload: { input?: string };
            try {
              payload = JSON.parse(body || "{}");
            } catch {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid json" }));
              return;
            }
            const input = (payload.input ?? "").trim();
            if (!input || input.length > 4000) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "input empty or too long (max 4000)" }));
              return;
            }

            const skillPath = join(
              homedir(),
              ".hermes",
              "skills",
              "productivity",
              "optimize-mission",
              "SKILL.md",
            );
            if (!existsSync(skillPath)) {
              res.statusCode = 500;
              res.end(
                JSON.stringify({
                  error: "optimize-mission skill not installed",
                }),
              );
              return;
            }
            const skillInstructions = readFileSync(skillPath, "utf-8");
            const prompt = `${skillInstructions}\n\n---\n\nUSER INPUT:\n${input}\n\nReturn ONLY the JSON object. No prose. No markdown fence. Start the response with { and end with }.`;

            // Resolve Hermes binary, mirroring the /__hermes_chat pattern.
            const home = homedir();
            const hermesRoot = join(home, ".hermes", "hermes-agent");
            const hermesPython = venvBin(join(hermesRoot, "venv"), "python");
            const hermesMain = join(hermesRoot, "hermes_cli", "main.py");
            const useSourceEntrypoint = existsSync(hermesPython) && existsSync(hermesMain);
            const binPath = useSourceEntrypoint ? hermesPython : resolveCliBin("hermes");
            if (!binPath) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: "hermes binary not found" }));
              return;
            }
            const args = useSourceEntrypoint
              ? [hermesMain, "chat", "-Q", "-q", prompt]
              : ["chat", "-Q", "-q", prompt];

            const hermesEnv = { ...process.env };
            delete hermesEnv.PYTHONPATH;
            delete hermesEnv.PYTHONHOME;
            const child = spawn(binPath, args, {
              cwd: home,
              env: {
                ...hermesEnv,
                PYTHONUNBUFFERED: "1",
                TERM: "xterm-256color",
                COLUMNS: "200",
                LINES: "60",
              },
            });

            let stdout = "";
            let stderr = "";
            const timeout = setTimeout(() => {
              if (!child.killed) child.kill("SIGTERM");
            }, 180_000); // 3 min budget for the model call

            child.stdout.on("data", (b: Buffer) => {
              stdout += b.toString("utf-8");
            });
            child.stderr.on("data", (b: Buffer) => {
              stderr += b.toString("utf-8");
            });
            child.on("close", (code) => {
              clearTimeout(timeout);
              // Extract JSON from stdout — model sometimes wraps with prose
              // despite instructions, so we find the first { and matching }
              let jsonStr = stdout.trim();
              const firstBrace = jsonStr.indexOf("{");
              const lastBrace = jsonStr.lastIndexOf("}");
              if (firstBrace !== -1 && lastBrace > firstBrace) {
                jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
              }
              try {
                const mission = JSON.parse(jsonStr);
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ mission }));
              } catch (e) {
                res.statusCode = 502;
                res.setHeader("Content-Type", "application/json");
                res.end(
                  JSON.stringify({
                    error: "Failed to parse JSON from Hermes",
                    raw: stdout.slice(0, 2000),
                    stderr: stderr.slice(0, 500),
                    code,
                  }),
                );
              }
            });
            child.on("error", (err) => {
              clearTimeout(timeout);
              res.statusCode = 500;
              res.end(JSON.stringify({ error: String(err.message || err) }));
            });
          });

          // POST /__hermes_missions/create — persist a mission as the active
          // mission. Body: the structured mission JSON returned by /optimize
          // (title, deadline_days, binary_outcome, mini_goals[]).
          // No token required — loopback-only is the security boundary, so
          // Hermes (also running locally) can POST via plain curl without
          // having to read the token file. Frontend can still pass a token
          // but it's ignored.
          server.middlewares.use("/__hermes_missions/create", async (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            let body = "";
            for await (const chunk of req as any) body += chunk;
            let payload: any;
            try {
              payload = JSON.parse(body || "{}");
            } catch {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid json" }));
              return;
            }
            if (
              !payload.title ||
              !Array.isArray(payload.mini_goals) ||
              payload.mini_goals.length === 0
            ) {
              res.statusCode = 400;
              res.end(
                JSON.stringify({
                  error: "missing title or mini_goals",
                }),
              );
              return;
            }
            if (payload.mini_goals.length > 10) {
              res.statusCode = 400;
              res.end(
                JSON.stringify({
                  error: "too many mini_goals (hard cap: 10)",
                }),
              );
              return;
            }
            // Require full_prompt on every mini-goal so the briefing
            // drawer always has a real authored brief (written using
            // discovery state) rather than the synthesized fallback.
            // Reject the whole payload if any are missing or anemic.
            // Tier the minimum by actor:
            //   - hermes  ≥ 200 chars  (the /goal prompt — full briefing)
            //   - human   ≥ 200 chars  (8-section briefing, 120–200 words)
            // Both tiers land at the same floor so Hermes has to do the
            // work for both; mis-tagging an anemic prompt as "human" to
            // dodge the check doesn't save anything.
            for (let i = 0; i < payload.mini_goals.length; i++) {
              const g = payload.mini_goals[i];
              const fp = typeof g?.full_prompt === "string" ? g.full_prompt.trim() : "";
              if (!fp || fp.length < 200) {
                res.statusCode = 400;
                res.end(
                  JSON.stringify({
                    error: `mini_goals[${i}].full_prompt missing or too short (need ≥200 chars of authored briefing — 80+ words for hermes /goal prompts, 120–200 words for human 8-section briefings)`,
                  }),
                );
                return;
              }
            }
            const id = `mission-${Date.now()}`;
            const days = Number(payload.deadline_days) || 28;
            const deadline = new Date(Date.now() + days * 86_400_000);
            const mission = {
              id,
              title: String(payload.title).slice(0, 200),
              binary_outcome: String(payload.binary_outcome ?? "").slice(0, 500),
              deadline_days: days,
              deadline_iso: deadline.toISOString(),
              created_at: new Date().toISOString(),
              mini_goals: payload.mini_goals.map((g: any, i: number) => ({
                id: `g-${id}-${i + 1}`,
                num: Number(g.num) || i + 1,
                title: String(g.title ?? "").slice(0, 200),
                actor: g.actor === "human" ? "human" : "hermes",
                done_when: String(g.done_when ?? "").slice(0, 500),
                full_prompt: String(g.full_prompt ?? "").slice(0, 4000),
                estimate: String(g.estimate ?? "").slice(0, 80),
                status: "queued",
              })),
              image_path: null,
            };
            const data = readMissions();
            data.missions[id] = mission;
            data.active = id;
            writeMissions(data);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ mission }));
          });

          // POST /__hermes_missions/tick — toggle a mini-goal's done status.
          // Body: { goalId: "g-<missionId>-<num>" }
          server.middlewares.use("/__hermes_missions/tick", async (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            let body = "";
            for await (const chunk of req as any) body += chunk;
            let payload: { goalId?: string };
            try {
              payload = JSON.parse(body || "{}");
            } catch {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid json" }));
              return;
            }
            const goalId = String(payload.goalId ?? "");
            if (!goalId) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "goalId required" }));
              return;
            }
            const data = readMissions();
            if (!data.active || !data.missions[data.active]) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: "no active mission" }));
              return;
            }
            const mission = data.missions[data.active];
            const goal = mission.mini_goals.find((g: any) => g.id === goalId);
            if (!goal) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: "goal not found" }));
              return;
            }
            goal.status = goal.status === "done" ? "queued" : "done";
            writeMissions(data);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ mission }));
          });

          // POST /__hermes_missions/clear — drop the active mission entirely.
          // No token required — loopback-only is the security boundary.
          server.middlewares.use("/__hermes_missions/clear", async (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const data = readMissions();
            data.active = null;
            writeMissions(data);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          });

          // GET /__hermes_skills — list installed Hermes skill categories
          // by walking ~/.hermes/skills/. Each top-level directory is a
          // category (apple, devops, research, etc.) with a DESCRIPTION.md
          // and zero-or-more sub-skill subdirectories. Loopback only.
          server.middlewares.use("/__hermes_skills", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const skillsDir = join(homedir(), ".hermes", "skills");
            const out: Array<{
              id: string;
              description: string;
              subskills: string[];
            }> = [];
            try {
              if (existsSync(skillsDir)) {
                const entries = readdirSync(skillsDir, { withFileTypes: true }).filter(
                  (e) => e.isDirectory() && !e.name.startsWith("."),
                );
                // Helper: pull a description from a markdown file with
                // YAML frontmatter. Prefers an explicit `description:`
                // line in the frontmatter, then falls back to the first
                // 1–2 non-heading body lines. Returns "" on any failure.
                function describeFromMd(path: string): string {
                  try {
                    let raw = readFileSync(path, "utf-8");
                    const fm = raw.match(/^---\n[\s\S]*?\n---\n?/);
                    if (fm) raw = raw.slice(fm[0].length);
                    const explicit = fm
                      ? fm[0].match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]
                      : undefined;
                    let description =
                      explicit?.trim() ||
                      raw
                        .split("\n")
                        .filter((l) => l.trim() && !l.startsWith("#"))
                        .slice(0, 2)
                        .join(" ")
                        .trim();
                    return description.slice(0, 240);
                  } catch {
                    return "";
                  }
                }
                for (const e of entries) {
                  const dir = join(skillsDir, e.name);
                  // 1) Prefer a top-level DESCRIPTION.md (Hermes-style).
                  let description = "";
                  const descPath = join(dir, "DESCRIPTION.md");
                  if (existsSync(descPath)) {
                    description = describeFromMd(descPath);
                  }
                  // 2) Fall back to a top-level SKILL.md — bundled Hermes
                  //    skills (dogfood, claude-os, etc.) carry their
                  //    description in the SKILL.md frontmatter instead.
                  if (!description) {
                    const skillPath = join(dir, "SKILL.md");
                    if (existsSync(skillPath)) {
                      description = describeFromMd(skillPath);
                    }
                  }
                  // 3) Some categories have neither at the top level but
                  //    DO have subskill directories with their own
                  //    SKILL.md (e.g. devops/<some-skill>/SKILL.md). For
                  //    those we synthesize a description from the first
                  //    sub-skill's frontmatter — better than empty.
                  if (!description) {
                    try {
                      const subs = readdirSync(dir, { withFileTypes: true })
                        .filter((s) => s.isDirectory() && !s.name.startsWith("."))
                        .map((s) => s.name);
                      for (const sub of subs) {
                        const subSkillPath = join(dir, sub, "SKILL.md");
                        if (existsSync(subSkillPath)) {
                          const subDesc = describeFromMd(subSkillPath);
                          if (subDesc) {
                            description = subDesc;
                            break;
                          }
                        }
                      }
                    } catch {
                      /* ignore */
                    }
                  }
                  let subskills: string[] = [];
                  try {
                    subskills = readdirSync(dir, { withFileTypes: true })
                      .filter((s) => s.isDirectory() && !s.name.startsWith("."))
                      .map((s) => s.name)
                      .slice(0, 12);
                  } catch {
                    /* ignore */
                  }
                  out.push({ id: e.name, description, subskills });
                }
              }
            } catch {
              /* surface empty list rather than 500 */
            }
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ skills: out }));
          });

          // GET /__hermes_profiles — list configured Hermes profiles by
          // shelling out to `hermes profile list`. Each row in the output
          // is a profile (◆default → name, model, gateway, alias). The
          // active profile is marked with ◆. Loopback only.
          server.middlewares.use("/__hermes_profiles", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const out: Array<{
              name: string;
              model: string | null;
              gateway: string | null;
              alias: string | null;
              distribution: string | null;
              active: boolean;
            }> = [];
            try {
              // Use `hermes profile list` with no --json flag — the binary's
              // table output is stable enough for line-parsing. The leading
              // ◆ glyph marks the sticky-default profile. We strip Rich box-
              // drawing chars and split on 2+ spaces between cells.
              const raw = execSync("hermes profile list", {
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
                env: { ...process.env, NO_COLOR: "1" },
                timeout: 5000,
              });
              const lines = raw.split("\n");
              for (const line of lines) {
                // Strip Rich's heavy box-drawing characters so we can split
                // on 2+ spaces cleanly.
                const clean = line.replace(/[┃│┏┓┗┛━─╇┡┩┛┃◇]/g, " ").trim();
                if (!clean) continue;
                // Header / divider rows
                if (
                  /^Profile/i.test(clean) ||
                  /^[\s─━]+$/.test(clean) ||
                  /^Name\s+Model/i.test(clean)
                )
                  continue;
                const cells = clean.split(/\s{2,}/).map((c) => c.trim());
                if (cells.length < 2) continue;
                let name = cells[0];
                const active = name.startsWith("◆") || name.startsWith("*");
                name = name.replace(/^[◆*]\s*/, "").trim();
                if (!name || /^[—-]+$/.test(name)) continue;
                // Skip rows that are just emoji-only or look bogus
                if (!/[a-z0-9_-]/i.test(name)) continue;
                const model = cells[1] && !/^[—-]+$/.test(cells[1]) ? cells[1] : null;
                const gateway = cells[2] && !/^[—-]+$/.test(cells[2]) ? cells[2] : null;
                const alias = cells[3] && !/^[—-]+$/.test(cells[3]) ? cells[3] : null;
                const distribution = cells[4] && !/^[—-]+$/.test(cells[4]) ? cells[4] : null;
                out.push({ name, model, gateway, alias, distribution, active });
              }
            } catch {
              /* hermes binary not found / errored — surface empty list */
            }
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ profiles: out }));
          });

          // GET /__hermes_connections — Hermes-specific connectivity. Real
          // signals only: provider auths from auth.json, messaging gateway
          // tokens from ~/.hermes/.env, configured MCP servers. NOT the
          // dashboard's broader machine integrations — those don't
          // necessarily plumb into Hermes. Loopback only.
          //
          // Returns { connections: [{kind, name, slug, status}] }
          //   kind = "provider" | "gateway" | "mcp" | "memory"
          //   slug = brand-icon slug for logo lookup
          //   status = "connected" | "needs_setup"
          server.middlewares.use("/__hermes_connections", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            // 30s cache — connections rarely change inside one user session;
            // running 6 CLI probes on every page focus is wasteful.
            if (sendCached("hermes-connections", res)) return;
            const conns: Array<{
              kind: string;
              name: string;
              slug: string;
              status: string;
            }> = [];

            // 1. Provider auths — read auth.json's providers map.
            try {
              const authPath = join(homedir(), ".hermes", "auth.json");
              if (existsSync(authPath)) {
                const raw = readFileSync(authPath, "utf-8");
                const j = JSON.parse(raw);
                const providers = j?.providers ?? {};
                for (const key of Object.keys(providers)) {
                  conns.push({
                    kind: "provider",
                    name: key,
                    slug: key.toLowerCase().replace(/-codex$/, ""),
                    status: "connected",
                  });
                }
              }
            } catch {
              /* ignore */
            }

            // 2. Messaging gateway tokens — read .env, look for known keys.
            //    Also: GENERIC API-key scan. Any other *_API_KEY / *_TOKEN /
            //    *_SECRET that the user has set (uncommented + non-empty)
            //    surfaces as a "service" connection automatically. This
            //    means dropping APOLLO_API_KEY into ~/.hermes/.env is all
            //    it takes for Apollo to show up in the dashboard strip —
            //    no code changes needed for every new skill/service.
            try {
              const envPath = join(homedir(), ".hermes", ".env");
              if (existsSync(envPath)) {
                const env = readFileSync(envPath, "utf-8");
                const GATEWAY_TOKENS: Record<string, { name: string; slug: string }> = {
                  TELEGRAM_BOT_TOKEN: { name: "Telegram", slug: "telegram" },
                  SLACK_BOT_TOKEN: { name: "Slack", slug: "slack" },
                  DISCORD_TOKEN: { name: "Discord", slug: "discord" },
                  WHATSAPP_CLOUD_TOKEN: { name: "WhatsApp", slug: "whatsapp" },
                  TWILIO_AUTH_TOKEN: { name: "SMS", slug: "twilio" },
                  RESEND_API_KEY: { name: "Email", slug: "resend" },
                  SENDGRID_API_KEY: { name: "Email", slug: "sendgrid" },
                };
                const knownTokenKeys = new Set(Object.keys(GATEWAY_TOKENS));
                for (const [token, meta] of Object.entries(GATEWAY_TOKENS)) {
                  const re = new RegExp(`^\\s*${token}\\s*=\\s*[^\\s#]`, "m");
                  if (re.test(env)) {
                    conns.push({
                      kind: "gateway",
                      name: meta.name,
                      slug: meta.slug,
                      status: "connected",
                    });
                  }
                }

                // Generic pass: catch ANY service the user has added via
                // an API key / token / secret env var. Skip anything we've
                // already surfaced above + provider creds (those come from
                // auth.json) + bare-noise tokens (HF_HOME etc. that aren't
                // credentials).
                const PROVIDER_KEYS = new Set([
                  "ANTHROPIC_API_KEY",
                  "OPENAI_API_KEY",
                  "OPENROUTER_API_KEY",
                  "GROQ_API_KEY",
                  "MISTRAL_API_KEY",
                  "GEMINI_API_KEY",
                  "GOOGLE_API_KEY",
                  "GOOGLE_GENERATIVE_AI_API_KEY",
                  "PERPLEXITY_API_KEY",
                  "COHERE_API_KEY",
                ]);
                const NON_CREDENTIAL_NOISE = new Set([
                  "HF_TOKEN", // some setups use this for HuggingFace download cache, still a token though
                ]);
                const seenServices = new Set<string>();
                // Match `NAME_API_KEY=value`, `NAME_TOKEN=value`, etc.
                const pattern =
                  /^\s*([A-Z][A-Z0-9_]*?)_(API_KEY|TOKEN|SECRET|ACCESS_TOKEN|API_TOKEN)\s*=\s*([^\s#].*)$/gm;
                let m: RegExpExecArray | null;
                while ((m = pattern.exec(env)) !== null) {
                  const fullKey = `${m[1]}_${m[2]}`;
                  if (knownTokenKeys.has(fullKey)) continue; // already surfaced as gateway
                  if (PROVIDER_KEYS.has(fullKey)) continue; // provider, comes from auth.json
                  if (NON_CREDENTIAL_NOISE.has(fullKey)) continue;
                  const root = m[1].toLowerCase();
                  if (seenServices.has(root)) continue;
                  seenServices.add(root);
                  // Derive a human-readable name: APOLLO -> "Apollo",
                  // STRIPE_LIVE -> "Stripe Live", AIRTABLE -> "Airtable".
                  const niceName = root
                    .split("_")
                    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
                    .join(" ");
                  const slug = root.replace(/_/g, "-");
                  conns.push({
                    kind: "service",
                    name: niceName,
                    slug,
                    status: "connected",
                  });
                }
              }
            } catch {
              /* ignore */
            }

            // 3. MCP servers — Hermes CLI requires a TTY for `mcp list`,
            // which means execSync from a non-TTY context hangs until
            // timeout. The endpoint was eating 3s per request for zero
            // benefit. Skip until Hermes ships a non-interactive flag.

            // 4. CLI-backed services — Hermes' skills use external CLIs
            // (gh, gws, linear-cli, spotify, etc.) for their actual work.
            // We probe each CLI's "am I authenticated?" command. If it
            // returns 0, the user has a working connection. Probes are
            // 500ms timeout + silent so missing/slow CLIs never block.
            // Most fail instantly (command not found) which is sub-ms.
            const cliServices: Array<{
              name: string;
              slug: string;
              probe: string;
            }> = [
              { name: "GitHub", slug: "github", probe: "gh auth status" },
              { name: "Google Workspace", slug: "google", probe: "gws auth status" },
              { name: "Linear", slug: "linear", probe: "linear whoami" },
              { name: "Spotify", slug: "spotify", probe: "spotify auth status" },
              { name: "Notion", slug: "notion", probe: 'test -n "$NOTION_TOKEN"' },
              { name: "Airtable", slug: "airtable", probe: 'test -n "$AIRTABLE_API_KEY"' },
            ];
            for (const svc of cliServices) {
              try {
                execSync(svc.probe, {
                  stdio: ["ignore", "ignore", "ignore"],
                  env: { ...process.env, NO_COLOR: "1" },
                  timeout: 500,
                });
                conns.push({
                  kind: "service",
                  name: svc.name,
                  slug: svc.slug,
                  status: "connected",
                });
              } catch {
                /* not authenticated or CLI not installed — skip */
              }
            }

            const body = JSON.stringify({ connections: conns });
            storeCached("hermes-connections", 30000, body);
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("X-Cache", "MISS");
            res.end(body);
          });

          // ────────────────────────────────────────────────────────────────
          // Pantheon — persona YAMLs at ~/.hermes/pantheon/personas/*.yaml.
          // Schema (per Hermes' spec, see PROFILE_TEMPLATES.tsx):
          //   id, name, description, avatar?, model:{provider,name},
          //   behavior:{tone,system_prompt}, skills:[], tools:[],
          //   summon_phrases:[]
          //
          // GET  /__hermes_pantheon         → list installed personas
          // POST /__hermes_pantheon/install → write the seed 10 YAMLs
          //                                   (idempotent — skips files
          //                                   that already exist so user
          //                                   edits aren't clobbered).
          //                                   Token-gated.
          // POST /__hermes_pantheon/validate → schema-check a single
          //                                    persona payload
          // ────────────────────────────────────────────────────────────────
          // Lazy-loaded — only the pantheon routes use it, so we keep
          // top-level imports stable.
          const pantheonDir = join(homedir(), ".hermes", "pantheon", "personas");
          const pantheonAssetsDir = join(homedir(), ".hermes", "pantheon", "assets");

          /** Read one persona YAML file → parsed object + path. Returns
           *  null on parse error (we log to stderr but don't 500 the
           *  whole listing for one bad file). */
          async function readPersonaFile(path: string): Promise<any | null> {
            try {
              const yaml = await import("js-yaml");
              const raw = readFileSync(path, "utf-8");
              return yaml.load(raw);
            } catch {
              return null;
            }
          }

          server.middlewares.use("/__hermes_pantheon", async (req, res, next) => {
            // vite strips the mount prefix; inside this handler req.url is
            // "/" for bare GETs and "/install" / "/validate" for sub-paths.
            // We only handle the bare GET here — sub-paths fall through to
            // the install/validate handlers below.
            const url = new URL(req.url ?? "/", "http://x");
            if (url.pathname !== "/") return next();
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const personas: any[] = [];
            try {
              if (existsSync(pantheonDir)) {
                const files = readdirSync(pantheonDir).filter(
                  (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
                );
                for (const f of files) {
                  const obj = await readPersonaFile(join(pantheonDir, f));
                  if (obj && typeof obj === "object" && obj.id) {
                    personas.push({ ...obj, _file: f });
                  }
                }
              }
            } catch {
              /* surface empty list rather than 500 */
            }
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(
              JSON.stringify({
                personas,
                installed: existsSync(pantheonDir),
                dir: pantheonDir,
              }),
            );
          });

          // POST /__hermes_pantheon/install — writes the 10 seed YAMLs
          // (curated by the operator + Hermes) to ~/.hermes/pantheon/personas/.
          // Skips any file that already exists, so re-running is safe
          // and doesn't clobber user customisations.
          server.middlewares.use("/__hermes_pantheon/install", async (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const token = req.headers["x-claude-os-token"];
            if (token !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            try {
              mkdirSync(pantheonDir, { recursive: true });
              mkdirSync(pantheonAssetsDir, { recursive: true });
            } catch {
              /* ignore */
            }
            const yaml = await import("js-yaml");
            const written: string[] = [];
            const skipped: string[] = [];
            // Only seed personas flagged as default. The rest are still
            // available as templates via /create but don't get auto-written
            // on install (design call — fewer personas by default is better
            // UX than 10 unfamiliar tiles).
            for (const seed of PANTHEON_SEEDS.filter((s) => s.default)) {
              const dest = join(pantheonDir, `${seed.id}.yaml`);
              if (existsSync(dest)) {
                skipped.push(seed.id);
                continue;
              }
              try {
                const body = yaml.dump(seed, {
                  lineWidth: 100,
                  noRefs: true,
                  sortKeys: false,
                });
                writeFileSync(dest, body, "utf-8");
                written.push(seed.id);
              } catch {
                /* file write fail — leave it out */
              }
            }
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                written,
                skipped,
                dir: pantheonDir,
              }),
            );
          });

          // POST /__hermes_pantheon/validate — schema-checks a persona
          // payload (request body = JSON {persona: <obj>}). Returns
          // {errors: [], warnings: []} so the dashboard can light up
          // a card before allowing export.
          server.middlewares.use("/__hermes_pantheon/validate", (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
              let payload: any;
              try {
                payload = JSON.parse(body);
              } catch {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "invalid json" }));
                return;
              }
              const p = payload?.persona ?? payload;
              const errors: string[] = [];
              const warnings: string[] = [];
              if (!p?.id) errors.push("missing id");
              if (!p?.name) errors.push("missing name");
              if (!p?.model?.name) errors.push("missing model.name");
              if (!p?.model?.provider) warnings.push("missing model.provider");
              if (!p?.behavior?.system_prompt) errors.push("missing behavior.system_prompt");
              if (!Array.isArray(p?.skills) || p.skills.length === 0)
                warnings.push("no skills listed");
              if (!Array.isArray(p?.summon_phrases) || p.summon_phrases.length === 0)
                errors.push("missing summon_phrases (at least 1 required)");
              // Tripwire — common secret patterns that should never appear
              // in a YAML you're about to push to GitHub.
              const flat = JSON.stringify(p ?? {});
              if (/sk-[a-z0-9]{20,}/i.test(flat)) errors.push("looks like an api key in payload");
              if (/(api_?key|secret|password)\s*[:=]/i.test(flat))
                warnings.push("payload mentions 'api_key/secret/password' — double-check");
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: errors.length === 0, errors, warnings }));
            });
          });

          // POST /__hermes_pantheon/create — create a new persona from one
          // of the PANTHEON_SEEDS templates, with the user's model + job
          // overrides applied. Returns 409 if a YAML with that id already
          // exists (the user is expected to pick an unused template).
          server.middlewares.use("/__hermes_pantheon/create", (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const token = req.headers["x-claude-os-token"];
            if (token !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", async () => {
              let payload: any;
              try {
                payload = JSON.parse(body);
              } catch {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "invalid json" }));
                return;
              }
              const { templateId, model, job, description, prompt } = payload ?? {};
              const seed = PANTHEON_SEEDS.find((s) => s.id === templateId);
              if (!seed) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "unknown template id" }));
                return;
              }
              const dest = join(pantheonDir, `${seed.id}.yaml`);
              if (existsSync(dest)) {
                res.statusCode = 409;
                res.end(JSON.stringify({ error: "persona already exists" }));
                return;
              }
              try {
                mkdirSync(pantheonDir, { recursive: true });
              } catch {
                /* ignore */
              }
              const merged = {
                ...seed,
                job: typeof job === "string" && job.trim() ? job.trim() : seed.job,
                description:
                  typeof description === "string" && description.trim()
                    ? description.trim()
                    : seed.description,
                model:
                  model && model.provider && model.name
                    ? {
                        provider: model.provider,
                        name: model.name,
                        // Reasoning-effort dial — whitelist the value so
                        // junk never lands in the YAML.
                        ...(["low", "medium", "high", "xhigh", "max"].includes(model.effort)
                          ? { effort: model.effort }
                          : {}),
                      }
                    : seed.model,
                behavior:
                  typeof prompt === "string" && prompt.trim()
                    ? { ...seed.behavior, system_prompt: prompt.trim() }
                    : seed.behavior,
              };
              try {
                const yaml = await import("js-yaml");
                writeFileSync(
                  dest,
                  yaml.dump(merged, { lineWidth: 100, noRefs: true, sortKeys: false }),
                  "utf-8",
                );
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, persona: merged }));
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err?.message ?? "write failed" }));
              }
            });
          });

          // GET /__hermes_pantheon_templates — surface the seed catalog
          // (id, name, job, default model) so the dashboard's Add Persona
          // wizard can show what's available without duplicating the data.
          server.middlewares.use("/__hermes_pantheon_templates", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const out = PANTHEON_SEEDS.map((s) => ({
              id: s.id,
              name: s.name,
              job: s.job ?? "",
              description: s.description,
              defaultModel: s.model,
            }));
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ templates: out }));
          });

          // PUT or DELETE /__hermes_pantheon/<id> — edit or remove a
          // persona's YAML on disk. Body for PUT: JSON patch (shallow
          // merged onto the existing YAML). DELETE just unlinks the file.
          // Token-gated, loopback only.
          server.middlewares.use("/__hermes_pantheon/", async (req, res, next) => {
            // Mounted on /__hermes_pantheon/ so we catch /<id> requests
            // (install / validate / create are mounted separately above).
            if (req.method !== "PUT" && req.method !== "POST" && req.method !== "DELETE")
              return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const url = new URL(req.url ?? "/", "http://x");
            const id = url.pathname.replace(/^\//, "").split("/")[0];
            // The /install and /validate sub-routes are handled by their own
            // middleware higher up. Anything else falls through to here as
            // an "edit this persona by id" request.
            if (!id || id === "install" || id === "validate") return next();
            if (!/^[a-z0-9_-]+$/i.test(id)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid id" }));
              return;
            }
            const token = req.headers["x-claude-os-token"];
            if (token !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            const filePath = join(pantheonDir, `${id}.yaml`);
            if (!existsSync(filePath)) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: "persona not found" }));
              return;
            }

            // DELETE — unlink the YAML and return ok.
            if (req.method === "DELETE") {
              try {
                unlinkSync(filePath);
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, deleted: id }));
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err?.message ?? "delete failed" }));
              }
              return;
            }

            // PUT/POST — JSON-patch the YAML on disk.
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", async () => {
              let patch: any;
              try {
                patch = JSON.parse(body);
              } catch {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "invalid json" }));
                return;
              }
              try {
                const yaml = await import("js-yaml");
                const existing = (yaml.load(readFileSync(filePath, "utf-8")) as any) ?? {};
                // Shallow merge for top-level fields; nested merge for
                // model + behavior so partial updates don't clobber other keys.
                const merged = { ...existing, ...patch };
                if (patch.model && existing.model)
                  merged.model = { ...existing.model, ...patch.model };
                // Effort dial hygiene: effort: null means "remove the key"
                // (model switched to one without a reasoning-effort knob),
                // and anything outside the known stops is dropped too.
                if (merged.model && "effort" in merged.model) {
                  const validEffort = ["low", "medium", "high", "xhigh", "max"];
                  if (!validEffort.includes(merged.model.effort)) delete merged.model.effort;
                }
                if (patch.behavior && existing.behavior)
                  merged.behavior = { ...existing.behavior, ...patch.behavior };
                const out = yaml.dump(merged, {
                  lineWidth: 100,
                  noRefs: true,
                  sortKeys: false,
                });
                writeFileSync(filePath, out, "utf-8");
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, persona: merged }));
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err?.message ?? "write failed" }));
              }
            });
          });

          // GET /__app_version — the running build's version + changelog,
          // parsed from CHANGELOG.md. Because it reads the file (not git), it
          // works for plain downloads with no repo; the git short hash is only
          // appended when a .git is present. Loopback only. Powers the header
          // version pill + the in-app "What's new" panel so anyone can see
          // which build they're on (even if the download's name lags the real
          // contents) and what each update changed before merging their edits.
          // POST /__start_voice — start the local voice engine (voice-lab) with the
          // user's OWN key so they never touch a terminal. The key is passed via the
          // child's ENV (not argv → never visible to `ps`). Loopback + token gated.
          // Body: { key?, base? }. Returns { ok, keyed } once :8099 answers health.
          let voiceChild: any = null;
          server.middlewares.use("/__start_voice", async (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            if (req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "invalid token" }));
              return;
            }
            let raw = "";
            for await (const chunk of req as any) raw += chunk;
            let key = "",
              base = "";
            try {
              const b = JSON.parse(raw || "{}");
              if (typeof b.key === "string") key = b.key.trim();
              if (typeof b.base === "string") base = b.base.trim();
            } catch {
              /* ignore */
            }
            // `base` decides where the user's OpenAI key gets sent — allowlist it (OpenAI, or a
            // local model server) so a caller can't redirect the Bearer key to an attacker host.
            if (base) {
              let baseOk = false;
              try {
                const u = new URL(base);
                baseOk =
                  !u.username &&
                  !u.password &&
                  ((u.protocol === "https:" && u.hostname === "api.openai.com") ||
                    u.hostname === "localhost" ||
                    u.hostname === "127.0.0.1" ||
                    u.hostname === "::1" ||
                    u.hostname === "[::1]");
              } catch {
                /* invalid */
              }
              if (!baseOk) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "base_not_allowed" }));
                return;
              }
            }
            // Durable key: a freshly-entered key is persisted to ~/.hermes/.env
            // FIRST — before any early return — so it's saved even when the
            // engine already happens to be keyed (e.g. from a shell export).
            // This is what stops voice "forgetting" the key across dev-server
            // restarts and across dashboard ports (localStorage is per-port).
            if (key) writeHermesEnv("OPENAI_API_KEY", key);
            const health = async () => {
              try {
                const r = await fetch("http://127.0.0.1:8099/api/health");
                if (r.ok) return (await r.json()) as any;
              } catch {
                /* down */
              }
              return null;
            };
            let h = await health();
            if (h && h.keyed) {
              res.end(JSON.stringify({ ok: true, already: true, keyed: true }));
              return;
            }
            // No key supplied and engine not keyed → fall back to the saved
            // one, so re-opening voice on ANY port after ANY restart just works.
            if (!key && !base) {
              const saved = readHermesEnv("OPENAI_API_KEY");
              if (saved) key = saved;
            }
            if (!key && !base) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "no_key" }));
              return;
            }
            try {
              if (voiceChild && voiceChild.exitCode === null) {
                try {
                  voiceChild.kill();
                } catch {
                  /* ignore */
                }
              }
              const childEnv: Record<string, string> = { ...(process.env as any), PORT: "8099" };
              if (key) childEnv.OPENAI_API_KEY = key;
              if (base) childEnv.OPENAI_BASE_URL = base;
              voiceChild = spawn("bun", ["run", "voice-lab/server.ts"], {
                cwd: process.cwd(),
                env: childEnv,
                stdio: "ignore",
              });
              voiceChild.on("exit", () => {
                voiceChild = null;
              });
            } catch (e: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e?.message || "spawn_failed" }));
              return;
            }
            for (let i = 0; i < 30; i++) {
              await new Promise((r) => setTimeout(r, 200));
              h = await health();
              if (h && h.ok) {
                res.end(JSON.stringify({ ok: true, keyed: !!h.keyed }));
                return;
              }
            }
            res.end(JSON.stringify({ ok: false, error: "engine_timeout" }));
          });

          server.middlewares.use("/__app_version", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            let version = "";
            let date = "";
            let markdown = "";
            try {
              const clPath = resolve(__dirname, "CHANGELOG.md");
              if (existsSync(clPath)) {
                markdown = readFileSync(clPath, "utf-8");
                const m = markdown.match(/^##\s+(V[\d.]+)\s*[—–-]\s*(.+?)\s*$/m);
                if (m) {
                  version = m[1];
                  date = m[2];
                }
              }
            } catch {
              /* ignore — pill renders nothing if version can't be read */
            }
            let hash = "";
            try {
              hash = execSync("git rev-parse --short HEAD", {
                cwd: __dirname,
                stdio: ["ignore", "pipe", "ignore"],
              })
                .toString()
                .trim();
            } catch {
              /* no git (plain download) — version still works without it */
            }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ version, date, hash, markdown }));
          });

          // GET /__hermes_models — list the user's available models so the
          // persona-edit dropdown is grounded in reality. Sources:
          //   1. The default in ~/.hermes/config.yaml (highest signal —
          //      this is what the user has actually set up)
          //   2. A curated catalog of widely-supported models grouped by
          //      provider, used as the dropdown's "recommended" section.
          // Loopback only.
          server.middlewares.use("/__hermes_models", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            // Default from config.yaml
            let defaultModel: { provider: string; name: string; context?: number } | null = null;
            try {
              const cfgPath = join(homedir(), ".hermes", "config.yaml");
              if (existsSync(cfgPath)) {
                const text = readFileSync(cfgPath, "utf-8");
                const m = text.match(/^model:\s*\n((?:[ \t]+.+\n)+)/m);
                if (m) {
                  const block = m[1];
                  const name = block.match(/^\s+default:\s*["']?([^"'\n]+)/m)?.[1]?.trim();
                  const provider = block.match(/^\s+provider:\s*["']?([^"'\n]+)/m)?.[1]?.trim();
                  const ctxRaw = block
                    .match(/^\s+context_length:\s*([0-9_]+)/m)?.[1]
                    ?.replace(/_/g, "");
                  if (name)
                    defaultModel = {
                      provider: provider ?? "openai",
                      name,
                      ...(ctxRaw ? { context: Number(ctxRaw) } : {}),
                    };
                }
              }
            } catch {
              /* ignore */
            }
            // Curated catalog. Names match real model ids accepted by their
            // respective providers. Free tier flagged so the dropdown can
            // surface them.
            // Comprehensive catalog reflecting what Hermes can integrate
            // with as of v0.13. Groups by provider (OpenAI / Anthropic /
            // Google / OpenRouter / xAI / Mistral / Ollama / Cohere).
            // Tiers: frontier (Mythos-class, effort dial), top, mid
            // (default), cheap (fast/small), free (no-cost tier).
            const catalog = [
              {
                provider: "openai",
                models: [
                  { name: "gpt-5.6-sol", tier: "frontier" },
                  { name: "gpt-5.6-terra", tier: "top" },
                  { name: "gpt-5.6-luna", tier: "cheap" },
                  { name: "gpt-5.5", tier: "top" },
                  { name: "gpt-5.5-pro", tier: "top" },
                  { name: "gpt-5.3-codex", tier: "mid" },
                  { name: "gpt-5.4-nano", tier: "cheap" },
                ],
              },
              {
                provider: "anthropic",
                models: [
                  { name: "claude-fable-5", tier: "frontier" },
                  { name: "claude-opus-4.8", tier: "top" },
                  { name: "claude-sonnet-4.6", tier: "mid" },
                  { name: "claude-haiku-4.5", tier: "cheap" },
                ],
              },
              {
                provider: "googlegemini",
                models: [
                  { name: "gemini-3.1-pro", tier: "top" },
                  { name: "gemini-3.5-flash", tier: "mid" },
                  { name: "gemini-3.1-flash-lite", tier: "cheap" },
                ],
              },
              {
                // OpenRouter is the universal router — these are the current
                // best, verified against the live OpenRouter catalog (2026-06).
                provider: "openrouter",
                models: [
                  { name: "anthropic/claude-fable-5", tier: "frontier" }, // verified live 2026-07-04 · 1M ctx · $10/$50
                  { name: "z-ai/glm-5.2", tier: "top" }, // best GLM — 1M ctx
                  { name: "anthropic/claude-opus-4.8", tier: "top" },
                  { name: "anthropic/claude-sonnet-5", tier: "top" }, // launched 2026-06-30 · 1M ctx · $2/$10
                  { name: "openai/gpt-5.6-sol", tier: "frontier" }, // GPT-5.6 Sol · 1.05M ctx · $5/$30
                  { name: "openai/gpt-5.6-terra", tier: "top" }, // balanced · $2.50/$15
                  { name: "openai/gpt-5.6-luna", tier: "cheap" }, // fast/cheap · $1/$6
                  { name: "openai/gpt-5.5", tier: "top" },
                  { name: "deepseek/deepseek-v4-pro", tier: "top" },
                  { name: "x-ai/grok-4.5", tier: "top" }, // verified live 2026-07-18 · 500k ctx · $2/$6
                  { name: "x-ai/grok-4.3", tier: "mid" },
                  { name: "google/gemini-3.5-flash", tier: "mid" },
                  { name: "minimax/minimax-m3", tier: "mid" },
                  { name: "qwen/qwen3.7-plus", tier: "mid" },
                  { name: "moonshotai/kimi-k3", tier: "top" }, // verified live 2026-07-18 · 1M ctx · $3/$15
                  { name: "moonshotai/kimi-k2.6", tier: "mid" },
                  { name: "deepseek/deepseek-v4-flash", tier: "cheap" },
                  { name: "z-ai/glm-4.7-flash", tier: "cheap" },
                  { name: "meta-llama/llama-3.3-70b-instruct:free", tier: "free" },
                ],
              },
              // OAuth / subscription providers — only surface when the user has
              // them configured (so it's zero marginal cost on an existing plan,
              // e.g. GPT-5.5 on a ChatGPT sub, Grok on an X sub).
              {
                provider: "openai-codex",
                models: [
                  // GPT-5.6 "Sol" family (GA 2026-07-09). Sol = frontier planner,
                  // Terra = balanced middle lane (half Sol's price), Luna = cheap
                  // throughput. Bare slugs as accepted by the openai-codex provider.
                  { name: "gpt-5.6-sol", tier: "frontier" },
                  { name: "gpt-5.6-terra", tier: "top" },
                  { name: "gpt-5.6-luna", tier: "cheap" },
                  { name: "gpt-5.5", tier: "top" },
                  { name: "gpt-5.5-pro", tier: "top" },
                  { name: "gpt-5.3-codex", tier: "mid" },
                ],
              },
              {
                provider: "xai-oauth",
                models: [
                  { name: "grok-4.5", tier: "top" }, // xAI flagship (2026-07)
                  { name: "grok-4.3", tier: "mid" },
                  { name: "grok-4", tier: "mid" },
                ],
              },
              {
                provider: "minimax",
                models: [{ name: "minimax-m3", tier: "top" }],
              },
              {
                provider: "sakana",
                models: [
                  { name: "fugu-ultra", tier: "top" },
                  { name: "fugu", tier: "mid" },
                ],
              },
              {
                provider: "xai",
                models: [
                  { name: "grok-4.5", tier: "top" }, // xAI flagship (2026-07)
                  { name: "grok-4.3", tier: "mid" },
                  { name: "grok-4", tier: "mid" },
                ],
              },
              {
                provider: "mistral",
                models: [
                  { name: "mistral-large-3", tier: "top" },
                  { name: "mistral-small-3", tier: "cheap" },
                ],
              },
              {
                provider: "ollama",
                models: [
                  { name: "llama3.3", tier: "free" },
                  { name: "qwen3", tier: "free" },
                  { name: "deepseek-r1", tier: "free" },
                ],
              },
              {
                provider: "groq",
                models: [{ name: "llama-3.3-70b-versatile", tier: "mid" }],
              },
              {
                provider: "cohere",
                models: [{ name: "command-a", tier: "top" }],
              },
            ];
            // Surface the user's Mixture-of-Agents presets so the chat's model
            // selector can offer them as first-class "blends" — selecting one
            // runs `hermes chat -m <preset> --provider moa`. Read from the same
            // config.yaml; fail soft if it's absent or malformed.
            let mixtures: Array<{ name: string; references: number; aggregator?: string }> = [];
            try {
              const cfgPath2 = join(homedir(), ".hermes", "config.yaml");
              if (existsSync(cfgPath2)) {
                const cfg = yaml.load(readFileSync(cfgPath2, "utf-8")) as any;
                const presets = cfg?.moa?.presets;
                if (presets && typeof presets === "object") {
                  mixtures = Object.entries(presets).map(([name, p]: [string, any]) => ({
                    name,
                    references: Array.isArray(p?.reference_models) ? p.reference_models.length : 0,
                    // Full expert model names so the chat can credit the
                    // whole ensemble under a Ministry reply.
                    referenceModels: Array.isArray(p?.reference_models)
                      ? p.reference_models.map((r: any) => String(r?.model ?? "")).filter(Boolean)
                      : [],
                    aggregator: p?.aggregator?.model ? String(p.aggregator.model) : undefined,
                  }));
                }
              }
            } catch {
              /* no MoA presets — fine */
            }
            // Which providers does the user ACTUALLY have credentials for? The
            // model picker hides catalog groups for unconfigured providers, so a
            // pick can never fail with "Unknown provider 'x'". Sources: the
            // configured default, auth.json OAuth providers, ~/.hermes/.env
            // API-key vars, and any custom providers in config.yaml. (If none are
            // detected, the UI falls back to showing everything.)
            const configured = new Set<string>();
            if (defaultModel?.provider) configured.add(defaultModel.provider.toLowerCase());
            // NOTE: deliberately NOT auto-unlocking the anthropic group off
            // Claude Code's OAuth credentials — Hermes borrowing that token
            // can invalidate Claude Code's own session (single-use refresh
            // tokens; same failure mode as the Hermes↔Codex OAuth conflict).
            // Claude models route through OpenRouter instead
            // (anthropic/claude-fable-5 etc.); the anthropic group only
            // appears when the user sets a real ANTHROPIC_API_KEY.
            try {
              const authPath = join(homedir(), ".hermes", "auth.json");
              if (existsSync(authPath)) {
                const j = JSON.parse(readFileSync(authPath, "utf-8"));
                for (const k of Object.keys(j?.providers ?? {})) configured.add(k.toLowerCase());
              }
            } catch {
              /* ignore */
            }
            try {
              const envPath = join(homedir(), ".hermes", ".env");
              if (existsSync(envPath)) {
                const env = readFileSync(envPath, "utf-8");
                const ENV_MAP: Record<string, string> = {
                  OPENROUTER_API_KEY: "openrouter",
                  // NOTE: no OPENAI_API_KEY → "openai" mapping. That env var is
                  // how the VOICE engine stores its key, and Hermes has no bare
                  // 'openai' provider ("Unknown provider 'openai'", exit 1) —
                  // GPT models route via openai-codex (OAuth) or openrouter.
                  ANTHROPIC_API_KEY: "anthropic",
                  GEMINI_API_KEY: "googlegemini",
                  GOOGLE_API_KEY: "googlegemini",
                  GOOGLEAI_API_KEY: "googlegemini",
                  XAI_API_KEY: "xai",
                  GROK_API_KEY: "xai",
                  MISTRAL_API_KEY: "mistral",
                  GROQ_API_KEY: "groq",
                  COHERE_API_KEY: "cohere",
                  DEEPSEEK_API_KEY: "deepseek",
                  MINIMAX_API_KEY: "minimax",
                  NVIDIA_API_KEY: "nvidia",
                };
                for (const [varName, prov] of Object.entries(ENV_MAP)) {
                  if (new RegExp(`^\\s*${varName}\\s*=\\s*\\S`, "m").test(env)) {
                    configured.add(prov);
                  }
                }
              }
            } catch {
              /* ignore */
            }
            // Hermes' global reasoning-effort knob (agent.reasoning_effort in
            // config.yaml) — surfaced so the chat composer can render the
            // effort dial with the real current value.
            let reasoningEffort = "";
            try {
              const cfg = yaml.load(
                readFileSync(join(homedir(), ".hermes", "config.yaml"), "utf-8"),
              ) as any;
              for (const k of Object.keys(cfg?.providers ?? {})) configured.add(k.toLowerCase());
              reasoningEffort = String(cfg?.agent?.reasoning_effort ?? "")
                .trim()
                .toLowerCase();
            } catch {
              /* ignore */
            }
            // Which paid lanes are usable right now — see the `laneHealth`
            // note on /__claude_models. Only lanes we can actually CHECK get an
            // `ok: true`: openai-codex has a credential file to look at, and
            // an OAuth provider Hermes lists in auth.json has told us it is
            // configured. Everything else is reported not-ok, which shows the
            // metered entry rather than hiding the only working copy.
            const laneHealth: Record<string, { ok: boolean; reason?: string }> = {
              "openai-codex": codexLaneHealth(),
            };
            for (const p of configured) {
              if (p === "openai-codex" || !p.includes("oauth")) continue;
              const failed = laneAuthFailure(p);
              laneHealth[p] = failed ? { ok: false, reason: failed } : { ok: true };
            }
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(
              JSON.stringify({
                default: defaultModel,
                catalog,
                mixtures,
                configured: Array.from(configured),
                reasoningEffort,
                laneHealth,
              }),
            );
          });

          // POST /__hermes_effort — set Hermes' global reasoning effort
          // (agent.reasoning_effort in ~/.hermes/config.yaml). Hermes reads
          // config fresh on every `hermes chat -Q` invocation, so the new
          // level applies from the next message. The write is a surgical
          // line replacement inside the `agent:` block — never a full YAML
          // re-dump, so the rest of the user's config is untouched byte-for-
          // byte. Token-gated + loopback only.
          server.middlewares.use("/__hermes_effort", (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const token = req.headers["x-claude-os-token"];
            if (token !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
              let effort: string;
              try {
                effort = String(JSON.parse(body)?.effort ?? "")
                  .trim()
                  .toLowerCase();
              } catch {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "invalid json" }));
                return;
              }
              // Hermes' canonical levels (see hermes_cli/main.py).
              if (!["minimal", "low", "medium", "high", "xhigh"].includes(effort)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "unknown effort level" }));
                return;
              }
              try {
                const cfgPath = join(homedir(), ".hermes", "config.yaml");
                const text = readFileSync(cfgPath, "utf-8");
                // Find the top-level `agent:` block and swap (or insert) its
                // reasoning_effort line. Anchored to the block so the same
                // key in other blocks (e.g. subagents) is never touched.
                const block = text.match(/^agent:\n((?:[ \t]+.+\n)+)/m);
                if (!block) throw new Error("no agent block in config.yaml");
                let inner = block[1];
                if (/^[ \t]+reasoning_effort:.*$/m.test(inner)) {
                  inner = inner.replace(
                    /^([ \t]+)reasoning_effort:.*$/m,
                    `$1reasoning_effort: ${effort}`,
                  );
                } else {
                  const indent = inner.match(/^([ \t]+)/)?.[1] ?? "  ";
                  inner = `${indent}reasoning_effort: ${effort}\n` + inner;
                }
                // Replacer fn so `$` sequences in config values are literal.
                writeFileSync(
                  cfgPath,
                  text.replace(block[0], () => `agent:\n${inner}`),
                  "utf-8",
                );
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, effort }));
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err?.message ?? "write failed" }));
              }
            });
          });

          // POST /__hermes_cmd — run a DETERMINISTIC, whitelisted Hermes
          // sub-command (NO model call) and return sanitized output. Powers the
          // chat's "commands" strip (Insights / Status / Version) — the real,
          // non-hallucinated equivalents of the interactive slash commands
          // (which can't run through `hermes chat -Q -q`). Only a fixed
          // allow-list runs; never user-supplied argv. Loopback + token gated.
          // Output is sanitized (home path → ~, API-key fragments masked, ANSI
          // stripped) so nothing sensitive lands on screen / in a screen-record.
          server.middlewares.use("/__hermes_cmd", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            if (req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "bad token" }));
              return;
            }
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
              let cmd = "";
              try {
                cmd = String(JSON.parse(body || "{}").cmd || "");
              } catch {
                cmd = "";
              }
              const ALLOW: Record<string, { args: string[]; timeout: number }> = {
                version: { args: ["version"], timeout: 20_000 },
                status: { args: ["status"], timeout: 25_000 },
                insights: { args: ["insights", "--days", "30"], timeout: 30_000 },
                doctor: { args: ["doctor"], timeout: 60_000 },
                // Mutating: pulls latest + reinstalls deps. Auto-confirm (the
                // user clicked it) and let Hermes keep its default backup.
                update: { args: ["update", "--yes"], timeout: 300_000 },
              };
              const entry = ALLOW[cmd];
              if (!entry) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "unknown command" }));
                return;
              }
              const verbArgs = entry.args;
              const home = homedir();
              const hermesRoot = join(home, ".hermes", "hermes-agent");
              const hermesPython = venvBin(join(hermesRoot, "venv"), "python");
              const hermesMain = join(hermesRoot, "hermes_cli", "main.py");
              const useSrc = existsSync(hermesPython) && existsSync(hermesMain);
              const binPath = useSrc ? hermesPython : resolveCliBin("hermes");
              if (!binPath) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: "hermes binary not found" }));
                return;
              }
              const args = useSrc ? [hermesMain, ...verbArgs] : [...verbArgs];
              const env: NodeJS.ProcessEnv = {
                ...process.env,
                PYTHONUNBUFFERED: "1",
                NO_COLOR: "1",
                TERM: "dumb",
              };
              delete env.PYTHONPATH;
              delete env.PYTHONHOME;
              let out = "";
              let done = false;
              let timedOut = false;
              const child = spawn(binPath, args, { cwd: home, env });
              const killer = setTimeout(() => {
                timedOut = true;
                try {
                  child.kill("SIGKILL");
                } catch {
                  /* already gone */
                }
              }, entry.timeout);
              child.stdout.on("data", (b: Buffer) => (out += b.toString("utf-8")));
              child.stderr.on("data", (b: Buffer) => (out += b.toString("utf-8")));
              child.on("error", (e) => {
                if (done) return;
                done = true;
                clearTimeout(killer);
                res.statusCode = 500;
                res.end(JSON.stringify({ error: String((e as any)?.message || e) }));
              });
              child.on("close", (code) => {
                if (done) return;
                done = true;
                clearTimeout(killer);
                if (timedOut) {
                  // A killed command (esp. `update --yes`) must NOT report success
                  // with partial output — the install may be half-applied.
                  res.statusCode = 504;
                  res.end(
                    JSON.stringify({
                      error: `hermes ${cmd} timed out after ${Math.round(
                        entry.timeout / 1000,
                      )}s and was stopped${
                        cmd === "update"
                          ? " — the update may be partially applied; finish it from a terminal with `hermes update`"
                          : ""
                      }.`,
                    }),
                  );
                  return;
                }
                // Redact-by-default: these outputs surface real account state and
                // may be screen-recorded, so strip anything credential- or
                // identity-shaped rather than denylisting one key prefix.
                const realHome = (() => {
                  try {
                    return realpathSync(home);
                  } catch {
                    return home;
                  }
                })();
                const clean = out
                  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") // strip ANSI / CSI sequences
                  .split(home)
                  .join("~")
                  .split(realHome)
                  .join("~") // symlink-resolved home → ~ too
                  // messaging / account identifiers, e.g. "(home: 7058871166)"
                  .replace(/\((home|chat|id|user|channel|account)\s*:\s*[^)]+\)/gi, "($1: •••)")
                  // explicit credential pairs: api_key/token/secret/password/bearer = <value>
                  .replace(
                    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|token|bearer)\b(\s*[:=]\s*)["']?[^\s"'\n]{4,}/gi,
                    "$1$2••••",
                  )
                  // a "✓ <token-ish>" value (anything but a status word) → configured
                  .replace(
                    /(✓\s+)(?!configured|exists|logged|enabled|active|valid|ready|installed|running|set\b|on\b|yes\b|ok\b)[A-Za-z0-9][A-Za-z0-9._-]{3,}(\.\.\.[A-Za-z0-9]+)?/gi,
                    "$1configured",
                  )
                  // known token shapes anywhere (OpenAI, Slack, GitHub, Google, JWT…)
                  .replace(
                    /\b(sk-[a-z]+-|sk-|xox[bapr]-|gh[pousr]_|AIza|ya29\.|eyJ)[A-Za-z0-9._\-/+]{4,}/g,
                    "••••",
                  )
                  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
                  // long opaque token runs (base64 / hex / JWT segments)
                  .replace(/\b[A-Za-z0-9_-]{28,}\b/g, "••••")
                  .trimEnd();
                res.end(JSON.stringify({ ok: true, cmd, output: clean || "(no output)", code }));
              });
            });
          });

          // GET /__hermes_pantheon_sync — per-persona git sync status.
          //
          // Architecture: personas live at ~/.hermes/pantheon/personas/
          // (NOT a git repo). The Hermes "Take Hermes anywhere" flow
          // rsyncs ~/.hermes/ into a mirror dir (default ~/code/hermes-mirror/)
          // and pushes THAT to GitHub. So sync status = "does the mirror's
          // pantheon/personas/<id>.yaml byte-match the source AND is the
          // mirror clean + pushed?"
          //
          // Mirror path resolution (in order):
          //   1. $HERMES_MIRROR env var
          //   2. ~/.hermes/.mirror_path marker file (one line, absolute path)
          //   3. ~/code/hermes-mirror/ (the default the install prompt uses)
          //
          // Classification (mapped to the frontend's existing 4 states):
          //   synced    = source matches mirror, mirror clean, at or behind upstream
          //   dirty     = source differs from mirror, OR mirror has uncommitted changes
          //   untracked = persona missing from mirror entirely
          //   no_repo   = no mirror configured
          // Loopback only.
          server.middlewares.use("/__hermes_pantheon_sync", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            // 5s cache — short because GHSyncStepCard's Copy click polls
            // every 5s for 90s expecting badges to flip green. 5s TTL
            // means each poll hits the cache once then recomputes — fast
            // enough to feel live, slow enough to not thrash git on every
            // tick.
            if (sendCached("hermes-pantheon-sync", res)) return;
            const out: Record<string, "synced" | "dirty" | "untracked" | "no_repo"> = {};

            // List source personas first — these are what we're checking sync for.
            let sourceFiles: string[] = [];
            try {
              if (existsSync(pantheonDir)) {
                sourceFiles = readdirSync(pantheonDir).filter((f) => f.endsWith(".yaml"));
              }
            } catch {
              /* ignore */
            }

            // Resolve mirror path.
            let mirrorRoot = process.env.HERMES_MIRROR ?? "";
            if (!mirrorRoot) {
              try {
                const markerPath = join(homedir(), ".hermes", ".mirror_path");
                if (existsSync(markerPath)) {
                  mirrorRoot = readFileSync(markerPath, "utf-8").trim();
                }
              } catch {
                /* ignore */
              }
            }
            if (!mirrorRoot) {
              mirrorRoot = join(homedir(), "code", "hermes-mirror");
            }
            const mirrorGit = join(mirrorRoot, ".git");
            const mirrorPersonas = join(mirrorRoot, "pantheon", "personas");

            // No mirror configured → every persona is no_repo.
            if (!existsSync(mirrorGit)) {
              for (const f of sourceFiles) {
                out[f.replace(/\.yaml$/, "")] = "no_repo";
              }
              const body = JSON.stringify({ statuses: out, hasRepo: false, mirrorRoot });
              storeCached("hermes-pantheon-sync", 5000, body);
              res.setHeader("Content-Type", "application/json");
              res.setHeader("X-Cache", "MISS");
              res.end(body);
              return;
            }

            // Check whether the mirror has uncommitted changes in pantheon/.
            let mirrorDirty = false;
            const dirtyMirrorIds = new Set<string>();
            const untrackedMirrorIds = new Set<string>();
            try {
              const porcelain = execSync("git status --porcelain pantheon/personas/", {
                cwd: mirrorRoot,
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 3000,
              });
              for (const line of porcelain.split("\n")) {
                if (!line) continue;
                const flag = line.slice(0, 2);
                const path = line.slice(3).trim();
                const m = path.match(/pantheon\/personas\/([a-z0-9_-]+)\.yaml/i);
                if (!m) continue;
                const id = m[1];
                if (flag.includes("?")) untrackedMirrorIds.add(id);
                else dirtyMirrorIds.add(id);
                mirrorDirty = true;
              }
            } catch {
              /* leave defaults */
            }

            // Compare each source file byte-for-byte against the mirror copy.
            for (const f of sourceFiles) {
              const id = f.replace(/\.yaml$/, "");
              const srcPath = join(pantheonDir, f);
              const mirrorPath = join(mirrorPersonas, f);
              if (!existsSync(mirrorPath)) {
                out[id] = "untracked";
                continue;
              }
              let same = false;
              try {
                same = readFileSync(srcPath, "utf-8") === readFileSync(mirrorPath, "utf-8");
              } catch {
                /* treat as different */
              }
              if (!same) {
                out[id] = "dirty";
                continue;
              }
              if (dirtyMirrorIds.has(id) || untrackedMirrorIds.has(id)) {
                out[id] = "dirty";
                continue;
              }
              out[id] = "synced";
            }

            const body = JSON.stringify({
              statuses: out,
              hasRepo: true,
              mirrorRoot,
              mirrorDirty,
            });
            storeCached("hermes-pantheon-sync", 5000, body);
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("X-Cache", "MISS");
            res.end(body);
          });

          // ────────────────────────────────────────────────────────────────
          // DESIGN STUDIO — a gallery over the images and video you actually
          // generate. Higgsfield and friends keep nothing on this machine, so
          // there is no single feed to subscribe to; what exists is output
          // scattered across project folders. These two endpoints do the
          // unglamorous half of that: find the media, then serve one file.
          //
          // Roots are read from ~/.claude-os/config.json → design.roots, so
          // the user nominates their own folders. We default to a small,
          // deliberately conservative set rather than sweeping all of $HOME.
          const DESIGN_EXT = new Set([
            ".png",
            ".jpg",
            ".jpeg",
            ".webp",
            ".gif",
            ".avif",
            ".svg",
            ".mp4",
            ".mov",
            ".webm",
            ".m4v",
          ]);
          const DESIGN_VIDEO = new Set([".mp4", ".mov", ".webm", ".m4v"]);
          const designReferenceDir = () => join(homedir(), ".claude-os", "design", "references");
          // Folders that are never design output — build junk, deps, caches,
          // and screen-recording frame dumps (a single ScreenStudio session
          // drops hundreds of stills that would drown a gallery).
          const DESIGN_SKIP_DIR =
            /^(node_modules|\.git|\.next|\.venv|venv|dist|build|out|target|__pycache__|\.cache|coverage|Pods|\.turbo|site-packages)$/i;
          // Tested against a FORWARD-SLASH form of the path. Windows hands us
          // "C:\Users\me\rec\recording", which a /-anchored pattern would never
          // match — so every caller normalises separators first rather than
          // this quietly becoming a macOS-only filter.
          const DESIGN_SKIP_PATH = /\.screenstudio(\/|$)|\/recording(\/|$)|\/graphify-out(\/|$)/i;
          const designPosix = (p: string) => p.replace(/\\/g, "/");

          // Default roots. Windows commonly redirects the shell folders into
          // OneDrive, in which case %USERPROFILE%\Desktop doesn't exist at all
          // — so we offer both and keep whichever is really there.
          function designDefaultRoots(): string[] {
            const home = homedir();
            const names = ["Desktop", "Documents", "Downloads"];
            const bases = [home];
            if (IS_WIN) {
              const od =
                process.env.OneDrive ||
                process.env.OneDriveConsumer ||
                process.env.OneDriveCommercial;
              if (od) bases.push(od);
              bases.push(join(home, "OneDrive"));
            }
            const out: string[] = [];
            for (const n of names) {
              for (const b of bases) {
                const p = join(b, n);
                if (existsSync(p) && !out.includes(p)) out.push(p);
              }
            }
            return out;
          }

          function designRoots(): string[] {
            try {
              const cfgPath = join(homedir(), ".claude-os", "config.json");
              if (existsSync(cfgPath)) {
                const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
                const roots = cfg?.design?.roots;
                if (Array.isArray(roots) && roots.length) {
                  const picked = roots
                    .filter((r: unknown) => typeof r === "string" && r.trim())
                    .map((r: string) =>
                      r.startsWith("~") ? join(homedir(), r.slice(1)) : resolve(r),
                    )
                    .filter((r: string) => existsSync(r));
                  if (picked.length) return picked;
                }
              }
            } catch {
              /* malformed config — fall through to defaults */
            }
            return designDefaultRoots();
          }

          // What to tell the user when a root won't open. The cause is
          // genuinely different per OS, so a single hardcoded message would be
          // wrong for most people reading it.
          const IS_MACOS_DESIGN = process.platform === "darwin";
          function designPermHint(): string {
            if (IS_MACOS_DESIGN) {
              return "macOS gates ~/Desktop, ~/Documents and ~/Downloads behind Full Disk Access, and the server inherits the permissions of whatever launched it — so a folder you can read in Terminal can still be blocked when the app starts it. Grant access in System Settings → Privacy & Security → Full Disk Access.";
            }
            if (IS_WIN) {
              return "Windows blocked this folder. If it's OneDrive-backed, make sure the files are downloaded rather than online-only, and check Controlled Folder Access under Windows Security → Ransomware protection.";
            }
            return "The server couldn't read this folder. Check its permissions, or point design.roots somewhere readable.";
          }

          // GET /__design_media — walk the nominated roots and return every
          // image/video found, newest first. Bounded on every axis (depth,
          // entries scanned, results returned) so a huge tree can't hang the
          // dev server. Loopback only; read-only.
          server.middlewares.use("/__design_media", (req, res, next) => {
            if (req.method !== "GET") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            try {
              const url = new URL(req.url ?? "", "http://localhost");
              const limit = Math.min(Number(url.searchParams.get("limit")) || 400, 1500);
              const roots = designRoots();
              type Hit = {
                id: string;
                path: string;
                name: string;
                ext: string;
                kind: "image" | "video";
                bytes: number;
                mtime: number;
                project: string;
                root: string;
              };
              const hits: Hit[] = [];
              let scanned = 0;
              const SCAN_CAP = 60_000;
              // Per-root outcome. On macOS the process serving this may not
              // hold Full Disk Access for ~/Desktop or ~/Documents (the
              // dashboard runs under different TCC grants depending on
              // whether it was launched from a terminal or from the app), and
              // readdirSync then throws EPERM on the root itself. Swallowing
              // that silently is the worst option: the gallery just looks
              // small and the user has no idea a whole folder was skipped.
              const rootStatus: Array<{ root: string; found: number; error: string | null }> = [];

              for (const root of roots) {
                const before = hits.length;
                let rootErr: string | null = null;
                const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
                while (stack.length) {
                  if (scanned > SCAN_CAP) break;
                  const { dir, depth } = stack.pop()!;
                  if (DESIGN_SKIP_PATH.test(designPosix(dir))) continue;
                  let entries: import("node:fs").Dirent[];
                  try {
                    entries = readdirSync(dir, { withFileTypes: true });
                  } catch (e: any) {
                    // Only the root failing is worth reporting — a single
                    // unreadable subfolder deep in the tree is noise.
                    if (dir === root)
                      rootErr =
                        e?.code === "EPERM" || e?.code === "EACCES"
                          ? "permission denied"
                          : (e?.code ?? "unreadable");
                    continue;
                  }
                  for (const e of entries) {
                    if (scanned++ > SCAN_CAP) break;
                    if (e.name.startsWith(".")) continue;
                    const full = join(dir, e.name);
                    if (e.isDirectory()) {
                      if (DESIGN_SKIP_DIR.test(e.name)) continue;
                      if (depth < 4) stack.push({ dir: full, depth: depth + 1 });
                      continue;
                    }
                    if (!e.isFile()) continue;
                    const dot = e.name.lastIndexOf(".");
                    if (dot < 0) continue;
                    const ext = e.name.slice(dot).toLowerCase();
                    if (!DESIGN_EXT.has(ext)) continue;
                    let st: import("node:fs").Stats;
                    try {
                      st = statSync(full);
                    } catch {
                      continue;
                    }
                    // Sub-8KB files are almost always icons/spacers, not work.
                    if (st.size < 8_000) continue;
                    // Label folders with forward slashes on every OS so the
                    // filter dropdown reads the same on Windows as it does
                    // here, and matches how design.roots is documented.
                    const rel = designPosix(full.slice(root.length + 1));
                    const slash = rel.lastIndexOf("/");
                    hits.push({
                      id: Buffer.from(full).toString("base64url"),
                      path: full,
                      name: e.name,
                      ext,
                      kind: DESIGN_VIDEO.has(ext) ? "video" : "image",
                      bytes: st.size,
                      mtime: st.mtimeMs,
                      project: slash > 0 ? rel.slice(0, slash) : "(root)",
                      root,
                    });
                  }
                }
                rootStatus.push({ root, found: hits.length - before, error: rootErr });
              }

              hits.sort((a, b) => b.mtime - a.mtime);
              const items = hits.slice(0, limit);
              // Project facets for the filter rail, biggest first.
              const byProject = new Map<string, number>();
              for (const h of hits) byProject.set(h.project, (byProject.get(h.project) ?? 0) + 1);
              const projects = [...byProject.entries()]
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count);

              res.setHeader("Cache-Control", "no-store");
              res.end(
                JSON.stringify({
                  ok: true,
                  roots,
                  rootStatus,
                  permHint: designPermHint(),
                  total: hits.length,
                  returned: items.length,
                  truncated: hits.length > items.length,
                  scanCapped: scanned > SCAN_CAP,
                  projects,
                  // `path` rides along: the client needs the real, native-
                  // separator path for "Copy path", and rebuilding it in the
                  // browser means hardcoding a separator that's wrong on one
                  // OS or the other. It's no more disclosure than `id`, which
                  // is just this string base64'd — and this is loopback-only
                  // on the user's own machine.
                  items,
                }),
              );
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err?.message ?? "scan failed" }));
            }
          });

          // GET /__design_file?id=<base64url path> — stream one media file.
          // The id is the absolute path, but we never trust it: it must
          // resolve inside one of the configured roots, or we refuse. Same
          // containment rule as /__memory_note.
          server.middlewares.use("/__design_file", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end("loopback only");
              return;
            }
            try {
              const url = new URL(req.url ?? "", "http://localhost");
              const raw = url.searchParams.get("id") ?? "";
              if (!raw) {
                res.statusCode = 400;
                res.end("missing id");
                return;
              }
              let filePath: string;
              try {
                filePath = Buffer.from(raw, "base64url").toString("utf-8");
              } catch {
                res.statusCode = 400;
                res.end("bad id");
                return;
              }
              // Resolve symlinks BEFORE the containment check so a symlink
              // inside a root can't point out of it.
              let real: string;
              try {
                real = realpathSync(resolve(filePath));
              } catch {
                res.statusCode = 404;
                res.end("not found");
                return;
              }
              const roots = designRoots().map((r) => {
                try {
                  return realpathSync(r);
                } catch {
                  return r;
                }
              });
              let inside = roots.some((r) => real === r || real.startsWith(r + sep));
              try {
                const referenceRoot = realpathSync(designReferenceDir());
                inside = inside || real === referenceRoot || real.startsWith(referenceRoot + sep);
              } catch {
                /* the folder does not exist until the first upload */
              }
              // Ledger-listed assets are servable wherever they live — agents
              // write into project folders the scan roots don't cover, and an
              // agent-reported path is exactly as trusted as a scanned one.
              // Compared post-realpath on both sides, so a symlinked ledger
              // entry can't smuggle a different file through.
              if (!inside) {
                inside = readDesignLedger().some((e) => {
                  try {
                    return realpathSync(e.path) === real;
                  } catch {
                    return false;
                  }
                });
              }
              if (!inside) {
                res.statusCode = 403;
                res.end("outside configured roots");
                return;
              }
              const ext = real.slice(real.lastIndexOf(".")).toLowerCase();
              if (!DESIGN_EXT.has(ext)) {
                res.statusCode = 403;
                res.end("unsupported type");
                return;
              }
              const MIME: Record<string, string> = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".webp": "image/webp",
                ".gif": "image/gif",
                ".avif": "image/avif",
                ".svg": "image/svg+xml",
                ".mp4": "video/mp4",
                ".mov": "video/quicktime",
                ".webm": "video/webm",
                ".m4v": "video/x-m4v",
              };
              const st = statSync(real);
              res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
              res.setHeader("Content-Length", String(st.size));
              res.setHeader("Cache-Control", "private, max-age=300");
              const stream = createReadStream(real);
              // The open happens async, so a file statSync could see but the
              // process can't READ (macOS TCC: metadata is allowed, content
              // isn't) errors here — not in the try/catch. Without this
              // handler that was an uncaught exception and a response that
              // never ended: every blocked thumbnail held its connection open
              // forever instead of falling back to a placeholder.
              stream.on("error", () => {
                if (!res.headersSent) {
                  res.statusCode = 403;
                  res.end("unreadable (permissions)");
                } else {
                  res.destroy();
                }
              });
              stream.pipe(res);
            } catch (err: any) {
              res.statusCode = 500;
              res.end(err?.message ?? "read failed");
            }
          });

          // ────────────────────────────────────────────────────────────────
          // THE LEDGER — ~/.claude-os/design/ledger.jsonl. The disk scan
          // above answers "what media exists"; the ledger answers the better
          // question, "what did my agents MAKE" — appended the moment a file
          // lands, by a Claude Code PostToolUse hook and a Hermes skill
          // (scripts/install-design-capture.ts arms both). Each line carries
          // provenance the filesystem can't: which agent, which session, and
          // the prompt that asked for it.
          type LedgerEntry = {
            ts: number;
            path: string;
            agent: string;
            tool?: string;
            kind: "image" | "video";
            bytes: number;
            session?: string | null;
            cwd?: string | null;
            prompt?: string | null;
            backfill?: boolean;
            model?: string | null;
            look?: string | null;
            params?: Record<string, unknown>;
            w?: number;
            h?: number;
            costUsd?: number | null;
            costCredits?: number | null;
            costSource?: string | null;
            jobId?: string | null;
          };
          const designLedgerPath = () => join(homedir(), ".claude-os", "design", "ledger.jsonl");
          // Parsed-ledger cache keyed on file mtime — /__design_file consults
          // this on EVERY thumbnail request for its containment check, and
          // re-parsing a few hundred JSON lines per image would be silly.
          let ledgerCache: { mtimeMs: number; entries: LedgerEntry[] } | null = null;
          function readDesignLedger(): LedgerEntry[] {
            const p = designLedgerPath();
            let st: import("node:fs").Stats;
            try {
              st = statSync(p);
            } catch {
              ledgerCache = null;
              return [];
            }
            if (ledgerCache && ledgerCache.mtimeMs === st.mtimeMs) return ledgerCache.entries;
            const entries: LedgerEntry[] = [];
            try {
              for (const line of readFileSync(p, "utf-8").split("\n")) {
                if (!line.trim()) continue;
                try {
                  const e = JSON.parse(line);
                  if (typeof e?.path === "string" && typeof e?.ts === "number") entries.push(e);
                } catch {
                  /* one bad line shouldn't sink the ledger */
                }
              }
            } catch {
              return [];
            }
            // Newest first, deduped by path (an asset regenerated in place
            // keeps only its latest record).
            entries.sort((a, b) => b.ts - a.ts);
            const seen = new Set<string>();
            const deduped = entries.filter((e) =>
              seen.has(e.path) ? false : (seen.add(e.path), true),
            );
            ledgerCache = { mtimeMs: st.mtimeMs, entries: deduped };
            return deduped;
          }

          // GET /__design_ledger — every asset an agent has reported, newest
          // first, re-stat'd so deleted files show as gone instead of 404ing
          // out of the grid.
          server.middlewares.use("/__design_ledger", (req, res, next) => {
            if (req.method !== "GET") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            try {
              const entries = readDesignLedger().slice(0, 500);
              const items = entries.map((e) => {
                let alive = false,
                  bytes = e.bytes ?? 0,
                  mtime = e.ts;
                try {
                  const st = statSync(e.path);
                  alive = st.isFile();
                  bytes = st.size;
                  mtime = st.mtimeMs;
                } catch {
                  /* deleted since capture */
                }
                return {
                  id: Buffer.from(e.path).toString("base64url"),
                  path: e.path,
                  name: e.path.slice(designPosix(e.path).lastIndexOf("/") + 1),
                  agent:
                    e.agent === "hermes" ? "hermes" : e.agent === "studio" ? "studio" : "claude",
                  tool: e.tool ?? null,
                  kind: e.kind === "video" ? "video" : "image",
                  ts: e.ts,
                  bytes,
                  mtime,
                  alive,
                  session: e.session ?? null,
                  cwd: e.cwd ?? null,
                  prompt: typeof e.prompt === "string" && e.prompt.trim() ? e.prompt.trim() : null,
                  backfill: Boolean(e.backfill),
                  model: typeof e.model === "string" ? e.model : null,
                  look: typeof e.look === "string" ? e.look : null,
                  params: e.params && typeof e.params === "object" ? e.params : {},
                  w: typeof e.w === "number" ? e.w : null,
                  h: typeof e.h === "number" ? e.h : null,
                  costUsd: typeof e.costUsd === "number" ? e.costUsd : null,
                  costCredits: typeof e.costCredits === "number" ? e.costCredits : null,
                  costSource: typeof e.costSource === "string" ? e.costSource : null,
                  jobId: typeof e.jobId === "string" ? e.jobId : null,
                  references: Array.isArray(e.references)
                    ? e.references
                        .filter((reference: unknown): reference is string =>
                          Boolean(typeof reference === "string" && reference),
                        )
                        .slice(0, 8)
                        .map((reference: string) => ({
                          id: Buffer.from(reference).toString("base64url"),
                          path: reference,
                          name: reference.slice(designPosix(reference).lastIndexOf("/") + 1),
                          alive: existsSync(reference),
                        }))
                    : [],
                };
              });
              const byAgent = { claude: 0, hermes: 0, studio: 0 };
              for (const i of items) byAgent[i.agent as "claude" | "hermes" | "studio"]++;
              res.setHeader("Cache-Control", "no-store");
              res.end(
                JSON.stringify({
                  ok: true,
                  ledger: designLedgerPath(),
                  armed: existsSync(join(homedir(), ".claude-os", "design", "capture.mjs")),
                  total: items.length,
                  byAgent,
                  items,
                }),
              );
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err?.message ?? "ledger read failed" }));
            }
          });

          // GET /__design_skills — the generation skills installed for each
          // agent, so the Create tab can offer "pick a skill, write the ask"
          // instead of a bare prompt box pretending to be Claude Design.
          // Frontmatter-only read: name + description, never the body.
          server.middlewares.use("/__design_skills", (req, res, next) => {
            if (req.method !== "GET") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const GEN_HINT =
              /image|video|visual|design|infograph|thumbnail|photo|\bart\b|anim|render|creative|diagram|logo|poster|banner|comic|pixel|sketch|illustrat|manim|gif|scroll-stop|higgsfield|mascot/i;
            // Skills ABOUT videos aren't skills that MAKE media — a script/
            // retention/report skill mentioning "video" or "design" in passing
            // shouldn't crowd the Create tab with things that output prose.
            const GEN_VETO =
              /\bscripts?\b|\bintro\b|retention|title generator|storytelling|\bmetaphor\b|weekly|\breport\b/i;
            const frontmatter = (
              file: string,
            ): { name: string | null; description: string | null } => {
              try {
                // Generously sized: several real skills carry frontmatter
                // descriptions long enough that a small head-slice cuts the
                // closing --- off and silently drops the skill.
                const head = readFileSync(file, "utf-8").slice(0, 8000);
                const m = head.match(/^---\n([\s\S]*?)\n---/);
                if (!m) return { name: null, description: null };
                const pick = (key: string) => {
                  const mm = m[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
                  return mm ? mm[1].trim().replace(/^["']|["']$/g, "") : null;
                };
                return { name: pick("name"), description: pick("description") };
              } catch {
                return { name: null, description: null };
              }
            };
            try {
              type SkillCard = {
                agent: "claude" | "hermes";
                name: string;
                description: string;
                invoke: string;
              };
              const skills: SkillCard[] = [];
              // Claude Code: ~/.claude/skills/<name>/SKILL.md, flat.
              const claudeRoot = join(homedir(), ".claude", "skills");
              if (existsSync(claudeRoot)) {
                for (const d of readdirSync(claudeRoot, { withFileTypes: true })) {
                  // Dirent.isDirectory() is false for SYMLINKED skills — and
                  // marketplace-installed skills are exactly that. The
                  // SKILL.md existence check (which follows links) is the
                  // real gate; a plain file can't pass it.
                  if (d.isFile()) continue;
                  const md = join(claudeRoot, d.name, "SKILL.md");
                  if (!existsSync(md)) continue;
                  const fm = frontmatter(md);
                  const desc = fm.description ?? "";
                  if (!GEN_HINT.test(`${d.name} ${desc}`) || GEN_VETO.test(desc)) continue;
                  skills.push({
                    agent: "claude",
                    name: fm.name ?? d.name,
                    description: desc.length > 220 ? `${desc.slice(0, 217)}…` : desc,
                    invoke: `/${fm.name ?? d.name}`,
                  });
                }
              }
              // Hermes: ~/.hermes/skills/<category>/<name>/SKILL.md, nested.
              const hermesRoot = join(homedir(), ".hermes", "skills");
              if (existsSync(hermesRoot)) {
                for (const cat of readdirSync(hermesRoot, { withFileTypes: true })) {
                  if (cat.isFile()) continue;
                  let inner: import("node:fs").Dirent[];
                  try {
                    inner = readdirSync(join(hermesRoot, cat.name), { withFileTypes: true });
                  } catch {
                    continue;
                  }
                  for (const d of inner) {
                    if (d.isFile()) continue;
                    const md = join(hermesRoot, cat.name, d.name, "SKILL.md");
                    if (!existsSync(md)) continue;
                    const fm = frontmatter(md);
                    const desc = fm.description ?? "";
                    if (d.name === "design-ledger") continue; // plumbing, not a tool to pitch
                    if (!GEN_HINT.test(`${cat.name} ${d.name} ${desc}`) || GEN_VETO.test(desc))
                      continue;
                    skills.push({
                      agent: "hermes",
                      name: fm.name ?? d.name,
                      description: desc.length > 220 ? `${desc.slice(0, 217)}…` : desc,
                      invoke: `/${fm.name ?? d.name}`,
                    });
                  }
                }
              }
              skills.sort((a, b) => a.name.localeCompare(b.name));
              res.setHeader("Cache-Control", "no-store");
              res.end(JSON.stringify({ ok: true, total: skills.length, skills }));
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err?.message ?? "skill scan failed" }));
            }
          });

          // ────────────────────────────────────────────────────────────────
          // THE STUDIO — generate right here, on the user's own API keys.
          // Not a rebuild of anyone's canvas: the composer sits ON the
          // provenance gallery, the model picker mirrors what the key can
          // actually serve (live from the provider, not a hardcoded menu),
          // and every generation lands in the same ledger as agent builds.
          const DESIGN_KEY_FILES = [
            join(homedir(), ".hermes", ".env"),
            join(homedir(), ".claude-os", ".env.local"),
            join(homedir(), ".config", "jack-keys.env"),
          ];
          // Every engine Design can generate through. Key-auth engines resolve
          // their key from config.json -> env -> the dotenv haunts; Higgsfield
          // signs in via its own CLI so it has no key at all.
          const DESIGN_ENGINE_ENV: Record<string, string> = {
            openrouter: "OPENROUTER_API_KEY",
            kie: "KIE_API_KEY",
            fal: "FAL_KEY",
            replicate: "REPLICATE_API_TOKEN",
            openai: "OPENAI_API_KEY",
          };
          type DesignKeySource = "settings" | "environment" | "key_file" | null;
          function designApiKeyInfo(provider: string): {
            key: string | null;
            source: DesignKeySource;
          } {
            const envName = DESIGN_ENGINE_ENV[provider] ?? "";
            // 1. the dashboard's own config (what "Connect" writes)
            try {
              const cfg = JSON.parse(
                readFileSync(join(homedir(), ".claude-os", "config.json"), "utf-8"),
              );
              const k = cfg?.design?.keys?.[provider];
              if (typeof k === "string" && k.trim()) return { key: k.trim(), source: "settings" };
            } catch {
              /* no config yet */
            }
            // Kie's CLI-era key file predates this config store; honour it.
            if (provider === "kie") {
              try {
                const k = readFileSync(join(homedir(), ".config", "kie", "key"), "utf-8").trim();
                if (k) return { key: k, source: "key_file" };
              } catch {
                /* absent */
              }
            }
            if (!envName) return { key: null, source: null };
            // 2. the process env, 3. the usual dotenv haunts
            if (process.env[envName]) return { key: process.env[envName]!, source: "environment" };
            for (const f of DESIGN_KEY_FILES) {
              try {
                const m = readFileSync(f, "utf-8").match(
                  new RegExp(`^\\s*${envName}\\s*=\\s*"?([^"\\n\\r]+)"?\\s*$`, "m"),
                );
                if (m?.[1]?.trim()) return { key: m[1].trim(), source: "environment" };
              } catch {
                /* file absent */
              }
            }
            return { key: null, source: null };
          }
          function designApiKey(provider: string): string | null {
            return designApiKeyInfo(provider).key;
          }

          // Higgsfield auth rides the CLI, not a key. A binary on PATH is not
          // the same thing as a connected account, so verify the local OAuth
          // token too. The provider menu can force a fresh check after login.
          let higgsCache: { at: number; ok: boolean } | null = null;
          function higgsfieldReady(force = false): boolean {
            if (!force && higgsCache && Date.now() - higgsCache.at < 30_000) return higgsCache.ok;
            let ok = false;
            try {
              const bin = resolveCliBin("higgsfield");
              if (!bin) throw new Error("Higgsfield CLI not found");
              execFileSync(bin, ["--version"], {
                stdio: ["ignore", "ignore", "ignore"],
                timeout: 5000,
                env: {
                  ...process.env,
                  PATH: `${process.env.PATH}:${join(homedir(), ".local", "bin")}`,
                },
              });
              execFileSync(bin, ["auth", "token"], {
                stdio: ["ignore", "ignore", "ignore"],
                timeout: 5000,
                env: {
                  ...process.env,
                  PATH: `${process.env.PATH}:${join(homedir(), ".local", "bin")}`,
                },
              });
              ok = true;
            } catch {
              ok = false;
            }
            higgsCache = { at: Date.now(), ok };
            return ok;
          }

          function runDesignCli(
            cmd: string,
            args: string[],
            timeoutMs: number,
            signal?: AbortSignal,
          ): Promise<{ out: string; code: number }> {
            return new Promise((done) => {
              if (signal?.aborted) {
                done({ out: "Generation cancelled", code: 130 });
                return;
              }
              const child = spawn(cmd, args, {
                stdio: ["ignore", "pipe", "pipe"],
                env: {
                  ...process.env,
                  PATH: `${process.env.PATH}:${join(homedir(), ".local", "bin")}`,
                },
              });
              let out = "";
              let errOut = "";
              let finished = false;
              const finish = (result: { out: string; code: number }) => {
                if (finished) return;
                finished = true;
                clearTimeout(t);
                signal?.removeEventListener("abort", abort);
                done(result);
              };
              child.stdout.on("data", (c) => {
                out += c;
              });
              child.stderr.on("data", (c) => {
                errOut += c;
              });
              const abort = () => {
                child.kill("SIGTERM");
                const killTimer = setTimeout(() => child.kill("SIGKILL"), 1_500);
                killTimer.unref();
                finish({ out: "Generation cancelled", code: 130 });
              };
              const t = setTimeout(() => {
                child.kill("SIGKILL");
                finish({ out: "Command timed out", code: 124 });
              }, timeoutMs);
              signal?.addEventListener("abort", abort, { once: true });
              if (signal?.aborted) abort();
              child.on("close", (code) => {
                finish({ out: out.trim() || errOut.trim(), code: code ?? 1 });
              });
              child.on("error", () => {
                finish({ out: errOut.trim() || "spawn failed", code: 127 });
              });
            });
          }

          function designAbortError(): Error {
            const error = new Error("Generation cancelled");
            error.name = "AbortError";
            return error;
          }

          function throwIfDesignAborted(signal?: AbortSignal): void {
            if (signal?.aborted) throw designAbortError();
          }

          function designRequestSignal(signal: AbortSignal | undefined, timeoutMs: number) {
            const timeoutSignal = AbortSignal.timeout(timeoutMs);
            if (!signal) return timeoutSignal;
            const signalClass = AbortSignal as typeof AbortSignal & {
              any?: (signals: AbortSignal[]) => AbortSignal;
            };
            if (signalClass.any) return signalClass.any([signal, timeoutSignal]);
            const controller = new AbortController();
            const abort = () => controller.abort();
            signal.addEventListener("abort", abort, { once: true });
            timeoutSignal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
            return controller.signal;
          }

          function designDelay(ms: number, signal?: AbortSignal): Promise<void> {
            return new Promise((resolve, reject) => {
              throwIfDesignAborted(signal);
              const timer = setTimeout(() => {
                signal?.removeEventListener("abort", abort);
                resolve();
              }, ms);
              const abort = () => {
                clearTimeout(timer);
                reject(designAbortError());
              };
              signal?.addEventListener("abort", abort, { once: true });
              if (signal?.aborted) abort();
            });
          }

          // Some providers CDN-block non-browser agents; a browser UA is the
          // difference between a download and a 403.
          const DESIGN_UA =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
          async function downloadAsset(
            url: string,
            timeoutMs = 300_000,
            signal?: AbortSignal,
          ): Promise<Buffer> {
            const r = await fetch(url, {
              headers: { "User-Agent": DESIGN_UA },
              signal: designRequestSignal(signal, timeoutMs),
            });
            if (!r.ok) throw new Error(`asset download HTTP ${r.status}`);
            return Buffer.from(await r.arrayBuffer());
          }
          const mediaExt = (url: string, fallback: string) => {
            const e = String(url).split("?")[0].split(".").pop()?.toLowerCase() ?? "";
            return /^(png|jpg|jpeg|webp|gif|mp4|webm|mov)$/.test(e) ? e : fallback;
          };

          // Real pixel dimensions, read from the file's own header. Beats
          // predicting them from a quality tier: engines distribute a "2k"
          // budget across the aspect ratio in ways only they know.
          function imageSize(buf: Buffer): { w: number; h: number } | null {
            try {
              // PNG: IHDR width/height at a fixed offset.
              if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
                return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
              }
              // WebP (VP8X / VP8L / VP8).
              if (
                buf.length > 30 &&
                buf.toString("ascii", 0, 4) === "RIFF" &&
                buf.toString("ascii", 8, 12) === "WEBP"
              ) {
                const fmt = buf.toString("ascii", 12, 16);
                if (fmt === "VP8X")
                  return {
                    w: (buf.readUIntLE(24, 3) & 0xffffff) + 1,
                    h: (buf.readUIntLE(27, 3) & 0xffffff) + 1,
                  };
                if (fmt === "VP8 ")
                  return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
                if (fmt === "VP8L") {
                  const b = buf.readUInt32LE(21);
                  return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
                }
              }
              // JPEG: walk the segments to the first start-of-frame.
              if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
                let i = 2;
                while (i + 9 < buf.length) {
                  if (buf[i] !== 0xff) {
                    i++;
                    continue;
                  }
                  const marker = buf[i + 1];
                  // SOF0..SOF15, skipping the non-frame markers in that range.
                  if (
                    marker >= 0xc0 &&
                    marker <= 0xcf &&
                    marker !== 0xc4 &&
                    marker !== 0xc8 &&
                    marker !== 0xcc
                  ) {
                    return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
                  }
                  i += 2 + buf.readUInt16BE(i + 2);
                }
              }
            } catch {
              /* unknown shape — say nothing rather than guess */
            }
            return null;
          }

          function saveGeneration(opts: {
            buf: Buffer;
            ext: string;
            prompt: string;
            engine: string;
            model: string;
            kind: "image" | "video";
            look: string | null;
            params?: Record<string, unknown>;
            costUsd?: number | null;
            costCredits?: number | null;
            costSource?: string | null;
            jobId?: string | null;
            references?: string[];
          }): { id: string; path: string } {
            const genDir = join(homedir(), ".claude-os", "design", "generations");
            mkdirSync(genDir, { recursive: true });
            const slug =
              opts.prompt
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "")
                .slice(0, 40) || "generation";
            // Concurrent batch items can land in the same millisecond with the
            // same slug, so the name carries its own entropy.
            const p = join(
              genDir,
              `${Date.now()}-${slug}-${randomBytes(3).toString("hex")}.${opts.ext}`,
            );
            writeFileSync(p, opts.buf);
            appendFileSync(
              designLedgerPath(),
              JSON.stringify({
                ts: Date.now(),
                path: p,
                agent: "studio",
                tool: opts.engine,
                kind: opts.kind,
                bytes: opts.buf.length,
                session: null,
                cwd: genDir,
                prompt: opts.prompt,
                model: opts.model,
                look: opts.look,
                params: opts.params ?? {},
                costUsd: opts.costUsd ?? null,
                costCredits: opts.costCredits ?? null,
                costSource: opts.costSource ?? null,
                jobId: opts.jobId ?? null,
                references: opts.references ?? [],
                ...(opts.kind === "image" ? (imageSize(opts.buf) ?? {}) : {}),
              }) + "\n",
            );
            return { id: Buffer.from(p).toString("base64url"), path: p };
          }

          // Model menus for the engines whose catalogs aren't queryable
          // keylessly. Prices are approximate, shown as a hint only.
          type ParamSpec = {
            name: string;
            type: "string" | "integer" | "boolean";
            default: unknown;
            required: boolean;
            enum?: string[];
          };
          type DesignPriceLine = {
            billable: string;
            unit: string;
            costUsd: number;
            variant?: string | null;
            provider?: string | null;
          };
          type EngineModel = {
            id: string;
            label: string;
            kind: "image" | "video";
            perUnit: number | null;
            params?: ParamSpec[];
            pricing?: DesignPriceLine[];
            pricingSource?: "live" | "estimate" | "unavailable";
          };

          // Static catalogs for the engines whose model lists aren't
          // introspectable. Param specs mirror what each API actually
          // accepts — the UI renders its controls FROM these, so a control
          // can never offer a setting the model would reject.
          const ENGINE_STATIC_MODELS: Record<string, EngineModel[]> = {
            openai: [
              {
                id: "gpt-image-2",
                label: "GPT Image 2",
                kind: "image",
                perUnit: null,
                pricingSource: "estimate",
                pricing: [
                  { billable: "output_image", unit: "token", costUsd: 0.00003, provider: "OpenAI" },
                ],
                params: [
                  {
                    name: "quality",
                    type: "string",
                    default: "high",
                    required: false,
                    enum: ["low", "medium", "high"],
                  },
                  {
                    name: "aspect_ratio",
                    type: "string",
                    default: "1:1",
                    required: false,
                    enum: ["1:1", "3:2", "2:3"],
                  },
                ],
              },
            ],
            fal: [
              {
                id: "fal-ai/flux-pro/v1.1",
                label: "FLUX 1.1 Pro",
                kind: "image",
                perUnit: 0.04,
                pricingSource: "estimate",
                params: [
                  {
                    name: "aspect_ratio",
                    type: "string",
                    default: "16:9",
                    required: false,
                    enum: ["1:1", "3:2", "2:3", "4:3", "3:4", "9:16", "16:9", "21:9"],
                  },
                ],
              },
            ],
            replicate: [
              {
                id: "black-forest-labs/flux-1.1-pro",
                label: "FLUX 1.1 Pro",
                kind: "image",
                perUnit: 0.04,
                pricingSource: "estimate",
                params: [
                  {
                    name: "aspect_ratio",
                    type: "string",
                    default: "16:9",
                    required: false,
                    enum: ["1:1", "3:2", "2:3", "4:3", "3:4", "9:16", "16:9", "21:9"],
                  },
                ],
              },
            ],
          };

          // Kie publishes one live catalogue across many model makers. Keep it
          // fresh and only expose prompt/reference driven image and video
          // generators that this composer can actually call.
          type KiePricingRow = {
            modelDescription?: string;
            interfaceType?: string;
            provider?: string;
            creditUnit?: string;
            usdPrice?: string | number;
            anchor?: string;
          };
          const KIE_MODEL_PATHS_URL = "https://api.kie.ai/api/v1/playground/model-paths";
          const KIE_PRICING_URL = "https://api.kie.ai/client/v1/model-pricing/page";
          const KIE_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "9:16", "16:9", "21:9"];
          const KIE_FALLBACK_MODELS: EngineModel[] = [
            {
              id: "nano-banana-2",
              label: "Nano Banana 2",
              kind: "image",
              perUnit: 0.04,
              pricingSource: "estimate",
              pricing: [
                {
                  billable: "output_image",
                  unit: "image",
                  costUsd: 0.04,
                  variant: "1k",
                  provider: "Google",
                },
                {
                  billable: "output_image",
                  unit: "image",
                  costUsd: 0.06,
                  variant: "2k",
                  provider: "Google",
                },
                {
                  billable: "output_image",
                  unit: "image",
                  costUsd: 0.09,
                  variant: "4k",
                  provider: "Google",
                },
              ],
              params: [
                {
                  name: "resolution",
                  type: "string",
                  default: "2K",
                  required: false,
                  enum: ["1K", "2K", "4K"],
                },
                {
                  name: "aspect_ratio",
                  type: "string",
                  default: "16:9",
                  required: false,
                  enum: KIE_RATIOS,
                },
                {
                  name: "output_format",
                  type: "string",
                  default: "png",
                  required: false,
                  enum: ["png", "jpeg"],
                },
              ],
            },
            {
              id: "gpt-image-2-text-to-image",
              label: "GPT Image 2 · Text to Image",
              kind: "image",
              perUnit: 0.03,
              pricingSource: "estimate",
              params: [
                {
                  name: "resolution",
                  type: "string",
                  default: "2K",
                  required: false,
                  enum: ["1K", "2K", "4K"],
                },
                {
                  name: "aspect_ratio",
                  type: "string",
                  default: "1:1",
                  required: false,
                  enum: KIE_RATIOS,
                },
              ],
            },
            {
              id: "seedream/5-pro-text-to-image",
              label: "Seedream 5 Pro · Text to Image",
              kind: "image",
              perUnit: 0.035,
              pricingSource: "estimate",
              params: [
                {
                  name: "quality",
                  type: "string",
                  default: "high",
                  required: false,
                  enum: ["basic", "high"],
                },
                {
                  name: "aspect_ratio",
                  type: "string",
                  default: "16:9",
                  required: false,
                  enum: KIE_RATIOS,
                },
                {
                  name: "output_format",
                  type: "string",
                  default: "png",
                  required: false,
                  enum: ["png", "jpeg"],
                },
              ],
            },
            {
              id: "bytedance/seedance-2-5",
              label: "Seedance 2.5",
              kind: "video",
              perUnit: null,
              pricingSource: "unavailable",
              params: [
                {
                  name: "resolution",
                  type: "string",
                  default: "720p",
                  required: false,
                  enum: ["480p", "720p", "1080p"],
                },
                {
                  name: "aspect_ratio",
                  type: "string",
                  default: "16:9",
                  required: false,
                  enum: ["16:9", "9:16", "1:1", "4:3", "21:9"],
                },
                { name: "duration", type: "integer", default: 5, required: false },
                { name: "generate_audio", type: "boolean", default: false, required: false },
              ],
            },
          ];
          let kieModelCache: { at: number; models: EngineModel[] } | null = null;
          let kiePricingCache: { at: number; rows: KiePricingRow[] } | null = null;

          function kieModelKind(id: string): "image" | "video" | null {
            const model = id.trim().toLowerCase();
            if (!model) return null;
            if (
              /audio|music|tts|speech|voice|lyrics|midi|lip-sync|watermark|upscale|remove-background|refiner|layer-decomposition|subject-detection|human-identification|avatar|extend|transition|videoedit|video-edit|motion-control/.test(
                model,
              )
            )
              return null;
            if (
              /text-to-video|image-to-video|reference-to-video|\br2v\b|seedance|veo-3-1|kling-3\.0\/video|grok-imagine-video|gemini-omni-video|^runway$|sora-2/.test(
                model,
              )
            )
              return "video";
            if (
              /text-to-image|image-to-image|image-edit|nano-banana|gpt-image|imagen4|seedream|z-image|flux|ideogram|4o-image|wan\/2-7-image|qwen\/image-edit|google\/nano-banana/.test(
                model,
              )
            )
              return "image";
            return null;
          }

          const KIE_LABELS: Record<string, string> = {
            "nano-banana-2": "Nano Banana 2",
            "nano-banana-2-lite": "Nano Banana 2 Lite",
            "nano-banana-pro": "Nano Banana Pro",
            "google/nano-banana": "Nano Banana",
            "google/nano-banana-edit": "Nano Banana · Edit",
            "gpt-image-2-text-to-image": "GPT Image 2 · Text to Image",
            "gpt-image-2-image-to-image": "GPT Image 2 · Image to Image",
            "bytedance/seedance-2-5": "Seedance 2.5",
            "bytedance/seedance-2": "Seedance 2.0",
            "bytedance/seedance-2-fast": "Seedance 2.0 Fast",
            "bytedance/seedance-2-mini": "Seedance 2.0 Mini",
            "veo-3-1": "Veo 3.1",
            "kling-3.0/video": "Kling 3.0",
            "gemini-omni-video": "Gemini Omni Video",
            "4o-image-api": "4o Image",
          };

          function kieModelLabel(id: string): string {
            if (KIE_LABELS[id]) return KIE_LABELS[id];
            const words = id
              .replaceAll("/", " · ")
              .replaceAll("-", " ")
              .split(/\s+/)
              .filter(Boolean)
              .map((word) => {
                const lower = word.toLowerCase();
                if (["gpt", "ai", "api"].includes(lower)) return lower.toUpperCase();
                if (/^v\d/.test(lower)) return lower.toUpperCase();
                return lower.slice(0, 1).toUpperCase() + lower.slice(1);
              });
            return words.join(" ").replaceAll(" · ", " · ");
          }

          function kieModelParams(id: string): ParamSpec[] {
            const model = id.toLowerCase();
            if (/nano-banana-2|nano-banana-pro/.test(model)) {
              return [
                {
                  name: "resolution",
                  type: "string",
                  default: "2K",
                  required: false,
                  enum: ["1K", "2K", "4K"],
                },
                {
                  name: "aspect_ratio",
                  type: "string",
                  default: "16:9",
                  required: false,
                  enum: KIE_RATIOS,
                },
                {
                  name: "output_format",
                  type: "string",
                  default: "png",
                  required: false,
                  enum: ["png", "jpeg"],
                },
              ];
            }
            if (/gpt-image-2/.test(model)) {
              return [
                {
                  name: "resolution",
                  type: "string",
                  default: "2K",
                  required: false,
                  enum: ["1K", "2K", "4K"],
                },
                {
                  name: "aspect_ratio",
                  type: "string",
                  default: "1:1",
                  required: false,
                  enum: KIE_RATIOS,
                },
              ];
            }
            if (/seedream\/5-pro/.test(model)) {
              return [
                {
                  name: "quality",
                  type: "string",
                  default: "high",
                  required: false,
                  enum: ["basic", "high"],
                },
                {
                  name: "aspect_ratio",
                  type: "string",
                  default: "16:9",
                  required: false,
                  enum: KIE_RATIOS,
                },
                {
                  name: "output_format",
                  type: "string",
                  default: "png",
                  required: false,
                  enum: ["png", "jpeg"],
                },
              ];
            }
            if (/qwen3/.test(model)) {
              return [
                {
                  name: "resolution",
                  type: "string",
                  default: "2K",
                  required: false,
                  enum: ["1K", "2K"],
                },
                {
                  name: "image_size",
                  type: "string",
                  default: "1:1",
                  required: false,
                  enum: KIE_RATIOS,
                },
                {
                  name: "output_format",
                  type: "string",
                  default: "png",
                  required: false,
                  enum: ["png", "jpeg"],
                },
              ];
            }
            if (/flux-2/.test(model)) {
              return [
                {
                  name: "resolution",
                  type: "string",
                  default: "1K",
                  required: false,
                  enum: ["1K", "2K"],
                },
                {
                  name: "aspect_ratio",
                  type: "string",
                  default: "1:1",
                  required: false,
                  enum: KIE_RATIOS,
                },
              ];
            }
            if (/seedance-2-5/.test(model)) {
              return [
                {
                  name: "resolution",
                  type: "string",
                  default: "720p",
                  required: false,
                  enum: ["480p", "720p", "1080p"],
                },
                {
                  name: "aspect_ratio",
                  type: "string",
                  default: "16:9",
                  required: false,
                  enum: ["16:9", "9:16", "1:1", "4:3", "21:9"],
                },
                { name: "duration", type: "integer", default: 5, required: false },
                { name: "generate_audio", type: "boolean", default: false, required: false },
              ];
            }
            if (/seedance/.test(model)) {
              return [
                {
                  name: "resolution",
                  type: "string",
                  default: "720p",
                  required: false,
                  enum: ["480p", "720p", "1080p"],
                },
                {
                  name: "aspect_ratio",
                  type: "string",
                  default: "16:9",
                  required: false,
                  enum: ["16:9", "9:16", "1:1", "4:3", "21:9"],
                },
                { name: "duration", type: "integer", default: 5, required: false },
                { name: "generate_audio", type: "boolean", default: false, required: false },
              ];
            }
            if (kieModelKind(model) === "video") {
              return [
                {
                  name: "aspect_ratio",
                  type: "string",
                  default: "16:9",
                  required: false,
                  enum: ["16:9", "9:16", "1:1"],
                },
                { name: "duration", type: "integer", default: 5, required: false },
              ];
            }
            // Unknown image models still generate safely with their provider
            // defaults. Do not invent controls their API may reject.
            return [];
          }

          function normalizeKiePriceText(value: string): string {
            return value
              .toLowerCase()
              .replace(/[^a-z0-9.]+/g, " ")
              .trim();
          }

          async function kiePricingRows(): Promise<KiePricingRow[]> {
            if (kiePricingCache && Date.now() - kiePricingCache.at < 3_600_000)
              return kiePricingCache.rows;
            const fetchPage = async (pageNum: number) => {
              const response = await fetch(KIE_PRICING_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json", "User-Agent": DESIGN_UA },
                body: JSON.stringify({ pageNum, pageSize: 100 }),
                signal: AbortSignal.timeout(20_000),
              });
              if (!response.ok) throw new Error(`Kie pricing returned HTTP ${response.status}`);
              const payload = (await response.json()) as {
                data?: { pages?: number; records?: KiePricingRow[] };
              };
              return {
                pages: Math.max(1, Number(payload?.data?.pages) || 1),
                rows: Array.isArray(payload?.data?.records) ? payload.data.records : [],
              };
            };
            try {
              const first = await fetchPage(1);
              const rest =
                first.pages > 1
                  ? await Promise.all(
                      Array.from({ length: first.pages - 1 }, (_, index) => fetchPage(index + 2)),
                    )
                  : [];
              const rows = [...first.rows, ...rest.flatMap((page) => page.rows)];
              kiePricingCache = { at: Date.now(), rows };
              return rows;
            } catch {
              return kiePricingCache?.rows ?? [];
            }
          }

          function kiePriceLines(
            modelId: string,
            kind: "image" | "video",
            rows: KiePricingRow[],
          ): DesignPriceLine[] {
            const wanted = normalizeKiePriceText(modelId);
            const wantedTail = normalizeKiePriceText(modelId.split("/").at(-1) ?? modelId);
            const matched = rows.filter((row) => {
              const description = normalizeKiePriceText(String(row.modelDescription ?? ""));
              let linkedModel = "";
              let linkedSlug = "";
              try {
                const url = new URL(String(row.anchor ?? ""));
                linkedModel = normalizeKiePriceText(url.searchParams.get("model") ?? "");
                linkedSlug = normalizeKiePriceText(
                  url.pathname.split("/").filter(Boolean).at(-1) ?? "",
                );
              } catch {
                /* a missing/partial anchor can still match its description */
              }
              if (linkedModel) return linkedModel === wanted;
              if (linkedSlug === wanted || linkedSlug === wantedTail) return true;
              // A more specific page slug means this is a sibling model. For
              // example nano-banana-2-lite must not leak into nano-banana-2.
              if (linkedSlug && linkedSlug.includes(wantedTail)) return false;
              return description.includes(wanted);
            });
            const lines: DesignPriceLine[] = [];
            for (const row of matched) {
              const description = String(row.modelDescription ?? "");
              if (/\binput\b/i.test(description) && !/\boutput\b/i.test(description)) continue;
              const costUsd = Number(row.usdPrice);
              if (!Number.isFinite(costUsd) || costUsd < 0) continue;
              const rawUnit = String(row.creditUnit ?? "")
                .toLowerCase()
                .trim();
              const unit = rawUnit.includes("per image")
                ? "image"
                : rawUnit.includes("per second")
                  ? "second"
                  : rawUnit.includes("per video") || rawUnit.includes("per vedio")
                    ? "video"
                    : rawUnit.includes("per request")
                      ? kind === "image"
                        ? "image"
                        : "video"
                      : null;
              if (!unit) continue;
              lines.push({
                billable: kind === "image" ? "output_image" : "output_video",
                unit,
                costUsd,
                variant: description.toLowerCase(),
                provider: row.provider ?? "Kie.ai",
              });
            }
            return lines.filter(
              (line, index, all) =>
                all.findIndex(
                  (candidate) =>
                    candidate.unit === line.unit &&
                    candidate.costUsd === line.costUsd &&
                    candidate.variant === line.variant,
                ) === index,
            );
          }

          async function kieModels(): Promise<EngineModel[]> {
            if (kieModelCache && Date.now() - kieModelCache.at < 3_600_000)
              return kieModelCache.models;
            try {
              const [catalogResponse, priceRows] = await Promise.all([
                fetch(KIE_MODEL_PATHS_URL, {
                  headers: { "User-Agent": DESIGN_UA },
                  signal: AbortSignal.timeout(20_000),
                }),
                kiePricingRows(),
              ]);
              if (!catalogResponse.ok)
                throw new Error(`Kie catalogue returned HTTP ${catalogResponse.status}`);
              const payload = (await catalogResponse.json()) as { data?: unknown[] };
              const paths = Array.isArray(payload?.data) ? payload.data : [];
              const seen = new Set<string>();
              const models: EngineModel[] = [];
              for (const raw of paths) {
                const id = String(raw ?? "").trim();
                if (!id || seen.has(id)) continue;
                const kind = kieModelKind(id);
                if (!kind) continue;
                seen.add(id);
                const pricing = kiePriceLines(id, kind, priceRows);
                const imageRates = pricing.filter((line) => line.unit === "image");
                models.push({
                  id,
                  label: kieModelLabel(id),
                  kind,
                  perUnit: imageRates.length
                    ? Math.min(...imageRates.map((line) => line.costUsd))
                    : null,
                  params: kieModelParams(id),
                  pricing,
                  pricingSource: pricing.length ? "live" : "unavailable",
                });
              }
              const preferred = [
                "nano-banana-2",
                "gpt-image-2-text-to-image",
                "seedream/5-pro-text-to-image",
                "flux-2/pro-text-to-image",
                "qwen3/pro-text-to-image",
                "bytedance/seedance-2-5",
                "bytedance/seedance-2",
                "kling-3.0/video",
                "veo-3-1",
                "sora-2-pro-text-to-video",
              ];
              models.sort((a, b) => {
                const ai = preferred.indexOf(a.id);
                const bi = preferred.indexOf(b.id);
                if (ai >= 0 || bi >= 0) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
                return a.label.localeCompare(b.label);
              });
              if (models.length) {
                kieModelCache = { at: Date.now(), models };
                return models;
              }
            } catch {
              /* use the hand-checked core list below */
            }
            return kieModelCache?.models ?? KIE_FALLBACK_MODELS;
          }

          // ── Higgsfield introspection ─────────────────────────────────────
          // The CLI publishes its own catalog AND each model's parameter
          // schema. Reading them beats any list I could hardcode: new models
          // show up the day Higgsfield ships them, with the right controls.
          let higgsModelCache: { at: number; models: EngineModel[] } | null = null;
          const higgsSchemaCache = new Map<string, ParamSpec[]>();

          async function higgsfieldModels(): Promise<EngineModel[]> {
            if (higgsModelCache && Date.now() - higgsModelCache.at < 3_600_000)
              return higgsModelCache.models;
            if (!higgsfieldReady()) return [];
            const r = await runDesignCli("higgsfield", ["model", "list", "--json"], 20_000);
            if (r.code !== 0) return higgsModelCache?.models ?? [];
            let rows: any[] = [];
            try {
              rows = JSON.parse(r.out);
            } catch {
              return higgsModelCache?.models ?? [];
            }
            const models = rows
              .filter((m) => m?.type === "image" || m?.type === "video")
              .map((m) => ({
                id: String(m.job_type),
                label: String(m.display_name ?? m.job_type),
                kind: m.type as "image" | "video",
                perUnit: null,
                pricingSource: "unavailable" as const,
              }));
            // Lead each kind with the models actually worth reaching for.
            const PREF = [
              "nano_banana_pro",
              "nano_banana_flash",
              "gpt_image_2",
              "seedream_v5_pro",
              "flux_2",
              "seedance_2_0",
              "seedance_2_5",
              "kling3_0",
              "veo3_1",
            ];
            models.sort((a, b) => {
              const ai = PREF.indexOf(a.id),
                bi = PREF.indexOf(b.id);
              return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
            });
            if (models.length) higgsModelCache = { at: Date.now(), models };
            return models;
          }

          async function higgsfieldSchema(jobType: string): Promise<ParamSpec[]> {
            const hit = higgsSchemaCache.get(jobType);
            if (hit) return hit;
            const r = await runDesignCli("higgsfield", ["model", "get", jobType, "--json"], 20_000);
            if (r.code !== 0) return [];
            let parsed: any = null;
            try {
              parsed = JSON.parse(r.out);
            } catch {
              return [];
            }
            // Reference/media params need an upload flow the composer doesn't
            // have yet; hide them rather than render a control that can't work.
            const SKIP = /reference|image$|_image$|prompt/i;
            const specs: ParamSpec[] = (parsed?.params ?? [])
              .filter(
                (p: any) =>
                  p?.name &&
                  !SKIP.test(p.name) &&
                  p.type !== "array" &&
                  !String(p.type).includes("object"),
              )
              .map((p: any) => ({
                name: String(p.name),
                type:
                  p.type === "integer" ? "integer" : p.type === "boolean" ? "boolean" : "string",
                default: p.default ?? null,
                required: Boolean(p.required),
                ...(Array.isArray(p.enum) && p.enum.length ? { enum: p.enum.map(String) } : {}),
              }));
            higgsSchemaCache.set(jobType, specs);
            return specs;
          }

          // Every model the composer can drive, per engine.
          async function engineModels(
            engine: string,
            orModels?: EngineModel[],
          ): Promise<EngineModel[]> {
            if (engine === "higgsfield") return higgsfieldModels();
            if (engine === "kie") return kieModels();
            if (engine === "openrouter") return orModels ?? [];
            return ENGINE_STATIC_MODELS[engine] ?? [];
          }

          async function modelSchema(engine: string, model: string): Promise<ParamSpec[]> {
            if (engine === "higgsfield") return higgsfieldSchema(model);
            if (engine === "kie") {
              return (await kieModels()).find((item) => item.id === model)?.params ?? [];
            }
            if (engine === "openrouter") {
              return (await studioModels()).find((m) => m.id === model)?.params ?? [];
            }
            return (ENGINE_STATIC_MODELS[engine] ?? []).find((m) => m.id === model)?.params ?? [];
          }

          // Looks — saved style recipes. The point of generating HERE instead
          // of on the provider's site: the OS knows the house styles.
          const DESIGN_LOOKS: Array<{ id: string; label: string; hint: string; prompt: string }> = [
            {
              id: "parchment",
              label: "Parchment Blueprint",
              hint: "Hand-drawn blueprint on aged parchment — the infographic house style",
              prompt:
                "Hand-drawn engineering blueprint on aged cream parchment paper. The ENTIRE frame is filled edge-to-edge with rich vintage parchment paper texture, and the parchment BLEEDS OFF ALL FOUR EDGES — there is NO lighter rim, NO cream border, NO white margin, NO vignette, NO drop shadow, NO frame around it. Every pixel out to the extreme corners is the same aged parchment. ABSOLUTELY NO transparent background. ABSOLUTELY NO checker pattern. ABSOLUTELY NO white border. Pencil-and-ink linework with subtle wobble, like a Victorian inventor's notebook. Burnt orange (#D97706) is the only color accent — rest in muted earth tones, sepia, dusty blue washes. Hand-lettered all-caps headlines. The parchment shows organic aging, coffee stains and subtle wrinkles — but the edges stay full-bleed, NO torn edges and NO transparency. Solid paper texture from corner to corner.",
            },
          ];
          function allDesignLooks() {
            const looks = [...DESIGN_LOOKS];
            try {
              const cfg = JSON.parse(
                readFileSync(join(homedir(), ".claude-os", "config.json"), "utf-8"),
              );
              for (const l of cfg?.design?.looks ?? []) {
                if (l?.id && l?.prompt && !looks.some((x) => x.id === l.id)) {
                  looks.push({
                    id: String(l.id),
                    label: String(l.label ?? l.id),
                    hint: String(l.hint ?? "custom look"),
                    prompt: String(l.prompt),
                  });
                }
              }
            } catch {
              /* built-ins only */
            }
            return looks;
          }

          // ── per-engine generate adapters ─────────────────────────────────
          async function kieGenerate(
            key: string,
            model: string,
            kind: "image" | "video",
            prompt: string,
            params: Record<string, unknown>,
            signal?: AbortSignal,
          ): Promise<{ buf: Buffer; ext: string }> {
            const KIE = "https://api.kie.ai/api/v1";
            const H = {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
              "User-Agent": DESIGN_UA,
            };
            const create = await fetch(`${KIE}/jobs/createTask`, {
              method: "POST",
              headers: H,
              body: JSON.stringify({ model, input: { prompt, ...params } }),
              signal: designRequestSignal(signal, 60_000),
            });
            const cd: any = await create.json().catch(() => ({}));
            if (!create.ok || cd?.code !== 200 || !cd?.data?.taskId) {
              throw new Error(`Kie createTask refused: ${JSON.stringify(cd).slice(0, 240)}`);
            }
            const tid = cd.data.taskId;
            const deadline = Date.now() + (kind === "video" ? 900_000 : 300_000);
            // A persistent auth or network failure should say so, not masquerade
            // as a timeout six minutes later.
            let pollFails = 0;
            let lastPollError = "";
            while (Date.now() < deadline) {
              await designDelay(8000, signal);
              let info: any = null;
              try {
                const ir = await fetch(`${KIE}/jobs/recordInfo?taskId=${encodeURIComponent(tid)}`, {
                  headers: H,
                  signal: designRequestSignal(signal, 60_000),
                });
                if (ir.status === 401 || ir.status === 403)
                  throw new Error(`Kie rejected the key (HTTP ${ir.status})`);
                info = await ir.json();
                pollFails = 0;
              } catch (e: any) {
                throwIfDesignAborted(signal);
                lastPollError = String(e?.message ?? e).slice(0, 200);
                if (/rejected the key/.test(lastPollError) || ++pollFails >= 5) {
                  throw new Error(`Kie polling failed: ${lastPollError}`);
                }
                continue;
              }
              const st = info?.data?.state;
              if (st === "fail")
                throw new Error(
                  `Kie generation failed: ${info?.data?.failMsg ?? "no reason given"}`,
                );
              if (st === "success") {
                const url = JSON.parse(info.data.resultJson).resultUrls[0];
                return {
                  buf: await downloadAsset(url, 300_000, signal),
                  ext: mediaExt(url, kind === "video" ? "mp4" : "png"),
                };
              }
            }
            throw new Error(
              `Kie generation timed out${lastPollError ? ` (last error: ${lastPollError})` : ""}`,
            );
          }

          async function higgsfieldGenerate(
            model: string,
            kind: "image" | "video",
            prompt: string,
            params: Record<string, unknown>,
            refPaths: string[] = [],
            signal?: AbortSignal,
          ): Promise<{ buf: Buffer; ext: string }> {
            const args = ["generate", "create", model, "--prompt", prompt, "--json"];
            // Local paths are uploaded by the CLI itself.
            for (const p of refPaths) args.push("--image-references", p);
            // The CLI takes each model param as --param-name, dashes for
            // underscores — exactly the names `model get` reports.
            for (const [k, v] of Object.entries(params)) {
              if (v === null || v === undefined || v === "") continue;
              args.push(`--${k.replace(/_/g, "-")}`, String(v));
            }
            const created = await runDesignCli("higgsfield", args, 120_000, signal);
            if (created.code !== 0)
              throw new Error(`higgsfield create failed: ${created.out.slice(0, 240)}`);
            let id = "";
            try {
              const parsed = JSON.parse(created.out);
              id = Array.isArray(parsed) ? String(parsed[0] ?? "") : String(parsed?.id ?? "");
            } catch {
              id = created.out.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0] ?? "";
            }
            if (!id) throw new Error(`higgsfield returned no job id: ${created.out.slice(0, 200)}`);
            throwIfDesignAborted(signal);
            const waited = await runDesignCli(
              "higgsfield",
              ["generate", "wait", id, "--timeout", kind === "video" ? "15m" : "8m", "--json"],
              kind === "video" ? 940_000 : 520_000,
              signal,
            );
            if (waited.code !== 0)
              throw new Error(`higgsfield wait failed: ${waited.out.slice(0, 240)}`);
            const findUrl = (o: any): string | null => {
              if (typeof o === "string")
                return /^https?:\/\//.test(o) && /(png|jpe?g|webp|mp4|webm)(\?|$)/i.test(o)
                  ? o
                  : null;
              if (Array.isArray(o)) {
                for (const v of o) {
                  const u = findUrl(v);
                  if (u) return u;
                }
                return null;
              }
              if (o && typeof o === "object") {
                for (const k of ["result_url", "min_result_url", "url"]) {
                  if (typeof o[k] === "string" && o[k]) return o[k];
                }
                for (const v of Object.values(o)) {
                  const u = findUrl(v);
                  if (u) return u;
                }
              }
              return null;
            };
            let url: string | null = null;
            try {
              url = findUrl(JSON.parse(waited.out));
            } catch {
              url = findUrl(waited.out);
            }
            if (!url)
              throw new Error(
                `higgsfield finished but returned no media url: ${waited.out.slice(0, 200)}`,
              );
            return {
              buf: await downloadAsset(url, 300_000, signal),
              ext: mediaExt(url, kind === "video" ? "mp4" : "png"),
            };
          }

          async function openaiGenerate(
            key: string,
            model: string,
            prompt: string,
            params: Record<string, unknown>,
            signal?: AbortSignal,
          ): Promise<{ buf: Buffer; ext: string }> {
            const ratio = String(params.aspect_ratio ?? "");
            const size =
              ratio === "2:3"
                ? "1024x1536"
                : ratio === "3:2"
                  ? "1536x1024"
                  : ratio === "1:1"
                    ? "1024x1024"
                    : "auto";
            const body: Record<string, unknown> = { model, prompt, size, n: 1 };
            if (params.quality) body.quality = params.quality;
            const r = await fetch("https://api.openai.com/v1/images/generations", {
              method: "POST",
              headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: designRequestSignal(signal, 300_000),
            });
            const d: any = await r.json().catch(() => ({}));
            if (!r.ok)
              throw new Error(
                `OpenAI HTTP ${r.status}: ${String(d?.error?.message ?? JSON.stringify(d)).slice(0, 240)}`,
              );
            const b64 = d?.data?.[0]?.b64_json;
            if (b64) return { buf: Buffer.from(b64, "base64"), ext: "png" };
            const url = d?.data?.[0]?.url;
            if (url)
              return {
                buf: await downloadAsset(url, 300_000, signal),
                ext: mediaExt(url, "png"),
              };
            throw new Error("OpenAI returned no image");
          }

          async function replicateGenerate(
            key: string,
            model: string,
            prompt: string,
            params: Record<string, unknown>,
            signal?: AbortSignal,
          ): Promise<{ buf: Buffer; ext: string }> {
            const r = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                Prefer: "wait=60",
              },
              body: JSON.stringify({ input: { prompt, ...params } }),
              signal: designRequestSignal(signal, 300_000),
            });
            let d: any = await r.json().catch(() => ({}));
            if (!r.ok)
              throw new Error(
                `Replicate HTTP ${r.status}: ${String(d?.detail ?? JSON.stringify(d)).slice(0, 240)}`,
              );
            const cancelUrl = typeof d?.urls?.cancel === "string" ? d.urls.cancel : null;
            const cancelRemote = () => {
              if (!cancelUrl) return;
              void fetch(cancelUrl, {
                method: "POST",
                headers: { Authorization: `Bearer ${key}` },
              }).catch(() => undefined);
            };
            signal?.addEventListener("abort", cancelRemote, { once: true });
            try {
              const started = Date.now();
              while (
                d?.status &&
                !["succeeded", "failed", "canceled"].includes(d.status) &&
                Date.now() - started < 600_000
              ) {
                await designDelay(4000, signal);
                const pr = await fetch(d.urls.get, {
                  headers: { Authorization: `Bearer ${key}` },
                  signal: designRequestSignal(signal, 60_000),
                });
                d = await pr.json();
              }
            } finally {
              signal?.removeEventListener("abort", cancelRemote);
            }
            if (d?.status !== "succeeded")
              throw new Error(
                `Replicate ${d?.status ?? "error"}: ${String(d?.error ?? "").slice(0, 200)}`,
              );
            const out = Array.isArray(d.output) ? d.output[0] : d.output;
            if (typeof out !== "string") throw new Error("Replicate returned no media url");
            return {
              buf: await downloadAsset(out, 300_000, signal),
              ext: mediaExt(out, "png"),
            };
          }

          async function falGenerate(
            key: string,
            model: string,
            prompt: string,
            params: Record<string, unknown>,
            signal?: AbortSignal,
          ): Promise<{ buf: Buffer; ext: string }> {
            const r = await fetch(`https://fal.run/${model}`, {
              method: "POST",
              headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
              body: JSON.stringify({ prompt, ...params }),
              signal: designRequestSignal(signal, 600_000),
            });
            const d: any = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(`fal HTTP ${r.status}: ${JSON.stringify(d).slice(0, 240)}`);
            const url =
              d?.images?.[0]?.url ??
              d?.image?.url ??
              d?.video?.url ??
              (typeof d?.output === "string" ? d.output : null);
            if (!url) throw new Error("fal returned no media url");
            return {
              buf: await downloadAsset(url, 300_000, signal),
              ext: mediaExt(url, "png"),
            };
          }

          // OpenRouter has a dedicated Image API. Its image catalog and its
          // endpoint pricing are separate public endpoints, so pull both and
          // keep the actual billing basis. The general /models `pricing.image`
          // field is INPUT-image pricing and must never be shown as generation
          // cost.
          type StudioModel = {
            id: string;
            label: string;
            perImage: number | null;
            pricing: DesignPriceLine[];
            params: ParamSpec[];
          };
          let studioModelCache: { at: number; models: StudioModel[] } | null = null;
          const STUDIO_FALLBACK: StudioModel[] = [
            {
              id: "google/gemini-3.1-flash-image",
              label: "Gemini 3.1 Flash Image",
              perImage: null,
              pricing: [],
              params: [],
            },
            {
              id: "google/gemini-3-pro-image",
              label: "Gemini 3 Pro Image",
              perImage: null,
              pricing: [],
              params: [],
            },
            {
              id: "google/gemini-2.5-flash-image",
              label: "Gemini 2.5 Flash Image",
              perImage: null,
              pricing: [],
              params: [],
            },
          ];
          function openRouterParams(raw: any): ParamSpec[] {
            if (!raw || typeof raw !== "object") return [];
            return Object.entries(raw)
              .filter(
                ([name, spec]: [string, any]) =>
                  !["n", "input_references", "stream", "seed"].includes(name) &&
                  (spec?.type === "enum" || spec?.type === "boolean"),
              )
              .map(([name, spec]: [string, any]) => {
                const values = Array.isArray(spec?.values) ? spec.values.map(String) : [];
                const preferred =
                  name === "aspect_ratio" && values.includes("16:9")
                    ? "16:9"
                    : name === "resolution" && values.includes("2K")
                      ? "2K"
                      : (values[0] ?? false);
                return {
                  name,
                  type: spec?.type === "boolean" ? ("boolean" as const) : ("string" as const),
                  default: preferred,
                  required: false,
                  ...(values.length ? { enum: values } : {}),
                };
              });
          }
          async function studioModels(): Promise<StudioModel[]> {
            if (studioModelCache && Date.now() - studioModelCache.at < 3_600_000)
              return studioModelCache.models;
            try {
              const r = await fetch("https://openrouter.ai/api/v1/images/models", {
                signal: AbortSignal.timeout(15_000),
              });
              if (!r.ok) throw new Error(`models HTTP ${r.status}`);
              const d: any = await r.json();
              const rows = Array.isArray(d?.data) ? d.data : [];
              const models: StudioModel[] = await Promise.all(
                rows.map(async (m: any) => {
                  const id = String(m.id);
                  let pricing: DesignPriceLine[] = [];
                  try {
                    const endpointPath =
                      typeof m?.endpoints === "string"
                        ? m.endpoints
                        : `/api/v1/images/models/${id}/endpoints`;
                    const er = await fetch(`https://openrouter.ai${endpointPath}`, {
                      signal: AbortSignal.timeout(15_000),
                    });
                    if (er.ok) {
                      const ed: any = await er.json();
                      const seen = new Set<string>();
                      for (const endpoint of ed?.endpoints ?? []) {
                        for (const line of endpoint?.pricing ?? []) {
                          const costUsd = Number(line?.cost_usd);
                          if (!Number.isFinite(costUsd)) continue;
                          const normalized: DesignPriceLine = {
                            billable: String(line.billable ?? "unknown"),
                            unit: String(line.unit ?? "unknown"),
                            costUsd,
                            variant: line?.variant ? String(line.variant) : null,
                            provider: endpoint?.provider_name
                              ? String(endpoint.provider_name)
                              : null,
                          };
                          const key = `${normalized.billable}|${normalized.unit}|${normalized.costUsd}|${normalized.variant ?? ""}`;
                          if (!seen.has(key)) {
                            seen.add(key);
                            pricing.push(normalized);
                          }
                        }
                      }
                    }
                  } catch {
                    /* catalog still works without a rate response */
                  }
                  const imageRates = pricing.filter(
                    (line) => line.billable === "output_image" && line.unit === "image",
                  );
                  return {
                    id,
                    label: String(m.name ?? id).replace(/^[^:]+:\s*/, ""),
                    perImage: imageRates.length
                      ? Math.min(...imageRates.map((line) => line.costUsd))
                      : null,
                    pricing,
                    params: openRouterParams(m?.supported_parameters),
                  };
                }),
              );
              if (models.length) {
                // gemini flash image models are the sensible default tier:
                // cheap, fast, and what most "make me a thumbnail" asks want.
                models.sort(
                  (a, b) => Number(/flash-image$/.test(b.id)) - Number(/flash-image$/.test(a.id)),
                );
                studioModelCache = { at: Date.now(), models };
                return models;
              }
            } catch {
              /* fall through */
            }
            return STUDIO_FALLBACK;
          }

          type DesignBalance = {
            engine: string;
            amount: number;
            unit: "credits" | "usd";
            plan?: string | null;
          };
          const designBalanceCache = new Map<string, { at: number; value: DesignBalance }>();
          async function designBalance(engine: string, force = false): Promise<DesignBalance> {
            const cached = designBalanceCache.get(engine);
            if (!force && cached && Date.now() - cached.at < 60_000) return cached.value;

            let value: DesignBalance;
            if (engine === "higgsfield") {
              if (!higgsfieldReady()) throw new Error("Higgsfield is not connected");
              const result = await runDesignCli(
                "higgsfield",
                ["account", "status", "--json"],
                15_000,
              );
              if (result.code !== 0) throw new Error(result.out || "Higgsfield balance failed");
              const data = JSON.parse(result.out) as {
                credits?: unknown;
                subscription_plan_type?: unknown;
              };
              const amount = Number(data?.credits);
              if (!Number.isFinite(amount)) throw new Error("Higgsfield returned no balance");
              value = {
                engine,
                amount,
                unit: "credits",
                plan: data?.subscription_plan_type ? String(data.subscription_plan_type) : null,
              };
            } else if (engine === "kie") {
              const key = designApiKey("kie");
              if (!key) throw new Error("Kie.ai is not connected");
              const response = await fetch("https://api.kie.ai/api/v1/chat/credit", {
                headers: { Authorization: `Bearer ${key}`, "User-Agent": DESIGN_UA },
                signal: AbortSignal.timeout(15_000),
              });
              if (!response.ok) throw new Error(`Kie balance HTTP ${response.status}`);
              const data = (await response.json()) as { data?: unknown };
              const amount = Number(data?.data);
              if (!Number.isFinite(amount)) throw new Error("Kie returned no balance");
              value = { engine, amount, unit: "credits" };
            } else if (engine === "openrouter") {
              const key = designApiKey("openrouter");
              if (!key) throw new Error("OpenRouter is not connected");
              const headers = { Authorization: `Bearer ${key}` };
              const [creditsResponse, keyResponse] = await Promise.all([
                fetch("https://openrouter.ai/api/v1/credits", {
                  headers,
                  signal: AbortSignal.timeout(15_000),
                }),
                fetch("https://openrouter.ai/api/v1/key", {
                  headers,
                  signal: AbortSignal.timeout(15_000),
                }).catch(() => null),
              ]);
              if (!creditsResponse.ok)
                throw new Error(`OpenRouter balance HTTP ${creditsResponse.status}`);
              const credits = (await creditsResponse.json()) as {
                data?: { total_credits?: unknown; total_usage?: unknown };
              };
              const total = Number(credits?.data?.total_credits);
              const used = Number(credits?.data?.total_usage);
              if (!Number.isFinite(total) || !Number.isFinite(used))
                throw new Error("OpenRouter returned no balance");
              let amount = total - used;
              if (keyResponse?.ok) {
                const keyData = (await keyResponse.json()) as {
                  data?: { limit_remaining?: unknown };
                };
                const keyRemaining = Number(keyData?.data?.limit_remaining);
                if (Number.isFinite(keyRemaining)) amount = Math.min(amount, keyRemaining);
              }
              value = { engine, amount: Math.max(0, amount), unit: "usd" };
            } else {
              throw new Error("This provider does not expose a balance");
            }

            designBalanceCache.set(engine, { at: Date.now(), value });
            return value;
          }

          // GET /__design_providers — every engine Design can fire through:
          // which are connected (never the key itself, only a tail), what
          // each can make, and the Looks the house styles ship as.
          server.middlewares.use("/__design_providers", (req, res, next) => {
            if (req.method !== "GET") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            (async () => {
              const forceCliRefresh =
                new URL(req.url ?? "", "http://localhost").searchParams.get("refresh") === "1";
              const orKey = designApiKey("openrouter");
              const orModels: EngineModel[] = orKey
                ? (await studioModels()).map((m) => ({
                    id: m.id,
                    label: m.label,
                    kind: "image" as const,
                    perUnit: m.perImage,
                    pricing: m.pricing,
                    pricingSource: m.pricing.length ? ("live" as const) : ("unavailable" as const),
                  }))
                : [];
              const keyed = (id: string, label: string) => {
                const info = designApiKeyInfo(id);
                return {
                  id,
                  label,
                  auth: "key" as const,
                  configured: Boolean(info.key),
                  tail: info.key ? info.key.slice(-6) : null,
                  source: info.source,
                  models: [] as EngineModel[],
                };
              };
              // Model lists are fetched per engine by /__design_models — this
              // endpoint answers the cheaper question of what's connected.
              const engines = [
                {
                  id: "higgsfield",
                  label: "Higgsfield",
                  auth: "cli" as const,
                  configured: higgsfieldReady(forceCliRefresh),
                  tail: null,
                  source: "cli",
                  models: [] as EngineModel[],
                },
                keyed("kie", "Kie.ai"),
                keyed("openrouter", "OpenRouter"),
                keyed("openai", "OpenAI"),
                keyed("fal", "fal"),
                keyed("replicate", "Replicate"),
              ];
              // Only these two currently carry a video lane.
              const videoReady = engines.some(
                (e) => e.configured && (e.id === "higgsfield" || e.id === "kie"),
              );
              res.setHeader("Cache-Control", "no-store");
              res.end(
                JSON.stringify({
                  ok: true,
                  engines,
                  looks: allDesignLooks().map(({ id, label, hint }) => ({ id, label, hint })),
                  // legacy fields, kept so an older client shape can't crash
                  providers: {
                    openrouter: {
                      configured: Boolean(orKey),
                      tail: orKey ? orKey.slice(-6) : null,
                    },
                  },
                  models: orModels.map((m) => ({ id: m.id, label: m.label, perImage: m.perUnit })),
                  video: {
                    available: videoReady,
                    reason: videoReady ? "" : "No video-capable engine connected yet",
                  },
                }),
              );
            })().catch((err) => {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err?.message ?? "provider check failed" }));
            });
          });

          // GET /__design_balance — live remaining spend for providers that
          // expose it. Keys and CLI account details stay server-side; the UI
          // receives only the amount and unit it can safely display.
          server.middlewares.use("/__design_balance", (req, res, next) => {
            if (req.method !== "GET") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            void (async () => {
              try {
                const url = new URL(req.url ?? "", "http://localhost");
                const engine = url.searchParams.get("engine") ?? "";
                const force = url.searchParams.get("refresh") === "1";
                const balance = await designBalance(engine, force);
                res.setHeader("Cache-Control", "no-store");
                res.end(JSON.stringify({ ok: true, ...balance }));
              } catch (error: unknown) {
                res.statusCode = 404;
                res.end(
                  JSON.stringify({
                    ok: false,
                    error: error instanceof Error ? error.message : "balance unavailable",
                  }),
                );
              }
            })();
          });

          // POST /__design_set_key — connect any engine's key from the UI.
          // Token-gated like every mutating endpoint, verified against the
          // provider BEFORE saving so a typo'd key fails here, not silently
          // on the first generation. Stored in ~/.claude-os/config.json.
          server.middlewares.use("/__design_set_key", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req) || req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "forbidden" }));
              return;
            }
            let body = "";
            req.on("data", (c) => {
              body += c;
              if (body.length > 4096) req.destroy();
            });
            req.on("end", async () => {
              try {
                const { provider, key } = JSON.parse(body || "{}");
                if (
                  typeof provider !== "string" ||
                  !(provider in DESIGN_ENGINE_ENV) ||
                  typeof key !== "string" ||
                  !key.trim()
                ) {
                  res.statusCode = 400;
                  res.end(
                    JSON.stringify({
                      error: `expected { provider: one of ${Object.keys(DESIGN_ENGINE_ENV).join("/")}, key }`,
                    }),
                  );
                  return;
                }
                const trimmed = key.trim();
                const verifiers: Record<string, (k: string) => Promise<string | null>> = {
                  openrouter: async (k) =>
                    (
                      await fetch("https://openrouter.ai/api/v1/auth/key", {
                        headers: { Authorization: `Bearer ${k}` },
                        signal: AbortSignal.timeout(15_000),
                      })
                    ).ok
                      ? null
                      : "OpenRouter rejected that key",
                  kie: async (k) => {
                    const r = await fetch("https://api.kie.ai/api/v1/chat/credit", {
                      headers: { Authorization: `Bearer ${k}`, "User-Agent": DESIGN_UA },
                      signal: AbortSignal.timeout(15_000),
                    });
                    return r.status === 401 || r.status === 403 ? "Kie rejected that key" : null;
                  },
                  openai: async (k) =>
                    (
                      await fetch("https://api.openai.com/v1/models", {
                        headers: { Authorization: `Bearer ${k}` },
                        signal: AbortSignal.timeout(15_000),
                      })
                    ).ok
                      ? null
                      : "OpenAI rejected that key",
                  replicate: async (k) =>
                    (
                      await fetch("https://api.replicate.com/v1/account", {
                        headers: { Authorization: `Bearer ${k}` },
                        signal: AbortSignal.timeout(15_000),
                      })
                    ).ok
                      ? null
                      : "Replicate rejected that key",
                  // fal keys can't be verified without firing a paid request;
                  // shape check only.
                  fal: async (k) =>
                    k.includes(":")
                      ? null
                      : "That doesn't look like a fal key (expected id:secret)",
                };
                const problem = await verifiers[provider](trimmed);
                if (problem) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: problem }));
                  return;
                }
                const cfgPath = join(homedir(), ".claude-os", "config.json");
                let cfg: any = {};
                try {
                  cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
                } catch {
                  /* fresh */
                }
                cfg.design ??= {};
                cfg.design.keys ??= {};
                cfg.design.keys[provider] = trimmed;
                mkdirSync(join(homedir(), ".claude-os"), { recursive: true });
                writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
                res.end(JSON.stringify({ ok: true, tail: trimmed.slice(-6) }));
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err?.message ?? "save failed" }));
              }
            });
          });

          // Remove only a key saved by Design. Environment variables and
          // provider-owned key files stay under the user's existing setup.
          server.middlewares.use("/__design_remove_key", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req) || req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "forbidden" }));
              return;
            }
            let body = "";
            req.on("data", (c) => {
              body += c;
              if (body.length > 4096) req.destroy();
            });
            req.on("end", () => {
              try {
                const { provider } = JSON.parse(body || "{}");
                if (typeof provider !== "string" || !(provider in DESIGN_ENGINE_ENV)) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: "unknown provider" }));
                  return;
                }
                const cfgPath = join(homedir(), ".claude-os", "config.json");
                let cfg: any = {};
                try {
                  cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
                } catch {
                  /* nothing saved */
                }
                if (
                  cfg?.design?.keys &&
                  Object.prototype.hasOwnProperty.call(cfg.design.keys, provider)
                ) {
                  delete cfg.design.keys[provider];
                  mkdirSync(join(homedir(), ".claude-os"), { recursive: true });
                  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
                }
                const remaining = designApiKeyInfo(provider);
                res.end(
                  JSON.stringify({
                    ok: true,
                    configured: Boolean(remaining.key),
                    source: remaining.source,
                  }),
                );
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err?.message ?? "disconnect failed" }));
              }
            });
          });

          // Resolve a client-supplied asset id to a readable path, under
          // the same containment rules /__design_file enforces: inside a
          // configured root, or listed in the ledger. Anything else is a no.
          function designResolveReadable(rawId: string): string | null {
            let filePath: string;
            try {
              filePath = Buffer.from(rawId, "base64url").toString("utf-8");
            } catch {
              return null;
            }
            let real: string;
            try {
              real = realpathSync(resolve(filePath));
            } catch {
              return null;
            }
            const roots = designRoots().map((r) => {
              try {
                return realpathSync(r);
              } catch {
                return r;
              }
            });
            let inside = roots.some((r) => real === r || real.startsWith(r + sep));
            try {
              const referenceRoot = realpathSync(designReferenceDir());
              inside = inside || real === referenceRoot || real.startsWith(referenceRoot + sep);
            } catch {
              /* the folder does not exist until the first upload */
            }
            if (!inside) {
              inside = readDesignLedger().some((e) => {
                try {
                  return realpathSync(e.path) === real;
                } catch {
                  return false;
                }
              });
            }
            if (!inside) return null;
            const ext = real.slice(real.lastIndexOf(".")).toLowerCase();
            return DESIGN_EXT.has(ext) ? real : null;
          }

          // POST /__design_reference — copy local image picks into a private
          // Design input folder. References are inputs, not creations, so they
          // stay out of the output ledger while remaining readable by every
          // generation engine for the life of the local workspace.
          server.middlewares.use("/__design_reference", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req) || req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "forbidden" }));
              return;
            }
            let body = "";
            let tooLarge = false;
            req.on("data", (chunk) => {
              if (tooLarge) return;
              body += chunk;
              if (body.length > 64_000_000) {
                tooLarge = true;
                res.statusCode = 413;
                res.end(JSON.stringify({ error: "reference upload is too large" }));
              }
            });
            req.on("end", () => {
              if (tooLarge) return;
              try {
                const parsed = JSON.parse(body || "{}");
                const files = Array.isArray(parsed.files) ? parsed.files.slice(0, 8) : [];
                if (!files.length) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: "choose at least one reference image" }));
                  return;
                }
                const referenceDir = designReferenceDir();
                mkdirSync(referenceDir, { recursive: true, mode: 0o700 });
                const items = files.map((file: any) => {
                  const match =
                    typeof file?.dataUrl === "string"
                      ? file.dataUrl.match(
                          /^data:image\/(png|jpeg|jpg|webp|gif);base64,([a-z0-9+/=\r\n]+)$/i,
                        )
                      : null;
                  if (!match)
                    throw new Error("Only PNG, JPEG, WebP and GIF references are supported");
                  const buf = Buffer.from(match[2], "base64");
                  if (!buf.length || buf.length > 12 * 1024 * 1024)
                    throw new Error("Each reference must be 12 MB or smaller");
                  const requested = String(file?.name ?? "reference");
                  const stem =
                    requested
                      .replace(/\.[^.]+$/, "")
                      .replace(/[^a-z0-9_-]+/gi, "-")
                      .replace(/^-+|-+$/g, "")
                      .slice(0, 56) || "reference";
                  const ext = match[1].toLowerCase().replace("jpeg", "jpg");
                  const name = `${Date.now()}-${stem}-${randomBytes(3).toString("hex")}.${ext}`;
                  const path = join(referenceDir, name);
                  writeFileSync(path, buf, { mode: 0o600 });
                  const stats = statSync(path);
                  return {
                    id: Buffer.from(path).toString("base64url"),
                    path,
                    name,
                    agent: "studio",
                    tool: "reference",
                    kind: "image",
                    ts: stats.mtimeMs,
                    bytes: stats.size,
                    mtime: stats.mtimeMs,
                    alive: true,
                    session: null,
                    cwd: referenceDir,
                    prompt: null,
                    backfill: false,
                    model: null,
                    params: {},
                    ...imageSize(buf),
                  };
                });
                res.setHeader("Cache-Control", "no-store");
                res.end(JSON.stringify({ ok: true, items }));
              } catch (error: any) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: error?.message ?? "reference upload failed" }));
              }
            });
          });

          // POST /__design_trash {id} — recoverable deletion. On macOS this
          // moves the file into the user's real Trash. Other platforms keep a
          // local Design trash folder instead of permanently unlinking it.
          server.middlewares.use("/__design_trash", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req) || req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "forbidden" }));
              return;
            }
            let body = "";
            req.on("data", (chunk) => {
              body += chunk;
              if (body.length > 4096) req.destroy();
            });
            req.on("end", () => {
              try {
                const parsed = JSON.parse(body || "{}");
                const source = designResolveReadable(String(parsed.id ?? ""));
                if (!source) {
                  res.statusCode = 404;
                  res.end(JSON.stringify({ error: "file not found" }));
                  return;
                }
                const preferredTrash = join(homedir(), ".Trash");
                const trashDir =
                  process.platform === "darwin" && existsSync(preferredTrash)
                    ? preferredTrash
                    : join(homedir(), ".claude-os", "design", "trash");
                mkdirSync(trashDir, { recursive: true });
                const name = source.slice(source.lastIndexOf(sep) + 1);
                const destination = join(
                  trashDir,
                  `${Date.now()}-${randomBytes(3).toString("hex")}-${name}`,
                );
                renameSync(source, destination);
                res.end(JSON.stringify({ ok: true, recoverable: true }));
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err?.message ?? "move to Trash failed" }));
              }
            });
          });

          // Kie takes references as URLs, so a local file has to go up first.
          async function kieUpload(
            key: string,
            file: string,
            signal?: AbortSignal,
          ): Promise<string> {
            const b64 = readFileSync(file).toString("base64");
            const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
            const r = await fetch("https://kieai.redpandaai.co/api/file-base64-upload", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                "User-Agent": DESIGN_UA,
              },
              body: JSON.stringify({
                base64Data: `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${b64}`,
                uploadPath: "images/design",
                fileName: file.slice(file.lastIndexOf(sep) + 1),
              }),
              signal: designRequestSignal(signal, 180_000),
            });
            const d: any = await r.json().catch(() => ({}));
            const url = d?.data?.downloadUrl ?? d?.data?.fileUrl ?? d?.data?.url;
            if (!url) throw new Error(`Kie upload failed: ${JSON.stringify(d).slice(0, 200)}`);
            return String(url);
          }

          function kieReferenceParams(
            modelId: string,
            kind: "image" | "video",
            params: Record<string, unknown>,
            urls: string[],
          ): Record<string, unknown> {
            if (!urls.length) return params;
            const model = modelId.toLowerCase();
            const next = { ...params };
            if (/seedance-2-5/.test(model)) {
              next.first_frame_url = urls[0];
              if (urls[1]) next.last_frame_url = urls[1];
              return next;
            }
            if (/nano-banana-2|nano-banana-pro/.test(model)) {
              next.image_input = urls.slice(0, 14);
              return next;
            }
            if (/gpt-image|flux-2/.test(model) && /image-to-image/.test(model)) {
              next.input_urls = urls;
              return next;
            }
            if (/ideogram|qwen2\/image-edit|qwen\/image-edit/.test(model)) {
              next.image_url = urls[0];
              return next;
            }
            if (/reference-to-video|\br2v\b/.test(model)) {
              next.image_urls = urls;
              return next;
            }
            if (/image-to-video/.test(model)) {
              next.image_url = urls[0];
              return next;
            }
            if (/image-to-image|image-edit|seedream|qwen3|google\/nano-banana-edit/.test(model)) {
              next.image_urls = urls;
              return next;
            }
            // Some multimodal video models accept an ordered image list even
            // without a task suffix. Unknown text-only models keep defaults.
            if (kind === "video" && /kling-3\.0\/video|gemini-omni-video/.test(model)) {
              next.image_urls = urls;
            }
            return next;
          }

          // GET /__design_models?engine=…  — every model that engine serves.
          server.middlewares.use("/__design_models", (req, res, next) => {
            if (req.method !== "GET") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            (async () => {
              const url = new URL(req.url ?? "", "http://localhost");
              const engine = url.searchParams.get("engine") ?? "";
              const orModels: EngineModel[] =
                engine === "openrouter"
                  ? (await studioModels()).map((m) => ({
                      id: m.id,
                      label: m.label,
                      kind: "image" as const,
                      perUnit: m.perImage,
                      pricing: m.pricing,
                      pricingSource: m.pricing.length
                        ? ("live" as const)
                        : ("unavailable" as const),
                    }))
                  : [];
              res.setHeader("Cache-Control", "no-store");
              res.end(JSON.stringify({ ok: true, models: await engineModels(engine, orModels) }));
            })().catch((err) => {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err?.message ?? "model list failed" }));
            });
          });

          // GET /__design_schema?engine=…&model=… — the controls that model
          // actually accepts, so the UI can never offer a knob it would reject.
          server.middlewares.use("/__design_schema", (req, res, next) => {
            if (req.method !== "GET") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            (async () => {
              const url = new URL(req.url ?? "", "http://localhost");
              const engine = url.searchParams.get("engine") ?? "";
              const model = url.searchParams.get("model") ?? "";
              res.setHeader("Cache-Control", "no-store");
              res.end(JSON.stringify({ ok: true, params: await modelSchema(engine, model) }));
            })().catch((err) => {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err?.message ?? "schema read failed" }));
            });
          });

          // POST /__design_cost — Higgsfield exposes a live credit estimator
          // through its CLI. Ask it before generation so the composer can show
          // the exact credits for the selected model, settings and quantity.
          server.middlewares.use("/__design_cost", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req) || req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "forbidden" }));
              return;
            }
            let body = "";
            req.on("data", (chunk) => {
              body += chunk;
              if (body.length > 16_000) req.destroy();
            });
            req.on("end", async () => {
              try {
                const parsed = JSON.parse(body || "{}");
                const engine = typeof parsed.engine === "string" ? parsed.engine : "";
                const model = typeof parsed.model === "string" ? parsed.model : "";
                const count = Math.max(1, Math.min(8, Number(parsed.count) || 1));
                if (engine !== "higgsfield") {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: "live cost is only required for Higgsfield" }));
                  return;
                }
                const catalog = await higgsfieldModels();
                if (!catalog.some((item) => item.id === model)) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: "unknown Higgsfield model" }));
                  return;
                }
                const args = ["generate", "cost", model, "--prompt", "pricing estimate"];
                const params =
                  parsed.params && typeof parsed.params === "object"
                    ? (parsed.params as Record<string, unknown>)
                    : {};
                for (const [name, value] of Object.entries(params)) {
                  if (!/^[a-z0-9_]+$/i.test(name) || value === null || value === undefined)
                    continue;
                  const flag = `--${name.replace(/_/g, "-")}`;
                  if (typeof value === "boolean") args.push(`${flag}=${value}`);
                  else if (typeof value === "string" || typeof value === "number") {
                    args.push(flag, String(value));
                  }
                }
                args.push("--json");
                const result = await runDesignCli("higgsfield", args, 20_000);
                if (result.code !== 0) throw new Error(result.out || "cost estimate failed");
                const estimate = JSON.parse(result.out);
                const perOutput = Number(estimate?.credits);
                if (!Number.isFinite(perOutput))
                  throw new Error("Higgsfield returned no credit cost");
                res.setHeader("Cache-Control", "no-store");
                res.end(
                  JSON.stringify({
                    ok: true,
                    unit: "credits",
                    perOutput,
                    total: perOutput * count,
                    source: "live",
                  }),
                );
              } catch (error: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: error?.message ?? "cost estimate failed" }));
              }
            });
          });

          type ActiveDesignGeneration = {
            controller: AbortController;
            id: string;
            startedAt: number;
            total: number;
            prompt: string;
            engine: string;
            engineLabel: string;
            model: string;
            modelLabel: string;
            kind: "image" | "video";
          };
          const activeDesignGenerations = new Map<string, ActiveDesignGeneration>();

          // GET /__design_jobs — lets the UI reconnect to active work after a
          // refresh instead of losing the only cancellation handle.
          server.middlewares.use("/__design_jobs", (req, res, next) => {
            if (req.method !== "GET") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            res.setHeader("Cache-Control", "no-store");
            res.end(
              JSON.stringify({
                ok: true,
                jobs: [...activeDesignGenerations.values()].map(
                  ({ controller: _controller, ...job }) => ({
                    ...job,
                    status: "running",
                  }),
                ),
              }),
            );
          });

          // POST /__design_cancel {jobId} — stop one run without touching any
          // other generations currently stacked beside it. Network requests
          // receive the abort signal; CLI children are terminated locally.
          server.middlewares.use("/__design_cancel", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req) || req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "forbidden" }));
              return;
            }
            let body = "";
            req.on("data", (chunk) => {
              body += chunk;
              if (body.length > 4096) req.destroy();
            });
            req.on("end", () => {
              try {
                const parsed = JSON.parse(body || "{}");
                const jobId = typeof parsed.jobId === "string" ? parsed.jobId : "";
                const job = activeDesignGenerations.get(jobId);
                if (job) job.controller.abort(designAbortError());
                res.setHeader("Cache-Control", "no-store");
                res.end(JSON.stringify({ ok: true, jobId, active: Boolean(job) }));
              } catch (error: any) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: error?.message ?? "cancel failed" }));
              }
            });
          });

          // POST /__design_generate — N assets, through whichever engine the
          // composer picked, with that model's own parameters passed straight
          // through. A Look prepends the house-style recipe server-side so the
          // ledger keeps the USER'S ask, not the boilerplate. Everything lands
          // in ~/.claude-os/design/generations/ and in the ledger as agent
          // "studio" with tool = engine, so a generation and an agent build are
          // the same kind of thing everywhere downstream.
          server.middlewares.use("/__design_generate", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req) || req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "forbidden" }));
              return;
            }
            let body = "";
            req.on("data", (c) => {
              body += c;
              if (body.length > 64_000) req.destroy();
            });
            req.on("end", async () => {
              let activeJobId: string | null = null;
              let jobController: AbortController | null = null;
              try {
                const parsed = JSON.parse(body || "{}");
                const engine: string =
                  typeof parsed.engine === "string" ? parsed.engine : "openrouter";
                const prompt: string =
                  typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
                const kind: "image" | "video" = parsed.kind === "video" ? "video" : "image";
                const look: string | null =
                  typeof parsed.look === "string" && parsed.look ? parsed.look : null;
                const lookLabel: string | null =
                  typeof parsed.lookLabel === "string" && parsed.lookLabel.trim()
                    ? parsed.lookLabel.trim().slice(0, 120)
                    : look;
                const lookPrompt: string | null =
                  typeof parsed.lookPrompt === "string" && parsed.lookPrompt.trim()
                    ? parsed.lookPrompt.trim().slice(0, 4000)
                    : null;
                const params: Record<string, unknown> =
                  parsed.params && typeof parsed.params === "object" ? { ...parsed.params } : {};
                const count = Math.max(1, Math.min(8, Number(parsed.count) || 1));
                const quotedCostCredits =
                  typeof parsed.quotedCostCredits === "number" &&
                  Number.isFinite(parsed.quotedCostCredits)
                    ? Math.max(0, parsed.quotedCostCredits)
                    : null;
                const estimatedCostUsd =
                  typeof parsed.estimatedCostUsd === "number" &&
                  Number.isFinite(parsed.estimatedCostUsd)
                    ? Math.max(0, parsed.estimatedCostUsd)
                    : null;
                const refIds: string[] = Array.isArray(parsed.references)
                  ? parsed.references.slice(0, 8)
                  : [];
                if (!prompt) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: "missing prompt" }));
                  return;
                }
                const requestedJobId = typeof parsed.jobId === "string" ? parsed.jobId : "";
                const jobId = /^[a-zA-Z0-9_-]{8,128}$/.test(requestedJobId)
                  ? requestedJobId
                  : randomBytes(16).toString("hex");
                if (activeDesignGenerations.has(jobId)) {
                  res.statusCode = 409;
                  res.end(JSON.stringify({ error: "generation job already active", jobId }));
                  return;
                }
                jobController = new AbortController();
                activeJobId = jobId;
                activeDesignGenerations.set(jobId, {
                  controller: jobController,
                  id: jobId,
                  startedAt: Date.now(),
                  total: count,
                  prompt,
                  engine,
                  engineLabel:
                    typeof parsed.engineLabel === "string" && parsed.engineLabel.trim()
                      ? parsed.engineLabel.trim().slice(0, 80)
                      : engine,
                  model: typeof parsed.model === "string" ? parsed.model : "",
                  modelLabel:
                    typeof parsed.modelLabel === "string" && parsed.modelLabel.trim()
                      ? parsed.modelLabel.trim().slice(0, 120)
                      : typeof parsed.model === "string"
                        ? parsed.model
                        : "Model",
                  kind,
                });
                const generationSignal = jobController.signal;
                const lookDef = look ? allDesignLooks().find((l) => l.id === look) : null;
                const stylePrompt = lookPrompt ?? lookDef?.prompt ?? null;
                const fullPrompt = stylePrompt ? `${stylePrompt}\n\n${prompt}` : prompt;
                const refPaths = refIds
                  .map((id) => designResolveReadable(String(id)))
                  .filter((p): p is string => Boolean(p));

                // One asset. Called `count` times, concurrently.
                const makeOne = async (): Promise<{ id: string; path: string }> => {
                  throwIfDesignAborted(generationSignal);
                  if (engine === "openrouter") {
                    const key = designApiKey("openrouter");
                    if (!key) throw new Error("No OpenRouter key connected");
                    const known = await studioModels();
                    throwIfDesignAborted(generationSignal);
                    const chosen = known.find((m) => m.id === parsed.model) ?? known[0];
                    if (!chosen) throw new Error("no image model available");
                    const requestBody: Record<string, unknown> = {
                      model: chosen.id,
                      prompt: fullPrompt,
                      n: 1,
                      ...params,
                    };
                    const inputReferences: any[] = [];
                    for (const p of refPaths) {
                      const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
                      inputReferences.push({
                        type: "image_url",
                        image_url: {
                          url: `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${readFileSync(p).toString("base64")}`,
                        },
                      });
                    }
                    if (inputReferences.length) requestBody.input_references = inputReferences;
                    const resp = await fetch("https://openrouter.ai/api/v1/images", {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${key}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify(requestBody),
                      signal: designRequestSignal(generationSignal, 300_000),
                    });
                    if (!resp.ok) {
                      const errText = await resp.text().catch(() => "");
                      throw new Error(`OpenRouter HTTP ${resp.status}: ${errText.slice(0, 240)}`);
                    }
                    const data: any = await resp.json();
                    const image = data?.data?.[0];
                    const b64 = image?.b64_json;
                    if (typeof b64 !== "string" || !b64)
                      throw new Error("OpenRouter returned no image");
                    const mime = String(image?.media_type ?? "image/png").toLowerCase();
                    const ext = mime.includes("jpeg")
                      ? "jpg"
                      : mime.includes("webp")
                        ? "webp"
                        : mime.includes("gif")
                          ? "gif"
                          : "png";
                    const costUsd = Number(data?.usage?.cost);
                    throwIfDesignAborted(generationSignal);
                    return saveGeneration({
                      buf: Buffer.from(b64, "base64"),
                      ext,
                      prompt,
                      engine,
                      model: chosen.id,
                      kind: "image",
                      look: lookLabel,
                      params,
                      jobId,
                      references: refPaths,
                      costUsd: Number.isFinite(costUsd) ? costUsd : estimatedCostUsd,
                      costSource: Number.isFinite(costUsd)
                        ? "reported"
                        : estimatedCostUsd !== null
                          ? "estimate"
                          : null,
                    });
                  }

                  const catalog = await engineModels(engine);
                  throwIfDesignAborted(generationSignal);
                  if (!catalog.length) throw new Error(`unknown engine "${engine}"`);
                  // Never silently substitute: the caller paid for the model
                  // it named, and a fallback would charge for a different one.
                  const chosenModel = parsed.model
                    ? catalog.find((m) => m.id === parsed.model && m.kind === kind)?.id
                    : catalog.find((m) => m.kind === kind)?.id;
                  if (!chosenModel) {
                    throw new Error(
                      parsed.model
                        ? `${engine} has no ${kind} model "${parsed.model}"`
                        : `${engine} has no ${kind} model`,
                    );
                  }

                  let made: { buf: Buffer; ext: string };
                  if (engine === "higgsfield") {
                    if (!higgsfieldReady())
                      throw new Error(
                        "Higgsfield CLI not found — install it and run `higgsfield auth login`",
                      );
                    // The CLI uploads local paths itself.
                    const withRefs = refPaths.length
                      ? { ...params, image_references: undefined }
                      : params;
                    made = await higgsfieldGenerate(
                      chosenModel,
                      kind,
                      fullPrompt,
                      withRefs,
                      refPaths,
                      generationSignal,
                    );
                  } else {
                    const key = designApiKey(engine);
                    if (!key) throw new Error(`No ${engine} key connected`);
                    if (engine === "kie") {
                      const urls = refPaths.length
                        ? await Promise.all(
                            refPaths.map((file) => kieUpload(key, file, generationSignal)),
                          )
                        : [];
                      const p = kieReferenceParams(chosenModel, kind, params, urls);
                      made = await kieGenerate(
                        key,
                        chosenModel,
                        kind,
                        fullPrompt,
                        p,
                        generationSignal,
                      );
                    } else if (engine === "openai")
                      made = await openaiGenerate(
                        key,
                        chosenModel,
                        fullPrompt,
                        params,
                        generationSignal,
                      );
                    else if (engine === "replicate")
                      made = await replicateGenerate(
                        key,
                        chosenModel,
                        fullPrompt,
                        params,
                        generationSignal,
                      );
                    else if (engine === "fal")
                      made = await falGenerate(
                        key,
                        chosenModel,
                        fullPrompt,
                        params,
                        generationSignal,
                      );
                    else throw new Error(`unknown engine "${engine}"`);
                  }
                  throwIfDesignAborted(generationSignal);
                  return saveGeneration({
                    ...made,
                    prompt,
                    engine,
                    model: chosenModel,
                    kind,
                    look: lookLabel,
                    params,
                    jobId,
                    references: refPaths,
                    costUsd: engine === "higgsfield" ? null : estimatedCostUsd,
                    costCredits: engine === "higgsfield" ? quotedCostCredits : null,
                    costSource:
                      engine === "higgsfield" && quotedCostCredits !== null
                        ? "live_quote"
                        : estimatedCostUsd !== null
                          ? "estimate"
                          : null,
                  });
                };

                const settled = await Promise.allSettled(
                  Array.from({ length: count }, () => makeOne()),
                );
                const items = settled
                  .filter((s) => s.status === "fulfilled")
                  .map((s: any) => s.value);
                const failures = settled
                  .filter((s) => s.status === "rejected")
                  .map((s: any) => String(s.reason?.message ?? s.reason));
                if (generationSignal.aborted) {
                  res.statusCode = 499;
                  res.end(JSON.stringify({ ok: false, cancelled: true, jobId, items }));
                  return;
                }
                if (!items.length) {
                  res.statusCode = 502;
                  res.end(JSON.stringify({ error: failures[0] ?? "generation failed" }));
                  return;
                }
                res.end(
                  JSON.stringify({
                    ok: true,
                    jobId,
                    items,
                    failed: failures.length,
                    failures: failures.slice(0, 3),
                  }),
                );
              } catch (err: any) {
                if (jobController?.signal.aborted || err?.name === "AbortError") {
                  res.statusCode = 499;
                  res.end(
                    JSON.stringify({
                      ok: false,
                      cancelled: true,
                      jobId: activeJobId,
                      error: "Generation cancelled",
                    }),
                  );
                } else {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: err?.message ?? "generation failed" }));
                }
              } finally {
                if (
                  activeJobId &&
                  jobController &&
                  activeDesignGenerations.get(activeJobId)?.controller === jobController
                ) {
                  activeDesignGenerations.delete(activeJobId);
                }
              }
            });
          });

          // ── Optional: describe every image with a cheap model, then
          // search them in plain English. Off until you turn it on; runs in
          // the background; each image is described once and remembered.
          const designIndexPath = () => join(homedir(), ".claude-os", "design", "index.jsonl");
          type IndexEntry = {
            path: string;
            desc: string;
            tags: string[];
            text?: string;
            ocr?: string;
            model: string;
            ts: number;
            mtimeMs?: number;
            costUsd?: number;
          };
          let indexCache: { mtimeMs: number; entries: Map<string, IndexEntry> } | null = null;
          function readDesignIndex(): Map<string, IndexEntry> {
            const p = designIndexPath();
            let st: import("node:fs").Stats;
            try {
              st = statSync(p);
            } catch {
              return new Map();
            }
            if (indexCache && indexCache.mtimeMs === st.mtimeMs) return indexCache.entries;
            const entries = new Map<string, IndexEntry>();
            try {
              for (const line of readFileSync(p, "utf-8").split("\n")) {
                if (!line.trim()) continue;
                try {
                  const e = JSON.parse(line);
                  // Later lines win, so a re-description supersedes the old one.
                  if (e?.path && typeof e.desc === "string") entries.set(e.path, e);
                } catch {
                  /* skip a bad line */
                }
              }
            } catch {
              return entries;
            }
            indexCache = { mtimeMs: st.mtimeMs, entries };
            return entries;
          }

          // Text inside an image should not need a paid model or leave the
          // machine. On macOS, Vision gives us fast, private OCR. The tiny
          // Objective-C helper is compiled into the temp directory on demand,
          // never into the user's project or library folders.
          const designOcrSource = resolve(__dirname, "scripts/design-ocr.m");
          const designOcrBinary = join(tmpdir(), `claude-os-design-ocr-${process.arch}`);
          let designOcrReady: string | null | undefined;
          function localOcrBinary(): string | null {
            if (designOcrReady !== undefined) return designOcrReady;
            if (process.platform !== "darwin" || !existsSync(designOcrSource)) {
              designOcrReady = null;
              return designOcrReady;
            }
            try {
              const sourceMtime = statSync(designOcrSource).mtimeMs;
              const binaryMtime = existsSync(designOcrBinary)
                ? statSync(designOcrBinary).mtimeMs
                : 0;
              if (binaryMtime < sourceMtime) {
                execFileSync(
                  "clang",
                  [
                    "-fobjc-arc",
                    "-framework",
                    "Foundation",
                    "-framework",
                    "Vision",
                    "-framework",
                    "ImageIO",
                    "-framework",
                    "CoreGraphics",
                    designOcrSource,
                    "-o",
                    designOcrBinary,
                  ],
                  { stdio: "ignore", timeout: 30_000 },
                );
              }
              designOcrReady = designOcrBinary;
            } catch {
              designOcrReady = null;
            }
            return designOcrReady;
          }

          function readImageText(file: string): Promise<string> {
            const binary = localOcrBinary();
            if (!binary)
              return Promise.reject(new Error("Local image text recognition is unavailable"));
            return new Promise((resolveText, rejectText) => {
              execFile(
                binary,
                [file],
                { timeout: 30_000, maxBuffer: 512 * 1024 },
                (error, stdout, stderr) => {
                  if (error) {
                    rejectText(
                      new Error(
                        String(stderr || error.message)
                          .trim()
                          .slice(0, 200),
                      ),
                    );
                    return;
                  }
                  resolveText(String(stdout).trim().slice(0, 2_000));
                },
              );
            });
          }

          // The describer: cheapest vision model the key serves, unless one
          // is pinned in config. Vision pricing is per-token, so a downscaled
          // thumbnail is the difference between pennies and real money.
          const INDEX_MODEL_FALLBACK = "google/gemini-2.5-flash-lite";
          // Conservative ceiling for a 512px image plus a short JSON
          // description at Gemini 2.5 Flash Lite's current OpenRouter rates.
          // The API response supplies the actual charge after each request;
          // this figure only exists so the operator can approve a batch with
          // a useful upper estimate before any paid work starts.
          const VISION_ESTIMATE_USD_PER_IMAGE = 0.0003;
          function indexModelId(): string {
            try {
              const cfg = JSON.parse(
                readFileSync(join(homedir(), ".claude-os", "config.json"), "utf-8"),
              );
              const m = cfg?.design?.indexModel;
              if (typeof m === "string" && m.trim()) return m.trim();
            } catch {
              /* default */
            }
            return INDEX_MODEL_FALLBACK;
          }

          // macOS ships sips, so downscaling needs no dependency. Without it
          // we send the original — correct, just pricier.
          function thumbnailFor(file: string): { b64: string; mime: string } {
            const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
            const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
            if (process.platform === "darwin") {
              const tmp = join(tmpdir(), `claude-os-idx-${randomBytes(8).toString("hex")}.jpg`);
              try {
                // execFileSync, NOT a shell string: a filename containing
                // $(…) or backticks would otherwise execute as this process.
                execFileSync("sips", ["-Z", "512", "-s", "format", "jpeg", file, "--out", tmp], {
                  stdio: ["ignore", "ignore", "ignore"],
                  timeout: 20_000,
                });
                return { b64: readFileSync(tmp).toString("base64"), mime: "image/jpeg" };
              } catch {
                /* fall through to the original */
              } finally {
                // Runs whether sips threw, the read threw, or neither.
                try {
                  unlinkSync(tmp);
                } catch {
                  /* never existed */
                }
              }
            }
            return { b64: readFileSync(file).toString("base64"), mime };
          }

          type IndexJob = {
            running: boolean;
            done: number;
            total: number;
            failed: number;
            spentUsd: number;
            model: string;
            mode: "ocr" | "vision";
            startedAt: number;
            stop: boolean;
            lastError: string | null;
          };
          let indexJob: IndexJob | null = null;

          function libraryImageCandidates(): string[] {
            const IMG = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);
            const out: string[] = [];
            const stack = designRoots().map((dir) => ({ dir, depth: 0 }));
            let scanned = 0;
            while (stack.length && out.length < 4000 && scanned < 200_000) {
              const { dir, depth } = stack.pop()!;
              if (depth > 6) continue;
              let entries: any[] = [];
              try {
                entries = readdirSync(dir, { withFileTypes: true });
              } catch {
                continue;
              }
              for (const entry of entries) {
                if (out.length >= 4000 || scanned >= 200_000) break;
                scanned++;
                if (entry.name.startsWith(".")) continue;
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                  if (
                    !DESIGN_SKIP_DIR.test(entry.name) &&
                    !DESIGN_SKIP_PATH.test(designPosix(full))
                  ) {
                    stack.push({ dir: full, depth: depth + 1 });
                  }
                } else if (
                  entry.isFile() &&
                  IMG.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase())
                ) {
                  out.push(full);
                }
              }
            }
            return out;
          }

          let visionEstimateCache:
            | { at: number; eligible: number; pending: number; estimatedUsd: number }
            | undefined;
          function visionIndexEstimate() {
            if (visionEstimateCache && Date.now() - visionEstimateCache.at < 30_000) {
              return visionEstimateCache;
            }
            const already = readDesignIndex();
            const candidates = libraryImageCandidates();
            const pending = candidates.filter((file) => {
              if (!existsSync(file)) return false;
              const prior = already.get(file);
              if (!prior?.desc.trim()) return true;
              if (!prior.mtimeMs) return false;
              try {
                return statSync(file).mtimeMs > prior.mtimeMs;
              } catch {
                return false;
              }
            }).length;
            visionEstimateCache = {
              at: Date.now(),
              eligible: candidates.length,
              pending,
              estimatedUsd: pending * VISION_ESTIMATE_USD_PER_IMAGE,
            };
            return visionEstimateCache;
          }

          async function describeOne(
            key: string,
            model: string,
            file: string,
          ): Promise<IndexEntry | null> {
            const { b64, mime } = thumbnailFor(file);
            const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model,
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "text",
                        text: 'Describe this image for search. Reply with JSON only: {"desc":"one plain sentence of what is visibly in it","tags":["6-12 lowercase keywords: subjects, colours, style, medium, mood, any legible text"]}',
                      },
                      { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
                    ],
                  },
                ],
                max_tokens: 300,
              }),
              signal: AbortSignal.timeout(120_000),
            });
            if (!r.ok)
              throw new Error(
                `describe HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`,
              );
            const d: any = await r.json();
            const text = String(d?.choices?.[0]?.message?.content ?? "");
            let desc = text.trim();
            let tags: string[] = [];
            const jsonish = text.match(/\{[\s\S]*\}/);
            if (jsonish) {
              try {
                const o = JSON.parse(jsonish[0]);
                if (typeof o?.desc === "string") desc = o.desc;
                if (Array.isArray(o?.tags))
                  tags = o.tags.map((x: any) => String(x).toLowerCase()).slice(0, 16);
              } catch {
                /* keep the raw text */
              }
            }
            if (!desc) return null;
            let mtimeMs = 0;
            try {
              mtimeMs = statSync(file).mtimeMs;
            } catch {
              /* raced a delete */
            }
            const reportedCost = Number(d?.usage?.cost);
            return {
              path: file,
              desc: desc.slice(0, 600),
              tags,
              model,
              ts: Date.now(),
              mtimeMs,
              costUsd:
                Number.isFinite(reportedCost) && reportedCost >= 0 ? reportedCost : undefined,
            };
          }

          // GET /__design_index_status
          server.middlewares.use("/__design_index_status", (req, res, next) => {
            if (req.method !== "GET") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const idx = readDesignIndex();
            const visionEntries = [...idx.values()].filter((entry) => entry.desc.trim());
            const costedVisionEntries = visionEntries.filter(
              (entry) => typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd),
            );
            const visionEstimate = visionIndexEstimate();
            res.setHeader("Cache-Control", "no-store");
            res.end(
              JSON.stringify({
                ok: true,
                indexed: idx.size,
                ocrIndexed: [...idx.values()].filter((entry) => entry.ocr).length,
                visionIndexed: visionEntries.length,
                visionEstimate: {
                  eligible: visionEstimate.eligible,
                  pending: visionEstimate.pending,
                  estimatedUsd: visionEstimate.estimatedUsd,
                  perImageUsd: VISION_ESTIMATE_USD_PER_IMAGE,
                  estimatedProcessedUsd: visionEntries.length * VISION_ESTIMATE_USD_PER_IMAGE,
                  trackedUsd: costedVisionEntries.reduce(
                    (sum, entry) => sum + (entry.costUsd ?? 0),
                    0,
                  ),
                  trackedImages: costedVisionEntries.length,
                },
                ocrAvailable: Boolean(localOcrBinary()),
                model: indexModelId(),
                available: Boolean(designApiKey("openrouter")),
                job: indexJob
                  ? {
                      running: indexJob.running,
                      done: indexJob.done,
                      total: indexJob.total,
                      failed: indexJob.failed,
                      spentUsd: indexJob.spentUsd,
                      lastError: indexJob.lastError,
                      mode: indexJob.mode,
                    }
                  : null,
              }),
            );
          });

          // POST /__design_index_start. Local OCR is safe to run quietly:
          // pixels never leave the machine and it has no usage cost. Semantic
          // vision descriptions stay explicitly opt-in because those do use
          // the user's OpenRouter key.
          server.middlewares.use("/__design_index_start", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req) || req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "forbidden" }));
              return;
            }
            let body = "";
            req.on("data", (c) => {
              body += c;
              if (body.length > 768_000) req.destroy();
            });
            req.on("end", async () => {
              try {
                if (indexJob?.running) {
                  res.end(JSON.stringify({ ok: true, already: true }));
                  return;
                }
                // A stopped run's workers may still be finishing a request.
                if (indexJob?.stop) await new Promise((r) => setTimeout(r, 250));
                const payload = JSON.parse(body || "{}");
                const scope = payload?.scope;
                const mode: "ocr" | "vision" = payload?.mode === "vision" ? "vision" : "ocr";
                const key = mode === "vision" ? designApiKey("openrouter") : null;
                if (mode === "vision" && !key) {
                  res.statusCode = 400;
                  res.end(
                    JSON.stringify({
                      error: "Visual descriptions run on your OpenRouter key — connect one first",
                    }),
                  );
                  return;
                }
                if (mode === "ocr" && !localOcrBinary()) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: "Local image text recognition is unavailable" }));
                  return;
                }
                const model = mode === "vision" ? indexModelId() : "apple-vision-ocr";
                const already = readDesignIndex();
                // Candidates: ledger assets, or every scanned image on disk.
                let candidates: string[] = [];
                if (scope === "paths" && Array.isArray(payload?.paths)) {
                  const IMG = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);
                  const roots = designRoots().map((root) => {
                    try {
                      return realpathSync(root);
                    } catch {
                      return root;
                    }
                  });
                  candidates = [...new Set(payload.paths)]
                    .filter((candidate): candidate is string => typeof candidate === "string")
                    .slice(0, 1_500)
                    .flatMap((candidate) => {
                      try {
                        const real = realpathSync(candidate);
                        const inside = roots.some(
                          (root) => real === root || real.startsWith(root + sep),
                        );
                        const ext = real.slice(real.lastIndexOf(".")).toLowerCase();
                        return inside && IMG.has(ext) ? [real] : [];
                      } catch {
                        return [];
                      }
                    });
                } else if (scope === "library") {
                  candidates = libraryImageCandidates();
                } else {
                  candidates = readDesignLedger()
                    .filter((e) => e.kind !== "video")
                    .map((e) => e.path);
                }
                // Skip only what's already described AND unchanged since.
                const todo = candidates.filter((p) => {
                  if (!existsSync(p)) return false;
                  const prior = already.get(p);
                  if (!prior) return true;
                  if (mode === "ocr" && !prior.ocr) return true;
                  if (mode === "vision" && !prior.desc.trim()) return true;
                  if (!prior.mtimeMs) return false;
                  try {
                    return statSync(p).mtimeMs > prior.mtimeMs;
                  } catch {
                    return false;
                  }
                });
                const job: IndexJob = {
                  running: true,
                  done: 0,
                  total: todo.length,
                  failed: 0,
                  spentUsd: 0,
                  model,
                  mode,
                  startedAt: Date.now(),
                  stop: false,
                  lastError: null,
                };
                indexJob = job;
                visionEstimateCache = undefined;
                res.end(
                  JSON.stringify({
                    ok: true,
                    queued: todo.length,
                    model,
                    mode,
                    estimatedUsd:
                      mode === "vision" ? todo.length * VISION_ESTIMATE_USD_PER_IMAGE : 0,
                  }),
                );
                // Fire and forget; status endpoint reports progress. Three at
                // a time keeps it quick without hammering the rate limit.
                void (async () => {
                  const queue = [...todo];
                  // Every worker mutates the job it was started for. Reading
                  // the global would let a stopped run drive its successor's
                  // counters and flip that run's `running` flag early.
                  const worker = async () => {
                    while (queue.length && !job.stop) {
                      const file = queue.shift()!;
                      try {
                        const prior = readDesignIndex().get(file);
                        const entry =
                          mode === "vision"
                            ? await describeOne(key!, model, file)
                            : ({
                                path: file,
                                desc: prior?.desc ?? "",
                                tags: prior?.tags ?? [],
                                text: await readImageText(file),
                                ocr: "apple-vision",
                                model: prior?.model ?? model,
                                ts: Date.now(),
                                mtimeMs: statSync(file).mtimeMs,
                              } satisfies IndexEntry);
                        if (entry) {
                          if (mode === "vision" && typeof entry.costUsd === "number") {
                            job.spentUsd += entry.costUsd;
                          }
                          if (mode === "vision" && prior?.ocr) {
                            entry.text = prior.text ?? "";
                            entry.ocr = prior.ocr;
                          }
                          mkdirSync(join(homedir(), ".claude-os", "design"), { recursive: true });
                          appendFileSync(designIndexPath(), JSON.stringify(entry) + "\n");
                        }
                        job.done++;
                      } catch (e: any) {
                        job.failed++;
                        job.lastError = String(e?.message ?? e).slice(0, 200);
                      }
                    }
                  };
                  await Promise.all([worker(), worker(), worker()]);
                  job.running = false;
                  visionEstimateCache = undefined;
                })();
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err?.message ?? "index start failed" }));
              }
            });
          });

          // POST /__design_index_stop
          server.middlewares.use("/__design_index_stop", (req, res, next) => {
            if (req.method !== "POST") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req) || req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "forbidden" }));
              return;
            }
            if (indexJob) indexJob.stop = true;
            res.end(JSON.stringify({ ok: true }));
          });

          // GET /__design_search?q=… — exact-word search across filenames,
          // image OCR, visual descriptions and generation prompts.
          server.middlewares.use("/__design_search", (req, res, next) => {
            if (req.method !== "GET") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            try {
              const url = new URL(req.url ?? "", "http://localhost");
              const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
              if (!q) {
                res.end(JSON.stringify({ ok: true, q: "", hits: [] }));
                return;
              }
              const normalize = (value: string) =>
                value
                  .toLowerCase()
                  .normalize("NFKD")
                  .replace(/[^\p{L}\p{N}]+/gu, " ")
                  .trim();
              const STOP = new Set([
                "the",
                "a",
                "an",
                "of",
                "in",
                "on",
                "with",
                "and",
                "that",
                "for",
                "it",
                "is",
                "to",
              ]);
              const phrase = normalize(q);
              const queryWords = phrase.split(/\s+/).filter(Boolean);
              const meaningful = queryWords.filter((word) => word.length > 1 && !STOP.has(word));
              const terms = meaningful.length ? meaningful : queryWords;
              const idx = readDesignIndex();
              const ledger = readDesignLedger();
              const promptByPath = new Map(ledger.map((e) => [e.path, String(e.prompt ?? "")]));
              const seen = new Set<string>();
              const scored: Array<{ path: string; score: number; desc: string; why: string }> = [];
              const consider = (
                path: string,
                desc: string,
                tags: string[],
                prompt: string,
                text = "",
              ) => {
                if (seen.has(path)) return;
                seen.add(path);
                const filename = designPosix(path).split("/").pop() ?? "";
                const fields = [
                  { why: "text", weight: 8, value: normalize(text) },
                  { why: "described", weight: 5, value: normalize(tags.join(" ")) },
                  { why: "described", weight: 4, value: normalize(desc) },
                  { why: "filename", weight: 4, value: normalize(filename) },
                  { why: "prompt", weight: 2, value: normalize(prompt) },
                ];
                const wordSets = fields.map(
                  (field) => new Set(field.value.split(/\s+/).filter(Boolean)),
                );
                let score = 0;
                let matched = 0;
                let why = "prompt";
                for (const t of terms) {
                  let best = 0;
                  for (let i = 0; i < fields.length; i++) {
                    if (!wordSets[i].has(t) || fields[i].weight <= best) continue;
                    best = fields[i].weight;
                    why = fields[i].why;
                  }
                  if (best > 0) {
                    matched++;
                    score += best;
                  }
                }
                // Two-word searches must match both meaningful words. Longer
                // searches may miss one word without turning into broad OR
                // matching. This is what stops `real` matching `really` in a
                // random video prompt and swamping the intended image.
                const required = terms.length <= 2 ? terms.length : Math.ceil(terms.length * 0.75);
                if (matched >= required && score > 0) {
                  for (const field of fields) {
                    if (phrase && field.value.includes(phrase)) {
                      score += field.weight * 3;
                      why = field.why;
                      break;
                    }
                  }
                  scored.push({
                    path,
                    score,
                    desc,
                    why,
                  });
                }
              };
              // A described file that's since been deleted is not a result.
              for (const [path, e] of idx) {
                if (!existsSync(path)) continue;
                consider(path, e.desc, e.tags ?? [], promptByPath.get(path) ?? "", e.text ?? "");
              }
              for (const e of ledger) consider(e.path, "", [], String(e.prompt ?? ""));
              scored.sort((a, b) => b.score - a.score);
              res.setHeader("Cache-Control", "no-store");
              res.end(
                JSON.stringify({
                  ok: true,
                  q,
                  indexed: idx.size,
                  hits: scored.slice(0, 200).map((h) => ({
                    id: Buffer.from(h.path).toString("base64url"),
                    path: h.path,
                    desc: h.desc,
                    why: h.why,
                    score: h.score,
                  })),
                }),
              );
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err?.message ?? "search failed" }));
            }
          });

          // GET /__memory_note?vault=<name>&id=<basename> — read the FULL
          // markdown body of one Obsidian note so the Memory page can show and
          // COPY the whole document (the graph only carries a short excerpt).
          // Resolves the vault root from Obsidian's own registry, finds the
          // .md file whose basename matches the note id (case-insensitive),
          // and returns its content. Path-safety: the resolved file MUST live
          // inside the matched vault root (blocks ../ traversal). Loopback only.
          server.middlewares.use("/__memory_note", (req, res, next) => {
            if (req.method !== "GET") return next();
            res.setHeader("Content-Type", "application/json");
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            try {
              const url = new URL(req.url ?? "", "http://localhost");
              const wantVault = (url.searchParams.get("vault") ?? "").trim().toLowerCase();
              const wantId = (url.searchParams.get("id") ?? "").trim().toLowerCase();
              if (!wantId) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "missing id" }));
                return;
              }
              // Resolve candidate vault roots from Obsidian's registry.
              let roots: string[] = [];
              try {
                const appSup =
                  process.platform === "darwin"
                    ? join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json")
                    : process.platform === "win32"
                      ? join(
                          process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
                          "obsidian",
                          "obsidian.json",
                        )
                      : join(homedir(), ".config", "obsidian", "obsidian.json");
                if (existsSync(appSup)) {
                  const parsed = JSON.parse(readFileSync(appSup, "utf-8"));
                  roots = Object.values(parsed?.vaults ?? {})
                    .map((v: any) => (typeof v?.path === "string" ? v.path : null))
                    .filter((p): p is string => Boolean(p));
                }
              } catch {
                /* no registry — roots stays empty */
              }
              // If a vault name was given, prefer the root whose basename matches.
              const norm = (p: string) => {
                try {
                  return realpathSync(p);
                } catch {
                  return resolve(p);
                }
              };
              const rootsByPref = roots
                .map(norm)
                .filter((r) => existsSync(r) && statSync(r).isDirectory())
                .sort((a, b) => {
                  const am = a.split(sep).pop()?.toLowerCase() === wantVault ? 0 : 1;
                  const bm = b.split(sep).pop()?.toLowerCase() === wantVault ? 0 : 1;
                  return am - bm;
                });
              // Bounded recursive search for <id>.md within a root.
              const findNote = (root: string): string | null => {
                const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
                let scanned = 0;
                while (stack.length) {
                  const { dir, depth } = stack.pop()!;
                  if (depth > 8 || scanned > 8000) break;
                  let entries: any[] = [];
                  try {
                    entries = readdirSync(dir, { withFileTypes: true });
                  } catch {
                    continue;
                  }
                  for (const e of entries) {
                    scanned++;
                    if (e.name.startsWith(".")) continue;
                    const full = join(dir, e.name);
                    if (e.isDirectory()) {
                      if (depth < 8) stack.push({ dir: full, depth: depth + 1 });
                    } else if (
                      e.isFile() &&
                      e.name.toLowerCase().endsWith(".md") &&
                      e.name.slice(0, -3).toLowerCase() === wantId
                    ) {
                      return full;
                    }
                  }
                }
                return null;
              };
              let filePath: string | null = null;
              let matchedRoot = "";
              for (const root of rootsByPref) {
                const f = findNote(root);
                if (f) {
                  filePath = f;
                  matchedRoot = root;
                  break;
                }
              }
              if (!filePath) {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "note not found" }));
                return;
              }
              // Path-safety: the file must sit inside the matched vault root.
              const safe = norm(filePath);
              if (!safe.startsWith(matchedRoot + sep) && safe !== matchedRoot) {
                res.statusCode = 403;
                res.end(JSON.stringify({ error: "outside vault" }));
                return;
              }
              const content = readFileSync(safe, "utf-8").slice(0, 400_000);
              res.setHeader("Cache-Control", "no-store");
              res.end(JSON.stringify({ ok: true, id: wantId, content }));
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err?.message ?? "read failed" }));
            }
          });

          // GET /__hermes_memory — universal memory readout for whichever
          // Hermes install is on this box. Respects $HERMES_HOME with a
          // fallback to ~/.hermes (per Hermes' own spec), so the dashboard
          // works for anyone who's installed Hermes in a non-default dir.
          // Returns:
          //   hermesHome             — resolved path
          //   user                   — { content, charCount, charLimit }
          //   memory                 — { content, charCount, charLimit }
          //   soul                   — { content, charCount, isTemplate }
          //                            (SOUL is the personality file, NOT
          //                            memory — surfaced separately so the
          //                            dashboard can render it differently)
          //   provider               — { active, available[] }
          //   profiles               — per-profile { name, hasMemory, hasUser, hasSoul }
          //   sessionCount, skillCount — quick counts so the dashboard can
          //                              render a system-wide overview
          //                              without firing 4 endpoints.
          // Loopback only.
          // ────────────────────────────────────────────────────────────────
          server.middlewares.use("/__hermes_memory", async (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const hermesHome = process.env.HERMES_HOME || join(homedir(), ".hermes");

            // Memory files — read MEMORY.md/USER.md and pair with the
            // configured char limit from config.yaml (2200 default).
            function safeRead(p: string): string {
              try {
                return readFileSync(p, "utf-8");
              } catch {
                return "";
              }
            }
            function parseCharLimit(): number {
              try {
                const cfg = readFileSync(join(hermesHome, "config.yaml"), "utf-8");
                const m = cfg.match(/memory_char_limit:\s*(\d+)/);
                if (m) return Number.parseInt(m[1] ?? "2200", 10);
              } catch {
                /* default */
              }
              return 2200;
            }
            const charLimit = parseCharLimit();

            const memoryDir = join(hermesHome, "memories");
            const userContent = safeRead(join(memoryDir, "USER.md"));
            const memoryContent = safeRead(join(memoryDir, "MEMORY.md"));
            const soulContent = safeRead(join(hermesHome, "SOUL.md"));
            // Default SOUL.md ships with only a comment block; detect that
            // so the dashboard can render a "define your voice" CTA rather
            // than rendering boilerplate comments as the persona.
            const stripped = soulContent
              .replace(/<!--[\s\S]*?-->/g, "")
              .replace(/^---[\s\S]*?---/, "")
              .trim();
            const isTemplate = stripped.length === 0;

            // Provider status — shell out to `hermes memory status` for
            // the authoritative list. Best-effort; fall back to empty.
            let providerActive: string | null = null;
            const providerAvailable: Array<{ name: string; needsKey: boolean }> = [];
            try {
              const raw = execSync("hermes memory status", {
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
                env: { ...process.env, NO_COLOR: "1" },
                timeout: 4000,
              });
              const lines = raw.split("\n");
              for (const line of lines) {
                const clean = line.trim();
                if (!clean) continue;
                // Active provider line — "Provider: name" or "(none …)"
                const provMatch = clean.match(/^Provider:\s*([a-z0-9_-]+)/i);
                if (provMatch) providerActive = provMatch[1] ?? null;
                // Available plugin rows — "• name  (requires API key)" etc.
                const pluginMatch = clean.match(/^[•·*]\s+([a-z0-9_-]+)\s*(?:\(([^)]+)\))?/i);
                if (pluginMatch) {
                  const name = pluginMatch[1] ?? "";
                  const meta = (pluginMatch[2] ?? "").toLowerCase();
                  const needsKey =
                    /(requires|needs)\s+api\s*key/.test(meta) || /api\s+key/.test(meta);
                  if (name) providerAvailable.push({ name, needsKey });
                }
              }
            } catch {
              /* hermes binary missing — leave defaults */
            }

            // Per-profile memory — Hermes profiles live at
            // $HERMES_HOME/profiles/<name>/ and each has its own
            // memories/, SOUL.md, sessions/, etc.
            const profilesDir = join(hermesHome, "profiles");
            const profiles: Array<{
              name: string;
              hasMemory: boolean;
              hasUser: boolean;
              hasSoul: boolean;
            }> = [];
            try {
              if (existsSync(profilesDir)) {
                const entries = readdirSync(profilesDir, { withFileTypes: true }).filter(
                  (e) => e.isDirectory() && !e.name.startsWith("."),
                );
                for (const e of entries) {
                  const dir = join(profilesDir, e.name);
                  profiles.push({
                    name: e.name,
                    hasMemory: existsSync(join(dir, "memories", "MEMORY.md")),
                    hasUser: existsSync(join(dir, "memories", "USER.md")),
                    hasSoul: existsSync(join(dir, "SOUL.md")),
                  });
                }
              }
            } catch {
              /* surface empty */
            }

            // Quick counts for the readout. sessions/ grows unbounded, so its
            // readdir runs async (off the main event loop) — a synchronous scan
            // here would pin the server on a cold start exactly like the sessions
            // list did.
            let sessionCount = 0;
            try {
              const sd = join(hermesHome, "sessions");
              const names = await readdirAsync(sd);
              sessionCount = names.filter((f) => f.endsWith(".json")).length;
            } catch {
              /* missing / unreadable — leave 0 */
            }
            let skillCount = 0;
            try {
              const sd = join(hermesHome, "skills");
              if (existsSync(sd)) {
                skillCount = readdirSync(sd, { withFileTypes: true }).filter(
                  (e) => e.isDirectory() && !e.name.startsWith("."),
                ).length;
              }
            } catch {
              /* ignore */
            }

            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(
              JSON.stringify({
                hermesHome,
                user: {
                  content: userContent,
                  charCount: userContent.length,
                  charLimit,
                  path: join(memoryDir, "USER.md"),
                },
                memory: {
                  content: memoryContent,
                  charCount: memoryContent.length,
                  charLimit,
                  path: join(memoryDir, "MEMORY.md"),
                },
                soul: {
                  content: soulContent,
                  charCount: soulContent.length,
                  isTemplate,
                  path: join(hermesHome, "SOUL.md"),
                },
                provider: { active: providerActive, available: providerAvailable },
                profiles,
                sessionCount,
                skillCount,
              }),
            );
          });

          // GET /__hermes_sessions — summary of recent sessions from
          // ~/.hermes/sessions/*.json. Returns last 20 with model,
          // message count, system prompt preview, start/end timestamps.
          // Loopback only.
          server.middlewares.use("/__hermes_sessions", async (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            // 8s cache — the /agents/hermes ActivityCard refetches this on every
            // mount and it's the heaviest read on the page. A cold hit computes
            // once; concurrent mount requests then serve from memory instead of
            // each re-scanning the sessions directory.
            if (sendCached("hermes-sessions", res)) return;
            const sessionsDir = join(homedir(), ".hermes", "sessions");
            const out: Array<{
              id: string;
              model: string | null;
              platform: string | null;
              messageCount: number;
              startedAt: string | null;
              lastUpdated: string | null;
              firstUserMessage: string | null;
            }> = [];
            try {
              // Bounded + non-blocking (see listRecentSessions): readdir/stat run
              // off the main event loop and only the newest candidates are
              // stat()'d, so a sessions dir with hundreds of thousands of files
              // can't pin the server on a cold start. The 200 cap feeds the
              // ActivityCard's 7-day bar chart (~3 weeks of heavy use); older
              // <ts>_<id>.jsonl files are included too.
              const files = await listRecentSessions(sessionsDir, 200);
              {
                for (const f of files) {
                  try {
                    const raw = await readFileAsync(join(sessionsDir, f.name), "utf-8");
                    // JSON: parse normally. JSONL: only first line is the
                    // session_meta header we care about — peel it off.
                    const isJsonl = f.name.endsWith(".jsonl");
                    const j = isJsonl
                      ? (() => {
                          const firstLine = raw.split("\n").find((l) => l.trim().length > 0);
                          if (!firstLine) return null;
                          try {
                            return JSON.parse(firstLine);
                          } catch {
                            return null;
                          }
                        })()
                      : JSON.parse(raw);
                    const msgs = Array.isArray(j?.messages) ? j.messages : [];
                    // First user-typed message preview — handle multimodal
                    // content arrays gracefully (Hermes stores some
                    // messages as [{type:"text", text:"..."}] arrays).
                    const userMsg = msgs.find((m: any) => m?.role === "user");
                    let firstUser: string | null = null;
                    if (typeof userMsg?.content === "string") firstUser = userMsg.content;
                    else if (Array.isArray(userMsg?.content)) {
                      const textPart = userMsg.content.find((c: any) => c?.type === "text");
                      if (typeof textPart?.text === "string") firstUser = textPart.text;
                    }
                    // Timestamp fallback: prefer explicit fields, else use
                    // the file's mtime. Without this, sessions whose JSON
                    // schema is missing session_start (older Hermes
                    // versions / JSONL format) were invisible to the
                    // 7-day bar chart and got bucketed as 0/week.
                    const mtimeIso = new Date(f.mtime).toISOString();
                    out.push({
                      id: j?.session_id ?? f.name.replace(/\.(json|jsonl)$/, ""),
                      model: j?.model ?? null,
                      platform: j?.platform ?? null,
                      messageCount:
                        typeof j?.message_count === "number" ? j.message_count : msgs.length,
                      startedAt: j?.session_start ?? mtimeIso,
                      lastUpdated: j?.last_updated ?? mtimeIso,
                      firstUserMessage:
                        typeof firstUser === "string" ? firstUser.slice(0, 200) : null,
                    });
                  } catch {
                    /* skip unreadable session */
                  }
                }
              }
            } catch {
              /* ignore */
            }
            // ALSO ingest live ongoing threads from sessions.json — the
            // master conversation index. Hermes 0.13+ reuses ONE active
            // session per platform thread (e.g. one Telegram DM thread
            // stays open across days of messages) and only flushes to a
            // session_*.json file when the thread closes or restarts.
            // Without reading the index, daily Telegram users showed
            // "last active 5 days ago" even when actively chatting,
            // because the index's `updated_at` was the only signal that
            // ever ticked forward. Index entries are merged on
            // session_id — if a session_*.json already exists for the
            // same id, the file's record wins (it has full messages);
            // otherwise we surface the index entry as a thin session.
            try {
              const indexPath = join(sessionsDir, "sessions.json");
              if (existsSync(indexPath)) {
                const indexRaw = await readFileAsync(indexPath, "utf-8");
                const indexJson = JSON.parse(indexRaw);
                const knownIds = new Set(out.map((s) => s.id));
                for (const [_threadKey, info] of Object.entries(indexJson)) {
                  if (!info || typeof info !== "object") continue;
                  const i = info as Record<string, any>;
                  const sid = i.session_id;
                  if (typeof sid !== "string" || knownIds.has(sid)) continue;
                  // Build a virtual session entry from the index.
                  out.push({
                    id: sid,
                    model: i.model ?? null,
                    platform: i.platform ?? null,
                    messageCount: typeof i.message_count === "number" ? i.message_count : 0,
                    startedAt: i.created_at ?? null,
                    lastUpdated: i.updated_at ?? i.created_at ?? null,
                    firstUserMessage: null,
                  });
                }
                // Re-sort the merged list newest-first so the dashboard
                // shows live threads at the top.
                out.sort((a, b) => {
                  const at = a.lastUpdated || a.startedAt || "";
                  const bt = b.lastUpdated || b.startedAt || "";
                  return bt.localeCompare(at);
                });
              }
            } catch {
              /* index unreadable — return file-only list */
            }
            // ALSO ingest sessions from ~/.hermes/state.db — Hermes 0.17+
            // stopped flushing per-session .jsonl files and records every
            // chat (CLI + dashboard turns included) in sqlite instead.
            // Without this read, everything after the migration was
            // invisible to the sidebar. DB rows win over legacy files on
            // id collision (they carry live message counts).
            try {
              const rows = queryHermesStateDb(
                "SELECT s.id, s.model, s.source, s.message_count, s.started_at, s.ended_at, (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.timestamp LIMIT 1) AS first_user FROM sessions s WHERE s.archived = 0 ORDER BY s.started_at DESC LIMIT 200",
              );
              if (rows) {
                // DB rows win over legacy files on id collision — they carry
                // the LIVE message_count / timestamps (an ongoing thread's
                // flushed file is stale). So drop any legacy entry that the DB
                // also has, and index the survivors for de-dup.
                const dbIds = new Set(rows.map((r) => String(r.id ?? "")).filter(Boolean));
                for (let k = out.length - 1; k >= 0; k--) {
                  if (dbIds.has(out[k].id)) out.splice(k, 1);
                }
                const known = new Set(out.map((s) => s.id));
                for (const r of rows) {
                  const sid = String(r.id ?? "");
                  if (!sid || known.has(sid)) continue;
                  known.add(sid);
                  // Multimodal user messages store content as a JSON array —
                  // pull the first text part for the preview.
                  let firstUser: string | null =
                    typeof r.first_user === "string" ? r.first_user : null;
                  if (firstUser && firstUser.trim().startsWith("[")) {
                    try {
                      const arr = JSON.parse(firstUser);
                      const t = Array.isArray(arr)
                        ? arr.find((c: any) => typeof c?.text === "string")
                        : null;
                      firstUser = t?.text ?? firstUser;
                    } catch {
                      /* keep raw */
                    }
                  }
                  const toIso = (v: any) =>
                    typeof v === "number" ? new Date(v * 1000).toISOString() : null;
                  out.push({
                    id: sid,
                    model: r.model ?? null,
                    platform: r.source ?? null,
                    messageCount: typeof r.message_count === "number" ? r.message_count : 0,
                    startedAt: toIso(r.started_at),
                    lastUpdated: toIso(r.ended_at) ?? toIso(r.started_at),
                    firstUserMessage:
                      typeof firstUser === "string" ? firstUser.slice(0, 200) : null,
                  });
                }
                out.sort((a, b) => {
                  const at = a.lastUpdated || a.startedAt || "";
                  const bt = b.lastUpdated || b.startedAt || "";
                  return bt.localeCompare(at);
                });
              }
            } catch {
              /* state.db unreadable — return file-based list */
            }
            // Final de-dup by id (a session can surface from more than one
            // source — legacy .json, legacy .jsonl, the sessions.json index).
            // Keep the first occurrence, then sort newest-first so the sidebar
            // never renders duplicate keys or a stale copy above a live one.
            const seenIds = new Set<string>();
            const deduped = out.filter((s) => {
              if (!s.id || seenIds.has(s.id)) return false;
              seenIds.add(s.id);
              return true;
            });
            deduped.sort((a, b) => {
              const at = a.lastUpdated || a.startedAt || "";
              const bt = b.lastUpdated || b.startedAt || "";
              return bt.localeCompare(at);
            });
            const body = JSON.stringify({ sessions: deduped });
            storeCached("hermes-sessions", 8000, body);
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(body);
          });

          // GET /__hermes_session?id=<session_id> — full message list for one
          // session, so the dashboard can render a Telegram-style sidebar:
          // click a thread, see its history. Loopback only. Returns the
          // session_id, model, platform, and full messages array.
          server.middlewares.use("/__hermes_session", async (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const url = new URL(req.url || "", "http://localhost");
            const id = url.searchParams.get("id");
            // Length-capped + charset-locked. The charset (no quotes) is what
            // keeps the id safe to embed in the state.db SQL below — keep it
            // strict; widening it (e.g. adding '.'/':') would open SQLi there.
            if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid id" }));
              return;
            }
            const sessionsDir = join(homedir(), ".hermes", "sessions");
            // Hermes session files include a timestamp prefix, so we search by
            // suffix match. readdir runs async (off the main event loop) — this
            // scans the whole directory to find the match, so a synchronous read
            // would block every route on a large sessions dir, same as the list.
            let match: string | null = null;
            try {
              const files = (await readdirAsync(sessionsDir)).filter((f) => f.endsWith(".json"));
              // Match on the id as a whole FILENAME SEGMENT — never a loose
              // substring. A bare `includes(id)` let a request for "abc" open
              // "session_..._abcdef.json" (a different conversation). Accept
              // only: exact name, exact stem, or the id as the trailing
              // `_<id>.json` segment (Hermes' `<ts>_<id>.json` layout).
              for (const f of files) {
                const stem = f.replace(/\.json$/, "");
                if (f === id || stem === id || stem.endsWith(`_${id}`)) {
                  match = f;
                  break;
                }
              }
            } catch {
              /* ignore */
            }
            if (!match) {
              // No legacy file — try Hermes 0.17+'s sqlite store. The id is
              // regex-validated above, so embedding it in SQL is safe.
              const rows = queryHermesStateDb(
                `SELECT role, content, timestamp FROM messages WHERE session_id = '${id}' AND role IN ('user','assistant') ORDER BY timestamp`,
              );
              const meta = queryHermesStateDb(
                `SELECT model, source, started_at, ended_at FROM sessions WHERE id = '${id}' LIMIT 1`,
              )?.[0];
              if (rows && rows.length > 0) {
                const clean = rows.map((m) => {
                  let content = typeof m.content === "string" ? m.content : "";
                  // Multimodal messages store content as a JSON array of parts.
                  if (content.trim().startsWith("[")) {
                    try {
                      const arr = JSON.parse(content);
                      if (Array.isArray(arr))
                        content = arr
                          .map((c: any) =>
                            typeof c === "string" ? c : (c?.text ?? c?.content ?? ""),
                          )
                          .filter(Boolean)
                          .join("\n");
                    } catch {
                      /* keep raw */
                    }
                  }
                  return {
                    role: m.role ?? "unknown",
                    content,
                    ts:
                      typeof m.timestamp === "number"
                        ? new Date(m.timestamp * 1000).toISOString()
                        : null,
                  };
                });
                const toIso = (v: any) =>
                  typeof v === "number" ? new Date(v * 1000).toISOString() : null;
                res.setHeader("Content-Type", "application/json");
                res.setHeader("Cache-Control", "no-store");
                res.end(
                  JSON.stringify({
                    sessionId: id,
                    model: meta?.model ?? null,
                    platform: meta?.source ?? null,
                    startedAt: toIso(meta?.started_at),
                    lastUpdated: toIso(meta?.ended_at) ?? toIso(meta?.started_at),
                    messages: clean,
                  }),
                );
                return;
              }
              res.statusCode = 404;
              res.end(JSON.stringify({ error: "not found" }));
              return;
            }
            try {
              const raw = await readFileAsync(join(sessionsDir, match), "utf-8");
              const j = JSON.parse(raw);
              const msgs = Array.isArray(j.messages) ? j.messages : [];
              // Surface only what the UI needs — drop system prompts and
              // raw tool blobs from the response payload.
              const clean = msgs.map((m: any) => ({
                role: m?.role ?? "unknown",
                content:
                  typeof m?.content === "string"
                    ? m.content
                    : Array.isArray(m?.content)
                      ? m.content
                          .map((c: any) =>
                            typeof c === "string" ? c : (c?.text ?? c?.content ?? ""),
                          )
                          .join("\n")
                      : "",
                ts: m?.timestamp ?? null,
              }));
              res.setHeader("Content-Type", "application/json");
              res.setHeader("Cache-Control", "no-store");
              res.end(
                JSON.stringify({
                  sessionId: j.session_id ?? id,
                  model: j.model ?? null,
                  platform: j.platform ?? null,
                  startedAt: j.session_start ?? null,
                  lastUpdated: j.last_updated ?? null,
                  messages: clean,
                }),
              );
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err?.message ?? "read failed" }));
            }
          });

          // ───────────────────────────────────────────────────────────────
          // DOCUMENTS GALLERY — three middlewares for the Hermes-page
          // "documents" surface. Source folder: ~/Documents/Hermes/
          // (auto-created on first hit so a fresh operator gets an empty
          // gallery instead of an error). Drag/save anything here and
          // it appears on the dashboard within 5 seconds (the gallery
          // polls). Click-to-delete removes from disk.
          //
          //   GET    /__hermes_documents             → list metadata
          //   GET    /__hermes_documents/file?name=  → stream one file
          //   DELETE /__hermes_documents?name=       → delete one file
          //
          // All three: loopback-only, path-traversal guarded
          // (filename must be a bare basename — no slashes, no `..`).
          // ───────────────────────────────────────────────────────────────
          const DOCUMENTS_DIR = join(homedir(), "Documents", "Hermes");
          // Soft-delete target. Files moved here on DELETE; the restore
          // endpoint moves them back. The dotfile prefix means listing
          // already skips this dir, so it doesn't show in the gallery.
          const TRASH_DIR = join(DOCUMENTS_DIR, ".trash");

          function ensureDocumentsDir() {
            try {
              if (!existsSync(DOCUMENTS_DIR)) {
                mkdirSync(DOCUMENTS_DIR, { recursive: true });
              }
            } catch {
              /* ignore — listing will return empty */
            }
          }

          function ensureTrashDir() {
            try {
              if (!existsSync(TRASH_DIR)) {
                mkdirSync(TRASH_DIR, { recursive: true });
              }
            } catch {
              /* ignore — soft-delete will fall back to hard-delete */
            }
          }

          // Trash IDs encode the original filename so restore can move
          // the file back without needing a separate manifest. Format:
          // {timestamp}__{originalname}. The timestamp prefix makes them
          // unique even across rapid same-name deletions.
          function safeTrashId(id: string | null): string | null {
            if (!id) return null;
            if (id.length === 0 || id.length > 320) return null;
            if (id.includes("/") || id.includes("\\")) return null;
            if (id.includes("..")) return null;
            if (!id.includes("__")) return null;
            return id;
          }

          function originalNameFromTrashId(id: string): string | null {
            // id = "{ms}__{originalname}". Split on the first __ only —
            // the original filename can contain __ in rare cases.
            const idx = id.indexOf("__");
            if (idx < 0) return null;
            const name = id.slice(idx + 2);
            return safeDocName(name);
          }

          function safeDocName(name: string | null): string | null {
            if (!name) return null;
            // Reject path-traversal, absolute paths, hidden files,
            // anything that contains a separator. Filename must be a
            // bare basename of reasonable length.
            if (name.length === 0 || name.length > 255) return null;
            if (name.includes("/") || name.includes("\\")) return null;
            if (name.includes("..")) return null;
            if (name.startsWith(".")) return null;
            return name;
          }

          // Symlink-safe path resolver. safeDocName() blocks string-form
          // path traversal but does NOT stop symlinks — an operator (or
          // attacker) could drop ~/Documents/Hermes/secret.html as a
          // symlink to ~/.ssh/id_rsa, and renameSync() would silently
          // move the private key into .trash/, or readFileSync() would
          // stream it back over the loopback endpoint. realpathSync()
          // follows every symlink to the true on-disk path; if that
          // path doesn't live inside DOCUMENTS_DIR or TRASH_DIR, we
          // refuse the operation. Returns the safe absolute path or
          // null if it would escape.
          let DOCUMENTS_DIR_REAL: string | null = null;
          let TRASH_DIR_REAL: string | null = null;
          function resolveInsideDocs(rawPath: string, allowTrash = false): string | null {
            try {
              // Cache the real root paths after first successful resolve
              // (cheap), so we don't realpath() the same dirs every call.
              if (DOCUMENTS_DIR_REAL === null) {
                DOCUMENTS_DIR_REAL = realpathSync(DOCUMENTS_DIR);
              }
              if (allowTrash && TRASH_DIR_REAL === null && existsSync(TRASH_DIR)) {
                TRASH_DIR_REAL = realpathSync(TRASH_DIR);
              }
              const real = realpathSync(rawPath);
              const docPrefix = DOCUMENTS_DIR_REAL + sep;
              if (real === DOCUMENTS_DIR_REAL || real.startsWith(docPrefix)) {
                return real;
              }
              if (allowTrash && TRASH_DIR_REAL) {
                const trashPrefix = TRASH_DIR_REAL + sep;
                if (real === TRASH_DIR_REAL || real.startsWith(trashPrefix)) {
                  return real;
                }
              }
              return null;
            } catch {
              // ENOENT / ELOOP / permission errors all collapse to "no".
              return null;
            }
          }

          function classifyDoc(ext: string): string {
            const e = ext.toLowerCase().replace(/^\./, "");
            if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"].includes(e))
              return "image";
            if (["pdf"].includes(e)) return "pdf";
            if (["html", "htm"].includes(e)) return "html";
            if (["md", "markdown", "mdx"].includes(e)) return "markdown";
            if (["txt", "log"].includes(e)) return "text";
            if (["json", "yaml", "yml", "toml", "csv", "tsv"].includes(e)) return "data";
            if (["mp4", "mov", "webm", "mkv", "avi"].includes(e)) return "video";
            if (["mp3", "wav", "ogg", "m4a", "flac"].includes(e)) return "audio";
            if (["zip", "tar", "gz", "tgz", "7z", "rar"].includes(e)) return "archive";
            if (
              ["ts", "tsx", "js", "jsx", "py", "rb", "go", "rs", "java", "c", "cpp", "sh"].includes(
                e,
              )
            )
              return "code";
            return "other";
          }

          // Read at most this many bytes per file when parsing the
          // title + description metadata. Big enough to catch frontmatter
          // and HTML <head>, small enough that a folder full of multi-MB
          // PDFs still lists in milliseconds.
          const META_READ_CAP = 4096;

          // Per-type metadata parser. Returns { title, description } —
          // either may be null. Hermes is asked (via the onboarding prompt)
          // to embed these explicitly so we get clean strings; the
          // fallbacks here mean even files without explicit metadata still
          // render with something better than the raw filename.
          function parseDocMeta(
            path: string,
            type: string,
          ): { title: string | null; description: string | null } {
            // Skip types that can't be cheaply parsed for text metadata.
            if (["image", "pdf", "video", "audio", "archive"].includes(type)) {
              return { title: null, description: null };
            }
            let head: string;
            try {
              const buf = readFileSync(path);
              head = buf.subarray(0, META_READ_CAP).toString("utf8");
            } catch {
              return { title: null, description: null };
            }

            // Trim a string to N words, with an ellipsis if truncated.
            // Kept loose — the operator-side word caps are soft.
            const trimWords = (s: string | null, n: number): string | null => {
              if (!s) return null;
              const cleaned = s.replace(/\s+/g, " ").trim();
              if (!cleaned) return null;
              const parts = cleaned.split(" ");
              if (parts.length <= n) return cleaned;
              return parts.slice(0, n).join(" ") + "…";
            };

            let title: string | null = null;
            let description: string | null = null;

            if (type === "html") {
              // Explicit hermes-* meta tags win — that's what Hermes is
              // asked to emit. Fall back to <title> and the standard
              // <meta name="description"> so non-Hermes HTML still works.
              const metaTitle = head.match(
                /<meta\s+name=["']hermes-title["']\s+content=["']([^"']+)["']/i,
              );
              const metaDesc = head.match(
                /<meta\s+name=["']hermes-description["']\s+content=["']([^"']+)["']/i,
              );
              const fallbackTitle = head.match(/<title>([^<]+)<\/title>/i);
              const fallbackDesc = head.match(
                /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i,
              );
              title = metaTitle?.[1] ?? fallbackTitle?.[1] ?? null;
              description = metaDesc?.[1] ?? fallbackDesc?.[1] ?? null;
            } else if (type === "markdown") {
              // YAML frontmatter first, then fall back to first # heading
              // + first paragraph.
              const fm = head.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
              if (fm) {
                const t = fm[1].match(/^title:\s*(.+)$/m);
                const d = fm[1].match(/^description:\s*(.+)$/m);
                if (t) title = t[1].replace(/^["']|["']$/g, "").trim();
                if (d) description = d[1].replace(/^["']|["']$/g, "").trim();
              }
              if (!title) {
                const h1 = head.match(/^#\s+(.+?)\s*$/m);
                if (h1) title = h1[1];
              }
              if (!description) {
                // Strip frontmatter + heading, then first paragraph.
                const body = head
                  .replace(/^---[\s\S]*?\n---\s*\n/, "")
                  .replace(/^#.+$/m, "")
                  .trim();
                const para = body.split(/\n\s*\n/).find((p) => p.trim());
                if (para) description = para.replace(/[*_`]/g, "").trim();
              }
            } else if (type === "data") {
              // JSON: look for top-level title/description, or _hermes.{title,description}.
              if (path.endsWith(".json")) {
                try {
                  const parsed = JSON.parse(head);
                  title = parsed?._hermes?.title ?? parsed?.title ?? parsed?.name ?? null;
                  description =
                    parsed?._hermes?.description ?? parsed?.description ?? parsed?.summary ?? null;
                  if (typeof title !== "string") title = null;
                  if (typeof description !== "string") description = null;
                } catch {
                  // Truncated JSON inside the 4KB window — try a permissive
                  // regex on the head instead.
                  const t = head.match(/"title"\s*:\s*"([^"]+)"/);
                  const d = head.match(/"description"\s*:\s*"([^"]+)"/);
                  title = t?.[1] ?? null;
                  description = d?.[1] ?? null;
                }
              } else {
                // YAML / TOML / CSV — look for a leading comment pair.
                const t = head.match(/^[#\s]*title:\s*(.+)$/im);
                const d = head.match(/^[#\s]*description:\s*(.+)$/im);
                if (t) title = t[1].trim();
                if (d) description = d[1].trim();
              }
            } else if (type === "text") {
              // Convention: first non-empty line = title, second = description,
              // optionally prefixed with a leading "# " or similar.
              const lines = head
                .split(/\r?\n/)
                .map((l) => l.replace(/^[#\s>*—\-=]+/, "").trim())
                .filter((l) => l.length > 0);
              if (lines[0]) title = lines[0];
              if (lines[1]) description = lines[1];
            } else if (type === "code") {
              // First leading-comment line as title, second as description.
              const lines = head
                .split(/\r?\n/)
                .map((l) => l.replace(/^\s*(\/\/|#|--|\/\*|\*)\s?/, "").trim())
                .filter((l) => l.length > 0 && !l.startsWith("*/"));
              if (lines[0]) title = lines[0];
              if (lines[1]) description = lines[1];
            }

            // Soft caps to keep card layouts tidy. Hermes is asked for
            // ≤5 / ≤15 words; we enforce slightly looser limits server-side
            // so legacy or hand-edited files don't get awkwardly chopped.
            return {
              title: trimWords(title, 8),
              description: trimWords(description, 22),
            };
          }

          // Cache wrapper around parseDocMeta. Keyed on the absolute
          // path; cache hits when mtimeMs AND size both match. The
          // gallery polls every 5s, so without this we'd readFileSync
          // every file on every poll (200 files = 200 syncs / 5s,
          // blocks HMR + the rest of the dev server). Per-process map
          // so it dies with vite reload.
          interface MetaCacheEntry {
            mtimeMs: number;
            size: number;
            meta: { title: string | null; description: string | null };
          }
          const docMetaCache = new Map<string, MetaCacheEntry>();
          function cachedParseDocMeta(
            path: string,
            type: string,
            mtimeMs: number,
            size: number,
          ): { title: string | null; description: string | null } {
            const cached = docMetaCache.get(path);
            if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
              return cached.meta;
            }
            const meta = parseDocMeta(path, type);
            docMetaCache.set(path, { mtimeMs, size, meta });
            // Soft cap on cache size to bound memory if the operator
            // is churning many files. Drop oldest insertion when we
            // exceed 5000 entries — generous given the 1000-file
            // enumeration cap.
            if (docMetaCache.size > 5000) {
              const firstKey = docMetaCache.keys().next().value;
              if (firstKey) docMetaCache.delete(firstKey);
            }
            return meta;
          }

          server.middlewares.use("/__hermes_documents", (req, res, next) => {
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const url = new URL(req.url || "", "http://localhost");
            // GET /__hermes_documents/file?name=… → stream one file with
            // a sensible Content-Type so the preview pane can render it
            // (img tag for images, iframe for html/pdf, fetch+text for
            // markdown/text/code).
            if (req.method === "GET" && url.pathname.endsWith("/file")) {
              const name = safeDocName(url.searchParams.get("name"));
              if (!name) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "invalid name" }));
                return;
              }
              const rawPath = join(DOCUMENTS_DIR, name);
              if (!existsSync(rawPath)) {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "not found" }));
                return;
              }
              // Symlink-escape guard: refuse to serve anything whose
              // real on-disk path escapes ~/Documents/Hermes/. Stops
              // an attacker who can plant a symlink in the folder from
              // exfiltrating ~/.ssh/id_rsa or other arbitrary files.
              const safePath = resolveInsideDocs(rawPath);
              if (!safePath) {
                res.statusCode = 403;
                res.end(JSON.stringify({ error: "path escapes documents folder" }));
                return;
              }
              const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
              const mimeMap: Record<string, string> = {
                png: "image/png",
                jpg: "image/jpeg",
                jpeg: "image/jpeg",
                gif: "image/gif",
                webp: "image/webp",
                svg: "image/svg+xml",
                bmp: "image/bmp",
                ico: "image/x-icon",
                avif: "image/avif",
                pdf: "application/pdf",
                html: "text/html; charset=utf-8",
                htm: "text/html; charset=utf-8",
                md: "text/markdown; charset=utf-8",
                markdown: "text/markdown; charset=utf-8",
                txt: "text/plain; charset=utf-8",
                log: "text/plain; charset=utf-8",
                json: "application/json; charset=utf-8",
                yaml: "text/yaml; charset=utf-8",
                yml: "text/yaml; charset=utf-8",
                csv: "text/csv; charset=utf-8",
                mp4: "video/mp4",
                mov: "video/quicktime",
                webm: "video/webm",
                mp3: "audio/mpeg",
                wav: "audio/wav",
                ogg: "audio/ogg",
              };
              const mime = mimeMap[ext] ?? "application/octet-stream";
              try {
                const st = statSync(safePath);
                res.setHeader("Content-Type", mime);
                res.setHeader("X-Content-Type-Options", "nosniff");
                // Active content (html/svg) here is written by the local agent, which acts on
                // untrusted inputs (web research, email). Sandbox it so a poisoned doc can't run
                // script in the dashboard origin and read /__token. `sandbox` (no allow-scripts)
                // = opaque origin, scripts disabled — the preview still renders, JS can't fire.
                if (
                  ["html", "htm", "svg", "svgz", "xhtml", "xht", "xml", "mathml", "mml"].includes(
                    ext,
                  )
                ) {
                  res.setHeader(
                    "Content-Security-Policy",
                    "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:",
                  );
                }
                res.setHeader("Cache-Control", "no-store");
                res.setHeader("Content-Length", String(st.size));
                // Stream instead of slurping — a 2GB video would
                // otherwise pull the whole file into memory before
                // the first byte ships.
                const stream = createReadStream(safePath);
                stream.on("error", (err: any) => {
                  if (!res.headersSent) {
                    res.statusCode = 500;
                    res.end(JSON.stringify({ error: err?.message ?? "stream failed" }));
                  } else {
                    res.destroy(err);
                  }
                });
                stream.pipe(res);
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err?.message ?? "read failed" }));
              }
              return;
            }
            // DELETE /__hermes_documents?name=… → soft-delete (move to
            // .trash/). Returns a trashId the operator can use within
            // the undo window to restore the file. Files in .trash/
            // are not auto-purged — operator can clean manually from
            // Finder. This means "delete" is genuinely reversible
            // forever, not just within the 8-second toast window.
            // Skip when the path is one of the sub-routes — those have
            // their own DELETE handlers below.
            if (req.method === "DELETE" && !url.pathname.endsWith("/trash")) {
              const name = safeDocName(url.searchParams.get("name"));
              if (!name) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "invalid name" }));
                return;
              }
              const path = join(DOCUMENTS_DIR, name);
              try {
                if (!existsSync(path)) {
                  res.statusCode = 404;
                  res.end(JSON.stringify({ error: "not found" }));
                  return;
                }
                // Symlink guard — refuse to trash anything whose real
                // path is outside ~/Documents/Hermes/. Stops a symlink
                // attack from moving ~/.ssh/id_rsa into .trash/.
                if (!resolveInsideDocs(path)) {
                  res.statusCode = 403;
                  res.end(JSON.stringify({ error: "path escapes documents folder" }));
                  return;
                }
                ensureTrashDir();
                const trashId = `${Date.now()}__${name}`;
                renameSync(path, join(TRASH_DIR, trashId));
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, trashId }));
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err?.message ?? "delete failed" }));
              }
              return;
            }
            // POST /__hermes_documents/restore?trashId=… → undo a
            // soft-delete by moving the file back to its original name.
            // If a file with the original name already exists (operator
            // recreated it in the meantime), append a numeric suffix
            // rather than clobbering.
            if (req.method === "POST" && url.pathname.endsWith("/restore")) {
              const trashId = safeTrashId(url.searchParams.get("trashId"));
              if (!trashId) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "invalid trashId" }));
                return;
              }
              const original = originalNameFromTrashId(trashId);
              if (!original) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "invalid trashId payload" }));
                return;
              }
              const trashPath = join(TRASH_DIR, trashId);
              if (!existsSync(trashPath)) {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "trash entry not found" }));
                return;
              }
              // Symlink guard — the entry in .trash/ must resolve to a
              // path actually inside .trash/. Without this, an attacker
              // could plant a symlink inside .trash/ pointing to e.g.
              // ~/.zshrc and a restore would happily move it into
              // ~/Documents/Hermes/.
              if (!resolveInsideDocs(trashPath, /*allowTrash*/ true)) {
                res.statusCode = 403;
                res.end(JSON.stringify({ error: "trash entry escapes folder" }));
                return;
              }
              // Compute a non-clobbering target name. If the original is
              // taken, append " (restored)", then " (restored 2)", etc.
              let targetName = original;
              if (existsSync(join(DOCUMENTS_DIR, targetName))) {
                const dot = original.lastIndexOf(".");
                const stem = dot > 0 ? original.slice(0, dot) : original;
                const ext = dot > 0 ? original.slice(dot) : "";
                let n = 1;
                let candidate = `${stem} (restored)${ext}`;
                while (existsSync(join(DOCUMENTS_DIR, candidate))) {
                  n += 1;
                  candidate = `${stem} (restored ${n})${ext}`;
                }
                targetName = candidate;
              }
              try {
                renameSync(trashPath, join(DOCUMENTS_DIR, targetName));
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, restoredAs: targetName }));
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err?.message ?? "restore failed" }));
              }
              return;
            }
            // GET /__hermes_documents/trash → list everything in the
            // soft-delete folder so the operator can restore or
            // permanently delete from a dedicated UI.
            if (req.method === "GET" && url.pathname.endsWith("/trash")) {
              const items: Array<{
                trashId: string;
                originalName: string;
                deletedMs: number;
                sizeBytes: number;
              }> = [];
              try {
                if (existsSync(TRASH_DIR)) {
                  for (const entry of readdirSync(TRASH_DIR)) {
                    const original = originalNameFromTrashId(entry);
                    if (!original) continue;
                    try {
                      const st = statSync(join(TRASH_DIR, entry));
                      if (!st.isFile()) continue;
                      const tsRaw = entry.split("__")[0];
                      const ts = Number(tsRaw);
                      items.push({
                        trashId: entry,
                        originalName: original,
                        deletedMs: Number.isFinite(ts) ? ts : st.mtimeMs,
                        sizeBytes: st.size,
                      });
                    } catch {
                      /* skip unreadable entry */
                    }
                  }
                }
              } catch {
                /* ignore — return empty */
              }
              items.sort((a, b) => b.deletedMs - a.deletedMs);
              res.setHeader("Content-Type", "application/json");
              res.setHeader("Cache-Control", "no-store");
              res.end(JSON.stringify({ items }));
              return;
            }
            // DELETE /__hermes_documents/trash?trashId=… → permanently
            // remove one trashed file. DELETE /__hermes_documents/trash
            // (no trashId) → empty the entire trash.
            if (req.method === "DELETE" && url.pathname.endsWith("/trash")) {
              const trashIdParam = url.searchParams.get("trashId");
              if (trashIdParam) {
                const trashId = safeTrashId(trashIdParam);
                if (!trashId) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: "invalid trashId" }));
                  return;
                }
                const p = join(TRASH_DIR, trashId);
                try {
                  if (existsSync(p)) {
                    // Symlink guard — the entry must be inside .trash/,
                    // not a symlink to ~/.zshrc or similar.
                    if (!resolveInsideDocs(p, /*allowTrash*/ true)) {
                      res.statusCode = 403;
                      res.end(JSON.stringify({ error: "trash entry escapes folder" }));
                      return;
                    }
                    unlinkSync(p);
                  }
                  res.setHeader("Content-Type", "application/json");
                  res.end(JSON.stringify({ ok: true }));
                } catch (err: any) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: err?.message ?? "purge failed" }));
                }
                return;
              }
              // Empty all — unlink every file inside TRASH_DIR. Each
              // entry is symlink-checked before unlink so an attacker
              // can't seed .trash/ with a symlink to a system file and
              // weaponize "empty trash" into a system deletion.
              let purged = 0;
              const errors: string[] = [];
              try {
                if (existsSync(TRASH_DIR)) {
                  for (const entry of readdirSync(TRASH_DIR)) {
                    const p = join(TRASH_DIR, entry);
                    try {
                      // Use lstatSync to inspect the link itself, not
                      // its target. resolveInsideDocs then verifies the
                      // resolved path is genuinely inside .trash/.
                      const lst = lstatSync(p);
                      if (!lst.isFile() && !lst.isSymbolicLink()) continue;
                      if (!resolveInsideDocs(p, /*allowTrash*/ true)) {
                        errors.push(`${entry}: refused (escapes folder)`);
                        continue;
                      }
                      unlinkSync(p);
                      purged += 1;
                    } catch (e: any) {
                      errors.push(`${entry}: ${e?.message ?? "purge failed"}`);
                    }
                  }
                }
              } catch (e: any) {
                errors.push(e?.message ?? "could not read trash dir");
              }
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: errors.length === 0, purged, errors }));
              return;
            }
            // GET /__hermes_documents → list metadata
            if (req.method !== "GET") return next();
            ensureDocumentsDir();
            const items: Array<{
              name: string;
              type: string;
              ext: string;
              sizeBytes: number;
              modifiedMs: number;
              title: string | null;
              description: string | null;
            }> = [];
            // Cap so a runaway folder doesn't hang the dev server's
            // event loop on the 5s polling cadence. 1000 is well past
            // any realistic operator's gallery; if it ever trips we
            // surface a `truncated` flag in the response.
            const MAX_ENTRIES = 1000;
            let truncated = false;
            try {
              const entries = readdirSync(DOCUMENTS_DIR);
              for (const name of entries) {
                if (items.length >= MAX_ENTRIES) {
                  truncated = true;
                  break;
                }
                if (name.startsWith(".")) continue; // skip .DS_Store etc.
                try {
                  const p = join(DOCUMENTS_DIR, name);
                  // lstatSync inspects the link itself — we want to
                  // skip symlinks entirely from the listing, never
                  // mind serving them. If an operator drops a symlink
                  // it just doesn't appear in the gallery.
                  const lst = lstatSync(p);
                  if (lst.isSymbolicLink()) continue;
                  if (!lst.isFile()) continue;
                  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
                  const type = classifyDoc(ext);
                  // Cached metadata read — keyed on (path, mtimeMs, size).
                  // At 200+ files on a 5s poll the uncached cost is
                  // 200×readFileSync + regex/parse every 5s. With the
                  // cache the cost drops to a single lstat per file
                  // unless its mtime or size changed.
                  const meta = cachedParseDocMeta(p, type, lst.mtimeMs, lst.size);
                  items.push({
                    name,
                    type,
                    ext,
                    sizeBytes: lst.size,
                    modifiedMs: lst.mtimeMs,
                    title: meta.title,
                    description: meta.description,
                  });
                } catch {
                  /* skip unreadable entry */
                }
              }
            } catch {
              /* ignore — return empty list */
            }
            // Newest first by default.
            items.sort((a, b) => b.modifiedMs - a.modifiedMs);

            // Trash count — cheap, lets the frontend conditionally
            // render the "Trash · N" link without an extra round trip.
            let trashCount = 0;
            try {
              if (existsSync(TRASH_DIR)) {
                for (const entry of readdirSync(TRASH_DIR)) {
                  if (originalNameFromTrashId(entry)) trashCount += 1;
                }
              }
            } catch {
              /* ignore — leave count at 0 */
            }

            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ folder: DOCUMENTS_DIR, items, trashCount, truncated }));
          });

          // GET /__just-installed — true the first time after `bun run setup`,
          // false thereafter. Setup writes ~/.claude-os/show-wizard; this
          // endpoint reads + deletes it so the dashboard force-opens the
          // wizard once even if the browser has stale claude-os-config from
          // a prior install.
          server.middlewares.use("/__just-installed", (req, res, next) => {
            if (req.method !== "GET") return next();
            const marker = join(homedir(), ".claude-os", "show-wizard");
            let justInstalled = false;
            try {
              if (existsSync(marker)) {
                justInstalled = true;
                unlinkSync(marker);
              }
            } catch {
              /* ignore */
            }
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ justInstalled }));
          });

          // GET /__token — hands the per-run refresh token to the dashboard
          // so it can authenticate /__refresh_data. Loopback-only and must
          // match the local file's contents (which only the user account
          // can read), so a browser extension on another origin can't get
          // it. Rotated every dev-server boot.
          server.middlewares.use("/__token", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ token: REFRESH_TOKEN }));
          });

          // POST /__refresh_data — re-runs the aggregator. Locked down to
          // (a) loopback origin only, and (b) a per-run token in the
          // X-Claude-OS-Token header. Any drive-by request from another
          // origin or extension is rejected with 403. Without this, every
          // tab on localhost:8081 could trigger a full machine scan that
          // reads ~/.claude/, decodes JWTs, and runs `security
          // dump-keychain`.
          server.middlewares.use("/__refresh_data", (req, res) => {
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.end("Method not allowed");
              return;
            }
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ ok: false, error: "loopback only" }));
              return;
            }
            const provided = req.headers["x-claude-os-token"];
            if (provided !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ ok: false, error: "invalid token" }));
              return;
            }
            try {
              const root = resolve(__dirname);
              execSync("bun run scripts/aggregate.ts", {
                cwd: root,
                stdio: "pipe",
                timeout: 30000,
              });
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true }));
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });

          // POST /__set_dream_engine — persists the operator's engine choice
          // to ~/.claude-os/config.json:dreamEngine without spending money
          // on a dream run. Used by the onboarding wizard's engine-picker
          // step so the choice survives even before the first cron fires.
          // Same loopback + token gate as the other write endpoints.
          server.middlewares.use("/__set_dream_engine", (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ ok: false, error: "loopback only" }));
              return;
            }
            const provided = req.headers["x-claude-os-token"];
            if (provided !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ ok: false, error: "invalid token" }));
              return;
            }
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
              let engine = "";
              let model = "";
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
                engine = typeof parsed.engine === "string" ? parsed.engine : "";
                model = typeof parsed.model === "string" ? parsed.model : "";
              } catch {
                /* invalid */
              }
              const valid = ["hermes", "claude", "openrouter", "codex"];
              if (!valid.includes(engine)) {
                res.statusCode = 400;
                res.end(
                  JSON.stringify({ ok: false, error: `engine must be one of ${valid.join(", ")}` }),
                );
                return;
              }
              try {
                const cfgDir = join(homedir(), ".claude-os");
                const cfgPath = join(cfgDir, "config.json");
                if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });
                let cfg: any = {};
                if (existsSync(cfgPath)) {
                  try {
                    cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) || {};
                  } catch {
                    cfg = {};
                  }
                }
                cfg.dreamEngine = engine;
                // Optional OpenRouter model (slug-shape guarded to keep junk out).
                if (model && /^[\w./:-]{1,80}$/.test(model)) cfg.openRouterModel = model;
                writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o644 });
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true }));
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ ok: false, error: err.message }));
              }
            });
          });

          // POST /__dream_action — persist the operator's verdict on a
          // prescription (skip / done / restore) into
          // ~/.claude-os/dreams/state.json. Before this endpoint the card
          // buttons only mutated React state, so every dismissal came back
          // on refresh — and the Dream engine itself never learned which
          // prescriptions the operator had already acted on. Writing the
          // status here closes the loop: the next dream run reads state.json
          // (per SKILL.md step 6) and won't resurface accepted/dismissed
          // items for 30 days. Loopback + token (state-mutating).
          server.middlewares.use("/__dream_action", (req, res, next) => {
            if (req.method !== "POST") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ ok: false, error: "loopback only" }));
              return;
            }
            if (req.headers["x-claude-os-token"] !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ ok: false, error: "invalid token" }));
              return;
            }
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
              let id = "";
              let action = "";
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
                id = typeof parsed.id === "string" ? parsed.id : "";
                action = typeof parsed.action === "string" ? parsed.action : "";
              } catch {
                /* invalid body → caught by the guards below */
              }
              // Slug-shaped ids only — this string becomes a JSON key in a
              // file other tools read, so keep junk and path-ish input out.
              if (
                !/^[\w-]{1,80}$/.test(id) ||
                !["dismissed", "accepted", "restored"].includes(action)
              ) {
                res.statusCode = 400;
                res.end(
                  JSON.stringify({
                    ok: false,
                    error: "need id (slug) + action (dismissed|accepted|restored)",
                  }),
                );
                return;
              }
              try {
                const dreamsDir = join(homedir(), ".claude-os", "dreams");
                const statePath = join(dreamsDir, "state.json");
                if (!existsSync(dreamsDir)) mkdirSync(dreamsDir, { recursive: true });
                let state: any = {};
                if (existsSync(statePath)) {
                  try {
                    state = JSON.parse(readFileSync(statePath, "utf-8")) || {};
                  } catch {
                    state = {};
                  }
                }
                if (typeof state.actions !== "object" || state.actions === null) state.actions = {};
                const now = new Date().toISOString();
                const prior = state.actions[id] ?? { firstSeenAt: now };
                state.actions[id] = {
                  ...prior,
                  status: action === "restored" ? "new" : action,
                  lastSeenAt: prior.lastSeenAt ?? now,
                  [action === "accepted"
                    ? "acceptedAt"
                    : action === "dismissed"
                      ? "dismissedAt"
                      : "restoredAt"]: now,
                };
                writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o644 });
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, id, status: state.actions[id].status }));
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ ok: false, error: err.message }));
              }
            });
          });

          // GET /__dream_engines — probes the machine for every engine that
          // could run the /dream skill and reports installation + auth
          // readiness for each. The homepage Dream card renders this list
          // as buttons so the operator picks which one runs their Dream.
          // No defaults baked in — the operator decides. Loopback only.
          server.middlewares.use("/__dream_engines", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const home = homedir();
            // The operator's previously-picked engine, if any. Used by the
            // homepage to show a "Engine: <name>" chip on the Dream card so
            // the picker isn't gated behind the empty state.
            let currentChoice: string | null = null;
            let openRouterModel = "anthropic/claude-fable-5";
            try {
              const cfgPath = join(home, ".claude-os", "config.json");
              if (existsSync(cfgPath)) {
                const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
                if (typeof cfg?.dreamEngine === "string") currentChoice = cfg.dreamEngine;
                if (
                  typeof cfg?.openRouterModel === "string" &&
                  /^[\w./:-]{1,80}$/.test(cfg.openRouterModel)
                )
                  openRouterModel = cfg.openRouterModel;
              }
            } catch {
              /* no recorded choice */
            }
            // Look for an OpenRouter API key in the common locations: env,
            // ~/.hermes/.env (Hermes' canonical location), ~/.claude-os/.env.local,
            // and the repo's local .env.local for users who use the project file.
            const openRouterKey = (() => {
              if (process.env.OPENROUTER_API_KEY) return true;
              const envFiles = [
                join(home, ".hermes", ".env"),
                join(home, ".claude-os", ".env.local"),
                join(resolve(__dirname), ".env.local"),
              ];
              for (const f of envFiles) {
                if (!existsSync(f)) continue;
                try {
                  const txt = readFileSync(f, "utf-8");
                  if (/^\s*OPENROUTER_API_KEY\s*=\s*\S/m.test(txt)) return true;
                } catch {
                  /* unreadable */
                }
              }
              return false;
            })();
            const engines: Array<{
              id: string;
              name: string;
              description: string;
              installed: boolean;
              ready: boolean;
              needsAction: string | null;
              cost: string;
            }> = [];

            // Hermes — routes through whatever provider its config.yaml is
            // pointing at (OpenRouter, Anthropic OAuth, local Ollama, etc).
            // Headless-friendly by design — no token-setup ceremony required.
            const hermesBin = resolveCliBin("hermes");
            const hermesSkill = existsSync(join(home, ".hermes", "skills", "dream", "SKILL.md"));
            const hermesConfig = existsSync(join(home, ".hermes", "config.yaml"));
            engines.push({
              id: "hermes",
              name: "Hermes",
              description:
                "Routes via your Hermes provider (gpt-5.5 / OpenAI by default) — sends your activity to that provider",
              installed: !!hermesBin,
              ready: !!hermesBin && hermesSkill && hermesConfig,
              needsAction: !hermesBin
                ? "Install Hermes via the setup wizard"
                : !hermesSkill
                  ? "Dream skill missing at ~/.hermes/skills/dream/"
                  : !hermesConfig
                    ? "Hermes config.yaml missing"
                    : null,
              cost: "~$0.001–0.003 per run (provider-dependent)",
            });

            // Claude Code — works for `claude -p` headless ONLY if
            // setup-token has been run OR ANTHROPIC_API_KEY is set. We can't
            // cheaply detect setup-token state, so we report "installed" and
            // flag the auth caveat in needsAction.
            const claudeBin = resolveCliBin("claude");
            const claudeSkill = existsSync(join(home, ".claude", "skills", "dream", "SKILL.md"));
            const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
            engines.push({
              id: "claude",
              name: "Claude Code",
              description: hasApiKey
                ? "Uses your ANTHROPIC_API_KEY — sends your activity to Anthropic"
                : "Uses your Claude subscription (needs `claude setup-token`) — sends your activity to Anthropic",
              installed: !!claudeBin,
              ready: !!claudeBin && claudeSkill && hasApiKey,
              needsAction: !claudeBin
                ? "Install Claude Code"
                : !claudeSkill
                  ? "Dream skill missing at ~/.claude/skills/dream/"
                  : !hasApiKey
                    ? "Run `claude setup-token` in Terminal to enable headless mode"
                    : null,
              cost: hasApiKey ? "API rate (small)" : "Uses your Claude subscription quota",
            });

            // OpenRouter — direct API call, no CLI in the loop. Cheapest path
            // for users who don't want to install/maintain Hermes or Claude
            // Code just for Dream. The trigger handler reads the dream skill
            // + live-data.json server-side and POSTs to api.openrouter.ai.
            engines.push({
              id: "openrouter",
              name: "OpenRouter",
              description:
                "Claude Fable 5 via API (model selectable) — sends your activity to OpenRouter",
              installed: openRouterKey,
              ready: openRouterKey,
              needsAction: openRouterKey
                ? null
                : "Add OPENROUTER_API_KEY to ~/.hermes/.env or ~/.claude-os/.env.local",
              cost: "~$0.001–0.003 per run (model-dependent)",
            });

            // Codex — ChatGPT-backed CLI. We don't depend on a /dream skill:
            // the trigger handler feeds Codex the assembled dream prompt via
            // `codex exec` and captures the JSON, so it's a first-class engine
            // whenever the CLI is installed and logged in (ChatGPT OAuth).
            const codexBin = resolveCliBin("codex");
            const codexAuth = existsSync(join(home, ".codex", "auth.json"));
            engines.push({
              id: "codex",
              name: "Codex",
              description:
                "Uses your ChatGPT subscription (gpt-5.5) — sends your activity to OpenAI",
              installed: !!codexBin,
              ready: !!codexBin && codexAuth,
              needsAction: !codexBin
                ? "Install the Codex CLI"
                : !codexAuth
                  ? "Run `codex login` in Terminal"
                  : null,
              cost: "Uses your ChatGPT subscription quota",
            });

            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            // A small curated set of OpenRouter slugs for the model picker.
            // Fable 5 (frontier tier) leads as the default — deepest analysis
            // for an overnight batch job where latency doesn't matter.
            // Sonnet 4.6 stays as the fast/cheap option.
            const openRouterModels = [
              { id: "anthropic/claude-fable-5", label: "Claude Fable 5 · frontier · default" },
              { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6 · fast" },
              { id: "openai/gpt-5.5", label: "OpenAI GPT-5.5" },
              { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
              { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
              { id: "deepseek/deepseek-chat", label: "DeepSeek V3" },
            ];
            res.end(JSON.stringify({ engines, currentChoice, openRouterModel, openRouterModels }));
          });

          // POST /__trigger_dream — runs the /dream skill on the engine
          // chosen by the operator (passed in the request body as
          // { "engine": "hermes" | "claude" | "codex" }). Waits for the
          // subprocess to finish, re-aggregates so live-data.json picks up
          // the new prescription, and returns the result. The frontend
          // reloads on success → carousel renders the new dream.
          // Same loopback + token gate as /__refresh_data. The user-driven
          // engine choice prevents this endpoint from racking up usage on
          // a provider the user didn't pick.
          server.middlewares.use("/__trigger_dream", (req, res) => {
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.end("Method not allowed");
              return;
            }
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ ok: false, error: "loopback only" }));
              return;
            }
            const provided = req.headers["x-claude-os-token"];
            if (provided !== REFRESH_TOKEN) {
              res.statusCode = 403;
              res.end(JSON.stringify({ ok: false, error: "invalid token" }));
              return;
            }
            // Read the engine choice from the request body. The user picked
            // it on the dashboard — no fallback / no defaults baked in. We
            // use the classic on(data)/on(end) pattern instead of `for await`
            // to keep this middleware non-async (matches the rest of vite.config).
            const bodyChunks: Buffer[] = [];
            req.on("data", (c: Buffer) => bodyChunks.push(c));
            req.on("end", () => runDream());
            const runDream = () => {
              let chosenEngine = "";
              try {
                const parsed = JSON.parse(Buffer.concat(bodyChunks).toString("utf-8") || "{}");
                chosenEngine = typeof parsed.engine === "string" ? parsed.engine : "";
              } catch {
                /* invalid body — error below */
              }
              if (!chosenEngine) {
                res.statusCode = 400;
                res.end(
                  JSON.stringify({
                    ok: false,
                    error: "missing engine — pass { engine: 'hermes' | 'claude' | 'codex' }",
                  }),
                );
                return;
              }

              let stdout = "";
              let stderr = "";
              let completed = false;
              let child: ReturnType<typeof spawn>;
              // Resolve the chosen engine's binary + args.
              let resolved: { cmd: string; args: string[] } | null = null;
              if (chosenEngine === "hermes") {
                const bin = resolveCliBin("hermes");
                if (bin) {
                  resolved = {
                    cmd: bin,
                    args: ["chat", "-Q", "--skills", "dream", "--yolo", "-q", "/dream"],
                  };
                }
              } else if (chosenEngine === "claude") {
                const bin = resolveCliBin("claude") ?? "claude";
                resolved = {
                  cmd: bin,
                  args: [
                    "-p",
                    "/dream",
                    "--add-dir",
                    join(homedir(), ".claude-os"),
                    "--permission-mode",
                    "acceptEdits",
                  ],
                };
              } else if (chosenEngine === "codex") {
                // Codex doesn't load a /dream skill — feed it the assembled dream
                // prompt via `codex exec` and capture the JSON. Runs on the user's
                // ChatGPT OAuth (gpt-5.5): no API key, no OpenRouter credits.
                const bin = resolveCliBin("codex");
                if (bin) {
                  runCodexDream(bin).catch((err) => {
                    if (completed) return;
                    completed = true;
                    res.statusCode = 500;
                    res.end(
                      JSON.stringify({
                        ok: false,
                        error: err instanceof Error ? err.message : String(err),
                      }),
                    );
                  });
                  return;
                }
                // bin not found → falls through to the `!resolved` 400 below.
              } else if (chosenEngine === "openrouter") {
                // OpenRouter takes a different path — no CLI to spawn, we
                // call the API directly. Hand off to runOpenRouterDream() and
                // return early so we don't fall into the spawn() branch.
                const home = homedir();
                const apiKey = (() => {
                  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
                  const candidates = [
                    join(home, ".hermes", ".env"),
                    join(home, ".claude-os", ".env.local"),
                    join(resolve(__dirname), ".env.local"),
                  ];
                  for (const f of candidates) {
                    if (!existsSync(f)) continue;
                    try {
                      const txt = readFileSync(f, "utf-8");
                      const m = txt.match(/^\s*OPENROUTER_API_KEY\s*=\s*"?([^"\n\r]+)"?\s*$/m);
                      if (m && m[1]) return m[1].trim();
                    } catch {
                      /* unreadable */
                    }
                  }
                  return "";
                })();
                if (!apiKey) {
                  res.statusCode = 400;
                  res.end(
                    JSON.stringify({
                      ok: false,
                      error:
                        "OPENROUTER_API_KEY not found in env, ~/.hermes/.env, ~/.claude-os/.env.local, or repo .env.local",
                    }),
                  );
                  return;
                }
                runOpenRouterDream(apiKey).catch((err) => {
                  if (completed) return;
                  completed = true;
                  res.statusCode = 500;
                  res.end(
                    JSON.stringify({
                      ok: false,
                      error: err instanceof Error ? err.message : String(err),
                    }),
                  );
                });
                return;
              }

              // Async OpenRouter handler — assembles the dream skill + live
              // data, posts to OpenRouter, parses the JSON response, and
              // writes ~/.claude-os/dreams/dream-YYYY-MM-DD.json directly.
              async function runOpenRouterDream(apiKey: string): Promise<void> {
                const home = homedir();
                // Find the dream skill — prefer Claude's path since it's the
                // canonical bundle; fall back to Hermes' path.
                const skillCandidates = [
                  join(home, ".claude", "skills", "dream", "SKILL.md"),
                  join(home, ".hermes", "skills", "dream", "SKILL.md"),
                  join(resolve(__dirname), "skills", "dream", "SKILL.md"),
                ];
                const skillPath = skillCandidates.find((p) => existsSync(p));
                if (!skillPath) {
                  throw new Error("Dream SKILL.md not found in any standard location");
                }
                const skillText = readFileSync(skillPath, "utf-8");
                const liveDataPath = join(resolve(__dirname), "src", "data", "live-data.json");
                const liveData = existsSync(liveDataPath)
                  ? readFileSync(liveDataPath, "utf-8")
                  : "{}";

                const today = new Date().toISOString().slice(0, 10);
                const systemPrompt = [
                  skillText,
                  "",
                  "---",
                  "IMPORTANT: You're being invoked via direct API call, NOT via a CLI with file tools.",
                  "Your reply MUST be a single valid JSON object matching the schema specified in the skill above.",
                  "Do not include any markdown fences, prose, or explanation. JSON only.",
                  `Set "date" to "${today}" and "generatedAt" to the current ISO timestamp.`,
                ].join("\n");

                const userPrompt = [
                  "Here is the operator's aggregated activity data:",
                  "",
                  liveData,
                  "",
                  "Produce the dream prescription JSON now.",
                ].join("\n");

                const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                  method: "POST",
                  signal: AbortSignal.timeout(240_000),
                  headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": "http://127.0.0.1:8081",
                    "X-Title": "Claude OS Dream",
                  },
                  body: JSON.stringify({
                    model: (() => {
                      try {
                        const cp = join(home, ".claude-os", "config.json");
                        if (existsSync(cp)) {
                          const c = JSON.parse(readFileSync(cp, "utf-8"));
                          if (
                            typeof c?.openRouterModel === "string" &&
                            /^[\w./:-]{1,80}$/.test(c.openRouterModel)
                          )
                            return c.openRouterModel;
                        }
                      } catch {
                        /* fall back to default */
                      }
                      return "anthropic/claude-sonnet-4.6";
                    })(),
                    messages: [
                      { role: "system", content: systemPrompt },
                      { role: "user", content: userPrompt },
                    ],
                    response_format: { type: "json_object" },
                    temperature: 0.4,
                    // Cap the output reservation so the request fits a near-limit
                    // OpenRouter key — an uncapped request reserves the model's full
                    // ~64K max and 402s on low balances. A dream JSON is ~4–5K tokens.
                    max_tokens: 8000,
                  }),
                });
                if (!resp.ok) {
                  const errText = await resp.text();
                  throw new Error(`OpenRouter HTTP ${resp.status}: ${errText.slice(0, 400)}`);
                }
                const data: any = await resp.json();
                const content: string = data?.choices?.[0]?.message?.content ?? "";
                if (!content) throw new Error("OpenRouter returned no content");
                let dream: any;
                try {
                  dream = JSON.parse(content);
                } catch (err) {
                  throw new Error(
                    `OpenRouter returned non-JSON content (head): ${content.slice(0, 300)}`,
                  );
                }
                const dreamsDir = join(home, ".claude-os", "dreams");
                if (!existsSync(dreamsDir)) mkdirSync(dreamsDir, { recursive: true });
                const outPath = join(dreamsDir, `dream-${today}.json`);
                writeFileSync(outPath, JSON.stringify(dream, null, 2), { mode: 0o644 });

                // Persist engine choice + re-aggregate so the dashboard reload
                // shows the new dream and the picker chip updates.
                try {
                  const cfgDir = join(home, ".claude-os");
                  const cfgPath = join(cfgDir, "config.json");
                  if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });
                  let cfg: any = {};
                  if (existsSync(cfgPath)) {
                    try {
                      cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) || {};
                    } catch {
                      cfg = {};
                    }
                  }
                  cfg.dreamEngine = "openrouter";
                  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o644 });
                } catch {
                  /* best-effort */
                }
                try {
                  execSync("bun run scripts/aggregate.ts", {
                    cwd: resolve(__dirname),
                    stdio: "pipe",
                    timeout: 30000,
                  });
                } catch {}

                if (completed) return;
                completed = true;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, code: 0, stdout: "", stderr: "" }));
              }

              // Codex path — Codex doesn't read a /dream skill, so we assemble the
              // same dream prompt (skill + live-data) and feed it to `codex exec`,
              // capturing the model's final message via --output-last-message. Runs
              // on the user's ChatGPT OAuth (gpt-5.5): no API key, no OpenRouter spend.
              async function runCodexDream(bin: string): Promise<void> {
                const home = homedir();
                const skillCandidates = [
                  join(home, ".claude", "skills", "dream", "SKILL.md"),
                  join(home, ".hermes", "skills", "dream", "SKILL.md"),
                  join(resolve(__dirname), "skills", "dream", "SKILL.md"),
                ];
                const skillPath = skillCandidates.find((p) => existsSync(p));
                if (!skillPath)
                  throw new Error("Dream SKILL.md not found in any standard location");
                const skillText = readFileSync(skillPath, "utf-8");
                const liveDataPath = join(resolve(__dirname), "src", "data", "live-data.json");
                const liveData = existsSync(liveDataPath)
                  ? readFileSync(liveDataPath, "utf-8")
                  : "{}";
                const today = new Date().toISOString().slice(0, 10);
                const prompt = [
                  skillText,
                  "",
                  "---",
                  "IMPORTANT: You are being run non-interactively. Do NOT use any tools or",
                  "read/write any files. Your ENTIRE reply must be a single valid JSON object",
                  "matching the schema in the skill above — no markdown fences, no prose.",
                  `Set "date" to "${today}" and "generatedAt" to the current ISO timestamp.`,
                  "",
                  "Operator's aggregated activity data:",
                  "",
                  liveData,
                  "",
                  "Produce the dream prescription JSON now.",
                ].join("\n");

                // Private per-run temp dir (random, unguessable) so there's no
                // symlink race or cross-run collision on the captured output file.
                const codexTmpDir = mkdtempSync(join(tmpdir(), "claude-os-codex-"));
                const outFile = join(codexTmpDir, "dream.json");
                const proc = spawn(
                  bin,
                  [
                    "exec",
                    "--skip-git-repo-check",
                    "--sandbox",
                    "read-only",
                    "--color",
                    "never",
                    "--output-last-message",
                    outFile,
                  ],
                  { stdio: ["pipe", "pipe", "pipe"] },
                );
                let cerr = "";
                proc.stderr?.on("data", (b: Buffer) => {
                  cerr += b.toString();
                });
                proc.stdin?.write(prompt);
                proc.stdin?.end();
                const code: number = await new Promise((resolveCode) => {
                  const t = setTimeout(() => {
                    try {
                      proc.kill("SIGKILL");
                    } catch {
                      /* ignore */
                    }
                    resolveCode(-1);
                  }, 180_000);
                  proc.on("close", (c) => {
                    clearTimeout(t);
                    resolveCode(c ?? -1);
                  });
                  proc.on("error", () => {
                    clearTimeout(t);
                    resolveCode(-1);
                  });
                });
                if (!existsSync(outFile)) {
                  try {
                    rmSync(codexTmpDir, { recursive: true, force: true });
                  } catch {
                    /* ignore */
                  }
                  throw new Error(
                    `Codex produced no output (exit ${code}). ${cerr.slice(-300)}`.trim(),
                  );
                }
                let raw = readFileSync(outFile, "utf-8").trim();
                // Remove the whole private temp dir, not just the file (no orphans).
                try {
                  rmSync(codexTmpDir, { recursive: true, force: true });
                } catch {
                  /* ignore */
                }
                // Strip accidental ``` fences if the model wrapped the JSON.
                raw = raw
                  .replace(/^```(?:json)?\s*/i, "")
                  .replace(/\s*```$/i, "")
                  .trim();
                let dream: any;
                try {
                  dream = JSON.parse(raw);
                } catch {
                  throw new Error(`Codex returned non-JSON (head): ${raw.slice(0, 300)}`);
                }
                const dreamsDir = join(home, ".claude-os", "dreams");
                if (!existsSync(dreamsDir)) mkdirSync(dreamsDir, { recursive: true });
                writeFileSync(
                  join(dreamsDir, `dream-${today}.json`),
                  JSON.stringify(dream, null, 2),
                  {
                    mode: 0o644,
                  },
                );
                try {
                  const cfgDir = join(home, ".claude-os");
                  const cfgPath = join(cfgDir, "config.json");
                  if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });
                  let cfg: any = {};
                  if (existsSync(cfgPath)) {
                    try {
                      cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) || {};
                    } catch {
                      cfg = {};
                    }
                  }
                  cfg.dreamEngine = "codex";
                  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o644 });
                } catch {
                  /* best-effort */
                }
                try {
                  execSync("bun run scripts/aggregate.ts", {
                    cwd: resolve(__dirname),
                    stdio: "pipe",
                    timeout: 30000,
                  });
                } catch {
                  /* non-fatal */
                }
                if (completed) return;
                completed = true;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, code: 0, stdout: "", stderr: "" }));
              }

              if (!resolved) {
                res.statusCode = 400;
                res.end(
                  JSON.stringify({
                    ok: false,
                    error: `engine '${chosenEngine}' is not installed on this machine`,
                  }),
                );
                return;
              }
              try {
                child = spawn(resolved.cmd, resolved.args, {
                  stdio: ["ignore", "pipe", "pipe"],
                });
              } catch (err: any) {
                res.statusCode = 500;
                res.end(
                  JSON.stringify({
                    ok: false,
                    error: `failed to spawn ${chosenEngine}: ${err.message}`,
                  }),
                );
                return;
              }
              child.stdout?.on("data", (b: Buffer) => {
                stdout += b.toString();
              });
              child.stderr?.on("data", (b: Buffer) => {
                stderr += b.toString();
              });
              // 2-minute hard ceiling. Typical dream is 30–60s. Beyond 2 min
              // assume it's hung (model stuck, auth prompt waiting for TTY, etc.)
              // and kill it so the frontend gets a definitive answer.
              const timer = setTimeout(() => {
                if (completed) return;
                killTree(child); // the hand-rolled escalation here never fired

                // 4-min ceiling — agentic Hermes/Claude dreams that read raw files
                // can run ~3 min; matches scripts/run-dream.ts so the dashboard
                // doesn't kill a slow-but-healthy dream mid-run.
              }, 240_000);
              child.on("close", (code) => {
                if (completed) return;
                completed = true;
                clearTimeout(timer);
                // On success: persist the operator's engine choice to
                // ~/.claude-os/config.json so the daily cron uses the same
                // engine. install-dream-cron.ts reads this file when building
                // the plist/.cmd dream command.
                if (code === 0) {
                  try {
                    const cfgDir = join(homedir(), ".claude-os");
                    const cfgPath = join(cfgDir, "config.json");
                    if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });
                    let cfg: any = {};
                    if (existsSync(cfgPath)) {
                      try {
                        cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) || {};
                      } catch {
                        cfg = {};
                      }
                    }
                    cfg.dreamEngine = chosenEngine;
                    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o644 });
                  } catch {
                    /* config persistence is best-effort */
                  }
                }
                // Re-aggregate so the new dream JSON lands in live-data.json
                // before the frontend reloads. Failures here aren't fatal —
                // the dream file itself is the source of truth.
                try {
                  execSync("bun run scripts/aggregate.ts", {
                    cwd: resolve(__dirname),
                    stdio: "pipe",
                    timeout: 30000,
                  });
                } catch {}
                res.setHeader("Content-Type", "application/json");
                res.end(
                  JSON.stringify({
                    ok: code === 0,
                    code,
                    stdout: stdout.slice(-1500),
                    stderr: stderr.slice(-1500),
                  }),
                );
              });
              child.on("error", (err) => {
                if (completed) return;
                completed = true;
                clearTimeout(timer);
                res.statusCode = 500;
                res.end(JSON.stringify({ ok: false, error: err.message }));
              });
            }; // runDream
          });
        },
      },
    ],
    server: {
      // Bind to IPv4 loopback explicitly. The dev server scans private user
      // data (~/.claude/, keychain, JWTs) so it must never be reachable from
      // another machine on the LAN — 127.0.0.1 keeps it loopback-only.
      //
      // Why 127.0.0.1 instead of "localhost": on modern macOS, Node resolves
      // "localhost" to ::1 (IPv6) first and binds there, so any client whose
      // resolver prefers IPv4 (Hermes's bash sandbox, older Python httpx,
      // curl in some configs) connects to 127.0.0.1:8081 → connection
      // refused. Binding to 127.0.0.1 directly works for every client:
      // IPv4-preferring clients connect on first try, IPv6-preferring
      // clients (browsers, modern curl) fail IPv6 then fall back via
      // Happy Eyeballs. The browser address bar still says "localhost:8081"
      // when the user types that, so localStorage origin stays stable.
      host: "127.0.0.1",
      port: 8081,
      strictPort: true,
      // Exclude live-data.json from the file watcher. The aggregator writes
      // this file during the wizard (Steps 2 and 7). Without this exclusion,
      // Vite triggers HMR on every write, which re-mounts route components,
      // destroys React state, and creates infinite scan/activate loops.
      // The app reads the file at import time; hot-reloading it mid-wizard
      // is actively harmful.
      watch: { ignored: ["**/src/data/live-data.json"] },
    },
  },
});
