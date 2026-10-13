// build — the human's authoring surface.
//
// Before this, a person could ADD to a world and never move, correct, or
// unmake anything in it: `place` and `remove` were server-allowed and agent-
// reachable, but there was no UI for either, so every misplacement was
// permanent and there was no undo. Agents had a richer verb surface than
// people. That is what this module fixes.
//
// Placement helpers are the drag semantics, per DESIGN.md: the ghost lands ON
// the table rather than beside it, because the collider tops that already
// compute walkable ground are the same data as "what can I put things on".

// SPLIT (R4): this file is the gesture CORE — mode, selection, ghost, drag,
// undo, and the one pointer/key router. The panel sections live beside it
// (catalog.js models+avatars+upload, groundpanel.js, skypanel.js), and the
// seat-anchor grammar in seatedit.js; the router here hands seat gestures
// across that seam and never re-implements them.

import { svg as iconSvg } from './icons.js';
import * as OP from '../../shared/protocol/requests.js';
import { mintId } from '../../shared/protocol/ids.js';
import { THREE, scene, camera, canvas } from './core.js';
import { bus, report } from './base.js';
import { loadGLB, libLabels } from './assets.js';
import { makeLightGizmo } from './lights.js';
import { entities, metaOf, bagOf, editHolds } from './world.js';
import { reindexCollider } from './colliders.js';
import { heightAt } from './terrain.js';
import { net, sendDrag } from './net.js';
import { scaleOf } from '../../shared/scale3.js';
import { MESH_DEFAULT, ghostMeshSize } from './meshghost.js';
import { engage, release } from './keyhints.js';
import { placeRefusal } from '../../shared/blueprint.js';
import { myState, mouse, setPointerClaim, setEditingProbe } from './controller.js';
import { flashHint, collapseAll, panelFrame, html, claimStatus, releaseStatus } from './ui.js';
import { paint, escapeHtml } from './markup.js';
import { pushHostHook } from './autohooks.js';
import { clickable } from './selectmask.js';
import { outOfMyView } from './myview.js';
import * as Sel from './edit/selection.js';
import { claimEscape } from './windows.js';
import { currentTool as structureTool, setTool as setStructureTool } from './structure_ui.js';   // an armed building tool is Esc's first rung
import { state } from './state.js';   // one rule for who may author (and one name for them), shared with the scene panel
import * as Edits from './editwrites.js';   // slice 3b: every write here is a request
import { refreshSeatGizmos, resetSeats, armSeatPlacement, seatArmed, seatSelected,
  cancelSeatArm, deselectSeat, seatMouseDown, seatKeyDown, updateSeatDrag } from './seatedit.js';

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hit = new THREE.Vector3();

// ============================================================ state

let ghost = null;         // { obj, lib, yaw, scale, bp? } — a thing not yet placed (bp: a blueprint copy, {hash, record})
let selected = null;      // { id, obj } — the selection's primary thing, resolved to its object (edit/selection.js is the truth)
let dragging = null;      // { id, offset, plane } while moving a selection

// Editing is a MODE.
//
// It was always-live, on the theory that "select anything, any time" is closer
// to the one-verb-surface ideal. In a world you look around by dragging, that
// theory is wrong: every camera drag that happens to start on an object picks
// it up and moves it, and the world quietly rearranges itself while you are
// just trying to see. Looking is the default; editing is something you say you
// are doing.
let editMode = false;
export const isEditing = () => editMode;
claimEscape(() => (editMode ? 'edit' : null));   // edit mode owns Esc (its own ladder) — the frames' close-all yields

/** May this client enter edit mode at all?
 *
 * PERMISSIVE WHEN UNKNOWN, denying only on a known-insufficient role —
 * generate.js:144 (`net.myRights?.gen !== false`) is the house idiom and this
 * follows it. net.myRights has no declaration in net's object literal; it is
 * assigned at the snapshot (net.js:697) or a live grant (:468), so it is
 * `undefined` for the whole pre-snapshot window. Treating that as denial would
 * make holdGhost() silently do nothing on a slow join — a build click that
 * vanishes is worse than one that is refused out loud.
 */
