# World access: who may enter a world, decided by the world

Status: implemented on branch `feat/world-access`: world access, the owner
panel (World › 🔒 access) and agent travel rules. What is left is operator
config on the home node and the Unreal client (see the end). Decisions from
antra, 2026-10-17, are folded in below.

## The split

- **Archipelago answers "who is this?"**: a verified `sub`, a display name, a
  kind (human/agent). It also still answers "may this identity use Eidoverse
  at all?" through the `worlds:join` scope.
- **Eidoverse answers "may they be in *this* world, and what may they do?"**:
  per world, owned by the world's owners, and changeable from inside the
  world by a human or an agent, with no home-node edit and no re-minted
  credential.

## Decisions (antra, 2026-10-17)

1. **No outsiders.** `worlds:join` stays required. A world chooses among
   instance members; it cannot admit someone without the scope. Nothing
   changes on the home node's login.
2. **Founding:** every member may create worlds, capped per day.
3. **Expiry while inside:** warn 5 minutes before, then remove.
4. **Members-only worlds are unlisted and invisible** to non-members. There
   is therefore no "knock": a refusal says only that the world isn't open to
   you.
5. ~~Builders may create invite links~~. **No invite links** (antra,
   later the same day): owners add people from inside the world, by name,
   with a search of everyone who has signed in. The one case links covered,
   a person Eidoverse has never seen, is handled by that person signing in
   once (opening any world).
6. **Forks keep the member list.** They do already, since roles ride the
   copied log. A fork also counts against the founding cap.

## What existed before (origin/main 8072c47)

| Layer | Where | What it decides | Problem |
|---|---|---|---|
| Instance door | aid1 scope `worlds:join` / `worlds:spectate`, or `JOIN_TOKEN` | may use Eidoverse at all | fine. Stays |
| Per-world, **agents only** | MCPL door `joinAllowed`: credential claims `world`, `worlds[]`, `create` | which worlds an agent may reach or found | set on id.animalabs.ai. Browser joins ignored it, so humans could enter every world |
| Per-world, native sessions | `nativeWorld: "water" \| "*"` | a paired device's login is limited to one world | credential narrowing, not world policy. Kept |
| Inside a world | log-sourced `roles` (`visitor < builder < owner`, plus `gen`/`fly`/caption) and `bans` | what you may do once inside | no rung below visitor, no expiry |
| Reads | `/worlds`, `/geom`, `/heightmap`, `/snap`, `/relay-diag` | | public |

## Model

### Entry is the bottom of the existing ladder

```
none  <  spectator  <  visitor  <  builder  <  owner
 -2        -1           0          1          2      (existing ranks unchanged)
```

- `none` may not enter, may not watch, and the world is invisible to them.
- `spectator` may watch but has no body.
- The wildcard `*` is everyone not named. `grant * none` makes a world
  members-only, `grant * spectator` makes it watch-only, and `grant * builder`
  (or revoking `*`) opens it again. A world with no `*` record reads as
  builder, so **no existing world changes.**

It is one structure, not a separate access list. The roles map is already
event-sourced, sub-keyed, owner-gated, reachable by agents, and computed
identically by server, browser and agent (`shared/rightsfold.js`), so "may I
build" and "may I be here" cannot disagree.

### Timed grants

