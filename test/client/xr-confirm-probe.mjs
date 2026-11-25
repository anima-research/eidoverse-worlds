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
// Review #359's rows carry its finding ids: D the desk card's keys, turn and limits; A4/A5 the VR keyboard; Q1/Q2 a
// press and its question; L a lock question that waited; R the real callers (reverting one turns its row red).
// Mutations (must go red): in client/lib/edit/confirmcenter.js confirmCenter, drop the `headset?.active()` branch;
// in audio/voiceconsent.js ensureSttConsent, save a dismissal as false; in xr/xrask.js, settle the open question
// instead of queueing (S2); drop the xr:state(true) closeCenter() (S3a, alone: S3's later rows stay green, a headset
// question closing the card too) and the desk card's aimedElsewhere guard (S3).
// XH/DH (a press counts from when it began): in xr/xrask.js `pressedAt` returns inputAt(e) (XH, XH2); in
// edit/confirmcenter.js arm()'s `clicked` returns armed(e) (DH, DH2). XS: in xrask.js show(), stamp shownAt = performance.now().
// E3/E4: drop `!e.repeat` from Escape in confirmCenter's onKey (E3) and from the quad buttons' Escape (E4).
// DS–DS4 (Space held from before a desk card): in confirmcenter.js arm()'s `spaced`, return on a repeat first.
// XT (the question on the quad's texture before its arm time): in xrask.js show(), showXRPanel('ask', true) before repaint().
import { launchBrowser, ownedWorld, checker, iwerInit, visorShown, enterVR, exitVR } from '../harness/probe-harness.mjs';
import { until, pause } from '../gate/wait.ts';
const { check, done } = checker();
const world = await ownedWorld({ owner: 'askprobe', env: { TRUST_NAMES: '1' } });   // the page owns staging: it may build, lock and close the door
const { browser, page } = await launchBrowser(); const pg = await page();
await iwerInit(pg, { cloud: 'off' });   // the sky guard: no cloud bake, whose shaders stall a software-rendered loop for minutes
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
  // a hand ray aimed at DOM point `pt` (client coords of the offscreen frame) on quad `id`
  const ray = (id, pt) => {
    const mesh = dq.domQuadMesh(id), dom = dq.domQuadTexture(id).dom, fr = dom.getBoundingClientRect();
    const u = (pt.x - fr.left) / fr.width, v = (pt.y - fr.top) / fr.height;
    const { width: W, height: H } = mesh.geometry.parameters; mesh.updateMatrixWorld(true);
    const p = mesh.localToWorld(new THREE.Vector3((u - 0.5) * W, (0.5 - v) * H, 0));
    const q = new THREE.Quaternion(); mesh.getWorldQuaternion(q);
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    return { matrixWorld: new THREE.Matrix4().compose(p.clone().addScaledVector(n, 0.5), q, new THREE.Vector3(1, 1, 1)) };
  };
  const pull = (id, el) => { const er = el.getBoundingClientRect(); return dq.domQuadsPick(ray(id, { x: er.left + er.width / 2, y: er.top + er.height / 2 }), true); };
  const btn = (id, re) => [...(dq.domQuadTexture(id)?.dom?.querySelectorAll('button') ?? [])].find((b) => re.test(b.textContent) && b.getBoundingClientRect().height > 0);
  const input = () => dq.domQuadTexture('ask')?.dom?.querySelector('input') ?? null;
  globalThis.__r ??= {};   // kept across a session start (S3 reads what entering VR did to a question asked before it)
  globalThis.__px = {
    dq, ask, ray, pull, btn, input,
    press: (re) => { const b = btn('ask', re); return b ? pull('ask', b) != null : false; },
    key: (k) => { const b = dq.domQuadTexture('keyboard')?.dom?.querySelector(`button[data-k="${k}"]`); return b ? pull('keyboard', b) != null : false; },
    // a page-side promise, recorded under `name` when it settles
    track: (name, p) => { globalThis.__r[name] = 'unsettled'; p.then((v) => { globalThis.__r[name] = v; }, (e) => { globalThis.__r[name] = `threw ${e}`; }); return true; },
    pose: () => { const m = dq.domQuadMesh('keyboard'); return m ? [...m.position.toArray(), ...m.quaternion.toArray()].map((x) => +x.toFixed(4)) : null; },
  };
  return true;
});
// a software-rendered XR loop can stall for minutes on a GPU-less host (a shader link): a wait that needs a frame drawn waits that out
const S = (what, fn, arg, ms = 15000) => until(what, () => pg.evaluate(fn, arg), { ms });   // a page condition, polled
// a key held down, as the OS sends it: its first keydown, then (repeat) more keydowns with no keyup between
const ENTER = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
const enterDown = (repeat = false) => pg.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER, text: '\r', autoRepeat: repeat });
const enterUp = () => pg.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
const ESC = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
const escDown = (repeat = false) => pg.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...ESC, autoRepeat: repeat });
const escUp = () => pg.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...ESC });
const SP = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
const spDown = (repeat = false) => pg.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...SP, text: ' ', autoRepeat: repeat });
const spUp = () => pg.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...SP });
const R = (name) => pg.evaluate((n) => globalThis.__r[n], name);                            // a tracked promise's value
const settledR = (name, what) => S(what, (n) => globalThis.__r[n] !== 'unsettled' && globalThis.__r[n] !== undefined, name);
const askTitle = () => pg.evaluate(() => globalThis.__px.ask.xrAskState()?.title ?? null);
// …and drawn: a press in the frame that showed it doesn't count (xrask.js answer), as no person could have seen it yet
const asked = (re, what) => S(what, (src) => { const st = globalThis.__px.ask.xrAskState(); return new RegExp(src, 'i').test(st?.title ?? '') && st.live !== false; }, re.source, 240000);
// in the headset, with the quads mounted (on xr:domquads, after the session starts; each mesh is built when first shown)
const inVR = async () => { await enterVR(pg); await install(); await S('the ask and keyboard quads are mounted', () => ['ask', 'keyboard'].every((id) => globalThis.__px.dq.domQuadIds().includes(id))); };

const stored = () => pg.evaluate(() => { try { return JSON.parse(localStorage.getItem('eido.audio.prefs') || '{}').sttConsent ?? null; } catch { return 'unreadable'; } });
const fresh = async () => {   // never asked: no remembered consent, the page reloaded so voiceconsent.js reads that
  if (await pg.evaluate(async () => (await import('./lib/xr/xrask.js')).xrActive())) await exitVR(pg);
  await pg.evaluate(() => localStorage.removeItem('eido.audio.prefs'));
  await pg.reload({ waitUntil: 'domcontentloaded' }); await visorShown(pg); await install();
};

