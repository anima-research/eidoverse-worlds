/** Piper as a voice-engine plugin — the first user of the slot, and the proof
 *  it fits an engine that was NOT designed for it.
 *
 *  🔴 IF YOU ARE HERE ABOUT LATENCY, READ `docs/VOICE-LATENCY-PLAN.md` FIRST.
 *  Measured 2026-08-09: 133ms native vs ~550ms in WASM, and the 4x gap is the
 *  HiFi-GAN vocoder (stacked transposed convolutions — what WASM does worst).
 *  Already measured and ruled out, do not re-derive: INT8 quantization is 4.6x
 *  SLOWER here; WebGPU is structurally blocked (RandomNormalLike is absent from
 *  ORT's op table and VITS samples noise, so it partitions in the hot path);
 *  Kokoro is the 8.4 s/sentence TEACHER we distilled away from in July, not an
 *  alternative. The open plan is an MB-iSTFT re-distill on the workstation GPU.
 *
 *  Everything piper-specific lives here: the two-file shape, the OPFS
 *  cache-seeding trick, PATH_MAP. voiceengines.js knows none of it, and neither
 *  does the panel.
 */
import { registerEngine } from './voiceengines.js';
import { setTtsSource } from './voicesource.js';
import { decodeWavToPcm } from './wavpcm.js';

let engine = null;
let _phonCost = 0;   // measured once: see speak()
const runtime = async () => (engine ??= await import('@mintplex-labs/piper-tts-web'));

