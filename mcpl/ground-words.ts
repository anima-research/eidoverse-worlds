// ground-words — what changed in the ground between two views of a world, and the one line that tells a body near it.
//
// The ground is @world's terrain, its named features (terrain-feature:<name>) and its sculpted tiles
// (terrain-tile:<i>-<j>); shared/terrainshape.js is the law. A body's own feet follow the ground without a word, so when
// someone ELSE reshapes it nearby the body is told: who, where from where it stands, how much, and how far the ground
// under its own feet moved. Pure: two views in, words out (agent-senses.ts decides when to speak).
import { SCULPT, tileIndex, shapeable } from "../shared/terrainshape.js";
import { compass } from "../shared/waterkind.js";

type View = { terrain?: any; terrainFeatures?: Record<string, any>; terrainTiles?: Record<string, number[]> };
export type GroundChange = {
  /** the terrain itself: made (there was none), gone, or changed */
  terrain?: "made" | "gone" | "changed";
  /** named features set, changed or removed */
  features: { name: string; was?: any; now?: any }[];
  /** what the sculpted layer did: the box [x0, z0, x1, z1] (m) round every sample that moved, and the most any rose or fell (mm) */
  sculpt?: { box: [number, number, number, number]; up: number; down: number };
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const LEVEL: number[] = [];

/** What differs in the ground from `prev` to `next`, or null when nothing does. */
export function groundChange(prev: View, next: View): GroundChange | null {
  const out: GroundChange = { features: [] };
  if (!same(prev.terrain, next.terrain)) out.terrain = !prev.terrain ? "made" : !next.terrain ? "gone" : "changed";
  const F0 = prev.terrainFeatures ?? {}, F1 = next.terrainFeatures ?? {};
  for (const name of [...new Set([...Object.keys(F0), ...Object.keys(F1)])].sort()) if (!same(F0[name], F1[name])) out.features.push({ name, was: F0[name], now: F1[name] });
  const T0 = prev.terrainTiles ?? {}, T1 = next.terrainTiles ?? {}, n = SCULPT.tile;
  let box: [number, number, number, number] | null = null, up = 0, down = 0;
  for (const key of new Set([...Object.keys(T0), ...Object.keys(T1)])) {
    const a = T0[key] ?? LEVEL, b = T1[key] ?? LEVEL; if (a === b) continue;
    const ij = tileIndex(key); if (!ij) continue;
    for (let k = 0; k < n * n; k++) { const d = (b[k] ?? 0) - (a[k] ?? 0); if (!d) continue;
      const x = SCULPT.origin + (ij[0] * n + (k % n)) * SCULPT.spacing, z = SCULPT.origin + (ij[1] * n + Math.floor(k / n)) * SCULPT.spacing;
      box = box ? [Math.min(box[0], x), Math.min(box[1], z), Math.max(box[2], x), Math.max(box[3], z)] : [x, z, x, z];
      if (d > up) up = d; if (-d > down) down = -d; }
  }
  if (box) out.sculpt = { box, up, down };
  return out.terrain || out.features.length || out.sculpt ? out : null;
}

const m2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
const m1 = (v: number) => String(Math.round(v * 10) / 10);
/** Where a spot is from a body: "under you" within half a metre, else how far and which way. */
const whereFrom = (me: { x: number; z: number }, x: number, z: number, d = Math.hypot(x - me.x, z - me.z)) =>
  (d <= 0.5 ? "under you" : `${Math.max(1, Math.round(d))} m ${compass(x - me.x, z - me.z)} of you`);
/** A named feature as a thing in the ground, and how big: "a hill" / "a pit" / "a ridge" / "a valley" / "a levelled pad". */
function shapeWords(f: any): { a: string; the: string; size: string; at: [number, number]; reach: number } | null {
  if (!f || typeof f !== "object") return null;
  const r = Number(f.radius) || 0, h = Number(f.height) || 0;
  if (f.type === "ridge") { const len = Math.hypot(f.x2 - f.x1, f.z2 - f.z1), w = h >= 0 ? "ridge" : "valley";
    return { a: `a ${w}`, the: `the ${w}`, size: `${m1(len)} m long, ${m1(Math.abs(h))} m ${h >= 0 ? "high" : "deep"}`, at: [(f.x1 + f.x2) / 2, (f.z1 + f.z2) / 2], reach: len / 2 + r }; }
  if (f.type === "flatten") return { a: "a levelled pad", the: "the levelled pad", size: `${m1(r)} m in radius, at ${m1(h)} m`, at: [f.x, f.z], reach: r + (Number(f.edge) || r / 2) };
  if (f.type === "hill") { const w = h >= 0 ? "hill" : "pit"; return { a: `a ${w}`, the: `the ${w}`, size: `${m1(r)} m in radius, ${m1(Math.abs(h))} m ${h >= 0 ? "high" : "deep"}`, at: [f.x, f.z], reach: r }; }
  return null;
}

/** The line a body is told, or null when none of the change is within `radius` metres of it and its own ground didn't
 *  move. `who`: who did it, already in words. `feet`: how far the ground under the body itself moved, metres (+ up). */
export function groundLine(who: string, c: GroundChange, me: { x: number; z: number }, radius: number, feet = 0): string | null {
  const stood = Math.abs(feet) >= 0.005 ? `where you stand it is ${m2(Math.abs(feet))} m ${feet > 0 ? "higher" : "lower"} now` : "";
  if (c.terrain) {
    const said = c.terrain === "gone" ? `${who} removed this world's terrain: the ground is level now` : c.terrain === "made" ? `${who} gave this world a terrain: the ground is no longer the level floor`
      : `${who} changed this world's terrain: the whole ground may have moved`;
    return `${said}${stood ? `; ${stood}` : ""}.`;
  }
  const parts: string[] = [];
  if (c.sculpt) { const [x0, z0, x1, z1] = c.sculpt.box, { up, down } = c.sculpt;
    const nx = Math.min(Math.max(me.x, x0), x1), nz = Math.min(Math.max(me.z, z0), z1), d = Math.hypot(nx - me.x, nz - me.z);   // the nearest of it
    if (d <= radius) { const across = Math.max(1, Math.round(Math.max(x1 - x0, z1 - z0) + SCULPT.spacing));
      const where = d <= 0.5 ? "under you" : whereFrom(me, (x0 + x1) / 2, (z0 + z1) / 2, d);
      parts.push(up && down ? `reshaped the ground ${where} (up to ${m2(up / 1000)} m up and ${m2(down / 1000)} m down), across about ${across} m`
        : `${up ? "raised" : "lowered"} the ground ${where} by up to ${m2((up || down) / 1000)} m, across about ${across} m`); } }
  for (const f of c.features) { const s = shapeWords(f.now ?? f.was); if (!s) continue;
    if (Math.hypot(s.at[0] - me.x, s.at[1] - me.z) - s.reach > radius) continue;
    const where = whereFrom(me, s.at[0], s.at[1]);
    parts.push(f.was === undefined ? `added ${s.a} to the ground ${where}: "${f.name}", ${s.size}`
      : f.now === undefined ? `took ${s.the} "${f.name}" out of the ground, ${where}` : `changed ${s.the} "${f.name}" in the ground, ${where}: now ${s.size}`); }
  if (!parts.length) return stood ? `${who} reshaped the ground, and ${stood}.` : null;
  return `${who} ${parts.join("; and ")}${stood ? `; ${stood}` : ""}.`;
}
