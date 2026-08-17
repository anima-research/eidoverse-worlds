// boot-check — does the served client BOOT AT ALL? The whole suite is node-side
// and could not see a syntax error that killed the browser at module load
// (2026-08-16: the mesh-deletion commit left an orphaned `}` in main.js and
// staging served a dead client for five hours while every test stayed green).
// This is the "what does it print when broken" instrument for the client.
//
// 🔴 OWNS ITS SERVER (the #128 review lens, applied here before it was asked):
// the first version pointed at whatever answered on :8960, so its verdict was
// about an AMBIENT world — a stale server could buy a green, and on a clean
// checkout there was nothing to answer at all. It now spawns a child bound to
// a per-run nonce identity, exactly like isolation-headers-test. Pass an
// origin argv[1] to probe a LIVE deployment instead (the old behavior, now
// explicit): `bun tools/boot-check.mjs http://host:port` — identity checks are
// skipped in that mode because the deployment is not our child.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const LIVE = process.argv[2];                 // explicit live-deployment mode
const KEY = process.env.JOIN_KEY || 'dev';
let srv = null, scratch = null, ORIGIN = LIVE;
const NONCE = randomUUID();

if (!LIVE) {
  const PORT = 8981 + Math.floor(Math.random() * 15);
  scratch = mkdtempSync(join(tmpdir(), 'bootcheck-'));
  // process.execPath is only right when WE run under bun — this test runs
  // under node (playwright), where execPath is node and cannot run TS. The
  // house rule's target is Windows PATH shims; an absolute bun serves both.
  const BUN = process.execPath.includes('bun') ? process.execPath
    : (process.env.BUN_PATH || '/home/claude/.bun/bin/bun');
  srv = spawn(BUN, ['server/server.ts'], {
    env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: KEY, WORLDS_DIR: scratch,
           EIDO_BOOT_NONCE: NONCE },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  ORIGIN = `http://127.0.0.1:${PORT}`;
  // Identity: prefer the nonce echo (#128's /version addition). A server that
  // PREDATES it answers /version without the field — accept that only when
  // the child is alive AND the reported startedAt is newer than our spawn
  // (a stale pre-nonce listener started long ago; ours started just now).
  // Wrong nonce = a different nonce-speaking server = always fail.
  const spawnedAt = Date.now() - 2000;
  let ours = false, reason = 'never answered';
  for (let i = 0; i < 60 && !ours; i++) {
    if (srv.exitCode !== null) { reason = `exited ${srv.exitCode}`; break; }
    try {
      const v = await (await fetch(`${ORIGIN}/version`)).json();
      if (v.nonce !== undefined) { ours = v.nonce === NONCE; if (!ours) { reason = 'wrong nonce (not our child)'; break; } }
      else { ours = Date.parse(v.startedAt) >= spawnedAt; if (!ours) { reason = `pre-nonce responder started ${v.startedAt} (stale listener)`; break; } }
    } catch { /* not up yet */ }
    if (!ours) await new Promise((r) => setTimeout(r, 250));
  }
  if (!ours) {
    console.log(`FAIL — child server never came up as OURS (${reason})`);
    try { srv.kill('SIGKILL'); } catch {}
    process.exit(1);
  }
}

const b = await chromium.launch({ executablePath: '/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
try {
  const pg = await (await b.newContext()).newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  await pg.goto(`${ORIGIN}/?world=staging&name=bootcheck&key=${KEY}`, { waitUntil: 'networkidle' });
  await new Promise(r => setTimeout(r, 3000));
  const n = await pg.evaluate(() => document.querySelectorAll('.sec').length);
  if (errs.length) { console.log('FAIL — page errors:\n  ' + errs.slice(0, 4).join('\n  ')); process.exit(1); }
  if (!n) { console.log('FAIL — zero .sec panels rendered (boot died silently)'); process.exit(1); }
  console.log(`ok — client boots, ${n} panels rendered, no page errors${LIVE ? ' (live deployment)' : ' (owned child)'}`);
} finally {
  await b.close();
  if (srv) {
    srv.kill('SIGTERM');
    await new Promise((r) => { const t = setTimeout(() => { try { srv.kill('SIGKILL'); } catch {} r(); }, 3000); srv.once('exit', () => { clearTimeout(t); r(); }); });
  }
  if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } }
}
