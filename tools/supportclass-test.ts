/**
 * supportclass unit test — #84: the one classifier both runtimes consume.
 * Pure math, no servers, no geometry files.
 *
 * Run: bun run tools/supportclass-test.ts
 */

// namespace import so a pre-revision head FAILS the certification checks by
// name instead of crashing the file on a missing export — controls stay controls
import * as SC from "../client/lib/supportclass.js";
const { gridAccumulator, decideSupportClass, validTopGrid, UNEVEN_MIN_LIE,
  LIE_GRID, SPARSE_MIN_CELLS, TOPGRID_VERSION, TOPGRID_MAX_JSON } = SC;
const CERT_SPREAD = (SC as any).CERT_SPREAD ?? 0.03;

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
    certSpread: CERT_SPREAD,
    cells: Array.from({ length: LIE_GRID * LIE_GRID }, (_, i) => (i % 3 === 0 ? null : 0.03)) });
  check("a well-formed grid is accepted", validTopGrid(good()));
  check("a grid without a certification bound is refused", !validTopGrid({ ...good(), certSpread: undefined }));
  check("a bound looser than the contract is refused", !validTopGrid({ ...good(), certSpread: CERT_SPREAD * 2 }));
  check("a non-positive bound is refused", !validTopGrid({ ...good(), certSpread: 0 }));
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

// ---- #94 review B2: the two adapters agree AT the strict gate --------------
// The browser computes lie in full precision; a served lie must reach the
// decision in full precision too, or a true 0.1004 flips verdicts across
// runtimes. Calibrated fixture: a dense sheet at y=0 with a small bump of
// EXACTLY the gate-straddling height — lie = bump height by construction —
// pushed through BOTH adapters: colliders.js topLie (a duck-typed mesh over
// real three) and the raw accumulator (the server's path).
console.log("\n━━ B2: browser and server verdicts agree at the 0.10 gate ━━");
{
  // colliders.js imports the browser's core.js — route it to the headless
  // stub the way mcpl/physics.ts does, BEFORE the dynamic import
  const { plugin } = await import("bun");
  const { fileURLToPath } = await import("node:url");
  const STUB = fileURLToPath(new URL("./core-stub.mjs", import.meta.url));
  plugin({ name: "core-stub-supportclass", setup(build) {
    build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB }));
  } });
  const { THREE } = await import("./core-stub.mjs");
  const { topLie } = await import("../client/lib/colliders.js");
  if (typeof topLie !== "function") {
    check("browser adapter exports topLie for parity fixtures", false, "absent (pre-revision head)");
  } else {

  const fixture = (bump: number) => {
    const pts: number[] = [];
    for (let x = 0.05; x < 3; x += 0.1) for (let z = 0.05; z < 3; z += 0.1) pts.push(x, 0, z);   // the sheet
    for (let x = 0.05; x < 0.3; x += 0.05) for (let z = 0.05; z < 0.3; z += 0.05) pts.push(x, bump, z); // the bump
    return pts;
  };
  const both = (bump: number) => {
    const pts = fixture(bump);
    // server adapter: raw accumulator
    const acc = gridAccumulator(0, 0, 3, 3)!;
    for (let i = 0; i < pts.length; i += 3) acc.add(pts[i], pts[i + 1], pts[i + 2]);
    const serverLie = acc.finish(bump).lie;
    // browser adapter: topLie over a duck-typed mesh (traverse/isMesh/
    // geometry/matrixWorld are all it reads)
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
    const obj: any = { isMesh: true, geometry: geo, matrixWorld: new THREE.Matrix4(),
      traverse(cb: (o: any) => void) { cb(this); }, updateMatrixWorld() {} };
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(3, bump, 3));
    const browserLie = topLie(obj, box);
    return { serverLie, browserLie };
  };

  const above = both(0.1004), below = both(0.0996);
  check("full precision survives both adapters (no rounding)", above.serverLie === 0.1004 && above.browserLie === 0.1004,
    JSON.stringify(above));
  check("just above the gate: BOTH call it uneven",
    decideSupportClass({ w: 3, d: 3, h: 0.5, lie: above.serverLie }).uneven
    && decideSupportClass({ w: 3, d: 3, h: 0.5, lie: above.browserLie }).uneven);
  check("just below the gate: NEITHER does",
    !decideSupportClass({ w: 3, d: 3, h: 0.5, lie: below.serverLie }).uneven
    && !decideSupportClass({ w: 3, d: 3, h: 0.5, lie: below.browserLie }).uneven);
  check("and the two adapters agree bit-for-bit", above.serverLie === above.browserLie && below.serverLie === below.browserLie,
    JSON.stringify({ above, below }));
  check("a 3-decimal rounding would have flipped the verdict (the bug pinned)",
    !decideSupportClass({ w: 3, d: 3, h: 0.5, lie: +above.serverLie.toFixed(3) }).uneven
    && decideSupportClass({ w: 3, d: 3, h: 0.5, lie: above.serverLie }).uneven);
  }
}

console.log("");
process.exit(failures ? 1 : 0);
