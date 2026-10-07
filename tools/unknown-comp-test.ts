// unknown-comp-test — what today's engine does with a component type it does
// not know (the baseline docs/COMPONENTS-TODAY.md states under "An unknown
// component", on protocol v4).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/unknown-comp-test.ts
//
// Four tiers, each the REAL module, no server process, no browser:
//   1. the door      shared/protocol/authority.js on a scratch v4 world (tools/protocol/scratchworld.ts): a set of an unknown type is
//                    accepted, with a note that the door knows no evaluator for it
//   2. the fold      the door's state as the view a client reads (view.js viewState): kept verbatim, replaced
//                    wholesale, removed by delete {id, component}
//   3. the browser   client/lib/realize/models.js + state.js + the real bus, over tools/lod-client-stub.mjs's cone
//                    (no renderer, no network), fed the views a v4 client folds (hydrate the cut's view, then
//                    applyView after each write): the bag is mirrored and announced, nobody claims it, nothing is
//                    reported; motion.js's frame loop skips it
//   4. the inspector shared/editschema.js — a raw-JSON field, editable by a door `set`; the edit's ops go through the
//                    real v4 door on a scratch world and are read back
// (Ported to v4 2026-10-07: tiers 1–3 pinned the v1 runtime's verbs.ts/fold.js/foldLive path, gone with protocol v1.
//  The v1-only shape rules they pinned, a 32-char type name truncated and an 8 KB comp refused, have no v4 subject.)
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.ts makes WORLDS_DIR at import: keep the bench out of the repo's worlds/
const SCRATCH = mkdtempSync(join(tmpdir(), 'ew-unknown-comp-'));
process.env.WORLDS_DIR = join(SCRATCH, 'worlds');

const STUB = fileURLToPath(new URL('./unknown-comp-stub.mjs', import.meta.url));
const SPY = fileURLToPath(new URL('./unknown-comp-report-spy.mjs', import.meta.url));
plugin({
  name: 'unknown-comp-stub',
  setup(b) {
    // the realizer's cone (realize/ imports ../x.js) and motion.js's (./x.js)
    for (const f of ['^\\.\\./(core|assets|colliders|lightrig|lights|world)\\.js$',
      '^\\./(core|world|colliders|remotes)\\.js$']) {
      b.onResolve({ filter: new RegExp(f) }, () => ({ path: STUB }));
    }
    // the realizer's report(), recorded; everyone else gets the real base.js
    b.onResolve({ filter: /^\.\.\/base\.js$/ }, (args) =>
      (args.importer.endsWith('realize/models.js') ? { path: SPY } : undefined));
  },
});

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const jeq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 8; i++) await sleep(15); };

const { inspectSchema, editOps, fieldAt } = await import('../shared/editschema.js');
const { scratchWorld } = await import('./protocol/scratchworld.ts');

const TYPE = 'weathervane';                 // a type no evaluator in this tree knows
const D1 = { points: 'north', vanes: [1, 2, { deep: true }], note: 'a cockerel' };
const D2 = { points: 'south' };
const LIB = 'eidoverse/assets/models/crate_large_red.glb';

// ---- 1. the door -------------------------------------------------------------
console.log('\n1. the door (shared/protocol/authority.js, a scratch v4 world)');
const W = scratchWorld('unknowncomp').seed({ crate: { lib: LIB, pos: [1, 0, 1] } });
const r0 = W.call('set', { id: 'crate', component: TYPE, value: D1 });
check('an unknown type is accepted: the set is not refused', r0.ok === true, JSON.stringify(r0.refused));
check('…and the door says it knows no evaluator for it (a note, not a refusal)',
  (r0.notes ?? []).some((n: any) => n.component === TYPE), JSON.stringify(r0.notes));

// ---- 2. the fold -------------------------------------------------------------
console.log('\n2. the fold (the door\'s state, as the view clients read)');
check('folded verbatim into the view: entities[id].comp[type]', jeq(W.rec('crate')?.comp?.[TYPE], D1), JSON.stringify(W.rec('crate')?.comp));
const snapView = structuredClone(W.view());  // what a late joiner adopts (the cut's view)
const views: any[] = [];                     // the views after each later write, as a joined client folds them
const r1 = W.call('set', { id: 'crate', component: TYPE, value: D2 });
views.push(structuredClone(W.view()));
check('a second set of the same type REPLACES the data wholesale (no merge)', r1.ok && jeq(W.rec('crate').comp?.[TYPE], D2), JSON.stringify(W.rec('crate').comp));
const r2 = W.call('delete', { id: 'crate', component: TYPE });
views.push(structuredClone(W.view()));
check('delete {id, component} removes it, and the thing stays', r2.ok && W.rec('crate') && W.rec('crate').comp?.[TYPE] === undefined, JSON.stringify(W.rec('crate')));

