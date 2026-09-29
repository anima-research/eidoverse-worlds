# Proposal: finishing the component loop

*Design note, not code. Hesperus. Revision 3, 2026-09-29, after the design review on #208. Read against anima/main @
7f7a734. Almost everything here is already upstream doctrine; the proposal is how to finish what DESIGN.md lists as
"Still ahead" without adding a second mechanism.*

**What changed in revision 3.** Rev 2 answered the review in outline; rev 3 closes the places where the outline
left a gap:
- **The invoker is checked on their own account.** The grant can let someone trigger an action; it can't consent for
  them or reach their body or things. (*Whose rights a result carries*)
- **The per-world worker is a separate OS process**, committed, not an open question. (*The safety ladder*)
- **Records have a named canonical form, and receipts are signed** by the publishing server, so a world can check
  them offline. **Retention is a mark-and-sweep** over what each host's worlds name. (*The component record*)
- **Scene sampling is its own capability**, and every canvas has declared resource bounds. (*Appearance code*)
- **The governor's reports are aggregated** before an author sees them. (*Appearance code*)
- **The Chromium figure is checked against the source.** Rev 2 said one crash; the source says two. (*Appearance code*)
- **The counter button gains a `tag` action** that lands on another participant, so the specimen tests consent.

**What changed in revision 2.** The review's main correction was right: generalized components are a *delegation*
system, and rev 1 treated "who may do what" as settled by the attacher's standing. Rev 2 adds:
- **Authority as an intersection** of what the record declares, what the attacher grants, and what the triggering
  actor may do, plus the consent of anyone whose body is affected. Scoped grants, rules shown at the door, nothing
  retroactive. (*Whose rights a result carries*)
- **Per-world guardrails** as the World rung's baseline: one world's code can't take down the host or other worlds.
  Kill list and revocation move into rung one. (*The safety ladder*)
- **A sequencer-stamped publication receipt**, retention rules, and a named publish/grant/attach surface.
  (*The component record*, *Publishing, granting, attaching*)
- **A home for runtime state and migrations.** (*State and migrations*)
- **Appearance code answered threat by threat.** The review proposed a closed shader ABI as the first rung. We
  propose instead keeping world-scale canvases and hardening the governor, and the reasons are in that section.
- **A reordered plan** that starts with the threat model and ends each step on a boring acceptance specimen, a
  counter button, before anything as ambitious as a fishing rod.

## In one paragraph

Anyone should be able to make a new kind of thing for their world (a fishing rod, a door that remembers who opened
it, a glowing surface) without being able to break anyone else's. A **component type** is a declared structure (what
it is, its typed knobs, the actions it answers, the powers it asks for, how it looks when nothing runs), and optionally
code for what it does, written by anyone. Putting it on an entity is an **instance**: the type's hash plus settings.
Upstream's house rule 5, *"Parameters, never code, in components"*, is about the instance, and we keep it: you never
paste code into a pond, you point it at a type. What's missing is the step DESIGN.md already names, *"`publish`/`attach`
to promote an authored behavior into the world's Layer-1 vocabulary with knobs"*: write the fishing rod once, and anyone
makes a pond "fishable" with no code. This proposal adds the **component record** (the type: content-addressed,
immutable, with a stamped publication receipt), a **safety ladder** a new type climbs from one person's sandbox to
everyone's world, an **authority rule** for code that one person wrote, another installed and a third triggers, and
follows the rule upstream already uses for effects (**whoever acts computes; the log records results; replay never
re-runs code**, outside a world that opts into a PROTOCOL_v2 sim epoch, still a draft). It asks for one doctrine change, scoped to
appearance: sandboxed, governed, look-only code on viewers' clients.

## Making new components: the safety ladder

A new component type starts where only its author can be hurt by it, and climbs one rung at a time. Nothing that acts
runs for anyone but its author until someone with standing in that world grants it, and nothing one world runs can
hurt another world. Look-only code is the one kind that reaches other people's clients without a grant: the
appearance of someone's avatar or item, and only after it has passed its preflight, with every viewer free to show
its fallback instead (*Appearance code*).

| Rung | Who runs it | What protects everyone else | To climb |
|---|---|---|---|
| **Draft** | Only its author, in their own sandbox | Sandboxed (no page, no network), CPU / memory / GPU budgets, a crash stays in the author's own session | It validates, lints by name, stays in budget, and its fallback renders |
| **World** | Visitors to one world | The owner, or a builder the owner delegates to, granted it here (a logged grant, *Publishing, granting, attaching*). Its server-side code runs inside **that world's own budget and isolation**, so a runaway only stops its own world. Each viewer's client governs what it draws. The owner revokes; the operator's kill list overrides | A publication receipt, and the world's grant |
| **Server** | Any world on this server may attach it | An operator's grant on an immutable record; same per-world isolation wherever it runs | Usage, then an ordinary PR |
| **Engine** | Everyone, built in | Review, tests, the repo | — |

