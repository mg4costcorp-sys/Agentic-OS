// ── Memory Brain — the full-screen "second brain" workspace ─────────────────
// A cinematic full-screen mode where the 3D memory graph IS the canvas: every
// cluster is a body of knowledge (your Obsidian vault, Claude memories, Pinecone
// indexes), kept in good viewport so you can see it, rotate it, and click into
// it. Clicking a cluster raises an overlay card ON TOP of the graph where you
// read the document and grab it (copy) — the core "pull it up and take it" beat.
//
// Squaring the corner orb with full-screen: when the Brain opens it fires
// `brain:open`, and the globally-mounted FloatingOracle relocates from the
// bottom-right corner to a centered anchor at the base of this canvas, rising
// above the Brain — so the same voice engine becomes the Brain's own console
// instead of a widget clipping over the corner. No second engine, no rewrite.
//
// The graph is the hero; the memory LIST (KnowledgeExplorer) rides along as a
// collapsible glass rail so "all my memories in one place" is one tap away
// without shrinking the brain. Voice "pull up my X" and the in-canvas search
// both fly the graph to a cluster and light the list.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Mic, Copy, Check, Search, PanelRightClose, PanelRightOpen, CornerDownLeft } from "lucide-react";
import { KnowledgeExplorer, type KnowledgeGraph } from "@/components/knowledge-explorer";
import { MemoryGraphLoader } from "@/components/memory-graph-loader";
import { BrainConverse } from "@/components/brain-converse";
import type { MemNode } from "@/components/memory-graph-3d";

const BrainGraph3D = lazy(() => import("@/components/brain-graph-3d"));

const ACCENT = "#3ddc97";

