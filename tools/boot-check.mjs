// boot-check — does the served client BOOT AT ALL? The whole suite is node-side
// and could not see a syntax error that killed the browser at module load
// (2026-08-16: the mesh-deletion commit left an orphaned `}` in main.js and
// staging served a dead client for five hours while every test stayed green).
// This is the "what does it print when broken" instrument for the client.
import { chromium } from 'playwright';
const ORIGIN = process.argv[2] || 'http://127.0.0.1:8960';
const KEY = process.env.JOIN_KEY || 'staging-2026';
const b = await chromium.launch({ executablePath: '/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const pg = await (await b.newContext()).newPage();
const errs = [];
pg.on('pageerror', e => errs.push(e.message));
await pg.goto(`${ORIGIN}/?world=staging&name=bootcheck&key=${KEY}`, { waitUntil: 'networkidle' });
await new Promise(r => setTimeout(r, 3000));
const n = await pg.evaluate(() => document.querySelectorAll('.sec').length);
await b.close();
if (errs.length) { console.log('FAIL — page errors:\n  ' + errs.slice(0,4).join('\n  ')); process.exit(1); }
if (!n) { console.log('FAIL — zero .sec panels rendered (boot died silently)'); process.exit(1); }
console.log(`ok — client boots, ${n} panels rendered, no page errors`);
