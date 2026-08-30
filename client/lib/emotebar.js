// The emote bar. Emotes were number keys and a slash command — invisible
// unless you read the help. On a performance platform the gestures should be
// somewhere you can see them.

import { makeFrame } from './frames.js';
import { EMOTE_ORDER, EMOTE_ICONS } from './avatar.js';
import { myState } from './controller.js';
import { getMe } from './mybody.js';
import { bus } from './base.js';

export function initEmoteBar() {
  const f = makeFrame('emotes', {
    title: 'emotes', x: -252, y: -10, w: 232, h: 44, minW: 120, minH: 34, hidden: true,
  });
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:4px; padding:7px;';
  // built from the def-hydrated vocabulary (§24l) and rebuilt when a defs
  // push re-hydrates it — icons ride the same table as the names now
  const fill = () => {
    wrap.innerHTML = '';
    EMOTE_ORDER.forEach((name, i) => {
      const b = document.createElement('button');
      b.textContent = `${EMOTE_ICONS[name] ?? '✨'}`;
      b.title = `${name}  (${i + 1})`;
      b.onclick = () => { getMe()?.playEmote(name); myState.emote = name; };
      wrap.appendChild(b);
    });
  };
  fill();
  bus.on('emotes-updated', fill);
  f.body.appendChild(wrap);
  return f;
}
