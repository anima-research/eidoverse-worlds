// audiopanel — the audio section: three category sliders, one consent row.
//
// This is where the categories live, and why they are HERE rather than behind
// a press-and-hold on the HUD toggle: volume is taste you set once, so it
// belongs on a settings row you can find, not a hidden gesture you cannot.
// (A hold-menu also does not survive VR, where the panel is a quad you point
// a laser at — a list of rows works there, a long-press does not.)
//
// Categories:
//   voices — other people's speech, and agent TTS. A resident is a resident.
//   world  — place sound. Not touched by the 🎧 toggle, on purpose.
//   TTS    — synthetic speech specifically, for anyone who wants people but
//            not narration (or the reverse).

import { makeSection } from './ui.js';
import { audioPrefs, setVolume, receivingVoice, setReceiveVoice,
  sttConsented, setSttConsent, isHushed, setHush,
  micFloor, setMicFloor } from './voiceconsent.js';
import { micAnalyserLevel } from './voice.js';
import { gateUnavailable, ungatedConsent, allowUngated } from './micgate.js';
import { bus } from './core.js';
import { ttsSection } from './ttsrow.js';
import { micOn, toggleMic } from './voice.js';
// 🔴 CONFIG is needed by the mic row (toggleMic wants the actor NAME) and was
// NOT imported — `CONFIG is not defined` threw inside the checkbox handler, so
// the box flipped and nothing published. Third instance tonight of the same
// bug: main.js:522 passed an undefined `me`, and this passed an undefined
// CONFIG. A handler that throws leaves the CHECKBOX checked, because the DOM
// already applied the click — display and reality separating one last time.
import { CONFIG } from './core.js';

// The panel's row layout, carried BY THE MODULE. Found live 2026-08-06 (R,
// in-headset): the sp-row/sp-label classes came from the lab's panel
// framework and were never extracted with this file, so nothing upstream
// defined them — the mic meter (an inline span with flex:1) collapsed to a
// 2px vertical line, which is just its threshold marker with zero meter
// behind it. A module's markup and its layout must travel together.
// 🔴 TWO COLUMNS ON A SHARED CENTRE LINE (R's spec, restored 2026-08-14).
// A flex row with a min-width label puts every control at a DIFFERENT x — the
// eye has to re-find the column on each row. A grid gives one gutter: labels
// end at the line, controls begin at it, and the panel reads as a table
// instead of a ragged list. ttsrow.js already emits `.sp-ctl` expecting exactly
// this ("same two columns as every other row") — it was written against a
// layout the panel never had, which is why its rows looked unlike the others.
//
// minmax(0,1fr) on the control column, not 1fr: the mic meter is flex:1 inside
// it and a bare 1fr lets it push the grid wider than the panel.
const SP_CSS = `
:root { --sp-label-col: 8.5rem; }
.sp-row { display: grid; grid-template-columns: var(--sp-label-col) minmax(0, 1fr);
          align-items: center; gap: 10px; margin: 5px 0; }
/* 8.5rem, not the 5.5 I guessed: the longest label here is "connect to other
   people's audio" and a column narrower than its longest member does not make
   a centre line, it makes a ragged wrap. Labels wrap to two lines rather than
   overflowing, and the line still holds. */
.sp-label { opacity: 0.75; text-align: right; line-height: 1.25; }
.sp-ctl { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sp-note { opacity: .6; font-size: .9em; }
/* rows that are a label + a bare control (checkbox first in markup) still line
   up: the checkbox is the whole second column, left-justified against the line */
.sp-row > input[type=checkbox] { justify-self: start; }
`;
function ensureCss() {
  if (document.getElementById('sp-audio-css')) return;
  const st = document.createElement('style');
  st.id = 'sp-audio-css';
  st.textContent = SP_CSS;
  document.head.appendChild(st);
}

const ROWS = [
  ['voices', 'voices', 'other people speaking, and agent speech'],
  ['world', 'world', 'ambience and place-sound — the 🎧 toggle never touches this'],
  ['tts', 'text-to-speech', 'synthetic narration only'],
];

