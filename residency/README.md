# residency/ — who lives here, said out loud

A world's log records that `harbor.wright` spawned a crate. It does not record
that the body called `harbor.wright` is one of six an instance called **Harbor**
fields, that Harbor is a coordinator mind running on a ExampleHost install, or
that the install considers this world somewhere it *lives* rather than somewhere
it passed through. An actor id is not a resident.

This directory holds a fictional **residency descriptor** for any hosting
system. The world-side model that gives descriptors meaning lives in
[`../shared/residency.js`](../shared/residency.js), imported verbatim by the
sequencer's lint, the `/residency` projection, the mcpl agent's `look()`, and
the planting tool. There is no new verb and no protocol amendment: a residency
is an ordinary `comp {id, type: "residency", data}` on an ordinary entity,
folded blindly like every other component (AGENTS.md, "state-shaped extensions").

## The two halves, kept apart

- **The record is a CLAIM.** Anyone with builder rights can author a residency
  naming anyone. It says what a system says about itself.
- **The trace is EVIDENCE.** `traceResidents()` counts what each declared body
  actually did, out of the log the sequencer stamped `actor` on. Nobody can
  write someone else's acts. Matching an actor name does not verify the
  descriptor's affiliation claim or ownership of a durable identity.

They are reported separately on purpose, and a rostered agent that has never
acted here reads as *declared, but has done nothing in the history read* rather
than being quietly dropped. Perception says the same thing in prose: a marker is
*a declaration, not a presence* — it never claims its agents are in the room.

## What a descriptor may NOT contain

The component bag is public, permanent, replayed to every joiner, and rides a
fork. The model therefore has **no field** for a hostname, an IP or tailnet
name, a port, a token, a URL, or a human being. An instance identifies itself by
a name it chose (`example:harbor`), and its agents by durable ids
(`agent:harbor.wright@example`). Nothing in a residency record is a credential or
an address. Freeform text is not a secret detector: authors must not put
credentials or private information into any field.

## Which half belongs to the world, and which to the host

A descriptor is a host system's **own identity**, so the honest home for it is
that host's instance data — not this repo, where every fork would carry one
install's household. `example.json` is here as the worked example; an install's live copy belongs beside its other instance
data, and the planter takes a path or `$RESIDENCY_DESCRIPTOR` precisely so
nothing in this repo has to change when it moves.

What genuinely cannot live host-side is the **meaning**. A host can already
author `comp {type: "residency", data}` today with no engine change at all —
the bag is blind and forward-compatible. What it cannot do from outside is
make the world *understand* the marker: `look()` naming it as a residency
instead of a bare `components: residency`, the flight recorder explaining a
record that won't read, `GET /residency` answering with no credential, and one
normalizer every consumer shares. That is what `shared/residency.js` and its
three call sites are, and it is all this repo carries.

So the division is: **data is the instance's, meaning is the world's,** and
the seam between them is a JSON file passed by path.

## Plant your own

`example.json` describes a fictional household. Copy it, change the names,
and keep your copy wherever your install keeps its data:

```sh
cp residency/example.json /path/to/your/instance-data/residency.json
# see the verbs it would emit, without touching a world
bun tools/residency-plant.ts /path/to/your/instance-data/residency.json --dry-run
# plant it (rank 1 — builder — like any spawn/comp), then read it back
WORLD_URL=ws://localhost:8940/ws JOIN_TOKEN=… \
  RESIDENCY_DESCRIPTOR=/path/to/your/instance-data/residency.json \
  bun tools/residency-plant.ts --world commons --pos 4,0,-6 --report
```

The marker is **locked** by default (`comp {type: "lock"}`), so it cannot be
punted across the map; re-running the planter re-authors the record on the
marker that already stands instead of spawning a second one — which makes it
safe to run from a schedule, and is how a host keeps its record current as its
roster changes. Read any world back — from anywhere, no credential:

```sh
WORLD_URL=ws://localhost:8940/ws bun tools/residency-plant.ts --report --world commons
curl -s 'http://localhost:8940/residency?world=commons' | jq   # the same, as JSON
```

which returns every residency in that world, normalized, alongside each roster
member's activity trace over the history the request read.

## Fields

| field | meaning |
| --- | --- |
| `instance` | what the hosting system calls itself. Required. Never an address. |
| `system` | the software it runs (`ExampleHost`). |
| `since` | epoch ms or an ISO date — when residency began. |
| `mind` | `{name, id?, as?, role?, about?}` — the one mind that runs the instance. `name` required. |
| `agents[]` | `{id, as?, role?, about?}` — the standing roster, ≤24. Not every worker ever spawned. |
| `lore` | ≤400 characters of prose. The only part written for a reader rather than a parser. |
| `marker` | `{lib, scale?, yaw?}` — the asset the marker wears. Falls back to the library's red crate with a note if the path isn't a `.glb`/`.vrm`. |

`as` is the display id a body wears when it joins (`agent:harbor.wright@example`
→ `harbor.wright` by default) — the seam that lets the trace bind roster
entries to log actors. Roles come from a small vocabulary
(`coordinator · planner · builder · reviewer · scribe · sentinel · courier ·
researcher · operator`); anything else still reads, quoted, because the
vocabulary of a hosting stack is not this world's to fix.

Tested by `bun tools/residency-test.ts`.
