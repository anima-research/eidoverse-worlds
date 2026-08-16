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
import { micAnalyserLevel as meshMicLevel } from './voice.js';
// 🔴 ASK THE LIVE TRANSPORT (2026-08-15, R found this one in the HUD: "the mic
// icon isn't turning gold anymore when it is transmitting"). voice.js's
// micAnalyserLevel() reads the MESH's micStream, which is null forever on an
// SFU client — so it returns 0 at line one and the glyph can never go hot, and
// the sensitivity bar sits at zero while looking merely quiet. Fifth instance
// of this defect class in one night; see stt.js / voicemouths.js / tts.js.
function micLevelNow() {
  try {
    if (typeof window.__sfuMyLevel === 'function') return window.__sfuMyLevel();
    return meshMicLevel?.() ?? 0;
  } catch { return 0; }
}

import { gateUnavailable, ungatedConsent, allowUngated } from './micgate.js';
import { selfMonitor, selfMonitoring } from './micstate.js';
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
// instead of a ragged list. ttsrow.js already emits `.ctl` expecting exactly
// this ("same two columns as every other row") — it was written against a
// layout the panel never had, which is why its rows looked unlike the others.
//
// minmax(0,1fr) on the control column, not 1fr: the mic meter is flex:1 inside
// it and a bare 1fr lets it push the grid wider than the panel.
// 🔴 USE THE HOUSE TOKENS (R, 2026-08-16: "can you grab the slider/checkbox
// color and styling and the text color/look from the 'sky' panel as
// reference?").
//
// index.html:307-310 is that reference, and the whole of it is four lines
// because it spends the palette in :root rather than inventing values:
//     .row      { font-size: var(--fs-sm); color: var(--dim); }
//     .row .nm  { color: var(--fg); }
//     .row input[type=range] { accent-color: var(--accent); }
//     .row .v   { color: var(--accent); }
//
// This panel hardcoded its own sizes and greys and used `opacity: .75` for
// "dim" — which is not the same colour as --dim, just a washed-out version of
// whatever it sits on. So the audio section read as a slightly different
// application than the sky section, which is exactly what R noticed.
//
// Keeping the two-column grid (her spec, 08-14) and changing only the PAINT:
// labels take --fg, hints and units take --dim, controls take --accent.
// 🔴 NO PRIVATE STYLESHEET. This panel used to define 40 lines of CSS under an
// sp-* class family that re-implemented index.html's .row — which is exactly
// how its spacing drifted to gap:10px while the house row is 7px, invisibly,
// until R measured the two panels against each other by eye.
// (R, 2026-08-16: "If there is an existing UI class we should 100% be using
// it.")
// The one thing .row genuinely lacked is a label column wide enough for a
// sentence; that now lives in the house sheet as `.row.wide`, so both panels
// read the same rules and neither can drift from the other again.
// The injector went with it: there is nothing to inject. Styles come from the
// document's own sheet, like every other panel's.
function ensureCss() { /* house sheet — index.html owns .row and .row.wide */ }

// Labels say what they CONTROL, not what they are about (R, 2026-08-16:
// "you should probably change all the volume sliders to be voice volume, world
// volume, etc."). "voices" beside a slider is a category; "voice volume" is a
// control. It also disambiguates the row from the text-to-speech MODEL row
// below, which used to carry the identical label "text-to-speech".
const ROWS = [
  ['voices', 'voice volume', 'other people speaking, and agent speech'],
  ['world', 'world volume', 'ambience and place-sound — the 🎧 toggle never touches this'],
  // 🔴 "self-TTS volume", NOT "text-to-speech volume" (R, 2026-08-16: "is it a
  // bit of a misnomer? Voice volume covers EVERYTHING in the voice lane,
  // including TTS"). She is right — voicesource.js hands synthesized speech to
  // the same lane as a microphone, so 'voices' already governs every TTS you
  // HEAR. The old label promised control this slider could not have, and did
  // not have: volumeFor('tts') had no caller anywhere in the client.
  // It now scales the SIDETONE — what you hear of your own synthesized voice —
  // and deliberately not what goes out. R's argument (2026-08-16): "endpoint
  // volume should be in the end user's control anyway". A sender-side gain
  // would let me override every listener's own 'voices' slider, rolloff and
  // consent from my end; a speaker controls what they monitor, a listener
  // controls what they hear.
  ['tts', 'self-TTS volume', 'how loud you hear your own synthesized voice'],
];

