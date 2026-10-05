// garden-look-probe — open R's v4 garden (a running server, GARDEN_ORIGIN) as a person would, after slice 3c: the page
// must draw from its own v4 fold (state.st = viewState(fold)), with every thing in the scene. Screenshot to SHOT.
import { launchBrowser, checker } from './probe-harness.mjs';
const ORIGIN = process.env.GARDEN_ORIGIN ?? 'http://127.0.0.1:8985';
const WORLD = process.env.WORLD ?? 'garden';
const { browser, page } = await launchBrowser();
const { check, done } = checker();
try {
  const pg = await page();
  await pg.goto(`${ORIGIN}/?world=${WORLD}&name=lookprobe`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => import('/lib/net.js').then((m) => m.v4?.active && m.net?.joined), null, { timeout: 60000 });
  // the splash leaves when the world is drawn (or after its own patience); then give the scene a moment to settle
  await pg.waitForFunction(() => { const sp = document.getElementById('splash'); return !sp || sp.hidden || getComputedStyle(sp).display === 'none' || getComputedStyle(sp).opacity === '0'; }, null, { timeout: 150000 }).catch(() => console.log('   (splash still up after 150 s)'));
  await pg.waitForTimeout(4000);
  const r = await pg.evaluate(async () => {
    const [n, s, rec, vd, w] = await Promise.all([import('/lib/net.js'), import('/lib/state.js'), import('/shared/v4/record.js'), import('/shared/v4/viewdiff.js'), import('/lib/world.js')]);
    const d = vd.diffView(s.state.st, rec.viewState(n.v4.st));
    const ids = Object.keys(s.state.st.entities);
    return { head: n.v4.head, things: ids.length, inScene: ids.filter((id) => w.entities.has(id)).length, diff: d.things.length + d.world.length, logs: n.v4.stats };
  });
  console.log('  ', JSON.stringify(r));
  check('the page holds exactly the view of its own v4 fold', r.things > 0 && r.diff === 0, JSON.stringify(r));
  check('every thing in the fold is in the scene', r.inScene === r.things, JSON.stringify(r));
  if (process.env.SHOT) await pg.screenshot({ path: process.env.SHOT });
} finally { await browser.close(); }
done();
