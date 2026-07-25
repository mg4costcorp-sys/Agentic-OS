#!/usr/bin/env bun
/**
 * Claude OS — one-shot setup.
 *
 * This is the script the install agent (Claude Code) runs in the user's
 * terminal AFTER `git clone` + `bun install`, BEFORE `bun run dev`. It
 * does the heavy lifting that previously lived in a backend sidecar:
 *
 *   1. Run the aggregator (real machine scan of ~/.claude/, Pinecone,
 *      OpenRouter, Obsidian) → src/data/live-data.json
 *   2. Copy skills/dream → ~/.claude/skills/dream so `claude -p "/dream"`
 *      has a skill to run
 *   3. Install the daily Dream launchd cron (macOS) or print a crontab
 *      snippet (Linux)
 *   4. Tell the user what env keys (Pinecone, OpenRouter, etc.) would
 *      unlock more if they want them, and how to add them
 *
 * Architecture intent: the browser-side wizard is now PURE UI (localStorage
 * only — no fetch, no race, no sidecar to keep alive). All OS-level work
 * happens here in the terminal where the agent already has shell permission.
 *
 * Localhost / no network needed. macOS first-class; Linux degrades.
 */
import { existsSync } from "node:fs";
import { mkdir, cp, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const HOME = homedir();
const REPO_ROOT = join(import.meta.dir, "..");

const c = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

function log(line: string) {
  console.log(line);
}

function step(label: string) {
  console.log(`\n${c.bold}${c.cyan}▸ ${label}${c.reset}`);
}

function ok(label: string) {
  console.log(`  ${c.green}✓${c.reset} ${label}`);
}

function warn(label: string) {
  console.log(`  ${c.yellow}⚠${c.reset} ${label}`);
}

function fail(label: string) {
  console.log(`  ${c.red}✗${c.reset} ${label}`);
}

async function runAggregator(): Promise<{ ok: boolean }> {
  const aggregator = join(REPO_ROOT, "scripts", "aggregate.ts");
  if (!existsSync(aggregator)) {
    fail("scripts/aggregate.ts not found — repo state is wrong");
    return { ok: false };
  }
  const proc = Bun.spawn(["bun", "run", aggregator], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    cwd: REPO_ROOT,
  });
  const exit = await proc.exited;
  if (exit !== 0) {
    fail(`aggregator exited ${exit}`);
    return { ok: false };
  }
  return { ok: true };
}

async function copyDreamSkill(): Promise<{ ok: boolean; path: string }> {
  const src = join(REPO_ROOT, "skills", "dream");
  const dest = join(HOME, ".claude", "skills", "dream");
  if (!existsSync(src)) {
    fail(`bundled /dream skill not found at ${src}`);
    return { ok: false, path: dest };
  }
  try {
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: true });
    return { ok: true, path: dest };
  } catch (err) {
    fail(`copying /dream skill failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, path: dest };
  }
}

// Drop the `personas` skill into ~/.hermes/skills/ so a fresh Hermes session
// loads the rule that "any YAML in ~/.hermes/pantheon/personas/ is a
// first-class local entity". Without this, when an operator creates a new
// persona via the dashboard and then asks Hermes about it ("tell me about
// Orpheus"), Hermes defaults to assuming an external entity (Orpheus TTS,
// the mythology, etc.) and ignores the local YAML they just wrote.
async function copyPersonasSkill(): Promise<{ ok: boolean; path: string; existed: boolean }> {
  const src = join(REPO_ROOT, "skills", "personas");
  const dest = join(HOME, ".hermes", "skills", "personas");
  const existed = existsSync(dest);
  if (!existsSync(src)) {
    fail(`bundled personas skill not found at ${src}`);
    return { ok: false, path: dest, existed };
  }
  try {
    await mkdir(dirname(dest), { recursive: true });
    // recursive copy with overwrite so an existing skill (older version) gets
    // refreshed each time `bun run setup` runs.
    await cp(src, dest, { recursive: true, force: true });
    return { ok: true, path: dest, existed };
  } catch (err) {
    fail(
      `copying personas skill failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, path: dest, existed };
  }
}

async function wireGitHooks(): Promise<void> {
  // The repo ships a .githooks/pre-commit that scans staged content for
  // common API-key prefixes and refuses commits that include them. It only
  // fires if `core.hooksPath` is pointed at it — git's default is
  // .git/hooks and contributors will silently miss it. Setting hooksPath
  // here is idempotent and local to this clone.
  const proc = Bun.spawn(["git", "config", "--local", "core.hooksPath", ".githooks"], {
    stdout: "ignore",
    stderr: "pipe",
    cwd: REPO_ROOT,
  });
  const exit = await proc.exited;
  if (exit !== 0) {
    warn("could not set core.hooksPath (not a git checkout?) — pre-commit secret-scan disabled");
  } else {
    ok(".githooks/pre-commit wired (secret-scan on commit)");
  }
}

