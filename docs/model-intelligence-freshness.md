# Model Intelligence — keeping it fresh

**Consumption context:** someone downloads Claude OS as files and runs it. No
account, no API key, no setup. So "stays up to date" has to mean *automatic and
keyless*, with a graceful story for the parts that genuinely need a human.

The data splits into two kinds of fields, and they age very differently:

| Field | Ages how | Refresh path |
| --- | --- | --- |
| `price.inputPerM` / `price.outputPerM`, `context` | Constantly (vendors re-price) | **Automatic, keyless** — OpenRouter |
| `benchmarks`, `sentiment`, `status`, `tier`, `oneLiner`, roster, `picks`, `upAndComing` | Slowly, and need judgement | **Curated** — maintainer refresh |

---

## Tier 1 — Live price/context (automatic, keyless) ✅ shipped

`src/lib/model-intel.ts` overlays fresh price + context from the **public
OpenRouter catalog** (`https://openrouter.ai/api/v1/models` — no auth, CORS-open)
on top of the baked snapshot.

As of V2.7 this runs on a **daily cadence with an offline-safe cache**:

- On load it hydrates instantly from the last cached pull (`localStorage:
  claude-os-model-live`) — so even offline you see the last-known live prices,
  not the build-time numbers, with **no flash**.
- It only hits the network when the cache is missing or **>24h old**
  (`LIVE_TTL_MS`). That's the "refreshes daily" behaviour.
- Any failure is fail-soft: keep the cache (or the baked snapshot), flip the
  status dot to `error`, never block render. A manual **Refresh** always forces
  a pull.

The UI's freshness line (`live · Nh ago · snapshot YYYY-MM`) tells the user
exactly how fresh each half is, and per-model `liveFields` records which numbers
were overlaid this render vs. left curated — so it's honest about provenance.

## Tier 2 — Curated facts (maintainer refresh)

Benchmarks, sentiment, status, one-liners, the roster, and picks can't be
auto-derived — they're judgement. They're a dated snapshot
(`freshness.snapshot.curatedAsOf`). Keep them current with:

```bash
bun run refresh:models
```

`scripts/refresh-model-intel.ts` (keyless) re-syncs price/context into the
shipped snapshot **and prints a CURATION TODO**: notable models now on
OpenRouter that aren't in the roster, plus any curated models that have
disappeared (renamed/deprecated). You hand-curate the new entries' benchmarks/
sentiment and commit. Run it before cutting a release.

## Tier 3 — Optional: push curation to existing downloads (a decision)

Tiers 1–2 keep **prices** fresh for everyone automatically, but a downloader's
**curated** data is only as fresh as their download until they re-download.

If you want curation updates to reach *existing* installs automatically, add a
**remote-snapshot channel**: fetch `model-intel.json` from a CDN once a day,
validate it, and fall back to the baked copy if it's missing/old/offline. jsDelivr
serves any public repo file, keyless + CORS-open:

```
https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/src/data/model-intel.json
```

Sketch (≈15 lines in `useModelIntel`, gated on a `REMOTE_MODEL_INTEL_URL`
constant; cache with the same 24h TTL; only adopt the remote doc if it validates
**and** its `generatedAt >= the baked one**, so a download never regresses):

```ts
const remote = await fetch(REMOTE_MODEL_INTEL_URL).then((r) => r.json());
if (isValidDoc(remote) && remote.generatedAt >= BAKED.generatedAt) base = remote;
// else keep BAKED — offline / 404 / bad shape all fall through safely
```

**Trade-off (this is the call to make):** it's the only way to keep curated
facts fresh without a re-download, but it makes the app softly depend on that
hosted file. It's invisible and degrades cleanly, but it *is* a network call to
a repo URL — which cuts against "it's just the files." Left **off by default**;
flip it on by setting the constant when you've decided where to host.

---

## Other value / UX ideas (ranked)

1. **Search** ✅ shipped — type-to-find across name/vendor/id.
2. **Price-drift highlight** — when the live price differs from the snapshot,
   tint the cell + tooltip "was $X at snapshot" so movement is visible.
3. **"New on OpenRouter" nudge** — a small count in the freshness line when the
   live catalog has notable models the roster doesn't, linking to the refresh
   flow. (The script already computes this set.)
4. **Export roster as agent config** — one click to copy the in-roster models as
   a routing block an agent can paste into its config (extends the existing
   copy-JSON).
5. **Per-model "verified" date** in the inspect drawer, from `curatedAsOf`.
6. **Deep-link** — `?model=<id>` opens the inspect drawer, so a recommendation
   can link straight to a model.

## How agents read it

`model-intel.json` is the agent-readable knowledge base. The `howAgentsUse`
field spells out the routing protocol: filter to `roster.inPlay`, match the task
to `bestFor` / avoid `avoidFor`, use `tier` + `routing.rules`, break ties on
price/speed/benchmarks, and cite `curatedAsOf` for curated claims vs the live
`fetchedAt` for price/context.
