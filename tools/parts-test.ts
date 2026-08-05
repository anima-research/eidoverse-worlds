// Sub-object motion — headless checks for client/lib/motion.js's part tier.
//
// Orrery's segmented exports name their parts (tripo_part_N); a component
// keyed `motion:<part>` (or a motion carrying `part`) animates that node
// alone. These checks pin the contract: the root never moves for a part
// motion, the pivot point is a real hinge (fixed in the parent frame),
// several parts move independently, a vanished part-motion restores the rest
// pose, and whole-entity motion is untouched by any of it.
//
// Run: bun run tools/parts-test.ts   (no servers, no GPU)

import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('./core-stub.mjs', import.meta.url));
const PARTS = fileURLToPath(new URL('./parts-stub.mjs', import.meta.url));
const LOADWORK = fileURLToPath(new URL('./loadwork-stub.mjs', import.meta.url));
plugin({
  name: 'parts-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: CORE }));
    build.onResolve({ filter: /^\.\/world\.js$/ }, () => ({ path: PARTS }));
    build.onResolve({ filter: /^\.\/colliders\.js$/ }, () => ({ path: PARTS }));
    // motion.js's cone reaches remotes.js → loadwork.js, which schedules on
    // requestAnimationFrame at module scope and dies headless. avatar-test
    // already carries a stub for exactly this; share it.
    build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: LOADWORK }));
  },
});

const { THREE } = await import('./core-stub.mjs');
const { entities, comps } = await import('./parts-stub.mjs');
const { tickMotion } = await import('../client/lib/motion.js');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const v = (...a: number[]) => new THREE.Vector3(...a);

// A swing the shape Orrery ships: a scaled wrapper, a frame, a seat.
function makeSwing() {
  const root = new THREE.Object3D(); root.name = 'orrery_scale';
  const frame = new THREE.Object3D(); frame.name = 'tripo_part_fused_0';
  const seat = new THREE.Object3D(); seat.name = 'tripo_part_3';
  seat.position.set(0.014, -0.307, -0.012);
  const chains = new THREE.Object3D(); chains.name = 'tripo_part_2';
  chains.position.set(0.005, -0.163, -0.176);
  root.add(frame); root.add(seat); root.add(chains);
  return { root, frame, seat, chains };
}

console.log('\n━━ part motion: the named node moves, the entity does not ━━');
{
  const { root, seat } = makeSwing();
  entities.set('swing', root);
  // t0 = now → theta(0) = amp exactly: deterministic
  comps.set('swing', { 'motion:tripo_part_3': { type: 'pendulum', axis: [0, 0, 1], pivot: [0, 0.6, 0], amp: 0.5, period: 3, damp: 0, t0: Date.now() } });
  const seatBasePos = seat.position.clone(), pivot = v(0, 0.6, 0);
  const pivotBefore = seatBasePos.clone().add(pivot); // base quat = identity
  tickMotion();
  const angle = 2 * Math.acos(Math.min(1, Math.abs(seat.quaternion.w)));
  check('seat rotated by ~amp', Math.abs(angle - 0.5) < 0.02, `angle=${angle.toFixed(3)}`);
  check('root untouched', root.position.lengthSq() === 0 && root.quaternion.w === 1);
  const pivotAfter = seat.position.clone().add(pivot.clone().applyQuaternion(seat.quaternion));
  check('pivot is a real hinge (fixed in parent frame)', pivotAfter.distanceTo(pivotBefore) < 1e-6,
    `drift=${pivotAfter.distanceTo(pivotBefore).toExponential(2)}`);
}

console.log('\n━━ several parts, one entity — and vanishing motion restores rest ━━');
{
  const { root, seat, chains } = makeSwing();
  entities.set('swing2', root);
  const bag: Record<string, unknown> = {
    'motion:tripo_part_3': { type: 'pendulum', axis: [0, 0, 1], amp: 0.4, period: 2, damp: 0, t0: Date.now() },
    'motion:tripo_part_2': { type: 'spin', axis: [0, 1, 0], degPerSec: 90, phase: 1, t0: Date.now() },
  };
  comps.set('swing2', bag);
  const seatRest = seat.position.clone(), chainsRest = chains.position.clone();
  tickMotion();
  const seatMoved = 2 * Math.acos(Math.min(1, Math.abs(seat.quaternion.w))) > 0.1;
  const chainsMoved = 2 * Math.acos(Math.min(1, Math.abs(chains.quaternion.w))) > 0.1;
  check('both parts animate independently', seatMoved && chainsMoved);
  delete bag['motion:tripo_part_3'];
  tickMotion();
  check('removed part motion → rest pose restored',
    seat.position.distanceTo(seatRest) < 1e-9 && Math.abs(seat.quaternion.w - 1) < 1e-9,
    `pos drift=${seat.position.distanceTo(seatRest)}`);
  check('the other part keeps moving', 2 * Math.acos(Math.min(1, Math.abs(chains.quaternion.w))) > 0.1);
  check('restored part has no stale base', !(seat.userData as Record<string, unknown>).mbase);
}

console.log('\n━━ verb sugar + safety ━━');
{
  const { root, seat } = makeSwing();
  entities.set('swing3', root);
  // the `motion` verb's shape: part rides IN the data
  comps.set('swing3', { motion: { type: 'spin', part: 'tripo_part_3', axis: [0, 1, 0], degPerSec: 90, phase: 1, t0: Date.now() } });
  tickMotion();
  check('motion {part} targets the part', 2 * Math.acos(Math.min(1, Math.abs(seat.quaternion.w))) > 0.1);
  check('root untouched by sugared part motion', root.quaternion.w === 1 && root.position.lengthSq() === 0);

  const { root: r4 } = makeSwing();
  entities.set('swing4', r4);
  comps.set('swing4', { 'motion:no_such_part': { type: 'spin', degPerSec: 90, t0: Date.now() } });
  tickMotion();
  check('unknown part name: silent, nothing moves, no crash', r4.quaternion.w === 1);
}

console.log('\n━━ regression: whole-entity motion unchanged ━━');
{
  const { root } = makeSwing();
  entities.set('swing5', root);
  comps.set('swing5', { motion: { type: 'bob', axis: [0, 1, 0], amp: 0.3, period: 4, phase: Math.PI / 2, t0: Date.now() } });
  tickMotion();
  check('root bob still works', Math.abs(root.position.y - 0.3) < 0.02, `y=${root.position.y.toFixed(3)}`);
}

console.log(fail ? `\n\x1b[31m${fail} failure(s)\x1b[0m` : `\n\x1b[32mall ${pass} checks passed\x1b[0m`);
process.exit(fail ? 1 : 0);
