// client/lib/vehicles.js — driving a hull from its helm (port of upstream main's client/lib/vehicles.js updateVehicle): this
// client steps the hull with shared/drive.js and streams its pose; the authority checks each step (authority/drive.js).
import { bus, CONFIG } from './base.js';
import { entities, bagOf } from './world.js';
import { avatarMounts } from './mounts.js';
import { sendDrive } from './net.js';
import { keys } from './controller.js';
import { reindexCollider } from './colliders.js';
import { driveOf, isHelmC, stepDrive } from '../../shared/drive.js';

const SEND_MS = 66;   // ~15 Hz, upstream's lease cadence
// `local`: the hull's pose as I drive it; the log's periodic commits (a step behind) never pull it back, only a refusal does
let vel = [0, 0, 0], lastSent = 0, level = 0, driving = null, local = null;

/** The hull my seat drives (its id), or null: my mount is a helm (station.input {move: 'drive'}) on a thing with drive. */
export function helmHull() {
  const m = avatarMounts.get(CONFIG.name), c = m ? bagOf(m.to) : null;
  const host = c && isHelmC(c) ? c.parent?.to : null;
  return host && driveOf(bagOf(host)) ? host : null;
}
const axis = (a, b) => Number(keys.has(a)) - Number(keys.has(b));

/** One frame at the helm: W/S thrust (or set the throttle), A/D steer, Space/C rise and sink (Space leaves a helm whose leaveBy lets a jump). */
export function updateHelm(dt) {
  const id = helmHull(), o = id ? entities.get(id) : null, spec = id ? driveOf(bagOf(id)) : null;
  if (!o || !spec) { if (driving) { driving = null; vel = [0, 0, 0]; level = 0; local = null; } return false; }
  if (driving !== id) { driving = id; vel = [0, 0, 0]; level = 0; lastSent = 0; local = { pos: o.position.toArray(), q: o.quaternion.toArray() }; }
  const push = axis('KeyW', 'KeyS');
  if (spec.throttle) level = Math.max(-1, Math.min(1, level + push * dt * 0.5));
  const n = stepDrive(local, vel,
    { throttle: spec.throttle ? level : push, steer: axis('KeyA', 'KeyD'), rise: axis('Space', 'KeyC') }, spec, dt);
  vel = n.vel; local = { pos: n.pos, q: n.q }; o.position.fromArray(n.pos); o.quaternion.fromArray(n.q); o.updateMatrixWorld(true); reindexCollider(id);
  const now = performance.now(); if (now - lastSent >= SEND_MS) { lastSent = now; sendDrive(id, n.pos, n.q); }
  return true;
}
// the authority's answers: someone else's hull moving (relayed), or my step refused (snap back to the pose that stands)
bus.on('drive', ({ id, pos, q, by, snap }) => {
  const o = entities.get(id); if (!o || !Array.isArray(pos) || pos.length !== 3 || !Array.isArray(q) || q.length !== 4) return;
  if (!snap && driving === id) return;
  o.position.fromArray(pos); o.quaternion.fromArray(q); o.updateMatrixWorld(true); reindexCollider(id);
  if (snap && driving === id) { vel = [0, 0, 0]; local = { pos: pos.slice(), q: q.slice() }; }
});
