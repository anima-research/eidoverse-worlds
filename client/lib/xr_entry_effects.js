// WHO ACTS ON AN ENTRY FAILURE — the effect owner for the busy/absent/reload verdicts.
//
// WHY THIS EXISTS (#197 round-two review, 2026-09-20): xr_entry_policy.js decides what a failure
// MEANS and is fully tested; the acting on it lived inline in xr.js and was covered only by source
// assertions — imports present, `verdict.delayMs` referenced, a cancel call in leaveVR. The reviewer
// mutated the shipping branch to `if (true)` so EVERY busy verdict scheduled a retry, including
// give-up, and the suite still passed 31/31. Regex-checking that code exists is not running it.
//
// So the effects move here, behind injected dependencies, and the suite drives THIS — the same
// module xr.js imports. Mutating the scheduling logic now turns the suite red because the suite
// executes it.
//
// State is per-owner rather than module-global so a test can hold two independent entry owners, and
// so nothing leaks between page sessions.

/** @param deps {{ setTimer, clearTimer, tee, toast, enter, markAbsent }} */
export function makeEntryEffects(deps) {
  let pendingFor = null;   // the ENTRY INTENT that owns the pending retry (null = none pending)
  let timer = null;

  /** The retry belongs to the click that scheduled it. A later click — or a leave — makes it stale,
   *  and a stale callback must never request a session. */
  function cancel(why) {
    if (timer !== null) { deps.clearTimer(timer); timer = null; }
    if (pendingFor !== null && why) deps.tee(`[xr] busy-retry cancelled: ${why}`);
    pendingFor = null;
  }

  /** Act on a verdict. Returns what was done, so a caller (and a test) can assert on it rather than
   *  on a log line: 'retried' | 'gave-up' | 'absent' | 'reload' | 'surface'. */
  function apply(verdict, { intent, error } = {}) {
    switch (verdict.action) {
      case 'retry-once': {
        // EXACTLY ONE automatic retry per entry intent. The original shape reset its own flag inside
        // the timeout, so every failure looked like the first and a busy session retried forever.
        // The retry carries its intent forward, so ITS failure is the second one and gives up.
        cancel(null);
        pendingFor = intent;
        deps.tee(`[xr] session busy (another page holds it) — retrying once in ${verdict.delayMs} ms`);
        deps.toast(verdict.toast, 'info', 3000);
        timer = deps.setTimer(() => {
          timer = null;
          if (pendingFor !== intent) { deps.tee('[xr] busy-retry dropped: a newer entry intent owns the visor'); return; }
          pendingFor = null;
          deps.enter({ retryOf: intent });
        }, verdict.delayMs);
        return 'retried';
      }
      case 'give-up':
        // No scheduling. The visor waits for an explicit click, which starts a fresh budget because
        // that click is a NEW intent and arrives with retryOf = null.
        deps.toast(verdict.toast, 'warn', 8000);
        deps.tee('[xr] session busy after retry — giving up until the visor is clicked again');
        return 'gave-up';
      case 'absent':
        deps.markAbsent(true);
        if (error && typeof error === 'object') error.userMessage = verdict.toast;
        return 'absent';
      case 'reload-webgl':
        deps.tee(`[xr] webgpu session refused (${error?.name ?? ''} ${error?.message ?? error}) — reloading on the WebGL backend`);
        deps.toast(verdict.toast, 'info', 6000);
        return 'reload';
      default:
        return 'surface';
    }
  }

  // `hasPending` reads the TIMER because that is what leaveVR must not swallow. An adversarial sweep
  // found that rewiring it to `pendingFor` survives every test — correctly, as it turns out: the two
  // are set and cleared together in every reachable state, so they are equivalent and no test can
  // distinguish them. Recorded rather than papered over with a test that only appears to bind:
  // the redundancy is the finding. They stay separate because they MEAN different things (one is a
  // handle, one is an identity) and a future edit could easily make them diverge.
  return { apply, cancel, get pendingFor() { return pendingFor; }, get hasPending() { return timer !== null; } };
}