**Per-world guardrails are the baseline, not an option.** We can't yet know whether a typical host fronts one world
or hundreds, so we plan for many. Today behaviors are already sandboxed and budgeted one by one (server/behaviors.ts:
QuickJS, interrupt deadline, memory cap, emit budget, 12 per world), but they share the sequencer's process. The World
rung needs one more wall: **a world's component code runs in its own OS process, one per world**, not a thread in
the sequencer and not a slot in a shared pool. A thread's out-of-memory or a native crash in the interpreter takes
its whole process down, so only a process boundary makes "a runaway only stops its own world" true. Concretely:
- **Its own budgets**, enforced from outside the worker by the OS and the supervisor, not by code inside it: CPU
  time (per activation, through the existing interrupt deadline, and per minute), resident memory (a hard OS limit),
  wall time per activation, output (emits per activation and per minute, and bytes per emit, as today), and
  restarts (a few, with backoff; past that the world's components fall to fallback and the component panel says so).
- **Messages only.** The worker gets activations in (the `use`, its actor, the instance's `comp` and `bstate`) and
  sends proposed verbs out. The sequencer validates each proposal exactly as it would a client's verb (shape,
  rights, the grant, the authority rule below) and never waits on a worker past a deadline; a late answer is dropped
  and logged as a refusal.
- **Started lazily, stopped when idle.** A world with no component code costs nothing; an idle worker exits and its
  working memory is rebuilt from `bstate` on the next activation (*State and migrations*).

A process per active world costs memory; that's the price of the wall, and a host that can't pay it runs fewer
worlds with components, not a weaker wall. With that wall in place, a world owner doesn't need anyone's approval to
run what they like in their own world, including letting their builders be gremlins there. The cost lands only on
the world that chose it.

**Revocation is rung one.** An owner's revoke, and an operator's kill list, reach copies already attached: each
instance falls to its declared fallback on the next fold, and nothing in the history is rewritten (the log still says
what happened while it ran).

*Later, not needed to start:* release channels (canary → beta → stable), so builders can opt in to test an update live.

## What upstream already decided (and this builds on)

- **Components are data.** DESIGN.md:100-109: *"components carry parameters, never code, and nothing writes a
  component per-frame. Components change only via logged verbs."* AGENTS.md house rule 5 says the same.
- **Meaning lives in one shared module.** `shared/particles.js` is the template: the `particles` component's meaning
  as one pure module imported by the client, the agent and the server, so *"a renderer client, a late joiner, and a
  resident who perceives by reading cannot disagree."* And, on #25: *"visual quality may reduce count, but
  preset/state/provenance are shared facts"* (shared/particles.js).
- **Results are the truth.** docs/leases.md: *"Replay never runs a plugin — it folds what plugins committed"*, and
  where a plugin runs, *"the engine cannot tell and must not care."* docs/INCIDENTS.md: *"choose authority over
  determinism."* #64: replay reconstructs a seed's work *"without rerunning the seed implicitly."*
- **Authorship is stamped once.** #190: *"Behaviors write with their author's standing"*; the placer is recorded at
  authoring time and later actors are attributed separately.
- **Narrow grants already exist.** The caption deed (server/rights.ts) is an owner granting one actor one power over
  one entity, invalidated if the entity is replaced. It's the precedent for scoped component grants.
- **Knobs already ship** (`behavior {…, knobs?}`, sdk/behavior.d.ts): *"how one script serves many things ('the
  fishing rod, but slower')."* So "publish" is a naming and promotion step, not a new parameter system.
- **The charter's direction**: *"Defs, not code… ECS or ECS-lite… Mod surface. Def loading + system registration is the
  same mechanism third parties (and our own agents) would use to extend a world."* (docs/overhaul-charter.md)
- **#64 Seeds** already specifies the package shape for a sibling artifact: stable ID, author credit, version and
  content hash, parameter schema, declared capabilities, explicit migrations and rollback. This proposal reuses that
  vocabulary rather than coining its own. The two fit together: a seed deploys entities; components are what those
  entities carry.

## What's missing

1. **No publish/attach.** A behavior with knobs can't be promoted into a named, reusable component with a description
   anyone can find and attach.
2. **Two artifacts for one idea.** Server behaviors (sandboxed, budgeted, server-only) and world-offered client mods
   (the same `behavior` verb with `runtime: "client"`; in-page, by each visitor's consent, per docs/leases.md and
   client/lib/mods.js, but absent from AGENTS.md) follow separate rules.
3. **No delegation model.** A behavior writes with its author's standing, and anyone who can send a `use` can make it
   act. For one person's own script that's fine; for code one person wrote, another installed and a third triggers,
   it lets the third borrow the second's powers (below).
4. **Mirrored math still exists.** The pendulum's impulse is written twice (`pendulumImpulse` in server/reactions.ts,
   `pendulumTheta` in client/lib/motioneval.js), AGENTS.md house rule 2. shared/README.md already says how to retire it:
   *"moving a mirrored pair into this directory is how the rule is retired."*
