// audiopanel — the audio section: three category sliders, one consent row. Volume is taste you
// set once, so it lives on a findable settings row (which also works as a VR quad), not a gesture.
//
// Categories:
//   voices — other people's speech, and agent TTS. A resident is a resident.
//   world  — place sound. Not touched by the 🎧 toggle, on purpose.
//   TTS    — your own synthesized voice as you hear it (others' TTS rides voices: ROWS below).

import { makeSection } from '../ui/ui.js';
import { audioPrefs, setVolume, receivingVoice, setReceiveVoice,
  sttConsented, setSttConsent, isHushed, setHush,
  micFloor, setMicFloor, pttMode, setPttMode } from './voiceconsent.js';
import { gateUnavailable, ungatedConsent, allowUngated } from './micgate.js';
import { selfMonitor, selfMonitoring } from './micstate.js';
import { why } from '../debuglog.js';
/** Is a mic actually publishing, whichever transport is live? Guarded: window.relayDiag (voicesfubridge.js) can
 *  throw before its state exists. The one reader every row uses. */
const micLive = () => {
  try { return window.relayDiag?.().micPublished ?? micOn(); } catch { return micOn(); }
};
import { bus } from '../base.js';
import { ttsSection } from './ttsrow.js';
import { micOn, toggleMic, micGateInfo, micDeviceLevel, isMuted } from './micstate.js';
// CONFIG: the mic row passes CONFIG.name, which toggleMic (micstate.js) ignores: it takes no argument.
import { CONFIG } from '../base.js';

// The panel's rows use the house sheet's `.row.wide` (index.html): two columns on a shared centre
// line, labels in --fg, hints and units in --dim, controls in --accent. No private stylesheet.
function ensureCss() { /* house sheet — index.html owns .row and .row.wide */ }

// Labels say what they CONTROL ("voice volume"), not what they are about ("voices").
const ROWS = [
  ['voices', 'voice volume', 'other people speaking, and agent speech'],
  ['world', 'world volume', 'ambience and place-sound — the 🎧 toggle never touches this'],
  // synthesized speech rides the 'voices' lane for others (voicesource.js); this slider is only your own sidetone
  ['tts', 'self-TTS volume', 'how loud you hear your own synthesized voice'],
];

function slider(cat, label, hint, value) {
  const row = document.createElement('div');
  row.className = 'sp-row row wide'; // sp-row: the markup contract test/client/xr-quad-colour-probe.mjs selects by
  row.innerHTML =
    `<span class="nm" title="${hint}">${label}</span>` +
    `<span class="ctl">` +
      `<input type="range" min="0" max="1" step="0.05" value="${value}" data-cat="${cat}" style="flex:1">` +
      `<span class="v" data-out="${cat}" style="min-width:34px;text-align:right">${Math.round(value * 100)}%</span>` +
    `</span>`;
  const input = row.querySelector('input');
  const out = row.querySelector('[data-out]');
  input.oninput = () => {
    const v = setVolume(cat, input.value);
    out.textContent = `${Math.round(v * 100)}%`;
  };
  return row;
}

function checkRow(label, hint, checked, onChange) {
  const row = document.createElement('div');
  row.className = 'sp-row row wide';
  // label first: the grid assigns columns by source order
  row.innerHTML =
    `<span class="nm" title="${hint}">${label}</span>` +
    `<span class="ctl"><input type="checkbox" ${checked ? 'checked' : ''} title="${hint}"></span>`;
  row.querySelector('input').onchange = (e) => onChange(e.target.checked, e.target);
  return row;
}

// mic sensitivity: a slider over a LIVE level bar (animates only while its row is in the DOM). The meter wears the mic
// badge's palette (mictoggle.js INK.hot): gold = the room is getting your voice, warm = live but the room isn't
// getting it (under the floor, or push-to-talk with the key up), dark = muted (still moves) or not publishing.
const LVL_LIVE = '#ffd66b';
const LVL_WARM = '#9a8a5e';
const LVL_DARK = '#6b5f42';

