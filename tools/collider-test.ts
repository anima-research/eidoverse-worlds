// colliders — the physical reading of placed geometry, tested headless.
//
//   bun tools/collider-test.ts
//
// There was no test here at all, which is how resolveColliders spent its life
// treating every box as an infinite column reaching down to the world floor:
// it never read box.min.y. A mezzanine slab modelled at y 2.4-2.7 shoved a
// walking avatar 2.3m sideways at GROUND level, and a tabletop ejected
// anything that tried to lie beneath it. The `pillar` heuristic (collapse
// anything over 2.4m tall to a slim centre column) was the only reason
// anything was ever passable underneath — which is why trees worked and
// archways did not.
//
// The routine is shared between the walking controller (a 1.9m capsule on its
// feet) and the ragdoll (one 3cm bead per joint), so most of what is tested
// here is that the vertical numbers follow the BODY and are not constants
// tuned for a standing human.

import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const STUB = fileURLToPath(new URL('./core-stub.mjs', import.meta.url));
plugin({ name: 'core-stub', setup(b) { b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); } });

const { THREE } = await import('./core-stub.mjs');
const { mergeGeometries } = await import(
  '../client/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js');
const C: any = await import('../client/lib/colliders.js');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

const flat = () => 0;
const AVATAR = 1.9;      // a body on its feet — resolveColliders' default
const BEAD = 0.03;       // one ragdoll joint

/** A box prop whose LOCAL box spans y in [y0, y0+h] — i.e. `y0` is how far
 *  off its own origin the geometry starts, which is what a mezzanine, a
 *  tabletop or a wall shelf all look like. */
function prop(id: string, { w = 1, h = 1, d = 1, y0 = 0, at = [0, 0, 0], collide = 'box' } = {}) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, y0 + h / 2, 0);
  const m = new THREE.Mesh(g, undefined);
  // fitCollider reads the box "with obj still at identity" — it stores LOCAL
  // extents and adds obj.position at query time. Fitting after a move bakes
  // the position in twice and the entity silently stops colliding.
  m.updateMatrixWorld(true);
  C.fitCollider(id, m, { collide });
  m.position.set(at[0], at[1], at[2]);
  m.updateMatrixWorld(true);
  C.reindexCollider(id);
  return m;
}

/** A forced-exact (BVH) entity: a floor slab with a 0.4m ledge on one side.
 *  Exact colliders are the only ones with a step-up allowance, so this is what
 *  exercises STEP. */
function twoLevel(id: string) {
  const floor = new THREE.BoxGeometry(8, 0.1, 8); floor.translate(0, -0.05, 0);
  const ledge = new THREE.BoxGeometry(3, 0.4, 8); ledge.translate(2.5, 0.2, 0);
  const m = new THREE.Mesh(mergeGeometries([floor, ledge], false), undefined);
  m.updateMatrixWorld(true);
  C.fitCollider(id, m, { collide: 'exact' });
  return m;
}
function at(x: number, y: number, z: number, r = 0.32, tall = AVATAR) {
  const p = new THREE.Vector3(x, y, z);
  const ground = C.resolveColliders(p, flat, r, tall);
  return { push: Math.hypot(p.x - x, p.z - z), ground, blocked: C.lastBlockedTop() };
}

console.log('colliders, headless:\n');

console.log('a crate on the floor (1m cube):');
{
  C.clearColliders(); prop('crate');
  check('walking into its side is pushed out', at(0.4, 0, 0).push > 0.1);
  check('standing on its top gets the top as ground', Math.abs(at(0, 1.0, 0).ground - 1) < 1e-6);
  check('...and the side push offers it as a mantle target',
    Math.abs((at(0.4, 0, 0).blocked ?? -1) - 1) < 1e-6);
  check('well clear of it is untouched', at(3, 0, 0).push === 0);
}

