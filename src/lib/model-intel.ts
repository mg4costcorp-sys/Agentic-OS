// src/lib/model-intel.ts
// Types + live OpenRouter merge + roster persistence. Pure helpers are React-free so a headless
// Claude Code script can `import { recommendModel, mergeLive } from "@/lib/model-intel"`.
//
// This file exports ONLY hooks + pure functions + types — NO React component export — so the
// `react-refresh/only-export-components` lint rule (eslint.config.js) stays happy.

import { useCallback, useEffect, useRef, useState } from "react";

// The curated snapshot is bundled at build time (resolveJsonModule). This makes the panel work
// identically in `vite dev`, in a static production build, and fully offline — no dev-only
// middleware, no backend, no API key. The live OpenRouter pull then overlays fresh price/context
// at runtime. Community members who clone the repo get a fully-populated panel on first paint.
import bakedDocJson from "@/data/model-intel.json";

// ── Types (mirror model-intel.json exactly) ─────────────────────────────────────────────
export type Tier = "frontier" | "fast" | "open" | "specialist";
export type ModelStatus = "new" | "rising" | "stable" | "fading";
export type SentimentLabel = "very positive" | "positive" | "mixed" | "negative";

export interface ModelIntel {
  id: string;
  name: string;
  vendor: string;
  vendorKey: string; // join key → MODELS[] in model-logos.tsx (string, not ModelKey, so new vendors don't break types)
  openrouterId: string;
  tier: Tier;
  status: ModelStatus;
  oneLiner: string;
  price: { inputPerM: number | null; outputPerM: number | null; currency: string };
  context: number | null;
  speedTps: number | null;
  liveFields: string[];
  benchmarks: {
    lmarenaElo: number | null;
    aaIndex: number | null;
    aiderPolyglot: number | null;
    sweBench: number | null;
  };
  primaryBench: keyof ModelIntel["benchmarks"];
  sentiment: {
    label: SentimentLabel;
    score: number;
    summary: string;
    loved: string[];
    gripes: string[];
  };
  strengths: string[];
  weaknesses: string[];
  bestFor: string[];
  avoidFor: string[];
  proUsage: string;
  popularity?: number | null; // curated OpenRouter usage rank (1 = most tokens); snapshot
  roster: { inPlay: boolean };
  links: { openrouter: string; vendor: string; leaderboard: string };
}

export interface Pick {
  slot: "smartest" | "proFavorite" | "fastest" | "cheapest" | "rising";
  modelId: string;
  label: string;
  metric: string;
}

export interface Upcoming {
  id: string;
  name: string;
  vendor: string;
  vendorKey: string;
  openrouterId: string;
  expected: string;
  why: string;
  link: string;
}

export interface ModelIntelDoc {
  $schema: string;
  generatedAt: string;
  freshness: {
    live: {
      source: string;
      endpoint: string;
      fetchedAt: string | null;
      status: "ok" | "stale" | "error";
      liveFields: string[];
    };
    snapshot: { curatedAsOf: string; by: string; curatedFields: string[] };
  };
  routing: { default: string; rules: string[] };
  leaderboards: { label: string; url: string }[];
  picks: Pick[];
  models: ModelIntel[];
  upAndComing: Upcoming[];
}

// ── Constants ───────────────────────────────────────────────────────────────────────────
// The on-disk path of the agent-readable knowledge base. Bundled into the app via static import
// (see top of file); also the literal file an agent / Claude Code reads: src/data/model-intel.json.
export const MODEL_INTEL_PATH = "src/data/model-intel.json";
export const OPENROUTER_CATALOG = "https://openrouter.ai/api/v1/models"; // public, no auth
export const ROSTER_LS_KEY = "claude-os-model-roster";

// EMPTY-safe doc so the panel can render before the baked snapshot lands (mirrors useLiveData's EMPTY).
export const EMPTY_MODEL_INTEL: ModelIntelDoc = {
  $schema: "",
  generatedAt: new Date().toISOString(),
  freshness: {
    live: {
      source: "OpenRouter",
      endpoint: OPENROUTER_CATALOG,
      fetchedAt: null,
      status: "stale",
      liveFields: ["price.inputPerM", "price.outputPerM", "context"],
    },
    snapshot: { curatedAsOf: "", by: "", curatedFields: [] },
  },
  routing: { default: "", rules: [] },
  leaderboards: [],
  picks: [],
  models: [],
  upAndComing: [],
};

