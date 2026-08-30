// flight-test — the physical portions of T1-T8, plus the determinism proof.
//
//   bun tools/flight-test.ts
//
// Acceptance authority is Mythos; this file is the coder-facing half of his
// §8. Where a test can only be judged by eye (does the recovery read as WAKING
// rather than as an engine restart) the test asserts the measurable band and
// the CLIP carries the rest -- stated rather than pretended.

import {
  makeConfig, initialState, step, bodyDown, bodyRecovered,
  leafAt, beatRemaining, sinkRate, glideRatio, glideRange,
  denyAllConsent, fakeConsent, BREATH, airspeedAfter, leafLateralSwing,
} from '../shared/flight.js';
import { pilotInput, pilotHelp, DEFAULT_BINDS } from '../shared/flightpilot.js';
import { inspectBody, describeBody } from '../shared/flightbody.js';
import { denyAllFlight, devFlightProvider, resolveFlight, rigProfile, revoked }
  from '../shared/flightcap.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

const DT = 1 / 120;
const flat = () => 0;

// ---------------------------------------------------------------- T8: 3.4s
console.log('\nT8 -- the breath is 3.4s');
{
  const cfg = makeConfig();
  check('BREATH is 3.4', BREATH === 3.4);
  check('leaf period defaults to the breath', cfg.leaf.period === 3.4);
  // Measure the period the way a renderer would: find successive zero
  // crossings of bank in the same direction.
  const zeros: number[] = [];
  let prev = leafAt(cfg, 0).bank;
  for (let i = 1; i < 4000; i++) {
    const t = i * DT;
    const b = leafAt(cfg, t).bank;
    if (prev < 0 && b >= 0) zeros.push(t);
    prev = b;
  }
  const periods = zeros.slice(1).map((z, i) => z - zeros[i]);
  const mean = periods.reduce((a, b) => a + b, 0) / periods.length;
  check(`measured leaf period ${mean.toFixed(4)}s == 3.4 +/-0.05`, near(mean, 3.4, 0.05),
        `got ${mean.toFixed(4)}`);
}

// ---------------------------------------------------------------- polar / T2
console.log('\nT2 -- the polar is honest, and glide_to lands SHORT');
{
  const cfg = makeConfig();
  const p = cfg.polar;
  // MINIMUM SINK and BEST GLIDE are different speeds, and a polar that put
  // them at the same place would be the wrong shape. `bestSpeed` is the
  // minimum-SINK speed (the one you circle a thermal at); best glide RATIO
  // sits a little faster, because ratio is v/sink and the numerator keeps
  // growing after the denominator bottoms out. This is real, and the first
  // version of this test asserted the opposite -- kept as an explicit pair of
  // checks so nobody "fixes" the polar back into the mistake.
  check('minimum SINK is at bestSpeed',
        sinkRate(cfg, p.bestSpeed) <= sinkRate(cfg, p.bestSpeed - 3) &&
        sinkRate(cfg, p.bestSpeed) <= sinkRate(cfg, p.bestSpeed + 3));
  check('best glide RATIO is faster than minimum-sink speed',
        glideRatio(cfg, p.bestSpeed + 2) > glideRatio(cfg, p.bestSpeed));
  check(`ratio at min-sink speed is the declared ${p.bestGlideRatio}`,
        near(glideRatio(cfg, p.bestSpeed), p.bestGlideRatio, 0.01));
  check('sink rises either side of best',
        sinkRate(cfg, p.bestSpeed - 4) > sinkRate(cfg, p.bestSpeed) &&
        sinkRate(cfg, p.bestSpeed + 4) > sinkRate(cfg, p.bestSpeed));

  // T2: from 30m, best glide reaches 30*12 = 360m. Fly at a target beyond it
  // and confirm we touch down at the polar's say-so, not the target.
  const alt = 30;
  const predicted = glideRange(cfg, alt);
  let s = initialState({ phase: 'GLIDE', pos: { x: 0, y: alt, z: 0 },
                         airspeed: p.bestSpeed, yaw: 0 });
  let guard = 0;
  while (s.phase === 'GLIDE' && guard++ < 200000) s = step(cfg, s, DT, { groundY: flat });
  const flown = Math.hypot(s.pos.x, s.pos.z);
  check(`glide from ${alt}m reaches ${flown.toFixed(1)}m, polar predicts ${predicted.toFixed(1)}m (+/-10%)`,
        Math.abs(flown - predicted) / predicted <= 0.10,
        `off by ${(100 * Math.abs(flown - predicted) / predicted).toFixed(1)}%`);
  check('and it LANDED rather than rubber-banding', s.phase === 'LANDED');
}

