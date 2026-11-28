// micstate.js + micgate.js EXECUTED, one process: the transport seam, every micstate.js export (micgate's own setMonitorDelay
// isn't called), the ungated lane, release. Stubs stop at
// the browser boundary (AudioContext, net); `ctx` picks which AudioContext the next gateFor meets. PTT: mic-ptt-test.mjs.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
import { pause, tryUntil } from "../gate/wait.ts";
import { suite } from "../gate/suite.ts";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });
const lib = (f) => fileURLToPath(new URL(`../../client/lib/${f}`, import.meta.url));

mock.module(lib("net.js"), () => ({ sendTyping: () => {}, say: () => {}, sendRequest: async () => ({ ok: true }), net: {} }));
const mkTrack = (label) => ({ kind: "audio", label, enabled: true, stopped: false, readyState: "live", stop() { this.stopped = true; } });
const mkStream = (label, synthetic = false) => { const t = mkTrack(label); return { synthetic, _t: t, getTracks: () => [t], getAudioTracks: () => [t] }; };
const node = () => ({ connect() {}, disconnect() {}, gain: { value: 0, setTargetAtTime() {} }, delayTime: { value: 0, setTargetAtTime() {} } });
// "none": no createMediaStreamDestination, so the gate graph cannot build; "full": the graph builds and each destination
// is a DISTINCT lane stream (else the release rows are vacuous)
let ctx = "none";
mock.module(lib("audio/audioctx.js"), () => ({
  audioContext: () => ({
    currentTime: 0, sampleRate: 48000, state: "running", destination: node(),
    createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData() {}, connect() {}, disconnect() {} }),
    createMediaStreamSource: () => node(),
    ...(ctx === "full" ? { createGain: node, createDelay: node, createMediaStreamDestination: () => ({ ...node(), stream: mkStream("lane") }) } : {}),
  }),
}));
// ui.js takes its HUD elements at load; flashHint is wrapped so the no-relay hint can be heard
for (const id of ["hud", "loading", "toasts", "hintbar", "door", "help", "dock", "touch"]) { const d = document.createElement("div"); d.id = id; document.body.append(d); }
const hints = [];
const realUi = await import("../../client/lib/ui/ui.js");
mock.module(lib("ui/ui.js"), () => ({ ...realUi, flashHint: (msg) => hints.push(msg) }));

localStorage.clear();
const vc = await import("../../client/lib/audio/voiceconsent.js");
const mg = await import("../../client/lib/audio/micgate.js");
const m = await import("../../client/lib/audio/micstate.js");
const { bus } = await import("../../client/lib/base.js");   // micstate emits on base.js's bus
const emitted = [];
bus.on("audio:mic", (v) => emitted.push(["audio:mic", v]));
const { check, done } = suite("micstate");

