// blueprint-test — design §3 "Blueprints", §7 step 6a: the record, its hash,
// the store, the `blueprint` verb's door, and the copy link as pure functions.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/blueprint-test.ts
//
// 1. the hash      key order and prose (note) never move it; meaning does
// 2. the shape     blueprintRefusal's rules, each refused by name
// 3. the link      expand / overridesOf / rebase, a conflict included
// 4. the store     the fold keeps every record by its recomputed hash; a
//                  snapshot (stateToEntries) carries it; lineage walks it
// 5. the door      server/verbs.ts runVerb on an in-process bench world
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
const { emptyState, foldEntry, stateToEntries } = await import('../shared/fold.js');

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
  const unlabel = structuredClone(lampV1); unlabel.parent = H1; unlabel.root.components.find((c: any) => c.type === 'Label').params.text = 'a lamp, v4';
  const c6: any = rebase(red, unlabel, lampV1);
  check('rebase: a component the copy removed but the update edited is a conflict', c6.ok === false && c6.conflicts.some((c: any) => c.comp === 'Label|label'), J(c6));
}

// ---- 4. the store ------------------------------------------------------------------
console.log('\n4. the store (shared/fold.js state.blueprints)');
const lampV2: any = structuredClone(lampV1); lampV2.parent = H1; lampV2.root.components[2].params.intensity = 24;
const H2 = blueprintHash(lampV2);
{
  const st: any = emptyState();
  let s = 0; const E = (verb: string, args: any, actor = 'ann') => ({ seq: s++, ts: 1786320000000 + s, actor, verb, args });
  foldEntry(st, E('blueprint', { hash: H1, record: lampV1 }));
  check('a published record folds into the store under its hash, with who and when', st.blueprints?.[H1]?.record?.name === 'Lamp' && st.blueprints[H1].by === 'ann' && st.blueprints[H1].ts === 1786320000001, J(st.blueprints?.[H1]));
  foldEntry(st, E('blueprint', { hash: '0'.repeat(64), record: lampV2 }));
  check('the fold recomputes the hash: a mismatched entry (a hand-edited log) folds to nothing', !st.blueprints['0'.repeat(64)] && !st.blueprints[H2]);
  foldEntry(st, E('blueprint', { hash: H1, record: { ...lampV1, note: 'reworded' } }, 'bo'));
  check('re-publishing reworded prose keeps the first publisher and time, takes the new note', st.blueprints[H1].by === 'ann' && st.blueprints[H1].ts === 1786320000001 && st.blueprints[H1].record.note === 'reworded');
  foldEntry(st, E('blueprint', { hash: H1 }, 'bo'));
  check('a thin re-publish {hash} folds to nothing new', st.blueprints[H1].record.note === 'reworded' && Object.keys(st.blueprints).length === 1);
  foldEntry(st, E('blueprint', { hash: H2, record: lampV2 }));
  check('a new version is stored beside its parent (nothing is replaced)', !!st.blueprints[H1] && !!st.blueprints[H2]);
  check('lineage walks parent hashes, newest first', J(lineageOf(st.blueprints, H2)) === J([H2, H1]));
  check('…and stops at a parent the store lacks', J(lineageOf({ [H2]: st.blueprints[H2] }, H2)) === J([H2, H1]));
  for (const junk of [null, 'x', { hash: H1, record: 'lamp' }, { record: lampV1 }, { hash: 5, record: lampV1 }]) foldEntry(st, E('blueprint', junk));
  check('malformed entries fold to nothing and never throw (PROTOCOL §1 totality)', Object.keys(st.blueprints).length === 2);
  const bad = { kind: 'eido.blueprint', v: 1, name: 'n', root: { components: [{ type: 'Transform', params: { scale: 1 } }], children: [] }, extra: { s: 1e999 } };
  foldEntry(st, E('blueprint', { hash: 'f'.repeat(64), record: bad }));
  check('…including a record canon() refuses', Object.keys(st.blueprints).length === 2);
  // the snapshot path: a joiner folding stateToEntries gets the same store
  const re: any = emptyState();
  for (const e of stateToEntries(st)) foldEntry(re, e);
  check('a snapshot (stateToEntries) carries the store: a re-fold holds the same records', canon(re.blueprints ?? null) === canon(st.blueprints), J(Object.keys(re.blueprints ?? {})));
  const fresh: any = emptyState();
  check('a world with no blueprints folds no store key (old states keep their shape)', !('blueprints' in fresh) && !stateToEntries(fresh).some((e: any) => e.verb === 'blueprint'));
}

