// voicestore — REMEMBER A VOICE YOU PICKED FROM YOUR OWN DISK.
//
// R, 2026-08-09: "it doesn't seem to remember which model I selected locally but
// maybe that's okay? There's also no way to *remove* models from the dropdown."
// It was not okay: a catalog voice (a name we fetch) persisted fine, while a
// file you chose vanished on reload — the same control forgetting one kind of
// choice and not the other, for reasons entirely invisible from the UI.
//
// WHY THIS NEEDS A MODULE AND NOT A localStorage KEY. A file path is useless: a
// page cannot re-open `/home/you/glados.onnx` by name, and browsers will never
// allow it — that would make any tab a file reader. What CAN be stored is the
// FileSystemFileHandle itself, which is structured-cloneable and therefore
// IndexedDB-storable. This is exactly how an editor's "recent files" works.
//
// 🔴 THE HANDLE IS NOT A PERMISSION. It survives a reload; the GRANT usually
// does not. On restore you must call queryPermission() and be ready for
// 'prompt' — meaning "I still know which file, but I may not read it until you
// say so." Re-requesting needs a user gesture, so the honest UI shows the voice
// greyed with a re-pick affordance rather than silently failing at load time.
// A remembered voice that cannot be read yet is a REAL state, and pretending
// otherwise is the display-vs-real-state bug that has cost the most time here.

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
      // Resolve on COMPLETE, not on the request's success: a readwrite
      // transaction can still abort after its request succeeded (quota, a
      // concurrent close), and resolving early would report a save that did not
      // durably happen.
      t.oncomplete = () => resolve(out?.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('idb aborted'));
    });
  } finally { db.close(); }
}

/** Everything remembered, newest first: [{id, name, handles}]. */
export async function listVoices() {
  const rows = await tx('readonly', (s) => s.getAll());
  return (rows || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

/** Remember one pick. `files` are the FileSystemFileHandles, not File objects —
 *  a File is a snapshot of bytes and is NOT persistable; the handle is. */
export async function rememberVoice(id, name, handles) {
  if (!id || !handles?.length) return false;
  try {
    await tx('readwrite', (s) => s.put({ id, name, handles, savedAt: Date.now() }, id));
    return true;
  } catch (e) {
    // Private-browsing and locked-down profiles refuse IndexedDB outright.
    // Forgetting a voice is a small loss; a thrown error mid-load is not.
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

/** Turn a remembered entry into Files. MUST be called from a user gesture when
 *  readable() said 'prompt' — requestPermission() throws otherwise, and that
 *  throw is the browser enforcing consent, not a bug to catch and ignore. */
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

/** Whether remembering is possible at all here. The file-picker path exists
 *  without it (Firefox/Safari use <input type=file>, whose File objects cannot
 *  be persisted), so the UI must not promise memory it cannot deliver. */
export const canRemember = () =>
  typeof indexedDB !== 'undefined' && typeof window !== 'undefined'
  && typeof window.showOpenFilePicker === 'function';
