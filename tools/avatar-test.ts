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
  for (const m of ['setLimp', '_park', '_resolveBones', '_humanoidBones', 'setPose',
                   'clearPose', '_applyOverride', '_composeBegin', '_composeEnd']) {
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
