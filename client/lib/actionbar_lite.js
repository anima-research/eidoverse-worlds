// The action row for a client with no body.
//
// NOT a reuse of actionbar.js, and the reason is worth stating: that bar is a draggable
// frame with whole-tile snapping, viewport caging and an XR panel registration, and it
// reaches the local avatar through controller.js and mybody.js to play the clip. Every
// one of those pulls the engine, and none of them means anything on a phone with no
// scene — there is no body to pose and no VR to register into.
//
// So this is the same VOCABULARY (animnames.js, the shared data the split bought) with
// a phone's interaction model: a wrapping row of buttons that send the verb. Everyone
// with a renderer sees the animation; the sender sees it in chat, like they do for
// anything else they say.
import { ANIM_ORDER, ANIM_ICONS } from './animnames.js';
import { bus } from './base.js';

const GLYPH_FALLBACK = '\u2728';

/** @param {(name: string) => void} gesture fires ONE gesture. NOT a verb sender: there is no
 *  gesture verb (the set is closed by design; the server answers "verb not allowed: gesture").
 *  A gesture is a one-shot field on the presence pose - see lite.js. */
export function initLiteActions(host, gesture) {
  const row = document.createElement('div');
  row.className = 'lite-actions';

  const paint = () => {
    row.textContent = '';
    if (!ANIM_ORDER.length) {
      // The vocabulary is hydrated from defs over the network, so an empty table is
      // "not yet", not "none" — say so rather than rendering an empty strip.
      const w = document.createElement('span');
      w.className = 'lite-actions-wait';
      w.textContent = 'loading actions\u2026';
      row.appendChild(w);
      return;
    }
    for (const name of ANIM_ORDER) {
      const b = document.createElement('button');
      b.className = 'lite-action';
      b.type = 'button';
      b.dataset.anim = name;
      b.title = name;
      b.setAttribute('aria-label', name);
      b.textContent = ANIM_ICONS[name] ?? GLYPH_FALLBACK;
      b.addEventListener('click', () => {
        gesture(name);
        // Local echo: on a phone there is no avatar to watch, so the button itself has
        // to be the feedback that the tap registered.
        b.classList.add('fired');
        setTimeout(() => b.classList.remove('fired'), 600);
      });
      row.appendChild(b);
    }
  };

  paint();
  bus.on('animnames-updated', paint);   // defs can land after us, and can be re-pushed live
  host.appendChild(row);
  return row;
}
