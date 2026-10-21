// ?orrery= is a link parameter (a self-hosted Orrery for the conjure panel), remembered in localStorage. It was taken
// verbatim and interpolated into the panel's markup and into window.open — so a link someone sent you could inject
// markup into this origin, and keep injecting it on every later visit. Only an http(s) ORIGIN is accepted now, and
// the login popup only opens an http(s) URL.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/orrery-param-test.ts
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({ name: 'orrery-stubs', setup(b) {
  for (const m of ['base', 'icons', 'ui', 'net', 'build', 'chat'])
    b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./orrery-param-stub.mjs') }));
} });
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// a value that is not an origin: an attribute break-out after a plausible host
const HOSTILE = 'https://orrery.example/"><img src=x onerror="globalThis.__pwned=1">';
// MODE (review of 4098ff7, Oscar-1808 #5b): 'param' = the hostile value arrives in the link; 'stored' = it was REMEMBERED by
// an earlier visit (localStorage ew-orrery-url holds the raw value) and the link carries nothing — the path that made the
// old injection persist. The file runs itself again in the second mode at the end.
const MODE = process.env.ORRERY_MODE ?? 'param';
if (MODE === 'stored') localStorage.setItem('ew-orrery-url', HOSTILE);
(globalThis as any).__ORRERY_QS = MODE === 'param' ? `orrery=${encodeURIComponent(HOSTILE)}` : '';
const fetched: string[] = [];
let loginUrl = 'javascript:globalThis.__pwned=1';
let signedIn = false;
globalThis.fetch = (async (url: string) => {
  fetched.push(String(url));
  if (/\/api\/auth\/me$/.test(url)) return signedIn ? new Response('{"name":"t"}', { status: 200 }) : new Response('no', { status: 401 });
  if (/\/api\/auth\/config$/.test(url)) return new Response(JSON.stringify({ login_url: loginUrl }), { status: 200 });
  return new Response('[]', { status: 200 });
}) as any;
const opened: string[] = [];
(globalThis as any).open = (u: string) => { opened.push(String(u)); return null; };
(globalThis as any).window.open = (globalThis as any).open;

console.log('?orrery= — a hostile link');
const stub = await import('./orrery-param-stub.mjs') as any;
const conjure = await import('../client/lib/conjure.js');
conjure.initConjure();
const stored = localStorage.getItem('ew-orrery-url');
// what's remembered (or what a remembered hostile value became) is an http(s) base re-serialised by the URL parser:
// origin + percent-encoded path, no query, hash or credentials (an Orrery under a path keeps its path; #4)
const isBase = (v: string) => { try { const u = new URL(v); return /^https?:$/.test(u.protocol) && v === u.origin + u.pathname.replace(/\/$/, '') && /^(\/[A-Za-z0-9._-]+)*$/.test(u.pathname.replace(/\/$/, '')) && !u.search && !u.hash; } catch { return false; } };
if (MODE === 'param') check('the remembered value is an http(s) base, never the raw parameter', stored === null || isBase(stored), String(stored));
else check('a hostile remembered value is not rewritten by a link that names nothing (left for the panel to refuse)', stored === HOSTILE, String(stored));
check('…and what the panel will use carries no markup', !String(stored ?? '').includes('<') || MODE === 'stored', String(stored));

const sec = stub.sections.find((s: any) => /conjure/.test(s.title));
const body = document.createElement('div');
await sec.onOpen(body);
await tick();
check('the panel asked an http(s) origin for auth', fetched.length > 0 && fetched.every((u) => /^https?:\/\/[^/"<>]+\/api\//.test(u)), JSON.stringify(fetched));
check('the sign-in panel holds no element smuggled in through the link', body.querySelector('img') === null, body.innerHTML.slice(0, 200));

console.log('\nthe login popup');
(body.querySelector('#cj-connect') as HTMLButtonElement | null)?.click();
await tick(); await tick();
check('a javascript: login link from the Orrery is not opened', opened.every((u) => /^https?:/.test(u)), JSON.stringify(opened));
// the control: the same button with an ordinary https login link DOES open it (so the guard isn't refusing everything)
loginUrl = 'https://orrery.example/login';
const body1b = document.createElement('div');
await sec.onOpen(body1b);
await tick();
(body1b.querySelector('#cj-connect') as HTMLButtonElement | null)?.click();
await tick(); await tick();
check('…while an https login link is opened', opened.includes('https://orrery.example/login'), JSON.stringify(opened));

console.log('\nthe signed-in panel (it links to the Orrery by name)');
// a fresh module instance (its `connected` state starts unknown) against an Orrery that says you are signed in
signedIn = true;
const stub2 = stub.sections.length;
const conjure2 = await import('../client/lib/conjure.js?signed-in');
conjure2.initConjure();
const body2 = document.createElement('div');
await stub.sections[stub2].onOpen(body2);
await tick();
check('the signed-in panel painted its Orrery link', !!body2.querySelector('a[target="_blank"]'), body2.innerHTML.slice(0, 200));
check('…and holds no element smuggled in through the link', body2.querySelector('img') === null, body2.innerHTML.slice(-300));
check('nothing ran', (globalThis as any).__pwned === undefined);

console.log('\n?orrery= — an Orrery under a path keeps its path (#4)');
{ const { originOf } = conjure as any;
  check('originOf keeps origin + path and drops query, hash and credentials', originOf('https://host.example/orrery/?x=1#f') === 'https://host.example/orrery' && originOf('https://u:p@host.example/') === null && originOf('javascript:1') === null && originOf(HOSTILE) === 'https://orrery.example', String(originOf?.('https://host.example/orrery/?x=1#f'))); }

console.log(`\n[${MODE}] ${pass} passed, ${fail} failed\n`);
if (fail || MODE !== 'param') process.exit(fail ? 1 : 0);   // happy-dom keeps the loop alive: exit explicitly
const r = Bun.spawnSync(['bun', import.meta.path], { env: { ...process.env, ORRERY_MODE: 'stored' }, stdout: 'inherit', stderr: 'inherit' });
process.exit(r.exitCode);
