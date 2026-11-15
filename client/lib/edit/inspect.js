// inspect — the client's half of shared/editschema.js. WHAT can be edited on a thing is declared once there, as a pure
// function of the folded record; this module adds what only a live client can:
//
//   commitEdit(id, key, value, {live})
//     live   → PREVIEW: the group's handler moves the realized object; no log traffic;
//     final  → COMMIT: editOps() plans the ops, sent as ONE request (writes.js sendOps): one act, one undo; `expect`
//              carries the values as the gesture began (a world field sends `expect: false`).
//
//   registerHandler(group, fn(id, obj, k, value, opts) → handled?)
//     realize modules install previews and viewport gestures here. Returning true means "done, don't commit": a live
//     preview always is; a final edit usually falls through to editOps.
//
//   registerEditor(fn) / editorsFor(ctx): the html+wire editors the look-mode scene panel (scenegraph.js) still uses.

import { materialsOf } from '../realize/material_draft.js';
import { isMineMuted, allowUntrusted } from '../mediaprefs.js';
import { rotOrderFor, setRotOrder } from './viewprefs.js';
import { entities } from '../world.js';
import { boxOf, previewMesh, previewLight } from '../realize/models.js';
import { state } from '../state.js';
import { net, sendDrag, replica } from '../net.js';
import { serverNow } from '../serverclock.js';   // the sky's and roles' stamps are the authority's
import { trustedOf } from '../../../shared/drafts.js';
import { enc } from '../../../shared/protocol/names.js';
import { THREE } from '../core.js';
import { renderDOM } from './fieldpanels.js';
import { inspectSchema, editOps, fieldAt } from '../../../shared/editschema.js';
import { namedParts } from '../parts.js';
import { sameRotation } from '../../../shared/euler.js';
import { localOf } from '../../../shared/hierarchy.js';
import { lightOf } from '../../../shared/components.js';
import { WORLD_ID, worldSchema, worldEditOps } from '../../../shared/worldentity.js';
import * as Edits from './writes.js';
import { effectLookup } from '../realize/emitters.js';
import { isOwner } from '../../../shared/protocol/roles.js';
const R2D = 180 / Math.PI;

const handlers = new Map();      // group → [fn] — consulted in order; the first to return true handled it
const htmlEditors = [];
let hooks = { casting: null };

export function registerHandler(group, fn) { if (!handlers.has(group)) handlers.set(group, []); handlers.get(group).push(fn); }
// a mesh card scrub (size x/y/z, shape) shows on the thing before release; the commit goes through editOps as any field's
registerHandler('mesh', (id, _obj, k, value, opts) => {
  if (!opts?.live) return false;
  const cur = { ...(recordFor(id)?.mesh ?? {}) }; const n = Number(value);
  if (k === 'shape') cur.shape = String(value); else if (/^size\.[xyz]$/.test(k) && Number.isFinite(n)) { cur.size = [...(Array.isArray(cur.size) ? cur.size : [1, 1, 1])]; cur.size['xyz'.indexOf(k.slice(5))] = n; } else return false;
  return previewMesh(id, cur);
});
// a light card's brightness / range slider shows on the light while dragged; the release commits through editOps
registerHandler('light', (id, _obj, k, value, opts) => {
  if (!opts?.live || (k !== 'intensity' && k !== 'range')) return false; const n = Number(value);
  return Number.isFinite(n) && previewLight(id, { [k]: n });
});
export function registerEditor(fn) { htmlEditors.push(fn); }
/** panels.js installs hooks at init (casting: lightgizmo.js lightCasting); importing it here would close an import loop. */
export function setEditHooks(h) { hooks = { ...hooks, ...h }; }

/** The view record of a placed thing (shared/protocol/view.js viewOf): what the gizmo and the euler hint read. */
export const foldRecord = (id) => state.st.entities?.[id] ?? null;
/** The fold record's components — exactly what shared/editschema.js reads. Never written here. */
export const recordFor = (id) => replica.st?.entities?.[enc(String(id))]?.c ?? null;
// The Rotate channels' hint (shared/euler.js): the Euler triple THIS viewer last composed for a thing, so its channels
// read back as typed (past 90°, at gimbal lock). Honoured only while the folded q is still the one it was composed for.
const eulerHints = new Map();   // id → { order, e, q }
function eulerHint(id, rec) {
  const h = eulerHints.get(id);
  if (!h) return undefined;
  const order = rotOrderFor(id);
  // a child's channels read its RELATIVE q (the mount's), so that is the q the hint is for
  const q = rec ? localOf(rec, state.st.entities).q : null;
  // not deleted on a mismatch: the repaint after a commit reads the fold BEFORE the echo lands
  return q && h.order === order && sameRotation(h.q, q, 1e-12) ? h.e : undefined;
}
/** What only a live client knows about a thing: the schema AND the commit path read the same. */
export function liveFor(id) {
  const obj = entities.get(id); const rec = foldRecord(id);
  const drawn = obj && !obj.userData?.empty;   // an Empty draws nothing: its only mesh may be a light's gizmo
  return { casting: lightOf(rec) ? hooks.casting?.(id) : undefined, parts: drawn ? namedParts(obj) : undefined, materials: drawn ? materialsOf(obj) : undefined,
    euler: eulerHint(id, foldRecord(id)),
    // this viewer's rotate order (viewprefs.js): how the channels read, never sent
    rotOrder: rotOrderFor(id),
    // the hierarchy reads the whole fold: a child's local pose, its parent's socket, the in-place parenting maths
    world: state.st.entities ?? {},
    // the model's own box (the pivot's centre / base snaps)
    box: boxOf(id),
    // this viewer's own choices about a thing's media (mediaprefs.js): never logged
    mutedForMe: isMineMuted(id), untrusted: allowUntrusted(),
    // the stored particle effects this viewer has (emitters.js): an effect's params are the inspector's knobs
    effects: effectLookup,
    // what this world trusts (@world.trusted-components), and whether this viewer may change it (the owner)
    trusted: trustedHere(), mayTrust: mayTrust(),
  };
}
const trustedHere = () => trustedOf(replica.st?.entities?.['@world']?.c);
export const mayTrust = () => (net.myRights?.role === undefined ? undefined : isOwner(net.myRights));
// The world entity `@world` (shared/worldentity.js): state.sky/terrain/grass as one entity, edited through the sky /
// weather / terrain / grass verbs. mayShape: the editWorld permission (the owner's, on an older server); false = known
// not allowed, undefined = rights not known yet.
export const mayShape = () => { const r = net.myRights; if (Array.isArray(r?.permissions)) return r.permissions.includes('editWorld'); return r?.role === undefined ? undefined : isOwner(r); };
export const worldLive = () => ({ now: serverNow(), mayShape: mayShape(), trusted: trustedHere(), mayTrust: mayTrust() });
export function schemaFor(id) {
  if (id === WORLD_ID) return worldSchema(state.st, worldLive());
  const rec = recordFor(id); if (!rec) return { id, groups: [] };
  return inspectSchema(rec, id, liveFor(id));
}

