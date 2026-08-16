// debug — draw what the physics actually thinks the world is.
//
// This exists because of a day spent proving by measurement that
// resolveColliders treated every box as an infinite column reaching down to
// the world floor: it never read box.min.y, so a mezzanine slab modelled at
// y 2.4-2.7 shoved a walking body 2.3m sideways at GROUND level. Finding that
// took a headless harness and a lot of printf. One wireframe would have shown
// it in a glance — the box on screen simply would not have been where the box
// on screen was.
//
// So: the collider volumes as the solver reads them, and the ragdoll as the
// solver reads it. Not the meshes — the COLLIDERS. Where the two disagree is
// the whole point, and a debug view that redraws the visible geometry would
// have shown nothing wrong on the day it mattered most.

import { THREE, scene } from './core.js';
import { MeshBVHHelper } from 'three-mesh-bvh';
import { colliders } from './colliders.js';
import { closestParams, TUNING } from './ragdoll.js';
import { makeFrame } from './frames.js';

// box = an OBB, walkable on top, solid on the sides between min.y and max.y
// pillar = anything over 2.4m tall, collapsed to a slim centre column so you
//          can walk under a canopy
// exact  = collides against its actual triangles; a box would be a lie, so the
//          BVH is drawn instead
const KIND_COLOR = { box: 0x4fd8ff, pillar: 0xffb347, exact: 0x8fe8c8 };
const RAG_COLOR = { joint: 0xff8fb0, bone: 0xffd166, hit: 0xff3b3b };

const _c = new THREE.Vector3();
const _ca = new THREE.Vector3();
const _cb = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _pr = { s: 0, t: 0 };
const _up = new THREE.Vector3(0, 1, 0);
const _Y = new THREE.Vector3(0, 1, 0);   // CapsuleGeometry's own axis

let frame = null, providers = {}, statsEl = null, framePre = null, statsAt = 0, lastRun = null, lastRag = null;
const on = { colliders: false, ragdoll: false };

// ---- shared geometry/material, so N colliders cost N transforms ------------
let unitBox = null, unitBall = null;
const lineMats = new Map();
// depthTest OFF: a debug overlay that the world can hide is not much of a
// debug overlay. The capsules live INSIDE the avatar mesh — that is the entire
// point of them — so depth-testing them against it drew the collision volume
// only where it poked out through the skin, which is exactly where it does not
// matter. Same for a collider box behind furniture.
const lineMat = (color) => {
  if (!lineMats.has(color)) {
    lineMats.set(color, new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false,
    }));
  }
  return lineMats.get(color);
};
const onTop = (o) => { o.renderOrder = 999; o.frustumCulled = false; return o; };

let collGroup = null, ragGroup = null;
const collViews = new Map();   // entity id -> { kind, node }
let ragJoints = null, ragCaps = null;

function ensureGroups() {
  if (!unitBox) unitBox = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  if (!unitBall) unitBall = new THREE.WireframeGeometry(new THREE.SphereGeometry(1, 8, 5));
  if (!collGroup) {
    collGroup = new THREE.Group();
    collGroup.name = 'debug:colliders';
    collGroup.userData.isDebug = true;   // the sky's scene-diff must not adopt it
    scene.add(collGroup);
  }
  if (!ragGroup) {
    ragGroup = new THREE.Group();
    ragGroup.name = 'debug:ragdoll';
    ragGroup.userData.isDebug = true;
    scene.add(ragGroup);
  }
}

// ---- collider volumes ------------------------------------------------------

function kindOf(e) { return e.exact ? 'exact' : e.pillar ? 'pillar' : 'box'; }

/** The BVH, not a box: an exact entity collides against its triangles, and
 *  drawing a box around it would misrepresent the one case where the box is
 *  explicitly NOT the collider. Falls back to a box if the helper can't build,
 *  because a debug view that throws is worse than one that approximates. */
