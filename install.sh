#!/bin/bash
# blackbox installer — thin wrapper for the clone-and-run path. All real
# setup lives in `blackbox setup` (cli/cmd/setup.js), so the npm path is
# identical:
#   npm install -g blackbox && blackbox setup
# Idempotent, safe to re-run. After a reboot you only need: blackbox up
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v node >/dev/null 2>&1 || { printf '\033[31m[blackbox] node not found — install Node.js >= 20 first\033[0m\n'; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { printf '\033[31m[blackbox] node >= 20 required (found %s)\033[0m\n' "$(node --version)"; exit 1; }

(cd "$REPO_DIR" && npm install --no-fund --no-audit --silent)
printf '\033[1m[blackbox]\033[0m npm dependencies installed\n'

exec node "$REPO_DIR/cli/blackbox.js" setup "$@"
