# The Verlet ragdoll — design notes and measurements

`client/lib/ragdoll/ragdoll.js` is a Verlet particle skeleton: one owner simulates and
streams the result as a held pose. This page keeps the reasons behind its rules
and the numbers that chose them, so the code can stay short. "The fleet" means
the shipped avatar rigs (14 at the time of most of these measurements; 44 for
the later fleet checks). The sweeps live in `test/labs/rag-tune.mjs`, and
`test/client/ragdoll-test.ts` pins the behaviour.

## 1. The four things a particle sim needs

- **Mass.** Every constraint splits its correction by inverse mass, so heavy
  parts win. With equal weights, a flailing forearm could throw the torso
  across the floor.
- **Volume.** Bones are capsules, not beads. Colliding only the joints left
  every shaft hollow: limbs passed through the torso on all 14 rigs (100% shaft
  overlap).
- **Handedness.** Knees bend backward and elbows forward, which needs a body
  frame. The particles supply one (§9).
- **A fixed step.** Verlet's inertia term is a position delta, so it assumes
  every frame lasted as long as the last one. Raw frame time made the physics
  depend on framerate: 15.7% peak bone stretch at 60 fps against 54.6% at 30 fps,
  with the body landing 10 m apart. Fixed `FIXED_DT` slices removed that (peak
  stretch had varied 3.5×). A long hitch drops its backlog.

Everything anatomical is measured from the rig, because the rigs disagree:
heights 0.63–1.53 m, rests from T-pose to A-pose, and half carry an
upperChest + shoulder pair.

## 2. Tuning

- **Substeps vs passes.** Splitting the time step helps framerate independence
  more than relaxing harder. At 1 substep, the same fall landed 31 mm apart at
  30 fps and at 120 fps. At 2 substeps it landed 1 mm apart. More than 2 stops
  helping, because the braced torso needs a few relaxation passes per substep.
  `SUBSTEPS: 2, ITER: 3` settles all 14 rigs; the neighbouring settings settle
  6 to 11.
- **`ITER_PINNED`.** A body hanging from a pin is a chain loaded at the far end.
  Gauss-Seidel moves tension one link per pass, so the chain stretches until
  the passes reach it. While dragging, bone stretch was 69% at 3 passes, 23% at
  8 and 8% at 16. A stretched body reads as twisting limbs, because the drive
  takes its directions from where the joints ended up.
- **`TWIST_LAG` = 0.** A limp bone lagging its parent's roll is the only
  physical source of twist in a model with no angular momentum about bone axes,
  and in measurement it only ever added twist. Mean limb twist was 8° at 0,
  18° at 0.05 and 34° at 0.2, and the worst case did not move.
- **`PIN_VEL` (off).** A position-only pin makes the joint's Verlet velocity
  equal to the whole distance the pin travelled. Against an unpinned fall, a
  moving pin took peak joint speed from 1.7 to 5.6 m/s, stretch from 3% to 16%
  and twist from 101° to 180°. `PIN_VEL` gives the joint the pin's own velocity
  instead. It stays off because the headless synthetic drag does not show that
  it helps. A real hand on a cursor is the test that settles it, so it is a
  switch in the debug panel. When it is on, a pin that jumps further than
  `PIN_JUMP` in one frame lands dead: turning a jump into speed threw the first
  frame of a grab at 45 m/s.
- **Settle.** The settle test is measured in seconds, not frames: 24 frames
  was 0.17 s at 144 Hz and 0.8 s at 30 Hz. It has hysteresis (`SETTLE_RESET`).
  `DEADLINE` forces the capture, because a tumble must always end as a held
  pose.

## 3. Joint limits: why three kinds

The old single table of unsigned bends could not express what was asked of it.
Its `lo` column was anchored to `Math.max(0, rest - lo)` with a rest angle near
zero, so it came out as 0° on all 14 rigs. The elbow's "no hyperextension" did
nothing at all. On every A-pose rig its shoulder entry came out as 0..180°,
which is no constraint. Its hip entry varied 3× across the fleet, because it
was measured against the sideways hip-to-thigh offset.

**FLEX is symmetric, and that is wrong on purpose.** A trunk curls far forward
and arches very little, but the fleet reaches about 30° of backbend where a body
has about 15°. A signed version was written and does not work. Choosing the
limit by which way the joint leans needs the sign of the distal link's lean.
Near straight that vector is close to zero and its sign is noise, so the limit
flickers between its two values, and it threw a foot at 24 m/s. A deadband
swaps the flicker for a dead zone. A proper fix needs real bone frames with a
stable up-vector, which means a rigid-body solver. The extra backbend is the
price.

**FLEX skips micro-links.** A link only has a direction if it has a length.
mythos-wings authors its spine 7.2 mm above its hips, so 1 mm of solver jitter
reads as about 8° of flexion, and FLEX answered it by swinging the real
spine→chest link every substep. The result was a 65 m/s peak at ground impact
on a plain topple (claude_suit: 3.8 m/s).

**HINGE transports its axis.** If the axis is rebuilt from the body's forward
projected onto the limb's normal plane, its sign flips whenever the limb lines
up with forward. For one pass that reads as "hyperextended by 180°", and the
clamp threw the foot across the body. The feet became 13 m/s projectiles, and
all 14 rigs ran to the 8 s deadline. Transporting the axis cannot flip it. The
hyperextension check has a deadband, because a limb resting exactly straight
has a sign that is numerical noise.

