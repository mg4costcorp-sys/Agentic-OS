/**
 * local-vector-index.ts — shared reader/search for the local, no-API-key
 * memory embeddings that `scripts/local-embed.ts` writes.
 *
 * Server-only (uses node:fs and @huggingface/transformers, which needs
 * onnxruntime-node) — import this from vite.config.ts / scripts, never from
 * browser-bundled component code.
 *
 * Why this file exists rather than living inline in local-embed.ts: the
 * `/__local_search` dev-server endpoint (vite.config.ts) needs the exact same
 * plain-text extraction and model as the embedding job used, or a query's
 * vector and a note's vector would be comparing two different encodings of
 * "the same" text. One shared module, imported by both, makes drift
 * impossible instead of merely unlikely.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOCAL_EMBED_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const LOCAL_EMBED_DIM = 384;

const HOME = homedir();
const STATE_DIR = join(HOME, ".claude-os");
export const VECTOR_MANIFEST_PATH = join(STATE_DIR, "vector-index.manifest.json");
export const VECTOR_BIN_PATH = join(STATE_DIR, "vector-index.bin");

export interface VectorManifestFile {
  path: string;
  hash: string;
  mtimeMs: number;
  bytes: number;
}

export interface VectorManifest {
  model: string;
  dimension: number;
  vaultRoot: string;
  createdAt: string;
  updatedAt: string;
  files: VectorManifestFile[];
}

/** Strip frontmatter + markdown syntax down to prose — must match
 *  scripts/local-embed.ts exactly, or query vs. note encodings diverge. */
export function toPlainText(raw: string): string {
  const withoutFrontmatter = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return withoutFrontmatter
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function loadManifest(): VectorManifest | null {
  if (!existsSync(VECTOR_MANIFEST_PATH)) return null;
  try {
    return JSON.parse(readFileSync(VECTOR_MANIFEST_PATH, "utf-8"));
  } catch {
    return null;
  }
}

/** All vectors, one Float32Array per file, same order as manifest.files. */
export function loadVectors(manifest: VectorManifest): Float32Array[] | null {
  if (!existsSync(VECTOR_BIN_PATH)) return null;
  try {
    const buf = readFileSync(VECTOR_BIN_PATH);
    const dim = manifest.dimension;
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (all.length !== manifest.files.length * dim) return null; // stale/mismatched pair
    return manifest.files.map((_, i) => all.slice(i * dim, (i + 1) * dim));
  } catch {
    return null;
  }
}

/** Cosine similarity — a plain dot product, since local-embed.ts writes
 *  L2-normalized vectors (pooling: "mean", normalize: true). */
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export interface SearchHit {
  path: string;
  score: number;
  mtimeMs: number;
}

export function cosineTopK(
  query: Float32Array,
  manifest: VectorManifest,
  vectors: Float32Array[],
  k: number,
): SearchHit[] {
  const scored = manifest.files.map((f, i) => ({
    path: f.path,
    mtimeMs: f.mtimeMs,
    score: dot(query, vectors[i]),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** Lazy singleton — loading the model takes real time (first run downloads
 *  it, ~90MB), so every /__local_search request after the first reuses this
 *  same in-process pipeline instead of reloading it per request. */
let embedderPromise: Promise<any> | null = null;
export function loadEmbedder(): Promise<any> {
  if (!embedderPromise) {
    embedderPromise = import("@huggingface/transformers").then(({ pipeline }) =>
      pipeline("feature-extraction", LOCAL_EMBED_MODEL_ID, { dtype: "fp32" }),
    );
  }
  return embedderPromise;
}

/** Embed one piece of text with the same pooling/normalize settings the
 *  index was built with. */
export async function embedText(text: string): Promise<Float32Array> {
  const extractor = await loadEmbedder();
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return new Float32Array(out.data);
}

/** A short, readable preview of a note — same source local-embed.ts
 *  actually embedded, truncated for display rather than for the model's
 *  token budget. */
export function readSnippet(path: string, maxChars = 220): string {
  try {
    const plain = toPlainText(readFileSync(path, "utf-8"));
    return plain.length > maxChars ? `${plain.slice(0, maxChars - 1)}…` : plain;
  } catch {
    return "";
  }
}

export function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
