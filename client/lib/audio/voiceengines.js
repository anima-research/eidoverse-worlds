/** voiceengines — a registry of speech engines; this module knows no engine names.
 *  An engine registers itself, declares what files it recognises, and returns what
 *  setTtsSource() takes: (text) => { pcm: Int16Array, sampleRate: number }.
 *  Adding an engine = one registerEngine() call in its own file.
 */

const engines = [];

/**
 * @param {object} spec
 * @param {string} spec.id      stable slug, e.g. 'piper'
 * @param {string} spec.label   human name for the UI
 * @param {string[]} spec.accept  file extensions it can consume ('.onnx', '.bin')
 * @param {(files: File[]) => number} spec.match
 *        Confidence this engine owns the picked files: 0 = not mine, higher
 *        wins. A SCORE rather than a boolean, because file shapes overlap —
 *        several engines use .onnx, and the one that recognises the config too
 *        should win over one that only saw a model.
 * @param {(files: File[]) => Promise<{speak: Function, label: string}>} spec.load
 *        Returns the speak fn. Throwing here is fine; the caller reports it.
 * @param {() => boolean} [spec.supported]  environment gate (WebGPU, OPFS, …)
 */
export function registerEngine(spec) {
  for (const k of ['id', 'label', 'accept', 'match', 'load']) {
    if (!spec?.[k]) throw new Error(`voice engine needs .${k}`);
  }
  const i = engines.findIndex((e) => e.id === spec.id);
  if (i >= 0) engines[i] = spec; else engines.push(spec);   // re-register = replace
}

function availableEngines() {
  return engines.filter((e) => e.supported?.() !== false).map(({ id, label, accept }) => ({ id, label, accept }));
}

/** Pick the engine that best recognises these files; null if none scores above 0. */
export function matchEngine(files) {
  let best = null, bestScore = 0;
  for (const e of engines) {
    if (e.supported?.() === false) continue;
    let s = 0;
    try { s = e.match(files) || 0; } catch { s = 0; }
    if (s > bestScore) { best = e; bestScore = s; }
  }
  return best;
}

/** Files a human picked → { engine, speak, label }. The engine is sniffed, never asked for. */

export async function loadFromFiles(files, onProgress = () => {}) {
  const e = matchEngine(files);
  if (!e) {
    const names = files.map((f) => f.name).join(', ');
    const known = availableEngines().map((x) => `${x.label} (${x.accept.join(' + ')})`).join('; ');
    throw new Error(`no engine recognises ${names}. Known formats: ${known || 'none registered'}`);
  }
  return { engine: e, ...(await e.load(files, onProgress)) };
}