// No edit mode on a phone (R, 10-06 23:39: "Probably not a great surface for it"). A phone = a coarse pointer on a
// screen whose short side is phone-sized; tablets, headset browsers and touch laptops keep edit mode. Viewing and
// playing are untouched. VR edit mode comes later but must not be broken in principle (same date), so this never
// reads XR state.
export const editSurface = () => !(globalThis.matchMedia?.('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600);
export const mayEdit = () => {
  if (!editSurface()) return false;
  const r = net.myRights; const role = r?.role;
  // a world says what you may do as permissions (research roles S4): build, whatever the role is called (a moderator,
  // a custom role); an older server still says only the role
  if (Array.isArray(r?.permissions)) return r.permissions.includes('build');
  return role === undefined || ['builder', 'owner'].includes(role);
};

export function setEditMode(on, { quiet = false } = {}) {
  // The gate the wrench advertises, applied at the one chokepoint every entry
  // point funnels through: toggleEditMode, the dock action, KeyB, and the two
  // quiet callers (holdGhost, armSeatPlacement — "I picked a thing to place",
  // which is exactly the build intent the server refuses). Gating only the
  // keybind would have been half a fix, which is the shape of mistake this
  // review round already caught once.
  //
  // ONLY the `on` direction. Leaving always works, or a client demoted
  // mid-session is trapped in edit mode with no way out.
  //
  // R, 2026-09-11, on why this is not merely cosmetic: "Builder is true by
  // default, but if it's a server where builder/not builder is delineated,
  // Edit is unpinned and gray." The rail says you cannot; the keyboard should
  // not disagree with the rail.
  if (on && !mayEdit()) {
    if (!quiet) flashHint(editSurface() ? 'builder mode needs build rights in this world' : 'builder mode is for a desktop (or tablet); on a phone you can look around and play');
    return editMode;
  }
  if (editMode === on) return editMode;
  editMode = on;
  document.body.classList.toggle('edit-mode', on);
  if (!on) { cancelGhost(); deselect(); resetSeats(); }
  refreshSeatGizmos();   // anchors are visible exactly while you are editing
  // Saying you are building puts the tools in front of you: the workspace's Build tab (editlayout.js) is the catalog.
  // The legacy World frame used to be shown here too; the workspace parked it at once and then "restored" it on the
  // way out, so it stayed open in look mode (review 10-07 S14). It now opens only if it was open before.
  if (!quiet) {
    flashHint(on
      ? html`builder mode — <kbd>G</kbd> move · <kbd>E</kbd> rotate · <kbd>R</kbd> scale · <kbd>Q</kbd> select · <kbd>F</kbd> find · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>B</kbd> leaves`
      : 'looking again');
  }
  bus.emit('edit-mode', on);
  return editMode;
}
export const toggleEditMode = () => setEditMode(!editMode);

// The TOOL is what a drag does. Move is the drag everyone has today; rotate
// and scale are the Q/E and ,/. gestures with the pointer instead of keys;
// select never moves anything. Gizmos (P2) will draw handles for the same
// three verbs — the tool state is theirs to read when they arrive.
let tool = 'move';
export const getTool = () => tool;
// transform space per tool (R 10-04: "gimbal/object/world rotations... a way to switch between them"): world = the
// world's axes, object = the thing's own axes (three's 'local'). Gimbal (the Euler rings in the rotate order) needs
// its own gizmo: not yet. Scale is always the thing's own axes. Kept per viewer (a view choice, never logged).
export const SPACES = { move: ['world', 'object'], rotate: ['world', 'object'], scale: ['object'] };
const space = (() => { try { return { move: 'world', rotate: 'world', scale: 'object', ...JSON.parse(localStorage.getItem('ew-tool-space') ?? '{}') }; } catch { return { move: 'world', rotate: 'world', scale: 'object' }; } })();
export const getSpace = (t = tool) => space[t] ?? 'world';
export function setSpace(t, s) {
  if (!SPACES[t]?.includes(s)) return getSpace(t);
  space[t] = s; try { localStorage.setItem('ew-tool-space', JSON.stringify(space)); } catch { /* fine */ }
  bus.emit('tool-space', { tool: t, space: s });
  return s;
}
/** The active tool's key pressed again steps its space (Blender's double-press, one key): G G = move in object axes. */
export function cycleSpace(t = tool) {
  const list = SPACES[t]; if (!list || list.length < 2) return getSpace(t);
  return setSpace(t, list[(list.indexOf(getSpace(t)) + 1) % list.length]);
}
export function setTool(t) {
  if (!['select', 'move', 'rotate', 'scale', 'pivot'].includes(t) || t === tool) return tool;
  tool = t;
  bus.emit('tool', tool);
  return tool;
}
export const hasGhost = () => ghost !== null;
export const hasSelection = () => selected !== null;
setPointerClaim(() => ghost !== null || !!dragging?.armed);
// the gizmo (gizmo.js) vetoes the mesh-grab while one of its handles is hot —
// a probe, not an import: gizmo imports us
// several handle sets may own a press (the gizmo, the grip editor's): any one vetoes
const pointerVetoes = [];
const pointerVeto = () => pointerVetoes.some((f) => f());
export function setPointerVeto(fn) { pointerVetoes.push(fn); }
setEditingProbe(() => editMode);

// ============================================================ selection

const outline = new THREE.Box3Helper(new THREE.Box3(), 0x8fe8c8);
outline.visible = false;
outline.userData.noCamCollide = true;
scene.add(outline);

// the selection line lives IN the one status bar (ui.js claimStatus, DESIGN-status-bar.md): a node it owns, claimed at
// priority 4 while something is selected, released when nothing is. The lock checkbox rides inside the node.
let inspector = null;
function ensureInspector() {
  if (!inspector) { inspector = document.createElement('div'); inspector.className = 'edit-selbar'; }
  return inspector;
}
const showSelbar = () => claimStatus('selection', { priority: 4, node: ensureInspector() });
/** The inspector bar as a surface other editors write to — seatedit paints
 *  its anchor line through this rather than reaching into the element. */
export function setInspectorHtml(line) {   // text, or markup built with html`` (markup.js)
  paint(ensureInspector(), line);
  showSelbar();
}
function showInspector(id) {
  const meta = metaOf(id) ?? {};
  ensureInspector();
  // its NAME first (R 10-11: the bar said 'crate_large_blue'), then the model's library label, its file, its id
  const own = Edits.compsOf(id)?.label;
  const label = (typeof own === 'string' && own) || (libLabels.get(meta.lib) ?? meta.lib?.split('/').pop()?.replace(/\.glb$/, '') ?? id);
  const locked = isLocked(id);
  inspector.innerHTML =
    `<span><b>${escapeHtml(label.slice(0, 34))}</b></span>` +   // a thing's label or model path: world content, text
    (locked
        ? `<span style="color:var(--dim)">locked — nothing moves or removes it until unchecked</span>`
        : `<span style="color:var(--dim)">drag move · <kbd>Shift</kbd>+drag up/down · ` +
          `<kbd>G</kbd> move · <kbd>E</kbd> rotate · <kbd>R</kbd> scale · <kbd>F</kbd> find · <kbd>X</kbd> remove · <kbd>Esc</kbd> done</span>`) +
    `<label title="nail it down: while locked, nobody's drags, verbs or scripts can move, replace or remove it (server-enforced) — sitting on it and content edits stay open" style="display:flex;gap:4px;align-items:center;cursor:pointer">` +
    // an icon, never an emoji (R, 10-10: "ONLY use emotes in the Chat and Emote panes. They are illegal pretty much everywhere else")
    `<input type="checkbox" data-bact="lock"${locked ? ' checked' : ''}><span class="sp-ico" aria-hidden="true">${iconSvg(locked ? 'lock' : 'lockOpen', 14)}</span> lock</label>`;
  // '+ seat' lived here (R 10-10 23:56: "Very curious why there's a 'seat' button here in the helper dialog?"); one stray
  // click on it seated people on a sign 3 m up. A seat is added where components are: Add Component ▸ Sockets ▸ '+ seat here'.
  inspector.querySelector('[data-bact="lock"]').onchange = (ev) => {
    const on = ev.target.checked;
    Edits.lock(id, on).then(() => { if (selected?.id === id) showInspector(id); });
  };
  showSelbar();
}
export function hideInspector() { releaseStatus('selection'); }

/** The selection's primary thing, when it is a thing. */
const primaryThing = () => { const s = Sel.selection(); return s.kind === 'things' ? s.ids[0] ?? null : null; };
export function select(id) {
  if (!entities.get(id)) return;
  // one store (edit/selection.js); the panels, the gizmo and this file's outline all follow its event
  Sel.set([id]);
  showInspector(id);
}
/** The deliberate deselect (Esc, Edit ▸ deselect): the selection itself. Plain deselect() drops the gesture and the
 *  helper strip and re-reads the selection — undo calls it, and an undo must not throw away the selection you are
 *  working on. */
export function deselectAll() { deselect(); Sel.clear(); }
export function deselect() {
  dragging = null;
  hideInspector();
  followSelection();
}
export function refreshOutline() {
  if (selected) outline.box.setFromObject(selected.obj);
}
// ONE selection (R 10-11 01:13: "make sure the same entities that are selected agree with each other in the hierarchy and
// the viewport"; 00:57: after undos, clicking away no longer deselected; 00:41: "Can the bounding box on moving objects
// update as the objects translate?"). edit/selection.js is the truth; `selected` is its primary resolved to an object,
// set on its event and re-resolved each edit-mode frame (a model swapped under it, a thing gone) with the box
// re-measured, so it tracks a thing that moves. The residency sweep must never demote what someone is editing —
// editHolds is id-based because promotion swaps the object out from under a userData flag.
function followSelection() {
  const sid = editMode ? primaryThing() : null; const obj = sid != null ? entities.get(sid) : null;
  if (obj) {
    if (!selected || selected.id !== sid || selected.obj !== obj) { if (selected && selected.id !== sid) editHolds.delete(selected.id); selected = { id: sid, obj }; editHolds.add(sid); }
    obj.updateWorldMatrix(true, true); outline.box.setFromObject(obj); outline.visible = true;
  } else if (selected && !dragging) { editHolds.delete(selected.id); selected = null; outline.visible = false; }
}
bus.on('selection', followSelection);
pushHostHook(followSelection);
/** For probes: what the viewport shows as selected (its outline box). */
export const selectionView = () => ({ id: selected?.id ?? null, visible: !!outline.visible, min: outline.box.min.toArray(), max: outline.box.max.toArray() });
// the echo of a place (ours from the inspector, or anyone's) moves the mesh; the box follows
bus.on('entity', ({ id } = {}) => { if (selected && id === selected.id) refreshOutline(); });

// ============================================================ ghost placement

function ghostify(obj) {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    o.material.transparent = true;
    o.material.opacity = 0.55;
    o.material.depthWrite = false;
    o.castShadow = false;
  });
  obj.userData.noCamCollide = true;
}

