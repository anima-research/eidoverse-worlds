// shared/chatwindow.js — the recent-chat window a joiner is shown. Pure.
//   hear(st, line)    append {actor, text, ts, seq} to st.recentChat, count it, trim fairly
export const RECENT_CHAT = 40;

/** Make room in the recent-chat window WITHOUT letting one loud speaker erase
 *  everyone else: the loudest voice loses its oldest line first, and nobody's
 *  LAST line is dropped while someone else still has several. Recency wins
 *  within a speaker; fairness decides between them.
 *  @param {{ actor: string, text: string, ts: number, seq: number }[]} rc */
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
