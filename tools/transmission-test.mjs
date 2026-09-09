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

// The Avatar constructor makes a nameplate sprite through document/canvas, so
// the DOM has to exist before avatar.js is imported. Same registrator
// chat-log-test and frames-resize-test use.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
// happy-dom ships no 2D canvas context, and the nameplate measures and draws
// text. An inert recorder is enough: nothing here asserts on pixels, and the
// alternative is a real canvas binding for a label the lamp does not care
// about.
HTMLCanvasElement.prototype.getContext = function () {
  // Every method returns a SELF-CHAINING stub, because the drawing code builds
  // objects from the context and calls methods on them (createRadialGradient
  // -> addColorStop). Returning a bare no-op yielded undefined and threw one
  // draw call later.
  const anything = new Proxy(function () {}, {
    get: (_t, k) => (k === 'width' ? 100 : anything),
    apply: () => anything,
    set: () => true,
  });
  return new Proxy({}, {
    get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : anything),
    set: () => true,
  });
};

import { plugin } from 'bun';
// import.meta.dir is a plain filesystem path; a `file:` URL string reaches
// readFile as a literal name and ENOENTs on a stub that is right there. This
// showed up only on a COLD module cache (i.e. right after editing a client
// file), which is exactly when a mutation test runs -- so the suite appeared
// to "fail" on mutations for the wrong reason.
const HERE = import.meta.dir;
const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({
  name: 'core-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    // lightrig pulls warmqueue -> loadwork, which calls requestAnimationFrame
    // at module scope. Same stub avatar-test and parts-test use.
    build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    // avatar.js pulls assets.js, which builds a KTX2Loader against a real
    // renderer. Without this the run's outcome depended on whether assets.js
    // had already been imported and cached -- a harness that sometimes passes
    // is worse than one that fails.
    build.onResolve({ filter: /^\.\/assets\.js$/ }, () => ({ path: here('./assets-stub.mjs') }));
    build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
  },
});

const { readFileSync } = await import('node:fs');
const { THREE } = await import('./core-stub.mjs');

// The stand-in for MeshPhysicalNodeMaterial lives in core-stub.mjs, which owns
// the THREE namespace it re-exports (a module namespace object is frozen).

const { prepareObject } = await import('../client/lib/materials.js');
// TOP-LEVEL, not inside a block. A dynamic import from inside a test resolved
// `./core.js` on a cold module cache without the plugin's substitution --
// ENOENT on a `file:` path -- so whether the suite ran at all depended on
// import order. Everything the suite touches is loaded here, once.
const { Avatar } = await import('../client/lib/avatar.js');
const { requestLight, releaseOwner, updateRequest, rigDebug, updateRig }
  = await import('../client/lib/lightrig.js');

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

console.log('\nSHARING -- one source material, one replacement');
{
  // Two meshes wearing THE SAME material must come back wearing the same
  // replacement. A WeakSet could record that a material had been upgraded but
  // not what to, so each mesh built its own node material: double the shader
  // objects for one look, and an author editing the shared material would move
  // one mesh and not the other (mica: replacementShared:false).
  const src = new THREE.MeshPhysicalMaterial({ name: 'Glass' });
  src.transmission = 0.9; src.ior = 1.5;
  const a = new THREE.Mesh(new THREE.BoxGeometry(), src);
  const b = new THREE.Mesh(new THREE.BoxGeometry(), src);
  const root = new THREE.Group(); root.add(a); root.add(b);
  prepareObject(root, { kind: 'model' });
  check('both meshes were upgraded', a.material.isNodeMaterial && b.material.isNodeMaterial);
  check('...to the SAME replacement, not one each', a.material === b.material,
        a.material === b.material ? '' : 'two node materials for one source');
  check('...carrying the value', a.material.transmission === 0.9);

  // And a mesh added LATER, in a separate pass, still shares.
  const c = new THREE.Mesh(new THREE.BoxGeometry(), src);
  const root2 = new THREE.Group(); root2.add(c);
  prepareObject(root2, { kind: 'model' });
  check('a mesh prepared in a later pass shares it too', c.material === a.material);
}

