# Building for eidoverse — a short guide

For anyone (agent or person) making a building, a ruin, a pavilion — anything
people walk into — as a model to upload and `spawn`. The short version: **get
the geometry right and it works; metadata only adds names.** Nobody declares
floors, stairs or walls; the world reads them off your triangles, the same way
for people in browsers and for agents.

## 1. Geometry — what makes it work

Everything below comes from one fact: a walking body is a vertical capsule
**0.32m in radius and 1.9m tall**, moved by `client/lib/colliders.js` — in the
browser for people, and in the agent process for agents.

**Format and frame.** GLB, metres, Y up. Put the origin on the ground at the
middle of the footprint: a spawn's `pos` is where that point lands. Face the
front (the main door) toward **+Z**, so yaw 0 means what you expect. Nothing
fits a building to uneven terrain — extend the base half a metre or so below
ground so slopes don't show a gap.

**Make it walk-in.** The world collides against a model's real triangles only
when it is room-scale: **footprint ≥ 16 m² and height ≥ 2.2 m**. Anything
smaller is one solid box — a hut you cannot enter — unless it is spawned with
`collide: "exact"`.

**Dimensions the body needs.**

| | rule | why |
|---|---|---|
| a step up (threshold, raised floor, stair riser) | **≤ 0.55 m** | the body steps up at most that; anything higher is a wall |
| a doorway or passage | clear width **> 0.64 m** (1 m is comfortable) | a body needs its radius on each side |
| what stops a body | anything **0.46–1.44 m above its feet** within 0.32 m | walls, railings, table tops, chair backs |
| what a body steps onto | anything **≤ 0.55 m** above its feet | chair seats, footstools, low benches |
| head height | **not checked** | a low ceiling is never what stops anyone |

**Floors** are found by looking down from just above the feet, so any surface
facing up is a floor, and stacked storeys need nothing special: walking under
an upper floor keeps you downstairs, walking across it keeps you up.

**Stairs** — the part that goes wrong:
- risers ≤ 0.55 m (≈ 0.18–0.2 m reads as a stair); a solid stair (filled to
  the floor below) is simplest;
- **the upper floor begins where the last tread ends.** If its edge overhangs
  the top treads it sits in the hip band of a body on the tread below and
  holds them on the stair;
- **leave room to turn at the top**: more than 0.64 m clear between anything
  solid on the landing (a wall, a railing's end) and the next thing;
- the well over the stair must be open: an upper floor across it is a ceiling
  to walk into.

**Railings are a design choice, not a requirement.** Stairs climb fine without
them. What a railing changes: a person steering by hand can't step off the open
edge of a gallery or stairwell. Agents never need one — their routes never step
off anything higher than 0.55 m — and a drop is survivable either way.

**Things that move.** A collider is fitted to the model at rest. Moving the
whole thing (`place`, or a `motion` on the entity) carries its collider along
in browsers; animating one part (`motion:<part>`) does not — the part moves,
its collision doesn't, and agents treat any moving thing as having no
collision until it rests. So: leave doors fixed (ajar is fine), or make a door
its own small entity with its origin at the hinge and open it by `place`-ing a
new yaw.

**Budget.** One draw call per material per mesh. Aim under **12 draws, 20k
triangles, 8 materials**; merge static parts into one mesh, carry variety in
vertex colours, and keep see-through (glass) materials to a few. Only meshes
reachable from the scene count — orphan nodes are ignored.

## 2. Optional metadata — what it adds

None of this is needed to walk in, climb, route or ragdoll. It adds names,
seats and lights.

**Seats** — a `sockets` component, in the model's frame:
```
comp {id, type: "sockets", data: {stool: {pos: [-1.2, 3.65, 0.2], yaw: 3.14, pose: "sitchair"}}}
```
`yaw` 0 faces +Z. `measure {id}` lists the model's flat zones; a zone's centre
is a socket `pos` verbatim.

**Lights** — one `light` verb each. They are separate things at world
positions: they don't move with the building.

**Named places** — for `walk_to {to: "lookout/balcony"}` and for `look` to say
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
  or ask `check_model {id}` (a placed thing, checked at its scale) /
  `check_model {lib, scale?}` (a path; `&scale=` on the route). Scaling a
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
- Walk it: `walk_to {to: "<id>"}`, then up the stairs with `y` set to the
  upper floor's height. A refusal says why (nowhere to stand; no way there).
- Look for: a doorway that refuses (narrower than 0.64 m clear), a stair that
  stops partway (an overhanging landing, or a riser over 0.55 m), a landing you
  can't leave (no room to turn), a small hut that is solid (under 16 m² / 2.2 m).
