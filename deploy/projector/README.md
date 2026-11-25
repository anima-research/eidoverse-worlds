# The projector appliance

mediamtx, configured as the transport for the eidoverse screen — layer 2,
route A of `anima_dev/eidoverse_projector_design.md` (outside this repo). It is an appliance you
plug in for an event, not an organ of the world. A screen's stream reaches a
viewer through the sequencer, which holds the read key and brokers each WHEP
session (`server/videosources.ts`): the browser never learns the appliance's
address or key. The caption bot reads audio from it on loopback.

```
OBS ──WHIP/RTMP──▶ mediamtx ──WHEP (read key)──▶ the sequencer ──brokered offer──▶ the screen comp
                      └──RTSP (loopback)──▶ services/captionbot ──caption──▶ the world
```

## Run

```
brew install mediamtx ffmpeg
mkdir -p /tmp/projector
deploy/projector/mkconfig.sh /tmp/projector/mediamtx.yml   # renders the config; prints the publish key, and the VIDEO_SOURCES entry
(cd /tmp/projector && mediamtx mediamtx.yml)
deploy/projector/smoke.sh                                    # no OBS needed: a test pattern exercises every face
```

There is no committed config and no committed password. `mkconfig.sh`
renders `mediamtx.template.yml` from the environment, fail-closed:

- **default: loopback.** Every face binds `127.0.0.1`; the publish key and
  the read key are minted for the run, and the publish key is printed. A dev
  box cannot accidentally become a network appliance with a known password.
- **on a network:** `PROJECTOR_BIND=0.0.0.0` (or an address) *requires* an
  explicit `PROJECTOR_PUBLISH_KEY` and an explicit `PROJECTOR_READ_KEY`, each
  of 16+ characters. The old dev key is refused by name. `PROJECTOR_PATH`
  names the stream (default `screen`);
  `PROJECTOR_{API,RTSP,RTMP,HLS,WEBRTC,WEBRTC_UDP}_PORT` move the faces.

`mkconfig.sh` also prints the stream's entry for the sequencer's
`VIDEO_SOURCES` file, under `PROJECTOR_SOURCE_ID` (default: the path,
lowercased). It holds the read key. The API that tells the sequencer whether a
source is live answers on this machine's loopback only, so only a loopback
appliance's entry names it; a network appliance's entry has none, and a
sequencer elsewhere replaces `127.0.0.1` in its `whep` with this appliance's
address.

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
| WHEP read | `http://host:8889/screen/whep` | the sequencer, with the read key (it brokers each viewer's session) |
| HLS read | `http://host:8888/screen/index.m3u8` | a reader with the read key; anonymous on this machine only |
| RTSP read | `rtsp://127.0.0.1:8554/screen` | `services/captionbot` — loopback only |
| API | `http://127.0.0.1:9997` | the sequencer on this machine (is a publisher there; are bytes arriving) — loopback only |

Publishing needs the key `mkconfig.sh` rendered (`publisher` / the key it
printed or the one you set; OBS takes it as the stream key or the WHIP bearer
token). Reading from another machine needs the read key (`reader` / the key
you set), which only the sequencer holds; reading from this machine needs
nothing, so the caption bot's tap keeps working. Which source a screen may
show is the world's decision (the operator admits it in `VIDEO_SOURCES`); a
viewer's browser never plays an appliance URL itself.

## What is deliberately not here

- No video through the house SFU (route B). A screen names an admitted
  source by id either way, so that swap is a later choice, not a rewrite.
- No recording (`playback: false`). A movie night is not an archive.
- No TLS. Put it behind the same reverse proxy as the sequencer when it
  leaves the LAN; mediamtx also terminates TLS itself if preferred.

## The captioner

`services/captionbot` reads the RTSP face and turns each final line of speech
into a caption for the screen: one door `caption` request per line
(`{id, session, n, t0, t1, text, speaker?, title?}`, or `{id, session, end}`),
which writes the screen's `captions` component by `shared/captions.js`'s rules.
Who may caption a screen is the screen's own `captioners {ids: [...]}`
component: anyone who may edit the screen sets it to the bot's identity (the
bot logs its identity when it joins), and anyone who may edit the screen can
caption it too. Nobody writes `captions` with a plain `set` (owners excepted),
so a builder can't forge the bot's lines. The server stamps the connection's
leg generation on every line, so a superseded bot can't write over its
successor. Run it with `AGENT_TOKEN` (its tokens.json entry) so it is the same
identity every time.