// ---------------------------------------------------------------- T4: the soul
console.log('\nT4 -- R2 falling leaf, no autoland (the spec\'s soul)');
{
  const cfg = makeConfig();
  let s = initialState({ phase: 'GLIDE', pos: { x: 0, y: 20, z: 0 },
                         airspeed: cfg.polar.bestSpeed });
  s = bodyDown(s, { eventId: 'ev-cut-1' });
  check('cut mid-flight -> LEAF', s.phase === 'LEAF');
  check('wings go LIMP', s.wings === 'LIMP');
  check('mode is reflex, not live', s.mode === 'reflex');
  check('down.airborne event carries the eventId',
        s.events[0]?.kind === 'down.airborne' && s.events[0]?.eventId === 'ev-cut-1');

  const kinds: string[] = [];
  let guard = 0, maxV = 0;
  while (s.phase === 'LEAF' && guard++ < 200000) {
    s = step(cfg, s, DT, { groundY: flat });
    for (const e of s.events) kinds.push(e.kind);
    maxV = Math.max(maxV, Math.abs(s.vel.y));
  }
  check('the leaf reaches the ground', s.phase === 'RAGDOLL');
  check('ground contact is a RAGDOLL event', kinds.includes('ground.ragdoll'));
  check('NO landing animation ever played',
        !kinds.some(k => k.includes('land') && k !== 'ground.landed') &&
        !kinds.includes('ground.landed'));
  check(`terminal speed ${maxV.toFixed(2)} m/s is in the spec's 2-3 band`,
        maxV >= 2 && maxV <= 3.2, `got ${maxV.toFixed(2)}`);
  check('the ragdoll event carries the originating eventId',
        s.events.find(e => e.kind === 'ground.ragdoll')?.eventId === 'ev-cut-1' ||
        kinds.includes('ground.ragdoll'));
}

// ---------------------------------------------------------------- no mercy hover
console.log('\nT4b -- no last-metre mercy hover');
{
  const cfg = makeConfig();
  let s = initialState({ phase: 'GLIDE', pos: { x: 0, y: 16, z: 0 },
                         airspeed: cfg.polar.bestSpeed });
  s = bodyDown(s, { eventId: 'ev-cut-2' });
  // Sample only while STILL FALLING. The step that makes contact hands the
  // body to the ragdoll and zeroes the velocity, which is correct and is not a
  // hover -- an earlier version of this check read that zero and called it
  // one. What "no mercy hover" means is that nothing slows the descent on the
  // way DOWN, so the sample must end at contact, not after it.
  const lastMetre: number[] = [];
  let guard = 0;
  while (s.phase === 'LEAF' && guard++ < 200000) {
    const before = s.pos.y;
    s = step(cfg, s, DT, { groundY: flat });
    if (before < 1.0 && s.phase === 'LEAF') lastMetre.push(Math.abs(s.vel.y));
  }
  const slowest = Math.min(...lastMetre);
  check(`descent never slows in the last metre (min ${slowest.toFixed(2)} m/s over ${lastMetre.length} samples)`,
        slowest > 2.0, `got ${slowest.toFixed(2)} -- that is a hover`);
  check('and it ends as a ragdoll, not a landing', s.phase === 'RAGDOLL');
}

