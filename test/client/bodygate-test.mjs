// The body-first gate (client/lib/bodygate.js): dormant until armed, released once, a capped wait; and the same gate AT
// ITS LOAD BOUNDARY, the real loadGLB (assets.js) with a scripted network and a recording loadwork stub: armed and
// closed, a model's bytes arrive but its PARSE waits in the 'body-first' phase until the gate opens (review 2026-09-10 #1).
// The gate is one-shot module state, so the two halves run as one sequence: unarmed, armed, open.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };
import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
import { tryUntil } from '../gate/wait.ts';
import { suite } from '../gate/suite.ts';
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({ name: 'core-stub', setup(build) {
  stubResolve(build, /^(\.\.?\/)+core\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
  stubResolve(build, /^(\.\.?\/)+base\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
  stubResolve(build, /^(\.\.?\/)+loadwork\.js$/, () => ({ path: here('../stubs/loadwork-stub.mjs') }));
} });
// a valid glTF with an empty scene: GLTFLoader.parse takes JSON text in an ArrayBuffer when it is not a GLB
const GLTF = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }));
globalThis.fetch = async (path) => /\.glb/.test(path)
  ? new Response(GLTF, { status: 200, headers: { 'content-length': String(GLTF.byteLength) } })
  : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

const { works } = await import('../stubs/loadwork-stub.mjs');
const { armBodyGate, bodyGateArmed, releaseBodyGate, bodyGateOpen, awaitBodyGate } = await import('../../client/lib/bodygate.js');
const { loadGLB } = await import('../../client/lib/assets.js');
// a wait that never resolves is the failure this file exists to catch: it must go RED, not hang
setTimeout(() => { console.log('  FAIL  a gate wait or a load hung past 8 s\n\nHUNG'); process.exit(1); }, 8000).unref?.();
const { check, done } = suite('bodygate');
const timed = async (p) => { const t = performance.now(); const v = await p; return { v, ms: performance.now() - t }; };
const phasesOf = (name) => works.find((w) => w.label === `glb ${name}`)?.phases ?? [];   // the label is the model's word (assets.js modelName)

console.log('UNARMED');
check('starts unarmed and closed', !bodyGateArmed() && !bodyGateOpen());
{ const { v, ms } = await timed(awaitBodyGate(5000)); check('unarmed: the wait resolves at once', v === 'unarmed' && ms < 50, `${v} after ${ms.toFixed(0)}ms`); }
{ const scene = await loadGLB('eidoverse/assets/models/unarmed.glb');
  check('the model loads', !!scene?.isObject3D, String(scene));
  const ph = phasesOf('unarmed');
  check('no body-first phase when nothing is armed', ph.includes('parse') && !ph.includes('body-first'), ph.join('>')); }

console.log('ARMED AND CLOSED');
armBodyGate();
check('armBodyGate arms', bodyGateArmed() && !bodyGateOpen());
{ const { v, ms } = await timed(awaitBodyGate(120)); check('armed + stuck: the wait times out at its cap, not before', v === 'timeout' && ms >= 100 && ms < 1000, `${v} after ${ms.toFixed(0)}ms`); }
check('a timed-out wait does not open the gate', !bodyGateOpen());
const held = loadGLB('eidoverse/assets/models/armed.glb');
await tryUntil('the armed load reaches a phase past download', () => phasesOf('armed').some((p) => p !== 'download'), { ms: 4000 });
const before = phasesOf('armed').slice();
check('bytes arrived, parse is HELD in body-first', before.includes('body-first') && !before.includes('parse') && !before.includes('queued'), before.join('>'));
{ const p = timed(awaitBodyGate(5000)); setTimeout(() => releaseBodyGate('test'), 30); const { v, ms } = await p; check('release resolves a pending wait as open', v === 'open' && ms < 1000, `${v} after ${ms.toFixed(0)}ms`); }
{ const scene = await held; const after = phasesOf('armed');
  check('release lets the held parse proceed and the model resolve', !!scene?.isObject3D && after.indexOf('body-first') < after.indexOf('parse'), after.join('>')); }

console.log('OPEN');
check('released once → open', bodyGateOpen());
releaseBodyGate('again'); check('a second release is a no-op', bodyGateOpen());
{ const { v, ms } = await timed(awaitBodyGate(5000)); check('open: later waits resolve at once', v === 'open' && ms < 50, `${v} after ${ms.toFixed(0)}ms`); }
{ const scene = await loadGLB('eidoverse/assets/models/open.glb');
  check('an open gate is not waited on', !!scene?.isObject3D && !phasesOf('open').includes('body-first'), phasesOf('open').join('>')); }

done();
