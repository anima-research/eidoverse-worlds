// The mic glyph and the sensitivity bar go gold when the room can hear you, and only then — through the real transport.
// micstate.js roomHears() is the one answer: the lane is sending (the gate, the held key, mute, a synth voice), its track
// is on, voicesfu.js carries it on a connected peer connection, and no moderator has muted you (voicesfubridge.js).
// mictoggle-glyph-test.mjs and mic-meter-gate-test.mjs run the gate's side; this runs the transport's.
//
// Real: voicesfu.js, voicesfubridge.js, micstate.js, micgate.js, voiceconsent.js, voicesource.js, mictoggle.js,
// audiopanel.js. Stubbed at the browser boundary: RTCPeerConnection (a transceiver list whose negotiated direction the
// test sets), MediaStream and getUserMedia, an AudioContext whose analyser hears `room`, and a synth provider that keeps
// its own record of when it last wrote an audible frame (as tts.js's pacer does). net.js, ui.js, chat.js, stt.js,
// ttsrow.js, audiounlock.js and the player modules are no-ops. The in-VR indicator (xrmicicon.js) runs for real on a
// stubbed camera, canvas and Image, which records every glyph it is asked to draw.
//
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/mic-room-hears-test.mjs
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pause, tryUntil } from '../gate/wait.ts';
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });

const lib = (p) => fileURLToPath(new URL(`../../client/lib/${p}`, import.meta.url));
let room = 0;   // the RMS the analyser hears: 0 is also what a stalled headless AudioContext reads
let analyserThrows = false, gumFails = false;
let ctxState = 'running';   // the AudioContext's state: 'suspended' sends silence through the gate's graph
let gainThrows = false;     // a gain whose automation throws: the gate falls back to a step (`value =`)
let noGate = false;         // a context without createMediaStreamDestination: the gate cannot be built (the raw lane, if consented)
// what the console is told, counted from the first line of the run (base.js warnRarely speaks once a minute per kind)
let levelWarns = 0;
{ const w = console.warn; console.warn = (...a) => { if (/the level could not be read/.test(String(a[0]))) levelWarns++; else w(...a); }; }
// what each indicator shows once a turn that painted one of them is over (section 11 turns the watch on)
let watchTurns = false;
const turns = [];
const ctxListeners = [];    // 'statechange' listeners on the contexts the gate built (a resume is told through them)
const ctxOwn = new Map();   // a context's own state, where one context must differ from the rest (a listener → its override)
let gateGain = null;        // the gate's own gain (the last one automated), to stand for the audio clock across a suspend
const gainLog = [];   // every automation asked of any gain: ['target', v, tau] | ['set', v, at] | ['ramp', v, seconds from now] | ['cancel', from]
const node = () => ({ connect() {}, disconnect() {} });
const mkTrack = (label) => ({ kind: 'audio', label, enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; } });
class FakeStream { constructor(tracks) { this._t = tracks; } getTracks() { return this._t; } getAudioTracks() { return this._t; } }
globalThis.MediaStream = FakeStream;
Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: { getUserMedia: async () => {
  if (gumFails) throw new DOMException('no microphone', 'NotFoundError');
  return new FakeStream([mkTrack('device')]); } }, configurable: true });
mock.module(lib('audio/audioctx.js'), () => ({
  audioContext: () => ({
    currentTime: 0, sampleRate: 48000, get state() { return ctxOwn.get(this._fn) ?? ctxState; }, destination: node(),
    addEventListener(type, fn) { if (type === 'statechange') { ctxListeners.push(fn); this._fn = fn; } },
    createAnalyser: () => ({ ...node(), fftSize: 0, getFloatTimeDomainData(buf) { if (analyserThrows) throw new Error('analyser gone'); buf.fill(room); } }),
    createMediaStreamSource: () => node(),
    createGain: () => ({ ...node(), gain: { _v: 0, get value() { return this._v; },
      set value(v) { this._v = v; if (gainThrows) gainLog.push(['step', v]); },
      setTargetAtTime(v, t, tau) { if (gainThrows) throw new Error('automation refused'); this._v = v; gateGain = this; gainLog.push(['target', v, tau]); },
      cancelScheduledValues(t) { gainLog.push(['cancel', t]); }, setValueAtTime(v, t) { this.value = v; gainLog.push(['set', v, t]); },
      linearRampToValueAtTime(v, t) { this.value = v; gainLog.push(['ramp', v, t - this._t0]); }, _t0: 0 } }),
    createDelay: () => ({ ...node(), delayTime: { value: 0, setTargetAtTime() {} } }),
    ...(noGate ? {} : { createMediaStreamDestination: () => ({ ...node(), stream: new FakeStream([mkTrack('gated')]) }) }),
  }),
}));
const netSrc = readFileSync(lib('net.js'), 'utf8');
const NET = [...netSrc.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
for (const m of netSrc.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const n of m[1].split(',')) { const k = n.trim().split(/\s+as\s+/).pop(); if (k) NET.push(k); }
const net = { joined: false, myRights: null };
mock.module(lib('net.js'), () => ({ ...Object.fromEntries(NET.filter(n => n !== 'net').map(n => [n, () => {}])), net }));
let sttAv = false;   // speech-to-text available: the mute tooltip's captions clause reads it
mock.module(lib('audio/stt.js'), () => ({ setSTT() {}, sttAvailable: () => sttAv, sttOn: () => false }));
mock.module(lib('ui/chat.js'), () => ({ logChat: () => {} }));
mock.module(lib('audio/audiounlock.js'), () => ({ playWhenAllowed: () => {} }));
mock.module(lib('audio/ttsrow.js'), () => ({ ttsSection: () => document.createElement('div') }));
mock.module(lib('player/remotes.js'), () => ({ remotes: new Map() }));
mock.module(lib('player/controller.js'), () => ({ myState: { pos: { x: 0, y: 0, z: 0 } } }));
// the in-VR indicator's world: a camera that takes children, a canvas with a 2d context, an Image that records each paint
const xrPaints = [], xrPairs = [];   // each glyph drawn, and (glyph gold?, the look's opacity) as each paint sets them
class Obj { constructor() { this.position = { set() {} }; this.scale = { setScalar(v) { this.v = v; } }; }
  removeFromParent() {} add() {} }
mock.module(lib('core.js'), () => ({
  THREE: { CanvasTexture: class {}, SRGBColorSpace: 'srgb', PlaneGeometry: class {},
    MeshBasicMaterial: class { constructor(o) { Object.assign(this, o); }
      set opacity(v) { this._o = v; xrPairs.push({ gold: (xrPaints.at(-1) || '').includes('drop-shadow'), opacity: v }); afterTurn('vr'); }
      get opacity() { return this._o; } },
    Mesh: class extends Obj { constructor(g, m) { super(); this.material = m; } } },
  camera: new Obj(), renderer: {},
}));
mock.module(lib('xr/quadcolour.js'), () => ({ quadMaterial() {} }));
// the indicator's canvas: drawImage records the glyph actually drawn; Image loads (fires onload) as a browser's would
const xrDrawn = [];
HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, beginPath() {}, arc() {}, fill() {}, drawImage(img) { xrDrawn.push(img._svg); } });
globalThis.Image = class { set src(v) { this._svg = decodeURIComponent(v.replace(/^data:image\/svg\+xml;utf8,/, '')); xrPaints.push(this._svg);
  queueMicrotask(() => this.onload?.()); } };
mock.module(lib('ui/ui.js'), () => ({
  flashHint: () => {},
  makeSection: (title, build, opts = {}) => { const el = document.createElement('div'); el.id = `sec-${opts.id}`; document.body.appendChild(el); build(el); (globalThis.__builds ??= {})[opts.id] = build; return el; },
}));

// the peer connection: one inactive floor transceiver, as the server offers; `negotiated()` is the answer landing
const pcs = [];
const floor = () => ({ direction: 'inactive', currentDirection: 'inactive', sender: { track: null, enabledAtReplace: null,
  async replaceTrack(t) { this.track = t; this.enabledAtReplace = t?.enabled ?? null; } } });
globalThis.RTCPeerConnection = class {
  constructor() { this.connectionState = 'new'; this.iceConnectionState = 'new'; this.tx = [floor()]; pcs.push(this); }
  getTransceivers() { return this.tx; } addTrack() {} close() {}
};
const negotiated = (pc) => { for (const t of pc.tx) if (t.direction === 'sendonly') t.currentDirection = 'sendonly'; };

// the synth provider: playing → it is writing audible frames now (heardAt follows the clock); a fresh track per start
let synthOn = false, playing = false, heardAt = 0;
const synthTracks = [];
// the provider's clock is performance.now (voicesource.js); MRH_WALL=1 stamps Date.now, for a red-first run at a base
// whose micstate read the wall clock
const STAMP = process.env.MRH_WALL ? () => Date.now() : () => performance.now();
setInterval(() => { if (playing) heardAt = STAMP(); }, 10);

document.body.innerHTML = '<div id="hud"></div>';
const vc = await import(lib('audio/voiceconsent.js'));
const vsrc = await import(lib('audio/voicesource.js'));
vsrc.setSynthProvider({ available: () => synthOn, start: () => { const t = mkTrack('synth'); synthTracks.push(t); return t; }, stop() {},
  audibleAt: () => heardAt });
const ms = await import(lib('audio/micstate.js'));
const sfu = await import(lib('audio/voicesfu.js'));
const { initVoiceSfu } = await import(lib('audio/voicesfubridge.js'));
const { bus } = await import(lib('base.js'));
initVoiceSfu('p');
const mt = await import(lib('audio/mictoggle.js'));
const { initAudioPanel } = await import(lib('audio/audiopanel.js'));
initAudioPanel();
// before the mic has ever been on there is no gate, so the panel can't know yet whether a release will have a tail
const pttHintBeforeGate = [...document.querySelectorAll('#sec-audio [title]')].map((e) => e.title).find((x) => /transmit only while the push-to-talk key/.test(x)) || '';
await import(lib('xr/xrmicicon.js'));
bus.emit('xr:state', true);   // in VR: the indicator ticks at the HUD's cadence