function slider(cat, label, hint, value) {
  const row = document.createElement('div');
  row.className = 'sp-row';
  row.innerHTML =
    `<span class="sp-label" title="${hint}">${label}</span>` +
    `<span class="sp-ctl">` +
      `<input type="range" min="0" max="1" step="0.05" value="${value}" data-cat="${cat}" style="flex:1">` +
      `<span class="sp-info" data-out="${cat}" style="min-width:34px;text-align:right">${Math.round(value * 100)}%</span>` +
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
  row.className = 'sp-row';
  // LABEL FIRST in the markup, because the grid assigns columns by source
  // order: label right-justified against the centre line, control left-
  // justified after it. The old order put the checkbox in the LABEL column and
  // the text in the control column — the exact inversion of R's spec.
  row.innerHTML =
    `<span class="sp-label" title="${hint}">${label}</span>` +
    `<span class="sp-ctl"><input type="checkbox" ${checked ? 'checked' : ''} title="${hint}"></span>`;
  row.querySelector('input').onchange = (e) => onChange(e.target.checked);
  return row;
}

// mic sensitivity: a slider over a LIVE level bar, so you can see where your
// voice lands versus your keyboard before choosing the floor (R, 17:19 —
// typing sounds were pinging agents' ears). The bar animates only while the
// section is open and stops the moment its row leaves the DOM.
// The meter tracks the mic BADGE's palette (client/lib/mictoggle.js), because
// they are read as one control: a bar lit while the badge is off says the mic
// is hearing you when it is not. LIVE is the badge's live white-gold; DARK is
// the same hue at a quarter value, so the bar still MOVES when muted (you can
// set your threshold before unmuting) without claiming to transmit.
const LVL_LIVE = '#ffd66b';
const LVL_DARK = '#6b5f42';   // was #4a4230 — INVISIBLE against the black track
// (seen in the 08-15 screenshot: only the threshold marker showed). A muted
// meter must still be READABLE; "not transmitting" is said by being dimmer than
// live, not by vanishing. Verified visually, which is the only way this class
// of bug gets caught.

function micFloorRow() {
  const row = document.createElement('div');
  row.className = 'sp-row';
  const hint = 'mic level below the marker is treated as room noise, not speech — ' +
    'raise it if typing pings nearby agents; the bar shows your live mic level';
  const FS = 0.2;  // full-scale mic level = right edge of the meter
  row.innerHTML =
    `<span class="sp-label" title="${hint}">mic sensitivity</span>` +
    `<span class="sp-ctl">` +
    `<span data-meter title="${hint}" style="flex:1;min-width:60px;position:relative;height:14px;` +
    `background:#000;border-radius:2px;overflow:hidden;cursor:ew-resize">` +
    `<span data-lvl style="position:absolute;left:0;top:0;height:100%;width:0;background:${LVL_DARK}"></span>` +
    `<span data-thr style="position:absolute;top:0;height:100%;width:2px;background:#9f9;opacity:.9"></span>` +
    `</span>` +
    `<span data-out style="min-width:34px;text-align:right">${Math.round(micFloor() * 500)}%</span>` +
    `</span>`;
  const meter = row.querySelector('[data-meter]');
  const out = row.querySelector('[data-out]');
  const lvl = row.querySelector('[data-lvl]');
  const thr = row.querySelector('[data-thr]');
  const paintLive = () => { lvl.style.background = micOn() ? LVL_LIVE : LVL_DARK; };
  paintLive();
  bus.on('audio:mic', paintLive);
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
    const level = micAnalyserLevel();
    lvl.style.width = `${Math.min(100, (level / FS) * 100)}%`;
    requestAnimationFrame(beat);
  };
  requestAnimationFrame(beat);
  return row;
}

