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
# An installed unit whose new version needs an EnvironmentFile the box lacks stops the deploy
# here, before the reset, so the old unit still finds the code it points at.
for unit in $(git ls-tree --name-only origin/main deploy/ | grep '\.service$'); do
  name=$(basename "$unit" .service); dest=/etc/systemd/system/$name.service
  [ -f "$dest" ] || continue
  git show "origin/main:$unit" | cmp -s - "$dest" && continue
  # plain EnvironmentFile=<path> lines only: a "-" prefix, quotes or several paths on one line are not parsed
  for env in $(git show "origin/main:$unit" | sed -n 's/^EnvironmentFile=//p'); do
    sudo test -f "$env" || { echo "unit: $name.service needs $env (its header says what goes in it); nothing deployed" >&2; exit 1; }
  done
done
git reset --hard origin/main
after=$(git rev-parse --short HEAD)
echo "code: $before -> $after"

# deps only when the manifests/lockfiles moved (bun.lock: a lockfile change that goes unwatched
# ships a client importing a module the VPS never installed, and boot hangs)
if ! git diff --quiet "$before" "$after" -- client/package.json client/bun.lock 2>/dev/null; then
  (cd client && "$BUN" install)
fi
# mcpl/'s siblings (mcpl-core-ts, which the door imports, and agent-framework) and services/captionbot's: run.ts pins them,
# checks them out in .siblings/ (gitignored, so the reset keeps them), builds them, and installs mcpl/ and
# services/captionbot/ with --frozen-lockfile; at the pin it only re-checks. Every deploy, since a pin can move in run.ts alone. A
# plain `bun install` in mcpl/ dropped a missing optional sibling without a word and the door stopped on restart; this
# fails here instead, under set -e, before the restarts.
"$BUN" test/gate/run.ts --siblings
# root deps: server/optimize.ts (the store's GLB diet) and what the sequencer imports (werift,
# pngjs, quickjs-emscripten, three). Under set -e a failed install stops this
# script here, before the chat bridge's install and the restarts.
if ! git diff --quiet "$before" "$after" -- package.json bun.lock 2>/dev/null; then
  "$BUN" install
fi
# chat bridge (services/chatbridge) — optional service; deps on manifest change,
# restarted below only where its unit is installed
if ! git diff --quiet "$before" "$after" -- services/chatbridge/package.json services/chatbridge/bun.lock 2>/dev/null; then
  (cd services/chatbridge && "$BUN" install)
fi

# Each deploy/*.service the box has installed is re-installed when it differs (docs/operator/RUNNING-A-SERVER.md);
# its env files were checked before the reset. Those optional units are only try-restarted: one the operator stopped stays stopped.
units=(eidoverse eidoverse-mcpl); optional=(); reload=0
for unit in deploy/*.service; do
  name=$(basename "$unit" .service); dest=/etc/systemd/system/$name.service
  [ -f "$dest" ] || continue
  [[ " ${units[*]} " == *" $name "* ]] || { systemctl is-active --quiet "$name" && units+=("$name"); optional+=("$name"); }
  [ "$(systemctl show -p NeedDaemonReload --value "$name")" = yes ] && reload=1   # an install a failed run left unloaded
  cmp -s "$unit" "$dest" && continue
  sudo install -m 644 "$unit" "$dest"; reload=1; echo "unit: re-installed $name.service"
done
[ "$reload" = 0 ] || sudo systemctl daemon-reload

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
[ "${#optional[@]}" = 0 ] || sudo systemctl try-restart "${optional[@]}"
sleep 2
# one unit at a time: `is-active a b` exits 0 when any one of them is up
for name in "${units[@]}"; do systemctl is-active --quiet "$name" || { echo "deploy: $name is not running after the restart (journalctl -u $name)" >&2; exit 1; }; done
echo "deployed $after"
