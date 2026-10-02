// editpanels — the hierarchy and the inspector as FIELDS (panels.js), so one
// declaration is a desktop frame and a VR quad. Every action here is a verb
// scenegraph.js already speaks; this file only decides what the rows are.
//
// P1 of notes/proposals/2026-09-04-edit-mode-spec.md, at parity with the
// World›Scene section it retires: transform, lock, every registered component
// editor (inspect.js), raw JSON for the rest, add/remove component, find /
// attach / detach / remove, script badges and a Behaviors group.
//
// The inspector is two lanes, Maya's shape:
//   CHANNELS  every numeric value on the selection in one dense column —
//             pos/yaw/scale plus every `num` a component editor declares.
//             Drag to scrub, click to type, `+=` `*=` math. The fast lane.
//   GROUPS    the full editors: colours, toggles, lists, and the same
//             numbers again next to their meaning. The complete lane.
// A number a motion comp drives shows its REST pose, tinted: `place` moves
// the base the motion composes onto, which is the honest thing to edit.

import { THREE, scene } from './core.js';
import { bus, CONFIG } from './base.js';
import { entities, entityMeta, comps, avatarMounts } from './world.js';
import { sendVerb, requestDebug } from './net.js';
import { flashHint } from './ui.js';
import { makeSchemaFrame, resolveDelta } from './panels.js';
import { registerXRPanel } from './xrpanels.js';
import { treeData, sceneSelected, sceneSelect } from './scenegraph.js';
import { state, onWorldChange } from './state.js';
import { treeRows, kindHint, ancestors } from '../../shared/hierarchy.js';
import { pushUndo, refreshOutline, setRemoveHook, holdGhost, getTool as transformTool, setTool as setTransformTool, deselectAll } from './build.js';
import { armSeatPlacement, seatArmed, cancelSeatArm } from './seatedit.js';
import { defsRegistry } from './defs.js';
import { WORLD_ID, describeWorld, worldPick, worldChoice } from '../../shared/worldentity.js';
import { WEATHERS } from '../../shared/forecast.js';
import { structureTools, currentTool as structureTool, setTool as setStructureTool, undo as structureUndo, undoDepth, newBuilding } from './structure_ui.js';
import { starterModels } from './palette.js';
import { spawnAhead } from './worldquad.js';
import { libLabels } from './assets.js';
import { schemaFor, commitEdit, planEdit, sendPlanned, setEditHooks, endGesture, foldRecord, mayShape } from './inspect.js';
import { channels, fieldAt } from '../../shared/editschema.js';
import { commitLight, lightCasting } from './lights.js';
import { myState } from './controller.js';
import { placerOf, guardedByOther, placerName } from './placer.js';
import { reindexCollider } from './colliders.js';

const _wp = new THREE.Vector3();
const short = (meta) => (meta?.lib ?? meta?.kind ?? '?').split('/').pop().replace('.glb', '').split('_').slice(0, 3).join(' ');
const round = (v, dp = 3) => +(+v).toFixed(dp);

