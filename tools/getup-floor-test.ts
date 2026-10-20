// bun tools/getup-floor-test.ts — a body that went limp gets up on the floor
// it lay on (client/lib/getup.js), not at height 0.
//
// While a body lies in a heap its root follows the hips a hips-height lower,
// so on a stair landing or an upper floor the root is BELOW that floor.
// localbody.js getUp used to stand the body at y = 0: on a landing its feet
// started inside the solid stair, upstairs under the floor it lay on.
// Checked with the real Bullet ragdoll on the committed skeleton fixture.
import { plugin } from 'bun';
const STUB = new URL('./core-stub.mjs', import.meta.url).pathname;
plugin({ name: 'core-stub', setup(b) { b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); } });
const { THREE } = await import('./core-stub.mjs');
const { mergeGeometries } = await import('../client/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js');
const C: any = await import('../client/lib/colliders.js');
const { AmmoRagdoll, ensureAmmo } = await import('../client/lib/ammodoll.js');
const { floorUnderLyingBody, standingYFromLyingRoot, floorStillUnder, standingYWithoutAvatar } = await import('../client/lib/getup.js');
const { makeAvatar, toppleLean } = await import('./rig-load.mjs');
const { wingRig } = await import('./doll-fixture.mjs');
const { mkCheck } = await import('./harness.ts');
const { check, tally } = mkCheck();
const flat = () => 0;

// an 8×8m house, walls 7m: a ground floor at 0.3, a solid stair landing
// (2×3m, 1.8m up) in one corner, and an upper floor at 3.3 over the west half
const FLOOR = 0.3, LANDING = 1.8, UPPER = 3.3;
const boxes = [
  [-4, 0, -4, 4, FLOOR, 4],
  [-4, FLOOR, -4, -3.8, 7, 4], [3.8, FLOOR, -4, 4, 7, 4], [-4, FLOOR, -4, 4, 7, -3.8], [-4, FLOOR, 3.8, 4, 7, 4],
  [1.8, 0, -3.8, 3.8, LANDING, -0.8],
  [-3.8, 3.1, -3.8, -0.5, UPPER, 3.8],
];
const geom = mergeGeometries(boxes.map(([x0, y0, z0, x1, y1, z1]) => {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g.index ? g.toNonIndexed() : g;
}), false);
const house = new THREE.Mesh(geom, undefined); house.updateMatrixWorld(true);
C.clearColliders();
C.fitCollider('house', house, { collide: 'exact' });
check('wasm door opens', await ensureAmmo());

/** Go limp standing at (x, y, z), let the doll settle, and answer where the
 *  body would get up — with the rig's hips readable the way a VRM's are. */
function fallAndGetUp(x: number, y: number, z: number, withHips = true, terrainAt: (x: number, z: number) => number = flat) {
  const av: any = makeAvatar(wingRig.P, { realParent: wingRig.realParent });
  av.root.position.set(x, y, z); av.root.updateMatrixWorld(true);
  const rd: any = new AmmoRagdoll(av, toppleLean(), av.restBonePositions());
  for (let k = 0; k < 900 && !rd.done; k++) rd.step(1 / 60);
  av.root.updateMatrixWorld(true);
  // getup.js reads the hips the way a VRM offers them (attached after the
  // doll settles: the doll reads this rig its own way)
  if (withHips) av.vrm ??= { humanoid: { getRawBoneNode: (n: string) => av.nodes?.[n] ?? null } };
  else av.vrm = undefined;
  const hipsRead = !!(av.vrm?.humanoid?.getRawBoneNode?.('hips') ?? av.vrm?.humanoid?.getNormalizedBoneNode?.('hips'));
  const rootY = av.root.position.y;
  const up = floorUnderLyingBody(av, terrainAt);
  const root = av.root.position.clone();
  rd.dispose?.();
  return { rootY, up, hipsRead, root };
}