console.log('\nAUTHORED ZERO -- ?? not ||');
{
  // A lamp material authored at emissiveIntensity 0 (starts dark) must not be
  // "restored" to 1. `|| 1` did exactly that, and the pooled material then
  // came back brighter than it was written.
  const av = readFileSync(`${HERE}/../client/lib/avatar.js`, 'utf8');
  check('the lamp base uses ?? so an authored zero survives',
        /base: m\.emissiveIntensity \?\? 1/.test(av) &&
        !/base: m\.emissiveIntensity \|\| 1/.test(av));
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

console.log('\nTHE AVATAR ITSELF -- build-new -> dispose-old, and pool -> rewear');
{
  // mica's re-review: the lifecycle checks below drive lightrig DIRECTLY, so
  // she restored both old defects in avatar.js -- bare `body:${id}` ownership
  // and no emissive restoration before pooling -- and the suite still passed
  // 21/21. Manually creating good keys cannot see a bug in how Avatar MAKES
  // them. These bind the real class.
  //
  // (And my note that Avatar could not be imported here was wrong: the ENOENT
  // was `new URL(...).pathname` reaching Bun's onResolve as a `file:` string,
  // not the module. A plain path works.)
  /** A body with one emissive mesh -- enough for attachLamps to want a lamp. */
  function glowingVrm() {
    const scene = new THREE.Object3D();
    const mat = new THREE.MeshStandardMaterial({ name: 'lampglass' });
    mat.emissive = new THREE.Color(1, 0.72, 0.25);
    mat.emissiveIntensity = 3;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 8), mat);
    mesh.name = 'lamp';
    scene.add(mesh);
    return {
      scene, mat, mesh,
      humanoid: { getNormalizedBoneNode: () => null },
      springBoneManager: { joints: [], reset() {}, setInitState() {} },
      expressionManager: null,
      update() {},
    };
  }
  const lampsOf = (owner) => rigDebug().requests.filter((r) => r.key.startsWith(`lamp:${owner}`)).length;
  const mine = (id) => rigDebug().requests.filter((r) => r.key.includes(`body:${id}`)).length;

  // B2: THE SWAP. mybody.js builds the NEW body and then disposes the old, so
  // an owner keyed on the identity means the old body's dispose deletes the
  // live lamp. mica measured requests 1 -> 0.
  const v1 = glowingVrm();
  const oldBody = new Avatar('mythos', v1, {});
  check('a glowing body registers a lamp', mine('mythos') === 1, `${mine('mythos')}`);
  const v2 = glowingVrm();
  const newBody = new Avatar('mythos', v2, {});          // build new...
  check('...and the second body of the same identity registers its own',
        mine('mythos') === 2, `${mine('mythos')}`);
  oldBody.dispose();                                      // ...then dispose old
  check('B2: disposing the OLD body leaves the new body lit',
        mine('mythos') === 1, `${mine('mythos')} requests left`);
  check('...and it is the NEW body\'s request that survived',
        lampsOf(newBody._lampOwner) === 1);

  // B3: THE POOL. The breath writes emissiveIntensity every frame and
  // assets.js resetVrmInstance touches no materials, so a body pooled
  // mid-breath comes back dim -- and dimmer than attachLamps's threshold means
  // the NEXT wearer gets no lamp at all (mica: rewear at 0.3, lamps made 0).
  newBody.update?.(1 / 60, performance.now());            // let the breath write
  v2.mat.emissiveIntensity = 0.3;                         // ...mid-breath, dim
  newBody.dispose();
  check('B3: dispose RESTORES the authored emissive before pooling',
        v2.mat.emissiveIntensity === 3, `left at ${v2.mat.emissiveIntensity}`);
  const rewear = new Avatar('mythos', v2, {});            // the pooled instance
  check('...so a rewear of the pooled body still gets a lamp',
        rewear._lamps.length === 1, `${rewear._lamps.length} lamps`);
  rewear.dispose();
  check('(cleanup) no lamp requests survive the last dispose', mine('mythos') === 0);
}

console.log('\nLAMP LIFECYCLE -- the rig\'s own contract');
{
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
