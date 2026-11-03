// media-trust-tabs-test — "Allow untrusted links" turned off in one tab reaches the others: mediaprefs.js listens for the
// browser's storage event on its key and re-emits media:trust, which pictures/sounds/materialcomp re-read on (bot #141).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/media-trust-tabs-test.ts
// Mutation (must go red): in client/lib/mediaprefs.js drop the addEventListener('storage', …) line.
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
// the page's window: record storage listeners so the test can play another tab's write
const storageListeners: ((e: any) => void)[] = [];
const realAdd = (globalThis as any).addEventListener?.bind(globalThis);
(globalThis as any).addEventListener = (t: string, fn: any, ...rest: any[]) => { if (t === 'storage') storageListeners.push(fn); else realAdd?.(t, fn, ...rest); };
const { bus } = await import('../client/lib/base.js');
const M = await import('../client/lib/mediaprefs.js');
const seen: any[] = []; bus.on('media:trust', (p: any) => seen.push(p));
check('setup: mediaprefs registered a storage listener', storageListeners.length === 1, String(storageListeners.length));
M.setAllowUntrusted(true);
check('this tab: opting in emits media:trust on', seen.length === 1 && seen[0].allowUntrusted === true, JSON.stringify(seen));
// another tab revokes: the browser fires storage on this window with the key and its new value (localStorage already updated)
store.set(M.UNTRUSTED_KEY, '0'); for (const fn of storageListeners) fn({ key: M.UNTRUSTED_KEY, newValue: '0', oldValue: '1' });
check('another tab\'s revoke reaches this tab: media:trust off, and allowUntrusted() reads off', seen.length === 2 && seen[1].allowUntrusted === false && M.allowUntrusted() === false, JSON.stringify(seen));
for (const fn of storageListeners) fn({ key: 'ew-something-else', newValue: '1', oldValue: null });
check('a storage event on another key is ignored', seen.length === 2, JSON.stringify(seen));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
