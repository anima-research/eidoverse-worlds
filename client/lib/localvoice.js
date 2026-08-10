// localvoice — PIPER IN THE USER'S OWN BROWSER, on the human speech lane.
//
// R's constraint (2026-08-09): "a local model that the user does their own
// inference for and runs on the same speech lane that human mic voice does" —
// and explicitly NOT the server serving the models, because they are ~60 MB.
//
// So: the browser fetches the voice DIRECTLY FROM HUGGING FACE (verified
// 2026-08-09: the CDN answers `access-control-allow-origin: *`, 63 MB, 200
// after a 302), runs the inference itself, and hands PCM to the same
// setTtsSource() seam the ws:// endpoint uses. Our server never sees a model,
// and the output rides voiceSource() — the identical path a microphone takes,
// so distance, the category sliders and consent all apply by construction
// rather than by a parallel implementation that has to remember to.
//
// The endpoint box does not go away; it becomes the ADVANCED option, for a
// voice the public catalog does not have (hesperus-clockwork is ours) or a
// GPU-backed synth. Dropdown for everyone else.
//
// Caching: the runtime stores the model in the Origin Private File System, so
// the ~60 MB download happens once per voice per browser and survives reloads.

import { setTtsSource } from './tts.js';
import { report } from './core.js';
import { decodeWavToPcm } from './wavpcm.js';

const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

// THE CATALOG IS THE PACKAGE'S, NOT MINE. It ships voices() — 118 voices
// across 37 languages with real file sizes and metadata — so hardcoding five
// would be inventing a worse version of data that already exists. I wrote that
// hardcoded list first; checking the .d.ts is what replaced it.
//
// We still curate the DEFAULT view: a raw 118-entry dropdown is its own
// usability failure. English first, one quality tier per voice, everything
// else behind "show all".
const PREFERRED = [
  'en_US-amy-medium', 'en_US-lessac-medium', 'en_US-ryan-high',
  'en_GB-alba-medium', 'en_GB-northern_english_male-medium', 'en_US-hfc_female-medium',
];

let catalog = null;

/** The full catalog, fetched once. Each entry carries its own byte sizes, so
 *  the UI can say "63 MB" honestly instead of guessing. */
export async function listVoices() {
  if (catalog) return catalog;
  const mod = await runtime();
  const all = await mod.voices();
  catalog = all.map((v) => {
    const onnx = Object.entries(v.files).find(([k]) => k.endsWith('.onnx'));
    return {
      key: v.key,
      label: `${v.name} (${v.language.country_english}, ${v.quality})`,
      lang: v.language.code,
      mb: onnx ? Math.round(onnx[1].size_bytes / 1e6) : null,
      preferred: PREFERRED.includes(v.key),
    };
  });
  return catalog;
}

/** What the dropdown shows by default: the curated few, biggest-signal first. */
export const suggestedVoices = async () =>
  (await listVoices()).filter((v) => v.preferred);

let engine = null;      // the loaded runtime, once a voice is chosen
let loadedKey = null;

/** Lazily import the runtime. Nobody who never picks a local voice should pay
 *  for the bundle. @mintplex-labs/piper-tts-web is the MAINTAINED fork (1.0.4,
 *  Feb 2026); @diffusionstudio/vits-web — the name everyone cites — has not
 *  been touched since Sep 2024. Checked; do not trust the popular name. */
async function runtime() {
  if (!engine) engine = await import('@mintplex-labs/piper-tts-web');
  return engine;
}

/** @deprecated Superseded by engine-piper.js, which owns this logic as a plugin
 *  behind the voiceengines.js slot. Kept only until the download path (
 *  useLocalVoice, still live below) is moved behind the slot too; delete then
 *  rather than letting two copies of the OPFS trick drift apart.
 *
 *  Use a Piper voice ALREADY ON THIS COMPUTER — no server, no endpoint, no
 *  download. R asked for exactly this (2026-08-09): "it would be best if the
 *  endpoints are file names on a person's own machine and the engine sets up all
 *  the endpoint stuff for them automatically."
 *
 *  The runtime has no public seam for local model bytes — TtsSession always
 *  resolves a voiceId through PATH_MAP and fetches from HuggingFace. But its
 *  getBlob() checks an OPFS cache FIRST and only fetches on a miss, keyed by the
 *  URL's basename. So we seed the cache with the user's own files under the
 *  names the runtime will look for, and it loads them without a single network
 *  request. No library patch, no fork — we are using its own cache the way it
 *  already works.
 *
 *  @param onnxFile  the .onnx model  @param cfgFile  its .onnx.json config
 */
