// dock-test substitutes this for everything ui.js imports that is NOT under test: base.js (bus/CONFIG/
// sinks), mictoggle.js (the mic/ear/VR glyph surface the ∃ menu paints), xrpanels.js, assets.js, defs.js,
// and the four panel modules initPanels() pulls in dynamically. One file, many specifiers — extra exports are
// harmless, a MISSING one is a SyntaxError that takes the suite down before a single check runs.
// frames.js, icons.js and dropdown.js stay REAL: the dock's contract is with them.
const handlers = new Map();
export const bus = {
  on(t, f) { (handlers.get(t) ?? handlers.set(t, []).get(t)).push(f); },
  emit(t, p) { for (const f of handlers.get(t) ?? []) f(p); },
};
export const CONFIG = { name: 'tester', world: 'w', token: '', authed: false, params: new URLSearchParams() };
export const report = () => {};
export const tee = () => {};
export const setName = () => {};
export const setToken = () => {};
export const setErrorSink = () => {};
export const colorFor = () => '#8fb572';
export const assignColors = () => {};

// ---- mictoggle.js surface (what ui.js destructures)
const G = (nm) => (size = 16) => `<svg data-glyph="${nm}" width="${size}" height="${size}" viewBox="0 0 26 26"><circle cx="13" cy="13" r="6"/></svg>`;
let _mic = false, _ear = false;
const _pinned = {};
export const flipMic = async () => { _mic = !_mic; };
export const flipEar = async () => { _ear = !_ear; };
export const micLive = () => _mic;
export const earOn = () => _ear;
export const glyphPinned = (k) => !!_pinned[k];
export const setGlyphPinned = (k, v) => { _pinned[k] = !!v; };
export const micGlyph = G('mic');
export const earGlyph = G('ear');
export const xrGlyph = G('xr');
export const xrGlyphAvailable = () => false;
export const xrLive = () => false;
export const flipXr = () => {};

// ---- xrpanels.js / assets.js / defs.js
export const registerXRPanel = () => {};
export const loadingItems = () => [];
export const defsRegistry = async () => ({});

// ---- the panels initPanels() imports at boot (profile, style, video, capnotice); dropdown.js is real
export const initProfile = () => {};
export const initStylePanel = () => {};
export const initVideoPanel = () => {};
export const initCapNotice = () => {};
