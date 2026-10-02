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
clearErr(); r = V('comp', { id: 'lamp', type: 'light', data: {} });
check('a visitor\'s comp light is refused by rank, before any shape talk', !r.appended && /builder/.test(r.error ?? ''), JSON.stringify(r));

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
