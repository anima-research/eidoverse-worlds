// chat-scrollback-test substitutes this for net.js: requestHistory pages a
// fake world log with the server's readHistory semantics (server/world.ts) —
// the NEWEST `limit` matching entries strictly between after and before,
// handed back oldest-first.
// holdNext() keeps the next answer in flight until release(), so a scenario
// can land a live line while a page is on its way.
let log = [];
export const requests = [];
let holding = false, held = null;
export function setLog(entries) { log = entries; requests.length = 0; }
export function holdNext() { holding = true; }
export function release() { const h = held; held = null; h?.(); }
export const inFlight = () => held !== null;
export async function requestHistory({ before = Infinity, after = -Infinity, limit = 50, verbs = null } = {}) {
  requests.push({ before, after, limit });
  const out = [];
  for (let i = log.length - 1; i >= 0 && out.length < limit; i--) {
    const e = log[i];
    if (e.seq < before && e.seq > after && (!verbs || verbs.includes(e.verb))) out.push(e);
  }
  out.reverse();
  const oldest = out.length ? out[0].seq : null;
  if (holding) { holding = false; await new Promise((resolve) => { held = resolve; }); }
  return { entries: out, oldestSeq: oldest, hasMore: oldest !== null && oldest > 0 };
}
