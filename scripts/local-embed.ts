#!/usr/bin/env bun
/**
 * local-embed.ts — local-first vector index for the Obsidian memory vault.
 *
 * Root cause this exists to fix: aggregate.ts's memory graph counts every
 * markdown file on disk (fast, free, local — walkMd()), but "vectors" in the
 * dashboard have only ever meant Pinecone's vectorCount, fetched by POLLING
 * an existing Pinecone project (fetchPineconeIndexes()). Nothing in this repo
 * ever created an embedding or upserted one to Pinecone — so without a
 * PINECONE_API_KEY *and* a separate external pipeline that already populated
 * an index, "vectors" reads 0 no matter how many files are on disk.
 *
 * This script closes that gap without touching Pinecone, without any API key,
 * and without modifying a single source file: it embeds every note in the
 * primary Obsidian vault with a small local model (no daemon, no network
 * calls except the one-time model download on first run) and writes the
 * result to two new files under ~/.claude-os/ — never into the vault itself.
 *
 *   ~/.claude-os/vector-index.manifest.json   — model, dimension, per-file hash/path
 *   ~/.claude-os/vector-index.bin             — Float32Array vectors, concatenated,
 *                                                same order as the manifest's `files`
 *
 * Incremental: a file whose content hash hasn't changed since the last run
 * reuses its stored vector instead of re-embedding.
 *
 * Usage:
 *   bun run scripts/local-embed.ts
 *   bun run scripts/local-embed.ts --vault "/path/to/other/vault"
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "@huggingface/transformers";

const HOME = homedir();
const STATE_DIR = join(HOME, ".claude-os");
const MANIFEST_PATH = join(STATE_DIR, "vector-index.manifest.json");
const BIN_PATH = join(STATE_DIR, "vector-index.bin");
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const MODEL_DIM = 384;

const MAX_CHARS = 2000; // plenty for a 256-token model; keeps inference fast.
const PROGRESS_EVERY = 200;
const SAVE_EVERY = 500; // checkpoint so a long run can be interrupted safely.

interface ManifestFile {
  path: string; // absolute path
  hash: string;
  mtimeMs: number;
  bytes: number;
}

interface Manifest {
  model: string;
  dimension: number;
  vaultRoot: string;
  createdAt: string;
  updatedAt: string;
  files: ManifestFile[];
}

function parseArgs(argv: string[]): { vaultOverride?: string } {
  const i = argv.indexOf("--vault");
  return i >= 0 && argv[i + 1] ? { vaultOverride: argv[i + 1] } : {};
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Same short candidate list aggregate.ts checks, minus the iCloud/Desktop
 *  deep scan — good enough to find the vault that actually holds ~99% of
 *  this machine's memory files, and CLAUDE_OS_OBSIDIAN_PATH always wins. */
function findVaultRoot(override?: string): string {
  const candidates = [
    override,
    process.env.CLAUDE_OS_OBSIDIAN_PATH,
    join(HOME, "Obsidian"),
    join(HOME, "Documents", "Obsidian Vault"),
    join(HOME, "Documents", "Obsidian"),
    join(HOME, "Desktop", "Obsidian"),
  ].filter((p): p is string => Boolean(p));

  for (const raw of candidates) {
    const root = resolve(raw);
    if (!isDirectory(root)) continue;
    if (override || existsSync(join(root, ".obsidian"))) return root;
  }
  throw new Error(
    "No Obsidian vault found (checked CLAUDE_OS_OBSIDIAN_PATH, ~/Obsidian, " +
      "~/Documents/Obsidian Vault, ~/Documents/Obsidian, ~/Desktop/Obsidian). " +
      "Pass --vault \"/path/to/vault\" to point at one directly.",
  );
}

function walkMd(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(p);
  }
  return out;
}

/** Strip frontmatter + markdown syntax down to prose — the embedding model
 *  reads meaning, not formatting. */
