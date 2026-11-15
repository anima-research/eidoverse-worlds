# The walker: how `move {to}` walks griddled structures

Reference: what is built. Moved verbatim from AGENTS.md ("Walking through buildings") on 2026-11-14; AGENTS.md
keeps what a builder needs.

## Summary

- `move {to, run?, tolerance?}` (mode `walk`) routes through doors and arches in griddled structures.
- A body's step is 0.8 m (`NAV_STEP`). At a wall crossing, a solid span blocks the band from the feet to 0.5 m above
  them.
- A walk is planned before it touches the body. A refused walk is refused before a step, with a reason.
- A walk asked with the feet in the air ends the flight or tumble, and the body falls: nothing walks in the air.
- Upstairs, the feet are on a storey when its floor is more than a step above the terrain under them
  (`storeyUnder`). A walk from a floor stays on it.
- The authority still walks the body, stretch by stretch, so a wall the planner doesn't know still stops the walk.

## Routing through structures

- `move {to, run?, tolerance?}` (mode `walk`) routes through doors and arches in griddled structures.
- This includes entry, exit, and outdoor walks obstructed by a building.
- The search region is the structure's padded local bounds, capped at 16,384 cells.
- Distant endpoints connect without inflating the search region.
- A straight leg that clears a structure's walls needs no search at all.
- Candidate paths are checked against every known structure under the same supplied support mode.
- Where stacked levels cut one cell along different diagonals, a terrain walk's search splits the cell along the
  diagonal its feet meet.
- A body standing in a wall (a door edited to a window under its feet) first steps out to the nearest clear point
  within half a metre, on the side that reaches the destination. It is routed from there.
- Routes use the structures known when the walk begins, where they are then.
- Intermediate waypoints are reached exactly.
- `tolerance` (0–0.4 metres) applies only to the requested destination.

### Caching and each walk's context

- The MCPL server caches received structure revisions and their derived local topology/wall spans by object
  identity.
- Authored edits replace the component data.
- Cached plans are immutable snapshots.
- The MCPL server keeps one plan per structure, keyed by its id and its content. So a structure's plan is computed
  once per received revision (the view's copy of it is new every view).
- Each walk creates a fresh context with its current support basis, the terrain, and each structure's transform
  where it is now (carried by a mount or moved by motion, not its rest pose).
- Each walk reuses only that cached local geometry for candidate validation.
- Wall spans are filed by the cells they touch, so a check reads only the walls near its leg.

## Support modes

- A walk's support basis comes from the standing implementation, not floor order or horizontal overlap.
- The shared `prepareRouteLocal(plan, basis)` API takes terrain mode, and also accepts identified-floor mode.
- Placed models' floors are stood on through their colliders.

### Terrain mode

- The MCPL server supplies terrain mode for griddled structures.
- The feet follow the live terrain each tick of the walk, as the planner read it at each wall crossing.
- Thus a basement does not redefine ground.
- Thus an overhead tile does not confine a ground walker.
- Terrain mode queries terrain at the crossing, not just at the origin.
- Terrain paths collinear with a projected wall are conservatively refused. Point-query terrain cannot certify the
  entire overlap from samples.

### Identified-floor mode

- A body standing on an upper storey, or on a floor raised above its building's base, walks in identified-floor
  mode (agent-ground.ts `storeyUnder`, through agent.ts `walkSupport`).
- The standing resolver supplies the supporting entity/level and its actual fixed surface height.
- The mode permits only the floor's cells/halves.
- Missing tiles are holes.
- Floor→terrain transitions are explicitly unsupported.
- Cross-building floor transitions are explicitly unsupported.
- Another building's route cannot discharge the supporting floor's constraint.
- A pure planner test with supplied floor identity demonstrates that contract.
- A floor walk keeps its fixed floor height through the completion tick.

## What blocks a step

- Obstruction is independent of floor support.
- At each horizontal wall crossing, a solid vertical span blocks the **feet-to-step band** `[feetY, feetY + 0.5m]`.
- Entity translation and scale convert that world-metre band to local units.
- The band includes ordinary slab-offset walls and tall basement walls.
- The band excludes spans above or below it.
- Doors and arches remove their opening's vertical span.
- Their lintels can still obstruct a higher walk.
- Windows remain topological barriers.
- The walker refuses a stride that rises more than a step (0.8 m).
- So terrain steeper than that is a wall to a walk, routed or not.

## Standing on a storey

### Which storey the feet are on (agent-ground.ts `storeyUnder`)

The feet stand on a level when all of these hold:

- The level rests above its building's base.
- Its floor is more than a body's step above the terrain under the feet. The step is `NAV_STEP`, the one walker's
  step, 0.8 m.
- The feet are no more than a route step (0.5 m) below the floor.
- The feet are less than a storey's height above the floor (the grid's `wallH`, 2.8 m by default).
- The feet are on a tile and, on a cut cell, on its floored half.

