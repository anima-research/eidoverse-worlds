// lod-client-test — the product door of #170, headless and owned.
//
//   bun test/client/lod-client-test.ts
//
// What the pure chooser (test/client/lod-policy-test.ts) cannot say: that the
// resident's dial, the residency sweep, the loader's wire, the sequencer's
// answer, the in-place replacement and the collider all AGREE. Review of
// #170, point 4 — "the committed receipt stops at the pure chooser".
//
// Three parts. The REALIZER part runs the real client/lib/realize/models.js
// and the real governor.js (with the real policy, fold, scheduler and bus)
// over a stub of their dependency cone — test/stubs/lod-client-stub.mjs: no
// renderer; a loader whose tier is the WIRE truth (askFor), whose
// "sequencer" answers a stamped variant for libs it baked and the original
// otherwise, and which the test can hold open and release by hand, so a
// tier swap is caught mid-flight; colliders recorded, never built; every
// governor lever below 'lod' answering "nothing to shed". The WIRE part
// spawns a sequencer child PROCESS-OWNED (WORLD_INSTANCE_NONCE, as
// object-lod-test does) over a fixture library and pushes the exact URLs the
// loader would send through it — capable, incapable, wrong generation, an
// authored `recipe` extra — reading the served tier with the same tierOf the
// loader uses. The PRODUCTION-LOADER part (round three of the review) then
// runs the real, unmodified client/lib/assets.js against that same child
// (test/client/lod-loader-child.ts: only a renderer that never draws and the frame
// conductors injected below it, its relative fetches resolved to the child),
// once per /version shape — the real one, one with no recipe, one with no
// key — and asserts the URL it fetched, the cache key it chose and the
// tierAsked / tierServed it stamped. A mutation at that seam (`tier =
// req.tier`, the url, the stamps) fails here; a stubbed loader could not
// say so, and the review caught exactly that.
//
// Negative controls, each named in its check: the churn of the first field
// run (an "already light" answer re-asked every cooldown), a held tier swap
// landing over an occupant / cargo / a part motion / an edit hold, a lod ask a
// non-KTX2 browser reports without ever sending, an authored `recipe`
// extra read as a served lod, a governor lever overriding the resident's
// "full detail".
import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn as spawnProc, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STUB = fileURLToPath(new URL('../stubs/lod-client-stub.mjs', import.meta.url));
plugin({
  name: 'lod-client-stub',
  setup(b) {
    // the realizer's cone (imported from realize/ as ../x.js) and the
    // governor's cone (imported from render/ as ./x.js or ../x.js) — state, scheduler,
    // policy, fold and the bus stay REAL, and so do models.js and governor.js
    for (const f of ['^\\.\\./core\\.js$', '^\\.\\./assets\\.js$', '^\\.\\./colliders\\.js$', '^(\\.\\.?/)+(render/)?lightrig\\.js$', '^(\\.\\.?/)+(render/)?lightgizmo\\.js$', '^\\.\\./world\\.js$',
      '^(\\.\\.?/)+(render/)?materials\\.js$', '^\\.\\.?/realize/emitters\\.js$', '^\\.\\.?/terrain\\.js$', '^(\\.\\.?/)+(render/)?frameloop\\.js$', '^(\\.\\.?/)+(player/)?remotes\\.js$', '^(\\.\\.?/)+(ui/)?ui\\.js$',
      '^(\\.\\.?/)+(ui/)?statuschips\\.js$']) {
      stubResolve(b, new RegExp(f), () => ({ path: STUB }));
    }
  },
});
// the dial persists through localStorage — a Map-backed one, inspectable
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

const stub: any = await import('../stubs/lod-client-stub.mjs');
const M: any = await import('../../client/lib/realize/models.js');
const S: any = await import('../../client/lib/state.js');
const { scratchWorld } = await import('../harness/scratchworld.ts');
const { emptyView } = await import('../../shared/protocol/view.js');
const { bus } = await import('../../client/lib/base.js');
const { makeModelQuality, askFor, tierOf } = await import('../../client/lib/render/lod_policy.js');
const { keyFromVersion, lodFromVersion, negotiate, withLod } = await import('../../shared/ktx2.js');
const { LOD_RECIPE } = await import('../../server/store-variants.ts');
const rig: any = await import('../../tools/assets/rig-load.mjs');
const { freePort } = await import('../harness/harness.ts');

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${!ok && detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};
/** Let the scheduler's microtask pump and the stub loader run out (both are microtasks: a few loop turns, no timer). */
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const { tryUntil } = await import('../gate/wait.ts');

// ============================================================================
console.log('\nlod-client — the realizer half (real models.js over a held loader)\n');

const REC = stub.server.recipe as string;
const enc = encodeURIComponent(REC);
const lib = (id: string) => `eidoverse/assets/models/${id}.glb`;
const GEOM = { bbox: { size: [1, 1, 1], center: [0, 0.5, 0] } };   // diag 1.73 → R ≈ 86.9m, auto edge ≈ 39m, halved ≈ 19.5m
// the world: a scratch authority; the realizer is fed the views a client's own fold reaches after each write
const W = scratchWorld('lodclient');
const door = (tool: string, args: any) => { const r = W.call(tool, args); if (!r.ok) throw new Error(`${tool} ${JSON.stringify(args)} refused: ${JSON.stringify(r.refused)}`); S.applyView(structuredClone(W.view())); return r; };
/** Place an entity on the z axis, `z` metres from the camera at the origin.
 *  Each id has its own lib, so loads and variants attribute per placement. */
const spawnAt = (id: string, z: number, variant = true) => {
  if (variant) stub.server.variants.add(lib(id));
  bus.emit('lib-geom', { [lib(id)]: GEOM });   // the geom side-channel, landed
  door('create', { id, model: lib(id), components: { transform: { pos: [0, 0, z] } } });
};
const obj = (id: string) => stub.entities.get(id);
const loadsOf = (id: string) => stub.loads.filter((l: any) => l.model === lib(id));
const drain = () => { for (let i = 0; i < 50 && M.promoteTailPending() > 0; i++) M.drainPromoteTail(); };
const res = () => M.residencyDebug();
/** three's object 'dispose' count per mesh of `o` (the stub loader counts it; render/discard.js dispatches it), the
 *  frame's mesh component left out: a dropped object reads all 1s, a worn one all 0s */