function toPlainText(raw: string): string {
  const withoutFrontmatter = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return withoutFrontmatter
    .replace(/```[\s\S]*?```/g, " ") // code fences
    .replace(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, "$1") // [[wikilinks]]
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url)
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function loadOldManifest(): Manifest | null {
  if (!existsSync(MANIFEST_PATH) || !existsSync(BIN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function oldVectorByPath(old: Manifest | null): Map<string, Float32Array> {
  const map = new Map<string, Float32Array>();
  if (!old) return map;
  try {
    const buf = readFileSync(BIN_PATH);
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    old.files.forEach((f, i) => {
      map.set(f.path, all.slice(i * old.dimension, (i + 1) * old.dimension));
    });
  } catch {
    /* a corrupt/short bin just means everything re-embeds */
  }
  return map;
}

async function main() {
  const { vaultOverride } = parseArgs(process.argv.slice(2));
  const vaultRoot = findVaultRoot(vaultOverride);
  console.log(`[local-embed] vault: ${vaultRoot}`);

  const files = walkMd(vaultRoot);
  console.log(`[local-embed] found ${files.length} markdown files`);
  if (files.length === 0) {
    console.log("[local-embed] nothing to embed — exiting");
    return;
  }

  const old = loadOldManifest();
  const oldVectors = oldVectorByPath(old && old.dimension === MODEL_DIM ? old : null);
  const oldHashByPath = new Map((old?.files ?? []).map((f) => [f.path, f.hash]));

  console.log(`[local-embed] loading ${MODEL_ID} (first run downloads ~90 MB, cached after)...`);
  const extractor = await pipeline("feature-extraction", MODEL_ID, { dtype: "fp32" });

  const manifestFiles: ManifestFile[] = [];
  const vectors: Float32Array[] = [];
  let reused = 0;
  let embedded = 0;
  let skippedEmpty = 0;

  const flush = () => {
    const combined = new Float32Array(vectors.length * MODEL_DIM);
    vectors.forEach((v, i) => combined.set(v, i * MODEL_DIM));
    writeFileSync(BIN_PATH, Buffer.from(combined.buffer));
    const manifest: Manifest = {
      model: MODEL_ID,
      dimension: MODEL_DIM,
      vaultRoot,
      createdAt: old?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      files: manifestFiles,
    };
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  };

  for (let i = 0; i < files.length; i++) {
    const path = files[i];
    let content: string;
    let stat;
    try {
      content = readFileSync(path, "utf-8");
      stat = statSync(path);
    } catch {
      continue; // vanished or unreadable mid-walk — skip, don't crash the run
    }
    const hash = Bun.hash(content).toString(16);

    const reusable = oldHashByPath.get(path) === hash ? oldVectors.get(path) : undefined;
    if (reusable && reusable.length === MODEL_DIM) {
      vectors.push(reusable);
      reused++;
    } else {
      const plain = toPlainText(content).slice(0, MAX_CHARS);
      const text = plain || files[i].split("/").pop() || "empty note";
      if (!plain) skippedEmpty++;
      const out = await extractor(text, { pooling: "mean", normalize: true });
      vectors.push(new Float32Array(out.data));
      embedded++;
    }
    manifestFiles.push({ path, hash, mtimeMs: stat.mtimeMs, bytes: stat.size });

    if ((i + 1) % PROGRESS_EVERY === 0) {
      console.log(
        `[local-embed] ${i + 1}/${files.length} — ${embedded} embedded, ${reused} reused`,
      );
    }
    if ((i + 1) % SAVE_EVERY === 0) flush();
  }

  flush();
  console.log(
    `[local-embed] done — ${manifestFiles.length} vectors total ` +
      `(${embedded} embedded, ${reused} reused, ${skippedEmpty} empty notes embedded by filename)`,
  );
  console.log(`[local-embed] wrote ${MANIFEST_PATH}`);
  console.log(`[local-embed] wrote ${BIN_PATH}`);
}

main().catch((e) => {
  console.error("[local-embed] failed:", e);
  process.exit(1);
});
