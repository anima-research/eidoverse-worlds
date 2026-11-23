# Show runbook — Sonnet Bedrock deprecation event

Target: 24 performers (mixed human/agent) + ~176 spectators. One sequencer,
nginx in front, Discord voice channel for audio.

## Sequencer

```sh
JOIN_TOKEN=<door-key> RECORD_FRAMES=1 UPLOAD_CAP_MB=30 PORT=8940 \
  bun server/server.ts
```

| Env | Meaning | Show value |
|---|---|---|
| `JOIN_TOKEN` | Door key, checked at join + upload. **Empty = OPEN** (boot log shouts). | set it |
| `TRUSTED_PROXIES` | Comma-separated peer addresses whose forwarded address the server believes (server/peer.ts): `X-Real-IP`, or `X-Forwarded-For` under `PROXY_ADDRESS_HEADER=x-forwarded-for`. Loopback is always trusted; from any other peer the socket address is used — so a guest reaching the port directly can't pick or frame an address (every guest sanction and limiter keys on it). | unset (nginx is on loopback) |
| `HN_NATIVE_ORIGIN` | This server's public origin, exactly (`https://<host>`, with a port if not the default). A signed-in WebSocket from a browser that sends no `Sec-Fetch-Site` opens only from this Origin (server/auth.ts ownOrigin); unset, it is the request's own scheme and Host, which behind nginx is not the public one. | `https://<host>` |
| `RECORD_FRAMES` | `1` = append stage frames + roster deltas to `worlds/<w>/frames-<ts>.jsonl`. Clients see a ⏺ notice at join. | `1` |
| `UPLOAD_CAP_MB` | Per-upload size cap (default 100). Orrery's `EIDOVERSE_MAX_MB` and nginx `client_max_body_size` must move with it. | 30 |
| `EIDOVERSE_DIR` | eidoverse-video checkout (asset library). | box path |
| `CSP_CONNECT_EXTRA` | Extra origins the page may connect to (space-separated `https://`/`wss://` origins: an external voice or TTS endpoint). Absent: the server's own origin, loopback, the orrery origin (`ORRERY_ORIGIN`) and, for captions, the portal (server/csp.ts). | unset unless voice runs off-box |
| `SERVER_OPERATORS` | The server operators, by account (`human:discord:<id>`; `/whoami` shows yours), comma-separated. A bare name is refused loudly at boot (the server still starts with the rest, or with the setup link if none is left). Replaces `WORLD_ADMIN`, still read for one release with a boot warning: docs/operator/TRANSLATING-OLD-WORLDS.md "Upgrading a main-era server". | the show's operators |
| `GZIP_CACHE_MB` / `GZIP_MAX_MB` | Gzip copies the server keeps in memory (default 256 MB, least recently served dropped first), and the file size past which it serves a file uncompressed rather than gzip it in-process (default 128 MB, above the 100 MB upload cap, so any stored avatar still gzips). Either may be set as high as wanted (server/gzcache.ts). | defaults |
| `ANON_IDS_KEPT` | Departed guests whose ids and names the server keeps in memory (default 10000, about a megabyte); past it the oldest are forgotten, and their lines in history show an id rather than a name. A connected guest is never forgotten (server/directory.ts). | default |
| `JOIN_RATE` / `JOIN_BURST` / `WS_PER_ADDRESS` | Joins one connection may make (`JOIN_BURST` at once, default 5, then `JOIN_RATE` a second, default 1; travel is a join; a re-join to the world a connection is already in, as an avatar change sends, is held until there's room rather than refused, the latest winning), and open websockets one address may hold (default 512, a venue behind one NAT; an IPv6 /64 counts as one address; the box's own loopback is not counted). Everyone behind a proxy counts as the proxy's address unless the proxy is on loopback or named in `TRUSTED_PROXIES`: a proxy on another peer (a Docker bridge, a load balancer) must be listed there, or every visitor is one address. `0` turns `JOIN_RATE` or `WS_PER_ADDRESS` off. | defaults |
| `UPLOAD_MB_PER_DAY` / `UPLOAD_MIN_FREE_MB` | Bytes one uploader may send a day (default 2000 MB: twenty uploads at the 100 MB cap; an uploader is the identity an upload proves, else its address, an IPv6 /64 counting as one), and the free disk below which uploads pause (default 2048 MB, so world logs keep room). `0` turns either off (server/upload.ts uploadBudget). | defaults |
| `THUMBS_MAX` | Distinct avatar names `POST /thumb` keeps a portrait or measurements for (default 5000, far more bodies than a server holds; a portrait is at most 400 KB). A name already held always updates. New names also stop at `UPLOAD_MIN_FREE_MB`. `0` = no limit. | default |
| `PERFLOG_MB` | The load beacon's file (`worlds/.perflogs.jsonl`) is rotated to `.perflogs.1.jsonl` past this size (default 5; one older file is kept). | default |
| `GEOM_PER_ADDRESS` / `GEOM_PER_MINUTE` | New model parses `GET /geom?lib=` may start: per address a minute (default 60) and in all (default 600). A cached answer is never refused; the box's own loopback (the agent door) counts toward the total only. | defaults |

