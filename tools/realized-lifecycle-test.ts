// realized-lifecycle-test — the four "realized" registries agree about every id, at every seam of a thing's life.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/realized-lifecycle-test.ts
//
// The realizer (client/lib/realize/models.js, REAL here) hands an id to world.js `entities`, its own `tracked`, the
// collider registry and the caster registry at different moments: tracked + a null reservation at create, the object
// at realize, collider + caster at the promote tail. A `remove` (or a demote, a same-id re-create, a world reset) can
// land between any two of those. The survey (DEBT-SURVEY-2026-10-12 §2.13) read the mechanism and named the drift —
// a remove landing mid-GLB-load leaving `entities` holding null, `tracked` a gen, `casters` warm — without
// reproducing it. This pins it either way: after each seam, ALL FOUR registries are empty for a removed id, and all
// four hold it after a full realize. Same cone as lod-client-test (tools/lod-client-stub.mjs: a loader the test holds
// open and releases by hand; colliders and casters recorded, never built).
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';

const STUB = fileURLToPath(new URL('./lod-client-stub.mjs', import.meta.url));
plugin({
  name: 'lod-client-stub',
  setup(b) {
    for (const f of ['^\\.\\./core\\.js$', '^\\.\\./assets\\.js$', '^\\.\\./colliders\\.js$',
      '^\\.\\./lightrig\\.js$', '^\\.\\./lights\\.js$', '^\\.\\./world\\.js$', '^\\.\\./materials\\.js$']) {
      b.onResolve({ filter: new RegExp(f) }, () => ({ path: STUB }));
    }
  },
});
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

const stub: any = await import('./lod-client-stub.mjs');
const M: any = await import('../client/lib/realize/models.js');
const S: any = await import('../client/lib/state.js');
const { scratchWorld } = await import('./protocol/scratchworld.ts');
const { emptyView } = await import('../shared/protocol/view.js');
const { bus } = await import('../client/lib/base.js');

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${!ok && detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 6; i++) await sleep(15); };

const lib = (id: string) => `eidoverse/assets/models/${id}.glb`;
const GEOM = { bbox: { size: [1, 1, 1], center: [0, 0.5, 0] } };
const W = scratchWorld('realized');
const door = (tool: string, args: any) => { const r = W.call(tool, args); if (!r.ok) throw new Error(`${tool} ${JSON.stringify(args)} refused: ${JSON.stringify(r.refused)}`); S.applyView(structuredClone(W.view())); return r; };
const spawnAt = (id: string, z: number, model = lib(id)) => {
  bus.emit('lib-geom', { [model]: GEOM });
  door('create', { id, model, components: { transform: { pos: [0, 0, z] } } });
};
const drain = () => { for (let i = 0; i < 50 && M.promoteTailPending() > 0; i++) M.drainPromoteTail(); };
/** What each registry says about an id — the one shape every check reads. */
const held = (id: string) => ({
  entities: stub.entities.has(id) ? (stub.entities.get(id) === null ? 'null' : stub.entities.get(id).userData?.placeholder ? 'placeholder' : 'object') : '-',
  tracked: M.realizedAs(id) ? 'yes' : '-',
  colliders: stub.colliders.has(id) ? 'yes' : '-',
  casters: stub.casters.has(id) ? 'yes' : '-',
});
const gone = (id: string) => { const h = held(id); return h.entities === '-' && h.tracked === '-' && h.colliders === '-' && h.casters === '-'; };
const full = (id: string) => { const h = held(id); return h.entities === 'object' && h.tracked === 'yes' && h.colliders === 'yes' && h.casters === 'yes'; };
const releaseAll = async () => { for (const h of stub.held.splice(0)) h.release(); await settle(); };
const noErrors = (label: string) => { check(`${label}: no realizer error reported`, stub.reports.length === 0, JSON.stringify(stub.reports.map((r: any) => [r.where, String(r.e?.message ?? r.e)]))); stub.reports.length = 0; };

M.initModelsRealizer();
S.hydrate(emptyView());
stub.camera.position.set(0, 0, 0);

console.log('\nrealized lifecycle — four registries, one id, every seam\n');

// ---- 1. the full life, as the baseline the races are measured against
{
  spawnAt('a', 5); await settle(); drain();
  check('realized + tail drained: all four hold it', full('a'), JSON.stringify(held('a')));
  door('delete', { id: 'a' });
  check('remove after a full realize: all four empty', gone('a'), JSON.stringify(held('a')));
  noErrors('full life');
}

