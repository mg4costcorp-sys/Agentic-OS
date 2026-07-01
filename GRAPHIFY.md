# Graphify — the shared brain

graphify maps any codebase (or docs/transcripts) into a knowledge graph.
Claude OS wires it into **one shared memory** across the dashboard, Hermes,
and Claude Code.

## How the shared brain works

The dashboard's registry is the single source of truth:

    src/data/graphs/index.json

Every entry carries an absolute `graphPath` → that project's `graph.json`.
Both agents' graphify skills are pointed at this file, so:

- **Ingest a repo in the dashboard** → it's added to `index.json` →
  **both Hermes and Claude Code can immediately query it.**
- The `claude-os` entry is the OS graphing itself, so the agents can
  reason about Claude OS's own structure.

One ingest, every agent sees it. No re-graphing per tool.

## Replicate the whole setup (one command)

    bash scripts/setup-graphify-brain.sh

Idempotent. It:
1. installs graphify (`graphifyy` on PyPI; command is `graphify`) if missing
2. symlinks it onto PATH (`~/.local/bin/graphify`)
3. registers it with both agents (`graphify install --platform claude|hermes`)
4. links both skills to the dashboard registry
5. backfills absolute `graphPath` into `index.json`
6. restarts the Hermes gateway

## Use it

- **Dashboard:** paste a local path or GitHub URL into "Add a project".
- **Either agent:** "graph ~/code/my-repo and explain it", or `/graphify .`
  inside a repo, then ask naturally — the skill triggers itself and runs
  `graphify query / path / explain` against the graph.

## Cost

AST extraction is local, no LLM, ≈ $0. Querying the map instead of
re-reading files saves tokens per question (surfaced as "Saved so far"
in the dashboard).
