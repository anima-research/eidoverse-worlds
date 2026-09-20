// xr-frame-clock-test — who owns window.requestAnimationFrame across a session (#197 review B2).
//
// This is the teardown/re-entry half of the session lifecycle, and it needs no renderer and no real
// XRSession: the shim touches exactly three members (requestAnimationFrame, cancelAnimationFrame,
// and an 'end' that flips a latch), so the stand-in below cannot invent product shape — there is
// almost no shape to invent. The compile/curtain/pose half is disclosed headset-only in the PR body.
//
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/xr-frame-clock-test.mjs
//
// Mutations that must turn a named check red:
//   xr_frame_clock.js: captureNative re-captures every entry (the shim becomes "native")
//   xr_frame_clock.js: the shim ignores the ended latch (frames go to a dead session)
//   xr_frame_clock.js: the shim stops catching a throwing session
//   xr_frame_clock.js: cancel reaches only one clock
//   xr_frame_clock.js: shouldShim ignores the emulator (IWER feeds its own clock)
//   xr.js: the restore listener is registered AFTER setSession (three's own listener wins)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { captureNative, shouldShim, makeFrameShim, makeCancelShim, clockIsRestored }
  from '../client/lib/xr_frame_clock.js';

const dir = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** A window whose clock we can watch. Ids are distinguishable so a frame can be traced to its owner. */
function fakeWindow() {
  const w = { calls: [], cancelled: [], _n: 0 };
  w.requestAnimationFrame = (cb) => { w.calls.push(cb); return `win-${++w._n}`; };
  w.cancelAnimationFrame = (id) => { w.cancelled.push(id); };
  return w;
}
/** The three members of an XRSession the frame clock actually touches. */
function fakeSession({ throwOnRaf = false } = {}) {
  const s = { calls: [], cancelled: [], _n: 0, ended: false, _endCbs: [] };
  s.requestAnimationFrame = (cb) => { if (throwOnRaf) throw new Error('session is gone'); s.calls.push(cb); return `ses-${++s._n}`; };
  s.cancelAnimationFrame = (id) => { s.cancelled.push(id); };
  s.addEventListener = (type, cb) => { if (type === 'end') s._endCbs.push(cb); };
  s.end = () => { s.ended = true; s._endCbs.splice(0).forEach((cb) => cb()); };
  // Actually DRIVE the queued callbacks (#197 review, 2026-09-20). Without this the suite only ever
  // collected them, so makeFrameShim's `(t) => cb(t)` wrapper — the only reason the shim is not a
  // bare pass-through — was never exercised: dropping the timestamp, or swapping time and XRFrame,
  // both passed green. A render loop handed an XRFrame where it expects a DOMHighResTimeStamp is a
  // real failure mode.
  s.tick = (t, frame) => s.calls.splice(0).forEach((cb) => cb(t, frame));
  return s;
}

