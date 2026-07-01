import { createFileRoute, Link } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { Waypoints, Plus, Circle, Sparkles, Loader2, X, Info, Copy, Check } from "lucide-react";
import projectIndex from "@/data/graphs/index.json";
import { HermesChat, useHermesStatus } from "./agents.hermes";
import hermesPortrait from "@/assets/hermes-portrait.png";

const GraphifyGraph3D = lazy(() => import("@/components/graphify-graph-3d"));

// Static fallbacks (used before the live endpoints answer / if they're down)
const graphLoaders = import.meta.glob("/src/data/graphs/*.json");
function loaderFor(id: string): null | (() => Promise<any>) {
  const key = Object.keys(graphLoaders).find((k) => k.endsWith(`/${id}.json`));
  return key ? (graphLoaders[key] as () => Promise<any>) : null;
}
const idOf = (v: any) => (typeof v === "object" && v ? v.id : v);

export const Route = createFileRoute("/codegraph")({ component: CodeGraphPage });

// The paste-into-Hermes prompt that wires up the shared brain. A community
// member drops this into a fresh Hermes session once — it teaches Hermes
// where the registry lives and how to answer from it. Kept plain so it
// works regardless of model. {{REGISTRY}} is replaced with the live path.
const CONNECT_PROMPT = `You now have access to my Claude OS knowledge graphs via graphify.

The master registry of every project I've graphed lives at:
  {{REGISTRY}}

When I ask about "my projects", "the codebase", or any project by name:
1. Read that index.json first — each entry has a "graphPath" (the absolute path to that project's graph.json) plus name, language, node/edge counts, communities, and "godNodes" (the most-connected files).
2. To answer a question about a project, open its graphPath and reason from the real structure — or run graphify directly: \`graphify query "<question>"\`, \`graphify path "A" "B"\`, \`graphify explain "X"\`.
3. The "claude-os" entry is the operating system itself — use it to answer questions about Claude OS.

When I ask you to graph a NEW repo (one not already in the registry), register it through the dashboard so it appears in my gallery:
  bash ~/code/claude-os/scripts/graph-to-dashboard.sh <local-path-or-github-url>
That graphs it AND adds it to the registry in one step — it shows up in the dashboard within seconds. Don't run a bare \`graphify update\`; that won't reach the dashboard.

Ground every answer in this graph data. If something isn't in the graph, say so rather than guessing. Be concrete and concise.`;

type Project = {
  id: string;
  name: string;
  description: string;
  lang: string;
  color: string;
  nodeCount: number;
  edgeCount: number;
  communities: number;
  extractedPct: number;
  godNodes: { name: string; degree: number }[];
};

