// Test stand-in for client/lib/loadwork.js — the scheduler is irrelevant here.
// beginWork records the phases a load passes through, so a test can see WHERE a load waited
// (tools/loadgate-boundary-test.mjs); the scheduler itself is still irrelevant here.
export const works = [];
export const beginWork = (label) => { const w = { label, phases: [], phase(p) { w.phases.push(p); }, yield: async () => {}, done() {}, end() {} }; works.push(w); return w; };
export const enqueue = (fn) => Promise.resolve(fn?.());
export const idleYield = () => Promise.resolve();
// A stub that is MISSING an export is not a stub, it is a broken suite: avatar.js
// grew nextFrame/loadNote imports and this file did not, so avatar-test.ts has
// been dying at import with a SyntaxError rather than running. Adding a name
// here is the price of the module boundary; the alternative is a test that
// silently stops covering the thing it was written for.
export const nextFrame = () => Promise.resolve();
export const loadNote = () => {};
