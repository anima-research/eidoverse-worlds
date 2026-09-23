#!/bin/sh
# Render mediamtx.template.yml into a runtime config. Fail-closed:
#
#   default            loopback only (PROJECTOR_BIND=127.0.0.1), a key minted
#                      for this run and printed once — a dev box cannot
#                      accidentally become a network appliance, and there is
#                      no shared password to know;
#   PROJECTOR_BIND=X   any other bind (0.0.0.0, an interface address) REQUIRES
#                      an explicit PROJECTOR_PUBLISH_KEY of 16+ characters;
#                      the historical dev key is refused by name.
#
#   deploy/projector/mkconfig.sh <out.yml>
#
# Env (all optional unless stated):
#   PROJECTOR_BIND           127.0.0.1 (default) | 0.0.0.0 | <address>
#   PROJECTOR_PUBLISH_KEY    the publisher's password (required off loopback)
#   PROJECTOR_PUBLISH_USER   publisher (default)
#   PROJECTOR_PATH           screen (default) — the stream path on every face
#   PROJECTOR_RTSP_PORT      8554   PROJECTOR_RTMP_PORT  1935
#   PROJECTOR_HLS_PORT       8888   PROJECTOR_WEBRTC_PORT 8889   PROJECTOR_WEBRTC_UDP_PORT 8189
set -eu
OUT="${1:?usage: mkconfig.sh <out.yml>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
BIND="${PROJECTOR_BIND:-127.0.0.1}"
USER_="${PROJECTOR_PUBLISH_USER:-publisher}"
KEY="${PROJECTOR_PUBLISH_KEY:-}"
STREAM_PATH="${PROJECTOR_PATH:-screen}"
case "$STREAM_PATH" in *[!A-Za-z0-9_-]*|"") echo "mkconfig: PROJECTOR_PATH must be [A-Za-z0-9_-]+ (got '$STREAM_PATH')" >&2; exit 2;; esac
if [ "$KEY" = "projector-dev" ]; then
  echo "mkconfig: refusing the historical dev key 'projector-dev' — it was committed once and is not a secret" >&2; exit 2
fi
if [ "$BIND" = "127.0.0.1" ] || [ "$BIND" = "localhost" ] || [ "$BIND" = "::1" ]; then
  BIND=127.0.0.1
  if [ -z "$KEY" ]; then
    KEY="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "mkconfig: loopback appliance; publish key for this run: $KEY" >&2
  fi
  IPS_FROM_IFACES=false
  WEBRTC_HOSTS='[127.0.0.1]'   # mediamtx wants one of the two filled; loopback names itself
else
  if [ "${#KEY}" -lt 16 ]; then
    echo "mkconfig: PROJECTOR_BIND=$BIND faces a network — set PROJECTOR_PUBLISH_KEY (16+ characters) explicitly" >&2; exit 2
  fi
  IPS_FROM_IFACES=true
  WEBRTC_HOSTS='[]'
  echo "mkconfig: NETWORK appliance on $BIND — publishing needs the key you set; readers need nothing" >&2
fi
# every substitution is explicit; an unset name would leave a literal ${…}
# in the config, so we check for that after rendering
sed \
  -e "s|\${BIND}|$BIND|g" \
  -e "s|\${PUBLISH_USER}|$USER_|g" \
  -e "s|\${PUBLISH_KEY}|$KEY|g" \
  -e "s|\${STREAM_PATH}|$STREAM_PATH|g" \
  -e "s|\${RTSP_PORT}|${PROJECTOR_RTSP_PORT:-8554}|g" \
  -e "s|\${RTMP_PORT}|${PROJECTOR_RTMP_PORT:-1935}|g" \
  -e "s|\${HLS_PORT}|${PROJECTOR_HLS_PORT:-8888}|g" \
  -e "s|\${WEBRTC_PORT}|${PROJECTOR_WEBRTC_PORT:-8889}|g" \
  -e "s|\${WEBRTC_UDP_PORT}|${PROJECTOR_WEBRTC_UDP_PORT:-8189}|g" \
  -e "s|\${WEBRTC_IPS_FROM_INTERFACES}|$IPS_FROM_IFACES|g" \
  -e "s|\${WEBRTC_HOSTS}|$WEBRTC_HOSTS|g" \
  "$DIR/mediamtx.template.yml" > "$OUT"
if grep -v '^[[:space:]]*#' "$OUT" | grep -q '\${'; then echo "mkconfig: unrendered placeholder in $OUT:" >&2; grep -vn '^[[:space:]]*#' "$OUT" | grep '\${' >&2; exit 2; fi
chmod 600 "$OUT"
echo "$KEY"
