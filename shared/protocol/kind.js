// shared/protocol/kind.js — what a thing IS, decided once for every reader.
//   kindOf(x) → 'model' | 'mesh' | 'light' | 'empty'
// x is either the authority's record ({c: {model?, mesh?, light?, …}}) or the view record every client-side reader holds
// ({lib?, comp: {mesh?, light?, …}}, shared/protocol/view.js viewOf). A model wins over a light (an imported lamp carries both;
// the authority's one-place rule refuses writing that pairing natively); a mesh is a drawn thing like a model and wins over a
// light the same way. A light or mesh component counts only as a plain object: anything else is an annotation on an Empty.
// A view record never carries `kind` (the old-world importer rewrites an old light to c.light and drops the field; viewOf emits none):
// readers that branch on `ent.kind === 'light'` are reading a field that is never there.
const bag = (v) => !!v && typeof v === "object" && !Array.isArray(v);

export const KINDS = Object.freeze(["model", "mesh", "light", "empty"]);

export function kindOf(x) {
  if (!x || typeof x !== "object") return "empty";
  const c = bag(x.c) ? x.c : null;
  const model = c ? typeof c.model === "string" : x.lib != null;
  if (model) return "model";
  const has = (k) => bag(c ? c[k] : x.comp?.[k]);
  if (has("mesh")) return "mesh";
  if (has("light")) return "light";
  return "empty";
}
