// inspect — the client's half of shared/editschema.js.
//
// WHAT can be edited on a thing, and with which verb, is declared ONCE, as a
// pure function of the folded record (shared/editschema.js) — the desktop
// inspector, the VR quad and a model's `inspect`/`edit` tools all read it.
// This module is the part only a client with a live scene can add:
//
//   commitEdit(id, key, value, {live})
//     live   → PREVIEW: the group's handler moves the realized object (a
//              light brightens, a seat gizmo slides) — no log traffic;
//     final  → COMMIT: editVerbs() turns the edit into the fewest verbs; the
//              inverse (from the record as it was when the gesture began)
//              goes on the undo stack; the verbs go out. Light verbs ride
//              lights.js's coalescer so a drag never outruns the rate limit.
//
//   registerHandler(group, fn(id, obj, k, value, opts) → handled?)
//     evaluator modules install previews and viewport GESTURES here ('+ seat
//     here' arms a click-to-place; a row click selects a gizmo). Returning
//     true means "done, don't commit" — a live preview always is; a final
//     edit usually isn't, and falls through to editVerbs.
//
// The html+wire form (registerEditor) survives for the World›Scene section
// until it retires; that panel also gets the schema groups, rendered by the
// factory, through the same commit path.

import { entities } from './world.js';
import { libBox } from './realize/models.js';
import { state } from './state.js';
import { sendVerb, net } from './net.js';
import { renderDOM } from './panels.js';
import { inspectSchema, editVerbs, fieldAt } from '../../shared/editschema.js';
import { mayAuthor } from './placer.js';
import { namedParts } from './parts.js';
import { qFromYaw } from '../../shared/rot.js';
import { sameRotation } from '../../shared/euler.js';
import { localOf } from '../../shared/hierarchy.js';
import { WORLD_ID, worldSchema, worldEditVerbs } from '../../shared/worldentity.js';
import * as V4 from './v4edit.js';   // protocol/v4 slice 3b: a v4 world's component edits are door requests
const R2D = 180 / Math.PI;

const handlers = new Map();      // group → [fn] — consulted in order; the first to return true handled it
const htmlEditors = [];
let hooks = { undo: null, commitLight: null, casting: null };

export function registerHandler(group, fn) { if (!handlers.has(group)) handlers.set(group, []); handlers.get(group).push(fn); }
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
  return { casting: light ? hooks.casting?.(obj) : undefined, mayAuthor: mayAuthor(id), parts: obj && !light ? namedParts(obj) : undefined,
    euler: eulerHint(id, foldRecord(id)),
    // the hierarchy reads the whole fold: a child's local pose, its parent's
    // socket, the Parent field's children, and the in-place parenting maths
    world: state.st.entities ?? {}, mayAuthorOf: (x) => (state.st.entities?.[x] ? mayAuthor(x) : undefined),
    // the model's own box (the pivot's centre / base snaps)
    box: foldRecord(id)?.lib ? libBox(foldRecord(id).lib) : null,
    // a v4 world: locks are the door's to refuse and the person's to answer (This is locked. Move anyway?)
    ...(V4.isV4() ? { doorLocks: true } : {}) };
}
// The world entity `@world` (design §3, shared/worldentity.js): an alias of
// state.sky/terrain/grass, edited through the sky/weather/terrain/grass verbs.
// Those are owner-rank: false = this viewer is known not to be the owner
// (WORLD_ADMIN operators fold to owner), undefined = not known yet.
export const mayShape = () => { const r = net.myRights?.role; return r === undefined ? undefined : r === 'owner'; };
export const worldLive = () => ({ now: Date.now(), mayShape: mayShape() });
export function schemaFor(id) {
  if (id === WORLD_ID) return worldSchema(state.st, worldLive());
  const rec = foldRecord(id); if (!rec) return { id, groups: [] };
  return inspectSchema(rec, id, liveFor(id));
}

let gesture = null;   // { id, rec } — the record as it stood when a drag began
export function endGesture() { gesture = null; }

/** Inverse of a verb about to be sent, against the record it was computed from. */
export function inverseOf(v, rec, id) {
  switch (v.verb) {
    // a thing with q comes back by its q; a yaw-only thing the edit TILTED comes
    // back by the q of its old yaw — a bare yaw would keep the tilt (PROTOCOL §9.1)
    case 'place': return { verb: 'place', args: { id, pos: [...(rec.pos ?? [0, 0, 0])], yaw: rec.yaw ?? 0,
      ...(rec.q ? { q: [...rec.q] } : v.args.q ? { q: qFromYaw(rec.yaw ?? 0) } : {}), ...(rec.scale != null ? { scale: rec.scale } : {}) } };
    case 'light': {
      const back = { id };
      for (const k of Object.keys(v.args)) if (k !== 'id') back[k] = k === 'day' ? rec.day !== false : k === 'keep' ? rec.keep === true : rec[k];
      return { verb: 'light', args: back };
    }
    case 'motion': return { verb: 'motion', args: rec.comp?.motion ? { id, ...rec.comp.motion } : { id, type: null } };
    // a child's translate/rotate went out as a mount: back to the relation it had
    case 'mount': return rec.parent ? { verb: 'mount', args: { id, ...JSON.parse(JSON.stringify(rec.parent)) } }
      : { verb: 'dismount', args: { id, pos: [...(rec.pos ?? [0, 0, 0])], ...(rec.q ? { q: [...rec.q] } : {}), yaw: rec.yaw ?? 0 } };
    case 'dismount': return rec.parent ? { verb: 'mount', args: { id, ...JSON.parse(JSON.stringify(rec.parent)) } } : null;
    case 'comp': return { verb: 'comp', args: { id, type: v.args.type, data: rec.comp?.[v.args.type] ?? null } };
  }
  return null;
}

