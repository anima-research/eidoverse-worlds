// The mic glyph and the sensitivity bar go gold when the room can hear you, and only then — through the real transport.
// micstate.js roomHears() is the one answer: the lane is sending (the gate, the held key, mute, a synth voice), its track
// is on, voicesfu.js carries it on a connected peer connection, and no moderator has muted you (voicesfubridge.js).
// mictoggle-glyph-test.mjs and mic-meter-gate-test.mjs run the gate's side; this runs the transport's.
//
// Real: voicesfu.js, voicesfubridge.js, micstate.js, micgate.js, voiceconsent.js, voicesource.js, mictoggle.js,
// audiopanel.js. Stubbed at the browser boundary: RTCPeerConnection (a transceiver list whose negotiated direction the
// test sets), MediaStream and getUserMedia, an AudioContext whose analyser hears `room`, and a synth provider that keeps
// its own record of when it last wrote an audible frame (as tts.js's pacer does). net.js, ui.js, chat.js, stt.js,
// ttsrow.js, audiounlock.js and the player modules are no-ops.
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
mock.module(lib('ui/ui.js'), () => ({
  flashHint: () => {},
  makeSection: (title, build, opts = {}) => { const el = document.createElement('div'); el.id = `sec-${opts.id}`; document.body.appendChild(el); build(el); return el; },
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

let ok = 0, bad = 0;
const t = (n, cond, d = '') => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}${cond ? '' : `  — ${d}`}`); };
const glyph = () => document.querySelector('#micbtn')?.innerHTML || '';
const gold = () => glyph().includes('drop-shadow');
const slashed = () => glyph().includes('x1="7" y1="4"');
const lvl = document.querySelector('#sec-audio [data-lvl]');
const GOLD = /255, 214, 107|#ffd66b/i;
const barGold = () => GOLD.test(lvl.style.background);
const state = () => `glyph gold=${gold()} slash=${slashed()} bar=${lvl.style.background} title="${document.querySelector('#micbtn')?.title}"`;
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
negotiated(pc); pc.connectionState = 'connected'; pc.iceConnectionState = 'connected';
t('setup: connected and negotiated, the open lane turns both gold',
  !!(await tryUntil('the carried lane goes gold', () => gold() && barGold())), state());
pc.connectionState = 'failed'; pc.iceConnectionState = 'failed';
t('ICE fails under an open gate: the gold goes out', !!(await tryUntil('a failed connection leaves gold', () => !gold() && !barGold())), state());
pc.connectionState = 'connected'; pc.iceConnectionState = 'connected';
await tryUntil('gold again once connected', () => gold());

// ── 2. muted: the icon says so (Winifred's third point), and a moderator's mute is a mute ──────────────────────────
ms.toggleMute(true);
await tryUntil('the glyph repaints for the mute', () => !gold() && slashed());
t('muted: the glyph is not the ordinary on icon (it carries the slash), and not gold',
  !gold() && slashed() && glyph() !== mt.micGlyphFor(true, false), state());
t('muted: its tooltip says the room hears nothing', /muted/.test(document.querySelector('#micbtn').title), state());
ms.toggleMute(false);
await tryUntil('unmuted, gold again', () => gold() && !slashed());
bus.emit('your-rights', { role: 'member', muted: { channels: ['voice'], until: null } });
await pause(`a moderator's voice mute (the SFU drops us at ingress): ${POLLS}`, 400);
t("moderator voice mute: not gold, though the lane is open (the server drops it)", !gold() && !barGold(), state());
t('...the glyph shows the mute and the tooltip names the moderator',
  slashed() && /moderator/.test(document.querySelector('#micbtn').title), state());
bus.emit('your-rights', { role: 'member' });
t('the moderator lifts it: gold again', !!(await tryUntil('gold after the lift', () => gold() && barGold())), state());
ms.setPttHeld(false); vc.setPttMode(false);

// ── 3. a synth voice published with the mic off (finding 2), heard on a stalled analyser (finding 1) ───────────────
synthOn = true;
await sfu.sfuMic(false);   // mic off with a provider: the swap publishes the synth lane, wantMic = false (it settles later)
const synthLane = await tryUntil('the swap put the synth track on the sender', () => synthTracks.length && pc.tx[0].sender.track === synthTracks.at(-1) && synthTracks.at(-1));
t('setup: the synth lane is on the sender, with mic intent off, and nothing gold yet', !!synthLane && sfu.sfuMicOn() === false
  && !!(await tryUntil('a silent synth lane is not gold', () => !gold() && !barGold())), state());
room = 0.3; playing = true;
t('TTS speaking with the mic off: the glyph is gold (the room hears it)', !!(await tryUntil('the synth voice goes gold', () => gold())), state());
t('...and so is the bar', !!(await tryUntil('the bar agrees', () => barGold())), state());
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

console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
