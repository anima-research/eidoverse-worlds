// hierarchy — the scene tree as a pure function of the fold (design §3
// "Children", §5 "Left: Hierarchy"). Dependency-free beyond shared/rot.js;
// read by the desktop Hierarchy panel, its VR quad, the inspector's Parent
// field and the agent's `inspect` / `hierarchy` tools.
//
// `world` is the fold's entities map ({ id: record }) — state.st.entities in
// the browser, the agent's folded records in mcpl. A record's `parent`
// ({ to, socket?, offset?, yaw?, q? }) is the only edge.
//
// A child's transform is LOCAL to its parent, exactly as the renderer
// realizes it (client/lib/realize/models.js execMount): the child is added
// to its carrier's Object3D, so
//   position = parent.offset ?? socket.pos ?? [0,0,0]   (carrier frame)
//   rotation = parent.q ?? R_y(parent.yaw ?? socket.yaw ?? 0)
//   scale    = the child's own `scale` (the carrier's scale multiplies it)
// and while mounted the fold's `pos`/`q` on the child are its pre-mount pose,
// unused until a dismount stamps a new one.

import * as OP from './protocol/requests.js';
import { enc } from './protocol/names.js';
import { scale3, scaleWire, entScale } from './scale3.js';
import { qNorm, qMul, qRotate, qFromYaw, qHeading } from './rot.js';
import { socketQ } from './components.js';

const conj = (q) => [-q[0], -q[1], -q[2], q[3]];
const r3 = (v) => +(+v).toFixed(4);
const r9 = (v) => +(+v).toFixed(9);
/** A pure turn about +Y (no tilt): such an orientation travels as a bare yaw. */
const upright = (q) => Math.abs(q[0]) < 1e-9 && Math.abs(q[2]) < 1e-9;

/** The socket a mount names, resolved on its carrier — or null. */
export function socketOf(world, rel) {
  if (!rel?.socket) return null;
  const s = world?.[rel.to]?.sockets?.[rel.socket];
  return s && typeof s === 'object' ? s : null;
}

/** Is `rel.to` a carrier this record actually rides (present in the world)?
 *  The renderer leaves a child whose carrier is missing where the fold put it. */
const ridden = (world, ent) => !!ent?.parent?.to && !!world?.[ent.parent.to];

/** An entity's LOCAL transform: its own pose for a root, the mount's for a
 *  child (see the header). `q` is null for a yaw-only pose. `part` names the
 *  carrier's moving part a part socket glues it into (its pose is then baked
 *  at the part's current phase, not editable as an offset). */
export function localOf(ent, world = null) {
  if (!ent) return null;
  const scale = entScale(ent) ?? 1;
  if (!ent.parent || (world && !ridden(world, ent))) {
    return { mounted: false, pos: [...(ent.pos ?? [0, 0, 0])], q: qNorm(ent.q) ?? null, yaw: ent.yaw ?? 0, scale, part: null };
  }
  const rel = ent.parent;
  const sock = socketOf(world, rel);
  const q = qNorm(rel.q) ?? (rel.yaw == null && sock ? socketQ(sock) : null);
  return {
    mounted: true, to: rel.to, ...(rel.socket ? { socket: rel.socket } : {}),
    pos: [...(Array.isArray(rel.offset) ? rel.offset : sock?.pos ?? [0, 0, 0])].map((v) => Number(v) || 0),
    q, yaw: q ? qHeading(q) : (rel.yaw ?? 0), scale,
    part: sock?.part ? String(sock.part) : null,
  };
}

/** The ids above `id`, nearest first. Stops at a missing carrier or a cycle
 *  (an old log may hold one; the authority refuses new ones). */
export function ancestors(world, id) {
  const out = [];
  const seen = new Set([id]);
  for (let ent = world?.[id]; ent?.parent?.to && world[ent.parent.to] && !seen.has(ent.parent.to); ent = world[ent.parent.to]) {
    out.push(ent.parent.to); seen.add(ent.parent.to);
  }
  return out;
}

/** World pose { pos, q, scale } of `id`, composing its chain the way three.js
 *  composes the realized Object3Ds: parent ∘ local. */
export function worldPose(world, id) {
  const ent = world?.[id];
  if (!ent) return null;
  const chain = [id, ...ancestors(world, id)];
  // the top of the chain is a root: its own pose IS its world pose
  let acc = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const e = world[chain[i]];
    const L = localOf(e, i === chain.length - 1 ? {} : world);   // {} = "treat as root": no carrier lookups
    const lq = L.q ?? qFromYaw(L.yaw);
    if (!acc) { acc = { pos: L.pos, q: lq, scale: L.scale }; continue; }
    // a scale is one number or [x,y,z] (shared/scale3.js): the parent's scale applies in its own axes, before its turn
    const s = scale3(acc.scale), ls = scale3(L.scale);
    const p = qRotate(acc.q, [s[0] * L.pos[0], s[1] * L.pos[1], s[2] * L.pos[2]]);
    acc = { pos: [acc.pos[0] + p[0], acc.pos[1] + p[1], acc.pos[2] + p[2]], q: qNorm(qMul(acc.q, lq)), scale: scaleWire([s[0] * ls[0], s[1] * ls[1], s[2] * ls[2]]) };
  }
  return acc;
}

/** The local transform that puts a thing at world pose `child` under a
 *  carrier at world pose `parent` — the inverse of worldPose's compose step. */
export function localUnder(parent, child) {
  const inv = conj(parent.q);
  const d = qRotate(inv, [child.pos[0] - parent.pos[0], child.pos[1] - parent.pos[1], child.pos[2] - parent.pos[2]]);
  const s = scale3(parent.scale || 1), cs = scale3(child.scale);
  return { offset: d.map((v, i) => v / (s[i] || 1)), q: qNorm(qMul(inv, child.q)), scale: scaleWire(cs.map((v, i) => v / (s[i] || 1))) };
}

