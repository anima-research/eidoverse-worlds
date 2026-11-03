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
const { AmmoRagdoll, ensureAmmo, interiorTriangles, INTERIOR_MAX_TRIS } = await import('../client/lib/ammodoll.js');
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
  interiorTriangles(entry, { x: -2, z: 0 }, 8).tris.length > 0 && interiorTriangles(entry, { x: 40, z: 40 }, 8).tris.length === 0);

check('wasm door opens', await ensureAmmo());

/** Drop the fixture skeleton standing at (x, y, z), toppled; the lowest any
 *  core body's centre reaches while settling, and where they rest. */
function drop(x: number, y: number, z: number) {
  const av: any = makeAvatar(wingRig.P, { realParent: wingRig.realParent });
  av.root.position.set(x, y, z);
  av.root.updateMatrixWorld(true);
  const t0 = performance.now();
  const rd: any = new AmmoRagdoll(av, toppleLean(), av.restBonePositions());
  const ctorMs = performance.now() - t0, fallback = rd.interiorFallback ?? null;
  let low = Infinity, rest = Infinity, steps = 0;
  while (!rd.done && steps < 900) {
    rd.step(1 / 60); steps++;
    if (rd.done) break;
    let m = Infinity;
    for (const b of rd._cores) m = Math.min(m, b.getCenterOfMassTransform().getOrigin().y());
    low = Math.min(low, m); rest = m;
  }
  rd.dispose?.();
  return { low, rest, steps, ctorMs, fallback };
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
  const tri = interiorTriangles(e, { x: X, z: 0 }, 8).tris;
  let top = false;
  for (let k = 0; k < tri.length; k += 9) if ([1, 4, 7].every((o) => Math.abs(tri[k + o] - H) < 1e-6)) top = true;
  check('interiorTriangles hands over a floor triangle whose corners are all out of reach', top, `${tri.length / 9} triangles`);
  const mid = drop(X, H, 0);
  check('in the middle of a wide hall, the body rests on its floor', mid.rest > H - 0.05 && mid.low > H - 0.2,
    `lowest ${mid.low.toFixed(2)}, rests ${mid.rest.toFixed(2)} (floor ${H})`);
}

console.log('\na dense interior (a million triangles in reach):');
const warns: string[] = [];
{
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  // 20×20m hall, its floor 1m up and tessellated into ~1M triangles —
  // lawful for exact collision, far past what one fall may hand Bullet
  const H = 1.0, X = -100, N = 707;   // N×N quads × 2 ≈ 1.0M
  const floor = new THREE.PlaneGeometry(20, 20, N, N);
  floor.rotateX(-Math.PI / 2); floor.translate(X, H, 0);
  const walls = [[-10, 0, -10, 10, H, 10], [-10, H, -10, -9.8, 4, 10], [9.8, H, -10, 10, 4, 10], [-10, H, -10, 10, 4, -9.8], [-10, H, 9.8, 10, 4, 10]]
    .map(([x0, y0, z0, x1, y1, z1]) => { const b = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0); b.translate((x0 + x1) / 2 + X, (y0 + y1) / 2, (z0 + z1) / 2); return b.toNonIndexed(); });
  const g = mergeGeometries([floor.toNonIndexed(), ...walls], false);
  const m = new THREE.Mesh(g, undefined); m.updateMatrixWorld(true);
  C.fitCollider('dense', m, { collide: 'exact' });
  const tris = g.getAttribute('position').count / 3;
  const t0 = performance.now();
  const got = interiorTriangles([...C.nearColliders(X, 0, 1)].find(([id]: any) => id === 'dense')?.[1], { x: X, z: 0 }, 8);
  const qMs = performance.now() - t0;
  check(`asking a ${(tris / 1e6).toFixed(2)}M-triangle interior for what's near a fall stops at the budget, quickly`,
    got.over && got.tris.length / 9 <= INTERIOR_MAX_TRIS && qMs < 200, `${got.tris.length / 9} triangles, over=${got.over}, ${qMs.toFixed(0)}ms`);
  // the same body going limp in the plain hall (warm): what a fall costs
  // anyway — the dense interior may add only its bounded handoff to it
  const base = Math.min(...[0, 1, 2].map(() => drop(100, 1.0, 0).ctorMs));
  const d = drop(X, H, 0);
  drop(X, H, 0);                                         // a second fall in the same room
  console.warn = realWarn;
  check('a body that goes limp in it builds its world without running out of memory, and the interior adds under 60ms',
    d.ctorMs - base < 60, `constructor ${d.ctorMs.toFixed(0)}ms vs ${base.toFixed(0)}ms in the plain hall`);
  // the fallback is observable where it ships: the `ragdoll` debuglog topic
  // (entity, cap, floor) and one console warning per thing — not per fall
  const { lastWhy } = await import('../client/lib/debuglog.js');
  const said = lastWhy('ragdoll');
  check('the fallback is reported where it ships: the ragdoll debug topic names the thing, the cap and the floor',
    /interior fallback — dense: over 20000 triangles .* floor slab at 1\.00m/.test(said), said);
  check('...with one console warning for that thing, not one per fall', warns.filter((w) => /interior fallback — dense/.test(w)).length === 1,
    `${warns.length} warning(s): ${warns.join(' | ').slice(0, 160)}`);
  check('...says it fell back, and lands on the floor, not the terrain 1m beneath',
    /floor slab at 1\.00m/.test(d.fallback ?? '') && d.rest > H - 0.05 && d.low > H - 0.2, `${d.fallback} — lowest ${d.low.toFixed(2)}, rests ${d.rest.toFixed(2)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
