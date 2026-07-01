#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# graph-to-dashboard.sh — graph a repo and register it INTO the Claude OS
# dashboard so it appears in the Knowledge Graph gallery (and the shared
# registry every agent reads).
#
# This is the agent→dashboard bridge. When Hermes or Claude Code is asked to
# graph a new project, running this ONE command routes it through the
# dashboard's own ingest endpoint — so the graph, its metadata, and the 3D
# view all land in the dashboard exactly as if you'd pasted it into the
# "Add a project" box. No drift, no separate folder.
#
# Usage:
#   bash scripts/graph-to-dashboard.sh ~/code/my-repo
#   bash scripts/graph-to-dashboard.sh https://github.com/user/repo
#
# Env:
#   CLAUDE_OS_URL   dashboard base URL (default http://localhost:8081)
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

TARGET="${1:-}"
BASE="${CLAUDE_OS_URL:-http://localhost:8081}"

if [ -z "$TARGET" ]; then
  echo "usage: graph-to-dashboard.sh <local-path-or-github-url>" >&2
  exit 1
fi

# 1. Is the dashboard running?
if ! curl -sf -o /dev/null "$BASE/__token" 2>/dev/null; then
  echo "✗ Claude OS dashboard isn't reachable at $BASE" >&2
  echo "  Start it (bun run dev in ~/code/claude-os) or set CLAUDE_OS_URL." >&2
  exit 1
fi

# 2. Grab the per-run token that gates the ingest endpoint.
TOKEN=$(curl -s "$BASE/__token" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || true)
if [ -z "$TOKEN" ]; then
  echo "✗ couldn't get the dashboard auth token" >&2
  exit 1
fi

echo "▎ graphing + registering: $TARGET"

# 3. POST to the dashboard's ingest endpoint — it runs graphify, writes the
#    graph + registry entry, and (for URLs) clones/cleans up. Same path the
#    UI uses, so the result is identical.
RESP=$(curl -s -X POST "$BASE/__graphify_ingest" \
  -H "Content-Type: application/json" \
  -H "x-claude-os-token: $TOKEN" \
  -d "$(python3 -c "import json,sys; print(json.dumps({'path': sys.argv[1]}))" "$TARGET")" \
  --max-time 600)

# 4. Report.
echo "$RESP" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print('✗ unexpected response:', sys.stdin.read()[:300]); sys.exit(1)
if d.get('ok'):
    p = d['project']
    print(f\"✓ {p['name']} → {p['nodeCount']} files, {p['communities']} clusters, {p['lang']}\")
    print('  It now appears in the Claude OS dashboard gallery + the shared registry.')
    if d.get('warning'): print('  note:', d['warning'])
else:
    print('✗', d.get('error', 'ingest failed'))
    sys.exit(1)
"
