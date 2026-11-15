// debug — draw what the physics thinks the world is: the collider volumes as the solver reads them, and the ragdoll
// as the solver reads it, not the meshes. Where the two disagree is the whole point.

import { THREE, scene } from '../core.js';
import { bus } from '../base.js';
import { registerXRPanel, xrPanelOpen } from '../xr/xrpanels.js';
import { gpuLine, shadowPassLine, setGpuTimer, gpuTimerOn, gpuTimerState, measureShadowPass } from './gputime.js';
import { perf } from '../render/perf.js';
import { drawStats } from '../render/render.js';
import { MODES, setMode, activeMode, setSolid, isSolid } from './perfscope.js';
import { MeshBVHHelper } from 'three-mesh-bvh';
import { colliders, frameOf } from '../colliders.js';
import { closestParams, TUNING } from '../ragdoll/ragdoll.js';
import { JOINT_SPECS, HAIR_TUNING, WING_TUNING } from '../ragdoll/ammodoll-tuning.js';
import { BLINK, WING_IDLE, LIMP_SPRINGS } from '../avatar/avatar.js';
import { makeFrame } from '../ui/windows.js';
import { sliderTable, checkRow, selectRow, btn, sectionHead } from '../edit/rows.js';
import { toast, paintRangesIn } from '../ui/ui.js';

// box    = an OBB, walkable on top, solid on the sides between min.y and max.y
// pillar = a fitted box over 2.4 m tall (not exact, not a declared structure box: colliders.js), collapsed to a slim
//          centre column so you can walk under a canopy
// exact  = collides against its actual triangles, so the BVH is drawn
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
// depthTest off: the capsules live inside the avatar mesh, so depth-testing would draw them only where they poke through
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

/** The BVH, not a box: an exact entity collides against its triangles. Falls back to a box if the helper can't build. */
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
    // the helper's updateMatrixWorld copies the source mesh's matrix over its own, so sync moves this mesh, not the helper
    helper.userData.source = mesh;
    return helper;
  } catch {
    return new THREE.LineSegments(unitBox, lineMat(KIND_COLOR.exact));
  }
}

