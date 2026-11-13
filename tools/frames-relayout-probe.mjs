// frames-relayout-probe — in a REAL browser: a window shrink is not a decision.
//
//   bun tools/frames-relayout-probe.mjs            (owned child world, like boot-check)
//
// Opens world/settings/debug, drags debug somewhere of its own (a deliberate placement),
// squeezes the window until panels collide, toggles a panel while squeezed, grows the
// window back and reloads. Every panel must come back to its rect: defaults to their
// layout, the dragged one to where it was dropped. frames-layout-test binds the same
// contract under happy-dom; this is the check that the real caller agrees.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';

const KEY = process.env.JOIN_KEY || 'dev';
const FULL = { width: 1280, height: 800 };
const { check, done } = checker();
let world, close = async () => {};
try {
  world = await ownedWorld({ key: KEY, env: { SKIP_OPT_SWEEP: '1' } });
  let page; ({ page, close } = await launchBrowser());
  const pg = await page();
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.setViewportSize(FULL);
  const boot = async () => {
    await pg.goto(`${world.origin}/?world=staging&name=relayout&key=${KEY}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pg.waitForFunction(() => { const sp = document.getElementById('splash');
      return (!sp || sp.classList.contains('gone')) && document.querySelectorAll('#dock button[data-toggles]').length > 0; },
      null, { timeout: 60000 });
    await pg.waitForTimeout(800);
  };
  const rects = () => pg.evaluate(() => Object.fromEntries([...document.querySelectorAll('.frame[data-frame]')]
    .filter((e) => getComputedStyle(e).display !== 'none')
    .map((e) => { const r = e.getBoundingClientRect();
      return [e.dataset.frame, [r.x, r.y, r.width, r.height].map(Math.round).join(',')]; })));
  const toggle = (id) => pg.evaluate((id) => document.querySelector(`#dock button[data-toggles="${id}"]`)?.click(), id);
  const settle = () => pg.waitForTimeout(500);
  const diff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} -> ${b[k]}`);

  await boot();
  const open0 = await rects();
  for (const id of ['world', 'settings', 'debug']) if (!open0[id]) await toggle(id);
  await settle();
  // the capability card sits top-centre over everything until dismissed (capnotice.js), and a headless
  // Chromium is exactly the reduced browser it appears for: the drag below landed on the card, not debug
  for (const b of await pg.locator('.capnotice .cn-ok').all()) await b.click().catch(() => {});
  await settle();
  // a deliberate placement: alt-drag debug by its body to a spot of its own
  let r = await rects();
  const [dx, dy] = r.debug.split(',').map(Number);
  await pg.keyboard.down('Alt');
  await pg.mouse.move(dx + 60, dy + 60); await pg.mouse.down();
  await pg.mouse.move(dx - 250, dy + 180, { steps: 8 }); await pg.mouse.up();
  await pg.keyboard.up('Alt');
  await settle();
  const before = await rects();
  console.log('layout at 1280x800:', JSON.stringify(before));
  check(`debug was really dragged (${r.debug} -> ${before.debug})`, before.debug !== r.debug);

  for (const vp of [{ width: 1280, height: 300 }, { width: 480, height: 800 }]) {
    await pg.setViewportSize(vp); await settle();
    const squeezed = await rects();
    check(`${vp.width}x${vp.height} really squeezes: ${diff(before, squeezed).join(' · ') || 'nothing moved'}`, diff(before, squeezed).length > 0);
    // an ordinary toggle while small, on a panel that is OPEN while squeezed (settings is auto-hidden
    // here, so clicking it would be a deliberate open-then-close, which rightly stays closed)
    await toggle('debug'); await settle(); await toggle('debug'); await settle();
    await pg.setViewportSize(FULL); await settle();
    const d = diff(before, await rects());
    check(`back to 1280x800 after ${vp.width}x${vp.height}: ${d.length ? d.join(' · ') : 'every panel where it was'}`, d.length === 0);
  }
  await pg.setViewportSize({ width: 1280, height: 300 }); await settle();
  await toggle('debug'); await settle(); await toggle('debug'); await settle();
  // settle BEFORE reloading: a reload that races the grow's resize event measures the
  // race (auto-hidden panels restore on that event), not the layout
  await pg.setViewportSize(FULL); await settle(); await boot();
  const d = diff(before, await rects());
  check(`a reload after a squeezed toggle: ${d.length ? d.join(' · ') : 'every panel where it was'}`, d.length === 0);
  check(`no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`, errs.length === 0);
} catch (e) { check('probe ran', false, e.message); }
finally { await close(); await world?.close?.(); }
done();
