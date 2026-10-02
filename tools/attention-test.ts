// bun run tools/attention-test.ts — pure gating plus the real renderer-free chat.
import { createAttentionGate, ATTENTION_COOLDOWN_MS } from '../client/lib/attention-policy.js';
import { mkCheck } from './harness.ts';
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const { check, tally } = mkCheck();
let now = 0, me = 'tester', world = 'a';
const gate = createAttentionGate({ now: () => now, me: () => me, scope: () => world,
  mentions: (text: any) => String(text).includes(me) });
let seq = 0;
const say = (text = '@tester hello', extra = {}, actor = 'other') =>
  ({ verb: 'say', seq: ++seq, actor, args: { text, ...extra } });
const tick = () => { now += ATTENTION_COOLDOWN_MS; };
check('live mention admitted', gate.say(say()));
check('burst coalesced', !gate.say(say()));
tick();
check('ambient ignored', !gate.say(say('hello room')));
check('self ignored', !gate.say(say('@tester', {}, me)));
check('replay ignored', !gate.say({ ...say(), replay: true }));
check('non-speech ignored', !gate.say({ ...say(), verb: 'caption' }));
const e = say();
check('next live mention admitted', gate.say(e)); tick();
check('duplicate sequence ignored after cooldown', !gate.say(e));
const spoken = say('@tester', { spoken: true, utt: 7 });
check('spoken mention admitted', gate.say(spoken)); tick();
check('same utterance continuation ignored after cooldown', !gate.say(say('@tester again', { spoken: true, utt: 7 })));
check('another actor may use the same utt', gate.say(say('@tester', { spoken: true, utt: 7 }, 'third'))); tick();
check('non-mention beginning stays eligible for later directed sentence', !gate.say(say('hello', { spoken: true, utt: 8 })));
check('later directed sentence admitted', gate.say(say('@tester', { spoken: true, utt: 8 }))); tick();
const dm = { from: 'other', to: 'tester', text: 'hello' };
check('incoming whisper admitted', gate.whisper(dm)); tick();
check('held whisper ignored', !gate.whisper({ ...dm, replay: true }));
check('outgoing whisper ignored', !gate.whisper({ ...dm, echo: true }));
check('wrong-recipient whisper ignored', !gate.whisper({ ...dm, to: 'elsewhere' }));
check('self whisper ignored', !gate.whisper({ ...dm, from: 'tester' }));
world = 'b';
check('sequence restarts in a new world', gate.say({ ...say(), seq: 1 }));
me = 'renamed';
check('renaming updates mention and self matching', gate.say({ ...say('@renamed'), seq: 2 }));
tick();
check('old name no longer addressed', !gate.say(say('@tester')));

// Utterance counters are sender-local: STT starts at 1 after a page reload.
me = 'tester'; world = 'sessions';
gate.roster([{ id: 'other', session: 'boot-a:1' }]);
check('first sender session owns its utterance', gate.say(say('@tester', { spoken: true, utt: 1 }))); tick();
gate.roster([{ id: 'other', session: 'boot-a:1' }]);
check('unchanged session snapshot retains dedup across listener reconnect', !gate.say(say('@tester', { spoken: true, utt: 1 })));
gate.participant({ id: 'other', session: 'boot-a:2' });
check('sender rejoin can reuse its utterance counter', gate.say(say('@tester', { spoken: true, utt: 1 }))); tick();
gate.roster([{ id: 'other', session: 'boot-b:2' }]);
check('server restart cannot collide at the same numeric generation', gate.say(say('@tester', { spoken: true, utt: 1 }))); tick();
gate.roster([]);
gate.participant({ id: 'other', session: 'boot-b:3' });
check('roster removal releases departed sender cache', gate.say(say('@tester', { spoken: true, utt: 1 }))); tick();
gate.forget('other');
check('live teardown releases sender cache', gate.say(say('@tester', { spoken: true, utt: 1 }))); tick();