// collapsed groups remembered per LIB (a chair's Components stays open for
// every chair) — Godot folds per object; per lib is the eidoverse shape
const FOLD_LS = 'ew-insp-fold';
let folds = {};
try { folds = JSON.parse(localStorage.getItem(FOLD_LS) || '{}'); } catch { /* fresh */ }
const foldKey = (id) => (id === WORLD_ID ? WORLD_ID : `${entityMeta.get(id)?.lib ?? '?'}`);
const isOpen = (id, g) => !(folds[foldKey(id)]?.[g]);
function toggleFold(id, g) {
  const k = foldKey(id); folds[k] ??= {}; folds[k][g] = !folds[k][g];
  try { localStorage.setItem(FOLD_LS, JSON.stringify(folds)); } catch { /* fine */ }
}
let arming = null;   // the child id waiting for a row click to name its parent
// a ref field waiting for a target: { id, key } — the entity being edited and
// the schema key (e.g. 'look.target'). The next thing picked (a tree row or the
// thing in the world) commits that id into the field. Reuses attach's pick path.
let armingRef = null;
// a need waiting on the viewer (design §3, shared/editschema.js): { id, ask } —
// a choice for an Add Component, or a remove-both for a Remove. Shown as a
// prompt at the top of the cards; answering re-commits the same address.
let pendingAsk = null;
let filter = '';     // the hierarchy's filter text: non-matches hide, ancestors of a match stay (dimmed)
// ids whose children are folded — this viewer's, per world, never on the wire
// (design §5: folding is a view, not the world). A selection unfolds its
// ancestors so the selected row is always on screen.
const HFOLD_LS = () => `ew-hier-fold:${CONFIG.world ?? ''}`;
const collapsed = new Set((() => { try { const v = JSON.parse(localStorage.getItem(HFOLD_LS()) || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } })());
function saveFolds() { try { localStorage.setItem(HFOLD_LS(), JSON.stringify([...collapsed])); } catch { /* a private window: folds last the session */ } }
/** Unfold every ancestor of `id` (a selection reveals itself). */
function revealPath(id) {
  let changed = false;
  for (const a of ancestors(state.st.entities ?? {}, id)) if (collapsed.delete(a)) changed = true;
  if (changed) saveFolds();
  return changed;
}
let visibleRows = [];          // the rows as last painted, for ↑/↓

// ---------------------------------------------------------------- the world entity
// `@world` (design §3, shared/worldentity.js) is not in `entities` — it is the
// fold's sky / terrain / grass read as one entity — so it has no outline and no
// scenegraph selection. Selecting it clears the thing selection and shows its
// components in the Inspector; selecting any thing clears it again.
let worldSel = false;
function selectWorld() {
  arming = null; armingRef = null;
  if (sceneSelected()) deselectAll();   // sg:selected(null) — which leaves worldSel alone
  clearExtras();
  worldSel = true;
  repaintAll();
}
// the palettes the World tiles offer — defs (defs/sky/_presets.json, defs/ground/_palette.json),
// authoring conveniences only: a pick writes concrete verb args, never a preset's name
let skyPresets = null, groundPal = null;
function loadWorldDefs() {
  defsRegistry().then((reg) => { skyPresets = reg.skyPresets ?? null; groundPal = reg.groundPalette ?? null; repaintAll(); }).catch(() => { /* the tiles say the palette is missing */ });
}
const worldRowFields = () => ({ t: 'list', k: 'wsel', rows: [{ id: WORLD_ID, label: 'World  (@world)', sub: describeWorld(state.st, Date.now(), { presets: skyPresets, clock: false }), active: worldSel }] });

// ---------------------------------------------------------------- multi-selection
// The PRIMARY selection stays exactly what build.js/scenegraph own (one id,
// the outline, every existing path). A Shift/Ctrl-click in the tree or a
// Ctrl-click in the viewport EXTENDS it with more ids, held here. The
// inspector then shows the channels every selected thing has (Godot's
// MultiNodeEdit intersects), typing writes the value to each, and the undo
// is one compound step. A plain click anywhere collapses back to one.
const extra = new Set();
let extending = false;         // true while an extend re-primaries: the sg:selected it emits must not clear the set
const outlines = new Map();    // id → BoxHelper for the extras (the primary keeps build.js's outline)
/** Find a painted field by its dispatch key (`ed:look.target`, `ch:pos.x`). */
function fieldByKey(fields, action) { return (fields ?? []).find((f) => f.k === action); }
/** Complete an armed ref pick: commit the target id into the waiting field.
 *  Returns true if a pick was pending and consumed. */
function completeRefPick(targetId) {
  if (!armingRef || !targetId || String(targetId).startsWith('rider:')) return false;
  const { id, key } = armingRef; armingRef = null;
  const what = key === 'parent.to' ? 'parent' : key.split('.').pop();
  if (targetId === id) { flashHint(key === 'parent.to' ? 'a thing can\'t be its own parent' : 'a thing can\'t reference itself', 3000); repaintAll(); return true; }
  const r = commitEdit(id, key, targetId);
  if (r.errors?.length) flashHint(r.errors.join(' · '), 5000);
  else flashHint(`${what} → <b>${targetId}</b>`, 3000);
  repaintAll();
  return true;
}
/** Every selected id, primary first, live things only. */
export function selection() {
  const p = sceneSelected();
  const ids = p && entities.get(p) ? [p] : [];
  for (const id of extra) if (id !== p && entities.get(id)) ids.push(id);
  return ids;
}
function extendSelection(id) {
  if (!entities.get(id)) return;
  const p = sceneSelected();
  if (!p) { sceneSelect(id); return; }
  if (id === p) {                       // un-primary: promote the next extra, or clear
    const next = [...extra][0];
    if (next) { extra.delete(next); extending = true; sceneSelect(next); extending = false; }
    else return;
  } else if (extra.has(id)) extra.delete(id);
  else extra.add(id);
  syncOutlines(); repaintAll();
}
function clearExtras() { if (!extra.size) return; extra.clear(); syncOutlines(); }
function syncOutlines() {
  for (const [id, h] of outlines) if (!extra.has(id) || !entities.get(id)) { scene.remove(h); h.dispose?.(); outlines.delete(id); }
  for (const id of extra) {
    const obj = entities.get(id); if (!obj) continue;
    let h = outlines.get(id);
    if (!h) { h = new THREE.BoxHelper(obj, 0x8fe8c8); h.material.transparent = true; h.material.opacity = 0.55; scene.add(h); outlines.set(id, h); }
    else h.setFromObject(obj);
  }
}

// ---------------------------------------------------------------- scripts roster
// the behavior runtime, for 📜 badges in the tree and the Behaviors group —
// the same world_debug an agent reads, polled while the panels are up
let behaviors = [];
let shown = false;
let rosterTimer = 0;
async function refreshBehaviors() {
  try {
    const r = await requestDebug({ behaviors: true });
    behaviors = (r?.events ?? []).filter((e) => e.kind === 'behavior');
    repaintAll();
  } catch { /* the roster is a refinement, never a gate */ }
}

function badgesFor(id) {
  const out = [];
  const bag = comps.get(id) ?? {};
  for (const [type, data] of Object.entries(bag)) {
    if (type === 'lock' || type === 'hidden' || type === 'label') continue;   // lock has its glyph, label IS the row's name, hidden is added once below
    if (type === 'guard') { out.push('🛡'); continue; }
    if (type === 'motion' || type.startsWith('motion:')) out.push(`${type}(${data?.type ?? '…'})`);
    else if (type === 'sockets' || type === 'reactions') out.push(`${type}(${Object.keys(data ?? {}).join(',')})`);
    else out.push(type);
  }
  for (const b of behaviors) if (b.attach === id) out.push(`📜${b.id}`);
  return out;
}

// ---------------------------------------------------------------- hierarchy
function hierarchyFields() {
  // the tree is the FOLD's (shared/hierarchy.js): a child whose model is still
  // loading sits under its parent, not at the root; seated people ride as rows
  const { riders } = treeData();
  const world = state.st.entities ?? {};
  const sel = sceneSelected();
  const q = filter.trim().toLowerCase();
  const labelOf = (id) => { const l = comps.get(id)?.label ?? world[id]?.comp?.label; return typeof l === 'string' && l ? `${l}  (${id})` : id; };
  const matches = q ? (id) => [id, world[id]?.comp?.label ?? '', world[id]?.lib ?? '', kindHint(world[id]), ...Object.keys(world[id]?.comp ?? {})].join(' ').toLowerCase().includes(q) : null;
  const ridersOf = (id) => (riders.get(id) ?? []).map((r) => ({ id: `rider:${r}`, match: !q || r.toLowerCase().includes(q) }));
  const rows = treeRows(world, { collapsed, matches, extra: ridersOf }).map((t) => {
    if (t.extra) return { id: t.id, label: `🧍 ${t.id.slice(6)}`, depth: t.depth, noDrag: true };
    const id = t.id; const bag = comps.get(id) ?? world[id]?.comp ?? {};
    const badges = badgesFor(id);
    if (!entities.get(id)) badges.unshift('loading…');
    if (bag.hidden === true) badges.push('hidden');
    return { id, label: labelOf(id), sub: kindHint(world[id]), depth: t.depth, active: id === sel, multi: extra.has(id) && id !== sel, badges, locked: !!bag.lock,
      kids: t.kids, open: t.open, ...(t.dim ? { dim: true } : {}) };   // a filter looks inside folded nodes, so the glyph says open
  });
  for (const r of rows) {
    if (String(r.id).startsWith('rider:')) continue;
    const mounted = !!world[r.id]?.parent;
    const lab = comps.get(r.id)?.label;
    r.rename = typeof lab === 'string' ? lab : '';   // the label comp; empty = the row shows its id
    r.menu = [
      { k: 'rename', label: 'rename  (F2)' },
      { k: 'find', label: 'find  (F)' },
      { k: 'duplicate', label: 'duplicate  (Alt+D)' },
      { k: 'attach', label: arming === r.id ? 'cancel parent pick' : 'parent to…' },
      ...(mounted ? [{ k: 'detach', label: 'unparent' }] : []),
      { k: 'lock', label: r.locked ? 'unlock' : 'lock in place' },
      { k: 'hide', label: comps.get(r.id)?.hidden === true ? 'show' : 'hide' },
      { k: 'remove', label: 'remove  (X)', danger: true },
    ];
  }
  visibleRows = rows.filter((r) => !String(r.id).startsWith('rider:')).map((r) => r.id);
  return [
    worldRowFields(),   // pinned: the world entity, always first, never filtered out (design §3)
    { t: 'text', k: 'filter', label: '', value: filter, placeholder: 'filter — id, label, lib, component ⏎', hint: 'non-matches hide; a match keeps its ancestors' },
    { t: 'tree', k: 'sel', rows, rootDrop: 'drop here: no parent', empty: q ? `nothing matches "${filter}"` : 'nothing placed yet — press B in the world to place things' },
  ];
}
function hierarchyDispatch(action, payload, _field, opts = {}) {
  let sel = sceneSelected();
  switch (action) {
    case 'wsel': {   // the pinned World row
      if (arming || armingRef) { arming = null; armingRef = null; flashHint('the world is not a thing to point at — pick a thing; a drop on the root strip unparents', 4000); break; }
      selectWorld();
      return;
    }
    case 'sel': {
      if (String(payload).startsWith('rider:')) return;
      if (armingRef && completeRefPick(payload)) break;   // a row click names a ref target
      if (arming && payload !== arming) { const child = arming; arming = null; reparent(child, payload); sceneSelect(child); break; }
      if (opts.extend) { extendSelection(payload); return; }
      sceneSelect(payload);
      break;
    }
    case 'lock': toggleLock(payload); break;
    case 'rename': {   // an empty name clears the label: the row shows its id again
      const r = commitEdit(payload, 'flags.label', opts?.value ?? '');
      if (r.errors?.length) flashHint(r.errors.join(' · '), 5000);
      break;
    }
    // menu items act on the row they were opened on: select it first
    case 'find': if (payload && payload !== sel) sceneSelect(payload); findSelected(); break;
    case 'attach': {
      if (arming === payload) { arming = null; flashHint('attach cancelled', 3000); break; }
      arming = payload ?? sel;
      if (arming) { sceneSelect(arming); flashHint(`now click <b>${arming}</b>'s new parent — a row here, or the thing itself in the world`, 5000); }
      break;
    }
    case 'detach': reparent(payload ?? sel, null); break;
    case 'remove': { const ids = payload && !extra.has(payload) && payload !== sel ? [payload] : selection(); if (ids.length) removeMany(ids); break; }
    case 'drop': reparent(payload?.id, payload?.onto); break;
    case 'filter': filter = String(payload ?? ''); break;
    case 'open': if (collapsed.has(payload)) collapsed.delete(payload); else collapsed.add(payload); saveFolds(); break;
    case 'hide': { const id = payload ?? sel; if (id) commitEdit(id, 'flags.hidden', comps.get(id)?.hidden !== true); break; }
    case 'duplicate': duplicate(payload ?? sel); break;
    case 'step': {   // ↑/↓ through the rows as painted
      const i = visibleRows.indexOf(sel);
      const next = visibleRows[Math.max(0, Math.min(visibleRows.length - 1, (i < 0 ? 0 : i) + payload))];
      if (next && next !== sel) sceneSelect(next);
      break;
    }
  }
  repaintAll();
}

/** Drag-reparent: `id` onto `onto` (null = make it a root), where it stands.
 *  The same edit as the inspector's Parent field (`parent.to`, shared/
 *  hierarchy.js parentVerbs through the shared commit path): the child keeps
 *  its world pose, a cycle / lock / guard is refused before anything is sent
 *  and the reason shown the way the inspector shows refusals, and the drag is
 *  ONE undo step however many verbs it took (a mount, plus a place when a
 *  scaled parent means the child's own scale must change to keep its size). */
function reparent(id, onto) {
  if (!id || !foldRecord(id)) return;
  if (onto === id) return;
  const r = commitEdit(id, 'parent.to', onto ?? null);
  if (r.errors?.length) { flashHint(r.errors.join(' · '), 5000); return r; }
  if (onto && collapsed.delete(onto)) saveFolds();   // show where it went
  return r;
}

/** A copy of a thing: same lib/pose (nudged so it is not on top of the
 *  original), same components, same carrier — composed on the client from
 *  ordinary verbs, ONE undo entry (remove the copy). Lights copy through
 *  `light`. Locks are not copied: a copy is a fresh thing to place. */
function duplicate(id) {
  const rec = foldRecord(id); const obj = entities.get(id);
  if (!rec || !obj) return;
  const nid = `${id}~${Math.random().toString(16).slice(2, 6)}`;   // never strip anything from the id: 'lamp-2024' is a name, not a suffix
  const pos = [...(rec.pos ?? [0, 0, 0])]; pos[0] = round(pos[0] + 0.5); pos[2] = round(pos[2] + 0.5);
  if (rec.kind === 'light') sendVerb('light', { id: nid, pos, color: rec.color, intensity: rec.intensity, range: rec.range, ...(rec.keep ? { keep: true } : {}), ...(rec.day === false ? { day: false } : {}) });
  else sendVerb('spawn', { id: nid, lib: rec.lib, pos, yaw: rec.yaw ?? 0, ...(rec.scale != null ? { scale: rec.scale } : {}), ...(rec.collide ? { collide: rec.collide } : {}) });
  for (const [type, data] of Object.entries(rec.comp ?? {})) if (type !== 'lock') sendVerb('comp', { id: nid, type, data });
  if (rec.parent) sendVerb('mount', { id: nid, to: rec.parent.to, ...(rec.parent.slot ? { slot: rec.parent.slot } : {}), ...(rec.parent.offset ? { offset: rec.parent.offset.map((v, i) => (i === 0 || i === 2 ? v + 0.5 : v)) } : {}), ...(rec.parent.yaw != null ? { yaw: rec.parent.yaw } : {}) });
  pushUndo({ verb: 'remove', args: { id: nid } }, `duplicating ${id}`);
  flashHint(`<b>${nid}</b> — a copy of ${id}`, 4000);
  setTimeout(() => { if (entities.has(nid)) sceneSelect(nid); }, 400);   // select it once the fold echoes
}

function toggleLock(id) {
  const locked = !!comps.get(id)?.lock;
  sendVerb('comp', { id, type: 'lock', data: locked ? null : true });
  pushUndo({ verb: 'comp', args: { id, type: 'lock', data: locked ? true : null } }, locked ? `unlocking ${id}` : `locking ${id}`);
}
function findSelected() {
  const sel = sceneSelected(); const obj = entities.get(sel); if (!obj) return;
  const p = obj.getWorldPosition(_wp);
  flashHint(`<b>${sel}</b> is ${p.distanceTo(myState.pos).toFixed(0)}m away at (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`, 5000);
}

// ---------------------------------------------------------------- inspector
let painted = [];      // the inspector's last field list (a canvas stepper's delta resolves against it)
let gesture = null;    // { before } while a transform drag is in flight (the local preview's start pose)

/** Is a whole-entity motion composing onto this thing's rest pose? */
function drivenBy(id, obj) {
  if (obj?.userData?.mountedTo) return null;
  const m = comps.get(id)?.motion;
  return m?.type && !m.part ? 'motion' : null;
}
/** The pose `place` edits — the FOLD's, which is the rest pose by definition. */
function restPose(id, obj) {
  const rec = foldRecord(id);
  return rec
    ? { pos: (rec.pos ?? [0, 0, 0]).map((v) => round(v)), yaw: round(rec.yaw ?? 0, 4), scale: round(rec.scale ?? 1) }
    : { pos: [round(obj.position.x), round(obj.position.y), round(obj.position.z)], yaw: round(obj.rotation.y, 4), scale: round(obj.scale?.x ?? 1) };
}

/** Godot's MultiNodeEdit: the channels EVERY selected thing has, the
 *  primary's value shown, ≠ where they differ; flags intersect the same way. */
function multiFields(ids) {
  const schemas = ids.map((id) => schemaFor(id));
  const chans = schemas.map((sc) => new Map(channels(sc).map((c) => [c.key, c])));
  const f = [{ t: 'info', label: 'selection', value: `${ids.length} selected — ${ids.join(', ')}` }, { t: 'info', label: '', value: 'typing sets every one · Ctrl-click to drop one · one undo' }];
  f.push({ t: 'group', k: 'channels', label: 'Channels (shared)', open: true });
  for (const c of chans[0].values()) {
    const all = chans.map((m) => m.get(c.key)).filter(Boolean);
    if (all.length !== ids.length) continue;
    const mixed = all.some((x) => Math.abs(x.value - c.value) > 1e-9);
    f.push({ ...c, k: `ch:${c.key}`, label: `${c.group === 'pos' ? c.label : `${c.group} · ${c.label ?? c.k}`}${mixed ? ' ≠' : ''}`, compact: true,
      disabled: all.some((x) => x.disabled), driven: undefined, hint: mixed ? 'differs across the selection — typing sets all' : c.hint });
  }
  f.push({ t: 'group', k: 'flags', label: 'Flags', open: true });
  for (const k of ['lock', 'hidden']) {
    const vals = ids.map((id) => comps.get(id)?.[k] === true);
    const on = vals.every(Boolean), mixed = vals.some(Boolean) && !on;
    f.push({ t: 'check', k: `ed:flags.${k}`, label: `${k === 'lock' ? 'locked' : 'hidden'}${mixed ? ' ≠' : ''}`, value: on, hint: mixed ? 'differs — checking sets all' : undefined });
  }
  f.push({ t: 'btn', k: 'remove', label: `remove ${ids.length}`, danger: true, vrOnly: true });   // desktop removes with Del / Backspace / X / right-click / Edit ▸ delete; a headset has no keys
  painted = f;
  return f;
}

// ---------------------------------------------------------------- inspector filter
// Hide non-matches and OPEN the groups that hold a hit — the two known-failed designs are
// Blender's highlight-only search and Godot's hits left buried under a collapsed header
// (proposals#10043). Matches a field's label or key; a group whose name matches keeps all
// of its fields. The header lines and the filter box itself always stay.
let ifilter = '';
function filterFields(f, q) {
  const needle = String(q ?? '').trim().toLowerCase();
  if (!needle) return f;
  const has = (x) => [x.label, x.k].some((v) => v != null && String(v).toLowerCase().replace(/^(ch|ed):/, '').includes(needle));
  const out = []; let group = null, rows = [], groupHit = false, any = false;
  const flush = () => {
    const keep = groupHit ? rows : rows.filter((x) => x.t !== 'info' && x.t !== 'btn' && has(x));
    if (group && keep.length) { out.push({ ...group, open: true }); out.push(...keep); any = true; }
  };
  for (const x of f) {
    if (x.t === 'group') { flush(); group = x; rows = []; groupHit = has(x); continue; }
    if (!group) { out.push(x); continue; }   // the header and the filter box
    rows.push(x);
  }
  flush();
  if (!any) out.push({ t: 'info', label: '', value: `no property matches "${q}"` });
  return out;
}

/** One card row from the schema, by address (the panels.js spec plus its dispatch key). */
function cardRow(schema, id, addr) {
  const nf = fieldAt(schema, addr); if (!nf) return null;
  const r = { ...nf, k: nf.commit ? `ed:${nf.commit}` : `ed:${addr}`, path: nf.commit ?? addr, ...(nf.t === 'num' ? { compact: true } : {}) };
  if (nf.t === 'ref') r.arming = !!armingRef && armingRef.id === id && armingRef.key === addr;
  if (nf.t === 'list') r.rows = (nf.rows ?? []).map((x) => ({ ...x, actions: (x.actions ?? []).map((a) => ({ ...a, k: `ed:${addr.slice(0, addr.indexOf('.'))}.${a.k}` })) }));
  return r;
}
/** The cards (design §5): one per component, each owning its fields by their
 *  group.k address — a thing's (inspectSchema) and the world's (worldSchema) alike. */
function pushCards(f, schema, id, { locked = false } = {}) {
  for (const sec of schema.sections.list) {
    const key = `c:${sec.key ?? sec.type}`;
    f.push({ t: 'group', k: key, label: `${sec.title}${locked && sec.type === 'Transform' ? ' 🔒' : ''}${sec.present === false ? ' · default' : ''}`, hint: `${sec.summary} — ${sec.category} · engine record ${sec.hash.slice(0, 12)}${sec.part ? ` · part: ${sec.part}` : ''}`, open: isOpen(id, key) });
    for (const [label, value] of sec.info ?? []) f.push({ t: 'info', label, value });
    // the channel box: an alias (pos.yaw, the heading) stays addressable for
    // agents but is not drawn; the Quaternion row folds under its own header,
    // closed unless the entity is in quaternion mode (then it IS the rotation)
    const quat = [];
    for (const addr of sec.fields) {
      const r = cardRow(schema, id, addr); if (!r || r.alias) continue;
      if (r.row === 'quat') quat.push(r); else f.push(r);
    }
    // groups are FLAT markers (renderDOM, the VR quad): a sub-header reopens
    // its rows even under a folded card, so a folded Transform omits it. A
    // filter is the exception: filterFields opens whatever holds a hit.
    if (quat.length && (isOpen(id, key) || ifilter.trim())) {
      const qk = `${key}:quat`;
      f.push({ t: 'group', k: qk, label: 'Quaternion', hint: 'the stored orientation, x y z w — normalized on commit', open: sec.quatOpen ? isOpen(id, qk) : !isOpen(id, qk) });
      f.push(...quat);
    }
    if (sec.removable && sec.key) f.push({ t: 'btn', k: `ed:remove.${sec.key}`, label: `remove ${sec.title}`, danger: true });
  }
}

/** The world entity in the Inspector: a header, then its Sky / Weather /
 *  Ground / Grass cards from shared/worldentity.js — edited through the sky,
 *  weather, terrain and grass verbs (inspect.js commitEdit routes @world). */
function worldFields() {
  const schema = schemaFor(WORLD_ID);
  const f = [
    { t: 'info', label: 'id', value: `${WORLD_ID} — the world entity` },
    { t: 'info', label: '', value: 'its sky, weather, ground and grass, as components: an edit goes out as the sky, weather, terrain or grass verb' },
  ];
  if (mayShape() === false) f.push({ t: 'info', label: '', value: 'shaping the world is the owner\'s — read-only for you' });
  f.push({ t: 'text', k: 'ifilter', label: '', value: ifilter, placeholder: 'filter properties ⏎', hint: 'non-matching fields hide; components with a hit open' });
  pushCards(f, schema, WORLD_ID);
  const shown = filterFields(f, ifilter);
  painted = shown;
  return shown;
}

function inspectorFields() {
  if (worldSel) return worldFields();
  const id = sceneSelected();
  if (!id || !entities.has(id)) return [{ t: 'info', label: 'selection', value: 'nothing selected — click a thing, a row in the hierarchy, or World for the sky and ground' }];
  const ids = selection();
  if (ids.length > 1) return multiFields(ids);
  const obj = entities.get(id); const meta = entityMeta.get(id) ?? {}; const bag = comps.get(id) ?? {};
  // the fold knows the thing before its model arrives: entities holds null
  // while the GLB loads (scenegraph guards the same seam)
  const schema = schemaFor(id);           // ONE declaration: shared/editschema.js
  // the lib line follows the Model component (schema.sections), not the realizer's meta,
  // which can lack it (the header used to say "lib ?" beside a Model card showing the path)
  const libLine = { t: 'info', label: 'lib', value: schema.sections?.libLabel ?? short(meta), ...(schema.sections?.lib ? { hint: schema.sections.lib } : {}) };
  if (!obj) return [{ t: 'info', label: 'id', value: id }, libLine, { t: 'info', label: 'state', value: 'loading…' }];
  const locked = !!bag.lock;
  const wp = obj.getWorldPosition(_wp);
  const label = typeof bag.label === 'string' && bag.label ? ` "${bag.label}"` : '';

  const f = [
    { t: 'info', label: 'id', value: `${id}${label}` },
    libLine,
    // attribution names the PLACER (the server's stamp); `actor` is whoever last wrote it —
    // an owner's re-light moves actor, so say so when they differ (AGENTS.md, build.js)
    { t: 'info', label: 'placed by', value: `${placerOf(id)?.id ?? meta.actor ?? '?'}${meta.actor && meta.actor !== (placerOf(id)?.id ?? meta.actor) ? ` · last change by ${meta.actor}` : ''}${obj?.userData?.mountedTo ? ` · on ${obj.userData.mountedTo}` : ''}` },
    { t: 'info', label: 'world', value: `(${wp.x.toFixed(1)}, ${wp.y.toFixed(1)}, ${wp.z.toFixed(1)}) · ${wp.distanceTo(myState.pos).toFixed(0)}m away` },
  ];

  // B: one card per component (shared/components.js via schema.sections), each
  // owning its fields by their unchanged group.k address, then Add Component.
  if (schema.sections) {
    for (const a of schema.sections.header ?? []) { const r = cardRow(schema, id, a); if (r) f.push(r); }
    if (pendingAsk?.id === id) {
      const q = pendingAsk.ask;
      f.push({ t: 'group', k: 'c:ask', label: q.kind === 'confirm' ? `Remove ${q.type}?` : `${q.component} needs a choice`, open: true });
      f.push({ t: 'info', label: '', value: q.prompt });
      if (q.kind === 'confirm') f.push({ t: 'btn', k: 'ask:both', label: `remove ${[...q.dependants.map((d) => d.type), q.type].join(' and ')}`, danger: true });
      else for (const o of q.options) f.push({ t: 'btn', k: `ask:${o.v}`, label: o.label });
      f.push({ t: 'btn', k: 'ask:cancel', label: 'cancel' });
    }
    f.push({ t: 'text', k: 'ifilter', label: '', value: ifilter, placeholder: 'filter properties ⏎', hint: 'non-matching fields hide; components with a hit open' });
    pushCards(f, schema, id, { locked });
    if (schema.sections.add.length) {
      f.push({ t: 'group', k: 'c:+', label: 'Add Component', open: isOpen(id, 'c:+') });
      for (const cat of [...new Set(schema.sections.add.map((a) => a.category))]) {
        f.push({ t: 'info', label: '', value: cat });
        for (const a of schema.sections.add.filter((x) => x.category === cat)) {
          const viaGesture = { Picture: 'ed:comp.add:picture', Sound: 'ed:comp.add:sound', Seats: 'ed:sockets.add' }[a.name];
          f.push({ t: 'btn', k: viaGesture ?? `ed:add.${a.name}`, label: `+ ${a.name}${a.brings ? ' (+ its need)' : a.asks ? '…' : ''}`, disabled: !!a.blocked,
            hint: a.blocked ?? (a.brings ? `${a.summary} — also adds ${a.brings}, in the same undo step` : a.asks ? `${a.summary} — needs a ${a.asks}: asks first` : a.summary) });
        }
      }
    }
  } else {
  // CHANNELS — the numeric lane: every num in the schema, transform first
  f.push({ t: 'text', k: 'ifilter', label: '', value: ifilter, placeholder: 'filter properties ⏎', hint: 'non-matching fields hide; groups with a hit open' });
  f.push({ t: 'group', k: 'channels', label: `Channels${locked ? ' 🔒' : ''}${obj.userData.mountedTo ? ' (mounted)' : ''}`, open: isOpen(id, 'channels') });
  for (const c of channels(schema)) {
    f.push({ ...c, k: `ch:${c.key}`, path: c.key, label: c.group === 'pos' ? c.label : `${c.group} · ${c.label ?? c.k}`, compact: true });
  }

  // GROUPS — flags, then every component group the schema declares, then the
  // raw-JSON floor for types no group speaks for, then behaviors
  const groupOf = (name) => schema.groups.find((g) => g.group === name);
  const addGroup = (g, key, title) => {
    if (!g) return;
    const name = String(title ?? g.label ?? g.group);
    f.push({ t: 'group', k: `g:${key}`, label: name.charAt(0).toUpperCase() + name.slice(1), open: isOpen(id, `g:${key}`) });
    for (const nf of g.fields) {
      // numbers read the same everywhere on desktop: scrub or type, no ± (the quad keeps its steppers)
      // a field may name its own commit address (a typed group's JSON hatch commits comp.<type>)
      const row = { ...nf, k: nf.commit ? `ed:${nf.commit}` : nf.k != null ? `ed:${g.group}.${nf.k}` : undefined, path: nf.commit ?? (nf.k != null ? `${g.group}.${nf.k}` : undefined), ...(nf.t === 'num' ? { compact: true } : {}) };
      if (nf.t === 'ref') row.arming = !!armingRef && armingRef.id === id && armingRef.key === `${g.group}.${nf.k}`;
      if (nf.t === 'list') row.rows = (nf.rows ?? []).map((r) => ({ ...r, actions: (r.actions ?? []).map((a) => ({ ...a, k: `ed:${g.group}.${a.k}` })) }));
      if (nf.t === 'json' && g.group === 'comp') { f.push(row); f.push({ t: 'btn', k: `uncomp:${nf.k}`, label: `remove ${nf.k}`, danger: true }); continue; }
      f.push(row);
    }
  };
  addGroup(groupOf('flags'), 'flags', 'Flags');
  for (const g of schema.groups) if (!['pos', 'flags', 'comp'].includes(g.group)) addGroup(g, g.group);
  addGroup(groupOf('comp'), 'components');
  }

  const mine = behaviors.filter((b) => b.attach === id);
  if (mine.length) {
    f.push({ t: 'group', k: 'behaviors', label: `Behaviors (${mine.length})`, open: isOpen(id, 'behaviors') });
    f.push({ t: 'list', k: 'bhv', rows: mine.map((b) => ({ id: b.id, label: `${b.status === 'running' ? '▶' : '⏸'} ${b.id}`, sub: `${b.timers ? `${b.timers}⏲ ` : ''}${b.status ?? ''}`, actions: [{ k: 'unbind', label: 'unbind', danger: true }] })) });
  }
  f.push({ t: 'btn', k: 'remove', label: 'remove', danger: true, vrOnly: true });   // desktop removes with Del / Backspace / X / right-click / Edit ▸ delete; a headset has no keys
  const shown = filterFields(f, ifilter);
  painted = shown;
  return shown;
}

function inspectorDispatch(action, payload, field, opts = {}) {
  const id = worldSel ? WORLD_ID : sceneSelected(); const obj = entities.get(id);
  if (action === 'fold') { toggleFold(id, payload); repaintAll(); return; }
  if (action === 'ifilter') { ifilter = String(payload ?? ''); repaintAll(); return; }
  if (id === WORLD_ID) {   // the world's cards: every field commits through inspect.js's @world path
    if (!action.startsWith('ed:') && !action.startsWith('ch:')) return;
    const isDelta = typeof payload === 'object' && payload && 'delta' in payload;   // a VR stepper
    const v = isDelta ? resolveDelta(painted, action, payload) : payload;
    if (isDelta && v == null) return;
    const r = commitEdit(WORLD_ID, action.slice(3), v, opts);
    if (r.errors?.length) flashHint(r.errors.join(' · '), 5000);
    if (!opts.live) repaintAll();
    return;
  }
  if (action.startsWith('ask:')) {
    const q = pendingAsk?.id === id ? pendingAsk.ask : null; pendingAsk = null;
    const v = action.slice(4);
    if (q && v !== 'cancel') { const r = commitEdit(id, q.key, v); if (r.errors?.length) flashHint(r.errors.join(' · '), 5000); }
    repaintAll(); return;
  }
  if (!obj) return;

  // ref field: a click with NO payload arms the pick (or cancels it); a null
  // payload clears the target (a real commit); an id falls through to commit.
  if ((action.startsWith('ed:') || action.startsWith('ch:')) && payload === undefined) {
    const key = action.slice(3);
    const f = fieldByKey(painted, action);
    if (f?.t === 'ref') {
      if (armingRef && armingRef.id === id && armingRef.key === key) { armingRef = null; flashHint('pick cancelled', 2500); }
      else { armingRef = { id, key }; flashHint(key === 'parent.to' ? `now click <b>${id}</b>'s new parent — a row here, or the thing itself in the world` : `now click <b>${key.split('.').pop()}</b>'s target — a row here, or the thing itself in the world`, 5000); }
      repaintAll();
      return;
    }
  }
  const live = !!opts.live;
  const ids = selection();
  if (ids.length > 1) {
    if (live) return;                                   // no multi preview: the commit is the feedback
    if (action === 'remove') { removeMany(ids); return; }
    if (action.startsWith('ch:') || action.startsWith('ed:')) {
      const key = action.slice(3);
      const isDelta = typeof payload === 'object' && payload && 'delta' in payload;
      const v = isDelta ? resolveDelta(painted, action, payload) : payload;
      if (isDelta && v == null) return;
      const inverses = [], errors = [];
      for (const each of ids) {
        const plan = planEdit(each, key, v);
        errors.push(...plan.errors); inverses.push(...plan.inverses);
        plan.verbs.forEach(sendPlanned);
      }
      if (inverses.length) pushUndo({ verbs: inverses }, `${key} on ${ids.length} things`);
      if (errors.length) flashHint(errors.join(' · '), 5000);
      repaintAll();
    }
    return;
  }

  // transform channels: preview locally while dragging (no log traffic), one
  // `place` on release carrying the full pose the channels show
  if (/^ch:pos\.(x|y|z|yaw|scale)$/.test(action)) {
    const k = action.slice(7);
    const driven = drivenBy(id, obj);
    const before = gesture?.before ?? restPose(id, obj);
    const next = { ...before, pos: [...before.pos] };
    const val = (cur) => (typeof payload === 'object' && payload && 'delta' in payload ? cur + payload.delta : payload);
    if (k === 'yaw') next.yaw = round(val(before.yaw), 4);
    else if (k === 'scale') next.scale = Math.max(0.01, round(val(before.scale)));
    else next.pos['xyz'.indexOf(k)] = round(val(before.pos['xyz'.indexOf(k)]));
    if (next.pos.some(Number.isNaN)) return;
    if (live) {
      // a live call back AT the start pose is a cancelled/no-op drag ending
      if (JSON.stringify(next) === JSON.stringify(before)) gesture = null; else gesture ??= { before };
      if (!driven) {   // a driven thing can't preview: the motion owns the frame
        obj.position.set(...next.pos); obj.rotation.y = next.yaw; obj.scale.setScalar(next.scale);
        reindexCollider(id); refreshOutline();
      }
      return;
    }
    gesture = null;
    if (JSON.stringify(next) === JSON.stringify(before)) return;
    pushUndo({ verb: 'place', args: { id, ...before } }, `moving ${id}`);
    sendVerb('place', { id, ...next });
    repaintAll();
    return;
  }
  // every other field, from either lane: ch:<group.k> / ed:<group.k> → the shared commit path
  if (action.startsWith('ch:') || action.startsWith('ed:')) {
    const key = action.slice(3);
    const isDelta = typeof payload === 'object' && payload && 'delta' in payload;   // a VR stepper
    const v = isDelta ? resolveDelta(painted, action, payload) : payload;
    if (isDelta && v == null) return;
    const r = commitEdit(id, key, v, opts);
    if (r.errors?.length) flashHint(r.errors.join(' · '), 5000);
    // a need that asks (a choice with options, or a remove-both) is a prompt, not an error
    const ask = r.asks?.find((q) => q.kind === 'confirm' || q.options?.length);
    if (ask) pendingAsk = { id, ask };
    if (!live) repaintAll();
    return;
  }
  switch (action) {
    case 'remove': removeMany([id]); break;
    case 'unbind': sendVerb('behavior', { id: payload, remove: true }); setTimeout(refreshBehaviors, 400); break;
    case 'bhv': watchScript(payload); break;   // a script row → the Console, watching it
    default: if (action.startsWith('uncomp:')) commitEdit(id, `comp.${action.slice(7)}`, null);
  }
  repaintAll();
}

// ---------------------------------------------------------------- console
// The behavior runtime made visible (the legacy World panel's 📜 scripts): every
// script bound in this world, and one script's live world.log() ring, polled
// while the frame is open. Agents read the same thing through world_debug.
let watching = null;           // behavior id whose log is open
let watchLog = null;           // { status, lines } from the last poll
async function refreshWatch() {
  if (!watching) { watchLog = null; return; }
  try {
    const d = await requestDebug({ behavior: watching, limit: 40 });
    watchLog = { status: d?.status ?? '?', lines: (d?.events ?? []).map((e) => `${new Date(e.ts).toTimeString().slice(0, 8)}  ${e.line}`) };
  } catch { /* a poll that fails keeps the last good tail */ }
}
function consoleFields() {
  const f = [{ t: 'list', k: 'cwatch', empty: 'no scripts bound in this world — behaviors are the scripting tier (AGENTS.md)',
    rows: behaviors.map((b) => ({ id: b.id, label: `${b.status === 'running' ? '▶' : '⏸'} ${b.id}`,
      sub: [b.attach ? `on ${b.attach}` : 'world', b.timers ? `${b.timers}⏲` : null, b.status !== 'running' ? (b.status ?? 'paused') : null].filter(Boolean).join(' · '),
      active: b.id === watching,
      actions: [...(b.attach ? [{ k: 'cgoto', label: 'select' }] : []), { k: 'unbind', label: 'unbind', danger: true }] })) }];
  if (watching) {
    f.push({ t: 'group', k: 'clog', label: `${watching} — ${watchLog?.status ?? '…'}`, open: true });
    f.push({ t: 'log', k: 'clines', lines: watchLog?.lines ?? [], empty: '(console empty — world.log() writes here)' });
  }
  f.push({ t: 'info', label: '', value: 'click a script to watch its log · /debug = flight recorder' });
  return f;
}
export async function watchScript(id) {
  watching = id; await refreshWatch();
  const c = frames.get('console'); if (c && !c.frame.visible) c.frame.show();
  repaintAll();
}
function consoleDispatch(action, payload) {
  switch (action) {
    case 'cwatch': watching = payload === watching ? null : payload; refreshWatch().then(repaintAll); break;
    case 'cgoto': { const b = behaviors.find((x) => x.id === payload); if (b?.attach && entities.has(b.attach)) sceneSelect(b.attach); break; }
    case 'unbind': sendVerb('behavior', { id: payload, remove: true }); if (watching === payload) watching = null; setTimeout(refreshBehaviors, 400); break;
    case 'fold': break;   // the log header is not a fold
  }
  repaintAll();
}

/** The verb that would bring a removed thing back — from the FOLD record,
 *  so a light returns with its colour and a model with its scale and comps. */
function removeInverse(id) {
  const rec = foldRecord(id); if (!rec) return null;
  const pos = [...(rec.pos ?? [0, 0, 0])];
  return rec.kind === 'light'
    ? { verb: 'light', args: { id, pos, color: rec.color, intensity: rec.intensity, range: rec.range, keep: rec.keep === true, day: rec.day !== false } }
    : { verb: 'spawn', args: { id, lib: rec.lib, pos, yaw: rec.yaw ?? 0, ...(rec.scale != null ? { scale: rec.scale } : {}) } };
}
function removeMany(ids) {
  const locked = ids.filter((id) => comps.get(id)?.lock);
  const held = ids.filter((id) => !comps.get(id)?.lock && guardedByOther(id));
  const why = [];
  if (locked.length) why.push(`${locked.join(', ')} ${locked.length > 1 ? 'are' : 'is'} locked — unlock first`);
  // the server would refuse these anyway; say so instead of a silent bounce
  if (held.length) why.push(held.map((id) => `${id} is guarded by ${placerName(id)}`).join(' · '));
  if (why.length) flashHint(why.join(' · '), 4000);
  const go = ids.filter((id) => entities.get(id) && !locked.includes(id) && !held.includes(id));
  if (!go.length) return false;
  const inverses = go.map(removeInverse).filter(Boolean);
  pushUndo(inverses.length === 1 ? inverses[0] : { verbs: inverses }, go.length === 1 ? `removing ${go[0]}` : `removing ${go.length} things`);
  for (const id of go) sendVerb('remove', { id });
  clearExtras();
  return true;
}

// ---------------------------------------------------------------- build
// Things INTO the world, in the left column beside the Hierarchy (Build | Hierarchy; design §5),
// so the viewport carries nothing but the world. B opens edit mode on this tab the first time;
// editlayout.js remembers the last tab after that (edittabs.js). Three sections, every one a
// RE-HOST of something that already worked — nothing here is a second implementation:
//   Blueprints  the starters and the library (palette.js, /library-models): a raw model is a
//               blueprint of one Model, and placing one is exactly what placing from the library
//               always did (build.js holdGhost → spawn). "add light" is a blueprint of one Light.
//               Saved blueprints arrive with step 6; the group is there, empty, saying so.
//   Tools       the transform tools (build.js setTool — the same call as Q/G/E/R), the building
//               tools (structure_ui.js — its TOOLS, its setTool, its OWN undo stack, labelled so)
//               and seat placement (seatedit.js armSeatPlacement, on the selected thing).
//   World       the world entity's presets (shared/worldentity.js worldPick): Sky from
//               defs/sky/_presets.json, Ground and Grass from defs/ground/_palette.json (the same
//               args groundpanel writes, shared/grounddefs.js), Weather. A pick replaces the
//               current choice through the existing sky / terrain / grass / weather verbs, as one
//               Ctrl+Z step. "World" selects @world: its every field, in the Inspector.
// The VR body says what it cannot do: the building tools pick cells with a mouse ray on the canvas,
// and the transform tools drag with one, which a headset does not have yet — so the quad names
// that, offers the Library (placing a model 1.5 m ahead: worldquad.js spawnAhead) and the World.
const buildFolds = {};
let libQ = '';            // the Library search box
let libHits = null;       // search results; null = the curated starters (an empty box shows those, as palette.js does)
let libSeq = 0;
async function searchLibrary(q) {
  libQ = q; const n = ++libSeq;
  if (!q) { libHits = null; repaintAll(); return; }
  try {
    const hits = await (await fetch(`/library-models?q=${encodeURIComponent(q)}`)).json();
    if (n === libSeq) { libHits = Array.isArray(hits) ? hits : []; repaintAll(); }
  } catch { /* keep the last list; the box still shows what was asked */ }
}
const libModels = () => libHits ?? starterModels().map((m) => ({ ...m, preview: m.path.replace(/\.glb$/, '_preview.jpg') }));
const libTiles = (pics) => ({ t: 'tiles', k: 'place', value: null, empty: libQ ? `nothing matches "${libQ}"` : 'the library is empty',
  options: libModels().map((m) => ({ v: m.path, label: m.name, ...(pics && m.preview ? { img: `/library/${m.preview}` } : {}),
    hint: pics ? 'a blueprint of one Model — click, then click the world to place it' : 'a blueprint of one Model — places it 1.5 m ahead of you' })) });

// the transform tools, as the rail draws them (editlayout.js TOOLS) — the same ids build.js setTool takes
const TRANSFORM_TILES = [
  { v: 'select', label: 'select', icon: 'mousePointer2', hint: 'Q — click picks, a drag never moves' },
  { v: 'move', label: 'move', icon: 'move', hint: 'G — drag moves; Shift+drag raises' },
  { v: 'rotate', label: 'rotate', icon: 'rotateCw', hint: 'E — drag turns it, any axis on the gizmo' },
  { v: 'scale', label: 'scale', icon: 'scale3d', hint: 'R — drag sizes, uniform' },
];

const blueprintFields = (pics) => [
  { t: 'group', k: 'blueprints', label: 'Blueprints', open: !buildFolds.blueprints },
  { t: 'info', label: '', value: 'a model from the library is a blueprint of one Model' },
  ...(pics ? [{ t: 'btn', k: 'light', label: 'add light', icon: 'lightbulb', hint: 'a blueprint of one Light — carry it, then click the world to place it' },
    { t: 'text', k: 'libq', label: '', value: libQ, placeholder: 'search the library ⏎', hint: 'an empty box shows the starters' }] : []),
  libTiles(pics),
  { t: 'info', label: 'saved here', value: 'none yet — Save as Blueprint comes with blueprints (next step)' },
];

/** The World section: one row of tiles per component, each reading its current choice. */
function worldBuildFields() {
  const owner = mayShape() !== false;
  const ro = owner ? {} : { disabled: true };
  const now = Date.now();
  const ch = worldChoice(state.st, { pal: groundPal, presets: skyPresets, now });
  const names = (o) => Object.keys(o ?? {}).filter((k) => k !== 'doc');
  const f = [
    { t: 'group', k: 'world', label: 'World', open: !buildFolds.world },
    worldRowFields(),
    ...(owner ? [] : [{ t: 'info', label: '', value: 'shaping the world is the owner\'s — these are read-only for you' }]),
    { t: 'info', label: 'sky', value: ch.sky ? `${ch.sky} — a pick replaces the sky; the weather stays` : 'custom — a pick replaces the sky; the weather stays' },
    { t: 'tiles', k: 'wsky', value: ch.sky, empty: 'this world serves no sky presets (defs/sky/_presets.json)', options: names(skyPresets).map((n) => ({ v: n, label: n, hint: `the sky at ${skyPresets[n].hours ?? '?'}h${skyPresets[n].clouds ? `, ${skyPresets[n].clouds}` : ''}` })), ...ro },
    { t: 'info', label: 'ground', value: 'shape and colour — each pick changes only its own dial' },
    { t: 'tiles', k: 'wshape', value: ch.shape, empty: 'this world serves no ground palette (defs/ground/_palette.json)', options: names(groundPal?.shapes).map((n) => ({ v: n, label: n, hint: `${groundPal.shapes[n]} m of relief` })), ...ro },
    { t: 'tiles', k: 'wtint', value: ch.tint, options: names(groundPal?.tints).map((n) => ({ v: n, label: n, hint: `${groundPal.tints[n].layer} ground, grass to match` })), ...ro },
    { t: 'info', label: 'grass', value: ch.plant ? `${ch.plant} growing` : state.st.grass ? 'something the palette does not name is growing' : 'nothing growing' },
    { t: 'tiles', k: 'wplant', value: ch.plant, options: [...names(groundPal?.plantings).map((n) => ({ v: n, label: n, hint: 'plant it (replaces what grows now)' })), ...(groundPal ? [{ v: '@mow', label: 'mow', hint: 'clear the field' }] : [])], ...ro },
    { t: 'info', label: 'weather', value: state.st.sky?.forecast ? 'a forecast governs — a pick holds until its next change' : 'a pick sets it' },
    { t: 'tiles', k: 'wwx', value: ch.weather, options: WEATHERS.map((w) => ({ v: w, label: w })), ...ro },
  ];
  return f;
}
const WORLD_PICKS = { wsky: 'sky', wshape: 'shape', wtint: 'tint', wplant: 'plant', wwx: 'weather' };
/** A World tile: the pick as verbs (shared/worldentity.js worldPick), one undo step. */
function pickWorld(action, v) {
  const kind = action === 'wplant' && v === '@mow' ? 'mow' : WORLD_PICKS[action];
  const r = worldPick(state.st, kind, v, { pal: groundPal, presets: skyPresets, now: Date.now(), mayShape: mayShape() });
  if (r.errors.length) { flashHint(r.errors.join(' · '), 5000); return r; }
  if (r.inverses.length) pushUndo(r.inverses.length === 1 ? r.inverses[0] : { verbs: [...r.inverses].reverse() }, kind === 'mow' ? 'mowing' : `the ${kind === 'shape' || kind === 'tint' ? 'ground' : kind === 'plant' ? 'grass' : kind}`);
  for (const x of r.verbs) sendVerb(x.verb, x.args);
  flashHint(kind === 'mow' ? 'field cleared' : `${kind === 'plant' ? 'grass' : kind}: <b>${v}</b>`, 2500);
  return r;
}

function buildFields() {
  const st = structureTool(); const sel = sceneSelected();
  return [
    ...blueprintFields(true),
    { t: 'group', k: 'tools', label: 'Tools', open: !buildFolds.tools },
    // one tool is active: an armed building tool or seat placement owns the next click, so the
    // transform tile reads armed only while neither is
    { t: 'tiles', k: 'ttool', value: st || seatArmed() ? null : transformTool(), options: TRANSFORM_TILES },
    { t: 'tiles', k: 'stool', value: st, options: structureTools().map((x) => ({ v: x.k, label: x.label, icon: x.icon, hint: x.hint })) },
    { t: 'tiles', k: 'xtool', value: seatArmed() ? 'seat' : null, disabled: !sel && !seatArmed(),
      options: [{ v: 'seat', label: 'seat', icon: 'armchair', hint: sel ? `click where a sitter goes on ${sel}` : 'select a thing first, then click where a sitter goes' }] },
    { t: 'btn', k: 'snew', label: 'new building', icon: 'plus', hint: 'start a new building on the ground in view' },
    { t: 'btn', k: 'sundo', label: 'undo building edit', icon: 'undo2', disabled: !undoDepth(), hint: 'undo the last building edit — its own stack, separate from Ctrl+Z' },
    ...worldBuildFields(),
  ];
}
function buildDispatch(action, payload) {
  if (WORLD_PICKS[action]) { pickWorld(action, payload); repaintAll(); return; }
  switch (action) {
    case 'fold': buildFolds[payload] = !buildFolds[payload]; break;
    case 'wsel': selectWorld(); return;
    // a transform tile is the same call as its key (Q/G/E/R); picking one also puts down an armed
    // building tool or seat placement, which would otherwise keep the next click
    case 'ttool': if (structureTool()) setStructureTool(null); cancelSeatArm(); setTransformTool(payload); break;
    case 'stool': cancelSeatArm(); setStructureTool(structureTool() === payload ? null : payload); break;   // the armed tile again = drop it
    case 'xtool': if (seatArmed()) cancelSeatArm(); else { if (structureTool()) setStructureTool(null); armSeatPlacement(sceneSelected()); } break;
    case 'snew': newBuilding(null); break;
    case 'sundo': structureUndo(); break;
    case 'light': holdGhost('@light', 'light'); break;
    case 'libq': searchLibrary(String(payload ?? '').trim()); return;
    case 'place': {
      const m = libModels().find((x) => x.path === payload);
      if (m) { libLabels.set(m.path, m.name); holdGhost(m.path, m.name); }
      break;
    }
  }
  repaintAll();
}
function buildVRFields() {
  return [
    ...blueprintFields(false),
    { t: 'group', k: 'tools', label: 'Tools', open: !buildFolds.tools },
    { t: 'info', label: '', value: 'building and transform tools: desktop only for now' },
    ...worldBuildFields(),
  ];
}
function buildVRDispatch(action, payload) {
  if (WORLD_PICKS[action]) pickWorld(action, payload);
  else if (action === 'fold') buildFolds[payload] = !buildFolds[payload];
  else if (action === 'wsel') { selectWorld(); return; }
  else if (action === 'place' && payload) spawnAhead(payload);
  repaintAll();
}

// ---------------------------------------------------------------- mounting
const PANELS = [
  { id: 'hierarchy', title: 'Hierarchy', theme: 'edit', fields: hierarchyFields, dispatch: hierarchyDispatch, frame: { x: 64, y: 60, w: 300, h: 380, minW: 220, minH: 160 } },   // x clears the dock rail (left:10 + 34px buttons + padding)
  // docked as a tab beside the Hierarchy by editlayout.js (Build | Hierarchy); its VR body is its own field list
  { id: 'build', title: 'Build', theme: 'edit', fields: buildFields, dispatch: buildDispatch, vr: { fields: buildVRFields, dispatch: buildVRDispatch }, frame: { x: 64, y: 60, w: 300, h: 380, minW: 220, minH: 160 } },
  { id: 'inspector', title: 'Inspector', theme: 'edit', fields: inspectorFields, dispatch: inspectorDispatch, frame: { x: -330, y: 60, w: 320, h: 520, minW: 250, minH: 160 } },
  // optional: never auto-shown on entering edit mode (View ▸ console, or a script row in the inspector)
  { id: 'console', title: 'Console', theme: 'edit', fields: consoleFields, dispatch: consoleDispatch, optional: true, frame: { x: 'center', y: -24, w: 560, h: 240, minW: 320, minH: 120 } },
];
const frames = new Map();
let queued = false;
function repaintAll() {
  globalThis.__panelTrace?.push(['ask', performance.now() | 0, queued]);   // probe hook; inert otherwise
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    globalThis.__panelTrace?.push(['paint', performance.now() | 0]);
    for (const p of PANELS) frames.get(p.id)?.set(p.fields(), (a, v, fld, o) => p.dispatch(a, v, fld, o));
    bus.emit('xr:repaint');
  });
}

