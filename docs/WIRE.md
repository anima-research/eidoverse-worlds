# The eidoverse live-wire protocol — inventory freeze v0

Status: **as-built inventory**, first frozen 2026-08-22 (branch
`overhaul/rimward`), revised for protocol v4. This is the surface a new
client builds against. It documents what the wire IS today, quirks included
— it does not yet rule on what it SHOULD be. Companion to `spec/PROTOCOL.md`,
which owns the *log* (entry shape, the fold, the door and its gate); this
file owns the *transport*: the WebSocket session and the HTTP routes around
it. Promotion into `spec/` (and its CC0 grant) is a maintainer decision, not
taken here.

Source of truth: `server/server.ts` (WS switch + stage tick),
`server/v4/messages.ts` + `server/v4/world.ts` + `shared/v4/door.js` (the
authored plane), `server/messages.ts` (presence lanes), `server/routes.ts`
(HTTP). Where this doc and the code disagree, the code is right and this doc
has a bug — fix the doc, or flag the code change as a **wire change** in
review.

## 1. Transport and session model

- WebSocket at **`/ws`**. An `archipelago-home` auth cookie presented at
  upgrade binds a verified session (`c.auth`/`c.sub`) to the socket; without
  one the socket is anonymous until `join` (which may require `JOIN_TOKEN`).
- All messages both directions are single JSON objects with a string `type`.
- A session is one **leg** of an identity: `(id, surface)`. `surface:
  "world"` (default) is the embodied primary; anything else (`voice`,
  `vr-hands`, …) is an **aux leg** — invisible, poseless, log-mute,
  rtc-capable, reaped when its primary leaves. One live leg per (id,
  surface): a fresh join **takes over** the stale one (close 4002); plain
  spectators never duel. Every accepted leg gets a server-issued
  monotonic **generation** (`gen`) — rtc/attest are stamped and gated by it.
- Flags on join: `spectate` (see everything, appear as nothing, cannot
  author), `agent` (self-declared MCPL body), `renderer` (invisible
  volunteer that answers `snap` requests). Aux surfaces imply spectator.
- Rate caps: **60 msgs/s** per client (`MSG_RATE`, excess silently
  dropped); the door's own rate per identity over everything it makes the
  log hold (acts and says: entries and bytes per 10 s, `RATE` in
  `shared/v4/door.js`), refused with code `rate`.
- No message may kill the process: handler errors answer
  `{type:"error", error:"that request failed server-side — it has been logged"}`.

### Close codes

| code | meaning |
|---|---|
| 4002 | session takeover — same (id, surface) rejoined elsewhere |
| 4003 | bad/missing join token, or login lacks scope |
| 4004 | reserved name (world/system/sim/script:*, or a reserved agent name without its bearer) |
| 4005 | malformed world name / unusable surface name — do not retry |
| 4006 | banned (per-world or global) |
| 4008 | aux leg without a living primary, or aux cap (4 distinct surfaces) |
| 4009 | aux leg presented no binding to the primary's identity authority |

## 2. The two planes (normative doctrine, PROTOCOL.md §5)

Every message belongs to exactly one plane:

- **Authored** — becomes a log entry, folds, replays, is public forever:
  only the `v4` message (a door request) writes here. The requester gets
  `v4-result`; every client gets the raw entries the door appended as
  `{type:"v4-log", from, entries}` and folds them itself with
  `shared/v4/fold.js`. The stream is authoritative; clients must not
  self-apply optimistically without reconciling against it.
- **Presence** — relayed or batched, never persisted, gone when it's gone:
  `pose`/`frame`, `typing`, `caption`, `drag`, `anim`, `puppet`,
  `bodydrag`, `v4-holds` (who holds what), `attest`/`performed`, `whisper`
  (held in memory for absent recipients, lost on restart — deliberately).
  Presence crosses into the log only through checked door requests
  (arriving, put, throw, drop).

## 3. Client → server messages

