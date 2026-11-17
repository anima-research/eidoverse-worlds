// blueprint-test — blueprints (spec/PROTOCOL.md §4.1) through the authority and the agent.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/shared/blueprint-test.ts
//
// 6. the door's publish (@world blueprints:<hash>) and create {from: <hash>, at} on a scratch world
//    (test/harness/scratchworld.ts): the record, the copy's tree, its local poses, one act, the door's undo
// 7. the agent's blueprints / create {from} / look() over the library, its door the scratch door
//
// (Sections 1–3, the v1 record API's pure functions, went with it: no runtime caller; 4, 5, 8 went with protocol v1.)
import { noWorldUrl } from '../harness/no-world.ts';
import "../harness/fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspectSchema, fieldAt } from "../../shared/editschema.js";
import { suite } from "../gate/suite.ts";
// config.ts makes WORLDS_DIR at import: keep the bench out of the repo's worlds/
const SCRATCH = mkdtempSync(join(tmpdir(), 'ew-blueprint-'));
process.env.WORLDS_DIR = join(SCRATCH, 'worlds');

const S = suite("blueprint");
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);
const J = JSON.stringify;
// a copy's parts are minted (R 10-17: opaque ids, never <copy>-<key>): the part with record key `key` under copy `copy`
const partOf = (E: any, copy: string, key: string) => Object.keys(E).find((x) => { if (E[x]?.['copy-of']?.key !== key) return false; for (let p: any = x, n = 0; p && n < 64; p = E[p]?.parent?.to, n++) if (p === copy) return true; return false; }) ?? `${copy}-${key}`;

