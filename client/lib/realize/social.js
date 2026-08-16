// social — roles, behavior roster, and the arrival chat window as
// projections of state (TEL0S_NOTES §11.4, slice 3c).
//
// The chat window gets simpler than the legacy path, not just equivalent:
// legacy re-synthesized st.recentChat into say entries and then had to
// SKIP the ones the tail would replay (the state/tail overlap dance).
// Here the window renders once from state at hydration, and every live
// say is the causes dispatcher's business — no overlap exists to manage.
// Window lines keep their REAL seq: the scrollback cursor derives from it
// (paging back must not re-fetch what is already on screen).

import { state, onWorldChange } from '../state.js';
import { applyGrantState, applyBehaviorState } from '../world.js';
import { logChat } from '../chat.js';

function reconcileSocial() {
  const st = state.st;
  for (const [id, rec] of Object.entries(st.roles ?? {})) applyGrantState(id, rec);
  for (const [id, rec] of Object.entries(st.behaviors ?? {})) applyBehaviorState(id, rec, false);
  for (const m of st.recentChat ?? []) {
    logChat(m.actor, m.text, '', { seq: m.seq, ts: m.ts });
  }
}

function onEntry(entry) {
  const { verb, args = {} } = entry;
  if (verb === 'grant' && args.id) {
    applyGrantState(args.id, state.st.roles?.[args.id] ?? args);
  } else if (verb === 'behavior' && args.id) {
    applyBehaviorState(args.id, state.st.behaviors?.[args.id] ?? null, true);
  }
}

const VERBS = new Set(['grant', 'behavior']);

export function initSocialRealizer() {
  onWorldChange((ev) => {
    if (ev.type === 'hydrated') reconcileSocial();
    else if (ev.type === 'entry' && VERBS.has(ev.entry.verb)) onEntry(ev.entry);
  });
  return true;
}
