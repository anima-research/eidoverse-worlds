// The world itself: its log (server/worldlog.ts WorldLog, the authority over the world's directory) and the embodied plane in
// flight (connected clients, the dirty-pose batch, stage-frame bookkeeping; never persisted). A directory holding only an old
// log is refused at open with the command that translates it. The registry (getWorld/worldExists/worlds) lives here too.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WORLDS_DIR } from "./config.ts";
import { WorldLog, isWorldSaved, resetWorld } from "./worldlog.ts";
import { WorldScripts, type ScriptHost } from "./scripts.ts";
import type { HnSession } from "./auth.ts";
import { gateReach } from "./reachgate.ts";
import { WORLD_NAME_RE } from "./limits.ts";
import { accessTrace } from "./worldindex.ts";

// The settle rule (what a pose looks like to someone else) lives in server.ts; the log needs it for rememberPose, so it is injected at boot.
let settle: (pose: unknown) => Record<string, unknown> | null = () => {
  throw new Error("settledPose not wired — server.ts wires it at boot");
};
export function wireSettledPose(fn: typeof settle) { settle = fn; }

// A role change re-sends everyone's rights; that needs server.ts's rightsFor, so it arrives by injection like settle
// (this module never imports server.ts).
let onRightsChanged: (w: World) => void = () => {};
export function wireRights(rights: typeof onRightsChanged) { onRightsChanged = rights; }

// ------------------------------------------------------------------- clients

export type Client = {
  renamed?: boolean; renameRefused?: { tried: string; until: number };   // the join's rename and its cooldown (server.ts)
  id: string;          // participant's display name in this world (their identity is actorId, from the authority directory)
  ws: { send(data: string): void; close?(code?: number, reason?: string): void; getBufferedAmount?(): number; readyState?: number };
  world: World | null;
  /** latest pose, forwarded to late joiners. Only `.p` is dereferenced (world.near, held-thing reach); the rest rides opaque. */
  lastPose: ({ p?: [number, number, number] } & Record<string, unknown>) | null | undefined;
  avatar: string;      // VRM library path chosen at join
  spectator: boolean;  // retina/observer connections: receive everything, appear as nothing
  declares?: string;   // a status the participant declared at join (PROTOCOL §6a: its own word, e.g. "agent" or "ai"); absent = undeclared. Never inferred
  auth?: HnSession;    // archipelago-home session bound at WS upgrade (verified human)
  sub?: string;        // durable principal id when authenticated (`human:discord:…`)
  superseded?: boolean; // kicked by identity takeover — don't let its stale pose overwrite the successor's
  // what the sanctions sweep (server.ts sanctionSweep) last applied to this connection
  sfuMuted?: boolean; sanctionKey?: string;
  tokenVerified?: boolean; // this leg presented the identity's own bearer at join
  trustedRenderer?: boolean; // a renderer that presented RENDERER_TOKEN: may watch any world (access.ts)
  auxBound?: boolean;  // this aux leg is bound to the primary's identity (token bearer or matching login sub)
  gen?: number;        // this leg's transport epoch, monotonic, never reused; a superseded gen's rtc/attestation messages are refused
  legGen?: number;     // this leg's WORLD-scoped generation (World.legGen): survives sequencer restarts, rides caption entries
  presenceSession?: string; // `session` on arrive and snapshot.present: the joining page's id, else a token for this leg (server.ts presenceSession)
  surface?: string;    // "world" = the embodied primary (default); anything else is an auxiliary media leg (voice, vr-hands, …):
                       // invisible, poseless, log-mute, rtc-capable, reaped when its primary dies. Per-surface last-writer-wins.
  renderer?: boolean;  // an invisible browser renderer (legacy): donates rendering for its world
  roam?: boolean;      // a renderer the screenshot broker may send to any world that has none (screenshots.ts)
  capture?: import("./screenshots.ts").CaptureCapability; // opt-in embodied/native donor
  account?: string | null; // the account this connection PROVED at its first join (fixed for the socket's life); null = anonymous
  addr?: string | null; // the connection's address, hashed at upgrade (a guest's ban names it)
  anonymous?: boolean; // no account: a guest (a member unless the world raises guests; named as one)
  actorId?: string;      // a world's actor: this connection's opaque id from the authority directory (server/directory.ts)
  replica?: boolean;    // the client said it folds the log stream itself (every current client does; one that doesn't is refused at join)
  bcRing?: unknown[];  // dev crash forensics (?bc=1): last N breadcrumbs, printed on close
  // rate windows: a griefer or a stuck client gets silence, not fanout
  msgs: import("./msgrate.ts").MsgBucket;   // all messages: a token bucket (server/msgrate.ts)
  /** this connection's requests, one at a time in the order sent (server/requestwire.ts) */
  verbQueue?: Promise<void>;
  /** how many of them are still waiting their turn (requestwire.ts QUEUE_MAX) */
  queued?: number;
  /** the log head when this connection arrived in its world (server.ts join, beside the snapshot's cut). Speech is
   *  arrival-only: a say at or below it is never sent back to this connection unless it is an admin's. */
  arrivedSeq?: number;
};

