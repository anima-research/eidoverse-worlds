# Two-bone reach: design notes

Rationale behind `shared/reach.js` (two-bone IK bounded by the ragdoll's joint limits). The code comments point here by
section number.

## §1 Analytic, not CCD/FABRIK

A shoulder-elbow-hand chain is two links, and two links have a closed form. Iterative solvers buy generality this chain
does not need and pay for it in jitter (they converge differently from different starting poses) and in nondeterminism
across clients. Every client solves the same reach independently, so two clients that iterate differently would draw two
different arms. A closed form is the same arm everywhere, every frame, with no starting-state memory.

## §2 Limits come from the ragdoll's tables

The limits are `shared/joints.js`'s (the ragdoll's measured tables). An arm that can reach where it could never fall is two
different bodies: this module consumes those numbers and never second-guesses them. Thicknesses come from the same model,
so a reach and a fall disagree about nothing, least of all how thick the body is.

Lengths come from the REST skeleton, never the live one: measured against a moving body, the same avatar gets different
limits depending on which frame of the walk cycle it was asked on.

## §3 A clamped elbow rebuilds the triangle

A clamped elbow changes how far the hand can be from the shoulder, so the triangle is rebuilt from the angle rather than
the distance. Skipping this is the classic two-bone bug: the elbow obeys its limit and the hand still teleports to the
target, stretching the forearm.

## §4 The limits constrain the upper bone, not the aim

The cone and the frontal stop are properties of the SHOULDER, so they constrain the upper bone's own direction, not the
shoulder-to-target line. Those differ by `alpha`; clamping the aim lets an aim well inside the cone still put the arm
outside it (seen on a real rig: 84° behind the body on a limit of 65°, missed by a geometry suite that checked the same
wrong vector).

Cone and half-space are two constraints whose intersection is not reached by applying either once (each projection can
leave the other violated), so they alternate to a fixed point. Both are geodesically convex caps (half-angles under 90°),
which is what makes alternating projection converge instead of cycling. The loop is bounded and then verified: a pass
limit hit without feasibility is reported (`infeasible`).

The `bound` list reports what binds AT THE FIXED POINT, not what fired on the way: projection can touch the cone early and
be carried clear of it by the frontal stop. (Measured: 'cone' reported at 0.423 against a boundary of 0.087.) Callers
fall back on this list, so it must be trustworthy.

## §5 The shoulder's envelope is not a circle

One half-angle for every direction can't describe a shoulder: the 85° that stops it folding backwards over the spine also
stops the arm crossing the chest, which is most of what arms do socially (folding, hugging, a hand on your own shoulder).
As with BEHIND for hips, a second number serves one direction: `inward` points at the body's midline, and the allowance
(`coneAcross`) opens smoothly with how much adduction the reach ASKS for, measured before any clamp. Keying it off the
clamped vector is circular (the clamp stops the arm pointing inward, so it never opens; that version moved the hand 6 mm).

## §6 The torso pushes the upper bone

Widening the envelope alone moves the arm INTO the chest, because an adducted upper bone points through the body
(clearance fell 831/840 → 693/840). The elbow swivel can't rescue that: it turns the elbow about the shoulder-hand axis,
and the offending bone IS that axis. So the torso pushes the upper bone, as a projection in the same loop as the joint
limits: rotate it about the shoulder just far enough to lift its deepest point out of the capsule. An arm crossing the
chest ends up in front of it because that's where the geometry allows.

Only the UPPER bone is pushed. Rotating the shoulder is the sole lever, and using it to resolve a FOREARM collision swings
the whole arm away instead of tucking the forearm (reaching the opposite hip went from a 75 mm gap to 512 mm, arm beside
the head). A forearm crossing in front of the belly is a real pose that a spine-centred capsule can't represent; that is
the swivel's business, and §9's warp.

## §7 The swivel clears the body without moving the hand

Once the hand is placed, a two-bone chain has exactly one degree of freedom left: the SWIVEL of the elbow about the
shoulder-hand axis. Turning it moves the elbow without moving the hand, so the arm comes out of the torso and still touches
what it was asked to touch. Pushing the limb out bodily would break that promise.

The swivel list is ordered by |angle|, so the first clear one is the least departure from the pole hint; every client
sweeps the same list in the same order and picks the same arm. With nothing clear, the least-bad swivel is used rather
than refusing: an arm 2 cm inside a hip reads better than one that gave up.

## §8 Contact, not separation (CONTACT = 0.25)

Requiring capsules fully separated keeps the upper arm (torsoRadius + armRadius) from the SPINE AXIS, 14–22 cm on the
shipped rigs, further than the body is wide. An arm hanging against the side then counts as penetrating, and a hand on
your own hip can't be reached (the guards alone cost 80–190 mm of reach on one rig's hip_l, 228 → 41 mm on another). The
artefact worth preventing is the limb passing THROUGH the body, its centreline crossing the interior; its radius
overlapping the surface is contact. So most of a limb's radius may sink in.

