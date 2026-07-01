#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# setup-graphify-brain.sh — wire graphify into the Agentic OS as ONE shared
# brain across the dashboard, Hermes, and Claude Code.
#
# Idempotent: safe to re-run. After this, ingesting a repo in the Claude OS
# dashboard makes it queryable by BOTH agents, because both read the
# dashboard's registry (src/data/graphs/index.json) as the source of truth.
#
# Usage:  bash scripts/setup-graphify-brain.sh
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

OS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INDEX="$OS_DIR/src/data/graphs/index.json"

echo "▎ Graphify shared-brain setup"
echo

# 1. Install graphify (the program) — once, on the machine.
if ! command -v graphify >/dev/null 2>&1 && [ ! -x "$HOME/.notebooklm-venv/bin/graphify" ] && [ ! -x "$HOME/.graphify-venv/bin/graphify" ]; then
  echo "1. Installing graphify…"
  if command -v uv >/dev/null 2>&1; then
    uv tool install graphifyy
  elif command -v pipx >/dev/null 2>&1; then
    pipx install graphifyy
  else
    python3 -m venv "$HOME/.graphify-venv"
    "$HOME/.graphify-venv/bin/pip" install -q graphifyy
  fi
else
  echo "1. graphify already installed ✓"
fi

# 2. Resolve the binary + symlink onto PATH so every agent can call it.
GBIN=""
for c in "$(command -v graphify || true)" "$HOME/.notebooklm-venv/bin/graphify" "$HOME/.graphify-venv/bin/graphify" "/opt/homebrew/bin/graphify"; do
  [ -n "$c" ] && [ -x "$c" ] && { GBIN="$c"; break; }
done
if [ -z "$GBIN" ]; then echo "✗ could not find the graphify binary after install"; exit 1; fi
mkdir -p "$HOME/.local/bin"
ln -sf "$GBIN" "$HOME/.local/bin/graphify"
echo "2. graphify on PATH → ~/.local/bin/graphify ✓"

# 3. Introduce graphify to both agents (skill files — not extra installs).
echo "3. Registering with agents…"
"$GBIN" install --platform claude  >/dev/null 2>&1 && echo "   • Claude Code ✓" || echo "   • Claude Code — skipped"
"$GBIN" install --platform hermes  >/dev/null 2>&1 && echo "   • Hermes ✓"      || echo "   • Hermes — skipped"

# 4. Point both skills at the dashboard registry (the shared brain).
NOTE_MARKER="Shared brain — Claude OS knowledge graph registry"
read -r -d '' NOTE <<EOF || true
## Shared brain — Claude OS knowledge graph registry

Your Claude OS dashboard maintains a master registry of every graphed project at:

  $INDEX

ALWAYS read this file FIRST when asked about "my projects", "what have I ingested", "the codebase", or any specific project by name. Each entry has: id, name, lang, graphPath (absolute path to that project's graph.json — open it directly), nodeCount, edgeCount, communities, godNodes.

To answer about a project: find its entry, then query its graphPath with graphify (query / path / explain) or read graph.json. The "claude-os" entry is THIS operating system itself.

Ingesting a repo in the dashboard adds it here automatically — one shared memory across Hermes, Claude Code, and the dashboard.

---

EOF
for skill in "$HOME/.hermes/skills/graphify/SKILL.md" "$HOME/.claude/skills/graphify/SKILL.md"; do
  [ -f "$skill" ] || continue
  if ! grep -q "$NOTE_MARKER" "$skill"; then
    printf '%s\n' "$NOTE" | cat - "$skill" > "$skill.tmp" && mv "$skill.tmp" "$skill"
    echo "4. linked registry → $(basename "$(dirname "$(dirname "$skill")")")/graphify ✓"
  fi
done

# 5. Backfill absolute graphPath into every registry entry.
if [ -f "$INDEX" ]; then
  python3 - "$INDEX" <<'PY'
import json, os, sys
p = sys.argv[1]; absdir = os.path.dirname(os.path.abspath(p))
idx = json.load(open(p))
for e in idx: e["graphPath"] = os.path.join(absdir, e["id"] + ".json")
json.dump(idx, open(p, "w"), indent=2)
print(f"5. registry: {len(idx)} projects have absolute graphPath ✓")
PY
fi

# 6. Reload Hermes so it picks up the skill change.
if command -v hermes >/dev/null 2>&1; then
  hermes gateway restart >/dev/null 2>&1 && echo "6. Hermes gateway restarted ✓" || echo "6. restart Hermes manually (hermes gateway restart)"
fi

echo
echo "✅ Done. Ingest a repo in the dashboard, then ask either agent about it."
