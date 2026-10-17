// bun tools/rain-splash-probe.mjs — rain splashes stand on the ground, not on y=0.
//
// The weather system rang every splash out on one flat plane (eidoverse-video weather_system.js, "flat-ground v1"):
// over terrain the rings hid inside hills and hung in the air over valleys and ponds. sky.js now hands makeSky the
// surface rain lands on (terrain.js rainSurfaceAt: terrain, or water over it, null past the edge) and terrain/water
// changes re-bake it ('ground-changed' → invalidateGround). This measures it ON THE GPU: the splash mesh's REAL vertex
// graph is drawn top-down into a float target whose colour is each fragment's world position, and every y is compared
// with rainSurfaceAt(x, z) on the CPU.
//   1  splashes on the terrain (heightfield): |y − (surface + lift)| p95 < 3 cm
//   2  the old flat plane, same instrument: far off (the bug is visible to this probe — it is not blind)
//   3  the terrain reshaped live: re-baked, and the splashes stand on the NEW surface
//   4  near the terrain's edge: the window bakes "no ground" past it, the rest still lands
// Needs a library whose weather_system has groundHeightAt (EIDOVERSE_DIR); an older one fails check 1 by name.
// Runs a GPU-backed headless Chromium (WebGPU where the machine has it): rain on the CPU rasteriser is very heavy.
import { chromium } from 'playwright';
import { ownedWorld, checker } from './probe-harness.mjs';

const { check, done } = checker();
const world = await ownedWorld({});
const browser = await chromium.launch({
  ...(process.env.SFU_TEST_CHROME ? { executablePath: process.env.SFU_TEST_CHROME } : {}),
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist',
    ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])],
});
const TERRAIN = { size: 140, segments: 200, amplitude: 3, seed: 4,
  features: [{ type: 'hill', x: 0, z: -14, radius: 10, height: 7 }, { type: 'hill', x: 16, z: 6, radius: 9, height: -6 }],
  water: { level: -2.5 } };
