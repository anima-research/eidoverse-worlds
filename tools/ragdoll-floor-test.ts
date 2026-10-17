// bun tools/ragdoll-floor-test.ts — a body that goes limp inside a building
// lands on the building's floor.
//
// The Bullet ragdoll (client/lib/ammodoll.js) builds its static world from
// the terrain and the boxes of nearby colliders, and skips room-scale
// INTERIORS — their box would seal the room into a block. Nothing replaced
// them, so a body that ragdolled indoors had no floor and fell through to
// the terrain, from the ground floor and from upstairs alike. Interiors now
// hand Bullet their own triangles near the fall. Checked on the committed
// skeleton fixture, in a two-storey box building fitted exactly as a spawn
// of one is (colliders.fitCollider, collide: "exact").
import { plugin } from 'bun';
const STUB = new URL('./core-stub.mjs', import.meta.url).pathname;
plugin({ name: 'core-stub', setup(b) { b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); } });

const { THREE } = await import('./core-stub.mjs');
const { mergeGeometries } = await import('../client/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js');
const C: any = await import('../client/lib/colliders.js');
const { AmmoRagdoll, ensureAmmo, interiorTriangles } = await import('../client/lib/ammodoll.js');
const { makeAvatar, toppleLean } = await import('./rig-load.mjs');
const { wingRig } = await import('./doll-fixture.mjs');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

// 8×8m, walls 4m to the eaves of a 6.3m box; ground floor raised 0.3m; an
// upper floor at 3.3m over the west half; terrain is flat at 0.
const FLOOR = 0.3, UPPER = 3.3;
const boxes: number[][] = [
  [-4, 0, -4, 4, FLOOR, 4],
  [-4, FLOOR, -4, -3.8, 6.3, 4], [3.8, FLOOR, -4, 4, 6.3, 4], [-4, FLOOR, -4, 4, 6.3, -3.8], [-4, FLOOR, 3.8, 4, 6.3, 4],
  [-3.8, 3.1, -3.8, 0, UPPER, 3.8],
];
const geom = mergeGeometries(boxes.map(([x0, y0, z0, x1, y1, z1]) => {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g.index ? g.toNonIndexed() : g;
}), false);
const house = new THREE.Mesh(geom, undefined);
house.updateMatrixWorld(true);
C.clearColliders();
C.fitCollider('house', house, { collide: 'exact' });
const entry = C.colliders?.get?.('house') ?? [...C.nearColliders(0, 0, 1)].find(([id]: any) => id === 'house')?.[1];
check('the building is fitted as an exact interior (the case the ragdoll used to skip)',
  !!entry?.exact && entry.interior === true, `exact=${!!entry?.exact} interior=${entry?.interior}`);
check('interiorTriangles hands over triangles near a point, in world space',
  interiorTriangles(entry, { x: -2, z: 0 }, 8).length > 0 && interiorTriangles(entry, { x: 40, z: 40 }, 8).length === 0);

check('wasm door opens', await ensureAmmo());

/** Drop the fixture skeleton standing at (x, y, z), toppled; the lowest any
 *  core body's centre reaches while settling, and where they rest. */
function drop(x: number, y: number, z: number) {
  const av: any = makeAvatar(wingRig.P, { realParent: wingRig.realParent });
  av.root.position.set(x, y, z);
  av.root.updateMatrixWorld(true);
  const rd: any = new AmmoRagdoll(av, toppleLean(), av.restBonePositions());
  let low = Infinity, rest = Infinity, steps = 0;
  while (!rd.done && steps < 900) {
    rd.step(1 / 60); steps++;
    if (rd.done) break;
    let m = Infinity;
    for (const b of rd._cores) m = Math.min(m, b.getCenterOfMassTransform().getOrigin().y());
    low = Math.min(low, m); rest = m;
  }
  rd.dispose?.();
  return { low, rest, steps };
}

console.log('\nlimp indoors:');
{
  const up = drop(-2, UPPER, 0);
  check('upstairs, the body comes to rest on the upper floor — not through it to the ground',
    up.rest > UPPER - 0.05 && up.low > UPPER - 0.2, `lowest ${up.low.toFixed(2)}, rests ${up.rest.toFixed(2)} (floor ${UPPER})`);
  const down = drop(2, FLOOR, 0);
  check('on the raised ground floor, it rests on the floor — not 0.3m down on the terrain',
    down.rest > FLOOR - 0.05 && down.low > FLOOR - 0.2, `lowest ${down.low.toFixed(2)}, rests ${down.rest.toFixed(2)} (floor ${FLOOR})`);
  const under = drop(-2, FLOOR, 0);
  check('under the upper floor, on the ground floor, it rests on the ground floor (the slab above is no floor)',
    under.rest > FLOOR - 0.05 && under.rest < 1.0, `rests ${under.rest.toFixed(2)}`);
}
console.log('\noutside:');
{
  const out = drop(12, 0, 0);
  check('outside, it rests on the terrain as before', out.rest > -0.05 && out.rest < 0.5, `rests ${out.rest.toFixed(2)}`);
}

console.log('\na wide hall:');
{
  // 24×24m, its floor 1m up: the floor's top is two triangles whose corners
  // are all 12m and more from a body in the middle
  const H = 1.0, X = 100;
  const hall = [[-12, 0, -12, 12, H, 12],
    [-12, H, -12, -11.8, 5, 12], [11.8, H, -12, 12, 5, 12], [-12, H, -12, 12, 5, -11.8], [-12, H, 11.8, 12, 5, 12]]
    .map(([x0, y0, z0, x1, y1, z1]) => [x0 + X, y0, z0, x1 + X, y1, z1]);
  const g = mergeGeometries(hall.map(([x0, y0, z0, x1, y1, z1]) => {
    const b = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    b.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return b.index ? b.toNonIndexed() : b;
  }), false);
  const m = new THREE.Mesh(g, undefined); m.updateMatrixWorld(true);
  C.fitCollider('hall', m, { collide: 'exact' });
  const e = [...C.nearColliders(X, 0, 1)].find(([id]: any) => id === 'hall')?.[1];
  const tri = interiorTriangles(e, { x: X, z: 0 }, 8);
  let top = false;
  for (let k = 0; k < tri.length; k += 9) if ([1, 4, 7].every((o) => Math.abs(tri[k + o] - H) < 1e-6)) top = true;
  check('interiorTriangles hands over a floor triangle whose corners are all out of reach', top, `${tri.length / 9} triangles`);
  const mid = drop(X, H, 0);
  check('in the middle of a wide hall, the body rests on its floor', mid.rest > H - 0.05 && mid.low > H - 0.2,
    `lowest ${mid.low.toFixed(2)}, rests ${mid.rest.toFixed(2)} (floor ${H})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
