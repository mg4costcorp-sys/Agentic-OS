#!/usr/bin/env bun
/**
 * install-dream-cron.ts
 *
 * Installs (or removes) the daily Dream cron on macOS via launchd.
 *
 * macOS:
 *   - Writes ~/Library/LaunchAgents/com.claude-os.dream.plist
 *   - Loads it with `launchctl` so it fires daily at the configured time
 *     (default 07:00) and runs `scripts/run-dream.ts` on the chosen engine. Output is
 *     written to ~/.claude-os/dream-cron.log.
 *
 * Linux / other:
 *   - Prints a clean message + a `crontab` snippet the user can install by
 *     hand. We don't try to write to /etc or invoke `crontab -e` for them.
 *
 * Usage:
 *   bun run scripts/install-dream-cron.ts                # install at 07:00
 *   bun run scripts/install-dream-cron.ts --time 23:30   # custom time
 *   bun run scripts/install-dream-cron.ts --uninstall    # remove
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { IS_WIN, IS_MACOS, whichCommand, appData, localAppData } from "./platform";

const HOME = homedir();
const PLIST_LABEL = "com.claude-os.dream";
const PLIST_PATH = join(HOME, "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
const DREAM_DIR = join(HOME, ".claude-os", "dreams");
const STATE_DIR = join(HOME, ".claude-os");
const LOG_PATH = join(HOME, ".claude-os", "dream-cron.log");
// Windows Task Scheduler task name + the .cmd wrapper schtasks/Register-Task
// points at (written at install time, same role as the macOS plist).
const WIN_TASK_NAME = "ClaudeOS Dream";
const WIN_WRAPPER_PATH = join(STATE_DIR, "dream-run.cmd");
// Absolute path to the cloned repo — captured at install time so the schedule
// keeps working even if the user later moves their shell elsewhere.
const REPO_ROOT = resolve(import.meta.dir, "..");

// Resolve a CLI to an absolute path so the scheduled job doesn't depend on
// inheriting the user's interactive PATH (launchd/Task Scheduler don't). Tries
// the platform's `where`/`which`, then common install locations, else falls
// back to the bare name (a warning is printed when that happens).
function resolveBin(name: string, fallbacks: string[]): string {
  try {
    const out = spawnSync(whichCommand(), [name], { encoding: "utf-8" }).stdout ?? "";
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // On Windows `where` often lists an extensionless shell script (e.g.
    // %APPDATA%\npm\claude) before the .cmd — but a Task Scheduler .cmd
    // wrapper can only invoke a runnable file (.cmd/.exe/.bat), so prefer one.
    if (IS_WIN) {
      const runnable = lines.find((l) => /\.(cmd|exe|bat)$/i.test(l) && existsSync(l));
      if (runnable) return runnable;
    }
    if (lines[0] && existsSync(lines[0])) return lines[0];
  } catch {
    /* where/which unavailable — fall through */
  }
  for (const p of fallbacks) if (p && existsSync(p)) return p;
  return name;
}

