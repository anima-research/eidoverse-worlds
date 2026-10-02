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
| `RECORD_FRAMES` | `1` = record bounded stage-frame segments. Clients see recording state at join and a notice if capture stops. See archive limits below. | `1` |
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
joins the channel, watches world `say` verbs from configured agent performers,
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
2. Confirm `RECORD_FRAMES=1` and available archive capacity at `GET /recordings`. A test client sees the ⏺ notice while capture is ready or active.
3. Load test against the public URL passes (above).
4. Warm the cache: open one spectator client cold, confirm `X-Cache: MISS→HIT`.
5. Voice bot in the channel, TTS smoke line plays.
6. Doors open ~20 min early (staggers cold-cache downloads).
7. Rotate/remove any pre-show MCPL dev tokens (`mcpl/tokens.json` — untracked now, rotate the `fable` token at deploy).

## Archive limits

Recording uses a preserve-and-stop retention policy. It keeps existing performances and stops new capture when a limit is reached. It never automatically deletes an archive segment. The stop stays latched until the sequencer restarts, even if space becomes available. Live frames and the authored world log continue.

| Env | Default | Meaning |
|---|---|---|
| `RECORD_SEGMENT_BYTES` | `67108864` (64 MiB) | Maximum raw bytes per segment, including roster lines. A batch larger than this stops capture. |
| `RECORD_SEGMENT_MS` | `3600000` (1 hour) | Maximum segment age. Idle segments close on the one-second maintenance tick. |
| `RECORD_MAX_BYTES` | `10737418240` (10 GiB) | Per-world archive budget: raw segments, index files, and leftover index temporaries. Reserves 8 KiB for index finalization before each write. |
| `RECORD_MAX_SEGMENTS` | `4096` | Per-world segment count, including legacy files. |
| `RECORD_MIN_FREE_BYTES` | `5368709120` (5 GiB) | Available filesystem space to preserve for the shared host. Checked before each batch and during maintenance. An unreadable disk-space measurement stops capture. |
| `RECORD_PERFORMANCE_ID` | Unique boot ID | Optional stable label, at most 80 characters, to group one performance across sequencer restarts. Set it before the show. |

Numeric limits are positive safe integers. Invalid values produce a warning and use the default. Legacy `frames-<timestamp>.jsonl` files count toward both archive limits at admission. A world already above either limit starts with recording stopped. The disk floor also applies when other worlds or services consume the same filesystem. It is an admission guard, not a reservation against concurrent writes by other processes.

`GET /recordings` reports each loaded world's state, stop reason, total archive bytes, bytes written this boot, trailing-minute byte rate, current segment bytes and age, and limits. Inventory is read at admission; counters then follow this sequencer's writes. Export or change local archives while the sequencer is stopped, then restart to refresh the inventory. `waiting` means a loaded world has not yet admitted a recording client; `disabled` means `RECORD_FRAMES` is off. The console and `world_debug` report segment transitions, a warning at 80% of the world byte budget, and stops. Joined browser/lite clients receive a stop notice; MCPL `look()` reports the last received capture state.

### Segment index and replay

Each boot creates a fresh stream: `frames-<boot>-<ordinal>.jsonl` and a matching `.index.json`. The index identifies the world, performance, boot, ordinal, first authored-log sequence, authored-log identity, and first frame sequence. It is created before frame writes and atomically finalized at close with the last complete frame sequence, frame count, raw byte count, and close reason. Every segment starts with the current performer roster; subsequent roster changes are deltas. Frames are pose deltas, so replay segments in order rather than treating a rotated segment as a standalone full pose snapshot.

Run `bun tools/frame-index.ts worlds/<world>` for a read-only inventory. Group by performance, then order by boot timestamp and segment ordinal. A supplied performance ID links boots but does not fill the outage between them. Frame sequence numbers restart at each boot. Use the frame timestamps and authored-log anchors to align the streams.

A segment’s `logId` is SHA-256 of the first complete line of its authored log, including the newline. New/reset genesis entries carry an opaque UUID epoch so rapid resets remain distinct. Existing logs are identified without changing their bytes. Recording stops if the opening line is unreadable, incomplete, or larger than 64 KiB. The ID moves with the log’s own rename; there is no separately renamed identity sidecar.

World reset closes the current segment before moving the authored log and binds the next segment to the new log ID. Quota usage and a stopped latch survive reset. The inventory reports `logState` (`resolved`, `missing`, `ambiguous`, or `unknown`) and matching `logPaths` across `log.jsonl` and `erased-*/log.jsonl`. It never guesses among duplicate or missing matches. Indices created before log IDs were introduced report `unknown`. Keep erased logs when exporting reset-spanning performances.

If reset is interrupted after the log moves but before its derived files move, startup preserves the leftover snapshots/poses and temporaries in `orphaned-derived-<uuid>/` before writing a new genesis. The same rule applies to an empty current log. These copies are explicitly unattributed; startup does not guess which erased epoch owns them. Retiring them on disk prevents a second unclean restart from restoring old derived state into the new epoch.

An index with `state: "open"` is unclosed: the sequencer may still be recording, or it may have crashed. Its final range and byte count are unknown. After stopping the sequencer, recover that segment by reading complete JSONL lines; retain and flag any incomplete final line. `state: "interrupted"` reports a known write or close failure. A failed close leaves the final frame range/count and close time unknown; recover the tail from complete lines. A missing/legacy index has `metadata: null` and no `metadataError`; damaged metadata has a per-file `metadataError`, while intact neighbors remain listed. Existing bytes are never rewritten during restart, and a new boot never appends to an old segment.

Segments stay raw JSONL for renderer compatibility and to keep compression CPU and temporary copy space off the sequencer. Compress exported copies on an archival host if desired. The bounded raw-storage policy is deliberate; compressed bytes are not a prerequisite for safe recording.

## After, or when recording stops

1. Stop the sequencer through the operator's normal shutdown procedure.
2. Copy the world's `log.jsonl`, its `erased-*` and `orphaned-derived-*` directories, all frame segments and indices, and `assets/opt/store/` off-box. Keep library assets used by the performance available too.
3. Verify the exported copies before removing local frame segments and their matching indices. Remove only copies you intentionally exported; the sequencer performs no deletion. After confirming complete, byte-identical off-box copies, you may delete local `orphaned-derived-*` directories to reclaim space; the sequencer never reads quarantined files.
4. Check the reported stop reason. Free shared filesystem space or adjust the archive limits if needed.
5. Restart the sequencer. Confirm `GET /recordings` reports `ready` or `recording` for the show world after a client joins.

A capacity stop preserves the captured portion of a performance; it cannot recover movement during the stopped interval. The authored world log remains independent.
