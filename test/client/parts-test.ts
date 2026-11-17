// Sub-object motion — headless checks for client/lib/motion.js's part tier.
//
// Orrery's segmented exports name their parts (tripo_part_N); a component
// `motion:<slot>` with the node in `value.node` animates that node alone. The
// fixtures use the OLDER stored forms the reader still takes (shared/protocol/
// names.js motionNode): the key as the node, and `motion.part`; the authority
// refuses both in a new write. These checks pin the contract: the root never moves for a part
// motion, the pivot point is a real hinge (fixed in the parent frame),
// several parts move independently, a vanished part-motion restores the rest
// pose, and whole-entity motion is untouched by any of it.
//
// Run: bun run test/client/parts-test.ts   (no servers, no GPU)

import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
import { fileURLToPath } from 'node:url';
import { suite } from "../gate/suite.ts";

// Bun 1.3.x caches transpiled module graphs globally by content. A failed
// plugin-resolved path can therefore survive into a later checkout and bypass
// onResolve entirely. Tests need deterministic resolver behavior; production
// runtime keeps Bun's normal cache. Re-exec once because this setting is read
// at process startup.
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

const CORE = fileURLToPath(new URL('../stubs/core-stub.mjs', import.meta.url));
const PARTS = fileURLToPath(new URL('../stubs/parts-stub.mjs', import.meta.url));
const COLLIDERS = fileURLToPath(new URL('../stubs/colliders-stub.mjs', import.meta.url));
const REMOTES = fileURLToPath(new URL('../stubs/remotes-stub.mjs', import.meta.url));
const LOOKAT = fileURLToPath(new URL('../stubs/lookat-stub.mjs', import.meta.url));
plugin({
  name: 'parts-stub',
  setup(build) {
    // one specifier, one file — './colliders.js' goes through a re-export
    // shim over parts-stub rather than to parts-stub itself. Two specifiers
    // resolving to one plugin-returned path is the configuration that breaks
    // on macOS Bun 1.3.14 (see colliders-stub.mjs for the evidence).
    stubResolve(build, /^(\.\.?\/)+core\.js$/, () => ({ path: CORE }));
    stubResolve(build, /^(\.\.?\/)+world\.js$/, () => ({ path: PARTS }));
    stubResolve(build, /^(\.\.?\/)+colliders\.js$/, () => ({ path: COLLIDERS }));
    // motion.js reads one clock from remotes.js, whose own cone is every remote body (avatar.js, the renderer)
    stubResolve(build, /^(\.\.?\/)+(player\/)?remotes\.js$/, () => ({ path: REMOTES }));
    // lookats.js (the look-at rows) reads bus/CONFIG from base.js and identityOf from net.js, nothing else
    stubResolve(build, /^(\.\.?\/)+base\.js$/, () => ({ path: LOOKAT }));
    stubResolve(build, /^(\.\.?\/)+net\.js$/, () => ({ path: LOOKAT }));
  },
});

const { THREE } = await import('../stubs/core-stub.mjs');
const { entities, comps } = await import('../stubs/parts-stub.mjs');
const { tickMotion } = await import('../../client/lib/motion.js');

const S = suite("parts");
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);
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
  // the old `motion` verb's shape (part IN the data): refused at the door now, still read from a stored world
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
  comps.set('swing5', { motion: { type: 'oscillate', axis: [0, 1, 0], amp: 0.3, period: 4, phase: Math.PI / 2, t0: Date.now() } });
  tickMotion();
  check('root bob still works', Math.abs(root.position.y - 0.3) < 0.02, `y=${root.position.y.toFixed(3)}`);
}

// house review of #260, client/lib I37: every parented thing carries userData.mountedTo (models.js execMount), and a
// parent record is only ever the hierarchy (sitting and holding are presence), so skipping mountedTo froze every child's
// own motion. A child moves in its parent's frame: its base is the local pose the mount gave it.
// Mutation (must go red): restore `|| obj.userData.mountedTo` in motion.js's skip.
console.log('\n━━ a parented thing keeps its own motion, in its parent\'s frame ━━');
{
  const parent = new THREE.Object3D(); parent.position.set(40, 0, 0);
  const child = new THREE.Object3D(); child.position.set(1, 2, 0);
  parent.add(child); child.userData.mountedTo = 'carrier';
  child.userData.base = { pos: [1, 2, 0], yaw: 0, q: [0, 0, 0, 1] };
  entities.set('kid', child);
  comps.set('kid', { motion: { type: 'oscillate', axis: [0, 1, 0], amp: 0.3, period: 4, phase: Math.PI / 2, t0: Date.now() } });
  tickMotion();
  check('the child oscillates about its LOCAL base (not frozen, not thrown to a world pose)', Math.abs(child.position.y - 2.3) < 0.02 && Math.abs(child.position.x - 1) < 1e-9, `pos=${child.position.toArray()}`);
  // the distance gate reads where it IS: a child 1 m from a carrier 200 m away is far, though its local pos is near
  parent.position.set(200, 0, 0); child.position.set(1, 2, 0); parent.updateMatrixWorld(true);
  tickMotion();
  check('…and the 90 m gate reads its world position', child.position.y === 2, `pos=${child.position.toArray()}`);
}

// I37, the openable half (openable.js skipped userData.mountedTo the same way): a lid parented to its box still opens
// Mutation (must go red): restore `|| obj.userData.mountedTo` in openable.js apply().
{
  const { tickOpenables } = await import('../../client/lib/realize/openable.js');
  const box = new THREE.Object3D(); const lid = new THREE.Object3D(); lid.position.set(0, 1, 0);
  box.add(lid); lid.userData.mountedTo = 'box'; lid.userData.base = { pos: [0, 1, 0], yaw: 0, q: [0, 0, 0, 1] };
  entities.set('lid', lid);
  const bag: Record<string, any> = { openable: { open: false, angle: Math.PI / 2, axis: [1, 0, 0], time: 0 } };
  comps.set('lid', bag);
  tickOpenables(0); bag.openable.open = true; tickOpenables(1);
  const turned = 2 * Math.acos(Math.min(1, Math.abs(lid.quaternion.w)));
  check('a parented lid opens (turned about its local hinge)', Math.abs(turned - Math.PI / 2) < 0.02, `angle=${turned.toFixed(3)}`);
  comps.delete('lid'); entities.delete('lid');
}

// look-at's 90 m gate reads where the thing IS, as motion's does: a child beside the camera under a far parent turns
{
  const { tickLookAt, _lookats } = await import('../../client/lib/realize/lookats.js');
  const parent = new THREE.Object3D(); parent.position.set(-100, 0, 0);
  const child = new THREE.Object3D(); child.position.set(100, 0, 0); child.userData.mountedTo = 'far';
  parent.add(child); parent.updateMatrixWorld(true);
  entities.set('gazer', child); comps.set('gazer', { 'look-at': { target: '@viewer' } });
  tickLookAt();
  check('a parented look-at beside the camera (local x=100, world x=0) is not skipped as 100 m away', _lookats.has('gazer\u0000look-at'));
  parent.position.set(200, 0, 0); child.position.set(1, 0, 0); parent.updateMatrixWorld(true); _lookats.clear();
  tickLookAt();
  check('…and one 201 m away though its local pos is near is', !_lookats.has('gazer\u0000look-at'));
  comps.delete('gazer'); entities.delete('gazer');
}

console.log(S.fail ? `\n\x1b[31m${S.fail} failure(s)\x1b[0m` : `\n\x1b[32mall ${S.pass} checks passed\x1b[0m`);
S.done();
