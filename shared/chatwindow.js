// shared/chatwindow.js — the recent-chat window a joiner is shown. Pure.
//   hear(st, line)    append {actor, text, ts, seq} to st.recentChat, count it, trim fairly
export const RECENT_CHAT = 40;

/** Make room in the recent-chat window WITHOUT letting one loud speaker erase
 *  everyone else.
 *
 *  A plain "keep the last N" is a lie about what a room sounded like: measured,
 *  a bot emitting 300 telemetry lines reduced the window to 40 messages
 *  spanning ZERO seconds, all its own, and the two people actually holding a
 *  conversation vanished from it completely. An arrival would have seen a
 *  machine talking to itself.
 *
 *  So the loudest voice loses its oldest line first, and nobody's LAST line is
 *  ever dropped while someone else still has several. Recency still wins
 *  within a speaker; fairness decides between them.
 *  @param {WorldState["recentChat"]} rc */
export function trimRecentChat(rc) {
  while (rc.length > RECENT_CHAT) {
    const counts = new Map();
    for (const m of rc) counts.set(m.actor, (counts.get(m.actor) ?? 0) + 1);
    let victim = -1;
    let worst = 1;
    for (let i = 0; i < rc.length; i++) {
      const n = counts.get(rc[i].actor);
      if (n > worst) { worst = n; victim = i; }      // oldest line of the loudest
    }
    rc.splice(victim >= 0 ? victim : 0, 1);          // everyone tied at 1: oldest goes
  }
}

/** One line heard: into the window (fairly trimmed) and counted. */
export function hear(st, { actor, text, ts, seq }) {
  (st.recentChat ??= []).push({ actor, text: String(text ?? ""), ts, seq });
  st.chatTotal = (st.chatTotal ?? 0) + 1;
  trimRecentChat(st.recentChat);
}