gate.roster([{ id: 'other' }]);
check('first legacy sender without session can chime', gate.say(say('@tester', { spoken: true, utt: 2 }))); tick();
gate.roster([{ id: 'other' }]);
check('sessionless reconnect snapshot preserves dedup', !gate.say(say('@tester', { spoken: true, utt: 2 })));
gate.participant({ id: 'other' });
check('explicit sessionless arrival permits counter reuse', gate.say(say('@tester', { spoken: true, utt: 2 }))); tick();

gate.roster([{ id: 'other', session: 'boot-c:9' }]);
check('known sender session establishes cache', gate.say(say('@tester', { spoken: true, utt: 3 }))); tick();
gate.roster([{ id: 'other' }]);
check('known to sessionless snapshot does not invent a lifetime', !gate.say(say('@tester', { spoken: true, utt: 3 })));
gate.roster([{ id: 'other', session: 'boot-c:9' }]);
check('later same known session retains dedup', !gate.say(say('@tester', { spoken: true, utt: 3 })));

let audible = false;
const silentGate = createAttentionGate({ me: () => 'tester', scope: () => 'silent',
  mentions: () => true, now: () => now, play: () => audible });
check('silent spoken notice stays silent', !silentGate.say(say('@tester', { spoken: true, utt: 4 })));
audible = true;
check('silent utterance never replays on enable', !silentGate.say(say('@tester', { spoken: true, utt: 4 })));
check('new utterance immediately eligible after silent notice', silentGate.say(say('@tester', { spoken: true, utt: 5 })));

