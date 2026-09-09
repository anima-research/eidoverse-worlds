// Transmission: does a transmissive material reach the renderer in a class
// that can DRAW it, and does the value survive the trip?
//
// This test was source-regex, and mica broke it on purpose to prove the point:
// she injected `if (k === 'transmission') continue;` into the upgrade -- so the
// runtime dropped the exact property the feature exists to preserve -- and the
// old test still reported 14 passed, 0 failed. A test that cannot fail is not a
// test. It also read an absolute path under a contributor's home directory, so
// it crashed ENOENT on her review host after 11 checks.
//
// So this one CALLS prepareObject() on a real mesh with a real
// MeshPhysicalMaterial and asserts on the material that comes back. No regex
// over source, no path outside this repo.
//
// The failure it guards is silent and looks like missing geometry: a plain
// MeshPhysicalMaterial with transmission > 0 arrives with every value correct
// -- visible: true, mesh present, triangles counted -- and renders as nothing,
// because three's WebGPU renderer only builds the transmission graph for
// MeshPhysicalNodeMaterial.

import { plugin } from 'bun';
const here = (p) => new URL(p, import.meta.url).pathname;
plugin({
  name: 'core-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    // lightrig pulls warmqueue -> loadwork, which calls requestAnimationFrame
    // at module scope. Same stub avatar-test and parts-test use.
    build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
  },
});

const { THREE } = await import('./core-stub.mjs');

// The stand-in for MeshPhysicalNodeMaterial lives in core-stub.mjs, which owns
// the THREE namespace it re-exports (a module namespace object is frozen).

const { prepareObject } = await import('../client/lib/materials.js');

let pass = 0, fail = 0;
const check = (name, ok, note = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); }
};

/** A mesh wearing one material, run through the real factory. */
function prepared(mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  const root = new THREE.Group();
  root.add(m);
  prepareObject(root, { kind: 'model' });
  return Array.isArray(m.material) ? m.material[0] : m.material;
}

console.log('TRANSMISSION -- a correct file the renderer could not honour');
{
  const src = new THREE.MeshPhysicalMaterial({ name: 'Glass' });
  src.transmission = 0.95;
  src.ior = 1.52;
  src.thickness = 0.06;
  src.roughness = 0.05;
  src.metalness = 0;
  src.color.setRGB(0.96, 0.98, 1.0);
  src.specularIntensity = 1;
  const out = prepared(src);

  check('a transmissive material is upgraded to a NODE material',
        out?.isNodeMaterial === true, `got ${out?.constructor?.name}`);
  check('...specifically MeshPhysicalNodeMaterial',
        out?.isMeshPhysicalNodeMaterial === true, `got ${out?.constructor?.name}`);

  // THE REGRESSION mica injected. `transmission` is a PROTOTYPE ACCESSOR on
  // MeshPhysicalMaterial, so a copy loop over Object.keys() silently drops the
  // one value the upgrade exists to carry -- producing a node material with
  // ior and thickness intact and transmission 0: the same invisibility for a
  // new reason. This is the check that goes red for that.
  check('TRANSMISSION SURVIVES the upgrade (the accessor bug)',
        out?.transmission === 0.95, `got ${out?.transmission}`);
  check('ior survives', out?.ior === 1.52, `got ${out?.ior}`);
  check('thickness survives', out?.thickness === 0.06, `got ${out?.thickness}`);
  check('roughness and metalness survive',
        out?.roughness === 0.05 && out?.metalness === 0);
  check('specularIntensity survives', out?.specularIntensity === 1,
        `got ${out?.specularIntensity}`);
  check('the name survives (lightrig and gltf_materials dispatch on it)',
        out?.name === 'Glass', `got ${out?.name}`);
  check('it is in the transparent pass', out?.transparent === true);

  // Colour/Vector types must be COPIED, not shared: assigning them would leave
  // the new material pointing at the old one's Color instance, so a later tweak
  // to either would silently move the other.
  check('colour came across by VALUE, not by reference',
        out?.color !== src.color
        && Math.abs(out.color.r - 0.96) < 1e-6
        && Math.abs(out.color.b - 1.0) < 1e-6);
}

