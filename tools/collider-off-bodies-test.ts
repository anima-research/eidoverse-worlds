// collider-off-bodies-test — a thing whose collision is off for bodies (collider {enabled: false}, or blocks without
// "bodies": simlayer.js solidOff, the authority's reading) gives the walker nothing to meet, on every path the client
// realizes it by (review of PR #260).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/collider-off-bodies-test.ts
//
// The REAL realizers (client/lib/realize/models.js and structure.js), state.js and the real bus, and the REAL
// colliders.js with resolveColliders, the walker's own step; the renderer cone stubbed (tools/collider-off-stub.mjs). Fed
// the views a client folds from a scratch world behind the real door (hydrate the cut's view, then applyView after each
// write), as components-wire-test does. No server process, no browser.
//
// What each part pins:
//  - a mesh thing: no collider when it loads, when it's born live, when a mesh change re-births it, and when it's
//    dismounted (models.js createMesh, execDismount);
//  - a structure thing: no wall or floor box, only the grass mask, and a live collider change takes its boxes away and
//    back (structure.js realize, onChange);
//  - the structure realizer's retire() gives an anchor back only for a building it realized: a thing born without a
//    structure keeps its `hidden`, its collider off, and the collider preference it asked for; and a building whose
//    structure is removed has its anchor back as hidden as it says, with the collider preference it asks for;
//  - controls beside each: the same thing with collision on has its collider, and a walker stepping into it is pushed out.
import "./protocol/fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STUB = fileURLToPath(new URL('./collider-off-stub.mjs', import.meta.url));
plugin({
  name: 'collider-off-stub',
  setup(b) {
    for (const f of ['^\\.\\./(core|assets|lightrig|lights|world|materials|defs)\\.js$', '^\\./(core|world|remotes)\\.js$']) {
      b.onResolve({ filter: new RegExp(f) }, () => ({ path: STUB }));
    }
  },
});

// config.ts makes WORLDS_DIR at import: keep the bench out of the repo's worlds/
const SCRATCH = mkdtempSync(join(tmpdir(), 'ew-collider-off-'));
process.env.WORLDS_DIR = join(SCRATCH, 'worlds');

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const stub: any = await import('./collider-off-stub.mjs');
const C: any = await import('../client/lib/colliders.js');
const M: any = await import('../client/lib/realize/models.js');
const ST: any = await import('../client/lib/realize/structure.js');
const S: any = await import('../client/lib/state.js');
const { scratchWorld } = await import('./protocol/scratchworld.ts');
const { until } = await import('./protocol/wait.ts');

const MESH = { shape: 'box', size: [2, 2, 2] };
// a two-cell room with its north wall, no doorway (structure-collider-test's house, without its door)
const HOUSE = { levels: [{ y: 0, tiles: [[0, 0], [1, 0]], walls: [[0, 0, 0], [0, 1, 0]] }] };
const W = scratchWorld('collideroff');
W.seed({
  meshoff: { pos: [5, 0, 0], mesh: MESH, collider: { enabled: false } },
  meshhulls: { pos: [10, 0, 0], mesh: MESH, collider: { blocks: ['hulls'] } },
  meshon: { pos: [15, 0, 0], mesh: MESH },
  modeloff: { model: 'eidoverse/assets/models/crate.glb', pos: [0, 0, 6], collider: { enabled: false } },
  modelon: { model: 'eidoverse/assets/models/crate.glb', pos: [3, 0, 6] },
  hiddenload: { pos: [-10, 0, 0], mesh: MESH, hidden: true },
  exactload: { pos: [25, 0, -6], mesh: MESH, collider: { shape: 'mesh' } },
  lightload: { pos: [-25, 0, -6], light: { intensity: 1 } },
  // each building's anchor is a mesh, so giving it back (its structure removed) has a shape to fit a collider to
  houseoff: { pos: [20, 0, 10], structure: HOUSE, mesh: MESH, collider: { enabled: false } },
  houseon: { pos: [-20, 0, 10], structure: HOUSE, mesh: MESH },
  househulls: { pos: [0, 0, 20], structure: HOUSE, mesh: MESH, collider: { blocks: ['hulls'] } },
  househidden: { pos: [10, 0, 20], structure: HOUSE, mesh: MESH, hidden: true },
  houseexact: { pos: [-10, 0, 20], structure: HOUSE, mesh: MESH, collider: { shape: 'mesh' } },
  cart: { pos: [0, 0, -20], mesh: MESH },
  rideoff: { pos: [0, 0, 0], mesh: MESH, collider: { enabled: false }, parent: { to: 'cart', offset: [0, 2, 0] } },
  rideon: { pos: [0, 0, 0], mesh: MESH, parent: { to: 'cart', offset: [0, 4, 0] } },
});
M.initModelsRealizer();
ST.initStructureRealizer();
S.hydrate(structuredClone(W.view()));
const live = (tool: string, args: any) => { const r = W.call(tool, args); if (!r.ok) throw new Error(`${tool} ${JSON.stringify(args)} refused: ${JSON.stringify(r.refused)}`); S.applyView(structuredClone(W.view())); return r; };
const settled = () => { M.residencySweep?.(); M.drainPromoteTail?.(); };
const realized = (id: string) => until(`${id} realized`, () => { settled(); return stub.entities.get(id); });
/** a model loaded and promoted, with its promote tail (where its collider is fitted) run */
const promoted = (id: string) => until(`${id} promoted`, () => { settled(); const o = stub.entities.get(id); return o?.userData?.lib && M.promoteTailPending() === 0 && o; });
const has = (id: string) => C.colliders.has(id);
/** where a walker standing at (x, z) on flat ground ends after the collider step */
const step = (x: number, z: number) => { const p = { x, y: 0, z }; C.resolveColliders(p, () => 0); return [+p.x.toFixed(3), +p.z.toFixed(3)]; };
const moved = (at: number[], x: number, z: number) => at[0] !== x || at[1] !== z;

