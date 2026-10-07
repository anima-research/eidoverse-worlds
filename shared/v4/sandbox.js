// shared/v4/sandbox.js — the v4 script sandbox: real JavaScript in QuickJS compiled to WASM (research 41 §3.13, §6:
// a SEPARATE VM, never same-VM compartments; Figma's Realms scar). The authority never imports this file (browsers import the
// authority); a host injects `runScript` as io.scripts (server/v4/livehost.ts, server/v4/filehost.ts), and an auditor calls it
// directly to re-run an activation from what its act records (shared/v4/scriptaudit.js).
//
// One activation = one FRESH runtime and context: evaluate the source (which registers handlers with world.on), deliver
// the one event, collect the proposed writes. Nothing survives between activations, so a re-run from the act's inputs
// is the same run (41 §3.5: "a script must behave correctly if VM memory is lost": here it always is).
// Deterministic inputs only (41 §3.7):
//   clock    Date.now() and new Date() are frozen at `now` (the act's ts) for the whole activation;
//   random   Math.random is a PRNG seeded from `seed` (H(world ‖ act seq ‖ script key), recorded in the act);
//   world    reads see the folded head the activation was given, plus its own writes so far (read-your-writes);
//   presence world.near(r) / world.count() answers, and world.name(id) (the authority's directory, outside the log), are
//            RECORDED (`reads`) and, on a re-run, REPLAYED from the record;
//   nothing else: no timers, no network, no filesystem, no other clock.
// Metered by FUEL: QuickJS calls the interrupt handler every so many bytecode ticks; the count of calls is the fuel,
// deterministic for one QuickJS build (LIMITS.fuel). A wall-clock deadline is the backstop (host calls can't be
// interrupted); a run that hits it writes nothing, so an auditor never sees a partial result. Memory and native stack
// are capped per runtime.
//
// Where it runs: an authority runs the VM side in a sandbox PROCESS (runIsolated, sandbox-child.js) that it SIGKILLs at the
// deadline, because fuel and the wall clock bound BYTECODE only: QuickJS's interrupt handler never runs inside a native
// builtin, and one such call (String#indexOf on crafted text, BigInt toString, an out-of-memory inside Array#fill) once
// held the authority's thread for 1–13 s (review, 2026-10-06). The host side stays on the authority's thread, so an activation is
// still one synchronous step. runScript (in-process) is for auditors and tools, which may take their time.
import { jcs, isEntityId, isComponent } from "./fold.js";
import { LIMITS, isParamKey } from "./scriptrules.js";

let Q = null, unavailable = null;
try { const mod = await import("quickjs-emscripten"); Q = await mod.getQuickJS(); }
catch (e) { unavailable = String(e?.message ?? e).slice(0, 200); }
/** Is the sandbox here? (The authority says "unavailable" for every activation when it isn't.) */
export const sandboxAvailable = () => (Q ? true : unavailable);

