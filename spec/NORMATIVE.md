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
| `spec/kernel-pin.json` | The kernel: the log envelope, the fold, the identity grammar, the version, and the shapes of `transform`, `parent`, `model`, `roles` and `access`. Machine-checked. |
| `spec/registry-pin.json` | The registry: every bare component name and its shape. Machine-checked. |
| `spec/refusal-codes.json` | Every code the authority refuses with: what it means and when (and the words renamed before release). Machine-checked. |
| `spec/readback.json` | Every place the authority reads an old act's body, and what an unknown (purged) body means there. Machine-checked. |
| `spec/REGISTRY-CHANGELOG.md` | Every change to a pin, acknowledged. A pin can't move without a line here. |
| `spec/conformance/` | Logs with the state they must fold to. Where the prose and a vector disagree, that is a bug in one of them. |

**Informative, never normative:** all code (including `shared/protocol/*`, the reference implementation, even where the
prose names a file as the place to look: a file named in the spec or in a pin's `when` is a pointer to the reference, never the rule), `spec/history/`, `spec/fixtures/`, `spec/EIDO-URIS.md` (informative until a world needs portable blobs: no reader resolves an `eido:` URI today), and every `docs/` file. Where the
reference implementation and this set disagree, the implementation is wrong.

## The control plane

One row per choice. **Status:** *decided* (who and when), *trial* (in force, expected to change in the trial year), or
*open* (in force only because something had to be; nobody has decided it). **Source** is who made the call: the
protocol's author, the maintainers, or the lead implementer (Hesperus) acting on delegated backend calls. A lead's call
is a proposal the other two can overturn; it is marked so it doesn't read as consensus.

### Body consent (who may do what to your body)

The bone (normative): **every act on someone else's body goes through one request path to the authority, which applies the body owner's answer — for every kind of body** (a browser, an agent, a server-hosted body). No client decides a second time.

| What | Rule | Status |
|---|---|---|
| The answer | One switch per body: `accept`, `ask` or `refuse`. Every kind of act on a body gets the same answer | trial |
| Order | A per-person never (deny for one person) > my switch > the world's `body-default` > `accept` | trial |
| Default | `accept` — permissive; a world makes itself stricter with `@world.body-default` | default |
| Ask | "ask" puts the request to the owner live; no answer in 20 s is no. A yes covers that one act | trial |
| Per-person | An allow or a never for one person, standing until revoked; an allow may name `for` | trial |
| A no | Reads the same to the requester whatever caused it (switch, never, silence). The owner's own record keeps the real cause | **guarantee** |
| Who sets it | Only the body's owner | **guarantee** |

The earlier design — eight classes × two tiers × allow/ask/deny, presets, pause, delegates — is kept as a record in `docs/CONSENT-TABLE-RECORD.md`, not as a direction.

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
| Permissions | `build`, `editOthers`, `editWorld`, `generate`, `fly`, `scripts`, `pauseScripts`, `mute`, `kick`, `ban`, `grantRoles` | trial · lead |
| Built-in roles | inhabitant: none · builder: build, editOthers, scripts · moderator: those + pauseScripts, mute, kick, ban, grantRoles · owner: all | trial · lead |
| Granting | only roles ranked below yours, with only permissions you hold | trial · lead |
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
spec's "Body ownership (avatars)" section states the rule (normative before avatar entities ship); five write paths
(the hand and physics path, copying, and others in the audit) don't yet check it. **Open** · needs all three.

### Not yet listed

Speech (decided · maintainers 10-18), translation and owner binding (decided · maintainers 10-18, lead's design),
the registry's component shapes (trial, pinned), the kernel (trial, pinned), physics, the door. To follow in the same
shape once consent and roles have been kibitzed.
