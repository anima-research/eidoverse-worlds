// lights — what a placed light shows: its GIZMO, a small emissive sphere, always drawn and cheap (one basic material, no
// scene-wide cost), so a light is visible and selectable even when it isn't casting. The cast itself is a REQUEST to the
// light rig (lightrig.js), made by the realizer (realize/models.js syncCompLight) for any thing with a `light` component —
// the rig owns a fixed pool of point-light slots born at boot and assigns them by priority: `keep` first, authored lights
// next, inferred lamps last, ties by camera distance. Winning a slot is uniform writes, never a recompile.
//
// The budget that used to live here (MAX_CAST, grantCast, the shared count with sky.js's lamps, the one-way governor
// ratchet) is gone — it existed because adding a PointLight recompiled every material in the scene, and the rig's fixed
// topology deletes that cost. `keep: true` is top PRIORITY in the rig, not a budget escape.

import { THREE } from './core.js';
import { isCasting } from './lightrig.js';

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
  m.userData.isGizmo = true;            // a thing's box is its model's, not its bulb's (realize/models.js boxOf)
  m.userData.noMaterialOverride = true; // the bulb is no material slot a `material` component may recolour
  return m;
}

// ---- the inspector ------------------------------------------------------------
// The fields are declared once, for every surface, in shared/editschema.js; a light is a thing's `light` component and
// commits through the shared edit path (one door request on release). This module adds only what the panel shows.
export const lightCasting = (id) => isCasting(`complight:${id}`);   // realize/models.js syncCompLight's request key