// The whole script-facing API, in one place (docs: docs/SCRIPTS-v4.md). Runs inside the VM before the source.
const PRELUDE = String.raw`"use strict";
(() => {
  const host = globalThis.__host; delete globalThis.__host;
  const IN = JSON.parse(globalThis.__in); delete globalThis.__in;
  const NOW = IN.now;
  const RealDate = Date, P = RealDate.prototype;
  // every activation's time zone is UTC: the host's zone would leak into local-time methods and parsing, and a re-run on
  // another machine would disagree. Local-time methods ARE the UTC ones; a date-time string with no zone is read as UTC.
  const hostOffset = P.getTimezoneOffset;
  for (const k of ["FullYear", "Month", "Date", "Day", "Hours", "Minutes", "Seconds", "Milliseconds"]) { P["get" + k] = P["getUTC" + k]; if (k !== "Day") P["set" + k] = P["setUTC" + k]; }
  P.getTimezoneOffset = function getTimezoneOffset() { return 0; };
  const iso = (d) => (Number.isNaN(d.getTime()) ? "Invalid Date" : d.toISOString());
  P.toString = P.toLocaleString = function toString() { return iso(this); };
  P.toDateString = P.toLocaleDateString = function toDateString() { const s = iso(this); return s === "Invalid Date" ? s : s.slice(0, 10); };
  P.toTimeString = P.toLocaleTimeString = function toTimeString() { const s = iso(this); return s === "Invalid Date" ? s : s.slice(11, 19) + " GMT+0000"; };
  const parse = (str) => { const s = String(str); const t = RealDate.parse(s); if (Number.isNaN(t)) return t;
    // ES: a date-time without an offset is LOCAL time (host-dependent); here it is UTC, like a date-only string
    return /[T ]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s.trim()) ? t - hostOffset.call(new RealDate(t)) * 60000 : t; };
  function FrozenDate(...a) {
    if (!new.target) return iso(new RealDate(NOW));
    if (!a.length) return new RealDate(NOW);
    if (a.length === 1) return new RealDate(typeof a[0] === "string" ? parse(a[0]) : a[0] instanceof RealDate ? a[0].getTime() : a[0]);
    return new RealDate(RealDate.UTC(...a)); }
  FrozenDate.now = () => NOW; FrozenDate.UTC = RealDate.UTC; FrozenDate.parse = parse; FrozenDate.prototype = P;
  Object.defineProperty(P, "constructor", { value: FrozenDate });
  globalThis.Date = FrozenDate;
  // sfc32 seeded from the activation's seed (64 hex): the same seed gives the same numbers
  let a = parseInt(IN.seed.slice(0, 8), 16) | 0, b = parseInt(IN.seed.slice(8, 16), 16) | 0, c = parseInt(IN.seed.slice(16, 24), 16) | 0, d = parseInt(IN.seed.slice(24, 32), 16) | 0;
  const sfc = () => { a |= 0; b |= 0; c |= 0; d |= 0; const t = (((a + b) | 0) + d) | 0; d = (d + 1) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); c = (c + t) | 0; return (t >>> 0) / 4294967296; };
  for (let i = 0; i < 12; i++) sfc();
  Math.random = function random() { return sfc(); };
  const enc = (v, what) => JSON.stringify(v === undefined ? null : v, (k, x) => {
    if (typeof x === "number" && !Number.isFinite(x)) throw new TypeError(what + ": " + x + " isn't a finite number");
    if (typeof x === "function" || typeof x === "symbol" || typeof x === "bigint") throw new TypeError(what + ": a " + typeof x + " can't be stored");
    return x; });
  const call = (q) => { const o = JSON.parse(host(JSON.stringify(q))); if (o.err) { const e = new Error(o.err); e.name = o.name || "WorldError"; throw e; } return o.v; };
  const freeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
  const handlers = Object.create(null);
  // a script's console line: shown in its status view (world_debug, scripts {id}), never logged
  const consoleLog = (...parts) => { call(["log", parts.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ")]); };
  const world = {
    self: IN.self, script: IN.key, knobs: freeze(IN.knobs ?? {}), now: NOW,
    on(event, fn) { if (typeof fn !== "function") throw new TypeError("world.on(event, fn): fn must be a function"); (handlers[String(event)] ||= []).push(fn); },
    get(id, comp) { return call(["get", String(id), comp === undefined ? null : String(comp)]); },
    children(id) { return call(["children", String(id)]); },
    ids() { return call(["ids"]); },
    near(r) { return call(["near", Number(r)]); },
    count() { return call(["count"]); },
    name(id) { return call(["name", String(id)]); },
    set(id, comp, value) { call(["set", String(id), String(comp), JSON.parse(enc(value, "world.set " + comp))]); },
    param(id, comp, name, value) { call(["param", String(id), String(comp), String(name), JSON.parse(enc(value, "world.param " + name))]); },
    delete(id, comp) { call(["delete", String(id), comp === undefined ? null : String(comp)]); },
    create(components, id) { return call(["create", JSON.parse(enc(components ?? {}, "world.create")), id === undefined ? null : String(id)]); },
    say(text) { call(["say", String(text)]); },
    shove(who) { call(["body", "shove", String(who), null]); },
    pose(who, spec) { call(["body", "pose", String(who), JSON.parse(enc(spec ?? {}, "world.pose"))]); },
    // world.log: the old spelling of console.log, kept for one version (the names pass, 2026-10-07); "the world log" is
    // the event log, never a script's console
    log(...parts) { consoleLog(...parts); },
  };
  globalThis.world = Object.freeze(world);
  globalThis.console = Object.freeze({ log: (...parts) => consoleLog(...parts) });
  globalThis.__deliver = (evJson) => { const e = freeze(JSON.parse(evJson)); const hs = handlers[e.on] || [];
    for (const h of hs) h(e); return hs.length; };
})();
`;

