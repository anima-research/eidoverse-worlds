// sfu-mic-race — a mic pressed BEFORE the credential lands must still publish.
//
// Regression test for 1175d47. window.__sfuMic is installed at initVoiceSfu()
// time, but `pc` does not exist until the relay-cred round-trip lands — so an
// early press hit `if (!pc) return`, set wantMic, and published NOTHING. The
// badge then reported false HONESTLY, which is worse than a lie: no error, no
// log, and nothing re-read wantMic once the connection existed.
//
// 🔴 PROVEN BY BISECT, not by reasoning. Same server, same test, bridge reverted
// one commit:
//     without the fix → micPublished false, timed out at 12s (mic dead forever)
//     with the fix    → micPublished true
// A green run here means nothing unless it goes red on HEAD~1. It does.
//
//   node tools/sfu-mic-race.mjs        (needs a VOICE_TRANSPORT=sfu server on 8946)
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:8946';
const browser = await chromium.launch({
  executablePath: '/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'],
});
const pg = await (await browser.newContext({ permissions:['microphone'] })).newPage();
const errs = []; pg.on('pageerror', e => errs.push(e.message));
await pg.goto(`${BASE}/?world=staging&sfu=1&name=racetest`, { waitUntil:'domcontentloaded' });

// Press the mic AS EARLY AS POSSIBLE — before relay-cred can plausibly land.
const early = await pg.evaluate(async () => {
  const t0 = Date.now();
  while (!window.__sfuMic && Date.now() - t0 < 4000) await new Promise(r => setTimeout(r, 5));
  if (!window.__sfuMic) return { err: '__sfuMic never appeared' };
  const before = window.relayDiag?.() ?? null;
  const r = await window.__sfuMic();                    // the early press
  return { pressed: r, activeAtPress: before?.active ?? null };
});
console.log('  early press →', JSON.stringify(early));

// Now wait for the connection and see whether the intent was honoured.
const after = await pg.evaluate(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const d = window.relayDiag?.();
    if (d?.active && d?.micPublished) return { active: d.active, micPublished: d.micPublished, waited: Date.now()-t0 };
    await new Promise(r => setTimeout(r, 200));
  }
  const d = window.relayDiag?.();
  return { active: d?.active, micPublished: d?.micPublished, timedOut: true };
});
console.log('  after connect →', JSON.stringify(after));
if (errs.length) console.log('  page errors:', errs.slice(0,2));
console.log(after.micPublished === true
  ? '\n  ✅ PASS — the early press survived; wantMic was replayed after sfuConnect'
  : '\n  ❌ FAIL — mic never published; the fix does not work as claimed');
await browser.close();
