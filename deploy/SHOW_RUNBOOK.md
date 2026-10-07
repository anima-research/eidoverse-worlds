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
| `RECORD_FRAMES` | `1` = append stage frames + roster deltas to `worlds/<w>/frames-<ts>.jsonl`. Clients see a ⏺ notice at join. | `1` |
| `UPLOAD_CAP_MB` | Per-upload size cap (default 20). Orrery's `EIDOVERSE_MAX_MB` and nginx `client_max_body_size` must move with it. | 30 |
| `EIDOVERSE_DIR` | eidoverse-video checkout (asset library). | box path |

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
URL=wss://<host>/ws TOKEN=<door-key> PERFORMERS=24 SPECTATORS=176 DURATION_S=60 \
  bun tools/loadtest.ts
```

Gates: 200/200 join, join p95 < 3s, spectator frames ≥ 12/s median, frame
latency p95 < 250ms, chat burst complete, reconnect churn survives.
Local baseline (M-series, loopback): join p95 19ms, 14.8 f/s all spectators,
latency p95 11ms, server 53MB RSS / ~2% CPU with recording on.

## Audio

Discord voice channel (stage). Agent speech: voice bot (`tools/voicebot.ts`)
joins the channel, watches world `say` entries from configured agent performers,
synthesizes via TTS endpoint, plays into the channel. Humans just talk.
Captions: every `say` is already in-world chat + the world log.

## Agent vision (Mac renderer)

The show box (eidoverse.animalabs.ai) has no GPU — /snap is answered by a
renderer client on antra's Mac, dialing OUT (no inbound access needed):

```sh
SHOW_URL=https://eidoverse.animalabs.ai WORLD=<show-world> KEY=<door-key> \
  deploy/run-mac-renderer.sh   # headless Chrome + auto-relaunch loop
```

Verified: --headless=new WebGPU renders, remote VRMs load, /snap → PNG ~14ms.
One instance per world (PORT=9224 etc. for a second). Keep the Mac awake
(`caffeinate -s`) for the show window.

## Day-of checklist

1. `git status` clean on the box; server + nginx up; `JOIN_TOKEN` set; boot log shows NO open-door warning.
2. `RECORD_FRAMES=1` confirmed — ⏺ notice visible in a test client.
3. Load test against the public URL passes (above).
4. Warm the cache: open one spectator client cold, confirm `X-Cache: MISS→HIT`.
5. Voice bot in the channel, TTS smoke line plays.
6. Doors open ~20 min early (staggers cold-cache downloads).
7. Rotate/remove any pre-show MCPL dev tokens (`mcpl/tokens.json` — untracked now, rotate the `fable` token at deploy).

## After

- Archive: `worlds/<world>/log.jsonl` + `frames-<ts>.jsonl` + `assets/opt/store/`
  = the complete performance. Copy all three off-box same night.
- Replay/machinima: frames file is `{roster|frame}` JSONL at ~15Hz — feed to
  the eidoverse batch renderer (retroactive filming, DESIGN.md).
