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
import { CONFIG } from './base.js';
import { registerEditor } from './inspect.js';
import { toast, flashHint } from './ui.js';
import { guardedByOther, placerName } from './placer.js';   // the server's who-may-author rule, mirrored — and its one name (#190)
import { normalizePicture, PICTURE_LIT, PICTURE_LOOK_MAX, PICTURE_STORE } from '../../shared/picture.js';

// id → { picture, part, original, material } for every picture currently hung
const hung = new Map();
// id → revision of the CURRENT intent for that id. Every change of intent —
// a new bag, a removal, a malformed bag, the entity leaving or being
// re-realized, a world reset — bumps it, and an async hang installs only if
// the revision it was issued under is still the current one. Without this a
// held image load installed after `data: null`, and an older bag's load
// finishing late overwrote a newer one (Mica, #186 review, blocker 1). The
// bag in the fold is the authority; a load is a request to realize it, and a
// request outlives its authority all the time.
const revision = new Map();
const bump = (id) => { const r = (revision.get(id) ?? 0) + 1; revision.set(id, r); return r; };
const current = (id, r) => revision.get(id) === r;
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

async function hang(id, picture, rev) {
  // The bag is pending from the moment it is current until a hang INSTALLS
  // it — including while a load is in flight with the entity present. A
  // demote/promote during that load bumps the load stale, and the promote's
  // spawn must still find the bag to rehang (Mica, #186 round 2): a picture
  // that is still authored never silently stops being shown.
  pending.set(id, picture);
  const root = entities.get(id);
  if (!root) return;
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
  // The load is done; is the intent it served still the intent? Anything
  // that changed it while we waited bumped the revision, and a stale load
  // installs nothing — not on the part, not on a re-realized subtree.
  if (!current(id, rev)) return;
  if (entities.get(id) !== root) return;   // entity re-realized mid-load (belt and braces)
  // Replace (same id, new bag): the old clone goes first so `original` is
  // always the model's own material, never a previous picture's clone.
  takeDown(id);
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
  const rev = bump(id);
  if (data == null) { pending.delete(id); takeDown(id); return; }
  const norm = normalizePicture(data);
  if (!norm.ok) {
    console.warn(`[pictures] ${id}: ${norm.why}`);
    pending.delete(id); takeDown(id);
    return;
  }
  if (norm.notes?.length) console.warn(`[pictures] ${id}: ${norm.notes.join(' · ')}`);
  void hang(id, norm.picture, rev);
}

bus.on('comp', ({ id, type, data }) => {
  if (type !== 'picture') return;
  applyFrom(id, data);
});

bus.on('entity', ({ id, kind }) => {
  if (kind === 'remove' || kind === 'demote') {
    // the subtree left the scene with our clone on it; forget the handle
    // (restoring a material on a detached mesh is harmless but pointless).
    // A load in flight for the departed subtree must not install: bump.
    // DEMOTE keeps the bag pending so the promote re-hangs it (the entity
    // and its comp still exist in the fold); REMOVE clears it — the entity
    // is gone, and a later spawn of the same id starts from its own comps.
    bump(id);
    const h = hung.get(id);
    if (h) { hung.delete(id); h.material.dispose(); if (kind === 'demote') pending.set(id, h.picture); }
    if (kind === 'remove') pending.delete(id);
  } else if (kind === 'spawn') {
    // a promote replaces the subtree: whatever we hung is on the old one,
    // and whatever was loading for the old one is stale — the re-hang below
    // is issued under a fresh revision.
    const rev = bump(id);
    const h = hung.get(id);
    if (h) { hung.delete(id); h.material.dispose(); pending.set(id, h.picture); }
    // Whatever is pending — a bag that never had a part to land on, or one
    // whose load was bumped stale by this very re-realization — is hung
    // again under the fresh revision.
    if (pending.has(id)) void hang(id, pending.get(id), rev);
  }
});

// The block's status line, per entity, kept OUTSIDE the DOM. The scene panel
// rebuilds every editor on the echo of a committed verb (scenegraph.js
// repaint, ~300ms after the comp lands), and a refusal is exactly the case
// with no echo to wait for: the user pressed hang, the block said why not,
// and the previous hang's echo then wiped the line under them (Mica, #191
// round 1). The render reads this back, so a repaint carries the last word.
const notes = new Map();   // id → { text, warn }

bus.on('world-reset', () => clearPictures());

export function clearPictures() {
  pending.clear();
  notes.clear();
  for (const id of revision.keys()) bump(id);   // every load in flight is stale
  for (const id of [...hung.keys()]) takeDown(id);
}

/** For probes: what is hung where, and the intent revision per id. */
export const _hung = hung;
export const _revision = revision;
export const pictureCount = () => hung.size;
export { THREE as _THREE };

// ---- the editor block: how a HUMAN hangs a picture -------------------------
//
// The scene panel's generic layer already edits the comp as raw JSON; this is
// the semantic block (client/lib/inspect.js): the model's named parts as a
// list instead of a guess, a file door that lands the image in the store and
// fills `src`, the look line with its bound, lit and flip. One verb per
// gesture — `hang` commits the whole bag, `take down` commits null — and the
// bag goes through normalizePicture FIRST so a refusal is a hint here, not a
// console warning after the round-trip.
//
// A thing guarded by someone else (comp {type: "guard"}, rights.ts) gets a
// read-only line: the server would refuse the comp, so the block says who may.

const PICTURE_ACCEPT = 'image/png,image/jpeg,image/webp';
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Named mesh parts under `root`, in traversal order — what `part` may name. */
export function namedParts(root) {
  const out = [];
  root?.traverse?.((c) => { if (c !== root && c.isMesh && c.name && c.material && !out.includes(c.name)) out.push(c.name); });
  return out;
}

