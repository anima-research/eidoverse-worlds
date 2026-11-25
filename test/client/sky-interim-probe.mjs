// sky-interim-probe — the world first, the sky last (owner, 09-27). After a fresh sky build: one interim gradient in
// the sky system's own time-of-day colours stands in, the big domes stay out of the scene and never enter the serial
// warm conductor, the curtain doesn't wait on the sky (save, on a live-tier boot where VR is
// supported, the cap's bake program: up to 40 s under the splash, sky.js), and the real sky replaces the gradient only once the world
// near you has settled (or 60 s have passed: sky.js worldSettled gives up there). Cloud quality OFF before load (a software cloud bake exhausts this machine); the tier still
// builds, holds and bakes. Real client.
//   bun test/client/sky-interim-probe.mjs
import { launchBrowser, ownedWorld, checker, skyBoot } from '../harness/probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({ owner: 'interim', env: { TRUST_NAMES: '1' } });   // the page owns staging, so its @world writes are admitted
const { browser, page } = await launchBrowser(); const pg = await page();
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
const lines = []; const T0 = Date.now();
pg.on('console', (m) => { const t = m.text(); if (/sky/.test(t)) lines.push(`${((Date.now() - T0) / 1000).toFixed(1)} ${t.slice(0, 900)}`); });
pg.on('request', (r) => { const b = r.postData(); if (b && /\[sky\]/.test(b)) for (const x of b.match(/\[sky\][^"\\]*/g) ?? []) lines.push(`${((Date.now() - T0) / 1000).toFixed(1)} ${x.slice(0, 900)}`); });
try {
  // a world whose log already has a cloudy sky, so boot builds it
  await skyBoot(pg, world, 'interim', { sky: { hours: 17, rate: 22.5, clouds: 'cumulus' } });
  await pg.waitForTimeout(1500);
  lines.length = 0;   // what follows is the reload's build only: the first boot's lines would answer the checks below
  await pg.reload({ waitUntil: 'domcontentloaded' });
  const t1 = Date.now();
  // sample the state until the real sky is up
  let seen = { interim: false, interimWithDomesOut: false, colours: null }; let up = false;
  for (let i = 0; i < 360 && !up; i++) {
    const st = await pg.evaluate(async () => {
      try {
        const si = await import('./lib/sky/sky_interim.js'), sb = await import('./lib/sky/sky_baked.js');
        const m = globalThis.EW?.scene?.getObjectByName?.('interim sky');
        const c = m?.geometry?.attributes?.color; const top = c ? [c.getX(0), c.getY(0), c.getZ(0)].map((v) => +v.toFixed(3)) : null;
        return { interim: si.interimSkyShown(), held: sb.liveDomesHeld(), top, booted: !document.querySelector('#splash:not(.gone)') };
      } catch (e) { return { err: String(e) }; }
    }).catch(() => null);
    if (st?.interim) { seen.interim = true; if (st.held) seen.interimWithDomesOut = true; if (st.top) seen.colours = st.top; }
    up = lines.some((l) => /the real sky is up/.test(l));
    if (!up) await pg.waitForTimeout(500);
  }
  const after = await pg.evaluate(async () => ({ interim: (await import('./lib/sky/sky_interim.js')).interimSkyShown(), held: (await import('./lib/sky/sky_baked.js')).liveDomesHeld() }));
  // a position in the log's text, not an entry's index: the page batches several [sky] lines into one console message
  const log = lines.join('\n'), order = (re) => log.search(re);
  console.log('   ', JSON.stringify({ seen, after, s: ((Date.now() - t1) / 1000).toFixed(1) }));
  console.log(lines.filter((l) => /held out|settled|real sky|build owns|compiled/.test(l)).map((l) => '      ' + l).join('\n'));
  check('a fresh build holds the domes out and shows the interim gradient', seen.interim && seen.interimWithDomesOut, JSON.stringify(seen));
  check('…painted in the sky system\'s own colours (not black, not a flat default)', !!seen.colours && seen.colours.some((v) => v > 0.02), JSON.stringify(seen.colours));
  // held AT BIRTH (the makeSkySystem wrapper), before the build's first await lets a frame draw them
  const heldAt = order(/held out from birth/), ownsAt = order(/build owns/);
  check('the domes are held at birth, before the build lets any frame run', heldAt >= 0 && heldAt < ownsAt, `held@${heldAt} owns@${ownsAt}`);
  // "world settled after N s" is logged at the 60 s cap too: N < 59.5 is a settle, not the give-up
  const settledS = Number(/world settled after ([\d.]+) ?s/.exec(log)?.[1] ?? NaN);
  check('the sky compiles only after the world settled (not the 60 s cap)', order(/world settled/) >= 0 && order(/world settled/) < order(/the real sky is up/) && settledS < 59.5, `settled after ${settledS} s`);
  const owns = lines.find((l) => /build owns/.test(l)) ?? '';
  const later = owns.match(/\w+=later/g) ?? [];
  check('exactly the two big domes (spheres) skip the warm conductor, for later', later.length === 2 && later.every((x) => /^SphereGeometry/.test(x)), owns.match(/\w+=later/g)?.join(' ') ?? owns.slice(0, 200));
  await pg.waitForTimeout(6000);   // a few more rated-sky seconds after the bake
  check('a baked tier never runs the full-quad env re-bake (the synchronous giant-program caller)', !lines.some((l) => /env re-bake/.test(l)), lines.filter((l) => /env re-bake/.test(l)).slice(0, 2).join(' | '));
  check('the real sky replaces it: gradient gone, nothing left held', up && !after.interim && !after.held, JSON.stringify(after));
  // M3: the off tier under cloudy weather never pins a cloud branch
  await pg.evaluate(async () => { const { sendRequest } = await import('./lib/net.js'); const r = await sendRequest('set', { id: '@world', component: 'sky', value: { hours: 12, rate: 0, clouds: 'cumulus', weather: 'overcast' }, merge: true }); if (!r.ok) throw new Error(`sky refused: ${JSON.stringify(r.refused)}`); });
  await pg.waitForTimeout(4000);
  const pinned = await pg.evaluate(async () => (await import('./lib/sky/sky_baked.js')).bakedCloudsPinned());
  check('off tier under overcast: the bake has no cloud branch', pinned === false, String(pinned));
  await pg.evaluate(async () => { const { sendRequest } = await import('./lib/net.js'); const r = await sendRequest('set', { id: '@world', component: 'sky', value: { hours: 12, rate: 0, clouds: 'cumulus', weather: 'clear' }, merge: true }); if (!r.ok) throw new Error(`sky refused: ${JSON.stringify(r.refused)}`); });
  await pg.waitForTimeout(3000);
  // M2: a quality flip never leaves the scene skyless during teardown + rebuild (gradient or baked dome at every sample).
  // Sampled per drawn frame through the teardown/module window (3 s), then the page leaves before low's cloud bake (a software
  // 3-pass bake exhausts this machine).
  const gaps = await pg.evaluate(async () => {
    const s = await import('./lib/sky/sky.js'), si = await import('./lib/sky/sky_interim.js'), sb = await import('./lib/sky/sky_baked.js');
    s.setCloudQuality('low');
    let gaps = 0, samples = 0, sawInterim = false; const t0 = performance.now();
    while (performance.now() - t0 < 3000) {
      await new Promise((r) => requestAnimationFrame(r)); samples++;   // per drawn frame: what a person could see
      const i = si.interimSkyShown(); if (i) sawInterim = true;
      if (!i && !sb.bakedActive()) gaps++;
    }
    return { gaps, samples, sawInterim };
  });
  await pg.goto('about:blank');
  console.log('    flip:', JSON.stringify(gaps));
  check('a quality flip never shows a skyless frame (the gradient covers the rebuild)', gaps.gaps === 0 && gaps.samples >= 2 && gaps.sawInterim, JSON.stringify(gaps));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