// --------------------------------------------------------------- the world

/** One world: its log and the embodied plane in flight. */
export class World {
  name: string;
  /** The flight recorder: the log holds what HAPPENED, this ring what DIDN'T and why (refusals, rate limits, script
   *  events). In-memory, capped, never persisted; readable by anyone in the world (ws `debug`, `/debug`, `world_debug`). */
  debugLog: Record<string, unknown>[] = [];
  debug(kind: string, detail: Record<string, unknown>): void {
    this.debugLog.push({ ts: Date.now(), kind, ...detail });
    if (this.debugLog.length > 300) this.debugLog.splice(0, this.debugLog.length - 300);
  }
  /** Runtime scripts: the authority runs script:<name> components (server/scripts.ts). */
  scripts!: ScriptHost;
  /** The world's log: the authority over its directory (server/worldlog.ts). Replaced in place by resetWorld. */
  log: WorldLog;
  /** The embodied plane: who is connected, poses received since the last stage-frame tick (latest wins; one frame per
   *  world per tick, fanned out once), and the frame bookkeeping server.ts's stage-frame tick writes. Never persisted. */
  clients = new Set<Client>();
  dirty = new Map<string, unknown>();
  frameSeq = 0;
  recPath: string | null = null; // frames archive, created lazily on first recorded frame
  lastRoster = "";               // last written roster line — deltas only

  /** The log position this world was opened at, and the legs admitted since. A leg's GENERATION is
   *  `openSeq × 1e6 + count`: strictly increasing, and never lower than a previous opening's (each advanced the log).
   *  Past a million admissions per opening, legs are refused a generation rather than issued an ambiguous one. */
  readonly openSeq: number;
  private legCount = 0;
  legGen(): number {
    if (this.legCount >= 1_000_000) throw new Error(`world "${this.name}": a million legs admitted since opening — restart the sequencer to open a new generation space`);
    return this.openSeq * 1_000_000 + (++this.legCount);
  }

  modStateKey?: string;   // the last mod-state (muted badges) the sweep sent
  sfuMutedIds?: Set<string>;   // display ids the sweep has muted at the SFU (released when that connection is gone)
  /** Hold every standing pose that carries a reach to the tables as they are now: after each
   *  request, and on the sanctions tick, since a timed allow can end with no request at all. Quiet: no attempt recorded,
   *  nothing said to a reacher for a packet they didn't send. */
  regateReaches(): void {
    for (const c of this.clients) {
      if (!c.lastPose?.reach) continue;
      const p = structuredClone(c.lastPose) as Record<string, unknown>; gateReach(c, p, { quiet: true });
      if (JSON.stringify(p.reach ?? null) === JSON.stringify(c.lastPose.reach)) continue;
      c.lastPose = p as Client["lastPose"]; this.dirty.set(c.id, p);   // the next frame carries the pose without the hand
    }
  }
  /** Speech is arrival-only (PROTOCOL §5): the log keeps every say, people receive speech only for the time they were
   *  present, and only whoever holds the readChat permission (owners hold every one) reads it back past their arrival. */
  isAdmin(c: Client): boolean { return !!c.actorId && this.log.may(c.actorId, "readChat"); }
  /** The log seq at or below which this identity may not read a say back: null for an admin (no floor), else the
   *  earliest arrival among its connections here now; nobody here under it = Infinity (every say hidden). */
  sayFloor(actor: string): number | null {
    let floor = Infinity;
    for (const c of this.clients) if (c.actorId === actor) { if (this.isAdmin(c)) return null; if (Number.isInteger(c.arrivedSeq)) floor = Math.min(floor, c.arrivedSeq!); }
    return floor;
  }
  /** …for one connection (a connection with no identity: its own arrival). */
  sayFloorFor(c: Client): number | null {
    if (this.isAdmin(c)) return null;
    return c.actorId ? this.sayFloor(c.actorId) : (Number.isInteger(c.arrivedSeq) ? c.arrivedSeq! : Infinity);
  }
  /** The hooks a log needs from the world around it. */
  private logHost(log: WorldLog) {
    return {
      broadcast: (msg: unknown) => this.broadcast(msg),
      rightsChanged: () => onRightsChanged(this),
      debug: (kind: string, detail: Record<string, unknown>) => this.debug(kind, detail),
      present: () => [...this.clients].filter((c) => !c.spectator && c.actorId && (c.surface ?? "world") === "world").map((c) => ({ id: c.actorId!, at: Array.isArray(c.lastPose?.p) ? c.lastPose!.p! : null, ...(Number.isFinite(c.lastPose?.yaw) ? { yaw: c.lastPose!.yaw as number } : {}) })),   // yaw: the facing a carried thing turns by (heldQ)
      toActor: (actor: string, msg: unknown) => { const d = JSON.stringify(msg); let n = 0;
        for (const c of this.clients) if (c.actorId === actor && !c.spectator && (c.surface ?? "world") === "world") { try { c.ws.send(d); n++; } catch { /* gone */ } }
        return n > 0; },
      sayFloor: (actor: string) => this.sayFloor(actor),
      regateReaches: () => this.regateReaches(),
      resync: (why: string) => { for (const c of this.clients) try { c.ws.close?.(1012, why); } catch { /* gone */ } },   // 1012: they redial and rejoin
    };
  }

