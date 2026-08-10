// ttsrow — the text-to-speech section, as a LIST of voices you have.
//
// Replaces a 670-line dropdown that had accumulated: a catalog we no longer
// ship, a "loading voices…" entry that was not a voice, a verb disguised as an
// option, a +/− pair whose "−" could not name its target, and browser speech,
// which cannot reach the mic lane at all and so was a permanent trap.
//
// The rule that killed all of it (R, 2026-08-09): a <select> is for choosing
// among options SOMEONE ELSE fixed. The moment the options are ones the user
// adds and removes, the list wants to be visible and the verb belongs on the
// row. See feedback_dropdown_vs_list.md.
//
// What remains is BYOV: a model file from your disk, or a speech server you run.
// Both transmit; nothing here is local-only, because a voice that only you can
// hear is indistinguishable from a working one until nobody answers.
import { renderVoiceList } from './voicelist.js';
import { ttsAvailable, ttsVoiceName, isTtsEnabled, setTtsEnabled, setTtsSource } from './tts.js';
import { setEndpointVoice } from './browservoice.js';
import { report } from './core.js';
// The id of whatever is currently installed, so the list can show a filled dot
// against it. Null when nothing is loaded — which is a real state, not an error.
let _selected = null;
/** Transient "you need a voice first" prompt, shown only after the user tries
 *  to tick the box with nothing loaded, and cleared the moment they act on it.
 *  NOT the permanent 'add a voice below' note R rejected twice — that pointed
 *  at rows already visible. This appears in response to a specific attempt and
 *  answers why the tick did not take. */
let _needVoice = false, _needVoiceTimer = 0;
/** Ticking TTS no longer touches the mic (R, 2026-08-09). MIC BEATS TTS is a
 *  PRIORITY, not a toggle: both settings stand and the live mic simply wins
 *  while it is on. Turning TTS on with the mic live arms it for the moment the
 *  mic goes off — nothing to re-tick, which is the whole advantage over the
 *  symmetric version I built first. */
let _busy = null;          // a phase string while loading, else null
/** A voice being imported RIGHT NOW: shown in the list as a ghost row with a
 *  running timer, so a slow prepare (the phonemizer build is ~27s on first use)
 *  reads as work rather than as nothing happening. */
let _loadingId = null, _loadingName = null, _loadingSince = 0;
/** 🔴 ONE LOAD AT A TIME (R, 2026-08-09: "re-clicking the box appears to make it
 *  thrash and start over"). Compiling the graph takes 30s+, and nothing stopped
 *  a second click from starting a SECOND compile racing the first — two 63 MB
 *  compiles competing for the same cores, each making the other slower, and
 *  whichever finished last won. A click during a load is now a no-op. */
let _inFlight = null;
// A pick that is missing its other half — kept so it can be resumed rather than
// discarded. See addFile().
let _pending = null;
/** Everything we know how to speak with: remembered files + this session's
 *  endpoints. Kept here rather than in the list so the list stays a renderer. */
