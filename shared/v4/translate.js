// shared/v4/translate.js — today's log → the v4 vocabulary, one entry at a time (protocol v4, Phase 1: shadow).
//
// Runs the engine's REAL fold (shared/fold.js) and, inside a physics epoch, its real sim (shared/sim.js) in their
// conformance order, and after every old entry emits the v4 entries that bring a v4 reader to the same world:
//   - a timeline record of the old entry as sent (intent: verb, args, actor, ts, from: old seq);
//   - a `launch` (kind sim) when a punt started motion, with the body's exact state;
//   - at most one state entry with the plain results (cause = that record);
//   - a rest result (actor `sim`, cause = the launch) whenever the sim brings a body to rest.
// It then checks — every entry, bit for bit — that the v4 blind fold agrees with the old world (her instant fold
// composed with her sim's rests), and that every body in flight agrees with the v4 sim layer. A divergence is
// reported, never patched over. The old log is never written; the output is a regenerable reading of it.
//
// Pure: no I/O. Server (the live shadow), tools and tests import it.

import { emptyState as v1Empty, foldEntry } from '../fold.js';
import * as eidosim from '../sim.js';
import { apply as v4apply, emptyState as v4Empty, FOLD_VERSION } from './fold.js';
import { simFold, digestOf, ENGINES } from './simlayer.js';

export const TRANSLATOR = 'translate@0.2';
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canonSorted = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));
const yawQ = (y) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];

/** Deliberate differences between the old world and its v4 reading. Everything else must agree exactly. */
export const DROPPED = {
  'entity.actor / entity.ts': 'last writer and time: in v4 these are the entry envelope, not state',
  'entity.born': 'incarnation seq: re-derived from the v4 log (the create\'s seq)',
  'mounts': 'bodies sitting: presence in v4, never history; their old entries survive in the timeline',
  'recentChat / chatTotal': 'the chat window: a timeline reader\'s job in v4, not world state',
  'light spelling': 'kind: "light" and comp.light are one Light component in v4 (Edit B treats them as aliases); which spelling an entity used stays in its timeline record',
};
const ENTITY_SKIP = new Set(['actor', 'ts', 'born']);
const KNOWN_ENT = new Set(['pos', 'yaw', 'q', 'scale', 'lib', 'kind', 'color', 'intensity', 'range', 'keep', 'day', 'comp', 'parent', 'placer']);
const KNOWN_WORLD = new Set(['entities', 'sky', 'terrain', 'grass', 'epoch', 'assets', 'roles', 'bans', 'behaviors', 'mounts', 'recentChat', 'chatTotal']);

