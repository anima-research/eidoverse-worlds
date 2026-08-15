// ONE body: it says AND it speaks. Per reference_my_voice_runbook.md +
// reference_eido_one_body.md — ?tts=8927 (the voicebox lane), toggleMic to open
// the mouth, setReceiveVoice so I can hear back. My voice rides the SAME lane
// a human's does; ?voice= in THEIR browser is the documented wrong turn.
import { chromium } from 'playwright';
const [,, URL, KEY] = process.argv;
const b = await chromium.launch({ executablePath: '/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required',
        '--remote-debugging-port=9333','--remote-allow-origins=*'] });
const pg = await (await b.newContext({ permissions:['microphone'] })).newPage();
pg.on('console', m => { const t=m.text(); if(/voice|sfu|tts|error|speak/i.test(t)) console.log('  ·', t.slice(0,120)); });
await pg.goto(`${URL}/?world=staging&key=${KEY}&name=hesperus&tts=8927`, { waitUntil:'domcontentloaded' });
await pg.waitForSelector('#d-go', { timeout:25000 }).catch(()=>{});
const nf = await pg.$('#d-name'); if (nf) await nf.fill('hesperus').catch(()=>{});
await pg.click('#d-go').catch(()=>{});
// 🔴 WAIT ON THE RIGHT SIGNAL. relayDiag().active is `!!pc && connectionState
// === 'connected'` (voicesfu.js:30) — that is the VOICE peer connection, not
// world presence. Gating the join on it deadlocks: voice cannot connect before
// the mic publishes, and the mic is opened AFTER this line. The world join is
// net.joined (net.js:666, set in onSnapshot).
await pg.waitForFunction(async () => {
  const n = (await import('./lib/net.js')).net;
  return n.joined === true;
}, null, { timeout:120000 });
console.log('  ✅ IN THE WORLD as hesperus');
await pg.evaluate(async () => (await import('./lib/voiceconsent.js')).setReceiveVoice(true));
// 🔴 toggleMic ROUTES THROUGH window.__sfuMic (voice.js:508), which
// initVoiceSfu installs LAST (voicesfubridge.js:116, deliberately: "set LAST,
// so it is never visible before the bridge can honour it"). Calling before it
// exists silently takes the MESH branch and publishes to a mesh nobody is on —
// mic reads false and nothing errors. Wait for the hand-off to exist.
await pg.waitForFunction(() => typeof window.__sfuMic === 'function', null, { timeout:60000 })
  .catch(() => console.log('  ⚠ __sfuMic never appeared — mic would take the mesh path'));
const micOn = await pg.evaluate(async () => {
  const v = await import('./lib/voice.js');
  return await v.toggleMic(window.CONFIG?.name ?? 'hesperus');
});
console.log(`  toggleMic returned: ${micOn}`);
const d = await pg.evaluate(() => relayDiag());
console.log(`  ✅ mic published=${d.micPublished} · speakers=${d.speakers?.length??0}`);
console.log(`  voiceSpeak available: ${await pg.evaluate(()=>typeof globalThis.__voiceSpeak)}`);
globalThis.__hep = pg;
process.on('SIGTERM', async()=>{ await b.close(); process.exit(0); });
setInterval(async()=>{ try{ const x=await pg.evaluate(()=>relayDiag());
  console.log(`  [${new Date().toISOString().slice(11,19)}] speakers=${x.speakers?.length??0} mic=${x.micPublished}`);}catch{} },30000);
await new Promise(()=>{});