console.log('one session, start to finish:');
{
  const win = fakeWindow();
  const ses = fakeSession();
  let ended = false;

  const nat = captureNative(null, win);
  win.requestAnimationFrame = makeFrameShim({ session: ses, native: nat, hasEnded: () => ended });
  win.cancelAnimationFrame = makeCancelShim({ session: ses, native: nat });

  check('while presenting, a frame request goes to the SESSION clock',
    win.requestAnimationFrame(() => {}) === 'ses-1' && ses.calls.length === 1);
  check('…and not to the window', win.calls.length === 0);
  // What the callback RECEIVES, not merely that it was queued (#197 review, 2026-09-20). The suite
  // only ever collected callbacks and never invoked them, so the shim's `(t) => cb(t)` wrapper was
  // untested: dropping the timestamp, or passing (frame, t), both passed green.
  // The wrapper drops the XRFrame ON PURPOSE — the shim stands in for window.requestAnimationFrame,
  // whose callback takes one argument, and no desktop consumer reads a second. Pinned both ways so
  // neither half can drift.
  { let gotT, gotF; const frame = { pose: 'x' };
    win.requestAnimationFrame((t, f) => { gotT = t; gotF = f; });
    ses.tick(1234.5, frame);
    check('the session timestamp reaches the caller', gotT === 1234.5, `got=${gotT}`);
    check('…as the FIRST argument, with the XRFrame deliberately dropped (window.rAF shape)',
      gotF === undefined, `second arg=${gotF}`);
    // tick() drained the queue and this probe added an id; later checks count queued callbacks and
    // ids, so put both back exactly as they were before this block.
    ses.calls.push(() => {}); ses._n = 1; }

  // the session ends; the latch flips BEFORE the restore runs
  ses.addEventListener('end', () => { ended = true; });
  ses.end();
  check('between "end" and the restore, frames fall back to the native clock rather than a dead session',
    win.requestAnimationFrame(() => {}) === 'win-1' && ses.calls.length === 1);

  // the restore itself. PIN THE NEGATIVE FIRST (#197 review, 2026-09-20): clockIsRestored was only
  // ever called in the already-restored state, so every term in it was dead — gutting the whole
  // predicate to `return true` passed green. Each clock is now checked on its own.
  check('before the restore the clock is NOT the one we saved', clockIsRestored(win, nat) === false);
  win.requestAnimationFrame = nat.raf;
  check('restoring only rAF is not enough — cancel must come back too', clockIsRestored(win, nat) === false);
  win.cancelAnimationFrame = nat.caf;
  check('a null native is never "restored"', clockIsRestored(win, null) === false);
  check('after teardown the desktop clock is the one we saved', clockIsRestored(win, nat) === true);
  check('…so a desktop frame ticks again, and reaches the WINDOW',
    win.requestAnimationFrame(() => {}) === 'win-2' && win.calls.length === 2);
}

console.log('\nre-entry — the failure that save-once exists to prevent:');
{
  // Assert BEHAVIOUR, not identity: captureNative returns bound functions, so `saved.raf` is never
  // `===` the original — a reference check here would fail on correct code. What matters is where a
  // frame actually lands, which is also what breaks in production when the save-once rule is broken.
  const win = fakeWindow();
  let saved = null;
  const sessions = [];

  for (const n of [1, 2]) {           // two full sessions on one page
    const ses = fakeSession(); sessions.push(ses);
    let ended = false;
    saved = captureNative(saved, win);   // SAVE ONCE: the second entry must not capture the shim
    win.requestAnimationFrame = makeFrameShim({ session: ses, native: saved, hasEnded: () => ended });
    win.cancelAnimationFrame = makeCancelShim({ session: ses, native: saved });
    check(`session ${n}: frames go to that session`, win.requestAnimationFrame(() => {}) === 'ses-1');
    ses.addEventListener('end', () => { ended = true; });
    ses.end();
    win.requestAnimationFrame = saved.raf; win.cancelAnimationFrame = saved.caf;
    const before = win.calls.length;
    const id = win.requestAnimationFrame(() => {});
    check(`session ${n}: a desktop frame reaches the WINDOW after teardown`,
      win.calls.length === before + 1 && String(id).startsWith('win-'), `id=${id}`);
  }
  // The double-capture bug is invisible on entry 1 and fatal on entry 2: the second capture would
  // save session 1's SHIM as "native", so the restore would hand frames to the dead first session.
  check('after TWO sessions a frame still reaches the window, not the first session',
    sessions[0].calls.length === 1, `session 1 received ${sessions[0].calls.length} frames (1 = only its own)`);
  check('…and not the second either', sessions[1].calls.length === 1);
  check('the native clock was captured exactly once', clockIsRestored(win, saved));
}

