// generate.js originOf (#260 house I98): ?orrery= is interpolated into the conjure panel's markup and its fetches, and
// remembered, so only an http(s) base (origin + a path of plain segments) is ever taken from it: never markup, a
// javascript: URL, credentials, a query or a hash. The cases orrery-param-test held, against the pure function.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/originof-test.ts
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({ name: 'originof-stubs', setup(b) {
  for (const m of ['base', 'icons', 'ui', 'net', 'build', 'chat', 'editwrites'])
    b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./originof-stub.mjs') }));
} });
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) };
const { originOf } = await import('../client/lib/generate.js');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const cases: [string, unknown, string | null][] = [
  ['an https origin', 'https://orrery.example', 'https://orrery.example'],
  ['an http origin with a port', 'http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
  ['a base under a path keeps its path', 'https://host.example/orrery/', 'https://host.example/orrery'],
  ['markup after a host: dropped to the origin', 'https://orrery.example/"><img src=x onerror="globalThis.__pwned=1">', 'https://orrery.example'],
  ['a query and a hash are dropped', 'https://orrery.example/o?x=<b>#y', 'https://orrery.example/o'],
  ['an encoded path segment is dropped to the origin', 'https://orrery.example/%3Cscript%3E', 'https://orrery.example'],
  ['javascript: is refused', 'javascript:globalThis.__pwned=1', null],
  ['data: is refused', 'data:text/html,<script>1</script>', null],
  ['credentials are refused', 'https://user:pw@orrery.example', null],
  ['a bare word is refused', 'orrery.example', null],
  ['nothing is refused', null, null],
];
console.log('originOf — the ?orrery= guard');
for (const [what, v, want] of cases) { const got = originOf(v); check(`${what}`, got === want, `${JSON.stringify(v)} → ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
check('no case ran markup', !(globalThis as any).__pwned);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
