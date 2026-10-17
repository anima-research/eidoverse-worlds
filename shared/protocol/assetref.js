// shared/protocol/assetref.js — names resolved at the write door (shape audit 10-16, render-media-env §G; PROTOCOL §9 "asset
// refs as content addresses resolved at the write door"). A name or a path is a convenience a writer may use; what the log
// STORES is the thing it named, frozen: a model's content address, a particle Essential's document address, a grass
// preset's strokes. A stored value then never means "whatever that name points at today" (Resonite stores resdb:///<sha256>
// on save for the same reason; the sky presets already worked this way: skydefs.js "the fold never sees a preset name").
//
//   atWrite(comp, value, {catalogue}) → {value, notes: [{field?, sent, kept, why}]}
//
// Pure (the catalogue is passed in: the authority hands it CTX.cat). One rule per component, nothing else touched:
//   model      a name or library path → catalogue.address(name) when this server can say what its bytes are (the engine's
//              catalogue hashes the library original: server/modelcatalogue.ts); an address, or a name no address is known
//              for, is kept as written (the lab's catalogue names models it can't hash)
//   particles  effect: an Essentials name → that Essential's pinned address (shared/particle_effects.js ESSENTIAL_ADDRESSES)
//   grass      the first protocol's makeGrass knobs → the flora spelling (flora_args mapGrassArgs, the reader's own mapping);
//              preset: <name> → its strokes (presetStrokes over shared/flora_presets.js), the name dropped. An unknown preset
//              throws from presetStrokes (it would throw in every reader too): the caller refuses it
import { essentialAddress } from "../particle_effects.js";
import { isLegacyArgs, mapGrassArgs, presetStrokes } from "../flora_args.js";
import { FLORA_PRESETS } from "../flora_presets.js";

const bag = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const ADDRESS = /^eido:sha256\/[0-9a-f]{64}$/;

/** A model reference as it is stored: its content address when the catalogue knows one, else as written. */
export function modelAddress(name, catalogue) {
  if (typeof name !== "string" || ADDRESS.test(name) || typeof catalogue?.address !== "function") return name;
  let a = null; try { a = catalogue.address(name); } catch { a = null; }
  return typeof a === "string" && ADDRESS.test(a) ? a : name;
}

/** A grass value in its one stored spelling (and the note for what was rewritten). Throws on an unknown preset. */
export function grassAtWrite(v) {
  if (!bag(v)) return { value: v, notes: [] };
  const notes = []; let out = v;
  if (isLegacyArgs(out)) { const m = mapGrassArgs(out); notes.push({ sent: "bladeHeight/spacing/perCell/colorTip/an int colour", kept: "the flora spelling", why: "the first protocol's makeGrass knobs, mapped once (flora_args mapGrassArgs)" });
    // anything the mapping doesn't name (preset, rows, strokes, heading…) rides along
    const LEG = new Set(["bladeHeight", "spacing", "perCell", "colorTip", "windSpeed", "lean", "fade", "fadeStart", "fadeEnd", "fadeColor", "backlight"]);
    out = { ...Object.fromEntries(Object.entries(out).filter(([k]) => !LEG.has(k) && !(k in m) && k !== "color")), ...m }; }
  if (out.preset != null) { const strokes = presetStrokes(out, FLORA_PRESETS); const { preset, ...rest } = out;
    out = { ...rest, strokes }; notes.push({ field: "preset", sent: preset, kept: `${strokes.length} strokes`, why: "a preset is a name for strokes in a file that may change: the strokes are what is stored" }); }
  return { value: out, notes };
}

/** What a write of `comp` stores: {value, notes}. */
export function atWrite(comp, value, { catalogue = null } = {}) {
  const base = String(comp).split(":")[0];
  if (base === "model") { const a = modelAddress(value, catalogue); return { value: a, notes: a !== value ? [{ sent: value, kept: a, why: "a model is stored as its content address (the bytes it names), not a path or a name that may point elsewhere later" }] : [] }; }
  if (base === "particles" && bag(value) && typeof value.effect === "string") { const a = essentialAddress(value.effect);
    return a ? { value: { ...value, effect: a }, notes: [{ field: "effect", sent: value.effect, kept: a, why: "an Essential is stored as its document's address, so a later build can't change what this effect is" }] } : { value, notes: [] }; }
  if (base === "grass") return grassAtWrite(value);
  return { value, notes: [] };
}