export async function useVoiceFiles(onnxFile, cfgFile) {
  if (!navigator.storage?.getDirectory) throw new Error('this browser has no OPFS — cannot load a local voice file');
  const engine = await runtime();

  // The runtime derives BOTH cache names from one voiceId, and the config name
  // is always `${model}.json`. Honour that or the config lookup misses and it
  // silently falls back to the network.
  const base = onnxFile.name.replace(/\.onnx$/i, '');
  const voiceId = base;
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('piper', { create: true });
  for (const [name, file] of [[`${base}.onnx`, onnxFile], [`${base}.onnx.json`, cfgFile]]) {
    const h = await dir.getFileHandle(name, { create: true });
    const w = await h.createWritable();
    await w.write(await file.arrayBuffer());
    await w.close();
  }

  // PATH_MAP is how voiceId becomes a URL. A voice we just invented is not in
  // it, so add it — the basename is all the cache lookup ends up using.
  if (engine.PATH_MAP && !engine.PATH_MAP[voiceId]) {
    try { engine.PATH_MAP[voiceId] = `${base}.onnx`; }
    catch { throw new Error('runtime PATH_MAP is not extensible in this version'); }
  }

  const sr = await (async () => {
    try { return JSON.parse(await cfgFile.text())?.audio?.sample_rate ?? null; } catch { return null; }
  })();

  setTtsSource(async (text) => {
    const wav = await engine.predict({ text, voiceId });
    return decodeWavToPcm(await wav.arrayBuffer());
  }, `file: ${base}${sr ? ` (${sr} Hz)` : ''}`);
  loadedKey = voiceId;
  return true;
}

/** Is a browser-side runtime even possible here? Needs WASM + (ideally) OPFS. */
export const localVoiceSupported = () => (
  typeof WebAssembly === 'object' &&
  typeof navigator !== 'undefined' &&
  !!navigator.storage?.getDirectory
);

/** Download progress is not a nicety at 63 MB — it is the difference between
 *  "broken" and "working, wait a moment". Callers pass a reporter. */
export async function useLocalVoice(voiceKey, onProgress = () => {}) {
  const v = (await listVoices()).find((x) => x.key === voiceKey);
  if (!v) throw new Error(`unknown voice: ${voiceKey}`);
  if (!localVoiceSupported()) throw new Error('this browser cannot run a local voice');

  onProgress({ phase: 'runtime' });
  await runtime();
  if (false) {
    // Imported lazily: nobody who never picks a local voice should pay for the
    // runtime bundle. @mintplex-labs/piper-tts-web is the maintained fork
    // (Feb 2026); @diffusionstudio/vits-web, the name everyone cites, has not
    // been touched since Sep 2024 — checked, do not trust the popular name.
  }

  if (loadedKey !== voiceKey) {
    onProgress({ phase: 'download', mb: v.mb });
    await engine.download(voiceKey, (p) => {
      if (p?.total) onProgress({ phase: 'download', mb: v.mb, pct: Math.round((p.loaded / p.total) * 100) });
    });
    loadedKey = voiceKey;
  }

  onProgress({ phase: 'ready' });
  // THE SEAM. Same shape the ws:// endpoint returns — {pcm: Int16Array,
  // sampleRate} — so everything downstream (the pacer, the generator, the
  // sender, distance, consent) is byte-identical whether the samples came from
  // a local model, a remote synth, or a microphone.
  setTtsSource(async (text) => {
    // predict() takes a CONFIG OBJECT and returns a Blob — checked against the
    // shipped .d.ts, not guessed. My first draft called it predict(text, id).
    const wav = await engine.predict({ text, voiceId: voiceKey });
    return decodeWavToPcm(await wav.arrayBuffer());
  }, `local: ${v.label}`);

  return true;
}
