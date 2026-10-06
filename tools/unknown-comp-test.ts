// unknown-comp-test — what today's engine does with a component type it does
// not know. Pins the baseline docs/COMPONENTS-TODAY.md states under "An
// unknown component", so a port onto component records can be checked
// against it rather than against anyone's memory.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/unknown-comp-test.ts
//
// Four tiers, each the REAL module, no server process, no browser:
//   1. the door      server/verbs.ts runVerb on an in-process bench world
//                    (the flight-test.ts precedent): accepted, appended verbatim
//   2. the fold      shared/fold.js — kept verbatim, replaced wholesale, removed
//                    by null, and carried across a snapshot (stateToEntries)
//   3. the browser   client/lib/realize/models.js + state.js + the real bus, over
//                    tools/lod-client-stub.mjs's cone (no renderer, no network):
//                    the bag is mirrored and announced, nobody claims it,
//                    nothing is reported; motion.js's frame loop skips it
//   4. the inspector shared/editschema.js — a raw-JSON field, editable by a door `set` (v4 port 2026-10-06: the
//                    edit's ops go through the real v4 door on a scratch world and are read back; tiers 1–3 still pin
//                    the v1 runtime, which v1 worlds still run — tools/v4/nov1-check.ts)
// Text-tier perception ("components: <type>" in look()) is pinned live by
// tools/compfold-test.ts and tools/comptest.ts against a scratch sequencer.
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

const { emptyState, foldEntry, stateToEntries } = await import('../shared/fold.js');
const { runVerb } = await import('../server/verbs.ts');
const { inspectSchema, editOps, fieldAt } = await import('../shared/editschema.js');

const TYPE = 'weathervane';                 // a type no evaluator in this tree knows
const D1 = { points: 'north', vanes: [1, 2, { deep: true }], note: 'a cockerel' };
const D2 = { points: 'south' };

// ---- 1. the door -------------------------------------------------------------
console.log('\n1. the door (server/verbs.ts runVerb)');
const st: any = emptyState();
st.roles.owner = { role: 'owner' };
let seq = -1;
const log: any[] = [];
const debugs: any[] = [];
const w: any = {
  name: 'unknown-comp-bench', state: st, clients: new Set(), leases: new Map(),
  sim: { epoch: null, bodies: {} },
  bhv: { sync() {}, onEntry() {} },
  append(actor: string, verb: string, args: any) {
    const e = { seq: ++seq, ts: 1786320000000 + seq, actor, verb, args };
    foldEntry(st, e); log.push(e); return e;
  },
  commit(actor: string, verb: string, args: any) { return this.append(actor, verb, args); },
  broadcast() {}, debug(kind: string, detail: any) { debugs.push({ kind, ...detail }); }, fold() {},
};
const msgs: any[] = [];
const owner: any = { id: 'owner', spectator: false, world: w, lastPose: null,
  ws: { send(x: string) { msgs.push(JSON.parse(x)); } }, verbWin: 0, verbCount: 0 };
w.clients.add(owner);
const verb = (v: string, args: any) => runVerb({ w, c: owner, now: Date.now(), expel() {} } as any, v, args);
const errors = () => msgs.filter((m) => m.type === 'error').map((m) => m.error);

verb('spawn', { id: 'crate', lib: 'eidoverse/assets/models/crate_large_red.glb', pos: [1, 0, 1] });
verb('comp', { id: 'crate', type: TYPE, data: D1 });
const e1 = log.at(-1);
check('an unknown type is accepted: no refusal, one comp entry appended',
  errors().length === 0 && e1?.verb === 'comp' && e1.args.type === TYPE, JSON.stringify({ errors: errors(), e1 }));
check('…carrying the data exactly as sent (opaque: nothing validated, nothing dropped)', jeq(e1?.args.data, D1), JSON.stringify(e1?.args));
check('…and leaving no flight-recorder line (only motion*/particles are linted after a comp)', debugs.length === 0, JSON.stringify(debugs));