| type | plane | who may send | shape (essentials) | notes |
|---|---|---|---|---|
| `join` | — | anyone admitted | `{world, id?, token?, avatar?, surface?, spectate?, agent?, renderer?, agentToken?, v4fold}` | travel = leave A, join B on the same socket. Verified sessions: `id` ignored, login name wins. An embodied (`world` surface) join must say `v4fold: true` — it folds the log itself — or it is refused. Answers `snapshot` (§4). |
| `v4` | authored | embodied; spectators may only read | `{id?, tool, args}` | the ONLY door to the log: one door request (create, set, delete, place, batch, use, say, undo, publish, update, grab/put/throw/drop/punt/move/wait, sky/weather/sculpt, upload/adopt, kick/ban/unban, and the reads look/inspect/measure/find/check/history/schema/scripts/help/whois). The asker is stamped from the connection, never read from the payload. Answers `v4-result`. There is no other write path. |
| `history` | read | anyone incl. spectators | `{before?, after?, limit?≤300, verbs?, reqId?}` | pages the log newest-first; answers `history`. |
| `debug` | read | anyone incl. spectators | `{limit?, kinds?}` or `{behavior}` or `{behaviors:true}` | the flight recorder (every refusal) + script status; answers `debug`. |
| `pose` | presence | embodied | `{pose}` | latest-wins into the world's dirty map; fanned out in stage `frame`s at ~15Hz. Bag fields incl. the C18 `xr` tracked-body contract: **docs/pose-wire.md**. Non-finite / malformed samples are refused at the source (`server/posecheck.ts`, 09-06). |
| `typing` | presence | embodied, or bound voice leg | `{to?, state?}` | state ∈ ear/think/tool/mic (whitelist). |
| `caption` | presence | embodied, or bound voice leg | `{text≤500, utt?}` | live speech pacing; the finished utterance lands as one `say`. |
| `drag` | presence | builder+ | `{id, pos, yaw}` | live build feedback; the release is one `set transform` request. |
| `anim` | presence | embodied | `{dur, tracks≤64KB, loop?}` | one-shot custom clip, relayed once. |
| `puppet` | presence | embodied | `{target, pose?, anim?, ragdoll?}` | ROUTED to target, who decides; ragdoll = `true` or `{lean:[x,y,z]}`. |
| `bodydrag` | presence | embodied | `{target, grab?/end?/pose?/p?/yaw?/sim?/pinAt?/unpin?/pins?}` | ragdoll takeover stream, routed to the body's owner; `sim` = ≤24 joints × {j,p,v}. |
| `whisper` | presence | embodied | `{to, text≤4000}` | point-to-point, NEVER logged; ≤20 held per absent recipient, lost on restart. |
| `rtc` | presence | embodied or aux leg | `{to, toSurface?, payload≤20KB}` | signaling, addressed per (id, surface); server stamps `fromGen`/`fromSurface`. |
| `attest` | presence | bound voice leg only | `{seq, digest, gen}` | per-utterance performance receipt; verified against `recentSays` (≤300s, sha256 of text, current gen) then broadcast as `performed`. |
| `bc` | dev | anyone | `{tag}` | crash breadcrumbs, printed on disconnect. |
| `snap-result` | service | renderer legs | `{id, dataUrl?/error?}` | answers a server `snap` request (backs HTTP `/snap`). |
| `world-fork` | admin | owner | `{to}` | a new world (its own genesis) whose founding act names this one, holding a copy of its current state; answers `world-forked`. |
| `world-reset` | admin | owner | `{name}` (must equal the world's) | archives the log beside it and re-founds the world for the same owners. |
| `world-bans` | read | anyone present | `{}` | answers a `mod` text summary. |
| `global-ban` / `global-unban` / `global-bans` | admin | WORLD_ADMIN | `{id, reason?}` | instance-wide, persisted in `.bans.json`, not door requests (there is no global log). |

## 4. Server → client messages

- `snapshot` — the join answer: `{world, you, gen, yourSurfaces, recording,
  v4: {…, state, head, worldId, sim, names, holds, mine}, state (the chat
  window), avatars (roster), yourRights, restore, present[{id, avatar, pose,
  agent, surfaces}]}`. `v4.state` is the fold at `head` (each component
  wrapped `{v}` or `{purged: true}`, as in the digest); a joiner adopts that
  cut and folds on from `head + 1`. Cost scales with the world, not its
  history.
- `geom` — async join follow-up: `{geom: {lib: {bbox}}}` placeholders.
- `v4-log` — `{world, from, entries, names?}`: the raw entries the door just
  appended, starting at seq `from`, fanned to everyone; `names` maps new
  identities to display names. The authored plane's only carrier. A gap, a
  purge or a genesis means the client can't continue its cut and asks for a
  fresh snapshot.
- `v4-result` — `{id, tool, ok, reply}`: the door's own answer to your
  request, whole under `reply` (`{ok: false, refused: {code, reason,
  teach}}` when refused).
- `v4-holds` — `{world, holds: {id: {by, hand, grip?|offset?, second?}}}`:
  who holds what (presence), sent whenever it changes and in every cut.
- `moderated` — `{verb, by, text}`: bystanders' line when the door removed
  someone.
- `frame` — `{seq, t, poses{id: pose}}`: the ~15Hz stage tick, latest-wins,
  dropped for clients with >32KB backlog (skip-to-current, never queue).
- `arrive` / `leave` — embodied presence transitions.
  `surface-transition` — `{id, surface, gen, retired}`: aux-leg
  join/takeover visibility (rtc re-keying, TTS hold capability).
- `error` — `{error}`: every refusal, human-readable. `mod` — `{text}`:
  moderation query/act summaries.
- `history`, `debug` — request answers (echo `reqId`).
- `whisper` (with `echo:true` on your own sent copy), `anim`, `puppet`,
  `bodydrag`, `caption`, `typing`, `drag`, `rtc`, `performed` — presence
  relays, shapes as sent (see §3) plus attribution stamps.
- `snap` — `{id, follow?, view?}`: server asks a renderer leg for a PNG.
- `world-forked`, `world-reset` — admin outcomes.
- `avatar-updated` / `avatar-profile-updated` — library changes (VRM upload,
  profile edit), broadcast to every world.

## 5. Who may write what

The wire carries requests; rights are the door's, keyed on the components a
request would change, never on the request's name (PROTOCOL.md §7). In
short: any component on an entity needs **builder**; anything on `@world`
needs **owner**, except `library:*` (publishing a blueprint, builder);
`use`, `say`, sitting and carrying what a thing's `grabbable.who` allows are
open to **visitors**. Roles live on `@world` as `roles:<identity>`.
`snapshot.yourRights` (and a fresh one whenever roles change) is the
client's view of the same answer; the door re-checks everything anyway.

Requests are open: anyone may add a tool, a `use` action or a script
command, and none of them grants a right. State words are closed: a new
feature is a new component.

## 6. HTTP surface (routes.ts, one line each)

`/ws` (upgrade) · `/auth` GET/POST + `/authcfg` + `/whoami` + `/logout`
(archipelago-home) · `/version` + `/client-version` (build identity) ·
`/library/*` + `/library-list` + `/library-models` (asset library:
upstream-patched > store > eidoverse-video precedence) · `/upload` POST ·
`/avatars` + `/animations` (rosters) · `/geom` (bbox summaries) · `/snap`
(render-for-me via a renderer leg) · `/thumb`, `/thumb/*` (thumbnails) ·
`/perflog` POST (client perf beacons) · `/shared/*`, `/node_modules/*`, `/`
(client serving).

The voice merge adopted upstream's #104 relay-floor wire wholesale:
the `rtc` message is RETIRED (the mesh's SDP lane, deleted with voice.js);
seven SFU-signaling messages arrive (`sfu-answer`, `sfu-ice`, `sfu-pos`,
`sfu-want-negotiate`, `relay-cred`, `voice-moderate`, `voice-consent` —
credentialed, gen-bound, inline in server.ts's switch beside join), plus
server→client `voice-service` (incarnation-stamped state) and the attest
`performed` receipt gaining `rung: "authorized-claim"` + `incarnation`.
Reach travels inside presence pose bags (`pose.reach`, relayed opaquely —
see the amended spec/PROTOCOL.md §5).

Wire additions since the v0 freeze (each flagged in its commit):
physics (PROTOCOL_v2): `snapshot.v4.sim` (the sim layer's cut: what flies,
from which launch, adopted by joiners) ·
`/defs` (the def registry, charter §3 — instance content as data, slice 2) ·
`/tick` (heartbeat gauges, charter §4 — per-system runs/worst-ms/errors,
slice 3) · server→client `defs-updated` `{}` (def hot-reload push, slice 6 —
a def file changed on disk; clients re-fetch /defs and regrow what the
changed content shapes; presence-plane, never logged).

## 7. Quirks recorded, not yet ruled on

Flagged for the phase-1 protocol review — each is as-built behavior a new
client must currently reproduce, and a candidate for a deliberate ruling:

1. `world-fork`/`world-reset`/`world-bans` and the `global-*` family are
   messages, not door requests — world lifecycle lives outside the door.
2. Objects settle through door requests (put, drop, throw: checked acts),
   while `bodydrag` settles through the dragged body's OWNER, on the
   presence plane. Two motion idioms, one seam.
3. `snapshot.yourRights` is advisory — clients re-derive rights from
   `@world.roles:*` in their own fold; the door re-checks everything
   anyway.
4. Whisper durability is memory-only and restart-lossy, deliberately
   (privacy > durability). Any future queue must not touch the log.
5. `bc` and `snap-result` are service lanes (forensics, render volunteering)
   riding the same socket as gameplay.
