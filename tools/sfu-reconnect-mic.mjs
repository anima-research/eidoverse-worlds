// REGRESSION: does the mic still publish after a RECONNECT?
//
// The bug (2026-08-15): sfuConnect() built a new pc but kept the OLD micStream,
// so the bridge's wanted-mic replay hit sfuMic's `if (micStream) …return` and
// never called addTrack on the live pc. Badge ON, server publishing=false,
// rx=0 — for an entire session, while a freshly-loaded tab worked fine. That
// asymmetry is why it survived every probe I wrote: they all started fresh.
import { chromium } from 'playwright';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8960', KEY = process.env.KEY ?? 'dev';
const diag = async () => (await (await fetch(`${BASE}/relay-diag`)).json());
const legOf = async (id) => (await diag()).legs.find((l) => l.id === id);

const b = await chromium.launch({ executablePath: process.env.SFU_TEST_CHROME || undefined,
  args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required',
        '--disable-features=AudioServiceOutOfProcess','--alsa-output-device=null']});
const pg = await (await b.newContext({permissions:['microphone']})).newPage();
pg.on('pageerror', e => console.log('  PAGEERROR:', e.message.slice(0,140)));
await pg.goto(`${BASE}/?world=staging&key=${KEY}&name=reconprobe`, {waitUntil:'domcontentloaded'});
await pg.waitForSelector('#d-go',{timeout:20000}).catch(()=>{});
await pg.fill('#d-name','reconprobe').catch(()=>{}); await pg.click('#d-go').catch(()=>{});
for (let i=0;i<40;i++){ await new Promise(r=>setTimeout(r,1500)); if (await pg.evaluate(()=>!!window.__sfuMic).catch(()=>false)) break; }

let ok = true;
const step = (label, pass, detail='') => { console.log(`  ${pass?'\x1b[32m✅\x1b[0m':'\x1b[31m❌\x1b[0m'} ${label}${detail?' — '+detail:''}`); if(!pass) ok=false; };

console.log('  mic on (first connection):', await pg.evaluate(()=>window.__sfuMic()));
await new Promise(r=>setTimeout(r,6000));
let leg = await legOf('reconprobe');
step('publishes BEFORE the reconnect', leg?.publishing === true, `publishing=${leg?.publishing}`);
const rxBefore = leg?.rxPackets ?? 0;

// Force a reconnect the way the world does: drop the socket, let it re-join.
console.log('  forcing a reconnect (closing the world socket)…');
await pg.evaluate(async () => { const n = await import('./lib/net.js'); n.net.ws.close(4000,'test'); });
await new Promise(r=>setTimeout(r,15000));
for (let i=0;i<20;i++){ if ((await legOf('reconprobe'))?.state === 'connected') break; await new Promise(r=>setTimeout(r,1500)); }
await new Promise(r=>setTimeout(r,8000));

leg = await legOf('reconprobe');
step('leg is back', !!leg, `state=${leg?.state}`);
step('badge and reality AGREE after reconnect',
     (await pg.evaluate(()=>window.__sfuMicOn())) === (leg?.publishing === true),
     `badge=${await pg.evaluate(()=>window.__sfuMicOn())} server.publishing=${leg?.publishing}`);
step('STILL PUBLISHING after the reconnect', leg?.publishing === true, `publishing=${leg?.publishing}`);
step('and packets are actually arriving', (leg?.rxPackets ?? 0) > rxBefore,
     `rx ${rxBefore} → ${leg?.rxPackets}`);
console.log(ok ? '\n\x1b[32m✅ sfu-reconnect-mic: PASS\x1b[0m' : '\n\x1b[31m❌ sfu-reconnect-mic: FAIL\x1b[0m');
await b.close();
process.exit(ok?0:1);
