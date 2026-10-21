// The seat inspector line (client/lib/seatedit.js selectSeat) puts a seat's slot name and the thing's library label into
// markup. Both come from the world: a slot is a key in a thing's sockets component, a label from the library — a builder
// chooses either. They must be escaped. hint-text-test stubs seatedit.js inside build.js's cone (the two import each
// other), so its escapes never ran in a test (review of 4098ff7, Oscar-1808 #5a); this one loads seatedit.js itself,
// with build.js replaced by a recorder for setInspectorHtml.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/seat-inspector-text-test.ts
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;
const STUBBED = ['core', 'base', 'assets', 'world', 'net', 'controller', 'ui'];
plugin({ name: 'seat-inspector-stubs', setup(b) {
  b.onResolve({ filter: /^\.\/[\w-]+\.js$/ }, (args) => {
    const m = args.path.slice(2, -3);
    if (!/\/seatedit\.js$/.test(args.importer)) return undefined;
    if (m === 'build') return { path: here('./seat-inspector-build-stub.mjs') };
    if (STUBBED.includes(m)) return { path: here('./build-gate-stub.mjs') };
    return undefined;
  });
} });
let pass = 0, fail = 0;
const check = (what: string, ok: boolean, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${what}${ok || !detail ? '' : ` — ${detail}`}`); };

const stub = await import('./build-gate-stub.mjs') as any;
const bstub = await import('./seat-inspector-build-stub.mjs') as any;
const seatedit = await import('../client/lib/seatedit.js');

console.log('SEAT INSPECTOR — a hostile slot name and a hostile library label');
const SLOT = '"><img src=x onerror="globalThis.__pwned=1">';
stub.entityMeta.set('bench', { lib: 'models/bench.glb' });
stub.libLabels.set('models/bench.glb', '<b onmouseover="globalThis.__pwned=2">bench</b>');
seatedit.selectSeat({ id: 'bench', slot: SLOT });
const html = bstub.inspectorHtml.at(-1) ?? '';
check('selectSeat wrote the inspector line', html.length > 0, html.slice(0, 120));
check('the slot name is escaped: no <img> element in the line', !/<img/i.test(html) && html.includes('&lt;img'), html.slice(0, 200));
check('the library label is escaped: no <b onmouseover> in the line', !/<b onmouseover/i.test(html) && html.includes('&lt;b onmouseover'), html.slice(0, 300));
check('the line still carries its own markup (<b> around the slot, <kbd> for the keys)', /<b>/.test(html) && /<kbd>Q<\/kbd>/.test(html), html.slice(-160));
check('nothing ran', (globalThis as any).__pwned === undefined);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
