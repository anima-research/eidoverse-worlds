/** The phonemizer, running where its loader is fast.
 *
 *  🔴 WHY THIS FILE EXISTS — measured 2026-08-09, same bytes, same code:
 *
 *      module build in Bun (native fs):       57 ms
 *      module build on the browser main thread:   27,551 ms      ← 480x
 *
 *  So the 17 MB espeak-ng data package is NOT the problem, and trimming it (the
 *  advice every search result gives) would not have helped. The gap is in HOW
 *  the browser path loads: piper-o91UDS6e.js contains two
 *
 *      xhr.open("GET", url, false)
 *
 *  — synchronous XHR — and its own comment concedes that browsers deprecated
 *  "synchronous binary XHRs outside webworkers in modern browsers". Those calls
 *  are guarded by ENVIRONMENT_IS_WORKER: inside a Worker the synchronous path is
 *  legal and fast, on the main thread it is the slow deprecated one.
 *
 *  Running here is therefore not a nicety about avoiding UI jank. It is what
 *  makes the load fast at all.
 *
 *  PROTOCOL — deliberately tiny, because the seam already existed in
 *  piperphon.js (phonemize / warmPhonemizer / phonReady):
 *      → { id, op: 'warm',      wasmPaths }         ← { id, ok }
 *      → { id, op: 'phonemize', text, voice, wasmPaths } ← { id, ok, ids }
 *      any failure                                   ← { id, ok: false, error }
 *  Every reply carries the id it answers, so a slow call cannot resolve a fast
 *  one's promise.
 */

let _mod = null;
let _building = null;
// Where the CURRENT call wants stdout to go. Emscripten captures Module.print
// ONCE at construction (piper-o91UDS6e.js:292 — `var out = Module["print"] ||
// console.log`), so the handler must be permanent and the sink swappable.
// Reassigning print per call silently sent every result to console.log.
let _sink = null, _errSink = null;

async function build(wasmPaths) {
  if (_mod) return _mod;
  if (_building) return _building;
  _building = (async () => {
    const { createPiperPhonemize } = await import(wasmPaths.js);
    _mod = await createPiperPhonemize({
      print: (data) => { _sink?.(data); },
      printErr: (msg) => { _errSink?.(msg); },
      locateFile: (url) =>
        url.endsWith('.wasm') ? wasmPaths.wasm :
        url.endsWith('.data') ? wasmPaths.data : url,
    });
    return _mod;
  })();
  try { return await _building; } finally { _building = null; }
}

function run(mod, text, voice) {
  let ids = null;
  _sink = (data) => { try { ids = JSON.parse(data).phoneme_ids; } catch { /* not our line */ } };
  // stderr is CHATTER until proven otherwise (r5 self-review): Emscripten's
  // printErr carries espeak warnings and info lines, and throwing on any of
  // them failed the whole phonemize call on output that wasn't an error.
  // Collect; it becomes the diagnostic only if the run produces no ids.
  const errLines = [];
  _errSink = (msg) => { errLines.push(String(msg)); };
  try {
    mod.callMain(['-l', voice || 'en-us', '--input', JSON.stringify([{ text }]),
                  '--espeak_data', '/espeak-ng-data']);
  } catch (e) {
    // callMain throws its exit code even on success; a real failure is an Error.
    if (typeof e !== 'number' && e?.status === undefined) throw e;
    // exit-code throws are normal; real failures fall through to the ids
    // check below, where collected stderr becomes the message.
  } finally {
    _sink = null; _errSink = null;
  }
  if (!ids && errLines.length) throw new Error('phonemizer produced no ids; stderr: ' + errLines.slice(-5).join(' | '));
  if (!ids) throw new Error('phonemizer produced no ids'
    + (errLines.length ? '; stderr: ' + errLines.slice(-5).join(' | ') : ''));
  return ids;
}

self.onmessage = async (e) => {
  const { id, op, text, voice, wasmPaths } = e.data || {};
  try {
    const mod = await build(wasmPaths);
    if (op === 'warm') { self.postMessage({ id, ok: true }); return; }
    self.postMessage({ id, ok: true, ids: run(mod, text, voice) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