// The bundled curated snapshot, typed. Cast through `unknown` because the JSON carries a few extra
// human-readable keys (_readme, sources, curatedPicks) that aren't on the interface.
export const BAKED_MODEL_INTEL = bakedDocJson as unknown as ModelIntelDoc;

// ── Live OpenRouter merge (pure) ────────────────────────────────────────────────────────
export interface OpenRouterModel {
  id: string;
  pricing?: { prompt?: string; completion?: string };
  context_length?: number;
}

/**
 * OpenRouter returns per-TOKEN price strings → ×1e6 for per-M. Parse defensively; on NaN/0 keep
 * curated. Returns null on bad input, never NaN.
 */
export function parseOpenRouterPrice(perToken?: string): number | null {
  if (perToken == null) return null;
  const n = Number(perToken);
  if (!Number.isFinite(n) || n <= 0) return null;
  const perM = n * 1_000_000;
  if (!Number.isFinite(perM) || perM <= 0) return null;
  // Round to a sane number of decimals so we don't surface float noise like 2.9999999.
  return Math.round(perM * 1000) / 1000;
}

/**
 * Overlays live price/context onto a curated doc keyed by openrouterId. NEVER touches curated
 * fields (benchmarks/sentiment/etc). Per-model try/catch; stamps each model.liveFields with what
 * merged. Returns a NEW doc (immutable); also sets freshness.live.fetchedAt + status.
 */
export function mergeLive(doc: ModelIntelDoc, catalog: OpenRouterModel[]): ModelIntelDoc {
  const fetchedAt = new Date().toISOString();

  // Index the catalog by id for O(1) lookups; ignore malformed rows.
  const byId = new Map<string, OpenRouterModel>();
  for (const row of Array.isArray(catalog) ? catalog : []) {
    if (row && typeof row.id === "string") byId.set(row.id, row);
  }

  let anyMerged = false;

  const models: ModelIntel[] = doc.models.map((m) => {
    try {
      const live = m.openrouterId ? byId.get(m.openrouterId) : undefined;
      if (!live) {
        // No live row for this model — keep curated values, clear any stale live stamps.
        return { ...m, liveFields: [] };
      }

      const liveInput = parseOpenRouterPrice(live.pricing?.prompt);
      const liveOutput = parseOpenRouterPrice(live.pricing?.completion);
      const liveContext =
        typeof live.context_length === "number" &&
        Number.isFinite(live.context_length) &&
        live.context_length > 0
          ? live.context_length
          : null;

      const liveFields: string[] = [];
      const price = { ...m.price };
      if (liveInput != null) {
        price.inputPerM = liveInput;
        liveFields.push("price.inputPerM");
      }
      if (liveOutput != null) {
        price.outputPerM = liveOutput;
        liveFields.push("price.outputPerM");
      }

      let context = m.context;
      if (liveContext != null) {
        context = liveContext;
        liveFields.push("context");
      }

      if (liveFields.length > 0) anyMerged = true;

      return { ...m, price, context, liveFields };
    } catch {
      // Never let one malformed row poison the whole merge — fall back to curated for this model.
      return { ...m, liveFields: [] };
    }
  });

  return {
    ...doc,
    models,
    freshness: {
      ...doc.freshness,
      live: {
        ...doc.freshness.live,
        fetchedAt,
        status: anyMerged ? "ok" : "stale",
      },
    },
  };
}

// ── Daily live-price cache (keyless, offline-safe) ──────────────────────────────────────
// We persist the last successful OpenRouter pull (only the rows we actually use, to stay tiny)
// so: (a) a reload shows last-known live prices instantly even offline, and (b) we only hit the
// network once a day — the "refreshes daily" cadence — instead of on every page load.
export const LIVE_CACHE_LS_KEY = "claude-os-model-live";
export const LIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface LiveCache {
  subset: OpenRouterModel[];
  fetchedAt: string;
}

function loadLiveCache(): LiveCache | null {
  try {
    const raw = localStorage.getItem(LIVE_CACHE_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.subset) && typeof parsed.fetchedAt === "string") {
      return parsed as LiveCache;
    }
  } catch {
    /* ignore — fall back to the baked snapshot */
  }
  return null;
}

function saveLiveCache(c: LiveCache) {
  try {
    localStorage.setItem(LIVE_CACHE_LS_KEY, JSON.stringify(c));
  } catch {
    /* private mode — fine, the merge still lives in React state this session */
  }
}

