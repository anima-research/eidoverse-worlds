// Click the REAL mic button, as a person does. My earlier probe called
// __sfuMic() directly — which works — so the gap must be between the BUTTON
// and the bridge. This closes that gap or proves it isn't there.
import { chromium } from 'playwright';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8960', KEY = process.env.KEY ?? 'dev';
const b = await chromium.launch({ executablePath: process.env.SFU_TEST_CHROME || undefined,
  args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const pg = await (await b.newContext({permissions:['microphone']})).newPage();
const errs=[]; pg.on('pageerror', e=>errs.push(e.message));
pg.on('console', m=>{ const t=m.text(); if(/mic|sfu|voice|stt|error/i.test(t) && !/jank|longtask|THREE|load\]/i.test(t)) console.log('  [pg]', t.slice(0,150)); });
await pg.goto(`${BASE}/?world=staging&key=${KEY}&name=btnprobe`, {waitUntil:'domcontentloaded'});
await pg.fill('#d-name','btnprobe').catch(()=>{}); await pg.click('#d-go').catch(()=>{});
for(let i=0;i<40;i++){ await new Promise(r=>setTimeout(r,1500)); if(await pg.evaluate(()=>!!window.__sfuMic).catch(()=>false)) break; }
console.log('  before:', JSON.stringify(await pg.evaluate(()=>({ sfuMicOn: window.__sfuMicOn?.(), diag: window.relayDiag?.() }))));
// The button lives in the HUD. Find it the way a click would.
const found = await pg.evaluate(() => {
  const els = [...document.querySelectorAll('span,button,div')];
  const el = els.find(e => e.onclick && /mic/i.test(e.className + ' ' + (e.id||'') + ' ' + (e.title||'')))
    || els.find(e => e.onclick && e.innerHTML.includes('svg') && /mic/i.test(e.outerHTML));
  if (!el) return null;
  el.click();
  return { tag: el.tagName, cls: el.className, title: el.title || null };
});
console.log('  clicked:', JSON.stringify(found));
await new Promise(r=>setTimeout(r,5000));
console.log('  after: ', JSON.stringify(await pg.evaluate(()=>({ sfuMicOn: window.__sfuMicOn?.(), diag: window.relayDiag?.() }))));
console.log('  page errors:', errs.length ? errs.slice(0,4) : 'none');
await b.close();
