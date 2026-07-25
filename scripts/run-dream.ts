#!/usr/bin/env bun
/**
 * Engine-agnostic Dream runner — the single entry point the daily cron calls.
 *
 * Reads the operator's chosen engine + model from ~/.claude-os/config.json and
 * runs the Dream on whichever engine they picked in the dashboard:
 *   - hermes / claude : spawn the CLI with the /dream skill (agentic — the skill
 *                       reads the raw files and writes the dream JSON itself).
 *   - codex           : `codex exec` with the assembled prompt (ChatGPT OAuth,
 *                       gpt-5.5). We capture the final message and write the JSON.
 *   - openrouter      : direct API call (default anthropic/claude-sonnet-4.6, or
 *                       config.openRouterModel). We write the JSON.
 *
 * Why this exists: the cron used to hardcode hermes/claude, so a user who picked
 * Codex or OpenRouter got a 7am job that silently fell back to `claude -p` and
 * 401'd without a setup-token. Resolving the engine fresh at runtime here means
 * whatever they picked actually runs, and a later dashboard change takes effect
 * without reinstalling the cron.
 *
 * Privacy: for codex/openrouter the aggregated activity (live-data.json) is sent
 * to that provider — the same as any cloud AI feature. The dashboard picker
 * discloses this per-engine.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { IS_WIN, whichCommand, appData, localAppData } from "./platform";

const HOME = homedir();
const REPO = resolve(import.meta.dir, "..");
const STATE_DIR = join(HOME, ".claude-os");
const DREAMS_DIR = join(STATE_DIR, "dreams");
const CONFIG = join(STATE_DIR, "config.json");
const today = new Date().toISOString().slice(0, 10);
// Fable 5 — frontier tier. The Dream is an overnight batch job, so we spend
// the deepest model on it by default; latency is free at 7am.
const DEFAULT_OR_MODEL = "anthropic/claude-fable-5";

function readConfig(): { dreamEngine?: string; openRouterModel?: string } {
  try {
    if (existsSync(CONFIG)) return JSON.parse(readFileSync(CONFIG, "utf-8")) || {};
  } catch {
    /* malformed config */
  }
  return {};
}

// Resolve a CLI: known locations first, then PATH (nvm/npm/brew). Returns
// undefined when not found anywhere.
function resolveBin(name: string, fallbacks: string[]): string | undefined {
  for (const p of fallbacks) if (p && existsSync(p)) return p;
  try {
    const out = spawnSync(whichCommand(), [name], { encoding: "utf-8" }).stdout ?? "";
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

const hermesBin = () =>
  resolveBin(
    "hermes",
    IS_WIN
      ? [join(HOME, ".local", "bin", "hermes.exe"), join(appData(), "npm", "hermes.cmd")]
      : [join(HOME, ".local", "bin", "hermes"), "/opt/homebrew/bin/hermes", "/usr/local/bin/hermes"],
  );
const claudeBin = () =>
  resolveBin(
    "claude",
    IS_WIN
      ? [join(appData(), "npm", "claude.cmd"), join(localAppData(), "Programs", "claude", "claude.exe")]
      : ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
  );
const codexBin = () =>
  resolveBin(
    "codex",
    IS_WIN
      ? [join(appData(), "npm", "codex.cmd"), join(localAppData(), "Programs", "codex", "codex.exe")]
      : ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"],
  );

function openRouterKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  for (const f of [join(HOME, ".hermes", ".env"), join(STATE_DIR, ".env.local"), join(REPO, ".env.local")]) {
    if (!existsSync(f)) continue;
    try {
      const m = readFileSync(f, "utf-8").match(/^\s*OPENROUTER_API_KEY\s*=\s*"?([^"\n\r]+)"?\s*$/m);
      if (m?.[1]) return m[1].trim();
    } catch {
      /* unreadable */
    }
  }
  return "";
}

function assemblePrompt(): { system: string; user: string } {
  const skillPath = [
    join(HOME, ".claude", "skills", "dream", "SKILL.md"),
    join(HOME, ".hermes", "skills", "dream", "SKILL.md"),
    join(REPO, "skills", "dream", "SKILL.md"),
  ].find((p) => existsSync(p));
  if (!skillPath) throw new Error("Dream SKILL.md not found in any standard location");
  const skill = readFileSync(skillPath, "utf-8");
  const liveDataPath = join(REPO, "src", "data", "live-data.json");
  const live = existsSync(liveDataPath) ? readFileSync(liveDataPath, "utf-8") : "{}";
  const system = [
    skill,
    "",
    "---",
    "IMPORTANT: You are being run non-interactively with no file tools. Your ENTIRE",
    "reply must be a single valid JSON object matching the skill's schema — no",
    "markdown fences, no prose.",
    `Set "date" to "${today}" and "generatedAt" to the current ISO timestamp.`,
  ].join("\n");
  const user = [
    "Operator's aggregated activity data:",
    "",
    live,
    "",
    "Produce the dream prescription JSON now.",
  ].join("\n");
  return { system, user };
}