const LAMP = 'eidoverse/assets/models/lamp.glb';
// ---- 6. the door's publish and create {from} ------------------------------------------
console.log('\n6. publish → @world blueprints:<hash>; create {from: hash, at} → the copy (the real door, a scratch world)');
const { scratchWorld } = await import('../harness/scratchworld.ts');
const { worldPose } = await import('../../shared/hierarchy.js');
const { qFromYaw, qNorm } = await import('../../shared/rot.js');
const near = (a: number[], b: number[], e = 2e-3) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= e);
const lampWorld = () => {
  const W = scratchWorld('blueprint');
  W.call('set', { id: '@world', component: 'roles:bld', value: { role: 'builder' } });
  W.call('set', { id: '@world', component: 'roles:vis', value: { role: 'member' } });
  // a lamp: a model with a label, and a bulb child (an Empty with its own light) 1.2 m up: the LIGHT lives on the bulb.
  W.seed({
    lamp: { model: LAMP, pos: [7, 0, 7], yaw: 1, label: 'a lamp' },
    bulb: { pos: [0, 0, 0], parent: { to: 'lamp', offset: [0, 1.2, 0], yaw: 0 }, light: { color: 0xffffff, intensity: 4, range: 3 } },
  });
  return W;
};
const libOf = (W: any) => Object.fromEntries(Object.entries(W.state().entities['@world'].c).filter(([k]) => k.startsWith('blueprints:')).map(([k, v]) => [k.slice('blueprints:'.length), v]));
let HV = '';   // the record's hash, "sha256:<hex>"
{
  const W = lampWorld();
  const vis = W.call('publish', { from: 'lamp', name: 'Lamp' }, 'vis');
  check('a member may not publish (rank)', vis.ok === false && vis.refused?.code === 'rights', J(vis));
  const r = W.call('publish', { from: 'lamp', name: 'Lamp' }, 'bld');
  HV = r.notes?.find((n: any) => n.record)?.record ?? '';
  const hex = HV.replace(/^sha256:/, '');
  check('publish {from, name}: one act, the record\'s hash in its notes, the blueprints entry @world blueprints:<hex> = {name, parts}', r.ok && /^sha256:[0-9a-f]{64}$/.test(HV) && J(libOf(W)[hex]) === J({ name: 'Lamp', parts: 2 }), J([r.refused, r.notes, libOf(W)]));
  const rec = W.getBlob(HV);
  check('the record: the thing and what is attached, root at the origin (its place is the copy\'s), parts keyed, the publisher named',
    rec.name === 'Lamp' && rec.root === 'lamp' && rec.by === 'bld' && J(rec.parts.map((p: any) => p.key)) === J(['lamp', 'bulb'])
    && J(rec.parts[0].components.transform.pos) === J([0, 0, 0]) && !rec.parts[0].components.parent && rec.parts[1].components.parent?.to === 'lamp'
    && near(rec.parts[1].components.transform.pos, [0, 1.2, 0], 0) && rec.parts[0].components.label === 'a lamp' && rec.parts[1].components.light.intensity === 4, J(rec));
  check('…the world is untouched by publishing (the lamp stays where it stands)', near(W.rec('lamp').pos, [7, 0, 7], 0) && W.rec('bulb').parent?.to === 'lamp');
  const again = W.call('publish', { from: 'lamp', name: 'Lamp' }, 'bld');
  check('content-addressed: the same publisher re-publishing the same thing gets the same hash', again.ok && again.notes?.find((n: any) => n.record)?.record === HV, J(again.notes));
  W.call('set', { id: 'bulb', component: 'light', value: { color: 0xffffff, intensity: 24, range: 3 } }, 'bld');
  const v2 = W.call('publish', { from: 'lamp', name: 'Lamp' }, 'bld');
  const H2v = v2.notes?.find((n: any) => n.record)?.record;
  check('…meaning moves it: a brighter lamp is a new record beside the first (nothing replaced)', v2.ok && H2v !== HV && Object.keys(libOf(W)).length === 2, J(libOf(W)));

  // place a copy: create {from: hash, at}
  const at = { pos: [3, 0, 4], q: qFromYaw(0.5) };
  const c1 = W.call('create', { id: 'lamp-1', from: HV, at }, 'bld');
  const E = () => W.view().entities;
  check('create {id, from: hash, at}: one act, the copy\'s parts minted under it (found by their copy-of key)', c1.ok && !!E()['lamp-1'] && !!E()[partOf(E(), 'lamp-1', 'bulb')], J([c1.refused, Object.keys(E())]));
  const root = E()['lamp-1'], bulb = E()[partOf(E(), 'lamp-1', 'bulb')];
  check('…the root at `at` (pos and turn) with its model and label; the bulb an Empty with its light',
    root.model === LAMP && near(root.pos, [3, 0, 4], 0) && Math.abs(root.yaw - 0.5) < 1e-6 && root?.light === undefined && root?.label === 'a lamp'
    && bulb.model === undefined && bulb?.light?.range === 3, J({ root, bulb }));
  check('…the bulb rides the copy\'s root at its LOCAL pose (as the record says)', bulb.parent?.to === 'lamp-1' && near(bulb.pos, [0, 1.2, 0], 0), J(bulb));
  const Wb = worldPose(E(), partOf(E(), 'lamp-1', 'bulb'))!;
  check('…so its world pose is the root\'s pose composed with it: [3, 1.2, 4]', near(Wb.pos, [3, 1.2, 4]), J(Wb));
  check('…every part carries the link: copy-of {from: hash, key}', J(root?.['copy-of']) === J({ from: HV, key: 'lamp' }) && J(bulb?.['copy-of']) === J({ from: HV, key: 'bulb' }), J([root?.['copy-of'], bulb?.['copy-of']]));
  const c2 = W.call('create', { id: 'lamp-1', from: HV, at }, 'bld');
  check('an id in use is refused (`exists`), nothing written', c2.ok === false && c2.refused?.code === 'exists', J(c2));
  const c3 = W.call('create', { from: 'sha256:' + '0'.repeat(64) }, 'bld');
  check('a hash with no record is refused', c3.ok === false && ['not-found', 'not-published'].includes(c3.refused?.code), J(c3));
  const W2 = scratchWorld('blueprint');
  const c4 = W2.call('create', { from: HV });
  check('a record that isn\'t one of THIS world\'s blueprints is refused (publish it here first)', c4.ok === false && ['not-published', 'not-found'].includes(c4.refused?.code), J(c4));
  const u = W.call('undo', {}, 'bld');
  check('one undo (the door\'s, of the create) takes the whole copy away', u.ok && !E()['lamp-1'] && !E()[partOf(E(), 'lamp-1', 'bulb')] && !!E().lamp, J([u.refused, Object.keys(E())]));
  // a copy edited for itself is just a thing (the link stays): editing it never touches the record or other copies
  W.call('create', { id: 'lamp-2', from: HV, at: { pos: [0, 0, 0] } }, 'bld');
  W.call('create', { id: 'lamp-3', from: HV, at: { pos: [2, 0, 0] } }, 'bld');
  W.call('set', { id: partOf(W.view().entities, 'lamp-2', 'bulb'), component: 'light', value: { color: 0xffffff, intensity: 2, range: 3 } }, 'bld');
  check('an edit to one copy\'s part changes that copy only, and the record stays as published', E()[partOf(E(), 'lamp-2', 'bulb')].light.intensity === 2 && E()[partOf(E(), 'lamp-3', 'bulb')].light.intensity === 4 && W.getBlob(HV).parts[1].components.light.intensity === 4);
}
{
  // a deeper design: a scaled base with a box collider, a tilted half-scale arm, a locked shade with a spin, and a glow
  // (an Empty with a light that burns at noon). No rotation order rides any part: it is the viewer's (PROTOCOL §9.1)
  const W = scratchWorld('blueprint');
  const tilt = [0.3826834323650898, 0, 0, 0.9238795325112867];
  W.seed({
    desk: { model: LAMP, pos: [50, 0, 50], scale: 2, collider: { shape: 'box' } },
    arm: { model: LAMP, parent: { to: 'desk', offset: [0.2, 0.5, 0], q: tilt }, scale: 0.5 },
    shade: { model: LAMP, parent: { to: 'arm', offset: [0, 1, 0] }, motion: { type: 'spin', axis: 'y', degPerSec: 20 }, lock: true },
    glow: { parent: { to: 'shade', offset: [0, -0.1, 0] }, light: { color: 0xff8800, intensity: 6, range: 4, daytime: 'full' } },
  });
  const p = W.call('publish', { from: 'desk', name: 'Desk' });
  const HD = p.notes?.find((n: any) => n.record)?.record;
  check('the deep design publishes (4 parts, the locked shade included)', p.ok && J(libOf(W)[String(HD).slice(7)]) === J({ name: 'Desk', parts: 4 }), J([p.refused, libOf(W)]));
  const yaw90 = [0, 0.7071067811865476, 0, 0.7071067811865476];
  const c = W.call('create', { id: 'desk2', from: HD, at: { pos: [10, 0, -2], q: yaw90 } });
  const E = W.view().entities;
  const id = (k: string) => { const x = partOf(E, 'desk2', k); return E[x]?.['copy-of']?.from === HD ? x : undefined; };
  check('the copy lands as one act: four parts', c.ok && ['desk', 'arm', 'shade', 'glow'].every((k) => !!id(k)), J([c.refused, Object.keys(E)]));
  const arm = worldPose(E, id('arm')!)!;
  check('the tilted arm (root turned 90°, root scale 2; local offset, tilt and scale ½) stands at its composed pose: [10, 1, -2.4], scale 1, tilted',
    near(arm.pos, [10, 1, -2.4]) && Math.abs(arm.scale - 1) < 1e-6 && Math.abs(E[id('arm')!].q[0]) > 0.1, J(arm));
  const shade = E[id('shade')!], glow = E[id('glow')!];
  check('the shade is locked (lock is a bool again: recut C11), spins, and carries no rotation order (the order is the viewer\'s)',
    shade?.lock === true && shade?.motion?.type === 'spin' && !Object.keys(shade ?? {}).some((k) => /rot-?order|726f744f72646572/i.test(k)), J(shade));
  // the viewer's order stays on the viewer: the editor reads the copy in whatever order this viewer chose, and placing
  // the copy wrote none (PROTOCOL §9.1; client/lib/edit/viewprefs.js keeps it)
  check('…and a viewer reading the copy in ZXY reads it in ZXY, from its own settings', fieldAt(inspectSchema(shade, id('shade')!, { rotOrder: 'ZXY' }), 'rot.order')?.value === 'ZXY'
    && fieldAt(inspectSchema(shade, id('shade')!), 'rot.order')?.value === 'XYZ');
  check('the glow is an Empty whose light burns at noon; the base collides as a box', glow.model === undefined && glow?.light?.daytime === 'full' && glow.light.color === 0xff8800 && E.desk2?.collider?.shape === 'box', J([glow, E.desk2.comp]));
  // a lock binds removal (§5), and undoing a create removes: the door refuses the bare undo `locked` (v1's inverses
  // unlocked first). The person is asked "Move anyway?" (edit/writes.js: undo offers through, not unlock); throughLock takes it.
  const u0 = W.call('undo', {});
  check('a bare undo of the copy is refused `locked` (its shade is locked), and nothing is removed', u0.ok === false && u0.refused?.code === 'locked' && ['desk', 'arm', 'shade', 'glow'].every((k) => !!W.view().entities[partOf(W.view().entities, 'desk2', k)]), J(u0));
  const u = W.call('undo', { throughLock: true });
  check('…throughLock: one undo takes the whole deep copy away, its locked part included', u.ok && !Object.values(W.view().entities).some((e: any) => e?.['copy-of']?.from === HD), J([u.refused, Object.keys(W.view().entities)]));
}

