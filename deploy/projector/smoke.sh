#!/bin/sh
# Projector appliance smoke: no OBS, no world. Starts mediamtx on this
# config, publishes a synthetic test pattern + tone over RTMP for ~20 s, and
# checks each face the design relies on:
#   1. HLS playlist serves and grows (the movie-night path);
#   2. RTSP exposes an audio stream (the caption bot's tap);
#   3. the caption bot's exact ffmpeg pull yields PCM at the expected rate
#      (16 kHz mono s16le → 32 000 bytes per second).
# Exit 0 = every face answered. Ports: 8554 8888 8889 1935 must be free.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
KEY="${PROJECTOR_PUBLISH_KEY:-projector-dev}"
fail=0; ok() { echo "  ok   $1"; }; bad() { echo "  FAIL $1"; fail=1; }
command -v mediamtx >/dev/null || { echo "mediamtx not installed (brew install mediamtx)"; exit 2; }
command -v ffmpeg  >/dev/null || { echo "ffmpeg not installed (brew install ffmpeg)"; exit 2; }
# mediamtx writes its auto-generated DTLS certificate (auto.crt/auto.key)
# into its working directory: run it from scratch space, never the repo.
WORK="$(mktemp -d /tmp/projector-XXXXXX)"
(cd "$WORK" && exec mediamtx "$DIR/mediamtx.yml") >/tmp/projector-mediamtx.log 2>&1 &
MTX=$!
trap 'kill $PUB 2>/dev/null; kill $MTX 2>/dev/null; wait 2>/dev/null; rm -rf "$WORK"' EXIT INT TERM
sleep 1.5
# A test pattern with a 440 Hz tone that pulses (1 s on / 1 s off) — a
# rhythm the VAD can see, so the same publisher rehearses the caption bot.
ffmpeg -hide_banner -loglevel error -re \
  -f lavfi -i "testsrc2=size=640x360:rate=25" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000,volume='if(lt(mod(t,2),1),1,0)':eval=frame" \
  -t 22 -c:v libx264 -preset ultrafast -tune zerolatency -g 25 -pix_fmt yuv420p \
  -c:a aac -b:a 96k -f flv "rtmp://127.0.0.1:1935/screen?user=publisher&pass=${KEY}" 2>/tmp/projector-publish.log &
PUB=$!
echo "— 1. HLS —"
# The muxer is created on the first packets; mediamtx answers index.m3u8 with
# a redirect into a per-viewer session (?session=…), so follow redirects, and
# poll rather than guess the ramp to the first segment.
PL=000; i=0
while [ $i -lt 30 ]; do
  PL="$(curl -sL -o /tmp/projector-pl.m3u8 -w '%{http_code}' http://127.0.0.1:8888/screen/index.m3u8)"
  [ "$PL" = "200" ] && grep -q "EXT-X-STREAM-INF" /tmp/projector-pl.m3u8 && break
  i=$((i+1)); sleep 0.5
done
[ "$PL" = "200" ] && ok "playlist served (200) after $((i/2))s" || bad "playlist HTTP $PL after 15 s"
if grep -q "EXT-X-STREAM-INF" /tmp/projector-pl.m3u8 2>/dev/null; then
  VAR="$(grep -v '^#' /tmp/projector-pl.m3u8 | grep -v '^[[:space:]]*$' | head -1)"
  curl -sL "http://127.0.0.1:8888/screen/$VAR" -o /tmp/projector-var.m3u8
  N1="$(grep -c 'EXTINF\|EXT-X-PART' /tmp/projector-var.m3u8)"; sleep 3
  curl -sL "http://127.0.0.1:8888/screen/$VAR" -o /tmp/projector-var.m3u8
  N2="$(grep -c 'EXTINF\|EXT-X-PART' /tmp/projector-var.m3u8)"
  [ "$N2" -gt 0 ] && ok "variant playlist carries segments ($N1 → $N2)" || bad "no segments in the variant playlist"
else
  bad "playlist is not a multivariant playlist: $(head -3 /tmp/projector-pl.m3u8 | tr '\n' ' ')"
fi
echo "— 2. RTSP audio (the caption bot's tap) —"
A="$(ffprobe -v error -rtsp_transport tcp -select_streams a:0 -show_entries stream=codec_name,sample_rate -of csv=p=0 rtsp://127.0.0.1:8554/screen 2>/dev/null | head -1)"
[ -n "$A" ] && ok "audio stream present: $A" || bad "no audio stream on rtsp://127.0.0.1:8554/screen"
echo "— 3. the bot's PCM pull —"
BYTES="$(ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i rtsp://127.0.0.1:8554/screen -t 2 -vn -ac 1 -ar 16000 -f s16le - 2>/dev/null | wc -c | tr -d ' ')"
# 2 s × 16000 × 2 bytes = 64000; allow the container's ramp.
[ "${BYTES:-0}" -ge 48000 ] && [ "${BYTES:-0}" -le 80000 ] && ok "2 s of 16 kHz mono PCM ≈ $BYTES bytes" || bad "PCM pull yielded $BYTES bytes (expected ≈ 64000)"
[ $fail -eq 0 ] && echo "ALL PASS" || echo "FAILURES (mediamtx log: /tmp/projector-mediamtx.log)"
exit $fail
