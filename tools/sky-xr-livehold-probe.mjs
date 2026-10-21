// sky-xr-livehold-probe — in a headset the live cloud march (per-eye noise; ~13 fps on the owner's rig while a first
// compile runs, 09-27) is held out of the scene until the baked dome attaches; release puts every dome back exactly
// once, so the baked dome's park and the sky's teardown still find them. Fake domes (no real sky headless).
//   bun tools/sky-xr-livehold-probe.mjs
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
try {
  await pg.goto(`${world.origin}/?world=staging&name=liveholdprobe&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 90000 });
  const r = await pg.evaluate(async () => {
    const sb = await import('./lib/sky_baked.js'); const THREE = await import('three');
    const parent = new THREE.Group(); globalThis.EW.scene.add(parent);
    const domes = [new THREE.Mesh(), new THREE.Mesh()]; for (const d of domes) parent.add(d);
    const api = { _internals: { sky: { domes } } };
    const out = {};
    out.held = sb.holdLiveDomesInXR(api);
    out.outOfScene = domes.every((d) => !d.parent);
    out.flag = sb.liveDomesHeld();
    out.again = sb.holdLiveDomesInXR(api);            // idempotent
    sb.releaseLiveDomes();
    out.back = domes.every((d) => d.parent === parent);
    out.flagAfter = sb.liveDomesHeld();
    sb.releaseLiveDomes();                              // a second release adds nothing twice
    out.childCount = parent.children.length;
    // teardown while held: detachBakedDome puts them back so the disposal pass can find them
    sb.holdLiveDomesInXR(api); sb.detachBakedDome();
    out.backAfterTeardown = domes.every((d) => d.parent === parent);
    // a baked tier whose dome fails to attach: whoever handles that calls release, and the live sky comes back
    sb.holdLiveDomesInXR(api); sb.releaseLiveDomes(); out.backAfterFailedAttach = domes.every((d) => d.parent === parent);
    parent.removeFromParent();
    return out;
  });
  console.log('  ·', JSON.stringify(r));
  check('in a headset the live domes are held out of the scene', r.held === true && r.outOfScene && r.flag, JSON.stringify(r));
  check('holding twice is a no-op', r.again === false);
  check('release puts every dome back, under its own parent', r.back && !r.flagAfter);
  check('…exactly once (a second release adds nothing)', r.childCount === 2, r.childCount);
  check('a teardown while held restores them (the disposal pass must find them)', r.backAfterTeardown);
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
