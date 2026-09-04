// boxes — the sequencer's word on what a model's geometry IS, for the log.
//
// PROTOCOL_v2 Covenant III: the sim may depend on nothing that is not stamped
// into an entry. A model's bounding box is an ASSET fact — it lives in a GLB,
// not in history — so before eidosim@0.3.0 can collide bodies with the
// world's things, the sequencer writes the box into the log exactly as it
// writes `ts`: `spawn.box` on every model spawned under a live epoch, and
// `epoch.boxes` (lib → box) for every model already standing in the world
// when an epoch is entered (ruling: tel0s, 2026-09-01). Clients never author
// a box; a client-supplied one is discarded at validation.
//
// Validators are synchronous (verbs.ts), and summarizing a GLB is not — so
// this is a warm cache: `warmBoxes` is awaited on the wire before a spawn or
// epoch reaches its validator (messages.ts) and fired on every join for the
// world's standing libs, and `boxOf` answers instantly. A lib whose file
// cannot be summarized is remembered as boxless (null): the entity is simply
// not a collider — the fold shapes nothing wrong, it just knows less.
//
// Boxes are rounded to millimetres: the log should carry a number a human can
// read and a diff can compare, and a millimetre is below anything the sim's
// contact law can resolve at 15Hz.

import { resolveLibFile } from "./lint.ts";
import { summarizeGlb } from "./geometry.ts";

/** [[minx, miny, minz], [maxx, maxy, maxz]] in the model's local frame. */
export type Box = [number[], number[]];

const boxes = new Map<string, Box | null>();
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The cached box for a lib: a Box, `null` when the model has none this
 *  sequencer can see, `undefined` when it has not been warmed yet. */
export function boxOf(lib: string): Box | null | undefined {
  return boxes.get(lib);
}

/** The libs among `libs` that have not been warmed yet. */
export function coldLibs(libs: Iterable<string>): string[] {
  const out: string[] = [];
  for (const lib of new Set(libs)) if (typeof lib === "string" && lib && !boxes.has(lib)) out.push(lib);
  return out;
}

/** Summarize every not-yet-known lib once. Resolves when `boxOf` can answer
 *  for all of them; never throws (a failure is remembered as boxless). */
export async function warmBoxes(libs: Iterable<string>): Promise<void> {
  await Promise.all(coldLibs(libs).map(async (lib) => {
    let box: Box | null = null;
    try {
      const file = resolveLibFile(lib);
      const sum = file ? await summarizeGlb(file) : null;
      const bb = sum?.bbox;
      if (bb && bb.min?.length === 3 && bb.max?.length === 3
        && [...bb.min, ...bb.max].every((n) => Number.isFinite(n))) {
        box = [bb.min.map(r3), bb.max.map(r3)];
      }
    } catch { /* boxless */ }
    if (!boxes.has(lib)) boxes.set(lib, box);
  }));
}

/** Every lib the world's entities stand on — the epoch's `boxes` domain. */
export function worldLibs(state: { entities?: Record<string, { lib?: unknown }> }): string[] {
  const out = new Set<string>();
  for (const id in state.entities ?? {}) {
    const lib = state.entities![id]?.lib;
    if (typeof lib === "string" && lib) out.add(lib);
  }
  return [...out];
}
