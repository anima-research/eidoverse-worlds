// mods-gate-test's stand-in for everything mods.js imports (base, world, net, ui, physobj, bodysim, frames, chat):
// a real bus, a behaviors roster the test fills with a world offer, and recorders for the rest.
const handlers = new Map();
export const bus = {
  on(t, f) { (handlers.get(t) ?? handlers.set(t, []).get(t)).push(f); },
  emit(t, p) { for (const f of [...(handlers.get(t) ?? [])]) f(p); },
};
export const CONFIG = { world: 'testworld', name: 'tester', token: 't', params: new URLSearchParams() };
export const reports = [];
export const report = (where, e) => { reports.push(`${where}: ${e?.message ?? e}`); };
export const behaviors = new Map();
export const sendVerb = () => {};
export const sections = [];
export const makeSection = (title, onOpen) => { const s = { title, onOpen, remove() {} }; sections.push(s); return s; };
export const toasts = [];
export const toast = (m) => { toasts.push(String(m)); };
export const flashHint = () => {};
export const physicsEnabled = () => true;
export const setPhysicsEnabled = () => {};
export const bodyEngine = () => 'verlet';
export const setBodyEngine = () => {};
export const currentBodyEngine = () => 'verlet';
export const listBodyEngines = () => ['verlet'];
export const makeFrame = () => ({ hide() {}, el: null });
export const chat = [];
export const logChat = (who, text) => { chat.push(String(text)); };
