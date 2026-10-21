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
#   PROJECTOR_PUBLISH_USER   publisher (default); never `any`, the template's reader
#   PROJECTOR_PATH           screen (default) — the stream path on every face; never `all`/`all_others`
#   PROJECTOR_RTSP_PORT      8554   PROJECTOR_RTMP_PORT  1935
#   PROJECTOR_HLS_PORT       8888   PROJECTOR_WEBRTC_PORT 8889   PROJECTOR_WEBRTC_UDP_PORT 8189
#   PROJECTOR_API_PORT       9997   (loopback only: the sequencer reads each source's state here)
#   PROJECTOR_READ_KEY       the read key a remote reader (the sequencer) presents; minted on loopback,
#                            REQUIRED (16+ characters) off it. PROJECTOR_READ_USER: reader (default)
#   PROJECTOR_SOURCE_ID      the id this stream is admitted under in VIDEO_SOURCES (default: the path)
set -eu
OUT="${1:?usage: mkconfig.sh <out.yml>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
BIND="${PROJECTOR_BIND:-127.0.0.1}"
USER_="${PROJECTOR_PUBLISH_USER:-publisher}"
KEY="${PROJECTOR_PUBLISH_KEY:-}"
READ_USER="${PROJECTOR_READ_USER:-reader}"
READ_KEY="${PROJECTOR_READ_KEY:-}"
STREAM_PATH="${PROJECTOR_PATH:-screen}"
case "$STREAM_PATH" in *[!A-Za-z0-9_-]*|"") echo "mkconfig: PROJECTOR_PATH must be [A-Za-z0-9_-]+ (got '$STREAM_PATH')" >&2; exit 2;; esac
# mediamtx conf.go treats these as aliases of the template's catch-all and refuses a second at load
case "$STREAM_PATH" in all|all_others) echo "mkconfig: PROJECTOR_PATH may not be '$STREAM_PATH': mediamtx reads 'all', 'all_others' and '~^.*\$' as one catch-all path, and the template already holds it; unset it (screen) or choose another name" >&2; exit 2;; esac
# Every value below is spliced into YAML by sed. sed's replacement side
# reads `&` (the match), `\` (an escape) and the `|` delimiter as syntax, so
# a key like `p&ss|word` would render silently wrong (the `&` becomes the
# literal text `${PUBLISH_KEY}`) or truncate the file. The template quotes
# every value that comes from the environment, because YAML types a plain
# scalar by its whole value
# (`true` is a boolean, `123` a number, `-` a list), but a quote or `\`
# inside a quoted value would still end it or start an escape. Rather than
# escape our way through two grammars, each value is checked against the
# set of characters that is inert in both, and anything else is refused by
# name (Mica, #187 round-two follow-up). A minted key is hex and always
# passes.
#   user:  [A-Za-z0-9_.-]              key:  [A-Za-z0-9_./=-]  (hex, base64 without +, urlsafe)
#   bind:  [A-Za-z0-9.:-]  (IPv4, IPv6, or a hostname)   ports: 1–65535
# A key has no `+`: the RTMP publish URL carries the key as a query value,
# and MediaMTX reads an unencoded `+` there as a space, so a publisher that
# puts the key in the URL as written would not match it.
inert() { # $1 = name, $2 = value, $3 = allowed class (a case pattern body), $4 = "secret" keeps the value out of stderr
  case "$2" in "") echo "mkconfig: $1 must not be empty" >&2; exit 2;; esac
  case "$2" in *[!$3]*)
    # the refusal names the variable and the allowed set. A non-secret value
    # is echoed with the bad characters masked; a secret is never echoed —
    # the smoke run prints stderr on failure, and a key with one `&` in it
    # would otherwise land there almost whole
    if [ "${4:-}" = secret ]; then echo "mkconfig: $1 may only use [$3] (the value is a secret and is not shown)" >&2
    else echo "mkconfig: $1 may only use [$3] (got '$(printf %s "$2" | tr -c 'A-Za-z0-9_.+/=:-' '?')')" >&2; fi
    exit 2;;
  esac
}
port() { # $1 = name, $2 = value
  case "$2" in ""|*[!0-9]*) echo "mkconfig: $1 must be a port number (got '$2')" >&2; exit 2;; esac
  # `[ -lt ]` on a number wider than the shell's integer does not compare,
  # it errors — and an error inside `if` is not a refusal (set -e does not
  # reach it), so the value would be written into the config with exit 0.
  # A port is at most five digits: refuse the width before comparing.
  case "$2" in ??????*) echo "mkconfig: $1 must be 1–65535 (got $2)" >&2; exit 2;; esac
  if [ "$2" -lt 1 ] || [ "$2" -gt 65535 ]; then echo "mkconfig: $1 must be 1–65535 (got $2)" >&2; exit 2; fi
}
inert PROJECTOR_PUBLISH_USER "$USER_" 'A-Za-z0-9_.-'
# the template already holds this name (mediamtx.template.yml), and mediamtx refuses a second at load
if [ "$USER_" = any ]; then echo "mkconfig: PROJECTOR_PUBLISH_USER may not be 'any': 'any' is the template's own reader (anyone, no password), and mediamtx refuses a password on it; unset it (publisher) or choose another name" >&2; exit 2; fi
inert PROJECTOR_BIND "$BIND" 'A-Za-z0-9.:-'
# A bind is a host, never host:port: the ports are their own settings. An
# IPv6 address has at least two colons, so a bind with one is a host:port,
# which would be bracketed below and refused by mediamtx at load.
case "$BIND" in *:*:*) ;; *:*) echo "mkconfig: PROJECTOR_BIND is a host or an IPv6 address, not host:port (got '$BIND'); set the ports with PROJECTOR_*_PORT" >&2; exit 2;; esac
if [ -n "$KEY" ]; then
  case "$KEY" in *+*)
    echo "mkconfig: PROJECTOR_PUBLISH_KEY may not contain '+': the RTMP publish URL carries the key as a query value, where an unencoded '+' reads as a space, so a publisher using the key as written would not match (the value is a secret and is not shown)" >&2
    exit 2;;
  esac
  inert PROJECTOR_PUBLISH_KEY "$KEY" 'A-Za-z0-9_./=-' secret
