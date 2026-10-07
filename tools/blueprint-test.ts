// blueprint-test — design §3 "Blueprints", §7 step 6a: the record, its hash,
// the copy link as pure functions, and blueprints through the authority.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/blueprint-test.ts
//
// 1. the hash      key order and prose (note) never move it; meaning does
// 2. the shape     blueprintRefusal's rules, each refused by name
// 3. the link      expand / overridesOf / rebase, a conflict included
// 6. the door's publish (@world library:<hash>) and create {from: <hash>, at} on a scratch world
//    (tools/protocol/scratchworld.ts): the record, the copy's tree, its local poses, one act, the door's undo
// 7. the agent's blueprints / blueprint_place / look() over the library, its door the scratch door
//
// Sections 1–3 are pure functions of shared/blueprint.js and stay as they were (NOTE: expand/overridesOf/rebase have
// no runtime caller today). The v1 sections went with the v1 runtime (protocol v1 removed, 2026-10-07): 4 (the v1
// fold's state.blueprints store and its stateToEntries snapshot), 5 (server/verbs.ts's blueprint verb) and 8
// (shared/pace.js against a model of the v1 door's 12-per-4-s verb window; pace.js has no runtime caller now).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.ts makes WORLDS_DIR at import: keep the bench out of the repo's worlds/
const SCRATCH = mkdtempSync(join(tmpdir(), 'ew-blueprint-'));
process.env.WORLDS_DIR = join(SCRATCH, 'worlds');

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const J = JSON.stringify;

const { blueprintHash, blueprintRefusal, hashRefusal, expand, overridesOf, rebase, linkOf, lineageOf, BLUEPRINT_LIMITS } = await import('../shared/blueprint.js');
const { componentsOf, entityOf, canon, sha256hex } = await import('../shared/components.js');

const LAMP = 'eidoverse/assets/models/lamp.glb';
// a lamp: a model with a light, and a bulb child (an Empty with its own light) 1.2 m up
const lampV1: any = {
  kind: 'eido.blueprint', v: 1, name: 'Lamp',
  root: {
    components: [
      { type: 'Transform', params: { scale: 1 } },
      { type: 'Model', params: { lib: LAMP } },
      { type: 'Light', key: 'light', params: { color: 0xffd9a0, intensity: 16, range: 10 } },
      { type: 'Label', key: 'label', params: { text: 'a lamp' } },
    ],
    children: [
      { id: 'bulb', components: [
        { type: 'Transform', params: { pos: [0, 1.2, 0], yaw: 0 } },
        { type: 'Light', key: 'light', params: { color: 0xffffff, intensity: 4, range: 3 } },
      ], children: [] },
    ],
  },
};
const H1 = blueprintHash(lampV1);

// ---- 1. the hash --------------------------------------------------------------
console.log('\n1. the hash (canonical JSON, RFC 8785, without the note)');
{
  check('a hash is 64 lowercase hex', /^[0-9a-f]{64}$/.test(H1), H1);
  // the same record with every object's keys reversed
  const rev = (v: any): any => Array.isArray(v) ? v.map(rev) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, rev(x)])) : v;
  const reordered = rev(lampV1);
  check('key order does not move it', J(Object.keys(reordered)) !== J(Object.keys(lampV1)) && blueprintHash(reordered) === H1);
  check('prose (a note) does not move it', blueprintHash({ ...lampV1, note: 'the porch lamp, warm' }) === H1 && blueprintHash({ ...lampV1, note: 'reworded' }) === H1);
  const brighter = structuredClone(lampV1); brighter.root.components[2].params.intensity = 24;
  check('meaning does: one parameter', blueprintHash(brighter) !== H1);
  check('…the name (it is what copies show)', blueprintHash({ ...lampV1, name: 'Desk lamp' }) !== H1);
  check('…the parent (a version names its lineage)', blueprintHash({ ...lampV1, parent: H1 }) !== H1);
  const moved = structuredClone(lampV1); moved.root.children[0].components[0].params.pos = [0, 1.3, 0];
  check('…a child\'s local pose', blueprintHash(moved) !== H1);
  const renamedKid = structuredClone(lampV1); renamedKid.root.children[0].id = 'globe';
  check('…a child\'s id (the handle an update finds it by)', blueprintHash(renamedKid) !== H1);
  check('the hash is canon() + sha256hex() — the component records\' own helpers', sha256hex(canon(lampV1)) === H1);
}

