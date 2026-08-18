// probe-harness — the owned foundations every browser probe shares (#131
// review, item 3). Two portability sins this replaces, each measured on the
// macOS review host:
//
// 1. A HARDCODED Linux browser path (`~/.cache/ms-playwright/chromium-1228/…`)
//    in seven probes — every one failed before behavior on any other platform.
//    Browser resolution here: `SFU_TEST_CHROME` env override (same knob as the
//    sfu mini-smoke) ▸ otherwise Playwright's MANAGED browser for the pinned
//    playwright version (`bunx playwright install chromium` on a clean
//    checkout fetches the right build for the current platform).
//
// 2. AMBIENT fixed ports (`127.0.0.1:8946`/`:8960`): the probe's verdict was
//    about whatever answered there — a stale staging server could buy a green,
//    and a clean checkout had nothing to answer at all. `ownedWorld()` spawns
//    a child bound to a per-run nonce identity in scratch state and REFUSES to
//    proceed unless the responder proves it is ours (the boot-check pattern,
//    which was already the #128 review lens applied). Probing a LIVE
//    deployment stays possible but explicit: pass its origin, and identity
//    checks are skipped because the deployment is not our child.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** SFU_TEST_CHROME override ▸ managed browser. `mic: true` adds the fake-media
 *  flags a microphone probe needs (and its contexts get mic permission). */
export async function launchBrowser({ mic = false } = {}) {
  const exe = process.env.SFU_TEST_CHROME;
  const args = mic ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required'] : [];
  const b = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args });
  const page = async () => {
    const ctx = await b.newContext(mic ? { permissions: ['microphone'] } : {});
    return ctx.newPage();
  };
  return { browser: b, page, close: () => b.close() };
}

/** Spawn a world server this run OWNS, prove it is ours, hand back origin +
 *  teardown. Pass `live: "http://host:port"` to probe a deployment instead
 *  (explicit, identity unchecked — it is not our child). */
export async function ownedWorld({ live = null, key = process.env.JOIN_KEY || 'dev' } = {}) {
  if (live) return { origin: live, key, owned: false, close: async () => {} };
  const PORT = 8981 + Math.floor(Math.random() * 15);
  const scratch = mkdtempSync(join(tmpdir(), 'probe-'));
  const NONCE = randomUUID();
  // process.execPath is only right when WE run under bun — under node it
  // cannot run TS. An absolute bun serves both (house rule's target is
  // Windows PATH shims); BUN_PATH overrides for other layouts.
  const BUN = process.execPath.includes('bun') ? process.execPath
    : (process.env.BUN_PATH || '/home/claude/.bun/bin/bun');
  const srv = spawn(BUN, ['server/server.ts'], {
    env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: key, WORLDS_DIR: scratch,
           EIDO_BOOT_NONCE: NONCE },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const origin = `http://127.0.0.1:${PORT}`;
  // Identity: prefer the nonce echo; a pre-nonce server is accepted only when
  // the child is alive AND startedAt is newer than our spawn. Wrong nonce =
  // someone else's server = always fail.
  const spawnedAt = Date.now() - 2000;
  let ours = false, reason = 'never answered';
  for (let i = 0; i < 60 && !ours; i++) {
    if (srv.exitCode !== null) { reason = `exited ${srv.exitCode}`; break; }
    try {
      const v = await (await fetch(`${origin}/version`)).json();
      if (v.nonce !== undefined) { ours = v.nonce === NONCE; if (!ours) { reason = 'wrong nonce (not our child)'; break; } }
      else { ours = Date.parse(v.startedAt) >= spawnedAt; if (!ours) { reason = `pre-nonce responder started ${v.startedAt} (stale listener)`; break; } }
    } catch { /* not up yet */ }
    if (!ours) await new Promise((r) => setTimeout(r, 250));
  }
  const close = async () => {
    try { srv.kill('SIGTERM'); } catch { /* gone */ }
    await new Promise((r) => { const t = setTimeout(() => { try { srv.kill('SIGKILL'); } catch {} r(); }, 3000);
      srv.once('exit', () => { clearTimeout(t); r(); }); });
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  if (!ours) { await close(); throw new Error(`owned world never came up as OURS (${reason})`); }
  return { origin, key, owned: true, close };
}

/** Uniform pass/fail counting with a nonzero exit — a probe that cannot fail
 *  is a console.log, not a receipt. */
export function checker() {
  let pass = 0, fail = 0;
  const check = (name, ok, extra = '') => {
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : '  ' + extra}`);
    ok ? pass++ : fail++;
  };
  const done = () => {
    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
    process.exit(fail ? 1 : 0);
  };
  return { check, done };
}