async function collectVoices() {
  const out = [];
  try {
    const { listVoices, voiceReadable, canRemember } = await import('./voicestore.js');
    if (canRemember()) {
      for (const v of await listVoices()) {
        const state = await voiceReadable(v);
        if (state === 'denied' || state === 'gone') continue;
        out.push({
          id: v.id,
          name: v.name,
          dim: state !== 'granted',
          note: state === 'granted'
            ? `${v.name} — a model on this computer`
            : `${v.name} — remembered, but this browser must ask before reading it again`,
        });
      }
    }
  } catch (e) { console.warn('[voice] could not list remembered voices:', e); }
  for (const ep of endpoints()) {
    out.push({ id: `ep:${ep}`, name: ep, note: `speech server at ${ep}` });
  }
  // The half-finished pick, if there is one — first, because it is the thing
  // asking for attention.
  if (_pending) {
    out.unshift({
      id: '__pending',
      // AN INSTRUCTION, NOT A DIAGNOSIS. R: "I would make the failure retry text
      // say 'select the .onnx.json.' Make it very clear what the user needs to
      // do." "needs its .onnx.json" describes a state; "select the .onnx.json"
      // is the next action, which is the only thing a stuck person wants.
      name: `select the ${_pending.want} for ${_pending.have}`,
      dim: true,
      note: `you picked ${_pending.have}; a Piper voice also needs its ${_pending.want}. Click to choose it.`,
    });
  }
  return out;
}
// Endpoints live in localStorage as a list, not a single value: "the one
// endpoint" was a field you had to retype every time you wanted the other one.
const EP_KEY = 'eido.ttsEndpoints';
const endpoints = () => {
  try { return JSON.parse(localStorage.getItem(EP_KEY) || '[]'); } catch { return []; }
};
const saveEndpoints = (list) => {
  try { localStorage.setItem(EP_KEY, JSON.stringify(list.slice(0, 12))); } catch { /* private mode */ }
};
/** Build (and rebuild) the section. `host` is the row container; `onPaint` lets
 *  the panel repaint sibling rows whose state we just changed. */
