// handgrab-test substitutes these for handgrab.js's imports — only what it touches.
import * as THREE from '../client/node_modules/three/build/three.module.js';
export { THREE };

export const CONFIG = { spectate: false };
const handlers = new Map();
export const bus = {
  on(t, f) { if (!handlers.has(t)) handlers.set(t, []); handlers.get(t).push(f); },
  emit(t, p) { for (const f of handlers.get(t) ?? []) f(p); },
};

// a REAL camera: pick() projects candidates through it, take() parents to it
export const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
camera.position.set(0, 1.6, 0);
camera.updateMatrixWorld();

// canvas: capture the click handler so the test can synthesize clicks
export const _canvasHandlers = new Map();
export const canvas = {
  addEventListener: (t, f) => _canvasHandlers.set(t, f),
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 800 }),
};

// world.js
export const entities = new Map();
export const comps = new Map();

// net.js
export const sentVerbs = [];
export const sendVerb = (verb, args) => sentVerbs.push({ verb, args });

// ui.js
export const flashHint = () => {};

// controller.js
export const myState = { pos: { x: 0, y: 0, z: 0 } };
let mouselook = false;
export const isMouselook = () => mouselook;
export const _setMouselook = (v) => { mouselook = v; };

// build.js
let editing = false;
export const isEditing = () => editing;
export const _setEditing = (v) => { editing = v; };