const disposals = (o: any) => { const n: number[] = []; o?.traverse((m: any) => { if (m.isMesh && !m.userData.meshPart) n.push(m.userData.disposed ?? 0); }); return n; };
const discarded = (o: any) => { const n = disposals(o); return n.length > 0 && n.every((k) => k === 1); };
const untouched = (o: any) => { const n = disposals(o); return n.length > 0 && n.every((k) => k === 0); };
/** the last clone the loader handed out for `id`'s lib */
const lastClone = (id: string) => [...stub.clones].reverse().find((c: any) => String(c.userData.glbKey).startsWith(lib(id)));

M.initModelsRealizer();          // geom side-channel + fold wiring (+ a 2Hz beat we ignore: we beat by hand)
S.hydrate(emptyView());
stub.camera.position.set(0, 0, 0);

// ---- 1. the join: tiers chosen before the fetch, from distance against the entity's own radius
{
  spawnAt('near', 5);
  spawnAt('far', 70);
  spawnAt('light', 70, false);   // far, but the sequencer has no variant — its "already light" refusal answers the original
  await settle();
  check('three placements realized', res().real === 3, JSON.stringify(res()));
  check('near (5m) asked FULL — a plain ktx2 fetch', loadsOf('near')[0]?.tier === 'full' && loadsOf('near')[0]?.url === `${lib('near')}?ktx2=4`, loadsOf('near')[0]?.url);
  check('far (70m) asked LOD — the recipe rides the ktx2 negotiation on the wire', loadsOf('far')[0]?.tier === 'lod' && loadsOf('far')[0]?.url === `${lib('far')}?ktx2=4&lod=${enc}`, loadsOf('far')[0]?.url);
  check('far wears the served lod: asked lod, served lod', obj('far')?.userData.tierAsked === 'lod' && obj('far')?.userData.tier === 'lod');
  check('light asked lod, was answered the original, wears FULL honestly', obj('light')?.userData.tierAsked === 'lod' && obj('light')?.userData.tier === 'full');
  check('EW.residency(): lod 1 (served) / lodAsked 2 (asked) — the gap is the sequencer\'s honest fall-through', res().lod === 1 && res().lodAsked === 2, JSON.stringify(res()));
  drain();
  check('the promote tail fits colliders for the full tiers only — the reduced mesh owns NO collider',
    stub.colliders.has('near') && stub.colliders.has('light') && !stub.colliders.has('far'), JSON.stringify(stub.colliderLog));
  // the churn control (the first field run: 21 re-tiers in 100s)
  const nLoads = stub.loads.length;
  for (let i = 0; i < 4; i++) { M.residencySweep(); await settle(); }
  check('four beats later nothing re-asked: an "already light" answer is NOT re-fetched every cooldown (hysteresis keys on the ASK)',
    stub.loads.length === nLoads && res().retiers === 0, `loads ${nLoads}→${stub.loads.length}, retiers ${res().retiers}`);
}

// ---- 2. the dial: persisted locally, never a verb; a flip re-tiers in place
{
  const worldBefore = JSON.stringify(S.state.st);
  const farBefore = obj('far');
  M.modelQuality.setQuality('full');
  check('the dial persists in THIS browser (localStorage) and reads back on the next boot',
    store.get('ew-model-quality') === 'full' && makeModelQuality(globalThis.localStorage).quality === 'full');
  M.residencySweep(); await settle();
  const last = loadsOf('far').at(-1);
  check('"full detail" re-tiers far in place: a FULL load, the old lod proto released, the new object worn',
    last?.tier === 'full' && obj('far') !== farBefore && obj('far')?.userData.tierAsked === 'full'
    && stub.released.includes(`${lib('far')}#lod`), JSON.stringify({ last, retiers: res().retiers }));
  // light wore the original already, but its ASK was lod — under "full detail" the ask must be full,
  // so it re-asks once (a plain ktx2 fetch), and that is also how a provisional answer picks up a
  // later bake: the ask flips, the wire asks again. Two re-tiers: far and light.
  check('light (asked lod, wearing the original) re-asks FULL once — the ask is what the dial commands, and that is the path a later bake rides',
    res().retiers === 2 && loadsOf('light').at(-1)?.tier === 'full' && obj('light')?.userData.tierAsked === 'full', JSON.stringify(res()));
  drain();
  check('…and the full tier earns its collider on landing', stub.colliders.has('far'), JSON.stringify(stub.colliderLog.slice(-3)));
  check('the world fold is byte-identical: the dial and the swap wrote NOTHING shared', JSON.stringify(S.state.st) === worldBefore);

  spawnAt('mid', 25);   // under "full": a full load, 25m inside the auto edge anyway
  await settle();
  check('mid (25m) joined full', obj('mid')?.userData.tierAsked === 'full');
  M.modelQuality.setQuality('eco');
  M.residencySweep(); await settle();
  check('"eco" halves the edge: mid (25m > 19.5m) re-tiers to LOD; near (5m) stays full — no dial reduces what you stand beside',
    obj('mid')?.userData.tierAsked === 'lod' && obj('mid')?.userData.tier === 'lod' && loadsOf('near').length === 1,
    JSON.stringify({ mid: obj('mid')?.userData.tierAsked, nearLoads: loadsOf('near').length }));
  M.modelQuality.setQuality('auto');
}

// ---- 3. a browser that cannot ask: the wire decides, and reports honestly (review point 2)
{
  const askedBefore = res().lodAsked;
  stub.server.capable = false;             // no KTX2 transcoder in this browser
  spawnAt('nolod', 70);
  await settle();
  const l = loadsOf('nolod')[0];
  check('no transcoder: far placement loads FULL with NO lod= (and no ktx2=) on the wire', l?.tier === 'full' && l?.url === lib('nolod'), l?.url);
  check('…and is reported as never asked: tierAsked full, lodAsked unchanged', obj('nolod')?.userData.tierAsked === 'full' && res().lodAsked === askedBefore);
  M.modelQuality.setQuality('eco');
  for (let i = 0; i < 2; i++) { M.residencySweep(); await settle(); }
  check('even on "eco" it never re-asks: the policy sees no recipe where none can cross the wire', loadsOf('nolod').length === 1);
  M.modelQuality.setQuality('auto');
  stub.server.capable = true;
  stub.server.recipe = null;               // a sequencer that published no recipe
  spawnAt('norecipe', 70);
  await settle();
  const n = loadsOf('norecipe')[0];
  check('no recipe published: ktx2 negotiates, lod does not — a plain ktx2 fetch, asked full', n?.tier === 'full' && n?.url === `${lib('norecipe')}?ktx2=4`, n?.url);
  stub.server.recipe = REC;
}

