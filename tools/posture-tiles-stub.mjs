// posture-tiles-test substitutes this for controller.js's client-side neighbours (core / base / terrain /
// colliders / chat / ui). ONE file: each module's names are disjoint, so one export table serves them all.
// shared/* and fp_view.js are pure and load for real. Everything here is a recorder or a knob the test sets.
import * as THREE_RAW from '../client/node_modules/three/build/three.module.js';
import * as TSL_RAW from '../client/node_modules/three/build/three.tsl.js';

// ---- core.js
export const THREE = THREE_RAW;
export const camera = new THREE_RAW.PerspectiveCamera();
export const canvas = document.createElement('canvas');
// controller.js reaches water.js (swimming): it takes these from core.js at load.
export const TSL = TSL_RAW;   // water.js builds its uniforms at load
export const scene = new THREE_RAW.Scene();
export const sun = new THREE_RAW.DirectionalLight();
export const hemi = new THREE_RAW.HemisphereLight();

// ---- base.js
const handlers = new Map();
export const busLog = [];
export const bus = {
  on(t, f) { (handlers.get(t) ?? handlers.set(t, []).get(t)).push(f); return () => {}; },
  emit(t, p) { busLog.push(t); for (const f of handlers.get(t) ?? []) f(p); },
};
export const CONFIG = { name: 'tester', params: new URLSearchParams() };
export function report() {}
export function angleDelta(a, b) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }

// ---- terrain.js / colliders.js — a flat world; the test places one chair pan when it wants one
export const heightAt = () => 0;
export function setEnvironmentFloor() {}
export const resolveColliders = () => 0;
export const lastBlockedTop = () => null;
export const raySegment = () => Infinity;
export const world = { seat: null };            // { id, x, y, z, yaw } → findSeat returns it
export function findSeat() { return world.seat; }

// ---- chat.js / ui.js
export const chat = { open() {}, isOpen: false };
export const isOverlayOpen = () => false;
export const hints = [];
export function flashHint(t) { hints.push(t); }
