# Piper voice engine: measurements and decisions

Rationale behind `client/lib/audio/engine_piper.js`. The code comments point here; the history is in git.

## Latency

- Native Piper ~133 ms vs ~550 ms in WASM for the same utterance. The gap is the HiFi-GAN vocoder (stacked transposed
  convolutions, the thing WASM does worst). WASM SIMD cannot reach AVX/NEON, so the gap is structural, not a bug. The
  ~65 ms figure in the Piper README is native and usually a low/x_low model, not a comparable number.
- Ruled out: INT8 quantization (4.6x slower here); WebGPU as a default (see below); Kokoro (8.4 s/sentence, the teacher
  the voice was distilled from, not an alternative). The open option is an MB-iSTFT re-distill on a GPU workstation.
- Inference cost tracks OUTPUT duration almost exactly (RTF ~1.1). "Hello." is 0.87 s at defaults on en_US-amy-medium
  (a person says it in ~0.35 s), 0.49 s on a voice trained at 1.25 speed. `length_scale` is therefore the cheapest
  latency lever, but it is a voice decision (pace, character): it is read from the `.onnx.json`, and
  `localStorage.eidoTtsLengthScale` overrides it for A/B.

## Our own session, bypassing `predict()`

- `predict()` ignores `wasmPaths` and fetches ONNX Runtime and piper_phonemize from CDNs on every load: no offline use.
- It also rebuilds the phonemizer module on every call (~30 s measured in the browser). Its factory and session are
  WeakMap private fields, so neither can be wrapped; we phonemize (piperphon.js) and run the ORT session ourselves, and
  warm the phonemizer (~27 s) during load rather than in front of the first utterance.
- `TtsSession` is a singleton that ignores `voiceId` and `wasmPaths` after the first construction; the instance is
  dropped before each load or a second voice keeps speaking in the first.
- Local bytes reach the runtime only through its OPFS cache (`getBlob()` reads it before fetching HuggingFace), so the
  load seeds the cache under the names it will look for. The cache name carries both the model and config digests:
  two voices sharing a filename, or one model with two configs, must never serve each other's bytes.

## ORT settings (measured natively, 45-token sequence)

| setting | P50 |
| --- | --- |
| executionMode sequential (default) | 192 ms |
| executionMode parallel | 232 ms (21% worse: a VITS graph is one long dependency chain) |
| graphOptimizationLevel all | 179 ms |
| graphOptimizationLevel basic | 248 ms |

onnxruntime-web ships only threaded builds, which need SharedArrayBuffer and so cross-origin isolation; without it ORT
runs single-threaded while `numThreads` still reads 8. The default is min(cores/2, 4), so the engine asks explicitly
and logs what it actually got.

## WebGPU is opt-in

- ORT's WebGPU EP throws at INFERENCE time on some VITS kernels ("Failed to run JSEP kernel" on GatherND, an op the EP
  lists as supported, so a failing kernel rather than a missing one). `RandomNormalLike` is absent from the EP's op
  table and VITS samples noise, so a partition boundary can land in the hot path.
- For short utterances WASM SIMD+threads often beats WebGPU anyway (per-call GPU setup dominates).
- So: `localStorage.eidoTtsBackend = 'webgpu'` opts in (with ORT verbose logging), and a failed `run()` rebuilds once on
  WASM and retries. The webgpu bundle is imported by path because the importmap maps only `onnxruntime-web`.

## Output quality

- A bare short word ("hello") with no sentence terminator is outside VITS's training distribution and comes out mangled
  (rhasspy/piper#252). Appending a terminator is the documented workaround.
- `noise_w` is duration noise. Same token ids, 6 runs each: 0.8 (default) spreads output length 5.7%, 0.4 spreads 1.0%,
  0.0 is identical every time. Two near-identical texts can sound different simply because they are two samples.
  Overridable per voice in the config.

## Progress reporting

The runtime's progress callback fires only while downloading, and the files are already local. Load reports phases;
the OPFS copy is the one phase with a real percentage; compiling the graph (silent, can take tens of seconds) shows an
elapsed-seconds counter so it never looks like a hang.
