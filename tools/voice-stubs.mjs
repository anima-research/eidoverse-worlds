// Substitutes for the modules voice.js/stt.js/voiceconsent.js touch, so the
// consent lifecycle can be executed without a GPU, a socket, or a DOM canvas.
// Same doctrine as chat-core-stub.mjs: only what the code under test uses.
const handlers = new Map();
export const bus = {
  on(t, f) { if (!handlers.has(t)) handlers.set(t, []); handlers.get(t).push(f); },
  emit(t, p) { for (const f of [...(handlers.get(t) ?? [])]) f(p); },
};
export const CONFIG = { name: 'tester' };
export const report = (...a) => { lastReport = a; };
export let lastReport = null;
export const flashHint = () => {};
export const sent = [];
export const sendRtc = (to, payload) => sent.push({ to, payload });
export const myState = { pos: { distanceTo: () => 1 } };
export const remotes = new Map();
export const typed = [];
export const sendTyping = (to, state) => typed.push({ to, state });

// audiopanel mounts through this; give it a real element so panel DOM is testable
export const makeSection = (title, build, opts = {}) => {
  const el = document.createElement('div');
  el.id = `section-${opts.id ?? title}`;
  document.body.appendChild(el);
  build(el);
  return el;
};
