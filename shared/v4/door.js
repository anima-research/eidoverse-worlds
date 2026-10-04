// The v4 door (lab). Every request is resolved here once; the log receives the request as sent (an `act` entry) and
// the plain results it produced (one `state` entry, `cause` = the act's seq). Replay never runs this file.
// PROTOCOL-v4 L7: every state write, from every path (tools, use handlers, undo, put, create-from, rests, the door's
// own follow-ups), is admitted by ONE function, `admit`, keyed on who asks, which components change (old and new),
// locks, where it lands, sanity and rate. Tool checks may only add to it. The only code that appends a state entry is
// `stateEntry`, and it takes only what `admit` returned.
// Ported from the v4 lab (code/v4-lab/door.js @ 11db981). Engine change: storage is injected. The lab's openWorld
// read and wrote files here; that part is server/v4/disk.js now, so this module has no node: imports and no
// process/Date of its own (callers pass the clock). Everything from `w.worldId` down is the lab's code unchanged.
import { readLog, fold, opsOf, applyOps, cloneState, checkEntry, checkIJSON, isEntityId, isComponent, isIdentity, jcs, sha256, worldIdOf, Malformed, PURGED, VERSION } from "./fold.js";
import { MODELS, COMPONENTS, PENDULUM } from "./catalogue.js";
import { validate, toolHelp, TOOLSPEC } from "./toolspec.js";
import { simFold, livePoses, digestOf, restEta, ENGINES, carried, worldPose } from "./simlayer.js";

// ---------- the model catalogue (engine, slice 2) ----------
// The lab's door read its own table (./catalogue.js). The engine's models are library paths measured from their GLBs
// (server/v4/catalogue.ts), so the catalogue is injected: io.catalogue = { get(name) → entry | undefined,
// list(query) → [name, entry][] }. An entry is { label, size?, box?, surfaces, solids?, sockets? }:
//   box      [[x,y,z], [x,y,z]] in the model's frame (a GLB's origin is wherever its author put it); absent → the lab's
//            convention, a size-box with the origin at the base centre;
//   surfaces [{y, x?: [min,max], z?: [min,max], inset?}] in the model's frame (measured flat zones carry x/z);
//   size     absent → a model this door can name but not measure (no placement help, no collisions, said so).
// request() sets CAT for the duration of one synchronous call; nothing in the door awaits, so calls can't interleave.
// own keys only: MODELS["constructor"] is Object (the lab door accepted model "constructor"; L1's no-prototype rule)
export const LAB_CATALOGUE = Object.freeze({ get: (n) => (Object.hasOwn(MODELS, n) ? MODELS[n] : undefined), list: (q) => Object.entries(MODELS).filter(([k, m]) => k.includes(q) || m.label.includes(q)) });
let CAT = LAB_CATALOGUE;
let THROUGH = false; // the request's through_lock flag, set by request() for one synchronous call (like CAT)
const modelOf = (name) => (typeof name === "string" ? CAT.get(name) : undefined);
const geomOf = (name) => { const m = modelOf(name); return m && m.size ? m : undefined; };
const boxOfM = (m) => m.box ?? [[-m.size[0] / 2, 0, -m.size[2] / 2], [m.size[0] / 2, m.size[1], m.size[2] / 2]];
/** Run fn with world w's catalogue in force (also for callers outside request(), e.g. a server's settle tick). */
export function withCatalogue(w, fn) { const prev = CAT; CAT = w.catalogue ?? LAB_CATALOGUE; try { return fn(); } finally { CAT = prev; } }

// ---------- storage ----------
const STATE = Symbol("admitted state write");
export const posAt = (e, i) => { if (e && typeof e === "object") Object.defineProperty(e, "seq", { value: i, enumerable: false, configurable: true }); return e; };
/**
 * A world over injected storage.
 * @param {{ name: string, entries: any[], getBlob: (h: string) => any, putBlob: (v: any) => string,
 *   writeLine: (line: string) => void, now: () => number,
 *   presence?: { bodies: object, holds: object }, savePresence?: (p: object) => void }} io
 *   entries: what readLog returned for the log so far, each with its seq attached by posAt (unenumerable).
 *   getBlob must verify a blob against its name and throw if it doesn't match (§2.2).
 *   writeLine appends one already-checked line (no trailing LF) to durable storage.
 *   now: the door's clock in ms (§2.1 ts); presence: the unlogged presence plane (P1, P2).
 */
export function worldOf(io) {
  const { name, entries, getBlob, putBlob } = io;
  const w = { name, entries, getBlob, putBlob, exists: entries.length > 0, catalogue: io.catalogue ?? null };
  w.worldId = entries[0] && !(entries[0] instanceof Malformed) ? worldIdOf(entries[0]) : null;
  w.now = io.now;
  // the presence plane: bodies and holds. Transient, never logged (P1, P2)
  w.presence = io.presence ?? { bodies: {}, holds: {} };
  w.savePresence = () => io.savePresence?.(w.presence);
  let cache = null; // the folded state is a view, rebuilt when the log grows (callers never mutate it)
  w.state = () => (cache?.n === entries.length ? cache.st : (cache = { n: entries.length, st: fold(entries) }).st);
  w.sim = () => simFold(entries, w.now());
  w.stateAt = (seq) => fold(entries, { until: seq });
  // The door re-reads every line it writes with the strict reader: it can never write what a reader would refuse.
  // §2.1: ts = the door's admission time, an integer that never decreases along the log (a clock that steps back,
  // an NTP slew or a VM restore, must not make the door write a line every reader refuses)
  const render = (e, seq) => {
    let lastTs = 0; for (let i = entries.length - 1; i >= 0; i--) if (isE(entries[i]) && Number.isInteger(entries[i].ts)) { lastTs = entries[i].ts; break; }
    const line = JSON.stringify({ ...(e.kind === "genesis" ? {} : { world: w.worldId }), ...e, ts: Math.max(Math.floor(w.now()), lastTs) });
    const [parsed] = readLog(line); let bad = parsed instanceof Malformed ? parsed : null;
    if (!bad) try { checkEntry(parsed, seq); } catch (x) { bad = x; }
    return { line, parsed, bad };
  };
  // Would these entries, appended in this order, all be lines a reader accepts? Checked BEFORE any is written, so a
  // request is all or nothing (an act is never left without its result, 33 C2). A size or depth cap is a refusal.
  w.fits = (...es) => { for (const [k, e] of es.entries()) { const { bad } = render(e, entries.length + k); if (!bad) continue;
    if (/^cap-/.test(bad.code)) refuse("too-big", `that would be a ${bad.code === "cap-size" ? `${bad.detail}-byte` : "too deeply nested"} ${e.kind} entry; a log line is at most 1 MiB, 64 deep (§2.4)`, "split it into smaller requests, or put big data in a blob and store its hash");
    throw new Error(`door bug: would write a malformed entry (${bad.code} ${bad.detail})`); } };
  w.append = (e, token) => {
    if (e.kind === "state" && token !== STATE) throw new Error("door bug: a state entry must come from stateEntry (L7: one gate)");
    w.fits(e); const { line, parsed } = render(e, entries.length); const seq = entries.length;
    entries.push(posAt(parsed, seq)); io.writeLine(line);
    if (e.kind === "genesis") w.worldId = worldIdOf(parsed);
    w.exists = true; return seq;
  };
  return w;
}
const isE = (e) => e && !(e instanceof Malformed) && typeof e === "object";
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// PROTOCOL-v4 §5 (locks: decided): `lock` is v1's lock with v1's meaning, so an old log's locks carry over untranslated.
// A lock is on when its value is truthy, exactly as v1 read it (`comp.lock`); the door itself only ever writes `true`.
// A purged value is absent(purged), not a lock. The lab's `pinned` and top-level `locked` are retired.
const lockedC = (c) => { const v = c?.lock; return v !== undefined && v !== PURGED && !!v; };
const r3 = (n) => Math.round(n * 1000) / 1000;
const setOp = (id, comp, value) => ({ verb: "set", id, comp, value });
const delOp = (id, comp) => (comp === undefined ? { verb: "delete", id } : { verb: "delete", id, comp });
const createOps = (id, comps) => [{ verb: "create", id }, ...Object.entries(comps).map(([k, v]) => setOp(id, k, v))];
const scratch = (st, ops) => applyOps(st, ops);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "thing";

// ---------- math (yaw-only rotation is enough for placement in this lab; q is stored whole) ----------
const yawQ = (y) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
const qYaw = (q) => 2 * Math.atan2(q[1], q[3]);
function qmul(a, b) {
  return [a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1], a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
          a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3], a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
}
function qrot(q, v) {
  const [x, y, z, w] = q; const [vx, vy, vz] = v;
  const tx = 2*(y*vz - z*vy), ty = 2*(z*vx - x*vz), tz = 2*(x*vy - y*vx);
  return [vx + w*tx + (y*tz - z*ty), vy + w*ty + (z*tx - x*tz), vz + w*tz + (x*ty - y*tx)];
}
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];

function worldT(st, id, depth = 0) {
  const e = st.entities[id]; if (!e) return null;
  const t = { ...COMPONENTS.transform.defaults, ...(e.c.transform ?? {}) };
  const p = e.c.parent?.to;
  if (!p || depth > 32 || !st.entities[p]) return t;
  const pt = worldT(st, p, depth + 1);
  const off = qrot(pt.q, t.pos.map((v, i) => v * pt.scale[i]));
  return { pos: pt.pos.map((v, i) => v + off[i]), q: qmul(pt.q, t.q), scale: t.scale.map((v, i) => v * pt.scale[i]) };
}
function localFrom(st, parentId, wt) {
  const pt = worldT(st, parentId);
  const d = qrot(qinv(pt.q), wt.pos.map((v, i) => v - pt.pos[i]));
  return { pos: d.map((v, i) => r3(v / pt.scale[i])), q: qmul(qinv(pt.q), wt.q).map(r3), scale: wt.scale.map((v, i) => r3(v / pt.scale[i])) };
}
function aabb(st, id) {
  const e = st.entities[id]; const m = geomOf(e?.c.model); if (!m) return null;
  const t = worldT(st, id); const [lo0, hi0] = boxOfM(m);
  const corners = [];
  for (const x of [lo0[0], hi0[0]]) for (const y of [lo0[1], hi0[1]]) for (const z of [lo0[2], hi0[2]]) {
    const p = qrot(t.q, [x * t.scale[0], y * t.scale[1], z * t.scale[2]]);
    corners.push(p.map((v, i) => v + t.pos[i]));
  }
  const min = [0, 1, 2].map((i) => Math.min(...corners.map((c) => c[i])));
  const max = [0, 1, 2].map((i) => Math.max(...corners.map((c) => c[i])));
  return { min, max };
}
function solids(st, id) {
  const e = st.entities[id]; const m = geomOf(e?.c.model); if (!m) return [];
  if (!m.solids) { const b = aabb(st, id); return b ? [b] : []; }
  const t = worldT(st, id);
  return m.solids.map(([lo, hi]) => { const cs = [];
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) { const p = qrot(t.q, [x * t.scale[0], y * t.scale[1], z * t.scale[2]]); cs.push(p.map((v, i) => v + t.pos[i])); }
    return { min: [0, 1, 2].map((i) => Math.min(...cs.map((c) => c[i]))), max: [0, 1, 2].map((i) => Math.max(...cs.map((c) => c[i]))) }; });
}
// Oriented boxes + the separating-axis test (F21): world-AABBs of rotated solids fatten into false overlaps.
function obbs(st, id) {
  const e = st.entities[id]; const m = geomOf(e?.c.model); if (!m) return [];
  const t = worldT(st, id); const boxes = m.solids ?? [boxOfM(m)];
  const ax = [qrot(t.q, [1, 0, 0]), qrot(t.q, [0, 1, 0]), qrot(t.q, [0, 0, 1])];
  return boxes.map(([lo, hi]) => { const lc = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2 * t.scale[i]);
    const off = qrot(t.q, lc); return { c: t.pos.map((v, i) => v + off[i]), ax, h: [0, 1, 2].map((i) => Math.abs(hi[i] - lo[i]) / 2 * Math.abs(t.scale[i])) }; });
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function satDepth(A, B) { // smallest penetration over the 15 axes; <= 0 means separated
  const d = B.c.map((v, i) => v - A.c[i]); let best = Infinity;
  const axes = [...A.ax, ...B.ax]; for (const a of A.ax) for (const b of B.ax) { const c = crs(a, b); const n = Math.hypot(...c); if (n > 1e-6) axes.push(c.map((v) => v / n)); }
  for (const L of axes) { const ra = A.h.reduce((t, h, i) => t + h * Math.abs(dot(A.ax[i], L)), 0), rb = B.h.reduce((t, h, i) => t + h * Math.abs(dot(B.ax[i], L)), 0);
    const p = ra + rb - Math.abs(dot(d, L)); if (p < best) best = p; if (best <= 0) return best; }
  return best;
}
const boxToObb = (b) => ({ c: [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2), ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], h: [0, 1, 2].map((i) => (b.max[i] - b.min[i]) / 2) });
const hits = (box, st, id, eps) => { const B = boxToObb(box); return obbs(st, id).some((o) => satDepth(B, o) > eps); };
const overlap = (a, b, eps = 0.01) => [0, 1, 2].every((i) => a.min[i] < b.max[i] - eps && b.min[i] < a.max[i] - eps);
const descendants = (st, id) => Object.keys(st.entities).filter((k) => {
  let p = st.entities[k].c.parent?.to, n = 0; while (p && n++ < 32) { if (p === id) return true; p = st.entities[p]?.c.parent?.to; } return false;
});
const ancestors = (st, id) => { const out = []; let p = st.entities[id]?.c.parent?.to, n = 0; while (p && n++ < 32) { out.push(p); p = st.entities[p]?.c.parent?.to; } return out; };

function surfacesOf(st, id) {
  const e = st.entities[id]; const m = geomOf(e?.c.model); const b = aabb(st, id); if (!m || !b) return [];
  const t = worldT(st, id);
  return (m.surfaces ?? []).map((s, i) => { const k = s.inset ?? 0;
    if (s.x && s.z) { // a measured zone: its own rectangle, carried into the world (the axis-aligned box of its corners)
      const cs = [[s.x[0], s.z[0]], [s.x[0], s.z[1]], [s.x[1], s.z[0]], [s.x[1], s.z[1]]].map(([x, z]) => { const p = qrot(t.q, [x * t.scale[0], s.y * t.scale[1], z * t.scale[2]]); return [p[0] + t.pos[0], p[2] + t.pos[2]]; });
      return { id, level: i, y: t.pos[1] + s.y * t.scale[1], min: [Math.min(...cs.map((c) => c[0])) + k, Math.min(...cs.map((c) => c[1])) + k], max: [Math.max(...cs.map((c) => c[0])) - k, Math.max(...cs.map((c) => c[1])) - k] }; }
    return { id, level: i, y: t.pos[1] + s.y * t.scale[1], min: [b.min[0] + k, b.min[2] + k], max: [b.max[0] - k, b.max[2] - k] }; });
}
function supportBelow(st, x, z, y, ignore = new Set()) {
  let best = { y: 0, id: "ground" };
  for (const id of Object.keys(st.entities)) {
    if (ignore.has(id)) continue;
    for (const s of surfacesOf(st, id))
      if (x >= s.min[0] && x <= s.max[0] && z >= s.min[1] && z <= s.max[1] && s.y <= y + 0.02 && s.y > best.y) best = { y: s.y, id };
  }
  return best;
}

// Supported anywhere under its footprint (the engine's rule: a box rests on a top its footprint overlaps), not just
// under its centre — so a thing physics left resting is never called floating by the door (playtest 22, F5).
function supportUnder(st, b, ignore) {
  let best = { y: 0, id: "ground" };
  for (const id of Object.keys(st.entities)) { if (ignore.has(id)) continue;
    for (const s of surfacesOf(st, id)) if (b.max[0] > s.min[0] && b.min[0] < s.max[0] && b.max[2] > s.min[1] && b.min[2] < s.max[1] && s.y <= b.min[1] + 0.02 && s.y > best.y) best = { y: s.y, id }; }
  return best;
}

