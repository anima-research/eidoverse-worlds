// Test stand-in for client/lib/loadwork.js — the scheduler is irrelevant here.
export const beginWork = () => ({ done() {} });
export const enqueue = (fn) => Promise.resolve(fn?.());
export const idleYield = () => Promise.resolve();
// A stub that is MISSING an export is not a stub, it is a broken suite: avatar.js
// grew nextFrame/loadNote imports and this file did not, so avatar-test.ts has
// been dying at import with a SyntaxError rather than running. Adding a name
// here is the price of the module boundary; the alternative is a test that
// silently stops covering the thing it was written for.
export const nextFrame = () => Promise.resolve();
export const loadNote = () => {};
