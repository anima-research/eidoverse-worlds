// client/lib/xrpass.js: stereo cameras are routed to their own chain map ('xr', 'xr:backSide'), exactly once even
// when three's own rebuild re-enters get() with the prefixed id; mono cameras and zero-eye array cameras are not.
// tools/xr-switch-compile-probe.mjs is the real-three half (both variants live side by side; the switch builds nothing).
import * as THREE from '../client/node_modules/three/build/three.webgpu.js';
import { separateXRPass, withXREyes } from '../client/lib/xrpass.js';
let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };
class FakeObjects { constructor() { this.seen = []; } get(o, m, s, cam, l, rc, cc, passId) { this.seen.push(passId); if (o === 'rebuild' && this.seen.length === 1) return this.get('again', m, s, cam, l, rc, cc, passId); return passId; } }
console.log('XR PASS SPLIT');
const objs = new FakeObjects(), r = { _objects: objs };
check('installs', separateXRPass(r) === true);
check('installs once; no renderer / no _objects → false', separateXRPass(r) === false && separateXRPass(null) === false && separateXRPass({}) === false);
const mono = new THREE.PerspectiveCamera(), empty = new THREE.ArrayCamera(), stereo = new THREE.ArrayCamera([new THREE.PerspectiveCamera(), new THREE.PerspectiveCamera()]);
check('mono camera: passId untouched', objs.get(1, 1, 1, mono, 1, 1, 1, undefined) === undefined && objs.get(1, 1, 1, mono, 1, 1, 1, 'backSide') === 'backSide');
check('zero-eye ArrayCamera: untouched (it renders the mono shader)', objs.get(1, 1, 1, empty, 1, 1, 1, null) === null);
check('stereo: default pass → "xr"', objs.get(1, 1, 1, stereo, 1, 1, 1, null) === 'xr');
check('stereo: backSide → "xr:backSide"', objs.get(1, 1, 1, stereo, 1, 1, 1, 'backSide') === 'xr:backSide');
objs.seen.length = 0; objs.get('rebuild', 1, 1, stereo, 1, 1, 1, null);
check("three's re-entrant rebuild keeps ONE prefix", objs.seen.join() === 'xr,xr', objs.seen.join());
// withXREyes: the warm goes through three's OWN camera and its persistent eyes (never a look-alike), for the whole
// async duration, and three's camera is handed back as it was found. The pixel half: tools/xr-eye-binding-probe.mjs.
const eyeL = new THREE.PerspectiveCamera(), eyeR = new THREE.PerspectiveCamera(), xrCam = new THREE.ArrayCamera();
const fakeXR = { renderer: { xr: { isPresenting: false, getCamera: () => xrCam, _cameras: [eyeL, eyeR] } } };
let seen = null;
await withXREyes(fakeXR.renderer, async (cam) => { await null; seen = { same: cam === xrCam, eyes: cam.cameras.slice() }; });
check('withXREyes: warms through three\'s own camera with its persistent eyes, held across an await', seen.same && seen.eyes[0] === eyeL && seen.eyes[1] === eyeR && seen.eyes.length === 2);
check('withXREyes: hands the camera back with zero eyes (as before a session)', xrCam.cameras.length === 0);
{ fakeXR.renderer.xr.isPresenting = true; await withXREyes(fakeXR.renderer, async () => { xrCam.cameras.length = 0; xrCam.cameras.push(eyeL, eyeR); });   // as XRManager refills them
  check('withXREyes: a session that started meanwhile keeps its eyes', xrCam.cameras.length === 2); fakeXR.renderer.xr.isPresenting = false; }
{ let n = null; await withXREyes(fakeXR.renderer, async (cam) => { n = cam.cameras.length; }); check('withXREyes: eyes already there (in session) → used as they are, not doubled', n === 2 && xrCam.cameras.length === 2); xrCam.cameras.length = 0; }
// OVERLAP (review round 1): two warms in flight at once — the second starts while the first holds the eyes, the first
// finishes first. The second's LATER, still-pending work must still see both eyes (it compiles after its awaits).
{ xrCam.cameras.length = 0;
  let releaseA, releaseB; const gateA = new Promise((r) => { releaseA = r; }), gateB = new Promise((r) => { releaseB = r; });
  let bLate = null;
  const a = withXREyes(fakeXR.renderer, async () => { await gateA; });
  const b = withXREyes(fakeXR.renderer, async (cam) => { await gateB; bLate = cam.cameras.length; });
  releaseA(); await a;
  const afterA = xrCam.cameras.length;
  releaseB(); await b;
  check('withXREyes: overlapping warms — the first to finish does NOT take the eyes from the one still running', afterA === 2 && bLate === 2, { afterA, bLate });
  check('withXREyes: …and the last one out hands the camera back with zero eyes', xrCam.cameras.length === 0, xrCam.cameras.length); }
{ let err = null; try { await withXREyes({ xr: { getCamera: () => xrCam, _cameras: [] } }, async () => {}); } catch (e) { err = e; } check('withXREyes: a three without the persistent eyes FAILS LOUDLY (no silent look-alike)', /persistent eyes/.test(err?.message ?? ''), String(err)); }
{ let err = null; try { await withXREyes(fakeXR.renderer, async () => { throw new Error('boom'); }); } catch (e) { err = e; } check('withXREyes: a throwing warm still hands the camera back and propagates', err?.message === 'boom' && xrCam.cameras.length === 0); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
