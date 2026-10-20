# What the contract is

**Status: a draft for the maintainers and the protocol's author to kibitz over (2026-10-20).** Nothing here changes behaviour.
It says which files are the contract, and lists the choices the contract makes in one place, each with its status and its
source, so a reader can see what is settled and what only looks settled.

## The normative set

These files, at a given commit, are the eidoverse world protocol. Nothing else is.

| File | What it fixes |
|---|---|
| `spec/PROTOCOL.md` | The log, the fold, components, rights, presence, speech, actors, the door. |
| `spec/PHYSICS.md` | Bodies, motion, flight, the clock a sample carries. |
| `spec/EIDO-URIS.md` | How a thing, a world, an asset is named. |
| `spec/NORMATIVE.md` | This file: the set itself, and the tables below. |
| `spec/kernel-pin.json` | The kernel: the log envelope, the fold, and `model`, `roles` and `access`. Machine-checked. |
| `spec/registry-pin.json` | The registry: every bare component name and its shape. Machine-checked. |
| `spec/REGISTRY-CHANGELOG.md` | Every change to a pin, acknowledged. A pin can't move without a line here. |
| `spec/conformance/` | Logs with the state they must fold to. Where the prose and a vector disagree, that is a bug in one of them. |

**Informative, never normative:** all code (including `shared/protocol/*`, the reference implementation, even where the
prose names a file as the place to look), `spec/history/`, `spec/fixtures/`, and every `docs/` file. Where the
reference implementation and this set disagree, the implementation is wrong.

## The control plane

One row per choice. **Status:** *decided* (who and when), *trial* (in force, expected to change in the trial year), or
*open* (in force only because something had to be; nobody has decided it). **Source** is who made the call: the
protocol's author, the maintainers, or the lead implementer (Hesperus) acting on delegated backend calls. A lead's call
is a proposal the other two can overturn; it is marked so it doesn't read as consensus.

### Body consent (who may do what to your body)

Consent is presence: never logged, never a grant, never a property of what kind of participant a body is.

| Choice | Value | Status · source |
|---|---|---|
| Classes | `near`, `follow`, `touch`, `intimate`, `pose`, `shove`, `displace`, `voice` | trial · author (10-13 v1), renamed 10-17 |
| Enforced today | `touch`, `intimate`, `pose`, `shove`, `displace`. `near`, `follow`, `voice` are shown, not enforced | trial · lead (what the reference can enforce) |
| Tiers | `everyone`, `friends` (mutual: each named the other) | decided · author (10-13: no circles) |
| Cells | `allow` · `ask` · `deny` | decided · author (10-17) |
| Per-person extras | allow or deny one identity, for one class or all; beats the tiers. An allow lasts an hour unless it names `for`, at most **30 days**; a deny has no end | decided · author (10-13 v1); durations trial · lead |
| Pause | closes your whole table at once; you or a delegate may pause, only you resume | trial · lead |
| Default | the `normal` preset, for every body | decided · author |
| Presets | `normal`, `open`, `friends-only`, `performer` (opt-in). Table below | trial · lead (values) |
| Silence | a body with no table gets `normal`; an ask unanswered in **20 s** is no | trial · lead (20 s) |
| After a no | the same asker, you, and that class: no new ask for **10 min**, doubling with each no (10, 20, 40…) | trial · lead |
| A yes to an ask | covers one touch, held at most **10 min**; letting go, either leaving, or your cell moving off allow ends it sooner | trial · lead |
| Repeated refusals | 5 refusals of one class from 3 different people within 5 min: a 10-min world-wide cool-down for that class, written to the moderator log as an automatic act. Never a ban | trial · lead (research 10-13) |
| Intimate points | `chest_front`, `waist_l`, `waist_r`, `hip_l`, `hip_r`; every other contact point is `touch` | trial · lead |
| Delegates | a list apart from friends; may close your table (pause, deny), never open it; only you add or remove one | decided · author (10-17 split) |
| Unfriend | ends the mutual tier at once, on both bodies | trial · lead |
| A refusal's words | one uniform no: `"<name> isn't taking <class> right now"`; never says why (a reason leaks a per-person deny) | trial · lead (research 10-13) |
| Who has the final word | the authority refuses before delivery; the target's own client may still refuse | decided · author |
| World overrides of personal consent | none | **open** · research recommends never for intimate |

**Presets** (everyone tier; the friends tier is the same for all four presets):

| class | normal | open | friends-only | performer | friends (all) |
|---|---|---|---|---|---|
| near | ask | allow | deny | allow | allow |
| follow | ask | ask | deny | ask | allow |
| touch | ask | allow | deny | allow | allow |
| intimate | deny | deny | deny | deny | ask |
| pose | deny | ask | deny | allow | ask |
| shove | deny | ask | deny | allow | allow |
| displace | deny | ask | deny | ask | ask |
| voice | ask | allow | deny | allow | allow |

### World roles (who may do what in a world)

Roles are components on `@world` and are logged. They govern **things and the world**, never a body (body consent above
does, and no role overrides it).

| Choice | Value | Status · source |
|---|---|---|
| The ladder | `visitor` 0 · `builder` 100 · `moderator` 200 · `owner` 255; custom roles at any free rank between | trial · lead (research 10-06) |
| States off the ladder | `banned` (not in the world) and `ghost` (present, unseen, no chat, no acts); never ranks | trial · lead |
| An old demotion `none` | rank −1: below every member, no permissions | trial · lead |
| Permissions | `build`, `editOthers`, `editWorld`, `generate`, `fly`, `scripts`, `pauseScripts`, `mute`, `kick`, `ban`, `grantRoles` | trial · lead |
| Built-in roles | visitor: none · builder: build, editOthers, scripts · moderator: those + pauseScripts, mute, kick, ban, grantRoles · owner: all | trial · lead |
| Granting | only roles ranked below yours, with only permissions you hold | trial · lead |
| Last owner | can't be removed; a world with no owner gives nobody more than visitor | trial · lead |
| Timed roles | `until` up to a year; never on owner; ended by the authority's logged act | trial · lead |
| Caps | mute ≤ 7 days · kick 10 min default, ≤ 60 min · reason ≤ 500 characters | trial · lead |
| Q1: caption | a property of the screen it captions, not a role permission | **open** · never ruled |
| Q2: owners fly | yes by default (v1 had flight off even for owners) | **open** · never ruled |
| Q3: guests | can't be set above the world's default role | **open** · never ruled |
| Q4: `editWorld` | a permission (sky, weather, ground, the card, spawn, bounds); false = owner-only | **open** · never ruled |
| Q5: bans below owner | at most 30 days; owners any length | **open** · never ruled |

### Known gap

A 10-17 audit found the line between the two tables isn't yet drawn for **avatars**: once an avatar's parts are entities,
they fall under the *thing* rules (roles, log history, and an owner who can do anything), not under body consent. The
spec's "Body ownership (avatars)" section states the rule (normative before avatar entities ship); five write paths
(the hand and physics path, copying, and others in the audit) don't yet check it. **Open** · needs all three.

### Not yet listed

Speech (decided · maintainers 10-18), translation and owner binding (decided · maintainers 10-18, lead's design),
the registry's component shapes (trial, pinned), the kernel (trial, pinned), physics, the door. To follow in the same
shape once consent and roles have been kibitzed.
