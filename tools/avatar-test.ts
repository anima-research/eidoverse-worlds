// avatar — the clip/limp lifecycle, run headless.
//
//   bun tools/avatar-test.ts
//
// This exists because the ragdoll suite tests the SIM against a mock avatar
// whose setLimp is a one-line stub, so the real seam between the locomotion
// mixer and the ragdoll was never exercised at all — and a single wrong line
// there (mixer.stopAllAction) broke three separate things in production:
// nothing animated again after getting up, the head integrated one pitch per
// frame into a spinning flywheel, and every tumble began with a T-pose flash
// that the Ragdoll constructor then measured as the body's starting pose.
//
// The Avatar constructor needs a canvas (nameplates, blob shadows), which Bun
// has no business providing, so these drive the real METHODS against a real
// THREE.AnimationMixer bound to a real skeleton. That is where the contract
// lives: actions are play()ed exactly once at load and cross-faded by WEIGHT
// ever after, so anything that deactivates them is unrecoverable.

import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
plugin({
  name: 'client-stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    b.onResolve({ filter: /^\.\/assets\.js$/ }, () => ({ path: here('./assets-stub.mjs') }));
    b.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
  },
});

const { THREE } = await import('./core-stub.mjs');
const { Avatar } = await import('../client/lib/avatar.js');
const { DRIVEN_BONES } = await import('../client/lib/ragdoll.js');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

const BONES = [
  ...DRIVEN_BONES,
  'head', 'leftShoulder', 'rightShoulder', 'upperChest',
  'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'leftIndexProximal',
];
const UNDRIVEN = BONES.filter((b) => !DRIVEN_BONES.includes(b));

/** A skeleton, a mixer, and a clip that animates EVERY bone — set up exactly
 *  the way Avatar's constructor does it: play() once, weight 0, cross-fade
 *  after. Plus the minimum `this` the lifecycle methods reach for. */
function stand({ constant = false } = {}) {
  const root = new THREE.Object3D();
  const nodes: Record<string, any> = {};
  for (const b of BONES) {
    const n = new THREE.Object3D(); n.name = b;
    root.add(n); nodes[b] = n;
  }
  // A clip that genuinely MOVES, because a real locomotion clip does and the
  // difference matters: three.js only writes a bone when the value it computes
  // changes, so a constant track is written once and never again.
  const key = (a: number) => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
    return [q.x, q.y, q.z, q.w];
  };
  // `constant` is the case three.js writes exactly ONCE: a single-key finger,
  // a head that does not move in idle. Everything composed after the mixer has
  // to behave identically either way, and none of it used to.
  const tracks = BONES.map((b) => new THREE.QuaternionKeyframeTrack(
    `${b}.quaternion`, [0, 0.5, 1],
    constant ? [...key(0.3), ...key(0.3), ...key(0.3)]
             : [...key(0.3), ...key(0.9), ...key(0.3)]));
  const clip = new THREE.AnimationClip('idle', 1, tracks);
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.enabled = true; action.setEffectiveWeight(0); action.play();   // as Avatar does
  action.setEffectiveWeight(1);                                          // ...then selected

  const self: any = {
    _limp: false, _parked: null, _override: null, emote: null, pitch: 0,
    root, mixer, actions: { idle: action }, current: action, currentSlot: 'idle',
    head: nodes.head,
    vrm: {
      humanoid: {
        humanBones: Object.fromEntries(BONES.map((b) => [b, {}])),
        getNormalizedBoneNode: (b: string) => nodes[b] ?? null,
      },
    },
    cancelEmote() { this.emote = null; },
  };
  self._composed = new Map();
  // setLimp reaches into the eyes and the wings on the way past. Both find
  // NOTHING on this fixture (no vrm.scene to traverse) and say so, which is the
  // behaviour a rig without lids or wings needs anyway — but they have to be
  // real methods, or setLimp throws and the whole suite stops at test two.
  for (const m of ['setLimp', '_park', '_resolveBones', '_humanoidBones', 'setPose',
                   'clearPose', '_applyOverride', '_composeBegin', '_composeEnd',
                   'setEyes', '_findLids', '_findWings', '_releaseHair', '_combHair']) {
    self[m] = (Avatar.prototype as any)[m];
  }
  // the slice of update() that matters here, in its real order
  self.tick = function (dt = 1 / 60) {
    this.mixer.update(dt);
    if (this._limp) this._park();
    if (this.head && !this._limp) {
      const r = this._composeBegin(this.head);
      if (this.pitch) {
        this.head.quaternion.premultiply(new THREE.Quaternion()
          .setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.clamp(this.pitch, -0.5, 0.6)));
      }
      this._composeEnd(this.head, r);
    }
    if (this._override) this._applyOverride(dt, 0);
  };
  return { self, nodes, action };
}
const moved = (n: any) => Math.abs(n.quaternion.y) > 1e-6;

