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
    ['an Attachment', { ...lampV1, root: { components: [{ type: 'Attachment', params: { to: 'x' } }], children: [] } }, /attached by nesting/],
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
// included) and the bulb as a child entity (an Attachment the world added)
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
  const ag: any = { blueprintStore: () => st.blueprints ?? {} };
  const out = (r: any) => r.content.map((c: any) => c.text).join('\n');
  const list = out(await HANDLERS.blueprints(ag, {}));
  check('the list names each record by short hash, name, version and parent', list.includes(`[${H1.slice(0, 12)}] "Lamp" v1 · 2 parts`) && list.includes(`[${H2.slice(0, 12)}] "Lamp" v2 ← ${H1.slice(0, 12)}`) && /Model · Light · Label · by bld/.test(list), list);
  const one = out(await HANDLERS.blueprints(ag, { hash: H2.slice(0, 10) }));
  check('a prefix opens one record in full, with its lineage newest first', one.startsWith(`[${H2}]`) && one.includes(`${H2.slice(0, 12)} "Lamp" ← ${H1.slice(0, 12)} "Lamp"`) && JSON.parse(one.slice(one.indexOf('{'))).root.children[0].id === 'bulb', one.slice(0, 300));
  check('an unknown prefix says so', /no record here whose hash starts "zz"/.test(out(await HANDLERS.blueprints(ag, { hash: 'zz' }))));
  check('an empty store says how to publish', /store is empty.*world_verb blueprint/.test(out(await HANDLERS.blueprints({ blueprintStore: () => ({}) } as any, {}))));
  check('world_verb\'s closed verb list names blueprint', /behavior, asset, blueprint/.test(TOOLS.find((t: any) => t.name === 'world_verb')!.description));
  check('the door\'s rules are the shared module\'s (one refusal text)', (() => { const v = (VERBS.blueprint as any).validate({ w, c: { id: 'bld' } }, { hash: H1, record: 'x' }); return v.error === blueprintRefusal('x'); })());
}

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
