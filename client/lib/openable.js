// openable — a thing that opens and closes when someone uses it (R 10-07: the behaviour, not the asset: a door, a
// gate, a lid, a hatch; shared/v4/catalogue.js `openable`). The log holds its STATE (open: true/false); every client
// tweens toward it over `time` seconds, the conventional door (Unity/Godot/Roblox recipes, Unreal's door timeline): a
// turn of `angle` about `axis` through the thing's pivot, or a slide of `slide` in its own frame. The tween is
// presentation, never logged: a late joiner draws it as it is, with no swing. A part (`part`) moves instead of the whole
// thing, about the part's own origin (motion.js's part convention).
//
// The pure halves (openFraction, openPose) live in motioneval.js (no THREE, no DOM: tools/v4/shiplist-check.ts and an
// agent can read them); tickOpenables applies them.
import { entities, comps, findPart } from './world.js';
import { reindexCollider } from './colliders.js';
import { qAxisAngle, openFraction, openPose, OPEN_DEFAULTS } from './motioneval.js';
export { openFraction, openPose, OPEN_DEFAULTS };

const tweens = new Map();   // id → {from, to, t0, dur, obj, base, sig, f}
const isBag = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** Once a frame (main.js). Only things with an openable are visited; a shut one nobody has opened is never touched, so
 *  edit-mode gestures on it stay the gizmo's. */
export function tickOpenables(now = performance.now()) {
  for (const [id, bag] of comps) {
    const o = bag.openable; if (!isBag(o)) continue;
    const want = o.open === true ? 1 : 0;
    let r = tweens.get(id);
    if (!r) tweens.set(id, (r = { from: want, to: want, t0: now, dur: 0 }));   // as it is when we first see it: no swing
    else if (r.to !== want) { const f = openFraction(r, now);
      Object.assign(r, { from: f, to: want, t0: now, dur: Math.max(0, (Number.isFinite(o.time) ? o.time : OPEN_DEFAULTS.time) * 1000 * Math.abs(want - f)) }); }
    apply(id, bag, o, r, openFraction(r, now));
  }
  for (const [id, r] of tweens) if (!isBag(comps.get(id)?.openable)) { restore(id, r); tweens.delete(id); }
}

function apply(id, bag, o, r, f) {
  const obj = entities.get(id); if (!obj) return;
  if (o.part) {
    const part = findPart(obj, o.part); if (!part) return;   // not loaded yet: next frame
    const sig = `p|${f}|${o.angle}|${o.axis}|${o.slide}`; if (r.obj === part && r.sig === sig) return;
    if (f === 0 && !r.drawn) { r.obj = part; r.sig = sig; return; }
    const pb = part.userData.mbase ?? (part.userData.mbase = { pos: part.position.toArray(), quat: part.quaternion.toArray() });
    const p = openPose({ pos: pb.pos, q: pb.quat }, o, f);
    part.position.set(...p.pos); part.quaternion.set(...p.q);
    Object.assign(r, { obj: part, sig, drawn: f !== 0, part: true });
    return;
  }
  // a whole-thing motion owns the pose (motion.js); a mounted thing rides its parent
  if (bag.motion?.type || obj.userData.mountedTo) return;
  const base = obj.userData.base; if (!base) return;
  const pv = bag.pivot?.pos; const pivot = Array.isArray(pv) && pv.length === 3 ? pv : [0, 0, 0];
  const sig = `${f}|${o.angle}|${o.axis}|${o.slide}|${pivot}|${obj.scale.x},${obj.scale.y},${obj.scale.z}`;
  if (r.obj === obj && r.base === base && r.sig === sig) return;
  if (f === 0 && !r.drawn && r.obj === obj && r.base === base) { r.sig = sig; return; }
  const p = openPose(base, o, f, pivot, [obj.scale.x, obj.scale.y, obj.scale.z]);
  obj.position.set(...p.pos); obj.quaternion.set(...p.q);
  Object.assign(r, { obj, base, sig, drawn: f !== 0, f });
  if (f === r.to) reindexCollider(id);   // where it came to rest is where bodies bump into it
}

function restore(id, r) {
  if (!r?.drawn || !r.obj) return;
  if (r.part) { const pb = r.obj.userData.mbase; if (pb) { r.obj.position.set(...pb.pos); r.obj.quaternion.fromArray(pb.quat); } return; }
  const b = r.obj.userData.base; if (!b) return;
  r.obj.position.set(...b.pos); const q = Array.isArray(b.q) && b.q.length === 4 ? b.q : qAxisAngle([0, 1, 0], b.yaw ?? 0); r.obj.quaternion.set(...q);
  reindexCollider(id);
}

/** probe surface: how open it is drawn now, and where it's going */
export const openableState = (id) => { const r = tweens.get(id); return r ? { f: openFraction(r, performance.now()), to: r.to, drawn: !!r.drawn } : null; };
