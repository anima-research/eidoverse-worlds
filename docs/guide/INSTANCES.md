# One thing, drawn many times

A forest, a field of stones, a ring of pillars, a sky of motes: one thing with the component `antra/instances` is drawn
as many copies as you say, in one draw for each of its meshes. The copies are not things. Nothing is stored for each
one, so a hundred thousand of them are one small value in the world's log, and they cost the graphics card far less
than as many separate things would.

`antra/instances` is a **draft** component (docs/contributing/COMPONENT-LADDER.md, rung 1): the authority stores it as
you write it and checks nothing, and a client draws the copies only if it carries the reader (the browser client does;
other renderers draw the thing once). Its shape may still change.

```
# a ring of 14 pillars, 5 m out, and no pillar in the middle
act {verb: "create", args: {components: {mesh: {shape: "cylinder", size: [0.5, 3, 0.5]},
  "antra/instances": {scatter: {count: 14, shape: "ring", radius: 5}, original: false}}}}

# sixty crates strewn round a clearing, each its own size and lean, standing on the ground
act {verb: "set", args: {id: "<a crate>", component: "antra/instances", value: {
  scatter: {count: 60, shape: "disc", radius: 16, inner: 7, scale: [0.5, 1.6], tilt: 0.15}, ground: true}}}

act {verb: "delete", args: {id: "<a crate>", component: "antra/instances"}}     # one crate again
```

The inspector checks a value before it is sent and says what it draws, in words:
`edit {id, set: {"comp.antra/instances": {…}}}`, then `inspect {id}` reads "drawn 61 times, scattered in a disc of
radius 16 m, standing on the ground". A `set` request stores whatever you send.

## The value

```
antra/instances = {
  at?:       [[x, y, z], [x, y, z, yaw], [x, y, z, yaw, scale], [x, y, z, qx, qy, qz, qw], [x, y, z, qx, qy, qz, qw, scale], …],
  scatter?:  {count, shape?, radius?, inner?, size?, to?, seed?, scale?, yaw?, tilt?, jitter?},
  ground?:   true,
  original?: false,
}
```

Places are in the thing's own frame, in metres before its scale: the copies move, turn and scale with the thing, and a
`motion` on the thing carries them all. Yaw is in radians (0 faces the thing's front, +Z).

- **`at`**: copies placed by hand, one row each. A row that isn't numbers is skipped.
- **`scatter`**: copies worked out from a seed (below). With both, the hand-placed ones come first.
- **`ground: true`**: each copy stands on the world's ground under it, whatever its `y` says, and again when the thing
  is moved or the ground changes. Absent: copies are where their rows put them.
- **`original: false`**: only the copies are drawn, not the thing itself (a ring with nothing in the middle). Absent:
  the thing is drawn too, at its own place.
- What absence means: no component, or a value with no usable row and no scatter, is the thing drawn once.

A thing draws at most 100,000 copies; a value asking for more draws that many.

## Scatter

Every viewer works the copies out from the same numbers, so everyone sees the same forest. `seed` names the
arrangement; without one it comes from the thing's id, so each thing scatters its own way. Changing `scale`, `tilt` or
`yaw` never moves a copy, and raising `count` adds copies without moving the ones already there.

| `shape` | where the copies go | reads |
|---|---|---|
| `disc` (when absent) | scattered over a disc on the ground plane | `radius` (5), `inner` (0: a hole of that radius in the middle) |
| `ring` | evenly spaced round a circle, the first in front | `radius` (5), `jitter` |
| `box` | scattered through a box centred on the thing, from its base up | `size: [x, y, z]` ([10, 0, 10]: flat) |
| `grid` | rows and columns filling a rectangle | `size: [x, _, z]`, `jitter` |
| `line` | evenly spaced from the thing to a point, both ends included | `to: [x, y, z]` ([10, 0, 0]), `jitter` |
| `sphere` | scattered over the surface of a sphere round the thing | `radius` (5) |

And for every shape:

- `count`: how many.
- `scale`: one number, or `[min, max]` for a different size each (1).
- `yaw`: `"random"` (every heading), `"out"` (away from the middle), `"in"` (toward it), or a number for one heading.
  Absent: `out` for a ring, the thing's own heading for a grid or a line, `random` for the rest.
- `tilt`: how far a copy may lean from upright, in radians (0).
- `jitter`: for a ring, a grid or a line, how far a copy may stray from its even place, 0 to 1 of the gap (0).

## With a shader

The copies wear the thing's material as it is now, so a `hesperus/material` override or an `antra/shader` on the thing
dresses every copy, and in a shader `instance` is the copy's number (0, 1, 2…): `hash(instance)` gives each its own
random number.

```
"antra/shader": {code: "
  float tw = 0.5 + 0.5 * sin(time * 3.0 + hash(instance) * 40.0);     // each mote twinkles in its own time
  color = vec3(0.0);
  emissive = mix(vec3(1.0, 0.7, 0.2), vec3(0.3, 0.8, 1.0), hash(instance + 9.0)) * (0.3 + 2.5 * tw);"}
```

## What copies are not

Copies are drawn, and that is all. They don't collide and can't be walked on, picked, grabbed, sat on or named: a body
walks through a scattered tree, and `move`'s routes don't know it is there. `look` tells a text-tier reader that the
thing is drawn many times, not where each copy is. For a tree someone should bump into, place a real thing.

Child things (a light, a socket, a picture hung on it) and a skinned model's body aren't copied: the copies are the
thing's own static meshes.

What a copy costs is its triangles: 10,000 copies of a 300-triangle crate are three million triangles a frame. Small
simple meshes go a long way; a detailed model copied thousands of times does not.