// ---------- rights ----------
const RANK = { none: -1, visitor: 0, builder: 1, owner: 3 };
const ownersOf = (st) => { const c = st.entities?.["@world"]?.c ?? {}; return Object.keys(c).filter((k) => k.startsWith("roles:") && c[k]?.role === "owner"); };
// §2.3: an empty owner list means NOBODY above visitor. A world may declare a default role for strangers
// (`default-role`, what a v1 `roles['*']` becomes); absence means visitor.
function roleOf(st, actor) {
  const c = st.entities?.["@world"]?.c; if (!c) return "none";
  let r = c[`roles:${actor}`]?.role ?? c["default-role"]?.role ?? "visitor";
  if (RANK[r] === undefined) r = "visitor";
  return !ownersOf(st).length && RANK[r] > RANK.visitor ? "visitor" : r;
}
const opsQuiet = (e) => { try { return opsOf(e); } catch { return []; } };
// ---------- views over the log: who did what (L2: derived, never stored) ----------
// Who a state entry is "by": its cause's actor (the person whose request it was), and whose RIGHTS admitted it. Those
// differ for a `use`: the visitor pulled the lever, but the handler's author's rights made the change, and the act
// records that author (capability.author). Entries with no act for a cause (rests, genesis-era) are their own actor's.
function entryBy(w, e) {
  const c = w.entries[e.cause];
  const by = isE(c) && c.kind === "act" ? c.actor : e.actor;
  return { seq: e.seq, by, rights: (isE(c) && c.kind === "act" && c.body?.capability?.author) || by };
}
// The creator of a thing (comp undefined), or of component `comp` on it, in its CURRENT life: the entry that made it
// present after it was last absent. null if it isn't present now. { seq, by, rights }.
// The state entries that may touch `id`, newest first. A live world (server/v4) keeps an index id → seqs so these
// views cost the thing's own history, not the whole log's; without one (the suites) every entry is a candidate.
function* backward(w, id) {
  if (w.touching) { const a = w.touching(id); for (let k = a.length - 1; k >= 0; k--) yield a[k]; return; }
  for (let i = w.entries.length - 1; i >= 0; i--) yield i;
}
export function creatorOf(w, id, comp) {
  let found = null;
  for (const i of backward(w, id)) { const e = w.entries[i]; if (!isE(e) || e.kind !== "state") continue;
    const ops = opsQuiet(e);
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== id) continue;
      if (comp === undefined) { if (o.verb === "create") return entryBy(w, e); if (o.verb === "delete" && o.comp === undefined) return null; continue; }
      if (o.verb === "set" && o.comp === comp) found = e;
      else if ((o.verb === "delete" && (o.comp === comp || o.comp === undefined)) || o.verb === "create") return found && entryBy(w, found); } }
  return found && entryBy(w, found);
}
// Who last set (or deleted) component `comp` on a thing: { seq, by, rights, deleted } or null if nobody ever has.
export function lastSetterOf(w, id, comp) {
  for (const i of backward(w, id)) { const e = w.entries[i]; if (!isE(e) || e.kind !== "state") continue;
    const ops = opsQuiet(e);
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== id || o.comp !== comp || o.verb === "create") continue;
      return { ...entryBy(w, e), deleted: o.verb === "delete" }; } }
  return null;
}
// Who made a thing: the view inspect shows (no stored `placer`).
const madeBy = (w, id) => creatorOf(w, id)?.by ?? null;

// ---------- the door ----------
class Refusal extends Error { constructor(code, reason, teach, extra = {}) { super(reason); Object.assign(this, { code, reason, teach, ...extra }); } }
const refuse = (code, reason, teach, extra) => { throw new Refusal(code, reason, teach, extra); };
const RESERVED = new Set(["door", "sim", "world"]); // the door's own identities: a request can never be stamped as one

// A request as sent must itself be I-JSON (it is logged as the act). -0 is normalised; non-finite is refused.
function wire(args) {
  const walk = (v) => { if (typeof v === "number" && !Number.isFinite(v)) refuse("shape", `numbers must be finite, got ${v}`, "I-JSON: finite numbers only");
    if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(args); const out = JSON.parse(JSON.stringify(args ?? {}));
  try { checkIJSON(out); } catch (x) { refuse("shape", `the request isn't I-JSON (${x.code})`, "RFC 7493: UTF-8, no duplicate keys, finite numbers, integers within 2^53"); }
  return out;
}

export function request(w, actor, tool, args = {}) {
  const prevCat = CAT, prevThrough = THROUGH; CAT = w.catalogue ?? LAB_CATALOGUE; THROUGH = false;
  try {
    if (!isIdentity(actor) || RESERVED.has(actor)) refuse("identity", `'${actor}' isn't an identity the door can stamp`, "identities are a–z, 0–9 and '-', up to 64 (§2.3); door, sim and world are the door's own");
    const h = TOOLS[tool];
    if (h && !w.exists && !["new", "help"].includes(tool)) refuse("no-world", `there is no world called '${w.name}' yet`, `new {title: '…'} founds it (you become its owner); or pick a world that exists`);
    if (h && w.exists && w.state().status !== "ok") refuse("unreadable", `this world's log folds to '${w.state().status}'`, "the door won't write to a log its own reader refuses");
    if (h && w.exists) settleSim(w);
    if (!h) refuse("unknown-tool", `there is no '${tool}'`, "help lists every tool", { didYouMean: guess(tool, Object.keys(TOOLS)) });
    args = wire(args);
    // through_lock (§5) is a flag on any request, not an argument of one tool: checked here, then admit reads it
    const { through_lock, ...plain } = args;
    if (through_lock !== undefined && typeof through_lock !== "boolean") refuse("shape", `through_lock is true or false, got ${JSON.stringify(through_lock)}`, "send through_lock: true to act through a lock you may remove");
    THROUGH = through_lock === true;
    const bad = validate(tool, plain); if (bad) { const { code, reason, teach, ...rest } = bad; refuse(code, reason, teach, rest); }
    if (tool === "create" && args.place) { const b2 = validate("place", { ...args.place, id: "x" }); if (b2) { const { code, reason, teach, ...rest } = b2; refuse(code, `place: ${reason}`, teach, rest); } }
    const r = h(w, actor, args);
    if (r && r.refused && !r.refused.teach) r.refused.teach = toolHelp(tool) ? `help {tool: '${tool}'} shows its arguments with examples` : "help lists every tool";
    return r;
  } catch (e) {
    if (e instanceof Refusal) { const { code, reason, teach, ...rest } = e; return { ok: false, refused: { code, reason, teach: teach || (TOOLSPEC[tool] ? `help {tool: '${tool}'} shows its arguments with examples` : "help lists every tool"), ...pick(rest) } }; }
    throw e;
  } finally { CAT = prevCat; THROUGH = prevThrough; }
}
const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !["message", "stack"].includes(k)));
function guess(s, opts) {
  const d = (a, b) => { const m = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i-1][j] + 1, m[i][j-1] + 1, m[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)); return m[a.length][b.length]; };
  const toks = (x) => String(x).toLowerCase().split(/[-_\s/:]+/).filter(Boolean);
  const share = (o) => { const a = toks(s), b = toks(o); return a.filter((t) => b.some((u) => u.startsWith(t) || t.startsWith(u))).length; };
  return opts.map((o) => [o, d(String(s), o) - 2 * share(o)]).sort((a, b) => a[1] - b[1]).filter(([o, n]) => n <= 3 || share(o) >= Math.max(1, toks(s).length - 1)).slice(0, 3).map(([o]) => o);
}

