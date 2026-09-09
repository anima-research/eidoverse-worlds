// Knock-downs, seats, and the input that ends them. The defect this exists
// for (PR #171 review): "stand up when moving" read the input LEVEL, so a
// player shoved while walking stood up on the very next frame — a one-frame
// ragdoll — and a grabbed body broke free before the hand had closed. Getting
// up is an edge now, and it uses the same movement threshold as updateMe.
import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';
import * as THREE from '../client/node_modules/three/build/three.module.js';

const base = `${import.meta.dir}/../client/lib/`;
const input = { moveX: 0, moveZ: 0, jump: false, run: false, creep: false };
const verbs: any[] = [];
const myState = { pos: new THREE.Vector3(), yaw: 0, speed: 0, clip: 'idle', pose: null as any };
const me = {
  root: new THREE.Object3D(),
  setLimp() {}, setClip() {}, setPose() {}, clearPose() {},
  restBonePositions: () => new Map(),
};
const avatarMounts = new Map<string, any>();
let seated = false;

mock.module(base + 'core.js', () => ({ THREE }));
mock.module(base + 'base.js', () => ({ CONFIG: { name: 'me' }, bus: { on() {}, emit() {} } }));
mock.module(base + 'controller.js', () => ({
  myState, updateFollowCamera() {}, setPosture() {}, setSeatHook() {},
}));
mock.module(base + 'input.js', () => ({ movementInput: () => input }));
mock.module(base + 'world.js', () => ({
  avatarMounts, comps: new Map(), socketWorldPos: () => null,
  mountTransform: (_id: string, out: any) => (seated ? (out.set(0, 0.5, 0), { yaw: 0, pose: 'sit' }) : null),
}));
mock.module(base + 'net.js', () => ({ sendVerb: (...a: any[]) => verbs.push(a), sendAnim() {} }));
mock.module(base + 'bodysim.js', () => ({ makeRagdoll: () => ({ step: () => null, dispose() {}, setPin() {}, impulse() {}, done: false }) }));
mock.module(base + 'ragdoll.js', () => ({ jointPositions: () => new Map() }));
mock.module(base + 'bodydrag.js', () => ({ initBodyDrag() {}, beingDragged: () => false, revokeDragged() {} }));
mock.module(base + 'ui.js', () => ({ toast() {}, flashHint() {}, setAmbientHint() {} }));
mock.module(base + 'consent.js', () => ({ posable: () => true, pushable: () => true }));
mock.module(base + 'reachnet.js', () => ({ clearMyReach() {} }));
mock.module(base + 'mybody.js', () => ({ getMe: () => me }));

const { goLimp, getUp, isDowned, updateGetUp, updateMountedMe } = await import('../client/lib/localbody.js');
const neutral = () => { input.moveX = input.moveZ = 0; input.jump = false; };

// Shoved mid-stride, with W still held: the ragdoll has to outlive the key.
input.moveZ = -1;
goLimp();
assert.equal(isDowned(), true);
for (let i = 0; i < 90; i++) updateGetUp();
assert.equal(isDowned(), true, 'a key held through the shove must not stand you back up');
neutral(); updateGetUp();
assert.equal(isDowned(), true, 'the neutral frame re-arms, it does not stand you up');
input.moveZ = -1; updateGetUp();
assert.equal(isDowned(), false, 'movement that starts after the fall does stand you up');

// Jump is intent too, and each knock-down disarms again.
neutral(); goLimp(); input.jump = true;
for (let i = 0; i < 5; i++) updateGetUp();
assert.equal(isDowned(), true, 'a held jump at the moment of the shove is not a new press');
input.jump = false; updateGetUp(); input.jump = true; updateGetUp();
assert.equal(isDowned(), false);

// A worn stick resting just past the 0.18 dead zone rescales to ~0.01. That
// is noise, and noise must not end a knock-down.
neutral(); goLimp(); updateGetUp();
input.moveZ = -0.01;
for (let i = 0; i < 90; i++) updateGetUp();
assert.equal(isDowned(), true, 'sub-threshold stick drift leaves a body down');
input.moveZ = -0.5; updateGetUp();
assert.equal(isDowned(), false);
neutral();

// Same threshold on a seat: drift does not tip you off the swing, real input does.
seated = true; avatarMounts.set('me', {});
input.moveX = 0.01;
updateMountedMe(0.016);
assert.equal(verbs.length, 0, 'sub-threshold stick drift keeps you seated');
input.moveX = 0.5;
updateMountedMe(0.016);
assert.equal(verbs[0]?.[0], 'dismount', 'real movement gets you off the seat');

console.log('Limp/seat input threshold and neutral-latch checks passed');
