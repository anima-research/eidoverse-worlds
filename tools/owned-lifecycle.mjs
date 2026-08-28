// owned-lifecycle — everything a browser-driven probe spawns, and the one
// owner that always takes it back down (#151 review, blockers 1 and 2).
//
// Two failures this exists to make impossible:
//
//   · A probe that advertises `node tools/…` and then uses a global that does
//     not exist on the reviewer's Node. `WebSocket` became global in Node 22;
//     the house runs 20.20.2, where the door test died with
//     `ReferenceError: WebSocket is not defined`. A receipt has to be produced
//     by the same command the next person can run.
//
//   · A probe that fails BEFORE its try/finally and leaves its child running.
//     That exact failure left a sequencer listening on :9471 on the reviewer's
//     machine, killed by hand. Anything spawned is registered with a Lifecycle
//     the moment it exists, and the Lifecycle is bound to the process — normal
//     return, throw, SIGINT, unhandled rejection, all the same owner.
//
// And one thing it refuses to assume: that whatever answers on a port is ours.
// The sequencer echoes EIDO_BOOT_NONCE from /version, so ownership is PROVEN
// rather than inferred from a 200. A stale listener squatting the port fails
// the check instead of quietly satisfying it.
//
// (tools/probe-harness.mjs grew the same nonce proof for the same reason. The
// two want consolidating; that is a separate change than this one, since that
// file is shared by probes this PR does not touch.)

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

// ---- the runtime contract ---------------------------------------------------

export const NODE_MIN_GLOBAL_WS = 22;

/** A WebSocket constructor, wherever this Node keeps one.
 *
 *  Node 22+ has it as a global. Node 20 does not, and the honest fix is not
 *  "run a newer Node" — it is to depend on the same `ws` the rest of this repo
 *  already speaks. Throws with the actual remedy if neither is available. */
export async function resolveWebSocket() {
  const major = Number(process.versions.node.split('.')[0]);
  if (typeof globalThis.WebSocket === 'function') {
    return { WebSocket: globalThis.WebSocket, source: `global (node ${process.versions.node})` };
  }
  try {
    const mod = await import('ws');
    const WS = mod.WebSocket ?? mod.default;
    if (typeof WS !== 'function') throw new Error('the ws package exported no WebSocket');
    return { WebSocket: WS, source: `ws package (node ${process.versions.node} has no global)` };
  } catch (e) {
    throw new Error(
      `no WebSocket available on node ${process.versions.node}: the global arrived in node `
      + `${NODE_MIN_GLOBAL_WS}, and the "ws" package did not load either (${String(e.message ?? e).slice(0, 120)}). `
      + 'Run `bun install` (ws is a devDependency) or use node ' + NODE_MIN_GLOBAL_WS + '+.');
  }
}

// ---- the owner --------------------------------------------------------------

/** Idempotent teardown for everything a run owns.
 *
 *  Register the moment a thing exists, not when the happy path is finished
 *  with it — the leak this replaces happened between "spawned" and "entered
 *  the try". Disposers run newest-first and every one of them is attempted
 *  even if an earlier one throws. */
export class Lifecycle {
  constructor({ bindSignals = true } = {}) {
    this._items = [];
    this._done = false;
    this._bound = null;
    if (bindSignals) this._bind();
  }

  /** @param {string} label @param {() => any} dispose */
  own(label, dispose) {
    this._items.push({ label, dispose });
    return dispose;
  }

  get size() { return this._items.length; }
  get disposed() { return this._done; }

  async dispose(reason = 'normal') {
    if (this._done) return [];
    this._done = true;
    const errors = [];
    for (const { label, dispose } of [...this._items].reverse()) {
      try { await dispose(); } catch (e) { errors.push(`${label}: ${String(e.message ?? e).slice(0, 160)}`); }
    }
    this._items = [];
    this._unbind();
    if (errors.length) console.error(`[lifecycle] cleanup (${reason}) had problems:\n  ${errors.join('\n  ')}`);
    return errors;
  }

