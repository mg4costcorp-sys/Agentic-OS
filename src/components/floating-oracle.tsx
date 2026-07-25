/*
 * FloatingOracle — the OS-wide guide, docked bottom-right on every route.
 *
 * A miniature of the Hermes Intelligence portal: the same living plasma core,
 * the same state grammar (teal listening · gold thinking · orange working ·
 * pale-mint speaking), and the same capability chips — real brand logos that
 * light up as Hermes actually touches GitHub / Notion / memory / the shell.
 *
 *   - Clicking the orb opens a chooser: VOICE LINE (live Realtime call via
 *     the local voice-lab engine) or TEXT CHAT (straight to the Hermes brain
 *     over /__hermes_chat — private, no voice account, no cost).
 *   - Typed replies STREAM into the caption as Hermes produces them, and the
 *     info/chunk text drives the chip row + state color — so text mode has
 *     the same alive, zero-latency feel as the call.
 *   - Replies may carry `<<nav:/path>>` directives; the widget executes them
 *     through the router and strips them from the visible text.
 *   - If voice isn't connected, the user is prompted with an inline setup
 *     card that hands off to the Intelligence portal's onboarding.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { ChevronDown, Keyboard, Mic, MicOff, Send, Square, X } from "lucide-react";
import { OraclePlasma } from "@/components/oracle-plasma";
import { SyntheticVoice } from "@/lib/synthetic-voice";

const TEAL = "#7be0c8";
// Compact model label — drops the "vendor/" prefix and the ":free" suffix so
// long OpenRouter ids fit the little header chip.
function shortName(name: string): string {
  const base = name.includes("/") ? name.split("/").pop()! : name;
  return base.replace(":free", " · free");
}
const VOICE_HEALTH_URL = "http://localhost:8099/api/health";
const VOICE_TOKEN_URL = "http://localhost:8099/api/session";

type OracleMode = "dormant" | "listening" | "thinking" | "talking" | "working";
// The portal's exact state grammar — the orb, label and glow all follow it.
const MODE_COLOR: Record<OracleMode, string> = {
  dormant: TEAL,
  listening: TEAL,
  thinking: "#FFD21E",
  talking: "#aef3dd",
  working: "#ff8a3c",
};
const MODE_LABEL: Record<OracleMode, string> = {
  dormant: "your OS guide",
  listening: "listening",
  thinking: "thinking",
  talking: "speaking",
  working: "working",
};

/** The guide's map of the OS — kept next to the directive contract so a new
 *  route added here is immediately navigable by voice or text. */
const SITE_MAP: Array<{ path: string; what: string }> = [
  { path: "/", what: "Mission Control home — stack overview, costs, time saved, Dream prescriptions" },
  { path: "/memory", what: "Memory graph — 3D map of Obsidian vault, Claude memories and Pinecone indexes, plus recent memory activity" },
  { path: "/skills", what: "Skills inventory — every installed skill, usage counts, lifecycle" },
  { path: "/activity", what: "Activity feed — sessions, tokens and model usage over time" },
  { path: "/workspaces", what: "Workspaces — every Claude Code project the OS tracks" },
  { path: "/codegraph", what: "Graphify code graphs — relational knowledge graphs of registered repos" },
  { path: "/agents/hermes", what: "Hermes Agent — chat with Hermes, Pantheon personas, models, skills, Mission Control" },
  { path: "/agents/hermes?intel=1", what: "The Intelligence portal — full-screen cinematic voice view" },
  { path: "/agents/claude-code", what: "Claude Code agent — usage, plan, sessions" },
  { path: "/agents/openclaw", what: "OpenClaw agent page" },
  { path: "/settings", what: "Dashboard settings — valuation rate, voice engine, integrations" },
  { path: "/setup", what: "First-run setup and onboarding" },
];

function guideSeed(currentPath: string, knowledge: string): string {
  const map = SITE_MAP.map((r) => `  ${r.path} — ${r.what}`).join("\n");
  return [
    "You are the Oracle — the built-in guide of this Claude OS dashboard, speaking from a small companion widget docked on screen. You ARE Hermes with your full toolset (files, shell, memory, skills), so you can genuinely act — including reading or editing the dashboard's own repo (the folder this dev server runs from) when the user explicitly asks for a change.",
    "",
    "The OS pages you can guide the user through:",
    map,
    `\nHOW THE DASHBOARD WORKS (built-in manual — this is ground truth about every section):\n${MANUAL_DIGEST}`,
    knowledge ? `\nLIVE SNAPSHOT of this OS (already loaded for you — answer from it directly, no tools needed):\n${knowledge}` : "",
    "",
    "SPEED CONTRACT: answer from the manual + snapshot above whenever they suffice — no tool calls, no file reads.",
    "ROUTING: (a) Questions about what the user's MEMORY or OBSIDIAN NOTES actually SAY, or their recent sessions → read the files / use recall, then answer. (b) Questions about how THIS dashboard's own code is built → the repo is the dev server's working directory; use graphify against it (`graphify query \"<question>\" --graph <graphPath>`; if the OS repo isn't graphed yet, offer to graph it). (c) Anything that CHANGES state or reaches the outside world → do it only when the user explicitly asks.",
    "",
    "NAVIGATION: to take the user to a page, put a directive on its own line anywhere in your reply: <<nav:/path>>. The dashboard executes it and strips it from your visible text. Use it whenever showing beats telling (at most one per reply).",
    "",
    `Style: warm, concise (2–4 sentences unless depth is requested), zero filler. The user is currently on: ${currentPath}`,
  ].join("\n");
}

