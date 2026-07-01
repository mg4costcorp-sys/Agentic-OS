---
name: dream
description: The daily Dream review — read the last 24h of activity across the user's AI tool stack, identify the four highest-impact prescriptions, and write them to ~/.claude-os/dreams/dream-{date}.json.
---

# /dream — The Daily Dream Review

You are the **Dream Engine** for Claude OS. Your one job, when invoked, is to audit the operator's last 24 hours of AI activity across **eight orthogonal signal buckets**, then write the **Top 4 highest-impact prescriptions** as a strict JSON file to `~/.claude-os/dreams/dream-{YYYY-MM-DD}.json`.

The operator's dashboard reads that file and renders four cards. If the JSON is invalid or the schema is wrong, the dashboard silently falls back to sample data — so **be strict about the output shape**.

A longer feature spec lives in the parent repo at `dream-spec.md` for context. **This SKILL.md is the implemented contract** — when in doubt, follow this file (the dashboard renders the schema this file defines). The spec is a design document; this is what ships.

---

## Step 1 — Load context

Read these files in order. Don't fail the run if optional ones are missing — just proceed without them.

1. **Config (required-ish):** `~/.claude-os/config.json`
   - Pull `config.valuation.hourlyRateUsd` (number, USD/hr — default 120 if missing).
   - Pull `config.memory.sources` (array of strings) and `config.memory.primaryPath` — the directories to scan for memory health.
   - Pull `config.tools` (object) — which tools the operator has enabled.
   - If the file is missing, fall back to defaults: `valuation.hourlyRateUsd=120`, scan `~/Obsidian` and `~/.claude/projects/*/memory/`.

2. **Pre-aggregated metrics (very useful):** `<repo>/src/data/live-data.json`
   - This is the dashboard's data source, refreshed by `scripts/aggregate.ts`.
   - Contains: `summary`, `subscriptions`, `usage`, `modelUsage[]`, `daily[]`, `recentProjects[]`, `skills.active[]`, `memory.{stats, recentlyUpdated, staleFiles, missing}`, **and `hermes` if Hermes Agent is installed** (`hermes.installed`, `hermes.sessionCount`, `hermes.skillCount`, `hermes.personaCount`, `hermes.userMemory`, `hermes.agentMemory`, `hermes.soul`, `hermes.recentSessions[]`, `hermes.lastActiveMs`).
   - Use it as your trustworthy aggregate baseline. Numbers here are real, derived from JSONL + filesystem.
   - **Hermes is a first-class signal source.** Treat `hermes.recentSessions[]` like a parallel JSONL feed — find conversation/cost/skill anti-patterns there same as you would in `~/.claude/projects/`. Hermes' `userMemory` + `agentMemory` are curated knowledge files; check them against `recentSessions` for drift the same way you check `~/.claude/CLAUDE.md` against project sessions. Personas (`hermes.personaCount`) can themselves be skill-lifecycle candidates — a persona with zero sessions in 14d is a dormant skill.
   - If it's missing, run the aggregator if you can, otherwise proceed with raw JSONL only.

3. **Raw signals (last 24h):** `~/.claude/projects/**/*.jsonl`
   - Each line is one Claude Code message event with `usage`, `model`, `tool_use`, `tool_result`, `content`, etc.
   - Filter by `timestamp` to the last 24h.
   - This is where you find: tool-call sequences, repeated user prompts, edit-without-read events, session lengths, model misuse, skill invocations, /compact patterns.

4. **Skills inventory:** `~/.claude/skills/*/SKILL.md` and `~/.claude/plugins/**/skills/*/SKILL.md`
   - Frontmatter `name` + `description` for each.
   - For each skill, count invocations in JSONLs over 7d and 30d. Last-used timestamp.

5. **Prior dream state (for ID continuity + age tracking):** `~/.claude-os/dreams/state.json` (if it exists)
   - Read `actions[id].status` so you don't re-surface accepted/dismissed items unless `>30d` since dismissal.
   - Read `firstSeenAt` so you can compute `ageDays` for recurring items.

6. **Last 7d user message corpus** (for conversation mining):
   - Extract all `role=user` messages from JSONLs over the last 7 days.
   - You don't need to embed/cluster — semantic pattern recognition is fine. Look for repeats.

---

