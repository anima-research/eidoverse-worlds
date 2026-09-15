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
  if (MUTATE === '1') lamp().castShadow = true;               // born casting regardless of the preference
  if (MUTATE === '2') setShadows = (on) => {                  // setShadows forgets the lamp slot
    const before = lamp().castShadow; rig.setShadows(on); lamp().castShadow = before;
  };
  if (MUTATE === '3') {                                      // far left at three's default
    lamp().shadow.camera.far = 500;
    const cam = lamp().shadow.camera;
    Object.defineProperty(cam, 'far', { get: () => 500, set: () => {}, configurable: true });
  }

  const out = (o) => console.log(`__RESULT__${JSON.stringify(o)}`);
  const snap = () => { const d = rig.rigDebug(); return { pref: d.shadows.pref, map: renderer.shadowMap.enabled, sun: sun.castShadow, lamp: d.shadows.lampCasting }; };

  if (CASE === 'boot-on' || CASE === 'boot-off') { out({ boot: snap() }); }
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

if (ARGV.includes('--mutants')) {
  // Each control reverts one half of the fix; the case that covers that half
  // must go red. A control that leaves the suite green means the test is not
  // measuring what its name claims.
  console.log('MUTATION CONTROLS — each must KILL its case');
  for (const [n, name, checks, label] of [
    [1, 'boot-off', bootOffChecks, 'slot born casting regardless of preference'],
    [2, 'flip', flipChecks, 'setShadows forgets the lamp slot'],
    [3, 'far', farChecks, "shadow far left at three's default 500"],
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
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
