# Avatar design notes

Rationale behind choices in `client/lib/avatar/avatar.js` that the code comments only point at.

## Own-body clearance for body-attached sprites

Goal: a nameplate (and the typing pill) is hidden by scenery and by other avatars, never by its owner's own body.
`depthTest: false` cured a head or a crown of hair eating its own plate, but also drew every plate through every wall.

The chosen fix: the sprites are depth-tested, but a fragment-depth node (`PLATE_DEPTH`) writes their depth as if they
stood `userData.plateClear` metres nearer the eye (platesize.js `plateClear`: the body's measured reach from the plate's
anchor, grown past the eye while names are held). The sprite stays exactly where it is, on screen and in stereo; only
the depth test moves. It costs early-z on a handful of sprite quads.

Rejected:

- a per-avatar "everything but me" depth pass: a scene render per body;
- stencil: needs every scene material to cooperate, in two backends and in XR;
- moving the sprite toward the eye (and shrinking it to match): the flat picture is right, but in a headset the plate
  sits at the wrong stereo depth, floating half a metre in front of the head.

The own-body sample (`_measureOwnClear`) skins the body once (at most 4000 vertices a mesh) into the VRM scene's own
frame and only re-projects it when size, plate lift or VR fit change; re-skinning on every slider tick and every remote
change was the cost, and re-projection is exact for those changes because none of them moves a vertex within the scene.

## Wing dials

`WING_IDLE` and `WING_POWER` share every key so `mixWings` can crossfade them by `wingEffort`. Tuning direction, for
whoever touches them next:

- idle: a small stroke (10 deg) that travels far along the span (tip 0.9) and lags (0.25), with a wide fore/aft sweep
  (18) — membrane rather than hinge. Larger idle strokes read as an animal trying to take off.
- power: small and fast (8 deg at 2.1 Hz) with LESS lag (0.09) than idle: a loaded wing stiffens along its span. A large
  power stroke at that rate read as thrashing; past ~3 Hz the whole chain blurs into one shape.
- `sweepPhase` 0.25: a quarter turn between flap and sweep opens the tip path into an ellipse; at 0 it is a tilted line.

## The lamp's breath

`LAMP_FLOOR` / `LAMP_PEAK` / `LAMP_SHAPE` / `LAMP_DAY_FLOOR` were tuned by eye in passes: a high floor read as a dimmer
twitching, a true zero as a lamp cutting out, so the floor is near-dark but non-zero. The peak stays below 1 so the
swing reads as breath rather than a pulse, and was raised once the lamp cast its own shadows (shadowed neighbours make
the same light read dimmer). They are named so they can become debug-panel dials like the wing dials.