let _body = null;
function paint(body) {
  _body = body ?? _body;
  if (!_body) return;
  const body_ = _body;
  body_.innerHTML = '';
  const p = audioPrefs();
  // 'hear voices' is what you HEAR — the same bit the 🎧 glyph toggles, so
  // the two controls can never disagree about the world you are in. (Field
  // report 12:43: toggling the headphone left this row stale, which is two
  // controls showing two different states while looking like one.) Ticking
  // it from a fully-revoked state grants consent as well, exactly like the
  // glyph, so the box is never a dead end.
  // MIC FIRST — it is the control people reach for, and it is the one that
  // transmits. Synced to the HUD badge exactly the way 'hear voices' is synced
  // to the 🎧 glyph: one state, two surfaces, never disagreeing. (mictoggle.js
  // exports nothing and self-injects, so both read micOn() and call the same
  // toggleMic — the sync is the shared state, not a message between them.)
  body_.append(checkRow('microphone',
    'transmit your voice — the mic glyph beside the HUD is this same switch',
    // 🔴 micOn() reads the MESH's state — on the SFU path it is always false,
    // so the box would render unticked no matter what. Ask whichever transport
    // is live. (window.relayDiag is installed by the SFU bridge.)
    (window.relayDiag?.().micPublished ?? micOn()), async () => {
      // 🔴 COPY THE BADGE EXACTLY (R, 00:05: "make sure you copy how 'hear
      // voice' is doing its thing" — the toggle would not turn on). Two bugs
      // in my first version, both the same shape as the `me is not defined`
      // one I fixed in main.js an hour earlier:
      //   1. `toggleMic()` with NO ARGUMENT. mictoggle.js:104 passes
      //      CONFIG.name; without it the mesh path has no actor name and the
      //      toggle silently does not take.
      //   2. I threw away the RETURN VALUE. toggleMic resolves to the new
      //      state — reading micOn() after the await races the async publish,
      //      which is exactly the state-lag the comment claimed to avoid.
      const on = await toggleMic(CONFIG.name);
      bus.emit('audio:mic', on);
    }));
  body_.append(micFloorRow());   // sensitivity belongs UNDER the switch it serves

  body_.append(checkRow('hear voices',
    'peers and agent speech — the 🎧 glyph is this same switch',
    receivingVoice() && !isHushed(), (on) => {
      if (on) { if (!receivingVoice()) setReceiveVoice(true); setHush(false); }
      else setHush(true);
    }));
  for (const [cat, label, hint] of ROWS) {
    body_.append(slider(cat, label, hint,
      cat === 'world' ? p.volWorld : cat === 'tts' ? p.volTts : p.volVoices));
  }
  // B2 (#90): the gate-unavailable escape hatch. Hidden while the gate works;
  // when the graph cannot be built the mic REFUSES to transmit and this row
  // appears — the explicit, user-visible choice to go raw. Never silent.
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
  // The structural act, deliberately last: hush is a gain, this is the
  // connection. Unticking negotiates no inbound media at all — the only row
  // here that is a guarantee rather than a preference. The wording leads with
  // what you GET (no connection, no cost) rather than with the mechanism,
  // because "refuse inbound audio" reads as a second mute to anyone who has
  // not thought about the wire. (Field note: a reader asked what it affords
  // over muting — if the label has to be explained, the label is wrong.)
  body_.append(checkRow('connect to other people’s audio',
    'on: your machine holds a live connection to each speaker nearby. ' +
    'Off: nothing is sent to you at all — saves bandwidth and CPU in busy ' +
    'rooms, and strangers cannot see your IP address. Muting only turns the ' +
    'volume down; this unplugs the wire.',
    receivingVoice(), (on) => { setReceiveVoice(on); if (on) setHush(false); }));

  // 🔴 THE TTS SECTION WAS ORPHANED. client/lib/ttsrow.js has shipped complete
  // since #91 (2026-08-10) and was NEVER imported by anything — not by the
  // commit that added it, not by main.js, not by origin/main today. 419 lines
  // of finished human UI, dead on arrival, which is why R could not find the
  // voice controls she remembered building. Found because she said "we did the
  // full UI for humans as well, where is it?" and was right; my first grep
  // covered only this file and I wrongly reported it as never built.
  // TTS sits between the text-to-speech volume row and the speech-to-text
  // controls — the voices you HAVE, next to the sliders that carry them.
  //
  // 🔴 ttsSection OWNS ITS HOST EXCLUSIVELY — build() does `host.textContent =
  // ''` (ttsrow.js:346) on every rebuild. Handing it body_ meant it ERASED
  // every row appended before it. Its own div, and the two coexist.
  const ttsHost = document.createElement('div');
  body_.append(ttsHost);
  ttsSection(ttsHost, () => {});
}

export function initAudioPanel() {
  ensureCss();
  makeSection('🔊 audio', (body) => paint(body), { id: 'audio' });
  // either control moving repaints the other's row — one truth, two surfaces
  bus.on('audio:hush', () => paint());
  bus.on('audio:receive', () => paint());
  bus.on('audio:mic', () => paint());     // the badge and this row are one state
}