// ---- 3. the browser realizer ----------------------------------------------------
console.log('\n3. the browser realizer (client/lib/realize/models.js, real bus + state)');
const stub: any = await import('./unknown-comp-stub.mjs');
const spy: any = await import('./unknown-comp-report-spy.mjs');
const M: any = await import('../client/lib/realize/models.js');
const S: any = await import('../client/lib/state.js');
const { bus } = await import('../client/lib/base.js');
const { tickMotion } = await import('../client/lib/motion.js');

const heard: any[] = [];
bus.on('comp', (ev: any) => heard.push(structuredClone(ev)));
M.initModelsRealizer();
// late join: the world's view as it stood with the unknown comp on the crate
S.hydrate(snapView);
for (let i = 0; i < 4; i++) { M.residencySweep?.(); await settle(); }
const obj = stub.entities.get('crate');
check('the entity realizes normally (an unknown comp blocks nothing)', !!obj && typeof obj.traverse === 'function',
  `entities.get('crate') = ${obj}`);
check('the bag is mirrored into the comps map evaluators read, verbatim', jeq(stub.comps.get('crate')?.[TYPE], D1), JSON.stringify(stub.comps.get('crate')));
check('…as a CLONE, never an alias of the folded state', stub.comps.get('crate')?.[TYPE] !== S.state.st.entities.crate?.comp?.[TYPE]);
check('the join announces it on the bus like any component ({id, type, data})',
  heard.some((h) => h.id === 'crate' && h.type === TYPE && jeq(h.data, D1)), JSON.stringify(heard));

// live: replace, then remove — the views a joined client's own fold reaches after the door's two writes
heard.length = 0;
for (const v of views) S.applyView(structuredClone(v));
await settle();
const live = heard.filter((h) => h.id === 'crate' && h.type === TYPE);
check('a live replace and a live removal are each announced (data, then null)',
  live.length === 2 && jeq(live[0].data, D2) && live[1].data === null, JSON.stringify(heard));
check('after the removal the comps map holds nothing for the entity', !stub.comps.has('crate'), JSON.stringify(stub.comps.get('crate')));
check('the realizer reported nothing at any point (no error path was taken)', spy.reports.length === 0, JSON.stringify(spy.reports));

// motion.js's per-frame loop walks the same map: an unknown key, and an
// unknown motion TYPE, are both stood still — never thrown
const before = obj.position.toArray();
stub.comps.set('crate', { [TYPE]: D1, motion: { type: 'wobble', amp: 1, t0: Date.now() - 5000 } });
let threw: unknown = null;
try { tickMotion(); } catch (e) { threw = e; }
check('tickMotion() walks past an unknown key and an unknown motion type without throwing', threw === null, String(threw));
check('…and the entity stays exactly where it was (stillness, not a guess)', jeq(obj.position.toArray(), before), JSON.stringify({ before, after: obj.position.toArray() }));
stub.comps.delete('crate');

// ---- 4. the inspector --------------------------------------------------------
console.log('\n4. the inspector (shared/editschema.js)');
const ent = { lib: 'x.glb', pos: [0, 0, 0], yaw: 0, comp: { [TYPE]: D1 } };
const schema = inspectSchema(ent, 'crate');
const f = fieldAt(schema, `comp.${TYPE}`);
check('an unknown type gets a raw-JSON field in the Components group', f?.t === 'json' && jeq(JSON.parse(f.value), D1), JSON.stringify(f));
const set = editOps(ent, 'crate', { [`comp.${TYPE}`]: '{"points":"east"}' });
check('…which saves as ONE set replacing the data wholesale',
  set.errors.length === 0 && set.ops.length === 1 && jeq(set.ops[0], { verb: 'set', args: { id: 'crate', component: TYPE, value: { points: 'east' } } }), JSON.stringify(set));
const del = editOps(ent, 'crate', { [`comp.${TYPE}`]: '' });
check('…and an emptied field removes it (delete)', jeq(del.ops, [{ verb: 'delete', args: { id: 'crate', component: TYPE } }]), JSON.stringify(del));
{
  // through the real v4 door: the unknown type is kept verbatim (the door notes it knows no evaluator), replaced
  // wholesale by the edit, removed by the delete
  const W = scratchWorld('unknowncomp').seed({ crate: ent });
  check('the v4 door keeps an unknown component verbatim', jeq(W.rec('crate').comp?.[TYPE], D1), JSON.stringify(W.rec('crate').comp));
  const r1 = W.send(set.ops[0]);
  check('…the edit replaces it wholesale (no merge with the old keys), and the door says it knows no evaluator for it',
    r1.ok && jeq(W.rec('crate').comp?.[TYPE], { points: 'east' }) && (r1.notes ?? []).some((n: any) => n.component === TYPE && /isn't a component/.test(n.why)), JSON.stringify([r1.refused, r1.notes, W.rec('crate').comp]));
  const r2 = W.send(del.ops[0]);
  check('…and the delete removes it', r2.ok && W.rec('crate').comp?.[TYPE] === undefined, JSON.stringify([r2.refused, W.rec('crate').comp]));
}

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
