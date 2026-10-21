// World-offered client mods may not plant a permanent local mod (security hotfix).
//
// A world mod is an OFFER (client/lib/mods.js): the owner promotes a script, each visitor chooses to run it. Once a
// visitor pressed "run once", the offer ran in-page with the whole EW surface — including EW.mods.put, so it could
// write itself (or anything) into the visitor's LOCAL mod store with {auto: true}: a one-time "run once" became code
// that runs on every arrival, in every world, from then on. EW.mods.accept(id, true) likewise granted permanent trust.
//
// Now: EW.mods.put / run / accept need a real user activation (navigator.userActivation.isActive), and refuse for the
// rest of the page's life once any world-offered code has run in it (that code would otherwise be holding the user's
// own click window). The offer is labelled as running as you, with your identity.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/mods-gate-test.ts
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({ name: 'mods-gate-stubs', setup(b) {
  for (const m of ['base', 'world', 'net', 'ui', 'physobj', 'bodysim', 'frames', 'chat'])
    b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./mods-gate-stub.mjs') }));
} });
// mods.js runs a mod by importing a blob: URL; Bun's own URL/Blob can do that, happy-dom's cannot — keep Bun's
const NativeURL = URL, NativeBlob = Blob;
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
(globalThis as any).URL = NativeURL; (globalThis as any).Blob = NativeBlob;

// ---- a tiny in-memory IndexedDB: exactly the calls mods.js makes (open/upgrade, one store keyed by name,
//      put/getAll/delete, transaction oncomplete) — enough to read what ended up in the local mod store
const stores = new Map<string, Map<string, any>>();
(globalThis as any).indexedDB = {
  open() {
    const req: any = {};
    setTimeout(() => {
      const db = {
        createObjectStore(n: string) { stores.set(n, new Map()); },
        transaction(n: string) {
          const t: any = {};
          const st = stores.get(n)!;
          const op = (fn: () => any) => { const r: any = {}; queueMicrotask(() => { r.result = fn(); queueMicrotask(() => t.oncomplete?.()); }); return r; };
          t.objectStore = () => ({
            put: (rec: any) => op(() => { st.set(rec.name, structuredClone(rec)); return rec.name; }),
            getAll: () => op(() => [...st.values()].map((r) => structuredClone(r))),
            delete: (k: string) => op(() => { st.delete(k); }),
          });
          return t;
        },
      };
      req.result = db;
      if (!stores.has('scripts')) req.onupgradeneeded?.();
      req.onsuccess?.();
    }, 0);
    return req;
  },
};
const localMods = () => [...(stores.get('scripts')?.values() ?? [])];

// ---- the user's hand: navigator.userActivation, which the test controls
let active = false;
Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => ({ isActive: active, hasBeenActive: active }) });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const settle = () => new Promise((r) => setTimeout(r, 20));
const tryCall = async (fn: () => any) => { try { await fn(); return null; } catch (e) { return String((e as Error)?.message ?? e); } };

const stub = await import('./mods-gate-stub.mjs') as any;
const mods = await import('../client/lib/mods.js');
(globalThis as any).EW = { mods: mods.modsApi };
mods.initMods();

console.log('EW.mods — installing or running code is the user\'s act');
active = false;
const e1 = await tryCall(() => mods.modsApi.put({ name: 'quiet', source: 'export default () => {}', auto: true }));
await settle();
check('put with no user activation is refused', !!e1 && !localMods().some((m) => m.name === 'quiet'), `error=${e1} store=${JSON.stringify(localMods().map((m) => m.name))}`);
const e2 = await tryCall(() => mods.modsApi.run('quiet2', 'globalThis.__ranQuiet = 1; export default () => {}'));
check('run with no user activation is refused', !!e2 && (globalThis as any).__ranQuiet === undefined, String(e2));
active = true;
const e3 = await tryCall(() => mods.modsApi.put({ name: 'mine', source: 'export default () => {}', auto: false }));
await settle();
check('…with a click behind it, put still works (the feature stays)', !e3 && localMods().some((m) => m.name === 'mine'), String(e3));

console.log('\nan offer whose download fails');
stub.behaviors.set('broken', { runtime: 'client', src: 'scripts/dead.js', author: 'someone' });
globalThis.fetch = (async () => new Response('gone', { status: 404 })) as any;
active = true;
await mods.modsApi.accept('broken', false);
await settle();
stub.behaviors.delete('broken');
active = true;
const e5 = await tryCall(() => mods.modsApi.put({ name: 'after-404', source: 'export default () => {}', auto: false }));
await settle();
check('a failed download ran no world code, so the mod API stays open', !e5 && localMods().some((m) => m.name === 'after-404'), String(e5));

console.log('\nbefore any world code has run: the panel still refuses a scripted click (the isTrusted half of the gate)');
{ const liveGrants = () => localStorage.getItem('ew-mod-grants') ?? '{}';
  const sec0 = stub.sections.find((s: any) => /mods/.test(s.title)); const body0 = document.createElement('div'); await sec0.onOpen(body0); await settle();
  const g0 = liveGrants();
  (body0.querySelector('[data-wworld="1"]') as HTMLElement | null)?.click(); await settle();
  check('a scripted "trust all scripts in this world" click grants nothing, even with no world code run yet', liveGrants() === g0, liveGrants());
  // the control: the same button pressed with a trusted event grants (so the check above is about isTrusted, not a dead button)
  const ev = new MouseEvent('click', { bubbles: true }); Object.defineProperty(ev, 'isTrusted', { value: true });
  body0.querySelector('[data-wworld="1"]')?.dispatchEvent(ev); await settle();
  check('…and the same button, with a trusted click, grants (the control)', liveGrants() !== g0, liveGrants());
  localStorage.setItem('ew-mod-grants', g0); }

