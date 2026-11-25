// social — roles and the arrival chat window as projections of state. The window renders once from state at
// hydration; every live say is livechat.js's business. Window lines keep their real seq: the scrollback cursor
// derives from it (paging back must not re-fetch what is already on screen).

import { state, onWorldChange } from '../state.js';
import { applyGrantState } from '../world.js';
import { logChat } from '../ui/chat.js';
import { replayRecentChat } from './recentchat.js';   // shared with the renderer-free client

function reconcileSocial() {
  const st = state.st;
  for (const [id, rec] of Object.entries(st.roles ?? {})) applyGrantState(id, rec);
  replayRecentChat();
}

function onWorld({ key, ids }) {
  const st = state.st;
  if (key === 'roles') for (const id of ids ?? Object.keys(st.roles ?? {})) applyGrantState(id, st.roles?.[id] ?? null);
}



export function initSocialRealizer() {
  onWorldChange((ev) => {
    if (ev.type === 'hydrated') reconcileSocial();
    else if (ev.type === 'world') onWorld(ev);
  });
  return true;
}