// ---- 2. the shape ---------------------------------------------------------------
console.log('\n2. the shape (blueprintRefusal)');
{
  check('the lamp is a v1 record', blueprintRefusal(lampV1) === null, String(blueprintRefusal(lampV1)));
  const bad: [string, any, RegExp][] = [
    ['not an object', 'lamp', /is an object/],
    ['an unknown top-level key', { ...lampV1, author: 'me' }, /no "author"/],
    ['another kind', { ...lampV1, kind: 'eido.component' }, /kind is "eido.blueprint"/],
    ['another version', { ...lampV1, v: 2 }, /v: 1/],
    ['an empty name', { ...lampV1, name: '  ' }, /name/],
    ['a parent that is not a hash', { ...lampV1, parent: 'v1' }, /parent is the hash/],
    ['a root with an id', { ...lampV1, root: { ...lampV1.root, id: 'x' } }, /root has no id/],
    ['a node with no children list', { ...lampV1, root: { components: [] } }, /children is a list/],
    ['a child with no id', { ...lampV1, root: { components: [], children: [{ components: [], children: [] }] } }, /needs an id/],
    ['two children with one id', { ...lampV1, root: { components: [], children: [{ id: 'a', components: [], children: [] }, { id: 'a', components: [], children: [] }] } }, /two children with id "a"/],
    ['an unknown component type', { ...lampV1, root: { components: [{ type: 'Gizmo', params: {} }], children: [] } }, /not a component a thing can carry/],
    ['a world component', { ...lampV1, root: { components: [{ type: 'Sky', params: {} }], children: [] } }, /not a component a thing can carry/],
    ['a Parent', { ...lampV1, root: { components: [{ type: 'Parent', params: { to: 'x' } }], children: [] } }, /attached by nesting/],
    ['Captions', { ...lampV1, root: { components: [{ type: 'Captions', key: 'captions', params: { feed: {} } }], children: [] } }, /caption verb/],
    ['a nested copy', { ...lampV1, root: { components: [{ type: 'Annotation', key: 'blueprint', params: { type: 'blueprint', data: { hash: H1 } } }], children: [] } }, /blueprint inside a blueprint/],
    ['placement on the root', { ...lampV1, root: { components: [{ type: 'Transform', params: { pos: [1, 0, 0] } }], children: [] } }, /holds no pos, q or yaw/],
    ['two of one component', { ...lampV1, root: { components: [{ type: 'Model', params: { lib: LAMP } }, { type: 'Model', params: { lib: LAMP } }], children: [] } }, /two Model components/],
    ['a component with stray keys', { ...lampV1, root: { components: [{ type: 'Model', params: { lib: LAMP }, placer: 'me' }], children: [] } }, /no "placer"/],
    ['a non-finite number', { ...lampV1, root: { components: [{ type: 'Transform', params: { scale: Infinity } }], children: [] } }, /plain JSON/],
    ['too many bytes', { ...lampV1, note: undefined, root: { components: [{ type: 'Annotation', key: 'pad', params: { type: 'pad', data: 'x'.repeat(BLUEPRINT_LIMITS.BYTES) } }], children: [] } }, /bytes; the most/],
    ['one component over 8 KB', { ...lampV1, root: { components: [{ type: 'Annotation', key: 'pad', params: { type: 'pad', data: 'x'.repeat(9000) } }], children: [] } }, /larger than a component may be/],
  ];
  const deep: any = { components: [], children: [] }; let n = deep;
  for (let i = 0; i < BLUEPRINT_LIMITS.DEPTH + 1; i++) { const k = { id: `d${i}`, components: [], children: [] }; n.children.push(k); n = k; }
  bad.push(['nesting deeper than the limit', { ...lampV1, root: deep }, /nests at most/]);
  bad.push(['more parts than the limit', { ...lampV1, root: { components: [], children: Array.from({ length: BLUEPRINT_LIMITS.NODES }, (_, i) => ({ id: `p${i}`, components: [], children: [] })) } }, /at most 256 parts/]);
  for (const [name, rec, re] of bad) {
    const why = blueprintRefusal(rec);
    check(`refused: ${name}`, !!why && re.test(why), String(why));
  }
  check('hashRefusal: the right hash passes', hashRefusal(lampV1, H1) === null);
  check('hashRefusal: a wrong hash is named with the real one', (hashRefusal(lampV1, '0'.repeat(64)) ?? '').includes(H1));
  check('hashRefusal: a missing hash says what it wants', /64 lowercase hex/.test(hashRefusal(lampV1, undefined) ?? ''));
}