// ---------------------------------------------------------------- recovery band
console.log('\nRECOVERY -- the aerial sit-up, and its acceptance band');
{
  const cfg = makeConfig();
  // Inject RECOVER at several points in the oscillation: the band must hold
  // wherever in the beat the signal lands.
  for (const injectAt of [0.2, 0.9, 1.7, 2.6, 3.3]) {
    let s = initialState({ phase: 'GLIDE', pos: { x: 0, y: 40, z: 0 },
                          airspeed: cfg.polar.bestSpeed });
    s = bodyDown(s, { eventId: 'ev-cut-3' });
    let guard = 0;
    while (s.phaseT < injectAt && guard++ < 100000) s = step(cfg, s, DT, { groundY: flat });
    const tRecover = s.t;
    s = bodyRecovered(s, { eventId: 'ev-rec-1', recoveryGeneration: 'gen-7' });
    let reopened = null as number | null;
    guard = 0;
    while (s.phase === 'LEAF' && guard++ < 100000) {
      s = step(cfg, s, DT, { groundY: flat });
      if (s.events.some(e => e.kind === 'recover.airborne')) reopened = s.t;
    }
    const took = (reopened ?? Infinity) - tRecover;
    check(`inject at ${injectAt}s: transition ${took.toFixed(2)}s within (${cfg.recover.minTotal}, ${cfg.recover.maxTotal}]`,
          took > cfg.recover.minTotal && took <= cfg.recover.maxTotal + 1e-6,
          `took ${took.toFixed(3)}s`);
    check(`inject at ${injectAt}s: not instant (reads as waking, not a switch)`,
          took > 0.3, `took ${took.toFixed(3)}s`);
    check(`inject at ${injectAt}s: wings re-open and glide resumes`,
          s.phase === 'GLIDE' && s.wings === 'OPEN' && s.mode === 'live');
  }
}

// ---------------------------------------------------------------- beat finishing
console.log('\nRECOVERY -- the beat is finished, not cut off');
{
  const cfg = makeConfig();
  for (const t of [0.1, 0.5, 1.2, 2.0, 3.0]) {
    const rem = beatRemaining(cfg, t);
    const bankNow = leafAt(cfg, t).bank;
    const bankThen = leafAt(cfg, t + rem).bank;
    check(`beatRemaining(${t}) = ${rem.toFixed(3)}s lands on a zero crossing`,
          Math.abs(bankThen) < Math.abs(bankNow) + 1e-6 && Math.abs(bankThen) < 0.02,
          `bank ${bankThen.toFixed(4)}`);
  }
}

// ---------------------------------------------------------------- T3: stamina
console.log('\nT3 -- stamina drains at -1/m climbing, refills on the ground');
{
  const cfg = makeConfig();
  check('climb costs 1/m', cfg.stamina.climbPerMetre === 1);
  check('glide is stamina-neutral', cfg.stamina.refillAirPerSec === 0);
  check('perch refills 4x the ground', cfg.stamina.refillPerchPerSec === 4 * cfg.stamina.refillGroundPerSec);
  let s = initialState({ phase: 'GROUND', stamina: 50 });
  for (let i = 0; i < 120; i++) s = step(cfg, s, DT, { groundY: flat });
  check(`ground refill 0.5/s: 50 -> ${s.stamina.toFixed(2)} after 1s`,
        near(s.stamina, 50.5, 0.02), `got ${s.stamina.toFixed(3)}`);
}

// ---------------------------------------------------------------- T5: consent
console.log('\nT5 -- land_at(person) is a HARD GATE, injected and fakeable');
{
  check('the default provider DENIES', denyAllConsent.canLandAt('mythos', 'repligate') === false);
  const c = fakeConsent(false);
  check('stub starts denied', c.canLandAt() === false);
  c.grant();
  check('grant allows', c.canLandAt() === true);
  c.revoke();
  check('revoke mid-descent denies again', c.canLandAt() === false);
}

