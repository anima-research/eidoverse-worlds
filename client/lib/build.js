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
// (palette.js models+avatars+upload, groundpanel.js, skypanel.js), and the
// seat-anchor grammar in seatedit.js; the router here hands seat gestures
// across that seam and never re-implements them.

import { THREE, scene, camera, canvas } from './core.js';
import { bus, report } from './base.js';
import { loadGLB, libLabels } from './assets.js';
import { makeLightGizmo } from './lights.js';
import { entities, entityMeta, comps, editHolds } from './world.js';
import { reindexCollider } from './colliders.js';
import { heightAt } from './terrain.js';
import { net, sendVerb, sendVerbs, sendDrag } from './net.js';
import { scaleOf } from '../../shared/scale3.js';
import { placeVerbs, placeRefusal } from '../../shared/blueprint.js';
import { myState, mouse, setPointerClaim, setEditingProbe } from './controller.js';
import { flashHint, collapseAll, panelFrame } from './ui.js';
import { sceneSelect, sceneSelected, sceneDeselect } from './scenegraph.js';
import { claimEscape } from './frames.js';
import { currentTool as structureTool, setTool as setStructureTool } from './structure_ui.js';   // an armed building tool is Esc's first rung
import { mayAuthor, placerOf, placerName } from './placer.js';
import { state } from './state.js';   // one rule for who may author (and one name for them), shared with the scene panel
import * as V4 from './v4edit.js';   // protocol/v4 slice 3b: in a v4 world every write here is a door request
import { refreshSeatGizmos, resetSeats, armSeatPlacement, seatArmed, seatSelected,
  cancelSeatArm, deselectSeat, seatMouseDown, seatKeyDown, updateSeatDrag } from './seatedit.js';

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hit = new THREE.Vector3();

// ============================================================ state

let ghost = null;         // { obj, lib, yaw, scale, bp? } — a thing not yet placed (bp: a blueprint copy, {hash, record})
let selected = null;      // { id, obj, box } — a placed thing under edit
let dragging = null;      // { id, offset, plane } while moving a selection
const undoStack = [];     // inverse entries, newest last

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
 * conjure.js:144 (`net.myRights?.gen !== false`) is the house idiom and this
 * follows it. net.myRights has no declaration in net's object literal; it is
 * assigned at the snapshot (net.js:697) or a live grant (:468), so it is
 * `undefined` for the whole pre-snapshot window. Treating that as denial would
 * make holdGhost() silently do nothing on a slow join — a build click that
 * vanishes is worse than one that is refused out loud.
 */
