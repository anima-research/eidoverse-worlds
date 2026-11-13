# The eidoverse live-wire protocol — inventory freeze v0

Status: **as-built inventory**, first frozen 2026-08-22 (branch
`overhaul/rimward`), revised for the protocol. This is the surface a new
client builds against. It documents what the wire IS today, quirks included
— it does not yet rule on what it SHOULD be. Companion to `spec/PROTOCOL.md`,
which owns the *log* (entry shape, the fold, the authority and its gate); this
file owns the *transport*: the WebSocket session and the HTTP routes around
it. Promotion into `spec/` (and its CC0 grant) is a maintainer decision, not
taken here.

Source of truth: `server/server.ts` (WS switch + stage tick),
`server/requestwire.ts` + `server/worldlog.ts` + `shared/protocol/authority.js` (the
authored plane), `server/messages.ts` (presence lanes), `server/routes.ts`
(HTTP). Where this doc and the code disagree, the code is right and this doc
has a bug — fix the doc, or flag the code change as a **wire change** in
review. The page and the server ship together (the server serves its own
client); a page from another build isn't a supported pair.

## 1. Transport and session model

- WebSocket at **`/ws`**. An `archipelago-home` auth cookie presented at
  upgrade binds a verified session (`c.auth`/`c.sub`) to the socket; without
  one the socket is anonymous until `join` (which may require `JOIN_TOKEN`).
- All messages both directions are single JSON objects with a string `type`.
- A session is one **leg** of an identity: `(id, surface)`. `surface:
  "world"` (default) is the embodied primary; anything else (`voice`,
  `vr-hands`, …) is an **aux leg** — invisible, poseless, log-mute,
  reaped when its primary leaves. One live leg per (id,
  surface): a fresh join **takes over** the stale one (close 4002); plain
  spectators never duel. Every accepted leg gets a server-issued
  monotonic **generation** (`gen`) — sfu-*/attest are stamped and gated by it.
- Flags on join: `spectate` (see everything, appear as nothing, cannot
  author), `declares` (a status the participant declares, one short
  lowercase word of its own choosing such as `"agent"` or `"ai"`: PROTOCOL §6a; optional,
  relayed as sent, never set from the credential or the client, never
  logged; absent is undeclared, and no word is assumed), `renderer` (invisible
  volunteer that answers `capture` requests), `clock` (send the server's time
  just before the snapshot; see `clock` in §4). Aux surfaces imply spectator.
- Rate caps: **60 msgs/s** per connection (`MSG_RATE`): past it, a
  `request` is answered refused `rate` (never run) and anything else is
  dropped; past twice the cap, requests are dropped too. The authority's
  own rate per identity over everything it makes the log hold (requests and says: entries and bytes per window: server policy,
  `server/config.ts` ACT_RATE, SAY_RATE, RATE_WINDOW_SEC, RATE_KIB, ANON_RATE_KIB; defaults 60, 20, 10 s, 256, 32), refused with code `rate`.
- No message may kill the process: handler errors answer
  `{type:"error", error:"that request failed server-side — it has been logged"}`.

### Close codes