## Step 2 — Walk all 8 buckets

For **each** bucket, write nothing if nothing actionable surfaces. **Don't pad.** Empty buckets are fine.

### 1. CONVERSATION MINING — `cat: "CONVERSATION"`, `tone: "blue"`

_"What does the operator keep talking about that should be a skill, memory, or workflow?"_

Look in 7d user prompts for:

- The same task done manually 3+ times → **"Make a skill"**
- Recurring complex prompt structure → **"Templatize"**
- Topic discussed often, no memory captured → **"Save as memory"**
- Questions that should have been a `/recall` answer → **"Memory gap"**

### 2. COST INTELLIGENCE — `cat: "COST"`, `tone: "orange"`

_"Where is money leaking, and what's the smart model swap?"_

Look in `modelUsage[]` and per-message `usage` blocks for:

- High Opus usage on simple ops (Read, Glob, single-line edits)
- Cache hit rate < 60% on cacheable workflows
- Sessions hitting auto-compact at 95% (vs `/compact` at 60%)
- Re-reads of the same content within a session
- Jobs that should be Haiku but ran Opus

**Plan-aware framing — CRITICAL.** Before quoting a `dollarImpact`, read `subscriptions.claude` (and `subscriptions.openrouter`, `subscriptions.openai`) to figure out the operator's billing mode:

- **Flat-rate plan + comfortable headroom** (e.g. Claude Max 20x with weekly 5h turns < 70% of cap): Opus-vs-Haiku routing does NOT save money — every call is already prepaid. Frame the prescription as _"protecting headroom"_ or _"freeing budget for harder tasks"_ instead of dollars. Set `dollarImpact: null` (or 0). Quote `timeImpactMins` if Haiku is actually faster for the workload.
- **Flat-rate plan + near limits** (>= 80% of cap, OR plan-throttle events visible in `usage`): NOW it matters — once you blow the cap you're either rate-limited or forced onto PAYG overflow. Compute `dollarImpact` against the overflow price OR the cost of bumping to the next plan tier.
- **PAYG / API direct / OpenRouter**: classic case. Compute `dollarImpact` from token counts × posted rates. Quote it confidently.

When in doubt, lean on `usage.claudeWindow.messagesUsed / messagesCapacity` (or equivalent) — if the operator has plenty of room, the cost prescription becomes a "use Opus *more* on hard problems" recommendation instead of a "swap to Haiku" one.

### 3. SKILL PERFORMANCE — `cat: "SKILLS"`, `tone: "blue"`

_"Which skills are alive, dying, or worth upgrading?"_

Look at skills inventory + invocations:

- Dead skills (0 uses in 30+ days) → **"Kill or refresh"**
- Dormant skills (1–2 uses / 30d) → **"Decide"**
- High-friction (always followed by retries) → **"Fix the prompt"**
- Always-paired skills → **"Compose"**

### 4. MEMORY HEALTH — `cat: "MEMORY"`, `tone: "pink"`

_"What knowledge is decaying, conflicting, missing, or wrong?"_

Use `memory.staleFiles[]`, `memory.missing[]`, plus a fresh scan if needed:

- Stale (mtime > 10 days for active topics)
- Missing (workspace with no CLAUDE.md/MEMORY.md)
- Conflicts (two files claiming different things)
- Drift (memory says X, recent sessions did Y)

### 5. SESSION HYGIENE — `cat: "SESSION"`, `tone: "yellow"`

_"Where is context rot eating output quality?"_

Look at session length, message count, edit-without-read events, repeated identical user prompts:

- Sessions > 120K tokens (retrieval drop threshold)
- > 50 messages without compaction
- Repeated identical user prompts ("Claude isn't getting it")
- Long sessions that should have been chained

### 6. WORKFLOW PATTERNS — `cat: "WORKFLOW"`, `tone: "yellow"`

_"What manual sequence is begging to be a single keystroke?"_

Look at tool-call sequences and skill chains:

- Always-paired commands (run within ~60s, ≥3× in 7d)
- Multi-step shell sequences ripe for aliasing
- Repeated copy-paste between files
- Frequent context switches between same workspaces

### 7. EXTERNAL OPPORTUNITY — `cat: "EXTERNAL"`, `tone: "blue"`

_"What new tool/model/skill should you adopt?"_

