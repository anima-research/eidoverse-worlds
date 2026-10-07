// lookats — the browser realizer for `look-at` / `look-at:<part>` (batch 2): a thing, or one of its parts, turns to
// face something. The component is logged state; the turn is a view each client computes every frame, like motion
// (motion.js): nothing is logged, nothing is sent. The angle is shared/lookat.js evalLookAt, the same pure function a
// test runs; this file finds the target and applies the result.
//
//   a thing's id   its world position (+ offset in its frame), as every client sees it: everyone agrees
//   @viewer        THIS viewer's eyes: everyone sees it face themselves (Resonite's LookAtUser)
//   @nearest       the nearest body within range (yours included), its head
//   u-…            that person's head, within range
// Beyond range, or with no target, it eases back to rest. It runs after motion (main.js registers it later), so a bob or
// an orbit moves it and then it turns; a rotating motion on the same node is refused at the door (one driver per node).
// The door's geometry (placing, colliders, what stands on what) uses the logged transform, never the turned one.
import { THREE, camera } from './core.js';
import { bus } from './base.js';
import { entities, comps, findPart } from './world.js';
import { remotes } from './remotes.js';
import { evalLookAt } from '../../shared/lookat.js';

const live = new Map();   // `${id}\0${key}` → { node, rest: [x,y,z,w], q: [x,y,z,w] }
export const _lookats = live;   // probes
const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _fq = new THREE.Quaternion(), _eye = new THREE.Vector3();
let last = performance.now();

function targetOf(la, from) {
  const T = la.target; const range = Number.isFinite(la.range) ? la.range : 12;
  if (T === '@viewer') return camera.getWorldPosition(_t).toArray();
  if (T === '@nearest' || /^u-/.test(T)) {
    let best = null, bd = range;
    const consider = (p) => { const d = Math.hypot(p[0] - from[0], p[1] - from[1], p[2] - from[2]); if (d <= bd) { bd = d; best = p; } };
    if (T === '@nearest') consider(camera.getWorldPosition(_t).toArray());
    for (const [rid, r] of remotes) { if (!r.avatar?.root) continue; if (T !== '@nearest' && rid !== T) continue;
      const p = r.avatar.root.position; consider([p.x, p.y + 1.5, p.z]); }
    return best;
  }
  const o = entities.get(T); if (!o) return null;   // a deleted target: it rests ("looks at nothing")
  const off = Array.isArray(la.offset) && la.offset.length === 3 ? la.offset : [0, 0, 0];
  return o.localToWorld(_t.set(off[0], off[1], off[2])).toArray();
}

/** Per frame, after motion. */
export function tickLookAt() {
  const now = performance.now(); const dt = Math.min(0.25, (now - last) / 1000); last = now;
  const seen = new Set();
  camera.getWorldPosition(_eye);
  for (const [id, bag] of comps) {
    for (const key in bag) {
      if (key !== 'look-at' && !key.startsWith('look-at:')) continue;
      const la = bag[key]; if (!la || typeof la !== 'object' || typeof la.target !== 'string') continue;
      const obj = entities.get(id); if (!obj) continue;
      if (obj.position.distanceToSquared(_eye) > 8100) continue;   // 90 m, as motion: nobody sees it turn from there
      const part = key === 'look-at' ? null : key.slice(8);
      const node = part ? findPart(obj, part) : obj; if (!node || !node.parent) continue;
      const k = `${id}\u0000${key}`; seen.add(k);
      let h = live.get(k);
      // the rest: the node's pose as realized from the log (and any motion this frame), never our own turn
      if (!h || h.node !== node) { h = { node, rest: node.quaternion.toArray(), q: null }; live.set(k, h); }
      else if (!node.quaternion.equals(_fq.fromArray(h.q ?? h.rest))) h.rest = node.quaternion.toArray();   // something else set it (a place, a motion)
      node.parent.getWorldQuaternion(_fq); node.getWorldPosition(_p);
      const at = _p.toArray(); const target = targetOf(la, at);
      const r = evalLookAt({ rest: h.rest, frame: _fq.toArray(), at, target, la, prev: h.q ?? h.rest, dt });
      h.q = r.q; node.quaternion.fromArray(r.q);
    }
  }
  // a look-at removed: the node goes back to its rest
  for (const [k, h] of live) if (!seen.has(k)) { live.delete(k); if (h.node.parent) h.node.quaternion.fromArray(h.rest); }
}
bus.on('world-reset', () => live.clear());
