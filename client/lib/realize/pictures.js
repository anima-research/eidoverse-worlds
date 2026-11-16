// pictures — the browser host for the `picture` component: a standalone image, a quad of its own (shared/picture.js says
// what a bag means). An image on a named node of a model is the material component's host (material.js).
//
// Never dispose a store file's texture: loadImageTexture (assets.js) caches by bytes and pins the texture for the
// session (`dispose` is a no-op on cached textures); the cache owns it, the picture borrows it. A link's texture is
// decoded here, uncached (linkTexture: userData.owned), and the quad's dispose frees it.

import { THREE } from '../core.js';
import { bus } from '../base.js';
import { primeFiles } from '../assets.js';
import { entities, bags, bagOf } from '../world.js';
import { CONFIG } from '../base.js';
import { registerEditor, registerHandler, commitEdit } from '../edit/inspect.js';
import { namedParts } from '../parts.js';
import { toast, flashHint } from '../ui/ui.js';
import { normalizePicture, PICTURE_LIT, PICTURE_DESCRIPTION_MAX, PICTURE_STORE, DESCRIPTION_HINT } from '../../../shared/picture.js';
import { clientMayFetch } from '../../../shared/mediasrc.js';
import { allowUntrusted, RIGHTS_WARNING } from '../mediaprefs.js';
import { escapeHtml as esc } from '../ui/markup.js';

// The quad: `width` metres wide, its height from the image's aspect, standing on the thing's origin and facing its
// front (+Z), readable from behind too (a second plane turned π, so the back isn't mirrored). Until the image is
// decoded, a 1:1 plate at 30% stands in, so the editor's gizmo has something to grab. Cutout transparency
// (alphaTest 0.5: no sorting, fine in VR). Its world extent is held to 50 m at the scale it is built at (a later
// rescale isn't re-held).
// The bytes (shared/mediasrc.js): a store file always; a trusted host's link always; any other link only if this
// viewer turned on "allow untrusted links", else nothing is fetched (the quad shows its empty plate). A link is
// fetched without a referrer or cross-origin credentials; it decodes at full size, and its texture is drawn at most 2048 px on its long side.
const QUAD_MAX_EXTENT = 50;
const MAX_TEXTURE_PX = 2048;
const blocked = new Map();   // id → why this browser didn't fetch it (probes)
export const _blocked = blocked;
export const _quadOf = (...a) => quadOf(...a);   // picture-note-test: the quad's dispose owns a link's texture
// A link is loaded as an image, not fetched: the page's CSP lets images come from any https host (img-src) but keeps
// connect-src to this server and its known services (server/csp.ts). crossOrigin 'anonymous' sends credentials only to
// this origin and needs the host's CORS answer (a texture must be clean).
async function linkTexture(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer'; img.decoding = 'async';
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('the image did not load')); img.src = url; });
  const bmp = await createImageBitmap(img);
  const k = Math.min(1, MAX_TEXTURE_PX / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close?.();
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.userData.owned = true; return tex;   // ours to free
}
function quadOf(picture, aspect, tex) {
  const w = picture.width ?? 1, hgt = w * aspect;
  const g = new THREE.Group(); g.name = 'picture-quad'; g.userData.pictureQuad = true;
  const M = picture.lit === 'self' ? THREE.MeshBasicMaterial : THREE.MeshStandardMaterial;
  const mat = new M(tex ? { map: tex, alphaTest: 0.5, ...(M === THREE.MeshStandardMaterial ? { roughness: 0.9, metalness: 0 } : {}) } : { color: 0x9aa3ad, transparent: true, opacity: 0.3 });
  const geo = new THREE.PlaneGeometry(w, hgt); geo.translate(0, hgt / 2, 0);
  const front = new THREE.Mesh(geo, mat), back = new THREE.Mesh(geo, mat);
  back.rotation.y = Math.PI; front.position.z = 0.001; back.position.z = -0.001;
  g.add(front, back); g.userData.dispose = () => { geo.dispose(); mat.dispose(); if (tex?.userData?.owned) tex.dispose(); };   // a link's texture is the quad's; a store file's is the cache's
  return g;
}
function holdExtent(root, g, picture, aspect) {
  const s = root.getWorldScale(new THREE.Vector3()); const big = Math.max(picture.width ?? 1, (picture.width ?? 1) * aspect) * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
  if (big > QUAD_MAX_EXTENT) g.scale.setScalar(QUAD_MAX_EXTENT / big);
}

