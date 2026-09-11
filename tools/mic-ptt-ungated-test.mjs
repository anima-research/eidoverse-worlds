// Push-to-talk on the UNGATED lane: EXECUTE the product path Mica's #148
// review found open. When the WebAudio gate graph cannot be built and the
// person allowed raw transmission, the SFU publishes the device stream itself
// — there is no gain node, so every gate decision used to land on nothing and
// the raw microphone left the machine continuously while PTT said "released".
// The repair drives the raw tracks' `enabled` flag from the PTT decision
// (micgate.js driveRawTracks). These cases go red if that call is removed.
//
// Run: bun tools/mic-ptt-ungated-test.mjs
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });
mock.module(new URL('../client/lib/net.js', import.meta.url).pathname, () => ({ sendTyping: () => {} }));
// A context that CANNOT build the gate graph: no createMediaStreamDestination.
mock.module(new URL('../client/lib/audioctx.js', import.meta.url).pathname, () => ({
  audioContext: () => ({
    currentTime: 0, sampleRate: 48000, state: 'running',
    createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData() {}, connect() {}, disconnect() {} }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
  }),
}));
localStorage.clear();
const vc = await import('../client/lib/voiceconsent.js');
const mg = await import('../client/lib/micgate.js');
const ms = await import('../client/lib/micstate.js');

let ok = 0, bad = 0;
const t = (n, cond) => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}`); };
const track = { kind: 'audio', enabled: true, stop() {} };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };

// The explicit escape hatch the panel offers, then the lane.
mg.allowUngated(true);
const lane = ms.gateFor(stream);
t('precondition: the gate is unavailable and the raw stream IS the lane', ms.gateIsUnavailable() && lane === stream);
t('voice activation on a consented raw lane: track transmits (that is what was consented to)', track.enabled === true);
t('…and gateOpenness() says so', mg.gateOpenness() === 1);

// ── arming PTT closes the WIRE, not a gain that does not exist ─────────────
vc.setPttMode(true);
t('PTT armed on the ungated lane: raw track is DISABLED (no key, no audio)', track.enabled === false);
t('…gateOpenness() agrees', mg.gateOpenness() === 0);
ms.setPttHeld(true);
t('PTT held: raw track enabled', track.enabled === true && mg.gateOpenness() === 1);
ms.setPttHeld(false);
t('PTT released: raw track disabled — "release V and the room hears nothing" is TRUE here', track.enabled === false && mg.gateOpenness() === 0);

// ── mute outranks the key on this lane too ────────────────────────────────
ms.toggleMute(true);
ms.setPttHeld(true);
t('held + muted on the ungated lane: raw track stays disabled', track.enabled === false);
t('held + muted reports speaking:false', ms.micGateInfo().speaking === false);
ms.toggleMute(false);
t('unmute while held: raw track enabled again', track.enabled === true);
ms.setPttHeld(false);

// ── leaving PTT restores the consented raw regime ─────────────────────────
vc.setPttMode(false);
t('mode exit: raw lane is open again (voice activation, ungated, as consented)', track.enabled === true && mg.gateOpenness() === 1);
ms.toggleMute(true);
vc.setPttMode(true); vc.setPttMode(false);
t('mode exit while muted does NOT reopen the raw lane', track.enabled === false);
ms.toggleMute(false);

console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
