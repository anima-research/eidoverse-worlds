// eidoverse-worlds sequencer — the world itself.
//
// A World is one world as this server holds it: its log (server/worldlog.ts WorldLog: the authority over the world's
// directory) and the embodied plane in flight (connected clients, the dirty-pose batch, stage-frame bookkeeping, never
// persisted). Every world this server serves speaks the current protocol: a directory that holds only an old log (the first
// protocol's log.jsonl) is refused at open, with the command that translates it (tools/protocol/import-v1/, run once by the
// operator).
// The registry (getWorld/worldExists/worlds) lives here too; the boot sweep that wakes scripted worlds stays in
// server.ts — waking scripted worlds with the server is boot policy, not world mechanics.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { WORLDS_DIR } from "./config.ts";
import { WorldLog, isWorldSaved, resetWorld } from "./worldlog.ts";
import { WorldScripts, type ScriptHost } from "./scripts.ts";
import type { HnSession } from "./auth.ts";

// The settle rule — what a pose looks like TO SOMEONE ELSE — is pinned to
// server.ts by source-text gates (§15.1: settled-pose-test regexes the file
// itself). The log needs it for rememberPose, so it arrives by injection at
// boot: one implementation, two planes.
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
  /** latest pose, forwarded to late joiners so they see everyone immediately.
   *  Minimal structure over an open record: the presence checks (scripts'
   *  world.near, the authority's held-thing reach) dereference `.p`, everything
   *  else rides opaque. */
  lastPose: ({ p?: [number, number, number] } & Record<string, unknown>) | null | undefined;
  avatar: string;      // VRM library path chosen at join
  spectator: boolean;  // retina/observer connections: receive everything, appear as nothing
  agent?: boolean;     // self-declared: an MCPL body, not a person at a keyboard
  auth?: HnSession;    // archipelago-home session bound at WS upgrade (verified human)
  sub?: string;        // durable principal id when authenticated (`human:discord:…`)
  superseded?: boolean; // kicked by identity takeover — don't let its stale pose overwrite the successor's
  // roles S4 / ghost: what the sanctions sweep (server.ts sanctionSweep) last applied to this connection
  sfuMuted?: boolean; sfuDeaf?: boolean; ghostHidden?: boolean; sanctionKey?: string;
  tokenVerified?: boolean; // this leg presented the identity's own bearer at join
  auxBound?: boolean;  // this aux leg is bound to the primary's identity authority (token bearer OR matching login sub) — the B1 admission result, reused by the B3 attest gate
  gen?: number;        // surfaceSession (#57 B2): server-issued transport epoch for THIS leg.
  legGen?: number;     // this leg's WORLD-scoped generation (World.legGen): survives sequencer restarts, rides caption entries
                       // Monotonic, never reused. Every rtc/attestation message is stamped with
                       // it, and a superseded generation's messages are refused structurally —
                       // takeover retires the GENERATION, not just the socket.
  surface?: string;    // (name, surface) session model: "world" = the embodied primary (default);
                       // anything else = an auxiliary media leg (voice, vr-hands, …) — invisible,
                       // poseless, log-mute, rtc-capable, and REAPED when its primary dies.
                       // Per-surface last-writer-wins replaces the flat one-body rule (2026-08-07;
                       // prior art: Discord voice legs keyed to gateway sessions, XMPP resources).
  renderer?: boolean;  // donates rendering: can answer snap requests for its world
  account?: string | null; // the account this connection PROVED at its first join (fixed for the socket's life); null = anonymous
  addr?: string | null; // the connection's address, hashed at upgrade (a guest's ban names it)
  anonymous?: boolean; // no account: a guest (capped at visitor; named as one)
  actorId?: string;      // a world's actor: this connection's opaque id from the authority directory (server/directory.ts)
  replica?: boolean;    // the client said it folds the log stream itself (every current client does; one that doesn't is refused at join)
  bcRing?: unknown[];  // dev crash forensics (?bc=1): last N breadcrumbs, printed on close
  // rate windows: a griefer or a stuck client gets silence, not fanout
  msgWin: number; msgCount: number;   // all messages, per second
  /** this connection's requests, one at a time in the order sent (server/requestwire.ts) */
  verbQueue?: Promise<void>;
};

// --------------------------------------------------------------- the world

/** One world: its log and the embodied plane in flight. */
export class World {
  name: string;
  /** The runtime's flight recorder — the "why didn't it work" surface.
   *
   *  The world log holds what HAPPENED; this ring holds what DIDN'T and why:
   *  requests the authority refused, rate limits, script events. In-memory only,
   *  capped, never persisted — it is diagnosis, not history. Readable by
   *  anyone in the world (ws `debug`, `/debug` in the client, `world_debug`
   *  over MCPL): the log is public, so the reasons things bounced off it are
   *  public too. */
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

  /** The log position this sequencer opened the world at, and the legs admitted
   *  since. A leg's GENERATION is `openSeq × 1e6 + count`: server-issued,
   *  strictly increasing within an opening, and never lower than any
   *  generation a previous opening issued (every say a leg made advanced the
   *  log past the opening that issued it). A million admissions per opening is
   *  the bound; past it the opening refuses further legs a generation rather
   *  than issuing an ambiguous one. */
  readonly openSeq: number;
  private legCount = 0;
  legGen(): number {
    if (this.legCount >= 1_000_000) throw new Error(`world "${this.name}": a million legs admitted since opening — restart the sequencer to open a new generation space`);
    return this.openSeq * 1_000_000 + (++this.legCount);
  }

