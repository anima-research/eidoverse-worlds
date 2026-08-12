// world-hold-stub.mjs — dependency stubs for surface-hold-test.ts, so
// client/lib/world.js can execute headless. Unlike core-stub.mjs's no-op bus,
// this bus is REAL: the hold-then-fallback contract lives entirely in bus
// traffic, so the test needs to emit surface events and observe 'speech'.
const handlers = new Map();
export const bus = {
  on(ev, fn) { (handlers.get(ev) ?? handlers.set(ev, []).get(ev)).push(fn); },
  emit(ev, ...a) { for (const fn of handlers.get(ev) ?? []) fn(...a); },
};

// three-ish surface world.js touches at module scope / in untested verbs
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set() { return this; } toArray() { return [this.x, this.y, this.z]; } setScalar() { return this; } }
class Q { setFromRotationMatrix() { return this; } }
class M4 { compose() { return this; } decompose() { return this; } copy() { return this; } multiplyMatrices() { return this; } }
export const THREE = { Vector3: V3, Quaternion: Q, Matrix4: M4, Object3D: class {}, Group: class {}, MathUtils: { degToRad: (d) => d * Math.PI / 180 } };
export const scene = { add() {}, remove() {} };
export const camera = { position: new V3(), quaternion: {} };
export const renderer = { domElement: null, shadowMap: {} };
export const report = () => {};

// assets.js
export const loadGLB = async () => { const o = new THREE.Object3D(); o.traverse = () => {}; o.position = new V3(); o.rotation = { y: 0 }; o.scale = new V3(); o.userData = {}; return o; };
export const loadEidoModule = async () => null;
export const noiseTexture = () => null;
export const loadTrack = async () => null;
export const loadDone = () => {};
export const libLabels = new Map();
// loadwork.js
export const beginWork = () => ({ done() {} });
// colliders.js
export const fitCollider = () => {};
export const removeCollider = () => {};
export const reindexCollider = () => {};
export const refitCollider = () => {};
// terrain.js
export const setTerrain = () => {};
export const setGrass = () => {};
export const clearGrass = () => {};
export const heightAt = () => 0;
// flora.js
export const buildFloraField = () => {};
// sky.js
export const applySky = () => {};
export const attachLocalLights = () => {};
// forecast.js
export const foldSkyEntry = () => null;
// seats.js / seatcore.js
export const seatCorrectionFor = () => null;
export const applySeatCorrection = () => {};
// lights.js
export const makeLight = () => null;
export const updateLight = () => {};
export const disposeLight = () => {};
// chat.js — observed by the test (captions still logged during a hold)
export const chatLog = [];
export const logChat = (actor, text, tag, extra) => { chatLog.push({ actor, text, tag, extra }); };
// boot.js
export const whenBooted = async () => {};