// Create ▸ Box/Sphere/Cylinder/Plane/Capsule (R 10-12): a mesh thing (componentspec `mesh`), held as its own grey ghost and
// placed with a click, standing on the floor (its origin is its base centre, the authority's boxOfM). Q/E turn it; ,/. scale
// its default size. The lib is '@mesh:<shape>'.
const meshOf = (lib) => (typeof lib === 'string' && lib.startsWith('@mesh:') ? lib.slice(6) : null);
function meshGhost(shape, [x, y, z]) {
  const r = x / 2;
  const geo = shape === 'sphere' ? new THREE.SphereGeometry(r, 24, 12).translate(0, r, 0)
    : shape === 'cylinder' ? new THREE.CylinderGeometry(r, r, y, 24).translate(0, y / 2, 0)
    : shape === 'capsule' ? new THREE.CapsuleGeometry(r, Math.max(0, y - 2 * r), 6, 12).translate(0, Math.max(y, x) / 2, 0)
    : shape === 'plane' ? new THREE.PlaneGeometry(x, z).rotateX(-Math.PI / 2)
    : new THREE.BoxGeometry(x, y, z).translate(0, y / 2, 0);
  const obj = new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ color: 0x9a9a9a, roughness: 0.8, metalness: 0, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
  obj.castShadow = false; obj.userData.noCamCollide = true;
  return obj;
}
export async function holdGhost(lib, label) {
  setEditMode(true, { quiet: true });   // choosing a thing to place is intent enough
  cancelGhost();
  deselect();
  try {
    let obj;
    if (lib === '@light') {
      obj = makeLightGizmo(0xffd9a0);
      obj.traverse((o) => { if (o.material) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.7; } });
    } else if (lib === '@empty') {   // Create ▸ Empty (R 10-11): a bare entity, a parent for others; shown as its axes
      obj = new THREE.AxesHelper(0.5);
    } else if (meshOf(lib)) {
      obj = meshGhost(meshOf(lib), MESH_DEFAULT[meshOf(lib)] ?? [1, 1, 1]);
    } else {
      obj = await loadGLB(lib);
      ghostify(obj);
    }
    ghost = { obj, lib, yaw: 0, scale: 1 };
    scene.add(obj);
    collapseAll();
    flashHint(lib === '@light' || lib === '@empty'
      ? html`placing ${lib === '@light' ? html`a <b>light</b>` : html`an <b>empty</b>`} — click to place · <kbd>Esc</kbd> cancel`
      : html`placing <b>${label ?? meshOf(lib) ?? ''}</b> — click to place · <kbd>Q</kbd>/<kbd>E</kbd> turn · <kbd>,</kbd>/<kbd>.</kbd> size · <kbd>Esc</kbd> cancel`, 6000);
    if (lib !== '@light' && lib !== '@empty') engage('ghostKeys');   // the status line keeps the keys while it's in hand
  } catch (e) { report('ghost', e); }
}

/** Carry a COPY of a blueprint as the ghost (design §3, step 6b): the whole tree,
 *  each part at its local pose under its parent — the same nesting the renderer
 *  builds for a mounted child — so what you aim is what lands. Committing places
 *  it as the authority's create {from: hash}: one act, one Ctrl+Z step. */
