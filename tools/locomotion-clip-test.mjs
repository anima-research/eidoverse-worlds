// locomotion-clip-test — the clip-selection policy the controller ships (#196 review B2).
//
// Drives the REAL client/lib/locomotion_clip.js (no stub, no copy: the module under test is the module
// controller.js imports) plus a wiring check that controller.js actually calls it.
//
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/locomotion-clip-test.mjs
//
// Each of these mutations of the PRODUCT must turn a named check red:
//   selectClip: drop `wantMove &&`              → intent selection (walk→idle on release)
//   selectClip: FADE_PRESS/FADE_WALKOFF swapped → the press/walk-off distinction
//   selectClip: `jumped ? … : …` → one branch   → ditto, via opts
//   selectClip: AIRBORNE_GRACE 0.04 → 0         → the stair-step guard
//   selectClip: RUN_SPEED 2.6 → 99              → walk/run split
//   controller.js: stop calling selectClip      → the wiring check (an extracted policy nobody calls
//                                                 is the regression extraction invites — antra's #180
//                                                 pattern: removing the real wiring must go red)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { selectClip, AIRBORNE_GRACE, RUN_SPEED, FADE_PRESS, FADE_WALKOFF } from '../client/lib/locomotion_clip.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0, n = 0;
const check = (name, cond) => { n++; if (cond) { console.log(`✓ ${name}`); } else { fail++; console.log(`✗ ${name}`); } };

// ---- intent, not coasting speed: the fix this PR advertises
check('key down at walking speed → walk',
  selectClip({ wantMove: true, speed: 1.2 }).clip === 'walk');
check('key RELEASED while speed still coasts → idle, not walk',
  selectClip({ wantMove: false, speed: 1.2 }).clip === 'idle');
check('key released at a dead stop → idle',
  selectClip({ wantMove: false, speed: 0 }).clip === 'idle');
check('key down but below the move epsilon → idle',
  selectClip({ wantMove: true, speed: 0.01 }).clip === 'idle');

// ---- walk / run split
check('a brisk 3.1 m/s is a run',
  selectClip({ wantMove: true, speed: 3.1 }).clip === 'run');   // literal: asserting against RUN_SPEED moves with the mutation
check('a walking 2.5 m/s is a walk',
  selectClip({ wantMove: true, speed: 2.5 }).clip === 'walk');
check('the walk/run split sits at a human walking speed',
  RUN_SPEED > 1.5 && RUN_SPEED < 4);

// ---- jump: the same clip, two different blends
const press = selectClip({ jumped: true, airborneFor: 0 });
check('a deliberate press selects jump on its first airborne frame', press.clip === 'jump');
check('a press blends with the SNAPPY fade and does not ease',
  press.opts?.fade === 0.1 && !press.opts?.ease);   // literal: asserting === FADE_PRESS moves with the mutation

const walkOff = selectClip({ jumped: false, airborneFor: 0.05, wantMove: true, speed: 1.5 });   // literal: > the 0.04 grace
check('walking off an edge past the grace window selects jump', walkOff.clip === 'jump');
check('a walk-off EASES in over the longer fade',
  walkOff.opts?.fade === 0.5 && walkOff.opts?.ease === true);   // literal, per above
check('press and walk-off are distinguishable (the whole point of the opts)',
  press.opts.fade !== walkOff.opts.fade);
check('the press fade is SHORTER than the walk-off (snappy vs eased, not merely different)',
  press.opts.fade < walkOff.opts.fade);

// ---- the stair-step guard
check('a 1-frame drop inside the grace window is NOT a jump',
  selectClip({ jumped: false, airborneFor: 0.03, wantMove: true, speed: 1.5 }).clip === 'walk');   // literal: < the 0.04 grace
check('the grace window is ~2 frames, not zero and not a shrug',
  AIRBORNE_GRACE > 0.02 && AIRBORNE_GRACE < 0.09);

// ---- precedence
check('a mantle outranks everything',
  selectClip({ mantle: true, jumped: true, wantMove: true, speed: 3 }).clip === 'climb');
check('jump outranks locomotion',
  selectClip({ jumped: true, wantMove: true, speed: 1.5 }).clip === 'jump');
check('moving outranks a held posture',
  selectClip({ wantMove: true, speed: 1.2, posture: 'sit' }).clip === 'walk');
check('a seat with a chair gives sitchair',
  selectClip({ posture: 'sit', seat: { chair: true } }).clip === 'sitchair');
check('a seat with no chair gives sit',
  selectClip({ posture: 'sit', seat: {} }).clip === 'sit');
check('lie posture',
  selectClip({ posture: 'lie' }).clip === 'lie');
check('nothing claims the body → idle', selectClip({}).clip === 'idle');

// ---- only jump carries options
check('non-jump clips carry no options (setClip defaults)',
  selectClip({ wantMove: true, speed: 1.2 }).opts === undefined && selectClip({}).opts === undefined);

// ---- the wiring: an extracted policy nobody calls is the regression extraction invites
const ctl = readFileSync(join(here, '../client/lib/controller.js'), 'utf8');
check('controller.js imports the real policy module',
  /import\s*\{[^}]*\bselectClip\b[^}]*\}\s*from\s*'\.\/locomotion_clip\.js'/.test(ctl));
check('controller.js CALLS selectClip in its tick',
  /\bselectClip\s*\(/.test(ctl));
check('controller.js passes the selected opts to setClip (not a re-derived literal)',
  /setClip\([^)]*\.opts\s*\)/.test(ctl));
// Scoped to the setClip call, not the whole file: a file-wide grep for `fade: 0.5` would go red on
// an unrelated future fade elsewhere in controller.js — an assertion that fails on innocent code is
// as bad as one that passes on broken code.
// The LOCOMOTION call specifically: controller.js also has the flight path's `me.setClip(clip, speed)`
// at :625, which takes no options at all — matching the first `me.setClip(` would assert the wrong line.
const setClipCall = ctl.split('\n').find((l) => /me\.setClip\([^)]*,[^)]*,/.test(l)) ?? '';
check('the tick hands setClip the SELECTED opts, with no fade re-derived at the call site',
  /\.opts\s*\)/.test(setClipCall) && !/fade:/.test(setClipCall), `call site: ${setClipCall.slice(0, 80)}`);

console.log(`\n${n - fail}/${n} passed`);
process.exit(fail ? 1 : 0);
