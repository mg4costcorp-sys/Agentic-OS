// install-design-capture.ts — arm the Design ledger's capture layer.
//
//   npx tsx scripts/install-design-capture.ts
//
// Three idempotent steps:
//   1. Copy the PostToolUse hook to ~/.claude-os/design/capture.mjs.
//   2. Register it in ~/.claude/settings.json (matcher Write|Bash) with an
//      ABSOLUTE node path — hooks run under /bin/sh, which doesn't load the
//      user's shell profile, so a bare `node` frequently isn't on PATH.
//   3. If Hermes is installed, drop the design-ledger skill into
//      ~/.hermes/skills/creative/ so Hermes reports its own output too.
//
// Re-running never duplicates the hook. Cross-platform: paths come from
// node:path, and the node binary is whatever is running this script.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const home = homedir();

// ── 1. the hook script ─────────────────────────────────────────────────────
const designDir = join(home, ".claude-os", "design");
mkdirSync(designDir, { recursive: true });
const hookDest = join(designDir, "capture.mjs");
copyFileSync(join(here, "design-capture.mjs"), hookDest);
console.log(`✓ hook script → ${hookDest}`);

// ── 2. register in ~/.claude/settings.json ─────────────────────────────────
const settingsPath = join(home, ".claude", "settings.json");
let settings: Record<string, any> = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch (e) {
    console.error(`✗ ${settingsPath} is not valid JSON — fix it and re-run. Nothing was changed.`);
    process.exit(1);
  }
}

// process.execPath is the node running this installer — guaranteed real.
// Quoted because "C:\Program Files\nodejs\node.exe" has a space in it.
const command = `"${process.execPath}" "${hookDest}"`;

const already = JSON.stringify(settings.hooks ?? {}).includes("capture.mjs");
if (already) {
  console.log("✓ hook already registered in settings.json — left as-is");
} else {
  settings.hooks ??= {};
  settings.hooks.PostToolUse ??= [];
  settings.hooks.PostToolUse.push({
    matcher: "Write|Bash",
    hooks: [{ type: "command", command, timeout: 10 }],
  });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`✓ PostToolUse hook registered in ${settingsPath}`);
  console.log("  (takes effect in NEW Claude Code sessions)");
}

// ── 3. Hermes skill ────────────────────────────────────────────────────────
const hermesSkills = join(home, ".hermes", "skills");
if (existsSync(hermesSkills)) {
  const dest = join(hermesSkills, "creative", "design-ledger");
  mkdirSync(dest, { recursive: true });
  copyFileSync(join(here, "hermes-design-ledger.SKILL.md"), join(dest, "SKILL.md"));
  console.log(`✓ Hermes skill → ${join(dest, "SKILL.md")}`);
} else {
  console.log("· Hermes not found (~/.hermes/skills missing) — skipped its skill");
}

console.log("\nDone. Everything Claude Code writes from the next session on —");
console.log("and everything Hermes reports — lands in Design → Creations.");
