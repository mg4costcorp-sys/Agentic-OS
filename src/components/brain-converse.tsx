/*
 * BrainConverse — the JARVIS console inside the full-screen Memory Brain.
 *
 * A conversational window docked at the base of the Brain: you ask a question,
 * Hermes answers FROM YOUR ACTUAL MEMORY (vault notes + Claude memory files),
 * and the graph behind the console reacts live — flying to the clusters the
 * conversation touches while the answer streams, then lighting every source
 * the answer actually drew from. Each source becomes a chip under the reply;
 * one tap raises the real document overlay (read it, copy it).
 *
 * The grounding contract: the prompt hands Hermes the user's real node names
 * and requires it to close every answer with `<<mem:Exact Node Name>>`
 * directives — one per source used. The console strips them from the visible
 * text, turns them into chips, and focuses the graph on the full set.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, CornerDownLeft, FileText, Loader2, Sparkles } from "lucide-react";
import type { KnowledgeGraph } from "@/components/knowledge-explorer";

const ACCENT = "#3ddc97";

type ConverseTurn = {
  who: "you" | "brain";
  text: string;
  sources?: string[];
};

// Directive contract Hermes closes each answer with.
const MEM_DIRECTIVE = /<<\s*mem\s*:\s*([^>]+?)\s*>>/g;

function stripDirectives(raw: string): { text: string; sources: string[] } {
  const sources: string[] = [];
  let m: RegExpExecArray | null;
  MEM_DIRECTIVE.lastIndex = 0;
  while ((m = MEM_DIRECTIVE.exec(raw)) !== null) {
    const name = m[1].trim();
    if (name && !sources.includes(name)) sources.push(name);
  }
  const text = raw.replace(MEM_DIRECTIVE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { text, sources: sources.slice(0, 6) };
}

// Drop CLI warning noise the same way the Oracle does.
function cleanReply(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*Warning:\s*(Unknown toolset|Unrecognized|Deprecat|No config)/i.test(l))
    .join("\n");
}

export function BrainConverse({
  graphs,
  isDemo,
  onFocus,
  onOpenNode,
}: {
  graphs: KnowledgeGraph[];
  isDemo: boolean;
  /** Fly the graph to (and glow) everything matching the query; "a | b" = set. */
  onFocus: (query: string) => void;
  /** Raise the document overlay for a memory by its node name. */
  onOpenNode: (name: string) => void;
}) {
  const [turns, setTurns] = useState<ConverseTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamTail, setStreamTail] = useState("");
  const [expanded, setExpanded] = useState(true);
  const sessionRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── the lexicon: every real node name in the user's memory ────────────────
  // Drives (a) instant graph-fly on the question, (b) live fly-bys while the
  // answer streams, and (c) the exact-name list handed to Hermes so its
  // <<mem:…>> citations land on real nodes.
  const lexicon = useMemo(() => {
    const names = new Set<string>();
    for (const g of graphs) for (const n of g.notes) {
      const t = (n.title || n.id || "").replace(/\.md$/i, "").trim();
      if (t.length >= 4) names.add(t);
    }
    return Array.from(names);
  }, [graphs]);
  const lexiconLower = useMemo(() => lexicon.map((n) => n.toLowerCase()), [lexicon]);

  // Find lexicon entries a piece of text mentions (substring either way for
  // short titles, title-in-text for long ones). Returns real node names.
  const matchLexicon = useCallback((text: string, cap = 4): string[] => {
    const low = text.toLowerCase();
    const words = low.split(/[^a-z0-9.-]+/).filter((w) => w.length >= 4);
    const hits: Array<{ name: string; score: number }> = [];
    for (let i = 0; i < lexicon.length; i++) {
      const title = lexiconLower[i];
      if (low.includes(title)) { hits.push({ name: lexicon[i], score: 100 + title.length }); continue; }
      const titleWords = title.split(/[^a-z0-9.-]+/).filter((w) => w.length >= 4);
      if (!titleWords.length) continue;
      const overlap = titleWords.filter((tw) => words.some((w) => w === tw || (tw.length > 5 && w.includes(tw)) || (w.length > 5 && tw.includes(w)))).length;
      if (overlap >= Math.min(2, titleWords.length)) hits.push({ name: lexicon[i], score: overlap / titleWords.length });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, cap).map((h) => h.name);
  }, [lexicon, lexiconLower]);

  // Live fly-bys while streaming: whenever the accumulating answer names new
  // memories, glide the camera there. Throttled so the flight stays cinematic.
  const flownRef = useRef<Set<string>>(new Set());
  const lastFlyRef = useRef(0);
  const flyForText = useCallback((accumulated: string) => {
    const now = performance.now();
    if (now - lastFlyRef.current < 2200) return;
    const found = matchLexicon(accumulated, 3).filter((n) => !flownRef.current.has(n));
    if (!found.length) return;
    found.forEach((n) => flownRef.current.add(n));
    lastFlyRef.current = now;
    onFocus(found.join(" | "));
  }, [matchLexicon, onFocus]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns.length, streamTail, busy]);

  const ask = useCallback(async (question: string) => {
    setBusy(true);
    setStreamTail("");
    flownRef.current = new Set();
    lastFlyRef.current = 0;

    // Beat 1 — the graph reacts to the QUESTION immediately, before Hermes
    // even answers: fly to whatever the question itself names.
    const asked = matchLexicon(question, 3);
    if (asked.length) { asked.forEach((n) => flownRef.current.add(n)); onFocus(asked.join(" | ")); }
    else onFocus(question);

    if (isDemo) {
      // Sample-memory installs get the theatre without a Hermes dependency.
      await new Promise((r) => setTimeout(r, 900));
      setTurns((t) => [...t.slice(-30), {
        who: "brain",
        text: "This is sample memory, so I can only show you the moves — connect Hermes and your real vault and I'll answer from your actual notes, lighting up every source I use.",
        sources: asked.slice(0, 2),
      }]);
      setBusy(false);
      return;
    }

    let token: string | null = null;
    try { const t = await fetch("/__token"); if (t.ok) token = (await t.json()).token ?? null; } catch { /* keyless */ }

    const nameList = lexicon.slice(0, 150).join("; ");
    const prompt = [
      "[MEMORY CONSOLE] You are answering inside the user's full-screen memory graph. Answer this question FROM THE USER'S OWN MEMORY — their Obsidian vault notes and Claude memory files. Read the relevant notes if you need to; do not answer from general knowledge when their memory speaks to it. Keep the answer tight: 2–6 sentences, plain prose, no markdown headers.",
      "CRITICAL — after the answer, on separate final lines, cite each memory you actually drew from as a directive, exact node name only, one per line:",
      "<<mem:Exact Node Name>>",
      nameList ? `The user's memory nodes include (use these EXACT names in directives): ${nameList}` : "",
      "If nothing in their memory covers it, say so plainly and cite nothing.",
      "",
      `Question: ${question}`,
    ].filter(Boolean).join("\n");

    let response: Response;
    try {
      response = await fetch("/__hermes_chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "X-Claude-OS-Token": token } : {}) },
        body: JSON.stringify({
          prompt,
          yolo: true,
          ...(sessionRef.current ? { sessionId: sessionRef.current } : {}),
        }),
      });
    } catch {
      setTurns((t) => [...t.slice(-30), { who: "brain", text: "I can't reach the Hermes brain right now — it does the reading. Start Hermes and ask again." }]);
      setBusy(false);
      return;
    }
    if (!response.ok || !response.body) {
      setTurns((t) => [...t.slice(-30), { who: "brain", text: "The memory brain didn't answer — check that Hermes is installed and the dev server is running." }]);
      setBusy(false);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", accumulated = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n"); buffer = events.pop() ?? "";
      for (const evt of events) {
        let eventName = "chunk"; const dataLines: string[] = [];
        for (const line of evt.split("\n")) {
          if (line.startsWith("event: ")) eventName = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
        }
        const data = dataLines.join("\n");
        if (eventName === "chunk" && data.length > 0) {
          accumulated += data + "\n";
          const visible = cleanReply(accumulated).replace(MEM_DIRECTIVE, "").trim();
          setStreamTail(visible.slice(-260));
          flyForText(accumulated);
        } else if (eventName === "info" && data) {
          const mm = data.match(/session_id:\s*([A-Za-z0-9_-]{6,})/);
          if (mm && mm[1]) sessionRef.current = mm[1];
          flyForText(data); // tool activity often names the files being read
        }
      }
    }

    const { text, sources } = stripDirectives(cleanReply(accumulated));
    setStreamTail("");
    setTurns((t) => [...t.slice(-30), { who: "brain", text: text || "Done.", sources }]);
    setBusy(false);
    // Beat 3 — the finale: light EVERY source the answer actually used.
    if (sources.length) onFocus(sources.join(" | "));
  }, [flyForText, isDemo, lexicon, matchLexicon, onFocus]);

  const send = (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = draft.trim();
    if (!q || busy) return;
    setDraft("");
    setExpanded(true);
    setTurns((t) => [...t.slice(-30), { who: "you", text: q }]);
    void ask(q);
  };

  const hasThread = turns.length > 0 || busy;

  return (
    <div
      className="absolute bottom-5 left-1/2 -translate-x-1/2 z-[10000] w-[min(680px,92vw)] flex flex-col"
      onKeyDown={(e) => e.stopPropagation()}
    >
      {/* the thread — floats up from the console, newest at the bottom */}
      {hasThread && expanded && (
        <div
          ref={scrollRef}
          className="mb-2.5 max-h-[42vh] overflow-y-auto rounded-2xl backdrop-blur-xl px-4 py-3 flex flex-col gap-3"
          style={{ background: "rgba(5,10,9,0.82)", border: `1px solid ${ACCENT}1f`, boxShadow: "0 24px 70px rgba(0,0,0,0.55)" }}
        >
          {turns.map((t, i) => (
            <div key={i} className={t.who === "you" ? "self-end max-w-[85%]" : "self-start max-w-[92%]"}>
              {t.who === "you" ? (
                <div className="rounded-2xl rounded-br-md px-3.5 py-2 text-[13px] leading-relaxed text-foreground" style={{ background: `${ACCENT}17`, border: `1px solid ${ACCENT}2a` }}>
                  {t.text}
                </div>
              ) : (
                <div>
                  <div className="text-[9px] uppercase tracking-[0.22em] mb-1" style={{ color: `${ACCENT}b0` }}>from your memory</div>
                  <div className="text-[13px] leading-relaxed text-foreground/90 whitespace-pre-wrap">{t.text}</div>
                  {t.sources && t.sources.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {t.sources.map((s) => (
                        <button
                          key={s}
                          onClick={() => onOpenNode(s)}
                          title="Open this memory"
                          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] font-medium transition-colors hover:brightness-125"
                          style={{ background: `${ACCENT}12`, border: `1px solid ${ACCENT}3a`, color: "#c9efe2" }}
                        >
                          <FileText className="h-3 w-3" style={{ color: ACCENT }} />
                          <span className="max-w-[200px] truncate">{s}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="self-start max-w-[92%]">
              <div className="flex items-center gap-2 text-[9px] uppercase tracking-[0.22em] mb-1" style={{ color: `${ACCENT}b0` }}>
                <Loader2 className="h-3 w-3 animate-spin" style={{ color: ACCENT }} />
                reading your memory
              </div>
              {streamTail && <div className="text-[12.5px] leading-relaxed text-foreground/45 whitespace-pre-wrap">…{streamTail}</div>}
            </div>
          )}
        </div>
      )}

      {/* the console bar */}
      <form
        onSubmit={send}
        className="flex items-center gap-2 rounded-full backdrop-blur-xl pl-4 pr-2 py-2"
        style={{ background: "rgba(5,10,9,0.85)", border: `1px solid ${ACCENT}30`, boxShadow: `0 18px 50px rgba(0,0,0,0.6), 0 0 34px -16px ${ACCENT}` }}
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0" style={{ color: ACCENT }} />
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder='Ask your memory… "what did I decide about pricing?"'
          className="flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/55 outline-none min-w-0"
        />
        {hasThread && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Collapse the thread" : "Show the thread"}
            className="grid place-items-center h-8 w-8 rounded-full shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
        )}
        <button
          type="submit"
          disabled={!draft.trim() || busy}
          title="Ask"
          className="grid place-items-center h-8 w-8 rounded-full shrink-0 transition-all disabled:opacity-35"
          style={{ background: `${ACCENT}1f`, color: ACCENT, border: `1px solid ${ACCENT}44` }}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CornerDownLeft className="h-3.5 w-3.5" />}
        </button>
      </form>
    </div>
  );
}
