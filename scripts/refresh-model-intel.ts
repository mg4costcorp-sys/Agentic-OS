#!/usr/bin/env bun
/**
 * refresh-model-intel.ts — keep src/data/model-intel.json current.
 *
 * What it does (keyless — uses only the public OpenRouter catalog):
 *   1. Re-syncs every model's price (input/output per-M) and context window from
 *      OpenRouter, so the SHIPPED snapshot's baseline is accurate even before the
 *      runtime live-merge kicks in (and for the first paint / offline).
 *   2. Stamps freshness.live.fetchedAt + generatedAt with today.
 *   3. Prints a CURATION TODO: notable models live on OpenRouter that aren't in the
 *      roster yet, and any curated models that have vanished from OpenRouter
 *      (renamed / deprecated) — the bits that still need a human's judgement
 *      (benchmarks, sentiment, one-liners can't be auto-derived).
 *
 * It NEVER touches curated fields (benchmarks, sentiment, status, strengths…) —
 * those are yours. Run it before cutting a release:
 *
 *     bun run refresh:models
 *
 * Then review the CURATION TODO, hand-edit the curated fields for any new models
 * you want to add, and commit.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const JSON_PATH = resolve(import.meta.dir, "../src/data/model-intel.json");

type ORModel = {
  id: string;
  pricing?: { prompt?: string; completion?: string };
  context_length?: number;
};

function parsePrice(perToken?: string): number | null {
  if (perToken == null) return null;
  const n = Number(perToken);
  if (!Number.isFinite(n) || n <= 0) return null;
  const perM = n * 1_000_000;
  if (!Number.isFinite(perM) || perM <= 0) return null;
  return Math.round(perM * 1000) / 1000;
}

async function main() {
  console.log("→ fetching OpenRouter catalog (no key needed)…");
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const json = (await res.json()) as { data?: ORModel[] };
  const catalog = Array.isArray(json?.data) ? json.data : [];
  const byId = new Map<string, ORModel>();
  for (const m of catalog) if (m && typeof m.id === "string") byId.set(m.id, m);
  console.log(`  got ${byId.size} models.`);

  const doc = JSON.parse(readFileSync(JSON_PATH, "utf-8"));
  const models: any[] = Array.isArray(doc.models) ? doc.models : [];

  let priced = 0;
  const missing: string[] = [];
  for (const m of models) {
    const live = m.openrouterId ? byId.get(m.openrouterId) : undefined;
    if (!live) {
      if (m.openrouterId) missing.push(`${m.name} (${m.openrouterId})`);
      continue;
    }
    const inP = parsePrice(live.pricing?.prompt);
    const outP = parsePrice(live.pricing?.completion);
    const ctx =
      typeof live.context_length === "number" && live.context_length > 0
        ? live.context_length
        : null;
    if (inP != null) m.price.inputPerM = inP;
    if (outP != null) m.price.outputPerM = outP;
    if (ctx != null) m.context = ctx;
    if (inP != null || outP != null || ctx != null) priced++;
  }

  const now = new Date().toISOString();
  if (doc.freshness?.live) doc.freshness.live.fetchedAt = now;
  doc.generatedAt = now;

  writeFileSync(JSON_PATH, JSON.stringify(doc, null, 2) + "\n");
  console.log(`✓ refreshed price/context for ${priced}/${models.length} models → ${JSON_PATH}`);

  // CURATION TODO — the parts a human still owns.
  const known = new Set(models.map((m) => m.openrouterId).filter(Boolean));
  const newOnes = catalog
    .filter((m) => m.id && !known.has(m.id) && parsePrice(m.pricing?.prompt) != null)
    .map((m) => m.id);
  if (missing.length) {
    console.log("\n⚠ curated models no longer on OpenRouter (rename/deprecate?):");
    for (const x of missing) console.log(`   - ${x}`);
  }
  if (newOnes.length) {
    console.log(`\nℹ ${newOnes.length} models exist on OpenRouter that aren't in your roster.`);
    console.log("  (curate benchmarks/sentiment by hand for any worth adding — sample:)");
    for (const x of newOnes.slice(0, 12)) console.log(`   - ${x}`);
  }
  console.log("\nDone. Review the TODO above, hand-curate new entries, then commit.");
}

main().catch((e) => {
  console.error("✗ refresh failed:", e?.message ?? e);
  process.exit(1);
});
