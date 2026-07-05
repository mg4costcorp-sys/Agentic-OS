---
name: handoff
description: Write a complete session handoff to docs/handoffs/ and push it, so the next session — possibly on a different machine (MacBook Air ↔ Mac Studio) — can pick up full context with a single git pull. Trigger: `/handoff` or when the operator says they're switching computers.
---

# /handoff — Cross-machine session continuity

Matthieu works from two Macs (a MacBook Air and a Mac Studio). Claude Code session history is **local to whichever machine it ran on** — there is no built-in sync between them. `CLAUDE.md` also forbids touching `~/.claude/` directly except via the aggregator, so this skill never tries to sync raw session files. Instead it writes a self-contained markdown handoff into the git repo, which both machines already have cloned (see `scripts/bootstrap-mac-studio.sh`) — `git pull` is the sync mechanism.

## When invoked

1. **Write the handoff doc.** Summarize the current conversation as if the reader has zero memory of it. Save to `docs/handoffs/{YYYY-MM-DD}-{slug}.md` (slug = short kebab-case topic, e.g. `crm-catherine`, `dream-cron-fix`). Structure:
   - **Contexte** — what is this about, why it matters
   - **Décisions prises** — the concrete choices made so far, with reasoning (not just conclusions)
   - **Architecture / code proposé** — any concrete designs, snippets, file structures discussed (verbatim, don't summarize away detail that would need re-deriving)
   - **État d'avancement** — what's actually built vs. still just discussed (be explicit: "rien n'est codé, ceci est une proposition" if that's true)
   - **Prochaines étapes** — what the next session should do first
   - Any open questions the operator hasn't resolved yet

2. **Commit and push.**
   ```
   git add docs/handoffs/{file}.md
   git commit -m "Add handoff: {topic}"
   git push
   ```

3. **Tell the operator exactly what to do on the other machine:**
   ```
   cd ~/Agentic-OS && git pull
   claude
   ```
   Then paste: `Lis docs/handoffs/{file}.md au complet et continue à partir de là.`

## Guard rails

- Never read or write anything under `~/.claude/` — this skill only touches files inside the git repo.
- The handoff doc must be self-contained. If it references a decision, include the *why*, not just the *what* — the next session (and the next machine) has no other context.
- Don't create a handoff doc for trivial exchanges — this is for substantial work (a plan, an architecture, a multi-step task) that's worth resuming elsewhere.
- Overwrite is fine if a handoff for the same topic+day already exists; otherwise always create a new dated file rather than appending, so history stays readable via `git log`.
