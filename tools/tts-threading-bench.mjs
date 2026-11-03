#!/usr/bin/env node
/**
 * Measure what cross-origin isolation actually buys Piper/ORT synthesis.
 *
 * 🔴 WHY THIS TIMES SYNTHESIS INSTEAD OF READING numThreads:
 * engine-piper.js:192 says it outright — onnxruntime-web ships only -threaded
 * builds, and without SharedArrayBuffer ORT falls back to one core while
 * `ort.env.wasm.numThreads` STILL READS 8. Config is a claim; wall-clock is
 * evidence.
 *
 * 🔴 WHY IT REPORTS SAMPLE COUNTS TOO — the trap this bench would otherwise
 * fall into. engine-piper.js:344-360 records that the SAME TEXT does not
 * produce the same audio: `noise_w` (stochastic duration predictor, default
 * 0.8) gives a 5.7% length spread, and ":378 — LENGTH IS LATENCY", inference
 * cost tracking output duration almost exactly (RTF ~1.1). So a naive A/B can
 * report a speedup that is really two different amounts of audio. Every run
 * prints samples; the summary prints ms-per-1k-samples, which is the
 * length-normalized number. If the sample totals differ much between arms,
 * trust the normalized figure and say so.
 *
 * The A/B is two SERVERS, not two flags: isolation is a property of how the
 * document was served and has no page-side switch. Both serve the same commit;
 * only `isolate()` in server/routes.ts differs.
 *
 *   node tools/tts-threading-bench.mjs --isolated 8960 --bare 8974
 *   node tools/tts-threading-bench.mjs --port 8960        # one arm only
 */
import { chromium } from 'playwright';

const PHRASES = [
  'The bell answers whoever rings it.',
  'A world is its append-only log of intent verbs, and every client folds the same log into the same world.',
  'She asked whether the lag had an explanation.',
  'Parameters, never code, in components.',
];
const REPEATS = 2;          // each phrase synthesized this many times
const VOICE = 'hesperus-clockwork';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

async function measure(base, label) {
  const browser = await chromium.launch({
    // Pin the same chromium the other browser smokes pin (sfu-browser-smoke.mjs:30).
    // The bundled default resolves to a headless-shell build that is not
    // installed here, and letting playwright download its own would also mean
    // benchmarking a DIFFERENT browser than every other receipt in this repo.
    executablePath: process.env.SFU_TEST_CHROME ?? process.env.CHROME ?? undefined,
    args: ['--autoplay-policy=no-user-gesture-required',
           '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const page = await browser.newPage();
  const ortLines = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('[voice] ORT')) ortLines.push(t); });
  page.on('pageerror', (e) => ortLines.push(`PAGEERROR: ${e.message}`));

  await page.goto(`${base}/?world=bench&name=bench${Date.now() % 10000}&token=${process.env.JOIN_KEY || 'dev'}`,
    { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => typeof window.crossOriginIsolated !== 'undefined', { timeout: 30_000 });

  const env = await page.evaluate(() => ({
    isolated: crossOriginIsolated,
    sab: typeof SharedArrayBuffer !== 'undefined',
    cores: navigator.hardwareConcurrency,
  }));

  const result = await page.evaluate(async ({ phrases, repeats, voice }) => {
    // Register engines exactly the way the page does, then drive the real one.
    await import('./lib/engines.js');
    const { loadFromFiles } = await import('./lib/voiceengines.js');

    // The engine takes File objects (the UI hands it user-picked files), so
    // fetch the served model and wrap it — same bytes the app would load.
    const grab = async (name) => {
      const r = await fetch(`./voices/${name}`);
      if (!r.ok) throw new Error(`${name} → HTTP ${r.status}`);
      const b = await r.blob();
      return new File([b], name);
    };
    let files;
    try { files = [await grab(`${voice}.onnx`), await grab(`${voice}.onnx.json`)]; }
    catch (e) { return { error: `model fetch: ${e.message}` }; }

    const t0 = performance.now();
    let handle;
    try { handle = await loadFromFiles(files); }
    catch (e) { return { error: `load: ${e.message}` }; }
    const cold = performance.now() - t0;
    if (!handle?.speak) return { error: `no speak(): ${Object.keys(handle || {}).join(',')}` };

    const runs = [];
    for (let i = 0; i < repeats; i++) {
      for (const p of phrases) {
        const s = performance.now();
        let out;
        try { out = await handle.speak(p); }
        catch (e) { return { error: `speak: ${e.message}`, cold }; }
        runs.push({ chars: p.length, ms: +(performance.now() - s).toFixed(1),
                    samples: out?.pcm?.length ?? 0, rate: out?.sampleRate ?? 0 });
      }
    }
    return { cold: +cold.toFixed(1), runs, label: handle.label ?? handle.id };
  }, { phrases: PHRASES, repeats: REPEATS, voice: VOICE });

  await browser.close();
  return { label, base, env, ortLog: ortLines[0] ?? '(no ORT line seen)', ...result };
}

function report(r) {
  console.log(`\n── ${r.label} — ${r.base}`);
  console.log(`   crossOriginIsolated=${r.env.isolated}  SharedArrayBuffer=${r.env.sab}  cores=${r.env.cores}`);
  console.log(`   ${r.ortLog}`);
  if (r.error) { console.log(`   🔴 ${r.error}`); return null; }
  console.log(`   cold load (model + graph opt): ${r.cold}ms`);
  for (const w of r.runs) {
    console.log(`     ${String(w.chars).padStart(3)}ch → ${String(w.ms).padStart(7)}ms  `
      + `${String(w.samples).padStart(6)} samples  ${(w.ms / (w.samples / 1000)).toFixed(2)} ms/1k`);
  }
  const med = median(r.runs.map((x) => x.ms));
  const totalSamples = r.runs.reduce((a, b) => a + b.samples, 0);
  const totalMs = r.runs.reduce((a, b) => a + b.ms, 0);
  const norm = totalMs / (totalSamples / 1000);
  console.log(`   median ${med}ms · ${totalSamples} samples total · `
    + `${norm.toFixed(2)} ms per 1k samples (length-normalized)`);
  return { med, norm, totalSamples };
}

const one = arg('--port', null);
if (one) {
  report(await measure(`http://127.0.0.1:${one}`, `port ${one}`));
} else {
  const a = await measure(`http://127.0.0.1:${arg('--bare', '8974')}`, 'WITHOUT isolation headers');
  const b = await measure(`http://127.0.0.1:${arg('--isolated', '8960')}`, 'WITH isolation headers');
  const ra = report(a), rb = report(b);
  if (ra && rb) {
    console.log(`\n══ length-normalized: ${(ra.norm / rb.norm).toFixed(2)}× faster with isolation`);
    console.log(`   raw median:          ${(ra.med / rb.med).toFixed(2)}× (${ra.med}ms → ${rb.med}ms)`);
    const skew = Math.abs(ra.totalSamples - rb.totalSamples) / Math.max(ra.totalSamples, rb.totalSamples);
    if (skew > 0.05) {
      console.log(`   ⚠️  arms differ by ${(skew * 100).toFixed(1)}% in total audio produced `
        + `(noise_w, engine-piper.js:347) — trust the NORMALIZED figure.`);
    }
    if (a.env.isolated === b.env.isolated) {
      console.log('🔴 BOTH ARMS REPORT THE SAME crossOriginIsolated — the A/B did not vary. '
        + 'Is the bare server actually running a build without isolate()?');
    }
  }
}
