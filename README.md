# Claude OS

**A one-page, read-only operator console for your AI tool stack.**

Claude OS is for the operator running a multi-tool stack — Claude Code, ChatGPT / Codex, OpenRouter, Pinecone, Obsidian, OpenClaw — who has no honest way of knowing how much they actually use any of it. Claude OS reads what's already on your disk, never writes to source tool data directories, and renders one scrollable dashboard with subscriptions, token spend, skills ROI, a 3D memory graph, and a daily **Dream** review that prescribes the four highest-impact things to fix today.

The Dream prescription engine is the headline. Everything else is context.

> _Screenshot once you've run the aggregator — drop a 1200×630 image at `docs/screenshot.png`._

---

## Install in 60 seconds — let Claude do it

Open **Claude Code** in any terminal. Paste this prompt exactly as-is:

```
Install Claude OS for me. The Claude OS files are already on my machine
at ~/code/claude-os. Ask once for permission, then run all three commands
in order without further prompts:

1. cd ~/code/claude-os && bun install
2. cd ~/code/claude-os && bun run setup
3. cd ~/code/claude-os && bun run dev

Step 2 (`bun run setup`) does the heavy lifting on my behalf:
- Scans my machine for what it natively supports (~/.claude/,
  Obsidian vaults under ~/Documents and ~/Desktop, ~/.codex/,
  Pinecone if PINECONE_API_KEY is set, OpenRouter if its key is
  set, MCP servers, scheduled-task registries)
- Copies the /dream skill into ~/.claude/skills/dream
- Installs the daily Dream cron (macOS launchd)
- Drops a marker so the wizard auto-pops on first open
- Tells me which env keys would unlock more

If step 3 reports missing API keys I might want, ASK ME for each one
before continuing. For each key I give you:
   echo "<KEY_NAME>=<value>" >> ~/code/claude-os/.env.local
then re-run `bun run scripts/aggregate.ts` once.

If macOS prompts for a Keychain password during step 3, tell me to
enter my login password — that's macOS, not you.

Step 3 (`bun run dev`) stays running and pops the 7-step wizard in
my browser.

Once the wizard is open, send this line:

  ✨ Claude OS is ready. The wizard is open in your browser — walk
  the 7 steps and click Save at the end.

Then become my onboarding guide. DO NOT assume what's in my stack —
ASK me. Cover at least these four areas:

- Note / memory tools: Obsidian, Notion, Roam, Logseq, Apple Notes,
  Mem.ai, Bear, plain markdown folders, anything else
- Vector databases / knowledge stores: Pinecone, Weaviate, Qdrant,
  Chroma, pgvector, Mem0, Letta, Cognee, custom Postgres, etc.
- LLM / agent platforms beyond Claude Code: Cursor, Continue,
  Aider, Cody, Copilot, OpenAI direct, OpenRouter, Mistral, Groq,
  Replicate, Together
- Automation / cron systems: macOS launchd, cron, systemd, Zapier,
  n8n, Make, Cowork tasks, Codex automations

For each thing I name, be honest about three buckets:

A) AUTO-DETECTED — Claude OS already saw it (Obsidian vaults under
   default paths, ~/.claude memory, Pinecone via API key,
   OpenRouter via API key, ~/.codex/, MCP servers, Cowork tasks,
   Codex automations, launchd plists). Confirm it's in the
   dashboard and walk me through extra wiring (e.g.
   CLAUDE_OS_OBSIDIAN_PATH for vaults outside the default).

B) NEEDS WIRING — supported but the auto-scan needs a key, env
   var, or path I haven't given yet. Walk me through adding it
   to ~/code/claude-os/.env.local then re-running
   `bun run scripts/aggregate.ts`.

C) NOT YET SUPPORTED — say so plainly (e.g. Notion, Roam,
   Weaviate, Qdrant, Mem0, Cursor, Continue aren't in the native
   scanner today). Offer concrete workarounds: export to markdown
   the auto-scan picks up, drop a CLAUDE.md the tool can read,
   stash credentials in .env.local for a future version, or just
   log it as a known gap.

Also explain the daily Dream review: /dream reads my last 24h of
activity and writes 4 prescriptions to ~/.claude-os/dreams/ every
morning at 7am. Ask whether I want to run it now, change the
schedule, or skip it.

Lead with: "I can guide you through this and connect the data
specific to your computer — just tell me what's in your stack and
I'll show you what Claude OS already sees, what needs a quick
wire-up, and what isn't supported yet so we can plan around it."

Then wait for me to pick. Don't mention URLs, ports, or technical
details unless I ask.
```

