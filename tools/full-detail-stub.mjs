// tools/full-detail-stub.mjs — lod-client-stub with STATEFUL levers, for tools/full-detail-test.ts. The shared stub
// answers "nothing to shed" for every lever below 'lod' (so other suites reach it deterministically); this one gives
// each lever a live subject — lights lit, shadows casting, an emitter, a meadow — and records what the governor set,
// so the test can assert the visible values a restore must bring back, not just the governor's own flags.
export * from './lod-client-stub.mjs';

export const state = {
  slotCap: 4, maxSlots: 4, lit: 2,
  casterBudget: 12, casters: 3,
  emitterQuality: 'auto', emitters: 1,
  grass: 1, hasGrass: true,
  lodBias: 1,
  shadowMap: 2048,
};
// lightrig.js
export const setSlotCap = (n) => { state.slotCap = n; };
export const getSlotCap = () => state.slotCap;
export const maxSlots = () => state.maxSlots;
export const litCount = () => state.lit;
export const setCasterBudget = (n) => { state.casterBudget = n; };
export const getCasterBudget = () => state.casterBudget;
export const casterCount = () => state.casters;
export const shadowsOn = () => true;
export const shadowRes = () => 2048;
// emitters.js
export const setEmitterQuality = (q) => { state.emitterQuality = q; return true; };
export const emitterQuality = () => state.emitterQuality;
export const emitterCount = () => state.emitters;
// terrain.js — the governor's shed dial, applied whether or not a field is live (as terrain.js's budget is)
export const setGrassDensity = (f) => { state.grass = f; };
export const getGrassDensity = () => state.grass;
export const hasGrass = () => state.hasGrass;
// remotes.js
export const setLodBias = (b) => { state.lodBias = b; };
// core.js: the sun's shadow map size is what the 'detail' lever moves
export const sun = { shadow: { map: null, mapSize: {
  get width() { return state.shadowMap; },
  set(w) { state.shadowMap = w; },
} } };
