// xr-confirm-probe — a question asked in a headset is answered in the headset. The client's yes/no asks went to the
// browser's confirm() (speech-to-text consent, log out, closing the door) or to the DOM centre card, neither of which an
// immersive session draws: the action blocked or quietly said no. Real client + IWER; the answers go through
// domQuadsPick, the same laser path the trigger uses, on the `ask` quad (xr/xrask.js).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/xr-confirm-probe.mjs
// Then the consent edges (a dismissed question is never a remembered answer): S1 leaving VR mid-question, S2 a moderator's
// warning arriving mid-question, S3 a desk card left open when the session starts and a headset ⏎ elsewhere, S4 two
// consent asks while one is open (mic on → off → on) are one question with one answer, S5 the mic turned off while the
// consent question is open: a Turn on after that keeps the consent but never starts the recognizer.
// Every wait is on the page's own state (wait.ts until): the question on the quad, a promise settled, a quad shown.
// Mutations (must go red): in client/lib/edit/confirmcenter.js confirmCenter, drop the `headset?.active()` branch;
// in audio/voiceconsent.js ensureSttConsent, save a dismissal as false; in xr/xrask.js, settle the open question
// instead of queueing (S2); drop the xr:state(true) closeCenter() and the desk card's aimedElsewhere guard (S3).
import { launchBrowser, ownedWorld, checker, iwerInit, visorShown, enterVR, exitVR } from '../harness/probe-harness.mjs';
import { until } from '../gate/wait.ts';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
await iwerInit(pg);
const errs = [], dialogs = [];
pg.on('pageerror', (e) => errs.push(String(e)));
// a native dialog in a headset is the bug: record it and dismiss it so the page doesn't hang on it
pg.on('dialog', (d) => { dialogs.push(`${d.type()}: ${d.message().slice(0, 60)}`); d.dismiss().catch(() => {}); });

// ---- the page's side: one helper object per page load (a reload starts it over) ----
// __px.pull aims a laser at a DOM point inside quad `id` and pulls the trigger: the real pick → mousedown/up/click path.
// __r holds what page-side promises settled to ('unsettled' until then), so the probe waits on them from here.
const install = () => pg.evaluate(async () => {
  const dq = await import('./lib/xr/domquad.js'); const THREE = await import('three');
  const ask = await import('./lib/xr/xrask.js');
  const pull = (id, el) => {
    const mesh = dq.domQuadMesh(id), dom = dq.domQuadTexture(id).dom, fr = dom.getBoundingClientRect(), er = el.getBoundingClientRect();
    const u = (er.left + er.width / 2 - fr.left) / fr.width, v = (er.top + er.height / 2 - fr.top) / fr.height;
    const { width: W, height: H } = mesh.geometry.parameters; mesh.updateMatrixWorld(true);
    const p = mesh.localToWorld(new THREE.Vector3((u - 0.5) * W, (0.5 - v) * H, 0));
    const q = new THREE.Quaternion(); mesh.getWorldQuaternion(q);
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    return dq.domQuadsPick({ matrixWorld: new THREE.Matrix4().compose(p.clone().addScaledVector(n, 0.5), q, new THREE.Vector3(1, 1, 1)) }, true);
  };
  const btn = (id, re) => [...(dq.domQuadTexture(id)?.dom?.querySelectorAll('button') ?? [])].find((b) => re.test(b.textContent) && b.getBoundingClientRect().height > 0);
  const input = () => dq.domQuadTexture('ask')?.dom?.querySelector('input') ?? null;
  globalThis.__r = {};
  globalThis.__px = {
    dq, ask, pull, btn, input,
    press: (re) => { const b = btn('ask', re); return b ? pull('ask', b) != null : false; },
    key: (k) => { const b = dq.domQuadTexture('keyboard')?.dom?.querySelector(`button[data-k="${k}"]`); return b ? pull('keyboard', b) != null : false; },
    // a page-side promise, recorded under `name` when it settles
    track: (name, p) => { globalThis.__r[name] = 'unsettled'; p.then((v) => { globalThis.__r[name] = v; }, (e) => { globalThis.__r[name] = `threw ${e}`; }); return true; },
    pose: () => { const m = dq.domQuadMesh('keyboard'); return m ? [...m.position.toArray(), ...m.quaternion.toArray()].map((x) => +x.toFixed(4)) : null; },
  };
  return true;
});
const S = (what, fn, arg, ms = 15000) => until(what, () => pg.evaluate(fn, arg), { ms });   // a page condition, polled
const R = (name) => pg.evaluate((n) => globalThis.__r[n], name);                            // a tracked promise's value
const settledR = (name, what) => S(what, (n) => globalThis.__r[n] !== 'unsettled' && globalThis.__r[n] !== undefined, name);
const askTitle = () => pg.evaluate(() => globalThis.__px.ask.xrAskState()?.title ?? null);
const asked = (re, what) => S(what, (src) => new RegExp(src, 'i').test(globalThis.__px.ask.xrAskState()?.title ?? ''), re.source);
// in the headset, with the quads mounted (on xr:domquads, after the session starts; each mesh is built when first shown)
const inVR = async () => { await enterVR(pg); await install(); await S('the ask and keyboard quads are mounted', () => ['ask', 'keyboard'].every((id) => globalThis.__px.dq.domQuadIds().includes(id))); };

