# Reserved names: sketches of their shapes

Not protocol. These names are reserved in the registry (a write is refused until an engine or a world needs them); no
shape is pinned for them, since pinning one builds ahead of any world (the house's view, #260 10-20). What follows is
the shape each was sketched with, verbatim from the registry before it was unpinned, kept so the work isn't lost.

## `surface` (on @world, keyed by name)

```js
  surface:   { status: "reserved", instead: "nothing yet: no engine here reads surfaces (eidosim's friction and bounce are its own constants)", on: "world", keyed: true, key: "instance", fields: { friction: "number", restitution: "number", density: "number", frictionCombine: "string", restitutionCombine: "string", label: "string" },
               enums: { frictionCombine: COMBINE, restitutionCombine: COMBINE }, ranges: { friction: { min: 0, max: 10 }, restitution: { min: 0, max: 1 }, density: { gt: 0, max: 1e5 }, label: { maxLen: 80 } }, units: { density: "kg/m³" },
               absentMeans: { friction: "the engine's own law", restitution: "the engine's own law", density: "the engine's own", frictionCombine: "average", restitutionCombine: "max", label: "its key" },
               help: "reserved (refused until an engine reads surfaces): on @world, keyed by name, a surface material things name with physics.surface: {friction? (≥ 0), restitution? (0..1), density? (kg/m³), frictionCombine?, restitutionCombine? (average|min|multiply|max; absent: average and max), label?}. When two touching surfaces' combine modes differ, the later of average < min < multiply < max wins (PhysX, Unity, Rapier; KHR resolves the other way round, PHYSICS §3.2)" },
```

## `terrain-grid`, `terrain-tile`

```js
  "terrain-grid": { status: "reserved", on: "world", fields: { spacing: "number", tile: "int", origin: "array", extent: "array", limits: "object" }, help: "the sculpt grid: {spacing (m), tile (samples per side), origin [x, z], extent [nx, nz] tiles, limits {raise, lower} (mm)}; fixed while any terrain-tile exists" },
  "terrain-tile": { status: "reserved", on: "world", keyed: true, key: "partition", fields: { mm: "array" }, help: "keyed <i>-<j>: {mm: [tile² integer millimetres, row-major]}, a delta over the base; written whole by sculpt" },
```

## `physics`'s reserved fields (`friction`, `restitution`, the combine modes, damping, `centerOfMass`)

```js
    // the reserved fields' units, limits and meaning of absence: what they will mean when an engine reads them (PHYSICS §3.2)
    reservedShape: { units: { linearDamping: "1/s", angularDamping: "1/s", centerOfMass: "m" },
      ranges: { friction: { min: 0, max: 10 }, restitution: { min: 0, max: 1 }, linearDamping: { min: 0, max: 1000 }, angularDamping: { min: 0, max: 1000 }, surface: { maxLen: 64 } },
      enums: { frictionCombine: COMBINE, restitutionCombine: COMBINE } },
```

## How surfaces would combine (moved from PHYSICS §3.2)

Verbatim when moved: the pre-review of #260 found §3.2 still defining a shape the registry no longer pins.

- **Surfaces.** A world names its materials as `@world surface:<name>
  {friction?, restitution?, density?, frictionCombine?, restitutionCombine?,
  label?}` (Marrow's Surface Data Cards: one name bundles a surface's
  numbers, and content names materials rather than raw per-object numbers).
  `surface` is **reserved** with `physics`' reserved fields (writes closed;
  both open together). A `physics.surface` naming no surface reads as none.
  The registry may later add built-in surface names; a world's own
  `surface:<name>` wins.
- **Combining two surfaces is the protocol's, not the engine's.** The modes
  are the four every engine can carry (PhysX's, Unity's and Rapier's enums;
  Jolt and Box2D v3 take any rule as a callback): `average`, `min`,
  `multiply`, `max`. When two touching surfaces name different modes, the
  later in that list wins (PhysX's and Unity's priority). Absent everywhere,
  friction averages (the PhysX, Unity and Rapier default) and restitution
  takes the max (the Jolt and Box2D default: a bouncy ball stays bouncy on
  any floor). Geometric mean, Jolt's and Box2D's friction default, isn't
  offered: three of the engines can't express it. **KHR_physics_rigid_bodies
  names the same four modes (`average`, `minimum`, `maximum`, `multiply`) but
  resolves a mismatch the other way round** (if either says average, average;
  then minimum, maximum, multiply). We keep the engines' order, which three of
  them carry natively; an importer of KHR materials resolves each touching
  pair to one mode, never maps mode to mode.
