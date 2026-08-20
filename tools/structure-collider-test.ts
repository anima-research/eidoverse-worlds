// Declared structure colliders — colliders.fitStructureBoxes.
//
//   bun tools/structure-collider-test.ts
//
// A griddled building declares its boxes instead of having a shape inferred
// from its bounding box. Two inherited behaviours would silently ruin that, and
// both are pinned here against a live control rather than asserted from taste:
//
//  - THE PILLAR RULE. fitSupportBox turns anything over 2.4m tall into a 0.5m
//    centre post (so you can walk under a canopy). A 2.8m wall is exactly that
//    tall. The control below pushes the SAME box through both doors and shows
//    they disagree — if fitStructureBoxes ever starts inheriting the rule, this
//    test stops being able to tell them apart.
//  - `interior`. flora reads it to clear grass; physobj and both ragdoll
//    engines read it to SKIP the entry. A floor slab wearing it is a floor
//    bodies fall through.
//
// Plus the claim the whole aperture design rests on: a doorway is walkable
// because there is NO BOX there, with no change to the movement solver.

import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';

// Same Bun transpiler-cache guard as the rest of the suite (see support-test).
if (process.env.__EIDO_TEST_CACHE_OFF !== '1') {
  const child = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, ...process.argv.slice(2)],
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', __EIDO_TEST_CACHE_OFF: '1' },
    stdout: 'inherit', stderr: 'inherit',
  });
  process.exit(child.exitCode ?? 1);
}

const STUB = fileURLToPath(new URL('./core-stub.mjs', import.meta.url));
plugin({
  name: 'core-stub',
  setup(build) { build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); },
});

const { THREE } = await import('./core-stub.mjs');
const {
  colliders, fitStructureBoxes, removeStructureBoxes, structureBoxIds,
  fitSupportBox, removeCollider, resolveColliders, surfaceUnder,
} = await import('../client/lib/colliders.js');
const { planStructure } = await import('../shared/structure.js');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const clean = () => { for (const id of [...colliders.keys()]) removeCollider(id); };
const flat = () => 0;

console.log('\ndeclared structure colliders:\n');

// A two-cell room with a wall across its north edge, doored on the left half:
//
//        x=0        1        2
//   z=0   ══[door]══╪═════════     ← both segments 2.8m tall
//         │  cell   │  cell   │
//   z=1   └─────────┴─────────┘
const HOUSE = {
  levels: [{
    y: 0,
    tiles: [[0, 0], [1, 0]],
    walls: [[0, 0, 0], [0, 1, 0]],
    apertures: [[0, 0, 0, 'door']],
  }],
};
const PLAN = planStructure(HOUSE);
const AT = { position: [0, 0, 0] as [number, number, number], yaw: 0, scale: 1 };
/** The walk surface — the top of the foundation, not the level's base. Bodies
 *  in this world stand HERE, and probing at 0 would be probing inside the slab. */
const WALK = PLAN.levels[0].y;

// 1. registration accounting
{
  clean();
  const n = fitStructureBoxes('house', PLAN.boxes, AT);
  // 2 floor slabs + 1 whole wall + 1 door lintel + the grass mask
  check('every plan box registers, plus one mask', n === PLAN.boxes.length + 1,
    `${n} entries for ${PLAN.boxes.length} boxes`);
  check('ids are owned by the building',
    structureBoxIds('house').length === n && structureBoxIds('house').every((i) => i.startsWith('house#')));
  check('entries carry their owner back',
    [...colliders.values()].every((e: any) => !e.structOwner || e.structOwner === 'house'));
}

// 2. THE PILLAR TRAP — same box, both doors, different verdict
{
  clean();
  const wall = PLAN.boxes.find((b: any) => b.kind === 'wall')!;
  fitStructureBoxes('house', [wall], AT);
  const declared = [...colliders.entries()].find(([id]) => id === 'house#s0')![1] as any;

  // the control: the SAME extents through the support door, which does inherit
  // the rule. If this stops being true the comparison above is vacuous.
  fitSupportBox('control', [wall.x0, wall.y0, wall.z0], [wall.x1, wall.y1, wall.z1], AT);
  const support = colliders.get('control') as any;

  check('control: fitSupportBox DOES pillar a wall-height box', support.pillar === true,
    'the trap this test exists for is no longer reachable');
  check('a declared wall is never a pillar', declared.pillar === false);
  check('a declared wall is never exact (no BVH in the spawn path)', declared.exact === null);
}

// 3. `interior` — the overloaded flag
{
  clean();
  fitStructureBoxes('house', PLAN.boxes, AT);
  const floors = structureBoxIds('house')
    .map((id) => colliders.get(id) as any)
    .filter((e) => e.structKind === 'floor');
  check('floor slabs exist', floors.length === 2, `${floors.length}`);
  check('no floor slab wears `interior` (bodies would fall through)',
    floors.every((e) => e.interior === false));
  const mask = colliders.get('house#mask') as any;
  check('the mask entry wears `interior` (grass clears)', mask.interior === true);
  check('the mask entry is flagged non-solid', mask.mask === true);
  check('the mask spans the whole footprint',
    mask.box.min.x <= 0 && mask.box.max.x >= 2);
}

