// hint-text-test's stand-in for build.js's import cone: build-gate-stub, plus the one thing select() needs that the
// gate test never reached — editHolds is a Set in world.js (select() calls .add), a Map in build-gate-stub.
export * from './build-gate-stub.mjs';
export const editHolds = new Set();