const errName = (e) => (e && typeof e === "object" ? e.name ?? "Error" : "Error");
const errMsg = (e) => (e && typeof e === "object" ? `${e.name ?? "Error"}: ${e.message ?? ""}` : String(e));
const firstLine = (e) => { const st = e && typeof e === "object" ? String(e.stack ?? "") : ""; const m = /eval\.js:(\d+):(\d+)/.exec(st); return m ? ` (line ${Number(m[1])}, column ${m[2]})` : ""; };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "thing";

/**
 * The HOST side of one activation: everything the script can ask of the world, answered from the authority's state on the
 * authority's thread (reads see the head plus the activation's own writes; writes are recorded as proposals; presence and
 * names are recorded, or replayed from `x.reads`). `call(json) → json` is what the VM's world.* functions reach, in
 * this process or, isolated, through the relay. `finish(vm)` turns the VM's outcome into the activation's result.
 */
export function makeHost(x) {
  const L = { ...LIMITS, ...(x.limits ?? {}) };
  const logs = [], ops = [], says = [], bodies = [], reads = { near: [], count: [], names: [] }; let nearAt = 0, countAt = 0, nameAt = 0;
  let calls = 0, minted = 0, stop = null;
  // read-your-writes without copying the world: an overlay of the things this activation wrote (id → entity, or null if
  // it deleted it), over the head it was given. Each write costs O(1); ids/children use indexes built once (a review
  // found 32 writes then a read cloned a big world 32 times, on the authority's thread, past the deadline). The authority's
  // admit still judges the real batch; this view is only what the script reads back.
  const base = x.st.entities, ov = new Map(); let idsIdx = null, kidsIdx = null, idsAll = null;
  const entOf = (id) => (ov.has(id) ? ov.get(id) : base[id] ?? null);
  const writable = (id) => { if (ov.has(id)) return ov.get(id); const b = base[id]; if (!b) return null; const e = { born: b.born, c: Object.assign(Object.create(null), b.c) }; ov.set(id, e); return e; };
  const apply = (o) => {
    if (o.verb === "create") { if (!entOf(o.id)) { ov.set(o.id, { born: -1, c: Object.create(null) }); idsAll = null; } return; }
    if (o.verb === "delete" && o.comp === undefined) { ov.set(o.id, null); idsAll = null; return; }
    const e = writable(o.id); if (!e) return;
    if (o.verb === "set") e.c[o.comp] = o.value; else delete e.c[o.comp];
  };
  const parentOf = (e) => (e?.c?.parent && typeof e.c.parent.to === "string" ? e.c.parent.to : null);
  // the merged id list, kept until the activation creates or deletes a thing (a script calling world.ids() 64 times on a
  // big world must not cost the authority 64 sorts)
  const allIds = () => { if (idsAll) return idsAll; idsIdx ??= Object.keys(base).sort();
    return (idsAll = ov.size ? [...new Set([...idsIdx, ...ov.keys()])].filter((k) => entOf(k)).sort() : idsIdx); };
  const kidsOf = (id) => { if (!kidsIdx) { kidsIdx = new Map(); for (const k of Object.keys(base)) { const p = parentOf(base[k]); if (p) { let a = kidsIdx.get(p); if (!a) kidsIdx.set(p, (a = [])); a.push(k); } } }
    const out = new Set((kidsIdx.get(id) ?? []).filter((k) => !ov.has(k)));
    for (const [k, e] of ov) if (e && parentOf(e) === id) out.add(k);
    return [...out].sort(); };
  const self = (id) => (id === "self" ? x.self : id);
  class HostError extends Error {}
  const wantId = (id, what) => { if (!isEntityId(id)) throw new HostError(`${what}: '${id}' isn't an entity id`); return id; };
  const wantComp = (c, what) => { if (!isComponent(c)) throw new HostError(`${what}: '${c}' isn't a component name`); return c; };
  const read = () => { if (++calls > L.calls) { stop = { code: "calls", why: `more than ${L.calls} reads in one activation` }; throw new HostError(stop.why); } };
  const write = () => { if (ops.length >= L.ops) { stop = { code: "too-big", why: `more than ${L.ops} writes in one activation (41 §3.10)` }; throw new HostError(stop.why); } };
  const copy = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const host = (q) => {
    const [verb, ...a] = q;
    switch (verb) {
      case "get": { read(); const e = entOf(self(a[0])); if (!e) return null; if (a[1] === null) return copy(e.c); return copy(e.c[a[1]]); }
      case "children": { read(); return kidsOf(self(a[0])).slice(0, L.ids); }
      case "ids": { read(); return allIds().slice(0, L.ids); }
      case "near": { read(); const r = a[0]; if (!(r >= 0 && r <= 1000)) throw new HostError("world.near(r): r is metres, 0–1000");
        const ids = x.reads ? x.reads.near?.[nearAt]?.ids ?? [] : (x.near ? x.near(r) : []); nearAt++; reads.near.push({ r, ids: ids.slice() }); return ids.slice(); }
      case "name": { read(); const id = a[0]; // a display name lives in the authority's directory, outside the log: recorded, so a re-run agrees
        const n = x.reads ? x.reads.names?.[nameAt]?.name ?? null : (x.name ? x.name(id) ?? null : null); nameAt++; reads.names.push({ id, name: n }); return n; }
      case "count": { read(); const n = x.reads ? x.reads.count?.[countAt] ?? 0 : (x.count ? x.count() : 0); countAt++; reads.count.push(n); return n; }
      case "set": { write(); const id = wantId(self(a[0]), "world.set"), comp = wantComp(a[1], "world.set"); const op = { verb: "set", id, comp, value: a[2] }; ops.push(op); apply(op); return null; }
      case "param": { write(); const id = wantId(self(a[0]), "world.param"), comp = wantComp(a[1], "world.param"), key = `param.${a[2]}`;
        if (!isParamKey(key)) throw new HostError(`world.param: '${a[2]}' isn't a parameter name (a letter, then letters, digits, _ or -, up to 32)`);
        if (typeof a[3] !== "number") throw new HostError(`world.param: ${key} is a number (a signal), got ${JSON.stringify(a[3])}`);
        const was = entOf(id)?.c[comp]; const prev = was && typeof was === "object" && !Array.isArray(was) ? copy(was) : {};
        const op = { verb: "set", id, comp, value: { ...prev, [key]: a[3] } }; ops.push(op); apply(op); return null; }
      case "delete": { write(); const id = wantId(self(a[0]), "world.delete"); const op = a[1] === null ? { verb: "delete", id } : { verb: "delete", id, comp: wantComp(a[1], "world.delete") }; ops.push(op); apply(op); return null; }
      case "create": { const comps = a[0]; if (!comps || typeof comps !== "object" || Array.isArray(comps)) throw new HostError("world.create(components, id?): components is an object");
        const id = a[1] !== null ? wantId(a[1], "world.create") : `${slug(comps.model ?? comps.label ?? "thing")}-${x.seed.slice(0, 8)}${minted ? `-${minted}` : ""}`; minted++;
        for (const c of Object.keys(comps)) wantComp(c, "world.create");
        write(); const mk = { verb: "create", id }; ops.push(mk); apply(mk);
        for (const [c, v] of Object.entries(comps)) { write(); const op = { verb: "set", id, comp: c, value: v }; ops.push(op); apply(op); }
        return id; }
      case "say": { if (says.length >= L.says) { stop = { code: "too-big", why: `more than ${L.says} says in one activation` }; throw new HostError(stop.why); } says.push(String(a[0]).slice(0, 8192)); return null; }
      case "body": { if (bodies.length >= L.bodies) { stop = { code: "too-big", why: `more than ${L.bodies} body effects in one activation` }; throw new HostError(stop.why); }
        bodies.push({ kind: a[0], to: String(a[1]).replace(/^body:/, ""), ...(a[2] ? { spec: a[2] } : {}) }); return null; }
      case "log": { if (logs.length < L.logLines) logs.push(String(a[0]).slice(0, 500)); return null; }
      default: throw new HostError(`no host call '${verb}'`);
    }
  };
  const call = (json) => { try { return JSON.stringify({ v: host(JSON.parse(json)) ?? null }); }
    catch (e) { return JSON.stringify({ err: String(e?.message ?? e), name: e instanceof HostError ? "WorldError" : "Error" }); } };
  // vm: {fuel, ran?, fail?: {code, why}}. A limit the host enforced (reads, writes, says) wins over how the VM ended,
  // because the script may have caught the error it was thrown
  const finish = (vm) => {
    if (stop) return { ok: false, ...stop, logs, fuel: vm.fuel };
    if (vm.fail) return { ok: false, ...vm.fail, logs, fuel: vm.fuel };
    return { ok: true, ran: vm.ran, ops, says, bodies, reads: reads.near.length || reads.count.length || reads.names.length ? { ...(reads.near.length ? { near: reads.near } : {}), ...(reads.count.length ? { count: reads.count } : {}), ...(reads.names.length ? { names: reads.names } : {}) } : null, logs, fuel: vm.fuel };
  };
  return { call, finish, limits: L, input: { self: x.self, key: x.key, knobs: x.knobs ?? {}, now: x.now, seed: x.seed } };
}
/**
 * The VM side: QuickJS runs the prelude, the source and the one event, reaching the world only through `call`. Fuel and
 * the wall clock are counted from after the prelude (ours). Pure function of (text, input, event, limits, call's
 * answers): the same inputs give the same run. Never throws.
 * @returns {{fuel: number, ran?: number, fail?: {code: string, why: string}}}
 */
