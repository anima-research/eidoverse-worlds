// support surfaces (#17) — a settling body rests on what actually holds it up.
//
//   bun tools/support-test.ts
//
// The headless settle sim used to run on flat ground at zero, offset by ONE
// terrain sample taken at the fall site: every placed floor was invisible to
// it, and a body released above an elevated deck settled through the deck to
// the dirt underneath (Mythos, under the bell — issue #17). The repair has
// two parts, and this suite pins both: the sim clamps against the LIVE height
// field (setTerrain with a heightAt-bearing object, under the headless stub),
// and against support boxes registered from data (colliders.fitSupportBox —
// the /geom-fed door agents use, no loaded mesh required).
//
// Everything here is in-process against the same modules the agent's
// physics.ts drives; the live-server agent plumbing rides knockdown-test.

import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';

// Bun 1.3.x caches transpiled module graphs globally by content. A failed
// plugin-resolved path can therefore survive into a later checkout and bypass
// onResolve entirely. Tests need deterministic resolver behavior; production
// runtime keeps Bun's normal cache. Re-exec once because this setting is read
// at process startup. (Same guard as the rest of the suite — see #13.)
if (process.env.__EIDO_TEST_CACHE_OFF !== '1') {
  const child = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, ...process.argv.slice(2)],
    env: {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      __EIDO_TEST_CACHE_OFF: '1',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(child.exitCode ?? 1);
}

const STUB = fileURLToPath(new URL('./core-stub.mjs', import.meta.url));
plugin({
  name: 'core-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB }));
  },
});

const { THREE } = await import('./core-stub.mjs');
const { Ragdoll, JOINTS } = await import('../client/lib/ragdoll.js');
const { setTerrain, heightAt } = await import('../client/lib/terrain.js');
const { colliders, fitSupportBox, removeCollider } = await import('../client/lib/colliders.js');
const { makeAvatar } = await import('./rig-load.mjs');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

// the known body ragdoll-test uses — the invariants here are about GROUND,
// not any particular rig
const WORLD: Record<string, [number, number, number]> = {
  hips: [0, 0.95, 0], spine: [0, 1.05, 0], chest: [0, 1.2, 0],
  neck: [0, 1.4, 0], head: [0, 1.5, 0],
  leftUpperArm: [0.18, 1.35, 0], leftLowerArm: [0.45, 1.35, 0], leftHand: [0.7, 1.35, 0],
  rightUpperArm: [-0.18, 1.35, 0], rightLowerArm: [-0.45, 1.35, 0], rightHand: [-0.7, 1.35, 0],
  leftUpperLeg: [0.09, 0.85, 0], leftLowerLeg: [0.09, 0.45, 0], leftFoot: [0.09, 0.05, 0],
  rightUpperLeg: [-0.09, 0.85, 0], rightLowerLeg: [-0.09, 0.45, 0], rightFoot: [-0.09, 0.05, 0],
};
const synth = (at: [number, number, number], yaw = 0) => {
  const av = makeAvatar(Object.fromEntries(Object.entries(WORLD).map(
    ([k, v]) => [k, new THREE.Vector3(v[0], v[1], v[2])])));
  av.root.position.set(at[0], at[1], at[2]);
  av.root.rotation.y = yaw;
  av.root.updateMatrixWorld(true);
  return av;
};

function run(av: any, lean: any = null, seed: any = null, maxSteps = 1200) {
  const rd: any = new Ragdoll(av, lean, av.restBonePositions(), seed);
  let steps = 0;
  while (!rd.done && steps < maxSteps) { rd.step(1 / 60); steps++; }
  return rd;
}
const jointYs = (rd: any) => Object.fromEntries(
  JOINTS.filter((j: string) => rd.p[j]).map((j: string) => [j, rd.p[j]]));
const lowest = (rd: any) => Math.min(...Object.values(jointYs(rd)).map((p: any) => p.y));
const clean = () => { for (const id of [...colliders.keys()]) removeCollider(id); };

console.log('support surfaces (#17):\n');

// ---- 0. the headless terrain door itself ----------------------------------
setTerrain({ mesh: null, heightAt: (_x: number, _z: number) => 1.25 });
check('setTerrain accepts a meshless height field under the stub', heightAt(3, -7) === 1.25);
setTerrain(null);
check('...and null restores the bare stage', heightAt(3, -7) === 0);

