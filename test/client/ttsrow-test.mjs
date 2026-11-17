// ttsrow-test: the audio panel's TTS section, executed headlessly (client/lib/audio/ttsrow.js + ttslist.js, tts.js, micstate.js
// shipped). Stubbed: the browser's file pickers, net.js, and the voice store / engine modules behind a dynamic import.
//   bun test/client/ttsrow-test.mjs
import { fileURLToPath } from 'node:url';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { mock } from 'bun:test';
import { pause } from '../gate/wait.ts';
GlobalRegistrator.register({ url: 'http://localhost/?world=t&name=p' });
const M = (p) => fileURLToPath(new URL(`../../client/lib/${p}`, import.meta.url));

let ok = 0, bad = 0;
const t = (n, cond, detail = '') => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}${cond || !detail ? '' : ` — ${detail}`}`); };
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// the remembered voices; a load parks on `gate` when set, and fails when `loadFails`
let voices = [], gate = null, loadFails = false, report = null;   // report: the running load's progress callback
const opened = [], loaded = [];
let tts;
mock.module(M('net.js'), () => ({ sendTyping: () => {}, requestHistory: () => {} }));
mock.module(M('audio/voicestore.js'), () => ({
  canRemember: () => true,
  listVoices: async () => voices.map((v) => ({ ...v })),
  voiceReadable: async () => 'granted',
  openVoice: async (entry) => { opened.push(entry.id); return [new File(['m'], `${entry.name}.onnx`), new File(['{}'], `${entry.name}.onnx.json`)]; },
  voiceIdentity: async (onnx) => ({ id: `id:${onnx.name}` }),
  rememberVoice: async (id, name) => { voices.push({ id, name }); },
  forgetVoice: async (id) => { voices = voices.filter((v) => v.id !== id); },
}));
mock.module(M('audio/voiceengines.js'), () => ({
  matchEngine: (files) => files.some((f) => /\.onnx$/.test(f.name)) && files.some((f) => /\.json$/.test(f.name)),
  loadFromFiles: async (files, onProgress) => {
    loaded.push(files.map((f) => f.name).join('+'));
    report = onProgress;
    if (gate) await gate.promise;
    if (loadFails) throw new Error('engine refused');
    tts.setTtsSource(async () => ({ pcm: new Int16Array(1), sampleRate: 22050 }), files[0].name.replace(/\.onnx$/, ''));
  },
}));
mock.module(M('audio/engines.js'), () => ({}));
mock.module(M('audio/browservoice.js'), () => ({ setEndpointVoice: async () => {} }));

tts = await import('../../client/lib/audio/tts.js');
const { bus } = await import('../../client/lib/base.js');
const { ttsSection } = await import('../../client/lib/audio/ttsrow.js');
const { lastWhy } = await import('../../client/lib/debuglog.js');

let micLive = false;
window.__sfuMicOn = () => micLive;
const host = document.createElement('div');
document.body.appendChild(host);
const note = () => host.querySelector('.row.wide .note')?.textContent ?? '(no note)';
const dimmed = () => host.querySelector('.row.wide .nm')?.style.opacity === '.45';
const box = () => host.querySelector('.row.wide input[type=checkbox]');
const rows = () => [...host.querySelectorAll('.vl-row[data-id]')];
const row = (id) => rows().find((r) => r.dataset.id === id);
const marked = () => rows().filter((r) => r.querySelector('.vl-radio')?.classList.contains('on')).map((r) => r.dataset.id);
const repaint = async () => { bus.emit('audio:mic'); await flush(); };
const tick = async (on) => { const b = box(); b.checked = on; b.dispatchEvent(new Event('change')); await flush(10); };
const reset = async ({ list = [], source = false, enabled = false, mic = false } = {}) => {
  voices = list.map((id) => ({ id, name: id })); micLive = mic; gate = null; loadFails = false;
  opened.length = 0; loaded.length = 0;
  tts.setTtsSource(source ? async () => ({ pcm: new Int16Array(1), sampleRate: 22050 }) : null, 'test-voice');
  tts.setTtsEnabled(enabled);
  await repaint();
};

ttsSection(host);
await flush();
t('first paint of an empty list draws the pane and the add-verbs', !!host.querySelector('.vl-pane') && host.querySelectorAll('.vl-add').length === 2);

// ── the header: what it says and whether it greys; a live mic outranks TTS and is SAID ──
for (const [name, st, wantNote, wantDim] of [
  ['fresh, no voice', {}, '', true],
  ['voice loaded, tts off', { source: true }, 'ready', true],
  ['tts on, mic off', { source: true, enabled: true }, 'test-voice', false],
  ['tts on, MIC ON', { source: true, enabled: true, mic: true }, 'not available while your mic is on', true],
]) {
  await reset(st);
  t(`head: ${name} → "${wantNote}", dim=${wantDim}`, note() === wantNote && dimmed() === wantDim, `note="${note()}" dim=${dimmed()}`);
}
{
  await reset({ list: ['a', 'b'], source: true, enabled: true, mic: true });
  gate = deferred();
  row('b').click(); await flush();
  t('head: loading beats the mic note', /^loading b/.test(note()) && dimmed(), `note="${note()}"`);
  gate.resolve(); await flush(10);
}

// ── selecting a radio: marking is free while TTS is off, a live switch while on ──
{
  await reset({ list: ['voice-a', 'voice-b'] });
  const before = rows();
  row('voice-a').click(); await flush();
  t('select, tts OFF: no load', opened.length === 0 && loaded.length === 0, `opened=${opened}`);
  t('select, tts OFF: the voice is marked and remembered', marked().join() === 'voice-a' && localStorage.getItem('eido.tts.lastVoice') === 'voice-a', marked().join());
  t('select, tts OFF: re-marked in place (same row nodes)', rows().length === 2 && rows().every((r, i) => r === before[i]));
  tts.setTtsSource(async () => ({ pcm: new Int16Array(1), sampleRate: 22050 }), 'voice-a'); tts.setTtsEnabled(true);
  row('voice-b').click(); await flush(10);
  t('select, tts ON: the switch loads at once', opened.join() === 'voice-b' && loaded.length === 1 && tts.isTtsEnabled(), `opened=${opened}`);
}

// ── the tick: it enables only after its own load, a failed load unticks, and every exit clears the pending flag ──
{
  await reset({ list: ['v1'] });
  gate = deferred();
  const pending = tick(true);
  await flush();
  t('tick: the box is ticked and faded while the load runs', box().checked && box().style.opacity === '.45' && !tts.isTtsEnabled());
  await repaint();
  t('tick: a repaint mid-load keeps the box ticked (in-place writer agrees)', box().checked === true, `checked=${box().checked}`);
  gate.resolve(); await pending; await flush(10);
  t('tick: a successful load enables TTS', tts.isTtsEnabled() === true && loaded.length === 1);
  t('tick: …and the box is no longer faded', box().checked && box().style.opacity === '', `opacity="${box().style.opacity}"`);
}
{
  await reset({ list: ['v1'] });
  loadFails = true;
  await tick(true); await flush(10);
  t('tick: a failed load unticks and leaves TTS off', box().checked === false && tts.isTtsEnabled() === false);
  loadFails = false;
  await tick(true); await flush(10);
  t('tick: the next tick after a failure still loads (pending flag cleared)', loaded.length === 2 && tts.isTtsEnabled() === true, `loads=${loaded.length}`);
}
{
  await reset({});
  await tick(true); await flush();
  t('tick with no voice: says so and does not claim the tick', box().checked === false && /add a voice/.test(note()), `note="${note()}"`);
}

// ── the list repaints in place unless its structure changed ──
{
  await reset({ list: ['a', 'b', 'c'] });
  const before = rows();
  await repaint();
  t('list: same membership → in place (row nodes survive)', rows().length === 3 && rows().every((r, i) => r === before[i]));
  voices.push({ id: 'd', name: 'd' });
  await repaint();
  t('list: a membership change rebuilds', rows().length === 4 && rows()[0] !== before[0]);
  tts.setTtsSource(async () => ({ pcm: new Int16Array(1), sampleRate: 22050 }), 'a'); tts.setTtsEnabled(true);
  gate = deferred();
  row('c').click(); await flush();
  t('list: a loading row appearing is structural (rebuilt, carries .vl-loading)', !!host.querySelector('.vl-loading') && row('c')?.classList.contains('vl-loading'));
  gate.resolve(); await flush(10);
}
{
  await reset({});
  const pane = host.querySelector('.vl-pane');
  await repaint();
  t('list: an empty list already painted stays in place', !!pane && host.querySelector('.vl-pane') === pane);
  voices.push({ id: 'x', name: 'x' });
  await repaint();
  t('list: rows expected but none carry data-id → rebuilt with the rows', rows().map((r) => r.dataset.id).join() === 'x' && host.querySelector('.vl-pane') !== pane);
  t('list: …and the rebuild says so, not "empty list"', /no data-id rows, but 1 item/.test(String(lastWhy('tts-list'))), String(lastWhy('tts-list')));
}

// ── adding a file: the matching FILE is asked for first; the folder only after a decline; a pending row resumes ──
{
  const calls = [];
  const handle = (name) => ({ getFile: async () => new File(['x'], name) });
  let answers = [];     // what each file prompt returns, in order
  window.showOpenFilePicker = async () => { calls.push('file'); return answers.shift() ?? null; };
  window.showDirectoryPicker = async () => { calls.push('folder'); throw Object.assign(new Error('declined'), { name: 'AbortError' }); };
  const add = () => host.querySelector('.vl-add');
  await reset({});
  answers = [[handle('piper.onnx')], [handle('piper.onnx.json')]];
  add().click(); await flush(12);
  t('add: lone .onnx → asks for the matching FILE; picking it imports, no folder ask', calls.join() === 'file,file' && loaded.at(-1) === 'piper.onnx+piper.onnx.json', `${calls} / ${loaded}`);
  calls.length = 0; voices = [];
  await reset({});
  answers = [[handle('piper.onnx')], null];
  add().click(); await flush(12);
  t('add: the file declined → the folder is offered after it', calls.join() === 'file,file,folder', calls.join());
  t('add: both declined → a resumable pending row', !!row('__pending'), rows().map((r) => r.dataset.id).join());
  calls.length = 0;
  tts.setTtsEnabled(false);
  answers = [[handle('piper.onnx.json')]];
  row('__pending').click(); await flush(12);
  t('select __pending resumes the import whatever the enable state', calls.join() === 'file' && loaded.at(-1) === 'piper.onnx+piper.onnx.json', `${calls} / ${loaded}`);
}

{ // a loading row's clock ticks on its own (it was cleared on its first tick, run before the row was in the page)
  const { renderVoiceList } = await import(M('audio/ttslist.js'));
  const since = Date.now() - 5_000, clocks = () => [...document.querySelectorAll('.vl-clocks .vl-loading .vl-note')].map((e) => e.textContent);
  const solo = document.createElement('div'), listed = document.createElement('div'); solo.className = listed.className = 'vl-clocks';
  document.body.append(solo, listed);
  renderVoiceList(solo, { items: [], selected: null, on: {}, loading: { id: 'new', name: 'new', since } });
  renderVoiceList(listed, { items: [{ id: 'v', name: 'v' }], selected: null, on: {}, loading: { id: 'v', name: 'v', since } });
  const first = clocks(); await pause('two of the clocks\' 1 s ticks: elapsed time is what this row reads', 2_200); const later = clocks();
  t('clock: a new voice\'s loading row and a listed voice\'s both count up by themselves', first.length === 2 && later.length === 2 && later.every((x, i) => x !== first[i]), JSON.stringify({ first, later }));
  solo.remove(); listed.remove();
}

{ // an engine's progress text survives the loading row's clock (the clock read the status the row was built with)
  const handle = (name) => ({ getFile: async () => new File(['x'], name) });
  let answers = [];
  window.showOpenFilePicker = async () => answers.shift() ?? null;
  await reset({});
  await pause('the earlier rows\' failure timers (3 s) clear the status; let them run out first', 3_200);
  gate = deferred(); const progress = 'compiling voice model';
  answers = [[handle('slow.onnx')], [handle('slow.onnx.json')]];
  host.querySelector('.vl-add').click(); await flush(12);
  report?.({ text: progress }); await flush();
  const shown = () => host.querySelector('.vl-loading .vl-note')?.textContent ?? '(no row)';
  const at = shown(); await pause('one of the clock\'s 1 s ticks, which repainted the old status', 1_300); const later = shown();
  t('progress: the engine\'s text stays on the loading row past a clock tick (the clock may add its seconds)', at.startsWith(progress) && later.startsWith(progress), JSON.stringify({ at, later }));
  report = null; gate.resolve(); await flush(12);
}

console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
