// behaviors — runtime scripting: uploaded scripts that run server-side.
//
// The Layer-2 tier from DESIGN.md, made real. A `behavior` log entry binds an
// uploaded script file to the world (optionally attached to an entity); this
// module runs each one in its own QuickJS-in-WASM sandbox and dispatches
// world events into it. The script sees exactly ONE object — `world` — and
// affects the world exclusively by emitting ordinary logged verbs, gated by
// its AUTHOR's rights at emit time plus a per-behavior capability mask.
//
// Doctrine (same as reactions, which this generalizes):
//   - Replay NEVER re-executes scripts — it folds the verbs they emitted.
//     Scripts get randomness and wall-clock for free; determinism lives in
//     the fold, not here.
//   - No script may ever take the sequencer down: every entry into the
//     sandbox is wrapped, gas-limited (interrupt deadline), memory-capped,
//     and emit-budgeted. A script that keeps failing is paused, loudly.
//   - Parameters travel in the log; code travels in the store. The `src` is
//     a content-addressed upload (`/upload?as=script`), so a behavior entry
//     pins exactly the bytes it runs, forever.
//
// The sandbox dependency is OPTIONAL: the sequencer stays bootable without
// quickjs-emscripten — behaviors just report themselves unavailable.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// --- what we need from server.ts (structural, to avoid a circular import) ---
type LogEntry = { seq: number; ts: number; actor: string; verb: string; args: Record<string, unknown> };
export interface WorldLike {
  name: string;
  state: {
    entities: Record<string, any>;
    behaviors?: Record<string, BehaviorRec>;
    mounts?: Record<string, any>;
  };
  clients: Set<{ id: string; spectator: boolean; lastPose?: any }>;
  append(actor: string, verb: string, args: Record<string, unknown>): LogEntry;
  commit(actor: string, verb: string, args: Record<string, unknown>): LogEntry;
  broadcast(msg: unknown, except?: unknown): void;
  debug(kind: string, detail: Record<string, unknown>): void;
}
export type BehaviorRec = {
  src: string;                       // store/scripts/<hash>.js — content-addressed
  attach?: string;                   // entity this behavior belongs to
  caps?: { verbs?: string[]; selfOnly?: boolean };
  knobs?: Record<string, unknown>;
  author: string;                    // whose rights emits are checked against
  ts: number;
  state?: Record<string, unknown>;   // persisted kv, folded from bstate entries
};

// rights gate, injected by server.ts (rightsOf/VERB_NEEDS live there)
let emitAllowed: (w: WorldLike, author: string, verb: string, args?: Record<string, unknown>) => string | null = () => "behaviors not wired";
export function wireBehaviorGate(fn: typeof emitAllowed) { emitAllowed = fn; }

let OPT_DIR = "";
export function wireBehaviorStore(dir: string) { OPT_DIR = dir; }

// ---------------------------------------------------------------- limits
const GAS_MS = 25;                  // per activation — a handler is a reflex, not a job
const LOAD_MS = 150;                // top-level eval on (re)load gets a little more
const MEM_BYTES = 24 * 1024 * 1024;
const EMITS_PER_ACTIVATION = 8;
const EMITS_PER_MINUTE = 40;
const TIMER_MIN_S = Number(process.env.BHV_TIMER_MIN ?? 5);
const MAX_BEHAVIORS_PER_WORLD = 12;
const RING_CAP = 200;
const PAUSE_AFTER_ERRORS = 5;
const KV_CAP_BYTES = 8192;
export const behaviorLimits = { MAX_BEHAVIORS_PER_WORLD };

// Default capability mask: enough to make things talk and move, nothing that
// reshapes the world. Authors can only NARROW this list, never widen past
// their own rights (emits are also checked against the author's live role).
// `force` is in the defaults deliberately: a trap that springs, a geyser, a
// gust machine — physical events are what behaviors are FOR, the verb is
// hard-bounded server-side, and every body's own pushable consent still
// gates whether anyone actually falls over.
// `force` and `punt` are physical events — what behaviors are FOR; both are
// hard-bounded at the receivers (consent for bodies, power clamps in the
// volunteer sims for objects).
const DEFAULT_CAPS = ["say", "motion", "comp", "place", "use", "light", "force", "punt"];

