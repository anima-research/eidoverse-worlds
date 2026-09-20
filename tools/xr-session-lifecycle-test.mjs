// bun tools/xr-session-lifecycle-test.mjs — THE SESSION CLOCK LIFECYCLE, EXECUTED.
//
// Required by the #197 round-two review (Blocker 2). The reviewer mutated the product's install to
//     if (false && shouldShim({ emulated: !!globalThis.IWER })) {
// and xr-frame-clock-test passed 29/29, because it drove the pure pieces and then source-checked the
// wiring. The ORDER — capture (save-once) → restore listener BEFORE setSession → shim — was never
// executed by any test.
//
// This drives client/lib/xr_frame_clock.js's installFrameClock(), the same function xr.js calls, over
// the sequence the review named:
//     requestSession → setSession → session clock owns frames → end latch → desktop clock restored
//     → second session enters and exits → stale first-session completion cannot affect the second
//
// The session objects are IWER's where it can supply them and a minimal fake otherwise; what matters
// is that the PRODUCT'S install sequence runs. Removing the install turns this red.
import { installFrameClock, clockIsRestored } from '../client/lib/xr_frame_clock.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}${extra ? ` — ${extra}` : ''}`); } };

function fakeWindow() {
  const w = { calls: [], cancelled: [], _n: 0 };
  w.requestAnimationFrame = (cb) => { w.calls.push(cb); return `win-${++w._n}`; };
  w.cancelAnimationFrame = (id) => w.cancelled.push(id);
  return w;
}
// The fake has to be as UNCOOPERATIVE as the real thing, or the transition paths go untested: an
// adversarial mutation sweep found the restore listener could be registered LAST — the catastrophic
// case this module's header names — with every check still green, because nothing else ever
// registered an 'end' listener to be ordered against. Same for a session that throws.
function fakeSession({ throwOnRaf = false } = {}) {
  const s = { calls: [], cancelled: [], _n: 0, _end: [], ended: false, endOrder: [] };
  s.requestAnimationFrame = (cb) => { if (throwOnRaf) throw new Error('session is gone'); s.calls.push(cb); return `ses-${++s._n}`; };
  s.cancelAnimationFrame = (id) => s.cancelled.push(id);
  s.addEventListener = (t, cb, o) => { if (t === 'end') s._end.push({ cb, once: o?.once, tag: s._tag }); };
  s.tagNext = (tag) => { s._tag = tag; return s; };   // label a listener so ORDER is observable
  s.end = () => { s.ended = true; s._end.splice(0).forEach(({ cb, tag }) => { s.endOrder.push(tag ?? '?'); cb(); }); };
  s.tick = (t) => s.calls.splice(0).forEach((cb) => cb(t));
  return s;
}

console.log('\n— entry: the session clock takes over —');
const win = fakeWindow();
const nat = { raf: win.requestAnimationFrame, caf: win.cancelAnimationFrame };
const s1 = fakeSession();
const fc1 = installFrameClock({ win, session: s1, saved: null });
check('the install reports that it installed', fc1.installed === true);
// captureNative BINDS the window's methods, so the saved pair is a wrapper, never === the original.
// Assert what it DOES: calling it reaches the window.
check('it saved a working native pair (bound, so not === the original)',
  (fc1.native.raf(() => {}), win.calls.length === 1) && (win.calls.length = 0, true));
check('the restore listener is registered on the session', s1._end.length === 1);
check('…exactly once, and once-only', s1._end[0].once === true);
check('a frame request now goes to the SESSION clock',
  win.requestAnimationFrame(() => {}) === 'ses-1' && s1.calls.length === 1);
check('…and not to the window', win.calls.length === 0);
{ let got; win.requestAnimationFrame((t) => { got = t; }); s1.tick(99.5);
  check('the session timestamp reaches the caller', got === 99.5, `got=${got}`); }
check('a cancel goes to the session too', (win.cancelAnimationFrame('ses-1'), s1.cancelled.length === 1));

console.log('\n— ORDERING: our restore must run before a listener registered after us —');
{
  // three registers its own 'end' listener inside setSession, i.e. AFTER ours. Listeners fire in
  // registration order, so ours must be first: if three's restarts the desktop loop against a dead
  // session first, no frame ever ticks again (the module header's 09-07 22:41 receipt).
  const w = fakeWindow(); const s = fakeSession();
  s.tagNext('decoy-before');
  s.addEventListener('end', () => {}, {});           // something already listening
  s._tag = 'ours';
  const fc = installFrameClock({ win: w, session: s, saved: null });
  s.tagNext('three-after');
  let sawRestored = null;
  s.addEventListener('end', () => { sawRestored = clockIsRestored(w, fc.native); }, {});
  s.end();
  check('a listener registered AFTER the install sees the clock already restored',
    sawRestored === true, `saw ${sawRestored}; order ${s.endOrder.join(' → ')}`);
  check('…and our restore ran before it', s.endOrder.indexOf('ours') < s.endOrder.indexOf('three-after'),
    s.endOrder.join(' → '));
}

