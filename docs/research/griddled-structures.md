# Griddled structures: design notes

Rationale behind `shared/structure.js` (the griddled-building model's pure half). Code comments point here by section.

## §1 Why a grid

A conjured building is one opaque mesh: an agent can be told its bounding box and nothing else. It can't ask which room it
is in, what that room connects to, or where the door is, because none of that is written down: it is an emergent property
of triangles. A griddled building writes the topology down, so "you are in the kitchen; the hallway is through the south
door" is a DERIVATION rather than a guess.

The grid is also the navigation graph. `walkTo` samples only the height field, so without it a headless agent walks a
straight line through walls. That would also make any monolith-vs-griddled comparison worthless: an agent told "go to the
kitchen" would arrive in both houses by walking through the dividing wall.

## §2 Walls live on grid EDGES, not in cells

An edge is shared by exactly two cells, so a wall between the kitchen and the hall is ONE wall: it can't be double-counted,
can't disagree with itself about thickness, and corners join because two edges meeting at a lattice point are exactly two
edges meeting at a point. Cell-owned walls ("this cell has a north wall") need a rule for whose wall it is when both
neighbours claim one, and every such rule leaks. (The Sims made the same choice.)

## §3 The grid defaults are a contract

Every part generated against the grid assumes them, so changing them invalidates content rather than re-rendering it. 1 m
tiles read well at a 1.7 m avatar height; 2.8 m floor-to-floor is a generous domestic storey; 0.15 m walls read as masonry
at arm's length without eating a tile.

## §4 Apertures: a hole is an absence of boxes, spanning the whole segment

An aperture is described by how much wall is left above and below it, not by a boolean subtract. The same decomposition
then serves geometry AND collision: the movement solver needs no concept of a hole, because a doorway is an absence of
boxes and absence is already walkable.

An aperture spans its whole tile, with no side jambs. That is a correctness requirement, found by test: a 0.9 m door in a
1 m tile leaves 5 cm jambs, far thinner than a 32 cm body radius. The solver ejects a body through the NEAREST face, so a
sliver jamb pushes you sideways along the wall and you slide through the doorframe. The neighbouring wall segments are the
jambs; any decorative frame is trim and must not collide.

## §5 Corners are filled with their own boxes

A wall straddles its edge, so where two perpendicular walls meet, the outer quadrant belongs to neither: a t/2 notch down
every external corner. Stretching a wall across it is wrong twice: at a T-junction there is no gap (the crossing wall
already covers it) and stretching the stem puts an interior wall's end on the building's outside, z-fighting; at an
L-corner it leaves two overlapping coplanar faces, which z-fight. A quadrant box's faces are coplanar but ADJACENT, and its
caps sit back-to-back with the walls', which backface culling resolves.

## §6 Runs

A five-tile wall as five boxes is the root of corner notches and trim discontinuities. A RUN (a maximal collinear chain
sharing a material) is one box: no interior seams, a fifth of the polygons. Apertured segments stay solitary: their
vertical profile differs. Runs are axis-aligned only (a diagonal read as one produced a phantom wall across the cell).

## §7 A level's y is where its foundation rests

The slab occupies [y, y + slabT]; the walk surface is its top. With the slab hanging below y, a level-0 floor at y = 0 is
coplanar with flat terrain and z-fights across every floor. A foundation with thickness in the right direction can't be
coplanar at any level, on any terrain, with no depth bias.

## §8 Rooms and routes: two graphs, one node set

A door doesn't merge two rooms: a kitchen with a door to the hall is still a kitchen, which is why rooms are worth naming.
Rooms are separated by a WALL whatever holes it carries; an opening with no wall merges two areas. Routes pass through
doors and arches. Sharing the node set but not the edges keeps both true; conflating them collapsed every doored pair of
rooms into one.

Room ids are derived, so scanning in sorted key order keeps the labelling a pure function of the data: two agents folding
the same log describe the same house the same way.

## §9 Diagonals

A diagonal runs corner to corner across a cell: axis 2 is ↘, axis 3 is ↗. Geometry needs nothing special (a swept profile
mitres at any angle); what diagonals break is the assumption that a CELL IS ATOMIC. A cut cell contributes two nodes, named
by the sides they touch (a ↘ diagonal separates N/E from S/W), and may be floored on only one side, which is what makes a
diagonal read as the corner of a building rather than a wall standing on a floor.

Diagonal COLLISION is stair-stepped: small overlapping axis-aligned boxes along the line, because the collider entry
carries ONE yaw for every box of a building. The steps (~18 cm apart, boxes wider than that) are well under a 32 cm body
radius. Visually the wall is a true mitred diagonal.

## §10 Visual parts are a second derivation

Collision keeps `boxes`; rendering wants baseboards, reveals and a roof, which collision must never see. Both come from one
normalized grid, so a doorway can't be open to the eye and shut to the body. Trim is what makes a wall read as built rather
than extruded. A flat roof with an overhang removes the loudest "unfinished" signal from outside; pitched roofs are a
straight-skeleton problem, deferred.

## §11 Swept walls

A box per run is axis-aligned, so it can never mitre or turn 45°. Sweeping a cross-section along a polyline builds the wall
from its own direction: true mitres at any angle, chamfers in the profile (the top arrises catch a highlight line), and
diagonal walls as a change of path. The skirting is a step in the same profile, so it's one board, mitred by construction.

- **Polylines** continue through a node by the straightest onward segment, so a T-junction's crossing wall runs through and
  the stem ends against it. At a junction a run continues only if something carries straight on; otherwise it would pick
  one of two perpendicular branches arbitrarily.
- **Apertured segments** are the same profile clipped vertically (a lintel keeps the chamfer, a sill the plinth; the flat
  cut is the reveal). Boxes there never lined up with the swept wall. Their ends mitre against the run they interrupt
  (`neighbourDirs`): at 45° a butt joint leaves a visible wedge. At the start the mitre wants the direction ARRIVING at the
  node, at the end the one LEAVING it; using "arriving" for both flips the bisector (a diagonal shot 0.23 m past its corner).
- **Glass** is swept too: `edgeSpan` treats "not axis 0" as axis 1, so a boxed diagonal window came out axis-aligned.
- **Winding.** The lateral offset is the LEFT normal of travel, so the obvious quad order points every face into the wall
  (a building turned inside out). Pinned by the outward-normal test.
- **End caps** close an open run (else a doorway shows the inside of the wall). The profile is v-monotone, so it
  triangulates by merge-walking its two chains.
- **Triangular prisms** (half-cell slabs) derive their winding from the cross product, never per case.

## §12 Analytic shading

The interior problem is a LIGHTING problem: one hemisphere light, one sun, no ambient occlusion, so inside a sealed box
every surface lands on the same value. Lights can't fix it: lightrig.js keeps 8 slots fixed because runtime light-topology
changes cost 388–1523 ms frames. So it's baked analytically at build time from what the plan already knows (walls, concave
joins, depth from windows): free at runtime, no texture bytes.

