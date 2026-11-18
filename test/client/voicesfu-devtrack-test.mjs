// voicesfu, executed: the raw mic DEVICE stops whenever the transport stops holding it, so the browser's mic indicator
// goes out. Under a gated publish the stream on the wire is the gate's destination, and the device feeding it is a
// separate stream; each row is a way the transport lets go of the device: a reconnect, a swap to the synth voice, a
// refusal because the gate could not be built, and an acquisition a reconnect superseded, which must also leave the live
// session's device and micstate alone.
//
// Stubbed: the browser boundary (RTCPeerConnection, and a WebAudio context whose MediaStreamDestination yields a track
// of its own, or none while `noGate` is set), voiceSource() as a deferred acquisition the test resolves by hand, the
// synth provider, and net.js, ui/chat.js and audiounlock.js as no-ops. voicesfu.js, micstate.js, micgate.js and
// voiceconsent.js are the shipped modules.
//
// Run: bun test/client/voicesfu-devtrack-test.mjs
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
const gated = [];
let noGate = false;   // true: the context has no createMediaStreamDestination, so the gate refuses to build
mock.module(M('audio/audioctx.js'), () => ({
  audioContext: () => ({
    currentTime: 0, sampleRate: 48000, state: 'running', destination: node(),
    createAnalyser: () => ({ ...node(), fftSize: 0, getFloatTimeDomainData() {} }),
    createMediaStreamSource: () => node(),
    createGain: () => ({ ...node(), gain: param() }),
    createDelay: () => ({ ...node(), delayTime: param() }),
    ...(noGate ? {} : {
      createMediaStreamDestination: () => { const stream = mkStream(mkTrack('gated')); gated.push(stream); return { ...node(), stream }; },
    }),
  }),
}));
const acquisitions = [];
let provider = null;
mock.module(M('audio/voicesource.js'), () => ({
  synthProvider: () => provider,
  voiceSource: ({ micWanted = true } = {}) => new Promise((resolve, reject) => acquisitions.push({ micWanted, resolve, reject })),
}));
const added = [];   // every track handed to addTrack, in order
globalThis.RTCPeerConnection = class { constructor() { this.connectionState = 'new'; } getTransceivers() { return []; } addTrack(t) { added.push(t); } close() {} };

const sfu = await import('../../client/lib/audio/voicesfu.js');
const mic = await import('../../client/lib/audio/micstate.js');

let ok = 0, bad = 0;
const t = (n, cond) => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}`); };
const watchdog = setTimeout(() => { console.log(`FAIL watchdog: a publish never settled\n\n${ok} ok, ${bad + 1} failed`); process.exit(1); }, 5000);
const flush = () => new Promise((r) => setImmediate(r));
/** The next acquisition voicesfu asks for; the publish imports voiceSource first, and the watchdog bounds this. */
async function nextAcquisition(a0) { while (acquisitions.length === a0) await flush(); return acquisitions[a0]; }

/** Publish a device on the gated lane, run `between`, reconnect: the device must be stopped. */
async function lane(name, between) {
  await sfu.sfuConnect({}, () => {});
  const a0 = acquisitions.length, g0 = gated.length;
  const p = sfu.sfuMic(true);
  const device = mkStream(mkTrack('device'));
  (await nextAcquisition(a0)).resolve(device);
  await p;
  t(`${name}: setup — the gated lane published (addTrack got the live gate track, the device under it is live)`,
    gated.length === g0 + 1 && added.at(-1) === gated[g0].track && !gated[g0].track.stopped && !device.track.stopped);
  await between(device);
  await sfu.sfuConnect({}, () => {});
  t(`${name}: a reconnect stops the device track, not only the gate's`, device.track.stopped && gated[g0].track.stopped);
}

await lane('mic on', async () => {});
t('mic on: the reconnect tells micstate the device stopped', !mic.micDeviceLive() && !mic.micOn());
await lane('mic off (no synth provider)', () => sfu.sfuMic(false));
await lane('mic off (synth provider)', async (device) => {
  provider = { available: () => true };
  const a0 = acquisitions.length;
  await sfu.sfuMic(false);                       // returns before the swap's publish settles
  const synth = Object.assign(mkStream(mkTrack('synth')), { synthetic: true });
  (await nextAcquisition(a0)).resolve(synth);
  while (added.at(-1) !== synth.track) await flush();
  t('mic off (synth provider): the swap to synth stops the device', device.track.stopped);
  provider = null;
});

{
  // a reconnect supersedes acquisition A while the live session presses for B: A must touch nothing the session owns
  await sfu.sfuConnect({}, () => {});
  const a0 = acquisitions.length;
  const pA = sfu.sfuMic(true);
  const acqA = await nextAcquisition(a0);
  await sfu.sfuConnect({}, () => {});
  const pB = sfu.sfuMic(true);
  for (let i = 0; i < 20; i++) await flush();
  t('superseded: the live session\'s acquisition waits for the stale one (one acquisition at a time)', acquisitions.length === a0 + 1);
  const A = mkStream(mkTrack('device A')), g0 = gated.length;
  acqA.resolve(A);
  const acqB = await nextAcquisition(a0 + 1);
  await pA;
  t('superseded: the stale acquisition is stopped and touches no shared mic state (no gate graph, micstate not on it)',
    A.track.stopped && gated.length === g0 && mic.rawMicStream() !== A);
  const B = mkStream(mkTrack('device B'));
  acqB.resolve(B);
  await pB;
  t('superseded: the live session\'s device B is live, current and attached, intent kept',
    !B.track.stopped && mic.rawMicStream() === B && added.at(-1) === gated.at(-1)?.track && !gated.at(-1).track.stopped
      && mic.micDeviceLive() && sfu.sfuMicWanted() && sfu.sfuMicOn());
}

// The gate cannot build and ungated audio is not consented: the publish is refused.
noGate = true;
{
  await sfu.sfuConnect({}, () => {});
  const a0 = acquisitions.length;
  const p = sfu.sfuMic(true);
  const device = mkStream(mkTrack('device'));
  (await nextAcquisition(a0)).resolve(device);
  await p;
  t('gate unavailable: the refusal stops the device and says so to micstate',
    !sfu.sfuMicWanted() && device.track.stopped && !mic.micDeviceLive());
}
{
  // the refusal lands on an acquisition a reconnect superseded: it is not that session's intent to clear
  await sfu.sfuConnect({}, () => {});
  const a0 = acquisitions.length;
  const p = sfu.sfuMic(true);
  const acq = await nextAcquisition(a0);
  await sfu.sfuConnect({}, () => {});
  const device = mkStream(mkTrack('device'));
  acq.resolve(device);
  await p;
  t('gate unavailable, superseded: the stale refusal keeps the live session\'s intent and stops its device',
    sfu.sfuMicWanted() && device.track.stopped);
}

clearTimeout(watchdog);
console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