// ---------- L7: the one gate ----------
// who = { actor, cap? }. With no cap the asker's own role decides. A cap is a scoped capability the request names:
//   reaction — a `use` exercises a handler; it may change only the component the handler names, on that thing, and
//              only while the handler's author could still change it themselves (the cause chain records both);
//   handle   — a settlement of something you hold (physics.who decides who may), transform/parent of that thing only;
//   rest     — the engine's word on a launched body: transform/parent of that body, and it must equal the engine's;
//   door     — the door's own follow-up to physics (set down what lost its support, attach a rest, return a lost thing);
//   founding — the `new` act's first write to @world, by an owner named in genesis, once.
// What a lock guards (§5, mirroring v1's matrix, tools/locktest.ts): nothing may MOVE, REPLACE or REMOVE a locked thing
// or anything attached to it. Move = transform or parent (v1 place, mount, punt); replace = model (v1 spawn/light onto
// its id); remove = deleting the thing. Everything that doesn't relocate it stays open, as in v1: labels, lights,
// reactions, sockets, `use`, sitting on it, and motion (v1's matrix keeps motion open: "sit / use / motion / other comps
// all stay open while locked"; v4's motions, pendulum/spin/bob, animate a thing in place and never carry it away) and
// physics (setting it moves nothing; picking a locked thing up is refused at grab). The lab's pin also guarded motion
// and physics (research 25d H1 called motion on a pin "a pinned thing now visibly moves"); §5 chose v1's meaning.
const LOCK_GUARDED = new Set(["transform", "parent", "model"]);
const RATE = { n: 60, ms: 10000 };
class Admitted { constructor(who, ops, after) { this.who = who; this.ops = ops; this.after = after; Object.freeze(this); } }
// L7 rate, per actor, over EVERYTHING the actor makes the log hold (acts and says), by the door's clock. One function:
// admit calls it for state writes, and every word that logs without a state write (say, grab's lift, throw, drop, a
// teleport) calls it before appending. The lab has no agents (`for` is unwritten until keys, L4), so "that actor's
// agents" is the actor alone here. Refusals aren't logged, so they cost the door, not the log (door practice).
function rateCheck(w, actor) {
  if (w.leaving === actor) return; // a disconnect's settlement is the door's duty, not the leaver's request: never rate-refused
  const now = w.now(); let n = 0; for (let i = w.entries.length - 1; i >= 0 && n <= RATE.n; i--) { const e = w.entries[i];
    if (isE(e) && Number.isInteger(e.ts) && now - e.ts > RATE.ms) break; // ts never decreases: everything earlier is older (engine: the lab scanned the whole log for a quiet actor)
    if (isE(e) && (e.kind === "act" || e.kind === "say") && e.actor === actor) n++; }
  if (n >= RATE.n) refuse("rate", `${actor} has made ${n} entries in ${RATE.ms / 1000} s`, "slow down; batch {ops} counts as one");
}
function admit(w, st, who, ops) {
  const { actor, cap } = who;
  if (!cap || cap.kind === "reaction" || cap.kind === "handle") rateCheck(w, actor);
  if (!ops.length) refuse("nothing", "that changes nothing", "");
  const role = roleOf(st, actor);
  const keysMade = new Set(); // keyed components this very write brings into being (their creator is the asker)
  // L6 (33 F1): a launched thing belongs to the engine until it rests. No write may touch it in flight except its rest
  // (cap rest) or the door's own follow-ups; an epoch cut (a write to @world.sim) may freeze it (P6, force).
  const sf = st.entities["@world"]?.c.sim && !(cap && ["rest", "door"].includes(cap.kind)) && !ops.some((o) => o.id === "@world" && o.comp === "sim") ? w.sim() : null;
  const inFlight = (id) => !!(sf?.launched[id] && sf.sim?.bodies[id] && !sf.sim.bodies[id].resting);
  let s = st; const norm = []; const made = new Set(); // a lock guards what happens after it, not the write that creates the thing
  ops.forEach((raw, i) => {
    const { verb, ...rest } = raw; const op = { verb, ...shapeOneOrRefuse(verb, rest, i) };
    if ("value" in op) op.value = unNegZero(op.value); // I-JSON has no -0 (an engine can make one); the same number, written as 0
    const at = `${op.id}${op.comp !== undefined ? "." + op.comp : ""}`;
    if ("value" in op) { try { checkIJSON(op.value); } catch (x) { refuse("shape", `${at}: the value isn't I-JSON (${x.code} ${x.detail})`, "finite numbers, integers within 2^53, no -0"); }
      if (jcs(op.value).length > 65536) refuse("too-big", `${at} is ${jcs(op.value).length} bytes; the door keeps values under 64 KiB`, "put big data in a blob and store its hash"); }
    const e = s.entities[op.id];
    if (verb === "create") { if (e) refuse("exists", `'${op.id}' already exists`, "choose another id, or leave id out and the door mints one"); }
    else if (!e) refuse("not-found", `no thing called '${op.id}'`, "look lists what's here", { didYouMean: guess(op.id, Object.keys(s.entities)) });
    else if (op.verb === "delete" && op.comp === undefined && op.id === "@world") refuse("world", "@world can't be deleted", "§2.3: delete or change its components instead (owners only)");
    else if (op.verb === "delete" && op.comp !== undefined && !(op.comp in e.c)) refuse("not-found", `${op.id} has no ${op.comp}`, `it has: ${Object.keys(e.c).join(", ")}`);
    else if (op.verb === "set" && !("value" in op)) refuse("shape", `set ${at} needs a value`, "");
    rights(w, st, s, who, role, op, at);
    keyRights(w, st, s, who, op, at, keysMade);
    if (inFlight(op.id)) refuse("in-flight", `${op.id} is in flight: the engine has it until it comes to rest`, "wait (or catch it: grab {id}); L6: no write may touch a launched thing before its rest");
    if (op.id === "@world" && op.comp === "lock" && op.verb === "set") refuse("world", "@world can't be locked", "§5: lock the things in it instead");
    // locks: the thing's own lock as of this op; its ancestors' locks as of before this write (what was attached then)
    if (op.verb === "create") made.add(op.id);
    else if (!made.has(op.id) && cap?.kind !== "rest" && (op.comp === undefined || LOCK_GUARDED.has(op.comp))) { // a rest is the engine's word on a released thing: locks guard authored writes
      const own = lockedC(s.entities[op.id]?.c) ? op.id : null; const anc = ancestors(st, op.id).find((k) => lockedC(st.entities[k]?.c));
      const k = own ?? anc;
      if (k) lockCheck(w, st, who, role, k, op, at); }
    s = applyOps(s, [op]); norm.push(op);
  });
  for (const op of norm) if (op.verb === "set") valueCheck(s, op); // against the state the whole write leaves (parents may come later in a batch)
  if (ownersOf(st).length && !ownersOf(s).length) refuse("last-owner", "that would leave this world with no owner", "§2.3: add the new owner's role first (set {id: '@world', component: 'roles:<them>', value: {role: 'owner'}}), then change yours");
  if (cap?.kind === "rest") restCheck(w, cap, s);
  return new Admitted(who, norm, s);
}
// A lock binds everyone, the locker and owners included (§5). `through_lock: true` on the request lets anyone who may
// remove that lock act through it, and the log records only the edit (the act carries the request as sent, flag and
// all). It covers the asker's OWN writes: a capability (a handler's author, a hand, the door's own follow-ups) never
// acts through a lock. Who may remove a lock is whoever may delete the component: builders and owners (L7 rights).
function lockCheck(w, st, who, role, k, op, at) {
  const mayUnlock = !who.cap && RANK[role] >= RANK[rankNeeded({ id: k, comp: "lock" })];
  if (THROUGH && mayUnlock) return;
  const by = lastSetterOf(w, k, "lock"); const whose = by && !by.deleted ? ` (locked by ${by.by} at ${by.seq})` : "";
  const what = k === op.id ? `${op.id} is locked${whose}, so ${at} can't change` : `${op.id} is attached to ${k}, which is locked${whose}, so ${at} can't change`;
  const teach = THROUGH && who.cap ? "through_lock covers your own edits, not a handler or a held thing; unlock it first"
    : mayUnlock ? `send the same request with through_lock: true, or unlock it first: delete {id: '${k}', component: 'lock'}. A lock stops accidents; any builder may lift it, and history shows who did`
    : `a builder or owner can unlock it (delete {id: '${k}', component: 'lock'}); you are ${role}`;
  refuse("locked", what, teach, { lock: k });
}
const unNegZero = (v) => (Object.is(v, -0) ? 0 : Array.isArray(v) ? v.map(unNegZero) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unNegZero(x)])) : v);
function shapeOneOrRefuse(verb, op, i) {
  if (!["create", "set", "delete"].includes(verb)) refuse("shape", `op ${i}: '${verb}' isn't a state operation`, "create, set and delete (batches are flat)");
  if (!isEntityId(op.id)) refuse("shape", `'${op.id}' isn't an entity id`, "§2.3: a–z, 0–9 and '-', up to 64, or @world", { didYouMean: guess(String(op.id), []) });
  if ((verb === "set" || op.comp !== undefined) && !isComponent(op.comp)) refuse("shape", `'${op.comp}' isn't a component name`, "§2.3: [a-z][a-z0-9-]*, optionally <domain>/ first, @<n> version and :<key> after (ASCII only)", { didYouMean: guess(String(op.comp), Object.keys(COMPONENTS)) });
  const out = { id: op.id }; if (op.comp !== undefined) out.comp = op.comp; if (verb === "set" && "value" in op) out.value = op.value;
  return out;
}
// L7 keys rights on the component, not on the word that carried it. On @world, adding to the shared library is a
// builder's act (publish); everything else there (roles, bounds, physics, the world's name) is the owner's.
const rankNeeded = (op) => (op.id !== "@world" ? "builder" : op.comp?.startsWith("library:") ? "builder" : "owner");
function rights(w, st, s, who, role, op, at) {
  const { actor, cap } = who; const need = rankNeeded(op);
  if (!cap) { if (RANK[role] < RANK[need]) refuse("rights", `changing ${at} needs ${need}; you are ${role}`, `ask the world's owner for ${need} rights (say {text, to: <owner>}); help shows your role`); return; }
  if (!cap.ids.includes(op.id) || !cap.comps.includes(op.comp)) refuse("rights", `${cap.kind === "reaction" ? `the '${cap.action}' handler` : cap.kind} may change only ${cap.comps.join("/")} of ${cap.ids.join(", ")}, not ${op.verb} ${at}`, "a capability is scoped to what it names");
  if (cap.kind === "reaction" && RANK[roleOf(st, cap.author)] < RANK[need]) refuse("rights", `'${cap.action}' was set up by ${cap.author}, who can't change ${at} any more`, "ask someone with the rights to set the reactions again");
  if (cap.kind === "handle") { const ph = st.entities[op.id]?.c.physics; const n = ph?.who ?? "builder";
    if (ph?.kind !== "dynamic") refuse("not-dynamic", `${op.id} isn't something you can carry`, "");
    if (RANK[role] < RANK[n]) refuse("rights", `only a ${n} may move ${op.id} by hand; you are ${role}`, "ask the owner to set physics.who"); }
  if (cap.kind === "founding") { const g = w.entries[0]; if (!g.body.owners?.includes(actor) || w.entries.some((e) => isE(e) && e.kind === "state")) refuse("rights", "founding writes happen once, by an owner genesis names", ""); }
}
// §5 / L7: a KEYED component (`<name>:<key>`, an instance such as library:<hash> or roles:<id>) that exists may be
// changed or deleted only by its creator (creatorOf, a view over the log: whose rights first made this life of the key)
// or by an owner. Making a new key needs only the component's ordinary rank. A capability changes it with the rights it
// carries: a handler with its author's. The door's own scoped follow-ups (rest, door, handle, founding) touch no keys
// that someone else made; founding makes roles:<founder>. A whole-entity delete is NOT gated here (see note 34).
const isKeyed = (comp) => typeof comp === "string" && comp.includes(":");
function keyRights(w, st, s, who, op, at, keysMade) {
  if (!isKeyed(op.comp) || op.verb === "create") return;
  const key = `${op.id}\u0000${op.comp}`;
  const present = s.entities[op.id] && op.comp in s.entities[op.id].c;
  if (!present) { if (op.verb === "set") keysMade.add(key); return; } // a new life of the key: the asker makes it
  if (keysMade.has(key)) return; // made earlier in this same write
  const { actor, cap } = who; if (cap && cap.kind !== "reaction") return;
  const holder = cap?.kind === "reaction" ? cap.author : actor;
  if (RANK[roleOf(st, holder)] >= RANK.owner) return;
  const c = creatorOf(w, op.id, op.comp);
  if (c && c.rights === holder) return;
  refuse("rights", `${at} is ${c ? c.rights : "nobody's on record"}'s${c ? ` (made at ${c.seq})` : ""}; only its creator or an owner may ${op.verb === "delete" ? "delete" : "change"} it`,
    op.comp.startsWith("library:") ? "publish your own version: it gets its own key" : `make your own instance (${op.comp.split(":")[0]}:<another key>), or ask ${c?.rights ?? "an owner"}`);
}
// Sanity and shape of the values the door's own engine reads (what the change IS, not which word carried it).
function valueCheck(s, { id, comp, value: v }) {
  const at = `${id}.${comp}`; const obj = v && typeof v === "object" && !Array.isArray(v);
  const nums = (a, n, lim = 1e5) => Array.isArray(a) && a.length === n && a.every((x) => typeof x === "number" && Math.abs(x) <= lim);
  if (comp === "transform") { if (!obj || !nums(v.pos, 3) || !nums(v.q, 4, 1.0001) || !nums(v.scale, 3, 1e3) || Object.keys(v).some((k) => !["pos", "q", "scale"].includes(k)))
    refuse("shape", `${at} must be {pos: [x,y,z], q: [x,y,z,w], scale: [x,y,z]}, finite and within bounds`, "pos within ±100 km, q a rotation, scale within ±1000"); }
  if (comp === "parent") { if (!obj || typeof v.to !== "string") refuse("shape", `${at} must be {to: <id>}`, "");
    if (!s.entities[v.to]) refuse("not-found", `no thing called '${v.to}'`, "", { didYouMean: guess(v.to, Object.keys(s.entities)) });
    if (v.to === id || ancestors(s, v.to).includes(id) || ancestors(s, id).length >= 32) refuse("loop", `${id} can't be inside ${v.to}: that makes a loop`, ""); }
  if (comp === "model" && !modelOf(v)) refuse("shape", `no model called '${v}'`, "find {kind: 'model', query} lists models", { didYouMean: guess(String(v), CAT.list(String(v).split("/").pop().replace(/\.[a-z0-9]+$/i, "").slice(0, 12)).map(([k]) => k).slice(0, 200)) });
  if (comp === "lock" && v !== true) refuse("shape", `${at} is true while locked; to unlock, delete it`, `delete {id: '${id}', component: 'lock'}`);
  if (comp === "motion" && obj && "pivot" in v) refuse("derived", `${at}.pivot is derived from what it hangs from; it isn't stored`, "L2: no stored derived values; inspect shows the pivot as a view");
  if (comp === "reactions") { if (!obj) refuse("shape", `${at} must be {<action>: handler}`, "");
    const kinds = Object.keys(COMPONENTS.reactions.handlers);
    for (const [act, h] of Object.entries(v)) { if (!kinds.includes(h?.kind)) refuse("shape", `reactions.${act}: no handler kind '${h?.kind}'`, `handler kinds: ${kinds.join(", ")}`, { didYouMean: guess(String(h?.kind), kinds) });
      if (h.component !== undefined && !isComponent(h.component)) refuse("shape", `reactions.${act}.component '${h.component}' isn't a component name`, "§2.3");
      if (h.kind === "set" && !isComponent(h.component)) refuse("shape", `reactions.${act} (set) needs a component`, "e.g. {kind: 'set', component: 'door', field: 'locked', value: true}");
      for (const f of ["field", "unless"]) if (h[f] !== undefined && typeof h[f] !== "string") refuse("shape", `reactions.${act}.${f} is a field name (a string)`, ""); } }
  if (comp.startsWith("roles:") && (!obj || RANK[v.role] === undefined)) refuse("shape", `${at} must be {role: owner|builder|visitor|none}`, "");
  for (const [f, allowed] of Object.entries(COMPONENTS[comp]?.enums ?? {})) if (obj && v[f] !== undefined && !allowed.includes(v[f])) refuse("shape", `${comp}.${f} must be one of ${allowed.join(" | ")}, got ${JSON.stringify(v[f])}`, `schema {component: '${comp}'}`);
}
// L3: a rest must equal the engine's value. The gate asks the engine itself, not the caller.
function restCheck(w, cap, after) {
  const sf = w.sim(); const id = cap.ids[0]; const b = sf.sim?.bodies[id];
  if (!b || !b.resting || sf.launched[id]?.seq !== cap.launch) refuse("not-at-rest", `the engine doesn't have ${id} at rest from launch ${cap.launch}`, "");
  if (JSON.stringify(worldPose(after, id).pos) !== JSON.stringify(b.p)) refuse("not-the-engine's", `${id} would rest at ${JSON.stringify(worldPose(after, id).pos)}; the engine has it at ${JSON.stringify(b.p)}`, "");
}
function stateShape(plan, cause) {
  const ops = plan.ops; const one = ops.length === 1 ? (({ verb, ...body }) => ({ verb, body }))(ops[0]) : { verb: "batch", body: { ops } };
  return { kind: "state", actor: plan.who.actor, cause, ...one };
}
function stateEntry(w, plan, cause) {
  if (!(plan instanceof Admitted)) throw new Error("door bug: a state write that admit() didn't produce (L7)");
  return w.append(stateShape(plan, cause), STATE);
}
const actEntry = (w, actor, tool, body) => ({ kind: "act", actor, verb: tool, body });
const actOf = (w, actor, tool, args, extra) => actEntry(w, actor, tool, { request: stripDry(args), ...(extra ?? {}) });

// A write: build ops against the folded state, admit them, then append the act and its one state entry.
function commit(w, actor, tool, args, build) {
  const sent = clone(args); // L4: the act is the request AS SENT (builders may annotate their own copy)
  const st = w.state();
  const ctx = { st, actor, w, notes: [], refs: new Set() };
  const ops = build(ctx);
  const plan = admit(w, st, { actor, cap: ctx.cap }, ops);
  if (args.dry) return { ok: true, dry: true, would: plan.ops, notes: ctx.notes, ...warnOrNot(warnings(plan.after, [...ctx.refs])) };
  const actE = actOf(w, actor, tool, sent, ctx.actExtra);
  w.fits(actE, stateShape(plan, w.entries.length)); // both lines fit, or neither is written
  const act = w.append(actE);
  const seq = stateEntry(w, plan, act);
  const after = w.state();
  return { ok: true, seq, act, refs: [...ctx.refs].filter((id) => after.entities[id]).map((id) => ({ id, born: after.entities[id].born })),
    after: touched(plan.ops, after), ...(ctx.notes.length ? { notes: ctx.notes } : {}), ...warnOrNot(warnings(after, [...ctx.refs])) };
}
function touched(ops, st) {
  const out = {};
  for (const o of ops) { const e = st.entities[o.id]; out[o.id] ??= {};
    if (!e) { out[o.id] = null; continue; }
    if (o.verb === "create") Object.assign(out[o.id], e.c);
    else if (o.comp !== undefined) out[o.id][o.comp] = e.c[o.comp] ?? null; else out[o.id] = null; }
  return out;
}
const stripDry = ({ dry, ...rest }) => rest;
const warnOrNot = (ws) => (ws.length ? { warnings: ws } : {});

function lastTouch(w, id, comp) {
  for (const i of backward(w, id)) { const e = w.entries[i]; if (!isE(e) || e.kind !== "state") continue;
    for (const o of opsQuiet(e)) { if (o.id !== id) continue;
      if (o.verb === "create" || o.comp === comp || (o.verb === "delete" && o.comp === undefined)) return { seq: i, actor: e.actor }; } }
  return null;
}
function needThing(ctx, id) {
  const e = ctx.st.entities[id];
  if (!e) refuse("not-found", `no thing called '${id}'`, "look lists what's here", { didYouMean: guess(String(id), Object.keys(ctx.st.entities)) });
  const by = id === "@world" ? null : madeBy(ctx.w, id);
  if (by && by !== ctx.actor && !ctx.__owned?.has(id)) { (ctx.__owned ??= new Set()).add(id); ctx.notes.push({ id, madeBy: by, why: `this is ${by}'s; your change is attributed to you and shows in their "changes to my things"` }); }
  return e;
}

// Resolve a component value fully (R7): defaults written out, conveniences converted, stamps applied. Shape and rights
// are admit's; this only turns what was asked into a plain value.
function resolve(ctx, id, comp, value, prev) {
  const def = COMPONENTS[comp];
  if (comp === "transform") {
    const v = { ...COMPONENTS.transform.defaults, ...(prev ?? {}), ...(value ?? {}) };
    if (value && "yaw" in value) { v.q = yawQ(value.yaw).map((n) => r3(n)); delete v.yaw; ctx.notes.push({ id, component: "transform", field: "yaw", sent: value.yaw, kept: v.q, why: "yaw is a convenience; the log stores q" }); }
    if (typeof v.scale === "number") v.scale = [v.scale, v.scale, v.scale];
    for (const k of ["pos", "q", "scale"]) if (!Array.isArray(v[k]) || v[k].some((n) => !Number.isFinite(n))) refuse("shape", `transform.${k} must be numbers`, "pos [x,y,z], q [x,y,z,w], scale [x,y,z] or a number");
    v.pos = v.pos.map(r3);
    return v;
  }
  if (!COMPONENTS[comp] && !comp.includes(":")) ctx.notes.push({ id, component: comp, why: `'${comp}' isn't a component this world's engine knows: it is kept (and will be preserved), but nothing will draw or run it`, didYouMean: guess(comp, Object.keys(COMPONENTS)) });
  if (comp === "motion" && value && typeof value === "object") { const v = { ...(value.type === "pendulum" ? PENDULUM : {}), ...value }; delete v.pivot;
    if (v.t0 === undefined) { v.t0 = ctx.w.now(); ctx.notes.push({ id, component: "motion", field: "t0", kept: v.t0, why: "stamped by the door" }); } return v; }
  if (def?.defaults && value && typeof value === "object" && !Array.isArray(value)) {
    const filled = Object.keys(def.defaults).filter((k) => !(k in value));
    if (filled.length) ctx.notes.push({ id, component: comp, filled, why: "defaults written out so the engine can't change them later" });
    return { ...def.defaults, ...value };
  }
  return value;
}
function merge7396(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return clone(patch);
  const out = target && typeof target === "object" && !Array.isArray(target) ? clone(target) : {};
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = merge7396(out[k], v); }
  return out;
}
let mintN = 0;
function mint(st, base) { base = slug(base); let n = Object.keys(st.entities).length + (++mintN); while (st.entities[`${base}-${n}`]) n++; return `${base}-${n}`; }

function buildCreate(ctx, a) {
  if (a.from) return buildCreateFrom(ctx, a);
  const comps = { ...(a.components ?? {}) };
  if (a.model) comps.model = a.model;
  const id = a.id ?? mint(ctx.st, comps.model ?? "thing");
  if (!isEntityId(id) || id === "@world") refuse("shape", `'${id}' isn't an id you can make`, "§2.3: a–z, 0–9 and '-', up to 64; or leave id out and the door mints one");
  if (ctx.st.entities[id]) refuse("exists", `'${id}' already exists`, "choose another id, or leave id out and the server mints one");
  for (const k of Object.keys(comps)) if (!isComponent(k)) refuse("shape", `'${k}' isn't a component name`, "§2.3: [a-z][a-z0-9-]*, optionally <domain>/, @<n> and :<key>", { didYouMean: guess(k, Object.keys(COMPONENTS)) });
  const out = {};
  for (const [k, v] of Object.entries(comps)) out[k] = resolve(ctx, id, k, v);
  if (!out.transform) out.transform = resolve(ctx, id, "transform", {});
  ctx.refs.add(id); // who made it is the create entry's actor: a view, never a stored `placer` (L2)
  const made = createOps(id, out);
  if (!a.place) return made;
  const placed = buildPlace({ ...ctx, st: scratch(ctx.st, made) }, { ...a.place, id });
  return [...made.filter((o) => !(o.verb === "set" && (o.comp === "transform" || o.comp === "parent"))), ...placed.filter((o) => o.verb === "set")];
}