// ---- 7. the agent's tools over the library ------------------------------------------------
console.log('\n7. the text tier — blueprints, create {from}, look() (mcpl), the agent\'s door the scratch door');
{
  const { WorldAgent } = await import('../../mcpl/agent.ts');
  const { HANDLERS } = await import('../../mcpl/tools.ts');
  const W = lampWorld();
  const pub = W.call('publish', { from: 'lamp', name: 'Lamp' });
  const H = pub.notes.find((n: any) => n.record).record as string, hex = H.slice(7);
  W.call('create', { id: 'lampa', from: H, at: { pos: [2, 0, 2] } });
  const ag: any = new WorldAgent({ url: noWorldUrl(), name: 'eye' });
  const sync = () => { ag.st = W.view(); ag.replica = { st: W.state(), active: true }; ag.reconcileFromFold(); };
  sync();
  // every handler reaches the authority through request() (10-14: there is no door()); here that is the in-process world
  ag.request = async (verb: string, args: any) => { const r = W.call(verb, args); sync(); return r; };
  ag.pos = { x: 0, y: 0, z: 0 }; ag.yaw = 0; ag.heightAt = () => 0;
  const txt = (r: any) => r.content.map((c: any) => c.text).join('\n');
  const list = txt(await HANDLERS.blueprints(ag, {}));
  check('blueprints: the library by short hash, name and part count', list.includes(`[${hex.slice(0, 12)}] "Lamp" · 2 part(s)`), list);
  check('…and says where its copies stand', /1 copy: lampa/.test(list), list);
  const one = txt(await HANDLERS.blueprints(ag, { hash: hex.slice(0, 10) }));
  check('blueprints {hash: a prefix}: that one record', one.startsWith(`[${hex.slice(0, 12)}] "Lamp"`) && one.split('\n').length === 2, one);
  check('…an unknown prefix says so', /none here starts "zz"/.test(txt(await HANDLERS.blueprints(ag, { hash: 'zz' }))));
  const before = Object.keys(W.view().entities).length;
  // blueprint_place folded into create {from: "sha256:<hash>"} (10-14): a unique prefix of the hash will do
  const dry = await HANDLERS.create(ag, { from: `sha256:${hex.slice(0, 10)}`, id: 'lampb', dry: true }, {} as any, 'create');
  check('create {from: a blueprint prefix} (dry): the door answers it would create, and nothing is written', !(dry as any).isError && /would create/.test(txt(dry)) && Object.keys(W.view().entities).length === before, txt(dry));
  const live = await HANDLERS.create(ag, { from: `sha256:${hex.slice(0, 10)}`, at: [5, 5] }, {} as any, 'create');
  const roots = Object.entries(W.view().entities).filter(([, e]: any) => e?.['copy-of']?.from === H && e['copy-of'].key === 'lamp');
  const placed = roots.find(([id]) => id !== 'lampa')?.[1] as any, pp = placed?.transform?.pos ?? placed?.pos;
  check('create {from: a blueprint, at}: places a copy at 5,5 as one act', !(live as any).isError && roots.length === 2 && Math.abs(pp?.[0] - 5) < 1e-6 && Math.abs(pp?.[2] - 5) < 1e-6, { text: txt(live), pos: pp });
  const r = await HANDLERS.create(ag, { from: 'sha256:ffff' }, {} as any, 'create');
  check('create {from}: an unknown hash is an error that points at blueprints', (r as any).isError && /blueprints tool lists them/.test(txt(r)));
  const look = ag.look();
  const line = (id: string) => look.split('\n').find((l: string) => l.includes(`[${id}]`)) ?? '';
  check('look(): a placed copy says which blueprint it is', /a copy of "Lamp"/.test(line('lampa')) && !/components: .*blueprint/.test(line('lampa')), line('lampa'));
  const bh = ag.handle(partOf(W.view().entities, 'lampa', 'bulb'));   // look reads a part by its handle (R 10-17)
  check('look(): a part says whose part it is', /part "bulb" of lampa/.test(line(bh)), line(bh));
}

rmSync(SCRATCH, { recursive: true, force: true });
S.done();
