import { createFileRoute } from "@tanstack/react-router";
import {
  memorySignals,
  memorySources,
  memoryEvents,
  memoryStats,
  workspaces,
  type MemorySource,
} from "@/lib/mock-data";
import { useLiveData } from "@/lib/use-live-data";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { FileText, AlertTriangle, RefreshCw, X, Pencil, Cloud, Search, Copy, Check, Maximize2, Loader2, Sparkles } from "lucide-react";
import { MemoryBrain } from "@/components/memory-brain";
import type { MemNode } from "@/components/memory-graph-3d";
import { MemoryGraphLoader } from "@/components/memory-graph-loader";
import { KnowledgeExplorer, type KnowledgeGraph } from "@/components/knowledge-explorer";
import { knowledgeDemo } from "@/lib/mock-data";
import claudeLogoPng from "@/assets/claude-logo.png";
import obsidianLogoSvg from "@/assets/logos/obsidian.svg";
import pineconeIconSvg from "@/assets/logos/pinecone-icon.svg";

const MemoryGraph3D = lazy(() => import("@/components/memory-graph-3d"));

export const Route = createFileRoute("/memory")({
  // ?focus=<query> — voice/text can deep-link the Memory brain to a topic:
  // the graph flies to the matching cluster and the results panel opens.
  validateSearch: (search: Record<string, unknown>): { focus?: string } => ({
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Memory — Claude Code OS" },
      {
        name: "description",
        content: "Interactive 3D map of CLAUDE.md files, decisions, and shared memory.",
      },
    ],
  }),
  component: MemoryPage,
});

const ACCENT = "oklch(0.72 0.17 155)";

const BASE_SOURCES = ["obsidian", "claude"] as const;
const PINECONE_SOURCES = ["obsidian", "claude", "pinecone"] as const;
type SourceId = "obsidian" | "claude" | "pinecone";

