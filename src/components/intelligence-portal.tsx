import { useCallback, useEffect, useRef, useState } from "react";
import { X, Mic, MicOff, Square, Send, Settings2, Play, Keyboard, Zap } from "lucide-react";
import { HermesMind3D, CL, type CoreMode } from "@/components/hermes-mind-3d";
import { OraclePlasma } from "@/components/oracle-plasma";
import { OracleSonar } from "@/components/oracle-sonar";
import { OracleWaveform } from "@/components/oracle-waveform";
import { OracleRider } from "@/components/oracle-rider";
import { StageAurora } from "@/components/stage-aurora";
import { StageCosmos } from "@/components/stage-cosmos";
import { SyntheticVoice } from "@/lib/synthetic-voice";
import labyrinth from "@/assets/hermes-art/06-labyrinth.webp";
import hermesLogo from "@/assets/hermes-agent.png";
import hermesAvatar from "@/assets/hermes-portrait-v2.png";

const CREAM = "#FFE6CB";
const TEAL = "#7be0c8";
const GREEN = "#46e0a0";
const VOICE_TOKEN_URL = "http://localhost:8099/api/session";

export type IntelState = "idle" | "thinking" | "responding";
export type AppKey = string;
export type ActivityEvent = { id: string; app: AppKey; status: "running" | "done" | "error"; detail?: string; result?: string; error?: string };

// Real brand marks Simple Icons dropped for trademark — baked so they never fall back to text
const LINKEDIN = `<svg viewBox="0 0 24 24" fill="currentColor" style="width:100%;height:100%"><path d="M4.98 3.5A2.5 2.5 0 1 1 2.5 6 2.5 2.5 0 0 1 4.98 3.5zM2.85 8.98h4.2v12.5h-4.2zM9.3 8.98h4.02v1.71h.06a4.4 4.4 0 0 1 3.96-2.18c4.24 0 5.02 2.79 5.02 6.42v6.55h-4.18v-5.8c0-1.39-.03-3.17-1.93-3.17s-2.23 1.51-2.23 3.07v5.9H9.3z"/></svg>`;
const CLAY = `<svg viewBox="0 0 24 24" style="width:100%;height:100%"><path d="M3 16a9 9 0 0 1 18 0z" fill="currentColor"/></svg>`;

type IconDef = { face?: boolean; lucide?: any; slug?: string; domain?: string; glyph?: string; color: string; letter: string };
// brands → real favicon (true colours + white parts) on a light tile
// concepts (Hermes's OWN native powers) → the Hermes face, ringed in its cluster colour — so they sit as medallions next to the brand logos
const ICONS: Record<string, IconDef> = {
  github: { domain: "github.com", color: "#FFFFFF", letter: "GH" },
  reddit: { domain: "reddit.com", color: "#ff4500", letter: "R" },
  linkedin: { domain: "linkedin.com", color: "#0a66c2", letter: "in" },
  x: { domain: "x.com", color: "#FFFFFF", letter: "X" },
  clay: { domain: "clay.com", color: "#FFD21E", letter: "Cl" },
  web: { face: true, color: "#60a5fa", letter: "W" },
  youtube: { domain: "youtube.com", color: "#ff3b3b", letter: "YT" },
  notion: { domain: "notion.so", color: "#FFFFFF", letter: "N" },
  drive: { domain: "drive.google.com", color: "#46e0a0", letter: "Dr" },
  obsidian: { domain: "obsidian.md", color: "#a78bfa", letter: "Ob" },
  supabase: { domain: "supabase.com", color: "#3ecf8e", letter: "Sb" },
  granola: { domain: "granola.ai", color: "#FFE6CB", letter: "Gr" },
  memory: { face: true, color: "#ff9da7", letter: "M" },
  pinecone: { domain: "pinecone.io", color: "#ff9da7", letter: "Pc" },
  claude: { domain: "claude.ai", color: "#ff8a3c", letter: "Cl" },
  gemini: { domain: "gemini.google.com", color: "#60a5fa", letter: "Gm" },
  codex: { domain: "openai.com", color: "#FFFFFF", letter: "AI" },
  agents: { face: true, color: "#b9a6ff", letter: "Ag" },
  writing: { face: true, color: "#ff5a7a", letter: "Wr" },
  elevenlabs: { domain: "elevenlabs.io", color: "#FFFFFF", letter: "11" },
  higgsfield: { domain: "higgsfield.ai", color: "#c8ff00", letter: "Hg" },
  notebooklm: { domain: "notebooklm.google.com", color: "#60a5fa", letter: "NB" },
  telegram: { domain: "telegram.org", color: "#2aabee", letter: "Tg" },
  email: { glyph: `<svg viewBox="0 0 24 24" fill="#EA4335" style="width:100%;height:100%"><path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/></svg>`, color: "#EA4335", letter: "@" },
  calendar: { glyph: `<svg viewBox="0 0 24 24" fill="#4285F4" style="width:100%;height:100%"><path d="M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z"/></svg>`, color: "#4285F4", letter: "Ca" },
  slack: { domain: "slack.com", color: "#e8d7c8", letter: "Sl" },
  code: { face: true, color: "#ff8a3c", letter: "</>" },
  cron: { face: true, color: "#ff8a3c", letter: "Cr" },
  n8n: { domain: "n8n.io", color: "#ea4b71", letter: "n8" },
  zapier: { domain: "zapier.com", color: "#ff4f00", letter: "Z" },
  mcp: { face: true, color: "#ff8a3c", letter: "MCP" },
  skills: { face: true, color: "#ff8a3c", letter: "Sk" },
};

const CLUSTER_CAPS: Record<string, string[]> = {
  research: ["github", "reddit", "linkedin", "x", "clay", "web", "youtube"],
  knowledge: ["notion", "drive", "obsidian", "supabase", "granola"],
  memory: ["memory", "pinecone"],
  thinking: ["claude", "gemini", "codex", "agents"],
  creation: ["writing", "elevenlabs", "higgsfield", "notebooklm"],
  comms: ["telegram", "email", "calendar", "slack"],
  action: ["code", "cron", "n8n", "zapier", "mcp", "skills"],
};
const CLUSTER_OF: Record<string, string> = {};
for (const [cl, caps] of Object.entries(CLUSTER_CAPS)) for (const c of caps) CLUSTER_OF[c] = cl;
const CAP_COUNT = Object.values(CLUSTER_CAPS).reduce((n, a) => n + a.length, 0);
const CLUSTER_COLOR: Record<string, string> = {}; for (const c of CL) CLUSTER_COLOR[c.key] = c.color;
const DOCK = CL.map((c) => ({ key: c.key, label: c.label, color: c.color, caps: CLUSTER_CAPS[c.key] ?? [] }));
const NAMES: Record<string, string> = {
  github: "GitHub", reddit: "Reddit", linkedin: "LinkedIn", x: "X / Twitter", clay: "Clay", web: "Web Search", youtube: "YouTube",
  notion: "Notion", drive: "Google Drive", obsidian: "Obsidian", supabase: "Supabase", granola: "Granola",
  memory: "Memory Core", pinecone: "Pinecone",
  claude: "Claude", gemini: "Gemini", codex: "Codex", agents: "Sub-agents",
  writing: "Writing", elevenlabs: "ElevenLabs", higgsfield: "Higgsfield", notebooklm: "NotebookLM",
  telegram: "Telegram", email: "Gmail", calendar: "Calendar", slack: "Slack",
  code: "Code / Bash", cron: "Schedule", n8n: "n8n", zapier: "Zapier", mcp: "MCP Tools", skills: "Skills",
};
const VOICES = [
  { id: "cedar", label: "Cedar", vibe: "warm · natural" },
  { id: "marin", label: "Marin", vibe: "bright · friendly" },
  { id: "alloy", label: "Alloy", vibe: "neutral · clear" },
  { id: "ash", label: "Ash", vibe: "calm · low" },
  { id: "coral", label: "Coral", vibe: "lively · warm" },
  { id: "sage", label: "Sage", vibe: "soft · measured" },
  { id: "verse", label: "Verse", vibe: "expressive" },
  { id: "ballad", label: "Ballad", vibe: "gentle" },
];
const SAMPLE_URL = "http://localhost:8099/api/sample";

// robust icon: Lucide concept icon · Simple Icons vector → DuckDuckGo real favicon → lettermark
function Cap({ cap }: { cap: string }) {
  const m: IconDef = ICONS[cap] || { color: CREAM, letter: "?" };
  const [err, setErr] = useState(false);
  if (m.face) return <img className="face" src={hermesAvatar} alt="" draggable={false} />;
  if (m.lucide) { const I = m.lucide; return <I className="ico" color={m.color} strokeWidth={2} style={{ width: "100%", height: "100%" }} />; }
  if (m.glyph) return <span className="fav" style={{ display: "grid", placeItems: "center", padding: 3 }} dangerouslySetInnerHTML={{ __html: m.glyph }} />;
  // real brand favicon (true colours + white parts) on a light app-tile
  if (m.domain && !err) return <img className="fav" src={`https://icons.duckduckgo.com/ip3/${m.domain}.ico`} alt="" onError={() => setErr(true)} />;
  if (m.slug && !err) return <img className="ico" src={`https://cdn.simpleicons.org/${m.slug}/${m.color.replace("#", "")}`} alt="" onError={() => setErr(true)} style={{ width: "100%", height: "100%", objectFit: "contain" }} />;
  return <span className="lettermark" style={{ color: m.color }}>{m.letter}</span>;
}

type Live = { status: "running" | "done" | "error"; result?: string; error?: string; n: number };