async function installDreamCron(): Promise<{ ok: boolean; detail: string }> {
  const plat = platform();
  // macOS (launchd) and Windows (Task Scheduler) auto-install; Linux prints a
  // crontab snippet the user installs by hand.
  if (plat !== "darwin" && plat !== "win32") {
    return { ok: true, detail: "Linux — skipped (see install-dream-cron.ts for crontab snippet)" };
  }
  const cronScript = join(REPO_ROOT, "scripts", "install-dream-cron.ts");
  if (!existsSync(cronScript)) {
    return { ok: false, detail: "install-dream-cron.ts not found" };
  }
  const proc = Bun.spawn(["bun", "run", cronScript], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    cwd: REPO_ROOT,
  });
  const exit = await proc.exited;
  if (exit !== 0) {
    return { ok: false, detail: `installer exited ${exit}` };
  }
  return { ok: true, detail: plat === "win32" ? "registered via Task Scheduler" : "loaded via launchctl" };
}

function summarizeEnvKeys() {
  const here = process.env;
  const known = [
    {
      name: "PINECONE_API_KEY",
      unlocks: "vector index counts in your memory graph",
      url: "https://app.pinecone.io",
    },
    {
      name: "OPENROUTER_API_KEY",
      unlocks: "live OpenRouter PAYG balance + per-call burn rate",
      url: "https://openrouter.ai/keys",
    },
    {
      name: "ANTHROPIC_API_KEY",
      unlocks: "raw API mode (only if you don't use Claude Code OAuth)",
      url: "https://console.anthropic.com",
    },
  ];
  const present: string[] = [];
  const missing: { name: string; unlocks: string; url: string }[] = [];
  for (const k of known) {
    if (here[k.name] && here[k.name]!.length > 4) present.push(k.name);
    else missing.push(k);
  }
  return { present, missing };
}

