// mic-hud-probe — the ONE owned browser receipt for the HUD mic's claims.
//
// #131's version proved the mesh-delegation discriminator (mesh main + no SFU
// globals → HUD still drives the mesh). The #132 cutover deletes the mesh, so
// the world under test is now the SFU one: the owned child boots with
// VOICE_TRANSPORT=sfu, and what must hold is that a person's real HUD clicks
// drive the ONE remaining transport ON→OFF→ON with the visible state (glyph
// slash + tooltip, mictoggle's three-state contract) following each step —
// and, the direction the UI must never fail in, the glyph never claims
// silence while the SFU is publishing (hud-mic-truth's 2026-08-15 finding,
// folded in here as an assertion instead of a console dump).
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';

const { check, done } = checker();
const world = await ownedWorld({ live: process.argv[2] || null,
  env: { VOICE_TRANSPORT: 'sfu' } });
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
  // The SFU is the transport now — its hook must actually arrive before the
  // click, or the probe would be testing the "still connecting" hint instead.
  await pg.waitForFunction(() => typeof window.__sfuMic === 'function',
    { timeout: 20000 }).catch(() => {});
  check('precondition: the SFU hook is installed (single-transport world)',
    await pg.evaluate(() => typeof window.__sfuMic === 'function'));

  // ON — the click a person makes. Fake device satisfies getUserMedia.
  await pg.click('#mictoggle');
  await pg.waitForFunction(() =>
    !document.getElementById('mictoggle')?.innerHTML.includes('x2="25"'),
    { timeout: 15000 }).catch(() => {});
  const s1 = await state();
  check('click ON reaches the SFU: slash gone, tooltip no longer "mic off"',
    s1.slashed === false && !/mic off/i.test(s1.title ?? ''), JSON.stringify(s1));
  // hud-mic-truth, as an assertion: while the transport says publishing, the
  // glyph must not claim silence. (Publishing may legitimately lag the click
  // on a slow negotiation — the forbidden state is publishing WITH a slash.)
  check('never "publishing but slashed" — the glyph cannot claim silence while live',
    await pg.evaluate(() => !(window.relayDiag?.()?.micPublished === true
      && document.getElementById('mictoggle')?.innerHTML.includes('x2="25"'))));

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