  constructor(name: string) {
    this.name = name;
    if (!isWorldSaved(name)) throw new Error(`world "${name}" holds no log here (a world saved by the old protocol is translated once, in place: bun tools/world.ts translate <its name>)`);
    this.log = this.openLog();
    this.openSeq = this.log.snapSeq + 1;   // past every chat line this world has numbered (seq × 1000)
    // Runtime scripts wake with the world — a timer keeps running with nobody connected, which is the point of running
    // server-side.
    this.scripts = new WorldScripts(this.log);
    this.scripts.sync();
    console.log(`[world:${name}] loaded — ${Object.keys(this.state.entities).length} things, seq ${this.log.seq}, `
      + `${Object.keys(this.poses).length} remembered poses`);
  }
  private openLog(): WorldLog {
    const log = new WorldLog(this.name);
    log.attach(this.logHost(log));
    return log;
  }

  /** The view of the world's fold (shared/protocol/view.js) plus the chat window, for this server's own readers. */
  get state() { return this.log.state; }
  get recentSays() { return this.log.recentSays; }
  get poses() { return this.log.poses; }

  broadcast(msg: unknown, except?: Client) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c !== except) c.ws.send(data);
  }
  readHistory(opts: { before?: number; after?: number; limit?: number; verbs?: Set<string> | null; floor?: number | null }) {
    return this.log.readHistory(opts);
  }
  rememberPose(id: string, pose: unknown) { this.log.rememberPose(id, pose, settle); }

  /** Erase the world back to zero (server/worldlog.ts resetWorld: archived beside it, founded again by the same owners);
   *  the fresh log replaces this one in place, so the people present rejoin the new world on their reload. Returns
   *  the archive directory. */
  resetWorld(): string {
    // a failure after the old log was moved aside retires this log: it would write a new world.jsonl
    // holding only what came after. A second reset is safe: it finishes the erase from the in-memory state, and the old
    // log stays in the first attempt's archive
    let arch: string;
    try { arch = resetWorld(this.log); } catch (e: any) { if (e?.logMoved) this.log.retire(WorldLog.HALF_RESET); throw e; }
    // the fresh log is on disk from here, so the world is erased whatever follows: an error carries the archive
    // (`resetDone`) and whether the fresh log opened (`opened`), so no answer reads as a reset that changed nothing
    let opened = false;
    try {
      this.log.retire();           // a request still awaiting warm() on the old log refuses instead of writing into the new file
      this.scripts.disposeAll();   // the old world's scripts stop with it: the fresh world has none
      this.log = this.openLog(); opened = true;
      this.scripts = new WorldScripts(this.log);
      this.scripts.sync();
    } catch (e) { throw Object.assign(new Error(String((e as Error)?.message ?? e)), { resetDone: arch, opened, cause: e }); }
    return arch;
  }
}

// -------------------------------------------------------------- the registry

export const worlds = new Map<string, World>();

// a function declaration on purpose: module-scope callers rely on hoisting
/** Does this world exist (in memory or on disk) without creating it? getWorld() founds on miss. The same test forkWorld uses. */
export function worldExists(name: string): boolean {
  if (!WORLD_NAME_RE.test(name)) return false;
  return worlds.has(name) || worldDirNamed(name);
}
/** Is there a world directory spelled exactly `name`? A case-insensitive filesystem finds "commons" for "Commons", and a
 *  second World over one log is a second authority: a name is served in its own case only. */
export function worldDirNamed(name: string): boolean {
  if (!existsSync(join(WORLDS_DIR, name))) return false;
  const now = Date.now();   // the listing is kept 5 s; a miss re-lists, so a new world is known at once
  if (now - dirsAt > 5000 || !dirs.has(name)) { try { dirs = new Set(readdirSync(WORLDS_DIR)); } catch { dirs = new Set(); } dirsAt = now; }
  return dirs.has(name);
}
let dirs = new Set<string>(), dirsAt = 0;

export function getWorld(name: string): World {
  if (!WORLD_NAME_RE.test(name)) throw new Error(`bad world name: ${name}`);
  let w = worlds.get(name);
  if (!w) { accessTrace("load", name); w = new World(name); worlds.set(name, w); }
  return w;
}

/** The world's authority clock (spec/PHYSICS.md §5.1): livehost's now(), never behind its log's last ts and never
 *  backwards, the clock that stamps entries' ts. Frames and clock replies carry it; wall time only for a world with no log. */
export const authorityNow = (w: any): number => { try { const t = w?.log?.live?.now?.(); if (typeof t === "number" && Number.isFinite(t)) return t; } catch {} return Date.now(); };
