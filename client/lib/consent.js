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

// the keys before it, read by readStored and never written: main's two (ew-pushable, ew-posable), the body switch (ew-body-switch, to 10-28)
export const KEY = 'ew-body-consent';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const plainList = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([id, n]) => typeof id === 'string' && typeof n === 'string')) : {});

/** What is stored: {move?, touch?, allow: {id: name}, block: {id: name}, queue: [{op, id, name, at, world, acked}]}; a gate
 *  absent = never chosen (the world's default answers, F2b). allow/block are my lists as last seen (the authority's, which
 *  is the source: review full-260 L9); `queue` is my own changes not yet landed, drained as they land (consentsync). A block
 *  follows me into every world for BLOCK_FOLLOW_MS (narrower); an allow or an unlist lands only in the world it was made in
 *  (wider). A setting kept under an older key is carried into the gates silently (R 10-28 13:03: "we're keeping their gates"),
 *  and written under KEY on first read. Never broader than it was: the body switch's refuse or ask → both off (F3, R 10-28
 *  16:02), accept → move on and touch as main's ew-posable stored it (else off); with no switch, main's ew-pushable → move
 *  ('0' off) and ew-posable → touch ('1' on), each only if that key is present. A stored list from before the queue: its
 *  blocks follow as queued blocks, its unlists follow too but only take someone off allow (never wider), its allows stay where they landed. */
export const BLOCK_FOLLOW_MS = 30 * 86_400_000;
const OPS = ['allow', 'block', 'unlist'];
/** a change that follows me into every world until BLOCK_FOLLOW_MS: a block, or an unlist from before the queue (its world unknown: it only ever takes someone off allow; review delta-260 #2) */
const follows = (q) => q.op === 'block' || (q.op === 'unlist' && q.world === null);
const liveOp = (q, now) => q && OPS.includes(q.op) && typeof q.id === 'string' && Number.isFinite(q.at) && (!follows(q) || now - q.at < BLOCK_FOLLOW_MS);
export function readStored(get = lsGet, now = Date.now()) {
  let raw = null; try { raw = JSON.parse(get(KEY) ?? 'null'); } catch { /* unreadable: as never chosen */ }
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  if (raw && raw.v === CONSENT_SHAPE) {
    const allow = plainList(raw.allow), block = plainList(raw.block);
    const queue = Array.isArray(raw.queue) ? raw.queue.filter((q) => liveOp(q, now)).map((q) => ({ op: q.op, id: q.id, name: String(q.name ?? q.id), at: q.at, world: typeof q.world === 'string' ? q.world : null, acked: Array.isArray(q.acked) ? q.acked.filter((w) => typeof w === 'string') : [] }))
      : [...Object.entries(block).map(([id, name]) => ({ op: 'block', id, name, at: now, world: null, acked: [] })),
        ...(Array.isArray(raw.unlist) ? raw.unlist.filter((id) => typeof id === 'string') : []).map((id) => ({ op: 'unlist', id, name: id, at: now, world: null, acked: [] }))];
    return { move: bool(raw.move), touch: bool(raw.touch), allow, block, queue };
  }
  const sw = get('ew-body-switch'), pushable = get('ew-pushable'), posable = get('ew-posable');
  const state = { move: undefined, touch: undefined, allow: {}, block: {}, queue: [] };
  if (sw === 'refuse' || sw === 'ask') { state.move = false; state.touch = false; }
  else if (sw === 'accept') { state.move = true; state.touch = posable === '1'; }
  else { if (pushable !== null) state.move = pushable !== '0'; if (posable !== null) state.touch = posable === '1'; }
  return state;
}

let current = readStored();
// a guest's id is minted per connection, so their entries last for the visit: in memory only, never stored (review full-260 #2)
const guests = new Set();
const save = () => lsSet(KEY, JSON.stringify({ v: CONSENT_SHAPE, move: current.move, touch: current.touch,
  allow: Object.fromEntries(Object.entries(current.allow).filter(([id]) => !guests.has(id))), block: Object.fromEntries(Object.entries(current.block).filter(([id]) => !guests.has(id))),
  queue: current.queue.filter((q) => !guests.has(q.id)) }));
save();
const listeners = new Set();
const changed = () => { save(); for (const fn of listeners) fn(current); };
let world = '';
/** the world this page syncs with (its authority's lists are the ones shown and sent to) */
export function useWorld(name) { world = String(name ?? ''); }

/** a gate as it shows: what I chose, else the built-in default (the world's own default is the authority's to apply) */
export const gate = (g) => (current[g] ?? DEFAULT_GATES[g]) === true;
export function setGate(g, on) { if (!GATES.includes(g) || current[g] === !!on) return false; current = { ...current, [g]: !!on }; changed(); return true; }
// the lists this world's authority holds for me (consentsync's read; per world): the source, which my lists then show
let held = null;
const heldListeners = new Set();
const nameOf = (id) => current.allow[id] ?? current.block[id] ?? current.queue.find((q) => q.id === id)?.name ?? id;
export function noteHeld(t) { const next = { allow: Array.isArray(t?.allow) ? [...t.allow] : [], block: Array.isArray(t?.block) ? [...t.block] : [] };
  const same = JSON.stringify(next) === JSON.stringify(held); held = next;
  const allow = Object.fromEntries(next.allow.map((id) => [id, nameOf(id)])), block = Object.fromEntries(next.block.map((id) => [id, nameOf(id)]));
  if (JSON.stringify([allow, block]) !== JSON.stringify([current.allow, current.block])) { current = { ...current, allow, block }; save(); }
  if (!same) for (const fn of heldListeners) fn(); }
