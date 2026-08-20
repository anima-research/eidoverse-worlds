// tts-blocking-probe — does a long utterance freeze the page?
//
// R, 2026-08-16: "I submitted a long thing to test TTS hang and boy it's hung
// af — froze the whole browser. Finally came back after about 30 seconds and
// started talking."
//
// The thing to measure is not "how long did synthesis take" — RTF ≈ 1.1 means
// a long utterance legitimately takes a long time. It is whether the MAIN
// THREAD stays available while it happens. So this drives a rAF counter and
// reports the worst gap between frames: a page that never blocks holds ~16ms;
// a page doing a 28-second ort.run() shows one enormous gap.
//
// Uses a stub synthesizer with a deliberate blocking spin, so the measurement
// is of OUR scheduling, not of piper's speed — the question is whether we hand
// the page back between pieces, and that must be answerable without a 63 MB
// model in the loop.
//
//   node tools/tts-blocking-probe.mjs [origin]
import { launchBrowser, ownedWorld } from './probe-harness.mjs';

const world = await ownedWorld({ live: process.argv[2] || null });
const ORIGIN = world.origin;
const { page, close } = await launchBrowser({ mic: true });
const shut = async () => { await close(); await world.close(); };
const pg = await page();
await pg.goto(`${ORIGIN}/?world=staging&name=blockprobe`, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));

const LONG = "Right, here's a good long one for you to push the sliders around on. "
  + "I'm going to keep talking for a while so you have something continuous to work with, "
  + "rather than a short clip that ends before you've found the control you wanted. "
  + "This sentence exists purely to make the whole thing long enough to matter, "
  + "because a short utterance cannot demonstrate the problem at all.";

const r = await pg.evaluate(async (text) => {
  const tts = await import('./lib/tts.js');

  // A stub engine: each call blocks the thread for a fixed slice, standing in
  // for ort.run(). 300ms per call is small enough to keep the probe quick and
  // large enough that an UNCHUNKED run (one call for the whole text) is
  // unmistakably worse than a chunked one.
  let calls = 0;
  tts.setTtsSource(async (t) => {
    calls++;
    const spin = 300 * Math.max(1, Math.round(t.length / 60));   // cost scales with length, like RTF
    const end = performance.now() + spin;
    while (performance.now() < end) { /* block, exactly as inference does */ }
    return { pcm: new Int16Array(1024), sampleRate: 22050 };
  }, 'blocking stub');
  tts.setTtsEnabled(true);

  // Watch frame-to-frame gaps across the whole utterance.
  let worst = 0, frames = 0, last = performance.now();
  let running = true;
  const tick = () => {
    if (!running) return;
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now; frames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const t0 = performance.now();
  await tts.speak(text, 'probe');
  const total = performance.now() - t0;
  running = false;
  return { worst: Math.round(worst), frames, calls, total: Math.round(total) };
}, LONG);

console.log(`  synth calls      ${r.calls}   (1 = never chunked)`);
console.log(`  total time       ${r.total}ms`);
console.log(`  frames observed  ${r.frames}`);
console.log(`  WORST frame gap  ${r.worst}ms`);
// One blocking slice is unavoidable per chunk; what must not happen is a single
// gap spanning the whole utterance.
const chunked = r.calls > 1;
const ok = chunked && r.worst < r.total * 0.6;
console.log(ok ? '✅ CHUNKED — the page gets the thread back between pieces'
               : '❌ the page is blocked for essentially the whole utterance');
await shut();
process.exit(ok ? 0 : 1);
