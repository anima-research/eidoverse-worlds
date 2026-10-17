// gripedit — the grip editor (R, 10-10: "position and pose how things are grabbed"; research
// notes/eidoverse/RESEARCH-grips-and-reset-2026-10-10.md, recommendation 1).
//
// Grips stay data inside grabbable.grips (one validated write). The editor draws a GHOST HAND at the selected grip and
// binds its own move / turn handles to it: a local-only proxy, never an entity (Godot's preview hand is the same idea).
// On release it writes the whole grabbable once. Mirror writes the other hand's grip; Try it puts the thing in my hand.
//
// The palm frame is shared/grab.js's (+Z out of the palm, +Y little→index). Its X differs by side, MEASURED on R's
// avatar (tools/protocol/palm-frame.lab.ts, 10-10): the right palm's +X points to the wrist, the left's along the
// fingers. So the ghost's points below are the right hand's, and the left's are the same with x negated; and a grip
// mirrored across the thing's X plane is M·R·diag(-1, 1, 1) (M the reflection), which keeps the palm out and the index up.

import { THREE, scene, camera, canvas } from './core.js';
import { bus } from './base.js';
import { entities } from './world.js';
import { registerSystem } from './frameloop.js';
import { isEditing, setPointerVeto, setEscapeHook } from './build.js';
import * as Edits from './editwrites.js';
import { sendRequest } from './net.js';
import { flashHint } from './ui.js';
import { checkGrabbable, HANDS, ROLES, GRASPS } from '../../shared/grab.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// the right hand's joints in its palm frame (metres), from R's avatar; ring is between middle and little
const R_PTS = {
  wrist: [0.122, -0.004, -0.041],
  thumb: [[0.082, 0.069, -0.016], [0.035, 0.096, -0.021], [-0.022, 0.115, -0.025]],
  index: [[-0.029, 0.057, -0.035], [-0.075, 0.054, -0.016], [-0.123, 0.052, 0.016]],
  middle: [[-0.041, 0.001, -0.041], [-0.086, -0.001, -0.023], [-0.148, -0.003, 0.024]],
  little: [[-0.029, -0.052, -0.035], [-0.066, -0.053, -0.017], [-0.115, -0.049, 0.028]],
};
R_PTS.ring = R_PTS.middle.map((m, i) => m.map((x, k) => (x + R_PTS.little[i][k]) / 2 + (k === 1 ? -0.001 : 0)));
const tip = (ch) => { const [, b, c] = ch; return c.map((x, k) => x + (x - b[k]) * 0.75); };
const COLORS = { right: 0xff9a3c, left: 0x4fb3ff, either: 0xd8d8dc };

let st = null;   // { id, name, proxy, ghost, controls, helper, panel, start }
const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();

export const gripEditing = () => st?.id ?? null;

function rawGrab(id) { const v = Edits.compsOf(id)?.grabbable; return v && typeof v === 'object' ? v : {}; }
function gripsOf(id) { return { ...(rawGrab(id).grips ?? {}) }; }

function bone(a, b, r, mat) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), len = A.distanceTo(B); if (len < 1e-4) return null;
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(1e-4, len - 2 * r * 0.5), 3, 8), mat);
  m.position.copy(A).add(B).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.sub(A).normalize());
  return m;
}
/** A see-through hand in the palm frame: the right hand's measured joints (x negated for the left). */
function ghostHand(side) {
  const g = new THREE.Group(); g.name = 'grip-ghost';
  const mat = new THREE.MeshBasicMaterial({ color: COLORS[side] ?? COLORS.either, transparent: true, opacity: 0.55, depthTest: false });
  const fx = side === 'left' ? -1 : 1; const P = (v) => [v[0] * fx, v[1], v[2]];
  for (const f of ['thumb', 'index', 'middle', 'ring', 'little']) {
    const ch = R_PTS[f].map(P); const t = P(tip(R_PTS[f]));
    const path = [P(R_PTS.wrist), ...ch, t];
    for (let i = f === 'thumb' ? 0 : 1; i < path.length - 1; i++) { const b = bone(path[i], path[i + 1], f === 'thumb' ? 0.009 : 0.008, mat); if (b) g.add(b); }
  }
  const palm = [R_PTS.index[0], R_PTS.little[0], R_PTS.wrist].map(P);   // the palm's edge, knuckles to wrist
  for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) { const s = bone(palm[a], palm[b], 0.012, mat); if (s) g.add(s); }
  // the palm frame's own marks: a dot at the grip point, and a short line out of the palm (+Z)
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false })); g.add(dot);
  const out = bone([0, 0, 0], [0, 0, 0.05], 0.003, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false })); if (out) g.add(out);
  g.traverse((o) => { o.renderOrder = 999; });
  return g;
}

