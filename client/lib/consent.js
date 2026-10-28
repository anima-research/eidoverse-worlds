// My body's consent (R 10-28): two gates — Move me, Touch me — each on or off, and two lists of people — Allow (always
// yes) and Block (always no), whatever the gates say. The authority is the only place it's decided (shared/protocol/
// consent.js decide; A1: no client gate). This module remembers my choice (localStorage, so it survives the session and
// follows me between worlds) and hands it to consentsync, which sends it on every arrival and every change.
// A leaf with no lib imports. setPushable/setPosable keep main's /pushable and /posable meanings: the move and touch gates.
import { GATES, DEFAULT_GATES, CONSENT_SHAPE } from '../../shared/protocol/consent.js';
export { GATES };
/** what each gate covers, in plain words (Settings ▸ body shows them as the tooltips) */
export const GATE_WORDS = {
  move: { label: 'Move me', tip: 'Whether other people may move your body: shove or knock you over (a /boom blast too), drag you, carry you, or sit you down on something. On by default.' },
  touch: { label: 'Touch me', tip: 'Whether other people may put their hands on you (anywhere, intimate places included) or pose your body. Off by default.' },
};

// the keys before it, read by readStored and never written: main's two (ew-pushable, ew-posable), v4's one switch (ew-body-switch, to 10-28)
export const KEY = 'ew-body-consent';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const plainList = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([id, n]) => typeof id === 'string' && typeof n === 'string')) : {});

/** What is stored: {move, touch, allow: {id: name}, block: {id: name}}. A setting kept under an older key is carried into
 *  the gates silently (R 10-28 13:03: "we're keeping their gates"), and written under KEY on first read. Never broader than
 *  it was: v4's switch refuse → both off, ask → move on and touch off, accept → move on and touch as main's ew-posable
 *  stored it (else off); with no switch, main's ew-pushable '0' → move off and ew-posable '1' → touch on. */
export function readStored(get = lsGet) {
  let raw = null; try { raw = JSON.parse(get(KEY) ?? 'null'); } catch { /* unreadable: as never chosen */ }
  if (raw && raw.v === CONSENT_SHAPE) return { move: raw.move === true, touch: raw.touch === true, allow: plainList(raw.allow), block: plainList(raw.block) };
  const sw = get('ew-body-switch'), pushable = get('ew-pushable'), posable = get('ew-posable');
  const state = { move: DEFAULT_GATES.move, touch: DEFAULT_GATES.touch, allow: {}, block: {} };
  if (sw === 'refuse') { state.move = false; state.touch = false; }
  else if (sw === 'ask') { state.move = true; state.touch = false; }
  else if (sw === 'accept') { state.move = true; state.touch = posable === '1'; }
  else { state.move = pushable !== '0'; state.touch = posable === '1'; }
  return state;
}

let current = readStored();
const save = () => lsSet(KEY, JSON.stringify({ v: CONSENT_SHAPE, ...current }));
save();
const listeners = new Set();
const changed = () => { save(); for (const fn of listeners) fn(current); };

export const gate = (g) => current[g] === true;
export function setGate(g, on) { if (!GATES.includes(g) || current[g] === !!on) return false; current = { ...current, [g]: !!on }; changed(); return true; }
/** a person's list: 'allow' | 'block' | null (neither: the gates answer them) */
export const listOf = (id) => (Object.hasOwn(current.block, id) ? 'block' : Object.hasOwn(current.allow, id) ? 'allow' : null);
/** put a person on a list ('allow' | 'block') or take them off both (null). `name` is how the list shows them. */
export function setListed(id, list, name = id) {
  if (typeof id !== 'string' || !id || !['allow', 'block', null].includes(list)) return false;
  if (listOf(id) === list && (!list || current[list][id] === name)) return false;
  const allow = { ...current.allow }, block = { ...current.block }; delete allow[id]; delete block[id];
  if (list) (list === 'allow' ? allow : block)[id] = String(name);
  current = { ...current, allow, block }; changed(); return true;
}
/** a list as [{id, name}], for the panel */
export const listed = (list) => Object.entries(current[list] ?? {}).map(([id, name]) => ({ id, name }));
export function onConsentChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** what consentsync sends: the gates and the lists' identities */
export const bodyTable = () => ({ move: current.move, touch: current.touch, allow: Object.keys(current.allow), block: Object.keys(current.block) });

export const pushable = () => gate('move');
export const posable = () => gate('touch');
export const setPushable = (b) => setGate('move', b);
export const setPosable = (b) => setGate('touch', b);
