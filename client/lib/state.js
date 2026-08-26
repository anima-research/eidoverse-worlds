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
// Events are invalidation signals, not data carriers: subscribers get the
// entry that changed the world and read the world from state.st. The
// vocabulary starts minimal (hydrated | reset | entry); per-facet interest
// filtering arrives with the first realizer, not before.

import { foldEntry, emptyState } from '../../shared/fold.js';
import { emptySim, simEntry } from '../../shared/sim.js';

export const state = {
  /** @type {import('../../shared/fold.js').WorldState} */
  st: emptyState(),
  /** The sim fold beside the instant one (dialect 3, PROTOCOL_v2): folded
   *  through the same entries in the same normative order; adopted from
   *  the join snapshot's cut (a joiner cannot recompute flights whose
   *  intents were folded out of the tail). simworld.js advances and
   *  applies it. */
  sim: emptySim(),
  /** Highest folded seq; -1 before hydration. Synthetic pre-hydration
   *  state (the snapshot) is already folded into what the server sent. */
  lastSeq: -1,
  hydrated: false,
};

const subs = new Set();

/** Subscribe to world changes. Returns unsubscribe. Events:
 *  {type:'hydrated'} · {type:'reset'} · {type:'entry', entry}. */
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
export function hydrate(snapshotState, tail = [], throughSeq = -1, sim = null) {
  // Defensive merge: snapshots from older servers may lack newer maps
  // (bans, mounts, behaviors are optional in the shape already).
  state.st = { ...emptyState(), ...structuredClone(snapshotState ?? {}) };
  // the sequencer's sim cut, adopted wholesale — advancement is schedule-
  // independent (PROTOCOL_v2), so resuming from it is exact
  state.sim = sim?.epoch ? structuredClone(sim) : emptySim();
  state.lastSeq = throughSeq;
  for (const e of tail) {
    if (e.seq <= state.lastSeq) continue;   // the documented overlap
    foldEntry(state.st, e);
    simEntry(state.sim, e, state.st);
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
  foldEntry(state.st, entry);
  simEntry(state.sim, entry, state.st);   // normative order: instant fold first
  state.lastSeq = entry.seq;
  emit({ type: 'entry', entry });
}

/** World switch / fork / leave: back to nothing. */
export function reset() {
  state.st = emptyState();
  state.sim = emptySim();
  state.lastSeq = -1;
  state.hydrated = false;
  emit({ type: 'reset' });
}
