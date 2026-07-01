#!/usr/bin/env bun
/**
 * Cross-platform replacement for the old `test -f ... || cp ...` shell one-liner
 * that package.json's seed:data script used. That one-liner failed on Windows
 * with `bun: command not found: test`, leaving fresh Windows clones without a
 * live-data.json on first `bun run dev`.
 *
 * Copies the committed sanitized template (live-data.example.json) into the
 * gitignored live-data.json ONLY when the latter doesn't already exist — so a
 * fresh clone boots in demo mode without ever clobbering a real aggregator run.
 */
import { existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const dataDir = join(import.meta.dir, "..", "src", "data");
const target = join(dataDir, "live-data.json");
const template = join(dataDir, "live-data.example.json");

if (existsSync(target)) {
  // Already seeded, or a real aggregator run is present — leave it untouched.
  process.exit(0);
}

if (!existsSync(template)) {
  console.error("[seed:data] live-data.example.json missing — cannot seed demo data.");
  process.exit(1);
}

copyFileSync(template, target);
console.log("[seed:data] created src/data/live-data.json from live-data.example.json");
