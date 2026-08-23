# The eidoverse live-wire protocol — inventory freeze v0

Status: **as-built inventory, frozen 2026-08-22** (branch `overhaul/rimward`).
This is the strangler seam of the overhaul charter (§6): the surface a new
client builds against and a sim-core refactor must not drift. It documents
what the wire IS today, quirks included — it does not yet rule on what it
SHOULD be. Companion to `spec/PROTOCOL.md`, which owns the *log dialect*
(entry shape, verbs' fold semantics, authority ladder); this file owns the
*transport*: the WebSocket session and the HTTP routes around it.
Promotion into `spec/` (and its CC0 grant) is a maintainer decision, not
taken here.

Source of truth: `server/server.ts` (WS switch + stage tick),
`server/verbs.ts` + `server/rights.ts` (authored plane), `server/routes.ts`
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
- Rate caps, enforced server-side, excess silently dropped: **60 msgs/s**
  per client (`MSG_RATE`), **12 authored verbs / 4s** (`VERB_RATE`, refusal
  message sent once per window).
- No message may kill the process: handler errors answer
  `{type:"error", error:"that request failed server-side — it has been logged"}`.

### Close codes

| code | meaning |
|---|---|
| 4002 | session takeover — same (id, surface) rejoined elsewhere |
| 4003 | bad/missing join token, or login lacks scope |
| 4004 | reserved name (world/bhv:*, or a reserved agent name without its bearer) |
| 4005 | malformed world name / unusable surface name — do not retry |
| 4006 | banned (per-world or global) |
| 4008 | aux leg without a living primary, or aux cap (4 distinct surfaces) |
| 4009 | aux leg presented no binding to the primary's identity authority |

## 2. The two planes (normative doctrine, PROTOCOL.md §5)

Every message belongs to exactly one plane:

- **Authored** — becomes a log entry, folds, replays, is public forever:
  only the `verb` message writes here, and the server echoes the appended
  entry to everyone (author included) as `{type:"log", entry}`. The echo is
  authoritative; clients must not self-apply optimistically without
  reconciling against it.
- **Presence** — relayed or batched, never persisted, gone when it's gone:
  `pose`/`frame`, `typing`, `caption`, `drag`, `anim`, `puppet`,
  `bodydrag`, `lease` streaming, `rtc`, `attest`/`performed`, `whisper`
  (held in memory for absent recipients, lost on restart — deliberately).

## 3. Client → server messages

| type | plane | who may send | shape (essentials) | notes |
|---|---|---|---|---|
| `join` | — | anyone admitted | `{world, id?, token?, avatar?, surface?, spectate?, agent?, renderer?, agentToken?}` | travel = leave A, join B on the same socket. Verified sessions: `id` ignored, login name wins. Answers `snapshot` (§4). First embodied joiner of a brand-new world is granted owner via the log. |
| `verb` | authored | embodied, rank-gated | `{verb, args}` | the ONLY door to the log. Closed verb set (§5); refusals teach the extension lanes (comp/use/behavior). |
| `history` | read | anyone incl. spectators | `{before?, after?, limit?≤300, verbs?, reqId?}` | pages the log newest-first; answers `history`. |
| `debug` | read | anyone incl. spectators | `{limit?, kinds?}` or `{behavior}` or `{behaviors:true}` | the flight recorder + behavior consoles; answers `debug`. |
| `pose` | presence | embodied | `{pose}` | latest-wins into the world's dirty map; fanned out in stage `frame`s at ~15Hz. |
| `typing` | presence | embodied, or bound voice leg | `{to?, state?}` | state ∈ ear/think/tool/mic (whitelist). |
| `caption` | presence | embodied, or bound voice leg | `{text≤500, utt?}` | live speech pacing; the finished utterance lands as one `say`. |
| `drag` | presence | builder+ | `{id, pos, yaw}` | live build feedback; the release is a `place` verb. |
| `anim` | presence | embodied | `{dur, tracks≤64KB, loop?}` | one-shot custom clip, relayed once. |
| `puppet` | presence | embodied | `{target, pose?, anim?, ragdoll?}` | ROUTED to target, who decides; ragdoll = `true` or `{lean:[x,y,z]}`. |
| `bodydrag` | presence | embodied | `{target, grab?/end?/pose?/p?/yaw?/sim?/pinAt?/unpin?/pins?}` | ragdoll takeover stream, routed to the body's owner; `sim` = ≤24 joints × {j,p,v}. |
| `lease` | presence→log | embodied | `{op: claim\|state\|release, id, p?, yaw?, q?, take?}` | server arbitrates (docs/leases.md); release/loss commits one `place` verb. Proximity take ≤3.5m; 5s staleness; ≤8 leases/client. |
| `whisper` | presence | embodied | `{to, text≤4000}` | point-to-point, NEVER logged; ≤20 held per absent recipient, lost on restart. |
| `rtc` | presence | embodied or aux leg | `{to, toSurface?, payload≤20KB}` | signaling, addressed per (id, surface); server stamps `fromGen`/`fromSurface`. |
| `attest` | presence | bound voice leg only | `{seq, digest, gen}` | per-utterance performance receipt; verified against `recentSays` (≤300s, sha256 of text, current gen) then broadcast as `performed`. |
| `bc` | dev | anyone | `{tag}` | crash breadcrumbs, printed on disconnect. |
| `snap-result` | service | renderer legs | `{id, dataUrl?/error?}` | answers a server `snap` request (backs HTTP `/snap`). |
| `world-fork` | admin | owner | `{to}` | byte-copies log+snapshot+poses; answers `world-forked`. |
| `world-reset` | admin | owner | `{name}` (must equal the world's) | archives to `erased-<ts>/`, re-grants prior owners. |
| `world-bans` | read | anyone present | `{}` | answers a `mod` text summary. |
| `global-ban` / `global-unban` / `global-bans` | admin | WORLD_ADMIN | `{id, reason?}` | instance-wide, persisted in `.bans.json`, NOT log verbs (there is no global log). |

## 4. Server → client messages

- `snapshot` — the join answer: `{world, you, gen, yourSurfaces, recording,
  state, throughSeq, entries (tail), avatars (roster), yourRights, restore,
  present[{id, avatar, pose, agent, surfaces}]}`. State + tail is the whole
  world; cost scales with the world, not its history.
- `geom` — async join follow-up: `{geom: {lib: {bbox}}}` placeholders.
- `log` — `{entry}`: one appended entry, fanned to everyone. The authored
  plane's only carrier.
- `frame` — `{seq, t, poses{id: pose}}`: the ~15Hz stage tick, latest-wins,
  dropped for clients with >32KB backlog (skip-to-current, never queue).
- `arrive` / `leave` — embodied presence transitions.
  `surface-transition` — `{id, surface, gen, retired}`: aux-leg
  join/takeover visibility (rtc re-keying, TTS hold capability).
- `lease` — `{op: granted\|denied\|claimed\|state\|lost\|released, …}`.
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
- `pendulum` — reaction-emitted nudge (reactions.ts) riding the presence
  plane.

## 5. The authored verb set (rank from rights.ts VERB_NEEDS)

Fold semantics are PROTOCOL.md §3's; this table is the wire's admission gate.
Rank: 0 visitor (using the world), 1 builder (shaping it), 2 owner.

- rank 0: `say`, `use`, `punt`
- rank 1: `spawn`, `place`, `remove`, `light`, `comp`, `motion`,
  `behavior`, `force`, `mount`*, `dismount`* (*rank 0 when mounting
  YOURSELF — sitting is using, not building), `asset` (also needs the
  `gen` capability)
- rank 2: `terrain`, `grass`, `sky`, `weather`, `grant`, `kick`, `ban`,
  `unban`
- server-only actors: `genesis`, `bstate` (scripts' persisted kv),
  lease-settled `place` (actor `world`, `via:"lease"`)

The set is **closed by design**: state extends through `comp`, interaction
through `use` + reactions, semantics through `behavior` scripts. A new verb
is a protocol amendment.

## 6. HTTP surface (routes.ts, one line each)

`/ws` (upgrade) · `/auth` GET/POST + `/authcfg` + `/whoami` + `/logout`
(archipelago-home) · `/version` + `/client-version` (build identity) ·
`/library/*` + `/library-list` + `/library-models` (asset library:
upstream-patched > store > eidoverse-video precedence) · `/upload` POST ·
`/avatars` + `/animations` (rosters) · `/geom` (bbox summaries) · `/snap`
(render-for-me via a renderer leg) · `/thumb`, `/thumb/*` (thumbnails) ·
`/perflog` POST (client perf beacons) · `/shared/*`, `/node_modules/*`, `/`
(client serving).

Wire additions since the v0 freeze (each flagged in its commit):
`/defs` (the def registry, charter §3 — instance content as data, slice 2) ·
`/tick` (heartbeat gauges, charter §4 — per-system runs/worst-ms/errors,
slice 3) · server→client `defs-updated` `{}` (def hot-reload push, slice 6 —
a def file changed on disk; clients re-fetch /defs and regrow what the
changed content shapes; presence-plane, never logged).

## 7. Quirks recorded, not yet ruled on

Flagged for the phase-1 protocol review — each is as-built behavior a new
client must currently reproduce, and a candidate for a deliberate ruling:

1. `world-fork`/`world-reset`/`world-bans` and the `global-*` family are
   messages, not verbs — world lifecycle lives outside the closed verb set.
2. `lease` is the one presence stream that writes the log (its settlement
   `place`), by design (docs/leases.md); `bodydrag` settles through the
   OWNER's ordinary verbs instead. Two object-motion idioms, one seam.
3. `snapshot.yourRights` is advisory — clients re-derive rights from live
   `grant` entries; the server re-checks everything anyway.
4. Whisper durability is memory-only and restart-lossy, deliberately
   (privacy > durability). Any future queue must not touch the log.
5. `bc` and `snap-result` are service lanes (forensics, render volunteering)
   riding the same socket as gameplay.
