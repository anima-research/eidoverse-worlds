// tools/v4/scratchdoor.ts — a scratch v4 world behind the real door, for the planner tests (tools/*-test.ts) that
// check the RESULT of an edit: seed the records a test reads (view form), send the planner's door requests, read the
// v4 state back as the view the planners read (shared/v4/record.js viewState). Same pattern as tools/v4/door-check.ts:
// request(openWorld(root, name), actor, tool, args), a `new` first to found the world (its founder is its owner).
// @ts-nocheck
import { scratch } from "./common.ts";
import { request, LAB_CATALOGUE } from "../../shared/v4/door.js";
import { openWorld } from "../../server/v4/disk.ts";
import { viewState } from "../../shared/v4/record.js";
import { enc, encName } from "../../shared/v4/names.js";
import { localOf } from "../../shared/hierarchy.js";
import { qNorm, qFromYaw } from "../../shared/rot.js";

let T = 1800000000000;
// the engine's catalogue is the library's GLB paths (server/v4/catalogue.ts); a scratch world names any path the tests
// use: the lab's measured models where they exist, else a model the door can name but not measure (no `size`)
const ANY_MODEL = Object.freeze({ get: (n) => LAB_CATALOGUE.get(n) ?? (typeof n === "string" && n ? { label: n, surfaces: [] } : undefined), list: (q) => LAB_CATALOGUE.list(q) });
const open = (root, name) => { const w = openWorld(root, name); w.catalogue = ANY_MODEL; return w; };
let n = 0;
const roots = new Map();

/** A fresh world in a scratch root (one root per tag), founded by `owner`. */
export function scratchWorld(tag = "edit", { owner = "olive", title = "scratch" } = {}) {
  if (!roots.has(tag)) roots.set(tag, scratch(tag));
  const root = roots.get(tag); const name = `w${++n}`;
  // one world object for the scratch world's life (its state is kept incrementally); the door's clock steps a second per
  // request so a long sweep stays inside the door's rate budget (60 entries / 10 s per actor)
  let w = null;
  const call = (tool, args = {}, actor = owner) => { T += 1000; process.env.V4_NOW = String(T); w ??= open(root, name); return request(w, actor, tool, args); };
  const founded = call("create-world", { title });
  if (!founded.ok) throw new Error(`scratch world: new refused: ${JSON.stringify(founded.refused)}`);
  const W = {
    name, root, owner,
    call,
    /** send one planned door request ({tool, args}); extra args (throughLock, dry, expect) ride along. */
    send: (req, extra = {}, actor = owner) => (req ? call(req.verb, { ...req.args, ...extra }, actor) : { ok: true, noop: true }),
    /** several planned requests as ONE gesture (shared/v4/ops.js batch semantics: one act). */
    sendAll: (reqs, extra = {}, actor = owner) => {
      const flat = reqs.filter(Boolean).flatMap((o) => (o.verb === "batch" ? o.args.ops : [o]));
      if (!flat.length) return { ok: true, noop: true };
      return flat.length === 1 ? W.send(flat[0], extra, actor) : call("batch", { ops: flat, ...extra }, actor);
    },
    state: () => (w ??= open(root, name)).state(),
    /** a stored blob (a published blueprint record) by its hash */
    getBlob: (h) => (w ??= open(root, name)).getBlob(h),
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
        for (const [k, v] of Object.entries(r.comp ?? {})) if (v !== undefined) components[encName(k)] = v;
        if (r.parent?.to) components.parent = { to: enc(r.parent.to), ...(r.parent.socket ? { socket: r.parent.socket } : {}) };
        const res = call("create", { id: enc(id), ...(r.lib ? { model: r.lib } : {}), components });
        if (!res.ok) throw new Error(`seed ${id}: ${JSON.stringify(res.refused)}`);
      }
      return W;
    },
  };
  return W;
}

/** a request's ops, flattened (a batch's ops, or the one op) */
export const flat = (x) => {
  const list = Array.isArray(x) ? x : x?.ops ?? (x ? [x] : []);
  return list.filter(Boolean).flatMap((o) => (o.verb === "batch" ? o.args.ops : [o]));
};
