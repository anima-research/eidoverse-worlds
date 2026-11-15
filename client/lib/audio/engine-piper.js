/** Piper as a voice-engine plugin. Everything piper-specific lives here (the two-file shape, the OPFS
 *  cache seeding, PATH_MAP); voiceengines.js and the panel know none of it.
 *  Latency measurements, what was ruled out, and why the session is built by hand:
 *  docs/research/piper-voice-engine.md.
 */
import { registerEngine } from './voiceengines.js';
import { setTtsSource } from './tts.js';
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
    // the config carries the phoneme→id map, sample rate and espeak language: not recoverable from the model
    if (!cfg) throw new Error(`Piper also needs ${onnx.name}.json — it holds the phoneme map and sample rate`);

    // PHASES, not percentages: the runtime's progress callback fires only while downloading, and these files are
    // local. Only the OPFS copy reports a real percentage.
    onProgress({ phase: 'runtime', text: 'loading runtime…' });
    const e = await runtime();
    // The OPFS cache name carries BOTH digests: two voices sharing a filename, or one model with two configs, must
    // never serve each other's cached bytes.
    const hex = (buf, n) => Array.from(new Uint8Array(buf).slice(0, n))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    const [modelBuf, cfgBuf] = await Promise.all([
      crypto.subtle.digest('SHA-256', await onnx.arrayBuffer()),
      crypto.subtle.digest('SHA-256', await cfg.arrayBuffer()),
    ]);
    const base = `${onnx.name.replace(/\.onnx$/i, '')}-${hex(modelBuf, 6)}-${hex(cfgBuf, 4)}`;
    // The name a person sees; `base` (with digests) stays the cache key.
    const humanName = onnx.name.replace(/\.onnx$/i, '');

    // The runtime has no seam for local bytes, but getBlob() reads its OPFS cache (by basename) before fetching
    // HuggingFace: seed the cache under the names it will look for. We move the bytes, so the copy reports a percentage.
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

    // Our own session, not predict(): predict() ignores wasmPaths (CDN fetches, no offline use). TtsSession is a
    // singleton that ignores voiceId after the first construction, so drop the instance before each load.
    if (e.TtsSession._instance) e.TtsSession._instance = null;
    // The phonemizer is ours too (piperphon.js): the library rebuilds it on every call. docs/research/piper-voice-engine.md.
    const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    // The importmap maps only "onnxruntime-web", so the webgpu bundle is resolved by PATH (node_modules is served);
    // any failure falls back to the mapped default.
    const ort = await (async () => {
      if (hasGpu) {
        try {
          const url = new URL('../../node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs',
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
      piperData: new URL('../../vendor/piper/piper_phonemize.data', import.meta.url).href,
      piperWasm: new URL('../../vendor/piper/piper_phonemize.wasm', import.meta.url).href,
    };
      // ORT's builds are all threaded and need cross-origin isolation, else it silently runs single-threaded while
      // numThreads still reads 8. Ask explicitly (the default caps at 4), and log what the runtime actually has.
      const cores = navigator.hardwareConcurrency || 4;
      const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
      const sab = typeof SharedArrayBuffer !== 'undefined';
      ort.env.wasm.numThreads = isolated && sab ? Math.min(cores, 8) : 1;
      ort.env.wasm.simd = true;
      ort.env.wasm.wasmPaths = new URL('../../node_modules/onnxruntime-web/dist/', import.meta.url).href;
      console.log(`[voice] ORT: ${cores} cores · crossOriginIsolated=${isolated} · `
        + `SharedArrayBuffer=${sab} · numThreads=${ort.env.wasm.numThreads}`
        + (isolated && sab ? '' : '  ⚠️ SINGLE-THREADED — isolation headers missing'));

      // WebGPU is opt-in (see the backend choice below); WASM is the default.
      const buf = await onnx.arrayBuffer();
      // The elapsed-seconds ticker wraps the compile and is cleared in the finally: the graph compile reports nothing.
      const compileT0 = performance.now();
      const ticker = setInterval(() => {
        const s = Math.round((performance.now() - compileT0) / 1000);
        onProgress({ phase: 'compile', elapsed: s, text: `compiling voice model — ${s}s` });
      }, 1000);
      onProgress({ phase: 'compile', elapsed: 0, text: 'compiling voice model…' });
      // Declared outside the try: speak() closes over ortSession and usedEP.
      // No executionMode 'parallel': measured 21% slower (one long dependency chain). 'all' measured faster than 'basic'.
      const opts = { graphOptimizationLevel: 'all' };
      let ortSession = null, usedEP = 'wasm';
      try {
      // backend: localStorage.eidoTtsBackend = 'wasm' | 'webgpu' | 'auto' (default)
      const pref = (() => { try { return localStorage.getItem('eidoTtsBackend'); } catch { return null; } })();
      // WebGPU is opt-in (localStorage.eidoTtsBackend = 'webgpu'): its EP fails some VITS kernels at inference time,
      // and WASM often wins on short utterances anyway. Verbose ORT logging shows which ops ran where.
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
    // warm the phonemizer (~27 s) inside the load, not in front of the first utterance
    await warmPhonemizer(wasmPaths, onProgress);

    const speak = async (text) => {
      const t0 = performance.now();
      const warm = phonReady();
      // a bare short word without a sentence terminator comes out mangled (rhasspy/piper#252): add one
      const spoken = /[.!?…,;:]\s*$/.test(text.trim()) ? text : `${text.trim()}.`;
      const ids = await phonemize(spoken, espeakVoice, wasmPaths);
      const t1 = performance.now();
      const feeds = {
        input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
        input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)])),
        scales: new ort.Tensor('float32', Float32Array.from([
          // noise_scale, length_scale, noise_w — per voice from the config. noise_w is duration noise (output length
          // varies per sample); length_scale is pace AND latency. localStorage.eidoTtsLengthScale overrides for A/B.
          inf.noise_scale ?? 0.667,
          (() => { try { const v = parseFloat(localStorage.getItem('eidoTtsLengthScale')); return Number.isFinite(v) ? v : (inf.length_scale ?? 1.0); } catch { return inf.length_scale ?? 1.0; } })(),
          inf.noise_w ?? 0.8,
        ])),
      };
        // a WebGPU kernel can fail at run() after create() succeeded: rebuild once on WASM and retry
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
    // what a person calls this voice; `base` stays the cache/PATH_MAP key
    const label = `Piper: ${humanName}${sr ? ` (${sr} Hz)` : ''}`;
    setTtsSource(speak, label);
    // `id` keeps the exact identity (two same-named voices, a bug report)
    return { speak, label, id: base };
  },
});