let gesture = null;   // { id, comps } — the thing's components as they stood when a drag began
export function endGesture() { gesture = null; }

/** The authority ops ONE edit would send (shared/editschema.js editOps), computed but not sent — a multi-selection batches
 *  these across ids into one request (one act, one Ctrl+Z: the authority's undo). */
export function planEdit(id, key, value) {
  if (id === WORLD_ID) { const r = worldEditOps(state.st, { [key]: value }, worldLive()); return { ops: r.ops, errors: r.errors }; }
  const rec = recordFor(id);
  if (!rec) return { ops: [], errors: [`${id} is not in the fold`] };
  const dot = key.indexOf('.');
  const group = key.slice(0, dot), k = key.slice(dot + 1);
  const live = liveFor(id);
  const f = fieldAt(inspectSchema(rec, id, live), key);
  if (f?.deg && typeof value === 'number') value = value * R2D;   // panel steppers speak wire (radians); editOps takes the face
  if (group === 'comp' && k !== '+' && value === '') return { ops: [], errors: [`${k}: empty — use "remove ${k}" to remove it`] };
  const { ops, errors, euler, asks, rotOrder } = editOps(rec, id, { [key]: value }, live);
  return { ops, errors, euler, asks, rotOrder };
}
/** Keep a rotate-order pick (a planEdit's rotOrder) as this viewer's: nothing is sent. */
export const keepView = (id, plan) => { if (plan?.rotOrder) setRotOrder(id, plan.rotOrder); };
/** Does this plan write a transform (a move/turn/scale)? The euler hint follows the pose. */
const movesPose = (ops) => ops.some((o) => (o.verb === 'batch' ? o.args.requests : [o]).some((x) => x.args?.component === 'transform'));

// a scrubbed transform is a live drag for everyone else (the presence lane the gizmo uses); the release sends the last
// sample with `end`
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
  const rec = recordFor(id);
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
  const { ops, errors, euler, asks, rotOrder } = planEdit(id, key, value);
  keepView(id, { rotOrder });
  // one edit is ONE request: one act, one Ctrl+Z; expect names what it changes as this viewer saw it (a scrub: as it began)
  const reply = ops.length ? Edits.sendOps(ops, { what: `${key} of ${id}`, base: baseComps ? { [id]: baseComps } : null, revert: () => Edits.revertPose(id) }) : null;
  if (euler) eulerHints.set(id, euler); else if (movesPose(ops)) eulerHints.delete(id);
  return { ok: !errors.length, errors, ops, reply, ...(euler ? { euler } : {}), ...(asks?.length ? { asks } : {}) };   // reply: the authority's answer (a promise)
}

/** Several channels in ONE request (one undo step): {'pos.x': 0, 'pos.y': 0, …}, FACE values (degrees for rotate).
 *  `id` may be an array (a multi-select: each thing from its own record) or WORLD_ID (worldEditOps over every field at
 *  once). The transform's reset keys and a scrubbed run of channels use it. */
export function commitMany(id, edits, what) {
  if (id === WORLD_ID) {
    const { ops, errors } = worldEditOps(state.st, edits, worldLive());
    if (ops.length) Edits.sendOps(ops, { what: `${what} of the world`, expect: false });
    return { ok: !errors.length, errors, ops };
  }
  const ids = Array.isArray(id) ? id : [id];
  const ops = [], errors = [];
  for (const one of ids) {
    const rec = recordFor(one); if (!rec) { errors.push(`${one} is not in the fold`); continue; }
    const r = editOps(rec, one, edits, liveFor(one));
    keepView(one, { rotOrder: r.rotOrder });
    ops.push(...r.ops); errors.push(...r.errors);
    if (r.euler) eulerHints.set(one, r.euler); else if (movesPose(r.ops)) eulerHints.delete(one);
  }
  if (ops.length) Edits.sendOps(ops, { what: `${what} of ${ids.length > 1 ? `${ids.length} things` : ids[0]}`, revert: () => ids.forEach((x) => Edits.revertPose(x)) });
  return { ok: !errors.length, errors, ops };
}

/** Every editor as html+wire for the look-mode scene panel: the registered html editors, then the schema's groups. */
export function editorsFor(ctx) {
  const out = [];
  for (const fn of htmlEditors) { try { const e = fn(ctx); if (e) out.push(e); } catch { /* skip it */ } }
  const schema = schemaFor(ctx.id);
  // picture/sound have html editors above; pos/flags/comp are the build-mode inspector's
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
