// Knock-downs, seats, and the input that ends them. The defect this exists
// for (PR #171 review): "stand up when moving" read the input LEVEL, so a
// player shoved while walking stood up on the very next frame — a one-frame
// ragdoll — and a grabbed body broke free before the hand had closed. Getting
// up is an edge now, and it uses the same movement threshold as updateMe.
//
// localbody.js is loaded with every sibling client module stubbed: each name it
// imports from './x.js' becomes a no-op unless overridden below, so the test
// follows the module's imports instead of listing them (a second copy of that
// list is what went stale when seats moved to sockets).
import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from '../client/node_modules/three/build/three.module.js';

const base = `${import.meta.dir}/../client/lib/`;
const input = { moveX: 0, moveZ: 0, jump: false, run: false, creep: false };
const seatCalls: any[] = [];
const myState = { pos: new THREE.Vector3(), yaw: 0, speed: 0, clip: 'idle', pose: null as any };
const me = {
  root: new THREE.Object3D(), pitch: 0,
  setLimp() {}, setClip() {}, setPose() {}, clearPose() {}, ensureClip() {}, headWorldPosition: () => null,
  restBonePositions: () => new Map(),
};
const handlers: Record<string, any[]> = {};
const avatarMounts = new Map<string, any>();
let seated = false;

const overrides: Record<string, Record<string, unknown>> = {
  'core.js': { THREE, camera: new THREE.PerspectiveCamera() },
  'base.js': { CONFIG: { name: 'me' }, bus: { on: (ev: string, fn: any) => { (handlers[ev] ??= []).push(fn); }, emit() {} } },
  'controller.js': { myState, keys: new Set(), xrIntent: { active: false }, camYaw: 0, camPitch: 0 },
  'input.js': { movementInput: () => input },
  'world.js': {
    avatarMounts, mountTransform: (_id: string, out: any) => (seated ? (out.set(0, 0.5, 0), { yaw: 0, pose: 'sit' }) : null),
    // a plain seat: the socket lets you go by moving or jumping, and takes no steering
    seatSocket: () => ({ host: null, station: { action: 'sit', leaveBy: 'any' } }),
    setBodySeat: (...a: any[]) => seatCalls.push(a),
    entities: new Map(), bags: () => [], socketsOn: () => [],
  },
  'occupybody.js': {
    driveOccupied: () => ({ pos: new THREE.Vector3(), yaw: 0, clip: 'sitchair', q: new THREE.Quaternion(), sw: { socketQ: [0, 0, 0, 1] } }),
  },
  'mybody.js': { getMe: () => me },
  'consent.js': { posable: () => true, pushable: () => true },
  'bodysim.js': { makeRagdoll: () => ({ step: () => null, dispose() {}, setPin() {}, impulse() {}, done: false }) },
  'ragdoll.js': { jointPositions: () => new Map() },
  'bodydrag.js': { initBodyDrag() {}, beingDragged: () => false, revokeDragged() {} },
  'remotes.js': { serverNow: () => 0 },
  'net.js': { identities: new Map() },
};
const src = readFileSync(base + 'localbody.js', 'utf8');
const wanted = new Map<string, Set<string>>();
for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w.]+)'/g)) {
  const names = wanted.get(m[2]) ?? new Set<string>();
  for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/)[0]; if (n) names.add(n); }
  wanted.set(m[2], names);
}
for (const [file, names] of wanted) {
  const exports: Record<string, unknown> = {};
  for (const n of names) exports[n] = () => undefined;
  Object.assign(exports, overrides[file] ?? {});
  mock.module(base + file, () => exports);
}

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
// (The seat lets you go by moving: leaveBy 'any', and it takes no steering.)
seated = true; avatarMounts.set('me', { to: 'swing' });
input.moveX = 0.01;
updateMountedMe(0.016);
assert.equal(seatCalls.length, 0, 'sub-threshold stick drift keeps you seated');
input.moveX = 0.5;
updateMountedMe(0.016);
assert.deepEqual(seatCalls[0], ['me', null], 'real movement gets you off the seat');

// A gamepad's A (jump) gets you off a seat that lets a jump through, too.
seatCalls.length = 0; neutral(); avatarMounts.set('me', { to: 'swing' });
input.jump = true;
updateMountedMe(0.016);
assert.deepEqual(seatCalls[0], ['me', null], 'jump (A / Space) gets you off the seat');

// B / ○ (and an unclaimed Escape) is the explicit get-up: it stands you up from a seat too, once controller.js's
// cancel chain reaches its standing rung (`cancel-stand`; photo mode goes first: escape-priority-test).
seatCalls.length = 0; neutral(); avatarMounts.set('me', { to: 'swing' });
assert.equal(handlers['input-action'], undefined, 'localbody no longer reads raw cancel (it would skip the chain)');
for (const h of handlers['cancel-stand'] ?? []) h();
assert.deepEqual(seatCalls[0], ['me', null], 'cancel (B / ○ / Escape) gets you off the seat');

console.log('Limp/seat input threshold and neutral-latch checks passed');
