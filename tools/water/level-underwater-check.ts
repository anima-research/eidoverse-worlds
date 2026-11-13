// Underwater under the world's water LEVEL (lakes, rivers, the sea), in a real browser, on both backends.
//   WATER_PREVIEW_URL=http://127.0.0.1:<port>/?world=<fresh>&spectate=1&name=lvl bun tools/water/level-underwater-check.ts
// A terrain with a level is applied locally (the real terrain + water build), the camera is driven (renderer
// mode) above the deepest wet spot, under its surface looking level, and under it looking up. Checks: the
// underwater state turns on only under the surface; the image under it is fogged (calmer, toward the water's
// colour) while above it is not; no shader errors on WebGPU or WebGL. SHOT_DIR=<dir> saves the frames.
import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
const base = process.env.WATER_PREVIEW_URL ?? 'http://127.0.0.1:19347/?world=level-underwater&spectate=1&name=lvl';
const shots = process.env.SHOT_DIR; if (shots) mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
try {
  for (const backend of ['webgpu', 'webgl']) {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const errors: string[] = []; page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text()); });
    // The ground builder is upstream's engine module (/library/eidoverse/terrain.js), not in this repo; a test
    // preview's library may not carry it. Stand in with this repo's own height law (shared/terrainmath.js — the
    // law the server and agents use), so the water fills real lows; never fetched from any other server.
    // ENGINE_LIB=<dir of upstream eidoverse/*.js> runs the REAL engine modules (terrain, sky, weather — the weather
    // system wraps transparent materials, which a stand-in would never exercise); otherwise a stand-in ground.
    const engine = process.env.ENGINE_LIB;
    if (engine) await page.route('**/library/eidoverse/*.js', (route) => {
      const f = `${engine}/${new URL(route.request().url()).pathname.split('/').pop()}`;
      return existsSync(f) ? route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(f, 'utf8') }) : route.continue();
    });
    else await page.route('**/library/eidoverse/terrain.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '// stand-in: makeTerrain is defined by the test' }));
    await page.goto(`${base}&${backend}=1`);
    await page.waitForFunction(() => !!globalThis.__waterDebug);
    await page.evaluate(async () => { const st = await import('/lib/state.js'); for (let i = 0; i < 200 && !st.state.hydrated; i++) await new Promise((r) => setTimeout(r, 50)); });
    const r = await page.evaluate(async (realEngine: boolean) => {
      const { camera, renderer, scene } = await import('/lib/core.js');
      const { CONFIG } = await import('/lib/base.js'); CONFIG.renderer = true;   // we drive the camera
      const { applyTerrainState } = await import('/lib/world.js');
      const { THREE } = await import('/lib/core.js'), tm = await import('/shared/terrainmath.js');
      if (!realEngine) (globalThis as any).makeTerrain = (args: any) => {
        const p = tm.terrainParams(args), h = tm.makeHeightField(p), geo = new THREE.PlaneGeometry(p.size, p.size, 128, 128).rotateX(-Math.PI / 2);
        const pos = geo.attributes.position; for (let i = 0; i < pos.count; i++) pos.setY(i, h(pos.getX(i), pos.getZ(i)));
        geo.computeVertexNormals();
        return { mesh: new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ color: 0x7a8a5a, roughness: 0.95 })), heightAt: h };
      };
      const lw = await import('/lib/water.js'), wv = await import('/lib/watervolumes.js'); (globalThis as any).__lvlDebug = [];
      // a level at the ground's 35th percentile: a third of the square floods, whatever the seed makes
      const { heightAt } = await import('/lib/terrain.js');
      // applyTerrainState queues the build (world.js enqueueWorldBuild): wait for each to land
      const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 50)); if (!ok()) throw Error(`${what} never landed`); };
      const ground = { seed: 11, size: 120, amplitude: 7 };
      const sample = () => { const hs: number[] = []; for (let x = -55; x <= 55; x += 5) for (let z = -55; z <= 55; z += 5) hs.push(heightAt(x, z)); return hs.sort((a, b) => a - b); };
      applyTerrainState(ground); await until(() => { const h = sample(); return h[h.length - 1] - h[0] > 1; }, 'the terrain');
      const hs = sample(), level = hs[Math.floor(hs.length * 0.35)];
      applyTerrainState({ ...ground, water: { level } }); await until(() => lw.waterLevel() === level, 'the water level');
      // a real sky over it (its domes draw unfogged — the under-dome must hide them below the surface)
      const st = await import('/lib/state.js'); st.foldLive({ seq: 1e9, ts: Date.now(), actor: 'test', verb: 'sky', args: { hours: 11 } });
      await new Promise((r) => setTimeout(r, 1500));
      // the deepest wet spot on a coarse scan
      let best: any = null;
      for (let x = -40; x <= 40; x += 2.5) for (let z = -40; z <= 40; z += 2.5) {   // away from the square's edge
        const w = lw.waterAt(x, z); if (w && (!best || w.depth > best.depth)) best = { x, z, depth: w.depth, kind: w.kind };
      }
      if (!best) return { error: 'no water in the test terrain' };
      const frame = async (pos: number[], look: number[]) => {
        camera.position.set(pos[0], pos[1], pos[2]); camera.lookAt(look[0], look[1], look[2]); camera.updateMatrixWorld();
        wv.updateWater();
        await renderer.compileAsync(scene, camera);
        // WebGL compiles in parallel and skips a draw until its program is ready: settle a few frames, then
        // capture right after our own render (the drawing buffer is only valid until the next composite)
        const { renderWorld } = await import('/lib/render.js');
        for (let i = 0; i < 4; i++) { wv.updateWater(); renderWorld(); await new Promise((r) => setTimeout(r, 60)); }
        wv.updateWater(); renderWorld();
        const under = wv.underLevel();
        if (under && (globalThis as any).__lvlDebug) {
          const sheet = scene.children.find((o: any) => o.name === 'water');
          (globalThis as any).__lvlDebug.push({ far: camera.far, near: camera.near, sheet: sheet ? { side: sheet.material.side, visible: sheet.visible, y: sheet.position.y, idx: sheet.geometry.index?.count } : null,
            domes: scene.children.filter((o: any) => o.geometry?.type === 'SphereGeometry').map((o: any) => ({ r: o.geometry.parameters.radius, visible: o.visible, order: o.renderOrder, fog: o.material.fog, depthTest: o.material.depthTest, transparent: o.material.transparent })),
            sky: scene.children.filter((o: any) => o.material && o.material.fog === false).map((o: any) => ({ type: o.geometry?.type, order: o.renderOrder, depthTest: o.material.depthTest, depthWrite: o.material.depthWrite, scale: o.scale?.x })), cam: camera.position.toArray().map((v: number) => +v.toFixed(2)) });
        }
        const url = renderer.domElement.toDataURL('image/png');
        return { under, url };
      };
      const surf = lw.surfaceHeightAt(best.x, best.z)!;
      const out: any = { best, surf };
      out.above = await frame([best.x - 6, surf + 3, best.z - 6], [best.x + 6, surf - 1, best.z + 6]);
      out.below = await frame([best.x, surf - Math.min(1.2, best.depth * 0.5), best.z], [best.x + 10, surf - Math.min(1.2, best.depth * 0.5), best.z]);
      // looking up at 50°: Snell's window (inside ~41.4° elevation and up) fills the top of the frame, the
      // darker water outside it the bottom
      const camY = surf - Math.min(1.2, best.depth * 0.5);
      out.dayAtUp = (await import('/lib/core.js')).sun.intensity;
      out.up = await frame([best.x, camY, best.z], [best.x + 10, camY + 10 * Math.tan(50 * Math.PI / 180), best.z]);
      out.backend = renderer.backend?.isWebGLBackend ? 'webgl' : 'webgpu';
      // the full sky's weather system wets every material: vec4(colorNode) → rgb × k, alpha kept. The sheet's colour
      // must survive that wrap (a select() colour compiled to invalid WGSL and no water drew at all on staging)
      { const sheet: any = scene.getObjectByName('water'); const { TSL } = await import('/lib/core.js');
        const base4 = TSL.vec4(sheet.material.colorNode); sheet.material.colorNode = TSL.vec4(base4.rgb.mul(TSL.float(0.9)), base4.a); sheet.material.needsUpdate = true;
        out.wrapped = await frame([best.x - 6, surf + 3, best.z - 6], [best.x + 6, surf - 1, best.z + 6]); await new Promise((r) => setTimeout(r, 1200)); }
      // back UNDER the surface for the checks that follow (review #254): they test underwater states
      const under = await frame([best.x, camY, best.z], [best.x + 10, camY, best.z]); out.backUnder = under.under;
      // a dry pocket below the level around the camera: the fog stays, the sky is not swapped for the far water
      const st0 = await import('/lib/state.js'); let s0 = 3e9;
      st0.foldLive({ seq: ++s0, ts: Date.now(), actor: 'test', verb: 'spawn', args: { id: 'shaft', lib: 'x.glb', pos: [best.x, camY - 1, best.z] } });
      st0.foldLive({ seq: ++s0, ts: Date.now(), actor: 'test', verb: 'comp', args: { id: 'shaft', type: 'air', data: { boxes: [{ center: [0, 6, 0], size: [3, 14, 3] }] } } });
      wv.updateWater(); wv.updateWaterView(); out.inShaft = wv.waterDebug();
      // per direction from inside the shaft: straight up leaves it above the surface (sky), sideways into water
      const lum = async (look: number[]) => { const f = await frame([best.x, camY, best.z], look); const img = new Image(); img.src = f.url; await img.decode();
        const cv = new OffscreenCanvas(img.width, img.height), g = cv.getContext('2d')!; g.drawImage(img, 0, 0);
        const px = g.getImageData(img.width >> 1, img.height >> 2, 1, 1).data; return { rgb: [px[0], px[1], px[2]], sum: px[0] + px[1] + px[2] }; };
      out.shaftUp = await lum([best.x + 0.01, camY + 20, best.z]); out.shaftSide = await lum([best.x + 20, camY, best.z]);
      st0.foldLive({ seq: ++s0, ts: Date.now(), actor: 'test', verb: 'remove', args: { id: 'shaft' } });
      wv.updateWater(); wv.updateWaterView(); out.afterShaft = wv.waterDebug();
      // four authored volumes AND the level: every one keeps a fog slot (the level has its own)
      const st2 = await import('/lib/state.js');
      let seq = 4e9; const fold = (verb: string, args: any) => st2.foldLive({ seq: ++seq, ts: Date.now(), actor: 'test', verb, args });
      for (let i = 0; i < 4; i++) { fold('spawn', { id: `vol${i}`, lib: 'x.glb', pos: [best.x + 200 + i * 20, 0, best.z] }); fold('comp', { id: `vol${i}`, type: 'water', data: { center: [0, 0, 0], size: [4, 4, 4] } }); }
      wv.updateWater(); wv.updateWaterView(); out.fourVolumes = wv.waterDebug();
      // travel: a world reset clears the level — no level fog, background or sky hiding follows to the next world
      st2.reset(); wv.updateWater(); wv.updateWaterView();
      out.afterReset = { level: lw.levelWaterInfo(), debug: wv.waterDebug(), backgroundNode: scene.backgroundNode ? 'set' : null };
      out.debug = (globalThis as any).__lvlDebug;
      return out;
    }, !!engine);
    assert.ok(!r.error, r.error);
    // pixel statistics from the PNGs, in the page (mean colour and spread)
    const stats = await page.evaluate(async (urls: string[]) => Promise.all(urls.map(async (u) => {
      const img = new Image(); img.src = u; await img.decode();
      const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d')!; g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data; let n = 0, s = [0, 0, 0], q = 0;
      for (let i = 0; i < d.length; i += 16) { n++; for (let k = 0; k < 3; k++) s[k] += d[i + k]; q += (d[i] + d[i + 1] + d[i + 2]) ** 2; }
      const m = s.map((v) => v / n), lum = (m[0] + m[1] + m[2]);
      // the centre's and the corners' brightness (Snell's window: a bright centre, darker water around it)
      const region = (x0: number, y0: number, w: number, h: number) => { const r = g.getImageData(x0, y0, w, h).data; let t = 0; for (let i = 0; i < r.length; i += 4) t += r[i] + r[i + 1] + r[i + 2]; return t / (r.length / 4); };
      const W = img.width, H = img.height, cw = W >> 3, ch = H >> 3;
      const centre = region((W - cw) >> 1, (H - ch) >> 1, cw, ch), corners = (region(0, 0, cw, ch) + region(W - cw, 0, cw, ch) + region(0, H - ch, cw, ch) + region(W - cw, H - ch, cw, ch)) / 4;
      const top = region(0, 0, W, ch), bottom = region(0, H - ch, W, ch);
      return { mean: m.map((v) => Math.round(v)), spread: Math.round(Math.sqrt(Math.max(0, q / n - lum * lum))), centre: Math.round(centre), corners: Math.round(corners), top: Math.round(top), bottom: Math.round(bottom) };
    })), [r.above.url, r.below.url, r.up.url]);
    if (shots) for (const [k, v] of Object.entries({ above: r.above.url, below: r.below.url, up: r.up.url })) writeFileSync(`${shots}/${backend}-${k}.png`, Buffer.from((v as string).split(',')[1], 'base64'));
    console.log(backend, JSON.stringify({ sunAtUp: r.dayAtUp, upStats: stats[2], ran: r.backend, spot: r.best, under: [r.above.under, r.below.under, r.up.under], stats, fourVolumes: r.fourVolumes, afterReset: r.afterReset }));
    if (process.env.LVL_DEBUG) console.log(JSON.stringify(r.debug, null, 1));
    assert.equal(r.backend, backend, `asked for ${backend}, the renderer ran ${r.backend}`);
    assert.equal(r.above.under, false, 'above the surface is not underwater');
    assert.equal(r.below.under, true, 'below the surface is underwater');
    assert.equal(r.up.under, true);
    assert.ok(stats[1].spread < stats[0].spread * 0.5, 'under water the view is fogged (well under half the contrast above)');
    assert.ok(stats[2].top > stats[2].bottom * 1.3, `looking up, Snell's window (top) is brighter than the water outside it (bottom): ${stats[2].top} vs ${stats[2].bottom}`);
    assert.equal(r.backUnder, true, 'the checks below run under the surface');
    assert.ok(r.inShaft.under && r.inShaft.enabled && r.inShaft.dryPocket >= 0, 'in a dry shaft below the level: fog on, the pocket found');
    assert.ok(r.shaftUp.sum > r.shaftSide.sum * 1.25, `up the shaft is sky, sideways is water (${JSON.stringify(r.shaftUp)} vs ${JSON.stringify(r.shaftSide)})`);
    assert.deepEqual([r.afterShaft.under, r.afterShaft.background], [true, true], 'out of the shaft, under the water again');
    assert.equal(r.fourVolumes.waters, 4); assert.equal(r.fourVolumes.slots, 5, 'four volumes and the level: five fog slots');
    assert.equal(r.fourVolumes.under, true, 'the four-volume check runs under the level');
    assert.equal(r.afterReset.level, null, 'a world reset clears the level');
    assert.deepEqual([r.afterReset.debug.under, r.afterReset.debug.background, r.afterReset.debug.enabled, r.afterReset.backgroundNode], [false, false, false, null], 'nothing of the old water follows to the next world');
    assert.deepEqual(errors.filter((e) => /shader|WGSL|GLSL|compile|TSL/i.test(e)), [], `${backend}: shader errors`);
    console.log(`PASS (${backend}): underwater only under the surface, fogged below, window bright overhead, clear above; four volumes + the level keep their fog; travel clears the level; no shader errors`);
    await page.close();
  }
} finally { await browser.close(); }