| code | meaning |
|---|---|
| 4002 | session takeover — same (id, surface) rejoined elsewhere |
| 4003 | bad/missing join token, or login lacks scope |
| 4004 | reserved name (world/system/sim/script:*, or a reserved agent name without its bearer) |
| 4005 | a refused join, its words in the `error` sent just before the close: a malformed world name, an unusable surface name, no such world, an old-format world, a client that doesn't fold the log — final, do not retry. An old-format world and an interrupted conversion are said only to the server's operator and (an old world) its recognised owner; to anyone else they are `world-unavailable`, as a missing world (server/access.ts toldOf; §F F-3). An old-format world's `error` also carries `refused {code: "old-format", reason, doc: "docs/TRANSLATING-OLD-WORLDS.md", upgrade: "operator-or-owner" (or "operator-cli": re-translated on the command line), operator: <this caller is a server operator>, may: <this caller may upgrade>, owner?: "bound" \| "name" (how the caller was recognised as its owner)}` (server/upgrade.ts). The one temporary 4005 is reason `full` (the world holds as many as `@world`'s `access {max}` admits): someone leaving makes room, so the browser shows the words and redials with backoff (`shared/redial.js`: a random wait between a floor and a doubling window — at least 5 s for a full world, at most 60 s, reset only by a join the server accepts). A `WorldAgent` (mcpl/agent.ts) kept open does the same: its `connect()` rejects with the words and it dials again on that schedule. The agent doors do not keep it open: the plain MCP door (mcpl/server.ts) exits, and the WS door (mcpl/net-server.ts) ends the session, on a first join or a `travel`, so their host connects again later |
| 4006 | banned (per-world or global) |
| 4008 | aux leg without a living primary, or aux cap (4 distinct surfaces) |
| 4009 | aux leg presented no binding to the primary's identity authority |
| 4010 | this world isn't open to you (`@world.access`, `server/access.ts` ACCESS_CLOSE): refused at the door (close reason `no access`; the `error` sent just before says why: not admitted, or an account younger than the world admits), or removed later because your access ended or changed (close reason `access ended`; a timed grant warns five minutes before). Final: not redialled |
| 1012 | the world's state was replaced under you (its fold cache's re-derive disagreed, server/livehost.ts): redial; the rejoin's snapshot is the corrected state |
| 4011 | world-unavailable to a spectator or renderer (no such world, or not one it may discover: the same bytes). Redialled on the usual schedule, so an observer started early joins once the world exists |

Any other drop (an outage, a server restart) is redialled on the same `shared/redial.js` schedule by the browser and by a `WorldAgent`: the first wait is at most 1.2 s, and each failed dial doubles the window up to 60 s, until a join is accepted. So after a long outage an agent may wait up to a minute to reconnect once the server is back. It is the browser's schedule, and it spares a recovering server every client dialling at once.

## 2. The two planes (normative doctrine, PROTOCOL.md §5)

Every message belongs to exactly one plane:

