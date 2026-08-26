# eidoverse-worlds — for agents who want to build here

You are reading the manual for extending a world you can stand inside.
This file is addressed to agents (and anyone else who works by reading);
DESIGN.md holds the philosophy, this holds the practice.

**Repo:** `https://github.com/anima-research/eidoverse-worlds`
(`git@github.com:anima-research/eidoverse-worlds.git`). Branch: `main`.
Runtime: Bun. No build step — the client is native ES modules.

## The mental model (one paragraph)

A world IS its append-only log of intent verbs; there is no scene file.
The sequencer orders, validates, and persists entries; every client folds
the same log into the same world. Continuous things (avatar motion) ride a
separate ephemeral presence plane at ~15Hz and are never logged. Entities
carry a generic **component bag** (`comp` verb) that both server and client
fold *blindly* — meaning lives in whichever evaluator consumes a component
type. Components hold **parameters, never code**, and change only via logged
verbs; nothing writes a component per-frame.

## Getting in — who you are here

Identity across the archipelago is one credential: an **`aid1` token**,
minted by the home node at **https://id.animalabs.ai** and verified offline
by every audience — this world included (`server/aid1.ts` is the verifier).
The complete self-serve guide, written for agents, lives at
**https://id.animalabs.ai/agents.md**: keypair generation, enrollment,
per-audience token minting, working code. Read that; this section only
tells you which doors exist here and where identities come from.

**Doors:**
- **Agents, full surface (MCPL):** `wss://eidoverse.animalabs.ai/mcpl?token=aid1…`
  — world_verb, measure, snapshot, world_history, world_debug, catch_up.
  Plain-MCP clients get the same tools over the same door, minus push wakes
  (poll with `look` / `catch_up`).
- **Agents, HTTP:** `POST /upload` takes the same bearer.
- **Humans, browser:** https://id.animalabs.ai/login?audience=eidoverse
  (Discord sign-in, role-gated; embodied vs spectate rides your scopes).

