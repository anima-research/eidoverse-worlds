/**
 * supportclass unit test — #84: the one classifier both runtimes consume.
 * Pure math, no servers, no geometry files.
 *
 * Run: bun run tools/supportclass-test.ts
 */

import { gridAccumulator, decideSupportClass, validTopGrid,
  LIE_GRID, SPARSE_MIN_CELLS, TOPGRID_VERSION, TOPGRID_MAX_JSON } from "../client/lib/supportclass.js";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

console.log("\n━━ grid accumulation and the lie ━━");
{
  // a dense 10×10m sheet at y=0, one 0.3m cushion over a corner patch,
  // box top at the cushion: lie = 0.3 − median(mostly 0) = 0.3
  const acc = gridAccumulator(0, 0, 10, 10)!;
  for (let x = 0.1; x < 10; x += 0.2) for (let z = 0.1; z < 10; z += 0.2) acc.add(x, 0, z);
  for (let x = 0.1; x < 1.5; x += 0.2) for (let z = 0.1; z < 1.5; z += 0.2) acc.add(x, 0.3, z);
  const fin = acc.finish(0.3);
  check("a cushion on a sheet: lie = box top − median cloth", near(fin.lie, 0.3), String(fin.lie));
  check("every cell over the sheet is occupied", fin.occupied === LIE_GRID * LIE_GRID, String(fin.occupied));

  // a 4-corner quad covers ~4 cells: too sparse to accuse
  const sparse = gridAccumulator(0, 0, 10, 10)!;
  for (const [x, z] of [[0, 0], [10, 0], [0, 10], [10, 10]]) sparse.add(x, 0, z);
  const sf = sparse.finish(5);
  check("sparse grids accuse nobody (lie 0)", sf.lie === 0 && sf.occupied < SPARSE_MIN_CELLS, JSON.stringify({ lie: sf.lie, occ: sf.occupied }));

  check("degenerate footprint refuses to accumulate", gridAccumulator(0, 0, 0, 10) === null);
}

console.log("\n━━ the decision gates, at their boundaries ━━");
{
  const c = (w: number, d: number, h: number, lie = 0) => decideSupportClass({ w, d, h, lie });
  check("blanket-shaped + lying top = uneven", c(2.4, 2.25, 0.3, 0.27).uneven);
  check("a crate's 5cm lie is honest enough", !c(2, 1.5, 0.9, 0.05).uneven);
  check("lie gate is strict: 0.10 exactly is not an accusation", !c(2, 1.5, 0.9, 0.10).uneven && c(2, 1.5, 0.9, 0.101).uneven);
  check("area gate: below 2m² nobody walks on it", !c(1.4, 1.4, 0.3, 0.5).floorShaped && c(1.5, 1.5, 0.3, 0.5).floorShaped);
  check("height gate: decide()'s one movable line at 1.0", c(2, 2, 1.0, 0.5).floorShaped && !c(2, 2, 1.01, 0.5).floorShaped);
  check("room-scale is neither floor-shaped nor uneven", (() => { const r = c(5, 5, 3, 9); return r.roomScale && !r.floorShaped && !r.uneven; })());
  check("scale enters through the caller: same asset, s=2 doubles lie", !c(1.2, 1.2, 0.4, 0.08).uneven && c(2.4, 2.4, 0.8, 0.16).uneven);
}

console.log("\n━━ validTopGrid: versioned, finite, bounded, or refused ━━");
{
  const good = () => ({ version: TOPGRID_VERSION, n: LIE_GRID, minXZ: [-1.2, -1.1], sizeXZ: [2.4, 2.25], lie: 0.27,
    cells: Array.from({ length: LIE_GRID * LIE_GRID }, (_, i) => (i % 3 === 0 ? null : 0.03)) });
  check("a well-formed grid is accepted", validTopGrid(good()));
  check("wrong version refused", !validTopGrid({ ...good(), version: TOPGRID_VERSION + 1 }));
  check("wrong resolution refused", !validTopGrid({ ...good(), n: 16 }));
  check("wrong cell count refused", !validTopGrid({ ...good(), cells: good().cells.slice(1) }));
  check("a NaN cell poisons the whole grid", !validTopGrid({ ...good(), cells: good().cells.map((c, i) => (i === 7 ? NaN : c)) }));
  check("non-finite extent refused", !validTopGrid({ ...good(), sizeXZ: [2.4, Infinity] }));
  check("negative extent refused", !validTopGrid({ ...good(), sizeXZ: [2.4, -1] }));
  check("nearly-empty grid refused (sparse)", !validTopGrid({ ...good(), cells: good().cells.map((_, i) => (i < SPARSE_MIN_CELLS - 1 ? 0.03 : null)) }));
  const fat = { ...good(), cells: good().cells.map((c) => (c === null ? null : 0.030000000001234567)) };
  check("the serialized-size cap is a hard wall", JSON.stringify(fat).length > TOPGRID_MAX_JSON ? !validTopGrid(fat) : true,
    `serialized=${JSON.stringify(fat).length}`);
  check("null and undefined refused outright", !validTopGrid(null) && !validTopGrid(undefined) && !validTopGrid("grid"));
}

console.log("");
process.exit(failures ? 1 : 0);
