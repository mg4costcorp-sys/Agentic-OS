# Model Intelligence panel — handoff & how it works

A leaderboard + knowledge base of current LLMs, living in the homepage's bottom slot behind a
`Sessions ⇄ Models` toggle. It doubles as an **agent-readable routing playbook**: Hermes / Claude
Code can read `src/data/model-intel.json` to pick the right model for a task by price, speed,
context, benchmark or usage.

- **Repo / branch:** lives on `main` (originally built on `feat/model-intelligence`); the
  2026-07-10 orchestration upgrade is uncommitted at time of writing.
- **Status:** `tsc` clean, eslint clean on new files, production build green, verified live in-browser.

---

## Files

| File | Role |
|---|---|
| `src/data/model-intel.json` | **The knowledge base.** 31 models + the `orchestration` playbook, self-describing (`_readme`). Committed (NOT gitignored) so it ships with the repo and bundles into the build. |
| `src/lib/model-intel.ts` | Types, the live OpenRouter merge, roster hooks, and pure helpers (`recommendModel`, `mergeLive`, `applyRoster`, `sortModels`, `filterModels`, `blendedPrice`, formatters). |
| `src/components/model-intelligence.tsx` | All the UI: the toggle, champions, leaderboard table, detail drawer, logos. |
| `src/routes/index.tsx` | **Modified** — Section 7 ("Sessions per day") now hosts the `Sessions/Models` switch. |

---

## How it works (architecture)

**Hybrid freshness — works key-less, zero-setup, offline-safe:**

1. The curated snapshot (`model-intel.json`) is **bundled at build time** via a static import
   (`import bakedDocJson from "@/data/model-intel.json"`). So the panel paints fully-populated on
   first frame, in dev *and* in a production/static build, even offline.
2. On mount the panel lazily fetches `https://openrouter.ai/api/v1/models` — **public, no API key,
   `access-control-allow-origin: *`** — and overlays **live price + context** keyed by
   `openrouterId`. Debounced 1×/10s, AbortController on unmount, fail-soft back to the snapshot.
3. A **Refresh** button forces a re-pull. The freshness line shows `live · Xs ago · snapshot 2026-07`.

**What's live vs snapshot:** price + context = live from OpenRouter (the public catalog carries
nothing else we trust — speed, benchmarks, sentiment and `popularity` are all curated snapshot,
stamped `as of 2026-07`, each with a deep link to the live leaderboard). Nothing is faked as
real-time.

**Agent resource:** the panel is just the human mirror of `model-intel.json`. Agents read that file
directly. `recommendModel(doc, query)` and a Copy-JSON button surface the same data.

---

## `model-intel.json` shape (what agents consume)

Top level: `_readme`, `asOf`, `generatedAt`, `freshness{ live, snapshot }`, `routing{ default, rules }`,
`orchestration{}`, `leaderboards[]`, `picks[]`, `models[]`, `upAndComing[]`, `sources[]`.

### The `orchestration` block (multi-model playbook)

Additive and optional — `routing{}` stays the single-call fallback contract. Three layers:

- **`patterns[]`** — named execution topologies as stage DAGs (`single`,
  `planner-worker-verifier`, `cheap-draft-frontier-finish`, `fan-out-review`, `map-reduce`).
  Each stage has `role`, `dependsOn`, `fanOut`, `input`, `output`.
- **`taskShapeRules[]`** — priority-ordered rules mapping a task shape (`artifacts`,
  `complexity`, `risk`, `volume`, `parallelizable` + free-text `signals`) onto a recipe.
- **`recipes[]`** — concrete bindings: each role gets `candidates[]` (model ids in preference
  order), a `choose` policy (`first-eligible` | `cheapest-eligible` | `best-fit` |
  `diverse-eligible`), an `effort` hint, `maxCalls`, and soft vendor-diversity via
  `preferDifferentVendorFrom`. `controls{}` carries `budgetClass`, `maxParallel`, `maxRounds`,
  `onFailure`, `onDisagreement`.

**How agents consume it:** the FIRST matching `taskShapeRules` entry (by priority) owns the
decision → `resolveRecipe()` binds roles to in-roster, non-fading models (missing candidate →
next in list; unfillable role → recipe is incomplete). An incomplete matched recipe follows
`eligibility.incompleteRecipePolicy` — `"routing-default"` means drop straight to
`routing.default` (a lower-priority rule is a different task shape, never a fallback). Only when
NO rule matches does `orchestration.defaultRecipeId` apply. The pure helpers
`resolveRecipe(doc, recipeId, rosterIds)` and `recommendOrchestration(doc, shapeQuery,
rosterIds)` in `model-intel.ts` implement exactly these semantics, deterministically — stable
sorts, so equal-scoring candidates keep their `candidates[]` order. `rosterSubset()` scopes
orchestration too (recipes, rules, `defaultRecipeId`, `routing.default`, picks, curatedPicks):
Copy-JSON with a roster never ships a fallback that routes to a model outside the subset.

Each `models[]` entry:

