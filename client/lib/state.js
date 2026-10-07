// state — the world as data. The client half of shared/fold.js.
//
// This module holds the folded WorldState and nothing else: no scene, no
// DOM, no THREE, no assets (the _field.js discipline — headless-tested in
// tools/state-test.ts). Realizers (TEL0S_NOTES §11.4) project this state
// into the scene through the scheduler; this file never does.
//
// Two invariants carry the whole design (§11.2):
//
// - FOLDING IS SYNCHRONOUS, IN SEQ ORDER. The net layer feeds entries one
//   at a time; a fold takes microseconds and never awaits. Only
//   *realization* is async — and it reads state that is always consistent.
//   (The old path's async applyEntry interleaving — two entries in flight,
//   ordering reconstructed downstream via pendingOps — cannot happen here.)
// - state.st IS A PURE FUNCTION OF (snapshot, entries). Same contract as
//   the sequencer's fold, because it is the sequencer's fold, imported.
//
// Events are invalidation signals, not data carriers: subscribers are told
// WHAT changed and read the world from state.st (slice 3c: said in v4 terms,
// shared/v4/viewdiff.js, never as v1 verbs):
//   {type:'hydrated'} · {type:'reset'}
//   {type:'change', id, what: 'born'|'gone'|'pose'|'parent'|'comp', comp?}
//   {type:'world', key, ids?, ts?}     a world key changed (sky, terrain, roles…; ids = which entries of a map)
// A v4 world hands this module each new view of its own v4 fold (applyView);
// a v1 world still folds its v1 entries here (foldLive), and says the same.

import { foldEntry, emptyState } from '../../shared/fold.js';
import { rightsIn } from '../../shared/rightsfold.js';
import { CONFIG, bus } from './base.js';
import { diffView, diffThing } from '../../shared/v4/viewdiff.js';

export const state = {
  /** @type {import('../../shared/fold.js').WorldState} */
  st: emptyState(),
  // (the v1 sim fold that lived here is gone: a v4 world's physics is the v4 client's own sim layer, beside its fold —
  //  shared/v4/client.js, drawn by v4phys.js)
  /** Highest folded seq; -1 before hydration. Synthetic pre-hydration
   *  state (the snapshot) is already folded into what the server sent. */
  lastSeq: -1,
  hydrated: false,
};

const subs = new Set();

/** Subscribe to world changes (the events above). Returns unsubscribe. */
export function onWorldChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

function emit(ev) {
  for (const fn of [...subs]) {
    // A subscriber must not be able to break the fold path — same doctrine
    // as the sequencer's house rule 3, one layer down.
    try { fn(ev); } catch (err) { console.error('[state] subscriber failed:', err); }
  }
}

/** Adopt a join snapshot wholesale (it IS WorldState-shaped), then fold any
 *  tail entries past `throughSeq`. Milliseconds, sync.
 *
 *  Two server contracts, one call:
 *  - TODAY's sequencer folds every append live, so the state it sends
 *    already CONTAINS its tail's effects (the tail rides along for the
 *    documented chat overlap). Callers pass tail=[] and throughSeq = the
 *    highest seq the state reflects — nothing folds twice.
 *  - The §4 cutover contract (snapshot at a boundary + catch-up tail)
 *    passes the tail and the boundary; entries at or below it are the
 *    overlap and are skipped.
 *  The clone makes the shadow OWN its state: live folds here must never
 *  mutate objects the legacy path is still reading out of the join msg. */
export function hydrate(snapshotState, tail = [], throughSeq = -1) {
  // Defensive merge: snapshots from older servers may lack newer maps
  // (bans, mounts, behaviors are optional in the shape already).
  state.st = { ...emptyState(), ...structuredClone(snapshotState ?? {}) };
  state.lastSeq = throughSeq;
  for (const e of tail) {
    if (e.seq <= state.lastSeq) continue;   // the documented overlap
    foldEntry(state.st, e);
    state.lastSeq = e.seq;
  }
  state.hydrated = true;
  emit({ type: 'hydrated' });
}

/** Fold one live entry. Sync; seq-guarded (a duplicate or regression is
 *  dropped with a warning — folding is total, never throwing). */