export const mayEdit = () => {
  const role = net.myRights?.role;
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
    if (!quiet) flashHint('edit mode needs build rights in this world');
    return editMode;
  }
  if (editMode === on) return editMode;
  editMode = on;
  document.body.classList.toggle('edit-mode', on);
  if (!on) { cancelGhost(); deselect(); resetSeats(); }
  refreshSeatGizmos();   // anchors are visible exactly while you are editing
  // Saying you are building should put the tools in front of you — B is now
  // the mode, so the catalog needs to arrive with it rather than behind a
  // separate keystroke nobody will guess.
  if (on) panelFrame().show();
  if (!quiet) {
    flashHint(on
      ? 'edit mode — <kbd>G</kbd> move · <kbd>E</kbd> rotate · <kbd>R</kbd> scale · <kbd>Q</kbd> select · <kbd>F</kbd> find · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>B</kbd> leaves'
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
export function setTool(t) {
  if (!['select', 'move', 'rotate', 'scale'].includes(t) || t === tool) return tool;
  tool = t;
  bus.emit('tool', tool);
  return tool;
}
export const hasGhost = () => ghost !== null;
export const hasSelection = () => selected !== null;
setPointerClaim(() => ghost !== null || !!dragging?.armed);
// the gizmo (gizmo.js) vetoes the mesh-grab while one of its handles is hot —
// a probe, not an import: gizmo imports us
let pointerVeto = () => false;
export function setPointerVeto(fn) { pointerVeto = fn; }
setEditingProbe(() => editMode);

// ============================================================ selection

const outline = new THREE.Box3Helper(new THREE.Box3(), 0x8fe8c8);
outline.visible = false;
outline.userData.noCamCollide = true;
scene.add(outline);

let inspector = null;
function ensureInspector() {
  if (!inspector) {
    inspector = document.createElement('div');
    inspector.className = 'panel';
    inspector.style.cssText = `position:fixed; left:50%; bottom:64px; transform:translateX(-50%);
      z-index:7; padding:9px 13px; font-size:var(--fs-sm); display:flex; gap:14px; align-items:center;`;
    document.body.appendChild(inspector);
  }
  return inspector;
}
/** The inspector bar as a surface other editors write to — seatedit paints
 *  its anchor line through this rather than reaching into the element. */
export function setInspectorHtml(html) {
  ensureInspector().innerHTML = html;
  inspector.style.display = 'flex';
}
function showInspector(id) {
  const meta = entityMeta.get(id) ?? {};
  ensureInspector();
  const label = libLabels.get(meta.lib) ?? meta.lib?.split('/').pop()?.replace(/\.glb$/, '') ?? id;
  const locked = isLocked(id);
  const guarded = isGuarded(id);
  const mine = mayAuthor(id);
  // a thing guarded by someone else is read-only here: the server would
  // refuse every edit, so the controls say so before the round-trip
  const held = guarded && !mine;
  // attribution names the PLACER (the stamped principal); `actor` is whoever
  // last wrote the entity, which an owner's re-light moves — say so when
  // they differ rather than letting "by" mean two things
  const who = placerOf(id)?.id ?? meta.actor ?? '?';
  const lastBy = meta.actor && meta.actor !== who ? ` · last change by ${meta.actor}` : '';
  inspector.innerHTML =
    `<span><b>${label.slice(0, 34)}</b></span>` +
    `<span style="color:var(--dim)">placed by ${who}${lastBy}</span>` +
    (held
      ? `<span style="color:var(--dim)">🛡 guarded by ${placerName(id)} — only they or the world's owner can change, move or remove it</span>`
      : locked
        ? `<span style="color:var(--dim)">🔒 locked — nothing moves or removes it until unchecked</span>`
        : `<span style="color:var(--dim)">drag move · <kbd>Shift</kbd>+drag up/down · ` +
          `<kbd>G</kbd> move · <kbd>E</kbd> rotate · <kbd>R</kbd> scale · <kbd>F</kbd> find · <kbd>X</kbd> remove · <kbd>Esc</kbd> done</span>`) +
    `<label title="nail it down: while locked, nobody's drags, verbs or scripts can move, replace or remove it (server-enforced) — sitting on it and content edits stay open" style="display:flex;gap:4px;align-items:center;cursor:pointer">` +
    `<input type="checkbox" data-bact="lock"${locked ? ' checked' : ''}${held ? ' disabled' : ''}> 🔒 lock</label>` +
    `<label title="${mine
      ? 'make it yours to author: while guarded, only you, the world\'s owner, or an operator can change its components, move it, remove it, or bind scripts to it (server-enforced) — using it and sitting on it stay open for everyone'
      : `only ${placerName(id)} or the world's owner can set or clear the guard on this`}" style="display:flex;gap:4px;align-items:center;cursor:${mine ? 'pointer' : 'not-allowed'}">` +
    `<input type="checkbox" data-bact="guard"${guarded ? ' checked' : ''}${mine ? '' : ' disabled'}> 🛡 guard</label>` +
    `<button data-bact="seat" title="declare a sit anchor: click the spot where a sitter goes"${held ? ' disabled' : ''}>+ seat</button>`;
  // a v4 world has no guard (PROTOCOL-v4 §5 merged it into lock; the door refuses it by name): don't offer it
  if (V4.isV4()) inspector.querySelector('[data-bact="guard"]')?.closest('label')?.remove();
  inspector.querySelector('[data-bact="lock"]').onchange = (ev) => {
    const on = ev.target.checked;
    if (V4.isV4()) { V4.lock(id, on).then(() => { if (selected?.id === id) showInspector(id); }); return; }
    sendVerb('comp', { id, type: 'lock', data: on ? true : null });
    flashHint(on ? `🔒 <b>${label.slice(0, 34)}</b> locked — nothing moves it until you uncheck` : `🔓 unlocked`);
    // the echo folds the comp; repaint the hint line once it lands
    setTimeout(() => { if (selected?.id === id) showInspector(id); }, 400);
  };
  const guardBox = inspector.querySelector('[data-bact="guard"]');
  if (guardBox) guardBox.onchange = (ev) => {
    const on = ev.target.checked;
    sendVerb('comp', { id, type: 'guard', data: on ? true : null });
    flashHint(on ? `🛡 <b>${label.slice(0, 34)}</b> guarded — only you or the world's owner can change it now` : `🛡 guard cleared — any builder can change it again`);
    setTimeout(() => { if (selected?.id === id) showInspector(id); }, 400);
  };
  inspector.querySelector('[data-bact="seat"]').onclick = () => armSeatPlacement(selected?.id ?? id);
  inspector.style.display = 'flex';
}
export function hideInspector() { if (inspector) inspector.style.display = 'none'; }

export function select(id) {
  const obj = entities.get(id);
  if (!obj) return;
  selected = { id, obj };
  // the residency sweep must never demote what someone is editing — id-based
  // because promotion swaps the object out from under a userData flag
  editHolds.add(id);
  outline.box.setFromObject(obj);
  outline.visible = true;
  showInspector(id);
  // the scene panel follows the mouse: selecting a thing opens its row —
  // transform fields, semantic editors, comp bag — scrolled into view
  sceneSelect(id);
}
/** The deliberate deselect (Esc, Edit ▸ deselect): the viewport pick AND what the
 *  inspector shows. Plain deselect() stays viewport-only — undo calls it, and an undo
 *  must not throw away the selection you are working on. */
export function deselectAll() { deselect(); sceneDeselect(); }
export function deselect() {
  if (selected) editHolds.delete(selected.id);
  selected = null;
  dragging = null;
  outline.visible = false;
  hideInspector();
}
export function refreshOutline() {
  if (selected) outline.box.setFromObject(selected.obj);
}
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

export async function holdGhost(lib, label) {
  setEditMode(true, { quiet: true });   // choosing a thing to place is intent enough
  cancelGhost();
  deselect();
  try {
    let obj;
    if (lib === '@light') {
      obj = makeLightGizmo(0xffd9a0);
      obj.traverse((o) => { if (o.material) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.7; } });
    } else {
      obj = await loadGLB(lib);
      ghostify(obj);
    }
    ghost = { obj, lib, yaw: 0, scale: 1 };
    scene.add(obj);
    collapseAll();
    flashHint(lib === '@light'
      ? 'placing a <b>light</b> — click to place · <kbd>Esc</kbd> cancel'
      : `placing <b>${label ?? ''}</b> — click to place, then <kbd>E</kbd> rotate / <kbd>R</kbd> scale · <kbd>Esc</kbd> cancel`, 6000);
  } catch (e) { report('ghost', e); }
}

/** Carry a COPY of a blueprint as the ghost (design §3, step 6b): the whole tree,
 *  each part at its local pose under its parent — the same nesting the renderer
 *  builds for a mounted child — so what you aim is what lands. Committing places
 *  it as ordinary verbs (shared/blueprint.js placeVerbs), one Ctrl+Z step. */
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
    flashHint(`placing a copy of <b>${record.name}</b>${n > 1 ? ` (${n} parts)` : ''} — click to place, then <kbd>E</kbd> rotate / <kbd>R</kbd> scale · <kbd>Esc</kbd> cancel`, 6000);
    return true;
  } catch (e) { report('ghost', e); return false; }
}

