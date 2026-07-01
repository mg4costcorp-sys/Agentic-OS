// voice-lab — tiny Bun backend for the OpenAI Realtime API
// Holds the OpenAI key server-side and mints short-lived ephemeral tokens
// the browser uses to open a WebRTC voice session. The real key never leaves here.
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KEY = process.env.OPENAI_API_KEY;
const PORT = Number(process.env.PORT || 8099);
// Point at ANY OpenAI-compatible Realtime server (e.g. a free local/open-source
// one) by setting OPENAI_BASE_URL; defaults to OpenAI's hosted API.
const BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
const MODELS = ["gpt-realtime", "gpt-realtime-2"]; // try GA first, then newer
// Resolve this file's directory cross-platform. On Windows import.meta.url is
// file:///C:/… so .pathname keeps a spurious leading "/"; fileURLToPath fixes it.
const HERE = fileURLToPath(new URL(".", import.meta.url));
// CORS — allow ANY localhost/127.0.0.1 port. The dashboard may run on 8082+ (or
// on Windows), and the health check was being blocked when it did. The server
// binds 127.0.0.1 only, so no remote page can reach it; a drive-by page on a
// real domain still fails this check (its Origin won't match).
const ALLOWED_ORIGINS = {
  has: (o: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o),
};

const SYSTEM = [
  "You are Hermes's VOICE — the user's warm, quick AI companion on a live call. Speak English (neutral/British), natural and concise, like a friend. You can be interrupted; if so, stop and listen.",
  "You run the CONVERSATION yourself in real time, with no delay: greetings, small talk, acknowledgements, clarifying questions, restating or summarising, and deciding what to do next. Keep it flowing and human — the user can keep chatting with you while Hermes works in the background.",
  "You have NO knowledge, memory or data of your own. For ANYTHING real — research, facts, current events or status, the user's files, email, calendar, notes, memory or personal data, any number/name/amount/date, or to TAKE AN ACTION — you MUST call the ask_hermes tool and then speak ONLY what it returns. Never state a fact or take a guess from your own head. If you're even slightly unsure whether something needs real data, call ask_hermes.",
  "Natural pattern: when a turn needs Hermes, say a brief natural line first ('Sure — let me look that up') and THEN call ask_hermes; you may keep chatting while it works. When it returns, give the answer in a brief natural wrapper but keep every fact EXACTLY as Hermes gave it — never alter, add to, or drop any detail.",
  "Especially: ANY question about the past, your memory, what was discussed before, or 'what did we talk about' REQUIRES ask_hermes. Never claim from your own head that you don't remember, that you have no record, or that a session 'didn't carry over' — you cannot know that. Ask Hermes and report exactly what it returns.",
].join(" ");

// Direct mode: pure relay — every turn goes straight to Hermes, no agent-on-top.
const RELAY_SYSTEM = [
  "You are the VOICE of Hermes — the user's AI operating system — on a live call. Speak English (neutral/British), warm and concise. You can be interrupted; if so, stop and listen.",
  "You have NO knowledge of your own. On EVERY turn you MUST call the ask_hermes tool with the user's request in their own words, then speak back ONLY what it returns — that IS Hermes's answer. You may add a brief natural lead-in ('one sec') but never add, change, guess or invent any fact. If it returns little, say exactly that.",
].join(" ");

const TOOLS = [{
  type: "function",
  name: "ask_hermes",
  description: "Hand a request to the real Hermes agent (full tool/memory/skill access). Use for anything needing real action, current info, or the user's personal data. Returns Hermes's result for you to speak.",
  parameters: {
    type: "object",
    properties: { request: { type: "string", description: "The user's request, phrased clearly and completely for the agent to act on." } },
    required: ["request"],
  },
}];

if (!KEY) console.error("⚠️  No OPENAI_API_KEY in env — set it in voice-lab/.env or your shell (export OPENAI_API_KEY=…).");

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",  // loopback only — never expose the key-minting endpoint to the LAN
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin") || "";
    const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "http://localhost:8081";
    const CORS: Record<string, string> = { "Access-Control-Allow-Origin": allowOrigin, "Vary": "Origin", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    // CSRF: CORS only stops a malicious page from READING our response; it can still fire a blind
    // POST that spends the key. Reject any cross-origin browser POST before doing any OpenAI work.
    if (req.method === "POST" && origin && !ALLOWED_ORIGINS.has(origin)) {
      return new Response(JSON.stringify({ error: "forbidden_origin" }), { status: 403, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // health — does this engine already have a key + where does it point? (UI reads this)
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, keyed: !!KEY, base: BASE }, { headers: CORS });
    }

    // mint an ephemeral client secret for a WebRTC realtime session
    if (url.pathname === "/api/session" && req.method === "POST") {
      let voice = "marin"; let reqMode = "companion"; let clientKey = "";
      try { const b = await req.json(); if (b?.voice) voice = String(b.voice); if (b?.mode) reqMode = String(b.mode); if (b?.key) clientKey = String(b.key).trim(); } catch {}
      // prefer a key the user supplied in the UI; else the server's env key
      const key = clientKey || KEY;
      if (!key) return new Response(JSON.stringify({ error: "no_key" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
      const direct = reqMode === "direct";
      let lastErr = "mint failed";
      for (const model of MODELS) {
        try {
          const r = await fetch(`${BASE}/v1/realtime/client_secrets`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ session: {
              type: "realtime", model,
              instructions: direct ? RELAY_SYSTEM : SYSTEM,
              tools: TOOLS,
              tool_choice: direct ? "required" : "auto",
              audio: {
                input: { transcription: { model: "gpt-4o-mini-transcribe" }, turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 650 } },
                output: { voice },
              },
            } }),
          });
          if (r.ok) {
            const j: any = await r.json();
            return Response.json({
              value: j.value ?? j.client_secret?.value, model, base: BASE, expires_at: j.expires_at,
              configured: {
                instructions: !!j.session?.instructions,
                mode: reqMode,
                vad: j.session?.audio?.input?.turn_detection?.type ?? null,
                transcription: j.session?.audio?.input?.transcription?.model ?? null,
                voice: j.session?.audio?.output?.voice ?? null,
              },
            }, { headers: CORS });
          }
          lastErr = await r.text();
        } catch (e: any) { lastErr = e?.message || String(e); }
      }
      return new Response(lastErr, { status: 500, headers: CORS });
    }

    // short spoken sample of a voice, for the voice picker
    if (url.pathname === "/api/sample" && req.method === "POST") {
      let voice = "cedar"; let clientKey = "";
      try { const b = await req.json(); if (b?.voice) voice = String(b.voice); if (b?.key) clientKey = String(b.key).trim(); } catch {}
      const key = clientKey || KEY;
      if (!key) return new Response(JSON.stringify({ error: "no_key" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
      try {
        const r = await fetch(`${BASE}/v1/audio/speech`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o-mini-tts", voice, input: "Hey — this is how I sound. Tap the core whenever you want to talk.", response_format: "mp3" }),
        });
        if (!r.ok) return new Response(await r.text(), { status: 500, headers: CORS });
        return new Response(r.body, { headers: { ...CORS, "Content-Type": "audio/mpeg" } });
      } catch (e: any) { return new Response(e?.message || String(e), { status: 500, headers: CORS }); }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(join(HERE, "index.html")), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`voice-lab → http://localhost:${PORT}  (key loaded: ${KEY ? "yes" : "NO"})`);