try {
  const pg = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e)));
  pg.on('console', (m) => { if (/groundHeightAt threw/.test(m.text())) errs.push(m.text()); });
  await pg.goto(`${world.origin}/?world=rainprobe&name=rainprobe&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp && document.getElementById('splash')?.classList.contains('gone'), null, { timeout: 180000 });
  const backend = await pg.evaluate(async () => {
    const sky = await import('./lib/sky.js');
    // the weather system is registered under lightrig's scene PROXY — reach it through the sky's own handle
    globalThis.__wx = () => sky.skyForProbe().api?._internals?.wx ?? null;
    return globalThis.EW.renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  });
  console.log(`  (backend: ${backend})`);
  await pg.evaluate((T) => globalThis.EW.sendVerb('terrain', T), TERRAIN);
  await pg.waitForFunction(async () => (await import('./lib/terrain.js')).hasTerrain(), null, { timeout: 60000, polling: 500 });
  await pg.evaluate(() => globalThis.EW.sendVerb('sky', { hours: 13, rate: 0, clouds: 'cumulus', weather: 'storm' }));
  await pg.waitForFunction(() => globalThis.__wx()?.diagnostics.precipitation.rainVisible, null, { timeout: 240000, polling: 1000 });
  await pg.evaluate(() => { globalThis.EW.myState.pos.set(6, 0, -2); });   // between the hill and the pond
  await pg.waitForTimeout(2500);

  const measure = () => pg.evaluate(async () => {
    const { THREE, renderer } = globalThis.EW;
    const G = globalThis.THREE;
    const T = await import('./lib/terrain.js');
    const wx = globalThis.__wx();
    const splash = wx.pipelineWarmupObjects()[1];
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    mat.positionNode = splash.material.positionNode;   // the real graph: hash tiling + the ground sample
    const OFF = 1000;                                   // colour outputs clamp negatives: carry position shifted positive
    mat.colorNode = G.vec4(G.positionWorld.add(OFF), 1);
    const dbg = new THREE.InstancedMesh(splash.geometry, mat, splash.count);
    dbg.frustumCulled = false;
    const sc = new THREE.Scene(); sc.add(dbg);
    const c = wx.uniforms.camPos.value, R = 46, W = 1024;
    const cam = new THREE.OrthographicCamera(-R, R, R, -R, 0.1, 2000);
    cam.position.set(c.x, c.y + 500, c.z); cam.up.set(0, 0, -1); cam.lookAt(c.x, c.y, c.z); cam.updateMatrixWorld(true);
    const rt = new THREE.RenderTarget(W, W, { type: THREE.FloatType });
    await renderer.compileAsync(sc, cam);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(sc, cam); renderer.setRenderTarget(prev);
    const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, W);
    rt.dispose(); mat.dispose();
    const g = wx.diagnostics.ground ?? { mode: 'unsupported' };   // a library from before groundHeightAt
    const lift = g.mode === 'heightfield' ? 0.03 : 0.015;
    const errs = [];
    for (let k = 0; k < px.length; k += 4) {
      if (px[k + 3] < 0.5) continue;
      const s = T.rainSurfaceAt(px[k] - OFF, px[k + 2] - OFF);
      if (s !== null) errs.push(Math.abs(px[k + 1] - OFF - (s + lift)));
    }
    errs.sort((a, b) => a - b);
    const q = (p) => errs[Math.min(errs.length - 1, Math.floor(errs.length * p))];
    return { mode: g.mode, bakes: g.bakes, lastBakeMs: g.lastBakeMs, absent: g.absentSamples, n: errs.length, p50: q(0.5), p95: q(0.95), p99: q(0.99) };
  });
  const fmt = (m) => `${m.n} px, |y − surface| p50 ${m.p50?.toFixed(4)} p95 ${m.p95?.toFixed(4)} p99 ${m.p99?.toFixed(4)} m`;

  const a = await measure();
  check('1 the host names the ground (weather is in heightfield mode)', a.mode === 'heightfield',
    a.mode === 'heightfield' ? a.mode : `${a.mode} — is EIDOVERSE_DIR a library whose weather_system has groundHeightAt?`);
  check('1 enough splash fragments to judge', a.n > 2000, `${a.n}`);
  check('1 splashes stand on the terrain: p95 within 3 cm', a.p95 < 0.03, `${fmt(a)} · bake ${a.lastBakeMs?.toFixed(2)} ms`);
  if (a.mode === 'unsupported') throw new Error('the library has no splash ground (groundHeightAt) — checks 2-4 need it');

  await pg.evaluate(() => globalThis.__wx().setGroundHeightAt(null));
  await pg.waitForTimeout(300);
  const b = await measure();
  check('2 the old flat plane is far off the same terrain (this probe sees the bug)', b.mode === 'flat' && b.p95 > 0.5 && b.p95 > 50 * a.p95, fmt(b));
  await pg.evaluate(async () => globalThis.__wx().setGroundHeightAt((await import('./lib/terrain.js')).rainSurfaceAt));
  await pg.waitForTimeout(300);

  const bakes0 = (await measure()).bakes;
  await pg.evaluate((T) => globalThis.EW.sendVerb('terrain', { ...T, features: [{ type: 'hill', x: 4, z: -6, radius: 12, height: 11 }, T.features[1]] }), TERRAIN);
  await pg.waitForFunction((b0) => globalThis.__wx().diagnostics.ground.bakes > b0, bakes0, { timeout: 60000, polling: 250 });
  await pg.waitForTimeout(1500);
  const c = await measure();
  check('3 a reshaped terrain re-bakes the splash ground', c.bakes > bakes0, `bakes ${bakes0} → ${c.bakes}`);
  check('3 …and the splashes stand on the NEW surface: p95 within 3 cm', c.p95 < 0.03, fmt(c));

  await pg.evaluate(() => { globalThis.EW.myState.pos.set(55, 0, 10); });   // 15 m from the edge
  await pg.waitForTimeout(2500);
  const d = await measure();
  check('4 past the terrain edge the window bakes "no ground"', d.absent > 0, `${d.absent} absent samples`);
  check('4 the splashes still on the terrain stand on it: p95 within 3 cm', d.p95 < 0.03, fmt(d));

  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
} catch (e) {
  check('probe ran to completion', false, String(e).slice(0, 300));
} finally {
  await browser.close();
  await world.close();
}
done();
