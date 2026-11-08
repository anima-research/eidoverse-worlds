// server/clock.ts — the authority's wall clock when its host passes none: the lab clock if one is pinned, else Date.now.
// A test pins it through tools/protocol/clock.ts so physics and rate windows are repeatable; a real authority passes its own.

export const CLOCK_ENV = "PROTOCOL_NOW";

export const now = (): number => (process.env[CLOCK_ENV] ? Number(process.env[CLOCK_ENV]) : Date.now());