export function vmRun(text, input, event, L, call, clock = () => performance.now()) {
  if (!Q) return { fuel: 0, fail: { code: "unavailable", why: `the script sandbox isn't available on this server (${unavailable})` } };
  let rt = null, ctx = null, fuel = 0, deadline = Infinity, vstop = null;
  try {
    rt = Q.newRuntime(); rt.setMemoryLimit(L.memory); rt.setMaxStackSize(L.stack);
    rt.setInterruptHandler(() => { fuel++; if (fuel > L.fuel) { vstop ??= { code: "fuel", why: `out of fuel (${L.fuel} interrupt ticks): a loop that never ends, or too much work for one activation` }; return true; }
      if (clock() > deadline) { vstop ??= { code: "time", why: `over the ${L.wallMs} ms wall-clock backstop` }; return true; } return false; });
    ctx = rt.newContext();
    const fn = ctx.newFunction("__host", (h) => ctx.newString(call(ctx.getString(h))));
    ctx.setProp(ctx.global, "__host", fn); fn.dispose();
    const inp = ctx.newString(JSON.stringify(input)); ctx.setProp(ctx.global, "__in", inp); inp.dispose();
    const evalStep = (code, file) => { const r = ctx.evalCode(code, file);
      if (r.error) { const e = ctx.dump(r.error); r.error.dispose(); return { e }; } const v = ctx.dump(r.value); r.value.dispose(); return { v }; };
    let r = evalStep(PRELUDE, "prelude.js"); if (r.e) return { fuel, fail: { code: "sandbox", why: `the prelude failed: ${errMsg(r.e)}` } };
    fuel = 0; vstop = null; deadline = clock() + L.wallMs;
    r = evalStep(text, "eval.js");
    if (!r.e) r = evalStep(`__deliver(${JSON.stringify(JSON.stringify(event))})`, "deliver.js");
    if (clock() > deadline) vstop ??= { code: "time", why: `over the ${L.wallMs} ms wall-clock backstop` };
    if (vstop) return { fuel, fail: vstop };
    if (r.e) { const m = errMsg(r.e);
      const code = /out of memory|string too long|Array too long|invalid array length/i.test(m) ? "memory" : /stack overflow|Maximum call stack/i.test(m) ? "stack" : errName(r.e) === "SyntaxError" ? "syntax" : "thrown";
      return { fuel, fail: { code, why: `${m.slice(0, 300)}${firstLine(r.e)}` } }; }
    return { fuel, ran: r.v };
  } catch (e) {
    return { fuel, fail: { code: "sandbox", why: `the sandbox failed: ${String(e?.message ?? e).slice(0, 200)}` } };
  } finally {
    try { ctx?.dispose(); } catch { /* already */ }
    try { rt?.dispose(); } catch { /* already */ }
  }
}
/**
 * Run one activation IN THIS PROCESS (an auditor's re-run, tools). Never throws for anything the script does; returns
 * {ok, ...}. A slow native builtin can hold this thread: an authority runs activations isolated (runIsolated, below).
 * @param {{text: string, self: string, key: string, event: object, knobs?: object, now: number, seed: string, st: any,
 *   near?: (r: number) => string[], count?: () => number, name?: (id: string) => string | null,
 *   reads?: {near?: {r, ids}[], count?: number[], names?: {id, name}[]},
 *   limits?: object, clock?: () => number}} x
 * @returns {{ok: true, ops, says, bodies, reads, logs, fuel, ran} | {ok: false, code, why, logs, fuel}}
 */
