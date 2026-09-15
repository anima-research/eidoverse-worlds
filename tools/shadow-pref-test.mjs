// The resident's shadow switch and the chest lamp's casting slot must agree
// (client/lib/lightrig.js). Written because they didn't, and the symptom was
// Janus's: "currently when i load it shadows arent being cast by the body at
// all" -- on a build where every body mesh had correct cast/receive flags.
//
// Two independent halves of one switch:
//   1. BOOT. slot 0 is born casting. With the preference off, shadowMap.enabled
//      was false, so the lamp was a casting light whose shadows were never
//      drawn -- and the boot state disagreed with the switch.
//   2. FLIP. setShadows() wrote renderer.shadowMap.enabled and sun.castShadow
//      and nothing else, so the lamp slot never followed the switch in either
//      direction. Turning shadows back ON did not restore the lamp, because the
//      slot is constructed once at boot and never revisited.
//
// lightrig reads the preference AT IMPORT, so the boot cases cannot share a
// module instance. Each runs in its own subprocess with its own localStorage;
// the parent below is the case runner. `--case <name>` is the child entry.
//
// MUTATION CONTROL: `--mutate <n>` reverts one half of the fix in the child, so
// the suite can prove it fails. Run `bun tools/shadow-pref-test.mjs --mutants`
// to check every control still kills the test (that is the guard against this
// file joining the suite as decoration).
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };

const ARGV = process.argv.slice(2);
const argOf = (f) => { const i = ARGV.indexOf(f); return i < 0 ? null : ARGV[i + 1]; };
const CASE = argOf('--case');
const MUTATE = argOf('--mutate');

// ---- the child: one boot state, measured -----------------------------------

if (CASE) {
  const { plugin } = await import('bun');
  const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
  plugin({ name: 'core-stub', setup(build) {
    build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    build.onResolve({ filter: /^\.\/assets\.js$/ }, () => ({ path: here('./assets-stub.mjs') }));
    build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
  } });

  // the preference, set BEFORE the import that reads it
  if (CASE === 'boot-off') localStorage.setItem('ew-shadows', 'off');
  else localStorage.removeItem('ew-shadows');   // absent = on (the default)

  const { renderer, sun } = await import('./core-stub.mjs');
  const rig = await import('../client/lib/lightrig.js');

  // The mutation controls reproduce the state a reverted source line left
  // behind. #1 cannot be re-run at import (the slot is already born), so it is
  // written onto the live slot. A module namespace is read-only, so #2 wraps a
  // local alias rather than patching `rig.setShadows` in place.
  const lamp = () => rig.rigDebug()._slots[0];
  let setShadows = rig.setShadows;
  let updateRig = rig.updateRig;
  if (MUTATE === '1') lamp().castShadow = true;               // born casting regardless of the preference
  if (MUTATE === '2') setShadows = (on) => {                  // setShadows forgets the lamp slot
    const before = lamp().castShadow; rig.setShadows(on); lamp().castShadow = before;
  };
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
  const snap = () => { const d = rig.rigDebug(); return { pref: d.shadows.pref, map: renderer.shadowMap.enabled, sun: sun.castShadow, lamp: d.shadows.slotIsCaster }; };

  if (CASE === 'boot-on' || CASE === 'boot-off') { out({ boot: snap() }); }
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

// ---- the parent: run the cases, check the invariants -----------------------

let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };

async function runCase(name, mutate = null) {
  const args = [process.execPath, import.meta.path, '--case', name];
  if (mutate) args.push('--mutate', String(mutate));
  const p = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
  const text = p.stdout.toString();
  const line = text.split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) throw new Error(`case ${name} produced no result:\n${text}\n${p.stderr.toString()}`);
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
  c('shadow map disabled at boot', r.boot.map === false);
  // THE DEFECT: a casting lamp with the map off. Agreement is the invariant,
  // not "off" -- a lamp that casts into a disabled map is a lamp pretending.
  c('the lamp slot does NOT cast when the preference is off', r.boot.lamp === false,
    'slot 0 born casting with shadowMap.enabled=false — boot disagrees with the switch');
};
const flipChecks = (r, c = check) => {
  c('setShadows(false) disables the map', r.off.map === false);
  c('setShadows(false) stops the sun casting', r.off.sun === false);
  c('setShadows(false) stops the LAMP casting', r.off.lamp === false,
    'the lamp kept casting into a disabled shadow map');
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
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