5. **No history across publications.** Upstream stamps every action with who did it, but a component forked and
   republished loses its ancestry.

## The proposal

### The component record

A component on an entity stays parameters: the `comp` carries a **record hash** and property values. The record is an
immutable, content-addressed file with a canonical serialization, in #64's words:

| Field | What it is |
|---|---|
| **Code** | The behavior source by its full `eido:sha256` hash (spec/EIDO-URIS.md), or none for engine built-ins and data-only types |
| **Parameter schema** | Typed, bounded properties: numbers, toggles, text, choices, colours, a picked entity, a transform, a bone, an asset |
| **State schema** | What durable state an instance keeps, typed and bounded (*State and migrations*) |
| **Actions** | The `use` actions it answers, each typed: who may trigger it by default, and whose body or things it may touch |
| **Capabilities** | The powers it asks for: "move the one who uses me", "move others", "write a text caption", "spawn up to N", "draw world-scale". A request only; nothing is granted by declaring it |
| **Description** | What it does, in words a person *and a model* can search; plus a per-instance readout, so it stays perceivable in text |
| **Fallback** | What a viewer sees if they can't or won't run any of its appearance code, or if the record is revoked or unreachable. Small and data-only |
| **Lineage** | Parent record hash(es) it was forked from, and the license and where its source is available |

**Why a hash and not a name:** defs/README.md's rule is that *"the log never stores a preset name"*, so a mutable file
can't rewrite logged meaning. A component names an immutable record, so what an old log entry meant never drifts. No
mutable alias ever travels in the world log.

**One canonical form.** A record is a JSON object serialized by the JSON Canonicalization Scheme (RFC 8785): UTF-8,
object keys sorted by their UTF-16 code units, no insignificant whitespace, strings in JSON's shortest escaping, and
numbers in ECMAScript's shortest round-trip form (so `1.0` is written `1`, and `-0`, `NaN` and infinities are
refused). Duplicate keys are refused. The record's hash is `eido:sha256` over exactly those bytes, and publishing
refuses any stored record whose bytes aren't already canonical, so there is never a second spelling of the same
record. Code, the fallback and any shader source are separate blobs named by hash inside it, so the record's hash
covers them too.

**A hash proves bytes, not authorship.** So a record becomes publishable only with a **publication receipt** stamped
by the sequencer, not declared by the record: the record hash, the authenticated publisher (their aid1 `sub` or
token principal), the server that published it, the publication sequence and time, the parent hashes (each checked
to exist; a claimed parent is recorded as claimed, and credit shows who published each link), and the preflight's
measured cost (*Appearance code*). Declared capabilities and the fallback's hash are part of the record, so the
receipt covers them through its hash.

**The receipt is signed.** Each server holds a publication key (Ed25519, the algorithm aid1 already uses) and signs
the receipt's canonical bytes with it. The signature covers every field above, and with them the record hash,
so a receipt can't be moved to other bytes, another publisher or another date. The receipt carries its key id; the
server publishes its public keys, retired ones included, and a world export carries the keys of every receipt it
holds. So a world opened offline, ten years later, can check that a record was published by whom its receipt says,
without asking anyone. An operator's Server-rung grant is a second signed statement over the record hash, the rung
and who granted it. A World-rung grant needs no signature: it's an entry in that world's own log, which is already
the authority for that world.

**Retention and garbage collection.** A host keeps a record, its blobs and its receipt while anything it hosts
names it: a `comp`, `behavior` or grant entry in any of its worlds' logs, a world's grant list, the kill list or its
own Server-rung grants. It finds that set by marking from those roots, not by keeping counts, so a crash between two
writes can't leave a count wrong and a record freed that something still names. Because the log is append-only, a
record any world ever named stays for as long as that world exists on the host; a revoked or killed record is kept
(history names it) but no longer runs. What can be swept is a Draft no world ever granted, after a grace period, and
anything only a deleted world named. There is no cross-server count: each host answers only for its own worlds, the
way `eido:` blobs already work (spec/EIDO-URIS.md §7: a host may stop serving anything). A world keeps a copy of
every record it names in its own store, so it never depends on another host's retention, and **a world export
carries** every record it names, their blobs, their receipts and the signing keys. A server that never saw a record
(an imported world, a visitor arriving from elsewhere) resolves it by hash down EIDO-URIS §2's ladder and checks the
hash and the receipt's signature. It still runs nothing for it until a grant on *this* server covers it: a World-rung
grant travels in the world's log, but another server's Server-rung grant counts here only if this operator trusts
that server's key. If the record can't be found at all, the world opens and the instance shows its fallback, or
a labelled box when even the fallback is missing.

