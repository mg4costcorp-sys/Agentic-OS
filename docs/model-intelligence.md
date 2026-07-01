# Model Intelligence panel — handoff & how it works

A leaderboard + knowledge base of current LLMs, living in the homepage's bottom slot behind a
`Sessions ⇄ Models` toggle. It doubles as an **agent-readable routing playbook**: Hermes / Claude
Code can read `src/data/model-intel.json` to pick the right model for a task by price, speed,
context, benchmark or usage.

- **Repo / branch:** built on `feat/model-intelligence` (uncommitted at time of writing).
- **Status:** `tsc` clean, eslint clean on new files, production build green, verified live in-browser.

---

## Files

| File | Role |
|---|---|
| `src/data/model-intel.json` | **The knowledge base.** 27 models, self-describing (`_readme`). Committed (NOT gitignored) so it ships with the repo and bundles into the build. |
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
3. A **Refresh** button forces a re-pull. The freshness line shows `live · Xs ago · snapshot 2026-06`.

**What's live vs snapshot:** price / context / availability = live from OpenRouter. Benchmarks,
sentiment and `popularity` (usage rank) = curated snapshot, stamped `as of 2026-06`, each with a
deep link to the live leaderboard. Nothing is faked as real-time.

**Agent resource:** the panel is just the human mirror of `model-intel.json`. Agents read that file
directly. `recommendModel(doc, query)` and a Copy-JSON button surface the same data.

---

## `model-intel.json` shape (what agents consume)

Top level: `_readme`, `asOf`, `generatedAt`, `freshness{ live, snapshot }`, `routing{ default, rules }`,
`leaderboards[]`, `picks[]`, `models[]`, `upAndComing[]`, `sources[]`.

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
  "liveFields": ["price","context"], // which fields the last live pull overwrote
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

## The UI (Models view)

- **`Sessions ⇄ Models` toggle** in the Section-7 slot. View persists to `localStorage["claude-os-activity-tab"]`.
- **Champions strip** — 5 cards computed *live* from the data: **Smartest** (max `aaIndex`),
  **Fastest** (max `speedTps`), **Cheapest** (min blended $/M), **Most used** (min `popularity`),
  **Best value** (max `aaIndex` ÷ blended $/M). Each card opens the drawer; "Rank table by this"
  re-sorts the leaderboard.
- **Leaderboard table (open by default)** — all 27 stacked. Columns: `#` (rank, medals for top-3),
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
- **localStorage keys:** `claude-os-activity-tab`, `claude-os-model-roster`.
- **Live endpoint:** `GET https://openrouter.ai/api/v1/models` (keyless), merged by `openrouterId`.

---

## Not done / possible follow-ups

- Not committed (sits on `feat/model-intelligence`).
- Not auto-wired into Hermes/Claude Code — it's a **pull** resource, by design.
- Could add: a `refresh:models` script to regenerate the snapshot; richer drawer
  (price-vs-intelligence chart, latency); a `/models` standalone route.
- Pre-existing lint debt in `index.tsx` (unrelated `any`/prettier) was left untouched.