Consequences:

- A body standing on something placed upstairs, a table or a landing, is on that storey.
- Where two storeys' ranges meet, the higher floor wins.
- A ground floor at the base, a basement and a low porch are the terrain's. A body there walks on the terrain, in
  and out.
- So is a deck, for standing, where the ground under it rises within a step of it.

### Walking from a floor

- A walk from a floor stays on it, its feet no lower than the floor and on what's placed above it.
- A walk from a table upstairs that the structure planner routes in legs keeps the feet on the table to its edge.
  It then brings them down to the floor, a drop of up to the table's height.
- A walk from a table upstairs that the navgrid routes is refused where the table stands more than a step above the
  floor. The grid takes no drop of more than a step, as on the ground.
- A walk the navgrid routes along a stage stays on its top.

### What a navgrid-routed floor walk stands on (`walkProbeGround`, `onOrAboveFloor`)

These cover a walk the navgrid routes, one the structure planner leaves as a single leg.

- It stands on that floor (`walkProbeGround`), all of it, at its height, where the ground beneath is no more than a
  step above it.
- It stands on what's placed there and beside it at or above the floor's height (`onOrAboveFloor`), since the feet
  go no lower than the floor to the walk's end.
- It does not stand on the ground beside the floor.
- It does not stand on another building's floor.
- It does not stand on anything placed lower than the floor.
- So it crosses a deck's low end at the deck's height, and the feet stand on the terrain there once it ends.
- Where the ground rises more than a step above a floor, it doesn't cross it.

A walk the planner routes in more than one leg, or keeps because the grid's route would cross a wall, follows the
structure router's floor route. That route crosses every floored cell at the floor's height.

### Destinations and the floor a height means (`floorMeant`, `placedNear`)

- A destination off the floor is refused, as identified-floor mode says.
- A destination whose height means another of the floors there is refused too (agent-ground.ts `floorMeant`). That
  other floor may be:
  - another storey of the building;
  - another building's storey;
  - the ground, which takes every floor within a step of the terrain, as standing does.
- The floor a height means is `move`'s own rule for the `y` of `to: [x, y, z]`, the navgrid's: the floor nearest it,
  no more than a step (`NAV_STEP`) above it, or within the destination's own bounds (`above`, `below`: a room's floor
  is exact, a seat's is no higher than its seat).
- Where the walk's own floor comes within a step of the terrain either way, as at a deck's low end, the ground there
  is that floor.
- The check comes once the router has planned the walk, before the navgrid routes it or its legs are walked.
- The check applies whatever gives the height: `to` with a `y`, a named place, a seat, a room, a thing's entrance,
  or a participant.
- Where something placed on this floor stands at about that height there, the walk goes (`placedNear`). That is:
  its top is within the destination's bounds (a step each way unless given), no lower than this floor, and under the
  next floor above it there.
- When the navgrid routes the walk, it reads the height against what is placed.
- Something placed on another floor is no reason to go.
- A walk whose `to` leaves out `y` isn't checked, and stays on the body's own storey.
- A walk from the ground isn't checked either. One to a room upstairs still ends on the ground floor below it, as it
  always has.

