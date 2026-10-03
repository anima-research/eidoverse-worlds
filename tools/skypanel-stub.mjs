// skypanel-state-test substitutes this for every module skypanel.js imports except rows.js, statelines.js and
// shared/forecast.js (pure, used for real). `S` is the sky the test drives.
const handlers = new Map();
export const bus = {
  on(t, f) { (handlers.get(t) ?? handlers.set(t, []).get(t)).push(f); return () => {}; },
  emit(t, p) { for (const f of handlers.get(t) ?? []) f(p); },
};
export const report = (what, e) => { throw new Error(`${what}: ${e}`); };
export const defsRegistry = async () => ({ skyPresets: {}, skyClocks: {} });
export const sendVerb = (verb, args) => { S.sent.push([verb, args]); };
export const flashHint = () => {};

export const S = { logged: null, args: {}, previewing: false, impl: 'eidoverse', cloudQuality: 'medium', sent: [] };
/** what applySky does to the state the panel reads */
export function logSky(args) {
  S.args = { ...args }; S.logged = { args: S.args, t0: args.ts ?? Date.now() }; S.previewing = false;
  bus.emit('sky-state');
}
export const previewSky = async (args) => { S.args = { ...args }; S.previewing = true; bus.emit('sky-state'); };
export const skyArgs = () => S.args;
export const skyImpl = () => S.impl;
export const loggedSky = () => S.logged;
export const skyPreviewing = () => S.previewing;
export const skyRendering = () => false;
export const skyDegraded = () => false;
export const getCloudQuality = () => S.cloudQuality;
export const getCloudChoice = () => S.cloudQuality;
export const setCloudQuality = (v) => { S.cloudQuality = v; };
export const cloudCap = () => null;
export const skyInXR = () => false;
export const WEATHERS = ['clear', 'fair', 'overcast', 'rain', 'storm'];
export const CLOUDS = ['clear', 'cumulus', 'stratus', 'cirrus'];
export const SKY_WORLDS = ['earth'];
export const CLOUD_QUALITY = ['off', 'low', 'medium', 'high'];

export const GRASS_QUALITY = ['off', 'low', 'full'];
export const getGrassQuality = () => 'full';
export const setGrassQuality = () => {};
export const getGrassDensity = () => 1;
export const getGrassShed = () => 1;
export const getGrassApplied = () => ({ field: false, status: 'applied', strokes: [] });
export const MODEL_QUALITY = ['auto', 'full', 'eco'];
export const modelQuality = { quality: 'auto' };
export const dialModelQuality = () => '';
