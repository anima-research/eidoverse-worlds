// Content that loads in ONE mode must not compile when you switch to the OTHER (client/lib/xrwarm.js; the pattern
// is BasisVR's warm-at-load — see that file's header). REAL three r186, WebGL backend, MSAA on like the client.
//
// Presenting is simulated the way three sees it: the output render target is set (XRManager does that), the XR
// ArrayCamera holds two eyes, xr.enabled and xr.isPresenting are true and cameraAutoUpdate is off (xr.js turns it off too). So a
// content warm with the main camera goes through three's own XR-camera swap, exactly as in a session.
//
//   boot      scene A, desktop frames; the stand-in pre-warm builds A's XR variants (the fixed warmXRPipelines)
//   load B    on the desktop: a content warm (as assets.js does), then desktop frames
//   enter     XR frames      → 'plain' compiles B's XR variants here; 'dual' warmed them at load
//   load C    in VR: a content warm, then XR frames
//   exit      desktop frames → 'plain' compiles C's desktop variants here; 'dual' warmed them at load
//
// Render-object births are counted per pass / camera / render context, which is what exposed three's post-frame
// target leak (xrwarm.js: an in-VR compileAsync built into a context the headset's frames never use).
//
// Run: node tools/xr-dual-warm-probe.mjs   (~40 s; run it under a memory guard)
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('../client/', import.meta.url).pathname;
const N = 30, M = 20;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html' };
const PAGE = `<!doctype html><html><body><script type="importmap">{"imports":{"three":"./node_modules/three/build/three.webgpu.js","three/webgpu":"./node_modules/three/build/three.webgpu.js","three/tsl":"./node_modules/three/build/three.tsl.js"}}</script>
<script type="module">
import * as THREE from 'three';
import { vec3 } from 'three/tsl';
import { separateXRPass, withXREyes } from './lib/xrpass.js';
import { installDualWarm } from './lib/xrwarm.js';
const N = ${N}, M = ${M}, W = 64, H = 32;
async function run(mode) {
  const canvas = document.createElement('canvas'); document.body.appendChild(canvas);
  const renderer = new THREE.WebGPURenderer({ canvas, forceWebGL: true, antialias: true });
  renderer.setSize(2 * W, H); renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
  await renderer.init();
  separateXRPass(renderer);
  const be = renderer.backend, count = { programs: 0, pipelines: 0 };
  for (const [k, f] of [['createProgram', 'programs'], ['createRenderPipeline', 'pipelines']]) { const o = be[k].bind(be); be[k] = (...a) => { count[f]++; return o(...a); }; }
  const scene = new THREE.Scene();
  const desk = new THREE.PerspectiveCamera(60, 2, 0.1, 10); scene.add(desk);
  let vr = false;
  // A GPU links pipelines asynchronously (parallel compile): the compile promise settles frames after its synchronous
  // walk. SwiftShader links inline, so the whole compile settles in one macrotask and no outside observer could see the
  // window. Model the real link: the ORIGINAL compileAsync still walks synchronously; only its settle is deferred.
  if (mode === 'dual') { const orig = renderer.compileAsync.bind(renderer);
    renderer.compileAsync = (...a) => orig(...a).then((v) => new Promise((r) => setTimeout(() => r(v), 40))); }
  if (mode === 'dual') installDualWarm({ THREE, renderer, camera: desk, presenting: () => vr });
  let k = 0;   // distinct shaders across all sets: the constant is inlined into the code
  const set = (n) => { const g = new THREE.Group(); for (let i = 0; i < n; i++, k++) {
    const m = new THREE.MeshBasicNodeMaterial(); m.colorNode = vec3(k / 97, 0.5, 1 - k / 97);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1), m); mesh.position.set((i % 10) * 0.1 - 0.5, Math.floor(i / 10) * 0.1 - 0.2, -2); g.add(mesh); } return g; };
  // three's CLASSIC eye buffer, as XRManager.setSession builds it (the branch xr.js takes)
  const out = new THREE.RenderTarget(2 * W, H, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, colorSpace: renderer.outputColorSpace, stencilBuffer: renderer.stencil });
  const xrCam = renderer.xr.getCamera();   // three's own, with its PERSISTENT eyes (filled at the first XR frame, in present())
  renderer.xr._cameras.forEach((c, i) => { c.viewport = new THREE.Vector4(i * W, 0, W, H); });
  // three swaps in the XR camera only if xr.ENABLED as well (Renderer._updateCamera) — xr.js sets it at session start;
  // without it the first run of this probe rendered every 'VR' frame mono and both controls read vacuously green
  // three itself leaves the eye buffer bound after the first XR frame (the leak xrwarm.js works around); exit unbinds
  // it (xr.js's black-desktop fix)
  const present = (on) => { vr = on; if (on) { renderer.xr.enabled = true; if (xrCam.cameras.length === 0) xrCam.cameras.push(...renderer.xr._cameras); } renderer.setOutputRenderTarget(on ? out : null); if (!on) renderer.setRenderTarget(null); renderer.xr.cameraAutoUpdate = !on; renderer.xr.isPresenting = on; };
  const steps = []; let born = {};
  { const objs = renderer._objects, cro = objs.createRenderObject.bind(objs);
    const seenCtx = new Set(), seenLights = new Set();
    objs.createRenderObject = (...a) => { const pid = a[10] ?? 'default', cam = a[6]; const had = objs.getChainMap(pid).get([a[3], a[4], a[9], a[7]]) !== undefined;
      const why = had ? 'REBUILD' : (!seenCtx.has(a[9]) ? 'newCtx' : (!seenLights.has(a[7]) ? 'newLights' : 'miss')); seenCtx.add(a[9]); seenLights.add(a[7]);
      const id = (m, o) => (m.has(o) ? m.get(o) : (m.set(o, m.size), m.size - 1)); window.__ids ??= { c: new Map(), l: new Map() };
      const key = pid + '/' + (cam?.isArrayCamera ? 'arr' + cam.cameras.length : 'mono') + '/' + why + '/ctx' + id(window.__ids.c, a[9]) + '/L' + id(window.__ids.l, a[7]); born[key] = (born[key] ?? 0) + 1; return cro(...a); }; }
  const measure = async (label, fn) => { const c0 = { ...count }; born = {}; await fn(); steps.push({ label, programs: count.programs - c0.programs, pipelines: count.pipelines - c0.pipelines, born }); };
  const frames = () => { renderer.render(scene, desk); renderer.render(scene, desk); };
  const A = set(N); scene.add(A);
  await measure('boot', async () => frames());
  await measure('pre-warm A (stand-in)', async () => { await withXREyes(renderer, (eyes) => renderer.compileAsync(scene, eyes, scene)); });
  const B = set(M); scene.add(B);
  // Culling off ONLY for the compile's synchronous walk: sampled from OUTSIDE on every macrotask while B's warm (both
  // variants) is in flight, no mesh of B may read frustumCulled=false — else it draws unculled for the whole link.
  let unculledSeen = 0, samples = 0;
  await measure('load B (desktop)', async () => {
    let done = false; const p = renderer.compileAsync(B, desk, scene).finally(() => { done = true; });
    while (!done) { await new Promise((r) => setTimeout(r, 0)); samples++; B.traverse((o) => { if (o.isMesh && !o.frustumCulled) unculledSeen++; }); }
    await p; frames(); });
  await measure('enter', async () => { present(true); frames(); });
  const C = set(M); scene.add(C);
  await measure('load C (in VR)', async () => { await renderer.compileAsync(C, desk, scene); frames(); });
  await measure('exit', async () => { present(false); frames(); });
  await measure('enter again', async () => { present(true); frames(); present(false); frames(); });
  renderer.dispose(); canvas.remove();
  return { mode, steps, unculledSeen, samples };
}
window.__probe = (async () => ({ plain: await run('plain'), dual: await run('dual') }))()
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
  const res = await Promise.race([page.evaluate(() => window.__probe), new Promise((r) => setTimeout(() => r({ error: 'probe timed out (150 s)' }), 150000))]);
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
  let pass = 0, fail = 0;
  const check = (n, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${n}`); } else { fail++; console.log(`  FAIL  ${n}${note ? `  -- ${note}` : ''}`); } };
  if (res.error) check('probe ran', false, res.error);
  else {
    for (const r of [res.plain, res.dual]) { console.log(`\n${r.mode}`); for (const s of r.steps) console.log(`  ${s.label.padEnd(22)} programs+${String(s.programs).padStart(4)}  pipelines+${String(s.pipelines).padStart(4)}  new objects ${JSON.stringify(s.born)}`); }
    console.log('');
    const by = (r) => Object.fromEntries(r.steps.map((s) => [s.label, s]));
    const P = by(res.plain), D = by(res.dual), none = (s) => s.programs === 0 && s.pipelines === 0;
    check(`pre-warm with the stand-in built A's XR variants under MSAA (≥ ${N} pipelines)`, P['pre-warm A (stand-in)'].pipelines >= N, JSON.stringify(P['pre-warm A (stand-in)']));
    check(`plain REPRODUCES: entry compiles what loaded on the desktop (≥ ${M} pipelines)`, P.enter.pipelines >= M, JSON.stringify(P.enter));
    check(`plain REPRODUCES: exit compiles what loaded in VR (≥ ${M} pipelines)`, P.exit.pipelines >= M, JSON.stringify(P.exit));
    check('plain: …and A itself cost nothing at entry beyond B (the pre-warm landed: fewer than M + N)', P.enter.pipelines < M + N, JSON.stringify(P.enter));
    check('dual: entry builds NOTHING — B was warmed in both variants at load', none(D.enter), JSON.stringify(D.enter));
    check('dual: culling is off only for the synchronous walk — never seen off from outside during the link', res.dual.unculledSeen === 0 && res.dual.samples > 1, JSON.stringify({ unculledSeen: res.dual.unculledSeen, samples: res.dual.samples }));
    check('dual: exit builds NOTHING — C was warmed in both variants at load', none(D.exit), JSON.stringify(D.exit));
    check('dual: a further round trip builds nothing', none(D['enter again']), JSON.stringify(D['enter again']));
    // THE LEAK: after an XR frame three leaves the eye buffer bound; compileAsync then compiles into a context the
    // frames never use, and the frames build every object again. Stereo render objects born during the in-VR load:
    const stereoBorn = (st) => Object.entries(st.born).filter(([k]) => k.startsWith('xr/')).reduce((n, [, v]) => n + v, 0);
    check(`plain REPRODUCES the leak: an in-VR warm's stereo objects are rebuilt by the frames (≥ ${2 * M} born)`, stereoBorn(P['load C (in VR)']) >= 2 * M, JSON.stringify(P['load C (in VR)'].born));
    check(`dual: the in-VR warm lands where the frames draw — each stereo object born ONCE (${M})`, stereoBorn(D['load C (in VR)']) === M, JSON.stringify(D['load C (in VR)'].born));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  code = fail ? 1 : 0;
} finally { await browser.close(); }
process.exit(code);
