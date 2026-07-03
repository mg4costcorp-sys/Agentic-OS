# Claude OS — Changelog

Tracks shipped versions of the Hermes-tier Claude OS dashboard. Older
versions are kept as zipped artefacts locally for rollback.

---

## V2.10.1 — 30 Jun 2026

A polish + hardening pass on the V2.10 Hermes chat.

### Fixed — the model picker respects your real setup

- The composer model picker now only offers **providers you actually have
  credentials for** (detected from `auth.json`, `~/.hermes/.env`, and your
  config) — so a pick can't fail with "Unknown provider 'x'".
- **OAuth / subscription providers now appear** with friendly labels — e.g.
  "OpenAI · ChatGPT sub", "xAI · X sub" — so you can run GPT-5.5 / Grok on an
  existing plan at zero marginal cost instead of paying through OpenRouter.

### Improved — context-window meter

- Accurate per-model window (GLM 5.1 = 203K, 5.2 = 1M, GPT-5.5 = 1.05M…). The
  retro grid is now a **100-cell (4×25)** field that lights even at ~1%, with
  filled cells **coloured by what's using the window** (amber = Hermes base,
  yellow = your conversation). Added a plain "~X of Y tokens used" line and a
  "Free space" label, and removed the confusing per-cell markers.

### Changed — model catalog

- Added **Claude Sonnet 5** (launched on OpenRouter 2026-06-30 · 1M context ·
  $2/$10) to the picker.

### Hardened — review pass (Codex + safety agents)

- The **commands** strip's output sanitiser now redacts messaging/account IDs
  and a wider set of token shapes (Bearer, JWT, `ghp_`, `AIza`, `xox*`…) on top
  of the existing home-path + API-key masking — nothing sensitive lands on
  screen or in a screen-recording.
- `Update Hermes` confirms before running, and a timed-out update no longer
  reports success; per-conversation model/provider overrides are validated
  against argument injection; the "compact → fresh session" carry-over can no
  longer leak into the wrong chat; haiku context size corrected; the
  benign-warning filter was narrowed so it can't swallow a real reply line.

---

## V2.10 — 30 Jun 2026

The **Hermes chat** release — the chat window now has a real model switcher, a
live context-window meter, and one-click Hermes commands, all driven by your
actual local Hermes.

### New — Chat composer

- **Model selector** — switch the model for a conversation from a searchable,
  provider-grouped popover, and pick a saved **Mixture-of-Agents preset** as a
  first-class "blend". Drives `hermes chat -m … --provider …` under the hood.
- **Context-window meter** — a retro segmented gauge (in Hermes yellow) showing
  how full the window is as a **%**, accurate per model (GLM 5.2 = 1M, GLM 5.1 =
  203K, …). Click it for a `/context`-style breakdown — conversation · Hermes
  base · free — with a notch at the 80% auto-compaction line. Counts are
  client-side estimates (`~`).
- **Commands menu** — runs REAL deterministic `hermes` sub-commands (no model
  call, so nothing is hallucinated): **Insights** (token usage, cost & model
  mix), **Status**, **Doctor**, **Version**, and **Update Hermes** (with a
  confirm). Output is **redacted by default** before it's shown — home paths →
  `~`, API-key/token fragments and messaging IDs masked, ANSI stripped — so it's
  safe to screen-share. The endpoint runs a fixed allow-list only, loopback +
  per-run-token gated.
