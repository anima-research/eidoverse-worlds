// instances — what the draft antra/instances says: one thing drawn many times (shared/instances.js).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/shared/instances-test.ts
//
// Binds: every viewer derives the same copies from the same value (a scatter is a function of its seed, or of the
// thing's id); each shape puts its copies where it says; rows placed by hand read in every length; a malformed value
// is absent, never a throw; the copy count has a ceiling; an option changed never reshuffles the rest.
import { suite } from "../gate/suite.ts";
import { readInstances, describeInstances, seedOf, INSTANCE_MAX, SCATTER_SHAPES, INSTANCES } from "../../shared/instances.js";

const { check, done } = suite("instances");
const copy = (r: any, i: number) => Array.from(r.copies.slice(i * 8, i * 8 + 8)) as number[];
const all = (r: any) => Array.from({ length: r.count }, (_, i) => copy(r, i));
const near = (a: number, b: number, e = 1e-5) => Math.abs(a - b) < e;
const unit = (c: number[]) => near(Math.hypot(c[3], c[4], c[5], c[6]), 1);
// the heading a copy faces (its +Z turned by its quaternion, on the ground plane)
const heading = (c: number[]) => { const [x, y, z, w] = c.slice(3, 7); return Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y)); };

console.log("\ncopies placed by hand:");
{
  const r = readInstances({ at: [[1, 2, 3], [4, 5, 6, Math.PI / 2], [7, 8, 9, 0, 2], [1, 1, 1, 0, 0.3826834, 0, 0.9238795], [2, 2, 2, 0, 0, 0, 2, 0.5]] })!;
  check("H1 a row is [x, y, z], then yaw, then scale; or a quaternion, then scale", r.count === 5 && JSON.stringify(copy(r, 0)) === JSON.stringify([1, 2, 3, 0, 0, 0, 1, 1]) && near(heading(copy(r, 1)), Math.PI / 2) && copy(r, 2)[7] === 2 && near(heading(copy(r, 3)), Math.PI / 4) && copy(r, 4)[7] === 0.5);
  check("H2 a quaternion is normalized (a doubled one is the same turn)", near(copy(r, 4)[6], 1) && all(r).every(unit));
  check("H3 a row that isn't numbers, or of a length that means nothing, is skipped; the rest still draw", readInstances({ at: [[1, 2], [1, 2, 3], ["a", 0, 0], [1, 2, 3, 4, 5, 6], [0, 0, 0, 0, 0, 0, 0], null, [9, 9, 9]] })!.count === 2);
  check("H4 the thing itself is drawn too unless original is false", readInstances({ at: [[1, 0, 0]] })!.original === true && readInstances({ at: [[1, 0, 0]], original: false })!.original === false);
}

console.log("\na scatter is a function of its seed:");
{
  const v = { scatter: { count: 200, shape: "disc", radius: 10, seed: 42 } };
  const a = readInstances(v, "thing-a")!, b = readInstances(JSON.parse(JSON.stringify(v)), "thing-b")!;
  check("D1 the same value gives the same copies, whoever reads it (a seed outranks the id)", JSON.stringify(all(a)) === JSON.stringify(all(b)));
  const noSeed = { scatter: { count: 50, shape: "disc", radius: 10 } };
  check("D2 with no seed each thing scatters its own way, the same every time", JSON.stringify(all(readInstances(noSeed, "one")!)) === JSON.stringify(all(readInstances(noSeed, "one")!)) && JSON.stringify(all(readInstances(noSeed, "one")!)) !== JSON.stringify(all(readInstances(noSeed, "two")!)) && seedOf("one") !== seedOf("two"));
  const big = readInstances({ scatter: { ...v.scatter, scale: [0.5, 2], tilt: 0.3 } })!;
  check("D3 changing one option (scale, tilt) leaves every copy where it was", all(a).every((c, i) => near(c[0], copy(big, i)[0]) && near(c[2], copy(big, i)[2])));
  check("D4 a longer scatter starts with the shorter one's copies", all(readInstances({ scatter: { ...v.scatter, count: 300 } })!).slice(0, 200).every((c, i) => JSON.stringify(c) === JSON.stringify(copy(a, i))));
}