- Daylight BFS's out from the apertures through open edges and doorways; below ~0.38 an interior reads as broken, not dim.
- Concave joins multiply per-wall falloffs (a corner compounds to ~0.3); corners sell an interior as a room.
- A downward face indoors gets floor bounce (else ceilings go near-black and every room feels like a cellar).
- Outside, the eave shadow and grade contact carry a building; convex corners lift slightly so massing reads as volume.
- A touch of warm/cool hue separation does more for "lit" than 10% more value.

The vertex bake is sampled per vertex and interpolated, but the shading is non-linear in height, so a storey-tall quad
shows lerp(shade(0), shade(H)) while a lintel samples shade(2.1) directly: a visible step at the opening. The wall profile
is refined with a ladder plus exact cuts at every aperture height and at every SHADE_KINKS breakpoint (no ladder spacing
tracks a kink unless a sample sits on it).

## §13 Perception

Everything perceptual reads the plan only (no scene, no raycast), so an agent with folded state answers "which room am I in
and how do I leave it" as well as a browser. Sides are the GRID's compass: a building rotated 40° has its own north, and
the phrasing says whose north it is. A point's room is resolved with its level (cell keys are x,z, so a key-only lookup on
a stacked building always answered with the ground floor).

## §14 Whole rebuilds, not patches

`planStructure` is pure and total, and the hosted half rebuilds on every reconcile: a building's geometry is cheap (hundreds
of boxes), edited rarely and rendered constantly, and a full rebuild can't drift from the state. A malformed structure
yields an EMPTY plan, never a throw: a neighbour's broken house must not stop yours from drawing.