- **Compact** — "summarize & start fresh": distils the conversation into a brief
  and carries it onto a new, near-empty session (the honest version of
  compaction, since slash commands can't run through the one-shot chat path).
- **Copy** button on each Hermes reply.

### Changed

- The chat header's **Intelligence** button is now **Voice**.
- A live **"Hermes is thinking · Ns"** state fills the pre-token wait.
- **Model catalog refreshed** against the live OpenRouter catalog — GLM 5.1 →
  5.2, DeepSeek V4 → V4 Pro, fixed provider ids, added Fable 5 and the current
  best model per vendor.

### Fixed

- Stripped Hermes' benign "Unknown toolsets: messaging" notice from replies and
  removed the stale toolset entry from config.

### Notes

- Reviewed across three independent passes — shareability/secret scan, Codex
  correctness, and a cross-cutting dead-code + build audit — before shipping.
  Nine findings were fixed, including hardening the command sanitizer to
  redact-by-default (masking a messaging ID and any non-`sk-` token shapes) and
  reporting command timeouts as failures rather than partial success.
- Streaming (token-by-token, like Hermes' Telegram mode) is in progress for the
  next drop.

---

## V2.9 — 28 Jun 2026

The **Ministry of Experts** release — build a Hermes Mixture-of-Agents line-up
visually and write it straight to your config, no copy-paste. Plus the
community voice-agent fixes and an OpenAI-key persistence fix for the voice chat.

### New — Ministry of Experts (Mixture of Agents builder)

- **A visual MoA builder**, the first persona in the Hermes Pantheon. Pick a
  core (orchestrator / aggregator) model and up to three expert (reference)
  models by drag-and-drop; the council renders each pick as a big branded node
  with the orchestrator wired to its three experts.
- **Live analytics per line-up** — Arena agent-leaderboard rank, indicative
  cost (green→red), and speed, all read from the bundled model knowledge base.
  No keys, no configuration.
- **One-click "Save to this computer"** — writes the preset straight into
  `~/.hermes/config.yaml` on **macOS and Windows** (`homedir`-based), **backs
  the file up first** (timestamped) and **merges** so your other presets and
  config keys are never touched. It also sets the preset as your default, and
  the write is loopback-only + per-run-token gated. A copy-the-prompt fallback
  is still there for anyone who'd rather hand it to Hermes by hand.
- **Max-tokens slider** with a live quality-tradeoff explainer (smaller is
  usually sharper for MoA; default 4096, recommended ceiling 16,384). Tells you
  it can be changed any time.
- Built against the Hermes v0.17.0 MoA schema — `provider` and `model` as
  separate keys, provider-mixing supported (e.g. a subscription-backed core
  with OpenRouter experts).

### Fixed — Voice agent + key persistence (community reports)

- **Voice-agent fixes** reported by the community (Gary Elliott, Seth
  Goldberg) plus the "ALL toolset counts" selector bug; the model selectors
  were refreshed.
- **OpenAI key now persists** across conversations in the Hermes voice chat —
  the saved key is silently reused to re-spawn the voice engine when it is
  down, instead of re-prompting you every session.

### Changed — Model intelligence

- **GLM 5.1 → 5.2**, and the Ministry rankings use the **Arena agent
  leaderboard** (the right board for agentic use). DeepSeek V4 Pro gains an
  Arena rating so every default seat ranks consistently rather than showing one
  unranked.

### Notes

- The Ministry feature and this release were cross-checked across three
  independent review passes — a shareability / secret scan, a code-correctness
  pass, and a cross-cutting dead-code + build audit — before shipping. ~1,200
  lines of superseded builder code from earlier design iterations were removed;
  type-check and production build are clean.

---

## V2.8 — 20 Jun 2026

The **Cross-platform** release — one zip, runs on macOS and Windows. Plus a
fix for the silent Dream-cron auth failure that had been affecting OAuth users.

### New — Windows support (contributed by Jason Welshonse)

- **Runtime OS detection** (`scripts/platform.ts`) replaces hard-coded macOS
  paths. Same files run on Mac, Windows, and partially Linux. macOS behaviour
  preserved 1:1.
- **Windows app + IDE detection** — Start-Menu `.lnk` shortcut index,
  `%LOCALAPPDATA%\Programs`, Program Files. Lights up Claude / Cursor /
  VS Code / Zed / Windsurf / Notion / Logseq + most terminals out of the box.
- **Windows Dream cron** — Task Scheduler port of the daily Dream review.
  `bun run install-dream` registers a non-elevated `ClaudeOS Dream` task that
  fires the same `aggregate → /dream` chain via a `.cmd` wrapper.
- **Cross-platform username redaction** — `aggregate.ts` anonymiser now uses
  `Get-CimInstance` on Windows (was macOS-`dscl`-only and leaked the real
  username). Backslash path form redacted too.
- **Real bug fix that affected Windows users**: aggregate.ts was splitting
  backslash-separated paths by `/`, inflating the reported project count
  (3 real folders → 13 reported). Fixed by normalising paths through `toPosix()`.
- **`scripts/seed-data.ts`** replaces the Unix `test -f || cp` one-liner that
  silently failed on `cmd.exe` (no `test` builtin).
- README gains a Windows (PowerShell) install section.

### Fixed — Silent Dream cron auth failure

- `claude -p` (headless print mode) does NOT use OAuth. Users who only ever
  ran `claude /login` were getting a Dream cron that fired daily, 401'd every
  time, and silently wrote nothing — while the dashboard showed sample
  prescriptions forever. **`bun run install-dream` now prints a clear,
  unmissable notice** explaining the one-time fix (`claude setup-token`) or
  the env-var alternative. Same notice surfaces during the setup wizard.
  Same warning applies on Windows (same headless-auth model).

### Notes

- The cross-platform refactor was reviewed across five angles (macOS
  regression, merge safety, code quality, security, release) before merging.
  Every Mac-specific path is properly gated behind `IS_WIN` / `IS_MACOS`
  branches. macOS smoke test passes (project count unchanged at 3, username
  leak count 0, build clean).
- Rollback tag: `pre-windows-port` on commit 6924958.

---

## V2.7 — 13 Jun 2026

The **Model Intelligence** release — a live LLM leaderboard + agent-readable
knowledge base on the homepage, plus a calmer Dream card.

### New — Model Intelligence

- **Homepage Section 7 now flips between "Sessions" and "Models"** — the
  Models view is a live leaderboard (`src/components/model-intelligence.tsx`):
  rank by intelligence / price / speed / context / usage, filter by vendor or
  tier, keep a personal "roster" of the models you actually run, and inspect
  any model in a drawer (benchmarks, sentiment, strengths/weaknesses, best-for).
  Section 7 defaults to the Models view so the leaderboard is visible on first
  load; returning users keep their last choice.
- **Agent-readable knowledge base** — `src/data/model-intel.json` ships a
  curated snapshot of ~27 models; `src/lib/model-intel.ts` overlays live
  price/context from the public OpenRouter catalog at runtime. Works fully
  **keyless and offline** (baked snapshot paints first; the live pull is lazy,
  debounced, and fail-soft — a failed fetch never blocks render). Docs:
  `docs/model-intelligence.md`.
- **Type-to-find search** — a "Find a model…" box filters the leaderboard by
  name, vendor, or id.
- **Daily freshness, keyless** — the live price/context pull is now cached to
  `localStorage` and runs on a **24h cadence**: a reload hydrates instantly from
  the last pull (offline-safe), and the network is only hit once a day (manual
  Refresh always forces one). Maintainers keep the curated snapshot current with
  **`bun run refresh:models`** (re-syncs price/context from OpenRouter and prints
  a curation to-do for new/retired models). Full freshness design:
  `docs/model-intelligence-freshness.md`.

### Changed — Calmer Dream card

- The homepage Dream card is now a fixed height so the hero image no longer
  overstretches on long prescriptions; the body scrolls internally with the
  footer pinned. Text is wider for an easier read, and **"Why we're suggesting
  this" is a collapsible toggle** (collapsed by default) so each card opens
  compact.

### Fixed

- Model Intelligence: the `specialist` tier (e.g. GPT-5.3 Codex) is now handled
  everywhere — sort rank, label, and tier filter — instead of mis-sorting and
  showing as "Open".
- Knowledge graph: the camera zoom-out clamp now actually runs on graph change
  (was silently throwing on an out-of-scope reference).

### Security

- Anonymized the seed knowledge-graph data: removed the absolute
  `graphPath`s from `src/data/graphs/index.json` (the loader falls back to the
  in-folder path, so graphs resolve on any machine) and scrubbed the operator
  username from the seed graphs' `source_file` paths.

---

## V2.6 — 13 Jun 2026

The **Know-your-build** release — the dashboard now tells you which version
it's running and what changed, and every "this is a repository" reference is
gone. Claude OS ships as files you own, not a repo you clone.

### New — Version in the UI

- **Version pill** in the top bar, next to `local` — reads the current
  `CHANGELOG.md` heading (e.g. `V2.6`) and appends the git short hash only
  when a `.git` is present. Because it reads the file (not git), the running
  build self-reports its true version even when the download's folder/zip name
  lags the contents.
- **"What's new" panel** — click the pill to read the changelog in-app. So if
  you've layered your own edits on top, you can see exactly what each update
  changed before you merge it in.
- **`GET /__app_version`** — loopback-only endpoint that serves `{ version,
  date, hash, markdown }` parsed from `CHANGELOG.md`.

### Changed — It's files, not a repo

- Removed references to a source **repository** across the dashboard and docs —
  "shipped with this repo" → "with the app", "in this repo" → "in this folder",
  "Repo layout" → "Folder layout", and the install steps now assume the files
  are already on your machine (no `git clone`). The download is just the files.
- Dropped the GitHub-hosted social-card image from the page `<head>`.
- The Hermes → private-GitHub backup is unchanged — that's *your* mirror of
  *your* Hermes, a deliberate feature, not a pointer to the Claude OS source.

### Notes

- The per-persona **model selector** (live model catalog + provider logos,
  saved into each persona's YAML) shipped in V2.5 and is fully in this build.

---

## V2.5 — 8 Jun 2026

The **Shared Brain** release — graphify becomes one memory shared across the
dashboard, Claude Code, and Hermes, plus a reliability fix for the grounded
graph chat.

### New — One shared brain

- **Single registry as source of truth** — `src/data/graphs/index.json`. Each
  entry carries an absolute `graphPath`; the dashboard, Claude Code, and Hermes
  all read the same file, so one ingest is visible to every agent.
- **`scripts/setup-graphify-brain.sh`** — one idempotent command to replicate
  the whole setup: installs graphify (`graphifyy`), registers the skill with
  both agents (`graphify install --platform claude|hermes`), links + backfills
  the registry to the local machine, and restarts the Hermes gateway.
- **`scripts/graph-to-dashboard.sh`** — agent→dashboard bridge: graph a local
  path or GitHub URL and register it through the dashboard's own ingest
  endpoint in one step, so agent-initiated graphs land in the gallery.
- **GitHub-URL ingest** — paste a repo URL in "Ingest a project"; it clones
  (shallow, temp), graphs, registers, and cleans up.
- **`/__graphify_list` auto-prune** — drops entries whose graph or local source
  has gone, so the gallery never shows dead projects.
- **Connect-with-Hermes card** (`/codegraph`) — a paste-once prompt (registry
  path filled per-machine) that wires a community member's own Hermes to the
  shared brain. Verified end-to-end: Hermes reads `index.json`, opens a project's
  graph, and answers from its real god-node data.
- **Per-session savings estimate** (replaces the misleading live counter) and a
  **"most important files"** panel (top-3 + show-more) on the graph page.
- Docs: `GRAPHIFY.md`, `GRAPHIFY_HANDOVER.md`.

### Fixed

- **Grounded graph chat now genuinely queries graphify** (and no longer times
  out). In non-interactive `hermes chat -Q -q` mode a tool call has no approval
  channel, so project questions used to deadlock and exit 130 (*"denying
  command"*). The `/codegraph` chat now runs with the **graphify skill +
  `--yolo`** (auto-approves the read) and a seed that hands Hermes the project's
  `graphPath` and tells it to answer by running `graphify query / explain /
  path` against the real graph — so it cites actual files/clusters instead of
  paraphrasing a summary. Opt-in via a `yolo` prop on the shared `HermesChat`;
  the Hermes Agent page chat is unchanged. Endpoint stays loopback + token
  gated.

### Notes

- The shared repo ships with the **`claude-os` graph only** (the OS graphing
  itself) as a seed — run `setup-graphify-brain.sh`, then ingest your own repos.

---

## V2.4 — 7 Jun 2026

The **Knowledge Graph** release — a per-project, graphify-powered code map
woven into the OS, plus a reused Hermes chat and a Hermes setup-detection fix.

### New — Knowledge Graph

- **`/codegraph` route** — a multi-project knowledge-graph explorer:
  - **Scrollable project gallery** (accent, language, file/cluster counts) +
    an **"Ingest a project"** card.
  - **3D Constellation view** (`src/components/graphify-graph-3d.tsx`, built on
    `react-force-graph-3d`): community-clustered "sections" via a custom cluster
    force, always-on bloom + starfield + fog, emissive **god-node halos with
    pulse**, adaptive camera that fills the frame, **Pause** toggle, hover-dims
    neighbours, large-graph cap (densest N), and **click-a-god-node → fly to it**.
  - **Side rail** — Files / Links / **Clusters** stats, a **Map-confidence bar**
    (EXTRACTED "found in code" vs INFERRED "model's guess"), a clickable
    **God Nodes** list with degree bars, and a selected-node inspector.
- **Homepage preview** — a compact graph under "Your memory" (`src/routes/index.tsx`).
- **4 projects ingested** — claude-os, publish-hub, personal-os, hermes-agent
  (`src/data/graphs/*.json` + `index.json`). Per-project, source-only AST ≈ $0.
- **Sidebar nav** — "Knowledge Graph" entry.
- **`docs/knowledge-graph-unlocks.md`** — researched, tiered roadmap of unlocks.

### New — Dashboard-driven ingest (vite middleware)

- **`POST /__graphify_ingest`** — run graphify on a local repo path, write its
  graph + update `index.json`, in place (no reload). Loopback + token gated,
  `execFileSync` (no shell injection), **path-aware collision-safe ids**, refuses
  >12k-node results (vendored-deps guard), cleans up `graphify-out/`.
- **`GET /__graphify_list`** + **`GET /__graphify_graph?id=`** — loopback-gated,
  id-sanitised, streamed (multi-MB safe).

### New — Chat

- The graph page now reuses the **real `HermesChat`** component from the Hermes
  section (exported from `agents.hermes.tsx`), gated on `/__hermes_status`.

### Fixed

- **Hermes "needs setup" false-positive** — `OAUTH_PROVIDERS` now includes
  `copilot` / `github-copilot` / `anthropic-oauth`, so OAuth/subscription
  providers (no env API key) stop tripping the "run hermes setup" state.
- Graph QA hardening (multiple review passes): loading-lockup guard on graph
  fetch, deferred + frozen god-node fly-to, memoised node meshes (no per-hover
  regeneration), live-list active-project reconcile, streamed graph reads.

---

## V2.3 — 31 May 2026

One headline feature this release: the **Documents Gallery**. Plus two
small dashboard fixes and a pricing-accuracy improvement. Everything
else from V2 is unchanged.

### New

- **Documents Gallery** — lives on the Hermes page, between the Skills
  section and the CLI Commands cheatsheet. A real, file-system-backed
  view of everything your Hermes agent (or you) drops into
  `~/Documents/Hermes/`. Reads files live, polls every 5 seconds, and
  renders each as a card with a hand-engraved Hermes-style placeholder
  per file type (sealed-scroll PDFs, loom-web HTML, codex for Markdown,
  abacus for Data, Dionysus mask for Video, lyre for Audio, treasure
  chest for Archive, Heron-of-Alexandria astrolabe for Code, etc.).
  Features:
  - Live type filtering with extension tooltips (".txt vs .md" never
    a mystery)
  - Live search across title, description, filename, type
  - Recency grouping (Today / Yesterday / This Week / Earlier) when
    you have more than six files
  - In-dashboard preview modal — click any card to render inline
    (HTML in iframe, markdown / JSON / text as styled `<pre>`, image /
    video / audio with native players)
  - Open-in-new-tab arrow if you prefer the full-browser view
  - **Soft delete to `.trash/`** with an 8-second Undo toast — the
    toast pauses on hover; the file stays in `~/Documents/Hermes/.trash/`
    forever so you can always recover from Finder
  - Trash modal (header chip appears when `.trash/` has items) for
    restore / permanently-delete-per-file / Empty trash
  - **"Install Prompt" modal** — one paste-able prompt + a full
    type-classification table you give to your Hermes agent so it
    saves all generated artefacts to `~/Documents/Hermes/` with proper
    metadata (HTML meta tags, Markdown YAML frontmatter, JSON `_hermes`
    block, first-line conventions for text + code). Includes explicit
    Save-here vs Don't-save-here rules so Hermes doesn't dump build
    artefacts or GitHub-repo project files into your gallery.
  - 10 engraved file-type placeholder cards in the existing Hermes
    Pantheon art style.

### Fixed

- **DreamCarousel clipping on long prescriptions** — long prescription
  bodies pushed the bottom nav (next arrow + "apply & mark done") below
  the fixed-height card, making later prescriptions unreachable. Changed
  `md:h-[440px]` → `md:min-h-[440px]` in `src/routes/index.tsx` so cards
  grow when content needs the room. Bottom controls are always reachable
  now.
- **Hardcoded "7am daily" copy** — the dream-status copy claimed a fixed
  7am run time, but the cron schedule is configurable. Replaced with
  "runs on your configured cron schedule" so it's accurate regardless of
  when you scheduled it.
- **Pricing accuracy via OAuth** — aggregator now reads the official
  `/api/oauth/usage` endpoint when your Claude Code OAuth session has
  one cached, so per-token costs match Anthropic's billing exactly.
  Falls back to the previous estimator if OAuth isn't available.
- **Daily activity counts** — uses real per-day session counts from
  the aggregator instead of synthesised noise + base when no data is
  available. Honest zeros beat lies.
- **Hermes sessions endpoint** — listing was capped at 20 and excluded
  Telegram threads; raised to 200 and merged in the `sessions.json`
  index so the chat sidebar surfaces everything.
- **Anthropic OAuth path** — reads from macOS Keychain via
  `find-generic-password -s "Claude Code-credentials" -a $USER` and
  sets the right `User-Agent` + `anthropic-beta: oauth-2025-04-20`
  headers.

### Security

- **Symlink-escape guard** on every gallery endpoint
  (`/__hermes_documents/file`, DELETE, restore, trash DELETE). Without
  it, an operator-planted symlink in `~/Documents/Hermes/` could leak
  arbitrary files (e.g. `~/.ssh/id_rsa`) or get those files moved to
  `.trash/` on delete. Every entry point now `realpathSync`'s the
  joined path and refuses anything that escapes the documents folder.
  Listing also skips symlinks entirely via `lstatSync`.

### Performance + safety

- **Streaming `/file` endpoint** — switched from `readFileSync` + buffer
  to `createReadStream().pipe(res)` so multi-GB videos / PDFs don't
  pull the entire file into memory before the first byte ships.
- **Directory enumeration cap** (1000 entries) with a `truncated` flag
  in the response. Operator with a runaway folder gets a clean
  truncation instead of a hung dev server.
- **`parseDocMeta` cache** — keyed on (path, mtimeMs, size). The 5-second
  poll no longer re-reads + re-parses the first 4KB of every file
  every tick; cache hits when nothing's changed. Bounded at 5000
  entries with oldest-eviction.
- **Body scroll lock stacking counter** — three modals (preview,
  install-prompt, trash) used to each snapshot/restore
  `document.body.style.overflow` independently. Closing them
  out-of-order could leave the page permanently scroll-locked. Now
  managed by a module-level reference counter; first mount locks,
  last unmount restores.
- **Undo toast interval leak** — the countdown's `setInterval` used to
  be recreated ~10×/s because the parent's `onDismiss` was a fresh
  closure every render. Fixed by wrapping the handlers in `useCallback`
  on the parent and using ref-backed `paused` / `onDismiss` inside the
  toast so the interval mounts once for the lifetime.

### Removed

- 70MB of unused PNG source files from `src/assets/hermes-art/file-types/`
  — only the webp versions were imported by the gallery; PNGs were
  dead weight in the ship. Regenerate via
  `scripts/gen-hermes-file-type-art.ts` if you ever want them back.

---

## V2 — 24 May 2026

Initial Hermes-tier release. Personal & Commercial Use License with
Attribution. Mission Labyrinth art swap. Personas skill. Auto-discovery
of `*_API_KEY` / `*_TOKEN` from `~/.hermes/.env` as connection
candidates.