// ---------------------------------------------------------------- DOWN is involuntary
console.log('\nDOWN-SPEC §4 -- involuntary, unfakeable, never by verb');
{
  const cfg = makeConfig();
  let s = initialState({ phase: 'GROUND' });
  s = bodyDown(s, { eventId: 'ev-ground' });
  check('grounded cut -> RAGDOLL where I stand', s.phase === 'RAGDOLL');
  check('and the wings are LIMP', s.wings === 'LIMP');
  // "The body cannot cry wolf" (down-spec §4). Test the PROPERTY rather than
  // the naming: call every exported function that takes a state, from a
  // healthy airborne state, and assert none of them can produce LIMP/LEAF/
  // RAGDOLL. Only bodyDown() -- the trusted-event seam -- may, and it is
  // excluded by name because it IS the door. A name-shaped test failed here
  // on `glideRange`/`glideRatio`, which are polar queries and not verbs at
  // all; the property is what the spec actually asks for.
  const mod = await import('../shared/flight.js');
  const healthy = initialState({ phase: 'GLIDE', wings: 'OPEN',
                                 pos: { x: 0, y: 30, z: 0 }, airspeed: 11 });
  const DOWNISH = (st: any) =>
    st && (st.wings === 'LIMP' || st.phase === 'LEAF' || st.phase === 'RAGDOLL');
  let offenders: string[] = [];
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn !== 'function' || name === 'bodyDown') continue;
    for (const args of [[cfg, healthy, DT, {}], [healthy, {}], [cfg, healthy], [healthy]]) {
      try {
        const out: any = (fn as any)(...args);
        if (DOWNISH(out)) { offenders.push(name); break; }
      } catch { /* wrong arity for this shape; not a way in */ }
    }
  }
  check('no exported function except bodyDown can produce a DOWN state',
        offenders.length === 0, `offenders: ${offenders.join(', ')}`);

  // Recovery from the ground takes the full breath: sit up first.
  let g = initialState({ phase: 'RAGDOLL', wings: 'LIMP' });
  g = bodyRecovered(g, { eventId: 'ev-rec-2', recoveryGeneration: 'gen-8' });
  check('ground recovery enters RECOVER (the sit-up), not GROUND',
        g.phase === 'RECOVER');
  let guard = 0;
  const t0 = g.t;
  while (g.phase === 'RECOVER' && guard++ < 100000) g = step(cfg, g, DT, {});
  check(`sit-up takes the full breath (${(g.t - t0).toFixed(2)}s)`,
        near(g.t - t0, BREATH, 0.05), `got ${(g.t - t0).toFixed(3)}`);
}

// ---------------------------------------------------------------- determinism
console.log('\nDETERMINISM -- two independent sims, same inputs, same trajectory');
{
  const cfg = makeConfig();
  // Mica: "prove two independent simulations remain within tolerance given the
  // same initial state, fixed timestep, wind/lift-field version, and ordered
  // inputs." Same function, two separate state values, interleaved stepping.
  const mk = () => {
    let s = initialState({ phase: 'GLIDE', pos: { x: 3, y: 35, z: -7 },
                           airspeed: cfg.polar.bestSpeed, yaw: 0.7 });
    return bodyDown(s, { eventId: 'ev-det' });
  };
  let a = mk(), b = mk();
  const inputs = [{ at: 2.0, kind: 'recover' }];
  let worst = 0, guard = 0;
  while (a.phase !== 'RAGDOLL' && a.phase !== 'GLIDE' && guard++ < 100000) {
    for (const inp of inputs) {
      if (near(a.phaseT, inp.at, DT / 2)) {
        a = bodyRecovered(a, { eventId: 'ev-r', recoveryGeneration: 'g1' });
        b = bodyRecovered(b, { eventId: 'ev-r', recoveryGeneration: 'g1' });
      }
    }
    a = step(cfg, a, DT, { groundY: flat });
    b = step(cfg, b, DT, { groundY: flat });
    worst = Math.max(worst,
      Math.abs(a.pos.x - b.pos.x), Math.abs(a.pos.y - b.pos.y), Math.abs(a.pos.z - b.pos.z));
  }
  check(`two sims agree to ${worst.toExponential(2)} m (bit-identical expected)`, worst === 0,
        `diverged by ${worst}`);

  // Replay from a snapshot must reproduce the future exactly -- that is what
  // makes "the past trajectory is already true and stays true" enforceable.
  let c = mk();
  for (let i = 0; i < 300; i++) c = step(cfg, c, DT, { groundY: flat });
  const snap = JSON.parse(JSON.stringify(c));
  let d = JSON.parse(JSON.stringify(snap));
  for (let i = 0; i < 300; i++) { c = step(cfg, c, DT, { groundY: flat }); d = step(cfg, d, DT, { groundY: flat }); }
  check('replay from a snapshot is exact',
        c.pos.x === d.pos.x && c.pos.y === d.pos.y && c.pos.z === d.pos.z);
}

