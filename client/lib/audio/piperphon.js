// piperphon — build the phonemizer once, in a worker (phon.worker.js), and keep it.
// @mintplex-labs/piper-tts-web's predict() rebuilds the 17 MB espeak-ng emscripten module on
// every call (~30 s per utterance); inference itself is nearly free, so we make the same
// build call ourselves and reuse the module (callMain is re-entrant).
let _worker = null, _seq = 0;
const _pending = new Map();
let _ready = false;

function worker() {
  if (_worker) return _worker;
  _worker = new Worker(new URL('./phon.worker.js', import.meta.url), { type: 'module' });
  _worker.onmessage = (e) => {
    const { id, ok, ids, error } = e.data || {};
    const p = _pending.get(id);
    if (!p) return;                      // a reply to a call that already gave up
    _pending.delete(id);
    ok ? p.resolve(ids) : p.reject(new Error(error || 'phonemizer failed'));
  };
  // a dead worker rejects every in-flight call rather than leaving promises unsettled
  _worker.onerror = (e) => {
    const err = new Error(`phonemizer worker died: ${e.message || 'unknown'}`);
    for (const p of _pending.values()) p.reject(err);
    _pending.clear(); _worker = null; _ready = false;
  };
  return _worker;
}

/** Resolve the chunk URL here, not in the worker, where import.meta.url differs. */
function wasmBundle(wasmPaths) {
  return {
    // piper-tts-web 1.0.4's hashed chunk: client/package.json pins that version exactly
    js: new URL('../../node_modules/@mintplex-labs/piper-tts-web/dist/piper-o91UDS6e.js',
                import.meta.url).href,
    wasm: new URL(wasmPaths.piperWasm, location.href).href,
    data: new URL(wasmPaths.piperData, location.href).href,
  };
}

function ask(op, payload, timeoutMs = 120_000) {
  const id = ++_seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(id);
      reject(new Error(`phonemizer ${op} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    _pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject:  (e) => { clearTimeout(timer); reject(e); },
    });
    worker().postMessage({ id, op, ...payload });
  });
}


/** Text → phoneme ids, computed in the worker. */
export async function phonemize(text, voice, wasmPaths) {
  const ids = await ask('phonemize', { text, voice, wasmPaths: wasmBundle(wasmPaths) });
  _ready = true;
  return ids;
}

/** Build the module ahead of the first utterance, inside the load the user is already watching. */
export async function warmPhonemizer(wasmPaths, onProgress = () => {}) {
  if (_ready) return true;
  const t0 = performance.now();
  const tick = setInterval(() => {
    onProgress({ phase: 'phonemizer',
      text: `building pronunciation — ${Math.round((performance.now() - t0) / 1000)}s` });
  }, 1000);
  try {
    await ask('warm', { wasmPaths: wasmBundle(wasmPaths) });
    _ready = true;
    console.log(`[voice] phonemizer ready in ${Math.round(performance.now() - t0)}ms (worker)`);
    return true;
  } catch (e) {
    console.warn('[voice] phonemizer warm-up failed:', e);
    return false;
  } finally { clearInterval(tick); }
}

export const phonReady = () => _ready;