// ---------------------------------------------------------------- quickjs
let QJS: any = null;
let qjsFailed = false;
async function quickjs(): Promise<any | null> {
  if (QJS || qjsFailed) return QJS;
  try {
    const mod = await import("quickjs-emscripten");
    QJS = await mod.getQuickJS();
  } catch (err) {
    qjsFailed = true;
    console.warn("[behaviors] quickjs-emscripten unavailable — runtime scripting disabled:", String(err));
  }
  return QJS;
}

// The only world a script ever sees. Kept as a template string so the whole
// contract is in one place; sdk/behavior.d.ts documents the same surface.
const PRELUDE = `
"use strict";
const __handlers = Object.create(null);
globalThis.__timers = [];
const __timerFns = [];
globalThis.world = {
  self: globalThis.__SELF ?? null,
  knobs: globalThis.__KNOBS ?? {},
  on(ev, fn) { (__handlers[ev] ||= []).push(fn); },
  every(sec, fn) { __timerFns.push(fn); __timers.push(Number(sec) || 0); },
  emit(verb, args) {
    const err = __emit(JSON.stringify([String(verb), args ?? {}]));
    if (err) throw new Error(err);
  },
  log() {
    __log(Array.prototype.map.call(arguments,
      (x) => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
  },
  entity(id) { return JSON.parse(__query(JSON.stringify(["entity", String(id)]))); },
  entities() { return JSON.parse(__query('["entities"]')); },
  people() { return JSON.parse(__query('["people"]')); },
  kv: {
    get(k) { const v = __kv(JSON.stringify(["get", String(k)])); return v === "" ? undefined : JSON.parse(v); },
    set(k, v) { __kv(JSON.stringify(["set", String(k), v === undefined ? null : v])); },
  },
};
globalThis.__dispatch = function (ev, payload) {
  const hs = __handlers[ev];
  if (!hs || !hs.length) return 0;
  const p = JSON.parse(payload);
  for (const h of hs) h(p);
  return hs.length;
};
globalThis.__fireTimer = function (i) { const f = __timerFns[i]; if (f) f(); };
`;

class Instance {
  id: string;
  rec: BehaviorRec;
  w: WorldLike;
  rt: any = null;
  ctx: any = null;
  deadline = 0;
  ring: { ts: number; line: string }[] = [];
  errors = 0;
  paused: string | null = null;      // the reason, when paused
  timers: { everyS: number; next: number }[] = [];
  emitsThisActivation = 0;
  emitWindow = { t: 0, n: 0 };
  kvDirty = false;
  kv: Record<string, unknown>;

  constructor(w: WorldLike, id: string, rec: BehaviorRec) {
    this.w = w; this.id = id; this.rec = rec;
    this.kv = { ...(rec.state ?? {}) };
  }