// ---- 4. a tier swap is re-authorized at APPLICATION, not only when scheduled (review point 3)
console.log('\n  held swaps — a dependency arrives while the bytes fly\n');
/** Join reduced at 70m, walk it to 10m (a `place`), catch the FULL load in
 *  flight, let `dep` land, then release the load. Returns what stood before. */
async function heldSwap(id: string, dep: null | ((id: string) => void)) {
  spawnAt(id, 70); await settle();
  const before = obj(id);
  check(`${id}: joined reduced (asked lod, served lod)`, before?.userData.tierAsked === 'lod' && before?.userData.tier === 'lod');
  const mark = stub.colliderLog.length;
  const refusedBefore = res().retiersRefused, retiersBefore = res().retiers;
  stub.setHold(true);
  door('set', { id, component: 'transform', value: { pos: [0, 0, 10] }, merge: true });   // walked toward: 10m < the inner edge (29m) → the sweep wants full
  M.residencySweep(); await settle();
  const h = stub.held.find((x: any) => x.model === lib(id));
  // per-placement: other placements may legitimately re-tier in the same beat (a browser that
  // regained KTX2 re-asks its far ones), so count THIS lib's loads, not the global counter
  check(`${id}: the FULL load is in flight, held`, !!h && h.tier === 'full' && loadsOf(id).length === 2 && res().retiers > retiersBefore,
    JSON.stringify({ held: !!h, loads: loadsOf(id).length }));
  dep?.(id);                                 // …and now the world moves
  await settle();
  for (const x of stub.held.splice(0)) x.release();
  stub.setHold(false);
  await settle();
  drain();
  return { before, mark, refusedBefore };
}
const sinceMark = (mark: number, id: string) => stub.colliderLog.slice(mark).filter((e: any) => e[1] === id).map((e: any) => e[0]);

{ // the control: nothing intervenes → the swap lands
  const { before, mark } = await heldSwap('ctl', null);
  check('control: with nothing riding, the held swap LANDS — new object, asked full, old lod proto released, collider fitted',
    obj('ctl') !== before && obj('ctl')?.userData.tierAsked === 'full' && stub.released.includes(`${lib('ctl')}#lod`)
    && sinceMark(mark, 'ctl').includes('fit'), JSON.stringify(sinceMark(mark, 'ctl')));
}
const deps: [string, (id: string) => void][] = [
  ['a body sits on it (avatarMounts)', (id) => stub.avatarMounts.set(`occupant-of-${id}`, { to: id })],
  ['cargo is parented to it (parent.to)', (id) => { spawnAt(`cargo-${id}`, 10); door('set', { id: `cargo-${id}`, component: 'parent', value: { to: id } }); }],
  ['a part motion arrives (motion:<slot> {node})', (id) => door('set', { id, component: 'motion:door', value: { node: 'Door', type: 'pendulum', axis: [0, 1, 0], amp: 0.3, period: 2 } })],
  ['an edit hold begins (editHolds)', (id) => stub.editHolds.add(id)],
];
let k = 0;
for (const [what, dep] of deps) {
  const id = `held${k++}`;
  const { before, mark, refusedBefore } = await heldSwap(id, dep);
  const same = obj(id) === before;
  check(`${what}: the loaded clone is NOT worn — the standing object stays, asked lod, collider untouched, refusal counted`,
    same && obj(id)?.userData.tierAsked === 'lod' && sinceMark(mark, id).length === 0 && res().retiersRefused === refusedBefore + 1,
    JSON.stringify({ same, asked: obj(id)?.userData.tierAsked, colliderOps: sinceMark(mark, id), refused: res().retiersRefused - refusedBefore }));
  check(`${what}: the refused clone is discarded (its meshes got three's object dispose) and the standing object is not`,
    lastClone(id) !== before && discarded(lastClone(id)) && untouched(before), JSON.stringify({ clone: disposals(lastClone(id)), standing: disposals(before) }));
}
check('no realizer error was reported through the whole realizer half', stub.reports.length === 0,
  stub.reports.map((r: any) => `${r.where}: ${r.e?.message ?? r.e}`).join(' | '));

