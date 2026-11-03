// bun tools/lod-look-probe.mjs — does a LOD look like its original from where a viewer can ACTUALLY see it?
// Pairs come from LOD_LOOK_PAIRS="orig.glb=lod.glb;…" (or LOD_LOOK_DIR: <dir>/<name>.plod.glb beside a list of
// originals). Each pair is loaded by the CLIENT's own loader and rendered from the closest distance lod_policy can
// show the LOD: auto = LOD edge 0.45·R × (1 − hyst 0.25) = 0.3375·R; eco/pressured = half that (R = 80 + 4·diag,
// realize/models.js). Pixel density ≈ a headset's (~20 px/°: 480 px over a 24° field). Per pair: the object's pixels
// (union of both silhouettes), mean RGB difference over them, and the share differing by > 24 (sum of channels).
// Writes a contact sheet (original | LOD | ×8 difference per row, auto and eco) to LOD_LOOK_OUT.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const { check, done } = checker();
const pairs = (process.env.LOD_LOOK_PAIRS ?? '').split(';').filter(Boolean).map((p) => p.split('='));
const OUT = process.env.LOD_LOOK_OUT ?? '/tmp/lod-look.png';
// REPORT-ONLY by default. A per-pixel threshold is not a look judgement: on the rubble pile the TEXTURE conversion
// alone (original vs its served KTX2, identical geometry) scored 64% 'visibly different', and the LOD vs what is served
// 52% — the number says nothing a person should trust. The contact sheet is for eyes (the owner's); LOD_LOOK_MAX turns on a
// gate for anyone who has calibrated one.
const MAX_BAD = process.env.LOD_LOOK_MAX != null ? Number(process.env.LOD_LOOK_MAX) : null;
if (!pairs.length) { check('pairs given (LOD_LOOK_PAIRS)', false, 'none'); done(); process.exit(1); }
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();
try {
  const pg = await page();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.route('**/__look/**', (route) => {
    const f = decodeURIComponent(route.request().url().split('/__look/')[1]);
    route.fulfill({ body: readFileSync(f), headers: { 'content-type': 'model/gltf-binary' } });
  });
  await pg.goto(`${world.origin}/?world=staging&name=lodlook&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 60000 });
  const rows = [];
  for (const [orig, lod] of pairs) {
    const r = await Promise.race([pg.evaluate(async ([orig, lod, dists]) => {
      const { THREE, renderer } = await import('./lib/core.js');
      const { makeLoader } = await import('./lib/assets.js');
      const load = async (f) => (await makeLoader().loadAsync(`/__look/${encodeURIComponent(f)}`)).scene;
      const [a, b] = await Promise.all([load(orig), load(lod)]);
      const box = new THREE.Box3().setFromObject(a), c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
      // the distances come from the client's own modules, never a copy (shared/lod-distance.js, lod_policy.js)
      const { lodNearest, residencyRadiusFor } = await import('/shared/lod-distance.js');
      const { PRESSURE_EDGE } = await import('./lib/lod_policy.js');
      const R = residencyRadiusFor(sz.length()), near = lodNearest(sz.length());
      const W = 480;
      const sc = new THREE.Scene();
      sc.add(new THREE.HemisphereLight(0xffffff, 0x4a4a4a, 1.3));
      const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(3, 6, 4); sc.add(sun);
      const rt = new THREE.RenderTarget(W, W, { type: THREE.UnsignedByteType });
      const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
      const shoot = async (obj, d) => {
        sc.add(obj);
        const cam = new THREE.PerspectiveCamera(24, 1, 0.1, 5000);
        cam.position.set(c.x + d * 0.6, c.y + d * 0.25, c.z + d * 0.76); cam.lookAt(c); cam.updateMatrixWorld(true);
        await renderer.compileAsync(sc, cam);
        renderer.setClearColor(0x000000, 0); renderer.setRenderTarget(rt); renderer.clear(); renderer.render(sc, cam); renderer.setRenderTarget(null);
        const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, W);
        sc.remove(obj);
        return px;
      };
      const out = { R: +R.toFixed(1), diag: +sz.length().toFixed(2) };
      // LOD_LOOK_DISTS="a,b" (metres) overrides both views — e.g. an avatar close-up, where LOD distances are meaningless
      const dd = (dists ?? '').split(',').map(Number).filter((x) => x > 0);
      for (const [label, d] of [['auto', dd[0] ?? near], ['eco', dd[1] ?? near * PRESSURE_EDGE]]) {
        const pa = await shoot(a, d), pb = await shoot(b, d);
        let n = 0, sum = 0, bad = 0;
        const img = new ImageData(W * 3, W);
        for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4, o = ((W - 1 - y) * W * 3 + x) * 4;
          const cov = pa[i + 3] > 0 || pb[i + 3] > 0;
          const dd = Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
          if (cov) { n++; sum += dd / 3; if (dd > 24) bad++; }
          for (let k = 0; k < 3; k++) { img.data[o + k] = pa[i + k]; img.data[o + W * 4 + k] = pb[i + k]; img.data[o + W * 8 + k] = Math.min(255, dd * 8 / 3); }
          img.data[o + 3] = img.data[o + W * 4 + 3] = img.data[o + W * 8 + 3] = 255;
        }
        const cv = document.createElement('canvas'); cv.width = W * 3; cv.height = W; cv.getContext('2d').putImageData(img, 0, 0);
        out[label] = { dist: +d.toFixed(1), px: n, meanDiff: +(sum / Math.max(1, n)).toFixed(2), bad: +(bad / Math.max(1, n)).toFixed(4), png: cv.toDataURL() };
      }
      renderer.setClearColor(cc, ca);
      return out;
    }, [orig, lod, process.env.LOD_LOOK_DISTS ?? null]), new Promise((_, rej) => setTimeout(() => rej(new Error('pinned 150 s')), 150000))]);
    rows.push([orig, r]);
    for (const k of ['auto', 'eco']) writeFileSync(`${OUT.replace(/\.png$/, '')}-${rows.length}-${k}.png`, Buffer.from(r[k].png.split(',')[1], 'base64'));
    const name = orig.split('/').pop().slice(0, 40);
    console.log(`  ${name}: R ${r.R} m | auto @${r.auto.dist} m: ${r.auto.px} px, mean Δ ${r.auto.meanDiff}, ${(r.auto.bad * 100).toFixed(1)}% visibly different | eco @${r.eco.dist} m: ${(r.eco.bad * 100).toFixed(1)}%`);
    check(`${name}: rendered at both LOD distances (object on screen)`, r.auto.px > 50 && r.eco.px > 50, [r.auto.px, r.eco.px]);
    if (MAX_BAD != null) check(`${name}: at the closest 'auto' LOD distance, ≤ ${MAX_BAD * 100}% of its pixels differ visibly`, r.auto.bad <= MAX_BAD, r.auto.bad);
  }
  // contact sheet (auto row then eco row per pair), assembled in the page
  const sheet = await pg.evaluate(async (pngs) => {
    const imgs = await Promise.all(pngs.map((s) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = s; })));
    const cv = document.createElement('canvas'); cv.width = imgs[0].width; cv.height = imgs.reduce((h, i) => h + i.height, 0);
    const g = cv.getContext('2d'); let y = 0; for (const i of imgs) { g.drawImage(i, 0, y); y += i.height; }
    return cv.toDataURL('image/png');
  }, rows.flatMap(([, r]) => [r.auto.png, r.eco.png]));
  writeFileSync(OUT, Buffer.from(sheet.split(',')[1], 'base64'));
  console.log(`  contact sheet: ${OUT} (per pair: auto row, eco row; columns original | LOD | ×8 difference)`);
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
} catch (e) { check('probe ran', false, String(e).slice(0, 300)); }
finally { await browser.close(); await world.close(); }
done();
