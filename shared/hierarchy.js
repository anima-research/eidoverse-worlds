// hierarchy — the scene tree as a pure function of the fold (design §3
// "Children", §5 "Left: Hierarchy"). Dependency-free beyond shared/rot.js;
// read by the desktop Hierarchy panel, its VR quad, the inspector's Parent
// field and the agent's `inspect` / `hierarchy` tools.
//
// `world` is the fold's entities map ({ id: record }) — state.st.entities in
// the browser, the agent's folded records in mcpl. A record's `parent`
// ({ to, slot?, offset?, yaw?, q? }, written by `mount`) is the only edge.
//
// A child's transform is LOCAL to its parent, exactly as the renderer
// realizes it (client/lib/realize/models.js execMount): the child is added
// to its carrier's Object3D, so
//   position = parent.offset ?? socket.pos ?? [0,0,0]   (carrier frame)
//   rotation = parent.q ?? R_y(parent.yaw ?? socket.yaw ?? 0)
//   scale    = the child's own `scale` (the carrier's scale multiplies it)
// and while mounted the fold's `pos`/`q` on the child are its pre-mount pose,
// unused until a dismount stamps a new one.

import { scale3, scaleWire } from './scale3.js';
import { qNorm, qMul, qRotate, qFromYaw, qHeading } from './rot.js';

const conj = (q) => [-q[0], -q[1], -q[2], q[3]];
const isLight = (ent) => ent?.kind === 'light';
const r3 = (v) => +(+v).toFixed(4);
const r9 = (v) => +(+v).toFixed(9);
/** A pure turn about +Y (no tilt): such an orientation travels as a bare yaw. */
const upright = (q) => Math.abs(q[0]) < 1e-9 && Math.abs(q[2]) < 1e-9;

/** The socket a mount names, resolved on its carrier — or null. */
export function socketOf(world, rel) {
  if (!rel?.slot) return null;
  const s = world?.[rel.to]?.comp?.sockets?.[rel.slot];
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
  const scale = isLight(ent) ? 1 : (ent.scale ?? 1);
  if (!ent.parent || (world && !ridden(world, ent))) {
    return { mounted: false, pos: [...(ent.pos ?? [0, 0, 0])], q: isLight(ent) ? null : (qNorm(ent.q) ?? null), yaw: isLight(ent) ? 0 : (ent.yaw ?? 0), scale, part: null };
  }
  const rel = ent.parent;
  const sock = socketOf(world, rel);
  const q = qNorm(rel.q);
  return {
    mounted: true, to: rel.to, ...(rel.slot ? { slot: rel.slot } : {}),
    pos: [...(Array.isArray(rel.offset) ? rel.offset : sock?.pos ?? [0, 0, 0])].map((v) => Number(v) || 0),
    q, yaw: q ? qHeading(q) : (rel.yaw ?? sock?.yaw ?? 0), scale,
    part: sock?.part ? String(sock.part) : null,
  };
}

/** The ids above `id`, nearest first. Stops at a missing carrier or a cycle
 *  (an old log may hold one; the door refuses new ones). */
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
  if (isLight(ent)) return 'light';
  const lit = ent.comp?.light && typeof ent.comp.light === 'object' ? ' + light' : '';
  if (ent.lib == null) return `empty${lit}`;
  return `${String(ent.lib).split('/').pop().replace(/\.glb$/, '').split('_').slice(0, 3).join(' ')}${lit}`;
}

/** { roots, kids } from the fold: a thing whose carrier is absent, or whose
 *  chain loops back on itself, is a root (so a hand-written cycle cannot hide
 *  its members from the tree). */
