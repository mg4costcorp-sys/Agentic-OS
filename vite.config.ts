import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { execFileSync, execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
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
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import yaml from "js-yaml";

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
// Pantheon — the 10 canonical persona recipes. Schema co-designed with
// Hermes (see chat 2026-05-12). Model names follow the provider/name split
// the YAML schema uses; the dashboard renders the matching local logo from
// HERMES_LOCAL_LOGOS in agents.hermes.tsx. Skill ids are real Hermes skill
// folder names (run `hermes skills list` to verify).
//
// Models are tiered so cheap/silly tasks use cheap/fast models and reasoning
// tasks get top-tier models:
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
  model: { provider: string; name: string };
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
    description: "Media generation — image, video, audio, design. Talks to Kie / Runway / ElevenLabs.",
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
    model: { provider: "anthropic", name: "claude-opus-4.8" },
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

// Reject any socket whose remote isn't 127.0.0.1 / ::1. Belt-and-braces
// alongside server.host = "127.0.0.1" — even if a future config change
// re-exposes the dev server, the privileged endpoints stay loopback-only.
function isLoopback(req: { socket?: { remoteAddress?: string | null }; headers?: Record<string, any> }): boolean {
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
                  String(data.name || "").trim().replace(/[^a-zA-Z0-9_-]/g, "-") ||
                  "ministry";
                const refs = Array.isArray(data.reference_models)
                  ? data.reference_models
                  : [];
                const agg = data.aggregator;
                if (!refs.length || !agg?.provider || !agg?.model) {
                  res.statusCode = 400;
                  res.end(
                    JSON.stringify({ error: "need >=1 reference and an aggregator" }),
                  );
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
                cfg.moa =
                  cfg.moa && typeof cfg.moa === "object" ? cfg.moa : {};
                cfg.moa.presets =
                  cfg.moa.presets && typeof cfg.moa.presets === "object"
                    ? cfg.moa.presets
                    : {};
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
                  max_tokens:
                    typeof data.max_tokens === "number" ? data.max_tokens : 4096,
                  enabled: true,
                };
                cfg.moa.default_preset = name;
                writeFileSync(
                  configPath,
                  yaml.dump(cfg, { lineWidth: 120, noRefs: true }),
                );
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
          server.middlewares.use("/__live-data", (req, res, next) => {
            if (req.method !== "GET") return next();
            try {
              const filePath = resolve(__dirname, "src/data/live-data.json");
              const raw = readFileSync(filePath, "utf-8");
              res.setHeader("Content-Type", "application/json");
              res.setHeader("Cache-Control", "no-store");
              res.end(raw);
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
                    } catch { /* ignore */ }
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
                    try { rmSync(cloneTmp, { recursive: true, force: true }); } catch { /* ignore */ }
                  }
                  res.statusCode = 502;
                  res.end(
                    JSON.stringify({ error: `git clone failed: ${String(err?.message ?? "").slice(0, 250)}` }),
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

              const binCandidates = [
                venvBin(join(homedir(), ".notebooklm-venv"), "graphify"),
                ...cliBinCandidates("graphify"),
              ];
              const bin = binCandidates.find((p) => existsSync(p)) ?? "graphify";
              try {
                execFileSync(bin, ["update", repoPath], { stdio: "pipe", timeout: 180000 });
              } catch (err: any) {
                res.statusCode = 500;
                res.end(
                  JSON.stringify({ error: `graphify failed: ${String(err?.message ?? "").slice(0, 300)}` }),
                );
                return;
              }
              const outPath = join(repoPath, "graphify-out", "graph.json");
              if (!existsSync(outPath)) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: "graphify produced no graph.json (no supported source files?)" }));
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

              const nodes: any[] = g.nodes ?? [];
              const links: any[] = g.links ?? g.edges ?? [];
              // Guard against vendored-deps explosions (e.g. a Python .venv) — refuse
              // rather than write a 100MB graph the browser can't load.
              if (nodes.length > 12000) {
                try {
                  rmSync(join(repoPath, "graphify-out"), { recursive: true, force: true });
                } catch {
                  /* ignore */
                }
                if (cloneTmp) {
                  try { rmSync(cloneTmp, { recursive: true, force: true }); } catch { /* ignore */ }
                }
                res.statusCode = 422;
                res.end(
                  JSON.stringify({
                    error: `Too large (${nodes.length.toLocaleString()} nodes) — likely includes vendored deps (.venv / site-packages / vendor). Point at a source subdir, e.g. ${repoPath.replace(homedir(), "~")}/src`,
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
                ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
                py: "Python", go: "Go", rs: "Rust", rb: "Ruby", java: "Java", php: "PHP",
                c: "C", cpp: "C++", swift: "Swift", kt: "Kotlin",
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
              const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
              const GENERIC = new Set([
                "src", "app", "lib", "dist", "source", "packages", "core", "server", "client", "agent",
              ]);
              // For a cloned URL, name from the repo (not the random temp
              // dir). For a local path, keep the path-aware naming.
              const segs = repoPath.split(sep).filter(Boolean);
              const baseSeg = urlRepoName || segs[segs.length - 1] || "project";
              const parentSeg = urlRepoName ? "" : (segs[segs.length - 2] || "");
              const generic = GENERIC.has(baseSeg.toLowerCase()) && !!parentSeg;
              const displayName = String(body.name || (generic ? `${parentSeg}/${baseSeg}` : baseSeg));
              let id = (generic ? slug(`${parentSeg}-${baseSeg}`) : slug(baseSeg)) || `project-${Date.now()}`;
              // Dedup key: for URL clones use the repo name (temp path changes
              // every run); for local use the path.
              const dedupKey = urlRepoName ?? repoPath;
              const clash = index.find((p) => p.id === id);
              if (clash && clash.path && clash.path !== dedupKey) {
                let h = 0;
                for (let i = 0; i < dedupKey.length; i++) h = (h * 31 + dedupKey.charCodeAt(i)) >>> 0;
                id = `${id}-${h.toString(36).slice(0, 4)}`;
              }

              writeFileSync(join(graphsDir, `${id}.json`), JSON.stringify(g));

              const PAL = [
                "#3ddc97", "#60a5fa", "#a78bfa", "#f5b14c", "#f472b6",
                "#7be0c8", "#22d3ee", "#fbbf24", "#34d399", "#fb7185",
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
                try { rmSync(cloneTmp, { recursive: true, force: true }); } catch { /* ignore */ }
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
                  const blockText =
                    endIdx === -1 ? afterHeader : afterHeader.slice(0, endIdx);
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
              "openai-codex", "nous", "copilot", "github-copilot", "anthropic-oauth",
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
            const providerKeyName = provider ? PROVIDER_KEY_MAP[provider] ?? null : null;
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
                (!OAUTH_PROVIDERS.has(provider) &&
                  providerKeyName !== null &&
                  !hasProviderKey));
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
            };
            const ext = EXT_BY_CT[contentType.split(";")[0].trim()];
            if (!ext) {
              res.statusCode = 415;
              res.end(JSON.stringify({ error: "unsupported image type" }));
              return;
            }
            const MAX = 8 * 1024 * 1024;
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
            let payload: { prompt?: string; sessionId?: string; toolsets?: string; yolo?: boolean; graph?: boolean; model?: string; provider?: string };
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
            const useSourceEntrypoint =
              existsSync(hermesPython) && existsSync(hermesMain);
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
              },
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
            const FIRST_OUTPUT_TIMEOUT_MS = 120_000; // 2 min cold-start grace
            const POST_OUTPUT_IDLE_MS = 8_000; // strict after streaming starts
            let watchdog: NodeJS.Timeout | null = null;
            let receivedAnyOutput = false;
            const setIdle = (ms: number) => {
              if (watchdog) clearTimeout(watchdog);
              watchdog = setTimeout(() => {
                if (child.killed) return;
                // Pre-output: hermes is hung waiting for something it
                // can't get (auth lock, network, etc.) — surface as error.
                // Post-output: assume done, terminate cleanly.
                child.kill("SIGTERM");
                setTimeout(() => {
                  if (!child.killed) child.kill("SIGKILL");
                }, 2_000);
              }, ms);
            };
            setIdle(FIRST_OUTPUT_TIMEOUT_MS);

            child.stdout.on("data", (buf: Buffer) => {
              receivedAnyOutput = true;
              sendEvent("chunk", buf.toString("utf-8"));
              setIdle(POST_OUTPUT_IDLE_MS);
            });
            child.stderr.on("data", (buf: Buffer) => {
              // Hermes pipes status into stderr; keep the user's chat
              // bubble clean by routing stderr to an "info" event the
              // client can choose to display dimly.
              receivedAnyOutput = true;
              sendEvent("info", buf.toString("utf-8"));
              setIdle(POST_OUTPUT_IDLE_MS);
            });
            child.on("error", (err) => {
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
                  "Hermes didn't respond in 2 minutes. Check ~/.hermes/.env has provider credentials and run `hermes gateway restart`.",
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
            if (
              req.method !== "GET" ||
              (req.url ?? "").split("?")[0] !== "/"
            )
              return next();
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
          server.middlewares.use(
            "/__hermes_missions/optimize",
            async (req, res, next) => {
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
                res.end(
                  JSON.stringify({ error: "input empty or too long (max 4000)" }),
                );
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
              const useSourceEntrypoint =
                existsSync(hermesPython) && existsSync(hermesMain);
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
                res.end(
                  JSON.stringify({ error: String(err.message || err) }),
                );
              });
            },
          );

          // POST /__hermes_missions/create — persist a mission as the active
          // mission. Body: the structured mission JSON returned by /optimize
          // (title, deadline_days, binary_outcome, mini_goals[]).
          // No token required — loopback-only is the security boundary, so
          // Hermes (also running locally) can POST via plain curl without
          // having to read the token file. Frontend can still pass a token
          // but it's ignored.
          server.middlewares.use(
            "/__hermes_missions/create",
            async (req, res, next) => {
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
                const fp = typeof g?.full_prompt === "string"
                  ? g.full_prompt.trim()
                  : "";
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
                binary_outcome: String(payload.binary_outcome ?? "").slice(
                  0,
                  500,
                ),
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
            },
          );

          // POST /__hermes_missions/tick — toggle a mini-goal's done status.
          // Body: { goalId: "g-<missionId>-<num>" }
          server.middlewares.use(
            "/__hermes_missions/tick",
            async (req, res, next) => {
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
              const goal = mission.mini_goals.find(
                (g: any) => g.id === goalId,
              );
              if (!goal) {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "goal not found" }));
                return;
              }
              goal.status = goal.status === "done" ? "queued" : "done";
              writeMissions(data);
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ mission }));
            },
          );

          // POST /__hermes_missions/clear — drop the active mission entirely.
          // No token required — loopback-only is the security boundary.
          server.middlewares.use(
            "/__hermes_missions/clear",
            async (req, res, next) => {
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
            },
          );

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
                const distribution =
                  cells[4] && !/^[—-]+$/.test(cells[4]) ? cells[4] : null;
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
                const GATEWAY_TOKENS: Record<
                  string,
                  { name: string; slug: string }
                > = {
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
                const pattern = /^\s*([A-Z][A-Z0-9_]*?)_(API_KEY|TOKEN|SECRET|ACCESS_TOKEN|API_TOKEN)\s*=\s*([^\s#].*)$/gm;
                let m: RegExpExecArray | null;
                while ((m = pattern.exec(env)) !== null) {
                  const fullKey = `${m[1]}_${m[2]}`;
                  if (knownTokenKeys.has(fullKey)) continue; // already surfaced as gateway
                  if (PROVIDER_KEYS.has(fullKey)) continue;  // provider, comes from auth.json
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
              { name: "Notion", slug: "notion", probe: "test -n \"$NOTION_TOKEN\"" },
              { name: "Airtable", slug: "airtable", probe: "test -n \"$AIRTABLE_API_KEY\"" },
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
                    ? { provider: model.provider, name: model.name }
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
            if (!isLoopback(req)) { res.statusCode = 403; res.end(JSON.stringify({ error: "loopback only" })); return; }
            if (req.headers["x-claude-os-token"] !== REFRESH_TOKEN) { res.statusCode = 403; res.end(JSON.stringify({ error: "invalid token" })); return; }
            let raw = ""; for await (const chunk of req as any) raw += chunk;
            let key = "", base = "";
            try { const b = JSON.parse(raw || "{}"); if (typeof b.key === "string") key = b.key.trim(); if (typeof b.base === "string") base = b.base.trim(); } catch { /* ignore */ }
            // `base` decides where the user's OpenAI key gets sent — allowlist it (OpenAI, or a
            // local model server) so a caller can't redirect the Bearer key to an attacker host.
            if (base) {
              let baseOk = false;
              try { const u = new URL(base); baseOk = !u.username && !u.password && ((u.protocol === "https:" && u.hostname === "api.openai.com") || u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "[::1]"); } catch { /* invalid */ }
              if (!baseOk) { res.statusCode = 400; res.end(JSON.stringify({ error: "base_not_allowed" })); return; }
            }
            const health = async () => { try { const r = await fetch("http://127.0.0.1:8099/api/health"); if (r.ok) return (await r.json()) as any; } catch { /* down */ } return null; };
            let h = await health();
            if (h && h.keyed) { res.end(JSON.stringify({ ok: true, already: true, keyed: true })); return; }
            if (!key && !base) { res.statusCode = 400; res.end(JSON.stringify({ error: "no_key" })); return; }
            try {
              if (voiceChild && voiceChild.exitCode === null) { try { voiceChild.kill(); } catch { /* ignore */ } }
              const childEnv: Record<string, string> = { ...(process.env as any), PORT: "8099" };
              if (key) childEnv.OPENAI_API_KEY = key;
              if (base) childEnv.OPENAI_BASE_URL = base;
              voiceChild = spawn("bun", ["run", "voice-lab/server.ts"], { cwd: process.cwd(), env: childEnv, stdio: "ignore" });
              voiceChild.on("exit", () => { voiceChild = null; });
            } catch (e: any) { res.statusCode = 500; res.end(JSON.stringify({ error: e?.message || "spawn_failed" })); return; }
            for (let i = 0; i < 30; i++) {
              await new Promise((r) => setTimeout(r, 200));
              h = await health();
              if (h && h.ok) { res.end(JSON.stringify({ ok: true, keyed: !!h.keyed })); return; }
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
                  const provider = block
                    .match(/^\s+provider:\s*["']?([^"'\n]+)/m)?.[1]
                    ?.trim();
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
            // Tiers: top (frontier), mid (default), cheap (fast/small),
            // free (no-cost tier).
            const catalog = [
              {
                provider: "openai",
                models: [
                  { name: "gpt-5.5", tier: "top" },
                  { name: "gpt-5.5-pro", tier: "top" },
                  { name: "gpt-5.3-codex", tier: "mid" },
                  { name: "gpt-5.4-nano", tier: "cheap" },
                ],
              },
              {
                provider: "anthropic",
                models: [
                  { name: "claude-fable-5", tier: "top" },
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
                  { name: "z-ai/glm-5.2", tier: "top" }, // best GLM — 1M ctx
                  { name: "anthropic/claude-opus-4.8", tier: "top" },
                  { name: "anthropic/claude-sonnet-5", tier: "top" }, // launched 2026-06-30 · 1M ctx · $2/$10
                  { name: "openai/gpt-5.5", tier: "top" },
                  { name: "deepseek/deepseek-v4-pro", tier: "top" },
                  { name: "x-ai/grok-4.3", tier: "mid" },
                  { name: "google/gemini-3.5-flash", tier: "mid" },
                  { name: "minimax/minimax-m3", tier: "mid" },
                  { name: "qwen/qwen3.7-plus", tier: "mid" },
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
                  { name: "gpt-5.5", tier: "top" },
                  { name: "gpt-5.5-pro", tier: "top" },
                  { name: "gpt-5.3-codex", tier: "mid" },
                ],
              },
              {
                provider: "xai-oauth",
                models: [
                  { name: "grok-4.3", tier: "top" },
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
                  { name: "grok-4.3", tier: "top" },
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
                models: [
                  { name: "llama-3.3-70b-versatile", tier: "mid" },
                ],
              },
              {
                provider: "cohere",
                models: [
                  { name: "command-a", tier: "top" },
                ],
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
                  mixtures = Object.entries(presets).map(
                    ([name, p]: [string, any]) => ({
                      name,
                      references: Array.isArray(p?.reference_models)
                        ? p.reference_models.length
                        : 0,
                      aggregator: p?.aggregator?.model
                        ? String(p.aggregator.model)
                        : undefined,
                    }),
                  );
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
                  OPENAI_API_KEY: "openai",
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
            try {
              const cfg = yaml.load(
                readFileSync(join(homedir(), ".hermes", "config.yaml"), "utf-8"),
              ) as any;
              for (const k of Object.keys(cfg?.providers ?? {})) configured.add(k.toLowerCase());
            } catch {
              /* ignore */
            }
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(
              JSON.stringify({
                default: defaultModel,
                catalog,
                mixtures,
                configured: Array.from(configured),
              }),
            );
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
                res.end(
                  JSON.stringify({ ok: true, cmd, output: clean || "(no output)", code }),
                );
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
                same =
                  readFileSync(srcPath, "utf-8") === readFileSync(mirrorPath, "utf-8");
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
          server.middlewares.use("/__hermes_memory", (req, res, next) => {
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
                const provMatch = clean.match(
                  /^Provider:\s*([a-z0-9_-]+)/i,
                );
                if (provMatch) providerActive = provMatch[1] ?? null;
                // Available plugin rows — "• name  (requires API key)" etc.
                const pluginMatch = clean.match(
                  /^[•·*]\s+([a-z0-9_-]+)\s*(?:\(([^)]+)\))?/i,
                );
                if (pluginMatch) {
                  const name = pluginMatch[1] ?? "";
                  const meta = (pluginMatch[2] ?? "").toLowerCase();
                  const needsKey = /(requires|needs)\s+api\s*key/.test(meta) ||
                    /api\s+key/.test(meta);
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

            // Quick counts for the readout
            let sessionCount = 0;
            try {
              const sd = join(hermesHome, "sessions");
              if (existsSync(sd)) {
                sessionCount = readdirSync(sd).filter((f) => f.endsWith(".json")).length;
              }
            } catch {
              /* ignore */
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
          server.middlewares.use("/__hermes_sessions", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
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
              if (existsSync(sessionsDir)) {
                const files = readdirSync(sessionsDir)
                  // Two real session formats live here:
                  //   • session_<timestamp>_<id>.json    (current format)
                  //   • <timestamp>_<id>.jsonl           (older format)
                  // Plus noise that must NOT be treated as sessions:
                  //   • sessions.json                    (the master index)
                  //   • request_dump_*.json              (per-request error
                  //       dumps — diagnostic snapshots, not conversations.
                  //       Previously polluted the visible list with all-
                  //       null-field rows because they have no
                  //       session_start / last_updated / messages.)
                  //   • .DS_Store / .lock / dotfiles
                  .filter(
                    (f) =>
                      (f.endsWith(".json") || f.endsWith(".jsonl")) &&
                      f !== "sessions.json" &&
                      !f.startsWith("request_dump_") &&
                      !f.startsWith("."),
                  )
                  .map((name) => ({
                    name,
                    mtime: statSync(join(sessionsDir, name)).mtimeMs,
                  }))
                  .sort((a, b) => b.mtime - a.mtime)
                  // Cap raised from 20 → 200. The /agents/hermes
                  // ActivityCard builds a 7-day bar chart from these and
                  // was silently truncating real activity at 20 items.
                  // 200 covers ~3 weeks of heavy use comfortably.
                  .slice(0, 200);
                for (const f of files) {
                  try {
                    const raw = readFileSync(join(sessionsDir, f.name), "utf-8");
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
                        typeof j?.message_count === "number"
                          ? j.message_count
                          : msgs.length,
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
                const indexRaw = readFileSync(indexPath, "utf-8");
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
                    messageCount:
                      typeof i.message_count === "number" ? i.message_count : 0,
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
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ sessions: out }));
          });

          // GET /__hermes_session?id=<session_id> — full message list for one
          // session, so the dashboard can render a Telegram-style sidebar:
          // click a thread, see its history. Loopback only. Returns the
          // session_id, model, platform, and full messages array.
          server.middlewares.use("/__hermes_session", (req, res, next) => {
            if (req.method !== "GET") return next();
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "loopback only" }));
              return;
            }
            const url = new URL(req.url || "", "http://localhost");
            const id = url.searchParams.get("id");
            if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid id" }));
              return;
            }
            const sessionsDir = join(homedir(), ".hermes", "sessions");
            // Hermes session files include a timestamp prefix, so we search
            // by suffix match. Bounded scan because we only ship 20 recent
            // anyway, and the directory is the user's own.
            let match: string | null = null;
            try {
              const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
              for (const f of files) {
                if (f.includes(id) || f.startsWith(id) || f.replace(/\.json$/, "") === id) {
                  match = f;
                  break;
                }
              }
            } catch {
              /* ignore */
            }
            if (!match) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: "not found" }));
              return;
            }
            try {
              const raw = readFileSync(join(sessionsDir, match), "utf-8");
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
                            typeof c === "string" ? c : c?.text ?? c?.content ?? "",
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
          function resolveInsideDocs(
            rawPath: string,
            allowTrash = false,
          ): string | null {
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
            if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"].includes(e)) return "image";
            if (["pdf"].includes(e)) return "pdf";
            if (["html", "htm"].includes(e)) return "html";
            if (["md", "markdown", "mdx"].includes(e)) return "markdown";
            if (["txt", "log"].includes(e)) return "text";
            if (["json", "yaml", "yml", "toml", "csv", "tsv"].includes(e)) return "data";
            if (["mp4", "mov", "webm", "mkv", "avi"].includes(e)) return "video";
            if (["mp3", "wav", "ogg", "m4a", "flac"].includes(e)) return "audio";
            if (["zip", "tar", "gz", "tgz", "7z", "rar"].includes(e)) return "archive";
            if (["ts", "tsx", "js", "jsx", "py", "rb", "go", "rs", "java", "c", "cpp", "sh"].includes(e)) return "code";
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
                  title =
                    parsed?._hermes?.title ??
                    parsed?.title ??
                    parsed?.name ??
                    null;
                  description =
                    parsed?._hermes?.description ??
                    parsed?.description ??
                    parsed?.summary ??
                    null;
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
                .map((l) =>
                  l.replace(/^\s*(\/\/|#|--|\/\*|\*)\s?/, "").trim(),
                )
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
                png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
                gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
                bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
                pdf: "application/pdf",
                html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
                md: "text/markdown; charset=utf-8", markdown: "text/markdown; charset=utf-8",
                txt: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8",
                json: "application/json; charset=utf-8",
                yaml: "text/yaml; charset=utf-8", yml: "text/yaml; charset=utf-8",
                csv: "text/csv; charset=utf-8",
                mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
                mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
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
                if (["html", "htm", "svg", "svgz", "xhtml", "xht", "xml", "mathml", "mml"].includes(ext)) {
                  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:");
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
            let openRouterModel = "anthropic/claude-sonnet-4.6";
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
              description: "Claude Sonnet 4.6 via API (model selectable) — sends your activity to OpenRouter",
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
              description: "Uses your ChatGPT subscription (gpt-5.5) — sends your activity to OpenAI",
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
            // Sonnet 4.6 is the verified default; the rest are common options.
            const openRouterModels = [
              { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6 · default" },
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
                  "Authorization": `Bearer ${apiKey}`,
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
              if (!skillPath) throw new Error("Dream SKILL.md not found in any standard location");
              const skillText = readFileSync(skillPath, "utf-8");
              const liveDataPath = join(resolve(__dirname), "src", "data", "live-data.json");
              const liveData = existsSync(liveDataPath) ? readFileSync(liveDataPath, "utf-8") : "{}";
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
                throw new Error(`Codex produced no output (exit ${code}). ${cerr.slice(-300)}`.trim());
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
              writeFileSync(join(dreamsDir, `dream-${today}.json`), JSON.stringify(dream, null, 2), {
                mode: 0o644,
              });
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
                JSON.stringify({ ok: false, error: `failed to spawn ${chosenEngine}: ${err.message}` }),
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
              try {
                child.kill("SIGTERM");
              } catch {}
              setTimeout(() => {
                try {
                  if (!child.killed) child.kill("SIGKILL");
                } catch {}
              }, 2_000);
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