function exactView(entry) {
  try {
    const geo = entry.exact.bvh.geometry;
    const mesh = new THREE.Mesh(geo);
    mesh.geometry.boundsTree = entry.exact.bvh;
    const helper = new MeshBVHHelper(mesh, 8);
    helper.color.set(KIND_COLOR.exact);
    helper.opacity = 0.5;
    helper.depth = 8;
    helper.update?.();
    // The helper's updateMatrixWorld copies the SOURCE mesh's matrix and
    // decomposes it over its own transform — positioning the helper itself is
    // silently undone every frame. Sync must therefore move this mesh, not
    // the helper node; kept here because only exactView knows it exists.
    // (Symptom fixed: every exact wireframe drew at world origin in the
    // entity's model frame, which went unnoticed for as long as the only
    // exact entities were room-scale spawns sitting AT the origin.)
    helper.userData.source = mesh;
    return helper;
  } catch {
    return new THREE.LineSegments(unitBox, lineMat(KIND_COLOR.exact));
  }
}

function syncColliders() {
  const seen = new Set();
  for (const [id, e] of colliders) {
    const kind = kindOf(e);
    seen.add(id);
    let view = collViews.get(id);
    if (!view || view.kind !== kind) {
      if (view) collGroup.remove(view.node);
      const node = onTop(kind === 'exact'
        ? exactView(e)
        : new THREE.LineSegments(unitBox, lineMat(KIND_COLOR[kind])));
      node.traverse?.((o) => { o.renderOrder = 999; });
      collGroup.add(node);
      view = { kind, node };
      collViews.set(id, view);
    }
    const { obj, box } = e;
    const s = obj.scale?.x || 1;
    view.node.quaternion.setFromAxisAngle(_up, obj.rotation.y);
    if (kind === 'exact') {
      const src = view.node.userData?.source;
      if (src) {
        // drive the source mesh — the helper mirrors it (see exactView)
        src.position.copy(obj.position);
        src.quaternion.setFromAxisAngle(_up, obj.rotation.y);
        src.scale.setScalar(s);
        src.updateMatrixWorld(true);
      } else {
        // LineSegments fallback: an ordinary node, positioned directly
        view.node.position.copy(obj.position);
        view.node.scale.setScalar(s);
      }
      continue;
    }
    // A pillar keeps its full height but only a slim centre footprint — the
    // clamp lives in LOCAL units, so it scales with the entity like the box.
    const half = kind === 'pillar' ? 0.25 : null;
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    _c.set(half ? cx : cx, (box.min.y + box.max.y) / 2, half ? cz : cz)
      .multiplyScalar(s).applyAxisAngle(_up, obj.rotation.y).add(obj.position);
    view.node.position.copy(_c);
    view.node.scale.set(
      (half ? half * 2 : box.max.x - box.min.x) * s,
      (box.max.y - box.min.y) * s,
      (half ? half * 2 : box.max.z - box.min.z) * s,
    );
  }
  for (const [id, view] of collViews) {
    if (seen.has(id)) continue;
    collGroup.remove(view.node);
    collViews.delete(id);
  }
}

// ---- the ragdoll's own idea of the body ------------------------------------
//
// Joint spheres at their MEASURED radii and the bone capsules between them —
// which is the model the solver actually integrates, and for a long time was
// not the model anyone believed it had (bones were beads, and limbs passed
// clean through the torso on all 14 rigs).

/** Real capsules, not centre lines. A bone's radius and its length never
 *  change once a tumble starts — the solver holds the length with a distance
 *  constraint and the radius is measured off the rig at construction — so each
 *  capsule's geometry is built ONCE and thereafter only moved. Drawing the
 *  axis instead was showing the one thing that was never in doubt and hiding
 *  the thing that matters: the thickness is what stops a forearm from passing
 *  through a torso, and you cannot see interpenetration in a line. */
function buildCapsules(rd) {
  disposeCapsules();
  const items = [];
  for (const c of rd.caps ?? []) {
    const len = rd.p[c.a].distanceTo(rd.p[c.b]);
    // CapsuleGeometry's `length` is the CYLINDER, with hemispheres added on
    // top — so a cylinder of |ab| puts the cap centres exactly on the joints,
    // which is the volume the solver tests.
    const mesh = onTop(new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.CapsuleGeometry(c.r, len, 2, 8)),
      lineMat(RAG_COLOR.bone)));
    ragGroup.add(mesh);
    items.push({ mesh, cap: c });
  }
  ragCaps = { rd, items, byCap: new Map(items.map((it) => [it.cap, it])) };
}
function disposeCapsules() {
  for (const it of ragCaps?.items ?? []) { ragGroup?.remove(it.mesh); it.mesh.geometry.dispose(); }
  ragCaps = null;
}