export function initEditPanels() {
  for (const p of PANELS) {
    registerXRPanel({ ...p, ...(p.vr ?? {}) });            // the VR body (a panel may declare its own)
    const sf = makeSchemaFrame(p.id, { title: p.title, ...p.frame, hidden: true, className: 'edit' });   // the desktop body
    frames.set(p.id, sf);
  }
  bus.on('sg:selected', (id) => { if (id) { revealPath(id); worldSel = false; } });   // before the paint: a selected child shows, its ancestors unfold (design §5)
  for (const ev of ['entity', 'comp', 'mount', 'edit-mode', 'sg:selected', 'structure-tool', 'tool', 'your-rights']) bus.on(ev, repaintAll);
  // the world entity's components are the fold's sky / terrain / grass: repaint when a world verb folds
  const WORLD_VERBS = new Set(['sky', 'weather', 'terrain', 'grass']);
  onWorldChange((ev) => { if (ev.type !== 'entry' || WORLD_VERBS.has(ev.entry?.verb)) repaintAll(); });
  loadWorldDefs(); bus.on('defs-updated', loadWorldDefs);
  bus.on('sg:selected', () => { gesture = null; pendingAsk = null; endGesture(); if (!extending) clearExtras(); });   // a plain select collapses the set; a drag's `before` never outlives its selection
  bus.on('edit-extend', (id) => extendSelection(id));   // Ctrl-click in the viewport (build.js)
  // an armed attach completes on a VIEWPORT pick too: build.js select → sceneSelect
  // → this. The child is re-selected after, so the inspector shows what moved.
  bus.on('sg:selected', (id) => {
    // a ref pick armed from the inspector: the world-clicked id is the target.
    // Re-select the entity being edited so the inspector stays on it.
    if (armingRef && id && id !== armingRef.id && !String(id).startsWith('rider:')) {
      const back = armingRef.id;
      if (completeRefPick(id)) { sceneSelect(back); return; }
    }
    if (!arming || !id || id === arming || String(id).startsWith('rider:')) return;
    const child = arming; arming = null;
    reparent(child, id);
    sceneSelect(child);
  });
  bus.on('entity', () => { if (extra.size) syncOutlines(); });
  bus.on('edit-mode', (on) => { if (!on) { clearExtras(); armingRef = null; worldSel = false; } });
  setEditHooks({ undo: pushUndo, commitLight, casting: lightCasting });
  // Del / Backspace / X act on what the inspector shows — every selected thing, one undo
  setRemoveHook(() => removeMany(selection()));
  bus.on('edit-find', () => findSelected());              // F in the viewport
  bus.on('key', (e) => {   // Alt+D duplicates: D strafes, and Shift+D strafes faster
    if (!shown || e.ctrlKey || e.metaKey || !e.altKey) return;
    if (e.code === 'KeyD' && sceneSelected()) { e.preventDefault(); hierarchyDispatch('duplicate', sceneSelected()); }
  });
  // ↑/↓ walk the tree ONLY while the tree has focus — on the window they are
  // walking keys (controller.js: ArrowUp is forward). The frame listener runs
  // before the window's and stops the event there.
  const hf = frames.get('hierarchy');
  if (hf) {
    const scroll = hf.frame.body.querySelector('.schema-scroll');
    scroll.tabIndex = 0;
    scroll.addEventListener('pointerdown', () => { if (!/INPUT|TEXTAREA/.test(document.activeElement?.tagName ?? '')) scroll.focus({ preventScroll: true }); });
    hf.frame.el.addEventListener('keydown', (e) => {
      if (/INPUT|TEXTAREA/.test(e.target?.tagName ?? '')) return;
      if (e.code === 'F2') {   // rename the selected row in place
        const sel = sceneSelected(); if (!sel) return;
        const line = [...scroll.querySelectorAll('.sp-tree-row')].find((x) => x.dataset.id === sel);
        if (line?._rename) { e.preventDefault(); e.stopPropagation(); line._rename(); }
        return;
      }
      if (e.code !== 'ArrowUp' && e.code !== 'ArrowDown') return;
      e.preventDefault(); e.stopPropagation();
      hierarchyDispatch('step', e.code === 'ArrowUp' ? -1 : 1);
    });
  }
  bus.on('sg:selected', () => { if (shown) refreshBehaviors(); });
  repaintAll();
  globalThis.__editPanels = editPanelsDebug;   // harness window (probes read it, nothing else does)
  globalThis.__editStep = (d) => { const sel = sceneSelected(); const i = visibleRows.indexOf(sel); hierarchyDispatch('step', d); return { sel, i, rows: [...visibleRows], after: sceneSelected(), has: entities.has(visibleRows[i + d]) }; };
  import('./editlayout.js').then((m) => { globalThis.__editLayout = m.editLayoutDebug; });
  const show = (on) => {
    shown = !!on;
    for (const p of PANELS) { const sf = frames.get(p.id); if (!sf) continue; if (!on) sf.frame.hide(); else if (!p.optional) sf.frame.show(); }
    clearInterval(rosterTimer); rosterTimer = 0;
    // the roster every 5 s; a watched log every 2.5 s while the console is open (someone is reading it)
    if (on) { refreshBehaviors(); let n = 0; rosterTimer = setInterval(async () => {
      const open = frames.get('console')?.frame.visible;
      if (!open && (n++ % 2)) return;
      await refreshBehaviors(); if (open && watching) { await refreshWatch(); repaintAll(); }
    }, 2500); }
  };
  return { show };
}

/** harness window */
export const editPanelsDebug = () => ({
  hierarchy: hierarchyFields().length, hierFields: () => hierarchyFields(), inspector: inspectorFields().length, inspFields: () => inspectorFields(),
  build: buildFields().length, buildFields: () => buildFields(), buildVR: buildVRFields().length, buildVRFields: () => buildVRFields(), worldSel, selected: sceneSelected(), arming,
  groups: sceneSelected() ? schemaFor(sceneSelected()).groups.map((g) => g.group) : [], behaviors: behaviors.length, rows: visibleRows, selection: selection(),
  watching, consoleLines: watchLog?.lines?.length ?? 0,
});
