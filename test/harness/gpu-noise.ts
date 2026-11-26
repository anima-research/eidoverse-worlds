// test/harness/gpu-noise.ts — the page errors a browser suite may drop as headless GPU noise, and only when the page's GPU
// is gone.
//
// Headless Chrome takes the WebGPU device away (harness.ts's GPU guard: ~1 s into a page on Linux; ~0.4 s after boot on
// windows-latest, comps-parity on main bc9b163a4, run 45781801288). After that three's error scopes reject "Instance dropped
// in popErrorScope" and the sky's detached finish reports "sky finish". Four suites dropped any error whose text merely
// contained "popErrorScope" or "sky finish", on a live device too, so a real error that happened to say either was
// swallowed. Here the two texts are dropped only once the page's GPU is gone, by gpulost.js's verdict (it fires for a lost
// WebGL context or WebGPU device, the browser's 'destroyed' included) or three's (renderer._isDeviceLost, set for any other
// reason: what froze clone-discard's counts on windows-latest, run 45874280243). On a live GPU every error counts.
//   const { real, gpuGone } = await beyondGpuNoise(errors, evalJson);   check("no page errors …", real.length === 0, …)

export const GPU_NOISE = /Instance dropped in popErrorScope|\bsky finish\b/;
/** the page's own verdict: true once gpulost.js or three has seen its context or device go */
export const GPU_GONE_EXPR = "import('/lib/core.js').then((m) => !!(globalThis.__gpuLost?.fired || m.renderer?._isDeviceLost), () => !!globalThis.__gpuLost?.fired)";

/** Pure: the errors that count, given whether the GPU is gone. */
export const realErrors = (errors: readonly string[], gpuGone: boolean): string[] => (gpuGone ? errors.filter((e) => !GPU_NOISE.test(e)) : [...errors]);

/** Ask the page whether its GPU is gone (a page that can't answer: not gone, so every error counts), then filter. */
export async function beyondGpuNoise(errors: readonly string[], evaluate: (expr: string) => Promise<unknown>): Promise<{ real: string[]; gpuGone: boolean; dropped: number }> {
  const gpuGone = (await Promise.resolve().then(() => evaluate(GPU_GONE_EXPR)).catch(() => false)) === true;
  const real = realErrors(errors, gpuGone);
  return { real, gpuGone, dropped: errors.length - real.length };
}