console.log('avatar clip/limp lifecycle, headless:\n');

console.log('going limp:');
{
  const { self, nodes, action } = stand();
  self.tick();
  check('the clip drives every bone before anything happens',
    BONES.every((b) => moved(nodes[b])));

  self.setLimp(true);
  // THE regression: stopping the mixer deactivates actions that are never
  // play()ed again, and restoreOriginalState snaps the skeleton to bind pose
  check('the mixer is NOT stopped — actions stay active', action.isRunning());
  check('...so no bone was snapped to its bind pose (the T-pose flash)',
    DRIVEN_BONES.every((b: string) => moved(nodes[b])),
    DRIVEN_BONES.filter((b: string) => !moved(nodes[b])).join(' '));
  check('undriven bones are parked at rest', UNDRIVEN.every((b) => !moved(nodes[b])),
    UNDRIVEN.filter((b) => moved(nodes[b])).join(' '));

  self.tick();
  check('...and stay parked after the next mixer write',
    UNDRIVEN.every((b) => !moved(nodes[b])),
    UNDRIVEN.filter((b) => moved(nodes[b])).join(' '));
}

console.log('\nthe tumble owns the driven bones from frame one:');
{
  const { self, nodes } = stand();
  self.setLimp(true);
  const target = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.2);
  self.setPose({ hips: [target.x, target.y, target.z, target.w] });
  check('a pose applied while limp starts at FULL weight, not ramping from the clip',
    self._override.weight === 1, `weight ${self._override.weight}`);
  self.tick();
  check('...so the first rendered frame is the sim, not a blend',
    nodes.hips.quaternion.angleTo(target) < 1e-3,
    `off by ${nodes.hips.quaternion.angleTo(target).toFixed(3)} rad`);

  const held = stand();
  held.self.setPose({ hips: [target.x, target.y, target.z, target.w] });
  check('a held pose arriving over the wire still eases in',
    held.self._override.weight === 0);
}

console.log('\ngetting up:');
{
  const { self, nodes, action } = stand();
  self.setLimp(true);
  self.tick();
  self.setLimp(false);
  self.tick();
  check('the clip animates the body again', BONES.every((b) => moved(nodes[b])),
    BONES.filter((b) => !moved(nodes[b])).join(' '));
  check('...because the action was never deactivated', action.isRunning());

  // head pitch composes with += on the assumption the mixer rewrote the bone
  // first. If the mixer ever goes silent this integrates forever — which is
  // exactly what a spinning head looked like.
  self.pitch = 0.3;
  const seen = new Set<string>();
  for (let i = 0; i < 240; i++) { self.tick(); seen.add(nodes.head.rotation.x.toFixed(4)); }
  check('head pitch does not accumulate frame over frame', seen.size <= 2,
    `${seen.size} distinct values, last ${nodes.head.rotation.x.toFixed(2)} rad`);
  check('...and stays inside its clamp', Math.abs(nodes.head.rotation.x) < 1.6,
    `${nodes.head.rotation.x.toFixed(2)} rad`);
}