/** Place a copy at a pose with no ghost (the VR body has no cursor to carry one;
 *  an agent says where). One undo step. Returns the plan, or null when refused. */
export function placeBlueprint(hash, record, at, label = record?.name) {
  const plan = placeVerbs(record, at, { hash, taken: (x) => entities.has(x) || !!state.st.entities?.[x] });
  if (plan.errors.length) { flashHint(`can't place it: ${plan.errors.join(' · ')}`, 5000); return null; }
  sendVerbs(plan.verbs);
  pushUndo({ verbs: plan.inverses }, `placing ${label}`);
  bus.emit('blueprint-placed', { hash, root: at.id, parts: plan.parts, verbs: plan.verbs.length });
  return plan;
}

export function cancelGhost() {
  if (ghost) { scene.remove(ghost.obj); ghost = null; }
}

/** Where the pointer is aiming, snapped onto whatever surface is under it.
 *  Raycasting real entities first is what turns "drops at y=0 beside the
 *  table" into "lands on the table". */
function aimPoint(skipId = null) {
  raycaster.setFromCamera(mouse, camera);
  const targets = [];
  for (const [id, o] of entities) if (o && id !== skipId) targets.push(o);
  let hits = raycaster.intersectObjects(targets, true);
  // v4: a mounted child is drawn INSIDE its parent's object, so the parent's recursive hit test would find the very
  // thing being dragged under the pointer (and it would climb toward the camera). Skip its whole subtree.
  const skipObj = V4.isV4() && skipId != null ? entities.get(skipId) : null;
  if (skipObj) hits = hits.filter((h) => { for (let o = h.object; o; o = o.parent) if (o === skipObj) return false; return true; });
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
          // v4: the grab offset, the aim and the result are WORLD points; a mounted child's object position is local
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
globalThis.__buildDrag = () => (dragging ? { id: dragging.id, armed: dragging.armed, world: !!dragging.world, tool } : null);   // harness window (tools/v4/client-check.ts F)
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

// remote drags: apply transiently, no log involvement
bus.on('drag', ({ id, pos, yaw, q }) => {
  const obj = entities.get(id);
  if (!obj) return;
  obj.position.set(...pos);
  if (Array.isArray(q) && q.length === 4) obj.quaternion.set(q[0], q[1], q[2], q[3]);   // the rotate gizmo's full turn
  else if (yaw != null) obj.rotation.y = yaw;
  reindexCollider(id);
});

// ============================================================ commits + undo

/** Exported for the sibling editors (seatedit) — one stack, one Ctrl+Z. */
export function pushUndo(inverse, describe) {
  undoStack.push({ inverse, describe });
  while (undoStack.length > 40) undoStack.shift();
}

function commitSpawn() {
  const p = ghost.obj.position;
  const id = crypto.randomUUID().slice(0, 8);
  if (V4.isV4()) {   // one door request: create (a model or a light), or create {from} for a blueprint copy
    const verbs = ghost.bp ? null : ghost.lib === '@light'
      ? [{ verb: 'light', args: { id, pos: [p.x, p.y + 0.9, p.z], color: 0xffd9a0, intensity: 16, range: 10 } }]
      : [{ verb: 'spawn', args: { id, lib: ghost.lib, pos: [p.x, p.y, p.z], yaw: ghost.yaw, ...(ghost.scale !== 1 ? { scale: ghost.scale } : {}) } }];
    if (ghost.bp) V4.copyBlueprint(ghost.bp.hash, { pos: [p.x, p.y, p.z], q: [0, Math.sin(ghost.yaw / 2), 0, Math.cos(ghost.yaw / 2)] });
    else V4.sendVerbsV4(verbs, { what: ghost.lib === '@light' ? 'place a light' : `place ${libLabels.get(ghost.lib) ?? ghost.lib}`, expect: false });
    cancelGhost();
    return;
  }
  if (ghost.bp) {
    const { hash, record } = ghost.bp;
    const plan = placeBlueprint(hash, record, { id, pos: [p.x, p.y, p.z], yaw: ghost.yaw, scale: ghost.scale });
    if (plan && plan.verbs.length > 10) flashHint(`placing <b>${record.name}</b> — ${plan.verbs.length} verbs, paced under the world's rate limit`, 3000);
    cancelGhost();
    return;
  }
  if (ghost.lib === '@light') {
    // lift a placed light off the floor a touch so it reads as a hanging bulb
    sendVerb('light', { id, pos: [p.x, p.y + 0.9, p.z], color: 0xffd9a0, intensity: 16, range: 10 });
    pushUndo({ verb: 'remove', args: { id } }, 'light');
    cancelGhost();
    return;
  }
  sendVerb('spawn', {
    id, lib: ghost.lib,
    pos: [p.x, p.y, p.z], yaw: ghost.yaw,
    ...(ghost.scale !== 1 ? { scale: ghost.scale } : {}),
  });
  pushUndo({ verb: 'remove', args: { id } }, 'spawn');
  cancelGhost();
}

// ---- lock: `comp {id, type: "lock", data: true}` nails a thing down. The
// SERVER is the enforcement (it refuses place/remove/punt/mount/spawn/light
// on a locked id for everyone, locker included); these guards keep the local
// gesture honest — no preview that would have to snap back on refusal, and a
// hint that teaches the unlock instead of a silent dead hand.
function isLocked(id) { return !!comps.get(id)?.lock; }
// ---- guard: `comp {id, type: "guard", data: true}` makes a thing its
// placer's to author. The SERVER is the enforcement (rights.ts guardRefusal:
// comps, motion, behaviors, moves, removal and replacement refused for anyone
// but the placer, the world's owner, or an operator); here the same answer
// keeps the gesture honest, and the hint names who may instead of a dead hand.
function isGuarded(id) { return !!comps.get(id)?.guard; }
function lockedHint(id) {
  if (isGuarded(id) && !mayAuthor(id)) {
    flashHint(`🛡 <b>guarded</b> by ${placerName(id)} — only they or the world's owner can move or change it`);
    return true;
  }
  // v4: the door is asked, and a person who may lift the lock gets "This is locked. Move anyway?" (v4edit.send)
  if (!isLocked(id) || V4.isV4()) return false;
  flashHint('🔒 <b>locked</b> — uncheck <b>lock</b> in the inspector to move or remove it');
  return true;
}

function commitPlace(before) {
  if (!selected) return;
  if (lockedHint(selected.id)) {
    // the world never moved — put the local preview back where the log says
    const o = selected.obj;
    o.position.set(...before.pos); o.quaternion.fromArray(before.q); o.scale.setScalar(before.scale);
    reindexCollider(selected.id); refreshOutline();
    return;
  }
  const o = selected.obj;
  if (V4.isV4()) {   // the drag was presence; the release is ONE request, with expect on where it started (§3a)
    const id = selected.id;
    V4.sendVerbsV4([{ verb: 'place', args: { id, pos: [o.position.x, o.position.y, o.position.z], q: o.quaternion.toArray(), scale: scaleOf(o) } }],
      { what: `move ${id}`, base: before.v4 ? { [id]: before.v4 } : null, revert: () => V4.revertPose(id) });
    return;
  }
  // a thing the fold knows by q is placed by q (a bare yaw would only turn it
  // about up, PROTOCOL §9.1); a yaw-only thing stays upright here, so a yaw
  const rec = state.st.entities?.[selected.id];
  const tilted = !!rec?.q;
  const { q: _bq, v4: _v4, ...beforeYaw } = before;
  sendVerb('place', {
    id: selected.id,
    pos: [o.position.x, o.position.y, o.position.z],
    ...(tilted ? { q: o.quaternion.toArray() } : {}),
    yaw: new THREE.Euler().setFromQuaternion(o.quaternion, 'YXZ').y,
    scale: scaleOf(o),
  });
  pushUndo({ verb: 'place', args: { id: selected.id, ...(tilted ? before : beforeYaw) } }, 'move');
}

const _up = new THREE.Vector3(0, 1, 0), _turn = new THREE.Quaternion(), _q = new THREE.Quaternion();
function snapshotOf(obj) {
  return { pos: [obj.position.x, obj.position.y, obj.position.z], yaw: new THREE.Euler().setFromQuaternion(obj.quaternion, 'YXZ').y, q: obj.quaternion.toArray(), scale: scaleOf(obj) };
}

export function undo() {
  // a v4 world: the door's undo {act} of MY last act (it refuses what others changed since)
  if (V4.isV4()) { deselect(); return V4.undo(); }
  const step = undoStack.pop();
  if (!step) { flashHint('nothing to undo'); return; }
  // Undo is inverse ENTRIES — history stays append-only, which is what keeps
  // the log replayable and the world forkable.
  // a compound inverse ({verbs: [...]}) undoes a multi-selection edit as ONE step
  // paced (net.js sendVerbs): undoing a placed blueprint copy is a remove per part,
  // more than the door's rate limit lets through at once
  sendVerbs(step.inverse.verbs ?? [step.inverse]);
  flashHint(`undid ${step.describe}`);
  deselect();
}

// Edit mode's panels own the selection the inspector SHOWS (a tree pick sets
// it without touching `selected`, which only a viewport pick sets). editpanels
// installs its remover here — it can't be imported (editpanels imports us).
// Without it, Del after a tree pick removed nothing, or the last thing picked
// in the viewport while the inspector showed another.
let removeHook = null;
export function setRemoveHook(fn) { removeHook = fn; }
/** What the keys act on: the inspector's selection, else the viewport's. */
const keyTarget = () => sceneSelected() ?? selected?.id ?? null;
/** Edit ▸ delete: the same act as the Del key. */
export function removeKeyTargets() { if (keyTarget()) removeTargets(); }
function removeTargets() {
  if (removeHook) { if (removeHook()) deselect(); return; }
  removeSelected();
}

function removeSelected() {
  if (!selected) return;
  if (lockedHint(selected.id)) return;   // an accidental Del is the worst accident
  if (V4.isV4()) { V4.del([selected.id]); deselect(); return; }
  const meta = entityMeta.get(selected.id) ?? {};
  const { q, ...upright } = snapshotOf(selected.obj);
  const snap = state.st.entities?.[selected.id]?.q ? { ...upright, q } : upright;   // q only for a thing the fold knew tilted
  sendVerb('remove', { id: selected.id });
  pushUndo({ verb: 'spawn', args: { id: selected.id, lib: meta.lib, ...snap } }, 'removal');
  deselect();
}

// ============================================================ pointer

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !editMode) return;  // outside edit mode the canvas is for looking
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
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const targets = [];
  for (const o of entities.values()) if (o) targets.push(o);
  const hit = raycaster.intersectObjects(targets, true)[0];
  if (!hit) { if (selected) deselect(); if (seatSelected()) deselectSeat(); return; }
  if (seatSelected()) deselectSeat();
  let root = hit.object;
  while (root && !root.userData.entityId) root = root.parent;
  if (!root) return;
  const id = root.userData.entityId;
  // Ctrl-click EXTENDS the selection (editpanels owns the set; Shift is the
  // vertical drag here, so it can't double as the extend modifier it is in
  // the tree). No drag starts from an extend.
  if (e.ctrlKey || e.metaKey) { bus.emit('edit-extend', id); e.preventDefault(); return; }
  select(id);
  // A press is a SELECT. It only becomes a drag once the pointer actually
  // travels — otherwise clicking a thing to look at its label moved it.
  const aim = aimPoint(id);
  // v4: the drag reckons in WORLD space (a mounted child's object position is in its parent's frame); v1 keeps the
  // object-position maths it always had (and its known child-drag bug: research 43 "Left")
  const world = V4.isV4();
  const at = world ? root.getWorldPosition(new THREE.Vector3()) : entities.get(id).position.clone();
  dragging = {
    id,
    world,
    // v4: the components this gesture starts from: the release's `expect`
    before: V4.isV4() ? { ...snapshotOf(root), v4: V4.compsOf(id) } : snapshotOf(root),
    lastSent: 0,
    armed: false,
    startX: e.clientX,
    startY: e.clientY,
    clientY: e.clientY,
    // Shift held at grab = a VERTICAL drag: the ground-plane raycast can't
    // express height, so hold Shift and the pointer's up/down maps to world Y
    // with the horizontal position pinned. The standard editor gesture.
    vertical: e.shiftKey,
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
    if (lockedHint(dragging.id)) { dragging = null; return; }
    dragging.armed = true;
  }
});

