// The ENGINE-SELECTION SEAM, tested — for the first time.
//
//   bun tools/bodysim-test.ts
//
// Every fall in the shipped client goes through bodysim.makeRagdoll, and that
// seam had zero coverage: the parity suites construct the engines directly,
// which is exactly why the dropped-seedVel incident (2026-08-04) lived for a
// month — makeRagdoll's 3-parameter signature silently ate the drag-release
// handover, both engines' seed paths were unreachable in the shipped client,
// and every suite stayed green. This file asserts the seam itself: selection,
// the verlet floor while wasm warms, the stored choice, and — the centerpiece
// — that a handover snapshot passed through the door actually lands in
// whichever engine answers.

import { plugin } from 'bun';
const STUB = new URL('./core-stub.mjs', import.meta.url).pathname;
plugin({
  name: 'core-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB }));
  },
});

// bodysim reads localStorage at import time (the stored engine choice); bun
// has none, so the seam gets the same kind of store the browser gives it
const _ls = new Map<string, string>();
(globalThis as any).localStorage ??= {
  getItem: (k: string) => _ls.get(k) ?? null,
  setItem: (k: string, v: string) => { _ls.set(k, String(v)); },
  removeItem: (k: string) => { _ls.delete(k); },
};

const { THREE } = await import('./core-stub.mjs');
const bs = await import('../client/lib/bodysim.js');
const { Ragdoll } = await import('../client/lib/ragdoll.js');
const { AmmoRagdoll } = await import('../client/lib/ammodoll.js');
const { BodyEngineBase } = await import('../client/lib/bodyengine.js');
const { rigs, makeAvatar, toppleLean } = await import('./rig-load.mjs');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

const FLEET = rigs().filter((r: any) => !r.err);
const rig: any = FLEET[0];
if (!rig) { console.error('no rigs in the fleet'); process.exit(1); }

console.log('selection and the verlet floor:');
{
  // no stored choice: the default is ammo, and the wasm is still warming —
  // the FLOOR must answer, not an error and not a wait
  check('default engine is ammo', bs.currentBodyEngine() === 'ammo');
  const av = makeAvatar(rig.P);
  const rd: any = bs.makeRagdoll(av, null, av.restBonePositions());
  check('while wasm warms, makeRagdoll answers with the verlet', rd instanceof Ragdoll);
  check('...and the status string says so',
    /loading|meanwhile/.test(bs.bodyEngine()), bs.bodyEngine());
  check('engines list in panel-cycle order',
    JSON.stringify(bs.listBodyEngines()) === '["verlet","ammo"]');
}

console.log('\nthe loaded engine answers:');
{
  const t0 = Date.now();
  while (bs.bodyEngine() !== 'ammo' && Date.now() - t0 < 30000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  check('ammo finishes loading', bs.bodyEngine() === 'ammo', bs.bodyEngine());
  const av = makeAvatar(rig.P);
  const rd: any = bs.makeRagdoll(av, null, av.restBonePositions());
  check('makeRagdoll now answers with the bullet engine', rd instanceof AmmoRagdoll);
  check('...which extends the shared spine', rd instanceof BodyEngineBase);
  rd.dispose?.();
}

console.log('\nthe stored choice wins:');
{
  bs.setBodyEngine('verlet');
  const av = makeAvatar(rig.P);
  const rd: any = bs.makeRagdoll(av, null, av.restBonePositions());
  check('setBodyEngine(verlet) answers verlet even with ammo loaded', rd instanceof Ragdoll);
  check('...and persists the choice', _ls.get('ew-bodysim') === 'verlet');
  check('...which extends the shared spine too', rd instanceof BodyEngineBase);
  bs.setBodyEngine('nonsense');
  check('an unknown engine name falls to the verlet floor',
    bs.currentBodyEngine() === 'verlet');
}

console.log('\nseedVel THROUGH THE DOOR (the dropped-argument regression):');
for (const engine of ['verlet', 'ammo']) {
  bs.setBodyEngine(engine);
  // a handover snapshot whose hips are HALF A METRE from where the avatar's
  // bones say they are: if the 4th argument is dropped, the sim rebuilds from
  // the bones and the hips land at the avatar — unmistakably not the seed
  const av = makeAvatar(rig.P);
  const rest = av.restBonePositions();
  const donor: any = new Ragdoll(makeAvatar(rig.P), null, rest);
  const seed = donor.snapshot();
  for (let i = 0; i < seed.j.length; i++) seed.p[i * 3] += 0.5;   // shift x by 0.5
  const rd: any = bs.makeRagdoll(av, null, rest, seed);
  const want = seed.p[seed.j.indexOf('hips') * 3];
  const got = rd.p?.hips?.x;
  check(`${engine}: the seeded hips reach the sim (Δ=${Math.abs((got ?? 99) - want).toFixed(3)}m)`,
    got != null && Math.abs(got - want) < 0.05);
  rd.dispose?.();
}

console.log('\ninterface parity across the seam:');
{
  const surface = ['step', 'impulse', 'setPin', 'snapshot'];
  for (const [name, cls] of [['verlet', Ragdoll], ['ammo', AmmoRagdoll]] as any) {
    const missing = surface.filter((m) => typeof cls.prototype[m] !== 'function');
    check(`${name} carries the contract methods`, missing.length === 0, missing.join(' '));
    check(`${name} answers .pinned`, 'pinned' in cls.prototype
      || 'pinned' in BodyEngineBase.prototype);
  }
  // the shared spine really is shared — one impulse law, one settle clock,
  // one root-follow (a re-declared copy on either engine would shadow it)
  for (const m of ['impulse', '_settleTick', '_followRoot']) {
    check(`${m} has ONE owner (BodyEngineBase)`,
      !Object.hasOwn(Ragdoll.prototype, m) && !Object.hasOwn(AmmoRagdoll.prototype, m)
      && typeof (BodyEngineBase.prototype as any)[m] === 'function');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