// ---- 4b. a re-tier that brings the tier already worn is no swap (render lab 11-26: a still room churned its caster
// budget for ~12 s after the capture camera moved 40 m into it; 14 props had asked lod, been answered the original,
// and each was torn down and rebuilt as the same original when the ask flipped back to full: collider, caster
// (re-registered unwarmed: its shadow dropped and faded back) and lamps all re-made for identical geometry)
console.log('\n  same-tier re-asks — the ask moves, the worn object stays\n');
{
  const { tracked } = await import('../../client/lib/realize/lifecycle.js');
  const id = 'same';
  spawnAt(id, 70, false);   // far, no variant: asked lod, answered the original
  await settle(); drain();
  const before = obj(id);
  check('same: joined asked lod, wearing the original (tier full)', before?.userData.tierAsked === 'lod' && before?.userData.tier === 'full');
  const mark = stub.colliderLog.length, lampMark = stub.lampLog.length, loads0 = loadsOf(id).length, caster0 = stub.casters.get(id);
  const lampOps = () => stub.lampLog.slice(lampMark).filter((e: any) => e[1] === `entity:${id}`);
  const kept0 = res().retiersKept;
  // the move itself refits the collider in place (a `place`); a swap is a remove + fit
  const swapOps = () => sinceMark(mark, id).filter((op: string) => op !== 'refit');
  door('set', { id, component: 'transform', value: { pos: [0, 0, 10] }, merge: true });   // walked toward: the sweep wants full
  M.residencySweep(); await settle(); drain();
  check('walked in: the ask goes to full (one fetch) and the standing object is KEPT: same object, caster never released, collider and lamps untouched',
    loadsOf(id).length === loads0 + 1 && obj(id) === before && obj(id)?.userData.tierAsked === 'full' && stub.casters.get(id) === caster0
      && swapOps().length === 0 && lampOps().length === 0 && res().retiersKept === kept0 + 1,
    JSON.stringify({ loads: loadsOf(id).length - loads0, same: obj(id) === before, asked: obj(id)?.userData.tierAsked, caster: stub.casters.get(id) === caster0, colliderOps: swapOps(), lampOps: lampOps(), kept: res().retiersKept - kept0 }));
  check('walked in: the clone it did not wear is discarded (three\'s object dispose on each mesh); the standing object is not',
    discarded(lastClone(id)) && lastClone(id) !== before && untouched(before), JSON.stringify({ clone: disposals(lastClone(id)), standing: disposals(before) }));
  // and back out: the lod ask goes out again and is answered the original again → kept. (This stub answers every ask
  // afresh. Live, a repeat lod ask is answered from the proto the loader already caches under lib#lod, so a bake that
  // landed since reaches a placement only after an eviction or a reload: a known follow-up, not this row's claim.)
  const t: any = tracked.get(id); if (t) t.retierAt = 0;   // past the 5 s cooldown
  door('set', { id, component: 'transform', value: { pos: [0, 0, 70] }, merge: true });
  M.residencySweep(); await settle(); drain();
  check('walked out: the lod ask goes out again, is answered the original again, and the standing object is KEPT',
    loadsOf(id).length === loads0 + 2 && loadsOf(id).at(-1)?.tier === 'lod' && obj(id) === before && obj(id)?.userData.tierAsked === 'lod'
      && stub.casters.get(id) === caster0 && swapOps().length === 0 && lampOps().length === 0 && res().retiersKept === kept0 + 2,
    JSON.stringify({ loads: loadsOf(id).length - loads0, same: obj(id) === before, asked: obj(id)?.userData.tierAsked, colliderOps: swapOps(), kept: res().retiersKept - kept0 }));
  // the control: a bake landed meanwhile and (in this stub) the next lod ask is answered a DIFFERENT tier: a swap
  stub.server.variants.add(lib(id));
  if (t) t.retierAt = 0;
  door('set', { id, component: 'transform', value: { pos: [0, 0, 10] }, merge: true }); M.residencySweep(); await settle(); drain();
  if (t) t.retierAt = 0;
  door('set', { id, component: 'transform', value: { pos: [0, 0, 70] }, merge: true }); M.residencySweep(); await settle(); drain();
  check('control: once the sequencer has baked it, the lod answer IS a different tier and the swap lands (new object, tier lod)',
    obj(id) !== before && obj(id)?.userData.tier === 'lod' && obj(id)?.userData.tierAsked === 'lod', JSON.stringify(obj(id)?.userData));
  check('…and the swap discards the object it replaced (each mesh once), not the one that replaced it',
    discarded(before) && untouched(obj(id)), JSON.stringify({ replaced: disposals(before), now: disposals(obj(id)) }));
}