export function runScript(x) {
  const h = makeHost(x);
  return h.finish(vmRun(x.text, h.input, x.event, h.limits, h.call, x.clock));
}
/** Does the source parse? (At upload and install: a refusal that teaches, before anything runs.) null, or {code, why}. */
export function checkSyntax(text) {
  if (!Q) return null; // no sandbox: install still works; every activation says "unavailable"
  let rt = null, ctx = null;
  try { rt = Q.newRuntime(); rt.setMemoryLimit(LIMITS.memory); rt.setMaxStackSize(LIMITS.stack); let n = 0; rt.setInterruptHandler(() => ++n > LIMITS.fuel);
    ctx = rt.newContext(); const r = ctx.evalCode(text, "eval.js", { compileOnly: true });
    if (r.error) { const e = ctx.dump(r.error); r.error.dispose(); return { code: "syntax", why: `${errMsg(e).slice(0, 300)}${firstLine(e)}` }; }
    r.value.dispose(); return null;
  } catch (e) { return { code: "sandbox", why: String(e?.message ?? e).slice(0, 200) }; }
  finally { try { ctx?.dispose(); } catch { /* already */ } try { rt?.dispose(); } catch { /* already */ } }
}
// ---------- isolated: the VM side in a killable process (sandbox-child.js) ----------
// The authority's thread sends the job down a named pipe and reads the process's lines back without blocking, answering the
// script's world.* calls itself (makeHost). So an activation stays one synchronous step of the authority (L7: one act + one
// batch, admitted at the head it read), and the authority holds the process's handle: at `wallMs + GRACE` after the job was
// sent it SIGKILLs the process (certain: a signal, not a request) and returns "time"; a warm spare takes the next job.
// Nothing a script does, a native builtin included, can hold the authority's thread past that deadline.
// (A Worker can't do this: worker.terminate() doesn't stop a thread inside WASM under Bun 1.3; measured 2026-10-06.)
export const GRACE = 200;        // ms over the script's own wall-clock backstop: the pipes, a loaded host, and the kill
const MAX = 2 << 20;             // bytes of one message (a job, a host call, an answer)
const WARM_MS = 300;             // at most this long an activation waits for a warm process (after kills): then it's
                                 // refused "unavailable" (not the script's failure), so waiting can't hold the thread either