export async function holdBlueprint(hash, record) {
  const why = record ? placeRefusal(record) : 'that blueprint is not in this world\'s store';
  if (why) { flashHint(`can't place it: ${why}`, 5000); return false; }
  setEditMode(true, { quiet: true });
  cancelGhost();
  deselect();
  const token = (holdBlueprint.n = (holdBlueprint.n ?? 0) + 1);
  try {
    const node = async (n) => {
      const g = new THREE.Group();
      const tf = n.components.find((c) => c.type === 'Transform')?.params ?? {};
      if (Array.isArray(tf.pos)) g.position.fromArray(tf.pos);
      if (Array.isArray(tf.q) && tf.q.length === 4) g.quaternion.fromArray(tf.q).normalize();
      else if (Number.isFinite(tf.yaw)) g.rotation.y = tf.yaw;
      if (Number.isFinite(tf.scale)) g.scale.setScalar(tf.scale);
      const model = n.components.find((c) => c.type === 'Model');
      const light = n.components.find((c) => c.type === 'Light');
      if (model) {
        try { const m = await loadGLB(model.params.lib); ghostify(m); g.add(m); }
        catch (e) { report('ghost', e); }
      } else if (light) {
        const m = makeLightGizmo(Number.isInteger(light.params?.color) ? light.params.color : 0xffd9a0);
        m.traverse((o) => { if (o.material) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.7; } });
        g.add(m);
      } else {
        g.add(new THREE.AxesHelper(0.3));   // an Empty: a pivot you can see while aiming
      }
      for (const k of n.children) g.add(await node(k));
      return g;
    };
    const obj = await node(record.root);
    if (token !== holdBlueprint.n) return false;   // another pick came first
    obj.userData.noCamCollide = true;
    obj.traverse((o) => { o.userData.noCamCollide = true; });
    // the ghost's own scale is the R-drag; the record's root scale rides inside
    const holder = new THREE.Group();
    holder.add(obj);
    holder.userData.noCamCollide = true;
    ghost = { obj: holder, lib: null, yaw: 0, scale: 1, bp: { hash, record } };
    scene.add(holder);
    collapseAll();
    const n = (function count(x) { return 1 + x.children.reduce((k, c) => k + count(c), 0); })(record.root);
    flashHint(html`placing a copy of <b>${record.name}</b>${n > 1 ? ` (${n} parts)` : ''} — click to place · <kbd>Q</kbd>/<kbd>E</kbd> turn · <kbd>,</kbd>/<kbd>.</kbd> size · <kbd>Esc</kbd> cancel`, 6000);
    engage('ghostKeys');
    return true;
  } catch (e) { report('ghost', e); return false; }
}

export function cancelGhost() {
  if (ghost) { scene.remove(ghost.obj); ghost = null; release(); }
}

// Turn and size the thing in hand BEFORE the click (review 10-07: the ghost always landed at yaw 0, scale 1). The keys
// are the old protocol's editor's and the seat tool's: Q / E turn (15°, Shift 1°), , / . size (×1.1, Shift ×1.01), clamped as the scale tool
// clamps. Roblox's R / T and Godot GridMap's S / D rotate a held piece the same way, by key while the mouse aims; here
// R is the scale tool and D walks, so the keys a builder already has in their fingers in THIS editor win.
const GHOST_TURN = Math.PI / 12, GHOST_TURN_FINE = Math.PI / 180, GHOST_SIZE = 1.1, GHOST_SIZE_FINE = 1.01;
/** The thing in hand, for tests and the hint: {yaw, scale} or null. */
export const ghostPose = () => (ghost ? { yaw: ghost.yaw, scale: ghost.scale, lib: ghost.lib, bp: ghost.bp?.hash ?? null } : null);
function ghostKey(e) {
  if (!ghost || ghost.lib === '@light' || ghost.lib === '@empty' || e.ctrlKey || e.metaKey || e.altKey) return false;   // keys: ghostKeys (a light is a point: nothing to turn; Ctrl+Z etc. pass)
  const fine = !!e.shiftKey;   // keys: ghostKeys
  if (e.code === 'KeyQ' || e.code === 'KeyE') ghost.yaw += (e.code === 'KeyQ' ? 1 : -1) * (fine ? GHOST_TURN_FINE : GHOST_TURN);
  else if (e.code === 'Comma' || e.code === 'Period') { const k = fine ? GHOST_SIZE_FINE : GHOST_SIZE; ghost.scale = THREE.MathUtils.clamp(ghost.scale * (e.code === 'Period' ? k : 1 / k), 0.1, 12); }
  else return false;
  ghost.yaw = Math.atan2(Math.sin(ghost.yaw), Math.cos(ghost.yaw));
  flashHint(html`turned <b>${Math.round(ghost.yaw * 180 / Math.PI)}°</b> · size <b>×${ghost.scale.toFixed(2)}</b>`, 1500);
  return true;
}

/** Where the pointer is aiming, snapped onto whatever surface is under it.
 *  Raycasting real entities first is what turns "drops at y=0 beside the
 *  table" into "lands on the table". */
function aimPoint(skipId = null) {
  raycaster.setFromCamera(mouse, camera);
  const targets = [];
  for (const [id, o] of entities) if (o && id !== skipId) targets.push(o);
  let hits = raycaster.intersectObjects(targets, true);
  // a mounted child is drawn INSIDE its parent's object, so the parent's recursive hit test would find the very
  // thing being dragged under the pointer (and it would climb toward the camera). Skip its whole subtree.
  const skipObj = skipId != null ? entities.get(skipId) : null;
  if (skipObj) hits = hits.filter((h) => { for (let o = h.object; o; o = o.parent) if (o === skipObj) return false; return true; });
  // a thing hidden in MY view still catches what I place: it is solid for everyone, and my private view must never shape a
  // shared write (review 10-12 S3-5)
  if (hits.length) {
    const h = hits[0];
    // only treat near-horizontal faces as placement surfaces — a wall should
    // not catch a chair
    const n = h.face?.normal ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
    if (!n || n.y > 0.6) return { point: h.point.clone(), onto: h.object.userData.entityId ?? null };
  }
  if (raycaster.ray.intersectPlane(groundPlane, _hit)) {
    // clamp to placeable range — a ray toward the horizon meets the ground
    // plane hundreds of metres out
    const d = _hit.clone().sub(myState.pos); d.y = 0;
    const MAX = 20;
    if (d.length() > MAX) _hit.copy(myState.pos).addScaledVector(d.normalize(), MAX);
    return { point: new THREE.Vector3(_hit.x, heightAt(_hit.x, _hit.z), _hit.z), onto: null };
  }
  return null;
}

