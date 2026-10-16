// bun tools/buildcheck-test.ts — the build check (server/buildcheck.ts) reads a
// model the way a walking body will meet it, and says what's wrong and what's
// there. Each fixture is the two-storey test building with one thing broken
// (tools/two-storey-fixture.ts), so every warning is checked against a cause
// it should name — and the good building against no warnings at all.
import { plugin } from "bun";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const STUB = new URL("./core-stub.mjs", import.meta.url).pathname;
plugin({ name: "core-stub", setup(b) { b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); } });
const { THREE } = await import(STUB);
const C = await import("../client/lib/colliders.js");
const { checkModel } = await import("../server/buildcheck.ts");
const { FLOOR, UPPER, RISE, GOING, STAIR_FOOT, boxes, building, buildGlb } = await import("./two-storey-fixture.ts");
const { mkCheck } = await import("./harness.ts");
const { check, tally } = mkCheck();

const dir = mkdtempSync(join(tmpdir(), "buildcheck-"));
async function run(name: string, list: number[][], opts: any = {}, roof = true) {
  const f = join(dir, `${name}.glb`);
  writeFileSync(f, await buildGlb((roof ? roofed(list) : list) as any, opts));
  return checkModel(f, C, THREE);
}
const kinds = (r: any) => r.warnings.map((w: any) => w.kind);
const say = (r: any) => r.warnings.map((w: any) => `${w.kind}: ${w.message}`).join(" | ") || "(no warnings)";
// the fixture is open to the sky (other tests rely on that); a building has a roof
const ROOF = [-3.2, 6.3, -3.2, 3.2, 6.5, 3.2];
const roofed = (list: number[][]) => [...list, ROOF];
// swap one box of the fixture for others
const without = (match: (b: number[]) => boolean, ...add: number[][]) => [...boxes.filter((b: number[]) => !match(b)), ...add];
const isFront = (b: number[]) => b[2] === 2.8 && b[5] === 3;   // the three front-wall pieces