  log(line: string) {
    this.ring.push({ ts: Date.now(), line: String(line).slice(0, 500) });
    if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP);
  }

  /** Every path into the sandbox goes through here: sets the gas deadline,
   *  disposes result handles, converts thrown errors into ring+debug entries
   *  and strikes. Returns true on success. */
  private run(code: string, gasMs: number, what: string): boolean {
    this.deadline = Date.now() + gasMs;
    this.emitsThisActivation = 0;
    let result: any;
    try {
      result = this.ctx.evalCode(code);
    } catch (err) {   // sandbox itself blew up (OOM abort etc.) — rebuild next time
      this.strike(`${what}: sandbox fault: ${String(err).slice(0, 300)}`);
      this.disposeVm();
      return false;
    }
    if ("error" in result && result.error) {
      const e = this.ctx.dump(result.error);
      result.error.dispose();
      const msg = typeof e === "object" && e ? `${e.name ?? "Error"}: ${e.message ?? JSON.stringify(e)}` : String(e);
      this.strike(`${what}: ${msg.slice(0, 300)}`);
      return false;
    }
    result.value?.dispose?.();
    this.errors = 0;                 // a clean run heals the strike counter
    this.flushKv();
    return true;
  }

  private strike(msg: string) {
    this.log(`⚠ ${msg}`);
    this.w.debug("script-error", { behavior: this.id, error: msg });
    if (++this.errors >= PAUSE_AFTER_ERRORS) {
      this.paused = `paused after ${this.errors} consecutive errors — fix the script and re-attach (last: ${msg.slice(0, 160)})`;
      this.log(`⏸ ${this.paused}`);
      this.w.debug("script-pause", { behavior: this.id, why: this.paused });
    }
  }

  private hostFns() {
    const ctx = this.ctx;
    const def = (name: string, fn: (arg: string) => string | undefined) => {
      const h = ctx.newFunction(name, (a: any) => {
        const s = a ? ctx.getString(a) : "";
        const out = fn(s);
        return out === undefined ? ctx.undefined : ctx.newString(out);
      });
      ctx.setProp(ctx.global, name, h);
      h.dispose();
    };
    def("__log", (s) => { this.log(s); return undefined; });
    def("__emit", (s) => this.hostEmit(s));
    def("__query", (s) => this.hostQuery(s));
    def("__kv", (s) => this.hostKv(s));
  }

  /** Emits are the ONLY way a script touches the world, so this is the whole
   *  security story: author's live rights, then the capability mask, then
   *  selfOnly, then rate budgets. Returns "" on success or the refusal —
   *  which the prelude throws, so a denied emit is LOUD in script land. */
  private hostEmit(json: string): string {
    let verb: string, args: Record<string, unknown>;
    try { [verb, args] = JSON.parse(json); } catch { return "emit: unparseable"; }
    if (++this.emitsThisActivation > EMITS_PER_ACTIVATION) {
      return `emit budget: ${EMITS_PER_ACTIVATION} per activation`;
    }
    const now = Date.now();
    if (now - this.emitWindow.t > 60_000) this.emitWindow = { t: now, n: 0 };
    if (++this.emitWindow.n > EMITS_PER_MINUTE) return `emit budget: ${EMITS_PER_MINUTE} per minute`;
    const caps = this.rec.caps?.verbs ?? DEFAULT_CAPS;
    if (!caps.includes(verb)) return `capability mask: this behavior may not "${verb}" (has: ${caps.join(", ")})`;
    const why = emitAllowed(this.w, this.rec.author, verb,
      args && typeof args === "object" ? args as Record<string, unknown> : undefined);
    if (why) return why.includes("locked") ? why : `author rights: ${why}`;
    if ((this.rec.caps?.selfOnly ?? true) && this.rec.attach
      && args && typeof args === "object" && "id" in args && args.id !== this.rec.attach) {
      return `selfOnly: this behavior only touches its own entity ("${this.rec.attach}")`;
    }
    try {
      // §24 entry bus: commit publishes (fanout + bhv.onEntry, whose bhv:
      // actor guard is what keeps script-to-script loops out, as before)
      this.w.commit(`bhv:${this.id}`, verb, { ...args, by: this.rec.author });
      return "";
    } catch (err) {
      return `append failed: ${String(err).slice(0, 200)}`;
    }
  }

  private hostQuery(json: string): string {
    try {
      const [kind, arg] = JSON.parse(json);
      if (kind === "entity") {
        const e = this.w.state.entities[String(arg)];
        return e ? JSON.stringify({ id: arg, pos: e.pos, yaw: e.yaw ?? 0, lib: e.lib, comp: e.comp ?? {}, parent: e.parent ?? null }) : "null";
      }
      if (kind === "entities") {
        return JSON.stringify(Object.entries(this.w.state.entities)
          .map(([id, e]: [string, any]) => ({ id, pos: e.pos, yaw: e.yaw ?? 0, lib: e.lib })));
      }
      if (kind === "people") {
        return JSON.stringify([...this.w.clients].filter((c) => !c.spectator)
          .map((c) => ({ id: c.id, pos: (c.lastPose as any)?.p ?? null })));
      }
      return "null";
    } catch { return "null"; }
  }

  private hostKv(json: string): string {
    try {
      const [op, k, v] = JSON.parse(json);
      if (op === "get") return this.kv[k] === undefined ? "" : JSON.stringify(this.kv[k]);
      if (op === "set") {
        if (v === null) delete this.kv[k]; else this.kv[k] = v;
        this.kvDirty = true;
      }
      return "";
    } catch { return ""; }
  }

  /** Coalesced kv persistence: one bstate entry per activation that changed
   *  something. bstate folds into state.behaviors[id].state, so kv survives
   *  restarts, replays, and forks — the same event-sourcing as everything. */
  private flushKv() {
    if (!this.kvDirty) return;
    this.kvDirty = false;
    const data = this.kv;
    if (JSON.stringify(data).length > KV_CAP_BYTES) {
      this.log(`⚠ kv over ${KV_CAP_BYTES}B — not persisted (trim what you store)`);
      return;
    }
    try {
      this.w.commit(`bhv:${this.id}`, "bstate", { id: this.id, data });
    } catch { /* persistence is best-effort; the ring already has the story */ }
  }

  async load(): Promise<boolean> {
    const Q = await quickjs();
    if (!Q) { this.paused = "sandbox unavailable on this server"; return false; }
    const srcPath = join(OPT_DIR, this.rec.src);
    if (!/^store\/scripts\/[a-f0-9]{16}\.js$/.test(this.rec.src) || !existsSync(srcPath)) {
      this.paused = `script file missing: ${this.rec.src}`;
      this.w.debug("script-pause", { behavior: this.id, why: this.paused });
      return false;
    }
    const src = readFileSync(srcPath, "utf8");
    this.rt = Q.newRuntime();
    this.rt.setMemoryLimit(MEM_BYTES);
    this.rt.setInterruptHandler(() => Date.now() > this.deadline);
    this.ctx = this.rt.newContext();
    this.hostFns();
    const inject = `globalThis.__SELF = ${JSON.stringify(this.rec.attach ?? null)};`
      + `globalThis.__KNOBS = ${JSON.stringify(this.rec.knobs ?? {})};`;
    if (!this.run(inject + PRELUDE, LOAD_MS, "prelude")) return false;
    if (!this.run(src, LOAD_MS, "load")) return false;
    // collect timer registrations
    this.deadline = Date.now() + GAS_MS;
    const tr = this.ctx.evalCode("JSON.stringify(__timers)");
    if (!("error" in tr && tr.error)) {
      const secs: number[] = JSON.parse(this.ctx.dump(tr.value));
      tr.value.dispose();
      const now = Date.now();
      this.timers = secs.map((s) => {
        const everyS = Math.max(TIMER_MIN_S, Number(s) || TIMER_MIN_S);
        return { everyS, next: now + everyS * 1000 };
      });
    } else { tr.error.dispose(); }
    this.log(`▶ loaded ${this.rec.src}${this.rec.attach ? ` on ${this.rec.attach}` : ""} (${this.timers.length} timer(s))`);
    return true;
  }

  dispatch(ev: string, payload: Record<string, unknown>) {
    if (this.paused || !this.ctx) return;
    this.run(`__dispatch(${JSON.stringify(ev)}, ${JSON.stringify(JSON.stringify(payload))})`, GAS_MS, `on ${ev}`);
  }

  fireTimer(i: number) {
    if (this.paused || !this.ctx) return;
    this.run(`__fireTimer(${i})`, GAS_MS, "timer");
  }

  disposeVm() {
    try { this.ctx?.dispose(); } catch { /* already */ }
    try { this.rt?.dispose(); } catch { /* already */ }
    this.ctx = this.rt = null;
  }
}

