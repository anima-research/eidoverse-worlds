// voice-matrix — EXTERNAL browser harness for the late-consent orders.
//
// HONESTY CONTRACT (#36 review, antra): this file is NOT part of the merge
// receipt — the traveling regression lives in tools/voice-lifecycle-test.ts
// (fake-RTC, runs with bun, no dependencies). This harness exists for
// real-media verification on a workstation that has Playwright + real
// browsers; it is documentation-plus-tool, not CI.
//
//   Requirements: playwright installed OUTSIDE this repo (run it from a
//   directory that has it, e.g. `cd ~/lab && node <repo>/tools/voice-matrix.mjs`),
//   a running server on :8940, and fake-media Chromium flags (below).
//
// The probe reads REAL stats via voice.js's exported voiceStats() — the
// previous revision read a `__voicePcs` global that was never defined, so
// its inbound numbers were structurally zero (review catch). It now ASSERTS
// and exits nonzero on failure instead of printing YES/NO prose.
//
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: [
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader',
] });
const mk = async (name) => {
  const page = await browser.newPage();
  page.on('pageerror', () => {});
  await page.goto(`http://localhost:8940/?key=workbench-2026&name=${name}&world=workbench`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__wired ?? true, { timeout: 15000 }).catch(() => {});
  await page.evaluate(async () => {
    const net = await import('/lib/net.js');
    for (let i = 0; i < 60 && !net.net?.joined; i++) await new Promise((r) => setTimeout(r, 250));
  });
  return page;
};

const stats = (page) => page.evaluate(async () => {
  const v = await import('/lib/voice.js');
  const peers = v.voiceDebug();
  const per = await v.voiceStats();   // real getStats — no phantom globals
  const inbound = Object.values(per).reduce((n, s) => n + (s.inboundAudioPackets ?? 0), 0);
  return { peers, inbound, per };
});

async function phase(label, sender, receiver) {
  await new Promise((r) => setTimeout(r, 4000));
  const s = await stats(sender), rx = await stats(receiver);
  console.log(label, JSON.stringify({ sender: s.peers, receiver: rx.peers, rxInboundPkts: rx.inbound }));
  return rx;
}

// ---- ORDER A: receive first, then mic --------------------------------------
{
  const [sender, receiver] = await Promise.all([mk('mxA-send'), mk('mxA-recv')]);
  await receiver.evaluate(async () => (await import('/lib/voiceconsent.js')).setReceiveVoice(true));
  await sender.evaluate(async () => (await import('/lib/voice.js')).toggleMic('mxA-send'));
  const a = await phase('ORDER-A (recv→mic):', sender, receiver);
  console.log('ORDER-A inbound packets:', a.inbound);
if (!(a.inbound > 0)) { console.error('FAIL: order A carried no audio'); process.exitCode = 1; }
  await sender.close(); await receiver.close();
}

// ---- ORDER B: mic first, receive later (production order) ------------------
{
  const [sender, receiver] = await Promise.all([mk('mxB-send'), mk('mxB-recv')]);
  await sender.evaluate(async () => (await import('/lib/voice.js')).toggleMic('mxB-send'));
  await new Promise((r) => setTimeout(r, 3000));            // offer arrives, gets dropped
  await receiver.evaluate(async () => (await import('/lib/voiceconsent.js')).setReceiveVoice(true));
  const b = await phase('ORDER-B (mic→recv):', sender, receiver);
  console.log('ORDER-B inbound packets (pre-heal):', b.inbound);
  // late probe: does ANYTHING heal it with more time?
  const b2 = await phase('ORDER-B +4s:', sender, receiver);
  console.log('ORDER-B inbound packets (post-recvReady):', b2.inbound);
if (!(b2.inbound > 0)) { console.error('FAIL: late consent did not heal order B'); process.exitCode = 1; }
process.exit(process.exitCode ?? 0);
  await sender.close(); await receiver.close();
}
await browser.close();