function syncColliders() {
  const seen = new Set();
  for (const [id, e] of colliders) {
    const F = frameOf(e); const kind = kindOf(F);   // what the walker reads: a lying thing as its turned box
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
    const { obj } = e; const box = F.box;
    const s = obj.scale?.x || 1;
    view.node.quaternion.setFromAxisAngle(_up, F.yaw);
    if (kind === 'exact') {
      const src = view.node.userData?.source;
      if (src) {
        // drive the source mesh — the helper mirrors it (see exactView)
        src.position.copy(obj.position);
        src.quaternion.setFromAxisAngle(_up, F.yaw);
        src.scale.setScalar(s);
        src.updateMatrixWorld(true);
      } else {
        // LineSegments fallback: an ordinary node, positioned directly
        view.node.position.copy(obj.position);
        view.node.scale.setScalar(s);
      }
      continue;
    }
    // a pillar keeps its full height but only a slim centre footprint (local units, so it scales with the entity)
    const half = kind === 'pillar' ? 0.25 : null;
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    _c.set(half ? cx : cx, (box.min.y + box.max.y) / 2, half ? cz : cz)
      .multiplyScalar(s).applyAxisAngle(_up, F.yaw).add(obj.position);
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
// Joint spheres at their measured radii and the bone capsules between them: the model the solver integrates.

/** Real capsules, not centre lines: thickness is what stops a forearm passing through a torso. Length and radius
 *  never change once a tumble starts, so each capsule's geometry is built once and only moved after. */
function buildCapsules(rd) {
  disposeCapsules();
  const items = [];
  for (const c of rd.caps ?? []) {
    const len = rd.p[c.a].distanceTo(rd.p[c.b]);
    // CapsuleGeometry's `length` is the cylinder, hemispheres added: a cylinder of |ab| puts the cap centres on the joints
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

// box volumes: a unit cube built once and scaled per box
let ragVols = null;
function syncVolumes(vols) {
  if (!ragVols || ragVols.items.length !== vols.length) {
    disposeVolumes();
    const items = vols.map(() => {
      const mesh = onTop(new THREE.LineSegments(unitBoxWire(), lineMat(RAG_COLOR.bone)));
      ragGroup.add(mesh);
      return mesh;
    });
    ragVols = { items };
  }
  vols.forEach((v, i) => {
    const m = ragVols.items[i];
    m.position.copy(v.p);
    m.quaternion.copy(v.q);
    m.scale.set(v.he.x * 2, v.he.y * 2, v.he.z * 2);
  });
}
function disposeVolumes() {
  // not m.geometry.dispose(): every box shares the one unit cube
  for (const m of ragVols?.items ?? []) ragGroup?.remove(m);
  ragVols = null;
}
let _boxWire = null;
const unitBoxWire = () => (_boxWire ??= new THREE.WireframeGeometry(new THREE.BoxGeometry(1, 1, 1)));

function syncRagdoll(rd) {
  // ---- joint spheres, at the radius the ground and props are tested against (per joint, not a bone's radius)
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

  // ---- box volumes, for engines that hold boxes rather than capsules (the Bullet rig); the verlet answers with caps below
  const vols = rd.volumes?.() ?? [];
  if (vols.length) syncVolumes(vols); else disposeVolumes();

  // ---- bone capsules
  if (!rd.caps) return;
  if (ragCaps?.rd !== rd) buildCapsules(rd);
  for (const it of ragCaps.items) {
    const pa = rd.p[it.cap.a], pb = rd.p[it.cap.b];
    _dir.copy(pb).sub(pa);
    const len = _dir.length() || 1e-6;
    it.mesh.position.copy(pa).addScaledVector(_dir, 0.5);
    it.mesh.quaternion.setFromUnitVectors(_Y, _dir.divideScalar(len));
    it.hit = false;
  }
  // ---- and which of them are currently inside each other
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
// The solver's switches and dials, where someone can watch the body and turn them. Toggling a whole family off
// mid-tumble is the fastest bisect.

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

// ---- joint limits ----------------------------------------------------------
// How floppy a ragdoll should look inside a joint's range is a judgement: pick a joint, drag its ranges, watch the
// body. retune() pushes the table into the running constraints, so a body already on the floor changes live.

// what each spec exposes: directional joints carry flex/ext, the rest an x pair
const LIMIT_FIELDS = [
  ['flex', 0, 180, 1], ['ext', 0, 180, 1],
  ['twist', 0, 90, 1],
  ['x0', -180, 0, 1], ['x1', 0, 180, 1],
  ['z0', -180, 0, 1], ['z1', 0, 180, 1],
];
const getF = (S, f) => (f === 'x0' ? S.x?.[0] : f === 'x1' ? S.x?.[1]
  : f === 'z0' ? S.z?.[0] : f === 'z1' ? S.z?.[1] : S[f]);
const setF = (S, f, v) => {
  if (f === 'x0') S.x[0] = v; else if (f === 'x1') S.x[1] = v;
  else if (f === 'z0') S.z[0] = v; else if (f === 'z1') S.z[1] = v;
  else S[f] = v;
};

/** The retune hook the live-tuning tables share: push the edited table into the running doll, if one exists. */
const retune = (method) => () => { providers.ragdoll?.()?.[method]?.(); };

/** Copy the tuned table to the clipboard. */
function copyBtn(label, make) {
  return btn(label, async () => {
    const out = make();
    try { await navigator.clipboard.writeText(out); toastLike(`${label.replace(/^copy /, '')} copied`); }
    catch { console.log(out); toastLike(`${label.replace(/^copy /, '')} logged to console`); }
  });
}

function buildJointPanel(stack) {
  // one snapshot of the shipped table, so "reset" means the defaults
  const jointDefaults = JSON.parse(JSON.stringify(JOINT_SPECS));
  const apply = retune('retune');

  const { row: head, select: pick } = selectRow('joint', Object.keys(JOINT_SPECS), null, () => table.repaint());
  head.querySelector('.nm').style.width = '42px';

  const table = sliderTable(LIMIT_FIELDS, null, {
    get: (f) => getF(JOINT_SPECS[pick.value], f),
    set: (f, v) => setF(JOINT_SPECS[pick.value], f, v),
    fmt: (f, v) => `${v}°`, onSet: apply, nmW: '42px', vW: '34px',
  });

  const btns = document.createElement('div');
  btns.className = 'row btn-row';
  btns.append(
    btn('reset joint', () => {
      Object.assign(JOINT_SPECS[pick.value], JSON.parse(JSON.stringify(jointDefaults[pick.value])));
      table.repaint(); apply(); paintRangesIn(stack);
    }),
    copyBtn('copy table', () => {
      const txt = Object.entries(JOINT_SPECS).map(([k, S]) => {
        const parts = [`ref: '${S.ref}'`];
        if (S.flex != null) parts.push(`flex: ${S.flex}`, `ext: ${S.ext}`, `want: '${S.want}'`);
        else parts.push(`x: [${S.x[0]}, ${S.x[1]}]`);
        parts.push(`twist: ${S.twist}`, `z: [${S.z[0]}, ${S.z[1]}]`);
        return `  ${k}: { ${parts.join(', ')} },`;
      }).join('\n');
      return `const JOINT_SPECS = {\n${txt}\n};`;
    }),
  );
  stack.append(head, table.el, btns);
}

// ---- blink and hair ---------------------------------------------------------
// Which way an eyelid shuts depends on how its bone was rolled, so the sign is a dial. Rigs that export a Limit
// Rotation constraint use their own value and ignore this one.
const BLINK_FIELDS = [
  ['closed', -2, 2, 0.02],   // upper lid
  ['lower', -2, 2, 0.02],    // lower lid: an upper alone does not shut an eye
  ['dur', 0.05, 0.8, 0.01],  // seconds for the whole close-and-open
  ['hz', 0.2, 4, 0.1],
  ['eyeMax', 0, 1.2, 0.02],  // 0 pins the eyeballs at rest: tells "rigged wrong" from "the gaze code turns them wrong"
  ['axis', 0, 2, 1],          // 0=x 1=y 2=z: which way the lid hinges
];

const HAIR_FIELDS = [
  ['mass', 0.001, 0.05, 0.001],
  // ranges where the hair actually responds (WING/HAIR_TUNING: 3 to 20 covers barely-moving to lively)
  ['tension', 0, 24, 0.25],
  ['damping', 0, 0.6, 0.01],
  ['gravity', 0, 1.5, 0.05],
  ['limit', 0, 90, 1],
  ['rootExp', 0.2, 3, 0.1],
];

function buildBlinkPanel(stack) {
  stack.appendChild(sliderTable(BLINK_FIELDS, BLINK, {
    fmt: (f, v) => (f === 'closed' || f === 'lower' || f === 'eyeMax'
      ? `${(v * 180 / Math.PI).toFixed(0)}°`
      : f === 'dur' ? `${(v * 1000).toFixed(0)}ms`
        : f === 'axis' ? ['x', 'y', 'z'][v] ?? '?' : `${v}x`),
  }).el);
}

// A limp body with no sim of its own falls back to three-vrm, whose springs are tuned for standing, so a body on its
// side reads as gravity pulling the hair sideways. These two take effect on the next body to go limp.
const LIMP_FIELDS = [
  ['stiffness', 0, 1, 0.02],   // factor on whatever the rig declared
  ['gravity', 0, 1.5, 0.05],   // floor, not a replacement
];

function buildLimpPanel(stack) {
  stack.appendChild(sliderTable(LIMP_FIELDS, LIMP_SPRINGS, {
    fmt: (f, v) => (f === 'stiffness' ? `${v}x` : String(v)),
  }).el);
}

/** The tuning-table literal, ready to paste back into the source. */
const tableLiteral = (name, o) => `export const ${name} = {\n`
  + Object.entries(o).map(([k, v]) => `  ${k}: ${v},`).join('\n') + '\n};';

function buildHairPanel(stack) {
  const defaults = { ...HAIR_TUNING };
  const apply = retune('retuneHair');
  const table = sliderTable(HAIR_FIELDS, HAIR_TUNING, {
    fmt: (f, v) => (f === 'mass' ? `${(v * 1000).toFixed(1)}g`
      : f === 'limit' ? `${v}°` : String(v)),
    onSet: apply,
  });
  const btns = document.createElement('div');
  btns.className = 'row btn-row';
  btns.append(
    btn('reset hair', () => { Object.assign(HAIR_TUNING, defaults); table.repaint(); apply(); paintRangesIn(stack); }),
    copyBtn('copy hair', () => tableLiteral('HAIR_TUNING', HAIR_TUNING)),
  );
  stack.append(table.el, btns);
}

// ---- wings ------------------------------------------------------------------
// Two tables: WING_IDLE is the flap, read fresh every frame by avatar/wings.js, so its sliders bite instantly on a
// standing body. WING_TUNING is the ragdoll's and needs retuneWings() to reach constraints that exist only while a body is limp.
const WING_IDLE_FIELDS = [
  ['deg', 0, 60, 1],        // half-amplitude at the shoulder
  ['hz', 0, 3, 0.02],       // flaps per second
  ['bias', -40, 40, 1],     // permanent lift, degrees
  ['tip', 0, 1.5, 0.05],    // outer segment's share
  ['lag', 0, 0.5, 0.01],    // cycles the tip trails the root
  ['sweep', 0, 40, 1],      // fore/aft travel; 0 pins the tips to the frontal plane (the hinge look)
  ['sweepPhase', 0, 0.5, 0.01],  // 0.25 opens the path into an ellipse; 0 or 0.5 collapses it to a tilted line
  ['recover', 0.05, 2, 0.05],
];
const WING_SIM_FIELDS = [
  ['mass', 0.02, 3, 0.01],
  ['tension', 0, 400, 5],
  ['damping', 0, 1, 0.02],
  ['gravity', 0, 2, 0.05],
  ['limit', 0, 90, 1],
  ['rootExp', 0.2, 3, 0.1],
];

function buildWingPanel(stack) {
  const idleDefaults = { ...WING_IDLE };
  const simDefaults = { ...WING_TUNING };
  const apply = retune('retuneWings');
  // WING_IDLE needs no retune hook; WING_TUNING is pushed into the live constraints by `apply`
  const idle = sliderTable(WING_IDLE_FIELDS, WING_IDLE, {
    fmt: (f, v) => (f === 'deg' || f === 'bias' || f === 'sweep' ? `${v}°`
      : f === 'hz' ? `${+(+v).toFixed(2)}Hz`   // the default is 1/3.4: unrounded it overflows the readout
        : f === 'recover' ? `${(v * 1000).toFixed(0)}ms` : String(+(+v).toFixed(3))),
  });
  const sim = sliderTable(WING_SIM_FIELDS, WING_TUNING, {
    fmt: (f, v) => (f === 'mass' ? `${(v * 1000).toFixed(0)}g`
      : f === 'limit' ? `${v}°` : String(v)),
    onSet: apply,
  });
  const sub = (text) => {
    const h = document.createElement('div');
    h.className = 'nm'; h.style.cssText = 'opacity:0.6;margin-top:4px';
    h.textContent = text;
    return h;
  };
  const btns = document.createElement('div');
  btns.className = 'row btn-row';
  btns.append(
    btn('reset wings', () => {
      Object.assign(WING_IDLE, idleDefaults);
      Object.assign(WING_TUNING, simDefaults);
      idle.repaint(); sim.repaint(); apply(); paintRangesIn(stack);
    }),
    copyBtn('copy wings', () =>
      `${tableLiteral('WING_IDLE', WING_IDLE)}\n\n${tableLiteral('WING_TUNING', WING_TUNING)}`),
  );
  stack.append(sub('flap (live)'), idle.el, sub('limp (needs a ragdoll)'), sim.el, btns);
}

const toastLike = (msg) => toast(msg);

// ---- panel -----------------------------------------------------------------

const viewRow = (label, key, onChange) => checkRow(label,
  () => on[key], (v) => { on[key] = v; onChange?.(v); }, { className: 'row dbg-row' });

/** @param p { ragdoll(), downed(), perf(), bill(), reLimp() }, passed in rather than imported, so this module stays a leaf. */
export function initDebug(p = {}) {
  providers = p;
  frame = makeFrame('debug', {
    // second right column, bottom-anchored ABOVE the action row: gestures own the corner, world/settings the top
    title: 'debug', x: -270, y: -165, w: 250, h: 460, minW: 210, hidden: true,
  });
  const stack = document.createElement('div');
  stack.className = 'stack';
  // the frame block is pinned above everything (flex:none), so scrolling the settings never hides it
  framePre = document.createElement('pre');
  framePre.className = 'dbg-stats';
  framePre.style.cssText = 'flex:none;margin:0 0 4px';
  stack.appendChild(framePre);
  // tabs by job: physics = the ragdoll and its tuning, body = the secondary motion that rides a body (blink, hair,
  // wings), perf = what the frame costs
  const tabs = dbgTabs(stack, ['physics', 'body', 'perf'], () => frame.visible);
  // the remembered tab is chosen at boot with Debug closed: its groups wait until the panel is on screen
  frame.onShow(tabs.flush);
  const phys = tabs.pane('physics');
  phys.append(
    viewRow('collider volumes', 'colliders', (v) => { if (!v) clearColliders(); }),
    viewRow('ragdoll skeleton', 'ragdoll', (v) => { if (!v) clearRagdoll(); }),
  );
  for (const [k] of DIALS) DEFAULTS[k] = TUNING[k];
  for (const [k] of SWITCHES) DEFAULTS[k] = TUNING[k];

  const btns = document.createElement('div');
  btns.className = 'row btn-row';   // unified equal-width action-button row
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label; b.onclick = fn;
    return b;
  };
  const pause = mk('pause', () => {
    TUNING.PAUSED = TUNING.PAUSED ? 0 : 1;
    pause.textContent = TUNING.PAUSED ? '▶ resume' : 'pause';
  });
  btns.append(
    btn('re-drop', () => providers.reLimp?.()),
    pause,
    btn('reset', () => {
      for (const [k] of [...DIALS, ...SWITCHES]) TUNING[k] = DEFAULTS[k];
      dials.repaint(); repaintSwitches();
    }),
  );
  phys.appendChild(btns);

  const swBox = document.createElement('div');
  // not .stack: that is flex:1 with its own scroller, and nested in the panel's stack it collapses to nothing
  swBox.style.cssText = 'display:flex;flex-direction:column;gap:3px';
  for (const [k, label] of SWITCHES) {
    swBox.appendChild(checkRow(label,
      () => !!TUNING[k], (v) => { TUNING[k] = v ? 1 : 0; }, { className: 'row dbg-row' }));
  }
  const repaintSwitches = () => {
    [...swBox.querySelectorAll('input')].forEach((cb, i) => { cb.checked = !!TUNING[SWITCHES[i][0]]; });
  };
  phys.appendChild(swBox);

  const dials = sliderTable(DIALS, TUNING, {
    label: (k) => k.toLowerCase().replace(/_/g, ' '),
    nmW: '92px', vW: '46px',
  });
  phys.appendChild(dials.el);


  tabs.group('physics', 'joint limits', (body) => buildJointPanel(body));
  tabs.group('body', 'blink', (body) => buildBlinkPanel(body));
  tabs.group('body', 'hair (while ragdolled)', (body) => buildHairPanel(body));
  tabs.group('body', 'limp hair (no local sim)', (body) => buildLimpPanel(body));
  tabs.group('body', 'wings', (body) => buildWingPanel(body));
  // perfscope mounts itself when its module is present; without it this is a silent no-op
  import('./perfscope.js').then((m) => m.mountPerfPanel(stack, { toast: toastLike, section: (_parent, title, build) => tabs.group('perf', title, build) })).catch(() => {});

  // GPU time, measured by the GPU (gputime.js): the number a headless probe cannot give us
  tabs.group('perf', 'gpu timer', (body) => {
    const row = document.createElement('label'); row.className = 'row dbg-row';   // the house check row, like every other switch here
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = gpuTimerOn();
    row.append(cb, document.createTextNode('time the world pass on the GPU'));
    const btn = document.createElement('button'); btn.textContent = 'measure shadow pass';
    const out = document.createElement('pre'); out.className = 'dbg-stats'; out.style.whiteSpace = 'pre-wrap';   // sentences, not columns: wrap rather than scroll sideways
    const paint = () => { out.textContent = [gpuLine(), shadowPassLine()].join('\n'); };
    cb.onchange = () => { setGpuTimer(cb.checked); paint(); };
    btn.onclick = () => { measureShadowPass().then((r) => { if (r?.error) toastLike(`gpu timer: ${r.error}`); cb.checked = gpuTimerOn(); paint(); }); paint(); };
    body.append(row, btn, out);
    setInterval(() => { let x = false; try { x = xrPanelOpen('debug'); } catch { /* not presenting */ } if (body.isConnected && (body.offsetParent || x)) paint(); }, 1000);
    if (!gpuTimerState().supported) { cb.disabled = true; btn.disabled = true; }
    paint();
  });

  // the live bone readout: its own group, last in physics
  statsEl = document.createElement('pre');
  statsEl.className = 'dbg-stats';
  tabs.group('physics', 'ragdoll readout', (body) => body.appendChild(statsEl));
  tabs.choose();
  frame.body.appendChild(stack);
  return frame;
}

// Debug's text tabs (the profile's .pf-tabs recipe). A group inside a tab is a caption and a body; `build(body)`
// runs once, lazily, the first time its tab is seen, so an unvisited tab costs nothing. A group added to the tab
// already on screen (perfscope arrives by dynamic import) builds at once.
function dbgTabs(parent, names, shown) {
  const LS = 'ew-tab-debug';
  const strip = document.createElement('div');
  strip.className = 'pf-tabs dbg-tabs'; strip.setAttribute('role', 'tablist');
  parent.appendChild(strip);
  const tabs = new Map();
  let current = null;
  const flush = () => { if (current && shown()) for (const g of tabs.get(current).pending.splice(0)) g(); };
  const show = (name) => {
    current = name;
    for (const [n, t] of tabs) {
      const on = n === name;
      t.btn.classList.toggle('on', on); t.btn.setAttribute('aria-selected', String(on)); t.pane.classList.toggle('open', on);
    }
    flush();
    try { localStorage.setItem(LS, name); } catch {}
  };
  for (const name of names) {
    const btn = document.createElement('button');
    btn.className = 'pf-tab'; btn.setAttribute('role', 'tab'); btn.dataset.tab = name; btn.textContent = name;
    btn.onclick = () => show(name);
    const pane = document.createElement('div');
    pane.className = 'dbg-pane'; pane.dataset.tab = name; pane.setAttribute('role', 'tabpanel');
    strip.appendChild(btn); parent.appendChild(pane);
    tabs.set(name, { btn, pane, pending: [] });
  }
  return {
    pane: (name) => tabs.get(name).pane,
    group(name, title, build) {
      const t = tabs.get(name);
      const cap = document.createElement('div'); cap.className = 'dbg-group'; cap.textContent = title;
      const body = document.createElement('div'); body.className = 'dbg-group-body';
      body.style.cssText = 'display:flex;flex-direction:column;gap:4px';
      t.pane.append(cap, body);
      const run = () => build(body);
      if (current === name && shown()) run(); else t.pending.push(run);
      return body;
    },
    flush,
    choose() { let want = null; try { want = localStorage.getItem(LS); } catch {} show(tabs.has(want) ? want : names[0]); },
  };
}

export function toggleDebug() { frame?.toggle(); }

function clearColliders() {
  for (const [, v] of collViews) collGroup?.remove(v.node);
  collViews.clear();
}
function clearRagdoll() {
  if (ragJoints) { ragGroup?.remove(ragJoints.mesh); ragJoints = null; }
  disposeCapsules();
  disposeVolumes();
}

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '--');

export function updateDebug(now = performance.now()) {
  if (!frame) return;
  // F1 hides the UI for screenshots; debug lines are UI. Open in the VR ring counts as shown, or the quad's numbers freeze.
  let inXR = false; try { inXR = xrPanelOpen('debug'); } catch { /* not presenting */ }
  const hidden = (!frame.visible && !inXR) || document.body.classList.contains('photo');
  ensureGroups();
  collGroup.visible = !hidden && on.colliders;
  ragGroup.visible = !hidden && on.ragdoll;
  if (hidden) return;

  if (on.colliders) syncColliders();

  // the settled pose is the one worth inspecting, exactly when the ragdoll reference is dropped: hold the last
  // skeleton while the body is still down
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
  // the pinned frame block: fps + ms + worst-of-last-second, then the per-system bill (EWMA ms)
  const p = providers.perf?.();
  if (framePre && p) {
    const bill = (providers.bill?.() ?? [])
      .filter((s) => s.ms > 0.05)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5);
    framePre.textContent = [
      `frame  ${String(p.fps).padStart(4)} fps  ${p.ms.toFixed(1)}ms  worst ${Math.round(p.worst)}ms`,
      ...bill.map((s) => `  ${s.name.padEnd(12)} ${s.ms.toFixed(2).padStart(6)}ms${s.every > 1 ? ` /${s.every}f` : ''}`),
      ...(gpuTimerOn() ? [gpuLine()] : []),
    ].join('\n');
  }
  const lines = [
    `things   ${String(colliders.size).padStart(5)}`,
    `  box    ${String(box).padStart(5)}   walk on top, solid between`,
    `  pillar ${String(pillar).padStart(5)}   slim column, pass under`,
    `  exact  ${String(exact).padStart(5)}   trimesh (BVH)`,
  ];
  // a tumble's numbers are most worth reading when it stops: keep the last set and say that it is the last one
  if (rd?.p) {
    lastRun = [
      `  speed  ${fmt(rd.maxV, 3).padStart(5)} m/s`,
      `  still  ${fmt(rd.settledFor, 2).padStart(5)} s`,
      `  age    ${fmt(rd.elapsed, 2).padStart(5)} s`,
      // hipsOffset (render root below the hips) is a property of the rig: if it drifts, the body renders off the sim
      `  hipsΔ  ${fmt(rd.hipsOffset, 3).padStart(5)} m  (rig constant)`,
      `  rootY  ${fmt(rd.avatar?.root?.position?.y, 3).padStart(5)} m`,
      // steps vs age separates "nobody is calling step()" from "step() called with dt 0"
      `  steps  ${String(rd.steps ?? 0).padStart(5)} / ${rd.frames ?? 0} substeps`,
      `  joints ${String(Object.keys(rd.p).length).padStart(5)}`,
      `  pairs  ${String(rd.pairs?.length ?? 0).padStart(5)}   capsule tests`,
      `  pins   ${String(rd.pins?.size ?? 0).padStart(5)}${rd.pins?.size ? '   ' + [...rd.pins.keys()].join(' ') : ''}`,
    ];
  }
  if (lastRun) lines.push('', `ragdoll  ${rd?.p ? 'active' : 'settled (last)'}`, ...lastRun);

  // per-bone twist, live: if a limb looks twisted and its row says 0°, the measurement is what is broken
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

// ---- the debug frame as a VR quad -------------------------------------------
// The same sources as the desk (perf.js, render.js, perfscope.js), shown to the person wearing the headset.
function debugFields() {
  const r = drawStats().render ?? {};
  const cur = activeMode();
  return [
    { t: 'info', label: 'fps', value: `${perf.fps}` },
    { t: 'info', label: 'frame', value: `${(+perf.ms).toFixed(1)} ms · worst ${(+perf.worst).toFixed(0)} · spikes ${perf.spikes}` },
    { t: 'info', label: 'draws', value: `${r.drawCalls ?? '—'} calls · ${((r.triangles ?? 0) / 1000).toFixed(0)}k tris` },
    { t: 'list', label: 'perfscope', rows: Object.entries(MODES).map(([k, m]) => ({ id: k, label: m.label, active: k === cur, actions: k === cur ? [] : [{ k: 'mode', label: 'use' }] })) },
    { t: 'check', k: 'solid', label: 'solid tint', value: isSolid() },
    { t: 'check', k: 'gputimer', label: 'gpu timer', value: gpuTimerOn() },
    { t: 'info', label: 'gpu', value: gpuLine().replace(/^gpu:? ?/, '') },
    { t: 'list', label: 'shadow pass', rows: [{ id: 'shadowab', label: shadowPassLine().replace(/^shadow pass:? ?/, ''), actions: [{ k: 'shadowab', label: 'measure' }] }] },
  ];
}
function debugDispatch(k, v) {
  if (k === 'mode') setMode(v);
  else if (k === 'solid') setSolid(!!v);
  else if (k === 'gputimer') setGpuTimer(!!v);
  else if (k === 'shadowab') measureShadowPass().then(() => bus.emit('xr:repaint'));
  else return;
  bus.emit('xr:repaint');
}
registerXRPanel({ id: 'debug', title: 'debug', fields: debugFields, dispatch: debugDispatch });
// live numbers: one repaint a second while the quad is open
setInterval(() => { try { if (xrPanelOpen('debug')) bus.emit('xr:repaint'); } catch { /* not presenting */ } }, 1000);
