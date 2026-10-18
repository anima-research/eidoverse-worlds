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

import * as OP from '../../shared/protocol/requests.js';
import { worldHistoryRows, historyView, HISTORY_MODES, mergeHistory } from './historyrows.js';
import { creditLine } from '../../shared/libcredits.js';
import { THREE, scene } from './core.js';
import { bus, CONFIG } from './base.js';
import { entities, bagOf, avatarMounts } from './world.js';
import { compEntries, compKeys } from '../../shared/protocol/view.js';
import { requestDebug, sendRequest, replica, net } from './net.js';
import { flashHint, html } from './ui.js';
import { openGripEditor } from './gripedit.js';
import { makeSchemaFrame, resolveDelta, getScrubFeel, setScrubFeel, SCRUB_SPEEDS } from './panels.js';
import { registerXRPanel } from './xrpanels.js';
import { treeData, sceneSelected, sceneSelect } from './scenegraph.js';
// a seated person's row in the hierarchy (not an entity: no drag, no lock, no selection)
const OCC_ROW = 'occupant:';
import * as Sel from './edit/selection.js';
import { state, onWorldChange } from './state.js';
import { treeRows, kindHint, ancestors } from '../../shared/hierarchy.js';
import { handleOf } from '../../shared/thingref.js';
import { refreshOutline, setRemoveHook, holdGhost, holdBlueprint, getTool as transformTool, setTool as setTransformTool } from './build.js';
import { armSocketPlacement, socketArmed, cancelSocketArm } from './socketedit.js';
import { defsRegistry } from './defs.js';
import { WORLD_ID, describeWorld, worldPick, worldChoice } from '../../shared/worldentity.js';
import { WEATHERS } from '../../shared/forecast.js';
import { copiesOf } from '../../shared/blueprint.js';
import { openNewScript, mayScript } from './scriptnew.js';
import { structureTools, currentTool as structureTool, setTool as setStructureTool, newBuilding } from './structure_ui.js';
import { starterModels } from './catalog.js';
import { spawnAhead } from './worldquad.js';
import { libLabels, modelName } from './assets.js';
import { offIn } from './realize/models_field.js';
import { schemaFor, commitEdit, commitMany, planEdit, setEditHooks, endGesture, foldRecord, mayShape } from './inspect.js';
import { channels, fieldAt, ADD_WORDS, libLabel } from '../../shared/editschema.js';
import { askCenter, confirmCenter } from './confirmcenter.js';
import { xrActive } from './xrask.js';
import { frontOf, addOnFace } from './facemedia.js';
import { lightCasting } from './lights.js';
import { myState, frameOn } from './controller.js';
import { reindexCollider } from './colliders.js';
import * as Edits from './editwrites.js';
import { isMineHidden, toggleMineHidden, showAllMine, myHiddenCount } from './myview.js';
import { agoWords, touchWords } from '../../shared/protocol/refusal.js';
import { recordComponents } from '../../shared/protocol/view.js';
import { RANK, lockLevel, lockRank } from '../../shared/protocol/roles.js';
import { KEYHINTS, withKeys } from './keyhints.js';   // slice 3b: these panels' writes are requests
import { called } from './plainwords.js';

const _wp = new THREE.Vector3();
const round = (v, dp = 3) => +(+v).toFixed(dp);

