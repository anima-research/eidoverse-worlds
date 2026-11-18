// arrivalhold-test — the arrival hold's decision (client/lib/arrivalhold.js solidArriving) through the REAL realizer
// (client/lib/realize/models.js modelArriving, modelFootprint), on records the v4 door wrote: a model's footprint is
// where the renderer puts it, its chain folded by shared/hierarchy.js worldPose.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/arrivalhold-test.ts
// Same cone as realized-lifecycle-test (test/stubs/lod-client-stub.mjs: loads the test holds open). The pure rules:
// arrival-hold-test.ts.
import "../harness/fixture-ids.ts";
import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
import { fileURLToPath } from 'node:url';
import { suite } from '../gate/suite.ts';

const STUB = fileURLToPath(new URL('../stubs/lod-client-stub.mjs', import.meta.url));
plugin({
  name: 'lod-client-stub',
  setup(b) {
    for (const f of ['^\\.\\./core\\.js$', '^\\.\\./assets\\.js$', '^\\.\\./colliders\\.js$',
      '^(\\.\\.?/)+(render/)?lightrig\\.js$', '^(\\.\\.?/)+(render/)?lightgizmo\\.js$', '^\\.\\./world\\.js$', '^(\\.\\.?/)+(render/)?materials\\.js$']) {
      stubResolve(b, new RegExp(f), () => ({ path: STUB }));
    }
  },
});
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

const stub: any = await import('../stubs/lod-client-stub.mjs');
const M: any = await import('../../client/lib/realize/models.js');
const S: any = await import('../../client/lib/state.js');
const H: any = await import('../../client/lib/arrivalhold.js');
const { scratchWorld } = await import('../harness/scratchworld.ts');
const { emptyView } = await import('../../shared/protocol/view.js');
const { qFromYaw } = await import('../../shared/rot.js');
const { bus } = await import('../../client/lib/base.js');

const { ok, done } = suite('arrivalhold');
// the realizer's work is microtasks (the scheduler pumps on queueMicrotask): a few loop turns, no timer
const settle = async () => { for (let i = 0; i < 24; i++) await new Promise((r) => setImmediate(r)); };
const lib = (id: string) => `eidoverse/assets/models/${id}.glb`;
const W = scratchWorld('arrivalhold');
const door = (tool: string, args: any) => { const r = W.call(tool, args); if (!r.ok) throw new Error(`${tool} ${JSON.stringify(args)} refused: ${JSON.stringify(r.refused)}`); S.applyView(structuredClone(W.view())); return r; };
// a 4×4×4 m building, its origin at its base
const BLDG = { bbox: { size: [4, 4, 4], center: [0, 2, 0] } };
const at = (id: string) => S.state.st.entities[id];
const said = (id: string) => JSON.stringify({ rec: { pos: at(id)?.pos, parent: at(id)?.parent }, arriving: M.modelArriving(id), foot: M.modelFootprint(id, at(id)) });

M.initModelsRealizer();
S.hydrate(emptyView());
stub.setHold(true);   // every load stays in flight: each building below is still on its way
stub.camera.position.set(0, 0, 0);

console.log('\narrival hold — a restored body at the origin, a building still loading near it or not\n');

// AH1: the carrier stands far off, turned and scaled; the building's local offset brings it back under the body.
// Its record's own pos (parent-local) is 100 m away. Mutation (must go red): footprint from the record's own pos/yaw/scale.
{
  bus.emit('lib-geom', { [lib('home')]: BLDG });
  door('create', { id: 'cart', components: { transform: { pos: [200, 0, 0], q: qFromYaw(Math.PI / 2), scale: [2, 2, 2] } } });
  // R_y(90°)·(2·(0, 0, -100)) = (-200, 0, 0): with the carrier at (200, 0, 0), the building stands at the origin
  door('create', { id: 'home', model: lib('home'), components: { parent: { to: 'cart' }, transform: { pos: [0, 0, -100] } } });
  await settle();
  ok(M.modelArriving('home') && at('home')?.parent?.to === 'cart' && Math.hypot(at('home').pos[0], at('home').pos[2]) === 100,
    'AH1 setup: the building is still loading, parented, its own pos 100 m from the body', said('home'));
  ok(H.solidArriving(0, 0), 'AH1 a building whose carrier puts it under the body holds the body, however far its local pos is', said('home'));
  door('delete', { id: 'home' }); door('delete', { id: 'cart' });
}