addEventListener('mouseup', () => {
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
  dragging = null;
});

canvas.addEventListener('click', (e) => {
  if (!ghost || !editMode) return;
  commitSpawn();
  e.preventDefault();
});

// ============================================================ keys

/** Something mid-gesture that Esc should cancel before anything else (gizmo.js, in a v4 world). */
let escapeHook = () => false;
export function setEscapeHook(fn) { escapeHook = fn; }
bus.on('key', (e) => {
  if (e.code === 'Escape') {
    // v4 (§3a): Esc during a drag cancels it and writes nothing; the thing goes back to where the log has it
    if (V4.isV4() && dragging?.armed) { const id = dragging.id; dragging = null; V4.revertPose(id); flashHint('move cancelled — nothing written'); return; }
    if (escapeHook()) return;
    if (structureTool()) setStructureTool(null);   // an armed building tool drops first (the viewport strip says "Esc to drop")
    else if (cancelSeatArm()) { /* an armed placement is the most transient state */ }
    else if (ghost) cancelGhost();
    else if (seatSelected()) deselectSeat();
    else if (selected || sceneSelected()) deselectAll();
    else if (editMode) setEditMode(false);
    return;
  }
  // Undo stays available outside edit mode — you may only notice the mistake
  // after you have gone back to looking.
  // v4: redo is Ctrl+Shift+Z or Ctrl+Y (the door's undo of my undo); a v1 world keeps today's keys exactly
  if (V4.isV4() && (e.ctrlKey || e.metaKey) && ((e.code === 'KeyZ' && e.shiftKey) || e.code === 'KeyY')) { e.preventDefault?.(); V4.redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
  if (!editMode) return;

  // a selected seat anchor holds the editing keys before things do
  if (seatKeyDown(e)) return;
  // Tool keys, every one OFF the walking set (the camera here is a BODY and
  // WASD walks — Maya's W and Blender's S both collide, found in review):
  // G move (Blender), E rotate and R scale (Maya), Q select, F find, X or Del
  // removes, Esc steps out, B toggles the mode. The old per-key nudges (Q/E
  // turn, ,/. size, R/F raise) are retired; the tools do those with a drag.
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    const t = { KeyQ: 'select', KeyG: 'move', KeyE: 'rotate', KeyR: 'scale' }[e.code];
    if (t) { setTool(t); return; }
    if (e.code === 'KeyF' && keyTarget()) { bus.emit('edit-find', keyTarget()); return; }
    if (e.code === 'KeyX' && keyTarget()) { removeTargets(); return; }
  }
  if ((e.code === 'Delete' || e.code === 'Backspace') && keyTarget()) { e.preventDefault?.(); removeTargets(); }
});