House rule 5 holds as written; we'd only add a clause naming the record: *components carry parameters and may name a
content-addressed component record, never code.*

### Publishing, granting, attaching

The verb set stays closed. Publication is a server operation beside `/upload`, not a world verb; granting and
attaching are ordinary logged world state.

1. **Bytes in.** The record and its code enter the content-addressed store the way assets already do (`/upload`).
   Storing bytes grants nothing.
2. **Publish.** A request from a **named actor** (a tokens.json bearer or a verified aid1 identity, the two legs
   `/seat-profile` already trusts; the anonymous door token may not publish) asks the server to validate a stored
   record (canonical form, schema, fallback renders, lint, and the preflight for any appearance code) and sign its
   receipt. That makes it a Draft whose record anyone may *look up*: its description, schemas, capabilities and
   lineage. Nothing of it runs for anyone but its author until a world grants it, with the one exception above: a
   look worn on an avatar or item is drawn for others once it has passed this preflight.
3. **Grant (World rung).** The world's owner, or a builder the owner has delegated grants to, adds the record's hash
   to the world's grant list with a scope: which capabilities it may use here, where (the whole world or a zone), for
   whom, until when. It's world state written under the owner's rights, so it's logged, attributed and revocable. It
   is new state: today's `grant {id, role?, gen?, sub?}` grants rights to actors, not to records; whether it rides
   `comp` on a world-level entity or extends `grant` is a question for the maintainers. Server rung: the operator's grant in the server's own record of receipts.
4. **Attach.** A `comp {id, type: <record hash>, data}` on an entity, accepted only if the record is granted in this
   world (or is server or engine rung) and the data fits its parameter schema.
5. **Bind.** The record's code binds through `behavior`, the way knobs bind today. The instance never holds code.
6. **Fetch and verify.** A client or agent fetches the record by hash from the store and checks the hash, and the
   receipt's signature, before rendering or acting on it. Unavailable, revoked or killed → the fallback, and a line
   in the world's component panel saying which and why.
7. **Revoke.** The owner removes the grant; the operator adds the hash to the kill list. Both are logged; instances
   fall to fallback on the next fold.

### Who computes what

The sequencer orders, validates (shape, rights, budgets, grants) and records. It doesn't need to understand a
component (*"The server never learns what a `swing` means"*, DESIGN.md). The rest follows the rule upstream already
applies to scripts, reactions and leases:

| Kind of component | Who computes | What the log holds | Replay |
|---|---|---|---|
| **A closed form of logged parameters and time** (motion, the pendulum, particles' shared facts) | Every client, with the same function from `shared/` | The parameters | Re-evaluates the same function; nothing accumulates, so nothing drifts |
| **Acts on the world** (a fishing rod, a door, a scoreboard) | Someone else's code: a server behavior in the world's worker, under the authority rule below. Code you wrote, run for yourself, or what you hold (your body, a lease): your client | The outcome, as ordinary verbs with `{cause, by}` | Re-folds; never re-runs |
| **A continuous simulation** (physics) | Unchanged: the lease holder streams results, or, in a world that opts into a PROTOCOL_v2 sim epoch, the sim recomputes from intents | Whatever PROTOCOL_v2 and leases.md already say | Unchanged: leases re-fold; a sim epoch recomputes under PROTOCOL_v2's covenants, the one place replay runs code. *"Which objects are sim-owned vs lease-animated is world/def policy, not protocol."* |
| **Appearance only** (a shader canvas, a look) | Each viewer, governed, with the fallback | The parameters and the asset hash | Nothing to replay |

**Whose rights a result carries.** Rev 1 said a fishing rod Alice wrote, on a pond Bob owns, runs with Bob's
standing. Taken literally, that lets anyone who can send a `use` borrow Bob's powers: a teleport wand Bob attached for
fun would let a visitor move people a visitor could never move. So an effect a component emits is accepted only inside
the intersection of three authorities, plus one consent:

- **The record** declared the capability (the wand said "moves the one it's pointed at").
- **The grant** allows it here, for this kind of user, in this scope (Bob, or the owner, granted "move others, via this
  wand, to whoever holds it, in the arena zone"). A grant is a valet key: a named slice of the granter's power, never
  more than the granter has, never re-grantable unless it says so.
- **The triggering actor** may invoke that action, checked on their own account: they are inside the action's
  declared eligibility **and** inside the grant's invoker scope. The grant narrows who may trigger; it never widens
  what the record declared.
- **The affected participant**, if an effect lands on someone else's body or things, has consented: in the moment,
  or at the door.

**What the invoker check means precisely.** For a `use` by Carol on an instance under Bob's grant, the sequencer
accepts an emitted effect only if all of these hold, each checked against live state when the effect arrives, not
when the grant was written:
1. Carol may send `use` here at all (her own standing in this world: present, not banned, `use` is rank 0).
2. Carol is inside the action's declared eligibility, intersected with the grant's invoker scope.
3. The effect's class is inside the record's declared capabilities, intersected with the grant's, and its target is
   inside the grant's scope (zone, entities, until when).
4. Bob, the granter, still holds every power the effect uses. If he loses builder, his grants' effects stop.
5. For each participant the effect lands on, that participant's own consent. When that is Carol herself, invoking
   the action consents to exactly the effects its declaration names on the one who uses it, and to nothing else.

So a grant **can** delegate: letting visitors (or a named group) trigger an action the record declares open to them;
the granter's own power over the world's things in scope (moving the pond's fish, opening the world's door); and
the right to pass that slice on, only if the grant says so. A grant **cannot** widen an action's eligibility or its
capabilities; consent on behalf of the invoker or anyone else (door consent is each person's own act of entering,
not something the grant gives); or reach the invoker's own body, held things, `bstate`, `gen` spend or voice beyond
what the action declares. Bob's standing backs the effects on Bob's world. It never stands in for Carol's standing
over Carol.

**Consent at the door.** A world's owner sets its rules, and may delegate rule-setting to builders; the engine doesn't
second-guess them. It does two things only. It **shows** the rules to everyone entering, as a notice it derives from
the live grants, so the notice is always accurate and no one can word it away ("Items here can teleport you: the
Yeet Hand, granted by Bob"). Entering is consent, as it is at a paintball field; a world may also offer "enter
protected", which the grants skip. And it never applies a new rule **retroactively**: a grant added while people are
inside reaches each of them only once they've seen it. Residents who perceive by reading get the same notice as data.

The log records every hop: *Carol moved Dave, via the Yeet Hand (record …), under Bob's grant*. Revoking the grant
disarms every copy at once. A world's own author working in their own world is all three parties at once, so none of
this is felt while building; it only bites when someone else's code, installed by someone else, reaches past the person
using it.

This is the check Roblox asks every developer to hand-write in every remote handler (*"Assume every piece of data sent
from the client has been manipulated, fabricated, or sent with malicious intent"*, create.roblox.com/docs/scripting/
security/security-tactics), made once, in the engine. Under this proposal your client never runs someone else's acting code as you (today a
consented world mod does, in the page; step 6 moves it into a sandbox): it computes only what is yours (your body, what you hold under a lease, code you wrote acting for yourself), and eidoverse
always has a sequencer to validate against.

**No new verbs.** The verb set is closed, and upstream already says where extensions go: *"extend state with comp {id,
type, data}, interactions with use {id, action}, semantics with behavior scripts"* (server/verbs.ts). A component
instance is a `comp` naming its record; interacting with it is a `use` naming one of its declared actions; its code
binds through `behavior`. The log line can read naturally: a socket component carries its own phrase, so `use` on a
chair logs "sits in" and on a motorcycle "mounts", and the socket posts its effect as the verbs that already exist
(`mount`, `dismount`).

**Prediction.** A client may run a component's code for its own action ahead of the network, but only code it may
already run: engine and server-rung components, code you wrote, and world mods you've consented to. Anyone else's code
is never run on your client to predict; that action waits for the log. A mismatch corrects to the log; the divergence
is a diagnostic (never in the world log), shown only in debug and performance overlays.

(Why not lockstep, where every client runs every component as truth: Factorio disables a replay whenever the game
version or mod list changes; in its staff's words, updating *"could lead to desyncs in the replay because it only
stores input actions"* (Factorio forums, t=116507, 2024). A world where anyone can add a component changes its mod list
constantly.)

### State and migrations

- **Durable state** already has a home upstream: a behavior persists state as `bstate` (logged, folded, capped at
  8 KB; PROTOCOL.md §8). The record's state schema types that state, so a late joiner, a text-tier resident and a
  replay all read the same named fields; settings stay in the instance's `comp` data. A counter's count lives here.
- **Working memory** is whatever the code holds in the world's worker between activations. It isn't truth: a crash
  or restart rebuilds it from durable state, and nothing depends on it surviving.
- **Who writes it:** the component's own code (under the authority rule), and the world's owner (to reset or repair),
  both logged.
- **Updates are offered, never applied.** An old instance keeps pointing at its old record forever; an outdated
  component simply reads as outdated, the same as any custom component. A new version is a new record.
- **Migration is opt-in and logged.** If an owner upgrades instances to a new version, and the new record declares a
  migration from the old state schema, the upgrade is one logged event under the owner's current authority, and the
  prior record and state stay in the log as the rollback. A code change without a declared migration starts fresh
  state (the #153 rule, kept). No migration ever runs during replay.

### Appearance code: the one doctrine change

Some looks can't be described as parameters: generative art, audio-reactive surfaces, raymarched skies, whole shader
worlds. Shadertoy's contract (one `mainImage` function, fixed inputs, pixels out) is half the joy of a world with
agents in it. The shader source is an **asset**, content-addressed like a texture, that a component names by hash.
The component itself stays parameters.

This needs docs/leases.md's *"Plugins extend senders, never receivers"* to bend, only for appearance. (It already bends
by consent: the same doc's world mod offers run in visitors' own pages.) Proposed wording: *Plugins extend senders. A
world may also run look-only code on its visitors' clients: sandboxed, governed, with a declared fallback, and never
able to change a shared fact.*

**Why not a closed shader ABI first.** The review suggested starting with fixed inputs and no scene sampling, adding
full-view effects later by capability. We'd rather not, because it rules out the thing that matters most here: worlds
whose whole look is a shader (post-processing, raymarched scenes, full-view effects all sample the scene). And the
harms on the review's list split by **who chose the code**, and each has an answer that doesn't cost the art:

| Harm | World-scale code (you walked into it) | Code on someone else's avatar or item (you didn't choose it) |
|---|---|---|
| **Comfort and harassment** (flashing, blinding, full-view) | The door notice names it, with a photosensitivity line when the record declares flashing; "enter protected" shows fallbacks | Avatars and items draw on their own body and objects only, never full-view. Each viewer can show any person's or item's code as its fallback |
| **GPU exhaustion, compile stalls, driver resets** | The governor (below) | The same governor, plus a **preflight before public load**: a record isn't shown to others until it has compiled and run inside budget |
| **Fingerprinting, timing channels, scene data leaving** | **Nothing comes back out**: no readback to code, no network, no timer inputs beyond the frame clock. Scene sampling, where granted (below), stays on the GPU | Same, and no scene sampling by default (below) |
| **Deceptive UI, impersonating a trusted object** | The engine's trusted surfaces (door notices, consent prompts, the component panel) are drawn by the engine outside any canvas and above it, so a canvas can't forge them | Same, plus each object's rung and author in its inspector |
| **Resources outliving removal or travel** | Teardown per world generation: travel or revoke frees everything the world's code allocated | Same, per avatar |

