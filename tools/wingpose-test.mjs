// Wing posing: can an agent actually MOVE a wing, and does the wrong body get
// refused?
//
// mica's first blocker on PR #174: she deleted BOTH real fixes -- client raw-bone
// resolution and post-spring wing ownership -- and every advertised test stayed
// green (45/45, 28/28, 6/6). They were source-regex and schema checks. So this
// file drives the real Avatar class and the real validator, and each check is
// paired with the mutation it is supposed to catch.
//
// The failure being guarded is silent: three separate writers claim a wing bone
// (the pose, _flap, and the springbone sim), and losing any of the three
// handoffs produces a body that reports success and does not move.

// The Avatar constructor draws a nameplate through document/canvas.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () {
  const anything = new Proxy(function () {}, {
    get: (_t, k) => (k === 'width' ? 100 : anything),
    apply: () => anything, set: () => true,
  });
  return new Proxy({}, {
    get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : anything),
    set: () => true,
  });
};

import { plugin } from 'bun';
// A plain absolute path from __dirname. Both `new URL(...).pathname` and
// fileURLToPath reach Bun 1.3's onResolve as a `file:` string that readFile
// then treats as a literal name -- which is why avatar-test.ts fails with
// ENOENT on a stub that is sitting right there, on clean main, unrelated to
// anything here. `import.meta.dir` sidesteps it.
// HOISTED to a const first. Reading import.meta.dir inside the arrow, called
// from within plugin.setup, resolved differently than reading it at module
// scope -- the same `file:` ENOENT that made this suite's outcome depend on
// import order. Identical to tools/transmission-test.mjs.
const HERE = import.meta.dir;
const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({
  name: 'core-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    // avatar.js pulls assets.js, which builds a KTX2Loader needing a real GPU.
    // Same three stubs avatar-test.ts uses, for the same reason.
    build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
  },
});

const { THREE } = await import('./core-stub.mjs');
const { validatePose, validateTracks, isRawBone, WING_RE }
  = await import('../shared/humanoid.js');
// TOP-LEVEL. A dynamic import from inside a test block resolved `./core.js`
// without the plugin's substitution on a cold cache -- ENOENT on a `file:`
// path -- so whether the suite ran depended on import order.
const { Avatar } = await import('../client/lib/avatar.js');
const { readFileSync } = await import('node:fs');

let pass = 0, fail = 0;
const check = (name, ok, note = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); }
};

const WINGED = ['Hip', 'Spine02', 'Head',
  'L_Wing_Upper', 'L_Wing_Upper_1', 'L_Wing_Upper_2',
  'R_Wing_Upper', 'R_Wing_Upper_1', 'R_Wing_Upper_2',
  'L_Wing_Lower', 'R_Wing_Lower'];
const WINGLESS = ['hips', 'spine', 'head', 'leftHand', 'rightHand'];