function parseDreamJson(raw: string): any {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

function writeDream(dream: any): void {
  if (!existsSync(DREAMS_DIR)) mkdirSync(DREAMS_DIR, { recursive: true });
  writeFileSync(join(DREAMS_DIR, `dream-${today}.json`), JSON.stringify(dream, null, 2), { mode: 0o644 });
}

function runAgenticCli(bin: string, args: string[], label: string): number {
  console.log(`[run-dream] ${label}: launching ${bin}`);
  const r = spawnSync(bin, args, { stdio: "inherit", timeout: 240_000 });
  return r.status ?? 1;
}

function runCodex(bin: string): void {
  const { system, user } = assemblePrompt();
  const prompt = `${system}\n\n${user}`;
  // Private per-run temp dir (not a predictable shared-tmp path) so there's no
  // symlink race or cross-run collision on the captured output file.
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-os-codex-"));
  const outFile = join(tmpDir, "dream.json");
  try {
    const r = spawnSync(
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
      { input: prompt, encoding: "utf-8", timeout: 240_000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (!existsSync(outFile)) {
      throw new Error(`codex produced no output (exit ${r.status}). ${(r.stderr || "").slice(-300)}`.trim());
    }
    writeDream(parseDreamJson(readFileSync(outFile, "utf-8")));
    console.log(`[run-dream] codex wrote dream-${today}.json`);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function runOpenRouter(model: string): Promise<void> {
  const key = openRouterKey();
  if (!key) throw new Error("OPENROUTER_API_KEY not found (env, ~/.hermes/.env, or .env.local)");
  const { system, user } = assemblePrompt();
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(240_000),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://127.0.0.1:8081",
      "X-Title": "Claude OS Dream",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.4,
      max_tokens: 8000,
    }),
  });
  if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data: any = await resp.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("OpenRouter returned no content");
  writeDream(parseDreamJson(content));
  console.log(`[run-dream] openrouter (${model}) wrote dream-${today}.json`);
}

async function main(): Promise<void> {
  const cfg = readConfig();
  let engine = (cfg.dreamEngine || "").toLowerCase();
  const model =
    cfg.openRouterModel && /^[\w./:-]{1,80}$/.test(cfg.openRouterModel)
      ? cfg.openRouterModel
      : DEFAULT_OR_MODEL;

  const have = {
    hermes: hermesBin(),
    claude: claudeBin(),
    codex: codexBin(),
    openrouter: !!openRouterKey(),
  };

  // No/unknown engine → auto-pick the first available so the daily dream never
  // silently no-ops or falls back to a 401-ing engine.
  if (!["hermes", "claude", "codex", "openrouter"].includes(engine)) {
    engine = have.hermes ? "hermes" : have.openrouter ? "openrouter" : have.codex ? "codex" : "claude";
    console.log(`[run-dream] no engine in config — auto-selected '${engine}'`);
  }

  try {
    if (engine === "hermes") {
      if (!have.hermes) throw new Error("hermes not installed");
      const code = runAgenticCli(have.hermes, ["chat", "-Q", "--skills", "dream", "--yolo", "-q", "/dream"], "hermes");
      if (code !== 0) throw new Error(`hermes exited ${code}`);
    } else if (engine === "claude") {
      const bin = have.claude ?? "claude";
      const code = runAgenticCli(
        bin,
        ["-p", "/dream", "--add-dir", STATE_DIR, "--permission-mode", "acceptEdits"],
        "claude",
      );
      if (code !== 0)
        throw new Error(`claude exited ${code} — headless needs 'claude setup-token' or ANTHROPIC_API_KEY`);
    } else if (engine === "codex") {
      if (!have.codex) throw new Error("codex not installed");
      runCodex(have.codex);
    } else if (engine === "openrouter") {
      await runOpenRouter(model);
    }
    console.log(`[run-dream] done (engine=${engine})`);
  } catch (err) {
    console.error(`[run-dream] FAILED (engine=${engine}): ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