// ---- 3. the link -------------------------------------------------------------------
console.log('\n3. the copy link (expand, overridesOf, rebase)');
// a copy as the world holds it: the root entity's components (placement + link
// included) and the bulb as a child entity (a Parent the world added)
const copyOf = (rec: any, at: number[]) => {
  const x = expand(rec);
  const root = componentsOf({ ...x.entity, pos: at, yaw: 0.5, comp: { ...(x.entity.comp ?? {}), blueprint: linkOf(rec) } }).components;
  const kid = (k: any) => ({ id: k.id, components: componentsOf({ ...k.entity, parent: { to: 'lamp-1', offset: [0, 1.2, 0] } }).components, children: k.children.map(kid) });
  return { components: root, children: x.children.map(kid) };
};
{
  const x = expand(lampV1);
  check('expand: the root writes wire bytes with no placement and no stamps', x.entity.lib === LAMP && x.entity.comp?.light?.intensity === 16 && !('pos' in x.entity) && !('actor' in x.entity), J(x.entity));
  check('expand: children by id, each with its own bytes (the bulb\'s local pos)', x.children.length === 1 && x.children[0].id === 'bulb' && J(x.children[0].entity.pos) === J([0, 1.2, 0]) && x.children[0].entity.comp?.light?.range === 3, J(x.children));
  x.components[1].params.lib = 'mutated';
  check('expand: components are copies (editing them leaves the record alone)', lampV1.root.components[1].params.lib === LAMP);
  check('linkOf: {hash, name}', J(linkOf(lampV1)) === J({ hash: H1, name: 'Lamp' }));

  const copy = copyOf(lampV1, [3, 0, 4]);
  check('a fresh copy has no overrides (placement, Attachment and the link are not overrides)', overridesOf(copy, lampV1).length === 0, J(overridesOf(copy, lampV1)));
  // this lamp is red, its label gone, its bulb dimmer, and it has a spin
  const red = structuredClone(copy);
  red.components.find((c: any) => c.type === 'Light').params.color = 0xff0000;
  red.components = red.components.filter((c: any) => c.type !== 'Label');
  red.components.push({ type: 'Spin', key: 'motion', params: { axis: 'y', rate: 10 } });
  red.children[0].components.find((c: any) => c.type === 'Light').params.intensity = 2;
  const ov = overridesOf(red, lampV1);
  const has = (f: (o: any) => boolean) => ov.some(f);
  check('overrides: a field (the light\'s color)', has((o) => o.comp === 'Light|light' && o.field === 'params/color' && o.value === 0xff0000 && o.base === 0xffd9a0), J(ov));
  check('overrides: a removed component (the label), whole and its fields', has((o) => o.comp === 'Label|label' && o.field === undefined && o.value === undefined && o.base === 'Label'), J(ov));
  check('overrides: an added component (the spin)', has((o) => o.comp === 'Spin|motion' && o.field === undefined && o.value === 'Spin'), J(ov));
  check('overrides: a child\'s field, addressed by its path', has((o) => J(o.path) === J(['bulb']) && o.comp === 'Light|light' && o.field === 'params/intensity' && o.value === 2), J(ov));

  // v2: brighter lamp, a new shade child, the label reworded; the bulb's range changed
  const lampV2 = structuredClone(lampV1); lampV2.parent = H1;
  lampV2.root.components.find((c: any) => c.type === 'Light').params.intensity = 24;
  lampV2.root.children[0].components.find((c: any) => c.type === 'Light').params.range = 5;
  lampV2.root.children.push({ id: 'shade', components: [{ type: 'Model', params: { lib: 'eidoverse/assets/models/shade.glb' } }, { type: 'Transform', params: { pos: [0, 1.4, 0] } }], children: [] });
  check('v2 is a record of its own, naming v1', blueprintRefusal(lampV2) === null && blueprintHash(lampV2) !== H1);
  const r: any = rebase(red, lampV2, lampV1);
  check('rebase with no overlap: ok', r.ok === true, J(r.conflicts));
  const root = r.tree?.components ?? [];
  const light = root.find((c: any) => c.type === 'Light');
  check('…takes the update (intensity 24) and keeps the override (red)', light?.params.intensity === 24 && light?.params.color === 0xff0000, J(light));
  check('…keeps the removal (no label) and the addition (the spin)', !root.some((c: any) => c.type === 'Label') && root.some((c: any) => c.type === 'Spin'), J(root.map((c: any) => c.type)));
  check('…keeps the copy\'s placement on its Transform', J(root.find((c: any) => c.type === 'Transform')?.params.pos) === J([3, 0, 4]) && root.find((c: any) => c.type === 'Transform')?.params.yaw === 0.5);
  const bulb = r.tree?.children.find((k: any) => k.id === 'bulb');
  const bl = bulb?.components.find((c: any) => c.type === 'Light');
  check('…in a child: takes the range, keeps the dimmer intensity', bl?.params.range === 5 && bl?.params.intensity === 2, J(bl));
  check('…adds the new part (shade), in the new version\'s order', J(r.tree?.children.map((k: any) => k.id)) === J(['bulb', 'shade']));
  check('…and the result expands (entityOf writes it)', (() => { try { entityOf({ components: root }); return true; } catch { return false; } })());
  check('…and its overrides against v2 are exactly the copy\'s own', (() => {
    const o2 = overridesOf(r.tree, lampV2).map((o: any) => `${o.path.join('/')}:${o.comp}:${o.field ?? '*'}`).sort();
    return J(o2) === J(ov.map((o: any) => `${o.path.join('/')}:${o.comp}:${o.field ?? '*'}`).sort());
  })());

  // the conflict: the copy made the lamp red; v3 makes it blue
  const lampV3 = structuredClone(lampV1); lampV3.parent = H1;
  lampV3.root.components.find((c: any) => c.type === 'Light').params.color = 0x0000ff;
  const c3: any = rebase(red, lampV3, lampV1);
  check('rebase: an override on a field the update also changed is a conflict', c3.ok === false && c3.conflicts.some((c: any) => c.comp === 'Light|light' && c.field === 'params/color' && c.ours === 0xff0000 && c.theirs === 0x0000ff && c.base === 0xffd9a0), J(c3));
  check('…and nothing is guessed (no tree)', c3.tree === undefined);
  const same3 = structuredClone(lampV1); same3.parent = H1; same3.root.components.find((c: any) => c.type === 'Light').params.color = 0xff0000;
  check('rebase: both sides making the same change is not a conflict', (rebase(red, same3, lampV1) as any).ok === true);
  // removing what the other side edited
  const noBulb = structuredClone(red); noBulb.children = [];
  const c4: any = rebase(noBulb, lampV2, lampV1);
  check('rebase: a part the copy removed but the update edited is a conflict', c4.ok === false && c4.conflicts.some((c: any) => J(c.path) === J(['bulb'])), J(c4));
  const c5: any = rebase(noBulb, (() => { const v = structuredClone(lampV1); v.parent = H1; v.name = 'Lamp '; return v; })(), lampV1);
  check('…but a removal the update did not touch stays removed', c5.ok === true && c5.tree.children.length === 0, J(c5));
  // the update ADDS to a part the copy removed: the remover and the adder disagree too
  const capped = structuredClone(lampV1); capped.parent = H1;
  capped.root.children[0].components.push({ type: 'Label', key: 'label', params: { text: 'the bulb' } });
  const c7: any = rebase(noBulb, capped, lampV1);
  check('rebase: a part the copy removed but the update added to is a conflict (not a silent drop)', c7.ok === false && c7.conflicts.some((c: any) => J(c.path) === J(['bulb']) && c.comp === 'Label|label'), J(c7));
  const unlabel = structuredClone(lampV1); unlabel.parent = H1; unlabel.root.components.find((c: any) => c.type === 'Label').params.text = 'a lamp, now';
  const c6: any = rebase(red, unlabel, lampV1);
  check('rebase: a component the copy removed but the update edited is a conflict', c6.ok === false && c6.conflicts.some((c: any) => c.comp === 'Label|label'), J(c6));
}

