// vrmic-exec-test — the EFFECTS of client/lib/vrmic.js, executed with a fake clock: the flows whose promise is "the
// mic ask never blocks entering VR, and a promise made in VR is kept after it". vrmic-policy-test drives the pure
// decisions; tools/vrmic-probe.mjs drives the real client in a browser. This file sits between: the shipped vrmic.js,
// stubbed only at the browser/transport boundary (permissions, getUserMedia, micstate, voicesfu, the toast layer).
//
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/vrmic-exec-test.mjs
//
// Each section names the regression it was written against (each was red on the code before its fix):
//   1. a second visor press during the permission read opened a second #vrmic scrim
//   2. Allow with a browser prompt nobody answers sat on "waiting for the browser…" with no way into VR
//   3. leaving VR during the in-VR try: the after-exit ask never came, and the flat page was told "when you leave VR"
//   4. every failed in-VR try added another permission 'change' listener, so one grant announced itself N times
//   2 (cont.) an unanswered Allow was remembered as 'allow', so every later press went straight in and never asked again;
//   2b. a browser answer after the bound left the card saying "hasn't answered"
//   5. with no navigator.permissions.query the grant watcher set its flag and never cleared it
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { mock } from 'bun:test';
import { checker } from './probe-harness.mjs';
const realImmediate = globalThis.setImmediate;
GlobalRegistrator.register({ url: 'http://localhost/?world=t&name=p' });

// ── a fake clock: timers fire only on advance() ──
let now = 0, seq = 0; const timers = new Map();
globalThis.setTimeout = (fn, ms = 0, ...a) => { const id = ++seq; timers.set(id, { at: now + ms, fn: () => fn(...a) }); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => realImmediate(r)); };
async function advance(ms) {
  const end = now + ms;
  for (;;) {
    await settle();
    const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    timers.delete(due[0]); now = due[1].at; due[1].fn();
  }
  now = end; await settle();
}

// ── the browser boundary ──
const perm = { state: 'prompt', delay: 0, statuses: [] };
Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: (d) => {
  if (d?.name !== 'microphone') return Promise.reject(new TypeError('not a permission name here'));
  const st = new EventTarget(); Object.defineProperty(st, 'state', { get: () => perm.state }); perm.statuses.push(st);
  return perm.delay ? new Promise((r) => setTimeout(() => r(st), perm.delay)) : Promise.resolve(st);
} } });
const gum = { calls: 0, held: [] };
Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
  getUserMedia: () => { gum.calls++; return new Promise((res, rej) => gum.held.push({ res, rej })); },   // a prompt nobody answers
} });
const fakeStream = () => { const t = { readyState: 'live', stop() { t.readyState = 'ended'; } }; return { track: t, getTracks: () => [t] }; };

const hints = [], toasts = [];
const listeners = new Map();
const bus = { on(e, f) { (listeners.get(e) ?? listeners.set(e, new Set()).get(e)).add(f); }, emit(e, p) { for (const f of listeners.get(e) ?? []) f(p); } };
const lib = (p) => new URL(`../client/lib/${p}`, import.meta.url).pathname;
mock.module(lib('base.js'), () => ({ bus, CONFIG: { name: 'p', params: new URLSearchParams() } }));
mock.module(lib('ui.js'), () => ({ flashHint: (t) => hints.push(t), toast: (t) => toasts.push(t) }));
mock.module(lib('core.js'), () => ({ THREE: {}, camera: {}, renderer: {} }));
mock.module(lib('quadcolour.js'), () => ({ quadMaterial: () => null }));
const mic = { on: false, toggles: 0 }, sfu = { wanted: false };
mock.module(lib('micstate.js'), () => ({ micOn: () => mic.on, toggleMic: () => { mic.toggles++; sfu.wanted = true; return new Promise(() => {}); } }));   // the in-VR acquisition hangs
mock.module(lib('voicesfu.js'), () => ({ sfuMicWanted: () => sfu.wanted, sfuMicOn: () => false, sfuMic: async (v) => { sfu.wanted = v; } }));

const V = await import('../client/lib/vrmic.js');
const { MIC_CHOICE_KEY } = await import('../client/lib/vrmic_policy.js');
const { check, done } = checker();
const scrims = () => document.querySelectorAll('#vrmic').length;
const closeCard = () => { dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); };
const reset = () => { localStorage.clear(); hints.length = 0; toasts.length = 0; perm.state = 'prompt'; perm.delay = 0; };

console.log('\n— 1. one visor press at a time —');
{
  reset(); perm.delay = 300;   // the permission read takes a while (it is capped at 400 ms)
  let proceeds = 0;
  void V.vrMicPreflight(() => proceeds++);
  void V.vrMicPreflight(() => proceeds++);   // the impatient second press, inside that read
  await advance(500);
  check('a second press during the permission read opens no second scrim', scrims() === 1, `${scrims()} scrims`);
  check('…and enters nothing', proceeds === 0, `${proceeds}`);
  closeCard();
  check('Escape closes it', scrims() === 0, `${scrims()} scrims`);
}