console.log('\nbeing UNDERNEATH things:');
{
  C.clearColliders(); prop('mezzanine', { w: 4, h: 0.3, d: 4, y0: 2.4 });
  check('an avatar walks under a mezzanine slab', at(0, 0, 0).push === 0,
    `pushed ${at(0, 0, 0).push.toFixed(2)}m`);
  check('...and still stands on top of it', Math.abs(at(0, 2.7, 0).ground - 2.7) < 1e-6);
  // it is the BODY's height that decides, not the foot position: the same
  // waist-high counter blocks a walking avatar and passes a ragdoll joint
  C.clearColliders(); prop('counter', { w: 3, h: 0.2, d: 3, y0: 1.0 });
  check('...but a waist-high counter still blocks a walking avatar',
    at(0, 0, 0).push > 0.1);
  check('...and the same counter passes a ragdoll joint on the floor',
    at(0, 0.03, 0, BEAD, BEAD).push === 0);

  C.clearColliders(); prop('tabletop', { w: 1.6, h: 0.1, d: 1.6, y0: 0.7 });
  check('a ragdoll joint rests under a tabletop', at(0, 0.03, 0, BEAD, BEAD).push === 0,
    `pushed ${at(0, 0.03, 0, BEAD, BEAD).push.toFixed(2)}m`);
  check('...and a joint ON the tabletop still finds it',
    Math.abs(at(0, 0.83, 0, BEAD, BEAD).ground - 0.8) < 1e-6);
  check('...while a standing avatar still collides with it',
    at(0, 0, 0).push > 0.1);

  C.clearColliders(); prop('shelf', { w: 2, h: 0.3, d: 0.4, y0: 2.2 });
  check('a wall shelf above head height does not block a corridor',
    at(0, 0, 0).push === 0);

  // Grazing the underside is the nastier half of the same bug: the box push
  // always exits through the nearest SIDE face, so overlapping a ceiling by a
  // centimetre threw you clear of the whole slab.
  C.clearColliders(); prop('ceiling', { w: 6, h: 0.2, d: 6, y0: 1.9 });
  check('brushing the underside of a ceiling does not fling you sideways',
    at(0, 0, 0, 0.32, 1.91).push < 0.05,
    `pushed ${at(0, 0, 0, 0.32, 1.91).push.toFixed(2)}m`);
  check('...but at the rim, where sideways IS the short way out, it pushes',
    at(3.25, 1.95, 0, 0.32, 0.1).push > 0.02);
}

console.log('\nthe vertical numbers follow the body:');
{
  // STEP is an EXACT-collider allowance (boxes have no step-up; the mantle
  // system handles those). An avatar walking at the foot of a 0.4m interior
  // ledge is lifted onto it; a ragdoll joint lying at the same spot must not
  // be — a 55cm step-up applied to a wrist teleports it onto the furniture.
  C.clearColliders(); twoLevel('room');
  check('an avatar at the foot of a 0.4m interior ledge steps up',
    at(2.5, 0, 0).ground > 0.3, `ground ${at(2.5, 0, 0).ground.toFixed(2)}`);
  const bead = at(2.5, 0.03, 0, BEAD, BEAD);
  check('a ragdoll joint at the same spot is NOT levitated onto it',
    bead.ground < 0.05, `ground ${bead.ground.toFixed(2)}`);

  C.clearColliders(); prop('crate');
  check('a ragdoll joint never claims a mantle target',
    at(0.4, 0.03, 0, BEAD, BEAD).blocked === null);
  check('...but an avatar still does', at(0.4, 0, 0).blocked !== null);
}

console.log('\nthings too tall to be boxes (the pillar rule):');
{
  // forced to 'box' so it becomes a pillar: a bare BoxGeometry of room scale
  // is genuinely HOLLOW, so decide() would classify it as a walkable interior.
  // A real tree has a trunk at the centre and fails that probe on its own.
  C.clearColliders(); prop('tree', { w: 6, h: 5, d: 6, y0: 0, collide: 'box' });
  check('you walk under a canopy', at(3, 0, 0).push === 0);
  check('you do not walk through the trunk', at(0.1, 0, 0).push > 0);
  check('a trunk is not a mantle target', at(0.1, 0, 0).blocked === null);
}

console.log('\nregression guards — the walking avatar must not have changed:');
{
  // Everything a 1.9m body sees should be exactly what it saw before `tall`
  // existed, because every derived height resolves back to its old constant
  // at 1.9: step 0.55, probe 0.95, span ~0.5.
  C.clearColliders();
  prop('a', { w: 1, h: 1, d: 1, at: [0, 0, 0] });
  prop('b', { w: 1, h: 0.5, d: 1, at: [3, 0, 0] });
  const rows = [at(0.4, 0, 0), at(0, 1, 0), at(3.4, 0, 0), at(3, 0.5, 0), at(8, 0, 0)];
  check('default `tall` reproduces the avatar case exactly', rows.every((r, i) =>
    Math.abs(r.push - [0.42, 0, 0.42, 0, 0][i]) < 0.005), rows.map((r) => r.push.toFixed(2)).join(' '));
  check('a box on the floor still has no gap to slip under',
    at(0.4, 0, 0, 0.32, 0.05).push > 0.1);
}