function syncRagdoll(rd) {
  // ---- joint spheres, at the radius the GROUND and props are tested against
  // (which is per-joint, and not the same number as a bone's radius)
  const joints = Object.keys(rd.p);
  if (!ragJoints || ragJoints.count !== joints.length) {
    if (ragJoints) ragGroup.remove(ragJoints.mesh);
    const mesh = onTop(new THREE.InstancedMesh(unitBall, lineMat(RAG_COLOR.joint), joints.length));
    ragGroup.add(mesh);
    ragJoints = { mesh, count: joints.length };
  }
  joints.forEach((j, i) => {
    const r = rd.radius?.[j] ?? 0.04;
    _m.compose(rd.p[j], _q.identity(), _c.set(r, r, r));
    ragJoints.mesh.setMatrixAt(i, _m);
  });
  ragJoints.mesh.instanceMatrix.needsUpdate = true;

  // ---- bone capsules
  if (ragCaps?.rd !== rd) buildCapsules(rd);
  for (const it of ragCaps.items) {
    const pa = rd.p[it.cap.a], pb = rd.p[it.cap.b];
    _dir.copy(pb).sub(pa);
    const len = _dir.length() || 1e-6;
    it.mesh.position.copy(pa).addScaledVector(_dir, 0.5);
    it.mesh.quaternion.setFromUnitVectors(_Y, _dir.divideScalar(len));
    it.hit = false;
  }
  // ---- and which of them are currently INSIDE each other, which is the whole
  // question the capsule model exists to answer
  for (const { A, B, min } of rd.pairs ?? []) {
    closestParams(rd.p[A.a], rd.p[A.b], rd.p[B.a], rd.p[B.b], _pr);
    _ca.copy(rd.p[A.a]).lerp(rd.p[A.b], _pr.s);
    _cb.copy(rd.p[B.a]).lerp(rd.p[B.b], _pr.t);
    if (_ca.distanceTo(_cb) >= min) continue;
    const ia = ragCaps.byCap.get(A), ib = ragCaps.byCap.get(B);
    if (ia) ia.hit = true;
    if (ib) ib.hit = true;
  }
  for (const it of ragCaps.items) {
    it.mesh.material = lineMat(it.hit ? RAG_COLOR.hit : RAG_COLOR.bone);
  }
}

// ---- the knobs -------------------------------------------------------------
//
// Every headless metric in this repo has at some point said a ragdoll was fine
// while it plainly was not on screen. So: put the solver's switches and dials
// where someone can watch the body and turn them. Toggling a whole family off
// mid-tumble is the fastest bisect there is — if the shape stops being wrong
// when CONE goes off, it was the cone.

const SWITCHES = [
  ['ON_FLEX', 'spine/neck bend'], ['ON_CONE', 'shoulder/hip cone'],
  ['ON_BEHIND', 'behind-body stop'], ['ON_HINGE', 'knee/elbow hinge'],
  ['ON_CAPSULE', 'self-collision'], ['ON_BRACE', 'torso bracing'],
  ['ON_TWIST', 'twist state'], ['ON_GROUND', 'ground + props'],
  ['PIN_VEL', 'pins carry velocity'],
];
const DIALS = [
  ['YIELD', 0, 1, 0.05], ['CAPSULE_SOFT', 0, 1, 0.05],
  ['SUBSTEPS', 1, 8, 1], ['ITER', 1, 8, 1],
  ['DAMP', 0.8, 1, 0.005], ['SLEEP_DAMP', 0.5, 1, 0.01],
  ['TWIST_LAG', 0, 1, 0.05], ['TWIST_STIFF', 0, 80, 2], ['TWIST_DAMP', 0.5, 1, 0.01],
  ['GRAVITY', -20, 0, 0.5], ['SETTLE_V', 0, 0.4, 0.01], ['DEADLINE', 1, 30, 1],
];
const DEFAULTS = {};

function switchRow(key, label) {
  const wrap = document.createElement('label');
  wrap.className = 'row dbg-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!TUNING[key];
  cb.onchange = () => { TUNING[key] = cb.checked ? 1 : 0; };
  const nm = document.createElement('span');
  nm.textContent = label;
  wrap.append(cb, nm);
  return wrap;
}

