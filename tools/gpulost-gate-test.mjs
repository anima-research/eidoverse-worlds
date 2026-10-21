// The lost-GPU gates in client/lib/render.js, without a GPU: once gpulost.js has handled a loss
// (globalThis.__gpuLost.fired), renderer.render, renderer.compileAsync and renderWorld() must reach nothing
// underneath. Drives the REAL module against a counting renderer, so no backend has to prove it is alive (#228
// review, round 2: a browser control that relies on a lost WebGL backend is not portable). Each gate is checked
// flag down → entered, flag up → not entered, flag down again → entered (the gate reads the flag, it doesn't latch).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/gpulost-gate-test.mjs   (bun, not node: the stubs load through a bun plugin)
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
import { plugin } from 'bun';
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({ name: 'core-stub', setup(build) {
  build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
} });

const { renderer, scene, camera } = await import('./core-stub.mjs');
// installed BEFORE render.js imports: render.js binds renderer.render / compileAsync at module scope
const n = { render: 0, compile: 0, target: 0 };
const stubRender = () => { n.render++; }, stubCompile = async () => { n.compile++; };
renderer.render = stubRender; renderer.compileAsync = stubCompile;
renderer.getRenderTarget = () => { n.target++; return null; };
const { renderWorld } = await import('../client/lib/render.js');
renderer.domElement = { toDataURL: () => { n.read++; return 'data:image/png;base64,' + 'A'.repeat(4000); } }; n.read = 0;
const { captureFrame } = await import('../client/lib/capture.js');

let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };
const zero = () => { for (const k in n) n[k] = 0; };
const legs = {
  'renderer.render': async () => { renderer.render(scene, camera); return n.render; },
  'renderer.compileAsync': async () => { await renderer.compileAsync(scene, camera, scene); return n.compile; },
  'renderWorld()': async () => { renderWorld(); return n.render + n.target; },
};
check('render.js wrapped both methods (the test drives the shipping wrappers)',
  renderer.render !== stubRender && renderer.compileAsync !== stubCompile);

// a snapshot after a handled loss refuses rather than reading the stale canvas (round 3)
console.log('CAPTUREFRAME()');
globalThis.__gpuLost = { fired: false }; zero(); n.read = 0;
check('flag down: captureFrame renders and reads the canvas', typeof captureFrame() === 'string' && n.read === 1 && n.render > 0);
globalThis.__gpuLost = { fired: true }; zero(); n.read = 0;
{ let threw = null; try { captureFrame(); } catch (e) { threw = e; }
  check('flag up: captureFrame throws (GPU lost) and never reads the canvas', /GPU lost/.test(String(threw?.message)) && n.read === 0 && n.render === 0, `read ${n.read} render ${n.render} err ${threw?.message}`); }

for (const [name, leg] of Object.entries(legs)) {
  console.log(name.toUpperCase());
  globalThis.__gpuLost = { fired: false }; zero();
  const down = await leg();
  check(`flag down: ${name} reaches the renderer`, down > 0, `entries ${down}`);
  globalThis.__gpuLost = { fired: true }; zero();
  const up = await leg();
  check(`loss handled: ${name} reaches nothing`, up === 0, `entries ${up}`);
  globalThis.__gpuLost = { fired: false }; zero();
  const again = await leg();
  check(`flag down again: ${name} reaches the renderer again`, again > 0, `entries ${again}`);
}
delete globalThis.__gpuLost;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
