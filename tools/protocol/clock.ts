// tools/protocol/clock.ts — the lab clock: the one place a test moves the authority's wall time (server/clock.ts reads it).
// The seam is process-global, so a suite owns one counter (`labClock`) and every request steps it forward through
// `advance`; hygiene-check's lab-clock rule refuses setting the env anywhere else.
import { CLOCK_ENV } from "../../server/clock.ts";

export const LAB_EPOCH = 1_800_000_000_000;

export function pin(ms: number): number { process.env[CLOCK_ENV] = String(ms); return ms; }

/** NaN when nothing is pinned and no fallback is given, as `Number(undefined)`. */
export const pinned = (fallback?: number): number => Number(process.env[CLOCK_ENV] ?? fallback);

/** For a child process's env. */
export const pinEnv = (ms: number) => ({ [CLOCK_ENV]: String(ms) });

/** `fn` runs on the real wall clock; whatever was pinned before is pinned again after, even on a throw. */
export async function unpinned<R>(fn: () => R | Promise<R>): Promise<R> {
  const was = process.env[CLOCK_ENV]; delete process.env[CLOCK_ENV];
  try { return await fn(); } finally { if (was !== undefined) process.env[CLOCK_ENV] = was; }
}

/** `t` is the counter; assigning it moves the counter without pinning (the next `advance` pins from there). */
export type LabClock = { t: number; advance(ms: number): number; set(ms: number): number; pin(): number };

export function labClock(start = LAB_EPOCH): LabClock {
  let t = start;
  return {
    get t() { return t; },
    set t(ms: number) { t = ms; },
    advance(ms: number) { t += ms; return pin(t); },
    set(ms: number) { t = ms; return pin(t); },
    pin: () => pin(t),
  };
}
