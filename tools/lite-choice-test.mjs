// The lite/full decision is a pure function, but it lives INLINE in client/index.html
// (it has to answer before the module graph exists, so it cannot be imported) — so the
// test extracts it from the served HTML rather than keeping a second copy here. A copy
// would drift, and this decision is exactly the kind that gets silently broken: every
// branch below is a device that either gets in or doesn't.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'client/index.html'), 'utf8');

// Pull the decision script out by its test seam, then run it with a stubbed globalThis.
const m = html.match(/<script>\s*\n\s*\/\/ decideLite[\s\S]*?<\/script>/);
if (!m) { console.log('FAIL  could not find the decideLite script in client/index.html'); process.exit(1); }
const src = m[0].replace(/^<script>/, '').replace(/<\/script>$/, '');

// storage and events are real enough to watch the tripwire's lifecycle, not just the decision
const store = new Map(), listeners = {};
const fire = (t, e = {}) => (listeners[t] ?? []).forEach((f) => f(e));
const g = {
  navigator: { deviceMemory: 8, gpu: {} },   // a capable browser, so the page takes the full path and arms
  location: { search: '' },
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  addEventListener: (t, f) => (listeners[t] ??= []).push(f),
  document: { documentElement: { classList: { toggle: () => {} } }, head: { appendChild: () => {} },
              createElement: () => ({}) },
  console: { log: () => {} },
  URLSearchParams,
};
g.globalThis = g;
new Function('globalThis', 'navigator', 'location', 'localStorage', 'document', 'console', 'URLSearchParams', 'addEventListener', src)
  .call(g, g, g.navigator, g.location, g.localStorage, g.document, g.console, URLSearchParams, g.addEventListener);

const decide = g.__ewDecideLite;
if (typeof decide !== 'function') { console.log('FAIL  decideLite was not exposed'); process.exit(1); }

let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };
const d = (q, o = {}) => decide({
  params: new URLSearchParams(q), stored: null, lastBootDied: false,
  deviceMemory: 8, gpuApi: true, mobile: true, ...o,
});

const desk = (q, o = {}) => d(q, { mobile: false, ...o });
console.log('LITE CHOICE');
check('a capable desktop gets the full world', desk('').lite === false && desk('').why === 'default');
check('a phone starts in lite (owner, 10-01)', d('').lite === true && d('').why === 'phone');
check('a phone that chose 3D (saved) gets the full world', d('', { stored: '0' }).lite === false && d('', { stored: '0' }).why === 'saved');
check('…and a saved 3D that then dies is caught once (crash outranks saved)', d('', { stored: '0', lastBootDied: true }).why === 'crash');
check('?lite=0 gives a phone the full world this load', d('lite=0').lite === false);
check('?lite=1 forces lite', d('lite=1').lite === true && d('lite=1').why === 'url');
check('bare ?lite forces lite', d('lite').lite === true);
check('?lite=0 forces full', d('lite=0').lite === false && d('lite=0').why === 'url');

console.log('  -- the crash tripwire --');
check('a died boot sends this device to lite', d('', { lastBootDied: true }).lite === true && d('', { lastBootDied: true }).why === 'crash');
check('a died boot OUTRANKS a saved full preference (no crash loop)',
  d('', { lastBootDied: true, stored: '0' }).lite === true);
check('?lite=0 still overrides a died boot (the manual way back in)',
  d('lite=0', { lastBootDied: true }).lite === false);
check('a died boot reaches iOS, where deviceMemory is absent',
  d('', { lastBootDied: true, deviceMemory: 0 }).lite === true);