// AH2: the reverse: the building's local pos is at the body, but its carrier puts it 200 m away. The camera stood by
// it when it was placed (photo mode: the body is elsewhere), so its load is in flight.
{
  bus.emit('lib-geom', { [lib('shed')]: BLDG });
  stub.camera.position.set(200, 0, 0);
  door('create', { id: 'dray', components: { transform: { pos: [200, 0, 0] } } });
  door('create', { id: 'shed', model: lib('shed'), components: { parent: { to: 'dray' }, transform: { pos: [0, 0, 0] } } });
  await settle();
  stub.camera.position.set(0, 0, 0);
  ok(M.modelArriving('shed') && at('shed')?.pos?.join() === '0,0,0', 'AH2 setup: the building is still loading, its own pos at the body', said('shed'));
  ok(!H.solidArriving(0, 0), 'AH2 a building whose carrier puts it 200 m off does not hold the body, though its local pos is at it', said('shed'));
  door('delete', { id: 'shed' }); door('delete', { id: 'dray' });
}

// AH3: a long floor stretched 100× along x (scale3) reaches a body near its far end
{
  bus.emit('lib-geom', { [lib('deck')]: { bbox: { size: [1, 0.2, 1], center: [0, 0.1, 0] } } });
  door('create', { id: 'deck', model: lib('deck'), components: { transform: { pos: [-45, 0, 0], scale: [100, 1, 1] } } });
  await settle();
  ok(M.modelArriving('deck') && Array.isArray(at('deck')?.scale3), 'AH3 setup: the floor is still loading, scaled per axis', said('deck'));
  ok(H.solidArriving(0, 0), 'AH3 a floor stretched 100× along x, its far end 5 m from the body, holds it', said('deck'));
  door('delete', { id: 'deck' });
}

// AH4: a tall mast tipped over (90° about z) lies along the ground: its height is across the ground now
{
  bus.emit('lib-geom', { [lib('mast')]: { bbox: { size: [0.5, 60, 0.5], center: [0, 30, 0] } } });
  const s = Math.SQRT1_2;
  // R_z(+90°) turns +y to -x: the mast, standing at (40, 0, 0), lies from x = 40 to x = -20
  door('create', { id: 'mast', model: lib('mast'), components: { transform: { pos: [40, 0, 0], q: [0, 0, s, s] } } });
  await settle();
  ok(M.modelArriving('mast'), 'AH4 setup: the mast is still loading', said('mast'));
  ok(H.solidArriving(0, 0), 'AH4 a mast lying across the body\'s spot holds it, though it stands 40 m off', said('mast'));
  door('delete', { id: 'mast' });
}

// AH5: a carrier with a whole-body motion may have carried its building anywhere from where the fold folds it, as the
// building's own motion may (modelFootprint): it can't be ruled out
{
  bus.emit('lib-geom', { [lib('hut')]: BLDG });
  stub.camera.position.set(200, 0, 0);
  door('create', { id: 'raft', components: { transform: { pos: [200, 0, 0] }, motion: { type: 'spin', degPerSec: 30 } } });
  door('create', { id: 'hut', model: lib('hut'), components: { parent: { to: 'raft' }, transform: { pos: [0, 0, 0] } } });
  await settle();
  stub.camera.position.set(0, 0, 0);
  ok(M.modelArriving('hut') && at('raft')?.motion?.type === 'spin' && !at('hut')?.motion, 'AH5 setup: the building is still loading, its carrier moving, itself not', said('hut'));
  ok(H.solidArriving(0, 0), 'AH5 a building on a moving carrier holds the body wherever the carrier is folded', said('hut'));
  door('delete', { id: 'hut' }); door('delete', { id: 'raft' });
}

stub.setHold(false);
for (const h of stub.held.splice(0)) h.release();
await settle();
done();
