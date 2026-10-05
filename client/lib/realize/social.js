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
import { replayRecentChat } from './recentchat.js';   // shared with the renderer-free client

function reconcileSocial() {
  const st = state.st;
  for (const [id, rec] of Object.entries(st.roles ?? {})) applyGrantState(id, rec);
  for (const [id, rec] of Object.entries(st.behaviors ?? {})) applyBehaviorState(id, rec, false);
  replayRecentChat();
}

function onWorld({ key, ids }) {
  const st = state.st;
  if (key === 'roles') for (const id of ids ?? Object.keys(st.roles ?? {})) applyGrantState(id, st.roles?.[id] ?? null);
  else if (key === 'behaviors') for (const id of ids ?? Object.keys(st.behaviors ?? {})) applyBehaviorState(id, st.behaviors?.[id] ?? null, true);
}



export function initSocialRealizer() {
  onWorldChange((ev) => {
    if (ev.type === 'hydrated') reconcileSocial();
    else if (ev.type === 'world') onWorld(ev);
  });
  return true;
}
