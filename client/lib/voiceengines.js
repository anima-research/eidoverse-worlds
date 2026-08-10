/** voiceengines — a SLOT for speech engines, the way the world has a slot for
 *  components.
 *
 *  R asked for this shape directly (2026-08-09): "Can we do a slot-component
 *  solution for this under the hood like we do for eidoverse itself?" Yes, and
 *  it is the right call — the alternative was already rotting. Piper was baked
 *  into 21 places across two files, so "support Kokoro too" meant editing the
 *  dropdown, the loader, and the accept list, and every engine after it would
 *  cost the same again. That is the enum basin: a kind-list masquerading as a
 *  capability.
 *
 *  The server's comp fold is the model (server.ts:407):
 *
 *      if (a.data == null) delete ent.comp[a.type]; else ent.comp[a.type] = a.data;
 *      // "Blind by design: `data` is opaque here."
 *
 *  It stores components without knowing a single component type. The meaning
 *  lives in the data and in whoever reads it. So here: this module knows no
 *  engine names. An engine REGISTERS itself, declares what files it recognises,
 *  and returns the one thing the rest of the system wants —
 *
 *      (text) => { pcm: Int16Array, sampleRate: number }
 *
 *  which is exactly what setTtsSource() has always taken. The universal seam was
 *  already there; only the loading layer had an enum in it.
 *
 *  Adding an engine = one registerEngine() call in its own file. Nothing here,
 *  in the panel, or in the accept list changes. A stranger can add one without
 *  touching code they did not write — the test from the enum-basin note: *can
 *  someone need a value that isn't listed?* Yes → it is data, not an enum.
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

/** Every extension any registered engine accepts — the file dialog's filter,
 *  derived rather than hardcoded. This is why adding an engine does not mean
 *  editing an accept string somewhere else. */
export function acceptedExtensions() {
  return [...new Set(engines.flatMap((e) => (e.supported?.() === false ? [] : e.accept)))];
}

export function availableEngines() {
  return engines.filter((e) => e.supported?.() !== false).map(({ id, label, accept }) => ({ id, label, accept }));
}

/** Pick the engine that best recognises these files. Returns null if none does,
 *  which the caller must render as "we do not know this format" — never as a
 *  silent failure, and never by guessing at the highest-scoring zero. */
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

/** The whole public flow: hand it the files a human picked, get back a speak fn.
 *  Deliberately does NOT ask which engine — sniffing is the point, because a
 *  person with a voice model should not have to know which runtime consumes it.
 */
/** Sessions already built this page-load, keyed by the files that made them.
 *
 *  🔴 R asked: "can we cache the model load so we don't have to do it all over
 *  again on every reload?" Two separate costs hide behind that question, and
 *  only one of them was already handled:
 *
 *    1. THE BYTES — 60 MB. Already cached in OPFS, keyed by basename. Fast.
 *    2. THE COMPILED GRAPH — InferenceSession.create(). ORT parses the protobuf,
 *       plans memory, fuses ops and JITs kernels. THIS is the ~30s.
 *
 *  (2) cannot be written to storage: onnxruntime-web has no save/restore of a
 *  compiled session, so a genuine page RELOAD must pay it again. What we CAN fix
 *  is paying it twice in one page — switching voice away and back rebuilt the
 *  whole graph even though the old session was still perfectly good.
 *
 *  Keyed by name+size+lastModified of every file: same bytes, same session. */
const _sessions = new Map();
const keyOf = (files) => files.map((f) => `${f.name}:${f.size}:${f.lastModified ?? 0}`).sort().join('|');

export async function loadFromFiles(files, onProgress = () => {}) {
  const e = matchEngine(files);
  if (!e) {
    const names = files.map((f) => f.name).join(', ');
    const known = availableEngines().map((x) => `${x.label} (${x.accept.join(' + ')})`).join('; ');
    throw new Error(`no engine recognises ${names}. Known formats: ${known || 'none registered'}`);
  }
  return { engine: e, ...(await e.load(files, onProgress)) };
}
