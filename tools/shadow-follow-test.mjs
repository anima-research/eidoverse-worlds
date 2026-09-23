// The sun shadow's follow box and the caster budget (client/lib/lightrig.js) must rank from the camera's
// WORLD position: in VR the camera is a child of the rig, and camera.position is only the head's offset
// inside it — the box sat at the origin while R stood 50 m away (09-07 22:28). Review 2026-09-10 #1 regressed
// both to camera.position and the suite stayed green; this parents the real camera and measures.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };
import { plugin } from 'bun';
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({ name: 'core-stub', setup(build) {
  build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/assets\.js$/ }, () => ({ path: here('./assets-stub.mjs') }));
  build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
} });
const { THREE, camera, sun } = await import('./core-stub.mjs');
const { updateRig, registerCaster, setCasterBudget, rigDebug } = await import('../client/lib/lightrig.js');

let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

// the rig: where you STAND; the camera: your head's offset inside it (xr.js)
sun.position.set(14, 22, 10);
const rig = new THREE.Group(); rig.position.set(50, 0, 60); rig.add(camera);
camera.position.set(0, 1.6, 0); rig.updateMatrixWorld(true);
const world = camera.getWorldPosition(new THREE.Vector3());

// expected extents, from the WORLD position expressed in the light's view frame (the module's own math)
const HALF = 46, DEPTH = 90;
const basis = new THREE.Matrix4().lookAt(sun.position, new THREE.Vector3(), THREE.Object3D.DEFAULT_UP);
const sx = new THREE.Vector3(), sy = new THREE.Vector3(), sz = new THREE.Vector3(); basis.extractBasis(sx, sy, sz);
const expect = (pos) => { const rel = pos.clone().sub(sun.position); const texel = (2 * HALF) / sun.shadow.mapSize.x; const fx = Math.round(rel.dot(sx) / texel) * texel, fy = Math.round(rel.dot(sy) / texel) * texel; const dist = -rel.dot(sz); return { left: fx - HALF, right: fx + HALF, top: fy + HALF, bottom: fy - HALF, near: dist - DEPTH, far: dist + DEPTH }; };

console.log('SHADOW FOLLOW — camera parented to a rig 78 m from the origin');
const cam = sun.shadow.camera;
const matrixBefore = cam.projectionMatrix.elements.slice();
updateRig(1000);
{ const e = expect(world);
  check('box centred on the WORLD position (left/right)', near(cam.left, e.left) && near(cam.right, e.right), `got ${cam.left.toFixed(2)}..${cam.right.toFixed(2)} want ${e.left.toFixed(2)}..${e.right.toFixed(2)}`);
  check('box centred on the WORLD position (top/bottom)', near(cam.top, e.top) && near(cam.bottom, e.bottom), `got ${cam.bottom.toFixed(2)}..${cam.top.toFixed(2)} want ${e.bottom.toFixed(2)}..${e.top.toFixed(2)}`);
  check('near/far bracket the world focus (near may be negative — ortho)', near(cam.near, e.near) && near(cam.far, e.far), `got ${cam.near.toFixed(2)}..${cam.far.toFixed(2)} want ${e.near.toFixed(2)}..${e.far.toFixed(2)}`);
  const local = expect(camera.position);
  check('…and NOT on the local head offset', !near(cam.left, local.left, 1) || !near(cam.top, local.top, 1), 'world and local extents coincide — the test cannot tell them apart');
  const want = new THREE.OrthographicCamera(cam.left, cam.right, cam.top, cam.bottom, cam.near, cam.far).projectionMatrix.elements;
  check('the projection matrix was rebuilt FROM the new extents', cam.projectionMatrix.elements.some((v, i) => Math.abs(v - matrixBefore[i]) > 1e-6) && cam.projectionMatrix.elements.every((v, i) => Math.abs(v - want[i]) < 1e-6)); }
console.log('SHADOW FOLLOW — the rig walks 30 m');
{ rig.position.x += 30; rig.updateMatrixWorld(true); updateRig(2000);
  const e = expect(camera.getWorldPosition(new THREE.Vector3()));
  check('the box follows the rig', near(cam.left, e.left) && near(cam.top, e.top), `got ${cam.left.toFixed(2)} want ${e.left.toFixed(2)}`); }

console.log('CASTER BUDGET — ranked by WORLD distance');
{ const mk = (id, x, y, z) => { const o = new THREE.Group(); o.position.set(x, y, z); o.add(new THREE.Mesh(new THREE.BoxGeometry())); o.updateMatrixWorld(true); registerCaster(id, o); return o; };
  const wp = camera.getWorldPosition(new THREE.Vector3());
  mk('near-local-far-world', 1, 1.6, 0);                 // 2 m from camera.position, ~100 m from where you stand
  mk('near-world', wp.x + 2, 0, wp.z);                  // 2 m from where you stand
  setCasterBudget(1);
  updateRig(3000);                                       // > 300 ms since the last caster pass
  const list = Object.fromEntries(rigDebug().casterList.map((c) => [c.id, c]));
  check('only the caster nearest in WORLD space is asked to warm', list['near-world']?.warm !== 'none' && list['near-local-far-world']?.warm === 'none', JSON.stringify(list));
  // a caster PARENTED under a moved group: its local position is near the origin, its world position is by the rig
  const parent = new THREE.Group(); parent.position.set(wp.x, 0, wp.z + 3); parent.updateMatrixWorld(true);
  const child = new THREE.Group(); child.position.set(0, 0, 0); child.add(new THREE.Mesh(new THREE.BoxGeometry())); parent.add(child); parent.updateMatrixWorld(true);
  registerCaster('parented-near-world', child);
  mk('unparented-far', 0, 0, 0);                        // at the origin: near in LOCAL terms to the parented one, ~80 m from the rig
  setCasterBudget(2);
  updateRig(3400);
  const l2 = Object.fromEntries(rigDebug().casterList.map((c) => [c.id, c]));
  check('a caster under a moved parent ranks by its WORLD position', l2['parented-near-world']?.warm !== 'none' && l2['unparented-far']?.warm === 'none', JSON.stringify(l2)); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