// collapsed groups remembered per LIB (a chair's Components stays open for
// every chair) — Godot folds per object; per lib is the eidoverse shape
const FOLD_LS = 'ew-insp-fold';
let folds = {};
try { folds = JSON.parse(localStorage.getItem(FOLD_LS) || '{}'); } catch { /* fresh */ }
const foldKey = (id) => (id === WORLD_ID ? WORLD_ID : `${bagOf(id)?.model ?? '?'}`);
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
// R 10-10 00:03: with 'list components' on, every thing would open on its component rows; there, things start FOLDED, and
// opening one is remembered here (per viewer, like the folds)
const openComps = new Set((() => { try { const v = JSON.parse(localStorage.getItem('ew.hierarchy.opencomps') || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } })());
const isFolded = (id) => (hopts.comps ? !openComps.has(id) : collapsed.has(id));
const setFolded = (id, shut) => { if (hopts.comps) { if (shut) openComps.delete(id); else openComps.add(id); } if (shut) collapsed.add(id); else collapsed.delete(id); };
const descendantsOf = (id) => { const w = state.st.entities ?? {}, out = []; const kids = (p) => Object.keys(w).filter((k) => w[k]?.parent?.to === p);
  for (let q = kids(id), n = 0; q.length && n < 4096; n++) { const k = q.shift(); out.push(k); q.push(...kids(k)); } return out; };
function saveFolds() { try { localStorage.setItem(HFOLD_LS(), JSON.stringify([...collapsed])); localStorage.setItem('ew.hierarchy.opencomps', JSON.stringify([...openComps].slice(-2000))); } catch { /* a private window: folds last the session */ } }
/** Unfold every ancestor of `id` (a selection reveals itself). */
function revealPath(id) {
  let changed = false;
  for (const a of ancestors(state.st.entities ?? {}, id)) { if (collapsed.delete(a)) changed = true; if (hopts.comps && !openComps.has(a)) { openComps.add(a); changed = true; } }
  if (changed) saveFolds();
  return changed;
}
let visibleRows = [];          // the rows as last painted, for ↑/↓

// ---------------------------------------------------------------- the world entity
// `@world` (design §3, shared/worldentity.js) is not in `entities` — it is the
// fold's sky / terrain / grass read as one entity — so it has no outline and no
// scenegraph selection. Selecting it clears the thing selection and shows its
// components in the Inspector; selecting any thing clears it again. Both live in edit/selection.js
// (kind 'world', or 'env:<key>' with one of its environment cards in focus).
const worldSel = () => { const k = Sel.selection().kind; return k === 'world' || String(k).startsWith('env:'); };
const envFocus = () => { const k = Sel.selection().kind; return String(k).startsWith('env:') ? k.slice(4) : null; };
/** Create ▸ Environment (editlayout.js): select the world with one of its cards open and the Build tab's World presets
 *  in view — the same places a click on the World row and on Build ▸ World lead to. */
export function openWorldCard(key) {
  const g = key === 'weather' ? 'weather' : key; if (g && !isOpen(WORLD_ID, g)) toggleFold(WORLD_ID, g);
  if (buildFolds.world) buildFolds.world = false;
  selectWorld(key);
}
function selectWorld(env = null) {
  arming = null; armingRef = null;
  Sel.set([WORLD_ID], env ? `env:${env}` : 'world');
  repaintAll();
}
// the palettes the World tiles offer — defs (defs/sky/_presets.json, defs/ground/_palette.json),
// authoring conveniences only: a pick writes concrete verb args, never a preset's name
let skyPresets = null, groundPal = null;
function loadWorldDefs() {
  defsRegistry().then((reg) => { skyPresets = reg.skyPresets ?? null; groundPal = reg.groundPalette ?? null; repaintAll(); }).catch(() => { /* the tiles say the palette is missing */ });
}
// the world's display name: @world's about.name, else the name in its address
const worldName = () => replica.st?.entities?.['@world']?.c?.about?.name || CONFIG.world || 'World';
// R, 10-10: "make it clear what the 'World' is in the Hierarchy. Either World: (gym, in this case) or at least tooltip
// the world entity, or maybe put the 'world' icon in-line with it": all three.
const worldRowFields = () => ({ t: 'list', k: 'wsel', rows: [{ id: WORLD_ID, icon: 'globe', kind: 'World', label: worldName(), sub: describeWorld(state.st, Date.now(), { presets: skyPresets, clock: false }), active: worldSel(),
  title: 'the world itself: its sky, weather, rules and settings. Click to edit them in the Inspector.' }, ...envRows()] });
// R 10-11: "no way to get rid of the weather, sky, or terrain once created… We really need those components or entities
// to appear under the world entity in the Hierarchy… so they can be deleted". Unreal's Outliner lists the sky and the
// landscape as actors, Godot's scene tree a WorldEnvironment node, Roblox Terrain under Workspace: things in the tree.
// Here they are @world's components, so they hang under the World row; a click opens their card, ✕ removes them.
const ENV = [
  { key: 'sky', label: 'Sky', icon: 'sun', gone: 'a plain clear sky' },
  { key: 'weather', label: 'Weather', icon: 'sparkle', gone: 'clear weather' },
  { key: 'terrain', label: 'Terrain', icon: 'mountains', gone: 'the default flat ground' },
  { key: 'grass', label: 'Grass', icon: 'plant', gone: 'no grass' },
];
const wxOf = () => state.st.sky?.weather ?? state.st.sky?.override?.weather ?? null;
/** Remove one environment component (sky/weather/terrain/grass): the same edit from the Hierarchy row's ✕, the World section's
 *  button and the card's remove button (mow, for grass; clear, for weather). */
function removeEnv(key) {
  const e = ENV.find((x) => x.key === key); if (!e) return;
  const path = key === 'weather' ? 'weather.state' : key === 'grass' ? 'grass.mow' : `${key}.remove`;
  const r = commitEdit(WORLD_ID, path, key === 'weather' ? 'clear' : true);
  flashHint(r.errors?.length ? r.errors.join(' · ') : `${e.label} removed: ${e.gone} (Ctrl+Z brings it back)`, r.errors?.length ? 5000 : 2600, r.errors?.length ? 'attn' : undefined);
  repaintAll();
}
function envRows() {
  const may = mayShape() !== false;
  return ENV.filter((e) => (e.key === 'weather' ? wxOf() && wxOf() !== 'clear' : state.st[e.key] != null)).map((e) => ({
    id: `env:${e.key}`, icon: e.icon, label: e.label, indent: true, active: worldSel() && envFocus() === e.key,
    sub: e.key === 'weather' ? wxOf() : undefined,
    title: `the world's ${e.label.toLowerCase()}: click to edit it in the Inspector${may ? `; ✕ removes it (${e.gone})` : ''}`,
    actions: may ? [{ k: 'envdel', label: '✕', danger: true, hover: true, title: `remove: ${e.gone}` }] : [] }));
}
// HIERARCHY VIEW OPTIONS (R, 10-10: "the list in the hierarchy is still hella busy. I would only have the name in the
// list proper, more info (like id) when you hover over it, and a drop-down ... 'display by id', checkboxes for 'list
// components'"). Off by default; kept per browser.
const HOPTS = { ids: 'show ids', kinds: 'show kinds', comps: 'list components' };
let hopts = { ids: false, kinds: false, comps: false, only: null };
// the row filters (R 10-12 10:58: the three row surfaces come with filters); a match keeps its ancestors, like the text filter
const ONLY = {
  all: { label: 'show every row', test: null },
  off: { label: 'only switched off', none: 'is switched off', test: (id, w) => w[id]?.disabled === true },
  mine: { label: 'only hidden in my view', none: 'is hidden in your view', test: (id) => isMineHidden(id) },
  locked: { label: 'only locked', none: 'is locked', test: (id) => !!bagOf(id)?.lock },
};
try { Object.assign(hopts, JSON.parse(localStorage.getItem('ew.hierarchy.view') ?? '{}')); } catch { /* a private window, or a bad value: the defaults */ }
const saveHopts = () => { try { localStorage.setItem('ew.hierarchy.view', JSON.stringify(hopts)); } catch { /* no storage */ } };

// ---------------------------------------------------------------- multi-selection
// One store (edit/selection.js): ids ordered, the PRIMARY first (the outline, every
// single-thing path). A Shift/Ctrl-click in the tree or a Ctrl-click in the viewport
// toggles more ids into it. The inspector then shows the channels every selected thing
// has (Godot's MultiNodeEdit intersects), typing writes the value to each, and the undo
// is one compound step. A plain click anywhere collapses back to one.
const outlines = new Map();    // id → BoxHelper for the non-primary ids (the primary keeps build.js's outline)
/** Find a painted field by its dispatch key (`ed:look.target`, `ch:pos.x`). */
function fieldByKey(fields, action) { return (fields ?? []).find((f) => f.k === action); }
/** Complete an armed ref pick: commit the target id into the waiting field.
 *  Returns true if a pick was pending and consumed. */
function completeRefPick(targetId) {
  if (!armingRef || !targetId || String(targetId).startsWith(OCC_ROW)) return false;
  const { id, key } = armingRef; armingRef = null;
  const what = key === 'parent.to' ? 'parent' : key.split('.').pop();
  if (targetId === id) { flashHint(key === 'parent.to' ? 'a thing can\'t be its own parent' : 'a thing can\'t reference itself', 3000); repaintAll(); return true; }
  const r = commitEdit(id, key, targetId);
  if (r.errors?.length) flashHint(r.errors.join(' · '), 5000);
  else flashHint(html`${what} → <b>${called(targetId)}</b>`, 3000);
  repaintAll();
  return true;
}
/** Every selected id, primary first, live things only. */
export function selection() {
  const s = Sel.selection();
  return s.kind === 'things' ? s.ids.filter((id) => entities.get(id)) : [];
}
/** Shift-click in the Hierarchy: every displayed row from the anchor (the last row clicked; else the active thing) to
 *  `id`, replacing the selection (Ctrl+Shift: added to it). The anchor stays where it is, so a second Shift-click re-ranges
 *  from it; the row clicked is active. false when there is no anchor among the displayed rows (the caller selects `id`). */
let hAnchor = null;
function rangeSelect(id, add) {
  const rows = visibleRows.filter((r) => entities.get(r));
  const from = [hAnchor, Sel.active()].find((a) => a != null && rows.includes(a) && Sel.isSelected(a));   // a stale anchor (since deselected) gives way
  const i = rows.indexOf(from), j = rows.indexOf(id);
  if (i < 0 || j < 0) { sceneSelect(id); hAnchor = id; return true; }
  const run = i <= j ? rows.slice(i, j + 1) : rows.slice(j, i + 1).reverse();   // the anchor first (the primary), the row clicked last
  Sel.set(add ? [...selection(), ...run.filter((r) => !Sel.isSelected(r))] : run, 'things', id);
  return true;
}
function extendSelection(id) {
  if (!entities.get(id)) return;
  Sel.toggle(id);   // taking the primary out promotes the next and keeps the rest, in one event
}
function syncOutlines() {
  const extra = new Set(selection().slice(1));
  for (const [id, h] of outlines) if (!extra.has(id)) { scene.remove(h); h.dispose?.(); outlines.delete(id); }
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
let behaviors = [];   // the world's scripts (the authority's status view, via world_debug {behaviors}): {id: "<thing>/<name>", attach, status, …}
/** The authority ops that remove one script: script:<name> on its thing, or an imported world's carried behaviour record. */
const unbindOps = (id) => { const s = String(id); const i = s.indexOf('/');
  return s.startsWith('imported-behavior:') ? [OP.unset('@world', s)] : i > 0 ? [OP.unset(s.slice(0, i), `script:${s.slice(i + 1)}`)] : []; };
const running = (b) => b.status === 'active' || b.status === 'asleep';
let shown = false;
let rosterTimer = 0;
async function refreshBehaviors() {
  try {
    const r = await requestDebug({ scripts: true });
    behaviors = (r?.events ?? []).filter((e) => e.kind === 'script');
    repaintAll();
  } catch { /* the roster is a refinement, never a gate */ }
}

function badgesFor(id) {
  const out = [];
  for (const [type, data] of compEntries(bagOf(id))) {
    if (type === 'lock' || type === 'hidden' || type === 'label') continue;   // lock has its glyph, label IS the row's name, hidden is added once below
    if (type === 'motion' || type.startsWith('motion:')) out.push(`${type}(${data?.type ?? '…'})`);
    else if (type === 'reactions') out.push(`${type}(${Object.keys(data ?? {}).join(',')})`);
    else if (type === 'socket') out.push(`socket(${data?.name ?? ''})`);
    else out.push(type);
  }
  for (const b of behaviors) if (b.attach === id) out.push(`📜${b.id}`);
  return out;
}

// ---------------------------------------------------------------- hierarchy
let claimsByOthers = {};   // id -> name, from build.js's drag claims (bus 'claims')
bus.on('claims', (c) => { claimsByOthers = c ?? {}; repaintAll(); });
function hierarchyFields() {
  // the tree is the FOLD's (shared/hierarchy.js): a child whose model is still
  // loading sits under its parent, not at the root; seated people show as rows
  const { occupants } = treeData();
  const world = state.st.entities ?? {};
  const sel = sceneSelected();
  const q = filter.trim().toLowerCase();
  // a socket's row is its name (a seat, a hook: kindHint says which), unless someone labelled it
  const nameOnly = (id) => { const c = bagOf(id); const l = c?.label; return typeof l === 'string' && l ? l : typeof c?.socket?.name === 'string' ? c.socket.name : null; };
  // R 10-17 (ID HARDENING 3): ids are hidden by default. A row is its label; an unlabelled one says what it is (its kind),
  // never its id ('show ids' adds the id). Siblings that read the same get a dim short handle, only those twins
  const shownName = (id) => nameOnly(id) ?? (kindHint(world[id]) || 'thing');
  const labelOf = (id) => { const l = shownName(id); return hopts.ids ? `${l}  (${id})` : l; };
  const twinOf = (() => { if (hopts.ids) return () => null; const all = Object.keys(world).filter((k) => k !== WORLD_ID); const groups = new Map();
    for (const k of all) { const key = `${world[k]?.parent?.to ?? ''}\u0000${shownName(k).trim().toLowerCase()}`; groups.set(key, (groups.get(key) ?? 0) + 1); }
    return (id) => (groups.get(`${world[id]?.parent?.to ?? ''}\u0000${shownName(id).trim().toLowerCase()}`) > 1 ? `#${handleOf(id, all)}` : null); })();
  const only = ONLY[hopts.only]?.test ?? null;
  const textHit = (id) => [id, world[id]?.label ?? '', world[id]?.model ?? '', world[id]?.model != null ? modelName(world[id].model) : '', kindHint(world[id]), ...Object.keys(recordComponents(world[id]))].join(' ').toLowerCase().includes(q);
  const matches = q || only ? (id) => (!q || textHit(id)) && (!only || only(id, world)) : null;
  // an occupant's or a component's row matches only where its thing passes the row filter too (review 10-12 S3-2)
  const underOk = (id) => !only || only(id, world);
  const occupantsOf = (id) => (occupants.get(id) ?? []).map((r) => ({ id: `${OCC_ROW}${r}`, match: (q ? r.toLowerCase().includes(q) : !only) && underOk(id) }));
  // with 'list components' on, a thing's components are greyed rows under it (they fold with it, like its children)
  const compsOfRow = (id) => (hopts.comps ? compKeys(bagOf(id)).filter((k) => k !== 'label').sort().map((k) => ({ id: `comp:${id}:${k}`, match: (q ? k.toLowerCase().includes(q) : !only) && underOk(id) })) : []);
  const underOf = (id) => [...occupantsOf(id), ...compsOfRow(id)];
  const rows = treeRows(world, { collapsed: { has: isFolded }, matches, extra: underOf }).map((t) => {
    if (t.extra && t.id.startsWith('comp:')) return { id: t.id, label: t.id.slice(t.id.lastIndexOf(':') + 1), depth: t.depth, noDrag: true, dim: true, title: `a component of ${t.id.slice(5, t.id.lastIndexOf(':'))}: click to select it` };
    if (t.extra) return { id: t.id, label: `🧍 ${t.id.slice(OCC_ROW.length)}`, depth: t.depth, noDrag: true };
    const id = t.id; const bag = bagOf(id) ?? {};
    const badges = hopts.kinds ? badgesFor(id) : [];   // what it carries (grabbable · physics) is 'show kinds'; state badges below always show
    const off = offIn(world, id);   // switched off (itself or above): not loaded, so not 'loading…'
    if (!entities.get(id) && !off) badges.unshift('loading…');
    if (bag.hidden === true) badges.push('hidden');
    if (claimsByOthers[id]) badges.push(`editing: ${claimsByOthers[id]}`);   // a live drag by someone else (build.js claims)
    { const tw = twinOf(id); if (tw) badges.unshift(tw); }   // a twin's short handle, dim, first (shared/thingref.js)
    const selfOff = world[id]?.disabled === true;
    if (off && !selfOff) badges.push('off (above)');   // its own box is ticked; what it hangs under is not
    const bpLink = world[id]?.['copy-of'];
    const sub = bpLink && typeof bpLink === 'object' ? `${kindHint(world[id])} · ${bpLink.hash ? `${bpLink.name ?? 'blueprint'} copy` : `part ${bpLink.part}`}` : kindHint(world[id]);
    // a child of a locked thing is held by that lock (the authority refuses moving it: "it rides X, which is locked"), so
    // its row says so instead of showing an open padlock (review 10-07 S3)
    let heldBy = null; for (let p = world[id]?.parent?.to, n = 0; p && n < 32 && !heldBy; p = world[p]?.parent?.to, n++) if (bagOf(p)?.lock) heldBy = p;
    // the row says the name; the rest is on hover (and in the row with 'show ids' / 'show kinds')
    const title = [nameOnly(id) ? `${nameOnly(id)}  (id ${id})` : `id ${id}`, sub].filter(Boolean).join(' — ');
    return { id, label: labelOf(id), ...(hopts.kinds ? { sub } : {}), title, depth: t.depth, active: id === sel, multi: id !== sel && Sel.isSelected(id), badges, locked: !!bag.lock, mine: isMineHidden(id),
      ...(bag.lock ? { lockLevel: lockLevelOf(bag.lock) } : {}), ...(heldBy && !bag.lock ? { heldBy, heldByLabel: labelOf(heldBy) } : {}),
      lockable: Edits.mayLift() && (!bag.lock || mayLiftLevel(id, bag.lock)),   // §5: only builders and owners lock and unlock; a lock above your rank isn't yours to lift
      enabled: !selfOff, ...(off ? { off: true } : {}),
      kids: t.kids, open: t.open, ...(t.dim ? { dim: true } : {}) };   // a filter looks inside folded nodes, so the glyph says open
  });
  for (const r of rows) {
    if (String(r.id).startsWith(OCC_ROW) || String(r.id).startsWith('comp:')) continue;
    const mounted = !!world[r.id]?.parent;
    const lab = bagOf(r.id)?.label;
    r.rename = typeof lab === 'string' ? lab : '';   // the label comp; empty = the row says what it is (its kind), never its id
    r.menu = [
      { k: 'rename', label: 'rename  (F2)' },
      { k: 'find', label: 'find  (F)' },
      { k: 'duplicate', label: 'duplicate  (Ctrl+D)', title: KEYHINTS.duplicate.before },
      { k: 'attach', label: arming === r.id ? 'cancel parent pick' : 'parent to…' },
      ...(mounted ? [{ k: 'detach', label: 'unparent' }] : []),
      ...(r.lockable === false ? [] : [{ k: 'lock', label: r.locked ? 'unlock' : 'lock in place' }]),
      { k: 'myhide', label: r.mine ? 'show in my view (only you)' : 'hide in my view (only you)' },
      { k: 'hide', label: bagOf(r.id)?.hidden === true ? 'make visible to everyone' : 'make invisible to everyone' },
      { k: 'off', label: world[r.id]?.disabled === true ? 'switch on' : 'switch off (for everyone)' },
      { k: 'remove', label: 'remove  (X)', danger: true },
    ];
  }
  visibleRows = rows.filter((r) => !String(r.id).startsWith(OCC_ROW) && !String(r.id).startsWith('comp:')).map((r) => r.id);
  return [
    { t: 'text', k: 'filter', label: '', value: filter, placeholder: 'filter — id, label, lib, component ⏎', hint: 'non-matches hide; a match keeps its ancestors' },
    // Options ▾ (R, 10-10: the 'View: ids' face was drawn twice and the list carried a search box and a 'recent'
    // group for three switches; Maya's Outliner calls its two menus Display and Show, which read as one thing: one menu here)
    // an active row filter says so on the bar: a filter nobody can see is the trap research 51 R3 names (review 10-12 S3-3)
    { t: 'pop', k: 'hopts', label: only ? `Options ▾ · ${ONLY[hopts.only].label}` : 'Options ▾', plain: true, deskOnly: true, bar: true, hint: 'what each row shows: names only, unless you turn more on',
      items: [...Object.keys(HOPTS).map((k) => ({ k: `hopt:${k}`, label: `${hopts[k] ? '✓' : ' '} ${HOPTS[k]}` })),
        ...Object.entries(ONLY).map(([k, o]) => ({ k: `honly:${k}`, label: `${(hopts.only ?? 'all') === k ? '✓' : ' '} ${o.label}` })),
        { k: 'fold:all-open', label: '  expand all' }, { k: 'fold:all-shut', label: '  collapse all' }] },
    // never lose track of what you hid (research 51 R3: Unity's eye confuses because nothing says it's on). On the Options
    // line, not a line of its own: appearing and vanishing with the first and last hidden thing, a line of its own pushed
    // every row down and back (R 10-11 01:00: "the scroll jumps up and if I click it again the scroll jumps down")
    ...(myHiddenCount() ? [{ t: 'btn', k: 'myshowall', label: `${myHiddenCount()} hidden in your view · show all`, bar: true, hint: 'things you hid with the eye: only your view, nobody else is affected' }] : []),
    // pinned: the world entity, the first row of the list itself and never filtered out (design §3). Below the filter
    // since R 10-11 ("move the 'world' in the Hierarchy under the filter line, just to make it more clear that you can
    // interact with it like an ordinary entity"): Blender's Outliner starts its tree with the Scene Collection the same way
    worldRowFields(),
    { t: 'tree', k: 'sel', rows, settle: enabledSettle, rootDrop: 'drop here: no parent', empty: q ? `nothing matches "${filter}"` : only ? `nothing ${ONLY[hopts.only].none}` : 'nothing placed yet — press B in the world to place things' },
  ];
}
function myHide(id) {
  const on = toggleMineHidden(id);
  flashHint(on ? html`${thingName(id)} hidden in <b>your</b> view only: not drawn, not clickable, still solid. Nobody else is affected` : `${thingName(id)} shown again`, 2400);
  repaintAll();
}
function hierarchyDispatch(action, payload, _field, opts = {}) {
  let sel = sceneSelected();
  switch (action) {
    case 'hopt:ids': case 'hopt:kinds': case 'hopt:comps': { const k = action.slice(5); hopts[k] = !hopts[k]; saveHopts(); repaintAll(); return; }
    case 'honly:all': case 'honly:off': case 'honly:mine': case 'honly:locked': { const k = action.slice(6); hopts.only = k === 'all' ? null : k; saveHopts(); repaintAll(); return; }
    case 'myhide': myHide(payload); return;
    case 'enable': { const id = payload?.id ?? payload; if (id) setEnabled(id, payload?.on ?? state.st.entities[id]?.disabled === true); return; }
    case 'myshowall': { const n = showAllMine(); flashHint(`${n} shown again`, 2000); repaintAll(); return; }
    case 'wsel': {   // the pinned World row, and its environment rows (env:<key>)
      if (arming || armingRef) { arming = null; armingRef = null; flashHint('the world is not a thing to point at — pick a thing; a drop on the root strip unparents', 4000); break; }
      const env = String(payload ?? '').startsWith('env:') ? String(payload).slice(4) : null;
      if (env) { const g = env === 'weather' ? 'weather' : env; if (!isOpen(WORLD_ID, g)) toggleFold(WORLD_ID, g); }
      selectWorld(env);
      if (env) requestAnimationFrame(() => document.querySelector(`#ew-inspector [data-group="${env}"], .sp-group[data-k="${env}"]`)?.scrollIntoView?.({ block: 'nearest' }));
      return;
    }
    case 'envdel': removeEnv(String(payload ?? '').slice(4)); return;   // ✕ on an environment row
    case 'sel': {
      if (String(payload).startsWith(OCC_ROW)) return;
      if (String(payload).startsWith('comp:')) payload = payload.slice(5, payload.lastIndexOf(':'));   // a component's row selects its thing
      if (armingRef && completeRefPick(payload)) break;   // a row click names a ref target
      if (arming && payload !== arming) { const child = arming; arming = null; reparent(child, payload); sceneSelect(child); break; }
      // R, gym 10-17 20:41: Shift selects the RANGE from the last row clicked to this one, in the rows as displayed (folded
      // branches and the filter respected); Ctrl/Cmd toggles one; a plain click selects one. Older callers send only `extend`
      if (opts.range && rangeSelect(payload, !!opts.toggle)) return;
      if (opts.toggle || (opts.extend && !opts.range)) { extendSelection(payload); hAnchor = payload; return; }
      sceneSelect(payload); hAnchor = payload;
      break;
    }
    case 'lock': toggleLock(payload); break;
    case 'rename': {   // an empty name clears the label: the row says what it is again
      const r = commitEdit(payload, 'flags.label', opts?.value ?? '');
      if (r.errors?.length) flashHint(r.errors.join(' · '), 5000);
      break;
    }
    // menu items act on the row they were opened on: select it first
    case 'find': if (payload && payload !== sel) sceneSelect(payload); findSelected(); break;
    case 'attach': {
      if (arming === payload) { arming = null; flashHint('attach cancelled', 3000); break; }
      arming = payload ?? sel;
      if (arming) { sceneSelect(arming); flashHint(html`now click <b>${arming}</b>'s new parent — a row here, or the thing itself in the world`, 5000); }
      break;
    }
    case 'detach': reparent(payload ?? sel, null); break;
    case 'remove': { const ids = payload && !Sel.isSelected(payload) ? [payload] : selection(); if (ids.length) removeMany(ids); break; }
    case 'drop': reparent(payload?.id, payload?.onto); break;
    case 'filter': filter = String(payload ?? ''); break;
    case 'open': { const id = typeof payload === 'object' ? payload?.id : payload, deep = typeof payload === 'object' && !!payload?.deep;
      const was = isFolded(id); for (const k of deep ? [id, ...descendantsOf(id)] : [id]) setFolded(k, !was); saveFolds(); break; }
    case 'fold:all-open': case 'fold:all-shut': { const shut = action.endsWith('shut'); for (const k of Object.keys(state.st.entities ?? {})) setFolded(k, shut); saveFolds(); repaintAll(); return; }
    case 'hide': { const id = payload ?? sel; if (id) commitEdit(id, 'flags.hidden', bagOf(id)?.hidden !== true); break; }
    case 'off': { const id = payload ?? sel; if (id) commitEdit(id, 'flags.disabled', state.st.entities[id]?.disabled !== true); break; }
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
// copies are independent: the second time you copy the same unlinked thing, say how to make copies that stay in step
// (R 10-04: "suggest that they blueprint something first… unless making unique copies is really their intention")
const dupCount = new Map();
function duplicate(id) {
  const rec = foldRecord(id); const obj = entities.get(id);
  if (!rec || !obj) return;
  const n = (dupCount.get(id) ?? 0) + 1; dupCount.set(id, n);
  const nudge = n === 2 && !rec?.['copy-of'] ? html` · copies are <b>independent</b>: for copies that stay in step, <b>Save as blueprint</b> and place them from Build ▸ Blueprints` : '';
  // the authority copies it, and what's attached to it: create {from: id}, one act
  Edits.duplicate(id).then((r) => { const nid = r.ok && r.refs?.[0]?.id; if (!nid) return;
    const out = Edits.idOut(nid); flashHint(html`<b>${called(out)}</b> — a copy of ${called(id)}${nudge}`, nudge ? 8000 : 4000); setTimeout(() => { if (entities.has(out)) sceneSelect(out); }, 400); });
}

// lock levels (R, 10-07): who may lift a lock is its level and up, or whoever set it (the authority decides; this only
// keeps the padlock honest about it)
const lockLevelOf = lockLevel;
const myRank = () => (Number.isFinite(net.myRights?.rank) ? net.myRights.rank : RANK[net.myRights?.role] ?? RANK.builder);
const lockerOf = (id) => authorityInspect(id)?.touched?.lock?.by ?? null;
const mayLiftLevel = (id, v) => myRank() >= lockRank(v) || (!!net.you && lockerOf(id) === net.you);
async function toggleLock(id) {
  const lk = bagOf(id)?.lock;
  if (!Edits.mayLift()) { flashHint('only builders and owners can lock or unlock things here'); return; }
  if (!lk) { Edits.lock(id, true); return; }
  // unlocking someone else's lock is a click-through, as moving a locked thing is: say whose it is and at what level
  const by = lockerOf(id), level = lockLevelOf(lk);
  if (by && by !== net.you) {
    const yes = await confirmCenter({ title: 'Unlock it?', body: `${Edits.nameOf(by)} locked this${level === 'builder' ? '' : ` at ${level} level`}. Unlocking lets anyone who may build here move or remove it; History shows who unlocked it.`, ok: 'Unlock', cancel: 'Keep it locked' });
    if (!yes) return;
  }
  Edits.lock(id, false);
}
function findSelected() {
  const sel = sceneSelected(); const obj = entities.get(sel); if (!obj) return;
  const p = obj.getWorldPosition(_wp);
  // F frames it (Maya, Blender's numpad .): the edit camera centres on its bounds
  const box = new THREE.Box3().setFromObject(obj), c = box.isEmpty() ? p.clone() : box.getCenter(new THREE.Vector3()), r = box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length() / 2;
  frameOn(c, r);
  flashHint(html`<b>${sel}</b> is ${p.distanceTo(myState.pos).toFixed(0)}m away at (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`, 5000);
}

/** Reset the selection's transform to its defaults (R, 10-10, after Rhythm and Hues' `g`): 'pos' → translate 0,
 *  'rot' → rotate 0, 'scale' → scale 1, 'all' → the three. The keys follow the tools': G move, E rotate, R scale, so
 *  Alt+G / Alt+E / Alt+R; Ctrl+G is all of it. One request per thing, so one Ctrl+Z each. */
const RESET = { pos: { 'pos.x': 0, 'pos.y': 0, 'pos.z': 0 }, rot: { 'rot.x': 0, 'rot.y': 0, 'rot.z': 0 }, scale: { 'pos.sx': 1, 'pos.sy': 1, 'pos.sz': 1 } };
function resetTransform(what) {
  const ids = selection(); if (!ids.length) { flashHint('select something first: Alt+G resets its translate, Alt+E rotate, Alt+R scale, Ctrl+G all three', 3500); return; }
  const want = what === 'all' ? { ...RESET.pos, ...RESET.rot, ...RESET.scale } : RESET[what]; if (!want) return;
  for (const id of ids) {
    // only the channels this thing has (quaternion order has no rotate x/y/z)
    const have = new Set(channels(schemaFor(id)).map((c) => c.key)); const edits = Object.fromEntries(Object.entries(want).filter(([k]) => have.has(k)));
    if (Object.keys(edits).length) commitMany(id, edits, what === 'all' ? 'transform reset' : `${{ pos: 'translate', rot: 'rotate', scale: 'scale' }[what]} reset`);
  }
  flashHint(`${what === 'all' ? 'transform' : { pos: 'translate', rot: 'rotate', scale: 'scale' }[what]} reset${ids.length > 1 ? ` on ${ids.length} things` : ''} — Ctrl+Z undoes`, 2200);
}

// ---------------------------------------------------------------- inspector
let painted = [];      // the inspector's last field list (a canvas stepper's delta resolves against it)
let gesture = null;    // { before } while a transform drag is in flight (the local preview's start pose)

/** Is a whole-entity motion composing onto this thing's rest pose? */
function drivenBy(id, obj) {
  if (obj?.userData?.mountedTo) return null;
  const m = bagOf(id)?.motion;
  return m?.type && !m.part ? 'motion' : null;
}
/** The pose `place` edits — the FOLD's, which is the rest pose by definition. */
function restPose(id, obj) {
  const rec = foldRecord(id);
  return rec
    ? { pos: (rec.pos ?? [0, 0, 0]).map((v) => round(v)), yaw: round(rec.yaw ?? 0, 4), scale: round(rec.scale ?? 1) }
    : { pos: [round(obj.position.x), round(obj.position.y), round(obj.position.z)], yaw: round(obj.rotation.y, 4), scale: round(obj.scale?.x ?? 1) };
}

/** Godot's MultiNodeEdit, Unity's multi-object editing: the channels EVERY selected thing has, the ACTIVE one's value
 *  shown and '—' where they differ (Unity's convention; R, gym 10-17 20:39); flags intersect the same way. The top line
 *  is the active (last-clicked) thing's name line, '<name> #<handle> + N more': the single Inspector's handle; hovering
 *  '+ N more' names the others (never a raw id). */
function multiFields(ids) {
  const act = ids.includes(Sel.active()) ? Sel.active() : ids[0];
  const order = [act, ...ids.filter((x) => x !== act)];   // the active one's values lead
  const schemas = order.map((id) => schemaFor(id));
  const chans = schemas.map((sc) => new Map(channels(sc).map((c) => [c.key, c])));
  const others = order.slice(1).map(thingName);
  const f = [
    { t: 'info', label: '', vrLabel: 'selection', value: thingName(act), bar: true, cls: 'sp-title' }, idHandleRow(act),
    { t: 'info', label: '', value: `+ ${ids.length - 1} more`, bar: true, cls: 'sp-more', hint: `also selected: ${others.join(', ')}` },
    { t: 'info', label: '', value: 'typing sets every one · Ctrl-click to drop one · one undo' },
  ];
  f.push({ t: 'group', k: 'channels', label: 'Channels (shared)', open: true });
  for (const c of chans[0].values()) {
    const all = chans.map((m) => m.get(c.key)).filter(Boolean);
    if (all.length !== ids.length) continue;
    const mixed = all.some((x) => Math.abs(x.value - c.value) > 1e-9);
    f.push({ ...c, k: `ch:${c.key}`, label: c.group === 'pos' ? c.label : `${c.group} · ${c.label ?? c.k}`, compact: true, mixed,
      disabled: all.some((x) => x.disabled), driven: undefined, hint: mixed ? '— : it differs across the selection; typing sets every one' : c.hint });
  }
  f.push({ t: 'group', k: 'flags', label: 'Flags', open: true });
  for (const k of ['lock', 'hidden']) {
    const vals = ids.map((id) => bagOf(id)?.[k] === true);
    const on = vals.every(Boolean), mixed = vals.some(Boolean) && !on;
    f.push({ t: 'check', k: `ed:flags.${k}`, label: k === 'lock' ? 'locked in place' : 'hidden', value: on, mixed, hint: mixed ? '— : some are, some aren\'t; checking sets every one' : undefined });
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
function pushCards(f, schema, id, opts = {}) {
  const { locked = false, afterTransform = [], away = null } = opts;
  const touched = id !== WORLD_ID ? authorityInspect(id)?.touched ?? {} : {};
  for (const sec of schema.sections.list) {
    if (sec.type === 'Parent' && !opts.withParent) continue;   // R 10-10: parenting is the Hierarchy's (and Attributes')
    const key = `c:${sec.key ?? sec.type}`;
    const prov = sec.present !== false ? touchLine(touched[wireOf(sec)]) : null;
    const acts = sec.removable && sec.key ? [{ k: `ed:remove.${sec.key}`, icon: 'x', title: `remove ${sec.title}`, danger: true }] : [];
    // provenance (R 10-10: 'a colored dot'): amber = a draft this client reads (docs/COMPONENT-LADDER.md), hollow = a
    // namespaced component nothing here reads; a core component has none
    const dot = sec.trusted ? 'trusted' : sec.draft ? 'draft' : (sec.key && String(sec.key).includes('/') ? 'foreign' : null);
    f.push({ t: 'group', k: key, actions: acts, ...(dot ? { dot } : {}), label: `${sec.title}${locked && sec.type === 'Transform' ? ' 🔒' : ''}${sec.present === false ? (sec.type === 'Parent' ? ' · none' : ' · default') : ''}`, ...(away && sec.type === 'Transform' ? away : {}), hint: `${prov ? `${prov}\n` : ''}${sec.summary} — ${sec.category} · engine record ${(sec.hash ?? 'draft').slice(0, 12)}${sec.status ? ` · ${sec.status}${sec.status === 'trial' ? ' (its shape may change during the alpha)' : ''}` : ''}${sec.part ? ` · part: ${sec.part}` : ''}`, open: isOpen(id, key), ...(prov ? { prov } : {}) });
    for (const [label, value] of sec.info ?? []) f.push({ t: 'info', label, value });
    // the channel box: an alias (pos.yaw, the heading) stays addressable for
    // agents but is not drawn; the Quaternion row folds under its own header,
    // closed unless the entity is in quaternion mode (then it IS the rotation)
    const quat = [];
    for (const addr of sec.fields) {
      const r = cardRow(schema, id, addr); if (!r || r.alias) continue;
      if (r.row === 'quat' || addr === 'rot.order') quat.push(r); else f.push(r);   // R, 10-04: rarely needed until rigs
    }
    // groups are FLAT markers (renderDOM, the VR quad): a sub-header reopens
    // its rows even under a folded card, so a folded Transform omits it. A
    // filter is the exception: filterFields opens whatever holds a hit.
    // R 10-10 23:38: 'Remember to move the Advanced component stuff into Attributes': rotation order and the stored
    // quaternion live in the Attributes tab now; only a thing in quaternion mode (where they ARE its rotation) keeps them here
    if (quat.length && sec.quatOpen && (isOpen(id, key) || ifilter.trim())) {
      const qk = `${key}:quat`;
      f.push({ t: 'group', k: qk, label: 'Advanced', hint: 'rotation order and the quaternion (the rotation as it is stored: four numbers that never gimbal-lock) — rarely needed until rigs', open: sec.quatOpen ? isOpen(id, qk) : !isOpen(id, qk) });
      f.push(...quat);
    }
    if (sec.removable && sec.key) f.push({ t: 'btn', k: `ed:remove.${sec.key}`, label: `remove ${sec.title}`, danger: true, vrOnly: true });   // desktop: the ✕ on the title line
    // R 10-10: Add Component and New Script sit right under Transform (Blender's Add Modifier), not at the foot of a long list
    if (sec.type === 'Transform' && afterTransform.length) f.push(...afterTransform);
  }
}

/** The world entity in the Inspector: a header, then its Sky / Weather /
 *  Terrain / Grass cards from shared/worldentity.js — edited through the sky,
 *  weather, terrain and grass verbs (inspect.js commitEdit routes @world). */
function worldFields() {
  const schema = schemaFor(WORLD_ID);
  const f = [
    { t: 'info', label: 'name', value: worldName(), hint: 'the world itself: its sky, weather, ground and grass are its components' },
    { t: 'info', label: 'id', value: WORLD_ID, dim: true, hint: 'the world entity\'s permanent id: agents and scripts name it @world' },
  ];
  if (mayShape() === false) f.push({ t: 'info', label: '', value: 'shaping the world is the owner\'s — read-only for you' });
  pushCards(f, schema, WORLD_ID);
  // no terrain yet: the card's only row pointed elsewhere (review 10-07 S15). Put Build ▸ World's ground shapes in it
  if (!state.st.terrain) {
    const at = f.findIndex((x) => x.t === 'info' && /no terrain authored/.test(String(x.value ?? '')));
    const shapes = Object.keys(groundPal?.shapes ?? {}).filter((k) => k !== 'doc');
    if (at >= 0 && shapes.length) f.splice(at + 1, 0, { t: 'tiles', k: 'wshape', value: null, options: shapes.map((n) => ({ v: n, label: n, hint: `${groundPal.shapes[n]} m of relief` })), ...(mayShape() === false ? { disabled: true } : {}) });
    if (at >= 0) f[at] = { ...f[at], value: 'no terrain authored: the default flat ground. Pick a shape:' };
  }
  const shown = filterFields(f, ifilter);
  painted = shown;
  return shown;
}

// who made it: no thing stores it (L2: a view over the log, never stored), so ask the authority once per thing, the same `inspect` an agent uses (derived.madeBy), and repaint when it answers
// the authority's inspect, per thing, re-asked whenever its components change (the key): who made it, and who last changed
// each component and when (touched: R 10-04, "where a value came from"; within a recent window, beyond = older)
const inspectCache = new Map();
function authorityInspect(id) {
  const key = JSON.stringify(Edits.compsOf(id));
  const c = inspectCache.get(id);
  if (c?.key === key) return c.reply;
  inspectCache.set(id, { key, reply: c?.reply ?? null });   // keep showing the last answer while the new one comes
  sendRequest('inspect', { id }).then((r) => { if (inspectCache.get(id)?.key === key && r?.ok) { inspectCache.set(id, { key, reply: r }); repaintAll(); } }).catch(() => inspectCache.delete(id));
  return c?.reply ?? null;
}
function placedBy(id) {
  const r = authorityInspect(id);
  return r ? (r.derived?.madeBy ? Edits.nameOf(r.derived.madeBy) : 'unknown') : '…';
}
// a card's component name: keyed sections carry it; the core ones (Transform, built from the record) go by their type
const wireOf = (sec) => sec.key ?? sec.type.toLowerCase();
const ago = (ts) => agoWords(ts);
const touchLine = (t) => touchWords(t);
function lastChange(id) {
  const t = Object.entries(authorityInspect(id)?.touched ?? {}).filter(([, v]) => v.by).sort((a, b) => b[1].seq - a[1].seq)[0];
  if (!t) return null;
  const [comp, v] = t; const sec = schemaFor(id)?.sections?.list?.find((x) => wireOf(x) === comp);
  return v.created ? `made by ${Edits.nameOf(v.by)} · ${ago(v.ts)}` : `${Edits.nameOf(v.by)} · ${sec?.title ?? comp} · ${ago(v.ts)}`;
}

const thingName = (id) => { const l = bagOf(id)?.label; return typeof l === 'string' && l ? l : (kindHint(state.st.entities?.[id]) || 'thing'); };   // never the id (R 10-17)
/** The ENABLED box that leads every thing's Inspector header (Unity's and Resonite's convention; R 10-12): ticked = on.
 *  It is the `disabled` component (5d5eef5c) read the other way round, so it is there whether the thing is on or off. */
const enabledBox = (id) => { const on = state.st.entities[id]?.disabled !== true;
  const words = on ? 'Enabled. Untick to switch it off for everyone: it stays in the Hierarchy, but nobody downloads, sees or touches it, and it has no physics (what hangs under it goes with it).'
    : 'Switched off for everyone: nobody downloads, sees or touches it. Tick to switch it back on.';
  return { t: 'check', k: 'henabled', label: '', vrLabel: 'enabled', value: on, settle: enabledSettle, bar: true, cls: 'sp-enabled', path: 'flags.disabled',
    hint: withKeys(words, 'toggleEnabled') }; };
let lastAway = null;   // { id, m }: the distance the Inspector's Transform title last showed (its ticker repaints on a change)
/** the thing's short handle (shared/thingref.js handleOf over every id but the world's, exactly as the Hierarchy's twins) */
const idHandle = (id) => handleOf(id, Object.keys(state.st.entities ?? {}).filter((k) => k !== WORLD_ID));
/** the name line's dim #handle: the id agents and the log use; clicking copies the full id */
const idHandleRow = (id) => ({ t: 'btn', k: 'copyid', label: `#${idHandle(id)}`, bar: true, deskOnly: true, cls: 'sp-iconbtn sp-handle',
  hint: `#${idHandle(id)} is its id (${id}), the one agents and the log use. It is permanent, minted by the world, and can't be renamed: the name is its label. Click to copy the full id.` });
function inspectorFields() {
  if (worldSel()) return worldFields();
  const id = sceneSelected();
  if (!id || (!entities.has(id) && !offIn(state.st.entities, id))) return [{ t: 'info', label: 'selection', value: 'nothing selected — click a thing, a row in the hierarchy, or World for the sky and ground' }];
  const ids = selection();
  if (ids.length > 1) return multiFields(ids);
  const obj = entities.get(id); const bag = bagOf(id) ?? {};
  // the fold knows the thing before its model arrives: entities holds null
  // while the GLB loads (scenegraph guards the same seam)
  const schema = schemaFor(id);           // ONE declaration: shared/editschema.js
  // R 10-17 20:30: no show-id button (awkward, under the attributes); the name line carries the thing's short handle, dim,
  // after the name: the same #handle the Hierarchy shows twins by and agents use (computed over every id, as hierarchyFields
  // does, so the two agree). Click it to copy the full id.
  const handleRow = idHandleRow(id);
  if (!obj && offIn(state.st.entities, id)) {   // switched off: nothing loaded, so no transform to show; the way back on
    const self = state.st.entities[id]?.disabled === true; let up = id; if (!self) for (let k = state.st.entities[id]?.parent?.to; k; k = state.st.entities[k]?.parent?.to) if (state.st.entities[k]?.disabled === true) { up = k; break; }
    return [enabledBox(id), { t: 'info', label: '', vrLabel: 'name', value: thingName(id), bar: true, cls: 'sp-title' }, handleRow,
      { t: 'info', label: 'state', value: self ? 'switched off: nobody downloads, sees or touches it' : `switched off with ${thingName(up)}, which it hangs under` },
      ...(self ? [] : [{ t: 'btn', k: `selup:${up}`, label: `select ${thingName(up)}` }])]; }
  if (!obj) return [{ t: 'info', label: 'state', value: 'loading…', hint: 'its model is still downloading' }];
  const locked = !!bag.lock;
  // R 10-17 20:34: no 'world' row; how far it is rides the Transform card's title line, dim ('Transform · 12 m away'),
  // its world coordinates on that line's tooltip. The ticker below repaints it as you move.
  const wp = obj.getWorldPosition(_wp); const awayM = Math.round(wp.distanceTo(myState.pos)); lastAway = { id, m: awayM };
  const away = { sub: `${awayM} m away`, subHint: `${awayM} m from you; in the world at (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)}, ${wp.z.toFixed(1)})` };

  const f = [
    { t: 'info', label: 'placed by', value: placedBy(id), hint: 'who first made it' },
  ];

  // B: one card per component (shared/components.js via schema.sections), each
  // owning its fields by their unchanged group.k address, then Add Component.
  if (schema.sections) {
    // the name leads (Unity's name box), the id under it; the rest of the header after the facts
    // THE NAME LINE (R 10-10 23:48: "make the 'name' attribute be like Maya, where it just kinda looks like a normal inline
    // title? The eye and lock and disable icons can be on this line to the right"): the name as a title, then the eye
    // (hidden in MY view only; the Hierarchy's eye is the same switch) and the padlock. 'disable' waits on its rules.
    let nameRow = null;
    for (const a of schema.sections.header ?? []) { const r = cardRow(schema, id, a); if (r && !a.startsWith('parent.') && a !== 'flags.hidden' && a !== 'flags.disabled') { if (a === 'flags.label') nameRow = r; else f.push(r); } }   // flags.disabled: the ENABLED box leads the header (one switch, one place)
    { const mine = isMineHidden(id), lk = bagOf(id)?.lock;
      const line = [
        enabledBox(id),
        ...(nameRow ? [{ ...nameRow, label: '', bar: true, cls: 'sp-title', placeholder: 'name it', vrLabel: 'name' }, handleRow] : []),
        { t: 'btn', k: 'myhide', icon: mine ? 'eyeOff' : 'eye', label: '', on: mine, bar: true, deskOnly: true, cls: 'sp-iconbtn sp-mine',
          hint: mine ? 'Only you: hidden in YOUR view (not drawn, not clickable, still solid). Everyone else still sees it. Click to show it again.' : 'Only you: hide it in YOUR view. Nobody else is affected (the eye in the Hierarchy is the same switch).' },
        { t: 'btn', k: 'hlock', icon: lk ? 'lock' : 'lockOpen', label: '', on: !!lk, bar: true, deskOnly: true, cls: 'sp-iconbtn',
          hint: lk ? 'Locked: nobody moves, replaces or removes it until it is unlocked. Click to unlock.' : 'Lock it: nobody moves, replaces or removes it until it is unlocked (sitting on it and content edits stay open).' },
      ];
      f.unshift(...line); }   // parenting is the Hierarchy's job (R, 10-04); agents keep parent.* in edit
    if (pendingAsk?.id === id) {
      const q = pendingAsk.ask;
      f.push({ t: 'group', k: 'c:ask', label: q.kind === 'confirm' ? `Remove ${q.type}?` : `${q.component} needs a choice`, open: true });
      f.push({ t: 'info', label: '', value: q.prompt });
      if (q.kind === 'confirm') f.push({ t: 'btn', k: 'ask:both', label: `remove ${[...q.dependants.map((d) => d.type), q.type].join(' and ')}`, danger: true });
      else for (const o of q.options) f.push({ t: 'btn', k: `ask:${o.v}`, label: o.label });
      f.push({ t: 'btn', k: 'ask:cancel', label: 'cancel' });
    }
    const adds = [];
    if (schema.sections.add.length) {
      // desktop: ONE button that opens a searchable list (R, 10-04); the VR quad keeps the flat rows below
      const keyOf = (a) => ({ Picture: 'ed:comp.add:picture', Sound: 'ed:comp.add:sound', Sockets: 'ed:sockets.add' }[a.name] ?? `ed:add.${a.name}`);
      adds.push({ t: 'pop', k: 'c:+pop', label: 'Add Component…', icon: 'plus', cls: 'sp-add', deskOnly: true, unfold: true, bar: true, recentKey: 'components', hint: 'add a light, motion, sound, collider…',
        items: schema.sections.add.map((a) => ({ k: keyOf(a), label: `${a.label ?? a.name}${a.asks ? '…' : ''}`, category: a.category, disabled: !!a.blocked, keywords: ADD_WORDS[a.name] ?? [], ...(a.chip ? { chip: a.chip } : {}),
          hint: a.blocked ?? (a.hint ? `${a.summary} — ${a.hint}` : a.brings ? `${a.summary} — also adds ${a.brings}, in the same undo step` : a.asks ? `${a.summary} — needs a ${a.asks}: asks first` : a.summary) })) });
      adds.push({ t: 'group', k: 'c:+', label: 'Add Component', open: isOpen(id, 'c:+'), vrOnly: true });
      for (const cat of [...new Set(schema.sections.add.map((a) => a.category))]) {
        adds.push({ t: 'info', label: '', value: cat });
        for (const a of schema.sections.add.filter((x) => x.category === cat)) {
          const viaGesture = { Picture: 'ed:comp.add:picture', Sound: 'ed:comp.add:sound', Sockets: 'ed:sockets.add' }[a.name];
          adds.push({ t: 'btn', k: viaGesture ?? `ed:add.${a.name}`, label: `+ ${a.label ?? a.name}${a.brings ? ' (+ its need)' : a.asks ? '…' : a.chip === 'amber' ? ' (draft)' : a.chip === 'blue' ? ' (trusted here)' : ''}`, disabled: !!a.blocked,
            hint: a.blocked ?? (a.hint ? `${a.summary} — ${a.hint}` : a.brings ? `${a.summary} — also adds ${a.brings}, in the same undo step` : a.asks ? `${a.summary} — needs a ${a.asks}: asks first` : a.summary) });
        }
      }
    }
    // the new-script button goes after the desktop's Add Component, BEFORE the VR-only Add Component group (a row after
    // that group's header would fold into it)
    if (id !== WORLD_ID) { const at = adds.findIndex((r) => r.vrOnly && r.t === 'group'); adds.splice(at < 0 ? adds.length : at, 0, { t: 'btn', k: 'newscript', label: 'Add Script…', icon: 'scrollText', cls: 'sp-add', deskOnly: true, unfold: true, bar: true, disabled: !mayScript(),
      hint: mayScript() ? 'write a script that runs when someone uses this, or on a timer' : 'making scripts needs the scripts switch (the owner gives it)' }); }
    pushCards(f, schema, id, { locked, afterTransform: adds, away });
    // the foot of the cards: the latest change to this thing, in one line (research 56: history lives beside the
    // Inspector, not in it; this line is the doorway)
    const lc = lastChange(id);
    if (lc) f.push({ t: 'btn', k: 'history', label: `last change: ${lc} — History ›`, hint: 'the most recent change to this thing, from the world log. History lists them all, newest first; each card\'s tooltip says who last set it' });
  } else {
  // CHANNELS — the numeric lane: every num in the schema, transform first
  f.push({ t: 'group', k: 'channels', label: `Channels${locked ? ' 🔒' : ''}${obj.userData.mountedTo ? ' (mounted)' : ''}`, open: isOpen(id, 'channels') });
  for (const c of channels(schema)) {
    f.push({ ...c, k: `ch:${c.key}`, path: c.key, label: c.group === 'pos' ? c.label : `${c.group} · ${c.label ?? c.k}`, compact: true });
  }

  // GROUPS — flags, then every component group the schema declares, then the
  // raw-JSON floor for types no group speaks for, then scripts
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
  // Scripts: the ones on this thing, and (desktop: it's a card with a source box) a new one (scriptnew.js: upload, then
  // one act). Its own group, so it never folds under the VR-only Add Component rows above.
  // the new-script button sits under Transform with Add Component; this card lists the scripts there are
  const scriptsUp = !!schema.sections && id !== WORLD_ID;
  if (mine.length || (id !== WORLD_ID && !scriptsUp)) f.push({ t: 'group', k: 'behaviors', label: mine.length ? `Scripts (${mine.length})` : 'Scripts', open: isOpen(id, 'behaviors') });
  if (mine.length) f.push({ t: 'list', k: 'scripts', rows: mine.map((b) => ({ id: b.id, label: `${running(b) ? '▶' : '⏸'} ${b.id}`, sub: `${b.timers ? `${b.timers}⏲ ` : ''}${b.status ?? ''}`, actions: [{ k: 'unbind', label: 'remove', danger: true }] })) });
  if (id !== WORLD_ID && !scriptsUp) f.push({ t: 'btn', k: 'newscript', label: 'new script…', icon: 'scrollText', deskOnly: true, disabled: !mayScript(),
    hint: mayScript() ? 'write a script that runs when someone uses this, or on a timer' : 'making scripts needs the scripts switch (the owner gives it)' });
  f.push({ t: 'btn', k: 'remove', label: 'remove', danger: true, vrOnly: true });   // desktop removes with Del / Backspace / X / right-click / Edit ▸ delete; a headset has no keys
  const shown = filterFields(f, ifilter);
  painted = shown;
  return shown;
}

// bumped when a switch has its answer: the ENABLED boxes drop the click they were holding and show the record
let enabledSettle = 0;
function setEnabled(id, on) {
  if ((state.st.entities[id]?.disabled !== true) === on) { enabledSettle++; repaintAll(); return; }
  const r = commitEdit(id, 'flags.disabled', !on);
  if (r?.errors?.length) { flashHint(r.errors.join(' · '), 5000, 'attn'); enabledSettle++; repaintAll(); return; }
  // the hint waits for the authority: a refusal says its own words (editwrites), and the boxes go back to the record
  Promise.resolve(r?.reply).then((x) => {
    if (x?.ok) flashHint(on ? `${thingName(id)} switched back on` : `${thingName(id)} switched off for everyone (Ctrl+Z switches it back on)`, 2600);
  }).finally(() => { enabledSettle++; repaintAll(); });
}
function inspectorDispatch(action, payload, field, opts = {}) {
  const id = worldSel() ? WORLD_ID : sceneSelected(); const obj = entities.get(id);
  if (action === 'fold') { toggleFold(id, payload); repaintAll(); return; }
  // a scrubbed RUN of channels (Maya's channel box): one edit for all of them, FACE values, one Ctrl+Z (panels.js commitRun)
  if (action === '__run' && id && id !== WORLD_ID && payload && typeof payload === 'object') {
    const edits = Object.fromEntries(Object.entries(payload).map(([k, v]) => [String(k).replace(/^(ch|ed):/, ''), v]));
    const r = commitMany(id, edits, 'channels'); endGesture(); if (r.errors?.length) flashHint(r.errors.join(' · '), 5000, 'attn'); repaintAll(); return; }
  if (action === 'history') { bus.emit('edit-righttab', 'history'); return; }
  if (action === 'goto') {   // a driven field's ~: open the driver's card and bring it into view
    const g = `c:${payload}`; if (!isOpen(id, g)) toggleFold(id, g);
    repaintAll();
    const title = schemaFor(id)?.sections?.list?.find((x) => wireOf(x) === payload)?.title ?? String(payload);   // found by component, not by words
    requestAnimationFrame(() => {
      const h = [...document.querySelectorAll('[data-frame="inspector"] .sp-group')].find((b) => b.textContent.replace(/^[▸▾]\s*/, '').trim().startsWith(title));
      if (h) { h.scrollIntoView({ block: 'center' }); h.classList.add('sp-flash'); setTimeout(() => h.classList.remove('sp-flash'), 900); } });
    return;
  }
  if (action === 'ifilter') { ifilter = String(payload ?? ''); repaintAll(); return; }
  if (action === 'hlock' && id && id !== WORLD_ID) { commitEdit(id, 'flags.lock', !bagOf(id)?.lock); return; }
  if (action.startsWith('selup:')) { sceneSelect(action.slice(6)); return; }
  if (action === 'henabled' && id && id !== WORLD_ID) { setEnabled(id, payload !== false); return; }
  if (action === 'myhide' && id && id !== WORLD_ID) { myHide(id); return; }
  if (action === 'copyid' && id) { const cid = selection().includes(Sel.active()) ? Sel.active() : id;   // the name line's thing: the active one when several are selected
    try { void navigator.clipboard?.writeText(String(cid)); flashHint(`copied its id: ${cid}`); } catch { /* no clipboard: the tooltip shows it */ } return; }
  if (action === 'ed:grabbable.gripedit') { openGripEditor(id); return; }
  if (action === 'ed:home.sethere') { void Edits.setHomeHere([id]); return; }   // the Home card's button: where it is now (editwrites)   // the grip editor (gripedit.js)
  if (id === WORLD_ID && WORLD_PICKS[action]) { pickWorld(action, payload); repaintAll(); return; }   // the Terrain card's shape tiles (S15)
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
      else { armingRef = { id, key }; flashHint(key === 'parent.to' ? html`now click <b>${called(id)}</b>'s new parent — a row here, or the thing itself in the world` : html`now click <b>${key.split('.').pop()}</b>'s target — a row here, or the thing itself in the world`, 5000); }
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
      // every selected thing's change in ONE request (a batch): one act, one Ctrl+Z
      const ops = [], errors = [];
      for (const each of ids) { const plan = planEdit(each, key, v); errors.push(...plan.errors); ops.push(...plan.ops); }
      if (ops.length) Edits.sendOps(ops, { what: `${key} on ${ids.length} things`, revert: () => ids.forEach((x) => Edits.revertPose(x)) });
      if (errors.length) flashHint(errors.join(' · '), 5000);
      repaintAll();
    }
    return;
  }

  // transform channels: preview locally while dragging (no log traffic), one
  // whole transform on release, carrying the pose the channels show
  if (/^ch:pos\.(x|y|z|yaw|scale)$/.test(action)) {
    const k = action.slice(7);
    const driven = drivenBy(id, obj);
    const before = gesture?.before ?? restPose(id, obj);
    // from the pose the channels SHOW (a run scrubs several at once: each channel's preview keeps the others', and the
    // leader's release carries them all; R 10-11 23:13: "scrubbing on then only affects one still")
    const shown = gesture?.cur ?? before;
    const next = { ...shown, pos: [...shown.pos] };
    const val = (cur) => (typeof payload === 'object' && payload && 'delta' in payload ? cur + payload.delta : payload);
    if (k === 'yaw') next.yaw = round(val(before.yaw), 4);
    else if (k === 'scale') next.scale = Math.max(0.01, round(val(before.scale)));
    else next.pos['xyz'.indexOf(k)] = round(val(before.pos['xyz'.indexOf(k)]));
    if (next.pos.some(Number.isNaN)) return;
    if (live) {
      // a live call back AT the start pose is a cancelled/no-op drag ending
      if (JSON.stringify(next) === JSON.stringify(before)) gesture = null; else { gesture ??= { before }; gesture.cur = next; }
      if (!driven) {   // a driven thing can't preview: the motion owns the frame
        obj.position.set(...next.pos); obj.rotation.y = next.yaw; obj.scale.setScalar(next.scale);
        reindexCollider(id); refreshOutline();
      }
      return;
    }
    gesture = null;
    if (JSON.stringify(next) === JSON.stringify(before)) return;
    // the whole transform (local for a child): a heading turns it about up keeping its tilt; scale sets all three axes
    const patch = { pos: next.pos, ...(k === 'yaw' ? { yaw: next.yaw } : {}), ...(k === 'scale' ? { scale: next.scale } : {}) };
    Edits.sendOps([OP.setTransform(foldRecord(id), id, patch)], { what: `move ${id}`, revert: () => Edits.revertPose(id) });
    repaintAll();
    return;
  }
  // Add Component › Text on a model: a sign on its front face, its own child (facemedia.js, review 10-07 S4)
  if (action === 'ed:add.Text' && !live && frontOf(id)) { addOnFace(id, 'text', { text: 'Hello' }); repaintAll(); return; }
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
    case 'unbind': Edits.sendOps(unbindOps(payload), { what: `remove ${payload}`, expect: false }); setTimeout(refreshBehaviors, 400); break;
    case 'scripts': watchScript(payload); break;   // a script row → the Console, watching it
    case 'newscript': openNewScript(id).then(async (r) => { if (!r.ok) return; await refreshBehaviors(); watchScript(`${r.id}/${r.name}`);
      flashHint(html`script <b>${r.name}</b> is on ${called(r.id)}${r.action ? ` — use it (${r.action}) to run it` : ''}; its log is in the Console`, 5000); }); break;
    default: if (action.startsWith('uncomp:')) commitEdit(id, `comp.${action.slice(7)}`, null);
  }
  repaintAll();
}

// ---------------------------------------------------------------- console
// The behavior runtime made visible (the legacy World panel's 📜 scripts): every
// script bound in this world, and one script's live console.log() ring, polled
// while the frame is open. Agents read the same thing through world_debug.
let watching = null;           // behavior id whose log is open
let watchLog = null;           // { status, lines } from the last poll
async function refreshWatch() {
  if (!watching) { watchLog = null; return; }
  try {
    const d = await requestDebug({ script: watching, limit: 40 });
    watchLog = { status: d?.status ?? '?', lines: (d?.events ?? []).map((e) => `${new Date(e.ts).toTimeString().slice(0, 8)}  ${e.line}`) };
  } catch { /* a poll that fails keeps the last good tail */ }
}
function consoleFields() {
  const f = [{ t: 'list', k: 'cwatch', empty: 'no scripts in this world — a script is a script:<name> component on a thing (docs/SCRIPTS-replica.md)',
    rows: behaviors.map((b) => ({ id: b.id, label: `${running(b) ? '▶' : '⏸'} ${b.id}`,
      sub: [b.attach ? `on ${b.attach}` : 'world', b.timers ? `${b.timers}⏲` : null, !running(b) ? (b.status ?? 'paused') : null].filter(Boolean).join(' · '),
      active: b.id === watching,
      actions: [...(b.attach ? [{ k: 'cgoto', label: 'select' }] : []), { k: 'unbind', label: 'remove', danger: true }] })) }];
  if (watching) {
    f.push({ t: 'group', k: 'clog', label: `${watching} — ${watchLog?.status ?? '…'}`, open: true });
    f.push({ t: 'log', k: 'clines', lines: watchLog?.lines ?? [], empty: '(console empty — console.log() writes here)' });
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
    case 'unbind': Edits.sendOps(unbindOps(payload), { what: `remove ${payload}`, expect: false }); if (watching === payload) watching = null; setTimeout(refreshBehaviors, 400); break;
    case 'fold': break;   // the log header is not a fold
  }
  repaintAll();
}

function removeMany(ids) {
  // a locked thing is asked about by the authority's refusal ("This is locked. Delete anyway?"), not filtered out here
  const go = ids.filter((id) => entities.get(id));
  if (!go.length) return false;
  Edits.del(go); if (selection().length > 1) Sel.set([selection()[0]]); return true;   // one request: delete, or a batch of them (one act)
}

// ---------------------------------------------------------------- build
// Things INTO the world, in the left column beside the Hierarchy (Build | Hierarchy; design §5),
// so the viewport carries nothing but the world. B opens edit mode on this tab the first time;
// editlayout.js remembers the last tab after that (edittabs.js). Three sections, every one a
// RE-HOST of something that already worked — nothing here is a second implementation:
//   Blueprints  the starters and the library (catalog.js, /library-models): a raw model is a
//               blueprint of one Model, and placing one is exactly what placing from the library
//               always did (build.js holdGhost → spawn). "add light" is a blueprint of one Light.
//               Saved blueprints arrive with step 6; the group is there, empty, saying so.
//   Tools       the transform tools (build.js setTool — the same call as Q/G/E/R), the building
//               tools (structure_ui.js — its TOOLS, its setTool; a building edit is one act, so Ctrl+Z undoes it)
//               and seat placement (socketedit.js armSocketPlacement, on the selected thing).
//   World       the world entity's presets (shared/worldentity.js worldPick): Sky from
//               defs/sky/_presets.json, Terrain and Grass from defs/ground/_palette.json (the same
//               args groundpanel writes, shared/grounddefs.js), Weather. A pick replaces the
//               current choice through the existing sky / terrain / grass / weather verbs, as one
//               Ctrl+Z step. "World" selects @world: its every field, in the Inspector.
// The VR body says what it cannot do: the building tools pick cells with a mouse ray on the canvas,
// and the transform tools drag with one, which a headset does not have yet — so the quad names
// that, offers the Library (placing a model 1.5 m ahead: worldquad.js spawnAhead) and the World.
const buildFolds = {};
let libQ = '';            // the Library search box
let libHits = null;       // search results; null = the curated starters (an empty box shows those, as catalog.js does)
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
    hint: `${pics ? 'a blueprint of one Model — click, then click the world to place it' : 'a blueprint of one Model — places it 1.5 m ahead of you'}${m.credits ? `\n${creditLine(m.credits)}` : ''}` })) });

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
  ...savedFields(pics),
];
/** The blueprints this world's store holds (state.blueprints, folded from `blueprint` entries),
 *  oldest publish first, each with its version and how many copies stand. A pick carries a copy
 *  as the ghost (build.js holdBlueprint) on desktop, or places one 1.5 m ahead in VR. Save as
 *  Blueprint (a selection → a record) is step 6c; until then records arrive through the
 *  door's publish (a person here, or an agent). */