console.log('THE VALIDATOR -- names, case, and whose body');
{
  const v = validatePose({ L_Wing_Upper: [0, 0, 0.26, 0.97] });
  check('a wing bone is accepted at all', v.accepted.includes('L_Wing_Upper'),
        JSON.stringify(v.rejected));
  check('...under its exact name, unrenamed',
        v.pose.L_Wing_Upper !== undefined && !v.renamed.length);
  check('outer segments too',
        validatePose({ R_Wing_Lower_2: [0, 0, 0, 1] }).accepted.length === 1);

  const low = validatePose({ l_wing_upper: [0, 0, 0, 1] });
  check('a lowercase wing name is refused (a raw name is a FACT, not a vocabulary)',
        !low.accepted.length);
  check('...and the refusal names the real spelling',
        /case-sensitive/.test(low.rejected[0]?.why ?? ''), low.rejected[0]?.why);

  // THE GATE. Raw bones are real only if the body wearing the pose has them.
  const rawKnown = new Set(WINGED);
  check('a wing the body HAS is accepted',
        validatePose({ L_Wing_Upper: [0, 0, 0, 1] }, { rawKnown }).accepted.length === 1);
  const no = validatePose({ L_Wing_Upper: [0, 0, 0, 1] }, { rawKnown: new Set(WINGLESS) });
  check('a wing the body LACKS is refused, not silently dropped',
        !no.accepted.length && /no bone by that name/.test(no.rejected[0]?.why ?? ''),
        JSON.stringify(no.rejected));
  check('humanoid bones stay ungated (VRM guarantees them)',
        validatePose({ head: [0, 0, 0, 1] }, { rawKnown: new Set() }).accepted.includes('head'));
  // THE ENFOLD -- the commissioning story, in Mythos's words: "someone ELSE
  // deciding, with my yes, to wrap my wing around them -- likely a wingless
  // someone." So `wingless self -> winged target` is not an edge case to
  // tolerate; it is the case that must SUCCEED. It was refused before the gate
  // asked about the right skeleton.
  const enfold = validatePose({ L_Wing_Upper: [0, 0, 0.26, 0.97] }, { rawKnown });
  check('THE ENFOLD: a wingless agent may pose a WINGED target\'s wing',
        enfold.accepted.includes('L_Wing_Upper'), JSON.stringify(enfold.rejected));
  const wrongWay = validatePose({ L_Wing_Upper: [0, 0, 0, 1] },
                                { rawKnown: new Set(WINGLESS), whose: 'claude' });
  check('...and a winged agent may NOT invent wings on a wingless target',
        !wrongWay.accepted.length);
  check('...with the refusal naming THEIR body, not the sender\'s',
        /claude has no bone/.test(wrongWay.rejected[0]?.why ?? ''),
        wrongWay.rejected[0]?.why);

  check('a pose can name a wing and an arm together',
        validatePose({ leftUpperArm: [0, 0, -0.9, 0.44], L_Wing_Upper: [0, 0, 0.26, 0.97] },
                     { rawKnown }).accepted.length === 2);

  // ANIMATE shares canonicalBone, so it inherited wing acceptance the moment
  // pose gained it. mica: `wingless self -> animate wing: "playing ...
  // L_Wing_Upper"`. Same gate, same reason.
  const track = { L_Wing_Upper: [{ t: 0, q: [0, 0, 0, 1] }, { t: 0.5, q: [0, 0, 0.26, 0.97] }] };
  check('animate accepts a wing the body has',
        validateTracks(track, { rawKnown }).accepted.length === 1);
  const at = validateTracks(track, { rawKnown: new Set(WINGLESS) });
  check('animate REFUSES a wing the body lacks',
        !at.accepted.length && /no bone by that name/.test(at.rejected[0]?.why ?? ''),
        JSON.stringify(at.rejected));
}

