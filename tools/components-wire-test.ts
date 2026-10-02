// components-wire-test — step 2 of docs/DESIGN-edit-mode-components.md §7:
// light as a component, empty entities, collider as a component — each with
// its alias, on every tier that gives it meaning.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/components-wire-test.ts
//
// Each tier is the REAL module; no server process, no browser:
//   1. the fold      shared/fold.js — a lib-less spawn is an Empty; comp.light /
//                    comp.collider fold blind; old shapes fold exactly as before
//   2. the door      server/verbs.ts runVerb on an in-process bench world
//   3. the browser   client/lib/realize/models.js over tools/lod-client-stub.mjs
//   4. text tier     the agent's look() line for each spelling
//   5. inspector     shared/editschema.js — reads either spelling, writes new on edit
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// the realizer's renderer/network cone, stubbed exactly as unknown-comp-test does
// (tools/lod-client-stub.mjs records light requests and collider fits)
const STUB = fileURLToPath(new URL('./unknown-comp-stub.mjs', import.meta.url));
const SPY = fileURLToPath(new URL('./unknown-comp-report-spy.mjs', import.meta.url));
plugin({
  name: 'components-wire-stub',
  setup(b) {
    for (const f of ['^\\.\\./(core|assets|colliders|lightrig|lights|world)\\.js$', '^\\./(core|world|colliders|remotes)\\.js$']) {
      b.onResolve({ filter: new RegExp(f) }, () => ({ path: STUB }));
    }
    // the realizer's report(), recorded; everyone else gets the real base.js (the real bus)
    b.onResolve({ filter: /^\.\.\/base\.js$/ }, (args) => (args.importer.endsWith('realize/models.js') ? { path: SPY } : undefined));
  },
});

// config.ts makes WORLDS_DIR at import: keep the bench out of the repo's worlds/
const SCRATCH = mkdtempSync(join(tmpdir(), 'ew-comp-wire-'));
process.env.WORLDS_DIR = join(SCRATCH, 'worlds');

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const jeq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const { emptyState, foldEntry, stateToEntries } = await import('../shared/fold.js');
const { canon } = await import('../shared/components.js');
const LAMP = 'eidoverse/assets/models/lamp.glb';
let ts = 1786320000000;
const E = (verb: string, args: any, actor = 'owner') => ({ seq: ts - 1786320000000, ts: ts++, actor, verb, args });

// ---- 1. the fold -------------------------------------------------------------
console.log('\n1. the fold (shared/fold.js)');
{
  const st: any = emptyState();
  foldEntry(st, E('spawn', { id: 'pivot', pos: [1, 2, 3], yaw: 0.5 }));
  const p = st.entities.pivot;
  check('spawn {id} with no lib folds to an Empty: a Transform, no lib, no kind',
    !!p && jeq(p.pos, [1, 2, 3]) && p.yaw === 0.5 && !('lib' in p) && !('kind' in p), JSON.stringify(p));
  foldEntry(st, E('spawn', { id: 'n', lib: null }));
  check('…and so does lib: null (absent and null are one thing)', !!st.entities.n && !('lib' in st.entities.n), JSON.stringify(st.entities.n));
  for (const bad of ['', 0, false]) {
    foldEntry(st, E('spawn', { id: `bad-${String(bad)}`, lib: bad }));
  }
  check('a PRESENT but empty lib ("", 0, false) still folds to nothing, as before', !st.entities['bad-'] && !st.entities['bad-0'] && !st.entities['bad-false']);
  foldEntry(st, E('spawn', { id: 'q', q: [0, 0, 0.7071068, 0.7071068], scale: 2, collide: 'box' }));
  check('an Empty carries q, scale and collide like any spawn', jeq(st.entities.q.q?.map((x: number) => +x.toFixed(4)), [0, 0, 0.7071, 0.7071]) && st.entities.q.scale === 2 && st.entities.q.collide === 'box', JSON.stringify(st.entities.q));
  const born = p.born;
  foldEntry(st, E('spawn', { id: 'pivot', pos: [9, 9, 9] }));
  check('re-spawning an Empty as an Empty keeps its creation generation (born)', st.entities.pivot.born === born, `${born} → ${st.entities.pivot.born}`);
  foldEntry(st, E('spawn', { id: 'pivot', lib: null, pos: [8, 8, 8] }));
  check('…also when one spawn says lib: null and the record has no lib at all', st.entities.pivot.born === born, `${born} → ${st.entities.pivot.born}`);
  foldEntry(st, E('spawn', { id: 'pivot', lib: LAMP }));
  check('…and spawning a model on its id is a new thing (new born), replacing wholesale', st.entities.pivot.lib === LAMP && st.entities.pivot.born !== born);
  foldEntry(st, E('spawn', { id: 'pivot' }));
  check('…as is spawning an Empty over a model', !('lib' in st.entities.pivot) && st.entities.pivot.born !== born);

  foldEntry(st, E('comp', { id: 'pivot', type: 'light', data: { color: 0xff0000, intensity: 30 } }));
  foldEntry(st, E('comp', { id: 'pivot', type: 'collider', data: { shape: 'box' } }));
  check('comp.light and comp.collider fold blind into the bag, like every comp',
    jeq(st.entities.pivot.comp, { light: { color: 0xff0000, intensity: 30 }, collider: { shape: 'box' } }), JSON.stringify(st.entities.pivot.comp));
  foldEntry(st, E('place', { id: 'pivot', pos: [4, 0, 4], yaw: 1 }));
  foldEntry(st, E('spawn', { id: 'lamp', lib: LAMP }));
  foldEntry(st, E('mount', { id: 'pivot', to: 'lamp', offset: [0, 1.8, 0] }));
  check('an Empty is placed and mounted like any entity', jeq(st.entities.pivot.pos, [4, 0, 4]) && st.entities.pivot.yaw === 1 && st.entities.pivot.parent?.to === 'lamp');

  const st2: any = emptyState();
  for (const e of stateToEntries(st, { now: 1 })) foldEntry(st2, JSON.parse(JSON.stringify(e)));
  const strip = (x: any) => { const { actor: _a, ts: _t, born: _b, ...r } = x; return r; };
  check('a snapshot roundtrip (stateToEntries → JSON → fold) keeps the Empty, its comps and its mount',
    canon(strip(st2.entities.pivot)) === canon(strip(st.entities.pivot)) && !('lib' in st2.entities.pivot), `${canon(st.entities.pivot)}\n      ${canon(st2.entities.pivot)}`);
  // the agent folds the synthetic entries in memory, without the JSON pass: lib: undefined
  const st3: any = emptyState();
  for (const e of stateToEntries(st, { now: 1, collide: false })) foldEntry(st3, e as any);
  check('…and without the JSON pass (the agent: lib undefined on the synthetic spawn)', !!st3.entities.pivot && !('lib' in st3.entities.pivot));
}