export function foldLive(entry) {
  if (!entry || typeof entry.seq !== 'number') return;
  if (entry.seq <= state.lastSeq) {
    // A reconnect race or a re-delivered backlog line. Dropping is correct:
    // the entry is already IN the folded state.
    return;
  }
  if (state.lastSeq >= 0 && entry.seq !== state.lastSeq + 1) {
    // A gap means missed entries — fold what we have (total folding), but
    // say so loudly: parity with the server is now suspect until rejoin.
    console.warn(`[state] seq gap: ${state.lastSeq} → ${entry.seq}`);
  }
  const watch = beforeOf(entry);
  foldEntry(state.st, entry);
  state.lastSeq = entry.seq;
  // LIVE RIGHTS, RECOMPUTED FROM THE FOLD -- not merged by hand.
  //
  // net.myRights only ever changed at join, so a `/grant … -fly` mid-session
  // was invisible to the client's own capability gate until reload. The first
  // repair merged grant entries by hand in world.js applyGrantState() -- which
  // turned out to be exported and CALLED BY NOTHING, so it was dead code that
  // read like a fix. mica found the same hole on the agent side in production.
  //
  // Recomputing beats merging: `rightsIn` is the identical function the
  // sequencer answers with, so the client cannot invent a precedence rule the
  // server does not have (a wildcard overriding a name-keyed grant, say --
  // which is exactly the mistake I made when merging by hand).
  //
  // WORLD_ADMIN is deliberately NOT reproducible here: it is an environment
  // fact the server folds in before sending yourRights, so an admin's grant is
  // preserved rather than recomputed away.
  if (watch) {
    const things = [];
    for (const [id, was] of watch.things) diffThing(id, was, state.st.entities[id], things);
    const d = diffView({ ...watch.world, entities: {} }, { ...pick(state.st, Object.keys(watch.world)), entities: {} });
    announce({ things, world: d.world, ids: d.ids }, entry.ts);
  }
}

// ---- v1 worlds: what one v1 entry can touch, copied before it folds (the fold mutates in place) ----
const THING_VERBS = new Set(['spawn', 'place', 'remove', 'light', 'comp', 'motion', 'mount', 'dismount']);
const WORLD_OF = { terrain: ['terrain'], grass: ['grass'], sky: ['sky'], weather: ['sky'], asset: ['assets'], grant: ['roles'],
  blueprint: ['blueprints'], ban: ['bans'], unban: ['bans'], behavior: ['behaviors'], mount: ['mounts'], dismount: ['mounts'], remove: ['mounts'] };
const pick = (st, keys) => Object.fromEntries(keys.map((k) => [k, st[k]]));
function beforeOf(entry) {
  const verb = entry?.verb, id = entry?.args?.id;
  const keys = WORLD_OF[verb] ?? [];
  const ids = THING_VERBS.has(verb) && typeof id === 'string'
    ? [id, ...Object.entries(state.st.entities).filter(([, e]) => e?.parent?.to === id).map(([k]) => k)] : [];
  if (!keys.length && !ids.length) return null;
  return { things: ids.map((x) => [x, structuredClone(state.st.entities[x])]), world: structuredClone(pick(state.st, keys)) };
}

/** A v4 world: adopt the next view of this client's own v4 fold (record.js viewState) and say what changed. */
export function applyView(next, { ts } = {}) {
  const d = diffView(state.st, next);
  state.st = next;
  // parents before children, so a thing born in the same batch as what it hangs from finds it there
  const depth = (id) => { let n = 0; for (let p = next.entities[id]?.parent?.to; p && n < 64; p = next.entities[p]?.parent?.to) n++; return n; };
  // (and every 'gone' first: a thing replaced by another model is 'gone' then 'born' under the same id)
  d.things.sort((a, b) => (b.what === 'gone') - (a.what === 'gone') || (a.what === 'born' && b.what === 'born' ? depth(a.id) - depth(b.id) : 0));
  announce(d, ts ?? Date.now());
  return d;
}

function announce(d, ts) {
  if (d.world.includes('roles')) refreshMyRights();
  for (const c of d.things) emit({ type: 'change', ...c });
  for (const key of d.world) emit({ type: 'world', key, ...(d.ids?.[key] ? { ids: d.ids[key] } : {}), ts });
}

/** Recompute what I may do here from the folded roles.
 *
 *  Only ever WIDENS or NARROWS what the server already told me: an admin
 *  override (WORLD_ADMIN) arrives in the snapshot as fly:true with no matching
 *  role record, so a recompute would strip it. Kept by taking the max of the
 *  two -- the snapshot is the authority and the fold is the live delta. */
// net.js imports THIS module (shadow fold), so the arrow cannot point back --
// the same reason net keeps the controller at arm's length. main.js wires it.
let rightsSink = null;
export function setRightsSink(fn) { rightsSink = typeof fn === 'function' ? fn : null; }

function refreshMyRights() {
  if (!rightsSink) return;
  const cur = rightsSink();
  if (!cur) return;                          // not joined; nothing to refresh
  // a v4 world's rights are the DOOR's (switches, by identity) and the server pushes them on every change (research
  // roles S4): recomputing v1's rule here, by display name, overwrote them (a moderator read as builder for a moment)
  if (Array.isArray(cur.switches)) return;
  const live = rightsIn(state.st, CONFIG.name);
  // WORLD_ADMIN is an environment fact the fold cannot see, so a recompute
  // would strip an admin's flight. The snapshot said so; keep it.
  const admin = cur.admin === true;
  const next = { ...cur, role: live.role, gen: live.gen,
                 fly: admin ? cur.fly : live.fly };
  if (next.role === cur.role && next.gen === cur.gen && next.fly === cur.fly) return;
  rightsSink(next);
  bus.emit('your-rights', next);
}

/** World switch / fork / leave: back to nothing. */
export function reset() {
  state.st = emptyState();
  state.lastSeq = -1;
  state.hydrated = false;
  emit({ type: 'reset' });
}
