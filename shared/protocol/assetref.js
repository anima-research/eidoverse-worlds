// shared/protocol/assetref.js — what the write door does to a reference by name (shape audit 10-16; R 10-17, binding: "definitely
// serve path again alongside hash"). A reference is stored AS WRITTEN: a model's library path, a particle Essential's name, a
// grass preset's name. Those are the portable references: a world loads anywhere the library (or the code that ships the
// Essentials and the presets) exists. What its bytes were rides beside it, never instead: a model's content hash is the
// model-hash component the authority stamps when its catalogue already knows it (authority.js stampModelHash), and a world
// loses nothing when it is absent. Readers still take a content address stored before 10-17 (shared/eido.js,
// particle_effects.js essentialNameOf).
//
//   atWrite(comp, value) → {value, notes: [{field?, sent, kept, why}]}
//
// Pure. The one rewrite left is a spelling, not a resolution:
//   grass  the first protocol's makeGrass knobs → the flora spelling (flora_args mapGrassArgs, the reader's own mapping); a
//          preset is kept by its name and checked (presetStrokes over shared/flora_presets.js): an unknown preset throws (it
//          would throw in every reader too), and the caller refuses it
import { isLegacyArgs, mapGrassArgs, presetStrokes } from "../flora_args.js";
import { FLORA_PRESETS } from "../flora_presets.js";

const bag = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** A grass value in its one stored spelling (and the note for what was rewritten). Throws on an unknown preset. */
export function grassAtWrite(v) {
  if (!bag(v)) return { value: v, notes: [] };
  const notes = []; let out = v;
  if (isLegacyArgs(out)) { const m = mapGrassArgs(out); notes.push({ sent: "bladeHeight/spacing/perCell/colorTip/an int colour", kept: "the flora spelling", why: "the first protocol's makeGrass knobs, mapped once (flora_args mapGrassArgs)" });
    // anything the mapping doesn't name (preset, rows, strokes, heading…) rides along
    const LEG = new Set(["bladeHeight", "spacing", "perCell", "colorTip", "windSpeed", "lean", "fade", "fadeStart", "fadeEnd", "fadeColor", "backlight"]);
    out = { ...Object.fromEntries(Object.entries(out).filter(([k]) => !LEG.has(k) && !(k in m) && k !== "color")), ...m }; }
  if (out.preset != null && !(Array.isArray(out.strokes) && out.strokes.length)) presetStrokes(out, FLORA_PRESETS);   // a name every reader can compose, or a refusal
  return { value: out, notes };
}

/** What a write of `comp` stores: {value, notes}. Everything but grass is stored as written. */
export function atWrite(comp, value) {
  if (String(comp).split(":")[0] === "grass") return grassAtWrite(value);
  return { value, notes: [] };
}