  _bind() {
    const bye = (reason) => () => {
      // best effort and synchronous-ish: a signal handler cannot await forever
      this.dispose(reason).finally(() => process.exit(reason === 'SIGINT' ? 130 : 1));
    };
    this._bound = {
      SIGINT: bye('SIGINT'), SIGTERM: bye('SIGTERM'),
      uncaughtException: (e) => { console.error('[lifecycle] uncaught:', e); bye('uncaughtException')(); },
      unhandledRejection: (e) => { console.error('[lifecycle] unhandled rejection:', e); bye('unhandledRejection')(); },
    };
    for (const [sig, fn] of Object.entries(this._bound)) process.on(sig, fn);
  }

  _unbind() {
    if (!this._bound) return;
    for (const [sig, fn] of Object.entries(this._bound)) process.off(sig, fn);
    this._bound = null;
  }
}

// ---- proving the child is ours ---------------------------------------------

/** Is anything listening there at all? Used to PROVE a port was released. */
export function portIsOpen(port, host = '127.0.0.1', timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    const done = (open) => { sock.destroy(); resolve(open); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * Ask the responder to prove it is the child we spawned.
 *
 * ONLY the nonce echo counts. A 200 on `/` proves a listener exists, which is
 * exactly what a stale sequencer squatting the port also provides; a
 * startedAt-freshness fallback reopens the just-started-impostor race. A
 * responder with no `nonce` field is by definition not ours.
 */
export async function proveOurs(origin, nonce, { tries = 80, gapMs = 250, alive = () => true } = {}) {
  let reason = 'never answered';
  for (let i = 0; i < tries; i++) {
    if (!alive()) return { ours: false, reason: 'the child exited before answering' };
    try {
      const res = await fetch(`${origin}/version`);
      if (!res.ok) { reason = `/version answered ${res.status}`; }
      else {
        const v = await res.json();
        if (v.nonce === undefined) return { ours: false, reason: 'responder has no nonce field (stale or foreign listener)' };
        if (v.nonce !== nonce) return { ours: false, reason: 'wrong nonce — something else owns this port' };
        return { ours: true, reason: 'nonce echoed', version: v };
      }
    } catch { reason = 'not listening yet'; }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return { ours: false, reason };
}

// ---- the child --------------------------------------------------------------

const BUN = () => (process.env.BUN_PATH
  || (process.execPath.includes('bun') ? process.execPath : null)
  || (process.platform === 'win32' ? `${process.env.USERPROFILE}\\.bun\\bin\\bun.exe` : `${process.env.HOME}/.bun/bin/bun`));

/**
 * Spawn a sequencer this run OWNS, prove it, and hand back where it lives.
 *
 * Registered with the Lifecycle BEFORE readiness is awaited, so a child that
 * never comes up is still a child that gets killed.
 */
export async function ownedWorld(lifecycle, { key = 'door-test', env = {}, port = null } = {}) {
  const PORT = port ?? 8990 + Math.floor(Math.random() * 900);
  const worldsDir = mkdtempSync(join(tmpdir(), 'owned-world-'));
  const nonce = randomUUID();
  const origin = `http://127.0.0.1:${PORT}`;

  if (await portIsOpen(PORT)) {
    rmSync(worldsDir, { recursive: true, force: true });
    throw new Error(`port ${PORT} is already in use — refusing to spawn onto someone else's listener`);
  }

  const child = spawn(BUN(), ['run', 'server/server.ts'], {
    env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: key, WORLDS_DIR: worldsDir, EIDO_BOOT_NONCE: nonce, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));

  // owned IMMEDIATELY — the whole point is that nothing between here and the
  // happy path can orphan it
  const close = lifecycle.own(`sequencer :${PORT}`, async () => {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    await new Promise((r) => {
      if (child.exitCode !== null) return r();
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } r(); }, 3000);
      child.once('exit', () => { clearTimeout(t); r(); });
    });
    try { rmSync(worldsDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const proof = await proveOurs(origin, nonce, { alive: () => child.exitCode === null });
  if (!proof.ours) {
    throw new Error(`owned world never came up as OURS on :${PORT} (${proof.reason})`
      + (log.length ? `\n--- child output ---\n${log.join('').slice(-1200)}` : ''));
  }
  return { origin, port: PORT, worldsDir, nonce, key, close, childPid: child.pid, output: () => log.join('') };
}