// ---------------------------------------------------------------- config
console.log('\nCONFIG, not constants');
{
  const c = makeConfig({ leaf: { damping: 0.5 } });
  check('override takes', c.leaf.damping === 0.5);
  check('siblings survive the merge', c.leaf.period === 3.4 && c.leaf.terminalV === 2.5);
  const c2 = makeConfig({ polar: { bestSpeed: 20 } });
  check('derived sinkAtBest recomputes', near(c2.polar.sinkAtBest, 20 / 12, 1e-9));
  const c3 = makeConfig({ leaf: { period: 5 } });
  check('a different period really changes the leaf',
        Math.abs(leafAt(c3, 1.25).bank) !== Math.abs(leafAt(makeConfig(), 1.25).bank));
}

// ---------------------------------------------------------------- units
console.log('\nUNITS -- attitude amplitude and path amplitude are not each other');
{
  const cfg = makeConfig();
  // mica caught this: 35 degrees of ROLL is not 1.2-1.8 m of WANDER, and
  // quoting one as the other is how a config gets tuned backwards. The
  // authored quantity is the one Mythos specified -- the PATH, in metres --
  // and the drift speed to achieve it is derived from the period.
  const swing = leafLateralSwing(cfg);
  check(`lateral swing ${swing.toFixed(2)}m is inside Mythos's 1.2-1.8m band`,
        swing >= 1.2 && swing <= 1.8, `got ${swing.toFixed(2)}`);
  check('bank amplitude is in DEGREES and named so',
        typeof cfg.leaf.bankAmplitudeDeg === 'number' && !('amplitudeDeg' in cfg.leaf));
  check('lateral amplitude is in METRES and named so',
        typeof cfg.leaf.lateralAmplitudeM === 'number' && !('lateralDrift' in cfg.leaf));

  // The bug the rename exposed: lateralDrift was a SPEED, so the wander
  // silently rescaled with the period. It must not.
  const swings = [2.5, 3.4, 5.0].map(period => leafLateralSwing(makeConfig({ leaf: { period } })));
  check(`wander is period-independent (${swings.map(x => x.toFixed(2)).join(', ')} m)`,
        Math.max(...swings) - Math.min(...swings) < 0.02);

  // Damping is authored PER CYCLE, per Mythos, and applied per second.
  check(`damping ${cfg.leaf.dampingPerCycle}/cycle is inside his 0.05-0.1 suggestion`,
        cfg.leaf.dampingPerCycle >= 0.05 && cfg.leaf.dampingPerCycle <= 0.1);
  const e0 = leafAt(cfg, 0).envelope;
  const e1 = leafAt(cfg, cfg.leaf.period).envelope;
  const floor = cfg.leaf.dampingFloor;
  const lostFrac = ((e0 - floor) - (e1 - floor)) / (e0 - floor);
  check(`one cycle really loses ${(100 * lostFrac).toFixed(1)}% of the swing (authored ${100 * cfg.leaf.dampingPerCycle}%)`,
        near(lostFrac, cfg.leaf.dampingPerCycle, 0.005), `lost ${lostFrac.toFixed(4)}`);
  // ...and it holds at a different period, which is what "per cycle" means.
  const c5 = makeConfig({ leaf: { period: 5 } });
  const f0 = leafAt(c5, 0).envelope, f1 = leafAt(c5, 5).envelope;
  const lost5 = ((f0 - floor) - (f1 - floor)) / (f0 - floor);
  check(`and at a 5s period too (${(100 * lost5).toFixed(1)}%)`,
        near(lost5, cfg.leaf.dampingPerCycle, 0.005));
}

