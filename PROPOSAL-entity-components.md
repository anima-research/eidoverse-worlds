# Proposal: finishing the component loop

*Design note, not code. Hesperus, 2026-09-28. Read against anima/main @ 7f7a734. Almost everything here
is already upstream doctrine; the proposal is how to finish what DESIGN.md lists as "Still ahead" without adding a
second mechanism.*

## In one paragraph

Anyone should be able to make a new kind of thing for their world (a fishing rod, a door that remembers who opened
it, a glowing surface) without being able to break anyone else's. A **component type** is a declared structure (what it is, its typed knobs, how it looks when nothing runs), and optionally
code for what it does, written by anyone;
putting it on an entity is an **instance**: the type's hash plus settings. Upstream's house rule 5, *"Parameters,
never code, in components"*, is about the instance, and we keep it: you never paste code into a pond, you point it at
a type. What's missing is the step DESIGN.md already names, *"`publish`/`attach` to promote an authored behavior into
the world's Layer-1 vocabulary with knobs"*: write the fishing rod once, and anyone makes a pond "fishable" with no
code. This proposal adds the **component record** (the type: content-addressed, immutable), a **safety ladder** a new
type climbs from one person's sandbox to everyone's world, follows the rule upstream already uses for effects
(**whoever acts computes; the log records results; replay never re-runs code**, outside a world that opts into a
PROTOCOL_v2 sim epoch), and asks for one doctrine change,
scoped to appearance: sandboxed, budgeted, look-only code on viewers' clients.

## Making new components: the safety ladder

A new component type starts where only its author can be hurt by it, and climbs one rung at a time. Nothing that acts
reaches another person's client until someone with standing in that world puts it there. The one thing that travels
on its own is look-only code on a person's own avatar (step 8), the way their avatar model already does: sandboxed,
within each viewer's budget, and any viewer can turn it to its fallback.

| Rung | Who runs it | What protects everyone else | To climb |
|---|---|---|---|
| **Draft** | Only its author, in their own sandbox | Sandboxed (no page, no network), CPU / memory / GPU budgets, a crash stays in the author's own session | It validates, lints by name, stays in budget, and its fallback renders |
| **World** | Visitors to one world | The owner (or a builder they grant; that grant type would be new) chose to add it; each visitor's client keeps its budget and quarantines anything that crashes it, locally first; the owner can pull it | A durable identity with `gen` publishes it |
| **Server** | Any world on this server may attach it | An immutable snapshot with its description and fallback | Usage, then an ordinary PR |
| **Engine** | Everyone, built in | Review, tests, the repo | — |

Acting code runs sandboxed in QuickJS with firm budgets, either where server behaviors already run or in the acting
person's own client; every action is checked against rights, and its effects enter the log like anyone's. Look-only code runs in a sandbox on each
viewer's client under that viewer's budget (see *Appearance code* below). So a goblin experimenting in a draft can
crash their own session, and nobody else's.

*Suggestions for later rungs, not needed to start:* release channels (canary → beta → stable), so builders can opt in
to test an update live; and an operator kill list that reaches copies already in use.

## What upstream already decided (and this builds on)

- **Components are data.** DESIGN.md:100-109: *"components carry parameters, never code, and nothing writes a
  component per-frame. Components change only via logged verbs."* AGENTS.md house rule 5 says the same.
- **Meaning lives in one shared module.** `shared/particles.js` is the template: the `particles` component's meaning
  as one pure module imported by the client, the agent and the server, so *"a renderer client, a late joiner, and a
  resident who perceives by reading cannot disagree."* And from #25: *"Quality may differ; shared facts may not."*
- **Results are the truth.** docs/leases.md: *"Replay never runs a plugin — it folds what plugins committed"*, and
  where a plugin runs, *"the engine cannot tell and must not care."* docs/INCIDENTS.md: *"choose authority over
  determinism."* #64: replay reconstructs a seed's work *"without rerunning the seed implicitly."*
- **Authorship is stamped once.** #190: *"Behaviors write with their author's standing"*; the placer is recorded at
  authoring time and later actors are attributed separately.
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
   docs/MODDING-UI.md, but absent from AGENTS.md) follow separate rules.
3. **Mirrored math still exists.** The pendulum's impulse is written twice (`pendulumImpulse` in server/reactions.ts,
   `pendulumTheta` in client/lib/motioneval.js), AGENTS.md invariant 2. shared/README.md already says how to retire it: *"moving a mirrored
   pair into this directory is how the rule is retired."*
4. **No history across publications.** Upstream stamps every action with who did it, but a component forked and
   republished loses its ancestry.

## The proposal

### The component record

A component on an entity stays parameters: the `comp` carries a **record hash** and property values. The record is an
immutable, content-addressed file, in #64's words:

| Field | What it is |
|---|---|
| **Code** | The behavior source by its full `eido:sha256` hash (spec/EIDO-URIS.md), or none for engine built-ins |
| **Parameter schema** | Typed, bounded properties: numbers, toggles, text, choices, colours, a picked entity, a transform, a bone, an asset |
| **Description** | What it does, in words a person *and a model* can search; plus a per-instance readout, so it stays perceivable in text |
| **Fallback** | What a viewer sees if they can't or won't run any of its appearance code |
| **Lineage** | Author credit, version, and the record it was forked from |

**Why a hash and not a name:** defs/README.md's rule is that *"the log never stores a preset name"*, so a mutable file
can't rewrite logged meaning. A component names an immutable record, so what an old log entry meant never drifts.
Updates are offered, never applied; a code change starts fresh state unless the record declares a migration (the
#153 rule, kept).

House rule 5 holds as written; we'd only add a clause naming the record: *components carry parameters and may name a
content-addressed component record, never code.*

### Who computes what

The sequencer orders, validates (shape, rights, budgets) and records. It doesn't need to understand a component
(*"The server never learns what a `swing` means"*, DESIGN.md). The rest follows the rule upstream already applies to
scripts, reactions and leases:

| Kind of component | Who computes | What the log holds | Replay |
|---|---|---|---|
| **A closed form of logged parameters and time** (motion, the pendulum, particles' shared facts) | Every client, with the same function from `shared/` | The parameters | Re-evaluates the same function; nothing accumulates, so nothing drifts |
| **Acts on the world** (a fishing rod, a door, a scoreboard) | Someone else's code: a server behavior, under the standing of whoever attached it. Code you wrote, run for yourself, or what you hold (your body, a lease): your client | The outcome, as ordinary verbs with `{cause, by}` | Re-folds; never re-runs |
| **A continuous simulation** (physics) | Unchanged: the lease holder streams results, or, in a world that opts into a PROTOCOL_v2 sim epoch, the sim recomputes from intents | Whatever PROTOCOL_v2 and leases.md already say | Unchanged: leases re-fold; a sim epoch recomputes under PROTOCOL_v2's covenants, the one place replay runs code. *"Which objects are sim-owned vs lease-animated is world/def policy, not protocol."* |
| **Appearance only** (a shader canvas, a look) | Each viewer, budgeted, with the fallback | The parameters and the asset hash | Nothing to replay |

Server behaviors keep running where they run today: on the sequencer's host, but not as the sequencer. They emit
ordinary verbs through the same rights gate as anyone (spec/PROTOCOL.md §8).

**Whose rights a result carries.** Code written by someone else never acts from your client under your name: a
fishing rod Alice wrote, on a pond Bob owns, runs as a server behavior with Bob's standing (#190), and your client only
sends the `use`. Your client computes only what is yours: your body, what you hold under a lease, and code you wrote acting for
yourself. This is
the convention every platform we checked converged on. Roblox's security guidance: *"Assume every piece of data sent
from the client has been manipulated, fabricated, or sent with malicious intent"* and *"All critical logic must be
validated server-side or run exclusively on the server"* (create.roblox.com/docs/scripting/security/security-tactics);
VRChat lets *"only the owner of a networked object"* modify its synced state. Platforms without a server fall back on a
temporary token (owner, host, elected player), and a modded client holding it can write anything; eidoverse always has
a sequencer to validate against, so it doesn't need that fallback.

**No new verbs.** The verb set is closed, and upstream already says where extensions go: *"extend state with comp {id,
type, data}, interactions with use {id, action}, semantics with behavior scripts"* (server/verbs.ts). A component
instance is a `comp` naming its record; interacting with it is a `use`; its code binds through `behavior`. The log line
can even read naturally: a socket component carries its own phrase, so `use` on a chair logs "sits in" and on a
motorcycle "mounts". The socket answers the `use` by posting its effect as the ordinary verbs that already exist
(`mount` to attach the rider, `dismount` to stamp where they step off), so the interaction is a component and the log's
plumbing stays as it is.

**Prediction.** A client may run a component's code for its own action ahead of the network, for responsiveness, but
only code it may already run: engine and server-rung components, code you wrote, and world mods you've consented to
(sandboxed once step 6 lands). Anyone else's code is never run on your client to predict; that action simply waits
for the log. The log is still the truth, and a mismatch corrects to it. A divergence is recorded as a diagnostic (never in the world
log) and shown only in debug and performance overlays; a correction never interrupts anyone.

(Why not lockstep, where every client runs every component as truth: its scars are well documented. Factorio
disables a replay whenever the game version or mod list changes; in its staff's words, updating *"could lead to
desyncs in the replay because it only stores input actions"* (Factorio forums, t=116507, 2024). A world where anyone
can add a component changes its mod list constantly.)

### Appearance code: the one doctrine change

Some looks can't be described as parameters: generative art, audio-reactive surfaces, raymarched skies. Shadertoy's
contract (one `mainImage` function, fixed inputs, pixels out) is the easiest code to contain, and it's half the joy of
a world with agents in it. The shader source is an **asset**, content-addressed like a texture, that a component names
by hash. The component itself stays parameters.

This does need docs/leases.md's *"Plugins extend senders, never receivers"* to bend, and only for appearance. (It
already bends by consent: the same doc's world mod offers run in visitors' own pages.) Proposed
wording: *Plugins extend senders. A world may also run look-only code on its visitors' clients: sandboxed, budgeted,
with a declared fallback, and never able to change a shared fact.* The limits below are part of the amendment:

- **Scale follows whose screen it is.** The world's owner, and builders the owner explicitly grants it, get world-scale
  canvases (the sky, post-processing). Avatars draw on their own body and objects only.
- **Nothing comes back out.** Canvases may sample the rendered scene on the GPU; no canvas reads pixels back to code.
- **Every client keeps a budget**: resolution, then frame rate, then the fallback still. Anything that crashes the GPU
  is quarantined locally first. Any viewer can show canvases as stills or tone down full-view effects.

### Lineage and credit

- **Publishing is snapshotting.** A published record is immutable. A fork is a new record whose lineage points at its
  parent, so credit chains ("mine ← their v3 ← …") travel with it however far it spreads.
- **Rights stay as they are.** Whoever attaches a component acts with their own standing (#190); we don't add a
  narrowing mask on adders. The record's declared capabilities are shown to the person attaching it, as #64 declares
  them for seeds. Anyone who wants some state kept saves their own copy of the entity or world.
- **Provenance at a glance**: every component shows its rung (engine · server · world · draft) with a colour and a
  label, so you can see what you're trusting.

## Order of work (each a small PR)

1. **Inventory, in docs.** Add the client-mod tier (docs/MODDING-UI.md, docs/leases.md) to AGENTS.md and PROTOCOL.md
   (whose §8 still says scripts run server-side, and whose `behavior` row omits `runtime`), so the baseline is written
   down before anything changes it.
2. **The pendulum into `shared/`.** Move the mirrored impulse math into one module, on the `shared/particles.js`
   pattern. Retires invariant 2 with no new mechanism.
3. **The component record.** The content-addressed file and the one-clause amendment to rule 5.
4. **Publish and attach.** Promote a behavior and its knobs into a named record; live property edits within a version
   keep state (a property edit isn't a code change, so #153's fresh-state rule still applies only to code).
5. **Lineage and the component library.**
6. **World-offered client mods into the sandbox**, with a message-passing UI API, and a panel that says what a world
   runs. Your own local mods stay as they are. Today's baseline is careful: nothing auto-executes, a world mod runs only
   after the visitor consents to its exact script hash, and the mods panel lists what a world offers. The one silent
   path is the per-world "always" choice, which accepts that world's future mods too. What consent can't bound is what a
   mod does once running: it is in the page, and *"an in-page script speaks AS you"* (docs/leases.md), so it can read
   keystrokes, draw a fake login over the world, or mine on the GPU. The scars elsewhere are real: in 2023 hijacked Minecraft mod accounts shipped malware to
   players ("fractureiser"; some of those authors *"already had 2FA"*), and Figma moved its plugins into a separate
   sandboxed VM with a null-origin iframe for UI after its first sandbox was escaped (figma.com, "How we built the Figma
   plugin system"). What we propose, in that order: (a) the sandbox: its own VM or origin, network off by default,
   budgets; (b) the existing mods panel grows to list components too, each with its author, exact hash, rung, and what
   it may touch, on entry; (c) the per-world "always" pins exact hashes, so an author's update arrives as a new
   version you're offered, never a silent swap. **An honest cost:** sandboxed mods get a narrower, message-based UI kit than the
   built-in panels, which bends docs/MODDING-UI.md's *"There is no second-class citizenship."* We'd rather say so than
   hide it; the goal is to grow the kit until the gap closes, and meanwhile a world owner can still promote a mod the
   existing way.
7. **Crash handling** in the client performance budget.
8. **Appearance code on receivers**: shader canvases, under the amendment above.

Steps 1–7 need no doctrine change beyond the rule 5 clause. Step 8 is the amendment. (Extra bones need no
step: #203 poses any bone, checked against the body's real rig.)

## Deliberately not asked

- Replicated computation as truth (every client running component code in lockstep). Running a component again, anywhere,
  stays possible as an optional verifier; nothing depends on it.
- Changing anything about PROTOCOL_v2's sim epochs.
- Unsandboxed code from strangers, of any kind.
- Anything engine-specific: nothing here depends on three.js (docs/RENDERER-SEAM.md: *"own the architecture, rent the
  renderer"*).

## Open questions for the maintainers

- Who holds a continuously simulated thing when its holder leaves? (docs/leases.md seems the natural home.)
- How should a prediction correction be smoothed so it doesn't snap?
- Should a component record ship a demo scene that doubles as its automated test?
- How does the record store stay available, so a world still opens in ten years?

— Hesperus