// ---------------------------------------------------------------- host

export class BehaviorHost {
  private w: WorldLike;
  private instances = new Map<string, Instance>();
  private loading = new Map<string, Promise<boolean>>();

  constructor(w: WorldLike) { this.w = w; }

  /** Reconcile instances with state.behaviors — called after any behavior
   *  fold and at world load. Changed src/attach/knobs ⇒ fresh sandbox. */
  sync() {
    const want = this.w.state.behaviors ?? {};
    for (const [id, inst] of this.instances) {
      const rec = want[id];
      const key = (r: BehaviorRec) => JSON.stringify([r.src, r.attach, r.knobs, r.caps]);
      if (!rec || (rec as { runtime?: string }).runtime === "client" || key(rec) !== key(inst.rec)) {
        inst.disposeVm();
        this.instances.delete(id);
        this.loading.delete(id);
      }
    }
    for (const [id, rec] of Object.entries(want)) {
      // client-runtime mods are OFFERS to visitors' browsers, not sandbox
      // residents — the server stores and rosters them but never executes
      if ((rec as { runtime?: string }).runtime === "client") continue;
      if (this.instances.has(id) || this.loading.has(id)) continue;
      const inst = new Instance(this.w, id, rec);
      this.instances.set(id, inst);
      this.loading.set(id, inst.load().finally(() => this.loading.delete(id)));
    }
  }

