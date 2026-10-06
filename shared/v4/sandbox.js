// shared/v4/sandbox.js — the v4 script sandbox: real JavaScript in QuickJS compiled to WASM (research 41 §3.13, §6:
// a SEPARATE VM, never same-VM compartments; Figma's Realms scar). The door never imports this file (browsers import the
// door); a host injects `runScript` as io.scripts (server/v4/live.ts, server/v4/disk.ts), and an auditor calls it
// directly to re-run an activation from what its act records (shared/v4/scriptaudit.js).
//
// One activation = one FRESH runtime and context: evaluate the source (which registers handlers with world.on), deliver
// the one event, collect the proposed writes. Nothing survives between activations, so a re-run from the act's inputs
// is the same run (41 §3.5: "a script must behave correctly if VM memory is lost": here it always is).
// Deterministic inputs only (41 §3.7):
//   clock    Date.now() and new Date() are frozen at `now` (the act's ts) for the whole activation;
//   random   Math.random is a PRNG seeded from `seed` (H(world ‖ act seq ‖ script key), recorded in the act);
//   world    reads see the folded head the activation was given, plus its own writes so far (read-your-writes);
//   presence world.near(r) / world.count() answers, and world.name(id) (the door's directory, outside the log), are
//            RECORDED (`reads`) and, on a re-run, REPLAYED from the record;
//   nothing else: no timers, no network, no filesystem, no other clock.
// Metered by FUEL: QuickJS calls the interrupt handler every so many bytecode ticks; the count of calls is the fuel,
// deterministic for one QuickJS build (LIMITS.fuel). A wall-clock deadline is the backstop (host calls can't be
// interrupted); a run that hits it writes nothing, so an auditor never sees a partial result. Memory and native stack
// are capped per runtime.
//
// SYNCHRONOUS, on the caller's thread. Research 41 recommends running the sandbox OFF the sequencer's thread; this
// slice doesn't (the door is synchronous end to end). The input is (source, head state, event, presence answers) and
// the output is a proposed batch, so moving it to a worker is a change of transport, not of meaning. Until then the
// fuel and the wall-clock backstop are what bound how long one activation can hold the door.
import { applyOps, jcs, isEntityId, isComponent } from "./fold.js";
import { LIMITS, isParamKey } from "./scriptrules.js";

let Q = null, unavailable = null;
try { const mod = await import("quickjs-emscripten"); Q = await mod.getQuickJS(); }
catch (e) { unavailable = String(e?.message ?? e).slice(0, 200); }
/** Is the sandbox here? (The door says "unavailable" for every activation when it isn't.) */
export const sandboxAvailable = () => (Q ? true : unavailable);

// The whole script-facing API, in one place (docs: docs/SCRIPTS-v4.md). Runs inside the VM before the source.
const PRELUDE = String.raw`"use strict";
(() => {
  const host = globalThis.__host; delete globalThis.__host;
  const IN = JSON.parse(globalThis.__in); delete globalThis.__in;
  const NOW = IN.now;
  const RealDate = Date;
  function FrozenDate(...a) { if (!new.target) return new RealDate(NOW).toString(); return a.length ? new RealDate(...a) : new RealDate(NOW); }
  FrozenDate.now = () => NOW; FrozenDate.UTC = RealDate.UTC; FrozenDate.parse = RealDate.parse; FrozenDate.prototype = RealDate.prototype;
  Object.defineProperty(RealDate.prototype, "constructor", { value: FrozenDate });
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
    log(...parts) { call(["log", parts.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ")]); },
  };
  globalThis.world = Object.freeze(world);
  globalThis.__deliver = (evJson) => { const e = freeze(JSON.parse(evJson)); const hs = handlers[e.on] || [];
    for (const h of hs) h(e); return hs.length; };
})();
`;

const errName = (e) => (e && typeof e === "object" ? e.name ?? "Error" : "Error");
const errMsg = (e) => (e && typeof e === "object" ? `${e.name ?? "Error"}: ${e.message ?? ""}` : String(e));
const firstLine = (e) => { const st = e && typeof e === "object" ? String(e.stack ?? "") : ""; const m = /eval\.js:(\d+):(\d+)/.exec(st); return m ? ` (line ${Number(m[1])}, column ${m[2]})` : ""; };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "thing";

/**
 * Run one activation. Never throws for anything the script does; returns {ok, ...}.
 * @param {{text: string, self: string, key: string, event: object, knobs?: object, now: number, seed: string, st: any,
 *   near?: (r: number) => string[], count?: () => number, name?: (id: string) => string | null,
 *   reads?: {near?: {r, ids}[], count?: number[], names?: {id, name}[]},
 *   limits?: object, clock?: () => number}} x
 * @returns {{ok: true, ops, says, bodies, reads, logs, fuel, ran} | {ok: false, code, why, logs, fuel}}
 */