let ok = 0, bad = 0;
const t = (n, cond, d = '') => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}${cond ? '' : `  — ${d}`}`); };
const glyph = () => document.querySelector('#micbtn')?.innerHTML || '';
const gold = () => glyph().includes('drop-shadow');
const slashed = () => glyph().includes('x1="7" y1="4"');
const lvl = document.querySelector('#sec-audio [data-lvl]');
const GOLD = /255, 214, 107|#ffd66b/i;
const barGold = () => GOLD.test(lvl.style.background);
const waves = () => glyph().includes('data-synth');
const state = () => `glyph gold=${gold()} slash=${slashed()} waves=${waves()} bar=${lvl.style.background} title="${document.querySelector('#micbtn')?.title}"`;
// the in-VR indicator: what it last drew, and whether that is what the HUD's glyph would draw now
const xrLast = () => xrDrawn.at(-1) || '';   // what the headset was last DRAWN, not only asked for
const xrShows = () => xrLast() === mt.micIndicatorSvg(84);
// the indicator's SVG goes to the headset as a standalone data:image/svg+xml, which is XML: every attribute needs a value
// (a bare `data-x`, fine in the HUD's innerHTML, makes the image fail to load in VR)
const xmlAttrsOk = (svg) => [...svg.matchAll(/<([^>]+)>/g)].every(([, tag]) =>
  /^\/?[\w:-]+\/?$/.test(tag.replace(/\s+[\w:-]+="[^"]*"/g, '').replace(/\s*\/$/, '/').trim()));
const xrState = () => `xr key=${mt.micIndicatorState()} paints=${xrPaints.length} lastSlash=${xrLast().includes('x1="7" y1="4"')} current=${xrShows()}`;
const POLLS = 'three glyph polls and many bar frames';
function afterTurn(who) {
  if (watchTurns) queueMicrotask(() => turns.push({ who, hud: gold(), vr: (xrPaints.at(-1) || '').includes('drop-shadow') }));
}
// A push-to-talk release keeps what was said while the key was down: it is still in the 50 ms lookahead, so the cut's
// 5 ms ramp starts one lookahead after the release, and the gold holds until that cut has closed. The close repaints
// the indicators itself (micstate.js 'audio:ptt-tail-end'), so the gold does not wait for a poll. `release` is the
// gesture; atOnce is what shows in its own turn, closed() what shows as the cut closes.
const LOOK_S = 0.05, CUT_S = 0.005, TAIL_MS = (LOOK_S + CUT_S) * 1000;
// ...and not late: the close's own timer fires ~1 ms after the cut, where the glyph's 8 Hz poll could land up to 125 ms
// after it. "Late" is an order, not a reading of the clock: releaseKey arms a reference timer this long just after the
// release (see it there), and the close must come before it fires. A stalled process (the gate at peak load: 114.9, 186.9 and 100.6 ms
// were read against a 100 ms wall-clock bound) delays both timers alike, and they still fire in the order they fall due;
// a tail-end timer set late, or a poll standing in for it, falls due after the reference and is told apart on any machine.
const TAIL_LATE_MS = 100;
const closedOnTime = (c) => !!c && c.ms >= TAIL_MS && !c.late;
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
const tipNow = () => document.querySelector('#micbtn')?.title || '';
function releaseKey(release) {
  const t0 = performance.now();
  let seen = null, refFired = false;
  const off = bus.on('audio:ptt-tail-end', () => {
    seen ??= { ms: performance.now() - t0, late: refFired, gold: gold(), hears: ms.roomHears(), xrKey: mt.micIndicatorState(),
      xrAsked: xrPaints.at(-1) || '', title: tipNow() };
  });
  release();
  // armed after the release, so it falls due after an on-time close (~56 ms) however late the process runs them both
  const ref = setTimeout(() => { refFired = true; }, TAIL_LATE_MS);
  const atOnce = { gold: gold(), hears: ms.roomHears(), xrKey: mt.micIndicatorState(), title: tipNow() };
  return { atOnce, closed: async () => { const r = await tryUntil('the delayed cut closes', () => seen, { ms: 1000 }); off(); clearTimeout(ref); return r || null; } };
}

// ── 1. the transport carries it, or nobody hears it (finding 3) ────────────────────────────────────────────────────
await sfu.sfuConnect({}, () => {});
const pc = pcs.at(-1);
await sfu.sfuMic(true);
const deviceLane = ms.micOn() && pc.tx[0].sender.track;
t('setup: the gated device lane is published on the floor (not yet negotiated)', !!deviceLane && pc.tx[0].direction === 'sendonly', state());
vc.setPttMode(true); ms.setPttHeld(true);   // the lane is sending: the held key is the gate
pc.connectionState = 'connecting'; pc.iceConnectionState = 'checking';
await pause(`ICE still checking, the key down: ${POLLS}`, 400);
t('ICE stalled with the gate open: the glyph is not gold', !gold(), state());
t('...and neither is the bar', !barGold(), state());
pc.connectionState = 'connected'; pc.iceConnectionState = 'connected';
pc.tx[0].currentDirection = null;   // connected, but the answer naming this sender's direction has not been applied
await pause(`connected, the sender's negotiated direction still null: ${POLLS}`, 400);
t('connected with the sender not yet negotiated (currentDirection null): not gold', !gold() && !barGold(), state());
negotiated(pc);
t('setup: connected and negotiated, the open lane turns both gold',
  !!(await tryUntil('the carried lane goes gold', () => gold() && barGold())), state());
pc.connectionState = 'failed'; pc.iceConnectionState = 'failed';
t('ICE fails under an open gate: the gold goes out', !!(await tryUntil('a failed connection leaves gold', () => !gold() && !barGold())), state());
pc.connectionState = 'connected'; pc.iceConnectionState = 'connected';
await tryUntil('gold again once connected', () => gold());
t('the published lane is carried; another stream holding the same track is not (the lane is what was published)',
  ms.laneCarried() === true && sfu.sfuCarries(new FakeStream([pc.tx[0].sender.track])) === false,
  `laneCarried=${ms.laneCarried()} other=${sfu.sfuCarries(new FakeStream([pc.tx[0].sender.track]))}`);
t('in VR, gold: the indicator draws the HUD glyph (hot)', mt.micIndicatorState() === 'hot'
  && !!(await tryUntil('the indicator repaints hot', () => xrShows())), xrState());
t('gold with the mic on carries no synth waves', !waves(), state());
// the words claim only what the code knows: the server gets your voice; who listens (consent, distance) is not counted
const meterHint = document.querySelector('#sec-audio [data-meter]')?.title || '';
const micTitle = document.querySelector('#micbtn').title;
t('the gold is named for what it means: "going out to the room" (glyph and bar), and nothing says the room hears you',
  /gold while your voice is going out to the room/.test(micTitle) && /gold while your voice is going out to the room/.test(meterHint)
  && !/hears you|is hearing/.test(micTitle + meterHint), `title="${micTitle}" hint="${meterHint}"`);

// ── 2. muted: the icon says so (Winifred's third point), and a moderator's mute is a mute ──────────────────────────
ms.toggleMute(true);
await tryUntil('the glyph repaints for the mute', () => !gold() && slashed());
t('muted: the glyph is not the ordinary on icon (it carries the slash), and not gold',
  !gold() && slashed() && glyph() !== mt.micGlyphFor(true, false), state());
t('muted: its tooltip says none of your voice goes out', /muted — none of your voice goes out/.test(document.querySelector('#micbtn').title), state());
t('muted carries no synth waves (only a synth voice that is going out does, mic on or off)', !waves(), state());
ms.toggleMute(false);
await tryUntil('unmuted, gold again', () => gold() && !slashed());
bus.emit('your-rights', { role: 'member', muted: { channels: ['voice'], until: null } });
await pause(`a moderator's voice mute (the SFU drops us at ingress): ${POLLS}`, 400);
t("moderator voice mute: not gold, though the lane is open (the server drops it)", !gold() && !barGold(), state());
t('...the glyph shows the mute and the tooltip names the moderator',
  slashed() && /moderator/.test(document.querySelector('#micbtn').title), state());
bus.emit('your-rights', { role: 'member' });
t('the moderator lifts it: gold again', !!(await tryUntil('gold after the lift', () => gold() && barGold())), state());
ms.setPttHeld(false);
await tryUntil('key up: the gold goes out', () => !gold());
t('in VR, mic on and silent: the indicator draws the plain on glyph', mt.micIndicatorState() === 'on'
  && !!(await tryUntil('the indicator repaints on', () => xrShows() && !xrLast().includes('x1="7" y1="4"'))), xrState());
ms.toggleMute(true);   // a mute landing while silent: gold never changes, only the slash does
t('in VR, muted while silent: the indicator repaints with the slash (key "muted")', !!(await tryUntil('the indicator repaints muted',
  () => mt.micIndicatorState() === 'muted' && xrShows() && xrLast().includes('x1="7" y1="4"'))), xrState());
const tip = () => document.querySelector('#micbtn').title;
t('muted, speech-to-text off: the tooltip says none of your voice goes out', /none of your voice goes out/.test(tip()) && !/caption/.test(tip()), tip());
sttAv = true; vc.setSttConsent(true);
sttAv = false;   // speech-to-text stops being available, with no event: only the words change, and the poll still repaints them
t('muted, speech-to-text gone with no event: the tooltip is repainted to say none of your voice goes out',
  !!(await tryUntil('the words follow', () => /none of your voice goes out/.test(tip()) && !/caption/.test(tip()), { ms: 2000 })), tip());
sttAv = true;
t('muted, speech-to-text on: the tooltip says captions still post, not that none of it goes out',
  !!(await tryUntil('the tooltip names captions', () => /captions still post/.test(tip()) && !/none of your voice/.test(tip()))), tip());
vc.setPttMode(true);
// stt.js keyAllows(): the held key (V, or A/X on a VR controller: both are setPttHeld) or the drain of a release
t('muted, speech-to-text on, push-to-talk: the tooltip says captions post while the key is held and as a release drains (stt.js keyAllows; captions themselves are stt-ptt\'s)',
  !!(await tryUntil('the tooltip names the key and the drain', () => /captions still post while you hold the push-to-talk key, and just after/.test(tip()))), tip());

vc.setPttMode(false);
net.myRights = { role: 'member', muted: { channels: ['voice', 'chat'], until: null } }; bus.emit('your-rights', net.myRights);
t('muted by a moderator in voice and chat, speech-to-text on: the tooltip says none of your voice goes out (say is refused; the refusal itself is the server\'s, not run here)',
  !!(await tryUntil('the tooltip drops the captions clause', () => /none of your voice goes out/.test(tip()) && !/caption/.test(tip()))), tip());
