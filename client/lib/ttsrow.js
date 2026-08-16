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
    // Captured BEFORE anything below clears it: "was the user already asking to
    // speak, and only missing a voice?" TTS already being on counts too — then
    // this is a SWITCH between voices and must stay on, not silently mute.
    const wantedSpeech = _needVoice || isTtsEnabled();
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
      // 🔴 CHOOSING IS NOT ENABLING (R, 2026-08-16: "can you make it possible to
      // interact with the text-to-speech model radio buttons between 2+ models
      // even without the check box checked? That way if there's more than one,
      // you can select the one you want, getting around uploading one you don't
      // want first when you click the checkbox").
      //
      // Selecting used to force TTS on unconditionally, which made the two
      // controls one control: with several voices remembered you could not
      // switch to the one you wanted without also starting to speak in it, and
      // ticking the box grabbed whichever voice the rules landed on first.
      //
      // Now the tick decides WHETHER, the list decides WHICH. Enabling on
      // select happens only when the user was already asking to speak and the
      // one thing missing was a voice — the _needVoice prompt is exactly that
      // state, so it keeps its old behaviour and nothing else does.
      if (wantedSpeech) setTtsEnabled(true);
    } catch (e) {
      report('tts voice', e);
      _busy = String(e?.message || e).slice(0, 80);
      build();
      setTimeout(() => { _busy = null; repaint(); }, 2500);
      // FALSE, loudly (r5 self-review): this catch absorbs every load
      // failure, which made the checkbox handler's own catch DEAD CODE — a
      // failed load left the box ticked with no voice behind it, the exact
      // silent failure its comment claims to prevent. Failure is a return
      // value now; the callers that must untick can finally see it.
      return false;
    }
    _busy = null;
    repaint();
    return true;
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
        // #91 B5: identity is the BYTES. `file:${'{'}name{'}'}` let a same-named
        // different model silently become the same voice; the digest id makes
        // that impossible, and the identity travels with the memory.
        const onnxF = files.find((f) => /\.onnx$/i.test(f.name));
        const cfgF = files.find((f) => /\.onnx\.json$/i.test(f.name)) || files.find((f) => /\.json$/i.test(f.name));
        const identity = (onnxF && cfgF)
          ? await (await import('./voicestore.js')).voiceIdentity(onnxF, cfgF)
          : null;
        const id = identity?.id ?? `file:${name}`;   // digest when we have bytes; picker edge cases keep working
        try {
          const { rememberVoice, canRemember } = await import('./voicestore.js');
          if (canRemember()) await rememberVoice(id, name, handles, identity);
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
  /** Look for the other half of a piper pair in the folder the user points at.
   *
   *  Piper names them `X.onnx` and `X.onnx.json`, so the sibling of `a.onnx` is
   *  `a.onnx.json` and the sibling of `a.onnx.json` is `a.onnx` — NOT a naive
   *  "strip the extension", which would turn `a.onnx.json` into `a.onnx` only
   *  by luck and `a.json` into `a` wrongly.
   *
   *  Returns {handle, file} or null. Never throws at the caller: a declined
   *  directory prompt is an ordinary outcome, not an error.
   */
  async function pairFromDirectory(have, want) {
    if (!window.showDirectoryPicker) return null;
    const base = /\.onnx$/i.test(have) ? have : have.replace(/\.json$/i, '');
    const target = want === '.onnx.json' ? `${base}.json` : base;
    _busy = `looking for ${target} — pick the folder holding ${have}`;
    build();
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: 'read', id: 'piper-voices' });
    } catch { return null; }          // declined, or unsupported: fall back to asking
    // getFileHandle throws NotFoundError when the name is absent — which is the
    // ordinary "they picked the wrong folder" case, not a failure worth
    // reporting. Confirm the ORIGINAL is here too, so we cannot pair a model
    // with a config belonging to a different copy of the same filename.
    try {
      const mate = await dir.getFileHandle(target);
      await dir.getFileHandle(have);   // throws if this is not that folder
      return { handle: mate, file: await mate.getFile() };
    } catch { return null; }
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

        // 🔴 TRY THE SIBLING FIRST (R, 2026-08-16: "when the TTS model is trying
        // to bring in a piper model and the user selects an onnx or onnx.jsonl,
        // can it grab the other pair in that same directory if it has the same
        // file name?").
        //
        // The constraint that makes this awkward: showOpenFilePicker hands back
        // a FileSystemFileHandle, and a file handle gives NO access to its
        // siblings — by design, and there is no .getParent(). The only lawful
        // route to the folder is asking for the folder. So we ask ONCE, and if
        // the user grants it we never bother them again for this pair.
        //
        // A user who declines is not stuck: the explicit second pick below is
        // still there, unchanged. This is a shortcut, never the only path.
        const paired = await pairFromDirectory(have, want).catch(() => null);
        if (paired) {
          handles = [...handles, paired.handle];
          files = [...files, paired.file];
          _busy = `found ${paired.file.name} beside it`;
          build();
          await finishImport(handles, files);
          return;
        }

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

    /** 🔴 THE TICK CHANGES TWO THINGS, SO WRITE TWO THINGS (R, 2026-08-16:
     *  "looks like panel is tearing down when you click the text-to-speech
     *  model checkbox").
     *
     *  Same defect as the audio panel's, one file over: the checkbox handler
     *  called repaint() → build() → host.textContent = '', destroying and
     *  recreating the whole section for a state change that touches a label's
     *  opacity and a note's text. My teardown probe missed it because it
     *  clicked 'hear voices' — a probe proves the path it walks and nothing
     *  else, and I let a green light stand for the panel as a whole.
     *
     *  Returns false if the nodes are not there yet, so callers keep their
     *  build() fallback and a first paint still works. */
    function syncHead() {
      const label = host.querySelector('.sp-row .sp-label');
      const note = host.querySelector('.sp-row .sp-note');
      const box = host.querySelector('.sp-row input[type=checkbox]');
      if (!label || !note || !box) return false;
      const live = ttsAvailable() && isTtsEnabled();
      label.style.opacity = live ? '1' : '.45';
      box.checked = isTtsEnabled();
      note.textContent = _busy || (_needVoice ? 'add a voice with one of the options below'
        : live ? ttsVoiceName() : ttsAvailable() ? 'ready' : '');
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
      // "text-to-speech MODEL" (R, 2026-08-16): the audio panel already has a
      // "text-to-speech volume" slider, and two different controls carrying the
      // identical label "text-to-speech" is the ambiguity she hit. This one
      // selects WHICH VOICE; that one sets how loud it is.
      `<label class="sp-label" style="opacity:${live ? '1' : '.45'}">text-to-speech model</label>` +
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
      // 🔴 SAY IT IS IN FLIGHT, ON THIS LINE (R, 2026-08-16: "maybe put a
      // 'loading...' next to the checkbox line so people know it's in flight").
      // _busy carries the engine's own phase text once loading starts, but
      // there is a gap between the tick and the first phase report where the
      // line said "ready" — i.e. it claimed the voice was available while a
      // 63MB graph was still downloading. _loadingId is set for EVERY path into
      // a load, so it closes that gap; the engine's phase text still wins once
      // it arrives, because it says more.
      `${_busy || (_loadingId ? `loading ${_loadingName || 'voice'}…`
        : _needVoice ? 'add a voice with one of the options below'
        : live ? ttsVoiceName() : ttsAvailable() ? 'ready' : '')}</span>` +
      `</span>`;
    head.querySelector('input').onchange = async (e) => {
      // Untick: nothing structural changes — no row appears or vanishes — so
      // write the two affected nodes instead of rebuilding the section.
      if (!e.target.checked) {
        _needVoice = false; setTtsEnabled(false);
        if (!syncHead()) repaint(); else onPaint();
        return;
      }
      // TICKING THE BOX MEANS "SPEAK" — so make that true if it can be
      // (R, 2026-08-09). Three cases:
      //   no voices  → refuse, and SAY why (transient, clears when they add one)
      //   one voice  → use it; asking which of one is busywork
      //   several    → last used, else the first
      // Tick with a voice already loaded: same two nodes, same reasoning.
      if (ttsAvailable()) {
        _needVoice = false; setTtsEnabled(true);
        if (!syncHead()) repaint(); else onPaint();
        return;
      }
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
      // 🔴 THE VISIBLE SELECTION WINS (R, 2026-08-16). Now that choosing a voice
      // no longer enables TTS, a user can mark the one they want and THEN tick
      // the box — so the tick must honour what the radio shows. Reading only
      // localStorage here would load a different voice than the one marked on
      // screen, which is the display-vs-reality split in its purest form: the
      // dot says one thing, the speaker says another.
      //
      // Order: what is selected right now → last used → the first row. The
      // second and third are the pre-existing rule, unchanged.
      const last = (() => { try { return localStorage.getItem('eido.tts.lastVoice'); } catch { return null; } })();
      const marked = _selected && items.some((i) => i.id === _selected) ? _selected : null;
      const pickId = marked ?? ((last && items.some((i) => i.id === last)) ? last : items[0].id);
        // If loading fails the box must not stay ticked over a voice that never
        // arrived — that is the same silent failure by a different route.
        try {
          const ok = await pick(pickId);      // loads, sets the source, enables
          // pickInner reports failure as `false`, not a throw — its catch
          // owns the error UI. Only the tick needs undoing here.
          if (ok === false) { e.target.checked = false; return; }
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
    // Indent to the CONTROL column so the voices hang under the checkbox that
    // switches them on rather than floating mid-panel.
    //
    // 🔴 DERIVED, NOT HARDCODED. This was `margin-left: 142px` from "label
    // 104px + 10px gap" — a measurement of one particular layout, which silently
    // became wrong the moment the panel's label column changed width (it went
    // 5.5rem → 8.5rem on 2026-08-14 because the longest label did not fit).
    // The grid owns the gutter; read it from the grid.
    const col = getComputedStyle(host.closest('.sp-row')?.parentElement ?? host)
      .getPropertyValue('--sp-label-col') || '8.5rem';
    listHost.style.cssText = `margin:2px 0 8px calc(${col} + 10px)`;
    host.appendChild(listHost);
    collectVoices().then((items) => {
      // 🔴 SOMETHING IS ALWAYS MARKED (R, 2026-08-16: "maybe leave top radio'd
      // by default, or last if one exists, per existing rules"). _selected
      // starts null, so a fresh page with remembered voices showed a list with
      // NO dot — and "which one will the checkbox use?" had no visible answer.
      //
      // Same order the tick uses, so the dot is a PREDICTION of what ticking
      // will do rather than a separate opinion: last used, else the first row.
      // Marking is display only — no load, no permission prompt, nothing
      // enabled. The voice is not touched until the user asks for it.
      if (!_selected && items.length) {
        const last = (() => { try { return localStorage.getItem('eido.tts.lastVoice'); } catch { return null; } })();
        const real = items.filter((i) => i.id !== '__pending');
        if (real.length) _selected = (last && real.some((i) => i.id === last)) ? last : real[0].id;
      }
      renderVoiceList(listHost, {
        items, selected: _selected, busy: _busy,
        // The in-flight import, shown as a ghost row with a running clock.
        loading: _loadingId ? { id: _loadingId, name: _loadingName, since: _loadingSince, status: _busy } : null,
        // 🔴 MARKING IS NOT LOADING (R, 2026-08-16: "when someone selects a
        // model radio button and the checkbox isn't checked, can you *not*
        // load the model yet?"). The comment above claimed marking was display
        // only — it was not: `select` called pick(), which imports the engine
        // and pulls a ~63MB graph. So glancing at the list cost a download.
        //
        // Now the radio only MARKS while TTS is off; the load happens when the
        // checkbox is ticked, which already honours the visible selection. If
        // TTS is already ON this is a live switch between voices and must load
        // immediately — otherwise the dot would say one thing and the speaker
        // another, which is the display-vs-reality split this file keeps
        // fixing.
        on: {
          select: (id) => {
            if (id === '__pending') return pick(id);   // resuming IS the ask
            if (isTtsEnabled()) return pick(id);       // live switch: load now
            _selected = id;
            try { localStorage.setItem('eido.tts.lastVoice', id); } catch { /* private mode */ }
            build();
          },
          remove, addFile, addEndpoint,
        },
      });
    });
  }
  build();
  return host;
}