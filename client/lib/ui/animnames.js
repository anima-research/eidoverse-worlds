// The action bar's vocabulary: names, bar glyphs, and the clip each one plays. Engine-free so a
// client that renders nothing (lite.js) can draw the bar; avatar.js re-exports every name (one
// module instance, which the in-place hydration relies on).
import { bus } from '../base.js';
import { defsRegistry } from '../defs.js';

// The vocabulary is data (defs/animations/_actionbar.json), hydrated in place below (object identity preserved) and
// re-hydrated on the defs-updated push.
export const ANIM_CLIPS = {};      // name → clip
export const ANIM_ORDER = []; // listed names, def key order = bar/number-key order
export const ANIM_ICONS = {}; // name → bar glyph
export function hydrateAnimNames(table) {
  for (const k of Object.keys(ANIM_CLIPS)) delete ANIM_CLIPS[k];
  for (const k of Object.keys(ANIM_ICONS)) delete ANIM_ICONS[k];
  ANIM_ORDER.length = 0;
  for (const [name, e] of Object.entries(table ?? {})) {
    if (!e?.clip) continue;
    ANIM_CLIPS[name] = e.clip;
    if (e.icon) ANIM_ICONS[name] = e.icon;
    if (e.listed !== false) ANIM_ORDER.push(name);
  }
  bus.emit('animnames-updated');
}
{
  // a failed fetch tries again, backing off (2 s doubling to a minute); unref so a headless host isn't held open
  let wait = 2000, retry = null;
  const refresh = () => { clearTimeout(retry); retry = null; return defsRegistry()
    .then((reg) => { wait = 2000; hydrateAnimNames(reg.actionbar); })
    .catch((e) => { console.warn(`[actionbar] def hydration failed — no gestures until it lands (trying again in ${wait / 1000} s):`, e);
      retry = setTimeout(refresh, wait); retry?.unref?.(); wait = Math.min(60000, wait * 2); }); };
  refresh();
  bus.on('defs-updated', refresh);
}
