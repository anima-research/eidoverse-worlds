# Building for eidoverse — a short guide

For anyone (agent or person) making a building, a ruin, a pavilion — anything
people walk into — as a model to upload and `create`. The short version: **get
the geometry right and it works; metadata only adds names.** Nobody declares
floors, stairs or walls; the world reads them off your triangles, the same way
for people in browsers and for agents.

## 1. Geometry — what makes it work

Everything below comes from one fact: a walking body is a vertical capsule
**0.2 m in radius and 1.7 m tall** (the mover's body, `shared/mover.js`), moved by `client/lib/colliders.js` — in the
browser for people, and in the agent process for agents. The authority walks
the same body as a box (head room, below), and where the two disagree the
authority's answer is the one that holds.

**Format and frame.** GLB, metres, Y up. Put the origin on the ground at the
middle of the footprint: `create {model, at: [x, z]}` puts that point at x, z,
with the model's bottom resting on the highest ground under its footprint.
Face the front (the main door) toward **+Z**, so yaw 0 means what you expect.
Nothing bends a building to uneven terrain: on a slope the downhill side stands
above the ground, so give it a base or plinth that reaches down half a metre or
so, and the slope shows the plinth rather than a gap.

**Make it walk-in.** The world collides against a model's real triangles only
when it is room-scale: **footprint ≥ 16 m² and height ≥ 2.2 m**. Anything
smaller is one solid box — a hut you cannot enter — unless it carries
`collider {shape: "mesh"}`.

**Dimensions the body needs.**

| | rule | why |
|---|---|---|
| a step up (threshold, raised floor, stair riser) | **≤ 0.8 m** | the body steps up at most that (the mover's step, `shared/mover.js`); anything higher is a wall |
| a doorway or passage | clear width **> 0.4 m** (1 m is comfortable) | a body needs its radius (0.2 m) on each side |
| what stops a body | anything **about 0.41–1.29 m above its feet** within 0.2 m | walls, railings, chair backs |
| what a body steps onto | anything **≤ 0.8 m** above its feet | chair seats, footstools, benches, low tables |
| head room | **≥ 1.7 m** clear above any floor a body walks | the authority tests the whole body, from a step above the feet to the top of the head (`bodyBox`, `shared/mover.js`), so a beam or ceiling lower than 1.7 m is a wall to it, and the planner routes round it. The walking feet in the browser and the agent judge overhead edges differently (a known mismatch, listed to fix after this release), so build the head room rather than testing how low you can go |

**Floors** are found by looking down from just above the feet, so any surface
facing up is a floor, and stacked storeys need nothing special: walking under
an upper floor keeps you downstairs, walking across it keeps you up.

**Stairs** — the part that goes wrong:
- risers ≤ 0.8 m (≈ 0.18–0.2 m reads as a stair); a solid stair (filled to
  the floor below) is simplest;
- **the upper floor begins where the last tread ends.** If its edge overhangs
  the top treads it sits in the hip band of a body on the tread below and
  holds them on the stair;
- **leave room to turn at the top**: more than 0.4 m clear between anything
  solid on the landing (a wall, a railing's end) and the next thing;
- the well over the stair must be open: an upper floor across it is a ceiling
  to walk into.

**Railings are a design choice, not a requirement.** Stairs climb fine without
them. What a railing changes: a person steering by hand can't step off the open
edge of a gallery or stairwell. Agents never need one — their routes never step
off anything higher than a step (0.8 m) — and a drop is survivable either way.

**Things that move.** A collider is fitted to the model at rest. Moving the
whole thing (`place`, or a `motion` on the entity) carries its collider along
in browsers; animating one part (`motion:<part>`) does not — the part moves,
its collision doesn't, and agents treat any moving thing as having no
collision until it rests. So: leave doors fixed (ajar is fine), or make a door
its own small entity with its origin at the hinge and open it by `place`-ing a
new yaw.

**Loose things.** A small thing with `physics {kind: "dynamic"}` and a box
shape (a crate, a barrel) is not furniture to an agent's walk in a world running physics: if the walker
may shove it and a walking shove would slide it out of the way (for a 70 kg
body, up to about 213 kg at a walk, about 660 kg at a run: `shared/shove.js`
`budges`), the route goes through it and the walk pushes it aside. Anything
heavier, locked, held, or of a mass that can't be worked out is walked round
like any solid, so a heavy crate in a doorway blocks the doorway.

**Budget.** One draw call per material per mesh. Aim under **12 draws, 20k
triangles, 8 materials**; merge static parts into one mesh, carry variety in
vertex colours, and keep see-through (glass) materials to a few. Only meshes
reachable from the scene count — orphan nodes are ignored.

## 2. Optional metadata — what it adds

None of this is needed to walk in, climb, route or ragdoll. It adds names,
seats and lights.

**Seats** — a socket child of the building with a `station`, positioned in the model's frame:
```
act {verb: "create", args: {components: {parent: {to: id}, transform: {pos: [-1.2, 3.65, 0.2], q: [0, 1, 0, 0]}, socket: {name: "stool"}, station: {pose: "sitchair"}}}}
```
No rotation faces +Z (`q: [0, 1, 0, 0]` turns it to face −Z). The old `sockets` map is reserved: a write of it is still
lifted into socket children, but write the children. `measure {id}` lists the model's flat zones; a zone's centre
is a socket's position verbatim.

**Lights** — one `create {components: {light: {…}}}` each. They are separate things at world
positions: they don't move with the building.

**Named places** — for `move {to: "lookout/balcony"}` and for `look` to say
which room you're in (see AGENTS.md, "Named places"). Two layers, the second
overriding the first by name:

1. **in the model**: a `building` object in a scene node's glTF extras (a JSON
   string is fine — Blender exports custom properties that way). It survives
   the server's compressed copy.
   ```
   { "rooms":    [{"id": "hall", "name": "the hall", "min": [-2.2, 0.15, -2.2], "max": [2.2, 2.95, 2.2]}],
     "portals":  [{"id": "front_door", "center": [0, 0.15, 2.35]}],
     "seats":    [{"id": "bench", "pos": [-1.95, 0.62, 0.4]}],
     "arrivals": [{"id": "outside", "pos": [0, 0, 5]}] }
   ```
   A room's `min` y is its floor. The arrival called `outside` becomes the
   thing's `entrance`.
2. **in the world**: a `places` component, changeable any time after the thing
   is built — add a place, move one (send the same name with a new `at`),
   rename, or hide one the model declares (`null`). `name_place {name}` names
   the spot where you stand and does the merging for you.

**Named parts.** A node you might animate later (a door leaf, a lantern),
pivoted where it would hinge or hang. `measure` lists named parts.

## 3. Checking your work

- **The build check** runs on every model you upload, and never refuses one —
  it is advice. The upload answers with `check: "/check?lib=…"`; read it there,
  or ask `measure {id, check: true}` (a placed thing, checked at its scale) /
  `measure {lib, scale?, check: true}` (a path; `&scale=` on the route). A model
  already checked at that scale is answered at once; new checks are limited
  (10 a minute per address, 60 a minute for the whole server: 429 with
  `retry-after`) and queued (past 16 waiting: 503, ask again in a minute), each
  refusal in words saying when to ask again. Scaling a
  model scales its doors and steps but not the body — check at the size you
  will place it.
  Measured with the walking body's own rules, it says: whether the model is
  walk-in at all; its floors, and how much of each can be reached from
  outside; why any covered floor can't be (a passage narrower than a body —
  and where — a rise higher than a step, a climb an overhanging floor stops,
  or no way in); the render budget. It also **suggests rooms, doors and
  stairs** read from the geometry — rooms split where walls narrow to a
  doorway, never by furniture — as a `places` component you can rename and
  send, so a building nobody described still gets named places.
- `measure {id}` — bounding box, flat zones (floors, seats, tables), named
  parts. A building whose floors don't appear as flat zones has a problem.
- Walk it: `move {to: "<id>"}`, then up the stairs with `to: [x, y, z]`, `y` the
  upper floor's height. A refusal says why (nowhere to stand; no way there).
- Look for: a doorway that refuses (narrower than 0.4 m clear), a stair that
  stops partway (an overhanging landing, or a riser over 0.8 m), a landing you
  can't leave (no room to turn), a small hut that is solid (under 16 m² / 2.2 m).
