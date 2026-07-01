# Claude OS — Changelog

Tracks shipped versions of the Hermes-tier Claude OS dashboard. Older
versions are kept as zipped artefacts locally for rollback.

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
