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
import { sendVerb, sendDrag } from './net.js';
import { myState, mouse, setPointerClaim, setEditingProbe } from './controller.js';
import { flashHint, collapseAll, panelFrame } from './ui.js';
import { sceneSelect } from './scenegraph.js';
import { refreshSeatGizmos, resetSeats, armSeatPlacement, seatArmed, seatSelected,
  cancelSeatArm, deselectSeat, seatMouseDown, seatKeyDown, updateSeatDrag } from './seatedit.js';

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hit = new THREE.Vector3();

// ============================================================ state

let ghost = null;         // { obj, lib, yaw, scale } — a thing not yet placed
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

export function setEditMode(on, { quiet = false } = {}) {
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
      ? 'edit mode — click to select · drag to move · <b>build</b> for the catalog · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Esc</kbd> to leave'
      : 'looking again');
  }
  bus.emit('edit-mode', on);
  return editMode;
}
export const toggleEditMode = () => setEditMode(!editMode);

export const hasGhost = () => ghost !== null;
export const hasSelection = () => selected !== null;
setPointerClaim(() => ghost !== null || !!dragging?.armed);
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
  inspector.innerHTML =
    `<span><b>${label.slice(0, 34)}</b></span>` +
    `<span style="color:var(--dim)">by ${meta.actor ?? '?'}</span>` +
    (locked
      ? `<span style="color:var(--dim)">🔒 locked — nothing moves or removes it until unchecked</span>`
      : `<span style="color:var(--dim)">drag move · <kbd>Shift</kbd>+drag or <kbd>R</kbd><kbd>F</kbd> up/down · ` +
        `<kbd>Q</kbd><kbd>E</kbd> turn · <kbd>,</kbd><kbd>.</kbd> size · <kbd>Del</kbd> remove · <kbd>Esc</kbd> done</span>`) +
    `<label title="nail it down: while locked, nobody's drags, verbs or scripts can move, replace or remove it (server-enforced) — sitting on it and content edits stay open" style="display:flex;gap:4px;align-items:center;cursor:pointer">` +
    `<input type="checkbox" data-bact="lock"${locked ? ' checked' : ''}> 🔒 lock</label>` +
    `<button data-bact="seat" title="declare a sit anchor: click the spot where a sitter goes">+ seat</button>`;
  inspector.querySelector('[data-bact="lock"]').onchange = (ev) => {
    const on = ev.target.checked;
    sendVerb('comp', { id, type: 'lock', data: on ? true : null });
    flashHint(on ? `🔒 <b>${label.slice(0, 34)}</b> locked — nothing moves it until you uncheck` : `🔓 unlocked`);
    // the echo folds the comp; repaint the hint line once it lands
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
export function deselect() {
  if (selected) editHolds.delete(selected.id);
  selected = null;
  dragging = null;
  outline.visible = false;
  hideInspector();
}
function refreshOutline() {
  if (selected) outline.box.setFromObject(selected.obj);
}

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
      : `placing <b>${label ?? ''}</b> — click to place · <kbd>Q</kbd><kbd>E</kbd> turn · <kbd>,</kbd><kbd>.</kbd> size · <kbd>Esc</kbd> cancel`, 6000);
  } catch (e) { report('ghost', e); }
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
  const hits = raycaster.intersectObjects(targets, true);
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
    if (dragging.vertical) {
      // map screen-vertical pixels to world metres at the object's depth, so a
      // drag feels the same whether the thing is near or far
      const fov = camera.fov * Math.PI / 180;
      const pxToWorld = (2 * dragging.depth * Math.tan(fov / 2)) / innerHeight;
      const dy = (dragging.startY - dragging.clientY) * pxToWorld;   // up = raise
      const floor = heightAt(dragging.startPos.x, dragging.startPos.z);
      const y = Math.max(floor, dragging.startPos.y + dy);
      selected.obj.position.set(dragging.startPos.x, y, dragging.startPos.z);
      reindexCollider(selected.id);
      refreshOutline();
      relayDrag();
    } else {
      const aim = aimPoint(selected.id);
      if (aim) {
        // Keep the grab offset. Without it the object teleports so that its
        // ORIGIN sits under the cursor, which is both a jump and usually wrong —
        // you grabbed a crate by its corner, not by its pivot.
        selected.obj.position.copy(aim.point).add(dragging.grab);
        // dropping onto a surface should still rest ON it, not float by the
        // offset you happened to grab at
        if (aim.onto) selected.obj.position.y = aim.point.y;
        reindexCollider(selected.id);
        refreshOutline();
        relayDrag();
      }
    }
  }
}

// relay at pose cadence so others see it move, not teleport
function relayDrag() {
  const now = performance.now();
  if (now - (dragging.lastSent ?? 0) < 66) return;
  dragging.lastSent = now;
  const p = selected.obj.position;
  sendDrag(selected.id, [p.x, p.y, p.z], selected.obj.rotation.y);
}

