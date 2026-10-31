// client/lib/climb.js — my body on a climb route (componentspec climb; shared/climb.js), ported from upstream main #248's
// client/lib/traversal.js. The state is {host, progress, dir}: presence sends {host, progress}, and every frame resolves it
// through the host's live object, so a moving carrier carries its climber.
import { THREE } from './core.js';
import { bus } from './base.js';
import { state } from './state.js';
import { routeOf, climbPose, boardAt, stepClimb } from '../../shared/climb.js';

let objects = () => new Map(), active = null;
export function setClimbObjects(fn) { objects = fn; }
export const climbing = () => active !== null;
/** My presence while climbing ({host, progress}: shared/climb.js climbWire), else null. */
export const climbPresence = () => (active ? { host: active.host, progress: active.progress } : null);
export function cancelClimb() { active = null; }
bus.on('world-reset', cancelClimb);
bus.on('net', (n) => { if (!n.joined) cancelClimb(); });

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
/** A host's live pose {pos, q, scale} (its drawn object), or null when it isn't drawn. */
export function hostPose(id) {
  const obj = objects().get(id); if (!obj) return null;
  obj.updateWorldMatrix(true, false); obj.matrixWorld.decompose(_p, _q, _s);
  return { pos: _p.toArray(), q: _q.toArray(), scale: _s.toArray() };
}
const routeHere = (id) => { const e = state.st.entities[id]; return e?.disabled === true ? null : routeOf(e?.climb); };

// the hosts with a route, read again only when the view is a new one (state.js: every change is a new view)
let routesOf = null, routes = [];
const climbHosts = () => {
  if (routesOf !== state.st.entities) { routesOf = state.st.entities; routes = Object.keys(routesOf).map((id) => [id, routeHere(id)]).filter(([, r]) => r); }
  return routes;
};
/** The route end nearest `pos` within its reach: {host, progress, dir, distance, name}, or null. */
export function nearbyClimb(pos) {
  let best = null; const at = [pos.x, pos.y, pos.z];
  for (const [id, route] of climbHosts()) {
    const pose = hostPose(id); if (!pose) continue;
    const b = boardAt(pose, route, at);
    if (b && (!best || b.distance < best.distance)) best = { host: id, ...b, name: typeof state.st.entities[id].label === 'string' ? state.st.entities[id].label : 'ladder' };
  }
  return best;
}
export function startClimb(pos, candidate = nearbyClimb(pos)) {
  if (!candidate) return false;
  active = { host: candidate.host, progress: candidate.progress, dir: candidate.dir };
  return true;
}
/** One frame: {pos (THREE.Vector3), yaw, done, speed} while climbing, else null. The route or its host gone ends the climb. */
export function stepOnClimb(dt) {
  if (!active) return null;
  const route = routeHere(active.host), pose = route && hostPose(active.host);
  if (!route || !pose) { cancelClimb(); return null; }
  const s = stepClimb(route, active.progress, active.dir, dt); active.progress = s.progress;
  const p = climbPose(pose, route, s.progress);
  if (s.done) cancelClimb();
  return { pos: new THREE.Vector3().fromArray(p.pos), yaw: p.yaw, done: s.done, speed: route.speed };
}
/** Where a climber's presence {host, progress} puts them now, through the host's live object: {pos, yaw}, or null. */
export function climbAt(c) {
  const route = c && routeHere(c.host), pose = route && hostPose(c.host);
  return pose ? climbPose(pose, route, c.progress) : null;
}
