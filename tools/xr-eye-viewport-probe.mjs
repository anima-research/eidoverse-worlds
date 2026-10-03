// #32 split vision, reproduced in REAL three (r186, WebGL backend) in real Chromium, no headset.
//
// XR's configuration is rebuilt exactly where it matters: the XR layer is the renderer's OUTPUT render
// target (XRManager: setOutputRenderTarget(xrRenderTarget)), so three sizes its tone-mapping target at the
// layer's full size and ignores the pixel ratio — while the WebGL backend scales each EYE'S VIEWPORT by
// renderer.getPixelRatio(). Two eyes, told apart by where they look: the left eye sees RED, the right eye GREEN.
// The pixel at 0.9·W sits inside the LEFT eye's half; it must be red.
//
//   control   ratio 1                           → left half red, right half green
//   bug       setPixelRatio(0.75) mid-session   → the right eye starts at 0.75·W: GREEN in the left eye
//   guarded   same call through xrpixelratio.js → deferred, the eyes stay put: red
//
// Run: node tools/xr-eye-viewport-probe.mjs   (~10 s; run it under a memory guard)
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('../client/', import.meta.url).pathname;
const W = 160, H = 80;   // per-eye size in the output target (2W × H), like an XR layer
const TYPES = { '.js': 'text/javascript', '.html': 'text/html' };
const PAGE = `<!doctype html><html><body><script type="importmap">{"imports":{"three":"./node_modules/three/build/three.webgpu.js","three/webgpu":"./node_modules/three/build/three.webgpu.js","three/tsl":"./node_modules/three/build/three.tsl.js"}}</script>
<script type="module">
import * as THREE from 'three';
import { guardPixelRatioInXR } from './lib/xrpixelratio.js';
const W = ${W}, H = ${H};
async function run(mode) {
  const canvas = document.createElement('canvas'); document.body.appendChild(canvas);
  const renderer = new THREE.WebGPURenderer({ canvas, forceWebGL: true, antialias: false });
  renderer.setSize(2 * W, H); renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
  await renderer.init();
  const guard = mode === 'guarded' ? guardPixelRatioInXR(renderer) : null;
  const out = new THREE.RenderTarget(2 * W, H, { depthBuffer: true });
  renderer.setOutputRenderTarget(out);                       // what XRManager does with the XR layer
  const scene = new THREE.Scene();
  // eyes told apart by WHERE THEY LOOK (per-sub-camera layers are not honoured per eye here — first run):
  // the left eye faces a red wall at −z, the right eye is turned 180° to face a green wall at +z
  const plane = (hex, z) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), new THREE.MeshBasicNodeMaterial({ color: hex, side: THREE.DoubleSide }));
    m.frustumCulled = false; m.position.z = z; scene.add(m); };
  plane(0xff0000, -1); plane(0x00ff00, 1);
  const eye = (x, yaw) => { const c = new THREE.PerspectiveCamera(60, W / H, 0.1, 10); c.viewport = new THREE.Vector4(x, 0, W, H); c.rotation.y = yaw; c.updateMatrixWorld(); return c; };
  const cam = new THREE.ArrayCamera([eye(0, 0), eye(W, Math.PI)]);
  cam.updateMatrixWorld();
  if (mode !== 'control') {
    // the governor's first shed on a dpr-1 monitor, arriving while the session presents
    renderer.xr.isPresenting = true; renderer.setPixelRatio(0.75); renderer.xr.isPresenting = false;
  }
  const gl = renderer.backend.gl, vps = [], ov = gl.viewport.bind(gl);
  gl.viewport = (x, y, w, h) => { vps.push([x, y, w, h]); ov(x, y, w, h); };
  renderer.render(scene, cam);
  gl.viewport = ov;
  // the two EYE viewports are the ones narrower than the whole target
  const eyes = [...new Map(vps.filter((v) => v[2] < 2 * W).map((v) => [v.join(), v])).values()].sort((a, b) => a[0] - b[0]);
  const px = await renderer.readRenderTargetPixelsAsync(out, 0, 0, 2 * W, H);
  const at = (x) => { const i = (Math.floor(H / 2) * 2 * W + x) * 4; return px[i] > 128 ? 'red' : px[i + 1] > 128 ? 'green' : \`other(\${px[i]},\${px[i+1]},\${px[i+2]})\`; };
  const r = { mode, ratio: renderer.getPixelRatio(), deferred: guard?.deferred ?? null, eyes,
    left10: at(Math.floor(0.1 * W)), left90: at(Math.floor(0.9 * W)), right10: at(Math.floor(1.1 * W)), right60: at(Math.floor(1.6 * W)) };
  renderer.dispose(); canvas.remove();
  return r;
}
window.__probe = (async () => ({ control: await run('control'), bug: await run('bug'), guarded: await run('guarded') }))()
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
  const res = await Promise.race([page.evaluate(() => window.__probe), new Promise((r) => setTimeout(() => r({ error: 'probe timed out (40 s)' }), 40000))]);
  console.log(JSON.stringify(res, null, 1));
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
  let pass = 0, fail = 0;
  const check = (n, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${n}`); } else { fail++; console.log(`  FAIL  ${n}${note ? `  -- ${note}` : ''}`); } };
  if (res.error) check('probe ran', false, res.error);
  else {
    const { control: c, bug: b, guarded: g } = res;
    // Colour can't tell the eyes apart outside a real XR frame (this build draws both sub-cameras with one view —
    // first two runs), so the evidence is the EYE VIEWPORTS themselves plus coverage of the target.
    const x = (e, i) => e.eyes[i]?.[0], w = (e, i) => e.eyes[i]?.[2];
    check('control: eyes at x=0 and x=W, each W wide; target fully covered', c.eyes.length === 2 && x(c, 0) === 0 && x(c, 1) === W && w(c, 0) === W && w(c, 1) === W && c.right60 !== 'other(0,0,0)', JSON.stringify(c.eyes));
    check('BUG REPRODUCED: at ratio 0.75 the right eye starts at 0.75·W — inside the LEFT eye\'s half', x(b, 1) === Math.floor(0.75 * W) && w(b, 1) === Math.floor(0.75 * W), JSON.stringify(b.eyes));
    check('…and the target\'s right edge is never drawn (the right eye ends at 1.5·W)', b.right60 === 'other(0,0,0)', b.right60);
    check('guarded: the mid-session ratio is deferred, the renderer keeps 1', g.ratio === 1 && g.deferred === 0.75, JSON.stringify(g));
    check('guarded: eyes back at x=0 and x=W, each W wide; target fully covered', g.eyes.length === 2 && x(g, 0) === 0 && x(g, 1) === W && w(g, 1) === W && g.right60 !== 'other(0,0,0)', JSON.stringify(g.eyes));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  code = fail ? 1 : 0;
} finally { await browser.close(); }
process.exit(code);