console.log('\nTHE BODY -- three writers, and the pose must win');
{
  // My earlier note that Avatar could not be imported here was WRONG: the
  // ENOENT was `new URL(...).pathname` reaching Bun's onResolve as a `file:`
  // string, not the module. So these drive the real class, and each is paired
  // with the mutation mica used to show the old checks were hollow.
  /** A winged skeleton with the wings declared as SPRINGBONES, which is what
   *  the shipped rig does -- and the reason skipping _flap is not enough. */
  function wingedVrm() {
    const scene = new THREE.Object3D();
    const chest = new THREE.Object3D(); chest.name = 'Spine02'; scene.add(chest);
    const joints = []; const bones = {};
    for (const side of ['L', 'R']) {
      for (const row of ['Upper', 'Lower']) {
        let parent = chest;
        for (let i = 0; i <= 2; i++) {
          const b = new THREE.Bone();
          b.name = `${side}_Wing_${row}${i ? `_${i}` : ''}`;
          b.position.set(side === 'L' ? 0.1 : -0.1, 0, 0);
          b.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.1 * (i + 1));
          parent.add(b); parent = b; bones[b.name] = b;
          joints.push({ bone: b, _initialLocalRotation: b.quaternion.clone() });
        }
      }
    }
    return {
      scene, bones,
      humanoid: { getNormalizedBoneNode: (n) => (n === 'chest' ? chest : null) },
      springBoneManager: { joints, reset() {}, setInitState() {} },
      expressionManager: null,
      update() {},
    };
  }

  const vrm = wingedVrm();
  const av = new Avatar('probe', vrm, {});
  const node = vrm.bones.L_Wing_Upper;
  const other = vrm.bones.R_Wing_Upper;

  // 1. RESOLUTION -- mutation: delete the raw-bone branch in _resolveBones.
  const resolved = av._resolveBones(['L_Wing_Upper', 'chest', 'not_a_bone']);
  check('the client RESOLVES a raw wing bone by name',
        resolved.some(([n, o]) => n === 'L_Wing_Upper' && o === node),
        JSON.stringify(resolved.map(([n]) => n)));
  check('...and still drops a name that is nothing',
        !resolved.some(([n]) => n === 'not_a_bone'));

  // 2. THE HOLD -- mutation: delete the posed write inside _flap. _flap runs
  //    after vrm.update with an unconditional copy, and the springbone sim
  //    claims these same joints, so skipping is not enough.
  const target = new THREE.Quaternion(0, 0, 0.7071, 0.7071).normalize();
  av.setPose({ L_Wing_Upper: target.toArray() }, true);
  av._findWings();
  if (av._override) av._override.weight = 1;      // past the ramp
  av._wingBlend = 1;                              // and past the stand-up slerp
  const want = new THREE.Quaternion()
    .copy(av._wings.find((w) => w.node === node).rest).multiply(target);
  let drift = 0;
  for (let i = 0; i < 30; i++) {
    av._flap(1 / 60);
    drift = Math.max(drift, Math.abs(node.quaternion.angleTo(want)));
  }
  check('a posed wing HOLDS through 30 flap frames', drift < 1e-6,
        `max drift ${drift.toFixed(6)} rad`);

  // 3. PER BONE, not per body.
  const seen = [];
  for (let i = 0; i < 30; i++) { av._flap(1 / 60); seen.push(other.quaternion.clone()); }
  const spread = Math.max(...seen.map((q) => Math.abs(q.angleTo(seen[0]))));
  check('the OTHER wing keeps flapping', spread > 1e-3, `spread ${spread.toFixed(4)} rad`);

  // 4. WEIGHT -- mutation: return only the target from _poseOwnedWings.
  av._override.weight = 0.5;
  av._flap(1 / 60);
  const off = Math.abs(node.quaternion.angleTo(want));
  check('a half-weighted pose sits BETWEEN flap and target, not snapped',
        off > 1e-4, `${off.toFixed(5)} rad from the target`);

  // 5. RELEASE.
  av._override.weight = 0;
  const before = node.quaternion.clone();
  for (let i = 0; i < 20; i++) av._flap(1 / 60);
  check('a released wing flaps again',
        Math.abs(node.quaternion.angleTo(before)) > 1e-3);
}

console.log('\nTHE TOOL SURFACE -- the right body, and a findable capability');
{
  const tools = readFileSync(`${import.meta.dir}/../mcpl/tools.ts`, 'utf8');
  check('pose gates on the TARGET body, not the sender',
        /loadBonesForTarget\(a\.target/.test(tools));
  check('animate gates on the target body too',
        (tools.match(/loadBonesForTarget/g) ?? []).length >= 2);
  check('the schema ADVERTISES wings (a capability nobody can find is none)',
        /L_Wing_Upper/.test(tools) && /CASE-SENSITIVE/.test(tools));
  const agent = readFileSync(`${import.meta.dir}/../mcpl/agent.ts`, 'utf8');
  check('bones come from skins[].joints, not every named node',
        /for \(const sk of g\.skins/.test(agent) && /sk\.joints/.test(agent));
  check('...deduplicated', /seen\.has\(nm\)/.test(agent));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
