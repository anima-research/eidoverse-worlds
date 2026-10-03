// gpulost — when the GPU takes the page's context away, go back to the live world.
//
// A frame that keeps the GPU busy for more than ~2 s trips the OS watchdog (Windows TDR)
// and the driver resets; the browser then loses every WebGL context on it
// ('CONTEXT_LOST_WEBGL: loseContext: context lost', seen by the owner 2026-09-26 after a 4.3 s sky bake
// frame in VR). three does not rebuild its resources on a lost context, so the page kept
// running at 60 fps into a black canvas with nothing to say why. Nothing listened.
//
// Rebuilding in place means re-creating every GPU object the realizers own (the same work
// as swapping renderers mid-page; FEATURE-WISHLIST), so recovery is a reload into the same
// world: the server remembers the pose, the HTTP cache is warm, and a VR session is gone
// either way. The ?xr=1 boot flag is dropped so a crash out of VR lands on the desktop.
//
// A second loss inside the window does NOT reload again: a device that resets on every
// boot would otherwise loop. It says so and leaves the reload to the person. Nor does a THIRD
// loss inside 15 min, however far apart (review 10a M2): a loop whose period is boot time plus
// time-to-the-fatal-draw — the 89–94 s sky link above plus a cold boot — runs longer than 2 min,
// saw an empty short window every time and reloaded forever, a driver reset each cycle.

export const GPU_LOST_KEY = 'ew-gpu-lost';           // sessionStorage: ms timestamps of recent losses
export const GPU_RECOVERED_KEY = 'ew-gpu-recovered'; // sessionStorage: the reason, read once by the next boot's notice
export const GPU_LOST_WINDOW_MS = 120000;
export const GPU_LOST_LONG_MS = 15 * 60000;   // …and at most GPU_LOST_LONG_MAX losses in this one
export const GPU_LOST_LONG_MAX = 3;

/** Pure: given recent loss times and now, reload or stop? `why` names the rule that stopped it. */
export function gpuLostAction(now, recent) {
  const kept = (recent ?? []).filter((t) => Number.isFinite(t) && now - t >= 0 && now - t < GPU_LOST_LONG_MS);
  const next = [...kept, now];
  if (kept.some((t) => now - t < GPU_LOST_WINDOW_MS)) return { reload: false, recent: next, why: 'second loss inside 2 min' };
  if (next.length >= GPU_LOST_LONG_MAX) return { reload: false, recent: next, why: `${next.length} losses inside 15 min` };
  return { reload: true, recent: next };
}

/** The URL to come back on: same world, same everything, minus the XR boot flag. */
export function recoveryUrl(href) {
  const u = new URL(href);
  u.searchParams.delete('xr');
  u.searchParams.delete('why');
  return u.toString();
}

export function installGpuLostRecovery({ canvas, renderer, tee = () => {}, onStop = () => {}, win = globalThis }) {
  let handled = false;
  const store = win.sessionStorage;
  const handle = (why) => {
    if (handled) return;
    handled = true;
    let recent = [];
    try { recent = JSON.parse(store?.getItem(GPU_LOST_KEY) || '[]'); } catch {}
    const act = gpuLostAction(Date.now(), recent);
    try { store?.setItem(GPU_LOST_KEY, JSON.stringify(act.recent)); } catch {}
    tee(`[gpu] LOST (${why}) — ${act.reload ? 'reloading into the live world' : `${act.why}, not reloading again`}`);
    if (!act.reload) { onStop(why, act.why); return; }
    try { store?.setItem(GPU_RECOVERED_KEY, why); } catch {}
    // This reload is deliberate, not a crash: disarm the lite tripwire (index.html) or the
    // recovery lands the person in the phone client — a boot that armed it and has not yet
    // reached its disarm (pagehide or the 60 s dwell) reads as "the last full boot died".
    try { win.localStorage?.removeItem(win.__ewTripKey?.(new URLSearchParams(win.location.search)) ?? 'ew-boot-attempt'); } catch {}
    // a beat for the tee's beacon to leave; the page is drawing nothing anyway
    win.setTimeout(() => win.location.replace(recoveryUrl(win.location.href)), 400);
  };
  // preventDefault: the spec's "we intend to handle this"; without it no restore event is ever offered
  canvas?.addEventListener('webglcontextlost', (e) => { e.preventDefault?.(); handle('webgl context lost'); });
  const device = renderer?.backend?.device;
  device?.lost?.then((info) => { if (info?.reason !== 'destroyed') handle(`webgpu device lost: ${info?.message || info?.reason || '?'}`); });
  return { handle, get fired() { return handled; } };
}

/** Read once by the boot after a recovery: the reason, or null. */
export function takeGpuRecovered(win = globalThis) {
  // The page whose context just died must not consume it: a loss during boot can race that
  // page's own late notice init inside the reload's 400 ms, and the flag is for the NEXT page.
  if (win.__gpuLost?.fired) return null;
  try { const v = win.sessionStorage?.getItem(GPU_RECOVERED_KEY); if (v) win.sessionStorage.removeItem(GPU_RECOVERED_KEY); return v || null; } catch { return null; }
}

/** How many losses this tab has recorded inside the long window (GPU_LOST_KEY) — the count a notice can show. */
export function recentGpuLosses(win = globalThis, now = Date.now()) {
  try {
    const recent = JSON.parse(win.sessionStorage?.getItem(GPU_LOST_KEY) || '[]');
    return Array.isArray(recent) ? recent.filter((t) => Number.isFinite(t) && now - t >= 0 && now - t < GPU_LOST_LONG_MS).length : 0;
  } catch { return 0; }
}
