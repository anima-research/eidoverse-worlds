// latestread — paced re-reads of the authority: at most one in flight per key, never more often than `gapMs`, and a
// read asked meanwhile replaces the one waiting (only the newest runs; it carries the newest state).
// Why: the Inspector and History re-read on every change, and fast editing tripped the server's rate limit.
//
//   const paced = latestRead(250);
//   paced(id, () => sendRequest('inspect', { id }).then(...));   // `run` must return a promise

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
