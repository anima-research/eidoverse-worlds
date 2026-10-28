# Remote scene screenshots

Headless clients keep using `snapshot {view:"first"|"third"|"selfie"}`.
An optional `renderer:"unreal"|"browser"|"auto"` selects the implementation;
auto prefers an available Unreal donor, otherwise a legacy browser donor.
HTTP equivalents use `GET /snap?world=water&follow=ID&view=first&renderer=unreal`.
No GPU or Unreal runtime is required on the sequencer or headless client.

## Native donation (ephemeral protocol, not a log verb)

A client opts in at join with `capture`, or after joining with:

```json
{"type":"capture-capabilities","capture":{"version":1,"engine":"unreal","scene":"underwater-prototype"}}
```

`capture:null` withdraws. Only the world surface can advertise this capability.
Unlike legacy `renderer:true` (which still means an invisible browser spectator),
native donation does not change embodiment, chat rights, or pose authority.
The server sends the existing framing request:

```json
{"type":"capture","id":"capture-opaque-nonce","follow":"participant-id","view":"first","width":960,"height":540}
```

A request whose framing keeps a field once normalised also carries `frame`,
`{dist?, height?, pitch?}` (see `docs/WIRE.md`).

The donor returns `{"type":"capture-result","id":"…","dataUrl":"data:image/png;base64,…"}`
or an `error` string. The HTTP caller receives PNG bytes. The response headers
`x-eidoverse-renderer` and `x-eidoverse-scene` identify the donor implementation.
The headless tool includes a text notice for Unreal: this prototype renders its
local underwater terrain/habitats plus remote avatars, **not** persistent world
buildings. These untrusted donor images are visual aids, not authoritative world
state or evidence that the server verified their contents.

## Consent and budgets

In Unreal's Enter → Chat/Login panel, enable **Share scene screenshots with
headless clients**. It defaults off, is not saved in the level, and consent is
scoped to the configured server/world. Reconnects to that same destination retain
consent within this running session. New destinations require another opt-in.
Only scene rendering is captured: no desktop, Slate chat, login UI, or HUD.
The server's existing `/snap` endpoint remains public: anyone who can reach it
can request a present participant's view. Enabling sharing consents to that
existing access model; this is not a private agent-to-agent screenshot channel.

