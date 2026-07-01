# Integration notes — `feat/intelligence-portal` → `main`

This branch was built on an **older base**; `main` has since moved ~62 commits ahead
(Model Intelligence, Antigravity, Mission Control, Graphify V2.5, etc.). So this is a
**layer-on-top job, not a fast-forward.** Most of the branch is brand-new files (no
conflict). Three files overlap with `main` — guidance below.

## What this branch adds
The **Hermes Intelligence view** — a full-screen "tap the orb to talk" command centre:
voice mode (OpenAI Realtime as ears+mouth, Hermes as the brain), a living force-directed
mind-graph, 5 node modes (Atlas / Plasma / Sonar / Pulse / Rider), a per-section nerve-strip
of capability logos, draggable chat, and the bundled **voice-lab** backend.

## New files — just add, no conflict
- `src/components/intelligence-portal.tsx` — the view (chat rail, graph, strip, voice).
- `src/components/hermes-mind-3d.tsx` — the react-force-graph-3d "living mind" + core orb.
- `src/components/oracle-plasma.tsx` / `oracle-sonar.tsx` / `oracle-waveform.tsx` / `oracle-rider.tsx`
  — the four alternate orb visualisers (self-contained canvas, react-only).
- `voice-lab/` — the OpenAI Realtime token server (see voice-lab/README.md).
- `src/components/agent-core-3d.tsx` — obsolete earlier prototype, safe to delete.

## Files that CONFLICT with main — how to resolve
1. **`src/routes/agents.hermes.tsx`** — keep main's newer page, then layer in this branch's
   voice bridge:
   - `intelEvents` state + `voiceHermesSession` ref.
   - `fireIntel(data)` — keyword-matches Hermes's stderr/info stream → lights the matching
     strip logo (covers apps + models: claude/anthropic/opus/sonnet, gemini, codex/gpt-…).
   - `askHermes(request, opts)` — the voice bridge: POSTs `/__hermes_chat`, **captures Hermes's
     real `session_id` from the info stream into `voiceHermesSession` and resumes it** (native
     continuity), routes `info` events to `fireIntel`, returns the text. For voice it passes
     `{ voice:true, yolo:true }` (no `sessionId` on turn 1; resumed after).
   - Mounts `<IntelligencePortal state={…} events={intelEvents} demo={…} onVoiceRequest={askHermes} onClose={…} />`.
   - The dashboard chat's KG call now sends `{ yolo:true, graph:true }` (see vite.config below).
2. **`vite.config.ts`** — in the `/__hermes_chat` middleware, **decouple yolo from the graphify skill**
   (this branch's key fix — Jack's Hermes has no `graphify` skill, so the old `yolo`→`-s graphify`
   errored on every tool call):
   - payload type: add `graph?: boolean`; parse `const graph = payload.graph === true;`
   - replace `if (yolo) args.push("--yolo", "-s", "graphify");`
     with `if (yolo) args.push("--yolo");` and `if (graph) args.push("-s", "graphify");`
   - The Knowledge-Graph chat caller must pass `{ yolo:true, graph:true }` to keep its behaviour.
3. **`src/data/graphs/index.json`** — this branch's data edits are **stale**; **take main's version**
   (main's Graphify V2.5 is authoritative). Discard this branch's graph-data changes/deletions.

## Wiring voice-lab
- Run `bun run voice-lab/server.ts` (or `bun run voice`) on port 8099. Needs `OPENAI_API_KEY`
  with Realtime access (voice-lab/.env.example). The app calls `http://localhost:8099`.
- A `voice-lab` config has been added to `.claude/launch.json`.

## Prerequisites for it to actually work
- **Hermes installed locally** — `/__hermes_chat` spawns the real `hermes` CLI.
- **OpenAI key** (Realtime) for voice-lab.
- `bun install` + run the app (`bun run dev`, port 8081) alongside voice-lab.