console.log('\ncomposing on a clip that holds still:');
for (const constant of [false, true]) {
  const tag = constant ? 'still track' : 'animated track';

  // three.js only writes a bone when the clip's computed value CHANGES, so on
  // a still track nothing puts back what we composed on top. Head pitch used
  // to integrate one pitch per frame — 54 radians in three seconds.
  {
    const { self, nodes } = stand({ constant });
    self.pitch = 0.3;
    for (let i = 0; i < 180; i++) self.tick();
    const base = stand({ constant });
    for (let i = 0; i < 180; i++) base.self.tick();
    const applied = nodes.head.quaternion.angleTo(base.nodes.head.quaternion);
    check(`${tag}: head pitch holds at its value instead of integrating`,
      Math.abs(applied - 0.3) < 0.02, `${applied.toFixed(2)} rad of pitch after 3s`);
  }

  // ...and clearPose used to be a one-way door: the bone never walked back to
  // the clip, so a body could stand up still holding the pose it landed in.
  {
    const { self, nodes } = stand({ constant });
    for (let i = 0; i < 30; i++) self.tick();
    const clipPose = nodes.hips.quaternion.clone();
    const t = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.2);
    self.setPose({ hips: [t.x, t.y, t.z, t.w] });
    for (let i = 0; i < 60; i++) self.tick();
    check(`${tag}: a held pose reaches its target`,
      nodes.hips.quaternion.angleTo(t) < 1e-3);
    self.clearPose();
    for (let i = 0; i < 60; i++) self.tick();
    check(`${tag}: ...and releasing it returns the bone to the clip`,
      nodes.hips.quaternion.angleTo(clipPose) < 1e-3,
      `${nodes.hips.quaternion.angleTo(clipPose).toFixed(3)} rad off`);
  }
}

// ---- wings ------------------------------------------------------------------
// The flap is geometry, and geometry is exactly the kind of thing that "runs
// without throwing" while pointing the wrong way — the eyelids shipped rotating
// about the wrong axis and passed every check there was, because every check
// asked whether a number had changed. So these ask where the WING TIP went.
//
// The rest pose below is mythos's own, read out of mythos-wings.blend and
// converted to glTF's Y-up (x, z, -y): wings that leave the shoulder blades and
// sweep out, up and back.
//
// THREE bones per chain since 08-17, and the fixture is a list per chain rather
// than named _1/_tip slots so that growing a chain again is a data edit. A
// fixture that hard-codes the chain length cannot catch a depth bug — which is
// exactly what happened: `_1` and `_2` both parsed as depth 1 (an underscore
// COUNT, not the index), and with only two-bone chains in the fixture nothing
// had a third segment to disagree about.
const WING_REST: Record<string, [number, number, number][]> = {
  // chain: [seg 0, seg 1, seg 2, ..., end of the last segment]
  L_Wing_Upper: [
    [0.0369, 0.7923, -0.067], [0.1696, 0.9047, -0.1645],
    [0.2307, 0.9479, -0.2038], [0.4386, 1.0227, -0.3627],
  ],
  R_Wing_Upper: [
    [-0.0432, 0.7923, -0.067], [-0.1786, 0.9047, -0.1623],
    [-0.2361, 0.9471, -0.2026], [-0.4469, 1.0162, -0.3524],
  ],
  L_Wing_Lower: [
    [0.0409, 0.7771, -0.067], [0.1466, 0.7004, -0.133],
    [0.2224, 0.5254, -0.1626], [0.2554, 0.3382, -0.1864],
  ],
  R_Wing_Lower: [
    [-0.0432, 0.7754, -0.067], [-0.1466, 0.7066, -0.1155],
    [-0.2339, 0.5265, -0.1617], [-0.2599, 0.3393, -0.1884],
  ],
};