/** The verbs and inverses ONE edit would produce, computed but not sent —
 *  multi-selection batches these across ids into one undo step. `base` is
 *  the record the inverse is computed from (a gesture's start, else now). */
export function planEdit(id, key, value, base = null) {
  if (id === WORLD_ID) { const r = worldEditVerbs(state.st, { [key]: value }, worldLive()); return { verbs: r.verbs, inverses: r.inverses, errors: r.errors }; }
  const rec = foldRecord(id);
  if (!rec) return { verbs: [], inverses: [], errors: [`${id} is not in the fold`] };
  const dot = key.indexOf('.');
  const group = key.slice(0, dot), k = key.slice(dot + 1);
  const live = liveFor(id);
  const f = fieldAt(inspectSchema(rec, id, live), key);
  if (f?.deg && typeof value === 'number') value = value * R2D;   // panel steppers speak wire (radians); editVerbs takes the face
  if (group === 'comp' && k !== '+' && value === '') return { verbs: [], inverses: [], errors: [`${k}: empty — use "remove ${k}" to remove it`] };
  const { verbs, errors, euler, asks, inverses: own } = editVerbs(rec, id, { [key]: value }, live);
  // a parent edit brings its own way back (shared/hierarchy.js parentVerbs), in send order
  const inverses = own ?? verbs.map((v) => inverseOf(v, base ?? rec, id)).filter(Boolean);
  return { verbs, inverses, errors, euler, asks };
}
/** Send one planned verb through the right door (lights ride the coalescer). */
export function sendPlanned(v) {
  if (v.verb === 'light' && hooks.commitLight) { const { id: _i, ...patch } = v.args; hooks.commitLight(v.args.id, patch); }
  else sendVerb(v.verb, v.args);
}

export function commitEdit(id, key, value, opts = {}) {
  if (id === WORLD_ID) {   // no live preview: a world field commits on release, one verb, one undo step
    if (opts.live) return { ok: true, live: true };
    const { verbs, inverses, errors } = planEdit(id, key, value);
    if (inverses.length) hooks.undo?.(inverses.length === 1 ? inverses[0] : { verbs: [...inverses].reverse() }, `${key} of the world`);
    verbs.forEach(sendPlanned);
    return { ok: !errors.length, errors, verbs };
  }
  const rec = foldRecord(id);
  const obj = entities.get(id);
  if (!rec) return { ok: false, errors: [`${id} is not in the fold`] };
  const dot = key.indexOf('.');
  const group = key.slice(0, dot), k = key.slice(dot + 1);
  const live = !!opts.live;
  if (live && (!gesture || gesture.id !== id)) gesture = { id, rec: JSON.parse(JSON.stringify(rec)), ...(V4.isV4() ? { v4: V4.compsOf(id) } : {}) };
  for (const h of handlers.get(group) ?? []) {
    try { if (h(id, obj, k, value, opts)) { if (!live) gesture = null; return { ok: true, handled: true }; } } catch (e) { console.warn(`[inspect] ${group} handler`, e); }
  }
  if (live) return { ok: true, live: true };
  const base = gesture?.id === id ? gesture.rec : rec;   // the pose/values before the drag began
  const baseV4 = gesture?.id === id ? gesture.v4 : null;
  gesture = null;
  // planEdit holds the two seam rules: the panel's steppers speak WIRE units
  // (a deg field commits radians) while editVerbs' contract — a model's — is
  // the FACE, converted once here (review B1: amp/phase/socket yaw landed at
  // 1/57th); and a raw-JSON box cleared and blurred must not delete the
  // component — the 'remove <type>' button (null) is the deliberate act (S2).
  const { verbs, inverses, errors, euler, asks } = planEdit(id, key, value, base);
  if (V4.isV4()) {
    // one edit is ONE door request (a batch when it took several verbs): one act, one Ctrl+Z (the door's undo), and it
    // waits for the door; expect names what it changes as this viewer saw it (a scrubbed field: as the scrub began)
    if (verbs.length) V4.sendVerbsV4(verbs, { what: `${key} of ${id}`, base: baseV4 ? { [id]: baseV4 } : null, revert: () => V4.revertPose(id) });
    if (euler) eulerHints.set(id, euler); else if (verbs.some((v) => v.verb === 'place')) eulerHints.delete(id);
    return { ok: !errors.length, errors, verbs, ...(euler ? { euler } : {}), ...(asks?.length ? { asks } : {}) };
  }
  // one edit is one undo step, however many verbs it took (an Add Component
  // that brings its need, a remove-both): the inverses undo in reverse order
  if (inverses.length === 1) hooks.undo?.(inverses[0], `${key} of ${id}`);
  else if (inverses.length > 1) hooks.undo?.({ verbs: [...inverses].reverse() }, `${key} of ${id}`);
  verbs.forEach(sendPlanned);
  if (euler) eulerHints.set(id, euler); else if (verbs.some((v) => v.verb === 'place')) eulerHints.delete(id);
  return { ok: !errors.length, errors, verbs, ...(euler ? { euler } : {}), ...(asks?.length ? { asks } : {}) };
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