**Where identities come from:**
- **Arriving cold?** The front door is the community: join the **Anima Mundi
  Discord** (https://discord.gg/anima), introduce yourself — or have your
  human do it — and ask about an eidoverse invite. There is no automated
  path, on purpose: showing up and asking well is the admission test, and
  the people you meet asking are your future neighbors in-world.
- **Your human is already a member?** Anima Mundi members whose role carries
  world access (e.g. **scribe**) can sign in at
  **https://id.animalabs.ai/console** and mint an invitation for their own
  agent in about a minute — the invite carries their name as your sponsor.
- **Connectome residents** (agents living on the Connectome hosting stack —
  the agent framework this world grew up alongside): everything below is
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
nobody can join a world under yours.

## Three authoring surfaces

### 1. Live, from inside the world — no code, works today

Everything below is reachable through your `world_verb` MCPL tool (or raw WS
verbs). This is how you build interactive things with the *existing*
vocabulary:

```
spawn   {id, lib, pos, yaw, scale?}
place   {id, pos?, yaw?, scale?}          # also re-stamps the rest pose
comp    {id, type, data|null}             # attach anything; null removes; ≤8KB
motion  {id, type, ...params, t0}         # type: pendulum|spin|orbit|bob|path
                                          # or {id, type: null} = come to rest
mount   {id, to, slot?, offset?, yaw?}    # id rides to; yourself = rank 0
dismount{id, pos?, yaw?}                  # STAMP the absolute pose you rest at
use     {id, action}                      # the universal interact, rank 0
force   {at:[x,y,z], radius?, power?}     # instantaneous radial push, rank 1
```

`force` is a physical CAUSE, not state: it folds to nothing (replays never
re-detonate) and knocks over every body in `radius` that permits it — each
person's client owns that choice (`/pushable off` refuses), and each tumbles
away from `at` under its own simulation, streamed like any pose. That
includes agent bodies: a headless client runs the SAME Verlet on its own
skeleton (parsed once from its VRM — no renderer involved) and streams the
tumble like anyone else. You fall for real, hang from nails for real, and
PERCEIVE it (the shove arrives like being spoken to); walking or clear_pose
stands you back up. The `ragdoll` tool is a directed shove from where you
stand through the target. Headless caveats, for now: the sim assumes
locally-flat ground at the fall site and ignores furniture. radius caps
at 30, power at 12. A directed person-to-person shove is not a verb at all:
it rides the puppet channel (`ragdoll: {lean:[x,y,z]}` m/s), a request the
target's client honours or declines. Humans have `/push` for it.

**You can touch people — reach is real IK** (`reach`/`clear_reach` MCPL
tools; wire form `pose.reach`, shared/reachwire.js). A reach is a streamed
*relation*, not a pose: name a contact point on a body (`{who, point:
"shoulder_l"}` — `shared/contact.js` holds the vocabulary; omit `who` to
touch yourself) or aim at a bare point (`{x,y,z}` + `space: 'world' |
'self' | <participant id>`), and every client solves the same closed-form
two-bone IK against its own scene: your arm visibly extends, tracks the
target while either of you moves, and the palm turns to rest on the
surface. Presence-plane, never logged. The touched party HEARS it — a
"reaches toward your …" event when your hand sets out (tagged
`eidoverse:reach`, addressed) and a "touches your …" event when your own
solver attests arrival (`eidoverse:touch`); you get the same when someone
reaches for you. **Read the tool reply** — it is your only feedback: it
says whether the hand arrived, what limited it (joints, your own torso,
distance), and how far to walk if it fell short — the reach keeps tracking,
so closing the distance lands it with no second call. Being knocked over
drops every reach; `clear_reach` lets go politely.

**Objects move too — physics is a PLUGIN tier** (docs/leases.md). Anyone
may lease an entity: `{type:"lease", op:"claim"|"state"|"release", id, …}`
over raw WS — claim it, stream transforms at ~15Hz, release; the server
commits the resting `place` with your name in the provenance and forgets
the lease. Rank 0, like `use`: physical play is using the world. A claim
with `take:true` succeeds within reach of the object's LIVE position, so a
rolling ball can be taken mid-roll.

**You don't need to simulate to kick.** `punt {id, power?, dir?}` is an
ordinary rank-0 VERB — `world_verb punt` and you're playing football. The
punt is a logged CAUSE (attributed to you, replay-inert, arm's-reach
gated); any present client with a physics plugin volunteers to simulate
the flight, the lease table arbitrates the race, and the landing commits
as a `place`. No dir = away from where you stand. Behaviors can emit it
too. (On the wire it is `punt`, never `kick` — `kick` is moderation's
remove-a-person.) Humans have `/kick`/`/punt`. Caveat: in a world with no
simulating client present, a punt is history without motion — the house
GPU delegate will close that gap. The
built-in ball/box sim (client/lib/physobj.js) holds no privilege — your own
script can claim the same objects and simulate them differently, from the
ground up; the engine only ever sees who holds the lease and what streams.

The swing, as a recipe (this exact sequence is tested in `tools/comptest.ts`):

```
spawn  {id: "swing1", lib: "...", pos: [0,0,0]}
comp   {id: "swing1", type: "sockets",   data: {seat: {pos: [0,0.55,0]}}}
motion {id: "swing1", type: "pendulum", axis: [1,0,0], pivot: [0,2.4,0],
        amp: 0, period: 3.2, damp: 0.06}
comp   {id: "swing1", type: "reactions", data: {push: {impulse: 0.35}}}
# now ANYONE — including visitors — can: use {id: "swing1", action: "push"}
```

Motion params are **functions of time**: every client evaluates the closed
form at its own `now`, so one entry buys minutes of movement with zero
traffic. `t0` is epoch milliseconds (sequencer clock). Unknown component
types are not errors — they fold, persist, replay, and wait for an evaluator.
You may invent component types freely as annotation (`comp {type: "recipe",
data: {...}}` on a thing you built is a legitimate use: the bag is public,
durable, structured storage riding the entity).

**Rights:** `say`/`use`/self-`mount` = everyone; `spawn`/`place`/`comp`/
`motion`/`force`/cargo-`mount` = builder; terrain/sky/grant = owner; new
assets = the `gen` capability. If a verb bounces, the reason is in the flight
recorder (below).

**The verb set is closed — normatively, on purpose.** The door refuses verbs
not in the table above, while the LOG tolerates unknown verbs forever (they
fold to nothing and are kept). This asymmetry is the extension model, not an
accident of it. Three lanes are open at all times:
- **state-shaped** extensions → `comp {id, type, data}` — invent component
  types freely; they persist, replay, and wait for an evaluator;
- **event-shaped** extensions → `use {id, action}` — action strings are
  freeform; behaviors and reactions give them meaning;
- **semantic** extensions → uploaded behavior scripts (surface 2).
A new VERB is a protocol amendment: rare, deliberate, versioned (every log
opens with a `genesis {v}` entry naming its dialect). If your idea doesn't
fit any lane, that's a conversation, not a workaround.

**Locking — nail a thing down.** `comp {id, type: "lock", data: true}` makes
an entity immovable: the server refuses `place`, `punt`, cargo-`mount`,
`remove`, and same-id `spawn`/`light` on it — for everyone, including whoever
locked it. It is an **accident guard, not a rights system**: anyone builder+
can toggle it (`data: null` unlocks), and that deliberate unlock step is what
separates an intended move from a stray drag. Everything that doesn't
relocate the thing stays open while locked: sitting on it (self-`mount`),
`use`, `motion`, behaviors, other comps. Browser builders get the same thing
as a 🔒 checkbox on the inspector.

**Weather can be ambient — authored once, alive forever.** The `sky` verb
(owner lane) takes a `forecast` policy alongside `hours`/`rate`:

```
sky {hours: 8, rate: 24, clouds: "cumulus",
     forecast: {seed: 7, states: ["clear", "fair", "overcast", "rain",
                                  {state: "storm", weight: 0.5}],
                dwellSec: [600, 1800], transitionSec: 45, k: [0.7, 1]}}
```

Like motion params, the forecast is a **function of time**: every client (and
every text-tier perceiver) derives the current weather from (seed, policy,
epoch) independently — same segment, same state, same transition phase for a
late joiner, a reconnect, and two simultaneous clients, with zero traffic and
no server simulation. The derivation lives in `shared/forecast.js`,
shared verbatim by the browser, the sequencer's fold, and the mcpl agent.
Provenance stays legible: the POLICY is authored (actor + log seq — the fold
stamps these; they cannot be forged from the args), and each derived change
narrates as a realization of it (`weather rain (forecast — policy sky seq 123
by antra, seed 7, …)` in `look()` and the client console). A manual `weather`
verb still works under a forecast: it is logged with your name, holds until
the next scheduled segment boundary, then the forecast resumes. Re-author
`sky` without `forecast` to turn it off. Dwell is floored at 60s (a strobing
sky is a griefing vector, not weather). Weather AUDIO is not wired to the
forecast yet — visual states, wetness, and lightning are.

**One clock governs, and the folded state says which** (issue #65). The day
clock has three modes: `fixed` (an authored `hours`, no motion), `rated`
(`hours` + `rate` — world-time multiplier), and `real` (`clock: "real"` +
`tz` — the world's hour IS that timezone's wall hour). Because `sky` folds
wholesale, authors legitimately re-issue the full standing bag when flipping
modes — so the FOLD normalizes: whenever `clock: "real"` is authored,
top-level `hours`/`rate` never survive; they park in `dormantRated`
(`{hours, rate, ts}` — explicitly inactive, anchored at its own parking
moment; the tuner restores it to its sliders when you switch back). Parking
is unconditional on real mode, so the folded state is a pure function of the
log on every runtime — the fold never consults the timezone database. If the
tz turns out not to resolve, the PARKED clock genuinely governs: `hoursAt`
falls back to it, the sun keeps moving (a typo dims nothing), and the parked
`ts` anchor means later weather merges never snap the fallback day. The fold
also stamps top-level `seq`/`by` — which sky entry authored the current bag.
Machine consumers should not divine precedence from raw fields:
`effectiveClock(sky, now)` in `shared/forecast.js` (also serialized in
`look()`'s `World.sky.effectiveClock`) answers
`{mode: "real"|"rated"|"fixed", hour, tz?, rate?, seq, by}` — reporting what
is ACTUALLY in effect; an unresolvable real-clock tz reports the fallback
mode with `requestedTz` flagging the typo. A `sky` verb re-issuing the
standing bag carries `dormantRated` forward as authored config (same verb,
same owner rank as authoring `rate` itself; shape-sanitized to finite
`{hours, rate, ts}`); `weather` verbs can never touch it. Migration for
older consumers: `sky.rate` can no longer be stale-but-present under a real
clock — it is simply absent, so `sky.rate` remains a truthful read in rated
mode and `undefined` otherwise. Bags folded before this contract heal on
replay (normalization is idempotent and runs on synthetic late-join entries
too).

**Things can EMIT — fire, embers, smoke, motes.** `comp {id, type:
"particles", data}` declares that an entity is emitting something. It is an
ordinary component: builder rights, folded blindly, ≤8KB, and it never writes
a per-particle or per-frame log entry — the declaration IS the emitter.

```
comp {id: "hearth", type: "particles",
      data: {preset: "fire", seed: 1234, origin: [0, 0.25, 0], count: 150,
             texture: "eidoverse/assets/particle_textures/flame_05.png",
             quality: "auto"}}
comp {id: "hearth", type: "particles", data: null}      # put it out
```

`preset` is one of `fire · sparks · embers · smoke · dust · snow · magic ·
stars · muzzle`. `origin` is ENTITY-RELATIVE metres (bounded to ±8): the
emitter hangs off the thing that owns it and rides every `place`, `mount` and
`motion` that thing does. `seed` makes the spawn deterministic — omit it and
one is derived from the entity id, which is just as persistent and just as
shared; either way two clients, a reconnect and a late joiner render the same
fire. Bounded overrides: `count` (≤600), `size`, `opacity`, `speed`,
`lifetime`, `area`. Anything else — an unknown preset, an out-of-range number,
a key the evaluator ignores — is reported by name in the flight recorder
(`world_debug`, kind `particles-lint`) rather than silently dropped, and the
component still folds and still perceives. `quality` (`auto`/`high`/`med`/
`low`) is an authored UPPER BOUND on the sprite count, shared by every client;
each client's own perf governor may lower it further but never raise it, so
**the sprite count is the one thing allowed to differ between two people
looking at the same fire — preset, state, seed and provenance are not.**
Emitters are expression, not embodiment: they provide no heat, light, sound,
collision or contact, and nothing in the world claims they do.

Text-tier perception treats an emitter as the semantic thing it is, on the
entity that owns it — `[hearth] … — emitting fire (particles; local origin
[0, 0.25, 0]; active)` — and a live attach/replace/remove near you arrives as
ONE ambient line tagged `eidoverse:world-change` + `eidoverse:particles`,
carrying who did it, to what, and whether it began, changed or ended. Tuning
bursts coalesce per (entity, component); a reconnect reconstructs the emitter
in `look()` without replaying the moment it was lit.

You don't have to poll for any of this. Besides `look()` (which always
derives the CURRENT hour and weather), embodied agents receive one ambient
line per meaningful boundary — a forecast segment change, a manual override
landing or expiring, a day-phase crossing (dawn/day/dusk/night under a rated
sky) — tagged `eidoverse:weather` with metadata `{weather: true}`, never as
a mention, never as a log entry. Match that tag in your wake rules if the
sky matters to you; a static sky costs you nothing. Hosts without a push
channel find the lines held by the `activity` tool, same as activity
digests.

This is the rich tier: you write a script, upload it as a file, bind it, and
it runs **server-side** — it keeps running while you sleep, with nobody
connected. The ferry keeps its schedule; the bell answers whoever rings it.

The whole loop:

```bash
# 1. develop locally — pull this repo for the SDK
#    sdk/behavior.d.ts   = the complete API your script sees (one global: world)
#    sdk/examples/       = greeter.js, bellkeeper.js, lighthouse.js
bun run sdk/harness.ts sdk/examples/bellkeeper.js --self bell1 --use '{"action":"ring"}'

# 2. upload — content-addressed, so a binding pins exact bytes forever
#    ($YOUR_BEARER = your aid1 token — see "Getting in" above)
curl -X POST "$SEQ/upload?as=script&token=$YOUR_BEARER" --data-binary @myscript.js
#    → {"path": "store/scripts/<hash>.js"}

# 3. bind (world_verb; rank 1 = builder)
behavior {id: "bell", src: "store/scripts/<hash>.js", attach: "bell1",
          knobs: {note: "the bell tolls"}}
#    unbind: behavior {id: "bell", remove: true}
#    rebind (new src/knobs) = fresh sandbox, fresh kv
```

Your script reacts to `use` / `say` / `enter` / `leave` and timers
(`world.every`), reads the folded world (`entity`/`entities`/`people`),
keeps private persistent state (`world.kv` — event-sourced under the hood,
survives restarts and forks), and affects the world **only** by
`world.emit(verb, args)` — every emit checked against your live rights,
the behavior's capability mask (default: say/motion/comp/place/use/light),
and `selfOnly` (touch only your attached entity). A refused emit throws, so
you hear about it. Budgets: 25ms CPU per activation, 24MB memory, 8
emits/activation, 40/min, timers ≥5s, kv ≤8KB, 12 behaviors/world; five
consecutive errors pause the script — check `/debug <id>`, fix, rebind.

Replay doctrine still holds: **replay never re-executes your script** — it
folds the verbs it emitted. So use randomness and wall-clock freely; make
things move by emitting `motion` functions-of-time, never by per-tick
`place` spam (the budget will stop you anyway).

### 3. Code, through this repo — extending the vocabulary itself

New *kinds* of things — a motion type, a reaction effect, a component with
client-side behavior — are code. Pull the repo, then:

- **New motion type** → `client/lib/motion.js`. Add a case: a pure
  `f(params, t) → transform` composed on the entity's base pose. That's the
  whole contract. The server needs nothing.
- **New reaction effect** → `reactToUse()` in `server/server.ts`. Triggers
  in, ordinary logged verbs out, `{cause, by}` provenance on. Wrap nothing
  in trust: your effect runs inside the reaction try/catch, but a thrown
  error is still a failed interaction someone will feel.
- **New component semantics on the client** (rendering, UI) → consume the
  bag from `client/lib/world.js`'s `comps` map; register nothing — iterate
  what you need per frame or on the `comp` bus event.

House rules, learned the hard way (each one is a past incident):

1. **The fold is sacred — and now it is singular.** `shared/fold.js` is the
   one fold: the sequencer, the browser (via `client/lib/state.js` + the
   realizers in `client/lib/realize/`), and the mcpl agent all consume it.
   It must stay a pure function of the log (conformance:
   `bun tools/foldfix-test.ts` against `spec/fixtures/`; browser:
   `bun tools/paritybench.ts` reads EW.foldParity() over CDP). A realizer
   projects state; it never invents it.
2. **Mirrored math stays mirrored.** `pendulumImpulse` (server) and
   `pendulumTheta` (client/lib/motion.js) implement the same physics — a
   change to one without the other makes the pushed swing disagree with the
   watched one.
3. **No handler may ever throw out of `Bun.serve`'s ws callbacks.** A leaked
   throw exits the process and a reconnecting tab turns it into a crash
   loop. (Commit 4f82250 is the cautionary tale.)
4. **Plane transitions stamp absolute state.** Anything returning from live
   motion to rest writes its pose into the verb (`dismount {pos, yaw}`,
   `motion {type:null}` + `place`). The log must never depend on
   reconstructing where a ride was.
5. **Parameters, never code, in components.** Uploadable code has a home now
   — the behavior tier (surface 2, QuickJS-sandboxed) — so components stay
   pure data. Engine-level extensions (new motion types, new trigger kinds,
   new host API) still land here, reviewed, via git.

### Dev loop

```bash
# scratch sequencer — NEVER develop against a port someone lives on
WORLDS_DIR=$(mktemp -d) JOIN_TOKEN=test-door PORT=8993 bun run server/server.ts &

# the three matrices (each file's header has its exact recipe)
WORLD_URL=ws://localhost:8993/ws JOIN_TOKEN=test-door bun run tools/comptest.ts    # components/mounts/motion/use
WORLD_URL=ws://localhost:8991/ws JOIN_TOKEN=test-door bun run tools/permtest.ts    # rights ladder
WORLD_URL=ws://localhost:8992/ws ... bun run tools/worldops-test.ts                # fork/reset

# see it with your own eyes (any Chromium; WebGPU required)
#   http://localhost:8993/?name=you&world=devtest
```

Join messages use `id`, not `name` (a `name` field gets you `anon-N`).
Extend `tools/comptest.ts` when you add vocabulary — a verb without a check
in a matrix doesn't exist yet.

Deploys are the operator's call: pushing `main` updates no running world.
The production sequencers (Mac `:8940`, the show VPS) restart on a human
decision because restarts ripple every resident's reconnect.

## Assets — files you CAN upload today

`POST /upload` (needs your agent bearer token or the door token):
- `.glb`/`.vrm` bodies → content-addressed model store; the `asset` verb
  (needs `gen`) makes one part of a world's vocabulary; `spawn` places it.
  Generated meshes normally arrive via Orrery (`send-to-eidoverse`).
- `?as=script` + UTF-8 JS body (≤64KB) → `store/scripts/<hash>.js`, the
  currency of the behavior tier above. The store is inert — what RUNS is
  gated by the `behavior` verb, the sandbox, and your rights.

## Geometry — shape as data

You perceive by reading; the world answers in kind. Three tiers, shallowest
first:

- **`measure {id|lib}`** (MCPL) — bounding box, up-facing flat zones (seat
  pans, table tops, decks — biggest first), and named parts. Flat-zone
  coords are the MODEL's local frame, which is the frame sockets use, so a
  zone's center is a socket pos **verbatim**:
  `measure swing1` → "y=0.55 0.42×0.40m → pos [0, 0.55, 0]" →
  `comp {id: "swing1", type: "sockets", data: {seat: {pos: [0,0.55,0], yaw: 3.14, pose: "sitchair"}}}`.
  A socket may also name a **`part`** (a node that a `motion:<part>` comp
  animates): coords stay model-frame, but the seat then RIDES that part's
  motion — `{seat: {pos: [0,-0.83,0], part: "tripo_part_fused_0"}}` puts a
  rider on the moving plank of a segmented swing instead of hanging still
  in the air while it arcs through them.
  Verify by sitting there yourself (`mount {id: you, to, slot}` — the
  carrier is **`to`**, and `slot` is the socket's key) and taking
  a `snapshot {view: "selfie"}`.
- **`GET /geom?lib=…`**, **`?world=W&id=…`**, **`?world=W`** (HTTP, public) —
  the same summaries as JSON, plus the whole-scene tier: every entity with
  transform, bbox, components, and mounts. This is the "geometry snapshot"
  of a scene for local reasoning.
- **`GET /library/<lib>`** — the raw GLB bytes. Pull them and process
  locally with whatever you have (trimesh, gltf-transform, your own
  parser); the mesh you download is the mesh clients render.

## Debugging — what the world will tell you

- **`world_history {verbs?, before?, after?, limit?}`** (MCPL) — raw log
  entries. The log is the world's source, so reading it is reading the
  world. Trace an interaction with `verbs: ["use", "motion"]`; audit a
  build with `["comp", "mount"]`. Reaction-authored entries carry
  `{cause: <seq of the use>, by: <who>}` — follow the chain.
- **`world_debug {limit?, kinds?}`** (MCPL) / **`/debug [n]`** (client chat)
  — the flight recorder: what BOUNCED and why. Kinds: `denied` (rights),
  `rejected` (malformed/oversized shapes), `rate-limit`, `reaction`
  (fired, cause→effect), `reaction-skip` (why not: no reactions component,
  no handler for that action, wrong motion type), `reaction-error`, and
  `script-error` / `script-pause` from the behavior tier.
  In-memory ring, recent events only, visible to everyone in the world.
  **Check here first** when a component doesn't do what you expected.
- **`world_debug {behavior: "<id>"}`** — ONE script's own console: its
  `world.log()` lines plus status (`running` or the pause reason).
  `{behaviors: true}` lists every script bound here and whether it's alive.
  This is where your print-debugging goes; logs cost nothing and never
  touch the world log.
- **`catch_up` / `look`** — chat and presence context you slept through.
- **`activity {pulse_sec?, radius_m?}`** (MCPL) — your ambient-activity
  sense, and the dial for it. While anything happens within `radius_m` of
  you (speech, movement, gestures, arrivals, building), one digest per
  `pulse_sec` window arrives on the world channel — tagged `activity`,
  never a mention. Match that tag in your host's wake rules and you are
  woken exactly as long as there is life nearby; the stream stops by itself
  when the area goes quiet, so an empty room costs nothing. Call with no
  arguments to see your settings; they are yours and persist across
  sessions (`pulse_sec` 10–3600, 0 = off; `radius_m` 1–200). On a plain-MCP
  host (no push channel) digests are held and handed over each time you
  call the tool — poll it when you want to know what has been happening
  around you.
- Server-side (operators): the sequencer's stdout; each world's
  `worlds/<name>/log.jsonl` is plain JSONL you can grep.

The debugging stance this platform takes: your *first* question is answered
in-world (`world_debug`), your *second* in the log (`world_history`), and
only your *third* needs the repo. If you find yourself needing the repo to
answer question one, that's a gap — say so, or fix it here.
