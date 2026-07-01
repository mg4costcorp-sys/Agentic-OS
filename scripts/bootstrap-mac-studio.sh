#!/usr/bin/env bash
# Bootstrap a second Mac (e.g. Mac Studio) to match this Claude OS setup.
#
# Run on the NEW machine with:
#   curl -fsSL https://raw.githubusercontent.com/mg4costcorp-sys/Agentic-OS/main/scripts/bootstrap-mac-studio.sh | bash
#
# Idempotent: safe to re-run if it fails partway through.
set -euo pipefail

REPO_URL="https://github.com/mg4costcorp-sys/Agentic-OS.git"
REPO_DIR="$HOME/Agentic-OS"
ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs"

c_bold=$'\033[1m'; c_cyan=$'\033[36m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_reset=$'\033[0m'
step() { echo ""; echo "${c_bold}${c_cyan}▸ $1${c_reset}"; }
ok()   { echo "  ${c_green}✓${c_reset} $1"; }
warn() { echo "  ${c_yellow}⚠${c_reset} $1"; }

step "Xcode Command Line Tools (needed for git)"
if ! xcode-select -p >/dev/null 2>&1; then
  warn "Not installed — a system dialog will pop up now. Click Install and re-run this script when it's done."
  xcode-select --install
  exit 1
else
  ok "already installed"
fi

step "Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  warn "Installing Homebrew — this WILL ask for your Mac password, that's normal."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
else
  ok "already installed"
fi

step "Desktop apps (Obsidian, Antigravity IDE, Claude)"
brew install --cask obsidian 2>&1 | tail -1 || ok "obsidian already installed"
brew install --cask antigravity-ide 2>&1 | tail -1 || ok "antigravity-ide already installed"
brew install --cask antigravity 2>&1 | tail -1 || ok "antigravity already installed"
brew install --cask claude 2>&1 | tail -1 || ok "claude already installed"

step "uv (Python 3.11, needed for graphify)"
if [ ! -x "$HOME/.local/bin/uv" ]; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
else
  ok "already installed"
fi

step "bun"
if [ ! -x "$HOME/.bun/bin/bun" ]; then
  curl -fsSL https://bun.sh/install | bash
else
  ok "already installed"
fi

step "PATH (~/.zshrc)"
PATH_LINE='export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"'
if ! grep -qF "$PATH_LINE" "$HOME/.zshrc" 2>/dev/null; then
  echo "$PATH_LINE" >> "$HOME/.zshrc"
  ok "added"
else
  ok "already present"
fi
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

step "Clone Agentic-OS"
if [ -d "$REPO_DIR/.git" ]; then
  ok "already cloned at $REPO_DIR — pulling latest"
  git -C "$REPO_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$REPO_DIR"
fi

step "Install dependencies"
cd "$REPO_DIR"
bun install

step "Run Claude OS setup (aggregator, Dream skill, Dream cron)"
bun run scripts/setup.ts || warn "setup.ts reported an issue — check output above"

step "graphify (codegraph)"
if [ ! -x "$HOME/.local/bin/graphify" ]; then
  uv tool install graphifyy
  ln -sf "$HOME/.local/share/uv/tools/graphifyy/bin/graphify" "$HOME/.local/bin/graphify"
fi
graphify install --platform claude || warn "graphify register failed — you may need to run 'claude' once first"

step "~/.claude-os/config.json"
mkdir -p "$HOME/.claude-os"
if [ ! -f "$HOME/.claude-os/config.json" ]; then
  cat > "$HOME/.claude-os/config.json" <<'JSON'
{
  "dreamEngine": "claude",
  "valuation": {
    "hourlyRateUsd": 120
  }
}
JSON
  ok "written"
else
  ok "already exists — left untouched"
fi

step "Obsidian vault (via iCloud Drive)"
mkdir -p "$ICLOUD/ObsidianVaults"
if [ -d "$ICLOUD/ObsidianVaults/Agentic OS" ]; then
  ok "vault present at: $ICLOUD/ObsidianVaults/Agentic OS"
  warn "Open Obsidian → 'Open folder as vault' → pick that path (first time only)."
else
  warn "Vault not synced down from iCloud yet. Wait a few minutes for iCloud to finish, then check:"
  warn "  $ICLOUD/ObsidianVaults/"
fi

step "Still needs YOU (can't be scripted)"
echo "  1. Open Claude.app once and sign in (or run: claude setup-token)"
echo "  2. Open Obsidian → open the vault at: ~/Library/Mobile Documents/com~apple~CloudDocs/ObsidianVaults/Agentic OS"
echo "  3. Open Antigravity IDE / Antigravity.app once and sign in"
echo "  4. First git push from this machine will ask for GitHub login (browser popup) — that's normal"
echo ""
echo "${c_bold}${c_green}Done. Run:${c_reset} cd ~/Agentic-OS && bun run dev"