function savedFields(pics) { return savedFieldsHere(); }
/** This world's blueprints are @world blueprints:<hash> (the authority's publish writes them); a copy is the authority's
 *  create {from: hash, at} 1.5 m ahead, and Save as blueprint is the authority's publish {from, name} on the selection. */
function savedFieldsHere() {
  const lib = Edits.blueprints(); const sel = selection();
  return [
    { t: 'info', label: 'saved here', value: lib.length ? `${lib.length} blueprint${lib.length === 1 ? '' : 's'} in this world` : 'none yet — select something and save it' },
    { t: 'btn', k: 'bpsave', label: 'save as blueprint', icon: 'boxes', disabled: !sel.length,
      hint: sel.length ? `save ${sel.length === 1 ? sel[0] : `these ${sel.length} things`} (and what's attached) as one of this world's blueprints — the authority's publish, the same request an agent sends` : 'select something first' },
    ...(lib.length ? [{ t: 'tiles', k: 'bp', value: null, options: lib.map((b) => ({ v: b.hash, label: String(b.name ?? b.hash.slice(7, 15)), icon: 'boxes',
      hint: `${b.parts ?? '?'} part${b.parts === 1 ? '' : 's'} · ${b.hash.slice(0, 15)} — places a copy 1.5 m ahead of you` })) }] : []),
  ];
}
const aheadPose = () => { const yaw = myState.yaw ?? 0;
  return { pos: [myState.pos.x + Math.sin(yaw) * 1.5, myState.pos.y, myState.pos.z + Math.cos(yaw) * 1.5].map((v) => +v.toFixed(2)), q: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)].map((v) => +v.toFixed(4)) }; };
