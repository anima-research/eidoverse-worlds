// relay-browser-smoke — TWO real Chromium bodies through the ?relay=1 leg.
// A publishes a fake-device mic over the relay; B consents to receive and the
// envelope check (the ONE speech check — voice doctrine) must show real
// amplitude on B's speaker element for A. Proves the browser half of the
// contract the rtc-node e2e proved headlessly.
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8941';
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: [
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
] });
const mk = async (name) => {
  const pg = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
  pg.on('console', (m) => { if (/relay|error/i.test(m.text())) console.log(`  [${name}] ${m.text().slice(0, 120)}`); });
  await pg.goto(`${BASE}/?world=staging&relay=1&name=${name}`);
  await pg.waitForFunction(() => window.relayDiag?.().active === true, null, { timeout: 90000 });
  return pg;
};

console.log('launching A (speaker) and B (listener)…');
const A = await mk('smoke-a');
const B = await mk('smoke-b');
console.log('  ✅ both joined the relay:', await A.evaluate(() => relayDiag().identity), '+', await B.evaluate(() => relayDiag().identity));

await A.evaluate(() => window.relayMic());                     // publish fake mic
await A.waitForFunction(() => relayDiag().micPublished === true, null, { timeout: 30000 });
console.log('  ✅ A publishing');

// B consents (the audio panel's toggle drives the same bus event)
await B.evaluate(async () => (await import('./lib/voiceconsent.js')).setReceiveVoice(true));
await B.waitForFunction(() => relayDiag().speakers.some((s) => s.hasStream), null, { timeout: 30000 });
console.log('  ✅ B subscribed to A (server-enforced, post-consent)');

// envelope check on B: real amplitude from A's fake-device tone
const level = await B.evaluate(async () => {
  const { relayPeerLevels } = await import('./lib/voicerelay.js');
  let peak = 0;
  for (let i = 0; i < 40; i++) {
    for (const v of relayPeerLevels().values()) peak = Math.max(peak, v);
    await new Promise((r) => setTimeout(r, 100));
  }
  return peak;
});
console.log(`  envelope peak at B for A: ${level.toFixed(3)}`);
if (level > 0.02) console.log('  ✅ AUDIO IS FLOWING browser→relay→browser');
else { console.log('  ❌ no audible envelope at B'); await browser.close(); process.exit(1); }

// revoke: B's consent off → stream stops being forwarded
await B.evaluate(async () => (await import('./lib/voiceconsent.js')).setReceiveVoice(false));
await B.waitForFunction(() => !relayDiag().speakers.some((s) => s.hasStream), null, { timeout: 30000 })
  .then(() => console.log('  ✅ consent revoked → subscription dropped'))
  .catch(() => { console.log('  ❌ subscription survived revocation'); process.exit(1); });

await browser.close();
console.log('\n✅ relay-browser-smoke: PASS');
