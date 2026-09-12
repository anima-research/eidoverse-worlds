// bodies — choose what you wear, declared ONCE as fields and rendered twice:
// a section of the profile frame (renderDOM) and part of the profile quad, both dispatching
// into the same switchAvatar the palette's cards call. live: "the
// exact same panels in Desktop mode — hopefully we only need to maintain
// ONE set of menus"; and 22:57: a body is never optional — this is the
// in-headset way to pick one when the default is not what you want.
import { bus } from './base.js';
import { net } from './net.js';
import { renderDOM } from './panels.js';
import { switchAvatar } from './palette.js';
import { getMyAvatarName, getMe } from './mybody.js';

// MY avatars = the bodies you have actually worn (live, 09-05: the world offers a
// wardrobe to try on — World›avatar — and only what you've worn is yours).
// Kept per browser (ew-worn) until the server grows a per-person field; the
// roster is consulted only to resolve a name to its path.
const WORN_LS = 'ew-worn';
let worn = [];
try { worn = JSON.parse(localStorage.getItem(WORN_LS) || '[]'); } catch { worn = []; }
if (!Array.isArray(worn)) worn = [];
function noteWorn(v) {
  const name = typeof v === 'string' ? v : v?.name;   // mybody.announceWorn emits { name, path }
  if (!name) return;
  worn = [name, ...worn.filter((n) => n !== name)].slice(0, 24);   // newest first
  try { localStorage.setItem(WORN_LS, JSON.stringify(worn)); } catch { /* private mode */ }
}
bus.on('avatar-worn', noteWorn);

function fields() {
  const cur = getMyAvatarName();
  const roster = net.avatars ?? [];
  const mine = worn.filter((n) => roster.some((a) => a.name === n) || n === cur);
  return [
    // None, not '—', and only when a body is actually in the scene: `cur` is
    // the name we INTEND to wear and survives a failed load, which is how this
    // row and the list below it came to contradict each other. (R, 2026-09-11)
    { t: 'info', label: 'wearing', value: getMe() ? (cur ?? 'None') : 'None' },
    { t: 'list', label: 'my avatars', empty: 'nothing worn yet — try one from World › avatar',
      rows: mine.map((n) => {
        const a = roster.find((x) => x.name === n);
        return { id: n, label: n, sub: a?.height ? `${a.height.toFixed(2)} m` : undefined, active: n === cur,
          actions: n === cur ? [] : [{ k: 'wear', label: 'wear' }] };
      }) },
  ];
}
function dispatch(k, id) {
  if (k !== 'wear' && k !== 'row') return;
  const a = (net.avatars ?? []).find((x) => x.name === id);
  if (a) switchAvatar(a.path, a.name);
}

// The bodies list lives INSIDE the profile (live, 09-05: reachable from
// profile, not its own menu). profile.js mounts it under the avatars tile
// and folds its fields into the profile quad.
export const bodiesFields = fields;
export const bodiesDispatch = dispatch;
export function mountBodies(host) {
  host.classList.add('schema-panel');
  const scroll = document.createElement('div');
  scroll.className = 'schema-scroll';
  host.append(scroll);
  const repaint = () => renderDOM(scroll, fields(), dispatch);
  repaint();
  bus.on('avatars', repaint);
  bus.on('avatar-worn', repaint);
  return repaint;
}
