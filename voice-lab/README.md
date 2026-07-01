# voice-lab — Hermes voice backend

A tiny Bun server that mints short-lived OpenAI Realtime tokens for the browser's
voice session (the "Talk to Hermes" mode in the Intelligence view). The OpenAI key
stays server-side and never reaches the browser.

It is **OpenAI = ears + mouth only**. The actual answers come from your local Hermes
agent: the browser calls `ask_hermes`, which hits the app's `/__hermes_chat`
middleware, which runs your real `hermes` CLI. See `INTEGRATION.md` at the repo root.

## Run it

```bash
# 1. give it an OpenAI key with Realtime access (see .env.example)
export OPENAI_API_KEY=sk-proj-...        # or put it in a repo-root .env

# 2. start the token server (port 8099)
bun run voice-lab/server.ts              # or: bun run voice
```

No dependencies to install — it uses Bun's built-ins only.

## Modes (set by the app per call)

- **Companion** (default): the voice handles conversation itself and only calls
  Hermes for real info/actions → snappy.
- **Direct** (`mode: "direct"`): every turn is relayed straight to Hermes → always
  the real agent, a touch slower.

## Prerequisites for full functionality

- **Bun** installed.
- **OpenAI key** with Realtime API access (above).
- **Hermes installed locally** — the app's `/__hermes_chat` spawns your real
  `hermes` CLI, so voice answers/actions only work on a machine where Hermes is set up.
