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
export function flashHint(t) { hints.push(String(t)); }   // a markup hint reads as its text
export { html } from '../client/lib/markup.js';

// ---- names the six real modules export that clients import and this stub lacked (scripted diff, 10-14; each the headless
// truth: no renderer, no socket, no DOM panels — a knob or a recorder, never a behaviour)
// core.js
export const BASE_PIXEL_RATIO = 1;
export const PREF_HEADSET_SEEN = 'ew-headset-seen', PREF_MSAA = 'ew-msaa';
export const WEBGPU_POSSIBLE = false, WEBGPU_XR = false, XR_BOOT = null;
export const axisLines = new THREE_RAW.Object3D(), grid = new THREE_RAW.Object3D(), ground = new THREE_RAW.Object3D();
export const renderer = { backend: {}, xr: { isPresenting: false, getSession: () => null }, setPixelRatio() {}, render() {} };
export const backendName = () => 'none';
export const headsetSeenRecently = () => false;
export function installRenderListTolerance() {}
export const xrPixelRatio = 1;
// base.js
export function assignColors() {}
export const colorFor = () => '#888';
export const reports = [];
export function report(context, err) { reports.push([String(context), err]); }
export function setErrorSink() {}
export function forgetRememberedWorlds() {}
export function setName() {}
export function setToken() {}
export function tee() {}
export function teeNow() {}
export const wornNameOf = (v) => (typeof v === 'string' ? v : v?.name) ?? '';
// terrain.js
export const GRASS_QUALITY = ['off', 'low', 'medium', 'high'];
export const clearGrass = () => {};
export function getGrassApplied() { return null; }
export const getGrassDensity = () => 0, getGrassField = () => null, getGrassQuality = () => 'off', getGrassShed = () => 0;
export const getTerrainMesh = () => null;
export function grassTiles() { return []; }
export const hasGrass = () => false;
export function setGrass() {}
export function setGrassDensity() {}
export function setGrassQuality() {}
export function setTerrain() {}
export function setWaterField() {}   // water.js hands the browser's water to terrain.js (upstream #242, merged 10-15)
// colliders.js
export const colliders = new Map();
export function frameOf() { return null; }
export const lastContacts = () => [];
export function* nearColliders() {}
export function reindexCollider() {}
export function surfaceUnder() { return null; }
export function suspendCollider() {}
// chat.js
export const chatLog = [];
export function logChat(who, text, kind = '') { chatLog.push({ who, text, kind }); }
export function noteHistoryContext() {}
export function noteTyping() {}
// ui.js
export function claimStatus(id, { content = null } = {}) { if (content != null) hints.push(String(content)); }
export function releaseStatus() {}
export function collapseAll() {}
export function dockPins() { return []; }
export const escapeHtml = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function makeSection() { return { body: document.createElement('div'), open() {}, close() {} }; }
export function moderationFrame() { return document.createElement('div'); }
export function paintRangesIn() {}
export function panelFrame() { return { show() {}, hide() {}, visible: false }; }
export function setAmbientHint() {}
export function setDockEntry() {}
export function toast(t) { hints.push(String(t)); }
export function worldSettingsFrame() { return document.createElement('div'); }