// ---- 1. an elevated deck holds a body dropped onto it (the bell floor) ----
// A thin slab, the exact shape syncSupport registers for a room-scale
// entity's floor deck: 6×6m, top at y=2, floating (nothing below it).
setTerrain({ mesh: null, heightAt: () => 0 });
fitSupportBox('deck', [-3, 1.85, -3], [3, 2, 3], { position: [0, 0, 0] });
{
  const av = synth([0, 2, 0]);           // standing on the deck
  const rd = run(av, new THREE.Vector3(0.9, 0, 0.4));   // knocked over on it
  const low = lowest(rd);
  check('a body knocked over ON the deck comes to rest ON the deck', low > 1.9,
    `lowest joint y=${low.toFixed(3)} (deck top 2.0, terrain 0)`);
  check('...and settles rather than hitting the deadline', rd.done && rd.settledFor > 0,
    `elapsed=${rd.elapsed?.toFixed(1)}s`);
}

// ---- 2. a drag released in MID-AIR above the deck lands on it, not through
// it — the Mythos signature: rootY high, pose from a dragger's hand, no seed
{
  const av = synth([0.5, 3.2, 0.5]);     // let go of half a metre over the deck
  const rd = run(av);                     // no lean: falls free
  const low = lowest(rd);
  check('a body released in mid-air over the deck lands on the deck', low > 1.9,
    `lowest joint y=${low.toFixed(3)}`);
}

// ---- 3. a world-frame handover seed keeps its height meaning --------------
// The old sim ran ground-at-zero and shifted seeds by -groundY; a seed now
// arrives in world y and must land exactly where the other machine had it.
{
  const av = synth([0, 2.6, 0]);
  const names = JOINTS.filter((j: string) => WORLD[j]);
  const p: number[] = [], v: number[] = [];
  for (const j of names) {                // the dragger's sim: body at 2.6 over the deck, drifting +x
    const w = WORLD[j];
    p.push(w[0], w[1] + 1.6, w[2]);       // its joints, lifted to world height
    v.push(0.5, 0, 0);
  }
  const rd = run(av, null, { j: names, p, v });
  const low = lowest(rd);
  check('a handover seed in world y settles onto the deck, not through it', low > 1.9,
    `lowest joint y=${low.toFixed(3)}`);
}

// ---- 4. off the edge is still a real fall ---------------------------------
// Support is a surface, not a force field: released BESIDE the deck, the body
// falls past its rim to the terrain.
{
  const av = synth([5.5, 3.2, 0]);        // outside the 3m half-extent
  const rd = run(av);
  const low = lowest(rd);
  check('released beside the deck, the body falls to the terrain', low < 0.6,
    `lowest joint y=${low.toFixed(3)}`);
}

// ---- 5. deck removed: the floor stops existing, honestly ------------------
removeCollider('deck');
{
  const av = synth([0, 2, 0]);
  const rd = run(av, new THREE.Vector3(0.9, 0, 0.4));
  const low = lowest(rd);
  check('with the deck removed the same fall reaches the terrain', low < 0.6,
    `lowest joint y=${low.toFixed(3)}`);
}

// ---- 6. live terrain, not one sample: a blast across a slope --------------
// heightAt rises 1m per 4m of x. A body toppled downhill from the high side
// must rest ON the local slope at its landing site — the single-groundY
// convention embedded it in the hill (or floated it) by the height difference.
setTerrain({ mesh: null, heightAt: (x: number) => Math.max(0, x / 4) });
{
  const av = synth([8, 2 + 0.95 - 0.95, 0]);  // standing at x=8 → ground 2.0
  av.root.position.y = 2;
  av.root.updateMatrixWorld(true);
  const rd = run(av, new THREE.Vector3(-3, 0, 0));   // blasted downhill
  let worst = 0; let where = '';
  for (const [j, p] of Object.entries(jointYs(rd)) as [string, any][]) {
    const g = Math.max(0, p.x / 4);
    const below = g - p.y;               // positive = embedded under the slope
    if (below > worst) { worst = below; where = `${j}@x=${p.x.toFixed(1)}`; }
  }
  check('every joint rests on or above the slope at ITS OWN (x,z)', worst < 0.02,
    `deepest embedding ${worst.toFixed(3)}m (${where})`);
}
setTerrain(null);

// ---- 7. the data-box door behaves like decide() where it can --------------
fitSupportBox('post', [-0.2, 0, -0.2], [0.2, 3.4, 0.2], { position: [4, 0, 4] });
check('a tall thin data box collides as a pillar, same as decide()',
  colliders.get('post')?.pillar === true);
fitSupportBox('crate', [-0.5, 0, -0.5], [0.5, 0.9, 0.5], { position: [4, 0, 4] });
check('a crate-sized data box stays a plain box', colliders.get('crate')?.pillar === false);
check('data boxes never claim exact/interior (no triangles to read)',
  colliders.get('post')?.exact === null && colliders.get('crate')?.interior === false);
clean();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
