// state — the world as data: the VIEW of this client's own fold of the world (shared/protocol/view.js viewState over
// shared/protocol/replica.js), plus the chat window.
//
// This module holds that view and nothing else: no scene, no DOM, no THREE, no assets. Realizers project it into the
// scene through the scheduler; this file never does.
//
// net.js folds the door's stream (shared/protocol/replica.js) and hands this module each new view (applyView); this module
// says what changed, in v4 terms (shared/protocol/viewdiff.js). Events are invalidation signals, not data carriers:
// subscribers are told WHAT changed and read the world from state.st:
//   {type:'hydrated'} · {type:'reset'}
//   {type:'change', id, what: 'born'|'gone'|'pose'|'parent'|'comp', comp?}
//   {type:'world', key, ids?, ts?}     a world key changed (sky, terrain, roles…; ids = which entries of a map)
// What I may do here (role, gen, fly) is the server's answer (`your-rights`, re-sent whenever a role changes), never
// recomputed here.

import { diffView } from '../../shared/protocol/viewdiff.js';
import { emptyView } from '../../shared/protocol/view.js';

export const state = {
  /** the view (view.js viewState): {entities, sky, terrain, grass, assets, roles, bans, recentChat, chatTotal} */
  st: emptyView(),
  /** Highest chat seq covered (seq × 1000); -1 before hydration. */
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

/** Adopt a join's view wholesale (the first view of this client's fold of the door's cut). Milliseconds, sync. */
export function hydrate(view, throughSeq = -1) {
  state.st = { ...emptyView(), ...structuredClone(view ?? {}) };
  state.lastSeq = throughSeq;
  state.hydrated = true;
  emit({ type: 'hydrated' });
}

/** Adopt the next view of this client's own fold (view.js viewState) and say what changed. */
export function applyView(next, { ts } = {}) {
  const d = diffView(state.st, next);
  state.st = next;
  // parents before children, so a thing born in the same batch as what it hangs from finds it there
  const depth = (id) => { let n = 0; for (let p = next.entities[id]?.parent?.to; p && n < 64; p = next.entities[p]?.parent?.to) n++; return n; };
  // (and every 'gone' first: a thing replaced by another model is 'gone' then 'born' under the same id)
  d.things.sort((a, b) => (b.what === 'gone') - (a.what === 'gone') || (a.what === 'born' && b.what === 'born' ? depth(a.id) - depth(b.id) : 0));
  for (const c of d.things) emit({ type: 'change', ...c });
  for (const key of d.world) emit({ type: 'world', key, ...(d.ids?.[key] ? { ids: d.ids[key] } : {}), ts: ts ?? Date.now() });
  return d;
}

/** World switch / fork / leave: back to nothing. */
export function reset() {
  state.st = emptyView();
  state.lastSeq = -1;
  state.hydrated = false;
  emit({ type: 'reset' });
}