export function updateBuild() {
  updateSeatDrag();
  if (ghost) {
    const aim = aimPoint();
    if (aim) {
      ghost.obj.position.copy(aim.point);
      ghost.obj.rotation.y = ghost.yaw;
      ghost.obj.scale.setScalar(ghost.scale);
    }
  }
  if (dragging?.armed && selected) {
    if (tool === 'rotate') {
      // ~1° per px, drag right = clockwise from above — a turn about world UP,
      // composed on the full orientation, so a tilted thing turns where it lies
      _turn.setFromAxisAngle(_up, -(dragging.clientX - dragging.startX) * 0.012);
      selected.obj.quaternion.copy(_turn).multiply(dragging.startQuat);
      reindexCollider(selected.id); refreshOutline(); relayDrag();
    } else if (tool === 'scale') {
      { const k = Math.exp((dragging.clientX - dragging.startX) * 0.006); const sc = selected.obj.scale.copy(dragging.startScale).multiplyScalar(k); sc.set(...sc.toArray().map((v) => THREE.MathUtils.clamp(v, 0.1, 12))); }   // keeps a stretched thing's proportions
      reindexCollider(selected.id); refreshOutline();
    } else if (dragging.vertical) {
      // map screen-vertical pixels to world metres at the object's depth, so a
      // drag feels the same whether the thing is near or far
      const fov = camera.fov * Math.PI / 180;
      const pxToWorld = (2 * dragging.depth * Math.tan(fov / 2)) / innerHeight;
      const dy = (dragging.startY - dragging.clientY) * pxToWorld;   // up = raise
      const floor = heightAt(dragging.startPos.x, dragging.startPos.z);
      const y = Math.max(floor, dragging.startPos.y + dy);
      if (dragging.world) setWorldPosition(selected.obj, _w.set(dragging.startPos.x, y, dragging.startPos.z));
      else selected.obj.position.set(dragging.startPos.x, y, dragging.startPos.z);
      reindexCollider(selected.id);
      refreshOutline();
      relayDrag();
    } else {
      const aim = aimPoint(selected.id);
      if (aim) {
        // Keep the grab offset. Without it the object teleports so that its
        // ORIGIN sits under the cursor, which is both a jump and usually wrong —
        // you grabbed a crate by its corner, not by its pivot.
        if (dragging.world) {
          // the grab offset, the aim and the result are WORLD points; a mounted child's object position is local
          // to its parent (turned, scaled), so the world target is brought into that frame last (research 44 #5)
          _w.copy(aim.point).add(dragging.grab);
          if (aim.onto) _w.y = aim.point.y;
          setWorldPosition(selected.obj, _w);
        } else {
          selected.obj.position.copy(aim.point).add(dragging.grab);
          // dropping onto a surface should still rest ON it, not float by the
          // offset you happened to grab at
          if (aim.onto) selected.obj.position.y = aim.point.y;
        }
        reindexCollider(selected.id);
        refreshOutline();
        relayDrag();
      }
    }
  }
}

const _w = new THREE.Vector3();
globalThis.__buildDrag = () => (dragging ? { id: dragging.id, armed: dragging.armed, world: !!dragging.world, tool } : null);   // harness window (tools/protocol/client-check.ts F)
/** Put an object at a WORLD position, whatever frame it is drawn in (a mounted child sits in its parent's). */
function setWorldPosition(obj, w) {
  const p = obj.parent;
  if (!p) { obj.position.copy(w); return; }
  p.updateWorldMatrix(true, false);
  obj.position.copy(p.worldToLocal(w.clone()));
}

// relay at pose cadence so others see it move, not teleport
function relayDrag() {
  const now = performance.now();
  if (now - (dragging.lastSent ?? 0) < 66) return;
  dragging.lastSent = now;
  const p = selected.obj.position; const q = selected.obj.quaternion;
  sendDrag(selected.id, [p.x, p.y, p.z], new THREE.Euler().setFromQuaternion(q, 'YXZ').y, [q.x, q.y, q.z, q.w]);
}

// remote drags: apply transiently, no log involvement. A live drag is a CLAIM (locking design 10-11, R: "while someone
// drags/edits a thing, presence says who"): while samples flow, `by` is editing `id`; an amber box marks it and the
// Hierarchy says 'editing: <name>'; it lapses on the last sample (`end`) or CLAIM_MS of silence. Presence only.
const CLAIM_MS = 1500;
const claims = new Map();   // id -> { by, at, box }
const claimBox = () => { const b = new THREE.Box3Helper(new THREE.Box3(), 0xe0a33a); b.userData.noCamCollide = true; scene.add(b); return b; };
function endClaim(id) { const c = claims.get(id); if (!c) return; claims.delete(id); c.box.removeFromParent(); bus.emit('claims', claimsNow()); }
/** Probe/Hierarchy surface: who is editing what right now, by id. */
export const claimsNow = () => Object.fromEntries([...claims].map(([id, c]) => [id, c.by]));
setInterval(() => { const now = performance.now(); for (const [id, c] of claims) if (now - c.at > CLAIM_MS) endClaim(id); }, 250);
bus.on('drag', ({ id, pos, yaw, q, scale, by, end }) => {
  const obj = entities.get(id);
  if (!obj) return;
  if (Array.isArray(pos) && pos.length === 3) obj.position.set(...pos);
  if (Array.isArray(scale) && scale.length === 3) obj.scale.set(...scale);   // a scrubbed size, previewed live
  if (Array.isArray(q) && q.length === 4) obj.quaternion.set(q[0], q[1], q[2], q[3]);   // the rotate gizmo's full turn
  else if (yaw != null) obj.rotation.y = yaw;
  reindexCollider(id);
  if (end) { endClaim(id); return; }
  if (typeof by === 'string' && by) { let c = claims.get(id); if (!c) { c = { by, at: 0, box: claimBox() }; claims.set(id, c); c.at = performance.now(); bus.emit('claims', claimsNow()); } c.at = performance.now(); c.by = by; c.box.box.setFromObject(obj); }
});
bus.on('cut-adopted', () => { for (const id of [...claims.keys()]) endClaim(id); });

