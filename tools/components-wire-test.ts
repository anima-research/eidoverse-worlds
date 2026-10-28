// components-wire-test — step 2 of docs/DESIGN-edit-mode-components.md §7:
// light as a component, empty entities, collider as a component — each with
// its alias, on every tier that gives it meaning.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/components-wire-test.ts
//
// Each tier is the REAL module; no server process, no browser:
//   3. the browser   client/lib/realize/models.js over tools/lod-client-stub.mjs, fed the views a client folds
//                    from a scratch world behind the real door (tools/protocol/scratchworld.ts)
//   5. inspector     shared/editschema.js — reads either spelling, writes new on edit, through the authority
// (Protocol v1 removed, 2026-10-07: tiers 1 (the v1 fold), 2 (server/verbs.ts) and 4 (the agent's v1 applyEntry
//  reader) went with it; tier 3 was ported to the protocol's feed. Its v1-only checks were dropped: the spawn verb's legacy
//  `collide`, light-verb lights, a re-spawn over an id as a wholesale replace, and cargo mount/dismount verbs.)
import "./protocol/fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
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
    for (const f of ['^\\.\\./(core|assets|colliders|lightrig|lights|world|materials)\\.js$', '^\\./(core|world|colliders|remotes)\\.js$']) {
      b.onResolve({ filter: new RegExp(f) }, () => ({ path: STUB }));
    }
    // the realizer's report(), recorded; everyone else gets the real base.js (the real bus)
    b.onResolve({ filter: /^\.\.\/base\.js$/ }, (args) => (args.importer.replace(/\\/g, '/').endsWith('realize/models.js') ? { path: SPY } : undefined));
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
const entScaleOf = (e: any) => { const s = e?.scale3 ?? e?.scale ?? 1; return Array.isArray(s) && s.every((x: number) => x === s[0]) ? s[0] : s; };

const LAMP = 'eidoverse/assets/models/lamp.glb';
const { scratchWorld } = await import('./protocol/scratchworld.ts');