console.log('\na mesh thing (models.js createMesh)');
for (const id of ['meshoff', 'meshhulls', 'meshon', 'hiddenload', 'cart']) await realized(id);
check('collider {enabled: false}: no collider once it loads', !has('meshoff'));
check('collider {blocks: ["hulls"]}: no collider once it loads (bodies aren\'t blocked)', !has('meshhulls'));
check('control: a mesh with no collider component has one', has('meshon'));
await promoted('modeloff'); await promoted('modelon');
check('control: a model with collider {enabled: false} has none once promoted (runPromoteTail\'s check)', !has('modeloff'));
check('control: a model with no collider component has one once promoted', has('modelon'));
const intoOff = step(4.2, 0), intoOn = step(14.2, 0);
check('a walker stepping 0.2 m into the collision-off mesh\'s box stays where it stepped', !moved(intoOff, 4.2, 0), JSON.stringify(intoOff));
check('control: the same step into the collision-on mesh pushes it out', moved(intoOn, 14.2, 0), JSON.stringify(intoOn));

W.seed({ meshlive: { pos: [5, 0, -6], mesh: MESH, collider: { enabled: false } }, hiddenborn: { pos: [-5, 0, 0], mesh: MESH, hidden: true },
  exactborn: { pos: [30, 0, -6], mesh: MESH, collider: { shape: 'mesh' } }, lightborn: { pos: [-30, 0, -6], light: { intensity: 1 } } });
S.applyView(structuredClone(W.view()));
const meshlive = await realized('meshlive'), hiddenborn = await realized('hiddenborn');
await realized('exactborn'); await realized('exactload');
const lightborn = await realized('lightborn'), lightload = await realized('lightload');
// an Empty owns no collider (its only mesh is a light's gizmo): the structure realizer's retire() fitted one to it
check('born live, a light (an Empty with its gizmo) has no collider', lightborn.userData?.empty === true && !has('lightborn'));
check('control: loaded with the world, the same', lightload.userData?.empty === true && !has('lightload'));
// the structure realizer's retire() refitted a thing it never realized with no preference, after the models realizer
// had fitted it with its own: a collider {shape: "mesh"} became one decided by size
check('born live with collider {shape: "mesh"}: its collider keeps the preference it asked for', C.colliders.get('exactborn')?.pref === 'exact',
  JSON.stringify(C.colliders.get('exactborn')?.pref ?? null));
check('control: loaded with the world, the same', C.colliders.get('exactload')?.pref === 'exact', JSON.stringify(C.colliders.get('exactload')?.pref ?? null));
check('born live with collision off: no collider (neither createMesh nor the structure realizer fits one)', !has('meshlive'));
check('born live with hidden: true: not drawn (the structure realizer\'s retire() leaves a thing it never realized alone)', hiddenborn.visible === false);
check('control: loaded with hidden: true, not drawn', stub.entities.get('hiddenload')?.visible === false);
check('control: born live and not hidden, drawn', meshlive.visible === true);

live('set', { id: 'meshhulls', component: 'mesh', value: { shape: 'box', size: [4, 4, 4] } });
await until('meshhulls rebuilt at its new size', () => { const o = stub.entities.get('meshhulls'); return o?.userData?.meshSize?.[0] === 4 && o; });
check('a mesh change on a collision-off mesh (folded as gone, then born) leaves it with no collider', !has('meshhulls'));

