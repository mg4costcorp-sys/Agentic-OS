/**
 * Daily snapshot history — turns the amnesiac live-data.json snapshot into a
 * time series so the dashboard can chart cost / volume / usage over time.
 *
 * Canonical store: ~/.claude-os/history.jsonl (one compact JSON record per
 * calendar day, upserted by date). It lives alongside the Dream files —
 * outside the repo — so it survives a re-clone or a hard reset of the working
 * tree, and is never at risk of being committed.
 *
 * The aggregator calls recordSnapshot() at the end of a run; it persists the
 * row and returns the recent window of records to embed into live-data.json
 * (under a `history` key) so the dashboard can render without filesystem
 * access. Every value here is an already-redacted aggregate number — no raw
 * session content ever lands in the history file.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".claude-os");
const HISTORY_PATH = join(STATE_DIR, "history.jsonl");

// How many days of history to embed into live-data.json for the chart. The
// canonical .jsonl keeps everything; this only caps what the UI loads.
const EMBED_DAYS = 90;

export interface HistoryRecord {
  date: string; // YYYY-MM-DD (local) — the upsert key
  capturedAt: string; // ISO timestamp of the run that wrote this row
  messages7d: number;
  value7d: number;
  projects: number;
  assistantTotal: number;
  claude5hPct: number;
  claudeWeeklyPct: number;
  skillRuns7d: number;
  dreamPrescriptions: number;
}

/** Local YYYY-MM-DD for the upsert key (not UTC — matches the operator's day). */
function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Pull a compact, PII-free record out of the fully-built emitted payload. */
function buildRecord(emitted: any): HistoryRecord {
  const summary = emitted?.summary ?? {};
  const cw = emitted?.usage?.claudeWindow ?? {};
  const windows: any[] = Array.isArray(cw.windows) ? cw.windows : [];
  const findPct = (needle: string, fallback: number) => {
    const w = windows.find((x) => String(x?.label ?? "").toLowerCase().includes(needle));
    return num(w?.pct, fallback);
  };
  const skillRuns7d = (Array.isArray(emitted?.skills?.active) ? emitted.skills.active : []).reduce(
    (a: number, s: any) => a + num(s?.uses7d),
    0,
  );

  return {
    date: localDate(),
    capturedAt: new Date().toISOString(),
    messages7d: num(summary.messagesLast7d),
    value7d: num(summary.valueExtracted7d),
    projects: num(summary.projectsTracked),
    assistantTotal: num(summary.totalAssistantMessages),
    claude5hPct: findPct("5-hour", num(cw.pctUsed)),
    claudeWeeklyPct: findPct("weekly", 0),
    skillRuns7d,
    dreamPrescriptions: Array.isArray(emitted?.dream?.prescriptions)
      ? emitted.dream.prescriptions.length
      : 0,
  };
}

/** Read existing rows, tolerating a missing or partially-corrupt file. */
function readExisting(): HistoryRecord[] {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    return readFileSync(HISTORY_PATH, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as HistoryRecord;
        } catch {
          return null; // skip a corrupt line rather than throwing away the file
        }
      })
      .filter((r): r is HistoryRecord => !!r && typeof r.date === "string");
  } catch {
    return [];
  }
}

/**
 * Append/update today's snapshot in ~/.claude-os/history.jsonl (upsert by
 * date — re-running the aggregator the same day overwrites the row rather than
 * duplicating it) and return the most recent EMBED_DAYS records for the UI.
 *
 * Never throws: on any failure it logs and returns whatever it could read, so
 * a history hiccup can never corrupt or block the main live-data.json write.
 */
export function recordSnapshot(emitted: any): HistoryRecord[] {
  try {
    const record = buildRecord(emitted);
    const byDate = new Map<string, HistoryRecord>();
    for (const r of readExisting()) byDate.set(r.date, r);
    byDate.set(record.date, record); // upsert today

    const all = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(HISTORY_PATH, all.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    console.log(`[aggregate] history: ${all.length} day(s) tracked → ${HISTORY_PATH}`);
    return all.slice(-EMBED_DAYS);
  } catch (err) {
    console.warn(`[aggregate] history snapshot skipped: ${(err as Error).message}`);
    try {
      return readExisting().slice(-EMBED_DAYS);
    } catch {
      return [];
    }
  }
}