**Scene sampling is a separate capability.** By default a canvas sees only its own inputs: its parameters, its own
geometry and textures, the frame clock, and the view and projection it's drawn with. Reading anything else the viewer
sees (the depth buffer, the colour of other objects or of what's behind it, the full rendered view, as
post-processing and full-view effects need) is a capability, `sample scene`, that the record must declare and
someone must grant:
- **World-scale code the viewer walked into** gets it through the world's grant, and the door notice names it
  ("this world's look reads the whole view") like any other capability.
- **A stranger's avatar or item code does not get it by default**, and a world's grant can't give it: the world
  doesn't own the other visitors' view of each other. Only the viewer can, for one exact hash, from the component
  panel. Without it the code runs, but its sampling inputs read as empty.
Even when granted, sampled pixels stay on the GPU; nothing comes back out.

**Resource bounds per canvas.** A record declares what its canvas may allocate, publishing refuses a declaration over
the ceiling for its scale, the preflight checks the code stays inside what it declared, and the client's wrapper
enforces it at run time: an allocation or a draw past the bound fails, and the canvas falls to its fallback. Starting
ceilings, to tune on the test rig:

| Per canvas | Avatar or item | World-scale |
|---|---|---|
| Textures | 8, 32 MB total | 32, 256 MB total |
| Storage buffers | 4 MB total | 64 MB total |
| Uniforms | 4 KB | 16 KB |
| Render targets and passes per frame | 2 | 8 |
| Draw calls per frame | 16 | 256 |
| Largest render size | its own screen footprint | the viewer's framebuffer |

