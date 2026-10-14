// shared/protocol/kind.js — what a thing IS, decided once for every reader.
//   kindOf(x) → 'socket' | 'model' | 'mesh' | 'light' | 'empty'
// x is either the authority's record ({c: {model?, mesh?, light?, …}}) or the view record every client-side reader holds
// (the same components flat on the record, shared/protocol/view.js viewOf). A model wins over a light (an imported lamp carries both;
// the authority's one-place rule refuses writing that pairing natively); a mesh is a drawn thing like a model and wins over a
// light the same way. A light component counts only as a plain object; a mesh only as a plain object whose shape is one the
// registry names (componentspec `mesh`; a malformed mesh is absent, the thing an Empty, never a throw — review primitives S2):
// anything else is an annotation on an Empty. A socket (an attachment point, a child of its host) is decided first: it has no
// body of its own, whatever else it carries.
// A view record never carries `kind` (the old-world importer rewrites an old light to c.light and drops the field; viewOf emits none):
// readers that branch on `ent.kind === 'light'` are reading a field that is never there.
import { COMPONENTS } from "./componentspec.js";
const bag = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** A `mesh` component a reader may draw: a bag whose shape the registry names. */
export const isMeshBag = (m) => bag(m) && COMPONENTS.mesh.enums.shape.includes(m.shape);

export const KINDS = Object.freeze(["socket", "model", "mesh", "light", "empty"]);

export function kindOf(x) {
  if (!x || typeof x !== "object") return "empty";
  const c = bag(x.c) ? x.c : x;   // the authority's record ({c}), or the view's: its components flat, in the same names
  if (bag(c.socket)) return "socket";
  if (typeof c.model === "string") return "model";
  if (isMeshBag(c.mesh)) return "mesh";
  if (bag(c.light)) return "light";
  return "empty";
}