// the mic off and muted: turning it on starts consented speech-to-text (stt.js syncSTT), so the tooltip can't promise
// that nothing reaches the room
net.myRights = { role: 'member' }; bus.emit('your-rights', net.myRights);
await sfu.sfuMic(false);
t('mic off and self-muted, speech-to-text on: turning the mic on won\'t let the room hear your voice, but captions would post',
  !!(await tryUntil('mic off, self-muted tooltip', () => /^mic off, and muted — turning the mic on won't let the room hear your voice, but your speech-to-text captions would post\n/.test(tip()))), tip());
vc.setPttMode(true);
t('...and under push-to-talk, the clause names the key and the drain',
  !!(await tryUntil('mic off, self-muted, PTT tooltip', () => /captions would post while you hold the push-to-talk key, and just after\n/.test(tip()))), tip());
vc.setPttMode(false);
ms.toggleMute(false);
net.myRights = { role: 'member', muted: { channels: ['voice', 'chat'], until: null } }; bus.emit('your-rights', net.myRights);
t('mic off under a moderator\'s voice and chat mute, speech-to-text on: turning the mic on won\'t reach the room (no captions either)',
  !!(await tryUntil('mic off, chat-muted tooltip', () => /^mic off — and a moderator has muted your voice here: turning the mic on won't reach the room\n/.test(tip()))), tip());
net.myRights = { role: 'member', muted: { channels: ['voice'], until: null } }; bus.emit('your-rights', net.myRights);
t('mic off under a moderator\'s voice mute, speech-to-text on: turning the mic on won\'t let the room hear it, but captions would post',
  !!(await tryUntil('mic off, voice-muted tooltip', () => /^mic off — and a moderator has muted your voice here: turning the mic on won't let the room hear it, but your speech-to-text captions would post\n/.test(tip()))), tip());
net.myRights = { role: 'member' }; bus.emit('your-rights', net.myRights);
ms.toggleMute(true);
await sfu.sfuMic(true); negotiated(pc);
await tryUntil('the mic back on, muted', () => mt.micLive() && slashed());
vc.setSttConsent(false); sttAv = false;
ms.toggleMute(false);
t('...and unmuted, the slash goes from the indicator', !!(await tryUntil('the indicator repaints unmuted',
  () => mt.micIndicatorState() === 'on' && xrShows() && !xrLast().includes('x1="7" y1="4"'))), xrState());
bus.emit('your-rights', { role: 'member', muted: { channels: ['voice'], until: null } });
t("in VR, a moderator's mute while silent: the indicator shows it", !!(await tryUntil('the indicator repaints for the moderator',
  () => mt.micIndicatorState() === 'muted' && xrShows() && xrLast().includes('x1="7" y1="4"'))), xrState());
bus.emit('your-rights', { role: 'member' });
t('...and lifted, the stale slash goes', !!(await tryUntil('the indicator repaints after the lift',
  () => mt.micIndicatorState() === 'on' && xrShows() && !xrLast().includes('x1="7" y1="4"'))), xrState());
vc.setPttMode(false);

// ── 3. a synth voice published with the mic off (finding 2), heard on a stalled analyser (finding 1) ───────────────
synthOn = true;
await sfu.sfuMic(false);   // mic off with a provider: the swap publishes the synth lane, wantMic = false (it settles later)
const synthLane = await tryUntil('the swap put the synth track on the sender', () => synthTracks.length && pc.tx[0].sender.track === synthTracks.at(-1) && synthTracks.at(-1));
t('setup: the synth lane is on the sender, with mic intent off, and nothing gold yet', !!synthLane && sfu.sfuMicOn() === false
  && !!(await tryUntil('a silent synth lane is not gold', () => !gold() && !barGold())), state());
t('mic off by the transport alone (no audio:mic event), silent: the glyph repaints slashed, no synth waves',
  !!(await tryUntil('the glyph follows the mic off', () => slashed() && !waves() && /^mic off/.test(document.querySelector('#micbtn').title))), state());
room = 0.3; playing = true;
t('TTS speaking with the mic off: the glyph is gold (it is going out to the room)', !!(await tryUntil('the synth voice goes gold', () => gold())), state());
t('...and so is the bar', !!(await tryUntil('the bar agrees', () => barGold())), state());
t('...its glyph keeps the slash and adds sound waves: a shape, not only a colour, tells it from off and muted',
  slashed() && waves(), state());
t('in VR, a synth voice going out with the mic off: its own key ("hot-off"), and the indicator draws it',
  mt.micIndicatorState() === 'hot-off' && !!(await tryUntil('the indicator repaints hot-off', () => xrShows() && xrLast().includes('data-synth'))), xrState());
t('...and every glyph the indicator drew is well-formed XML (it loads as an image in the headset)',
  xrPaints.length > 0 && xrPaints.every(xmlAttrsOk), xrPaints.filter((x) => !xmlAttrsOk(x)).map((x) => x.match(/<[^>]*data-[^>]*>/)?.[0]).join(' | '));
room = 0;   // the analyser hears nothing (a stalled headless clock) while the generator keeps sending speech
await pause(`the analyser silent past the 700 ms hang while the provider still writes speech: ${POLLS}`, 1000);
t('analyser silent, provider writing speech: still gold (the provider\'s record, not the analyser)', gold() && barGold(), state());
playing = false;
t('the provider falls silent: the gold goes out after the hang', !!(await tryUntil('silent synth leaves gold', () => !gold() && !barGold())), state());

// ── 4. mute ends the synth hang without a poll in between (finding 4) ─────────────────────────────────────────────
room = 0.3; playing = true;
await tryUntil('playing again', () => gold());
playing = false; heardAt = STAMP() - 5; room = 0;   // the voice stops just before the mute
ms.toggleMute(true); ms.toggleMute(false);            // and no poll runs in between
t('mute then unmute with the voice silent: not speaking, at once (the mute ended the hang)',
  ms.micGateInfo().speaking === false && (ms.roomHears?.() ?? false) === false, JSON.stringify(ms.micGateInfo()));

// ── 5. the transport's own off outranks unmute (finding 6) ─────────────────────────────────────────────────────────
playing = true;
await tryUntil('playing again', () => gold());
ms.toggleMute(true);
t('setup: muted, the synth track is off', synthLane.enabled === false);
synthOn = false;
await sfu.sfuMic(false);   // no provider any more: the transport turns the lane off
ms.toggleMute(false);
t('unmute after the transport turned the synth lane off: the track stays off', synthLane.enabled === false);
await pause(`the track off, the provider still writing: ${POLLS}`, 400);
t('...and nothing is gold', !gold() && !barGold(), state());

// ── 6. the generator rebuilt while muted, through the bridge's hook and the swap (finding 6's test) ────────────────
synthOn = true;
ms.toggleMute(true);
vsrc.notifySynthTrackChanged(mkTrack('ignored'));   // voicesfubridge.js's hook: mic off, provider available → sfuMic(false)
const rebuilt = await tryUntil('the swap put a new synth track on the sender', () => synthTracks.length > 1 && pc.tx[0].sender.track === synthTracks.at(-1) && synthTracks.at(-1));
t('muted rebuild: the sender got the new track already off', !!rebuilt && pc.tx[0].sender.enabledAtReplace === false && rebuilt.enabled === false,
  `enabledAtReplace=${pc.tx[0].sender.enabledAtReplace}`);
ms.toggleMute(false);
t('...on at unmute, and gold while it plays', !!rebuilt && rebuilt.enabled === true && !!(await tryUntil('rebuilt lane gold', () => gold())), state());
playing = false;

// ── 7. every paint draws the state as it is now, not as the last poll saw it ───────────────────────────────────────
const xrGold = () => xrLast().includes('drop-shadow');
synthOn = false;
await sfu.sfuMic(true);
negotiated(pc);
vc.setPttMode(true); ms.setPttHeld(true);
t('setup: the device lane is gold under the held key, on the HUD and in VR',
  !!(await tryUntil('gold under PTT', () => gold() && xrShows() && xrGold())), `${state()} ${xrState()}`);
const keyUp = releaseKey(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyV' })));
t('PTT keyup: still gold in the same turn, because the last 50 ms said under the key is still going out',
  keyUp.atOnce.hears === true && keyUp.atOnce.gold === true, `${JSON.stringify(keyUp.atOnce)} ${state()}`);
t('...and the tooltip says so: the key is up and the end of the word is going out, not "hold V to speak" beside a gold glyph',
  /^push-to-talk: the key is up — the end of your last word is still going out/.test(keyUp.atOnce.title) && !/hold V/.test(keyUp.atOnce.title), keyUp.atOnce.title);
const keyUpClosed = await keyUp.closed();
t(`...and dark as the cut closes (${TAIL_MS} ms after the keyup, before a ${TAIL_LATE_MS} ms timer armed at the release), painted by the close itself, not the last poll`,
  closedOnTime(keyUpClosed) && keyUpClosed.hears === false && keyUpClosed.gold === false
  && /^push-to-talk armed — hold V to speak \(A\/X on a VR controller\)/.test(keyUpClosed.title), `${JSON.stringify(keyUpClosed)} ${state()}`);
ms.setPttHeld(true);
await tryUntil('gold again under the key, in VR too', () => gold() && xrShows() && xrGold());
// the XR controller's A/X release (xr.js): setPttHeld alone, no key event
const vrRel = releaseKey(() => ms.setPttHeld(false));
t('VR controller release: the HUD and the indicator stay gold while the last 50 ms goes out',
  vrRel.atOnce.gold === true && vrRel.atOnce.xrKey === 'hot', `${JSON.stringify(vrRel.atOnce)} ${xrState()}`);
const vrClosed = await vrRel.closed();
t(`...and as the cut closes (${TAIL_MS} ms on, before a ${TAIL_LATE_MS} ms timer armed at the release) the indicator asks for the plain glyph and the HUD drops gold, with no tick`,
  closedOnTime(vrClosed) && !vrClosed.xrAsked.includes('drop-shadow') && vrClosed.xrKey === 'on' && vrClosed.gold === false,
  `${JSON.stringify(vrClosed && { ...vrClosed, xrAsked: vrClosed.xrAsked.includes('drop-shadow') ? 'gold' : 'plain' })} ${xrState()}`);
t('...and the headset draws it once the image loads', !!(await tryUntil('the indicator draws the release', () => !xrGold() && xrShows())), xrState());
ms.setPttHeld(true);
await tryUntil('gold again before turning the mic off', () => gold());
await ms.toggleMic();   // V or a click: the mic off, and no synth provider to take over
t('toggleMic off with no synth provider: no waves, not gold, and the VR key is not hot-off, in the same turn',
  ms.roomHears() === false && !gold() && !waves() && mt.micIndicatorState() === 'off'
  && !/synthesized/.test(document.querySelector('#micbtn').title), `${state()} key=${mt.micIndicatorState()}`);
// the bar's warm/dark follows a mic the transport turns off with no event
vc.setPttMode(false);
await sfu.sfuMic(true);
await tryUntil('the mic back on', () => mt.micLive());
ms.setPttHeld(false); vc.setPttMode(true);   // on, key up: the bar is warm
t('setup: mic on, key up: the bar is warm', !!(await tryUntil('warm bar', () => /154, 138, 94|#9a8a5e/i.test(lvl.style.background))), state());
await sfu.sfuMic(false);   // the transport alone, no audio:mic
t('the transport turns the mic off with no event: the bar goes dark',
  !!(await tryUntil('dark bar', () => /107, 95, 66|#6b5f42/i.test(lvl.style.background))), state());

// ── 8. airtight: one read per VR paint, a throwing answer, the bar's loop across a VR exit, the panel rebuilt ────────
const pttHint = [...document.querySelectorAll('#sec-audio [title]')].map((e) => e.title).find((x) => /transmit only while the push-to-talk key/.test(x)) || '';
t('the push-to-talk hint says the end of the last word still goes out and the mic cuts off 50 ms after the release, in 5 ms, and that a synth voice is not keyed by it',
  /Release the key and the end of your last word still goes out: your mic cuts off 50 ms later \(your voice is sent 50 ms behind you\), within 5 ms, and the gold goes with it\./.test(pttHint)
  && !/at once|after a short fade|fades out/.test(pttHint) && /synthesized voice is not keyed by it/.test(pttHint), pttHint);
t('...and before any gate was built it promised neither: 50 ms later where the device can hold the voice back, at once where it can\'t',
  /cuts off, and the gold goes with it: 50 ms later where this device can send your voice 50 ms behind you .* at once where it can't\./.test(pttHintBeforeGate)
  && !/still goes out: your mic cuts off 50 ms later/.test(pttHintBeforeGate), pttHintBeforeGate);
t('...and names the key as it is held: V, or A/X on a VR controller (not V alone)',
  /^transmit only while the push-to-talk key is held down \(V, or A\/X on a VR controller\)/.test(pttHint), pttHint);
const floorHint = [...document.querySelectorAll('#sec-audio [title]')].map((e) => e.title).find((x) => /voice-activation threshold/.test(x)) || '';
t('the sensitivity hint says speech-to-text, when on, still hears what the marker keeps from the room (as main\'s did)',
  /sound under it the rest of the time is not sent as voice \(speech-to-text, when on, still hears it\)/.test(floorHint), floorHint);
await sfu.sfuMic(true);
negotiated(pc);
ms.setPttHeld(true);
t('setup: the mic back on, gold under the key (glyph, bar, VR)',
  !!(await tryUntil('gold under the key', () => gold() && barGold() && xrGold())), `${state()} ${xrState()}`);
const laneTrack = pc.tx[0].sender.track;
const realEnabled = laneTrack.enabled;
// a track whose `enabled` flips on every read: two reads of roomHears() in a row disagree
let flip = false;
Object.defineProperty(laneTrack, 'enabled', { configurable: true, get() { flip = !flip; return flip; }, set() {} });
const pairsFrom = xrPairs.length;
// an extra reader off the 125 ms beat, so the reads between two VR ticks are not always an even number (that phase would
// leave the indicator's state constant, and nothing painted to check)
const jitter = setInterval(() => ms.roomHears(), 37);
await tryUntil(`the answer flipping on every read: at least 3 VR paints`, () => xrPairs.length - pairsFrom >= 3, { ms: 4000 });
clearInterval(jitter);
const pairs = xrPairs.slice(pairsFrom);
t('in VR, each paint takes its look and its glyph from one read: gold is drawn at the hot look and only there',
  pairs.length > 0 && pairs.every((p) => p.gold === (p.opacity === 1)),
  JSON.stringify(pairs.slice(0, 6)));
// roomHears() throwing on every call
let huds = 0, warns = 0;
const realWarn = console.warn; console.warn = (...a) => { if (/roomHears\(\) threw/.test(String(a[0]))) warns++; else realWarn(...a); };
Object.defineProperty(laneTrack, 'enabled', { configurable: true, get() { throw new Error('a track that throws'); }, set() {} });
await pause('the throw lands on a poll and a paint', 300);
const mo = new MutationObserver(() => huds++);
mo.observe(document.querySelector('#micbtn'), { childList: true });
await pause(`roomHears throwing: ${POLLS}`, 1000);
mo.disconnect();
console.warn = realWarn;
t('roomHears throwing: the HUD glyph is not repainted on every poll (and shows not gold)', huds <= 1 && !gold(), `${huds} paints in 1 s; ${state()}`);
t('...and the broken read is told to the console, once (not at frame rate)', warns === 1, `${warns} warnings in 1.3 s`);
t('...and the bar fails toward not gold while it throws (its frame loop reads a throw as not hot)', !barGold(), state());
delete laneTrack.enabled; laneTrack.enabled = realEnabled;
t('...and the bar\'s frame loop outlives the throw: gold again once the answer is', !!(await tryUntil('the bar gold again', () => gold() && barGold())), state());
// the bar's loop across a VR exit: a frame still waiting on the session when it ends
const { installFrameClock } = await import(lib('xr/xr_frame_clock.js'));
const ses = { cbs: new Map(), n: 0, ends: [],
  requestAnimationFrame(cb) { this.cbs.set(++this.n, cb); return this.n; }, cancelAnimationFrame(id) { this.cbs.delete(id); },
  addEventListener(type, cb) { if (type === 'end') this.ends.push(cb); },
  tick() { const cbs = [...this.cbs.values()]; this.cbs.clear(); for (const cb of cbs) cb(performance.now()); },
  end() { for (const cb of this.ends.splice(0)) cb(); } };
installFrameClock({ win: window, session: ses, saved: null });
const pump = setInterval(() => ses.tick(), 16);   // presenting: the session's clock drives every rAF loop
t('setup: in VR the bar\'s loop runs on the session clock, gold while talking',
  !!(await tryUntil('the bar on the session clock', () => ses.cbs.size > 0 && barGold())), state());
clearInterval(pump);   // the session stops calling back...
ses.end();             // ...and ends while you are still talking
ms.setPttHeld(false);  // then you stop
t('VR exit while gold: the bar\'s loop comes back on the window clock and the bar leaves gold',
  !!(await tryUntil('the bar leaves gold after the exit', () => !barGold())), state());
// the panel rebuilt: the old row's listeners go with it
const oldSec = document.querySelector('#sec-audio'), oldLvl = lvl;
oldSec.remove();
const fresh = document.createElement('div'); fresh.id = 'sec-audio'; document.body.appendChild(fresh);
globalThis.__builds.audio(fresh);
const newLvl = fresh.querySelector('[data-lvl]');
await pause('the old row\'s frame loop sees it detached', 300);
// sentinels only a live listener would overwrite: the bar's colour (mic, mute, micfloor) and the row's dimming (ptt)
const oldRow = oldLvl.closest('.sp-row'), newRow = newLvl?.closest('.sp-row');
for (const el of [oldLvl, newLvl]) el.style.background = 'rgb(1, 2, 3)';
for (const el of [oldRow, newRow]) el.style.opacity = '0.33';
ms.toggleMute(true); ms.toggleMute(false); bus.emit('audio:mic', true); bus.emit('audio:micfloor');
vc.setPttMode(false); vc.setPttMode(true);   // audio:ptt, both ways
t('the panel rebuilt: the detached row no longer listens (both sentinels stand)',
  oldLvl.style.background === 'rgb(1, 2, 3)' && oldRow.style.opacity === '0.33', `old bar=${oldLvl.style.background} old row=${oldRow.style.opacity}`);
t('...and the new row does (mute repaints its bar, push-to-talk dims it)',
  !!newLvl && newLvl !== oldLvl && newLvl.style.background !== 'rgb(1, 2, 3)' && newRow.style.opacity === '0.45',
  `new bar=${newLvl?.style.background} new row=${newRow?.style.opacity}`);
const lvlNow = newLvl;   // the rows below read the rebuilt panel's bar
const barGoldNow = () => GOLD.test(lvlNow.style.background);

// ── 9. round five: the gain's real envelope, a mute with the mic off, the synth fallback, the clocks, the menus ─────
// a gated lane under push-to-talk: the release is a cut, not a 120 ms fade
await sfu.sfuMic(true); negotiated(pc);
ms.setPttHeld(true);
t('setup: gold under the key', !!(await tryUntil('gold under the key', () => gold() && barGoldNow())), state());
t('held, the tooltip names the push-to-talk key, not V alone (A/X on a VR controller hold it too)',
  /^push-to-talk: key held \(release it to stop\)/.test(tipNow()) && !/V held/.test(tipNow()), tipNow());
gainLog.length = 0;
const gainRel = releaseKey(() => ms.setPttHeld(false));
const relLog = gainLog.slice();
const relSet = relLog.find((g) => g[0] === 'set'), last = relLog.at(-1) || [];
t('PTT release cuts the gain one lookahead later: held at its level until +50 ms, then a ramp to 0 that ends at +55 ms; not the voice-activation fade (setTargetAtTime τ 120 ms)',
  !!relSet && relSet[1] > 0.9 && near(relSet[2], LOOK_S) && last[0] === 'ramp' && last[1] === 0 && near(last[2], LOOK_S + CUT_S)
  && !relLog.some((g) => g[0] === 'target' && g[1] === 0 && g[2] >= 0.1), JSON.stringify(relLog));
t('...and gold holds in the same turn: the room is still getting the end of the word', gainRel.atOnce.hears === true && gainRel.atOnce.gold === true,
  `${JSON.stringify(gainRel.atOnce)} ${state()}`);
const gainClosed = await gainRel.closed();
t(`...and gold ends as the cut closes (${TAIL_MS} ms on), not before and not at a later poll (before a ${TAIL_LATE_MS} ms timer armed at the release)`,
  closedOnTime(gainClosed) && gainClosed.hears === false && gainClosed.gold === false, `${JSON.stringify(gainClosed)} ${state()}`);
t('...and the 20 ms ticks over the tail do not reschedule the cut (each would push it later): one hold, one ramp',
  gainLog.filter((g) => g[0] === 'ramp').length === 1 && gainLog.filter((g) => g[0] === 'set').length === 1, JSON.stringify(gainLog));
// a mute and the mic off under push-to-talk mean "stop now": the cut starts at once, with no lookahead tail
const atOnceCut = (log) => { const s = log.filter((g) => g[0] === 'set'), r = log.at(-1) || [];
  return s.length >= 1 && s.every((g) => near(g[2], 0)) && r[0] === 'ramp' && r[1] === 0 && near(r[2], CUT_S); };
ms.setPttHeld(true);
await tryUntil('gold under the key', () => gold());
gainLog.length = 0; ms.toggleMute(true);
t('PTT held, then mute: the cut starts at once (ends at +5 ms, no lookahead tail) and gold ends in the same turn',
  atOnceCut(gainLog) && ms.roomHears() === false && !gold(), `${JSON.stringify(gainLog)} ${state()}`);
ms.toggleMute(false);
await tryUntil('gold under the key again', () => gold());
gainLog.length = 0; ms.setMicLive(false);
// (the answer only: setMicLive is the transport's report and emits no event, so the glyph follows it at its next poll)
t('PTT held, then the mic off: the cut starts at once and the room stops hearing it in the same turn',
  atOnceCut(gainLog) && ms.roomHears() === false, `${JSON.stringify(gainLog)} ${state()}`);
ms.setMicLive(true);
await tryUntil('gold under the key again', () => gold());
// a mute inside a release's tail: the person now means to stop at once, so the pending cut is brought forward
ms.setPttHeld(false); gainLog.length = 0; ms.toggleMute(true);
t('a mute inside the release tail brings the cut forward: it starts at once, and gold ends in the same turn',
  atOnceCut(gainLog) && ms.roomHears() === false && !gold(), `${JSON.stringify(gainLog)} ${state()}`);
ms.toggleMute(false);
await pause('past the tail', 100);
// a re-press inside the tail: the pending cut is cancelled, or it would cut the new word 50 ms in
ms.setPttHeld(true);
await tryUntil('gold under the key again', () => gold());
await pause('the key held past the 8 ms attack, so the gain is open when it comes up', 60);
ms.setPttHeld(false); gainLog.length = 0; ms.setPttHeld(true);
const rePress = gainLog.slice();
const cancelAt = rePress.findIndex((g) => g[0] === 'cancel'), openAt = rePress.findIndex((g) => g[0] === 'target' && g[1] === 1);
await pause('past where the cancelled cut would have closed', 120);
t('a re-press inside the release tail cancels the pending cut before it opens, and the room still hears you after the tail',
  cancelAt >= 0 && openAt > cancelAt && !gainLog.some((g) => g[0] === 'ramp') && ms.roomHears() === true && gold(), `${JSON.stringify(gainLog)} ${state()}`);
const holdAt = rePress.findIndex((g, i) => i > cancelAt && g[0] === 'set');
t('...and the gain does not dip: after the cancel it is held at the level it had (near full, not 0) and reopens from there',
  cancelAt >= 0 && holdAt > cancelAt && holdAt < openAt && rePress[holdAt][1] > 0.9 && near(rePress[holdAt][2], 0)
  && !rePress.some((g) => (g[0] === 'set' || g[0] === 'ramp') && g[1] === 0), JSON.stringify(rePress));
// the menus (the ∃ menu, the VR ring) draw the HUD glyph: mictoggle.js announces each change of its key, in the turn
// it happens, so they repaint with the HUD and not at a sweep
const announced = [];
const offInd = bus.on('mic:indicator', (k) => announced.push(k));
const relAnn = releaseKey(() => ms.setPttHeld(false));
const annAtOnce = announced.slice();
await relAnn.closed();
const annAtClose = announced.slice();
ms.toggleMute(true);
const annMuted = announced.at(-1);
ms.toggleMute(false);
offInd();
t('the indicator\'s key is announced as it changes: nothing at the release (still gold), "on" as the tail closes, "muted" in the turn of a mute',
  annAtOnce.length === 0 && annAtClose.at(-1) === 'on' && annMuted === 'muted', JSON.stringify({ annAtOnce, annAtClose, annMuted }));
ms.setPttHeld(true);
await tryUntil('gold under the key again', () => gold());
ms.setPttHeld(false);
await tryUntil('key up: the gold goes out', () => !gold());
// voice activation: after the hang the gain fades over ~0.83 s (to -60 dB), and sound in the fade is sent: gold holds
vc.setPttMode(false);
room = 0.3;
t('setup: voice activation, speaking: gold', !!(await tryUntil('gold by level', () => gold())), state());
gainLog.length = 0;
room = 1e-4;   // under the line, not muted (0 reads as muted)
// anchored on the event, not a fixed pause (a loaded host stretches timers): the hang has ended when the gate schedules
// its release fade
const fadeBegan = await tryUntil('the hang ends and the release fade is scheduled',
  () => gainLog.some((g) => g[0] === 'target' && g[1] === 0 && g[2] >= 0.1) && performance.now(), { ms: 3000 });
const sendingAtFade = ms.roomHears();
t('voice activation: as the release fade begins (the hang over), the lane still counts as sending (sound is still going out)',
  !!fadeBegan && sendingAtFade === true, `fade=${!!fadeBegan} roomHears=${sendingAtFade} gain=${JSON.stringify(gainLog.slice(-2))}`);
const closedAt = await tryUntil('the fade closes', () => !gold() && ms.roomHears() === false && performance.now(), { ms: 4000 });
t('...and gold ends only once the gain has closed (-60 dB, ~0.83 s into the fade: at least 0.6 s after it began)',
  !!closedAt && !!fadeBegan && closedAt - fadeBegan >= 600, `closed ${closedAt && fadeBegan ? Math.round(closedAt - fadeBegan) : '?'} ms into the fade`);
// arming push-to-talk is a deliberate close (a cut), and under push-to-talk a cut carries a release's tail; but arming while
// silent has no word in the lookahead to let out: the gain is already shut, so the cut is not a tail and nothing is gold
await pause('well past the fade: the gain is shut', 300);
{ vc.setPttMode(true);
  const hearsAtOnce = ms.roomHears(), goldAtOnce = gold();
  let goldSeen = goldAtOnce;
  const t0 = performance.now();
  while (performance.now() - t0 < 150) { if (gold() || ms.roomHears()) goldSeen = true; await pause('watch for a phantom tail', 5); }
  t('arming push-to-talk while silent: not gold, in its own turn or after (no tail of a word that was never said)',
    hearsAtOnce === false && goldAtOnce === false && !goldSeen, `roomHears=${hearsAtOnce} gold=${goldAtOnce} seen=${goldSeen} ${state()}`);
  vc.setPttMode(false); }
// arming push-to-talk mid-speech: the end of the word goes out through the tail, and gold goes dark as its cut closes,
// told by the close itself (audio:ptt-tail-end), not at the glyph's next poll
room = 0.3;
t('setup: voice activation, speaking again: gold', !!(await tryUntil('gold by level', () => gold())), state());
{ const arm = releaseKey(() => vc.setPttMode(true));
  t('arming push-to-talk mid-speech: still gold in the same turn (the word in the lookahead is still going out)',
    arm.atOnce.hears === true && arm.atOnce.gold === true, `${JSON.stringify(arm.atOnce)} ${state()}`);
  const armClosed = await arm.closed();
  t(`...and audio:ptt-tail-end fires and gold ends as the cut closes (${TAIL_MS} ms on, before a ${TAIL_LATE_MS} ms timer armed at the arming), not at a later poll`,
    closedOnTime(armClosed) && armClosed.hears === false && armClosed.gold === false, `${JSON.stringify(armClosed)} ${state()}`);
  vc.setPttMode(false); }
room = 1e-4;
await tryUntil('the gate closes by level', () => !gold() && ms.roomHears() === false, { ms: 4000 });
room = 0;
// a moderator's mute with the mic off: the tooltip names it (V can't make the voice reach the room)
await sfu.sfuMic(false);
await tryUntil('mic off', () => !mt.micLive());
bus.emit('your-rights', { role: 'member', muted: { channels: ['voice'], until: null } });
t('mic off under a moderator mute: the tooltip names the moderator, not "V to talk"',
  !!(await tryUntil('the tooltip names the moderator', () => /moderator/.test(document.querySelector('#micbtn').title)
    && !/V to talk|arm push-to-talk/.test(document.querySelector('#micbtn').title))), state());
// the menus' mic icon: the same glyph as the HUD (slash for a mute, gold while going out)
await sfu.sfuMic(true); negotiated(pc);
await tryUntil('mic on, moderator-muted', () => mt.micLive() && slashed());
t('the menu mic icon shows the moderator mute (slashed), as the HUD does', /x1="7" y1="4"/.test(mt.micGlyph(16)), mt.micGlyph(16));
bus.emit('your-rights', { role: 'member' });
vc.setPttMode(true); ms.setPttHeld(true);
await tryUntil('gold again', () => gold());
t('...and gold while the voice is going out', mt.micGlyph(16).includes('drop-shadow'), mt.micGlyph(16));
ms.setPttHeld(false);
// a synth voice standing in for a mic that couldn't be opened, under push-to-talk with the key up
synthOn = true; gumFails = true;
await sfu.sfuMic(false);   // mic off with a provider: the synth lane
await sfu.sfuMic(true);    // wanted mic, no device to open: the synth provider supplies the lane
const fallback = await tryUntil('the synth fallback is on the sender', () => pc.tx[0].sender.track === synthTracks.at(-1) && synthTracks.at(-1));
negotiated(pc);
t('synth fallback under PTT, key up, silent: the tooltip says no microphone is open and V does not key the synth voice (not "hold V to speak")',
  !!fallback && !!(await tryUntil('the quiet fallback tooltip', () => !gold()
    && /^mic on, but no microphone is open: a synthesized voice stands in for it, and V does not key it — gold while your voice is going out to the room\n/.test(tip()))), `${state()}`);
// what reaches the room is the gold's to say: with the transport down the words still hold
pc.connectionState = 'disconnected';
await pause('the transport down under the quiet fallback: a glyph poll', 200);
t('...and with the transport not carrying the lane, the tooltip promises nothing it can\'t keep (no "goes out to the room when it speaks")',
  ms.laneCarried() === false && !/goes out to the room when it speaks/.test(tip()) && /gold while your voice is going out to the room/.test(tip()), tip());
pc.connectionState = 'connected';
// not hearing the room is said beside the fallback (and push-to-talk) too, not only beside the plain mic-on words
const recv0 = vc.receivingVoice();
vc.setReceiveVoice(false);
t('the synth fallback while not hearing the room: the tooltip says that too',
  !!(await tryUntil('the tooltip names the deafness', () => /no microphone is open/.test(tip())
    && /\nyou are not hearing the room \(click the headphones to listen\)\n/.test(tip()), { ms: 2000 })), tip());
vc.setReceiveVoice(true);
t('...and not once you are', /no microphone is open/.test(tip()) && !/not hearing the room/.test(tip()), tip());
// hushed is not hearing either: the voices arrive and none is played (finding 2 of #383's review)
vc.setHush(true);
t('the headphones hushed (voices still received): the tooltip says you are not hearing the room, as it does with none received',
  vc.receivingVoice() === true && !!(await tryUntil('the tooltip names the hush', () => /no microphone is open/.test(tip())
    && /\nyou are not hearing the room \(click the headphones to listen\)\n/.test(tip()), { ms: 2000 })), tip());
vc.setHush(false);
t('...and not once unhushed', !!(await tryUntil('the tooltip drops it', () => /no microphone is open/.test(tip()) && !/not hearing the room/.test(tip()), { ms: 2000 })), tip());
vc.setReceiveVoice(recv0);
playing = true;
t('synth fallback under PTT, key up, speaking: gold, with the waves, and the tooltip says it is going out (not "hold V")',
  !!fallback && !!(await tryUntil('the fallback goes gold', () => gold() && waves()
    && /synthesized voice is going out/.test(document.querySelector('#micbtn').title))), `${state()} key=${mt.micIndicatorState()}`);
t('...and the VR key is its own (hot-synth)', mt.micIndicatorState() === 'hot-synth', mt.micIndicatorState());
analyserThrows = true;   // a synth lane sends whatever the provider writes: an unreadable level must not hide it
await pause('the analyser throws while the synth voice speaks: three glyph polls', 400);
t('synth voice speaking, the level unreadable: still gold (micGateInfo does not throw)', ms.roomHears() === true && gold(), state());
t('...and the unreadable level is told to the console, once (it is read at tick and frame rate)', levelWarns === 1, `${levelWarns} warnings in 0.4 s`);
analyserThrows = false;
// a synth frame stamped in the same millisecond as an unmute is the old side's
const realPerf = performance.now.bind(performance), realDate = Date.now;
const P = realPerf(), D = realDate();
playing = false;
performance.now = () => P; Date.now = () => D;
heardAt = STAMP();   // the provider's last sound, stamped this very millisecond
ms.toggleMute(true); ms.toggleMute(false);   // the boundary lands in the same millisecond
const sameMs = ms.micGateInfo().speaking;
performance.now = realPerf; Date.now = realDate;
t('a sound stamped in the same millisecond as an unmute does not count after it', sameMs === false, `speaking=${sameMs}`);
// the wall clock stepping back does not hold the synth hang open
playing = true;
await tryUntil('the synth lane gold again', () => gold());
playing = false;
Date.now = () => realDate() - 10000;   // the wall clock steps back 10 s, and runs on from there
const endsAnyway = await tryUntil('the synth hang ends after a wall-clock step', () => !gold(), { ms: 3000 });
const stepInfo = `${JSON.stringify(ms.micGateInfo())} heardAt=${heardAt} now=${Date.now()}`;
Date.now = realDate;
t('a wall-clock step back does not hold the synth hang open (its times are performance.now)', !!endsAnyway, `${state()} ${stepInfo}`);
synthOn = false; gumFails = false;
// the meter stops sampling while its panel is hidden, and survives a throw
await sfu.sfuMic(false); await sfu.sfuMic(true); negotiated(pc);
vc.setPttMode(false); room = 0.05;
await tryUntil('the bar moves', () => parseFloat(lvlNow.style.width) > 0);
fresh.style.display = 'none';
await pause('the hidden row sees itself hidden', 300);
const hiddenW = lvlNow.style.width; room = 0.2;
// the loop is still alive while hidden (it looks 4× a second): count the frames that ran, so "did not move" is not "did not run"
let hiddenFrames = 0;
const realRaf = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = (cb) => realRaf((ts) => { hiddenFrames++; cb(ts); });
await tryUntil('two frames of the hidden meter\'s loop', () => hiddenFrames >= 2, { ms: 3000 });
globalThis.requestAnimationFrame = realRaf;
t('the audio panel hidden: its meter stops sampling (the bar does not move), over frames that ran with the level changed',
  lvlNow.style.width === hiddenW && hiddenFrames >= 2, `${hiddenW} → ${lvlNow.style.width}, ${hiddenFrames} frames`);
fresh.style.display = '';
t('...and shown again, it resumes', !!(await tryUntil('the bar moves again', () => lvlNow.style.width !== hiddenW)), lvlNow.style.width);
room = 0.3;
await tryUntil('the gate open by level', () => gold());
gainLog.length = 0;
analyserThrows = true;
await pause('the analyser throws for a while', 300);
t('a level that cannot be read closes the gate: the gain is driven to 0 (not left open)',
  gainLog.length > 0 && gainLog.at(-1)[1] === 0, JSON.stringify(gainLog.slice(-3)));
analyserThrows = false; room = 0.02;
const wAfter = lvlNow.style.width;
t('the meter outlives a throwing analyser (its loop keeps going)', !!(await tryUntil('the bar moves after the throw', () => lvlNow.style.width !== wAfter)), lvlNow.style.width);
room = 0;
// the bar's two warnings each have their own once-a-minute: an unreadable level, just told, does not silence a meter that throws (finding 8 of #383's review)
await tryUntil('the bar dark again', () => !gold() && !barGoldNow(), { ms: 4000 });
{ const seen = [], w = console.warn;
  console.warn = (...a) => { const s = String(a[0]); if (/^\[audio panel\]/.test(s)) seen.push(s); else w(...a); };
  analyserThrows = true;
  await pause('frames with the level unreadable: told here, or in the last minute by the rows above', 100);
  analyserThrows = false;
  Object.defineProperty(lvlNow, 'style', { configurable: true, get() { throw new Error('no style'); } });   // sample() throws outside the level read
  await pause('frames with the meter throwing', 100);
  delete lvlNow.style;
  console.warn = w;
  t('a meter that throws within a minute of an unreadable level: the console is told of the throw too, once',
    seen.filter((s) => /the mic meter threw/.test(s)).length === 1, JSON.stringify(seen));
  const wBack = lvlNow.style.width; room = 0.02;
  t('...and the bar carries on after it', !!(await tryUntil('the bar moves after the meter threw', () => lvlNow.style.width !== wBack)), lvlNow.style.width);
  room = 0; }

// ── 10. round six: an unreadable level under the held key, a mute or mic-off is a cut, a stepped gain, a suspended context
await sfu.sfuMic(false); await sfu.sfuMic(true); negotiated(pc);
vc.setPttMode(true); room = 0.3; ms.setPttHeld(true);
t('setup: gold under the held key', !!(await tryUntil('gold under the key', () => gold())), state());
gainLog.length = 0; analyserThrows = true;
await pause('the analyser throws under the held key: three glyph polls', 400);
const heldGain = gainLog.filter((g) => g[0] === 'target' || g[0] === 'ramp').at(-1);
let heldInfo = null; try { heldInfo = ms.micGateInfo(); } catch { heldInfo = 'threw'; }
t('PTT held, the level unreadable: the gate stays open (the key decides) and the glyph says so: gold, micGateInfo does not throw',
  !!heldGain && heldGain[1] === 1 && heldInfo !== 'threw' && ms.roomHears() === true && gold(), `${JSON.stringify(gainLog.slice(-2))} ${state()}`);
t('...and the bar says so too: gold (an unreadable level empties the bar; it does not skip the gold read)', barGoldNow(), state());
analyserThrows = false; ms.setPttHeld(false); vc.setPttMode(false);
// a mute and the mic off are deliberate closes: cuts, not the voice-activation fade
room = 0.3;
await tryUntil('the gate open by level', () => gold());
gainLog.length = 0; ms.toggleMute(true);
const muteGain = gainLog.at(-1) || [];
t('voice activation open, then mute: the gain is cut at once (a ramp to 0 that starts now and ends at +5 ms)', atOnceCut(gainLog) && muteGain[0] === 'ramp', JSON.stringify(gainLog));
ms.toggleMute(false);
await tryUntil('open again', () => gold());
gainLog.length = 0; ms.setMicLive(false);
const offGain = gainLog.at(-1) || [];
t('voice activation open, then the device reported not live: the gain is cut', offGain[0] === 'ramp' && offGain[1] === 0 && offGain[2] <= 0.01, JSON.stringify(gainLog));
ms.setMicLive(true);
t('setup: open again by level', !!(await tryUntil('open again', () => gold())), state());
// a gain whose automation throws takes a step: there is no fade to call sending
gainThrows = true; gainLog.length = 0;
room = 1e-4;
const stepped = await tryUntil('the hang ends and the gain steps to 0', () => gainLog.some((g) => g[0] === 'step' && g[1] === 0), { ms: 3000 });
const sendingAfterStep = ms.roomHears();
gainThrows = false;
t('a gain that steps shut (automation refused) is shut: no phantom fade counted as sending', !!stepped && sendingAfterStep === false,
  `stepped=${!!stepped} roomHears=${sendingAfterStep} log=${JSON.stringify(gainLog.slice(-4))} micOn=${ms.micOn()} ptt=${vc.pttMode()} live=${ms.micDeviceLive()}`);
// a suspended AudioContext sends silence through the gate
vc.setPttMode(true); ms.setPttHeld(true);
await tryUntil('gold under the key', () => gold());
ctxState = 'suspended';
t('the AudioContext suspended: the gated lane sends nothing (no packets), so not gold', !!(await tryUntil('gold goes out', () => !gold() && ms.roomHears() === false)), state());
ctxState = 'running';
t('...and running again, gold again', !!(await tryUntil('gold back', () => gold())), state());
// suspended, the audio clock stops and the gain stays where it was, while the wall-clock model runs on toward open
ctxState = 'suspended';
if (gateGain) gateGain._v = 0.02;   // where the audio clock left it (the stub's automation lands at once; a real one would not)
gainLog.length = 0; ms.toggleMute(true);
const susCut = gainLog.find((g) => g[0] === 'set');
t('a cut while the context is suspended starts from the gain\'s own value (0.02), not the wall-clock model (~1): no burst on resume',
  !!susCut && Math.abs(susCut[1] - 0.02) < 1e-9, JSON.stringify(gainLog));
await pause('past the cut on the wall clock; the audio clock, suspended, has not run it', 30);
gainLog.length = 0; ms.toggleMute(false);
const susOpen = gainLog.slice();
const sc = susOpen.findIndex((g) => g[0] === 'cancel'), so = susOpen.findIndex((g) => g[0] === 'target' && g[1] === 1);
t('...and an open after it cancels that cut first (still scheduled on the stopped audio clock), or it would close the reopened gain on resume',
  sc >= 0 && so > sc, JSON.stringify(susOpen));
ctxState = 'running';
for (const fn of ctxListeners) fn();
await tryUntil('gold back', () => gold());
// a release while the context is suspended: the audio clock is stopped, so a hold of one lookahead on it would run only
// after resume, holding the word near full for 50 ms while gold (the context not running) is dark. With the clock stopped
// the cut starts at once instead: set at +0, ramp to 0 by +5 ms
ctxState = 'suspended';
if (gateGain) gateGain._v = 0.98;   // where the audio clock left the gain under the key
gainLog.length = 0; ms.setPttHeld(false);
const susRel = gainLog.slice(), susSet = susRel.find((g) => g[0] === 'set');
t('a release while the context is suspended: the cut starts at once (set at +0 from the gain, 0.98; ramp ends at +5 ms), no lookahead hold on the stopped clock',
  atOnceCut(susRel) && !!susSet && Math.abs(susSet[1] - 0.98) < 1e-9, JSON.stringify(susRel));
const susHears = ms.roomHears();
ctxState = 'running';
for (const fn of ctxListeners) fn();
const resHears = ms.roomHears();
t('...and no tail is reported going out, suspended or on resume: the stopped clock holds no word to send after it',
  susHears === false && resHears === false, `suspended=${susHears} resumed=${resHears} ${state()}`);
ms.setPttHeld(true);
await tryUntil('gold back under the key', () => gold());
// a suspend inside a release's tail, and a resume, with no 20 ms tick between them (throttled timers; here, one turn):
// the hold is scheduled on the audio clock, which the suspend stops, so on resume the held word would go out for the
// rest of the lookahead with the tail long over on the wall clock (no gold). The gate's own statechange listener cuts
// the pending tail the moment the context leaves 'running', from the gain's own value
await pause('the key held past the attack, so the release has an open gain to hold', 60);
// the rows from here to the resume are one turn inside the 55 ms tail: hold the clock, so a preempted process can't run the tail out under them
{ const heldAt = realPerf(); performance.now = () => heldAt; }
const tailRel = releaseKey(() => ms.setPttHeld(false));
const tailHeld = tailRel.atOnce.hears;   // the tail is going out: the context still runs
if (gateGain) gateGain._v = 0.97;        // where the audio clock holds the gain through the lookahead
gainLog.length = 0;
// first, a context the gate built for an earlier lane and has left suspends alone: its listener is still registered, and
// it must not cut the live lane's tail
const staleFn = ctxListeners[0];
ctxOwn.set(staleFn, 'suspended'); staleFn(); ctxOwn.delete(staleFn);
const staleLog = gainLog.slice(), staleHears = ms.roomHears();
t('a context the gate has left (an earlier lane\'s) suspends during the live lane\'s tail: its listener cuts nothing, and the tail still goes out',
  ctxListeners.length > 1 && staleFn !== ctxListeners.at(-1) && staleLog.length === 0 && staleHears === true,
  `listeners=${ctxListeners.length} hears=${staleHears} ${JSON.stringify(staleLog)}`);
ctxState = 'suspended';
for (const fn of ctxListeners) fn();     // every context the gate ever built says its state changed: only the live one acts
const tailSus = gainLog.slice(), tailSet = tailSus.find((g) => g[0] === 'set');
t('a suspend inside a release\'s tail, no tick: the pending hold is cut at once (set at +0 from the gain, 0.97; ramp ends at +5 ms), once, however many contexts and lanes were built',
  tailHeld === true && atOnceCut(tailSus) && !!tailSet && Math.abs(tailSet[1] - 0.97) < 1e-9
  && tailSus.filter((g) => g[0] === 'cancel').length === 1 && tailSus.length === 3, `held=${tailHeld} ${JSON.stringify(tailSus)}`);
ctxState = 'running';
gainLog.length = 0;
for (const fn of ctxListeners) fn();
const tailRes = ms.roomHears(), tailResLog = gainLog.slice();
performance.now = realPerf;
t('...and on resume, still inside the 55 ms on the wall clock, no tail is reported going out and nothing reopens the gain: only the cut\'s 5 ms ramp is left',
  tailRes === false && tailResLog.length === 0, `resumed=${tailRes} ${JSON.stringify(tailResLog)} ${state()}`);
const tailEnd = await tailRel.closed();
t('...and the watch on that tail still ends (audio:ptt-tail-end, not late), so the indicators repaint dark',
  !!tailEnd && !tailEnd.late && tailEnd.hears === false && tailEnd.gold === false, `${JSON.stringify(tailEnd)} ${state()}`);
ms.setPttHeld(true);
await tryUntil('gold back under the key', () => gold());
// push-to-talk turned off inside a release's tail: the cut stays a cut (driven again as a plain close it became voice
// activation's fade, ~830 ms of whatever the room said next)
await pause('the key held past the attack', 60);
room = 1e-4;   // under the line: voice activation, once it decides, says closed
gainLog.length = 0;
const offInTail = releaseKey(() => { ms.setPttHeld(false); vc.setPttMode(false); });
const offTailEnd = await offInTail.closed();
await pause('three of voice activation\'s ticks, each a plain close', 70);
t('push-to-talk turned off inside the release tail: the cut is not rescheduled as a fade (one hold, one ramp, no setTargetAtTime to 0), and the room stops hearing with the tail',
  closedOnTime(offTailEnd) && offTailEnd.hears === false && ms.roomHears() === false
  && gainLog.filter((g) => g[0] === 'ramp').length === 1 && gainLog.length === 3 && !gainLog.some((g) => g[0] === 'target'),
  `${JSON.stringify(offTailEnd)} ${JSON.stringify(gainLog)}`);
// a suspend during the voice-activation release fade: the audio clock stops with the gain part-way down, the wall clock
// runs on; on resume the gain carries on from where it stopped, and sound goes out
room = 0.3;
t('setup: the gate open by level (for the suspend)', !!(await tryUntil('the gate open by level', () => gold())), state());
gainLog.length = 0; room = 1e-4;
t('setup: the release fade begins', !!(await tryUntil('the fade is scheduled', () => gainLog.some((g) => g[0] === 'target' && g[1] === 0 && g[2] >= 0.1), { ms: 3000 })));
ctxState = 'suspended';
await pause('suspended past the whole fade on the wall clock', 1000);
// where the audio clock left the gain (the reviewer's measurement); set here because this stub's automation lands at
// once, where a real param stays put while its context is suspended
if (gateGain) gateGain._v = 0.371;
ctxState = 'running';
for (const fn of ctxListeners) fn();   // the context says it runs again
const sendingOnResume = ms.roomHears();
t('resumed mid-fade: the gain is still at 0.37 and fading, so the lane counts as sending (gold), not dark',
  sendingOnResume === true && !!(await tryUntil('gold on resume', () => gold())), `roomHears=${sendingOnResume} ${state()}`);
t('...and gold ends once that fade has closed', !!(await tryUntil('the resumed fade closes', () => !gold() && ms.roomHears() === false, { ms: 4000 })), state());
room = 0;
// a synth voice with the mic off, muted by a moderator (Winifred's third-family review): the tooltip names the mute
synthOn = true; gumFails = false;
await sfu.sfuMic(false); negotiated(pc);   // mic off with a provider: the synth lane
playing = true;
t('setup: the synth voice going out with the mic off (gold, waves)', !!(await tryUntil('synth gold', () => gold() && waves())), state());
bus.emit('your-rights', { role: 'member', muted: { channels: ['voice'], until: null } });
playing = false;   // the word the server is now dropping ends here
t('a synth voice, the mic off, muted by a moderator: not gold, and the tooltip names the moderator, not "V to talk"',
  !!(await tryUntil('the tooltip names the moderator', () => !gold() && /moderator has muted/.test(document.querySelector('#micbtn').title)
    && !/V to talk|arm push-to-talk/.test(document.querySelector('#micbtn').title))), state());
bus.emit('your-rights', { role: 'member' });   // lifted inside the 700 ms hang
const goldAfterLift = ms.roomHears();
t('the mute lifted inside the synth hang: the word the server dropped does not turn gold after it', goldAfterLift === false, `roomHears=${goldAfterLift}`);
synthOn = false;
await sfu.sfuMic(true); negotiated(pc); vc.setPttMode(false);
// releasing the microphone is a deliberate close too
room = 0.3;
t('setup: the gate open by level', !!(await tryUntil('the gate open by level', () => gold())), state());
gainLog.length = 0; ms.releaseMicrophone();
const relGain = gainLog.at(-1) || [];
t('releaseMicrophone: the gain is cut, not faded', relGain[0] === 'ramp' && relGain[1] === 0 && relGain[2] <= 0.01, JSON.stringify(gainLog));
room = 0;

// ── 11. the follow-up to #349's automatic review (of 659ed6343): each row was red before its fix ─────────────────────
// (8) a lane the transport turned off, then its microphone released: a new device gated into it comes back on
{ const laneTr = pc.tx[0].sender.track;
  ms.setLaneEnabled(false);
  const wasOff = laneTr.enabled === false;
  const again = ms.gateFor(new FakeStream([mkTrack('device-2')])); ms.setMicLive(true);
  t('a lane the transport turned off, its microphone released: a new device gated into it is the same track, on again',
    wasOff && again?.getTracks?.()[0] === laneTr && laneTr.enabled === true, `wasOff=${wasOff} same=${again?.getTracks?.()[0] === laneTr} enabled=${laneTr.enabled}`); }
// (23) voice activation's hang runs on a monotonic clock: the wall clock stepping back does not hold the mic open
room = 0.3;
t('setup: the gate open by level', !!(await tryUntil('the gate open by level', () => gold())), state());
{ const wall = Date.now; Date.now = () => wall() - 30000;   // the wall clock steps back 30 s, and runs on from there
  room = 1e-4;
  const shut = await tryUntil('the hang and the fade end', () => ms.roomHears() === false, { ms: 4000 });
  Date.now = wall;
  t('a wall-clock step back of 30 s inside the hang: the gate still closes on time (it does not send quiet sound for 30 s more)', !!shut, state()); }
// (9) one announcement, every indicator: while the bar shows, what its frame sees first is told, and the glyph, the menus
// and the VR indicator all show it by the end of that turn; the VR indicator keeps no clock of its own
{ const told = [];
  const offHears = bus.on('mic:hears', (hot) => told.push({ hot, hud: gold(), bar: barGoldNow() }));
  const offInd = bus.on('mic:indicator', () => afterTurn('announce'));
  watchTurns = true; turns.length = 0;
  room = 0.3;
  await tryUntil('gold by level, in VR too', () => gold() && xrGold() && xrShows());
  room = 1e-4;
  await tryUntil('dark again, in VR too', () => !gold() && !xrGold() && xrShows(), { ms: 4000 });
  watchTurns = false; offHears(); offInd();
  t('the bar tells what its frame sees (mic:hears), and the glyph is painted with it in that turn: an open and a close, the two agreeing each time',
    told.some((x) => x.hot) && told.some((x) => !x.hot) && told.every((x) => x.hud === x.hot && x.bar === x.hot), JSON.stringify(told));
  t('the HUD glyph and the VR indicator change in one turn: after every turn that painted either, both show the same gold',
    turns.some((x) => x.who === 'vr') && turns.some((x) => x.who === 'announce') && turns.every((x) => x.hud === x.vr), JSON.stringify(turns)); }
room = 0;
// (3) a suspend and a resume the main thread hears of together, late: the statechange reads 'running', and the tail is cut all the same
vc.setPttMode(true); ms.setPttHeld(true);
await tryUntil('gold under the key', () => gold());
await pause('the key held past the attack', 60);
{ const heldAt = realPerf(); performance.now = () => heldAt;   // one turn inside the tail, on a held clock
  const rel = releaseKey(() => ms.setPttHeld(false));
  if (gateGain) gateGain._v = 0.96;   // where the audio clock holds the gain through the lookahead
  gainLog.length = 0;
  for (const fn of ctxListeners) fn();   // the context says its state changed, and it reads 'running'
  const log = gainLog.slice(), set = log.find((g) => g[0] === 'set'), hears = ms.roomHears();
  performance.now = realPerf;
  t('a statechange inside a release\'s tail that reads "running": the pending hold is cut at once from the gain\'s own value (0.96), and no tail is reported',
    rel.atOnce.hears === true && atOnceCut(log) && !!set && Math.abs(set[1] - 0.96) < 1e-9 && hears === false, `${JSON.stringify(log)} hears=${hears}`);
  await rel.closed(); }
// (the measurement on #349) the close of a tail is seen by a frame as well as by its timer: with the timer running late
// (a loaded main thread: 5 to 24 ms in Chrome), the indicators are still told as the tail ends
ms.setPttHeld(true);
await tryUntil('gold under the key', () => gold());
{ const realST = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms_, ...a) => realST(fn, ms_ >= 50 && ms_ <= 58 ? ms_ + 400 : ms_, ...a);   // the tail's own timer (56 ms), 400 ms late
  const rel = releaseKey(() => ms.setPttHeld(false));
  const end = await rel.closed();
  globalThis.setTimeout = realST;
  t(`the tail's timer 400 ms late: a frame still tells its end on time (${TAIL_MS} ms on, before a ${TAIL_LATE_MS} ms timer armed at the release), and the gold goes then`,
    closedOnTime(end) && end.ms < 400 && end.gold === false && end.hears === false, `${JSON.stringify(end)} ${state()}`); }
// ...and a timer tells it where no frame comes (a hidden tab)
ms.setPttHeld(true);
await tryUntil('gold under the key', () => gold());
{ const realRaf = globalThis.requestAnimationFrame, waiting = [];
  globalThis.requestAnimationFrame = (cb) => (waiting.push(cb), 0);   // no frame is called until the tab shows again
  const rel = releaseKey(() => ms.setPttHeld(false));
  const end = await rel.closed();
  globalThis.requestAnimationFrame = realRaf;
  for (const cb of waiting) realRaf(cb);   // shown again: the loops that were waiting carry on (the bar's among them)
  t('no frames at all (a hidden tab): the tail\'s timer still tells its end on time, and the gold goes then',
    closedOnTime(end) && end.gold === false && end.hears === false, `${JSON.stringify(end)} ${state()}`); }
vc.setPttMode(false);
// (1, 5) a device that cannot build the gate: the sensitivity and push-to-talk hints say what the raw lane does
const hintOf = (re) => [...document.querySelectorAll('#sec-audio [title]')].map((e) => e.title).find((x) => re.test(x)) || '';
const floorTip = () => document.querySelector('#sec-audio [data-meter]')?.title || '';
const pttTip = () => hintOf(/^transmit only while the push-to-talk key/);
const ungatedBox = [...document.querySelectorAll('#sec-audio .sp-row')].find((r) => /transmit UNGATED/.test(r.textContent))?.querySelector('input');
synthOn = true; await sfu.sfuMic(false);   // onto the synth lane, so the next mic-on builds a lane afresh
noGate = true; synthOn = false;
await sfu.sfuMic(true);                    // the gate cannot be built, and nothing was consented: refused
t('the gate cannot be built, nothing consented: the sensitivity hint says the marker is not in use and the mic sends nothing until "transmit UNGATED" is ticked',
  !!(await tryUntil('the refused-gate hint', () => ms.gateIsUnavailable() && /could not be built on this device, so the white marker is not in use and your microphone sends nothing unless you tick/.test(floorTip()), { ms: 3000 }))
  && !/opens your mic/.test(floorTip()), floorTip());
// the refused attempt turned the mic off, so the tick alone would send nothing (finding 6 of #383's review)
t('...and that the tick is not all: the refused attempt left the mic off, and the hint says to turn it on again after ticking',
  mt.micLive() === false && /unless you tick ‘transmit UNGATED’ below, and then turn the microphone on again \(the attempt that could not build the gate left it off\); /.test(floorTip()), `micLive=${mt.micLive()} ${floorTip()}`);
ungatedBox.checked = true; ungatedBox.dispatchEvent(new Event('change'));   // the person's own tick
t('"transmit UNGATED" ticked: the hint changes in that turn, and no longer says sound under the marker is not sent',
  ms.ungatedAllowed() === true && /you chose to transmit ungated: the white marker holds nothing back, so everything your microphone picks up is sent while the mic is on/.test(floorTip())
  && !/is not sent as voice|opens your mic/.test(floorTip()), floorTip());
await sfu.sfuMic(true); negotiated(pc);
room = 1e-4;   // far under the marker
t('...and it is true: on the consented raw lane, sound far under the marker is going out (gold), which is what the hint now says',
  !!(await tryUntil('the raw lane goes gold under the line', () => gold() && barGoldNow())) && /holds nothing back/.test(floorTip()), `${state()} ${floorTip()}`);
t('...and the push-to-talk hint promises no 50 ms tail there: the raw track is switched off at once',
  !!(await tryUntil('the raw lane\'s push-to-talk hint', () => /Release the key and your mic cuts off at once \(this device has no lookahead/.test(pttTip()), { ms: 2000 }))
  && !/50 ms/.test(pttTip()), pttTip());
// back to a device that can build the gate: the words follow the lane, with no event of their own
ungatedBox.checked = false; ungatedBox.dispatchEvent(new Event('change'));
t('the tick taken back with the mic still on: the hint asks for the tick alone (the mic is on already)',
  mt.micLive() === true && /sends nothing unless you tick ‘transmit UNGATED’ below; /.test(floorTip()), `micLive=${mt.micLive()} ${floorTip()}`);
synthOn = true; await sfu.sfuMic(false); noGate = false; synthOn = false;
await sfu.sfuMic(true); negotiated(pc);
t('the gate built again: both hints are the gated lane\'s again (the marker keeps quiet sound in; a release has its 50 ms tail)',
  !!(await tryUntil('the gated hints', () => /sound under it the rest of the time is not sent as voice/.test(floorTip()) && /cuts off 50 ms later/.test(pttTip()), { ms: 3000 })),
  `${floorTip()} | ${pttTip()}`);
room = 0;
// (10) the lane swapped for a quiet synth one with nothing else changing (no event, mic intent still on, not gold before or
// after): the glyph's poll still repaints the words. Last, because it goes under the transport.
await tryUntil('quiet, mic on: the plain words', () => /^mic on \(V to turn off\)/.test(tip()));
{ const quiet = new FakeStream([mkTrack('quiet-synth')]); quiet.synthetic = true; quiet.audibleAt = () => 0;
  ms.gateFor(quiet);
  t('a quiet device lane replaced by a quiet synth lane, no event: the tooltip is repainted to say no microphone is open',
    !!(await tryUntil('the swapped lane\'s tooltip', () => /^mic on, but no microphone is open/.test(tip()), { ms: 2000 })), tip()); }

console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
