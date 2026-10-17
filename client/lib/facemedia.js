// facemedia — a sign or a picture added to a MODEL goes on its front face, where people can see it (review 10-07 S4).
//
// A text or picture component with no part draws at its thing's origin, facing +Z: on a crate that's inside the crate,
// half under the floor, and nobody saw it (B 07-picture-set). Roblox's SurfaceGui picks a face (Front by default) and
// fits the part; Unity puts a canvas at the object's front. Here the sign is its OWN thing, a child of the model, stood
// just past the model's front (+Z) face, centred on it and sized to it — one create, one undo, and it rides the model
// wherever it goes. The parent's scale is undone on the child so the sign keeps its own size on a stretched crate.
// Agents place the same way with create {place: {against: <id>}}; this is the person's one-click version.
import { THREE } from './core.js';
import { entities } from './world.js';
import { bus } from './base.js';
import { enc } from '../../shared/protocol/names.js';
import * as OP from '../../shared/protocol/requests.js';
import { sendOps } from './editwrites.js';

const r4 = (v) => +v.toFixed(4);
const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _s = new THREE.Vector3();

/** The thing's model box in its OWN frame (before its scale), leaving out child things, signs and picture quads; null
 *  when it has no mesh of its own (an empty, a light). */
export function ownBox(id) {
  const obj = entities.get(id); if (!obj) return null;
  obj.updateWorldMatrix(true, true);
  _inv.copy(obj.matrixWorld).invert();
  const others = new Set([...entities.values()].filter((o) => o !== obj));
  const own = (o) => { for (let p = o; p && p !== obj; p = p.parent) if (others.has(p) || p.name === 'sign' || p.userData?.pictureQuad) return false; return true; };
  const box = new THREE.Box3(); let any = false;
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry || !own(o)) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    box.union(o.geometry.boundingBox.clone().applyMatrix4(_m.multiplyMatrices(_inv, o.matrixWorld))); any = true;
  });
  return any && !box.isEmpty() ? box : null;
}

/** Where a sign goes on `id`: its local pose and how wide it may be (world metres), or null when it has no model. */
export function frontOf(id) {
  const box = ownBox(id); if (!box) return null;
  const obj = entities.get(id); obj.getWorldScale(_s);
  const s = [Math.abs(_s.x) || 1, Math.abs(_s.y) || 1, Math.abs(_s.z) || 1];
  const c = box.getCenter(new THREE.Vector3());
  return { pos: [r4(c.x), r4(c.y), r4(box.max.z + 0.01 / s[2])], scale: s.map((v) => r4(1 / v)), faceW: (box.max.x - box.min.x) * s[0], faceH: (box.max.y - box.min.y) * s[1], s };
}

/** Add `comp` (text | picture) with `data` to the model `id` as a sign on its front face: one act. Resolves with the
 *  reply; the new sign is selected once it lands. Returns null (nothing sent) when `id` has no model of its own. */
export async function addOnFace(id, comp, data) {
  const f = frontOf(id); if (!f) return null;
  const cid = '$sign';   // the authority mints its id (R 10-17); the reply's ids map says what it became
  const value = { ...data };
  let pos = f.pos;
  if (comp === 'picture') {
    value.width = r4(Math.max(0.1, Math.min(value.width ?? 1, 0.8 * f.faceW, 0.8 * f.faceH)));
    pos = [pos[0], r4(pos[1] - value.width / 2 / f.s[1]), pos[2]];   // the quad stands from its lower edge: centre it (a square guess until the image says)
  } else if (comp === 'text') value.width = r4(Math.max(0.1, Math.min(value.width ?? 2, 0.9 * f.faceW)));
  const op = OP.create(cid, { transform: { pos, scale: f.scale }, components: { parent: { to: enc(String(id)) }, label: comp === 'text' ? 'sign' : 'picture', [comp]: value } });
  const r = await sendOps([op], { what: comp === 'text' ? `put a sign on ${id}` : `hang a picture on ${id}`, expect: false });
  if (r?.ok && r.ids?.[cid]) selectWhenHere(r.ids[cid]);
  return r;
}

/** Select a thing once the replica has drawn it (a created thing arrives a frame or two after the reply). */
export function selectWhenHere(id, ms = 3000) {
  const t0 = performance.now();
  const go = async () => {
    if (entities.has(id)) { const sg = await import('./scenegraph.js'); sg.sceneSelect(id); bus.emit('edit-righttab', 'inspector'); return; }
    if (performance.now() - t0 < ms) setTimeout(go, 60);
  };
  go();
}
