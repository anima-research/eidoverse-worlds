// bun tools/puddle-gate-probe.mjs — the puddle-noise cost gates (materials.js) change NO pixel.
//
// Every PBR surface ran 4 value-noise taps (16 hashes) per fragment for puddles: materials that opted out (grass,
// foliage) multiplied them by a literal 0 (GLSL cannot fold x*0), and in dry weather the puddle factor is exactly 0.
// Now: opted-out materials never build the term, and the taps run in a uniform If(wet > 0.35). ?pudgate=0 builds the
// old graph verbatim. This renders the same scene through the REAL prepareMaterial in both graphs and diffs:
//   dry / edge / wet — wet 0.20, 0.36, 0.90: old graph vs gated graph byte-identical (flat PBR ground where puddles
//                      form, a tilted plane, a noPuddles plane)
//   live             — the wet render really HAS puddles (differs from dry): the gate cannot be hiding a dead term
// Usage: bun tools/puddle-gate-probe.mjs   (run under a memory guard: headless Chromium renders on the CPU)
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';

const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();

async function renderAll(pudgate) {
  const pg = await page();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${world.origin}/?world=staging&name=pudprobe&key=${world.key}${pudgate ? '' : '&pudgate=0'}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 60000 });
  await pg.waitForTimeout(3000);
  const out = await Promise.race([pg.evaluate(async () => {
    const { THREE, renderer } = await import('./lib/core.js');
    const M = await import('./lib/materials.js');
    const U = M.materialUniforms();
    const W = 256, H = 160;
    const sc = new THREE.Scene();
    sc.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(3, 8, 2); sc.add(sun);
    const cam = new THREE.PerspectiveCamera(55, W / H, 0.1, 500); cam.position.set(0, 6, 9); cam.lookAt(0, 0, 0);
    const mk = (col) => new THREE.MeshStandardNodeMaterial({ color: col, roughness: 0.8, metalness: 0 });
    const flat = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), mk(0x7a6a55)); flat.rotation.x = -Math.PI / 2;
    const tilt = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), mk(0x556677)); tilt.position.set(-3, 1.5, 1); tilt.rotation.x = -0.9;
    const grassMat = mk(0x557733); grassMat.userData.noPuddles = true;
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), grassMat); grass.rotation.x = -Math.PI / 2; grass.position.set(3, 0.05, 1);
    sc.add(flat, tilt, grass);
    for (const m of [flat, tilt, grass]) M.prepareMaterial(m.material, m);
    const rt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType });
    await renderer.compileAsync(sc, cam);
    const res = {};
    for (const wet of [0.2, 0.36, 0.9]) {
      // pin every animated uniform, then render synchronously (no frame between the pin and the draw)
      U.wet.value = wet; U.cloudStrength.value = 0.3;
      U.scroll1.value.set(1.25, 2.5); U.scroll2.value.set(-3.0, 0.75); U.cloudOff.value.set(0, 0);
      const prev = renderer.getRenderTarget(); renderer.setRenderTarget(rt); renderer.render(sc, cam); renderer.setRenderTarget(prev);
      res[wet] = Array.from(await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H));
    }
    return res;
  }), new Promise((_, rej) => setTimeout(() => rej(new Error('page pinned 60 s')), 60000))]);
  await pg.close();
  return { out, errs };
}

const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
try {
  const old = await renderAll(false), neu = await renderAll(true);
  for (const wet of ['0.2', '0.36', '0.9']) {
    const n = diff(old.out[wet], neu.out[wet]);
    check(`wet ${wet}: gated graph is byte-identical to the old graph`, n === 0, `${n} of ${old.out[wet].length} bytes differ`);
  }
  const live = diff(neu.out['0.2'], neu.out['0.9']);
  check('live: the wet render really differs from the dry one (puddles + wetness present)', live > 1000, `${live} bytes differ dry→wet`);
  check('no page errors', old.errs.length + neu.errs.length === 0, [...old.errs, ...neu.errs].slice(0, 2).join(' | ') || 'none');
} catch (e) { check('probe ran to completion', false, String(e).slice(0, 300)); }
finally { await browser.close(); await world.close(); }
done();