export function MemoryBrain({
  graphs,
  isDemo,
  hasPinecone,
  focusQuery,
  focusNonce,
  onClose,
}: {
  graphs: KnowledgeGraph[];
  isDemo: boolean;
  hasPinecone?: boolean;
  focusQuery: string;
  focusNonce: number;
  onClose: () => void;
}) {
  // Node the user clicked in the graph → drives the "grab it" overlay.
  const [selected, setSelected] = useState<MemNode | null>(null);
  const selectedRef = useRef<MemNode | null>(null);
  selectedRef.current = selected;
  const [railOpen, setRailOpen] = useState(true);
  const [layer, setLayer] = useState<string>("all");
  const [searchText, setSearchText] = useState("");

  // Single focus (query, nonce) pair that drives BOTH the graph fly and the
  // list highlight. Seeded from the parent (voice "pull up my X" → ?focus=…),
  // and re-bumped by the in-canvas search box.
  const [focus, setFocus] = useState<{ q: string; n: number }>({ q: focusQuery || "", n: focusNonce || 0 });
  useEffect(() => {
    if (!focusQuery) return;
    setFocus((f) => ({ q: focusQuery, n: f.n + 1 }));
  }, [focusNonce, focusQuery]);
  const bumpFocus = (q: string) => { const t = q.trim(); if (t) setFocus((f) => ({ q: t, n: f.n + 1 })); };


  // Esc: close the grab-overlay first if it's up, else leave the Brain. Fire
  // brain:open/close so the corner Oracle relocates into (and back out of) here.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("brain:open"));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selectedRef.current) { setSelected(null); e.stopPropagation(); }
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.dispatchEvent(new CustomEvent("brain:close"));
    };
  }, [onClose]);

  // Layer pills mirror what's actually IN the brain: each vault by name, the
  // Claude memory layer, and Pinecone when connected.
  const layers: { id: string; label: string; color: string }[] = [
    { id: "all", label: "All", color: "#9aa3b0" },
    ...graphs.map((g) => ({ id: g.vault, label: g.vault, color: "#a78bfa" })),
    { id: "claude", label: "Claude", color: "#FF7A3D" },
    ...(hasPinecone ? [{ id: "pinecone", label: "Pinecone", color: "#22D3EE" }] : []),
  ];

  return createPortal(
    <div className="fixed inset-0 z-[9998] overflow-hidden" style={{ background: "#040706" }}>
      {/* THE CANVAS — the graph fills the whole screen; clusters stay in view */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 44%, rgba(61,220,151,0.15) 0%, rgba(0,0,0,0.96) 58%, #000 100%), #000",
        }}
      >
        <Suspense fallback={<MemoryGraphLoader height={typeof window !== "undefined" ? window.innerHeight : 800} />}>
          <BrainGraph3D
            graphs={graphs}
            hasPinecone={hasPinecone}
            onSelect={setSelected}
            sourceFilter={layer}
            focusQuery={focus.q}
            focusNonce={focus.n}
          />
        </Suspense>
      </div>

      {/* ── floating chrome (corners, not a bar — keeps the brain immersive) ── */}
      {/* top-left: identity + fly-to-cluster search */}
      <div className="absolute top-4 left-4 flex flex-col gap-2.5 max-w-[min(92vw,420px)]">
        <div
          className="inline-flex items-center gap-2.5 rounded-full px-3.5 py-2 backdrop-blur-md w-fit"
          style={{ background: "rgba(6,12,10,0.72)", border: `1px solid ${ACCENT}2e` }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: ACCENT, boxShadow: `0 0 8px ${ACCENT}` }} />
          <span className="text-sm font-semibold tracking-tight text-foreground">The Brain</span>
          <span className="text-[11px] text-muted-foreground hidden sm:inline">
            {isDemo ? "sample memory" : "your live memory"}
          </span>
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); bumpFocus(searchText); }}
          className="relative flex items-center rounded-full backdrop-blur-md overflow-hidden"
          style={{ background: "rgba(6,12,10,0.72)", border: `1px solid ${ACCENT}22` }}
        >
          <Search className="ml-3 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Fly to a cluster… (or say it)"
            className="bg-transparent px-2.5 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 outline-none w-[220px] max-w-[60vw]"
          />
          {searchText.trim() && (
            <button type="submit" title="Fly there" className="mr-1.5 grid place-items-center h-6 w-6 rounded-full shrink-0" style={{ background: `${ACCENT}1f`, color: ACCENT }}>
              <CornerDownLeft className="h-3 w-3" />
            </button>
          )}
        </form>
        <div className="text-[10.5px] leading-snug text-muted-foreground/80 pl-1 max-w-[300px]">
          Ask the console below, say <span style={{ color: ACCENT }}>"pull up my …"</span>, or click any cluster to open it and copy it.
        </div>
      </div>

      {/* top-right: layer filter + rail toggle + exit */}
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <div
          className="hidden md:flex items-center gap-1 rounded-full p-1 backdrop-blur-md"
          style={{ background: "rgba(6,12,10,0.72)", border: `1px solid ${ACCENT}22` }}
        >
          {layers.map((l) => {
            const active = layer === l.id;
            return (
              <button
                key={l.id}
                onClick={() => setLayer(l.id)}
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors"
                style={active
                  ? { background: `${l.color}1f`, color: "#fff", boxShadow: `inset 0 0 0 1px ${l.color}66` }
                  : { color: "rgba(255,255,255,0.55)" }}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: l.color }} />
                {l.label}
              </button>
            );
          })}
        </div>
        <button
          onClick={() => setRailOpen((v) => !v)}
          title={railOpen ? "Hide the memory list" : "Show all memories"}
          className="grid place-items-center h-9 w-9 rounded-full backdrop-blur-md text-muted-foreground hover:text-foreground transition-colors"
          style={{ background: "rgba(6,12,10,0.72)", border: `1px solid ${ACCENT}22` }}
        >
          {railOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </button>
        <button
          onClick={onClose}
          title="Exit the Brain (Esc)"
          className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold backdrop-blur-md text-muted-foreground hover:text-foreground transition-colors"
          style={{ background: "rgba(6,12,10,0.72)", border: "1px solid rgba(255,255,255,0.12)" }}
        >
          <X className="h-3.5 w-3.5" />
          Exit
        </button>
      </div>

      {/* right rail — "all my memories in one place", glass over the canvas so
          the graph keeps the full viewport behind it. Collapsible to a tab. */}
      <div
        className="absolute top-20 bottom-24 right-4 w-[360px] max-w-[86vw] rounded-2xl backdrop-blur-xl overflow-hidden flex flex-col transition-all duration-300"
        style={{
          background: "rgba(6,11,10,0.82)",
          border: `1px solid ${ACCENT}1f`,
          boxShadow: "0 30px 80px rgba(0,0,0,0.55)",
          transform: railOpen ? "translateX(0)" : "translateX(calc(100% + 1.25rem))",
          opacity: railOpen ? 1 : 0,
          pointerEvents: railOpen ? "auto" : "none",
        }}
      >
        <div className="px-4 pt-4 pb-1 shrink-0">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">All memories</div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3">
          {/* multi-term focuses ("a | b") come from the console — the list
              highlights on the first source; the graph lights the whole set */}
          <KnowledgeExplorer graphs={graphs} isDemo={isDemo} focusQuery={focus.q.split("|")[0].trim()} focusNonce={focus.n} />
        </div>
      </div>

      {/* the JARVIS console — converse with your memory from the base of the
          canvas. Questions and streamed answers fly the graph live; the cited
          sources light up and open as document overlays. */}
      <BrainConverse
        graphs={graphs}
        isDemo={isDemo}
        onFocus={bumpFocus}
        onOpenNode={(name) => {
          // Resolve the cited title to its real note (file id + vault) so the
          // overlay fetches the actual document; excerpt rides as fallback.
          const low = name.toLowerCase();
          let hit: { id: string; title: string; excerpt?: string; updated?: string } | null = null;
          let hitVault = "";
          for (const g of graphs) {
            const n = g.notes.find((x) => (x.title ?? "").toLowerCase() === low || (x.id ?? "").toLowerCase() === low);
            if (n) { hit = n; hitVault = g.vault; break; }
          }
          setSelected({
            id: `converse-${name}`,
            name: hit?.title ?? name,
            kind: "file",
            val: 5,
            color: "#8a93a3",
            preview: hit?.excerpt,
            updated: hit?.updated,
            ...(hit ? ({ noteId: hit.id, vault: hitVault } as any) : {}),
          } as MemNode);
        }}
      />

      {/* the "grab it" overlay — rises ON TOP of the graph (above the docked
          Oracle) with the full document and a big Copy. This is the beat. */}
      {selected && <BrainNote node={selected} onClose={() => setSelected(null)} />}
    </div>,
    document.body,
  );
}