function buildSet(ctx, a) {
  const e = needThing(ctx, a.id);
  if (!isComponent(a.component)) refuse("shape", `'${a.component}' isn't a component name`, "§2.3: [a-z][a-z0-9-]*, optionally <domain>/, @<n> and :<key> (ASCII only)", { didYouMean: guess(String(a.component), Object.keys(COMPONENTS)) });
  const lt = lastTouch(ctx.w, a.id, a.component);
  if (a.base !== undefined && lt && lt.seq > a.base) refuse("stale", `${a.id}.${a.component} changed since version ${a.base}: ${lt.actor} set it at ${lt.seq}`, a.merge ? `inspect {id: '${a.id}'} for the current value and its new version, then re-send with that base` : `inspect {id: '${a.id}'} for the current value and version, then decide; or merge: true to change only your fields`, { current: e.c[a.component] ?? null, version: lt.seq });
  if (a.base === undefined && !a.merge && lt && lt.actor !== ctx.actor && a.component in e.c) ctx.notes.push({ id: a.id, component: a.component, overwrote: { by: lt.actor, seq: lt.seq }, why: "you replaced someone else's value without a base version; send base (from inspect) to be refused instead if it changed" });
  let v = a.merge ? merge7396(e.c[a.component], a.value) : a.value;
  if (a.component === "parent") {
    if (v?.to && !ctx.st.entities[v.to]) refuse("not-found", `no thing called '${v.to}'`, "", { didYouMean: guess(v.to, Object.keys(ctx.st.entities)) });
    if (v?.to && (v.to === a.id || ancestors(ctx.st, v.to).includes(a.id))) refuse("loop", `${a.id} can't be inside ${v.to}: that makes a loop`, "");
    const wt = worldT(ctx.st, a.id);
    const t = v?.to ? localFrom(ctx.st, v.to, wt) : wt;
    ctx.notes.push({ id: a.id, component: "transform", why: "re-expressed in its new parent's frame so it stays where it is (stamped)" });
    ctx.refs.add(a.id);
    return [setOp(a.id, "parent", resolve(ctx, a.id, "parent", v)), setOp(a.id, "transform", t)];
  }
  if (a.id === "@world" && a.component === "sim") return buildEpoch(ctx, v, a);
  v = resolve(ctx, a.id, a.component, v);
  ctx.refs.add(a.id);
  return [setOp(a.id, a.component, v)];
}

function buildDelete(ctx, a) {
  const e = needThing(ctx, a.id);
  if (a.id === "@world" && a.component === "sim") return buildEpoch(ctx, null, a);
  if (a.component !== undefined) {
    if (a.component === "parent" && e.c.parent) {
      const wt = worldT(ctx.st, a.id); ctx.refs.add(a.id);
      return [delOp(a.id, "parent"), setOp(a.id, "transform", { ...wt, pos: wt.pos.map(r3) })];
    }
    if (!(a.component in e.c)) refuse("not-found", `${a.id} has no ${a.component}`, `it has: ${Object.keys(e.c).join(", ")}`);
    ctx.refs.add(a.id);
    return [delOp(a.id, a.component)];
  }
  const kids = descendants(ctx.st, a.id);
  if (kids.length) ctx.notes.push({ id: a.id, why: `its ${kids.length} children went with it: ${kids.join(", ")}` });
  const gone = new Set([a.id, ...kids]); const ops = [...kids.reverse(), a.id].map((id) => delOp(id));
  const after = scratch(ctx.st, ops); const setDown = [];
  for (const id of Object.keys(after.entities)) { const b = aabb(after, id); if (!b || after.entities[id].c.parent) continue;
    const before = supportBelow(ctx.st, (b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2, b.min[1], new Set([id]));
    if (!gone.has(before.id)) continue;
    const now = supportBelow(after, (b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2, b.min[1], new Set([id]));
    const t = worldT(after, id); ops.push(setOp(id, "transform", { ...t, pos: [t.pos[0], r3(t.pos[1] - (b.min[1] - now.y)), t.pos[2]] })); setDown.push({ id, onto: now.id }); ctx.refs.add(id); }
  if (setDown.length) ctx.notes.push({ setDown, why: "they were resting on what you deleted, so they were set down on what's below" });
  return ops;
}

// Relational placement (A1): the door solves; the log gets a plain transform.
function buildPlace(ctx, a) {
  const e = needThing(ctx, a.id);
  const m = geomOf(e.c.model); if (!m) refuse("shape", modelOf(e.c.model) ? `${a.id}'s model hasn't been measured here, so it has no size to place` : `${a.id} has no model, so it has no size to place`, "set its transform directly");
  const st = ctx.st, cur = worldT(st, a.id), scale = cur.scale;
  const fam = new Set([a.id, ...descendants(st, a.id)]);
  let yaw = a.yaw ?? qYaw(cur.q);
  // lying: rest on the largest face. The door owns the tilt and where the origin ends up (W6).
  let tilt = [0, 0, 0, 1];
  if (a.lying) { const d = m.size.map((v, i) => v * scale[i]); const k = d.indexOf(Math.min(...d)); const r = Math.SQRT1_2;
    tilt = k === 2 ? [r, 0, 0, r] : k === 0 ? [0, 0, r, r] : tilt; }
  const [mlo, mhi] = boxOfM(m); const lc = []; for (const x of [mlo[0], mhi[0]]) for (const y of [mlo[1], mhi[1]]) for (const z of [mlo[2], mhi[2]]) lc.push(qrot(tilt, [x * scale[0], y * scale[1], z * scale[2]]));
  const lo = [0, 1, 2].map((i) => Math.min(...lc.map((c) => c[i]))), hi = [0, 1, 2].map((i) => Math.max(...lc.map((c) => c[i])));
  const S = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], C = [(hi[0] + lo[0]) / 2, 0, (hi[2] + lo[2]) / 2];
  const half = (y) => { const c = Math.abs(Math.cos(y)), s = Math.abs(Math.sin(y)); const hx = S[0] / 2, hz = S[2] / 2; return [c * hx + s * hz, s * hx + c * hz]; };
  const free = (x, y, z, yw, ignore) => { const [hx, hz] = half(yw); const box = { min: [x - hx, y, z - hz], max: [x + hx, y + S[1], z + hz] };
    for (const id of Object.keys(st.entities)) { if (fam.has(id) || ignore.has(id)) continue; if (hits(box, st, id, 0.01)) return id; } return null; };
  const relaxed = []; let pos, support;
  const faceYaw = (p) => { if (!a.facing) return yaw; const tgt = Array.isArray(a.facing) ? [a.facing[0], 0, a.facing[1]] : worldT(st, a.facing)?.pos;
    if (!tgt) refuse("not-found", `can't face '${a.facing}': facing takes a thing's id or an [x, z] point, not a direction word`, "e.g. facing: 'door-1', or facing: [0, -5] to face north-ish (−z)", { didYouMean: guess(String(a.facing), Object.keys(st.entities)) }); const d = [tgt[0] - p[0], tgt[2] - p[2]]; return Math.atan2(d[0], d[1]) + (a.away ? Math.PI : 0); };
  if (a.on) {
    const surfs = surfacesOf(st, a.on); if (!st.entities[a.on]) refuse("not-found", `no '${a.on}'`, "", { didYouMean: guess(a.on, Object.keys(st.entities)) });
    if (!surfs.length) refuse("no-surface", `${a.on} has no surface to put things on`, `measure {id: '${a.on}'} shows its surfaces`);
    const s = surfs[a.level ?? surfs.length - 1] ?? refuse("no-surface", `${a.on} has levels 0–${surfs.length - 1}`, "");
    const want = a.offset ? [(s.min[0] + s.max[0]) / 2 + a.offset[0], (s.min[1] + s.max[1]) / 2 + a.offset[1]] : [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2];
    let best = null, lastBlock = null;
    for (let pass = 0; pass < 2; pass++) {
      const [hx, hz] = half(yaw);
      for (let x = s.min[0] + hx; x <= s.max[0] - hx + 1e-9; x += 0.025) for (let z = s.min[1] + hz; z <= s.max[1] - hz + 1e-9; z += 0.025) {
        const d = Math.hypot(x - want[0], z - want[1]); if (best && d >= best.d) continue;
        const bl = free(x, s.y, z, yaw, new Set()); if (!bl) best = { x, z, d }; else lastBlock = bl;
      }
      if (!best) break; if (a.facing && pass === 0) { yaw = faceYaw([best.x, 0, best.z]); best = null; } else break;
    }
    if (!best) { const [hx, hz] = half(yaw); refuse("no-room", `${a.id} (${r3(2 * hx)}×${r3(2 * hz)} m) doesn't fit free on ${a.on}'s level ${s.level} (${r3(s.max[0] - s.min[0])}×${r3(s.max[1] - s.min[1])} m)${lastBlock ? `; ${lastBlock} is in the way` : ""}`, "try another level, a smaller thing, or move what's there"); }
    if (best.d > 0.01) relaxed.push(`moved ${r3(best.d)} m from where you asked to stay clear and fully supported`);
    pos = [best.x, s.y, best.z]; support = a.on; if (a.attach === undefined) a.attach = true; // things rest on what supports them
  } else if (a.hang) {
    const ft = worldT(st, a.hang), fb = aabb(st, a.hang); if (!fb) refuse("not-found", `no solid '${a.hang}'`, "", { didYouMean: guess(a.hang, Object.keys(st.entities)) });
    yaw = qYaw(ft.q); const right = qrot(ft.q, [1, 0, 0]); const along = a.along ?? 0; const h = a.height ?? 0.5;
    if (h + m.size[1] * scale[1] > fb.max[1]) refuse("no-room", `${a.id} can't hang ${h} m up from ${a.hang}: its top is at ${r3(fb.max[1])} m`, "use a lower height");
    pos = [ft.pos[0] + right[0] * along, h, ft.pos[2] + right[2] * along]; support = a.hang; a.attach = true;
    { const [hx, hz] = half(yaw); const box = { min: [pos[0] - hx, h, pos[2] - hz], max: [pos[0] + hx, h + S[1], pos[2] + hz] };
      if (hits(box, st, a.hang, 0.01)) refuse("inside", `hanging there would put ${a.id} inside ${a.hang}'s solid parts`, `${a.hang} isn't something to hang from at that spot; hang from a frame or beam (find {query: 'frame'}), or use along to move clear`); }
  } else if (a.beside) {
    const nb = aabb(st, a.beside); const nt = worldT(st, a.beside); if (!nb) refuse("not-found", `no solid '${a.beside}'`, "", { didYouMean: guess(a.beside, Object.keys(st.entities)) });
    yaw = qYaw(nt.q); const right = qrot(nt.q, [1, 0, 0]), fwd = qrot(nt.q, [0, 0, 1]); const dir = a.side === "left" ? -1 : 1;
    const nm = geomOf(st.entities[a.beside].c.model);
    const nh = nm.size[0] * nt.scale[0] / 2, mh = m.size[0] * scale[0] / 2, gap = a.gap ?? 0.005;
    const flush = ((m.size[2] * scale[2]) - (nm.size[2] * nt.scale[2])) / 2; // backs line up, as furniture does against a wall
    let k = nh + mh + gap, p, blocker = null;
    for (let tries = 0; tries < 40; tries++, k += 0.02) { p = [nt.pos[0] + right[0] * k * dir + fwd[0] * flush, nt.pos[1], nt.pos[2] + right[2] * k * dir + fwd[2] * flush];
      blocker = free(p[0], p[1], p[2], yaw, new Set()); if (!blocker) break; p = null; }
    if (!p) refuse("no-room", `${a.id} won't fit ${a.side ?? "right"} of ${a.beside}: it would overlap ${blocker}`, "try the other side, or move " + blocker);
    if (k > nh + mh + gap + 1e-6) relaxed.push(`shifted ${r3(k - nh - mh - gap)} m further to clear something`);
    pos = p; support = supportBelow(st, p[0], p[2], p[1] + 0.01, fam).id; if (a.attach === undefined) a.attach = true;
    const sb = supportBelow(st, p[0], p[2], p[1] + 0.01, fam); if (Math.abs(sb.y - p[1]) > 0.02) refuse("unsupported", `there's nothing to stand on ${a.side ?? "right"} of ${a.beside}`, "try the other side, or 'on' with an offset");
  } else if (a.against) {
    const b = aabb(st, a.against); if (!b) refuse("not-found", `no solid '${a.against}'`, "look lists what's here", { didYouMean: guess(a.against, Object.keys(st.entities)) });
    const thinX = b.max[0] - b.min[0] < b.max[2] - b.min[2];
    const c = [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
    const side = a.side ?? (thinX ? Math.sign(cur.pos[0] - c[0]) || 1 : Math.sign(cur.pos[2] - c[1]) || 1);
    yaw = thinX ? (side > 0 ? Math.PI / 2 : -Math.PI / 2) : (side > 0 ? 0 : Math.PI);
    const [hx, hz] = half(yaw); const gap = a.gap ?? 0.01; const along = a.along ?? 0;
    pos = thinX ? [side > 0 ? b.max[0] + hx + gap : b.min[0] - hx - gap, 0, c[1] + along] : [c[0] + along, 0, side > 0 ? b.max[2] + hz + gap : b.min[2] - hz - gap];
    if (a.height !== undefined) { // wall-mounted: at that height, riding the wall
      if (a.height + m.size[1] * scale[1] > b.max[1]) refuse("no-room", `${a.id} at ${a.height} m would stick out above ${a.against} (top ${r3(b.max[1])} m)`, "use a lower height");
      pos[1] = a.height; support = a.against; if (a.attach === undefined) a.attach = true; a.__mounted = true; }
    if (a.facing) relaxed.push("'facing' ignored: against a wall, a thing faces away from it");
  } else if (a.near) {
    const t = worldT(st, a.near); const b = aabb(st, a.near); if (!t) refuse("not-found", `no '${a.near}'`, "");
    const gap = a.gap ?? 0.3; let ok = null;
    for (let i = 0; i < 16 && !ok; i++) { const ang = (a.side ?? 0) + i * Math.PI / 8 * (i % 2 ? 1 : -1) * Math.ceil(i / 2) / Math.max(1, i);
      const R = (b ? Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2 : 0) + Math.max(...half(yaw)) + gap;
      const p = [t.pos[0] + Math.sin(ang) * R, 0, t.pos[2] + Math.cos(ang) * R]; const yw = a.facing ? faceYaw(p) : yaw;
      const level = (b ? b.min[1] : t.pos[1]) + 0.02; // "near X" = on the same support as X, never on top of other furniture
      if (!free(p[0], supportBelow(st, p[0], p[2], level, fam).y, p[2], yw, new Set())) { ok = p; yaw = yw; } }
    if (!ok) refuse("no-room", `no free spot within ${gap} m of ${a.near}`, "try a larger gap");
    pos = ok; a.__level = (b ? b.min[1] : t.pos[1]) + 0.02;
  } else if (a.at) {
    pos = [a.at[0], 0, a.at[1]];
  } else refuse("shape", "place needs one of: on, against, near, at", "e.g. place {id, on: 'table-1'} or {id, near: 'bed-2', facing: 'door-1'}");
  if (!a.on && !a.beside && !a.hang && !a.__mounted) { if (a.facing && !a.against) yaw = faceYaw(pos); const sup = supportBelow(st, pos[0], pos[2], a.__level ?? a.at?.[2] ?? 10, fam); pos[1] = sup.y; support = sup.id;
    const hit = free(pos[0], pos[1], pos[2], yaw, new Set()); if (hit) relaxed.push(`overlaps ${hit}: nothing nearer was free`); }
  const off = qrot(yawQ(yaw), C); const restsAt = pos[1];
  const wt = { pos: [pos[0] - off[0], pos[1] - lo[1], pos[2] - off[2]].map(r3), q: qmul(yawQ(yaw), tilt).map(r3), scale };
  const ops = [];
  if (a.attach && support !== "ground") {
    ops.push(setOp(a.id, "parent", { to: support, order: "a0" }));
    const s2 = scratch(st, [setOp(a.id, "parent", { to: support })]);
    ops.push(setOp(a.id, "transform", localFrom(s2, support, wt)));
  } else {
    if (e.c.parent) ops.push(delOp(a.id, "parent"));
    ops.push(setOp(a.id, "transform", wt));
  }
  ctx.notes.push({ id: a.id, placed: { pos: wt.pos, restsAt: r3(restsAt), ...(a.lying ? { lying: true } : {}), yawDeg: r3(yaw * 180 / Math.PI), on: support, ridesWith: a.attach && support !== "ground" ? support : null }, ...(relaxed.length ? { relaxed } : {}) });
  ctx.refs.add(a.id);
  return ops;
}

// Physical checks on every write (A2).
function warnings(st, ids) {
  const out = []; const all = Object.keys(st.entities);
  const B = st.entities["@world"]?.c.bounds;
  for (const id of ids) {
    const b = aabb(st, id); if (!b) continue;
    const fam = new Set([id, ...descendants(st, id)]); // a parent is NOT exempt: a bell inside its lamp pole is still inside it
    const mine = obbs(st, id);
    for (const o of all) { if (fam.has(o)) continue;
      const pair = mine.flatMap((a) => obbs(st, o).map((sb) => satDepth(a, sb)).filter((p) => p > 0.02));
      if (pair.length && !out.some((x) => x.kind === "overlap" && x.id === o && x.with === id)) out.push({ id, kind: "overlap", with: o, by: r3(Math.max(...pair)) }); }
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    const sup = supportBelow(st, cx, cz, b.min[1], new Set([id, ...descendants(st, id)]));
    const hungFrom = ancestors(st, id).find((p) => { const pb = aabb(st, p); return pb && pb.max[1] > b.max[1]; });
    if (!hungFrom && sup.y - b.min[1] > 0.005 && sup.y - b.min[1] < 0.3) out.push({ id, kind: "sunk", depth: r3(sup.y - b.min[1]), into: sup.id });
    const mounted = ancestors(st, id).some((p) => { const pb = aabb(st, p); return pb && pb.min[1] <= b.min[1] && pb.max[1] >= b.max[1]; });
    const under = supportUnder(st, b, new Set([id, ...descendants(st, id)]));
    if (b.min[1] - under.y > 0.03 && !hungFrom && !mounted) out.push({ id, kind: "floating", gap: r3(b.min[1] - under.y), above: under.id });
    if (B && (b.min[0] < B.min[0] || b.max[0] > B.max[0] || b.min[2] < B.min[2] || b.max[2] > B.max[2])) out.push({ id, kind: "out-of-bounds" });
  }
  return out;
}

// ---------- use (interaction) ----------
// A pendulum's pivot is a view: derived from what it hangs from, every time it's read (L2: never stored).
function pivotOf(st, id) {
  const t = worldT(st, id); const p = st.entities[id]?.c.parent?.to; const pb = p && aabb(st, p);
  return pb && pb.max[1] > t.pos[1] ? [0, r3((pb.max[1] - t.pos[1]) / t.scale[1]), 0] : null;
}
// L7: a `use` exercises a capability the handler holds. It is scoped to the component the handler names, and good
// only while the handler's author (whoever last set `reactions`) could still make that change themselves.
function reactionCap(ctx, id, comp, action) {
  const lt = lastTouch(ctx.w, id, "reactions"); if (!lt) refuse("no-handler", `nobody set up '${action}' on ${id}`, "");
  ctx.actExtra = { capability: { reaction: action, author: lt.actor, grantedAt: lt.seq } };
  ctx.cap = { kind: "reaction", ids: [id], comps: [comp], author: lt.actor, action };
}
function buildUse(ctx, a) {
  const e = ctx.st.entities[a.id]; if (!e) refuse("not-found", `no '${a.id}'`, "", { didYouMean: guess(a.id, Object.keys(ctx.st.entities)) });
  const offers = actionsOf(ctx.st, a.id);
  const action = a.action ?? offers[0];
  if (!offers.includes(action)) refuse("no-action", `${a.id} doesn't '${action}'`, `it offers: ${offers.join(", ") || "nothing"}`, { didYouMean: guess(action, offers) });
  if (action === "sit") return { presence: true, note: `you're seated on ${a.id} (presence: your frame says seat; nothing recorded)` };
  const h = e.c.reactions?.[action];
  if (h?.who && RANK[roleOf(ctx.st, ctx.actor)] < RANK[h.who]) refuse("rights", `only a ${h.who} may ${action} ${a.id}`, "ask someone who can");
  if (h?.kind === "pendulum-push") {
    const mo = { ...(e.c.motion?.type === "pendulum" ? e.c.motion : PENDULUM) }; delete mo.pivot;
    if (!pivotOf(ctx.st, a.id)) refuse("no-pivot", `${a.id} swings but hangs from nothing above it`, `hang it first: place {id: '${a.id}', hang: <frame>}`);
    const raw = a.args?.impulse ?? qrot(worldT(ctx.st, a.id).q, [0, 0, h.default ?? 1]);
    const fwd = qrot(worldT(ctx.st, a.id).q, [0, 0, 1]); const along = raw[0] * fwd[0] + raw[1] * fwd[1] + raw[2] * fwd[2];
    const mag = Math.hypot(...raw);
    if (mag > 0 && Math.abs(along) < 0.3 * mag) refuse("sideways", `${a.id} swings front-to-back; that push is mostly sideways`, `push along its front ${JSON.stringify(fwd.map(r3))} (or the opposite)`);
    const amp = Math.min(mo.maxAmp ?? 0.9, (mo.amp ?? 0) * 0.5 + Math.abs(along) * (h.gain ?? 0.25));
    reactionCap(ctx, a.id, "motion", action);
    ctx.refs.add(a.id); return [setOp(a.id, "motion", { ...mo, amp: r3(amp), t0: ctx.w.now() })];
  }
  // §5: a thing's gameplay state lives inside its own component (a door is `door: {open, locked}`), never as a top-level
  // name beside the edit `lock`. A handler names its component and, for an object component, the field it changes.
  if (h?.kind === "set") { const comp = h.component; reactionCap(ctx, a.id, comp, action); ctx.refs.add(a.id);
    return [setOp(a.id, comp, h.field === undefined ? h.value : { ...objOf(e.c[comp]), [h.field]: h.value })]; }
  if (h?.kind === "toggle") {
    const { comp, field } = toggleOf(h); ctx.refs.add(a.id);
    if (barredBy(e, h)) refuse("barred", `${a.id} is ${h.unless}`, h.teach ?? `someone allowed to may 'use' it with another action first`);
    reactionCap(ctx, a.id, comp, action);
    return [setOp(a.id, comp, field === undefined ? !e.c[comp] : { ...objOf(e.c[comp]), [field]: !objOf(e.c[comp])[field] })];
  }
  refuse("no-handler", `${a.id} declares '${action}' but its handler kind isn't one this engine runs`, `handler kinds: ${Object.keys(COMPONENTS.reactions.handlers).join(", ")} (schema {component: 'reactions'})`);
}
const objOf = (v) => (v && typeof v === "object" && !Array.isArray(v) && v !== PURGED ? v : {});
// toggle's defaults: the door's own `open` (component `door`, field `open`); a named component with no field toggles
// the whole value (a plain boolean component). `unless` names a field of the same component that, when true, bars it.
const toggleOf = (h) => { const comp = h.component ?? "door"; return { comp, field: h.field ?? (h.component === undefined ? "open" : undefined) }; };
const barredBy = (e, h) => !!h?.unless && objOf(e.c[toggleOf(h).comp])[h.unless] === true;
function actionsOf(st, id) {
  const e = st.entities[id]; const m = modelOf(e?.c.model);
  return [...Object.keys(e?.c.reactions ?? {}), ...((e?.c.sockets || m?.sockets) ? ["sit"] : [])];
}
function offersFor(st, id, actor) {
  const e = st.entities[id]; const can = [], notForYou = [];
  for (const act of actionsOf(st, id)) { const h = e.c.reactions?.[act];
    if (h?.who && RANK[roleOf(st, actor)] < RANK[h.who]) notForYou.push({ action: act, why: `needs ${h.who}` });
    else if (h?.kind === "toggle" && barredBy(e, h)) notForYou.push({ action: act, why: `it is ${h.unless}` });
    else can.push(act); }
  return { canDo: can, ...(notForYou.length ? { notForYou } : {}) };
}

// ---------- the act index (slice 3a): undo and wait without scanning the log ----------
// A view over the log (L2), built once per world object and advanced per appended entry, so a live world (server/v4,
// where `w` lives as long as the world is open) pays for each entry once. A purge is retroactive (L1), so a purge entry
// throws the index away and rebuilds it, as live.ts refolds the state. What it holds:
//   actsOf    actor → their act seqs, in order          resultOf  act seq → the first state entry it caused
//   undone    act seqs some `undo` act names (body.undoes)
//   purged    seqs whose act/say/sim BODY is purged; purgedOps `${seq}:${op|-}` → a purged set value (as the fold keys it)
//   states    every state seq, in order                 touch     id → the state seqs that touch it, in order
//   rests     state seqs that are rests (caused by a sim launch); restAfter: rest seq → the door's follow-up act
//   lastAct   the latest act that isn't an undo or the door's (for "the latest change was X's")
// A world object over a log that is re-read per request (the suites' disk worlds) rebuilds it per request, as before.
function freshIndex() {
  return { n: 0, actsOf: new Map(), resultOf: new Map(), undone: new Set(), purged: new Set(), purgedOps: new Map(), states: [], touch: new Map(),
    rests: [], restAfter: new Map(), lastAct: null };
}
function purgeTargets(E, x) { // the fold's own reading of purge entries (fold.js purgesOf), kept for views
  x.pt = E.length; // purges below this seq are already in purged/purgedOps
  E.forEach((e, pseq) => { if (!isE(e) || x.bad.has(pseq) || e.kind !== "purge" || !Array.isArray(e.body?.values)) return;
    for (const t of e.body.values) { if (!t || typeof t !== "object" || Array.isArray(t) || !Object.keys(t).every((k) => k === "seq" || k === "op")) continue;
      if (!Number.isInteger(t.seq) || t.seq <= 0 || t.seq >= pseq || (t.op !== undefined && !(Number.isInteger(t.op) && t.op >= 0))) continue;
      const tgt = E[t.seq]; if (!isE(tgt) || x.bad.has(t.seq) || tgt.kind === "purge") continue;
      if (t.op === undefined && ["act", "say", "sim"].includes(tgt.kind)) x.purged.add(t.seq);
      x.purgedOps.set(`${t.seq}:${t.op ?? "-"}`, pseq); } });
}
function indexEntry(x, E, i) {
  const e = E[i]; if (!isE(e) || x.bad.has(i)) return; // what the fold refuses (malformed) shapes no view either
  if (e.kind === "act") { let a = x.actsOf.get(e.actor); if (!a) x.actsOf.set(e.actor, (a = [])); a.push(i);
    const b = x.purged.has(i) ? null : e.body;
    if (e.verb === "undo" && b && b.undoes !== undefined) x.undone.add(b.undoes);
    if (e.verb !== "undo" && e.actor !== "door") x.lastAct = i;
    if (e.actor === "door" && b && Number.isInteger(b.rest) && !x.restAfter.has(b.rest)) x.restAfter.set(b.rest, i); }
  if (e.kind === "state") { x.states.push(i);
    if (Number.isInteger(e.cause) && !x.resultOf.has(e.cause)) x.resultOf.set(e.cause, i);
    for (const id of new Set(opsQuiet(e).map((o) => o.id))) { let a = x.touch.get(id); if (!a) x.touch.set(id, (a = [])); a.push(i); }
    const c = E[e.cause]; if (isE(c) && c.kind === "sim" && c.verb === "launch") x.rests.push(i); }
}
// The entries the fold calls malformed (it shapes nothing with them). The door never writes one; an old or hand-made
// log may hold some, and they're known when the index is built (the door re-reads every line it appends).
const malformedSeqs = (st) => new Set((st?.diagnostics ?? []).filter(([, c]) => String(c).startsWith("malformed")).map(([q]) => q));
/** The act index for a world, advanced to the log's end (rebuilt from scratch when a purge arrives). */
export function actIndexOf(w) {
  const E = w.entries; let x = w.__actIndex;
  const fresh = () => { const y = freshIndex(); y.entries = E; y.bad = malformedSeqs(w.state ? w.state() : fold(E)); purgeTargets(E, y); return (w.__actIndex = y); };
  if (!x || x.entries !== E || x.n > E.length) x = fresh();
  for (; x.n < E.length; x.n++) {
    if (x.n >= x.pt && isE(E[x.n]) && E[x.n].kind === "purge") { const n = x.n; x = fresh(); for (; x.n < n; x.n++) indexEntry(x, E, x.n); } // retroactive (L1): start over
    indexEntry(x, E, x.n); }
  return x;
}
/** The same index built from nothing over `entries` (the reference the incremental one must equal). */
export function actIndexFresh(entries) { return actIndexOf({ entries }); }
const firstAfter = (a, seq) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= seq) lo = m + 1; else hi = m; } return lo; };
/** A thing as it was just before entry `seq` (= fold(entries, {until: seq - 1}).entities[id]), from its own history
 *  through the index, never the whole log. Purged values are PURGED at every point in time, as the fold has them. */
