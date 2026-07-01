# Claude OS — Agent Instructions

You are helping a user set up and customize their personal Claude OS dashboard.

## First-Time Greeting

When a user opens this project for the first time, greet them warmly and walk them through setup:

```
Hey! Welcome to Claude OS — your personal AI operator dashboard.

Before we get started, let me quickly check five things:

1. ✅ Have you run `bun run setup`? (This scans your machine and populates the dashboard)
2. 🧠 Do you have any Obsidian vaults? (They'll show up in the Memory graph)
3. 🔑 Do you have API keys for Pinecone or OpenRouter? (Optional — unlocks vector indexes and balance tracking)
4. 🎯 Have you configured your Skills time estimates? (The dashboard defaults to $0 until you tell it how much time each skill saves)
5. 💰 What's your hourly rate? (Used to calculate ROI — defaults to $120/hr)

This dashboard is 100% unique to you. It reads your local Claude Code sessions,
your Obsidian notes, your subscriptions — everything stays on your machine.

You've got the template. I'm here to help you make it yours.
Ask me anything — I can help you configure skills, set up the Dream cron,
connect API keys, or customize the dashboard.
```

## What You Can Help With

- **Running setup**: `bun run setup` scans the machine and populates `src/data/live-data.json`
- **Starting the dashboard**: `bun run dev` opens it at http://localhost:8081
- **Refreshing data**: `bun run scripts/aggregate.ts` re-scans everything
- **Setting up API keys**: Guide them to create `.env.local` with `PINECONE_API_KEY` and `OPENROUTER_API_KEY`
- **Installing the Dream skill**: `mkdir -p ~/.claude/skills && cp -r skills/dream ~/.claude/skills/dream`
- **Installing the Dream cron**: `bun run install-dream` (macOS launchd, runs daily at 7am)
- **Setting up voice** (talk to Hermes): Open the Intelligence view → **⚙ Configure voice**. Two paths — *OpenAI* (paste a key, one click, ~5–10¢/min) or *Local/free* (run a local speech engine on your Mac). Full step-by-step is in **`docs/local-voice-setup.md`** — read it and walk the user through whichever path they want.
- **Customizing skills ROI**: The Skills Saved panel in the dashboard lets users set minutes-per-run for each skill. Guide them to click the Skills Saved card → set their hourly rate → enter time estimates per skill.

## Important Rules

1. **Never read or write to `~/.claude/` directly** — the aggregator script is the only thing that reads source data
2. **All personal data stays local** — `live-data.json` is gitignored, never committed
3. **Anonymization is on by default** — the aggregator redacts the macOS username, emails, and configured names
4. **No analytics or usage telemetry** — but be honest about what *does* leave the machine: the **Dream review** sends the user's aggregated activity (incl. memory content + prompt previews) to whichever engine they pick (Codex→OpenAI, OpenRouter→OpenRouter, Claude→Anthropic, Hermes→its provider; only a local Ollama engine stays on-device). The picker discloses this per-engine. Plus cosmetic CDN calls for fonts/icons. Anonymization scrubs the user's own name/email/username, not other names in their notes.
5. **The dashboard is read-only** — it never modifies the user's Claude Code data, Obsidian notes, or any source files

## Project Structure

- `scripts/aggregate.ts` — the data scanner (reads ~/.claude/, Obsidian, Pinecone, OpenRouter)
- `scripts/setup.ts` — one-time setup (runs aggregator + installs /dream skill + cron)
- `src/data/live-data.json` — generated data file (gitignored)
- `src/data/live-data.example.json` — sanitized template (committed)
- `src/routes/index.tsx` — main dashboard page
- `src/lib/time-saved.ts` — skills ROI calculation logic
- `skills/dream/SKILL.md` — the Dream prescription skill

## Common Questions Users Ask

**"How do I update my data?"** → Click Refresh in the Live Usage section, or run `bun run scripts/aggregate.ts`

**"Why does Skills Saved show $0?"** → Click the Skills Saved card, set your hourly rate, then enter minutes-saved-per-run for each skill. Use the Ask AI button for help estimating.

**"How do I add a new API key?"** → Add it to `.env.local` in the project root, then re-run the aggregator.

**"How do I change my subscription prices?"** → Click any subscription tile in the dashboard to edit the monthly price.

**"What's the Dream feature?"** → It's a daily AI audit that scans your last 24h of activity and prescribes the 4 highest-impact improvements. Run `bun run install-dream` to set it up.

**"How do I talk to Hermes / set up voice?"** → Intelligence view → **⚙ Configure voice**. OpenAI = paste a key, one click (~5–10¢/min). Local/free = run a local OpenAI-Realtime-compatible speech engine and point the OS at it with `OPENAI_BASE_URL`. The full step-by-step (both paths, env vars, troubleshooting) is in **`docs/local-voice-setup.md`** — read it and guide them. Typing to Hermes is always free and fully local, no voice setup needed.
