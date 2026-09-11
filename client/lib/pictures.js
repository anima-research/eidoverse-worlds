// pictures — the browser host for the `picture` component.
//
// Owns the THREE-bound half: loading the image off the library route, finding
// the named part on the owning entity, swapping that part's material for a
// clone carrying the image, and putting the original back when the picture
// comes down. The split mirrors emitters.js:
//
//   shared/picture.js — what a `picture` bag MEANS (shared with the mcpl agent)
//   this file         — hosting
//
// Two rules that are easy to get wrong and are therefore stated:
//
//   1. NEVER mutate the part's material. glTF materials are shared across
//      primitives and across instances of the same model; painting one
//      screen by writing `map` on its material paints every screen in the
//      world. The host clones, textures the clone, and restores the original
//      on removal — the clone is ours to dispose, the original never was.
//   2. NEVER dispose the texture. loadImageTexture caches by bytes and pins
//      the texture for the session (assets.js §16.2.B: `dispose` is a no-op
//      on cached textures); the cache owns it, the picture borrows it. Same
//      ownership rule as emitter sprites.

import { THREE } from './core.js';
import { bus } from './base.js';
import { primeFiles } from './assets.js';
import { entities, findPart } from './world.js';
import { normalizePicture } from '../../shared/picture.js';

// id → { picture, part, original, material } for every picture currently hung
const hung = new Map();
// id → picture whose entity (or part) is not in the scene yet — replay usually
// delivers the comp before the GLB has landed; the bag is folded and look()
// is right the whole time, the texture just waits for something to land on.
const pending = new Map();

async function pictureTexture(picture) {
  await primeFiles([picture.src]);
  const bytes = globalThis.Deno.readFileSync(picture.src);
  // glTF UVs are authored in glTF convention (no vertical flip); the shim's
  // default bakes the browser flip for procedurally-mapped surfaces. A picture
  // on a modelled part wants the glTF convention, so flipY:false — `flip` is
  // the author's escape hatch for a part whose UVs were exported the other
  // way, which the by-eye check tells you in one glance.
  return globalThis.loadImageTexture(bytes, { srgb: true, flipY: picture.flip === true });
}

function takeDown(id) {
  const h = hung.get(id);
  if (!h) return;
  hung.delete(id);
  // The part may have been re-realized (promote/demote) since we hung on it;
  // only restore if our clone is still what it wears.
  if (h.part.material === h.material) h.part.material = h.original;
  h.material.dispose();     // ours; the texture is not (see rule 2)
}

async function hang(id, picture) {
  const root = entities.get(id);
  if (!root) { pending.set(id, picture); return; }
  const part = findPart(root, picture.part);
  if (!part || !part.material) {
    // Legible, once: the comp folds and reads correctly in text tier; there is
    // just no such part on this model to hang it on. `measure {id}` lists them.
    console.warn(`[pictures] ${id}: part "${picture.part}" not found on the model — nothing hung`);
    pending.delete(id);
    return;
  }
  let tex;
  try { tex = await pictureTexture(picture); }
  catch (e) { console.warn(`[pictures] ${id}: ${picture.src} could not be loaded — nothing hung`, e); return; }
  // Replace (same id, new bag): the old clone goes first so `original` is
  // always the model's own material, never a previous picture's clone.
  takeDown(id);
  if (!hung.has(id) && entities.get(id) !== root) return;   // entity re-realized mid-load
  const original = part.material;
  const material = original.clone();
  material.map = tex;
  // A picture's colours are the picture's: an authored base colour would tint
  // it. White base, and for a self-lit picture the image also drives emissive
  // so it reads in the dark the way a screen does.
  if (material.color) material.color.set(0xffffff);
  if (picture.lit === 'self' && 'emissive' in material) {
    material.emissive.set(0xffffff);
    material.emissiveMap = tex;
    material.emissiveIntensity = 1;
  }
  material.needsUpdate = true;
  part.material = material;
  hung.set(id, { picture, part, original, material });
  pending.delete(id);
}

function applyFrom(id, data) {
  if (data == null) { pending.delete(id); takeDown(id); return; }
  const norm = normalizePicture(data);
  if (!norm.ok) {
    console.warn(`[pictures] ${id}: ${norm.why}`);
    pending.delete(id); takeDown(id);
    return;
  }
  if (norm.notes?.length) console.warn(`[pictures] ${id}: ${norm.notes.join(' · ')}`);
  void hang(id, norm.picture);
}

bus.on('comp', ({ id, type, data }) => {
  if (type !== 'picture') return;
  applyFrom(id, data);
});

bus.on('entity', ({ id, kind }) => {
  if (kind === 'remove' || kind === 'demote') {
    // the subtree left the scene with our clone on it; forget the handle
    // (restoring a material on a detached mesh is harmless but pointless),
    // and keep the bag pending so a promote re-hangs it.
    const h = hung.get(id);
    if (h) { hung.delete(id); h.material.dispose(); if (kind === 'demote') pending.set(id, h.picture); }
  } else if (kind === 'spawn') {
    // a promote replaces the subtree: whatever we hung is on the old one
    const h = hung.get(id);
    if (h) { hung.delete(id); h.material.dispose(); pending.set(id, h.picture); }
    if (pending.has(id)) { const p = pending.get(id); pending.delete(id); void hang(id, p); }
  }
});

bus.on('world-reset', () => clearPictures());

export function clearPictures() {
  pending.clear();
  for (const id of [...hung.keys()]) takeDown(id);
}

/** For probes: what is hung where. */
export const _hung = hung;
export const pictureCount = () => hung.size;
export { THREE as _THREE };
