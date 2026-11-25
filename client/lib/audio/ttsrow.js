// ttsrow — the audio panel's text-to-speech section: a tick ("speak?") and the list of voices you
// have (ttslist.js renders it). Bring your own voice: a Piper model from disk, or a speech server
// you run. Both are made to transmit; where the browser has no track generator (canSynthesize, tts.js), nothing
// is sent (sidetone, if on, still plays it to you).
import { renderVoiceList } from './ttslist.js';
import { why } from '../debuglog.js';
import { ttsAvailable, ttsVoiceName, isTtsEnabled, setTtsEnabled, setTtsSource } from './tts.js';
import { setEndpointVoice } from './browservoice.js';
import { report, bus } from '../base.js';
import { micOn } from './micstate.js';
let _selected = null;      // the marked voice's id; null when nothing is loaded (a real state)
let _needVoice = false, _needVoiceTimer = 0;   // transient "add a voice first" note after a tick with nothing loaded
let _busy = null;          // a phase string while loading, else null
let _loadingId = null, _loadingName = null, _loadingSince = 0;   // the import in flight, shown as a loading row with a clock
// the tick's own await window (collectVoices before pick sets _loadingId), so a repaint in the gap keeps the box ticked
let _tickPending = false;
// the user's last word on "speak?", written only by the checkbox handler: the box itself is re-derived
// by every sync, so it cannot carry an untick made mid-load
let _wantSpeech = false;
let _inFlight = null;      // one load at a time: a click during a load is a no-op
let _pending = null;       // a pick missing its other half, kept as a row so it can be resumed (addFile)
/** Everything we can speak with: remembered files + this session's endpoints. */
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
  // the half-finished pick first: it is the thing asking for attention
  if (_pending) {
    out.unshift({
      id: '__pending',
      name: `select the ${_pending.want} for ${_pending.have}`,
      dim: true,
      note: `you picked ${_pending.have}; a Piper voice also needs its ${_pending.want}. Click to choose it.`,
    });
  }
  return out;
}
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
    /** Every pick of a listed voice goes through here (the checkbox path too): one busy guard, one loading row. An import
     *  (addFile, resumePending → finishImport) loads on its own path.
     *  Returns false on refusal or failure, so the tick handler can undo itself. */
    async function pick(id) {
      if (id === '__pending') return resumePending();
      if (id === _selected && ttsAvailable()) return true;   // already live
      if (_inFlight) {
        console.log(`[voice] already loading ${_inFlight}; ignoring ${id}`);
        return false;
      }
      _inFlight = id;
      _loadingId = id;
      // stored voices are keyed by content digest (voicestore.js), so ask the list for the human name
      _loadingName = id.replace(/^file:/, '').replace(/^ep:/, '');
      void collectVoices().then((vs) => {
        const hit = vs.find((v) => v.id === id);
        if (hit?.name && _loadingId === id) { _loadingName = hit.name; build(); }
      }).catch(() => { /* keep the fallback */ });
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
    // captured before anything below clears it: was the user already asking to speak (or switching voices)?
    const wantedSpeech = _needVoice || isTtsEnabled();
    try {
      if (id.startsWith('ep:')) {
        await setEndpointVoice(id.slice(3));
      } else {
        const { listVoices, openVoice } = await import('./voicestore.js');
        const entry = (await listVoices()).find((v) => v.id === id);
        if (!entry) throw new Error('that voice is no longer remembered');
        const files = await openVoice(entry, { allowPrompt: true });
        const { loadFromFiles } = await import('./voiceengines.js');
        await import('./engines.js');
        await loadFromFiles(files, (p) => {
        _busy = p.text || p.phase || 'loading…';
        if (!liveStatus(_busy)) build();
      });
      }
      _selected = id;
    try { localStorage.setItem('eido.tts.lastVoice', id); } catch { /* private mode */ }
    _needVoice = false;
      // choosing is not enabling: the tick decides whether, the list decides which
      if (wantedSpeech) setTtsEnabled(true);
    } catch (e) {
      report('tts voice', e);
      _busy = String(e?.message || e).slice(0, 80);
      build();
      setTimeout(() => { _busy = null; repaint(); }, 2500);
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
    // removing the voice that is speaking also stops it
    if (id === _selected) { setTtsSource(null); setTtsEnabled(false); _selected = null; }
    repaint();
  }
  /** Finish an import once both halves are in hand (addFile and resumePending). */
  async function finishImport(handles, files) {
    const { loadFromFiles } = await import('./voiceengines.js');
    await import('./engines.js');
    const shown = (files.find((f) => /\.onnx$/i.test(f.name)) || files[0])?.name || 'voice';
    const name = shown.replace(/\.onnx$/i, '');
      _busy = `loading ${name}…`;   // cleared on every exit, or the add button stays grey (ttslist.js)
      _loadingId = `file:${name}`; _loadingName = name; _loadingSince = Date.now();
      build();
      try {
        await loadFromFiles(files, (p) => {
        _busy = p.text || p.phase || `loading ${name}…`;
        if (!liveStatus(_busy)) build();
      });
        // identity is the bytes: a same-named different model is a different voice
        const onnxF = files.find((f) => /\.onnx$/i.test(f.name));
        const cfgF = files.find((f) => /\.onnx\.json$/i.test(f.name)) || files.find((f) => /\.json$/i.test(f.name));
        const identity = (onnxF && cfgF)
          ? await (await import('./voicestore.js')).voiceIdentity(onnxF, cfgF)
          : null;
        const id = identity?.id ?? `file:${name}`;
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
      if (!more?.length) return;                       // dismissed: row stays
      const handles = [..._pending.handles, ...more];
      const files = [..._pending.files, ...await Promise.all(more.map((h) => h.getFile()))];
      const { matchEngine } = await import('./voiceengines.js');
      await import('./engines.js');
      if (!matchEngine(files)) {
        _pending = { ..._pending, handles, files };
        _busy = `that was not a ${want} — try again`;
        build();
        return;
      }
      await finishImport(handles, files);
    } catch (e) {
      if (e?.name === 'AbortError') return;
      report('resume voice import', e);
    }
  }
  /** Find the other half of a Piper pair (`X.onnx` / `X.onnx.json`) in a folder the user points at.
   *  Returns {handle, file} or null; a declined prompt is an ordinary outcome. */
  async function pairFromDirectory(have, want) {
    if (!window.showDirectoryPicker) return null;
    const base = /\.onnx$/i.test(have) ? have : have.replace(/\.json$/i, '');
    const target = want === '.onnx.json' ? `${base}.json` : base;
    _busy = `optional: pick the folder holding ${have} and I'll find ${target} myself`;
    build();
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: 'read', id: 'piper-voices' });
    } catch { return null; }
    // NotFoundError is the ordinary wrong-folder case; the original's NAME must be here too (a same-named file in
    // another folder still passes: a name check, not identity)
    try {
      const mate = await dir.getFileHandle(target);
      await dir.getFileHandle(have);
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
      // a lone .onnx is the common near-miss: ask for the other half by name
      if (!matchEngine(files) || files.length === 1) {
        const have = files[0]?.name || 'a file';
        const want = /\.onnx$/i.test(have) ? '.onnx.json' : '.onnx';

        // a file handle has no .getParent(), so the folder is the only route to the file next door
        _busy = `${have} selected — now pick the matching ${want}`;
        build();
        let more = await window.showOpenFilePicker({
          multiple: true,
          types: [{ description: `Matching ${want} for ${have}`,
                    accept: want === '.onnx' ? { 'application/octet-stream': ['.onnx'] }
                                             : { 'application/json': ['.json'] } }],
        }).catch(() => null);

        // declined the file pick: offer the folder; declining both lands on the half-finished row
        if (!more?.length) {
          const paired = await pairFromDirectory(have, want).catch(() => null);
          if (paired) {
            handles = [...handles, paired.handle];
            files = [...files, paired.file];
            _busy = `found ${paired.file.name} beside it`;
            build();
            await finishImport(handles, files);
            return;
          }
        }
        if (more?.length) {
          handles = [...handles, ...more];
          files = [...files, ...await Promise.all(more.map((h) => h.getFile()))];
        } else {
          // a half-finished import becomes a row; click it to be asked for the rest
          _pending = { handles, files, have, want };
          _busy = null;
          repaint();
          return;
        }
      }
      await finishImport(handles, files);
    } catch (e) {
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
    /** Write progress into the loading row's note; false if it is not built yet. */
    function liveStatus(text) {
      const row = host.querySelector('.vl-loading .vl-note');
      if (!row) return false;
      row.textContent = text || '';
      return true;
    }

    /** Write the head row (label, box, note) in place; false if the nodes are not there yet. */
    function syncHead() {
      const label = host.querySelector('.row.wide .nm');
      const note = host.querySelector('.row.wide .note');
      const box = host.querySelector('.row.wide input[type=checkbox]');
      if (!label || !note || !box) return false;
      const live = ttsAvailable() && isTtsEnabled();
      label.style.opacity = headDimmed() ? '.45' : '1';
      // a loading voice is a ticked box, faded
      const loadingNow = (!!_loadingId || _tickPending) && (_wantSpeech || !_tickPending);
      box.checked = isTtsEnabled() || loadingNow;
      box.style.opacity = loadingNow && !isTtsEnabled() ? '.45' : '';
      note.textContent = headNote();
      return true;
    }
/** A live mic wins outright, and the panel says so; isTtsEnabled() stays true, only the display yields. */
function micIsPublishing() {
  // the SFU's own read (window.__sfuMicOn, voicesfubridge.js), else micstate's
  try {
    if (typeof window.__sfuMicOn === 'function') return !!window.__sfuMicOn();
  } catch { /* no window */ }
  return micOn();
}

function headNote() {
  if (_busy) return _busy;
  if (_loadingId) return `loading ${_loadingName || 'voice'}…`;
  if (micIsPublishing()) return 'not available while your mic is on';
  if (_needVoice) return 'add a voice with one of the options below';
  const live = ttsAvailable() && isTtsEnabled();
  return live ? ttsVoiceName() : ttsAvailable() ? 'ready' : '';
}

/** Dimmed when TTS cannot actually speak: off, or outranked by a live mic. */
function headDimmed() {
  return !(ttsAvailable() && isTtsEnabled()) || micIsPublishing();
}

  /** Update every node build() paints (label, box, note, list) without destroying any; false when they are missing. */
  function syncInPlace() {
    const label = host.querySelector('.nm');
    const box = host.querySelector('input[type=checkbox]');
    const note = host.querySelector('.note');
    const listHost = host.querySelector('.tts-list');
    if (!label || !box || !note || !listHost) {
      const missing = [!label && '.nm', !box && 'checkbox', !note && '.note',
                       !listHost && '.tts-list'].filter(Boolean).join(', ');
      why('tts-section', `sync refused: missing ${missing}`);
      return false;
    }

    const live = ttsAvailable() && isTtsEnabled();
    label.style.opacity = headDimmed() ? '.45' : '1';
    // must match syncHead()'s rule, or the two writers disagree mid-load
    const wantChecked = isTtsEnabled() || ((!!_loadingId || _tickPending) && (_wantSpeech || !_tickPending));
    if (box.checked !== wantChecked) box.checked = wantChecked;
    box.style.opacity = wantChecked && !isTtsEnabled() ? '.45' : '';
    note.textContent = headNote();

    // the list updates in place on a selection change; a voice added or removed rebuilds it (ttslist.js renderVoiceList)
    collectVoices().then((items) => {
      if (!_selected && items.length) {
        const last = (() => { try { return localStorage.getItem('eido.tts.lastVoice'); } catch { return null; } })();
        const real = items.filter((i) => i.id !== '__pending');
        if (real.length) _selected = (last && real.some((i) => i.id === last)) ? last : real[0].id;
      }
      renderVoiceList(listHost, {
        items, selected: _selected, busy: _busy,
        loading: _loadingId ? { id: _loadingId, name: _loadingName, since: _loadingSince, get status() { return _busy; } } : null,   // live: liveStatus updates _busy between builds
        on: {
          select: (id) => {
            if (id === '__pending') return pick(id);
            if (isTtsEnabled()) return pick(id);
            _selected = id;
            try { localStorage.setItem('eido.tts.lastVoice', id); } catch { /* private mode */ }
            build();
          },
          remove, addFile, addEndpoint,
        },
      });
    });
    return true;
  }

  /** Build the section, or update it in place when it is already built (the voice list rebuilds when its voices change). */
  function build() {
    if (host.firstChild) {
      if (syncInPlace()) { why('tts-section', 'in place'); return; }
      why('tts-section', 'REBUILT (syncInPlace refused)');
    } else {
      why('tts-section', 'first paint');
    }
    host.textContent = '';
    const head = document.createElement('div');
    head.className = 'row wide';
    const live = ttsAvailable() && isTtsEnabled();
    // label, then control, as every other row; the status note rides in the control column
    head.innerHTML =
      `<label class="nm" style="opacity:${headDimmed() ? '.45' : '1'}">text-to-speech model</label>` +
      `<span class="ctl">` +
      `<input type="checkbox" ${isTtsEnabled() || ((_loadingId || _tickPending) && (_wantSpeech || !_tickPending)) ? 'checked' : ''} `
        + `${(_loadingId || _tickPending) && (_wantSpeech || !_tickPending) && !isTtsEnabled() ? 'style="opacity:.45" ' : ''}` +
        // never `disabled`: a disabled checkbox fires no change event, and the handler must run to say what is missing
      `title="speak with the voice marked below">` +
      `<span class="note">` +
      `${headNote()}</span>` +
      `</span>`;
    head.querySelector('input').onchange = async (e) => {
      _wantSpeech = e.target.checked;   // the last click wins for this tick's own load (below); finishImport enables regardless
      if (!e.target.checked) {
        _needVoice = false; setTtsEnabled(false);
        if (!syncHead()) repaint(); else onPaint();
        return;
      }
      if (_tickPending) return;   // a load this tick started is running; its completion honours the box
      // ticking means "speak": no voices → refuse and say why; else load the marked voice (last used, else first)
      if (ttsAvailable()) {
        _needVoice = false; setTtsEnabled(true);
        if (!syncHead()) repaint(); else onPaint();
        return;
      }
      _tickPending = true;
      const items = await collectVoices();
      if (!_wantSpeech) { _tickPending = false; return; }      // unticked while listing
      if (!items.length) {
        _tickPending = false;
        e.target.checked = false;          // the tick did not take
        _needVoice = true;
        clearTimeout(_needVoiceTimer);     // answers one click; repeated clicks restart the window
        _needVoiceTimer = setTimeout(() => { _needVoice = false; build(); }, 5000);
        build();   // not repaint(): nothing outside this row changed
        return;
      }
      _needVoice = false;
      // the tick loads the voice the radio shows: selected → last used → first
      const last = (() => { try { return localStorage.getItem('eido.tts.lastVoice'); } catch { return null; } })();
      const marked = _selected && items.some((i) => i.id === _selected) ? _selected : null;
      const pickId = marked ?? ((last && items.some((i) => i.id === last)) ? last : items[0].id);
        try {
          const ok = await pick(pickId);
          if (ok === false) { e.target.checked = false; return; }   // pick's catch owns the error UI
          if (!_wantSpeech) return;   // unticked mid-load
          setTtsEnabled(true);        // the tick owns the enable (pickInner saw _needVoice already cleared)
        } catch (err) {
          e.target.checked = false;
          _needVoice = true;
        clearTimeout(_needVoiceTimer);
        _needVoiceTimer = setTimeout(() => { _needVoice = false; build(); }, 5000);
          console.warn('[voice] could not load the saved voice:', err);
        } finally {
          _tickPending = false;   // every exit, or the box stays faded forever
        }
        repaint();
    };
    host.appendChild(head);
    const listHost = document.createElement('div');
    listHost.className = 'tts-list';   // findable by syncInPlace
    // indent to the control column (read from the grid) so the voices hang under their checkbox
    const col = getComputedStyle(host.closest('.row.wide')?.parentElement ?? host)
      .getPropertyValue('--row-label-col') || '8.5rem';
    listHost.style.cssText = `margin:2px 0 8px calc(${col} + 10px)`;
    host.appendChild(listHost);
    collectVoices().then((items) => {
      // something is always marked, in the order the tick uses, so the dot predicts what ticking does
      if (!_selected && items.length) {
        const last = (() => { try { return localStorage.getItem('eido.tts.lastVoice'); } catch { return null; } })();
        const real = items.filter((i) => i.id !== '__pending');
        if (real.length) _selected = (last && real.some((i) => i.id === last)) ? last : real[0].id;
      }
      renderVoiceList(listHost, {
        items, selected: _selected, busy: _busy,
        loading: _loadingId ? { id: _loadingId, name: _loadingName, since: _loadingSince, get status() { return _busy; } } : null,   // live: liveStatus updates _busy between builds
        // while TTS is off the radio only marks (a load pulls a ~63MB graph); with TTS on it is a live switch
        on: {
          select: (id) => {
            if (id === '__pending') return pick(id);
            if (isTtsEnabled()) return pick(id);
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
  // repaint when the mic changes, or the greying is one toggle stale (build() updates in place)
  bus.on('audio:mic', () => build());
  return host;
}