// ---- 2. the door -------------------------------------------------------------
console.log('\n2. the door (server/verbs.ts runVerb)');
const { runVerb } = await import('../server/verbs.ts');
const st: any = emptyState();
st.roles.owner = { role: 'owner' }; st.roles.vis = { role: 'visitor' };
let seq = -1;
const log: any[] = [];
const w: any = {
  name: 'comp-wire-bench', state: st, clients: new Set(), leases: new Map(),
  sim: { epoch: null, bodies: {} }, bhv: { sync() {}, onEntry() {} },
  append(actor: string, verb: string, args: any) { const e = { seq: ++seq, ts: 1786320000000 + seq, actor, verb, args }; foldEntry(st, e); log.push(e); return e; },
  commit(actor: string, verb: string, args: any) { return this.append(actor, verb, args); },
  broadcast() {}, debug() {}, fold() {},
};
const conn = (id: string) => { const msgs: any[] = []; const c: any = { id, spectator: false, world: w, lastPose: null, ws: { send(x: string) { msgs.push(JSON.parse(x)); } }, verbWin: 0, verbCount: 0, msgs }; w.clients.add(c); return c; };
const owner = conn('owner'), vis = conn('vis');
// the rate limiter is not under test here: each call opens a fresh window
const as = (c: any) => (v: string, args: any) => { c.verbWin = 0; c.verbCount = 0; const n = log.length; runVerb({ w, c, now: Date.now(), expel() {} } as any, v, args); return { appended: log.length > n ? log.at(-1) : null, error: c.msgs.filter((m: any) => m.type === 'error').at(-1)?.error }; };
const O = as(owner), V = as(vis);
const clearErr = () => { owner.msgs.length = 0; vis.msgs.length = 0; };

let r = O('spawn', { id: 'empty1', pos: [1, 0, 1] });
check('a builder\'s spawn {id} with no lib is accepted, appended as sent, and folds to an Empty',
  !!r.appended && r.appended.args.lib === undefined && !!st.entities.empty1 && !('lib' in st.entities.empty1), JSON.stringify(r));
check('…with the placer principal stamped by the server like any spawn', st.entities.empty1?.placer?.id === 'owner', JSON.stringify(st.entities.empty1));
clearErr(); r = V('spawn', { id: 'empty2' });
check('a visitor\'s lib-less spawn is refused by rank, like any spawn', !r.appended && /builder/.test(r.error ?? ''), JSON.stringify(r));
O('comp', { id: 'empty1', type: 'lock', data: true });
clearErr(); r = O('spawn', { id: 'empty1' });
check('a lib-less spawn onto a locked id is refused (it would replace it)', !r.appended && /lock/i.test(r.error ?? ''), JSON.stringify(r));
O('comp', { id: 'empty1', type: 'lock', data: null });

