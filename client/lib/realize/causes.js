// causes — the live-event dispatcher for verbs that FOLD TO NOTHING
// (TEL0S_NOTES §11.4, slice 3c).
//
// The fold handles state; these are events. A `use` is a cause whose
// effects arrive as separate entries; `force`/`punt` are physical causes
// only bodies present at the moment feel; moderation lines narrate only
// when they HAPPEN (replaying an old ban as if it just happened would be a
// lie); a live `say` is a spoken moment (chat line + speech event) whose
// RECORD the fold keeps in recentChat for the next arrival's window.
// None of that can come from a state diff — the fold deliberately shapes
// nothing for them — so the live path dispatches them here.
//
// Wired by main.js off the bus ('live-entry', emitted by net.js when the
// realizers own the scene) rather than imported by net: importing chat
// from a module net imports would add yet another lap around the
// net → chat → net cycle this rebuild is unwinding.

import { bus } from '../core.js';
import { logChat } from '../chat.js';
import { PORTED } from './models.js';

// #57: performance receipts. voiceCapable = actors with a live voice leg
// (seeded by snapshot, kept current by surface-transition); pendingSpeech =
// says held awaiting a `performed` receipt (seq → fallback timer).
const voiceCapable = new Map();
const pendingSpeech = new Map();
const PERFORMANCE_TIMEOUT_MS = 2500;
bus.on('surfaces', (people) => {
  voiceCapable.clear();
  for (const p of people ?? [])
    for (const sf of p.surfaces ?? [])
      if (sf.surface === 'voice') voiceCapable.set(p.id, sf.gen);
});
bus.on('surface-transition', ({ actor, surface, gen, retired }) => {
  if (surface !== 'voice') return;
  // gen null = the leg DIED unreplaced (r-review: this event never fired
  // before — set-only bookkeeping held dead capability forever and every say
  // from that actor ate the full performance timeout against a gone leg).
  // Retire only OUR CURRENT idea of the leg: if a successor's transition
  // already landed (delivery is per-socket, order across sockets is not
  // guaranteed), the stale retirement names an older gen and must not strip
  // the live one.
  if (gen == null) {
    if (retired == null || voiceCapable.get(actor) === retired) voiceCapable.delete(actor);
  } else {
    voiceCapable.set(actor, gen);
  }
});
bus.on('performed', ({ actor, seq, gen }) => {
  // A receipt cancels a hold only from the right author and NOT from a stale
  // (predecessor) voice generation (B2). It carries actor/gen for exactly this.
  // The gen test is `>=`, not `===` (Opus-5 review): a say held while gen 7 was
  // live may legitimately be performed by a SUCCESSOR leg (gen 9) after a
  // mid-hold takeover — the successor inherits the utterance and attests under
  // its own current gen, which the server stamps as performed.gen. Requiring
  // strict equality would ignore that valid receipt and double-speak the line
  // locally. Only a receipt OLDER than the hold's generation (a retired leg's
  // late frame) must be refused; current-or-newer is a real performance.
  const held = pendingSpeech.get(seq);
  if (held && held.actor === actor && gen >= held.gen) {
    clearTimeout(held.timer);
    pendingSpeech.delete(seq);
    // The SUCCESS path still performs VISUALLY (review finding 9): a receipt
    // proves the voice lane carried the audio, but bubbles/mouth ride bus
    // events — cancel-only receipts made the system look broken exactly when
    // it worked (fallback drew everything, success drew nothing). performed:
    // true keeps TTS out (tts.js speakOwnSays skips it — the leg already made
    // the sound). Skipped when the say carried spoken display metadata: that
    // is precisely the field antra's spec leaves in charge of display/caption
    // continuation, so a caption-paced bubble is not drawn twice.
    if (!held.spoken) bus.emit('speech', { ...held.say, performed: true });
  }
});

// Everything realized from folded state — the set that separates "handled
// elsewhere" from a genuinely unknown verb deserving the forward-compat trace.
const STATE_VERBS = new Set([...PORTED, 'terrain', 'grass', 'sky', 'weather', 'asset', 'grant', 'behavior']);

export function handleLiveCause(entry) {
  const { verb, args = {}, actor } = entry;
  switch (verb) {
    case 'say': {
      logChat(actor, args.text, '', {
        seq: entry.seq, ts: entry.ts,
        // spoken-say protocol only: display metadata for a voice that
        // already performed as captions (server sanitizes; this is the
        // client's own guard for old/foreign servers)
        ...(args.spoken === true && Number.isSafeInteger(args.utt)
          ? { spoken: true, utt: args.utt, t0: args.t0 } : {}),
      });
      // PERFORMANCE, decided by receipts, not flags (#57 B1; re-review B2:
      // `spoken` is author-controlled display metadata riding #100's typed
      // say door, so it must never gate performance — a claim is not a
      // receipt). If the author has a live voice leg, HOLD the local speech
      // path briefly: a valid attest arrives as `performed` and we skip (the
      // voice lane carried it); no receipt inside the window means the leg is
      // dead or deaf and we fall back — the half-dead-sidecar case degrades
      // to local TTS instead of silence. Authors with no voice leg speak
      // immediately, spoken flag or not. `spoken/utt/t0` shape only the
      // caption/display continuation above.
      const say = { actor, text: args.text };
      if (voiceCapable.has(actor)) {
        // Bind the hold to WHO is speaking and WHICH voice generation is
        // live now (B2): the receipt that cancels it must match {actor,
        // seq, gen}. A wrong actor, or a predecessor generation's receipt,
        // must not cancel THIS hold — otherwise a receipt born under a
        // retired leg, submitted after reconnect, suppresses a fallback
        // that should have fired.
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
    case 'use':
      bus.emit('use', { actor, ...args });
      return;
    case 'punt':
      bus.emit('punt', { actor, ...args });
      return;
    case 'force':
      bus.emit('force', { actor, ...args });
      return;
    case 'grant': {
      // the roles MIRROR is the social realizer's (state); the narration is
      // live-only and therefore this dispatcher's
      const bits = [args.role, args.gen != null ? (args.gen ? '+gen' : '-gen') : null].filter(Boolean);
      logChat('*', `${actor === 'world' ? 'the world' : actor} made ${args.id} ${bits.join(' ')}`);
      return;
    }
    case 'ban': case 'unban': case 'kick': {
      const what = verb === 'ban' ? 'banned' : verb === 'unban' ? 'lifted the ban on' : 'removed';
      logChat('*', `${actor} ${what} ${args.id}${verb !== 'unban' && args.reason ? ` — ${args.reason}` : ''}`);
      return;
    }
    default:
      // state verbs realized elsewhere are not "unhandled"; anything else
      // keeps the forward-compat trace legacy's default case had
      if (!STATE_VERBS.has(verb)) console.debug('unhandled verb', verb, args);
  }
}

export function initCauses() {
  bus.on('live-entry', handleLiveCause);
}
