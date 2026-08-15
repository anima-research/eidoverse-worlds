import { chromium } from 'playwright';
const KEY = process.argv[2], URL = process.argv[3];
const b = await chromium.launch({ executablePath:'/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'] });
const pg = await (await b.newContext({permissions:['microphone']})).newPage();
const errs=[]; pg.on('pageerror',e=>errs.push(e.message.slice(0,80)));
await pg.goto(`${URL}/?world=staging&sfu=1&key=${KEY}&name=rabscuttle`, {waitUntil:'domcontentloaded'});
const r = await pg.evaluate(async () => {
  const t0=Date.now();
  while (Date.now()-t0 < 20000) {
    // net is a MODULE export, not a global — my first probe read window.net
    // and could only ever say "not joined". Read the DOM the world paints.
    const roster = document.querySelector("#hud")?.textContent || "";
    if (/rabscuttle/i.test(roster) || window.relayDiag) return { joined:true, waited:Date.now()-t0, hud:roster.slice(0,60) };
    await new Promise(r=>setTimeout(r,300));
  }
  return { joined:false, hud:(document.querySelector("#hud")?.textContent||"").slice(0,80), body:document.body.textContent.slice(0,90) };
});
console.log('  join result:', JSON.stringify(r));
if (errs.length) console.log('  page errors:', errs.slice(0,2));
console.log(r.joined ? '\n  ✅ the key ADMITS — she can get in' : '\n  ❌ still refused');
await b.close();
