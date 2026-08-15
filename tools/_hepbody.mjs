// A body for me in the world, over the SAME tunnel R is on (real network path).
import { chromium } from 'playwright';
const [,, URL, KEY] = process.argv;
const b = await chromium.launch({ executablePath: '/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'] });
const pg = await (await b.newContext({ permissions: ['microphone'] })).newPage();
pg.on('console', m => { const t = m.text(); if (/voice|sfu|error/i.test(t)) console.log('  ·', t.slice(0,110)); });
await pg.goto(`${URL}/?world=staging&key=${KEY}&name=hesperus`, { waitUntil: 'domcontentloaded' });
await pg.waitForSelector('#d-go', { timeout: 25000 }).catch(()=>{});
const nf = await pg.$('#d-name'); if (nf) await nf.fill('hesperus').catch(()=>{});
await pg.click('#d-go').catch(()=>{});
await pg.waitForFunction(() => window.relayDiag?.().active === true, null, { timeout: 90000 });
console.log('  ✅ in the world as hesperus');
await pg.evaluate(async () => (await import('./lib/voiceconsent.js')).setReceiveVoice(true));
console.log('  ✅ listening (receive consent on)');
globalThis.__pg = pg;
setInterval(async () => {
  try { const d = await pg.evaluate(() => relayDiag());
    console.log(`  [${new Date().toISOString().slice(11,19)}] speakers=${d.speakers?.length??0} mic=${d.micPublished}`); } catch {}
}, 20000);
await new Promise(() => {});   // stay