console.log('\n— 2. Allow, and the browser never answers —');
{
  reset();
  let proceeds = 0;
  void V.vrMicPreflight(() => proceeds++);
  await advance(500);
  document.querySelector('#vrmic [data-act=allow]').click();
  await advance(1000);
  check('while the browser is asked, the card waits', /waiting for the browser/.test(document.querySelector('#vrmic')?.textContent ?? ''));
  await advance(V.TRY_MS);
  const card = document.querySelector('#vrmic');
  const go = card?.querySelector('[data-act=enter]');
  check(`after TRY_MS (${V.TRY_MS} ms) unanswered, "Enter VR" is offered`, !!go, card?.textContent.replace(/\s+/g, ' ').trim());
  check('…with honest words: the browser has not answered, and VR is still open', /hasn.t answered/.test(card?.textContent ?? '') && /still enter/.test(card?.textContent ?? ''), card?.textContent.replace(/\s+/g, ' ').trim());
  go?.click();
  check('"Enter VR" enters (proceed ran once) and the card is gone', proceeds === 1 && scrims() === 0, JSON.stringify({ proceeds, scrims: scrims() }));
  check('an ask nobody answered is not remembered as "allow"', localStorage.getItem(MIC_CHOICE_KEY) !== 'allow', String(localStorage.getItem(MIC_CHOICE_KEY)));
  const again = V.vrMicPreflight(() => proceeds++);
  await advance(500);
  check('…so the next visor press, permission still open, asks again', (await again) === 'asked' && scrims() === 1, JSON.stringify({ scrims: scrims(), proceeds }));
  closeCard();
  const s = fakeStream(); gum.held.splice(0).forEach((h) => h.res(s));   // the prompt is answered long after
  await advance(10);
  check('a late answer\'s tracks are stopped (the mic light goes out)', s.track.readyState === 'ended', s.track.readyState);
  check('exactly one getUserMedia for the Allow', gum.calls === 1, `${gum.calls}`);
  if (scrims()) closeCard();
}

console.log('\n— 2b. the browser answers after the bound, with the card still up —');
{
  reset(); gum.held.length = 0;
  void V.vrMicPreflight(() => {});
  await advance(500);
  document.querySelector('#vrmic [data-act=allow]').click();
  await advance(V.TRY_MS + 100);
  check('setup: the card says the browser has not answered', /hasn.t answered/.test(document.querySelector('#vrmic')?.textContent ?? ''));
  gum.held.splice(0).forEach((h) => h.res(fakeStream()));
  await advance(10);
  const card = document.querySelector('#vrmic');
  check('a late answer replaces "hasn\'t answered" with what the browser said',
    !/hasn.t answered/.test(card?.textContent ?? '') && card?.querySelector('[data-result=allowed]') && !!card.querySelector('[data-act=enter]'),
    card?.textContent.replace(/\s+/g, ' ').trim());
  check('…and an answered ask is remembered', localStorage.getItem(MIC_CHOICE_KEY) === 'allow', String(localStorage.getItem(MIC_CHOICE_KEY)));
  if (scrims()) closeCard();
}

console.log('\n— 3. leaving VR while the in-VR try is still out —');
{
  reset(); gum.held.length = 0;
  bus.emit('xr:state', true);
  void V.xrMicPress();
  await advance(1000);
  check('the try is out (one acquisition, hanging)', mic.toggles === 1, `${mic.toggles}`);
  bus.emit('xr:state', false);   // she takes the headset off before TRY_MS
  await advance(V.TRY_MS + 3000);
  const card = document.querySelector('#vrmic');
  check('the flat page asks after all ("Voice needs permission")', card?.querySelector('#vrmic-title')?.textContent === 'Voice needs permission', card ? card.textContent.replace(/\s+/g, ' ').trim() : 'no card');
  const said = [...hints, globalThis.__vrmic?.note ?? ''].join(' | ');
  check('…and no one off the headset is told "when you leave VR"', !/leave VR/.test(said), said);
  check('the intent was retracted', sfu.wanted === false);
  if (scrims()) closeCard();
}

console.log('\n— 4. one grant, announced once —');
{
  reset(); mic.toggles = 0;
  bus.emit('xr:state', true);
  for (let i = 0; i < 2; i++) { void V.xrMicPress(); await advance(V.TRY_MS + 100); }
  check('two failed tries happened', mic.toggles === 2, `${mic.toggles}`);
  bus.emit('xr:state', false);   // off the headset, so "allowed" lands as a flat hint we can count
  perm.state = 'granted';
  for (const st of perm.statuses) st.dispatchEvent(new Event('change'));
  const allowed = hints.filter((h) => /allowed/.test(h));
  check('a grant after two failed tries announces itself once', allowed.length === 1, JSON.stringify(allowed));
  await advance(5000);
  check('…and the after-exit ask then has nothing to ask', scrims() === 0, `${scrims()} scrims`);
}

console.log('\n— 5. a browser with no permissions.query —');
{
  reset(); mic.toggles = 0; hints.length = 0;
  const query = navigator.permissions.query; delete navigator.permissions.query;
  bus.emit('xr:state', true);
  let err = null;
  const press = V.xrMicPress().catch((e) => { err = e; });
  await advance(V.TRY_MS + 100); await press;
  check('the failed try settles without throwing', mic.toggles === 1 && err === null, String(err));
  navigator.permissions.query = query;
  const n = perm.statuses.length;
  void V.xrMicPress(); await advance(V.TRY_MS + 100);
  bus.emit('xr:state', false);
  perm.state = 'granted';
  for (const st of perm.statuses.slice(n)) st.dispatchEvent(new Event('change'));
  // contrived (the API does not appear mid-page), but it is how the flag is seen: a stuck flag skips every later watch
  check('…and the watcher is not left "watching": once the API answers, a grant announces itself', hints.filter((h) => /allowed/.test(h)).length === 1, JSON.stringify(hints));
  await advance(5000);
  if (scrims()) closeCard();
}
done();