async function main() {
  console.log(`${c.bold}Claude OS — setup${c.reset}`);
  console.log(c.dim + "One-time scan + skill install + cron. Then `bun run dev`." + c.reset);

  step("Scan your machine (aggregator)");
  log(c.dim + "  Reads ~/.claude/, ~/.codex/, Obsidian vaults, Pinecone, OpenRouter." + c.reset);
  log(c.dim + "  macOS may prompt for keychain access on the first run." + c.reset);
  const agg = await runAggregator();
  if (!agg.ok) {
    fail("Aggregator failed — see output above. The wizard will still load with sample data.");
  } else {
    ok("live-data.json populated");
  }

  step("Install the /dream skill");
  log(c.dim + "  Copies skills/dream/ → ~/.claude/skills/dream/" + c.reset);
  const skill = await copyDreamSkill();
  if (skill.ok) ok(`installed at ${skill.path}`);
  else fail("skill not installed — Dream cards will keep showing samples");

  step("Install the personas skill into Hermes");
  log(
    c.dim +
      "  Copies skills/personas/ → ~/.hermes/skills/personas/  (so Hermes recognises personas you add via the dashboard)" +
      c.reset,
  );
  const personasSkill = await copyPersonasSkill();
  if (personasSkill.ok) {
    ok(
      `${personasSkill.existed ? "refreshed" : "installed"} at ${personasSkill.path}`,
    );
  } else {
    warn(
      "personas skill not installed — Hermes may not recognise persona names you add later",
    );
  }

  step("Install the daily Dream cron (macOS launchd · Windows Task Scheduler)");
  const cron = await installDreamCron();
  if (cron.ok) ok(cron.detail);
  else warn(`cron install: ${cron.detail}`);

  step("Dream cron auth (READ THIS — silent-failure trap)");
  if (process.env.ANTHROPIC_API_KEY) {
    ok("ANTHROPIC_API_KEY detected in env — headless Dream will authenticate");
  } else {
    log(c.dim + "  `claude -p` (headless) does NOT use the OAuth login from `claude /login`." + c.reset);
    log(c.dim + "  Without one of the options below, the cron fires daily but every run 401s" + c.reset);
    log(c.dim + "  and the dashboard shows sample prescriptions forever." + c.reset);
    log("");
    log(`  ${c.bold}Pick one (both use your existing Claude subscription):${c.reset}`);
    log(`    ${c.yellow}1.${c.reset} Run ${c.bold}claude setup-token${c.reset} once — stores a long-lived token`);
    log(`    ${c.yellow}2.${c.reset} Set ${c.bold}ANTHROPIC_API_KEY${c.reset} in your shell profile and rerun setup`);
    log("");
    log(c.dim + "  Verify after fixing:  launchctl kickstart -k gui/$(id -u)/com.claude-os.dream" + c.reset);
    log(c.dim + "  Then check:           ls ~/.claude-os/dreams/   (should contain today's JSON)" + c.reset);
    warn("headless auth not configured — fix above before the cron will write real dreams");
  }

  step("Wire git hooks (.githooks/pre-commit secret scan)");
  await wireGitHooks();

  step("Optional API keys");
  const envs = summarizeEnvKeys();
  if (envs.present.length > 0) {
    ok(`detected: ${envs.present.join(", ")}`);
  }
  if (envs.missing.length > 0) {
    log(c.dim + "  Drop any of these into claude-os/.env.local to unlock more:" + c.reset);
    for (const m of envs.missing) {
      log(`    ${c.yellow}${m.name}${c.reset}${c.dim} — ${m.unlocks}${c.reset}`);
      log(`      ${c.dim}${m.url}${c.reset}`);
    }
  }

  step("What we scan (all local, all automatic)");
  log("");
  log(`  ${c.bold}Subscriptions${c.reset}`);
  log(`  ${c.dim}  Claude     ~/.claude/credentials.json + keychain${c.reset}`);
  log(`  ${c.dim}  ChatGPT    ~/.codex/auth.json (JWT decode for plan tier)${c.reset}`);
  log(`  ${c.dim}  OpenRouter  OPENROUTER_API_KEY env var${c.reset}`);
  log("");
  log(`  ${c.bold}Integrations${c.reset}`);
  log(`  ${c.dim}  MCP servers       ~/.claude.json → mcpServers${c.reset}`);
  log(`  ${c.dim}  Claude plugins    ~/.claude/settings.json → enabledPlugins${c.reset}`);
  log(`  ${c.dim}  Claude connectors ~/.claude.json → claudeAiMcpEverConnected${c.reset}`);
  log(`  ${c.dim}  Codex plugins     ~/.codex/config.toml → [plugins.*]${c.reset}`);
  log(`  ${c.dim}  Env-based keys    FIRECRAWL_API_KEY, SUPABASE_URL, etc.${c.reset}`);
  log("");
  log(`  ${c.bold}Skills${c.reset}`);
  log(`  ${c.dim}  Installed skills  ~/.gemini/antigravity/skills/*/SKILL.md${c.reset}`);
  log(`  ${c.dim}  Usage tracking    ~/.claude/projects/**/*.jsonl (SKILL.md reads)${c.reset}`);
  log("");
  log(`  ${c.bold}Automations${c.reset}`);
  log(`  ${c.dim}  Cowork tasks      ~/Library/App Support/Claude/local-agent-mode-sessions/.../scheduled-tasks.json${c.reset}`);
  log(`  ${c.dim}  Codex automations ~/.codex/automations/*/automation.toml${c.reset}`);
  log(`  ${c.dim}  Claude tasks      ~/.claude/tasks/${c.reset}`);
  log(`  ${c.dim}  Dream cron        ~/Library/LaunchAgents/com.claude-os.dream.plist${c.reset}`);
  log("");
  log(`  ${c.bold}Memory${c.reset}`);
  log(`  ${c.dim}  Memory files      ~/.claude/CLAUDE.md, project CLAUDE.md files${c.reset}`);
  log(`  ${c.dim}  Obsidian vaults   auto-detected from ~/Library/Application Support/obsidian${c.reset}`);
  log(`  ${c.dim}  Pinecone          PINECONE_API_KEY env var${c.reset}`);
  log("");
  log(`  ${c.bold}Activity${c.reset}`);
  log(`  ${c.dim}  Sessions + usage  ~/.claude/projects/**/*.jsonl${c.reset}`);
  log(`  ${c.dim}  Model usage       per-session model tracking from JSONL${c.reset}`);

  // Drop a marker so the next `bun run dev` force-opens the wizard once,
  // even if the browser already has a stale `claude-os-config` from a
  // prior install. The vite middleware reads + deletes this file on the
  // first /__just-installed request, so re-runs of `setup` re-arm it.
  try {
    const markerDir = join(HOME, ".claude-os");
    await mkdir(markerDir, { recursive: true });
    await writeFile(join(markerDir, "show-wizard"), new Date().toISOString());
  } catch {
    /* non-fatal — wizard will still be reachable at /setup */
  }

  console.log(`\n${c.green}${c.bold}Done.${c.reset}`);
  console.log(`Run ${c.bold}bun run dev${c.reset} next — it'll open the dashboard in your browser.`);
  console.log(`${c.dim}Everything above is scanned automatically. No accounts to link, no tokens to paste.${c.reset}`);
  console.log(`${c.dim}Re-run ${c.bold}bun run setup${c.dim} any time to refresh.${c.reset}`);
}

main().catch((err) => {
  fail(`unexpected: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
