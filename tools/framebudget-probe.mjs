// framebudget-probe — the shared per-frame budget is live in the real client: the render loop ticks it, boot loading
// runs through it, the governor sets its share, and in an XR session warms still run and the share is capped for a
// headset. Real client + IWER. (Window rAF being parked in a session is not a case here: xr_frame_clock.js routes it
// to the session's clock on a real runtime, and IWER drives its session ON window rAF.) Empty world (no sky).
//   bun tools/framebudget-probe.mjs   (with SKIP_OPT_SWEEP=1 its server starts no asset-optimizer jobs)
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync } from 'node:fs';
const { check, done } = checker();
const IWER_RAW = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
const IWER = `globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` + IWER_RAW.replace(LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
await pg.addInitScript(IWER);
await pg.addInitScript(() => { const { XRDevice, metaQuest3 } = window.IWER ?? {}; const d = new XRDevice(metaQuest3); d.installRuntime({ forceInstall: true });
  window.__iwerDevice = d; try { delete window.IWER; } catch { window.IWER = undefined; } });
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
const logs = []; pg.on('console', (m) => logs.push(m.text()));
try {
  await pg.goto(`${world.origin}/?world=staging&name=fbprobe&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 90000 });
  // headless draws on the CPU: a few fps, and boot takes a while — wait for it rather than assume desktop speed
  await pg.waitForFunction(() => !!globalThis.__bootMarks, null, { timeout: 120000, polling: 500 });   // loadwork's 'booted' mirror — present on both sides of an A/B
  await pg.waitForTimeout(2500);

  // desktop: the loop drives the budget
  const d = await pg.evaluate(async () => {
    const fb = await import('./lib/framebudget.js');
    const same = globalThis.EW?.budget === fb.budgetStats;
    const a = fb.budgetStats(); await new Promise((r) => setTimeout(r, 1000)); const b = fb.budgetStats();
    return { same, a, b };
  });
  console.log('  · desktop', JSON.stringify({ same: d.same, b: d.b }));
  check('the probe reads the LIVE framebudget (EW.budget is the same function)', d.same === true);
  check('the render loop ticks the budget (frames advance)', d.b.frameNo - d.a.frameNo >= 2, `${d.a.frameNo}→${d.b.frameNo}`);
  check('booted: the splash boost is over', d.b.booted === true);
  check('the governor set a share it knows (0.36 / 0.3 / 0.2)', [0.36, 0.3, 0.2].includes(d.b.share), String(d.b.share));
  check('boot loading ran through the budget (warm or load lanes granted)', (d.b.lanes.warm?.grants ?? 0) + (d.b.lanes.load?.grants ?? 0) > 0, JSON.stringify(d.b.lanes));

  // XR
  await pg.evaluate(() => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 30000, polling: 250 });
  await pg.waitForTimeout(1000);
  const x = await pg.evaluate(async () => {
    const fb = await import('./lib/framebudget.js');
    const wq = await import('./lib/warmqueue.js');
    const a = fb.budgetStats();
    let ran = false;
    const t0 = performance.now();
    const w = wq.warm('fbprobe: a warm enqueued inside the session', async () => { ran = true; });
    const settled = await Promise.race([w.then(() => performance.now() - t0), new Promise((r) => setTimeout(() => r(null), 3000))]);
    // a second one: the pump's between-items yield must not stall either
    const w2 = wq.warm('fbprobe: second', async () => {});
    const settled2 = await Promise.race([w2.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
    await new Promise((r) => setTimeout(r, 3000));        // headless sessions run a couple of fps: give it frames to count
    const b = fb.budgetStats();
    return { ran, settled, settled2, a, b, presenting: globalThis.EW.renderer.xr.isPresenting };
  });
  console.log('  · xr', JSON.stringify({ ran: x.ran, settled: x.settled, settled2: x.settled2, frames: x.b.frameNo - x.a.frameNo, b: x.b }));
  check('in the session the loop ticks the budget', x.presenting && x.b.frameNo - x.a.frameNo >= 2, `${x.a.frameNo}→${x.b.frameNo}`);
  check('a warm enqueued in the session runs', x.ran && x.settled != null, JSON.stringify({ ran: x.ran, settled: x.settled }));
  check('…and the next one after it', x.settled2 === true);
  check('the share is capped for a headset (≤ 0.25) once the governor pulses', x.b.share <= 0.25, String(x.b.share));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