// ============================================================ commits + undo


function commitSpawn() {
  const p = ghost.obj.position;
  const id = mintId(ghost.lib === '@light' ? 'light' : ghost.lib === '@empty' ? 'empty' : meshOf(ghost.lib) ?? String(ghost.lib ?? '').split('/').pop().replace(/\.[a-z0-9]+$/i, ''));   // 128+ random bits (shared/protocol/ids.js)
  // one request: create (a model, or a light: a thing with a light component), or create {from} for a blueprint copy
  // a copy's root keeps the record's own size, times the size it was given in hand
  const rootScale = () => { const s = ghost.bp.record?.root?.components?.find((c) => c.type === 'Transform')?.params?.scale; return Number.isFinite(s) ? s : 1; };
  let sent;
  if (ghost.bp) sent = Edits.copyBlueprint(ghost.bp.hash, { pos: [p.x, p.y, p.z], q: [0, Math.sin(ghost.yaw / 2), 0, Math.cos(ghost.yaw / 2)], ...(ghost.scale !== 1 ? { scale: Array(3).fill(+(rootScale() * ghost.scale).toFixed(4)) } : {}) });
  else if (ghost.lib === '@empty') sent = Edits.sendOps([OP.create(id, { transform: { pos: [p.x, p.y, p.z] }, components: { label: 'empty' } })], { what: 'place an empty', expect: false });
  else if (meshOf(ghost.lib)) { const shape = meshOf(ghost.lib); const size = ghostMeshSize(shape, ghost.scale);
    sent = Edits.sendOps([OP.create(id, { transform: { pos: [p.x, p.y, p.z], q: [0, Math.sin(ghost.yaw / 2), 0, Math.cos(ghost.yaw / 2)] }, components: { mesh: { shape, size }, label: shape } })], { what: `place a ${shape}`, expect: false }); }
  else if (ghost.lib === '@light') sent = Edits.sendOps([OP.create(id, { transform: { pos: [p.x, p.y + 0.9, p.z] }, components: { light: { color: 0xffd9a0, intensity: 16, range: 10 } } })], { what: 'place a light', expect: false });   // a touch off the floor: a hanging bulb
  else sent = Edits.sendOps([OP.create(id, { model: ghost.lib, transform: { pos: [p.x, p.y, p.z], q: [0, Math.sin(ghost.yaw / 2), 0, Math.cos(ghost.yaw / 2)], scale: ghost.scale } })], { what: `place ${libLabels.get(ghost.lib) ?? ghost.lib}`, expect: false });
  // what you just placed is the selection, so you can tweak it straight away (review 10-07 S7; Roblox, Unity and Godot
  // select what was inserted). A blueprint copy selects its root: the first thing the authority names that rides nothing
  // else it made. The thing arrives a frame or two after the reply.
  const bp = !!ghost.bp;
  Promise.resolve(sent).then((r) => {
    if (!r?.ok) return;
    const made = (r.refs ?? []).map((x) => x.id);
    const pick = bp ? made.find((x) => !made.includes(state.st.entities?.[x]?.parent?.to)) ?? made[0] : id;
    if (pick) selectWhenHere(pick);
  });
  cancelGhost();
}
function selectWhenHere(id, ms = 3000) {
  const t0 = performance.now();
  const go = () => { if (entities.has(id)) { if (editMode) Sel.set([id]); return; } if (performance.now() - t0 < ms) setTimeout(go, 60); };
  go();
}

// ---- lock: `comp {id, type: "lock", data: true}` nails a thing down. The
// SERVER is the enforcement (it refuses place/remove/punt/mount/spawn/light
// on a locked id for everyone, locker included); these guards keep the local
// gesture honest — no preview that would have to snap back on refusal, and a
// hint that teaches the unlock instead of a silent dead hand.
function isLocked(id) { return !!bagOf(id)?.lock; }
function commitPlace(before) {
  if (!selected) return;
  const o = selected.obj;
  // the drag was presence; the release is ONE request (the whole transform, local for a child), expecting where it started
  const id = selected.id;
  Edits.sendOps([OP.setTransform(state.st.entities?.[id] ?? {}, id, { pos: [o.position.x, o.position.y, o.position.z], q: o.quaternion.toArray(), scale: scaleOf(o) })],
    { what: `move ${id}`, base: before.comps ? { [id]: before.comps } : null, revert: () => Edits.revertPose(id) });
}

const _up = new THREE.Vector3(0, 1, 0), _turn = new THREE.Quaternion(), _q = new THREE.Quaternion();
function snapshotOf(obj) {
  return { pos: [obj.position.x, obj.position.y, obj.position.z], yaw: new THREE.Euler().setFromQuaternion(obj.quaternion, 'YXZ').y, q: obj.quaternion.toArray(), scale: scaleOf(obj) };
}

export function undo() {
  // the authority's undo {act} of MY last act (it refuses what others changed since)
  deselect(); return Edits.undo();
}

// Edit mode's panels own the selection the inspector SHOWS (a tree pick sets
// it without touching `selected`, which only a viewport pick sets). editpanels
// installs its remover here — it can't be imported (editpanels imports us).
// Without it, Del after a tree pick removed nothing, or the last thing picked
// in the viewport while the inspector showed another.
let removeHook = null;
export function setRemoveHook(fn) { removeHook = fn; }
/** What the keys act on: the inspector's selection, else the viewport's. */
const keyTarget = () => primaryThing();
/** Edit ▸ delete: the same act as the Del key. */
export function removeKeyTargets() { if (keyTarget()) removeTargets(); }
function removeTargets() {
  if (removeHook) { if (removeHook()) deselect(); return; }
  removeSelected();
}

function removeSelected() {
  if (!selected) return;
  Edits.del([selected.id]); deselect();   // a locked thing: the authority asks ("This is locked. Delete anyway?")
}

// ============================================================ pointer