function slider(cat, label, hint, value) {
  const row = document.createElement('div');
  row.className = 'row wide';
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
  row.className = 'row wide';
  // LABEL FIRST in the markup, because the grid assigns columns by source
  // order: label right-justified against the centre line, control left-
  // justified after it. The old order put the checkbox in the LABEL column and
  // the text in the control column — the exact inversion of R's spec.
  row.innerHTML =
    `<span class="nm" title="${hint}">${label}</span>` +
    `<span class="ctl"><input type="checkbox" ${checked ? 'checked' : ''} title="${hint}"></span>`;
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
const LVL_LIVE = '#ffd66b';   // = INK.hot in mictoggle.js. One instrument, one gold.
// Mic ON but under the threshold: the bar is hearing you and the gate is not
// passing it. Brighter than muted-dark (something IS happening) and plainly not
// the live gold (nothing is leaving your machine).
const LVL_WARM = '#9a8a5e';
const LVL_DARK = '#6b5f42';   // was #4a4230 — INVISIBLE against the black track
// (seen in the 08-15 screenshot: only the threshold marker showed). A muted
// meter must still be READABLE; "not transmitting" is said by being dimmer than
// live, not by vanishing. Verified visually, which is the only way this class
// of bug gets caught.

function micFloorRow() {
  const row = document.createElement('div');
  row.className = 'row wide';
  const hint = 'mic level below the marker is treated as room noise, not speech — ' +
    'raise it if typing pings nearby agents; the bar shows your live mic level';
  const FS = 0.2;  // full-scale mic level = right edge of the meter
  row.innerHTML =
    `<span class="nm" title="${hint}">mic sensitivity</span>` +
    `<span class="ctl">` +
    `<span data-meter title="${hint}" style="flex:1;min-width:60px;position:relative;height:14px;` +
    `background:#000;border-radius:2px;overflow:hidden;cursor:ew-resize">` +
    `<span data-lvl style="position:absolute;left:0;top:0;height:100%;width:0;background:${LVL_DARK}"></span>` +
    // The marker is a RULER, not a signal (R, 2026-08-16: "the percentage
    // slider being green is kinda ugly with a gold waveform bar… maybe just
    // white?"). Green read as a second status light competing with the level;
    // white states a POSITION and never argues with whatever colour the bar is.
    `<span data-thr style="position:absolute;top:0;height:100%;width:2px;background:rgba(255,255,255,.85);opacity:1"></span>` +
    `</span>` +
    `<span data-out style="min-width:34px;text-align:right">${Math.round(micFloor() * 500)}%</span>` +
    `</span>`;
  const meter = row.querySelector('[data-meter]');
  const out = row.querySelector('[data-out]');
  const lvl = row.querySelector('[data-lvl]');
  const thr = row.querySelector('[data-thr]');
  // 🔴 THREE STATES, NOT TWO (R, 2026-08-16: "when the mic sensitivity waveform
  // is over the sensitivity threshold and goes live, can you turn it bright
  // gold (same color as the HUD mic when it's live) and leave it gold until it
  // goes off again").
  //   mic off        → dark (still moves, so you can set a floor before unmuting)
  //   on, under floor→ dim  (hearing you, not passing the gate)
  //   on, over floor → GOLD (this is what the room actually gets)
  // The gold is INK.hot from mictoggle.js — the same value, because the badge
  // and this bar are read as one instrument.
  //
  // "leave it gold until it goes off again" IS hysteresis: a bare `level >
  // floor` strobes on every syllable boundary, because speech crosses its own
  // threshold dozens of times a second. Release at 85% of the floor, so it
  // latches through the gaps inside a word and drops on a real pause.
  const REL = 0.85;
  let hot = false;
  // 🔴 SIXTH INSTANCE OF THE SAME DEFECT (caught by tools/mic-meter-states.mjs,
  // 2026-08-16). micOn() reads voice.js's MESH micStream, which is null forever
  // on an SFU client — so this asked "is the mic on?" of a transport that is
  // not running and got `false` every time, and the bar could never leave its
  // muted colour no matter how loud you were. The file header at line 20 warns
  // about exactly this for micLevelNow(); the mic ROW above already asks
  // relayDiag() first. This is the third reader in this one file, so it gets
  // the same treatment rather than a fourth private copy.
  const micIsLive = () => {
    try { return window.relayDiag?.().micPublished ?? micOn(); } catch { return micOn(); }
  };
  const paintLive = () => {
    if (!micIsLive()) { hot = false; lvl.style.background = LVL_DARK; return; }
    lvl.style.background = hot ? LVL_LIVE : LVL_WARM;
  };
  paintLive();
  bus.on('audio:mic', paintLive);
  // Dragging the threshold must re-evaluate immediately: the bar is the thing
  // you are aiming, so it cannot wait for the next level sample to agree.
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
    const level = micLevelNow();
    lvl.style.width = `${Math.min(100, (level / FS) * 100)}%`;
    // Latch above the floor, release at REL× it. Repaint only on a state
    // CHANGE — this runs at frame rate, and assigning a style every frame is
    // how you get a repaint storm behind a bar that already looks fine.
    const floor = micFloor();
    const next = hot ? level > floor * REL : level > floor;
    if (next !== hot) { hot = next; paintLive(); }
    requestAnimationFrame(beat);
  };
  requestAnimationFrame(beat);
  return row;
}

