// debuglog — the "name which guard refused" channel, shared.
//
// The pattern this generalizes was proven the hard way, three times in one
// day (2026-08-16): a predicate that can decline for five reasons and returns
// a bare false costs a debugging round per guess ("I read the code three
// times and guessed wrong twice"). The fix each time was the same — make the
// code SAY which branch it took — but each site invented its own bespoke
// window.__* global (__ttsSync, __ttsMissing, __vlSync, __sfuSrc), so the
// affordance was undiscoverable and the namespace grew a new squatter per
// hunt.
//
// One channel instead. A subsystem narrates its decisions with
// `why(topic, message)`; anyone — /audio, the console, a probe — reads them
// back per topic, with the recent history that a single last-value slot
// cannot carry (a slot also cannot prove something happened BEFORE the thing
// you are staring at).
//
// Deliberately dependency-free and try/catch-free: nothing here can throw
// (strings, arrays, Date.now), so callers do not need to guard it, which is
// what keeps the call sites one line.

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

/** The most recent narration for a topic, or a fixed absent-marker — a probe
 *  that formats this must be able to tell "quiet subsystem" from "no such
 *  topic ever spoke", and both from a real message. */
export function lastWhy(topic) {
  const ring = topics.get(topic);
  return ring?.length ? ring[ring.length - 1].msg : '(nothing logged)';
}

/** Full recent history for a topic (newest last). */
export function whyHistory(topic) {
  return (topics.get(topic) ?? []).map((e) => ({ ...e }));
}

// Console affordance: __why() lists topics, __why('tts-list') prints its ring
// with ages. Installed unconditionally — it IS the discoverability this
// replaces five ad-hoc globals to get.
if (typeof window !== 'undefined') {
  window.__why = (topic) => {
    if (!topic) return [...topics.keys()];
    const now = Date.now();
    return (topics.get(topic) ?? []).map((e) => `${((now - e.t) / 1000).toFixed(1)}s ago: ${e.msg}`);
  };
}