console.log("\neach shape:");
{
  const disc = all(readInstances({ scatter: { count: 500, shape: "disc", radius: 10, inner: 4, seed: 1 } })!);
  check("G1 disc: on the ground plane, between inner and radius, spread over it", disc.every((c) => c[1] === 0 && Math.hypot(c[0], c[2]) >= 4 - 1e-6 && Math.hypot(c[0], c[2]) <= 10 + 1e-6) && disc.filter((c) => c[0] > 0).length > 180 && disc.filter((c) => c[0] > 0).length < 320);
  const ring = all(readInstances({ scatter: { count: 12, shape: "ring", radius: 5 } })!);
  check("G2 ring: evenly round the circle, the first in front (+Z), each facing out", ring.every((c) => near(Math.hypot(c[0], c[2]), 5)) && near(ring[0][0], 0) && near(ring[0][2], 5) && near(ring[3][0], 5) && near(ring[3][2], 0) && ring.every((c) => near(Math.sin(heading(c)), c[0] / 5) && near(Math.cos(heading(c)), c[2] / 5)));
  const ringIn = all(readInstances({ scatter: { count: 4, shape: "ring", radius: 5, yaw: "in" } })!);
  check("G3 yaw: in faces the middle; a number is one heading for all", near(Math.cos(heading(ringIn[0])), -1) && all(readInstances({ scatter: { count: 6, shape: "disc", radius: 3, yaw: 1.25 } })!).every((c) => near(heading(c), 1.25)));
  const box = all(readInstances({ scatter: { count: 400, shape: "box", size: [10, 4, 6], seed: 2 } })!);
  check("G4 box: centred on the origin, from the ground up to its height", box.every((c) => Math.abs(c[0]) <= 5 && c[1] >= 0 && c[1] <= 4 && Math.abs(c[2]) <= 3) && box.some((c) => c[1] > 3) && box.some((c) => c[1] < 1));
  const grid = all(readInstances({ scatter: { count: 12, shape: "grid", size: [8, 0, 6] } })!);
  const xs = [...new Set(grid.map((c) => c[0].toFixed(4)))], zs = [...new Set(grid.map((c) => c[2].toFixed(4)))];
  check("G5 grid: rows and columns filling its size, cell-centred, all facing front", xs.length * zs.length === 12 && grid.every((c) => Math.abs(c[0]) < 4 && Math.abs(c[2]) < 3 && near(heading(c), 0)), `${xs.length} × ${zs.length}`);
  const line = all(readInstances({ scatter: { count: 5, shape: "line", to: [8, 2, 0] } })!);
  check("G6 line: evenly from the origin to `to`, both ends included", near(line[0][0], 0) && near(line[4][0], 8) && near(line[4][1], 2) && near(line[2][0], 4) && near(line[2][1], 1));
  const ball = all(readInstances({ scatter: { count: 300, shape: "sphere", radius: 6, seed: 3 } })!);
  check("G7 sphere: on its surface, above and below", ball.every((c) => near(Math.hypot(c[0], c[1], c[2]), 6, 1e-4)) && ball.some((c) => c[1] > 3) && ball.some((c) => c[1] < -3));
  const sized = all(readInstances({ scatter: { count: 200, shape: "disc", radius: 5, scale: [0.5, 2], tilt: 0.4, seed: 5 } })!);
  check("G8 scale: each copy between min and max; tilt: each leans at most that far; every turn a unit quaternion", sized.every((c) => c[7] >= 0.5 && c[7] <= 2 && unit(c) && Math.acos(Math.min(1, 1 - 2 * (c[3] * c[3] + c[5] * c[5]))) <= 0.4 + 1e-4) && sized.some((c) => c[7] > 1.5) && sized.some((c) => c[7] < 0.8));
  check("G9 an unknown shape is a disc; every listed shape draws", JSON.stringify(all(readInstances({ scatter: { count: 5, shape: "blob", seed: 1 } })!)) === JSON.stringify(all(readInstances({ scatter: { count: 5, seed: 1 } })!)) && SCATTER_SHAPES.every((shape) => readInstances({ scatter: { count: 3, shape } })?.count === 3));
}

console.log("\nmalformed is absent, and there is a ceiling:");
{
  check("M1 a value that draws nothing is null, never a throw", [null, undefined, 5, "x", [], {}, { at: [] }, { at: "no" }, { scatter: null }, { scatter: { count: 0 } }, { scatter: { count: -5 } }, { scatter: { count: "many" } }, { scatter: [] }].every((v) => readInstances(v as any) === null));
  check("M2 junk in a scatter's fields falls back to what absence means", readInstances({ scatter: { count: 4, radius: "wide", size: [1, 2], scale: "big", tilt: {}, yaw: "sideways", seed: "s" } } as any, "id")?.count === 4);
  check(`M3 at most ${INSTANCE_MAX} copies, by hand and scattered together`, readInstances({ scatter: { count: 10 * INSTANCE_MAX } })!.count === INSTANCE_MAX && readInstances({ at: [[0, 0, 0], [1, 0, 0]], scatter: { count: INSTANCE_MAX } })!.count === INSTANCE_MAX);
  check("M4 hand-placed copies come first, then the scatter", (() => { const r = readInstances({ at: [[9, 9, 9]], scatter: { count: 3, shape: "ring", radius: 1 } })!; return r.count === 4 && copy(r, 0)[0] === 9; })());
  check("M5 ground is only ever the word true", readInstances({ at: [[0, 0, 0]], ground: true })!.ground === true && readInstances({ at: [[0, 0, 0]], ground: 1 } as any)!.ground === false);
}

console.log("\nin words, for someone who reads rather than sees:");
{
  check("W1 a ring", describeInstances({ scatter: { count: 14, shape: "ring", radius: 4 } }) === "drawn 15 times, spaced round a ring of radius 4 m");
  check("W2 only the copies, on the ground", describeInstances({ scatter: { count: 60, shape: "disc", radius: 16 }, ground: true, original: false }) === "drawn 60 times, scattered in a disc of radius 16 m, standing on the ground");
  check("W3 by hand; and nothing to say of a value that draws nothing", describeInstances({ at: [[1, 0, 0], [2, 0, 0]] }) === "drawn 3 times, placed by hand" && describeInstances({}) === null);
  check("W4 the component's name", INSTANCES === "antra/instances");
}

done();