console.log('\nsteps off a carrier (models.js execDismount)');
const riders = () => [stub.entities.get('rideoff'), stub.entities.get('rideon')];
await until('the riders realized and mounted', () => { settled(); return riders().every((o: any) => o?.userData?.mountedTo); });
check('mounted: neither rider has a collider while it rides', !has('rideoff') && !has('rideon'));
live('delete', { id: 'rideoff', component: 'parent' });
live('delete', { id: 'rideon', component: 'parent' });
await until('the riders dismounted', () => riders().every((o: any) => o && !o.userData?.mountedTo));
check('dismounted with collision off: no collider', !has('rideoff'));
check('control: dismounted with collision on: a collider', has('rideon'));
// Not here: the carrier's own retire stepping its cargo off (models.js, the step-off in retire). A delete takes the
// cargo with it (the door deletes the subtree), and a mesh change on the carrier didn't reach the step-off either, so its
// guard is the same collisionOwnedElsewhere read as execDismount's, held by reading.

console.log('\na structure thing (structure.js realize)');
const boxes = (id: string) => C.structureBoxIds(id).filter((k: string) => !k.endsWith('#mask'));
const wallCentre = (id: string) => {
  const k = boxes(id).find((b: string) => C.colliders.get(b)?.structKind === 'wall');
  const e = k && C.colliders.get(k);
  return e ? [e.obj.position.x + (e.box.min.x + e.box.max.x) / 2, e.obj.position.z + (e.box.min.z + e.box.max.z) / 2] : null;
};
check('control: collision on, its floor and wall boxes register', boxes('houseon').length === 3, JSON.stringify(C.structureBoxIds('houseon')));
const onWall = wallCentre('houseon');
const atOn = onWall ? step(onWall[0], onWall[1]) : null;
check('control: a walker at its wall\'s centre is pushed out', !!atOn && moved(atOn, onWall![0], onWall![1]), JSON.stringify([onWall, atOn]));
check('collision off: no floor or wall box, only the grass mask', boxes('houseoff').length === 0 && C.structureBoxIds('houseoff').some((k: string) => k.endsWith('#mask')),
  JSON.stringify(C.structureBoxIds('houseoff')));
check('collider {blocks: ["hulls"]}: no floor or wall box, only the grass mask', boxes('househulls').length === 0 && C.structureBoxIds('househulls').some((k: string) => k.endsWith('#mask')),
  JSON.stringify(C.structureBoxIds('househulls')));
// the same wall, 40 m east: houseoff stands at [20, 0, 10], houseon at [-20, 0, 10]
const atOff = onWall ? step(onWall[0] + 40, onWall[1]) : null;
check('collision off: a walker where its wall stands stays where it stepped', !!atOff && !moved(atOff, onWall![0] + 40, onWall![1]), JSON.stringify(atOff));
live('set', { id: 'houseon', component: 'collider', value: { enabled: false } });
check('switching a building\'s collision off live takes its boxes away and keeps its mask', boxes('houseon').length === 0 && C.structureBoxIds('houseon').some((k: string) => k.endsWith('#mask')),
  JSON.stringify(C.structureBoxIds('houseon')));
live('set', { id: 'houseon', component: 'collider', value: { enabled: true } });
check('…and back on brings them back', boxes('houseon').length === 3, JSON.stringify(C.structureBoxIds('houseon')));
live('delete', { id: 'houseoff', component: 'structure' });
check('a collision-off building\'s structure removed: its anchor comes back with no collider', !has('houseoff') && C.structureBoxIds('houseoff').length === 0);
live('delete', { id: 'houseon', component: 'structure' });
check('control: a collision-on building\'s structure removed: its anchor comes back drawn and solid',
  has('houseon') && stub.entities.get('houseon')?.visible === true, JSON.stringify([has('houseon'), stub.entities.get('houseon')?.visible]));
live('delete', { id: 'househidden', component: 'structure' });
check('a hidden building\'s structure removed: its anchor comes back still hidden', stub.entities.get('househidden')?.visible === false,
  JSON.stringify(stub.entities.get('househidden')?.visible ?? 'no object'));
live('delete', { id: 'houseexact', component: 'structure' });
check('a building with collider {shape: "mesh"}: its structure removed, its anchor\'s collider keeps that preference',
  C.colliders.get('houseexact')?.pref === 'exact', JSON.stringify(C.colliders.get('houseexact')?.pref ?? null));

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