function wingStand() {
  const root = new THREE.Object3D();
  const chest = new THREE.Object3D(); chest.name = 'upperChest';
  root.add(chest);
  const nodes: Record<string, any> = { upperChest: chest };
  for (const [chain, pts] of Object.entries(WING_REST)) {
    const V = (i: number) => new THREE.Vector3(...pts[i]);
    let parent = chest;
    for (let i = 0; i < pts.length - 1; i++) {
      const n = new THREE.Object3D();
      n.name = i === 0 ? chain : `${chain}_${i}`;
      n.position.copy(V(i)).sub(i === 0 ? new THREE.Vector3() : V(i - 1));
      parent.add(n);
      nodes[n.name] = n;
      parent = n;
    }
    // not a bone — a marker at the end of the outermost segment, so a test can
    // ask where the WING went rather than what a quaternion contains
    const tip = new THREE.Object3D();
    tip.name = `${chain}_tip#marker`;
    tip.position.copy(V(pts.length - 1)).sub(V(pts.length - 2));
    parent.add(tip);
    nodes[`${chain}_tip`] = tip;
  }
  const self: any = {
    _limp: false, root, emote: null, _parked: null,
    vrm: {
      scene: root,
      humanoid: {
        humanBones: {},
        getNormalizedBoneNode: (n: string) => nodes[n] ?? null,
      },
    },
    cancelEmote() { this.emote = null; },
  };
  for (const m of ['_findWings', '_flap', 'setLimp', 'setEyes', '_findLids',
                   '_resolveBones', '_humanoidBones', '_park', '_releaseHair', '_combHair']) {
    self[m] = (Avatar.prototype as any)[m];
  }
  self._findWings();
  self.tick = function (dt = 1 / 60) {
    if (!this._limp) this._flap(dt);
    root.updateMatrixWorld(true);
  };
  const tipY = (n: string) => {
    root.updateMatrixWorld(true);
    return nodes[n].getWorldPosition(new THREE.Vector3()).y;
  };
  const tipPos = (n: string) => {
    root.updateMatrixWorld(true);
    return nodes[n].getWorldPosition(new THREE.Vector3());
  };
  return { self, nodes, tipY, tipPos };
}

console.log('\nwings:');
{
  const { self, nodes } = wingStand();
  check('every wing bone is found (4 chains x 3)', self._wings?.length === 12,
    `${self._wings?.length ?? 0} found`);
  check('...at the depth its NAME says, not a count of underscores',
    JSON.stringify(self._wings.map((w: any) => w.depth).sort()) === '[0,0,0,0,1,1,1,1,2,2,2,2]',
    self._wings.map((w: any) => `${w.node.name}=${w.depth}`).join(' '));
  check('roots are visited before tips',
    self._wings.every((w: any, i: number) => i === 0
      || w.depth >= self._wings[i - 1].depth));
  check('sides are read off the name',
    self._wings.filter((w: any) => w.side === 1).length === 6
    && self._wings.filter((w: any) => w.side === -1).length === 6);
  check('the authored pose is shared with the ragdoll',
    self.__wingRest instanceof Map && self.__wingRest.size === 12);
  // nodes are referenced so the fixture cannot be optimised into nothing
  check('the marker hangs off the OUTERMOST segment',
    nodes.L_Wing_Upper_tip.parent === nodes.L_Wing_Upper_2);
}

