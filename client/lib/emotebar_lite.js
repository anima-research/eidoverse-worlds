// The emote row for a client with no body.
//
// NOT a reuse of emotebar.js, and the reason is worth stating: that bar is a draggable
// frame with whole-tile snapping, viewport caging and an XR panel registration, and it
// reaches the local avatar through controller.js and mybody.js to play the clip. Every
// one of those pulls the engine, and none of them means anything on a phone with no
// scene — there is no body to pose and no VR to register into.
//
// So this is the same VOCABULARY (emotedefs.js, the shared data the split bought) with
// a phone's interaction model: a wrapping row of buttons that send the verb. Everyone
// with a renderer sees the animation; the sender sees it in chat, like they do for
// anything else they say.
import { EMOTE_ORDER, EMOTE_ICONS } from './emotedefs.js';
import { bus } from './base.js';

const GLYPH_FALLBACK = '\u2728';

/** @param {(name: string) => void} emote fires ONE emote. NOT a verb sender: there is no
 *  emote verb (the set is closed by design; the server answers "verb not allowed: emote").
 *  An emote is a one-shot field on the presence pose - see lite.js. */
export function initLiteEmotes(host, emote) {
  const row = document.createElement('div');
  row.className = 'lite-emotes';

  const paint = () => {
    row.textContent = '';
    if (!EMOTE_ORDER.length) {
      // The vocabulary is hydrated from defs over the network, so an empty table is
      // "not yet", not "none" — say so rather than rendering an empty strip.
      const w = document.createElement('span');
      w.className = 'lite-emotes-wait';
      w.textContent = 'loading emotes\u2026';
      row.appendChild(w);
      return;
    }
    for (const name of EMOTE_ORDER) {
      const b = document.createElement('button');
      b.className = 'lite-emote';
      b.type = 'button';
      b.dataset.emote = name;
      b.title = name;
      b.setAttribute('aria-label', name);
      b.textContent = EMOTE_ICONS[name] ?? GLYPH_FALLBACK;
      b.addEventListener('click', () => {
        emote(name);
        // Local echo: on a phone there is no avatar to watch, so the button itself has
        // to be the feedback that the tap registered.
        b.classList.add('fired');
        setTimeout(() => b.classList.remove('fired'), 600);
      });
      row.appendChild(b);
    }
  };

  paint();
  bus.on('emotes-updated', paint);   // defs can land after us, and can be re-pushed live
  host.appendChild(row);
  return row;
}
