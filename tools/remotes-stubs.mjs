// Substitutes for the modules remotes.js/net.js touch, so the participant
// lifecycle (#95) can be executed without a GPU, a socket, or a DOM. Same
// doctrine as voice-stubs.mjs: only what the code under test uses. THREE is
// real — remotes.js allocates quaternions at module scope and the math must
// be the shipping math.
import * as THREE_REAL from '../client/node_modules/three/build/three.module.js';
export const THREE = THREE_REAL;

const handlers = new Map();
export const bus = {
  on(t, f) { if (!handlers.has(t)) handlers.set(t, []); handlers.get(t).push(f); },
  emit(t, p) { for (const f of [...(handlers.get(t) ?? [])]) f(p); },
};
export const CONFIG = { name: 'tester', world: 'testworld' };
export const camera = { position: new THREE_REAL.Vector3(0, 1.6, 0) };
export const scene = { add() {}, remove() {} };
export const renderer = {};
export const canvas = { addEventListener() {} };
export const report = (...a) => { reports.push(a); };
export const reports = [];
export const parallelMap = (xs, fn) => Promise.all([...xs].map(fn));
export const angleDelta = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

// assets
export const fetchBytes = async () => new ArrayBuffer(0);
export const forgetBytes = () => {};

// world
export const applyEntry = async () => {};
export const stateToEntries = () => [];
export const avatarMounts = new Map();
export const pendingMounts = new Map();
export const mountTransform = () => null;

// chat / ui / boot / fp_view
export const logChat = () => {};
export const logWhisper = () => {};
export const noteTyping = () => {};
export const noteHistoryContext = () => {};
export const composeFirstPerson = () => {};
export const markPhase = () => {};
export const toast = () => {};
export const flashHint = () => {};

// ---- the avatar factory, instrumented --------------------------------------
// makeAvatar receives the RESOLVED path (remotes.js substitutes its default
// for null), so `avatarCalls` is a direct detector for "a default-avatar
// body was constructed" — the sunflower, in a list.
export const avatarCalls = [];
export let disposeCount = 0;
export const resetAvatarLog = () => { avatarCalls.length = 0; disposeCount = 0; pendingLoads.length = 0; };
/** while > 0, makeAvatar returns promises the TEST resolves — the door for
 *  forcing delayed-load races deterministically */
export const pendingLoads = [];
export let holdLoads = false;
export const setHoldLoads = (v) => { holdLoads = v; };

const fakeAvatar = () => ({
  root: { position: Object.assign(new THREE_REAL.Vector3(), { set() {}, copy() {} }), rotation: { y: 0 } },
  dispose() { disposeCount++; },
  transientResets: 0,
  resetTransients() { this.transientResets++; },   // the generation-end seam (#97)
  setTyping() {}, playAnimation() {}, setClip() {}, setPose() {}, clearPose() {},
  setLimp() {}, playEmote() {}, setGazeTarget() {}, update() {},
});

export const makeAvatar = (id, path) => {
  avatarCalls.push({ id, path });
  if (!holdLoads) return Promise.resolve(fakeAvatar());
  return new Promise((resolve) => pendingLoads.push({ id, path, resolve: () => resolve(fakeAvatar()) }));
};
