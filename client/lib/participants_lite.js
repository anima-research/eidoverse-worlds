// The participant registry for a client with no renderer — the DOM-only twin of
// remotes.js, wired into net.js by lite.js exactly where main.js wires the real one.
//
// Same interface, deliberately: net.js calls these under the names it always used, so
// the wire protocol has one implementation and this file never has to track changes to
// it. What differs is what a "participant" IS. There, a record owns a three.js body, a
// pose buffer and an interpolator. Here it is a row: who, what they're wearing (as a
// NAME, never loaded), whether they're an agent, whether they just spoke or are typing.
//
// The pose plane is dropped on the floor, and that is the single biggest reason a
// phone can hold this: presence arrives ~15Hz PER PERSON, and every sample would
// otherwise buy interpolation nobody can see. We keep the server clock anyway — it
// costs two numbers and it is what makes timestamps in chat honest.
import { bus } from './base.js';

export const remotes = new Map(); // id -> LiteRow

// Server-to-local clock offset, smoothed. Copied from remotes.js rather than imported
// because importing it would pull the engine in — the one duplication in this file,
// and it is eight lines of arithmetic with no dependencies of its own.
let clockOffset = null;
export function noteServerTime(t) {
  if (typeof t !== 'number') return;
  const sample = t - performance.timeOrigin - performance.now();
  clockOffset = clockOffset === null ? sample : clockOffset * 0.92 + sample * 0.08;
}
export const serverNow = () => performance.timeOrigin + performance.now() + (clockOffset ?? 0);

/** Async to match remotes.js, whose caller does `.then(...)` on the arrival path —
 *  the signature is part of the interface even though nothing here awaits. */
export async function ensureRemote(id, avatarPath, meta = {}) {
  const existing = remotes.get(id);
  if (existing) {
    if (meta.agent !== undefined) existing.agent = meta.agent;
    if (avatarPath) existing.avatarPath = avatarPath;   // a name; nothing fetches it
    bus.emit('roster');
    return existing;
  }
  const row = {
    id,
    avatarPath: avatarPath || '',
    agent: meta.agent,
    speakingUntil: 0,
    typing: false,
    // No `avatar` key, and that is load-bearing: net.js reaches through this record
    // with `remotes.get(id)?.avatar?.setTyping(...)`, so its absence makes every
    // body-facing call a no-op through optional chaining rather than a guard here.
  };
  remotes.set(id, row);
  bus.emit('roster');
  return row;
}

/** Generation-conditional like remotes.js (#95): a predecessor's late cleanup must
 *  not delete the successor that now owns the id. Cheaper here — there are no bones
 *  to dispose, but the identity rule is the same one. */
export function dropRemote(id, expected) {
  const r = remotes.get(id);
  if (!r) return null;
  if (expected && r !== expected) return null;
  remotes.delete(id);
  bus.emit('roster');
  return r;
}

/** The pose plane, deliberately discarded. ~15Hz per person of position data that
 *  would drive bodies this client does not have. Kept as a named no-op rather than
 *  an omission so the interface stays honest and the cost stays visible. */
export function pushPose() { /* no bodies to move */ }

export function noteSpeaking(id, ms = 4000) {
  const r = remotes.get(id);
  if (!r) return;
  r.speakingUntil = performance.now() + ms;
  bus.emit('roster');
}

/** Who is here, newest-speaker-first — what the lite player list renders. */
export const roster = () => [...remotes.values()]
  .map((r) => ({ ...r, speaking: r.speakingUntil > performance.now() }))
  .sort((a, b) => (b.speakingUntil - a.speakingUntil) || a.id.localeCompare(b.id));