function micFloorRow() {
  const row = document.createElement('div');
  row.className = 'sp-row row wide';
  const hint = 'mic level below the marker is treated as room noise, not speech, and isn\'t sent as voice ' +
    '(speech-to-text, when on, still hears it) — raise it if typing pings nearby agents; the bar shows your live mic level';
  const FS = 0.2;  // full-scale micFloor = right edge of the meter (0 dB)
  row.innerHTML =
    `<span class="nm" title="${hint}">mic sensitivity</span>` +
    `<span class="ctl">` +
    `<span data-meter title="${hint}" style="flex:1;min-width:60px;position:relative;height:14px;` +
    `background:var(--well);border-radius:2px;overflow:hidden;cursor:ew-resize">` +
    `<span data-lvl style="position:absolute;left:0;top:0;height:100%;width:0;background:${LVL_DARK}"></span>` +
    // the marker is a ruler, not a signal: white, so it never competes with the bar's colour
    `<span data-thr style="position:absolute;top:0;height:100%;width:2px;background:rgba(255,255,255,.85);opacity:1"></span>` +
    `</span>` +
    `<span data-out style="min-width:34px;text-align:right">${Math.round(micFloor() * 500)}%</span>` +
    `</span>`;
  const meter = row.querySelector('[data-meter]');
  const out = row.querySelector('[data-out]');
  const lvl = row.querySelector('[data-lvl]');
  const thr = row.querySelector('[data-thr]');
  // gold is micstate.js micGateInfo().speaking, the HUD glyph's own answer, so the two agree with what the room gets
  let hot = false;
  const micIsLive = micLive;
  const paintLive = () => {
    if (!micIsLive() || isMuted()) { hot = false; lvl.style.background = LVL_DARK; return; }
    lvl.style.background = hot ? LVL_LIVE : LVL_WARM;
  };
  paintLive();
  bus.on('audio:mic', paintLive);
  bus.on('audio:mute', paintLive);
  // dragging the threshold repaints at once, not on the next level sample
  bus.on('audio:micfloor', () => paintLive());
  const paintThr = () => {
    thr.style.left = `calc(${Math.min(100, (micFloor() / FS) * 100)}% - 1px)`;
    out.textContent = `${Math.round(micFloor() * 500)}%`;
  };
  paintThr();
  const setFromX = (ev) => {
    const r = meter.getBoundingClientRect();
    setMicFloor(((ev.clientX - r.left) / r.width) * FS);
    paintThr();
  };
  meter.onpointerdown = (ev) => { meter.setPointerCapture(ev.pointerId); setFromX(ev); };
  meter.onpointermove = (ev) => { if (meter.hasPointerCapture?.(ev.pointerId)) setFromX(ev); };
  const beat = () => {
    if (!row.isConnected) return;
    // the bar rides the marker's dB track (-60..0 dB, voiceconsent.js gateThresholdDb) at the RMS the gate reads (the
    // transport's peak crossed the marker with the gate shut), muted or not
    const level = micDeviceLevel();
    lvl.style.width = `${Math.min(100, Math.max(0, (20 * Math.log10(Math.max(level, 1e-6)) + 60) / 60 * 100))}%`;
    // repaint only on a state change (this runs at frame rate)
    const next = !!micGateInfo().speaking;
    if (next !== hot) { hot = next; paintLive(); }
    requestAnimationFrame(beat);
  };
  requestAnimationFrame(beat);
  return row;
}

let _body = null;
// The rows are built once and updated in place: a rebuild would make the panel jump, end the meter's rAF chain and
// drop a threshold drag mid-gesture. The three synced checkboxes keep a reference here; a bus event writes `.checked`.
const _sync = { mic: null, hear: null, connect: null };

/** Reflect state onto the existing controls (what the bus handlers call instead of paint()). */
function syncRows() {
  if (!_body) return;
  const p = audioPrefs();   // unused today; kept so slider sync has an obvious home
  void p;
  if (_sync.mic) _sync.mic.checked = micLive();
  if (_sync.hear) _sync.hear.checked = receivingVoice() && !isHushed();
  if (_sync.connect) _sync.connect.checked = receivingVoice();
}

