// bun tools/meadow-grank-probe.mjs — global-rank tiling (flora.js GR_*) keeps EXACTLY the same blades.
//
// The Commons meadow (galleta_dry, 80×70 m, density 0.5 → 1729 tufts) used to stay one untiled InstancedMesh. It now
// tiles with every tuft keeping its whole-stroke rank, and a per-tile count that is only a ceiling on the shader's own
// keep test. This builds that meadow through the REAL buildFloraField twice — ?grassgrank=0 (the old refusal) and the
// default — renders core's camera from several poses (inside at eye height, facing both ways; a corner; 30 m up looking
// down, where a 3D-distance budget would under-draw; 100 m outside) and diffs the pixels. It also counts the tufts
// submitted per pose (Σ draw counts over what the frustum keeps) — the win has to be real, not just harmless.
// Usage: bun tools/meadow-grank-probe.mjs   (run under a memory guard: headless Chromium renders on the CPU)
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';

const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();

const POSES = [
  ['center, eye height, +z', [0, 1.6, 0], [0, 1.2, 30]],
  ['center, eye height, -x', [0, 1.6, 0], [-30, 1.2, 0]],
  ['corner, looking in', [-36, 1.6, -31], [0, 0, 0]],
  ['30 m up, looking down', [5, 30, 5], [12, 0, 18]],
  ['100 m outside', [0, 4, -130], [0, 0, 0]],
];

async function renderAll(grank) {
  const pg = await page();
  const errs = [], logs = [];
  pg.on('pageerror', (e) => errs.push(String(e)));
  pg.on('console', (m) => { const t = m.text(); if (t.startsWith('[flora]')) logs.push(t); });
  await pg.goto(`${world.origin}/?world=staging&name=meadowprobe&key=${world.key}${grank ? '' : '&grassgrank=0'}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 60000 });
  await pg.waitForTimeout(3000);
  const out = await Promise.race([pg.evaluate(async (POSES) => {
    const { THREE, renderer, camera } = await import('./lib/core.js');
    const F = await import('./lib/flora.js');
    const W = 320, H = 200;
    const sc = new THREE.Scene();
    sc.background = new THREE.Color(0x223344);
    sc.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(3, 8, 2); sc.add(sun);
    const field = await F.buildFloraField({ species: 'galleta_dry', width: 80, depth: 70, density: 0.5 }, { scene: sc, heightFn: () => 0 });
    // pin everything time-varying: unhook the field's per-frame hooks, fix wind time, no pushers
    const autos = globalThis._autoParticleSystems || [];
    for (const h of field.autoHooks) { const i = autos.indexOf(h); if (i >= 0) autos.splice(i, 1); }
    for (const f of field._strokes) { f.update?.(10); f.setPushers?.([]); }
    const strokes = field._strokes.map((f) => ({ label: f.strokeLabel, count: f.count, tiled: !!f.tiled, tiles: f.tiles?.length ?? 0 }));
    const saved = { p: camera.position.clone(), q: camera.quaternion.clone(), a: camera.aspect };
    camera.aspect = W / H; camera.updateProjectionMatrix();
    // warm every program first (compile is async), THEN each pose is set → applied → rendered with no await between
    camera.position.set(0, 1.6, 0); camera.lookAt(0, 1.2, 30); camera.updateMatrixWorld(true);
    await F.warmField(field, renderer, camera, sc);
    const rt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType });
    const fr = new THREE.Frustum(), pm = new THREE.Matrix4();
    const res = [];
    for (const [, pos, at] of POSES) {
      camera.position.set(...pos); camera.lookAt(...at); camera.updateMatrixWorld(true);
      for (const f of field._strokes) f._applyTiles?.();
      pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); fr.setFromProjectionMatrix(pm);
      let submitted = 0;
      field.mesh.traverse((o) => {
        if (!o.isInstancedMesh || !o.visible) return;
        const sph = o.boundingSphere;
        if (o.frustumCulled && sph && !fr.intersectsSphere(sph)) return;
        submitted += o.count;
      });
      const prev = renderer.getRenderTarget(); renderer.setRenderTarget(rt); renderer.render(sc, camera); renderer.setRenderTarget(prev);
      res.push({ submitted, px: Array.from(await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H)) });
    }
    camera.position.copy(saved.p); camera.quaternion.copy(saved.q); camera.aspect = saved.a; camera.updateProjectionMatrix();
    return { strokes, res };
  }, POSES), new Promise((_, rej) => setTimeout(() => rej(new Error('page pinned 150 s')), 150000))]);
  await pg.close();
  return { ...out, errs, logs };
}

const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
try {
  const old = await renderAll(false), neu = await renderAll(true);
  console.log('  old strokes', JSON.stringify(old.strokes), '| new', JSON.stringify(neu.strokes));
  check('the Commons meadow builds 1729 tufts (the audit\'s number)', neu.strokes[0]?.count === 1729, `count ${neu.strokes[0]?.count}`);
  check('old build: untiled (the refusal this change targets)', old.strokes[0] && !old.strokes[0].tiled, JSON.stringify(old.strokes[0]));
  check('new build: tiled', neu.strokes[0]?.tiled && neu.strokes[0].tiles >= 4, JSON.stringify(neu.strokes[0]));
  let oldSum = 0, newSum = 0;
  POSES.forEach(([name], i) => {
    const n = diff(old.res[i].px, neu.res[i].px);
    const lit = old.res[i].px.some((v, k) => k % 4 === 1 && v !== old.res[0].px[1]);
    check(`${name}: byte-identical`, n === 0, `${n} of ${old.res[i].px.length} bytes differ; tufts submitted ${old.res[i].submitted} → ${neu.res[i].submitted}`);
    console.log(`    ${name}: tufts submitted ${old.res[i].submitted} → ${neu.res[i].submitted}`);
    oldSum += old.res[i].submitted; newSum += neu.res[i].submitted;
    void lit;
  });
  const grassShows = diff(old.res[0].px, old.res[4].px) > 1000;
  check('the meadow is really in frame (inside vs 100 m out differ)', grassShows, 'renders differ by pose');
  console.log(`    total ${oldSum} → ${newSum}`);
  check('fewer tufts submitted overall', newSum < oldSum, `${oldSum} → ${newSum} (${(100 * (1 - newSum / oldSum)).toFixed(0)}% fewer; ×272 tris each)`);
  check('no page errors', old.errs.length + neu.errs.length === 0, [...old.errs, ...neu.errs].slice(0, 2).join(' | ') || 'none');
} catch (e) { check('probe ran to completion', false, String(e).slice(0, 300)); }
finally { await browser.close(); await world.close(); }
done();
