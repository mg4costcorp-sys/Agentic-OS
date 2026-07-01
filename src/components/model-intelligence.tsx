// src/components/model-intelligence.tsx
// Renders inside Section 7 when activityTab==="models". Reads model-intel.json via /__model-intel,
// merges live OpenRouter price/context/speed in a useEffect (encapsulated in useModelIntel), falls
// back to the baked snapshot. Self-contained: does NOT depend on useLiveData(); renders
// unconditionally.
//
// Three altitudes: GLANCE (logo strip + picks) → SCAN (sortable/filterable table) → INSPECT (in-place
// drawer). The panel is a typeset of model-intel.json — the single Copy-JSON affordance is the only
// "agents read this" chrome in the calm default.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Braces,
  Check,
  ChevronDown,
  Copy,
  RotateCw,
  Search,
  Trophy,
  X,
} from "lucide-react";

import { MODELS, ModelLogo, type ModelKey } from "@/components/model-logos";
import {
  blendedPrice,
  formatBlendedPrice,
  formatContext,
  formatPrice,
  formatSpeed,
  formatTier,
  rosterSubset,
  sortModels,
  useModelIntel,
  useModelRoster,
  type ModelIntel,
  type ModelIntelDoc,
  type ModelSortKey,
  type ModelStatus,
  type SentimentLabel,
  type Tier,
} from "@/lib/model-intel";

// ────────────────────────────────────────────────────────────────────────────────────────
//  Vendor logo + color resolver
//  MODELS in model-logos.tsx only covers claude/openai/gemini/llama/deepseek. The JSON adds
//  grok / mistral / qwen / moonshot / minimax / tencent / xiaomi / zai / nvidia / cohere / meta.
//  We resolve a {slug,color,mono,name} for any vendorKey, reuse the same Simple Icons CDN pattern,
//  and always fall back to a colored monogram chip so nothing renders broken.
// ────────────────────────────────────────────────────────────────────────────────────────

interface VendorBrand {
  name: string;
  slug: string | null; // null ⇒ no clean Simple Icons slug; go straight to monogram
  color: string; // 6-digit hex, NO leading "#"
  mono: string; // 1-2 char fallback monogram
}

const KNOWN_MODEL_KEYS = new Set<string>(Object.keys(MODELS));

// Extra vendors not in MODELS. Slugs are real Simple Icons slugs where one exists.
// Slugs verified against the Simple Icons CDN (cdn.simpleicons.org). Where no clean icon exists,
// slug is null so we render a polished branded monogram instead of flashing a broken image.
// `color` is the colour the icon (or monogram) is drawn in — must read on a DARK chip, so brands
// whose real colour is near-black (e.g. Moonshot) use a lightened brand tone.
const EXTRA_VENDORS: Record<string, VendorBrand> = {
  grok: { name: "xAI", slug: "x", color: "FFFFFF", mono: "x" },
  xai: { name: "xAI", slug: "x", color: "FFFFFF", mono: "x" },
  mistral: { name: "Mistral", slug: "mistralai", color: "FA520F", mono: "M" },
  mistralai: { name: "Mistral", slug: "mistralai", color: "FA520F", mono: "M" },
  qwen: { name: "Qwen", slug: "qwen", color: "615CED", mono: "Q" },
  alibaba: { name: "Alibaba", slug: "alibabacloud", color: "FF6A00", mono: "A" },
  moonshot: { name: "Moonshot", slug: "moonshotai", color: "7A5CFF", mono: "K" },
  moonshotai: { name: "Moonshot", slug: "moonshotai", color: "7A5CFF", mono: "K" },
  minimax: { name: "MiniMax", slug: "minimax", color: "F23A3A", mono: "MM" },
  tencent: { name: "Tencent", slug: null, color: "33B6F5", mono: "T" },
  xiaomi: { name: "Xiaomi", slug: "xiaomi", color: "FF6900", mono: "Mi" },
  zai: { name: "Z.ai", slug: null, color: "5B8DEF", mono: "Z" },
  zhipu: { name: "Z.ai", slug: null, color: "5B8DEF", mono: "Z" },
  glm: { name: "Z.ai", slug: null, color: "5B8DEF", mono: "Z" },
  nvidia: { name: "NVIDIA", slug: "nvidia", color: "76B900", mono: "N" },
  cohere: { name: "Cohere", slug: null, color: "39D3B0", mono: "Co" },
  meta: { name: "Meta", slug: "meta", color: "0467DF", mono: "Me" },
};

function resolveVendor(vendorKey: string, fallbackName?: string): VendorBrand {
  if (KNOWN_MODEL_KEYS.has(vendorKey)) {
    const m = MODELS[vendorKey as ModelKey];
    return { name: m.tagline, slug: m.slug, color: m.color, mono: m.mono };
  }
  const extra = EXTRA_VENDORS[vendorKey];
  if (extra) return extra;
  // Unknown vendor → derive a stable monogram + neutral color so it still renders.
  const name = fallbackName || vendorKey;
  const mono =
    name
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 2)
      .toUpperCase() || "AI";
  return { name, slug: null, color: "8A8F98", mono };
}

/** Vendor-aware logo. Uses ModelLogo for the 5 known keys (keeps OpenAI's inline SVG / fallbacks),
 *  otherwise the Simple Icons CDN with a monogram fallback — same idiom as ModelLogo. */
