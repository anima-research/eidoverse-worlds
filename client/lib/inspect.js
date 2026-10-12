// inspect — the client's half of shared/editschema.js.
//
// WHAT can be edited on a thing, and what it writes, is declared ONCE, as a
// pure function of the folded record (shared/editschema.js) — the desktop
// inspector, the VR quad and a model's `inspect`/`edit` tools all read it.
// This module is the part only a client with a live scene can add:
//
//   commitEdit(id, key, value, {live})
//     live   → PREVIEW: the group's handler moves the realized object (a
//              light brightens, a seat gizmo slides) — no log traffic;
//     final  → COMMIT: editOps() turns the edit into the fewest door ops, sent as ONE request (shared/protocol/requests.js via
//              editwrites.sendOps): one act, undone by the authority's undo; expect carries the values as the gesture began.
//
//   registerHandler(group, fn(id, obj, k, value, opts) → handled?)
//     evaluator modules install previews and viewport GESTURES here ('+ seat
//     here' arms a click-to-place; a row click selects a gizmo). Returning
//     true means "done, don't commit" — a live preview always is; a final
//     edit usually isn't, and falls through to editOps.
//
// The html+wire form (registerEditor) survives for the World›Scene section
// until it retires; that panel also gets the schema groups, rendered by the
// factory, through the same commit path.

import { materialsOf } from './matoverride.js';
import { isMineMuted, allowUntrusted } from './mediaprefs.js';
import { entities } from './world.js';
import { boxOf, previewMesh } from './realize/models.js';
import { state } from './state.js';
import { net, sendDrag } from './net.js';
import { THREE } from './core.js';
import { renderDOM } from './panels.js';
import { inspectSchema, editOps, fieldAt } from '../../shared/editschema.js';
import { namedParts } from './parts.js';
import { sameRotation } from '../../shared/euler.js';
import { localOf } from '../../shared/hierarchy.js';
import { WORLD_ID, worldSchema, worldEditOps } from '../../shared/worldentity.js';
import * as Edits from './editwrites.js';   // slice 3b: component edits are requests
import { effectLookup } from './emitters.js';
const R2D = 180 / Math.PI;

const handlers = new Map();      // group → [fn] — consulted in order; the first to return true handled it
const htmlEditors = [];
let hooks = { casting: null };

export function registerHandler(group, fn) { if (!handlers.has(group)) handlers.set(group, []); handlers.get(group).push(fn); }
// a mesh card scrub (size x/y/z, shape) shows on the thing before release; the commit goes through editOps as any field's
registerHandler('mesh', (id, _obj, k, value, opts) => {
  if (!opts?.live) return false;
  const cur = { ...(foldRecord(id)?.comp?.mesh ?? {}) }; const n = Number(value);
  if (k === 'shape') cur.shape = String(value); else if (/^size\.[xyz]$/.test(k) && Number.isFinite(n)) { cur.size = [...(Array.isArray(cur.size) ? cur.size : [1, 1, 1])]; cur.size['xyz'.indexOf(k.slice(5))] = n; } else return false;
  return previewMesh(id, cur);
});
export function registerEditor(fn) { htmlEditors.push(fn); }
/** editpanels installs the undo stack and the light coalescer at init —
 *  importing build.js from here would close an import loop through
 *  scenegraph.js. */
export function setEditHooks(h) { hooks = { ...hooks, ...h }; }

