// hud-mic-truth — the HUD glyph must never say PRIVATE while the room hears you.
//
// Found 2026-08-15 by reading mictoggle.js end to end (the house rule R added
// to the trim boilerplate that morning), then confirmed in a real browser:
//
//   SFU publishing: true      glyph: slashed, "mic off (V to talk)"
//
// mictoggle painted from micOn(), which is voice.js's MESH state — and on the
// SFU path micStream is never set there, so it was permanently false. Worse,
// 'audio:mic' was already being emitted from three sites and subscribed by
// nobody, so the glyph only ever repainted from its own 125ms poll.
//
// This is the one direction the UI must never fail in. A control that claims
// silence while transmitting is not a cosmetic bug.
//
//   node tools/hud-mic-truth.mjs      (needs a VOICE_TRANSPORT=sfu server on 8946)
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath:'/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'] });
const pg = await (await b.newContext({permissions:['microphone']})).newPage();
await pg.goto('http://127.0.0.1:8946/?world=staging&sfu=1&name=hudcheck', { waitUntil:'domcontentloaded' });
await pg.waitForFunction(() => !!window.__sfuMic, null, { timeout: 15000 }).catch(()=>{});
await pg.waitForFunction(() => window.relayDiag?.()?.active === true, null, { timeout: 20000 }).catch(()=>{});
const r = await pg.evaluate(async () => {
  const glyph = () => { const el = document.querySelector('#mictoggle'); return { slashed: /c0574f/.test(el?.innerHTML||''), title: el?.title || null }; };
  const before = glyph();
  await window.__sfuMic();                                  // turn the mic ON via the SFU
  await new Promise(r => setTimeout(r, 800));               // well past the 125ms repaint poll
  return { before, after: glyph(), sfuPublishing: window.relayDiag?.().micPublished };
});
console.log('  glyph before mic-on :', JSON.stringify(r.before));
console.log('  glyph after  mic-on :', JSON.stringify(r.after));
console.log('  SFU actually publishing:', r.sfuPublishing);
console.log(r.sfuPublishing && r.after.slashed
  ? '\n  🔴 CONFIRMED — SFU is publishing while the HUD glyph still shows MIC OFF (slashed)'
  : '\n  ✓ glyph agrees with the SFU');
await b.close();
