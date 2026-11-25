// livechat — the live chat lines (the `say` entries the authority writes): a live say is a spoken moment (chat line +
// speech event) whose record stays in the chat window for the next arrival. It isn't world state, so no view diff
// can carry it: net.js dispatches each live line here over the bus ('live-entry', {seq, ts, actor, verb: 'say',
// args: {text, to?, spoken?, utt?, t0?}}). Wired by main.js off the bus, not imported by net (a net → chat → net cycle).

import { bus } from '../base.js';
import { logChat } from '../ui/chat.js';

// voiceCapable: actors with a live voice leg (seeded by the snapshot, kept current by surface-transition).
// pendingSpeech: says held awaiting a `performed` receipt (seq → fallback timer).
const voiceCapable = new Map();
const pendingSpeech = new Map();
const PERFORMANCE_TIMEOUT_MS = 2500;
// a leg that performs an actor's says aloud: the voice leg, or the SFU relay's (server/server.ts, voicesfubridge.js)
const isVoiceLeg = (s) => s === 'voice' || s === 'voice-relay';
bus.on('surfaces', (people) => {
  voiceCapable.clear();
  for (const p of people ?? [])
    for (const sf of p.surfaces ?? [])
      if (isVoiceLeg(sf.surface)) voiceCapable.set(p.id, sf.gen);
});
bus.on('surface-transition', ({ actor, surface, gen, retired }) => {
  if (!isVoiceLeg(surface)) return;
  // gen null: the leg died unreplaced; drop it, or every say from that actor waits out the full timeout. Retire only
  // our current gen: a successor's transition may already have landed (order across sockets is not guaranteed).
  if (gen == null) {
    if (retired == null || voiceCapable.get(actor) === retired) voiceCapable.delete(actor);
  } else {
    voiceCapable.set(actor, gen);
  }
});
bus.on('performed', ({ actor, seq, gen }) => {
  // A receipt cancels a hold only from the right actor, and `gen >=` the hold's: a successor leg may perform a say
  // held under an older gen; only an older gen (a retired leg's late frame) is refused.
  const held = pendingSpeech.get(seq);
  if (held && held.actor === actor && gen >= held.gen) {
    clearTimeout(held.timer);
    pendingSpeech.delete(seq);
    // the bubble/mouth still draw (they ride bus events); performed: true keeps TTS out (tts.js speakOwnSays).
    // Skipped for a spoken say, whose caption continuation already owns the bubble.
    if (!held.spoken) bus.emit('speech', { ...held.say, performed: true });
  }
});

export function handleLiveCause(entry) {
  const { verb, args = {}, actor } = entry;
  switch (verb) {
    case 'say': {
      logChat(actor, args.text, '', {
        seq: entry.seq, ts: entry.ts,
        // spoken-say protocol only: display metadata for a voice that already performed as captions (the server
        // sanitizes; this guards against old/foreign servers)
        ...(args.spoken === true && Number.isSafeInteger(args.utt)
          ? { spoken: true, utt: args.utt, t0: args.t0 } : {}),
      });
      // Performance is decided by receipts, never by `spoken` (author-controlled display metadata). An author with a
      // live voice leg is held briefly: a `performed` receipt skips local speech, no receipt in the window falls back
      // to local TTS. No voice leg: speak immediately.
      const say = { actor, text: args.text };
      if (voiceCapable.has(actor)) {
        // bound to {actor, seq, gen}: a wrong actor's or a retired leg's receipt must not suppress the fallback
        const gen = voiceCapable.get(actor);
        const timer = setTimeout(() => {
          pendingSpeech.delete(entry.seq);
          bus.emit('speech', say);
        }, PERFORMANCE_TIMEOUT_MS);
        pendingSpeech.set(entry.seq, { timer, actor, gen, say, spoken: args.spoken === true });
      } else {
        bus.emit('speech', say);
      }
      return;
    }
    default:
      console.debug('unhandled live entry', verb, args);
  }
}

export function initCauses() {
  bus.on('live-entry', handleLiveCause);
}