let _body = null;
// 🔴 THE ROWS ARE BUILT ONCE AND THEN UPDATED IN PLACE (R, 2026-08-16: "I can
// see elements in the panel jumping around on the tick after a click… make
// that tear-down per element and not the whole panel").
//
// What was wrong: all three bus handlers called paint(), and paint() opened
// with innerHTML='' and rebuilt all nine rows. One checkbox click destroyed and
// recreated every node in the section — hence the jump. Worse, micFloorRow()'s
// beat() loop ends itself on !row.isConnected, so each teardown killed the live
// meter's rAF chain and started a new one (a visible stutter), and any in-flight
// pointer-drag on the threshold was dropped mid-gesture.
//
// ttsrow.js:204 already carries this doctrine for its own host — "UPDATE TEXT,
// DO NOT REBUILD… that is the thrash R saw". Same rule, second file.
//
// The three synced checkboxes keep a reference here; a bus event writes
// `.checked` and nothing else moves. Everything else in the panel owns its own
// state (sliders write through on input; the meter animates itself).
const _sync = { mic: null, hear: null, connect: null };

/** Reflect state onto the existing controls. No DOM construction, no reflow —
 *  this is what the bus handlers call instead of paint(). */
function syncRows() {
  if (!_body) return;
  const p = audioPrefs();   // unused today; kept so slider sync has an obvious home
  void p;
  if (_sync.mic) _sync.mic.checked = (window.relayDiag?.().micPublished ?? micOn());
  if (_sync.hear) _sync.hear.checked = receivingVoice() && !isHushed();
  if (_sync.connect) _sync.connect.checked = receivingVoice();
}