## §9 Bodies are not round (the warp)

A guard may carry a WARP: the body-frame basis it is elliptical in, plus how much thinner it is front-to-back than
side-to-side. Distances are measured in a space where that ellipse is a circle; scaling is linear, so segment-segment
distance survives it. Without it, torsoRadius (0.42× the wider of shoulder or hip span, a half-WIDTH) is also the
half-depth, and a forearm crossing in front of the belly reads as buried in it: a capsule has no front. A push direction
found in warped space is carried back (`unwarpDir`), or the arm is shoved along an axis the body doesn't have.

## §10 Clip guards near the target, don't drop them

You can't touch a hip without the hand entering the hip's capsule. Dropping the whole guard is too coarse: the torso is one
capsule from hips to chest, a hand reaching the hip is within R of its lower end, and the whole column vanishes; the
forearm then passed through the chest with zero penetration reported (3 mm from the spine where 162 mm was required).
Clipping keeps every part of the body that isn't where the hand is going; the excluded span is one interval, so at most two
pieces remain.

## §11 Hysteresis without feedback

- **CLEAR (1 mm).** A pose exactly on the penetration boundary flickers as the body breathes: the search alternated between
  a pose that reached exactly and one 61 mm short, every other frame. A millimetre of tolerance is invisible and turns a
  knife edge into something a body can rest against.
- **Accept strict, keep tolerant.** Accepting a fresh pose with the elbow on the wrong side of the chord is the artefact the
  rule prevents (letting it in "a little" let 72 back through). Keeping the incumbent tolerates a few degrees, since a
  strict boolean flips on noise. The chord test is a proxy sound only while the arm isn't adducted, so it's gated off for
  reaches across the chest.
- **The previous elbow.** A swivel angle is relative to the projected rest-direction pole, which flips when a lateral
  target crosses the pole axis, so the same angle can move the elbow half a metre. The previous physical elbow is tried
  directly first, only when its endpoint was reached. It is never the sweep's base pole: rotating our own output each frame
  can self-excite an oscillator. A constrained miss isn't an inverse of the triangle, so it isn't fed back.
- **The swivel latch.** Penetration hovering at zero at one of the discrete swivels made the winner alternate (an 18–64 mm
  elbow jump on four rigs while the body drifted 0.5 mm). The previous angle is tried first and kept while still clear.
- **STICK (3 cm) on the retreat pick.** A deadband latch, not feedback: an incumbent keeps its place until a rival beats it
  by STICK, and switching back needs STICK again, so noise can't drive a cycle. The incumbent gets a FULL evaluation outside
  the shortlist; scoring it cheaply and letting it fall out of the top six was the failure the latch existed to prevent.

## §12 Unreachable: the nearest pose the body allows

When no swivel clears, the solver neither gives up nor drives the arm through the body, unless no retreat clears either: then
it returns the original pose with `penetration` > 0 and `retreat: 1` (`shared/reach.js` solveTwoBoneClear), which a caller
must check. The nearest allowed pose is NOT on
the line to the target: reaching the far hip, every point on that line penetrates (floor ~65 mm), folded against the chest
near the shoulder and through the torso further out. The clear poses are OFF the line, lower or further round. So it
samples directions in a cone about the target and distances along each, scores each by where the HAND actually lands
against the target, probes cheaply (one solve), and runs the full swivel search on the best six.

## §13 Directions → bone rotations

A VRM's normalized humanoid rig has identity rest rotations, so the rotation a bone needs is the one taking its rest
direction to its wanted one, and a child subtracts its parent's. Minimal-arc leaves roll about the bone's axis at zero (the
ragdoll's swing construction): position IK doesn't determine twist; the spare degree of freedom is the POLE, and twist
belongs to whoever aims the hand.

`rest` carries what the rig IS at rest in the avatar root's frame. Without it, rest is assumed identity in root space, true
on many rigs and false on any Mixamo-derived one, where the normalized hierarchy sits 180° from the root: every rest
direction gains a half-turn and the arm reaches the mirror image (a hand 0.35 m ABOVE the shoulder for a target 0.38 m
below, while the solver reported a 34 mm gap: the maths was right and the frame was not).

## §14 The palm

Position IK says where the hand goes, not how it's turned, so a hand arrives with its back against the skin as often as
not. Most of the correction belongs to the forearm (pronation/supination, the ragdoll's TWIST.lowerArm = 80°); the rest
goes to the wrist, clamped, because a hand bent past its range reads worse than a palm merely off-angle.
