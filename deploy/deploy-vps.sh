#!/usr/bin/env bash
# Deploy eidoverse-worlds on the show VPS (eidoverse.animalabs.ai).
# Run ON the VPS:   /opt/eidoverse/deploy/deploy-vps.sh
# Or from anywhere: ssh ubuntu@eidoverse.animalabs.ai /opt/eidoverse/deploy/deploy-vps.sh
#
# Code comes from git (origin/main). Everything the working tree accumulates
# at runtime is gitignored and survives untouched; under the units in deploy/
# the state is in /var/lib/eidoverse, not here. Assets travel by rsync, not git.
set -euo pipefail
cd "$(dirname "$0")/.."

# A box in the old layout (the checkout and its state under a home, the units running as its owner) is moved by hand,
# once, by the box's owner, who can roll it back: docs/operator/RUNNING-A-SERVER.md, "Moving a box to /opt". This
# script never moves it. It stops here, before fetching, so a refused deploy changes nothing.
refuse() { echo "deploy: $1; nothing deployed." >&2; exit 1; }
old_layout() { refuse "$1. See docs/operator/RUNNING-A-SERVER.md, \"Moving a box to /opt\""; }
here=$(pwd -P)   # a symlink from the old place to /opt/eidoverse is not the old layout
case $here in /home/*) old_layout "this checkout is in a home ($here), not /opt/eidoverse";; esac
for unit in deploy/*.service deploy/*.service.template; do
  name=$(basename "${unit%.template}" .service)
  [ -f "/etc/systemd/system/$name.service" ] || continue
  wd=$(systemctl show -p WorkingDirectory --value "$name")
  [ -z "$wd" ] || wd=$(realpath -m "$wd")   # both physical: /opt may be a symlink to a data volume
  [ -z "$wd" ] || [[ $wd == "$here" || $wd == "$here"/* ]] || old_layout "$name.service runs $wd, not this checkout ($here)"
done
# state and secrets the units now keep in /var/lib and /etc (WORLDS_DIR=… in their environment) but still here
for pair in eidoverse:WORLDS_DIR:worlds eidoverse:BACKUPS_DIR:backups eidoverse:OPT_DIR:assets/opt \
    eidoverse:SESSIONS_PATH:.sessions.json eidoverse-mcpl:MCPL_STATE:mcpl/state.json eidoverse:AGENT_TOKENS_PATH:mcpl/tokens.json; do
  IFS=: read -r name var path <<<"$pair"
  [ -n "$(ls -A "$path" 2>/dev/null)" ] || continue   # absent, or an empty directory a tool made
  [[ " $(systemctl show -p Environment --value "$name") " != *" $var="* ]] || old_layout "$path is still here, but $name.service reads $var"
done
# bun loads a .env from its working directory and skips one it can't read without a word: a JOIN_TOKEN there would
# leave the door open. What the units need goes in /etc/eidoverse/<unit>.env.
if id -u eidoverse >/dev/null 2>&1; then
  for f in .env .env.* services/chatbridge/.env services/chatbridge/.env.*; do
    [ ! -e "$f" ] || sudo -u eidoverse test -r "$f" || old_layout "$f is not readable by eidoverse, so the units would run without it: move what it sets to /etc/eidoverse/<unit>.env"
  done
  # the agents' tokens are read by the units themselves, not by systemd: through a 0700 /etc/eidoverse they would see
  # no enrolments, and say nothing
  for pair in eidoverse:AGENT_TOKENS_PATH eidoverse-mcpl:MCPL_TOKENS; do
    IFS=: read -r name var <<<"$pair"
    tok=$(systemctl show -p Environment --value "$name" | tr ' ' '\n' | sed -n "s/^$var=//p")
    [ -z "$tok" ] || ! sudo test -e "$tok" || sudo -u eidoverse test -r "$tok" \
      || refuse "$tok is not readable by eidoverse ($name.service reads it): /etc/eidoverse must be 755, the file root:eidoverse 0640"
  done
fi

# bun is the box's, installed and upgraded by hand (docs/operator/RUNNING-A-SERVER.md, "Upgrading bun"), never here
BUN=${BUN:-/usr/local/bin/bun}
[ -x "$BUN" ] || { echo "deploy: no bun at $BUN (docs/operator/RUNNING-A-SERVER.md, \"Upgrading bun\"); nothing deployed" >&2; exit 1; }

before=$(git rev-parse --short HEAD)
# Installs are keyed to the last deploy that finished (.deploy-done, gitignored), not to the pre-reset HEAD,
# so a retry after a failed install, or after an older script stopped partway, redoes them.
done_at=$(cat .deploy-done 2>/dev/null || true)
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
# against the package.json just fetched: a bump warns on the deploy that brings it
want=$("$BUN" -e 'console.log(require("./package.json").engines.bun)')
[ "$("$BUN" --version)" = "$want" ] || echo "bun: $BUN is $("$BUN" --version), package.json wants $want: upgrade it (docs/operator/RUNNING-A-SERVER.md, \"Upgrading bun\")" >&2
# true when these paths moved since the last finished deploy, or there is none to compare with
changed() { [ -n "$done_at" ] && git diff --quiet "$done_at" "$after" -- "$@" 2>/dev/null && return 1; return 0; }

# deps only when the manifests/lockfiles moved (bun.lock: a lockfile change that goes unwatched
# ships a client importing a module the VPS never installed, and boot hangs)
if changed client/package.json client/bun.lock; then
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
if changed package.json bun.lock; then
  "$BUN" install
fi
# chat bridge (services/chatbridge) — optional service; deps on manifest change,
# restarted below only where its unit is installed
if changed services/chatbridge/package.json services/chatbridge/bun.lock; then
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
# the user each unit runs as (User=), also for one installed by hand from a .template: a system user, no login, no home
ensure_user() { id -u "$1" >/dev/null 2>&1 || { sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$1" && echo "user: made $1"; }; }
for name in "${units[@]}" "${optional[@]}"; do user=$(systemctl show -p User --value "$name"); [ -z "$user" ] || ensure_user "$user"; done

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
git rev-parse --short HEAD > .deploy-done
echo "deployed $after"
