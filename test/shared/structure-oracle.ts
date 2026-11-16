// test/shared/structure-oracle.ts — what the structure routing suites share: the wall-crossing oracle, computed from the
// AUTHORED edges apart from the planner (so a shared predicate bug cannot pass it), and one tick driver for agent walks.
// Each agent suite keeps its own process: the collider map loads once per process (mcpl/physics.ts) and changes how feet
// meet the ground, so walks written for a process with none would read another suite's.
import type { WorldAgent } from "../../mcpl/agent.ts";
export type P = [number, number];

/** The shared fixtures: a two-room house (a doored divider, a door out), the same sealed by a window, and huge sparse bounds. */
export const house = { levels: [{ y: 0,
  tiles: Array.from({ length: 8 }, (_, i) => [i % 4, Math.floor(i / 4)]),
  walls: [...Array.from({ length: 4 }, (_, x) => [0, x, 0]), ...Array.from({ length: 4 }, (_, x) => [0, x, 2]),
    [1, 0, 0], [1, 0, 1], [1, 4, 0], [1, 4, 1], [1, 2, 0], [1, 2, 1]],
  apertures: [[0, 0, 0, "door"], [1, 2, 0, "door"]] as any[],
}] };
export const sealed = structuredClone(house); sealed.levels[0].apertures = [[0, 0, 0, "window"], [1, 2, 0, "door"]];
export const sparse = { levels: [{ tiles: [], walls: [[1, 0, 0], [1, 100000000, 0]], apertures: [] }] };

/** Whether a→b crosses a solid authored wall of `level` (doors and arches are open; a window is a wall). A leg running
 *  along a wall's line is not counted as crossing it. */
export function crossesLevel(level: any, tile: number, a: P, b: P) {
  return level.walls.some(([axis, x, z]: number[]) => {
    if (level.apertures?.some(([k, i, j, kind]: any[]) => k === axis && i === x && j === z && (kind === "door" || kind === "arch"))) return false;
    // parametric line at the wall, checked against the wall's closed span
    const A = axis === 0 ? 0 : 1;
    const B = axis === 0 ? 1 : axis === 1 ? 0 : axis === 2 ? -1 : 1;
    const C = (axis === 0 ? z : axis === 1 ? x : axis === 2 ? x - z : x + z + 1) * tile;
    const v0 = A * a[0] + B * a[1] - C, v1 = A * b[0] + B * b[1] - C;
    if (v0 * v1 > 0 || Math.abs(v0 - v1) < 1e-10) return false;
    const t = v0 / (v0 - v1), px = a[0] + t * (b[0] - a[0]), pz = a[1] + t * (b[1] - a[1]);
    if (t < -1e-8 || t > 1 + 1e-8) return false;
    return axis === 0 ? px >= x * tile - 1e-8 && px <= (x + 1) * tile + 1e-8 :
      axis === 1 ? pz >= z * tile - 1e-8 && pz <= (z + 1) * tile + 1e-8 :
      px >= x * tile - 1e-8 && px <= (x + 1) * tile + 1e-8 && pz >= z * tile - 1e-8 && pz <= (z + 1) * tile + 1e-8;
  });
}
/** No leg of `points` crosses a solid wall of the given level (the one the walker meets). */
export const valid = (data: any, points: number[][], level = 0) =>
  points.slice(1).every((p, i) => !crossesLevel(data.levels[level], data.tile ?? 1, points[i] as P, p as P));


/** Ticks a walk under way to its end: the positions each tick, the waypoints as planned, and its verdict. */
export async function drive(a: WorldAgent, promise: Promise<boolean>, each?: (i: number) => void) {
  const points = [{ ...a.pos }];
  const planned: P[] = (a as any).target ? [(a as any).target, ...(a as any).legs].map((q: any) => [q.x, q.z] as P) : [];
  for (let i = 0; i < 2000 && (a as any).target; i++) { each?.(i); (a as any).tick(); points.push({ ...a.pos }); }
  if ((a as any).target) { a.stop(); throw new Error("walk failed to finish within bounded ticks"); }
  return { arrived: await promise, points, samples: points.map((p) => [p.x, p.z] as P), planned };
}
/** walkTo and drive: run unless told, arrival tolerance 0 unless told. */
export const walk = (a: WorldAgent, to: P, { run = true, tolerance = 0, timeout = 10000 } = {}) => drive(a, a.walkTo(...to, run, timeout, tolerance));
