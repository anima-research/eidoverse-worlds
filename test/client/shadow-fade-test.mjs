// lightrig.js's shadows, three sequences, one suite: casters FADE in and out of the budget (R 10-11); the follow box,
// the caster budget and the light slots rank from the camera's WORLD position (VR parents the camera to the rig); the
// resident's shadow switch and the lamp's casting slot agree. lightrig reads the shadow preference AT IMPORT, so those
// boot cases each run as a child (`--case <name>`); `--mutants` runs the child mutation controls, each must go red.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
import { suite } from "../gate/suite.ts";
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
const ARGV = process.argv.slice(2);
const argOf = (f) => { const i = ARGV.indexOf(f); return i < 0 ? null : ARGV[i + 1]; };
const CASE = argOf('--case');
const MUTATE = argOf('--mutate');

// ---- the child: one shadow-preference boot state, measured ----
if (CASE) {
  plugin({ name: 'core-stub', setup(build) {
    stubResolve(build, /^(\.\.?\/)+core\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
    stubResolve(build, /^(\.\.?\/)+base\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
    stubResolve(build, /^(\.\.?\/)+(render\/)?loadwork\.js$/, () => ({ path: here('../stubs/loadwork-stub.mjs') }));
  } });

  // the preference, set BEFORE the import that reads it
  if (CASE === 'boot-off') localStorage.setItem('ew-shadows', 'off');
  else localStorage.removeItem('ew-shadows');   // absent = on (the default)
  if (CASE === 'res') localStorage.setItem('ew-shadow-res', '4096');   // the module-init path reads it (a TDZ there takes the client down)
  else localStorage.removeItem('ew-shadow-res');

  const { renderer, sun } = await import('../stubs/core-stub.mjs');
  const rig = await import('../../client/lib/render/lightrig.js');

  // The mutation controls reproduce the state a reverted source line left
  // behind. #1 cannot be re-run at import (the slot is already born), so it is
  // written onto the live slot. A module namespace is read-only, so #2 wraps a
  // local alias rather than patching `rig.setShadows` in place.
  const lamp = () => rig.rigDebug()._slots[0];
  let setShadows = rig.setShadows;
  let updateRig = rig.updateRig;
  let setLampShadow = rig.setLampShadow;
  // #1/#2 revert the uniform-level switch (applyShadowPref: shadow.intensity + autoUpdate), not castShadow
  if (MUTATE === '1') { lamp().shadow.intensity = 1; lamp().shadow.autoUpdate = true; }   // born casting regardless of the preference
  if (MUTATE === '2') setShadows = (on) => {                  // setShadows forgets the lamp slot
    const { intensity, autoUpdate } = lamp().shadow; rig.setShadows(on); Object.assign(lamp().shadow, { intensity, autoUpdate });
  };
  if (MUTATE === '5') {                                      // bias pinned to a constant, as before
    const real = rig.setLampShadow;
    setLampShadow = (o) => { const r = real(o); lamp().shadow.normalBias = 0.02; return r; };
  }
  if (MUTATE === '4') {                                      // the old claim: FREE slot + unassigned request only
    // The old guard was `!used.has(SHADOW_SLOT) && r.slot < 0`, whose end
    // state from assign #2 onward is: the casting slot is NOT the one that
    // casts for the lamp. Reproduced at the cheapest honest seam -- take the
    // caster flag off slot 0 and put it on a slot the lamp does not hold, so
    // the lamp's own slot does not cast. No test-only export in production.
    const realUpdate = rig.updateRig;
    updateRig = (t) => {
      realUpdate(t);
      const sl = rig.rigDebug()._slots;
      const lampSlot = (rig.rigDebug().requests.find((r) => r.key === 'lamp:body:janus:1') || {}).slot;
      if (lampSlot >= 0) for (let i = 0; i < sl.length; i++) sl[i].castShadow = i !== lampSlot && i === 1;
    };
  }
  if (MUTATE === '3') {                                      // far left at three's default
    lamp().shadow.camera.far = 500;
    const cam = lamp().shadow.camera;
    Object.defineProperty(cam, 'far', { get: () => 500, set: () => {}, configurable: true });
  }

  const out = (o) => console.log(`__RESULT__${JSON.stringify(o)}`);
  // `slotIsCaster`, not a per-request row: the boot/flip cases make no lamp
  // request, so what is under test is the casting SLOT's own wiring following
  // the resident's switch. (The contend case below is the one that asks the
  // other question -- whether the lamp actually HOLDS that slot.)
  const snap = () => { const d = rig.rigDebug(); return { pref: d.shadows.pref, map: renderer.shadowMap.enabled, sun: d.shadows.sunCasting, lamp: d.shadows.slotIsCaster, shapeOn: renderer.shadowMap.enabled && sun.castShadow }; };   // sun/lamp = EFFECTIVE casting: the switch is uniform-level since 09-27

  if (CASE === 'boot-on' || CASE === 'boot-off') { out({ boot: snap() }); }
  if (CASE === 'res') {   // Video › shadow resolution governs every caster: the sun takes n, the lamp slot scales from its tuned 256
    const at = () => ({ sun: sun.shadow.mapSize.x, lamp: rig.lampShadowState()?.map });
    const boot = at(); rig.setShadowRes(1024); const low = at(); rig.setShadowRes(2048);
    out({ boot, low, def: at() });
  }
  if (CASE === 'bias') {
    // A SMALLER MAP SHOWING MORE LIGHT is a bias symptom, not a resolution
    // one: normalBias offsets the lookup along the surface normal, so a bias
    // measured in millimetres is measured in TEXELS by the shader, and the
    // same 0.02 m was 7 texels at 280 and 12.8 at 512. The look must not
    // depend on the map size, so the bias is derived from it.
    const born = rig.lampShadowState();
    const shipped = { map: born.map, texels: born.texels, workDist: born.workDist,
                      forward: born.forward, up: born.up, side: born.side };
    const at = {};
    for (const n of [256, 280, 512, 1024]) {
      setLampShadow({ map: n });
      const st = rig.lampShadowState();
      at[n] = { map: st.map, normalBias: st.normalBias, texelMM: st.texelMM };
    }
    setLampShadow({ map: 280 });
    const retuned = setLampShadow({ texels: 3 });
    out({ born, at, retuned, shipped });
  }
  if (CASE === 'contend') {
    // THE WORLD LOADS BEFORE YOUR BODY DOES. A placed orb / emissive model
    // realizes first and takes slot 0; then the avatar's lamp arrives wanting
    // shadows. The lamp must END UP on the casting slot, and the incumbent
    // must keep its light.
    rig.requestLight('orb:world:1', { authored: true, intensity: 10, range: 8, pos: [0, 1, 0] });
    updateRig(1000);
    const before = rig.rigDebug();
    rig.requestLight('lamp:body:janus:1', { keep: true, intensity: 8, range: 10, shadows: true, pos: [0, 1, 0] });
    // several passes: the original bug was invisible on the FIRST assign and
    // permanent from the second, so a one-pass test would have missed it
    for (const t of [2000, 3000, 4000, 9000, 20000]) updateRig(t);
    const d = rig.rigDebug();
    const slotOf = (k) => (d.requests.find((r) => r.key === k) || {}).slot;
    out({
      orbFirstSlot: (before.requests.find((r) => r.key === 'orb:world:1') || {}).slot,
      lampSlot: slotOf('lamp:body:janus:1'),
      orbSlot: slotOf('orb:world:1'),
      castingSlot: d.shadows.castingSlot,
      anyCasting: d.shadows.anyCasting,
      lampRow: d.shadows.wantsShadows.find((w) => w.key === 'lamp:body:janus:1') || null,
      slotState: d.slotState,
      distinct: new Set(d.requests.filter((r) => r.slot >= 0).map((r) => r.slot)).size,
      assignedCount: d.requests.filter((r) => r.slot >= 0).length,
    });
  }
  if (CASE === 'far') {
    // The lamp's shadow camera must be BOUNDED at body scale. A PointLight
    // defaults to 0.5/500; near alone was set to 0.03, which made the ratio
    // WORSE than the default pair (16,667:1 vs 1000:1) and quantised every
    // shadow at 0.6 m to nothing.
    const born = { near: lamp().shadow.camera.near, far: lamp().shadow.camera.far };
    // a lamp request with a tight range must pull `far` down to match, since
    // pl.distance is rewritten from the winning request every frame
    rig.requestLight('lamp:test', { keep: true, intensity: 8, range: 3, shadows: true });
    rig.updateRig(1000);
    const tight = { far: lamp().shadow.camera.far, distance: lamp().distance };
    // ...and a wide one must push it back up
    rig.requestLight('lamp:test', { keep: true, intensity: 8, range: 9, shadows: true });
    rig.updateRig(2000);
    const wide = { far: lamp().shadow.camera.far, distance: lamp().distance };
    out({ born, tight, wide });
  }
  if (CASE === 'flip') {
    const boot = snap();
    setShadows(false); const off = snap();
    setShadows(true); const on = snap();
    out({ boot, off, on });
  }
  process.exit(0);
}

// ---- the parent ----
plugin({ name: 'core-stub', setup(build) {
  stubResolve(build, /^(\.\.?\/)+core\.js$/, () => ({ path: here('../stubs/shadow-fade-core-stub.mjs') }));
  stubResolve(build, /^(\.\.?\/)+base\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
  stubResolve(build, /^(\.\.?\/)+state\.js$/, () => ({ path: here('../stubs/state-stub.mjs') }));
  stubResolve(build, /^(\.\.?\/)+(render\/)?warmqueue\.js$/, () => ({ path: here('../stubs/lod-client-stub.mjs') }));   // warmDepth resolves at once
} });
const S = suite("shadow-fade");
const check = (name, ok, note) => S.check(name, ok, note);
const { THREE, camera, sun } = await import('../stubs/core-stub.mjs');
const rig = await import('../../client/lib/render/lightrig.js');
const mats = await import('../../client/lib/render/materials.js');
const { updateRig, registerCaster, setCasterBudget, rigDebug, requestLight, releaseLight, isCasting, setSlotCap } = rig;
const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

if (!ARGV.includes('--mutants')) {
camera.position.set(0, 1.6, 0); camera.updateMatrixWorld(true);
const made = [];
const makeCaster = (id, x, node = true) => {
  const g = new THREE.Group(); g.position.set(x, 0, 0);
  const m = new THREE.Mesh(new THREE.BufferGeometry(), node ? new THREE.NodeMaterial() : new THREE.MeshBasicMaterial());
  m.name = id; g.add(m); g.updateMatrixWorld(true);
  if (node) m.material.userData.shadowFade = true;   // what prepareMaterial marks on a lit node material
  registerCaster(id, g); made.push({ id, m });
  return m;
};
const fadeOf = (id) => rigDebug().casterList.find((c) => c.id === id)?.fade;

console.log('MATERIALS — one mask node, marked');
{ const a = new THREE.NodeMaterial(), b = new THREE.NodeMaterial(); a.roughness = 0.5; a.metalness = 0; b.roughness = 0.5; b.metalness = 0;
  mats.prepareMaterial(a); mats.prepareMaterial(b);
  check('a prepared material gets a maskShadowNode', !!a.maskShadowNode);
  check('two materials share ONE node instance', a.maskShadowNode === b.maskShadowNode, `${a.maskShadowNode?.n} vs ${b.maskShadowNode?.n}`);
  check('the material is marked fadeable', a.userData.shadowFade === true);
  const c = new THREE.NodeMaterial(); c.roughness = 0.5; c.metalness = 0; c.maskNode = { tag: 'own' };
  mats.prepareMaterial(c);
  check('an existing mask is composed, not replaced', c.maskShadowNode !== a.maskShadowNode && c.maskShadowNode?.tag?.endsWith('.and()'), c.maskShadowNode?.tag);
  const basic = new THREE.MeshBasicMaterial(); basic.isNodeMaterial = true; basic.isMeshBasicNodeMaterial = true;
  mats.prepareMaterial(basic);
  check('an unlit material is not marked (hard flip)', basic.userData.shadowFade !== true);
  // realize/material_draft.js clones a prepared material: NodeMaterial.copy carries maskShadowNode AND userData, then prepareMaterial runs again
  const clone = new THREE.NodeMaterial(); clone.roughness = 0.5; clone.metalness = 0; clone.maskShadowNode = a.maskShadowNode; clone.userData = { ...a.userData };
  clone.colorNode = a.colorNode; clone.roughnessNode = a.roughnessNode;
  mats.prepareMaterial(clone);
  check('re-preparing a clone keeps the ONE node (never FADE.and(FADE))', clone.maskShadowNode === a.maskShadowNode, clone.maskShadowNode?.tag);
  check('…and its wrapped colour and roughness are not wrapped again (house I173: wetness and cloud shade twice)', !!a.colorNode && clone.colorNode === a.colorNode && clone.roughnessNode === a.roughnessNode); }

console.log('REGISTER — a mesh handed in casting starts not casting (house I172, #260)');
{ const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()); m.castShadow = true;   // realize/models.js primitives
  g.add(m); g.position.set(500, 0, 0); g.updateMatrixWorld(true); registerCaster('pre-cast', g);
  check('registerCaster leaves its meshes as its record says (casting false)', m.castShadow === false && rigDebug().casterList.find((c) => c.id === 'pre-cast')?.casting === false);
  rig.releaseCaster('pre-cast'); }

console.log('ENABLE — fades in from 0');
let t = 1000;
const nearC = makeCaster('near', 2);
updateRig(t);                      // pass 1: asks the conductor
await settle();
updateRig(t += 301);               // pass 2: warm done → flip at 0
check('castShadow flips true at the start', nearC.castShadow === true);
check('the fade starts at 0', nearC.userData.shadowFade === 0, `got ${nearC.userData.shadowFade}`);
check('the mesh leaves the draw batches while it fades', nearC.userData.noDrawBatch === true);
updateRig(t += 16); updateRig(t += 16);
const mid = nearC.userData.shadowFade;
check('…and climbs per frame', mid > 0 && mid < 1, `got ${mid}`);
for (let i = 0; i < 20; i++) updateRig(t += 16);                       // 320 ms of frames
check(`reaches 1 within ~${rig.FADE_MS} ms`, nearC.userData.shadowFade === 1, `got ${nearC.userData.shadowFade}`);
check('…and rejoins the draw batches', nearC.userData.noDrawBatch === undefined);
check('nothing left fading', rig.fadingCount() === 0);

console.log('SHED — the budget drops: fades out, castShadow holds until 0');
const far = makeCaster('far', 40);
updateRig(t += 301); await settle(); updateRig(t += 301);
for (let i = 0; i < 22; i++) updateRig(t += 16);
check('two cast at budget 2', nearC.castShadow && far.castShadow && far.userData.shadowFade === 1);
setCasterBudget(1);
updateRig(t += 301);
check('shedding does not pop: far still casts', far.castShadow === true && fadeOf('far') === 1, `fade ${fadeOf('far')}`);
check('…but the far one is now fading out', rig.fadingCount() === 1 && rigDebug().casterList.find((c) => c.id === 'far').casting === false);
updateRig(t += 16); updateRig(t += 16);
check('its amount drops per frame', far.userData.shadowFade < 1 && far.userData.shadowFade > 0 && far.castShadow === true, `got ${far.userData.shadowFade}`);

console.log('REVERSE — it comes back in mid-fade');
setCasterBudget(2);
updateRig(t += 301);
const atReverse = far.userData.shadowFade;
updateRig(t += 16); updateRig(t += 16);
check('the fade climbs again from where it was, castShadow never dropped', far.userData.shadowFade > atReverse && far.castShadow === true, `${atReverse} → ${far.userData.shadowFade}`);
for (let i = 0; i < 22; i++) updateRig(t += 16);
check('back to 1', far.userData.shadowFade === 1 && rig.fadingCount() === 0);

console.log('DISABLE — castShadow goes false only when the fade reaches 0');
setCasterBudget(1);
updateRig(t += 301);
let flippedEarly = false;
for (let i = 0; i < 12; i++) { updateRig(t += 16); if (far.userData.shadowFade > 0 && far.castShadow === false) flippedEarly = true; }
check('still casting while the amount is above 0', !flippedEarly && far.castShadow === true, `fade ${far.userData.shadowFade}`);
for (let i = 0; i < 12; i++) updateRig(t += 16);
check('castShadow false once the fade hits 0', far.userData.shadowFade === 0 && far.castShadow === false);
check('near was never touched', nearC.castShadow === true && nearC.userData.shadowFade === 1);

console.log('BUDGET 0 — nothing is kept by hysteresis (the edge was Infinity at 0: the first four stayed forever)');
setCasterBudget(2);
updateRig(t += 301); for (let i = 0; i < 22; i++) updateRig(t += 16);
check('two cast again', nearC.castShadow && far.castShadow && rig.fadingCount() === 0);
setCasterBudget(0);
updateRig(t += 301); for (let i = 0; i < 22; i++) updateRig(t += 16);
check('at budget 0 every caster fades out and stops casting', !nearC.castShadow && !far.castShadow && rig.fadingCount() === 0, JSON.stringify(rigDebug().casterList));

console.log('HARD FLIP — a mesh whose material is not a node material');
setCasterBudget(3);
const plain = makeCaster('plain', 3, false);
updateRig(t += 301); await settle(); updateRig(t += 301);
check('castShadow flips true, no amount written', plain.castShadow === true && plain.userData.shadowFade === undefined);

// the follow rows' clock starts after the fade rows' (lightrig's caster pass runs on elapsed time)
const T0 = t + 1000;
{
const close = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

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
updateRig(T0 + 1000);
{ const e = expect(world);
  check('box centred on the WORLD position (left/right)', close(cam.left, e.left) && close(cam.right, e.right), `got ${cam.left.toFixed(2)}..${cam.right.toFixed(2)} want ${e.left.toFixed(2)}..${e.right.toFixed(2)}`);
  check('box centred on the WORLD position (top/bottom)', close(cam.top, e.top) && close(cam.bottom, e.bottom), `got ${cam.bottom.toFixed(2)}..${cam.top.toFixed(2)} want ${e.bottom.toFixed(2)}..${e.top.toFixed(2)}`);
  check('near/far bracket the world focus (near may be negative — ortho)', close(cam.near, e.near) && close(cam.far, e.far), `got ${cam.near.toFixed(2)}..${cam.far.toFixed(2)} want ${e.near.toFixed(2)}..${e.far.toFixed(2)}`);
  const local = expect(camera.position);
  check('…and NOT on the local head offset', !close(cam.left, local.left, 1) || !close(cam.top, local.top, 1), 'world and local extents coincide — the test cannot tell them apart');
  const want = new THREE.OrthographicCamera(cam.left, cam.right, cam.top, cam.bottom, cam.near, cam.far).projectionMatrix.elements;
  check('the projection matrix was rebuilt FROM the new extents', cam.projectionMatrix.elements.some((v, i) => Math.abs(v - matrixBefore[i]) > 1e-6) && cam.projectionMatrix.elements.every((v, i) => Math.abs(v - want[i]) < 1e-6)); }
console.log('SHADOW FOLLOW — the rig walks 30 m');
{ rig.position.x += 30; rig.updateMatrixWorld(true); updateRig(T0 + 2000);
  const e = expect(camera.getWorldPosition(new THREE.Vector3()));
  check('the box follows the rig', close(cam.left, e.left) && close(cam.top, e.top), `got ${cam.left.toFixed(2)} want ${e.left.toFixed(2)}`); }

console.log('CASTER BUDGET — ranked by WORLD distance');
{ const mk = (id, x, y, z) => { const o = new THREE.Group(); o.position.set(x, y, z); o.add(new THREE.Mesh(new THREE.BoxGeometry())); o.updateMatrixWorld(true); registerCaster(id, o); return o; };
  const wp = camera.getWorldPosition(new THREE.Vector3());
  mk('near-local-far-world', 1, 1.6, 0);                 // 2 m from camera.position, ~100 m from where you stand
  mk('near-world', wp.x + 2, 0, wp.z);                  // 2 m from where you stand
  setCasterBudget(1);
  updateRig(T0 + 3000);                                       // > 300 ms since the last caster pass
  const list = Object.fromEntries(rigDebug().casterList.map((c) => [c.id, c]));
  check('only the caster nearest in WORLD space is asked to warm', list['near-world']?.warm !== 'none' && list['near-local-far-world']?.warm === 'none', JSON.stringify(list));
  // a caster PARENTED under a moved group: its local position is near the origin, its world position is by the rig
  const parent = new THREE.Group(); parent.position.set(wp.x, 0, wp.z + 3); parent.updateMatrixWorld(true);
  const child = new THREE.Group(); child.position.set(0, 0, 0); child.add(new THREE.Mesh(new THREE.BoxGeometry())); parent.add(child); parent.updateMatrixWorld(true);
  registerCaster('parented-near-world', child);
  mk('unparented-far', 0, 0, 0);                        // at the origin: near in LOCAL terms to the parented one, ~80 m from the rig
  setCasterBudget(2);
  updateRig(T0 + 3400);
  const l2 = Object.fromEntries(rigDebug().casterList.map((c) => [c.id, c]));
  check('a caster under a moved parent ranks by its WORLD position', l2['parented-near-world']?.warm !== 'none' && l2['unparented-far']?.warm === 'none', JSON.stringify(l2)); }

console.log('POINT-LIGHT SLOTS — ranked by WORLD distance (review 10a M4)');
{ const wp = camera.getWorldPosition(new THREE.Vector3());
  setSlotCap(1);
  requestLight('lamp-near-local', { pos: [1, 1.6, 0] });                 // 1 m from camera.position, far from where you stand
  requestLight('lamp-near-world', { pos: [wp.x + 2, 1, wp.z] });        // 2 m from where you stand
  updateRig(T0 + 5000);
  check('the one free slot goes to the lamp nearest in WORLD space', isCasting('lamp-near-world') && !isCasting('lamp-near-local'),
    JSON.stringify({ world: isCasting('lamp-near-world'), local: isCasting('lamp-near-local') }));
  // walking re-ranks at once (the rig moves, camera.position doesn't): the > 1.5 m trigger, well inside the 600 ms cadence
  requestLight('lamp-ahead', { pos: [wp.x + 40, 1, wp.z] });            // 40 m ahead: loses to near-world for now
  updateRig(T0 + 5100);
  const before = isCasting('lamp-ahead');
  rig.position.x += 39; rig.updateMatrixWorld(true);
  updateRig(T0 + 5200);                                                      // 100 ms later: only the movement trigger can fire
  check('walking 39 m toward a lamp re-assigns within the 600 ms cadence (the move trigger reads the WORLD position)', !before && isCasting('lamp-ahead'),
    JSON.stringify({ before, after: isCasting('lamp-ahead') }));
  for (const k of ['lamp-near-local', 'lamp-near-world', 'lamp-ahead']) releaseLight(k); }
}
}

async function runCase(name, mutate = null) {
  const args = [process.execPath, import.meta.path, '--case', name];
  if (mutate) args.push('--mutate', String(mutate));
  const p = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
  const text = p.stdout.toString();
  const line = text.split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line || p.exitCode !== 0) throw new Error(`case ${name} exited ${p.exitCode}${line ? '' : ' with no result'}:\n${text}\n${p.stderr.toString()}`);   // a FAIL in the child (stubResolve's) is a fail here
  return JSON.parse(line.slice('__RESULT__'.length));
}

// One case's assertions, as a function, so the mutation controls can reuse the
// exact same checks rather than a paraphrase of them.
const bootOnChecks = (r, c = check) => {
  c('preference default is ON', r.boot.pref === true);
  c('shadow map enabled at boot', r.boot.map === true);
  c('the lamp slot casts at boot', r.boot.lamp === true);
};
const bootOffChecks = (r, c = check) => {
  c('preference OFF is read at boot', r.boot.pref === false);
  c('pref off at boot: the sun draws no shadow (uniform-level; the map stays in the pipeline shape)', r.boot.sun === false && r.boot.shapeOn === true);
  // THE DEFECT: a casting lamp with shadows off. Agreement is the invariant,
  // not "off" -- a lamp that casts while the switch is off is a lamp pretending.
  c('the lamp slot does NOT cast when the preference is off', r.boot.lamp === false,
    'slot 0 born casting with shadows off — boot disagrees with the switch');
};
const flipChecks = (r, c = check) => {
  c('setShadows(false) keeps the pipeline shape (no scene recompile)', r.off.shapeOn === true);
  c('setShadows(false) stops the sun casting', r.off.sun === false);
  c('setShadows(false) stops the LAMP casting', r.off.lamp === false,
    'the lamp kept casting with shadows off');
  c('setShadows(false) is reported by shadowsOn()', r.off.pref === false);
  c('setShadows(true) re-enables the map', r.on.map === true);
  c('setShadows(true) restores the sun', r.on.sun === true);
  c('setShadows(true) RESTORES the lamp', r.on.lamp === true,
    'the lamp never came back — the slot is built once at boot and was never revisited');
  c('setShadows(true) is reported by shadowsOn()', r.on.pref === true);
};

const farChecks = (r, c = check) => {
  c('the lamp is born with a bounded near', r.born.near > 0 && r.born.near <= 0.05,
    `near=${r.born.near}`);
  // THE DEFECT: far=500 with near=0.03. The invariant is the RATIO, which is
  // what actually sets a perspective shadow map's depth precision.
  c('the lamp is born with a bounded far (NOT three\'s 500)', r.born.far <= 10,
    `far=${r.born.far} — a 512 cube map spread over ${r.born.far} m has no precision at 0.6 m`);
  c('born near/far ratio is usable at body scale', r.born.far / r.born.near <= 1000,
    `ratio=${Math.round(r.born.far / r.born.near)}:1`);
  c('far follows a TIGHT lamp range', r.tight.far <= 3 + 1e-6,
    `range 3 -> far ${r.tight.far} (distance ${r.tight.distance})`);
  c('far follows a WIDE lamp range', Math.abs(r.wide.far - 9) < 1e-6,
    `range 9 -> far ${r.wide.far} (distance ${r.wide.distance})`);
};

const contendChecks = (r, c = check) => {
  c('the world light takes the casting slot first (the setup)', r.orbFirstSlot === r.castingSlot,
    `orb landed on slot ${r.orbFirstSlot}, casting slot is ${r.castingSlot}`);
  // THE DEFECT: the lamp is assigned by the general pass on its first assign,
  // so `r.slot < 0` was false from the second pass onward and it never claimed
  // the casting slot. Janus had to set castShadow on the lamp's own slot by
  // hand, every session.
  c('the lamp ends up on the CASTING slot', r.lampSlot === r.castingSlot,
    `lamp on slot ${r.lampSlot}, casting slot is ${r.castingSlot}`);
  c('...and is actually casting', r.lampRow?.casting === true,
    `wantsShadows row: ${JSON.stringify(r.lampRow)}`);
  c('anyCasting agrees', r.anyCasting === true);
  // the swap must not cost the incumbent its light, or "shadows work now" is
  // paid for with a world light going dark
  c('the evicted world light keeps a slot', r.orbSlot >= 0, `orb slot ${r.orbSlot}`);
  c('the evicted world light is still lit', (r.slotState[r.orbSlot] || {}).intensity > 0,
    `slot ${r.orbSlot} intensity ${(r.slotState[r.orbSlot] || {}).intensity}`);
  // and no two requests may share one slot (the first cut of the swap did)
  c('no two requests share a slot', r.distinct === r.assignedCount,
    `${r.assignedCount} assigned across ${r.distinct} distinct slots`);
};

const biasChecks = (r, c = check) => {
  // THE SHIPPED DEFAULTS ARE JANUS'S, verbatim. Pinned as a set so that
  // editing one constant and forgetting the others is caught -- the values
  // were chosen together against a moving body, and they only mean anything
  // together. Change them here when he retunes, deliberately.
  c('the shipped defaults are the measured set',
    r.shipped.map === 256 && r.shipped.texels === 8 && r.shipped.workDist === 12
    && Math.abs(r.shipped.forward - -0.02) < 1e-6 && Math.abs(r.shipped.up - 0.15) < 1e-6
    && r.shipped.side === 0,
    JSON.stringify(r.shipped));
  // The born values are Janus's, measured with the live dials. Asserted as a
  // pair against the arithmetic rather than as remembered numbers: an earlier
  // version of this check pinned map===280 and normalBias<0.008, which were my
  // defaults, and it went red the moment he tuned them. A test that encodes
  // the author's guess fails on the author being wrong, which is backwards.
  c('the lamp is born at a small map size', r.born.map >= 128 && r.born.map <= 512,
    `map=${r.born.map}`);
  // THE INVARIANT: whatever the dials say, the bias IS texels x texel size.
  // That is the property the fix established; the specific look is Janus's to
  // choose.
  c('born normalBias equals texels x texel size',
    Math.abs(r.born.normalBias - r.born.texels * (r.born.texelMM / 1000)) < 1e-4,
    `normalBias=${r.born.normalBias} texels=${r.born.texels} texelMM=${r.born.texelMM}`);
  c('born bias is not the old hand-picked 0.02 constant', Math.abs(r.born.normalBias - 0.02) > 1e-6,
    `normalBias=${r.born.normalBias}`);
  // THE INVARIANT: bias scales with the map so the LOOK is size-independent
  c('normalBias HALVES when the map doubles (256->512)',
    Math.abs(r.at[256].normalBias / r.at[512].normalBias - 2) < 0.02,
    `256:${r.at[256].normalBias} 512:${r.at[512].normalBias}`);
  c('...and again (512->1024)',
    Math.abs(r.at[512].normalBias / r.at[1024].normalBias - 2) < 0.02,
    `512:${r.at[512].normalBias} 1024:${r.at[1024].normalBias}`);
  // tolerance, not equality: texelMM is reported rounded to 2 decimals, so
  // dividing by it reconstructs the texel count to about 1 part in 500. The
  // claim under test is "constant across sizes", not "bit-identical".
  {
    const counts = [256, 280, 512, 1024].map((n) => r.at[n].normalBias / (r.at[n].texelMM / 1000));
    const spread = Math.max(...counts) - Math.min(...counts);
    c('bias stays a constant number of TEXELS across sizes', spread < 0.01,
      `texel counts ${counts.map((x) => x.toFixed(3)).join(' / ')} (spread ${spread.toFixed(4)})`);
  }
  c('the texel dial retunes without touching the map', r.retuned.map === 280 && r.retuned.texels === 3,
    JSON.stringify(r.retuned));
};

if (ARGV.includes('--mutants')) {
  // Each control reverts one half of the fix; the case that covers that half
  // must go red. A control that leaves the suite green means the test is not
  // measuring what its name claims.
  console.log('MUTATION CONTROLS — each must KILL its case');
  for (const [n, name, checks, label] of [
    [1, 'boot-off', bootOffChecks, 'slot born casting regardless of preference'],
    [2, 'flip', flipChecks, 'setShadows forgets the lamp slot'],
    [3, 'far', farChecks, "shadow far left at three's default 500"],
    [4, 'contend', contendChecks, 'lamp parked on a non-casting slot'],
    [5, 'bias', biasChecks, 'normalBias pinned to the old 0.02 constant'],
  ]) {
    const r = await runCase(name, n);
    let died = 0;
    checks(r, (_nm, ok) => { if (!ok) died++; });
    check(`control ${n} (${label}) is caught`, died > 0, 'the mutant survived — this test proves nothing');
  }
} else {
  console.log('SHADOW PREFERENCE — boot, default ON');
  bootOnChecks(await runCase('boot-on'));
  console.log('SHADOW PREFERENCE — boot, preference OFF');
  bootOffChecks(await runCase('boot-off'));
  console.log('SHADOW PREFERENCE — the switch flips both casters');
  flipChecks(await runCase('flip'));
  console.log('LAMP SHADOW CAMERA — near and far are bounded together');
  farChecks(await runCase('far'));
  console.log('CONTENDED CASTING SLOT — the world light loaded first');
  contendChecks(await runCase('contend'));
  console.log('LAMP SHADOW BIAS — derived from the map, not guessed');
  biasChecks(await runCase('bias'));
  console.log('SHADOW RESOLUTION — one dial for every caster (moved down from shadow-res-probe)');
  { const r = await runCase('res');
    check('boot with a stored 4096: sun 4096, lamp 512', r.boot.sun === 4096 && r.boot.lamp === 512, JSON.stringify(r.boot));
    check('1024: sun 1024, lamp 128', r.low.sun === 1024 && r.low.lamp === 128, JSON.stringify(r.low));
    check('2048 (default): sun 2048, lamp exactly its tuned 256', r.def.sun === 2048 && r.def.lamp === 256, JSON.stringify(r.def)); }
}

S.done();
