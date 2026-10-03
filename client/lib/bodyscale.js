// bodyscale — "this body": the wearer's chosen SIZE and NAMEPLATE LIFT for the body they have on (Profile › Avatar;
// R, 2026-09-30). Pure: no THREE, no DOM — tools/bodyscale-test.ts drives these very functions.
//
// SIZE, Basis/VRChat semantics: one multiplier `u` grows the body, its eye height, its stride (move speed) and its
// collider together. On an Avatar it lives on vrm.scene (never the root: the root also carries the nameplate,
// the typing pill and the bubble, which stay screen-sized — platesize.js owns their size), multiplied with the VR
// puppet fit: vrm.scene.scale = u · puppet.
//
// IN VR (xr.js DeviceScale, Basis's way): the puppet wears 1/k, k = avatar eye / your eye, so your authored body's eyes
// land at your real eye height H with tracking 1:1. A chosen size u must NOT be undone by that fit — and eyes must
// still sit at the HMD and hands on the controllers. So the TRACKING SPACE (the rig: camera + controllers) scales by u
// too: the HMD then reads u·H in the world, the body is u·(1/k)·E = u·H tall at the eye, the controllers are u× as far
// from the rig as your hands are from your feet, and the arms (u/k × authored) reach them — the same 1:1 as before,
// one size up. The world looks 1/u as big, which is what being big IS. Everything the rig measures in its own frame
// (the head-height samples that decide k, the recentre offsets) is in rig-local units, i.e. divided by u.
//
// NAMEPLATE LIFT: metres above the measured crown (plateanchor.js), at the body's AUTHORED size — applied × the live
// model→world scale, so it grows with the body and follows sitting/lying exactly as auto does. 0 = auto.
import { clampBodyScale, clampPlateY, BODY_SCALE_MIN, BODY_SCALE_MAX, PLATE_Y_MIN, PLATE_Y_MAX } from '../../shared/presencewire.js';
export { clampBodyScale, clampPlateY, BODY_SCALE_MIN, BODY_SCALE_MAX, PLATE_Y_MIN, PLATE_Y_MAX };

/** The VR composition. u = chosen size, k = measured device ratio (avatar eye / your eye; 1 unmeasured).
 *  → { body: what vrm.scene wears, rig: what the tracking space wears, puppet: the device fit alone } */
export function xrScales(u, k) {
  const uu = clampBodyScale(u), kk = typeof k === 'number' && k > 0 && Number.isFinite(k) ? k : 1;
  return { puppet: 1 / kk, body: uu / kk, rig: uu };
}

/** A head height measured in the WORLD while presenting, back into the playspace (rig-local) units k is defined in. */
export const toRigLocal = (worldY, rigScale) => worldY / (rigScale > 0 ? rigScale : 1);

/** The desktop follow camera's standing eye (controller.js: 1.45 m over the root for a 1.0 body). */
export const DESK_EYE = 1.45;
export const deskEyeY = (u) => DESK_EYE * clampBodyScale(u);

/** Move speed for a size: stride grows with the legs. */
export const scaledSpeed = (base, u) => base * clampBodyScale(u);

/** A ledge the body can climb onto (controller.js's mantle): 0.3–1.7 m over the feet at 100%, in proportion to the size.
 *  Jump height and gravity stay absolute — the mantle is a judgement about the body, the jump is physics. */
export const canMantle = (reach, u) => { const s = clampBodyScale(u); return reach > 0.3 * s && reach <= 1.7 * s; };
/** How far onto the ledge the mantle carries the root. */
export const mantleStep = (u) => 0.6 * clampBodyScale(u);

/** The walking capsule (colliders.resolveColliders r / tall): radius and height grow; a scaled body still climbs. */
export const COLLIDER_R = 0.32, COLLIDER_TALL = 1.9;
export const colliderFor = (u) => { const s = clampBodyScale(u); return { r: COLLIDER_R * s, tall: COLLIDER_TALL * s }; };

/** A locomotion clip's playback rate: a u× body covers u× the ground per cycle, so the same speed is 1/u the cadence.
 *  Same clamp as Avatar.setClip always used. */
export function clipRate(speed, natural, u) {
  const nat = natural * clampBodyScale(u);
  return nat > 0 && speed > 0 ? Math.min(1.6, Math.max(0.6, speed / nat)) : 1;
}

/** Where the plate hangs above the crown, WORLD metres: the authored lift × the live model→world scale. */
export const plateLift = (plateY, s) => clampPlateY(plateY) * (typeof s === 'number' && s > 0 ? s : 1);

// ---- per body, per browser (like ew-xr-scale: keyed by the worn body's NAME) ----
export const PREFS_LS = 'ew-body-prefs';
function readAll(storage) {
  try { const v = JSON.parse(storage?.getItem(PREFS_LS) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}
/** → { scale, plateY } for this body name, defaults when unknown/garbled. */
export function loadBodyPrefs(storage, name) {
  const v = name ? readAll(storage)[name] : null;
  return { scale: clampBodyScale(v?.scale), plateY: clampPlateY(v?.plateY) };
}
/** Merge a change for this body name and persist. Defaults are forgotten, not stored. → the stored { scale, plateY }. */
export function saveBodyPrefs(storage, name, patch) {
  const cur = loadBodyPrefs(storage, name);
  const next = { scale: clampBodyScale(patch?.scale ?? cur.scale), plateY: clampPlateY(patch?.plateY ?? cur.plateY) };
  if (!name) return next;
  const all = readAll(storage);
  if (next.scale === 1 && next.plateY === 0) delete all[name]; else all[name] = { ...next, t: Date.now() };
  try { storage?.setItem(PREFS_LS, JSON.stringify(all)); } catch { /* private mode */ }
  return next;
}