try {
  await pg.goto(`${world.origin}/?world=staging&name=askprobe&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await visorShown(pg);
  await inVR();

  // C: the guarded action — turning on speech-to-text asks for consent first (audio/voiceconsent.js)
  await pg.evaluate(async () => globalThis.__px.track('c', (await import('./lib/audio/voiceconsent.js')).ensureSttConsent()));
  await asked(/speech-to-text/, 'the consent question is on the ask quad');
  const c = await pg.evaluate(() => ({ state: globalThis.__px.ask.xrAskState(), quadOpen: globalThis.__px.dq.domQuadOpen('ask'), settledEarly: globalThis.__r.c }));
  // on main the native confirm() was dismissed: a silent "no", settled before the question could be read
  c.hit = await pg.evaluate(() => globalThis.__px.press(/turn on/i));
  await settledR('c', 'the consent question answered');
  Object.assign(c, await pg.evaluate(async () => ({ settled: globalThis.__r.c, consented: (await import('./lib/audio/voiceconsent.js')).sttConsented(), after: globalThis.__px.ask.xrAskState(), quadAfter: globalThis.__px.dq.domQuadOpen('ask') })));
  console.log('  · C', JSON.stringify(c));
  check('C1 in a headset, the speech-to-text consent question rides the ask quad', /speech-to-text/i.test(c.state?.title ?? '') && c.quadOpen, JSON.stringify(c.state));
  check('C2 …and waits for an answer (no native dialog quietly answering it)', c.settledEarly === 'unsettled' && !dialogs.some((d) => /^confirm/.test(d)), dialogs.join(' | '));
  check('C3 the trigger on its yes button answers yes, and the consent is recorded', c.hit && c.settled === true && c.consented === true, JSON.stringify({ hit: c.hit, settled: c.settled, consented: c.consented }));
  check('C4 …and the quad goes away', c.after === null && !c.quadAfter);

  // A: a few words asked in a headset (askCenter: the speech-server address, a blueprint's name) — typed on the VR keyboard.
  // First the keyboard's own place on the arc, before a text question moves it under the question
  const kbPose0 = await pg.evaluate(() => { const { dq, pose } = globalThis.__px; dq.domQuadShow('keyboard', true); const p = pose(); dq.domQuadShow('keyboard', false); return p; });
  await pg.evaluate(async () => globalThis.__px.track('a', (await import('./lib/edit/confirmcenter.js')).askCenter({ title: 'Name it', value: '', ok: 'Save' })));
  await asked(/Name it/, 'the text question is on the ask quad');
  const a = await pg.evaluate(() => ({ askState: globalThis.__px.ask.xrAskState(), input: !!globalThis.__px.input() }));
  if (a.input) {
    await pg.evaluate(() => globalThis.__px.pull('ask', globalThis.__px.input()));
    a.kbOpen = await S('the VR keyboard opens for the field', () => globalThis.__px.dq.domQuadOpen('keyboard')).catch(() => false);
    // where the two quads sit (they overlapped on the arc, and the question covered ⌫ and ⏎)
    a.layout = await pg.evaluate(async () => { const THREE = await import('three'); const { dq } = globalThis.__px;
      return Object.fromEntries(['ask', 'keyboard'].map((id) => { const m = dq.domQuadMesh(id); if (!m) return [id, null]; m.updateMatrixWorld(true); const p = new THREE.Vector3(); m.getWorldPosition(p); return [id, { p: p.toArray().map((x) => +x.toFixed(3)), w: +m.geometry.parameters.width.toFixed(3), h: +m.geometry.parameters.height.toFixed(3) }]; })); });
    a.keys = [];
    for (const [k, want] of [['h', 'h'], ['i', 'hi']]) { a.keys.push(await pg.evaluate((x) => globalThis.__px.key(x), k)); await S(`the field reads "${want}"`, (w) => globalThis.__px.input()?.value === w, want).catch(() => {}); }
    a.typed = await pg.evaluate(() => globalThis.__px.input()?.value ?? null);
    a.keys.push(await pg.evaluate(() => globalThis.__px.key('⏎')));
    await settledR('a', 'the text question answered').catch(() => {});
  }
  Object.assign(a, await pg.evaluate(() => ({ words: globalThis.__r.a, askAfter: globalThis.__px.ask.xrAskState(), kbPose1: globalThis.__px.pose(), card: !!document.querySelector('#confirm-center') })));
  console.log('  · A', JSON.stringify(a));
  check('A1 a few words asked in a headset show a text field on the ask quad', a.input && /Name it/.test(a.askState?.title ?? ''), JSON.stringify(a.askState));
  check('A2 …the trigger on it opens the VR keyboard, and its keys and ⏎ answer it', a.kbOpen && a.words === 'hi', JSON.stringify({ kb: a.kbOpen, words: a.words, keys: a.keys, typed: a.typed }));
  check('A3 …and nothing was left on the desk card nobody could see', !a.card && a.askAfter === null);
  check('K1 after a text question the keyboard is back at its own place', !!kbPose0 && JSON.stringify(kbPose0) === JSON.stringify(a.kbPose1), JSON.stringify({ before: kbPose0, after: a.kbPose1 }));

  // ---- the consent edges: a dismissed question is never a remembered answer ----
  const stored = () => pg.evaluate(() => { try { return JSON.parse(localStorage.getItem('eido.audio.prefs') || '{}').sttConsent ?? null; } catch { return 'unreadable'; } });
  const fresh = async () => {   // never asked: no remembered consent, the page reloaded so voiceconsent.js reads that
    if (await pg.evaluate(async () => (await import('./lib/xr/xrask.js')).xrActive())) await exitVR(pg);
    await pg.evaluate(() => localStorage.removeItem('eido.audio.prefs'));
    await pg.reload({ waitUntil: 'domcontentloaded' }); await visorShown(pg); await install();
  };
  const startConsent = () => pg.evaluate(async () => globalThis.__px.track('cr', (await import('./lib/audio/voiceconsent.js')).ensureSttConsent()));

  // S1: leave the headset while the consent question is open
  await fresh(); await inVR();
  await startConsent(); await asked(/speech-to-text/, 'S1: the consent question is open');
  const s1asked = await askTitle();
  await exitVR(pg); await settledR('cr', 'S1: leaving VR answers the open question').catch(() => {});
  const s1 = { asked: s1asked, resolved: await R('cr'), stored: await stored() };
  check('S1 leaving VR mid-consent: the question was open, ensureSttConsent says no for now, and nothing is remembered (sttConsent still null)',
    /speech-to-text/i.test(s1.asked ?? '') && s1.resolved === false && s1.stored === null, JSON.stringify(s1));

  // S2: a moderator's warning arrives while the consent question is open (same page: still never asked)
  await inVR();
  await startConsent(); await asked(/speech-to-text/, 'S2: the consent question is open');
  await pg.evaluate(async () => { (await import('./lib/base.js')).bus.emit('warned', { by: 'Mod Rowan', reason: 'probe' }); return true; });
  // the warning is asked (people.js imports xrask.js first): it either waits in line or replaced the question
  await S('S2: the warning was asked', () => (globalThis.__px.ask.xrAskState()?.waiting ?? 0) > 0 || /moderator/i.test(globalThis.__px.ask.xrAskState()?.title ?? '')).catch(() => {});
  const s2 = { open: await askTitle(), stored: await stored(), resolved: await R('cr') };
  s2.pressed = await pg.evaluate(() => globalThis.__px.press(/not now/i));
  await settledR('cr', 'S2: the consent question answered').catch(() => {});
  s2.after = { stored: await stored(), resolved: await R('cr'), next: await askTitle() };
  check("S2 a warning mid-consent waits behind it: the consent question stays open and unanswered (sttConsent null)",
    /speech-to-text/i.test(s2.open ?? '') && s2.stored === null && s2.resolved === 'unsettled', JSON.stringify(s2));
  check("…then answering it is remembered (Not now → false), and the warning is asked next", s2.pressed && s2.after.stored === false && s2.after.resolved === false && /moderator/i.test(s2.after.next ?? ''), JSON.stringify(s2.after));
  await pg.evaluate(() => globalThis.__px.press(/understand|ok/i));

  // S3: the desk consent card is open when the session starts; then a headset text question answered with the VR keyboard's ⏎
  await fresh(); await startConsent();
  const s3card = await S('S3: the desk consent card is open', () => !!document.querySelector('#confirm-center')).catch(() => false);
  await inVR();
  await pg.evaluate(async () => globalThis.__px.track('w', (await import('./lib/edit/confirmcenter.js')).askCenter({ title: 'Name it', value: '' })));
  await asked(/Name it/, 'S3: the text question is on the ask quad');
  await S('S3: the VR keyboard is up for the field', () => globalThis.__px.dq.domQuadOpen('keyboard'));
  const s3keys = [];
  for (const [k, want] of [['h', 'h'], ['i', 'hi']]) { s3keys.push(await pg.evaluate((x) => globalThis.__px.key(x), k)); await S(`S3: the field reads "${want}"`, (w) => globalThis.__px.input()?.value === w, want).catch(() => {}); }
  s3keys.push(await pg.evaluate(() => globalThis.__px.key('⏎')));
  await settledR('w', 'S3: the text question answered').catch(() => {});
  const s3 = { cardAtStart: s3card, keys: s3keys, words: await R('w'), stored: await stored(), card: await pg.evaluate(() => !!document.querySelector('#confirm-center')) };
  check('S3 a desk consent card open at session start never takes the headset ⏎: sttConsent stays null', s3.cardAtStart && s3.stored === null, JSON.stringify(s3));
  check('…and the headset text question gets "hi"', s3.words === 'hi', JSON.stringify(s3));

  // S4: mic on → off → on while the consent question is open: two ensureSttConsent calls. One question, one answer:
  // a second copy queued behind it would ask again after Turn on, and its Not now would overwrite the yes just given
  const s4pre = { stored: await stored(), open: await askTitle() };
  await pg.evaluate(async () => { const vc = await import('./lib/audio/voiceconsent.js'); globalThis.__px.track('s4a', vc.ensureSttConsent()); globalThis.__px.track('s4b', vc.ensureSttConsent()); return true; });
  await asked(/speech-to-text/, 'S4: the consent question is open');
  const s4 = { q1: await askTitle(), pressed: await pg.evaluate(() => globalThis.__px.press(/turn on/i)) };
  await settledR('s4a', 'S4: the first ask answered');
  // a second copy, had it been queued, is asked the moment the first is settled (xrask.js settle → show)
  s4.afterYes = await pg.evaluate(() => ({ a: globalThis.__r.s4a, b: globalThis.__r.s4b, next: globalThis.__px.ask.xrAskState()?.title ?? null }));
  s4.afterYes.stored = await stored();
  if (s4.afterYes.next) { await pg.evaluate(() => globalThis.__px.press(/not now/i)); await settledR('s4b', 'S4: the copy answered').catch(() => {}); }   // the copy, answered: the stale answer would win
  s4.end = { a: await R('s4a'), b: await R('s4b'), stored: await stored(), next: await askTitle() };
  check('S4 two consent asks while one is open show one question: after Turn on nothing more is asked',
    s4pre.stored === null && !s4pre.open && /speech-to-text/i.test(s4.q1 ?? '') && s4.pressed && s4.afterYes.next === null, JSON.stringify({ s4pre, ...s4 }));
  check('…both callers get the one answer (true), and the stored value is that press', s4.end.a === true && s4.end.b === true && s4.end.stored === true, JSON.stringify(s4.end));

  // S5: mic on → consent question opens → mic off → Turn on. The yes is a real press and is kept, but the mic is off now:
  // the recognizer (SpeechRecognition holds its own capture, audio to the vendor) must not start. A fake transport and a
  // fake recognizer stand in for the SFU bridge and the browser's engine, so the row counts start() calls exactly
  await fresh(); await inVR();
  await pg.evaluate(async () => {
    const f = globalThis.__s5 = { live: false, starts: 0 };
    window.__voiceRelayAbsent = false;
    window.__sfuMic = async () => { f.live = !f.live; return f.live; };
    window.__sfuMicOn = () => f.live;
    window.SpeechRecognition = class { start() { f.starts++; } stop() {} abort() {} };
    globalThis.__px.track('flip', (await import('./lib/audio/mictoggle.js')).flipMic());
    return true;
  });
  await asked(/speech-to-text/, 'S5: the consent question is open');
  const s5 = { q: await askTitle(), liveAtAsk: await pg.evaluate(() => globalThis.__s5.live) };
  await pg.evaluate(async () => { await (await import('./lib/audio/mictoggle.js')).flipMic(); return true; });   // mic off while the question is open
  s5.liveAtPress = await pg.evaluate(() => globalThis.__s5.live);
  s5.pressed = await pg.evaluate(() => globalThis.__px.press(/turn on/i));
  await settledR('flip', 'S5: the first mic-on finished').catch(() => {});
  Object.assign(s5, await pg.evaluate(() => ({ flipped: globalThis.__r.flip === 'unsettled' ? 'unsettled' : 'done', starts: globalThis.__s5.starts, live: globalThis.__s5.live, next: globalThis.__px.ask.xrAskState()?.title ?? null })));
  s5.stored = await stored();
  await pg.evaluate(async () => { (await import('./lib/audio/stt.js')).setSTT(false); return true; });   // tidy: nothing of this row outlives it
  check('S5 mic turned off while the consent question is open, then Turn on: the recognizer never starts',
    /speech-to-text/i.test(s5.q ?? '') && s5.liveAtAsk && !s5.liveAtPress && s5.pressed && s5.flipped === 'done' && s5.starts === 0, JSON.stringify(s5));
  check('…and the consent is still stored (true): that was a real press', s5.stored === true && s5.next === null, JSON.stringify(s5));
  check('no native dialogs at all', dialogs.length === 0, dialogs.join(' | '));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
