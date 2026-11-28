// STT under push-to-talk: EXECUTE stt.js with a fake SpeechRecognition and count the `say`s.
// The key is the gate (micstate.js); captions must obey it like the audio does (bot #333 131).
//
// Run: bun test/client/stt-ptt-test.mjs
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });

const said = [];
mock.module(fileURLToPath(new URL('../../client/lib/net.js', import.meta.url)), () => ({
  say: (text) => { said.push(text); }, sendTyping: () => {}, sendRequest: async () => ({ ok: true }), net: {},
}));
mock.module(fileURLToPath(new URL('../../client/lib/ui/ui.js', import.meta.url)), () => ({ flashHint: () => {} }));

// the recognizer: `running` is whether it holds the mic; final() delivers a result as Chrome would
let rec = null;
class FakeSR {
  constructor() { rec = this; this.running = false; this.starts = 0; }
  start() { if (this.running) throw new Error('already started'); this.running = true; this.starts++; this.onstart?.(); }
  stop() { if (!this.running) return; this.running = false; this.flush?.(); this.flush = null; this.onend?.(); }
  abort() { if (!this.running) return; this.running = false; this.flush = null; this.onend?.(); }
  final(text) { const r = [{ transcript: text }]; r.isFinal = true; this.onresult?.({ resultIndex: 0, results: [r] }); }
}
window.SpeechRecognition = FakeSR;
window.__sfuMicOn = () => true;   // the mic is live throughout; the key is the only variable

localStorage.clear();
const vc = await import('../../client/lib/audio/voiceconsent.js');
const ms = await import('../../client/lib/audio/micstate.js');
await import('../../client/lib/audio/stt.js');
const { bus } = await import('../../client/lib/base.js');

let ok = 0, bad = 0;
const t = (n, cond) => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}`); };
const posted = (s) => said.some((x) => x.includes(s));

// voice activation: captions flow while the mic is live (the baseline the PTT rows differ from)
vc.setSttConsent(true);
bus.emit('audio:mic', true);
t('setup: a recognizer was built and started', !!rec && rec.running);
rec.final('open line');
t('VAD: a final result is posted', posted('open line'));

// arm PTT with the key up: nothing heard from here may be posted, and the recognizer lets go of the mic
vc.setPttMode(true);
rec.final('key up one');
t('PTT key up: a final result is NOT posted', !posted('key up one'));
t('PTT key up: the recognizer is not listening', !rec.running);

// hold V: listening again, results post
ms.setPttHeld(true);
t('PTT held: the recognizer is listening', rec.running);
rec.final('held line');
t('PTT held: a final result is posted', posted('held line'));

// release V mid-utterance: what was heard while held still finalizes (stop() flushes it), later speech does not
rec.flush = () => rec.final('tail heard while held');
ms.setPttHeld(false);
t('PTT release: speech heard while held still posts', posted('tail heard while held'));
t('PTT release: the recognizer stops listening', !rec.running);
rec.final('after release');
t('PTT released: a late final result is NOT posted', !posted('after release'));

// leaving PTT resumes voice-activated captions
vc.setPttMode(false);
t('VAD again: the recognizer listens', rec.running);
rec.final('vad again');
t('VAD again: a final result is posted', posted('vad again'));

console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
