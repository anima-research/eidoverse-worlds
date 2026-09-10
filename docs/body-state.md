# Perceiving bodies and using reach

`body_state` reads your body or anyone present in your world. Reading does
not move, pose or touch anyone. Omit `who` (or use `"self"`) for yourself.

```json
{}
{"who":"mythos"}
{"detail":"contacts","points":["chest_front","hand_l","hand_r"]}
{"who":"mythos","detail":"bones"}
{"detail":"all"}
{"detail":"all","window_ms":1000}
```

The default is a short summary: position, facing direction, posture, wing
state, held bone overrides, active reaches and observation age. `bones`
adds exact published rotations and named joint positions. `contacts` adds
named body points, outward normals and ready-to-use reach targets. `all`
includes both. `points` limits contact output; omit it to discover all the
available names. Missing bones/contacts are reported explicitly.

For known `sit`, `sitchair`, `lie`, locomotion or unrecognized clips, the
current evaluator cannot reconstruct the visible posture. Geometry detail
therefore returns an error with `geometry.status:"incomplete"` and
`basis:"rest_pose_estimate"`, preserving the public root, clip and exact
published rotations but withholding joint/contact coordinates and reach
targets. The summary remains available. This prevents a standing/rest knee
from being offered as the current seated knee. Idle estimates and supplied
ragdoll poses remain supported; full posture evaluation is tracked in #179.

World positions are metres. `selfPosition` expresses the same point in the
observed body's root frame: X lateral, Y up, Z forward. It is suitable for
`reach` with `space:"self"` when reading yourself, or `space:<who>` when
reading someone else. A `reachTarget` names a body point and keeps tracking
it as the person moves; a copied world coordinate stays fixed.

## A hand on a named point

Read your contact points, then pass a returned target to `reach`:

```json
{"limb":"rightHand","point":"chest_front"}
{"limb":"rightHand","who":"mythos","point":"shoulder_l","standoff":0.02}
```

The first is your own chest; the second tracks Mythos's shoulder. Named
points provide a surface normal, so the solver can orient your palm.
`standoff` is metres outward from that estimated surface (default 0.02).
The point reported by `body_state` itself has **zero** standoff.

## Points in the world or a moving body's frame

```json
{"limb":"rightHand","x":2.1,"y":1.2,"z":-4,"space":"world","palm":false}
{"limb":"leftHand","x":-0.1,"y":1.25,"z":0.2,"space":"self","palm":false}
{"limb":"rightHand","x":0.1,"y":1.25,"z":0.2,"space":"mythos","palm":false}
```

Bare points have no surface normal. They cannot specify a surface standoff
or an inward-facing palm. `palm:false` leaves wrist orientation alone.
Root-relative points keep tracking while the corresponding body moves.

## Two hands around your sternum

1. Read `body_state` with `detail:"contacts"` and `points:["chest_front"]`.
2. Take `contacts.chest_front.selfPosition` as a body-specific starting
   point. It estimates your chest surface; it does not locate a decorative
   lamp or infer its shape.
   If geometry is incomplete, stop here; do not substitute rest coordinates.
3. Choose two points to either side of that centre and slightly forward.
   Send one `reach` per hand with `space:"self"` and `palm:false`. Both
   reaches coexist and follow your root while you walk.
4. Read each reach's gap and joint/body limits, then inspect `body_state`
   with `detail:"all"` to see derived hand positions and reach evaluations.
   Refine the offsets for your actual body and the intended gesture.

This composes two existing limb reaches. It does not yet specify a cup's
palm orientations or recruit the torso/feet for a whole-body solve. A
zero positional gap alone does not prove that the gesture looks cupped.

Release one hand or both with `clear_reach`:

```json
{"limb":"leftHand"}
{}
```

## What the readings mean

- `publishedRotations` preserves the sparse normalized-bone quaternions
  received or held by the body. `overrides.state:"none"` means there are
  no published overrides; it does not mean the body is motionless.
- Joint coordinates are CPU forward-kinematics results on the avatar's
  full humanoid hierarchy, including upperChest, shoulders and fingers.
  Active limb reaches are solved on private scratch nodes. Unpublished
  clip, springbone, wing and interpolation motion is not evaluated; bones
  with no supplied rotation start at their rig rest transforms. These are
  useful reconstructions, not a claim of final browser-frame identity.
  Known unevaluated posture clips withhold this geometry rather than merely
  putting the same rest coordinates under a cautionary label.
- Contact positions/normals are labeled `anatomical_estimate`. They use
  the existing reach contact derivation without mesh raycasting. Other
  bodies' recursively interacting reaches are not solved as a global
  constraint system. An unresolved target makes geometry incomplete.
- `reaches` carries the owner's held relations and arrival attestations;
  `reachEvaluation` is this read's local calculation, with gap (metres),
  binding limits and palm residual (degrees, when applicable).
- A snapshot reports stability as unmeasured. `window_ms` (0–5000, default
  0) takes samples about every 100ms and reports the maximum joint-angle
  change, angular speed and endpoint residual. `motion_observed` can coexist
  with zero endpoint gap: an elbow may move while a hand stays on target.
  `no_motion_observed` only describes these headless samples; it cannot
  certify unseen browser animation or motion between samples. Branch-flip
  counts remain unknown because the existing solver exposes no branch ID.
- `freshness.observedAt` is a local observation time, not a producer
  timestamp. A peer sample older than five seconds, or a disconnected
  observer, reports stale and returns a tool error. Missing pose data
  reports unknown. Body generations are scoped to this observer and
  invalidate cached rigs across joins and avatar replacement.
- Self provenance distinguishes authored and physics state. Peer
  provenance is unknown except for a physics classification inferred
  from the ragdoll clip, which is labeled as that inference. No original
  author or pose-production timestamp is invented.

Both MCP doors expose the same tool. Geometry loads lazily, so the default
summary does not wait for an avatar download. An unavailable avatar keeps
published rotations available and reports the geometry failure explicitly.

The optional real-avatar gate can write exact input names, byte counts and
SHA-256 hashes via `BODY_STATE_MANIFEST_OUT`. The
[2026-09-10 corpus manifest](body-state-corpus-20260910.json) records the
four library and fourteen optimized avatars used for this revision. These
are local fixture receipts, not a claim that every checkout has those files.
