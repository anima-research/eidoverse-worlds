// shared/protocol/requests.js — the authority requests an edit plans, in v4 terms.
// Every planner (editschema, hierarchy, blueprint, the client's gestures, the agent's tools) builds these, and every
// sender sends them as they are: {tool, args}, one per change, or one `batch` for one gesture (= one act = one undo).
// Ids and component names arrive as the VIEW shows them (shared/protocol/view.js decodes the translator's x-- escapes)
// and are encoded here, once. A transform is always written whole ({pos, q, scale}); for a child it is LOCAL to its
// parent (PROTOCOL-v4 §2.3), exactly what the view shows as the child's pos/q/scale. Pure; browser, server, agent.
import { socketQ } from '../components.js';
import { enc, encName } from "./names.js";
import { qNorm, qFromYaw, qWithHeading } from "../rot.js";

const E = (id) => (id === "@world" ? id : enc(String(id ?? "")));   // the world entity is itself, never escaped
const finite3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const scale3 = (s) => (Number.isFinite(s) ? [s, s, s] : finite3(s) ? [...s] : null);

/** set one component (value replaces it; `merge: true` merges an object value into the current one). */
export const set = (id, component, value, { merge = false } = {}) =>
  ({ verb: "set", args: { id: E(id), component: encName(String(component)), value, ...(merge ? { merge: true } : {}) } });
/** remove one component. */
export const unset = (id, component) => ({ verb: "delete", args: { id: E(id), component: encName(String(component)) } });
/** remove a thing (and let its children go: the authority's rule). */
export const remove = (id) => ({ verb: "delete", args: { id: E(id) } });
/** use a thing (its reactions: a swing's push, a door's open). */
/** use a thing. With no action the authority does the thing's one action, or names what it offers (never 'use' by default:
 *  a thing that offers 'push' doesn't 'use'). */
export const use = (id, action = null, args = null) => ({ verb: "use", args: { id: E(id), ...(action != null ? { action: String(action) } : {}), ...(args ? { args } : {}) } });
/** make a thing. components: {name: value}; the transform is whole (missing parts default). */
export function create(id, { model = null, transform = {}, components = {}, from = null } = {}) {
  const comps = {}; for (const [k, v] of Object.entries(components)) comps[encName(k)] = v;
  return { verb: "create", args: { id: E(id), ...(model ? { model } : {}), ...(from ? { from } : {}),
    components: { transform: { pos: finite3(transform.pos) ? [...transform.pos] : [0, 0, 0], q: qNorm(transform.q) ?? [0, 0, 0, 1], scale: scale3(transform.scale) ?? [1, 1, 1] }, ...comps } } };
}

/** The whole transform after a pose edit, from what the view shows (`ent`: {pos, q, yaw, scale, scale3}). `patch`:
 *  pos?, q? (wins), yaw? (a heading: keeps a tilted thing's tilt, turns it about up), scale? (number or [x,y,z]). */
export function transformOf(ent, patch = {}) {
  const q0 = qNorm(ent?.q) ?? qFromYaw(Number.isFinite(ent?.yaw) ? ent.yaw : 0);
  const q = qNorm(patch.q) ?? (Number.isFinite(patch.yaw) ? qWithHeading(q0, patch.yaw) : q0);
  return {
    pos: finite3(patch.pos) ? [...patch.pos] : finite3(ent?.pos) ? [...ent.pos] : [0, 0, 0],
    q,
    scale: scale3(patch.scale) ?? scale3(ent?.scale3) ?? scale3(ent?.scale) ?? [1, 1, 1],
  };
}
/** move/turn/scale a thing (local to its parent if it has one). */
export const setTransform = (ent, id, patch) => set(id, "transform", transformOf(ent, patch));

/** ride `to` (optionally on a named socket): parent + the local pose. With no pose given, the socket's pose, else the
 *  carrier's origin (shared/hierarchy.js localOf reads a parent the same way). Re-parenting to the parent it already
 *  has is just the pose. `world` is the view ({entities}). */
export function parent(world, id, to, { socket = null, pos = null, q = null, yaw = null } = {}) {
  const ent = world?.entities?.[id] ?? null;
  const sock = socket ? world?.entities?.[to]?.comp?.sockets?.[socket] : null;
  const local = {
    pos: finite3(pos) ? pos : finite3(sock?.pos) ? sock.pos : [0, 0, 0],
    q: qNorm(q) ?? (Number.isFinite(yaw) ? qFromYaw(yaw) : sock ? socketQ(sock) : [0, 0, 0, 1]),
  };
  const t = set(id, "transform", { ...local, scale: scale3(ent?.scale3) ?? scale3(ent?.scale) ?? [1, 1, 1] });
  if (ent?.parent?.to === to && (ent.parent.socket ?? null) === (socket ?? null)) return t;
  return batch([set(id, "parent", { to: E(to), ...(socket ? { socket } : {}) }), t]);
}
/** stop riding: drop the parent and stand at a world pose (the caller computes it: hierarchy.worldPose). */
export const unparent = (ent, id, worldPatch) => batch([unset(id, "parent"), set(id, "transform", transformOf({ ...ent, parent: null }, worldPatch))]);

/** one request for one gesture: a single op as itself, several as one batch (nested batches flattened). */
export function batch(ops) {
  const flat = ops.filter(Boolean).flatMap((o) => (o.verb === "batch" ? o.args.ops : [o]));
  if (!flat.length) return null;
  return flat.length === 1 ? flat[0] : { verb: "batch", args: { ops: flat } };
}
/** the (id, component) pairs a request sets — what a gesture's `expect` covers (ids as the authority has them). */
export function writesOf(req) {
  if (!req) return [];
  const ops = req.verb === "batch" ? req.args.ops : [req];
  return ops.filter((o) => o.verb === "set").map((o) => [o.args.id, o.args.component]);
}