// ---- 3. the browser realizer --------------------------------------------------
console.log('\n3. the browser (client/lib/realize/models.js, real bus + state, stubbed renderer)');
const stub: any = await import('./unknown-comp-stub.mjs');
const M: any = await import('../client/lib/realize/models.js');
const S: any = await import('../client/lib/state.js');
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const settle = async () => { for (let i = 0; i < 6; i++) { M.residencySweep?.(); M.drainPromoteTail?.(); await sleep(15); } };
{
  // the world as a client holds it: a scratch world behind the real door; the realizer is fed the views a
  // client's own fold reaches (hydrate the cut's view, then applyView after every door write)
  const W = scratchWorld('compwire3');
  W.seed({
    pivot: { pos: [1, 2, 3], yaw: 0.5, light: { important: true, intensity: 30 } },
    lamp: { model: LAMP, pos: [2, 0, 0], collider: { shape: 'box' } },
    'lamp-light': { pos: [0, 0, 0], parent: { to: 'lamp', offset: [0, 1, 0] }, light: { color: 0xff8800, range: 7, day: false } },
    crate: { model: 'eidoverse/assets/models/crate.glb', pos: [4, 0, 0], collider: { shape: 'box' } },
    plain: { model: 'eidoverse/assets/models/plain.glb', pos: [6, 0, 0] },
    farlamp: { model: LAMP, pos: [600, 0, 0] },
    'farlamp-light': { pos: [0, 0, 0], parent: { to: 'farlamp', offset: [0, 0, 0] }, light: { intensity: 5 } },
    cup: { model: 'eidoverse/assets/models/cup.glb', pos: [0, 0, 0], parent: { to: 'pivot', offset: [0, 0.5, 0] } },
    tbl: { model: 'eidoverse/assets/models/crate.glb', pos: [10, 0, 0], yaw: 1 },
    tcup: { model: 'eidoverse/assets/models/cup.glb', pos: [0, 0, 0], parent: { to: 'tbl', offset: [0, 1, 0] } },
    tem: { pos: [0, 0, 0], parent: { to: 'tbl', offset: [0, 1.5, 0] } },
  });
  M.initModelsRealizer();
  const view0 = structuredClone(W.view());
  view0.entities.implamp = { model: LAMP, pos: [8, 0, 0], light: { color: 0xff8800, range: 7 } };   // as an imported log folds (the fold never refuses)
  S.hydrate(view0);
  await settle();
  /** one door write, then the view a client folds from it */
  const live = (tool: string, args: any) => { const r = W.call(tool, args); if (!r.ok) throw new Error(`${tool} ${JSON.stringify(args)} refused: ${JSON.stringify(r.refused)}`); S.applyView(structuredClone(W.view())); return r; };
  const at = (id: string, pos: number[]) => ({ id, component: 'transform', value: { pos }, merge: true });

  const piv = stub.entities.get('pivot');
  check('an Empty realizes at once as an invisible Group at its folded transform', !!piv && piv.isGroup && piv.userData.empty === true
    && jeq(piv.position.toArray().map((x: number) => +x.toFixed(9)), [1, 2, 3]) && Math.abs(piv.rotation.y - 0.5) < 1e-9, `${piv?.type} ${JSON.stringify(piv?.position)}`);
  check('…loads nothing (no asset request names it) and is listed with kind "light" (one kindOf: an Empty carrying a light IS a light)',
    !stub.loads.some((l: any) => l.lib == null || l.lib === 'undefined') && stub.metaOf('pivot')?.kind === 'light', JSON.stringify([stub.loads.map((l: any) => l.lib), stub.metaOf('pivot')]));   // loads: the loader's own record (its lib path, as userData.lib), not a view record
  check('…and owns no collider', !stub.colliderLog.some((e: any) => e[1] === 'pivot'), JSON.stringify(stub.colliderLog));
  const cup = stub.entities.get('cup');
  check('a model parented to an Empty rides it (parented into the Empty\'s Group at its offset)', !!cup && cup.parent === piv && jeq(cup.position.toArray().map((x: number) => +x.toFixed(9)), [0, 0.5, 0]), `${cup?.parent?.type} ${JSON.stringify(cup?.position)}`);

  const rq = (id: string) => stub.lightRequests.get(`complight:${id}`);
  check('the light component on the Empty becomes a rig request that follows the Empty\'s object, with its fields and the defaults',
    rq('pivot')?.obj === piv && rq('pivot').keep === true && rq('pivot').intensity === 30 && rq('pivot').range === 10 && rq('pivot').color === 0xffd9a0 && rq('pivot').dayAware === true && rq('pivot').authored === true, JSON.stringify({ ...rq('pivot'), obj: !!rq('pivot')?.obj }));
  check('…and its gizmo is a child of the Empty (a bare bulb is seen, and selectable)', piv?.children.some((c: any) => c.userData.gizmo), JSON.stringify(piv?.children.map((c: any) => c.type)));
  // one place per thing (R 10-11): a light never shares an entity with a model natively — a lamp is a model with a light
  // on its own child. An imported world's lamp (model + light on one record, kept by the fold) is hydrated here by hand.
  const lamp = stub.entities.get('lamp'); const lampLight = stub.entities.get('lamp-light');
  check('a lamp (Model + child light): the child Empty rides the REALIZED model and its request follows the child, day:false → not day-aware',
    !!lamp && !!lamp.userData.lib && lampLight?.parent === lamp && rq('lamp-light')?.obj === lampLight && rq('lamp-light').color === 0xff8800 && rq('lamp-light').range === 7 && rq('lamp-light').dayAware === false, JSON.stringify({ ...rq('lamp-light'), obj: rq('lamp-light')?.obj?.userData, parent: lampLight?.parent?.userData }));
  let lampGizmo = false; lamp?.traverse((o: any) => { if (o.userData?.gizmo && o.parent !== lampLight) lampGizmo = true; });
  check('…with NO gizmo mesh inside the model itself (it would join the collider, the lamp scan, the caster scan); the bulb\'s gizmo hangs on the child', !lampGizmo && !!lampLight?.children.some((c: any) => c.userData.gizmo));
  // where the rig puts a request's light (lightrig.js worldPosOf): its object's world position, else its parked pos
  const lit = (id: string) => { const r = rq(id); if (!r) return null; const p = r.obj ? r.obj.getWorldPosition(new stub.THREE.Vector3()).toArray() : r.pos; return p?.map((x: number) => +x.toFixed(6) + 0); };
  // F1 (10-12): a child's record pos is carrier-LOCAL; with no realized carrier to mount into, the child Empty stood
  // in the Scene at that local pos and its light shone at the world origin. It stands at its folded WORLD pose now.
  // round 2 (review S1/S2): it waits mounted in the far lamp's STAND-IN, a bare Group at the lamp's folded world pose, so
  // its own transform stays local like every mounted child's
  const farChild = stub.entities.get('farlamp-light');
  const inStandIn = (o: any, carrier: string) => o?.parent?.userData?.standIn === carrier && o.userData.mountedTo === carrier;
  check('a far lamp\'s light (beyond its residency radius, never loaded) still lights, over the far lamp: its child waits in the lamp\'s stand-in and the request rides it',
    stub.entities.get('farlamp') === null && rq('farlamp-light')?.obj === farChild && inStandIn(farChild, 'farlamp') && jeq(lit('farlamp-light'), [600, 0, 0]) && rq('farlamp-light').intensity === 5,
    JSON.stringify({ lit: lit('farlamp-light'), obj: rq('farlamp-light')?.obj?.userData?.entityId ?? null, pos: rq('farlamp-light')?.pos }));

  // authored beats inferred (design §3): a Light component suppresses the model's inferred lamps
  const lamps = (id: string) => stub.lampOwners.get(`entity:${id}`) ?? 0;
  check('an imported lamp (Model + light on one record, as the fold keeps it) lands WITHOUT inferred lamps — the authored light alone lights it', !!stub.entities.get('implamp')?.userData?.lib && lamps('implamp') === 0 && rq('implamp')?.obj === stub.entities.get('implamp'),
    JSON.stringify(stub.lampLog.filter((e: any) => e[1] === 'entity:implamp')));
  check('…a model with no Light component still gets its inferred lamps, exactly once', lamps('plain') === 1 && lamps('crate') === 1, JSON.stringify([...stub.lampOwners]));
  check('…attached once at landing, with no churn (no release, no second attach) before anything changed',
    ['plain', 'crate'].every((id) => JSON.stringify(stub.lampLog.filter((e: any) => e[1] === `entity:${id}`)) === JSON.stringify([['attach', `entity:${id}`]])), JSON.stringify(stub.lampLog));
  const fit = (id: string) => stub.colliders.get(id)?.opts;
  check('colliders: the collider component decides the fit', fit('lamp')?.collide === 'box' && fit('crate')?.collide === 'box', JSON.stringify([fit('lamp'), fit('crate')]));
  check('…and none = undefined (decide by size)', !!fit('plain') && fit('plain').collide === undefined, JSON.stringify(fit('plain')));

  // live
  live('set', { id: 'pivot', component: 'light', value: { intensity: 2, color: 0x00ff00 } });
  check('live: a changed light component updates the request in place (important cleared, colour, intensity)', rq('pivot')?.intensity === 2 && rq('pivot').keep === false && rq('pivot').color === 0x00ff00 && rq('pivot').obj === piv, JSON.stringify({ ...rq('pivot'), obj: !!rq('pivot')?.obj }));
  live('set', at('pivot', [5, 5, 5]));
  check('live: moving the Empty moves its Group (and the request rides it)', jeq(piv.position.toArray().map((x: number) => +x.toFixed(9)), [5, 5, 5]) && rq('pivot')?.obj === piv, JSON.stringify(piv.position));
  live('set', at('farlamp', [700, 0, 0]));
  check('live: moving a never-loaded lamp moves its child\'s light with it', jeq(lit('farlamp-light'), [700, 0, 0]), JSON.stringify(lit('farlamp-light')));
  const marks = stub.colliderLog.length;
  live('set', { id: 'lamp', component: 'collider', value: { shape: 'exact' } });
  check('live: a changed collider component re-decides the standing collider under the new shape',
    stub.colliders.get('lamp')?.pref === 'exact' && stub.colliderLog.slice(marks).some((e: any) => e[0] === 'refit' && e[1] === 'lamp'), JSON.stringify(stub.colliderLog.slice(marks)));
  const onePlace = W.call('set', { id: 'plain', component: 'light', value: { intensity: 9 } });
  check('live: a Light component on a STANDING model is refused at the door (one-place)', !onePlace.ok && onePlace.refused?.code === 'one-place', JSON.stringify(onePlace.refused));
  live('create', { id: 'plain-light', components: { transform: { pos: [0, 1, 0] }, parent: { to: 'plain' }, light: { intensity: 9 } } });
  check('live: a light child added under a STANDING model casts its own light; the model keeps its inferred lamps (a child is not an authored light ON the model)',
    rq('plain-light')?.intensity === 9 && rq('plain-light').obj === stub.entities.get('plain-light') && lamps('plain') === 1, JSON.stringify([stub.lampLog.slice(-3), rq('plain-light')?.intensity, lamps('plain')]));
  live('set', { id: 'plain-light', component: 'light', value: { intensity: 12 } });
  check('…changing that light touches no lamps', lamps('plain') === 1 && stub.lampLog.at(-1)?.[1] !== 'entity:plain' && rq('plain-light')?.intensity === 12, JSON.stringify([stub.lampLog.slice(-2), rq('plain-light')?.intensity]));
  live('delete', { id: 'plain-light' });
  check('…removing the child releases its request and leaves the model\'s lamps alone', lamps('plain') === 1 && !rq('plain-light'), JSON.stringify(stub.lampLog.slice(-3)));
  live('delete', { id: 'pivot', component: 'light' });
  check('live: removing the light component releases the request and takes the gizmo off the Empty',
    !rq('pivot') && !piv.children.some((c: any) => c.userData.gizmo));
  live('create', { id: 'e2', components: { transform: { pos: [0, 0, 9] }, light: { range: 3 } } });
  const e2 = stub.entities.get('e2');
  check('live: an Empty created with a light realizes with its request', !!e2 && e2.userData.empty === true && rq('e2')?.range === 3, JSON.stringify({ ...rq('e2'), obj: !!rq('e2')?.obj }));
  live('delete', { id: 'e2' });
  check('live: removing an Empty retires its Group and releases its light', !stub.entities.has('e2') && !e2.parent && !rq('e2'));
  const spy: any = await import('./unknown-comp-report-spy.mjs');
  const { planReconcile, kindOf } = await import('../client/lib/realize/models_field.js');
  const plan = planReconcile({ a: { pos: [0, 0, 0] }, b: { model: LAMP, pos: [0, 0, 0] }, c: { pos: [0, 1, 0], light: {} } },
    new Map([['a', { kind: 'empty' }], ['b', { kind: 'model', model: LAMP }], ['c', { kind: 'light' }]]));
  check('reconcile (rejoin) leaves a standing Empty alone — no retire-and-rebuild churn', plan.create.length === 0 && plan.retire.length === 0, JSON.stringify(plan));
  const plan2 = planReconcile({ a: { model: LAMP, pos: [0, 0, 0] } }, new Map([['a', { kind: 'empty' }]]));
  check('…but an Empty whose id now folds as a model is rebuilt', plan2.retire[0] === 'a' && plan2.create[0]?.id === 'a', JSON.stringify(plan2));
  check('kindOf: light / empty / model / mesh', kindOf({ pos: [0, 1, 0], light: {} }) === 'light' && kindOf({ pos: [0, 0, 0] }) === 'empty' && kindOf({ model: LAMP }) === 'model' && kindOf({ mesh: { shape: 'box', size: [1, 1, 1] } }) === 'mesh' && kindOf({ mesh: {} }) === 'empty');
  const { bus } = await import('../client/lib/base.js');
  const marker = (g: any) => !!g?.children.some((c: any) => c.userData?.emptyMarker);
  check('outside edit mode an Empty carries no marker (nothing to hit that nobody can see)', !marker(piv));
  bus.emit('edit-mode', true);
  live('create', { id: 'e3', components: { transform: { pos: [0, 0, 15] } } });
  check('edit mode on: every Empty wears a pickable marker, including one created while editing', marker(piv) && marker(stub.entities.get('e3')));
  bus.emit('edit-mode', false);
  check('edit mode off: the markers come off again', !marker(piv) && !marker(stub.entities.get('e3')));
  // F1 pins: a waiting child composes its carrier's whole folded pose (turn, scale) with its own offset, follows a change
  // to either, and mounts into the real lamp the moment the lamp loads, without moving.
  const q90 = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  live('set', { id: 'farlamp', component: 'transform', value: { pos: [700, 0, 0], q: q90, scale: 2 }, merge: true });
  live('set', { id: 'farlamp-light', component: 'transform', value: { pos: [0, 1, 2] }, merge: true });
  check('live: a waiting child stands at carrier pose ∘ its offset (turned 90°, scale 2, offset [0,1,2] → [704,2,0]), its light with it',
    stub.entities.get('farlamp') === null && jeq(lit('farlamp-light'), [704, 2, 0]) && inStandIn(farChild, 'farlamp'), JSON.stringify(lit('farlamp-light')));
  // review S1: what the gizmo's release commits (gizmo.js endDrag: the object's own position, turn and scale through
  // poseEdits) must be the LOCAL pose, so a zero-length nudge of a waiting child writes the offset it already has
  const { poseEdits, editOps } = await import('../shared/editschema.js');
  const fcRec = S.state.st.entities['farlamp-light'];
  const gz = { pos: farChild.position.toArray(), q: farChild.quaternion.toArray(), scale: farChild.scale.toArray() };
  const nudge = editOps(fcRec, 'farlamp-light', { ...poseEdits(fcRec, 'farlamp-light', 'move', gz), ...poseEdits(fcRec, 'farlamp-light', 'scale', gz) }, { world: S.state.st.entities });
  for (const op of nudge.ops) live(op.verb, op.args);
  check('review S1: a zero-length gizmo nudge on a waiting child writes the offset it has (local), and it stays over the far lamp',
    jeq(farChild.position.toArray(), [0, 1, 2]) && jeq(S.state.st.entities['farlamp-light']?.parent?.offset, [0, 1, 2]) && jeq(entScaleOf(S.state.st.entities['farlamp-light']), 1) && jeq(lit('farlamp-light'), [704, 2, 0]),
    JSON.stringify({ local: farChild.position.toArray(), offset: S.state.st.entities['farlamp-light']?.parent?.offset, scale: S.state.st.entities['farlamp-light']?.scale, ops: nudge.ops, lit: lit('farlamp-light') }));
  // review S3 (4): the stand-in is hidden with its carrier, so the waiting child is too, as the scene graph would have it
  live('set', { id: 'farlamp', component: 'hidden', value: true });
  const hid = farChild.parent?.visible === false;
  live('delete', { id: 'farlamp', component: 'hidden' });
  check('a waiting child of a HIDDEN far lamp is not drawn (its stand-in hides with the lamp) and comes back with it', hid && farChild.parent?.visible === true, JSON.stringify({ hid, now: farChild.parent?.visible }));
  live('set', at('farlamp', [3, 0, 0]));
  await settle();
  const farNow = stub.entities.get('farlamp');
  check('…brought within its radius the lamp loads, the emptied stand-in goes, and the child mounts into it at its offset and its OWN scale (not the composed one it waited in), the light where it was composed ([7,2,0])',
    !!farNow?.userData?.lib && farChild.parent === farNow && !stub.scene.children.some((c: any) => c.userData?.standIn === 'farlamp') && jeq(farChild.position.toArray(), [0, 1, 2]) && jeq(farChild.scale.toArray(), [1, 1, 1]) && rq('farlamp-light')?.obj === farChild && jeq(lit('farlamp-light'), [7, 2, 0]),
    JSON.stringify({ lib: farNow?.userData?.lib ?? null, parent: farChild.parent?.userData?.entityId ?? farChild.parent?.type, local: farChild.position.toArray(), scale: farChild.scale.toArray(), lit: lit('farlamp-light') }));
  live('create', { id: 'far2', components: { transform: { pos: [600, 0, 0] }, model: LAMP } });
  live('set', { id: 'lamp-light', component: 'parent', value: { to: 'far2' } });
  const { worldPose } = await import('../shared/hierarchy.js');
  const lampLightNow = stub.entities.get('lamp-light');
  const want = worldPose(S.state.st.entities, 'lamp-light')?.pos.map((x: number) => +x.toFixed(6) + 0);
  check('live: a child re-parented from a standing lamp to a never-loaded one steps off the old lamp and stands at its folded world pose (the door keeps it where it was)',
    stub.entities.get('far2') === null && inStandIn(lampLightNow, 'far2') && jeq(lit('lamp-light'), want),
    JSON.stringify({ parent: lampLightNow?.parent?.userData?.entityId ?? lampLightNow?.parent?.type, lit: lit('lamp-light'), want }));
  live('set', at('far2', [650, 0, 0]));
  check('…and from then on it follows the far lamp, not the old one', jeq(lit('lamp-light'), [want[0] + 50, want[1], want[2]]), JSON.stringify(lit('lamp-light')));
  // review S2: a mounted child's rest pose (userData.base, what a motion's end restores) is LOCAL: deleting a motion
  // from a cup on a turned table left it 10 m off the table, in world coordinates in the table's frame
  live('create', { id: 'loose', model: 'eidoverse/assets/models/cup.glb', components: { transform: { pos: [10, 2, 0] } } });
  await settle();
  live('set', { id: 'loose', component: 'parent', value: { to: 'tbl' } });
  for (const cid of ['tcup', 'tem', 'loose']) {
    const o = stub.entities.get(cid);
    const off = S.state.st.entities[cid]?.parent?.offset?.map((x: number) => +x.toFixed(6) + 0);
    const before = o?.position.toArray();
    live('set', { id: cid, component: 'motion', value: { type: 'spin', degPerSec: 30 } });
    live('delete', { id: cid, component: 'motion' });
    const r6 = (a: number[] | undefined) => a?.map((x) => +x.toFixed(6) + 0);
    check(`review S2: ${cid} on a turned table keeps a LOCAL rest; a motion set and removed leaves it at its offset${cid === 'loose' ? ' (a root parented to it: its old world rest is replaced)' : ''}`,
      o?.parent === stub.entities.get('tbl') && jeq(r6(o.userData.base?.pos), off) && jeq(r6(o.position.toArray()), off) && jeq(r6(before), off),
      JSON.stringify({ parent: o?.parent?.userData?.entityId, base: o?.userData?.base, before, after: o?.position.toArray() }));
  }
  // review S3-4: a waiting carrier under another waiting carrier: stand-ins re-stand down the chain
  live('create', { id: 'far3', components: { transform: { pos: [900, 0, 0] }, model: LAMP } });
  live('create', { id: 'far3-kid', components: { transform: { pos: [0, 2, 0] }, parent: { to: 'far3' }, light: { intensity: 3 } } });
  live('create', { id: 'far4', components: { transform: { pos: [950, 0, 0] }, model: LAMP } });
  const k3 = stub.entities.get('far3-kid');
  const k3before = lit('far3-kid');
  live('set', { id: 'far3', component: 'parent', value: { to: 'far4' } });
  const kAfter = lit('far3-kid');
  live('set', at('far4', [1000, 0, 0]));
  const w3 = worldPose(S.state.st.entities, 'far3-kid')?.pos.map((x: number) => +x.toFixed(6) + 0);
  check('review S3-4: a waiting carrier re-parented under another far lamp keeps its waiting child where the fold has it, and moving the new grand-carrier carries it (stand-ins re-stand down the chain)',
    jeq(k3before, [900, 2, 0]) && jeq(kAfter, [900, 2, 0]) && inStandIn(k3, 'far3') && jeq(w3, [950, 2, 0]) && jeq(lit('far3-kid'), w3), JSON.stringify({ k3before, kAfter, now: lit('far3-kid'), fold: w3 }));
  live('delete', { id: 'far3' });
  check('…and when the carrier is deleted its stand-in goes with it (nothing left at the far lamp)',
    !stub.entities.has('far3-kid') && !stub.scene.children.some((c: any) => c.userData?.standIn === 'far3'), JSON.stringify(stub.scene.children.filter((c: any) => c.userData?.standIn).map((c: any) => c.userData.standIn)));
  check('the realizer reported nothing at any point (no error path was taken)', spy.reports.length === 0, JSON.stringify(spy.reports.map((r: any) => `${r.where}: ${r.e}`)));
}

