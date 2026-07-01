# Intelligence view — designs & demo setup

The Hermes **Intelligence view** (open it from `/agents/hermes` → **Intelligence**) is a
full-screen, cinematic "living mind" you can talk to. It now ships with **three
switchable designs**, chosen from the selector in the HUD top-bar:

| Design | Feel | What you see |
|---|---|---|
| **✺ Aurora** *(default)* | Warm · organic · premium companion | A breathing amber **singularity core** ringed by a circular voice-crown, with the 7 capability clusters slowly revolving around it, energy streaming inward along active links, spoken-word ripples when it talks. |
| **✷ Cosmos** | Cold · cosmic · awe | A tilted **accretion disk** of thousands of particles spiralling a singularity (passing *behind* it), a parallax starfield + nebula, the clusters as distant constellation-stars that flare and fire a signal inward when they activate. |
| **◈ Classic** | The original | The 3D Atlas force-graph + the 4 Oracle orbs (Plasma/Sonar/Pulse/Rider) + the nerve-strip. Unchanged. |

Your choice is remembered (localStorage), and you can deep-link a specific one with
`?design=aurora` / `?design=cosmos` / `?design=classic`.

## The two ways to demo

### 1. Visuals only — **zero setup** (recommended for a stage)
When you're **not** in a live call, Aurora & Cosmos run an **attract mode**: a
synthetic-speech generator cycles the mind through *listening → thinking → speaking*
with realistic speech cadence, so the core breathes, blooms and fires capabilities on
its own. No mic, no backend, no API key.

```bash
cd ~/code/claude-os && bun run dev      # → http://localhost:8081
```
Then open straight into it:
```
http://localhost:8081/agents/hermes?intel=1&design=aurora
```
(`?intel=1` opens the Intelligence view immediately; swap `design=` to compare.)

### 2. Full live voice
Click **Talk to Hermes** (or tap the core) and a **voice-provider chooser** appears so
you (or anyone running this) can pick how Hermes hears & speaks:

- **OpenAI Realtime** *(recommended)* — best quality + lowest latency.
  **≈ $3–6 per hour of active talking (~5–10¢/min) — you only pay while audio flows.**
  Paste your OpenAI key in the chooser and click **Connect** — the app starts the voice
  engine for you (**no terminal**). The key lives only on your machine and is handed to
  the local engine via its environment (never argv, so it's not visible to `ps`).
  *Fallback if auto-start fails:* `OPENAI_API_KEY=sk-... bun run voice` (→ :8099).
- **Local / open-source** *(free · private)* — $0, runs on your Mac. Point the engine at
  any OpenAI-compatible Realtime server via `OPENAI_BASE_URL`:
  ```bash
  OPENAI_BASE_URL=http://localhost:8080 OPENAI_API_KEY=local bun run voice
  ```
  Self-host the speech stack (faster-whisper STT · Piper TTS · Ollama brain). Advanced.

The chosen engine only powers **speech-in / speech-out** — Hermes still does the
reasoning. The telemetry HUD flips to **LIVE** during a call, and the core/disk react to
your real mic + Hermes's voice. Cost basis: OpenAI `gpt-realtime` is $32 / $64 per 1M
audio in/out tokens (1 token≈100ms in, 50ms out).

## Notes
- The telemetry panel (Neural Core · load · capabilities · active · channel) and the
  "◢ INITIALIZING" boot reveal appear on the Aurora/Cosmos designs only.
- Everything is one shared voice/state contract, so a new design is just a new canvas
  stage — a cold "Meridian" (technical/precision) variant is a straightforward future add.
