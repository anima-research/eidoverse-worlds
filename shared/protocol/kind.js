// shared/protocol/kind.js — what a thing IS, decided once for every reader.
//   kindOf(x) → 'model' | 'mesh' | 'light' | 'empty'
// x is either the authority's record ({c: {model?, mesh?, light?, …}}) or the view record every client-side reader holds
// ({lib?, comp: {mesh?, light?, …}}, shared/protocol/view.js viewOf). A model wins over a light (an imported lamp carries both;
// the authority's one-place rule refuses writing that pairing natively); a mesh is a drawn thing like a model and wins over a
// light the same way. A light component counts only as a plain object; a mesh only as a plain object whose shape is one the
// registry names (componentspec `mesh`; a malformed mesh is absent, the thing an Empty, never a throw — review primitives S2):
// anything else is an annotation on an Empty.
// A view record never carries `kind` (translate-v1 rewrites a v1 light to c.light and drops the field; viewOf emits none):
// readers that branch on `ent.kind === 'light'` are reading a field that is never there.
import { COMPONENTS } from "./componentspec.js";
const bag = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** A `mesh` component a reader may draw: a bag whose shape the registry names. */
export const isMeshBag = (m) => bag(m) && COMPONENTS.mesh.enums.shape.includes(m.shape);

export const KINDS = Object.freeze(["model", "mesh", "light", "empty"]);

export function kindOf(x) {
  if (!x || typeof x !== "object") return "empty";
  const c = bag(x.c) ? x.c : null;
  const model = c ? typeof c.model === "string" : x.lib != null;
  if (model) return "model";
  const get = (k) => (c ? c[k] : x.comp?.[k]);
  if (isMeshBag(get("mesh"))) return "mesh";
  if (bag(get("light"))) return "light";
  return "empty";
}
