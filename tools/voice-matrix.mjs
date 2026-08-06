// voice-matrix — the both-orders consent experiment promised on issue #34.
// Two fake-mic browsers. Order A: receive ON before the sender's mic. Order B:
// receive enabled AFTER the sender offered (the production Digi→Antra order).
// Receipts per phase: receiver peer count, pc state, inbound-rtp packets.
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
  const { bus } = await import('/lib/core.js');
  const peers = v.voiceDebug();
  let inbound = 0, tracks = 0;
  for (const pc of (globalThis.__voicePcs?.() ?? [])) {
    for (const r of (await pc.getStats()).values())
      if (r.type === 'inbound-rtp' && r.kind === 'audio') inbound += r.packetsReceived ?? 0;
    tracks += pc.getReceivers().filter((x) => x.track?.readyState === 'live').length;
  }
  return { peers, inbound, tracks };
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
  console.log('ORDER-A audio flows:', a.inbound > 0 ? 'YES' : 'NO');
  await sender.close(); await receiver.close();
}

// ---- ORDER B: mic first, receive later (production order) ------------------
{
  const [sender, receiver] = await Promise.all([mk('mxB-send'), mk('mxB-recv')]);
  await sender.evaluate(async () => (await import('/lib/voice.js')).toggleMic('mxB-send'));
  await new Promise((r) => setTimeout(r, 3000));            // offer arrives, gets dropped
  await receiver.evaluate(async () => (await import('/lib/voiceconsent.js')).setReceiveVoice(true));
  const b = await phase('ORDER-B (mic→recv):', sender, receiver);
  console.log('ORDER-B audio flows:', b.inbound > 0 ? 'YES' : 'NO — the #34 deadlock');
  // late probe: does ANYTHING heal it with more time?
  const b2 = await phase('ORDER-B +4s:', sender, receiver);
  console.log('ORDER-B healed later:', b2.inbound > 0 ? 'YES' : 'NO');
  await sender.close(); await receiver.close();
}
await browser.close();
