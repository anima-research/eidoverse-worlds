// vrmic-probe — ask for the microphone BEFORE VR, so voice works inside the headset (client/lib/vrmic.js). The real
// client, ?xr=1, an IWER session entered through the REAL visor (#xrbtn) and the real voice transport. Only the browser's
// permission boundary is driven: navigator.permissions.query answers what the probe says ('granted' / 'denied' /
// 'prompt'), and getUserMedia is counted (and, for the in-VR case, held open the way an unanswerable prompt holds it).
//   granted  — straight in: no step, no getUserMedia, a session
//   denied   — straight in: no step, no getUserMedia, a hint naming the browser's site settings
//   prompt   — the step appears and nothing enters; Allow → getUserMedia ONCE, its tracks stopped, the mic still OFF;
//              then "Enter VR" (a fresh click) → a session
//   in VR    — the ring's mic with the permission open and the request hanging: after vrmic.TRY_MS the intent is
//              retracted, a head-locked note says why, a flag is set; exactly one acquisition was attempted
//   exit     — unaffected (the session ends and the page answers), the note is gone, the flat page then asks
//   late     — the hung request finally resolves after the retraction: the device is stopped, never published
//   unanswered — Allow, and the browser never answers: after vrmic.TRY_MS the step still offers "Enter VR", which enters;
//              the late answer's tracks are stopped
// Run one headless browser at a time; clouds are forced off before boot here.
//   bun tools/vrmic-probe.mjs [--shots <dir>]      (SHOT_BASE=160 numbers the shots)
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const { check, done } = checker();
const shotDir = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();
let shotN = Number(process.env.SHOT_BASE ?? 160);
if (shotDir) mkdirSync(shotDir, { recursive: true });
const IWER_RAW = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const DEVICE_LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
if (IWER_RAW.split(DEVICE_LOOP).length !== 2) throw new Error(`iwer build changed: expected exactly one '${DEVICE_LOOP}'`);
const IWER = `globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` +
  IWER_RAW.replace(DEVICE_LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');

const world = await ownedWorld({ env: { SKIP_OPT_SWEEP: '1', VOICE_TRANSPORT: 'sfu' } });   // a real SFU leg, so the ring's press reaches getUserMedia
// mic: fake device + the context's permission granted, so a REAL getUserMedia succeeds; what the PAGE reads as the
// permission state is the probe's stub. vrMicChoice: null — this probe drives the step the harness otherwise pre-answers.
const { browser, page } = await launchBrowser({ mic: true, vrMicChoice: null });
const pg = await page();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, arg) => Promise.race([pg.evaluate(fn, arg),
  new Promise((_, rej) => setTimeout(() => rej(new Error('page main thread pinned for 30 s')), 30000))]);
const shot = async (name, opts = {}) => { if (!shotDir) return; const f = `${shotDir}/${shotN++}-${name}.png`; await pg.screenshot({ path: f, ...opts }); console.log(`  · shot ${f}`); };
const saveUrl = (name, url) => { if (!shotDir || !url) return; const f = `${shotDir}/${shotN++}-${name}.png`; writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); console.log(`  · shot ${f}`); };

await pg.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });   // THE SKY GUARD, before boot
await pg.addInitScript(IWER);
await pg.addInitScript(() => {
  if (window.__probe) return;
  const { XRDevice, metaQuest3 } = window.IWER ?? {};
  if (!XRDevice) { window.__probe = { fatal: 'IWER did not load' }; return; }
  const device = new XRDevice(metaQuest3);
  device.installRuntime({ forceInstall: true });
  window.__iwerDevice = device;
  try { delete window.IWER; } catch { window.IWER = undefined; }
  const P = window.__probe = { grants: 0, perm: 'granted', gum: 0, hang: false, held: [], streams: [] };
  const real = navigator.xr.requestSession.bind(navigator.xr);
  navigator.xr.requestSession = async (...a) => { const s = await real(...a); P.grants++; return s; };
  // the permission boundary: what the page READS (never what the browser enforces — the context grants the device)
  const q = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = async (d) => {
    if (d?.name !== 'microphone') return q(d);
    const st = new EventTarget(); Object.defineProperty(st, 'state', { get: () => P.perm }); return st;
  };
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) => {
    P.gum++;
    const go = () => gum(c).then((s) => { P.streams.push(s); return s; });
    if (!P.hang) return go();
    return new Promise((res, rej) => P.held.push({ release: () => go().then(res, rej) }));   // a prompt nobody can see
  };
});
const errs = [];
pg.on('pageerror', (e) => errs.push(String(e)));
pg.on('dialog', (d) => d.dismiss().catch(() => {}));

