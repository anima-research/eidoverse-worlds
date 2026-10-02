// Private attention, separate from chat rendering (which also renders history).
// Only the wire's live-entry path calls say(). Captions are visual performance:
// the durable say is the single attention source for a spoken utterance.
export const ATTENTION_COOLDOWN_MS = 3000;
const UTTERANCE_LIMIT = 1024;

export function createAttentionGate({ me, scope, mentions, now = () => performance.now(), play = () => true }) {
  let context, highSeq = -1, last = -Infinity;
  const utterances = new Map();
  const sessions = new Map();
  function forget(actor) {
    sessions.delete(actor);
    for (const [key, who] of utterances) if (who === actor) utterances.delete(key);
  }
  function participant({ id, session } = {}, arrived = true) {
    sync();
    if (!id) return;
    // A live arrival is a boundary even on older servers. A snapshot without
    // session cannot establish a changed sender; preserve the existing cache.
    // A rejoin missed while disconnected needs the new server's session field.
    if (arrived || (typeof session === 'string' && sessions.get(id) !== session)) forget(id);
    if (typeof session === 'string' || !sessions.has(id)) sessions.set(id, session);
  }
  function sync() {
    const next = JSON.stringify([scope(), me()]);
    if (next !== context) {
      context = next; highSeq = -1; last = -Infinity; utterances.clear(); sessions.clear();
    }
  }
  function admit() {
    const at = now();
    if (at - last < ATTENTION_COOLDOWN_MS) return false;
    if (play() !== true) return false; // silent/locked notices consume identity, not audio cooldown
    last = at;
    return true; // leading-edge coalescing; never queue a stale bell
  }
  return {
    participant,
    forget,
    roster(people) {
      sync();
      const present = new Set(people.map(p => p.id));
      for (const actor of sessions.keys()) if (!present.has(actor)) forget(actor);
      for (const person of people) participant(person, false);
    },
    say(entry) {
      sync();
      if (entry?.verb !== 'say' || entry.replay) return false;
      if (!Number.isSafeInteger(entry.seq) || entry.seq <= highSeq) return false;
      highSeq = entry.seq;
      const { actor, args = {} } = entry;
      if (!actor || actor === '*' || actor === me() || !mentions(args.text)) return false;
      if (args.spoken === true && Number.isSafeInteger(args.utt)) {
        const key = JSON.stringify([actor, args.utt]);
        if (utterances.has(key)) return false;
        utterances.set(key, actor);
        // Bounded session memory, not a timer: a long utterance's later flush
        // stays consumed even after the burst cooldown has passed.
        if (utterances.size > UTTERANCE_LIMIT) utterances.delete(utterances.keys().next().value);
      }
      return admit();
    },
    whisper(msg) {
      sync();
      if (!msg || msg.echo || msg.replay || !msg.from || msg.from === me()
          || msg.to !== me() || typeof msg.text !== 'string' || !msg.text) return false;
      return admit();
    },
  };
}
