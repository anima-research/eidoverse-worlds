// materialcomp — the browser host for the `material` component: an image on a named node of the thing's model
// (shared/material.js says what a bag means). Main's picture on a part, moved here (R 10-27: a picture is a quad of its own).
//
//   1. NEVER mutate the node's material: glTF materials are shared across primitives and instances, so painting one
//      screen by writing `map` paints every screen. Clone, texture the clone, restore the original on removal.
//   2. NEVER dispose the texture: the asset cache owns it (pictures.js imageTexture); the clone is ours to dispose.
//   3. A load installs only under the intent revision it was issued for (a new bag, a removal, the entity leaving or
//      re-realized, a world reset each bump it): the picture host's rule, pictures.js.

import { bus } from './base.js';
import { entities, findPart, bags } from './world.js';
import { prepareMaterial } from './materials.js';
import { normalizeMaterial } from '../../shared/material.js';
import { clientMayFetch } from '../../shared/mediasrc.js';
import { allowUntrusted } from './mediaprefs.js';
import { imageTexture } from './pictures.js';

const worn = new Map();      // id → { material, on: [[mesh, original, clone]] }
const pending = new Map();   // id → the bag, until it is worn (the comp usually lands before the model)
const revision = new Map();
const bump = (id) => { const r = (revision.get(id) ?? 0) + 1; revision.set(id, r); return r; };
const current = (id, r) => revision.get(id) === r;

/** The meshes under `node` that are this thing's own: never a child thing riding it, never a picture's quad. */
function meshesOf(node) {
  const others = new Set(entities.values()), out = [];
  const own = (o) => { for (let p = o; p && p !== node; p = p.parent) if (others.has(p) || p.userData?.pictureQuad) return false; return true; };
  node.traverse((o) => { if (o.isMesh && o.material && !Array.isArray(o.material) && own(o)) out.push(o); });
  return out;
}

function takeOff(id) {
  const h = worn.get(id); if (!h) return;
  worn.delete(id);
  for (const [mesh, original, clone] of h.on) { if (mesh.material === clone) mesh.material = original; clone.dispose(); }
}

async function wear(id, m, rev) {
  pending.set(id, m);
  const root = entities.get(id); if (!root) return;
  if (!clientMayFetch(m.texture, 'image', allowUntrusted())) { pending.delete(id); takeOff(id); return; }   // an untrusted link this viewer didn't allow (or no longer does: pictures.js takeDown)
  const node = findPart(root, m.node), meshes = node ? meshesOf(node) : [];
  if (!meshes.length) { console.warn(`[material] ${id}: node "${m.node}" is not on its model (or has no mesh): nothing worn`); pending.delete(id); return; }
  let tex;
  try { tex = await imageTexture(m.texture, false); }   // glTF UVs: no vertical flip
  catch (e) { console.warn(`[material] ${id}: ${m.texture} could not be loaded: nothing worn`, e); return; }
  if (!current(id, rev) || entities.get(id) !== root) return;
  takeOff(id);   // a replace: `original` is always the model's own material, never an earlier clone
  const on = meshes.map((mesh) => {
    const original = mesh.material, clone = original.clone();
    clone.map = tex;
    if (clone.color) clone.color.set(0xffffff);   // the image's colours are its own: an authored base colour would tint them
    if (m.lit === 'self' && clone.emissive) { clone.emissive.set(0xffffff); clone.emissiveMap = tex; clone.emissiveIntensity = 1; }
    prepareMaterial(clone, mesh);   // every world material passes the factory before its first compile (materials.js)
    clone.needsUpdate = true; mesh.material = clone;
    return [mesh, original, clone];
  });
  worn.set(id, { material: m, on });
  pending.delete(id);
}

function applyFrom(id, data) {
  const rev = bump(id);
  if (data == null) { pending.delete(id); takeOff(id); return; }
  const n = normalizeMaterial(data);
  if (!n.ok) { console.warn(`[material] ${id}: ${n.why}`); pending.delete(id); takeOff(id); return; }
  void wear(id, n.material, rev);
}

bus.on('comp', ({ id, type, data }) => { if (type === 'material') applyFrom(id, data); });
bus.on('entity', ({ id, kind }) => {
  if (kind !== 'remove' && kind !== 'demote' && kind !== 'spawn') return;
  // the subtree left (or was replaced) wearing our clones: forget them, and a load in flight for it is stale
  const rev = bump(id), h = worn.get(id);
  if (h) { worn.delete(id); for (const [, , clone] of h.on) clone.dispose(); pending.set(id, h.material); }
  if (kind === 'remove') pending.delete(id);
  else if (kind === 'spawn' && pending.has(id)) void wear(id, pending.get(id), rev);
});
bus.on('world-reset', () => { pending.clear(); for (const id of revision.keys()) bump(id); for (const id of [...worn.keys()]) takeOff(id); });
bus.on('media:trust', () => { for (const [id, c] of bags()) if (c?.material) applyFrom(id, c.material); });

/** For probes: what is worn where. */
export const _worn = worn;
