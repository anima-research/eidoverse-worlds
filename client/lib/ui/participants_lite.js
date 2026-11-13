// The participant registry for a client with no renderer — the DOM-only twin of remotes.js, wired into
// net.js by lite.js where main.js wires the real one. Same interface, so the wire protocol has one
// implementation; a participant here is a row (who, avatar NAME, declared word, speaking/typing), not a
// body. Poses are dropped (~15 Hz per person a phone need not interpolate); the server clock is kept so
// chat timestamps stay honest.
import { bus } from '../base.js';

export const remotes = new Map(); // id -> LiteRow

// the same clock as remotes.js, so net.js's one-way samples feed the one estimate
export { noteServerTime, serverNow } from '../serverclock.js';

/** Async to match remotes.js: net.js does `.then(...)` on the arrival path. */
export async function ensureRemote(id, avatarPath, meta = {}) {
  const existing = remotes.get(id);
  if (existing) {
    if (meta.declares !== undefined) existing.declares = meta.declares;   // the word they declared at the door (§6a), or null
    if (avatarPath) existing.avatarPath = avatarPath;   // a name; nothing fetches it
    bus.emit('roster');
    return existing;
  }
  const row = {
    id,
    avatarPath: avatarPath || '',
    declares: meta.declares ?? null,
    speakingUntil: 0,
    typing: false,
    // no `avatar` key, deliberately: net.js's `remotes.get(id)?.avatar?.setTyping(...)` then no-ops
  };
  remotes.set(id, row);
  bus.emit('roster');
  return row;
}

/** Like remotes.js: a predecessor's late cleanup must not delete the successor that now owns the id. */
export function dropRemote(id, expected) {
  const r = remotes.get(id);
  if (!r) return null;
  if (expected && r !== expected) return null;
  remotes.delete(id);
  bus.emit('roster');
  return r;
}

/** Poses are discarded (no bodies to drive); a named no-op keeps the interface whole. */
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
