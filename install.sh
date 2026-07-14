#!/bin/bash
# blackbox installer — idempotent. Safe to re-run any time.
#  1. checks node, installs npm deps
#  2. checks/installs/starts Supermemory Local on :6767 (pointed at local Ollama)
#  3. installs zsh hooks + `blackbox` wrapper inside a marked block in ~/.zshrc
#  4. starts the ingest daemon
# Git capture stays opt-in per repo: run `blackbox init` inside a repo.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BLACKBOX_HOME="${BLACKBOX_HOME:-$HOME/.blackbox}"
BEGIN_MARK="# BEGIN BLACKBOX (managed by install.sh — do not edit inside this block)"
END_MARK="# END BLACKBOX"

say()  { printf '\033[1m[blackbox]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[blackbox] %s\033[0m\n' "$*"; exit 1; }

# ── 1. node + deps ─────────────────────────────────────────────
command -v node >/dev/null 2>&1 || fail "node not found — install Node.js >= 20 first"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || fail "node >= 20 required (found $(node --version))"
say "node $(node --version) ok"
(cd "$REPO_DIR" && npm install --no-fund --no-audit --silent)
say "npm dependencies installed"

mkdir -p "$BLACKBOX_HOME"
node -e "import('$REPO_DIR/lib/config.js').then(m => m.initConfig())"
say "config ready at $BLACKBOX_HOME/config.json"

# ── 2. supermemory local ───────────────────────────────────────
sm_up() { curl -s -m 2 -o /dev/null http://localhost:6767/ 2>/dev/null; }
if sm_up; then
  say "supermemory local already running on :6767"
else
  SM_BIN=""
  for c in "$HOME/.local/bin/supermemory-server" "$HOME/.supermemory/bin/supermemory-server" "$(command -v supermemory-server || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && SM_BIN="$c" && break
  done
  if [ -z "$SM_BIN" ]; then
    say "installing supermemory local (one binary, ~30s)…"
    curl -fsSL https://supermemory.ai/install | bash
    SM_BIN="$HOME/.local/bin/supermemory-server"
    [ -x "$SM_BIN" ] || SM_BIN="$HOME/.supermemory/bin/supermemory-server"
    [ -x "$SM_BIN" ] || fail "supermemory install did not produce a binary — see https://supermemory.ai/docs/self-hosting/overview"
  fi
  say "starting supermemory local (data: ~/.supermemory/data, log: $BLACKBOX_HOME/supermemory.log)"
  mkdir -p "$HOME/.supermemory/data"
  # LLM backend = local Ollama, so nothing needs a cloud key (README: privacy)
  SUPERMEMORY_DATA_DIR="$HOME/.supermemory/data" \
  OPENAI_BASE_URL="http://localhost:11434/v1" \
  OPENAI_API_KEY="ollama" \
  OPENAI_MODEL="llama3.2:3b" \
    nohup "$SM_BIN" >> "$BLACKBOX_HOME/supermemory.log" 2>&1 &
  for i in $(seq 1 60); do sm_up && break; sleep 1; done
  sm_up || fail "supermemory did not come up on :6767 — check $BLACKBOX_HOME/supermemory.log"
  say "supermemory local up on :6767 (first boot downloads the embedding model)"
fi

# ── ollama (optional but recommended) ──────────────────────────
if curl -s -m 2 -o /dev/null http://localhost:11434/api/version 2>/dev/null; then
  if ! curl -s -m 5 http://localhost:11434/api/tags 2>/dev/null | grep -q 'llama3.2:3b'; then
    say "pulling llama3.2:3b for local generation (~2 GB, one-time)…"
    ollama pull llama3.2:3b || say "WARN: pull failed — ask/standup/rca will use no-LLM fallbacks"
  fi
  say "ollama ok (llama3.2:3b)"
else
  say "WARN: Ollama not running — ask --explain / standup / rca fall back to non-LLM output (capture + search fully work)"
fi

# ── 3. zsh hooks + wrapper in ~/.zshrc (marked block) ──────────
mkdir -p "$BLACKBOX_HOME/bin"
cat > "$BLACKBOX_HOME/bin/blackbox" <<EOF
#!/bin/sh
exec node "$REPO_DIR/cli/blackbox.js" "\$@"
EOF
chmod +x "$BLACKBOX_HOME/bin/blackbox"

ZSHRC="$HOME/.zshrc"
touch "$ZSHRC"
if grep -qF "$BEGIN_MARK" "$ZSHRC"; then
  # refresh block in place (repo path may have changed)
  TMP=$(mktemp)
  awk -v begin="$BEGIN_MARK" -v end="$END_MARK" '
    $0 == begin { inblock=1; next }
    $0 == end   { inblock=0; next }
    !inblock    { print }
  ' "$ZSHRC" > "$TMP"
  mv "$TMP" "$ZSHRC"
  say "refreshed existing ~/.zshrc block"
fi
{
  echo "$BEGIN_MARK"
  echo "export PATH=\"$BLACKBOX_HOME/bin:\$PATH\""
  echo "source \"$REPO_DIR/shell/blackbox.zsh\""
  echo "$END_MARK"
} >> "$ZSHRC"
say "zsh hooks installed in ~/.zshrc (terminal commands recorded from the next shell)"

# ── 4. ingest daemon ───────────────────────────────────────────
node "$REPO_DIR/cli/blackbox.js" ingest-daemon --stop >/dev/null 2>&1 || true
node "$REPO_DIR/cli/blackbox.js" ingest-daemon --daemonize
say "ingest daemon running"

cat <<'QUICKSTART'

──────────────────────────────────────────────────────────────
 blackbox is recording. Quickstart:

   exec zsh                      # reload your shell (hooks active)
   blackbox status               # every component at a glance
   blackbox init                 # inside a repo: record its commits (opt-in)
   blackbox record               # subshell that also captures command OUTPUT

 then, after you've done some work:

   blackbox ask "why did the deploy fail" --explain
   blackbox standup --since 24h
   blackbox rca PROJ-123 --out rca.md

 Everything stays on this machine: ~/.blackbox → localhost:6767.
──────────────────────────────────────────────────────────────
QUICKSTART
