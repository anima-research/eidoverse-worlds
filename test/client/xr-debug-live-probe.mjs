// xr-debug-live-probe — the Debug pane opened in VR keeps its numbers live (owner, 09-27 20:42: 'the perf numbers are
// locked and never change'). Real client + IWER: opens the debug quad from the ring and reads its frame-timing text
// twice, a few seconds apart.
//   bun test/client/xr-debug-live-probe.mjs
import { launchBrowser, ownedWorld, checker, iwerInit, visorShown, enterVR, drawn } from '../harness/probe-harness.mjs';
import { pause, until } from '../gate/wait.ts';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
await iwerInit(pg, { cloud: 'off' });
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
try {
  await pg.goto(`${world.origin}/?world=staging&name=dbglive&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await visorShown(pg);
  await enterVR(pg);
  await drawn(pg, 60);
  const open = await pg.evaluate(async () => {
    const dq = await import('./lib/xr/domquad.js'), xp = await import('./lib/xr/xrpanels.js');
    dq.domQuadShow('debug', true); for (let i = 0; i < 300 && !xp.xrPanelOpen('debug'); i++) await new Promise((r) => requestAnimationFrame(r));
    return { open: xp.xrPanelOpen('debug'), ids: dq.domQuadIds() };
  });
  const read = () => pg.evaluate(async () => { const t = (await import('./lib/xr/domquad.js')).domQuadTexture('debug'); return t?.dom?.querySelector('pre.dbg-stats')?.textContent ?? null; });
  // debug.js fills the frame block on its first 200 ms stats tick after the quad opens: on a fast host the read can land
  // before it (a = '' on Cyllene's GPU). The first reading is the first text; the check is that it then changes
  const a = await until('the debug pane prints its frame timing', async () => (await read()) || null, { ms: 30_000 }).catch(() => null);
  await pause('4 s of live frame timing', 4000); const b = await read();
  console.log('   ', JSON.stringify({ open, a: a?.slice(0, 80), b: b?.slice(0, 80) }));
  check('the debug pane is open in VR', open.open === true, JSON.stringify(open));
  check('its frame-timing numbers change over 4 s (live, not frozen)', !!a && !!b && a !== b, JSON.stringify({ a: a?.slice(0, 60), b: b?.slice(0, 60) }));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
