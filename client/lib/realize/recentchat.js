// recentchat — puts the join snapshot's `state.st.recentChat` on screen. Kept apart from social.js (which imports
// the engine via world.js) so the renderer-free client can reach it too. Current servers send it empty (speech is
// arrival-only); the loop stays for older servers.
import { state, onWorldChange } from '../state.js';
import { logChat } from '../ui/chat.js';

/** Put the pre-existing room context on screen. Safe to call more than once: the chat log dedupes by seq, and
 *  every entry here carries its real seq. */
export function replayRecentChat() {
  for (const m of state.st?.recentChat ?? []) {
    logChat(m.actor, m.text, '', { seq: m.seq, ts: m.ts });
  }
}

/** Subscribe the replay to hydration. Install before the socket is adopted: the snapshot can already be in the
 *  early socket's buffer, and a consumer registered after the drain never sees it. */
export function initRecentChat() {
  onWorldChange((ev) => { if (ev.type === 'hydrated') replayRecentChat(); });
}
