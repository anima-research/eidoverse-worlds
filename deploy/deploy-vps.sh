#!/usr/bin/env bash
# Deploy eidoverse-worlds on the show VPS (eidoverse.animalabs.ai).
# Run ON the VPS:   ~/eidoverse-worlds/deploy/deploy-vps.sh
# Or from anywhere: ssh ubuntu@eidoverse.animalabs.ai eidoverse-worlds/deploy/deploy-vps.sh
#
# Code comes from git (origin/main). Everything the working tree accumulates
# at runtime — worlds/, mcpl/tokens.json, mcpl/state.json, assets/ — is
# gitignored and survives untouched. Assets travel by rsync, not git.
set -euo pipefail
cd "$(dirname "$0")/.."

BUN="$HOME/.bun/bin/bun"

before=$(git rev-parse --short HEAD)
git fetch origin main
git reset --hard origin/main
after=$(git rev-parse --short HEAD)
echo "code: $before -> $after"

# deps only when the manifests/lockfiles moved (bun migrated package-lock.json
# to bun.lock — watching only the old name once shipped a client that imported
# a module the VPS had never installed, and boot hung at "waking the engine")
if ! git diff --quiet "$before" "$after" -- client/package.json client/bun.lock client/package-lock.json 2>/dev/null; then
  (cd client && "$BUN" install)
fi
# mcpl/'s siblings (mcpl-core-ts, which the door imports, and agent-framework) and tools/captionbot's: run.ts pins them,
# checks them out in tools/protocol/.siblings/ (gitignored, so the reset keeps them), builds them, and installs mcpl/ and
# tools/captionbot/ with --frozen-lockfile; at the pin it only re-checks. Every deploy, since a pin can move in run.ts alone. A
# plain `bun install` in mcpl/ dropped a missing optional sibling without a word and the door stopped on restart; this
# fails here instead, under set -e, before the restarts.
"$BUN" tools/protocol/run.ts --siblings
# root deps power server/optimize.ts (the store's GLB diet); the sequencer
# itself stays dependency-free. Under set -e a failed install stops this
# script here, before the chat bridge's install and the restarts.
if ! git diff --quiet "$before" "$after" -- package.json bun.lock 2>/dev/null; then
  "$BUN" install
fi
# chat bridge (tools/chatbridge) — optional service; deps on manifest change,
# restart only where the unit is actually installed
if ! git diff --quiet "$before" "$after" -- tools/chatbridge/package.json tools/chatbridge/bun.lock 2>/dev/null; then
  (cd tools/chatbridge && "$BUN" install)
fi
sudo systemctl try-restart eido-chatbridge 2>/dev/null || true

# An in-place install keeps ndarray-pixels' own copy of sharp after the
# lockfile stops listing it, and optimize.ts loads that copy whenever it
# exists (getSharp), so the server would keep an old sharp. Whatever deploy
# left one, it goes here, while eidoverse is stopped: a running optimize pass
# already holds ndarray-pixels' copy, and resolving sharp after the removal
# would load a second libvips.
if [ -d node_modules/ndarray-pixels/node_modules/sharp ] \
  && ! grep -q '"ndarray-pixels/sharp"' bun.lock; then
  sudo systemctl stop eidoverse
  rm -rf node_modules/ndarray-pixels/node_modules/sharp
fi
sudo systemctl restart eidoverse eidoverse-mcpl
sleep 2
systemctl is-active eidoverse eidoverse-mcpl
echo "deployed $after"