try {
  await pg.goto(`${world.origin}/?world=staging&name=askprobe&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await visorShown(pg);

  // D (review #359 1): the desk card keeps the keyboard. Focus sent elsewhere (another control, the canvas) comes back to
  // the card, so a real Escape still answers it and a walking key never reaches the body behind it; Tab stays on the card
  await install();
  await pg.evaluate(async () => { const { bus } = await import('./lib/base.js'); globalThis.__keys = 0; bus.on('key', () => { globalThis.__keys++; }); return true; });
  const d = {};
  await pg.evaluate(async () => globalThis.__px.track('d1', (await import('./lib/edit/confirmcenter.js')).confirmCenter({ title: 'Desk question' })));
  await S('D: the desk card is open', () => !!document.querySelector('#confirm-center'));
  await pg.evaluate(() => { const b = document.createElement('button'); b.id = 'probe-elsewhere'; b.textContent = 'elsewhere'; document.body.append(b); b.focus(); return true; });   // another control takes focus
  d.keys0 = await pg.evaluate(() => globalThis.__keys);
  await pg.keyboard.press('KeyW');
  d.keys1 = await pg.evaluate(() => globalThis.__keys);
  await pg.keyboard.press('Escape');
  await pg.evaluate(() => { document.querySelector('#probe-elsewhere')?.remove(); return true; });
  d.d1 = await settledR('d1', 'D: Escape answers the desk card').then(() => R('d1'), () => 'unsettled');
  await pg.evaluate(async () => globalThis.__px.track('d3', (await import('./lib/edit/confirmcenter.js')).askCenter({ title: 'Desk name' })));
  await S('D: the desk text card is open', () => !!document.querySelector('#confirm-center input'));
  d.tabs = [];
  for (let i = 0; i < 4; i++) { await pg.keyboard.press('Tab'); d.tabs.push(await pg.evaluate(() => !!document.activeElement?.closest?.('#confirm-center'))); }
  await pg.keyboard.press('Escape');
  d.d3 = await settledR('d3', 'D: Escape answers the desk text card').then(() => R('d3'), () => 'unsettled');
  console.log('  · D', JSON.stringify(d));
  check('D1 a desk card whose focus was taken elsewhere: a real Escape still answers it (no)', d.d1 === false, JSON.stringify(d));
  check('D2 …and a walking key pressed meanwhile never reaches the body', d.keys1 === d.keys0, JSON.stringify(d));
  check('D3 Tab walks the desk text card (field, Cancel, Save) and never leaves it', d.tabs.every(Boolean) && d.d3 === null, JSON.stringify(d.tabs));

  // D1–D3 hold while either of the card's two guards does (each covers for the other); D6 and D7 pin each one alone.
  // D6, a real key goes to the card wherever it was aimed (aimedElsewhere's `!e.isTrusted`): focus moved off the card
  // without a focusin reaching holdFocus (here a listener swallows it, as a page script may), and a walking key still
  // never reaches the body, a real Escape still answers. Mutation: drop `!e.isTrusted &&` from aimedElsewhere
  await pg.evaluate(async () => { globalThis.__swallow = (e) => e.stopImmediatePropagation(); addEventListener('focusin', globalThis.__swallow, true);
    globalThis.__px.track('d6', (await import('./lib/edit/confirmcenter.js')).confirmCenter({ title: 'Desk question' }));
    const b = document.createElement('button'); b.id = 'probe-elsewhere'; b.textContent = 'elsewhere'; document.body.append(b); b.focus(); return true; });
  const d6 = { away: await pg.evaluate(() => document.activeElement?.id ?? null), keys0: await pg.evaluate(() => globalThis.__keys) };
  await pg.keyboard.press('KeyW'); d6.keys1 = await pg.evaluate(() => globalThis.__keys);
  await pg.keyboard.press('Escape');
  d6.answer = await settledR('d6', 'D6: Escape answers the desk card').then(() => R('d6'), () => 'unsettled');
  await pg.evaluate(() => { removeEventListener('focusin', globalThis.__swallow, true); document.querySelector('#probe-elsewhere')?.remove(); return true; });
  if (d6.answer === 'unsettled') await pg.evaluate(async () => { (await import('./lib/edit/confirmcenter.js')).closeCenter(); return true; });
  check('D6 focus off the desk card with no focusin heard: a walking key still never reaches the body, and a real Escape answers (no)', d6.away === 'probe-elsewhere' && d6.keys1 === d6.keys0 && d6.answer === false, JSON.stringify(d6));
  // D7, focus taken off the card comes back to it (holdFocus): letters typed after a control elsewhere took focus go into
  // the card's field, never into that control (the chat line, a name field behind the card). Mutation: holdFocus returns
  // a no-op without listening
  await pg.evaluate(async () => { globalThis.__px.track('d7', (await import('./lib/edit/confirmcenter.js')).askCenter({ title: 'Desk name', value: '' }));
    const i = document.createElement('input'); i.id = 'probe-behind'; document.body.append(i); i.focus(); return true; });
  await pg.keyboard.type('ab');
  const d7 = await pg.evaluate(() => ({ behind: document.querySelector('#probe-behind')?.value ?? null, card: document.querySelector('#confirm-center input')?.value ?? null }));
  await pg.keyboard.press('Escape');
  d7.answer = await settledR('d7', 'D7: Escape answers the desk text card').then(() => R('d7'), () => 'unsettled');
  await pg.evaluate(() => { document.querySelector('#probe-behind')?.remove(); return true; });
  check('D7 letters typed after a control behind the desk text card took focus go into the card\'s field, not that control', d7.behind === '' && d7.card === 'ab' && d7.answer === null, JSON.stringify(d7));

  // D4 (review #359 10): the speech server's address, from the real caller (audio/ttsrow.js addEndpoint), is as long as
  // it is: main's prompt() had no limit, and a signed URL runs past 300 characters
  await pg.evaluate(async () => { const host = document.createElement('div'); host.id = 'probe-tts'; document.body.append(host); (await import('./lib/audio/ttsrow.js')).ttsSection(host); return true; });
  await S('D4: the voice list offers "add a speech server"', () => [...document.querySelectorAll('#probe-tts .vl-add')].some((r) => /speech server/.test(r.textContent)));
  await pg.evaluate(() => { [...document.querySelectorAll('#probe-tts .vl-add')].find((r) => /speech server/.test(r.textContent)).click(); return true; });
  await S('D4: the speech server is asked on the desk card', () => /speech server/i.test(document.querySelector('#confirm-center #cc-title')?.textContent ?? ''));
  const long = 'ws://127.0.0.1:8927/?sig=' + 'a'.repeat(300);
  await pg.evaluate(() => { const i = document.querySelector('#confirm-center input'); i.focus(); i.select(); return true; });
  await pg.keyboard.insertText(long);
  const typedLen = await pg.evaluate(() => document.querySelector('#confirm-center input')?.value.length ?? -1);
  await pg.keyboard.press('Escape');
  await pg.evaluate(() => { document.querySelector('#probe-tts')?.remove(); return true; });
  check('D4 a speech server address longer than 300 characters is typed whole into the desk card', typedLen === long.length, `${typedLen} of ${long.length}`);

  // D5 (cold read of #359's fixes): a question can't be answered in its first moment (confirmcenter.js ARM_MS). An Enter
  // that lands as the desk consent card appears was meant for what was there before (sending a chat line, a card that
  // just closed): on its focused Not now it was a remembered no that nobody gave. Ignored, not queued: the card stays
  // open, unanswered, and later answers only what is pressed then
  await pg.evaluate(async () => { const vc = await import('./lib/audio/voiceconsent.js'); globalThis.__d5key = null;
    addEventListener('keydown', (e) => { if (e.key === 'Enter' && globalThis.__d5key === null) globalThis.__d5key = Math.round(e.timeStamp - globalThis.__d5at); }, { capture: true, once: true });
    globalThis.__d5at = performance.now(); return globalThis.__px.track('d5', vc.ensureSttConsent()); });
  await pg.keyboard.press('Enter');   // at once: nothing waited on between the card appearing and the key
  const d5 = { ms: await pg.evaluate(() => globalThis.__d5key), early: await R('d5'), open: await pg.evaluate(() => /speech-to-text/i.test(document.querySelector('#confirm-center #cc-title')?.textContent ?? '')), stored: await stored() };
  if (d5.open) {
    await S('D5: the desk consent card can be answered now', () => document.querySelector('#confirm-center')?.dataset.armed !== undefined).catch(() => {});
    d5.armed = await R('d5');   // still unanswered once it can be: the early key was dropped, not kept for later
    await pg.keyboard.press('Escape');   // a dismissal: no for now, nothing remembered
    d5.after = await settledR('d5', 'D5: Escape answers the desk consent card').then(() => R('d5'), () => 'unsettled');
  }
  d5.storedAfter = await stored();
  console.log('  · D5', JSON.stringify(d5));
  check('D5 an Enter as the desk consent card appears answers nothing (the card stays open, sttConsent null)', d5.early === 'unsettled' && d5.open && d5.stored === null, JSON.stringify(d5));
  check('…and is not kept for later: once the card can be answered it is still unanswered, and Escape then is no for now, nothing stored', d5.armed === 'unsettled' && d5.after === false && d5.storedAfter === null, JSON.stringify(d5));
  if (d5.storedAfter !== null) await fresh();   // a remembered answer would skip every consent row below

  // E1 (cold read): Enter held down answers one desk card, never the next one in line. Its auto-repeat starts ~500 ms
  // later, past the next card's arm time, and lands on that card's home button (OK on a confirmCenter card)
  const deskArmed = (t) => S(`E1: the desk card "${t}" can be answered`, (src) => document.querySelector('#confirm-center #cc-title')?.textContent === src && document.querySelector('#confirm-center')?.dataset.armed !== undefined, t);
  await pg.evaluate(async () => { const C = await import('./lib/edit/confirmcenter.js'); globalThis.__px.track('e1a', C.confirmCenter({ title: 'Held A' })); globalThis.__px.track('e1b', C.confirmCenter({ title: 'Held B' })); return true; });
  await deskArmed('Held A'); await enterDown();
  await settledR('e1a', 'E1: the first card answered').catch(() => {});
  const e1 = { a: await R('e1a') };
  await deskArmed('Held B').catch(() => {});
  await enterDown(true); await enterDown(true); await enterUp();
  e1.b = await R('e1b');
  if (e1.b === 'unsettled') { await pg.keyboard.press('Escape'); await settledR('e1b', 'E1: Escape answers the second card').catch(() => {}); }
  console.log('  · E1', JSON.stringify(e1));
  check('E1 Enter held down answers the desk card it was pressed on (yes), and its auto-repeat never answers the next one', e1.a === true && e1.b === 'unsettled', JSON.stringify(e1));
  // E3 (cold review of the arm time): Escape held likewise dismisses one desk card, never the next one in line
  await pg.evaluate(async () => { const C = await import('./lib/edit/confirmcenter.js'); globalThis.__px.track('e3a', C.confirmCenter({ title: 'Esc A' })); globalThis.__px.track('e3b', C.confirmCenter({ title: 'Esc B' })); return true; });
  await deskArmed('Esc A'); await escDown();
  await settledR('e3a', 'E3: the first card dismissed').catch(() => {});
  const e3 = { a: await R('e3a') };
  await deskArmed('Esc B').catch(() => {});
  await escDown(true); await escDown(true); await escUp();
  e3.b = await R('e3b');
  if (e3.b === 'unsettled') { await pg.keyboard.press('Escape'); await settledR('e3b', 'E3: Escape dismisses the second card').catch(() => {}); }
  console.log('  · E3', JSON.stringify(e3));
  check('E3 Escape held down dismisses the desk card it was pressed on (no), and its auto-repeat never the next one', e3.a === false && e3.b === 'unsettled', JSON.stringify(e3));

  // DS (cold review of the press time): Space is the jump key, so it is often down as a card opens. Its first keydown
  // went to the page; its auto-repeat lands on the button the card focused, and Blink clicks that button at the keyup
  // (a trusted click, detail 0). That press began before the card was there: let go once the card can be answered, it
  // answers nothing. Real keys (CDP), the three shapes of card: confirmCenter (OK focused), the consent question (Not now
  // focused: a remembered no), the lock question (✓ Move anyway focused: a write through the lock).
  // Mutation: confirmcenter.js arm()'s `spaced` ignores repeats (`if (e.repeat) return;` first)
  const deskOpen = (kind) => pg.evaluate(async (k) => {
    const C = await import('./lib/edit/confirmcenter.js'), vc = await import('./lib/audio/voiceconsent.js');
    const p = k === 'confirm' ? C.confirmCenter({ title: 'Log out?' })
      : k === 'lock' ? C.chooseCenter({ title: 'This thing is locked', choices: [{ v: 'through', label: '✓ Move anyway' }, { v: 'cancel', label: '✕ Cancel' }, { v: 'unlock', label: '🔓 Unlock, then Move' }], cancel: 'cancel' })
      : vc.ensureSttConsent();
    return globalThis.__px.track('ds', p);
  }, kind);
  const deskCanAnswer = () => pg.evaluate(() => document.querySelector('#confirm-center')?.dataset.armed !== undefined);
  // the OS's auto-repeat (~30 a second) until the card can be answered, and one more
  const repeatUntilArmed = async () => { let n = 0; for (; n < 600 && !(await deskCanAnswer()); n++) { await spDown(true); await pause('the OS auto-repeat cadence of a held key', 30); } await spDown(true); return n; };
  const closeDesk = () => pg.evaluate(async () => { (await import('./lib/edit/confirmcenter.js')).closeCenter(); return true; });
  for (const [tag, kind] of [['DS', 'confirm'], ['DS2', 'consent'], ['DS3', 'lock']]) {
    await pg.evaluate(() => { document.activeElement?.blur?.(); return true; });
    await spDown();   // the first keydown: the page's (a jump)
    await deskOpen(kind);
    const ds = { repeats: await repeatUntilArmed(), focused: await pg.evaluate(() => document.activeElement?.textContent ?? null) };
    await spUp(); await pause('the row is that nothing answers: a click the keyup fired has had time to land', 150);
    Object.assign(ds, { answer: await R('ds'), open: await pg.evaluate(() => !!document.querySelector('#confirm-center')), stored: await stored() });
    console.log(`  · ${tag}`, JSON.stringify(ds));
    check(`${tag} Space held from before a desk card (${ds.focused} focused) and let go once it can be answered answers nothing${kind === 'consent' ? ' (sttConsent null)' : ''}`,
      ds.repeats > 0 && ds.answer === 'unsettled' && ds.open && (kind !== 'consent' || ds.stored === null), JSON.stringify(ds));
    await closeDesk();
    if ((await stored()) !== null) await fresh();   // each row starts never asked
  }
  // the control: a Space begun on a card once it can be answered, held a moment (repeats), is its answer
  { await deskOpen('confirm');
    await S('DS: the control card can be answered', () => document.querySelector('#confirm-center')?.dataset.armed !== undefined);
    await spDown(); await spDown(true); await spDown(true); await spUp();
    const dsc = await settledR('ds', 'DS: a Space begun on the card answers it').then(() => R('ds'), () => 'unsettled');
    check('…while a Space begun on the card once it can be answered, held a moment, is its answer (yes)', dsc === true, JSON.stringify(dsc));
    await closeDesk();
  }
  // DS4: the same held Space, and meanwhile a real mouse press on the consent card's Turn on, let go off it (the way a
  // person takes back a click: nothing clicked). The press focused Turn on, so Space's keyup clicks it: the click is
  // still the held Space's, begun before the card, not the mouse's
  { await pg.evaluate(() => { document.activeElement?.blur?.(); return true; });
    await spDown(); await deskOpen('consent');
    const ds4 = { repeats: await repeatUntilArmed() };
    const at = (sel) => pg.evaluate((s) => { const el = [...document.querySelectorAll('#confirm-center button, #confirm-center #cc-title')].find((b) => new RegExp(s, 'i').test(b.textContent)); const r = el?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; }, sel);
    const on = await at('^turn on$'), off = await at('speech-to-text');
    await pg.mouse.move(on.x, on.y); await pg.mouse.down(); await pg.mouse.move(off.x, off.y); await pg.mouse.up();
    ds4.afterMouse = await R('ds');
    await spDown(true); await spDown(true);
    ds4.focused = await pg.evaluate(() => document.activeElement?.textContent ?? null);
    await spUp(); await pause('the row is that nothing answers: a click the keyup fired has had time to land', 150);
    Object.assign(ds4, { answer: await R('ds'), stored: await stored() });
    console.log('  · DS4', JSON.stringify(ds4));
    check('DS4 Space held from before the consent card, a mouse press on Turn on let go off it, then Space let go: answers nothing (sttConsent null)',
      ds4.afterMouse === 'unsettled' && ds4.answer === 'unsettled' && ds4.stored === null, JSON.stringify(ds4));
    await closeDesk();
    if ((await stored()) !== null) await fresh();   // a remembered answer would skip every consent row below
  }
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

  // A4 (review #359 2): a text question answered with the laser on its OK, not the keyboard's ⏎: the keyboard goes with it.
  // Left up, it typed into the chat line (its field was gone) and its ⏎ sent that
  await pg.evaluate(async () => globalThis.__px.track('a4', (await import('./lib/edit/confirmcenter.js')).askCenter({ title: 'Name it again', value: '', ok: 'Save' })));
  await asked(/Name it again/, 'A4: the text question is on the ask quad');
  await pg.evaluate(() => globalThis.__px.pull('ask', globalThis.__px.input()));
  await S('A4: the VR keyboard is up for the field', () => globalThis.__px.dq.domQuadOpen('keyboard'));
  await pg.evaluate(() => globalThis.__px.key('o'));
  await S('A4: the field reads "o"', () => globalThis.__px.input()?.value === 'o');
  const a4 = { pressed: await pg.evaluate(() => globalThis.__px.press(/^save$/i)) };
  await settledR('a4', 'A4: the text question answered').catch(() => {});
  Object.assign(a4, await pg.evaluate(() => { const chat = document.getElementById('chatline'); const before = chat?.value ?? null;
    const typed = globalThis.__px.key('x'); return { words: globalThis.__r.a4, kbOpen: globalThis.__px.dq.domQuadOpen('keyboard'), typed, chatBefore: before, chatAfter: chat?.value ?? null }; }));
  check('A4 a text question answered by its OK button takes the VR keyboard with it (nothing typed into chat after)', a4.pressed && a4.words === 'o' && !a4.kbOpen && !a4.typed && a4.chatAfter === a4.chatBefore, JSON.stringify(a4));

  // A5 (review #359 9): the headset field keeps the desk's limit (askCenter's max): the VR keyboard's keys stop at it
  await pg.evaluate(async () => globalThis.__px.track('a5', (await import('./lib/edit/confirmcenter.js')).askCenter({ title: 'Three letters', value: '', max: 3 })));
  await asked(/Three letters/, 'A5: the text question is on the ask quad');
  await pg.evaluate(() => globalThis.__px.pull('ask', globalThis.__px.input()));
  await S('A5: the VR keyboard is up for the field', () => globalThis.__px.dq.domQuadOpen('keyboard'));
  for (const k of ['h', 'i', 'x', 'y']) await pg.evaluate((x) => globalThis.__px.key(x), k);
  const a5typed = await pg.evaluate(() => globalThis.__px.input()?.value ?? null);
  await pg.evaluate(() => globalThis.__px.key('⏎'));
  await settledR('a5', 'A5: the text question answered').catch(() => {});
  check('A5 a headset text question with max 3: four VR keys type three letters, and the answer is those', a5typed === 'hix' && (await R('a5')) === 'hix', JSON.stringify({ typed: a5typed, words: await R('a5') }));

  // Q1 (review #359 17): a headset chooseCenter answers with the choice's own value, as the desk card does (1, not "1")
  await pg.evaluate(async () => globalThis.__px.track('q1', (await import('./lib/edit/confirmcenter.js')).chooseCenter({ title: 'Which kind', choices: [{ v: 1, label: 'one' }, { v: true, label: 'yes' }], cancel: 0 })));
  await asked(/Which kind/, 'Q1: the question is on the ask quad');
  await pg.evaluate(() => globalThis.__px.press(/^one$/));
  await settledR('q1', 'Q1: answered').catch(() => {});
  const q1 = await R('q1');
  check('Q1 a headset choice of value 1 answers 1 (a number), not "1"', q1 === 1, JSON.stringify(q1));

  // Q2 (review #359 16): two questions in line, the same buttons in the same place. Both hands on "Move anyway" in one
  // frame: the first press answers the first question; the second must not answer the next one, which nobody has seen yet
  await pg.evaluate(async () => { const ask = globalThis.__px.ask; const q = () => ask.chooseXR({ title: 'Same place', choices: [{ v: 'through', label: 'Move anyway' }, { v: 'cancel', label: 'Cancel' }], cancel: 'cancel' });
    globalThis.__px.track('q2a', q()); globalThis.__px.track('q2b', q()); return true; });
  await asked(/Same place/, 'Q2: the first question is on the ask quad');
  const q2 = await pg.evaluate(() => { const a = globalThis.__px.press(/move anyway/i), b = globalThis.__px.press(/move anyway/i); return { a, b }; });   // one frame: no await between
  await settledR('q2a', 'Q2: the first question answered').catch(() => {});
  Object.assign(q2, { first: await R('q2a'), second: await R('q2b'), next: await askTitle() });
  await asked(/Same place/, 'Q2: the second question is drawn').catch(() => {});
  await pg.evaluate(() => globalThis.__px.press(/move anyway/i));
  q2.later = await settledR('q2b', 'Q2: the second question answered').then(() => R('q2b'), () => 'unsettled');
  check('Q2 two presses in one frame on two queued questions answer only the one that was drawn', q2.first === 'through' && q2.second === 'unsettled' && /Same place/.test(q2.next ?? ''), JSON.stringify(q2));
  check('…and the next one is answered by a press once it is drawn', q2.later === 'through', JSON.stringify(q2));

  // E2 (cold read): the same in the headset (a keyboard on PCVR): the quad focuses OK, so a held Enter's repeat would close
  // the next question in line, a door or a log out, as nobody chose
  await pg.evaluate(() => { const q = (t) => globalThis.__px.ask.chooseXR({ title: t, choices: [{ v: 'ok', label: 'OK' }, { v: 'cancel', label: 'Cancel' }], cancel: 'cancel', focus: 'ok' });
    globalThis.__px.track('e2a', q('Held in VR A')); globalThis.__px.track('e2b', q('Held in VR B')); return true; });
  await asked(/Held in VR A/, 'E2: the first question can be answered');
  await enterDown();
  await settledR('e2a', 'E2: the first question answered').catch(() => {});
  const e2 = { a: await R('e2a') };
  await asked(/Held in VR B/, 'E2: the second question can be answered').catch(() => {});
  e2.focused = await pg.evaluate(() => document.activeElement?.textContent ?? null);
  await enterDown(true); await enterDown(true); await enterUp();
  e2.b = await R('e2b');
  if (e2.b === 'unsettled') { await pg.evaluate(() => globalThis.__px.press(/^cancel$/i)); await settledR('e2b', 'E2: the second question answered').catch(() => {}); }
  console.log('  · E2', JSON.stringify(e2));
  check('E2 Enter held down in a headset answers the question it was pressed on, and its auto-repeat never answers the next one (focused on OK)', e2.a === 'ok' && e2.focused === 'OK' && e2.b === 'unsettled', JSON.stringify(e2));
  // E4: Escape held in a headset, likewise: one question's cancel, never the next one's
  await pg.evaluate(() => { const q = (t) => globalThis.__px.ask.chooseXR({ title: t, choices: [{ v: 'ok', label: 'OK' }, { v: 'cancel', label: 'Cancel' }], cancel: 'cancel', focus: 'ok' });
    globalThis.__px.track('e4a', q('Esc in VR A')); globalThis.__px.track('e4b', q('Esc in VR B')); return true; });
  await asked(/Esc in VR A/, 'E4: the first question can be answered');
  await escDown();
  await settledR('e4a', 'E4: the first question dismissed').catch(() => {});
  const e4 = { a: await R('e4a') };
  await asked(/Esc in VR B/, 'E4: the second question can be answered').catch(() => {});
  e4.focused = await pg.evaluate(() => document.activeElement?.textContent ?? null);
  await escDown(true); await escDown(true); await escUp();
  e4.b = await R('e4b');
  if (e4.b === 'unsettled') { await pg.evaluate(() => globalThis.__px.press(/^cancel$/i)); await settledR('e4b', 'E4: the second question answered').catch(() => {}); }
  console.log('  · E4', JSON.stringify(e4));
  check('E4 Escape held down in a headset dismisses the question it was pressed on, and its auto-repeat never the next one', e4.a === 'cancel' && e4.focused === 'OK' && e4.b === 'unsettled', JSON.stringify(e4));

  // ---- the consent edges: a dismissed question is never a remembered answer ----
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
  // (review #359 8) answered with a keyboard's Enter: the headset question focuses its safe choice (Not now), as the desk card does
  s2.focused = await pg.evaluate(() => document.activeElement?.textContent ?? null);
  await pg.keyboard.press('Enter'); s2.pressed = true;
  await settledR('cr', 'S2: the consent question answered').catch(() => {});
  s2.after = { stored: await stored(), resolved: await R('cr'), next: await askTitle() };
  check("S2 a warning mid-consent waits behind it: the consent question stays open and unanswered (sttConsent null)",
    /speech-to-text/i.test(s2.open ?? '') && s2.stored === null && s2.resolved === 'unsettled', JSON.stringify(s2));
  check("…then Enter on its focused Not now answers it, remembered (false), and the warning is asked next", s2.pressed && s2.after.stored === false && s2.after.resolved === false && /moderator/i.test(s2.after.next ?? ''), JSON.stringify(s2.after));
  await pg.evaluate(() => globalThis.__px.press(/understand|ok/i));

  // S3: the desk consent card is open when the session starts; then a headset text question answered with the VR keyboard's ⏎
  await fresh(); await startConsent();
  const s3card = await S('S3: the desk consent card is open', () => !!document.querySelector('#confirm-center')).catch(() => false);
  await inVR();
  // (review #359 3) read before anything else is asked: a headset question closes the desk card too, so a row read after
  // one can't tell whether entering VR did
  const s3enter = await pg.evaluate(() => ({ card: !!document.querySelector('#confirm-center'), consent: globalThis.__r.cr }));
  check('S3a entering VR dismisses the open desk card by itself (a dismissal: no for now, nothing stored)', s3card && !s3enter.card && s3enter.consent === false && (await stored()) === null, JSON.stringify(s3enter));
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

  // ---- the lock question in line behind another (review #359 14, 15): it may be answered long after it was asked ----
  const req = (verb, args) => pg.evaluate(async ([v, a]) => { const r = await (await import('./lib/net.js')).sendRequest(v, a); return { ok: r.ok, refused: r.refused?.code ?? null, ids: r.ids ?? null }; }, [verb, args]);
  // the authority mints a thing's id: '$lkp' is the request's placeholder, and the page keeps the id it became (__lk)
  const made = await req('create', { id: '$lkp', components: { transform: { pos: [3, 0, 3], q: [0, 0, 0, 1], scale: [1, 1, 1] }, label: 'lock probe' } });
  const LK = made.ids?.$lkp ?? null;
  await pg.evaluate((id) => { globalThis.__lk = id; return true; }, LK);
  const lockedNow = () => pg.evaluate(async () => !!(await import('./lib/edit/writes.js')).compsOf(globalThis.__lk)?.lock);
  const lk0 = await req('set', { id: LK, component: 'lock', value: true });
  await S('L: the lock is in the fold', async () => !!(await import('./lib/edit/writes.js')).compsOf(globalThis.__lk)?.lock).catch(() => {});
  const blocker = (name) => pg.evaluate((n) => globalThis.__px.track(n, globalThis.__px.ask.chooseXR({ title: 'Blocking question', choices: [{ v: 'ok', label: 'OK' }], cancel: 'ok' })), name);
  const onQuad = async () => { const f = async () => pg.evaluate(async () => ({ f: (await import('./lib/render/perf.js')).perf.frameNo, xr: (await import('./lib/xr/xrask.js')).xrActive(), hidden: document.hidden, t: performance.now() })); const a = await f(); const b = await until('frames move', async () => { const x = await f(); return x.f > a.f + 2 ? x : null; }, { ms: 90000 }).catch(() => f()); return JSON.stringify({ a, b, q: await pg.evaluate(() => globalThis.__px.ask.xrAskState()) }); };
  // a move of the locked thing, through edit/writes.js send (its revert counted: what a cancelled gesture runs)
  const move = (name, x) => pg.evaluate(async ([n, px]) => { globalThis.__reverts = 0; const E = await import('./lib/edit/writes.js');
    return globalThis.__px.track(n, E.sendOps([{ verb: 'set', args: { id: globalThis.__lk, component: 'transform', value: { pos: [px, 0, 3], q: [0, 0, 0, 1], scale: [1, 1, 1] } } }], { what: 'move the lock probe', expect: false, revert: () => { globalThis.__reverts++; E.revertPose(globalThis.__lk); } }).then((r) => r.ok)); }, [name, x]);
  const inLine = () => S('L: the lock question waits behind the open one', () => (globalThis.__px.ask.xrAskState()?.waiting ?? 0) > 0);

  // L1 (14): cancelled after a newer drag of the same thing began: the old revert must not yank it back under the hand
  await blocker('b1'); await asked(/Blocking/, 'L1: the blocking question is open').catch(async (e) => { throw new Error(`${e.message}; on the quad: ${await onQuad()}`); });
  await move('m1', 4); await inLine().catch(() => {});
  await pg.evaluate(async () => { (await import('./lib/net.js')).sendDrag(globalThis.__lk, [5, 0, 3], 0); return true; });   // a newer drag of it (build.js, gizmo.js, inspect.js all send these)
  await pg.evaluate(() => globalThis.__px.press(/^ok$/i));
  await asked(/locked/, 'L1: the lock question is asked').catch(() => {});
  await pg.evaluate(() => globalThis.__px.press(/cancel/i));
  await settledR('m1', 'L1: the move settled').catch(() => {});
  const l1 = { made, lk0, moved: await R('m1'), reverts: await pg.evaluate(() => globalThis.__reverts) };
  check('L1 a queued lock question cancelled after a newer drag of the thing began leaves the thing to that drag (no revert)', l1.made.ok && l1.lk0.ok && l1.moved === false && l1.reverts === 0, JSON.stringify(l1));

  // L1g: the same, for a GROUP move (a multi-select drag: #352): a newer drag took only one of its things. That one stays
  // under the hand; the others still go back where the log has them, as any cancelled move puts its things back
  const mate = await req('create', { id: '$lkq', components: { transform: { pos: [2, 0, 3], q: [0, 0, 0, 1], scale: [1, 1, 1] }, label: 'lock probe mate' } });
  await pg.evaluate((id) => { globalThis.__lk2 = id; return true; }, mate.ids?.$lkq ?? null);
  await blocker('b1g'); await asked(/Blocking/, 'L1g: the blocking question is open').catch(async (e) => { throw new Error(`${e.message}; on the quad: ${await onQuad()}`); });
  await pg.evaluate(async () => { const E = await import('./lib/edit/writes.js'); const { bus } = await import('./lib/base.js');
    globalThis.__putBack = []; if (!globalThis.__putBackOn) { globalThis.__putBackOn = true; bus.on('pose-revert', (e) => globalThis.__putBack?.push(e.id)); }
    const ids = [globalThis.__lk, globalThis.__lk2], op = (id, x) => ({ verb: 'set', args: { id, component: 'transform', value: { pos: [x, 0, 3], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
    return globalThis.__px.track('m1g', E.sendOps([op(ids[0], 4), op(ids[1], 1)], { what: 'move 2 things', expect: false, revert: () => ids.forEach((i) => E.revertPose(i)) }).then((r) => r.ok)); });
  await inLine().catch(() => {});
  await pg.evaluate(async () => { (await import('./lib/net.js')).sendDrag(globalThis.__lk, [5, 0, 3], 0); return true; });   // a newer drag of the locked one alone
  await pg.evaluate(() => globalThis.__px.press(/^ok$/i));
  await asked(/locked/, 'L1g: the lock question is asked').catch(() => {});
  await pg.evaluate(() => globalThis.__px.press(/cancel/i));
  await settledR('m1g', 'L1g: the group move settled').catch(() => {});
  const l1g = { mate: mate.ok, moved: await R('m1g'), putBack: await pg.evaluate(() => globalThis.__putBack.map((i) => (i === globalThis.__lk ? 'held' : i === globalThis.__lk2 ? 'mate' : i))) };
  check('L1g a queued lock question on a group move, cancelled after a newer drag took one of its things: the others go back, that one stays',
    l1g.mate && l1g.moved === false && l1g.putBack.includes('mate') && !l1g.putBack.includes('held'), JSON.stringify(l1g));

  // L2 (15): while the question waits, the lock it names is lifted and a new one set: 🔓 Unlock must not lift the new one
  await blocker('b2'); await asked(/Blocking/, 'L2: the blocking question is open').catch(async (e) => { throw new Error(`${e.message}; on the quad: ${await onQuad()}`); });
  await move('m2', 4); await inLine().catch(() => {});
  const relock = { off: await req('delete', { id: LK, component: 'lock' }), on: await req('set', { id: LK, component: 'lock', value: true }) };
  await S('L2: the new lock is in the fold', async () => !!(await import('./lib/edit/writes.js')).compsOf(globalThis.__lk)?.lock).catch(() => {});
  await pg.evaluate(() => globalThis.__px.press(/^ok$/i));
  await asked(/locked/, 'L2: the lock question is asked').catch(() => {});
  await pg.evaluate(async () => { const { bus } = await import('./lib/base.js'); globalThis.__unlocks = 0; bus.on('edit-done', (e) => { if (/^unlock /.test(e?.what ?? '')) globalThis.__unlocks++; }); return true; });
  const id0 = await pg.evaluate(() => globalThis.__px.ask.xrAskState()?.id ?? null);
  const hit = await pg.evaluate(() => globalThis.__px.press(/unlock/i));
  // the right answer is the question again, about the lock there now; the wrong one deletes it and moves the thing
  const again = await S('L2: asked again, or the move settled', () => /locked/i.test(globalThis.__px.ask.xrAskState()?.title ?? '') || globalThis.__r.m2 !== 'unsettled').catch(() => false);
  const l2 = { relock, hit, again, askedAgain: /locked/i.test((await askTitle()) ?? '') && (await pg.evaluate(() => globalThis.__px.ask.xrAskState()?.id ?? null)) !== id0,   // a new question, not the old one left open
    unlocks: await pg.evaluate(() => globalThis.__unlocks), moved: await R('m2'), locked: await lockedNow() };
  if (l2.askedAgain) { await asked(/locked/, 'L2: the second lock question is drawn'); await pg.evaluate(() => globalThis.__px.press(/cancel/i)); await settledR('m2', 'L2: the move settled').catch(() => {}); }
  check('L2 🔓 Unlock on a queued question whose lock was replaced asks again, and the new lock stays on', relock.off.ok && relock.on.ok && l2.hit && l2.askedAgain && l2.unlocks === 0 && l2.locked === true, JSON.stringify(l2));

  // ---- the real callers in a headset (review #359 12, 13): each one's question rides the ask quad, nothing native ----
  const nDialogs = dialogs.length;
  // speech server (audio/ttsrow.js addEndpoint → askCenter)
  await pg.evaluate(async () => { const host = document.createElement('div'); host.id = 'probe-tts'; document.body.append(host); (await import('./lib/audio/ttsrow.js')).ttsSection(host); return true; });
  await S('R1: the voice list offers "add a speech server"', () => [...document.querySelectorAll('#probe-tts .vl-add')].some((r) => /speech server/.test(r.textContent)));
  await pg.evaluate(() => { [...document.querySelectorAll('#probe-tts .vl-add')].find((r) => /speech server/.test(r.textContent)).click(); return true; });
  const r1 = await asked(/speech server/, 'R1: the speech server is asked on the ask quad').then(() => true, () => false);
  if (r1) { await pg.evaluate(() => globalThis.__px.press(/^cancel$/i)); await S('R1: answered', () => !globalThis.__px.ask.xrAskState()); }
  await pg.evaluate(() => { document.querySelector('#probe-tts')?.remove(); return true; });
  check('R1 in a headset, adding a speech server asks for its address on the ask quad', r1, dialogs.slice(nDialogs).join(' | '));

  // closing the door with people here who have no role (ui/rolespanels.js → confirmCenter's headset branch); two stand-ins
  // for people present, as net.js identities holds them. (review #359 6) one more arrives while it is asked: asked again
  await pg.evaluate(async () => { const n = await import('./lib/net.js'); n.identities.set('probe-peer-1', 'u-probe-guest-1');
    const host = document.createElement('div'); host.id = 'probe-door'; document.body.append(host); (await import('./lib/ui/rolespanels.js'))._test.paintAccess(host); return true; });
  const door0 = await pg.evaluate(async () => JSON.stringify((await import('./lib/net.js')).replica.st?.entities?.['@world']?.c?.access ?? null));
  await pg.evaluate(() => { document.querySelector('#probe-door button[data-door="invite-only"]').click(); return true; });
  const r2 = await asked(/close the door/, 'R2: the door question is on the ask quad').then(() => true, () => false);
  const r2body = await pg.evaluate(() => globalThis.__px.ask.xrAskState()?.body ?? null);
  const r2why = r2 ? null : await pg.evaluate(async () => { const n = await import('./lib/net.js'); const b = document.querySelector('#probe-door button[data-door="invite-only"]'); return { rights: n.net.myRights, you: n.net.you, ids: [...n.identities], btn: b ? { disabled: b.disabled, on: b.className } : null }; });
  check('R2 in a headset, closing the door on someone with no role asks on the ask quad, counting them', r2 && /^1 person /.test(r2body ?? ''), JSON.stringify({ r2body, r2why, dialogs: dialogs.slice(nDialogs) }));
  let r2again = null;
  if (r2) {
    await pg.evaluate(async () => { (await import('./lib/net.js')).identities.set('probe-peer-2', 'u-probe-guest-2'); return true; });
    await pg.evaluate(() => globalThis.__px.press(/close it/i));
    r2again = await S('R2: asked again, or the door question gone', () => { const st = globalThis.__px.ask.xrAskState(); return st ? (st.live !== false && st.body) : 'gone'; }).catch(() => null);
    if (r2again && r2again !== 'gone') await pg.evaluate(() => globalThis.__px.press(/keep it open/i));
  }
  const door1 = await pg.evaluate(async () => JSON.stringify((await import('./lib/net.js')).replica.st?.entities?.['@world']?.c?.access ?? null));
  await pg.evaluate(async () => { const n = await import('./lib/net.js'); n.identities.delete('probe-peer-1'); n.identities.delete('probe-peer-2'); document.querySelector('#probe-door')?.remove(); return true; });
  check('…and a second person arriving while it was asked is asked about again (2 people), the door still open after Keep it open', /^2 people /.test(r2again ?? '') && door1 === door0, JSON.stringify({ r2again, door0, door1 }));

  // log out (ui/ui-menu.js logOut → confirmCenter): the menu's own action, as a signed-in person has it
  await pg.evaluate(async () => { (await import('./lib/base.js')).CONFIG.authed = true; (await import('./lib/ui/actions.js')).get('menu:login').run(); return true; });
  const r3 = await asked(/log out/, 'R3: the log out question is on the ask quad').then(() => true, () => false);
  if (r3) { await pg.evaluate(() => globalThis.__px.press(/^stay$/i)); await S('R3: answered', () => !globalThis.__px.ask.xrAskState()); }
  await pg.evaluate(async () => { (await import('./lib/base.js')).CONFIG.authed = false; return true; });
  check('R3 in a headset, Log out asks on the ask quad (Stay keeps you here)', r3, dialogs.slice(nDialogs).join(' | '));

  // save as blueprint (edit/panels.js bpsave → askCenter): the Build tab's own button, with the lock probe selected
  await pg.evaluate(async () => { (await import('./lib/edit/build.js')).setBuildMode(true); return true; });
  await pg.evaluate(() => { document.querySelector('.edit-tab[data-tab="build"]')?.click(); return true; });
  await pg.evaluate(async () => { (await import('./lib/scenegraph.js')).sceneSelect(globalThis.__lk); return true; });
  await pg.evaluate(() => { globalThis.__bp = () => [...(document.querySelector('[data-frame="build"]')?.querySelectorAll('.sp-btn') ?? [])].find((b) => /save as blueprint/.test(b.textContent) && !b.disabled); return true; });
  await S('R4: Build offers "save as blueprint"', () => !!globalThis.__bp()).catch(() => {});
  await pg.evaluate(() => { globalThis.__bp()?.click(); return true; });
  const r4 = await asked(/blueprint/, 'R4: the blueprint name is asked on the ask quad').then(() => true, () => false);
  const r4input = await pg.evaluate(() => globalThis.__px.input()?.value ?? null);
  if (r4) { await pg.evaluate(() => globalThis.__px.press(/^cancel$/i)); await S('R4: answered', () => !globalThis.__px.ask.xrAskState()); }
  await pg.evaluate(async () => { (await import('./lib/edit/build.js')).setBuildMode(false); return true; });
  check('R4 in a headset, Save as blueprint asks for its name on the ask quad, its label offered', r4 && r4input === 'lock probe', JSON.stringify({ r4input, dialogs: dialogs.slice(nDialogs) }));

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

  // X (cold read of #359's fixes): a press meant for the question that just closed never answers the one that took its
  // place. The ask quad's buttons always sit in its bottom row, so the consent question's Turn on appears under a
  // notice's OK. One frame (#16) is ~11 ms; a double-press, or a press aimed at a card closing by itself, comes
  // 100–300 ms later. A question can't be answered until it has been shown for ARM_MS (confirmcenter.js), as browsers do
  // for permission prompts; a press before then is dropped, not kept for later
  await fresh(); await inVR();
  await pg.evaluate(() => globalThis.__px.track('xn', globalThis.__px.ask.chooseXR({ title: 'refused — nothing changed', body: 'probe', choices: [{ v: 'ok', label: 'OK' }], cancel: 'ok' })));
  await asked(/refused/, 'X: the notice is drawn');
  await startConsent();   // the real ensureSttConsent question, in line behind the notice
  await S('X: the consent question waits behind the notice', () => (globalThis.__px.ask.xrAskState()?.waiting ?? 0) > 0);
  // in the page, in one task: OK pressed at its left quarter (where Turn on will be), then the same spot again a person's
  // double-press later (120 ms); both through the laser. A headset draws ~11 frames in that time, so the consent question
  // has been drawn and #16's gate is passed. This host's software loop blocks the main thread 1–2 s a frame, so any wait
  // that yields to it is a second long: the row spins the 120 ms instead (the passing of time is what is under test) and
  // counts the one frame a headset would have drawn meanwhile (perf.frameNo + 1, the value the loop writes on its next tick)
  const x = await pg.evaluate(async () => {
    const { btn, pull, dq } = globalThis.__px; const { perf } = await import('./lib/render/perf.js');
    const r = btn('ask', /^ok$/i).getBoundingClientRect(), pt = { x: r.left + r.width * 0.25, y: r.top + r.height / 2 };
    // the frame is laid out offscreen while presenting (domquad.js), so elementFromPoint can't see it: the button whose box holds the point
    const under = () => [...dq.domQuadTexture('ask').dom.querySelectorAll('button')].find((b) => { const q = b.getBoundingClientRect(); return q.height > 0 && pt.x >= q.left && pt.x <= q.right && pt.y >= q.top && pt.y <= q.bottom; }) ?? null;
    const pressAt = () => { const b = under(); return b ? pull('ask', b) != null : false; };
    const t0 = performance.now(), x1 = pressAt(), f0 = perf.frameNo ?? 0;
    perf.frameNo = f0 + 1; globalThis.__px.ask.xrAskTick?.();   // the frame that drew it, and the next one starting
    while (performance.now() - t0 < 120) { /* a double-press's gap, with no frame able to run in it */ }
    const label = under()?.textContent ?? null, ms = Math.round(performance.now() - t0), x2 = pressAt();
    return { x1, label, ms, x2 };
  });
  Object.assign(x, { notice: await R('xn'), consent: await R('cr'), stored: await stored(), arm: await pg.evaluate(async () => (await import('./lib/edit/confirmcenter.js')).ARM_MS ?? null) });
  console.log('  · X', JSON.stringify(x));
  check('X a press at the notice\'s spot 120 ms and a frame after it went never answers the consent question under it (sttConsent null)',
    x.x1 && x.notice === 'ok' && x.label === 'Turn on' && x.x2 && x.consent === 'unsettled' && x.stored === null && !(x.ms >= (x.arm ?? Infinity)), JSON.stringify(x));
  // the press was dropped, not kept: once the question can be answered it is still open, and a press then is the answer
  await asked(/speech-to-text/, 'X: the consent question can be answered').catch(() => {});
  const xl = { still: await R('cr') };
  xl.pressed = await pg.evaluate(() => globalThis.__px.press(/turn on/i));
  xl.consent = await settledR('cr', 'X: the consent question answered').then(() => R('cr'), () => 'unsettled'); xl.stored = await stored();
  check('…the dropped press is not kept for later, and a press once the question can be answered is its answer (true)', xl.still === 'unsettled' && xl.pressed && xl.consent === true && xl.stored === true, JSON.stringify(xl));

  // XH (cold review of the arm time): the arm time counts from when a press STARTED. X's presses click at once; the
  // trigger clicks at its release (xr.js: domQuadsPress on trigger down, domQuadsRelease on trigger up), so a double-press
  // whose second press starts inside ARM_MS and is let go after it was answering the question nobody had seen yet.
  // Same spot as X (OK's left quarter, where Turn on appears), same spun time and one counted frame
  const xrHeld = async (tag, down, up) => {
    await fresh(); await inVR();
    await pg.evaluate(() => globalThis.__px.track('xn', globalThis.__px.ask.chooseXR({ title: 'refused — nothing changed', body: 'probe', choices: [{ v: 'ok', label: 'OK' }], cancel: 'ok' })));
    await asked(/refused/, `${tag}: the notice is drawn`);
    await startConsent();
    await S(`${tag}: the consent question waits behind the notice`, () => (globalThis.__px.ask.xrAskState()?.waiting ?? 0) > 0);
    const h = await pg.evaluate(async ({ down, up }) => {
      const { btn, ray, dq } = globalThis.__px; const { perf } = await import('./lib/render/perf.js');
      const r = btn('ask', /^ok$/i).getBoundingClientRect(), pt = { x: r.left + r.width * 0.25, y: r.top + r.height / 2 };
      const p1 = dq.domQuadsPress(ray('ask', pt)); dq.domQuadsRelease(p1?.press);   // the first trigger click: answers the notice
      const t0 = performance.now(), f0 = perf.frameNo ?? 0;
      perf.frameNo = f0 + 1; globalThis.__px.ask.xrAskTick?.();   // as X
      const spin = (ms) => { while (performance.now() - t0 < ms) { /* time passing, no frame able to run */ } };
      spin(down); const p2 = dq.domQuadsPress(ray('ask', pt)); const downMs = Math.round(performance.now() - t0);
      spin(up); const upMs = Math.round(performance.now() - t0); dq.domQuadsRelease(p2?.press);
      return { first: !!p1?.press, under: p2?.press?.el?.textContent ?? null, downMs, upMs };
    }, { down, up });
    Object.assign(h, { notice: await R('xn'), consent: await R('cr'), stored: await stored() });
    console.log(`  · ${tag}`, JSON.stringify(h));
    return h;
  };
  for (const [tag, down, up] of [['XH', 300, 470], ['XH2', 120, 470]]) {
    const h = await xrHeld(tag, down, up);
    check(`${tag} a trigger press begun ${down} ms after the notice went and let go at ${up} never answers the consent question under it (sttConsent null)`,
      h.first && h.notice === 'ok' && h.under === 'Turn on' && h.downMs < 450 && h.upMs >= 450 && h.consent === 'unsettled' && h.stored === null, JSON.stringify(h));
  }

  // XS (cold review of the arm time): a question's ARM_MS starts once it has been drawn, on the frame after (xrask.js
  // xrAskTick), not when it was asked. A frame that takes 600 ms as the question appears (a shader compiling for it) left
  // it in sight ~100 ms when a press 700 ms after the ask counted. In one task, as X: the stall spun, the frame that drew
  // it counted, the next tick stood in for (xrAskTick is the frame loop's first system), then 100 ms, then a press
  await fresh(); await inVR();
  const xs = await pg.evaluate(async () => {
    const { btn, pull, ask, track } = globalThis.__px; const { perf } = await import('./lib/render/perf.js');
    const vc = await import('./lib/audio/voiceconsent.js');
    const t0 = performance.now(), f0 = perf.frameNo ?? 0;
    track('cr', vc.ensureSttConsent());   // asked now: the question is on the quad at once
    const spin = (ms) => { while (performance.now() - t0 < ms) { /* */ } };
    spin(600); perf.frameNo = f0 + 1; ask.xrAskTick?.();
    const stallMs = Math.round(performance.now() - t0);
    spin(stallMs + 100); const title = ask.xrAskState()?.title ?? null, b = btn('ask', /turn on/i), ms = Math.round(performance.now() - t0), hit = b ? pull('ask', b) != null : false;
    return { title, stallMs, ms, hit };
  });
  Object.assign(xs, { consent: await R('cr'), stored: await stored() });
  console.log('  · XS', JSON.stringify(xs));
  check('XS a press 100 ms after a 600 ms frame that drew the consent question never answers it (sttConsent null)',
    /speech-to-text/i.test(xs.title ?? '') && xs.hit && xs.stallMs >= 600 && xs.ms >= 450 && xs.consent === 'unsettled' && xs.stored === null, JSON.stringify(xs));
  await asked(/speech-to-text/, 'XS: the consent question can be answered').catch(() => {});
  const xs2 = { pressed: await pg.evaluate(() => globalThis.__px.press(/turn on/i)) };
  xs2.consent = await settledR('cr', 'XS: the consent question answered').then(() => R('cr'), () => 'unsettled');
  check('…and once it has been up ARM_MS, a press is its answer (true)', xs2.pressed && xs2.consent === true, JSON.stringify(xs2));

  // XT (cold review of the press time): "drawn" means the question is on the quad's texture. HTMLMesh rasterises the
  // frame's DOM when the quad is shown, and again for a DOM change only on a ≥16 ms timer: had the quad been shown before
  // the question was painted into its frame, the frame after showed an empty card, and a long task before the timer ran
  // (a shader compiling) ate the arm time of a question nobody could read. In one task, as XS: the question asked, the
  // next frame's tick, a 600 ms long task, a press at 700 ms. The row watches the quad's own texture: the question must
  // be on it before the arm time starts. Mutation: in xrask.js show(), showXRPanel('ask', true) before repaint()
  await fresh(); await inVR();
  await pg.evaluate(() => globalThis.__px.track('xtn', globalThis.__px.ask.chooseXR({ title: 'probe notice', choices: [{ v: 'ok', label: 'OK' }], cancel: 'ok' })));
  await asked(/probe notice/, 'XT: a notice first, so the ask quad is built and its texture can be watched');
  await pg.evaluate(() => globalThis.__px.press(/^ok$/i)); await settledR('xtn', 'XT: the notice answered');
  const xt = await pg.evaluate(async () => {
    const { btn, pull, ask, dq, track } = globalThis.__px; const { perf } = await import('./lib/render/perf.js');
    const vc = await import('./lib/audio/voiceconsent.js');
    const map = dq.domQuadTexture('ask'), rasters = [], orig = map.update;
    map.update = function () { rasters.push([performance.now(), /speech-to-text/i.test(this.dom.textContent)]); return orig.call(this); };
    const t0 = performance.now(), f0 = perf.frameNo ?? 0;
    track('cr', vc.ensureSttConsent());
    perf.frameNo = f0 + 1; ask.xrAskTick();   // the next frame begins: the arm time starts here
    const tickMs = performance.now() - t0;
    const spin = (ms) => { while (performance.now() - t0 < ms) { /* a long task, before HTMLMesh's raster timer can run */ } };
    spin(600); const b = btn('ask', /turn on/i); spin(700);
    const hit = b ? pull('ask', b) != null : false, same = dq.domQuadTexture('ask') === map;
    delete map.update;   // the prototype's again
    const first = rasters.find(([, has]) => has);
    return { same, hit, rasters: rasters.length, firstWithQuestionMs: first ? Math.round(first[0] - t0) : null, tickMs: Math.round(tickMs), title: ask.xrAskState()?.title ?? null };
  });
  Object.assign(xt, { consent: await R('cr'), stored: await stored() });
  console.log('  · XT', JSON.stringify(xt));
  check('XT the consent question is on the ask quad\'s texture before its arm time starts (a 600 ms long task before the re-raster timer), so a press at 700 ms answers only a question that could be read',
    xt.same && xt.hit && xt.firstWithQuestionMs != null && xt.firstWithQuestionMs <= xt.tickMs, JSON.stringify(xt));

  // DH: the same on the desk, with a mouse: a press begun inside the card's ARM_MS and let go after it answers nothing.
  // The notice's Close and consent's Turn on don't share a spot on the desk (the consent card is taller), so the press is
  // put on Turn on; the events are a real mouse's (pointerdown, mousedown … pointerup, mouseup, click), spun in one task
  const deskHeld = async (tag, down, up) => {
    await fresh();
    await pg.evaluate(async () => globalThis.__px.track('dn', (await import('./lib/edit/confirmcenter.js')).confirmCenter({ title: 'From a moderator', body: 'warned you', ok: 'I understand', cancel: 'Close' })));
    await S(`${tag}: the desk notice can be answered`, () => document.querySelector('#confirm-center')?.dataset.armed !== undefined);
    await startConsent();
    const h = await pg.evaluate(({ down, up }) => {
      const mouse = (b, phase) => { const r = b.getBoundingClientRect(), init = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', isPrimary: true, pointerId: 1 };
        const seq = phase === 'down' ? [['pointerdown', PointerEvent], ['mousedown', MouseEvent]] : [['pointerup', PointerEvent], ['mouseup', MouseEvent], ['click', PointerEvent]];
        for (const [type, E] of seq) b.dispatchEvent(new E(type, { ...init, detail: 1 })); };
      const close = document.querySelector('#confirm-center .cc-no'); mouse(close, 'down'); mouse(close, 'up');   // Close: the notice
      const t0 = performance.now(), spin = (ms) => { while (performance.now() - t0 < ms) { /* */ } };
      spin(down); const b = [...document.querySelectorAll('#confirm-center button')].find((x) => /turn on/i.test(x.textContent));
      if (b) mouse(b, 'down'); const downMs = Math.round(performance.now() - t0);
      spin(up); if (b) mouse(b, 'up');
      return { under: b?.textContent ?? null, downMs, upMs: Math.round(performance.now() - t0) };
    }, { down, up });
    Object.assign(h, { notice: await R('dn'), consent: await R('cr'), stored: await stored() });
    console.log(`  · ${tag}`, JSON.stringify(h));
    await pg.evaluate(async () => { (await import('./lib/edit/confirmcenter.js')).closeCenter(); return true; });
    return h;
  };
  for (const [tag, down, up] of [['DH', 300, 470], ['DH2', 120, 470]]) {
    const h = await deskHeld(tag, down, up);
    check(`${tag} a mouse press begun ${down} ms after the desk notice went and let go at ${up} never answers the consent card (sttConsent null)`,
      h.notice === false && h.under === 'Turn on' && h.downMs < 450 && h.upMs >= 450 && h.consent === 'unsettled' && h.stored === null, JSON.stringify(h));
  }
  check('no native dialogs at all', dialogs.length === 0, dialogs.join(' | '));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