// ---- 5. the inspector ----------------------------------------------------------
// the protocol port (2026-10-06): editOps plans door requests; what an edit DOES is checked through the real authority on a
// scratch world (tools/protocol/scratchworld.ts). Light-verb lights are gone from the planner (a lamp is a thing with a
// light component), so the "old light-verb light keeps the light verb" checks are dropped.
console.log('\n5. the inspector (shared/editschema.js: reads either spelling, writes new on edit, through the authority)');
{
  const { inspectSchema, editOps, fieldAt } = await import('../shared/editschema.js');
  const { scratchWorld } = await import('./protocol/scratchworld.ts');
  const ed = (ent: any, set: Record<string, unknown>) => editOps(ent, 'x', set);
  const opsOf = (r: any) => JSON.stringify(r.ops);
  // the edit through the door: `x` seeded as `ent`, the ops sent as one request, the view read back
  const door = (ent: any, set: Record<string, unknown>) => { const W = scratchWorld('compwire').seed({ x: ent }); const r = ed(ent, set); const res = W.sendAll(r.ops); return { r, res, after: W.rec('x') }; };
  // every card's fields resolve and are owned once (components-inspector-test's rule)
  const cardsSound = (ent: any) => { const sc = inspectSchema(ent, 'x'); const own = new Map<string, string>(); const bad: string[] = [];
    for (const a of sc.sections.header) own.set(a, 'header');
    for (const sec of sc.sections.list) for (const a of sec.fields) { if (!fieldAt(sc, a)) bad.push(`${sec.title}: ${a} is no field`); if (own.has(a)) bad.push(`${a} owned twice`); own.set(a, sec.title); }
    return bad; };
  const card = (ent: any, type: string, key: string | null = null) => inspectSchema(ent, 'x').sections.list.find((c: any) => c.type === type && c.key === key);

  // a lamp is a thing with a light component — an Empty (one place per thing: the door refuses a light on a model)
  const lamp = { pos: [0, 0, 0], yaw: 0, light: { color: 0xff8800, intensity: 20, important: true }, actor: 'a', ts: 1 };
  const lsch = inspectSchema(lamp, 'x');
  check('a light component shows in the light group (light.* addresses), valued from its bag',
    fieldAt(lsch, 'light.intensity')?.value === 20 && fieldAt(lsch, 'light.color')?.value === 0xff8800 && fieldAt(lsch, 'light.range')?.value === 10 && fieldAt(lsch, 'light.important')?.value === true, JSON.stringify(lsch.groups.find((g: any) => g.group === 'light')));
  const le = door(lamp, { 'light.intensity': 24, 'light.important': false, 'light.daytime': true, 'light.color': '#00ff00' });
  check('…editing it writes ONE set light, merged into the bag, important/daytime stored only when not default (daytime: full is burns-at-noon: shape audit 10-16)',
    opsOf(le.r) === JSON.stringify([{ verb: 'set', args: { id: 'x', component: 'light', value: { color: 0x00ff00, intensity: 24, daytime: 'full' } } }]), opsOf(le.r));
  check('…and through the door the lamp is lit that way (important cleared, burns at noon)', le.res.ok && le.after.light.color === 0x00ff00 && le.after.light.intensity === 24 && le.after.light.daytime === 'full' && !le.after.light.important, JSON.stringify([le.res.refused, le.after.comp]));
  // a lamp translated from v1 can carry a key the authority's light schema doesn't know (v1 accepted unknown keys; the
  // translator keeps them). The planner keeps it in the bag (it never drops what it doesn't understand)…
  const odd = { ...lamp, light: { ...lamp.light, flicker: 1 } };
  const oe = ed(odd, { 'light.intensity': 24 });
  check('…unknown keys in the bag are kept by the planner (flicker rides along)', JSON.parse(opsOf(oe))[0]?.args.value.flicker === 1, opsOf(oe));
  // KNOWN BUG (reported 2026-10-06; door/translator, not the planner): …but the door's light schema is closed, so it
  // refuses that edit whole ("x.light: unknown key 'flicker'"): a translated lamp with an unknown light key can't be
  // edited at all now. Translation keeps such keys (shown first), so these lamps exist.
  { const { translate } = await import('./protocol/import-v1/translate-v1.js'); const { v1FoldBuild } = await import('./protocol/import-v1/build.ts');
    const tr = translate([{ seq: 0, ts: 1, actor: 'world', verb: 'genesis', args: { v: 2, dialect: 'eidoverse-log' } }, { seq: 1, ts: 2, actor: 'r', verb: 'spawn', args: { id: 'x', lib: LAMP } },
      { seq: 2, ts: 3, actor: 'r', verb: 'comp', args: { id: 'x', type: 'light', data: odd.light } }], { foldBuild: v1FoldBuild() });
    // the translator now carries a key the component doesn't define BESIDE it (imported:light {flicker}), so the lamp
    // itself is an ordinary lamp: the planner's edit of it goes through the closed door
    const tx = tr.final.translated.x;
    check('…(a v1 lamp with flicker translates with flicker carried as imported:light {flicker}, not inside light)', tx?.['imported:light']?.flicker === 1 && !('flicker' in (tx?.light ?? {})), JSON.stringify(tx));
    const tlamp = { ...lamp, ...lamp.comp, light: tx.light };
    const W = scratchWorld('compwire').seed({ x: tlamp });
    const sent = W.sendAll(ed(tlamp, { 'light.intensity': 24 }).ops);
    check('…and the door takes the planner\'s edit of such a (translated) lamp', sent.ok, JSON.stringify(sent.refused)); }
  check('…a value the door would refuse is refused here first, with the door\'s words', (() => { const r = ed(lamp, { 'light.color': 'zz' }); return r.ops.length === 0 && /light\.color: a colour/.test(r.errors[0] ?? ''); })(), JSON.stringify(ed(lamp, { 'light.color': 'zz' })));
  const rl = door(lamp, { 'remove.light': null });
  check('…its card is removable and remove.light writes delete light; through the door it is dark', card(lamp, 'Light', 'light')?.removable === true
    && opsOf(rl.r) === JSON.stringify([{ verb: 'delete', args: { id: 'x', component: 'light' } }]) && rl.res.ok && rl.after?.light === undefined, JSON.stringify([rl.r.ops, rl.res.refused]));
  check('…and it is not shown a second time as raw JSON in Components', !fieldAt(lsch, 'comp.light'));

  const empty = { pos: [1, 2, 3], yaw: 0, actor: 'a', ts: 1 };
  const esch = inspectSchema(empty, 'x');
  check('an Empty: a Transform card with yaw and scale, no Model card (and a root\'s quiet, empty Parent card, R 10-04)', !!fieldAt(esch, 'pos.yaw') && !!fieldAt(esch, 'pos.scale') && !card(empty, 'Model')
    && JSON.stringify(esch.sections.list.map((c: any) => c.type)) === '["Transform","Parent"]' && esch.sections.list[1].present === false, JSON.stringify(esch.sections.list.map((c: any) => [c.type, c.present])));
  check('…Add Component offers Light (unblocked) and not Collider (it needs a model)',
    esch.sections.add.some((a: any) => a.name === 'Light' && !a.blocked) && !esch.sections.add.some((a: any) => a.name === 'Collider' && !a.blocked), JSON.stringify(esch.sections.add.map((a: any) => `${a.name}${a.blocked ? '(blocked)' : ''}`)));
  const al = door(empty, { 'add.Light': null });
  check('…add.Light writes set light with the fields spelled out (the log records the result, not a default)',
    opsOf(al.r) === JSON.stringify([{ verb: 'set', args: { id: 'x', component: 'light', value: { color: 0xffd9a0, intensity: 25.93, range: 10 } } }]), opsOf(al.r));
  check('…and through the door the Empty is a lamp with exactly those values', al.res.ok && al.after?.light?.color === 0xffd9a0 && al.after.light.intensity === 25.93 && al.after.light.range === 10 && al.after.model === undefined, JSON.stringify([al.res.refused, al.after]));
  check('…add.Collider is refused with a reason', (() => { const r = ed(empty, { 'add.Collider': null }); return r.ops.length === 0 && /needs a model/.test(r.errors[0] ?? ''); })());
  check('add.Light on a thing that already has a light is refused', (() => { const r = ed(lamp, { 'add.Light': null }); return r.ops.length === 0 && /already has a light/.test(r.errors[0] ?? ''); })());

  const oldCol = { model: LAMP, pos: [0, 0, 0], yaw: 0, collide: 'exact', actor: 'a', ts: 1 };
  const oc = ed(oldCol, { 'collider.shape': 'box' });
  check('a legacy spawn collide shows as the collider group; editing it writes the collider COMPONENT (write-new-on-edit)',
    fieldAt(inspectSchema(oldCol, 'x'), 'collider.shape')?.value === 'exact' && opsOf(oc) === JSON.stringify([{ verb: 'set', args: { id: 'x', component: 'collider', value: { shape: 'box' } } }]), opsOf(oc));
  check('…its legacy card is not removable (only a spawn writes collide)', card(oldCol, 'Collider')?.removable === false);
  const both = { ...oldCol, collider: { shape: 'box' } };
  check('with both spellings the component owns the group, the legacy card says it is overridden, nothing is owned twice',
    fieldAt(inspectSchema(both, 'x'), 'collider.shape')?.value === 'box' && card(both, 'Collider', 'collider')?.fields.includes('collider.shape')
    && /overridden/.test(JSON.stringify(card(both, 'Collider')?.info)) && cardsSound(both).length === 0, JSON.stringify(cardsSound(both)));
  check('collider.shape must be mesh, box or sphere (shape audit 10-16: mesh was exact)', (() => { const r = ed(both, { 'collider.shape': 'triangles' }); return r.ops.length === 0 && /mesh.*box/.test(r.errors[0] ?? ''); })());
  const ac = door({ model: LAMP, pos: [0, 0, 0] }, { 'add.Collider': 'box' });
  check('add.Collider on a model writes set collider (default mesh; "box" when asked), and the door writes it',
    opsOf(ac.r) === JSON.stringify([{ verb: 'set', args: { id: 'x', component: 'collider', value: { shape: 'box' } } }])
    && opsOf(ed({ model: LAMP, pos: [0, 0, 0] }, { 'add.Collider': null })) === JSON.stringify([{ verb: 'set', args: { id: 'x', component: 'collider', value: { shape: 'mesh' } } }])
    && ac.res.ok && ac.after?.collider?.shape === 'box', JSON.stringify([ac.r.ops, ac.res.refused]));
  check('the raw-JSON door obeys the door\'s rules too (comp.light with a string colour)', ed(lamp, { 'comp.light': '{"color":"red"}' }).ops.length === 0);
  check('every card sound on the lamp, the Empty and the legacy-collide model', [lamp, empty, oldCol].every((e) => cardsSound(e).length === 0), JSON.stringify([lamp, empty, oldCol].map(cardsSound)));
}

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
