// latestread — a panel's re-read of the authority, paced: at most one read in flight per key, the newest wish re-asked once
// the current one answers, and never more often than `gapMs`.
//
// Why: the Inspector and the History each re-read on every change to the thing they show. Editing fast (a drag, a burst of
// sets, an undo after a move) sent one read per change, and the connection crossed the server's 60-messages-a-second cap,
// so the person's own next request (an undo, a reshuffle) was refused with `rate` (client-check K7, GR1; 10-22). The lock
// padlock had been fixed for the same thing alone (10-20); this is the one rule for all of them.
//
//   const paced = latestRead(250);
//   paced(id, () => sendRequest('inspect', { id }).then(...));   // returns nothing; `run` must return a promise
//
// A read asked while one is in flight, or inside the gap, replaces any read already waiting: only the newest runs. Nothing
// is dropped that matters: the newest wish carries the newest state.

/** @param {number} gapMs  least time between two reads' starts, per key */
export function latestRead(gapMs = 250, now = () => performance.now(), later = (f, ms) => setTimeout(f, ms)) {
  const keys = new Map();   // key -> { busy, next, last, timer }
  const start = (s, run) => {
    s.busy = true; s.last = now();
    let p; try { p = Promise.resolve(run()); } catch (e) { p = Promise.reject(e); }
    p.catch(() => {}).finally(() => { s.busy = false; if (s.next) ask(s, s.next); });
  };
  const ask = (s, run) => {
    s.next = null;
    if (s.busy || s.timer) { s.next = run; return; }
    const wait = s.last + gapMs - now();
    if (wait > 0) { s.next = run; s.timer = later(() => { s.timer = null; const r = s.next; if (r) { s.next = null; start(s, r); } }, wait); return; }
    start(s, run);
  };
  return (key, run) => { let s = keys.get(key); if (!s) keys.set(key, (s = { busy: false, next: null, last: -Infinity, timer: null })); ask(s, run); };
}