/** The folded record for a placed thing — exactly what the schema reads. */
export const foldRecord = (id) => state.st.entities?.[id] ?? null;
// The Rotate channels' hint (shared/euler.js): the Euler triple THIS viewer
// last composed for a thing, so its channels read back exactly as typed
// (the branch past 90°, the inner channel at gimbal lock). Only honoured
// while the folded q is still the one it was composed for — anyone else's
// turn (a gizmo, a peer, an undo) voids it. Client memory, never stored.
const eulerHints = new Map();   // id → { order, e, q }
function eulerHint(id, rec) {
  const h = eulerHints.get(id);
  if (!h) return undefined;
  const order = rec?.comp?.rotOrder ?? 'XYZ';
  // a child's channels read its RELATIVE q (the mount's), so that is the q the hint is for
  const q = rec ? localOf(rec, state.st.entities).q : null;
  // not deleted on a mismatch: the repaint right after a commit reads the fold
  // BEFORE the echo lands, and the hint is for the q that is about to arrive
  return q && h.order === order && sameRotation(h.q, q, 1e-12) ? h.e : undefined;
}
/** What only a live client knows about a thing: the schema AND the commit path read the same. */
export function liveFor(id) {
  const obj = entities.get(id);
  const light = !!obj?.userData?.isLight;
  return { casting: light ? hooks.casting?.(obj) : undefined, parts: obj && !light ? namedParts(obj) : undefined, materials: obj && !light ? materialsOf(obj) : undefined,
    euler: eulerHint(id, foldRecord(id)),
    // the hierarchy reads the whole fold: a child's local pose, its parent's
    // socket, the Parent field's children, and the in-place parenting maths
    world: state.st.entities ?? {},
    // the model's own box (the pivot's centre / base snaps)
    box: boxOf(id),
    // batch 2: this viewer's own choices about a thing's media (mediaprefs.js): never logged
    mutedForMe: isMineMuted(id), untrusted: allowUntrusted(),
    // the stored particle effects this viewer has (emitters.js): an effect's params are the inspector's knobs
    effects: effectLookup,
  };
}
// The world entity `@world` (design §3, shared/worldentity.js): an alias of
// state.sky/terrain/grass, edited through the sky/weather/terrain/grass verbs.
// Those are owner-rank: false = this viewer is known not to be the owner
// (WORLD_ADMIN operators fold to owner), undefined = not known yet.
// shaping the world's look is the editWorld switch (research roles S2); the owner's on an older server
export const mayShape = () => { const r = net.myRights; if (Array.isArray(r?.permissions)) return r.permissions.includes('editWorld'); return r?.role === undefined ? undefined : r.role === 'owner'; };
export const worldLive = () => ({ now: Date.now(), mayShape: mayShape() });
export function schemaFor(id) {
  if (id === WORLD_ID) return worldSchema(state.st, worldLive());
  const rec = foldRecord(id); if (!rec) return { id, groups: [] };
  return inspectSchema(rec, id, liveFor(id));
}

let gesture = null;   // { id, comps } — the thing's components as they stood when a drag began
export function endGesture() { gesture = null; }

/** The authority ops ONE edit would send (shared/editschema.js editOps), computed but not sent — a multi-selection batches
 *  these across ids into one request (one act, one Ctrl+Z: the authority's undo). */
export function planEdit(id, key, value) {
  if (id === WORLD_ID) { const r = worldEditOps(state.st, { [key]: value }, worldLive()); return { ops: r.ops, errors: r.errors }; }
  const rec = foldRecord(id);
  if (!rec) return { ops: [], errors: [`${id} is not in the fold`] };
  const dot = key.indexOf('.');
  const group = key.slice(0, dot), k = key.slice(dot + 1);
  const live = liveFor(id);
  const f = fieldAt(inspectSchema(rec, id, live), key);
  if (f?.deg && typeof value === 'number') value = value * R2D;   // panel steppers speak wire (radians); editOps takes the face
  if (group === 'comp' && k !== '+' && value === '') return { ops: [], errors: [`${k}: empty — use "remove ${k}" to remove it`] };
  const { ops, errors, euler, asks } = editOps(rec, id, { [key]: value }, live);
  return { ops, errors, euler, asks };
}
/** Does this plan write a transform (a move/turn/scale)? The euler hint follows the pose. */
export const movesPose = (ops) => ops.some((o) => (o.verb === 'batch' ? o.args.ops : [o]).some((x) => x.args?.component === 'transform'));

