// EXECUTE every micstate export. Not a source grep — an actual call.
//
// 🔴 WHY THIS EXISTS. The extraction that created micstate.js left SIX module
// variables behind (_onsetTimer, _above, _lastOnset, _openUntil, _openedAt,
// _announced, declared at voice.js:680-682) and dropped the audioctx import.
// The file passed `node --check`, passed every source-level test in tools/, and
// IMPORTED cleanly — free variables are only resolved when executed — while
// gateFor() threw ReferenceError on the first call, i.e. turning the mic on
// rejected and the gate never ran.
//
// Every check in place was structurally incapable of reporting it. An
// adversarial agent found it by running the module. So: run the module.
//
// Imports are stubbed only at the BROWSER boundary (AudioContext, the bus, the
// net send). The code under test is the shipped code.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });
mock.module(new URL('../client/lib/core.js', import.meta.url).pathname, () => ({
  // 🔴 no flashHint here — it does NOT live in core.js, and stubbing it there
  // once codified exactly the wrong import this test then failed to catch.
  report: () => {}, bus: { on(){}, emit(){} },
}));
mock.module(new URL('../client/lib/net.js', import.meta.url).pathname, () => ({ sendTyping: () => {} }));
mock.module(new URL('../client/lib/audioctx.js', import.meta.url).pathname, () => ({
  audioContext: () => ({ createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData(){}, connect(){} }),
    createMediaStreamSource: () => ({ connect(){} }), sampleRate: 48000, state: 'running' }),
}));
const m = await import('../client/lib/micstate.js');
const track = { kind:'audio', enabled:true, stop(){} };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
let ok = 0, bad = 0;
const t = (n, f) => { try { f(); console.log(`ok   ${n}`); ok++; }
                      catch (e) { console.log(`FAIL ${n} — ${e.constructor.name}: ${e.message}`); bad++; } };
t('micAnalyserLevel()', () => m.micAnalyserLevel());
t('micOn()',            () => m.micOn());
t('isMuted()',          () => m.isMuted());
t('gateFor(stream)',    () => m.gateFor(stream));
t('micAnalyserLevel() with a lane', () => m.micAnalyserLevel());
t('toggleMute()',       () => m.toggleMute(true));
t('toggleMute() back',  () => m.toggleMute(false));
t('selfMonitoring()',   () => m.selfMonitoring());
t('gateRelease()',      () => m.gateRelease());
t('releaseMicrophone()',() => m.releaseMicrophone());
console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
