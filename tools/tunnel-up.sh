#!/usr/bin/env bash
# Bring up (or reuse) a cloudflare quick tunnel to the staging server and print
# its URL. Writes /tmp/current-tunnel.txt so every other tool can find it.
#
# 🔴 WHY THIS EXISTS (R, 2026-08-15, having watched me do it wrong repeatedly):
# "Testing SFU *requires* a real network test... we *must* do it with cloudflare
# to ensure the SFU is working correctly before opening the PR."
# localhost is not a network. It exempts getUserMedia from secure-context rules
# AND lets ICE pick loopback, so a localhost pass proves nothing about the
# candidate exchange a real listener will do.
#
# 🔴 FLAGS THAT ARE NOT OPTIONAL:
#   --protocol http2      QUIC quick-tunnels DO NOT CARRY WEBSOCKETS. Measured
#                         2026-08-15: page 200, ws upgrade 0. The world dies at
#                         the /ws handshake and looks like a bad key.
#   --edge-ip-version 4   IPv6 edges flap (1033s).
#   --retries 10          quick tunnels hold ONE edge connection (connIndex=0)
#                         with no failover, so every drop is a visible 530.
#                         A NAMED tunnel gets 4; that needs a CF account.
set -euo pipefail
PORT="${PORT:-8960}"
LOG=/tmp/tunnel-$PORT.log
if pgrep -x cloudflared >/dev/null && [ -s /tmp/current-tunnel.txt ]; then
  U=$(cat /tmp/current-tunnel.txt)
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$U/?world=staging" || true)" = "200" ]; then
    echo "$U"; exit 0                      # healthy tunnel: reuse it
  fi
fi
pkill -x cloudflared 2>/dev/null || true; sleep 2
nohup /tmp/cloudflared tunnel --protocol http2 --edge-ip-version 4 --retries 10 \
  --url "http://127.0.0.1:$PORT" > "$LOG" 2>&1 & disown
for _ in $(seq 1 20); do
  U=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1) || true
  [ -n "${U:-}" ] && break; sleep 3
done
[ -z "${U:-}" ] && { echo "no tunnel URL after 60s; see $LOG" >&2; exit 1; }
# 🔴 A URL IN THE LOG IS NOT A LIVE TUNNEL. Propagation lags registration —
# curling too early returns 000 and looks like a dead tunnel (hit twice today).
for _ in $(seq 1 10); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$U/?world=staging" || true)" = "200" ] && break
  sleep 3
done
echo "$U" > /tmp/current-tunnel.txt
echo "$U"
