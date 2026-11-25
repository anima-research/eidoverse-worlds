// debuglog — the "name which guard refused" channel, shared.
//
// A predicate that can decline for five reasons and returns a bare false costs a debugging round per guess. Instead a
// subsystem narrates its decisions with `why(topic, message)`, and anyone — /audio, the console, a probe — reads the
// recent history back per topic.
//
// Deliberately dependency-free and try/catch-free: nothing here can throw (strings, arrays, Date.now), so call sites
// stay one line.

const RING = 5;
const topics = new Map();            // topic → [{ t, msg }] newest-last

/** Narrate a decision. Cheap enough to leave in shipped code: one array push
 *  when nobody is looking. */
export function why(topic, msg) {
  let ring = topics.get(topic);
  if (!ring) { ring = []; topics.set(topic, ring); }
  ring.push({ t: Date.now(), msg: String(msg) });
  if (ring.length > RING) ring.shift();
}

/** The most recent narration for a topic, or a fixed absent-marker, so a probe can tell a real message from silence.
 *  A quiet subsystem and an unknown topic read the same: no registry of topics exists to tell them apart. */
export function lastWhy(topic) {
  const ring = topics.get(topic);
  return ring?.length ? ring[ring.length - 1].msg : '(nothing logged)';
}

// Console affordance: __why() lists topics, __why('tts-list') prints its ring with ages. Installed unconditionally:
// it IS the discoverability.
if (typeof window !== 'undefined') {
  window.__why = (topic) => {
    if (!topic) return [...topics.keys()];
    const now = Date.now();
    return (topics.get(topic) ?? []).map((e) => `${((now - e.t) / 1000).toFixed(1)}s ago: ${e.msg}`);
  };
}
