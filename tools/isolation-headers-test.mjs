#!/usr/bin/env bun
// Isolation headers — does every response actually carry COOP/COEP?
//
// 🔴 WHY THIS EXISTS. The PR that adds these headers had NO test. Its whole
// claim is "wasm gets its threads back", which depends on `crossOriginIsolated`
// being true in the browser, which depends on BOTH headers riding EVERY
// response — not just the document. A worker script served without them
// silently degrades the entire context back to single-threaded, and the only
// symptom is the thing being slow, which is exactly the symptom we started with.
//
// The failure this guards is REGRESSION BY ROUTE: someone adds a route that
// returns early, or wraps the table, and the document keeps its headers while
// /client/lib/*.js quietly loses them. Testing only `/` would pass.
//
// It boots a real server on a scratch port and reads real responses. It does
// NOT test that threads got faster — that is a benchmark, and a separate claim.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PORT = 8971 + Math.floor(Math.random() * 20);
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// 🔴 IDENTITY, NOT JUST A LISTENER (review: "we have already had an old 89xx
// listener buy a false green in this repository"). The child echoes this
// per-run nonce on /version; readiness and every later probe are bound to it,
// so a stale server that lost us to EADDRINUSE cannot answer for the child.
const NONCE = randomUUID();
const scratch = mkdtempSync(join(tmpdir(), 'iso-'));
const srv = spawn(process.execPath, ['server/server.ts'], {
  env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: 'iso-test',
         WORLDS_DIR: scratch, EIDO_BOOT_NONCE: NONCE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', () => {});

const childAlive = () => srv.exitCode === null && !srv.killed;
const identity = async () => {
  const v = await (await fetch(`http://127.0.0.1:${PORT}/version`)).json();
  return v.nonce === NONCE;
};
const up = async () => {
  for (let i = 0; i < 60; i++) {
    if (!childAlive()) return false;            // died (EADDRINUSE etc.) — never green
    try { if (await identity()) return true; }  // an answer that isn't OURS is not readiness
    catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

try {
  if (!await up()) { console.log(`FAIL server never came up as OURS (child ${childAlive() ? 'alive' : `exited ${srv.exitCode}`})`); process.exit(1); }

  // The document itself.
  const doc = await fetch(`http://127.0.0.1:${PORT}/`);
  ok('document sends COOP',
     doc.headers.get('cross-origin-opener-policy') === 'same-origin',
     `got ${doc.headers.get('cross-origin-opener-policy')}`);
  ok('document sends COEP credentialless',
     doc.headers.get('cross-origin-embedder-policy') === 'credentialless',
     `got ${doc.headers.get('cross-origin-embedder-policy')}`);

  // 🔴 THE ONE THAT ACTUALLY MATTERS. A module script without COEP breaks
  // isolation for the whole context even when the document has it.
  // 🔴 REAL 200s, NOT 404s. The first draft asked for '/client/main.js', which
  // the catch-all resolves under client/ — so it 404'd, and a 404 carrying the
  // headers proves much less than a real module doing so. The static tree is
  // rooted AT client/, so the module is '/main.js'. Checked the route table
  // (routes.ts:677) rather than guessing a second time.
  for (const path of ['/main.js', '/lib/core.js', '/nonexistent-404']) {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
    if (path !== '/nonexistent-404') ok(`${path} is really served (not a 404)`, r.status === 200, `status ${r.status}`);
    ok(`${path} (${r.status}) carries both headers`,
       r.headers.get('cross-origin-opener-policy') === 'same-origin'
       && r.headers.get('cross-origin-embedder-policy') === 'credentialless',
       `COOP=${r.headers.get('cross-origin-opener-policy')} COEP=${r.headers.get('cross-origin-embedder-policy')}`);
  }

  // credentialless, NOT require-corp: require-corp would block any cross-origin
  // subresource that does not opt in, which is a different (breaking) product
  // decision. Pin the exact value so a "stricter is safer" edit has to argue.
  ok('COEP is credentialless, not require-corp',
     doc.headers.get('cross-origin-embedder-policy') !== 'require-corp');

  // The websocket upgrade must be untouched — isolate() returning a modified
  // response (or throwing on undefined) would break every world connection.
  // A 101 never reaches fetch(), so the observable is: the socket still opens.
  const wsOk = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 4000);
    ws.onopen = () => { clearTimeout(t); ws.close(); resolve(true); };
    ws.onerror = () => { clearTimeout(t); resolve(false); };
  });
  ok('websocket upgrade still succeeds under isolate()', wsOk);

  // Bind the whole vector run to the child one last time: still alive, still
  // answering with our nonce. A mid-run crash + stale listener would otherwise
  // pass every header assertion above.
  ok('child is still alive after the vectors', childAlive(), `exitCode=${srv.exitCode}`);
  ok('responder is still OUR child (nonce echo)', await identity().catch(() => false));
} finally {
  // TERM first (let it close sockets), escalate to KILL, then remove scratch.
  srv.kill('SIGTERM');
  await new Promise((r) => { const t = setTimeout(() => { try { srv.kill('SIGKILL'); } catch {} r(); }, 3000); srv.once('exit', () => { clearTimeout(t); r(); }); });
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
