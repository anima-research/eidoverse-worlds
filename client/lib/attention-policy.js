// Private attention, separate from chat rendering (which also renders history).
// Only the wire's live-entry path calls say(). Captions are visual performance:
// the durable say is the single attention source for a spoken utterance.
export const ATTENTION_COOLDOWN_MS = 3000;
const UTTERANCE_LIMIT = 1024;

export function createAttentionGate({ me, scope, mentions, now = () => performance.now() }) {
  let context, highSeq = -1, last = -Infinity;
  const utterances = new Set();
  function sync() {
    const next = JSON.stringify([scope(), me()]);
    if (next !== context) {
      context = next; highSeq = -1; last = -Infinity; utterances.clear();
    }
  }
  function admit() {
    const at = now();
    if (at - last < ATTENTION_COOLDOWN_MS) return false;
    last = at;
    return true; // leading-edge coalescing; never queue a stale bell
  }
  return {
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
        utterances.add(key);
        // Bounded session memory, not a timer: a long utterance's later flush
        // stays consumed even after the burst cooldown has passed.
        if (utterances.size > UTTERANCE_LIMIT) utterances.delete(utterances.values().next().value);
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
