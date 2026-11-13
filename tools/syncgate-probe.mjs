// bun tools/syncgate-probe.mjs — NO PIPELINE LINKS ON THE RENDER PATH (client/lib/syncgate.js), in the real client.
//
// The owner's DevTools trace (2026-09-24 00:25): one render-path getProgramParameter held the main thread 54.7 s in the
// Commons and froze the browser. syncgate hands render-path builds to three's KHR_parallel_shader_compile polling
// branch and skips the object's draw until its program links. What this binds (mutation that turns it red in brackets):
//   census   — a never-warmed variant added to the scene is counted as a render-path build
//   inert    — with no extension (SwiftShader), nothing is deferred and the object draws at once
//   deferred — with the extension, the build goes to the poll, not linked in place   [?syncgate=0 run: its own checks]
//   skipped  — the object is not drawn on the frame that requested its program (three's isReady gate)
//   drains   — it IS drawn once linked, within a few frames                           [--mutate-never-drain]
//   frame    — the frame that met the new variant did not pay a link (< 100 ms request)
//   one-shot — a cold render INTO A TARGET (a bake, an env) is NOT deferred: it draws on that one call
//              [mutate: drop the getRenderTarget()===null condition → the target reads back empty]
// SwiftShader has no KHR_parallel_shader_compile, so the gate runs against an EMULATED extension (COMPLETION_STATUS
// true 150 ms after the link is issued): this proves ORCHESTRATION. Whether the owner's Chrome exposes the extension,
// and whether the 55 s freeze becomes a late pop-in, is a headset-machine fact — the '[syncgate] installed' tee says
// which, and '[syncgate] render-path build …' lines name every slow build and its material.
// Usage: bun tools/syncgate-probe.mjs [origin] [--mutate-never-drain]   (run under a memory guard: headless Chromium renders on the CPU)
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';

const { check, done } = checker();
const MUTATE = process.argv.includes('--mutate-never-drain');
const world = await ownedWorld({ live: process.argv.slice(2).find((a) => a.startsWith('http')) ?? null });
const { browser, page } = await launchBrowser();

async function emulateParallel() {
  const { renderer } = await import('./lib/core.js');
  const be = renderer.backend, gl = be.gl;
  const born = new WeakMap();
  const link = gl.linkProgram.bind(gl);
  gl.linkProgram = (p) => { born.set(p, performance.now()); return link(p); };
  const gpp = gl.getProgramParameter.bind(gl);
  gl.getProgramParameter = (p, pname) => (pname === 0x91B1 ? performance.now() - (born.get(p) ?? 0) > 150 : gpp(p, pname));
  be.parallel = { COMPLETION_STATUS_KHR: 0x91B1 };
}

async function addUnwarmed(mutate) {
  const { THREE, TSL, renderer, scene, camera } = await import('./lib/core.js');
  const be = renderer.backend, s = globalThis.__syncGate;
  if (mutate) {   // never drain: anything requested on the render path stays undrawable
    const stuck = new WeakSet(); be.__stuck = stuck;
    const crp0 = be.createRenderPipeline.bind(be); be.createRenderPipeline = (ro, p) => { const r = crp0(ro, p); if (p == null) stuck.add(ro.pipeline); return r; };
    const dr0 = be.draw.bind(be); be.draw = (ro, i) => (stuck.has(ro.pipeline) ? undefined : dr0(ro, i));
  }
  const before = { renderPath: s.renderPath, deferred: s.deferred };
  const mat = new THREE.MeshStandardNodeMaterial();   // a variant unique to this run: nothing could have warmed it
  mat.colorNode = TSL.vec3(TSL.sin(TSL.positionWorld.x.mul(Math.random() * 9 + 1)), TSL.float(0.4), TSL.cos(TSL.time.mul(0.7)));
  mat.name = 'syncgate-probe-unique';
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), mat);
  mesh.name = 'syncgate-probe-box'; mesh.frustumCulled = false;
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  mesh.position.copy(camera.getWorldPosition(new THREE.Vector3())).addScaledVector(dir, 2.5);
  let reqMs = null, drawnAt = null, frame = 0;
  const crp = be.createRenderPipeline.bind(be), dr = be.draw.bind(be);
  be.createRenderPipeline = (ro, p) => {
    const t = performance.now(); const r = crp(ro, p);
    if (ro.object === mesh && p == null && reqMs === null) reqMs = performance.now() - t;
    return r;
  };
  be.draw = (ro, i) => {
    if (ro.object !== mesh || drawnAt !== null) return dr(ro, i);
    const r = dr(ro, i);
    if (!be.__stuck?.has(ro.pipeline)) drawnAt = frame;
    return r;
  };
  scene.add(mesh);
  const t0 = performance.now();
  while (drawnAt === null && performance.now() - t0 < 8000) { await new Promise((r) => requestAnimationFrame(r)); frame++; }
  delete be.draw; if (!be.__stuck) be.createRenderPipeline = crp; scene.remove(mesh);
  return { parallel: !!be.parallel, gate: s.gate, reqMs, drawnAt, waitedMs: +(performance.now() - t0).toFixed(0),
    d: { renderPath: s.renderPath - before.renderPath, deferred: s.deferred - before.deferred },
    totals: { renderPath: s.renderPath, deferred: s.deferred },
    slow: s.slow.map((r) => `${r.ms}ms ${r.object} ${r.material} vs${r.vs} fs${r.fs}`) };
}