console.log('\n— the latch, in the window it exists for —');
{
  // Between 'end' firing and the restore completing, a caller can still hold the shim. The latch is
  // the only thing that keeps that frame off a dead session — and it is invisible to any test that
  // only looks after the restore.
  const w = fakeWindow(); const s = fakeSession();
  const fc = installFrameClock({ win: w, session: s, saved: null });
  const shim = w.requestAnimationFrame;            // a caller that grabbed the shim earlier
  s.end();                                          // ended; restore has run
  w.calls.length = 0; s.calls.length = 0;
  shim(() => {});                                   // the STALE shim is called
  check('a frame through a stale shim after end falls back to the window, not the dead session',
    w.calls.length === 1 && s.calls.length === 0, `win=${w.calls.length} ses=${s.calls.length}`);
}
{
  const w = fakeWindow(); const s = fakeSession({ throwOnRaf: true });
  installFrameClock({ win: w, session: s, saved: null });
  check('a session that THROWS from requestAnimationFrame falls back to the window',
    (w.calls.length = 0, w.requestAnimationFrame(() => {}), w.calls.length === 1));
}
{
  const w = fakeWindow(); const s = fakeSession(); let onEndAt = null, restoredAt = null, n = 0;
  const fc = installFrameClock({ win: w, session: s, saved: null,
    onEnd: () => { onEndAt = ++n; restoredAt = clockIsRestored(w, fc.native) ? n : null; } });
  s.end();
  check('onEnd IS called on session end', onEndAt === 1);
  check('…after the restore, so a handler reading the clock sees it back', restoredAt === 1);
}

console.log('\n— the end latch, and the restore —');
check('before the end, the desktop clock is NOT restored', clockIsRestored(win, fc1.native) === false);
s1.end();
check('the session end restores the desktop clock', clockIsRestored(win, fc1.native) === true);
check('…and a frame now reaches the WINDOW again',
  (win.calls.length = 0, /^win-/.test(win.requestAnimationFrame(() => {})) && win.calls.length === 1));
check('a late frame request after end never reaches the dead session', s1.calls.length === 0);

console.log('\n— re-entry: a second session, and save-once —');
const s2 = fakeSession();
const fc2 = installFrameClock({ win, session: s2, saved: fc1.native });   // xr.js passes the saved pair
check('the second entry keeps the FIRST entry’s saved pair (save-once)', fc2.native === fc1.native);
check('…so the saved clock still reaches the window, not a shim',
  (win.calls.length = 0, fc2.native.raf(() => {}), win.calls.length === 1));
check('the second session owns frames', win.requestAnimationFrame(() => {}) === 'ses-1' && s2.calls.length === 1);
s2.end();
check('and its end restores the desktop clock to the saved native',
  clockIsRestored(win, fc2.native) === true);
check('…so a desktop frame ticks after the SECOND exit too',
  (win.calls.length = 0, /^win-/.test(win.requestAnimationFrame(() => {})) && win.calls.length === 1));

console.log('\n— a stale first-session completion cannot affect the second —');
{
  const w = fakeWindow(); const a = fakeSession(), b = fakeSession();
  const fa = installFrameClock({ win: w, session: a, saved: null });
  const fb = installFrameClock({ win: w, session: b, saved: fa.native });   // re-enter BEFORE a tore down
  a.end();   // the FIRST session ends late, after the second installed
  check('a late end from the superseded session does not steal the clock back',
    w.requestAnimationFrame(() => {}) === 'ses-1' && b.calls.length === 1,
    `window got ${w.calls.length}`);
  b.end();
  check('…and when the live session ends, the desktop clock comes back', clockIsRestored(w, fb.native) === true);
}

console.log('\n— the emulator drives its own frames —');
{
  const w = fakeWindow(); const s = fakeSession();
  const fc = installFrameClock({ win: w, session: s, saved: null, emulated: true });
  check('under IWER the shim is NOT installed', fc.installed === false);
  check('…so frames keep going to the window', w.requestAnimationFrame(() => {}) === 'win-1');
  check('…but the restore listener is still registered', s._end.length === 1);
}

console.log('\n— the PRODUCT runs this sequence (the wiring the reviewer broke) —');
{
  const xr = readFileSync(new URL('../client/lib/xr.js', import.meta.url), 'utf8');
  check('xr.js imports installFrameClock', /import \{ installFrameClock \}/.test(xr));
  check('…and calls it', /frameClock = installFrameClock\(\{/.test(xr));
  check('…passing the saved pair, so save-once holds across entries', /saved: nativeRAF \? \{ raf: nativeRAF, caf: nativeCAF \} : null/.test(xr));
  check('…before setSession', xr.indexOf('installFrameClock({') < xr.indexOf('await renderer.xr.setSession('));
  check('NO second shim install survives', !/window\.requestAnimationFrame = makeFrameShim/.test(xr));
  // THE SEAM, which is where both round-two regressions lived (agent review). The suites drove the
  // modules; the glue that calls them was still only prose. A second 'end' listener in xr.js used to
  // restore the clock UNCONDITIONALLY from the module-global native pair — which the newer session's
  // install overwrites — so a stale session's teardown reached straight around the generation guard
  // and handed the desktop clock back mid-session. Reproduced against the real module before fixing.
  check('ONLY the owner restores the clock — no unguarded restore survives in xr.js',
    !/window\.requestAnimationFrame = nativeRAF/.test(xr), 'an end listener still restores directly');
  check('…so nativeRAF/nativeCAF are save-once bookkeeping only, never a restore path',
    (xr.match(/nativeRAF/g) ?? []).length <= 4, `${(xr.match(/nativeRAF/g) ?? []).length} references`);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
