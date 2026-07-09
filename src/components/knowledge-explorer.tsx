/**
 * Knowledge Explorer — a drill-down knowledge base over the Obsidian vault.
 *
 * Not another node graph (the memory constellation above already does that).
 * This is for making decisions from what you've filed: start from TOPIC
 * CLUSTERS (built from note tags), click into a topic to see the concepts
 * with their actual TL;DRs, the people who teach them, and the source
 * transcripts backing them — then keep clicking down into any note, or back
 * up via breadcrumbs and related topics. Substance on every card, never a
 * bare title. Data comes from scripts/aggregate.ts (memory.knowledge);
 * ships with demo data so a fresh clone renders keyless.
 */
import { useMemo, useState } from "react";
import {
  Search,
  X,
  ArrowUpRight,
  CornerDownRight,
  BookOpen,
  Hash,
  ChevronRight,
  Users,
  Lightbulb,
  FileText,
} from "lucide-react";
import { PALETTE, colorForCommunity } from "@/components/graphify-graph-3d";

export interface KnowledgeNote {
  id: string;
  title: string;
  type: string;
  folder: string;
  tags: string[];
  domain?: string;
  confidence?: string;
  status?: string;
  updated?: string;
  excerpt?: string;
  sourceCount?: number;
  out: string[];
}

export interface KnowledgeGraph {
  vault: string;
  stats: { notes: number; links: number; byType: Record<string, number>; unresolved?: number };
  notes: KnowledgeNote[];
  links: Array<{ s: string; t: string }>;
}

const ACCENT = "#3ddc97";

// Note types map onto the shared graph PALETTE by community slot so every
// dot/badge here matches the Knowledge Graph page's colour language.
const COMMUNITY_BY_TYPE: Record<string, number> = {
  concept: 0, // accent green
  source: 8, // amber
  reference: 8,
  entity: 2, // violet
  person: 2,
  topic: 12, // cyan
  moc: 12,
  report: 3, // pink
  note: 7, // soft grey
};
const FREE_SLOTS = [4, 9, 10, 11, 13, 14, 15, 5, 6, 1];

// Buckets a note type into the three bands a topic page shows.
const bandOf = (type: string): "concept" | "person" | "source" => {
  if (type === "entity" || type === "person") return "person";
  if (type === "source" || type === "reference") return "source";
  return "concept"; // concept / topic / moc / report / note / custom
};

const cleanTitle = (t: string) => t.replace(/^Source:\s*/i, "");

type Crumb = { t: "themes" } | { t: "theme"; tag: string } | { t: "note"; id: string };