O('spawn', { id: 'lamp', lib: LAMP });
clearErr(); r = O('comp', { id: 'lamp', type: 'light', data: { color: 0xffaa66, intensity: 24, range: 9, day: false, flicker: 0.2 } });
check('comp light on a model is accepted verbatim (unknown keys ride along)', !!r.appended && jeq(st.entities.lamp.comp?.light, { color: 0xffaa66, intensity: 24, range: 9, day: false, flicker: 0.2 }), JSON.stringify(r));
for (const [what, data, re] of [
  ['a string', 'on', /is an object/], ['an array', [1], /is an object/], ['a colour as a string', { color: 'red' }, /color/],
  ['a negative intensity', { intensity: -1 }, /intensity/], ['a zero range', { range: 0 }, /range/], ['keep as a string', { keep: 'yes' }, /keep/], ['day as 0', { day: 0 }, /day/],
] as [string, unknown, RegExp][]) {
  clearErr(); r = O('comp', { id: 'lamp', type: 'light', data });
  check(`comp light with ${what} is refused with a teaching reason, nothing appended`, !r.appended && re.test(r.error ?? ''), JSON.stringify(r));
}
O('light', { id: 'porch', pos: [0, 2, 0] });
clearErr(); r = O('comp', { id: 'porch', type: 'light', data: { intensity: 4 } });
check('comp light on a light-verb light is refused (its own fields are its light)', !r.appended && /already a light/.test(r.error ?? '') && !st.entities.porch.comp, JSON.stringify(r));
clearErr(); r = O('comp', { id: 'porch', type: 'light', data: null });
check('…but removing one (data: null) is always allowed — a hand-written log may have put one there', !!r.appended, JSON.stringify(r));
clearErr(); r = O('comp', { id: 'empty1', type: 'light', data: {} });
check('comp light {} on an Empty is accepted (all defaults)', !!r.appended && jeq(st.entities.empty1.comp?.light, {}), JSON.stringify(r));
clearErr(); r = O('comp', { id: 'lamp', type: 'collider', data: { shape: 'box' } });
check('comp collider {shape: "box"} is accepted', !!r.appended && jeq(st.entities.lamp.comp?.collider, { shape: 'box' }), JSON.stringify(r));
for (const data of [{ shape: 'mesh' }, {}, 'box']) {
  clearErr(); r = O('comp', { id: 'lamp', type: 'collider', data });
  check(`comp collider ${JSON.stringify(data)} is refused, saying the two shapes`, !r.appended && /exact.*box/.test(r.error ?? ''), JSON.stringify(r));
}
// step 3 (design §3): the Transform's rotation order rides comp.rotOrder
clearErr(); r = O('comp', { id: 'lamp', type: 'rotOrder', data: 'ZXY' });
check('comp rotOrder "ZXY" is accepted and folds into the bag', !!r.appended && st.entities.lamp.comp?.rotOrder === 'ZXY', JSON.stringify(r));
for (const bad of ['zxy', 'XYX', 3, { order: 'XYZ' }]) {
  clearErr(); r = O('comp', { id: 'lamp', type: 'rotOrder', data: bad });
  check(`comp rotOrder ${JSON.stringify(bad)} is refused, naming the seven orders`, !r.appended && /XYZ, XZY, YXZ, YZX, ZXY, ZYX, quat/.test(r.error ?? ''), JSON.stringify(r));
}
{
  const snap: any = emptyState();
  for (const e of stateToEntries(st, { now: 1 })) foldEntry(snap, JSON.parse(JSON.stringify(e)));
  check('…and survives a snapshot replay (a late joiner reads the same order)', snap.entities.lamp?.comp?.rotOrder === 'ZXY', JSON.stringify(snap.entities.lamp?.comp));
}
clearErr(); r = O('comp', { id: 'lamp', type: 'rotOrder', data: null });
check('…removing it (back to XYZ) is always allowed', !!r.appended && st.entities.lamp.comp?.rotOrder === undefined, JSON.stringify(r));
clearErr(); r = V('comp', { id: 'lamp', type: 'light', data: {} });
check('a visitor\'s comp light is refused by rank, before any shape talk', !r.appended && /builder/.test(r.error ?? ''), JSON.stringify(r));