Claude Code asks once for permission, you say yes, and ~60 seconds later your browser is on the wizard with the dashboard already populated by your real machine data. The wizard is a pure browser experience — no backend processes, no race conditions, no "Activate" timing out.

If you don't have Claude Code, [scroll to the manual install](#manual-install) below.

---

## What it shows

The dashboard is one long scroll. Top to bottom:

- **KPI strip** — _Spent on AI_ (last 7d API-equivalent value), _Skills saved_ (invocations × time × hourly rate), _Net ROI_ (saved minus spent). Plus an **Operator Score pill** that grades the health of your stack at a glance. Source: `~/.claude/projects/**/*.jsonl`.
- **Currently in** tile — the project you most recently worked in, with last-active timestamp. Source: JSONL `cwd` + timestamps.
- **Subscription strip** — four tiles for Claude / ChatGPT / OpenRouter / OpenClaw with the ROI multiplier on each (`$X extracted from $Y sub`). Source: macOS Keychain heuristic + `~/.codex/auth.json` + `~/.openclaw/openclaw.json` + shell env.
- **Usage panel** — the 5h Claude window bar, ChatGPT window, live OpenRouter balance, and the model split (Opus / Sonnet / Haiku / others). Source: JSONL `usage` blocks + `https://openrouter.ai/api/v1/auth/key`.
- **Skills + Skill recommender** — most-used skills, last activation, recommendations for new skills based on repeated manual sequences. Source: `~/.claude/skills/*/SKILL.md` + JSONL grep.
- **Memory graph** — 3D force-graph across Obsidian, `~/.claude/projects/*/memory/`, and Pinecone. Multi-source filter chips. Source: walked from disk + Pinecone API.
- **Integrations + Vector indexes** — installed plugins, MCP servers, and Pinecone indexes (the latter feed the memory graph as another memory source). Source: `~/.claude/plugins/installed_plugins.json` + Pinecone.
- **Automations** — scheduled Claude Code tasks. Source: `~/.claude/tasks/`. (Cron + launchd plist parsing is on the roadmap.)
- **Dream panel** — four prescription cards (memory / cost / skills / workflow), each with a runnable command you can copy. Source: `~/.claude-os/dreams/dream-{date}.json`.
- **/share route** — a 1200×630 OG card for Twitter / LinkedIn. Open `http://localhost:8081/share`, take a screenshot.

---

## Honest "what's real today"

### Works out of the box

The moment you `bun run dev`:

| Section                                                        | Notes                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Aggregator (Claude / Codex / OpenRouter / Pinecone / Obsidian) | macOS only — auto-runs from the setup wizard                            |
| Subscription detection                                         | OAuth Keychain heuristic                                                |
| Memory graph                                                   | Live data flows in once the aggregator runs                             |
| Skills (active)                                                | Real `skills.active` from JSONL parse                                   |
| Sample Dream cards                                             | Four sample prescriptions render straight from `live-data.example.json` |
| One-click setup wizard activation                              | The local sidecar boots alongside Vite via `bun run dev`                |
| One-click `[Run this fix →]`                                   | Same — backed by the bundled sidecar                                    |
| `/share` OG card                                               | Take a screenshot of the 1200×630 frame                                 |

### Needs one extra step

