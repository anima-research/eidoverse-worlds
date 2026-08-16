// sfu-browser-smoke — TWO real Chromium bodies through the IN-PROCESS SFU.
//
// The one row loopback werift peers can never prove: real getUserMedia, real
// Opus, real Chrome SDP against our answer. Same assertions as
// relay-browser-smoke.mjs (deliberately — a row proved by a different yardstick
// proves nothing comparable), plus two the SFU makes newly checkable.
//
//   BASE=http://127.0.0.1:8946 bun tools/sfu-browser-smoke.mjs
//   (server must be running with VOICE_TRANSPORT=sfu)
import { chromium } from 'playwright';

// 🔴 THIS TEST IS ONLY MEANINGFUL OVER A REAL NETWORK (R, 2026-08-15).
// A localhost pass proves nothing about WebRTC: 127.0.0.1 is a secure context
// for free (so getUserMedia never faces the real gate) and ICE will happily
// pick a loopback candidate, skipping exactly the exchange a remote listener
// must complete. Run it through the cloudflare tunnel:
//     BASE=$(tools/tunnel-up.sh) node tools/sfu-browser-smoke.mjs
// It still ACCEPTS a localhost BASE — for a fast inner-loop check — but it says
// loudly that such a run is not evidence for the PR.
const BASE = process.env.BASE ?? 'http://127.0.0.1:8960';
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(BASE);
if (LOCAL) {
  console.log('  \x1b[33m⚠ LOCALHOST RUN — inner-loop only, NOT evidence the SFU works.\x1b[0m');
  console.log('    Real check: BASE=$(tools/tunnel-up.sh) node tools/sfu-browser-smoke.mjs');
} else {
  console.log(`  \x1b[36mreal-network run via ${BASE}\x1b[0m`);
}
const KEY = process.env.KEY ?? 'staging-2026';
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: [
    // --use-fake-device gives a deterministic tone, which is what makes the
    // envelope check a THRESHOLD rather than a vibe. A real mic in a quiet room
    // would fail this test for the right reason and the wrong purpose.
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // 🔴 WSL HAS NO SOUND CARD (2026-08-15). `/dev/snd` contains only `timer`,
    // and without an output device Chromium's WebAudio renderer eventually
    // fails to start a graph: "The AudioContext encountered an error from the
    // audio device or the WebAudio renderer" — and then the AnalyserNode this
    // test measures with reads 0.000 forever. The audio was FINE (the server
    // forwarded 13k packets and B was subscribed); the INSTRUMENT was dead.
    //
    // That is the worst failure shape available here: an envelope of 0.000
    // reads exactly like silence, so a green transport looks broken and a
    // change made minutes earlier looks guilty. It cost an A/B against a
    // stashed tree to clear code that was never involved.
    //
    // This flag gives Chromium a null audio sink so the render graph runs with
    // no hardware. It changes nothing about what is measured — the analyser
    // still reads the decoded remote track.
    '--disable-features=AudioServiceOutOfProcess',
    '--alsa-output-device=null',
  ],
});

let failed = false;
const ok = (m) => console.log(`  \x1b[32m✅\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m❌\x1b[0m ${m}`); failed = true; };

const mk = async (name) => {
  const pg = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
  pg.on('console', (m) => { if (/sfu|error/i.test(m.text())) console.log(`  [${name}] ${m.text().slice(0, 140)}`); });
  pg.on('pageerror', (e) => console.log(`  [${name}] PAGEERROR ${String(e).slice(0, 140)}`));
  await pg.goto(`${BASE}/?world=staging&key=${KEY}&name=${name}`);
  // 🔴 THERE IS A FRONT DOOR (found 2026-08-15). main.js calls start() ONLY
  // from openDoor's onEnter (ui.js:369, button #d-go) — a probe that merely
  // LOADS the url sits at the panel forever while the HUD paints behind the
  // overlay. This test predates that discovery and hung 90s at this line.
  // Click through like a visitor.
  await pg.waitForSelector('#d-go', { timeout: 20000 }).catch(() => {});
  const nameField = await pg.$('#d-name');
  if (nameField) await nameField.fill(name).catch(() => {});
  await pg.click('#d-go').catch(() => {});
  // Page boot is ~13s under load, so 90s is the floor, not slack. (Cited
  // RECEIPTS.md until 2026-08-16 — a file that never existed. The number is a
  // live observation with no preserved artifact.)
  await pg.waitForFunction(() => window.relayDiag?.().active === true, null, { timeout: 90000 });
  return pg;
};

try {
  console.log('launching A (speaker) and B (listener) against the in-process SFU…');
  const A = await mk('smoke-a');
  const B = await mk('smoke-b');
  ok(`both connected: ${await A.evaluate(() => relayDiag().identity)} + ${await B.evaluate(() => relayDiag().identity)}`);

  // The transport must be OURS, not a LiveKit leg that happened to be up. This
  // assertion exists because "the smoke passed" is worthless if it passed
  // against the wrong server.
  const t = await A.evaluate(() => relayDiag().transport);
  t === 'sfu' ? ok('transport is the in-process SFU (no LiveKit)') : bad(`transport reported "${t}", expected "sfu"`);

  await A.evaluate(() => window.relayMic());
  await A.waitForFunction(() => relayDiag().micPublished === true, null, { timeout: 30000 });
  ok('A publishing a real getUserMedia track');

  await B.evaluate(async () => (await import('./lib/voiceconsent.js')).setReceiveVoice(true));
  await B.waitForFunction(() => relayDiag().speakers.some((s) => s.hasStream), null, { timeout: 30000 });
  ok('B subscribed to A — server-enforced, POST-consent');

  // THE ONE SPEECH CHECK. Packet counters can be right while the audio is
  // silence; amplitude at the listener's element is the only proof that
  // survives every intermediate lie.
  const level = await B.evaluate(async () => {
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      for (const v of window.relayPeerLevels().values()) peak = Math.max(peak, v);
      await new Promise((r) => setTimeout(r, 100));
    }
    return peak;
  });
  console.log(`  envelope peak at B for A: ${level.toFixed(3)}`);
  level > 0.02 ? ok('AUDIO IS FLOWING browser → our SFU → browser')
               : bad('no audible envelope at B');

  // Revocation must be a memory write, not an SDP round trip — measure it.
  const t0 = Date.now();
  await B.evaluate(async () => (await import('./lib/voiceconsent.js')).setReceiveVoice(false));
  const quiet = await B.evaluate(async () => {
    for (let i = 0; i < 30; i++) {
      let peak = 0;
      for (const v of window.relayPeerLevels().values()) peak = Math.max(peak, v);
      if (peak < 0.005) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  });
  quiet ? ok(`consent revoked → audio stopped in ~${Date.now() - t0}ms`)
        : bad('audio survived revocation');

  // Server-side truth, not just what the client believes.
  const diag = await (await fetch(`${BASE}/relay-diag?world=staging`)).json();
  console.log(`  server diag: forwarded=${diag.forwarded} suppressed=${JSON.stringify(diag.suppressed)}`);
  diag.forwarded > 0 ? ok('server confirms it forwarded packets')
                     : bad('server forwarded nothing — client may be hearing itself');
} catch (e) {
  bad(`threw: ${String(e).slice(0, 300)}`);
} finally {
  await browser.close();
}

console.log(failed ? '\n\x1b[31m❌ sfu-browser-smoke: FAIL\x1b[0m' : '\n\x1b[32m✅ sfu-browser-smoke: PASS\x1b[0m');
process.exit(failed ? 1 : 0);
