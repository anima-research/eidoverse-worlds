// Test stand-in for the renderer-bound edge of the settings panels' import cone — see
// tools/settings-panels-test.ts. ONE file answers for core.js, base.js, governor.js,
// lightrig.js, xrpanels.js, net.js, palette.js, avatar.js, controller.js, capnotice.js,
// assets.js and mictoggle.js (the names never collide), so the suite drives the REAL
// ui.js / frames.js / panels.js / presence.js / stylepanel.js / videopanel.js /
// profile.js / bodies.js / mybody.js against a recorder instead of a GPU.
//
// core-stub's bus is inert (`on() {}`); these panels are wired THROUGH the bus
// (presence:me → the dock dot, avatar-worn → the bodies list), so this one is real.
export * from './core-stub.mjs';

// ---- base.js: a real bus, a named person in a named world
const handlers = new Map();
export const bus = {
  on(t, f) { (handlers.get(t) ?? handlers.set(t, []).get(t)).push(f); return () => { const l = handlers.get(t); const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }; },
  emit(t, p) { emitted.push([t, p]); for (const f of [...(handlers.get(t) ?? [])]) f(p); },
};
export const emitted = [];   // every bus.emit, in order — the suite counts xr:repaint / avatar-worn here
export const CONFIG = { params: new URLSearchParams(), name: 'tester', world: 'testworld', avatar: 'claude', token: 't' };

// ---- the recorder: every setter the panels are supposed to reach lands here
export const calls = [];
const rec = (name) => (...a) => { calls.push([name, ...a]); };

// ---- governor.js
export const RENDER_SCALES = ['auto', '1', '0.85', '0.7'];
let renderScale = 'auto';
export const getRenderScale = () => renderScale;
export const setRenderScale = (v) => { calls.push(['setRenderScale', v]); renderScale = v; };
export const PARTICLE_TIERS = ['auto', 'med', 'low'];
let particleTier = 'auto';
export const getParticleTier = () => particleTier;
export const setParticleTier = (v) => { calls.push(['setParticleTier', v]); particleTier = v; };
export const AVATAR_DETAILS = { auto: null, full: 1, half: 2, low: 4 };
let avatarDetail = 'auto';
export const getAvatarDetail = () => avatarDetail;
export const setAvatarDetail = (v) => { calls.push(['setAvatarDetail', v]); avatarDetail = v; };

// ---- lightrig.js
let shadows = true, res = 2048;
export const SHADOW_RES = [1024, 2048, 4096];
export const shadowsOn = () => shadows;
export const setShadows = (on) => { calls.push(['setShadows', on]); shadows = !!on; };
export const shadowRes = () => res;
export const setShadowRes = (n) => { calls.push(['setShadowRes', n]); res = n; };

// ---- xrpanels.js: the quad registry, kept so the suite can drive a panel's dispatch
export const xrPanels = new Map();
export const registerXRPanel = (p) => { xrPanels.set(p.id, p); calls.push(['registerXRPanel', p.id]); };

// ---- net.js
export const net = { avatars: [], joined: false };
export const sendVerb = rec('sendVerb');
export const sendJoin = rec('sendJoin');
export const requestHistory = async () => ({ entries: [], hasMore: false });

// ---- palette.js
let onSwitch = null;
export const wireAvatarSwitch = (fn) => { onSwitch = fn; };
export const switchAvatar = (path, name) => { calls.push(['switchAvatar', path, name]); return onSwitch?.(path, name); };
export const setMyAvatarPath = rec('setMyAvatarPath');

// ---- avatar.js
export const makeAvatar = async (who, path) => ({ name: path.split('/').pop().replace(/\.vrm.*$/, ''), path, dispose() {} });
export const contributeThumbnail = rec('contributeThumbnail');

// ---- controller.js
export const armFlight = () => false;
export const folded = () => false;

// ---- capnotice.js
export const WEBGL = { active: false };

// ---- assets.js (ui.js reads the byte ledger for the splash)
export const loadingItems = () => [];

// ---- mictoggle.js (ui.js's dock glyphs; nothing here toggles a real mic)
export const flipMic = rec('flipMic');
export const flipEar = rec('flipEar');
export const micLive = () => false;
export const earOn = () => false;
export const glyphPinned = () => false;
export const setGlyphPinned = rec('setGlyphPinned');
export const micGlyph = () => '';
export const earGlyph = () => '';
export const xrGlyph = () => '';
export const xrGlyphAvailable = () => false;
export const xrLive = () => false;
export const flipXr = rec('flipXr');
