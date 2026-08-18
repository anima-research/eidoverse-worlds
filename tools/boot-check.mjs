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
import { launchBrowser, ownedWorld } from './probe-harness.mjs';

const LIVE = process.argv[2];                 // explicit live-deployment mode
const KEY = process.env.JOIN_KEY || 'dev';
// Child ownership (nonce identity, scratch state, verified readiness) now
// lives in probe-harness.ownedWorld — this file is where the pattern was
// born, and the harness is it, extracted for the six probes that lacked it.
let world;
try { world = await ownedWorld({ live: LIVE || null, key: KEY }); }
catch (e) { console.log(`FAIL — ${e.message}`); process.exit(1); }
const ORIGIN = world.origin;

const { page, close } = await launchBrowser();
try {
  const pg = await page();
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  await pg.goto(`${ORIGIN}/?world=staging&name=bootcheck&key=${KEY}`, { waitUntil: 'networkidle' });
  await new Promise(r => setTimeout(r, 3000));
  const n = await pg.evaluate(() => document.querySelectorAll('.sec').length);
  if (errs.length) { console.log('FAIL — page errors:\n  ' + errs.slice(0, 4).join('\n  ')); process.exit(1); }
  if (!n) { console.log('FAIL — zero .sec panels rendered (boot died silently)'); process.exit(1); }
  console.log(`ok — client boots, ${n} panels rendered, no page errors${LIVE ? ' (live deployment)' : ' (owned child)'}`);
} finally {
  await close();
  await world.close();
}