// ---- 2. the survey's race: remove while the GLB is in flight
{
  stub.setHold(true);
  spawnAt('b', 5); await settle();
  check('mid-load: a placeholder stands, tracked holds it, no collider, no caster', held('b').entities === 'placeholder' && held('b').tracked === 'yes' && held('b').colliders === '-' && held('b').casters === '-', JSON.stringify(held('b')));
  check('…and the load is held open', stub.held.some((h: any) => h.lib === lib('b')));
  door('delete', { id: 'b' });
  check('remove lands mid-load: all four empty BEFORE the bytes land', gone('b'), JSON.stringify(held('b')));
  stub.setHold(false);
  await releaseAll(); drain();
  check('the bytes land for a gone id: all four STILL empty (the completion re-read state and stood down)', gone('b'), JSON.stringify(held('b')));
  check('nothing was added to the scene for it', !stub.scene.children.some((o: any) => o.userData?.entityId === 'b'));
  noErrors('remove mid-load');
}

// ---- 3. remove between realize and the promote tail (the heavy tail is a later frame)
{
  spawnAt('c', 5); await settle();
  check('realized, tail pending: object + tracked, no collider, no caster yet', held('c').entities === 'object' && held('c').tracked === 'yes' && held('c').colliders === '-' && held('c').casters === '-' && M.promoteTailPending() === 1, JSON.stringify({ ...held('c'), tail: M.promoteTailPending() }));
  door('delete', { id: 'c' });
  drain();
  check('remove before the tail drained: all four empty, the tail never registered a caster or fitted a collider', gone('c') && M.promoteTailPending() === 0, JSON.stringify(held('c')));
  noErrors('remove before tail');
}

// ---- 4. the same id re-modelled (set model) over a load still in flight: the OLD completion must leave nothing
{
  stub.setHold(true);
  spawnAt('d', 5); await settle();
  const oldHeld = stub.held.find((h: any) => h.lib === lib('d'));
  bus.emit('lib-geom', { [lib('d2')]: GEOM });
  door('set', { id: 'd', component: 'model', value: lib('d2') }); await settle();
  // the aborted old job still occupies the scheduler's net lane until its bytes land, so the new load waits behind it
  check('re-modelled mid-load: a new reservation stands; the old load is still held and the new one queued behind it',
    held('d').entities === 'placeholder' && held('d').tracked === 'yes' && stub.held.length === 1 && oldHeld && !stub.loads.some((l: any) => l.lib === lib('d2')), JSON.stringify({ ...held('d'), held: stub.held.map((h: any) => h.lib) }));
  oldHeld.release(); await settle(); drain();
  check('the OLD bytes land: still a placeholder, for the NEW lib — the stale completion neither realized nor cleared the reservation; the new load is now held too',
    held('d').entities === 'placeholder' && held('d').tracked === 'yes' && held('d').colliders === '-' && held('d').casters === '-' && stub.held.some((h: any) => h.lib === lib('d2')), JSON.stringify({ ...held('d'), held: stub.held.map((h: any) => h.lib) }));
  stub.setHold(false);
  await releaseAll(); drain();
  check('the NEW bytes land: all four hold it, wearing the new lib', full('d') && stub.entities.get('d').userData.lib === lib('d2'), JSON.stringify({ ...held('d'), lib: stub.entities.get('d')?.userData?.lib }));
  door('delete', { id: 'd' });
  check('removed: all four empty', gone('d'), JSON.stringify(held('d')));
  noErrors('re-model over a held load');
}

// ---- 5. demote (residency sweep): the stand-in holds no collider and no caster; promote brings both back
{
  spawnAt('e', 5); await settle(); drain();
  check('near: full', full('e'), JSON.stringify(held('e')));
  stub.camera.position.set(0, 0, -500);
  M.residencySweep(); await settle();
  check('demoted: entities holds the placeholder, tracked holds it, collider and caster are RELEASED', held('e').entities === 'placeholder' && held('e').tracked === 'yes' && held('e').colliders === '-' && held('e').casters === '-', JSON.stringify(held('e')));
  stub.camera.position.set(0, 0, 0);
  M.residencySweep(); await settle(); drain();
  check('promoted again: all four hold it', full('e'), JSON.stringify(held('e')));
  door('delete', { id: 'e' });
  check('removed: all four empty', gone('e'), JSON.stringify(held('e')));
  noErrors('demote / promote');
}

// ---- 6. a world reset with a load in flight and a realized thing standing: nothing survives in any registry
{
  stub.setHold(true);
  spawnAt('f', 5); await settle();
  stub.setHold(false);
  spawnAt('g', 5); await settle(); drain();
  check('one mid-load, one full', held('f').entities === 'placeholder' && full('g'), JSON.stringify({ f: held('f'), g: held('g') }));
  S.reset();
  check('reset: all four empty for both', gone('f') && gone('g'), JSON.stringify({ f: held('f'), g: held('g') }));
  await releaseAll(); drain();
  check('the held bytes land after the reset: still empty', gone('f'), JSON.stringify(held('f')));
  noErrors('reset');
}

console.log(`\n${failures ? `\x1b[31m${failures} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'}\n`);
W.close?.();
process.exit(failures ? 1 : 0);