export function runScript(x) {
  const L = { ...LIMITS, ...(x.limits ?? {}) };
  const logs = [];
  if (!Q) return { ok: false, code: "unavailable", why: `the script sandbox isn't available on this door (${unavailable})`, logs, fuel: 0 };
  const clock = x.clock ?? (() => performance.now());
  const deadline = clock() + L.wallMs;
  const ops = [], says = [], bodies = [], reads = { near: [], count: [], names: [] }; let nearAt = 0, countAt = 0, nameAt = 0;
  let calls = 0, minted = 0, fuel = 0, stop = null, cur = x.st, pending = [];
  const view = () => { if (pending.length) { for (const o of pending) { try { cur = applyOps(cur, [o]); } catch { /* admit names it */ } } pending = []; } return cur; };
  const self = (id) => (id === "self" ? x.self : id);
  const wantId = (id, what) => { if (!isEntityId(id)) throw new HostError(`${what}: '${id}' isn't an entity id`); return id; };
  const wantComp = (c, what) => { if (!isComponent(c)) throw new HostError(`${what}: '${c}' isn't a component name`); return c; };
  class HostError extends Error {}
  const read = () => { if (++calls > L.calls) { stop = { code: "calls", why: `more than ${L.calls} reads in one activation` }; throw new HostError(stop.why); } };
  const write = () => { if (ops.length >= L.ops) { stop = { code: "too-big", why: `more than ${L.ops} writes in one activation (41 §3.10)` }; throw new HostError(stop.why); } };
  const copy = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const host = (q) => {
    const [verb, ...a] = q;
    switch (verb) {
      case "get": { read(); const st = view(); const e = st.entities[self(a[0])]; if (!e) return null; if (a[1] === null) return copy(e.c); return copy(e.c[a[1]]); }
      case "children": { read(); const st = view(); const id = self(a[0]); return Object.keys(st.entities).filter((k) => st.entities[k].c.parent?.to === id).sort().slice(0, L.ids); }
      case "ids": { read(); return Object.keys(view().entities).sort().slice(0, L.ids); }
      case "near": { read(); const r = a[0]; if (!(r >= 0 && r <= 1000)) throw new HostError("world.near(r): r is metres, 0–1000");
        const ids = x.reads ? x.reads.near?.[nearAt]?.ids ?? [] : (x.near ? x.near(r) : []); nearAt++; reads.near.push({ r, ids: ids.slice() }); return ids.slice(); }
      case "name": { read(); const id = a[0]; // a display name lives in the door's directory, outside the log: recorded, so a re-run agrees
        const n = x.reads ? x.reads.names?.[nameAt]?.name ?? null : (x.name ? x.name(id) ?? null : null); nameAt++; reads.names.push({ id, name: n }); return n; }
      case "count": { read(); const n = x.reads ? x.reads.count?.[countAt] ?? 0 : (x.count ? x.count() : 0); countAt++; reads.count.push(n); return n; }
      case "set": { write(); const id = wantId(self(a[0]), "world.set"), comp = wantComp(a[1], "world.set"); const op = { verb: "set", id, comp, value: a[2] }; ops.push(op); pending.push(op); return null; }
      case "param": { write(); const id = wantId(self(a[0]), "world.param"), comp = wantComp(a[1], "world.param"), key = `param.${a[2]}`;
        if (!isParamKey(key)) throw new HostError(`world.param: '${a[2]}' isn't a parameter name (a letter, then letters, digits, _ or -, up to 32)`);
        if (typeof a[3] !== "number") throw new HostError(`world.param: ${key} is a number (a signal), got ${JSON.stringify(a[3])}`);
        const st = view(); const was = st.entities[id]?.c[comp]; const base = was && typeof was === "object" && !Array.isArray(was) ? copy(was) : {};
        const op = { verb: "set", id, comp, value: { ...base, [key]: a[3] } }; ops.push(op); pending.push(op); return null; }
      case "delete": { write(); const id = wantId(self(a[0]), "world.delete"); const op = a[1] === null ? { verb: "delete", id } : { verb: "delete", id, comp: wantComp(a[1], "world.delete") }; ops.push(op); pending.push(op); return null; }
      case "create": { const comps = a[0]; if (!comps || typeof comps !== "object" || Array.isArray(comps)) throw new HostError("world.create(components, id?): components is an object");
        const id = a[1] !== null ? wantId(a[1], "world.create") : `${slug(comps.model ?? comps.label ?? "thing")}-${x.seed.slice(0, 8)}${minted ? `-${minted}` : ""}`; minted++;
        for (const c of Object.keys(comps)) wantComp(c, "world.create");
        write(); const mk = { verb: "create", id }; ops.push(mk); pending.push(mk);
        for (const [c, v] of Object.entries(comps)) { write(); const op = { verb: "set", id, comp: c, value: v }; ops.push(op); pending.push(op); }
        return id; }
      case "say": { if (says.length >= L.says) { stop = { code: "too-big", why: `more than ${L.says} says in one activation` }; throw new HostError(stop.why); } says.push(String(a[0]).slice(0, 8192)); return null; }
      case "body": { if (bodies.length >= L.bodies) { stop = { code: "too-big", why: `more than ${L.bodies} body effects in one activation` }; throw new HostError(stop.why); }
        bodies.push({ act: a[0], to: String(a[1]).replace(/^body:/, ""), ...(a[2] ? { spec: a[2] } : {}) }); return null; }
      case "log": { if (logs.length < L.logLines) logs.push(String(a[0]).slice(0, 500)); return null; }
      default: throw new HostError(`no host call '${verb}'`);
    }
  };
  let rt = null, ctx = null;
  try {
    rt = Q.newRuntime(); rt.setMemoryLimit(L.memory); rt.setMaxStackSize(L.stack);
    rt.setInterruptHandler(() => { fuel++; if (fuel > L.fuel) { stop ??= { code: "fuel", why: `out of fuel (${L.fuel} interrupt ticks): a loop that never ends, or too much work for one activation` }; return true; }
      if (clock() > deadline) { stop ??= { code: "time", why: `over the ${L.wallMs} ms wall-clock backstop` }; return true; } return false; });
    ctx = rt.newContext();
    const fn = ctx.newFunction("__host", (h) => {
      try { return ctx.newString(JSON.stringify({ v: host(JSON.parse(ctx.getString(h))) ?? null })); }
      catch (e) { return ctx.newString(JSON.stringify({ err: String(e?.message ?? e), name: e instanceof HostError ? "WorldError" : "Error" })); } });
    ctx.setProp(ctx.global, "__host", fn); fn.dispose();
    const inp = ctx.newString(JSON.stringify({ self: x.self, key: x.key, knobs: x.knobs ?? {}, now: x.now, seed: x.seed }));
    ctx.setProp(ctx.global, "__in", inp); inp.dispose();
    const evalStep = (code, file) => { const r = ctx.evalCode(code, file);
      if (r.error) { const e = ctx.dump(r.error); r.error.dispose(); return { e }; } const v = ctx.dump(r.value); r.value.dispose(); return { v }; };
    let r = evalStep(PRELUDE, "prelude.js"); if (r.e) return { ok: false, code: "sandbox", why: `the prelude failed: ${errMsg(r.e)}`, logs, fuel };
    r = evalStep(x.text, "eval.js");
    if (!r.e) r = evalStep(`__deliver(${JSON.stringify(JSON.stringify(x.event))})`, "deliver.js");
    if (clock() > deadline) stop ??= { code: "time", why: `over the ${L.wallMs} ms wall-clock backstop` };
    if (stop) return { ok: false, ...stop, logs, fuel };
    if (r.e) { const m = errMsg(r.e);
      const code = /out of memory|string too long|Array too long|invalid array length/i.test(m) ? "memory" : /stack overflow|Maximum call stack/i.test(m) ? "stack" : errName(r.e) === "SyntaxError" ? "syntax" : "thrown";
      return { ok: false, code, why: `${m.slice(0, 300)}${firstLine(r.e)}`, logs, fuel }; }
    return { ok: true, ran: r.v, ops, says, bodies, reads: reads.near.length || reads.count.length || reads.names.length ? { ...(reads.near.length ? { near: reads.near } : {}), ...(reads.count.length ? { count: reads.count } : {}), ...(reads.names.length ? { names: reads.names } : {}) } : null, logs, fuel };
  } catch (e) {
    return { ok: false, code: "sandbox", why: `the sandbox failed: ${String(e?.message ?? e).slice(0, 200)}`, logs, fuel };
  } finally {
    try { ctx?.dispose(); } catch { /* already */ }
    try { rt?.dispose(); } catch { /* already */ }
  }
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
/** What a door injects as io.scripts. */
export const SANDBOX = Object.freeze({ run: runScript, checkSyntax, available: sandboxAvailable });
export { jcs };