/** A copy 1.5 m ahead, facing the way you face — the hand-free place (worldquad.js spawnAhead's pose). */
function placeAhead(hash) { return Edits.copyBlueprint(hash, aheadPose()); }

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
    // remove what's there, from the world's own section too (R 10-11 23:05: "allow the sky/weather/terrain/grass to be
    // deleted/disabled from the World entity"): the same edit as the Hierarchy row's ✕ and the card's remove button
    ...(owner ? envRows().map((r) => ({ t: 'btn', k: `envdel-${r.id.slice(4)}`, label: `✕ remove ${r.label.toLowerCase()}`, icon: r.icon, hint: `remove: ${ENV.find((e) => e.key === r.id.slice(4))?.gone} (Ctrl+Z brings it back)` })) : []),
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
/** A World tile: the pick as one request (shared/worldentity.js worldPick): one act, one Ctrl+Z. */
function pickWorld(action, v) {
  const kind = action === 'wplant' && v === '@mow' ? 'mow' : WORLD_PICKS[action];
  const r = worldPick(state.st, kind, v, { pal: groundPal, presets: skyPresets, now: Date.now(), mayShape: mayShape() });
  if (r.errors.length) { flashHint(r.errors.join(' · '), 5000); return r; }
  Edits.sendOps(r.ops, { what: kind === 'mow' ? 'mowing' : `the ${kind === 'shape' || kind === 'tint' ? 'ground' : kind === 'plant' ? 'grass' : kind}`, expect: false });
  flashHint(kind === 'mow' ? 'field cleared' : html`${kind === 'plant' ? 'grass' : kind}: <b>${v}</b>`, 2500);
  return r;
}

