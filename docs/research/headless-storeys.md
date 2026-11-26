# Headless storeys: which griddled floor the feet stand on

`mcpl/agent-ground.ts` `storeyUnder(x, z, yHint)` answers which upper storey of a griddled building a headless body's feet stand
on at (x, z), if any: the structure, the level's index and the floor's world height. Griddled structures are outside the
headless colliders (their walls are routed by `walkStructures`), so this is how the feet, a walk's support and its routes
know such a floor is there. `floorsAt`, `floorMeant`, `placedNear` and `groundAt` build on it.

## The rule

A storey counts when all of these hold:

- it rests above its building's base;
- its floor is more than the walk grid's step (`NAV_STEP`, 0.8 m) above the terrain under the point;
- `yHint` (the feet's height) is no more than a route step (`ROUTE_STEP_METRES`, 0.5 m) below the floor, and less than
  the storey's height (the grid's `wallH`, the router's floor-to-floor) above it;
- it has a tile under the point and, on a cell a diagonal cuts, a floor on the half the point falls in (the other half
  is a hole).

What follows from that:

- **At or below the base.** A level resting on the base or below it (a ground floor at the base, a basement) is the
  terrain's. A body there walks on the terrain, in and out of the building, as the router's terrain walk expects. A
  ground floor declared above the base is a raised floor like any other.
- **Within a step of the terrain.** A floor within `NAV_STEP` of the terrain (a low porch) is the terrain's: a body steps
  on and off it as it walks, and a floor route can't step down off its edge, so standing on it would trap a body that
  walked onto it. This is decided under the point, so a deck over rising ground is the terrain's, for standing, where
  the ground comes within a step of it. A floor walk on the deck still crosses that part at the deck's height
  (`walkProbeGround`), and the feet stand on the terrain there once the walk ends, as on a porch.
- **Anything in the storey.** Feet anywhere in the storey count, on something placed on its floor too (a table, a bed, a
  landing), so a body standing on a table upstairs walks on from that floor.
- **Where storeys meet.** With feet within a route step below the upper floor and still under the lower storey's height,
  the highest floor wins: feet stepping up onto it are on it.
- **`yHint` never becomes the height.** It only picks which real floor qualifies, so a body far above the house is not
  on its top storey.
- **Placement.** Each building is placed where it is now (`eff`), as `walkStructures` places it, and one that can't be
  read costs only itself.
- **Collision off.** A building whose collision is off for bodies (`collider.enabled` false, or `blocks` without
  `bodies`) has no floor here and no wall for `walkStructures`, as the browser fits it no box (`client/lib/realize/structure.js`
  `solid`). Every reader takes its structures from `bodyStructure` (`mcpl/agent-result.ts`).
