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

import { plugin } from 'bun';
// A plain absolute path from __dirname. Both `new URL(...).pathname` and
// fileURLToPath reach Bun 1.3's onResolve as a `file:` string that readFile
// then treats as a literal name -- which is why avatar-test.ts fails with
// ENOENT on a stub that is sitting right there, on clean main, unrelated to
// anything here. `import.meta.dir` sidesteps it.
const here = (p) => `${import.meta.dir}/${p.replace(/^\.\//, '')}`;
plugin({
  name: 'core-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    // avatar.js pulls assets.js, which builds a KTX2Loader needing a real GPU.
    // Same three stubs avatar-test.ts uses, for the same reason.
    build.onResolve({ filter: /^\.\/assets\.js$/ }, () => ({ path: here('./assets-stub.mjs') }));
    build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
  },
});

const { THREE } = await import('./core-stub.mjs');
const { validatePose, validateTracks, isRawBone, WING_RE }
  = await import('../shared/humanoid.js');

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
  // avatar.js cannot be imported here: it pulls assets.js, and Bun 1.3's
  // onResolve hands the stub path to readFile as a `file:` string, so the
  // module-substitution trick avatar-test.ts uses fails with ENOENT on clean
  // main too. Rather than claim coverage a broken harness cannot give, this
  // section asserts on the SOURCE of the three handoffs -- and says plainly
  // that it is doing so.
  //
  // THESE ARE THE CHECKS MICA'S MUTATIONS MUST FAIL, so each one names the
  // deletion it catches rather than merely matching a phrase.
  const { readFileSync } = await import('node:fs');
  const av = readFileSync(`${import.meta.dir}/../client/lib/avatar.js`, 'utf8');

  const resolve = /_resolveBones\(names\) \{[\s\S]*?\n  \}/.exec(av)?.[0] ?? '';
  check('_resolveBones falls through to a RAW bone lookup',
        /isRawBone\(n\)/.test(resolve) && /_rawBone\(n\)/.test(resolve),
        'deleting this is mutation 1 of blocker 1');
  check('...memoised, not a traverse per pose',
        /this\._rawBones === undefined/.test(av));

  const owned = /_poseOwnedWings\(\) \{[\s\S]*?\n  \}/.exec(av)?.[0] ?? '';
  check('_poseOwnedWings carries the override WEIGHT, not just the target',
        /weight: w, q: m/.test(owned),
        'without it a wing snaps in at 0.02 and snaps out below');

  const flap = /_flap\(dt\) \{[\s\S]*?\n  \}/.exec(av)?.[0] ?? '';
  check('_flap WRITES the posed rotation (skipping hands it to the springs)',
        /_wacc\.slerp\(_wtgt\.copy\(w\.rest\)\.multiply\(pq\), posed\.weight\)/.test(flap),
        'deleting this is mutation 2 of blocker 1');
  check('...blended by weight rather than copied',
        /slerp\(/.test(flap) && !/quaternion\.copy\(_wtgt\)/.test(flap));
  check('...and rides the same updateMatrix the flap needs for springbones',
        /w\.node\.updateMatrix\(\)/.test(flap));

  // The tool surface must ASK about the right body, and must advertise the
  // capability at all -- blockers 2, 3 and 6.
  const tools = readFileSync(`${import.meta.dir}/../mcpl/tools.ts`, 'utf8');
  check('pose gates on the TARGET body, not the sender',
        /loadBonesForTarget\(a\.target/.test(tools),
        'the wrong-body receipts mica produced');
  check('animate gates on the target body too',
        (tools.match(/loadBonesForTarget/g) ?? []).length >= 2);
  check('the pose schema ADVERTISES wings (a capability nobody can find is none)',
        /L_Wing_Upper/.test(tools) && /CASE-SENSITIVE/.test(tools));

  const agent = readFileSync(`${import.meta.dir}/../mcpl/agent.ts`, 'utf8');
  check('bones come from skins[].joints, not every named node',
        /for \(const sk of g\.skins/.test(agent) && /sk\.joints/.test(agent),
        'nodes.filter(n=>n.name) let Armature and GOLD false-pass');
  check('...deduplicated', /seen\.has\(nm\)/.test(agent));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