const BUN_BIN = resolveBin(
  "bun",
  IS_WIN
    ? [join(HOME, ".bun", "bin", "bun.exe")]
    : [join(HOME, ".bun", "bin", "bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"],
);

// The Claude Code CLI ships as claude.cmd under %APPDATA%\npm on Windows (npm
// global) or as claude under Homebrew/.nvm on macOS. Neither is on the
// scheduled job's default PATH, so resolve an absolute path here.
const CLAUDE_BIN = resolveBin(
  "claude",
  IS_WIN
    ? [join(appData(), "npm", "claude.cmd"), join(localAppData(), "Programs", "claude", "claude.exe")]
    : ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
);

// Hermes CLI lookup — used only if the operator has explicitly picked Hermes
// as their Dream engine in the dashboard (~/.claude-os/config.json:
// dreamEngine). Resolves to "" when not installed.
const HERMES_BIN = (() => {
  const candidates = IS_WIN
    ? [
        join(HOME, ".local", "bin", "hermes.exe"),
        join(appData(), "npm", "hermes.cmd"),
        join(localAppData(), "Programs", "hermes", "hermes.exe"),
      ]
    : [
        join(HOME, ".local", "bin", "hermes"),
        "/opt/homebrew/bin/hermes",
        "/usr/local/bin/hermes",
      ];
  for (const p of candidates) if (existsSync(p)) return p;
  try {
    const out = spawnSync(whichCommand(), ["hermes"], { encoding: "utf-8" }).stdout ?? "";
    const first = out.split(/\r?\n/).find((l) => l.trim());
    if (first && existsSync(first.trim())) return first.trim();
  } catch {
    /* hermes not installed */
  }
  return "";
})();

// Operator's explicit engine choice from the dashboard. The OS thesis is
// "operator picks the AI" — so this cron honours the explicit selection
// stored at ~/.claude-os/config.json. We default to Claude Code (the original
// behaviour) when no choice is recorded yet, so the install script never
// silently picks an engine for the user.
function readChosenEngine(): "claude" | "hermes" | "codex" {
  try {
    const cfgPath = join(HOME, ".claude-os", "config.json");
    if (!existsSync(cfgPath)) return "claude";
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    const e = cfg?.dreamEngine;
    if (e === "hermes" || e === "claude" || e === "codex") return e;
  } catch {
    /* malformed config — fall through to default */
  }
  return "claude";
}

// Build the dream command that goes inside the plist / .cmd wrapper. We call
// the engine-agnostic runner (scripts/run-dream.ts), which reads the operator's
// chosen engine + model from ~/.claude-os/config.json at RUNTIME and dispatches
// to it (hermes/claude via CLI, codex via `codex exec`, openrouter via API). So
// a Codex/OpenRouter user's daily run no longer silently falls back to
// `claude -p` (which 401s without a setup-token), and changing the engine in the
// dashboard takes effect without reinstalling the cron.
function buildDreamCommand(): string {
  const runner = join(REPO_ROOT, "scripts", "run-dream.ts");
  return IS_WIN
    ? `"${BUN_BIN}" run "${runner}"`
    : `${shellSingleQuote(BUN_BIN)} run ${shellSingleQuote(runner)}`;
}

type Args = {
  uninstall: boolean;
  hour: number;
  minute: number;
  rawTime: string;
};

function parseArgs(argv: string[]): Args {
  let uninstall = false;
  let rawTime = "07:00";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--uninstall" || a === "-u") {
      uninstall = true;
    } else if (a === "--time" || a === "-t") {
      const next = argv[i + 1];
      if (!next) {
        console.error(`[install-dream-cron] --time requires a HH:MM argument`);
        process.exit(2);
      }
      rawTime = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      printUsageAndExit(0);
    }
  }
  const m = /^([0-2]?\d):([0-5]\d)$/.exec(rawTime);
  if (!m) {
    console.error(`[install-dream-cron] invalid --time "${rawTime}". Use HH:MM (24-hour).`);
    process.exit(2);
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23) {
    console.error(`[install-dream-cron] invalid hour "${hour}" — must be 0-23.`);
    process.exit(2);
  }
  return { uninstall, hour, minute, rawTime };
}

function printUsageAndExit(code: number) {
  console.log(
    [
      "Usage: bun run scripts/install-dream-cron.ts [options]",
      "",
      "Options:",
      "  --time HH:MM      Daily trigger time, 24-hour. Default: 07:00",
      "  --uninstall       Unload and delete the launchd plist",
      "  --help            Show this message",
    ].join("\n"),
  );
  process.exit(code);
}

// Escape a string for safe inclusion as XML character data (text node or
// attribute value). Required because REPO_ROOT and BUN_BIN are interpolated
// into the plist; any `&`, `<`, `>`, `"`, or `'` would otherwise break
// `plutil` parsing or, worse, smuggle additional XML elements.
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Wrap an arbitrary string for safe use inside a /bin/sh -c command. We use
// single-quotes which neutralise everything in POSIX sh except the closing
// quote itself; embedded `'` is escaped via the standard close/open dance.
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