// id → { picture, quad, root, aspect } for every picture currently hung
const hung = new Map();
// id → revision of the current intent for that id. Every change of intent (a new bag, a removal, the entity leaving
// or re-realized, a world reset) bumps it; an async hang installs only if its revision is still current.
const revision = new Map();
const bump = (id) => { const r = (revision.get(id) ?? 0) + 1; revision.set(id, r); return r; };
const current = (id, r) => revision.get(id) === r;
// id → picture whose entity is not in the scene yet (replay usually delivers the comp before the GLB has landed)
const pending = new Map();

/** An image's texture, by the media rule (shared/mediasrc.js): a link decoded here, a library file through the asset
 *  cache. flipY: a PlaneGeometry's UVs are WebGL's (v up: true); a modelled node's are glTF's (false). */
export async function imageTexture(src, flipY) {
  if (/^https:/i.test(src)) { const t = await linkTexture(src); t.flipY = flipY; t.needsUpdate = true; return t; }
  await primeFiles([src]);
  return globalThis.loadImageTexture(globalThis.Deno.readFileSync(src), { srgb: true, flipY });
}

function takeDown(id) {
  const h = hung.get(id);
  if (!h) return;
  hung.delete(id);
  h.quad.parent?.remove(h.quad); h.quad.userData.dispose?.();
}

async function hang(id, picture, rev) {
  // pending from the moment it is current until a hang installs it, so a demote/promote during an in-flight load
  // still finds it to rehang
  pending.set(id, picture);
  const root = entities.get(id);
  if (!root) return;
  const mayFetch = clientMayFetch(picture.src, 'image', allowUntrusted());
  if (!mayFetch) blocked.set(id, 'untrusted'); else blocked.delete(id);
  // the plate first (something to grab), the image when (if) it arrives
  takeDown(id);
  const plate = quadOf(picture, 1, null); root.add(plate); holdExtent(root, plate, picture, 1);
  hung.set(id, { picture, quad: plate, root, aspect: null });
  pending.delete(id);
  if (!mayFetch) return;   // an untrusted link without this viewer's opt-in: never fetched
  let tex;
  try { tex = await imageTexture(picture.src, true); }
  catch (e) { console.warn(`[pictures] ${id}: ${picture.src} could not be loaded — the plate stays empty`, e); return; }
  // a stale load installs nothing: the intent it served moved while it loaded (a new bag, a removal, a re-realize)
  if (!current(id, rev) || entities.get(id) !== root || hung.get(id)?.quad !== plate) { if (tex.userData?.owned) tex.dispose(); return; }
  const img = tex.image; const aspect = img?.width > 0 ? img.height / img.width : 1;   // its height follows the image
  takeDown(id);
  const q = quadOf(picture, aspect, tex); root.add(q); holdExtent(root, q, picture, aspect);
  hung.set(id, { picture, quad: q, root, aspect });
}

function applyFrom(id, data) {
  const rev = bump(id);
  if (data == null) { pending.delete(id); takeDown(id); return; }
  const norm = normalizePicture(data, { clip: true });   // stored: an over-long description is clipped, not torn down
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
    // the subtree left the scene with our quad on it: forget the handle and bump any load in flight. Demote keeps
    // the bag pending so the promote re-hangs it; remove clears it (a later spawn starts from its own comps).
    bump(id);
    const h = hung.get(id);
    if (h) { hung.delete(id); h.quad.userData.dispose?.(); if (kind === 'demote') pending.set(id, h.picture); }
    // the editor's status line is about this entity; a later spawn under the same id opens with no line
    if (kind === 'remove') { pending.delete(id); notes.delete(id); }
  } else if (kind === 'spawn') {
    // a promote replaces the subtree: whatever we hung is on the old one, and whatever was loading for it is stale;
    // the re-hang below runs under a fresh revision
    const rev = bump(id);
    const h = hung.get(id);
    if (h) { hung.delete(id); h.quad.userData.dispose?.(); pending.set(id, h.picture); }
    // whatever is pending (a bag whose entity wasn't here yet, or one bumped stale just above) is hung again
    if (pending.has(id)) void hang(id, pending.get(id), rev);
  }
});

