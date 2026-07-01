#!/usr/bin/env bun
/**
 * Generate 10 Hermes-style placeholder cards — one per non-image file type
 * in the Documents Gallery (pdf, html, markdown, text, data, video, audio,
 * archive, code, other).
 *
 * Style matches the existing Pantheon art at src/assets/hermes-art/* —
 * 19th-century engraving on parchment, muted teal + cream + a single warm
 * accent, stippled dot-texture, soft candlelight, classical Greek framing.
 *
 * Each type gets its own Greek/mythological object so the placeholder
 * still reads as that file type at a glance:
 *   pdf       → sealed wax-stamped vellum scroll
 *   html      → woven loom with threads forming a web pattern
 *   markdown  → open codex with quill
 *   text      → folded letter on a writing desk
 *   data      → abacus + stacked stone tablets
 *   video     → bronze theatre mask (Dionysus)
 *   audio     → small golden lyre on a velvet cushion
 *   archive   → bronze-bound chest, slightly open
 *   code      → mechanical bronze astrolabe / gears (Heron of Alexandria)
 *   other     → unfurled blank parchment with quill
 *
 * Per-type accent colour is baked into the prompt so the resulting image
 * already has a subtle tint pulling toward the gallery's TYPE_META colour.
 *
 * Usage:
 *   KIE_API_KEY=... bun run scripts/gen-hermes-file-type-art.ts
 *   bun run scripts/gen-hermes-file-type-art.ts pdf data code
 *     (omit args = generate all 10)
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { generate } from "./gen-image.ts";

// Source the .env.local if KIE_API_KEY isn't already in env.
if (!process.env.KIE_API_KEY) {
  try {
    const env = require("node:fs").readFileSync(
      join(import.meta.dir, "..", ".env.local"),
      "utf8",
    );
    for (const line of env.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

interface TypeSpec {
  key: string;
  subject: string;
  accentLabel: string; // human-readable colour name baked into the prompt
}

// Style preamble — applied to every generation so the set feels like one
// matched series, not 10 mismatched one-offs.
const STYLE =
  "19th-century hand-engraved illustration on aged parchment, " +
  "stippled fine dot-texture, ink-and-watercolour wash, " +
  "muted desaturated teal and cream palette with a single warm accent, " +
  "framed by classical Greek stone columns at the edges, " +
  "soft candlelight glow from off-frame, vignette darkening at the corners, " +
  "ornate yet minimal, centred composition, no humans visible, " +
  "antique Hermes-mythology atmosphere, suitable as a small card thumbnail";

// The 10 file types — one mythological object each, plus the accent
// colour that should bleed into the image. Accent names are deliberately
// muted (rust, ochre, slate, plum…) so the result still looks like a
// faded engraving, not a saturated cartoon.
const TYPES: TypeSpec[] = [
  {
    key: "pdf",
    subject:
      "a single sealed vellum scroll bound with a deep rust-red ribbon and a glowing wax seal, " +
      "resting on a polished wooden lectern, parchment edges slightly curled, " +
      "a wax seal embossed with a stylised feathered wing",
    accentLabel: "warm rust-orange",
  },
  {
    key: "html",
    subject:
      "a wooden weaving loom, threads strung in an interlocking grid forming a delicate web, " +
      "a single bronze shuttle hanging mid-weave, faint dawn light catching the threads",
    accentLabel: "soft sage-green",
  },
  {
    key: "markdown",
    subject:
      "an open leather-bound codex laying flat, its pages handwritten in ink, " +
      "a single quill resting in an inkwell beside it, gold-leaf flourish on the page",
    accentLabel: "warm gold-amber",
  },
  {
    key: "text",
    subject:
      "a single folded parchment letter sealed with cream wax, " +
      "resting on a dark oak writing desk beside a brass candlestick",
    accentLabel: "pale ivory",
  },
  {
    key: "data",
    subject:
      "a bronze counting abacus on a marble plinth with three stacked stone tablets behind it, " +
      "tablets carved with faint geometric numerals, cool moonlight from above",
    accentLabel: "cool slate-blue",
  },
  {
    key: "video",
    subject:
      "a single bronze Greek theatre mask of Dionysus mounted on a velvet-draped pedestal, " +
      "the mask's eye-holes glowing softly from a hidden flame, drapery cascading down",
    accentLabel: "deep rose-pink",
  },
  {
    key: "audio",
    subject:
      "a small ornate golden lyre resting on a folded indigo velvet cushion on a marble bench, " +
      "seven taut strings catching warm light, faint musical-note flourishes drifting up",
    accentLabel: "soft violet",
  },
  {
    key: "archive",
    subject:
      "a bronze-bound oak treasure chest, lid slightly ajar, warm light spilling out from within, " +
      "iron lock hanging open, ancient runes etched into the bronze bands",
    accentLabel: "burnished amber",
  },
  {
    key: "code",
    subject:
      "a mechanical bronze astrolabe with intricate interlocking gears and engraved star-charts, " +
      "set on a workshop table, schematic blueprints faintly visible behind it, " +
      "Heron-of-Alexandria style precision instrument",
    accentLabel: "verdigris-emerald",
  },
  {
    key: "other",
    subject:
      "a single unfurled blank parchment scroll on a dark wooden table, " +
      "a quill and inkwell beside it, soft candlelight from the upper left, " +
      "deliberately understated and quiet",
    accentLabel: "warm cream",
  },
];

function buildPrompt(spec: TypeSpec): string {
  return (
    `${STYLE}. Subject: ${spec.subject}. ` +
    `Dominant accent colour throughout the image: ${spec.accentLabel}. ` +
    `Aspect 5:3, card-thumbnail framing with the subject centred and clearly readable at small size.`
  );
}

async function main() {
  const requested = Bun.argv.slice(2).filter((a) => !a.startsWith("-"));
  const targets = requested.length
    ? TYPES.filter((t) => requested.includes(t.key))
    : TYPES;

  if (!targets.length) {
    console.error(
      `No matching types. Available: ${TYPES.map((t) => t.key).join(", ")}`,
    );
    process.exit(1);
  }

  const outDir = join(
    import.meta.dir,
    "..",
    "src",
    "assets",
    "hermes-art",
    "file-types",
  );
  mkdirSync(outDir, { recursive: true });

  console.log(`[hermes-art] target dir: ${outDir}`);
  console.log(`[hermes-art] generating ${targets.length} placeholders…\n`);

  const results: Array<{ key: string; path: string | null; err?: string }> = [];

  // Sequential — kie.ai jobs queue best one-at-a-time and we get cleaner
  // logs. Total wall time: ~5-10 min for the full 10.
  for (let i = 0; i < targets.length; i++) {
    const spec = targets[i];
    const outPath = join(outDir, `${spec.key}.png`);
    console.log(`\n[hermes-art] (${i + 1}/${targets.length}) ${spec.key}`);
    try {
      const prompt = buildPrompt(spec);
      await generate({
        prompt,
        aspect: "3:2", // closest kie.ai aspect to our 5:3 card slot
        outPath,
        model: "nano-banana-2",
        resolution: "2K",
        format: "png",
      });
      results.push({ key: spec.key, path: outPath });
      console.log(`[hermes-art] ✓ ${spec.key} → ${outPath}`);
    } catch (e: any) {
      const err = e?.message || String(e);
      console.error(`[hermes-art] ✗ ${spec.key}: ${err}`);
      results.push({ key: spec.key, path: null, err });
    }
  }

  console.log(`\n[hermes-art] summary:`);
  for (const r of results) {
    console.log(`  ${r.path ? "✓" : "✗"}  ${r.key.padEnd(10)} ${r.path ?? r.err}`);
  }

  const ok = results.filter((r) => r.path).length;
  console.log(`\n[hermes-art] ${ok}/${results.length} succeeded.`);
  process.exit(ok === results.length ? 0 : 1);
}

main();
