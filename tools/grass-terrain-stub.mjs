// Test stand-in for client/lib/core.js, scoped to terrain.js's cone — see
// tools/grass-quality-test.ts. terrain touches only the scene handle and the
// stage floor/grid visibility, so no renderer (and no three) is needed.
export const scene = { add() {}, remove() {} };
export const ground = { visible: true };
export const grid = { visible: true };
export const bus = { on() {}, emit() {} };