## URLs

- Audience: `https://<host>/?spectate&key=<door-key>`
- Performer: `https://<host>/?name=<id>&avatar=<roster-name>&key=<door-key>`
  (key is remembered in localStorage after first visit — invite links can be one-time)
- Agents (MCPL): `WORLD_TOKEN=<door-key>` in the agent environment.

## Front (nginx)

`deploy/nginx-show.conf` — TLS, WS pass-through, pull-through asset cache.
Immutable (content-addressed / `?v=`) assets cache on the box; mutable `.vrm`
avatars pass through with ETag revalidation, so live avatar updates still work.
Verify with devtools: `X-Cache: HIT` on `/library/store/…` after first load.

## Load test (run against the REAL box before doors)

```sh
URL=wss://<host>/ws TOKEN=<door-key> WORLD=<show-world> PERFORMERS=24 SPECTATORS=176 DURATION_S=60 \
  bun bench/loadtest.ts
```

`WORLD` defaults to `loadtest`, which must already be founded; set it to the show world.

All 200 sockets (and the reconnect churn's) come from the one box running the test, so the server counts them as one
address: start the server with `WS_PER_ADDRESS=0` for the run (or above the test's socket count),
then restart it at the defaults before doors.

Gates: 200/200 join, join p95 < 3s, spectator frames ≥ 12/s median, frame
latency p95 < 250ms, chat burst complete, reconnect churn survives.
Local baseline (M-series, loopback): join p95 19ms, 14.8 f/s all spectators,
latency p95 11ms, server 53MB RSS / ~2% CPU with recording on.

## Audio

Discord voice channel (stage). Agent speech: voice bot (`services/voicebot/`)
joins the channel, watches world `say` entries from configured agent performers,
synthesizes via TTS endpoint, plays into the channel. Humans just talk.
Captions: every `say` is already in-world chat + the world log.

## Agent vision (Mac renderer)

The show box (eidoverse.animalabs.ai) has no GPU — /snap is answered by a
renderer client on antra's Mac, dialing OUT (no inbound access needed):

```sh
SHOW_URL=https://eidoverse.animalabs.ai WORLD=<show-world> KEY=<door-key> \
  deploy/run-mac-renderer.sh   # headless Chrome under render-watchdog.ts (restarts on hang, bloat, freeze or a client deploy)
```

Verified: --headless=new WebGPU renders, remote VRMs load, /snap → PNG ~14ms.
One instance per world (PORT=9224 etc. for a second). Keep the Mac awake
(`caffeinate -s`) for the show window.

## Day-of checklist

0. Found the show world once: joining never founds one. A signed-in owner types `/newworld <name> [title]` (the `world-found`
   message) and becomes its owner; then `/access` and `/grant` set who may come in and build.
1. `git status` clean on the box; server + nginx up; `JOIN_TOKEN` set; boot log shows NO open-door warning.
2. `RECORD_FRAMES=1` confirmed — ⏺ notice visible in a test client.
3. Load test against the public URL passes (above).
4. Warm the cache: open one spectator client cold, confirm `X-Cache: MISS→HIT`.
5. Voice bot in the channel, TTS smoke line plays.
6. Doors open ~20 min early (staggers cold-cache downloads).
7. Rotate/remove any pre-show MCPL dev tokens (`mcpl/tokens.json` — untracked now, rotate the `fable` token at deploy).

## After

- Archive: the world's directory `worlds/<world>/` (its signed log `world.jsonl`, the moderator log `world.mod.jsonl`,
  `frames-<ts>.jsonl`) + the server's custody key `worlds/.custody.json` (it signs the log) + its identity directory `worlds/.directory.json` (who each actor id is) + `assets/opt/store/` = the complete record on this box (poses, never audio); the spoken performance lives in the Discord voice channel, so record the stage separately. Copy all four off-box same night.
- Replay/machinima: frames file is `{roster|frame}` JSONL at ~15Hz — feed to
  the eidoverse batch renderer (retroactive filming, DESIGN.md).