`grant {id, role, for: "2h"}`. The door turns the duration into an absolute
`until` (epoch ms), so the log stays deterministic. `until: null` clears an
end. If `until` is absent, the record keeps whatever end it had (adding
`+gen` doesn't make someone permanent). A reader treats a record past its
`until` as absent, so the holder falls back to `*`. Every second the sequencer
sweeps: anyone whose access ends within 5 minutes gets a `notice`, and once
the end passes it writes a world-authored `grant {id, revoke, expired}` and
removes whoever lost entry (close code 4010).

Guards: ownership never expires, and the wildcard never expires (an expiring
`*` would quietly open a closed world). Every grant is also folded into a copy
first, and refused if the result would leave a closed world with no owner (an
ownerless world reads as open) or would shut out the owner making the change.
The guards check the result rather than the one record named, because a grant
whose sub merges records can touch more than one. `WORLD_ADMIN` remains the
recovery of last resort.

### Naming who

- **A record already filed under that exact name:** it keeps its own sub. The
  directory is never consulted over it. (Review: a directory lookup once
  returned another person's sub, and the fold, which touches every record
  carrying a sub, deleted their record.) A name-keyed record is bound to the
  person standing in the world under that name, as before.
- **No record under the name, the person is here:** bound to their sub.
- **No record, not here:** resolved through Eidoverse's own directory
  (`WORLDS_DIR/.principals.json`, 0600). It is written at every verified
  door: browser login, aid1 agent join, always under the *credential's* name.
  One match binds; several are refused with the candidate subs listed; none
  stays name-keyed.
- **A subject string** (`human:discord:…`, `agent:…@…`): used directly.
- **The granter is told what happened**: "X's grant is bound to <sub>
  (human, last here as …)", "revoked X's grant (<sub>)", or a warning that a
  grant is by name only.
- **Agents now carry their sub.** An agent joining through the MCPL door with
  an aid1 credential arrives with `c.sub = payload.sub`. Before, the
  sequencer knew agents only by name.
- **In a closed world a name is not a key.** A record filed only by name (no
  sub) admits only an identity whose *name* is authoritative: a tokens.json
  agent, or an aid1 agent (agent names are enrolled uniquely). A human's
  Discord display name is self-chosen, and a typed JOIN_TOKEN name is
  anything, so for them only sub-bound records and the wildcard count. To let
  in a person who was granted by name before Eidoverse ever saw them: revoke
  and grant again once they've signed in once, or grant by subject. Inside open worlds name-keyed
  grants keep their old meaning.
- **Identity is per join.** A socket that joins again (travel) is
  re-identified from scratch: the agent-credential match, the reserved-name
  flag and the sub are reset and re-derived from what *this* join presented.
  (Review: a credentialed socket re-joining under a member's typed name was
  treated as verified.)

### Visibility

- `/worlds` answers **per caller**: the browser's cookie session, or
  `Authorization: Bearer <aid1 | tokens.json bearer>`. Worlds the caller
  cannot even watch are omitted. Each listed world now also carries `access`
  (`open | watch | members`) and `you` (`enter | watch`).
- `/geom?world`, `/heightmap`, `/snap` and `/relay-diag?world` answer for an
  invisible world exactly as they do for a world that doesn't exist.
- A refused join says `"X" isn't open to you`. That the name is *taken*
  cannot be hidden, because founding it would fail; nothing else is revealed.
- `/worlds` must not load idle worlds, since loaded worlds are never
  unloaded. An idle world's door is read from its snapshot plus the `grant`/
  `ban`/`unban` entries in the log tail, cached until either file changes.

### Founding

Every member may found worlds, `FOUND_DAILY_CAP` per identity per rolling 24 h
(default 5; `off` removes the cap; operators are exempt). This applies to
stepping into a new name and to `/fork`. The ledger is
`WORLDS_DIR/.founding.json`. For JOIN_TOKEN typed names the cap is per typed
name, so it can be dodged by retyping. Those doors are operator-trusted.
Watching a world that doesn't exist founds nothing: it closes with 4011,
which clients retry, so an observer started early joins once the world
exists. Founding also now happens only *after* identity, ban and access
checks: before, `getWorld()` ran first and wrote a genesis entry, so a refused
join could leave a world behind.

### Credential narrowing vs world policy

- **World policy** is the only thing that can *admit*.
- **Credential narrowing** can only *refuse*. Examples: `nativeWorld`, and
  `claims.worlds` at the MCPL door. Absent means unrestricted.

## Enforcement: one function

`server/access.ts canEnter(world, who, "embody" | "watch")` evaluates global
ban → world ban → operator → credential narrowing → the ladder.

| Door | Phase 1 |
|---|---|
| browser ws `join` (incl. travel) | identity re-derived per join; `canEnter` against the world's door (read from disk if idle, so a refused join loads nothing); then the founding cap |
| agent join via MCPL door | same path. The sub now arrives with the aid1 credential |
| after any `grant` (owner, agent) | `settleAccess`: push `your-rights`, remove whoever lost entry (4010) |
| expiry | `sweepAccess` every `ACCESS_SWEEP_MS` (5 s) |
| `/worlds`, `/geom`, `/heightmap`, `/snap`, `/relay-diag` | per-caller visibility |
| MCPL door: travel and dial-time `?world=` | the credential only narrows (`worlds` list, `create: false`); the door asks the sequencer `GET /access` *as the agent* before anything moves, so the world decides and a refusal strands nothing |
| MCPL door `worlds` tool, `/snap` | ask *as the agent* (bearer), so members see their private worlds |
| behavior scripts | may not change access (`*`, revoke, `for`/`until`, `sub`, the two new rungs), and may not grant at all in a closed world. A script's emit skips the validator and the settle pass |
| `/reset` | owners kept with their sub. A closed world keeps its `*` and its live members, because erasing content must not open it |
| renderer client | a renderer is the vision of the agents inside, so one holding the renderers' credential (`RENDERER_TOKEN`, presented as its door key *with* the renderer flag) may watch any world, members-only included. It stays invisible and never authors, and closing a world doesn't remove it. A client that only *says* renderer (door key plus flag) gets nothing extra. The snapshot dispatcher sends a roamer only where it will be let in, because a refused renderer stops rather than retrying |

## UX

**World › 🔒 access** (`client/lib/accesspanel.js`), a tab in the world
panel:

- **The door:** four buttons (open · visitors · watch only · members only),
  the current one marked. Closing while unlisted people are present asks
  twice and says how many will have to leave.
- **Listed by name:** each member with role, "agent" / "here now" / time left,
  a role select, a time select (no end · 1 hour · 1 day · 1 week; picking one
  restarts it from now) and ✕ to remove. A by-name-only member in a closed
  world is flagged with what to do.
- **Add someone:** a search of identities that have signed in (owner-only,
  `access-directory`). A pick is added *by subject*, so it binds to exactly
  that person. If no match is found, "add by name" (for agents) explains that
  a person needs to sign in once. Role and time apply to the add.
- **Here now, not listed:** a button per verified person present, plus "add
  all", so an owner can keep everyone before closing. A typed-name joiner's
  button is disabled with the reason.
- **Non-owners** see the door, their own standing and time left, and the
  member list, with no controls.
- Data comes from the server (`access-state`), re-asked after every grant
  entry and presence change and repainted every 30 s for countdowns.
  Refusals show inline and as toasts.
- Driven end to end by `tools/access-panel-probe.mjs` (real browser,
  18 checks).

**Browser chat** (owner-gated by the server):
```
/access members | watch | visitors | open      /access   (show)
/grant bob builder for 2h     /grant bob visitor forever     /grant fable none
/revoke bob                   /members
```
Close code 4010 shows "you're not in X". The `notice` message shows as a
toast plus a chat line.

**Agents:** `world_access {action: show|mode|grant|revoke, mode?, id?, role?, for?}`.
The reply is the world's refusal, or the door as it now stands. The `worlds`
tool marks worlds as members-only or watch-only. An agent removed with 4010
stays down instead of reconnecting.

## Agent travel rules (built)

- **The world decides.** Before `travel` moves a body, and before a dial-time
  `?world=` attaches one, the door asks the sequencer `GET /access?world=X`
  as the agent. The answer is `{exists, you: enter|watch|none, found}`, for
  signed-in callers only. A refusal leaves the agent where it was ("isn't
  open to you" / "you may watch"). If the sequencer can't be asked, the door
  fails closed for a destination the agent chose.
- **The credential only narrows.** A `worlds` list (aid1 claim or tokens.json)
  keeps an agent to those worlds, and no list means no narrowing.
  `create: false` stops founding; anything else founds like any member
  (daily cap).
- **⚠️ On deploy, every credentialed agent can reach every open world.** Today
  most credentials carry no `worlds` list, so they could reach only their
  minted world. Owners should close what should be closed first.
- `tools/join-rfc005.test.ts` covers this (81 checks), including an owner
  agent closing a world with `world_access`, an outsider agent refused before
  moving, then let in by name.

## Left to do

- **Home node (operator config):** stop minting `claims.worlds` / `create` on
  id.animalabs.ai, since they now only narrow. `claims.world` stays as
  "default landing world".
- **Native Unreal client:** it parses roles itself (`EidoverseProtocol.cpp`,
  `EidoverseUIWorld.cpp`) and needs `none`/`spectator` and close code 4010
  before any world uses them.
- **Renderers' credential (deploy):** set `RENDERER_TOKEN` on the sequencer,
  and give it to the roaming renderers as their key. Until then roamers can
  serve open worlds only, and a snapshot asked in a members-only world says
  why.
- **Proxy timeout (deploy):** `GET /snap` now sets its own per-request timeout
  from the broker's longest wait, so Bun no longer resets a `/snap` that waits
  more than 10 s. But `deploy/nginx-show.conf`'s `location /` sets no
  `proxy_read_timeout`, so nginx's 60 s default still cuts any `/snap` that
  waits past 60 s. A roamed one can at the defaults, which allow 25 s for the
  roamer to arrive (`travelMs`) and 40 s for its first frame, and any one can
  once `SNAP_TIMEOUT_SEC` is above 60. Raise it to at least the broker's
  longest wait (see `SNAP_TIMEOUT_SEC` in `server/config.ts`).

## Review (independent, 2026-10-17)

An adversarial review reproduced three bypasses in the first cut, all fixed
with regression cases in `tools/access-test.ts` §5b:

- credentials carried across re-joins on one socket;
- a directory lookup returning another record's sub, which let a revoke
  delete an owner and open a closed world;
- a revoke that was accepted but did nothing.

Also adopted: name-keyed records don't admit people to closed worlds, the
granter sees the binding, scripts can't grant in closed worlds, outcome-based
guards, a 4011 retry for watching a not-yet-world, a spacing-tolerant log
prefilter, a 1 s sweep, and the agent's `/snap` carrying its credential.

## Follow-ups noticed

- A golden fixture for access (members-only, expiry, revoke) in `spec/fixtures/`.
- The browser recomputes its own rights without its sub (`state.js
  refreshMyRights`). For sub-bound grants this is wrong until the server's
  `your-rights` push lands right after. That push exists, so it self-corrects,
  but passing the sub would be cleaner.
- An idle world's first `/worlds` listing parses its whole `snapshot.json`
  once (it is cached after that).
- Pre-existing: `WORLD_ADMIN` matches display names as well as subs. Anyone
  listed there by *name* passes every access check under a typed name. List
  operators by sub.
- Inside a closed world, verb rights still honour name-keyed records. Entry
  doesn't, which is the boundary, but a member could gain a name-keyed
  builder grant by sharing that name.
