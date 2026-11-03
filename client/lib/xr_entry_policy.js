// What a failed immersive-session request MEANS, as a pure function. xr.js owns the effects (toasts,
// timers, reloads); this owns the decision. tools/xr-entry-policy-test.mjs drives every outcome.
// No imports on purpose.
//
// The rules (#197 review B1):
//   busy (another page still holds the session) — retry ONCE, automatically, after BUSY_RETRY_MS.
//     A SECOND busy failure on the same entry intent stops and waits for an explicit visor click.
//     "Same intent" is the point: the previous shape reset its own flag inside the retry timer, so
//     every failure looked like the first one and a busy session retried forever.
//   no device / not supported — there is no headset: say so, mark it absent, do not retry.
//   webgpu refused on a WebGPU backend — the browser cannot grant the 'webgpu' feature; reload onto
//     WebGL, where three's classic path runs. Not a failure the user can act on.
//   anything else — surface it; retrying an unknown error is guessing.
export const BUSY_RETRY_MS = 1500;

const isBusy = (e) => e?.name === 'InvalidStateError' && /already an active/i.test(e?.message ?? '');
const isAbsent = (e) => e?.name === 'NotSupportedError' || e?.name === 'NotFoundError'
  || /no.*(device|headset|runtime)|not supported|unavailable/i.test(e?.message ?? '');

/** @param err the rejection from requestSession
 *  @param isRetry true when this attempt IS the automatic retry (so its failure is the second one)
 *  @param gpu true on a WebGPU backend, where a refused 'webgpu' feature means reload-to-WebGL */
export function decideEntryFailure(err, { isRetry = false, gpu = false } = {}) {
  if (isBusy(err)) {
    return isRetry
      ? { action: 'give-up', retry: false, delayMs: 0, markAbsent: false,
          toast: 'VR is still held by another tab — close it, then click the visor again' }
      : { action: 'retry-once', retry: true, delayMs: BUSY_RETRY_MS, markAbsent: false,
          toast: 'a previous VR session is still closing — retrying' };
  }
  if (gpu) {
    return { action: 'reload-webgl', retry: false, delayMs: 0, markAbsent: false,
             toast: 'no WebGPU VR here — reloading on WebGL' };
  }
  if (isAbsent(err)) {
    return { action: 'absent', retry: false, delayMs: 0, markAbsent: true,
             toast: 'no headset detected — put it on (or wake it) and click the visor again' };
  }
  return { action: 'surface', retry: false, delayMs: 0, markAbsent: false, toast: null };
}

/** Is a pending retry still the one the user asked for? A retry belongs to the entry intent that
 *  scheduled it; a later click or a leave supersedes it, and a superseded timer must not enter VR. */
export function retryIsCurrent(pendingFor, currentIntent) {
  return pendingFor !== null && pendingFor === currentIntent;
}