// ---- 4c. same-tier keeps against the realizer's other paths (rows from the 11-26 cold review): a shared library
// model, the ask flipping back mid-flight, a bake mid-flight, an edit hold, a delete mid-flight, a pending heavy tail,
// the dial; and the drop sites that discard what they let go of (render/discard.js)
console.log('\n  same-tier keeps — shared libs, in-flight interleavings, the pending tail, the drop sites\n');
{
  const { tracked } = await import('../../client/lib/realize/lifecycle.js');
  const cool = (id: string) => { const t: any = tracked.get(id); if (t) t.retierAt = 0; };
  const place = (id: string, z: number) => door('set', { id, component: 'transform', value: { pos: [0, 0, z] }, merge: true });
  const beat = async () => { M.residencySweep(); await settle(); };
  const ud = (id: string) => obj(id)?.userData;
  const net = (k: string) => stub.retained.get(k) ?? 0;

  // R1: one library model, two placements; only one crosses the band edge
  const SH = 'eidoverse/assets/models/shared.glb';
  bus.emit('lib-geom', { [SH]: GEOM });
  door('create', { id: 'sh-a', model: SH, components: { transform: { pos: [0, 0, 70] } } });
  door('create', { id: 'sh-b', model: SH, components: { transform: { pos: [0, 0, 5] } } });
  await settle(); drain();
  const A0 = obj('sh-a'), B0 = obj('sh-b');
  check('R1a shared: A (70m) asked lod wears full under key #lod; B (5m) asked full under the bare key',
    ud('sh-a')?.tierAsked === 'lod' && ud('sh-a')?.tier === 'full' && ud('sh-a')?.glbKey === `${SH}#lod` && ud('sh-b')?.tierAsked === 'full' && ud('sh-b')?.glbKey === SH, JSON.stringify([ud('sh-a'), ud('sh-b')]));
  const kept0 = res().retiersKept;
  place('sh-a', 10); await beat(); drain();
  check('R1b shared: A walks in → A kept, ask full; B untouched; retiersKept +1',
    obj('sh-a') === A0 && ud('sh-a')?.tierAsked === 'full' && obj('sh-b') === B0 && res().retiersKept === kept0 + 1, JSON.stringify({ a: obj('sh-a') === A0, b: obj('sh-b') === B0, kept: res().retiersKept - kept0 }));
  // (the two protos of one model this leaves, sh-a on #lod and sh-b on the bare key, are a known follow-up)
  check('R1d shared: A (tier full, asked full) and B both own colliders', stub.colliders.has('sh-a') && stub.colliders.has('sh-b'));
  stub.server.variants.add(SH); cool('sh-a'); place('sh-a', 70); await beat(); drain();
  check('R1e shared: baked, A walks out → A swaps to lod (no collider), B is the same object, asked full, collider kept',
    obj('sh-a') !== A0 && ud('sh-a')?.tier === 'lod' && !stub.colliders.has('sh-a') && obj('sh-b') === B0 && ud('sh-b')?.tierAsked === 'full' && stub.colliders.has('sh-b'), JSON.stringify([ud('sh-a'), ud('sh-b')]));
  cool('sh-a'); place('sh-a', 10); await beat(); drain();
  check('R1f shared: A walks back in → swaps to full with a collider; B still the same object; refs balance (#lod 0, bare 2)',
    ud('sh-a')?.tier === 'full' && stub.colliders.has('sh-a') && obj('sh-b') === B0 && net(`${SH}#lod`) === 0 && net(SH) === 2, JSON.stringify({ a: ud('sh-a'), lodRefs: net(`${SH}#lod`), fullRefs: net(SH) }));

  // R2: the ask flips back while the answer is in flight (no variant)
  spawnAt('ff', 70, false); await settle(); drain();
  const F0 = obj('ff'); let n0 = loadsOf('ff').length;
  stub.setHold(true); place('ff', 10); await beat();
  place('ff', 70);   // walked back out mid-flight
  for (let i = 0; i < 3; i++) await beat();
  check('R2a in flight: no second ask stacks while one is out', loadsOf('ff').length === n0 + 1 && stub.held.length === 1, `loads +${loadsOf('ff').length - n0}, held ${stub.held.length}`);
  for (const x of stub.held.splice(0)) x.release(); stub.setHold(false); await settle(); drain();
  check('R2b the stale full answer is kept (asked full) — and the next beat past the cooldown asks lod again: nothing lost',
    obj('ff') === F0 && ud('ff')?.tierAsked === 'full', JSON.stringify(ud('ff')));
  cool('ff'); await beat(); drain();
  check('R2c …lod asked again, kept, asked lod', loadsOf('ff').length === n0 + 2 && loadsOf('ff').at(-1)?.tier === 'lod' && obj('ff') === F0 && ud('ff')?.tierAsked === 'lod', JSON.stringify({ loads: loadsOf('ff').length - n0, ud: ud('ff') }));

  // R3: a bake lands while the lod ask is in flight
  cool('ff'); place('ff', 10); await beat(); drain();   // asked full again, kept
  stub.setHold(true); cool('ff'); place('ff', 70); await beat();
  stub.server.variants.add(lib('ff'));
  for (const x of stub.held.splice(0)) x.release(); stub.setHold(false); await settle(); drain();
  check('R3 bake during flight (this stub reads its answer at release; live the cached #lod proto answers): swap lands once, tier lod, collider gone, one #lod ref',
    obj('ff') !== F0 && ud('ff')?.tier === 'lod' && !stub.colliders.has('ff') && net(`${lib('ff')}#lod`) === 1, JSON.stringify({ ud: ud('ff'), refs: net(`${lib('ff')}#lod`) }));

  // R4: an edit hold begins while a SAME-tier answer is in flight
  spawnAt('eh', 70, false); await settle(); drain();
  const E0 = obj('eh'); const ref0 = res().retiersRefused, k0 = res().retiersKept;
  stub.setHold(true); place('eh', 10); await beat();
  stub.editHolds.add('eh');
  for (const x of stub.held.splice(0)) x.release(); stub.setHold(false); await settle(); drain();
  check('R4a edit hold during a same-tier flight: refused (counted), not "kept"; object and ask unchanged',
    obj('eh') === E0 && ud('eh')?.tierAsked === 'lod' && res().retiersRefused === ref0 + 1 && res().retiersKept === k0, JSON.stringify({ ud: ud('eh'), refused: res().retiersRefused - ref0, kept: res().retiersKept - k0 }));
  check('R4a\' …and the refused clone is discarded, the standing object is not', discarded(lastClone('eh')) && untouched(E0), JSON.stringify({ clone: disposals(lastClone('eh')), standing: disposals(E0) }));
  stub.editHolds.delete('eh'); cool('eh'); await beat(); drain();
  check('R4b hold over: the full ask goes again and is kept', obj('eh') === E0 && ud('eh')?.tierAsked === 'full' && res().retiersKept === k0 + 1, JSON.stringify(ud('eh')));

  // R5: deleted while a same-tier answer is in flight (an id is never reused, so there is no re-create case)
  spawnAt('rc', 70, false); await settle(); drain();
  stub.setHold(true); place('rc', 10); await beat();
  door('delete', { id: 'rc' });
  await settle();
  for (const x of stub.held.splice(0)) x.release(); stub.setHold(false); await settle(); drain();
  const keys = [lib('rc'), `${lib('rc')}#lod`];
  check('R5\' delete in flight: the late clone is discarded (no one wears it)', discarded(lastClone('rc')), JSON.stringify(disposals(lastClone('rc'))));
  check('R5 delete in flight: nothing stands, no collider, refs net 0, no report',
    !stub.entities.has('rc') && !stub.colliders.has('rc') && keys.reduce((n, k2) => n + net(k2), 0) === 0 && stub.reports.length === 0,
    JSON.stringify({ has: stub.entities.has('rc'), refs: keys.map(net), reports: stub.reports.map((r: any) => String(r.e?.message ?? r.e)) }));

  // R6: the heavy tail is still pending when the same-tier answer arrives
  spawnAt('pt', 70, false); await settle();   // NOT drained: collider and caster not yet landed
  const P0 = obj('pt'); const pend = M.promoteTailPending();
  place('pt', 10); await beat();
  check('R6a pending tail: kept while its tail is still queued', obj('pt') === P0 && ud('pt')?.tierAsked === 'full' && pend > 0 && M.promoteTailPending() > 0, JSON.stringify({ pend, now: M.promoteTailPending(), ud: ud('pt') }));
  drain();
  check('R6b …and the tail still lands on it: collider fitted, caster registered for THIS object', stub.colliders.get('pt')?.obj === P0 && stub.casters.get('pt') === P0);

  // R7: the dial path with a kept object: "full detail" then "auto" at distance
  spawnAt('dl', 70, false); await settle(); drain();
  const D0 = obj('dl'); const dn = loadsOf('dl').length;
  M.modelQuality.setQuality('full'); for (const id of ['dl']) cool(id); await beat(); drain();
  M.modelQuality.setQuality('auto'); cool('dl'); await beat(); drain();
  for (let i = 0; i < 3; i++) await beat();
  check('R7 dial full → auto at 70m: two asks (full, lod), same object throughout, collider kept, then quiet',
    obj('dl') === D0 && loadsOf('dl').length === dn + 2 && ud('dl')?.tierAsked === 'lod' && stub.colliders.get('dl')?.obj === D0, JSON.stringify({ loads: loadsOf('dl').length - dn, ud: ud('dl') }));
  // the other drop sites: a demote and a retire discard the object they take out of the scene; a swap leaves the
  // frame's mesh component (re-homed onto the new object) alone
  spawnAt('dm', 5); await settle(); drain();
  const DM0 = obj('dm');
  place('dm', 400); await beat();   // past the residency radius + its band: a stand-in replaces it
  check('R8a demote: the stand-in replaces it and the object it replaced is discarded', obj('dm') !== DM0 && obj('dm')?.userData.placeholder === true && discarded(DM0), JSON.stringify(disposals(DM0)));
  spawnAt('rt', 5); await settle(); drain();
  const RT0 = obj('rt');
  door('delete', { id: 'rt' }); await settle();
  check('R8b retire: the object that left the world is discarded', !stub.entities.has('rt') && discarded(RT0), JSON.stringify(disposals(RT0)));
  stub.server.variants.add(lib('mp'));
  bus.emit('lib-geom', { [lib('mp')]: GEOM });
  door('create', { id: 'mp', model: lib('mp'), components: { transform: { pos: [0, 0, 70] }, mesh: { shape: 'box', size: [1, 1, 1] } } });
  await settle(); drain();
  const MP0 = obj('mp'); const part = (() => { let p: any = null; MP0?.traverse((n: any) => { if (n.userData.meshPart) p = n; }); return p; })();
  part?.addEventListener('dispose', () => { part.userData.disposed = (part.userData.disposed ?? 0) + 1; });
  place('mp', 10); await beat(); drain();   // asked full, served full: a different tier from the lod it wore, a swap
  check('R8c swap with a mesh component: the old model object is discarded, the mesh component is not and rides the new one',
    !!part && obj('mp') !== MP0 && discarded(MP0) && !(part.userData.disposed > 0) && part.parent === obj('mp'),
    JSON.stringify({ part: !!part, swapped: obj('mp') !== MP0, old: disposals(MP0), partDisposed: part?.userData.disposed ?? 0, onNew: part?.parent === obj('mp') }));
  check('4c: no realizer error reported', stub.reports.length === 0, stub.reports.map((r: any) => `${r.where}: ${r.e?.message ?? r.e}`).join(' | '));
}