console.log('\nAND ONLY TRANSMISSIVE MATERIALS -- node materials compile dearer');
{
  const opaque = new THREE.MeshPhysicalMaterial({ name: 'GOLD' });
  opaque.metalness = 1; opaque.roughness = 0.26;
  const out = prepared(opaque);
  check('an opaque MeshPhysicalMaterial is left alone',
        out?.isNodeMaterial !== true, `got ${out?.constructor?.name}`);
  check('...with its values untouched',
        out?.metalness === 1 && out?.roughness === 0.26);

  const std = new THREE.MeshStandardMaterial({ name: 'RAVEN' });
  const outStd = prepared(std);
  check('a MeshStandardMaterial is left alone too',
        outStd?.isNodeMaterial !== true, `got ${outStd?.constructor?.name}`);
}

console.log('\nIDEMPOTENCE -- prepareObject runs on every load and hot-swap');
{
  const m = new THREE.MeshPhysicalMaterial({ name: 'Glass' });
  m.transmission = 0.5;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), m);
  const root = new THREE.Group(); root.add(mesh);
  prepareObject(root, { kind: 'model' });
  const first = mesh.material;
  prepareObject(root, { kind: 'model' });
  check('a second pass does not re-upgrade (or churn the material)',
        mesh.material === first);
  check('...and the value is still there', mesh.material.transmission === 0.5);
}

console.log('\nLAMP LIFECYCLE -- mica\'s two probes, as tests');
{
  const { requestLight, releaseOwner, updateRequest, rigDebug, updateRig }
    = await import('../client/lib/lightrig.js');

  // B2: OWNERSHIP. A lamp owner keyed to the IDENTITY collides across a body
  // swap: the swap order is build-new-then-dispose-old (mybody.js), so the new
  // body registers `body:mythos`, the old body's dispose releases
  // `body:mythos`, and the LIVE lamp dies. mica measured requests 1 -> 0.
  const before = rigDebug().requests.length;
  requestLight('lamp:body:mythos:1:0', { owner: 'body:mythos:1', intensity: 10 });
  requestLight('lamp:body:mythos:2:0', { owner: 'body:mythos:2', intensity: 10 });
  const both = rigDebug().requests.length - before;
  check('two bodies of one identity hold two distinct requests', both === 2, `${both}`);
  releaseOwner('body:mythos:1');                       // the OLD body disposes
  const left = rigDebug().requests.filter((r) => /mythos:2/.test(r.key)).length;
  check('disposing the old body leaves the new body\'s lamp alive', left === 1,
        `${left} left`);
  releaseOwner('body:mythos:2');

  // ...and the collision itself, so the test states what used to happen.
  requestLight('lamp:body:janus:0', { owner: 'body:janus', intensity: 10 });
  releaseOwner('body:janus');
  check('(control) a SHARED owner key does take the other body down',
        rigDebug().requests.filter((r) => /janus/.test(r.key)).length === 0);

  // B6: intensity must NOT dirty slot assignment -- the rig recomputes at most
  // every 600ms and assignment reads tier and camera distance, never intensity.
  // A breathing lamp patches this 60x a second.
  //
  // The assertion has to start from a CLEAN flag, or it passes on the broken
  // code: a fresh requestLight leaves assignDirty true, so "still true after
  // an intensity patch" proves nothing. updateRig() clears it -- so run one,
  // confirm it cleared, and only then patch. (My first cut skipped that and
  // passed against the very implementation it was written to reject, which is
  // precisely the failure mica found in the rest of this file.)
  requestLight('probe:0', { owner: 'probe', intensity: 5 });
  updateRig(performance.now());
  check('(setup) a rig pass clears the assignment flag',
        rigDebug().assignDirty === false, `${rigDebug().assignDirty}`);
  updateRequest('probe:0', { intensity: 7 });
  check('an intensity patch does not force reassignment',
        rigDebug().assignDirty === false, `dirty became ${rigDebug().assignDirty}`);
  updateRequest('probe:0', { keep: true });
  check('...but a TIER patch does', rigDebug().assignDirty === true);
  releaseOwner('probe');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