// ---- instant local answers — pure client-side replies for guide questions
// the widget can resolve itself. Hermes only gets involved when needed. ----
const NAV_HINTS: Array<{ match: RegExp; path: string; say: string }> = [
  { match: /memor(y|ies)|obsidian|pinecone|vault/i, path: "/memory", say: "Here's your memory graph — Obsidian, Claude memories and Pinecone in one 3D map." },
  { match: /skill/i, path: "/skills", say: "Here's your skills inventory." },
  { match: /activit|usage|token|session/i, path: "/activity", say: "Here's your activity feed." },
  { match: /graph(ify)?|code ?graph|knowledge graph/i, path: "/codegraph", say: "Here are your Graphify code graphs." },
  { match: /workspace|project/i, path: "/workspaces", say: "Here are your tracked workspaces." },
  { match: /intelligence|voice (view|portal)/i, path: "/agents/hermes?intel=1", say: "Opening the Intelligence portal." },
  { match: /hermes/i, path: "/agents/hermes", say: "Here's the Hermes agent page." },
  { match: /dream|prescription/i, path: "/", say: "Dream prescriptions live on the home page — taking you there." },
  { match: /setting/i, path: "/settings", say: "Here are your settings." },
  { match: /claude ?code/i, path: "/agents/claude-code", say: "Here's the Claude Code agent page." },
  { match: /home|dashboard|mission control|overview/i, path: "/", say: "Back to Mission Control." },
];
const NAV_INTENT = /^(take me|go( to)?|open|show( me)?|bring up|navigate|jump)\b|where('s| is| are| can i (see|find))\b/i;

// ────────────────────────────────────────────────────────────────────────────
// THE OS MANUAL — the Oracle's built-in, ships-with-the-app knowledge base.
// Hand-authored so ANY install answers questions about the dashboard instantly,
// keyless, with no Hermes and no network. Each entry: a matcher, a title, and
// a tight explanation. This is the source of truth the Oracle speaks from for
// "what is / how does / explain / tell me about" questions, and a condensed
// version is also handed to Hermes + the voice call so every path stays
// grounded in the same facts.
// ────────────────────────────────────────────────────────────────────────────
type ManualEntry = { key: string; match: RegExp; title: string; body: string };
const OS_MANUAL: ManualEntry[] = [
  { key: "overview", match: /what is (this|claude ?os|the (os|dashboard|app))|explain (claude ?os|the os|this)|what does this (app|dashboard) do/i,
    title: "Claude OS",
    body: "Claude OS is an operator dashboard for your whole AI stack — it makes your AI 'brain' visible and controllable. It watches your Claude Code activity, memory, skills, costs and agents, and pairs with Hermes (a local autonomous agent) so you can actually act. Everything runs locally against your own machine; nothing needs a login to explore." },
  { key: "home", match: /home page|mission control|dashboard home|landing page|main page/i,
    title: "Mission Control (Home)",
    body: "The home page is Mission Control: your at-a-glance state — AI spend, hours saved, activity, live plan limits, connected sources, and the day's Dream prescriptions. It's the first read on 'how is my whole system doing right now'." },
  { key: "memory", match: /how does (the )?memory (work|system)|what is the memory (graph|system)|explain memory|memory system/i,
    title: "The memory system",
    body: "Memory is your AI's long-term brain, drawn from three layers: local Claude memories (CLAUDE.md, MEMORY.md and decision files across your workspaces), your Obsidian vault (markdown notes), and Pinecone vector indexes (semantic recall). The Memory page renders all of it as a 3D graph — clusters by workspace, links shared decisions, and flags stale or missing files. Say 'take me to my memory' to see it." },
  { key: "obsidian", match: /obsidian|my (vault|notes|wiki)|markdown notes/i,
    title: "Obsidian in the OS",
    body: "Your Obsidian vault is one of the three memory sources. The OS reads its markdown — sources (transcripts), concepts, entities and topic pages — and folds it into the memory graph as the purple 'Obsidian' layer. Questions about what a note actually *says* go to Hermes, which can read the files; questions about counts and freshness I answer instantly." },
  { key: "pinecone", match: /pinecone|vector (index|store|memory|database)|embeddings/i,
    title: "Pinecone vector memory",
    body: "Pinecone holds your vector indexes — embedded memories you can recall semantically rather than by filename. Each index shows up in the memory graph with its vector count and namespaces. It's the layer behind 'what did we decide about X' style recall." },
  { key: "graphify", match: /what is graphify|how does graphify|code ?graph|knowledge graph|graphify/i,
    title: "Graphify code graphs",
    body: "Graphify turns a codebase into a relational knowledge graph — an AST-based map of files and how they depend on each other, clustered into communities (≈ modules). The Knowledge Graph page renders these in 3D so you can see a repo's real structure. For deep 'how is this code built' questions I hand off to Hermes, which runs graphify against the actual graph." },
  { key: "skills", match: /what are skills|how do skills|skills (page|inventory|lifecycle)|explain skills/i,
    title: "Skills",
    body: "Skills are reusable capabilities your agents can invoke — each is a folder with a SKILL.md. The Skills page inventories every installed skill, how often it's run, and its lifecycle (alive, dormant, or dead) so you can prune or promote them. Say 'take me to my skills' for the list." },
  { key: "activity", match: /activity (page|feed)|what is activity|session history|usage over time/i,
    title: "Activity",
    body: "The Activity page is your usage timeline — sessions, message turns, tokens and which models ran, over time. It's where you see how hard the system's been working and where the spend came from." },
  { key: "workspaces", match: /what are workspaces|workspaces page|my projects/i,
    title: "Workspaces",
    body: "Workspaces are the Claude Code projects the OS tracks — each with its own memory files and activity. The Workspaces page lists them so you can jump into any project's context." },
  { key: "hermes", match: /what is hermes|who is hermes|how does hermes|explain hermes|hermes agent/i,
    title: "Hermes",
    body: "Hermes is your local autonomous agent — the brain behind me. It has real tools (files, shell, memory, skills, web) and its own persistent memory, so it can genuinely act on your machine, not just chat. When a question needs live data, your files, or an action, I route it to Hermes and speak back what it returns." },
  { key: "personas", match: /persona|pantheon|philosopher|what.*personas/i,
    title: "Pantheon personas",
    body: "Hermes runs a 'Pantheon' of personas — named specialists (like the Philosopher for deep reasoning) each with their own model, effort level and system prompt. You pick or edit them on the Hermes page; each is a saved YAML you can tune or sync to GitHub." },
  { key: "intel", match: /intelligence (portal|view)|voice (view|portal|mode)|the plasma|cinematic/i,
    title: "The Intelligence portal",
    body: "The Intelligence portal is Hermes' full-screen cinematic view — the living plasma core, capability constellation, and a hands-free voice line to the agent. I'm the pocket version of it, docked in the corner. Say 'open the Intelligence portal' to go full-screen." },
  { key: "dream", match: /what is dream|how does dream|dream (review|feature)|prescriptions|dreaming/i,
    title: "The Dream review",
    body: "Dream is the overnight self-improvement pass: on a daily cron it audits your last 24h across eight signal buckets (cost, memory, skills, workflow, sessions and more) and writes the top four highest-impact prescriptions — concrete, evidence-backed fixes you can run. They surface on the home page." },
  { key: "voice", match: /how does voice|voice (line|call|engine)|talk to (it|you|hermes)/i,
    title: "Voice",
    body: "The voice line is a live, zero-latency call to Hermes over your own local voice engine — your key stays on your machine. Quick facts come straight from my knowledge base; anything real routes to Hermes mid-call. If voice isn't set up, I'll walk you through the one-time setup." },
  { key: "cost", match: /how (is|do you) (spend|cost|money)|time saved|roi|valuation|hourly rate/i,
    title: "Cost & value",
    body: "The OS tracks what your stack costs (subscriptions + token spend) against what it saves — hours removed × your hourly rate, set in Settings. That's the ROI framing on the home page: spend versus time-saved value." },
  { key: "settings", match: /settings page|what.*settings|configure the (os|dashboard)/i,
    title: "Settings",
    body: "Settings is where you set your valuation (hourly rate), wire the voice engine, and manage integrations. Say 'take me to settings' to open it." },
  { key: "oracle", match: /what are you|who are you|what is the oracle|how do you work|are you hermes/i,
    title: "The Oracle (me)",
    body: "I'm the Oracle — the OS's built-in guide, docked in the corner on every page. I carry a knowledge base about the whole dashboard so I answer instantly, I can navigate you anywhere, and for anything real — your files, live data, or actions — I hand off to Hermes and speak back what it finds. Voice or text, your call." },
];

// Match a conceptual question to a manual entry. Only fires when the phrasing
// reads as a "what/how/explain/tell me about" question so we never hijack an
// action request or a live-stats question (both handled earlier / elsewhere).
const CONCEPT_INTENT = /\b(what('s| is| are| does)|how (do|does|to)|explain|tell me about|describe|what.*mean)\b/i;
function manualAnswer(text: string): string | null {
  const hit = OS_MANUAL.find((e) => e.match.test(text));
  if (!hit) return null;
  // A bare keyword ("obsidian?") counts as conceptual too — but a
  // navigation/action phrasing was already filtered upstream.
  if (!CONCEPT_INTENT.test(text) && text.trim().split(/\s+/).length > 4) return null;
  return hit.body;
}
// Condensed manual for the Hermes seed + voice snapshot — keeps every path
// grounded in the same section facts without shipping the full prose twice.
const MANUAL_DIGEST = OS_MANUAL.map((e) => `${e.title}: ${e.body}`).join("\n");

// ---- capability chips — the portal's brand-logo grammar, miniaturised ----
// keyword → app key (verbatim from the Intelligence view's fireIntel map)
const CHIP_MAP: [string, string][] = [
  ["pull request", "github"], ["github", "github"], ["repo", "github"], ["commit", "github"],
  ["youtube", "youtube"], ["reddit", "reddit"], ["linkedin", "linkedin"], ["x.com", "x"], ["twitter", "x"], ["clay", "clay"],
  ["notion", "notion"], ["obsidian", "obsidian"], ["granola", "granola"], ["calendar", "calendar"],
  ["gmail", "email"], ["email", "email"], ["telegram", "telegram"], ["slack", "slack"],
  ["supabase", "supabase"], ["drive", "drive"],
  ["pinecone", "memory"], ["recall", "memory"], ["remember", "memory"], ["memory", "memory"],
  ["claude", "claude"], ["anthropic", "claude"], ["opus", "claude"], ["sonnet", "claude"], ["fable", "claude"],
  ["gemini", "gemini"], ["codex", "codex"], ["gpt-", "codex"], ["sub-agent", "agents"], ["subagent", "agents"], ["spawn", "agents"],
  ["draft", "writing"], ["writing", "writing"], ["compose", "writing"], ["elevenlabs", "elevenlabs"], ["notebooklm", "notebooklm"], ["higgsfield", "higgsfield"],
  ["n8n", "n8n"], ["zapier", "zapier"], ["mcp", "mcp"], ["cron", "cron"], ["schedul", "cron"], ["skill", "skills"],
  ["web search", "web"], ["browse", "web"], ["fetch", "web"], ["http", "web"], ["search", "web"],
  ["bash", "code"], ["editing", "code"], ["edit file", "code"], ["reading file", "code"], ["run command", "code"],
];
// app key → real favicon domain (true brand colours) or a lettermark fallback
const CHIP_ICON: Record<string, { domain?: string; color: string; letter: string; name: string }> = {
  github: { domain: "github.com", color: "#fff", letter: "GH", name: "GitHub" },
  youtube: { domain: "youtube.com", color: "#ff3b3b", letter: "YT", name: "YouTube" },
  reddit: { domain: "reddit.com", color: "#ff4500", letter: "R", name: "Reddit" },
  linkedin: { domain: "linkedin.com", color: "#0a66c2", letter: "in", name: "LinkedIn" },
  x: { domain: "x.com", color: "#fff", letter: "X", name: "X / Twitter" },
  clay: { domain: "clay.com", color: "#FFD21E", letter: "Cl", name: "Clay" },
  notion: { domain: "notion.so", color: "#fff", letter: "N", name: "Notion" },
  obsidian: { domain: "obsidian.md", color: "#a78bfa", letter: "Ob", name: "Obsidian" },
  granola: { domain: "granola.ai", color: "#FFE6CB", letter: "Gr", name: "Granola" },
  calendar: { domain: "calendar.google.com", color: "#4285F4", letter: "Ca", name: "Calendar" },
  email: { domain: "mail.google.com", color: "#EA4335", letter: "@", name: "Gmail" },
  telegram: { domain: "telegram.org", color: "#2aabee", letter: "Tg", name: "Telegram" },
  slack: { domain: "slack.com", color: "#e8d7c8", letter: "Sl", name: "Slack" },
  supabase: { domain: "supabase.com", color: "#3ecf8e", letter: "Sb", name: "Supabase" },
  drive: { domain: "drive.google.com", color: "#46e0a0", letter: "Dr", name: "Google Drive" },
  memory: { domain: "pinecone.io", color: "#ff9da7", letter: "M", name: "Memory" },
  claude: { domain: "claude.ai", color: "#ff8a3c", letter: "Cl", name: "Claude" },
  gemini: { domain: "gemini.google.com", color: "#60a5fa", letter: "Gm", name: "Gemini" },
  codex: { domain: "openai.com", color: "#fff", letter: "AI", name: "Codex" },
  agents: { color: "#b9a6ff", letter: "Ag", name: "Sub-agents" },
  writing: { color: "#ff5a7a", letter: "Wr", name: "Writing" },
  elevenlabs: { domain: "elevenlabs.io", color: "#fff", letter: "11", name: "ElevenLabs" },
  notebooklm: { domain: "notebooklm.google.com", color: "#60a5fa", letter: "NB", name: "NotebookLM" },
  higgsfield: { domain: "higgsfield.ai", color: "#c8ff00", letter: "Hg", name: "Higgsfield" },
  n8n: { domain: "n8n.io", color: "#ea4b71", letter: "n8", name: "n8n" },
  zapier: { domain: "zapier.com", color: "#ff4f00", letter: "Z", name: "Zapier" },
  mcp: { color: "#ff8a3c", letter: "MCP", name: "MCP Tools" },
  cron: { color: "#ff8a3c", letter: "Cr", name: "Schedule" },
  skills: { color: "#ff8a3c", letter: "Sk", name: "Skills" },
  web: { domain: "duckduckgo.com", color: "#60a5fa", letter: "W", name: "Web Search" },
  code: { color: "#ff8a3c", letter: "</>", name: "Code / Bash" },
};

type Chip = { id: string; app: string; status: "running" | "done" };

function ChipIcon({ app }: { app: string }) {
  const m = CHIP_ICON[app] ?? { color: "#FFE6CB", letter: "?", name: app };
  const [err, setErr] = useState(false);
  if (m.domain && !err) {
    return (
      <img
        src={`https://icons.duckduckgo.com/ip3/${m.domain}.ico`}
        alt=""
        onError={() => setErr(true)}
        style={{ width: 16, height: 16, borderRadius: 4, background: "#fbfbfb", padding: 1.5, objectFit: "contain", display: "block" }}
      />
    );
  }
  return (
    <span style={{ font: "600 7.5px ui-monospace,monospace", color: m.color }}>{m.letter}</span>
  );
}

type Turn = { who: "you" | "oracle"; text: string; via?: string; apps?: string[] };

// Distinct app/capability keys a reply touched — powers the "apps used" row
// under an Oracle message. Same keyword map the live chips used, deduped.
function appsFromText(data: string): string[] {
  const low = (data || "").toLowerCase();
  const seen: string[] = [];
  for (const [kw, app] of CHIP_MAP) {
    if (seen.includes(app) || !low.includes(kw)) continue;
    seen.push(app);
  }
  return seen.slice(0, 8);
}

// Structured client-side knowledge base about the OS — the Oracle's own
// "database". Populated once per panel-open from the dashboard's endpoints;
// the query router answers from it instantly and only escalates to Hermes
// for what it genuinely can't know.
type OracleKB = {
  memory?: { files: number; workspaces: number; pinecone: number; freshness: number | string };
  skillsActive?: number;
  spend?: string;
  timeSaved?: string;
  hermes?: { sessions?: number; personas?: number; skills?: number };
  summary?: string;
  // The OS's OWN code graph (Graphify), when it's been built — lets the Oracle
  // answer "how is this dashboard built" from real AST structure, instantly.
  osCode?: { files: number; edges: number; modules: number; godNodes: string[]; graphPath?: string };
};

// A registered graph is the OS's own self-graph if its most-connected files
// are the dashboard's signature sources. Portable across installs (same repo,
// same files) and won't false-match an unrelated user project.
const SELF_SIGNATURE = new Set(["agents.hermes.tsx", "aggregate.ts", "model-intelligence.tsx", "app-sidebar.tsx", "hermes-mission-control.tsx", "index.tsx"]);
function isSelfGraph(g: any): boolean {
  const gods = (g?.godNodes ?? []).map((n: any) => n?.name).filter(Boolean);
  const hits = gods.filter((n: string) => SELF_SIGNATURE.has(n)).length;
  return hits >= 2 || /claude.?os/i.test(String(g?.name ?? ""));
}

function cleanReply(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*Warning:\s*(Unknown toolset|Unrecognized|Deprecat|No config)/i.test(l))
    .join("\n");
}

const SUGGESTIONS = [
  "Give me a tour of the OS",
  "What's in my memory graph?",
  "Take me to my Dream prescriptions",
];

// onDisable is accepted for the header-toggle contract but the panel no
// longer calls it — X minimizes; only the header dot fully hides the Oracle.
export function FloatingOracle({ enabled }: { enabled: boolean; onDisable?: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("os-oracle-open") === "1"; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem("os-oracle-open", open ? "1" : "0"); } catch { /* ignore */ } }, [open]);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  // Model the TEXT brain routes to (voice audio is always gpt-realtime; this
  // picks the Hermes model that answers ask_hermes / text turns). Persisted
  // per-browser; null = follow the Hermes config default. A small switcher in
  // the header lets you tell it which brain to use without leaving the widget.
  const [brainModel, setBrainModel] = useState<{ provider: string; name: string } | null>(() => {
    try { const s = localStorage.getItem("os-oracle-brain-model"); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [modelMenu, setModelMenu] = useState(false);
  const [modelCatalogState, setModelCatalogState] = useState<Array<{ provider: string; name: string }>>([]);
  const brainModelRef = useRef<{ provider: string; name: string } | null>(null);
  brainModelRef.current = brainModel;
  function pickBrainModel(m: { provider: string; name: string } | null) {
    setBrainModel(m);
    try {
      if (m) localStorage.setItem("os-oracle-brain-model", JSON.stringify(m));
      else localStorage.removeItem("os-oracle-brain-model");
    } catch { /* ignore */ }
    setModelMenu(false);
  }
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState("");
  const [oMode, setOMode] = useState<OracleMode>("dormant");
  const [voiceSetup, setVoiceSetup] = useState(false); // inline "connect voice" prompt card
  const [keyDraft, setKeyDraft] = useState("");        // inline OpenAI-key entry in the setup card
  const [connecting, setConnecting] = useState(false); // key → /__start_voice in flight
  const [setupErr, setSetupErr] = useState("");
  const [micMuted, setMicMuted] = useState(false);     // pause the mic without dropping the call
  // Persist a freshly-entered key to ~/.hermes/.env via /__start_voice (which
  // also boots voice-lab), THEN start the call. This makes voice "just work"
  // from the widget itself — no hop to the portal — and the key sticks across
  // ports/restarts so it never re-asks.
  async function connectWithKey() {
    const k = keyDraft.trim();
    if (!k || connecting) return;
    setConnecting(true);
    setSetupErr("");
    try {
      let token: string | null = null;
      try { const t = await fetch("/__token"); if (t.ok) token = (await t.json()).token ?? null; } catch { /* keyless */ }
      const r = await fetch("/__start_voice", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "X-Claude-OS-Token": token } : {}) },
        body: JSON.stringify({ key: k }),
      }).then((res) => res.json()).catch(() => null);
      if (!r || r.error) throw new Error(r?.error || "engine didn't start");
      try { localStorage.setItem("hermes-openai-key", k); } catch { /* ignore */ }
      setKeyDraft("");
      setVoiceSetup(false);
      await startVoice(); // engine is up + keyed now → connects straight through
    } catch (e: any) {
      setSetupErr(e?.message === "no_key" ? "That key was empty — paste your OpenAI key." : "Couldn't start the engine. Check the key and try again.");
    } finally {
      setConnecting(false);
    }
  }
  const inputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<string | null>(null);
  const seededRef = useRef(false);

  // ---- knowledge preload: live-data + Graphify registry, fetched once when
  // the panel first opens. Lets the widget answer instantly and gives Hermes
  // a grounded snapshot so it doesn't burn a tool loop rediscovering the OS.
  const knowledgeRef = useRef<string>("");
  const snapshotSentRef = useRef(false); // injected into the current call yet?
  const graphsRef = useRef<Array<{ id: string; name?: string; nodeCount?: number; edgeCount?: number; communities?: number; graphPath?: string }>>([]);
  // Push the verified snapshot into a live call exactly once per call. Called
  // both at dc.onopen AND when the async knowledge fetch lands — whichever is
  // later — so a fast mic press can't beat the snapshot to the line.
  const injectSnapshot = useCallback(() => {
    const dc = voice.current?.dc;
    if (snapshotSentRef.current || !knowledgeRef.current || !dc || dc.readyState !== "open") return;
    try {
      dc.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "system", content: [{ type: "input_text", text:
          `LIVE OS SNAPSHOT — verified by the dashboard seconds ago. Facts below are Hermes-grade truth: when a question is answerable from them, answer DIRECTLY (no ask_hermes call, no lead-in about looking it up). Anything beyond this snapshot still requires ask_hermes as normal.\n${knowledgeRef.current}` } ] },
      }));
      snapshotSentRef.current = true;
    } catch { /* snapshot is a nicety — the call works without it */ }
  }, []);
  const kbRef = useRef<OracleKB>({});
  const [hermesModel, setHermesModel] = useState<{ name: string; provider: string } | null>(null);
  useEffect(() => {
    if (!open || knowledgeRef.current) return;
    void (async () => {
      const lines: string[] = [];
      const kb: OracleKB = {};
      const [ldR, glR, hsR] = await Promise.allSettled([
        fetch("/__live-data").then((r) => r.json()),
        fetch("/__graphify_list").then((r) => r.json()),
        fetch("/__hermes_status").then((r) => r.json()),
      ]);
      if (ldR.status === "fulfilled") {
        const ld = ldR.value;
        const m = ld?.memory?.stats ?? {};
        if (ld?.summary) { kb.summary = JSON.stringify(ld.summary).slice(0, 400); lines.push(`Summary: ${kb.summary}`); }
        if (m.totalFiles) {
          kb.memory = { files: m.totalFiles, workspaces: m.totalWorkspaces, pinecone: m.pineconeIndexes ?? 0, freshness: m.freshness ?? "—" };
          lines.push(`Memory: ${m.totalFiles} files across ${m.totalWorkspaces} workspaces, ${m.pineconeIndexes ?? 0} Pinecone indexes, freshness ${m.freshness ?? "—"}.`);
        }
        if (Array.isArray(ld?.skills?.active)) { kb.skillsActive = ld.skills.active.length; lines.push(`Skills active: ${kb.skillsActive}.`); }
        const spend = ld?.summary?.spend28d ?? ld?.summary?.aiSpend;
        if (spend != null) kb.spend = String(spend);
        const ts = ld?.summary?.timeSavedLabel ?? ld?.timeSaved?.label;
        if (ts) kb.timeSaved = String(ts);
        if (ld?.hermes?.installed) {
          kb.hermes = { sessions: ld.hermes.sessionCount, personas: ld.hermes.personaCount, skills: ld.hermes.skillCount };
          lines.push(`Hermes: installed, ${ld.hermes.sessionCount ?? "?"} sessions, ${ld.hermes.personaCount ?? "?"} personas, ${ld.hermes.skillCount ?? "?"} skills.`);
        }
      }
      if (glR.status === "fulfilled") {
        const gl = glR.value;
        const graphs = Array.isArray(gl?.graphs) ? gl.graphs : Array.isArray(gl) ? gl : [];
        graphsRef.current = graphs;
        if (graphs.length) {
          lines.push(`Graphify code graphs registered: ${graphs
            .map((g: any) => `${g.name ?? g.id} (${g.nodeCount ?? "?"} files / ${g.edgeCount ?? "?"} edges${g.graphPath ? `, graph: ${g.graphPath}` : ""})`)
            .join("; ")}.`);
        }
        // Identify the OS's own graph so code-structure questions answer from
        // real AST data and Hermes gets the exact graphPath for deep queries.
        const self = graphs.find(isSelfGraph);
        if (self) {
          kb.osCode = {
            files: self.nodeCount ?? 0,
            edges: self.edgeCount ?? 0,
            modules: self.communities ?? 0,
            godNodes: (self.godNodes ?? []).map((n: any) => n?.name).filter(Boolean),
            graphPath: self.graphPath,
          };
          lines.push(`This dashboard's OWN code graph (Graphify, use for 'how is the OS built' questions): ${self.nodeCount} files, ${self.edgeCount} relationships, ${self.communities} modules. Most-connected files: ${kb.osCode.godNodes.slice(0, 6).join(", ")}.${self.graphPath ? ` Query it with: graphify explain "<file>" --graph ${self.graphPath}` : ""}`);
        } else {
          lines.push("This dashboard's own code is NOT graphed yet — to answer deep code-structure questions, offer to graph it (POST the repo path to /__graphify_ingest, or run `graphify update <repo>`).");
        }
      }
      if (hsR.status === "fulfilled" && hsR.value?.installed && hsR.value?.defaultModel) {
        setHermesModel({ name: hsR.value.defaultModel, provider: hsR.value.provider ?? "" });
        lines.push(`Hermes active model: ${hsR.value.defaultModel} via ${hsR.value.provider ?? "—"}.`);
      }
      kbRef.current = kb;
      knowledgeRef.current = lines.join("\n");
      injectSnapshot(); // call already live? land the snapshot now, not never
    })();
  }, [open, injectSnapshot]);

  // Instant client-side answers — navigation intents and "what graphs do I
  // have" never need a Hermes round-trip. Returns null to escalate.
  const localAnswer = useCallback((text: string): string | null => {
    const t = text.trim();
    if (NAV_INTENT.test(t)) {
      for (const h of NAV_HINTS) {
        if (h.match.test(t)) {
          const [pathname, search] = h.path.split("?");
          try { void router.navigate({ to: pathname || "/", search: search ? Object.fromEntries(new URLSearchParams(search)) : undefined } as any); } catch { /* ignore */ }
          return h.say;
        }
      }
    }
    // Action verbs always escalate — the KB is read-only knowledge, never a
    // substitute for actually doing something.
    if (/\b(edit|change|update|create|delete|run|save|write|fix|add|remove|install|search the web|email|schedule)\b/i.test(t)) return null;
    const kb = kbRef.current;
    if (/how('s| is| does)? (my )?memory|memory (look|health|fresh|status|doing)/i.test(t) && kb.memory) {
      return `Memory: ${kb.memory.files} files across ${kb.memory.workspaces} workspaces, ${kb.memory.pinecone} Pinecone indexes, freshness ${kb.memory.freshness}. Say "take me to my memory" for the full 3D map.`;
    }
    if (/status report|health check|how('s| is) (the|my) (os|operating system|system)|state of the (os|system)/i.test(t) && !/(built|structured|organi|made up|architecture|composed|put together)/i.test(t)) {
      const bits: string[] = [];
      if (kb.memory) bits.push(`memory holds ${kb.memory.files} files across ${kb.memory.workspaces} workspaces (freshness ${kb.memory.freshness})`);
      if (kb.skillsActive != null) bits.push(`${kb.skillsActive} skills active`);
      if (kb.hermes) bits.push(`Hermes online with ${kb.hermes.sessions ?? "?"} sessions and ${kb.hermes.personas ?? "?"} personas`);
      if (graphsRef.current.length) bits.push(`${graphsRef.current.length} code graph${graphsRef.current.length === 1 ? "" : "s"} registered`);
      if (kb.timeSaved) bits.push(`${kb.timeSaved} saved`);
      if (bits.length) return `All systems live: ${bits.join("; ")}. Ask about any of those for detail.`;
    }
    if (/(how many|what) skills/i.test(t) && kb.skillsActive != null) {
      return `${kb.skillsActive} skills are active right now. Say "take me to my skills" for the full inventory.`;
    }
    if (/what (graphs|code graphs)|which (repos|projects) (are )?graph/i.test(t) && graphsRef.current.length) {
      return `You have ${graphsRef.current.length} Graphify graph${graphsRef.current.length === 1 ? "" : "s"}: ${graphsRef.current.map((g) => g.name ?? g.id).join(", ")}. Want me to open the Knowledge Graph page?`;
    }
    // Code-structure questions — answered from the OS's OWN Graphify graph.
    if (kb.osCode) {
      if (/how big is (the )?(claude ?os|codebase|repo|dashboard|os|this)|how many (files|lines)|size of (the )?(codebase|os|repo)/i.test(t)) {
        return `The Claude OS codebase is ${kb.osCode.files} files with ${kb.osCode.edges} relationships across ${kb.osCode.modules} modules — straight from its Graphify code graph.`;
      }
      if (/(main|core|biggest|central|important|key|most.connected|hub) (part|module|file|piece|component)|architecture|how is (the |it )?(os|dashboard|this|codebase) (built|structured|organi)|structure of (the )?(code|os|repo)|what.*made (of|up)/i.test(t) && kb.osCode.godNodes.length) {
        return `The dashboard's most-connected files are ${kb.osCode.godNodes.slice(0, 5).join(", ")} — ${kb.osCode.godNodes[0]} is the hub. There are ${kb.osCode.modules} modules in all. Ask "explain <file>" and I'll have Hermes trace it in the graph.`;
      }
      if (/how many (modules|clusters|communit)/i.test(t)) {
        return `${kb.osCode.modules} modules (Graphify communities) across ${kb.osCode.files} files.`;
      }
    }
    if (/how big is (the )?(claude ?os|codebase|repo)/i.test(t) && graphsRef.current.length) {
      const g = graphsRef.current[0];
      return `${g.name ?? g.id}: ${g.nodeCount ?? "?"} files and ${g.edgeCount ?? "?"} code relationships in its AST graph.`;
    }
    if (/(what|which) model/i.test(t) && hermesModelRef.current) {
      return `The brain behind me is ${hermesModelRef.current.name} via ${hermesModelRef.current.provider || "Hermes"}. Voice runs on gpt-realtime; quick facts like this one come straight from my local knowledge base.`;
    }
    // Static OS manual — conceptual "what is / how does" questions about any
    // section. Ships in the app, so this works keyless for any installer.
    const manual = manualAnswer(t);
    if (manual) return manual;
    if (/^(what can you do|help)\??$/i.test(t)) {
      return "I'm the Oracle — your guide to this whole OS. Ask me about any page or feature, say \"take me to…\" and I'll navigate, or hand me a real job and I'll run it through Hermes. Voice or text, your call.";
    }
    return null;
  }, [router]);
  // ref mirror so localAnswer (stable callback) always reads the fresh model
  const hermesModelRef = useRef<{ name: string; provider: string } | null>(null);
  hermesModelRef.current = hermesModel;

  // ---- sync-back: keep Hermes up to date ----
  // After a conversation the Oracle pushes a digest of the new turns to Hermes
  // so its persistent memory reflects what the user asked and learned — even
  // for turns I answered locally. Fire-and-forget, background, deduped by a
  // high-water mark, and a no-op when Hermes isn't installed.
  const turnsRef = useRef<Turn[]>([]);
  useEffect(() => { turnsRef.current = turns; }, [turns]);
  const syncedCountRef = useRef(0);
  const syncToHermes = useCallback(() => {
    const all = turnsRef.current;
    if (!hermesModelRef.current) return;               // no Hermes → nothing to sync to
    if (all.length - syncedCountRef.current < 2) return; // need at least a Q+A of new material
    const fresh = all.slice(syncedCountRef.current);
    syncedCountRef.current = all.length;
    const transcript = fresh.map((t) => `${t.who === "you" ? "User" : "Oracle"}: ${t.text}`).join("\n");
    void (async () => {
      let token: string | null = null;
      try { const r = await fetch("/__token"); if (r.ok) token = (await r.json()).token ?? null; } catch { /* keyless */ }
      try {
        await fetch("/__hermes_chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(token ? { "X-Claude-OS-Token": token } : {}) },
          body: JSON.stringify({
            prompt: `[Oracle sync — do NOT reply conversationally] The user just interacted with the Oracle, your in-dashboard guide. Persist anything worth remembering (preferences, decisions, recurring questions, follow-ups). If nothing is worth saving, do nothing.\n\nTRANSCRIPT:\n${transcript}`,
            ...(sessionRef.current ? { sessionId: sessionRef.current } : {}),
            yolo: true,
          }),
        });
      } catch { /* sync is best-effort */ }
    })();
  }, []);

  // ---- capability chips: brand logos light up as Hermes touches things ----
  const [chips, setChips] = useState<Chip[]>([]);
  const fireChips = useCallback((data: string) => {
    const low = data.toLowerCase();
    const seen = new Set<string>();
    for (const [kw, app] of CHIP_MAP) {
      if (seen.has(app) || !low.includes(kw)) continue;
      seen.add(app);
      const id = app + "_" + Math.round(performance.now()) + "_" + Math.round(Math.random() * 1e6);
      setChips((c) => [...c.filter((x) => x.app !== app).slice(-9), { id, app, status: "running" }]);
      window.setTimeout(() => setChips((c) => c.map((x) => (x.id === id ? { ...x, status: "done" } : x))), 1700);
      window.setTimeout(() => setChips((c) => c.filter((x) => x.id !== id)), 5200);
    }
  }, []);

  // ---- ambient idle drive so the orb looks alive with no call running ----
  const [level, setLevel] = useState(0);
  const [callState, setCallState] = useState<"off" | "connecting" | "live">("off");
  const callStateRef = useRef(callState);
  callStateRef.current = callState;
  useEffect(() => {
    if (!enabled || callState === "live") return;
    const synth = new SyntheticVoice();
    let raf = 0, prev = performance.now(), lastSet = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) { prev = now; return; }
      const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
      const s = synth.tick(dt);
      if (now - lastSet > 60) { setLevel(s.level * 0.45); lastSet = now; }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [enabled, callState]);

  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [turns.length, caption, busy, chips.length]);

  // ---- navigation directives: execute <<nav:/path>> and strip from text ----
  const applyDirectives = useCallback((raw: string): string => {
    let out = raw;
    const m = raw.match(/<<\s*nav\s*:\s*([^>]+?)\s*>>/);
    if (m) {
      const target = m[1];
      out = raw.replace(/<<\s*nav\s*:\s*[^>]+?>>/g, "").replace(/\n{3,}/g, "\n\n").trim();
      try {
        const [pathname, search] = target.split("?");
        void router.navigate({ to: pathname || "/", search: search ? Object.fromEntries(new URLSearchParams(search)) : undefined } as any);
      } catch { /* bad path from the model — keep the text, skip the jump */ }
    }
    return out;
  }, [router]);

  // ---- the brain: typed + voice-tool turns both land here. Streams chunks
  // into the caption + fires chips live, so text mode feels as alive as voice.
  const askGuide = useCallback(async (request: string, opts?: { yolo?: boolean; stream?: boolean }): Promise<string> => {
    let token: string | null = null;
    try { const t = await fetch("/__token"); if (t.ok) token = (await t.json()).token ?? null; } catch { /* keyless demo */ }
    const seed = seededRef.current ? "" : `${guideSeed(router.state.location.pathname, knowledgeRef.current)}\n\n---\n\n`;
    setOMode("thinking");
    fireChips("running on claude");           // the brain lights up the moment a turn starts
    let response: Response;
    try {
      response = await fetch("/__hermes_chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "X-Claude-OS-Token": token } : {}) },
        body: JSON.stringify({
          prompt: `${seed}${request}`,
          ...(sessionRef.current ? { sessionId: sessionRef.current } : {}),
          ...(opts?.yolo ? { yolo: true } : {}),
          // Optional brain override picked in the widget's model switcher.
          ...(brainModelRef.current ? { model: brainModelRef.current.name, provider: brainModelRef.current.provider } : {}),
        }),
      });
    } catch {
      setOMode("dormant");
      return "I can't reach the Hermes brain right now — it powers my answers and actions. Start Hermes (or finish setup on the Hermes page) and I'll be right here.";
    }
    if (!response.ok || !response.body) { setOMode("dormant"); return "The agent endpoint returned an error — check that Hermes is installed and the dev server is running locally."; }
    seededRef.current = true;
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
          if (opts?.stream) { setOMode("talking"); setCaption(cleanReply(accumulated).replace(/<<\s*nav\s*:[^>]*>>/g, "").trim()); }
        } else if (eventName === "info" && data) {
          setOMode("working");                 // tool activity → orange, chips fire
          fireChips(data);
          const mm = data.match(/session_id:\s*([A-Za-z0-9_-]{6,})/);
          if (mm && mm[1]) sessionRef.current = mm[1];
        }
      }
    }
    fireChips(accumulated);                    // light anything Hermes named in the reply
    const cleaned = cleanReply(accumulated).trim() || "Done.";
    return applyDirectives(cleaned);
  }, [applyDirectives, fireChips, router]);

  async function sendText(e?: React.FormEvent, preset?: string) {
    e?.preventDefault();
    const text = (preset ?? draft).trim();
    if (!text || busy) return;
    setDraft("");
    setVoiceSetup(false);
    setTurns((t) => [...t.slice(-40), { who: "you", text }]);
    // zero-latency path: guide questions the widget can answer itself
    if (callState !== "live") {
      const instant = localAnswer(text);
      if (instant) { setTurns((t) => [...t.slice(-40), { who: "oracle", text: instant, via: "⚡ local KB" }]); return; }
    }
    const dc = voice.current?.dc;
    if (callState === "live" && dc && dc.readyState === "open") {
      try {
        dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }));
        dc.send(JSON.stringify({ type: "response.create" }));
      } catch { /* channel raced shut */ }
      return;
    }
    setBusy(true);
    const reply = await askGuide(text, { stream: true });
    setCaption("");
    setTurns((t) => [...t.slice(-40), { who: "oracle", text: reply, via: hermesModelRef.current ? `hermes · ${hermesModelRef.current.name}` : "hermes", apps: appsFromText(reply) }]);
    setBusy(false);
    setOMode(callStateRef.current === "live" ? "listening" : "dormant");
  }

  // Lazily load the model catalog the first time the switcher opens, so the
  // widget stays light until you actually want to change the brain.
  useEffect(() => {
    if (!modelMenu || modelCatalogState.length > 0) return;
    void (async () => {
      try {
        const d = await fetch("/__hermes_models").then((r) => r.json());
        const cfg = new Set<string>((d?.configured ?? []).map((s: string) => s.toLowerCase()));
        const flat: Array<{ provider: string; name: string }> = [];
        for (const g of d?.catalog ?? []) {
          if (cfg.size && !cfg.has(String(g.provider).toLowerCase())) continue;
          for (const m of g.models ?? []) flat.push({ provider: g.provider, name: m.name });
        }
        setModelCatalogState(flat.slice(0, 24));
      } catch { /* menu just shows "default" then */ }
    })();
  }, [modelMenu, modelCatalogState.length]);

  // ---- voice: same Realtime pipeline as the Intelligence portal ----
  const voice = useRef<any>({});
  const curAI = useRef("");
  async function startVoice() {
    if (callState !== "off") { endCall(); return; }
    let keyed = false;
    try {
      const h = await fetch(VOICE_HEALTH_URL).then((r) => r.json());
      keyed = !!h?.keyed;
    } catch { keyed = false; }
    let savedKey = "";
    try { savedKey = localStorage.getItem("hermes-openai-key") || ""; } catch { /* ignore */ }
    // If the local engine isn't already keyed and this browser has no saved
    // key, the key may STILL live in ~/.hermes/.env — set up once via this
    // widget, the Intelligence portal, or a shell export. Ask the dashboard
    // to boot voice-lab from that persisted key BEFORE prompting for setup,
    // so a fresh browser / new port / restart never re-asks. (localStorage is
    // per-port, but ~/.hermes/.env is the one durable home for the key.)
    if (!keyed) {
      try {
        let token: string | null = null;
        try { const t = await fetch("/__token"); if (t.ok) token = (await t.json()).token ?? null; } catch { /* keyless */ }
        const boot = await fetch("/__start_voice", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(token ? { "X-Claude-OS-Token": token } : {}) },
          body: JSON.stringify(savedKey ? { key: savedKey } : {}), // reload from ~/.hermes/.env, or use the saved key
        }).then((r) => r.json()).catch(() => null);
        if (boot && boot.keyed) { keyed = true; savedKey = ""; }
      } catch { /* fall through to setup */ }
      if (!keyed) { setVoiceSetup(true); return; }  // genuinely no key anywhere → prompt
    }
    setVoiceSetup(false);
    snapshotSentRef.current = false; // fresh call → fresh snapshot injection
    setCallState("connecting");
    try {
      const s = await fetch(VOICE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice: "sage", mode: "companion", ...(savedKey && !keyed ? { key: savedKey } : {}) }),
      }).then((r) => r.json());
      if (!s.value) throw new Error("no token");
      const pc = new RTCPeerConnection();
      const audio = new Audio(); audio.autoplay = true;
      const actx = new AudioContext();
      pc.ontrack = (ev) => {
        audio.srcObject = ev.streams[0]; audio.play().catch(() => {});
        const an = actx.createAnalyser(); an.fftSize = 256;
        actx.createMediaStreamSource(ev.streams[0]).connect(an);
        voice.current.aiAna = an;
      };
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      pc.addTrack(mic.getAudioTracks()[0], mic);
      const micAn = actx.createAnalyser(); micAn.fftSize = 256;
      actx.createMediaStreamSource(mic).connect(micAn);
      voice.current.micAna = micAn;
      const dc = pc.createDataChannel("oai-events");
      dc.onmessage = onVoiceEvent;
      dc.onopen = () => {
        setCallState("live"); setOMode("listening"); pumpVoice();
        // Clear any stale "couldn't start the voice line" failure from an
        // earlier attempt — the call is live now, so a lingering error bubble
        // is just confusing.
        setTurns((t) => t.filter((x) => !(x.who === "oracle" && x.text.startsWith("I couldn't start the voice line"))));
        setVoiceSetup(false);
        // Hand the call the dashboard's pre-verified snapshot (see
        // injectSnapshot — also fired when the async fetch lands, so a fast
        // mic press can't race past it).
        injectSnapshot();
      };
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      const ans = await fetch((s.base || "https://api.openai.com") + "/v1/realtime/calls?model=" + encodeURIComponent(s.model || "gpt-realtime"), {
        method: "POST", body: offer.sdp, headers: { Authorization: "Bearer " + s.value, "Content-Type": "application/sdp" },
      });
      await pc.setRemoteDescription({ type: "answer", sdp: await ans.text() } as any);
      voice.current = { ...voice.current, pc, dc, mic, actx, audio };
    } catch {
      setCallState("off"); setOMode("dormant");
      setTurns((t) => [...t, { who: "oracle", text: "I couldn't start the voice line — the local voice engine didn't answer. Open voice setup below and I'll get you connected." }]);
      setVoiceSetup(true);
    }
  }
  function endCall() {
    const v = voice.current;
    try { cancelAnimationFrame(v.raf); v.dc?.close(); v.pc?.close(); v.mic?.getTracks?.().forEach((t: any) => t.stop()); v.actx?.close?.(); } catch { /* teardown is best-effort */ }
    voice.current = {};
    snapshotSentRef.current = false;
    setCallState("off"); setLevel(0); setCaption(""); setOMode("dormant"); setMicMuted(false);
    syncToHermes(); // persist what the call surfaced back to Hermes' memory
  }
  // Pause/resume the mic without tearing the call down — disables the audio
  // track so nothing you say is sent, but the model can still finish speaking
  // and the line stays open.
  function toggleMute() {
    const track = voice.current?.mic?.getAudioTracks?.()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicMuted(!track.enabled);
    if (!track.enabled) setOMode("dormant");
  }
  function onVoiceEvent(e: MessageEvent) {
    let m: any; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === "input_audio_buffer.speech_started") setOMode("listening");
    else if (m.type === "input_audio_buffer.speech_stopped") setOMode("thinking");
    else if (m.type === "conversation.item.input_audio_transcription.completed") {
      if (m.transcript?.trim()) setTurns((t) => [...t.slice(-40), { who: "you", text: m.transcript.trim() }]);
      setCaption("");
    } else if (m.type === "response.created") { curAI.current = ""; setOMode("thinking"); }
    else if (m.type === "response.audio_transcript.delta" || m.type === "response.output_audio_transcript.delta") {
      setOMode("talking"); curAI.current += m.delta || ""; setCaption(curAI.current);
    } else if (m.type === "response.done") {
      const out = m.response?.output || [];
      const calls = out.filter((o: any) => o.type === "function_call");
      if (calls.length) { for (const c of calls) void handleToolCall(c); return; }
      let finalText = curAI.current.trim();
      if (!finalText) { for (const it of out) for (const ct of (it.content || [])) if (ct && ct.transcript) finalText = (finalText + " " + ct.transcript).trim(); }
      if (finalText) { const clean = applyDirectives(finalText); setTurns((t) => [...t.slice(-40), { who: "oracle", text: clean, apps: appsFromText(finalText) }]); }
      curAI.current = ""; setCaption(""); setOMode("listening");
    }
  }
  // realtime called a tool → run it, feed the result back for the model to speak.
  async function handleToolCall(c: any) {
    const dc = voice.current?.dc;
    const reply = (out: string) => {
      if (dc && dc.readyState === "open") {
        try {
          dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output: String(out).slice(0, 4000) } }));
          dc.send(JSON.stringify({ type: "response.create", response: { tool_choice: "none" } }));
        } catch { /* channel closed mid-call */ }
      }
      setCaption("");
    };

    // navigate → move the dashboard for real, then tell the model it's done.
    if (c.name === "navigate") {
      let path = "";
      try { path = String(JSON.parse(c.arguments || "{}").path || "").trim(); } catch { /* malformed */ }
      const known = SITE_MAP.some((r) => r.path === path);
      if (path && (known || path.startsWith("/"))) {
        const [pathname, search] = path.split("?");
        try {
          void router.navigate({ to: pathname || "/", search: search ? Object.fromEntries(new URLSearchParams(search)) : undefined } as any);
        } catch { /* ignore */ }
        fireChips(`navigate ${path}`);
        reply(`Navigated to ${path}. Tell the user you've taken them there.`);
      } else {
        reply("That page doesn't exist. Ask the user which section they meant.");
      }
      return;
    }

    // ask_hermes (default) → run the REAL agent, feed the result back to speak.
    let request = "";
    try { request = JSON.parse(c.arguments || "{}").request || ""; } catch { /* malformed args */ }
    setOMode("working"); setCaption("· checking with Hermes …");
    let result = "I couldn't reach the agent.";
    try { if (request) result = await askGuide(request, { yolo: true }); } catch { /* surfaced via fallback text */ }
    reply(result);
  }
  function pumpVoice() {
    const rms = (an: any) => {
      if (!an) return 0;
      const d = new Uint8Array(an.fftSize); an.getByteTimeDomainData(d);
      let s = 0; for (let i = 0; i < d.length; i++) { const x = (d[i] - 128) / 128; s += x * x; }
      return Math.min(1, Math.sqrt(s / d.length) * 4);
    };
    const loop = () => {
      if (!voice.current.dc) return;
      const combined = Math.max(rms(voice.current.aiAna), rms(voice.current.micAna));
      voice.current.sm = (voice.current.sm || 0) * 0.8 + combined * 0.2;
      setLevel(Math.min(1, Math.max(0, voice.current.sm - 0.08) * 1.8));
      voice.current.raf = requestAnimationFrame(loop);
    };
    loop();
  }
  useEffect(() => () => endCall(), []);
  useEffect(() => { if (!enabled && callStateRef.current !== "off") endCall(); }, [enabled]);

  if (!enabled) return null;

  const orbColor = MODE_COLOR[oMode];
  const live = callState === "live";
  const statusLabel = callState === "connecting" ? "connecting…" : live ? `live · ${MODE_LABEL[oMode]}` : oMode === "dormant" ? MODE_LABEL.dormant : MODE_LABEL[oMode];

  return (
    <div className="fixed bottom-5 right-5 z-40 flex flex-col items-end gap-3" style={{ maxWidth: "min(384px, calc(100vw - 2rem))" }}>
      {open && (
        <div
          className="w-[384px] max-w-full rounded-2xl border border-border bg-card/95 shadow-2xl backdrop-blur-md overflow-hidden flex flex-col"
          style={{ height: "min(560px, calc(100vh - 8rem))", boxShadow: `0 24px 64px rgba(0,0,0,0.55), 0 0 40px -18px ${orbColor}`, transition: "box-shadow .5s" }}
        >
          {/* header — label + glow follow the state grammar */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
            <div className="h-9 w-9 shrink-0 rounded-full overflow-hidden" style={{ boxShadow: `0 0 16px -4px ${orbColor}`, transition: "box-shadow .5s" }}>
              <OraclePlasma level={level} mode={oMode === "dormant" ? "idle" : oMode} color={orbColor} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold tracking-tight">Oracle</span>
                {/* Model switcher — shows the brain the text turns route to and
                    lets you change it without leaving the widget. Voice audio
                    is always gpt-realtime; this picks the ask_hermes brain. */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setModelMenu((v) => !v)}
                    title="Brain for text answers — click to switch. Voice audio is always gpt-realtime."
                    className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[9px] hover:border-foreground/40 transition-colors"
                    style={{ color: brainModel ? TEAL : undefined }}
                  >
                    <span className="max-w-[110px] truncate">
                      {shortName(brainModel?.name ?? hermesModel?.name ?? "default brain")}
                    </span>
                    <ChevronDown className="h-2.5 w-2.5 opacity-60" />
                  </button>
                  {modelMenu && (
                    <div
                      className="absolute left-0 top-full mt-1 z-50 w-56 max-h-64 overflow-y-auto rounded-lg border border-border bg-card shadow-2xl py-1"
                      style={{ boxShadow: "0 18px 50px rgba(0,0,0,0.6)" }}
                    >
                      <button
                        type="button"
                        onClick={() => pickBrainModel(null)}
                        className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-accent transition-colors flex items-center justify-between"
                      >
                        <span>Hermes default{hermesModel ? ` · ${shortName(hermesModel.name)}` : ""}</span>
                        {!brainModel && <span style={{ color: TEAL }}>✓</span>}
                      </button>
                      {modelCatalogState.map((m) => {
                        const active = brainModel?.name === m.name && brainModel?.provider === m.provider;
                        return (
                          <button
                            key={`${m.provider}-${m.name}`}
                            type="button"
                            onClick={() => pickBrainModel(m)}
                            className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-accent transition-colors flex items-center justify-between gap-2"
                          >
                            <span className="truncate">{shortName(m.name)}</span>
                            {active && <span style={{ color: TEAL }}>✓</span>}
                          </button>
                        );
                      })}
                      {modelCatalogState.length === 0 && (
                        <div className="px-3 py-2 text-[10px] text-muted-foreground">loading models…</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="text-[10px] uppercase tracking-[0.18em] truncate" style={{ color: oMode === "dormant" ? undefined : orbColor, transition: "color .4s" }}>
                <span className={oMode === "dormant" ? "text-muted-foreground" : ""}>{statusLabel}</span>
                <span className="text-muted-foreground/60">{" "}· {live ? "voice" : "text"}</span>
              </div>
            </div>
            {/* X = minimize to the orb. Everything keeps running (a live call
                stays live — the red dot on the orb shows it). Fully hiding
                the Oracle lives on the header's teal dot only, so a stray X
                can never make the whole thing vanish. */}
            <button onClick={() => { setOpen(false); syncToHermes(); }} title="Minimize to orb — I keep running" className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* transcript */}
          <div ref={transcriptRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {turns.length === 0 && !caption && !voiceSetup && (
              <div className="space-y-3">
                {/* mode chooser — voice line or text chat, same brain either way */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => void startVoice()}
                    className="rounded-xl border border-border/70 bg-background/40 px-3 py-3.5 text-left hover:border-foreground/25 hover:bg-accent transition-colors"
                  >
                    <Mic className="h-4 w-4 mb-1.5" style={{ color: TEAL }} />
                    <div className="text-xs font-semibold">Voice line</div>
                    <div className="text-[10px] text-muted-foreground leading-snug mt-0.5">Talk live — zero-latency, hands-free</div>
                  </button>
                  <button
                    onClick={() => inputRef.current?.focus()}
                    className="rounded-xl border border-border/70 bg-background/40 px-3 py-3.5 text-left hover:border-foreground/25 hover:bg-accent transition-colors"
                  >
                    <Keyboard className="h-4 w-4 mb-1.5 text-muted-foreground" />
                    <div className="text-xs font-semibold">Text chat</div>
                    <div className="text-[10px] text-muted-foreground leading-snug mt-0.5">Type instead — private, no voice account</div>
                  </button>
                </div>
                <div className="flex flex-col gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => void sendText(undefined, s)}
                      className="text-left text-xs rounded-lg border border-border/70 bg-background/40 px-3 py-2 text-foreground/85 hover:border-foreground/25 hover:bg-accent transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`flex flex-col ${t.who === "you" ? "items-end" : "items-start"}`}>
                <div className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${t.who === "you" ? "bg-foreground/10 text-foreground" : "bg-background/60 border border-border/60 text-foreground/90"}`}>
                  {t.text}
                  {t.who === "oracle" && t.via && (
                    <div className="mt-1 text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">{t.via}</div>
                  )}
                </div>
                {/* apps used — the real capabilities this answer touched, sitting
                    under the message and staying put (no fade). */}
                {t.who === "oracle" && t.apps && t.apps.length > 0 && (
                  <div className="mt-1.5 flex items-center gap-1.5 flex-wrap max-w-[85%]">
                    <span className="text-[8.5px] uppercase tracking-[0.18em] text-muted-foreground/55 shrink-0">apps used</span>
                    {t.apps.map((app) => {
                      const meta = CHIP_ICON[app];
                      return (
                        <span
                          key={app}
                          title={meta?.name ?? app}
                          className="inline-flex items-center gap-1 rounded-md pl-1 pr-1.5 py-0.5 shrink-0"
                          style={{ background: "rgba(10,24,22,0.55)", border: `1px solid ${(meta?.color ?? TEAL)}44` }}
                        >
                          <span className="grid place-items-center h-3.5 w-3.5"><ChipIcon app={app} /></span>
                          <span className="text-[8.5px] text-foreground/70">{meta?.name ?? app}</span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
            {(busy || caption) && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap bg-background/60 border text-foreground/80" style={{ borderColor: `${orbColor}44` }}>
                  {caption || <span className="italic text-foreground/60">thinking…</span>}
                </div>
              </div>
            )}
            {voiceSetup && (
              <div className="rounded-xl border px-3.5 py-3 space-y-2" style={{ borderColor: `${TEAL}55`, background: "rgba(123,224,200,0.06)" }}>
                <div className="text-xs font-semibold">Connect voice</div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Paste your OpenAI key once — it's saved on this machine (<span className="hermes-mono">~/.hermes/.env</span>) and
                  reused everywhere after, so I won't ask again.
                </p>
                <form
                  onSubmit={(e) => { e.preventDefault(); void connectWithKey(); }}
                  className="flex items-center gap-2"
                >
                  <input
                    type="password"
                    value={keyDraft}
                    onChange={(e) => { setKeyDraft(e.target.value); setSetupErr(""); }}
                    placeholder="sk-…"
                    autoComplete="off"
                    spellCheck={false}
                    className="flex-1 min-w-0 rounded-full border border-border/70 bg-background/50 px-3 py-1.5 text-[11px] hermes-mono outline-none focus:border-foreground/30"
                  />
                  <button
                    type="submit"
                    disabled={!keyDraft.trim() || connecting}
                    className="rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-40 shrink-0"
                    style={{ background: "rgba(123,224,200,0.15)", color: TEAL }}
                  >
                    {connecting ? "Connecting…" : "Connect"}
                  </button>
                </form>
                {setupErr && <div className="text-[10px]" style={{ color: "#fca5a5" }}>{setupErr}</div>}
                <div className="flex items-center gap-3 pt-0.5">
                  <button
                    onClick={() => { setVoiceSetup(false); void router.navigate({ to: "/agents/hermes", search: { intel: "1" } as any }); }}
                    className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                    title="Full guided setup — includes local-model / custom base-url options"
                  >
                    guided setup
                  </button>
                  <button onClick={() => setVoiceSetup(false)} className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                    not now
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* capability chips — real brand logos pulse while Hermes touches them */}
          {/* input row */}
          <form onSubmit={sendText} className="flex items-center gap-2 border-t border-border px-3 py-3 shrink-0">
            {live ? (
              <>
                {/* pause mic — mute without dropping the call */}
                <button
                  type="button"
                  onClick={toggleMute}
                  title={micMuted ? "Un-mute your mic" : "Pause your mic — the call stays open"}
                  className="rounded-full p-2 transition-colors shrink-0"
                  style={{
                    background: micMuted ? "rgba(251,191,36,0.16)" : "rgba(123,224,200,0.10)",
                    color: micMuted ? "#fbbf24" : TEAL,
                  }}
                >
                  {micMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </button>
                {/* stop the conversation — end the call */}
                <button
                  type="button"
                  onClick={endCall}
                  title="End the call"
                  className="rounded-full p-2 transition-colors shrink-0"
                  style={{ background: "rgba(255,90,90,0.14)", color: "#ff8a8a", boxShadow: "0 0 14px -4px #ff5a5a" }}
                >
                  <Square className="h-4 w-4" />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void startVoice()}
                title={callState === "connecting" ? "Connecting…" : "Start the voice line"}
                className="rounded-full p-2 transition-colors shrink-0"
                style={{ background: "rgba(123,224,200,0.10)", color: TEAL }}
              >
                <Mic className="h-4 w-4" />
              </button>
            )}
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={live ? "Type into the live call…" : "Ask, or say where to go…"}
              className="flex-1 min-w-0 rounded-full border border-border/70 bg-background/50 px-3.5 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-foreground/30"
            />
            <button type="submit" disabled={!draft.trim() || busy} className="rounded-full p-2 text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors shrink-0">
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      )}

      {/* the docked orb — a soft glowing sphere. No hard clip ring: the plasma
          sits in a transparent canvas and a radial halo behind it fades into
          the page, so the orb reads as light, not a bordered disc. */}
      <button
        onClick={() => setOpen((v) => !v)}
        title={open ? "Collapse the Oracle" : "Open the Oracle — your OS guide"}
        className="relative grid place-items-center h-24 w-24 rounded-full transition-transform hover:scale-105"
        style={{ background: "transparent", transition: "transform .3s" }}
      >
        {/* soft radial halo — the glow that used to get clipped, now free */}
        <span
          aria-hidden
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            background: `radial-gradient(circle at 50% 50%, ${orbColor}44 0%, ${orbColor}18 42%, transparent 70%)`,
            filter: "blur(2px)",
            transition: "background .5s",
          }}
        />
        {/* the sphere itself — slightly inset so the halo reads around it */}
        <span className="relative h-[86px] w-[86px] rounded-full overflow-hidden" style={{ boxShadow: `0 8px 24px rgba(0,0,0,0.45), 0 0 30px -8px ${orbColor}` }}>
          <OraclePlasma level={level} mode={oMode === "dormant" ? "idle" : oMode} color={orbColor} />
        </span>
        {live && (
          <span aria-hidden className="absolute top-2 right-2 h-2.5 w-2.5 rounded-full" style={{ background: "#ff5a5a", boxShadow: "0 0 10px rgba(255,90,90,0.95)", border: "1.5px solid rgba(10,20,18,0.8)" }} />
        )}
      </button>
    </div>
  );
}

export default FloatingOracle;
