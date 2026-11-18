// Test stand-in for client/lib/render/loadwork.js — the scheduler is irrelevant here.
// beginWork records the phases a load passes through, so a test can see WHERE a load waited (test/client/bodygate-test.mjs).
export const works = [];
export const beginWork = (label) => { const w = { label, phases: [], phase(p) { w.phases.push(p); }, yield: async () => {}, done() {}, end() {} }; works.push(w); return w; };
export const enqueue = (fn) => Promise.resolve(fn?.());
export const idleYield = () => Promise.resolve();
// avatar.js imports nextFrame/loadNote: a stub MISSING an export is a SyntaxError
// at import, and the suite stops covering what it was written for.
export const nextFrame = () => Promise.resolve();
export const loadNote = () => {};
