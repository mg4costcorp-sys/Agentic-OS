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

// Vendor id → display name + the vendorKey the UI uses for brand logos.
const VENDORS: Record<string, { name: string; key: string }> = {
  anthropic: { name: "Anthropic", key: "claude" },
  openai: { name: "OpenAI", key: "openai" },
  google: { name: "Google", key: "gemini" },
  "x-ai": { name: "xAI", key: "xai" },
  moonshotai: { name: "Moonshot AI", key: "moonshot" },
  minimax: { name: "MiniMax", key: "minimax" },
  "meta-llama": { name: "Meta", key: "meta" },
  mistralai: { name: "Mistral", key: "mistral" },
  deepseek: { name: "DeepSeek", key: "deepseek" },
  qwen: { name: "Qwen", key: "qwen" },
  "z-ai": { name: "Z.ai", key: "zai" },
  cohere: { name: "Cohere", key: "cohere" },
};

// Brand acronyms that must not be title-cased into "Gpt" / "Glm".
const ACRONYMS = new Set(["gpt", "glm", "ai", "llm", "moe", "vl", "xl"]);

function prettyName(slug: string): string {
  const parts = slug.split("-").map((p) => {
    if (ACRONYMS.has(p.toLowerCase())) return p.toUpperCase();
    if (/^\d/.test(p) || p.length <= 2) return p.toUpperCase();
    return p[0].toUpperCase() + p.slice(1);
  });
  // "GPT 5.6" reads wrong — brands hyphenate the acronym to its version number.
  return parts
    .join(" ")
    .replace(/\b(GPT|GLM) (\d)/g, "$1-$2");
}

function prettyCtx(n: number | null): string | null {
  if (!n) return null;
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M context`;
  return `${Math.round(n / 1000)}K context`;
}

/**
 * Parse `--add id[,id…]` (also accepts `--add=id,id`). Adding a model pulls ONLY
 * verifiable facts from OpenRouter — pricing and context window — into the
 * `upAndComing` list, which has no benchmark/sentiment fields. Benchmarks and
 * editorial judgement are never auto-generated: inventing them would be worse
 * than leaving them out.
 */
function parseAddFlag(): string[] {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith("--add="));
  if (eq) return eq.slice(6).split(",").map((s) => s.trim()).filter(Boolean);
  const i = argv.indexOf("--add");
  if (i !== -1 && argv[i + 1]) return argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
  return [];
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

  // --add: pull new models in with verifiable facts only (price + context).
  const toAdd = parseAddFlag();
  const added: string[] = [];
  if (toAdd.length) {
    const upcoming: any[] = Array.isArray(doc.upAndComing)
      ? doc.upAndComing
      : (doc.upAndComing = []);
    const tracked = new Set(
      [...models, ...upcoming].map((m: any) => m.openrouterId).filter(Boolean),
    );
    for (const id of toAdd) {
      const live = byId.get(id);
      if (!live) {
        console.log(`   ! ${id} — not on OpenRouter, skipped`);
        continue;
      }
      if (tracked.has(id)) {
        console.log(`   = ${id} — already tracked, skipped`);
        continue;
      }
      const [vendorId, ...rest] = id.split("/");
      const slug = rest.join("/") || id;
      const vendor = VENDORS[vendorId] ?? {
        name: prettyName(vendorId),
        key: vendorId.replace(/[^a-z0-9]/gi, ""),
      };
      const inP = parsePrice(live.pricing?.prompt);
      const outP = parsePrice(live.pricing?.completion);
      const ctx =
        typeof live.context_length === "number" && live.context_length > 0
          ? live.context_length
          : null;
      // Strictly factual — no claims we can't verify from the catalog.
      const facts = [
        prettyCtx(ctx),
        inP != null && outP != null ? `$${inP}/$${outP} per M tokens` : null,
      ].filter(Boolean);
      upcoming.push({
        id: slug,
        name: prettyName(slug),
        vendor: vendor.name,
        vendorKey: vendor.key,
        openrouterId: id,
        expected: "Available now",
        why: facts.length
          ? `${facts.join(" · ")} (live OpenRouter pricing). Not yet reviewed — benchmarks and verdict pending.`
          : "Newly listed on OpenRouter. Not yet reviewed.",
        link: `https://openrouter.ai/${id}`,
      });
      tracked.add(id);
      added.push(id);
    }
  }

  const now = new Date().toISOString();
  if (doc.freshness?.live) doc.freshness.live.fetchedAt = now;
  doc.generatedAt = now;

  writeFileSync(JSON_PATH, JSON.stringify(doc, null, 2) + "\n");
  console.log(`✓ refreshed price/context for ${priced}/${models.length} models → ${JSON_PATH}`);
  if (added.length) {
    console.log(`✓ added ${added.length} model(s) to upAndComing with live price/context:`);
    for (const a of added) console.log(`   + ${a}`);
    console.log("  (facts only — add benchmarks/verdict by hand when you've formed one.)");
  }

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
