# Light rig: measurements and decisions

Rationale behind `client/lib/render/lightrig.js`. TEL0S_NOTES §12.1 is the r184 ground truth it is built on; the history is
in git.

## Fixed slots

The pipeline cache keys lights by (id, castShadow) in scene-traversal order; intensity-0 lights stay in the hash and
visible=false culls them out of it. So N point slots are born at module init and never added, removed, reparented or
visible-toggled; an idle slot is intensity 0, and slot churn is uniform writes. Adding a point light used to be a
whole-scene recompile (grass + 4 lights measured never finishing), which is what a budget of 4, a compileAsync per
grant and a one-way governor ratchet existed to ration.

N defaults to 8, measured with lightbench --measure (removed in #13; see git history): with the compile at boot, a full grass field compiled in
1379/1510/1551/1597 ms at 4/8/12/16 slots and held ~120 fps at every count on the dev machine. 8 is the modest end
because per-fragment loop cost and WGSL→Metal compile scale with slot count on weaker machines; the governor's cap lever
handles them downward, and `?slots=N` re-measures.

## The one casting slot (the chest lamp)

Slot 0 is born casting (flipping castShadow on a live slot is a recompile); the rest are not. A body lit from inside,
throwing its own shadows, is the point of the lamp, so a shadow-wanting request takes slot 0 by SWAP: the incumbent
takes the challenger's old slot, nobody is evicted. Only avatar.js asks for it: attachLamps is also the seam for every
placed glowing prop, and a nearer emissive orb must not take slot 0 off a body.

### Map, bias and bulb position (tuned by eye against a moving body)

    {map: 256, texels: 8, workDist: 12, forward: -0.02, up: 0.15}  →  normalBias 0.75, texel 93.75 mm

- normalBias 0.75 is 75 cm of offset along each surface normal, most of the torso's height: the shadow term is
  effectively pushed out of the scene and what reaches the wings is near-unoccluded falloff. It is "light the body from
  inside and mostly don't shadow it", reached through the only dial that could express it. `texels` here is not a
  contact offset in any meaningful sense.
- A cleaner knob, untried: `PointLightShadow.intensity` (0..1) scales how dark the shadow gets without distorting
  geometry; `{texels: 1.5, shadowIntensity: 0.25}` would likely land in the same place with the bias meaning what it
  says.
- forward is NEGATIVE: the wing mass sits entirely behind the bulb (wing z −0.734..−0.107 in bind space, bulb z +0.015),
  so light reaching a wing travels backward out of the chest.
- FORWARD IS −Z IN THE BONE FRAME (L_Eye/R_Eye sit at z −0.085 relative to Head); VRMUtils.rotateVRM0 flips the scene
  node so the body faces +Z in the world, but the nudge is applied in the bone's frame, upstream of that flip.
- normalBias offsets the shadow lookup along each NORMAL; on a torso and the tops of wings those point mostly up, so
  raising it looks like raising the bulb. It never moved the light; the forward/up/side nudge does.
- map 256: a point light needs six cube faces, and 2048 would be 24 MB for a 12 cm lamp.
- near/far go together: depth precision is the near/far RATIO. near 0.03 (the bulb is inside the body) with three's
  default far 500 gave 16,667:1 and quantised a body 0.6 m away to nothing; far is bounded by the light's own falloff
  distance and follows whichever request holds the slot.

### Where a skinned lamp is

A SkinnedMesh's node sits at the body root while its vertices are in BIND-POSE coordinates, so the bounding-sphere
centre is an absolute (0, 1.47, 0.0155). Rotating that by the body's quaternion swept the light 0.34 m in x and
0.36 m in z while turning in place (it lit one wing or the other by facing). The lamp is located through the
skeleton instead: the bind-space centre times the bone matrix of the dominant joint (one bone, not a blend: the lamp
is skinned to one bone at weight 1.0).

## Sun shadow follow-box

The frustum follows the camera by sliding the ortho EXTENTS in the light's view frame (moving sun.position would fight
the sky), snapped to texels against shimmer. The near plane may be negative: the camera often stands up-sun of the
light's fixed point, and clamping near ≥ 0.1 threw that whole quarter out of the map (casters "casting", no shadow).
three reads shadow.camera.near/far only for VSM and log depth. In XR, the camera's WORLD position is used (it is a
child of the rig).

## The shadow switch is uniform-level

shadowMap.enabled and castShadow are in every lit material's pipeline key, so flipping them recompiled the whole scene
(seconds per relink on some GPUs) and raced ShadowNode into 'reading depthTexture of null'. They are fixed on at boot;
'off' is the shadow's own intensity 0 with its depth pass stopped. Cost: shadows-off still carries the lookup in lit
shaders.

## Day-awareness

`dayness` starts null (unknown), not 1: dayGlow is (1 − dayness)², so 1 would make "time unknown" mean zero light until
a sky loads. Unknown lights the lamp. glowScale() puts emissive surfaces on the same curve as their lights.
