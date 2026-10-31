// tools/protocol/scratchworld.ts — a scratch world behind the real authority, for the planner tests (tools/*-test.ts) that
// check the RESULT of an edit: seed the records a test reads (view form), send the planner's requests, read the
// state back as the view the planners read (shared/protocol/view.js viewState). Same pattern as tools/protocol/authority-check.ts:
// request(openWorld(root, name), actor, verb, args), a `create-world` first to found the world (its founder is its owner).
// @ts-nocheck
import { scratch } from "./common.ts";
import { request, LAB_CATALOGUE, liftWorld, fixtureIds } from "../../shared/protocol/authority.js";
import { openWorld } from "../../server/filehost.ts";
import { viewState } from "../../shared/protocol/view.js";
import { enc, encName } from "../../shared/protocol/names.js";
import { localOf } from "../../shared/hierarchy.js";
import { qNorm, qFromYaw } from "../../shared/rot.js";

import { recordComponents } from "../../shared/protocol/view.js";
import { labClock } from "./clock.ts";
// a fixture seeds the ids its test reads (seed(), and the suites' own creates), as a fork's copy keeps ids: the authority's
// in-process fixture seam (R 10-17: a WRITER never chooses an id; ids-check holds runtime files to never calling it)
fixtureIds(true);
const clock = labClock();
// the engine's catalogue is the library's GLB paths (server/modelcatalogue.ts); a scratch world names any path the tests
// use: the lab's measured models where they exist, else a model the authority can name but not measure (no `size`)
const ANY_MODEL = Object.freeze({ get: (n) => LAB_CATALOGUE.get(n) ?? (typeof n === "string" && n ? { label: n, surfaces: [] } : undefined), list: (q) => LAB_CATALOGUE.list(q) });
const open = (root, name, catalogue = ANY_MODEL) => { const w = openWorld(root, name); w.catalogue = catalogue; liftWorld(w); return w; };
let n = 0;
const roots = new Map();

/** A fresh world in a scratch root (one root per tag), founded by `owner`. */
export function scratchWorld(tag = "edit", { owner = "olive", title = "scratch", catalogue = ANY_MODEL } = {}) {
  if (!roots.has(tag)) roots.set(tag, scratch(tag));
  const root = roots.get(tag); const name = `w${++n}`;
  // one world object for the scratch world's life (its state is kept incrementally); the authority's clock steps a second per
  // request so a long sweep stays inside the authority's rate budget (60 entries / 10 s per actor)
  let w = null;
  const call = (verb, args = {}, actor = owner) => { clock.advance(1000); w ??= open(root, name, catalogue); return request(w, actor, verb, args); };
  const founded = call("create-world", { title });
  if (!founded.ok) throw new Error(`scratch world: new refused: ${JSON.stringify(founded.refused)}`);
  const W = {
    name, root, owner,
    /** the world object itself (the system door, forkCopy, takes it) */
    world: () => (w ??= open(root, name, catalogue)),
    call,
    /** send one planned request ({verb, args}); extra args (throughLock, dry, expect) ride along. */
    send: (req, extra = {}, actor = owner) => (req ? call(req.verb, { ...req.args, ...extra }, actor) : { ok: true, noop: true }),
    /** several planned requests as ONE gesture (shared/protocol/requests.js batch semantics: one act). */
    sendAll: (reqs, extra = {}, actor = owner) => {
      const flat = reqs.filter(Boolean).flatMap((o) => (o.verb === "batch" ? o.args.ops : [o]));
      if (!flat.length) return { ok: true, noop: true };
      return flat.length === 1 ? W.send(flat[0], extra, actor) : call("batch", { ops: flat, ...extra }, actor);
    },
    state: () => (w ??= open(root, name, catalogue)).state(),
    /** the log's entries as the authority holds them */
    entries: () => (w ??= open(root, name, catalogue)).entries,
    /** a stored blob (a published blueprint record) by its hash */
    getBlob: (h) => (w ??= open(root, name, catalogue)).getBlob(h),
    view: () => viewState(w.state()),
    /** the view record of one thing (ids as the planners use them) */
    rec: (id) => viewState(w.state()).entities[id] ?? null,
    /** seed things from VIEW-form records ({lib, pos, q|yaw, scale|scale3, parent:{to, socket?, offset?, q?|yaw?}, comp}).
     *  A child's transform is written LOCAL to its parent (localOf reads a v1-style mount the same way the planners do).
     *  Parents first; every create must be accepted or the seed throws. */
    seed: (recs) => {
      const done = new Set(); const order = [];
      const visit = (id) => { if (done.has(id)) return; done.add(id); const p = recs[id]?.parent?.to; if (p && recs[p]) visit(p); order.push(id); };
      Object.keys(recs).forEach(visit);
      for (const id of order) {
        const r = recs[id];
        const L = r.parent ? localOf(r, recs) : null;
        const pos = L?.mounted ? L.pos : r.pos ?? [0, 0, 0];
        const q = (L?.mounted ? L.q : null) ?? qNorm(r.q) ?? qFromYaw((L?.mounted ? L.yaw : r.yaw) ?? 0);
        const s = r.scale3 ?? (Number.isFinite(r.scale) ? [r.scale, r.scale, r.scale] : [1, 1, 1]);
        const components = { transform: { pos, q, scale: s } };
        for (const [k, v] of Object.entries(recordComponents(r))) if (v !== undefined) components[encName(k)] = v;
        if (r.parent?.to) components.parent = { to: enc(r.parent.to), ...(r.parent.socket ? { socket: r.parent.socket } : {}) };
        const res = call("create", { id: enc(id), ...(r.model ? { model: r.model } : {}), components });
        if (!res.ok) throw new Error(`seed ${id}: ${JSON.stringify(res.refused)}`);
      }
      return W;
    },
  };
  return W;
}

/** The world object behind a scratch world (for the authority's system door: forkCopy). */
export const worldObject = (W) => W.world();

/** A VIEW-form record ({model?, pos, …components flat}) as the fold holds it (`c`: {model?, transform, parent?, …components}, names encoded) — what seed()
 *  writes, read back without the authority: the suites run their fixtures through the editor as fold records (C7b). */
export function foldRecordOf(r, recs = null) {
  const L = r.parent ? localOf(r, recs) : null;   // a child's transform is LOCAL to its parent (as seed writes it)
  const pos = L?.mounted ? L.pos : r.pos ?? [0, 0, 0];
  const q = (L?.mounted ? L.q : null) ?? qNorm(r.q) ?? qFromYaw((L?.mounted ? L.yaw : r.yaw) ?? 0);
  const s = r.scale3 ?? (Number.isFinite(r.scale) ? [r.scale, r.scale, r.scale] : [1, 1, 1]);
  const c = Object.create(null);
  if (r.model) c.model = r.model;
  c.transform = { pos, q, scale: s };
  if (r.parent?.to) c.parent = { to: enc(r.parent.to), ...(r.parent.socket ? { socket: r.parent.socket } : {}) };
  for (const [k, v] of Object.entries(recordComponents(r))) if (v !== undefined && k !== 'model' && k !== 'parent') c[encName(k)] = JSON.parse(JSON.stringify(v));   // the view's flat components (its model and parent are written above)
  return c;
}

/** a request's ops, flattened (a batch's ops, or the one op) */
export const flat = (x) => {
  const list = Array.isArray(x) ? x : x?.ops ?? (x ? [x] : []);
  return list.filter(Boolean).flatMap((o) => (o.verb === "batch" ? o.args.ops : [o]));
};
