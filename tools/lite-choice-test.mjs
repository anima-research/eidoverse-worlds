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

const g = {
  navigator: { deviceMemory: 8 },
  location: { search: '' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { documentElement: { classList: { toggle: () => {} } }, head: { appendChild: () => {} },
              createElement: () => ({}) },
  console: { log: () => {} },
  URLSearchParams,
};
g.globalThis = g;
new Function('globalThis', 'navigator', 'location', 'localStorage', 'document', 'console', 'URLSearchParams', src)
  .call(g, g, g.navigator, g.location, g.localStorage, g.document, g.console, URLSearchParams);

const decide = g.__ewDecideLite;
if (typeof decide !== 'function') { console.log('FAIL  decideLite was not exposed'); process.exit(1); }

let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };
const d = (q, o = {}) => decide({
  params: new URLSearchParams(q), stored: null, lastBootDied: false,
  deviceMemory: 8, gpuApi: true, ...o,
});

console.log('LITE CHOICE');
check('a capable device gets the full world', d('').lite === false && d('').why === 'default');
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

console.log('  -- hardware --');
check('no 3D API at all → lite', d('', { gpuApi: false }).lite === true && d('', { gpuApi: false }).why === 'no-gpu');
check('2GB or less → lite', d('', { deviceMemory: 2 }).lite === true && d('', { deviceMemory: 1 }).lite === true);
check('4GB is allowed to TRY (the tripwire catches it if it cannot)', d('', { deviceMemory: 4 }).lite === false);
check('absent deviceMemory is not read as 0GB', d('', { deviceMemory: 0 }).lite === false);

console.log('  -- saved preference --');
check('saved lite is honoured', d('', { stored: '1' }).lite === true && d('', { stored: '1' }).why === 'saved');
check('saved full is honoured on a healthy device', d('', { stored: '0' }).lite === false);
check('saved full still loses to no-GPU? no — an explicit choice outranks inference',
  d('', { stored: '0', gpuApi: false }).lite === false);
check('?lite=1 overrides saved full', d('lite=1', { stored: '0' }).lite === true);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
