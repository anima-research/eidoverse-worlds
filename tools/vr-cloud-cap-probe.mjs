// bun tools/vr-cloud-cap-probe.mjs — in a headset on WEBGL, clouds never run 'high' (sky.js VR CAP; a headset test, 09-24: high in
// VR = 12 fps + a different sky per eye). Drives the real xr:state bus event on a WebGL page (headless can't present):
// high → enter: medium, saved choice still high → exit: high. Asking for high INSIDE: held at medium, high on exit. A
// deliberate medium inside: stays medium after exit. On WebGPU the cap is deliberately off (⚑ in the code) — not
// asserted here (headless is WebGL).
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();
try {
  const pg = await page();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${world.origin}/?world=staging&name=vrcap&key=${world.key}&webgl=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 90000 });
  const r = await pg.evaluate(async () => {
    const S = await import('./lib/sky.js'); const { bus } = await import('./lib/base.js'); const { backendName } = await import('./lib/core.js');
    const q = () => ({ q: S.getCloudQuality(), choice: S.getCloudChoice(), saved: localStorage.getItem('ew-cloud-quality') });
    const tick = () => new Promise((res) => setTimeout(res, 50));
    const out = { backend: backendName() };
    await S.setCloudQuality('high'); out.start = q();
    bus.emit('xr:state', true); await tick(); out.inVR = q();
    bus.emit('xr:state', false); await tick(); out.afterExit = q();
    await S.setCloudQuality('medium'); bus.emit('xr:state', true); await tick();
    await S.setCloudQuality('high'); out.askHighInVR = q();
    bus.emit('xr:state', false); await tick(); out.afterExit2 = q();
    bus.emit('xr:state', true); await tick(); await S.setCloudQuality('medium'); out.chooseMediumInVR = q();
    bus.emit('xr:state', false); await tick(); out.afterExit3 = q();
    return out;
  });
  console.log('   ', JSON.stringify(r));
  check('the page is on WebGL (the cap applies)', r.backend === 'webgl', r.backend);
  check('high → entering VR runs medium; the saved choice stays high', r.inVR.q === 'medium' && r.inVR.saved === 'high', r.inVR);
  check('while capped, the settings row reads the CHOICE (high), not the running level', r.inVR.choice === 'high', r.inVR);
  check('…and exiting brings high back', r.afterExit.q === 'high', r.afterExit);
  check('asking for high INSIDE VR holds medium (saved high)', r.askHighInVR.q === 'medium' && r.askHighInVR.saved === 'high', r.askHighInVR);
  check('…high on exit', r.afterExit2.q === 'high', r.afterExit2);
  check('a deliberate medium inside VR stays medium after exit', r.chooseMediumInVR.q === 'medium' && r.afterExit3.q === 'medium' && r.afterExit3.saved === 'medium', [r.chooseMediumInVR, r.afterExit3]);
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
} catch (e) { check('probe ran', false, String(e).slice(0, 300)); }
finally { await browser.close(); await world.close(); }
done();