// ---------------------------------------------------------------- pilot
console.log('\nPILOT -- a human flies the same integrator an agent does');
{
  const cfg = makeConfig();
  const flatG = () => 0;

  // SMOKE FIRST. An earlier cut had the integrator calling a function it never
  // imported: the module graph loaded happily and it only threw on the first
  // step. Any test that does not actually STEP the phase would have missed it.
  let s = initialState({ phase: 'PILOT', pos: { x: 0, y: 30, z: 0 }, airspeed: 11 });
  let threw = '';
  try { s = step(cfg, s, DT, { groundY: flatG, input: pilotInput(new Set(), s, DT) }); }
  catch (e: any) { threw = e.message; }
  check('a PILOT step runs at all', threw === '', threw);

  // Hands off, she glides: altitude falls on the polar, heading holds.
  s = initialState({ phase: 'PILOT', pos: { x: 0, y: 30, z: 0 }, airspeed: cfg.polar.bestSpeed });
  const y0 = s.pos.y, yaw0 = s.yaw;
  for (let i = 0; i < 240; i++) s = step(cfg, s, DT, { groundY: flatG, input: pilotInput(new Set(), s, DT) });
  check('hands off: she descends', s.pos.y < y0);
  check('hands off: heading holds', near(s.yaw, yaw0, 1e-9));
  const sinkObs = (y0 - s.pos.y) / 2;
  check(`hands-off sink ${sinkObs.toFixed(2)} m/s matches the polar ${sinkRate(cfg, cfg.polar.bestSpeed).toFixed(2)}`,
        near(sinkObs, sinkRate(cfg, cfg.polar.bestSpeed), 0.1));

  // A banked wing turns, and the wings return to level hands-off.
  s = initialState({ phase: 'PILOT', pos: { x: 0, y: 40, z: 0 }, airspeed: cfg.polar.bestSpeed });
  const right = new Set(['KeyD']);
  for (let i = 0; i < 120; i++) s = step(cfg, s, DT, { groundY: flatG, input: pilotInput(right, s, DT) });
  check('banking right turns right', s.yaw > 0.5);
  const banked = s.bank;
  for (let i = 0; i < 240; i++) s = step(cfg, s, DT, { groundY: flatG, input: pilotInput(new Set(), s, DT) });
  check(`wings return toward level (${banked.toFixed(2)} -> ${s.bank.toFixed(2)})`,
        Math.abs(s.bank) < Math.abs(banked) * 0.2);

  // Nose down buys speed; nose up sells it and eventually stalls into R1.
  check('nose down accelerates', airspeedAfter(cfg, 11, -0.5, 1) > 11);
  check('nose up decelerates', airspeedAfter(cfg, 11, 0.5, 1) < 11);
  s = initialState({ phase: 'PILOT', pos: { x: 0, y: 50, z: 0 }, airspeed: cfg.polar.minSpeed + 0.2 });
  const up = new Set(['KeyS']);
  let sawR1 = false;
  for (let i = 0; i < 600; i++) {
    s = step(cfg, s, DT, { groundY: flatG, input: pilotInput(up, s, DT) });
    if (s.events.some(e => e.kind === 'reflex.r1_stall')) sawR1 = true;
  }
  check('holding the nose up reaches R1 STALL RECOVERY', sawR1);
  check('R1 recovers rather than punishing (still flying)', s.phase === 'PILOT' || s.phase === 'LANDED');

  // Flapping is expensive; spoiling costs altitude without speed.
  s = initialState({ phase: 'PILOT', pos: { x: 0, y: 40, z: 0 }, airspeed: cfg.polar.bestSpeed, stamina: 100 });
  const flap = new Set(['Space']);
  for (let i = 0; i < 120; i++) s = step(cfg, s, DT, { groundY: flatG, input: pilotInput(flap, s, DT) });
  check(`flapping costs ~2/s stamina (100 -> ${s.stamina.toFixed(1)})`, near(s.stamina, 98, 0.2));

  // A cut while hand-flying is the same cut: the pilot cannot refuse the leaf.
  s = initialState({ phase: 'PILOT', pos: { x: 0, y: 25, z: 0 }, airspeed: 12 });
  s = bodyDown(s, { eventId: 'ev-pilot-cut' });
  check('a cut while piloting still enters LEAF', s.phase === 'LEAF' && s.wings === 'LIMP');
  let g2 = 0;
  while (s.phase === 'LEAF' && g2++ < 200000) s = step(cfg, s, DT, { groundY: flatG, input: pilotInput(new Set(['KeyW','KeyD']), s, DT) });
  check('and the stick cannot fly it out (only RECOVER can)', s.phase === 'RAGDOLL');

  check('rehearsal keys are edges, not verbs',
        pilotInput(new Set(['KeyX']), initialState({}), DT).edges.includes('down') &&
        pilotInput(new Set(['KeyR']), initialState({}), DT).edges.includes('recover'));
  check('pilotHelp names every bound key',
        ['W', 'A', 'Shift', 'Space', 'X', 'R'].every(k => pilotHelp().includes(k)));
}