// remote drags: apply transiently, no log involvement
bus.on('drag', ({ id, pos, yaw }) => {
  const obj = entities.get(id);
  if (!obj) return;
  obj.position.set(...pos);
  if (yaw != null) obj.rotation.y = yaw;
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
function lockedHint(id) {
  if (!isLocked(id)) return false;
  flashHint('🔒 <b>locked</b> — uncheck <b>lock</b> in the inspector to move or remove it');
  return true;
}

function commitPlace(before) {
  if (!selected) return;
  if (lockedHint(selected.id)) {
    // the world never moved — put the local preview back where the log says
    const o = selected.obj;
    o.position.set(...before.pos); o.rotation.y = before.yaw; o.scale.setScalar(before.scale);
    reindexCollider(selected.id); refreshOutline();
    return;
  }
  const o = selected.obj;
  sendVerb('place', {
    id: selected.id,
    pos: [o.position.x, o.position.y, o.position.z],
    yaw: o.rotation.y,
    scale: o.scale.x,
  });
  pushUndo({ verb: 'place', args: { id: selected.id, ...before } }, 'move');
}

function snapshotOf(obj) {
  return { pos: [obj.position.x, obj.position.y, obj.position.z], yaw: obj.rotation.y, scale: obj.scale.x };
}

export function undo() {
  const step = undoStack.pop();
  if (!step) { flashHint('nothing to undo'); return; }
  // Undo is inverse ENTRIES — history stays append-only, which is what keeps
  // the log replayable and the world forkable.
  sendVerb(step.inverse.verb, step.inverse.args);
  flashHint(`undid ${step.describe}`);
  deselect();
}

function removeSelected() {
  if (!selected) return;
  if (lockedHint(selected.id)) return;   // an accidental Del is the worst accident
  const meta = entityMeta.get(selected.id) ?? {};
  const snap = snapshotOf(selected.obj);
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
  select(id);
  // A press is a SELECT. It only becomes a drag once the pointer actually
  // travels — otherwise clicking a thing to look at its label moved it.
  const aim = aimPoint(id);
  dragging = {
    id,
    before: snapshotOf(root),
    lastSent: 0,
    armed: false,
    startX: e.clientX,
    startY: e.clientY,
    clientY: e.clientY,
    // Shift held at grab = a VERTICAL drag: the ground-plane raycast can't
    // express height, so hold Shift and the pointer's up/down maps to world Y
    // with the horizontal position pinned. The standard editor gesture.
    vertical: e.shiftKey,
    startPos: entities.get(id).position.clone(),
    depth: camera.position.distanceTo(entities.get(id).position),
    grab: aim ? entities.get(id).position.clone().sub(aim.point) : new THREE.Vector3(),
  };
  e.preventDefault();
});

// Arm the drag only after a few pixels of travel — the same threshold every
// desktop UI uses to tell a click from a drag.
const DRAG_SLOP = 4;
addEventListener('mousemove', (e) => {
  if (!dragging) return;
  dragging.clientY = e.clientY;                 // vertical drag reads this each frame
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
      && Math.abs(o.position.z - moved.pos[2]) < 0.005;
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

bus.on('key', (e) => {
  if (e.code === 'Escape') {
    if (cancelSeatArm()) { /* an armed placement is the most transient state */ }
    else if (ghost) cancelGhost();
    else if (seatSelected()) deselectSeat();
    else if (selected) deselect();
    else if (editMode) setEditMode(false);
    return;
  }
  // Undo stays available outside edit mode — you may only notice the mistake
  // after you have gone back to looking.
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
  if (!editMode) return;

  const turn = (d) => {
    if (ghost) ghost.yaw += d;
    else if (selected) {
      const before = snapshotOf(selected.obj);
      selected.obj.rotation.y += d;
      reindexCollider(selected.id); refreshOutline();
      commitPlace(before);
    }
  };
  const size = (f) => {
    if (ghost) ghost.scale = THREE.MathUtils.clamp(ghost.scale * f, 0.1, 12);
    else if (selected) {
      const before = snapshotOf(selected.obj);
      selected.obj.scale.multiplyScalar(f);
      selected.obj.scale.clampScalar(0.1, 12);
      reindexCollider(selected.id); refreshOutline();
      commitPlace(before);
    }
  };
  // R/F raise/lower — the keyboard counterpart to Shift+drag, for precise
  // heights. Never underground. (R is ragdoll globally, but that is gated to
  // NOT fire while editing, so it is free here.)
  const raise = (dy) => {
    if (ghost) { ghost.obj.position.y = Math.max(0, ghost.obj.position.y + dy); return; }
    if (!selected) return;
    const before = snapshotOf(selected.obj);
    const floor = heightAt(selected.obj.position.x, selected.obj.position.z);
    selected.obj.position.y = Math.max(floor, selected.obj.position.y + dy);
    reindexCollider(selected.id); refreshOutline();
    commitPlace(before);
  };
  // a selected seat anchor holds the editing keys before things do
  if (seatKeyDown(e)) return;
  // Q/E only steer objects when something is being edited — otherwise they're
  // photo-mode fly keys and must stay free.
  if (ghost || selected) {
    if (e.code === 'KeyQ') turn(e.shiftKey ? 0.02 : Math.PI / 12);
    if (e.code === 'KeyE') turn(e.shiftKey ? -0.02 : -Math.PI / 12);
    if (e.code === 'Comma') size(0.92);
    if (e.code === 'Period') size(1.087);
    if (e.code === 'KeyR') raise(e.shiftKey ? 0.05 : 0.25);
    if (e.code === 'KeyF') raise(e.shiftKey ? -0.05 : -0.25);
  }
  if ((e.code === 'Delete' || e.code === 'Backspace') && selected) removeSelected();
});
