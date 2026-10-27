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
import { entities, findPart, bags, bagOf } from './world.js';
import { CONFIG } from './base.js';
import { registerEditor, registerHandler, commitEdit } from './inspect.js';
import { namedParts } from './parts.js';
import { toast, flashHint } from './ui.js';
import { normalizePicture, PICTURE_LIT, PICTURE_DESCRIPTION_MAX, PICTURE_STORE, DESCRIPTION_HINT } from '../../shared/picture.js';
import { clientMayFetch } from '../../shared/mediasrc.js';
import { allowUntrusted, RIGHTS_WARNING } from './mediaprefs.js';

// Batch 2 (R 10-07):
//   3. No part = a QUAD of its own (Godot Sprite3D, a Resonite image import): `width` metres wide, its height from the
//      image's aspect, standing on the thing's origin and facing its front (+Z), readable from behind too (a second
//      plane turned π, so the back isn't mirrored). Until the image is decoded, a 1:1 plate at 30% stands in, so the
//      editor's gizmo has something to grab. Cutout transparency (alphaTest 0.5: no sorting, fine in VR). Its world
//      extent is held to 50 m whatever the transform's scale.
//   4. Where the bytes come from (shared/mediasrc.js): a store file always; a trusted host's link always; any other
//      link only if this viewer turned on "allow untrusted links" — otherwise nothing is fetched (a quad shows its empty
//      plate). A link is fetched without credentials or a referrer, and decoded at most 2048 px on its long side.
export const QUAD_MAX_EXTENT = 50;
export const MAX_TEXTURE_PX = 2048;
const blocked = new Map();   // id → why this browser didn't fetch it (probes)
export const _blocked = blocked;
// A link is loaded as an image, not fetched: the page's CSP lets images come from any https host (img-src) but keeps
// connect-src to this server and its known services, so a script can't post what it reads anywhere (server/csp.ts).
// crossOrigin 'anonymous' sends no credentials to another origin and needs its CORS answer (a texture must be clean).
async function linkTexture(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer'; img.decoding = 'async';
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('the image did not load')); img.src = url; });
  const bmp = await createImageBitmap(img);
  const k = Math.min(1, MAX_TEXTURE_PX / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close?.();
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}
function quadOf(picture, aspect, tex) {
  const w = picture.width ?? 1, hgt = w * aspect;
  const g = new THREE.Group(); g.name = 'picture-quad'; g.userData.pictureQuad = true;
  const M = picture.lit === 'self' ? THREE.MeshBasicMaterial : THREE.MeshStandardMaterial;
  const mat = new M(tex ? { map: tex, alphaTest: 0.5, ...(M === THREE.MeshStandardMaterial ? { roughness: 0.9, metalness: 0 } : {}) } : { color: 0x9aa3ad, transparent: true, opacity: 0.3 });
  const geo = new THREE.PlaneGeometry(w, hgt); geo.translate(0, hgt / 2, 0);
  const front = new THREE.Mesh(geo, mat), back = new THREE.Mesh(geo, mat);
  back.rotation.y = Math.PI; front.position.z = 0.001; back.position.z = -0.001;
  g.add(front, back); g.userData.dispose = () => { geo.dispose(); mat.dispose(); };
  return g;
}
function holdExtent(root, g, picture, aspect) {
  const s = root.getWorldScale(new THREE.Vector3()); const big = Math.max(picture.width ?? 1, (picture.width ?? 1) * aspect) * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
  if (big > QUAD_MAX_EXTENT) g.scale.setScalar(QUAD_MAX_EXTENT / big);
}

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

// `quad`: the picture's own plane. A PlaneGeometry's UVs are WebGL's (v up), so a quad wants the browser flip; a modelled
// part's are glTF's (no flip). `flip` inverts either. Decided at decode: a store texture is a shared ImageBitmap (its
// flipY is a no-op after upload), a link's is this picture's own canvas.
async function pictureTexture(picture, quad = false) {
  const flipY = quad ? picture.flip !== true : picture.flip === true;
  if (/^https:/i.test(picture.src)) { const t = await linkTexture(picture.src); t.flipY = flipY; t.needsUpdate = true; return t; }
  await primeFiles([picture.src]);
  const bytes = globalThis.Deno.readFileSync(picture.src);
  // glTF UVs are authored in glTF convention (no vertical flip); the shim's
  // default bakes the browser flip for procedurally-mapped surfaces. A picture
  // on a modelled part wants the glTF convention, so flipY:false — `flip` is
  // the author's escape hatch for a part whose UVs were exported the other
  // way, which the by-eye check tells you in one glance.
  return globalThis.loadImageTexture(bytes, { srgb: true, flipY });
}

