// The emote vocabulary: names, bar glyphs, and the clip each one plays.
//
// Split out of avatar.js so the EMOTE BAR can have it without the engine. The bar
// needs a name and a glyph per emote — strings — while the clip is the only part that
// wants a renderer, and importing all of it from avatar.js meant a client that renders
// nothing (lite.js) still paid for three.js to draw nine buttons.
//
// avatar.js re-exports every name below, so nothing that imported these from there had
// to change; it is one module instance either way, which is what the hydration trick
// relies on.
import { bus } from './base.js';
import { defsRegistry } from './defs.js';

// §24l R1: the vocabulary itself is DATA now — defs/animations/_emotes.json,
// hydrated below (object identity preserved, the FLORA_SPECIES trick) and
// re-hydrated on the defs-updated push. It used to live in four places
// (this table, emotebar's ICON map, the /emote help string, the help
// sheet's prose), each drifted from the others.
export const EMOTES = {};      // name → clip
export const EMOTE_ORDER = []; // listed names, def key order = bar/number-key order
export const EMOTE_ICONS = {}; // name → bar glyph
export function hydrateEmotes(table) {
  for (const k of Object.keys(EMOTES)) delete EMOTES[k];
  for (const k of Object.keys(EMOTE_ICONS)) delete EMOTE_ICONS[k];
  EMOTE_ORDER.length = 0;
  for (const [name, e] of Object.entries(table ?? {})) {
    if (!e?.clip) continue;
    EMOTES[name] = e.clip;
    if (e.icon) EMOTE_ICONS[name] = e.icon;
    if (e.listed !== false) EMOTE_ORDER.push(name);
  }
  bus.emit('emotes-updated');
}
{
  const refresh = () => defsRegistry()
    .then((reg) => hydrateEmotes(reg.emotes))
    .catch((e) => console.warn('[emotes] def hydration failed — no emotes until it lands:', e));
  refresh();
  bus.on('defs-updated', refresh);
}