const LONG = 'a-component-type-name-well-past-thirty-two';
verb('comp', { id: 'crate', type: LONG, data: { x: 1 } });
check('a type name longer than 32 chars is TRUNCATED to 32, not refused',
  log.at(-1)?.args.type === LONG.slice(0, 32) && errors().length === 0, JSON.stringify(log.at(-1)?.args));
verb('comp', { id: 'crate', type: LONG.slice(0, 32), data: null });   // tidy: back to one unknown type

const nBefore = log.length;
verb('comp', { id: 'crate', type: TYPE, data: { blob: 'x'.repeat(8200) } });
check('the only shape rule an unknown type meets is size: > 8KB is refused, nothing appended',
  log.length === nBefore && /8KB/.test(errors().at(-1) ?? ''), errors().at(-1));

// ---- 2. the fold -------------------------------------------------------------
console.log('\n2. the fold (shared/fold.js)');
check('folded verbatim into entities[id].comp[type]', jeq(st.entities.crate?.comp?.[TYPE], D1), JSON.stringify(st.entities.crate?.comp));
const snapState = structuredClone(st);       // what a late joiner is handed
const snapSeq = seq;
{
  const st2: any = emptyState();
  for (const e of stateToEntries(st, { now: 1 })) foldEntry(st2, e as any);
  check('a snapshot roundtrip (stateToEntries → fold) carries it unchanged',
    jeq(st2.entities.crate?.comp?.[TYPE], D1), JSON.stringify(st2.entities.crate?.comp));
}
verb('comp', { id: 'crate', type: TYPE, data: D2 });
check('a second comp of the same type REPLACES the data wholesale (no merge)', jeq(st.entities.crate.comp[TYPE], D2), JSON.stringify(st.entities.crate.comp));
verb('comp', { id: 'crate', type: TYPE, data: null });
check('data: null removes it, and an emptied bag is deleted, not left as {}',
  st.entities.crate.comp === undefined, JSON.stringify(st.entities.crate));

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
// late join: the bench world as it stood with the unknown comp on the crate
S.hydrate(snapState, [], snapSeq);
for (let i = 0; i < 4; i++) { M.residencySweep?.(); await settle(); }
const obj = stub.entities.get('crate');
check('the entity realizes normally (an unknown comp blocks nothing)', !!obj && typeof obj.traverse === 'function',
  `entities.get('crate') = ${obj}`);
check('the bag is mirrored into the comps map evaluators read, verbatim', jeq(stub.comps.get('crate')?.[TYPE], D1), JSON.stringify(stub.comps.get('crate')));
check('…as a CLONE, never an alias of the folded state', stub.comps.get('crate')?.[TYPE] !== S.state.st.entities.crate?.comp?.[TYPE]);
check('the join announces it on the bus like any component ({id, type, data})',
  heard.some((h) => h.id === 'crate' && h.type === TYPE && jeq(h.data, D1)), JSON.stringify(heard));

// live: replace, then remove — exactly the entries the door appended
heard.length = 0;
for (const e of log.filter((x) => x.seq > snapSeq)) S.foldLive(structuredClone(e));
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
  set.errors.length === 0 && set.ops.length === 1 && jeq(set.ops[0], { tool: 'set', args: { id: 'crate', component: TYPE, value: { points: 'east' } } }), JSON.stringify(set));
const del = editOps(ent, 'crate', { [`comp.${TYPE}`]: '' });
check('…and an emptied field removes it (delete)', jeq(del.ops, [{ tool: 'delete', args: { id: 'crate', component: TYPE } }]), JSON.stringify(del));
{
  // through the real v4 door: the unknown type is kept verbatim (the door notes it knows no evaluator), replaced
  // wholesale by the edit, removed by the delete
  const { scratchWorld } = await import('./v4/scratchdoor.ts');
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