function takeDown(id) {
  const h = hung.get(id);
  if (!h) return;
  hung.delete(id);
  if (h.quad) { h.quad.parent?.remove(h.quad); h.quad.userData.dispose?.(); return; }
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
  const mayFetch = clientMayFetch(picture.src, 'image', allowUntrusted());
  if (!mayFetch) blocked.set(id, 'untrusted'); else blocked.delete(id);
  if (!picture.part) {
    // a quad of its own: the plate first (something to grab), the image when (if) it arrives
    takeDown(id);
    const plate = quadOf(picture, 1, null); root.add(plate); holdExtent(root, plate, picture, 1);
    hung.set(id, { picture, quad: plate, root, aspect: null });
    pending.delete(id);
    if (!mayFetch) return;   // an untrusted link without this viewer's opt-in: never fetched
    let tex;
    try { tex = await pictureTexture(picture, true); }
    catch (e) { console.warn(`[pictures] ${id}: ${picture.src} could not be loaded — the plate stays empty`, e); return; }
    if (!current(id, rev) || entities.get(id) !== root || hung.get(id)?.quad !== plate) return;
    const img = tex.image; const aspect = img?.width > 0 ? img.height / img.width : 1;
    takeDown(id);
    const q = quadOf(picture, aspect, tex); root.add(q); holdExtent(root, q, picture, aspect);
    hung.set(id, { picture, quad: q, root, aspect });
    return;
  }
  if (!mayFetch) { pending.delete(id); return; }
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
  reconcileNote(id, data);
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
    if (h) { hung.delete(id); if (h.quad) h.quad.userData.dispose?.(); else h.material.dispose(); if (kind === 'demote') pending.set(id, h.picture); }
    // the editor's status line is about THIS entity; a later spawn under the
    // same id is another one and opens with no line (Mica, #191 round 2)
    if (kind === 'remove') { pending.delete(id); notes.delete(id); }
  } else if (kind === 'spawn') {
    // a promote replaces the subtree: whatever we hung is on the old one,
    // and whatever was loading for the old one is stale — the re-hang below
    // is issued under a fresh revision.
    const rev = bump(id);
    const h = hung.get(id);
    if (h) { hung.delete(id); if (h.quad) h.quad.userData.dispose?.(); else h.material.dispose(); pending.set(id, h.picture); }
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
//
// A line is about ONE state of ONE entity, though, and both can move under
// it (Mica, round 2):
//   · the entity can be removed and a new one spawned under the same id — a
//     different thing that must not open with its predecessor's "taken
//     down". The client's entity lifecycle names that case (`kind: 'remove'`,
//     below); a demote/promote is the SAME entity leaving and re-entering
//     residency, and keeps its line.
//   · the bag can change by someone else's hand. Every line is stamped with
//     the picture it was said ABOUT — for `hang` the bag it committed, for
//     `take down` none, for a refusal or an upload note the bag as it stood —
//     and a picture echo that disagrees with the stamp retires the line: a
//     local status must never read as newer than the world. An echo that
//     AGREES (the hang's own, or a late repeat of it) keeps it, which is the
//     round-1 case and why this is a comparison, not a clear-on-every-echo.
const notes = new Map();   // id → { text, warn, about }   (about = pictureKey of the bag the line describes)

/** The four fields a picture IS, normalized, as one comparable string; `none`
 *  for no picture. Echo data and committed data both go through here so a
 *  server-side default or key order can never read as a change. */
function pictureKey(data) {
  if (data == null) return 'none';
  const n = normalizePicture(data);
  const p = n.ok ? n.picture : data;
  return JSON.stringify([p?.src ?? '', p?.description ?? '', p?.lit ?? 'scene', p?.width ?? 1]);
}

/** A picture echo for `id`: the line stays only if it was about this very bag. */
function reconcileNote(id, data) {
  const n = notes.get(id);
  if (n && n.about !== pictureKey(data)) notes.delete(id);
}

bus.on('world-reset', () => clearPictures());
// the viewer changed what their browser may fetch: every picture is read again under the new rule
bus.on('media:trust', () => { for (const [id, c] of bags()) if (c?.picture) applyFrom(id, c.picture); });

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
// the semantic block (client/lib/inspect.js): a file door that lands the image
// in the store and fills `src`, the description with its bound, and lit. One verb per
// gesture — `hang` commits the whole bag, `take down` commits null — and the
// bag goes through normalizePicture FIRST so a refusal is a hint here, not a
// console warning after the round-trip.
//
// A thing guarded by someone else (comp {type: "guard"}, rights.ts) gets a
// read-only line: the server would refuse the comp, so the block says who may.

const PICTURE_ACCEPT = 'image/png,image/jpeg,image/webp';
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export { namedParts };   // lives in parts.js now: the inspector's `parts` extra reads the same list

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
  if (!obj || meta?.kind === 'light') return null;   // a bulb has no part to texture
  const parts = namedParts(obj);
  if (!parts.length) return null;                     // nothing to hang on — the generic JSON row still exists
  const cur = bag?.picture && typeof bag.picture === 'object' ? bag.picture : null;
  const lit = cur?.lit === 'self' ? 'self' : 'scene';
  return {
    html: `<div data-pe-root style="display:flex;flex-direction:column;gap:4px;margin:4px 0">
      <div><b>🖼 picture</b> <span style="color:var(--dim);font-size:11px">${cur ? 'hung' : 'none hung'}</span></div>
      <label style="display:flex;gap:6px;align-items:center">image
        <input data-pe="src" type="text" placeholder="eidoverse/assets/… or store/images/…" value="${esc(cur?.src ?? '')}" style="flex:1;font-size:11px">
        <input data-pe="file" type="file" accept="${PICTURE_ACCEPT}" style="display:none">
        <button data-pe="pick" title="upload a PNG, JPEG or WebP into the store and use it">upload…</button></label>
      <label style="display:flex;flex-direction:column;gap:2px" title="${esc(DESCRIPTION_HINT)}">description <span style="color:var(--dim);font-size:11px">(what it shows, in words; ≤${PICTURE_DESCRIPTION_MAX})</span>
        <textarea data-pe="description" maxlength="${PICTURE_DESCRIPTION_MAX}" rows="2" style="font-size:11px;font-family:inherit">${esc(cur?.description ?? '')}</textarea></label>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;gap:4px;align-items:center">lit
          <select data-pe="lit">${Object.entries(PICTURE_LIT).map(([k, v]) => `<option value="${k}"${k === lit ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      </div>
      <div style="display:flex;gap:6px">
        <button data-pe="hang">${cur ? 'update' : 'hang'}</button>
        ${cur ? '<button data-pe="down" title="comp {type: \"picture\", data: null}">take down</button>' : ''}
        <span data-pe="msg" style="color:${notes.get(id)?.warn ? 'var(--warn, #e8a33d)' : 'var(--dim)'};font-size:11px">${esc(notes.get(id)?.text ?? '')}</span>
      </div>
    </div>`,
    wire(root) {
      const q = (k) => root.querySelector(`[data-pe="${k}"]`);
      // `about` is the bag this line describes: what a gesture committed, or
      // (omitted) the bag as it stands now. Survives the repaint; the DOM
      // below does not — and is retired by any echo that disagrees with it.
      const msg = (t, warn = false, about = bagOf(id)?.picture ?? null) => {
        notes.set(id, { text: t, warn, about: pictureKey(about) });
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
        // part and flip went with the shape audit (10-16: shared/picture.js keeps src/width/description/lit), so the block offers neither (I59)
        const data = { src: q('src').value.trim(), lit: q('lit').value };
        const said = q('description').value.trim();
        if (said) data.description = said;
        const norm = normalizePicture(data);
        if (!norm.ok) { msg(norm.why, true); return; }   // the rule, here, before any round-trip
        commit('picture', norm.picture);
        msg(norm.notes.length ? norm.notes.join(' · ') : 'hung', false, norm.picture);
        if (norm.notes.length) flashHint(`🖼 ${norm.notes[0]}`);
        ev.target.blur();
      });
      q('down')?.addEventListener('click', (ev) => {
        commit('picture', null);
        msg('taken down', false, null);
        ev.target.blur();
      });
    },
  };
});

// ---- the edit-mode inspector's gestures (the fields themselves are the schema's
// `picture` group, shared/editschema.js). An upload is a GESTURE, not a value:
// pick a file, send it through the store door, then commit the path like any edit.
function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept });
    inp.onchange = () => resolve(inp.files?.[0] ?? null);
    inp.click();
  });
}
async function uploadThenSet(id, key) {
  flashHint(`🖼 ${RIGHTS_WARNING}`, 4000);
  const file = await pickFile(PICTURE_ACCEPT); if (!file) return;
  flashHint(`uploading ${file.name}…`);
  try {
    const path = await uploadPicture(file);
    const r = commitEdit(id, key, path);
    if (r.errors?.length) flashHint(`🖼 ${r.errors.join(' · ')}`, 6000);
    else flashHint(`🖼 hung ${path.split('/').pop()}`, 3000);
  } catch (err) { toast(`picture upload failed — ${err.message}`, 'warn', 8000); }
}
registerHandler('picture', (id, _obj, k, _v, opts) => {
  if (k !== 'upload' || opts?.live) return false;
  uploadThenSet(id, 'picture.src'); return true;
});
registerHandler('comp', (id, _obj, k, _v, opts) => {
  if (k !== 'add:picture' || opts?.live) return false;
  uploadThenFace(id); return true;
});
// Add Component › Picture on a MODEL hangs it on the model's front face, as its own child (facemedia.js; review 10-07
// S4: a picture with no part drew at the origin, inside the crate). On an empty it is that thing's own quad, as before;
// a part is still picked in the card's `where`.
async function uploadThenFace(id) {
  const fm = await import('./facemedia.js');
  if (!fm.frontOf(id)) return uploadThenSet(id, 'picture.src');
  flashHint(`🖼 ${RIGHTS_WARNING}`, 4000);
  const file = await pickFile(PICTURE_ACCEPT); if (!file) return;
  flashHint(`uploading ${file.name}…`);
  try {
    const path = await uploadPicture(file);
    const r = await fm.addOnFace(id, 'picture', { src: path });
    if (r?.ok) flashHint(`🖼 hung ${path.split('/').pop()} on its front`, 3000);
  } catch (err) { toast(`picture upload failed — ${err.message}`, 'warn', 8000); }
}
