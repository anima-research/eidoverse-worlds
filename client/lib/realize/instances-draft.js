// instances-draft — the reader for the DRAFT component `antra/instances` (docs/contributing/COMPONENT-LADDER.md, rung 1;
// the value: shared/instances.js, docs/guide/INSTANCES.md): one thing drawn many times, in one draw per mesh.
//
// Each of the thing's own meshes gets an InstancedMesh sharing its geometry and its CURRENT material (so an override or
// a shader on the thing dresses every copy, and a shader's `instance` input tells them apart). The copies hang in the
// scene, not under the thing, and follow its world matrix each frame: nothing that walks the thing (its collider, its
// bounds, measure, the material readers) ever meets them. So copies are drawn and nothing else: no collision, no
// picking, no physics. A draft can't change a rule.

import { THREE, scene } from '../core.js';
import { bus } from '../base.js';
import { entities, bagOf } from '../world.js';
import { heightAt } from '../terrain.js';
import { registerDraft } from '../../../shared/drafts.js';
import { INSTANCES, readInstances } from '../../../shared/instances.js';
import { meshes } from './material_draft.js';

registerDraft(INSTANCES, { title: 'Instances', summary: 'draw it many times: copies placed by hand, or scattered by a seed (a draft this client reads)', category: 'Look',
  blank: { scatter: { count: 12, shape: 'ring', radius: 4 } }, applies: (ent) => ent?.model != null || (ent?.mesh && typeof ent.mesh === 'object') });

const drawn = new Map();   // id → {obj, spec, value, parts: [{inst, src, rel}], hid: [mesh], at: Matrix4 (where the ground was read), groundAt}
const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _t = new THREE.Matrix4();

function drop(id) {
  const d = drawn.get(id); if (!d) return;
  for (const { inst } of d.parts) { scene.remove(inst); inst.dispose(); }
  for (const m of d.hid) m.visible = true;
  drawn.delete(id);
}
/** Each copy's matrix on each part: the copy's place in the thing's frame, then the mesh's own place in it. */
function place(d) {
  const { spec, obj } = d; const c = spec.copies;
  if (spec.ground) { obj.updateWorldMatrix(true, false); _inv.copy(obj.matrixWorld).invert(); d.at.copy(obj.matrixWorld); d.groundAt = performance.now(); }
  for (const { inst, rel } of d.parts) {
    for (let i = 0; i < spec.count; i++) {
      const o = i * 8;
      _p.set(c[o], c[o + 1], c[o + 2]);
      if (spec.ground) { _p.applyMatrix4(obj.matrixWorld); _p.y = heightAt(_p.x, _p.z); _p.applyMatrix4(_inv); }   // down (or up) to the ground under it
      _q.set(c[o + 3], c[o + 4], c[o + 5], c[o + 6]); _s.setScalar(c[o + 7]);
      inst.setMatrixAt(i, _t.compose(_p, _q, _s).multiply(rel));
    }
    inst.instanceMatrix.needsUpdate = true; inst.computeBoundingSphere(); inst.computeBoundingBox();
  }
}
function build(id) {
  drop(id);
  const obj = entities.get(id); const value = bagOf(id)?.[INSTANCES];
  if (!obj || obj.userData?.placeholder || value == null) return;
  const spec = readInstances(value, id); if (!spec) return;
  const srcs = meshes(obj).filter((m) => !m.isSkinnedMesh && m.geometry?.attributes?.position);
  if (!srcs.length) return;
  obj.updateWorldMatrix(true, true); _inv.copy(obj.matrixWorld).invert();
  const d = { obj, spec, value, parts: [], hid: [], at: new THREE.Matrix4(), groundAt: 0 };
  for (const src of srcs) {
    const inst = new THREE.InstancedMesh(src.geometry, src.material, spec.count);
    inst.name = 'instances'; inst.matrixAutoUpdate = false; inst.castShadow = src.castShadow; inst.receiveShadow = src.receiveShadow; inst.layers.mask = src.layers.mask;
    // the toolkit's weather sweeps skip it (its material is the thing's, already dressed), and nothing fits a collider to it
    Object.assign(inst.userData, { instancesOf: id, noWet: true, noCloudShadow: true, collision: false, noMaterialOverride: true });
    d.parts.push({ inst, src, rel: new THREE.Matrix4().multiplyMatrices(_inv, src.matrixWorld) });
    scene.add(inst);
    if (!spec.original) { src.visible = false; d.hid.push(src); }
  }
  drawn.set(id, d); place(d); follow(d);
}
const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
function follow(d) {
  const { obj } = d;
  obj.updateWorldMatrix(true, false);
  const vis = shown(obj);
  for (const p of d.parts) {
    if (p.inst.material !== p.src.material) p.inst.material = p.src.material;   // an override or a shader arrived on the thing, or left
    p.inst.matrix.copy(obj.matrixWorld); p.inst.matrixWorld.copy(obj.matrixWorld); p.inst.visible = vis;
  }
  // a thing that moved: its copies stand on the ground where they are now (twice a second while it keeps moving)
  if (d.spec.ground && !d.at.equals(obj.matrixWorld) && performance.now() - d.groundAt > 500) place(d);
}
/** Per frame: the copies follow their thing; one whose thing was replaced or reshaped is rebuilt. */
export function tickInstances() {
  for (const [id, d] of drawn) {
    if (entities.get(id) !== d.obj || d.parts.some((p) => !p.src.parent)) { build(id); continue; }
    follow(d);
  }
}
export function initInstances() {
  bus.on('comp', ({ id, type }) => { if (type === INSTANCES) build(id); else if (drawn.has(id) && bagOf(id)?.[INSTANCES] !== drawn.get(id).value) build(id); });   // …or it was deleted (no event names a deleted type)
  bus.on('entity', ({ id, kind }) => {
    if (kind === 'remove' || kind === 'demote') drop(id);
    else if (kind === 'spawn' || (kind === 'place' && !drawn.has(id))) { if (bagOf(id)?.[INSTANCES] != null) requestAnimationFrame(() => build(id)); }
  });
  bus.on('world-reset', () => { for (const id of [...drawn.keys()]) drop(id); });
  bus.on('ground-changed', () => { for (const d of drawn.values()) if (d.spec.ground) place(d); });
  globalThis.__instancesDraft = { drawn: (id) => { const d = drawn.get(id); return d ? { count: d.spec.count, parts: d.parts.length, ground: d.spec.ground, original: d.spec.original } : null; } };
}