export function entityBefore(w, id, seq, x = actIndexOf(w)) {
  let ent = id === "@world" ? { born: 0, c: Object.create(null) } : undefined; // @world is live from genesis (§2.3)
  const E = w.entries; const hist = x.touch.get(id) ?? [];
  for (let k = 0; k < hist.length && hist[k] < seq; k++) { const i = hist[k]; const e = E[i]; const ops = opsQuiet(e); const batch = e.verb === "batch";
    ops.forEach((o, j) => { if (o.id !== id) return;
      if (o.verb === "create") { if (!ent) ent = { born: i, c: Object.create(null) }; return; }
      if (!ent) return;
      if (o.verb === "set") { if (x.purgedOps.has(`${i}:${batch ? j : "-"}`)) ent.c[o.comp] = PURGED; else if ("value" in o) ent.c[o.comp] = clone(o.value); return; }
      if (o.comp === undefined) { if (id !== "@world") ent = undefined; return; }
      delete ent.c[o.comp]; }); }
  return ent;
}

// ---------- undo (by act; the inverse goes through admit like any write: rank and locks NOW) ----------
function buildUndo(ctx, a, w) {
  const X = actIndexOf(w); const E = w.entries;
  const mine = X.actsOf.get(ctx.actor) ?? [];
  const bodyOf = (seq) => (X.purged.has(seq) ? null : E[seq].body); // a purged act's request can't be read, or matched by label
  const result = (seq) => { const r = X.resultOf.get(seq); return r === undefined ? undefined : E[r]; };
  const pick = (pred) => { for (let k = mine.length - 1; k >= 0; k--) if (pred(mine[k])) return E[mine[k]]; return undefined; };
  const target = a.act !== undefined ? (mine.includes(a.act) ? E[a.act] : undefined)
    : a.label ? pick((q) => bodyOf(q)?.request?.label === a.label && !X.undone.has(q))
    : pick((q) => E[q].verb !== "undo" && E[q].verb !== "new" && !X.undone.has(q) && X.resultOf.has(q));
  if (!target) { const last = X.lastAct === null ? null : E[X.lastAct];
    refuse("nothing", "nothing of yours to undo" + (last && last.actor !== ctx.actor ? ` (the latest change was ${last.actor}'s; undo only reverts your own)` : ""), "history shows who did what; to change someone else's work, edit it (they'll see it)"); }
  if (target.verb === "new") refuse("founding", "founding a world can't be undone", "§2.3: @world can't be deleted or undone as a whole; to hand it over, give the new owner their role first");
  if (X.undone.has(target.seq)) refuse("nothing", `act ${target.seq} was already undone`, "");
  if (["throw", "drop", "leave"].includes(target.verb)) refuse("physical", `that was a ${target.verb}: what it changed is where things came to rest, which physics decided`, "put it back yourself: grab it, then put {id, pos}");
  const res = result(target.seq); if (!res) refuse("nothing", "that act changed nothing", "");
  const now = ctx.st; const beforeOf = new Map(); const before = (id) => { if (!beforeOf.has(id)) beforeOf.set(id, entityBefore(w, id, target.seq, X)); return beforeOf.get(id); };
  const flat = opsOf(res);
  // what others wrote since: a thing's own later history (touch), and, for the spatial check, every state entry since
  // the result (bounded by what happened after the act, never the log before it)
  const others = (i) => E[i].actor !== ctx.actor;
  const touchedBy = (id, comp) => { const h = X.touch.get(id) ?? []; for (let k = firstAfter(h, res.seq); k < h.length; k++) { const e = E[h[k]]; if (!others(h[k])) continue;
    for (const o of opsQuiet(e)) if (o.id === id && (comp === undefined || o.comp === comp || o.comp === undefined || o.verb === "create")) return e.actor; } return null; };
  const later = X.states.slice(firstAfter(X.states, res.seq)).filter(others).map((i) => E[i]);
  const groups = [], skipped = [];
  const keys = new Map();
  const madeHere = new Set(flat.filter((o) => o.verb === "create").map((o) => o.id)); // undone as one unit: the whole thing goes
  for (const o of flat) { if (madeHere.has(o.id) && o.verb !== "create") continue;
    const k = o.id + "|" + (o.verb === "set" || (o.verb === "delete" && o.comp !== undefined) ? o.comp : "*"); if (!keys.has(k)) keys.set(k, o); }
  for (const [, o] of [...keys].reverse()) {
    const { id, comp } = o; const whole = o.verb === "create" || (o.verb === "delete" && comp === undefined);
    const by = touchedBy(id, whole ? undefined : comp);
    if (by) { skipped.push({ id, component: comp, why: `${by} changed it since` }); continue; }
    if (o.verb === "create") { if (now.entities[id]) groups.push([delOp(id)]); }
    else if (whole) { const old = before(id); if (old && !now.entities[id]) groups.push(createOps(id, Object.fromEntries(Object.entries(old.c).filter(([, v]) => v !== PURGED)))); }
    else { const old = before(id)?.c[comp];
      if (old === PURGED) { skipped.push({ id, component: comp, why: "its old value was purged" }); continue; }
      if (old === undefined) { if (now.entities[id] && comp in now.entities[id].c) groups.push([delOp(id, comp)]); }
      else if (now.entities[id]) groups.push([setOp(id, comp, old)]); }
    ctx.refs.add(id);
  }
  // an undo must not land my old state on someone else's later work (spatial conflict, not just same-component)
  const othersSince = new Set(later.flatMap((e) => opsQuiet(e).map((o) => o.id)));
  for (let i = groups.length - 1; i >= 0; i--) { const g = groups[i]; const o = g.at(-1);
    if (!(g[0].verb === "create" || (o.verb === "set" && ["transform", "parent"].includes(o.comp)))) continue;
    const trial = scratch(now, g); const mine = obbs(trial, o.id);
    const hit = [...othersSince].find((x) => x !== o.id && trial.entities[x] && obbs(trial, x).some((sb) => mine.some((ma) => satDepth(ma, sb) > 0.02)));
    if (hit) { const who = later.find((e) => opsQuiet(e).some((q) => q.id === hit))?.actor;
      skipped.push({ id: o.id, component: o.comp, why: `putting it back would land it on ${hit}, which ${who} has placed since` }); groups.splice(i, 1); } }
  if (!groups.length) refuse("conflict", "everything that act touched has been changed by someone else since", "", { skipped });
  if (skipped.length) ctx.notes.push({ skipped });
  ctx.actExtra = { undoes: target.seq };
  return groups.flat();
}

