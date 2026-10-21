// bun tools/overdraw-probe.mjs — EW.overdraw() counts what it claims to count.
//   calib  — two opaque planes filling the view at 2 m and 3 m: 'actual' = exactly 1 fragment per pixel (the far plane
//            fails depth), 'raw' = exactly 2. A tool that dropped the materials' depth state reads 2 in 'actual'.
//   grass  — the real Commons meadow in the live scene: in 'raw' mode the grass's covered-pixel count equals what a
//            normal render of that grass covers. A clone that lost positionNode piles every tuft at its local origin.
//   live   — a heat PNG + the by-category table for the staging view (written to the dir given in OUT).
// Usage: OUT=<dir> bun tools/overdraw-probe.mjs   (run under a memory guard: headless Chromium renders on the CPU)
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { writeFileSync } from 'node:fs';

const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();
const OUT = process.env.OUT || '/tmp';

try {
  const pg = await page();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${world.origin}/?world=staging&name=odprobe&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp && globalThis.EW?.overdraw, null, { timeout: 60000 });
  await pg.waitForTimeout(4000);
  const r = await Promise.race([pg.evaluate(async () => {
    const { THREE, scene, camera, renderer } = await import('./lib/core.js');
    const { renderAside } = await import('./lib/render.js');
    const W = 240;
    // ---- calib: two view-filling planes in front of the camera
    // a FIXED probe camera: the visitor keeps walking in while captures compile
    const pc = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
    pc.position.set(0, 1.6, 0); pc.lookAt(0, 1.2, 20); pc.updateMatrixWorld(true);
    const eye = pc.getWorldPosition(new THREE.Vector3()), fwd = pc.getWorldDirection(new THREE.Vector3());
    const cal = new THREE.Group(); cal.userData.odTag = 'calib';
    for (const d of [2, 3]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicNodeMaterial({ color: 0x808080 }));
      m.position.copy(eye).addScaledVector(fwd, d); m.lookAt(eye); cal.add(m);
    }
    scene.add(cal);
    const calA = await EW.overdraw({ mode: 'actual', w: W, camera: pc });
    const calR = await EW.overdraw({ mode: 'raw', w: W, camera: pc });
    scene.remove(cal);
    // ---- grass: the Commons meadow around the camera, in the live scene
    const F = await import('./lib/flora.js');
    const field = await F.buildFloraField({ species: 'galleta_dry', width: 80, depth: 70, density: 0.5, center: [eye.x, eye.z] }, { scene, heightFn: () => 0 });
    await F.warmField(field, renderer, pc, scene);
    // pin the meadow: no pusher (the visitor walks through it), no tile re-budget from the moving core camera
    const autos = globalThis._autoParticleSystems || [];
    for (const hk of field.autoHooks) { const i = autos.indexOf(hk); if (i >= 0) autos.splice(i, 1); }
    for (const f of field._strokes) { f.setPushers?.([]); f._applyTiles?.(); }
    const grR = await EW.overdraw({ mode: 'raw', w: W, camera: pc });
    const livePending = EW.overdraw({ mode: 'actual', w: 480, heat: true, camera: pc });
    const second = await EW.overdraw({ mode: 'raw', w: 64, camera: pc });   // started while the first still runs
    const live = await livePending;
    const liveRaw = await EW.overdraw({ mode: 'raw', w: 480, camera: pc });
    // normal-render coverage of the same grass: the group alone, alpha > 0
    const g = field.mesh, parent = g.parent, solo = new THREE.Scene();
    solo.add(g);
    const h = grR.size.split('x').map(Number)[1];
    const rt = new THREE.RenderTarget(W, h, { type: THREE.UnsignedByteType });
    const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
    renderer.setClearColor(0, 0); renderer.setRenderTarget(rt); renderer.clear(); renderer.setRenderTarget(null);
    renderAside(solo, pc, rt);
    const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, h);
    renderer.setClearColor(cc, ca); parent.add(g);
    let normalCovered = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 0) normalCovered++;
    return { calA, calR, grR: { byTag: grR.byTag }, normalCovered, second: { error: second?.error ?? null }, live, liveRaw: { total: liveRaw.total, byTag: liveRaw.byTag } };
  }), new Promise((_, rej) => setTimeout(() => rej(new Error('page pinned 150 s')), 150000))]);
  const px = r.calA.pixels;
  console.log(`  calib actual: ${JSON.stringify(r.calA.byTag?.calib)} | raw: ${JSON.stringify(r.calR.byTag?.calib)} | pixels ${px}`);
  check('calib actual: the two planes shade exactly 1 fragment per pixel', r.calA.byTag?.calib?.fragments === px && r.calA.byTag.calib.covered === px, JSON.stringify(r.calA.byTag?.calib));
  check('calib raw: exactly 2 per pixel', r.calR.byTag?.calib?.fragments === 2 * px, JSON.stringify(r.calR.byTag?.calib));
  const gc = r.grR.byTag?.grass?.covered ?? -1;
  console.log(`  grass raw covered ${gc} vs normal render ${r.normalCovered}`);
  check('grass: raw covered pixels == a normal render\'s grass coverage (instances placed, not piled at origin)', gc > 200 && Math.abs(gc - r.normalCovered) <= Math.max(3, r.normalCovered * 0.005), `${gc} vs ${r.normalCovered}`);
  const { heat, ...rest } = r.live;
  console.log('  live view:', JSON.stringify(rest));
  if (heat) writeFileSync(`${OUT}/overdraw-staging.png`, Buffer.from(heat.split(',')[1], 'base64'));
  const parts = Object.values(rest.byTag || {}).reduce((a, t) => a + t.fragments, 0);
  check('live: per-category fragments sum to the total within 0.5% (measured gap: see tool header)', Math.abs(parts - rest.total) <= rest.total * 0.005, `${parts} vs ${rest.total} (${(100 * (parts - rest.total) / rest.total).toFixed(3)}%)`);
  const partsRaw = Object.values(r.liveRaw.byTag || {}).reduce((a, t) => a + t.fragments, 0);
  console.log(`  stable actual=${rest.stable} drift=${rest.drift ?? 0}; raw: parts ${partsRaw} vs total ${r.liveRaw.total} | actual: parts ${parts} vs total ${rest.total}`);
  check('live raw: per-category fragments sum to the total within 0.5%', Math.abs(partsRaw - r.liveRaw.total) <= r.liveRaw.total * 0.005, `${partsRaw} vs ${r.liveRaw.total} (${(100 * (partsRaw - r.liveRaw.total) / r.liveRaw.total).toFixed(3)}%)`);
  check('stable: the first and last total passes agree (nothing moved mid-capture)', rest.stable === true, `drift ${rest.drift ?? 0}`);
  check('live capture has a heat map and categories', !!heat && Object.keys(rest.byTag || {}).length >= 2, Object.keys(rest.byTag || {}).join(','));
  check('a capture started while another runs answers busy (never overlaps it)', /busy/.test(r.second?.error ?? ''), JSON.stringify(r.second));
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
} catch (e) { check('probe ran to completion', false, String(e).slice(0, 300)); }
finally { await browser.close(); await world.close(); }
done();