function CodeGraphPage() {
  const [projects, setProjects] = useState<Project[]>(projectIndex as Project[]);
  const [activeId, setActiveId] = useState<string | undefined>((projectIndex as Project[])[0]?.id);
  const [graph, setGraph] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<any>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [godExpanded, setGodExpanded] = useState(false);

  const [meta, setMeta] = useState<{ shown: number; total: number; capped: boolean } | null>(null);

  const active = useMemo(() => projects.find((p) => p.id === activeId) ?? projects[0], [projects, activeId]);
  const { data: hermesStatus, isLoading: hermesLoading } = useHermesStatus();

  // Live project list — polled every 8s so a project an AGENT registers
  // (Hermes/Claude running scripts/graph-to-dashboard.sh) appears in the
  // gallery automatically, no manual reload. Merge-only: we never clobber
  // the operator's current selection.
  useEffect(() => {
    let alive = true;
    const pull = () => {
      fetch("/__graphify_list")
        .then((r) => r.json())
        .then((d) => {
          if (!alive || !Array.isArray(d) || !d.length) return;
          setProjects((prev) => {
            // Only update if the set of ids actually changed (avoids
            // re-rendering / flicker on every poll).
            const a = prev.map((p) => p.id).join(",");
            const b = d.map((p: any) => p.id).join(",");
            return a === b ? prev : d;
          });
          setActiveId((cur) => (cur && d.some((p: any) => p.id === cur) ? cur : d[0].id));
        })
        .catch(() => {});
    };
    pull();
    const id = window.setInterval(pull, 8000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  // Load the active project's graph (live endpoint, fallback to bundled glob)
  useEffect(() => {
    if (!activeId) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setSelected(null);
    setPinnedId(null);
    setMeta(null);
    fetch(`/__graphify_graph?id=${encodeURIComponent(activeId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("http"))))
      .then((g) => {
        if (alive) {
          setGraph(g);
          setLoading(false);
        }
      })
      .catch(async () => {
        try {
          const ld = loaderFor(activeId);
          const m = ld ? await ld() : null;
          if (alive) {
            setGraph(m ? m.default ?? m : null);
            setLoading(false);
          }
        } catch {
          if (alive) {
            setGraph(null);
            setLoading(false);
          }
        }
      });
    return () => {
      alive = false;
    };
  }, [activeId]);

  // God nodes computed from the loaded graph (gives real ids → click-to-focus)
  const godNodes = useMemo(() => {
    if (!graph?.nodes) return (active?.godNodes ?? []).map((g) => ({ id: null as string | null, ...g }));
    const deg = new Map<string, number>();
    for (const l of graph.links ?? []) {
      deg.set(idOf(l.source), (deg.get(idOf(l.source)) ?? 0) + 1);
      deg.set(idOf(l.target), (deg.get(idOf(l.target)) ?? 0) + 1);
    }
    const lbl: Record<string, string> = {};
    for (const n of graph.nodes) lbl[n.id] = n.label || n.norm_label || n.id;
    return [...deg.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, degree]) => ({ id, name: lbl[id] ?? id, degree }));
  }, [graph, active]);
  const maxGodDeg = godNodes[0]?.degree || 1;


  function focusGod(g: { id: string | null; name: string; degree: number }) {
    if (!g.id) return;
    const node = (graph?.nodes ?? []).find((n: any) => n.id === g.id);
    setSelected(
      node
        ? { name: g.name, fileType: node.file_type, community: node.community, degree: g.degree, sourceFile: node.source_file, god: true, id: g.id }
        : { name: g.name, degree: g.degree, god: true, id: g.id },
    );
    setPinnedId(g.id);
  }

  if (!projects.length || !active) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        No projects ingested yet — use the <span className="text-foreground">Ingest a project</span> card.
      </div>
    );
  }

  const inferredPct = 100 - active.extractedPct;

  // FIXED per-session savings estimate (honest — not a live tracker we
  // can't verify). The graph lets an agent answer a structural question
  // from a compact summary instead of re-reading a chunk of the repo.
  //   per-question avoided read ≈ min(25% of files, 120) × ~400 tokens
  //   typical session ≈ 10 such questions
  //   $ at a conservative blended ~$3 / 1M input tokens
  const AVG_QUESTIONS_PER_SESSION = 10;
  const TOKEN_COST_PER_M = 3;
  const perQuestionTokens = useMemo(
    () => Math.round(Math.min(active.nodeCount * 0.25, 120) * 400),
    [active.nodeCount],
  );
  const sessionTokens = perQuestionTokens * AVG_QUESTIONS_PER_SESSION;
  const sessionDollars = (sessionTokens / 1_000_000) * TOKEN_COST_PER_M;

  // Starter questions — plain English, for a normal person (not the agent).
  // A mix of "understand it" + "do something with it". Short one-liners.
  const starterQuestions = useMemo(() => {
    return [
      `What does this project do?`,      // understand
      `How do I run it?`,                 // understand / practical
      `Give me a quick tour`,            // action — produces a walkthrough
      `Is anything broken or risky?`,    // action — produces findings
    ];
  }, [active]);

  // Build the chat seed: a compact, plain-language brief of the active
  // project's graph so Hermes answers grounded in THIS project's real
  // structure (god nodes = load-bearing files, clusters = modules).
  const seedContext = useMemo(() => {
    if (!active) return undefined;
    const gods = godNodes.filter((g) => g.name).slice(0, 8).map((g) => `${g.name} (${g.degree} links)`).join(", ");
    const gp = (active as any).graphPath as string | undefined;
    return [
      `You are helping me understand and work on the "${active.name}" project.`,
      active.description ? `Project: ${active.description}` : "",
      `Its knowledge graph (built by graphify, AST-based) has ${active.nodeCount.toLocaleString()} files, ${active.edgeCount.toLocaleString()} relationships, grouped into ${active.communities} clusters (≈ modules). ${active.extractedPct}% of edges are verified from code, the rest inferred.`,
      gods ? `The most-connected / load-bearing files are: ${gods}.` : "",
      gp ? `This project's graph.json is at: ${gp}` : "",
      `Answer by actually using graphify against that graph — read the graph.json above and/or run \`graphify query "<my question>" --graph ${gp ?? "<graphPath>"}\`, \`graphify explain "X" --graph …\`, or \`graphify path "A" "B" --graph …\`. Ground every answer in the real graph data (cite the files/clusters you found). Prefer one focused graphify call, then answer concisely.`,
    ].filter(Boolean).join("\n");
  }, [active, godNodes]);

  return (
    <div className="p-6 space-y-5">
      {/* Header — simple, clean title band (constellation/statue reverted). */}
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg border border-border/70 bg-card/60 p-2 shrink-0">
          <Waypoints className="h-5 w-5 text-foreground/80" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Knowledge Graph</h1>
          <p className="text-sm text-muted-foreground mt-0.5 max-w-3xl">
            Every codebase you work in, mapped by <span className="text-foreground/80">graphify</span> —
            files and the relationships between them, grouped into clusters. Pick a project, explore its
            structure, and ask Hermes about it below.
          </p>
        </div>
      </div>

      {/* Gallery: scrollable project strip + ingest card.
          min-w-0 on the scroller lets it shrink so the fixed-width
          ingest card never gets overlapped when the viewport is zoomed
          or narrow; py-1 gives the hover -translate-y room so cards
          don't clip at the top edge. */}
      <div className="flex gap-3 items-stretch min-w-0">
        <div className="flex gap-3 overflow-x-auto pb-1 pt-1 flex-1 min-w-0 [scrollbar-width:thin]">
          {projects.map((p) => {
            const isActive = p.id === activeId;
            return (
              <div
                key={p.id}
                onClick={() => setActiveId(p.id)}
                className={`group relative text-left rounded-xl border bg-card/40 backdrop-blur overflow-hidden transition-all shrink-0 w-[210px] cursor-pointer ${
                  isActive ? "-translate-y-0.5" : "border-border/60 hover:border-foreground/30 hover:-translate-y-0.5"
                }`}
                style={
                  isActive
                    ? // Active: tint the border with the project color + a soft
                      // outer glow. No ring (the ring was clipping the top
                      // accent bar); the border + glow read as "selected" and
                      // the top accent bar stays fully visible.
                      ({ borderColor: p.color, boxShadow: `0 8px 30px ${p.color}33, inset 0 0 0 1px ${p.color}` } as any)
                    : undefined
                }
              >
                <div className="h-1 w-full" style={{ background: p.color }} />
                {/* No manual remove — projects auto-prune when their graph
                    file is gone (handled on the backend list). */}
                <div className="p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm truncate">{p.name}</span>
                    <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border shrink-0" style={{ color: p.color, borderColor: `${p.color}55` }}>
                      {p.lang}
                    </span>
                  </div>
                  <div className="mt-1 text-[10px] text-muted-foreground/80 line-clamp-1">{p.description}</div>
                  <div className="mt-2 flex items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground">
                    <span className="text-foreground/90">{p.nodeCount.toLocaleString()}</span>files
                    <span className="opacity-40">·</span>
                    <span className="text-foreground/90">{p.communities}</span>clusters
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <IngestCard
          onIngested={(proj, all) => {
            setProjects(all);
            setActiveId(proj.id);
          }}
        />
      </div>

      {/* Hero graph + side rail */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4 items-start">
       <div className="space-y-4">
        <div
          className="rounded-2xl border bg-card/40 backdrop-blur overflow-hidden h-[620px] relative"
          style={{ borderColor: `${active.color}33`, boxShadow: `inset 0 0 120px ${active.color}10` }}
        >
          <div className="absolute top-4 left-4 z-10 rounded-xl border border-border/60 bg-black/70 backdrop-blur px-3 py-2 text-[11px] pointer-events-none">
            <div className="text-muted-foreground uppercase tracking-wider text-[9px] mb-0.5">Project</div>
            <div className="font-semibold text-foreground flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: active.color }} />
              {active.name}
            </div>
            <div className="text-muted-foreground mt-0.5">
              {active.nodeCount.toLocaleString()} files · {active.communities} clusters
            </div>
          </div>

          {loading || !graph ? (
            <div className="h-full flex items-center justify-center text-[12px] text-muted-foreground">
              <Circle className="h-3 w-3 mr-2 animate-pulse" style={{ color: active.color }} />
              Loading {active.name} graph…
            </div>
          ) : (
            <Suspense fallback={<div className="h-full flex items-center justify-center text-[12px] text-muted-foreground">Rendering…</div>}>
              <GraphifyGraph3D
                key={active.id}
                graph={graph}
                accent={active.color}
                pinnedId={pinnedId}
                onSelect={(n) => {
                  setSelected(n);
                  setPinnedId(n?.id ?? null);
                }}
                onMeta={setMeta}
              />
            </Suspense>
          )}
        </div>

        {/* Ask Hermes — the Hermes portrait on the left, plain-English
            question chips on the right. Clicking one prefills the chat. */}
        <div className="flex items-center gap-3 px-1">
          <div className="shrink-0 flex flex-col items-center gap-1">
            <div
              className="h-11 w-11 rounded-full overflow-hidden border"
              style={{ borderColor: `${active.color}66`, boxShadow: `0 0 16px ${active.color}33` }}
            >
              <img src={hermesPortrait} alt="Hermes" className="h-full w-full object-cover" />
            </div>
            <span className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/70">Ask</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 flex-1">
            {starterQuestions.map((q, i) => (
              <button
                key={i}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("hermes-chat-prefill", { detail: q }));
                  document.getElementById("kg-chat-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className="text-[12px] rounded-full border border-border/50 bg-background/40 hover:bg-background/70 hover:border-foreground/40 px-3 py-1.5 transition-colors text-foreground/85 whitespace-nowrap"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
       </div>

        {/* Side rail */}
        <div className="space-y-4">
          {/* Quick numbers */}
          <div className="grid grid-cols-3 gap-2">
            <MiniStat label="Files" value={active.nodeCount.toLocaleString()} sub="nodes" />
            <MiniStat label="Links" value={active.edgeCount.toLocaleString()} sub="relations" />
            <MiniStat label="Clusters" value={String(active.communities)} sub="≈ modules" />
          </div>

          {/* Map confidence — explains EXTRACTED vs INFERRED visually */}
          <div className="rounded-2xl border border-border/60 bg-card/40 backdrop-blur p-4">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80 mb-2">Map confidence</div>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-border/40">
              <div className="h-full" style={{ width: `${active.extractedPct}%`, background: "#3ddc97" }} />
              <div className="h-full" style={{ width: `${inferredPct}%`, background: "#a78bfa" }} />
            </div>
            <div className="mt-2 space-y-1 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-foreground/90">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#3ddc97" }} />
                  Found in code
                </span>
                <span className="tabular-nums text-muted-foreground">{active.extractedPct}%</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-foreground/90">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#a78bfa" }} />
                  Inferred (model's guess)
                </span>
                <span className="tabular-nums text-muted-foreground">{inferredPct}%</span>
              </div>
            </div>
            <div className="mt-2 text-[10px] text-muted-foreground/70 leading-snug">
              Higher "found in code" = more of the map is verified fact, not inference.
            </div>
          </div>

          {/* Most important files — top 3 by default, expand for the rest.
              Plain-language framing for non-engineers. */}
          <div className="rounded-2xl border border-border/60 bg-card/40 backdrop-blur p-4">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80 mb-1">
              <Sparkles className="h-3 w-3" /> Most important files
            </div>
            <div className="text-[10px] text-muted-foreground/60 mb-2.5 leading-snug">
              The files everything else relies on — the heart of the project. Click one to fly to it on the map.
            </div>
            <ol className="space-y-2">
              {(godExpanded ? godNodes : godNodes.slice(0, 3)).map((g, i) => {
                const isPinned = g.id && g.id === pinnedId;
                return (
                  <li key={i}>
                    <button
                      onClick={() => focusGod(g)}
                      disabled={!g.id}
                      className={`w-full text-left group ${g.id ? "cursor-pointer" : "cursor-default"}`}
                    >
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className={`truncate ${isPinned ? "text-foreground font-medium" : "text-foreground/90 group-hover:text-foreground"}`}>
                          <span className="text-muted-foreground/50 mr-1.5">{i + 1}.</span>
                          {g.name}
                        </span>
                        <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">{g.degree}</span>
                      </div>
                      <div className="mt-1 h-1 w-full rounded-full bg-border/40 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${Math.max(6, (g.degree / maxGodDeg) * 100)}%`, background: active.color, opacity: isPinned ? 1 : 0.6 }}
                        />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ol>
            {godNodes.length > 3 && (
              <button
                onClick={() => setGodExpanded((v) => !v)}
                className="mt-2.5 text-[10.5px] text-muted-foreground/70 hover:text-foreground transition-colors"
              >
                {godExpanded ? "Show less" : `Show ${godNodes.length - 3} more`}
              </button>
            )}
          </div>

          {/* Est. savings per session — a FIXED, honest ballpark (not a
              live tracker we can't verify). Sized to this project. */}
          <div
            className="rounded-2xl border bg-card/40 backdrop-blur p-4"
            style={{ borderColor: "#3ddc9740" }}
          >
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80 mb-1.5">
              Est. savings / session
              <span
                className="cursor-help text-muted-foreground/50 hover:text-foreground transition-colors"
                title={`A cautious estimate, not a billing figure.\n\nWithout the graph, each structural question makes an agent re-read a chunk of the codebase (opening + grepping files). With the graph it answers from the map instead.\n\nPer question ≈ min(25% of files, 120) × ~400 tokens — for ${active.name}, about ${perQuestionTokens.toLocaleString()} tokens.\nTypical session ≈ ${AVG_QUESTIONS_PER_SESSION} such questions = ~${sessionTokens.toLocaleString()} tokens.\n$ at a conservative ~$${TOKEN_COST_PER_M}/million input tokens.`}
              >
                <Info className="h-3 w-3" />
              </span>
            </div>
            <div className="flex items-end gap-2">
              <div className="text-2xl font-semibold tracking-tight tabular-nums" style={{ color: "#3ddc97" }}>
                ~${sessionDollars < 0.01 ? "0.01" : sessionDollars.toFixed(2)}
              </div>
              <div className="text-[11px] text-muted-foreground mb-1 tabular-nums">
                ~{sessionTokens >= 1000 ? `${(sessionTokens / 1000).toFixed(0)}k` : sessionTokens} tokens
              </div>
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground/65 leading-snug">
              Rough estimate for a ~{AVG_QUESTIONS_PER_SESSION}-question session on {active.name} — answering from the map instead of re-reading the codebase each time.
            </div>
          </div>

          {/* Selected node */}
          <div className="rounded-2xl border border-border/60 bg-card/40 backdrop-blur p-4 min-h-[96px]">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80 mb-2">
              <span>Selected</span>
              {pinnedId && (
                <button onClick={() => setPinnedId(null)} className="normal-case tracking-normal text-[10px] text-muted-foreground/60 hover:text-foreground">
                  clear
                </button>
              )}
            </div>
            {selected ? (
              <div className="space-y-1">
                <div className="text-sm font-medium text-foreground break-all">{selected.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {selected.fileType ?? "file"} · cluster {selected.community ?? "—"} · {selected.degree} links
                  {selected.god ? " · ★ god node" : ""}
                </div>
                {selected.sourceFile && (
                  <div className="text-[11px] text-muted-foreground/70 italic break-all">
                    {String(selected.sourceFile).replace(/^.*\/(?=[^/]+\/[^/]+$)/, "…/")}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[12px] text-muted-foreground/70">Click a node (or a god node) to inspect it.</div>
            )}
          </div>

          {meta?.capped && (
            <div className="text-[10px] text-muted-foreground/70 px-1">
              Large graph — rendering the densest {meta.shown.toLocaleString()} of {meta.total.toLocaleString()} files.
            </div>
          )}

        </div>
      </div>

      {/* Connect with Hermes — the paste-once prompt that wires a viewer's
          own Hermes into this shared brain. Collapsed by default. */}
      <ConnectHermesCard
        registryPath={
          ((active as any).graphPath as string | undefined)?.replace(/[^/]+$/, "index.json") ??
          "~/code/claude-os/src/data/graphs/index.json"
        }
        accent={active.color}
      />

      {/* Chat section header — makes the "ask Hermes about THIS project"
          link explicit and mirrors the project's accent color so the
          grounded-chat below reads as part of the same selection. */}
      <div id="kg-chat-anchor" className="flex items-center gap-3 pt-1 scroll-mt-4">
        <div
          className="h-8 w-1 rounded-full shrink-0"
          style={{ background: active.color }}
        />
        <div className="min-w-0">
          <div className="text-sm font-semibold tracking-tight flex items-center gap-2">
            Chat with{" "}
            <span style={{ color: active.color }}>{active.name}</span>
          </div>
          <div className="text-[11px] text-muted-foreground">
            Hermes is grounded in this project's structure — ask where things live, what connects to what, or what a change would touch.
          </div>
        </div>
      </div>

      {/* The exact Hermes chat from the Hermes section, reused here.
          Three states, ALL at the same min-height so the panel never
          renders short-then-tall as the status query resolves (that
          mount-race "snap" was the height bug):
            1. status still loading  → skeleton at full height
            2. installed             → the real chat
            3. not installed         → full-height click-through to setup */}
      {hermesLoading ? (
        <div className="rounded-2xl border border-border/60 bg-card/40 flex items-center justify-center min-h-[480px]">
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Connecting to Hermes…
          </div>
        </div>
      ) : hermesStatus?.installed ? (
        // No key={active.id} — remounting on every project switch reset the
        // chat height + wiped any typed message. Seed context flows via
        // props instead. min-h wrapper guarantees it never renders short.
        <div className="min-h-[480px]">
          <HermesChat
            status={hermesStatus}
            seedContext={seedContext}
            seedLabel={active.name}
            seedAccent={active.color}
            yolo
          />
        </div>
      ) : (
        <Link
          to="/agents/hermes"
          className="group rounded-2xl border border-dashed border-border/60 bg-card/30 hover:bg-card/50 hover:border-foreground/30 transition-colors flex flex-col items-center justify-center gap-3 text-center min-h-[480px] px-6"
        >
          <div className="rounded-full border border-border/60 bg-card/60 p-3 group-hover:scale-105 transition-transform">
            <Sparkles className="h-6 w-6 text-foreground/70" />
          </div>
          <div className="text-base font-medium text-foreground">Connect Hermes to chat with your graphs</div>
          <div className="text-sm text-muted-foreground max-w-md">
            Hermes Agent isn't set up yet. Once connected, you can ask questions about
            any project right here — grounded in its real structure.
          </div>
          <div className="mt-1 inline-flex items-center gap-1.5 text-[12px] font-medium text-foreground border border-foreground/30 rounded-lg px-3 py-1.5 group-hover:border-foreground/60 transition-colors">
            Set up Hermes →
          </div>
        </Link>
      )}
    </div>
  );
}

function IngestCard({ onIngested }: { onIngested: (proj: Project, all: Project[]) => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function ingest() {
    const p = path.trim();
    if (!p || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const tokRaw = await fetch("/__token").then((r) => r.json());
      const token = tokRaw?.token ?? tokRaw;
      if (typeof token !== "string") throw new Error("couldn't get auth token — restart the dev server");
      const r = await fetch("/__graphify_ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-claude-os-token": token },
        body: JSON.stringify({ path: p }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "ingest failed");
      setMsg({ kind: "ok", text: `✓ ${j.project.name} — ${j.project.nodeCount.toLocaleString()} files` });
      setPath("");
      onIngested(j.project, j.projects);
    } catch (e: any) {
      setMsg({ kind: "err", text: e.message || "ingest failed" });
    } finally {
      setBusy(false);
    }
  }

  const [open, setOpen] = useState(false);

  // Collapsed: a compact "+ Add a project" tile that matches the project
  // cards (same height, dashed to read as "new"). Click → expands in place
  // into the path input. This makes ingest feel like part of the gallery
  // system rather than a permanently-open form bolted to the side.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="group shrink-0 w-[150px] rounded-xl border border-dashed border-border/60 bg-card/20 hover:bg-card/40 hover:border-foreground/40 transition-all flex flex-col items-center justify-center gap-2 text-muted-foreground hover:text-foreground"
        title="Graph another repository"
      >
        <div className="rounded-full border border-border/60 bg-card/60 p-2 group-hover:scale-110 transition-transform">
          <Plus className="h-4 w-4" />
        </div>
        <div className="text-[11px] font-medium">Add a project</div>
        <div className="text-[9px] text-muted-foreground/60">graph a repo · $0</div>
      </button>
    );
  }

  return (
    <div className="rounded-xl border bg-card/40 backdrop-blur p-3 shrink-0 w-[270px] flex flex-col gap-2" style={{ borderColor: "#3ddc9755" }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground/90">
          <Waypoints className="h-3.5 w-3.5" style={{ color: "#3ddc97" }} /> Add a project
        </div>
        <button onClick={() => setOpen(false)} className="text-muted-foreground/60 hover:text-foreground" aria-label="Cancel">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <input
        autoFocus
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") ingest();
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="~/code/my-repo  or  https://github.com/user/repo"
        disabled={busy}
        className="w-full rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-[11px] outline-none focus:border-foreground/40 disabled:opacity-50"
      />
      <button
        onClick={ingest}
        disabled={busy || !path.trim()}
        className="flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium disabled:opacity-40 transition-colors"
        style={{ background: "#3ddc9722", color: "#3ddc97", border: "1px solid #3ddc9755" }}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Waypoints className="h-3 w-3" />}
        {busy ? "Graphing…" : "Graph it ($0)"}
      </button>
      {msg ? (
        <div className={`text-[10px] leading-snug ${msg.kind === "ok" ? "text-[#3ddc97]" : "text-[#ef5a5a]"}`}>{msg.text}</div>
      ) : (
        <div className="text-[9px] text-muted-foreground/55 leading-snug">
          Local path or GitHub URL → graphify (AST, source-only). Appears instantly.
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 backdrop-blur px-3 py-2.5">
      <div className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground/80">{label}</div>
      <div className="text-base font-semibold tracking-tight mt-0.5">{value}</div>
      {sub && <div className="text-[9px] text-muted-foreground/55 mt-0.5">{sub}</div>}
    </div>
  );
}

// Connect-with-Hermes — a collapsible card holding the paste-once prompt
// that wires a viewer's own Hermes into the shared graph registry. The
// {{REGISTRY}} token is filled with the live path so the copied prompt
// works on their machine as-is.
function ConnectHermesCard({ registryPath, accent }: { registryPath: string; accent: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const prompt = CONNECT_PROMPT.replace("{{REGISTRY}}", registryPath);

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = prompt;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="rounded-2xl border border-border/60 bg-card/40 backdrop-blur overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <img
            src={hermesPortrait}
            alt="Hermes"
            className="h-8 w-8 rounded-full object-cover shrink-0 border"
            style={{ borderColor: `${accent}66`, boxShadow: `0 0 14px ${accent}33` }}
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight">Connect with Hermes</div>
            <div className="text-[11px] text-muted-foreground truncate">
              Paste one prompt into your own Hermes to give it this shared brain.
            </div>
          </div>
        </div>
        <span className="text-[11px] text-muted-foreground shrink-0">{open ? "Hide" : "Show prompt"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-2">
          <div className="relative">
            <pre className="text-[11px] leading-relaxed whitespace-pre-wrap rounded-lg border border-border/50 bg-background/60 p-3 pr-12 max-h-64 overflow-y-auto text-foreground/85 font-mono">
{prompt}
            </pre>
            <button
              onClick={copy}
              className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors"
              style={{
                borderColor: copied ? "#3ddc9788" : "var(--border)",
                color: copied ? "#3ddc97" : undefined,
                background: copied ? "#3ddc9714" : "rgba(0,0,0,0.2)",
              }}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="text-[10px] text-muted-foreground/70 leading-snug">
            One-time setup. After pasting, ask Hermes anything about your projects —
            it reads the registry and answers from the real graph.
          </div>
        </div>
      )}
    </div>
  );
}