function buildFields() {
  const st = structureTool(); const sel = sceneSelected();
  return [
    ...blueprintFields(true),
    { t: 'group', k: 'tools', label: 'Tools', open: !buildFolds.tools },
    // one tool is active: an armed building tool or seat placement owns the next click, so the
    // transform tile reads armed only while neither is
    { t: 'tiles', k: 'ttool', value: st || socketArmed() ? null : transformTool(), options: TRANSFORM_TILES },
    { t: 'tiles', k: 'stool', value: st, options: structureTools().map((x) => ({ v: x.k, label: x.label, icon: x.icon, hint: x.hint })) },
    { t: 'tiles', k: 'xtool', value: socketArmed() ? 'seat' : null, disabled: !sel && !socketArmed(),
      options: [{ v: 'seat', label: 'station', icon: 'armchair', hint: sel ? `click where a body occupies ${sel} (a station socket)` : 'select a thing first, then click where a body occupies it' }] },
    { t: 'btn', k: 'snew', label: 'new building', icon: 'plus', hint: 'start a new building on the ground in view' },
    ...worldBuildFields(),
  ];
}
function buildDispatch(action, payload) {
  if (WORLD_PICKS[action]) { pickWorld(action, payload); repaintAll(); return; }
  if (String(action).startsWith('envdel-')) { removeEnv(action.slice(7)); return; }
  switch (action) {
    case 'fold': buildFolds[payload] = !buildFolds[payload]; break;
    case 'wsel': selectWorld(); return;
    // a transform tile is the same call as its key (Q/G/E/R); picking one also puts down an armed
    // building tool or seat placement, which would otherwise keep the next click
    case 'ttool': if (structureTool()) setStructureTool(null); cancelSocketArm(); setTransformTool(payload); break;
    case 'stool': cancelSocketArm(); setStructureTool(structureTool() === payload ? null : payload); break;   // the armed tile again = drop it
    case 'xtool': if (socketArmed()) cancelSocketArm(); else { if (structureTool()) setStructureTool(null); armSocketPlacement(sceneSelected()); } break;
    case 'snew': newBuilding(null); break;
    case 'light': holdGhost('@light', 'light'); break;
    case 'bp': placeAhead(payload); break;
    case 'bpsave': { const ids = selection(); if (!ids.length) break;
      // asked, as Roblox's "Save to Roblox" and SL's Take name what they keep (review 10-07 S5: it saved as "4177f489").
      // The offer is a person's word for it: its label, else its model's name (the inspector's header), else its id
      const one = ids.length === 1 ? foldRecord(ids[0]) : null;
      const offer = ids.length === 1 ? String(one?.label ?? (one?.model != null ? modelName(one.model) : ids[0])) : `${ids.length} things`;
      (xrActive() ? Promise.resolve(offer) : askCenter({ title: 'Save as blueprint', body: 'A name for it in Blueprints › saved here, where you place copies of it.', value: offer, ok: 'Save' }))
        .then((name) => { if (!name) return;
          Edits.publish(ids, name).then((r) => { if (r.ok) flashHint(html`saved <b>${name}</b> as a blueprint — it's in Blueprints › saved here`, 4000); repaintAll(); }); });
      break; }
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
  else if (action === 'bp' && payload) placeAhead(payload);
  repaintAll();
}

// ---------------------------------------------------------------- History
// the right column's second page (R 10-04, research 56): the selected thing's acts, newest first, or the whole world's
// with nothing selected — read from the log on demand through the same request an agent uses (history {id,
// before}), a page at a time: recent by default, Older… for the deep search. Nothing stored.
// Credits are filter modes here (R 10-07: no third tab, no hand credits): by time, by person, biggest contributors, by
// what changed (client/lib/historyrows.js historyView). The view's mode is this viewer's, never logged.
// (mergeHistory: client/lib/historyrows.js)
const hist = { key: null, entries: [], next: null, loading: false, id: null, mode: 'time', who: null, gen: 0, paged: false };
// A thing's history is re-read whenever the thing changes (its components are in the key). A refresh shows the newest page;
// once the person has read Older… pages, a refresh never undoes them (historyrows.js mergeHistory), and a refresh answered
// after a newer refresh was sent is dropped (client-check HT6, 10-17: a late refresh replaced an Older… read).
function histLoad(id, more = false) {
  const before = more ? hist.next : undefined;
  const gen = more ? hist.gen : ++hist.gen;
  hist.loading = true;
  sendRequest('history', id ? { id, limit: 20, ...(before != null ? { before } : {}) } : { limit: 30 }).then((r) => {
    if (!r?.ok || hist.id !== id || (!more && gen !== hist.gen)) return;
    const rows = id ? r.entries : worldHistoryRows(r.entries, Edits.nameOf);
    if (!id) { hist.entries = more ? [...hist.entries, ...rows] : rows; hist.next = r.next ?? null; }
    else ({ entries: hist.entries, next: hist.next, paged: hist.paged } = mergeHistory(hist, rows, r.next ?? null, more));
    hist.loading = false; repaintAll();
  }).catch(() => { hist.loading = false; });
}
function historyFields() {
  const id = worldSel() ? null : sceneSelected() ?? null;
  // re-read when the selection changes or the thing does (its components), or the world log moves (nothing selected)
  const key = id ? `${id}|${JSON.stringify(Edits.compsOf(id))}` : `@|${entities.size}|${Math.floor(Date.now() / 3000)}`;
  if (key !== hist.key) { hist.key = key; if (hist.id !== id) { hist.entries = []; hist.next = null; hist.who = null; hist.paged = false; } hist.id = id; histLoad(id); }
  const f = [{ t: 'info', label: id ? 'history of' : 'history', value: id ? (bagOf(id)?.label ?? id) : 'the whole world, newest first — select a thing for its own', hint: 'from the world log: who did what, when' }];
  const view = historyView(hist.entries, Edits.nameOf, { mode: hist.mode, who: hist.who });
  const people = historyView(hist.entries, Edits.nameOf, { mode: 'top' }).people ?? [];
  f.push({ t: 'enum', k: 'mode', label: 'show', value: hist.mode, options: HISTORY_MODES.map(([v, label]) => ({ v, label })), hint: 'the same log, seen four ways: who made this what it is (the Credits) is "biggest contributors"' });
  if (hist.mode === 'person') f.push({ t: 'enum', k: 'who', label: 'person', value: hist.who ?? '', options: [{ v: '', label: '(pick someone)' }, ...people.map((p) => ({ v: p.by, label: `${p.who} (${p.deeds})` }))] });
  if (!hist.entries.length) f.push({ t: 'info', label: '', value: hist.loading ? 'reading the log…' : 'nothing yet' });
  const row = (e) => {
    // what changed, not just where (R 10-10 23:55): the authority's diff per component ('text: width 5.08 → 3.91')
    const diff = e.diff && !e.changed?.includes('(created)') ? Object.entries(e.diff).map(([c, d]) => `${c}: ${d}`).join(' · ') : '';   // a creation says so; its every field isn't news
    const what = `${e.verb}${e.target ? ` ${e.target}` : ''}${diff ? ` · ${diff}` : e.changed?.length ? ` · ${e.changed.join(', ')}` : ''}${e.undoes !== undefined ? ` (undoes #${e.undoes})` : ''}`;
    f.push({ t: 'info', k: `h:${e.seq}`, label: e.ts ? agoWords(e.ts) : `#${e.seq}`, value: e.text ?? `${e.who ?? Edits.nameOf(e.by)} · ${what}`, hint: `${diff ? diff + '\n' : ''}act #${e.act ?? e.seq} in the log${e.ts ? ` · ${new Date(e.ts).toLocaleString()}` : ''}` });
  };
  if (view.mode === 'top') for (const p of view.people) f.push({ t: 'btn', k: `who:${p.by}`, label: `${p.who} — ${p.did.join(' · ') || 'tried'}${p.deeds > 1 ? ` (${p.deeds})` : ''}`, hint: `${p.deeds} change${p.deeds === 1 ? '' : 's'}${p.tried ? `, ${p.tried} refused` : ''} in what's loaded — click for their history` });
  else if (view.mode === 'kind') for (const g of view.groups) { f.push({ t: 'info', label: '', value: `${g.kind} (${g.rows.length})` }); g.rows.forEach(row); }
  else view.rows.forEach(row);
  if (hist.next != null && id) f.push({ t: 'btn', k: 'older', label: 'Older…', hint: 'read further back in the log (a deeper search, 20 at a time); the other views count only what is loaded' });
  return f;
}
function historyDispatch(action, value) {
  if (action === 'older') histLoad(hist.id, true);
  else if (action === 'mode') { hist.mode = HISTORY_MODES.some(([v]) => v === value) ? value : 'time'; repaintAll(); }
  else if (action === 'who') { hist.who = value || null; repaintAll(); }
  else if (typeof action === 'string' && action.startsWith('who:')) { hist.mode = 'person'; hist.who = action.slice(4); repaintAll(); }
}

// ---------------------------------------------------------------- Attributes (R 10-10: Maya's Attribute Editor beside
// the Inspector's channel box): everything about the selection, including what the Inspector leaves out — its id, its
// parent, whether it is hidden for EVERYONE, and every component as JSON.
let attrPainted = [];
function attributesFields() {
  const id = worldSel() ? null : sceneSelected();
  if (!id || !entities.has(id)) { attrPainted = [{ t: 'info', label: 'selection', value: 'nothing selected — Attributes lists everything about the selected thing, including what the Inspector leaves out' }]; return attrPainted; }
  const schema = schemaFor(id); const bag = bagOf(id) ?? {}; const f = [];
  f.push({ t: 'info', label: 'id', value: id, dim: true, hint: 'its permanent id: the log, scripts and agents point at this' });
  const hid = cardRow(schema, id, 'flags.hidden');
  if (hid) f.push({ ...hid, label: 'hidden for all', hint: 'Hidden from EVERYONE in this world (a world edit). The eye in the Inspector and the Hierarchy hides it in your view only.' });
  const lk = cardRow(schema, id, 'flags.lock'); if (lk) f.push({ ...lk, label: 'locked' });
  const ly = cardRow(schema, id, 'flags.layer'); if (ly) f.push(ly);   // the selection layer (Select ▾ in the viewport bar)
  const ct = cardRow(schema, id, 'flags.clickthrough'); if (ct) f.push(ct);   // clicks go through: beside the layer, which it may merge into (R 10-17 20:36; left the Inspector)
  // the Transform's advanced rows (were the Inspector's 'Advanced'): rotation order and the quaternion as stored
  const tsec = schema.sections?.list?.find((x) => x.type === 'Transform');
  const adv = (tsec?.fields ?? []).map((addr) => [addr, cardRow(schema, id, addr)]).filter(([addr, r]) => r && !r.alias && (r.row === 'quat' || addr === 'rot.order')).map(([, r]) => r);
  if (adv.length && !tsec.quatOpen) { f.push({ t: 'group', k: 'a:rot', label: 'Rotation, as stored', open: isOpen(id, 'a:rot'), hint: 'rotation order and the quaternion (four numbers that never gimbal-lock): rarely needed until rigs' }); f.push(...adv); }
  const parentSec = schema.sections?.list?.find((s) => s.type === 'Parent');
  if (parentSec) { f.push({ t: 'group', k: 'a:parent', label: 'Parent', open: isOpen(id, 'a:parent') }); for (const addr of parentSec.fields) { const r = cardRow(schema, id, addr); if (r) f.push(r); } }
  f.push({ t: 'group', k: 'a:json', label: 'Components as JSON', open: isOpen(id, 'a:json'), hint: 'every component on it, as it is stored. A saved edit replaces that component whole.' });
  for (const type of compKeys(bag).sort()) {
    if (bag[type] === undefined) continue;
    f.push({ t: 'json', k: `ed:comp.${type}`, path: `comp.${type}`, label: type, value: JSON.stringify(bag[type], null, 2), collapsed: true, hint: `the whole ${type} component as JSON` });
  }
  attrPainted = f;
  return f;
}
function attributesDispatch(action, payload, field, opts = {}) {
  const keep = painted; painted = attrPainted;
  try { return inspectorDispatch(action, payload, field, opts); } finally { painted = keep; }
}

// ---------------------------------------------------------------- mounting
const PANELS = [
  { id: 'hierarchy', title: 'Hierarchy', theme: 'edit', fields: hierarchyFields, dispatch: hierarchyDispatch, frame: { x: 64, y: 60, w: 300, h: 380, minW: 220, minH: 160 } },   // x clears the dock rail (left:10 + 34px buttons + padding)
  // docked as a tab beside the Hierarchy by editlayout.js (Build | Hierarchy); its VR body is its own field list
  { id: 'build', title: 'Build', theme: 'edit', fields: buildFields, dispatch: buildDispatch, vr: { fields: buildVRFields, dispatch: buildVRDispatch }, frame: { x: 64, y: 60, w: 300, h: 380, minW: 220, minH: 160 } },
  { id: 'inspector', title: 'Inspector', theme: 'edit', fields: inspectorFields, dispatch: inspectorDispatch, frame: { x: -330, y: 60, w: 320, h: 520, minW: 250, minH: 160 } },
  // docked as a tab beside the Inspector by editlayout.js (Inspector | History)
  { id: 'history', title: 'History', theme: 'edit', fields: historyFields, dispatch: historyDispatch, frame: { x: -330, y: 60, w: 320, h: 520, minW: 250, minH: 160 } },
  // docked as a third tab (Inspector | Attributes | History): Maya's Attribute Editor to the Inspector's channel box
  { id: 'attributes', title: 'Attributes', theme: 'edit', fields: attributesFields, dispatch: attributesDispatch, frame: { x: -330, y: 60, w: 320, h: 520, minW: 250, minH: 160 } },
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
    lastAway = null;   // inspectorFields sets it again if it still shows a thing's distance
    for (const p of PANELS) frames.get(p.id)?.set(p.fields(), (a, v, fld, o) => p.dispatch(a, v, fld, o));
    bus.emit('xr:repaint');
  });
}