/** What an old world MEANS in v4 terms. Anything unmapped is carried as `legacy:<key>`, never dropped. */
export function project(st) {
  const out = {};
  for (const [id, e] of Object.entries(st.entities ?? {})) {
    const c = {};
    c.transform = { pos: e.pos ?? [0, 0, 0], q: Array.isArray(e.q) ? e.q : yawQ(e.yaw ?? 0),
      scale: typeof e.scale === 'number' ? [e.scale, e.scale, e.scale] : (e.scale ?? [1, 1, 1]) };
    if (e.lib !== undefined) c.model = e.lib;
    if (e.kind === 'light') c.light = Object.fromEntries(['color', 'intensity', 'range', 'keep', 'day'].filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
    for (const [k, v] of Object.entries(e.comp ?? {})) c[k] = v;
    if (e.parent) c.parent = e.parent;
    if (e.placer) c.placer = { who: e.placer.id, ...(e.placer.sub ? { sub: e.placer.sub } : {}) };
    for (const [k, v] of Object.entries(e)) if (!KNOWN_ENT.has(k) && !ENTITY_SKIP.has(k)) c[`legacy:${k}`] = v;
    out[id] = c;
  }
  const w = {};
  for (const k of ['sky', 'terrain', 'grass']) if (st[k] != null) w[k] = st[k];
  for (const a of st.assets ?? []) w[`palette:${typeof a === 'string' ? a : a.path ?? JSON.stringify(a)}`] = typeof a === 'string' ? {} : a;
  for (const [k, v] of Object.entries(st.roles ?? {})) w[`roles:${k}`] = v;
  for (const [k, v] of Object.entries(st.bans ?? {})) w[`bans:${k}`] = v;
  for (const [k, v] of Object.entries(st.behaviors ?? {})) w[`behavior:${k}`] = v;
  for (const [k, v] of Object.entries(st)) if (!KNOWN_WORLD.has(k) && v != null) w[`legacy:${k}`] = v;
  if (st.epoch) w.sim = { engine: st.epoch.sim, build: ENGINES[st.epoch.sim]?.build ?? null, tickMs: st.epoch.tickMs };
  if (Object.keys(w).length) out['@world'] = w;
  // a copy, never references: the old fold mutates some records in place (bstate sets behaviors[id].state), and a
  // projection that aliased them would see "no change" and drop the update
  return clone(out);
}
function diff(prev, now) {
  const ops = [];
  for (const id of Object.keys(prev)) if (!(id in now)) ops.push({ verb: 'delete', args: { id } });
  for (const [id, comps] of Object.entries(now)) {
    if (!(id in prev)) { ops.push({ verb: 'create', args: { id, components: clone(comps) } }); continue; }
    for (const k of Object.keys(prev[id])) if (!(k in comps)) ops.push({ verb: 'delete', args: { id, component: k } });
    for (const [k, v] of Object.entries(comps)) if (!eq(prev[id][k], v)) ops.push({ verb: 'set', args: { id, component: k, value: clone(v) } });
  }
  return ops;
}

export class Translator {
  /** opts.check: false skips the per-entry self-check (each check re-projects the whole world). Use it only for a
   *  catch-up over a log tools/v4-test.ts already proves; check every live entry. */
  constructor(opts = {}) {
    this.checking = opts.check !== false;
    this.st = v1Empty(); this.sim = eidosim.emptySim(); this.v4 = v4Empty(); this.out = [];
    this.recorded = new Map(); this.restLogged = new Set(); this.launchSeq = {}; this.restTicks = {};
    this.stats = { in: 0, out: 0, state: 0, launches: 0, rests: 0, worldDivergences: 0, flightDivergences: 0, first: null, verbs: {} };
    this.prev = this.composed();
    this.started = false;
  }
  push_(e) { e.seq = this.out.length; this.out.push(e); v4apply(this.v4, e, () => null); return e.seq; }
  composed() {
    const out = project(this.st);
    for (const [id, p] of this.recorded) if (this.sim.bodies[id] && out[id]) out[id].transform = { ...out[id].transform, pos: p.slice() };
    if (this.sim.boxes) for (const c of Object.values(out)) if (typeof c.model === 'string' && this.sim.boxes[c.model]) c.physics = { shape: this.sim.boxes[c.model] };
    return out;
  }
  stepTo(tick) {
    const sim = this.sim;
    while (sim.epoch && !sim.epoch.foreign && sim.tick < tick) {
      const flying = Object.keys(sim.bodies).filter((id) => !sim.bodies[id].resting);
      if (!flying.length) { eidosim.advanceSim(sim, tick); break; }
      eidosim.advanceSim(sim, sim.tick + 1);
      for (const id of flying) if (sim.bodies[id]?.resting) this.restTicks[id] = sim.tick;
    }
  }
  logRests(ts) {
    const sim = this.sim;
    const fresh = Object.keys(sim.bodies).filter((id) => sim.bodies[id].resting && this.launchSeq[id] !== undefined && !this.restLogged.has(id))
      .sort((a, b) => this.restTicks[a] - this.restTicks[b]);
    for (const id of fresh) {
      const sf = simFold(this.out, () => null, ts);
      this.recorded.set(id, sim.bodies[id].p.slice()); this.restLogged.add(id);
      const now = this.composed(); const ops = diff(this.prev, now); this.prev = now;
      this.push_({ kind: 'state', actor: 'sim', ts, cause: this.launchSeq[id], verb: 'batch',
        args: { ops, sim: { rest: true, id, at: sim.bodies[id].p.slice(), tick: this.restTicks[id], digest: sf.sim ? digestOf(sf.sim) : null } } });
      this.stats.rests++;
    }
  }
  /** One old entry in; returns the v4 entries it produced and whether the readings still agree. */
  push(e) {
    const from = this.out.length;
    if (!this.started) {
      this.started = true;
      const g = e?.verb === 'genesis' ? e.args : { v: 1, dialect: 'eidoverse-log', implicit: true };
      this.push_({ kind: 'genesis', actor: 'world', verb: 'genesis', ts: e?.ts ?? 0, args: { v: 4, fold: FOLD_VERSION, translatedFrom: { ...g, translator: TRANSLATOR } } });
      if (e?.verb === 'genesis') return { entries: this.out.slice(from), ok: true };
    }
    if (e.verb === 'genesis') return { entries: [], ok: true };
    this.stats.in++; this.stats.verbs[e.verb] = (this.stats.verbs[e.verb] ?? 0) + 1;
    const sim = this.sim;
    if (sim.epoch) { this.stepTo(eidosim.tickOf(sim, e.ts)); this.logRests(e.ts); }
    foldEntry(this.st, e); eidosim.simEntry(sim, e, this.st);
    const say = e.verb === 'say';
    const tl = this.push_({ kind: 'timeline', actor: e.actor, ts: e.ts, verb: say ? 'say' : 'legacy', args: say ? clone(e.args) : { verb: e.verb, args: clone(e.args) }, from: e.seq });
    const b = sim.bodies[e.args?.id];
    if (e.verb === 'punt' && b && b.seq === e.seq) {
      this.launchSeq[e.args.id] = this.push_({ kind: 'sim', actor: e.actor, ts: e.ts, cause: tl, from: e.seq, verb: 'launch', args: { id: e.args.id, p: b.p.slice(), yaw: b.yaw, v: b.v.slice() } });
      this.restLogged.delete(e.args.id); this.stats.launches++;
    }
    for (const id of [...this.recorded.keys(), ...Object.keys(this.launchSeq)]) if (!sim.bodies[id]) { this.recorded.delete(id); this.restLogged.delete(id); delete this.launchSeq[id]; }
    const now = this.composed(); const ops = diff(this.prev, now);
    if (ops.length) { this.push_({ kind: 'state', actor: e.actor, ts: e.ts, cause: tl, from: e.seq, verb: ops.length === 1 ? ops[0].verb : 'batch', args: ops.length === 1 ? ops[0].args : { ops } }); this.stats.state++; }
    this.prev = now;
    const ok = this.checking ? this.check(e) : true;
    this.stats.out = this.out.length;
    return { entries: this.out.slice(from), ok };
  }
  check(e) {
    let ok = true;
    const v4view = Object.fromEntries(Object.entries(this.v4.entities).map(([id, x]) => [id, x.c]));
    if (canonSorted(v4view) !== canonSorted(this.prev)) { ok = false; this.stats.worldDivergences++; this.stats.first ??= { oldSeq: e.seq, verb: e.verb, kind: 'world' }; }
    const flying = Object.entries(this.sim.bodies).filter(([, b]) => !b.resting);
    if (flying.length) {
      const sf = simFold(this.out, () => null, e.ts);
      for (const [id, b] of flying) { const mine = sf.sim?.bodies[id];
        if (!mine || !eq(mine.p, b.p) || !eq(mine.v, b.v)) { ok = false; this.stats.flightDivergences++; this.stats.first ??= { oldSeq: e.seq, verb: e.verb, kind: 'flight', id }; } }
    }
    return ok;
  }
  /** Settle as her replaybench does — far past the last entry — and log what came to rest. */
  finish() {
    const sim = this.sim;
    if (sim.epoch && !sim.epoch.foreign) {
      this.stepTo(sim.tick + 100000);
      const end = Math.max(this.out.at(-1).ts, ...Object.values(this.restTicks).map((t) => sim.epoch.ts + t * sim.epoch.tickMs));
      this.logRests(end);
    }
    this.stats.out = this.out.length;
    return this.stats;
  }
}

/** The world as a v4 reader sees it, component-keyed, for comparisons and views. */
export const v4project = (s) => Object.fromEntries(Object.entries(s.entities).map(([id, e]) => [id, e.c]));
