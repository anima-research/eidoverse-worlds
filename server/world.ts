// eidoverse-worlds sequencer — the world itself.
//
// A World is one v4 world as this server holds it: its log (server/v4/world.ts V4Log: the door over the world's
// directory) and the embodied plane in flight (connected clients, the dirty-pose batch, stage-frame bookkeeping, never
// persisted). Every world this server serves is a v4 world: a directory that holds only an old (v1) log is refused at
// open, with the command that translates it (shared/v4/import-v1/, run once by the operator).
// The registry (getWorld/worldExists/worlds) lives here too; the boot sweep that wakes scripted worlds stays in
// server.ts — waking scripted worlds with the server is boot policy, not world mechanics.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { WORLDS_DIR } from "./config.ts";
import { V4Log, isV4World, resetV4 } from "./v4/world.ts";
import { V4Scripts, type ScriptHost } from "./v4/scripts.ts";
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
let v4Rights: (w: World) => void = () => {};
export function wireV4(rights: typeof v4Rights) { v4Rights = rights; }

// ------------------------------------------------------------------- clients

export type Client = {
  id: string;          // participant's display name in this world (their identity is v4id, from the door directory)
  ws: { send(data: string): void; close?(code?: number, reason?: string): void; getBufferedAmount?(): number; readyState?: number };
  world: World | null;
  /** latest pose, forwarded to late joiners so they see everyone immediately.
   *  Minimal structure over an open record: the presence checks (scripts'
   *  world.near, the door's held-thing reach) dereference `.p`, everything
   *  else rides opaque. */
  lastPose: ({ p?: [number, number, number] } & Record<string, unknown>) | null | undefined;
  avatar: string;      // VRM library path chosen at join
  spectator: boolean;  // retina/observer connections: receive everything, appear as nothing
  agent?: boolean;     // self-declared: an MCPL body, not a person at a keyboard
  auth?: HnSession;    // archipelago-home session bound at WS upgrade (verified human)
  sub?: string;        // durable principal id when authenticated (`human:discord:…`)
  superseded?: boolean; // kicked by identity takeover — don't let its stale pose overwrite the successor's
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
  v4id?: string;      // a v4 world's actor: this connection's opaque id from the door directory (server/v4/directory.ts)
  v4fold?: boolean;    // the client said it folds the v4 stream itself (every current client does; one that doesn't is refused at join)
  bcRing?: unknown[];  // dev crash forensics (?bc=1): last N breadcrumbs, printed on close
  // rate windows: a griefer or a stuck client gets silence, not fanout
  msgWin: number; msgCount: number;   // all messages, per second
  /** this connection's door requests, one at a time in the order sent (server/v4/messages.ts) */
  verbQueue?: Promise<void>;
};

// --------------------------------------------------------------- the world

/** One v4 world: its log and the embodied plane in flight. */
export class World {
  name: string;
  /** The runtime's flight recorder — the "why didn't it work" surface.
   *
   *  The world log holds what HAPPENED; this ring holds what DIDN'T and why:
   *  requests the door refused, rate limits, script events. In-memory only,
   *  capped, never persisted — it is diagnosis, not history. Readable by
   *  anyone in the world (ws `debug`, `/debug` in the client, `world_debug`
   *  over MCPL): the log is public, so the reasons things bounced off it are
   *  public too. */
  debugLog: Record<string, unknown>[] = [];
  debug(kind: string, detail: Record<string, unknown>): void {
    this.debugLog.push({ ts: Date.now(), kind, ...detail });
    if (this.debugLog.length > 300) this.debugLog.splice(0, this.debugLog.length - 300);
  }
  /** Runtime scripts: the door runs script:<name> components (server/v4/scripts.ts). */
  bhv!: ScriptHost;
  /** The world's log: the door over its directory (server/v4/world.ts). Replaced in place by resetV4. */
  v4: V4Log;
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

  constructor(name: string) {
    this.name = name;
    if (!isV4World(name)) throw new Error(`world "${name}" holds no v4 log here (an old v1 world is translated once: bun tools/v4/world.ts translate <its dir> <a new dir>)`);
    this.v4 = this.openLog();
    this.openSeq = this.v4.snapSeq + 1;   // past every chat line this world has numbered (v4seq × 1000)
    // Runtime scripts wake with the world — a timer keeps running with nobody connected, which is the point of running
    // server-side.
    this.bhv = new V4Scripts(this.v4);
    this.bhv.sync();
    console.log(`[world:${name}] loaded — ${Object.keys(this.state.entities).length} things, v4 head ${this.v4.head}, `
      + `${Object.keys(this.poses).length} remembered poses`);
  }
  private openLog(): V4Log {
    const v4 = new V4Log(this.name);
    v4.attach({
      broadcast: (msg) => this.broadcast(msg),
      rightsChanged: () => v4Rights(this),
      debug: (kind, detail) => this.debug(kind, detail),
      present: () => [...this.clients].filter((c) => !c.spectator && c.v4id && (c.surface ?? "world") === "world").map((c) => ({ id: c.v4id!, at: Array.isArray(c.lastPose?.p) ? c.lastPose!.p! : null })),
    });
    return v4;
  }

  /** The view of the world's fold (shared/v4/record.js) plus the chat window, for this server's own readers. */
  get state() { return this.v4.state; }
  get recentSays() { return this.v4.recentSays; }
  get poses() { return this.v4.poses; }

  broadcast(msg: unknown, except?: Client) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c !== except) c.ws.send(data);
  }
  readHistory(opts: { before?: number; after?: number; limit?: number; verbs?: Set<string> | null }) {
    return this.v4.readHistory(opts);
  }
  rememberPose(id: string, pose: unknown) { this.v4.rememberPose(id, pose, settle); }

  /** Erase the world back to zero (server/v4/world.ts resetV4: archived beside it, founded again by the same owners);
   *  the fresh log replaces this one in place, so the people present rejoin the new world on their reload. Returns
   *  the archive directory. */
  resetV4(): string {
    const arch = resetV4(this.v4);
    this.bhv.disposeAll();   // the old world's scripts stop with it: the fresh world has none
    this.v4 = this.openLog();
    this.bhv = new V4Scripts(this.v4);
    this.bhv.sync();
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