export function KnowledgeExplorer({
  graphs,
  isDemo,
}: {
  graphs: KnowledgeGraph[];
  isDemo: boolean;
}) {
  const [vaultIdx, setVaultIdx] = useState(0);
  const [query, setQuery] = useState("");
  const [stack, setStack] = useState<Crumb[]>([{ t: "themes" }]);
  const [showAllThemes, setShowAllThemes] = useState(false);
  const data = graphs[Math.min(vaultIdx, graphs.length - 1)];

  const { byId, inbound, degree, typeCommunity, themes } = useMemo(() => {
    const byId = new Map(data.notes.map((n) => [n.id, n]));
    const inbound = new Map<string, string[]>();
    for (const l of data.links) {
      if (!inbound.has(l.t)) inbound.set(l.t, []);
      inbound.get(l.t)!.push(l.s);
    }
    const degree = new Map(
      data.notes.map((n) => [n.id, n.out.length + (inbound.get(n.id)?.length ?? 0)]),
    );
    const typeCommunity = new Map<string, number>();
    let free = 0;
    for (const [type] of Object.entries(data.stats.byType).sort((a, b) => b[1] - a[1])) {
      typeCommunity.set(type, COMMUNITY_BY_TYPE[type] ?? FREE_SLOTS[free++ % FREE_SLOTS.length]);
    }
    // Topic clusters = tag buckets. A tag that only appears once isn't a
    // cluster, it's a label — keep it reachable via search, not the wall.
    const tagMap = new Map<string, KnowledgeNote[]>();
    for (const n of data.notes) {
      for (const tag of n.tags) {
        const key = tag.toLowerCase();
        if (!tagMap.has(key)) tagMap.set(key, []);
        tagMap.get(key)!.push(n);
      }
    }
    const themes = [...tagMap.entries()]
      .filter(([, notes]) => notes.length >= 2)
      .map(([tag, notes]) => {
        const types: Record<string, number> = {};
        for (const n of notes) types[bandOf(n.type)] = (types[bandOf(n.type)] ?? 0) + 1;
        return { tag, notes, types };
      })
      .sort((a, b) => b.notes.length - a.notes.length);
    return { byId, inbound, degree, typeCommunity, themes };
  }, [data]);

  const colorOf = (type: string) =>
    colorForCommunity(typeCommunity.get(type) ?? 7, ACCENT) ?? PALETTE[7];

  const current = stack[stack.length - 1];

  const go = (crumb: Crumb) => {
    setQuery("");
    setStack((prev) => {
      const top = prev[prev.length - 1];
      if (JSON.stringify(top) === JSON.stringify(crumb)) return prev;
      return [...prev.slice(-11), crumb];
    });
  };
  const popTo = (idx: number) => setStack((prev) => prev.slice(0, idx + 1));

  const switchVault = (idx: number) => {
    if (idx === vaultIdx) return;
    setVaultIdx(idx);
    setStack([{ t: "themes" }]);
    setQuery("");
    setShowAllThemes(false);
  };

  // Search cuts across levels: matching topics + matching notes with their
  // substance, so you can jump straight to either.
  const q = query.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!q) return null;
    const matchedThemes = themes.filter((t) => t.tag.includes(q)).slice(0, 10);
    const matchedNotes = data.notes
      .filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          n.tags.some((t) => t.toLowerCase().includes(q)) ||
          (n.excerpt ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .slice(0, 12);
    return { matchedThemes, matchedNotes };
  }, [q, themes, data, degree]);

  if (!data || data.notes.length === 0) return null;

  const crumbLabel = (c: Crumb) =>
    c.t === "themes"
      ? "All topics"
      : c.t === "theme"
        ? `#${c.tag}`
        : truncate(cleanTitle(byId.get(c.id)?.title ?? c.id), 30);

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-b border-border">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-1 inline-flex items-center gap-2">
            <BookOpen className="h-3.5 w-3.5" />
            Knowledge explorer
            {isDemo && (
              <span
                title="Sample knowledge base shipped with this repo. Run `bun run scripts/aggregate.ts` to load your real Obsidian vault."
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
          <div className="text-base font-semibold tracking-tight">
            {themes.length} topics · {data.stats.notes} notes ·{" "}
            <span className="text-muted-foreground font-normal">{data.vault}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Click a topic to open everything filed under it — concepts with their takeaways, who
            teaches them, and the sources behind them.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {graphs.length > 1 && (
            <div className="flex items-center gap-1" role="tablist" aria-label="Vault">
              {graphs.map((g, i) => (
                <button
                  key={g.vault}
                  role="tab"
                  aria-selected={i === vaultIdx}
                  onClick={() => switchVault(i)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] transition-all ${
                    i === vaultIdx
                      ? "border-foreground/40 bg-foreground/[0.08] text-foreground"
                      : "border-border/70 bg-card/40 text-muted-foreground hover:text-foreground hover:border-foreground/20"
                  }`}
                >
                  {g.vault}
                </button>
              ))}
            </div>
          )}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search topics, notes, ideas"
              aria-label="Search the knowledge base"
              className="w-48 focus:w-60 transition-[width] rounded-full border border-border/70 bg-card/40 pl-8 pr-7 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-foreground/30"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Breadcrumbs — the up/down ladder */}
      <nav
        aria-label="Knowledge path"
        className="flex flex-wrap items-center gap-1 px-6 py-2.5 border-b border-border/60 text-xs"
      >
        {stack.map((c, i) => (
          <span key={`${c.t}-${i}`} className="inline-flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/50" />}
            <button
              onClick={() => popTo(i)}
              className={`rounded-md px-1.5 py-0.5 transition-colors ${
                i === stack.length - 1
                  ? "text-foreground font-medium bg-foreground/[0.06]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {crumbLabel(c)}
            </button>
          </span>
        ))}
      </nav>

      <div className="p-6 min-h-[380px]">
        {searchResults ? (
          <SearchView
            results={searchResults}
            colorOf={colorOf}
            degree={degree}
            onTheme={(tag) => go({ t: "theme", tag })}
            onNote={(id) => go({ t: "note", id })}
            query={query}
          />
        ) : current.t === "themes" ? (
          <ThemesView
            themes={showAllThemes ? themes : themes.slice(0, 24)}
            hiddenCount={showAllThemes ? 0 : Math.max(0, themes.length - 24)}
            onShowAll={() => setShowAllThemes(true)}
            onTheme={(tag) => go({ t: "theme", tag })}
          />
        ) : current.t === "theme" ? (
          <ThemeView
            tag={current.tag}
            themes={themes}
            colorOf={colorOf}
            degree={degree}
            onTheme={(tag) => go({ t: "theme", tag })}
            onNote={(id) => go({ t: "note", id })}
          />
        ) : (
          <NoteView
            note={byId.get(current.id)}
            byId={byId}
            inbound={inbound.get(current.id) ?? []}
            degree={degree}
            colorOf={colorOf}
            onTheme={(tag) => go({ t: "theme", tag })}
            onNote={(id) => go({ t: "note", id })}
          />
        )}
      </div>
    </section>
  );
}

// ─── Level 0: topic clusters ────────────────────────────────────────────────

function ThemesView({
  themes,
  hiddenCount,
  onShowAll,
  onTheme,
}: {
  themes: Array<{ tag: string; notes: KnowledgeNote[]; types: Record<string, number> }>;
  hiddenCount: number;
  onShowAll: () => void;
  onTheme: (tag: string) => void;
}) {
  if (themes.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No tagged notes yet — add <span className="font-mono">tags:</span> frontmatter to your
        vault notes and re-run the aggregator.
      </p>
    );
  }
  const max = themes[0].notes.length;
  return (
    <div>
      <div className="flex flex-wrap gap-2.5">
        {themes.map((t) => {
          // Three visual tiers so the big clusters read as big.
          const ratio = t.notes.length / max;
          const tier = ratio > 0.55 ? 0 : ratio > 0.25 ? 1 : 2;
          return (
            <button
              key={t.tag}
              onClick={() => onTheme(t.tag)}
              className="group text-left rounded-xl border border-border/70 bg-card/40 hover:border-foreground/30 hover:bg-foreground/[0.04] transition-all"
              style={{
                padding: tier === 0 ? "14px 18px" : tier === 1 ? "11px 14px" : "8px 12px",
              }}
            >
              <span
                className="flex items-center gap-1.5 font-semibold tracking-tight"
                style={{ fontSize: tier === 0 ? 17 : tier === 1 ? 14 : 12.5 }}
              >
                <Hash
                  className="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity"
                  style={{ width: tier === 0 ? 15 : 12, height: tier === 0 ? 15 : 12, color: ACCENT }}
                />
                {t.tag}
              </span>
              <span className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground tabular-nums">
                {t.notes.length} notes
                <span className="inline-flex items-center gap-1">
                  {t.types.concept ? <Dot color={ACCENT} n={t.types.concept} /> : null}
                  {t.types.person ? <Dot color="#a78bfa" n={t.types.person} /> : null}
                  {t.types.source ? <Dot color="#fbbf24" n={t.types.source} /> : null}
                </span>
              </span>
            </button>
          );
        })}
        {hiddenCount > 0 && (
          <button
            onClick={onShowAll}
            className="rounded-xl border border-dashed border-border/70 px-4 py-2 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-all"
          >
            +{hiddenCount} more topics
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-4 mt-5 pt-4 border-t border-border/50 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: ACCENT }} /> concepts &
          frameworks
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#a78bfa" }} /> people
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#fbbf24" }} /> sources
        </span>
      </div>
    </div>
  );
}

function Dot({ color, n }: { color: string; n: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {n}
    </span>
  );
}

// ─── Level 1: one topic, grouped by what kind of knowledge it is ───────────

function ThemeView({
  tag,
  themes,
  colorOf,
  degree,
  onTheme,
  onNote,
}: {
  tag: string;
  themes: Array<{ tag: string; notes: KnowledgeNote[]; types: Record<string, number> }>;
  colorOf: (type: string) => string;
  degree: Map<string, number>;
  onTheme: (tag: string) => void;
  onNote: (id: string) => void;
}) {
  const theme = themes.find((t) => t.tag === tag);
  if (!theme) return <p className="text-xs text-muted-foreground">Topic not found.</p>;

  const byDegree = (a: KnowledgeNote, b: KnowledgeNote) =>
    (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
  const concepts = theme.notes.filter((n) => bandOf(n.type) === "concept").sort(byDegree);
  const people = theme.notes.filter((n) => bandOf(n.type) === "person").sort(byDegree);
  const sources = theme.notes.filter((n) => bandOf(n.type) === "source").sort(byDegree);

  // Related topics = tags that co-occur on this topic's notes.
  const co = new Map<string, number>();
  for (const n of theme.notes)
    for (const t of n.tags) {
      const k = t.toLowerCase();
      if (k !== tag) co.set(k, (co.get(k) ?? 0) + 1);
    }
  const themeTags = new Set(themes.map((t) => t.tag));
  const related = [...co.entries()]
    .filter(([t]) => themeTags.has(t))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold tracking-tight flex items-center gap-1.5">
            <Hash className="h-4.5 w-4.5" style={{ color: ACCENT }} />
            {tag}
          </h3>
          <p className="text-xs text-muted-foreground mt-1 tabular-nums">
            {concepts.length} concepts · {people.length} people · {sources.length} sources
          </p>
        </div>
        {related.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 max-w-md">
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mr-1">
              Related
            </span>
            {related.map(([t, n]) => (
              <button
                key={t}
                onClick={() => onTheme(t)}
                className="rounded-full border border-border/70 bg-card/40 px-2 py-0.5 text-[11px] text-foreground/85 hover:text-foreground hover:border-foreground/25 transition-colors"
                title={`${n} shared notes`}
              >
                #{t}
              </button>
            ))}
          </div>
        )}
      </div>

      {concepts.length > 0 && (
        <Band icon={<Lightbulb className="h-3.5 w-3.5" />} label="Concepts & frameworks">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {concepts.map((n) => (
              <NoteCard key={n.id} note={n} color={colorOf(n.type)} degree={degree} onNote={onNote} />
            ))}
          </div>
        </Band>
      )}

      {people.length > 0 && (
        <Band icon={<Users className="h-3.5 w-3.5" />} label="People & entities">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {people.map((n) => (
              <NoteCard key={n.id} note={n} color={colorOf(n.type)} degree={degree} onNote={onNote} />
            ))}
          </div>
        </Band>
      )}

      {sources.length > 0 && (
        <Band icon={<FileText className="h-3.5 w-3.5" />} label={`Sources (${sources.length})`}>
          <ul className="divide-y divide-border/50 rounded-lg border border-border/60 overflow-hidden">
            {sources.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => onNote(n.id)}
                  className="w-full text-left px-4 py-2.5 hover:bg-foreground/[0.04] transition-colors"
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-foreground/90 truncate">
                      {cleanTitle(n.title)}
                    </span>
                    <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
                      {n.updated ?? ""}
                    </span>
                  </span>
                  {n.excerpt && (
                    <span className="block text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
                      {n.excerpt}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </Band>
      )}
    </div>
  );
}

function Band({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2 inline-flex items-center gap-1.5">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}

/** The workhorse card: title + the actual takeaway, never a bare title. */
function NoteCard({
  note,
  color,
  degree,
  onNote,
}: {
  note: KnowledgeNote;
  color: string;
  degree: Map<string, number>;
  onNote: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onNote(note.id)}
      className="text-left rounded-lg border border-border/60 bg-card/40 p-3.5 hover:border-foreground/25 hover:bg-foreground/[0.04] transition-all"
      style={{ borderLeftWidth: 3, borderLeftColor: color }}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold tracking-tight leading-snug">
          {cleanTitle(note.title)}
        </span>
        <span
          className="text-[9.5px] tabular-nums shrink-0 rounded-full px-1.5 py-0.5"
          style={{ background: `${color}1a`, color }}
          title="How connected this note is — more relations, more load-bearing"
        >
          {degree.get(note.id) ?? 0} rel
        </span>
      </span>
      {note.excerpt && (
        <span className="block text-[11.5px] leading-relaxed text-muted-foreground mt-1.5 line-clamp-2">
          {note.excerpt}
        </span>
      )}
    </button>
  );
}

// ─── Level 2: a single note with its full substance and relations ──────────

function NoteView({
  note,
  byId,
  inbound,
  degree,
  colorOf,
  onTheme,
  onNote,
}: {
  note: KnowledgeNote | undefined;
  byId: Map<string, KnowledgeNote>;
  inbound: string[];
  degree: Map<string, number>;
  colorOf: (type: string) => string;
  onTheme: (tag: string) => void;
  onNote: (id: string) => void;
}) {
  if (!note) return <p className="text-xs text-muted-foreground">Note not found.</p>;
  const backlinks = inbound.filter((id) => byId.has(id));
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-8">
      <div className="space-y-4 min-w-0">
        <div>
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            <Badge color={colorOf(note.type)}>{note.type}</Badge>
            {note.confidence && <Badge color="#9aa3b0">{note.confidence} confidence</Badge>}
            {note.domain && <Badge color="#22d3ee">{note.domain}</Badge>}
          </div>
          <h3 className="text-xl font-semibold tracking-tight leading-snug">
            {cleanTitle(note.title)}
          </h3>
          <div className="text-[11px] text-muted-foreground mt-1 tabular-nums">
            {note.folder}
            {note.updated ? ` · updated ${note.updated}` : ""}
            {note.sourceCount ? ` · ${note.sourceCount} sources` : ""}
            {` · ${degree.get(note.id) ?? 0} relations`}
          </div>
        </div>

        {note.excerpt && (
          <p
            className="text-sm leading-relaxed text-foreground/85 border-l-2 pl-4"
            style={{ borderColor: colorOf(note.type) }}
          >
            {note.excerpt}
          </p>
        )}

        {note.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {note.tags.map((t) => (
              <button
                key={t}
                onClick={() => onTheme(t.toLowerCase())}
                className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-foreground/25 transition-colors"
                title={`Open the #${t} topic`}
              >
                #{t}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-5">
        <RelationList
          icon={<ArrowUpRight className="h-3 w-3" />}
          label={`Cites (${note.out.length})`}
          ids={note.out}
          byId={byId}
          colorOf={colorOf}
          onPick={onNote}
        />
        <RelationList
          icon={<CornerDownRight className="h-3 w-3" />}
          label={`Cited by (${backlinks.length})`}
          ids={backlinks}
          byId={byId}
          colorOf={colorOf}
          onPick={onNote}
        />
      </div>
    </div>
  );
}

function RelationList({
  icon,
  label,
  ids,
  byId,
  colorOf,
  onPick,
}: {
  icon: React.ReactNode;
  label: string;
  ids: string[];
  byId: Map<string, KnowledgeNote>;
  colorOf: (type: string) => string;
  onPick: (id: string) => void;
}) {
  const notes = ids.map((id) => byId.get(id)).filter(Boolean) as KnowledgeNote[];
  if (notes.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-1.5 inline-flex items-center gap-1.5">
        {icon}
        {label}
      </div>
      <ul className="space-y-1">
        {notes.map((n) => (
          <li key={n.id}>
            <button
              onClick={() => onPick(n.id)}
              className="w-full text-left flex items-start gap-2 rounded-md px-2 py-1.5 text-[11.5px] text-foreground/85 hover:text-foreground hover:bg-foreground/[0.05] transition-colors"
            >
              <span
                className="h-1.5 w-1.5 rounded-full shrink-0 mt-1.5"
                style={{ background: colorOf(n.type) }}
              />
              <span className="min-w-0">
                <span className="block truncate">{cleanTitle(n.title)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Search: cuts across all levels ─────────────────────────────────────────

function SearchView({
  results,
  colorOf,
  degree,
  onTheme,
  onNote,
  query,
}: {
  results: {
    matchedThemes: Array<{ tag: string; notes: KnowledgeNote[] }>;
    matchedNotes: KnowledgeNote[];
  };
  colorOf: (type: string) => string;
  degree: Map<string, number>;
  onTheme: (tag: string) => void;
  onNote: (id: string) => void;
  query: string;
}) {
  const { matchedThemes, matchedNotes } = results;
  if (matchedThemes.length === 0 && matchedNotes.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No topics or notes match “{query.trim()}”.</p>
    );
  }
  return (
    <div className="space-y-5">
      {matchedThemes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mr-1">
            Topics
          </span>
          {matchedThemes.map((t) => (
            <button
              key={t.tag}
              onClick={() => onTheme(t.tag)}
              className="rounded-full border border-border/70 bg-card/40 px-2.5 py-1 text-[11px] text-foreground/85 hover:text-foreground hover:border-foreground/25 transition-colors"
            >
              #{t.tag}
              <span className="text-muted-foreground/70 ml-1 tabular-nums">{t.notes.length}</span>
            </button>
          ))}
        </div>
      )}
      {matchedNotes.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {matchedNotes.map((n) => (
            <NoteCard key={n.id} note={n} color={colorOf(n.type)} degree={degree} onNote={onNote} />
          ))}
        </div>
      )}
    </div>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[9.5px] uppercase tracking-[0.14em] font-semibold"
      style={{ background: `${color}1f`, color, border: `1px solid ${color}44` }}
    >
      {children}
    </span>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
