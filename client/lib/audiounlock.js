/** Autoplay unlock — one gesture, every pending audio element, both transports.
 *
 * 🔴 FOUND ON A REAL PHONE (R, 2026-08-16). Desktop→phone audio was silent
 * while phone→desktop worked, and STT worked in the failing direction — which
 * is what pinned it: SpeechRecognition holds its OWN microphone (stt.js:75) and
 * never touches playback, so a receive-side failure leaves it untouched.
 *
 * The server was fanning out correctly the whole time (forwarded=40734, both
 * legs publishing). The packets ARRIVED and did not PLAY.
 *
 * Cause: `audio.play()` rejects without a user gesture, and both transports
 * retried on `addEventListener('click', …, {once: true})`. Two things were
 * wrong with that:
 *
 *   1. ONE listener, ONE element, ONE shot. `{once: true}` fires for whichever
 *      speaker registered it and every other pending element stays silent —
 *      so even a lucky tap only unlocked one voice.
 *   2. It listened for `click` alone. Mobile browsers are far stricter about
 *      autoplay than desktop, and the gesture that satisfies them is not
 *      reliably a synthetic `click` — `touchend` and `pointerdown` land first,
 *      and a page that never receives a plain click never unlocks at all.
 *
 * And it failed SILENTLY: a caught promise rejection, no log, no UI. The person
 * holding the phone sees a working mic meter and concludes the app is broken in
 * a way they cannot describe. R had to tap a blank part of the page on a hunch.
 *
 * So: one shared queue, unlocked by ANY plausible gesture, retried for every
 * element at once, and — because a silent failure is the actual bug — it says
 * so in the chat line the person can see.
 */
import { logChat } from './chat.js';

const pending = new Set();
let armed = false;
let toldThem = false;

/** Play this element, and if the browser refuses, hold it until a gesture. */
export function playWhenAllowed(audio, who = 'someone') {
  const attempt = () => audio.play().then(() => true).catch(() => false);
  attempt().then((ok) => {
    if (ok) { pending.delete(audio); return; }
    pending.add(audio);
    arm();
    if (!toldThem) {
      toldThem = true;
      // The one thing the old code never did: TELL THEM. Without this the only
      // symptom is silence, which is indistinguishable from "nobody is talking".
      logChat('*', 'tap anywhere to enable audio — your browser is holding it until you do');
      console.warn(`[voice] autoplay blocked (${who}) — waiting for a user gesture. `
        + `${pending.size} element(s) held.`);
    }
  });
}

function arm() {
  if (armed) return;
  armed = true;
  // Every gesture a browser might accept. `click` alone was the bug; on a
  // touchscreen `touchend`/`pointerdown` are what actually arrive, and
  // `keydown` covers a desktop user who never mouses.
  const events = ['pointerdown', 'touchend', 'click', 'keydown'];
  const unlock = () => {
    let released = 0;
    for (const a of [...pending]) {
      a.play().then(() => { pending.delete(a); released++; }).catch(() => { /* still blocked */ });
    }
    // Do NOT disarm while anything is still held: a gesture can be consumed
    // before the audio context is ready, and a second tap must still work.
    // Disarming on the first gesture is the {once: true} bug wearing a new hat.
    if (pending.size === 0) {
      for (const e of events) removeEventListener(e, unlock);
      armed = false;
      if (released) console.info(`[voice] audio unlocked — ${released} element(s) now playing`);
    }
  };
  for (const e of events) addEventListener(e, unlock, { passive: true });
}