// ---------- blueprints ----------
const libKey = (h) => `library:${String(h).replace(/^sha256:/, "")}`;
const inLibrary = (st, h) => !!st.entities["@world"]?.c[libKey(h)];
function buildPublish(ctx, a, w) {
  const roots = Array.isArray(a.from) ? a.from : [a.from];
  for (const r of roots) if (!ctx.st.entities[r]) refuse("not-found", `no '${r}'`, "look lists what's here", { didYouMean: guess(r, Object.keys(ctx.st.entities)) });
  if (roots.length > 1) return publishGroup(ctx, a, w, roots);
  const ids = [a.from, ...descendants(ctx.st, a.from)];
  const keyOf = (id) => ctx.st.entities[id].c.blueprint?.key ?? id;
  const parts = ids.map((id) => { const c = clone(ctx.st.entities[id].c); delete c.blueprint;
    if (id === a.from) { delete c.parent; c.transform = { ...c.transform, pos: [0, 0, 0] }; }
    else if (c.parent) c.parent = { ...c.parent, to: keyOf(c.parent.to) };
    return { key: keyOf(id), components: c }; });
  const record = { name: a.name ?? a.from, root: keyOf(a.from), parts, by: ctx.actor };
  const hash = w.putBlob(record);
  ctx.notes.push({ record: hash, parts: parts.length });
  ctx.refs.add("@world");
  return [setOp("@world", libKey(hash), { name: record.name, parts: parts.length })]; // who published it is a view (creatorOf), never stored (L2)
}
function publishGroup(ctx, a, w, roots) {
  // a group of siblings: the record gets a root part at their footprint centre on the ground; the world is untouched
  const keyOf = (id) => ctx.st.entities[id].c.blueprint?.key ?? id;
  const ws = roots.map((r) => worldT(ctx.st, r).pos); const cx = ws.reduce((t, p) => t + p[0], 0) / ws.length, cz = ws.reduce((t, p) => t + p[2], 0) / ws.length;
  const all = [...new Set(roots.flatMap((r) => [r, ...descendants(ctx.st, r)]))];
  const parts = [{ key: "root", components: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, label: a.name } },
    ...all.map((id) => { const c = clone(ctx.st.entities[id].c); delete c.blueprint;
      if (roots.includes(id)) { const t = worldT(ctx.st, id); c.transform = { ...t, pos: [r3(t.pos[0] - cx), r3(t.pos[1]), r3(t.pos[2] - cz)] }; c.parent = { to: "root", order: "a0" }; }
      else c.parent = { ...c.parent, to: keyOf(c.parent.to) };
      return { key: keyOf(id), components: c }; })];
  const record = { name: a.name ?? "group", root: "root", parts, by: ctx.actor };
  const hash = w.putBlob(record); ctx.notes.push({ record: hash, parts: parts.length, roots: roots.length }); ctx.refs.add("@world");
  return [setOp("@world", libKey(hash), { name: record.name, parts: parts.length })]; // who published it is a view (creatorOf), never stored (L2)
}
// Ids for a copy's parts: minted, so they follow §2.3; which part is which lives in each part's blueprint.key.
function partIds(st, copy, rootKey, keys) {
  const map = new Map([[rootKey, copy]]); const used = new Set(Object.keys(st.entities)); used.add(copy);
  for (const k of keys) { if (map.has(k)) continue; let id = `${copy}-${slug(k)}`.slice(0, 64); let n = 2;
    while (used.has(id) || !isEntityId(id)) id = `${copy}-${slug(k)}`.slice(0, 60) + `-${n++}`; used.add(id); map.set(k, id); }
  return map;
}
// Offer a newer record to a copy: per-part, per-component, per-FIELD three-way merge (R13). base = the copy's record,
// mine = the copy now, theirs = the new record. Recorded as plain results; never re-derived on replay.
function buildUpdate(ctx, a, w) {
  const root = ctx.st.entities[a.copy]; if (!root?.c.blueprint) refuse("not-a-copy", `${a.copy} isn't a blueprint copy`, "");
  let base, theirs; try { base = w.getBlob(root.c.blueprint.from); theirs = w.getBlob(a.to); } catch { refuse("not-found", "unknown record", "find {kind: 'blueprint'}"); }
  if (!inLibrary(ctx.st, a.to)) refuse("not-in-library", `${a.to} isn't in this world's library`, "");
  const have = new Map(); for (const id of [a.copy, ...descendants(ctx.st, a.copy)]) { const k = ctx.st.entities[id].c.blueprint?.key; if (k !== undefined && !have.has(k)) have.set(k, id); }
  const fresh = partIds(ctx.st, a.copy, base.root, theirs.parts.map((p) => p.key).filter((k) => !have.has(k)));
  const idOf = (key) => (key === base.root ? a.copy : have.get(key) ?? fresh.get(key));
  const B = Object.fromEntries(base.parts.map((p) => [p.key, p.components])), T = Object.fromEntries(theirs.parts.map((p) => [p.key, p.components]));
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const ops = [], conflicts = [], kept = [], orphaned = [];
  const skipComp = new Set(["blueprint", "parent"]);
  for (const key of new Set([...Object.keys(B), ...Object.keys(T)])) {
    const id = idOf(key), mineE = ctx.st.entities[id];
    if (!B[key]) { const c = clone(T[key]); if (c.parent) c.parent = { ...c.parent, to: idOf(c.parent.to) }; c.blueprint = { from: a.to, key };
      ops.push(...createOps(id, c)); continue; }
    if (!T[key]) { if (mineE && Object.keys(B[key]).every((k) => skipComp.has(k) || eq(B[key][k], mineE.c[k]))) ops.push(delOp(id)); else if (mineE) orphaned.push(id); continue; }
    if (!mineE) { kept.push({ id, why: "you deleted it in this copy" }); continue; }
    for (const comp of new Set([...Object.keys(B[key]), ...Object.keys(T[key])])) {
      if (skipComp.has(comp) || (key === base.root && comp === "transform")) continue;
      const b = B[key][comp], t = T[key][comp], m = mineE.c[comp];
      if (eq(b, t)) continue; // nothing new upstream
      if (eq(m, b)) { ops.push(t === undefined ? delOp(id, comp) : setOp(id, comp, t)); continue; }
      if (eq(m, t)) continue;
      const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
      if (isObj(b) && isObj(t) && isObj(m)) { // field level
        const out = clone(m); const clash = [];
        for (const f of new Set([...Object.keys(b), ...Object.keys(t)])) { if (eq(b[f], t[f])) continue; if (eq(m[f], b[f])) { if (t[f] === undefined) delete out[f]; else out[f] = clone(t[f]); } else if (!eq(m[f], t[f])) clash.push(f); }
        if (clash.length) conflicts.push({ id, component: comp, fields: clash, yours: Object.fromEntries(clash.map((f) => [f, m[f]])), theirs: Object.fromEntries(clash.map((f) => [f, t[f]])) });
        if (!eq(out, m)) ops.push(setOp(id, comp, out)); else if (!clash.length) kept.push({ id, component: comp });
      } else conflicts.push({ id, component: comp, yours: m, theirs: t });
    }
  }
  if (conflicts.length && !a.resolve) refuse("conflicts", `${conflicts.length} part(s) changed both here and upstream`, "re-send with resolve: {\"<id>.<component>.<field>\": \"yours\"|\"theirs\"} or dry: true to see the merge", { conflicts });
  for (const c of conflicts) { const id = c.id; for (const f of c.fields ?? [null]) { const choice = a.resolve?.[f ? `${id}.${c.component}.${f}` : `${id}.${c.component}`] ?? "yours";
      if (choice === "theirs") { const cur = ops.findLast((o) => o.id === id && o.comp === c.component)?.value ?? clone(ctx.st.entities[id].c[c.component]);
        const v = f ? { ...cur, [f]: c.theirs[f] } : c.theirs; ops.push(setOp(id, c.component, v)); } } }
  ops.push(setOp(a.copy, "blueprint", { ...root.c.blueprint, from: a.to }));
  if (orphaned.length) ctx.notes.push({ orphaned, why: "gone upstream but you changed them here: kept, still yours" });
  if (kept.length) ctx.notes.push({ keptYours: kept });
  for (const o of ops) ctx.refs.add(o.id);
  return ops;
}
// L1: a copy is expanded by the door into an explicit batch. The fold never reads the record.
function buildCreateFrom(ctx, a) {
  const w = ctx.w; let rec;
  try { rec = w.getBlob(a.from); } catch { refuse("not-found", `no blueprint ${a.from}`, "find {kind: 'blueprint'} lists this world's library"); }
  if (!inLibrary(ctx.st, a.from)) refuse("not-in-library", `${a.from} isn't in this world's library`, "publish it here first");
  const id = a.id ?? mint(ctx.st, rec.name);
  if (!isEntityId(id) || id === "@world") refuse("shape", `'${id}' isn't an id you can make`, "§2.3: a–z, 0–9 and '-', up to 64; or leave id out");
  if (ctx.st.entities[id]) refuse("exists", `'${id}' already exists`, "choose another id for the copy");
  const ids = partIds(ctx.st, id, rec.root, rec.parts.map((p) => p.key));
  const ops = [];
  for (const p of rec.parts) { const c = clone(p.components);
    if (p.key === rec.root) c.transform = resolve(ctx, id, "transform", { ...c.transform, ...(a.at ?? {}) });
    if (c.parent) c.parent = { ...c.parent, to: ids.get(c.parent.to) };
    c.blueprint = { from: a.from, key: p.key };
    ops.push(...createOps(ids.get(p.key), c)); ctx.refs.add(ids.get(p.key)); }
  return ops;
}

// ---------- reads ----------
function describe(st, id, live = {}, holds = {}) {
  const e = st.entities[id]; const t = worldT(st, id);
  return { id, name: e.c.label ?? modelOf(e.c.model)?.label ?? e.c.model ?? id, at: t.pos.map((n) => Math.round(n * 100) / 100),
    ...(live[id] ? { moving: live[id] } : {}), ...(holds[id] ? { heldBy: holds[id].by, heldAt: holds[id].pose.pos.map((n) => Math.round(n * 100) / 100) } : {}),
    ...(actionsOf(st, id).length ? { actions: actionsOf(st, id) } : {}), ...(e.c.parent ? { in: e.c.parent.to } : {}), ...(lockedC(e.c) ? { lock: true } : {}), ...(e.c.door && typeof e.c.door === "object" ? { door: e.c.door } : {}) };
}

