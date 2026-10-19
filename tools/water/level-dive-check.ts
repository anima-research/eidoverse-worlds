// Diving in the world's water LEVEL (lakes, rivers, the sea), as a player in a real browser.
//   WATER_PREVIEW_URL=http://127.0.0.1:<port>/?world=<fresh>&name=diver bun tools/water/level-dive-check.ts
// A terrain with a deep lake is built (the ground from this repo's height law, or ENGINE_LIB=<dir> for upstream's
// real modules); the body is put afloat in the lake; holding C dives it under (the 3D swim takes over from the float),
// and letting go brings it back up to the surface, where the float takes it again.
import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
const base = process.env.WATER_PREVIEW_URL ?? 'http://127.0.0.1:19347/?world=level-dive&name=diver';
const engine = process.env.ENGINE_LIB;
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(String(e)));
  if (engine) await page.route('**/library/eidoverse/*.js', (route) => {
    const f = `${engine}/${new URL(route.request().url()).pathname.split('/').pop()}`;
    return existsSync(f) ? route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(f, 'utf8') }) : route.continue();
  });
  else await page.route('**/library/eidoverse/terrain.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '// stand-in' }));
  await page.goto(base);
  await page.waitForFunction(() => !!globalThis.__waterDebug);
  const r = await page.evaluate(async (realEngine: boolean) => {
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
    const { THREE } = await import('/lib/core.js'), tm = await import('/shared/terrainmath.js');
    if (!realEngine) (globalThis as any).makeTerrain = (args: any) => {
      const p = tm.terrainParams(args), h = tm.makeHeightField(p), geo = new THREE.PlaneGeometry(p.size, p.size, 96, 96).rotateX(-Math.PI / 2);
      const pos = geo.attributes.position; for (let i = 0; i < pos.count; i++) pos.setY(i, h(pos.getX(i), pos.getZ(i)));
      geo.computeVertexNormals(); return { mesh: new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ color: 0x7a8a5a })), heightAt: h };
    };
    const st = await import('/lib/state.js'); for (let i = 0; i < 200 && !st.state.hydrated; i++) await sleep(50);
    const { applyTerrainState } = await import('/lib/world.js'), lw = await import('/lib/water.js'), c = await import('/lib/controller.js');
    applyTerrainState({ seed: 7, size: 120, amplitude: 0, features: [{ type: 'hill', x: 0, z: 30, radius: 18, height: -8 }], water: { level: 0 } });
    for (let i = 0; i < 300 && lw.waterLevel() !== 0; i++) await sleep(50);
    // falling over the lake with C held, before the body has ever floated: no swim starts in mid-air (review #254)
    c.myState.pos.set(0, 8, 30); c.keys.add('KeyC'); await sleep(200);
    const fallingWithC = { diving: c.isLevelDiving(), y: +c.myState.pos.y.toFixed(2) }; c.keys.delete('KeyC'); await sleep(2500);
    // afloat at the lake's centre (after the fall's dunk has bobbed back up: the float owns the body meanwhile)
    for (let i = 0; i < 160 && Math.abs(c.myState.pos.y + 1.1) > 0.25; i++) await sleep(50);
    c.myState.pos.set(0, -1.1, 30); await sleep(1500);
    const y = () => +c.myState.pos.y.toFixed(2);
    const out: any = { fallingWithC, floating: { y: y(), diving: c.isLevelDiving() } };
    // the clip while afloat must hold steady (tread idle, swim moving) — not flip frame to frame
    const clips = async (ms: number) => { const seen: string[] = []; const t0 = performance.now();
      while (performance.now() - t0 < ms) { seen.push(c.myState.clip); await new Promise((r) => requestAnimationFrame(() => r(null))); }
      let flips = 0; for (let i = 1; i < seen.length; i++) if (seen[i] !== seen[i - 1]) flips++; return { flips, clips: [...new Set(seen)] }; };
    out.idleClips = await clips(1500);
    c.keys.add('KeyW'); await sleep(400); out.swimClips = await clips(1500); c.keys.delete('KeyW'); await sleep(800);
    c.myState.pos.set(0, -1.1, 30); await sleep(1200);
    c.keys.add('KeyC'); await sleep(1500);
    out.diving = { y: y(), diving: c.isLevelDiving(), mode: c.myState.locomotion?.mode ?? null, medium: c.myState.locomotion?.medium ?? null };
    c.keys.delete('KeyC'); c.keys.add('Space'); await sleep(3500); c.keys.delete('Space'); await sleep(1500);
    out.surfaced = { y: y(), diving: c.isLevelDiving(), clip: c.myState.clip };
    return out;
  }, !!engine);
  console.log(JSON.stringify(r));
  assert.equal(r.floating.diving, false, 'afloat at the surface is not diving');
  assert.equal(r.fallingWithC.diving, false, 'falling over the water with C held does not start a swim in the air');
  assert.equal(r.diving.diving, true, 'holding C in deep level water dives');
  assert.ok(r.diving.y < r.floating.y - 1, `the body goes down while diving (${r.floating.y} → ${r.diving.y})`);
  assert.equal(r.diving.medium, 'water');
  assert.equal(r.surfaced.diving, false, 'back at the surface the float takes the body again');
  assert.ok(Math.abs(r.surfaced.y - r.floating.y) < 0.6, `it surfaces at the floating depth (${r.surfaced.y} vs ${r.floating.y})`);
  assert.ok(r.idleClips.flips <= 1 && r.swimClips.flips <= 1, `the floating clip holds steady (idle ${JSON.stringify(r.idleClips)}, swimming ${JSON.stringify(r.swimClips)})`);
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS: dive under the level with C, the 3D swim takes the body; back up, the float takes it again');
} finally { await browser.close(); }
