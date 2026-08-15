import { chromium } from 'playwright';
const [,, URL, KEY] = process.argv;
const b = await chromium.launch({ executablePath:'/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'] });
const pg = await (await b.newContext({permissions:['microphone']})).newPage();
const logs=[]; pg.on('console',m=>logs.push(m.text().slice(0,100))); pg.on('pageerror',e=>logs.push('PAGEERR '+e.message.slice(0,90)));
await pg.goto(`${URL}/?world=staging&key=${KEY}&name=looker`, {waitUntil:'domcontentloaded'});
await new Promise(r=>setTimeout(r,6000));
const st = await pg.evaluate(() => ({
  hasDoor: !!document.querySelector('#d-go'),
  doorVisible: (()=>{const e=document.querySelector('#d-go'); if(!e) return null; const r=e.getBoundingClientRect(); return r.width>0&&r.height>0;})(),
  transport: window.__voiceTransport ?? '(unset)',
  bodyStart: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,110),
}));
console.log('  state:', JSON.stringify(st));
console.log('  console:', logs.slice(0,5));
await b.close();