console.log('\nfloor-shaped things with lying tops (the blanket rule, issue #11):');
{
  // The smallest mesh that reproduces the bug: a 3×3m blanket, 4cm thick,
  // three 0.5m cushions on it. NO collide override anywhere in this block —
  // the auto rule is the thing under test.
  //
  // The cloth is TESSELLATED (12×12) on purpose. The lie probe buckets
  // vertices, so it can only see surface a vertex lands on — a corner-only
  // BoxGeometry cloth is invisible between its corners and the probe reads
  // the cushion corners as the whole story. Real triggers for this rule are
  // generated meshes at 10k–150k tris, which cover every cell many times
  // over; the sparse case is pinned separately below as the fail-safe it is.
  const blanket = (id: string, seg = 12) => {
    const cloth = new THREE.BoxGeometry(3, 0.04, 3, seg, 1, seg); cloth.translate(0, 0.02, 0);
    const parts = [cloth];
    for (const [px, pz] of [[-0.9, -0.9], [0.9, -0.6], [0.2, 1.0]]) {
      const p = new THREE.BoxGeometry(0.7, 0.5, 0.7); p.translate(px, 0.29, pz);
      parts.push(p);
    }
    const m = new THREE.Mesh(mergeGeometries(parts, false), undefined);
    m.updateMatrixWorld(true);
    C.fitCollider(id, m, {});
    return m;
  };
  C.clearColliders(); blanket('blanket');
  check('a blanket with cushions auto-classifies exact', !!C.colliders.get('blanket').exact);
  // issue #11's three acceptance observables, in order:
  const rim = at(1.6, 0, 0);
  check('1: no shove at the rim — you step onto the cloth', rim.push < 0.05,
    `pushed ${rim.push.toFixed(2)}m`);
  check('2: no phantom mantle target at cushion height', rim.blocked === null);
  check('3a: ground on bare cloth is the cloth', Math.abs(at(-1.2, 0.04, 0.9).ground - 0.04) < 0.02,
    `ground ${at(-1.2, 0.04, 0.9).ground.toFixed(2)}`);
  check('3b: ground on a cushion is the cushion', Math.abs(at(0.2, 0.54, 1.0).ground - 0.54) < 0.02,
    `ground ${at(0.2, 0.54, 1.0).ground.toFixed(2)}`);
  check('...and a cushion is a step up from the cloth, not a wall',
    Math.abs(at(0.2, 0.04, 1.0).ground - 0.54) < 0.02);

  // the gates hold — each of these is one clause away from being a blanket
  const auto = (id: string, w: number, h: number, d: number, bumpH = 0) => {
    const base = new THREE.BoxGeometry(w, h, d); base.translate(0, h / 2, 0);
    const parts = [base];
    if (bumpH) { const b = new THREE.BoxGeometry(w * 0.5, bumpH, d * 0.5); b.translate(0, h + bumpH / 2, 0); parts.push(b); }
    const m = new THREE.Mesh(mergeGeometries(parts, false), undefined);
    m.updateMatrixWorld(true);
    C.fitCollider(id, m, {});
    return C.colliders.get(id);
  };
  C.clearColliders();
  check('a 1m crate stays a box (footprint gate)', !auto('crate2', 1, 1, 1).exact);
  C.clearColliders();
  check('an honest flat slab stays a box (lie gate)', !auto('slab', 3, 0.3, 3).exact);
  C.clearColliders();
  check('a car-height hump stays a box (height gate)', !auto('car', 3, 0.9, 2.5, 0.36).exact);
  C.clearColliders();
  // The probe's known blind spot, pinned as DELIBERATE: a corner-only
  // low-poly mesh gives the probe nothing to see between its corners, so it
  // under- or mis-reads the lie and the object keeps today's box. Wrong in
  // the safe direction — sparse authored props stay exactly as they are;
  // only dense (generated) meshes can earn the flip.
  blanket('sparse', 1);
  check('a corner-only low-poly blanket keeps the status quo (box)',
    !C.colliders.get('sparse').exact);
  C.clearColliders();
  // the override still outranks the rule, both ways
  const m = blanket('forced');
  C.removeCollider('forced');
  C.fitCollider('forced', m, { collide: 'box' });
  check('collide:"box" still wins over the blanket rule', !C.colliders.get('forced').exact);
}

{
  C.clearColliders();
  prop('target', { h: 2 });
  const eye = new THREE.Vector3(0, 1, 3), dir = new THREE.Vector3(0, 0, -1);
  check('camera rays still hit the target collider', C.raySegment(eye, dir, 3) !== null);
  check('interaction target does not occlude itself', C.raySegment(eye, dir, 3, 'target') === null);
  prop('wall', { h: 2, at: [0, 0, 1.5] });
  check('another wall still occludes interaction', C.raySegment(eye, dir, 3, 'target') !== null);
  C.colliders.get('wall').structOwner = 'target';
  check('owned structure colliders are excluded with their target', C.raySegment(eye, dir, 3, 'target') === null);
  C.clearColliders();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
