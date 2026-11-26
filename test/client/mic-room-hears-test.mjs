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
const node = () => ({ connect() {}, disconnect() {} });
const mkTrack = (label) => ({ kind: 'audio', label, enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; } });
class FakeStream { constructor(tracks) { this._t = tracks; } getTracks() { return this._t; } getAudioTracks() { return this._t; } }
globalThis.MediaStream = FakeStream;
Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: { getUserMedia: async () => new FakeStream([mkTrack('device')]) }, configurable: true });
mock.module(lib('audio/audioctx.js'), () => ({
  audioContext: () => ({
    currentTime: 0, sampleRate: 48000, state: 'running', destination: node(),
    createAnalyser: () => ({ ...node(), fftSize: 0, getFloatTimeDomainData(buf) { buf.fill(room); } }),
    createMediaStreamSource: () => node(),
    createGain: () => ({ ...node(), gain: { value: 0, setTargetAtTime(v) { this.value = v; } } }),
    createDelay: () => ({ ...node(), delayTime: { value: 0, setTargetAtTime() {} } }),
    createMediaStreamDestination: () => ({ ...node(), stream: new FakeStream([mkTrack('gated')]) }),
  }),
}));
const netSrc = readFileSync(lib('net.js'), 'utf8');
const NET = [...netSrc.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
for (const m of netSrc.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const n of m[1].split(',')) { const k = n.trim().split(/\s+as\s+/).pop(); if (k) NET.push(k); }
const net = { joined: false, myRights: null };
mock.module(lib('net.js'), () => ({ ...Object.fromEntries(NET.filter(n => n !== 'net').map(n => [n, () => {}])), net }));
mock.module(lib('audio/stt.js'), () => ({ setSTT() {}, sttAvailable: () => false, sttOn: () => false }));
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
      set opacity(v) { this._o = v; xrPairs.push({ gold: (xrPaints.at(-1) || '').includes('drop-shadow'), opacity: v }); }
      get opacity() { return this._o; } },
    Mesh: class extends Obj { constructor(g, m) { super(); this.material = m; } } },
  camera: new Obj(), renderer: {},
}));
mock.module(lib('xr/quadcolour.js'), () => ({ quadMaterial() {} }));
HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, beginPath() {}, arc() {}, fill() {}, drawImage() {} });
globalThis.Image = class { set src(v) { xrPaints.push(decodeURIComponent(v.replace(/^data:image\/svg\+xml;utf8,/, ''))); } };
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
setInterval(() => { if (playing) heardAt = Date.now(); }, 10);

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
const xrLast = () => xrPaints.at(-1) || '';
const xrShows = () => xrLast() === mt.micIndicatorSvg(84);
// the indicator's SVG goes to the headset as a standalone data:image/svg+xml, which is XML: every attribute needs a value
// (a bare `data-x`, fine in the HUD's innerHTML, makes the image fail to load in VR)
const xmlAttrsOk = (svg) => [...svg.matchAll(/<([^>]+)>/g)].every(([, tag]) =>
  /^\/?[\w:-]+\/?$/.test(tag.replace(/\s+[\w:-]+="[^"]*"/g, '').replace(/\s*\/$/, '/').trim()));
const xrState = () => `xr key=${mt.micIndicatorState()} paints=${xrPaints.length} lastSlash=${xrLast().includes('x1="7" y1="4"')} current=${xrShows()}`;
const POLLS = 'three glyph polls and many bar frames';

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
t('muted carries no synth waves (only a synth voice going out with the mic off does)', !waves(), state());
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
playing = false; heardAt = Date.now() - 5; room = 0;   // the voice stops just before the mute
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
window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyV' }));
t('PTT keyup: not gold in the same turn (the paint reads roomHears live, not the last poll)',
  ms.roomHears() === false && !gold() && /push-to-talk armed/.test(document.querySelector('#micbtn').title), state());
ms.setPttHeld(true);
await tryUntil('gold again under the key, in VR too', () => gold() && xrShows() && xrGold());
ms.setPttHeld(false);   // the XR controller's A/X release (xr.js): setPttHeld alone, no key event
t('VR controller release: the indicator and the HUD glyph drop gold in the same turn, with no tick', !xrGold() && xrShows()
  && mt.micIndicatorState() === 'on' && !gold(), `${state()} ${xrState()}`);
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
const pttHint = [...document.querySelectorAll('#sec-audio [title]')].map((e) => e.title).find((x) => /transmit only while V/.test(x)) || '';
t('the push-to-talk hint says the voice stops going out at once and only the sound fades',
  /stops going out at once/.test(pttHint) && !/after a short fade/.test(pttHint), pttHint);
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
await pause(`the answer flipping on every read: ${POLLS} and the VR ticks`, 600);
const pairs = xrPairs.slice(pairsFrom);
t('in VR, each paint takes its look and its glyph from one read: gold is drawn only at the hot look',
  pairs.length > 0 && pairs.every((p) => !p.gold || p.opacity === 1) && pairs.every((p) => p.opacity !== 0.45 || !p.gold),
  JSON.stringify(pairs.slice(0, 6)));
// roomHears() throwing on every call
Object.defineProperty(laneTrack, 'enabled', { configurable: true, get() { throw new Error('a track that throws'); }, set() {} });
await pause('the throw lands on a poll and a paint', 300);
let huds = 0;
const mo = new MutationObserver(() => huds++);
mo.observe(document.querySelector('#micbtn'), { childList: true });
await pause(`roomHears throwing: ${POLLS}`, 1000);
mo.disconnect();
t('roomHears throwing: the HUD glyph is not repainted on every poll (and shows not gold)', huds <= 1 && !gold(), `${huds} paints in 1 s; ${state()}`);
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
oldLvl.style.background = 'rgb(1, 2, 3)';   // a sentinel only a live listener on the old row would overwrite
ms.toggleMute(true); ms.toggleMute(false); bus.emit('audio:mic', true); bus.emit('audio:micfloor');
t('the panel rebuilt: the detached row no longer listens (its sentinel stands), the new row does',
  oldLvl.style.background === 'rgb(1, 2, 3)' && !!newLvl && newLvl !== oldLvl, `old=${oldLvl.style.background}`);

console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