const presenting = () => ev(() => !!globalThis.EW?.renderer?.xr?.isPresenting);
const endSession = async (label) => {
  const t0 = Date.now();
  await pg.evaluate(() => { window.__iwerDevice.activeSession?.end(); });
  let ok = false;   // EXIT IS SLOW HEADLESS, NOT HUNG (xr-quad-colour-probe): wait for the page to answer again
  while (!ok && Date.now() - t0 < 180000) ok = await Promise.race([pg.evaluate(() => !window.__iwerDevice.activeSession && !globalThis.EW?.renderer?.xr?.isPresenting), sleep(5000).then(() => false)]);
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  · ${label}: session ended, page answering after ${s} s`);
  return { ok, s };
};
const card = () => ev(() => { const c = document.getElementById('vrmic'); return c ? { title: c.querySelector('#vrmic-title')?.textContent, text: c.querySelector('.vrmic-body')?.textContent.replace(/\s+/g, ' ').trim(), btns: [...c.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null; });
const P = () => ev(() => ({ grants: window.__probe.grants, gum: window.__probe.gum, held: window.__probe.held.length,
  choice: localStorage.getItem('ew-vr-mic-choice'), pending: localStorage.getItem('ew-vr-mic-pending'), vrmic: { ...globalThis.__vrmic, noteCanvas: undefined, noteMesh: undefined } }));
const mic = () => ev(async () => { const M = await import('./lib/micstate.js'); const S = await import('./lib/voicesfu.js'); return { micOn: M.micOn(), wanted: S.sfuMicWanted(), sfuOn: S.sfuMicOn() }; });
const clickVisor = () => ev(() => document.querySelector('#xrbtn').click());

try {
  await pg.goto(`${world.origin}/?world=staging&name=vrmicprobe&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 90000 }).catch(() => {});
  await pg.waitForFunction(() => typeof window.__sfuMic === 'function' && window.relayDiag?.()?.connectionState != null, null, { timeout: 60000 }).catch(() => {});   // the voice lane is the one the ring talks through
  const boot = await ev(() => ({ xrbtn: !!document.querySelector('#xrbtn'), fatal: window.__probe?.fatal ?? null, sfu: typeof window.__sfuMic, diag: window.relayDiag?.() ?? null, absent: !!window.__voiceRelayAbsent }));
  check('booted: visor, IWER, the voice lane with a live connection', boot.xrbtn && !boot.fatal && boot.sfu === 'function' && !boot.absent && boot.diag?.connectionState != null, JSON.stringify(boot));
  if (!boot.xrbtn) throw new Error('boot gate failed');
  check('mic is off by default', (await mic()).micOn === false, JSON.stringify(await mic()));

  // ── granted: straight in ──
  await ev(() => { window.__probe.perm = 'granted'; });
  await clickVisor();
  await pg.waitForFunction(() => window.__probe.grants >= 1, null, { timeout: 30000, polling: 250 }).catch(() => {});
  { const p = await P(); const c = await card();
    check('granted: straight in — a session, no step, no getUserMedia', p.grants === 1 && !c && p.gum === 0, JSON.stringify({ p, c })); }
  { const e = await endSession('granted'); check('granted: the exit completes', e.ok, `${e.s} s`); }

  // ── denied: straight in, with the fix ──
  await sleep(1700);   // the visor refuses an enter inside 1.5 s of a leave (xr.js)
  await ev(() => { window.__probe.perm = 'denied'; });
  await clickVisor();
  await pg.waitForFunction(() => window.__probe.grants >= 2, null, { timeout: 30000, polling: 250 }).catch(() => {});
  { const p = await P(); const c = await card();
    const toasts = await ev(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent));
    check('denied: straight in — a session, no step, no getUserMedia', p.grants === 2 && !c && p.gum === 0, JSON.stringify({ p, c }));
    check('denied: a hint says how to fix it in the browser\'s site settings', toasts.some((t) => /blocked/i.test(t) && /site's settings/.test(t)), JSON.stringify(toasts)); }
  { const e = await endSession('denied'); check('denied: the exit completes', e.ok, `${e.s} s`); }

  // ── prompt, never asked: the 2D step ──
  await sleep(1700);
  await ev(() => { window.__probe.perm = 'prompt'; localStorage.removeItem('ew-vr-mic-choice'); });
  await clickVisor();
  await pg.waitForFunction(() => !!document.getElementById('vrmic'), null, { timeout: 10000, polling: 100 }).catch(() => {});
  await sleep(1500);
  { const p = await P(); const c = await card();
    check('prompt: the step appears ("Voice in VR?", Allow / Not now) and nothing enters yet',
      c?.title === 'Voice in VR?' && c.btns.join('|') === 'Allow microphone|Not now' && p.grants === 2 && p.gum === 0, JSON.stringify({ p, c })); }
  await shot('vrmic-step-voice-in-vr');
  await ev(() => document.querySelector('#vrmic [data-act=allow]').click());
  await pg.waitForFunction(() => !!document.querySelector('#vrmic [data-act=enter]'), null, { timeout: 15000, polling: 100 }).catch(() => {});
  await sleep(400);
  { const p = await P(); const c = await card(); const m = await mic();
    const tracks = await ev(() => window.__probe.streams.flatMap((s) => s.getTracks().map((t) => t.readyState)));
    check('Allow: getUserMedia called exactly once', p.gum === 1, JSON.stringify(p));
    check('Allow: every track it returned is stopped', tracks.length > 0 && tracks.every((s) => s === 'ended'), JSON.stringify(tracks));
    check('Allow: the mic is still OFF (permission is not consent to speak)', m.micOn === false && m.wanted === false && m.sfuOn === false, JSON.stringify(m));
    check('Allow: the step says so and offers "Enter VR"; the choice is remembered', /stays off/.test(c?.text ?? '') && c?.btns.join('|') === 'Enter VR' && p.choice === 'allow', JSON.stringify({ c, choice: p.choice }));
    check('Allow: still no session (the prompt spent the gesture; entry waits for the fresh click)', p.grants === 2, JSON.stringify(p)); }
  await shot('vrmic-step-allowed-enter-vr');
  await ev(() => document.querySelector('#vrmic [data-act=enter]').click());
  await pg.waitForFunction(() => window.__probe.grants >= 3, null, { timeout: 30000, polling: 250 }).catch(() => {});
  { const p = await P(); check('"Enter VR": a session, and the step is gone', p.grants === 3 && !(await card()), JSON.stringify(p)); }
  await pg.waitForFunction(() => !!globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 30000, polling: 250 }).catch(() => {});

  // ── in VR: the ring's mic with the permission open and the request hanging ──
  await ev(() => { window.__probe.perm = 'prompt'; window.__probe.hang = true; });
  const gumBefore = (await P()).gum;
  const t0 = Date.now();
  const pressed = await ev(async () => { (await import('./lib/base.js')).bus.emit('xr:mic'); return true; });   // the ring's own action
  check('in VR: the press returns at once (nothing awaits the hanging request)', pressed && Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  const TRY_MS = await ev(async () => (await import('./lib/vrmic.js')).TRY_MS);
  await pg.waitForFunction(() => !!globalThis.__vrmic?.lastTry, null, { timeout: TRY_MS + 15000, polling: 250 }).catch(() => {});
  await sleep(500);
  { const p = await P(); const m = await mic();
    const settledAfter = Date.now() - t0;
    check('in VR: exactly one acquisition attempted, and it is the one left hanging', p.gum - gumBefore === 1 && p.held === 1, JSON.stringify({ gum: p.gum - gumBefore, held: p.held }));
    check(`in VR: given up after the ${TRY_MS} ms try, not before`, p.vrmic.lastTry?.how === 'timeout' && p.vrmic.lastTry?.verdict === 'later' && settledAfter >= TRY_MS, JSON.stringify({ lastTry: p.vrmic.lastTry, settledAfter }));
    check('in VR: the intent is retracted (wantMic false, mic off)', m.wanted === false && m.micOn === false, JSON.stringify(m));
    // the page runs ~0.7 s/frame in a headless session, so the plate may have lived out its 7 s before this read:
    // 'shown' is "still up now, or was up for (most of) its full life", read in ONE evaluate with its timestamps
    const v = p.vrmic;
    const dbg = await ev(() => { const r = globalThis.__vrmic ?? {}; return { up: !!r.noteMesh?.parent, at: r.noteAt ?? 0, cleared: r.noteClearedAt ?? null, mat: r.noteMat ?? null }; });
    const life = dbg.cleared != null ? dbg.cleared - dbg.at : null;
    console.log(`  · note: up now=${dbg.up}, ${life == null ? 'not cleared yet' : `lived ${(life / 1000).toFixed(1)} s (its timer is 7 s)`}`);
    check('in VR: a head-locked note says permission is needed and when it will be asked', dbg.at > 0 && (dbg.up || life >= 6000) && /needs permission/.test(v.note) && /leave VR/.test(v.note), JSON.stringify({ ...dbg, note: v.note, life }));
    check('in VR: the plate wears the quads\' colour material (quadMaterial: an outputNode undoing ACES), depth still off',
      dbg.mat?.node && dbg.mat.output && dbg.mat.depthTest === false && dbg.mat.depthWrite === false, JSON.stringify(dbg.mat));
    check('in VR: the note rides the camera (head-locked), in front of the eyes', /Camera/.test(v.noteParent ?? '') && v.noteZ < 0, JSON.stringify({ parent: v.noteParent, z: v.noteZ }));
    check('in VR: the flag for the next flat-page moment is set', p.pending === '1', JSON.stringify(p.pending)); }
  saveUrl('vrmic-note-in-vr-texture', await ev(() => globalThis.__vrmic?.noteCanvas?.toDataURL('image/png')));
  // (no desktop shot here: headless, the mirror pauses itself for cost — xrmirror.js — so the desktop shows its banner, not the eyes)

  // ── exit: unaffected, then the flat page asks ──
  { const e = await endSession('after the in-VR fallback'); check('exit: the session ends and the page answers (the fallback does not hold it)', e.ok, `${e.s} s`); }
  { const shown = await ev(async () => (await import('./lib/vrmic.js')).vrNoteShown()); check('exit: the note is gone', !shown); }
  await pg.waitForFunction(() => !!document.getElementById('vrmic'), null, { timeout: 15000, polling: 250 }).catch(() => {});
  { const c = await card(); check('after exit: the flat page asks ("Voice needs permission", Allow / Not now)', c?.title === 'Voice needs permission' && c.btns.join('|') === 'Allow microphone|Not now', JSON.stringify(c)); }
  await sleep(300);
  await shot('vrmic-step-after-vr');
  await ev(() => document.querySelector('#vrmic [data-act=later]').click());
  { const p = await P(); check('after exit: "Not now" closes it, clears the flag, remembers the answer, enters nothing', !(await card()) && p.pending === null && p.choice === 'later' && p.grants === 3, JSON.stringify(p)); }

  // ── late: the hung request finally answers — the retraction must win ──
  await ev(() => { window.__probe.hang = false; window.__probe.held.splice(0).forEach((h) => h.release()); });
  await sleep(2500);
  { const m = await mic(); const tracks = await ev(() => { const s = window.__probe.streams.at(-1); return s ? s.getTracks().map((t) => t.readyState) : null; });
    check('late: the device that arrived after the retraction is stopped, never published', m.micOn === false && m.wanted === false && tracks?.every((s) => s === 'ended'), JSON.stringify({ m, tracks })); }

  // ── unanswered: Allow, and the browser's prompt is never answered — the way in must not be held ──
  await sleep(1700);
  await ev(() => { window.__probe.perm = 'prompt'; window.__probe.hang = true; localStorage.removeItem('ew-vr-mic-choice'); });
  await clickVisor();
  await pg.waitForFunction(() => !!document.querySelector('#vrmic [data-act=allow]'), null, { timeout: 10000, polling: 100 }).catch(() => {});
  const gumAt = (await P()).gum, tAllow = Date.now();
  await ev(() => document.querySelector('#vrmic [data-act=allow]').click());
  await pg.waitForFunction(() => !!document.querySelector('#vrmic [data-act=enter]'), null, { timeout: TRY_MS + 15000, polling: 250 }).catch(() => {});
  { const p = await P(); const c = await card(); const res = await ev(() => document.querySelector('#vrmic [data-result]')?.dataset.result ?? null);
    check(`unanswered: after the ${TRY_MS} ms bound the step offers "Enter VR" and says the browser hasn't answered`,
      res === 'unanswered' && c?.btns.join('|') === 'Enter VR' && /hasn.t answered/.test(c?.text ?? '') && Date.now() - tAllow >= TRY_MS, JSON.stringify({ res, c, ms: Date.now() - tAllow }));
    check('unanswered: one getUserMedia, still hanging', p.gum - gumAt === 1 && p.held === 1, JSON.stringify({ gum: p.gum - gumAt, held: p.held })); }
  await shot('vrmic-step-unanswered-enter-vr');
  await ev(() => document.querySelector('#vrmic [data-act=enter]').click());
  await pg.waitForFunction(() => window.__probe.grants >= 4, null, { timeout: 30000, polling: 250 }).catch(() => {});
  { const p = await P(); check('unanswered: "Enter VR" still enters — a session, and the step is gone', p.grants === 4 && !(await card()), JSON.stringify(p)); }
  await ev(() => { window.__probe.hang = false; window.__probe.held.splice(0).forEach((h) => h.release()); });
  await sleep(2500);
  { const tracks = await ev(() => window.__probe.streams.at(-1)?.getTracks().map((t) => t.readyState) ?? null); const m = await mic();
    check('unanswered: the prompt answered late, in VR — its tracks are stopped and the mic stays off', tracks?.length > 0 && tracks.every((s) => s === 'ended') && m.micOn === false, JSON.stringify({ tracks, m })); }
  { const e = await endSession('unanswered'); check('unanswered: the exit completes', e.ok, `${e.s} s`); }
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, `${e.stack || e.message}${errs.length ? ` — page errors: ${errs.slice(0, 3).join(' | ')}` : ''}`); }
finally {
  try { await browser.close(); } catch {}
  try { await world.close(); } catch {}
}
done();
