// No edit mode on a phone (R, 10-06 23:39: "I would just not make edit mode available on phone honestly"). An owner on
// a phone-sized touch screen can't enter builder mode (B or the dock); the same owner on a desktop can (the control,
// so a phone pass isn't vacuous). Run: perf-guard.sh -t 300 -- bun tools/protocol/phone-edit-probe.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchBrowser, ownedWorld } from '../probe-harness.mjs';
import { foundWorld } from '../../server/worldlog.ts';

const KEY = 'phoneprobe';
const worlds = mkdtempSync(join(tmpdir(), 'phone-probe-'));
let failed = 0; const check = (n, v, d) => { if (!v) failed++; console.log(`${v ? 'ok  ' : 'FAIL'} ${n}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 300)}` : ''}`); };
let world = null, browser = null;
try {
  foundWorld(join(worlds, 'garden'), 'garden', 'Ann', 'a phone test garden');
  world = await ownedWorld({ key: KEY, env: { WORLDS_DIR: worlds, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', TRUST_NAMES: '1' } });
  ({ browser } = await launchBrowser());
  for (const [name, opts] of [['desktop', { viewport: { width: 1280, height: 800 } }], ['phone', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }]]) {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });   // never the real sky headless
    const pg = await ctx.newPage(); const errors = []; pg.on('pageerror', (e) => errors.push(String(e)));
    let ready = false; pg.on('console', (m) => { if (m.text().startsWith('[boot] ready')) ready = true; });
    await pg.goto(`${world.origin}/?world=garden&name=Ann&key=${KEY}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 240 && !ready; i++) await pg.waitForTimeout(500);
    for (let i = 0; i < 40; i++) { if (await pg.evaluate(() => globalThis.EW?.net?.myRights?.role)) break; await pg.waitForTimeout(250); }
    const role = await pg.evaluate(() => globalThis.EW?.net?.myRights?.role);
    await pg.keyboard.press('KeyB'); await pg.waitForTimeout(600);
    const editing = await pg.evaluate(() => document.body.classList.contains('edit-mode'));
    const coarse = await pg.evaluate(() => matchMedia('(pointer: coarse)').matches);
    check(`${name}: booted as the owner`, ready && role === 'owner', { ready, role, errors: errors.slice(0, 2) });
    const wrench = await pg.evaluate(() => { const b = document.querySelector('[data-toggles="edit"]'); return b ? { disabled: b.disabled, title: b.title || b.getAttribute('aria-label') } : null; });
    if (name === 'desktop') check('desktop: the dock wrench is live', wrench && !wrench.disabled, wrench);
    else check('phone: the dock wrench is grey, and says why (not "needs build rights")', wrench?.disabled && !/build rights/.test(wrench.title ?? ''), wrench);
    if (name === 'desktop') check('desktop: B enters builder mode (the control)', editing === true, { editing, coarse });
    else check('phone: B does NOT enter builder mode', editing === false, { editing, coarse });
    await ctx.close();
  }
} catch (e) { failed++; console.log('FAIL probe crashed —', String(e?.stack ?? e).slice(0, 400)); }
finally { try { await browser?.close(); } catch {} try { await world?.close?.(); } catch {} rmSync(worlds, { recursive: true, force: true }); }
console.log(`[phone-edit-probe] ${failed ? failed + ' failed' : 'all pass'}`); process.exit(failed ? 1 : 0);