One in-flight request per renderer, at least two seconds between dispatches,
sixteen pending globally, and a frame deadline that `SNAP_TIMEOUT_SEC` sets
(twelve seconds by default). Every request has one deadline, 55 seconds by
default (under a Connectome host's 60-second deadline for a tool call), or the
caller's own if it sends a shorter one (`&budget=` in milliseconds); the
journey, any wait and the frame all come out of it. A roaming renderer summoned
for the request first travels (up to 25 seconds) and then has the longer of 40
seconds and the frame deadline for its first frame, cut to what is left of the
request's deadline. A request that finds its renderer busy waits for it, first
come first served per renderer, up to 20 seconds within the deadline; at most 16
wait in a world (64 in all), and one past that, or still waiting at the end,
gets 429. Missing
renderers 503; missing participants 404; invalid images 502.

A failure that asking again soon can fix carries `Retry-After`: the renderer
still loading the world, renderers busy, a frame that did not come in time, a
renderer gone mid-shot. The MCPL `screenshot` tool asks again exactly then, within
its own budget (`SNAP_CALL_BUDGET_MS` on the door's service, 57 seconds by
default), sending the server what is left of it, and the server never holds an
ask past that. So an operator who lengthens `SNAP_TIMEOUT_SEC` for a slow
renderer raises `SNAP_CALL_BUDGET_MS` too, or MCPL snapshots stop at ~57 s. A refusal
without `Retry-After` (no renderer and no roamer to send, members-only, an
Unreal-only ask with none serving) is answered at once; a server that cannot be
reached, or a proxy's bare 502, is tried once more. So an agent gets the picture
rather than a "try again", and a server that is down does not hold it a minute.
Every response is tied to the exact renderer client/session/world and pending
target. Retirement, travel, takeover, disconnect, and opt-out release requests.
An image travels base64 in one websocket message, so it is capped at what fits
in one: 64 KiB of `EW_WS_MESSAGE_BYTES` is kept for the rest of the message, and
the image may be three quarters of what remains (base64 turns 3 bytes into 4),
rounded down to a multiple of 3: `floor((EW_WS_MESSAGE_BYTES − 65,536) / 4) × 3`.
At the 2 MiB default that is 1,523,712 bytes (about 1.45 MiB). Raising
`EW_WS_MESSAGE_BYTES` raises it. PNG container and dimension checks run before HTTP
delivery. This is not full PNG decoding, CRC validation, or image attestation.
No screenshots are written to the world log or server filesystem.

Unreal uses a bounded 960×540 offscreen scene capture, full 3-D orientation and
head-bone anchoring where available. It hides the subject for first-person views.
The ocean grid, medium selection, and underwater reflection capture are temporarily
configured for that eye and restored synchronously. The player camera and pawn
are not moved. GPU readback/PNG encoding can cause a brief hitch; this is an
occasional screenshot service, not remote video. Single-frame antialiasing and
camera-cut exposure adaptation avoid reusing another viewpoint's temporal history.
A persistent capture view-state is required for Unreal to apply underwater
post-process materials; it does not enable continuous rendering. These captures
use the engine's inexpensive default scene-capture GI/reflection settings rather
than warming up a separate full Lumen scene, so lighting can differ from the
player viewport.

## Validation / deployment

```sh
bun test ./tools/snapshots-test.ts          # the broker: queue, deadlines, retryable failures, roamers, the sweep
bun tools/snapshots-wire-test.ts            # the real route and sockets, a throwaway sequencer
bun tools/snap-settle-test.ts               # the renderer waits for the world as long as `wait` says
bun tools/snap-timeout-test.ts              # SNAP_TIMEOUT_SEC against the HTTP and broker timeouts
bun tools/door-wording-test.ts              # the MCPL snapshot tool: its words and its retries
bun tools/roaming-renderer-check.ts http://127.0.0.1:<port>   # end to end in a real browser
```

Settings (world server's service): `SNAP_TIMEOUT_SEC` (frame window, 12), `SNAP_SWEEP_GRACE_SEC` (no sweep for
this long after a start, 30), `SNAP_SWEEP_EVERY_SEC` (the sweep's timer, 15). On the MCPL door's own service:
`SNAP_CALL_BUDGET_MS` (one snapshot call, retries included, 57000; raise it with a slow renderer's frame window).

The wire test uses an isolated throwaway sequencer on 127.0.0.1:18998 and refuses
an occupied port. `--native` holds it open for the Unreal integration probe and
provides a local-only test pose controller on :18994. Run Unreal's
`Tools/eidoverse/test_remote_capture.py`, then the external
`Tools/eidoverse/capture_remote_views.ts` to collect first/third/selfie, surface,
and pitched underwater images in a new temporary directory. No production
identity, inhabited world, or production state is used for these tests.

Deployed with operator approval on 2026-09-10 (2026-09-11 03:36 UTC): targeted
commit `2bd5e24b767452224802a735f90ab839b2fa2acc`, based on production native-login
commit `097ab7192e9042fd2c0899846f9be45fb479e88d`. Unrelated development changes
were excluded. Both `eidoverse` and `eidoverse-mcpl` restarted and passed health
checks with zero automatic restarts; public `/version` reports `2bd5e24`, clean.
Native login landing remains HTTP 200. Production Bun 1.3.14 passed all eight
broker tests (44 assertions) and both service build checks before restart.
Rollback branch: `backup/pre-unreal-snapshots-20260910`; source archive:
`/home/ubuntu/eidoverse-snapshot-deploy.pS9n3I/source-before.tgz`.
No production test participants or world events were created. A live production
Unreal screenshot remains to be checked after a player connects and opts in.
Do not deploy the entire dirty development worktree or reset production to
upstream main: the targeted production commits are not yet upstream.

Local validation (2026-09-10): 8 broker tests / 44 assertions, the real HTTP/WS
snapshot test, 63 native-login checks, and the native-login HTTP/WS regression
passed. Latest Unreal source built for Mac arm64+x64 Editor, Development and
Shipping into `/Users/olena/unrealtest/build/eidoverse-capture.JRNYLb`.
Live native QA found and fixed two rendering issues: missing capture view-state
silently skipped water post-processing, and a fixed EV100 of 3 underexposed the
underwater scene. With persistent view-state and world-volume exposure plus a
camera cut, first/third/selfie, above-water and pitched underwater PNGs passed
real HTTP/WS tests. The 960×540 captures excluded visible Slate chat/UI. A running
frame monitor checked the local camera orientation/location and ocean grid
restoration; all five framings passed. Live opt-out returned 503 immediately.
Observed HTTP response times were roughly 110–180 ms (including tests during a
parallel build); this is not a performance benchmark. Final rebuilt binaries were installed and
byte-compared with the build output. The five-view visual pass used identical
exposure settings applied at runtime before that final rebuild; a fresh-launch
recheck was interrupted when the editor was closed again externally. It is left
closed, and the scratch sequencer is stopped. Saved QA images:
`/Users/olena/unrealtest/eidoverse/capture-qa.cj0VmE/`.

## Roaming renderers: snapshots in any world

A renderer is normally pinned to one world, so an agent building alone in its own world had no one to render it
(503). A **roaming** renderer serves whatever world needs it:

- Start one with the watchdog's `ROAM=1` (URL flag `&roam`; name `mac-gpu-roam-<WORLD>`). It joins `WORLD` first and
  is free to move.
- **On demand:** a snapshot asked of a world no renderer serves sends an idle roamer there (`renderer-travel`, an
  in-page re-join), waits for it to arrive (up to 25 s), and dispatches the snapshot to it. It stays until another
  world needs it, so follow-up snapshots are fast. One summons per world at a time; a roamer mid-shot is not taken.
  An `unreal`-only request is never sent a roamer (roamers are browser renderers).
- **Pre-warm:** when an agent's body joins a world no renderer serves, a roamer is sent at once, so the world is
  loaded by the time the agent asks.
- **Sweep:** every world with an agent in it and no renderer is sent a *parked* roamer (one with no agent where it
  is): when a roamer joins (its watchdog restarts it into its lobby every few hours and on every client deploy) and
  every 15 s. So an agent's world goes back to being served after a restart, before anyone asks. A sweep never takes a
  roamer from another agent's world; with more such worlds than roamers, the rest are served on demand. It leaves a
  world whose own (pinned) renderer left in the last 2 minutes, since that renderer is restarting; a roamer beside a
  pinned renderer counts as parked. A roamer that never reaches a world it was swept to is backed off (15 s, doubling to 10
  minutes) and logged.
- **No partial worlds:** before capturing, a renderer moves its camera to the followed body (residency loads what is
  near it) and waits until the world is realized there — the body in its scene, the world's builds done, no model
  loading or standing in, steady for a second. It waits as long as the server says it may: each `capture` carries
  `wait`, the frame's window less a 2 s margin: up to 38 s for a roamer that arrived within the last 40 s (sent by
  this request, a pre-warm or a sweep), less if the request's 55 s deadline has less left; otherwise the frame
  window (`SNAP_TIMEOUT_SEC`) less the margin, 10 s by default, pinned renderers included. If the world is still not realized by then, the snapshot fails with the counts
  (`the renderer is still loading this world — 3 models still loading (12 in); try again in a few seconds`), as a
  retryable 503 — never a half-loaded frame. A settled renderer captures at once. (The renderer used to give up at
  a fixed 20 s while the server would wait 40, which failed first snapshots of worlds that took a little longer.)
- Refusals stay explicit: no roamer free → 503 naming the world; a renderer still loading → its own words.

`tools/roaming-renderer-check.ts http://host:port` exercises it end to end (pre-warm, a snapshot asked the instant
the agent arrives, the renderer's realized model count at capture, the watchdog's check, and a roamer restarted into
its lobby being swept back before the next snapshot). `GRACE_MS=0` asks at once.