/** The Inspector header's scrub-feel dials (Maya's Channel Box icons, R 10-04): speed and accelerating. Per viewer. */
function scrubFeelButtons(root) {
  const btns = root.querySelector('.fr-btns'); if (!btns) return;
  const mk = (cls) => { const b = document.createElement('button'); b.className = `fr-btn sp-scrubfeel ${cls}`; Object.assign(b.style, { fontSize: '10px', padding: '0 5px', width: 'auto', opacity: '0.8' }); return b; };
  const speed = mk('sp-scrub-speed'), accel = mk('sp-scrub-accel');
  const paint = () => { const f = getScrubFeel();
    speed.textContent = { slow: 'slow', medium: 'med', fast: 'fast' }[f.speed] ?? f.speed;
    speed.title = `scrub speed: ${f.speed} — how much dragging a number changes it (click: ${Object.keys(SCRUB_SPEEDS).join(' → ')}). While dragging: Shift finer, Ctrl whole numbers`;
    accel.textContent = f.accel ? 'accel' : 'linear';
    accel.title = f.accel ? 'accelerating: the further you drag, the faster it changes (Maya\'s hyperbolic) — click for linear' : 'linear: the same change per inch however far you drag — click for accelerating'; };
  speed.onclick = (e) => { e.stopPropagation(); const ks = Object.keys(SCRUB_SPEEDS); setScrubFeel({ speed: ks[(ks.indexOf(getScrubFeel().speed) + 1) % ks.length] }); paint(); };
  accel.onclick = (e) => { e.stopPropagation(); setScrubFeel({ accel: !getScrubFeel().accel }); paint(); };
  paint(); btns.prepend(speed, accel);
}

