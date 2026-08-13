#!/usr/bin/env node
// design-capture.mjs — Claude Code PostToolUse hook that records every media
// file the agent creates into the Design ledger, the second it lands.
//
//   ~/.claude-os/design/ledger.jsonl   (one JSON object per line)
//
// The dashboard's Creations tab reads this ledger. The hook must NEVER get in
// the agent's way: any failure — bad JSON on stdin, unreadable transcript,
// full disk — exits 0 with no output. Recording is best-effort; the session
// always wins.
//
// Installed by scripts/install-design-capture.ts, which registers it in
// ~/.claude/settings.json under hooks.PostToolUse (matcher: Write|Bash).

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MEDIA_EXT = /\.(png|jpe?g|webp|gif|avif|svg|mp4|mov|webm|m4v)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
const LEDGER_DIR = join(homedir(), ".claude-os", "design");
const LEDGER = join(LEDGER_DIR, "ledger.jsonl");
// Only count files that appeared just now. A Bash command can *mention* an
// existing image ("curl -F file=@old.png"); a five-minute mtime window keeps
// inputs out while still catching anything the command actually produced.
const FRESH_MS = 5 * 60 * 1000;

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

// Last real user message from the session transcript, as a prompt hint.
// Transcripts are JSONL; we walk from the end and skip tool results, command
// wrappers and system-reminder noise. Best-effort — null is fine.
function promptHint(transcriptPath) {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    const lines = readFileSync(transcriptPath, "utf-8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== "user" || entry?.message?.role !== "user") continue;
      const content = entry.message.content;
      let text = null;
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        const part = content.find((p) => p?.type === "text" && typeof p.text === "string");
        if (part) text = part.text;
      }
      if (!text) continue;
      text = text.trim();
      // Wrapped slash-command payloads and system reminders aren't what the
      // user said; keep looking for a real message.
      if (text.startsWith("<") || text.startsWith("Caveat:")) continue;
      return text.length > 280 ? `${text.slice(0, 277)}…` : text;
    }
  } catch {
    /* transcript unreadable — no hint */
  }
  return null;
}

// Candidate media paths for one tool call.
function candidates(toolName, toolInput, cwd) {
  const out = [];
  if (toolName === "Write" || toolName === "Edit") {
    const p = toolInput?.file_path;
    if (typeof p === "string" && MEDIA_EXT.test(p)) out.push(p);
  } else if (toolName === "Bash") {
    const cmd = typeof toolInput?.command === "string" ? toolInput.command : "";
    // Pull path-shaped tokens ending in a media extension. Quoted or bare;
    // ~, absolute, or relative to the session cwd.
    const re = /(["']?)((?:~|\.{0,2})?[\w./\\ -]*?\.(?:png|jpe?g|webp|gif|avif|svg|mp4|mov|webm|m4v))\1/gi;
    let m;
    while ((m = re.exec(cmd)) !== null) {
      let p = m[2].trim();
      if (!p || p.includes("*")) continue;
      if (p.startsWith("~")) p = join(homedir(), p.slice(1));
      out.push(isAbsolute(p) ? p : resolve(cwd || process.cwd(), p));
    }
  }
  return out;
}

// Paths already in the ledger tail, so a retried Write or a re-run command
// doesn't produce duplicate cards.
function recentPaths() {
  try {
    if (!existsSync(LEDGER)) return new Set();
    const lines = readFileSync(LEDGER, "utf-8").trim().split("\n").slice(-200);
    const seen = new Set();
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e?.path && (e?.ts ?? 0) > cutoff) seen.add(e.path);
      } catch {
        /* skip bad line */
      }
    }
    return seen;
  } catch {
    return new Set();
  }
}

try {
  const input = JSON.parse(readStdin());
  const toolName = input?.tool_name ?? "";
  const cwd = input?.cwd ?? process.cwd();
  const now = Date.now();
  const seen = recentPaths();
  const records = [];

  for (const raw of candidates(toolName, input?.tool_input, cwd)) {
    let full;
    try {
      full = resolve(raw);
    } catch {
      continue;
    }
    if (seen.has(full)) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // mentioned but never created
    }
    if (!st.isFile()) continue;
    if (now - st.mtimeMs > FRESH_MS) continue; // pre-existing input, not output
    if (st.size < 2_000) continue; // favicons and 1px spacers aren't work
    seen.add(full);
    records.push({
      ts: now,
      path: full,
      agent: "claude",
      tool: toolName,
      kind: VIDEO_EXT.test(full) ? "video" : "image",
      bytes: st.size,
      session: input?.session_id ?? null,
      cwd,
      prompt: null, // filled below, once, if anything matched
    });
  }

  if (records.length) {
    const hint = promptHint(input?.transcript_path);
    for (const r of records) r.prompt = hint;
    mkdirSync(LEDGER_DIR, { recursive: true });
    appendFileSync(LEDGER, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
} catch {
  /* never block the session */
}
process.exit(0);