function paint(body) {
  // makeSection calls onOpen(body) on every open: already built and attached → just re-sync
  if (body && _body === body && _body.firstChild) { syncRows(); return; }
  _body = body ?? _body;
  if (!_body) return;
  const body_ = _body;
  body_.innerHTML = '';
  const p = audioPrefs();
  // mic first: the control people reach for, and the one that transmits. The HUD badge (mictoggle.js) reads the same
  // state and calls the same toggleMic.
  const micRow = checkRow('microphone',
    'transmit your voice — the mic glyph beside the HUD is this same switch',
    micLive(), async () => {
      // use toggleMic's resolved state: reading micOn() after the await races the async publish
      const on = await toggleMic(CONFIG.name);
      bus.emit('audio:mic', on);
    });
  _sync.mic = micRow.querySelector('input');
  body_.append(micRow);
  // PTT sits between the mic switch and the sensitivity floor because it decides whether the floor is in use
  body_.append(checkRow('push-to-talk',
    'transmit only while V is held down — replaces voice activation, so the ' +
    'sensitivity floor below is not used while this is on. Release V and the ' +
    'room stops hearing you after a short fade.',
    pttMode(), (on) => setPttMode(on)));
  const floorRow = micFloorRow();
  body_.append(floorRow);
  // under PTT the floor drives nothing: dimmed and inert, not hidden, so the row stays findable
  const dimFloor = () => {
    const off = pttMode();
    floorRow.style.opacity = off ? '0.45' : '';
    floorRow.style.pointerEvents = off ? 'none' : '';
  };
  dimFloor();
  bus.on('audio:ptt', dimFloor);

  // 'hear voices' is the same bit the 🎧 glyph toggles; ticking it from a fully-revoked state grants consent too
  const hearRow = checkRow('hear voices',
    'peers and agent speech — the 🎧 glyph is this same switch',
    receivingVoice() && !isHushed(), (on) => {
      if (on) { if (!receivingVoice()) setReceiveVoice(true); setHush(false); }
      else setHush(true);
    });
  _sync.hear = hearRow.querySelector('input');
  body_.append(hearRow);
  // the slider that belongs to a switch sits under it: voice · world · [tts toggle + model list] · self-TTS
  const ttsHost = document.createElement('div');
  for (const [cat, label, hint] of ROWS) {
    if (cat === 'tts') body_.append(ttsHost);   // the switch, immediately above its slider
    body_.append(slider(cat, label, hint,
      cat === 'world' ? p.volWorld : cat === 'tts' ? p.volTts : p.volVoices));
  }
  // hear your own gated lane (micgate.js setMonitor): tapped after the gain node, so a closed gate is silent here too
  {
    const row = checkRow('hear my own mic (monitor)',
      'plays your gated mic back to you — what the room hears of your mic, so silence here means your mic sends silence (a synthetic voice, sent with the mic off, bypasses this). USE HEADPHONES: on speakers this feeds back.',
      selfMonitoring(), (on, input) => {
        // setMonitor() returns false before the gate graph exists: untick and say why
        const took = selfMonitor(on);
        if (on && took === false && input) {
          input.checked = false;
          why('panel', 'monitor refused: no gate graph yet — turn the mic on first');
        }
      });
    body_.append(row);
  }

  // the gate-unavailable escape hatch: hidden while the gate works; when the graph cannot be built the mic refuses to
  // transmit and this row appears
  {
    const row = checkRow('transmit UNGATED (voice gate unavailable)',
      'the noise gate could not be built on this device — checking this transmits your raw microphone, room noise and all',
      ungatedConsent(), (on) => allowUngated(on));
    row.style.display = gateUnavailable() ? '' : 'none';
    row.style.color = '#fa5';
    bus.on('voice-gate-unavailable', () => { row.style.display = ''; });
    body_.append(row);
  }
  body_.append(checkRow('speech-to-text',
    'sends your mic audio to your browser vendor’s cloud to transcribe',
    sttConsented(), (on) => setSttConsent(on)));
  // last: hush is a gain, this is consent. Unticked, the server forwards you no voice (voiceconsent.js).
  const connectRow = checkRow('connect to other people’s audio',
    'on: your machine holds one live connection to the server, which forwards each speaker nearby. ' +
    'Off: nothing is sent to you at all — saves bandwidth and CPU in busy ' +
    'rooms. Muting only turns the ' +
    'volume down; this unplugs the wire.',
    receivingVoice(), (on) => { setReceiveVoice(on); if (on) setHush(false); });
  _sync.connect = connectRow.querySelector('input');
  body_.append(connectRow);

  // the TTS voice section (ttsrow.js) owns its host (build() clears it), so it gets its own div; wired after every row
  // exists so it can measure the grid gutter
  ttsSection(ttsHost, () => {});
}

export function initAudioPanel() {
  ensureCss();
  makeSection('🔊 audio', (body) => paint(body), { id: 'audio', host: 'settings' });
  // syncRows(), not paint(): these fire on every toggle and only three booleans need mirroring
  bus.on('audio:hush', syncRows);
  bus.on('audio:receive', syncRows);
  bus.on('audio:mic', syncRows);
}