/** Why `id` may not go under `to`, or null. A thing cannot be its own parent,
 *  nor be dropped onto anything inside it. */
export function cycleRefusal(world, id, to) {
  if (to == null) return null;
  if (to === id) return `${id} can't be its own parent`;
  const up = ancestors(world, to);
  const at = up.indexOf(id);
  if (at < 0) return null;
  const path = [to, ...up.slice(0, at + 1)].reverse().join(' › ');
  return `${to} is inside ${id} (${path}) — a thing can't be parented under its own child`;
}

/** Children of `id`, in id order (the fold's edges, not the realized scene). */
export function childrenOf(world, id) {
  return Object.keys(world ?? {}).filter((k) => world[k]?.parent?.to === id).sort();
}

/** What a row says a thing IS, in a word or two: a light, an Empty, or its model's file stem. */
export function kindHint(ent) {
  if (!ent) return '?';
  const lit = ent?.light && typeof ent.light === 'object';
  const mesh = ent?.mesh && typeof ent.mesh === 'object' ? ent.mesh.shape : null;
  if (ent.model == null) return typeof mesh === 'string' ? `${mesh}${lit ? ' + light' : ''}` : lit ? 'light' : 'empty';
  const plus = lit ? ' + light' : '';
  return `${String(ent.model).split('/').pop().replace(/\.glb$/, '').split('_').slice(0, 3).join(' ')}${plus}`;
}

/** { roots, kids } from the fold: a thing whose carrier is absent, or whose
 *  chain loops back on itself, is a root (so a hand-written cycle cannot hide
 *  its members from the tree). */
export function treeOf(world) {
  const kids = new Map(); const roots = [];
  // ordered by the name a person sees, numbers as numbers (R 10-10: 'domino 11, domino 12, domino 3')
  const nm = (id) => { const l = world[id]?.label; return typeof l === 'string' && l ? l : id; };
  const order = Object.keys(world ?? {}).sort((a, b) => nm(a).localeCompare(nm(b), 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0));
  for (const id of order) {
    const to = world[id]?.parent?.to;
    const loops = to && ancestors(world, id).length && ancestors(world, to).includes(id);
    if (to && world[to] && !loops && to !== id) { if (!kids.has(to)) kids.set(to, []); kids.get(to).push(id); }
    else roots.push(id);
  }
  return { roots, kids };
}

/** The rows a tree view paints, in order: [{ id, depth, kids, open, dim }].
 *  `collapsed` folds a node's children away; `matches(id)` (when given) is the
 *  filter: a row shows if it matches or anything under it does, its
 *  non-matching ancestors show dimmed, and a match inside a FOLDED parent still
 *  shows — the filter opens the path to it. `extra(id)` lists non-entity rows
 *  under a node (seated people), as { id, match } — they count as children. */
export function treeRows(world, { collapsed = new Set(), matches = null, extra = null } = {}) {
  const { roots, kids } = treeOf(world);
  const rows = [];
  const walk = (id, depth) => {
    const ch = kids.get(id) ?? [];
    const ex = extra?.(id) ?? [];
    const mine = !matches || matches(id);
    const at = rows.length;
    const folded = collapsed.has(id);
    const row = { id, depth, kids: ch.length + ex.length, open: !folded || !!matches, ...(matches && !mine ? { dim: true } : {}) };
    rows.push(row);
    let any = mine;
    if (!folded || matches) {
      for (const x of ex) if (!matches || x.match) { rows.push({ id: x.id, depth: depth + 1, kids: 0, extra: true }); any = true; }
      for (const k of ch) if (walk(k, depth + 1)) any = true;
    }
    if (!any) rows.splice(at);
    return any;
  };
  for (const id of roots) walk(id, 0);
  return rows;
}

/** Parent `id` under `to` (or make it a root when `to` is null) WHERE IT STANDS: the authority requests (shared/protocol/requests.js)
 *  for the Hierarchy's drag, the Parent card and the agent's edit. Its world pose is kept: under a parent the transform
 *  becomes local to it (pos, q and scale: the renderer composes a child's scale with its carrier's); as a root it is the
 *  world pose. One gesture, one batch, one act — the authority's undo is the way back. Locks are the authority's to ask about. */
export function parentOps(world, id, to) {
  const errors = [];
  const ent = world?.[id];
  if (!ent) return { ops: [], errors: [`${id} is not in the world`] };
  to = to == null || to === '' ? null : String(to);
  const was = ent.parent?.to ?? null;   // a carrier that is gone still counts: unparenting clears the dangling edge
  if (to === was) return { ops: [], errors: [to ? `${id} is already under ${to}` : `${id} already has no parent`] };
  if (to && !world[to]) return { ops: [], errors: [`no ${to} here to parent under`] };
  const cyc = cycleRefusal(world, id, to);
  if (cyc) return { ops: [], errors: [cyc] };
  const W = worldPose(world, id);
  if (to) {
    const L = localUnder(worldPose(world, to), W);
    return { ops: [OP.batch([OP.set(id, 'parent', { to: enc(to) }), OP.set(id, 'transform', { pos: L.offset.map(r9), q: L.q.map(r9), scale: scale3(L.scale).map(r9) })])], errors: [] };
  }
  return { ops: [OP.batch([OP.unset(id, 'parent'), OP.set(id, 'transform', { pos: W.pos.map(r9), q: W.q.map(r9), scale: scale3(W.scale).map(r9) })])], errors: [] };
}