{
  // Sweep a whole cycle and record where each tip goes.
  const { self, tipY, tipPos } = wingStand();
  const { WING_IDLE } = await import('../client/lib/avatar.js');
  const dt = 1 / 120;
  const frames = Math.round(1 / (WING_IDLE.hz * dt));      // one full flap
  const track: Record<string, number[]> = {};
  const p0: Record<string, any> = {};
  for (const n of ['L_Wing_Upper_tip', 'R_Wing_Upper_tip',
                   'L_Wing_Lower_tip', 'R_Wing_Lower_tip']) {
    track[n] = []; p0[n] = tipPos(n).clone();
  }
  for (let i = 0; i <= frames; i++) {
    self.tick(dt);
    for (const n of Object.keys(track)) track[n].push(tipY(n));
  }
  const span = (n: string) => Math.max(...track[n]) - Math.min(...track[n]);
  check('the tips actually move', Object.keys(track).every((n) => span(n) > 0.02),
    Object.keys(track).map((n) => `${n} ${span(n).toFixed(3)}m`).join(' '));

  // THE AXIS test — asked as "which axis", not "which direction the tip went".
  //
  // The first version asserted the swing was VERTICAL, which held while every
  // wing pointed outward and broke the moment the lower chain was re-authored
  // to hang DOWN: rotate a drooping wing about the body's forward axis and its
  // tip travels sideways, correctly. That test was reading the rig's geometry
  // and calling it the code's axis.
  //
  // What the flap actually promises is that it turns about the body's FORWARD
  // axis, and a rotation about forward moves nothing along forward. So with the
  // sweep off, every tip must stay in the frontal plane, whatever direction its
  // bone happens to point. Geometry can change freely under this.
  {
    const sweep0 = WING_IDLE.sweep;
    WING_IDLE.sweep = 0;
    const rep = wingStand();
    const fore: Record<string, number[]> = {};
    for (const n of Object.keys(track)) fore[n] = [];
    for (let i = 0; i <= frames; i++) {
      rep.self.tick(dt);
      for (const n of Object.keys(track)) fore[n].push(rep.tipPos(n).z);
    }
    WING_IDLE.sweep = sweep0;
    const rng = (a: number[]) => Math.max(...a) - Math.min(...a);
    const worst = Math.max(...Object.keys(fore).map((n) => rng(fore[n])));
    check('the flap turns about the body FORWARD axis (no fore/aft without sweep)',
      worst < 0.001, `${(worst * 1000).toFixed(2)}mm of fore/aft leaked in`);
  }

  // Symmetry: both sides must rise together. A sign error here gives one wing
  // up while the other goes down, which is the single most likely mistake in
  // the whole file and looks deliberate enough to survive a glance.
  const corr = (a: string, b: string) => {
    const A = track[a], B = track[b];
    const ma = A.reduce((s, v) => s + v, 0) / A.length;
    const mb = B.reduce((s, v) => s + v, 0) / B.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < A.length; i++) {
      num += (A[i] - ma) * (B[i] - mb); da += (A[i] - ma) ** 2; db += (B[i] - mb) ** 2;
    }
    return num / Math.sqrt(da * db);
  };
  check('left and right rise TOGETHER (mirrored, not opposed)',
    corr('L_Wing_Upper_tip', 'R_Wing_Upper_tip') > 0.99,
    `r=${corr('L_Wing_Upper_tip', 'R_Wing_Upper_tip').toFixed(3)}`);
  check('the upper and lower pairs are in sync',
    corr('L_Wing_Upper_tip', 'L_Wing_Lower_tip') > 0.9,
    `r=${corr('L_Wing_Upper_tip', 'L_Wing_Lower_tip').toFixed(3)}`);
}