export function IntelligencePortal({ state, events, demo = true, onVoiceRequest, onClose }: { state: IntelState; events?: ActivityEvent[]; demo?: boolean; onVoiceRequest?: (request: string, opts?: { sessionId?: string; context?: string; save?: boolean; yolo?: boolean; voice?: boolean }) => Promise<string>; onClose: () => void }) {
  const [active, setActive] = useState<Record<string, Live | undefined>>({});
  const [recent, setRecent] = useState<{ id: string; app: string; result?: string; error?: string }[]>([]);
  const [hoverCap, setHoverCap] = useState<{ name: string; x: number; y: number; color: string } | null>(null);
  const [callState, setCallState] = useState<"off" | "connecting" | "live">("off");
  const [directMode, setDirectMode] = useState(false);  // Companion: instant ack, THEN calls Hermes (feels fast). ⚡ toggle for every-turn-Hermes.
  const groupN = useRef<Record<string, number>>({});
  // domino plays once on mount, then nv-in is dropped so live re-renders can't restart it (which froze chips mid-scale)
  const [entered, setEntered] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setEntered(true), 1250); return () => window.clearTimeout(t); }, []);
  // hovering a strip logo lights its cluster's branch in the graph
  const [hoverCluster, setHoverCluster] = useState<string | null>(null);
  const [nodeMode, setNodeMode] = useState<"atlas" | "plasma" | "sonar" | "waveform" | "rider">("atlas");
  // full-view ART DIRECTION — Aurora (warm) · Cosmos (cosmic) · Classic (3D Atlas + orbs). Persisted + ?design= override.
  const [design, setDesign] = useState<"classic" | "aurora" | "cosmos">(() => {
    try {
      const u = new URLSearchParams(window.location.search).get("design");
      if (u === "classic" || u === "aurora" || u === "cosmos") return u;
      const s = localStorage.getItem("hermes-intel-design");
      if (s === "classic" || s === "aurora" || s === "cosmos") return s;
    } catch { /* SSR / privacy mode */ }
    return "aurora";
  });
  useEffect(() => { try { localStorage.setItem("hermes-intel-design", design); } catch { /* ignore */ } }, [design]);
  // synthetic state reported up from the attract-mode stages → keeps the HUD label/telemetry coherent
  // attract-mode synthetic drive (level + state) so the reactive visuals look alive with no live call
  const [attractLevel, setAttractLevel] = useState(0);
  const [attractState, setAttractState] = useState<CoreMode>("dormant");
  const [engineUp, setEngineUp] = useState(false);     // is the local voice engine reachable?
  const [engineKeyed, setEngineKeyed] = useState(false); // …and does it already hold a key?
  // cinematic boot reveal — replays when the view opens or the design changes
  const [showBoot, setShowBoot] = useState(true);
  useEffect(() => { setShowBoot(true); const tb = window.setTimeout(() => setShowBoot(false), 2000); return () => window.clearTimeout(tb); }, [design]);
  // check the voice engine's health on open so the chat setup card + Talk button know if it's ready
  // (startVoice / connectWithKey re-check freshly on each attempt)
  useEffect(() => { let alive = true; fetch("http://localhost:8099/api/health").then((r) => r.json()).then((h) => { if (alive) { setEngineUp(true); setEngineKeyed(!!h?.keyed); } }).catch(() => { if (alive) setEngineUp(false); }); return () => { alive = false; }; }, []);
  // drive the synthetic attract signal — paused when hidden, in a live call, or on the calm Atlas
  useEffect(() => {
    if (!(demo && callState !== "live")) { setAttractLevel(0); setAttractState("dormant"); return; }
    const synth = new SyntheticVoice();
    let raf = 0, prev = performance.now(), lastSet = 0, lastMode = "";
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) { prev = now; return; }
      const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
      const s = synth.tick(dt);
      if (now - lastSet > 45) { setAttractLevel(s.level); lastSet = now; }  // ~22fps; orbs smooth between
      if (s.mode !== lastMode) { lastMode = s.mode; setAttractState(s.mode); }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [demo, callState, design, nodeMode]);
  // draggable divider → resize the chat panel
  const [chatW, setChatW] = useState(272);
  const dragW = useRef(false);
  useEffect(() => {
    const mm = (e: MouseEvent) => { if (dragW.current) setChatW((w) => Math.max(212, Math.min(640, w + e.movementX))); };
    const mu = () => { if (dragW.current) { dragW.current = false; document.body.style.cursor = ""; document.body.style.userSelect = ""; } };
    window.addEventListener("mousemove", mm); window.addEventListener("mouseup", mu);
    return () => { window.removeEventListener("mousemove", mm); window.removeEventListener("mouseup", mu); };
  }, []);

  const ignite = (app: string, _detail?: string) => {
    if (!ICONS[app]) return;
    groupN.current[app] = (groupN.current[app] ?? 0) + 1;
    setActive((a) => ({ ...a, [app]: { status: "running", n: groupN.current[app] } }));
  };
  const settle = (app: string, ok: boolean, result?: string, error?: string) => {
    if (!ICONS[app]) return;
    setActive((a) => ({ ...a, [app]: { ...(a[app] ?? { n: 1 }), status: ok ? "done" : "error", result, error } as Live }));
    setRecent((r) => [...r.slice(-6), { id: app + "_" + Math.round(performance.now()), app, result, error }]);
    window.setTimeout(() => setActive((a) => { const n = { ...a }; delete n[app]; groupN.current[app] = 0; return n; }), ok ? 4000 : 6500);
  };

  // the "piano cascade" — light every capability in sequence (replays the domino sweep on demand)
  function playCascade() {
    const caps = DOCK.flatMap((d) => d.caps);
    caps.forEach((cap, i) => {
      window.setTimeout(() => { ignite(cap); window.setTimeout(() => settle(cap, true), 620); }, i * 46);
    });
  }

  const seen = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!events) return;
    for (const e of events) { const k = e.id + e.status; if (seen.current.has(k)) continue; seen.current.add(k); if (e.status === "running") ignite(e.app, e.detail); else settle(e.app, e.status === "done", e.result, e.error); }
  }, [events]);

  useEffect(() => {
    if (!demo || callState === "live") return;  // never run the demo reel during a real voice call
    let alive = true; let timers: number[] = [];
    const seq = () => {
      const s: [number, () => void][] = []; let t = 0;
      const f = (app: string, dur: number, res?: string, err?: string) => { s.push([t += 850, () => alive && ignite(app)]); s.push([t += dur, () => alive && settle(app, !err, res, err)]); };
      f("web", 1700, "12 results");
      s.push([t += 200, () => { if (alive) { ignite("github"); ignite("claude"); } }]);
      s.push([t += 2200, () => { if (alive) { settle("github", true, "3 repos"); settle("claude", true, "reasoned"); } }]);
      f("memory", 1500, "5 hits");
      f("notion", 1500, "updated");
      f("writing", 1700, "drafted");
      f("telegram", 1500, "sent");
      timers = s.map(([ms, fn]) => window.setTimeout(fn, ms));
      timers.push(window.setTimeout(seq, t + 3400));
    };
    seq();
    return () => { alive = false; timers.forEach(clearTimeout); };
  }, [demo, callState]);

  // ---- voice (OpenAI Realtime via voice-lab token) ----
  const [turns, setTurns] = useState<{ who: "you" | "hermes"; text: string }[]>([]);
  const [caption, setCaption] = useState("");
  const [breath, setBreath] = useState(0);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [hermesWorking, setHermesWorking] = useState(false);  // a real Hermes turn is running (the ~slow brain call)
  const [micMuted, setMicMuted] = useState(false);  // mute YOUR mic mid-call (silences your input, keeps the line open)
  const [typing, setTyping] = useState(false);        // a typed (text-only) Hermes turn is in flight — no voice engine
  const [draft, setDraft] = useState("");
  const [voiceId, setVoiceId] = useState("sage");  // calm female default; voice is subjective → sample all via the ⚙
  const [settingsOpen, setSettingsOpen] = useState(false);
  // voice provider setup — chooser modal + a key the user saves on their own machine
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false);
  // first-run welcome — explains what Voice is + the local-vs-paid choice; shown once per machine
  const [welcomed, setWelcomed] = useState<boolean>(() => { try { return localStorage.getItem("hermes-intel-welcomed") === "1"; } catch { return true; } });
  const dismissWelcome = (openSetup = false) => { try { localStorage.setItem("hermes-intel-welcomed", "1"); } catch { /* ignore */ } setWelcomed(true); if (openSetup) setVoiceSetupOpen(true); };
  // skip setup and talk anyway — uses the running engine's key if it has one; if not, startCall falls back to the chooser
  const skipAndTalk = () => { try { localStorage.setItem("hermes-intel-welcomed", "1"); } catch { /* ignore */ } setWelcomed(true); setVoiceSetupOpen(false); startCall(); };
  // ?fresh=1 → reset to a clean first-run (forget the saved key + replay the welcome) for on-camera startup demos
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get("fresh") === "1") {
        localStorage.removeItem("hermes-openai-key"); localStorage.removeItem("hermes-intel-welcomed");
        setOpenaiKey(""); setWelcomed(false);
      }
    } catch { /* ignore */ }
  }, []);
  const [openaiKey, setOpenaiKey] = useState<string>(() => { try { return localStorage.getItem("hermes-openai-key") || ""; } catch { return ""; } });
  const [keyDraft, setKeyDraft] = useState("");
  const [setupHint, setSetupHint] = useState<"idle" | "engine">("idle");
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);  // auto-starting the voice engine
  const copyCmd = (txt: string) => { try { navigator.clipboard?.writeText(txt); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  const shq = (s: string) => "'" + String(s).replace(/'/g, "'\\''") + "'";  // shell-quote a pasted key so it can't inject into the copy-and-run command
  const [sampling, setSampling] = useState<string | null>(null);
  const sampleAudio = useRef<HTMLAudioElement | null>(null);
  async function playSample(v: string) {
    try {
      sampleAudio.current?.pause();
      setSampling(v);
      const r = await fetch(SAMPLE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice: v, ...(openaiKey ? { key: openaiKey } : {}) }) });
      if (!r.ok) throw new Error("sample");
      const a = new Audio(URL.createObjectURL(await r.blob()));
      sampleAudio.current = a; a.onended = () => setSampling(null);
      await a.play();
    } catch { setSampling(null); }
  }
  const voice = useRef<any>({});
  const turnsRef = useRef<{ who: "you" | "hermes"; text: string }[]>([]);
  useEffect(() => { turnsRef.current = turns; }, [turns]);
  const curAI = useRef("");
  const speakingRef = useRef(false);  // Schmitt-trigger for "Hermes is talking" → no talking/listening strobe between syllables
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight; }, [turns.length, caption]);

  async function startCall(keyOverride?: string) {
    const key = (keyOverride ?? openaiKey).trim();
    setCallState("connecting");
    try {
      const s = await fetch(VOICE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice: voiceId, mode: directMode ? "direct" : "companion", ...(key ? { key } : {}) }) }).then((r) => r.json());
      if (!s.value) throw new Error("no token");
      const pc = new RTCPeerConnection();
      const audio = new Audio(); audio.autoplay = true;
      const actx = new AudioContext();
      pc.ontrack = (e) => { audio.srcObject = e.streams[0]; audio.play().catch(() => {}); const an = actx.createAnalyser(); an.fftSize = 256; actx.createMediaStreamSource(e.streams[0]).connect(an); voice.current.aiAna = an; };
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      pc.addTrack(mic.getAudioTracks()[0], mic);
      const micAn = actx.createAnalyser(); micAn.fftSize = 256; actx.createMediaStreamSource(mic).connect(micAn); voice.current.micAna = micAn;
      const dc = pc.createDataChannel("oai-events"); dc.onmessage = onVoiceEvent; dc.onopen = () => { setCallState("live"); pumpVoice(); };
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      const ans = await fetch((s.base || "https://api.openai.com") + "/v1/realtime/calls?model=" + encodeURIComponent(s.model || "gpt-realtime"), { method: "POST", body: offer.sdp, headers: { Authorization: "Bearer " + s.value, "Content-Type": "application/sdp" } });
      await pc.setRemoteDescription({ type: "answer", sdp: await ans.text() } as any);
      voice.current = { ...voice.current, pc, dc, mic, actx, audio };
    } catch { setCallState("off"); setEngineUp(false); setVoiceSetupOpen(true); if (openaiKey) setSetupHint("engine"); }
  }
  // gate the call behind the setup chooser until a reachable, keyed voice engine exists
  async function startVoice() {
    try {
      const h = await fetch("http://localhost:8099/api/health").then((r) => r.json());
      setEngineUp(true); setEngineKeyed(!!h?.keyed);
      // Engine already keyed → go. Otherwise (up but unkeyed, e.g. after a
      // dev-server restart) ask the server to key it — it re-loads the saved
      // OPENAI_API_KEY from ~/.hermes/.env, so we don't need a localStorage
      // key on this port at all.
      if (h?.keyed) return startCall();
      const started = await startEngine(openaiKey).catch(() => null);
      if (started?.ok && started?.keyed) { setEngineKeyed(true); return startCall(openaiKey || undefined); }
    } catch {
      setEngineUp(false);
      // Engine isn't up — spawn it. Pass the localStorage key if we have one;
      // otherwise the server falls back to the key saved in ~/.hermes/.env, so
      // voice keeps working across ports and restarts without re-prompting.
      const started = await startEngine(openaiKey).catch(() => null);
      if (started?.ok && started?.keyed) { setEngineUp(true); setEngineKeyed(true); return startCall(openaiKey || undefined); }
    }
    setVoiceSetupOpen(true);  // only prompt when there's genuinely no saved key anywhere
  }
  // ask the dev server to spawn voice-lab with the user's key — no terminal needed
  async function startEngine(key: string, base?: string) {
    let token = "";
    try { token = (await fetch("/__token").then((r) => r.json()))?.token ?? ""; } catch { /* no token endpoint */ }
    const r = await fetch("/__start_voice", { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-Claude-OS-Token": token } : {}) }, body: JSON.stringify({ ...(key ? { key } : {}), ...(base ? { base } : {}) }) });
    return r.ok ? r.json().catch(() => null) : null;
  }
  async function connectWithKey() {
    const k = keyDraft.trim(); if (!k) return;
    try { localStorage.setItem("hermes-openai-key", k); } catch { /* ignore */ }
    setOpenaiKey(k); setStarting(true);
    const started = await startEngine(k).catch(() => null);
    setStarting(false);
    if (started?.ok) { setEngineUp(true); setEngineKeyed(true); setKeyDraft(""); setVoiceSetupOpen(false); startCall(k); }
    else { setEngineUp(false); setSetupHint("engine"); }  // auto-start failed → show the terminal fallback
  }
  function forgetKey() { try { localStorage.removeItem("hermes-openai-key"); } catch { /* ignore */ } setOpenaiKey(""); }
  // mute YOUR mic without dropping the call — disables the mic track (silence → OpenAI hears nothing, no cost on idle audio)
  function toggleMute() {
    if (callState !== "live") return;
    setMicMuted((m) => {
      const next = !m;
      const tracks = voice.current?.mic?.getAudioTracks?.() || [];
      tracks.forEach((tr: MediaStreamTrack) => { tr.enabled = !next; });
      if (next) { setListening(false); setVoiceLevel(0); }  // calm the orb the instant you mute
      return next;
    });
  }
  // press M to mute / unmute during a live call (ignored while typing in the chat box)
  useEffect(() => {
    if (callState !== "live") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "m" && e.key !== "M" || e.metaKey || e.ctrlKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      toggleMute();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [callState]);
  function endCall() {
    const v = voice.current; try { cancelAnimationFrame(v.raf); v.dc?.close(); v.pc?.close(); v.mic?.getTracks?.().forEach((t: any) => t.stop()); v.actx?.close?.(); } catch {}
    // hand the whole conversation back to Hermes so it persists what mattered
    const convo = turnsRef.current;
    if (convo.length > 1 && onVoiceRequest) {
      const transcript = convo.map((t) => `${t.who === "you" ? "User" : "Hermes"}: ${t.text}`).join("\n");
      onVoiceRequest(`The voice call just ended. Save anything important from it to memory and note any follow-ups. Do not reply conversationally.\n\nTRANSCRIPT:\n${transcript}`, { voice: true, save: true, yolo: true }).catch(() => {});
    }
    voice.current = {}; speakingRef.current = false; setCallState("off"); setBreath(0); setVoiceLevel(0); setListening(false); setThinking(false); setHermesWorking(false); setMicMuted(false); setCaption("");
  }
  function onVoiceEvent(e: MessageEvent) {
    let m: any; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === "input_audio_buffer.speech_started") setListening(true);
    else if (m.type === "input_audio_buffer.speech_stopped") { setListening(false); setThinking(true); }
    else if (m.type === "conversation.item.input_audio_transcription.delta") setCaption((c) => c + (m.delta || ""));
    else if (m.type === "conversation.item.input_audio_transcription.completed") { if (m.transcript?.trim()) setTurns((t) => [...t.slice(-30), { who: "you", text: m.transcript.trim() }]); setCaption(""); }
    else if (m.type === "response.created") { curAI.current = ""; setThinking(true); }
    else if (m.type === "response.audio_transcript.delta" || m.type === "response.output_audio_transcript.delta") { setThinking(false); curAI.current += m.delta || ""; setCaption(curAI.current); }
    else if (m.type === "response.done") {
      const out = m.response?.output || [];
      const calls = out.filter((o: any) => o.type === "function_call");
      if (calls.length) { for (const c of calls) handleToolCall(c); return; }
      setThinking(false);
      // show Hermes's reply in the rail — prefer streamed deltas, else pull the output item transcript
      let finalText = curAI.current.trim();
      if (!finalText) { for (const it of out) for (const ct of (it.content || [])) if (ct && ct.transcript) finalText = (finalText + " " + ct.transcript).trim(); }
      if (finalText) setTurns((t) => [...t.slice(-30), { who: "hermes", text: finalText }]);
      curAI.current = ""; setCaption("");
    }
  }
  // the realtime voice called ask_hermes → run the REAL agent (lights nodes), feed result back to speak
  async function handleToolCall(c: any) {
    let request = "";
    try { request = JSON.parse(c.arguments || "{}").request || ""; } catch {}
    setThinking(true); setHermesWorking(true); curAI.current = ""; setListening(false); setCaption("· checking with Hermes …");
    let result = "I couldn't reach the agent.";
    try { if (onVoiceRequest && request) result = await onVoiceRequest(request, { voice: true, yolo: true }); } catch {}
    setHermesWorking(false);
    const dc = voice.current?.dc;
    if (dc && dc.readyState === "open") {
      try {
        dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output: String(result).slice(0, 4000) } }));
        // speak the result WITHOUT calling a tool again (session forces the tool, so override per-response)
        dc.send(JSON.stringify({ type: "response.create", response: { tool_choice: "none" } }));
      } catch {}
    }
  }
  function pumpVoice() {
    const rms = (an: any) => { if (!an) return 0; const d = new Uint8Array(an.fftSize); an.getByteTimeDomainData(d); let s = 0; for (let i = 0; i < d.length; i++) { const x = (d[i] - 128) / 128; s += x * x; } return Math.min(1, Math.sqrt(s / d.length) * 4); };
    const loop = () => {
      if (!voice.current.dc) return;
      // Hermes's speaking level → low-passed so the core GROWS smoothly (no glitchy jumps)
      const aiR = rms(voice.current.aiAna);
      voice.current.smB = (voice.current.smB || 0) * 0.9 + aiR * 0.1;
      setBreath(voice.current.smB);
      // your mic level → smoothed, so the core's crown reacts while YOU speak too
      const mic = voice.current.micAna;
      let micL = 0;
      if (mic) {
        const NB = mic.frequencyBinCount; const f = (voice.current.f ||= new Uint8Array(NB)); mic.getByteFrequencyData(f);
        let e = 0; for (let k = 2; k < 46; k++) e += f[k];
        const lvl = Math.min(1, (e / 44 / 255) * 2.5);
        voice.current.lvl = (voice.current.lvl || 0) * 0.82 + lvl * 0.18;
        micL = voice.current.lvl;
      }
      // snappy + amplified — the Oracle orbs (Pulse/Plasma/Rider) react quickly as Jack talks
      const combined = Math.max(voice.current.smB, micL);
      const gated = Math.max(0, combined - 0.1) * 1.7;  // drop the ambient noise floor → ~0 at rest, dynamic on real speech (KR bar stops sitting fully-extended)
      voice.current.vlOut = (voice.current.vlOut || 0) * 0.55 + gated * 0.45;
      setVoiceLevel(Math.min(1, voice.current.vlOut));
      voice.current.raf = requestAnimationFrame(loop);
    };
    loop();
  }
  async function sendText(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim(); if (!text) return;
    setDraft("");
    setTurns((t) => [...t.slice(-30), { who: "you", text }]);
    const dc = voice.current?.dc;
    if (callState === "live" && dc && dc.readyState === "open") {
      // on a live call → inject the typed line into the realtime conversation (Hermes can speak it back)
      try {
        dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }));
        dc.send(JSON.stringify({ type: "response.create" }));
      } catch {}
      return;
    }
    // TYPE MODE — straight to the real Hermes brain. No mic, no voice engine, no cost.
    if (!onVoiceRequest) { startCall(); return; }
    setTyping(true);
    try {
      const reply = await onVoiceRequest(text, { save: true });
      setTurns((t) => [...t.slice(-30), { who: "hermes", text: (reply || "").trim() || "…" }]);
    } catch {
      setTurns((t) => [...t.slice(-30), { who: "hermes", text: "I couldn't reach the agent just now." }]);
    }
    setTyping(false);
  }
  useEffect(() => () => endCall(), []);

  const runningCount = Object.values(active).filter((a) => a?.status === "running").length;
  const activeClusters = [...new Set(Object.keys(active).filter((k) => active[k]?.status === "running").map((k) => CLUSTER_OF[k]).filter(Boolean))];
  // Schmitt trigger: latch "talking" above 0.07, release below 0.03. The speech envelope dipping between
  // syllables can no longer strobe talking↔listening — that single-threshold flip WAS the orb "spasm".
  if (callState === "live") {
    if (breath > 0.07) speakingRef.current = true;
    else if (breath < 0.03) speakingRef.current = false;
  } else speakingRef.current = false;
  const hermesSpeaking = speakingRef.current;

  let mode: CoreMode;
  if (callState === "live") { if (hermesSpeaking) mode = "talking"; else if (listening) mode = "listening"; else if (runningCount > 0 || hermesWorking) mode = "working"; else if (thinking) mode = "thinking"; else mode = "listening"; }
  else if (state === "responding") mode = "talking"; else if (state === "thinking") mode = "thinking"; else if (runningCount > 0) mode = "working"; else mode = "dormant";

  const STATE_LABEL: Record<CoreMode, string> = { dormant: "asleep", listening: "listening", thinking: "thinking", talking: "speaking", working: "working" };
  const STATE_COLOR: Record<CoreMode, string> = { dormant: "rgba(255,230,203,0.45)", listening: TEAL, thinking: "#FFD21E", talking: "#eafff8", working: "#ff8a3c" };
  const live = callState === "live";
  const clLabel = (k: string) => CL.find((c) => c.key === k)?.label ?? k;
  const stateText = callState === "connecting" ? "INITIALIZING"
    : activeClusters.length ? `${live ? "LIVE · " : ""}${activeClusters.map((k) => clLabel(k).toUpperCase()).join(" + ")}`
    : live ? `LIVE · ${STATE_LABEL[mode].toUpperCase()}` : mode === "dormant" ? "ASLEEP" : STATE_LABEL[mode].toUpperCase();
  const stateColor = callState === "connecting" ? "#FFD21E" : activeClusters.length ? (CLUSTER_COLOR[activeClusters[0]] ?? STATE_COLOR[mode]) : STATE_COLOR[mode];
  const oracleLevel = Math.max(voiceLevel, breath);
  // attract drives a synthetic level+state so the WHOLE mind looks alive with no live call —
  // the orbs react, Aurora/Cosmos bloom, and the Atlas core fires up (all heavily damped).
  const attracting = demo && !live;
  const displayMode: CoreMode = attracting ? attractState : mode;
  const displayLevel = live ? oracleLevel : attracting ? attractLevel : 0;
  const oracleColor = displayMode === "thinking" ? "#FFD21E" : displayMode === "working" ? "#ff8a3c" : displayMode === "talking" ? "#aef3dd" : "#7be0c8";
  const dispLabel = micMuted && live ? "MIC MUTED" : attracting ? STATE_LABEL[attractState].toUpperCase() : stateText;
  const dispColor = micMuted && live ? "#FFD21E" : attracting ? STATE_COLOR[attractState] : stateColor;
  const loadPct = activeClusters.length ? 88 : ({ dormant: 8, listening: 34, thinking: 72, talking: 58, working: 90 } as Record<CoreMode, number>)[displayMode];
  // voice is "ready" only when the engine is reachable AND has a key (env or the one the user pasted)
  const voiceReady = engineUp && (engineKeyed || !!openaiKey);
  // HermesMind3D is memoized (so the 60fps voice props can't flash it) → an unstable onTapHub could
  // go stale (in demo mode a call-state flip may not change displayMode, skipping the ref refresh).
  // Give it ONE constant identity that always runs the latest behaviour via a ref.
  const tapHubRef = useRef<() => void>(() => {});
  tapHubRef.current = () => (callState === "off" ? startVoice() : endCall());
  const tapHub = useCallback(() => tapHubRef.current(), []);

  return (
    <div className="w-full h-full flex flex-col overflow-hidden relative" style={{ background: "#061613", color: CREAM }}>
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 0, backgroundImage: `url(${labyrinth})`, backgroundSize: "cover", backgroundPosition: "center", opacity: 0.12, filter: "saturate(.5) contrast(1.05)" }} />
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 0, background: "radial-gradient(950px 650px at 56% 46%, rgba(6,29,28,0.25), rgba(3,16,14,0.92) 74%)" }} />
      {/* state frame — unmistakable when LIVE, faint when asleep */}
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 40, ["--sc" as any]: stateColor, boxShadow: live ? undefined : `inset 0 0 0 1px ${stateColor}22, inset 0 0 34px -20px ${stateColor}55`, animation: live ? "ip-frame 2.6s ease-in-out infinite" : "none", transition: "box-shadow .5s" }} />
      <style>{`
        @keyframes ip-spin{to{transform:rotate(360deg)}}
        @keyframes ip-pulse{0%,100%{box-shadow:0 0 11px -1px var(--g),inset 0 0 12px -7px var(--g)}50%{box-shadow:0 0 24px 2px var(--g),inset 0 0 16px -5px var(--g)}}
        @keyframes ip-livedot{50%{opacity:.3}}
        @keyframes ip-frame{0%,100%{box-shadow:inset 0 0 0 2px var(--sc),inset 0 0 46px -18px var(--sc)}50%{box-shadow:inset 0 0 0 2.5px var(--sc),inset 0 0 86px -8px var(--sc)}}
        .ip-spin{animation:ip-spin .7s linear infinite}.ip-livedot{animation:ip-livedot 1.1s ease-in-out infinite}
        .ip-app{position:relative;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:rgba(10,24,22,.5);border:1px solid rgba(255,230,203,.1);transition:box-shadow .35s,border-color .35s,background .35s}
        .ip-app .ico{width:16px;height:16px;display:grid;place-items:center}
        .ip-app .fav{width:22px;height:22px;border-radius:6px;background:#fbfbfb;padding:2px;object-fit:contain;display:block}
        .ip-app .lettermark{font:600 8.5px ui-monospace,monospace}
        .ip-app:not(.on) .ico,.ip-app:not(.on) .lettermark{filter:saturate(.95);opacity:.72}
        .ip-app.on .ico,.ip-app.on .lettermark{opacity:1}
        .ip-app:hover{border-color:var(--g);box-shadow:0 0 14px -5px var(--g);z-index:20}
        .ip-app:hover .ico,.ip-app:hover .lettermark{opacity:1;filter:none}
        .ip-app:hover .ip-app-name{opacity:1;transform:translate(-50%,-2px)}
        .ip-app.run{border-color:transparent;background:rgba(14,30,28,.6);animation:ip-pulse 1.7s ease-in-out infinite}
        .ip-app.on{border-color:transparent;box-shadow:0 0 14px -3px var(--g)}
        .ip-app.done{border-color:rgba(70,224,160,.4)}.ip-app.err{border-color:#ff8a3c}
        .ip-app-name{position:absolute;bottom:calc(100% + 5px);left:50%;transform:translate(-50%,2px);font:600 8px ui-monospace,monospace;letter-spacing:.4px;white-space:nowrap;color:#fff;background:rgba(0,0,0,.88);border:1px solid var(--g);padding:3px 7px;border-radius:6px;opacity:0;pointer-events:none;transition:opacity .15s,transform .15s;z-index:30}
        .ip-bar{position:absolute;left:3px;right:3px;bottom:3px;height:3px;border-radius:2px;background:rgba(255,230,203,.14);overflow:hidden}
        .ip-bar i{position:absolute;top:0;bottom:0;width:45%;border-radius:2px;background:var(--g);animation:ip-load 1.1s ease-in-out infinite}
        @keyframes ip-load{0%{left:-45%}100%{left:105%}}
        .ip-st{position:absolute;bottom:-5px;right:-5px;width:14px;height:14px;border-radius:50%;display:grid;place-items:center;background:#061613;border:1px solid rgba(255,230,203,.12);font-size:8px}
        .nv-chip{position:relative;width:30px;flex:0 0 30px;display:grid;place-items:center;border-radius:7px;border:1px solid rgba(255,230,203,.08);opacity:.55;transition:opacity .3s,box-shadow .3s,border-color .3s,transform .2s;will-change:transform,opacity}
        .nv-chip.concept{border-color:transparent;background:transparent}
        .nv-chip .ico{width:58%;height:58%;display:grid;place-items:center}
        .nv-chip .fav{width:100%;height:auto;aspect-ratio:1;border-radius:6px;background:#fbfbfb;padding:2px;object-fit:contain;display:block}
        .nv-chip .face{width:100%;height:auto;aspect-ratio:1;border-radius:50%;object-fit:cover;display:block;border:1.5px solid var(--g);box-shadow:0 0 7px -2px var(--g)}
        .nv-chip .lettermark{font:600 8px ui-monospace,monospace}
        .nv-chip.on{opacity:1;border-color:var(--g);box-shadow:0 0 18px -1px var(--g),0 0 5px 0 var(--g);transform:scale(1.14);z-index:3}
        .nv-chip.on.concept{border-color:transparent;box-shadow:none}
        .nv-chip.on.concept .face{box-shadow:0 0 18px 0 var(--g);border-color:#fff}
        .nv-chip.run{opacity:1;border-color:var(--g);box-shadow:0 0 26px 1px var(--g),inset 0 0 0 1px var(--g);transform:scale(1.2);z-index:4}
        .nv-chip.run.concept{box-shadow:none}.nv-chip.run.concept .face{box-shadow:0 0 24px 1px var(--g);border-color:#fff}
        .nv-chip.done{opacity:.9;border-color:rgba(70,224,160,.4)}
        .nv-chip:hover{opacity:1;border-color:var(--g);box-shadow:0 0 12px -4px var(--g);transform:translateY(-2px);z-index:5}
        .nv-chip.concept:hover{border-color:transparent;box-shadow:none}
        .nv-chip.concept:hover .face{box-shadow:0 0 13px -1px var(--g)}
        .nv-in{animation:nv-domino .5s ease backwards}
        @keyframes nv-domino{0%{opacity:0;transform:translateY(7px) scale(.5)}60%{opacity:1;transform:translateY(0) scale(1.18)}100%{opacity:1;transform:scale(1)}}
        @keyframes ip-boot{0%{opacity:0;transform:scale(.94)}22%{opacity:1}74%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.03)}}
      `}</style>

      {/* hover tooltip — fixed so the sidebar's overflow never clips it */}
      {hoverCap && (
        <div className="hermes-mono" style={{ position: "fixed", left: Math.min(Math.max(hoverCap.x, 72), (typeof window !== "undefined" ? window.innerWidth : 1280) - 72), top: hoverCap.y - 9, transform: "translate(-50%,-100%)", zIndex: 9999, pointerEvents: "none", font: "600 9px ui-monospace,monospace", letterSpacing: ".5px", textTransform: "uppercase", whiteSpace: "nowrap", color: "#fff", background: "rgba(6,16,15,0.96)", border: `1px solid ${hoverCap.color}`, padding: "4px 8px", borderRadius: 7, boxShadow: `0 5px 18px -5px ${hoverCap.color}` }}>{hoverCap.name}</div>
      )}

      {/* HUD */}
      <div className="flex items-center justify-between px-5 py-2.5 border-b shrink-0 relative z-10" style={{ borderColor: "rgba(255,230,203,0.14)" }}>
        <div className="hermes-mono text-[11px] uppercase tracking-[0.3em] flex items-center gap-2"><span style={{ width: 7, height: 7, borderRadius: 99, background: mode !== "dormant" ? TEAL : "rgba(123,224,200,0.5)", boxShadow: mode !== "dormant" ? "0 0 12px #7be0c8" : "none" }} />Hermes · Intelligence</div>
        <div className="hermes-mono text-[9px] uppercase tracking-[0.22em] flex items-center gap-3" style={{ color: "rgba(255,230,203,0.5)" }}>
          {/* art-direction selector — the full-view design */}
          <div className="flex items-center gap-0.5 rounded-full p-0.5" style={{ background: "rgba(0,0,0,0.32)", border: "1px solid rgba(255,170,80,0.24)" }}>
            {([["aurora", "✺ Aurora"], ["cosmos", "✷ Cosmos"], ["classic", "◈ Classic"]] as const).map(([d, label]) => (
              <button key={d} type="button" onClick={() => setDesign(d)} className="hermes-mono text-[8px] uppercase tracking-[0.16em] px-2 py-1 rounded-full transition-colors" style={{ background: design === d ? "rgba(255,170,80,0.20)" : "transparent", color: design === d ? "#ffce8a" : "rgba(255,230,203,0.5)" }}>{label}</button>
            ))}
          </div>
          {design === "classic" && (
          <div className="flex items-center gap-0.5 rounded-full p-0.5" style={{ background: "rgba(0,0,0,0.32)", border: "1px solid rgba(255,230,203,0.14)" }}>
            {([["atlas", "◈ Atlas"], ["plasma", "✦ Plasma"], ["sonar", "◎ Sonar"], ["waveform", "∿ Pulse"], ["rider", "◢ Rider"]] as const).map(([m, label]) => (
              <button key={m} type="button" onClick={() => setNodeMode(m)} className="hermes-mono text-[8px] uppercase tracking-[0.16em] px-2 py-1 rounded-full transition-colors" style={{ background: nodeMode === m ? "rgba(123,224,200,0.18)" : "transparent", color: nodeMode === m ? TEAL : "rgba(255,230,203,0.5)" }}>{label}</button>
            ))}
          </div>
          )}
          <span className="hidden xl:inline">{CAP_COUNT} capabilities · {CL.length} clusters</span>
          <button type="button" onClick={playCascade} className="opacity-60 hover:opacity-100 transition-opacity ml-1" aria-label="Play capability cascade" title="Play the capability cascade"><Zap className="h-4 w-4" /></button>
          <button type="button" onClick={() => setSettingsOpen((s) => !s)} className="hover:opacity-100 transition-opacity" aria-label="Voice settings" style={{ opacity: settingsOpen ? 1 : 0.6, color: settingsOpen ? TEAL : "inherit" }}><Settings2 className="h-4 w-4" /></button>
          <button type="button" onClick={onClose} className="flex items-center gap-1.5 px-2.5 py-1 rounded transition-opacity hover:opacity-100" aria-label="Close" style={{ opacity: 0.85, border: "1px solid rgba(255,230,203,0.35)", background: "rgba(255,230,203,0.08)", color: CREAM }}><X className="h-3.5 w-3.5" /><span className="hermes-mono text-[9px] uppercase tracking-[0.16em]">Close</span></button>
        </div>
      </div>

      {/* voice settings popover */}
      {settingsOpen && (
        <div className="absolute right-4 top-12 rounded-xl overflow-hidden" style={{ width: 232, zIndex: 60, background: "rgba(8,18,17,0.98)", border: "1px solid rgba(255,230,203,0.16)", boxShadow: "0 20px 54px -14px rgba(0,0,0,0.75)" }}>
          <div className="px-3.5 py-2.5 border-b flex items-center justify-between" style={{ borderColor: "rgba(255,230,203,0.1)" }}>
            <span className="hermes-mono text-[9px] uppercase tracking-[0.22em] flex items-center gap-2" style={{ color: CREAM }}><Mic className="h-3 w-3" />Voice</span>
            <button type="button" onClick={() => setSettingsOpen(false)} className="opacity-50 hover:opacity-100" aria-label="Close"><X className="h-3.5 w-3.5" /></button>
          </div>
          {/* Configure — one place to set up the connection; shows live status (the stats) */}
          <button type="button" onClick={() => { setSettingsOpen(false); setVoiceSetupOpen(true); }} className="w-full flex items-center justify-between px-3.5 py-2.5 border-b transition-colors hover:bg-[rgba(123,224,200,0.05)]" style={{ borderColor: "rgba(255,230,203,0.1)" }}>
            <span className="flex flex-col items-start leading-tight gap-0.5">
              <span className="hermes-mono text-[10px] uppercase tracking-wider flex items-center gap-1.5" style={{ color: TEAL }}><Settings2 className="h-3 w-3" />Configure voice</span>
              <span className="hermes-mono text-[8px]" style={{ color: "rgba(255,230,203,0.42)" }}>{voiceReady ? (openaiKey ? "OpenAI key saved · engine ready" : "engine ready · using its key") : engineUp ? "engine up · no key yet" : "not set up — connect a voice"}</span>
            </span>
            <span className="flex items-center gap-2 shrink-0">
              <span style={{ width: 7, height: 7, borderRadius: 99, background: voiceReady ? GREEN : "#ffce8a", boxShadow: voiceReady ? `0 0 8px ${GREEN}` : "none" }} />
              <span className="hermes-mono text-[13px]" style={{ color: TEAL }}>›</span>
            </span>
          </button>
          {openaiKey && (
            <div className="flex items-center justify-between px-3.5 py-2 border-b" style={{ borderColor: "rgba(255,230,203,0.08)" }}>
              <span className="hermes-mono text-[8px] uppercase tracking-wide" style={{ color: "rgba(123,224,200,0.7)" }}>✓ key on this machine only</span>
              <button type="button" onClick={() => { forgetKey(); setEngineKeyed(false); }} className="hermes-mono text-[8px] uppercase tracking-wide opacity-70 hover:opacity-100" style={{ color: "#ff8a8a" }}>Disconnect key</button>
            </div>
          )}
          <button type="button" onClick={() => setDirectMode((d) => !d)} className="w-full flex items-center justify-between px-3.5 py-2.5 border-b" style={{ borderColor: "rgba(255,230,203,0.1)" }}>
            <span className="flex flex-col items-start leading-tight gap-0.5">
              <span className="hermes-mono text-[10px] uppercase tracking-wider" style={{ color: directMode ? TEAL : CREAM }}>⚡ Hermes Direct</span>
              <span className="hermes-mono text-[8px]" style={{ color: "rgba(255,230,203,0.4)" }}>every turn straight to Hermes · slower, fully real</span>
            </span>
            <span style={{ width: 34, height: 18, borderRadius: 99, background: directMode ? "rgba(123,224,200,0.45)" : "rgba(255,230,203,0.12)", position: "relative", transition: "background .2s", flexShrink: 0 }}>
              <span style={{ position: "absolute", top: 2, left: directMode ? 18 : 2, width: 14, height: 14, borderRadius: 99, background: directMode ? TEAL : "rgba(255,230,203,0.6)", transition: "left .2s" }} />
            </span>
          </button>
          <div className="max-h-[300px] overflow-y-auto py-1.5">
            {VOICES.map((v) => {
              const sel = voiceId === v.id;
              return (
                <div key={v.id} className="flex items-center gap-1.5 px-2">
                  <button type="button" onClick={() => setVoiceId(v.id)} className="flex-1 text-left flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors" style={{ background: sel ? "rgba(123,224,200,0.14)" : "transparent", border: `1px solid ${sel ? "rgba(123,224,200,0.4)" : "transparent"}` }}>
                    <span style={{ width: 7, height: 7, borderRadius: 99, background: sel ? TEAL : "rgba(255,230,203,0.25)", boxShadow: sel ? `0 0 8px ${TEAL}` : "none", flexShrink: 0 }} />
                    <span className="flex flex-col leading-tight"><span className="text-[12px]" style={{ color: CREAM }}>{v.label}</span><span className="hermes-mono text-[8px] uppercase tracking-wider" style={{ color: "rgba(255,230,203,0.4)" }}>{v.vibe}</span></span>
                  </button>
                  <button type="button" onClick={() => playSample(v.id)} className="shrink-0 grid place-items-center rounded-full transition-colors" style={{ width: 26, height: 26, background: "rgba(255,230,203,0.06)", border: "1px solid rgba(255,230,203,0.16)", color: sampling === v.id ? TEAL : CREAM }} aria-label={`Play ${v.label} sample`}>
                    {sampling === v.id ? <span className="ip-spin" style={{ width: 9, height: 9, border: "2px solid rgba(123,224,200,0.3)", borderTopColor: TEAL, borderRadius: "50%", display: "block" }} /> : <Play className="h-3 w-3" fill="currentColor" />}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="px-3.5 py-2 border-t hermes-mono text-[8px] uppercase tracking-wider" style={{ borderColor: "rgba(255,230,203,0.1)", color: "rgba(255,230,203,0.38)" }}>applies to your next call · ▶ to preview</div>
        </div>
      )}

      {/* first-run welcome — what Voice is + the local-vs-paid choice (shown once per machine) */}
      {!welcomed && (
        <div className="absolute inset-0 grid place-items-center p-6" style={{ zIndex: 85, background: "rgba(3,10,9,0.86)", backdropFilter: "blur(5px)" }}>
          <div className="w-full" style={{ maxWidth: 560 }}>
            <div className="rounded-2xl overflow-hidden" style={{ background: "rgba(8,18,17,0.99)", border: "1px solid rgba(255,230,203,0.16)", boxShadow: "0 30px 90px -20px rgba(0,0,0,0.9)" }}>
              <div className="px-6 pt-6 pb-1 text-center">
                <img src={hermesAvatar} alt="" style={{ width: 54, height: 54, borderRadius: "50%", objectFit: "cover", border: "1.5px solid rgba(255,210,33,0.5)", boxShadow: "0 0 22px -4px rgba(255,170,40,0.6)", margin: "0 auto 12px" }} />
                <div className="hermes-mono text-[13px] uppercase tracking-[0.24em]" style={{ color: CREAM }}>Talk to Hermes</div>
                <p className="text-[12.5px] leading-relaxed mt-2.5" style={{ color: "rgba(255,230,203,0.72)" }}>This is a live line to <span style={{ color: CREAM }}>Hermes</span> — your real local agent, with its own tools and memory. <span style={{ color: CREAM }}>Type any time, free.</span> To <span style={{ color: TEAL }}>talk out loud</span>, give it a voice:</p>
              </div>
              {/* how voice works — 3 steps */}
              <div className="px-6 py-3 flex items-stretch gap-2">
                {([["1", "You speak"], ["2", "A speech engine turns voice ⇄ text"], ["3", "Hermes thinks, acts & speaks back"]] as const).map(([n, t]) => (
                  <div key={n} className="flex-1 rounded-lg px-2 py-2 text-center" style={{ background: "rgba(255,230,203,0.04)", border: "1px solid rgba(255,230,203,0.1)" }}>
                    <div className="hermes-mono text-[12px]" style={{ color: TEAL }}>{n}</div>
                    <div className="hermes-mono text-[8px] uppercase tracking-wide mt-1 leading-snug" style={{ color: "rgba(255,230,203,0.58)" }}>{t}</div>
                  </div>
                ))}
              </div>
              {/* the two ways to power the voice */}
              <div className="px-6 pt-1 pb-1 grid gap-2.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <div className="rounded-xl px-3 py-2.5" style={{ background: "rgba(123,224,200,0.05)", border: "1px solid rgba(123,224,200,0.22)" }}>
                  <div className="flex items-center justify-between mb-1"><span className="hermes-mono text-[9px] uppercase tracking-wider" style={{ color: TEAL }}>Free · Local</span><span className="hermes-mono text-[12px]" style={{ color: GREEN }}>$0</span></div>
                  <div className="text-[10px] leading-snug" style={{ color: "rgba(255,230,203,0.6)" }}>Runs fully on your Mac. Private. A bit of setup.</div>
                </div>
                <div className="rounded-xl px-3 py-2.5" style={{ background: "rgba(255,170,80,0.06)", border: "1px solid rgba(255,170,80,0.3)" }}>
                  <div className="flex items-center justify-between mb-1"><span className="hermes-mono text-[9px] uppercase tracking-wider" style={{ color: "#ffce8a" }}>Paid · OpenAI</span><span className="hermes-mono text-[11px]" style={{ color: "#ffce8a" }}>~5–10¢/min</span></div>
                  <div className="text-[10px] leading-snug" style={{ color: "rgba(255,230,203,0.6)" }}>Instant, top quality. Paste a key — one click.</div>
                </div>
              </div>
              <div className="px-6 pt-3 pb-2 flex items-center gap-2.5">
                <button type="button" onClick={() => dismissWelcome(true)} className="flex-1 hermes-mono text-[11px] uppercase tracking-wider rounded-lg py-2.5 transition-all hover:brightness-110" style={{ background: "linear-gradient(180deg,#1d423c,#0d2824)", border: "1.5px solid #7be0c8", color: CREAM, fontWeight: 600 }}>Set up voice →</button>
                <button type="button" onClick={() => dismissWelcome(false)} className="hermes-mono text-[10px] uppercase tracking-wider rounded-lg px-4 py-2.5 opacity-70 hover:opacity-100 transition-opacity" style={{ border: "1px solid rgba(255,230,203,0.2)", color: "rgba(255,230,203,0.7)" }}>Explore first</button>
              </div>
              <div className="px-6 pb-5 text-center">
                <button type="button" onClick={skipAndTalk} className="hermes-mono text-[9px] uppercase tracking-wider opacity-60 hover:opacity-100 transition-opacity" style={{ color: "#7be0c8" }}>skip setup — talk now →</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* voice provider chooser — surfaces cost + a free alternative before any call */}
      {voiceSetupOpen && (
        <div className="absolute inset-0 grid place-items-center p-6" style={{ zIndex: 80, background: "rgba(3,10,9,0.8)", backdropFilter: "blur(4px)" }} onClick={() => setVoiceSetupOpen(false)}>
          <div className="w-full" style={{ maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
            <div className="rounded-2xl overflow-hidden" style={{ background: "rgba(8,18,17,0.99)", border: "1px solid rgba(255,230,203,0.16)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.85)" }}>
              <div className="flex items-center justify-between px-5 py-3.5 border-b" style={{ borderColor: "rgba(255,230,203,0.1)" }}>
                <span className="hermes-mono text-[11px] uppercase tracking-[0.24em] flex items-center gap-2" style={{ color: CREAM }}><Mic className="h-3.5 w-3.5" />Give Hermes a voice</span>
                <button type="button" onClick={() => setVoiceSetupOpen(false)} className="opacity-60 hover:opacity-100" aria-label="Close"><X className="h-4 w-4" /></button>
              </div>
              <div className="px-5 py-4">
                <p className="text-[12.5px] leading-relaxed mb-3.5" style={{ color: "rgba(255,230,203,0.75)" }}>Pick a <span style={{ color: CREAM }}>speech engine</span> — it's only the <span style={{ color: CREAM }}>ears &amp; mouth</span> (turns your voice ⇄ text). <span style={{ color: CREAM }}>Hermes</span> stays the brain either way. Two ways to power it:</p>
                <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
                  {/* OpenAI */}
                  <div className="rounded-xl p-3.5 flex flex-col" style={{ background: "rgba(255,170,80,0.06)", border: "1px solid rgba(255,170,80,0.3)" }}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="hermes-mono text-[10px] uppercase tracking-wider" style={{ color: "#ffce8a" }}>OpenAI Realtime</span>
                      <span className="hermes-mono text-[7px] uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: "rgba(255,170,80,0.2)", color: "#ffce8a" }}>Recommended</span>
                    </div>
                    <div className="rounded-lg px-2.5 py-2 mb-2.5" style={{ background: "rgba(0,0,0,0.28)", border: "1px solid rgba(255,230,203,0.1)" }}>
                      <div className="hermes-mono text-[14px]" style={{ color: "#ffce8a" }}>≈ $3–6<span className="text-[9px]" style={{ color: "rgba(255,230,203,0.5)" }}> / hr talking</span></div>
                      <div className="hermes-mono text-[8px] uppercase tracking-wide mt-0.5" style={{ color: "rgba(255,230,203,0.42)" }}>~5–10¢/min · only while audio flows</div>
                    </div>
                    <input value={keyDraft} onChange={(e) => { setKeyDraft(e.target.value); setSetupHint("idle"); }} placeholder="Paste your OpenAI key (sk-…)" type="password" autoComplete="off" className="w-full bg-transparent outline-none text-[12px] rounded-lg px-2.5 py-2 mb-2" style={{ color: CREAM, border: "1px solid rgba(255,230,203,0.18)", caretColor: "#ffce8a" }} />
                    <button type="button" onClick={connectWithKey} disabled={!keyDraft.trim() || starting} className="hermes-mono text-[10px] uppercase tracking-wider rounded-lg py-2 transition-all disabled:opacity-40" style={{ background: "rgba(255,170,80,0.2)", border: "1px solid #ffce8a", color: "#ffce8a" }}>{starting ? "Starting…" : "Connect"}</button>
                    <div className="hermes-mono text-[7.5px] uppercase tracking-wide mt-1.5 text-center" style={{ color: "rgba(255,230,203,0.4)" }}>starts the engine for you · no terminal</div>
                    {setupHint === "engine" && (
                      <div className="mt-2.5 rounded-lg p-2" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,210,33,0.3)" }}>
                        <div className="hermes-mono text-[8px] uppercase tracking-wide mb-1.5" style={{ color: "#FFD21E" }}>⚠ couldn't auto-start — run this, then Connect</div>
                        <button type="button" onClick={() => copyCmd(`OPENAI_API_KEY=${shq(openaiKey || keyDraft.trim())} bun run voice`)} className="w-full text-left hermes-mono text-[9px] rounded px-2 py-1.5" style={{ background: "rgba(0,0,0,0.45)", color: "#aef3dd", border: "1px solid rgba(123,224,200,0.22)" }}>{copied ? "✓ copied to clipboard" : "⧉ copy:  OPENAI_API_KEY=… bun run voice"}</button>
                      </div>
                    )}
                    <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="hermes-mono text-[8px] uppercase tracking-wide mt-2 self-start opacity-60 hover:opacity-100" style={{ color: "#7be0c8" }}>Get a key →</a>
                  </div>
                  {/* Local / open-source */}
                  <div className="rounded-xl p-3.5 flex flex-col" style={{ background: "rgba(123,224,200,0.05)", border: "1px solid rgba(123,224,200,0.22)" }}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="hermes-mono text-[10px] uppercase tracking-wider" style={{ color: TEAL }}>Local · Open-source</span>
                      <span className="hermes-mono text-[7px] uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: "rgba(70,224,160,0.18)", color: GREEN }}>Free</span>
                    </div>
                    <div className="rounded-lg px-2.5 py-2 mb-2.5" style={{ background: "rgba(0,0,0,0.28)", border: "1px solid rgba(255,230,203,0.1)" }}>
                      <div className="hermes-mono text-[14px]" style={{ color: GREEN }}>$0<span className="text-[9px]" style={{ color: "rgba(255,230,203,0.5)" }}> · private</span></div>
                      <div className="hermes-mono text-[8px] uppercase tracking-wide mt-0.5" style={{ color: "rgba(255,230,203,0.42)" }}>runs on your Mac · ~20-min setup</div>
                    </div>
                    <div className="text-[10px] leading-relaxed mb-2" style={{ color: "rgba(255,230,203,0.55)" }}>Run an OpenAI-compatible voice server locally, then start the engine pointed at it:</div>
                    <button type="button" onClick={() => copyCmd("OPENAI_BASE_URL=http://localhost:8080 OPENAI_API_KEY=local bun run voice")} className="w-full text-left hermes-mono text-[9px] rounded px-2 py-1.5 mb-2" style={{ background: "rgba(0,0,0,0.45)", color: "#aef3dd", border: "1px solid rgba(123,224,200,0.22)" }}>{copied ? "✓ copied to clipboard" : "⧉ copy:  OPENAI_BASE_URL=… bun run voice"}</button>
                    <div className="hermes-mono text-[8px] leading-relaxed" style={{ color: "rgba(255,230,203,0.4)" }}>Pieces: faster-whisper (STT) · Piper (TTS). Full guide: <span style={{ color: "#aef3dd" }}>docs/local-voice-setup.md</span> — or ask Hermes to walk you through it.</div>
                  </div>
                </div>
                <p className="text-[10.5px] leading-snug mt-3" style={{ color: "rgba(255,230,203,0.6)" }}><span style={{ color: TEAL }}>Not sure?</span> Start with <span style={{ color: "#ffce8a" }}>OpenAI</span> — one click, and you only pay while you're actually talking. You can switch to local any time.</p>
                {openaiKey && (
                  <div className="flex items-center justify-between mt-3 pt-3 border-t" style={{ borderColor: "rgba(255,230,203,0.08)" }}>
                    <span className="hermes-mono text-[8.5px] uppercase tracking-wide" style={{ color: "rgba(123,224,200,0.7)" }}>✓ key saved on this machine only</span>
                    <button type="button" onClick={forgetKey} className="hermes-mono text-[8.5px] uppercase tracking-wide opacity-70 hover:opacity-100" style={{ color: "#ff8a8a" }}>Forget key</button>
                  </div>
                )}
                <button type="button" onClick={skipAndTalk} className="w-full hermes-mono text-[10px] uppercase tracking-wider rounded-lg py-2 mt-3 transition-all hover:brightness-110" style={{ background: "rgba(123,224,200,0.1)", border: "1px solid rgba(123,224,200,0.3)", color: "#7be0c8" }}>Skip — talk to Hermes anyway →</button>
                <p className="hermes-mono text-[8px] uppercase tracking-wide mt-2 text-center" style={{ color: "rgba(255,230,203,0.32)" }}>just exploring? the mind animates for free — no key needed</p>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 flex min-h-0 relative z-10">
        {/* LEFT — conversation (resizable) */}
        <div className="shrink-0 flex flex-col" style={{ width: chatW, borderColor: "rgba(255,230,203,0.12)" }}>
          {/* header — Hermes wordmark */}
          <div className="px-3.5 h-[42px] shrink-0 border-b flex items-center justify-between" style={{ borderColor: "rgba(255,255,255,0.07)" }}>
            <img src={hermesLogo} alt="Hermes" style={{ height: 13, width: "auto", objectFit: "contain", filter: "drop-shadow(0 1px 4px rgba(255,170,40,0.3))" }} />
            <span className="hermes-mono text-[8px] uppercase tracking-[0.2em] flex items-center gap-1.5" style={{ color: live ? "#ff9a9a" : "rgba(255,230,203,0.4)" }}>{live && <span className="ip-livedot" style={{ width: 5, height: 5, borderRadius: 99, background: "#ff6b6b" }} />}{live ? "live" : "chat"}</span>
          </div>
          {/* transcript */}
          <div ref={transcriptRef} className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3">
            {callState === "off" && !voiceReady && (
              <div className="rounded-xl p-3" style={{ background: "rgba(255,170,80,0.05)", border: "1px solid rgba(255,170,80,0.22)" }}>
                <div className="hermes-mono text-[8.5px] uppercase tracking-[0.18em] flex items-center justify-between mb-2" style={{ color: "#ffce8a" }}>
                  <span>◢ Give Hermes a voice</span>
                  <button type="button" onClick={() => setVoiceSetupOpen(true)} className="opacity-70 hover:opacity-100 transition-opacity" style={{ color: TEAL }}>options ›</button>
                </div>
                <div className="text-[10.5px] leading-snug mb-2.5" style={{ color: "rgba(255,230,203,0.66)" }}>Paste your OpenAI key and it just works — <span style={{ color: CREAM }}>no terminal</span>. <span style={{ color: "rgba(255,230,203,0.45)" }}>≈$3–6/hr · your key, your machine.</span></div>
                <button type="button" onClick={() => setVoiceSetupOpen(true)} className="w-full hermes-mono text-[10px] uppercase tracking-wider rounded-lg py-2 transition-all hover:brightness-110" style={{ background: "rgba(255,170,80,0.18)", border: "1px solid #ffce8a", color: "#ffce8a" }}>Set up voice →</button>
                <div className="hermes-mono text-[8px] uppercase tracking-wide mt-2 text-center" style={{ color: "rgba(255,230,203,0.34)" }}>or just watch the mind — it's free</div>
              </div>
            )}
            {turns.length === 0 && !caption && voiceReady && (
              <div className="flex flex-col items-center text-center gap-2.5 mt-6 px-2">
                <img src={hermesAvatar} alt="" style={{ width: 46, height: 46, borderRadius: "50%", objectFit: "cover", border: "1.5px solid rgba(255,210,33,0.4)", boxShadow: "0 0 18px -4px rgba(255,170,40,0.5)" }} />
                <div className="hermes-mono text-[10px] leading-relaxed" style={{ color: "rgba(255,230,203,0.4)" }}>Tap the core or type below to talk with Hermes. Interrupt any time.</div>
              </div>
            )}
            {turns.map((t, i) => t.who === "you" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[84%] text-[12.5px] leading-snug px-3 py-2" style={{ background: "rgba(123,224,200,0.14)", border: "1px solid rgba(123,224,200,0.26)", color: CREAM, borderRadius: "13px 13px 4px 13px" }}>{t.text}</div>
              </div>
            ) : (
              <div key={i} className="flex items-start gap-2">
                <img src={hermesAvatar} alt="" style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", border: "1px solid rgba(255,210,33,0.4)", marginTop: 1, flexShrink: 0 }} />
                <div className="max-w-[82%] text-[12.5px] leading-snug px-3 py-2" style={{ background: "rgba(255,230,203,0.06)", border: "1px solid rgba(255,230,203,0.12)", color: CREAM, borderRadius: "13px 13px 13px 4px" }}>{t.text}</div>
              </div>
            ))}
            {caption && (listening ? (
              <div className="flex justify-end"><div className="max-w-[84%] text-[12.5px] leading-snug px-3 py-2 italic" style={{ background: "rgba(123,224,200,0.09)", border: "1px solid rgba(123,224,200,0.18)", color: "rgba(255,230,203,0.8)", borderRadius: "13px 13px 4px 13px" }}>{caption}</div></div>
            ) : (
              <div className="flex items-start gap-2"><img src={hermesAvatar} alt="" style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", border: "1px solid rgba(255,210,33,0.4)", marginTop: 1, flexShrink: 0 }} /><div className="max-w-[82%] text-[12.5px] leading-snug px-3 py-2 italic" style={{ background: "rgba(255,230,203,0.04)", border: "1px solid rgba(255,230,203,0.1)", color: "rgba(255,230,203,0.82)", borderRadius: "13px 13px 13px 4px" }}>{caption}<span className="ip-livedot" style={{ marginLeft: 3 }}>▍</span></div></div>
            ))}
            {typing && (
              <div className="flex items-start gap-2">
                <img src={hermesAvatar} alt="" style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", border: "1px solid rgba(255,210,33,0.4)", marginTop: 1, flexShrink: 0 }} />
                <div className="text-[12.5px] leading-snug px-3 py-2 italic" style={{ background: "rgba(255,230,203,0.04)", border: "1px solid rgba(255,230,203,0.1)", color: "rgba(255,230,203,0.7)", borderRadius: "13px 13px 13px 4px" }}>Hermes is thinking<span className="ip-livedot" style={{ marginLeft: 2 }}>…</span></div>
              </div>
            )}
          </div>
          {/* text input — typing here talks to Hermes by text (no voice engine) unless a call is live */}
          <form onSubmit={sendText} className="px-2.5 py-2 shrink-0 border-t flex flex-col gap-1.5" style={{ borderColor: "rgba(255,255,255,0.07)", background: "rgba(123,224,200,0.05)" }}>
            {!live && (
              <div className="hermes-mono text-[7.5px] uppercase tracking-[0.16em] flex items-center gap-1.5 px-1" style={{ color: "rgba(255,230,203,0.34)" }}><Keyboard className="h-2.5 w-2.5" />Type-only — talks to Hermes · no voice, no cost</div>
            )}
            <div className="flex items-center gap-2">
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={live ? "Message Hermes…" : "Message Hermes — no voice needed…"} className="flex-1 min-w-0 bg-transparent outline-none text-[12.5px]" style={{ color: CREAM, caretColor: TEAL }} />
              <button type="submit" disabled={!draft.trim()} className="shrink-0 grid place-items-center rounded-full transition-all disabled:opacity-30" style={{ width: 28, height: 28, background: draft.trim() ? "rgba(123,224,200,0.18)" : "transparent", border: `1px solid ${draft.trim() ? "#7be0c8" : "rgba(255,230,203,0.18)"}`, color: draft.trim() ? TEAL : "rgba(255,230,203,0.4)" }} aria-label="Send"><Send className="h-3.5 w-3.5" /></button>
            </div>
          </form>
        </div>

        {/* drag handle — resize the chat panel */}
        <div onMouseDown={() => { dragW.current = true; document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none"; }} className="shrink-0 self-stretch relative group" style={{ width: 7, cursor: "col-resize", zIndex: 20 }} title="Drag to resize chat">
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 group-hover:bg-[rgba(123,224,200,0.5)] transition-colors" style={{ width: 1, background: "rgba(255,230,203,0.14)" }} />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-[3px] opacity-30 group-hover:opacity-100 transition-opacity">
            <span style={{ width: 3, height: 3, borderRadius: 9, background: TEAL }} /><span style={{ width: 3, height: 3, borderRadius: 9, background: TEAL }} /><span style={{ width: 3, height: 3, borderRadius: 9, background: TEAL }} />
          </div>
        </div>

        {/* CENTER — the living mind graph */}
        <div className="flex-1 relative min-w-0">
          <div className="absolute inset-0" style={{ zIndex: 0 }}>
            {design === "aurora" ? (
              <StageAurora mode={displayMode} level={displayLevel} activeClusters={activeClusters} onTap={() => (callState === "off" ? startVoice() : endCall())} />
            ) : design === "cosmos" ? (
              <StageCosmos mode={displayMode} level={displayLevel} activeClusters={activeClusters} onTap={() => (callState === "off" ? startVoice() : endCall())} />
            ) : nodeMode === "atlas" ? (
              <HermesMind3D mode={displayMode} breath={breath} voiceLevel={displayLevel} activeClusters={hoverCluster ? [...activeClusters, hoverCluster] : activeClusters} onTapHub={tapHub} />
            ) : (
              <div className="w-full h-full" style={{ cursor: "pointer" }} onClick={() => (callState === "off" ? startVoice() : endCall())}>
                {nodeMode === "plasma" ? <OraclePlasma level={displayLevel} mode={displayMode} color={oracleColor} />
                  : nodeMode === "sonar" ? <OracleSonar level={displayLevel} mode={displayMode} color={oracleColor} />
                  : nodeMode === "rider" ? <OracleRider level={displayLevel} mode={displayMode} color={oracleColor} />
                  : <OracleWaveform level={displayLevel} mode={displayMode} color={oracleColor} />}
              </div>
            )}
          </div>
          <div className="absolute left-4 top-4 pointer-events-none" style={{ zIndex: 41 }}><div className="hermes-mono text-[11px] uppercase tracking-[0.2em] flex items-center gap-2 px-3.5 py-2 rounded-lg" style={{ background: "rgba(0,0,0,0.72)", border: `1.5px solid ${dispColor}${live || attracting ? "" : "55"}`, color: dispColor, boxShadow: live || attracting ? `0 0 16px -4px ${dispColor}` : "none", fontWeight: 600 }}><span className={live || attracting ? "ip-livedot" : ""} style={{ width: 8, height: 8, borderRadius: 99, background: dispColor, boxShadow: `0 0 10px ${dispColor}` }} />{dispLabel}</div></div>
          {/* telemetry HUD — the FUI command-center readouts (cinematic designs only) */}
          {design !== "classic" && (
            <div className="absolute right-4 top-4 pointer-events-none hidden sm:block" style={{ zIndex: 41, width: 190 }}>
              <div className="hermes-mono rounded-xl overflow-hidden" style={{ background: "rgba(6,14,13,0.55)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", border: "1px solid rgba(255,230,203,0.12)", boxShadow: "0 14px 44px -20px rgba(0,0,0,0.85)" }}>
                <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: "1px solid rgba(255,230,203,0.08)" }}>
                  <span className="text-[8.5px] uppercase tracking-[0.2em] flex items-center gap-1.5" style={{ color: dispColor }}><span className={live || attracting ? "ip-livedot" : ""} style={{ width: 6, height: 6, borderRadius: 99, background: dispColor, boxShadow: `0 0 8px ${dispColor}` }} />Neural Core</span>
                  <span className="text-[8px] tracking-[0.16em]" style={{ color: "rgba(255,230,203,0.42)" }}>{live ? "LIVE" : attracting ? "DEMO" : "IDLE"}</span>
                </div>
                <div className="px-3 py-2.5 flex flex-col gap-2">
                  <div>
                    <div className="flex justify-between text-[7.5px] uppercase tracking-[0.18em] mb-1" style={{ color: "rgba(255,230,203,0.45)" }}><span>Neural Load</span><span style={{ color: dispColor }}>{loadPct}%</span></div>
                    <div style={{ height: 3, borderRadius: 2, background: "rgba(255,230,203,0.1)", overflow: "hidden" }}><div style={{ height: "100%", width: `${loadPct}%`, background: dispColor, boxShadow: `0 0 8px ${dispColor}`, transition: "width .6s ease" }} /></div>
                  </div>
                  {(([["Capabilities", String(CAP_COUNT)], ["Clusters", String(CL.length)], ["Active", activeClusters.length ? activeClusters.map(clLabel).join(" · ") : "standby"], ["Channel", directMode ? "Hermes Direct" : "Companion"]]) as [string, string][]).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-2 text-[8.5px]">
                      <span className="uppercase tracking-[0.16em] shrink-0" style={{ color: "rgba(255,230,203,0.4)" }}>{k}</span>
                      <span className="truncate text-right" style={{ color: v === "standby" ? "rgba(255,230,203,0.4)" : CREAM }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {/* cinematic boot reveal — systems coming online */}
          {design !== "classic" && showBoot && (
            <div className="absolute inset-0 grid place-items-center pointer-events-none" style={{ zIndex: 42 }}>
              <div className="hermes-mono text-center" style={{ animation: "ip-boot 2s ease forwards" }}>
                <div className="text-[11px] uppercase tracking-[0.5em]" style={{ color: dispColor, textShadow: `0 0 18px ${dispColor}` }}>◢ Initializing</div>
                <div className="text-[8px] uppercase tracking-[0.32em] mt-2" style={{ color: "rgba(255,230,203,0.55)" }}>neural core · {CAP_COUNT} capabilities online</div>
              </div>
            </div>
          )}
          {live && hermesWorking && (
            <div className="absolute left-1/2 pointer-events-none" style={{ bottom: 116, transform: "translateX(-50%)", zIndex: 42 }}>
              <div className="hermes-mono text-[11px] uppercase tracking-[0.18em] flex items-center gap-2.5 px-4 py-2 rounded-full" style={{ background: "rgba(0,0,0,0.72)", border: "1.5px solid #ff8a3c", color: "#ffce8a", boxShadow: "0 0 24px -6px #ff8a3c" }}>
                <span className="ip-spin" style={{ width: 11, height: 11, border: "2px solid rgba(255,138,60,0.3)", borderTopColor: "#ff8a3c", borderRadius: "50%", display: "block" }} />
                Checking with Hermes…
              </div>
            </div>
          )}
          <div className="absolute left-1/2 bottom-7 flex items-center justify-center gap-2.5" style={{ transform: "translateX(-50%)", zIndex: 41 }}>
            {live && (
              <button type="button" onClick={toggleMute} className="hermes-mono text-[11px] tracking-[0.08em] inline-flex items-center gap-2 px-4 py-2.5 rounded-full transition-all hover:brightness-110" style={{ background: micMuted ? "rgba(255,210,33,0.18)" : "rgba(0,0,0,0.55)", border: `1.5px solid ${micMuted ? "#FFD21E" : "rgba(255,230,203,0.4)"}`, color: micMuted ? "#FFD21E" : CREAM, fontWeight: 600 }} aria-label={micMuted ? "Unmute your mic" : "Mute your mic"} title="Mute / unmute your mic (M)">
                {micMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                {micMuted ? "Unmute" : "Mute"}
              </button>
            )}
            <button type="button" onClick={() => (callState === "off" ? startVoice() : endCall())} className="hermes-mono text-[12.5px] tracking-[0.1em] inline-flex items-center gap-2.5 px-5 py-2.5 rounded-full transition-all hover:brightness-110" style={{ background: live ? "#d23b3b" : callState === "connecting" ? "rgba(255,210,33,0.16)" : "linear-gradient(180deg,#1d423c,#0d2824)", border: `1.5px solid ${live ? "#ff8a8a" : callState === "connecting" ? "#FFD21E" : "#7be0c8"}`, color: live ? "#fff" : callState === "connecting" ? "#FFD21E" : CREAM, boxShadow: live ? "0 0 24px -3px #d23b3b" : "0 4px 22px -8px #7be0c8", fontWeight: 600 }}>
              {callState === "connecting" ? <span className="ip-spin" style={{ width: 11, height: 11, border: "2px solid rgba(255,210,33,0.3)", borderTopColor: "#FFD21E", borderRadius: "50%", display: "block" }} /> : live ? <Square className="h-3.5 w-3.5" fill="currentColor" /> : <Mic className="h-4 w-4" />}
              {callState === "connecting" ? "Connecting…" : live ? "End voice" : "Talk to Hermes"}
            </button>
          </div>
        </div>

      </div>

      {/* BOTTOM — nerve strip (classic Atlas only) */}
      {design === "classic" && nodeMode === "atlas" && (
      <div className="shrink-0 border-t relative z-10 flex items-stretch" style={{ borderColor: "rgba(255,230,203,0.14)", background: "rgba(0,0,0,0.5)", minHeight: 62 }}>
        <div className="flex items-stretch justify-end gap-2.5 px-2 py-2 flex-1 min-w-0">
          {(() => { let gi = -1; return DOCK.map((cat) => {
            const liveN = cat.caps.filter((c) => active[c]?.status === "running").length;
            return (
              <div key={cat.key} className="flex items-center justify-center gap-1.5 pb-1.5" style={{ borderBottom: `2px solid ${cat.color}${liveN ? "" : "55"}`, boxShadow: liveN ? `0 7px 13px -11px ${cat.color}` : "none", transition: "border-color .3s, box-shadow .3s" }}>
                  {cat.caps.map((c) => {
                    gi++;
                    const st = active[c]; const cls = st?.status === "running" ? "on run" : st?.status === "done" ? "on done" : st?.status === "error" ? "on err" : "";
                    const concept = !!ICONS[c]?.face;
                    return (
                      <div key={c} className={`nv-chip ${entered ? "" : "nv-in"} ${concept ? "concept" : ""} ${cls}`} style={{ ["--g" as any]: cat.color, animationDelay: `${gi * 32}ms` }}
                        onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHoverCap({ name: NAMES[c] ?? c, x: r.left + r.width / 2, y: r.top, color: cat.color }); setHoverCluster(cat.key); }}
                        onMouseLeave={() => { setHoverCap(null); setHoverCluster(null); }}>
                        <Cap cap={c} />
                        {st?.status === "running" && <span className="ip-bar"><i /></span>}
                        {st?.status === "done" && <span className="ip-st" style={{ color: GREEN }}>✓</span>}
                        {st?.status === "error" && <span className="ip-st" style={{ color: "#ff8a3c" }}>!</span>}
                      </div>
                    );
                  })}
              </div>
            );
          }); })()}
        </div>
        <div className="shrink-0 border-l flex flex-col items-end justify-center px-4 gap-0.5" style={{ borderColor: "rgba(255,230,203,0.1)" }}>
          <span className="hermes-mono text-[8px] uppercase tracking-[0.2em]" style={{ color: "rgba(255,230,203,0.4)" }}>Activity</span>
          <span className="hermes-mono text-[11px] whitespace-nowrap" style={{ color: runningCount > 0 ? TEAL : "rgba(255,230,203,0.55)" }}>{runningCount > 0 ? `▸ ${runningCount} running` : `${recent.length} recent`}</span>
        </div>
      </div>
      )}
    </div>
  );
}
