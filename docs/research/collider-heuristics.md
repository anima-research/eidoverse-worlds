# Collider heuristics: why client/lib/colliders.js decides the way it does

The design reasoning behind `decide()`, the uneven-top probe, and the overhang rule. The code carries one-line
pointers here.

## No "hollow" probe

Walkability once also required a thing to be "hollow": nothing within 0.9 m of its bounding-box centre, to keep a
tree's canopy from becoming a walkable room. That probe can't tell a trunk from anything else standing in the middle
of an open structure, so it failed every bell tower, pavilion, gazebo and colonnade (bell2 is a 214 m² pavilion with
its bell hanging 0.20 m from the centre, and it read as solid rock). A rule that excludes real buildings to exclude
trees is the wrong rule. Trees are handled where they actually cause harm (the grass mask), and a per-object
`collide` override still wins over all of it.

That history is also why declared structure boxes (`fitStructureBoxes`) skip `decide()` entirely: architecture is the
population where guessing a shape back out of a bounding box has already lost once.

## The uneven-top probe (issue #11)

A box collider's top face is the only ground it can report, so a box is exactly as honest as the thing's top is flat.
For most props that is honest enough: a crate's top is off by about 5 cm. For a blanket with cushions on it, the
bbox top sits at the tallest cushion and the whole footprint reads as ground at that height, so a body on the bare
cloth stands 27 cm up in the air. Issue #11's three observables (the shove at the rim, the phantom mantle offer, the
invisible full-footprint ceiling) all come from that one lie.

The probe buckets every vertex into a 24×24 grid over the footprint, keeps the highest y per cell, and calls the LIE
the gap between the bbox top and the median cell top. One linear pass, no BVH (the BVH is what `decide()` is pricing).

Surveyed against a raycast ground truth across the 58-model library plus 8 conjured store meshes
(`tools/assets/collider-survey.ts`): inside the floor-shaped population the gate admits, the vertex version tracks the
raycast to within 1.8 cm in the worst case and never disagrees about the threshold. Across the whole library it drifts
by up to 2.5 m on tall structured things (a watchtower, a perimeter wall), which is why the shape gate runs before
the probe is consulted.

The grid/median maths lives in `supportclass.js`, so the headless support pipeline classifies with the same module
and the two runtimes can't drift apart.

## The floor-shaped gate

Things that are wide enough to stand on and low enough that standing on them is all a body would do (a blanket, a
rug, a pillow pile), with a real gap between the box top and the surface, collide exact. The numbers come from the
survey:

- Footprint ≥ 2 m²: anything smaller, nobody walks on.
- Lie > 0.10 m: below that the box is honest enough (a crate reads 0.05).
- Height ≤ 1.0 m: every gate from 0.6 to 1.0 reclassifies exactly ONE object out of the 66 surveyed (the blanket).
  A gate of 1.2 pulls in nine more: both rubble piles (which float you 0.73 m and 0.44 m, worse than the blanket),
  five hovercars, and a shark. If those should firm up too, that gate is the one line to move.

## Overhangs: when not to push

If you exit through the nearest vertical face no matter what, a head brushing a mezzanine by 1.3 cm gets flung 1.6 m
sideways, clear of a 3 m slab's whole footprint (tens of metres on a room-sized one). The push is declined only when
both of these hold:

- There is a down. A crate on the floor has its underside at ground level, so it must still push you sideways.
- The overlap is a graze, not "I don't fit". A waist-high counter overlaps a standing body by most of a metre, and
  letting that through would let the avatar phase through it at chest height.

"The shortest way out is down" is not the test: for any large slab the sideways exit is metres away, so down would
always win and everything would become passable.

Before `box.min.y` was read at all, every box was an infinite column down to the world floor: a mezzanine slab at
y 2.4–2.7 shoved a walking avatar 2.3 m sideways at ground level, and the `pillar` heuristic was the only reason
anything was passable underneath (which is why trees worked and archways did not).
