// components-corpus-test — the component view is lossless on every world we have.
//
// For every world log in the corpus, fold it entry by entry; after each entry,
// read every entity it touched as components (shared/components.js
// componentsOf) and write it back (entityOf). The bytes must come back
// identical (canonical JSON), and every key must land in a component parameter,
// a declared stamp, or `extra` (which is counted and printed, never silently
// dropped). One differing entity anywhere = red.
//
// Corpus: spec/fixtures (always), plus any dirs in COMPONENTS_CORPUS
// (colon-separated; each is searched for worlds/*/log.jsonl or */log.jsonl).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/components-corpus-test.ts
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { emptyState, foldEntry } from '../shared/fold.js';
import { componentsOf, entityOf, canon, sha256hex, RECORDS, addable } from '../shared/components.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };

console.log('the primitives:');
check('sha256("abc") is the FIPS 180-2 vector', sha256hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
check('sha256 agrees with node:crypto on a long multi-block string', (() => { const s = 'ε∃'.repeat(500) + 'x'; return sha256hex(s) === createHash('sha256').update(s).digest('hex'); })());
check('canon sorts keys and drops undefined', canon({ b: 1, a: [1, { d: undefined, c: 'x' }] }) === '{"a":[1,{"c":"x"}],"b":1}');
check('canon refuses NaN', (() => { try { canon({ a: NaN }); return false; } catch { return true; } })());
const hashes = Object.values(RECORDS).map((r: any) => r.hash);
check(`every record has a distinct 64-hex hash (${hashes.length} records)`, hashes.every((h) => /^[0-9a-f]{64}$/.test(h)) && new Set(hashes).size === hashes.length);
check('Pendulum is not addable twice on a part-less basis but motion types repeat', addable([{ type: 'Transform' }, { type: 'Pendulum' }]).some((a) => a.name === 'Pendulum'));
check('a tilted entity keeps q through the view', (() => { const e = { lib: 'x.glb', pos: [0, 1, 0], q: [0.2588, 0, 0, 0.9659], yaw: 0, comp: { lock: true } }; return canon(entityOf(componentsOf(e))) === canon(e); })());
check('Picture needs a Model', !addable([{ type: 'Transform' }, { type: 'Light' }]).some((a) => a.name === 'Picture') && addable([{ type: 'Transform' }, { type: 'Model' }]).some((a) => a.name === 'Picture'));

// ------------------------------------------------------------ the corpus
const logs: string[] = [];
const walk = (d: string, depth = 0) => {
  if (depth > 4 || !existsSync(d)) return;
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (n === 'node_modules' || n === '.git') continue; walk(p, depth + 1); }
    else if (n === 'log.jsonl') logs.push(p);
  }
};
walk(join(import.meta.dir, '..', 'spec', 'fixtures'));
for (const d of (process.env.COMPONENTS_CORPUS ?? '').split(':').filter(Boolean)) walk(d);
const seen = new Set<string>(); const unique: string[] = [];
for (const p of logs) { const h = createHash('md5').update(readFileSync(p)).digest('hex'); if (!seen.has(h)) { seen.add(h); unique.push(p); } }

console.log(`\nthe corpus: ${unique.length} distinct world logs (${logs.length} found)`);
let entries = 0, checked = 0, entitiesSeen = 0;
const bad: string[] = [];
const types = new Map<string, number>();
const extras = new Map<string, number>();
for (const path of unique) {
  const st: any = emptyState();
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const ids = new Set<string>();
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    try { foldEntry(st, e); } catch { continue; }
    entries++;
    const id = e?.args?.id ?? e?.id;
    const touched = typeof id === 'string' ? [id] : [];
    for (const tid of touched) {
      const ent = st.entities?.[tid];
      if (!ent) continue;
      ids.add(tid);
      const view = componentsOf(ent);
      const back = entityOf(view);
      checked++;
      if (canon(back) !== canon(ent)) { if (bad.length < 12) bad.push(`${path.replace(/^.*?(worlds|fixtures)\//, '$1/')} @${e.seq ?? '?'} ${tid}\n     was ${canon(ent).slice(0, 300)}\n     got ${canon(back).slice(0, 300)}`); }
    }
  }
  entitiesSeen += ids.size;
  for (const ent of Object.values(st.entities ?? {})) for (const c of componentsOf(ent).components) {
    types.set(c.type, (types.get(c.type) ?? 0) + 1);
    for (const k of Object.keys(c.extra?.unknown ?? {})) extras.set(`${c.type}.${k}`, (extras.get(`${c.type}.${k}`) ?? 0) + 1);
  }
}
check(`round trip exact after every entry (${checked} entity states, ${entries} entries, ${entitiesSeen} entities)`, bad.length === 0 && checked > 0, '\n   ' + bad.join('\n   '));
console.log('\ncomponents in the final worlds:', [...types].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(' · '));
console.log('keys no record names (kept in extra, not lost):', extras.size ? [...extras].map(([k, n]) => `${k} ×${n}`).join(' · ') : 'none');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