// ---- 5. the other entry points (round three): the REAL governor's lever crosses into the sweep; the dial's callback is gated
console.log('\n  entry points — the governor lever and the dial callback\n');
{
  const G: any = await import('../../client/lib/render/governor.js');   // real, over the same stub cone: every lever below "lod" answers "nothing to shed"
  M.modelQuality.setQuality('auto');
  spawnAt('gov', 25); await settle();                          // inside the auto edge (39m) — full
  drain();
  check('gov (25m) joined full under "auto"', obj('gov')?.userData.tierAsked === 'full');
  const toastsBefore = stub.toasts.length;
  const hist = () => G.governorDebug().history as string[];
  let windows = 0;
  while (!hist().some((h) => h.startsWith('− lod')) && windows++ < 4) for (let i = 0; i < 4; i++) G.governPerformance(12);
  check('slow seconds with nothing else to shed: the ladder reaches "lod" — the session dial sheds, and a status chip says so (no toast)',
    M.modelQuality.shed === true && hist().some((h) => h.startsWith('− lod')) && stub.chips.has('quality-reduced')
      && stub.chips.get('quality-reduced').level === 'attn' && stub.toasts.length === toastsBefore,
    JSON.stringify({ shed: M.modelQuality.shed, hist: hist().slice(-3), chips: [...stub.chips.keys()], toasts: stub.toasts.slice(-1) }));
  M.residencySweep(); await settle(); drain();   // drained: the governor's grace holds while a promote tail is pending
  check('…and it CROSSES into the realizer: gov (25m > the halved 19.5m edge) re-tiers to lod on the next beat',
    obj('gov')?.userData.tierAsked === 'lod' && obj('gov')?.userData.tier === 'lod', JSON.stringify(obj('gov')?.userData));
  windows = 0;
  while (M.modelQuality.shed && windows++ < 4) for (let i = 0; i < 6; i++) G.governPerformance(60);
  check('smooth seconds: "lod" restores SILENTLY — the dial is off, no toast, and the chip goes with it',
    !M.modelQuality.shed && hist().some((h) => h.startsWith('+ lod')) && stub.toasts.length === toastsBefore && !stub.chips.has('quality-reduced'),
    JSON.stringify({ shed: M.modelQuality.shed, hist: hist().slice(-3), chips: [...stub.chips.keys()] }));
  M.modelQuality.setQuality('full');
  drain();
  const histLen = hist().length;
  for (let i = 0; i < 4; i++) G.governPerformance(12);
  check('the resident\'s "full detail" is never overridden: under load the lever declines and the ladder passes it by',
    M.modelQuality.shed === false && !hist().slice(histLen).some((h) => h.startsWith('− lod')), JSON.stringify(hist().slice(histLen)));
  M.modelQuality.setQuality('auto');

  // the dial's callback — skypanel.js binds it to the models⚙ row and shows what it returns
  const hintEco = M.dialModelQuality('eco');
  check('the row\'s callback sets and persists the dial and says it is yours only',
    M.modelQuality.quality === 'eco' && store.get('ew-model-quality') === 'eco' && hintEco === 'models: eco (yours only)', hintEco);
  stub.server.recipe = null;
  const hintNone = M.dialModelQuality('auto');
  check('…and where no reduced tier can be asked from this browser, the hint says so', /cannot be asked/.test(hintNone) && M.modelQuality.quality === 'auto', hintNone);
  stub.server.recipe = REC;
  const hintUnknown = M.dialModelQuality('ultra');
  check('an unknown level is refused; the dial stands', M.modelQuality.quality === 'auto' && hintUnknown.startsWith('models: auto'), hintUnknown);
}

