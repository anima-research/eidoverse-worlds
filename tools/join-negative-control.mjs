import { chromium } from 'playwright';
const [,, URL, KEY, label] = process.argv;
const b = await chromium.launch({ executablePath:'/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args:['--use-fake-ui-for-media-stream'] });
const pg = await (await b.newContext({permissions:['microphone']})).newPage();   // FRESH context, no localStorage
await pg.goto(`${URL}/?world=staging&key=${KEY}&name=rabscuttle`, {waitUntil:'domcontentloaded'});
const r = await pg.evaluate(async () => { const t0=Date.now(); while(Date.now()-t0<15000){ const h=document.querySelector('#hud')?.textContent||''; if(/rabscuttle @/.test(h)) return {joined:true,hud:h.slice(0,55)}; await new Promise(r=>setTimeout(r,300)); } return {joined:false, body:(document.body.textContent||'').replace(/\s+/g,' ').slice(0,90)}; });
console.log(`  ${label}: ${JSON.stringify(r)}`);
await b.close();
