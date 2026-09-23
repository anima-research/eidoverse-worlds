// The body-first gate AT ITS LOAD BOUNDARY: the real loadGLB (client/lib/assets.js) with a scripted network
// and a recording loadwork stub. Armed and closed, a model's bytes arrive but its PARSE waits in the
// 'body-first' phase until the gate opens; unarmed, no load ever enters that phase. Review 2026-09-10 #1
// asked for the gate "at its actual load boundary" — bodygate-test.mjs covers the contract in isolation,
// this drives the boundary. (The 12 s cap itself is proven in bodygate-test; it is not shortened here.)
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };
import { plugin } from 'bun';
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({ name: 'core-stub', setup(build) {
  build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
} });
// a valid glTF with an empty scene: GLTFLoader.parse takes JSON text in an ArrayBuffer when it is not a GLB
const GLTF = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }));
globalThis.fetch = async (path) => /\.glb/.test(path)
  ? new Response(GLTF, { status: 200, headers: { 'content-length': String(GLTF.byteLength) } })
  : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

const { works } = await import('./loadwork-stub.mjs');
const { armBodyGate, releaseBodyGate } = await import('../client/lib/bodygate.js');
const { loadGLB } = await import('../client/lib/assets.js');
let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };
setTimeout(() => { console.log('  FAIL  a load hung past 8 s\n\nHUNG'); process.exit(1); }, 8000).unref?.();
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const phasesOf = (name) => works.find((w) => w.label === `glb ${name}.glb`)?.phases ?? [];

console.log('LOAD BOUNDARY — gate not armed');
{ const scene = await loadGLB('eidoverse/assets/models/unarmed.glb');
  check('the model loads', !!scene?.isObject3D, String(scene));
  const ph = phasesOf('unarmed');
  check('no body-first phase when nothing is armed', ph.includes('parse') && !ph.includes('body-first'), ph.join('>')); }
console.log('LOAD BOUNDARY — gate armed and closed');
{ armBodyGate();
  const p = loadGLB('eidoverse/assets/models/armed.glb');
  await tick(120);
  const before = phasesOf('armed').slice();
  check('bytes arrived, parse is HELD in body-first', before.includes('body-first') && !before.includes('parse') && !before.includes('queued'), before.join('>'));
  releaseBodyGate('test');
  const scene = await p;
  const after = phasesOf('armed');
  check('release lets the parse proceed and the model resolve', !!scene?.isObject3D && after.indexOf('body-first') < after.indexOf('parse'), after.join('>')); }
console.log('LOAD BOUNDARY — gate open');
{ const scene = await loadGLB('eidoverse/assets/models/open.glb');
  const ph = phasesOf('open');
  check('an open gate is not waited on', !!scene?.isObject3D && !ph.includes('body-first'), ph.join('>')); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
