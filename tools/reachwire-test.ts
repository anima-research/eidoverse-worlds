/**
 * reachwire — the descriptor grammar and the event edges, no scene required.
 *
 *   bun tools/reachwire-test.ts
 *
 * Everything here is wire-facing: descriptors arrive from OTHER processes and
 * other versions, so the reader must fold garbage to nothing (never throw in
 * a frame loop) and the edge logic must fire each event exactly once.
 */
import {
  REACH_LIMBS, canonicalLimb, normalizeReachTarget, normalizeReachBag,
  reachTargetsWho, sameReach, describeTarget, diffReach,
} from '../shared/reachwire.js';

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ''}\x1b[0m`);
  if (!ok) failures++;
};

console.log('\nlimb names, as people write them');
check("'right' → rightHand", canonicalLimb('right') === 'rightHand');
check("'left hand' → leftHand", canonicalLimb('left hand') === 'leftHand');
check("'LEFT_FOOT' → leftFoot", canonicalLimb('LEFT_FOOT') === 'leftFoot');
check("'tail' → null", canonicalLimb('tail') === null);
check('four limbs', REACH_LIMBS.length === 4);

console.log('\ntargets normalize or fold to nothing');
{
  const lm = normalizeReachTarget({ who: 'mythos', point: 'left shoulder' });
  check('landmark form, generous point name', lm?.who === 'mythos' && lm?.point === 'shoulder_l');
  check('unknown point → null', normalizeReachTarget({ who: 'mythos', point: 'tentacle' }) === null);
  check('standoff clamps to 0.2', normalizeReachTarget({ who: 'a', point: 'head_top', standoff: 9 })?.standoff === 0.2);
  check('negative standoff drops', normalizeReachTarget({ who: 'a', point: 'head_top', standoff: -1 })?.standoff === undefined);
  const wp = normalizeReachTarget({ p: [1, 2, 3] });
  check('world point form, space omitted', !!wp && wp.space === undefined);
  check("space 'world' normalizes to omitted", normalizeReachTarget({ p: [1, 2, 3], space: 'world' })?.space === undefined);
  check("space 'self' kept", normalizeReachTarget({ p: [0, 1, 0], space: 'self' })?.space === 'self');
  check('avatar space kept', normalizeReachTarget({ p: [0, 1, 0], space: 'mythos' })?.space === 'mythos');
  check('NaN point → null', normalizeReachTarget({ p: [1, NaN, 3] }) === null);
  check('short point → null', normalizeReachTarget({ p: [1, 2] }) === null);
  check('string → null', normalizeReachTarget('shoulder_l' as any) === null);
  check('null → null', normalizeReachTarget(null) === null);
}

console.log('\nbags: unknown limbs and malformed entries drop');
{
  const bag = normalizeReachBag({
    rightHand: { t: { who: 'a', point: 'head_top' }, palm: false, reached: true },
    leftHand: { t: { p: [0, 0, 0], space: 'self' } },
    tail: { t: { p: [0, 0, 0] } },
    leftFoot: { t: { who: 'a', point: 'nope' } },
  });
  check('two limbs survive', bag !== null && Object.keys(bag!).length === 2);
  check('palm:false kept', bag?.rightHand?.palm === false);
  check('reached kept', bag?.rightHand?.reached === true);
  check('empty bag → null', normalizeReachBag({ tail: {} }) === null);
  check('non-object → null', normalizeReachBag('x' as any) === null);
  check('reached:"yes" drops (attestation is boolean)', normalizeReachBag({ rightHand: { t: { p: [0, 0, 0] }, reached: 'yes' } })?.rightHand?.reached === undefined);
}

console.log('\nwho a reach is aimed at');
{
  const lm = { t: normalizeReachTarget({ who: 'me', point: 'head_top' })! };
  const sp = { t: normalizeReachTarget({ p: [0, 1, 0], space: 'me' })! };
  const wp = { t: normalizeReachTarget({ p: [0, 1, 0] })! };
  check('landmark on me → me', reachTargetsWho(lm, 'me'));
  check('point in my frame → me', reachTargetsWho(sp, 'me'));
  check('world point → nobody', !reachTargetsWho(wp, 'me'));
  check('landmark on them ≠ me', !reachTargetsWho(lm, 'you'));
}

console.log('\nreach identity ignores the reached rider');
{
  const a = normalizeReachBag({ rightHand: { t: { who: 'x', point: 'head_top' } } })!.rightHand;
  const b = normalizeReachBag({ rightHand: { t: { who: 'x', point: 'head_top' }, reached: true } })!.rightHand;
  const c = normalizeReachBag({ rightHand: { t: { who: 'x', point: 'shoulder_l' } } })!.rightHand;
  const d = normalizeReachBag({ rightHand: { t: { who: 'x', point: 'head_top' }, palm: false } })!.rightHand;
  check('same aim ± reached → same', sameReach(a, b));
  check('different point → different', !sameReach(a, c));
  check('palm opt-out is part of the aim', !sameReach(a, d));
  const p1 = normalizeReachBag({ leftHand: { t: { p: [1, 2, 3] } } })!.leftHand;
  const p2 = normalizeReachBag({ leftHand: { t: { p: [1, 2, 3] } } })!.leftHand;
  const p3 = normalizeReachBag({ leftHand: { t: { p: [1, 2, 3.001] } } })!.leftHand;
  check('same point → same', sameReach(p1, p2));
  check('moved point → different', !sameReach(p1, p3));
}

console.log('\nevents fire on edges, exactly once');
{
  const B = (spec: any) => normalizeReachBag(spec);
  const aiming = B({ rightHand: { t: { who: 'me', point: 'shoulder_l' } } });
  const arrived = B({ rightHand: { t: { who: 'me', point: 'shoulder_l' }, reached: true } });
  const retargeted = B({ rightHand: { t: { who: 'me', point: 'head_top' }, reached: true } });
  const elsewhere = B({ rightHand: { t: { who: 'you', point: 'head_top' } } });

  check('new reach at me → one reach event',
    JSON.stringify(diffReach(null, aiming, 'me').map((e) => e.type)) === '["reach"]');
  check('held aim, no arrival → silence', diffReach(aiming, aiming, 'me').length === 0);
  check('arrival → one touch', JSON.stringify(diffReach(aiming, arrived, 'me').map((e) => e.type)) === '["touch"]');
  check('held touch → silence', diffReach(arrived, arrived, 'me').length === 0);
  check('retarget while touching → reach + touch',
    JSON.stringify(diffReach(arrived, retargeted, 'me').map((e) => e.type).sort()) === '["reach","touch"]');
  check('let go → one release', JSON.stringify(diffReach(arrived, null, 'me').map((e) => e.type)) === '["release"]');
  check('reach at someone else → not my event', diffReach(null, elsewhere, 'me').length === 0);
  check('retarget AWAY from me → my release',
    JSON.stringify(diffReach(arrived, elsewhere, 'me').map((e) => e.type)) === '["release"]');
  check('descriptor arriving already reached → reach + touch (caller seeds baselines)',
    JSON.stringify(diffReach(null, arrived, 'me').map((e) => e.type).sort()) === '["reach","touch"]');
  const twoLimbs = B({
    rightHand: { t: { who: 'me', point: 'shoulder_l' } },
    leftHand: { t: { who: 'me', point: 'shoulder_r' } },
  });
  check('two limbs → two reach events', diffReach(null, twoLimbs, 'me').length === 2);
}

console.log('\nwords');
check("your shoulder", describeTarget(normalizeReachTarget({ who: 'me', point: 'shoulder_l' }), 'me') === 'your shoulder_l');
check("their shoulder", describeTarget(normalizeReachTarget({ who: 'mythos', point: 'shoulder_l' })) === "mythos's shoulder_l");
check('world point', describeTarget(normalizeReachTarget({ p: [1.234, 0, 2] }))?.startsWith('the point [1.23'));
check('self frame', describeTarget(normalizeReachTarget({ p: [0, 1, 0], space: 'self' }))!.includes('their own frame'));
check('your frame', describeTarget(normalizeReachTarget({ p: [0, 1, 0], space: 'me' }), 'me')!.includes('your frame'));

console.log(failures ? `\n\x1b[31m${failures} failing\x1b[0m` : '\n\x1b[32mall passing\x1b[0m');
process.exit(failures ? 1 : 0);