// ── the single transport (#132): no hook → an honest hint; the SFU hook IS the transport; no mesh residue ──────────────
const src = readFileSync(new URL("../../client/lib/audio/micstate.js", import.meta.url), "utf8");
check("T1 micstate has NO import of the deleted mesh (voice.js) — code or dynamic",
  !/import\s*\(\s*['"]\.\/voice\.js['"]\s*\)/.test(src) && !/from\s+['"]\.\/voice\.js['"]/.test(src));
check("T2 precondition: no transport hook installed", typeof window.__sfuMic !== "function");
check("T3 micOn() starts false", m.micOn() === false);
const none = await m.toggleMic();
check("T4 toggleMic without a transport returns the (false) current state, no throw", none === false);
check("T5 …and did not claim the mic went live", m.micOn() === false);
let sfuCalls = 0, sfuOn = false;
window.__sfuMic = async () => { sfuCalls++; sfuOn = !sfuOn; m.setMicLive(sfuOn); return sfuOn; };
const s1 = await m.toggleMic();
check("T6 with __sfuMic installed, toggleMic calls it", sfuCalls === 1);
check("T7 …returns its resulting state", s1 === true);
check("T8 …emits audio:mic with that state", emitted.some(([ev, v]) => ev === "audio:mic" && v === true));
const s2 = await m.toggleMic();
check("T9 OFF→ back through the same hook", sfuCalls === 2 && s2 === false);
const s3 = await m.toggleMic();
check("T10 ON→OFF→ON completes through the single transport", s3 === true);
// a world with NO voice relay, hook installed (gym 10-17): the server's refusal (__voiceRelayAbsent) wins over the hook
await m.toggleMic();   // back to OFF
const callsBefore = sfuCalls; hints.length = 0;
window.__voiceRelayAbsent = true;
const absent = await m.toggleMic();
await tryUntil("the lazy ui.js import lands its hint", () => hints.length > 0, { ms: 2000, step: 5 });
check("T11 no relay: toggleMic does not hand the press to a transport that cannot exist", sfuCalls === callsBefore, `calls ${sfuCalls - callsBefore}`);
check("T12 no relay: …returns the honest current state (off)", absent === false);
check("T13 no relay: …and SAYS so — the no-voice-relay hint, not silence", hints.some((h) => /no voice relay/.test(h)), JSON.stringify(hints));
delete window.__voiceRelayAbsent;
// house I111 (#260): the no-relay guard is for turning ON; a live mic must still switch OFF through the hook
m.gateFor({ synthetic: true }); m.setMicLive(true); sfuOn = true;
check("T14 precondition: the mic is live", m.micOn() === true);
window.__voiceRelayAbsent = true;
const callsLive = sfuCalls;
const off = await m.toggleMic();
check("T15 no relay, mic live: the press goes to the hook and turns it off", sfuCalls === callsLive + 1 && off === false && m.micOn() === false, `calls ${sfuCalls - callsLive}, returned ${off}, micOn ${m.micOn()}`);
delete window.__voiceRelayAbsent;
delete window.__sfuMic;

// ── every export CALLED, not grepped: the extraction once left free variables that only threw when run ─────────────────
const ran = (f) => { try { f(); return ""; } catch (e) { return `${e.constructor.name}: ${e.message}`; } };
const xs = mkStream("exec");
let r;
r = ran(() => m.micAnalyserLevel()); check("E1 micAnalyserLevel() runs", !r, r);
r = ran(() => m.micOn()); check("E2 micOn() runs", !r, r);
r = ran(() => m.isMuted()); check("E3 isMuted() runs", !r, r);
let lane0;
r = ran(() => { lane0 = m.gateFor(xs); });
check("E4 gateFor(stream) runs, and on a context that cannot build the gate, unconsented, fails CLOSED", !r && lane0 === null && m.gateIsUnavailable(), r || String(lane0));
r = ran(() => m.micAnalyserLevel()); check("E5 micAnalyserLevel() with a lane runs", !r, r);
r = ran(() => m.toggleMute(true)); check("E6 toggleMute(true) runs", !r && m.isMuted() === true, r);
r = ran(() => m.toggleMute(false)); check("E7 toggleMute(false) runs", !r && m.isMuted() === false, r);
r = ran(() => m.selfMonitoring()); check("E8 selfMonitoring() runs", !r, r);
r = ran(() => m.gateRelease()); check("E9 gateRelease() runs", !r, r);
r = ran(() => m.releaseMicrophone()); check("E10 releaseMicrophone() runs", !r, r);
r = ran(() => m.selfMonitor(false)); check("E11 selfMonitor(false) runs", !r, r);
r = ran(() => { m.pttHeld(); m.ungatedAllowed(); m.rawMicStream(); m.micDeviceLive(); m.micDeviceLevel(); }); check("E12 pttHeld / ungatedAllowed / rawMicStream / micDeviceLive / micDeviceLevel run", !r, r);

// ── the UNGATED lane (#148): the graph cannot build and raw was consented, so PTT drives the raw track's `enabled` ──────
const track = mkTrack("ungated");
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
// PTT armed BEFORE the raw lane exists governs it the moment gateFor returns, not a tick later
mg.allowUngated(true);
vc.setPttMode(true);
const early = m.gateFor(stream);
check("U1 armed-first: gateFor returns the raw stream as the lane", m.gateIsUnavailable() && early === stream);
check("U2 armed-first: the raw track is DISABLED synchronously, before any tick", track.enabled === false);
check("U3 armed-first: gateOpenness() is 0 synchronously", mg.gateOpenness() === 0);
check("U4 armed-first: speaking is false synchronously", m.micGateInfo().speaking === false);
m.setPttHeld(true);
check("U5 armed-first: a press opens the raw track", track.enabled === true);
m.setPttHeld(false);
check("U6 armed-first: a release closes it", track.enabled === false);
m.gateRelease();
m.releaseMicrophone();
vc.setPttMode(false);
track.enabled = true;   // a fresh device stream arrives enabled
const lane = m.gateFor(stream);
check("U7 precondition: the gate is unavailable and the raw stream IS the lane", m.gateIsUnavailable() && lane === stream);
check("U8 voice activation on a consented raw lane: track transmits", track.enabled === true);
check("U9 …and gateOpenness() says so", mg.gateOpenness() === 1);
vc.setPttMode(true);
check("U10 PTT armed on the ungated lane: raw track is DISABLED (no key, no audio)", track.enabled === false);
check("U11 …gateOpenness() agrees", mg.gateOpenness() === 0);
m.setPttHeld(true);
check("U12 PTT held: raw track enabled", track.enabled === true && mg.gateOpenness() === 1);
m.setPttHeld(false);
check("U13 PTT released: raw track disabled", track.enabled === false && mg.gateOpenness() === 0);
m.toggleMute(true);
m.setPttHeld(true);
check("U14 held + muted on the ungated lane: raw track stays disabled", track.enabled === false);
check("U15 held + muted reports speaking:false", m.micGateInfo().speaking === false);
m.toggleMute(false);
check("U16 unmute while held: raw track enabled again", track.enabled === true);
m.setPttHeld(false);
vc.setPttMode(false);
check("U17 mode exit: raw lane is open again (voice activation, ungated, as consented)", track.enabled === true && mg.gateOpenness() === 1);
m.toggleMute(true);
vc.setPttMode(true); vc.setPttMode(false);
check("U18 mode exit while muted does NOT reopen the raw lane", track.enabled === false);
m.toggleMute(false);
// the transport's mic OFF outranks the key (Mica, round 3): voicesfu.js sfuMic's order, verbatim; the onset ticks are real
const transportMicOff = () => { track.enabled = false; m.setMicLive(false); };
const transportMicOn = () => { track.enabled = true; m.setMicLive(true); };
vc.setPttMode(true);
m.setPttHeld(true);
check("U19 precondition: held on the ungated lane transmits", track.enabled === true && m.micOn() === true);
transportMicOff();
check("U20 held → mic OFF: raw track is disabled at once", track.enabled === false);
await pause("four-plus 20 ms onset ticks with the key still down", 90);
check("U21 held → mic OFF → ticks: raw track STAYS disabled", track.enabled === false);
check("U22 …micOn() is false", m.micOn() === false);
check("U23 …speaking is false", m.micGateInfo().speaking === false);
check("U24 …gateOpenness() is 0", mg.gateOpenness() === 0);
m.setPttHeld(false); m.setPttHeld(true);
check("U25 a fresh press while the mic is OFF does not reopen the raw track", track.enabled === false);
m.setPttHeld(false);
transportMicOn();
check("U26 mic ON under PTT, key up: the regime closes the re-enabled track again, synchronously", track.enabled === false && mg.gateOpenness() === 0);
m.setPttHeld(true);
check("U27 mic ON under PTT: a press opens", track.enabled === true && m.micOn() === true && m.micGateInfo().speaking === true);
m.setPttHeld(false);
check("U28 precondition: armed, key up, track closed", track.enabled === false);
transportMicOff();
vc.setPttMode(false);
check("U29 armed → mic OFF → leave PTT: raw track stays disabled", track.enabled === false);
check("U30 …gateOpenness() stays 0", mg.gateOpenness() === 0);
await pause("four-plus 20 ms onset ticks in voice activation", 90);
check("U31 …and stays so across ticks in voice activation", track.enabled === false && mg.gateOpenness() === 0);
transportMicOn();
check("U32 mic ON under voice activation: the consented raw lane is open again", track.enabled === true && mg.gateOpenness() === 1 && m.micOn() === true);
mg.allowUngated(false);

// ── releaseMicrophone keeps the lane (#131 review, finding 2): track identity and liveness across releases ─────────────
ctx = "full";
const raw1 = mkStream("device-1");
const laneR = m.gateFor(raw1);
check("R1 gate built a DISTINCT lane (stub is not degraded)", laneR !== raw1, "gateStream fell back — the rows below would be vacuous");
check("R2 …and the gate reports available", !m.gateIsUnavailable());
m.releaseMicrophone();
check("R3 release stops the raw device track (rule 1: OS indicator dies)", raw1._t.stopped);
check("R4 release does NOT stop the lane track (rule 2: one-way door)", !laneR._t.stopped);
check("R5 micOn() is false after release", !m.micOn());
m.releaseMicrophone();
check("R6 a SECOND release is harmless: lane track still live", !laneR._t.stopped);
const raw2 = mkStream("device-2");
check("R8 reacquisition returns the SAME lane the senders already hold", m.gateFor(raw2) === laneR);
check("R9 …whose track was never stopped across the whole cycle", !laneR._t.stopped);
m.releaseMicrophone();
check("R10 …and a fresh raw stops on the next release while the lane still lives", raw2._t.stopped && !laneR._t.stopped);
// synthetic: raw IS the lane, so release may stop it; repeats stay harmless and reacquisition works
const synth = mkStream("synth", true);
check("R11 synthetic source bypasses the gate (lane === source)", m.gateFor(synth) === synth);
m.releaseMicrophone();
check("R12 synthetic release stops the generator (it IS the device)", synth._t.stopped);
r = ran(() => { m.releaseMicrophone(); m.releaseMicrophone(); });
check("R13 repeated synthetic release does not throw", !r, r);
const synth2 = mkStream("synth-2", true);
check("R14 a new synthetic source acquires cleanly after release", m.gateFor(synth2) === synth2);

done();