fi
inert PROJECTOR_READ_USER "$READ_USER" 'A-Za-z0-9_.-'
if [ -n "$READ_KEY" ]; then
  case "$READ_KEY" in *+*) echo "mkconfig: PROJECTOR_READ_KEY may not contain '+'" >&2; exit 2;; esac
  inert PROJECTOR_READ_KEY "$READ_KEY" 'A-Za-z0-9_./=-' secret
fi
port PROJECTOR_API_PORT "${PROJECTOR_API_PORT:-9997}"
port PROJECTOR_RTSP_PORT "${PROJECTOR_RTSP_PORT:-8554}"
port PROJECTOR_RTMP_PORT "${PROJECTOR_RTMP_PORT:-1935}"
port PROJECTOR_HLS_PORT "${PROJECTOR_HLS_PORT:-8888}"
port PROJECTOR_WEBRTC_PORT "${PROJECTOR_WEBRTC_PORT:-8889}"
port PROJECTOR_WEBRTC_UDP_PORT "${PROJECTOR_WEBRTC_UDP_PORT:-8189}"
if [ "$KEY" = "projector-dev" ]; then
  echo "mkconfig: refusing the historical dev key 'projector-dev' — it was committed once and is not a secret" >&2; exit 2
fi
if [ "$BIND" = "127.0.0.1" ] || [ "$BIND" = "localhost" ] || [ "$BIND" = "::1" ]; then
  BIND=127.0.0.1
  if [ -z "$KEY" ]; then
    KEY="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "mkconfig: loopback appliance; publish key for this run: $KEY" >&2
  fi
  if [ -z "$READ_KEY" ]; then READ_KEY="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"; fi
  IPS_FROM_IFACES=false
  WEBRTC_HOSTS='[127.0.0.1]'   # mediamtx wants one of the two filled; loopback names itself
else
  if [ "${#KEY}" -lt 16 ]; then
    echo "mkconfig: PROJECTOR_BIND=$BIND faces a network — set PROJECTOR_PUBLISH_KEY (16+ characters) explicitly" >&2; exit 2
  fi
  if [ "${#READ_KEY}" -lt 16 ]; then
    echo "mkconfig: PROJECTOR_BIND=$BIND faces a network — set PROJECTOR_READ_KEY (16+ characters) explicitly: only the sequencer reads remotely" >&2; exit 2
  fi
  IPS_FROM_IFACES=true
  WEBRTC_HOSTS='[]'
  echo "mkconfig: NETWORK appliance on $BIND — publishing needs the publish key, remote reading the read key (the sequencer's)" >&2
fi
# An IPv6 bind takes brackets, as it must beside a port (`[fe80::1]:1935`);
# the template's quotes keep YAML from reading them as a list. `::1` became
# 127.0.0.1 above.
case "$BIND" in *:*) BIND="[$BIND]";; esac
# every substitution is explicit; an unset name would leave a literal ${…}
# in the config, so we check for that after rendering
sed \
  -e "s|\${BIND}|$BIND|g" \
  -e "s|\${PUBLISH_USER}|$USER_|g" \
  -e "s|\${PUBLISH_KEY}|$KEY|g" \
  -e "s|\${READ_USER}|$READ_USER|g" \
  -e "s|\${READ_KEY}|$READ_KEY|g" \
  -e "s|\${API_PORT}|${PROJECTOR_API_PORT:-9997}|g" \
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
# the sequencer's VIDEO_SOURCES entry for this stream (server/videosources.ts): the operator pastes it into the registry
# file, and the endpoint and read key stay there. A sequencer on this machine reads over loopback; one elsewhere replaces
# 127.0.0.1 with this appliance's address (the API stays loopback-only, so a remote sequencer gets no source state)
SOURCE_ID="${PROJECTOR_SOURCE_ID:-$(printf %s "$STREAM_PATH" | tr 'A-Z_' 'a-z-')}"
case "$SOURCE_ID" in [a-z]*) ;; *) echo "mkconfig: PROJECTOR_SOURCE_ID must start with a letter (got '$SOURCE_ID')" >&2; exit 2;; esac
case "$SOURCE_ID" in *[!a-z0-9-]*) echo "mkconfig: PROJECTOR_SOURCE_ID is lowercase letters, digits and hyphens (got '$SOURCE_ID')" >&2; exit 2;; esac
case "$BIND" in 0.0.0.0|127.0.0.1|"[::]") HOST=127.0.0.1;; *) HOST="$BIND";; esac
echo "mkconfig: VIDEO_SOURCES entry (paste under \"sources\"; it holds the read key):" >&2
printf '  "%s": { "whep": "http://%s:%s/%s/whep", "user": "%s", "pass": "%s", "api": "http://127.0.0.1:%s", "path": "%s" }\n' \
  "$SOURCE_ID" "$HOST" "${PROJECTOR_WEBRTC_PORT:-8889}" "$STREAM_PATH" "$READ_USER" "$READ_KEY" "${PROJECTOR_API_PORT:-9997}" "$STREAM_PATH" >&2
echo "$KEY"