for (const [where, x, y, z, floor] of [
  ['on the stair landing', 2.8, LANDING, -2.3, LANDING],
  ['upstairs', -2.2, UPPER, 0, UPPER],
  ['on the ground floor under the upper floor (the slab overhead is no floor)', -2.2, FLOOR, 0, FLOOR],
  ['on the ground floor in the open half', 1.5, FLOOR, 2.0, FLOOR],
] as [string, number, number, number, number][]) {
  const r = fallAndGetUp(x, y, z);
  check(`limp ${where}: it gets up on that floor (${floor}m)`, r.hipsRead && Math.abs(r.up - floor) < 0.02,
    `root lies at ${r.rootY.toFixed(2)}m; gets up at ${r.up.toFixed(2)}m (height 0 would have been ${(floor - 0).toFixed(2)}m too low)`);
}
{
  const r = fallAndGetUp(2.8, LANDING, -2.3, false);
  check('a rig whose hips cannot be read still gets up on the landing (root + a typical hips height)', !r.hipsRead && Math.abs(r.up - LANDING) < 0.02, `hips read: ${r.hipsRead}; root ${r.rootY.toFixed(2)} → ${r.up.toFixed(2)}m`);
}
{
  // a rejoin while lying on the landing
  const r = fallAndGetUp(2.8, LANDING, -2.3);
  check('rejoining mid-heap with the floor recorded wakes exactly on it', standingYFromLyingRoot(r.rootY, { floor: LANDING }) === LANDING);
  const wake = standingYFromLyingRoot(r.rootY);
  check('...and a record without one (before `floor` existed) wakes at or above the landing, within a step of it', wake >= LANDING - 0.01 && wake - LANDING < 0.55,
    `root ${r.rootY.toFixed(2)} → wakes at ${wake.toFixed(2)} (landing ${LANDING})`);
}
{
  // body-relative: the same heap at twice the size lies twice as far below
  // its floor — the fallback grows with the body, so it wakes at or above it (unless a tumble carried it up onto a higher floor)
  const rootY2 = LANDING - 2 * 1.06;          // this rig's root-to-floor gap, doubled
  const wake2 = standingYFromLyingRoot(rootY2, { scale: 2 });
  check('a 2× body\'s legacy record still wakes at or above its floor', wake2 >= LANDING - 0.01, `root ${rootY2.toFixed(2)} → ${wake2.toFixed(2)}`);
  const rootYs = LANDING - 0.5 * 1.06;         // a half-size body
  const wakes = standingYFromLyingRoot(rootYs, { scale: 0.5 });
  check('...and a half-size body\'s within its (smaller) step of it', wakes >= LANDING - 0.01 && wakes - LANDING < 0.55 * 0.5 + 0.05, `root ${rootYs.toFixed(2)} → ${wakes.toFixed(2)}`);
}
{
  // lying on open ground, with no placed floor under it: it gets up on the
  // terrain there, read where the body lies (a ground that rises with x)
  const asked: number[][] = [];
  const slope = (x: number, z: number) => { asked.push([x, z]); return 0.02 + 0.001 * Math.abs(x); };
  const r = fallAndGetUp(20, 0, 20, true, slope);
  const want = 0.02 + 0.001 * Math.abs(r.root.x);
  check('limp on open ground: it gets up on the terrain where it lies, not a fixed height', Math.abs(r.up - want) < 1e-9
    && asked.some(([x, z]) => x === r.root.x && z === r.root.z), `root at (${r.root.x.toFixed(2)}, ${r.root.z.toFixed(2)}); gets up at ${r.up.toFixed(3)}m, the terrain there ${want.toFixed(3)}m`);
}
{
  // the floor a settled body measured rides presence only while its root is
  // still where it was measured: a settled body doesn't move, and a drag, a
  // shove or an unpin moves it
  const measured = { y: LANDING, root: [2.8, 0.74, -2.3] };
  check('a settled body still where it measured its floor still lies on it', floorStillUnder(measured, { x: 2.8, y: 0.74, z: -2.3 }) === LANDING);
  check('...moved 2mm along any axis (dragged, shoved, unpinned), that floor is no longer its own',
    floorStillUnder(measured, { x: 2.802, y: 0.74, z: -2.3 }) === undefined
    && floorStillUnder(measured, { x: 2.8, y: 0.742, z: -2.3 }) === undefined
    && floorStillUnder(measured, { x: 2.8, y: 0.74, z: -2.302 }) === undefined);
  check('...moved half a millimetre, it is still its own', floorStillUnder(measured, { x: 2.8005, y: 0.74, z: -2.3 }) === LANDING);
  check('...moved half a metre and back by float arithmetic, it is its own again',
    floorStillUnder(measured, { x: 2.8 + 0.5 - 0.5, y: 0.74, z: -2.3 - 0.5 + 0.5 }) === LANDING);
  check('no floor measured, or a broken one, is none', floorStillUnder(undefined, { x: 0, y: 0, z: 0 }) === undefined
    && floorStillUnder({ y: NaN, root: [0, 0, 0] }, { x: 0, y: 0, z: 0 }) === undefined);
}
{
  // getting up with no avatar to measure (localbody.js getUp): the floor it
  // measured while it is still there, else its root raised by its size's reach
  const measured = { y: LANDING, root: [2.8, 0.74, -2.3] };
  check('with no avatar, a body still where it measured its floor stands on it',
    standingYWithoutAvatar(measured, { x: 2.8, y: 0.74, z: -2.3 }, 1) === LANDING);
  check('...moved off it, at its root raised by the reach', standingYWithoutAvatar(measured, { x: 3.3, y: 0.74, z: -2.3 }, 1) === 0.74 + 1.1);
  check('...a 2× body by twice the reach', standingYWithoutAvatar(undefined, { x: 3.3, y: 0.5, z: -2.3 }, 2) === 0.5 + 2.2);
}
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
