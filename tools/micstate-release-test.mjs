// BEHAVIORAL vectors for releaseMicrophone's lane-preservation contract
// (#131 review, finding 2). The exec test cannot see this class of bug: it
// calls gateRelease() first, which nulls the lane, so its releaseMicrophone()
// is a no-op. These vectors keep the lane ALIVE across releases and assert
// track identity and liveness — the properties the function's own doc-comment
// promises.
//
// The AudioContext stub here is FULL ENOUGH to build the real gate graph
// (source → lookahead → gain → destination), so the lane is a genuinely
// DISTINCT stream from the raw device — a degraded stub where gateStream
// falls back to raw===lane would make every assertion below vacuous.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });

const mkTrack = (label) => ({ kind: "audio", label, enabled: true, stopped: false,
  stop() { this.stopped = true; }, readyState: "live" });
const mkStream = (label, synthetic = false) => {
  const t = mkTrack(label);
  return { synthetic, _t: t, getTracks: () => [t], getAudioTracks: () => [t] };
};

// One destination per createMediaStreamDestination call — its .stream is the
// lane the senders would hold.
const node = () => ({ connect() {}, disconnect() {},
  gain: { value: 1, setTargetAtTime() {} }, delayTime: { setTargetAtTime() {} } });
mock.module(new URL("../client/lib/audioctx.js", import.meta.url).pathname, () => ({
  audioContext: () => ({
    currentTime: 0, sampleRate: 48000, state: "running", destination: node(),
    createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData() {}, connect() {}, disconnect() {} }),
    createMediaStreamSource: () => node(),
    createGain: node,
    createDelay: node,
    createMediaStreamDestination: () => ({ ...node(), stream: mkStream("lane") }),
  }),
}));
mock.module(new URL("../client/lib/core.js", import.meta.url).pathname, () => ({
  report: () => {}, bus: { on() {}, emit() {} },
}));
mock.module(new URL("../client/lib/net.js", import.meta.url).pathname, () => ({ sendTyping: () => {} }));

const m = await import("../client/lib/micstate.js");
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${n}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};

// ── device path: the lane survives release, twice, and is REUSED on return ──
const raw1 = mkStream("device-1");
const lane = m.gateFor(raw1);
check("gate built a DISTINCT lane (stub is not degraded)", lane !== raw1,
  "gateStream fell back — assertions below would be vacuous");
check("…and the gate reports available", !m.gateIsUnavailable());

m.releaseMicrophone();
check("release stops the raw device track (rule 1: OS indicator dies)", raw1._t.stopped);
check("release does NOT stop the lane track (rule 2: one-way door)", !lane._t.stopped);
check("micOn() is false after release", !m.micOn());

m.releaseMicrophone();                      // the second release — v0 stopped the lane here
check("a SECOND release is harmless: lane track still live", !lane._t.stopped);
check("…still exactly the same track object", lane.getTracks()[0] === lane._t);

const raw2 = mkStream("device-2");
const lane2 = m.gateFor(raw2);
check("reacquisition returns the SAME lane the senders already hold", lane2 === lane);
check("…whose track was never stopped across the whole cycle", !lane._t.stopped);
m.releaseMicrophone();
check("…and a fresh raw stops on the next release while the lane still lives",
  raw2._t.stopped && !lane._t.stopped);

// ── synthetic path: raw IS the lane; release may stop it (it is the device),
//    but repeated release must stay harmless and reacquisition must work ─────
const synth = mkStream("synth", true);
const synthLane = m.gateFor(synth);
check("synthetic source bypasses the gate (lane === source)", synthLane === synth);
m.releaseMicrophone();
check("synthetic release stops the generator (it IS the device)", synth._t.stopped);
m.releaseMicrophone();
m.releaseMicrophone();
check("repeated synthetic release does not throw and stays inert", true);
const synth2 = mkStream("synth-2", true);
check("a new synthetic source acquires cleanly after release", m.gateFor(synth2) === synth2);

console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