// a scrubbed transform is a live drag for everyone else (E2: the same presence lane the gizmo uses, so co-builders see the
// number move and the claim badge); the release's commit sends the last sample with end
function dragOut(id, obj, end) {
  obj.updateWorldMatrix(true, false);
  const p = obj.getWorldPosition(new THREE.Vector3()), q = obj.getWorldQuaternion(new THREE.Quaternion());
  sendDrag(id, p.toArray(), new THREE.Euler().setFromQuaternion(q, 'YXZ').y, q.toArray(), { end, scale: obj.scale.toArray() });
}
export function commitEdit(id, key, value, opts = {}) {
  if (id === WORLD_ID) {   // no live preview: a world field commits on release, one request, one undo step
    if (opts.live) return { ok: true, live: true };
    const { ops, errors } = planEdit(id, key, value);
    if (ops.length) Edits.sendOps(ops, { what: `${key} of the world`, expect: false });
    return { ok: !errors.length, errors, ops };
  }
  const rec = foldRecord(id);
  const obj = entities.get(id);
  if (!rec) return { ok: false, errors: [`${id} is not in the fold`] };
  const dot = key.indexOf('.');
  const group = key.slice(0, dot), k = key.slice(dot + 1);
  const live = !!opts.live;
  if (live && (!gesture || gesture.id !== id)) gesture = { id, comps: Edits.compsOf(id) };
  for (const h of handlers.get(group) ?? []) {
    try { if (h(id, obj, k, value, opts)) { if (!live) gesture = null; return { ok: true, handled: true }; } } catch (e) { console.warn(`[inspect] ${group} handler`, e); }
  }
  if (group === 'pos' && obj) dragOut(id, obj, !live);   // the channel box previews a transform itself (no handler): still a drag for everyone else
  if (live) return { ok: true, live: true };
  const baseComps = gesture?.id === id ? gesture.comps : null;   // the components before the drag began
  gesture = null;
  // planEdit holds the two seam rules: the panel's steppers speak WIRE units (a deg field commits radians) while
  // editOps' contract — a model's — is the FACE, converted once there (review B1: amp/phase/socket yaw landed at 1/57th);
  // and a raw-JSON box cleared and blurred must not delete the component — 'remove <type>' (null) is the deliberate act.
  const { ops, errors, euler, asks } = planEdit(id, key, value);
  // one edit is ONE request (a batch when it took several ops): one act, one Ctrl+Z, and it waits for the authority;
  // expect names what it changes as this viewer saw it (a scrubbed field: as the scrub began)
  if (ops.length) Edits.sendOps(ops, { what: `${key} of ${id}`, base: baseComps ? { [id]: baseComps } : null, revert: () => Edits.revertPose(id) });
  if (euler) eulerHints.set(id, euler); else if (movesPose(ops)) eulerHints.delete(id);
  return { ok: !errors.length, errors, ops, ...(euler ? { euler } : {}), ...(asks?.length ? { asks } : {}) };
}

/** Several channels of one thing in ONE request (so one undo step): {'pos.x': 0, 'pos.y': 0, …}, FACE values (degrees
 *  for rotate), as editOps takes them. The transform's reset keys use it. */
export function commitMany(id, edits, what) {
  const rec = foldRecord(id); if (!rec) return { ok: false, errors: [`${id} is not in the fold`] };
  const { ops, errors, euler } = editOps(rec, id, edits, liveFor(id));
  if (ops.length) Edits.sendOps(ops, { what: `${what} of ${id}`, revert: () => Edits.revertPose(id) });
  if (euler) eulerHints.set(id, euler); else if (movesPose(ops)) eulerHints.delete(id);
  return { ok: !errors.length, errors, ops };
}

/** Every editor as html+wire for the legacy section: the registered html
 *  editors, then the schema's component groups rendered by the factory. */
export function editorsFor(ctx) {
  const out = [];
  for (const fn of htmlEditors) { try { const e = fn(ctx); if (e) out.push(e); } catch { /* skip it */ } }
  const schema = schemaFor(ctx.id);
  // picture/sound keep their reviewed html blocks here (the registered editors
  // above) until this panel retires; the edit-mode inspector renders the groups
  schema.groups.filter((g) => !['pos', 'flags', 'comp', 'picture', 'sound'].includes(g.group)).forEach((g, i) => {
    const host = `data-fe="${i}"`;
    out.push({
      html: `<div style="margin:4px 0"><b>${ctx.esc?.(g.label ?? g.group) ?? g.group}</b><div ${host}></div></div>`,
      wire(root) {
        const div = root.querySelector(`[${host}]`);
        if (div) renderDOM(div, g.fields, (k, v, _f, o) => { if (k === 'fold') return; commitEdit(ctx.id, `${g.group}.${k}`, v, o); });
      },
    });
  });
  return out;
}
