// My body's switch (recut A2; it was the whole table), as the authority takes it (consent.js bodyTable: one `set`
// per cell, and no preset, which would empty the server's cells first; each sync reads what the authority holds and
// sends only the cells that differ, in order on one socket): the
// server checks it before it forwards anyone's knock-over, pose, grab or touch, so a table that never lands leaves me on
// Normal (everyone: deny) while my switch says allow — and the server refuses in my name. The sync is sent on
// every arrival (a world's presence plane is its own) and every change; a refusal is said once and the table is sent
// again on a timer and on the next arrival. The last word is still my client's: it re-checks the switch when a puppet or shove arrives (localbody.js).
// A leaf like consent.js — everything it touches comes in, so tools/consent-switch-test.ts can drive it.
export const RETRY_MS = 5000;
export function makeConsentSync({ table, send, toast, on, later = (fn) => setTimeout(fn, RETRY_MS), enabled = () => true }) {
  let failing = false, retryArmed = false;
  // ONE sync in flight: changes made while it runs collapse into a single follow-up that reads the latest table, so a
  // burst of changes stays under the server's per-connection message cap (10-19), which would refuse some sets.
  let running = null, again = false;
  function sync() {
    if (running) { again = true; return running; }
    running = (async () => { try { do { again = false; await syncOnce(); } while (again); } finally { running = null; } })();
    return running;
  }
  async function syncOnce() {
    if (!enabled()) return;
    const want = table().switch;
    const failed = (e) => ({ ok: false, refused: { reason: String(e?.message ?? e) } });
    const read = await send('consent', {}).then((r) => r, failed);   // reads, changes nothing: send only if it differs
    let results;
    if (!read?.ok || !read.table) results = [['your switch, read back', read?.ok ? { ok: false, refused: { reason: 'the authority sent no table' } } : read]];
    else results = read.table.switch === want ? [] : [[`switch: ${want}`, await send('consent', { switch: want }).then((r) => r, failed)]];
    const bad = results.find(([, r]) => !r?.ok);
    if (!bad) { failing = false; return; }
    const [what, r] = bad;
    if (!failing) toast(`your body's consent (${what}) didn't reach the world — ${r?.refused?.reason ?? 'no reply'}. Sending it again shortly, and on the next arrival`, 'warn', 8000);
    failing = true;
    if (!retryArmed) { retryArmed = true; later(() => { retryArmed = false; if (failing) sync(); }); }
  }
  on('hydrated', sync);
  return { sync, failing: () => failing };
}