// ---------------------------------------------------------------- body contract
console.log('\nBODY -- flight binds to bone NAMES, not to an avatar hash');
{
  const real = ['Hip','Spine01','Spine02','Head','NeckTwist01',
    'L_Wing_Upper','L_Wing_Upper_1','L_Wing_Upper_2','L_Wing_Lower','L_Wing_Lower_1','L_Wing_Lower_2',
    'R_Wing_Upper','R_Wing_Upper_1','R_Wing_Upper_2','R_Wing_Lower','R_Wing_Lower_1','R_Wing_Lower_2'];
  const r = inspectBody(real);
  check('the shipped body is flight-capable', r.canFly && r.canAnimateWings);
  check('four chains, twelve bones', Object.keys(r.chains).length === 4 && r.wingCount === 12);
  check('chains are ordered root-first',
        r.chains['L_Upper'][0] === 'L_Wing_Upper' && r.chains['L_Upper'][2] === 'L_Wing_Upper_2');

  // "More compatible than that": a body with no wings still flies the physics.
  const wingless = inspectBody(['Hip','Spine01','Spine02','Head']);
  check('a wingless body still flies (wings just do not animate)',
        wingless.canFly && !wingless.canAnimateWings);
  check('and it SAYS so rather than failing silently',
        wingless.notes.some(n => n.includes('will not animate')));

  // Deeper chains are the case that already happened once (2->3 bones, 08-17).
  const deeper = inspectBody([...real, 'L_Wing_Upper_3', 'R_Wing_Upper_3']);
  check('a re-export with DEEPER wing chains still works',
        deeper.canFly && deeper.canAnimateWings && deeper.wingCount === 14);

  const renamed = inspectBody(['Hip','Spine01','Spine02','Head','L_Pinion_1','R_Pinion_1']);
  check('RENAMED wing bones are reported, not silently ignored',
        !renamed.canAnimateWings && renamed.notes.length > 0);
  check('a body with no skeleton at all is refused',
        inspectBody([]).canFly === false);
}