// ============================================================================
console.log('\nlod-client — the wire half (an OWNED sequencer answers the loader\'s exact URLs)\n');

const ROOT = resolve(import.meta.dir, '..', '..');
const OPT = mkdtempSync(join(tmpdir(), 'ew-lodc-opt-'));   // the child's OPT_DIR: its boot sweep bakes here, never into the checkout
const NOWHERE = mkdtempSync(join(tmpdir(), 'ew-lodc-nowhere-'));   // no encoder anywhere: an untextured fixture reduces without one
const LIB = mkdtempSync(join(tmpdir(), 'ew-lodc-lib-'));
mkdirSync(join(LIB, 'eidoverse', 'assets', 'models'), { recursive: true });
const HEAVY = 'eidoverse/assets/models/lod_client_heavy.glb';        // 161² verts → reduced
const AUTHORED = 'eidoverse/assets/models/lod_client_authored.glb';  // 81 verts, with an AUTHORED `recipe` extra equal to the running one
const mine = [HEAVY, AUTHORED].flatMap((r) => [`${r}.lod.${LOD_RECIPE}.glb`, `${r}.lod.${LOD_RECIPE}.glb.failed`, `${r}.ktx2.glb`, `${r}.ktx2.glb.failed`]);
let child: ChildProcess | null = null;
const cleanup = () => {
  try { child?.kill(); } catch { /* gone */ }
  for (const rel of mine) try { rmSync(join(OPT, rel), { force: true }); } catch { /* best effort */ }
  for (const d of [LIB, NOWHERE, OPT]) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { cleanup(); process.exit(1); });
// a run killed mid-way may have left last time's variants in OPT_DIR: a STALE
// variant (older than the fixture written below) is exactly what the server
// refuses to serve (#156 freshness), so clear before writing, and wait for a
// variant NEWER than its source, never for a file that merely exists
for (const rel of mine) try { rmSync(join(OPT, rel), { force: true }); } catch { /* best effort */ }

async function gridGlb(tag: string, cells: number, extras: object | null): Promise<Uint8Array> {
  const { Document, NodeIO } = await import('@gltf-transform/core');
  const doc = new Document();
  if (extras) doc.getRoot().getAsset().extras = extras;
  const buf = doc.createBuffer();
  const n = cells + 1;
  const pos = new Float32Array(n * n * 3);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    pos[i * 3] = x / cells; pos[i * 3 + 1] = Math.sin(x * 0.37) * Math.cos(y * 0.29) * 0.02; pos[i * 3 + 2] = y / cells;
  }
  const idx = new Uint32Array(cells * cells * 6);
  let q = 0;
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    const a = y * n + x, b = a + 1, c = a + n, d = c + 1;
    idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
  }
  const prim = doc.createPrimitive().setMaterial(doc.createMaterial('m'))
    .setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buf).setArray(idx))
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(pos));
  doc.createScene('s').addChild(doc.createNode(`hero-${tag}`).setMesh(doc.createMesh('gridMesh').addPrimitive(prim)));
  return new NodeIO().writeBinary(doc);
}

/** Process-owned, as object-lod-test spawns it: the per-run nonce goes INTO
 *  the child and must come back on /version before anything counts as up. */
