// VR enter/exit cost (notes: vr-exit-hang-commons.md — "why is entering and leaving VR such a heavy cost?"),
// measured in REAL three (r186, WebGL backend) in real Chromium, no headset.
//
// three keys a render object on (object, material, render context, lights) — NOT the camera — but the XR
// stereo ArrayCamera changes its dynamic cache key (`cameras.length`). So at the switch every object is
// disposed and rebuilt IN THE SAME SLOT, the old pipeline loses its last user, and Pipelines._releaseProgram
// deletes the compiled program. MEASURED (first run, 09-23): stock rebuilds the whole DESKTOP variant on the
// first EXIT — the one it threw away at entry (60 materials: 61 programs, 314 ms in SwiftShader); after one round
// trip it settles. So the first exit of every session recompiles every material that existed before entry.
// This probe renders N distinct materials desktop → XR → desktop → XR → desktop and counts programs/pipelines
// built per switch: stock; with client/lib/xrpass.js (stereo in its own pass); and xrpass + a desktop-side
// pre-warm through a two-eye stand-in camera (xr.getCamera() has ZERO eyes before a session — the old warm
// compiled the mono variant under a stereo name).
//
// Run: node tools/xr-switch-compile-probe.mjs   (~30 s; run it under a memory guard)
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('../client/', import.meta.url).pathname;
const N = Number(process.env.N ?? 60);
const TYPES = { '.js': 'text/javascript', '.html': 'text/html' };
const PAGE = `<!doctype html><html><body><script type="importmap">{"imports":{"three":"./node_modules/three/build/three.webgpu.js","three/webgpu":"./node_modules/three/build/three.webgpu.js","three/tsl":"./node_modules/three/build/three.tsl.js"}}</script>
<script type="module">
import * as THREE from 'three';
import { vec3 } from 'three/tsl';
import { separateXRPass, withXREyes } from './lib/xrpass.js';
const N = ${N}, W = 64, H = 32;
async function run(mode) {
  const canvas = document.createElement('canvas'); document.body.appendChild(canvas);
  const renderer = new THREE.WebGPURenderer({ canvas, forceWebGL: true, antialias: false });
  renderer.setSize(2 * W, H); renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
  await renderer.init();
  if (mode !== 'stock') separateXRPass(renderer);
  const be = renderer.backend, count = { programs: 0, pipelines: 0 };
  for (const [k, f] of [['createProgram', 'programs'], ['createRenderPipeline', 'pipelines']]) { const o = be[k].bind(be); be[k] = (...a) => { count[f]++; return o(...a); }; }
  const scene = new THREE.Scene();
  for (let i = 0; i < N; i++) {   // N distinct shaders: the constant is inlined into the code
    const m = new THREE.MeshBasicNodeMaterial(); m.colorNode = vec3(i / N, 0.5, 1 - i / N);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1), m); mesh.position.set((i % 10) * 0.1 - 0.5, Math.floor(i / 10) * 0.1 - 0.3, -2); mesh.frustumCulled = false; scene.add(mesh);
  }
  const desk = new THREE.PerspectiveCamera(60, 2, 0.1, 10);
  // three's own XR camera and its persistent eyes (a look-alike rebinds the stereo uniforms: xr-eye-binding-probe.mjs)
  const xrCam = renderer.xr.getCamera();
  renderer.xr._cameras.forEach((c, i) => { c.viewport = new THREE.Vector4(i * W, 0, W, H); });
  const out = new THREE.RenderTarget(2 * W, H, { depthBuffer: true });
  const steps = [];
  const frame = async (label, xr) => {
    if (xr && xrCam.cameras.length === 0) xrCam.cameras.push(...renderer.xr._cameras);   // three fills them on the first XR frame
    renderer.setOutputRenderTarget(xr ? out : null);   // what XRManager does at session start / end
    const c0 = { ...count }, t0 = performance.now();
    renderer.render(scene, xr ? xrCam : desk);
    renderer.render(scene, xr ? xrCam : desk);           // a second frame: settles, must cost nothing new
    const tr = performance.now();
    const px = xr ? await renderer.readRenderTargetPixelsAsync(out, 0, 0, 1, 1) : null;   // GPU sync: charged separately
    steps.push({ label, programs: count.programs - c0.programs, pipelines: count.pipelines - c0.pipelines, ms: Math.round(tr - t0), readMs: Math.round(performance.now() - tr) });
  };
  await frame('desktop (boot)', false);
  if (mode === 'prewarmed') {
    const c0 = { ...count }, t0 = performance.now();
    await withXREyes(renderer, (eyes) => renderer.compileAsync(scene, eyes, scene));   // on the desktop, before any session
    steps.push({ label: 'prewarm (async)', programs: count.programs - c0.programs, pipelines: count.pipelines - c0.pipelines, ms: Math.round(performance.now() - t0) });
    await frame('desktop again', false);
  }
  await frame('enter 1', true);
  await frame('exit 1', false);
  await frame('enter 2', true);
  await frame('exit 2', false);
  const r = { mode, steps };
  renderer.dispose(); canvas.remove();
  return r;
}
window.__probe = (async () => ({ stock: await run('stock'), split: await run('split'), prewarmed: await run('prewarmed') }))()
  .catch((e) => ({ error: String(e && e.stack || e) }));
</script></body></html>`;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let code = 1;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('http://probe.local/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/') return route.fulfill({ body: PAGE, contentType: 'text/html' });
    const f = join(ROOT, path);
    if (!f.startsWith(ROOT) || !existsSync(f)) return route.fulfill({ status: 404, body: 'nope' });
    return route.fulfill({ body: readFileSync(f), contentType: TYPES[extname(f)] ?? 'application/octet-stream' });
  });
  await page.goto('http://probe.local/');
  const res = await Promise.race([page.evaluate(() => window.__probe), new Promise((r) => setTimeout(() => r({ error: 'probe timed out (120 s)' }), 120000))]);
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
  let pass = 0, fail = 0;
  const check = (n, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${n}`); } else { fail++; console.log(`  FAIL  ${n}${note ? `  -- ${note}` : ''}`); } };
  if (res.error) check('probe ran', false, res.error);
  else {
    for (const r of [res.stock, res.split, res.prewarmed]) {
      console.log(`\n${r.mode}`);
      for (const st of r.steps) console.log(`  ${st.label.padEnd(16)} programs+${String(st.programs).padStart(4)}  pipelines+${String(st.pipelines).padStart(4)}  render ${st.ms} ms${st.readMs ? ` (+ readback ${st.readMs} ms)` : ''}`);
    }
    console.log('');
    const by = (r) => Object.fromEntries(r.steps.map((st) => [st.label, st]));
    const S = by(res.stock), X = by(res.split), P = by(res.prewarmed);
    const none = (st) => st && st.programs === 0 && st.pipelines === 0;
    check(`stock: boot builds the desktop variants (≥ ${N} pipelines)`, S['desktop (boot)'].pipelines >= N, JSON.stringify(S['desktop (boot)']));
    check('stock REPRODUCES: the first exit rebuilds the discarded desktop variant (≥ N pipelines)', S['exit 1'].pipelines >= N, JSON.stringify(S['exit 1']));
    check('split: the first entry builds the XR variants (nothing warmed them)', X['enter 1'].pipelines >= N, JSON.stringify(X['enter 1']));
    check('split: exit 1, enter 2, exit 2 build NOTHING — both variants live side by side', ['exit 1', 'enter 2', 'exit 2'].every((l) => none(X[l])), JSON.stringify(res.split.steps));
    check('prewarmed: the stand-in warm built the XR variants (≥ N pipelines) — a zero-eye camera would build none', P['prewarm (async)'].pipelines >= N, JSON.stringify(P['prewarm (async)']));
    check('prewarmed: …and the desktop frame after it rebuilt nothing (the warm did not evict desktop)', none(P['desktop again']), JSON.stringify(P['desktop again']));
    check('prewarmed: EVERY switch builds nothing, the first entry included', ['enter 1', 'exit 1', 'enter 2', 'exit 2'].every((l) => none(P[l])), JSON.stringify(res.prewarmed.steps));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  code = fail ? 1 : 0;
} finally { await browser.close(); }
process.exit(code);
