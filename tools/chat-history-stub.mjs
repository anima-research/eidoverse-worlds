// chat-scrollback-test substitutes this for net.js: requestHistory pages a
// fake world log with the server's readHistory semantics (server/world.ts) —
// the NEWEST `limit` matching entries strictly between after and before,
// handed back oldest-first.
// holdNext(skip) keeps an answer in flight until release(), so a scenario can
// land a live line while a page is on its way; failNext(skip) makes a request
// reject, as net.js's does when no socket is joined or no answer comes. Each
// takes the request `skip` requests from now (0: the next one).
let log = [];
export const requests = [];
let holdAt = -1, held = null, failAt = -1;
export function setLog(entries) { log = entries; requests.length = 0; holdAt = -1; failAt = -1; }
export function holdNext(skip = 0) { holdAt = requests.length + skip; }
export function failNext(skip = 0) { failAt = requests.length + skip; }
export function release() { const h = held; held = null; h?.(); }
export const inFlight = () => held !== null;
export async function requestHistory({ before = Infinity, after = -Infinity, limit = 50, verbs = null } = {}) {
  requests.push({ before, after, limit });
  const n = requests.length - 1;
  if (n === failAt) { failAt = -1; throw new Error('history: no answer (stub)'); }
  const out = [];
  for (let i = log.length - 1; i >= 0 && out.length < limit; i--) {
    const e = log[i];
    if (e.seq < before && e.seq > after && (!verbs || verbs.includes(e.verb))) out.push(e);
  }
  out.reverse();
  const oldest = out.length ? out[0].seq : null;
  if (n === holdAt) { holdAt = -1; await new Promise((resolve) => { held = resolve; }); }
  return { entries: out, oldestSeq: oldest, hasMore: oldest !== null && oldest > 0 };
}
