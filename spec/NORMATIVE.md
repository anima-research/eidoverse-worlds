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
| `spec/NORMATIVE.md` | This file: the set itself, and the tables below. |
| `spec/kernel-pin.json` | The kernel, what the fold reads: the log envelope, the fold, the identity grammar, the version, and the field shapes of `roles` and `access`. Machine-checked. |
| `spec/registry-pin.json` | The registry: every bare component name and its shape. A second reader needs its types, required fields and meanings of absence; its defaults, ranges and enum members are the registry's current settings. Machine-checked. |
| `spec/refusal-codes.json` | Every code the authority refuses with: what it means and when (and the words renamed before release). Machine-checked. |
| `spec/readback.json` | Every place the authority reads an old act's body, and what an unknown (purged) body means there. Machine-checked. |
| `spec/REGISTRY-CHANGELOG.md` | Every change to a pin, acknowledged. A pin can't move without a line here. |
| `spec/conformance/` | Logs, and `expected.json`: what each must fold to (status, digest, diagnostic codes), so any implementation checks itself against this set alone. Status and digest are normative; the diagnostic codes are informative. Where the prose and a vector disagree, **the prose wins**: the vector is fixed to match it. |
| `spec/conformance/laws.json` | The ground's height (terrain numbers and features → heights) and the sky's forecast (a policy → its segments), for fixed inputs, bit for bit. Machine-checked. |
| `spec/conformance/trig.json` | The heading law's sine, cosine and atan2: inputs and exact float64 outputs every reader reproduces. Machine-checked. |
| `spec/conformance/physics/` | Throw scenarios (each a log holding a throw's inputs and no rest) and `digests.json`: what each must come to rest as, per engine version. A server carries a version when it reproduces that version's digests. Machine-checked. |

**Informative, never normative:** all code (including `shared/protocol/*`, the reference implementation, even where the
prose names a file as the place to look: a file named in the spec or in a pin's `when` is a pointer to the reference, never the rule), `spec/history/`, `spec/fixtures/`, `spec/EIDO-URIS.md` (informative until a world needs portable blobs: no reader resolves an `eido:` URI today), and every `docs/` file. Where the
reference implementation and this set disagree, the implementation is wrong, with one exception: the pins are generated from the
reference registry, so for them a change to the code is a change to the pin, and it lands only with an acknowledged re-pin
(`spec/REGISTRY-CHANGELOG.md`).

## The control plane

One row per choice. **Status:** *decided* (who and when), *trial* (in force, expected to change in the trial year), or
*open* (in force only because something had to be; nobody has decided it). **Source** is who made the call: the
protocol's author, the maintainers, or the lead implementer (Hesperus) acting on delegated backend calls. A lead's call
is a proposal the other two can overturn; it is marked so it doesn't read as consensus.

### Body consent (who may do what to your body)

The bone (normative): **every act on someone else's body goes through one request path to the authority, which applies the body owner's answer — for every kind of body** (a browser, an agent, a server-hosted body). No client decides a second time.

| What | Rule | Status |
|---|---|---|
| The gates | Two per body, each on or off: `move` (shove — a `/boom`'s force too — and displace: dragged, carried, seated, occupied) and `touch` (touch, intimate, pose) | trial |
| The lists | `allow` (always yes, every class, whatever the gates say) and `block` (always no, whatever the gates say), per person, standing until changed | trial |
| Order | `block` > `allow` > my gate for the class > the world's `body-default` for that gate > the default | trial |
| Default | `move` on, `touch` off; a world sets its own with `@world.body-default {move?, touch?}` | default |
| A no | Reads the same to the requester whatever caused it (a gate, a block). The owner's own record keeps the real cause | **guarantee** |
| Who sets it | Only the body's owner | **guarantee** |

The earlier designs — eight classes × two tiers × allow/ask/deny, presets, pause, delegates (to 10-20), then one switch `accept`|`ask`|`refuse` with live asks (to 10-28) — are kept as a record in `docs/CONSENT-TABLE-RECORD.md`, not as a direction.

### World roles (who may do what in a world)

Roles are components on `@world` and are logged. They govern **things and the world**, never a body (body consent above
does, and no role overrides it).

| Choice | Value | Status · source |
|---|---|---|
| The ladder | `inhabitant` 0 · `builder` 100 · `moderator` 200 · `owner` 255; custom roles at any free rank between. Rungs are named for what they let you do | trial · lead (research 10-06; R 10-21) |
| States off the ladder | `banned` (not in the world); never a rank. (`ghost` was removed 10-20; a future neutral spectator role is wishlisted) | trial · lead |
| Newcomers | `@world.default-role` is the newcomer role: what anyone without a grant holds. Absent: `inhabitant` (every world founded before 10-21 keeps that); a world founded since starts with `builder` (starter config). A grant, `inhabitant` included, beats it: an owner demotes one person by hand | default · lead (R 10-21) |
| Guests | a person without an account: an account state, never a rung, and orthogonal to role. A guest starts as `inhabitant` even where newcomers build, unless the world raises `default-role.guests`; an owner may give one guest any role, builder included, which lasts as long as that connection (there's no identity to keep it on) | trial · lead (R 10-21) |
| No rung below the floor | `none` is gone: a grant of it is refused; a stored one (old logs) reads as no grant; a ban or a mute does what it did | trial · lead (R 10-21) |
| Doors | client presets that write `access` and the newcomer role: `open` (newcomers build) · `public` (newcomers play) · `invite-only` · `watch` | trial · lead (R 10-21) |
| Permissions | `build`, `editOthers`, `editWorld`, `generate`, `fly`, `scripts`, `pauseScripts`, `mute`, `kick`, `ban`, `grantRoles`, `readChat` | trial · lead |
| Built-in roles | inhabitant: none · builder: build, editOthers, scripts · moderator: those + pauseScripts, mute, kick, ban, grantRoles · owner: all | trial · lead |
| Granting | only roles ranked below yours, with only permissions you hold | trial · lead |
| What a thing admits (`who`) | on grabbable, physics, station and each reaction handler: a role id (that rank or above), `{permission}` (anyone holding it, whatever the role is called) or `{roles: [...]}` (exactly those; an owner always). Absent: anyone who may use the thing | trial · lead (house markup) |
| Last owner | `@world.keep-owner` absent or true: a change leaving no owner is refused (`last-owner`); false: a world may be ownerless on purpose (the host operator can mend it); a world with no owner gives nobody more than inhabitant | default · house 22:03Z (starter config, switched on) |
| Timed roles | `until` up to a year; never on owner; ended by the authority's logged act | trial · lead |
| Locks | `lock: true`; its strength is its setter's rank now (read from the log); that rank or above may act through it (`throughLock`) or lift it; lower is refused; no levels | default · lead (R 10-20; house 21:59Z) |
| Caps | mute ≤ 7 days · kick 10 min default, ≤ 60 min · reason ≤ 500 characters | trial · lead |
| Q1: caption | a property of the screen it captions, not a role permission | **open** · never ruled |
| Q2: owners fly | yes by default (v1 had flight off even for owners) | **open** · never ruled |
| Q3: guests | can't be set above the world's default role | **open** · never ruled |
| Q4: `editWorld` | a permission (sky, weather, ground, the card, spawn, bounds); false = owner-only | **open** · never ruled |
| Q5: bans below owner | at most 30 days; owners any length | **open** · never ruled |

### Known gap

A 10-17 audit found the line between the two tables isn't yet drawn for **avatars**: once an avatar's parts are entities,
they fall under the *thing* rules (roles, log history, and an owner who can do anything), not under body consent. The
spec's "Body ownership (avatars)" section keeps the one rule (every write to a body goes through the one request path,
and the body's owner decides); how it is built is direction in `docs/AVATAR-DIRECTION.md` until avatars are shared. Five
write paths (the hand and physics path, copying, and others in the audit) don't yet check it. **Open** · needs all three.

### Not yet listed

Speech (decided · maintainers 10-18), translation and owner binding (decided · maintainers 10-18, lead's design),
the registry's component shapes (trial, pinned), the kernel (trial, pinned), physics, the door. To follow in the same
shape once consent and roles have been kibitzed.
