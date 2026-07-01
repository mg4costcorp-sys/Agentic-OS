# Local voice setup (free · private · on your Mac)

> **TL;DR** — Voice has two parts: a **speech engine** (the ears + mouth that turn
> your voice ⇄ text) and **Hermes** (the brain, which already runs locally). The
> *paid* path uses OpenAI's hosted speech engine — one click, ~5–10¢/min. The
> *free* path points the OS at a **local, OpenAI-compatible speech engine** you run
> on your own machine. Text chat is always free and fully local regardless.
>
> **If you're not sure, just ask Hermes:** *"walk me through setting up local
> voice"* — it can read this file and guide you step by step.

---

## How voice actually works here

1. **You speak.**
2. A **speech engine** transcribes it to text, and later speaks Hermes's reply
   back. In the OS this is the OpenAI **Realtime** API (low-latency, two-way).
3. **Hermes** — your real local agent, with all its tools and memory — does the
   thinking via the `ask_hermes` tool, and hands back the answer to be spoken.

The speech engine is the *only* part that costs money on the paid path. Swapping
it for a local one makes voice free and fully private. **Hermes itself is always
local** — your words and its answers never need to leave your machine for the
thinking.

The OS reaches the speech engine through one env var: **`OPENAI_BASE_URL`**.
Default is `https://api.openai.com`. Point it at `http://localhost:<port>` and the
exact same code talks to your local engine instead.

---

## The free / local path

### What you need
A local server that speaks the **OpenAI Realtime API** — specifically:

- `POST /v1/realtime/client_secrets` → returns a short-lived `client_secret`
- a WebRTC endpoint at `/v1/realtime/calls` for the live audio session

Under the hood a local engine like this is usually:

| Piece | Job | Common pick |
|-------|-----|-------------|
| STT (speech → text) | hears you | **faster-whisper** |
| TTS (text → speech) | speaks back | **Piper** |
| Realtime shim | speaks the OpenAI Realtime protocol over the two above | community bridge |

> **Honest status:** a one-command, turnkey local *Realtime* server isn't a solved,
> click-to-install thing yet — it's the advanced / experimental path and you'll be
> assembling community pieces. The plumbing below is exact and stable; the local
> server is the part you (or Hermes) wire up. If you just want voice working now,
> the OpenAI path is one click. **Text chat is free and 100% local today** with no
> setup at all.

### Steps

1. **Run your local OpenAI-Realtime-compatible server** on some port, e.g. `8080`.
   (Bring your own — a faster-whisper + Piper realtime bridge, or any server that
   exposes the two endpoints above.)

2. **Start the OS voice engine pointed at it** — from the repo root:

   ```bash
   OPENAI_BASE_URL=http://localhost:8080 OPENAI_API_KEY=local bun run voice
   ```

   - `OPENAI_BASE_URL` — your local server (must be `localhost`/`127.0.0.1`; the OS
     allowlists those + `api.openai.com` and rejects anything else, so your key
     can't be redirected elsewhere).
   - `OPENAI_API_KEY=local` — a placeholder; a local server ignores it.
   - `PORT` — optional, defaults to `8099` (the voice engine's own port).

3. **In the dashboard**, open the Intelligence view → **⚙ Configure voice**. It
   probes the engine on `:8099`; once it answers, the status dot goes green. Tap
   the orb (or "Skip — talk to Hermes anyway") and talk. $0, nothing leaves your
   machine.

### Env vars

| Variable | Default | Meaning |
|----------|---------|---------|
| `OPENAI_BASE_URL` | `https://api.openai.com` | where the speech engine lives (set to your `http://localhost:<port>`) |
| `OPENAI_API_KEY`  | — | the speech engine's key; use `local` for a local server |
| `PORT`            | `8099` | the port the OS voice engine (`voice-lab`) listens on (loopback only) |

---

## The paid / OpenAI path (one click, for comparison)

1. Get a key at <https://platform.openai.com/api-keys>.
2. In the dashboard, **⚙ Configure voice** → paste the key → **Connect**. It
   auto-starts the engine; no terminal.
3. ~5–10¢/min (≈ $3–6/hr), billed only while audio is actually flowing. Your key
   is stored on your machine only.

You can switch between local and OpenAI any time from **⚙ Configure voice**.

---

## Troubleshooting

- **Status dot stays amber / "no key yet"** — the engine on `:8099` isn't running
  or has no key. Re-run the `bun run voice` command above; the Configure panel
  re-probes automatically.
- **Local server unreachable** — confirm it's on `localhost`/`127.0.0.1` (remote
  hosts are intentionally blocked) and that the two Realtime endpoints respond.
- **I just want it to work** — use the OpenAI path, or skip voice entirely and
  **type** to Hermes (free, local, no setup).