try {
  console.log("the good building:");
  const good = await run("good", boxes, { building });
  check("no warnings", good.ok && good.warnings.length === 0, say(good));
  check("two floors, both reachable", good.levels.filter((l: any) => l.reachable > 2).length === 2
    && good.levels.some((l: any) => Math.abs(l.y - FLOOR) < 0.1) && good.levels.some((l: any) => Math.abs(l.y - UPPER) < 0.1), JSON.stringify(good.levels));
  const hall = good.suggested.rooms.find((r: any) => Math.abs(r.min[1] - FLOOR) < 0.1), up = good.suggested.rooms.find((r: any) => Math.abs(r.min[1] - UPPER) < 0.1);
  check("suggests a room on each floor", !!hall && !!up && good.suggested.rooms.length === 2, JSON.stringify(good.suggested.rooms.map((r: any) => [r.id, r.min, r.area])));
  const front = good.suggested.doors.find((d: any) => d.between.includes("outside"));
  check("suggests the front door, where it is", !!front && Math.abs(front.at[0]) < 0.4 && front.at[2] > 2.3 && front.at[2] < 3.6, JSON.stringify(good.suggested.doors));
  check("suggests the stair, joining the two rooms", good.suggested.stairs.length === 1 && good.suggested.stairs[0].between.length === 2
    && good.suggested.stairs[0].at[0] > 1.6 && good.suggested.stairs[0].at[0] < 2.8, JSON.stringify(good.suggested.stairs));
  check("its suggestions are named places, ready for a places component",
    Object.keys(good.suggested.places).length === good.suggested.rooms.length + good.suggested.doors.length + good.suggested.stairs.length);

  console.log("\nbroken buildings:");
  const narrow = await run("narrow", without(isFront, [-3, FLOOR, 2.8, -0.25, 6.3, 3], [0.25, FLOOR, 2.8, 3, 6.3, 3], [-0.25, 2.4, 2.8, 0.25, 6.3, 3]));
  check("a 0.5m doorway: the inside is reachable only through a passage narrower than a body, and it says where",
    kinds(narrow).includes("narrow") && narrow.warnings.some((w: any) => w.kind === "narrow" && Math.abs(w.at[0]) < 0.5 && w.at[2] > 2.2 && w.at[2] < 3.6), say(narrow));

  // overhanging the top TWO treads: certainly cut off. (One tread is a
  // borderline case — whether a body is held at the edge depends on how far
  // it moves between collision checks — so it is not asserted here.)
  const STAIR_TOP = STAIR_FOOT - 15 * GOING;
  const overhang = await run("overhang", without((b) => b[1] === 3.1 && b[0] === 1.6, [1.6, 3.1, -2.8, 2.8, UPPER, STAIR_TOP + 2 * GOING]));
  // the exact reason (a blocked climb, or a rise) is a hint; what matters is
  // that the cut-off floor is flagged, at its height, with the stair named
  check("an upper floor overhanging the top treads: the upper floor is flagged unreachable, pointing at the stair top",
    overhang.warnings.some((w: any) => (w.kind === "climb" || w.kind === "rise") && /at 3\.3m/.test(w.message) && /last tread/.test(w.message)), say(overhang));

  const sealed = await run("sealed", without(isFront, [-3, FLOOR, 2.8, 3, 6.3, 3]));
  check("no door at all: sealed, no opening leads in", kinds(sealed).includes("sealed"), say(sealed));

  const RAISED = 0.8;
  const rise = await run("rise", [[-3, 0, -3, 3, RAISED, 3], ...boxes.filter((b: number[]) => b[1] !== 0).map((b: number[]) => b[1] === FLOOR ? [b[0], RAISED, b[2], b[3], b[4], b[5]] : b)]);
  check(`a floor ${RAISED}m up with no step: the inside is flagged unreachable`,
    rise.warnings.some((w: any) => ["rise", "sealed", "climb"].includes(w.kind)) && rise.levels.every((l: any) => l.reachable < 1), say(rise));

  const hut = await run("hut", [[-1.4, 0, -1.4, 1.4, 0.1, 1.4], [-1.4, 0.1, -1.4, -1.25, 2.5, 1.4], [1.25, 0.1, -1.4, 1.4, 2.5, 1.4], [-1.25, 0.1, -1.4, 1.25, 2.5, -1.25], [-1.4, 2.5, -1.4, 1.4, 2.6, 1.4]], {}, false);
  check("a 2.8m hut: under the walk-in size — a solid box unless spawned collide: \"exact\"",
    kinds(hut).includes("solid") && /collide: "exact"/.test(say(hut)) && hut.walkIn.roomScale === false, say(hut));

  check("...and its raised floor, a solid plinth 0.8m up, is a floor — not furniture", rise.levels.some((l: any) => Math.abs(l.y - RAISED) < 0.1), JSON.stringify(rise.levels));

  console.log("\nwhat is not a floor, and what is:");
  // a 2×2m table 0.75m up in the hall, room above it: furniture, no floor
  const table = await run("table", [...boxes, [-2.6, FLOOR + 0.7, 0.4, -0.6, FLOOR + 0.75, 2.4]], { building });
  check("a large tabletop is furniture: no extra floor, no warning", table.ok && table.levels.length === 2, `${say(table)} ${JSON.stringify(table.levels)}`);
  // the same climb in 0.10m risers: the treads are not one floor with both storeys
  const shallow = await run("shallow", [...boxes.filter((b: number[]) => !(b[0] === 1.6 && b[3] === 2.8 && b[1] === FLOOR && b[4] < UPPER - 0.01)),
    ...Array.from({ length: 30 }, (_, k) => [1.6, FLOOR, STAIR_FOOT - (k + 1) * GOING / 2, 2.8, FLOOR + (k + 1) * RISE / 2, STAIR_FOOT - k * GOING / 2])]);
  check("a stair of 0.10m risers leaves the two floors apart, joined by a stair",
    shallow.levels.length === 2 && shallow.levels.some((l: any) => Math.abs(l.y - FLOOR) < 0.1) && shallow.levels.some((l: any) => Math.abs(l.y - UPPER) < 0.1)
      && shallow.suggested.stairs.length === 1, `${JSON.stringify(shallow.levels)} stairs ${shallow.suggested.stairs.length} | ${say(shallow)}`);
  check("room ids are never reused", [good, table, shallow].every((r: any) => new Set(r.suggested.rooms.map((x: any) => x.id)).size === r.suggested.rooms.length));

  console.log("\nsize:");
  const huge = await run("huge", [[-200, 0, -200, 200, 0.1, 200], [-1, 0.1, -1, 1, 3, 1]], {}, false);
  check("a model 400m across gets its size and budget, not a cell-by-cell walk", kinds(huge).includes("too-large") && huge.levels.length === 0 && huge.ms < 5000,
    `${huge.ms}ms ${say(huge)}`);

  check("each check takes seconds, not minutes", [good, narrow, overhang, sealed, rise].every((r: any) => r.ms < 20_000),
    [good, narrow, overhang, sealed, rise].map((r: any) => `${r.ms}ms`).join(" "));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
