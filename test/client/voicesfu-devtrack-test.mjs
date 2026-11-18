// A reconnect stops the DEVICE under a gated publish, not only the gate's track. sfuConnect stops the stream it published
// so the hardware light goes out and the replay acquires afresh; on the gated lane that stream is the gate's destination,
// and the device feeding it kept capturing, mic on or off, beside whatever the replay acquired next.
//
// Stubbed: the browser boundary (RTCPeerConnection, and a WebAudio context whose MediaStreamDestination yields a track of
// its own), voiceSource() as a deferred acquisition the test resolves by hand, and net.js, ui/chat.js and audiounlock.js
// as no-ops. voicesfu.js, micstate.js and micgate.js are the shipped modules.
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
globalThis.RTCPeerConnection = class { constructor() { this.connectionState = 'new'; } getTransceivers() { return []; } addTrack() {} close() {} };

const sfu = await import('../../client/lib/audio/voicesfu.js');

let ok = 0, bad = 0;
const t = (n, cond) => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}`); };
const watchdog = setTimeout(() => { console.log(`FAIL watchdog: a publish never settled\n\n${ok} ok, ${bad + 1} failed`); process.exit(1); }, 5000);
const flush = () => new Promise((r) => setImmediate(r));

/** Publish a device on the gated lane, run `between`, reconnect: the device must be stopped. */
async function lane(name, between) {
  await sfu.sfuConnect({}, () => {});
  const a0 = acquisitions.length, g0 = gated.length;
  const p = sfu.sfuMic(true);
  while (acquisitions.length === a0) await flush();   // the publish imports voiceSource first; the watchdog bounds this
  const device = mkStream(mkTrack('device'));
  acquisitions[a0].resolve(device);
  await p;
  t(`${name}: setup — the gated lane published (a gate graph, the device under it)`, gated.length === g0 + 1 && !device.track.stopped);
  await between();
  await sfu.sfuConnect({}, () => {});
  t(`${name}: a reconnect stops the device track, not only the gate's`, device.track.stopped && gated[g0].track.stopped);
}

await lane('mic on', async () => {});
await lane('mic off (no synth provider)', () => sfu.sfuMic(false));

clearTimeout(watchdog);
console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