export function ttsSection(host, onPaint = () => {}) {
  const repaint = () => { build(); onPaint(); };
    /** 🔴 EVERY LOAD GOES THROUGH HERE, so the guard and the loading row belong
     *  HERE — not in finishImport, where I put them and where the CHECKBOX path
     *  never reaches. That is why R saw "no timer" twice after I twice reported
     *  it fixed: clicking the tick calls pick(), which set no _loadingId, so no
     *  row and no clock were ever built. Same reason re-clicking still thrashed.
     *  One entry point, one guard, one row. */
    async function pick(id) {
      if (id === '__pending') return resumePending();
      if (id === _selected && ttsAvailable()) return;    // already live
      if (_inFlight) {
        // A second click during a 30s compile used to start a SECOND compile
        // racing the first — two 63 MB graphs fighting for the same cores.
        console.log(`[voice] already loading ${_inFlight}; ignoring ${id}`);
        return;
      }
      _inFlight = id;
      // The loading row + clock, for EVERY path into a load.
      _loadingId = id;
      _loadingName = id.replace(/^file:/, '').replace(/^ep:/, '');
      _loadingSince = Date.now();
      build();
      try {
        return await pickInner(id);
      } finally {
        _inFlight = null; _loadingId = null; _busy = null;
        repaint();
      }
    }
    async function pickInner(id) {
    try {
      if (id.startsWith('ep:')) {
        await setEndpointVoice(id.slice(3));
      } else {
        const { listVoices, openVoice } = await import('./voicestore.js');
        const entry = (await listVoices()).find((v) => v.id === id);
        if (!entry) throw new Error('that voice is no longer remembered');
        // allowPrompt: this runs from a click, which is the only context in
        // which requestPermission() may ask.
        const files = await openVoice(entry, { allowPrompt: true });
        const { loadFromFiles } = await import('./voiceengines.js');
        await import('./engines.js');
        await loadFromFiles(files, (p) => {
        _busy = p.text || p.phase || 'loading…';
        if (!liveStatus(_busy)) build();
      });
      }
      _selected = id;
    // Remember it so ticking the box later picks what they used last.
    try { localStorage.setItem('eido.tts.lastVoice', id); } catch { /* private mode */ }
    _needVoice = false;   // they acted on the prompt; it has served its purpose
      setTtsEnabled(true);
    } catch (e) {
      report('tts voice', e);
      _busy = String(e?.message || e).slice(0, 80);
      build();
      setTimeout(() => { _busy = null; repaint(); }, 2500);
      return;
    }
    _busy = null;
    repaint();
  }
  async function remove(id) {
    if (id === '__pending') { _pending = null; repaint(); return; }
    if (id.startsWith('ep:')) {
      saveEndpoints(endpoints().filter((e) => e !== id.slice(3)));
    } else {
      const { forgetVoice } = await import('./voicestore.js');
      await forgetVoice(id);
    }
    // Removing what is currently speaking also stops it — leaving a live voice
    // whose entry is gone would be state the UI cannot show.
    if (id === _selected) { setTtsSource(null); setTtsEnabled(false); _selected = null; }
    repaint();
  }
  /** Finish an import once both halves are in hand. Shared by addFile() and
   *  resumePending() so a resumed import cannot behave differently from a
   *  first-try one — two paths to the same outcome is how this panel has been
   *  drifting all day. */
  async function finishImport(handles, files) {
    const { loadFromFiles } = await import('./voiceengines.js');
    await import('./engines.js');
    const shown = (files.find((f) => /\.onnx$/i.test(f.name)) || files[0])?.name || 'voice';
    const name = shown.replace(/\.onnx$/i, '');
      // 🔴 _busy MUST BE CLEARED ON EVERY EXIT. The add button greys itself while
      // busy (voicelist.js), so a throw in here left it grey FOREVER — R,
      // 2026-08-09: "the add a text-to-speech model button goes gray after one is
      // added, so you can't add more". try/finally, not a trailing assignment.
      _busy = `loading ${name}…`;
      // Show the model in the list IMMEDIATELY, loading, so a slow prepare reads
      // as work-in-progress rather than nothing happening. The phonemizer build
      // is ~27s on first use; without this the panel looks inert for half a
      // minute and a silent failure is indistinguishable from a slow success.
      _loadingId = `file:${name}`; _loadingName = name; _loadingSince = Date.now();
      build();
      try {
        await loadFromFiles(files, (p) => {
        _busy = p.text || p.phase || `loading ${name}…`;
        // 🔴 UPDATE TEXT, DO NOT REBUILD. build() does host.textContent = '' and
        // remakes every row — once a second, for 30+ seconds. That is the thrash
        // R saw, and it also resets anything mid-interaction. Write into the
        // existing nodes; fall back to a rebuild only if they are not there yet.
        if (!liveStatus(_busy)) build();
      });
        const id = `file:${name}`;
        try {
          const { rememberVoice, canRemember } = await import('./voicestore.js');
          if (canRemember()) await rememberVoice(id, name, handles);
        } catch (e) { console.warn('[voice] not remembered:', e); }
        _pending = null;
        _selected = id;
        setTtsEnabled(true);
      } catch (e) {
        report('tts voice', e);
        _busy = String(e?.message || e).slice(0, 80);
        build();
        setTimeout(() => { _busy = null; _loadingId = null; repaint(); }, 3000);
        return;
      } finally {
        _loadingId = null;
      }
      _busy = null;
    repaint();
  }
  /** Ask again for the missing half of a partial pick. */
  async function resumePending() {
    if (!_pending || !window.showOpenFilePicker) return;
    const { have, want } = _pending;
    try {
      const more = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: `Matching ${want} for ${have}`,
                  accept: want === '.onnx' ? { 'application/octet-stream': ['.onnx'] }
                                           : { 'application/json': ['.json'] } }],
      });
      if (!more?.length) return;                       // dismissed again: row stays
      const handles = [..._pending.handles, ...more];
      const files = [..._pending.files, ...await Promise.all(more.map((h) => h.getFile()))];
      const { matchEngine } = await import('./voiceengines.js');
      await import('./engines.js');
      if (!matchEngine(files)) {
        // Still not a pair — keep the row rather than dropping back to nothing.
        _pending = { ..._pending, handles, files };
        _busy = `that was not a ${want} — try again`;
        build();
        return;
      }
      await finishImport(handles, files);
    } catch (e) {
      if (e?.name === 'AbortError') return;            // dismissed: row stays, silently
      report('resume voice import', e);
    }
  }
  async function addFile() {
    try {
      const { loadFromFiles, matchEngine } = await import('./voiceengines.js');
      await import('./engines.js');
      if (!window.showOpenFilePicker) {
        _busy = 'this browser cannot pick files here — use a speech server';
        build(); setTimeout(() => { _busy = null; repaint(); }, 3000);
        return;
      }
      let handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'Piper voice (.onnx + .onnx.json)',
                  accept: { 'application/octet-stream': ['.onnx'], 'application/json': ['.json'] } }],
      });
      let files = await Promise.all(handles.map((h) => h.getFile()));
      // A lone .onnx is the common near-miss. Ask for the rest, NAMING what is
      // missing — an unlabelled second dialog reads as a bug.
      if (!matchEngine(files) || files.length === 1) {
        const have = files[0]?.name || 'a file';
        const want = /\.onnx$/i.test(have) ? '.onnx.json' : '.onnx';
        _busy = `${have} selected — now pick the matching ${want}`;
        build();
        const more = await window.showOpenFilePicker({
          multiple: true,
          types: [{ description: `Matching ${want} for ${have}`,
                    accept: want === '.onnx' ? { 'application/octet-stream': ['.onnx'] }
                                             : { 'application/json': ['.json'] } }],
        }).catch(() => null);
        if (more?.length) {
          handles = [...handles, ...more];
          files = [...files, ...await Promise.all(more.map((h) => h.getFile()))];
        } else {
          // 🔴 A HALF-FINISHED IMPORT BECOMES A ROW, NOT A DISAPPEARING MESSAGE.
          // R: "I clicked close on the second panel to see what would happen and
          // the error telling you what to do didn't last long before reverting."
          // Right — the instruction was a toast on a timer, so dismissing the
          // dialog left you with nothing to click and nothing to read. Worse,
          // the .onnx you already chose was thrown away.
          //
          // Now the partial pick is kept and listed: click it to be asked for
          // the missing half again. State that can be resumed should live in
          // the list, where it is visible until you act on it, not in a message
          // that expires.
          _pending = { handles, files, have, want };
          _busy = null;
          repaint();
          return;
        }
      }
      await finishImport(handles, files);
    } catch (e) {
      // An aborted picker is a choice, not an error.
      if (e?.name === 'AbortError') { _busy = null; build(); return; }
      report('add voice file', e);
      _busy = String(e?.message || e).slice(0, 80);
      build(); setTimeout(() => { _busy = null; repaint(); }, 3000);
    }
  }
  function addEndpoint() {
    const addr = prompt('Address of a speech server you are running:\n(ws://… or http://…)', 'ws://127.0.0.1:8927');
    if (!addr) return;
    const list = endpoints();
    if (!list.includes(addr)) { list.unshift(addr); saveEndpoints(list); }
    pick(`ep:${addr}`);
  }
    /** Write the current status into nodes that already exist, returning false if
     *  they are not built yet so the caller can fall back to a full build.
     *  Exists because build() does host.textContent = '' — rebuilding every row
     *  once a second for 30+ seconds is the thrash R saw, and it resets anything
     *  mid-interaction. */
    function liveStatus(text) {
      // Only the loading ROW carries progress now; the header note is about
      // which voice is live, and echoing progress there was the double message.
      const row = host.querySelector('.vl-loading .vl-note');
      if (!row) return false;
      row.textContent = text || '';
      return true;
    }
  function build() {
    host.textContent = '';
    const head = document.createElement('div');
    head.className = 'sp-row';
    const live = ttsAvailable() && isTtsEnabled();
    // Same two columns as every other row: label, then control. The status note
    // rides in the control column beside the tick rather than starting a third
    // ragged column of its own.
    head.innerHTML =
      `<label class="sp-label" style="opacity:${live ? '1' : '.45'}">text-to-speech</label>` +
      `<span class="sp-ctl">` +
      `<input type="checkbox" ${isTtsEnabled() ? 'checked' : ''} ` +
        // 🔴 NOT `disabled` WHEN THERE IS NO VOICE (R, 2026-08-09: "there's no
        // warning to load a model if you try to checkbox text-to-speech, it just
        // fails silently"). A disabled checkbox fires NO change event, so the
        // handler that explains why could never run — the control was mute about
        // its own precondition. It must be clickable precisely so the click can
        // be answered: the handler unticks it and names what is missing.
      `title="speak with the voice marked below">` +
      `<span class="sp-note">` +
      // THE NOTE SAYS ONE THING: what is loading, or what is loaded. Not what to
      // do next — the rows below ARE what to do next, and a note pointing at them
      // was the second "add a voice below" R found. Empty when there is nothing to
      // report: a row with nothing to say should be quiet.
      `${_busy || (_needVoice ? 'add a voice with one of the options below'
        : live ? ttsVoiceName() : ttsAvailable() ? 'ready' : '')}</span>` +
      `</span>`;
    head.querySelector('input').onchange = async (e) => {
      if (!e.target.checked) { _needVoice = false; setTtsEnabled(false); repaint(); return; }
      // TICKING THE BOX MEANS "SPEAK" — so make that true if it can be
      // (R, 2026-08-09). Three cases:
      //   no voices  → refuse, and SAY why (transient, clears when they add one)
      //   one voice  → use it; asking which of one is busywork
      //   several    → last used, else the first
      if (ttsAvailable()) { _needVoice = false; setTtsEnabled(true); repaint(); return; }
      const items = await collectVoices();
      if (!items.length) {
        e.target.checked = false;          // the tick did not take; do not lie about it
        _needVoice = true;
        // Clear itself after 5s (R, 2026-08-09). It answers ONE click; leaving it
        // up turns an answer into nagging, and it would still be there long after
        // the user moved on. clearTimeout first so repeated clicks restart the
        // window instead of stacking timers that fire mid-message.
        clearTimeout(_needVoiceTimer);
        _needVoiceTimer = setTimeout(() => { _needVoice = false; build(); }, 5000);
        // build() only — NOT repaint(). Showing "you need a voice" changes
        // nothing outside this row, and repaint() calls the panel's paint(),
        // which rebuilds every row (the jostle R caught on the mic toggle).
        build();
        return;
      }
      _needVoice = false;
      const last = (() => { try { return localStorage.getItem('eido.tts.lastVoice'); } catch { return null; } })();
      const pickId = (last && items.some((i) => i.id === last)) ? last : items[0].id;
        // If loading fails the box must not stay ticked over a voice that never
        // arrived — that is the same silent failure by a different route.
        try {
          await pick(pickId);                 // loads, sets the source, enables
        } catch (err) {
          e.target.checked = false;
          _needVoice = true;
        // Clear itself after 5s (R, 2026-08-09). It answers ONE click; leaving it
        // up turns an answer into nagging, and it would still be there long after
        // the user moved on. clearTimeout first so repeated clicks restart the
        // window instead of stacking timers that fire mid-message.
        clearTimeout(_needVoiceTimer);
        _needVoiceTimer = setTimeout(() => { _needVoice = false; build(); }, 5000);
          console.warn('[voice] could not load the saved voice:', err);
        }
        repaint();
    };
    host.appendChild(head);
    const listHost = document.createElement('div');
    // Indent to the CONTROL column (label 104px + 10px gap), so the voices hang
    // under the checkbox that switches them on rather than floating mid-panel.
    listHost.style.cssText = 'margin:2px 0 8px 142px';
    host.appendChild(listHost);
    collectVoices().then((items) => {
      renderVoiceList(listHost, {
        items, selected: _selected, busy: _busy,
        // The in-flight import, shown as a ghost row with a running clock.
        loading: _loadingId ? { id: _loadingId, name: _loadingName, since: _loadingSince, status: _busy } : null,
        on: { select: pick, remove, addFile, addEndpoint },
      });
    });
  }
  build();
  return host;
}