function MemoryPage() {
  const [selected, setSelected] = useState<MemNode | null>(null);
  const [brainOpen, setBrainOpen] = useState(false);
  const [activityQuery, setActivityQuery] = useState("");
  // Voice/text "pull up my X" deep-links here as ?focus=X. We mirror it into
  // state so the graph fly + explorer focus fire on arrival AND whenever the
  // query changes, then strip it from the URL so a manual reload is clean.
  const routeSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const [focusQuery, setFocusQuery] = useState<string>("");
  const [focusNonce, setFocusNonce] = useState(0);
  useEffect(() => {
    const f = (routeSearch?.focus ?? "").trim();
    if (!f) return;
    setFocusQuery(f);
    setFocusNonce((n) => n + 1);
    // Voice "pull up my X" → land in the immersive Brain, not just the page.
    setBrainOpen(true);
    // strip ?focus= from the URL (keep the state) so refresh doesn't re-fire.
    void navigate({ search: (prev: any) => ({ ...prev, focus: undefined }), replace: true });
  }, [routeSearch?.focus, navigate]);
  const liveData = useLiveData();
  const ld = liveData as any;
  const hasPinecone = (ld?.memory?.stats?.pineconeIndexes ?? 0) > 0 || ld?.detection?.memoryStores?.pinecone?.hasKey === true;
  const ALL_SOURCES = hasPinecone ? PINECONE_SOURCES : BASE_SOURCES;
  // Multi-select set. Empty set = nothing selected (graph empty).
  // All three present = "All" (everything visible).
  const [activeSet, setActiveSet] = useState<Set<SourceId>>(() => new Set<SourceId>(ALL_SOURCES));
  const isDemo = ld?.isExample === true;
  // Prefer the aggregator's totals; fall back to a sum of mock workspaces so
  // a cold-start clone (live-data.example.json) still renders a meaningful
  // header instead of "0 files indexed".
  const totalFiles =
    Number.isFinite(ld?.memory?.stats?.totalFiles) && ld.memory.stats.totalFiles > 0
      ? ld.memory.stats.totalFiles
      : workspaces.reduce((a, w) => a + w.memoryFiles.length, 0);
  const totalWorkspaces =
    Number.isFinite(ld?.memory?.stats?.totalWorkspaces) && ld.memory.stats.totalWorkspaces > 0
      ? ld.memory.stats.totalWorkspaces
      : workspaces.length;
  const vectorIndexCount = Number.isFinite(ld?.memory?.stats?.pineconeIndexes)
    ? ld.memory.stats.pineconeIndexes
    : memorySources.filter((s) => s.kind === "vector").length;

  const allOn = ALL_SOURCES.every((s) => activeSet.has(s));
  // Pass a single id to the graph: if all three are selected we send "all"
  // (no filter), otherwise we union the matching nodes.
  const matchesActive = (sourceTag: string | undefined, kind?: string) => {
    if (allOn) return true;
    if (activeSet.size === 0) return false;
    if (kind === "vector_store" && activeSet.has("pinecone")) return true;
    if (sourceTag === "pinecone" && activeSet.has("pinecone")) return true;
    if (sourceTag === "obsidian" && activeSet.has("obsidian")) return true;
    if (sourceTag === "claude" && activeSet.has("claude")) return true;
    return false;
  };

  const toggleSource = (id: SourceId | "all") => {
    setActiveSet((prev) => {
      if (id === "all") {
        // Clicking "All" snaps to everything on (or back to everything if it
        // was already all on — same end state, idempotent).
        return new Set(ALL_SOURCES);
      }
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // The graph still wants a single string. We compose one based on the set:
  // - all 3 → "all"
  // - 1 → that id
  // - 0 or 2 → use a synthetic id and rely on the graph's union via matchesActive
  const graphFilter = (() => {
    if (allOn) return "all";
    if (activeSet.size === 1) return [...activeSet][0];
    return `multi:${[...activeSet].sort().join(",")}`;
  })();

  // Knowledge graphs — one per Obsidian vault, emitted by the aggregator.
  // A cold-start clone (no live data) gets the bundled demo graph instead.
  const liveGraphs: KnowledgeGraph[] = Array.isArray(ld?.memory?.knowledge?.graphs)
    ? ld.memory.knowledge.graphs.filter((g: KnowledgeGraph) => g?.notes?.length > 0)
    : [];
  const knowledgeIsDemo = liveGraphs.length === 0;
  const knowledgeGraphs = knowledgeIsDemo ? [knowledgeDemo as KnowledgeGraph] : liveGraphs;

  // Use real aggregator events when available, else fall back to the mock
  // event feed shipped with the example file.
  const sourceEvents: typeof memoryEvents =
    Array.isArray(ld?.memory?.events) && ld.memory.events.length > 0
      ? ld.memory.events
      : memoryEvents;

  const visibleEvents = useMemo(() => {
    if (allOn) return sourceEvents;
    const filtered = sourceEvents.filter((e: any) => matchesActive(e.source));
    return filtered.length ? filtered : sourceEvents;
  }, [activeSet, sourceEvents]);

  // Free-text search across the (already source-filtered) activity feed.
  // Matches event type, target, destination and source so the user can find a
  // specific memory event instead of being stuck with the silently-truncated
  // top-8 list. Empty query = no filtering (identity).
  const activityResults = useMemo(() => {
    const q = activityQuery.trim().toLowerCase();
    if (!q) return visibleEvents;
    return visibleEvents.filter((e) =>
      [e.type, e.target, e.destination, e.source]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q)),
    );
  }, [activityQuery, visibleEvents]);

  // Stale + missing — prefer aggregator output.
  const staleList: { name: string; updated: string }[] =
    Array.isArray(ld?.memory?.staleFiles) && ld.memory.staleFiles.length > 0
      ? ld.memory.staleFiles.map((f: any) => ({ name: f.name, updated: f.updated ?? "—" }))
      : memorySignals.stale;
  const missingList: string[] =
    Array.isArray(ld?.memory?.missing) && ld.memory.missing.length > 0
      ? ld.memory.missing
      : memorySignals.missing;
  // Conflicts aren't yet emitted by the aggregator — show only mock data
  // when we're running off the example file.
  const conflictsList = isDemo ? memorySignals.conflicts : [];

  // Recompute stat counts based on filter — driven by live data so toggling
  // actually changes what's shown below the graph. Aggregator stats are the
  // source of truth; mock fallbacks are only used in demo mode.
  const tiles = useMemo(() => {
    const memNodes = liveData?.memory?.nodes ?? [];
    const stats = liveData?.memory?.stats ?? {};
    const liveActive = Number.isFinite(stats?.activeLast7d)
      ? stats.activeLast7d
      : isDemo
        ? memoryStats.activeLast7d
        : 0;
    const liveActivated = Number.isFinite(stats?.activatedLast7d)
      ? stats.activatedLast7d
      : isDemo
        ? memoryStats.activatedLast7d
        : 0;
    const liveMissing = Number.isFinite(stats?.missing)
      ? stats.missing
      : isDemo
        ? memoryStats.missing
        : 0;

    if (allOn) {
      return {
        active: liveActive,
        activated: liveActivated,
        // Count the REAL memory sources (obsidian + claude [+ pinecone]) — not a
        // hardcoded 3, which over-reported by 1 (it effectively counted the
        // "All" toggle as a source).
        sources: ALL_SOURCES.length,
        missing: liveMissing,
      };
    }

    const filtered = memNodes.filter((n: any) => matchesActive(n.source, n.kind));
    const fileCount = filtered.filter(
      (n: any) => n.kind === "file" || n.kind === "vector_store",
    ).length;
    const events = sourceEvents.filter((e: any) => matchesActive(e.source));
    const recallHits = events
      .filter((e: any) => e.type === "recall")
      .reduce((a: number, e: any) => a + (e.meta?.hits ?? 1), 0);

    const onlyPinecone = activeSet.size === 1 && activeSet.has("pinecone");
    if (onlyPinecone) {
      return {
        active: stats.pineconeIndexes ?? fileCount,
        activated: recallHits || 0,
        sources: stats.pineconeIndexes ?? 1,
        missing: 0,
      };
    }
    return {
      active: Math.max(0, fileCount),
      activated:
        recallHits || (isDemo ? Math.max(1, Math.round(memoryStats.activatedLast7d / 3)) : 0),
      sources: activeSet.size,
      missing: activeSet.has("claude") ? liveMissing : 0,
    };
  }, [activeSet, sourceEvents, isDemo]);

  return (
    <div className="max-w-[1400px]">
      <header className="flex items-end justify-between border-b border-border pb-9 mb-7">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground mb-3 inline-flex items-center gap-2">
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: "#3ddc97",
                boxShadow: "0 0 8px rgba(61, 220, 151, 0.7)",
              }}
            />
            <span>Memory graph</span>
            {isDemo && (
              <span
                title="Sample data shipped with the app. Run `bun run scripts/aggregate.ts` to populate with your real ~/.claude/ + Obsidian + Pinecone activity."
                className="px-1.5 py-0.5 rounded-full text-[9px] tracking-[0.18em] font-semibold"
                style={{
                  background: "rgba(251, 191, 36, 0.14)",
                  color: "#fbbf24",
                  border: "1px solid rgba(251, 191, 36, 0.3)",
                }}
              >
                DEMO DATA
              </span>
            )}
          </div>
          <h1 className="text-4xl md:text-5xl font-semibold tracking-tight leading-[1.05]">
            <span className="tabular-nums">{totalFiles}</span>{" "}
            <span className="text-muted-foreground/55 font-normal">files indexed</span>
          </h1>
          <p className="text-base text-muted-foreground mt-3 max-w-2xl leading-relaxed">
            Drag to rotate. Hover a node to trace its links. Click to inspect. The map clusters by
            workspace, then connects shared decisions and skills across them — your AI brain made
            visible.
          </p>
        </div>
      </header>

      {/* Semantic search — local vectors, no API key (scripts/local-embed.ts) */}
      <SemanticSearch />

      {/* Source filter pills */}
      <SourceFilter activeSet={activeSet} allOn={allOn} onToggle={toggleSource} />

      {/* Stat tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border rounded-xl overflow-hidden border border-border mb-8">
        <Tile
          label="Active"
          value={tiles.active}
          tooltip="Files you've worked on this week — your live working memory."
        />
        <Tile
          label="Activated"
          value={tiles.activated}
          tooltip="How often your memories have been pulled into a session. The most-activated memories are the ones doing real work."
        />
        <Tile
          label="Memory sources"
          value={tiles.sources}
          tooltip="Memory sources feeding this view. Toggle them above."
        />
        <Tile
          label="Missing"
          value={tiles.missing}
          tone="red"
          tooltip="Folders without an index — uncatalogued areas of your knowledge."
        />
      </div>

      <section className="rounded-xl border border-border bg-card overflow-hidden mb-10 relative">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-1">
              Memory graph · 3D
            </div>
            <div className="text-base font-semibold tracking-tight">
              {totalWorkspaces} workspaces · {totalFiles} memory files · {vectorIndexCount} vector
              indexes
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Single entry to full-screen memory. Voice lives INSIDE the Brain
                (the corner Oracle relocates in as its console), so there's one
                door here — no "enter" vs "talk" duplication. */}
            <button
              onClick={() => setBrainOpen(true)}
              className="inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-xs font-semibold transition-all shrink-0"
              style={{
                border: "1px solid rgba(61,220,151,0.5)",
                background: "linear-gradient(160deg, rgba(61,220,151,0.16), rgba(61,220,151,0.05))",
                color: "#3ddc97",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "0 0 22px -6px #3ddc97")}
              onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "none")}
              title="Enter the Brain — full-screen memory, click any cluster to grab it, talk to it hands-free"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              Enter the Brain
            </button>
            <Legend />
          </div>
        </div>

        <div
          className="relative rounded-lg overflow-hidden"
          style={{
            background:
              "radial-gradient(ellipse at 50% 40%, rgba(61,220,151,0.18) 0%, rgba(0,0,0,0.95) 55%, #000 100%), #000",
            boxShadow: "inset 0 0 160px rgba(61,220,151,0.08)",
          }}
        >
          {/* Unmount the page graph while the full-screen Brain is open — two
              live WebGL force-graphs at once tanked the frame rate. */}
          {brainOpen ? (
            <MemoryGraphLoader height={640} />
          ) : (
            <Suspense fallback={<MemoryGraphLoader height={640} />}>
              <MemoryGraph3D onSelect={setSelected} sourceFilter={graphFilter} focusQuery={focusQuery} focusNonce={focusNonce} />
            </Suspense>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border rounded-xl overflow-hidden border border-border">
        <Panel
          title="Recent activity"
          tone="ok"
          wide
          headerRight={
            <ActivitySearch
              value={activityQuery}
              onChange={setActivityQuery}
              shown={Math.min(activityResults.length, 8)}
              total={visibleEvents.length}
            />
          }
        >
          {activityResults.length > 0 ? (
            activityResults
              .slice(0, 8)
              .map((e, i) => <EventRow key={`${e.id}-${i}`} event={e} />)
          ) : (
            <li className="px-5 py-6 text-xs text-muted-foreground text-center">
              No activity matches “{activityQuery.trim()}”.
            </li>
          )}
        </Panel>
        <Panel title="Stale" tone="warn">
          {staleList.map((m, i) => (
            <Row key={`${m.name}-${i}`} left={m.name} right={m.updated} tone="amber" />
          ))}
        </Panel>
        <Panel title="Missing" tone="danger">
          {missingList.map((m, i) => (
            <Row key={`${m}-${i}`} left={m} right="missing" tone="red" />
          ))}
          {conflictsList.map((c) => (
            <Row key={c} left={c} right="conflict" tone="red" />
          ))}
        </Panel>
      </div>

      {/* Knowledge explorer — the relational layer: walk the vault's
          wikilink graph note-by-note like a knowledge base. */}
      <KnowledgeExplorer graphs={knowledgeGraphs} isDemo={knowledgeIsDemo} focusQuery={focusQuery} focusNonce={focusNonce} />

      {selected && <Inspector node={selected} onClose={() => setSelected(null)} />}
      {brainOpen && (
        <MemoryBrain
          graphs={knowledgeGraphs}
          isDemo={knowledgeIsDemo}
          hasPinecone={hasPinecone}
          focusQuery={focusQuery}
          focusNonce={focusNonce}
          onClose={() => setBrainOpen(false)}
        />
      )}
    </div>
  );
}