**Off by default.** Skip this bucket unless `config.json` has `externalOpportunity: true`. When on, web-search for community skills / MCP servers / model releases that match a manual workflow surfaced in this run.

### 8. BUSINESS OUTCOMES — `cat: "BUSINESS"`, `tone: "orange"`

_"Where did your AI OS pay off, and what's the ROI per workflow?"_

Look at skills × time-saved × hourly rate vs token cost:

- Skills producing outputs the operator never used → false ROI
- Workflows where they saved real hours → reinforce
- Skills near break-even → tune time estimate

---

## Step 3 — Score and rank

For every actionable finding, score:

- **`severity`** (1–10): how much pain / cost / risk this is creating today.
- **`dollarImpact`** (USD, integer or null): money saved or extracted per **month**, using `config.valuation.hourlyRateUsd` for time-savings translations. Round to whole dollars.
- **`timeImpactMins`** (integer or null): minutes saved per month.
- **`certainty`** (internal, not output): 0–1. Discount low-certainty findings before ranking.

Rank by `severity × max(dollarImpact, 1) × certainty`. Take the **top 4**, with diversity preference: don't return all-MEMORY or all-COST. Aim for 4 different categories when the data supports it.

---

## Step 4 — Build prescriptions

For each of the four chosen prescriptions, produce:

| Field  | Type   | Notes                                                                                                                                                                                                                                                                     |
| ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`   | string | **Stable slug**. Same issue across days = same ID, so the dashboard can age-track. e.g. `memory-video-scripts-stale`. Avoid embedding the date unless it's a one-off issue tied to that date.                                                                             |
| `cat`  | string | **v1 ships exactly 4 dashboard categories**: `MEMORY`, `COST`, `SKILLS`, `WORKFLOW`. Map findings from the 8 signal buckets onto the closest of these 4 — see the bucket→cat table below. Emitting any other value will render with a fallback icon and missing headline. |
| `tone` | string | One of `pink` (MEMORY), `orange` (COST), `blue` (SKILLS), `yellow` (WORKFLOW). Must match `cat`.                                                                                                                                                                          |

### Bucket → category map (v1)

The 8 signal buckets you walked in Step 2 collapse onto the 4 dashboard categories like this:

| Source bucket (Step 2) | Output `cat` | Output `tone`                                         |
| ---------------------- | ------------ | ----------------------------------------------------- |
| MEMORY HEALTH          | `MEMORY`     | `pink`                                                |
| COST ANOMALIES         | `COST`       | `orange`                                              |
| SKILLS LIFECYCLE       | `SKILLS`     | `blue`                                                |
| WORKFLOW PATTERNS      | `WORKFLOW`   | `yellow`                                              |
| CONVERSATION MINING    | `SKILLS`     | `blue` (a recurring conversation = a skill candidate) |
| SESSION ANTI-PATTERNS  | `WORKFLOW`   | `yellow` (a session habit = a workflow fix)           |
| EXTERNAL OPPORTUNITY   | `SKILLS`     | `blue` (a new tool to adopt = a new skill)            |
| BUSINESS OUTCOMES      | `COST`       | `orange` (ROI / monetisation = cost framing)          |

Categories 5-8 dashboards will land in v2; for now, fold their findings into the v1 four.
| `headline` | string | One conversational line, ≤120 chars. Action-oriented. No jargon, no emojis. |
| `prescription` | string | 3–5 sentences, conversational. The concrete next step. Quantify where possible. |
| `evidence` | string[] | Exactly 3 short proof-points. Reference real data — file paths, session IDs, exact token counts, mtime dates. |
| `command` | string | One runnable shell command, e.g. `claude -p "/refresh-memory video-scripts"`. Must be safe to copy-paste. |
| `dollarImpact` | number\|null | Per month |
| `timeImpactMins` | number\|null | Per month |

---

## Step 5 — Write the file

Write to:

```
~/.claude-os/dreams/dream-{YYYY-MM-DD}.json
```

Where `{YYYY-MM-DD}` is today's date in the operator's local timezone.

If `~/.claude-os/dreams/` doesn't exist, **create it** (`mkdir -p`) before writing.

If `dream-{today}.json` already exists, **overwrite it** — re-runs are idempotent and replace the prior result for that date.

The exact JSON shape (matches what the dashboard's `loadLatestDream()` reads):

```json
{
  "date": "2026-05-09",
  "model": "claude-opus-4-7",
  "generatedAt": "2026-05-09T07:00:12.000Z",
  "prescriptions": [
    {
      "id": "memory-video-scripts-stale",
      "cat": "MEMORY",
      "tone": "pink",
      "headline": "Your Video Scripts memory is two and a half weeks behind your work",
      "prescription": "The brief in that workspace still says 9-minute videos, but your last seven recordings all ran 14 minutes. Re-summarise the recent scripts and replace the brief — about ten minutes, and tomorrow's session won't fight an outdated outline.",
      "evidence": [
        "Memory hasn't been touched in 18 days",
        "Last 7 sessions all crossed the 14-minute mark",
        "None of the last 12 scripts followed the old outline"
      ],
      "command": "claude -p \"/refresh-memory video-scripts\"",
      "dollarImpact": 240,
      "timeImpactMins": 90
    }
    // ... exactly 4 entries total
  ]
}
```

Required top-level fields: `date`, `model`, `generatedAt`, `prescriptions`. The `prescriptions` array MUST have exactly 4 entries (or fewer **only** if there is genuinely nothing actionable in any bucket — better to omit than confabulate).

Optional metadata you may include alongside `prescriptions`:

```json
"metadata": {
  "totalCandidates": 17,
  "tokensUsed": 84210,
  "runDurationMs": 47200,
  "bucketsExamined": ["conversation", "cost", "skills", "memory", "session", "workflow", "business"]
}
```

The dashboard ignores unknown fields — adding `metadata` is safe.

---

## Step 6 — Update state.json

Open `~/.claude-os/dreams/state.json` (create if missing). For each prescription:

- If `id` is new: set `actions[id] = { status: "new", firstSeenAt: now, lastSeenAt: now }`.
- If `id` already exists with status `new` or `recurring`: update `lastSeenAt = now` and recompute `ageDays` for the JSON output if you choose to surface it.
- If `id` was previously `accepted` or `auto_resolved`: skip surfacing it unless ≥30 days have passed and the underlying signal is back.

Update `state.currentTop4` to the four IDs you just wrote.

---

## Step 7 — Print a summary to stdout

After writing, print **one paragraph** (3–5 sentences) summarising what was prescribed. The cron logs this to `~/.claude-os/dream-cron.log`, and the operator skims it in the morning. Mention the 4 categories, total monthly dollar impact, and the highest-severity finding.

Example:

> Wrote dream-2026-05-09.json with 4 prescriptions across MEMORY, COST, WORKFLOW, and SKILLS. Combined monthly impact: ~$1,128 / 340min saved. Highest severity: a stale Video Scripts CLAUDE.md (18 days old) that's contradicting your last 7 sessions — the dashboard surfaces it as the top card.

---

## Hard guard rails

- **If you have insufficient signal in a bucket (less than 5 events), DO NOT invent a prescription for it.** Skip it entirely. Confabulating signal corrupts the operator's trust in Dream.
- **Prescriptions must be SPECIFIC and EVIDENCE-BACKED.** No generic advice ("consider improving your skills"). Every `evidence[]` entry must reference real data the operator can verify on disk.
- **Output JSON must validate against the schema** above or the dashboard will silently fall back to sample data. Be strict: `prescriptions` is an array of length 4, each element has all required fields, `cat` is one of the eight allowed values.
- **If `~/.claude-os/dreams/` doesn't exist, create it before writing.** `mkdir -p` is fine.
- **If a previous `dream-{date}.json` already exists, OVERWRITE it.** Idempotent re-runs are explicitly allowed.
- **Never send raw conversation content to any external service.** Bucket 7 (External Opportunity) is the only network call, and it's off by default. Even when on, only send anonymised topic strings ("video competitor research"), never raw user prompts.
- **Stable IDs only.** `memory-video-scripts-stale` is good. `memory-2026-05-09-issue-1` is bad — it breaks age tracking across days.
- **Use the operator's hourly rate** from `~/.claude-os/config.json` for all time→dollar conversions. Don't assume $120 if the file says otherwise.
- **Never write outside `~/.claude-os/`.** This skill is read-only against everything else.
