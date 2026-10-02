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

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