// The block's status line, per entity, kept outside the DOM: the scene panel rebuilds every editor on a committed
// verb's echo, and a refusal has no echo, so the previous hang's echo would wipe the line. A line is about one state
// of one entity: a remove clears it (a demote/promote keeps it), and it is stamped with the picture it was said
// about, so a picture echo that disagrees retires it (a local status must never read as newer than the world).
const notes = new Map();   // id → { text, warn, about }   (about = pictureKey of the bag the line describes)

/** The four fields a picture is, normalized, as one comparable string; `none` for no picture. Echo data and
 *  committed data both go through here so a server-side default or key order never reads as a change. */
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

function clearPictures() {
  pending.clear();
  notes.clear();
  for (const id of revision.keys()) bump(id);   // every load in flight is stale
  for (const id of [...hung.keys()]) takeDown(id);
}

/** For probes: what is hung where. */
export const _hung = hung;

// ---- the editor block: how a human hangs a picture -------------------------
// The scene panel's generic layer already edits the comp as raw JSON; this is the semantic block (edit/inspect.js):
// a file door that lands the image in the store and fills `src`, the description, and lit. One verb per gesture
// (`hang` commits the whole bag, `take down` commits null), and the bag goes through normalizePicture first so a
// refusal is a hint here, not a console warning after the round-trip.

const PICTURE_ACCEPT = 'image/png,image/jpeg,image/webp';

/** POST an image file through the store door; resolves to the library-relative path. */
async function uploadPicture(file) {
  const q = new URLSearchParams({ as: 'image', name: file.name });
  const r = await fetch(`/upload?${q}`, { method: 'POST', body: file, headers: CONFIG.token ? { authorization: `Bearer ${CONFIG.token}` } : {} });   // the key rides a header, never the URL
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const { path } = await r.json();
  if (typeof path !== 'string' || !path.startsWith(PICTURE_STORE)) throw new Error(`upload answered with an unexpected path: ${path}`);
  return path;
}

registerEditor(({ id, obj, bag, commit }) => {
  if (!obj || obj.userData?.empty) return null;   // an Empty draws nothing: no part to texture
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
        <textarea data-pe="description" rows="2" style="font-size:11px;font-family:inherit">${esc(cur?.description ?? '')}</textarea></label>
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
      // `about` is the bag this line describes: what a gesture committed, or (omitted) the bag as it stands now.
      // Survives the repaint; the DOM does not. Retired by any echo that disagrees with it.
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
        // shared/picture.js keeps src/width/description/lit only, so the block offers nothing else
        const data = { src: q('src').value.trim(), lit: q('lit').value, ...(cur?.width !== undefined ? { width: cur.width } : {}) };
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

// ---- the build-mode inspector's gestures (the fields are the schema's `picture` group, shared/editschema.js). An
// upload is a gesture, not a value: pick a file, send it through the store door, then commit the path like any edit.
function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept });
    inp.onchange = () => resolve(inp.files?.[0] ?? null);
    inp.click();
  });
}
/** Pick an image and send it through the store door, with the rights reminder: its library path, or null (cancelled
 *  or failed, said in a toast). Create ▸ Picture's first step (edit/build.js holdPicture). */
export async function pickPicture() {
  flashHint(`🖼 ${RIGHTS_WARNING}`, 4000);
  const file = await pickFile(PICTURE_ACCEPT); if (!file) return null;
  flashHint(`uploading ${file.name}…`);
  try { return await uploadPicture(file); } catch (err) { toast(`picture upload failed — ${err.message}`, 'warn', 8000); return null; }
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
// Add Component › Picture on a MODEL hangs it on the model's front face, as its own child (facemedia.js), not on the
// model's origin inside it. On an empty it is that thing's own quad.
async function uploadThenFace(id) {
  const fm = await import('../facemedia.js');
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
