// xrpointer — the VR laser's POLICY, in one place, as plain functions a test can run without a headset
// (tools/xrpointer-test.mjs). xr.js owns the per-hand loop and the scene; this owns the decisions it makes there:
//
//   1. WHEN THE BEAM IS DRAWN — the owner's "pointer laser" setting (Settings › VR, 10-02, after comparing with
//      Resonite): always / never / contextual. Contextual is the behaviour before the setting existed: the beam shows
//      while it rests on a panel or a nameplate, or while grip or trigger is held. Never hides the BEAM only: pointing,
//      clicking, the stick scroll and nameplate hover all still work.

// ---- 1. the setting -------------------------------------------------------------------------------------------
export const LASER_MODES = ['always', 'never', 'contextual'];
export const LASER_DEFAULT = 'contextual';
export const laserMode = (v) => (LASER_MODES.includes(v) ? v : LASER_DEFAULT);   // an unknown stored value reads as the default
/** Is the beam drawn this frame? `target`: the ray rests on a panel or a nameplate. `grip`/`trig`: held. */
export function laserVisible(mode, { target = false, grip = false, trig = false } = {}) {
  const m = laserMode(mode);
  if (m === 'never') return false;
  if (m === 'always') return true;
  return !!(target || grip || trig);
}
/** Does the hand look for WORLD entities this frame (the laser's length)? Panels and nameplates are always looked
 *  for — they are the targets a resting laser serves. The world is looked at only while a button is held, or when the
 *  beam is always drawn: an idle hand in contextual or never mode must not paint a dot on every wall it hangs toward
 *  (and must not pay a scene raycast per hand per frame for it). */
export const looksAtWorld = (mode, { grip = false, trig = false } = {}) => laserMode(mode) === 'always' || !!(grip || trig);