// ── BrainNote — click a cluster, read it, take it ───────────────────────────
// Resolves the node's full document from the Obsidian vault (via /__memory_note
// using the node name as the note id) and copies it. Falls back to the node's
// preview when it's not a vault-backed file (workspace / index / hub node).
function BrainNote({ node, onClose }: { node: MemNode; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    // Console-cited sources carry the note's real file id + vault (titles and
    // basenames differ); graph-clicked nodes fall back to the display name.
    const id = (((node as any).noteId as string) ?? node.name ?? "").replace(/\.md$/i, "");
    const vault = ((node as any).vault as string) ?? "";
    if (!id) return;
    setLoading(true);
    fetch(`/__memory_note?vault=${encodeURIComponent(vault)}&id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((r) => { if (live && r?.ok && typeof r.content === "string" && r.content.length > 0) setContent(r.content); })
      .catch(() => { /* fall back to preview */ })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [node.name]);

  const body = content ?? node.preview ?? "";
  const copy = async () => {
    const text = body || node.name || "";
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; }
    catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch { /* give up */ }
    }
    if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
  };

  const kindLabel =
    node.kind === "hub" ? "Shared core"
    : node.kind === "workspace" ? "Workspace memory"
    : node.kind === "vector_store" ? "Pinecone index"
    : node.kind === "file" ? "Note"
    : node.kind === "decision" ? "Decision"
    : String(node.kind ?? "Memory");

  return (
    <div className="absolute inset-0 z-[10001] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-fade-in" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-xl rounded-2xl overflow-hidden flex flex-col animate-scale-in"
        style={{
          maxHeight: "min(78vh, 720px)",
          background: "rgba(8,14,12,0.96)",
          border: `1px solid ${ACCENT}33`,
          boxShadow: `0 40px 120px rgba(0,0,0,0.7), 0 0 60px -30px ${ACCENT}`,
        }}
      >
        <div className="flex items-start justify-between gap-3 p-5 border-b shrink-0" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-1">{kindLabel}</div>
            <div className="text-base font-semibold tracking-tight text-foreground truncate">{node.name}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {node.size ? `${node.size} · ` : ""}{node.updated ? `edited ${node.updated}` : loading ? "reading…" : "in your memory"}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => void copy()}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
              style={{
                background: copied ? `${ACCENT}1f` : `${ACCENT}14`,
                color: copied ? ACCENT : "#dfeee9",
                border: `1px solid ${copied ? ACCENT : `${ACCENT}44`}`,
              }}
              title="Copy this memory to your clipboard"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
            <button onClick={onClose} className="grid place-items-center h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5">
          {body ? (
            <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/85 font-sans">{body}</pre>
          ) : loading ? (
            <div className="text-sm text-muted-foreground italic">Reading the document…</div>
          ) : (
            <div className="text-sm text-muted-foreground">
              No document body for this node — it's a {kindLabel.toLowerCase()}. Open its cluster in the list to browse the notes inside.
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t shrink-0 flex items-center gap-2" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("oracle:activate", { detail: { voice: true } }))}
            className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            title="Ask the Oracle about this"
          >
            <Mic className="h-3 w-3" /> ask about this
          </button>
          <span className="ml-auto text-[10px] text-muted-foreground/60">Esc to close</span>
        </div>
      </div>
    </div>
  );
}
