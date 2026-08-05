// chat-log-test substitutes this for core.js — only what chat.js touches.
export const CONFIG = { name: 'tester' };
const handlers = new Map();
export const bus = {
  on(t, f) { (handlers.get(t) ?? handlers.set(t, []).get(t)).push(f); },
  emit(t, p) { for (const f of handlers.get(t) ?? []) f(p); },
};
