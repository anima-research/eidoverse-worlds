// Who owns window.requestAnimationFrame while a session presents. While presenting, frames must come
// from the session's clock (the window's is throttled behind a headset), so window.rAF is shimmed onto
// the session and restored at teardown. xr.js calls installEntryClock; this owns the rules, with no
// imports. test/client/xr-frame-clock-test.mjs and xr-session-lifecycle-test.mjs drive them.
//
// The rules that matter:
//  • restore BEFORE three's own 'end' listener (registered in setSession), which restarts the desktop
//    loop through window.rAF — on a dead session, no frame ever ticks again;
//  • once ended, the shim falls through to the native clock;
//  • the native pair is saved once per page, never per entry (a second save would capture the shim);
//  • no shim under an emulator (IWER), whose session clock IS window.rAF.

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

/** Is the desktop clock actually back (window.rAF is the function we saved)? */
export function clockIsRestored(win, native) {
  return !!native && win.requestAnimationFrame === native.raf && win.cancelAnimationFrame === native.caf;
}

/** Install and tear down as one sequence: capture, register the restore listener (before setSession), shim.
 *
 *  @param win     the window whose clock is being taken over
 *  @param session the XRSession (or anything with addEventListener/requestAnimationFrame)
 *  @param saved   the previously-saved native pair, or null on a first entry (save-once)
 *  @param emulated true under IWER, where the emulator drives frames itself
 *  @param onEnd   extra teardown to run after the clock is restored
 *  @returns {{ native, installed, restore }} */
export function installFrameClock({ win, session, saved, emulated = false, onEnd = null }) {
  const native = captureNative(saved, win);   // save-once: a second capture would store the SHIM as native
  let ended = false, restored = false;
  // a generation: only the latest install may hand the clock back, so a stale session's end can't take it from a live one
  const gen = (win.__xrClockGen = (win.__xrClockGen ?? 0) + 1);
  const restore = () => {
    ended = true;
    if (restored) return false;
    restored = true;
    if (win.__xrClockGen !== gen) return false;   // superseded: a newer session owns the clock now
    win.requestAnimationFrame = native.raf; win.cancelAnimationFrame = native.caf;
    return true;
  };
  // registered before setSession so it fires before three's own 'end' listener (see the header)
  session.addEventListener('end', () => { restore(); if (onEnd) onEnd(); }, { once: true });
  let installed = false;
  if (shouldShim({ emulated })) {
    win.requestAnimationFrame = makeFrameShim({ session, native, hasEnded: () => ended });
    win.cancelAnimationFrame = makeCancelShim({ session, native });
    installed = true;
  }
  return { native, installed, restore };
}

/** What enterVR calls. Decides `emulated` here rather than at the call site, so a test can prove a real
 *  runtime gets a shim.
 *  @param globals where to look for an emulator (a test seam; the product never passes it) */
export function installEntryClock({ win, session, saved, globals = globalThis, onEnd = null }) {
  const emulated = !!globals?.IWER;   // IWER drives the session clock ON window.rAF; shimming feeds it to itself
  return installFrameClock({ win, session, saved, emulated, onEnd });
}
