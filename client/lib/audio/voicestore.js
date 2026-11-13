// voicestore — remember a voice picked from disk: the FileSystemFileHandle itself, in IndexedDB
// (a page cannot re-open a path by name).
// The handle is not a permission: it survives a reload, the grant usually does not. On restore
// expect queryPermission() === 'prompt'; re-requesting needs a user gesture, so the UI shows the
// voice greyed with a re-pick affordance.

const DB = 'eido.voices';
const STORE = 'handles';

function idb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch (e) { return reject(e); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let out;
      try { out = fn(store); } catch (e) { return reject(e); }
      // resolve on complete, not request success: a readwrite transaction can still abort
      t.oncomplete = () => resolve(out?.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('idb aborted'));
    });
  } finally { db.close(); }
}

/** Voice identity from the bytes, not the file name (sha256 of a 60 MB model is ~0.5s, once at selection). */
export async function voiceIdentity(onnxFile, cfgFile) {
  const sha = async (f) => Array.from(new Uint8Array(
    await crypto.subtle.digest('SHA-256', await f.arrayBuffer())))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const [modelSha256, configSha256] = await Promise.all([sha(onnxFile), sha(cfgFile)]);
  let sampleRate = null, params = null;
  try {
    const cfg = JSON.parse(await cfgFile.text());
    sampleRate = cfg?.audio?.sample_rate ?? null;
    params = cfg?.inference ?? null;   // noise_scale / length_scale / noise_w
  } catch { /* config unreadable: identity still stands on the digests */ }
  return {
    // same model + different config is a different voice, so both digests carry
    id: `sha256:${modelSha256.slice(0, 16)}+${configSha256.slice(0, 16)}`,
    modelSha256, configSha256, sampleRate, params,
    engine: 'piper-tts-web', engineVersion: PIPER_WEB_VERSION,
    modelBytes: onnxFile.size, configBytes: cfgFile.size,
  };
}
// pinned in client/package.json; identity records name the runtime, not just the model
const PIPER_WEB_VERSION = '1.0.4';

/** Everything remembered, newest first: [{id, name, handles, identity}]. */
export async function listVoices() {
  const rows = await tx('readonly', (s) => s.getAll());
  return (rows || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

/** Remember one pick. `handles` are FileSystemFileHandles (a File is not persistable). */
export async function rememberVoice(id, name, handles, identity = null) {
  if (!id || !handles?.length) return false;
  try {
    await tx('readwrite', (s) => s.put({ id, name, handles, identity, savedAt: Date.now() }, id));
    return true;
  } catch (e) {
    // private-browsing profiles refuse IndexedDB; forgetting a voice beats throwing mid-load
    console.warn('[voice] could not remember voice:', e);
    return false;
  }
}

export async function forgetVoice(id) {
  try { await tx('readwrite', (s) => s.delete(id)); return true; }
  catch (e) { console.warn('[voice] could not forget voice:', e); return false; }
}

/** Can we read this remembered voice RIGHT NOW, without prompting?
 *  'granted' → usable. 'prompt' → we know the file, need a gesture.
 *  'denied'/'gone' → the entry is dead weight and should be offered for removal. */
export async function voiceReadable(entry) {
  const hs = entry?.handles || [];
  if (!hs.length) return 'gone';
  for (const h of hs) {
    if (typeof h?.queryPermission !== 'function') return 'gone';
    let st;
    try { st = await h.queryPermission({ mode: 'read' }); }
    catch { return 'gone'; }            // handle outlived its origin/file
    if (st === 'denied') return 'denied';
    if (st !== 'granted') return 'prompt';
  }
  return 'granted';
}

/** Turn a remembered entry into Files. With allowPrompt, call from a user gesture
 *  (requestPermission() throws otherwise). */
export async function openVoice(entry, { allowPrompt = false } = {}) {
  const out = [];
  for (const h of entry.handles || []) {
    let st = await h.queryPermission({ mode: 'read' });
    if (st !== 'granted') {
      if (!allowPrompt) throw new Error('permission needed — click to allow');
      st = await h.requestPermission({ mode: 'read' });
      if (st !== 'granted') throw new Error('permission refused');
    }
    out.push(await h.getFile());
  }
  return out;
}

/** Whether remembering is possible here (Firefox/Safari fall back to <input type=file>, not persistable). */
export const canRemember = () =>
  typeof indexedDB !== 'undefined' && typeof window !== 'undefined'
  && typeof window.showOpenFilePicker === 'function';
