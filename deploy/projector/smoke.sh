#!/bin/sh
# Projector appliance smoke: no OBS, no world. Renders a config for THIS run
# (random free ports, a stream path with a nonce, a key minted by mkconfig),
# starts mediamtx from scratch space, publishes a synthetic test pattern +
# tone over RTMP for ~20 s, and checks each face the design relies on:
#   1. HLS playlist serves and grows (the movie-night path);
#   2. RTSP exposes an audio stream (the caption bot's tap);
#   3. the caption bot's exact ffmpeg pull yields PCM at the expected rate
#      (16 kHz mono s16le → 32 000 bytes per second).
#
# OWNED, or it is not a smoke (Mica, #187 review B5): every port the faces
# answer on is proven to be LISTENED ON BY THE CHILD WE SPAWNED (lsof / ss by
# pid), the child is checked alive before every face and at the end, the
# stream path carries a nonce no stale listener could be serving, and the
# exact pids are torn down with the scratch directory. A mediamtx someone
# left running cannot make this pass.
# Exit 0 = every face answered. Exit 2 = a prerequisite is missing.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
fail=0; ok() { echo "  ok   $1"; }; bad() { echo "  FAIL $1"; fail=1; }
command -v mediamtx >/dev/null || { echo "mediamtx not installed (brew install mediamtx)"; exit 2; }
command -v ffmpeg  >/dev/null || { echo "ffmpeg not installed (brew install ffmpeg)"; exit 2; }
command -v python3 >/dev/null || { echo "python3 needed to pick free ports"; exit 2; }
if command -v lsof >/dev/null; then
  owns() { lsof -nP -a -p "$MTX" -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | grep -q .; }
elif command -v ss >/dev/null; then
  owns() { ss -ltnp 2>/dev/null | grep ":$1 " | grep -q "pid=$MTX,"; }
else
  echo "neither lsof nor ss: cannot prove port ownership, so this smoke cannot pass"; exit 2
fi