let barePress = null;
addEventListener('mouseup', (e) => {
  const p = barePress; barePress = null;
  if (!p || !editMode || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) return;
  // a click on empty space clears THE selection (the Hierarchy's too), not only the viewport's pick
  deselectAll(); if (seatSelected()) deselectSeat();
});
// BOX SELECT (R 10-11 00:18: "shift-select-drag draw a bounding box around objects to select them"): Shift-drag on bare
// space draws a box and ADDS every thing whose centre lands inside it (hidden ones, and layers I've switched off for
// clicks, aren't caught). A plain bare drag still orbits.
let marquee = null; const _mc = new THREE.Vector3(), _mb = new THREE.Box3();
function marqueeMove(e) { if (!marquee) return; const x0 = Math.min(marquee.x, e.clientX), y0 = Math.min(marquee.y, e.clientY);
  Object.assign(marquee.el.style, { left: `${x0}px`, top: `${y0}px`, width: `${Math.abs(e.clientX - marquee.x)}px`, height: `${Math.abs(e.clientY - marquee.y)}px`, display: 'block' }); }
function marqueeEnd(e) { const m = marquee; marquee = null; if (!m) return; m.el.remove(); removeEventListener('mousemove', marqueeMove); removeEventListener('mouseup', marqueeEnd);
  if (Math.hypot(e.clientX - m.x, e.clientY - m.y) < 5) return;
  const x0 = Math.min(m.x, e.clientX), x1 = Math.max(m.x, e.clientX), y0 = Math.min(m.y, e.clientY), y1 = Math.max(m.y, e.clientY); const ids = [];
  const W = state.st?.entities ?? {};
  for (const [id, o] of entities) { if (!o || !o.visible || outOfMyView(o) || !clickable(W, id)) continue; _mb.setFromObject(o); if (_mb.isEmpty()) continue;
    _mb.getCenter(_mc).project(camera); if (_mc.z > 1) continue;
    const sx = (_mc.x + 1) / 2 * innerWidth, sy = (1 - _mc.y) / 2 * innerHeight; if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) ids.push(id); }
  if (ids.length) bus.emit('edit-select-add', ids); }
export const marqueeActive = () => !!marquee;

/** The nearest hit under a viewport point (NDC) on a thing MY selection layers let me click (selectmask.js; the floor is
 *  'environment', off at first) and that is in my view (a thing hidden with the eye is not drawn, so not clicked). */
function pickHit(nx, ny) {
  mouse.set(nx, ny);
  raycaster.setFromCamera(mouse, camera);
  const targets = [];
  for (const o of entities.values()) if (o) targets.push(o);
  const W = state.st?.entities ?? {};   // the editor's world view (lib, comp, parent), as editpanels reads it
  return raycaster.intersectObjects(targets, true).find((h) => { let r = h.object; while (r && !r.userData.entityId) r = r.parent; return r && clickable(W, r.userData.entityId) && !outOfMyView(h.object); }) ?? null;
}
/** What a viewport click at NDC (nx, ny) would select: its id, or null. */
export function pickAt(nx, ny) { let r = pickHit(nx, ny)?.object; while (r && !r.userData.entityId) r = r.parent; return r?.userData.entityId ?? null; }

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !editMode) return;  // outside edit mode the canvas is for looking
  if (e.altKey) return;   // Alt+drag is the camera's (controller.js: orbit / pan / dolly)   // keys: editCamera
  // an armed seat placement outranks everything, the ghost included
  if (seatArmed()) { seatMouseDown(e); e.preventDefault(); return; }
  if (ghost) return;                        // click-to-place handled on click
  // gizmo picks next — a marker is small and deliberate, and the mesh it
  // floats over would otherwise win every contested click
  if (seatMouseDown(e)) { e.preventDefault(); return; }
  if (pointerVeto()) return;                // a gizmo handle under the pointer owns this press
  // Pick from THIS event's coordinates. Relying on the last mousemove to have
  // left `mouse` in the right place works for a real pointer and fails for
  // anything that presses without moving first — a touch, a synthetic click,
  // a tab that regained focus under the cursor.
  const hit = pickHit((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  // a press on nothing: a DRAG from here orbits the camera; only a click that didn't travel deselects (an orbit that
  // threw away the selection every time would make looking around a thing impossible)
  if (!hit && e.shiftKey) { const d = document.createElement('div');   // keys: selectExtend
    d.className = 'edit-marquee'; d.style.display = 'none'; document.body.append(d);
    marquee = { x: e.clientX, y: e.clientY, el: d }; addEventListener('mousemove', marqueeMove); addEventListener('mouseup', marqueeEnd); e.preventDefault(); return; }
  if (!hit) { barePress = { x: e.clientX, y: e.clientY }; bus.emit('edit-bare-press'); return; }
  if (seatSelected()) deselectSeat();
  let root = hit.object;
  while (root && !root.userData.entityId) root = root.parent;
  if (!root) return;
  const id = root.userData.entityId;
  // Ctrl-click EXTENDS the selection (editpanels owns the set; Shift is the
  // vertical drag here, so it can't double as the extend modifier it is in
  // the tree). No drag starts from an extend.
  if (e.ctrlKey || e.metaKey) { bus.emit('edit-extend', id); e.preventDefault(); return; }   // keys: selectExtend
  // Shift: a click adds it to (or takes it from) the selection, as in the tree (R 10-11); a Shift press that TRAVELS is
  // still the vertical drag, so the thing is selected only once it starts to move
  const shiftPick = e.shiftKey && !!primaryThing() && primaryThing() !== id;   // keys: selectExtend
  if (!shiftPick) select(id);
  // A press is a SELECT. It only becomes a drag once the pointer actually
  // travels — otherwise clicking a thing to look at its label moved it.
  const aim = aimPoint(id);
  // the drag reckons in WORLD space (a mounted child's object position is in its parent's frame)
  const world = true;
  const at = root.getWorldPosition(new THREE.Vector3());
  dragging = {
    id,
    world,
    // the components this gesture starts from: the release's `expect`
    before: { ...snapshotOf(root), comps: Edits.compsOf(id) },
    lastSent: 0,
    armed: false,
    startX: e.clientX,
    startY: e.clientY,
    clientY: e.clientY,
    // Shift held at grab = a VERTICAL drag: the ground-plane raycast can't
    // express height, so hold Shift and the pointer's up/down maps to world Y
    // with the horizontal position pinned. The standard editor gesture.
    vertical: e.shiftKey,   // keys: meshMove
    shiftPick,
    clientX: e.clientX,
    startYaw: root.rotation.y,
    startQuat: root.quaternion.clone(),
    startScale: root.scale.clone(),
    startPos: at,
    depth: camera.position.distanceTo(at),
    grab: aim ? at.clone().sub(aim.point) : new THREE.Vector3(),
  };
  e.preventDefault();
});