function SourceFilter({
  activeSet,
  allOn,
  onToggle,
}: {
  activeSet: Set<SourceId>;
  allOn: boolean;
  onToggle: (id: SourceId | "all") => void;
}) {
  const liveData = useLiveData();
  const pineconeCount = liveData?.memory?.stats?.pineconeIndexes ?? 0;
  type Pill = {
    id: SourceId | "all";
    label: string;
    sub?: string;
    logo?: string;
    /** Render the icon as a white silhouette via mask-image (use for monochrome SVGs) */
    mask?: boolean;
    color: string;
    tooltip: string;
  };
  const pills: Pill[] = [
    { id: "all", label: "All", color: "#9aa3b0", tooltip: "Show every memory layer" },
    {
      id: "obsidian",
      label: "Obsidian",
      logo: obsidianLogoSvg,
      color: "#7c3aed",
      tooltip: "Markdown notes from your Obsidian vault",
    },
    {
      id: "claude",
      label: "Local Claude",
      logo: claudeLogoPng,
      color: "#FF7A3D",
      tooltip: "MEMORY.md, CLAUDE.md and decisions across your workspaces",
    },
    ...(liveData?.memory?.stats?.pineconeIndexes > 0 || liveData?.detection?.memoryStores?.pinecone?.hasKey
      ? [{
          id: "pinecone" as const,
          label: "Pinecone",
          sub: pineconeCount ? `${pineconeCount} indexes` : undefined,
          logo: pineconeIconSvg,
          mask: true,
          color: "#22D3EE",
          tooltip: "Vector indexes — every Pinecone collection feeds this memory source",
        }]
      : []),
  ];

  return (
    <div className="mb-5 flex flex-wrap gap-2">
      {pills.map((p) => {
        const isActive = p.id === "all" ? allOn : activeSet.has(p.id);
        return (
          <button
            key={p.id}
            onClick={() => onToggle(p.id)}
            title={p.tooltip}
            className={`group inline-flex items-center gap-2 rounded-full border pl-1 pr-3.5 py-1 text-xs transition-all ${
              isActive
                ? "border-foreground/40 bg-foreground/[0.08] text-foreground shadow-sm"
                : "border-border/70 bg-card/40 text-muted-foreground hover:text-foreground hover:border-foreground/20"
            }`}
            style={
              isActive
                ? { boxShadow: `0 0 0 1px ${p.color}66, 0 6px 18px -10px ${p.color}` }
                : undefined
            }
          >
            <span
              className="h-6 w-6 rounded-full grid place-items-center shrink-0"
              style={{
                background: `${p.color}1f`,
                boxShadow: `inset 0 0 0 1px ${p.color}55`,
              }}
            >
              {p.id === "all" ? (
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: p.color }} />
              ) : p.mask && p.logo ? (
                <span
                  aria-hidden
                  className="h-3.5 w-3.5"
                  style={{
                    background: p.color,
                    WebkitMaskImage: `url(${p.logo})`,
                    maskImage: `url(${p.logo})`,
                    WebkitMaskSize: "contain",
                    maskSize: "contain",
                    WebkitMaskRepeat: "no-repeat",
                    maskRepeat: "no-repeat",
                    WebkitMaskPosition: "center",
                    maskPosition: "center",
                  }}
                />
              ) : (
                <img src={p.logo} alt="" className="h-3.5 w-3.5 object-contain" loading="lazy" />
              )}
            </span>
            <span className="font-medium">{p.label}</span>
            {p.sub && (
              <span className="text-[10px] tabular-nums text-muted-foreground/80">{p.sub}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

interface SearchResult {
  path: string;
  relPath: string;
  title: string;
  score: number;
  snippet: string;
}

/** "Search by meaning" over scripts/local-embed.ts's local vector index —
 *  no API key, nothing leaves the machine except the embedding model's
 *  one-time download. Hits /__local_search (vite.config.ts), which embeds
 *  the query with the same model + text-cleanup the index was built with. */
function SemanticSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalVectors, setTotalVectors] = useState<number | null>(null);
  const [openNote, setOpenNote] = useState<SearchResult | null>(null);

  const runSearch = async () => {
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    try {
      const tokRaw = await fetch("/__token").then((r) => r.json());
      const token = tokRaw?.token ?? tokRaw;
      const r = await fetch("/__local_search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-claude-os-token": token },
        body: JSON.stringify({ query: q, topK: 8 }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        setError(String(data?.error ?? `search failed (${r.status})`));
        setResults(null);
        return;
      }
      setResults(data.results ?? []);
      setTotalVectors(typeof data.totalVectors === "number" ? data.totalVectors : null);
    } catch (e: any) {
      setError(e?.message ?? "network error");
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden mb-6">
      <div className="px-6 pt-4">
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-1 inline-flex items-center gap-1.5">
          <Sparkles className="h-3 w-3" style={{ color: "#8be9c7" }} />
          Semantic search
        </div>
        <div className="text-xs text-muted-foreground mb-3">
          Search your notes by meaning, not filename — local, free, no API key.
          {totalVectors != null && (
            <span className="text-muted-foreground/60">
              {" "}
              · {totalVectors.toLocaleString()} notes indexed
            </span>
          )}
        </div>
      </div>
      <div className="px-6 pb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runSearch();
            }}
            placeholder='e.g. "what did we decide about the Picbois pricing"'
            aria-label="Semantic search across your memory vault"
            className="w-full rounded-full border border-border/70 bg-background/40 pl-10 pr-28 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-foreground/30"
          />
          <button
            onClick={() => void runSearch()}
            disabled={loading || !query.trim()}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all disabled:opacity-40"
            style={{
              border: "1px solid rgba(139,233,199,0.5)",
              background: "linear-gradient(160deg, rgba(139,233,199,0.16), rgba(139,233,199,0.05))",
              color: "#8be9c7",
            }}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            {loading ? "Searching…" : "Search"}
          </button>
        </div>

        {error && (
          <div className="mt-3 text-xs text-amber-500">
            {error.includes("embed:local") ? (
              <>
                No local vector index yet — run{" "}
                <code className="font-mono text-foreground/80">bun run embed:local</code> in the
                Terminal tab, then try again.
              </>
            ) : (
              error
            )}
          </div>
        )}

        {results && results.length > 0 && (
          <ul className="mt-4 divide-y divide-border border-t border-border">
            {results.map((r) => (
              <li key={r.path}>
                <button
                  onClick={() => setOpenNote(r)}
                  className="w-full text-left py-3 hover:bg-foreground/[0.03] transition-colors flex items-start gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground truncate">{r.title}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {r.snippet}
                    </div>
                    <div className="text-[10px] font-mono text-muted-foreground/50 mt-1 truncate">
                      {r.relPath}
                    </div>
                  </div>
                  <div
                    className="shrink-0 text-[10px] font-semibold tabular-nums rounded-full px-2 py-0.5 mt-0.5"
                    style={{ background: "rgba(139,233,199,0.12)", color: "#8be9c7" }}
                    title="Cosine similarity to your query"
                  >
                    {Math.round(r.score * 100)}%
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}

        {results && results.length === 0 && !error && (
          <div className="mt-4 text-xs text-muted-foreground text-center py-4">No matches.</div>
        )}
      </div>

      {openNote && <NotePreviewModal result={openNote} onClose={() => setOpenNote(null)} />}
    </section>
  );
}

function NotePreviewModal({ result, onClose }: { result: SearchResult; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/__memory_note?vault=&id=${encodeURIComponent(result.title)}`)
      .then((r) => r.json())
      .then((r) => {
        if (cancelled) return;
        setContent(r?.ok && typeof r.content === "string" ? r.content : result.snippet);
      })
      .catch(() => {
        if (!cancelled) setContent(result.snippet);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [result.title]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content ?? "");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard denied — button just doesn't confirm */
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-background/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-2xl max-h-[80vh] flex flex-col rounded-t-2xl md:rounded-2xl border border-border bg-card shadow-2xl m-0 md:m-6 animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-5 border-b border-border shrink-0">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-1">
              {Math.round(result.score * 100)}% match
            </div>
            <div className="text-base font-semibold tracking-tight truncate">{result.title}</div>
            <div className="text-[10px] font-mono text-muted-foreground/60 mt-0.5 truncate">
              {result.relPath}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => void copy()}
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors"
              style={{
                borderColor: copied ? "#3ddc97" : "rgba(255,255,255,0.14)",
                background: copied ? "rgba(61,220,151,0.12)" : "rgba(255,255,255,0.03)",
                color: copied ? "#3ddc97" : undefined,
              }}
              title="Copy this note to your clipboard"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="px-5 py-4 overflow-y-auto text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">
          {loading ? "Loading…" : content}
        </div>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
  tooltip,
}: {
  label: string;
  value: number | string;
  tone?: "red";
  tooltip: string;
}) {
  const c = tone === "red" ? "text-red-500" : "text-foreground";
  return (
    <div className="bg-card px-5 py-4" title={tooltip}>
      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums mt-1 ${c}`}>{value}</div>
    </div>
  );
}

function EventRow({ event: e }: { event: (typeof memoryEvents)[number] }) {
  const Icon = e.type === "edit" ? Pencil : e.type === "vectorize" ? Cloud : Search;
  const color = e.type === "edit" ? "#3ddc97" : e.type === "vectorize" ? "#a78bfa" : "#fbbf24";
  return (
    <li className="flex items-center justify-between gap-3 px-5 py-2.5 text-xs hover:bg-foreground/[0.03] transition-colors">
      <div className="flex items-center gap-2.5 min-w-0">
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-16 shrink-0">
          {e.type}
        </span>
        <span className="font-mono text-foreground/90 truncate">
          {e.target}
          {e.destination && <span className="text-muted-foreground"> → {e.destination}</span>}
        </span>
      </div>
      <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
        {e.time}
        {e.meta?.hits ? ` · ${e.meta.hits} hits` : ""}
      </span>
    </li>
  );
}

function Inspector({ node, onClose }: { node: MemNode; onClose: () => void }) {
  const ws = node.workspaceId ? workspaces.find((w) => w.id === node.workspaceId) : null;
  // Copy the node's content — the full file body if it resolves in an Obsidian
  // vault (via /__memory_note using the node name as the note id), else the
  // preview. This is the "click a node → grab it" beat from the reference.
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const copyable = node.kind === "file" || node.kind === "decision" || !!node.preview;
  const copyNode = async () => {
    setCopying(true);
    let content = node.preview ?? node.name ?? "";
    try {
      const r = await fetch(
        `/__memory_note?vault=&id=${encodeURIComponent((node.name ?? "").replace(/\.md$/i, ""))}`,
      ).then((res) => res.json());
      if (r?.ok && typeof r.content === "string" && r.content.length > 0) content = r.content;
    } catch { /* fall back to preview */ }
    let ok = false;
    try { await navigator.clipboard.writeText(content); ok = true; }
    catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = content; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch { /* give up */ }
    }
    setCopying(false);
    if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-background/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-lg rounded-t-2xl md:rounded-2xl border border-border bg-card shadow-2xl m-0 md:m-6 animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-5 border-b border-border">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-1">
              {node.kind === "hub"
                ? "Shared core"
                : node.kind === "workspace"
                  ? "Workspace memory"
                  : node.kind === "vector_store"
                    ? "Pinecone index"
                    : node.kind === "file"
                      ? "Note"
                      : node.kind}
            </div>
            <div className="text-base font-semibold tracking-tight">{node.name}</div>
            {node.kind === "workspace" && ws && (
              <div className="text-xs text-muted-foreground mt-0.5">
                {ws.memoryFiles.length} notes · last edited {node.updated ?? "—"}
              </div>
            )}
            {node.kind === "file" && (
              <div className="text-xs text-muted-foreground mt-0.5">
                {node.size ?? "—"} · last edited {node.updated ?? "—"}
              </div>
            )}
            {node.kind === "vector_store" && (
              <div className="text-xs text-muted-foreground mt-0.5">
                {node.vectorCount?.toLocaleString() ?? "—"} vectors ·{" "}
                {Array.isArray(node.namespaces) ? node.namespaces.length : (node.namespaces ?? "—")}{" "}
                namespaces
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {copyable && (
              <button
                onClick={() => void copyNode()}
                disabled={copying}
                className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-50"
                style={{
                  borderColor: copied ? "#3ddc97" : "rgba(255,255,255,0.14)",
                  background: copied ? "rgba(61,220,151,0.12)" : "rgba(255,255,255,0.03)",
                  color: copied ? "#3ddc97" : undefined,
                }}
                title="Copy this memory to your clipboard"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : copying ? "Reading…" : "Copy"}
              </button>
            )}
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {node.kind === "file" && node.preview && (
          <div className="px-5 py-4 border-b border-border">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-1.5">
              Preview
            </div>
            <p className="text-sm italic text-foreground/80 leading-relaxed">"{node.preview}"</p>
          </div>
        )}

        {node.kind === "vector_store" && (
          <div className="p-5 space-y-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Index details
            </div>
            <ul className="space-y-1.5 text-xs">
              <li className="flex justify-between">
                <span className="text-muted-foreground">Embedding</span>
                <span className="font-mono text-foreground/90">
                  Pinecone · {node.dimension ?? 1024}-dim cosine
                </span>
              </li>
              <li className="flex justify-between">
                <span className="text-muted-foreground">Namespaces</span>
                <span className="tabular-nums">{Array.isArray(node.namespaces) ? node.namespaces.length : (node.namespaces ?? "—")}</span>
              </li>
              <li className="flex justify-between">
                <span className="text-muted-foreground">Total vectors</span>
                <span className="tabular-nums">{node.vectorCount?.toLocaleString() ?? "—"}</span>
              </li>
            </ul>
            {Array.isArray(node.namespaces) && node.namespaces.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border">
                <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2">Namespace breakdown</div>
                <ul className="space-y-1">
                  {node.namespaces.map((ns: any) => (
                    <li key={ns.name} className="flex justify-between text-xs">
                      <span className="font-mono text-foreground/90">{ns.name}</span>
                      <span className="tabular-nums text-muted-foreground">{ns.vectorCount?.toLocaleString?.()} vectors</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {ws && node.kind === "workspace" && (
          <div className="p-5 space-y-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Notes
            </div>
            <ul className="space-y-1.5">
              {ws.memoryFiles.map((f) => (
                <li key={f.name} className="flex items-center justify-between text-xs">
                  <span className="font-mono text-foreground/90">{f.name}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {f.size} · {f.updated}
                  </span>
                </li>
              ))}
            </ul>
            {node.status === "missing" && (
              <div className="pt-2 border-t border-border text-xs text-amber-500">
                Suggested: add a MEMORY.md to make this workspace discoverable.
              </div>
            )}
            <div className="pt-2 border-t border-border text-xs text-muted-foreground">
              Path: <span className="font-mono text-foreground/80">{ws.path}</span>
            </div>
          </div>
        )}

        {node.kind === "hub" && (
          <div className="p-5 text-sm text-muted-foreground">
            The shared index aggregates CLAUDE.md, decisions, and session summaries across{" "}
            {workspaces.length} workspaces and{" "}
            {memorySources.filter((s) => s.kind === "vector").length} Pinecone indexes.
          </div>
        )}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="hidden md:flex items-center gap-4 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: ACCENT }} /> Core
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-foreground/70" /> Workspace
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#a78bfa" }} /> Vector index
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Stale
      </span>
    </div>
  );
}

function Panel({
  title,
  children,
  tone,
  wide,
  headerRight,
}: {
  title: string;
  children: React.ReactNode;
  tone?: "ok" | "warn" | "danger";
  wide?: boolean;
  headerRight?: React.ReactNode;
}) {
  const Icon = tone === "warn" ? AlertTriangle : tone === "danger" ? FileText : RefreshCw;
  const c =
    tone === "warn"
      ? "text-amber-500"
      : tone === "danger"
        ? "text-red-500"
        : "text-muted-foreground";
  return (
    <div className={`bg-card ${wide ? "md:col-span-1" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className={`h-4 w-4 shrink-0 ${c}`} />
          <div className="text-sm font-semibold tracking-tight truncate">{title}</div>
        </div>
        {headerRight}
      </div>
      <ul className="divide-y divide-border">{children}</ul>
    </div>
  );
}

function ActivitySearch({
  value,
  onChange,
  shown,
  total,
}: {
  value: string;
  onChange: (v: string) => void;
  shown: number;
  total: number;
}) {
  const q = value.trim();
  return (
    <div className="flex items-center gap-2 shrink-0">
      {q && (
        <span className="text-[10px] tabular-nums text-muted-foreground/80">
          {shown}/{total}
        </span>
      )}
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Filter activity"
          aria-label="Filter recent memory activity"
          className="w-32 focus:w-40 transition-[width] rounded-full border border-border/70 bg-card/40 pl-7 pr-6 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-foreground/30"
        />
        {q && (
          <button
            onClick={() => onChange("")}
            aria-label="Clear activity filter"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ left, right, tone }: { left: string; right?: string; tone?: "amber" | "red" }) {
  const c =
    tone === "amber" ? "text-amber-500" : tone === "red" ? "text-red-500" : "text-muted-foreground";
  return (
    <li className="flex items-center justify-between gap-3 px-5 py-2.5 text-xs">
      <span className="font-mono text-foreground/90 truncate">{left}</span>
      {right && (
        <span className={`text-[10px] uppercase tracking-wider shrink-0 ${c}`}>{right}</span>
      )}
    </li>
  );
}