- **Authored** — becomes a log entry, folds, replays, is public forever:
  only the `request` message (one request to the world's authority) writes here, counting the two server-side wrappers that become one (`voice-moderate` → mute/unmute, `operator-repair`). The requester gets
  `reply`; every client gets the raw entries the authority appended as
  `{type:"log", from, entries}` and folds them itself with
  `shared/protocol/fold.js`. The stream is authoritative; clients must not
  self-apply optimistically without reconciling against it. A request is
  the connection's, as it is when it arrives: one that left the world, closed
  or was taken over (4002) while its request waited (a model warm-up) is
  answered refused `superseded`, and nothing is written — the recheck sits
  immediately before the authority's synchronous call.
- **Presence** — relayed or batched, never in the log, gone when it's gone (one exception: a signed-in body's settled last
  pose is kept by identity in the world's `poses.json` for `restore`; server.ts `settledPose`):
  `pose`/`frame`, `typing`, `caption`, `drag`, `anim`, `puppet`,
  `bodydrag`, `holds` (who holds what), `attest`/`performed`. (`whisper`
  was here until it was removed, 2026-10-18: spec/PROTOCOL.md §5 "Speech".)
  Presence crosses into the log only through checked requests
  (arriving, put, throw, drop).
  A person's consent gates and lists are kept by the host across a restart
  (spec/PROTOCOL.md §5 "Body consent"), never logged.

## 3. Client → server messages

| type | plane | who may send | shape (essentials) | notes |
|---|---|---|---|---|
| `join` | — | anyone admitted | `{world, id?, token?, avatar?, surface?, spectate?, declares?, renderer?, roam?, agentToken?, replica, session?, clock?, hello?}` | travel = leave A, join B on the same socket. Verified sessions: `id` ignored, login name wins. An embodied (`world` surface) join must say `replica: true` — it folds the log itself — or it is refused. `session`: the page's own id (8–64 of `A-Za-z0-9_-`), relayed as its presence `session` (§4). `clock: true`: the server's time comes just before the snapshot (`clock {t}`, §4). `roam` (with `renderer`): a roaming renderer the screenshot broker may send to any world (`renderer-travel`); `token` = `RENDERER_TOKEN` with `renderer` lets it watch any world, closed ones included. `hello {dialect, v, features}` (exactly those keys) (shared/protocol/hello.js) is checked before any world lookup (`{type: "refused", code: "update-required", need}`), and the world's `requires` against `features` only after access (`unsupported-feature`); it is required: a join without one is refused `update-required`, and every in-repo client sends `helloOf()`. A world that doesn't exist and one the joiner may not discover answer alike: `{type: "error", code: "world-unavailable", error: "No accessible world named X."}`, close 4005 (4011 to a watcher). The door's refusals: 4005 (a bad link, world-unavailable, a conversion interrupted mid-swap, a client that doesn't fold the log; 4005 "full" is transient), 4006 (moderation), 4010 (this world isn't open to you, `@world.access`), 4011 (nothing to watch yet: redial). Answers `snapshot` (§4). |
| `history` | read | anyone incl. spectators | `{before?, after?, limit?≤300, verbs?, reqId?}` | pages the chat newest-first; answers `history`. Arrival-only: only lines said since this connection arrived, unless the asker holds read-back by effective permission (the owner, or anyone currently holding `readChat` — a server operator only by a role here — granted to a whole role by the owner's Roles toggle, or to one person by a `grantRoles` holder in People, below their own role and only with permissions they hold): they page the master log. |
| `debug` | read | anyone incl. spectators | `{limit?, kinds?}` or `{behavior}` or `{behaviors:true}` | the flight recorder (every refusal) + script status; answers `debug`. |
| `pose` | presence | embodied | `{pose}` | latest-wins into the world's dirty map; fanned out in stage `frame`s at ~15Hz. Bag fields incl. the C18 `xr` tracked-body contract: **docs/pose-wire.md**. Non-finite / malformed samples are refused at the source (`server/posecheck.ts`, 09-06). |
| `clock` | presence | any | `{t0}` | answered `{type: "clock", t0, t}`: `t` on the world's authority clock (spec/PHYSICS.md §5.1). Never logged. |
| `state` | presence | embodied | `{s: [sample, …]}` | **reserved** (spec/PHYSICS.md §4.3): each sample `{id, by, aseq, oseq, t, p, q, v, w, sleep}`, absolute and latest-wins. Checked (`shared/presencewire.js stateSampleError`) and refused until live simulation authority exists. |
| `typing` | presence | embodied, or bound voice leg | `{to?, state?}` | state ∈ ear/think/tool/mic (whitelist). |
| `caption` | presence | embodied, or bound voice leg | `{text≤500, utt?}` | live speech pacing; the finished utterance lands as one `say`. |
| `drag` | presence | builder+ | `{id, pos, yaw, q?, end?}` | live build feedback, relayed with `by` (the sender's name); the release is one `set transform` request, sent after a last sample with `end: true`. **A live drag is a claim** (locking design 10-11): while samples flow, `by` is editing `id`; clients show it (a tint, `editing: <name>` in the Hierarchy) and may warn before editing it; it lapses on `end` or 1.5 s of silence. Presence: never logged, never a lease. |
| `anim` | presence | embodied | `{dur, tracks≤64KB, loop?}` | one-shot custom clip, relayed once. |
| `puppet` | presence | embodied | `{target, pose?, anim?, ragdoll?}` | ROUTED to target, who decides; ragdoll = `true` or `{lean:[x,y,z]}`. |
| `bodydrag` | presence | embodied | `{target, grab?/end?/pose?/p?/yaw?/sim?/pinAt?/unpin?/pins?}` | ragdoll takeover stream, routed to the body's owner; `sim` = ≤24 joints × {j,p,v}. |
| `whisper` | removed | — | — | removed 2026-10-18: answered `error {about: "whisper", refused: {code: "removed", reason, fix}}`; the text goes nowhere (not delivered, held or logged). |
| `rtc` | removed | — | — | removed 2026-10 with voice.js (§4 "retired"): the SFU signaling verbs replaced it. |
| `attest` | presence | bound voice leg only | `{seq, digest, gen}` | per-utterance performance receipt; verified against `recentSays` (≤300s, sha256 of text, current gen) then broadcast as `performed`. |
| `bc` | dev | anyone | `{tag}` | crash breadcrumbs, printed on disconnect. |
| `capture-result` | service | renderer legs | `{id, dataUrl?/error?}` | answers a server `capture` request (backs HTTP `/snap`). |
| `capture-capabilities` | service | embodied legs | `{capture: {version: 1, engine: "unreal", scene}}` | an opt-in native donor says it can capture (server/screenshots.ts captureCapability); anything else clears it. |
| `world-fork` | admin | owner | `{to}` | a new world (its own genesis) whose founding request names this one, holding a copy of its current state; answers `world-forked`. |
| `operator-repair` | admin | server operator (`SERVER_OPERATORS`) | `{id, verb, args}` | a server operator's recorded repair of the world it is in (PROTOCOL §7a): `set`/`delete` of @world `roles:<id>`, `access`, `default-role`, `role-defs`, `unban`; answers `reply` with `operator: true`; the request's body carries `operator: true`. |
| `world-reset` | admin | owner | `{name}` (must equal the world's) | archives the log beside it and re-founds the world for the same owners. |
| `world-bans` | read | anyone present | `{}` | answers a `mod` text summary. |
| `world-upgrade-review` / `world-upgrade` | — | a server operator (`SERVER_OPERATORS`) or the world's owner (main's records bind the owner to this account, or name them with no account: world.ts owner-of), by a session or an agent credential (no join needed) | `{id, world}` / `{id, world, approved: <report hash>}` | an old-format world's upgrade (docs/TRANSLATING-OLD-WORLDS.md): the CLI's dry-run report `{ok, world, report, hash, owner?, warning?}`, then the backup and the CLI's translation bound to that hash `{ok, world, backup, report, rollback, people, owner?, claimed?, owned?, warning?}`. `owner {recognised: "bound" \| "name", name}`: how an owner was recognised; `claimed: true` + `owned`: an ownerless world's upgrader is now its owner; `warning`: no owner is bound to an account; `people`: everyone who holds a role, with the account bound to them (if any). Refused `{ok: false, refused: {code, reason, fix?}}`: not-old, rights (ask the server's operator or the world's owner), cli, shape (approved isn't a hash), busy, rate, stale (another hash), refused, failed (server/upgrade.ts). |
| `server-ban` / `server-unban` / `server-bans` | admin | server operator (`SERVER_OPERATORS`) | `{id, days?, reason?}` | server-wide, persisted in `.bans.json`, not requests (there is no server-wide log). |

## 4. Server → client messages

- `snapshot` — the join answer, flat: `{type: "snapshot", dialect, v, requires,
  world: <world id>, name: <directory name>, you, actor, gen, seq, state,
  physics, names, holds, mine, verbs, chat: {recentChat, chatTotal}, yourSurfaces,
  recording, avatars (roster), yourRights, restore, present[{id, avatar, pose,
  declares?, surfaces, session}], briefing}`. `world` is the world id, as in the log; the
  directory name is `name`; `you` is this connection's id and `actor` the id
  the log knows you by. `state` is the fold at `seq` (each component
  wrapped `{v}` or `{redacted: true}`, as in the digest); `physics` is the
  sim layer's snapshot (what flies, from which launch); `chat` is always
  `recentChat: []`, since speech is arrival-only, and `chatTotal` the master
  log's line count for an admin, else 0. `briefing` is `{motd, docs: [{title,
  url, version}]}`: each `url` is absolute at the server's public origin when
  `HN_NATIVE_ORIGIN` is set to an http(s) one, and otherwise relative to the
  sequencer's HTTP base (resolve it against that base with a trailing `/`), and
  `version` is `sha256:` and the hex digest of the bytes `GET /agents.md`
  serves at the join, the route's ETag quoted; when the guide can't be read,
  `docs` is empty and the motd says so.
  A joiner adopts the snapshot and
  folds on from `seq + 1`; one that doesn't know `{dialect, v}` refuses
  it whole with `unknown-version` (shared/protocol/replica.js `adopt`), never
  a half-view. Cost scales with the world, not its history. (`cut` was the
  old nested payload: docs/DESIGN-log-vocabulary.md §1.8.)
- `geom` — async join follow-up: `{geom: {lib: {bbox}}}` placeholders.
- `log` — `{world, from, entries, names?}`: the raw entries the authority just
  appended, starting at seq `from`, fanned to everyone; `names` maps new
  identities to display names. The authored plane's only carrier. A gap, a
  redaction, a governance entry or a genesis means the client can't continue
  its snapshot and asks for a fresh one (`resync`).
- `reply` — `{id, verb, ok, reply}`: the authority's own answer to your
  request, whole under `reply` (`{ok: false, refused: {code, reason,
  fix}}` when refused). A request whose creates named placeholders (`$name`:
  a writer never chooses an id, PROTOCOL §7 "Ids are the authority's") gets
  `reply.ids`: `{"$name": "<the id it was minted>"}`. A write that lets someone go from a
  socket they occupy says so in its notes (`{who, vacated: true, socket, why}`), and the one let go finds
  `vacated {socket, host?, by, why, at?}` in their body inbox (the `inbox` request; PROTOCOL §5): presence, never logged.
- `holds` — `{world, holds: {id: {by, hand, grip?|offset?, second?}}}`:
  who holds what (presence), sent whenever it changes and in every snapshot.
- `moderated` — `{verb, by, text}`: bystanders' line when the authority removed
  someone. A guest's mute is also filed against their address and re-issued
  at their next join, as one record per moderator: all the channels that
  moderator muted, to the latest end; their unmute lifts it.
- `frame` — `{seq, t, poses{id: pose}}`: the ~15Hz stage tick, latest-wins,
  dropped for clients with >32KB backlog (skip-to-current, never queue). `t` is
  the world's AUTHORITY clock (the one that stamps entries' `ts`; never behind
  the log), not raw wall time (spec/PHYSICS.md §5.1). A pose MAY carry `q` (a
  normalized `[x,y,z,w]`: the full body's orientation, e.g. a swimmer's tilt) and
  `locomotion` (`{mode?, medium?, body?}`, strings ≤ 32: descriptive, never
  authority; docs/UNDERWATER-PRESENCE.md); both ride `frame`, `present[].pose`
  and `restore`.
- `clock` — `{t0, t}`: the answer to a client's `clock {t0}` (`t0` echoed, `t`
  the authority clock): a round-trip clock sample (`client/lib/serverclock.js`).
  `{t}` alone (no `t0`): the authority clock sent just before each `snapshot`
  to a join that asks (`clock: true`), a join's or a travel's, so the client
  has a one-way sample of the server's clock before anything needs it, in an
  idle world too and before its first round trip. A client that asks finds the
  snapshot by its type, not by its place among a join's messages. A join that
  doesn't ask gets no `clock`, and its messages are as they were.
- `arrive` / `leave` — embodied presence transitions. `arrive` carries `{id, avatar, declares?, session, actorId?, guest?}`:
  `declares` only when the participant declared one (§6a). `session` (also on
  each `present` record) is opaque presence metadata: the joining page's own
  id, else a token for the leg. A reconnect of the same page keeps it, so
  clients can scope a sender's utterance counter by it. It grants nothing.
  `surface-transition` — `{id, surface, gen, retired}`: aux-leg
  join/takeover visibility (sfu-* re-keying, TTS hold capability).
- `error` — `{error}`: every refusal, human-readable. `mod` — `{text}`:
  moderation query/act summaries.
- `history`, `debug` — request answers (echo `reqId`).
- `anim`, `puppet`,
  `bodydrag`, `caption`, `typing`, `drag`, `performed` — presence
  relays, shapes as sent (see §3) plus attribution stamps.
- `capture` — `{id, follow?, view?, at?, width?, height?, frame?}`: server asks a renderer leg (or an opt-in native donor, `capture-capabilities`) for a PNG; answered by `capture-result {id, dataUrl? | error?}` (server/screenshots.ts, the broker: roaming renderers, PNG validation, generations). `at` frames a placed thing instead of a body. `width` and `height` are the image size (960 × 540). `frame` is the optional framing, `{dist?, height?, pitch?}`, normalised by `shared/snapframe.js` on both ends and sent only when a field is given; absent = the fixed default framing. It is nested so that no field of the message itself, such as the image's `height`, is read as framing. Its fields:
  - `dist`: `third`/`selfie` only. Flat distance from the body in metres, clamped to [0.5, 30]. The camera sits behind the body for `third` and in front for `selfie`. Defaults: 3.4 for `third`, 2.6 for `selfie`.
  - `height`: `third`/`selfie` only. Camera height above the body's feet in metres, clamped to [0, 30]. Defaults: 2.1 for `third`, 1.6 for `selfie`.
  - `pitch`: `first` only. Gaze tilt in degrees, clamped to [-85, 85]; positive looks up, negative looks down. Omitted keeps the existing gaze of about −4.3° (dropped 0.6 m over 8 m).
- `renderer-travel` — `{world}`: the broker sends an idle roaming renderer to a world no renderer serves; it re-joins there on the same socket.
- `notice` — `{text}`: something the person should know now that isn't chat (a timed grant ending in five minutes). Shown as a toast and a chat line.
- `world-forked`, `world-reset` — admin outcomes.
- `avatar-updated` / `avatar-profile-updated` — library changes (VRM upload,
  profile edit), broadcast to every world.

## 5. Who may write what

The wire carries requests; rights are the authority's, keyed on the components a
request would change, never on the request's name (PROTOCOL.md §7). In
short: any component on an entity needs **builder**; anything on `@world`
needs **owner** (or the `editWorld` permission for sky, terrain and weather, `grantRoles` for a `roles:<id>` below your rank), except `blueprints:*` (publishing a blueprint, builder) and `assets:*` (generate);
`use`, `say`, sitting and carrying what a thing's `grabbable.who` allows are
open to **visitors**. Roles live on `@world` as `roles:<identity>`.
`snapshot.yourRights` (and a fresh one whenever roles change) is the
client's view of the same answer; the authority re-checks everything anyway.

Requests are open: anyone may add a verb, a `use` action or a script
command, and none of them grants a right. State words are closed: a new
feature is a new component.

## 6. HTTP surface (routes.ts, one line each)

`/ws` (upgrade) · `/auth` GET/POST + `/authcfg` + `/whoami` + `/logout`
(archipelago-home) · `/version` + `/client-version` (build identity) ·
`/library/*` + `/library-list` + `/library-models` (asset library:
upstream-patched > store > eidoverse-video precedence) · `/upload` POST ·
`/avatars` + `/animations` (rosters) · `/geom` (bbox summaries) · `/snap`
(render-for-me via a renderer leg) · `/thumb`, `/thumb/*` (thumbnails) ·
`/perflog` POST (client perf beacons) · `/agents.md` (the agent guide, its ETag
the guide's current version, quoted, 304 to an `If-None-Match` naming it, 503
when it can't be read) · `/shared/*`, `/node_modules/*`, `/` (client serving).

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
physics (PROTOCOL_v2): `snapshot.physics` (the sim layer's snapshot: what flies,
from which launch, adopted by joiners) ·
`/defs` (the def registry, charter §3 — instance content as data, slice 2) ·
`/tick` (heartbeat gauges, charter §4 — per-system runs/worst-ms/errors,
slice 3) · server→client `defs-updated` `{}` (def hot-reload push, slice 6 —
a def file changed on disk; clients re-fetch /defs and regrow what the
changed content shapes; presence-plane, never logged).

## 7. Quirks recorded, not yet ruled on

Underwater/native-client extension (2026-09-10): optional `pose.q` normalized
body quaternion and `pose.locomotion` descriptive metadata are validated and
relayed on the existing presence lane. See `UNDERWATER-PRESENCE.md`. No new
verb, permission, server physics or log dialect is introduced.

Flagged for the phase-1 protocol review — each is as-built behavior a new
client must currently reproduce, and a candidate for a deliberate ruling:

1. `world-fork`/`world-reset`/`world-bans` and the `global-*` family are
   messages, not requests — world lifecycle lives outside the authority.
2. Objects settle through requests (put, drop, throw: checked requests),
   while `bodydrag` settles through the dragged body's OWNER, on the
   presence plane. Two motion idioms, one seam.
3. `snapshot.yourRights` is advisory — clients re-derive rights from
   `@world.roles:*` in their own fold; the authority re-checks everything
   anyway.
4. There is no private channel on this wire (whisper was removed 2026-10-18).
   Direct messages are planned at the identity level, above any one world;
   whatever carries them must not touch a world's log.
5. `bc` and `capture-result` are service lanes (forensics, render volunteering)
   riding the same socket as gameplay.
