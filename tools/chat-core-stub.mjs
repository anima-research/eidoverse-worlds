// chat-log-test substitutes this for core.js — only what chat.js touches.
export const CONFIG = { name: 'tester' };
const handlers = new Map();
export const bus = {
  on(t, f) { (handlers.get(t) ?? handlers.set(t, []).get(t)).push(f); },
  emit(t, p) { for (const f of handlers.get(t) ?? []) f(p); },
};
export const assignColors = () => {};
export const colorFor = () => '#8fb572';
// chat.js → xrpanels.js → domquad.js (VR alpha; the quads themselves are part 4) construct THREE objects at import; every class is inert here
export const THREE = new Proxy({}, { get: () => class { constructor() {} set() { return this; } add() {} remove() {} setFromCamera() {} intersectObjects() { return []; } } });
