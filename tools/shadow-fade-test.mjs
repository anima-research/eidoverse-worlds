// A caster entering or leaving the budget FADES (client/lib/lightrig.js casterPass + stepFades; the dither mask
// client/lib/materials.js FADE_MASK reads mesh.userData.shadowFade) instead of popping (R 10-11). Pins: an enable
// starts at 0 and reaches 1 within ~FADE_MS of frames; a disable keeps castShadow until the fade reaches 0; shedding
// the budget fades out; a caster coming back mid-fade reverses; prepared materials share ONE mask node.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };
import { plugin } from 'bun';
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({ name: 'core-stub', setup(build) {
  build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./shadow-fade-core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/assets\.js$/ }, () => ({ path: here('./assets-stub.mjs') }));
  build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
  build.onResolve({ filter: /^\.\/state\.js$/ }, () => ({ path: here('./state-stub.mjs') }));
  build.onResolve({ filter: /^\.\/warmqueue\.js$/ }, () => ({ path: here('./lod-client-stub.mjs') }));   // warmDepth resolves at once
} });
const { THREE, camera } = await import('./core-stub.mjs');
const rig = await import('../client/lib/lightrig.js');
const mats = await import('../client/lib/materials.js');
const { updateRig, registerCaster, setCasterBudget, rigDebug } = rig;

let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };
const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

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
  // matoverride clones a prepared material: NodeMaterial.copy carries maskShadowNode AND userData, then prepareMaterial runs again
  const clone = new THREE.NodeMaterial(); clone.roughness = 0.5; clone.metalness = 0; clone.maskShadowNode = a.maskShadowNode; clone.userData = { ...a.userData };
  mats.prepareMaterial(clone);
  check('re-preparing a clone keeps the ONE node (never FADE.and(FADE))', clone.maskShadowNode === a.maskShadowNode, clone.maskShadowNode?.tag); }

console.log('REGISTER — a mesh handed in casting starts not casting (house I172, #260)');
{ const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()); m.castShadow = true;   // realize/models.js primitives
  g.add(m); g.position.set(500, 0, 0); g.updateMatrixWorld(true); registerCaster('pre-cast', g);
  check('registerCaster leaves its meshes as its record says (casting false)', m.castShadow === false && rigDebug().casterList.find((c) => c.id === 'pre-cast')?.casting === false);
  rig.releaseCaster('pre-cast'); }

console.log('ENABLE — fades in from 0');
let t = 1000;
const near = makeCaster('near', 2);
updateRig(t);                      // pass 1: asks the conductor
await settle();
updateRig(t += 301);               // pass 2: warm done → flip at 0
check('castShadow flips true at the start', near.castShadow === true);
check('the fade starts at 0', near.userData.shadowFade === 0, `got ${near.userData.shadowFade}`);
check('the mesh leaves the draw batches while it fades', near.userData.noDrawBatch === true);
updateRig(t += 16); updateRig(t += 16);
const mid = near.userData.shadowFade;
check('…and climbs per frame', mid > 0 && mid < 1, `got ${mid}`);
for (let i = 0; i < 20; i++) updateRig(t += 16);                       // 320 ms of frames
check(`reaches 1 within ~${rig.FADE_MS} ms`, near.userData.shadowFade === 1, `got ${near.userData.shadowFade}`);
check('…and rejoins the draw batches', near.userData.noDrawBatch === undefined);
check('nothing left fading', rig.fadingCount() === 0);

console.log('SHED — the budget drops: fades out, castShadow holds until 0');
const far = makeCaster('far', 40);
updateRig(t += 301); await settle(); updateRig(t += 301);
for (let i = 0; i < 22; i++) updateRig(t += 16);
check('two cast at budget 2', near.castShadow && far.castShadow && far.userData.shadowFade === 1);
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
check('near was never touched', near.castShadow === true && near.userData.shadowFade === 1);

console.log('BUDGET 0 — nothing is kept by hysteresis (the edge was Infinity at 0: the first four stayed forever)');
setCasterBudget(2);
updateRig(t += 301); for (let i = 0; i < 22; i++) updateRig(t += 16);
check('two cast again', near.castShadow && far.castShadow && rig.fadingCount() === 0);
setCasterBudget(0);
updateRig(t += 301); for (let i = 0; i < 22; i++) updateRig(t += 16);
check('at budget 0 every caster fades out and stops casting', !near.castShadow && !far.castShadow && rig.fadingCount() === 0, JSON.stringify(rigDebug().casterList));

console.log('HARD FLIP — a mesh whose material is not a node material');
setCasterBudget(3);
const plain = makeCaster('plain', 3, false);
updateRig(t += 301); await settle(); updateRig(t += 301);
check('castShadow flips true, no amount written', plain.castShadow === true && plain.userData.shadowFade === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