### A slumped or tumbling body's floor (`rootCanned`, `RAGDOLL_ROOT_DROP`)

- A slumped or tumbling body's floor is found from its feet (`feetY`), `RAGDOLL_ROOT_DROP` above its root.
- For a canned slump it is found at the root (`rootCanned`). A canned slump is one held by a knockdown before any
  sim has run, or with no sim to run, as a limp flight ended before its ragdoll began (which then never does).
- This holds wherever the floor is asked: for a walk, a stand-up, a takeoff, a flight's end, a spot it names by x
  and z, the tick's ground, and the room `look` says it is in.
- A flight under way and a tumble's physics read the terrain alone, since griddled floors aren't headless colliders.

## Walking to a person

- A participant's height is read from presence, which carries their root.
- One standing, or held by a canned slump, has their root on their floor.
- One a sim laid down, under clip `ragdoll` or a physics pose held under another, has it about `RAGDOLL_ROOT_DROP`
  below the surface they lie on.
- So their floor is no more than that drop (and 0.05 m) above the root.
- For the check, their floor is the highest griddled floor within that at their own spot, wherever the walk stops
  short of them. That is the one their body is on, since no body stands with a floor less than that above its feet.
- The navgrid, which reads every surface, takes the place to stand nearest the root within it:
  - the floor they lie on;
  - the floor beside a bed less than 1.4 m high that they lie on;
  - where they lie on a surface more than 1.4 m above the next one down, that surface.
- Where no route reaches it, as on a top bunk, `walkNow` routes the walk again to the place to stand nearest the
  root no higher than it. It ends on the floor beside the bunk.
- A step above the root would still reach the bunk, since the walker's step is more than `RAGDOLL_ROOT_DROP`.
- A walk from the ground to someone lying on a floor above that no route reaches ends on the ground below them.
- Where they lie on a surface less than 1.4 m above another, such as a low deck, the navgrid takes the surface
  below.
- The exception is a floor walk on that deck, whose grid stands nowhere lower than its floor.

## The walker and the authority (#218)

- The walk rides the one walker (`shared/mover.js` `walkToward`, the stride the client and the authority take).
- Routing only chooses its legs.
- The walker's floor is the walk's admitted support.
- The authority still walks the body too (E1): a planned route is asked for stretch by stretch.
- So a wall the planner doesn't know (a placed model) still stops the walk with the authority's own refusal.

## Refusals and limits

### Before a step

- A walk is planned before it touches the body.
- A refused walk leaves a seated, pinned, posed or tumbling body on the ground as it was, and sends nothing.
- A route refusal comes back from `move` as an error before a step is taken (`move refused before a step: …`).
- Sealed, over-budget, or conflicting routes return a reason instead of becoming an unchecked straight line.
- The reason names each structure's own refusal.
- An over-budget structure's reason gives its padded footprint in metres.
- A detour that another structure obstructs names both.
- Replacing a walk with a refused route cancels the old walk too.
- A call refused for its arguments leaves the walk under way going.

### Structures the server can't check

- A structure the MCPL server can't check (its geometry isn't finite, or its place can't be composed) has no walls
  to check against.
- Every walk skips it.
- The MCPL server's log names it once per component revision.

### A walk asked in the air

- A walk asked with the feet in the air (flying, or falling or tumbling out of a flight) ends that flight or tumble
  at once.
- The body falls straight down under gravity: nothing walks in the air.
- The walk waits for the ground and is planned from where the body lands.
- Refused then, the fall is not undone.
- A newer walk or a stop during the fall answers it at once, and the body still comes down.

### How a walk ends

- Stop, cancellation, refusal, timeout, and arrival release the walk's basis.
- They leave a walking body standing.
- A subsequent walk resolves standing again.

## Outside this contract

- Global multi-building route search.
- Full-body/capsule clearance.
- Arbitrary mesh avoidance.
- Vertical navigation.
