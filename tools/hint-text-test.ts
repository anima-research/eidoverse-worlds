// The hint bar treats what it is handed as TEXT (security hotfix: stored XSS via display name).
//
// A participant's display name reached the hint bar through `${by} knocked you over`, `${by} grabs you`,
// `${by} posed you`, … and flashHint wrote it with innerHTML — so a name carrying a tag ran script in the
// browser of anyone that participant knocked over. The hint API is text by default now; markup is an explicit
// opt-in built with html`` (client/lib/markup.js), whose interpolations are escaped.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/hint-text-test.ts
//
// Three parts:
//   1. the REAL ui.js under happy-dom (settings-panels-stub answers for its renderer-bound imports):
//      flashHint / setHint / setAmbientHint with a hostile string create no element; html`` still renders <kbd>
//      and escapes what it interpolates.
//   2. the REAL build.js (build-gate stubs): the edit-mode inspector and the guarded/locked hints show a hostile
//      placer name and a hostile library label as text.
//   3. a source scan: every hint call whose argument carries a literal tag must build it with html`` — otherwise
//      the fix would show "<kbd>X</kbd>" to everyone as literal characters (what this file prints when broken).
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
const here = (f: string) => new URL(f, import.meta.url).pathname;
// one plugin, two stub sets keyed on the importer: ui.js's renderer edge (settings-panels-stub, as
// settings-panels-test uses it) for the real ui.js cone, and build.js's whole import cone (hint-text-build-stub,
// which re-exports build-gate-stub) for build.js / placer.js — there ui.js IS stubbed, with a recorder flashHint,
// so part 2 reads exactly what build.js handed the bar.
const UI_STUBBED = ['core', 'base', 'governor', 'lightrig', 'xrpanels', 'net', 'palette', 'avatar', 'controller', 'capnotice', 'assets', 'mictoggle'];
const BUILD_STUBBED = ['core', 'base', 'assets', 'lights', 'world', 'colliders', 'terrain', 'net', 'controller', 'ui', 'scenegraph', 'frames', 'seatedit'];
plugin({ name: 'hint-text-stubs', setup(b) {
  b.onResolve({ filter: /^\.\/[\w-]+\.js$/ }, (args) => {
    const m = args.path.slice(2, -3);
    if (/\/(build|placer)\.js$/.test(args.importer) && BUILD_STUBBED.includes(m)) return { path: here('./hint-text-build-stub.mjs') };
    if (/\/client\/lib\//.test(args.importer) && !/\/(build|placer)\.js$/.test(args.importer) && UI_STUBBED.includes(m)) return { path: here('./settings-panels-stub.mjs') };
    return undefined;
  });
} });

import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
(globalThis as any).Option = function (text: string, value?: string) { const o = document.createElement('option'); o.text = text; if (value !== undefined) o.value = value; return o; };
globalThis.fetch = (async () => new Response('[]', { status: 200 })) as any;
for (const id of ['hud', 'loading', 'toasts', 'hintbar', 'door', 'help', 'dock', 'touch']) { const d = document.createElement('div'); d.id = id; document.body.append(d); }

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

// a name that would be an element if anything parsed it (an <img> whose onerror never fires under happy-dom —
// the test asks whether the ELEMENT exists, which is the whole bug)
const HOSTILE = '<img src=x onerror="globalThis.__pwned=1">eve';

console.log('HINT BAR — the real ui.js');
const ui = await import('../client/lib/ui.js');
const markup = await import('../client/lib/markup.js').catch((e) => ({ err: String(e) })) as any;
const bar = document.getElementById('hintbar')!;

ui.flashHint(`${HOSTILE} knocked you over`);
check('flashHint: a name with a tag in it creates no element', bar.querySelector('img') === null, bar.innerHTML);
check('…and is shown as the characters it is', bar.textContent === `${HOSTILE} knocked you over`, bar.textContent ?? '');
ui.setHint(`${HOSTILE} grabs you`);
check('setHint: text too', bar.querySelector('img') === null && bar.textContent === `${HOSTILE} grabs you`, bar.innerHTML);
ui.setAmbientHint(`${HOSTILE} offers a seat`);
// a flash owns the bar for 2.6s; the ambient line lands when it ends — wait it out rather than poke internals
await new Promise((r) => setTimeout(r, 2700));
check('setAmbientHint: text too (after the flash hands the bar back)', bar.querySelector('img') === null && bar.textContent === `${HOSTILE} offers a seat`, bar.innerHTML);
ui.setAmbientHint(null);

check('markup.js exists and exports html``', !markup.err && typeof markup.html === 'function', markup.err);
if (!markup.err) {
  ui.flashHint(markup.html`<kbd>X</kbd> — sit next to ${HOSTILE}`);
  check('html``: the built-in <kbd> still renders as a key', bar.querySelector('kbd')?.textContent === 'X', bar.innerHTML);
  check('html``: what it interpolates is escaped (no element, characters shown)', bar.querySelector('img') === null && (bar.textContent ?? '').includes(HOSTILE), bar.innerHTML);
  const fake = JSON.parse(JSON.stringify(markup.html`<b>x</b>`));
  ui.flashHint(fake);
  check('a JSON round-trip of markup is NOT markup (the brand is a module-private Symbol)', bar.querySelector('b') === null, bar.innerHTML);
  ui.flashHint(markup.html`<b>${markup.html`<kbd>K</kbd>`}</b>`);
  check('html`` nests html`` without double-escaping', bar.querySelector('b kbd')?.textContent === 'K', bar.innerHTML);
}
check('nothing ran', (globalThis as any).__pwned === undefined);

console.log('\nBUILD INSPECTOR — the real build.js, a thing placed by a hostile name');
const bstub = await import('./hint-text-build-stub.mjs') as any;
const build = await import('../client/lib/build.js');
const ID = 'thing1';
bstub.entities.set(ID, new bstub.THREE.Object3D());
bstub.entityMeta.set(ID, { lib: `deco/${HOSTILE}.glb`, actor: HOSTILE, placer: { id: HOSTILE } });
bstub.comps.set(ID, { guard: true });
bstub.net.myRights = { role: 'builder' };
bstub.net.myId = 'me';
build.setEditMode(true, { quiet: true });
build.select(ID);
const insp = [...document.body.children].find((n) => n.querySelector?.('[data-bact="lock"]')) as HTMLElement | undefined;
check('the inspector painted', !!insp);
check('…with no element from the placer name or the library label', !!insp && insp.querySelector('img') === null, insp?.innerHTML.slice(0, 300));
check('…the placer name shown as its characters', !!insp && (insp.textContent ?? '').includes(HOSTILE), insp?.textContent?.slice(0, 200));
check('…and its own <kbd>/<b> markup intact', !!insp && !!insp.querySelector('b') && !!insp.querySelector('input[data-bact="guard"]'));
const h0 = bstub.hints.length;
(build as any).updateBuild?.();   // harmless; the guarded hint is reached via a drag attempt we can't fake headless
// lockedHint is module-private; reach the same flashHint through the lock checkbox (its hint names the label)
const lock = insp?.querySelector('[data-bact="lock"]') as HTMLInputElement | null;
if (lock) { lock.disabled = false; lock.checked = true; lock.dispatchEvent(new Event('change')); }
const said = bstub.hints.slice(h0).map(String);
check('the lock hint was said', said.length > 0, JSON.stringify(said));
check('…and carries no tag from the label (escaped in html``, or text)', said.every((s: string) => !s.includes('<img')), JSON.stringify(said));

console.log('\nSOURCE SCAN — every hint call carrying a literal tag builds it with html``');
const SINKS = /\b(flashHint|setHint|setAmbientHint)\(/g;   // setInspectorHtml is HTML by name; its callers escape (build.js, seatedit.js)
const TAG = /<\/?(kbd|b|span|i|em|strong|br|u|q)\b/;
const offenders: string[] = [];
let scanned = 0;
for (const f of readdirSync(here('../client/lib')).filter((f) => f.endsWith('.js')).map((f) => `client/lib/${f}`).concat(['client/main.js'])) {
  const src = readFileSync(here(`../${f}`), 'utf8');
  for (const m of src.matchAll(SINKS)) {
    if (/function\s*$/.test(src.slice(Math.max(0, m.index! - 20), m.index!))) continue;   // the definition
    // the call's argument span: balanced parens from the opening one
    let i = m.index! + m[0].length, depth = 1, q: string | null = null;
    const start = i;
    for (; i < src.length && depth; i++) {
      const c = src[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') q = c; else if (c === '(') depth++; else if (c === ')') depth--;
    }
    let arg = src.slice(start, i - 1);
    // one level of indirection: setAmbientHint(hint) — read what `hint` was assigned in the 600 chars before
    if (/^\s*\w+\s*$/.test(arg)) {
      const v = arg.trim(), before = src.slice(Math.max(0, m.index! - 600), m.index!);
      arg = [...before.matchAll(new RegExp(`\\b${v}\\s*=\\s*([^;]+);`, 'g'))].map((x) => x[1]).join(' ; ');
    }
    scanned++;
    // every string literal in the argument that carries a tag must be an html`` template
    for (const lit of arg.matchAll(/(html)?(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g)) {
      if (TAG.test(lit[2]) && !lit[1]) {
        const line = src.slice(0, m.index!).split('\n').length;
        offenders.push(`${f}:${line} ${lit[2].slice(0, 70)}`);
      }
    }
  }
}
check(`scanned the hint calls (${scanned})`, scanned > 40);
check('no hint call passes a tag in a plain string (it would print as literal "<kbd>")', offenders.length === 0, `\n      ${offenders.join('\n      ')}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
