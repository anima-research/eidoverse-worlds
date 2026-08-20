// mic-hud-probe — the ONE owned browser receipt for this branch's mic claims,
// consolidating the SFU-era field probes (#131 review, item 3).
//
// What it proves, in a real browser against a child server this run OWNS:
// the review's standalone discriminator — current main + this PR, with NO SFU
// globals, can turn the existing mesh mic ON→OFF→ON **through the real HUD
// button**, and the visible state (glyph slash + tooltip, mictoggle's own
// three-state contract) follows each step. On the pre-delegation head this
// fails at the first click: toggleMic checked only window.__sfuMic and
// flashed "still connecting" forever.
//
// The six field-debug probes this replaces were written against the ambient
// SFU staging world (:8960) and asserted nothing (console dumps, exit 0
// always) — the review's exact objection. Their SFU-specific claims are only
// testable where an SFU exists, so those instruments ride with the SFU-stack
// PRs; this branch ships receipts for what THIS branch claims.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';

const { check, done } = checker();
const world = await ownedWorld({ live: process.argv[2] || null });
const { page, close } = await launchBrowser({ mic: true });
try {
  const pg = await page();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));   // decline the STT consent ask
  await pg.goto(`${world.origin}/?world=probe&key=${world.key}&name=micprobe`,
    { waitUntil: 'domcontentloaded' });
  await pg.fill('#d-name', 'micprobe').catch(() => {});
  await pg.click('#d-go').catch(() => {});
  await pg.waitForSelector('#mictoggle', { timeout: 30000 });

  const state = () => pg.evaluate(() => {
    const el = document.getElementById('mictoggle');
    return { title: el?.title ?? null, slashed: el?.innerHTML.includes('x2="25"') ?? null };
  });

  const s0 = await state();
  check('HUD renders the mic button, OFF by default (grey + slash)',
    s0.slashed === true && /mic off/i.test(s0.title ?? ''), JSON.stringify(s0));
  check('precondition: no SFU hook installed (this is the standalone world)',
    await pg.evaluate(() => typeof window.__sfuMic !== 'function'));

  // ON — the click a person makes. Fake device satisfies getUserMedia.
  await pg.click('#mictoggle');
  await pg.waitForFunction(() =>
    !document.getElementById('mictoggle')?.innerHTML.includes('x2="25"'),
    { timeout: 15000 }).catch(() => {});
  const s1 = await state();
  check('click ON reaches the mesh: slash gone, tooltip no longer "mic off"',
    s1.slashed === false && !/mic off/i.test(s1.title ?? ''), JSON.stringify(s1));

  // OFF
  await pg.click('#mictoggle');
  await pg.waitForFunction(() =>
    document.getElementById('mictoggle')?.innerHTML.includes('x2="25"'),
    { timeout: 15000 }).catch(() => {});
  const s2 = await state();
  check('click OFF follows: slash back, off tooltip back',
    s2.slashed === true && /mic off/i.test(s2.title ?? ''), JSON.stringify(s2));

  // ON again — completes the review's ON→OFF→ON discriminator.
  await pg.click('#mictoggle');
  await pg.waitForFunction(() =>
    !document.getElementById('mictoggle')?.innerHTML.includes('x2="25"'),
    { timeout: 15000 }).catch(() => {});
  const s3 = await state();
  check('click ON again completes ON→OFF→ON with visible state following',
    s3.slashed === false, JSON.stringify(s3));

  check('no page errors across the whole cycle', errs.length === 0, errs.slice(0, 3).join(' | '));
} finally {
  await close();
  await world.close();
}
done();