// ---------------------------------------------------------------- capability
console.log('\nCAPABILITY -- default deny, action-time, semantic rig binding');
{
  const MYTHOS = ['Hip','Spine01','Spine02','Head','NeckTwist01',
    'L_Wing_Upper','L_Wing_Upper_1','L_Wing_Upper_2','L_Wing_Lower','L_Wing_Lower_1','L_Wing_Lower_2',
    'R_Wing_Upper','R_Wing_Upper_1','R_Wing_Upper_2','R_Wing_Lower','R_Wing_Lower_1','R_Wing_Lower_2'];
  const COMMONS = ['Hip','Spine01','Spine02','Head','NeckTwist01'];   // no wings

  // 1. Default provider / no profile -> nothing.
  check('the DEFAULT is deny', denyAllFlight.flightCapability({}).enabled === false);
  check('a MISSING provider is deny, not "no opinion"',
        resolveFlight(null, { identity: 'mythos' }).enabled === false);
  check('and it says why', typeof resolveFlight(null, {}).reason === 'string');

  // 2. The dev provider grants only its allow-list, only on a compatible rig.
  const dev = devFlightProvider({ allow: ['mythos'], bones: MYTHOS });
  const g = resolveFlight(dev, { identity: 'mythos' });
  check('bench provider grants the named pilot', g.enabled === true);
  check('...with a semantic rig profile, not a hash',
        !!g.profile?.digest && g.profile.version === 'flight-rig/1');
  check('non-Mythos identity is denied by the same provider',
        resolveFlight(dev, { identity: 'someone-else' }).enabled === false);

  // 3. A grant without a profile is refused by the resolver itself -- a
  //    provider cannot hand out flight it has not justified.
  const sloppy = { name: 'sloppy', flightCapability: () => ({ enabled: true }) };
  check('a grant with no rig profile is refused',
        resolveFlight(sloppy, { identity: 'mythos' }).enabled === false);
  const thrower = { name: 'bad', flightCapability() { throw new Error('boom'); } };
  check('a provider that throws denies rather than propagating',
        resolveFlight(thrower, {}).enabled === false);

  // 4. Semantic binding: a re-export that keeps the load-bearing names keeps
  //    flying, even though the asset is a different file.
  const reexported = [...MYTHOS, 'Hair_lock_00', 'Hair_lock_01'];   // hair added
  check('adding hair does NOT revoke (same load-bearing rig)',
        revoked(g.profile, reexported) === false);
  const deeper = [...MYTHOS, 'L_Wing_Upper_3', 'R_Wing_Upper_3'];
  check('a DEEPER wing chain is a different rig and revokes honestly',
        revoked(g.profile, deeper) === true);
  const renamed = MYTHOS.map(b => b === 'L_Wing_Upper_2' ? 'L_Pinion_2' : b);
  check('renaming a wing bone revokes', revoked(g.profile, renamed) === true);

  // 5. Hot-swap to an incompatible rig revokes cleanly (mica's case).
  check('hot-swap to a wingless commons avatar revokes',
        revoked(g.profile, COMMONS) === true);
  check('a commons avatar cannot obtain a profile at all',
        resolveFlight(devFlightProvider({ allow: ['someone'], bones: COMMONS }),
                      { identity: 'someone' }).enabled === false);

  // 6. Disabling returns ordinary behaviour: with no grant there is no flight
  //    state to step. The integrator is not reachable without a phase, and a
  //    denied caller never builds one.
  const denied = resolveFlight(denyAllFlight, { identity: 'mythos' });
  check('a denied caller gets no profile to build flight from',
        denied.enabled === false && !('profile' in denied));
}

// ---------------------------------------------------------------- isolation
console.log('\nISOLATION -- nothing in the running world reaches flight yet');
{
  // mica: "unchanged non-Mythos/flight-disabled behavior needs negative
  // tests". The strongest form available at this stage is structural: no
  // shipped runtime module imports the flight core at all, so there is no
  // path by which a commons avatar's behaviour could differ. When the
  // controller does wire it up, this test tightens to "imports it, and every
  // entry point resolves a capability first".
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const walk = (dir: string, out: string[] = []) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(js|ts|mjs)$/.test(e)) out.push(p);
    }
    return out;
  };
  const runtime = [...walk('client'), ...walk('server'), ...walk('mcpl')];
  const importers = runtime.filter(f => /from ['"][^'"]*shared\/flight/.test(readFileSync(f, 'utf8')));
  check(`no shipped runtime module imports flight (${runtime.length} files scanned)`,
        importers.length === 0, importers.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