async function oneShotIntoTarget() {
  const { THREE, TSL, renderer } = await import('./lib/core.js');
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = TSL.vec3(TSL.float(Math.random() * 0.2 + 0.7), TSL.float(0.2), TSL.float(0.9));   // unique → cold
  const sc = new THREE.Scene(); sc.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const rt = new THREE.RenderTarget(8, 8, { type: THREE.UnsignedByteType, depthBuffer: false });
  const s = globalThis.__syncGate; const d0 = s.deferred;
  const prev = renderer.getRenderTarget(); renderer.setRenderTarget(rt); renderer.render(sc, cam); renderer.setRenderTarget(prev);
  const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, 8, 8);
  return { deferred: s.deferred - d0, red: px[0], blue: px[2] };
}

async function run({ gateOn, emulate }) {
  const pg = await page();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e)));
  const ev = (fn, arg) => Promise.race([pg.evaluate(fn, arg),
    new Promise((_, rej) => setTimeout(() => rej(new Error('page main thread pinned for 20 s')), 20000))]);
  await pg.goto(`${world.origin}/?world=staging&name=gateprobe&key=${world.key}&xr=1${gateOn ? '' : '&syncgate=0'}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => !!globalThis.__syncGate && globalThis.__ewEngineUp, null, { timeout: 60000 });
  await pg.waitForTimeout(8000);   // let the boot's own warms settle
  if (emulate) await ev(emulateParallel);
  const res = await ev(addUnwarmed, MUTATE);
  res.oneShot = emulate ? await ev(oneShotIntoTarget) : null;
  await pg.close();
  return { ...res, errs };
}

let fatal = null;
try {
  const real = await run({ gateOn: true, emulate: false });
  console.log('  real SwiftShader, gate on:', JSON.stringify(real));
  check('census: a never-warmed variant is counted as a render-path build', real.d.renderPath >= 1, `renderPath +${real.d.renderPath}, parallel=${real.parallel}`);
  check('inert without the extension: nothing deferred, the object draws at once', real.parallel || (real.d.deferred === 0 && real.drawnAt !== null && real.drawnAt <= 2), `parallel=${real.parallel} deferred +${real.d.deferred} drawn@${real.drawnAt}`);
  const on = await run({ gateOn: true, emulate: true });
  console.log('  EMULATED parallel, gate on:', JSON.stringify(on));
  check('deferred: with the extension, the render-path build goes to the poll, not linked in place', on.d.deferred >= 1, `deferred +${on.d.deferred}`);
  check('skipped: the object is NOT drawn on the frame that requested its program (three waits for the link)', on.drawnAt !== null && on.drawnAt >= 1, `first draw at frame ${on.drawnAt}`);
  check('drains: the deferred object IS drawn once linked, within a few frames', on.drawnAt !== null && on.drawnAt <= 30, `drawn at frame ${on.drawnAt} (${on.waitedMs} ms)`);
  check('frame: requesting the new pipeline on the render path took < 100 ms', on.reqMs !== null && on.reqMs < 100, `${on.reqMs?.toFixed?.(1)} ms`);
  check('one-shot: a cold render into a target is NOT deferred and draws on its one call', on.oneShot && on.oneShot.deferred === 0 && on.oneShot.red > 150 && on.oneShot.blue > 200, JSON.stringify(on.oneShot));
  check('no page errors (real + emulated)', real.errs.length + on.errs.length === 0, [...real.errs, ...on.errs].slice(0, 2).join(' | ') || 'none');
  const off = await run({ gateOn: false, emulate: true });
  console.log('  EMULATED parallel, ?syncgate=0:', JSON.stringify(off));
  check('?syncgate=0 defers nothing even with the extension (three links in place, as upstream)', off.d.deferred === 0 && off.totals.deferred === 0, `deferred +${off.d.deferred}, total ${off.totals.deferred}`);
  check('?syncgate=0: the object draws on its first frame', off.drawnAt !== null && off.drawnAt <= 2, `drawn at frame ${off.drawnAt}`);
} catch (e) { fatal = e; check('probe ran to completion', false, String(e).slice(0, 300)); }
finally {
  await browser.close();
  await world.close();
}
done();
