// vrmic-exec-test — the EFFECTS of client/lib/xr/vrmic.js, executed with a fake clock: the flows whose promise is "the
// mic ask never blocks entering VR, and a promise made in VR is kept after it". section 0 drives the pure
// decisions; test/client/vrmic-probe.mjs drives the real client in a browser. This file sits between: the shipped vrmic.js,
// stubbed only at the browser/transport boundary (permissions, getUserMedia, micstate, voicesfu, the toast layer).
//
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/vrmic-exec-test.mjs
//
// Each section names the regression it was written against (each was red on the code before its fix):
//   1. a second visor press during the permission read opened a second #vrmic scrim
//   2. Allow with a browser prompt nobody answers sat on "waiting for the browser…" with no way into VR
//   3. leaving VR during the in-VR try: the after-exit ask never came, and the flat page was told "when you leave VR"
//   4. every failed in-VR try added another permission 'change' listener, so one grant announced itself N times
//   2 (cont.) an unanswered Allow was remembered as 'allow', so every later press went straight in and never asked again;
//   2b. a browser answer after the bound left the card saying "hasn't answered"
//   5. with no navigator.permissions.query the grant watcher set its flag and never cleared it
//   0. the policy itself (vrmic_policy.js) against an independent table; each mutation below turns the named row red:
//      'unknown' treated as straight-in → "never asked + unknown asks" · remembered checked before pending → "a VR promise
//      outranks an earlier not-now" · denied asked instead of hinted → "denied goes straight in, with the settings hint" ·
//      in-VR 'try' on granted → "granted in VR just toggles" · inVrAfterTry ignores micOn → "a live mic after the try is ok"
//   6. section 0's table, executed: what vrmic.js does is what the policy decides
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { mock } from 'bun:test';
import { checker } from '../harness/probe-harness.mjs';
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
const lib = (p) => fileURLToPath(new URL(`../../client/lib/${p}`, import.meta.url));
mock.module(lib('base.js'), () => ({ bus, CONFIG: { name: 'p', params: new URLSearchParams() } }));
mock.module(lib('ui/ui.js'), () => ({ flashHint: (t) => hints.push(t), toast: (t) => toasts.push(t) }));
mock.module(lib('core.js'), () => ({ THREE: {}, camera: {}, renderer: {} }));
mock.module(lib('xr/quadcolour.js'), () => ({ quadMaterial: () => null }));
const mic = { on: false, toggles: 0 }, sfu = { wanted: false };
mock.module(lib('audio/micstate.js'), () => ({ micOn: () => mic.on, toggleMic: () => { mic.toggles++; sfu.wanted = true; return new Promise(() => {}); } }));   // the in-VR acquisition hangs
mock.module(lib('audio/voicesfu.js'), () => ({ sfuMicWanted: () => sfu.wanted, sfuMicOn: () => false, sfuMic: async (v) => { sfu.wanted = v; } }));

const V = await import('../../client/lib/xr/vrmic.js');
const { MIC_CHOICE_KEY, MIC_PENDING_KEY, preVrStep, inVrMicPlan, inVrAfterTry, afterExitStep } = await import('../../client/lib/xr/vrmic_policy.js');
const { check, done } = checker();
const scrims = () => document.querySelectorAll('#vrmic').length;
const closeCard = () => { dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); };
const reset = () => { localStorage.clear(); hints.length = 0; toasts.length = 0; perm.state = 'prompt'; perm.delay = 0; };