/** Where the selected grip's palm is in the world: the thing's origin, then grip.pos (scaled by the thing), grip.q. */
function placeProxy() {
  const obj = entities.get(st.id); const gp = gripsOf(st.id)[st.name]; if (!obj || !gp) return;
  obj.updateWorldMatrix(true, false); obj.matrixWorld.decompose(_p, _q, _s);
  st.proxy.position.copy(new THREE.Vector3(...gp.pos).multiply(_s).applyQuaternion(_q).add(_p));
  st.proxy.quaternion.copy(_q).multiply(new THREE.Quaternion(...(gp.q ?? [0, 0, 0, 1])));
}
/** The proxy's pose, back in the thing's frame (unscaled), as a grip's pos and q. */
function proxyToGrip() {
  const obj = entities.get(st.id); obj.updateWorldMatrix(true, false); obj.matrixWorld.decompose(_p, _q, _s);
  const inv = _q.clone().invert();
  const pos = st.proxy.position.clone().sub(_p).applyQuaternion(inv).divide(_s).toArray().map((x) => +x.toFixed(4));
  const q = inv.multiply(st.proxy.quaternion).normalize().toArray().map((x) => +x.toFixed(5));
  return { pos, q };
}

async function writeGrips(grips, what) {
  const value = { ...rawGrab(st.id), grips };
  if (!Object.keys(grips).length) delete value.grips;
  const bad = checkGrabbable(value); if (bad) { flashHint(bad.reason ?? String(bad), 4500, 'attn'); return null; }
  return Edits.setComp(st.id, 'grabbable', value, what);
}

function setGhost() {
  if (st.ghost) { st.proxy.remove(st.ghost); st.ghost.traverse((o) => { o.geometry?.dispose?.(); }); }
  const gp = gripsOf(st.id)[st.name]; st.ghost = gp ? ghostHand(gp.hand ?? 'either') : null;
  if (st.ghost) st.proxy.add(st.ghost);
  st.controls.enabled = !!gp; st.helper.visible = !!gp;
  if (gp) placeProxy();
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function select(options, value, on) { const s = el('select'); for (const o of options) { const op = el('option', null, o); op.value = o; s.append(op); } s.value = value; s.onchange = () => on(s.value); return s; }

function paint() {
  if (!st) return;
  const p = st.panel; p.replaceChildren();
  const grips = gripsOf(st.id); const names = Object.keys(grips);
  if (st.name && !grips[st.name]) st.name = names[0] ?? null;
  const head = el('div', 'gripedit-head'); head.append(el('b', null, 'Grips'), el('span', 'gripedit-of', Edits.compsOf(st.id)?.label ?? st.id));
  const done = el('button', 'gripedit-done', 'Done'); done.title = 'Close the grip editor (Esc)'; done.onclick = closeGripEditor; head.append(done); p.append(head);
  const list = el('div', 'gripedit-list');
  for (const n of names) { const g = grips[n]; const row = el('button', 'gripedit-row' + (n === st.name ? ' on' : ''));
    const sw = el('span', 'gripedit-sw'); sw.style.background = '#' + (COLORS[g.hand ?? 'either']).toString(16).padStart(6, '0');
    row.append(sw, el('span', null, n), el('span', 'gripedit-dim', `${g.hand ?? 'either'} · ${g.role ?? 'primary'}`));
    row.onclick = () => { st.name = n; setGhost(); paint(); }; list.append(row); }
  if (!names.length) list.append(el('div', 'gripedit-dim', 'No grips yet: it is held wherever the hand takes it.'));
  p.append(list);
  const add = el('button', null, '+ grip'); add.title = 'Add a grip for the right hand at the thing\'s centre; then drag the hand into place';
  add.onclick = () => addGrip();
  const bar = el('div', 'gripedit-bar'); bar.append(add);
  if (st.name) {
    const g = grips[st.name];
    const mirror = el('button', null, 'mirror'); mirror.title = 'Write the other hand\'s grip: this one reflected across the thing\'s left-right plane';
    mirror.onclick = () => mirrorGrip();
    const del = el('button', 'danger', 'delete'); del.onclick = async () => { const gs = gripsOf(st.id); delete gs[st.name]; st.name = null; await writeGrips(gs, 'delete a grip'); };
    const tryIt = el('button', null, 'try it'); tryIt.title = 'Pick it up by this grip (walk within reach first)'; tryIt.onclick = () => tryGrip();
    const move = el('button', st.controls.mode === 'translate' ? 'on' : '', 'move'), turn = el('button', st.controls.mode === 'rotate' ? 'on' : '', 'turn');
    move.onclick = () => { st.controls.setMode('translate'); paint(); }; turn.onclick = () => { st.controls.setMode('rotate'); paint(); };
    bar.append(mirror, tryIt, del);
    const fields = el('div', 'gripedit-fields');
    const set = (k) => async (v) => { const gs = gripsOf(st.id); gs[st.name] = { ...gs[st.name], [k]: v }; if (k === 'grasp') delete gs[st.name].fingers; await writeGrips(gs, `grip ${k}`); };
    fields.append(el('label', null, 'hand'), select(HANDS, g.hand ?? 'either', set('hand')),
      el('label', null, 'role'), select(ROLES, g.role ?? 'primary', set('role')),
      el('label', null, 'grasp'), select(GRASPS, g.grasp ?? g.fingers ?? 'fist', set('grasp')));
    const tools = el('div', 'gripedit-bar'); tools.append(move, turn);
    p.append(fields, tools);
  }
  p.append(bar);
}

async function addGrip() {
  const gs = gripsOf(st.id); let i = 1; while (gs[`grip${i}`]) i++; const name = `grip${i}`;
  const obj = entities.get(st.id); const box = new THREE.Box3().setFromObject(obj); obj.updateWorldMatrix(true, false); obj.matrixWorld.decompose(_p, _q, _s);
  const c = box.getCenter(new THREE.Vector3()).sub(_p).applyQuaternion(_q.clone().invert()).divide(_s);
  gs[name] = { pos: c.toArray().map((x) => +x.toFixed(4)), q: [0, 0, 0, 1], hand: 'right', role: 'primary' };
  st.name = name; await writeGrips(gs, 'add a grip');
}

const mirrorQ = (q) => { const R = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...q)); const M = new THREE.Matrix4().makeScale(-1, 1, 1);
  const out = M.clone().multiply(R).multiply(M); return new THREE.Quaternion().setFromRotationMatrix(out).normalize().toArray().map((x) => +x.toFixed(5)); };
