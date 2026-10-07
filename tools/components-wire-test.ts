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
    pivot: { pos: [1, 2, 3], yaw: 0.5, comp: { light: { important: true, intensity: 30 } } },
    lamp: { lib: LAMP, pos: [2, 0, 0], comp: { light: { color: 0xff8800, range: 7, day: false }, collider: { shape: 'box' } } },
    crate: { lib: 'eidoverse/assets/models/crate.glb', pos: [4, 0, 0], comp: { collider: { shape: 'box' } } },
    plain: { lib: 'eidoverse/assets/models/plain.glb', pos: [6, 0, 0] },
    farlamp: { lib: LAMP, pos: [600, 0, 0], comp: { light: { intensity: 5 } } },
    cup: { lib: 'eidoverse/assets/models/cup.glb', pos: [0, 0, 0], parent: { to: 'pivot', offset: [0, 0.5, 0] } },
  });
  M.initModelsRealizer();
  S.hydrate(structuredClone(W.view()));
  await settle();
  /** one door write, then the view a client folds from it */
  const live = (tool: string, args: any) => { const r = W.call(tool, args); if (!r.ok) throw new Error(`${tool} ${JSON.stringify(args)} refused: ${JSON.stringify(r.refused)}`); S.applyView(structuredClone(W.view())); return r; };
  const at = (id: string, pos: number[]) => ({ id, component: 'transform', value: { pos }, merge: true });

  const piv = stub.entities.get('pivot');
  check('an Empty realizes at once as an invisible Group at its folded transform', !!piv && piv.isGroup && piv.userData.empty === true
    && jeq(piv.position.toArray().map((x: number) => +x.toFixed(9)), [1, 2, 3]) && Math.abs(piv.rotation.y - 0.5) < 1e-9, `${piv?.type} ${JSON.stringify(piv?.position)}`);
  check('…loads nothing (no asset request names it) and is listed with kind "empty"',
    !stub.loads.some((l: any) => l.lib == null || l.lib === 'undefined') && stub.entityMeta.get('pivot')?.kind === 'empty', JSON.stringify(stub.loads.map((l: any) => l.lib)));
  check('…and owns no collider', !stub.colliderLog.some((e: any) => e[1] === 'pivot'), JSON.stringify(stub.colliderLog));
  const cup = stub.entities.get('cup');
  check('a model parented to an Empty rides it (parented into the Empty\'s Group at its offset)', !!cup && cup.parent === piv && jeq(cup.position.toArray().map((x: number) => +x.toFixed(9)), [0, 0.5, 0]), `${cup?.parent?.type} ${JSON.stringify(cup?.position)}`);

  const rq = (id: string) => stub.lightRequests.get(`complight:${id}`);
  check('the light component on the Empty becomes a rig request that follows the Empty\'s object, with its fields and the defaults',
    rq('pivot')?.obj === piv && rq('pivot').keep === true && rq('pivot').intensity === 30 && rq('pivot').range === 10 && rq('pivot').color === 0xffd9a0 && rq('pivot').dayAware === true && rq('pivot').authored === true, JSON.stringify({ ...rq('pivot'), obj: !!rq('pivot')?.obj }));
  check('…and its gizmo is a child of the Empty (a bare bulb is seen, and selectable)', piv?.children.some((c: any) => c.userData.gizmo), JSON.stringify(piv?.children.map((c: any) => c.type)));
  const lamp = stub.entities.get('lamp');
  check('a lamp (Model + light component): the request follows the REALIZED model, day:false → not day-aware',
    !!lamp && !!lamp.userData.lib && rq('lamp')?.obj === lamp && rq('lamp').color === 0xff8800 && rq('lamp').range === 7 && rq('lamp').dayAware === false, JSON.stringify({ ...rq('lamp'), obj: rq('lamp')?.obj?.userData }));
  let lampGizmo = false; lamp?.traverse((o: any) => { if (o.userData?.gizmo) lampGizmo = true; });
  check('…with NO gizmo mesh inside the model (it would join the collider, the lamp scan, the caster scan)', !lampGizmo);
  check('a far lamp (beyond its residency radius, never loaded) still lights: the request parks at the folded position',
    stub.entities.get('farlamp') === null && rq('farlamp')?.obj === null && jeq(rq('farlamp')?.pos, [600, 0, 0]) && rq('farlamp').intensity === 5, JSON.stringify(rq('farlamp')));

  // authored beats inferred (design §3): a Light component suppresses the model's inferred lamps
  const lamps = (id: string) => stub.lampOwners.get(`entity:${id}`) ?? 0;
  check('a lamp (Model + light component) lands WITHOUT inferred lamps — the authored light alone lights it', !!lamp?.userData?.lib && lamps('lamp') === 0,
    JSON.stringify(stub.lampLog.filter((e: any) => e[1] === 'entity:lamp')));
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
  check('live: moving a never-loaded lamp moves its parked light', jeq(rq('farlamp')?.pos, [700, 0, 0]), JSON.stringify(rq('farlamp')?.pos));
  const marks = stub.colliderLog.length;
  live('set', { id: 'lamp', component: 'collider', value: { shape: 'exact' } });
  check('live: a changed collider component re-decides the standing collider under the new shape',
    stub.colliders.get('lamp')?.pref === 'exact' && stub.colliderLog.slice(marks).some((e: any) => e[0] === 'refit' && e[1] === 'lamp'), JSON.stringify(stub.colliderLog.slice(marks)));
  live('set', { id: 'plain', component: 'light', value: { intensity: 9 } });
  check('live: a Light component added to a STANDING model releases its inferred lamps (and casts its own)',
    lamps('plain') === 0 && stub.lampLog.at(-1)?.[0] === 'release' && stub.lampLog.at(-1)?.[1] === 'entity:plain' && rq('plain')?.intensity === 9, JSON.stringify(stub.lampLog.slice(-3)));
  live('set', { id: 'plain', component: 'light', value: { intensity: 12 } });
  check('…changing that light touches no lamps', lamps('plain') === 0 && stub.lampLog.at(-1)?.[1] === 'entity:plain' && stub.lampLog.at(-1)?.[0] === 'release' && rq('plain')?.intensity === 12);
  live('delete', { id: 'plain', component: 'light' });
  check('…removing it re-infers the lamps, once', lamps('plain') === 1 && !rq('plain'), JSON.stringify(stub.lampLog.slice(-3)));
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
  const plan = planReconcile({ a: { pos: [0, 0, 0] }, b: { lib: LAMP, pos: [0, 0, 0] }, c: { kind: 'light', pos: [0, 1, 0] } },
    new Map([['a', { kind: 'empty' }], ['b', { kind: 'model', lib: LAMP }], ['c', { kind: 'light' }]]));
  check('reconcile (rejoin) leaves a standing Empty alone — no retire-and-rebuild churn', plan.create.length === 0 && plan.retire.length === 0, JSON.stringify(plan));
  const plan2 = planReconcile({ a: { lib: LAMP, pos: [0, 0, 0] } }, new Map([['a', { kind: 'empty' }]]));
  check('…but an Empty whose id now folds as a model is rebuilt', plan2.retire[0] === 'a' && plan2.create[0]?.id === 'a', JSON.stringify(plan2));
  check('kindOf: light / empty / model', kindOf({ kind: 'light' }) === 'light' && kindOf({ pos: [0, 0, 0] }) === 'empty' && kindOf({ lib: LAMP }) === 'model');
  const { bus } = await import('../client/lib/base.js');
  const marker = (g: any) => !!g?.children.some((c: any) => c.userData?.emptyMarker);
  check('outside edit mode an Empty carries no marker (nothing to hit that nobody can see)', !marker(piv));
  bus.emit('edit-mode', true);
  live('create', { id: 'e3', components: { transform: { pos: [0, 0, 15] } } });
  check('edit mode on: every Empty wears a pickable marker, including one created while editing', marker(piv) && marker(stub.entities.get('e3')));
  bus.emit('edit-mode', false);
  check('edit mode off: the markers come off again', !marker(piv) && !marker(stub.entities.get('e3')));
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

  const lamp = { lib: LAMP, pos: [0, 0, 0], yaw: 0, comp: { light: { color: 0xff8800, intensity: 20, important: true } }, actor: 'a', ts: 1 };
  const lsch = inspectSchema(lamp, 'x');
  check('a light component shows in the light group (light.* addresses), valued from its bag',
    fieldAt(lsch, 'light.intensity')?.value === 20 && fieldAt(lsch, 'light.color')?.value === 0xff8800 && fieldAt(lsch, 'light.range')?.value === 10 && fieldAt(lsch, 'light.important')?.value === true, JSON.stringify(lsch.groups.find((g: any) => g.group === 'light')));
  const le = door(lamp, { 'light.intensity': 24, 'light.important': false, 'light.noon': true, 'light.color': '#00ff00' });
  check('…editing it writes ONE set light, merged into the bag, important/day stored only when not default',
    opsOf(le.r) === JSON.stringify([{ verb: 'set', args: { id: 'x', component: 'light', value: { color: 0x00ff00, intensity: 24, day: false } } }]), opsOf(le.r));
  check('…and through the door the lamp is lit that way (important cleared, burns at noon)', le.res.ok && le.after.comp.light.color === 0x00ff00 && le.after.comp.light.intensity === 24 && le.after.comp.light.day === false && !le.after.comp.light.important, JSON.stringify([le.res.refused, le.after.comp]));
  // a lamp translated from v1 can carry a key the authority's light schema doesn't know (v1 accepted unknown keys; the
  // translator keeps them). The planner keeps it in the bag (it never drops what it doesn't understand)…
  const odd = { ...lamp, comp: { light: { ...lamp.comp.light, flicker: 1 } } };
  const oe = ed(odd, { 'light.intensity': 24 });
  check('…unknown keys in the bag are kept by the planner (flicker rides along)', JSON.parse(opsOf(oe))[0]?.args.value.flicker === 1, opsOf(oe));
  // KNOWN BUG (reported 2026-10-06; door/translator, not the planner): …but the door's light schema is closed, so it
  // refuses that edit whole ("x.light: unknown key 'flicker'"): a translated lamp with an unknown light key can't be
  // edited at all now. Translation keeps such keys (shown first), so these lamps exist.
  { const { translate } = await import('./protocol/import-v1/translate-v1.js'); const { v1FoldBuild } = await import('./protocol/import-v1/build.ts');
    const tr = translate([{ seq: 0, ts: 1, actor: 'world', verb: 'genesis', args: { v: 2, dialect: 'eidoverse-log' } }, { seq: 1, ts: 2, actor: 'r', verb: 'spawn', args: { id: 'x', lib: LAMP } },
      { seq: 2, ts: 3, actor: 'r', verb: 'comp', args: { id: 'x', type: 'light', data: odd.comp.light } }], { foldBuild: v1FoldBuild() });
    // the translator now carries a key the component doesn't define BESIDE it (imported:light {flicker}), so the lamp
    // itself is an ordinary lamp: the planner's edit of it goes through the closed door
    const tx = tr.final.translated.x;
    check('…(a v1 lamp with flicker translates with flicker carried as imported:light {flicker}, not inside light)', tx?.['imported:light']?.flicker === 1 && !('flicker' in (tx?.light ?? {})), JSON.stringify(tx));
    const tlamp = { ...lamp, comp: { ...lamp.comp, light: tx.light } };
    const W = scratchWorld('compwire').seed({ x: tlamp });
    const sent = W.sendAll(ed(tlamp, { 'light.intensity': 24 }).ops);
    check('…and the door takes the planner\'s edit of such a (translated) lamp', sent.ok, JSON.stringify(sent.refused)); }
  check('…a value the door would refuse is refused here first, with the door\'s words', (() => { const r = ed(lamp, { 'light.color': 'zz' }); return r.ops.length === 0 && /light: light color/.test(r.errors[0] ?? ''); })(), JSON.stringify(ed(lamp, { 'light.color': 'zz' })));
  const rl = door(lamp, { 'remove.light': null });
  check('…its card is removable and remove.light writes delete light; through the door it is dark', card(lamp, 'Light', 'light')?.removable === true
    && opsOf(rl.r) === JSON.stringify([{ verb: 'delete', args: { id: 'x', component: 'light' } }]) && rl.res.ok && rl.after.comp?.light === undefined, JSON.stringify([rl.r.ops, rl.res.refused]));
  check('…and it is not shown a second time as raw JSON in Components', !fieldAt(lsch, 'comp.light'));

  const empty = { pos: [1, 2, 3], yaw: 0, actor: 'a', ts: 1 };
  const esch = inspectSchema(empty, 'x');
  check('an Empty: a Transform card with yaw and scale, no Model card (and a root\'s quiet, empty Parent card, R 10-04)', !!fieldAt(esch, 'pos.yaw') && !!fieldAt(esch, 'pos.scale') && !card(empty, 'Model')
    && JSON.stringify(esch.sections.list.map((c: any) => c.type)) === '["Transform","Parent"]' && esch.sections.list[1].present === false, JSON.stringify(esch.sections.list.map((c: any) => [c.type, c.present])));
  check('…Add Component offers Light (unblocked) and not Collider (it needs a model)',
    esch.sections.add.some((a: any) => a.name === 'Light' && !a.blocked) && !esch.sections.add.some((a: any) => a.name === 'Collider' && !a.blocked), JSON.stringify(esch.sections.add.map((a: any) => `${a.name}${a.blocked ? '(blocked)' : ''}`)));
  const al = door(empty, { 'add.Light': null });
  check('…add.Light writes set light with the fields spelled out (the log records the result, not a default)',
    opsOf(al.r) === JSON.stringify([{ verb: 'set', args: { id: 'x', component: 'light', value: { color: 0xffd9a0, intensity: 16, range: 10 } } }]), opsOf(al.r));
  check('…and through the door the Empty is a lamp with exactly those values', al.res.ok && al.after.comp?.light?.color === 0xffd9a0 && al.after.comp.light.intensity === 16 && al.after.comp.light.range === 10 && al.after.lib === undefined, JSON.stringify([al.res.refused, al.after]));
  check('…add.Collider is refused with a reason', (() => { const r = ed(empty, { 'add.Collider': null }); return r.ops.length === 0 && /needs a model/.test(r.errors[0] ?? ''); })());
  check('add.Light on a thing that already has a light is refused', (() => { const r = ed(lamp, { 'add.Light': null }); return r.ops.length === 0 && /already has a light/.test(r.errors[0] ?? ''); })());

  const oldCol = { lib: LAMP, pos: [0, 0, 0], yaw: 0, collide: 'exact', actor: 'a', ts: 1 };
  const oc = ed(oldCol, { 'collider.shape': 'box' });
  check('a legacy spawn collide shows as the collider group; editing it writes the collider COMPONENT (write-new-on-edit)',
    fieldAt(inspectSchema(oldCol, 'x'), 'collider.shape')?.value === 'exact' && opsOf(oc) === JSON.stringify([{ verb: 'set', args: { id: 'x', component: 'collider', value: { shape: 'box' } } }]), opsOf(oc));
  check('…its legacy card is not removable (only a spawn writes collide)', card(oldCol, 'Collider')?.removable === false);
  const both = { ...oldCol, comp: { collider: { shape: 'box' } } };
  check('with both spellings the component owns the group, the legacy card says it is overridden, nothing is owned twice',
    fieldAt(inspectSchema(both, 'x'), 'collider.shape')?.value === 'box' && card(both, 'Collider', 'collider')?.fields.includes('collider.shape')
    && /overridden/.test(JSON.stringify(card(both, 'Collider')?.info)) && cardsSound(both).length === 0, JSON.stringify(cardsSound(both)));
  check('collider.shape must be exact or box', (() => { const r = ed(both, { 'collider.shape': 'mesh' }); return r.ops.length === 0 && /exact.*box/.test(r.errors[0] ?? ''); })());
  const ac = door({ lib: LAMP, pos: [0, 0, 0] }, { 'add.Collider': 'box' });
  check('add.Collider on a model writes set collider (default exact; "box" when asked), and the door writes it',
    opsOf(ac.r) === JSON.stringify([{ verb: 'set', args: { id: 'x', component: 'collider', value: { shape: 'box' } } }])
    && opsOf(ed({ lib: LAMP, pos: [0, 0, 0] }, { 'add.Collider': null })) === JSON.stringify([{ verb: 'set', args: { id: 'x', component: 'collider', value: { shape: 'exact' } } }])
    && ac.res.ok && ac.after.comp?.collider?.shape === 'box', JSON.stringify([ac.r.ops, ac.res.refused]));
  check('the raw-JSON door obeys the door\'s rules too (comp.light with a string colour)', ed(lamp, { 'comp.light': '{"color":"red"}' }).ops.length === 0);
  check('every card sound on the lamp, the Empty and the legacy-collide model', [lamp, empty, oldCol].every((e) => cardsSound(e).length === 0), JSON.stringify([lamp, empty, oldCol].map(cardsSound)));
}

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