console.log('\n— 0. the policy, against its own table —');
const STATES = ['granted', 'denied', 'prompt', 'unknown'];
{
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const expectPre = (state, remembered, pending) => {
    if (state === 'granted') return { step: 'straight', hint: null };
    if (state === 'denied') return { step: 'straight', hint: 'denied' };
    if (pending) return { step: 'ask', hint: null };
    return remembered ? { step: 'straight', hint: null } : { step: 'ask', hint: null };
  };
  const bad = [];
  for (const s of STATES) for (const r of [null, 'allow', 'later']) for (const p of [false, true]) {
    const got = preVrStep({ state: s, remembered: r, pending: p });
    if (!eq(got, expectPre(s, r, p))) bad.push(`${s}/${r}/${p} → ${JSON.stringify(got)}`);
  }
  check('pre-VR: all 24 state × choice × pending cases match the table', bad.length === 0, bad.join('; '));
  check('pre-VR: granted goes straight in, no step', eq(preVrStep({ state: 'granted' }), { step: 'straight', hint: null }));
  check('pre-VR: denied goes straight in, with the settings hint', eq(preVrStep({ state: 'denied' }), { step: 'straight', hint: 'denied' }));
  check('pre-VR: never asked + prompt asks', preVrStep({ state: 'prompt', remembered: null }).step === 'ask');
  check('pre-VR: never asked + unknown asks', preVrStep({ state: 'unknown', remembered: null }).step === 'ask');
  check('pre-VR: a remembered "not now" is not re-asked', preVrStep({ state: 'prompt', remembered: 'later' }).step === 'straight');
  check('pre-VR: a remembered "allow" (prompt dismissed since) is not re-asked', preVrStep({ state: 'prompt', remembered: 'allow' }).step === 'straight');
  check('pre-VR: a VR promise outranks an earlier not-now', preVrStep({ state: 'prompt', remembered: 'later', pending: true }).step === 'ask');
  check('pre-VR: a garbage remembered value counts as never asked', preVrStep({ state: 'prompt', remembered: 'yes' }).step === 'ask');
  check('in VR: turning the mic OFF is never gated', inVrMicPlan({ turningOn: false, presenting: true, state: 'prompt' }) === 'proceed');
  check('in VR: outside a session nothing is gated', inVrMicPlan({ turningOn: true, presenting: false, state: 'prompt' }) === 'proceed');
  check('in VR: granted in VR just toggles', inVrMicPlan({ turningOn: true, presenting: true, state: 'granted' }) === 'proceed');
  check('in VR: denied is blocked (no request at all)', inVrMicPlan({ turningOn: true, presenting: true, state: 'denied' }) === 'blocked');
  check('in VR: prompt / unknown get one bounded try', ['prompt', 'unknown'].every((s) => inVrMicPlan({ turningOn: true, presenting: true, state: s }) === 'try'));
  check('after the try: a live mic is ok whatever the state says', STATES.every((s) => inVrAfterTry({ micOn: true, state: s }) === 'ok'));
  check('after the try: granted but not live is not a permission problem', inVrAfterTry({ micOn: false, state: 'granted' }) === 'ok');
  check('after the try: denied → blocked', inVrAfterTry({ micOn: false, state: 'denied' }) === 'blocked');
  check('after the try: still open → later (ask on the flat page)', ['prompt', 'unknown'].every((s) => inVrAfterTry({ micOn: false, state: s }) === 'later'));
  check('after exit: no promise → nothing', STATES.every((s) => afterExitStep({ pending: false, state: s }) === 'none'));
  check('after exit: answered on the way out → clear', afterExitStep({ pending: true, state: 'granted' }) === 'clear');
  check('after exit: denied → clear with the settings hint', afterExitStep({ pending: true, state: 'denied' }) === 'clear-denied');
  check('after exit: still open → ask', ['prompt', 'unknown'].every((s) => afterExitStep({ pending: true, state: s }) === 'ask'));
  check('keys are distinct and namespaced', MIC_CHOICE_KEY !== MIC_PENDING_KEY && [MIC_CHOICE_KEY, MIC_PENDING_KEY].every((k) => k.startsWith('ew-vr-mic-')));
}

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
// ── 6. vrmic.js does what the policy decides: every pre-VR row, the in-VR turn-on per state and every after-exit row, executed through its effects ──
const asState = (s) => s === 'unknown' ? 'not-a-state' : s;   // micPermissionState maps any other answer to 'unknown'
console.log('\n— 6. the policy table, executed —');
{
  const bad = []; let deniedHints = 0;
  for (const state of STATES) for (const r of [null, 'allow', 'later']) for (const p of [false, true]) {
    reset(); perm.state = asState(state);
    if (r) localStorage.setItem(MIC_CHOICE_KEY, r);
    if (p) localStorage.setItem(MIC_PENDING_KEY, '1');
    const toasted = toasts.length; let proceeds = 0;
    const res = V.vrMicPreflight(() => proceeds++); await advance(500);
    const d = preVrStep({ state, remembered: r, pending: p });
    const ok = d.step === 'straight' ? (await res) === 'straight' && proceeds === 1 && scrims() === 0
      : (await res) === 'asked' && proceeds === 0 && scrims() === 1;
    // the settings hint is said once a page: never on a row that isn't denied
    const hinted = toasts.slice(toasted).some((t) => /blocked/.test(t) && /settings/.test(t)); if (hinted) deniedHints++;
    if (!ok || (hinted && d.hint !== 'denied')) bad.push(`${state}/${r}/${p}: want ${JSON.stringify(d)}, got ${JSON.stringify({ proceeds, scrims: scrims(), hinted })}`);
    if (scrims()) closeCard();
  }
  check('pre-VR: every state × remembered × pending does what preVrStep says', bad.length === 0, bad.join('; '));
  check('…and a denied permission was hinted, once a page', deniedHints === 1, String(deniedHints));
}
{
  const bad = [];
  for (const state of STATES) {
    reset(); perm.state = asState(state); mic.toggles = 0; mic.on = false;
    bus.emit('xr:state', true);
    void V.xrMicPress(); await advance(V.TRY_MS + 100);
    const plan = inVrMicPlan({ turningOn: true, presenting: true, state });
    const want = plan === 'blocked' ? 0 : 1;   // blocked asks for nothing; proceed toggles; try toggles once, bounded
    if (mic.toggles !== want) bad.push(`${state}: plan ${plan}, ${mic.toggles} toggles`);
    bus.emit('xr:state', false); await advance(5000); if (scrims()) closeCard();
  }
  check('in VR: a press toggles the mic exactly when inVrMicPlan lets it (denied asks nothing)', bad.length === 0, bad.join('; '));
}
{
  const bad = [];
  for (const state of STATES) for (const p of [false, true]) {
    reset(); perm.state = asState(state); if (p) localStorage.setItem(MIC_PENDING_KEY, '1');
    const hinted = hints.length, toasted = toasts.length;
    await V.__askAfterExit(); await advance(10);
    const step = afterExitStep({ pending: p, state });
    const got = scrims() ? 'ask' : toasts.length > toasted ? 'clear-denied' : hints.length > hinted ? 'clear' : 'none';
    const cleared = step.startsWith('clear') ? localStorage.getItem(MIC_PENDING_KEY) === null : true;
    if (got !== step || !cleared) bad.push(`${state}/${p}: want ${step}, got ${got}${cleared ? '' : ' (flag kept)'}`);
    if (scrims()) closeCard();
  }
  check('after exit: every pending × state does what afterExitStep says, and a clear clears the flag', bad.length === 0, bad.join('; '));
}

done();