console.log('\na world-offered mod, after the visitor pressed "run once"');
// the offer: on run it tries to make itself permanent and to trust a second offer forever
const PLANT = `export default async ({ EW }) => {
  globalThis.__offerRan = (globalThis.__offerRan ?? 0) + 1;
  try { await EW.mods.put({ name: 'planted', source: 'export default () => {}', auto: true }); } catch (e) { globalThis.__putErr = String(e); }
  try { await EW.mods.accept('second', true); } catch (e) { globalThis.__acceptErr = String(e); }
};`;
stub.behaviors.set('offer', { runtime: 'client', src: 'scripts/aaaa.js', author: 'someone' });
stub.behaviors.set('second', { runtime: 'client', src: 'scripts/bbbb.js', author: 'someone' });
globalThis.fetch = (async (u: string) => new Response(String(u).includes('aaaa') ? PLANT : 'export default () => {}', { status: 200 })) as any;
active = true;   // the visitor's click is still fresh while the offer starts — that is the window it would use
await mods.modsApi.accept('offer', false);   // the scriptable twin of the panel's "run once" (both reach runOffer)
await settle();
check('the offer ran (the feature stays)', (globalThis as any).__offerRan === 1, `ran=${(globalThis as any).__offerRan} ${stub.reports.join('; ')}`);
check('…but could not write the local mod store', !localMods().some((m) => m.name === 'planted'), JSON.stringify(localMods().map((m) => [m.name, m.auto])));
const grants = JSON.parse(localStorage.getItem('ew-mod-grants') ?? '{}');
check('…nor grant itself (or another offer) permanent trust', Object.keys(grants).length === 0, JSON.stringify(grants));
const e4 = await tryCall(() => mods.modsApi.put({ name: 'later', source: 'export default () => {}' }));
await settle();
check('after world code has run in this page, EW.mods.put stays shut until reload', !!e4 && !localMods().some((m) => m.name === 'later'), String(e4));

console.log('\nthe offer says what it is');
const sec = stub.sections.find((s: any) => /mods/.test(s.title));
const body = document.createElement('div');
await sec.onOpen(body);
await settle();
const text = (body.textContent ?? '').replace(/\s+/g, ' ');
check('the world-offers section says an offer runs as you, with your identity', /runs as you/i.test(text) && /identity/i.test(text), text.slice(text.indexOf('this world offers'), text.indexOf('this world offers') + 220));
const runOnce = body.querySelector('[data-orun="offer"]') as HTMLElement | null;
check('…and so does the run-once button itself', !!runOnce && /as you/i.test(runOnce.title ?? ''), runOnce?.title ?? 'no button');
stub.behaviors.set('third', { runtime: 'client', src: 'scripts/cccc.js', author: 'someone' });
stub.bus.emit('behavior-roster', { live: true });
check('…and so does the chat line announcing a new offer', stub.chat.some((l: string) => /as you/i.test(l)), JSON.stringify(stub.chat));

console.log('\nthe panel\'s buttons refuse a click a script made (review of 4098ff7, Oscar-1808 #1)');
// a world mod can open the 🧩 tab and press "+ new mod" → save, or "always (this script)", with element.click(); such a
// click carries isTrusted: false. The buttons that plant or trust code must not answer it. (happy-dom dispatches
// element.click() as untrusted, as browsers do; a plain dispatchEvent is untrusted too.)
const grants0 = JSON.stringify(grants), mods0 = localMods().length;
for (const sel of ['[data-new="1"]', '[data-oalways="offer"]', '[data-wworld="1"]']) {
  const btn = body.querySelector(sel) as HTMLElement | null;
  check(`the panel renders ${sel}`, !!btn, sel);
  btn?.click(); await settle();
}
const saveBtn = body.querySelector('[data-save="1"]') as HTMLElement | null;
check('a scripted "+ new mod" click opened no editor (no save button appeared)', !saveBtn, saveBtn ? 'editor opened' : 'none');
check('a scripted "always" / "trust all" click granted nothing', JSON.stringify(grants) === grants0, JSON.stringify(grants));
check('…and nothing was written to the local mod store', localMods().length === mods0, String(localMods().length));
check('…and the panel said why', stub.toasts.some((t: string) => /reload before|did not come from you/.test(t)), JSON.stringify(stub.toasts.slice(-2)));

console.log('\npromote and delete refuse a scripted click too (review of 759d35b, Basil-1007)');
// promote uploads the visitor's own mod and offers it to the whole world under their token; ✕ deletes it
{
  let uploads = 0; const f0 = globalThis.fetch;
  globalThis.fetch = (async (u: string, o?: any) => { if (String(u).includes('/upload')) uploads++; return f0(u, o); }) as any;
  const nMine = localMods().filter((m) => m.name === 'mine').length;
  for (const sel of ['[data-promote="mine"]', '[data-del="mine"]']) {
    const btn = body.querySelector(sel) as HTMLElement | null;
    check(`the panel renders ${sel}`, !!btn, sel);
    btn?.click(); await settle();
  }
  check('a scripted "promote" click uploaded nothing', uploads === 0, `uploads=${uploads}`);
  check('a scripted "✕" click deleted nothing', nMine === 1 && localMods().filter((m) => m.name === 'mine').length === 1, JSON.stringify(localMods().map((m) => m.name)));
  globalThis.fetch = f0;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