export function treeOf(world) {
  const kids = new Map(); const roots = [];
  for (const id of Object.keys(world ?? {}).sort()) {
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

/** The verbs that put `id` under `to` (null = make it a root) WITHOUT moving
 *  it in the world, and the inverse verbs that put it back — one undo step on
 *  every surface. Refusals mirror the server (server/rights.ts): a locked
 *  thing does not move; a guarded thing, a guarded new carrier and a guarded
 *  old carrier answer only to their placer (`mayAuthor(id) === false` means
 *  this viewer is not; undefined = unknown, the server decides).
 *
 *  The pose: `mount {id, to, offset, q, yaw}` carries the full local pose
 *  (offset in the carrier's frame and scale, q relative to it — PROTOCOL
 *  §9.1); `dismount {id, pos, q, yaw}` stamps the absolute pose. Neither verb
 *  carries scale, and the renderer multiplies a child's scale by its
 *  carrier's, so when the carrier's world scale is not 1 a `place {id, scale}`
 *  rides along to keep the size. An upright orientation travels as a bare yaw
 *  (old readers stay exact); anything tilted as q + its heading. */
export function parentVerbs(world, id, to, { mayAuthor, doorLocks = false } = {}) {
  const errors = [];
  const ent = world?.[id];
  if (!ent) return { verbs: [], inverses: [], errors: [`${id} is not in the world`] };
  to = to == null || to === '' ? null : String(to);
  const was = ent.parent?.to ?? null;   // a carrier that is gone still counts: unparenting clears the dangling edge
  if (to === was) return { verbs: [], inverses: [], errors: [to ? `${id} is already under ${to}` : `${id} already has no parent`] };
  if (to && !world[to]) return { verbs: [], inverses: [], errors: [`no ${to} here to parent under`] };
  const cyc = cycleRefusal(world, id, to);
  if (cyc) errors.push(cyc);
  if (ent.comp?.lock && !doorLocks) errors.push(`${id} is locked — unlock it first to move it`);   // doorLocks (v4): the door asks
  const guardedBy = (x) => world[x]?.comp?.guard && mayAuthor?.(x) === false ? (world[x].placer?.id ?? world[x].actor ?? 'its placer') : null;
  if (guardedBy(id)) errors.push(`${id} is guarded by ${guardedBy(id)} — only they or the world's owner can move it`);
  if (to && guardedBy(to)) errors.push(`${to} is guarded by ${guardedBy(to)} — only they or the world's owner can put things under it`);
  if (was && guardedBy(was)) errors.push(`${was} is guarded by ${guardedBy(was)} — only they or the world's owner can take things out from under it`);
  if (errors.length) return { verbs: [], inverses: [], errors };

  const W = worldPose(world, id);
  const ownScale = isLight(ent) ? 1 : (ent.scale ?? 1);
  const orient = (q) => (upright(q) ? { yaw: r9(qHeading(q)) } : { q: q.map(r9), yaw: r9(qHeading(q)) });
  const verbs = [];
  let scale = W.scale;
  if (to) {
    const P = worldPose(world, to);
    const L = localUnder(P, W);
    verbs.push({ verb: 'mount', args: { id, to, offset: L.offset.map(r3), ...orient(L.q) } });
    scale = L.scale;
  } else {
    verbs.push({ verb: 'dismount', args: { id, pos: W.pos.map(r3), ...orient(W.q) } });
  }
  const sameScale = scale3(scale).every((v, i) => Math.abs(v - scale3(ownScale)[i]) <= 1e-6);
  if (!isLight(ent) && !sameScale) verbs.push({ verb: 'place', args: { id, scale: scaleWire(scale3(scale).map(r3)) } });

  // the way back: the old carrier with its old relation, or the stamp of the
  // root pose it had (the fold keeps a root's pos/q current)
  const inverses = [];
  if (ent.parent) inverses.push({ verb: 'mount', args: { id, ...JSON.parse(JSON.stringify(ent.parent)) } });
  else inverses.push({ verb: 'dismount', args: { id, pos: [...(ent.pos ?? [0, 0, 0])], ...(ent.q ? { q: [...ent.q] } : {}), yaw: ent.yaw ?? 0 } });
  if (verbs.some((v) => v.verb === 'place')) inverses.push({ verb: 'place', args: { id, scale: ownScale } });
  return { verbs, inverses, errors: [] };
}
