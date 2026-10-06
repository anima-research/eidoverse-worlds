// lights — placed light sources, as authored entities.
//
// A light is a Thing: it persists, replays, and folds into the snapshot, so it
// is a `light` VERB, not presence. Each one renders two parts:
//
//   * a small emissive sphere GIZMO — always shown, cheap (one basic material,
//     no scene-wide cost), so a light is visible and selectable even when it
//     isn't casting;
//   * a REQUEST to the light rig (lightrig.js) — the rig owns a fixed pool of
//     point-light slots born at boot, and assigns them by priority: `keep`
//     first, authored placed lights next, inferred lamps last, ties by
//     camera distance. Winning a slot is uniform writes, never a recompile.
//
// The budget that used to live here (MAX_CAST, grantCast, the shared count
// with sky.js's lamps, the one-way governor ratchet) is gone — it existed
// because adding a PointLight recompiled every material in the scene, and the
// rig's fixed topology deletes that cost. `keep: true` is top PRIORITY in the
// rig, not a budget escape: an author saying "this light matters", honored
// ahead of everything sheddable, but the pool is the pool.
//
// Placed lights live in time of day like lamps do (the rig dims them by
// dayness); the deliberate noon-burning porch light gets its opt-out verb
// arg with the 5f spec work.

import { THREE } from './core.js';
import { bus } from './base.js';
import { requestLight, updateRequest, releaseLight, isCasting } from './lightrig.js';
import { entities } from './world.js';

// governor compatibility re-exports (main.js's shed lever; 5d replaces)
export { shedALight, litCount } from './lightrig.js';

/** A bare gizmo mesh — the visible, always-cheap part. Used both for a placed
 *  light and as the placement ghost. */
export function makeLightGizmo(color = 0xffd9a0) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 16, 12),
    // basic node material: emits its colour regardless of scene lighting, so
    // the gizmo reads as a glowing bulb and costs no lighting recompute
    new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color), toneMapped: false }),
  );
  m.userData.perfscopeIgnore = true; // an editor primitive, not scene content — cost views skip gizmos
  m.userData.noCamCollide = true;   // don't let the camera collide with a bulb
  m.castShadow = m.receiveShadow = false;
  m.userData.noWet = true;          // a glowing bulb does not get rained dark —
  m.userData.noCloudShadow = true;  // and the sweep must not recompile it
  return m;
}

/** Build a placed-light entity: gizmo + a rig request keyed to its id. The
 *  slot follows the group, so a `place` moves the cast with the bulb. */
export function makeLight({ color = 0xffd9a0, intensity = 16, range = 10, keep = false, day } = {}, owner = null) {
  const group = new THREE.Group();
  const gizmo = makeLightGizmo(color);
  group.add(gizmo);

  group.userData.isLight = true;
  group.userData.lightParams = { color, intensity, range, keep: !!keep, day: day !== false };
  group.userData.noCamCollide = true;

  const key = `placed:${owner ?? group.uuid}`;
  group.userData.rigKey = key;
  requestLight(key, {
    obj: group, color, intensity, range,
    keep: !!keep, authored: true, dayAware: day !== false,
    owner: owner ? `entity:${owner}` : null,
  });
  return group;
}

/** Partial update of a placed light — the render side of re-issuing the
 *  `light` verb on an existing id. Only fields present in the patch change;
 *  the fold upstream merges the same way, so a joiner and a live client
 *  agree. Slot assignment reacts on the rig's next pass — checking "keep
 *  lit" on an outbid light re-lights it visibly. */
export function updateLight(group, { color, intensity, range, keep, day } = {}) {
  if (!group?.userData?.isLight) return;
  const p = group.userData.lightParams;
  if (color != null) p.color = color;
  if (intensity != null) p.intensity = intensity;
  if (range != null) p.range = range;
  if (keep != null) p.keep = !!keep;
  if (day != null) p.day = day !== false;

  if (color != null) {
    const gizmo = group.children.find((o) => o.isMesh);
    gizmo?.material?.color?.set(new THREE.Color(color));
  }
  updateRequest(group.userData.rigKey, {
    color: p.color, intensity: p.intensity, range: p.range, keep: p.keep,
    dayAware: p.day,
  });
}

/** Free a light: release its request (the rig re-fills the slot) and dispose
 *  the gizmo. */
export function disposeLight(group) {
  if (!group?.userData?.isLight) return;
  releaseLight(group.userData.rigKey);
  group.traverse((o) => {
    o.geometry?.dispose?.();
    if (Array.isArray(o.material)) o.material.forEach((m) => m?.dispose?.());
    else o.material?.dispose?.();
  });
}

// ---- the inspector ------------------------------------------------------------
// The fields are declared once, for every surface, in shared/editschema.js; a light is a thing's `light` component and
// commits through the shared edit path (one door request on release). This module adds only what the panel shows.
export const lightCasting = (obj) => (obj?.userData?.rigKey ? isCasting(obj.userData.rigKey) : undefined);
