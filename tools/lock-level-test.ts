// lock-level-test — the three readers of a lock's level agree, and read it from ONE place.
//
// A lock is `true` or {rank: builder|moderator|owner}; its level decides who may lift it (authority), what the inspector
// shows (editschema `lockLevel` field) and whether the padlock asks or refuses (editpanels `mayLiftLevel`). Before C9
// each reader restated the level list and the rank numbers (DEBT-SURVEY-2026-10-12 #5). Now `lockLevel`/`lockRank` live
// in shared/protocol/roles.js beside RANK; the authority re-exports them, the two client readers import them.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/lock-level-test.ts
// Mutation (must go red): put `const LEVEL_RANK = { builder: 100, moderator: 150, owner: 255 }` back in editpanels.js,
// or a level list back in editschema's `lockLevel` field or editOps' flags.lockLevel branch.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as R from '../shared/protocol/roles.js';
import * as A from '../shared/protocol/authority.js';
import { inspectSchema, fieldAt } from '../shared/editschema.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };

const cases: [string, any, string][] = [
  ['true', true, 'builder'], ['{rank:owner}', { rank: 'owner' }, 'owner'], ['{rank:moderator}', { rank: 'moderator' }, 'moderator'],
  ['{rank:builder}', { rank: 'builder' }, 'builder'], ['junk string', { rank: 'emperor' }, 'builder'], ['junk number', { rank: 255 }, 'builder'],
  ['junk array', ['owner'], 'builder'], ['junk nested', { rank: { rank: 'owner' } }, 'builder'],
];
for (const [name, v, want] of cases) {
  const roles = R.lockLevel(v), auth = A.lockLevel(v);
  const schema = inspectSchema({ lock: v }, 'x');
  const shown = fieldAt(schema, 'flags.lockLevel')?.value;
  check(`${name}: roles ${roles} = authority ${auth} = inspector ${shown} = ${want}`, roles === want && auth === want && shown === want);
  check(`${name}: lockRank is RANK[level]`, R.lockRank(v) === R.RANK[want] && A.lockRank === R.lockRank);
}
check('LOCK_LEVELS is the authority\'s', A.LOCK_LEVELS === R.LOCK_LEVELS && R.LOCK_LEVELS.every((l: string) => typeof R.RANK[l] === 'number'));
check('inspector offers exactly the LOCK_LEVELS', JSON.stringify(fieldAt(inspectSchema({ lock: true }, 'x'), 'flags.lockLevel')?.options.map((o: any) => o.v)) === JSON.stringify(R.LOCK_LEVELS));

// the client readers restate nothing: no level list, no rank number, and the symbols come from roles.js
const src = (p: string) => readFileSync(join(import.meta.dir, '..', p), 'utf8');
for (const p of ['client/lib/editpanels.js', 'shared/editschema.js']) {
  const s = src(p);
  check(`${p} imports lockLevel from roles.js`, /import \{[^}]*\block(Level|Rank)\b[^}]*\} from '[^']*protocol\/roles\.js'/.test(s));
  check(`${p} has no level-list literal`, !/\[\s*'builder'\s*,\s*'moderator'\s*,\s*'owner'\s*\]/.test(s), 'the list lives in roles.js LOCK_LEVELS');
  check(`${p} has no rank-number literal`, !/\b(?:builder|moderator|owner)\s*:\s*\d+\b/.test(s) && !/[?:]\s*(?:255|200|100)\s*[:;]/.test(s), 'the numbers live in roles.js RANK');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