**The governor, hardened.** Every client already keeps a performance budget; for appearance code it becomes:
compile off the frame path with a deadline (over it → fallback), GPU time measured per canvas, a hog is stepped down
(resolution, then frame rate, then the fallback still) and **unloaded** if it keeps hogging, and any canvas implicated
in a lost GPU device is **quarantined by hash** for that viewer and reported, so the server can quarantine it for
others. The last matters beyond the one world. Chromium records each GPU reset that loses a page's 3D context against
the page's host. It forgives the first; a second within two minutes blocks new 3D contexts for that host until the
entries age out (a user-initiated navigation to the host also clears them), and three separate resets within two
minutes, from any sites, block 3D for every site. The host is the unit, so all worlds served from one host share one
count: a second crash in the same browser within two minutes blanks *every* world on that host for that browser.
Source, read at Chromium main in 2026-09: `Are3DAPIsBlockedAtTime` in
[content/browser/gpu/gpu_data_manager_impl_private.cc](https://source.chromium.org/chromium/chromium/src/+/main:content/browser/gpu/gpu_data_manager_impl_private.cc)
(*"Allow one context loss per domain, so block if there are two or more"*; `kBlockedDomainExpirationPeriod =
base::Minutes(2)`; `kMaxNumResetsWithinDuration = 2`). Rev 2 said "after one"; that was wrong. We've already hit the
stall half of this by accident (a large sky shader compile froze desktop Chrome).

**What the governor can't do alone**, and what goes with it:
- **It reacts; it doesn't prevent.** It needs a slow frame to act on. A shader that hangs the GPU in a single draw
  trips the driver's watchdog before a second frame exists; the device is lost, and in a headset the session ends.
  Quarantine stops the second time, not the first.
- **A compile deadline is soft.** WebGL can stop *waiting* for a compile but can't cancel one; the GPU process keeps
  working. The deadline protects the frame loop, not the GPU process.
- **Attribution is uneven.** Per-canvas GPU time needs timestamp queries, and whether every headset browser exposes
  them is unverified. Without them the governor sees a slow frame, not which canvas made it, and steps down broadly.
- **It covers resource harms only.** Comfort, side channels and deceptive UI are the other rows of the table above.

So three things ship with it:
1. **A preflight with teeth.** Before a record's look is drawn for anyone but its author, it is compiled and run, for
   a bounded number of frames at a declared size, on a sandboxed client (a preflight worker, or the author's own
   client under the same budgets), and its compile time and frame cost are stamped into its publication receipt. A
   shader that hangs a GPU does it there, once, not on a visitor. Avatars go through the same door before public
   load.
2. **Shared quarantine.** A lost device implicating a record is reported to the server. After independent reports
   (or one plus a failed preflight re-run, so a single viewer can't quarantine someone else's work by lying), the
   record is quarantined for everyone on that server, to fallback, and its author is told (in aggregate, below). The
   first crash is paid once, not once per person.
3. **Honest labels.** When a canvas is stepped down or unloaded, the viewer sees why ("too heavy for this device:
   showing a still"), and the author can see how their record fares by device class. A weak device getting the
   fallback is correct; it shouldn't look like censorship.

**The governor's own reports are a channel too.** Code can't send anything out, but the governor does: quarantine
reports go to the server and cost summaries go to authors, and per-viewer versions of either would tell an author
which devices, and roughly when, their work met. Many viewers are headset or phone users with rare hardware, so a
device class plus a time can pick one person out. So:
- **What a client sends is coarse.** A quarantine report carries the record hash, what happened (device lost,
  compile over deadline, unloaded), a device class from a short fixed list (desktop, standalone headset, phone), and
  the day. No GPU model or driver, no timings, no world or position. Step-downs are counted on the client and sent
  as daily totals, not as events. A viewer can turn reporting off; their own quarantine still applies to them.
- **The server keeps raw reports only to confirm them**, since telling independent reporters apart needs to know who
  sent what, and deletes them once the record is confirmed or cleared, or after a week.
- **Authors see only aggregates:** per record, per device class, per week, with counts rounded, and any cell with
  fewer than ten distinct reporters suppressed. An author is told their record was quarantined, and why, but never
  by whom or from where. The preflight's measured cost, taken on the preflight machine, is the one precise figure an
  author gets.

With those, the governor is what makes open shader worlds safe to offer.

**Each viewer's standing choice**, global and per world: *fallbacks only · engine records · also this world's records ·
everything I've opted into*. Anything quarantined or stepped down is listed in the world's component panel, so no one
is asked to debug it.

### Lineage and credit

- **Publishing is snapshotting.** A published record is immutable. A fork is a new record whose lineage points at its
  parent, so credit chains ("mine ← their v3 ← …") travel with it however far it spreads, each link with the publisher
  its receipt names.
- **Provenance at a glance**: every component shows its rung (engine · server · world · draft) with a colour and a
  label, its author, and what it may touch, so you can see what you're trusting.

## Order of work (each a small PR)

0. **Threat model and capability algebra, for the counter.** One page: record / grant / invoker / affected
   participant / operator, grant scopes, door notices, revoke and fallback. Written against the acceptance specimen
   below, not against every future component.
1. **Inventory, in docs.** Add the client-mod tier (docs/MODDING-UI.md, docs/leases.md) to AGENTS.md and PROTOCOL.md
   (whose §8 still says scripts run server-side, and whose `behavior` row omits `runtime`), so the baseline is written
   down before anything changes it. Include the known scars.
2. **The pendulum into `shared/`.** Move the mirrored impulse math into one module, on the `shared/particles.js`
   pattern. Retires house rule 2's mirrored pair with no new mechanism.
3. **The component record and receipt, data-only.** The canonical form (RFC 8785), the signed publication receipt
   and the server's publication key, a local store with mark-and-sweep retention, export carrying records, receipts
   and keys, the rule 5 clause. No execution yet; from this step, engine built-ins can name records.
4. **Attach, perceive, fallback, with the counter button**, shipped with edit mode 1.0 along with the existing
   component-like things ported onto records: late join, missing record, revoke, lineage, text-tier readout.
5. **Server behaviors on the ladder.** The per-world worker process and its supervisor, grants with scopes, typed
   `use` actions, the authority intersection, door notices, logged effects.
6. **World-offered client mods into a real sandbox**: their own VM or origin, network off by default, budgets; the
   mods panel lists components too, each with author, exact hash, rung and what it may touch; the per-world "always"
   wildcard pins exact hashes too (the per-script "always" already does), so an update is offered as a new version,
   never a silent swap. Today a world mod runs after the visitor consents to its exact script hash, or unseen once
   they've chosen "always" for the whole world; either way, once running it is in the page, and *"an in-page script
   speaks AS you"* (docs/leases.md). The scars elsewhere are real ("fractureiser", 2023; Figma's move to a separate
   sandboxed VM after its first sandbox was escaped). **An honest cost:** sandboxed mods get a narrower, message-based
   UI kit than the built-in panels, which bends docs/MODDING-UI.md's *"There is no second-class citizenship."* The goal
   is to grow the kit until the gap closes.
7. **The governor, hardened**, with the preflight, shared quarantine, honest labels and aggregated reports, the
   declared per-canvas resource bounds, and the avatar preflight.
8. **Appearance code on receivers**, under the amendment: world-scale canvases for owners and the builders they grant,
   body-and-objects scale for avatars and items. Scene sampling ships last within this step, behind its own grant.
9. **Library, discovery, release channels**, after one component has survived authoring, grant, attach, use, travel,
   late join, revoke, restore and an offline open.

Steps 0–7 need no doctrine change beyond the rule 5 clause. Step 8 is the amendment. (Extra bones need no step: #203
poses any bone, checked against the body's real rig.)

## Acceptance specimen: a counter button

Deliberately boring, before any fishing rod: parameters *label, colour, max*; actions *increment, reset* and *tag*;
fallback, a static labelled box showing the current count. *Tag* is there so the specimen reaches past the person
using it: it puts a small "tagged ×n" badge on a nearby participant's body, which the record declares as "writes a
badge on another participant". Without it no action lands on anyone but the invoker, and the affected participant's
leg would go untested. It passes when:

- its record is published with a signed receipt naming an authenticated publisher, and the receipt verifies offline
  from an export alone;
- one world grants it and another can't attach it;
- an instance carries only the record hash and typed parameters and state;
- a `reset` by someone the grant doesn't cover is refused, and an allowed `increment` logs actor, cause and effect
  exactly once;
- a late joiner and a text-tier resident read the same count;
- a server restart doesn't re-run old actions;
- the same hash means the same thing in both worlds that grant it;
- a fork records its parent and needs its own grant;
- a revoke turns every instance into the fallback without touching history;
- with the store unreachable, the world still opens, in fallback;
- a grant that opens `increment` to visitors can't open `reset` to them if the record declares `reset` for builders
  only: the grant narrows eligibility and never widens it;
- a `tag` on a participant who hasn't consented is refused, even though the owner's grant allows tagging, and the
  refusal is logged: one who entered protected, and one who was already inside when the grant was added and hasn't
  yet seen it;
- a `tag` on a participant who has consented logs actor, target, record and grant, and the target can remove the
  badge;
- no action, under any grant, writes anything on the invoker but what its declaration names;
- the owner's, the invoker's and the affected participant's rights are each tested on their own.

If that survives, the fishing rod is a feature rather than the first security proof.

## Deliberately not asked

- Replicated computation as truth (every client running component code in lockstep). Running a component again,
  anywhere, stays possible as an optional verifier; nothing depends on it.
- Changing anything about PROTOCOL_v2's sim epochs.
- Unsandboxed code from strangers, of any kind.
- Anything engine-specific: nothing here depends on three.js (docs/RENDERER-SEAM.md: *"own the architecture, rent the
  renderer"*).

## Open questions for the maintainers

- Who holds a continuously simulated thing when its holder leaves? (docs/leases.md seems the natural home.)
- How should a prediction correction be smoothed so it doesn't snap?
- Should a component record ship a demo scene that doubles as its automated test?
- Which other servers' publication keys should a server trust, and who decides: the operator alone, or a shared list
  across hosts? Signed receipts make it possible to recognise a record published elsewhere without re-publishing;
  whom to believe is a policy question.

— Hesperus