**A limit is a hard stop, not a spring** (`_stop`).
- Carrying the whole correction into `prev` keeps the velocity that pushed the
  joint past the limit, and the limit gives it back as the joint unwinds. A
  collapsing body folds its knees into their stop and then kicks its legs out:
  12.9 m/s of foot after landing.
- Dropping the carry entirely is worse, because the correction then reads as
  new velocity. Settle never fires, and the body sits in a 0.7 m/s limit cycle.
- The answer is to remove only the velocity component driving into the limit.
  That brought the foot to 4.1 m/s.
- A correction worth half a bone lands dead (`prev = p`). Skipping the carry
  instead leaves `prev` behind, the next step reads the teleport as speed, and
  the hands orbited at 5 m/s.

Per-pass corrections are a multiplicative yield (`YIELD`). An exact snap
teleports an overshot limb, and a fixed angle cap starves when another
constraint contests the joint.

## 4. How a body goes over (`lean`)

`lean` is a velocity weighted by height: none at the lowest joint, all of it at
the highest. That makes a topple about the feet. A uniform shove only slides the
body sideways, and it pancakes. A 0.8 m leg then has nowhere to put its length,
so the knee jams into its stop under the torso's weight and unwinds ("lands on
its butt, then the legs kick out"). Toppling spends the same energy on rotation.
Across the fleet, the worst foot speed after landing fell from 4.1 to 1.6 m/s.

## 5. Handover: a sim continues, it doesn't restart

A streamed pose shows where the bones point. It does not show where the
particles are or how fast they move. A sim rebuilt from a pose therefore starts
at zero velocity, so a body swung at 3 m/s and let go settled on the spot, and
every rebuild (a nail pulled, a drag let go) threw the momentum away.
`snapshot()` carries positions and velocities instead (in rigmeasure.js's
`snapshotPacker` format, shared with the other engine), and `seedVel` inherits
them.

A snapshot also has to carry the hinge axes it transported. A doll rebuilt
mid-tumble from its rest normals measures its elbows and knees against axes the
limbs left long ago. Its first step then puts the whole correction into the
lightest particles: hands ended 12–22 cm off after one step on 41 of 44 fleet
rigs (TEL0S_NOTES §24t-8). A snapshot without axes, such as one from another
engine, gets normals derived from where the limbs are.

## 6. Measured offsets

- **hipsOffset** (the origin below the hips) runs from about 0.55 (youngopus)
  to about 0.91 (aporia). A hardcoded value put the pelvis about 25 cm
  underground on a short avatar. It comes from the neutral pose, because a walk
  cycle moves the hips. The `rest` map has to be captured with the root where it
  is now.
- **Joint ground clearance** is the joint's own measured radius.
  `resolveColliders` treats a radius as horizontal (a vertical cylinder), so a
  single 6 cm constant used to do this job for 0.63 m and 1.53 m avatars alike.
- **Bone direction** runs from the joint's particle to its child's, never from
  the skeleton's bone position, which `_followRoot` alone places. On tel0s the
  hips sit 23 cm forward of the root. The two sources disagreed by that much,
  the hips→spine direction became noise, and the chest inherited 42° of roll
  (§24t-8).

## 7. Roll references are transported

If a body axis is chosen per bone and the roll is rebuilt from it each frame,
a limb that swings onto its own reference has no defined roll, and falling back
to another axis makes the roll jump. In measurement the arms sat at
dir·ref = 0.99 and snapped 178° in one frame. Carrying the reference and
re-squaring it against the bone rotates it exactly as much as the bone, which is
also what an untorqued limb does with its twist.

## 8. Contacts

- **Capsules are inelastic.** A soft push never fully clears the overlap, so if
  each push reads as separation velocity, two resting limbs trade energy
  forever. On one wide rig the legs came to rest touching: 1 mm a step, 83 mm of
  travel for 5 mm of progress, up to the deadline.
- **Rest-overlapping pairs are excluded.** The chest capsule overlaps the neck
  capsule on every real body. A constraint already violated in the rest pose
  acts as a motor that inflates the torso.
- **Ground contact is a pure vertical clamp,** so a grounded joint keeps its
  horizontal velocity. A body that is already down can creep while an arm
  fights its limits: mythos-2 moved 39 cm over 5.5 s after a shove, and
  ragdoll-test names the case. A sleep-regime grip made the fleet worse (a
  feline rig flailed at capture). The open fix is a tuned ground-friction law
  swept in rag-tune.
- **World collision runs once per frame,** not once per pass. In the inner loop
  it cost 100+ spatial-hash queries a frame. The substeps keep a cheap terrain
  clamp so nothing tunnels.

## 9. The body frame and settling

- **Forward = right × up** from the particles, checked against the toe
  direction on all 12 rigs that have toes. It holds for VRM 0.x and 1.0 alike:
  they face opposite ways on +Z, the pelvis right-vector flips with them, and
  the cross product cancels the convention out. A degenerate fold keeps the
  last good frame.
- **Speed is the distance actually travelled,** not Verlet's `p - prev`. Every
  limit carries its correction into `prev`, so a joint parked on its limit has a
  `prev` offset that describes no motion. A hand moving 0.11 mm per step
  reported 0.54 m/s and kept the whole body above the settle threshold until
  the 8 s deadline.
- **Sleep damping.** Near rest, damping gets much harder (island sleeping). The
  last residual chatter is always in a hand, which weighs 1/24 of the pelvis and
  sits four links out, so it inherits whatever error the relaxation could not
  place anywhere else.