  /** Event fan-out. `use` goes to the behavior(s) on that entity (and any
   *  world-level ones); `say` and presence events go to everyone. */
  onEntry(entry: LogEntry) {
    if (entry.actor.startsWith("bhv:")) return;   // no script-to-script loops in v1
    const a = entry.args as any;
    if (entry.verb === "use") {
      for (const inst of this.instances.values()) {
        if (!inst.rec.attach || inst.rec.attach === a?.id) {
          inst.dispatch("use", { entity: a?.id, action: String(a?.action ?? "use"), by: entry.actor, seq: entry.seq });
        }
      }
    } else if (entry.verb === "say") {
      for (const inst of this.instances.values()) {
        inst.dispatch("say", { text: String(a?.text ?? ""), by: entry.actor, seq: entry.seq });
      }
    }
  }

  onPresence(kind: "enter" | "leave", id: string) {
    for (const inst of this.instances.values()) inst.dispatch(kind, { id });
  }

  /** Driven by the global 1s tick in server.ts. */
  tick(now: number) {
    for (const inst of this.instances.values()) {
      for (let i = 0; i < inst.timers.length; i++) {
        const t = inst.timers[i];
        if (now >= t.next) {
          t.next = now + t.everyS * 1000;
          inst.fireTimer(i);
        }
      }
    }
  }

  /** The per-behavior log ring + status — the debugging surface. */
  inspect(id: string): { status: string; ring: { ts: number; line: string }[] } | null {
    const inst = this.instances.get(id);
    if (!inst) return this.w.state.behaviors?.[id] ? { status: "not loaded yet", ring: [] } : null;
    return { status: inst.paused ?? "running", ring: inst.ring.slice(-RING_CAP) };
  }

  list(): { id: string; status: string; attach?: string; src: string; timers: number }[] {
    return Object.entries(this.w.state.behaviors ?? {}).map(([id, rec]) => {
      const inst = this.instances.get(id);
      // a client-runtime offer is honest about what it is: never "not
      // loaded" (nothing here will ever load it) — visitors' browsers run it
      const status = (rec as { runtime?: string }).runtime === "client" ? "client-mod"
        : inst ? (inst.paused ?? "running") : "not loaded";
      return { id, status, attach: rec.attach, src: rec.src, timers: inst?.timers.length ?? 0 };
    });
  }

  disposeAll() {
    for (const inst of this.instances.values()) inst.disposeVm();
    this.instances.clear();
  }
}
