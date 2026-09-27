// Replaying the room you just walked into.
//
// The join snapshot carries `state.st.recentChat` - what was said before you arrived -
// and someone has to put it on screen. In the full client that is social.js, alongside
// applying grants and behaviors. But social.js imports world.js for those, and world.js
// is the engine (core, materials, colliders, terrain), so a renderer-free client could
// not reach the one loop it actually needed and arrived into a room with no history
// (#188 round two). This is that loop, and social.js now calls it too - one
// implementation, reachable from both.
import { state, onWorldChange } from '../state.js';
import { logChat } from '../chat.js';

/** Put the pre-existing room context on screen. Safe to call more than once only if the
 *  chat log dedupes by seq - which it does; every entry here carries its real sequence
 *  identity rather than being re-stamped as new. */
export function replayRecentChat() {
  for (const m of state.st?.recentChat ?? []) {
    logChat(m.actor, m.text, '', { seq: m.seq, ts: m.ts });
  }
}

/** Subscribe the replay to hydration. MUST be installed before the socket is adopted:
 *  the snapshot can be in the early socket's buffer already, and a consumer registered
 *  after the drain is a consumer that never sees it. */
export function initRecentChat() {
  onWorldChange((ev) => { if (ev.type === 'hydrated') replayRecentChat(); });
}