| Feature                                    | What's needed                                 | Command                                                                                               |
| ------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Real Dream prescriptions (vs. sample)      | Install the `/dream` skill + a daily 7am cron | `mkdir -p ~/.claude/skills && cp -r skills/dream ~/.claude/skills/dream` then `bun run install-dream` |
| Live OpenRouter balance / Pinecone indexes | Add API keys to `.env.local`                  | see [Connecting to everything](#connecting-to-everything)                                             |
| Skill recommendations                      | Pattern-detection v0 — manual review for now  | n/a                                                                                                   |

### Aspirational

| Feature                | Status                                             |
| ---------------------- | -------------------------------------------------- |
| `bun create claude-os` | 🔴 Package not yet on npm — use the files for now |

---

## Architecture

```
┌──────────────────────┐    bun run aggregate     ┌────────────────────┐
│ ~/.claude/           │ ───────────────────────▶ │ live-data.json     │
│ ~/.codex/            │                          │ (gitignored, real) │
│ ~/.openclaw/         │                          │ live-data.example  │
│ Obsidian vaults      │                          │ (committed, demo)  │
│ Pinecone API         │                          └─────────┬──────────┘
│ OpenRouter API       │                                    │
└──────────────────────┘                                    ▼
                                                 ┌────────────────────┐
                                                 │ TanStack Start app │
                                                 │ (port 8081)        │
                                                 └────────────────────┘
```

**One rule:** the frontend never reads `~/.claude/` directly. The aggregator script is the only reader on disk. The frontend reads `live-data.json` plus the most recent `~/.claude-os/dreams/dream-{date}.json`. Everything else is derived.

---

## Manual install

If you're not letting Claude run the commands, the path that works for any stranger on macOS.

**Prerequisites**

- macOS (Linux/Windows partially work — see [Linux / Windows](#linux--windows))
- [Bun](https://bun.sh) ≥ 1.0
- Claude Code installed and used at least once (so `~/.claude/projects/` exists)

**Unzip and run**

```bash
cd claude-os        # the folder you unzipped
bun install
bun run dev
```

That's it. `bun run dev` starts the Vite dev server on **http://localhost:8081** _and_ the local sidecar on **127.0.0.1:17873** in the same terminal — no second window required. Open the browser, walk the setup wizard, click **Activate now**, and the dashboard populates with your real machine's data.

If you'd rather scan from the command line, you can still run `bun run scripts/aggregate.ts` directly. The wizard does this for you on Step 2 and again on the final "Activate now" click.

---

### Windows (PowerShell)

Windows is supported alongside macOS. From PowerShell:

```powershell
# 1. Install Bun if you don't have it
irm bun.sh/install.ps1 | iex

# 2. From the unzipped folder
cd claude-os
bun install
bun run dev
```

The aggregator reads the same signals on Windows — Claude Code sessions
(`~/.claude/projects`), Codex auth, Obsidian vaults (via Obsidian's own
`%APPDATA%\obsidian\obsidian.json` registry), and apps / IDEs / terminals (via
Start-Menu shortcuts + `%LOCALAPPDATA%\Programs`). The daily **Dream** review
installs to **Windows Task Scheduler** instead of launchd:

```powershell
bun run install-dream            # --time HH:MM to change, then:
bun run uninstall-dream          # to remove the scheduled task
```

Windows-specific notes:

- macOS Keychain plan-tier detection is skipped; Claude OAuth is read from
  `~/.claude/.credentials.json`.
- For the Dream task to run unattended, `claude` must be resolvable — the
  installer looks for it at `~/.local/bin/claude.exe` or
  `%APPDATA%\npm\claude.cmd`.
- There's no Full Disk Access prompt; Windows grants the aggregator read
  access to your own profile by default.

#### Dream cron auth (applies to both macOS and Windows)

`claude -p` (headless print mode) does **not** read OAuth — only
`ANTHROPIC_API_KEY` or a long-lived token from `claude setup-token`.
If you only ever ran `claude /login`, the scheduled Dream task fires daily
but every run 401s and the dashboard shows sample prescriptions forever.

One-time fix (uses your existing Claude subscription, no extra cost):

```bash
claude setup-token        # interactive, one-time
```

Or set `ANTHROPIC_API_KEY` in your shell profile (`~/.zshrc`, `~/.bashrc`, or
`$PROFILE` on Windows) and rerun `bun run install-dream`.

Verify the fix:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.claude-os.dream
ls ~/.claude-os/dreams/            # should contain today's JSON

# Windows (PowerShell)
schtasks /run /tn "ClaudeOS Dream"
ls $env:USERPROFILE\.claude-os\dreams\
```

## The setup wizard

The setup wizard lives at `http://localhost:8081/setup`. A short Welcome pre-roll opens it; the 7 numbered steps that follow are what the Stepper at the top tracks:

| #   | Step          | What it does                                                                                                                                                                                                                                                                                       |
| --- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —   | Welcome       | Animated pre-roll + value prop. Not numbered.                                                                                                                                                                                                                                                      |
| 1   | Make it yours | Optional avatar (file picker → 256×256 base64 in localStorage)                                                                                                                                                                                                                                     |
| 2   | Detect tools  | Probes for Claude Code / Desktop / VS Code / AntiGravity / Codex / Gemini / Anthropic API / OpenAI API / OpenRouter / OpenClaw. On first run, auto-runs the aggregator via the sidecar (`POST /api/aggregate`) the first time you land on this step, then reloads with real detection results. |
| 3   | Memory        | Shows Pinecone / Obsidian / Notion / Logseq detection, lists detected Obsidian vaults, and lets you paste a vault path if detection misses it.                                                                                                                                                     |
| 4   | API keys      | Captures optional API keys for OpenRouter, Anthropic, OpenAI, KIE, Pinecone, and Notion.                                                                                                                                                                                                           |
| 5   | Time value    | Set your hourly rate so skills ROI is denominated correctly ($150/hr default)                                                                                                                                                                                                                      |
| 6   | Dream cadence | Daily or weekly schedule, morning or evening                                                                                                                                                                                                                                                       |
| 7   | You're set    | One-click "Activate now" via the local sidecar — writes the config, then re-runs the aggregator so the dashboard has fresh data when you land.                                                                                                                                                     |

The wizard's final action is **one click** — "Activate now" hands the collected state to the local sidecar, which writes `~/.claude-os/config.json` and the project-root `.env.local`, then triggers the aggregator so the dashboard is hydrated by the time you land on it. The three-command copy-paste fallback only appears if the sidecar can't be reached.

---

## Connecting to everything

The aggregator and dashboard auto-detect what they can. Anything that needs an API key goes in `claude-os/.env.local`:

```bash
# claude-os/.env.local
PINECONE_API_KEY=...
OPENROUTER_API_KEY=...
ANTHROPIC_API_KEY=...        # optional, only if you use raw API mode
```

| Service                                               | What it unlocks                              | How to get the key                                                                                                  | Where it goes                                        |
| ----------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Anthropic (Claude)**                                | Subscription tier detection, plan estimation | OAuth via Claude Code CLI (default), or set `ANTHROPIC_API_KEY` for raw API mode                                    | Auto if OAuth; else `.env.local`                     |
| **OpenAI Codex / ChatGPT**                            | ChatGPT panel + Codex tab                    | Sign in via the Codex CLI — writes `~/.codex/auth.json`                                                             | Auto                                                 |
| **OpenRouter**                                        | Live PAYG balance + burn rate                | https://openrouter.ai/keys                                                                                          | `OPENROUTER_API_KEY` in `.env.local`                 |
| **Pinecone**                                          | Vector indexes in the memory graph           | https://app.pinecone.io                                                                                             | `PINECONE_API_KEY` in `.env.local`                   |
| **Obsidian**                                          | Local notes in the memory graph              | Nothing — auto-detected from common vault locations, one-level desktop/document scans, or `CLAUDE_OS_OBSIDIAN_PATH` | n/a                                                  |
| **OpenClaw**                                          | Sidebar agent tab                            | Install OpenClaw locally                                                                                            | Auto via `~/.openclaw/openclaw.json`                 |
| **AntiGravity / Claude.app / Cursor / Terminal apps** | Setup-wizard tool detection                  | Install the apps                                                                                                    | Auto via `/Applications/<App>.app`                   |
| **KIE.ai**                                            | (Developer scripts only — image generation)  | https://kie.ai                                                                                                      | `KIE_API_KEY` in `.env.local`; not needed at runtime |

The setup wizard surfaces missing keys and helps you generate the `.env.local` file at the end. Keys are only ever read locally — the aggregator never relays them anywhere except the API the key belongs to.

---

## Permissions (macOS Full Disk Access)

The first time the aggregator reads `~/.claude/projects/`, macOS may deny access. If `bun run scripts/aggregate.ts` reports `permission denied`, grant **Full Disk Access**:

1. Open **System Settings → Privacy & Security → Full Disk Access**.
2. Toggle **on** for the host you run commands from — Terminal, iTerm2, Ghostty, or your editor's integrated shell.
3. Re-run the aggregator. It logs project counts and memory file counts as it walks each directory.

`security dump-keychain` (used to estimate Claude plan tier) will additionally prompt for your **login password** the first time it runs. That's a macOS prompt — Claude OS never sees the password.

---

## Linux / Windows

Linux and Windows partially work:

**Works:**

- JSONL parsing (`~/.claude/projects/`)
- OpenRouter + Pinecone polling
- Obsidian vault detection
- Codex auth detection (if you have `~/.codex/auth.json`)

**Doesn't work:**

- macOS Keychain credential count → skipped automatically
- Plan-tier estimation falls back to "unknown"

The aggregator prints a clear platform warning at startup. Open an issue if you want a target supported properly.

---

## Privacy + anonymization

- **Source data stays read-only.** Claude OS never writes to source tool data directories like `~/.claude/`, `~/.codex/`, `~/.openclaw/`, or your Obsidian vaults. The sidecar writes Claude OS config to `~/.claude-os/config.json`, writes repo-local `.env.local`, and the aggregator writes `src/data/live-data.json`.
- **No analytics, no tracking, no usage telemetry.** Claude OS never phones home about *you*. Outbound calls are limited to things you control: (1) the **Dream review** sends your aggregated activity to whichever engine you pick so it can write the prescriptions — **Codex → OpenAI · OpenRouter → OpenRouter · Claude → Anthropic · Hermes → its configured provider** (the engine picker discloses this on every option; a local **Ollama** engine is the only fully on-device path); (2) optional data sources you key yourself (OpenRouter, Pinecone). The UI also loads fonts + brand icons from public CDNs (Google Fonts, Simple Icons, DuckDuckGo favicons) — cosmetic, no personal data.
- **What the Dream actually sends:** your aggregated metrics *and* free-form context (memory-file content, recent-prompt previews) — because the model needs that to produce specific, evidence-backed insights instead of generic advice. `CLAUDE_OS_ANONYMIZE` scrubs your own username/email/name, but other names in your notes pass through. If that matters to you, pick the local Ollama engine (or don't use a cloud Dream engine).
- **`live-data.json` is gitignored.** Only the sanitized `live-data.example.json` is committed.
- **Anonymization is on by default.** `CLAUDE_OS_ANONYMIZE=1` rewrites your real macOS username to `operator`, redacts emails to `<email-redacted>`, and accepts an extra `CLAUDE_OS_REDACT_NAMES="First Last,handle"` env var to scrub additional terms before screen-sharing or recording.
- **Disable for fully local use:** `CLAUDE_OS_ANONYMIZE=0 bun run scripts/aggregate.ts`.

---

## The Dream feature

Dream is what makes Claude OS more than a metrics dashboard.

A daily 7am cron runs `bun run scripts/run-dream.ts` on your **chosen Dream engine** (Hermes, Claude, Codex, or OpenRouter), auditing your last 24 hours of activity across **eight orthogonal signal buckets**:

1. **Conversation mining** — recurring topics not yet skilled
2. **Cost intelligence** — model misuse, low cache hit rate, token waste
3. **Skill performance** — dead, dormant, or compose-worthy skills
4. **Memory health** — stale, conflicting, missing, drifted
5. **Session hygiene** — context rot, edit-without-read, length issues
6. **Workflow patterns** — manual sequences ripe for automation
7. **External opportunity** — new tools, skills, models worth adopting (only outbound network bucket; opt-in)
8. **Business outcomes** — actual ROI per skill / workspace / day

It then ranks every candidate by `severity × dollar_impact` and writes the **Top 4** to `~/.claude-os/dreams/dream-{date}.json`. The dashboard reads that JSON and renders four cards. Each card has a `[Run this fix →]` button that POSTs the prescription ID to the local sidecar, which resolves the stored command from the latest Dream JSON before running it.

**Cost:** ~$1.50–$3.00 per run, amortized into your existing Claude subscription via OAuth. No new keys.

**Setting it up (two commands):**

```bash
# 1. Install the /dream skill into your Claude Code skills directory
mkdir -p ~/.claude/skills && cp -r skills/dream ~/.claude/skills/dream

# 2. Install the launchd cron so /dream runs daily at 7am (macOS)
bun run install-dream         # --time HH:MM to change, --uninstall to remove
```

The cron installer writes `~/Library/LaunchAgents/com.claude-os.dream.plist` (macOS) or registers a Task Scheduler job (Windows), and pipes output to `~/.claude-os/dream-cron.log`. The skill lives at `skills/dream/SKILL.md`; the cron calls `scripts/run-dream.ts`, which reads your chosen engine from `~/.claude-os/config.json` and dispatches to it. On Linux the installer prints a `crontab` snippet you can install by hand.

The dashboard's `[Run again ↻]` button hits `POST /api/dream-now` on the local sidecar (auto-started by `bun run dev`) to trigger a run on demand without waiting for 7am.

In short: Dream walks 8 signal buckets (CONVERSATION, COST, SKILLS, MEMORY, SESSION, WORKFLOW, EXTERNAL, BUSINESS), ranks every candidate by `severity × dollar_impact`, and emits the top 4 highest-impact prescriptions as JSON to `~/.claude-os/dreams/dream-{date}.json`. Each prescription comes with a `claude -p "<command>"` that the dashboard can run via its prescription ID or that you can run manually in your terminal.

---

## Folder layout

```
claude-os/
├── scripts/
│   └── aggregate.ts                # Bun script — reads ~/.claude, Pinecone, OpenRouter
├── src/
│   ├── data/
│   │   ├── live-data.json          # gitignored — generated from your machine
│   │   └── live-data.example.json  # sanitized template (committed, demo mode)
│   ├── routes/
│   │   ├── index.tsx               # Home dashboard
│   │   ├── setup.tsx               # Setup wizard (Welcome pre-roll + 7 numbered steps)
│   │   ├── memory.tsx              # 3D memory graph
│   │   ├── share.tsx               # 1200×630 OG card
│   │   ├── skills.tsx              # Skills fleet detail
│   │   ├── activity.tsx            # Recent project activity
│   │   ├── settings.tsx            # Local config viewer
│   │   ├── workspaces.*.tsx        # Per-workspace drilldowns
│   │   └── agents.hermes.tsx       # Full Hermes Agent page (pantheon, chat,
│   │                                 GitHub sync, demo mode, skill library)
│   ├── components/                 # KPI tiles, usage panel, dream cards, sidebar
│   └── assets/
│       ├── hermes-art/             # Pantheon imagery (10 personas + banner +
│       │                             GH connect/push + skill hero + overlay +
│       │                             style reference)
│       ├── logos/                  # Brand marks (n8n, granola, higgsfield,
│       │                             stitch, codex, claude, gemini, etc.)
│       └── ...                     # Other logos + painterly anime skill banners
├── vite.config.ts                  # Vite + loopback-gated middleware:
│                                     /__hermes_status · /__hermes_pantheon
│                                     (+/install /create /validate /<id>
│                                     PUT/DELETE) · /__hermes_pantheon_sync
│                                     · /__hermes_pantheon_templates ·
│                                     /__hermes_models · /__hermes_connections
│                                     · /__hermes_sessions · /__hermes_skills
│                                     · /__hermes_chat (SSE) ·
│                                     /__hermes_image_upload · /__hermes_memory
└── package.json
```

The aggregator is the one and only integration point with disk for the main
dashboard. The Hermes page additionally reads from `~/.hermes/` via
loopback-only vite middleware (token-gated for writes).

### `~/.hermes/` (read by the Hermes page)

```
~/.hermes/
├── config.yaml                     # default model, provider, gateway
├── .env                            # provider keys + gateway tokens
├── auth.json                       # OAuth provider state
├── sessions/                       # *.json per chat session
├── skills/                         # bundled skill packs (auto-loaded)
├── memories/                       # USER.md, MEMORY.md (curated)
├── SOUL.md                         # personality / self-image
└── pantheon/                       # ← THE PERSONA SYSTEM
    └── personas/
        ├── labyrinth.yaml          # default seed
        ├── mercury.yaml            # default seed
        └── philosopher.yaml        # default seed
        (more added via the wizard)
```

Each persona YAML carries: `id`, `name`, `job`, `description`, `avatar`,
`model.{provider,name}`, `behavior.{tone,system_prompt}`, `skills`, `tools`,
`summon_phrases`. The dashboard reads + writes these files; Hermes itself
reads them at runtime when a summon phrase fires.

---

## Roadmap

Clearly labeled aspirations. All contributions welcome.

- ⏳ **`bun create claude-os`** — distribution package on npm so you can `bun create claude-os my-os`
- ✅ **Backend sidecar** — auto-started alongside Vite by `bun run dev`. Writes `~/.claude-os/config.json` from the wizard, runs the aggregator on demand, and powers Dream's one-click prescriptions. See [Backend sidecar](#backend-sidecar-auto-started-by-bun-run-dev) below
- ✅ **Dream cron auto-install** — `bun run install-dream` writes the launchd plist and loads it; `skills/dream/SKILL.md` is the bundled skill
- ⏳ **File-watcher** — live memory graph updates when you edit a note in Obsidian
- ⏳ **Pinecone search bar** — query your vector indexes from inside the memory graph
- ⏳ **Heartbeat + sparklines + ambient sound polish** — small details that make the dashboard feel alive

---

## Contributing

Issues and pull requests are welcome. The codebase is small enough to read in a sitting:

- Aggregator changes → `scripts/aggregate.ts`
- New panels → `src/components/` + wire into `src/routes/index.tsx`
- New routes → `src/routes/`
- Data contract changes → update `src/data/live-data.example.json` so the demo mode still boots

Don't push secrets. Don't commit `live-data.json`. The aggregator's anonymization layer is on by default for a reason.

---

## Backend sidecar (auto-started by `bun run dev`)

A small Bun sidecar that turns the dashboard from copy-paste theater into a real product. It powers the **"Activate now"** button at the end of the setup wizard, the **"Scanning your machine…"** step inside the wizard, and the **"Run this fix"** button on each Dream prescription.

`bun run dev` starts it for you — Vite and the sidecar run in the same terminal under one process supervisor. If you want to run it standalone (for debugging, or to keep Vite in another window), `bun run server` still works.

It binds to `127.0.0.1:17873` (localhost only — never `0.0.0.0`) and exposes:

- `POST /api/install` — writes `~/.claude-os/config.json` and `.env.local` from the wizard's collected state.
- `POST /api/aggregate` — runs `bun run scripts/aggregate.ts` and streams stdout back as Server-Sent Events. On exit, emits `event: meta` with `{ wrote: "src/data/live-data.json" }` then `event: done` with the exit code.
- `POST /api/run-fix` — accepts `{ "prescriptionId": "..." }`, resolves it from the latest `~/.claude-os/dreams/dream-{date}.json`, then streams the stored `claude -p` command back as Server-Sent Events.
- `POST /api/dream-now` — same, but runs the `/dream` skill (optionally `--quick`).
- `GET /api/health` — `{ ok: true, version: "1" }`.

If the sidecar isn't reachable, the wizard surfaces a clear "restart `bun run dev`" hint and the Dream cards fall back to copy-paste flows so the UI keeps working.

---

## License

Personal & Commercial Use License with Attribution. See [`LICENSE`](LICENSE). You may use and modify Claude OS for personal use AND commercial work (client projects, freelance, day job, internal tooling). You must credit "Claude OS by Jack Roberts" on any public deliverable it materially contributed to. You may not redistribute, repackage, sell, or re-upload it.