```jsonc
{
  "id": "claude-opus-4-8",
  "name": "Claude Opus 4.8",
  "vendor": "Anthropic",
  "vendorKey": "claude",            // → logo lookup
  "openrouterId": "anthropic/claude-opus-4.8",  // → live merge key
  "tier": "frontier",                // frontier | fast | open
  "status": "new",                   // new | rising | stable | fading
  "oneLiner": "…",
  "price": { "inputPerM": 5, "outputPerM": 25, "currency": "USD" },
  "context": 1000000,
  "speedTps": 67,
  "liveFields": [], // baked snapshot ships empty; the runtime merge stamps e.g. ["price.inputPerM","price.outputPerM","context"]
  "benchmarks": { "lmarenaElo": 1479, "aaIndex": 61, "aiderPolyglot": null, "sweBench": 88.6 },
  "primaryBench": "aaIndex",
  "sentiment": { "label": "very positive", "score": 0.9, "summary": "…", "loved": [], "gripes": [] },
  "strengths": [], "weaknesses": [], "bestFor": [], "avoidFor": [],
  "proUsage": "…",
  "popularity": 4,                   // curated OpenRouter usage rank, 1 = most tokens
  "roster": { "inPlay": true },
  "links": { "openrouter": "…", "vendor": "…", "leaderboard": "…" }
}
```

---

### `claude-opus-5` and null-by-default fields

`claude-opus-5` is the current Anthropic flagship: it sits at the top of the chat's Claude
lane, it is the third hop of the chat's failover chain, and it carries `roster.inPlay: true`.
Its `price`, `speedTps`, `popularity` and every `benchmarks` field are `null` on purpose —
nothing in this repository's own data establishes them, and a guessed number here would
silently drive routing decisions, cost estimates and the Champions strip. The live OpenRouter
merge stamps `price` and `context` when the model appears in the catalog; sentiment and
benchmarks stay null until a curated refresh supplies verified figures. Champions cards skip
null fields, so an unrated model never wins a superlative it hasn't earned.

## The UI (Models view)

- **`Sessions ⇄ Models` toggle** in the Section-7 slot. View persists to `localStorage["claude-os-activity-tab"]`.
- **`Leaderboard ⇄ Playbooks` sub-switch** (persists to `localStorage["claude-os-model-intel-view"]`).
  Playbooks renders the orchestration block: task-shape chips (click → the matching recipe
  highlights) and recipe cards showing the stage topology, each role resolved live against the
  roster (vendor logo + model, click → INSPECT drawer), budget/parallelism/disagreement controls,
  and **Copy plan JSON**. Un-checking a model in the leaderboard re-resolves every role to the
  next eligible candidate. No model calls happen in the panel. The INSPECT drawer gains an
  **"Orchestrates as"** list — every recipe role the model is a candidate for.
- **Champions strip** — 5 cards computed *live* from the data: **Smartest** (max `aaIndex`),
  **Fastest** (max `speedTps`), **Cheapest** (min blended $/M), **Most used** (min `popularity`),
  **Best value** (max `aaIndex` ÷ blended $/M). Each card opens the drawer; "Rank table by this"
  re-sorts the leaderboard.
- **Leaderboard table (open by default)** — all 31 stacked. Columns: `#` (rank, medals for top-3),
  Model (logo + name + `openrouterId`), Tier, Price (`in/out` + `≈$ blend` subtitle), Speed,
  Context, Bench (AA · SWE), Sentiment bar, **Usage** (`#popularity`), Status, **Roster checkbox**.
- **RANK BY** chips: Default · Smartest · Arena · Cheapest · Fastest · Most used. Headers are also
  click-to-sort. Tier chips (All/Frontier/Fast/Open) + click-a-logo vendor filter + Hide off-roster.
- **Selection** — per-row checkboxes write to `localStorage["claude-os-model-roster"]` (string[] of
  ids). Empty roster = all in play; first pick scopes the subset. Selection bar + Reset.
- **Detail drawer** — click any row: benchmarks w/ provenance, loved/gripes, bestFor/avoidFor chips,
  proUsage, deep links, copy-this-model JSON.

---

## Conventions for making changes

- **Update benchmark / sentiment / popularity numbers** → edit `src/data/model-intel.json`
  (the snapshot layer). Prices/context refresh themselves live.
- **`blendedPrice`** = `(3·input + output) / 4` (industry-standard 3:1 input:output weighting).
- **`popularity`** = curated OpenRouter usage rank, `1` = most tokens.
- **Add a vendor logo** → `EXTRA_VENDORS` map in `model-intelligence.tsx`: `{ slug, color, mono }`.
  `slug` is a Simple Icons CDN slug (`cdn.simpleicons.org/<slug>/<hex>`) or `null` → branded monogram.
- **localStorage keys:** `claude-os-activity-tab`, `claude-os-model-roster`, `claude-os-model-intel-view`.
- **Add/adjust an orchestration recipe** → edit `orchestration.recipes[]` in the JSON; every
  `candidates[]` id must exist in `models[]`, every `recipeId`/`patternId` reference must resolve.
  The UI and `resolveRecipe()` pick up changes with no code edits.
- **Live endpoint:** `GET https://openrouter.ai/api/v1/models` (keyless), merged by `openrouterId`.

---

## Not done / possible follow-ups

- The 2026-07-10 orchestration upgrade is not committed yet (working tree on `main`).
- Not auto-wired into Hermes/Claude Code — it's a **pull** resource, by design.
- Could add: a `refresh:models` script to regenerate the snapshot; richer drawer
  (price-vs-intelligence chart, latency); a `/models` standalone route.
- Pre-existing lint debt in `index.tsx` (unrelated `any`/prettier) was left untouched.
