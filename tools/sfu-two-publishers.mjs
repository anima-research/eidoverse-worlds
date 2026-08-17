// REGRESSION: can TWO people publish to each other at the same time?
//
// The bug (2026-08-15): sfuNegotiate's recvonly "floor" was gated on
// `getTransceivers().length === 0`. With two people present, each leg already
// has a sendonly route to the other before its first negotiation, so the floor
// was skipped and the offer proposed NO receive direction. ontrack never fired;
// diag said publishing:false / rxPackets:0 while both browsers reported
// micPublished:true with thousands of packets sent.
//
// It hid because a SINGLE client has no routes → floor applies → works.
// Every single-client probe passed all day while two humans heard nothing.
import { chromium } from 'playwright';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8960', KEY = process.env.KEY ?? 'dev';
const diag = async () => (await (await fetch(`${BASE}/relay-diag`)).json());
const b = await chromium.launch({ executablePath:'/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required',
        '--disable-features=AudioServiceOutOfProcess','--alsa-output-device=null']});
const mk = async (name) => {
  const pg = await (await b.newContext({permissions:['microphone']})).newPage();
  await pg.goto(`${BASE}/?world=staging&key=${KEY}&name=${name}`, {waitUntil:'domcontentloaded'});
  await pg.waitForSelector('#d-go',{timeout:20000}).catch(()=>{});
  await pg.fill('#d-name',name).catch(()=>{}); await pg.click('#d-go').catch(()=>{});
  for (let i=0;i<40;i++){ await new Promise(r=>setTimeout(r,1500)); if (await pg.evaluate(()=>!!window.__sfuMic).catch(()=>false)) break; }
  return pg;
};
let ok = true;
const step = (l,p,d='') => { console.log(`  ${p?'\x1b[32m✅\x1b[0m':'\x1b[31m❌\x1b[0m'} ${l}${d?' — '+d:''}`); if(!p) ok=false; };

const A = await mk('pubA'); const B = await mk('pubB');
await new Promise(r=>setTimeout(r,4000));
// consent BOTH ways first, so each leg gains an outbound route → the exact
// condition that used to suppress the recvonly floor.
for (const pg of [A,B]) await pg.evaluate(async()=>{ (await import('./lib/voiceconsent.js')).setReceiveVoice(true); });
await new Promise(r=>setTimeout(r,3000));
console.log('  both consenting; now publishing…');
for (const pg of [A,B]) console.log('   mic:', await pg.evaluate(async()=>{ try { return await window.__sfuMic(); } catch(e){ return 'THREW: '+e.message; } }));
await new Promise(r=>setTimeout(r,12000));

const legs = (await diag()).legs;
for (const n of ['pubA','pubB']) {
  const l = legs.find(x=>x.id===n);
  step(`${n}: server sees it PUBLISHING`, l?.publishing === true, `publishing=${l?.publishing}`);
  step(`${n}: server RECEIVED packets`, (l?.rxPackets??0) > 0, `rx=${l?.rxPackets}`);
}
const a = legs.find(x=>x.id==='pubA'), bb = legs.find(x=>x.id==='pubB');
step('they hear each other', a?.hears?.includes('pubB') && bb?.hears?.includes('pubA'),
     `A.hears=${JSON.stringify(a?.hears)} B.hears=${JSON.stringify(bb?.hears)}`);
console.log(ok ? '\n\x1b[32m✅ sfu-two-publishers: PASS\x1b[0m' : '\n\x1b[31m❌ sfu-two-publishers: FAIL\x1b[0m');
await b.close(); process.exit(ok?0:1);