function dialRow(key, lo, hi, step) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.style.width = '92px';
  nm.textContent = key.toLowerCase().replace(/_/g, ' ');
  const sl = document.createElement('input');
  sl.type = 'range'; sl.min = lo; sl.max = hi; sl.step = step; sl.value = TUNING[key];
  const val = document.createElement('span');
  val.className = 'v';
  val.style.width = '46px';
  const paint = () => { val.textContent = String(TUNING[key]); };
  sl.oninput = () => { TUNING[key] = Number(sl.value); paint(); };
  paint();
  wrap.append(nm, sl, val);
  return { wrap, reset: () => { TUNING[key] = DEFAULTS[key]; sl.value = DEFAULTS[key]; paint(); } };
}

// ---- panel -----------------------------------------------------------------

function row(label, key, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'row dbg-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = on[key];
  cb.onchange = () => { on[key] = cb.checked; onChange?.(cb.checked); };
  const nm = document.createElement('span');
  nm.textContent = label;
  wrap.append(cb, nm);
  return wrap;
}

/** @param p { ragdoll(), downed(), fps() } — passed in rather than imported,
 *  so this module stays a leaf and never draws main.js into a cycle. */
export function initDebug(p = {}) {
  providers = p;
  frame = makeFrame('debug', {
    title: 'debug', x: -10, y: 300, w: 250, h: 460, minW: 210, hidden: true,
  });
  const stack = document.createElement('div');
  stack.className = 'stack';
  // The frame block is PINNED above everything (tel0s: the stats pre at the
  // bottom rendered past the scroller's end) — its own element, flex:none,
  // so scrolling the settings never hides the one number the panel is
  // usually opened for.
  framePre = document.createElement('pre');
  framePre.className = 'dbg-stats';
  framePre.style.cssText = 'flex:none;margin:0 0 4px';
  stack.appendChild(framePre);
  stack.append(
    row('collider volumes', 'colliders', (v) => { if (!v) clearColliders(); }),
    row('ragdoll skeleton', 'ragdoll', (v) => { if (!v) clearRagdoll(); }),
  );
  for (const [k] of DIALS) DEFAULTS[k] = TUNING[k];
  for (const [k] of SWITCHES) DEFAULTS[k] = TUNING[k];

  const btns = document.createElement('div');
  btns.className = 'row';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label; b.onclick = fn;
    b.style.cssText = 'flex:1;font-size:var(--fs-sm);padding:3px 0';
    return b;
  };
  const pause = mk('pause', () => {
    TUNING.PAUSED = TUNING.PAUSED ? 0 : 1;
    pause.textContent = TUNING.PAUSED ? '▶ resume' : 'pause';
  });
  const resets = [];
  btns.append(
    mk('re-drop', () => providers.reLimp?.()),
    pause,
    mk('reset', () => { for (const r of resets) r(); for (const [k] of SWITCHES) TUNING[k] = DEFAULTS[k]; repaintSwitches(); }),
  );
  stack.appendChild(btns);

  const swBox = document.createElement('div');
  // NOT .stack — that is flex:1 with its own scroller, and nested inside the
  // panel's stack it collapses to nothing and the switches vanish.
  swBox.style.cssText = 'display:flex;flex-direction:column;gap:3px';
  for (const [k, label] of SWITCHES) swBox.appendChild(switchRow(k, label));
  const repaintSwitches = () => {
    [...swBox.querySelectorAll('input')].forEach((cb, i) => { cb.checked = !!TUNING[SWITCHES[i][0]]; });
  };
  stack.appendChild(swBox);

  for (const [k, lo, hi, st] of DIALS) {
    const d = dialRow(k, lo, hi, st);
    resets.push(d.reset);
    stack.appendChild(d.wrap);
  }

  statsEl = document.createElement('pre');
  statsEl.className = 'dbg-stats';
  stack.appendChild(statsEl);
  frame.body.appendChild(stack);
  return frame;
}

export function toggleDebug() { frame?.toggle(); }
export const debugVisible = () => !!frame?.visible;

function clearColliders() {
  for (const [, v] of collViews) collGroup?.remove(v.node);
  collViews.clear();
}
function clearRagdoll() {
  if (ragJoints) { ragGroup?.remove(ragJoints.mesh); ragJoints = null; }
  disposeCapsules();
}

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '--');