// ---- 3. the browser realizer --------------------------------------------------
console.log('\n3. the browser (client/lib/realize/models.js, real bus + state, stubbed renderer)');
const stub: any = await import('./unknown-comp-stub.mjs');
const M: any = await import('../client/lib/realize/models.js');
const S: any = await import('../client/lib/state.js');
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const settle = async () => { for (let i = 0; i < 6; i++) { M.residencySweep?.(); M.drainPromoteTail?.(); await sleep(15); } };
{
  const w0: any = emptyState(); let q = 0;
  const F = (verb: string, args: any) => foldEntry(w0, { seq: q, ts: 1786320000000 + q++, actor: 'owner', verb, args });
  F('spawn', { id: 'pivot', pos: [1, 2, 3], yaw: 0.5 });
  F('comp', { id: 'pivot', type: 'light', data: { keep: true, intensity: 30 } });
  F('spawn', { id: 'lamp', lib: LAMP, pos: [2, 0, 0], collide: 'exact' });
  F('comp', { id: 'lamp', type: 'light', data: { color: 0xff8800, range: 7, day: false } });
  F('comp', { id: 'lamp', type: 'collider', data: { shape: 'box' } });
  F('spawn', { id: 'crate', lib: 'eidoverse/assets/models/crate.glb', pos: [4, 0, 0], collide: 'box' });
  F('spawn', { id: 'plain', lib: 'eidoverse/assets/models/plain.glb', pos: [6, 0, 0] });
  F('spawn', { id: 'farlamp', lib: LAMP, pos: [600, 0, 0] });
  F('comp', { id: 'farlamp', type: 'light', data: { intensity: 5 } });
  F('spawn', { id: 'cup', lib: 'eidoverse/assets/models/cup.glb', pos: [0, 0, 0] });
  F('mount', { id: 'cup', to: 'pivot', offset: [0, 0.5, 0] });
  F('light', { id: 'porch', pos: [0, 2, 0] });
  M.initModelsRealizer();
  S.hydrate(structuredClone(w0), [], q - 1);
  await settle();

  const piv = stub.entities.get('pivot');
  check('an Empty realizes at once as an invisible Group at its folded transform', !!piv && piv.isGroup && piv.userData.empty === true
    && jeq(piv.position.toArray(), [1, 2, 3]) && Math.abs(piv.rotation.y - 0.5) < 1e-9, `${piv?.type} ${JSON.stringify(piv?.position)}`);
  check('…loads nothing (no asset request names it) and is listed with kind "empty"',
    !stub.loads.some((l: any) => l.lib == null || l.lib === 'undefined') && stub.entityMeta.get('pivot')?.kind === 'empty', JSON.stringify(stub.loads.map((l: any) => l.lib)));
  check('…and owns no collider', !stub.colliderLog.some((e: any) => e[1] === 'pivot'), JSON.stringify(stub.colliderLog));
  const cup = stub.entities.get('cup');
  check('a model mounted on an Empty rides it (parented into the Empty\'s Group at its offset)', !!cup && cup.parent === piv && jeq(cup.position.toArray(), [0, 0.5, 0]), `${cup?.parent?.type} ${JSON.stringify(cup?.position)}`);

  const rq = (id: string) => stub.lightRequests.get(`complight:${id}`);
  check('comp.light on the Empty becomes a rig request that follows the Empty\'s object, with its fields and the fold\'s defaults',
    rq('pivot')?.obj === piv && rq('pivot').keep === true && rq('pivot').intensity === 30 && rq('pivot').range === 10 && rq('pivot').color === 0xffd9a0 && rq('pivot').dayAware === true && rq('pivot').authored === true, JSON.stringify({ ...rq('pivot'), obj: !!rq('pivot')?.obj }));
  check('…and its gizmo is a child of the Empty (a bare bulb is seen, and selectable)', piv?.children.some((c: any) => c.userData.gizmo), JSON.stringify(piv?.children.map((c: any) => c.type)));
  const lamp = stub.entities.get('lamp');
  check('a lamp (Model + comp.light): the request follows the REALIZED model, day:false → not day-aware',
    !!lamp && !!lamp.userData.lib && rq('lamp')?.obj === lamp && rq('lamp').color === 0xff8800 && rq('lamp').range === 7 && rq('lamp').dayAware === false, JSON.stringify({ ...rq('lamp'), obj: rq('lamp')?.obj?.userData }));
  let lampGizmo = false; lamp?.traverse((o: any) => { if (o.userData?.gizmo) lampGizmo = true; });
  check('…with NO gizmo mesh inside the model (it would join the collider, the lamp scan, the caster scan)', !lampGizmo);
  check('a far lamp (beyond its residency radius, never loaded) still lights: the request parks at the folded position',
    stub.entities.get('farlamp') === null && rq('farlamp')?.obj === null && jeq(rq('farlamp')?.pos, [600, 0, 0]) && rq('farlamp').intensity === 5, JSON.stringify(rq('farlamp')));
  check('a legacy light-verb light makes no comp request (it is realized by createLight, as always)', !rq('porch') && stub.entities.get('porch') !== undefined);

  // authored beats inferred (design §3): a Light component suppresses the model's inferred lamps
  const lamps = (id: string) => stub.lampOwners.get(`entity:${id}`) ?? 0;
  check('a lamp (Model + comp.light) lands WITHOUT inferred lamps — the authored light alone lights it', !!lamp?.userData?.lib && lamps('lamp') === 0,
    JSON.stringify(stub.lampLog.filter((e: any) => e[1] === 'entity:lamp')));
  check('…a model with no Light component still gets its inferred lamps, exactly once', lamps('plain') === 1 && lamps('crate') === 1, JSON.stringify([...stub.lampOwners]));
  check('…attached once at landing, with no churn (no release, no second attach) before anything changed',
    ['plain', 'crate'].every((id) => JSON.stringify(stub.lampLog.filter((e: any) => e[1] === `entity:${id}`)) === JSON.stringify([['attach', `entity:${id}`]])), JSON.stringify(stub.lampLog));
  const fit = (id: string) => stub.colliders.get(id)?.opts;
  check('colliders: comp.collider wins over the legacy collide on the same entity', fit('lamp')?.collide === 'box', JSON.stringify(fit('lamp')));
  check('…the legacy collide alone is still honoured', fit('crate')?.collide === 'box', JSON.stringify(fit('crate')));
  check('…and neither = undefined (decide by size), as before', !!fit('plain') && fit('plain').collide === undefined, JSON.stringify(fit('plain')));

  // live
  const live = (verb: string, args: any) => { const e = { seq: q, ts: 1786320000000 + q++, actor: 'owner', verb, args }; S.foldLive(e); };
  live('comp', { id: 'pivot', type: 'light', data: { intensity: 2, color: 0x00ff00 } });
  check('live: a changed comp.light updates the request in place (keep cleared, colour, intensity)', rq('pivot')?.intensity === 2 && rq('pivot').keep === false && rq('pivot').color === 0x00ff00 && rq('pivot').obj === piv, JSON.stringify({ ...rq('pivot'), obj: !!rq('pivot')?.obj }));
  live('place', { id: 'pivot', pos: [5, 5, 5] });
  check('live: placing the Empty moves its Group (and the request rides it)', jeq(piv.position.toArray(), [5, 5, 5]) && rq('pivot')?.obj === piv);
  live('place', { id: 'farlamp', pos: [700, 0, 0] });
  check('live: placing a never-loaded lamp moves its parked light', jeq(rq('farlamp')?.pos, [700, 0, 0]), JSON.stringify(rq('farlamp')?.pos));
  const marks = stub.colliderLog.length;
  live('comp', { id: 'lamp', type: 'collider', data: { shape: 'exact' } });
  check('live: a changed comp.collider re-decides the standing collider under the new shape',
    stub.colliders.get('lamp')?.pref === 'exact' && stub.colliderLog.slice(marks).some((e: any) => e[0] === 'refit' && e[1] === 'lamp'), JSON.stringify(stub.colliderLog.slice(marks)));
  live('comp', { id: 'lamp', type: 'collider', data: null });
  check('…and removing it falls back to the legacy collide', stub.colliders.get('lamp')?.pref === 'exact');
  live('comp', { id: 'plain', type: 'light', data: { intensity: 9 } });
  check('live: a Light component added to a STANDING model releases its inferred lamps (and casts its own)',
    lamps('plain') === 0 && stub.lampLog.at(-1)?.[0] === 'release' && stub.lampLog.at(-1)?.[1] === 'entity:plain' && rq('plain')?.intensity === 9, JSON.stringify(stub.lampLog.slice(-3)));
  live('comp', { id: 'plain', type: 'light', data: { intensity: 12 } });
  check('…changing that light touches no lamps', lamps('plain') === 0 && stub.lampLog.at(-1)?.[1] === 'entity:plain' && stub.lampLog.at(-1)?.[0] === 'release' && rq('plain')?.intensity === 12);
  live('comp', { id: 'plain', type: 'light', data: null });
  check('…removing it re-infers the lamps, once', lamps('plain') === 1 && !rq('plain'), JSON.stringify(stub.lampLog.slice(-3)));
  live('comp', { id: 'plain', type: 'light', data: null });
  check('…and a second removal does not attach them twice', lamps('plain') === 1);
  live('comp', { id: 'pivot', type: 'light', data: null });
  check('live: removing comp.light releases the request and takes the gizmo off the Empty',
    !rq('pivot') && !piv.children.some((c: any) => c.userData.gizmo));
  live('spawn', { id: 'lamp', lib: LAMP, pos: [2, 0, 0] });
  check('live: re-spawning a lamp with the same model (wholesale replace, refreshed in place) drops its old light', !rq('lamp') && stub.entities.get('lamp') === lamp, `${JSON.stringify(rq('lamp')?.color)}`);
  check('…and, its authored light gone, its inferred lamps come back', lamps('lamp') === 1, JSON.stringify(stub.lampLog.filter((e: any) => e[1] === 'entity:lamp')));
  live('comp', { id: 'pivot', type: 'light', data: {} });
  live('spawn', { id: 'pivot', pos: [5, 5, 5] });
  check('live: re-spawning the Empty (wholesale replace) drops the light its old bag had', !rq('pivot') && stub.entities.get('pivot') === piv, `${!!rq('pivot')}`);
  live('spawn', { id: 'pivot', lib: 'eidoverse/assets/models/stool.glb', pos: [5, 0, 5] });
  await settle();
  check('live: a model spawned over the Empty replaces it (the Group retires, the model realizes)',
    stub.entities.get('pivot') !== piv && !!stub.entities.get('pivot')?.userData?.lib && !piv.parent, `${stub.entities.get('pivot')?.userData?.lib}`);
  // cargo on a model whose id is re-spawned as an Empty: the fold keeps the
  // cargo's parent (it names the id); retiring the model steps the cargo off,
  // and the Empty — which has no promote tail — must re-seat it itself
  live('spawn', { id: 'cart', lib: 'eidoverse/assets/models/cart.glb', pos: [0, 0, 12] });
  live('spawn', { id: 'box1', lib: 'eidoverse/assets/models/box.glb', pos: [0, 0, 12] });
  await settle();
  live('mount', { id: 'box1', to: 'cart', offset: [0, 1, 0] });
  live('spawn', { id: 'cart', pos: [0, 0, 12] });
  const cartE = stub.entities.get('cart');
  check('live: cargo on a model re-spawned as an Empty is re-seated on the Empty at once', cartE?.userData?.empty === true && stub.entities.get('box1')?.parent === cartE,
    `${stub.entities.get('box1')?.parent?.type} / ${cartE?.userData?.empty}`);
  // step 4: a child keeps the FOLD's scale when it steps off a scaled carrier —
  // scene.attach() bakes the carrier's scale into the child (0.5 on a 2× carrier
  // came off as 1.0), which a joiner building from ent.scale would never see
  live('spawn', { id: 'big', lib: 'eidoverse/assets/models/box.glb', pos: [0, 0, 20], scale: 2 });
  live('spawn', { id: 'mug', lib: 'eidoverse/assets/models/box.glb', pos: [1, 1, 20], scale: 0.5 });
  await settle();
  live('mount', { id: 'mug', to: 'big', offset: [0.5, 0.5, 0] });
  const mug = stub.entities.get('mug');
  check('live: a 0.5 child on a 2× carrier rides it at its own scale (world 1.0)', mug?.parent === stub.entities.get('big') && Math.abs(mug.scale.x - 0.5) < 1e-9, `${mug?.parent?.type} ${mug?.scale?.x}`);
  live('dismount', { id: 'mug', pos: [1, 1, 20], yaw: 0 });
  check('live: dismounting it keeps the fold\'s scale 0.5, not the 1.0 attach() baked in', !mug.userData.mountedTo && Math.abs(mug.scale.x - 0.5) < 1e-9, `${mug.scale.x}`);
  live('mount', { id: 'mug', to: 'big', offset: [0.5, 0.5, 0] });
  live('remove', { id: 'big' });
  check('live: …and so does stepping off a carrier that is removed', !mug.userData.mountedTo && Math.abs(mug.scale.x - 0.5) < 1e-9, `${mug.scale.x}`);
  live('spawn', { id: 'e2', pos: [0, 0, 9] });
  live('comp', { id: 'e2', type: 'light', data: { range: 3 } });
  const e2 = stub.entities.get('e2');
  live('remove', { id: 'e2' });
  check('live: removing an Empty retires its Group and releases its light', !stub.entities.has('e2') && !e2.parent && !rq('e2'));
  const spy: any = await import('./unknown-comp-report-spy.mjs');
  const { planReconcile, kindOf } = await import('../client/lib/realize/models_field.js');
  const plan = planReconcile({ a: { pos: [0, 0, 0] }, b: { lib: LAMP, pos: [0, 0, 0] }, c: { kind: 'light', pos: [0, 1, 0] } },
    new Map([['a', { kind: 'empty' }], ['b', { kind: 'model', lib: LAMP }], ['c', { kind: 'light' }]]));
  check('reconcile (rejoin) leaves a standing Empty alone — no retire-and-rebuild churn', plan.create.length === 0 && plan.retire.length === 0, JSON.stringify(plan));
  const plan2 = planReconcile({ a: { lib: LAMP, pos: [0, 0, 0] } }, new Map([['a', { kind: 'empty' }]]));
  check('…but an Empty whose id now folds as a model is rebuilt', plan2.retire[0] === 'a' && plan2.create[0]?.id === 'a', JSON.stringify(plan2));
  check('kindOf: light / empty / model', kindOf({ kind: 'light' }) === 'light' && kindOf({ pos: [0, 0, 0] }) === 'empty' && kindOf({ lib: LAMP }) === 'model');
  const { bus } = await import('../client/lib/base.js');
  const marker = (g: any) => !!g?.children.some((c: any) => c.userData?.emptyMarker);
  const cartG = stub.entities.get('cart');
  check('outside edit mode an Empty carries no marker (nothing to hit that nobody can see)', !marker(cartG));
  bus.emit('edit-mode', true);
  live('spawn', { id: 'e3', pos: [0, 0, 15] });
  check('edit mode on: every Empty wears a pickable marker, including one created while editing', marker(cartG) && marker(stub.entities.get('e3')));
  bus.emit('edit-mode', false);
  check('edit mode off: the markers come off again', !marker(cartG) && !marker(stub.entities.get('e3')));
  check('the realizer reported nothing at any point (no error path was taken)', spy.reports.length === 0, JSON.stringify(spy.reports.map((r: any) => `${r.where}: ${r.e}`)));
}

