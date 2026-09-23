# The projector appliance

mediamtx, configured as the transport for the eidoverse screen — layer 2,
route A of `anima_dev/eidoverse_projector_design.md`. It is an appliance you
plug in for an event, not an organ of the world: the world server is
untouched, the client plays a URL, and the caption bot reads audio from it.

```
OBS ──WHIP/RTMP──▶ mediamtx ──HLS/WHEP──▶ the screen comp (client plays a URL)
                      └──RTSP (loopback)──▶ tools/captionbot ──caption──▶ the world
```

## Run

```
brew install mediamtx ffmpeg
deploy/projector/mkconfig.sh /tmp/projector/mediamtx.yml   # renders the config; prints this run's publish key
(cd /tmp/projector && mediamtx mediamtx.yml)
deploy/projector/smoke.sh                                    # no OBS needed: a test pattern exercises every face
```

There is no committed config and no committed password. `mkconfig.sh`
renders `mediamtx.template.yml` from the environment, fail-closed:

- **default: loopback.** Every face binds `127.0.0.1`; the publish key is
  minted for the run and printed once. A dev box cannot accidentally become
  a network appliance with a known password.
- **on a network:** `PROJECTOR_BIND=0.0.0.0` (or an address) *requires* an
  explicit `PROJECTOR_PUBLISH_KEY` of 16+ characters. The old dev key is
  refused by name. `PROJECTOR_PATH` names the stream (default `screen`);
  `PROJECTOR_{RTSP,RTMP,HLS,WEBRTC,WEBRTC_UDP}_PORT` move the faces.

The smoke owns everything it checks: it picks free ports for the run, uses a
stream path with a nonce, proves with `lsof`/`ss` that the mediamtx it
spawned is the process listening on those ports (before the first face and
again at the end), fails if the child exits, and tears down exactly its own
pids and scratch directory. A mediamtx someone left running cannot make it
pass. Then it publishes a synthetic pattern with a pulsing tone and checks the
HLS playlist serves and grows, RTSP exposes the audio, and the caption bot's
exact PCM pull yields 16 kHz mono at the expected byte rate.

mediamtx writes an auto-generated DTLS certificate (`auto.crt`, `auto.key`)
into whatever directory it runs from. Run it from scratch space, as the smoke
does, not from the repository.

## Faces

| face | URL | who |
|---|---|---|
| WHIP publish | `http://host:8889/screen/whip` | OBS ≥ 30 (Settings → Stream → Service: WHIP) |
| RTMP publish | `rtmp://host:1935/screen?user=publisher&pass=<key>` | OBS "Custom" (server + key as query), any encoder |
| HLS play | `http://host:8888/screen/index.m3u8` | the screen comp, movie nights (~3–6 s behind) |
| WHEP play | `http://host:8889/screen/whep` | the screen comp, phase 3 (sub-second + presentation delay) |
| RTSP read | `rtsp://127.0.0.1:8554/screen` | `tools/captionbot` — loopback only |

Publishing needs the key `mkconfig.sh` rendered (`publisher` / the key it
printed or the one you set; OBS takes it as the stream key or the WHIP bearer
token). Reading needs nothing: what a screen may point at is the world's
decision, made by the screen comp's source allow-list, not here.

## What is deliberately not here

- No video through the house SFU (route B). The client plays a URL either
  way, so that swap is a later choice, not a rewrite.
- No recording (`playback: false`). A movie night is not an archive.
- No TLS. Put it behind the same reverse proxy as the sequencer when it
  leaves the LAN; mediamtx also terminates TLS itself if preferred.

## The captioner

`tools/captionbot` reads the RTSP face and writes one `caption` verb per
final line (AGENTS.md, "Things can carry CAPTIONS"). It needs the caption
deed for its screen, granted once by the world's owner:

```
grant {id: "captioner", caption: "cinema"}
```

Captions are durable world testimony like `say`; `end` clears current
perception, not history.
