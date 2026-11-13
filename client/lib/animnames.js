// The action bar's vocabulary: names, bar glyphs, and the clip each one plays.
//
// Split out of avatar.js so the ACTION BAR can have it without the engine. The bar
// needs a name and a glyph per gesture — strings — while the clip is the only part that
// wants a renderer, and importing all of it from avatar.js meant a client that renders
// nothing (lite.js) still paid for three.js to draw nine buttons.
//
// avatar.js re-exports every name below, so nothing that imported these from there had
// to change; it is one module instance either way, which is what the hydration trick
// relies on.
import { bus } from './base.js';
import { defsRegistry } from './defs.js';

// §24l R1: the vocabulary itself is DATA now — defs/animations/_actionbar.json,
// hydrated below (object identity preserved, the FLORA_SPECIES trick) and
// re-hydrated on the defs-updated push. It used to live in four places
// (this table, actionbar.js's ICON map, the slash command's help string, the help
// sheet's prose), each drifted from the others.
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
  // a failed fetch tries again, backing off (2 s doubling to a minute): waiting for a hot-reload push left the bar empty
  // for the session (house config I18). unref: a headless host without /defs isn't held open by the retry
  let wait = 2000, retry = null;
  const refresh = () => { clearTimeout(retry); retry = null; return defsRegistry()
    .then((reg) => { wait = 2000; hydrateAnimNames(reg.actionbar); })
    .catch((e) => { console.warn(`[actionbar] def hydration failed — no gestures until it lands (trying again in ${wait / 1000} s):`, e);
      retry = setTimeout(refresh, wait); retry?.unref?.(); wait = Math.min(60000, wait * 2); }); };
  refresh();
  bus.on('defs-updated', refresh);
}