// ---- 4. text tier --------------------------------------------------------------
console.log('\n4. text tier (mcpl/agent.ts look(), mcpl/tools.ts)');
{
  const { WorldAgent } = await import('../mcpl/agent.ts');
  const ag = new WorldAgent({ name: 'eye' });
  const A = ag as any;
  let n = 1;
  const entry = (verb: string, args: Record<string, unknown>) => A.applyEntry({ verb, args, ts: 1786320000000 + n, seq: n++, actor: 'owner' }, false);
  entry('spawn', { id: 'pivot', pos: [1, 0, 1] });
  entry('spawn', { id: 'bulb', pos: [2, 0, 2] });
  entry('comp', { id: 'bulb', type: 'light', data: { color: 0x00ff00, intensity: 9, day: false } });
  entry('spawn', { id: 'lamp', lib: LAMP, pos: [3, 0, 3] });
  entry('comp', { id: 'lamp', type: 'light', data: { keep: true } });
  entry('comp', { id: 'lamp', type: 'collider', data: { shape: 'box' } });
  entry('light', { id: 'porch', pos: [4, 2, 4], color: 0xffd9a0, intensity: 40, range: 12 });
  entry('spawn', { id: 'odd', lib: LAMP, pos: [5, 0, 5] });
  entry('comp', { id: 'odd', type: 'light', data: 'on' });
  entry('spawn', { id: 'old', lib: LAMP, pos: [6, 0, 6], collide: 'exact' });
  const out = ag.look();
  const line = (id: string) => out.split('\n').find((l: string) => l.includes(`[${id}]`)) ?? '';
  check('an Empty is named "(empty)" in look() — like "(light)", never a blank', /\[pivot\] \(empty\):/.test(line('pivot')), line('pivot'));
  check('a light component on an Empty says what it casts (colour, brightness, reach, noon)', /\[bulb\] \(empty\): .*light: #00ff00, brightness 9, reaches 10m, burns at noon/.test(line('bulb')), line('bulb'));
  check('…and is not ALSO listed as a bare component', !/components: .*light/.test(line('bulb')), line('bulb'));
  check('a lamp (Model + light component) is named by its model and says its light and its collider',
    /\[lamp\] lamp: .*light: #ffd9a0, brightness 16, reaches 10m, kept lit/.test(line('lamp')) && /collides as a box/.test(line('lamp')) && !/components:/.test(line('lamp')), line('lamp'));
  check('a light-verb light now says what it casts too (it used to say only "(light)")', /\[porch\] \(light\): .*light: #ffd9a0, brightness 40, reaches 12m/.test(line('porch')), line('porch'));
  check('a malformed light comp casts nothing and stays listed by name', /components: light/.test(line('odd')) && !/light: #/.test(line('odd')), line('odd'));
  check('the spawn verb\'s legacy collide is not described (this agent\'s snapshot path drops it by design)', !/collides/.test(line('old')), line('old'));
  const { HANDLERS } = await import('../mcpl/tools.ts');
  {
    const r: any = await HANDLERS.inspect(ag as any, { id: 'pivot' });
    const txt = JSON.stringify(r);
    check('the inspect tool heads an Empty "empty"', /\[pivot\] empty/.test(txt), txt.slice(0, 160));
  }
}

// ---- 5. the inspector ----------------------------------------------------------
console.log('\n5. the inspector (shared/editschema.js: reads either spelling, writes new on edit)');
{
  const { inspectSchema, editVerbs, fieldAt } = await import('../shared/editschema.js');
  const ed = (ent: any, set: Record<string, unknown>) => editVerbs(ent, 'x', set);
  const verbsOf = (r: any) => JSON.stringify(r.verbs);
  // every card's fields resolve and are owned once (components-inspector-test's rule)
  const cardsSound = (ent: any) => { const sc = inspectSchema(ent, 'x'); const own = new Map<string, string>(); const bad: string[] = [];
    for (const a of sc.sections.header) own.set(a, 'header');
    for (const sec of sc.sections.list) for (const a of sec.fields) { if (!fieldAt(sc, a)) bad.push(`${sec.title}: ${a} is no field`); if (own.has(a)) bad.push(`${a} owned twice`); own.set(a, sec.title); }
    return bad; };
  const card = (ent: any, type: string, key: string | null = null) => inspectSchema(ent, 'x').sections.list.find((c: any) => c.type === type && c.key === key);

  const legacy = { kind: 'light', pos: [0, 2, 0], color: 0xffd9a0, intensity: 16, range: 10, actor: 'a', ts: 1 };
  check('an OLD light-verb light is edited with the light verb, as before — it is not migrated',
    verbsOf(ed(legacy, { 'light.intensity': 30, 'light.noon': true })) === JSON.stringify([{ verb: 'light', args: { id: 'x', intensity: 30, day: false } }]), verbsOf(ed(legacy, { 'light.intensity': 30, 'light.noon': true })));
  check('…its Light card owns the light group and is not removable (removing a light-verb light is removing the entity)',
    card(legacy, 'Light')?.fields.includes('light.intensity') && card(legacy, 'Light').removable === false, JSON.stringify(card(legacy, 'Light')));

  const lamp = { lib: LAMP, pos: [0, 0, 0], yaw: 0, comp: { light: { color: 0xff8800, intensity: 20, keep: true, flicker: 1 } }, actor: 'a', ts: 1 };
  const lsch = inspectSchema(lamp, 'x');
  check('a light component shows in the SAME light group (light.* addresses), valued from its bag',
    fieldAt(lsch, 'light.intensity')?.value === 20 && fieldAt(lsch, 'light.color')?.value === 0xff8800 && fieldAt(lsch, 'light.range')?.value === 10 && fieldAt(lsch, 'light.keep')?.value === true, JSON.stringify(lsch.groups.find((g: any) => g.group === 'light')));
  check('…editing it writes comp light, merged into the bag (unknown keys kept), keep/day stored only when not default',
    verbsOf(ed(lamp, { 'light.intensity': 24, 'light.keep': false, 'light.noon': true, 'light.color': '#00ff00' })) === JSON.stringify([{ verb: 'comp', args: { id: 'x', type: 'light', data: { color: 0x00ff00, intensity: 24, flicker: 1, day: false } } }]),
    verbsOf(ed(lamp, { 'light.intensity': 24, 'light.keep': false, 'light.noon': true, 'light.color': '#00ff00' })));
  check('…a value the door would refuse is refused here first, with the door\'s words', (() => { const r = ed(lamp, { 'light.color': 'zz' }); return r.verbs.length === 0 && /light: light color/.test(r.errors[0] ?? ''); })(), JSON.stringify(ed(lamp, { 'light.color': 'zz' })));
  check('…its card is removable and remove.light writes comp light null', card(lamp, 'Light', 'light')?.removable === true
    && verbsOf(ed(lamp, { 'remove.light': null })) === JSON.stringify([{ verb: 'comp', args: { id: 'x', type: 'light', data: null } }]));
  check('…and it is not shown a second time as raw JSON in Components', !fieldAt(lsch, 'comp.light'));

  const empty = { pos: [1, 2, 3], yaw: 0, actor: 'a', ts: 1 };
  const esch = inspectSchema(empty, 'x');
  check('an Empty: a Transform card with yaw and scale, and no Model card', !!fieldAt(esch, 'pos.yaw') && !!fieldAt(esch, 'pos.scale') && !card(empty, 'Model') && esch.sections.list.length === 1, JSON.stringify(esch.sections.list.map((c: any) => c.type)));
  check('…Add Component offers Light (unblocked) and not Collider (it needs a model)',
    esch.sections.add.some((a: any) => a.name === 'Light' && !a.blocked) && !esch.sections.add.some((a: any) => a.name === 'Collider' && !a.blocked), JSON.stringify(esch.sections.add.map((a: any) => `${a.name}${a.blocked ? '(blocked)' : ''}`)));
  check('…add.Light writes comp light with the fields spelled out (the log records the result, not a default)',
    verbsOf(ed(empty, { 'add.Light': null })) === JSON.stringify([{ verb: 'comp', args: { id: 'x', type: 'light', data: { color: 0xffd9a0, intensity: 16, range: 10 } } }]));
  check('…add.Collider is refused with a reason', (() => { const r = ed(empty, { 'add.Collider': null }); return r.verbs.length === 0 && /needs a model/.test(r.errors[0] ?? ''); })());
  check('add.Light on a light-verb light is refused (it is already one)', (() => { const r = ed(legacy, { 'add.Light': null }); return r.verbs.length === 0 && /already a light/.test(r.errors[0] ?? ''); })());

  const oldCol = { lib: LAMP, pos: [0, 0, 0], yaw: 0, collide: 'exact', actor: 'a', ts: 1 };
  check('a legacy spawn collide shows as the collider group; editing it writes the collider COMPONENT (write-new-on-edit)',
    fieldAt(inspectSchema(oldCol, 'x'), 'collider.shape')?.value === 'exact' && verbsOf(ed(oldCol, { 'collider.shape': 'box' })) === JSON.stringify([{ verb: 'comp', args: { id: 'x', type: 'collider', data: { shape: 'box' } } }]));
  check('…its legacy card is not removable (only a spawn writes collide)', card(oldCol, 'Collider')?.removable === false);
  const both = { ...oldCol, comp: { collider: { shape: 'box' } } };
  check('with both spellings the component owns the group, the legacy card says it is overridden, nothing is owned twice',
    fieldAt(inspectSchema(both, 'x'), 'collider.shape')?.value === 'box' && card(both, 'Collider', 'collider')?.fields.includes('collider.shape')
    && /overridden/.test(JSON.stringify(card(both, 'Collider')?.info)) && cardsSound(both).length === 0, JSON.stringify(cardsSound(both)));
  check('collider.shape must be exact or box', (() => { const r = ed(both, { 'collider.shape': 'mesh' }); return r.verbs.length === 0 && /exact.*box/.test(r.errors[0] ?? ''); })());
  check('add.Collider on a model writes comp collider (default exact; "box" when asked)',
    verbsOf(ed({ lib: LAMP, pos: [0, 0, 0] }, { 'add.Collider': 'box' })) === JSON.stringify([{ verb: 'comp', args: { id: 'x', type: 'collider', data: { shape: 'box' } } }])
    && verbsOf(ed({ lib: LAMP, pos: [0, 0, 0] }, { 'add.Collider': null })) === JSON.stringify([{ verb: 'comp', args: { id: 'x', type: 'collider', data: { shape: 'exact' } } }]));
  check('the raw-JSON door obeys the door\'s rules too (comp.light with a string colour; comp.light on a light-verb light)',
    ed(lamp, { 'comp.light': '{"color":"red"}' }).verbs.length === 0 && ed(legacy, { 'comp.light': '{"intensity":3}' }).verbs.length === 0);
  const hand = { ...legacy, comp: { light: { color: 4 } } };
  check('a hand-written log with both lights: the legacy one owns the group, the component is raw JSON, nothing owned twice',
    fieldAt(inspectSchema(hand, 'x'), 'light.color')?.value === 0xffd9a0 && !!fieldAt(inspectSchema(hand, 'x'), 'comp.light') && cardsSound(hand).length === 0, JSON.stringify(cardsSound(hand)));
  check('every card sound on the lamp, the Empty and the legacy-collide model', [lamp, empty, oldCol, legacy].every((e) => cardsSound(e).length === 0), JSON.stringify([lamp, empty, oldCol, legacy].map(cardsSound)));
}

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