// ---- 6. the door's publish and create {from} ------------------------------------------
console.log('\n6. publish → @world blueprints:<hash>; create {from: hash, at} → the copy (the real door, a scratch world)');
const { scratchWorld } = await import('./protocol/scratchworld.ts');
const { worldPose } = await import('../shared/hierarchy.js');
const { qFromYaw, qNorm } = await import('../shared/rot.js');
const near = (a: number[], b: number[], e = 2e-3) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= e);
const lampWorld = () => {
  const W = scratchWorld('blueprint');
  W.call('set', { id: '@world', component: 'roles:bld', value: { role: 'builder' } });
  W.call('set', { id: '@world', component: 'roles:vis', value: { role: 'visitor' } });
  // a lamp: a model with a light and a label, and a bulb child (an Empty with its own light) 1.2 m up
  W.seed({
    lamp: { lib: LAMP, pos: [7, 0, 7], yaw: 1, comp: { light: { color: 0xffd9a0, intensity: 16, range: 10 }, label: 'a lamp' } },
    bulb: { pos: [0, 0, 0], parent: { to: 'lamp', offset: [0, 1.2, 0], yaw: 0 }, comp: { light: { color: 0xffffff, intensity: 4, range: 3 } } },
  });
  return W;
};
const libOf = (W: any) => Object.fromEntries(Object.entries(W.state().entities['@world'].c).filter(([k]) => k.startsWith('blueprints:')).map(([k, v]) => [k.slice('blueprints:'.length), v]));
let HV = '';   // the record's hash, "sha256:<hex>"
{
  const W = lampWorld();
  const vis = W.call('publish', { from: 'lamp', name: 'Lamp' }, 'vis');
  check('a visitor may not publish (rank)', vis.ok === false && vis.refused?.code === 'rights', J(vis));
  const r = W.call('publish', { from: 'lamp', name: 'Lamp' }, 'bld');
  HV = r.notes?.find((n: any) => n.record)?.record ?? '';
  const hex = HV.replace(/^sha256:/, '');
  check('publish {from, name}: one act, the record\'s hash in its notes, the blueprints entry @world blueprints:<hex> = {name, parts}', r.ok && /^sha256:[0-9a-f]{64}$/.test(HV) && J(libOf(W)[hex]) === J({ name: 'Lamp', parts: 2 }), J([r.refused, r.notes, libOf(W)]));
  const rec = W.getBlob(HV);
  check('the record: the thing and what is attached, root at the origin (its place is the copy\'s), parts keyed, the publisher named',
    rec.name === 'Lamp' && rec.root === 'lamp' && rec.by === 'bld' && J(rec.parts.map((p: any) => p.key)) === J(['lamp', 'bulb'])
    && J(rec.parts[0].components.transform.pos) === J([0, 0, 0]) && !rec.parts[0].components.parent && rec.parts[1].components.parent?.to === 'lamp'
    && near(rec.parts[1].components.transform.pos, [0, 1.2, 0], 0) && rec.parts[0].components.light.intensity === 16, J(rec));
  check('…the world is untouched by publishing (the lamp stays where it stands)', near(W.rec('lamp').pos, [7, 0, 7], 0) && W.rec('bulb').parent?.to === 'lamp');
  const again = W.call('publish', { from: 'lamp', name: 'Lamp' }, 'bld');
  check('content-addressed: the same publisher re-publishing the same thing gets the same hash', again.ok && again.notes?.find((n: any) => n.record)?.record === HV, J(again.notes));
  W.call('set', { id: 'lamp', component: 'light', value: { color: 0xffd9a0, intensity: 24, range: 10 } }, 'bld');
  const v2 = W.call('publish', { from: 'lamp', name: 'Lamp' }, 'bld');
  const H2v = v2.notes?.find((n: any) => n.record)?.record;
  check('…meaning moves it: a brighter lamp is a new record beside the first (nothing replaced)', v2.ok && H2v !== HV && Object.keys(libOf(W)).length === 2, J(libOf(W)));

  // place a copy: create {from: hash, at}
  const at = { pos: [3, 0, 4], q: qFromYaw(0.5) };
  const c1 = W.call('create', { id: 'lamp-1', from: HV, at }, 'bld');
  const E = () => W.view().entities;
  check('create {id, from: hash, at}: one act, the copy\'s parts named from its id', c1.ok && !!E()['lamp-1'] && !!E()['lamp-1-bulb'], J([c1.refused, Object.keys(E())]));
  const root = E()['lamp-1'], bulb = E()['lamp-1-bulb'];
  check('…the root at `at` (pos and turn) with its model, light and label; the bulb an Empty with its light',
    root.lib === LAMP && near(root.pos, [3, 0, 4], 0) && Math.abs(root.yaw - 0.5) < 1e-6 && root.comp?.light?.intensity === 16 && root.comp?.label === 'a lamp'
    && bulb.lib === undefined && bulb.comp?.light?.range === 3, J({ root, bulb }));
  check('…the bulb rides the copy\'s root at its LOCAL pose (as the record says)', bulb.parent?.to === 'lamp-1' && near(bulb.pos, [0, 1.2, 0], 0), J(bulb));
  const Wb = worldPose(E(), 'lamp-1-bulb')!;
  check('…so its world pose is the root\'s pose composed with it: [3, 1.2, 4]', near(Wb.pos, [3, 1.2, 4]), J(Wb));
  check('…every part carries the link: copy-of {from: hash, key}', J(root.comp?.['copy-of']) === J({ from: HV, key: 'lamp' }) && J(bulb.comp?.['copy-of']) === J({ from: HV, key: 'bulb' }), J([root.comp?.['copy-of'], bulb.comp?.['copy-of']]));
  const c2 = W.call('create', { id: 'lamp-1', from: HV, at }, 'bld');
  check('an id in use is refused (`exists`), nothing written', c2.ok === false && c2.refused?.code === 'exists', J(c2));
  const c3 = W.call('create', { from: 'sha256:' + '0'.repeat(64) }, 'bld');
  check('a hash with no record is refused', c3.ok === false && ['not-found', 'not-published'].includes(c3.refused?.code), J(c3));
  const W2 = scratchWorld('blueprint');
  const c4 = W2.call('create', { from: HV });
  check('a record that isn\'t one of THIS world\'s blueprints is refused (publish it here first)', c4.ok === false && ['not-published', 'not-found'].includes(c4.refused?.code), J(c4));
  const u = W.call('undo', {}, 'bld');
  check('one undo (the door\'s, of the create) takes the whole copy away', u.ok && !E()['lamp-1'] && !E()['lamp-1-bulb'] && !!E().lamp, J([u.refused, Object.keys(E())]));
  // a copy edited for itself is just a thing (the link stays): editing it never touches the record or other copies
  W.call('create', { id: 'lamp-2', from: HV, at: { pos: [0, 0, 0] } }, 'bld');
  W.call('create', { id: 'lamp-3', from: HV, at: { pos: [2, 0, 0] } }, 'bld');
  W.call('set', { id: 'lamp-2-bulb', component: 'light', value: { color: 0xffffff, intensity: 2, range: 3 } }, 'bld');
  check('an edit to one copy\'s part changes that copy only, and the record stays as published', E()['lamp-2-bulb'].comp.light.intensity === 2 && E()['lamp-3-bulb'].comp.light.intensity === 4 && W.getBlob(HV).parts[1].components.light.intensity === 4);
}
{
  // a deeper design: a scaled base with a box collider, a tilted half-scale arm, a locked shade with a rotation order
  // and a spin, and a glow (an Empty with a light that burns at noon)
  const W = scratchWorld('blueprint');
  const tilt = [0.3826834323650898, 0, 0, 0.9238795325112867];
  W.seed({
    desk: { lib: LAMP, pos: [50, 0, 50], scale: 2, comp: { collider: { shape: 'box' } } },
    arm: { lib: LAMP, parent: { to: 'desk', offset: [0.2, 0.5, 0], q: tilt }, scale: 0.5 },
    shade: { lib: LAMP, parent: { to: 'arm', offset: [0, 1, 0] }, comp: { rotOrder: 'ZXY', motion: { type: 'spin', axis: 'y', degPerSec: 20 }, lock: true } },
    glow: { parent: { to: 'shade', offset: [0, -0.1, 0] }, comp: { light: { color: 0xff8800, intensity: 6, range: 4, day: false } } },
  });
  const p = W.call('publish', { from: 'desk', name: 'Desk' });
  const HD = p.notes?.find((n: any) => n.record)?.record;
  check('the deep design publishes (4 parts, the locked shade included)', p.ok && J(libOf(W)[String(HD).slice(7)]) === J({ name: 'Desk', parts: 4 }), J([p.refused, libOf(W)]));
  const yaw90 = [0, 0.7071067811865476, 0, 0.7071067811865476];
  const c = W.call('create', { id: 'desk2', from: HD, at: { pos: [10, 0, -2], q: yaw90 } });
  const E = W.view().entities;
  const id = (k: string) => Object.keys(E).find((x) => E[x].comp?.['copy-of']?.from === HD && E[x].comp['copy-of'].key === k && x.startsWith('desk2'));
  check('the copy lands as one act: four parts', c.ok && ['desk', 'arm', 'shade', 'glow'].every((k) => !!id(k)), J([c.refused, Object.keys(E)]));
  const arm = worldPose(E, id('arm')!)!;
  check('the tilted arm (root turned 90°, root scale 2; local offset, tilt and scale ½) stands at its composed pose: [10, 1, -2.4], scale 1, tilted',
    near(arm.pos, [10, 1, -2.4]) && Math.abs(arm.scale - 1) < 1e-6 && Math.abs(E[id('arm')!].q[0]) > 0.1, J(arm));
  const shade = E[id('shade')!], glow = E[id('glow')!];
  check('the shade is locked, spins, and keeps its rotation order', shade.comp?.lock === true && shade.comp?.motion?.type === 'spin' && shade.comp?.rotOrder === 'ZXY', J(shade.comp));
  check('the glow is an Empty whose light burns at noon; the base collides as a box', glow.lib === undefined && glow.comp?.light?.day === false && glow.comp.light.color === 0xff8800 && E.desk2.comp?.collider?.shape === 'box', J([glow, E.desk2.comp]));
  // a lock binds removal (§5), and undoing a create removes: the door refuses the bare undo `locked` (v1's inverses
  // unlocked first). The person is asked "Move anyway?" (editwrites: undo offers through, not unlock); throughLock takes it.
  const u0 = W.call('undo', {});
  check('a bare undo of the copy is refused `locked` (its shade is locked), and nothing is removed', u0.ok === false && u0.refused?.code === 'locked' && Object.keys(W.view().entities).filter((x) => x.startsWith('desk2')).length === 4, J(u0));
  const u = W.call('undo', { throughLock: true });
  check('…throughLock: one undo takes the whole deep copy away, its locked part included', u.ok && !Object.keys(W.view().entities).some((x) => x.startsWith('desk2')), J([u.refused, Object.keys(W.view().entities)]));
}

