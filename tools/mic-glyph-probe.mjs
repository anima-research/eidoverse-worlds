// Does the HUD glyph read a LIVE level on the SFU? (R: "the mic icon isn't
// turning gold anymore when it is transmitting"). Both the glyph and the
// audio-panel bar polled voice.js's mesh analyser, which is 0 forever here.
import { chromium } from 'playwright';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8960';
const b = await chromium.launch({ executablePath:'/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required',
        '--disable-features=AudioServiceOutOfProcess','--alsa-output-device=null']});
const pg = await (await b.newContext({permissions:['microphone']})).newPage();
const errs=[]; pg.on('pageerror', e=>errs.push(e.message));
await pg.goto(`${BASE}/?world=staging&key=staging-2026&name=glyphprobe`, {waitUntil:'domcontentloaded'});
await pg.waitForSelector('#d-go',{timeout:20000}).catch(()=>{});
await pg.fill('#d-name','glyphprobe').catch(()=>{}); await pg.click('#d-go').catch(()=>{});
for(let i=0;i<40;i++){ await new Promise(r=>setTimeout(r,1500)); if(await pg.evaluate(()=>!!window.__sfuMic).catch(()=>false)) break; }
console.log('  mic:', await pg.evaluate(async()=>{try{return await window.__sfuMic();}catch(e){return 'THREW '+e.message;}}));
await new Promise(r=>setTimeout(r,6000));
// the fake device is a tone, so a live analyser must read > 0
// sample over 3s: the fake device is a slow sine, so one sample can catch a
// zero crossing. Peak is what the glyph threshold actually compares against.
let peak = 0;
for (let i=0;i<30;i++){ const v = await pg.evaluate(()=>window.__sfuMyLevel?.()) ?? 0; if (v>peak) peak=v; await new Promise(r=>setTimeout(r,100)); }
console.log('  __sfuMyLevel peak over 3s:', peak.toFixed(4), '(glyph hot threshold is 0.02)');
console.log(peak > 0.02 ? '  ✅ crosses the hot threshold — glyph will go gold'
  : peak > 0.001 ? '  ⚠️  live but below threshold (quiet fake device, not a dead analyser)'
  : '  ❌ dead analyser');
console.log('  page errors:', errs.length?errs.slice(0,3):'none');
await b.close(); process.exit(peak>0.001?0:1);