// The save-once rule only BITES when a second entry installs its shim while the first is still in
// place — a re-enter before teardown completed, which is exactly the window a user produces by
// clicking the visor again the moment a session drops. Restoring between entries (as the loop above
// does) hides it: the re-capture then reads an already-native clock and looks harmless.
console.log('\nre-enter BEFORE the first teardown — where double-capture actually bites:');
{
  const win = fakeWindow();
  const s1 = fakeSession(), s2 = fakeSession();
  let saved = null, ended1 = false, ended2 = false;

  saved = captureNative(saved, win);
  win.requestAnimationFrame = makeFrameShim({ session: s1, native: saved, hasEnded: () => ended1 });
  // session 2 arrives with session 1's shim STILL INSTALLED
  saved = captureNative(saved, win);
  win.requestAnimationFrame = makeFrameShim({ session: s2, native: saved, hasEnded: () => ended2 });

  ended2 = true;                       // session 2 ends; its shim falls through to `saved`
  const id = win.requestAnimationFrame(() => {});
  check('a frame after the second session reaches the WINDOW, not the dead first session',
    String(id).startsWith('win-'), `went to ${id} — the second capture saved session 1's shim as "native"`);
  check('…and the first session never sees a frame it cannot serve', s1.calls.length === 0,
    `session 1 received ${s1.calls.length}`);
}

console.log('\na session that dies under us:');
{
  const win = fakeWindow();
  const nat = captureNative(null, win);
  const ses = fakeSession({ throwOnRaf: true });
  win.requestAnimationFrame = makeFrameShim({ session: ses, native: nat, hasEnded: () => false });
  check('a throwing session does not kill the frame — it falls through to the native clock',
    win.requestAnimationFrame(() => {}) === 'win-1');
}

console.log('\ncancel reaches both clocks:');
{
  const win = fakeWindow();
  const nat = captureNative(null, win);
  const ses = fakeSession();
  const cancel = makeCancelShim({ session: ses, native: nat });
  cancel('ses-1');
  check('the session is asked to cancel', ses.cancelled.includes('ses-1'));
  check('…and so is the window (an id from before the swap may be either)', win.cancelled.includes('ses-1'));
}

console.log('\nunder an emulator:');
{
  check('a real runtime is shimmed', shouldShim({ emulated: false }) === true);
  check('an emulated runtime is NOT — its session clock IS the window clock, so shimming feeds it to itself',
    shouldShim({ emulated: true }) === false);
}

console.log('\nthe wiring:');
{
  const xr = readFileSync(join(dir, '../client/lib/xr.js'), 'utf8');
  check('xr.js imports the frame-clock rules', /import \{ installFrameClock \}/.test(xr));
  check('xr.js installs the shim through them', /frameClock = installFrameClock\(\{/.test(xr));
  check('the emulator case is passed to the owner, which asks the predicate',
  /emulated: !!globalThis\.IWER/.test(xr) && /shouldShim\(\{ emulated \}\)/.test(readFileSync(new URL('../client/lib/xr_frame_clock.js', import.meta.url), 'utf8')));
  // ORDERING: the restore listener must be registered before setSession, so it runs before three's
  // own 'end' listener restarts the desktop loop through window.requestAnimationFrame.
  const restoreAt = xr.indexOf("session.addEventListener('end'");
  const setSessionAt = xr.indexOf('renderer.xr.setSession(session)');
  check('the install — which registers the restore listener — runs BEFORE setSession',
  xr.indexOf('installFrameClock({') < xr.indexOf('await renderer.xr.setSession('));
  // The restore lives in installFrameClock, generation-guarded. xr.js must NOT restore on its own: a
  // second unguarded listener there let a stale session hand the clock back mid-session (agent review).
  check('the OWNER restores both clocks',
    /win\.requestAnimationFrame = native\.raf; win\.cancelAnimationFrame = native\.caf;/.test(readFileSync(join(dir, '../client/lib/xr_frame_clock.js'), 'utf8')));
  check('…and xr.js does not restore behind its back', !/window\.requestAnimationFrame = nativeRAF/.test(xr));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
