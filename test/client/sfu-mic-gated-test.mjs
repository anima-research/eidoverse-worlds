// The SFU transport publishes the GATED stream, never the raw device. The gate is the privacy control: mute,
// push-to-talk and the noise gate all act on the gain between the device and the wire (micgate.js), so a publish of the
// raw device would let a muted person be heard. sfu-mic-intent-race runs only the consented ungated lane, where the
// published track IS the device track, so it can't tell the two apart; this suite runs the gated lane.
//
// Stubbed: the browser boundary (RTCPeerConnection, and a WebAudio context whose MediaStreamDestination yields a track
// of its own, distinct from the device's), voiceSource() as a deferred acquisition the test resolves by hand, and
// net.js, ui/chat.js and audiounlock.js as no-ops. voicesfu.js, micstate.js and micgate.js are the shipped modules, and
// ungated consent is never given, so a gate that failed to build refuses the publish (the setup rows catch that).
// Each of the three ways a track reaches a sender (bare addTrack, our own sendonly sender, the inactive floor) is a lane;
// a transceiver is named by its role, so a lane says which branch chose it, and lane B offers the floor first.
//
// Run: bun test/client/sfu-mic-gated-test.mjs
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });
const M = (p) => fileURLToPath(new URL(`../../client/lib/${p}`, import.meta.url));
mock.module(M('net.js'), () => ({ sendTyping: () => {}, requestHistory: () => {} }));
mock.module(M('ui/chat.js'), () => ({ logChat: () => {} }));
mock.module(M('audio/audiounlock.js'), () => ({ playWhenAllowed: () => {} }));
const mkTrack = (label) => ({ kind: 'audio', label, enabled: true, readyState: 'live', stopped: false, stop() { this.stopped = true; } });
const mkStream = (tr) => ({ track: tr, getTracks: () => [tr], getAudioTracks: () => [tr] });
const node = () => ({ connect() {}, disconnect() {} });
const param = () => ({ value: 0, setTargetAtTime(v) { this.value = v; } });
// every gate graph built: its destination's stream is what the gate hands the transport
const gated = [];
mock.module(M('audio/audioctx.js'), () => ({
  audioContext: () => ({
    currentTime: 0, sampleRate: 48000, state: 'running', destination: node(),
    createAnalyser: () => ({ ...node(), fftSize: 0, getFloatTimeDomainData() {} }),
    createMediaStreamSource: () => node(),
    createGain: () => ({ ...node(), gain: param() }),
    createDelay: () => ({ ...node(), delayTime: param() }),
    createMediaStreamDestination: () => { const stream = mkStream(mkTrack('gated')); gated.push(stream); return { ...node(), stream }; },
  }),
}));
const acquisitions = [];
mock.module(M('audio/voicesource.js'), () => ({
  synthProvider: () => null,
  voiceSource: ({ micWanted = true } = {}) => new Promise((resolve, reject) => acquisitions.push({ micWanted, resolve, reject })),
}));
// the transceivers the next pc starts with; every track handed to any sender is recorded in `handed`
let nextTransceivers = () => [], lastPc = null;
const handed = [];
class FakePC {
  constructor() { this.connectionState = 'new'; this.iceConnectionState = 'new'; this.tx = nextTransceivers(); lastPc = this; }
  getTransceivers() { return this.tx; }
  addTrack(track, stream) { handed.push({ via: 'addTrack', track, stream }); }
  close() {}
}
const mkTx = (role, direction, currentDirection) => ({
  role, direction, currentDirection,
  sender: { replaceTrack: async (track) => { handed.push({ via: `replaceTrack(${role})`, track }); } },
});
globalThis.RTCPeerConnection = FakePC;

const mg = await import('../../client/lib/audio/micgate.js');
const sfu = await import('../../client/lib/audio/voicesfu.js');

let ok = 0, bad = 0;
const t = (n, cond) => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}`); };
const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: a publish never settled');
  console.log(`\n${ok} ok, ${bad + 1} failed`);
  process.exit(1);
}, 5000);
const flush = () => new Promise((r) => setImmediate(r));

async function lane(name, transceivers, via, after = null) {
  nextTransceivers = transceivers;
  await sfu.sfuConnect({}, () => {});
  const h0 = handed.length, g0 = gated.length, a0 = acquisitions.length;
  const p = sfu.sfuMic(true);
  while (acquisitions.length === a0) await flush();   // the publish imports voiceSource first; the watchdog bounds this
  const device = mkStream(mkTrack('device'));
  acquisitions[a0]?.resolve(device);
  await p; await flush();
  const mine = handed.slice(h0);
  // setup: the gated lane really ran, and exactly one track went to a sender by the path this lane is about
  t(`${name}: setup — one acquisition, the gate graph was built, no ungated consent`, acquisitions.length === a0 + 1
    && gated.length === g0 + 1 && mg.gateUnavailable() === false && mg.ungatedConsent() === false);
  t(`${name}: setup — exactly one track was handed to a sender, via ${via}`, mine.length === 1 && mine[0].via === via);
  const gatedTrack = gated[g0]?.getTracks()[0];
  t(`${name}: the track on the wire is the gate's, not the device's`, !!gatedTrack && mine[0]?.track === gatedTrack
    && mine[0]?.track !== device.track);
  if (via === 'addTrack') t(`${name}: …and the stream handed with it is the gated stream`, mine[0]?.stream === gated[g0]);
  if (after) t(`${name}: ${after[0]}`, after[1]());
  await sfu.sfuMic(false);
}

await lane('A solo (bare addTrack)', () => [], 'addTrack');
await lane('B our own sendonly sender', () => [mkTx('floor', 'inactive', 'inactive'), mkTx('owned', 'sendrecv', 'sendonly')], 'replaceTrack(owned)',
  ['…and the floor offered before it is left alone', () => lastPc.tx[0].direction === 'inactive']);
await lane('C the inactive floor', () => [mkTx('floor', 'inactive', 'inactive')], 'replaceTrack(floor)',
  ['…and the floor is turned sendonly', () => lastPc.tx[0].direction === 'sendonly']);

clearTimeout(watchdog);
console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