# ---- this run's identity: ports nobody holds, a path nobody serves ----
set -- $(python3 -c 'import socket
ss=[socket.socket() for _ in range(5)]
for s in ss: s.bind(("127.0.0.1",0))
print(*[s.getsockname()[1] for s in ss])
for s in ss: s.close()')
RTSP=$1; RTMP=$2; HLS=$3; WEBRTC=$4; WUDP=$5
NONCE="$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
STREAM="screen-$NONCE"
WORK="$(mktemp -d /tmp/projector-XXXXXX)"
KEY="$(PROJECTOR_PATH=$STREAM PROJECTOR_RTSP_PORT=$RTSP PROJECTOR_RTMP_PORT=$RTMP PROJECTOR_HLS_PORT=$HLS \
       PROJECTOR_WEBRTC_PORT=$WEBRTC PROJECTOR_WEBRTC_UDP_PORT=$WUDP sh "$DIR/mkconfig.sh" "$WORK/mediamtx.yml" 2>"$WORK/mkconfig.log")" \
  || { cat "$WORK/mkconfig.log"; rm -rf "$WORK"; exit 2; }
echo "run: path /$STREAM · rtsp :$RTSP · rtmp :$RTMP · hls :$HLS · webrtc :$WEBRTC · scratch $WORK"

# mediamtx writes its auto-generated DTLS certificate (auto.crt/auto.key)
# into its working directory: run it from scratch space, never the repo.
(cd "$WORK" && exec mediamtx "$WORK/mediamtx.yml") >"$WORK/mediamtx.log" 2>&1 &
MTX=$!
PUB=""
teardown() {
  [ -n "$PUB" ] && kill "$PUB" 2>/dev/null
  kill "$MTX" 2>/dev/null
  wait "$MTX" 2>/dev/null; [ -n "$PUB" ] && wait "$PUB" 2>/dev/null
  if [ $fail -ne 0 ]; then echo "logs kept: $WORK/mediamtx.log $WORK/publish.log"; else rm -rf "$WORK"; fi
}
trap teardown EXIT INT TERM
alive() { kill -0 "$MTX" 2>/dev/null; }

echo "— 0. the child owns its ports —"
i=0
while [ $i -lt 40 ]; do
  alive || break
  owns "$RTSP" && owns "$RTMP" && owns "$HLS" && break
  i=$((i+1)); sleep 0.25
done
if ! alive; then bad "mediamtx (pid $MTX) exited before listening: $(tail -3 "$WORK/mediamtx.log" | tr '\n' ' ')"; exit 1; fi
if owns "$RTSP" && owns "$RTMP" && owns "$HLS"; then ok "pid $MTX listens on :$RTSP :$RTMP :$HLS (proven by pid, not by port)"; else bad "pid $MTX does not own its ports after 10 s"; exit 1; fi

# A test pattern with a 440 Hz tone that pulses (1 s on / 1 s off) — a
# rhythm the VAD can see, so the same publisher rehearses the caption bot.
ffmpeg -hide_banner -loglevel error -re \
  -f lavfi -i "testsrc2=size=640x360:rate=25" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000,volume='if(lt(mod(t,2),1),1,0)':eval=frame" \
  -t 22 -c:v libx264 -preset ultrafast -tune zerolatency -g 25 -pix_fmt yuv420p \
  -c:a aac -b:a 96k -f flv "rtmp://127.0.0.1:$RTMP/$STREAM?user=publisher&pass=$KEY" 2>"$WORK/publish.log" &
PUB=$!

echo "— 1. HLS —"
alive || { bad "mediamtx died before HLS"; exit 1; }
# The muxer is created on the first packets; mediamtx answers index.m3u8 with
# a redirect into a per-viewer session (?session=…), so follow redirects, and
# poll rather than guess the ramp to the first segment.
PL=000; i=0
while [ $i -lt 30 ]; do
  PL="$(curl -sL -o "$WORK/pl.m3u8" -w '%{http_code}' "http://127.0.0.1:$HLS/$STREAM/index.m3u8")"
  [ "$PL" = "200" ] && grep -q "EXT-X-STREAM-INF" "$WORK/pl.m3u8" && break
  i=$((i+1)); sleep 0.5
done
[ "$PL" = "200" ] && ok "playlist served (200) after $((i/2))s on /$STREAM" || bad "playlist HTTP $PL after 15 s (publish log: $(tail -2 "$WORK/publish.log" | tr '\n' ' '))"
if grep -q "EXT-X-STREAM-INF" "$WORK/pl.m3u8" 2>/dev/null; then
  VAR="$(grep -v '^#' "$WORK/pl.m3u8" | grep -v '^[[:space:]]*$' | head -1)"
  curl -sL "http://127.0.0.1:$HLS/$STREAM/$VAR" -o "$WORK/var.m3u8"
  N1="$(grep -c 'EXTINF\|EXT-X-PART' "$WORK/var.m3u8")"; sleep 3
  curl -sL "http://127.0.0.1:$HLS/$STREAM/$VAR" -o "$WORK/var.m3u8"
  N2="$(grep -c 'EXTINF\|EXT-X-PART' "$WORK/var.m3u8")"
  [ "$N2" -gt 0 ] && ok "variant playlist carries segments ($N1 → $N2)" || bad "no segments in the variant playlist"
else
  bad "playlist is not a multivariant playlist: $(head -3 "$WORK/pl.m3u8" 2>/dev/null | tr '\n' ' ')"
fi
NOPE="$(curl -sL -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HLS/screen/index.m3u8")"
[ "$NOPE" != "200" ] && ok "the un-nonced path /screen is NOT served here ($NOPE): a stale listener could not have answered" || bad "/screen answered 200 — is another mediamtx serving this port?"

echo "— 2. RTSP audio (the caption bot's tap) —"
alive || { bad "mediamtx died before RTSP"; exit 1; }
A="$(ffprobe -v error -rtsp_transport tcp -select_streams a:0 -show_entries stream=codec_name,sample_rate -of csv=p=0 "rtsp://127.0.0.1:$RTSP/$STREAM" 2>/dev/null | head -1)"
[ -n "$A" ] && ok "audio stream present: $A" || bad "no audio stream on rtsp://127.0.0.1:$RTSP/$STREAM"

echo "— 3. the bot's PCM pull —"
alive || { bad "mediamtx died before the PCM pull"; exit 1; }
BYTES="$(ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i "rtsp://127.0.0.1:$RTSP/$STREAM" -t 2 -vn -ac 1 -ar 16000 -f s16le - 2>/dev/null | wc -c | tr -d ' ')"
# 2 s × 16000 × 2 bytes = 64000; allow the container's ramp.
[ "${BYTES:-0}" -ge 48000 ] && [ "${BYTES:-0}" -le 80000 ] && ok "2 s of 16 kHz mono PCM ≈ $BYTES bytes" || bad "PCM pull yielded $BYTES bytes (expected ≈ 64000)"

echo "— 4. still ours at the end —"
if alive && owns "$HLS" && owns "$RTSP"; then ok "pid $MTX alive and still the listener on :$HLS :$RTSP"; else bad "the child is gone or lost its ports — the faces above may have been answered by something else"; fi

[ $fail -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit $fail