const WANT = 2;                  // warm processes kept: one runs, one is ready the moment a kill takes the other
const env = () => globalThis.process?.env ?? {};
let fsm = null, osm = null, pathm = null; // node:fs etc., loaded only where isolation runs (never in a browser)
try { if (globalThis.process?.versions) { fsm = await import("node:fs"); osm = await import("node:os"); pathm = await import("node:path"); } } catch { /* no isolation here */ }
const canIsolate = () => !!(Q && fsm && typeof Bun !== "undefined" && !env().EIDO_SANDBOX_CHILD && env().EIDO_SANDBOX !== "inprocess" && fifoOk());
let FIFO = null; const fifoOk = () => (FIFO ??= (() => { try { return Bun.spawnSync(["mkfifo", "--help"]).exitCode !== null; } catch { return false; } })());
const pool = []; let kills = 0, spawned = 0;
const SLEEP = new Int32Array(new SharedArrayBuffer(4)); const nap = (ms) => Atomics.wait(SLEEP, 0, 0, ms);
function spawnChild() {
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "eido-sandbox-")); const inP = pathm.join(dir, "in"), outP = pathm.join(dir, "out");
  if (Bun.spawnSync(["mkfifo", "-m", "600", inP, outP]).exitCode !== 0) { fsm.rmSync(dir, { recursive: true, force: true }); return null; }
  const rfd = fsm.openSync(outP, fsm.constants.O_RDONLY | fsm.constants.O_NONBLOCK); // the child's "w" open then succeeds
  const wfd = fsm.openSync(inP, fsm.constants.O_RDWR | fsm.constants.O_NONBLOCK);    // O_RDWR: never blocks, never EPIPE
  const proc = Bun.spawn([process.execPath, new URL("./sandbox-child.js", import.meta.url).pathname, inP, outP],
    { stdio: ["ignore", "ignore", "ignore"], env: { ...env(), EIDO_SANDBOX_CHILD: "1", TZ: "UTC" } });
  proc.unref?.(); spawned++;
  return { proc, rfd, wfd, dir, pend: "", ready: false, buf: Buffer.alloc(1 << 16), dec: new TextDecoder() };
}
function closeChild(c, kill) {
  if (kill) { try { c.proc.kill(9); } catch { /* gone */ } }
  for (const fd of [c.rfd, c.wfd]) try { fsm.closeSync(fd); } catch { /* closed */ }
  try { fsm.rmSync(c.dir, { recursive: true, force: true }); } catch { /* gone */ }
}
// one line from the process, or null at the deadline (or if it died). Polls the non-blocking pipe, napping in between
function lineOf(c, deadline) {
  let naps = 0, last = false;
  for (;;) {
    const i = c.pend.indexOf("\n"); if (i >= 0) { const l = c.pend.slice(0, i); c.pend = c.pend.slice(i + 1); return l; }
    let n = -1; try { n = fsm.readSync(c.rfd, c.buf, 0, c.buf.length, null); } catch (e) { if (e?.code !== "EAGAIN") { c.gone = true; return null; } }
    if (n > 0) { c.pend += c.dec.decode(c.buf.subarray(0, n), { stream: true }); c.opened = true; naps = 0; continue; }
    // 0 = end of file: nobody holds the write end. Before the child has opened it (still starting) that's normal; after,
    // it means the child is gone, whether or not it has been reaped yet (exitCode stays null until the event loop runs)
    if ((n === 0 && c.opened) || c.proc.exitCode !== null || c.proc.signalCode) { c.gone = true; return null; }
    // past the deadline, look once more: if THIS thread was the one held up (a GC, an oversleeping nap), the answer may
    // already be waiting in the pipe, and killing a process that replied in time would fail an innocent script
    const left = deadline - performance.now(); if (left <= 0) { if (last) return null; last = true; continue; }
    nap(Math.min(left, naps++ < 40 ? 0.05 : 0.5)); // fast while a reply is likely, gentle while the script computes
  }
}
function send(c, str, deadline) {
  const b = Buffer.from(str + "\n"); let o = 0;
  while (o < b.length) { try { o += fsm.writeSync(c.wfd, b, o); } catch (e) { if (e?.code !== "EAGAIN") return false; }
    if (o < b.length) { if (performance.now() > deadline) return false; nap(0.1); } }
  return true;
}
function refill() { while (pool.length < WANT) { const c = spawnChild(); if (!c) break; pool.push(c); } }
// a warm process: one that has said ready. One still loading QuickJS is waited for, bounded; a dead one is replaced
const dead = (c) => !!c.gone || c.proc.exitCode !== null || !!c.proc.signalCode;
function takeReady(until) {
  refill();
  for (;;) {
    for (const c of [...pool]) {
      if (c.ready) return c;
      if (lineOf(c, 0) !== null) { c.ready = true; return c; } // its {ready: true}
      if (dead(c)) { pool.splice(pool.indexOf(c), 1); closeChild(c, false); refill(); }
    }
    if (!pool.length || performance.now() > until) return null;
    nap(1);
  }
}
// take in any {ready} lines already waiting (never waits): a process is warm once it said so
function pollReady() { for (const c of pool) if (!c.ready && lineOf(c, 0) !== null) c.ready = true; }
/** Start the warm processes now (an authority that holds scripts calls this at load, so its first activation doesn't wait). */
export function warm() { if (canIsolate()) { refill(); pollReady(); } }
/** A view for tests and status: is isolation on, how many processes were killed, how many were started. */
export const isolationStats = () => (fsm && pollReady(), { isolated: canIsolate(), kills, spawned, warm: pool.filter((c) => c.ready || c.opened).length, next: pool.find((c) => c.ready || c.opened)?.proc.pid ?? null });
if (globalThis.process?.on) process.on("exit", () => { for (const c of pool) closeChild(c, true); });
// the CPU a process has used, ms (Linux /proc: utime + stime, clock ticks; null where there's no /proc). At a deadline it
// tells a script that kept its process busy (a loop, a native call: `time`, its failure) from a process the host never
// got round to running (a loaded machine: `unavailable`, not the script's failure). The kill happens either way.
const TICK_MS = 10; // USER_HZ is 100 on Linux (getconf CLK_TCK)
function cpuMs(pid) { try { const f = fsm.readFileSync(`/proc/${pid}/stat`, "utf8"); const r = f.slice(f.lastIndexOf(")") + 2).split(" ");
  return (Number(r[11]) + Number(r[12])) * TICK_MS; } catch { return null; } }
