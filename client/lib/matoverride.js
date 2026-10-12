// matoverride — the reader for the DRAFT component `hesperus/material` (docs/COMPONENT-LADDER.md, rung 1).
//
// R, 10-10: Material as the ladder's first test. Absent, a thing shows its model's own materials. Present, the value
// overrides fields of them: {color?, roughness?, metalness?, emissive?, emissiveStrength?, opacity?} (glTF PBR terms).
// `hesperus/material` applies to every material slot; `hesperus/material:<slot>` to one (the slot is the model's
// material name, slotKey'd). A field absent = the model's own value. A malformed value or field is ignored, never thrown.
// (A `surface` link to physics waits for promotion: a draft can't feed a rule.)
//
// Models share materials across instances, so an override is a per-mesh CLONE, built once and prepared like every
// world material (materials.js prepareMaterial: the node graph's shape is fixed before its first compile); later edits
// are uniform writes. Removing the override puts the model's own material back.

import { THREE } from './core.js';
import { bus } from './base.js';
import { entities, bagOf } from './world.js';
import { prepareMaterial } from './materials.js';
import { registerDraft } from '../../shared/drafts.js';

export const MAT = 'hesperus/material';
// Add Component offers it where this reader applies (every thing with meshes), as a draft or, once trusted here, in the main list
registerDraft(MAT, { title: 'Material', summary: "override its look: colour, roughness, metalness, glow, opacity (a draft this client reads)", category: 'Look', blank: {}, applies: (ent) => ent?.lib != null || (ent?.comp?.mesh && typeof ent.comp.mesh === 'object') });
export const slotKey = (name, i = 0) => {
  const k = String(name ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return /^[a-z]/.test(k) ? k : `slot-${i}${k ? `-${k}` : ''}`.slice(0, 48);
};
const U = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const HEX = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffff;
/** The fields of a value that a reader may use (anything else is ignored). */
export function readMaterial(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = {};
  if (HEX(v.color)) o.color = v.color;
  if (U(v.roughness)) o.roughness = v.roughness;
  if (U(v.metalness)) o.metalness = v.metalness;
  if (HEX(v.emissive)) o.emissive = v.emissive;
  if (typeof v.emissiveStrength === 'number' && v.emissiveStrength >= 0 && v.emissiveStrength <= 20) o.emissiveStrength = v.emissiveStrength;
  if (U(v.opacity)) o.opacity = v.opacity;
  return Object.keys(o).length ? o : null;
}

// its own meshes only: a child THING (parented, or settled onto it) is its own entity with its own materials
function meshes(obj) {
  const out = []; const id = obj?.userData?.entityId;
  const walk = (o) => { if (o !== obj && o.userData?.entityId && o.userData.entityId !== id) return;
    if (o.isMesh && o.material && !o.userData?.noMaterialOverride && !o.isInstancedMesh) out.push(o);
    for (const k of o.children ?? []) walk(k); };
  if (obj) walk(obj);
  return out;
}
const origOf = (mesh) => (mesh.userData.__matOrig ??= Array.isArray(mesh.material) ? mesh.material.slice() : [mesh.material]);

// one slot name per distinct original material, in first-seen order; two with one name are numbered (the card and the
// reader both use this, so a key always means the same slot)
function slotsOf(obj) {
  const slot = new Map(); const used = new Map();
  for (const m of meshes(obj)) origOf(m).forEach((mat) => {
    if (!mat || slot.has(mat)) return;
    const base = slotKey(mat.name, slot.size); const c = (used.get(base) ?? 0) + 1; used.set(base, c);
    slot.set(mat, c > 1 ? `${base}-${c}`.slice(0, 48) : base);
  });
  return slot;
}
/** The model's OWN materials (never the overrides), one per slot: for the Inspector's read-only Material card. */
export function materialsOf(obj) {
  return [...slotsOf(obj)].map(([mat, slot], i) => ({ slot, name: mat.name || `material ${i + 1}`,
    color: mat.color?.getHex?.() ?? null, roughness: typeof mat.roughness === 'number' ? +mat.roughness.toFixed(3) : null,
    metalness: typeof mat.metalness === 'number' ? +mat.metalness.toFixed(3) : null, opacity: typeof mat.opacity === 'number' ? +mat.opacity.toFixed(3) : null,
    emissive: mat.emissive?.getHex?.() ?? null }));
}

function overrideFor(bag, slot) {
  const all = readMaterial(bag?.[MAT]); const one = slot ? readMaterial(bag?.[`${MAT}:${slot}`]) : null;
  return all || one ? { ...(all ?? {}), ...(one ?? {}) } : null;
}
function write(clone, orig, o) {
  if (clone.color && orig.color) clone.color.setHex(o.color ?? orig.color.getHex());
  if ('roughness' in clone) clone.roughness = o.roughness ?? orig.roughness;
  if ('metalness' in clone) clone.metalness = o.metalness ?? orig.metalness;
  if (clone.emissive && orig.emissive) clone.emissive.setHex(o.emissive ?? orig.emissive.getHex());
  if ('emissiveIntensity' in clone) clone.emissiveIntensity = o.emissiveStrength ?? orig.emissiveIntensity ?? 1;
  const op = o.opacity ?? orig.opacity; clone.opacity = op; clone.transparent = orig.transparent || op < 1;
}

/** Make a thing's meshes show its override (or their own materials again). Returns how many slots carry one. */
export function applyMaterials(id) {
  const obj = entities.get(id); if (!obj) return 0;
  const bag = bagOf(id); let n = 0; const slots = slotsOf(obj);
  for (const mesh of meshes(obj)) {
    const orig = origOf(mesh); const clones = (mesh.userData.__matClones ??= []);
    const next = orig.map((mat, i) => {
      const o = mat ? overrideFor(bag, slots.get(mat)) : null;
      if (!o) return mat;
      n++;
      let c = clones[i];
      if (!c || c.__from !== mat) { c = mat.clone(); c.__from = mat; c.name = mat.name; prepareMaterial(c, mesh); clones[i] = c; }
      write(c, mat, o); return c;
    });
    mesh.material = Array.isArray(mesh.material) || next.length > 1 ? next : next[0];
  }
  return n;
}

export function initMaterialOverrides() {
  bus.on('comp', ({ id, type }) => { if (type === MAT || String(type).startsWith(`${MAT}:`)) applyMaterials(id); });
  // a model that arrives (or is swapped in by residency) after its component: the bag is re-announced, but be sure
  bus.on('entity', ({ id, kind }) => { if (kind === 'spawn' || kind === 'place') { const bag = bagOf(id); if (bag && Object.keys(bag).some((k) => k === MAT || k.startsWith(`${MAT}:`))) requestAnimationFrame(() => applyMaterials(id)); } });
  // a deleted override: the bag no longer has it, and nothing announces a deleted type by name everywhere; re-read on any comp change of a thing that had one
  bus.on('comp', ({ id }) => { const obj = entities.get(id); if (obj && meshes(obj).some((m) => m.userData.__matClones?.some(Boolean))) applyMaterials(id); });
  globalThis.__matoverride = { applyMaterials, materialsOf: (id) => materialsOf(entities.get(id)) };
}