console.log('  -- desktops and headsets are never demoted by inference (owner, 10-01) --');
check('a desktop whose last boot died boots FULL again, told why', desk('', { lastBootDied: true }).lite === false && desk('', { lastBootDied: true }).why === 'retry');
check('a desktop whose RETRY died too lands in lite (crash): the pill never loaded to offer it (review #212)', desk('', { lastBootDied: true, retried: true }).lite === true && desk('', { lastBootDied: true, retried: true }).why === 'crash');
check('a died boot on a desktop with no 3D API says no-gpu, not retry', desk('', { lastBootDied: true, gpuApi: false }).why === 'no-gpu');
check('a desktop reporting 2GB still gets the full world', desk('', { deviceMemory: 2 }).lite === false);
check('a desktop with no 3D API still gets lite (a fact, not a guess)', desk('', { gpuApi: false }).lite === true);
check('a desktop that chose lite keeps it', desk('', { stored: '1' }).lite === true);
check('?lite=1 still works on a desktop', desk('lite=1').lite === true);
const mob = g.__ewIsMobile;
const ua = (s, extra = {}) => mob({ userAgent: s, ...extra });
check('isMobile: Android phone', ua('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36'));
check('isMobile: Android tablet (no "Mobile" token)', ua('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/130 Safari/537.36'));
check('isMobile: iPhone', ua('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'));
check('isMobile: iPadOS (reports a Mac, has touch)', ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', { maxTouchPoints: 5 }));
check('isMobile: a real Mac is not', !ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', { maxTouchPoints: 0 }));
check('isMobile: Windows Chrome is not', !ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36'));
check('isMobile: Linux Firefox is not', !ua('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'));
check('isMobile: a Quest headset is not (it needs the full client for VR)', !ua('Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 OculusBrowser/35.0 Chrome/130 VR Safari/537.36'));
check('isMobile: an older Quest that says Android and Mobile is not', !ua('Mozilla/5.0 (Linux; Android 10; Quest 2) AppleWebKit/537.36 OculusBrowser/23.0 SamsungBrowser/4.0 Chrome/110 Mobile VR Safari/537.36'));
check('isMobile: a Pico headset is not', !ua('Mozilla/5.0 (Linux; Android 10; Pico Neo3 Link) AppleWebKit/537.36 Chrome/105 Mobile VR Safari/537.36'));
check('isMobile: Client Hints mobile:true wins', mob({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', userAgentData: { mobile: true } }));
check('isMobile: an unknown browser is not (the cheap wrong guess)', !mob({}));

console.log('  -- the tripwire lifecycle (armed by the page itself) --');
const K = 'ew-boot-attempt:default';
check('a full boot arms the flag before any engine byte', store.has(K));
fire('pagehide', { persisted: false });
check('closing or reloading MID-LOAD is a clean exit: pagehide clears it', !store.has(K),
  'nothing was listening until arrival (the owner closed Chrome mid-load and landed in lite)');
fire('pageshow', { persisted: true });
check('a bfcache restore mid-load re-arms it', store.has(K));
fire('pagehide', { persisted: true }); g.__ewTripDisarmed = true;
fire('pageshow', { persisted: true });
check('once boot.js has disarmed for good, a restore does not re-arm', !store.has(K));
store.set(K, '1'); g.__ewTripDisarmed = false;
check('a crash runs no handler, so the flag survives to the next visit', store.has(K));

console.log('  -- hardware --');
check('no 3D API at all → lite', d('', { gpuApi: false }).lite === true && d('', { gpuApi: false }).why === 'no-gpu');
check('a 2GB phone is lite (it starts there anyway: 4b)', d('', { deviceMemory: 2 }).lite === true && d('', { deviceMemory: 1 }).lite === true);
check('a 4GB desktop is allowed to TRY', desk('', { deviceMemory: 4 }).lite === false);
check('absent deviceMemory is not read as 0GB', desk('', { deviceMemory: 0 }).lite === false);

console.log('  -- saved preference --');
check('saved lite is honoured', d('', { stored: '1' }).lite === true && d('', { stored: '1' }).why === 'saved');
check('saved full is honoured on a healthy device', d('', { stored: '0' }).lite === false);
check('saved full still loses to no-GPU? no — an explicit choice outranks inference',
  d('', { stored: '0', gpuApi: false }).lite === false);
check('?lite=1 overrides saved full', d('lite=1', { stored: '0' }).lite === true);

console.log('  -- the page itself, end to end (the call site, not just the function) --');
const boot = (nav, tripped) => {
  const st = new Map(tripped ? [['ew-boot-attempt:default', '1']] : []);
  const h = { ...g, navigator: { gpu: {}, ...nav }, localStorage: { getItem: (k) => (st.has(k) ? st.get(k) : null), setItem: (k, v) => st.set(k, String(v)), removeItem: (k) => st.delete(k) }, addEventListener: () => {} };
  h.globalThis = h;
  new Function('globalThis', 'navigator', 'location', 'localStorage', 'document', 'console', 'URLSearchParams', 'addEventListener', src)
    .call(h, h, h.navigator, h.location, h.localStorage, h.document, h.console, URLSearchParams, h.addEventListener);
  return { lite: h.__ewLite, why: h.__ewLiteWhy };
};
const winUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const phoneUA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36';
{ // the page spends the retry when it takes it, so a second death in a row lands in lite
  const st = new Map([['ew-boot-attempt:default', '1']]);
  const run2 = () => { const h = { ...g, navigator: { gpu: {}, userAgent: winUA, deviceMemory: 8 }, localStorage: { getItem: (k) => (st.has(k) ? st.get(k) : null), setItem: (k, v) => st.set(k, String(v)), removeItem: (k) => st.delete(k) }, addEventListener: () => {} };
    h.globalThis = h; new Function('globalThis', 'navigator', 'location', 'localStorage', 'document', 'console', 'URLSearchParams', 'addEventListener', src)
      .call(h, h, h.navigator, h.location, h.localStorage, h.document, h.console, URLSearchParams, h.addEventListener); return { lite: h.__ewLite, why: h.__ewLiteWhy }; };
  const a1 = run2();
  check('page: a Windows desktop after a died boot loads FULL (retry), and spends its retry', a1.lite === false && a1.why === 'retry' && st.has('ew-boot-retried:default'), JSON.stringify(a1));
  const a2 = run2();   // that retry died too (no handler ran): the trip key is still set
  check('page: …and if the retry dies too, the next visit is lite (crash)', a2.lite === true && a2.why === 'crash', JSON.stringify(a2));
}
{ const r = boot({ userAgent: phoneUA, deviceMemory: 4 }, true); check('page: an Android phone after a died boot loads lite (crash)', r.lite === true && r.why === 'crash', JSON.stringify(r)); }
{ const r = boot({ userAgent: winUA, deviceMemory: 8 }, false); check('page: a healthy desktop loads full (default)', r.lite === false && r.why === 'default', JSON.stringify(r)); }

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