async function mirrorGrip() {
  const gs = gripsOf(st.id); const g = gs[st.name]; if (!g) return;
  const other = g.hand === 'left' ? 'right' : g.hand === 'right' ? 'left' : null;
  if (!other) return flashHint('an "either" grip already serves both hands; set it to left or right to mirror it', 4200, 'attn');
  const base = st.name.replace(/-(left|right)$/, ''); const name = `${base}-${other}`.slice(0, 32);
  gs[name] = { ...g, pos: [-g.pos[0], g.pos[1], g.pos[2]], q: mirrorQ(g.q ?? [0, 0, 0, 1]), hand: other };
  st.name = name; await writeGrips(gs, 'mirror a grip');
}
export { mirrorQ as _mirrorQ };

async function tryGrip() {
  const g = gripsOf(st.id)[st.name]; if (!g) return;
  const r = await sendRequest('grab', { id: st.id, grip: st.name, ...(g.hand === 'left' ? { hand: 'left' } : {}) });
  if (!r?.ok) flashHint(r?.refused?.reason ?? 'couldn\'t pick it up', 4200, 'attn');
  return r;
}

export function openGripEditor(id) {
  if (st) closeGripEditor();
  if (!entities.get(id)) return;
  const proxy = new THREE.Object3D(); proxy.name = 'grip-proxy'; scene.add(proxy);
  const controls = new TransformControls(camera, canvas); controls.size = 0.6; controls.setSpace('local');
  const helper = controls.getHelper(); helper.name = 'grip-gizmo'; scene.add(helper); controls.attach(proxy);
  controls.addEventListener('dragging-changed', (e) => { if (!e.value && st) { const gs = gripsOf(st.id); if (!gs[st.name]) return; gs[st.name] = { ...gs[st.name], ...proxyToGrip() }; void writeGrips(gs, 'move a grip'); } });
  const panel = el('div', 'gripedit'); document.body.append(panel);
  const vb = document.querySelector('.edit-viewbar'); const r = vb && !vb.hidden ? vb.getBoundingClientRect() : null;
  panel.style.left = `${r ? r.left : 16}px`; panel.style.top = `${r ? r.bottom + 6 : 80}px`;
  st = { id, name: Object.keys(gripsOf(id))[0] ?? null, proxy, ghost: null, controls, helper, panel };
  setGhost(); paint();
  bus.emit('grip-edit', id);
}
export function closeGripEditor() {
  if (!st) return;
  st.controls.detach(); st.controls.dispose(); scene.remove(st.helper); scene.remove(st.proxy); st.panel.remove();
  const id = st.id; st = null; bus.emit('grip-edit', null); return id;
}

export function initGripEdit() {
  setPointerVeto(() => !!st && (!!st.controls.axis || !!st.controls.dragging));
  setEscapeHook(() => { if (!st) return false; if (st.controls.dragging) return false; closeGripEditor(); return true; });
  bus.on('edit-mode', (on) => { if (!on) closeGripEditor(); });
  bus.on('comp', () => { if (st && !st.controls.dragging) { if (!entities.get(st.id)) return closeGripEditor(); setGhost(); paint(); } });
  registerSystem('gripedit', () => { if (st && !st.controls.dragging) placeProxy(); }, { every: 2 });
  globalThis.__gripeditTest = () => st && { proxy: st.proxy, controls: st.controls, panel: st.panel };   // harness: drive a drag
  globalThis.__gripedit = () => (st ? { id: st.id, name: st.name, proxy: st.proxy.position.toArray(), q: st.proxy.quaternion.toArray(), ghost: !!st.ghost, mode: st.controls.mode } : null);
}