// Arm the drag only after a few pixels of travel — the same threshold every
// desktop UI uses to tell a click from a drag.
const DRAG_SLOP = 4;
addEventListener('mousemove', (e) => {
  if (!dragging) return;
  dragging.clientY = e.clientY;                 // vertical drag reads this each frame
  dragging.clientX = e.clientX;                 // rotate/scale tools read this one
  if (tool === 'select') return;                // select: a press picks, travel never moves
  if (!dragging.armed
      && Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) > DRAG_SLOP) {
    // the press selected it; travel is where a move would begin — a locked
    // thing refuses here, before any preview exists to snap back
    dragging.armed = true;
    if (dragging.shiftPick) { select(dragging.id); dragging.shiftPick = false; }
    engage('meshMove');
  }
});

addEventListener('mouseup', () => {
  if (dragging && !dragging.armed && dragging.shiftPick) bus.emit('edit-extend', dragging.id);
  if (dragging?.armed) release();
  if (dragging?.armed && selected) {
    const moved = dragging.before;
    const o = selected.obj;
    const same = Math.abs(o.position.x - moved.pos[0]) < 0.005
      && Math.abs(o.position.y - moved.pos[1]) < 0.005
      && Math.abs(o.position.z - moved.pos[2]) < 0.005
      && o.quaternion.angleTo(_q.fromArray(moved.q)) < 1e-4
      && JSON.stringify(scaleOf(o)) === JSON.stringify(moved.scale);
    if (!same) commitPlace(moved);          // release commits ONE clean entry
  }
  // the last sample says so: others drop the claim at once rather than after CLAIM_MS
  if (dragging?.armed) { const o = entities.get(dragging.id); if (o) sendDrag(dragging.id, o.position.toArray(), new THREE.Euler().setFromQuaternion(o.quaternion, 'YXZ').y, o.quaternion.toArray(), { end: true }); }
  dragging = null;
});

canvas.addEventListener('click', (e) => {
  if (!ghost || !editMode) return;
  commitSpawn();
  e.preventDefault();
});

// ============================================================ keys

/** Something mid-gesture that Esc should cancel before anything else (gizmo.js). */
// Esc goes to each hook in turn, newest first (the grip editor, then the gizmo's drag); the first that takes it ends it
const escapeHooks = [];
const escapeHook = () => escapeHooks.some((f) => f());
export function setEscapeHook(fn) { escapeHooks.unshift(fn); }
bus.on('key', (e) => {
  if (e.code === 'Escape') {
    // §3a: Esc during a drag cancels it and writes nothing; the thing goes back to where the log has it
    if (dragging?.armed) { const id = dragging.id; dragging = null; Edits.revertPose(id); flashHint('move cancelled — nothing written'); return; }
    if (escapeHook()) return;
    if (structureTool()) setStructureTool(null);   // an armed building tool drops first (the viewport strip says "Esc to drop")
    else if (cancelSeatArm()) { /* an armed placement is the most transient state */ }
    else if (ghost) cancelGhost();
    else if (seatSelected()) deselectSeat();
    else if (primaryThing()) deselectAll();
    else if (editMode) setEditMode(false);
    return;
  }
  // Undo stays available outside edit mode — you may only notice the mistake
  // after you have gone back to looking.
  // redo is Ctrl+Shift+Z or Ctrl+Y (the authority's undo of my undo)
  if ((e.ctrlKey || e.metaKey) && ((e.code === 'KeyZ' && e.shiftKey) || e.code === 'KeyY')) {   // keys: undo
    e.preventDefault?.(); Edits.redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }   // keys: undo
  if (!editMode) return;

  // reset the selection's transform (editpanels.resetTransform): the tools' own letters with Alt, and Ctrl+G for all
  // three. Before the tool keys, which ignore modifiers.
  if (e.altKey && !e.ctrlKey && !e.metaKey && ['KeyG', 'KeyE', 'KeyR'].includes(e.code)) { e.preventDefault(); bus.emit('edit-reset', { KeyG: 'pos', KeyE: 'rot', KeyR: 'scale' }[e.code]); return; }   // keys: resetTransform
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyG') { e.preventDefault(); bus.emit('edit-reset', 'all'); return; }   // keys: resetTransform
  // the thing in hand holds Q / E and , / . before the tools do (they'd switch tool mid-aim)
  if (ghostKey(e)) return;
  // a selected seat anchor holds the editing keys before things do
  if (seatKeyDown(e)) return;
  // Tool keys, every one OFF the walking set (the camera here is a BODY and
  // WASD walks — Maya's W and Blender's S both collide, found in review):
  // G move (Blender), E rotate and R scale (Maya), Q select, F find, X or Del
  // removes, Esc steps out, B toggles the mode. The old per-key nudges (Q/E
  // turn, ,/. size, R/F raise) are retired; the tools do those with a drag.
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {   // keys: toolKeys
    const t = { KeyQ: 'select', KeyG: 'move', KeyE: 'rotate', KeyR: 'scale', KeyP: 'pivot' }[e.code];   // P: the pivot (Maya's D; D walks here)
    if (t) {   // the active tool's key again steps its space (G G: move in the thing's own axes), saying so
      if (t === getTool() && SPACES[t]?.length > 1) { const s = cycleSpace(t); flashHint(html`${t} in <b>${s}</b> axes · ${{ move: 'G', rotate: 'E' }[t]} again to switch`, 2200); return; }
      setTool(t); return;
    }
    if (e.code === 'KeyF' && keyTarget()) { bus.emit('edit-find', keyTarget()); return; }
    if (e.code === 'KeyX' && keyTarget()) { removeTargets(); return; }
  }
  if ((e.code === 'Delete' || e.code === 'Backspace') && keyTarget()) { e.preventDefault?.(); removeTargets(); }
});