/** POST an image file through the store door; resolves to the library-relative path. */
export async function uploadPicture(file) {
  const q = new URLSearchParams({ as: 'image', name: file.name });
  if (CONFIG.token) q.set('token', CONFIG.token);
  const r = await fetch(`/upload?${q}`, { method: 'POST', body: file });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const { path } = await r.json();
  if (typeof path !== 'string' || !path.startsWith(PICTURE_STORE)) throw new Error(`upload answered with an unexpected path: ${path}`);
  return path;
}

registerEditor(({ id, obj, meta, bag, commit }) => {
  if (!obj || obj.userData?.isLight) return null;   // a bulb has no part to texture
  const parts = namedParts(obj);
  if (!parts.length) return null;                     // nothing to hang on — the generic JSON row still exists
  const cur = bag?.picture && typeof bag.picture === 'object' ? bag.picture : null;
  // guarded by someone I am not: the server would refuse the comp, so the
  // block says so instead of offering a form. Authorship is the PLACER's —
  // by subject when the door vouched for one, never `meta.actor`, which an
  // owner's partial re-light moves while the placer stays (#190 round 2).
  const heldBy = guardedByOther(id) ? placerName(id) : null;
  if (heldBy) {
    return { html: `<div style="margin:4px 0;color:var(--dim)">🖼 picture — guarded by ${esc(heldBy)}; only they or the world's owner can hang or change one here${cur ? ` (showing ${esc(cur.src?.split('/').pop() ?? '?')})` : ''}</div>`, wire() {} };
  }
  const part = cur?.part && parts.includes(cur.part) ? cur.part : parts[0];
  const lit = cur?.lit === 'self' ? 'self' : 'scene';
  return {
    html: `<div data-pe-root style="display:flex;flex-direction:column;gap:4px;margin:4px 0">
      <div><b>🖼 picture</b> <span style="color:var(--dim);font-size:11px">${cur ? 'hung on ' + esc(cur.part ?? '?') : 'none hung'}</span></div>
      <label style="display:flex;gap:6px;align-items:center">part
        <select data-pe="part" style="flex:1">${parts.map((p) => `<option value="${esc(p)}"${p === part ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      <label style="display:flex;gap:6px;align-items:center">image
        <input data-pe="src" type="text" placeholder="eidoverse/assets/… or store/images/…" value="${esc(cur?.src ?? '')}" style="flex:1;font-size:11px">
        <input data-pe="file" type="file" accept="${PICTURE_ACCEPT}" style="display:none">
        <button data-pe="pick" title="upload a PNG, JPEG or WebP into the store and use it">upload…</button></label>
      <label style="display:flex;flex-direction:column;gap:2px">what it shows <span style="color:var(--dim);font-size:11px">(what text-tier residents read; ≤${PICTURE_LOOK_MAX})</span>
        <textarea data-pe="look" maxlength="${PICTURE_LOOK_MAX}" rows="2" style="font-size:11px;font-family:inherit">${esc(cur?.look ?? '')}</textarea></label>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;gap:4px;align-items:center">lit
          <select data-pe="lit">${Object.entries(PICTURE_LIT).map(([k, v]) => `<option value="${k}"${k === lit ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label style="display:flex;gap:4px;align-items:center;cursor:pointer"><input data-pe="flip" type="checkbox"${cur?.flip ? ' checked' : ''}> flip (UVs upside down)</label>
      </div>
      <div style="display:flex;gap:6px">
        <button data-pe="hang">${cur ? 'update' : 'hang'}</button>
        ${cur ? '<button data-pe="down" title="comp {type: \"picture\", data: null}">take down</button>' : ''}
        <span data-pe="msg" style="color:${notes.get(id)?.warn ? 'var(--warn, #e8a33d)' : 'var(--dim)'};font-size:11px">${esc(notes.get(id)?.text ?? '')}</span>
      </div>
    </div>`,
    wire(root) {
      const q = (k) => root.querySelector(`[data-pe="${k}"]`);
      const msg = (t, warn = false) => {
        notes.set(id, { text: t, warn });   // survives the repaint; the DOM below does not
        const m = q('msg'); if (m) { m.textContent = t; m.style.color = warn ? 'var(--warn, #e8a33d)' : 'var(--dim)'; }
      };
      q('pick')?.addEventListener('click', () => q('file')?.click());
      q('file')?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        msg(`uploading ${file.name}…`);
        try {
          const path = await uploadPicture(file);
          q('src').value = path;
          msg(`in the store as ${path.split('/').pop()} — now hang it`);
        } catch (err) { msg(`upload failed: ${err.message}`, true); toast(`picture upload failed — ${err.message}`, 'warn', 8000); }
        ev.target.value = '';
      });
      q('hang')?.addEventListener('click', (ev) => {
        const data = { src: q('src').value.trim(), part: q('part').value, lit: q('lit').value, flip: !!q('flip').checked };
        const look = q('look').value.trim();
        if (look) data.look = look;
        const norm = normalizePicture(data);
        if (!norm.ok) { msg(norm.why, true); return; }   // the rule, here, before any round-trip
        commit('comp', { id, type: 'picture', data: norm.picture });
        msg(norm.notes.length ? norm.notes.join(' · ') : `hung on ${norm.picture.part}`);
        if (norm.notes.length) flashHint(`🖼 ${esc(norm.notes[0])}`);
        ev.target.blur();
      });
      q('down')?.addEventListener('click', (ev) => {
        commit('comp', { id, type: 'picture', data: null });
        msg('taken down');
        ev.target.blur();
      });
    },
  };
});
