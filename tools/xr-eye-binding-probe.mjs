// Do the headset's eyes render with THEIR OWN matrices after a pre-warm? (REAL three r186, WebGL backend.)
//
// r186 binds the stereo camera uniforms to ONE module-global array (Camera nodes: `_cameraProjectionMatrixArray.array =
// matrices` inside a .once() Fn, no per-frame refresh) pointed at whichever ArrayCamera's matrix objects built a shader
// last. three's own XR camera reuses two persistent eye cameras (renderer.xr._cameras, updated in place per frame), so
// stock three never notices. A warm through a LOOK-ALIKE ArrayCamera (our first pre-warm, 0fe2540/43d12fa) rebinds the
// array to the look-alike's matrices, and the session's frames then draw from them: head tracking frozen.
//
// Scene: red wall ahead (−z), green wall behind (+z). The desktop camera looks ahead; the headset's eyes are turned to
// look behind. Correct VR sees GREEN in both eyes.
//   no warm              → green (control)
//   look-alike warm      → RED   (reproduces the bug)
//   withXREyes warm      → green, and entry builds nothing (the warm still works)
//   dual warm at load    → green (xrwarm.js path: a content warm on the desktop, then enter)
//
// Run: node tools/xr-eye-binding-probe.mjs   (~30 s; run it under a memory guard)
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('../client/', import.meta.url).pathname;
const PAGE = `<!doctype html><html><body><script type="importmap">{"imports":{"three":"./node_modules/three/build/three.webgpu.js","three/webgpu":"./node_modules/three/build/three.webgpu.js","three/tsl":"./node_modules/three/build/three.tsl.js"}}</script>
<script type="module">
import * as THREE from 'three';
import { separateXRPass, withXREyes } from './lib/xrpass.js';
import { installDualWarm } from './lib/xrwarm.js';
async function run(mode) {
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGPURenderer({ canvas, forceWebGL: true });
  renderer.setSize(128, 64); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
  await renderer.init(); separateXRPass(renderer);
  let pipelines = 0; const built = []; { const be = renderer.backend, o = be.createRenderPipeline.bind(be); be.createRenderPipeline = (...a) => { pipelines++; built.push(a[0]?.material?.name || a[0]?.material?.type || '?'); return o(...a); }; }
  const scene = new THREE.Scene();
  const wall = (hex, z) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), new THREE.MeshBasicNodeMaterial({ color: hex, side: THREE.DoubleSide })); m.position.z = z; scene.add(m); return m; };
  wall(0xff0000, -2); wall(0x00ff00, 2);
  const desk = new THREE.PerspectiveCamera(60, 2, 0.1, 10); scene.add(desk);
  let vr = false;
  if (mode === 'dual warm at load') installDualWarm({ THREE, renderer, camera: desk, presenting: () => vr });
  renderer.render(scene, desk);
  if (mode === 'look-alike warm') {
    const eye = () => { const c = new THREE.PerspectiveCamera(60, 1, 0.1, 10); c.viewport = new THREE.Vector4(0, 0, 1, 1); return c; };
    await renderer.compileAsync(scene, new THREE.ArrayCamera([eye(), eye()]), scene);
  }
  if (mode === 'withXREyes warm') await withXREyes(renderer, (eyes) => renderer.compileAsync(scene, eyes, scene));
  if (mode === 'dual warm at load') { const m = wall(0x00ff00, 2.5); m.material = new THREE.MeshBasicNodeMaterial({ color: 0x00ff00, side: THREE.DoubleSide, transparent: false }); await renderer.compileAsync(m, desk, scene); }
  const warmedEyes = renderer.xr.getCamera().cameras.length;
  // the session starts: three's own XR camera, its PERSISTENT eyes (as XRManager._onXRFrame fills them), turned to look behind
  const xrCam = renderer.xr.getCamera(), eyes = renderer.xr._cameras;
  // three's eyes have matrixWorldAutoUpdate=false (XRManager writes them): set the world matrices directly, as it does
  eyes.forEach((c, i) => { c.viewport = new THREE.Vector4(i * 64, 0, 64, 64); c.matrix.makeRotationY(Math.PI); c.matrixWorld.copy(c.matrix); c.matrixWorldInverse.copy(c.matrixWorld).invert();
    c.projectionMatrix.makePerspective(-0.05, 0.05, 0.05, -0.05, 0.1, 10); c.projectionMatrixInverse.copy(c.projectionMatrix).invert(); });
  if (xrCam.cameras.length === 0) xrCam.cameras.push(...eyes);
  xrCam.matrixWorld.copy(eyes[0].matrixWorld);
  const out = new THREE.RenderTarget(128, 64, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, colorSpace: renderer.outputColorSpace, stencilBuffer: renderer.stencil });
  vr = true; renderer.xr.enabled = true; renderer.setOutputRenderTarget(out); renderer.xr.cameraAutoUpdate = false; renderer.xr.isPresenting = true;
  const p0 = pipelines, b0 = built.length;
  renderer.render(scene, desk); renderer.render(scene, desk);
  const enterPipelines = pipelines - p0, enterBuilt = built.slice(b0);
  const px = await renderer.readRenderTargetPixelsAsync(out, 0, 0, 128, 64);
  // classify by the DOMINANT channel: ACES turns pure green into (148,228,89) — a 'red > 128' test called it red (first cut)
  const at = (x) => { const i = (32 * 128 + x) * 4; return px[i] > px[i + 1] ? 'RED' : 'green'; };
  renderer.dispose();
  return { mode, leftEye: at(32), rightEye: at(96), enterPipelines, enterBuilt, warmedEyes };
}
// ONE MODE PER PAGE LOAD: the stereo uniform array is MODULE-global, so modes sharing a page contaminate each other
// (the first cut of this probe did exactly that)
window.__probe = run(new URLSearchParams(location.search).get('mode')).catch((e) => ({ error: String(e && e.stack || e) }));
</script></body></html>`;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let code = 1;
try {
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('http://probe.local/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/') return route.fulfill({ body: PAGE, contentType: 'text/html' });
    const f = join(ROOT, path);
    if (!f.startsWith(ROOT) || !existsSync(f)) return route.fulfill({ status: 404, body: 'nope' });
    return route.fulfill({ body: readFileSync(f), contentType: extname(f) === '.html' ? 'text/html' : 'text/javascript' });
  });
  const res = [];
  for (const mode of ['no warm', 'look-alike warm', 'withXREyes warm', 'dual warm at load']) {
    await page.goto('about:blank');
    await page.goto('http://probe.local/?mode=' + encodeURIComponent(mode));
    const r = await Promise.race([page.evaluate(() => window.__probe), new Promise((ok) => setTimeout(() => ok({ error: 'probe timed out (60 s)' }), 60000))]);
    if (r.error) { res.error = r.error; break; }
    res.push(r);
  }
  if (errors.length) console.log('page errors:', errors.slice(0, 4));
  let pass = 0, fail = 0;
  const check = (n, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${n}`); } else { fail++; console.log(`  FAIL  ${n}${note ? `  -- ${note}` : ''}`); } };
  if (res.error) check('probe ran', false, res.error);
  else {
    for (const r of res) console.log(`  ${r.mode.padEnd(18)} eyes see ${r.leftEye}/${r.rightEye}  entry pipelines +${r.enterPipelines} ${JSON.stringify(r.enterBuilt)}  xr camera eyes after warm: ${r.warmedEyes}`);
    const by = Object.fromEntries(res.map((r) => [r.mode, r])), green = (r) => r.leftEye === 'green' && r.rightEye === 'green';
    check('control: with no warm the eyes see what they face (green)', green(by['no warm']), JSON.stringify(by['no warm']));
    check('REPRODUCES: a look-alike warm leaves the eyes drawing from ITS matrices (red)', by['look-alike warm'].leftEye === 'RED' && by['look-alike warm'].rightEye === 'RED', JSON.stringify(by['look-alike warm']));
    check('withXREyes: the eyes see what they face (green)', green(by['withXREyes warm']), JSON.stringify(by['withXREyes warm']));
    // the output pass's quad (outputColorTransform) is drawn into the eye buffer only at entry; no scene warm covers it
    const sceneBuilt = (r) => r.enterBuilt.filter((n) => n !== 'outputColorTransform');
    check('withXREyes: …and the warm still warmed (entry builds no SCENE pipelines; only the output quad)', sceneBuilt(by['withXREyes warm']).length === 0 && sceneBuilt(by['no warm']).length > 0, JSON.stringify([by['withXREyes warm'].enterBuilt, by['no warm'].enterBuilt]));
    check('withXREyes: three\'s XR camera is handed back with ZERO eyes (as before a session)', by['withXREyes warm'].warmedEyes === 0, JSON.stringify(by['withXREyes warm']));
    check('dual warm at load (xrwarm.js): the eyes see what they face (green)', green(by['dual warm at load']), JSON.stringify(by['dual warm at load']));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  code = fail ? 1 : 0;
} finally { await browser.close(); }
process.exit(code);