function buildPlistXml(hour: number, minute: number): string {
  // Use a single ${HOME}-aware PATH so `claude` resolves whether installed
  // via Homebrew (Apple Silicon: /opt/homebrew/bin), Intel Homebrew
  // (/usr/local/bin), or a system path. launchd does not source the user's
  // shell, so PATH must be set explicitly here.
  // Run the aggregator first so live-data.json is fresh, then fire /dream.
  // The aggregator gives Dream up-to-date metrics to base its prescriptions
  // on; the dashboard also sees the refreshed numbers without the user
  // hitting the Refresh button. Using `;` (not `&&`) so a flaky aggregator
  // run doesn't block the daily Dream review.
  const cdPart = `cd ${shellSingleQuote(REPO_ROOT)}`;
  const bunPart = `${shellSingleQuote(BUN_BIN)} run scripts/aggregate.ts`;
  // Hermes-first (works headlessly via OpenRouter — no setup-token needed);
  // falls back to `claude -p` with scoped permissions when Hermes isn't
  // installed (--add-dir ~/.claude-os + acceptEdits auto-approves the file
  // write there, not arbitrary tools).
  const dreamPart = buildDreamCommand();
  const command = xmlEscape(`${cdPart} && ${bunPart} ; ${dreamPart}`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>${command}</string>
  </array>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>

  <key>RunAtLoad</key>
  <false/>

  <key>WorkingDirectory</key>
  <string>${xmlEscape(HOME)}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(`${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string>
    <key>HOME</key>
    <string>${xmlEscape(HOME)}</string>
  </dict>

  <key>StandardOutPath</key>
  <string>${xmlEscape(LOG_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(LOG_PATH)}</string>
</dict>
</plist>
`;
}

function ensureDirs() {
  const dirs = [STATE_DIR, DREAM_DIR];
  // ~/Library/LaunchAgents is only meaningful on macOS — don't litter it
  // onto Windows/Linux home directories.
  if (IS_MACOS) dirs.push(join(HOME, "Library", "LaunchAgents"));
  for (const d of dirs) {
    if (!existsSync(d)) {
      mkdirSync(d, { recursive: true });
    }
  }
  if (!existsSync(LOG_PATH)) {
    writeFileSync(LOG_PATH, "", { flag: "a" });
  }
}

function runLaunchctl(args: string[], { ignoreFailure = false }: { ignoreFailure?: boolean } = {}) {
  const r = spawnSync("launchctl", args, { stdio: "pipe", encoding: "utf-8" });
  if (r.status !== 0 && !ignoreFailure) {
    const cmd = ["launchctl", ...args].join(" ");
    console.error(`[install-dream-cron] command failed: ${cmd}`);
    if (r.stderr) console.error(r.stderr.trim());
    return false;
  }
  return true;
}

function warnIfClaudeBinUnresolved() {
  // If the resolver fell through to bare "claude", the plist will rely on
  // launchd's PATH — which doesn't include nvm or any user-installed node
  // bins. The cron will silently exit 127 at 7am tomorrow. Better to flag
  // it now than to debug "no prescriptions" days later.
  if (CLAUDE_BIN === "claude") {
    console.warn("");
    console.warn(`[install-dream] WARNING: could not resolve absolute path to 'claude'.`);
    console.warn(
      `[install-dream] The scheduled job will rely on the OS scheduler's PATH, which usually fails.`,
    );
    console.warn(`[install-dream] Install Claude Code first or add its bin dir to your shell PATH,`);
    console.warn(`[install-dream] then re-run: bun run install-dream`);
    console.warn("");
  }
}

function warnIfDreamSkillMissing() {
  // The cron will fire `claude -p "/dream"` at the configured time. If the user
  // hasn't actually copied the bundled skill into ~/.claude/skills/dream/, the
  // slash command is unknown, the cron silently does nothing, and the dashboard
  // shows samples forever. Warn loudly but don't block — the user might have
  // a custom skill location.
  const skillPath = join(HOME, ".claude", "skills", "dream", "SKILL.md");
  if (!existsSync(skillPath)) {
    console.warn("");
    console.warn(`[install-dream] WARNING: ~/.claude/skills/dream/SKILL.md not found.`);
    console.warn(
      `[install-dream] The cron will fire at the configured time but Claude won't know /dream.`,
    );
    console.warn(`[install-dream] Install the skill first:`);
    console.warn(
      `[install-dream]   mkdir -p ~/.claude/skills && cp -r skills/dream ~/.claude/skills/dream`,
    );
    console.warn(`[install-dream] Then re-run: bun run install-dream`);
    console.warn("");
  }
}

// `claude -p` (headless print mode) does NOT use OAuth — confirmed against
// Claude Code 2.1.x. It needs either ANTHROPIC_API_KEY in env or a long-lived
// token from `claude setup-token`. If the user only ever ran `claude /login`,
// the cron will fire daily but every run 401s and no dream JSON is written
// (silent failure). Print a clear notice unless we can see an env-var key.
function warnIfHeadlessAuthMissing() {
  if (process.env.ANTHROPIC_API_KEY) return;
  console.log("");
  console.log("⚠  Headless auth notice (read this — it's the #1 reason Dream silently fails)");
  console.log("   `claude -p` does NOT use the OAuth login you get from `claude /login`.");
  console.log("   Without a long-lived token, the cron fires daily but every run 401s and");
  console.log("   the dashboard shows sample prescriptions forever.");
  console.log("");
  console.log("   One-time fix (uses your existing Claude subscription, no extra cost):");
  console.log("");
  console.log("     claude setup-token");
  console.log("");
  console.log("   Or set ANTHROPIC_API_KEY in your shell profile and reinstall.");
  console.log("");
  console.log("   After fixing, verify:");
  console.log(`     launchctl kickstart -k gui/$(id -u)/com.claude-os.dream`);
  console.log(`     ls -la ~/.claude-os/dreams/           # should contain today's JSON`);
  console.log("");
}

function installMac(hour: number, minute: number, rawTime: string) {
  ensureDirs();
  // Skip Claude-specific warnings when Hermes will be used instead.
  // Hermes routes via OpenRouter so headless auth "just works".
  if (!HERMES_BIN) {
    warnIfClaudeBinUnresolved();
    warnIfHeadlessAuthMissing();
  } else {
    console.log("");
    console.log(`✓ Hermes detected at ${HERMES_BIN} — using it for the daily Dream.`);
    console.log("  (Hermes routes via its configured provider — no setup-token needed.)");
  }
  warnIfDreamSkillMissing();

  const xml = buildPlistXml(hour, minute);
  writeFileSync(PLIST_PATH, xml, "utf-8");
  console.log(`[install-dream-cron] wrote plist: ${PLIST_PATH}`);

  // Best-effort unload first (idempotent re-install). Ignore failures —
  // launchctl prints a non-zero status when the job isn't loaded yet.
  runLaunchctl(["unload", "-w", PLIST_PATH], { ignoreFailure: true });

  const ok = runLaunchctl(["load", "-w", PLIST_PATH]);
  if (!ok) {
    console.error("");
    console.error("[install-dream-cron] launchctl load failed.");
    console.error(`  Try manually:  launchctl load -w ${PLIST_PATH}`);
    process.exit(1);
  }

  console.log("");
  console.log(`Dream cron installed. Next run: tomorrow ${rawTime}.`);
  console.log(`At each run: refreshes the dashboard's live-data.json, then`);
  console.log(`fires /dream so prescriptions are based on up-to-date metrics.`);
  console.log(`Logs: ${LOG_PATH}`);
  console.log(`Plist: ${PLIST_PATH}`);
  console.log("");
  console.log("To trigger an on-demand run right now:");
  console.log(`  cd ${REPO_ROOT} && bun run scripts/aggregate.ts && bun run scripts/run-dream.ts`);
  console.log("");
  console.log("To remove:");
  console.log("  bun run uninstall-dream");
}

function uninstallMac() {
  if (existsSync(PLIST_PATH)) {
    runLaunchctl(["unload", "-w", PLIST_PATH], { ignoreFailure: true });
    try {
      unlinkSync(PLIST_PATH);
      console.log(`[install-dream-cron] removed plist: ${PLIST_PATH}`);
    } catch (err) {
      console.warn(`[install-dream-cron] could not remove ${PLIST_PATH}:`, err);
    }
  } else {
    console.log(`[install-dream-cron] no plist at ${PLIST_PATH} — nothing to do.`);
  }
  console.log(
    `Dream cron uninstalled. Log file kept at ${LOG_PATH} (delete manually if you want).`,
  );
}

// Write the .cmd Task Scheduler runs: refresh live-data.json, then fire
// /dream, both appended to the log. A wrapper file sidesteps schtasks /tr
// quoting issues with paths + arguments. CRLF line endings for cmd.exe.
function writeWindowsWrapper(): void {
  const lines = [
    "@echo off",
    `cd /d "${REPO_ROOT}"`,
    `"${BUN_BIN}" run scripts\\aggregate.ts >> "${LOG_PATH}" 2>&1`,
    // Hermes-first (works headlessly via OpenRouter — no setup-token / API
    // key required); falls back to scoped `claude -p` when Hermes isn't
    // installed (--add-dir + acceptEdits scope writes to ~/.claude-os only).
    `${buildDreamCommand()} >> "${LOG_PATH}" 2>&1`,
    "",
  ];
  writeFileSync(WIN_WRAPPER_PATH, lines.join("\r\n"), "utf-8");
}

function installWindows(hour: number, minute: number, rawTime: string) {
  ensureDirs();
  if (!HERMES_BIN) {
    warnIfClaudeBinUnresolved();
    warnIfHeadlessAuthMissing();
  }
  warnIfDreamSkillMissing();
  writeWindowsWrapper();
  console.log(`[install-dream-cron] wrote runner: ${WIN_WRAPPER_PATH}`);

  // Register (or replace) the daily task via PowerShell's ScheduledTasks
  // cmdlets — cleaner than raw schtasks for paths with spaces. -Force makes a
  // re-run idempotent. Single-quoted PS literals (with '' escaping) so paths
  // can't break the command.
  const at = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const esc = (s: string) => s.replace(/'/g, "''");
  const ps = [
    `$a = New-ScheduledTaskAction -Execute '${esc(WIN_WRAPPER_PATH)}'`,
    `$t = New-ScheduledTaskTrigger -Daily -At '${at}'`,
    `Register-ScheduledTask -TaskName '${esc(WIN_TASK_NAME)}' -Action $a -Trigger $t -Description 'ClaudeOS daily Dream review' -Force | Out-Null`,
  ].join("; ");
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    console.error("[install-dream-cron] Register-ScheduledTask failed.");
    if (r.stderr) console.error(r.stderr.trim());
    process.exit(1);
  }

  console.log("");
  console.log(`Dream task installed. Next run: tomorrow ${rawTime}.`);
  console.log(`At each run: refreshes live-data.json, then fires /dream.`);
  console.log(`Logs: ${LOG_PATH}`);
  console.log(`Task: "${WIN_TASK_NAME}" (Windows Task Scheduler)`);
  console.log("");
  console.log("To trigger an on-demand run right now:");
  console.log(`  schtasks /run /tn "${WIN_TASK_NAME}"`);
  console.log("");
  console.log("To remove:");
  console.log("  bun run uninstall-dream");
}

function uninstallWindows() {
  const r = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Unregister-ScheduledTask -TaskName '${WIN_TASK_NAME.replace(/'/g, "''")}' -Confirm:$false`,
    ],
    { stdio: "pipe", encoding: "utf-8" },
  );
  if (r.status === 0) {
    console.log(`[install-dream-cron] removed Task Scheduler task "${WIN_TASK_NAME}".`);
  } else {
    console.log(`[install-dream-cron] no task "${WIN_TASK_NAME}" found (or removal failed).`);
  }
  try {
    if (existsSync(WIN_WRAPPER_PATH)) unlinkSync(WIN_WRAPPER_PATH);
  } catch {
    /* ignore */
  }
  console.log(`Dream task uninstalled. Log file kept at ${LOG_PATH} (delete manually if you want).`);
}

