// Stand-in for every client module thingphysics.js reaches that owns a renderer, a socket or the DOM (tools/put-settle-test.ts).
// base.js (the bus) and state.js (the fold's view and its change events) stay REAL: the contract under test is a change
// event arriving while a hold is on, and what the next frames draw.
export const entities = new Map();
export const remotes = new Map();
export const colliders = new Map();
export const suspended = new Set();
export const colliderLog = [];
export function suspendCollider(id, on) { colliderLog.push([id, on]); if (on) suspended.add(id); else suspended.delete(id); }
export const hostHooks = [];
export const pushHostHook = (fn) => hostHooks.push(fn);
export const colliderFor = () => ({ r: 0.3, h: 1.6 });
export const replica = { active: true, sim: null, simVersion: 0, head: 0, st: { entities: {} }, simClone: () => null };
export const net = { you: 'me', joined: true };
export const sent = [];
export async function sendRequest(verb, args) { sent.push([verb, args]); return { ok: true }; }
export const identities = new Map();
export const flashHint = () => {};
export const logChat = () => {};
export const register = () => {};
export const setPressFx = () => {};
export const pressFxOn = () => [];
export const clockRtt = () => null;
export const plain = (what, r) => `${what}: ${r?.refused?.code ?? ''}`;
export const nameOf = (id) => id;
export const html = (s, ...v) => s.raw.map((x, i) => x + (v[i] ?? '')).join('');
export const xrActive = () => false;
export let clock = 0;
export const setClock = (t) => { clock = t; };
export const serverNow = () => clock;
