/** Autoplay unlock — one gesture, every pending audio element, both transports.
 *
 * `audio.play()` rejects without a user gesture. Blocked elements wait in one shared
 * queue, retried all at once on ANY plausible gesture (mobile often sends no plain
 * `click`), and the block is said in chat, since silence alone looks like "nobody talking".
 */
import { logChat } from '../ui/chat.js';

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
      // Tell them: otherwise the only symptom is silence, which looks like "nobody is talking".
      logChat('*', 'tap anywhere to enable audio — your browser is holding it until you do');
      console.warn(`[voice] autoplay blocked (${who}) — waiting for a user gesture. `
        + `${pending.size} element(s) held.`);
    }
  });
}

function arm() {
  if (armed) return;
  armed = true;
  // Every gesture a browser might accept: on a touchscreen `touchend`/`pointerdown` arrive
  // rather than `click`; `keydown` covers a desktop user who never mouses.
  const events = ['pointerdown', 'touchend', 'click', 'keydown'];
  const unlock = () => {
    let released = 0;
    for (const a of [...pending]) {
      a.play().then(() => { pending.delete(a); released++; }).catch(() => { /* still blocked */ });
    }
    // Do NOT disarm while anything is still held: a gesture can be consumed
    // before the audio context is ready, and a second tap must still work.
    if (pending.size === 0) {
      for (const e of events) removeEventListener(e, unlock);
      armed = false;
      if (released) console.info(`[voice] audio unlocked — ${released} element(s) now playing`);
    }
  };
  for (const e of events) addEventListener(e, unlock, { passive: true });
}
