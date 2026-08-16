// The emote bar. Emotes were number keys and a slash command — invisible
// unless you read the help. On a performance platform the gestures should be
// somewhere you can see them.

import { makeFrame } from './frames.js';
import { EMOTE_ORDER } from './avatar.js';
import { myState } from './controller.js';
import { getMe } from './mybody.js';

export function initEmoteBar() {
  const f = makeFrame('emotes', {
    title: 'emotes', x: -252, y: -10, w: 232, h: 44, minW: 120, minH: 34, hidden: true,
  });
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:4px; padding:7px;';
  const ICON = { wave: '👋', cheer: '🙌', dance: '💃', point: '👉', salute: '🫡', clap: '👏' };
  EMOTE_ORDER.forEach((name, i) => {
    const b = document.createElement('button');
    b.textContent = `${ICON[name] ?? '✨'}`;
    b.title = `${name}  (${i + 1})`;
    b.onclick = () => { getMe()?.playEmote(name); myState.emote = name; };
    wrap.appendChild(b);
  });
  f.body.appendChild(wrap);
  return f;
}