  /** Is this connection a ghost here (PLAN 10-06: in the world, outside society)? A sanction or a chosen mode. */
  modStateKey?: string;   // the last mod-state (muted badges) the sweep sent
  sfuMutedIds?: Set<string>;   // display ids the sweep has muted at the SFU (released when that connection is gone)
  sfuDeafIds?: Set<string>;    // display ids the sweep has deafened at the SFU (ghosts; released likewise)
  isGhost(c: Client): boolean { return !!(this.log && c.actorId && this.log.ghostHere(c.actorId)); }
  /** The hooks a log needs from the world around it. A ghost is left out of `present` (scripts don't sense them) and
   *  is sent the log with every say emptied (it can't read chat). */
  private logHost(log: WorldLog) {
    return {
      broadcast: (msg: unknown) => this.broadcast(msg),
      broadcastLog: (msg: unknown, ghostMsg: unknown) => { const d = JSON.stringify(msg), g = JSON.stringify(ghostMsg);
        const S = log.sanctions();   // once per broadcast, not a moderator-log scan per client (review 10-07)
        for (const c of this.clients) { try { c.ws.send(c.actorId && (S[c.actorId] as any)?.ghost ? g : d); } catch { /* gone */ } } },
      rightsChanged: () => onRightsChanged(this),
      debug: (kind: string, detail: Record<string, unknown>) => this.debug(kind, detail),
      present: () => [...this.clients].filter((c) => !c.spectator && c.actorId && (c.surface ?? "world") === "world" && !log.ghostHere(c.actorId)).map((c) => ({ id: c.actorId!, at: Array.isArray(c.lastPose?.p) ? c.lastPose!.p! : null })),
      toActor: (actor: string, msg: unknown) => { const d = JSON.stringify(msg); let n = 0;
        for (const c of this.clients) if (c.actorId === actor && !c.spectator && (c.surface ?? "world") === "world") { try { c.ws.send(d); n++; } catch { /* gone */ } }
        return n > 0; },
    };
  }

  constructor(name: string) {
    this.name = name;
    if (!isWorldSaved(name)) throw new Error(`world "${name}" holds no log here (a world saved by the old protocol is translated once, in place: bun tools/protocol/world.ts translate <its name>)`);
    this.log = this.openLog();
    this.openSeq = this.log.snapSeq + 1;   // past every chat line this world has numbered (seq × 1000)
    // Runtime scripts wake with the world — a timer keeps running with nobody connected, which is the point of running
    // server-side.
    this.scripts = new WorldScripts(this.log);
    this.scripts.sync();
    console.log(`[world:${name}] loaded — ${Object.keys(this.state.entities).length} things, head ${this.log.head}, `
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
  readHistory(opts: { before?: number; after?: number; limit?: number; verbs?: Set<string> | null }) {
    return this.log.readHistory(opts);
  }
  rememberPose(id: string, pose: unknown) { this.log.rememberPose(id, pose, settle); }

  /** Erase the world back to zero (server/worldlog.ts resetWorld: archived beside it, founded again by the same owners);
   *  the fresh log replaces this one in place, so the people present rejoin the new world on their reload. Returns
   *  the archive directory. */
  resetWorld(): string {
    const arch = resetWorld(this.log);
    this.log.retire();           // a request still awaiting warm() on the old log refuses instead of writing into the new file
    this.scripts.disposeAll();   // the old world's scripts stop with it: the fresh world has none
    this.log = this.openLog();
    this.scripts = new WorldScripts(this.log);
    this.scripts.sync();
    return arch;
  }
}

// -------------------------------------------------------------- the registry

export const worlds = new Map<string, World>();

// A function DECLARATION on purpose (§15.1): hoisting is load-bearing for
// module-scope callers — the unsplit boot sweep called it above its
// definition, and keeping the declaration form keeps that shape legal.
/** Does this world already exist — in memory or on disk — WITHOUT creating it?
 *  getWorld() founds on miss, which is right for a join by someone entitled to
 *  found and wrong for everyone else (RFC-005 §3.2.7: founding is not joining).
 *  Same test forkWorld uses to refuse an occupied name. */
export function worldExists(name: string): boolean {
  if (!/^[a-z0-9_-]{1,64}$/i.test(name)) return false;
  return worlds.has(name) || existsSync(join(WORLDS_DIR, name));
}

export function getWorld(name: string): World {
  if (!/^[a-z0-9_-]{1,64}$/i.test(name)) throw new Error(`bad world name: ${name}`);
  let w = worlds.get(name);
  if (!w) { w = new World(name); worlds.set(name, w); }
  return w;
}

/** The world's authority clock (spec/PHYSICS.md §5.1): livehost's now(), never behind its log's last ts and never
 *  backwards, the clock that stamps entries' ts. Frames and clock replies carry it; wall time only for a world with no log. */
export const authorityNow = (w: any): number => { try { const t = w?.log?.live?.now?.(); if (typeof t === "number" && Number.isFinite(t)) return t; } catch {} return Date.now(); };