export function onHeldChange(fn) { heldListeners.add(fn); return () => heldListeners.delete(fn); }
/** my change still to land in this world, if any */
const pendingOf = (id) => current.queue.find((q) => q.id === id && !q.acked.includes(world) && (q.op === 'block' || q.world === world || q.world === null));
/** a person's list: 'allow' | 'block' | null (neither: the gates answer them); my change not yet landed here first, else the
 *  authority's (or, before its first read, my lists as last seen) */
export function listOf(id) {
  const p = pendingOf(id), l = held ?? { allow: Object.keys(current.allow), block: Object.keys(current.block) };
  if (p && !(p.op === 'unlist' && p.world === null)) return p.op === 'unlist' ? null : p.op;
  return l.block.includes(id) ? 'block' : l.allow.includes(id) && !p ? 'allow' : null;
}
/** put a person on a list ('allow' | 'block') or take them off both (null). `name` is how the list shows them; a `guest`'s
 *  entry is for this visit only (never stored). */
export function setListed(id, list, name = id, { guest = false } = {}) {
  if (typeof id !== 'string' || !id || !['allow', 'block', null].includes(list)) return false;
  if (listOf(id) === list && (!list || nameOf(id) === name)) return false;
  if (guest) guests.add(id);
  const allow = { ...current.allow }, block = { ...current.block }; delete allow[id]; delete block[id];
  if (list) (list === 'allow' ? allow : block)[id] = String(name);
  const queue = [...current.queue.filter((q) => q.id !== id), { op: list ?? 'unlist', id, name: String(name), at: Date.now(), world, acked: [] }];
  current = { ...current, allow, block, queue }; changed(); return true;
}
/** consentsync: my change for `id` (`op`) holds in this world now. An allow or unlist is drained; a block, or an old unlist
 *  ('unallow': off allow only), is marked landed here and keeps following until BLOCK_FOLLOW_MS. */
export function landed(op, id) {
  const now = Date.now(), un = op === 'unallow', is = (q) => (un ? q.op === 'unlist' && q.world === null : q.op === op);
  const queue = current.queue.flatMap((q) => (q.id !== id || !is(q) ? [q] : follows(q) ? [{ ...q, acked: [...new Set([...q.acked, world])] }] : [])).filter((q) => liveOp(q, now));
  const allow = { ...current.allow }, block = { ...current.block };
  if (un) { if (held) held = { ...held, allow: held.allow.filter((x) => x !== id) }; delete allow[id]; current = { ...current, allow, queue }; save(); return; }
  if (held) { held = { allow: held.allow.filter((x) => x !== id), block: held.block.filter((x) => x !== id) }; if (op !== 'unlist') held[op].push(id); }
  delete allow[id]; delete block[id]; if (op !== 'unlist') (op === 'allow' ? allow : block)[id] = nameOf(id);
  current = { ...current, allow, block, queue }; save();
}
/** drop an identity no one wears any more (the server's "gone"), from storage too, with nothing sent */
export function forget(id) {
  if (!(id in current.allow) && !(id in current.block) && !current.queue.some((q) => q.id === id)) return false;
  const allow = { ...current.allow }, block = { ...current.block }; delete allow[id]; delete block[id];
  if (held) held = { allow: held.allow.filter((x) => x !== id), block: held.block.filter((x) => x !== id) };
  current = { ...current, allow, block, queue: current.queue.filter((q) => q.id !== id) }; changed(); return true;
}
/** a list as [{id, name}] for the panel (a guest's marked visit: true) */
export const listed = (list) => [...new Set([...Object.keys(current.allow), ...Object.keys(current.block), ...(held?.allow ?? []), ...(held?.block ?? []), ...current.queue.map((q) => q.id)])]
  .filter((id) => listOf(id) === list).map((id) => ({ id, name: nameOf(id), ...(guests.has(id) ? { visit: true } : {}) }));
export function onConsentChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** what consentsync sends to this world: the gates I chose (undefined = never chosen) and my changes not yet landed here */
export const bodyTable = () => { const now = Date.now(), mine = (op, old = false) => current.queue.filter((q) => q.op === op && (op !== 'unlist' || (q.world === null) === old) && liveOp(q, now) && pendingOf(q.id) === q).map((q) => q.id);
  return { move: current.move, touch: current.touch, allow: mine('allow'), block: mine('block'), unlist: mine('unlist'), unallow: mine('unlist', true) }; };   // unallow: old unlists, off allow only

export const pushable = () => gate('move');
export const posable = () => gate('touch');
export const setPushable = (b) => setGate('move', b);
export const setPosable = (b) => setGate('touch', b);