{
  // THE SWEEP: tips have to travel FORWARD and BACK too, not only up and down.
  // Rotating about the forward axis alone confines every tip to the frontal
  // plane — "rotating on the X-Z plane", as Janus put it — and that reads as a
  // hinge. Three things have to hold, and a silent no-op passes none of them.
  const { WING_IDLE } = await import('../client/lib/avatar.js');
  const { self, tipPos } = wingStand();
  const dt = 1 / 120;
  const frames = Math.round(1 / (WING_IDLE.hz * dt));
  const ys: Record<string, number[]> = {}, zs: Record<string, number[]> = {};
  const names = ['L_Wing_Upper_tip', 'R_Wing_Upper_tip'];
  for (const n of names) { ys[n] = []; zs[n] = []; }
  for (let i = 0; i <= frames; i++) {
    self.tick(dt);
    for (const n of names) { const p = tipPos(n); ys[n].push(p.y); zs[n].push(p.z); }
  }
  const rng = (a: number[]) => Math.max(...a) - Math.min(...a);
  const corr = (A: number[], B: number[]) => {
    const ma = A.reduce((s, v) => s + v, 0) / A.length;
    const mb = B.reduce((s, v) => s + v, 0) / B.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < A.length; i++) {
      num += (A[i] - ma) * (B[i] - mb); da += (A[i] - ma) ** 2; db += (B[i] - mb) ** 2;
    }
    return num / Math.sqrt(da * db);
  };
  const fa = rng(zs.L_Wing_Upper_tip);
  check('the tips also travel FORE AND AFT, not only in the frontal plane',
    fa > 0.02, `${(fa * 100).toFixed(1)}cm fore/aft`);
  check('...both wings sweeping forward together',
    corr(zs.L_Wing_Upper_tip, zs.R_Wing_Upper_tip) > 0.99,
    `r=${corr(zs.L_Wing_Upper_tip, zs.R_Wing_Upper_tip).toFixed(3)}`);
  // quadrature is what opens the path into an ellipse. In phase (r near ±1) the
  // tip runs up and down a tilted straight line, which is still just a hinge —
  // a sweep that "works" by every other measure and changes nothing to look at.
  const q = Math.abs(corr(ys.L_Wing_Upper_tip, zs.L_Wing_Upper_tip));
  check('...and the tip path is an ellipse, not a tilted straight line',
    q < 0.4, `|r(up, fore)|=${q.toFixed(3)} — 1.0 would be a line`);
}

{
  // Does not integrate. Every frame rebuilds from the captured rest, so after
  // any number of whole cycles the pose is the pose it started in — the failure
  // this prevents is a wing that winds slowly around its own axis over an hour
  // and is invisible for the first ten minutes.
  const { self, nodes } = wingStand();
  const { WING_IDLE } = await import('../client/lib/avatar.js');
  // dt chosen so a cycle is a WHOLE number of frames. With a round dt the last
  // frame of each cycle lands short, and 300 cycles of that rounding is a
  // quarter turn of phase — which the first version of this test dutifully
  // reported as 30° of drift in the code. The test was the thing drifting.
  const perCycle = 600;
  const dt = 1 / (WING_IDLE.hz * perCycle);
  self.tick(dt);
  const q0 = nodes.L_Wing_Upper.quaternion.clone();
  for (let c = 0; c < 300; c++) for (let i = 0; i < perCycle; i++) self.tick(dt);
  const drift = nodes.L_Wing_Upper.quaternion.angleTo(q0);
  check('300 cycles later the wing is where it started (no integration)',
    drift < 1e-3, `${(drift * 180 / Math.PI).toFixed(3)}° of drift`);
}

{
  // The handover. While limp the flap must not write — the ragdoll owns these
  // bones — and standing up must ease out of the pose the fall left, not cut.
  const { self, nodes } = wingStand();
  for (let i = 0; i < 40; i++) self.tick();
  (Avatar.prototype as any).setLimp.call(self, true);
  const fallen = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.1);
  nodes.L_Wing_Upper.quaternion.copy(fallen);
  for (let i = 0; i < 40; i++) self.tick();
  check('while limp the flap writes nothing',
    nodes.L_Wing_Upper.quaternion.angleTo(fallen) < 1e-9);

  // through the real setLimp — assigning _limp first would make it return at
  // its own `on === this._limp` guard, and the test would be asserting on a
  // method that never ran
  (Avatar.prototype as any).setLimp.call(self, false);
  check('standing up captures where the sim left each wing',
    self._wings.every((w: any) => w.from) && self._wingBlend === 0);
  self.tick();
  const moved1 = nodes.L_Wing_Upper.quaternion.angleTo(fallen);
  check('...and the first frame back is a step, not a teleport',
    moved1 > 0 && moved1 < 0.25, `${(moved1 * 180 / Math.PI).toFixed(1)}° in one frame`);
  for (let i = 0; i < 120; i++) self.tick();
  check('...and the blend completes', self._wingBlend === 1);
}

