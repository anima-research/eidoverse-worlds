// originof-test's stand-ins for generate.js's client neighbours: it only needs the module to load, to call originOf.
export const CONFIG = { params: new URLSearchParams(globalThis.__ORRERY_QS ?? '') };
export const bus = { on() {}, emit() {} };
export function report() {}
export const fsvg = () => '';
export function makeSection() { return {}; }
export function toast() {}
export function flashHint() {}
export const net = {};
export function holdGhost() {}
export function logChat() {}
export function sendOps() { return Promise.resolve({ ok: true }); }