export function initEditPanels() {
  for (const p of PANELS) {
    registerXRPanel({ ...p, ...(p.vr ?? {}) });            // the VR body (a panel may declare its own)
    const sf = makeSchemaFrame(p.id, { title: p.title, ...p.frame, hidden: true, className: 'edit' });   // the desktop body
    if (p.id === 'inspector') scrubFeelButtons(sf.frame.el);
    frames.set(p.id, sf);
  }
  // the Transform title's 'N m away' follows you: twice a second, repaint only when the whole metres changed (an in-place update)
  setInterval(() => { if (!lastAway || document.hidden || !frames.get('inspector')?.frame?.el?.getClientRects().length) return; const id = sceneSelected(); const o = id === lastAway.id ? entities.get(id) : null;
    if (!o) { lastAway = null; return; } if (Math.round(o.getWorldPosition(_wp).distanceTo(myState.pos)) !== lastAway.m) repaintAll(); }, 500);
  bus.on('selection', () => { const id = sceneSelected(); if (id) revealPath(id); });   // before the paint: a selected child shows, its ancestors unfold (design §5)
  for (const ev of ['entity', 'comp', 'mount', 'edit-mode', 'selection', 'structure-tool', 'tool', 'your-rights', 'log-applied']) bus.on(ev, repaintAll);   // log-applied: a world's library lives on @world, which the realizers never touch
  // the world entity's components are the fold's sky / terrain / grass: repaint when a world verb folds
  // …and the Build panel's saved blueprints when a record is published
  const WORLD_KEYS = new Set(['sky', 'terrain', 'grass', 'blueprints'])
  onWorldChange((ev) => { if (ev.type !== 'change' && (ev.type !== 'world' || WORLD_KEYS.has(ev.key))) repaintAll(); });
  loadWorldDefs(); bus.on('defs-updated', loadWorldDefs);
  // a drag's `before` never outlives its primary; the extras' outlines follow the set
  let lastPrimary = null;
  bus.on('selection', () => { const p = sceneSelected(); if (p !== lastPrimary) { lastPrimary = p; gesture = null; pendingAsk = null; endGesture(); } syncOutlines(); });
  bus.on('edit-extend', (id) => extendSelection(id));   // Ctrl-click in the viewport (build.js)
  // a box drawn in the viewport (Shift-drag on bare space, build.js): ADD each to the selection (never toggles one off)
  bus.on('edit-select-add', (ids) => { const list = (ids ?? []).filter((id) => entities.get(id)); if (list.length) Sel.extend(list); });
  // an armed attach completes on a VIEWPORT pick too: build.js select → the store
  // → this. The child is re-selected after, so the inspector shows what moved.
  bus.on('selection', ({ ids, kind }) => {
    const id = kind === 'things' ? ids[0] ?? null : null;
    // a ref pick armed from the inspector: the world-clicked id is the target.
    // Re-select the entity being edited so the inspector stays on it.
    if (armingRef && id && id !== armingRef.id && !String(id).startsWith(OCC_ROW)) {
      const back = armingRef.id;
      if (completeRefPick(id)) { sceneSelect(back); return; }
    }
    if (!arming || !id || id === arming || String(id).startsWith(OCC_ROW)) return;
    const child = arming; arming = null;
    reparent(child, id);
    sceneSelect(child);
  });
  bus.on('entity', () => { if (outlines.size) syncOutlines(); });
  bus.on('disabled-changed', () => repaintAll());   // switched off or on: the Inspector and the Hierarchy say so at once
  // leaving edit mode keeps the primary thing (the look-mode scene panel shows it) and drops the rest
  bus.on('edit-mode', (on) => { if (!on) { armingRef = null; const p = sceneSelected(); if (p) Sel.set([p]); else Sel.clear(); } });
  setEditHooks({ casting: lightCasting });
  // Del / Backspace / X act on what the inspector shows — every selected thing, one undo
  setRemoveHook(() => removeMany(selection()));
  bus.on('edit-find', () => findSelected());              // F in the viewport
  bus.on('edit-reset', (what) => resetTransform(what));   // Alt+G / Alt+E / Alt+R, Ctrl+G in the viewport
  bus.on('key', (e) => {   // Ctrl+D duplicates (Maya, Unity, Godot; R 10-04), Alt+D as well; preventDefault stops the bookmark
    if (!shown || e.code !== 'KeyD' || !(e.ctrlKey || e.metaKey || e.altKey)) return;   // keys: duplicate
    if (sceneSelected()) { e.preventDefault(); hierarchyDispatch('duplicate', sceneSelected()); }
  });
  bus.on('key', (e) => {   // Alt+Shift+A: the selection's ENABLED box (Unity's toggle active); the primary decides which way
    if (!shown || e.code !== 'KeyA' || !(e.altKey && e.shiftKey)) return;   // keys: toggleEnabled
    const sel = Sel.selection();   // not selection(): that keeps live things only, and a switched-off thing is still selected
    const ids = sel.kind === 'things' ? sel.ids.filter((id) => id !== WORLD_ID && state.st.entities[id]) : []; if (!ids.length) return;
    e.preventDefault();
    const on = state.st.entities[ids[0]]?.disabled === true;
    for (const id of ids) setEnabled(id, on);
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
  bus.on('selection', () => { if (shown) refreshBehaviors(); });
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
  inspDo: (a, v) => inspectorDispatch(a, v), hierDo: (a, v) => hierarchyDispatch(a, v),
  build: buildFields().length, buildFields: () => buildFields(), buildVR: buildVRFields().length, buildVRFields: () => buildVRFields(), buildVRDo: (a, v) => buildVRDispatch(a, v), worldSel: worldSel(), selected: sceneSelected(), arming,
  groups: sceneSelected() ? schemaFor(sceneSelected()).groups.map((g) => g.group) : [], behaviors: behaviors.length, rows: visibleRows, selection: selection(),
  watching, consoleLines: watchLog?.lines?.length ?? 0,
});
