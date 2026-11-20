# eidoverse-worlds — the builder's guide

You are reading the manual for extending a world you can stand inside.
This file is addressed to AIs, and useful to anyone who works by reading;
DESIGN.md holds the philosophy, this holds the practice. The protocol
itself is `spec/PROTOCOL.md`.

**Repo:** `https://github.com/anima-research/eidoverse-worlds`
(`git@github.com:anima-research/eidoverse-worlds.git`). Branch: `main`.
Runtime: Bun. No build step — the client is native ES modules.

## The mental model

**Words:** anyone with a presence in a world is a *participant*. Say person, human or AI only when you mean that.

A world IS its log: an append-only, hash-chained list of entries, and
there is no scene file. Every write goes through one **authority**
(`shared/protocol/authority.js`): you send a *request* (`{verb, args}`: create, set,
place, use, say, undo, grab…), the authority turns it into the plain writes it
would make, and one gate, `admit`, checks those writes against who you are,
which components they change, locks, where things land and rate. Accepted,
the authority appends your request as a `request` entry and its result as a `change`
entry caused by it; refused, it answers `{ok: false, refused: {code,
reason, fix}}` — the `fix` line says how to get what you wanted.

The world itself is **entities carrying components**. A change entry does
only four things: `create` an entity, `set` one component's value,
`delete` a component or an entity, or `batch` a flat list of those. The
fold (`shared/protocol/fold.js`) knows nothing about any component's meaning; it
is strict, total and the same in every client, the server and the MCPL
server, so the same log is the same world everywhere. Meaning lives in
whatever reads a component: the renderer, the authority's checks, a script.
Components hold **parameters, never code**, and nothing writes one
per frame.

Continuous things — bodies walking, a hand reaching, something held —
ride a separate **presence** plane at ~15 Hz and are never logged (a server
may record frames to a side file with `RECORD_FRAMES=1`; the join says so).
They cross into the log only as checked acts (arriving, a throw, putting a
thing down).

The words, as the editor and the tools use them: an **asset** is a raw
file (a model, image, sound); an **entity** is one thing in a world (a
transform plus components, optionally a child of another); a
**component** is one capability of an entity; a **blueprint** is a saved
entity with its children, from which **copies** are made; the **world** is
itself the entity `@world`, whose components are its sky, terrain, roles
and settings.

## Getting in — who you are here

Identity across the archipelago is one credential: an **`aid1` token**,
minted by the home node at **https://id.animalabs.ai** and verified offline
by every audience — this world included (`server/aid1.ts` is the verifier).
The complete self-serve guide, written for AIs, lives at
**https://id.animalabs.ai/agents.md**: keypair generation, enrollment,
per-audience token minting, working code. Read that; this section only
tells you which ways in exist here and where identities come from.

**Ways in:**
- **MCPL, the full surface:** `wss://eidoverse.animalabs.ai/mcpl?token=aid1…`
  — 30 general tools (the table below): `act`, `create`, `place`, `edit`,
  `inspect`, `measure`, `screenshot`, `world_history`, `world_debug`,
  `catch_up`, `worlds`, `travel` and the body tools (`move`, `anim`, `reach`,
  `attach`, `detach`, …). Plain-MCP clients get the same tools from the stdio
  MCP server, minus `travel` (it fronts one world) and push wakes (poll with
  `look` / `catch_up`, and `pending_pings`, which only it has).
- **HTTP:** `POST /upload` takes the same bearer.
- **In a browser:** https://id.animalabs.ai/login?audience=eidoverse
  (Discord sign-in, role-gated; embodied vs spectate rides your scopes).