function paint(body) {
  // makeSection calls onOpen(body) on EVERY open, so this must be idempotent:
  // if the rows are already built and still attached, just re-sync them.
  if (body && _body === body && _body.firstChild) { syncRows(); return; }
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
  const micRow = checkRow('microphone',
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
    });
  _sync.mic = micRow.querySelector('input');
  body_.append(micRow);
  body_.append(micFloorRow());   // sensitivity belongs UNDER the switch it serves

  const hearRow = checkRow('hear voices',
    'peers and agent speech — the 🎧 glyph is this same switch',
    receivingVoice() && !isHushed(), (on) => {
      if (on) { if (!receivingVoice()) setReceiveVoice(true); setHush(false); }
      else setHush(true);
    });
  _sync.hear = hearRow.querySelector('input');
  body_.append(hearRow);
  // 🔴 TOGGLE, THEN ITS VOLUME (R, 2026-08-16: "you should probably move this
  // between world volume and TTS volume to be consistent in this panel —
  // usually it's toggle on/off then volume for a lot of these features").
  //
  // She is right, and the panel already read that way everywhere else: mic
  // switch then mic sensitivity, hear-voices then the voice slider. The TTS
  // model picker was the odd one out, stranded at the BOTTOM below the consent
  // rows — so the one feature whose on/off is furthest from its volume was
  // also the one with the most controls between them.
  //
  // Order is now: voice volume · world volume · [tts toggle + model list] ·
  // text-to-speech volume. The slider that belongs to a switch sits under it.
  const ttsHost = document.createElement('div');
  for (const [cat, label, hint] of ROWS) {
    if (cat === 'tts') body_.append(ttsHost);   // the switch, immediately above its slider
    body_.append(slider(cat, label, hint,
      cat === 'world' ? p.volWorld : cat === 'tts' ? p.volTts : p.volVoices));
  }
  // 🔴 HEAR YOUR OWN LANE — R asked for this on 2026-08-09 ("can you feed my own
  // audio lane back to me for this test so I can hear myself?"), micgate.js
  // built it, and it was never surfaced: setMonitor() had ZERO callers until
  // now, so the feature shipped dark for a week.
  //
  // It is the instrument that settles "is the gate actually working?" — the
  // question that found the SFU publishing ungated audio (2026-08-16). Source
  // reading says the gate is wired; hearing your own voice cut out cleanly when
  // you stop talking says it unambiguously. Tapped AFTER the gain node
  // (micgate.js:150), so when the gate closes the monitor goes quiet too — a
  // monitor on the RAW source would sound perfect while the room heard nothing.
  //
  // Default OFF and low: on speakers this WILL howl (mic hears monitor hears
  // mic), which the hint says out loud rather than leaving to be discovered at
  // volume.
  {
    const row = checkRow('hear my own mic (monitor)',
      'plays your gated lane back to you — exactly what the room hears, so silence here means the room hears silence. USE HEADPHONES: on speakers this feeds back.',
      selfMonitoring(), (on) => selfMonitor(on));
    body_.append(row);
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
  const connectRow = checkRow('connect to other people’s audio',
    'on: your machine holds a live connection to each speaker nearby. ' +
    'Off: nothing is sent to you at all — saves bandwidth and CPU in busy ' +
    'rooms, and strangers cannot see your IP address. Muting only turns the ' +
    'volume down; this unplugs the wire.',
    receivingVoice(), (on) => { setReceiveVoice(on); if (on) setHush(false); });
  _sync.connect = connectRow.querySelector('input');
  body_.append(connectRow);

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
  // ''` on every rebuild. Handing it body_ meant it ERASED every row appended
  // before it. Its own div, and the two coexist. (The div is created and
  // POSITIONED above, beside the tts volume slider; only the wiring is here,
  // after every row exists, so the section can measure the grid gutter.)
  ttsSection(ttsHost, () => {});
}

export function initAudioPanel() {
  ensureCss();
  makeSection('🔊 audio', (body) => paint(body), { id: 'audio' });
  // Either control moving updates the other's row — one truth, two surfaces.
  // 🔴 syncRows(), NOT paint(): these fire on every toggle, and a full repaint
  // tears down and rebuilds all nine rows (see the comment above _sync). The
  // state that needs mirroring is three booleans; write the three booleans.
  bus.on('audio:hush', syncRows);
  bus.on('audio:receive', syncRows);
  bus.on('audio:mic', syncRows);          // the badge and this row are one state
}