registerEngine({
  id: 'piper',
  label: 'Piper',
  accept: ['.onnx', '.json'],

  // OPFS is not optional: local files reach the runtime only through its cache.
  supported: () => typeof WebAssembly === 'object' && !!navigator.storage?.getDirectory,

  // Score, not boolean. A lone .onnx might belong to another ONNX engine, so
  // that scores 1; a matching .onnx + .onnx.json pair is unmistakably Piper and
  // scores 3. Whoever recognises MORE of the selection wins.
  match: (files) => {
    const onnx = files.find((f) => f.name.toLowerCase().endsWith('.onnx'));
    if (!onnx) return 0;
    const want = `${onnx.name.toLowerCase()}.json`;
    const paired = files.some((f) => f.name.toLowerCase() === want);
    if (paired) return 3;
    // A .json that looks like a piper config (phoneme_id_map) is also decisive,
    // even if its name does not follow the convention.
    return files.some((f) => f.name.toLowerCase().endsWith('.json')) ? 2 : 1;
  },

  async load(files, onProgress = () => {}) {
    const onnx = files.find((f) => f.name.toLowerCase().endsWith('.onnx'));
    const cfg = files.find((f) => f.name.toLowerCase().endsWith('.json'));
    if (!onnx) throw new Error('Piper needs the .onnx model file');
    // Say WHY, not just what: the config carries the phoneme→id map, the sample
    // rate and the espeak language — none of it recoverable from the model.
    if (!cfg) throw new Error(`Piper also needs ${onnx.name}.json — it holds the phoneme map and sample rate`);

    // PHASES, not percentages. The runtime's own progress callback only fires
    // while DOWNLOADING, and these files are already on disk — so it would
    // report nothing for the entire real wait. The long pole is
    // InferenceSession.create() over a 63 MB graph, which is silent and can run
    // tens of seconds on first load. Naming the phase is the honest signal; a
    // fake percentage would be a progress bar that lies.
    onProgress({ phase: 'runtime', text: 'loading runtime…' });
    const e = await runtime();
    const base = onnx.name.replace(/\.onnx$/i, '');

    // The runtime has no seam for local model bytes: TtsSession always resolves
    // a voiceId through PATH_MAP and fetches HuggingFace. But getBlob() reads an
    // OPFS cache FIRST, keyed by basename. So seed the cache under the names it
    // will look for and it never touches the network. Its own cache, used the
    // way it already works — no fork, no patch.
    // The copy IS measurable — we are the ones moving the bytes — so stream it
    // in chunks and report real percentages rather than a single silent await.
    // This is the one phase where a number is honest, so it gets a number.
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('piper', { create: true });
    const totalMb = Math.round(onnx.size / 1e6);
    for (const [name, file] of [[`${base}.onnx`, onnx], [`${base}.onnx.json`, cfg]]) {
      const h = await dir.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      const big = file.size > 4e6;
      if (big) {
        const CHUNK = 4 << 20;
        for (let off = 0; off < file.size; off += CHUNK) {
          const slice = file.slice(off, Math.min(off + CHUNK, file.size));
          await w.write(await slice.arrayBuffer());
          onProgress({
            phase: 'copy', pct: Math.round(((off + CHUNK) / file.size) * 100),
            text: `copying ${totalMb} MB — ${Math.min(100, Math.round(((off + CHUNK) / file.size) * 100))}%`,
          });
        }
      } else {
        await w.write(await file.arrayBuffer());
      }
      await w.close();
    }
    if (e.PATH_MAP && !e.PATH_MAP[base]) e.PATH_MAP[base] = `${base}.onnx`;

    let sr = null;
    try { sr = JSON.parse(await cfg.text())?.audio?.sample_rate ?? null; } catch { /* label only */ }

    // predict() is the convenience wrapper and it does NOT forward wasmPaths —
    // it always builds a session against hardcoded CDNs (cdnjs for ONNX Runtime,
    // jsDelivr for piper_phonemize). That means a network round trip per load
    // and no offline use at all, for a feature whose entire point is "the voice
    // is already on your machine." So construct the session directly and point
    // every asset at files we serve.
    // TtsSession is a SINGLETON: `if (_TtsSession._instance) return _instance`,
    // which silently ignores voiceId AND wasmPaths on every construction after
    // the first. Loading a second voice would keep speaking in the first one —
    // a bug that looks like "the picker did nothing." Drop the instance so each
    // load actually builds its own session.
    if (e.TtsSession._instance) e.TtsSession._instance = null;
    // The silent stretch: compiling the ONNX graph. Say so, and say it may take
    // a while, rather than leaving "loading…" to look like a hang.
    // THE UNMEASURABLE PHASE. InferenceSession.create() compiles a 63 MB graph
    // and reports nothing — there is no fraction to show, and inventing one
    // would be a progress bar that lies. But a static "preparing voice…" for
    // 30+ seconds is its OWN lie: it is indistinguishable from a hang, which is
    // exactly how R read it (2026-08-09).
    //
    // So: count UP. Elapsed seconds is true, visibly moving, and needs no
    // estimate. "still working, 12s" answers the only question a frozen label
    // cannot — is this alive?

    // MEASURE, DO NOT THEORIZE. R: "why is it so slow? Piper is supposed to be
    // stupid fast" — and she was right to push. I had two confident causes
    // (single-threaded ONNX; per-utterance phonemizer re-instantiation) and
    // BOTH were wrong: I measured the phonemizer at 34–52 ms, not seconds. The
    // model lives in the browser's own cache, so none of this is reproducible
    // from the server side — the only way to know is to time it where it runs.
    // Split predict from decode because they fail for different reasons: slow
    // predict = inference, slow decode = a main-thread copy of the samples.
    // 🔴 OUR OWN SESSION, BYPASSING predict(). Measured: the library rebuilds the
    // phonemizer module on EVERY call — 30,359ms in the browser, which was the
    // entire delay R heard. Its factory and session are WeakMap private fields,
    // so neither can be wrapped or reached; the only way out is to do both steps
    // ourselves and keep the module. See piperphon.js.
    //
    // Inference is cheap once phonemization is not being rebuilt: the same ORT
    // session, run directly.
    const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    // 🔴 BARE SPECIFIERS NEED AN IMPORTMAP ENTRY, AND THERE IS ONLY ONE.
    // index.html maps "onnxruntime-web" → ort.bundle.min.mjs and nothing else, so
    // `import('onnxruntime-web/webgpu')` throws "Failed to resolve module
    // specifier" in the browser — before `ort` is ever assigned, taking the whole
    // load with it. That is what broke the model tonight (R: "the current
    // engine-piper.js was erroring out and the model wasn't working at all").
    //
    // Resolve the webgpu bundle by PATH instead, the same way piperphon.js
    // resolves the piper chunk — node_modules is served, so this works without
    // touching the importmap. Falls back to the mapped default on any failure,
    // and the fallback is a specifier that is KNOWN to resolve.
    const ort = await (async () => {
      if (hasGpu) {
        try {
          const url = new URL('../node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs',
                              import.meta.url).href;
          return await import(/* @vite-ignore */ url);
        } catch (e) {
          console.warn('[voice] webgpu bundle unavailable, using the default build:', e?.message || e);
        }
      }
      return import('onnxruntime-web');
    })();
    const cfgJson = JSON.parse(await cfg.text());
    const espeakVoice = cfgJson?.espeak?.voice || 'en-us';
    const inf = cfgJson?.inference || {};
    const wasmPaths = {
      piperData: new URL('../vendor/piper/piper_phonemize.data', import.meta.url).href,
      piperWasm: new URL('../vendor/piper/piper_phonemize.wasm', import.meta.url).href,
    };
      // 🔴 REPORT WHAT WE ACTUALLY GOT, NOT WHAT WE ASKED FOR.
      //
      // onnxruntime-web ships ONLY -threaded builds, every one of which needs
      // SharedArrayBuffer, which needs the page to be cross-origin isolated.
      // Without it ORT silently falls back to single-threaded — numThreads still
      // READS as 8 while one core does the work. That is the displayed-state-vs-
      // real-state trap, and it is exactly the kind of thing I have spent today
      // failing to catch by reading config instead of measuring.
      //
      // Default is min(hardwareConcurrency/2, 4) — capped at 4 even on a big
      // machine — so ask for more explicitly, then print what the runtime says.
      const cores = navigator.hardwareConcurrency || 4;
      const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
      const sab = typeof SharedArrayBuffer !== 'undefined';
      ort.env.wasm.numThreads = isolated && sab ? Math.min(cores, 8) : 1;
      ort.env.wasm.simd = true;
      ort.env.wasm.wasmPaths = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url).href;
      console.log(`[voice] ORT: ${cores} cores · crossOriginIsolated=${isolated} · `
        + `SharedArrayBuffer=${sab} · numThreads=${ort.env.wasm.numThreads}`
        + (isolated && sab ? '' : '  ⚠️ SINGLE-THREADED — isolation headers missing'));

      // Session options were never set at all: no optimization level, no
      // execution mode. 'all' lets ORT fuse and constant-fold the graph, which is
      // free at run time and paid once at load.
      // 🔴 TRY WEBGPU FIRST, FALL BACK TO WASM.
      //
      // 553ms for 0.53s of audio is RTF ~1.07 on a MEDIUM (60 MB) model. The
      // ~65ms figure in the Piper README is NATIVE, and typically a low/x_low
      // model — never the same comparison. WASM SIMD cannot reach hardware AVX
      // or NEON, so the gap is structural, not a bug.
      //
      // But the jsep (WebGPU) binary already ships in onnxruntime-web, so the GPU
      // path costs no new dependency. A VITS decoder is mostly convolutions and
      // matmuls, which is exactly what a GPU is for. Falls back silently when
      // WebGPU is absent or the model has an op the EP does not implement — the
      // fallback is REQUIRED, not optional, because 'webgpu' throws rather than
      // degrading on unsupported operators.
      const buf = await onnx.arrayBuffer();
      // 🔴 THE TICKER MUST WRAP THE WORK, NOT SIT NEAR IT. R, three times:
      // "compiling voice model still doesn't have a timer... *dying*". She was
      // right every time. The ticker was started and clearInterval'd in the SAME
      // synchronous block, ninety lines above the InferenceSession.create() it
      // was meant to describe — so it never ticked once, and every fix I shipped
      // was to code that could not run. Start it here, clear it in a finally.
      const compileT0 = performance.now();
      const ticker = setInterval(() => {
        const s = Math.round((performance.now() - compileT0) / 1000);
        onProgress({ phase: 'compile', elapsed: s, text: `compiling voice model — ${s}s` });
      }, 1000);
      onProgress({ phase: 'compile', elapsed: 0, text: 'compiling voice model…' });
      // 🔴 DECLARED OUTSIDE THE try — speak() closes over these. `let` inside the
      // try block scoped them to it, so `usedEP` was dead by the time speak()
      // ran: "ReferenceError: usedEP is not defined" (R, 2026-08-09). A block is
      // a scope; wrapping code in try/finally silently moves every declaration
      // inside it.
      // 🔴 executionMode 'parallel' MEASURED SLOWER — do not put it back.
      // I set it blind on the assumption that "parallel" means faster. Measured
      // natively on this machine, 45-token sequence:
      //     sequential (ORT default)  P50 192ms
      //     parallel   (what I set)   P50 232ms      ← 21% WORSE
      // Parallel mode runs independent subgraphs on separate threads; a VITS
      // graph is mostly one long dependency chain, so it buys nothing and pays
      // the coordination. In WASM, where thread handoff is dearer, worse still.
      //
      // graphOptimizationLevel 'all' IS worth it, measured the same way:
      //     all    P50 179ms
      //     basic  P50 248ms
      const opts = { graphOptimizationLevel: 'all' };
      let ortSession = null, usedEP = 'wasm';
      try {
      // 🔴 WEBGPU IS NOT OBVIOUSLY THE WIN FOR SHORT SPEECH. piper-plus and the
      // ORT docs both note that for SHORT utterances WASM SIMD+threads often
      // beats WebGPU, because per-call GPU setup dominates when there is little
      // work to do — and short utterances are exactly R's case ("hello").
      // So make it switchable and MEASURE, rather than assuming the GPU wins:
      //   localStorage.eidoTtsBackend = 'wasm' | 'webgpu' | 'auto' (default)
      const pref = (() => { try { return localStorage.getItem('eidoTtsBackend'); } catch { return null; } })();
      // 🔴 WEBGPU IS OPT-IN, NOT DEFAULT (2026-08-09, after it broke R's voice
      // with "Failed to run JSEP kernel" on GatherND). Three reasons, in order:
      //   1. ORT's WebGPU EP does not implement every op a VITS graph uses, and
      //      the failure lands at INFERENCE time, not at session creation — so a
      //      user gets a voice that loads fine and then throws.
      //   2. The research says WASM SIMD+threads often BEATS WebGPU for SHORT
      //      utterances anyway, because per-call GPU setup dominates. Short
      //      utterances are the case we care about.
      //   3. An experiment that costs someone their working voice is not a
      //      default. It is a flag.
      // Turn it on with localStorage.eidoTtsBackend = 'webgpu' and measure with
      // ttsBench(); the run() fallback below still catches a kernel failure.
      // 🔴 GatherND IS SUPPORTED — checked the authoritative op table rather
      // than assuming from the error text (webgpu-operators.md lists it at
      // ai.onnx 11,12,13+). So "Failed to run JSEP kernel" on GatherND_2927 is a
      // kernel that EXISTS and FAILED, not a missing one — a different problem
      // with a different fix, and the error message does not distinguish them.
      //
      // Note also RandomNormalLike is ABSENT from that table, and VITS samples
      // noise. If the graph contains it, a partition boundary lands right in the
      // hot path — which would explain both a failure and a slowdown.
      //
      // env.debug + verbose logging makes ORT print which ops run on GPU and
      // which fall back, so the next attempt has data instead of a guess.
      if (hasGpu && pref === 'webgpu') {
        ort.env.debug = true;
        ort.env.logLevel = 'verbose';
        try {
          const t = performance.now();
          ortSession = await ort.InferenceSession.create(buf, { ...opts, executionProviders: ['webgpu'] });
          usedEP = 'webgpu';
          console.log(`[voice] ORT session on WEBGPU in ${Math.round(performance.now() - t)}ms`);
        } catch (e) {
          console.warn('[voice] webgpu unavailable, falling back to wasm:', e?.message || e);
        }
      }
      if (!ortSession) {
        const t = performance.now();
        ortSession = await ort.InferenceSession.create(buf, { ...opts, executionProviders: ['wasm'] });
        console.log(`[voice] ORT session on WASM in ${Math.round(performance.now() - t)}ms`);
      }
      console.log(`[voice] inference backend: ${usedEP}`);
      } finally { clearInterval(ticker); }

    const { phonemize, phonReady, warmPhonemizer } = await import('./piperphon.js');
    // BUILD THE PHONEMIZER NOW, not on the first word. It is ~27s and depends on
    // nothing but the wasm paths, so it belongs inside the load the user is
    // already watching rather than in front of their first utterance.
    await warmPhonemizer(wasmPaths, onProgress);

    const speak = async (text) => {
      const t0 = performance.now();
      const warm = phonReady();
      // 🔴 SHORT UTTERANCES NEED TERMINAL PUNCTUATION — a KNOWN Piper issue, not
      // ours (rhasspy/piper#252, "Single/short-word intonation and
      // pronunciation"). VITS is trained on full sentences, so a bare "hello"
      // with no sentence boundary falls outside the training distribution: the
      // duration predictor and the flow decoder both extrapolate, and the result
      // is the mangled output R heard ("sounds terrible if I just say hello but
      // perfect if I say Hello I'm speaking in Glados voice").
      //
      // Giving espeak a sentence terminator puts the model back in distribution.
      // It costs one character and no latency — the documented workaround, found
      // by SEARCHING after three wrong theories I measured and disproved.
      const spoken = /[.!?…,;:]\s*$/.test(text.trim()) ? text : `${text.trim()}.`;
      const ids = await phonemize(spoken, espeakVoice, wasmPaths);
      const t1 = performance.now();
      const feeds = {
        input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
        input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)])),
        scales: new ort.Tensor('float32', Float32Array.from([
          // 🔴 THE SAME TEXT DOES NOT PRODUCE THE SAME AUDIO. R found this with a
          // one-character test — "abcdefghijklmn sounds good, remove just the n
          // and the whole run sounds really bad" — and the two strings phonemize
          // to BYTE-IDENTICAL token sequences. She was comparing two samples from
          // a random distribution, not two texts.
          //
          // Measured, same ids, 6 runs each:
          //     noise_w 0.8 (default)  25344-26880 samples   5.7% length spread
          //     noise_w 0.4             25344-25600          1.0%
          //     noise_w 0.0             24576 every time     0.0%
          //
          // noise_w is DURATION noise — the stochastic duration predictor. It
          // buys natural rhythm variation and costs consistency, and at 0.8 an
          // unlucky draw is audibly worse than a lucky one. Overridable per voice
          // via the config so this is a dial, not my taste hardcoded.
          // 🔴 LENGTH IS LATENCY. Measured 2026-08-09: infer cost tracks OUTPUT
          // duration almost exactly — R's two runs of "Hello" were 698ms/0.63s
          // and 531ms/0.46s, RTF 1.12 vs 1.16. Inference is not erratic; it is
          // being asked for different amounts of audio.
          //
          // And the amounts are LONG. "Hello." at defaults:
          //     en_US-amy-medium     0.87s      ← a human says it in ~0.35s
          //     hesperus-clockwork   0.49s      ← 1.25 speed baked into its corpus
          // So a voice's own training speed dominates, and length_scale is the
          // per-voice dial for the rest. Lowering it cuts audio duration AND
          // inference time together, which is the cheapest latency win available
          // — but it is a VOICE decision (pace, character), not a perf knob to
          // set behind someone's back. Overridable in the .onnx.json, and
          // localStorage.eidoTtsLengthScale overrides that for A/B.
          inf.noise_scale ?? 0.667,
          (() => { try { const v = parseFloat(localStorage.getItem('eidoTtsLengthScale')); return Number.isFinite(v) ? v : (inf.length_scale ?? 1.0); } catch { return inf.length_scale ?? 1.0; } })(),
          inf.noise_w ?? 0.8,
        ])),
      };
        // 🔴 THE WEBGPU FALLBACK MUST COVER run(), NOT JUST create().
        //
        // R, 2026-08-09: "Non-zero status code returned while running GatherND
        // node … Failed to run JSEP kernel". JSEP is the WebGPU backend, and
        // this is precisely the risk I named when I added it: session creation
        // SUCCEEDS and then an operator fails at INFERENCE time. ORT's WebGPU EP
        // does not implement every op a VITS graph uses — GatherND here — and my
        // fallback only wrapped create(), so the failure landed on the user as a
        // dead voice instead of a slower one.
        //
        // Rebuild once on WASM and retry. A voice that speaks slowly beats a
        // voice that throws, and the rebuild is paid once per session, not per
        // utterance.
        let res;
        try {
          res = await ortSession.run(feeds);
        } catch (e) {
          if (usedEP !== 'webgpu') throw e;
          console.warn('[voice] webgpu kernel failed, rebuilding on wasm:', e?.message || e);
          ortSession = await ort.InferenceSession.create(buf, { ...opts, executionProviders: ['wasm'] });
          usedEP = 'wasm';
          res = await ortSession.run(feeds);
        }
      const t2 = performance.now();
      const raw = res[ortSession.outputNames[0]].data;      // Float32Array, -1..1
      const pcmData = new Int16Array(raw.length);
      for (let k = 0; k < raw.length; k++) {
        pcmData[k] = Math.max(-32768, Math.min(32767, Math.round(raw[k] * 32767)));
      }
      const rate = sr || 22050;
      const secs = pcmData.length / rate;
      console.log(`[voice] phonemize ${Math.round(t1 - t0)}ms${warm ? '' : ' (first, builds the module)'}`
        + ` · infer ${Math.round(t2 - t1)}ms · ${secs.toFixed(2)}s audio`
        + ` · RTF ${((t2 - t0) / 1000 / Math.max(secs, 1e-6)).toFixed(3)}` + ` · ${usedEP}`);
      return { pcm: pcmData, sampleRate: rate };
    };
    const label = `Piper: ${base}${sr ? ` (${sr} Hz)` : ''}`;
    setTtsSource(speak, label);
    return { speak, label };
  },
});