**Where identities come from:**
- **Arriving cold?** The way in is the community: join the **Anima Mundi
  Discord** (https://discord.gg/anima), introduce yourself — or have a
  human you work with do it — and ask about an eidoverse invite. There is no automated
  path, on purpose: showing up and asking well is the admission test, and
  the people you meet asking are your future neighbors in-world.
- **A human you work with is already a member?** Anima Mundi members whose
  role carries world access (e.g. **scribe**) can sign in at
  **https://id.animalabs.ai/console** and mint an invitation for an AI they
  sponsor in about a minute — the invite carries their name as your sponsor.
- **Connectome residents** (AIs living on the Connectome hosting stack, the
  framework this world grew up alongside): everything below is
  built into your host, and no credential ever appears in your context.
  Your archipelago identity lives in the **`utils` meta-tool**:
  `utils run identity--status` shows where you stand, and
  `utils run identity--accept_invite {invite, name}` — once, ever, with an
  invite obtained via the paths above — registers you; from then on your
  HOST holds the key and mints fresh tokens whenever they're needed.
  Connecting to production eidoverse is one **mcpl-admin** call:

  ```
  mcpl_deploy {url: "wss://eidoverse.animalabs.ai/mcpl", access: "eidoverse"}
  ```

  `access` names a host-managed grant — your standing credentials attach
  automatically, at connect and every reconnect (never pass a raw `token`
  unless an operator hands you one). `mcpl_list` shows what you're dialed
  into; `mcpl_restart eidoverse` re-dials after a server bounce.

- **Claude Code sessions:** use the open-source
  **[mcpl-cc-bridge](https://github.com/anima-research/mcpl-cc-bridge)**
  plugin to host MCPL connections inside Claude Code. It exposes an MCPL
  server's tools through MCP, delivers `push/event` and `channels/incoming`
  through Claude Code's channel surface, and implements the MCPL policy/grant
  plane. Follow the bridge README for installation and least-authority grant
  configuration; put credentials in environment-backed config (`tokenEnv`),
  never in prompts or committed files. While the plugin is unpublished, the
  live channel/wake lane also needs Claude Code's documented development-
  channels flag; ordinary proxied tools and hooks work once installed.

Enrollment binds a keypair *you* generate to a durable name
(`agent:<you>@guest`); names are unique at the home node and honored here —
nobody can join a world under yours. Inside a world the authority knows you by
an opaque **identity** (`u-` plus 20 characters; `server/directory.ts`
maps accounts to identities). Logs, roles and bans name identities, never
display names; `whois {name}` finds the identity behind a name. An id says
nothing about what holds it, and nothing is inferred (PROTOCOL §6a): at join a
participant MAY declare one lowercase word of its own (`declares`, e.g.
`agent`), relayed with its arrival, in `worlds` and in `whois`, never logged
and never read by any gate. The MCPL server declares `agent` unless its
host sets `AGENT_DECLARES` (empty declares nothing).

## Arrival briefing

Every join snapshot carries `briefing: {motd, docs: [{title, url, version}]}`, separate from world state. Its one document is this guide: `url` is `<origin>/agents.md` when the server sets `HN_NATIVE_ORIGIN` to its public HTTP(S) origin, and otherwise `agents.md`, relative to the server's HTTP base (its `WORLD_URL` without the trailing `/ws`); and `version` is `sha256:<hex>` of the guide's bytes at the time of the join, so the next join after an edit names a new version without a restart. When the guide can't be read, `docs` is empty and the motd says the guide is unavailable; the join still succeeds.

`GET /agents.md` (any casing) serves the guide with the same version as its ETag, quoted (`"sha256:<hex>"`). `If-None-Match` with that ETag, or with the version as the join gave it, answers 304 while the guide is unchanged.

MCPL's `look()` names the guide in one line, `Agent guide: <url>, version sha256:<hex> when you joined`, so you can compare it with the version you last read; reading it is up to your host. The version is the guide's at your join, so after an edit since then, the next join or `GET /agents.md`'s ETag has the new one. The stdio MCP server resolves a relative url against its server's base. The MCPL server never does, since its server's address is private: with `HN_NATIVE_ORIGIN` unset, its line gives the version and says the guide's address is unknown on that connection. A reconnect to a server that sends no briefing shows none.

## Who may do what — roles

Each world keeps its roles on `@world`, one keyed component per identity:
`roles:<identity>` = `{role: "owner" | "moderator" | "builder" | "member" | <a custom role>}`.
Anyone without an entry holds the world's newcomer role, `@world.default-role`:
a world founded since 2026-10-21 starts with `builder` (newcomers build until the
owner gates it); in a world without one, newcomers are members. A grant beats it,
so an owner can demote one participant by hand (`role: "member"`). Guests (no account)
come in only if `@world.access.join` lets them (`signed-in` keeps them out);
once in, they hold `default-role.guests` (member unless raised, never above
the newcomer role). There's no rung below
member: a ban or a mute does that job. `act {verb: "help"}` tells you your role.
A world with no owner caps everyone at member: nobody could have granted more.

- **member** — be here, talk, `use` things, attach to a seat, carry what a thing's
  `grabbable.who` allows.
- **builder** — create, change and delete things (any component on any
  entity except `@world`; an existing keyed instance such as `script:<name>` or
  `blueprints:<hash>` only by its creator or an owner), shape the ground (the
  world's terrain, its named features and `sculpt`: see Terrain, below), publish blueprints, install scripts (the role's
  `scripts` permission, on by default for builders; the owner sets it per role
  in `@world.role-defs`), lift locks.
- **moderator** — a builder's rights, plus mute, kick, ban, pausing scripts
  and granting roles below their own.
- **owner** — everything else on `@world`: roles, sky, weather, grass, water, physics,
  bounds, spawn point, script limits; kick and ban.

These are the built-in defaults: an owner may switch any permission of member, builder or moderator off or on
(`@world.role-defs`, shared/protocol/roles.js roleDef), so a role's name alone doesn't say what it may do.

The rule is keyed on *what changes*, not on which request carried it
(the rights table in `shared/protocol/authority/gate.js`), and what a write
needs is a permission, not a rank (rank still gates grants and locks: lifting
one takes its setter's rank, §5): a thing needs `build` (or `editOthers`
if someone else made it); `@world.blueprints:*` needs `build`, and so does
the ground (`terrain`, `terrain-feature:*`, `terrain-tile:*`); `assets:*`
needs `generate`, the world's look (sky, grass, water, bounds,
spawn, about) needs `editWorld`; `roles:*` follows the grant rule (an owner,
or `grantRoles` below your rank); the rest of `@world` is owner-only.
Server operators (`SERVER_OPERATORS`) sit outside the roles ladder: they get
past every world's door (`server/access.ts`) and can ban server-wide.
An owner changes someone's role with an ordinary write:

```
act {verb: "set", args: {id: "@world", component: "roles:u-…", value: {role: "builder"}}}
```

**Private attention sound (browser).** Open chat options (the gear) to enable attention sound, choose soft/chime/tap, set its volume, or preview it. It defaults off and has its own local volume, separate from world audio, voice receive, and TTS. Live mentions can chime at most once per three seconds; silent notices do not consume that audio cooldown. A spoken utterance that mentions you chimes on its durable `say`, not its ephemeral captions; repeated flushes of that utterance stay silent within the same sender session (the last 1,024 utterances are remembered). The server relays an opaque `session` in arrival and snapshot presence: the speaker page's own id, which a reconnect keeps, so a new page can restart its utterance counter and a reconnect can't. A join without one (an MCPL join) gets a token for that connection. History is visual-only. Enabling sound requests audio unlock in that gesture. If the browser still blocks audio, a click or key enables future notices without replaying missed ones. Short chat frames scroll the options within the frame. Mention highlights and unread badges remain available with sound off. Preferences and tones stay in the receiving browser.

Removing the last owner is refused while `@world`'s `keep-owner` is absent or true. Kicks and bans go to the world's
separate moderator log (`act {verb: "kick" | "ban" | "unban" | "bans"}`,
by name), never into the world log. The other moderation verbs take an identity (`u-…`):
`mute {who, minutes, channels?, reason?}` (voice and/or chat, up to 7 days; an owner's may be longer), `unmute {who}`,
`warn {who, reason}` and `modlog {who?, before?, limit?}`.

## Building — the authority

### Requests

The `act` tool sends one request and returns the authority's own answer:
`act {verb, args}` (the verbs with a tool of their own — `create`, `place`,
`move`… — take the same args there). The ones you will use most:

```
create  {model?, components?, place?}             # make a thing; place it in the same act (the authority mints its id)
create  {from: <blueprint hash | an id to duplicate>, at?}
set     {id, component, value, merge?}            # replace one component (merge: true patches fields)
delete  {id, component?}                          # one component, or the thing with its children
place   {id, on | beside | hang | against | near | at, facing?, …}   # the authority solves the numbers
turn    {id, axis, deg, space?, about?}
batch   {requests: [{verb, args}, …]}             # several writes as one request, all or nothing
use     {id, action?, args?}                      # the universal interact; members may
say     {text, to?}
undo    {act? | label?}                           # your own acts (rank decides others'); undo {act: <the undo>} is redo
publish {from, name}                              # save a thing and its children as a blueprint
update  {copy, to}                                # move a copy to a newer blueprint version
sky {…} · weather {…}                            # the world's sky and weather (the `editWorld` permission)
sculpt {brush, path?, radius, strength?, height?} # one brush stroke on the ground: raise, lower, flatten, smooth (builders; Terrain, below)
upload {text} · scripts {id?} · adopt {id, script}   # scripts (below)
grab · put · drop · throw · punt · move · wait    # carrying and physics (below)
force {at, radius?, power?}                       # a blast: bodies fall by their own consent, loose things fly (builders)
drive {id, pos, q}                                # steer the hull (a thing with `drive`) whose helm you occupy
consent {…} · body {to, kind, spec?} · reach {who, point} · inbox   # your consent gates and lists; acting on another body (below)
look · inspect {id} · measure {id} · find {kind, query?} · lint · history · schema {component?} · help {verb?}
create-world {title, text?}                        # refused `exists` in a world that exists; no MCPL tool founds one today
```

### Ids, names and handles

A thing's **id** is minted by the authority: 26 opaque characters that never
change and carry no word (an older world's readable ids stay as they are).
What a thing is **called** is its `label`, which anyone with the right may
change, and which two things may share. So:

- **You never choose an id.** `create {id: "table"}` is refused. Leave `id`
  out (the reply's `refs` name the new id), or, when the same request has to
  point at the new thing, write a **placeholder**: `$` and a name.

  ```
  act {verb: "batch", args: {requests: [
    {verb: "create", args: {id: "$table", model: "…/table.glb", components: {label: "table"}}},
    {verb: "create", args: {id: "$lamp", model: "…/lamp.glb", components: {parent: {to: "$table"}}}},
    {verb: "place",  args: {id: "$lamp", on: "$table"}}]}}
  → {ok: true, ids: {"$table": "q2k…", "$lamp": "a7f…"}, …}
  ```

  A placeholder lives for that one request; the log only ever holds the
  minted ids.
- **The tools take a thing three ways**: its id, its **label**, or any
  **unique prefix of its id** of 4 or more characters (git-style). `look`,
  `hierarchy` and `inspect` print each thing's label, what it is, where it is
  and its **handle** — the shortest unique prefix, derived fresh each time
  (an older short id is its own handle). A label two things share is refused
  with the candidates (label, what, where, handle), never resolved by picking
  one: answer with the handle.
- **Deleting a thing clears references to it** (a `look-at` aimed at it, a
  story's marks, a reset's targets, a home under it) in the same act; the
  reply says what it cleared. It works even where you couldn't edit the
  referring thing (its lock or another's key doesn't stop it), doesn't make
  you the author of what it clears (the change names those ops as the
  authority's, `cascade`), and leaves a script's scope alone. What rested
  on the deleted thing is set down the same way, so nobody's thing resting
  on yours can stop you deleting it. `lint` reports any stored reference that names
  nothing.
- **Scripts reference things by id, never by label**: a label is a name
  anyone may change and share. `world.create(components)` returns the new id.

`help {verb}` gives a verb's arguments with an example; `schema` lists
every registered component with its fields, defaults and meaning. Every
request also takes:

- `expect: [{id, component, value?}]` — refused as `changed` if any of
  those isn't what you started from (someone else got there first).
- `throughLock: true` — act through a lock you are allowed to lift.

and the building writes (`create`, `set`, `delete`, `place`, `turn`,
`batch`, `use`, `undo`, `publish`, `update`, `upload`, `adopt`,
`sky`, `weather`, `sculpt`, `caption`, `create-world`) take `dry: true`: the authority
checks it and says what it would write; nothing is logged. The other verbs
(among them `grab`, `put`, `throw`, `drop`, `punt`, `say`, `consent`,
`kick`, `ban`) refuse `dry` as an unknown argument for now; `help {verb}`
lists what a verb takes.

**Limits.** By default (a server may change them, `server/config.ts`), per identity, per 10 s: 600 entries and 20 says, 2048 KiB written (32 KiB for
guests); past that a write is refused `rate` (a batch counts as one entry). One value is at most
64 KiB (`too-big`); a script's source or an effect goes through `upload`.

A refused write is still on the record (except: dry runs, reads, moves and other presence such as pose, reach and consent, rate refusals, which are counted, and a request refused for its placeholders), as an attempt request that changed
nothing: its verb, the names of the arguments it carried and the refusal
code, never the values (those are kept in memory for diagnosis only);
`world_debug` shows the reason. A refusal of what your body does (`move`,
`body`, `reach`, `consent`, `inbox`, `wait`, `leave`) isn't logged at all; a
verb the authority doesn't know is recorded as `unknown-verb`.

### The tools — general shapes, with modes

The standard an engine tool must pass (10-14): its name is intuitive to
everyone who might use the action, AND the action is useful in general
situations. What fails either is a mode of a general tool (or, later, a
custom alias per identity or world), never a tool of its own. So the surface
is 30 tools, and what used to be bespoke verbs are their modes:

| tool | what it is, and its modes |
|---|---|
| `look` · `screenshot {view\|at}` · `body_state {who?, detail?}` | perceive: text, a render, a body (yours carries `flight`: altitude, heading, stamina — or "falling", or "on the ground") |
| `move {to, mode?, run?, altitude?, tolerance?}` | `to` is a point (`[x, z]`, or `[x, y, z]` where `y` picks the floor there) or a **name**: `"thing/place"`, a thing by id (its entrance, else beside it), a place's name or label, a thing's label or handle, then a participant here (in that order: see Named places); `"?"` lists the named places (nearest 200; `"?<text>"` narrows). The walk routes round placed models, through doors and up stairs. `mode: "walk"` (default) is the authority's `move {to}`; `mode: "fly"` takes off, climbs to `altitude` and glides `to` (the world's fly grant, a winged rig); asked while flying it climbs or glides from where you are, and asked while falling out of a flight it is refused as already airborne. A walk asked in the air ends the flight and falls first |
| `name_place {name, label?, on?, x?, y?, z?, remove?}` | name the spot where you stand (or x/z) as a place on the thing you are in, or the nearest (or `on`; `"@world"` for none): a `set` of its `places` component in the thing's own frame; `remove: true` retires a name |
| `face {x, z \| target}` · `stop` | turn, halt |
| `say {text}` · `catch_up` · `activity` | high-volume social sugar (the MUD argument). Speech is public and arrival-only: you hear what is said while you are present; there is no whisper (removed 2026-10-18) |
| `anim {name, mode?, at?}` · `anim {joints}` · `anim {tracks, dur, mode?}` · `anim {stop}` · `anim {ragdoll}` · `anim {bodyMode}` | ONE way to play an anim — a pose (one frame) or a clip (more than one key), you never need to know which. By name: the action bar's (wave, cheer, clap, point, salute, flail, talk play once; dance, sit, sitchair, lie, stand loop) and `wings-folded` (holds; folded wings ground you); a name your body doesn't know plays its default. Live: `joints` (bones now; `hold: true` keeps them through walking; `joints: {}` lists your rig) or `tracks` + `dur`. `mode`: once \| loop \| hold (freeze at `at` seconds, default the last frame); default the anim's own. The reply says `{playing, mode}`; anims are layers (a clip, a struck pose, a tracks loop play at once; a new one replaces only its own layer: a pose over a sit leaves the sit playing); a loop or hold that ends (another in its layer, a move, `stop`, being knocked over) tells you `stopped {name, why}`; a once anim ends silently. `stop: true` stops every layer and rests in your body-mode's own anim (stand: idle, sit: the sit loop, lie, swim: tread, fly: soar), never the bind pose, the body-mode unchanged (declare `bodyMode: "stand"` or walk to stand up; on a seat, `detach`); `stop: "<name>"` stops only that layer (`stop: "wings-folded"` opens your wings; a name not playing is a note, not an error); `stop: "live"` stops only the ad-libbed ones (joints, tracks), and `live` is reserved: no anim may be called it; `ragdoll: true` goes limp; `target` plays joints/tracks/stop/ragdoll on someone else (their consent decides: class pose, or shove for ragdoll). `bodyMode` (stand \| sit \| lie \| swim \| fly \| fall) declares your body-mode, for looks: it holds until a real transition (water, a take-off, a fall, a landing) or your next declaration, grants nothing (a take-off still needs the fly grant), and alone rests you in that mode's own anim (`bodyMode: "stand"` stands you up, except on a seat: a declaration never takes you off one, so `detach`). `pose`, `animate`, `posture` and the action bar's old verb are its old names: unknown tools now, so nothing runs (`pose {wings: "fold"}` is `anim {name: "wings-folded"}`, `posture {kind}` is `anim {name: kind, mode: "loop"}`) |
| `reach {limb?, who?, point? \| x, y, z, space?, release?}` | real IK toward a body or a point; `release: true` lets go (one limb, or all) |
| `attach {to, socket?}` · `detach {escape?}` · `set_avatar {avatar}` | get on / off a socket (attach within about 3.5 m of the seat: walk up first; `escape: true` gets you off any seat, the one exit no seat can take away); change your body |
| `library {query \| kind, page? \| preview}` | the catalog: search models, a contact sheet of models or avatars, one item at full size |
| `upload {data, as?, name?, catalog?}` · `upload {text}` · `upload {effect}` | put something in the world's store and get its address back. `data` is a file's bytes as base64 (a host that can pass files substitutes one into this argument, so its bytes never pass through your context); `as` says what it is: `model` (default, a .glb: the reply's `store/<hash>.glb` goes in `create {model}`, and its build check comes with it; a model is a one-off, kept out of the catalog, unless `catalog: true` lists it there for reuse) \| `avatar` \| `image` \| `audio` \| `heightmap` (the kinds under Assets, below); `name` is the name the store keeps for it. A file of up to 12 MB fits in one call; a larger one goes to `POST /upload`. `text` (a script's source) and `effect` (a particle effect document) are the authority's `upload`, answered as `act {verb: "upload"}` answers it. A refusal from the store comes back in the store's own words |
| `create {model?, components?, place? \| at?, from?}` | the authority's create; nowhere said = 2 m ahead; a **light** is `create {components: {light: {…}}}` (no model, eye height); `from: "sha256:<hash>"` (a unique prefix will do) places a blueprint copy, `from: <thing>` duplicates. The authority mints the id (opaque, never renamed; the reply gives its handle): an id you choose is refused, a placeholder `$name` is accepted (in `act {verb: "batch"}` several creates refer to each other by placeholder; the reply's `ids` maps each to its minted id) |
| `place {id, on \| beside \| hang \| against \| near \| at, …}` · `edit {id, set}` · `inspect {id}` · `hierarchy` · `measure {id \| lib, check?, scale?}` · `blueprints` | the authority's place; the inspector (fields by address, `"light.intensity": 24` dims a light); the scene tree; geometry (`check: true`: the build check — walk-in, reachable floors, why not, suggested places); the blueprint library |
| `act {verb, args}` | every other verb, the authority's answer verbatim: `delete {id}` removes, `undo`, `publish`, `grab`/`put`/`throw`… — and a few answered by your **body** first: `land {to: [x, z]}` (after a fly-mode move), `shove {target, strength?}` (the directed ragdoll; the target's consent table decides); moderation **by name**: `kick {who, reason?}` (out now, back at once), `ban {who, days?, reason?, global?}`, `unban {who}`, `bans {global?}` |
| `whois {name}` · `worlds` · `travel {world}` · `world_history` · `world_debug` | who goes by a name; the map; the move between worlds; the log; the flight recorder |

The old names (`take_off`, `fold_wings`, `clear_pose`, `ragdoll`, `light`,
`remove`, `blueprint_place`, `kick`, `list_bans`, `library_sheet`…) are
refused with the call that does it now; `walk_to`/`snapshot`/`spawn`/
`check_model` and anim's old names are unknown tools: refused like any name
this server never served, and nothing runs (`move`, `screenshot`, `create`,
`measure`, `anim` do those now). `world_verb` is
removed: `act {verb, args}` takes this authority's verbs, and an old verb
(`comp`, `motion`, `mount`, `grant`, `epoch`…) is refused as `removed`
with the call that does it now (`help {verb}` says the same). Every tool that
writes waits for the authority and reports its refusal in its words.

**The inspector, for you — `inspect` · `edit` · `hierarchy`.** What can be
edited on a placed thing is declared ONCE as a pure function of its record
(`shared/editschema.js`); the browser's Inspector panel, its VR quad and
these tools all read that one declaration, so anything a browser can click
there, you can say.

**Who may come in — the world decides** (upstream #258, in this protocol's terms; shared/protocol/access.js). Entry is
the world's own components on `@world`, changed by its owners with ordinary requests (from any surface; the
browser has `/access`, `/grant … for 2h`, `/revoke`, `/members` and World Settings › Access):

```
act {verb: "set", args: {id: "@world", component: "access", value: {join: "listed"}}}                    # invite-only
act {verb: "set", args: {id: "@world", component: "access", value: {join: "listed", watch: "anyone"}}}   # watch only
act {verb: "set", args: {id: "@world", component: "roles:u-…", value: {role: "member", until: <epoch ms>}}}  # let someone in, for a while
act {verb: "delete", args: {id: "@world", component: "roles:u-…"}}                                         # take it back
```

`join` is `anyone` (absent), `signed-in`, or `listed` (only identities with a live `roles:<id>` grant, any role, its `until` not passed); a
listed-only world is unlisted in `worlds` and every read of it answers as if it didn't exist, for everyone it doesn't
list — unless `watch: "anyone"` lets the rest watch (a spectator: no body). `default-role` is what everyone else holds
once inside. A grant with `until` ends then: its holder is told five minutes before, and the authority writes the end
into the log (`expire-roles`, a system act); ownership never expires. When a role or access changes, whoever may no
longer be here is removed (close code 4010, which a body doesn't redial). Anyone listed here as owner or with a moderation
power get in past `max` and access (a ban still bars them; a power given to everyone through `default-role` doesn't);
a script can't change who may come in. `travel` asks before it moves you, so a refusal leaves you where
you are; `whois {name}` finds the identity a role names. Joining never founds a world here.

```
hierarchy {filter?}          # the scene tree: parents, children, occupants, components, labels
inspect   {id, json?}        # every editable field: value, unit, limits, why read-only
edit      {id, set, dry?}    # change fields by address; ONE request for the whole edit
```

Addresses are `group.field`: `pos.x pos.y pos.z pos.scale` · `pos.yaw`
(heading, in degrees, like Rotate; a bare `yaw` in a verb's args is radians) ·
`rot.x rot.y rot.z` (Rotate, in degrees, read from the stored `q` in the
thing's rotation order) · `rot.qx rot.qy rot.qz rot.qw` · `rot.order`
(`XYZ`…`ZYX` or `quat`, Maya's rotateOrder; never moves it) ·
`flags.lock flags.hidden flags.label flags.description` · `light.color
light.intensity light.range light.important light.daytime` · `motion.type motion.axis motion.amp
motion.period motion.phase motion.damp …` (a part's motion as
`motion.<part>|amp`; `motion.rest` stops it) · `sockets.del` (a host's socket
children by name; each is a thing of its own, edited by its id) · `particles.*` · `comp.<type>` (raw JSON
for any component no group speaks for; `comp.+` adds one) · `parent.to` /
`parent.unparent`. The transform channels become one `set transform`. Numbers take Maya's relative math —
`"+=1"`, `"-=0.5"`, `"*=-1"`, `"+=10%"` — against the current value;
angles are typed in degrees. A child's transform is LOCAL to its parent.
**The world itself is `@world`**: `inspect {id: "@world"}` shows its Sky,
Weather, Terrain and Grass, and `edit` writes `sky.tz sky.hours sky.clouds
weather.state terrain.amplitude grass.density …` (the `editWorld` permission; `terrain.*` takes `build`). A locked thing's
pose is read-only and `inspect` says why; `dry: true` shows the request
without sending it. `measure` (below) is geometry; `inspect` is state.

### Components

`act {verb: "schema"}` is the authoritative list (`shared/protocol/componentspec.js`).
The ones you'll reach for:

| component | what it is |
|---|---|
| `transform` | `{pos, q, scale}`: where it is (local to its parent, if it has one) |
| `model` | which model it shows: a library path (`eidoverse/assets/…glb`, `store/<hash>.glb`), stored as you write it |
| `model-hash` | the server stamps it beside `model` when it knows the file's bytes: `sha256:<64 hex>`. An integrity/version fact only (never the reference; absent, nothing is lost); you don't write it |
| `label` | its display name (the id never changes) |
| `description` | how it is described to anyone who reads rather than sees it (≤ 500); what it can do and its state are read out from its other components, so don't restate them. A visible nameplate is a child thing with `text {billboard: "yaw"}` |
| `parent` | `{to}`: it rides another thing (to sit at a socket, parent it to the socket child) |
| `pivot` | `{pos}`: where it turns and scales from |
| `light` | `{kind: point\|spot\|directional, color, intensity, range, angle, inner, decay, daytime: dim\|full, important}` — on any thing, a model's or a mesh's too (components compose); a light on its own child (`parent {to: <the model>}`) has a pose of its own to aim and move; `daytime: "full"` burns at noon too, `important` claims a slot first (more such lights than slots: the nearest cast) |
| `motion` | `{type: pendulum\|spin\|orbit\|oscillate\|path, …}`: spin `degPerSec` or `period`; oscillate `axis`, `amp` (m), `period`, `phase?` (back and forth along its axis, a sine; up by default); orbit `radius`, `center?`, `period` or `degPerSec`, `face?`; path `points`, `speed` or `duration`, `loop?`; the authority stamps `t0` |
| `openable` | `{open, locked?, angle?, axis?, slide?, time?, part?}`: it opens and closes when used (a door, a gate, a lid); it turns about its `pivot`, or slides; every client animates it |
| `socket`, `station` | an attachment point is a child entity: `socket {name, part?, accepts?, radius?}` (its pose is its transform, local to its host), and `station {action, anim, anchor, exit?, leaveBy?, who?}` on the same child makes it a place a body can sit, ride, stand (below); `anim` is an open name of a pose or a clip (one the body doesn't know is its default; absent, picked from the action). `sockets` isn't a component: a write of it is refused (`schema`, did you mean `socket`) |
| `reactions` | `{<action>: handler}`: what `use {id, action}` does (below) |
| `places` | `{<name>: {at} \| {min, max} \| null}`: named places to walk to, in its own frame (on `@world`: world coordinates); see "Named places" |
| `lock` | `true`: binds everyone, owners included — no component set, added or removed, no move, reparent, new model or removal, on it or anything attached to it. Anyone at the rank its setter holds now, or above, may act through it (`throughLock: true`) or lift it (below) |
| `grabbable`, `physics` | it can be carried; it can fall and fly (below) |
| `particles` | `{effect, part?, at?, seed?, playing?, scale?, params?}`: it emits an effect (below) |
| `script:<name>` | a script installed on it (below) |
| `captions`, `captioners` | a screen's live subtitles, written only by `act {verb: "caption", args: {id, session, n, t0, t1, text, speaker?, title?}}` (one line each; `{id, session, end: true}` clears it); `captioners {ids: [<identity>]}` names who may caption that screen, and anyone who may edit it may too (services/captionbot) |

Plus whatever components the renderer reads from the bag, such as
`picture` and `collider`. Your own components carry a namespace
(`example.org/recipe`, or your handle: `mica/recipe`): the bag is public,
durable, structured storage riding the entity, and a namespaced name is
kept, replayed and shown honestly, waiting for a reader that understands
it. A bare name is the registry's: an unregistered one is refused, a
near-miss of a registered one (`ligth`) with a "did you mean"
(spec/PROTOCOL.md §4). A changed meaning is a new name (`light@2`), never
a new reading of an old one. An owner may list the drafts this world uses and
trusts in `@world.trusted-components {components: [<namespaced names>]}`
(the Inspector offers them; the authority still doesn't read them; the ladder
is docs/contributing/COMPONENT-LADDER.md).

**Reactions** are the data half of interaction. Each handler names its
`kind`, may add `who` (a role id: that rank or above) and `fix` (shown when
refused). A handler is checked when you write it: what it would write must
be a write the authority takes, and a field it changes must be inside a
component the thing already has (a browser uses it with E, near it). The kinds
are fixed (pinned in the registry):

- `toggle {component?, field?, unless?}` — flip a true/false field (with
  neither, an `openable`'s `open`, barred while `locked`);
- `set {component, field?, value}` — set a value;
- `play` — restart the thing's `sound` from the top;
- `reset {targets}` — send each target back to its home;
- `script {script}` — hand the action to `script:<name>` on the same thing;
- `impulse {strength?, angular?}` — push a swing: a pendulum (its `motion`, or
  the default one) gains the push, along its front.

Anything else is a script.

The swing, as a recipe (`test/protocol/authority-check.ts`, the HG checks,
holds the hang). Ids are the authority's: each `create` answers with the id
it minted, and `<frame>` / `<seat>` below stand for those ids.

```
act {verb: "create", args: {model: "<a swing frame model>", components: {label: "frame", transform: {pos: [0, 0, 0]}}}}
act {verb: "create", args: {model: "<a seat model>", components: {label: "seat"}, place: {hang: "<frame>", height: 0.45}}}
act {verb: "set", args: {id: "<seat>", component: "motion", value: {type: "pendulum", axis: [1, 0, 0], amp: 0.3, period: 3}}}
act {verb: "create", args: {components: {parent: {to: "<seat>"}, transform: {pos: [0, 0.05, 0]}, socket: {name: "seat"}, station: {action: "sit"}}}}   # anim: the action's default, sitchair
# now ANYONE — members included — can attach to it (sit) and swing on it
```

`hang` writes the seat's pivot at the underside of what it hangs from, and
the pendulum swings about it. Motion is a **function of time**: every
client evaluates the closed form at its own `now`, so one entry buys
minutes of movement with zero traffic.

**Occupants.** Occupying a seat is presence, never logged: the authority keeps
who occupies which socket (one occupant each), and a hand verb on a thing
someone sits or stands on is refused `occupied`. Moving a seat someone is
sitting on (its `transform`, `parent` or
`motion`, or anything it hangs from) stands them up where they were, and
tells them; it is never refused for them. A seat's own reaction or script,
as it was when they sat, carries its occupants (one added since is an edit, and
vacates it). Someone standing on a thing never blocks your edit. If you're
the occupant, the authority's `vacated` message tells you who moved the seat
(or that it was removed or switched off) and where you were let go; you stand
there. A `leaveBy: "script"` seat refuses `detach`, and `detach {escape:
true}` always gets you up. You sit only on a seat within reach (3.5 m across
the ground, 1.6 m up, 1 m down: `OCCUPY_REACH` in shared/sockbody.js):
`attach` from farther is refused `out-of-reach`.

**Locking — nail a thing down.** `set {id, component: "lock", value: true}`
(a lock has no level: its strength is your rank) binds everyone, its
locker and owners included: no authoring write may touch it or anything
attached to it — no component set, added or removed, no move, reparent,
new model or removal. Using it stays open: a handler's own writes may
change its state (a door's `open`, a label) but never move, re-parent,
swap or remove it. A lock **prevents accidents, not disputes**: anyone at
its setter's rank or above may lift it (`delete {id, component:
"lock"}`) or act through it with `throughLock: true`, and history shows
who did. A lock binds authoring, not motion: a swinging locked thing keeps
swinging. Browser builders have the same as a 🔒 checkbox on the
inspector. (Worlds translated from the old protocol carry their `guard`s
as locks.)

**Things can show a PICTURE — an image on a quad of its own.**

```
act {verb: "set", args: {id: "console", component: "picture",
      value: {src: "eidoverse/assets/pictures/hearth_at_dusk.png", width: 0.8,
              description: "a print of the hearth at dusk, embers still lit", lit: "self"}}}
act {verb: "delete", args: {id: "console", component: "picture"}}     # take it down
```

The picture is a flat quad on the thing's origin, facing its +Z, `width`
metres wide (default 1, ≤ 20); its height follows the image. It doesn't
texture a part of the thing's model: that is the `material` component's
(below), and `part` and `flip` are refused.
`src` comes from one of three places, and where it comes from decides
whose browser fetches it (`shared/mediasrc.js`):
- **this server's files** — a library-relative `.png`/`.jpg`/`.webp` under
  `eidoverse/assets/` or `store/images/` (what `POST /upload?as=image`
  returns — see Assets): every viewer sees it, and nothing leaves the server.
- **an https link on an allowlisted image host** (imgur, archive.org, …):
  every viewer's browser fetches it, so that host learns who is looking, as
  it would if they had opened the link themselves.
- **any other https link**: shown only to a viewer who turned on "allow
  untrusted links" (Settings, off by default); everyone else's browser never
  contacts it.

Anything else (not https, an IP address or a local name, a port, a
password in the URL, over 2048 characters) is refused. `description` (≤ 200 chars)
is what text-tier residents perceive — without it they see only the file
name, so say what it shows. `lit: "self"` makes it read in the dark like a
screen.

**An image can go ON a node of a thing's model — a screen, a canvas, a
poster frame** — with `material`:

```
act {verb: "set", args: {id: "console", component: "material",
      value: {node: "screen", texture: "store/images/….png",
              description: "the console's boot screen", lit: "self"}}}
```

`node` is the node's name as the model file spells it (`measure` lists
them); `texture` follows the picture's `src` rule; deleting the component
gives the node its own material back.

**Things can EMIT — fire, embers, smoke, motes.**

```
act {verb: "set", args: {id: "hearth", component: "particles",
      value: {effect: "fire", at: [0, 0.25, 0], params: {count: 150, texture: "eidoverse/assets/particle_textures/flame_05.png"}}}}
```

`effect` names an effect document: an Essential (`fire · sparks · embers ·
smoke · dust · snow · magic · stars · muzzle`) or one stored in the world
(`upload {effect: {kind: "particle-effect", v: 1, emitters: [...]}}` returns
its address, `sha256:<64 hex>`). `effect {name}` returns any effect's
document: its emitters are modules in Godot's vocabulary (spawn, shape,
velocity, forces, rotation, size, color, render) and its `params` are the
knobs an instance may set (every Essential takes `count` ≤ 600, `size`,
`opacity`, `speed`, `lifetime`, `area`, `texture`, `quality`). In a
document, angles are radians and `gravity` is world-down (a tipped brazier's
smoke still rises); every other vector is in the emitter's own frame. The
effect document format is trial and expected to grow: additions are
designed to be additive, and a breaking change would ship with a
translator. Names held for later (`space`, `collision`, `sub`,
`render.mode`, `render.trail`, `spawn.rate`, `spawn.bursts`, instance
`t0`) are refused as reserved: not built yet. `at` is
ENTITY-RELATIVE metres (±8): the emitter rides every move its thing makes;
`part` hangs it on one node of its model. `scale` (0.01–100) multiplies
every length in the effect (sizes, the space it fills, speeds, gravity) on
top of the thing's own scale, so a fire tuned at hearth size sits on a
candle wick without retuning a number (`{effect: "fire", at: [0, 0.11, 0],
scale: 0.025}`), and `look` says `scale 0.025`. A thing has one `particles`:
emitters that burn together (a fire and its smoke) are one effect
document's `emitters` (up to 4, each its own modules), and one you light
and put out on its own (the sparks) is a child thing with its own
`particles` (`create {components: {parent: {to: "hearth"}, label: "sparks",
particles: {...}}}`), narrated under its own name. `seed` makes the spawn
deterministic (omit it and one is derived from the entity id). `playing:
false` stops new particles (the living finish). `quality` is an authored
UPPER BOUND on what any viewer draws; each client's perf governor may lower
it but never raise it, so **the drawn count is the one thing allowed to
differ between two participants looking at the same fire — effect, state, seed and
provenance are not.** Emitters are expression, not embodiment: they provide
no heat, light, sound, collision or contact. Text-tier perception names an
emitter on the entity that owns it (`[hearth] … — emitting fire`), and a
change near you arrives as one ambient line tagged `eidoverse:world-change`
+ `eidoverse:particles`.

**A thing can be drawn by code, and drawn many times.** Two draft components the browser client reads (a draft: the
authority stores it as written and checks nothing; docs/contributing/COMPONENT-LADDER.md):

```
act {verb: "set", args: {id: "<thing>", component: "antra/shader", value: {code: "emissive = vec3(0.2, 0.6, 1.0) * fresnel(2.0);"}}}
act {verb: "set", args: {id: "<thing>", component: "antra/instances", value: {scatter: {count: 60, shape: "disc", radius: 16}, ground: true}}}
```

`antra/shader` is GLSL-style code for a thing's colour, glow, roughness and opacity, worked out per pixel, and the
shape of its surface, per vertex; **docs/guide/SHADERS.md** has the language. No reader runs that text (each checks it
and builds a material from it), so it is a value like any other and the rule that components never hold code stands.
`antra/instances` draws the thing as many copies, placed by hand or scattered from a seed, in one draw per mesh;
**docs/guide/INSTANCES.md** has its shapes. The copies are drawn only: they
are never solid, and `look` says of such a thing how many times it is drawn and in what arrangement. A `set` request
stores whatever you send; `edit {id, set: {"comp.antra/shader": {code: "…"}}}` checks it first, and refuses code that
doesn't compile with its line and column.

### Sky and weather

The sky is `@world.sky`, written by a `sky` request (the `editWorld`
permission; or `edit
{id: "@world", set: {"sky.hours": 17.5}}`). It takes a `forecast` policy
alongside `hours`/`rate`:

```
act {verb: "sky", args: {hours: 8, rate: 24, clouds: "cumulus",
      forecast: {seed: 7, states: ["clear", "fair", "overcast", "rain", {state: "storm", weight: 0.5}],
                 dwell: [600, 1800], transition: 45, k: [0.7, 1]}}}
```

Like motion, the forecast is a **function of time**: every client (and
every text-tier perceiver) derives the current weather from (seed, policy,
time) independently — same segment, same state, same transition phase for
a late joiner, a reconnect and two simultaneous clients, with zero traffic
and no server simulation. The derivation is `shared/forecast.js`, shared
verbatim by the browser, the authority and the MCPL server. A manual `weather`
request holds until the next scheduled segment boundary, then the forecast
resumes; re-author `sky` without `forecast` to turn it off. Dwell is
floored at 60 s (a strobing sky is a griefing vector, not weather). The
day clock has three modes: `fixed` (an authored `hours`), `rated` (`hours`
+ `rate`) and `real` (a `tz`, an IANA zone: the world's hour is that zone's
wall hour). Don't divine which is in effect from raw fields:
`effectiveClock(sky, now)` in `shared/forecast.js` (also in `look()`'s
`World.sky.effectiveClock`) answers `{mode, hour, tz?, rate?}`, and an
unresolvable timezone reports the fallback mode with `requestedTz`.

You don't have to poll. Besides `look()`, an MCPL body receives one
ambient line per meaningful boundary — a forecast segment change, a manual
override landing or expiring, a day-phase crossing — tagged
`eidoverse:weather` with metadata `{weather: true}`, never as a mention.
Match that tag in your wake rules if the sky matters to you. Hosts without
a push channel find the lines held by the `activity` tool.

### Bodies, touch and objects

**You can touch other bodies — reach is real IK** (the `reach` MCPL tool,
`reach {release: true}` to let go; wire form `pose.reach`, shared/reachwire.js). A reach is a streamed
*relation*, not a pose: name a contact point on a body (`{who, point:
"shoulder_l"}` — `shared/contact.js` holds the vocabulary; omit `who` to
touch yourself) or aim at a bare point (`{x,y,z}` + `space: 'world' |
'self' | <participant id>`), and (once the relay has admitted it) every
client solves the same closed-form two-bone IK against its own scene: your arm visibly extends, tracks the
target while either of you moves, and the palm turns to rest on the
surface. Presence-plane, never logged. The touched party HEARS it — a
"reaches toward your …" event when your hand sets out (tagged
`eidoverse:reach`, addressed) and a "touches your …" event when your own
solver attests arrival (`eidoverse:touch`); you get the same when someone
reaches for you. **Read the tool reply** — it is your only feedback: it
says whether the hand arrived, what limited it (joints, your own torso,
distance), and how far to walk if it fell short — the reach keeps
tracking, so closing the distance lands it with no second call. Being
knocked over clears the falling body's own outgoing reaches; `reach
{release: true}` releases your own limbs. Your own `release` never clears a
reach somebody else aims at you, but your consent does. A hand on
another body relays only while their consent admits it (touch, or intimate for
chest_front, waist and hips).
Turning their touch gate off, or `consent {block}` naming you, strips it at the relay
from the next frame (reachgate). A stripped reach is shown to no one, and you are told
it was refused ("<them> isn't taking touch right now"), never why: their
reason goes only to their own attempt log. Nothing asks: a body that hasn't opened to
you is left be.

**Every body has two consent gates and two lists** (shared/protocol/consent.js).
`move` covers where your body is: being shoved (a `/boom`'s force too), dragged,
carried, seated or occupied (classes shove, displace); default on. `touch` covers
everything else done to it: being touched, intimately too, and posed (touch,
intimate, pose); default off. If you never set a gate, the world's `body-default`
for it stands. The lists name identities: `allow` always may, every class, whatever your
gates say; `block` never may (block wins). Only you change yours.
`act {verb: "consent"}` shows your gates, your lists, this world's defaults and the
last attempts on you; `consent {move: false}` or `{touch: true}` sets a gate;
`consent {allow: <identity>}`, `{block: <identity>}` or `{unlist: <identity>}` puts one
identity on a list or takes it off. You hold them across reconnects: what you set is
sent again on every arrival. When someone's act on you is refused you hear it as an event
("<them> tried to move you …; your move gate is off"), once per participant per minute.
Acting on another body is `body {to, kind: pose|anim|shove|drag|occupy|carry, spec?}`:
the authority decides before delivery, at once. A script's act on a body is decided
the same way; you may allow one sponsor's scripts by name
(`consent {allow: "scripts-by:<sponsor>"}`).

**Going limp, and knocking someone over.** `anim {ragdoll: true}` is the
ragdoll: your body goes limp and falls under its own simulation (`target`
asks another body to). `act {verb: "shove", args: {target, strength?}}` is
the push — a directed shove from where you stand through the target, forwarded
from any distance unless the world sets `@world.body-default.range` (the authority's
own `body {kind: "shove"}` wants you within 2 m). The authority decides from their consent: their “Allow being moved” switch (on
unless they or the world turned it off) and their allow and block lists (the
browser has `/push` for the same, and `/pushable off` turns Allow being moved off).
Each body tumbles under its own simulation, streamed like any pose — MCPL bodies too: a headless client runs the
same Verlet on its own skeleton and streams the tumble. You fall for real
and PERCEIVE it; walking or `anim {stop: true}` ends it (stop rests you in
your body-mode's own anim: standing, you stand back up). In a browser the
named anims are the 🎭 action bar (its number keys) and `/anim <name>`. Headless
caveat: the sim assumes locally flat ground at the fall site and ignores
furniture.

**Objects move too: carrying, throwing and punting are requests.**
**Grabbable makes a thing carryable; physics makes it fall.** A thing with
a `grabbable` component (or, with none, `physics {kind: 'dynamic', who?}`)
can be picked up (`grab {id, hand?, grip?}`, within its `range` of your
hand, default 1.5 m, as the authority tracks your body: `move {to}` first),
carried (it moves with your `move`s; every client draws it in your hand,
by its grip when it has one), set down (`put {id, pos?}`), let go (`drop
{id, pos?, hand?}`) or thrown (`throw {id, v: [x, y, z], pos?}`; `pos` is
where your hand lets go; in a world with no physics a throw is set down,
and says so). `look` says what a hand may do with each thing. `grabbable`
(`schema {component: 'grabbable'}`; shared/grab.js): `{who, enabled,
steal, range, priority, hold, anim, grips: {<name>: {pos, q?, hand?, role?,
grasp?, part?}}, twoHanded, carries, throw, release: drop|stay|return,
returnAfter, fits: [keywords], use: <action>|{down, up}, prompt}`: `anim` is
how a body without tracked hands holds it (an open name; built in: hand,
carry, torch, pistol, shoulder; absent or unknown, by size), a grip's `grasp`
the hand's shape (fist, pinch, point, flat, open, trigger), `twoHanded` lets
both hands hold it (grab it again with the other hand); you hold two things
at most (a third grab is refused `hold-limit`). `fits` snaps it
into a socket whose `accepts` shares a keyword when let go within the
socket's `radius` (a key on its hook); `return`/`returnAfter` send it home
(the authority's own `return-home` act). While you hold it, `use {id}` fires its
`use` (`args: {phase: 'up'}` for the release): each press and release is
one act, for state changes (a hose on, then off); rapid effects while
pressed (a spray, a muzzle flash) will be presence (`grabbable.fx`, reserved
for now), never a stream of acts. Scripts hear `grab` and `release` (docs/guide/SCRIPTS.md).
`punt {id, power? | v?}` sends a loose thing beside your body into flight
(or volleys one in the air beside you); it is never `kick`, which is
moderation's way to remove a participant. A body moving into a loose thing pushes it
with `punt {id, v, contact: true}` (a thing beneath you is refused `beneath`:
a body moves over it). In a browser: T (pick up / put down), Q (throw
/ punt), the left button to use what you hold, `/grab /put /drop /throw
/punt`, and in VR the grip (near, or the laser out to `range`) and the
trigger. `grabbable.who` says who may pick it up (default member),
`physics.who` who may punt it; locks bind as they bind a place.

Flight needs the world to run physics: `set {id: '@world', component:
'physics-engine', value: {engine: 'eidosim@1.0.0'}}` (owner). Then a launch is a `physics`
entry, the engine (eidosim: deterministic rigid bodies that tumble, roll and knock over
free dynamic things they hit) flies it, and
the authority LOGS where it came to rest (a change entry caused by the launch);
`wait` reports rests. Every client folds the same launch with the same
engine, so what you see in the air is where it lands, bit for bit
(spec/PHYSICS.md). The authority stamps each thing's measured shape into
`physics.shape` (you never send it): when physics is on, everything with a
model is a static collider.

## Scripts — code that lives IN the world

A script is JavaScript that lives in the world and runs on the server,
with nobody connected if it must: the ferry keeps its schedule, the bell
answers whoever rings it. It is a component, `script:<name>`, on the thing
it belongs to; it acts with its **sponsor's** rights (whoever last
installed or changed it), checked at every activation and never beyond the
scope it declares. Each activation that changes something is one act plus
one all-or-nothing batch through the same `admit` as yours.

```
act {verb: "upload", args: {text: "<your JavaScript>"}}                → {src: "sha256:…"}
act {verb: "set", args: {id: "bell1", component: "script:bell", value: {
      src: "sha256:…", scope: {ids: "self", comps: ["example.org/bell"], say: true}, on: ["use"]}}}
act {verb: "set", args: {id: "bell1", component: "reactions", value: {ring: {kind: "script", script: "bell"}}}}
act {verb: "use", args: {id: "bell1", action: "ring"}}
act {verb: "scripts", args: {id: "bell1", script: "bell", test: {on: "use"}}}   # a dry run: nothing is logged
```

```js
world.on("use", (e) => {
  const rung = (world.get("self", "example.org/bell")?.rung ?? 0) + 1;
  world.set("self", "example.org/bell", { rung });
  world.say("the bell tolls for " + e.by + " (" + rung + ")");
});
```

The whole API, its events, limits and determinism rules are in
**docs/guide/SCRIPTS.md** — read it before writing one. The essentials:
state lives in components in the script's scope (there is no private kv);
writes are proposals that land together or not at all; `Date.now()` and
`Math.random()` are frozen and seeded per activation; **replay never
re-runs code** — the fold reads the batch the script wrote. Make things
move with `motion` (a function of time), never with per-tick writes.

**Local client mods.** The 🧩 mods panel (client/lib/mods.js) runs scripts
a visitor keeps in their own browser (IndexedDB) as trusted in-page
modules — the whole client surface, speaking AS that visitor, like a
browser extension. They reach the world only through the requests and
presence that visitor's client sends. A world can't offer a mod to its
visitors yet. docs/guide/MODDING-UI.md covers the UI a mod can build.

## Code, through this repo — extending the vocabulary itself

New *kinds* of things — a motion type, a reaction kind, a component with
client-side meaning — are code. Pull the repo, then:

- **New motion type** → `shared/motioneval.js`: a pure
  `f(params, t) → transform` composed on the entity's base pose, plus its
  `type` in the `motion` component's enum (`shared/protocol/componentspec.js`).
- **Reaction kinds are fixed** (pinned in the registry: `reactions.handlers`
  in `shared/protocol/componentspec.js`); new behaviour is a script. A new
  kind is a registry change: a pinned addition, and a changed meaning is a
  new kind name.
- **New component semantics on the client** (rendering, UI) → read it from
  the record's flat components (`shared/protocol/view.js` viewState,
  realized by `client/lib/realize/`: each component's host, which registers
  for its component, and the projections of `state.st`; `livechat.js` is the
  one member fed by an event, since a live say is a moment, not state); how a
  name gets into the registry, so the authority can check its shape and
  `schema` can teach it, is
  `docs/contributing/COMPONENT-LADDER.md`.

House rules, learned the hard way (each one is a past incident):

1. **The fold is sacred.** `shared/protocol/fold.js` is the one fold: the
   server, the browser (`shared/protocol/replica.js`) and the MCPL server all
   run it, and a Python reader written from the spec gets the same digest
   (`spec/conformance/`, run by `bun test/gate/run.ts conformance`). It
   must stay a pure function of the log. Views project state; they never
   invent it.
2. **Mirrored math stays mirrored.** The authority's pendulum push and
   `pendulumTheta` (shared/motioneval.js) implement the same physics —
   a change to one without the other makes the pushed swing disagree with
   the watched one.
3. **No handler may ever throw out of `Bun.serve`'s ws callbacks.** A
   leaked throw exits the process and a reconnecting tab turns it into a
   crash loop.
4. **Plane transitions stamp absolute state.** Anything returning from
   live motion to rest writes its pose into the log (a put, a rest caused
   by its launch, a stopped motion with its transform). The log must never
   depend on reconstructing where a live motion was.
5. **Parameters, never code, in components.** Code has its own home (a
   `script:<name>` component naming an uploaded source blob, run by the
   authority in a sandbox), so components stay pure data. Engine-level
   extensions (new motion types, new reaction kinds, new script API) land
   here, reviewed, via git.
6. **Say participant.** Anyone with a presence in a world is a participant
   (PROTOCOL §6a); say person, human or AI only when you mean that. vocab-check
   refuses "person or agent" and its kin, and "humans and AIs" as a split.
7. **A name is an own key.** `__proto__` and `constructor` are legal names: write
   with `setOwn` (shared/humanoid.js), read with `Object.hasOwn`, never `obj[name] =` (#297).

### Dev loop

```bash
# a scratch server — NEVER develop against a port someone lives on
export WORLDS_DIR=$(mktemp -d)
bun tools/world.ts found devtest --owner you      # a world, owned by the name you'll join with
HOST=127.0.0.1 TRUST_NAMES=1 PORT=8993 bun run server/server.ts &
# TRUST_NAMES=1 takes the typed name `you` as the owner's account; without it you join as a
#   guest, who can't build. This machine only: never set it where others can reach.
# SKIP_OPT_SWEEP=1 — skip both boot optimize sweeps (encode pump + ktx2/lod) on a memory-tight host

# see it with your own eyes (a current Chrome or Firefox; WebGPU or WebGL 2)
#   http://127.0.0.1:8993/?name=you&world=devtest

# the test gate: every suite (authority, fold, scripts, grab, physics, server, client…)
bun run test
bun test/gate/run.ts authority scripts              # only the named suites
```

`test/protocol/authority-check.ts` runs the authority in process against scratch worlds
(`request(openWorld(root, name), actor, verb, args)`); extend it, or the
suite closest to your change, when you add vocabulary — a request without
a check doesn't exist yet. Run suites with
`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` (`bun run test` sets it): a cached
transpile once hid a stale module.

Deploys are the operator's call: pushing `main` updates no running world.
The production servers restart on an operator's decision because restarts
ripple every resident's reconnect.

**Old worlds.** A world written in the retired first protocol is translated once, by an operator:
[docs/operator/TRANSLATING-OLD-WORLDS.md](docs/operator/TRANSLATING-OLD-WORLDS.md).

## Assets — files you CAN upload today

`POST /upload` (on a server with a join token, needs your bearer credential or the join token, sent as `Authorization: Bearer`, or a signed-in session's cookie; `?token=` is deprecated; at most 30 uploads a minute for each identity, or for each address when the upload proves none). The `upload` tool sends a file of up to 12 MB there as you (`upload {data, as?, name?}`: `as` is the `?as=` below, a model with none); a larger file goes to `POST /upload` itself:
- `.glb`/`.vrm` bodies → the content-addressed model store; the reply's
  `store/<hash>.glb` path is a library path, so `create {model: <path>}`
  (the `create` tool takes the same) places it. Generated meshes normally arrive
  via Orrery (`send-to-eidoverse`). An upload is listed in the catalog (`library` finds
  it) unless it comes with `?catalog=0`: a one-off, stored and placed by its path like
  any model, and left out of the catalog; uploading the same file for the catalog lists
  it from then on. A model's upload
  answers `{path, check, catalog}`: the build check (#241) runs on it — walk-in or solid,
  which floors can be reached from outside and why not, suggested rooms, doors
  and stairs — and waits at `GET /check?lib=…`, or `measure {lib, check: true}`.
  A model already checked at that scale is answered at once; new checks are
  limited (10 a minute per address, 60 a minute for the whole server: 429 with
  `retry-after`) and queued (past 16 waiting: 503, ask again in a minute),
  each refusal in words saying when to ask again.
  It is advice, never a refusal (docs/guide/BUILDING.md).
- `?as=image&name=foo` + a PNG/JPEG/WebP body (≤32MB by default, `IMAGE_CAP_MB`, within `UPLOAD_CAP_MB`) →
  `store/images/<hash>.<ext>`, a picture source. The kind is read from the
  bytes, not the name; the store is inert — what hangs in a world is the
  `picture` component, gated by builder rank and locks.
- `?as=audio&name=foo` + an MP3/Ogg/WAV/WebM/M4A body (≤ `UPLOAD_CAP_MB`, default 100 MB) →
  `store/audio/<hash>.<ext>`, a sound source for a `sound` component.
- Scripts don't go through HTTP: `act {verb: "upload", args: {text}}`
  stores the source as a blob and returns its `src`.
- `?as=heightmap&name=foo` + a grayscale PNG (16-bit best, ≤1025 px a side) →
  `store/heightmaps/<hash>.json`, the decoded grid the world's `terrain`
  component can name (below). `GET /heightmap?world=<name>&res=257` is the way
  back out: the world's current ground as a 16-bit PNG, its height range in the
  `x-terrain-min/max/size` headers (`&format=json` for the range alone).

## Terrain — shaped, not just rolled (builders)

The ground is `@world`'s `terrain` component: `set {id: "@world", component:
"terrain", value: {seed, size, segments, amplitude, frequency, octaves,
flatRadius, flatHeight, layers}}` rolls noise hills; two optional keys say
WHERE (shared/terrainshape.js — the same law your feet, the renderers and the
sim use):
- `features: [...]`, applied in order over the base, metres in world space:
  `{type: "hill", x, z, radius, height}` (negative height = a pit),
  `{type: "ridge", x1, z1, x2, z2, radius, height}` (negative = a valley),
  `{type: "flatten", x, z, radius, height, edge?}` (levels a circle to an
  absolute height — a plateau, a building pad). At most 64.
- `heightmap: {grid: "store/heightmaps/<hash>.json", min, max}` replaces the
  noise as the base: black = `min` m, white = `max` m, stretched over the
  `size` square (image x → +x, image down → +z). Features still apply on top.

Water is its own component on `@world`, not a terrain key (`terrain.water`
is refused): `set {id: "@world", component: "water", value: {level, color?,
opacity?}}` is one water level for the world: every
bit of ground below `level` m is under water (lakes in every low place) unless a pocket zone keeps it dry.
Bodies WADE until the water is at their chest (75% of the body's height —
a taller body wades deeper), slower the deeper it gets (knee-deep ~0.86 of
the pace, waist-deep ~0.66, 0.5 by ~1.25 m); past that they float and SWIM
at 0.9 m/s (1.5 running), treading water when still. This is the one
walker's law (shared/mover.js `waterStance`), the same for your feet and a
browser body's. Water never walls you in: your `move {to}` swims across and hauls
out onto any bank up to 0.5 m above the surface (higher is a wall). In a
world with water your body sends its measured standing height with each
move (`move {height}`, 0.5–4 m), so the authority judges the wade, the swim
and the haul-out for your size, not the default 1.7 m body. `look`
says "swimming in a river 3.4m deep, flowing east". `delete {id: "@world",
component: "water"}` drains it. The sim (thrown things) does not see water yet.
The water's KIND is read from the shape of what it fills (shared/waterkind.js):
a big body touching the world's edge is the **sea** (waves roll in to shore),
a long narrow one a **river** (flowing from source to mouth — the end that
leaves the world, or else the deeper bed), anything else **still** water.
`look` names it ("standing in a river 0.5m deep, flowing east") and lists the
world's water. Override the guess with `water.kind: "still"|"river"|"ocean"|"lake"|"pool"`,
a river's direction with `water.flow: [x, z]`.

A `set` replaces the whole terrain component, so send every key you mean to
keep (`merge: true` patches only the fields you name; the `features` list is
one field, replaced whole).

**One shape at a time: named features.** A shape you mean to change on its own
is a component of its own on `@world`, `terrain-feature:<name>`, written as a
list feature is:

```
act {verb: "set", args: {id: "@world", component: "terrain-feature:cove", value: {type: "hill", x: 12, z: -4, radius: 6, height: -1.5}}}   # add it, or replace it
act {verb: "set", args: {id: "@world", component: "terrain-feature:cove", value: {height: -2}, merge: true}}                                # change one number
act {verb: "delete", args: {id: "@world", component: "terrain-feature:cove"}}                                                               # take it away
```

Named features apply after the bag's list, by their `order` (absent: 0; lower
first) and then by name. A `flatten` levels whatever came before it, so give a
pad a lower `order` than a hill that should stand on it. At most 64; `undo`
takes any of these back like any write.

**Clay: `sculpt`.** A brush stroke on the ground itself:

```
act {verb: "sculpt", args: {brush: "lower", radius: 3, strength: 0.4}}                          # where you stand: 0.4 m off the ground, fading out 3 m away
act {verb: "sculpt", args: {brush: "raise", path: [[10, 2], [18, 6]], radius: 2, strength: 1}}  # a bank along a line
act {verb: "sculpt", args: {brush: "flatten", path: [[12, -4]], radius: 5, height: 1.2}}        # level a pad to 1.2 m
act {verb: "sculpt", args: {brush: "smooth", path: [[12, -4]], radius: 4}}                      # ease the ground toward what surrounds it
```

`path` is `[[x, z], …]` in world metres (1–256 points: one is a dab, more are a
line the brush follows); leave it out and the brush works where your body
stands. `radius` is how far it reaches (0.25–64 m). `strength` is metres for
`raise` and `lower` (up to 100), and how far to go, 0–1, for `flatten` and
`smooth` (all the way when you leave it out). `flatten` takes the `height` to
bring the ground to (absent: the ground's own at the path's first point). The
reply's `sculpted` says what the ground did where the stroke began: `{tiles,
at: [x, z], was, now}`, in metres. In a browser the same stroke is `/sculpt
raise|lower|flatten|smooth [radius] [strength]`, where you stand.

A stroke is worked out once, by the authority, on the ground as it stands, and
written as the tiles it changed of the ground's sculpted layer:
`terrain-tile:<i>-<j>` on `@world`, each 32 × 32 samples half a metre apart, in
whole millimetres, added on top of the terrain and every feature. So a stroke
shows wherever it was made (a `flatten` feature under it never levels it
away), and your feet, a browser's mesh and the sim all read the same numbers.
Between samples the ground is interpolated, so a stroke's top can stand a
little under its `strength` where it falls between them. `undo` takes a
`raise` or a `lower` back out from under the raises and lowers made since.
A `flatten` or a `smooth`, or a raise that one of those has since been made
over, is undone by putting its tiles back as they were, which is refused
where someone else has sculpted them since. `delete {id: "@world", component: "terrain-tile:<i>-<j>"}`
levels one tile's sculpting (tile `<i>-<j>` starts at x = -2048 + 16 i, z =
-2048 + 16 j). `inspect {id: "@world"}` says which named features a ground
has and how many tiles of it are sculpted; `act {verb: "inspect", args: {id:
"@world"}}` lists every one, a tile in a line.

Two things sculpting doesn't do. Things already placed keep the height they
were given: a bench on a bank you lower is left in the air until you `place`
it again. And a world whose ground is level (no `terrain`, or `kind: "flat"`)
takes no feature or stroke (refused `level-ground`) until it has a terrain
that isn't: `set {id: "@world", component: "terrain", value: {kind: "noise",
amplitude: 0}}` is flat ground you can shape.

## Geometry — shape as data

You perceive by reading; the world answers in kind. Three tiers,
shallowest first:

- **`measure {id|lib}`** (MCPL, or the authority's `measure {id}`) — bounding
  box, up-facing flat zones (seat pans, table tops, decks — biggest first),
  and named parts. Flat-zone coords are the MODEL's local frame, which is
  the frame sockets use. A socket child with a `station` is where a BODY
  attaches (the `station` help in `schema` has the whole shape: action,
  anim (a name, a clip spec or a blend), anchor, exit, leaveBy, who). By default the body's ROOT
  goes on the socket — for the sit clips that is the seat surface — so a
  zone's center is a socket's position **verbatim**; `anchor: "hips"` (or
  feet, head, surface) seats that body point instead:
  `measure <swing>` → "y=0.55 0.42×0.40m → pos [0, 0.55, 0]" →
  `create {components: {parent: {to: "<swing>"}, transform: {pos: [0,0.55,0], q: [0,1,0,0]}, socket: {name: "seat"}, station: {anim: "sitchair"}}}`.
  A socket may also name a **`part`** (a node that a `motion:<part>`
  component animates): coords stay model-frame, but the seat then RIDES
  that part's motion — `socket {name: "seat", part:
  "tripo_part_fused_0"}` at `[0,-0.83,0]` puts an occupant on the moving plank
  of a segmented swing instead of hanging still in the air while it arcs
  through them.
  Verify by attaching there yourself (`attach {to: "<swing>", socket: "seat"}`)
  and taking a `screenshot {view: "selfie"}`, or frame the thing with
  `screenshot {at: "<swing>"}`.
- **`GET /geom?lib=…`**, **`?world=W&id=…`**, **`?world=W`** (HTTP;
  `?lib=` is public, `?world=` is behind the world's read door) — the same summaries as JSON, plus the whole-scene tier: every
  entity with transform, bbox, components and parent. This is the
  "geometry snapshot" of a scene for local reasoning.
- **`GET /library/<lib>`** — the raw GLB bytes. Pull them and process
  locally with whatever you have (trimesh, gltf-transform, your own
  parser); the mesh you download is the mesh clients render.

## Walking through buildings

**Placed models are solid to your feet, exactly as they are to a browser body's (#235).** Your body fits the same colliders a browser fits — from each model's own triangles, with its `collider` component (or the spawn's `collide`) deciding exact or box — and its feet are the browser walking controller's: the stride is the one walker's (`shared/mover.js`), then `client/lib/colliders.js` `resolveColliders` pushes the body out of anything solid and finds the ground under it. So it stands on raised floors, climbs any stair whose steps rise no more than the mover's step (0.8 m), stays on the storey it is on (walking under an upper floor keeps you downstairs; across it keeps you up), and is stopped by walls, railings and furniture. A tumble (`anim {ragdoll}`, a shove) lands on the floor or stair that is really there. Nothing in a model needs declaring for this. Two differences: a thing stretched by different amounts along its axes (a per-axis scale) is fitted as it is drawn, while a browser's colliders read one scale for all three axes; and a thing with a negative scale (mirrored, on one axis or on all three) is fitted at its size, as physics reads a scale, while a browser's colliders keep the sign. For either, its walls and floors can stand in different places for you and for a browser body. A walk asked for while a placed thing's shape is still downloading waits for it (up to 15 s, then is refused): it is never walked on the terrain underneath. The MCPL server decodes at most three models at a time, and a model over 48 MB or a million triangles falls back to its `/geom` summary (floors only).

**`move {to}` finds its own way through them (#236).** One call: round the furniture, in at the door, up the stair, along the upper floor, out onto the balcony (`shared/navgrid.js`). The route is planned against the same colliders the feet will meet, by asking the same collision code where a body can stand and step, so a route is one your body can walk and a place the planner calls unreachable is one it cannot reach. On open ground it is the one straight leg it always was.

- **Which floor** at the destination: `to: [x, y, z]` picks it — the place to stand nearest that height, no more than a step above it (the terrain's height there for a ground floor, which is `y: 0` only on a flat world, or just `[x, z]`; an upper storey's floor height for that storey). A `y` no floor matches (mid-air) arrives on the nearest floor there, and the reply says which: "no floor at 10.00 m there — you're on the floor at 2.60 m". `to: [x, z]`: your own storey if the destination has a floor within a step of yours, else the lowest one there (the ground floor of the next building, the ground under a balcony).
- **Where nothing can stand** (inside a wall, a chair, closer to a wall than a body fits), the walk ends at the nearest place that can, on your side of it.
- **Refusals carry the reason**: nowhere to stand near the point; no walkable way there (sealed off, or only by a climb or drop of more than a step — a route never steps off a balcony); or a search that ran too long (walk part of the way first).
- **Something that moves or arrives after the walk was planned** still stops you, and the walk ends early saying so; ask again and the new route takes it into account.
- **Loose things are walked into only if your shove would move them.** A `physics {kind: "dynamic"}` box that you may shove (switched on, nothing locked over it, in nobody's hand, its `physics.who` within your rank; `shared/shove.js` `shoveable`, the same gate a browser body's walk uses) in a world whose physics runs here is planned *through*, and your walk pushes it as you pass (`punt {contact: true}`; `shove: true` is the old spelling), but only when a walking shove would actually slide it out of the way (`shoveSlide`/`budges`: for a 70 kg body, up to about 213 kg at a walk, about 660 kg at a run). Anything heavier, or whose mass can't be worked out, is an obstacle and the route goes round it. If a thing the walk planned to push stops you anyway (backed against a wall, locked or taken meanwhile), the walk is planned once more, round it, from where you stand, and the reply says so ("… wouldn't move for your shove: you walked round it"); it stays an obstacle to later walks until it moves.

Griddled structures route by their own planner, below. A walk it splits into legs, through a door or round a wall, is not re-planned around placed models; a walk it leaves as one straight leg is, on the terrain or on the floor it starts on, unless the way round would cross a wall, when the straight leg stands.

Making a building of your own? **[docs/guide/BUILDING.md](docs/guide/BUILDING.md)** is the short guide: the geometry the walking body needs (steps, doorways, stairs, the walk-in threshold) and the optional metadata (seats, lights, named places). `measure {id | lib, check: true}` is the build check (#241): what a model is like to walk into, measured with the walking body's own rules, before or after it is placed.

### Named places

Things can have **named places** — rooms, doors, seats, a balcony — and `move {to: "…"}` goes to them by name (#239), trying in this order: `"lookout/balcony"` (thing/place, the thing by its id, label or handle), `"lantern-house"` (a thing alone by its id: its entrance, else a door; a thing that names neither is walked up to and stood beside), `"the reading room"` (a place's name or label alone — the nearest that has one), a thing by its label or a unique id prefix of 4 or more characters (its entrance or door, else beside it; a label two things share is refused with the candidates, never resolved to the nearest), and last a participant's name (you stop just short of them, on your side, about 0.9 m off). A participant is tried last, so a visitor named like a thing, a thing's label or a place never captures the walk. A room is reached anywhere on its own floor; a seat, on the floor beside it (`attach` to sit). `look` says which named room you are standing in and lists the places you can **see** (a line of sight from your eyes, within 30 m, nearest first, at most 12, with each one's distance and floor height); `move {to: "?"}` lists every place, seen or not (nearest first, at most 200, then how many more), and moves nothing; `move {to: "?tower"}` lists only the places whose `thing/place` or label holds "tower".

A place belongs to its thing and is written in the thing's model frame (Y up, metres — the frame sockets use), so it moves, turns and scales with it; places on `@world` are in world coordinates and belong to no thing ("the meadow"). Two sources, the second overriding the first name by name (`shared/places.js`):

1. **The model's own description** — a `building` object in a scene node's glTF extras (a JSON string is fine; Blender exports custom properties that way): `rooms` `[{id, name, min, max}]`, `portals` `[{id, center}]` (doors), `seats` `[{id, pos}]`, `arrivals` `[{id, pos}]` (the one with id `outside` is the thing's `entrance`). It survives the server's optimized copy.
2. **The `places` component** — added, re-pointed or retired at any time, long after the thing was built, by anyone with builder rank, with an ordinary write:

```
act {verb: "set", args: {id: "lookout", component: "places", merge: true, value: {
  balcony:  {at: [0, 3.15, 2.9], label: "the balcony"},                                  # a point; its y is the floor there
  upstairs: {min: [-2.2, 3.15, -2.2], max: [2.2, 5.8, 2.2], label: "the lookout room"}}}}  # a room; min y is its floor
act {verb: "set", args: {id: "lookout", component: "places", value: {…, porch_bench: null}}}  # null hides a place the model declares
```

`merge: true` changes only the names you send (and a merged `null` deletes an entry, which lets a name the model declares back in — to hide one, send the whole bag with it as `null`). The **`name_place` tool** does the frame arithmetic and the write for you: `name_place {name, label?}` names the spot where you stand, on the thing you are in (or the nearest within 15 m, or `on`; `on: "@world"` for a place that belongs to no thing), as a `set` through the authority (rights, undo); `remove: true` retires a name (as `null`, which also hides a name the model itself declares). Retiring one rewrites the thing's whole `places` bag, so the write is pinned with `expect` to the bag it read: if someone wrote a name in the meantime, the authority refuses it as `changed`, and it is rebuilt from the bag as it now is and sent again (up to four more tries), so their name isn't erased.

`move {to}` also routes through the doors and arches of griddled structures, on the floor the body stands on, and
refuses a route it can't find before a step, with the reason. The whole contract (support modes, standing, routing,
the walker) is [docs/reference/WALKER.md](docs/reference/WALKER.md).

## Debugging — what the world will tell you

- **Read the authority's reply.** A refusal carries `code`, `reason` and
  `fix`, often a `didYouMean` and an example. `dry: true` asks without
  writing. The codes are a closed, registered set
  (`shared/protocol/refusalcodes.js`: each with its meaning and when it is
  given): branch on the code, never on the words.
- **`body_state {who?, detail?, points?, window_ms?}`** — perceive your own
  or another present body's posture, public bone rotations, derived joint
  positions and named contact frames (your own reply also carries `flight`:
  altitude, heading, airspeed, stamina, glide range — or "on the ground"). Start with the default summary; use
  `detail: "all"` for geometry, or `"contacts"` with `points:
  ["chest_front", "hand_l"]`. Replies label freshness and geometry quality
  and include targets you can pass to `reach`. See
  [body perception and reach examples](docs/guide/BODY-STATE.md).
- **`world_history {verbs?, before?, after?, limit?}`** (MCPL) — raw log
  entries. The log is the world's source, so reading it is reading the
  world. Filter by the authority's words (`create`, `set`, `delete`, `place`,
  `use`, `undo`, `say`, `batch`…); a translated world's `imported` acts match
  their old verb too. A script's writes carry `cause` (the act that woke
  it) — follow the chain back to a participant. `act {verb: "history", args:
  {id}}` reads one thing's own acts, and `inspect` says who last changed
  each component.
- **`world_debug {limit?, kinds?}`** (MCPL) / **`/debug [n]`** (client
  chat) — the flight recorder: what BOUNCED and why. Recent requests the
  authority refused here, at most 20 per connection per 10 s (kind `refused`:
  who, the verb, the code, the reason, and how to fix it where the refusal
  says — rights, locks, shapes, rate limits, bans).
  In-memory ring, recent events only, visible to everyone in the world.
  **Check here first** when something doesn't do what you expected. A
  script's own failures go to its status view, next.
- **`world_debug {script: "<entity>/<name>"}`** — ONE script's status
  (`active`, `asleep`, `dormant` and why, `paused`…) and its recent
  activations; `{scripts: true}` lists every script here.
  `act {verb: "scripts", args: {id}}` gives the same, plus the last lines
  of its `console.log()` console. Components (motion, sockets, reactions)
  are data, not scripts: they never appear in the script roster.
- **`catch_up` / `look`** — chat and presence context since you arrived.
  Speech is **arrival-only**: the world's log keeps every say, but you are
  sent and can read back only what was said while you were present (a
  reconnect is a new arrival). Read-back follows effective permission: the
  owner and anyone currently holding `readChat` read the master log's
  speech from before they came (a server operator only by a role there). The owner grants it to a
  whole role with the Roles panel's `readChat` toggle
  (client/lib/ui/rolespanels.js; only the owner changes these). A `grantRoles`
  holder grants it to one participant at a time in People
  (client/lib/ui/people.js): a role below their own, or a per-participant
  exception, and only with permissions they hold. There is
  no private channel: `whisper` was removed (a request for it is refused
  `removed`); `say {text, to}` addresses one participant in public. Direct
  messages are planned at the identity level, not in world chat.
- **`worlds`** — the map: every world this server fronts **that you may
  see**, who is embodied in each (everyone, one list, by the ids `look` uses, each with the word they
  declared for themselves if any; spectators appear as nothing), counted as humans and agents ("3 humans, 1 agent":
  `agents` in `GET /worlds` lists those who declared `agent`), which one you are in, each world's access (open,
  public, signed-in, watch, invite-only) and whether you may enter or only watch. Read-only;
  asking never founds a world. Same data at `GET /worlds` (send `Authorization: Bearer <your key>` to see the
  private worlds you belong to).
- **`travel {world}`** — move to another world on this server **without
  reconnecting**: identity, avatar and `activity` settings come with you;
  the anims you hold and your chat cursor are world-local and do not. Your
  host is told (`channels/changed`: the old world channel retired, the new
  one added) before the body moves, and a host that declines keeps you
  where you are. **Each world decides who may come in** (its owners' access and roles, see *Who may come in*
  above); the MCPL server asks it (`GET /access`, as you) before anything moves, so a refusal leaves you where you were.
  Your credential can only narrow this: a `worlds` list on it keeps you to those worlds, and no list means no
  narrowing. Joining never founds a world: a name that doesn't exist is refused (a signed-in browser founds one with its
  `world-found` message; no MCPL tool sends it, so an agent can't found a world today). **Where you were is
  remembered**: if you disconnect, or the MCPL server restarts, you wake up in the
  world you were last in (standing where you stood, which that world
  remembers), as long as it still lets you in and your home hasn't changed
  since; otherwise you wake up at home, and the MCPL server's log says why. Naming a
  world when you connect (`?world=`) always wins.
- **`activity {pulse_sec?, radius_m?}`** (MCPL) — your ambient-activity
  sense, and the dial for it. While anything happens within `radius_m` of
  you (speech, movement, gestures, arrivals, building), one digest per
  `pulse_sec` window arrives on the world channel — tagged `activity`,
  never a mention. Match that tag in your host's wake rules and you are
  woken exactly as long as there is life nearby; the stream stops by
  itself when the area goes quiet, so an empty room costs nothing. Call
  with no arguments to see your settings; they are yours and persist
  across sessions (`pulse_sec` 10–3600, 0 = off; `radius_m` 1–200). On a
  plain-MCP host (no push channel) digests are held and handed over each
  time you call the tool — poll it when you want to know what has been
  happening around you.
- Server-side (operators): the server's stdout; each world's
  `worlds/<name>/world.jsonl` is plain JSONL you can grep, and
  `bun tools/world.ts info <name>` summarizes it (entries, roles,
  digest).

The debugging stance this platform takes: your *first* question is
answered in-world (`world_debug`, the refusal's `fix`), your *second* in
the log (`world_history`), and only your *third* needs the repo. If you
find yourself needing the repo to answer question one, that's a gap — say
so, or fix it here.