function VendorLogo({
  vendorKey,
  vendorName,
  size = 20,
}: {
  vendorKey: string;
  vendorName?: string;
  size?: number;
}) {
  const [errored, setErrored] = useState(false);

  if (KNOWN_MODEL_KEYS.has(vendorKey)) {
    return <ModelLogo model={vendorKey as ModelKey} size={size} />;
  }

  const brand = resolveVendor(vendorKey, vendorName);
  if (brand.slug && !errored) {
    return (
      <img
        src={`https://cdn.simpleicons.org/${brand.slug}/${brand.color}`}
        alt={`${brand.name} logo`}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setErrored(true)}
        className="object-contain"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="flex items-center justify-center rounded-full font-semibold leading-none"
      style={{
        width: size,
        height: size,
        background: `#${brand.color}26`,
        color: "#fff",
        boxShadow: `inset 0 0 0 1px #${brand.color}66`,
        fontSize: Math.round(size * (brand.mono.length > 1 ? 0.34 : 0.44)),
        letterSpacing: "-0.02em",
      }}
    >
      {brand.mono}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────
//  Small shared helpers
// ────────────────────────────────────────────────────────────────────────────────────────

const SENTIMENT_COLOR: Record<SentimentLabel, string> = {
  "very positive": "#3ddc97",
  positive: "#5fd6a8",
  mixed: "#f5b14c",
  negative: "#ef5a5a",
};

const STATUS_STYLE: Record<ModelStatus, { label: string; cls: string }> = {
  new: { label: "New", cls: "bg-emerald-500/15 text-emerald-400" },
  rising: { label: "Rising", cls: "bg-violet-500/15 text-violet-400" },
  stable: { label: "Stable", cls: "bg-foreground/5 text-muted-foreground" },
  fading: { label: "Fading", cls: "bg-red-500/15 text-red-400" },
};

const TIER_RANK: Record<Tier, number> = { frontier: 0, fast: 1, open: 2, specialist: 3 };

function timeAgo(iso: string | null): string {
  if (!iso) return "snapshot";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "snapshot";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ────────────────────────────────────────────────────────────────────────────────────────
//  Champions — "the best model for each metric", computed LIVE from the data so they stay
//  correct after every refresh. Each champion can also re-rank the leaderboard below it.
// ────────────────────────────────────────────────────────────────────────────────────────

type ChampionKey = "smartest" | "fastest" | "cheapest" | "used" | "value";

interface Champion {
  key: ChampionKey;
  label: string;
  model: ModelIntel;
  value: string;
  unit: string;
  rankKey: ModelSortKey | null; // clicking "rank by this" sorts the table on this key
}

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Returns the model that wins `score` (max or min), skipping models with no value for it. */
function bestBy(
  models: ModelIntel[],
  score: (m: ModelIntel) => number | null,
  pickMax: boolean,
): ModelIntel | null {
  let winner: ModelIntel | null = null;
  let wv = pickMax ? -Infinity : Infinity;
  for (const m of models) {
    const s = score(m);
    if (s == null || !Number.isFinite(s)) continue;
    if (pickMax ? s > wv : s < wv) {
      wv = s;
      winner = m;
    }
  }
  return winner;
}

function computeChampions(models: ModelIntel[]): Champion[] {
  const champs: Champion[] = [];

  const smart = bestBy(models, (m) => m.benchmarks.aaIndex, true);
  if (smart && isNum(smart.benchmarks.aaIndex))
    champs.push({
      key: "smartest",
      label: "Smartest",
      model: smart,
      value: String(smart.benchmarks.aaIndex),
      unit: "AA index",
      rankKey: "aa",
    });

  const fast = bestBy(models, (m) => m.speedTps, true);
  if (fast && isNum(fast.speedTps))
    champs.push({
      key: "fastest",
      label: "Fastest",
      model: fast,
      value: String(Math.round(fast.speedTps)),
      unit: "tok/s",
      rankKey: "speed",
    });

  const cheap = bestBy(models, (m) => blendedPrice(m.price), false);
  if (cheap)
    champs.push({
      key: "cheapest",
      label: "Cheapest",
      model: cheap,
      value: formatPrice(blendedPrice(cheap.price)),
      unit: "/M blended",
      rankKey: "price",
    });

  const used = bestBy(models, (m) => m.popularity ?? null, false);
  if (used && isNum(used.popularity))
    champs.push({
      key: "used",
      label: "Most used",
      model: used,
      value: `#${used.popularity}`,
      unit: "on OpenRouter",
      rankKey: "usage",
    });

  const value = bestBy(
    models,
    (m) => {
      const b = blendedPrice(m.price);
      const aa = m.benchmarks.aaIndex;
      return isNum(aa) && isNum(b) && b > 0 ? aa / b : null;
    },
    true,
  );
  if (value && isNum(value.benchmarks.aaIndex))
    champs.push({
      key: "value",
      label: "Best value",
      model: value,
      value: String(value.benchmarks.aaIndex),
      unit: `AA · ${formatPrice(blendedPrice(value.price))}/M`,
      rankKey: "price",
    });

  return champs;
}

// ────────────────────────────────────────────────────────────────────────────────────────
//  Toast (tiny, self-contained — the dashboard does not mount a Sonner <Toaster/>)
// ────────────────────────────────────────────────────────────────────────────────────────

function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((m: string) => {
    setMsg(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 1600);
  }, []);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const node = msg ? (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
      <div className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12px] text-foreground shadow-[0_10px_30px_-15px_rgba(0,0,0,0.8)]">
        <Check className="h-3.5 w-3.5 text-emerald-400" />
        {msg}
      </div>
    </div>
  ) : null;
  return { show, node };
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════
//  BottomPanelSwitcher — heavy SESSIONS | MODELS view-switch (SectionHead `right` slot)
//  Plain <button>s (house style); NOT radix toggle-group.
// ════════════════════════════════════════════════════════════════════════════════════════

export interface BottomPanelSwitcherProps {
  value: "sessions" | "models";
  onChange: (v: "sessions" | "models") => void;
}

export function BottomPanelSwitcher({
  value,
  onChange,
}: BottomPanelSwitcherProps): React.JSX.Element {
  const opt = (key: "sessions" | "models", label: string) => {
    const active = value === key;
    return (
      <button
        type="button"
        aria-pressed={active}
        onClick={() => onChange(key)}
        className={`rounded-md px-2.5 py-1 uppercase tracking-wider transition-colors ${
          active
            ? "bg-foreground/10 text-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        {label}
      </button>
    );
  };
  return (
    <div className="inline-flex items-center rounded-lg border border-border bg-card p-0.5 text-[11px]">
      {opt("models", "Models")}
      {opt("sessions", "Sessions")}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════════════
//  BottomPanel — keeps both panels in the same vertical band so flipping never jumps layout.
// ════════════════════════════════════════════════════════════════════════════════════════

export interface BottomPanelProps {
  tab: "sessions" | "models";
  sessions: ReactNode; // <DailyActivityRows /> — Section 7's existing behaviour, verbatim
  models: ReactNode; // <ModelIntelligence />
}

export function BottomPanel({ tab, sessions, models }: BottomPanelProps): React.JSX.Element {
  return (
    <div>
      <div className={tab === "sessions" ? "" : "hidden"}>{sessions}</div>
      <div className={tab === "models" ? "" : "hidden"}>{models}</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════════════
//  ModelIntelligence — the panel. Owns data + roster + sort + filters + drawer.
// ════════════════════════════════════════════════════════════════════════════════════════

interface SortState {
  key: ModelSortKey;
  dir: "asc" | "desc";
}

export function ModelIntelligence(): React.JSX.Element {
  const { data, refresh, refreshing, fetchedAt, liveStatus } = useModelIntel();
  const { toggle, inRoster, roster, clear } = useModelRoster();
  const { show: toast, node: toastNode } = useToast();

  const [expanded, setExpanded] = useState(true); // SCAN table — default OPEN so the full leaderboard shows
  const [expandedId, setExpandedId] = useState<string | null>(null); // INSPECT drawer; one at a time
  const [sort, setSort] = useState<SortState | null>(null); // ephemeral; null = default order
  const [vendorFilter, setVendor] = useState<string | null>(null); // logo-strip-as-filter
  const [tierFilter, setTier] = useState<Tier | "all">("all");
  const [showOffRoster, setShowOffRoster] = useState(true);
  const [query, setQuery] = useState(""); // type-to-find filter over name/vendor/id

  // Esc clears the INSPECT drawer (no modal; one open at a time).
  useEffect(() => {
    if (!expandedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expandedId]);

  const byId = useMemo(() => {
    const m: Record<string, ModelIntel> = {};
    for (const model of data.models) m[model.id] = model;
    return m;
  }, [data.models]);

  // Default sort = picks-aware: frontier first, then aaIndex desc, then name. Nulls last.
  const defaultCompare = useCallback((a: ModelIntel, b: ModelIntel) => {
    const tr = (TIER_RANK[a.tier] ?? 99) - (TIER_RANK[b.tier] ?? 99);
    if (tr !== 0) return tr;
    const aa = a.benchmarks.aaIndex;
    const ba = b.benchmarks.aaIndex;
    if (aa == null && ba == null) return a.name.localeCompare(b.name);
    if (aa == null) return 1;
    if (ba == null) return -1;
    if (ba !== aa) return ba - aa;
    return a.name.localeCompare(b.name);
  }, []);

  // rows = filter → roster-sink → sort (pure; derives the visible set).
  const rows = useMemo(() => {
    let list = data.models.slice();

    if (tierFilter !== "all") list = list.filter((m) => m.tier === tierFilter);
    if (vendorFilter) list = list.filter((m) => m.vendorKey === vendorFilter);
    if (!showOffRoster) list = list.filter((m) => inRoster(m.id));

    // Type-to-find: match across name, vendor, and both ids so "opus", "anthropic",
    // and "claude-opus-4.8" all land the same model.
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.vendor.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.openrouterId.toLowerCase().includes(q),
      );
    }

    // Apply the chosen sort (or default order).
    const sorted = sort ? sortModels(list, sort.key, sort.dir) : list.slice().sort(defaultCompare);

    // Roster sink: off-roster rows stably sink below on-roster rows within the chosen sort.
    const onR = sorted.filter((m) => inRoster(m.id));
    const offR = sorted.filter((m) => !inRoster(m.id));
    return [...onR, ...offR];
  }, [data.models, tierFilter, vendorFilter, showOffRoster, sort, inRoster, defaultCompare, query]);

  const onSort = useCallback((key: ModelSortKey) => {
    setSort((prev) => {
      // cycle: default → desc → asc → default (per column)
      if (!prev || prev.key !== key) {
        const startDesc = !(key === "price" || key === "tier" || key === "name");
        return { key, dir: startDesc ? "desc" : "asc" };
      }
      const startDesc = !(key === "price" || key === "tier" || key === "name");
      if (prev.dir === (startDesc ? "desc" : "asc")) {
        return { key, dir: startDesc ? "asc" : "desc" };
      }
      return null; // back to default
    });
  }, []);

  // One-click leaderboard re-rank: set the sort directly (null = back to default order).
  const onRankBy = useCallback((key: ModelSortKey | null) => {
    if (key == null) return setSort(null);
    const asc = key === "price" || key === "tier" || key === "name" || key === "usage";
    setSort({ key, dir: asc ? "asc" : "desc" });
  }, []);

  const handleRefresh = useCallback(() => {
    refresh();
    toast("Refreshing live prices…");
  }, [refresh, toast]);

  const expandedModel = expandedId ? (byId[expandedId] ?? null) : null;

  return (
    <div className="relative">
      {/* The Refresh control lives in the panel (the SectionHead host shows the switcher only); we
          surface it inline-right of the freshness line so the panel stays self-contained. */}
      <FreshnessLine
        fetchedAt={fetchedAt}
        liveStatus={liveStatus}
        curatedAsOf={data.freshness?.snapshot?.curatedAsOf ?? ""}
        expanded={expanded}
        onExpand={() => setExpanded((v) => !v)}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        onCopyJson={() => {
          const subset = rosterSubset(data, rosterIdsFrom(data, inRoster));
          void copyText(JSON.stringify(subset, null, 2)).then((ok) => {
            if (ok) toast("Copied ✓");
          });
        }}
      />

      <LogoStrip
        models={data.models}
        inRoster={inRoster}
        activeVendor={vendorFilter}
        onPick={(v) => setVendor((cur) => (cur === v ? null : v))}
      />

      <ChampionsRow
        models={data.models}
        inRoster={inRoster}
        onInspect={setExpandedId}
        onRankBy={onRankBy}
      />

      {expanded && (
        <ModelTable
          rows={rows}
          query={query}
          onQuery={setQuery}
          sort={sort}
          onSort={onSort}
          onRankBy={onRankBy}
          tierFilter={tierFilter}
          onTier={setTier}
          showOffRoster={showOffRoster}
          onToggleOffRoster={() => setShowOffRoster((v) => !v)}
          roster={{ toggle, inRoster }}
          rosterCount={roster.length}
          onClearRoster={clear}
          onInspect={setExpandedId}
          leaderboards={data.leaderboards}
        />
      )}

      {expandedModel && (
        <InspectDrawer
          model={expandedModel}
          curatedAsOf={data.freshness?.snapshot?.curatedAsOf ?? ""}
          leaderboards={data.leaderboards}
          onClose={() => setExpandedId(null)}
          onCopyOne={() => {
            void copyText(JSON.stringify(expandedModel, null, 2)).then((ok) => {
              if (ok) toast("Copied ✓");
            });
          }}
        />
      )}

      {toastNode}
    </div>
  );
}

/** The set of in-roster ids, derived from the inRoster predicate over the catalog. */
function rosterIdsFrom(doc: ModelIntelDoc, inRoster: (id: string) => boolean): string[] {
  return doc.models.filter((m) => inRoster(m.id)).map((m) => m.id);
}

// ────────────────────────────────────────────────────────────────────────────────────────
//  FreshnessLine — 4px chrome, the only always-on status. + Refresh + Copy-JSON.
// ────────────────────────────────────────────────────────────────────────────────────────

function FreshnessLine({
  fetchedAt,
  liveStatus,
  curatedAsOf,
  expanded,
  onExpand,
  onRefresh,
  refreshing,
  onCopyJson,
}: {
  fetchedAt: string | null;
  liveStatus: "ok" | "stale" | "error";
  curatedAsOf: string;
  expanded: boolean;
  onExpand: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  onCopyJson: () => void;
}) {
  const failed = liveStatus === "error";
  const dotColor = failed ? "#f5b14c" : "#3ddc97";
  const liveLabel = failed ? "snapshot only · live pull failed" : `live · ${timeAgo(fetchedAt)}`;

  return (
    <div className="mb-3 flex items-center gap-2 text-[10px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: dotColor, boxShadow: `0 0 8px ${dotColor}` }}
        />
        <span className={failed ? "text-amber-400" : "text-foreground/80"}>{liveLabel}</span>
      </span>
      {curatedAsOf && <span className="text-muted-foreground/60">· snapshot {curatedAsOf}</span>}

      <span className="ml-auto inline-flex items-center gap-1.5">
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={expanded}
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          All models
          <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh live model data"
          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          <RotateCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
        </button>
        <button
          type="button"
          onClick={onCopyJson}
          title="Copy model-intel.json (what your agents read)"
          aria-label="Copy model-intel.json"
          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          <Braces className="h-3 w-3" />
        </button>
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────
//  LogoStrip — compacted ModelStrip chip idiom; doubles as the vendor filter in SCAN.
// ────────────────────────────────────────────────────────────────────────────────────────

function LogoStrip({
  models,
  inRoster,
  activeVendor,
  onPick,
}: {
  models: ModelIntel[];
  inRoster: (id: string) => boolean;
  activeVendor: string | null;
  onPick: (vendorKey: string) => void;
}) {
  // One chip per vendor (dedupe by vendorKey, first model's name for the label).
  const vendors = useMemo(() => {
    const map = new Map<string, { key: string; name: string; anyInRoster: boolean }>();
    for (const m of models) {
      const ex = map.get(m.vendorKey);
      const inR = inRoster(m.id);
      if (ex) ex.anyInRoster = ex.anyInRoster || inR;
      else map.set(m.vendorKey, { key: m.vendorKey, name: m.vendor, anyInRoster: inR });
    }
    return Array.from(map.values());
  }, [models, inRoster]);

  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {vendors.map((v) => {
        const brand = resolveVendor(v.key, v.name);
        const active = activeVendor === v.key;
        return (
          <button
            key={v.key}
            type="button"
            title={`${v.name}${active ? " · active filter" : ""}`}
            aria-pressed={active}
            onClick={() => onPick(v.key)}
            className={`flex h-11 w-11 items-center justify-center rounded-xl border transition-all hover:-translate-y-0.5 ${
              active ? "border-foreground/50 ring-1 ring-foreground/20" : "border-border/70"
            } ${v.anyInRoster ? "" : "opacity-50"}`}
            style={{ background: `#${brand.color}1a` }}
          >
            <VendorLogo vendorKey={v.key} vendorName={v.name} size={22} />
          </button>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────
//  ChampionsRow + ChampionCard — the best model per metric, computed live, in glow cards.
// ────────────────────────────────────────────────────────────────────────────────────────

function ChampionsRow({
  models,
  inRoster,
  onInspect,
  onRankBy,
}: {
  models: ModelIntel[];
  inRoster: (id: string) => boolean;
  onInspect: (id: string) => void;
  onRankBy: (key: ModelSortKey | null) => void;
}) {
  const champions = useMemo(() => computeChampions(models), [models]);
  if (champions.length === 0) return null;
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
        <Trophy className="h-3 w-3 text-amber-400" />
        Champions · the best model for each metric
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {champions.map((c) => (
          <ChampionCard
            key={c.key}
            champ={c}
            inRoster={inRoster(c.model.id)}
            onInspect={onInspect}
            onRankBy={onRankBy}
          />
        ))}
      </div>
    </div>
  );
}

function ChampionCard({
  champ,
  inRoster,
  onInspect,
  onRankBy,
}: {
  champ: Champion;
  inRoster: boolean;
  onInspect: (id: string) => void;
  onRankBy: (key: ModelSortKey | null) => void;
}) {
  const { model, label, value, unit, rankKey } = champ;
  const brand = resolveVendor(model.vendorKey, model.vendor);

  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border border-border/70 bg-card p-4 transition-all hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.6)] ${
        inRoster ? "" : "opacity-60"
      }`}
      style={{
        backgroundImage: `radial-gradient(120% 80% at 0% 0%, #${brand.color}1f, transparent 60%)`,
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -top-12 -right-12 h-32 w-32 rounded-full opacity-40 blur-3xl transition-opacity group-hover:opacity-70"
        style={{ background: `#${brand.color}` }}
      />
      <button
        type="button"
        onClick={() => onInspect(model.id)}
        className="relative block w-full text-left"
      >
        <div className="mb-2 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <Trophy className="h-3 w-3 text-amber-400" />
          {label}
        </div>

        <div className="flex items-center gap-2.5">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/70"
            style={{ background: `#${brand.color}1a` }}
          >
            <VendorLogo vendorKey={model.vendorKey} vendorName={model.vendor} size={18} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold leading-tight">{model.name}</div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              {model.vendor}
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-baseline gap-1.5">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
          <span className="text-[11px] text-muted-foreground">{unit}</span>
        </div>
      </button>

      {rankKey && (
        <button
          type="button"
          onClick={() => onRankBy(rankKey)}
          className="relative mt-2 inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          Rank table by this
          <ArrowUpRight className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────
//  ModelTable — the SCAN layer. Sortable header, tier chips, hairline rows, footer deep-links.
// ────────────────────────────────────────────────────────────────────────────────────────

const TIER_CHIPS: { key: Tier | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "frontier", label: "Frontier" },
  { key: "fast", label: "Fast" },
  { key: "open", label: "Open" },
  { key: "specialist", label: "Specialist" },
];

// One-click leaderboard re-ranking. "default" clears the sort back to the picks-aware order.
const RANK_BY: { key: ModelSortKey | "default"; label: string }[] = [
  { key: "default", label: "Default" },
  { key: "aa", label: "Smartest" },
  { key: "elo", label: "Arena" },
  { key: "price", label: "Cheapest" },
  { key: "speed", label: "Fastest" },
  { key: "usage", label: "Most used" },
];

// Top-3 rank medal colours (used by the leaderboard # column).
const MEDAL: Record<number, string> = { 1: "#f5c451", 2: "#c8cdd6", 3: "#cd8b5b" };

function ModelTable({
  rows,
  query,
  onQuery,
  sort,
  onSort,
  onRankBy,
  tierFilter,
  onTier,
  showOffRoster,
  onToggleOffRoster,
  roster,
  rosterCount,
  onClearRoster,
  onInspect,
  leaderboards,
}: {
  rows: ModelIntel[];
  query: string;
  onQuery: (v: string) => void;
  sort: SortState | null;
  onSort: (key: ModelSortKey) => void;
  onRankBy: (key: ModelSortKey | null) => void;
  tierFilter: Tier | "all";
  onTier: (t: Tier | "all") => void;
  showOffRoster: boolean;
  onToggleOffRoster: () => void;
  roster: { toggle: (id: string) => void; inRoster: (id: string) => boolean };
  rosterCount: number;
  onClearRoster: () => void;
  onInspect: (id: string) => void;
  leaderboards: { label: string; url: string }[];
}) {
  return (
    <div className="mt-4">
      {/* Rank-by control (the leaderboard's main lever) + tier filter + off-roster toggle */}
      <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
            Rank by
          </span>
          <div className="flex flex-wrap items-center gap-1">
            {RANK_BY.map((r) => {
              const active = (sort?.key ?? "default") === r.key;
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => onRankBy(r.key === "default" ? null : (r.key as ModelSortKey))}
                  aria-pressed={active}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    active
                      ? "bg-foreground/[0.12] text-foreground ring-1 ring-foreground/20"
                      : "bg-foreground/5 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/50" />
            <input
              type="text"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Find a model…"
              aria-label="Find a model"
              className="h-6 w-36 rounded-full border border-border bg-card pl-7 pr-6 text-[11px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-foreground/25"
            />
            {query && (
              <button
                type="button"
                onClick={() => onQuery("")}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 transition-colors hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {TIER_CHIPS.map((c) => {
              const active = tierFilter === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => onTier(c.key)}
                  aria-pressed={active}
                  className={`rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wider transition-colors ${
                    active
                      ? "bg-foreground/10 text-foreground ring-1 ring-foreground/20"
                      : "bg-foreground/5 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={onToggleOffRoster}
            className="text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            {showOffRoster ? "Hide off-roster" : "Show off-roster"}
          </button>
        </div>
      </div>

      {/* Selection bar — makes the per-row checkboxes discoverable + summarises the roster */}
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground/70">
        <span
          aria-hidden
          className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border border-foreground/30"
        >
          <Check className="h-2.5 w-2.5" />
        </span>
        {rosterCount === 0 ? (
          <span>Tick a model to add it to your roster — the shortlist your agents read.</span>
        ) : (
          <span className="text-foreground/80">
            {rosterCount} {rosterCount === 1 ? "model" : "models"} selected for your roster
          </span>
        )}
        {rosterCount > 0 && (
          <button
            type="button"
            onClick={onClearRoster}
            className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Reset
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <div className="min-w-[900px]">
            {/* Header */}
            <div className="grid grid-cols-[34px_minmax(160px,2fr)_56px_96px_60px_60px_76px_minmax(72px,1fr)_56px_52px_56px] items-center gap-2 border-b border-border px-4 py-3 text-[11px] text-muted-foreground">
              <span className="text-muted-foreground/50">#</span>
              <SortHeader label="Model" k="name" sort={sort} onSort={onSort} />
              <SortHeader label="Tier" k="tier" sort={sort} onSort={onSort} />
              <SortHeader label="Price ($/M)" k="price" sort={sort} onSort={onSort} />
              <SortHeader label="Speed" k="speed" sort={sort} onSort={onSort} />
              <SortHeader
                label="Context"
                k="context"
                sort={sort}
                onSort={onSort}
                className="hidden md:flex"
              />
              <SortHeader
                label="Bench"
                k="aa"
                sort={sort}
                onSort={onSort}
                className="hidden md:flex"
              />
              <span className="text-muted-foreground">Sentiment</span>
              <SortHeader label="Usage" k="usage" sort={sort} onSort={onSort} />
              <span className="text-muted-foreground">Status</span>
              <span className="text-right text-muted-foreground">Roster</span>
            </div>

            {/* Rows */}
            <div className="divide-y divide-border/60">
              {rows.length === 0 ? (
                <div className="px-5 py-6 text-center text-[12px] text-muted-foreground">
                  No models match this filter.
                </div>
              ) : (
                rows.map((m, i) => (
                  <ModelRow
                    key={m.id}
                    rank={i + 1}
                    model={m}
                    inRoster={roster.inRoster(m.id)}
                    roster={roster}
                    onInspect={onInspect}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        {/* Footer — leaderboard deep-links */}
        {leaderboards.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-5 py-2.5 text-[10px] text-muted-foreground">
            <span className="uppercase tracking-wider text-muted-foreground/60">Leaderboards</span>
            {leaderboards.map((lb) => (
              <a
                key={lb.url}
                href={lb.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 transition-colors hover:text-foreground"
              >
                {lb.label}
                <ArrowUpRight className="h-2.5 w-2.5" />
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  className = "",
}: {
  label: string;
  k: ModelSortKey;
  sort: SortState | null;
  onSort: (key: ModelSortKey) => void;
  className?: string;
}) {
  const active = sort?.key === k;
  const caret = active ? (sort!.dir === "asc" ? "▲" : "▼") : "";
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      className={`inline-flex items-center gap-1 text-left transition-colors hover:text-foreground ${
        active ? "text-foreground" : "text-muted-foreground"
      } ${className}`}
    >
      {label}
      {caret && <span className="text-[9px] text-foreground">{caret}</span>}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────
//  ModelRow — one table row. .model-share-bar sentiment; live cells get an emerald underline-dot.
// ────────────────────────────────────────────────────────────────────────────────────────

function ModelRow({
  rank,
  model,
  inRoster,
  roster,
  onInspect,
}: {
  rank: number;
  model: ModelIntel;
  inRoster: boolean;
  roster: { toggle: (id: string) => void; inRoster: (id: string) => boolean };
  onInspect: (id: string) => void;
}) {
  const brand = resolveVendor(model.vendorKey, model.vendor);
  const medal = MEDAL[rank];
  const sentColor = SENTIMENT_COLOR[model.sentiment.label];
  const sentPct = Math.round(Math.max(0, Math.min(1, model.sentiment.score)) * 100);
  const priceLive = model.liveFields.some((f) => f.startsWith("price"));
  const ctxLive = model.liveFields.includes("context");
  const status = STATUS_STYLE[model.status];
  const primaryBenchVal = model.benchmarks[model.primaryBench];
  const sweVal = model.benchmarks.sweBench;
  const dim = inRoster ? "" : "text-muted-foreground/50";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onInspect(model.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onInspect(model.id);
        }
      }}
      className={`grid cursor-pointer grid-cols-[34px_minmax(160px,2fr)_56px_96px_60px_60px_76px_minmax(72px,1fr)_56px_52px_56px] items-center gap-2 px-4 py-2.5 text-[12px] transition-colors hover:bg-foreground/[0.03] ${dim}`}
    >
      {/* Rank # — medal-tinted for the top 3 of the current ranking */}
      <span
        className="flex h-5 w-5 items-center justify-center rounded-md text-[11px] font-semibold tabular-nums"
        style={
          medal
            ? { background: `${medal}1f`, color: medal, boxShadow: `inset 0 0 0 1px ${medal}55` }
            : { color: "var(--muted-foreground)" }
        }
      >
        {rank}
      </span>

      {/* Model: logo + name + openrouterId chip */}
      <div className="flex min-w-0 items-center gap-2">
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/60"
          style={{ background: `#${brand.color}1a` }}
        >
          <VendorLogo vendorKey={model.vendorKey} vendorName={model.vendor} size={15} />
        </div>
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground/90">{model.name}</div>
          {model.openrouterId && (
            <span className="mt-0.5 inline-block max-w-full truncate rounded-md border border-white/10 bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {model.openrouterId}
            </span>
          )}
        </div>
      </div>

      {/* Tier */}
      <span className="text-[11px] text-muted-foreground">{formatTier(model.tier)}</span>

      {/* Price — in/out on top, 3:1 blended $/M underneath */}
      <span className="tabular-nums leading-tight">
        <LiveValue live={priceLive}>
          {model.price.inputPerM != null && model.price.outputPerM != null
            ? `${formatPrice(model.price.inputPerM)}/${formatPrice(model.price.outputPerM)}`
            : formatBlendedPrice(model.price)}
        </LiveValue>
        {model.price.inputPerM != null &&
          model.price.outputPerM != null &&
          blendedPrice(model.price) != null && (
            <span className="block text-[9.5px] text-muted-foreground/55">
              ≈{formatPrice(blendedPrice(model.price))} blend
            </span>
          )}
      </span>

      {/* Speed */}
      <span className="tabular-nums text-muted-foreground">
        {model.speedTps != null ? `${Math.round(model.speedTps)}` : "—"}
      </span>

      {/* Context (md+) */}
      <span className="hidden tabular-nums text-muted-foreground md:inline">
        <LiveValue live={ctxLive}>{formatContext(model.context)}</LiveValue>
      </span>

      {/* Bench: AA / SWE (md+) */}
      <span className="hidden tabular-nums text-muted-foreground md:inline">
        {primaryBenchVal != null ? primaryBenchVal : "—"}
        {sweVal != null && <span className="text-muted-foreground/60"> · {sweVal}</span>}
      </span>

      {/* Sentiment bar (collapses to a dot under md) */}
      <span className="flex items-center">
        <span className="hidden h-1.5 w-full overflow-hidden rounded-full bg-muted/40 md:block">
          <span
            className={
              inRoster ? "model-share-bar block h-full rounded-full" : "block h-full rounded-full"
            }
            style={{
              width: `${sentPct}%`,
              background: inRoster ? undefined : sentColor,
              ["--bar-color" as string]: sentColor,
              ["--bar-color-soft" as string]: `${sentColor}66`,
            }}
          />
        </span>
        <span
          aria-hidden
          className="h-2 w-2 rounded-full md:hidden"
          style={{ background: sentColor }}
          title={model.sentiment.label}
        />
      </span>

      {/* Usage — curated OpenRouter usage rank (1 = most tokens) */}
      <span
        className="tabular-nums text-muted-foreground"
        title="OpenRouter usage rank (snapshot) — lower = more used"
      >
        {model.popularity != null ? (
          <span className="inline-flex items-center rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[11px] font-medium text-foreground/80">
            #{model.popularity}
          </span>
        ) : (
          "—"
        )}
      </span>

      {/* Status pill */}
      <span>
        <span
          className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${status.cls}`}
        >
          {status.label}
        </span>
      </span>

      {/* Roster toggle */}
      <span className="flex justify-end">
        <RosterToggle
          id={model.id}
          inRoster={inRoster}
          color={brand.color}
          onToggle={roster.toggle}
        />
      </span>
    </div>
  );
}

/** Live-sourced cell wrapper — a faint emerald underline-dot when the value came from OpenRouter. */
function LiveValue({ live, children }: { live: boolean; children: ReactNode }) {
  if (!live) return <>{children}</>;
  return (
    <span className="relative inline-flex items-center gap-1">
      {children}
      <span
        aria-hidden
        className="h-1 w-1 rounded-full"
        style={{ background: "#3ddc97", boxShadow: "0 0 5px #3ddc97" }}
        title="live from OpenRouter"
      />
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────
//  RosterToggle — tiny pin-switch. ON = vendor-tinted glowing dot; OFF = hollow.
// ────────────────────────────────────────────────────────────────────────────────────────

function RosterToggle({
  id,
  inRoster,
  color,
  onToggle,
}: {
  id: string;
  inRoster: boolean;
  color: string;
  onToggle: (id: string) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={inRoster}
      title={inRoster ? "In your roster — click to remove" : "Add to your roster"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(id);
      }}
      className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border transition-all hover:scale-110"
      style={
        inRoster
          ? { background: `#${color}`, borderColor: `#${color}`, boxShadow: `0 0 8px #${color}66` }
          : { background: "transparent", borderColor: "rgba(255,255,255,0.22)" }
      }
    >
      {inRoster && <Check className="h-3 w-3" strokeWidth={3} style={{ color: "#0b0e13" }} />}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────
//  InspectDrawer — detail card, in place. Height/opacity transition, no modal, Esc closes.
// ────────────────────────────────────────────────────────────────────────────────────────

function InspectDrawer({
  model,
  curatedAsOf,
  leaderboards,
  onClose,
  onCopyOne,
}: {
  model: ModelIntel;
  curatedAsOf: string;
  leaderboards: { label: string; url: string }[];
  onClose: () => void;
  onCopyOne: () => void;
}) {
  const brand = resolveVendor(model.vendorKey, model.vendor);
  const primaryBenchVal = model.benchmarks[model.primaryBench];

  return (
    <div
      className="group relative mt-4 overflow-hidden rounded-2xl border border-border bg-card"
      style={{
        backgroundImage: `radial-gradient(120% 80% at 0% 0%, #${brand.color}1f, transparent 60%)`,
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 -right-16 h-40 w-40 rounded-full opacity-30 blur-3xl"
        style={{ background: `#${brand.color}` }}
      />

      <button
        type="button"
        onClick={onClose}
        aria-label="Close detail"
        className="absolute right-3 top-3 z-10 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      <div className="relative grid grid-cols-1 gap-6 p-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        {/* Left: identity + headline numbers */}
        <div>
          <div className="flex items-center gap-3">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border/70"
              style={{ background: `#${brand.color}1a` }}
            >
              <VendorLogo vendorKey={model.vendorKey} vendorName={model.vendor} size={24} />
            </div>
            <div className="min-w-0">
              <div className="text-[15px] font-semibold leading-tight">{model.name}</div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {model.vendor} · {formatTier(model.tier)}
              </div>
            </div>
          </div>

          <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">{model.oneLiner}</p>

          <div className="mt-4 grid grid-cols-3 gap-2">
            <HeadlineNum label="Price" value={formatBlendedPrice(model.price)} sub="blended /M" />
            <HeadlineNum label="Speed" value={formatSpeed(model.speedTps)} />
            <HeadlineNum label="Context" value={formatContext(model.context)} />
          </div>

          {/* Benchmarks + provenance */}
          <div className="mt-4 rounded-lg border border-border/60 bg-black/20 p-3">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
              <span>
                AA <span className="text-foreground/90">{model.benchmarks.aaIndex ?? "—"}</span>
              </span>
              <span>
                Elo <span className="text-foreground/90">{model.benchmarks.lmarenaElo ?? "—"}</span>
              </span>
              <span>
                SWE{" "}
                <span className="text-foreground/90">
                  {model.benchmarks.sweBench != null ? `${model.benchmarks.sweBench}%` : "—"}
                </span>
              </span>
              {primaryBenchVal != null && (
                <span className="text-muted-foreground/60">primary: {model.primaryBench}</span>
              )}
            </div>
            {curatedAsOf && (
              <div className="mt-1.5 text-[10px] text-muted-foreground/60">
                benchmarks &amp; sentiment as of {curatedAsOf}
              </div>
            )}
          </div>
        </div>

        {/* Middle: Loved / Gripes + Best-for / Avoid-for chips */}
        <div className="space-y-4">
          <DotList title="Loved" items={model.sentiment.loved} dot="#3ddc97" />
          <DotList title="Gripes" items={model.sentiment.gripes} dot="#f5b14c" />

          <div>
            <div className="mb-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Best for
            </div>
            <div className="flex flex-wrap gap-1.5">
              {model.bestFor.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-400"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
          {model.avoidFor.length > 0 && (
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Avoid for
              </div>
              <div className="flex flex-wrap gap-1.5">
                {model.avoidFor.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-400"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: pro usage + deep links */}
        <div className="space-y-3">
          <div className="rounded-lg border border-violet-500/20 bg-violet-500/10 p-3">
            <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-violet-300">
              How pros use it
            </div>
            <p className="text-[11px] leading-relaxed text-foreground/80">{model.proUsage}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <DeepLink href={model.links.openrouter} label="OpenRouter" />
            <DeepLink href={model.links.vendor} label="Vendor docs" />
            <DeepLink href={model.links.leaderboard} label="Leaderboard" />
            {leaderboards.slice(0, 2).map((lb) => (
              <DeepLink key={lb.url} href={lb.url} label={lb.label} muted />
            ))}
          </div>

          <button
            type="button"
            onClick={onCopyOne}
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            <Copy className="h-3 w-3" />
            View in JSON
            <ArrowUpRight className="h-2.5 w-2.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function HeadlineNum({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-black/20 px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold tabular-nums leading-tight">{value}</div>
      {sub && <div className="text-[9px] text-muted-foreground/60">{sub}</div>}
    </div>
  );
}

function DotList({ title, items, dot }: { title: string; items: string[]; dot: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </div>
      <ul className="space-y-1">
        {items.map((it) => (
          <li
            key={it}
            className="flex items-start gap-2 text-[11px] leading-snug text-foreground/80"
          >
            <span
              aria-hidden
              className="mt-1.5 h-1 w-1 shrink-0 rounded-full"
              style={{ background: dot }}
            />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeepLink({ href, label, muted }: { href: string | null; label: string; muted?: boolean }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex items-center justify-between rounded-md border border-border/60 px-2.5 py-1.5 text-[11px] transition-colors hover:border-foreground/30 hover:bg-foreground/5 ${
        muted ? "text-muted-foreground" : "text-foreground/80"
      }`}
    >
      {label}
      <ArrowUpRight className="h-3 w-3" />
    </a>
  );
}