// ---- 7. the agent's tools over the library ------------------------------------------------
console.log('\n7. the text tier — blueprints, blueprint_place, look() (mcpl), the agent\'s door the scratch door');
{
  const { WorldAgent } = await import('../mcpl/agent.ts');
  const { HANDLERS } = await import('../mcpl/tools.ts');
  const W = lampWorld();
  const pub = W.call('publish', { from: 'lamp', name: 'Lamp' });
  const H = pub.notes.find((n: any) => n.record).record as string, hex = H.slice(7);
  W.call('create', { id: 'lampa', from: H, at: { pos: [2, 0, 2] } });
  const ag: any = new WorldAgent({ name: 'eye' });
  const sync = () => { ag.st = W.view(); ag.replica = { st: W.state(), active: true }; ag.reconcileFromFold(); };
  sync();
  ag.door = async (verb: string, args: any) => { const r = W.call(verb, args); sync(); return r; };
  ag.pos = { x: 0, y: 0, z: 0 }; ag.yaw = 0; ag.heightAt = () => 0;
  const txt = (r: any) => r.content.map((c: any) => c.text).join('\n');
  const list = txt(await HANDLERS.blueprints(ag, {}));
  check('blueprints: the library by short hash, name and part count', list.includes(`[${hex.slice(0, 12)}] "Lamp" · 2 part(s)`), list);
  // KNOWN BUG (reported 2026-10-06, mcpl/tools.ts blueprints): it counts copies by copy-of.hash, but the door's
  // link is copy-of {from: "sha256:…", key} — so every record reads "no copies placed"
  check('…and says where its copies stand (KNOWN BUG: reads copy-of.hash; the door writes {from, key})', /1 copy: lampa/.test(list), list);
  const one = txt(await HANDLERS.blueprints(ag, { hash: hex.slice(0, 10) }));
  check('blueprints {hash: a prefix}: that one record', one.startsWith(`[${hex.slice(0, 12)}] "Lamp"`) && one.split('\n').length === 2, one);
  check('…an unknown prefix says so', /none here starts "zz"/.test(txt(await HANDLERS.blueprints(ag, { hash: 'zz' }))));
  const before = Object.keys(W.view().entities).length;
  const dry = await HANDLERS.blueprint_place(ag, { hash: hex.slice(0, 10), id: 'lampb', dry: true });
  // KNOWN BUG (reported 2026-10-06, mcpl/tools.ts blueprint_place): it sends create {from: <hex>} — the library key
  // without "sha256:" — and the door reads a from without that prefix as a THING id to duplicate: "no thing called…"
  check('blueprint_place (dry): the door answers it would place a copy, and nothing is written (KNOWN BUG: from lacks "sha256:")', !(dry as any).isError && /would place a copy of "Lamp"/.test(txt(dry)) && Object.keys(W.view().entities).length === before, txt(dry));
  const live = await HANDLERS.blueprint_place(ag, { hash: hex.slice(0, 10), x: 5, z: 5 });
  check('blueprint_place: places a copy 5,5 as one act (KNOWN BUG above)', !(live as any).isError && Object.values(W.view().entities).filter((e: any) => e.comp?.['copy-of']?.from === H && e.comp['copy-of'].key === 'lamp').length === 2, txt(live));
  const r = await HANDLERS.blueprint_place(ag, { hash: 'ffff' });
  check('blueprint_place: an unknown hash is an error that points at blueprints', (r as any).isError && /blueprints tool lists them/.test(txt(r)));
  const look = ag.look();
  const line = (id: string) => look.split('\n').find((l: string) => l.includes(`[${id}]`)) ?? '';
  // KNOWN BUG (reported 2026-10-06, mcpl/agent.ts look → shared/blueprint.js copyLine): copyLine reads v1's link
  // ({hash, name} / {part} and state.blueprints); the link is copy-of {from, key}, so look() says nothing about a
  // copy and dumps "components: blueprint" instead
  check('look(): a placed copy says which blueprint it is (KNOWN BUG: v1 copyLine)', /a copy of "Lamp"/.test(line('lampa')) && !/components: .*blueprint/.test(line('lampa')), line('lampa'));
  check('look(): a part says whose part it is (KNOWN BUG: v1 copyLine)', /part "bulb" of lampa/.test(line('lampa-bulb')), line('lampa-bulb'));
}

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
