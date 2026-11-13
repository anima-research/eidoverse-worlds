/** The phonemizer worker (driven by piperphon.js).
 *
 *  Why a Worker: the emscripten build loads espeak-ng's data with synchronous XHR, which is
 *  the slow deprecated path on the main thread (~27 s) and the fast legal one in a Worker.
 *
 *  Protocol — every reply carries the id it answers:
 *      → { id, op: 'warm',      wasmPaths }              ← { id, ok }
 *      → { id, op: 'phonemize', text, voice, wasmPaths } ← { id, ok, ids }
 *      any failure                                        ← { id, ok: false, error }
 */

let _mod = null;
let _building = null;
// per-call stdout/stderr sinks: Emscripten captures Module.print once at construction
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
  // stderr is espeak chatter; it becomes the diagnostic only if the run yields no ids
  const errLines = [];
  _errSink = (msg) => { errLines.push(String(msg)); };
  try {
    mod.callMain(['-l', voice || 'en-us', '--input', JSON.stringify([{ text }]),
                  '--espeak_data', '/espeak-ng-data']);
  } catch (e) {
    // callMain throws its exit code even on success; only a real Error propagates
    if (typeof e !== 'number' && e?.status === undefined) throw e;
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