// ── Fetch hook (React) ──────────────────────────────────────────────────────────────────
export interface UseModelIntel {
  data: ModelIntelDoc; // baked snapshot, then live-merged after a successful pull (EMPTY-safe before load)
  live: boolean; // true once a live merge has landed this session
  liveStatus: "ok" | "stale" | "error";
  fetchedAt: string | null;
  refreshing: boolean;
  refresh: () => void; // re-pulls OpenRouter, re-merges; debounced 1/10s; AbortController on unmount; fail-soft
}

/**
 * Seeds from the bundled BAKED_MODEL_INTEL snapshot (no flash of empty); then lazy (after first
 * paint) fetch(OPENROUTER_CATALOG) → mergeLive. On any live failure: keep baked doc,
 * liveStatus="error", panel never errors.
 */
export function useModelIntel(): UseModelIntel {
  // Seed directly from the bundled curated snapshot so the panel paints fully-populated on the very
  // first frame — no empty flash, works offline. The live OpenRouter pull overlays fresh data after.
  const [baked, setBaked] = useState<ModelIntelDoc>(BAKED_MODEL_INTEL);
  const [data, setData] = useState<ModelIntelDoc>(BAKED_MODEL_INTEL);
  const [live, setLive] = useState(false);
  const [liveStatus, setLiveStatus] = useState<"ok" | "stale" | "error">("stale");
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Keep a ref to the latest baked doc so refresh() always merges onto the curated base,
  // never onto an already-merged doc (avoids compounding live overlays).
  const bakedRef = useRef<ModelIntelDoc>(BAKED_MODEL_INTEL);
  const abortRef = useRef<AbortController | null>(null);
  const lastPullRef = useRef(0); // debounce: 1 pull / 10s

  // Core live-pull. Fail-soft: any error keeps the baked doc and flips liveStatus to "error".
  const pull = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && now - lastPullRef.current < 10_000) return; // debounce auto-pulls 1/10s
    lastPullRef.current = now;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRefreshing(true);
    try {
      const res = await fetch(OPENROUTER_CATALOG, { signal: controller.signal });
      if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
      const json = (await res.json()) as { data?: OpenRouterModel[] };
      const catalog = Array.isArray(json?.data) ? json.data : [];
      const merged = mergeLive(bakedRef.current, catalog);
      if (controller.signal.aborted) return;
      setData(merged);
      setLive(true);
      setLiveStatus(merged.freshness.live.status);
      setFetchedAt(merged.freshness.live.fetchedAt);
      // Persist only the rows we use so a reload (even offline) shows last-known
      // live prices, and so the next visit can honour the once-a-day cadence.
      const wanted = new Set(bakedRef.current.models.map((m) => m.openrouterId));
      const subset = catalog.filter((c) => c && typeof c.id === "string" && wanted.has(c.id));
      saveLiveCache({
        subset,
        fetchedAt: merged.freshness.live.fetchedAt ?? new Date().toISOString(),
      });
    } catch (err) {
      // AbortError on unmount/refresh is expected — don't surface it as an error state.
      if ((err as { name?: string })?.name === "AbortError") return;
      setLiveStatus("error");
    } finally {
      if (!controller.signal.aborted) setRefreshing(false);
    }
  }, []);

  // Mount: the baked snapshot is already in state (bundled import). Just lazily pull live after
  // first paint so we overlay fresh OpenRouter price/context without blocking the initial render.
  useEffect(() => {
    let cancelled = false;
    bakedRef.current = BAKED_MODEL_INTEL;
    setBaked(BAKED_MODEL_INTEL);

    // Hydrate instantly from yesterday's cached pull (offline-safe, no flash), and work out
    // whether today's refresh is actually due.
    let cacheFresh = false;
    const cache = loadLiveCache();
    if (cache) {
      const merged = mergeLive(BAKED_MODEL_INTEL, cache.subset);
      setData(merged);
      setLive(true);
      setLiveStatus(merged.freshness.live.status);
      setFetchedAt(cache.fetchedAt);
      const age = Date.now() - new Date(cache.fetchedAt).getTime();
      cacheFresh = Number.isFinite(age) && age >= 0 && age < LIVE_TTL_MS;
    }

    // Daily cadence: only hit the network when there's no cache or it's >24h old. A manual
    // Refresh always bypasses this (it calls pull() directly).
    if (!cacheFresh) {
      const schedule =
        typeof window !== "undefined" &&
        typeof (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback ===
          "function"
          ? (cb: () => void) =>
              (
                window as unknown as { requestIdleCallback: (cb: () => void) => void }
              ).requestIdleCallback(cb)
          : (cb: () => void) => setTimeout(cb, 0);
      schedule(() => {
        if (!cancelled) void pull();
      });
    }

    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(() => {
    void pull(true); // manual refresh bypasses the debounce so the button always responds
  }, [pull]);

  // `baked` is intentionally read so consumers/tests can rely on the state existing; the live-merged
  // `data` is what the panel renders.
  void baked;

  return { data, live, liveStatus, fetchedAt, refreshing, refresh };
}

// ── Roster persistence (copies use-price-overrides.ts shape verbatim) ───────────────────
export interface UseModelRoster {
  roster: string[]; // model ids the user has pinned
  toggle: (id: string) => void; // add/remove, persists to localStorage
  inRoster: (id: string) => boolean; // EMPTY ROSTER ⇒ ALL TRUE (useful out of the box; first pin scopes the subset)
  clear: () => void; // reset selection back to "all in roster"
}

function loadRoster(): string[] {
  try {
    const raw = localStorage.getItem(ROSTER_LS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveRoster(r: string[]) {
  try {
    localStorage.setItem(ROSTER_LS_KEY, JSON.stringify(r));
  } catch {
    // localStorage throws in private mode — fail silent, state still lives in React.
  }
}

export function useModelRoster(): UseModelRoster {
  const [roster, setRoster] = useState<string[]>(loadRoster);

  const toggle = useCallback((id: string) => {
    setRoster((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      saveRoster(next);
      return next;
    });
  }, []);

  const inRoster = useCallback(
    (id: string) => (roster.length === 0 ? true : roster.includes(id)),
    [roster],
  );

  const clear = useCallback(() => {
    saveRoster([]);
    setRoster([]);
  }, []);

  return { roster, toggle, inRoster, clear };
}

// ── Agent-facing pure helpers (React-free; importable by a headless CC/Hermes script) ────

/** empty roster ⇒ all models */
export function applyRoster(doc: ModelIntelDoc, rosterIds: string[]): ModelIntel[] {
  if (!rosterIds || rosterIds.length === 0) return doc.models;
  const set = new Set(rosterIds);
  return doc.models.filter((m) => set.has(m.id));
}

export function getModelIntel(doc: ModelIntelDoc, id: string): ModelIntel | undefined {
  return doc.models.find((m) => m.id === id);
}

export interface RouteQuery {
  task: string;
  budget?: "low" | "any";
  latency?: "critical" | "any";
}

/**
 * Deterministic routing per doc.routing.rules: filter to inPlay, drop status==="fading", score by
 * bestFor/avoidFor match + benchmarks.aaIndex (hard tasks) or price/speedTps (volume/latency).
 */
export function recommendModel(
  doc: ModelIntelDoc,
  q: RouteQuery,
  rosterIds: string[],
): { model: ModelIntel; why: string } | null {
  const candidates = applyRoster(doc, rosterIds).filter(
    (m) => m.roster.inPlay && m.status !== "fading",
  );
  if (candidates.length === 0) return null;

  const task = (q.task || "").toLowerCase().trim();
  const tokens = task.split(/[^a-z0-9]+/).filter(Boolean);
  const budgetLow = q.budget === "low";
  const latencyCritical = q.latency === "critical";

  // Detect a "hard" task: reasoning/agentic/coding intent → reward raw intelligence (aaIndex).
  const HARD_HINTS = [
    "reason",
    "reasoning",
    "agent",
    "agentic",
    "code",
    "coding",
    "refactor",
    "architecture",
    "debug",
    "math",
    "proof",
    "complex",
    "hard",
    "research",
    "plan",
    "analysis",
  ];
  const isHard = tokens.some((t) => HARD_HINTS.includes(t));

  const matchTags = (tags: string[]) =>
    tags.reduce((acc, tag) => {
      const tl = tag.toLowerCase();
      const hit = tokens.some((t) => t.length > 2 && (tl.includes(t) || t.includes(tl)));
      return acc + (hit ? 1 : 0);
    }, 0);

  const priceOf = (m: ModelIntel) =>
    m.price.inputPerM != null && m.price.outputPerM != null
      ? (m.price.inputPerM + m.price.outputPerM) / 2
      : (m.price.inputPerM ?? m.price.outputPerM ?? null);

  type Scored = { model: ModelIntel; score: number; reasons: string[] };
  const scored: Scored[] = candidates.map((m) => {
    const reasons: string[] = [];
    let score = 0;

    // Intent fit: strong reward for bestFor matches, hard penalty for avoidFor matches.
    const best = matchTags(m.bestFor);
    const avoid = matchTags(m.avoidFor);
    if (best > 0) {
      score += best * 40;
      reasons.push(`best-for match (${best})`);
    }
    if (avoid > 0) {
      score -= avoid * 80;
      reasons.push(`avoid-for penalty (${avoid})`);
    }

    if (isHard) {
      // Hard task → reward intelligence index (aaIndex), 0..~70 typical → scale to ~0..70.
      if (m.benchmarks.aaIndex != null) {
        score += m.benchmarks.aaIndex;
        reasons.push(`AA index ${m.benchmarks.aaIndex}`);
      }
      if (m.tier === "frontier") {
        score += 10;
        reasons.push("frontier tier");
      }
    } else {
      // Volume / general → reward throughput, lean on cheaper/faster tiers.
      if (m.speedTps != null) {
        score += Math.min(m.speedTps / 10, 40);
        reasons.push(`${m.speedTps} tps`);
      }
      if (m.tier === "fast" || m.tier === "open") {
        score += 8;
        reasons.push(`${m.tier} tier`);
      }
    }

    if (latencyCritical && m.speedTps != null) {
      score += Math.min(m.speedTps / 6, 60);
      reasons.push("latency-critical → speed");
    }

    if (budgetLow) {
      const p = priceOf(m);
      if (p != null) {
        // Cheaper is better: subtract a price penalty (scaled), reward sub-$1/M blends.
        score -= Math.min(p * 4, 60);
        if (p <= 1) {
          score += 20;
          reasons.push("low-cost blend");
        } else {
          reasons.push(`price ~$${p.toFixed(2)}/M`);
        }
      }
    }

    // Rising models get a small tiebreaker nudge (momentum).
    if (m.status === "rising") {
      score += 4;
      reasons.push("rising");
    }

    return { model: m, score, reasons };
  });

  // Deterministic ordering: highest score, then alpha by id so ties resolve identically every run.
  scored.sort((a, b) =>
    b.score === a.score ? a.model.id.localeCompare(b.model.id) : b.score - a.score,
  );

  const top = scored[0];
  if (!top) return null;

  const primaryBenchVal = top.model.benchmarks[top.model.primaryBench];
  const benchNote = primaryBenchVal != null ? `, ${top.model.primaryBench} ${primaryBenchVal}` : "";
  const why =
    `${top.model.name} for "${q.task}" — ${top.reasons.slice(0, 3).join(", ") || "best overall fit"}${benchNote}.`.trim();

  return { model: top.model, why };
}

// ── Copy-JSON helper ────────────────────────────────────────────────────────────────────

/** what Copy-JSON copies by default — the doc scoped to the user's roster (empty roster ⇒ full doc) */
export function rosterSubset(doc: ModelIntelDoc, rosterIds: string[]): ModelIntelDoc {
  const models = applyRoster(doc, rosterIds);
  if (models.length === doc.models.length) return { ...doc };
  const keep = new Set(models.map((m) => m.id));
  return {
    ...doc,
    models,
    // Trim picks that point at models no longer in the subset so the copied JSON stays self-consistent.
    picks: doc.picks.filter((p) => keep.has(p.modelId)),
  };
}

// ── Small formatters (React-free) ────────────────────────────────────────────────────────

/** "$3.00" / "$0.15" per-M, or "—" when unknown. */
export function formatPrice(perM: number | null | undefined, currency = "$"): string {
  if (perM == null || !Number.isFinite(perM)) return "—";
  const decimals = perM < 1 ? 2 : perM < 10 ? 2 : 0;
  return `${currency}${perM.toFixed(decimals)}`;
}

/**
 * Blended $/M using the industry-standard 3:1 input:output weighting (most real workloads read far
 * more tokens than they write — this is what Artificial Analysis reports as "blended price").
 * Returns null when neither price is known.
 */
export function blendedPrice(price: ModelIntel["price"] | null | undefined): number | null {
  if (!price) return null;
  const { inputPerM, outputPerM } = price;
  if (inputPerM != null && outputPerM != null) {
    return Math.round(((inputPerM * 3 + outputPerM) / 4) * 1000) / 1000;
  }
  return inputPerM ?? outputPerM ?? null;
}

/** Blended in/out per-M as "$1.58" — handy for a single price chip. */
export function formatBlendedPrice(
  price: ModelIntel["price"] | null | undefined,
  currency = "$",
): string {
  return formatPrice(blendedPrice(price), currency);
}

/** 200000 → "200K", 1000000 → "1M", null → "—". */
export function formatContext(context: number | null | undefined): string {
  if (context == null || !Number.isFinite(context) || context <= 0) return "—";
  if (context >= 1_000_000) {
    const m = context / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (context >= 1_000) {
    const k = context / 1_000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return `${context}`;
}

/** 145 → "145 tok/s", null → "—". */
export function formatSpeed(tps: number | null | undefined): string {
  if (tps == null || !Number.isFinite(tps) || tps <= 0) return "—";
  return `${Math.round(tps)} tok/s`;
}

/** Tier → display label. */
export function formatTier(tier: Tier): string {
  switch (tier) {
    case "frontier":
      return "Frontier";
    case "fast":
      return "Fast";
    case "specialist":
      return "Specialist";
    default:
      return "Open";
  }
}

// ── Sort / filter helpers (React-free) ───────────────────────────────────────────────────

export type ModelSortKey = "price" | "speed" | "elo" | "aa" | "context" | "usage" | "tier" | "name";

const TIER_RANK: Record<Tier, number> = { frontier: 0, fast: 1, open: 2, specialist: 3 };

/**
 * Returns a NEW sorted array. Nulls sort last regardless of direction so "unknown" never wins a row.
 * `dir` defaults to a sensible per-key direction: cheapest first for price, biggest/fastest first
 * for the rest. Pass `dir` to override.
 */
export function sortModels(
  models: ModelIntel[],
  key: ModelSortKey,
  dir?: "asc" | "desc",
): ModelIntel[] {
  const ascByDefault = key === "price" || key === "tier" || key === "name" || key === "usage";
  const direction = dir ?? (ascByDefault ? "asc" : "desc");
  const sign = direction === "asc" ? 1 : -1;

  const valueOf = (m: ModelIntel): number | string | null => {
    switch (key) {
      case "price":
        return blendedPrice(m.price); // 3:1 weighted blended $/M
      case "speed":
        return m.speedTps;
      case "elo":
        return m.benchmarks.lmarenaElo;
      case "aa":
        return m.benchmarks.aaIndex;
      case "usage":
        return m.popularity ?? null; // lower rank = more used → asc shows most-used first
      case "context":
        return m.context;
      case "tier":
        return TIER_RANK[m.tier];
      case "name":
        return m.name;
      default:
        return null;
    }
  };

  return [...models].sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    // Nulls always last.
    if (va == null && vb == null) return a.id.localeCompare(b.id);
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "string" || typeof vb === "string") {
      const cmp = String(va).localeCompare(String(vb));
      return cmp !== 0 ? cmp * sign : a.id.localeCompare(b.id);
    }
    const cmp = va - vb;
    return cmp !== 0 ? cmp * sign : a.id.localeCompare(b.id);
  });
}

export interface ModelFilter {
  tier?: Tier | "all";
  status?: ModelStatus | "all";
  vendorKey?: string | "all";
  inPlayOnly?: boolean;
  query?: string; // free-text over name/vendor/oneLiner
}

/** Returns a NEW filtered array. Omitted/"all" fields don't constrain. */
export function filterModels(models: ModelIntel[], f: ModelFilter): ModelIntel[] {
  const q = (f.query || "").toLowerCase().trim();
  return models.filter((m) => {
    if (f.tier && f.tier !== "all" && m.tier !== f.tier) return false;
    if (f.status && f.status !== "all" && m.status !== f.status) return false;
    if (f.vendorKey && f.vendorKey !== "all" && m.vendorKey !== f.vendorKey) return false;
    if (f.inPlayOnly && !m.roster.inPlay) return false;
    if (q) {
      const hay = `${m.name} ${m.vendor} ${m.oneLiner}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Resolve a model's pick (smartest/fastest/…) for badge rendering, if any. */
export function pickForModel(doc: ModelIntelDoc, id: string): Pick | undefined {
  return doc.picks.find((p) => p.modelId === id);
}