export function updateDebug(now = performance.now()) {
  if (!frame) return;
  // F1 hides the UI for screenshots; debug lines are UI, whatever layer they
  // happen to live on
  const hidden = !frame.visible || document.body.classList.contains('photo');
  ensureGroups();
  collGroup.visible = !hidden && on.colliders;
  ragGroup.visible = !hidden && on.ragdoll;
  if (hidden) return;

  if (on.colliders) syncColliders();

  // The settled pose is the one worth inspecting, and it is exactly the moment
  // main.js drops its ragdoll reference — so hold the last skeleton for as long
  // as the body is still down, and only clear it when they get up.
  const live = providers.ragdoll?.();
  if (live?.p) lastRag = live;
  if (!providers.downed?.()) lastRag = null;
  const rd = lastRag;
  if (on.ragdoll && rd?.p) syncRagdoll(rd); else if (!rd) clearRagdoll();

  if (now - statsAt < 200) return;      // the panel is for reading, not for fps
  statsAt = now;
  let box = 0, pillar = 0, exact = 0;
  for (const [, e] of colliders) {
    const k = kindOf(e);
    if (k === 'box') box++; else if (k === 'pillar') pillar++; else exact++;
  }
  // the pinned frame block: fps + honest ms + worst-of-last-second, then
  // the per-system bill (EWMA ms) — where the frame actually goes
  const p = providers.perf?.();
  if (framePre && p) {
    const bill = (providers.bill?.() ?? [])
      .filter((s) => s.ms > 0.05)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5);
    framePre.textContent = [
      `frame  ${String(p.fps).padStart(4)} fps  ${p.ms.toFixed(1)}ms  worst ${Math.round(p.worst)}ms`,
      ...bill.map((s) => `  ${s.name.padEnd(12)} ${s.ms.toFixed(2).padStart(6)}ms${s.every > 1 ? ` /${s.every}f` : ''}`),
    ].join('\n');
  }
  const lines = [
    `things   ${String(colliders.size).padStart(5)}`,
    `  box    ${String(box).padStart(5)}   walk on top, solid between`,
    `  pillar ${String(pillar).padStart(5)}   slim column, pass under`,
    `  exact  ${String(exact).padStart(5)}   trimesh (BVH)`,
  ];
  // A tumble's numbers are most worth reading the moment it STOPS, which is
  // exactly when main.js drops its reference and they would vanish. Keep the
  // last set and say plainly that it is the last one.
  if (rd?.p) {
    lastRun = [
      `  speed  ${fmt(rd.maxV, 3).padStart(5)} m/s`,
      `  still  ${fmt(rd.settledFor, 2).padStart(5)} s`,
      `  age    ${fmt(rd.elapsed, 2).padStart(5)} s`,
      // steps vs age separates "nobody is calling step()" from "step() is
      // being called with dt 0" — two very different bugs that look identical
      // from a frozen body.
      `  steps  ${String(rd.steps ?? 0).padStart(5)} / ${rd.frames ?? 0} substeps`,
      `  joints ${String(Object.keys(rd.p).length).padStart(5)}`,
      `  pairs  ${String(rd.pairs?.length ?? 0).padStart(5)}   capsule tests`,
      `  pins   ${String(rd.pins?.size ?? 0).padStart(5)}${rd.pins?.size ? '   ' + [...rd.pins.keys()].join(' ') : ''}`,
    ];
  }
  if (lastRun) lines.push('', `ragdoll  ${rd?.p ? 'active' : 'settled (last)'}`, ...lastRun);

  // Per-bone TWIST, live. This is the number I have got wrong more than once,
  // so it is on screen next to the body it claims to describe: if a limb looks
  // twisted and its row says 0°, the measurement is what is broken.
  if (rd?.drive && rd.pose) {
    lines.push('', 'twist about each bone (deg)');
    for (const d of rd.drive) {
      const q = rd.pose[d.bone];
      const child = rd.nodes?.[d.child];
      if (!q || !child) continue;
      _c.copy(child.position);
      if (_c.lengthSq() < 1e-9) continue;
      _c.normalize();
      const along = q[0] * _c.x + q[1] * _c.y + q[2] * _c.z;
      _q.set(_c.x * along, _c.y * along, _c.z * along, q[3]);
      if (_q.lengthSq() < 1e-12) continue;
      _q.normalize();
      let a = 2 * Math.acos(Math.min(1, Math.max(-1, _q.w))) * 180 / Math.PI;
      if (a > 180) a -= 360;
      lines.push(`  ${d.bone.padEnd(14)}${Math.abs(a).toFixed(0).padStart(4)}`);
    }
  }
  statsEl.textContent = lines.join('\n');
}