async function startServer() {
  const PORT = freePort(20000);
  const nonce = crypto.randomUUID();
  const env: Record<string, string | undefined> = { ...process.env, SKIP_OPT_SWEEP: undefined, OPT_DIR: OPT, PORT: String(PORT), JOIN_TOKEN: 'test-door',
    WORLD_INSTANCE_NONCE: nonce, WORLDS_DIR: mkdtempSync(join(tmpdir(), 'ew-lodc-w-')), EIDOVERSE_DIR: LIB,
    KTX2_TOKTX: join(NOWHERE, 'no-such'), PATH: NOWHERE, HOME: NOWHERE, USERPROFILE: NOWHERE };
  const proc = spawnProc(process.execPath, [join(ROOT, 'server', 'server.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child = proc;
  let log = '';
  proc.stdout!.on('data', (d) => { log += d; });
  proc.stderr!.on('data', (d) => { log += d; });
  let version: any = null;
  // an answer that isn't ours ends the wait too: refuse, never test into someone else's world
  await tryUntil('the child answers /version', async () => proc.exitCode != null
    || (version = await fetch(`http://127.0.0.1:${PORT}/version`).then((r) => r.json()).catch(() => null)) != null, { ms: 30_000, step: 250 });
  const up = !!version && typeof version === 'object' && version.instance === nonce;
  if (!up) console.log(`      child did not come up OWNED — log tail:\n      ${log.split('\n').slice(-6).join('\n      ')}`);
  const base = `http://127.0.0.1:${PORT}`;
  return { up, base, key: keyFromVersion(version), lod: lodFromVersion(version), log: () => log,
    stop: async () => { try { proc.kill(); } catch { /* gone */ } child = null; await tryUntil('the child exits', () => proc.exitCode != null || proc.signalCode != null, { ms: 5000 }); } };
}

writeFileSync(join(LIB, HEAVY), await gridGlb('heavy', 160, null));
writeFileSync(join(LIB, AUTHORED), await gridGlb('authored', 8, { recipe: LOD_RECIPE, note: 'an author wrote this' }));
const C = await startServer();
try {
  check('child sequencer came up OWNED over the fixture library', C.up);
  if (C.up) {
    const key = C.key as string, recipe = C.lod as string;
    check('it published a key and the recipe this client was built against', !!key && recipe === LOD_RECIPE, `${key} / ${recipe}`);
    const variant = join(OPT, `${HEAVY}.lod.${recipe}.glb`);
    const fresh = () => existsSync(variant) && statSync(variant).mtimeMs > statSync(join(LIB, HEAVY)).mtimeMs;
    const landed = !!(await tryUntil('the boot sweep bakes the heavy fixture', fresh, { ms: 60_000, step: 250 }));
    check('the boot sweep baked the heavy fixture\'s LOD (untextured: no encoder needed)', landed,
      C.log().split('\n').filter((l) => l.includes('lod')).slice(-3).join(' | '));
    const served = async (url: string) => {
      const r = await fetch(`${C.base}/library/${url}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const json = rig.glbJson(bytes);
      return { status: r.status, cc: r.headers.get('cache-control'), json, tier: tierOf(json, recipe), url };
    };
    const capable = askFor({ libPath: HEAVY, key, capable: true, recipe, tier: 'lod' });
    const a = await served(capable.url);
    check('a CAPABLE browser\'s lod ask → the stamped variant; the loader\'s tierOf reads it as lod',
      capable.tier === 'lod' && a.status === 200 && a.tier === 'lod' && typeof a.json.asset?.extras?.lodOf === 'string',
      JSON.stringify({ url: a.url, extras: a.json.asset?.extras }));
    const incapable = askFor({ libPath: HEAVY, key, capable: false, recipe, tier: 'lod' });
    const b = await served(incapable.url);
    check('an INCAPABLE browser sends neither lod= nor ktx2=: the original comes back, read as full',
      incapable.tier === 'full' && !incapable.url.includes('=') && b.status === 200 && b.tier === 'full' && !b.json.asset?.extras?.lodOf, incapable.url);
    const c = await served(withLod(negotiate(HEAVY, key), 'some-future-recipe'));
    check('a WRONG-GENERATION ask answers provisionally (no-cache) and the loader reads it as full',
      c.status === 200 && c.cc === 'no-cache' && c.tier === 'full', `cc=${c.cc}`);
    const authored = askFor({ libPath: AUTHORED, key, capable: true, recipe, tier: 'lod' });
    const refused = !!(await tryUntil('the sweep refuses the authored fixture', () => existsSync(join(OPT, `${AUTHORED}.lod.${recipe}.glb.failed`)), { ms: 30_000, step: 250 }));
    const d = await served(authored.url);
    check('an authored `recipe` extra EQUAL to the running recipe, through the lod door: the sweep refused it typed (already light), the original answers, the loader reads FULL',
      refused && d.status === 200 && d.json.asset?.extras?.recipe === recipe && !d.json.asset?.extras?.lodOf && d.tier === 'full',
      JSON.stringify({ refused, extras: d.json.asset?.extras, cc: d.cc }));

    // ---- the PRODUCTION loader (round three): real client/lib/assets.js, only a renderer and
    // the frame conductors injected below it, its /version and /library fetches going to the
    // owned child. A mutation at the decision seam (tier / url / glbKey / the stamps) fails here.
    console.log('\n  the production loader — real assets.js against the owned child\n');
    const probe = async (strip: string) => {
      const p = Bun.spawn([process.execPath, join(ROOT, 'test', 'client', 'lod-loader-child.ts')], {
        env: { ...process.env, LODC_BASE: C.base, LODC_STRIP: strip, LODC_HEAVY: HEAVY, LODC_AUTHORED: AUTHORED },
        stdout: 'pipe', stderr: 'pipe',
      });
      const killer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 90_000);   // a wedged probe is a failure, not a hang
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      const code = await p.exited;
      clearTimeout(killer);
      const line = out.split('\n').find((l) => l.startsWith('PROBE '));
      const r = line ? JSON.parse(line.slice(6)) : {};
      if (code !== 0) r.error = `exit ${code}`;   // a FAIL in the child (stubResolve's) is a fail here
      if (!line || r.error) r.error = (r.error ?? '') + (err + out).split('\n').filter(Boolean).slice(-8).join(' | ');
      return r;
    };
    const P = await probe('');
    check('the real loader came up against the child: its /version handshake read the real key and recipe, the transcoder is detected',
      !P.error && P.negotiable === true && P.capable === true, P.error ?? JSON.stringify(P));
    if (!P.error) {
      check('resolveLoadRequest(HEAVY, lod): the URL carries the child\'s key and recipe, the tier is lod, the cache key is <lib>#lod',
        P.resolve.url === `${HEAVY}?ktx2=${key}&lod=${encodeURIComponent(recipe)}` && P.resolve.tier === 'lod' && P.resolve.glbKey === `${HEAVY}#lod`,
        JSON.stringify(P.resolve));
      check('loadGLB(HEAVY, {tier: lod}) FETCHED that URL, keyed #lod, stamped asked lod, and read the REAL variant\'s stamp as served lod',
        P.fetched.includes(`/library/${P.resolve.url}`) && P.lod.glbKey === `${HEAVY}#lod` && P.lod.asked === 'lod' && P.lod.served === 'lod',
        JSON.stringify({ lod: P.lod, fetched: P.fetched }));
      check('loadGLB(HEAVY, {tier: full}) fetched the plain ktx2 URL, keyed on the lib, asked and served full',
        P.fetched.includes(`/library/${HEAVY}?ktx2=${key}`) && P.full.glbKey === HEAVY && P.full.asked === 'full' && P.full.served === 'full',
        JSON.stringify(P.full));
      check('loadGLB(AUTHORED, {tier: lod}) asked lod and, parsing the ORIGINAL the child fell through to, served full — the authored extra fooled the real loader no more than the pure one',
        P.authored.asked === 'lod' && P.authored.served === 'full' && P.authored.glbKey === `${AUTHORED}#lod`, JSON.stringify(P.authored));
    }
    const older = await probe('lodRecipe');
    check('an OLDER sequencer (no lodRecipe on /version): the real loader never asks — plain ktx2 URL, keyed on the lib, asked full, no lod= anywhere',
      !older.error && older.negotiable === false && older.lod?.asked === 'full' && older.lod?.glbKey === HEAVY
      && older.fetched?.includes(`/library/${HEAVY}?ktx2=${key}`) && !older.fetched?.some((u: string) => u.includes('lod=')),
      older.error ?? JSON.stringify(older));
    const keyless = await probe('ktx2Key');
    check('no key on /version: nothing negotiates — the bare path, asked full',
      !keyless.error && keyless.negotiable === false && keyless.lod?.asked === 'full' && keyless.fetched?.includes(`/library/${HEAVY}`)
      && !keyless.fetched?.some((u: string) => u.includes('=')), keyless.error ?? JSON.stringify(keyless));
  }
} finally { await C.stop(); }

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32m0 failed\x1b[0m');
process.exit(failures ? 1 : 0);
