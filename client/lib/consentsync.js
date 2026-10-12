// My two switches, as the authority's consent table for my body (consent.js bodyTable): the server checks it before it
// forwards anyone's knock-over, pose or grab, so a table that never lands leaves me on Normal (strangers: nobody) while
// my switch says everyone — and the server refuses in my name. The sync is sent on every arrival (a world's presence
// plane is its own) and every change; a refusal is said once and the table is sent again on a timer and on the next
// arrival. The last word is still my client's: it re-checks the switch when a puppet or shove arrives (localbody.js).
// A leaf like consent.js — everything it touches comes in, so tools/consent-switch-test.ts can drive it.
export const RETRY_MS = 5000;
export function makeConsentSync({ table, send, toast, on, later = (fn) => setTimeout(fn, RETRY_MS), enabled = () => true }) {
  let failing = false, retryArmed = false;
  async function sync() {
    if (!enabled()) return;
    const results = await Promise.all(table().map(([cls, mode]) => send('consent', { set: { class: cls, tier: 'strangers', mode } }).then((r) => [cls, mode, r], (e) => [cls, mode, { ok: false, refused: { reason: String(e?.message ?? e) } }])));
    const bad = results.find(([, , r]) => !r?.ok);
    if (!bad) { failing = false; return; }
    const [cls, mode, r] = bad;
    if (!failing) toast(`your body's consent (${cls}: ${mode}) didn't reach the world — ${r?.refused?.reason ?? 'no reply'}. Sending it again shortly, and on the next arrival`, 'warn', 8000);
    failing = true;
    if (!retryArmed) { retryArmed = true; later(() => { retryArmed = false; if (failing) sync(); }); }
  }
  on('hydrated', sync);
  return { sync, failing: () => failing };
}
