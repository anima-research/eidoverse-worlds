#!/bin/bash
# Mac-side /snap renderer for the GPU-less show box: a thin wrapper around
# render-watchdog.ts, which keeps the renderer not just RUNNING but HEALTHY —
# restarting it on hang, memory bloat, freeze, or a client deploy.
#
#   SHOW_URL=https://eidoverse.animalabs.ai WORLD=commons KEY=doorkey \
#     deploy/run-mac-renderer.sh
#
# Extra knobs (optional): MEM_CAP_GB, MAX_UPTIME_MIN, CHECK_SEC, PORT, CHROME.
set -u
: "${SHOW_URL:?set SHOW_URL (e.g. https://eidoverse.animalabs.ai)}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec bun "$DIR/deploy/render-watchdog.ts"