// Execute the actual chat and audio UI; only the renderer/wire are replaced.
plugin({ name: 'attention-chat-stubs', setup(b) {
  for (const name of ['core', 'base', 'frames', 'net'])
    b.onResolve({ filter: new RegExp('^\\./' + name + '\\.js$') },
      () => ({ path: fileURLToPath(new URL('./chat-' + name + '-stub.mjs', import.meta.url)) }));
} });
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
GlobalRegistrator.register();
let time = 0;
Object.defineProperty(performance, 'now', { value: () => time, configurable: true });
const oscillators: any[] = [], gains: any[] = [];
class Gain {
  gain = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
  target: any; disconnected = false;
  connect(target: any) { this.target = target; }
  disconnect() { this.disconnected = true; }
}
let gesture = false, resumeCalls = 0, contexts = 0;
class Audio {
  constructor() { contexts++; }
  state = 'suspended'; currentTime = 0; destination = {};
  resume() { resumeCalls++; if (gesture) this.state = 'running'; return Promise.resolve(); }
  createGain() { const g = new Gain(); gains.push(g); return g; }
  createOscillator() {
    const o: any = { frequency: { value: 0 }, connect() {}, disconnect() {},
      start() { oscillators.push(o); }, stop() {} };
    return o;
  }
}
(window as any).AudioContext = Audio;
const { bus, CONFIG } = await import('./chat-base-stub.mjs');
const { initChat, logChat, logWhisper } = await import('../client/lib/chat.js');
const { attentionPrefs, setAttentionPrefs } = await import('../client/lib/attention.js');
const { audioPrefs } = await import('../client/lib/voiceconsent.js');
const { audioContext } = await import('../client/lib/audioctx.js');
const unrelated = JSON.stringify(audioPrefs());
initChat({ send() {}, people: () => [] });
document.querySelector<HTMLButtonElement>('.chat-gear')!.click();
const enabled = document.querySelector<HTMLInputElement>('[data-attention="enabled"]')!;
check('chat gear mounts default-off attention with independent 20% volume', !enabled.checked && attentionPrefs().volume === 0.2);
bus.emit('live-entry', { verb: 'say', actor: 'other', seq: 1, args: { text: '@tester' } });
check('default-off creates no oscillator', oscillators.length === 0);
gesture = true;
enabled.checked = true; enabled.dispatchEvent(new Event('change'));
check('enable change creates and resumes audio during its gesture', contexts === 1 && resumeCalls > 0 && audioContext().state === 'running');
gesture = false;
// No cooldown wait: the preceding disabled notice made no sound.
logChat('other', '@tester replayed', '', { seq: 100 });
bus.emit('caption', { actor: 'other', text: '@tester live caption' });
check('history rendering and captions never chime', oscillators.length === 0);
bus.emit('live-entry', { verb: 'say', actor: 'other', seq: 2, args: { text: '@tester', spoken: true, utt: 1 } });
check('actual bus live mention schedules one soft tone', oscillators.length === 1);
check('tone connects through its own quiet gain', gains.some(g => g.target === audioContext().destination && g.gain.value === 0.03));
time += 3000;
bus.emit('live-entry', { verb: 'say', actor: 'other', seq: 3, args: { text: '@tester continuation', spoken: true, utt: 1 } });
check('caption plus repeated durable representation stays one tone', oscillators.length === 1);
logWhisper({ from: 'other', to: CONFIG.name, text: 'held', replay: true });
check('actual chat held whisper stays visual-only', oscillators.length === 1 && document.body.textContent!.includes('held'));
logWhisper({ from: 'other', to: CONFIG.name, text: 'live' });
check('actual chat live whisper chimes', oscillators.length === 2);
check('whisper has a visual ping independent of audio', !!document.querySelector('.whisper.ping'));
setAttentionPrefs({ enabled: false });
check('muting silences active attention gains immediately', gains.filter(g => g.target === audioContext().destination).every(g => g.gain.value === 0));
check('muting attention leaves world, voice and TTS prefs unchanged', JSON.stringify(audioPrefs()) === unrelated);
setAttentionPrefs({ enabled: true });
(audioContext() as any).state = 'suspended';
time += 3000;
bus.emit('live-entry', { verb: 'say', actor: 'other', seq: 4, args: { text: '@tester locked' } });
check('suspended context drops notice before scheduling', oscillators.length === 2);
(audioContext() as any).state = 'running';
window.dispatchEvent(new Event('pointerdown'));
await Promise.resolve();
check('unlock never replays a stale notice', oscillators.length === 2);
// No cooldown wait: the preceding locked notice made no sound.
bus.emit('live-entry', { verb: 'say', actor: 'other', seq: 5, args: { text: '@tester fresh' } });
check('fresh notice after unlock chimes', oscillators.length === 3);
const select = document.querySelector<HTMLSelectElement>('[data-attention="sound"]')!;
select.value = 'chime'; select.dispatchEvent(new Event('change'));
document.querySelector<HTMLButtonElement>('[data-attention="preview"]')!.click();
await Promise.resolve(); await Promise.resolve();
check('selected chime preview has two tones', oscillators.length === 5);
const slider = document.querySelector<HTMLInputElement>('[data-attention="volume"]')!;
slider.value = '0'; slider.dispatchEvent(new Event('input'));
check('volume control persists independently', JSON.parse(localStorage.getItem('ew-attention')!).volume === 0);
time += 3000;
bus.emit('live-entry', { verb: 'say', actor: 'other', seq: 6, args: { text: '@tester zero-volume' } });
check('zero-volume notice schedules no tone', oscillators.length === 5);
setAttentionPrefs({ volume: 0.2, sound: 'soft' });
bus.emit('live-entry', { verb: 'say', actor: 'other', seq: 7, args: { text: '@tester after volume restored' } });
check('fresh mention after restoring volume has no silent cooldown', oscillators.length === 6);

check('controls keep audio prefs unchanged', JSON.stringify(audioPrefs()) === unrelated);
for (const o of oscillators) o.onended();
check('completed tones release every gain', gains.every(g => g.disconnected));
setAttentionPrefs({ volume: NaN, sound: 'unknown' });
check('malformed preferences normalize', attentionPrefs().volume === 0.2 && attentionPrefs().sound === 'soft');
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