export const STARVED = 0.3; // a job that got under this share of the deadline's wall time on a CPU was starved, not stuck
/** Run one activation with its VM side in a sandbox process. Same input and result as runScript. */
export function runIsolated(x) {
  const h = makeHost(x); const L = h.limits;
  if (!Q) return h.finish({ fuel: 0, fail: { code: "unavailable", why: `the script sandbox isn't available on this server (${unavailable})` } });
  const c = takeReady(performance.now() + WARM_MS);
  if (!c) return h.finish({ fuel: 0, fail: { code: "unavailable", why: "no sandbox process is ready" } });
  const sentAt = performance.now(), deadline = sentAt + L.wallMs + GRACE, cpu0 = cpuMs(c.proc.pid); let hostMs = 0;
  const stop = (fail) => { pool.splice(pool.indexOf(c), 1); closeChild(c, true); refill(); return h.finish(fail); };
  if (!send(c, JSON.stringify({ text: x.text, input: h.input, event: x.event, limits: L, max: MAX }), deadline)) return stop({ fuel: null, fail: { code: "sandbox", why: "couldn't hand the job to the sandbox process" } });
  for (;;) {
    const l = lineOf(c, deadline);
    if (l === null) { const died = dead(c); if (died) return stop({ fuel: null, fail: { code: "sandbox", why: "the sandbox process died" } });
      return killAt(); }
    let m; try { m = JSON.parse(l); } catch { return stop({ fuel: null, fail: { code: "sandbox", why: "the sandbox process said something unreadable" } }); }
    if (typeof m.h === "string") {
      if (performance.now() > deadline) return killAt(); // a stream of host calls never leaves the pipe empty: check here too
      const t1 = performance.now(); const ans = h.call(m.h); const ok = send(c, ans, deadline); hostMs += performance.now() - t1;
      if (!ok) return killAt(); continue; }
    if (m.done) return h.finish(m.done); // the process stays warm for the next job
    return stop({ fuel: null, fail: { code: "sandbox", why: "the sandbox process said something unexpected" } });
  }
  // at the deadline: killed either way. The script's failure (`time`) unless the process was starved: it had under
  // STARVED of the time the AUTHORITY wasn't busy answering it (answering is the script's doing: it asked), and that time
  // was most of the run (a review found heavy reads could make a busy script look starved)
  function killAt() {
      kills++; const cpu1 = cpuMs(c.proc.pid), wall = performance.now() - sentAt, used = cpu0 !== null && cpu1 !== null ? cpu1 - cpu0 : null, own = wall - hostMs;
      if (used !== null && own > 0.5 * wall && used < STARVED * own) return stop({ fuel: null, fail: { code: "unavailable", why: `stopped at the ${L.wallMs + GRACE} ms deadline, but the host was too busy to run it (its process had ${used} ms of CPU in ${Math.round(wall)} ms): not the script's doing` } });
      return stop({ fuel: null, fail: { code: "time", why: `stopped at the ${L.wallMs + GRACE} ms deadline: its sandbox process was killed (a loop, a native call that wouldn't yield, or reads that kept the authority busy${used !== null ? `; ${used} ms of CPU, ${Math.round(hostMs)} ms answering it` : ""})` } });
  }
}
// warm the sandbox once at load (the first QuickJS run in a process is several times slower than the rest)
if (Q) try { runScript({ text: "", self: "warm", key: "script:warm", event: { on: "warm" }, now: 0, seed: "0".repeat(64), st: { entities: {} } }); } catch { /* the next run says what's wrong */ }
/** What an authority injects as io.scripts. */
// an authority runs activations isolated wherever it can (bun, node: Worker + SharedArrayBuffer); EIDO_SANDBOX=inprocess opts out
export const SANDBOX = Object.freeze({ run: (x) => (canIsolate() ? runIsolated(x) : runScript(x)), checkSyntax, available: sandboxAvailable, warm, isolated: canIsolate });
export { jcs };