// ---- 5. the door -----------------------------------------------------------------------
console.log('\n5. the door (server/verbs.ts runVerb)');
{
  const { runVerb, VERBS } = await import('../server/verbs.ts');
  const st: any = emptyState();
  st.roles.owner = { role: 'owner' }; st.roles.bld = { role: 'builder' }; st.roles.vis = { role: 'visitor' };
  let seq = -1;
  const log: any[] = [];
  const debug: any[] = [];
  const w: any = {
    name: 'blueprint-bench', state: st, clients: new Set(), leases: new Map(),
    sim: { epoch: null, bodies: {} }, bhv: { sync() {}, onEntry() {} },
    append(actor: string, verb: string, args: any) { const e = { seq: ++seq, ts: 1786320000000 + seq, actor, verb, args }; foldEntry(st, e); log.push(e); return e; },
    commit(actor: string, verb: string, args: any) { return this.append(actor, verb, args); },
    broadcast() {}, debug(kind: string, d: any) { debug.push([kind, d]); }, fold() {},
  };
  const conn = (id: string) => { const msgs: any[] = []; const c: any = { id, spectator: false, world: w, lastPose: null, ws: { send(x: string) { msgs.push(JSON.parse(x)); } }, verbWin: 0, verbCount: 0, msgs }; w.clients.add(c); return c; };
  const as = (c: any) => (args: any) => { c.verbWin = 0; c.verbCount = 0; c.msgs.length = 0; const n = log.length; runVerb({ w, c, now: Date.now(), expel() {} } as any, 'blueprint', args); return { appended: log.length > n ? log.at(-1) : null, error: c.msgs.filter((m: any) => m.type === 'error').at(-1)?.error as string | undefined }; };
  const B = as(conn('bld')), V = as(conn('vis'));

  check('the verb is in the table at builder rank (design §8)', VERBS.blueprint?.rank === 1 && !VERBS.blueprint?.gen);
  let r = V({ hash: H1, record: lampV1 });
  check('a visitor is refused by rank', !r.appended && /builder rights/.test(r.error ?? ''), J(r));
  r = B({ hash: H1, record: { ...lampV1, author: 'x' } });
  check('a malformed record is refused with the shape rule\'s words, and recorded', !r.appended && /no "author"/.test(r.error ?? '') && debug.some(([k, d]) => k === 'rejected' && d.verb === 'blueprint'), J(r));
  r = B({ record: lampV1 });
  check('a publish without its hash is refused (say which record you mean)', !r.appended && /wants \{hash, record\}/.test(r.error ?? ''), J(r));
  r = B({ hash: '0'.repeat(64), record: lampV1 });
  check('a hash that is not the record\'s is refused, naming the real one', !r.appended && (r.error ?? '').includes(H1), J(r));
  r = B({ hash: H2, record: lampV2 });
  check('a parent the store does not hold is refused', !r.appended && /parent .* is not in this world's store/.test(r.error ?? ''), J(r));
  r = B({ hash: H1, record: { ...lampV1, note: 'first' }, extra: 'dropped', by: 'someone-else' });
  check('a good publish is appended as exactly {hash, record}', !!r.appended && J(Object.keys(r.appended.args).sort()) === J(['hash', 'record']) && st.blueprints[H1]?.by === 'bld', J(r));
  const n = log.length;
  r = B({ hash: H1, record: { ...lampV1, note: 'first' } });
  check('an identical re-publish is accepted idempotently: a thin {hash} entry, store unchanged', !r.error && !!r.appended && J(r.appended.args) === J({ hash: H1 }) && log.length === n + 1 && st.blueprints[H1].record.note === 'first', J(r));
  r = B({ hash: H1 });
  check('a bare {hash} the store holds is the same thin acknowledgement', !r.error && J(r.appended?.args) === J({ hash: H1 }));
  r = B({ hash: H2 });
  check('a bare {hash} the store lacks is refused (send the record)', !r.appended && /send the record/.test(r.error ?? ''), J(r));
  r = B({ hash: H1, record: { ...lampV1, note: 'reworded' } });
  check('a re-publish with reworded prose goes in whole, and the store takes the note', !!r.appended?.args.record && st.blueprints[H1].record.note === 'reworded', J(r));
  r = B({ hash: H2, record: lampV2 });
  check('now the parent is held, the new version is accepted', !!r.appended && !!st.blueprints[H2], J(r));
  // ---- 6. the agent's readout
  console.log('\n6. the text tier (mcpl/tools.ts blueprints)');
  const { HANDLERS, TOOLS } = await import('../mcpl/tools.ts');
  const ag: any = { blueprintStore: () => st.blueprints ?? {}, foldedIds: () => Object.keys(st.entities), foldRecord: (id: string) => st.entities[id] ?? null };
  const out = (r: any) => r.content.map((c: any) => c.text).join('\n');
  const list = out(await HANDLERS.blueprints(ag, {}));
  check('the list names each record by short hash, name, version and parent', list.includes(`[${H1.slice(0, 12)}] "Lamp" v1 · 2 parts`) && list.includes(`[${H2.slice(0, 12)}] "Lamp" v2 ← ${H1.slice(0, 12)}`) && /Model · Light · Label · by bld/.test(list), list);
  const one = out(await HANDLERS.blueprints(ag, { hash: H2.slice(0, 10) }));
  check('a prefix opens one record in full, with its lineage newest first', one.startsWith(`[${H2}]`) && one.includes(`${H2.slice(0, 12)} "Lamp" ← ${H1.slice(0, 12)} "Lamp"`) && JSON.parse(one.slice(one.indexOf('{'))).root.children[0].id === 'bulb', one.slice(0, 300));
  check('an unknown prefix says so', /no record here whose hash starts "zz"/.test(out(await HANDLERS.blueprints(ag, { hash: 'zz' }))));
  check('an empty store says how to publish', /store is empty.*world_verb blueprint/.test(out(await HANDLERS.blueprints({ blueprintStore: () => ({}), foldedIds: () => [], foldRecord: () => null } as any, {}))));
  check('world_verb\'s closed verb list names blueprint', /behavior, asset, blueprint/.test(TOOLS.find((t: any) => t.name === 'world_verb')!.description));
  check('the door\'s rules are the shared module\'s (one refusal text)', (() => { const v = (VERBS.blueprint as any).validate({ w, c: { id: 'bld' } }, { hash: H1, record: 'x' }); return v.error === blueprintRefusal('x'); })());
}

// ---- 7. placing a copy (6b) ----------------------------------------------------------
console.log('\n7. placing a copy through the door (placeVerbs → runVerb → the fold → copyTree)');
{
  const { placeVerbs, placeRefusal, copyTree, copyOf, copiesOf, copyLine, modernize, versionOf, LINK_KEY } = await import('../shared/blueprint.js');
  const { runVerb } = await import('../server/verbs.ts');
  const { worldPose } = await import('../shared/hierarchy.js');
  const { lightOf, colliderOf } = await import('../shared/components.js');
  const st: any = emptyState();
  st.roles.bld = { role: 'builder' };
  let seq = -1;
  const log: any[] = [];
  const w: any = {
    name: 'place-bench', state: st, clients: new Set(), leases: new Map(),
    sim: { epoch: null, bodies: {} }, bhv: { sync() {}, onEntry() {} },
    append(actor: string, verb: string, args: any) { const e = { seq: ++seq, ts: 1786320000000 + seq, actor, verb, args }; foldEntry(st, e); log.push(e); return e; },
    commit(actor: string, verb: string, args: any) { return this.append(actor, verb, args); },
    broadcast() {}, debug() {}, fold() {},
  };
  const msgs: any[] = [];
  const c: any = { id: 'bld', spectator: false, world: w, lastPose: null, ws: { send(x: string) { msgs.push(JSON.parse(x)); } }, verbWin: 0, verbCount: 0 };
  w.clients.add(c);
  // the door's own rate rule, honoured: a run is sent as a client would, within VERB_RATE
  // per window (the pacer's job, checked in 8); here each verb opens a fresh window
  const send = (list: any[]) => { const errs: string[] = []; for (const v of list) { c.verbWin = 0; c.verbCount = 0; msgs.length = 0; runVerb({ w, c, now: Date.now(), expel() {} } as any, v.verb, v.args); const e = msgs.find((m) => m.type === 'error'); if (e) errs.push(`${v.verb} ${J(v.args).slice(0, 80)}: ${e.error}`); } return errs; };
  const ents = () => st.entities;
  send([{ verb: 'blueprint', args: { hash: H1, record: lampV1 } }]);

  // the lamp: a model + light + label at the root, the bulb (an Empty with a light) 1.2 m up
  const plan = placeVerbs(lampV1, { id: 'lamp-1', pos: [3, 0, 4], yaw: 0.5 }, { hash: H1 });
  check('placeVerbs: no errors, a part per node', plan.errors.length === 0 && J(plan.parts) === J({ '': 'lamp-1', bulb: 'lamp-1-bulb' }), J(plan));
  const sp = plan.verbs.filter((v: any) => v.verb === 'spawn');
  check('…the root spawns at the placed pose with its model; the bulb as an Empty (no lib)', sp[0]?.args.id === 'lamp-1' && sp[0].args.lib === LAMP && J(sp[0].args.pos) === J([3, 0, 4]) && sp[0].args.yaw === 0.5 && sp[1]?.args.id === 'lamp-1-bulb' && !('lib' in sp[1].args), J(sp));
  const mt = plan.verbs.find((v: any) => v.verb === 'mount');
  check('…the bulb mounts under the root at its LOCAL pose (offset + yaw, as the record says)', J(mt?.args) === J({ id: 'lamp-1-bulb', to: 'lamp-1', offset: [0, 1.2, 0], yaw: 0 }), J(mt));
  check('…the link on the root ({hash, name}) and a part marker on the bulb ({part})', plan.verbs.some((v: any) => v.verb === 'comp' && v.args.id === 'lamp-1' && v.args.type === LINK_KEY && J(v.args.data) === J({ hash: H1, name: 'Lamp' })) && plan.verbs.some((v: any) => v.verb === 'comp' && v.args.id === 'lamp-1-bulb' && v.args.type === LINK_KEY && J(v.args.data) === J({ part: 'bulb' })));
  check('…and the way back is one list: remove each part, leaves first', J(plan.inverses) === J([{ verb: 'remove', args: { id: 'lamp-1-bulb' } }, { verb: 'remove', args: { id: 'lamp-1' } }]), J(plan.inverses));
  const errs = send(plan.verbs);
  check('the door accepts every verb (builder rank)', errs.length === 0, errs.join(' | '));
  const root = ents()['lamp-1'], bulb = ents()['lamp-1-bulb'];
  check('the fold holds the tree: the bulb rides the lamp', root?.lib === LAMP && bulb?.parent?.to === 'lamp-1' && J(bulb.parent.offset) === J([0, 1.2, 0]), J(bulb));
  check('…the lamp is a Model and a Light (comp.light), the bulb an Empty with comp.light', root.comp?.light?.intensity === 16 && bulb.lib == null && bulb.kind == null && bulb.comp?.light?.range === 3);
  const W = worldPose(ents(), 'lamp-1-bulb');
  check('the bulb\'s spawn pose is its world pose (nothing jumps between spawn and mount)', W && J(W.pos.map((v: number) => +v.toFixed(4))) === J(sp[1].args.pos), J({ W, spawned: sp[1].args.pos }));
  const t = copyTree(ents(), 'lamp-1', lampV1);
  check('read back: copyTree finds the link and names every part', t?.hash === H1 && t.name === 'Lamp' && J(t.parts) === J({ '': 'lamp-1', bulb: 'lamp-1-bulb' }) && J(t.tree.children.map((k: any) => k.id)) === J(['bulb']), J(t?.parts));
  check('…a child\'s Transform reads LOCAL (the mount\'s offset), not its pre-mount pose', J(t.tree.children[0].components.find((x: any) => x.type === 'Transform').params) === J({ pos: [0, 1.2, 0], yaw: 0 }), J(t.tree.children[0].components[0]));
  check('…and an unmodified copy is the record: no overrides', overridesOf(t.tree, lampV1).length === 0, J(overridesOf(t.tree, lampV1)));
  check('copyOf: the root is itself, the bulb is part "bulb" of lamp-1', J(copyOf(ents(), 'lamp-1')) === J({ root: 'lamp-1', path: [], link: { hash: H1, name: 'Lamp' } }) && J(copyOf(ents(), 'lamp-1-bulb')?.path) === J(['bulb']));
  check('copyLine: "a copy of "Lamp" (v1, …)", and the part names its copy', copyLine(ents(), 'lamp-1', st.blueprints) === `a copy of "Lamp" (v1, ${H1.slice(0, 12)})` && copyLine(ents(), 'lamp-1-bulb', st.blueprints) === `part "bulb" of lamp-1, a copy of "Lamp" (v1, ${H1.slice(0, 12)})`, `${copyLine(ents(), 'lamp-1', st.blueprints)} / ${copyLine(ents(), 'lamp-1-bulb', st.blueprints)}`);
  check('copyLine: a record the store lacks says so', /not in this world's store/.test(copyLine(ents(), 'lamp-1', {}) ?? ''));

  // a second copy, so the store knows where copies stand; the minted ids avoid what stands
  const plan2 = placeVerbs(lampV1, { id: 'lamp-2', pos: [0, 0, 0] }, { hash: H1, taken: (x: string) => !!ents()[x] || x === 'lamp-2-bulb' });
  check('a minted part id never replaces something standing', plan2.parts.bulb === 'lamp-2-bulb-2', J(plan2.parts));
  send(plan2.verbs);
  check('copiesOf: where each blueprint\'s copies stand', J(copiesOf(ents())) === J({ [H1]: ['lamp-1', 'lamp-2'] }));
  check('placeVerbs refuses an id already in use', placeVerbs(lampV1, { id: 'lamp-1', pos: [0, 0, 0] }, { taken: (x: string) => !!ents()[x] }).errors[0]?.includes('already in use'));

  // a copy edited for itself: overrides read off the world
  send([{ verb: 'comp', args: { id: 'lamp-1-bulb', type: 'light', data: { color: 0xffffff, intensity: 2, range: 3 } } }]);
  send([{ verb: 'spawn', args: { id: 'cat', lib: 'eidoverse/assets/models/cat.glb', pos: [0, 0, 0] } }, { verb: 'mount', args: { id: 'cat', to: 'lamp-1', offset: [0.3, 0, 0] } }]);
  const ov = overridesOf(copyTree(ents(), 'lamp-1', lampV1)!.tree, lampV1);
  check('an edit to a part reads as an override at that part\'s path', ov.some((o: any) => J(o.path) === J(['bulb']) && o.comp === 'Light|light' && o.field === 'params/intensity' && o.value === 2), J(ov));
  check('a thing parented into the copy since reads as an ADDED part, named by its entity id', ov.some((o: any) => J(o.path) === J(['cat']) && o.value === true && o.base === undefined), J(ov));
  check('…and nothing else', ov.every((o: any) => o.path[0] === 'cat' || (o.path[0] === 'bulb' && o.field === 'params/intensity')), `${ov.length}: ${J(ov.map((o: any) => [o.path.join('/'), o.comp, o.field]))}`);

  // one undo step takes the copy away
  const undoErrs = send(plan2.inverses);
  check('undo: the inverses remove every part of the copy, and nothing is left standing', undoErrs.length === 0 && !ents()['lamp-2'] && !ents()['lamp-2-bulb-2'], undoErrs.join(' | '));

  // a deeper design: a tilted, scaled arm, a locked shade with a rotation order, a legacy light
  // (keyless: from a kind:"light" entity) and a legacy collide on the base
  const deep: any = {
    kind: 'eido.blueprint', v: 1, name: 'Desk',
    root: { components: [
      { type: 'Transform', params: { scale: 2 } },
      { type: 'Model', params: { lib: LAMP } },
      { type: 'Collider', params: { shape: 'box' } },
    ], children: [
      { id: 'arm', components: [
        { type: 'Transform', params: { pos: [0.2, 0.5, 0], q: [0.3826834323650898, 0, 0, 0.9238795325112867], yaw: 0, scale: 0.5 } },
        { type: 'Model', params: { lib: LAMP } },
      ], children: [
        { id: 'shade', components: [
          { type: 'Transform', params: { pos: [0, 1, 0], rotOrder: 'ZXY' } },
          { type: 'Model', params: { lib: LAMP } },
          { type: 'Lock', key: 'lock', params: {}, wire: { value: true } },
          { type: 'Spin', key: 'motion', params: { axis: 'y', rate: 20 } },
        ], children: [
          { id: 'glow', components: [
            { type: 'Transform', params: { pos: [0, -0.1, 0] } },
            { type: 'Light', params: { color: 0xff8800, intensity: 6, range: 4, burnsAtNoon: true } },
          ], children: [] },
        ] },
      ] },
    ] },
  };
  check('the deep design is a record', blueprintRefusal(deep) === null, String(blueprintRefusal(deep)));
  const HD = blueprintHash(deep);
  send([{ verb: 'blueprint', args: { hash: HD, record: deep } }]);
  const pd = placeVerbs(deep, { id: 'desk', pos: [10, 0, -2], q: [0, 0.7071067811865476, 0, 0.7071067811865476], scale: 1.5 }, { hash: HD });
  check('a keyless (legacy) Light goes out as comp.light on an Empty, never the light verb (owner, 10-02)', !pd.verbs.some((v: any) => v.verb === 'light') && pd.verbs.some((v: any) => v.verb === 'comp' && v.args.id === pd.parts['arm/shade/glow'] && v.args.type === 'light' && v.args.data.day === false), J(pd.verbs.filter((v: any) => v.args.id === pd.parts['arm/shade/glow'])));
  check('a legacy collide goes out as comp.collider, not the spawn\'s collide', !pd.verbs.some((v: any) => v.verb === 'spawn' && 'collide' in v.args) && pd.verbs.some((v: any) => v.verb === 'comp' && v.args.id === 'desk' && v.args.type === 'collider' && v.args.data.shape === 'box'));
  check('the ghost\'s scale multiplies the record\'s root scale', pd.verbs[0]?.args.scale === 3, J(pd.verbs[0]?.args ?? pd.errors));
  check('locks go out last (a locked part refuses its own mount)', pd.verbs.at(-1)?.args.type === 'lock' && pd.verbs.findIndex((v: any) => v.args.type === 'lock') > pd.verbs.findLastIndex((v: any) => v.verb === 'mount'));
  check('…and the way back unlocks before it removes', J(pd.inverses[0]) === J({ verb: 'comp', args: { id: pd.parts['arm/shade'], type: 'lock', data: null } }) && pd.inverses.slice(1).every((v: any) => v.verb === 'remove'), J(pd.inverses));
  const de = send(pd.verbs);
  check('the door accepts the deep copy', de.length === 0, de.join(' | '));
  const glow = ents()[pd.parts['arm/shade/glow']];
  check('the glow is an Empty whose light reads the same (colour, brightness, reach, burns at noon) — comp spelling', glow && glow.kind == null && J(lightOf(glow)) === J({ spelling: 'comp', color: 0xff8800, intensity: 6, range: 4, keep: false, day: false }), J(glow));
  check('the base collides as a box', colliderOf(ents().desk) === 'box');
  check('the shade is locked, spins, and reads its rotation order', ents()[pd.parts['arm/shade']]?.comp?.lock === true && ents()[pd.parts['arm/shade']]?.comp?.motion?.type === 'spin' && ents()[pd.parts['arm/shade']]?.comp?.rotOrder === 'ZXY');
  const td = copyTree(ents(), 'desk', deep)!;
  const ovd = overridesOf(td.tree, deep);
  check('read back: the deep copy is the record (legacy spellings and all) — the root\'s scale is the one override', ovd.length === 1 && ovd[0].comp === 'Transform' && ovd[0].field === 'params/scale' && ovd[0].value === 3 && ovd[0].base === 2, J(ovd));
  const unscaled = placeVerbs(deep, { id: 'desk2', pos: [0, 0, 0] }, { hash: HD });
  send(unscaled.verbs);
  check('…and placed at the record\'s own scale, no override at all', overridesOf(copyTree(ents(), 'desk2', deep)!.tree, deep).length === 0, J(overridesOf(copyTree(ents(), 'desk2', deep)!.tree, deep)));
  const tilted = worldPose(ents(), pd.parts.arm);
  const armSpawn = pd.verbs.find((v: any) => v.verb === 'spawn' && v.args.id === pd.parts.arm)?.args;
  check('the tilted arm (root turned 90°, scale 3; local offset, tilt and scale ½) spawns at its composed pose: [10, 1.5, -2.6], tilted', tilted && Math.abs(tilted.scale - 1.5) < 1e-9 && J(tilted.pos.map((v: number) => +v.toFixed(4))) === J([10, 1.5, -2.6]) && J(armSpawn?.pos) === J([10, 1.5, -2.6]) && Array.isArray(armSpawn?.q), J({ tilted, armSpawn }));
  const du = send(pd.inverses);
  check('undo removes the whole deep copy, its locked part included', du.length === 0 && !Object.keys(pd.parts).some((k) => ents()[pd.parts[k]]), du.join(' | '));
  check('modernize: a keyless Light/Collider takes the component spelling; one that would collide keeps its own', J(modernize([{ type: 'Light', params: {} }]).map((x: any) => x.key)) === J(['light'])
    && J(modernize([{ type: 'Light', params: {} }, { type: 'Light', key: 'light', params: {} }]).map((x: any) => x.key ?? null)) === J([null, 'light'])
    && J(modernize([{ type: 'Collider', params: { shape: 'mesh' } }]).map((x: any) => x.key ?? null)) === J([null])
    && J(modernize([{ type: 'Label', params: { text: 'x' } }, { type: 'Annotation', params: { type: 'recipe', data: 1 } }]).map((x: any) => x.key)) === J(['label', 'recipe']));
  check('versionOf: v1 for an original, 0 for a record the store lacks', versionOf(st.blueprints, H1) === 1 && versionOf(st.blueprints, '0'.repeat(64)) === 0);

  // refusals, before anything is sent
  const both: any = { kind: 'eido.blueprint', v: 1, name: 'x', root: { components: [{ type: 'Light', params: {} }, { type: 'Light', key: 'light', params: {} }], children: [] } };
  check('placeRefusal: a part holding both spellings of a light', /both spellings/.test(placeRefusal(both) ?? ''), String(placeRefusal(both)));
  const badLight: any = { kind: 'eido.blueprint', v: 1, name: 'x', root: { components: [{ type: 'Light', key: 'light', params: { color: 'red' } }], children: [] } };
  check('placeRefusal: a light the component contract refuses (the door would)', /light color/.test(placeRefusal(badLight) ?? ''), String(placeRefusal(badLight)));
  const longKey: any = { kind: 'eido.blueprint', v: 1, name: 'x', root: { components: [{ type: 'Annotation', params: { type: 'k'.repeat(40), data: 1 } }], children: [] } };
  check('placeRefusal: a comp key the door would truncate', /32 characters/.test(placeRefusal(longKey) ?? ''), String(placeRefusal(longKey)));
  const nullData: any = { kind: 'eido.blueprint', v: 1, name: 'x', root: { components: [{ type: 'Annotation', key: 'note', params: { type: 'note', data: null } }], children: [] } };
  check('placeRefusal: a comp with no data (it would be a removal)', /holds no data/.test(placeRefusal(nullData) ?? ''), String(placeRefusal(nullData)));
  const badOrder: any = { kind: 'eido.blueprint', v: 1, name: 'x', root: { components: [{ type: 'Transform', params: { rotOrder: 'XXY' } }], children: [] } };
  check('placeRefusal: a rotation order the door refuses', /rotation order/.test(placeRefusal(badOrder) ?? ''), String(placeRefusal(badOrder)));
  check('placeVerbs: refusals come back as errors, with no verbs', (() => { const r = placeVerbs(both, { id: 'z', pos: [0, 0, 0] }); return r.errors.length === 1 && r.verbs.length === 0; })());
}

// ---- 8. the pacer ------------------------------------------------------------------------
console.log('\n8. the pacer (shared/pace.js) against the door\'s rate rule');
{
  const { makePacer, PACE } = await import('../shared/pace.js');
  // a model of server/verbs.ts runVerb's window: 12 per 4 s, the window opening at the first verb after the last one closed
  const door = () => { let win = -Infinity, n = 0, dropped = 0; return { hit(t: number) { if (t - win > 4000) { win = t; n = 0; } if (++n > 12) dropped++; }, get dropped() { return dropped; } }; };
  const run = (count: number, jitter: number, direct = 0) => {
    let now = 0; const timers: [number, () => void][] = []; const d = door(); const sent: string[] = [];
    const p = makePacer({ now: () => now, schedule: (fn: () => void, ms: number) => { timers.push([now + ms, fn]); return 0; },
      send: (verb: string, args: any) => { sent.push(args.n); d.hit(now + (now === 0 ? jitter : 0)); } });   // the worst bunching: the first burst arrives `jitter` ms late, the next on time
    for (let i = 0; i < direct; i++) p.direct('place', { n: `d${i}` });
    p.run(Array.from({ length: count }, (_, i) => ({ verb: 'comp', args: { n: i } })));
    p.direct('remove', { n: 'after' });   // an undo issued mid-run waits its turn
    while (timers.length) { timers.sort((a, b) => a[0] - b[0]); const [at, fn] = timers.shift()!; now = at; fn(); }
    return { dropped: d.dropped, sent, end: now };
  };
  const a = run(120, 0);
  check(`120 verbs in one run: none dropped by the door, in order (drained in ${(a.end / 1000).toFixed(1)} s)`, a.dropped === 0 && a.sent.length === 121 && a.sent.slice(0, 120).every((n, i) => n === i), J({ dropped: a.dropped, n: a.sent.length }));
  check('…and a verb sent the ordinary way while it drains goes after it, not into the middle', a.sent.at(-1) === 'after');
  const b = run(60, 350, 5);
  check('with the first burst arriving 0.35 s late (the next on time: the worst bunching) and 5 direct sends before it, still none dropped', b.dropped === 0, J({ dropped: b.dropped }));
  const worst = run(60, 1500, 0);
  check('control: past the margin (the first burst 1.5 s late) the door does drop — the margin is what holds', worst.dropped > 0, J({ dropped: worst.dropped }));
  const small = run(PACE.LIMIT - 1, 0);
  check(`a run under the budget (${PACE.LIMIT - 1}) goes at once`, small.end === 0 && small.sent.length === PACE.LIMIT);
  // the control: the same 120 sent unpaced lose their tail at the door
  const d = door(); for (let i = 0; i < 120; i++) d.hit(i);
  check('control: unpaced, the door drops all but 12', d.dropped === 108);
}

// ---- 9. the text tier for copies ----------------------------------------------------------
console.log('\n9. the text tier: look(), inspect, blueprints, blueprint_place (mcpl)');
{
  const { placeVerbs } = await import('../shared/blueprint.js');
  const { WorldAgent } = await import('../mcpl/agent.ts');
  const { HANDLERS } = await import('../mcpl/tools.ts');
  const ag: any = new WorldAgent({ name: 'eye' });
  let n = 1;
  const entry = (verb: string, args: Record<string, unknown>) => ag.applyEntry({ verb, args, ts: 1786320000000 + n, seq: n++, actor: 'owner' }, false);
  entry('blueprint', { hash: H1, record: lampV1 });
  for (const v of placeVerbs(lampV1, { id: 'lampA', pos: [2, 0, 2] }, { hash: H1 }).verbs) entry(v.verb, v.args);
  const out = ag.look();
  const line = (id: string) => out.split('\n').find((l: string) => l.includes(`[${id}]`)) ?? '';
  check('look(): a placed copy says which blueprint it is', line('lampA').includes(`a copy of "Lamp" (v1, ${H1.slice(0, 12)})`) && !/components: .*blueprint/.test(line('lampA')), line('lampA'));
  check('look(): a part says whose part it is', line('lampA-bulb').includes(`part "bulb" of lampA, a copy of "Lamp"`), line('lampA-bulb'));
  const txt = (r: any) => r.content.map((c: any) => c.text).join('\n');
  const ins = txt(await HANDLERS.inspect(ag, { id: 'lampA-bulb' }));
  check('inspect: the head names the copy, beside parent and children', ins.includes(`blueprint: part "bulb" of lampA, a copy of "Lamp" (v1,`) && ins.includes('parent: lampA'), ins.slice(0, 400));
  const list = txt(await HANDLERS.blueprints(ag, {}));
  check('blueprints: each record says where its copies stand', list.includes('· 1 copy: lampA'), list);
  const one = txt(await HANDLERS.blueprints(ag, { hash: H1.slice(0, 8) }));
  check('blueprints {hash}: lists the copies with how many overrides each holds', /copies \(1\): lampA\n/.test(one), one.slice(0, 400));
  entry('comp', { id: 'lampA', type: 'label', data: 'the porch lamp' });
  check('…an edited copy counts its overrides', /copies \(1\): lampA \(1 override\)/.test(txt(await HANDLERS.blueprints(ag, { hash: H1.slice(0, 8) }))));
  ag.pos = { x: 0, y: 0, z: 0 }; ag.yaw = 0; ag.heightAt = () => 0;
  const dry = txt(await HANDLERS.blueprint_place(ag, { hash: H1.slice(0, 10), id: 'lampB', dry: true }));
  check('blueprint_place dry: the verbs a copy is, 2 m ahead, with its parts', /^would send \d+ verbs/.test(dry) && dry.includes('spawn {"id":"lampB","lib"') && dry.includes('"pos":[0,0,2]') && dry.includes('bulb → lampB-bulb'), dry.slice(0, 300));
  const sent: any[] = []; ag.verb = (verb: string, args: any) => sent.push({ verb, args });
  const live = txt(await HANDLERS.blueprint_place(ag, { hash: H1.slice(0, 10), id: 'lampC', x: 5, z: 5 }));
  check('blueprint_place: sends the copy (paced) and says how to undo it', sent.length > 0 && sent[0].verb === 'spawn' && sent[0].args.id === 'lampC' && /to undo: remove .*lampC-bulb.*remove .*"lampC"/.test(live), live.slice(0, 300));
  const r = await HANDLERS.blueprint_place(ag, { hash: 'ffff' });
  check('blueprint_place: an unknown hash is an error that points at blueprints', (r as any).isError && /blueprints tool lists them/.test(txt(r)));
  const before = sent.length;
  const taken: any = await HANDLERS.blueprint_place(ag, { hash: H1.slice(0, 10), id: 'lampA' });
  check('blueprint_place: an id in use is refused, nothing sent', taken.isError === true && /already in use/.test(txt(taken)) && sent.length === before, txt(taken));
}

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
