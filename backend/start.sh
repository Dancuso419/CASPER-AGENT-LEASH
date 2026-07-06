#!/usr/bin/env bash
# Launch the Agent Leash backend from WSL. Node deps + casper-client only work on the
# Linux filesystem, so we sync this repo's backend into ~/agent-leash-backend and run there.
# Requires: nvm+node, casper-client (~/.cargo/bin), keys in ~/casper-keys, ~/proxy_caller.wasm.
set -e
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
NODE_BIN="$(dirname "$(command -v node)")"
REPO="$(cd "$(dirname "$0")" && pwd)"
RUN="$HOME/agent-leash-backend"
mkdir -p "$RUN"
cp -r "$REPO/src" "$REPO/public" "$RUN/"
cp "$REPO/package.json" "$RUN/"
[ -f "$REPO/.env" ] && cp "$REPO/.env" "$RUN/"
[ -d "$RUN/node_modules" ] || (cd "$RUN" && PATH="$NODE_BIN:$PATH" npm install --no-fund --no-audit)
pkill -f 'node src/server.js' 2>/dev/null || true; sleep 1
cd "$RUN"
PATH="$NODE_BIN:$HOME/.cargo/bin:$PATH" setsid nohup node src/server.js > "$HOME/backend.log" 2>&1 < /dev/null &
disown
sleep 4
ss -ltn 2>/dev/null | grep -q 3001 && echo "Backend up: http://localhost:3001" || { echo "Failed to start:"; cat "$HOME/backend.log"; }