// ---- one author per hair bone ----------------------------------------------
// A rig with Hair_* chains has TWO simulators: ammodoll's Bullet bodies (system
// 'me-drive') and three-vrm's springBoneManager, which runs inside vrm.update
// one system later in 'me-update' and therefore always wrote last. The Bullet
// boxes swung and the rendered hair did not follow.
//
// Nothing else can catch this: every bone is finite, every quaternion is
// written, both sims are "working". The only observable is WHICH ran last.
{
  console.log('\nhair ownership while the sim drives it:');
  const mk = () => {
    const calls: string[] = [];
    const self: any = {
      _limp: false, _wings: null, _lids: null, _eyes: null, __simHair: false,
      vrm: {
        springBoneManager: { update: () => calls.push('spring'), reset: () => calls.push('reset') },
        update: function (d: number) { this.springBoneManager?.update(d); },
      },
    };
    // the slice of Avatar.update that decides the question
    self.tick = function (dt = 1 / 60) {
      const sbm = this.__simHair ? this.vrm.springBoneManager : null;
      if (sbm) this.vrm.springBoneManager = null;
      this.vrm.update(dt);
      if (sbm) this.vrm.springBoneManager = sbm;
    };
    return { self, calls };
  };
  const a = mk();
  a.self.tick();
  check('a standing body runs three-vrm springbones (hair moves while walking)',
    a.calls.includes('spring'));

  const b = mk();
  b.self._limp = true; b.self.__simHair = true;
  b.calls.length = 0;
  for (let i = 0; i < 10; i++) b.self.tick();
  check('...but not while a local sim owns those same bones',
    !b.calls.includes('spring'), `${b.calls.length} springbone updates ran`);
  check('...and the manager is restored, not lost',
    b.self.vrm.springBoneManager?.update != null);

  // Handing the hair back must not COMB it. joint.reset() restores each bone's
  // _initialLocalRotation, so the fallen shape would snap to default — which is
  // exactly what it did, a few seconds into every fall.
  {
    const q = (x: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), x);
    const bone = { quaternion: q(1.1) };                 // where the tumble left it
    const joint = { bone, _initialLocalRotation: q(0) }; // combed
    const self: any = {
      __simHair: true, _limp: true,
      vrm: {
        scene: { updateMatrixWorld() {} },
        springBoneManager: {
          joints: new Set([joint]),
          reset() { bone.quaternion.copy(joint._initialLocalRotation); },
        },
      },
    };
    self._releaseHair = (Avatar.prototype as any)._releaseHair;
    self._combHair = (Avatar.prototype as any)._combHair;
    self._releaseHair();
    check('releasing the hair KEEPS the pose the fall left',
      bone.quaternion.angleTo(q(1.1)) < 1e-6,
      `moved ${(bone.quaternion.angleTo(q(1.1)) * 180 / Math.PI).toFixed(1)}°`);
    check('...and puts the combed rest back, so it still combs out afterwards',
      joint._initialLocalRotation.angleTo(q(0)) < 1e-6);
    check('...and ownership is released', self.__simHair === false);
  }

  // A limp body with NO sim of its own must hang its hair on the world. The
  // springs are authored for standing — gravity near zero, stiffness pulling
  // toward a rest direction that rotates WITH the body — so on a body lying on
  // its side the hair is pulled sideways and gravity cannot argue.
  {
    const { LIMP_SPRINGS } = await import('../client/lib/avatar.js');
    const hips = { name: 'Hip' };
    const joint: any = {
      settings: { stiffness: 1.0, gravityPower: 0.02 }, _center: hips,
      bone: { quaternion: new THREE.Quaternion() },
      _initialLocalRotation: new THREE.Quaternion(),
    };
    let resets = 0;
    const self: any = {
      _limp: false, __simHair: false,
      vrm: {
        scene: { updateMatrixWorld() {} },
        springBoneManager: { joints: new Set([joint]), reset() { resets++; } },
      },
    };
    self._springsLimp = (Avatar.prototype as any)._springsLimp;
    self._springsResync = (Avatar.prototype as any)._springsResync;
    self._springsLimp(false);
    check('a standing body keeps the rig\'s own spring settings',
      joint.settings.stiffness === 1.0 && joint.settings.gravityPower === 0.02);
    self._springsLimp(true);
    check('a limp body with no sim lets gravity win',
      joint.settings.gravityPower >= LIMP_SPRINGS.gravity
      && joint.settings.stiffness < 1.0,
      `stiffness ${joint.settings.stiffness}, gravity ${joint.settings.gravityPower}`);
    check('...and gravity is a FLOOR, not a replacement',
      joint.settings.gravityPower === Math.max(0.02, LIMP_SPRINGS.gravity));
    self._springsLimp(false);
    check('...restored exactly on standing, so nothing accumulates',
      joint.settings.stiffness === 1.0 && joint.settings.gravityPower === 0.02);
    // the CENTER is why a carried body's hair rotates rigidly with it: the tail
    // state lives in hip space, so turning the body is invisible to the springs
    self._springsLimp(true);
    check('a limp body simulates its hair in the WORLD, not in its hips',
      joint._center === null);
    check('...re-deriving the tails, which lived in the frame just changed',
      resets > 0);
    self._springsLimp(false);
    check('...and the hips center comes back on standing',
      joint._center === hips);
    // and it must be idempotent — update() calls it every frame
    for (let i = 0; i < 5; i++) self._springsLimp(true);
    check('...and repeated calls do not compound the factor',
      Math.abs(joint.settings.stiffness - 1.0 * LIMP_SPRINGS.stiffness) < 1e-9,
      `stiffness ${joint.settings.stiffness}`);
  }

  // Letting go of a DRAGGED body disposes its doll mid-tumble. Adopting the
  // fallen shape hands the hair back live; not handing it back at all left it
  // owned by a sim that no longer existed and frozen in mid-air — seen on a
  // dragged dummy, never on a body going limp on its own, because that one
  // keeps its doll until it settles.
  {
    const q = (x: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), x);
    const bone = { quaternion: q(0.9) };
    const joint = { bone, _initialLocalRotation: q(0) };
    const self: any = {
      __simHair: true, _limp: true,
      vrm: {
        scene: { updateMatrixWorld() {} },
        springBoneManager: {
          joints: new Set([joint]),
          reset() { bone.quaternion.copy(joint._initialLocalRotation); },
        },
      },
    };
    self._releaseHair = (Avatar.prototype as any)._releaseHair;
    self._combHair = (Avatar.prototype as any)._combHair;
    self._releaseHair({ adopt: true });
    check('a doll disposing mid-tumble hands the hair back LIVE, not frozen',
      self.__simHair === false);
    check('...keeping the pose it was dropped in',
      bone.quaternion.angleTo(q(0.9)) < 1e-6);
    check('...with the springs now resting THERE, so it falls on with her',
      joint._initialLocalRotation.angleTo(q(0.9)) < 1e-6);
    self._combHair();
    check('...and getting up restores the authored shape (no ratchet)',
      joint._initialLocalRotation.angleTo(q(0)) < 1e-6);
  }

  // a REMOTE body goes limp with no doll of its own — suppressing there would
  // freeze its hair completely, which is worse than the bug
  const c = mk();
  c.self._limp = true;            // limp, but nothing claimed the hair
  c.calls.length = 0;
  c.self.tick();
  check('a limp REMOTE (no local sim) keeps its springbone hair',
    c.calls.includes('spring'));
}

{
  // A rig with no wings must not cost anything or throw.
  const root = new THREE.Object3D();
  const self: any = { _limp: false, root, vrm: { scene: root, humanoid: {} } };
  self._findWings = (Avatar.prototype as any)._findWings;
  self._findWings();
  check('a wingless rig finds nothing and says so', self._wings === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
