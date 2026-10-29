// My body's consent (consent.js: two gates and two lists), as the authority takes it: each sync reads what the authority
// holds for me (consent {}) and sends only what differs, in order on one socket — the gates I chose in one request, then
// one allow / block per person, and an unlist only for someone I took off a list here (mcpl replayConsent's model). The
// server checks it before it forwards anyone's knock-over, pose, grab or touch, so a
// table that never lands leaves me on the world's defaults while my switches say otherwise — and the server answers in my
// name. Only my own changes are sent (consent.js's queue), never my whole list over the world's (L9). The sync runs on every arrival (a world's presence plane is its own) and every change; a refusal is said once
// and the table is sent again on a timer and on the next arrival.
// A leaf like consent.js — everything it touches comes in, so tools/consent-switch-test.ts can drive it.
export const RETRY_MS = 5000;
export function makeConsentSync({ table, send, toast, on, later = (fn) => setTimeout(fn, RETRY_MS), enabled = () => true, held = () => {}, gone = () => {}, landed = () => {} }) {
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
    const want = table();
    const failed = (e) => ({ ok: false, refused: { reason: String(e?.message ?? e) } });
    const read = await send('consent', {}).then((r) => r, failed);
    const noteHeld = (t) => { try { held(t); } catch { /* the panel's, never the sync's */ } };   // reads, changes nothing: send only what differs
    const results = [];
    if (!read?.ok || !read.table) results.push(['your consent, read back', read?.ok ? { ok: false, refused: { reason: 'the authority sent no table' } } : read]);
    else {
      const held = read.table, gates = {}; noteHeld(held);   // the panel shows the authority's lists too
      for (const g of ['move', 'touch']) if (typeof want[g] === 'boolean' && held[g] !== want[g]) gates[g] = want[g];   // never chosen: the world's default stands (F2b)
      if (Object.keys(gates).length) results.push([Object.entries(gates).map(([g, v]) => `${g} ${v ? 'on' : 'off'}`).join(', '), await send('consent', gates).then((r) => r, failed)]);
      const has = (list, id) => Array.isArray(held[list]) && held[list].includes(id);
      // each of my changes not yet landed here, then marked landed (consent.js drains it: review full-260 L9)
      const mark = (op, id) => { try { landed(op, id); } catch { /* the store's, never the sync's */ } };
      for (const list of ['allow', 'block']) for (const id of want[list]) { if (has(list, id)) { mark(list, id); continue; }
        const r = await send('consent', { [list]: id }).then((r) => r, failed);
        if (r?.refused?.code === 'gone') gone(id); else { results.push([`${list} one person`, r]); if (r?.ok) mark(list, id); } }   // gone: no one wears that id now (a guest who left): pruned, not retried
      for (const id of want.unlist ?? []) { if (want.allow.includes(id) || want.block.includes(id)) continue;
        if (!has('allow', id) && !has('block', id)) { mark('unlist', id); continue; }   // only whom I unlisted: the authority's own entries stay (F2a)
        const r = await send('consent', { unlist: id }).then((r) => r, failed); results.push(['unlist one person', r]); if (r?.ok) mark('unlist', id); }
      // an unlist from before the queue (its world unknown): sent only to take someone off allow here, never to lift a block (consent.js follows)
      for (const id of want.unallow ?? []) { if (want.allow.includes(id) || want.block.includes(id)) continue;
        if (!has('allow', id)) { mark('unallow', id); continue; }
        const r = await send('consent', { unlist: id }).then((r) => r, failed); results.push(['unlist one person', r]); if (r?.ok) mark('unallow', id); }
    }
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
