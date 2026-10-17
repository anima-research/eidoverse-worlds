// consentinbox.js — the asks waiting for ME, and what the authority told me about my body (PROTOCOL L6; R 10-14: wire `ask`).
//
// The authority files an ask when someone's act on my body meets an `ask` cell (shared/protocol/authority.js bodyGate:
// `body {to, kind}` / `reach`), gives it 20 s, and pushes it to my socket as {type: "body-inbox", messages} (server/
// worldlog.ts forwardInbox). Until 10-14 no client file read that message: a person who chose `ask` was silently in
// `deny`. This module holds the asks (keyed by the authority's ask id), answers one with `consent {answer, yes}` through
// whatever `send` it is handed, and lets an unanswered ask go at its expiry WITHOUT sending — the authority already took
// silence as no (expireAsks) and told the asker. Replies to MY asks, acts delivered to me and revocations ride the same
// message; they are kept in a short ring for whoever wants to show them.
// A leaf like consent.js: nothing from lib comes in, so tools/consent-switch-test.ts can drive it with its own clock.
import { KIND_CLASS, ASK_MS } from '../../shared/protocol/consent.js';

const RING = 50;
export function makeConsentInbox({ now = () => Date.now(), onChange = () => {} } = {}) {
  const pending = new Map();   // ask id → {id, from, kind, cls, summary, why, expires, until}
  const ring = [];
  const changed = (ev) => { try { onChange(ev); } catch { /* a listener's trouble is its own */ } };
  /** The messages of one body-inbox push. */
  function take(messages) {
    if (!Array.isArray(messages)) return;
    const added = [];
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      if (m.type === 'body-ask') {
        const a = m.ask; if (!a || typeof a.id !== 'string' || typeof a.from !== 'string') continue;
        if (pending.has(a.id)) continue;
        const cls = KIND_CLASS[a.kind] ?? (typeof a.kind === 'string' ? a.kind : null); if (!cls) continue;
        // the authority's `expires` is on ITS clock; locally the ask lives ASK_MS from when it reached me (a late
        // message overshoots by its lateness, never the other way: a row marked for an ask that is already gone is
        // the worse error, and the authority refuses the stale answer with not-found anyway)
        const k = { id: a.id, from: a.from, kind: a.kind, cls, summary: typeof a.summary === 'string' ? a.summary : `${a.from} asks to ${a.kind}`, why: typeof a.why === 'string' ? a.why : null, expires: a.expires, until: now() + ASK_MS };
        pending.set(a.id, k); added.push(k);
      } else if (m.type === 'body-reply' || m.type === 'body' || m.type === 'body-revoked') {
        ring.push({ ...m, ts: now() }); if (ring.length > RING) ring.shift();
      }
    }
    if (added.length) changed({ added });
  }
  /** Drop what has expired; returns the ids that went. */
  function sweep() {
    const t = now(), removed = [];
    for (const [id, k] of pending) if (k.until <= t) { pending.delete(id); removed.push(id); }
    if (removed.length) changed({ removed });
    return removed;
  }
  const asks = () => { sweep(); return [...pending.values()]; };
  const askFrom = (actorId) => asks().find((k) => k.from === actorId) ?? null;
  /** Answer an ask: consent {answer: <id>, yes}. Returns the authority's reply, or null when there is no such ask here. */
  async function answer(id, yes, send) {
    const k = pending.get(id); if (!k) return null;
    pending.delete(id); changed({ removed: [id], answered: { ...k, yes: !!yes } });
    return send('consent', { answer: id, yes: !!yes });
  }
  return { take, sweep, asks, askFrom, answer, ring: () => ring.slice() };
}
