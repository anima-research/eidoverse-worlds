// xr-confirm-probe — a question asked in a headset is answered in the headset. The client's yes/no asks went to the
// browser's confirm() (speech-to-text consent, log out, closing the door) or to the DOM centre card, neither of which an
// immersive session draws: the action blocked or quietly said no. Real client + IWER; the answers go through
// domQuadsPick, the same laser path the trigger uses, on the `ask` quad (xr/xrask.js).
//   bun test/client/xr-confirm-probe.mjs
// Then the consent edges (a dismissed question is never a remembered answer): S1 leaving VR mid-question, S2 a moderator's
// warning arriving mid-question, S3 a desk card left open when the session starts and a headset ⏎ elsewhere, S4 two
// consent asks while one is open (mic on → off → on) are one question with one answer.
// Mutations (must go red): in client/lib/edit/confirmcenter.js confirmCenter, drop the `headset?.active()` branch;
// in audio/voiceconsent.js ensureSttConsent, save a dismissal as false; in xr/xrask.js, settle the open question
// instead of queueing (S2); drop the xr:state(true) closeCenter() and the desk card's aimedElsewhere guard (S3).
import { launchBrowser, ownedWorld, checker, iwerInit, visorShown, enterVR, exitVR } from '../harness/probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
await iwerInit(pg);
const errs = [], dialogs = [];
pg.on('pageerror', (e) => errs.push(String(e)));
// a native dialog in a headset is the bug: record it and dismiss it so the page doesn't hang on it
pg.on('dialog', (d) => { dialogs.push(`${d.type()}: ${d.message().slice(0, 60)}`); d.dismiss().catch(() => {}); });
try {
  await pg.goto(`${world.origin}/?world=staging&name=askprobe&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await visorShown(pg);
  await enterVR(pg);
  await pg.waitForTimeout(1500);
  const r = await pg.evaluate(async () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const dq = await import('./lib/xr/domquad.js'); const THREE = await import('three');
    const ask = await import('./lib/xr/xrask.js');
    // no domQuadsSetShown(true): every panel at once covers the keyboard; the ask quad and the keyboard show themselves
    // aim a laser at a DOM point inside quad `id`, pull the trigger: the real pick → mousedown/up/click path
    const meshOf = (id) => dq.domQuadMesh(id);
    const pull = (id, el) => {
      const mesh = meshOf(id), dom = dq.domQuadTexture(id).dom, fr = dom.getBoundingClientRect(), er = el.getBoundingClientRect();
      const u = (er.left + er.width / 2 - fr.left) / fr.width, v = (er.top + er.height / 2 - fr.top) / fr.height;
      const { width: W, height: H } = mesh.geometry.parameters;
      mesh.updateMatrixWorld(true);
      const p = mesh.localToWorld(new THREE.Vector3((u - 0.5) * W, (0.5 - v) * H, 0));
      const q = new THREE.Quaternion(); mesh.getWorldQuaternion(q);
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const ray = { matrixWorld: new THREE.Matrix4().compose(p.clone().addScaledVector(n, 0.5), q, new THREE.Vector3(1, 1, 1)) };
      return dq.domQuadsPick(ray, true);
    };
    const askBtn = (re) => [...(dq.domQuadTexture('ask')?.dom?.querySelectorAll('button') ?? [])].find((b) => re.test(b.textContent) && b.getBoundingClientRect().height > 0);
    const out = {};
    // C: the guarded action — turning on speech-to-text asks for consent first (audio/voiceconsent.js)
    const vc = await import('./lib/audio/voiceconsent.js');
    let settled = null; const p = vc.ensureSttConsent().then((v) => { settled = v; });
    await sleep(600);
    out.state = ask.xrAskState();
    out.quadOpen = dq.domQuadOpen('ask');
    out.settledEarly = settled;   // on main the native confirm() was dismissed: a silent "no"
    const yes = askBtn(/turn on/i);
    out.yesBtn = yes?.textContent ?? null;
    out.hit = yes ? pull('ask', yes) != null : false;
    await Promise.race([p, sleep(1500)]);
    out.settled = settled; out.consented = vc.sttConsented?.() ?? null;
    out.after = ask.xrAskState(); out.quadAfter = dq.domQuadOpen('ask');
    // A: a few words asked in a headset (askCenter: the speech-server address, a blueprint's name) — typed on the VR keyboard
    const cc = await import('./lib/edit/confirmcenter.js');
    // the keyboard's own place on the arc, before a text question moves it under the question
    const pose = () => { const m = dq.domQuadMesh('keyboard'); return m ? [...m.position.toArray(), ...m.quaternion.toArray()].map((x) => +x.toFixed(4)) : null; };
    dq.domQuadShow('keyboard', true); await sleep(200); out.kbPose0 = pose(); dq.domQuadShow('keyboard', false);
    let words; const pa = cc.askCenter({ title: 'Name it', value: '', ok: 'Save' }).then((v) => { words = v; });
    await sleep(600);
    out.askState = ask.xrAskState();
    const inp = dq.domQuadTexture('ask')?.dom?.querySelector('input');
    out.input = !!inp;
    if (inp) {
      pull('ask', inp); await sleep(300);
      out.kbOpen = dq.domQuadOpen('keyboard');
      // where the two quads sit (they overlapped on the arc, and the question covered ⌫ and ⏎)
      out.layout = Object.fromEntries(['ask', 'keyboard'].map((id) => { const m = dq.domQuadMesh(id); if (!m) return [id, null]; m.updateMatrixWorld(true); const p = new THREE.Vector3(); m.getWorldPosition(p); return [id, { p: p.toArray().map((x) => +x.toFixed(3)), w: +m.geometry.parameters.width.toFixed(3), h: +m.geometry.parameters.height.toFixed(3) }]; }));
      const kb = dq.domQuadTexture('keyboard')?.dom;
      out.keys = [];
      for (const k of ['h', 'i', '⏎']) { const b = kb?.querySelector(`button[data-k="${k}"]`); out.keys.push(b ? pull('keyboard', b) : 'none'); out.typed = inp.value; await sleep(150); }
    }
    await Promise.race([pa, sleep(1500)]);
    out.words = words === undefined ? 'unsettled' : words;
    out.askAfter = ask.xrAskState();
    await sleep(100); out.kbPose1 = pose();
    out.card = !!document.querySelector('#confirm-center');
    return out;
  });
  console.log('  ·', JSON.stringify(r));
  check('C1 in a headset, the speech-to-text consent question rides the ask quad', r.state && /speech-to-text/i.test(r.state.title) && r.quadOpen, JSON.stringify(r.state));
  check('C2 …and waits for an answer (no native dialog quietly answering it)', r.settledEarly === null && !dialogs.some((d) => /^confirm/.test(d)), dialogs.join(' | '));
  check('C3 the trigger on its yes button answers yes, and the consent is recorded', r.hit && r.settled === true && r.consented === true, JSON.stringify({ hit: r.hit, settled: r.settled, consented: r.consented, yes: r.yesBtn }));
  check('C4 …and the quad goes away', r.after === null && !r.quadAfter);
  check('A1 a few words asked in a headset show a text field on the ask quad', r.input && r.askState && /Name it/.test(r.askState.title), JSON.stringify(r.askState));
  check('A2 …the trigger on it opens the VR keyboard, and its keys and ⏎ answer it', r.kbOpen && r.words === 'hi', JSON.stringify({ kb: r.kbOpen, words: r.words, keys: r.keys, typed: r.typed }));
  check('A3 …and nothing was left on the desk card nobody could see', !r.card && r.askAfter === null);
  check('K1 after a text question the keyboard is back at its own place', !!r.kbPose0 && JSON.stringify(r.kbPose0) === JSON.stringify(r.kbPose1), JSON.stringify({ before: r.kbPose0, after: r.kbPose1 }));

  // ---- the consent edges: a dismissed question is never a remembered answer ----
  const stored = () => pg.evaluate(() => { try { return JSON.parse(localStorage.getItem('eido.audio.prefs') || '{}').sttConsent ?? null; } catch { return 'unreadable'; } });
  const fresh = async () => {   // never asked: no remembered consent, the page reloaded so voiceconsent.js reads that
    if (await pg.evaluate(async () => (await import('./lib/xr/xrask.js')).xrActive())) await exitVR(pg);
    await pg.evaluate(() => localStorage.removeItem('eido.audio.prefs'));
    await pg.reload({ waitUntil: 'domcontentloaded' }); await visorShown(pg);
  };
  const helpers = () => pg.evaluate(async () => {
    const dq = await import('./lib/xr/domquad.js'); const THREE = await import('three');
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
    globalThis.__px = { pull, press: (re) => { const b = btn('ask', re); return b ? pull('ask', b) != null : false; }, key: (k) => { const b = dq.domQuadTexture('keyboard')?.dom?.querySelector(`button[data-k="${k}"]`); return b ? pull('keyboard', b) != null : false; } };
    return true;
  });
  const askTitle = () => pg.evaluate(async () => (await import('./lib/xr/xrask.js')).xrAskState()?.title ?? null);
  const startConsent = () => pg.evaluate(async () => { const vc = await import('./lib/audio/voiceconsent.js'); globalThis.__cr = 'unsettled'; vc.ensureSttConsent().then((v) => { globalThis.__cr = v; }); return true; });

  // S1: leave the headset while the consent question is open
  await fresh(); await enterVR(pg); await pg.waitForTimeout(1500); await helpers();
  await startConsent(); await pg.waitForTimeout(600);
  const s1asked = await askTitle();
  await exitVR(pg); await pg.waitForTimeout(800);
  const s1 = { asked: s1asked, resolved: await pg.evaluate(() => globalThis.__cr), stored: await stored() };
  check('S1 leaving VR mid-consent: the question was open, ensureSttConsent says no for now, and nothing is remembered (sttConsent still null)',
    /speech-to-text/i.test(s1.asked ?? '') && s1.resolved === false && s1.stored === null, JSON.stringify(s1));

  // S2: a moderator's warning arrives while the consent question is open (same page: still never asked)
  await enterVR(pg); await pg.waitForTimeout(1500); await helpers();
  await startConsent(); await pg.waitForTimeout(600);
  await pg.evaluate(async () => { (await import('./lib/base.js')).bus.emit('warned', { by: 'Mod Rowan', reason: 'probe' }); return true; });
  await pg.waitForTimeout(800);
  const s2 = { open: await askTitle(), stored: await stored(), resolved: await pg.evaluate(() => globalThis.__cr) };
  s2.pressed = await pg.evaluate(() => globalThis.__px.press(/not now/i)); await pg.waitForTimeout(400);
  s2.after = { stored: await stored(), resolved: await pg.evaluate(() => globalThis.__cr), next: await askTitle() };
  check("S2 a warning mid-consent waits behind it: the consent question stays open and unanswered (sttConsent null)",
    /speech-to-text/i.test(s2.open ?? '') && s2.stored === null && s2.resolved === 'unsettled', JSON.stringify(s2));
  check("…then answering it is remembered (Not now → false), and the warning is asked next", s2.pressed && s2.after.stored === false && s2.after.resolved === false && /moderator/i.test(s2.after.next ?? ''), JSON.stringify(s2.after));
  await pg.evaluate(() => globalThis.__px.press(/understand|ok/i));

  // S3: the desk consent card is open when the session starts; then a headset text question answered with the VR keyboard's ⏎
  await fresh(); await startConsent(); await pg.waitForTimeout(400);
  const s3card = await pg.evaluate(() => !!document.querySelector('#confirm-center'));
  await enterVR(pg); await pg.waitForTimeout(1500); await helpers();
  await pg.evaluate(async () => { const cc = await import('./lib/edit/confirmcenter.js'); globalThis.__w = 'unsettled'; cc.askCenter({ title: 'Name it', value: '' }).then((v) => { globalThis.__w = v; }); return true; });
  await pg.waitForTimeout(600);
  const s3keys = await pg.evaluate(async () => { const out = []; for (const k of ['h', 'i', '⏎']) { out.push(globalThis.__px.key(k)); await new Promise((r) => setTimeout(r, 150)); } return out; });
  await pg.waitForTimeout(400);
  const s3 = { cardAtStart: s3card, keys: s3keys, words: await pg.evaluate(() => globalThis.__w), stored: await stored(), card: await pg.evaluate(() => !!document.querySelector('#confirm-center')) };
  check('S3 a desk consent card open at session start never takes the headset ⏎: sttConsent stays null', s3.cardAtStart && s3.stored === null, JSON.stringify(s3));
  check('…and the headset text question gets "hi"', s3.words === 'hi', JSON.stringify(s3));

  // S4: mic on → off → on while the consent question is open: two ensureSttConsent calls. One question, one answer:
  // a second copy queued behind it would ask again after Turn on, and its Not now would overwrite the yes just given
  const s4pre = { stored: await stored(), open: await askTitle() };
  const s4 = await pg.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const vc = await import('./lib/audio/voiceconsent.js'); const ask = await import('./lib/xr/xrask.js');
    const prefs = () => { try { return JSON.parse(localStorage.getItem('eido.audio.prefs') || '{}').sttConsent ?? null; } catch { return 'x'; } };
    let a = 'unsettled', b = 'unsettled';
    vc.ensureSttConsent().then((v) => { a = v; }); await sleep(100);
    vc.ensureSttConsent().then((v) => { b = v; }); await sleep(400);
    const q1 = ask.xrAskState()?.title ?? null;
    const pressed = globalThis.__px.press(/turn on/i); await sleep(400);
    const afterYes = { a, b, stored: prefs(), next: ask.xrAskState()?.title ?? null };
    if (afterYes.next) { globalThis.__px.press(/not now/i); await sleep(400); }   // the copy, answered: the stale answer would win
    return { q1, pressed, afterYes, end: { a, b, stored: prefs(), next: ask.xrAskState()?.title ?? null } };
  });
  check('S4 two consent asks while one is open show one question: after Turn on nothing more is asked',
    s4pre.stored === null && !s4pre.open && /speech-to-text/i.test(s4.q1 ?? '') && s4.pressed && s4.afterYes.next === null, JSON.stringify({ s4pre, ...s4 }));
  check('…both callers get the one answer (true), and the stored value is that press', s4.end.a === true && s4.end.b === true && s4.end.stored === true, JSON.stringify(s4.end));
  check('no native dialogs at all', dialogs.length === 0, dialogs.join(' | '));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
