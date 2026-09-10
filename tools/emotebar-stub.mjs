// emotebar-test substitutes this for every neighbour emotebar.js imports except icons.js (pure). ONE file,
// resolved for frames.js / avatar.js / controller.js / mybody.js / xrpanels.js / base.js — each module's
// names are disjoint, so one export table serves them all. Everything is a recorder the test reads.

// ---- base.js: the bus
const handlers = new Map();
export const busLog = [];
export const bus = {
  on(t, f) { (handlers.get(t) ?? handlers.set(t, []).get(t)).push(f); },
  emit(t, p) { busLog.push(t); for (const f of handlers.get(t) ?? []) f(p); },
};
export const CONFIG = { name: 'tester' };
export function report() {}

// ---- frames.js: a frame that carries the refs emotebar rides (_state, _paint, show)
export const frames = [];
export function makeFrame(key, opts = {}) {
  const el = document.createElement('div');
  const body = document.createElement('div');
  el.append(body); document.body.append(el);
  const f = {
    key, opts, el, body, visible: !opts.hidden, paints: 0,
    _state: { w: opts.w, h: opts.h },
    _paint() { this.paints++; },
    show() { this.visible = true; },
    toggle() { this.visible = !this.visible; },
    badge() {},
  };
  frames.push(f);
  return f;
}
export const allFrames = () => frames;
export const getFrame = (k) => frames.find((f) => f.key === k) ?? null;

// ---- avatar.js: the def-hydrated vocabulary, MUTABLE like the real one
export const EMOTE_ORDER = ['wave', 'cheer', 'dance', 'point', 'salute', 'clap'];
export const EMOTE_ICONS = {};

// ---- controller.js
export const myState = { emote: null, clip: null, posture: null, seat: null };
export const postureCalls = [];
export function setPosture(p) { postureCalls.push(p); }
export function sitHere() { postureCalls.push('sitHere'); }
export function standUp() { postureCalls.push('standUp'); }
export const getPosture = () => null;

// ---- mybody.js
export const played = [];
export const getMe = () => ({ playEmote: (n) => played.push(n) });

// ---- xrpanels.js
export const xrPanels = [];
export function registerXRPanel(p) { xrPanels.push(p); }