// 4. THE ONE THAT MATTERS: a wall stops you, a doorway does not
{
  clean();
  fitStructureBoxes('house', PLAN.boxes, AT);

  // dead centre of the solid segment (x 1..2), standing on the wall line
  const atWall = new THREE.Vector3(1.5, WALK, 0);
  resolveColliders(atWall, flat);
  check('a solid wall pushes a body out', Math.abs(atWall.z) > 0.01,
    `moved to z=${atWall.z.toFixed(3)}`);

  // dead centre of the doorway — the whole segment (x 0..1) is open
  const atDoor = new THREE.Vector3(0.5, WALK, 0);
  const before = { x: atDoor.x, z: atDoor.z };
  resolveColliders(atDoor, flat);
  check('a doorway lets a body stand in it',
    Math.abs(atDoor.z - before.z) < 1e-6 && Math.abs(atDoor.x - before.x) < 1e-6,
    `moved to (${atDoor.x.toFixed(3)}, ${atDoor.z.toFixed(3)})`);

  // The opening must not leak into its neighbour. Assert the body ends up
  // OUTSIDE the solid segment's volume rather than naming an axis: near a
  // segment's end the nearest way out is legitimately sideways (a 15cm wall is
  // thinner than a 32cm body), and demanding a z-push there would be asserting
  // the solver's arithmetic rather than the wall's solidity.
  const atEdge = new THREE.Vector3(1.05, WALK, 0);
  resolveColliders(atEdge, flat);
  const insideWall = atEdge.x > 1 && atEdge.x < 2 && Math.abs(atEdge.z) < 0.075;
  check('the doorway does not leak into the next segment', !insideWall,
    `ended at (${atEdge.x.toFixed(3)}, ${atEdge.z.toFixed(3)})`);
}

// 5. the lintel is overhead, not underfoot — you can walk UNDER a doorway
{
  clean();
  fitStructureBoxes('house', PLAN.boxes, AT);
  // standing in the doorway, the ground is the floor slab's TOP, not the lintel:
  // a body must not be lifted 2.1m by the thing above its head
  const g = resolveColliders(new THREE.Vector3(0.5, WALK, 0.5), flat);
  check('ground under a doorway is the floor, not the lintel',
    Math.abs(g - WALK) < 1e-6, `ground=${g}, walk=${WALK}`);
  // and the floor holds you UP rather than pushing you aside — the support
  // contract. A body dropped at grade inside the house rises onto the slab.
  const low = new THREE.Vector3(0.5, 0, 0.5);
  const gy = resolveColliders(low, flat);
  check('a floor lifts a body standing at grade, never ejects it',
    Math.abs(gy - WALK) < 1e-6 && Math.abs(low.x - 0.5) < 1e-9 && Math.abs(low.z - 0.5) < 1e-9,
    `ground=${gy}, moved to (${low.x.toFixed(3)}, ${low.z.toFixed(3)})`);
}

// 6. surfaceUnder finds the slab and ignores the mask
{
  clean();
  fitStructureBoxes('house', PLAN.boxes, AT);
  const { y, onto } = surfaceUnder(0.5, 0.5, flat) as any;
  check('surfaceUnder lands on the floor slab top', Math.abs(y - WALK) < 1e-6, `y=${y}`);
  check('surfaceUnder never reports the mask', onto !== 'house#mask', `onto=${onto}`);
}

// 7. ownership: retire is total and idempotent
{
  clean();
  fitStructureBoxes('house', PLAN.boxes, AT);
  fitStructureBoxes('other', PLAN.boxes, { ...AT, position: [50, 0, 50] });
  const before = colliders.size;
  removeStructureBoxes('house');
  check('retiring a building drops exactly its own boxes',
    colliders.size === before - (PLAN.boxes.length + 1) && structureBoxIds('house').length === 0,
    `${before} → ${colliders.size}`);
  check("the neighbour's building is untouched", structureBoxIds('other').length === PLAN.boxes.length + 1);
  removeStructureBoxes('house');
  check('retiring twice is harmless', structureBoxIds('house').length === 0);
  // a re-fit REPLACES rather than accumulating — the realizer rebuilds wholesale
  fitStructureBoxes('other', PLAN.boxes, { ...AT, position: [50, 0, 50] });
  check('re-fitting replaces, never doubles',
    structureBoxIds('other').length === PLAN.boxes.length + 1);
}

// 8. totality — a malformed declaration registers nothing, never throws
{
  clean();
  let threw = 0;
  for (const args of [
    [null, AT], [[], AT], [[{}], AT],
    [PLAN.boxes, { position: [NaN, 0, 0], yaw: 0, scale: 1 }],
    [PLAN.boxes, { position: [0, 0, 0], yaw: 0, scale: 0 }],
    [PLAN.boxes, {}],
  ] as any[]) {
    try { fitStructureBoxes('bad', args[0], args[1]); } catch { threw++; }
  }
  check('no malformed declaration throws', threw === 0, `${threw} threw`);
  check('and none of them registered anything', structureBoxIds('bad').length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
