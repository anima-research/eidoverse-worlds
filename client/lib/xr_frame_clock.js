// Who owns window.requestAnimationFrame while a session presents — as pure state. xr.js installs and
// restores it; this owns the rules. tools/xr-frame-clock-test.mjs drives them. No imports on purpose.
//
// While presenting, frames must come from the SESSION's clock, not the window's: a headset runs at its
// own rate and the window clock is throttled or stopped behind it. So window.rAF is shimmed onto the
// session for the session's duration, and restored at teardown.
//
// Three things make this sharp rather than cosmetic (#197 review B2):
//
//  • RESTORE ORDERING. three registers its OWN 'end' listener inside setSession, and that listener
//    restarts the desktop loop through window.requestAnimationFrame. If our restore has not run by
//    then, the restart goes to the dead session and NO FRAME EVER TICKS AGAIN (xr.js, 09-07 22:41:
//    after-exit frames+0 at +0.5 s AND +3 s). Our restore therefore has to be registered BEFORE
//    setSession, so it runs first.
//  • THE LATCH. Between 'end' firing and the restore completing, a caller can still reach the shim.
//    `sessionEnded` makes it fall through to the native clock instead of a dead session.
//  • RE-ENTRY. The saved native functions must survive one session and still be correct for the next.
//    Saving them twice (once per entry) captures the SHIM as "native" on the second entry and the
//    desktop loop never comes back — the failure the save-once rule exists to prevent.
//
// An emulated runtime (IWER) drives the session clock ON window.rAF, so shimming would feed it to
// itself (bench crash, 09-07 19:15). `shouldShim` says so.

/** Save the window's own clock exactly once per page, never per entry. */
export function captureNative(saved, win) {
  if (saved) return saved;   // already ours: a second capture would save the SHIM as native
  return { raf: win.requestAnimationFrame.bind(win), caf: win.cancelAnimationFrame.bind(win) };
}

/** Do we shim at all? Not under an emulator whose session clock IS the window clock. */
export function shouldShim({ emulated = false } = {}) { return !emulated; }

/** The shimmed requestAnimationFrame: the session's clock while it lives, the native one once it has
 *  ended or if the session throws (a session can die between the check and the call). */
export function makeFrameShim({ session, native, hasEnded }) {
  return (cb) => {
    if (hasEnded()) return native.raf(cb);
    try { return session.requestAnimationFrame((t) => cb(t)); }
    catch { return native.raf(cb); }
  };
}

/** Cancel reaches both clocks: an id handed out before the swap may belong to either. */
export function makeCancelShim({ session, native }) {
  return (id) => {
    try { session.cancelAnimationFrame(id); } catch { /* not the session's id, or it is gone */ }
    try { native.caf(id); } catch { /* not the window's id */ }
  };
}

/** Is the desktop clock actually back? The teardown's whole point, and what a test should assert —
 *  not "restore was called" but "window.rAF is the function we saved". */
export function clockIsRestored(win, native) {
  return !!native && win.requestAnimationFrame === native.raf && win.cancelAnimationFrame === native.caf;
}