// ---------- physics (design 20) ----------
const REACH = 1.5;   // m from your body: arm plus a step
const HAND_Y = 1.1; // where a held thing sits above your feet
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const handOf = (me) => [me.at[0], me.at[1] + HAND_Y, me.at[2]]; // reach is measured from the hand, not the feet
// P5 + L3: the sequencer logs where unheld motion came to rest. The rest is the engine's value and nothing else: its
// cause is the launch, it goes through admit like every write, and admit checks it against the engine. The engine
// digest is its own `sim` entry. Whatever the door then does about it (attach it to what it rests on, return a thing
// that left the world) is a SEPARATE entry caused by a door act, so a rest and a correction never look alike.
function settleSim(w) {
  const skip = new Set(); w.unsettled = [];
  for (let guard = 0; guard < 64; guard++) {
    const sf = w.sim(); const r = sf.rested.find((x) => !skip.has(`${x.id}@${x.seq}`)); if (!r) return;
    const st = w.state(); const t = worldT(st, r.id);
    const ops = [...(st.entities[r.id].c.parent ? [delOp(r.id, "parent")] : []), setOp(r.id, "transform", { pos: r.p.slice(), q: t.q, scale: t.scale })];
    let plan; try { plan = admit(w, st, { actor: "sim", cap: { kind: "rest", ids: [r.id], comps: ["transform", "parent"], launch: r.seq } }, ops); }
    catch (e) { if (!(e instanceof Refusal)) throw e; w.unsettled.push({ id: r.id, launch: r.seq, refused: e.code, reason: e.reason }); skip.add(`${r.id}@${r.seq}`); continue; } // 33 F2: one refused rest must never stall every later one
    w.append({ kind: "sim", actor: "sim", cause: r.seq, verb: "digest", body: { digest: digestOf(sf.sim) } });
    const rest = stateEntry(w, plan, r.seq);
    const st2 = w.state(); const B = st2.entities["@world"]?.c.bounds;
    if (B && (r.p[0] < B.min[0] || r.p[0] > B.max[0] || r.p[2] < B.min[2] || r.p[2] > B.max[2])) {
      // it landed outside the world: lost. The door returns it to where it was picked up, as its own act.
      const old = st.entities[r.id].c; const back = [setOp(r.id, "transform", old.transform), ...(old.parent ? [setOp(r.id, "parent", old.parent)] : [])];
      const p2 = admit(w, st2, { actor: "door", cap: { kind: "door", ids: [r.id], comps: ["transform", "parent"] } }, back);
      stateEntry(w, p2, w.append(actEntry(w, "door", "return-lost", { id: r.id, rest })));
      continue;
    }
    // it rests ON something: name that as its parent, as place does, so it rides with it (the relation is the door's word)
    const fam = new Set([r.id, ...descendants(st2, r.id)]); const sup = supportBelow(st2, r.p[0], r.p[2], r.p[1] + 0.02, fam);
    if (sup.id === "ground") continue;
    const wt = worldT(st2, r.id); const s3 = scratch(st2, [setOp(r.id, "parent", { to: sup.id })]);
    const attach = [setOp(r.id, "parent", { to: sup.id, order: "a0" }), setOp(r.id, "transform", localFrom(s3, sup.id, wt))];
    const p3 = admit(w, st2, { actor: "door", cap: { kind: "door", ids: [r.id], comps: ["transform", "parent"] } }, attach);
    stateEntry(w, p3, w.append(actEntry(w, "door", "settle", { id: r.id, onto: sup.id, rest })));
  }
}
// P6: an engine change is a real cut. At rest the cut is free (the log already holds every result); in flight it waits.
function buildEpoch(ctx, v, a) {
  const sf = ctx.w.sim(); const live = [...new Set([...Object.keys(livePoses(sf)), ...sf.rested.map((r) => r.id)])]; // at rest but not on the record counts (33 F2): P6's "free" needs every result logged
  if (live.length && !a.force) refuse("busy", `${live.length} thing(s) are still in flight or not yet on the record (${live.join(", ")}); all at rest in about ${r3((restEta(sf) ?? 0) / 1000)} s`, "try again then, or force: true to freeze them where they are now (they'll be logged there)");
  const ops = live.map((id) => setOp(id, "transform", { ...worldT(sf.st, id), pos: sf.sim.bodies[id].p.slice() }));
  for (const id of live) ctx.refs.add(id);
  if (live.length) ctx.notes.push({ frozen: live, why: "forced cut: stopped mid-air and logged where they were" });
  if (v === null) return [...ops, delOp("@world", "sim")];
  if (!v || typeof v.engine !== "string") refuse("shape", "sim needs {engine, tickMs?}", `engines this server carries: ${Object.keys(ENGINES).join(", ")}`);
  const known = ENGINES[v.engine];
  const spec = { engine: v.engine, build: v.build ?? known?.build ?? null, tickMs: Number.isInteger(v.tickMs) ? v.tickMs : 33 };
  if (!known) refuse("unknown-engine", `this server doesn't carry '${v.engine}'`, `it carries: ${Object.keys(ENGINES).join(", ")}`, { didYouMean: guess(v.engine, Object.keys(ENGINES)) });
  if (v.build === undefined) ctx.notes.push({ component: "sim", field: "build", kept: spec.build, why: "stamped: determinism belongs to one exact build, so the epoch names it" });
  if (!carried(spec)) ctx.notes.push({ component: "sim", why: "that build isn't carried here: nothing will be thrown in this world until a server that carries it runs it" });
  ctx.refs.add("@world");
  return [...ops, setOp("@world", "sim", spec)];
}
function body(w, actor) {
  const b = w.presence.bodies[actor];
  if (!b) refuse("not-here", "your body isn't in the world yet", "move {to: [x, y, z]} puts it somewhere (bodies are presence: never logged)");
  return b;
}
function holdOf(w, actor, id) {
  const h = w.presence.holds[id];
  if (!h || h.by !== actor) refuse("not-holding", `you aren't holding ${id}${h ? ` (${h.by} is)` : ""}`, `grab {id: '${id}'} first`);
  if (!w.state().entities[id]) { delete w.presence.holds[id]; w.savePresence(); refuse("gone", `${id} was deleted while you held it`, "your hand is empty now"); }
  return h;
}
// L6 / 25d M3: the door's own plausibility TRACK of each body (presence: unlogged). A body is where the door last
// ACCEPTED it, never where a client last claimed. Walking spends a token bucket (SPEED m/s sustained, CAP m of
// burst) and may not enter a solid a body can't step over; a refused step leaves the body where it was (reverted for
// its sender, visibly). Arriving, or `teleport: true`, is a teleport: an ACT on the record (it resets the track), refused
// while holding anything, refused inside a solid, and (for visitors) refused away from @world.spawn when the world
// declares one. Every settlement (grab, put, throw) measures reach from the track and records the presence it used.
const TRACK = { speed: 6, cap: 4, step: 0.8, radius: 0.2, height: 1.7, spawnR: 2 };
function bodyBox(p) { return { min: [p[0] - TRACK.radius, p[1] + TRACK.step, p[2] - TRACK.radius], max: [p[0] + TRACK.radius, p[1] + TRACK.height, p[2] + TRACK.radius] }; }
function solidAt(w, st, p, except = new Set()) {
  const box = bodyBox(p); const held = new Set(Object.keys(w.presence.holds));
  for (const id of Object.keys(st.entities)) { if (id === "@world" || held.has(id) || except.has(id) || !geomOf(st.entities[id].c.model)) continue; if (hits(box, st, id, 0.01)) return id; }
  return null;
}
function pathBlocked(w, st, from, to) {
  const already = new Set(); const b0 = bodyBox(from); // a body already inside something may walk out of it
  for (const id of Object.keys(st.entities)) if (geomOf(st.entities[id].c.model) && hits(b0, st, id, 0.01)) already.add(id);
  const n = Math.max(1, Math.ceil(dist(from, to) / 0.05));
  for (let k = 1; k <= n; k++) { const p = from.map((v, i) => v + (to[i] - v) * k / n); const hit = solidAt(w, st, p, already); if (hit) return hit; }
  return null;
}
const presenceFacts = (me) => ({ at: me.at.slice(), hand: handOf(me).map(r3), trackTs: me.ts });
const PHYSICS_TOOLS = {
  move(w, actor, a) {
    if (!Array.isArray(a.to) || a.to.length !== 3 || a.to.some((n) => !Number.isFinite(n))) refuse("shape", "move needs to: [x, y, z]", "");
    const st = w.state(); const B = st.entities["@world"]?.c.bounds;
    if (B && (a.to[0] < B.min[0] || a.to[0] > B.max[0] || a.to[2] < B.min[2] || a.to[2] > B.max[2])) refuse("out-of-bounds", `[${a.to.join(", ")}] is outside this world (x ${B.min[0]}…${B.max[0]}, z ${B.min[2]}…${B.max[2]})`, "pick a spot inside the bounds");
    const me = w.presence.bodies[actor]; const now = w.now(); const to = a.to.slice();
    if (!me || a.teleport === true) { // a teleport (arriving is one): an act, so the track's reset is on the record
      const mine = Object.entries(w.presence.holds).filter(([, h]) => h.by === actor).map(([id]) => id);
      if (mine.length) refuse("holding", `you're holding ${mine.join(", ")}; a teleport can't carry things`, "put it down (or walk it there) first", { at: me?.at });
      const inSolid = solidAt(w, st, to); if (inSolid) refuse("solid", `[${to.join(", ")}] is inside ${inSolid}`, "arrive somewhere a body fits", { at: me?.at });
      const sp = st.entities["@world"]?.c.spawn;
      if (sp && Array.isArray(sp.pos) && RANK[roleOf(st, actor)] < RANK.builder && dist(sp.pos, to) > (sp.radius ?? TRACK.spawnR))
        refuse("spawn", `this world's arrivals are within ${sp.radius ?? TRACK.spawnR} m of [${sp.pos.join(", ")}]`, "arrive there, then walk", { at: me?.at });
      rateCheck(w, actor);
      const act = w.append(actOf(w, actor, "move", a, { presence: { from: me?.at ?? null, to, arrival: !me } }));
      w.presence.bodies[actor] = { at: to, ts: now, tokens: TRACK.cap }; w.savePresence();
      return { ok: true, recorded: true, act, at: to };
    }
    const d = dist(me.at, to); const tokens = Math.min(TRACK.cap, (me.tokens ?? TRACK.cap) + TRACK.speed * Math.max(0, now - (me.ts ?? now)) / 1000);
    if (d > tokens + 1e-9) refuse("too-fast", `that's ${r3(d)} m; right now your body can cover ${r3(tokens)} m (${TRACK.speed} m/s, ${TRACK.cap} m at most in one go)`, "walk there in steps, or move {to, teleport: true} (an act on the record; not while holding anything)", { at: me.at });
    const block = pathBlocked(w, st, me.at, to);
    if (block) refuse("solid", `${block} is in the way`, "walk around it (or through a door someone opens)", { at: me.at });
    const prev = me.at; w.presence.bodies[actor] = { at: to, ts: now, tokens: tokens - d };
    const carrying = [];
    for (const [id, h] of Object.entries(w.presence.holds)) if (h.by === actor) { h.pose.pos = h.pose.pos.map((n, i) => n + to[i] - prev[i]); carrying.push(id); }
    w.savePresence();
    return { ok: true, recorded: false, at: to, ...(carrying.length ? { carrying } : {}) };
  },
  grab(w, actor, a) {
    const me = body(w, actor); const sf = w.sim(); const st = w.state(); const e = st.entities[a.id];
    if (!e) refuse("not-found", `no '${a.id}'`, "look lists what's here", { didYouMean: guess(a.id, Object.keys(st.entities)) });
    const held = w.presence.holds[a.id];
    if (held?.by === actor) return { ok: true, recorded: false, holding: a.id, inHandAt: held.pose.pos.map(r3), note: "you're already holding it" };
    const ph = e.c.physics;
    if (ph?.kind !== "dynamic") refuse("not-dynamic", `${a.id} isn't something you can pick up`, `a builder can make it so: set {id: '${a.id}', component: 'physics', value: {kind: 'dynamic'}}`);
    const need = ph.who ?? "builder"; if (RANK[roleOf(st, actor)] < RANK[need]) refuse("rights", `only a ${need} may pick up ${a.id}`, "ask someone who can, or ask the owner to set physics.who: 'visitor'");
    for (const k of [a.id, ...ancestors(st, a.id)]) if (lockedC(st.entities[k]?.c)) refuse("locked", `${k === a.id ? `${a.id} is locked` : `${a.id} is attached to ${k}, which is locked`}, so it can't be picked up`, `a builder or owner can unlock it first: delete {id: '${k}', component: 'lock'}`, { lock: k });
    const live = livePoses(sf)[a.id]; const t = worldT(st, a.id); const here = held ? held.pose.pos : live ? live.pos : t.pos; // where it IS: someone's hand, the air, or the log
    const d = dist(handOf(me), here); if (d > REACH) refuse("out-of-reach", `${a.id} is ${r3(d)} m from you; you can reach ${REACH} m`, `move {to: [${r3(here[0])}, ${me.at[1]}, ${r3(here[2])}]} (your feet stay on the floor; your hand reaches ${HAND_Y} m up) first`);
    const prev = w.presence.holds[a.id]; const notes = [];
    if (prev && prev.by !== actor) notes.push({ id: a.id, takenFrom: prev.by, why: "the latest grab wins; they were told" });
    // what rested on it (and isn't its child, which rides along) loses its support (playtest 22, F3)
    const fam = new Set([a.id, ...descendants(st, a.id)]);
    const dependents = live ? [] : Object.keys(st.entities).filter((k) => { if (fam.has(k)) return false; const b = aabb(st, k);
      return b && !st.entities[k].c.parent && supportUnder(st, b, new Set([k, ...descendants(st, k)])).id === a.id; });
    for (const k of dependents) { const pk = st.entities[k].c.physics; const role = roleOf(st, actor);
      const lockK = [k, ...ancestors(st, k)].find((x) => lockedC(st.entities[x]?.c)); if (lockK) refuse("locked", `${k} rests on ${a.id}, and ${lockK === k ? "it" : lockK} is locked, so picking ${a.id} up would move it`, `take ${k} off first, or unlock ${lockK} (delete {id: '${lockK}', component: 'lock'})`, { lock: lockK });
      if (RANK[role] < RANK.builder && !(pk?.kind === "dynamic" && RANK[role] >= RANK[pk.who ?? "builder"])) refuse("rights", `${k} rests on ${a.id}, and you can't move ${k}`, "picking it up would move what's on it; ask someone who can to take it off first"); }
    const spec = st.entities["@world"]?.c.sim;
    // without physics, dependents are set straight down: a write, so it is admitted first (all or nothing)
    let plan = null;
    if (dependents.length && !(spec && carried(spec))) {
      const ops = dependents.map((k) => { const b = aabb(st, k); const below = supportUnder(st, b, new Set([k, ...fam, ...descendants(st, k)])); const tk = worldT(st, k);
        return setOp(k, "transform", { ...tk, pos: [tk.pos[0], r3(tk.pos[1] - (b.min[1] - below.y)), tk.pos[2]] }); });
      plan = admit(w, st, { actor, cap: { kind: "door", ids: dependents, comps: ["transform"] } }, ops);
    }
    // picking a thing up takes it out of the world's physics (no collider left at its old spot), and that changes the
    // sim, so it goes through the log (Covenant III: presence never feeds the sim otherwise)
    let act = null;
    if ((spec && carried(spec)) || dependents.length) rateCheck(w, actor); // this grab will be logged
    const actOnce = () => (act ??= w.append(actOf(w, actor, "grab", a, { presence: presenceFacts(me) })));
    if (spec && carried(spec)) { w.append({ kind: "sim", actor, cause: actOnce(), verb: live ? "catch" : "lift", body: { id: a.id } });
      if (live) notes.push({ id: a.id, why: "caught it in the air (logged: the sim had it)" }); }
    if (dependents.length) {
      if (spec && carried(spec)) {
        for (const k of dependents) w.append({ kind: "sim", actor, cause: actOnce(), verb: "launch", body: { id: k, p: worldT(st, k).pos.slice(), yaw: qYaw(worldT(st, k).q), v: [0, 0, 0], handled: [actor] } });
        notes.push({ fell: dependents, why: `they were resting on ${a.id}; picking it up let them fall (physics will log where they land)` });
      } else {
        stateEntry(w, plan, actOnce());
        notes.push({ setDown: dependents, why: `they were resting on ${a.id}; with no physics running they were set straight down` });
      }
    }
    const handled = [...new Set([...(prev?.handled ?? []), actor])];
    const hand = handOf(me); // in your hand now (a VR client would send the hand's pose)
    w.presence.holds[a.id] = { by: actor, since: w.now(), pose: { pos: hand, q: t.q, scale: t.scale }, handled };
    w.savePresence();
    return { ok: true, recorded: act !== null, holding: a.id, inHandAt: hand.map(r3), ...(notes.length ? { notes } : {}) };
  },
  // P3: putting something down is a settlement: a claim the door checks like any write, then logs as a plain result.
  put(w, actor, a) {
    const me = body(w, actor); const h = holdOf(w, actor, a.id);
    const st = w.state(); const t = worldT(st, a.id);
    let pos = a.pos;
    if (pos === undefined) { // no pose given: straight down from where it's held, onto what's below (the door resolves)
      const fam = new Set([a.id, ...descendants(st, a.id)]); const sup = supportBelow(st, h.pose.pos[0], h.pose.pos[2], h.pose.pos[1], fam);
      pos = [r3(h.pose.pos[0]), sup.y, r3(h.pose.pos[2])]; }
    if (!Array.isArray(pos) || pos.length !== 3 || pos.some((n) => !Number.isFinite(n))) refuse("shape", "put takes pos: [x, y, z] (or nothing: straight down)", "");
    const d = dist(handOf(me), pos); if (d > REACH) refuse("out-of-reach", `that's ${r3(d)} m from you; you can reach ${REACH} m`, "move closer first");
    const q = a.q ?? h.pose.q; const value = { pos, q, scale: t.scale };
    const ops = [...(st.entities[a.id].c.parent ? [delOp(a.id, "parent")] : []), setOp(a.id, "transform", value)];
    // the one gate first (your role and its locks NOW, not when you picked it up), then the physical claim on top
    const plan = admit(w, st, { actor, cap: { kind: "handle", ids: [a.id], comps: ["transform", "parent"] } }, ops);
    const bad = warnings(plan.after, [a.id]);
    if (bad.length) refuse("implausible", `physics wouldn't leave ${a.id} there: ${bad.map((b) => b.kind + (b.with ? ` ${b.with}` : b.above ? ` above ${b.above}` : b.into ? ` into ${b.into}` : "")).join("; ")}`, "a settlement is a claim the door checks; put it where it would really rest, or leave pos out to set it straight down", { problems: bad });
    const act = w.append(actOf(w, actor, "put", a, { handled: h.handled, presence: { ...presenceFacts(me), held: h.pose.pos.map(r3) } }));
    const seq = stateEntry(w, plan, act);
    delete w.presence.holds[a.id]; w.savePresence();
    return { ok: true, seq, act, settled: { id: a.id, pos }, handled: h.handled };
  },
  throw(w, actor, a) { return launch(w, actor, a, "throw"); },
  drop(w, actor, a) {
    if (!w.state().entities["@world"]?.c.sim) return PHYSICS_TOOLS.put(w, actor, { id: a.id });
    return launch(w, actor, { ...a, v: [0, 0, 0] }, "drop");
  },
  // a holder who leaves: what they held is dropped (into the sim if there is one), attributed to them (orphans, 18a)
  leave(w, actor) {
    const mine = Object.entries(w.presence.holds).filter(([, h]) => h.by === actor).map(([id]) => id);
    w.leaving = actor; let out; try { out = mine.map((id) => ({ id, r: request(w, actor, "drop", { id }) })); } finally { w.leaving = null; }
    // L6: a disconnect settles at the last ACCEPTED state. A drop the gate refused (demoted, locked) leaves the thing
    // where the log last had it; if picking it up took it out of the engine, the door puts it back there, as its own act.
    for (const { id, r } of out) if (!r.ok && w.presence.holds[id]?.by === actor) { delete w.presence.holds[id];
      const st = w.state(); if (st.entities[id] && st.entities["@world"]?.c.sim) { const t = st.entities[id].c.transform;
        if (t) { const p = admit(w, st, { actor: "door", cap: { kind: "door", ids: [id], comps: ["transform"] } }, [setOp(id, "transform", t)]);
          stateEntry(w, p, w.append(actEntry(w, "door", "return-held", { id, holder: actor, why: r.refused?.code }))); } } }
    delete w.presence.bodies[actor]; w.savePresence();
    return { ok: true, left: true, dropped: out.map(({ id, r }) => ({ id, ok: r.ok, ...(r.refused ? { refused: r.refused.reason } : {}) })) };
  },
  wait(w) {
    const sf = w.sim(); const now = w.now();
    const rests = recentRests(w, now).map((r) => {
      const par = sf.st.entities[r.id]?.c.parent?.to;
      return { id: r.id, at: r.at.map(r3), ...(r.lost ? { lost: "landed outside the world; it's back where it was picked up" } : { on: par ?? "ground" }), secondsAgo: Math.round((now - r.when) / 1000) }; });
    const stuck = sf.rested.map((r) => ({ id: r.id, launch: r.seq, at: r.p.map(r3), why: (w.unsettled ?? []).find((u) => u.id === r.id)?.reason ?? "not yet logged" }));
    return { ok: true, inFlight: livePoses(sf), ...(rests.length ? { cameToRest: rests } : {}), ...(stuck.length ? { unsettled: stuck } : {}) };
  },
};
// The rests of the last minute, at most 8, oldest first: what restsOf(w.entries) gives filtered to that window, read
// from the act index's rest list backwards (ts never decreases along the log, so the window is a suffix).
function recentRests(w, now) {
  const X = actIndexOf(w); const E = w.entries; const out = [];
  for (let k = X.rests.length - 1; k >= 0 && out.length < 8; k--) { const seq = X.rests[k]; const e = E[seq]; const when = e.ts ?? 0;
    if (!(now - when < 60000)) break;
    const c = E[e.cause]; const op = opsQuiet(e).find((o) => o.comp === "transform" && o.id === c.body.id);
    const ai = X.restAfter.get(seq); const after = ai === undefined ? null : E[ai];
    out.push({ seq, id: c.body.id, cause: e.cause, at: op?.value?.pos, handled: c.body.handled ?? [c.actor], when,
      ...(after?.verb === "return-lost" ? { lost: true } : {}), ...(after?.verb === "settle" ? { onto: after.body.onto } : {}) }); }
  return out.reverse();
}
function launch(w, actor, a, tool) {
  const me = body(w, actor); const h = holdOf(w, actor, a.id);
  const spec = w.state().entities["@world"]?.c.sim;
  if (!spec) refuse("no-physics", "this world has no physics running, so nothing flies", "put it down instead (put {id}); the owner can turn physics on: set {id: '@world', component: 'sim', value: {engine: 'eidosim@0.5.0'}}");
  if (!carried(spec)) refuse("foreign-engine", `this world runs ${spec.engine} (build ${spec.build}), which this server doesn't carry`, "put it down instead");
  if (!Array.isArray(a.v) || a.v.length !== 3 || a.v.some((n) => !Number.isFinite(n))) refuse("shape", "throw needs v: [x, y, z] in m/s", "e.g. v: [0, 3, 4] tosses it up and forward (+z)");
  // L7 (33 F3): a launch writes no state now, but it decides a write (its rest). Admit the write it releases, as put
  // does: your role and its locks NOW, rate. The plan is a check only; the rest will be the engine's value.
  { const st = w.state(); const t = worldT(st, a.id);
    admit(w, st, { actor, cap: { kind: "handle", ids: [a.id], comps: ["transform", "parent"] } }, [...(st.entities[a.id].c.parent ? [delOp(a.id, "parent")] : []), setOp(a.id, "transform", { pos: h.pose.pos.map(r3), q: t.q, scale: t.scale })]); }
  const notes = []; let v = a.v; const sp = Math.hypot(...v), max = ENGINES[spec.engine].maxSpeed;
  if (sp > max) { v = v.map((n) => n * max / sp); notes.push({ field: "v", sent: a.v, kept: v.map(r3), why: `capped at ${max} m/s` }); }
  const act = w.append(actOf(w, actor, tool, a, { handled: h.handled, presence: presenceFacts(me) }));
  const seq = w.append({ kind: "sim", actor, cause: act, verb: "launch", body: { id: a.id, p: h.pose.pos.slice(), yaw: qYaw(h.pose.q), v, handled: h.handled } });
  delete w.presence.holds[a.id]; w.savePresence();
  return { ok: true, seq, act, flying: a.id, from: h.pose.pos.map(r3), ...(notes.length ? { notes } : {}), next: "wait (or any request) logs where it comes to rest" };
}
const TOOLS = {
  ...PHYSICS_TOOLS,
  new(w, actor, a) {
    if (w.exists) refuse("exists", `world '${w.name}' exists`, "you're in it already: look shows what's here; help shows your role");
    if (a.dry) return { ok: true, dry: true, would: { found: w.name, you: "owner", title: a.title ?? w.name } };
    // genesis seeds no state (§2.4): it names the governance keys. The founding act then writes @world, once.
    w.append({ kind: "genesis", actor: "door", verb: "genesis", body: { version: VERSION, owners: [actor] } });
    const ops = [setOp("@world", "about", { name: a.title ?? w.name, text: a.text ?? "" }), setOp("@world", "bounds", { min: [-20, 0, -20], max: [20, 12, 20] }),
      setOp("@world", `roles:${actor}`, { role: "owner" })];
    const plan = admit(w, w.state(), { actor, cap: { kind: "founding", ids: ["@world"], comps: ops.map((o) => o.comp) } }, ops);
    stateEntry(w, plan, w.append(actOf(w, actor, "new", a)));
    return { ok: true, world: w.name, you: "owner" };
  },
  help(w, actor, a) {
    if (a?.tool) return toolHelp(a.tool) ? { ok: true, ...toolHelp(a.tool) } : { ok: false, refused: { code: "no-detail", reason: `no detailed help for '${a.tool}' yet`, teach: `detailed: ${Object.keys(TOOLSPEC).join(", ")}` } };
    const st = w.exists ? w.state() : null; const role = st ? roleOf(st, actor) : "none";
    return { ok: true, world: st?.entities?.["@world"]?.c.about, you: { id: actor, role },
      tools: { read: ["look", "inspect {id}", "measure {id}", "find {kind: 'model'|'blueprint', query?}", "check {id?}", "history {limit?}", "schema {component?}"],
        world: ["new {title, text?} — found this world if it doesn't exist (you become its owner)"],
        write: ["create {id?, model?, components?} | {from: <blueprint>, id?, at?}", "set {id, component, value, merge?}", "delete {id} | {id, component}",
          "place {id, on|beside|hang|against|near|at, facing?, height?, along?, level?, offset?, side?, gap?, attach?}", "batch {ops: [{tool, args}…], label?}", "use {id, action?, args?}", "say {text, to?}",
          "undo {label?|act?}", "publish {from, name}", "update {copy, to, resolve?}"],
        body: ["move {to: [x, y, z]}", "grab {id}", "put {id, pos?}", "throw {id, v: [x, y, z]}", "drop {id}", "leave", "wait"],
        physics: "the world runs physics when @world has a sim component: set {id: '@world', component: 'sim', value: {engine: 'eidosim@0.5.0'}} (owner). A thing can be picked up when it has physics {kind: 'dynamic', who?: 'visitor'|'builder'}", every_write: "may add dry: true to preview, and through_lock: true to act through a lock you may remove (§5: a lock stops accidents and binds everyone, its locker included)", details: "help {tool: 'place'} (or create, set, delete, use, grab, put, throw) shows every argument with its type and an example" },
      world: st?.entities?.["@world"]?.c.about ?? { name: w.name } };
  },
  look(w, actor, a) {
    const st = w.state(); const ids = Object.keys(st.entities).filter((k) => k !== "@world" && !st.entities[k].c.parent);
    const lim = a.limit ?? 40;
    const live = livePoses(w.sim());
    const tree = (id, d) => [{ ...describe(st, id, live, w.presence.holds), depth: d }, ...Object.keys(st.entities).filter((k) => st.entities[k].c.parent?.to === id).flatMap((k) => tree(k, d + 1))];
    const all = ids.flatMap((id) => tree(id, 0));
    return { ok: true, things: all.slice(0, lim), ...(all.length > lim ? { truncated: true, total: all.length } : {}) };
  },
  inspect(w, actor, a) {
    const st = w.state(); const e = st.entities[a.id];
    if (!e) return { ok: false, refused: { code: "not-found", reason: `no '${a.id}'`, didYouMean: guess(String(a.id), Object.keys(st.entities)) } };
    const piv = e.c.motion?.type === "pendulum" ? pivotOf(st, a.id) : undefined;
    return { ok: true, ...describe(st, a.id, livePoses(w.sim()), w.presence.holds), born: e.born, components: e.c, versions: Object.fromEntries(Object.keys(e.c).map((k) => [k, lastTouch(w, a.id, k)?.seq])), world: worldT(st, a.id),
      derived: { madeBy: madeBy(w, a.id), ...(piv !== undefined ? { pivot: piv } : {}) },
      children: Object.keys(st.entities).filter((k) => st.entities[k].c.parent?.to === a.id), ...offersFor(st, a.id, actor), yourRole: roleOf(st, actor) };
  },
  measure(w, actor, a) {
    const st = w.state(); const b = aabb(st, a.id); if (!b) return { ok: false, refused: { code: "no-model", reason: `${a.id} has no model to measure` } };
    const t = worldT(st, a.id);
    return { ok: true, id: a.id, bounds: { min: b.min.map(r3), max: b.max.map(r3) }, size: b.max.map((v, i) => r3(v - b.min[i])),
      front: qrot(t.q, [0, 0, 1]).map(r3), surfaces: surfacesOf(st, a.id).map((s) => ({ level: s.level, y: r3(s.y), size: [r3(s.max[0] - s.min[0]), r3(s.max[1] - s.min[1])] })) };
  },
  find(w, actor, a) {
    const q = (a.query ?? "").toLowerCase();
    if (a.kind === "blueprint") { const lib = w.state().entities["@world"]?.c ?? {};
      return { ok: true, blueprints: Object.entries(lib).filter(([k]) => k.startsWith("library:")).map(([k, v]) => ({ hash: `sha256:${k.slice(8)}`, ...v, by: creatorOf(w, "@world", k)?.rights ?? null })).filter((b) => String(b.name ?? "").toLowerCase().includes(q)) }; }
    return { ok: true, models: CAT.list(q).slice(0, 50).map(([k, m]) => ({ model: k, ...(m.size ? { size: m.size } : { size: null, note: "not measured here" }), about: m.label, surfaces: (m.surfaces ?? []).map((s) => s.y), ...(m.sockets ? { seats: Object.keys(m.sockets) } : {}) })) };
  },
  check(w, actor, a) { const st = w.state(); return { ok: true, warnings: warnings(st, a.id ? [a.id] : Object.keys(st.entities)) }; },
  history(w, actor, a) { const from = Math.max(0, w.entries.length - (a.limit ?? 12)); return { ok: true, entries: w.entries.slice(from).map((e, k) => [e, from + k]).map(([e, seq]) => isE(e) ? { seq, actor: e.actor, kind: e.kind, verb: e.verb, ...(e.cause !== undefined ? { cause: e.cause } : {}), body: e.kind === "act" ? e.body : JSON.stringify(e.body).slice(0, 160) } : { seq, malformed: e.code }) }; },
  schema(w, actor, a) { return { ok: true, components: a.component ? { [a.component]: COMPONENTS[a.component] } : COMPONENTS }; },
  create: (w, actor, a) => commit(w, actor, "create", a, (ctx) => buildCreate(ctx, a)),
  set: (w, actor, a) => commit(w, actor, "set", a, (ctx) => buildSet(ctx, a)),
  delete: (w, actor, a) => commit(w, actor, "delete", a, (ctx) => buildDelete(ctx, a)),
  place: (w, actor, a) => commit(w, actor, "place", a, (ctx) => buildPlace(ctx, a)),
  publish: (w, actor, a) => commit(w, actor, "publish", a, (ctx) => buildPublish(ctx, a, w)),
  update: (w, actor, a) => commit(w, actor, "update", a, (ctx) => buildUpdate(ctx, a, w)),
  use(w, actor, a) {
    const probe = buildUse({ st: w.state(), actor, w, notes: [], refs: new Set() }, a);
    if (probe.presence) return { ok: true, recorded: false, note: probe.note };
    return commit(w, actor, "use", a, (ctx) => buildUse(ctx, a));
  },
  say(w, actor, a) { if (!a.text) refuse("shape", "say needs text", ""); rateCheck(w, actor); const seq = w.append({ kind: "say", actor, verb: "say", body: { text: a.text, ...(a.to ? { to: a.to } : {}) } }); return { ok: true, seq }; }, // w.append refuses too-big before writing
  undo: (w, actor, a) => commit(w, actor, "undo", a, (ctx) => buildUndo(ctx, a, w)),
  batch(w, actor, a) {
    return commit(w, actor, "batch", a, (ctx) => {
      const all = []; let st = ctx.st;
      (a.ops ?? []).forEach((o, i) => {
        const B = { create: buildCreate, set: buildSet, delete: buildDelete, place: buildPlace }[o.tool];
        if (!B) refuse("shape", `batch op ${i}: '${o.tool}' can't go in a batch`, "batch takes create, set, delete, place");
        const sub = { ...ctx, st };
        let ops; try { ops = B(sub, o.args ?? {}); } catch (e) { if (e instanceof Refusal) { e.op = i; } throw e; }
        all.push(...ops); st = scratch(st, ops); sub.refs.forEach((r) => ctx.refs.add(r));
        if (sub.cap) ctx.cap = sub.cap;
      });
      return all;
    });
  },
};