function printLinuxFallback(hour: number, minute: number, rawTime: string) {
  const cron = `${minute} ${hour} * * *  /bin/sh -lc 'cd ${REPO_ROOT} && ${BUN_BIN} run scripts/run-dream.ts >> ${LOG_PATH} 2>&1'`;
  console.log("[install-dream-cron] Only macOS is auto-installable (launchd plist).");
  console.log("");
  console.log(`Detected platform: ${process.platform}`);
  console.log("");
  console.log(`To install the Dream cron manually on Linux at ${rawTime} daily:`);
  console.log("");
  console.log("  1. Make sure ~/.claude-os/dreams exists:");
  console.log(`       mkdir -p ${DREAM_DIR}`);
  console.log("");
  console.log("  2. Add this line to your crontab (run `crontab -e`):");
  console.log("");
  console.log(`       ${cron}`);
  console.log("");
  console.log("  3. Confirm `bun` resolves on your $PATH (cron has a minimal env).");
  console.log("     run-dream.ts reads your chosen engine from ~/.claude-os/config.json.");
  console.log("");
  console.log("Windows is auto-installable — just run `bun run install-dream`.");
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (IS_WIN) {
    if (args.uninstall) {
      uninstallWindows();
      return;
    }
    installWindows(args.hour, args.minute, args.rawTime);
    return;
  }

  if (process.platform !== "darwin") {
    if (args.uninstall) {
      console.log(
        "[install-dream-cron] --uninstall is macOS/Windows-only. On Linux, edit your crontab.",
      );
      process.exit(0);
    }
    warnIfDreamSkillMissing();
    printLinuxFallback(args.hour, args.minute, args.rawTime);
    process.exit(0);
  }

  if (args.uninstall) {
    uninstallMac();
    return;
  }

  installMac(args.hour, args.minute, args.rawTime);
}

main();
