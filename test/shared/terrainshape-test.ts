// terrainshape — placed features and heightmaps over the terrain noise (shared/terrainshape.js), the sim's
// use of them (shared/terrainmath.js), and the server's image round trip (server/heightmap.ts).
//   bun test/shared/terrainshape-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { WAIT_SCALE } from "../gate/wait.ts";   // a wall-clock bound stretches with PROTOCOL_TIMEOUT_SCALE (bot #333 187, 218)

// the server half writes into OPT_DIR — point it at a scratch store BEFORE config.ts is imported
process.env.OPT_DIR = mkdtempSync(join(tmpdir(), "terrainshape-opt-"));
process.env.WORLDS_DIR = mkdtempSync(join(tmpdir(), "terrainshape-worlds-"));

const { shapeParams, shapeHeight, shapedHeightAt, encodeGrid, decodeGrid, registerGrid, gridFor, requestGrid, setGridFetcher, shapeReady, gridRetryIn, MAX_FEATURES, waterParams, waterStance, waterCost, waterBlocks, SWIM_AT, SWIM_SPEED } =
  await import("../../shared/terrainshape.js");
const { terrainParams, makeHeightField } = await import("../../shared/terrainmath.js");
const { ingestHeightmap, exportHeightmap, serveHeightmapExport, exportIsCached, exportStats, resetExportBudget, heightRange, EXPORT_MAX, EXPORT_PER_ADDRESS, EXPORT_PER_MINUTE } = await import("../../server/heightmap.ts");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const flat = () => 0;

console.log("\nan unshaped world is untouched");
{
  const args = { seed: 7, size: 160, segments: 200, amplitude: 2.6, flatRadius: 16, layers: [{ color: "#5a6b3a" }] };
  check("no features, no heightmap → no shape", shapeParams(args) === null);
  check("the sim's params carry no shape key (its JSON is unchanged)", !("shape" in terrainParams(args)));
  const base = (x: number, z: number) => x + z;
  check("shapedHeightAt hands back the base function itself", shapedHeightAt(base, args) === base);
  check("an empty features list is still no shape", shapeParams({ ...args, features: [] }) === null);
}

console.log("\nfeatures");
{
  const S = shapeParams({ features: [{ type: "hill", x: 10, z: -5, radius: 8, height: 6 }] })!;
  const h = shapeHeight(flat, S, 100);
  check("a hill peaks at its height", near(h(10, -5), 6));
  check("...is gone at its radius", near(h(18, -5), 0));
  check("...and beyond", near(h(40, 40), 0));
  check("...and is round-topped (smooth, not a cone)", h(11, -5) > 5.8, `got ${h(11, -5)}`);
  const pit = shapeHeight(flat, shapeParams({ features: [{ type: "hill", x: 0, z: 0, radius: 5, height: -3 }] })!, 100);
  check("a negative hill is a pit", near(pit(0, 0), -3));
}
{
  const S = shapeParams({ features: [{ type: "ridge", x1: -20, z1: 0, x2: 20, z2: 0, radius: 4, height: 5 }] })!;
  const h = shapeHeight(flat, S, 100);
  check("a ridge holds its height all along its line", near(h(-20, 0), 5) && near(h(7, 0), 5) && near(h(20, 0), 5));
  check("...falls to nothing at its radius off the line", near(h(0, 4), 0));
  check("...and rounds off past its ends", near(h(24, 0), 0) && h(22, 0) > 0);
}
{
  const base = (x: number) => x * 0.5;
  const S = shapeParams({ features: [{ type: "flatten", x: 0, z: 0, radius: 6, height: 2, edge: 4 }] })!;
  const h = shapeHeight(base, S, 100);
  check("flatten sets an absolute height inside its radius", near(h(0, 0), 2) && near(h(5, 0), 2));
  check("...blends back to the ground over its edge", h(8, 0) > 2 && h(8, 0) < base(8));
  check("...and leaves the ground alone past radius+edge", near(h(10.5, 0), base(10.5)));
  const S2 = shapeParams({ features: [
    { type: "hill", x: 0, z: 0, radius: 20, height: 10 },
    { type: "flatten", x: 0, z: 0, radius: 5, height: 8 },
  ] })!;
  check("features apply in order: a plateau cut into a hill", near(shapeHeight(flat, S2, 100)(0, 0), 8));
}

console.log("\nvalidation");
{
  const S = shapeParams({ features: [
    { type: "volcano", x: 0, z: 0, radius: 5, height: 5 },
    { type: "hill", x: 0, z: 0, radius: 0, height: 5 },
    { type: "hill", x: "a", z: 0, radius: 5, height: 5 },
    { type: "ridge", x1: 0, z1: 0, radius: 5, height: 5 },
    { type: "hill", x: 1, z: 2, radius: 5, height: 1e9 },
  ] })!;
  check("unknown types, zero radius, bad numbers and half-given ridges are dropped", S.features.length === 1);
  check("an absurd height is clamped", S.features[0].height === 500);
  const many = Array.from({ length: 100 }, (_, i) => ({ type: "hill", x: i, z: 0, radius: 1, height: 1 }));
  check(`at most ${MAX_FEATURES} features`, shapeParams({ features: many })!.features.length === MAX_FEATURES);
  check("a heightmap must name a store grid", shapeParams({ heightmap: { grid: "../../etc/passwd", min: 0, max: 1 } }) === null);
}

console.log("\nthe sim grounds bodies on the shaped law");
{
  const args = { seed: 7, size: 160, amplitude: 2.6, flatRadius: 16, features: [{ type: "hill", x: 30, z: 30, radius: 10, height: 7 }] };
  const plain = makeHeightField(terrainParams({ ...args, features: undefined }));
  const shaped = makeHeightField(terrainParams(args));
  check("the hill is in the sim's field", near(shaped(30, 30), plain(30, 30) + 7));
  check("...and only there", near(shaped(-50, -50), plain(-50, -50)));
}

console.log("\nheightmap grids");
{
  const g = { w: 3, h: 2, data: new Uint16Array([0, 1000, 65535, 32768, 7, 40000]) };
  const back = decodeGrid(JSON.parse(JSON.stringify(encodeGrid(g))));
  check("encode/decode round-trips every sample", back.w === 3 && back.h === 2 && Array.from(back.data).join() === Array.from(g.data).join());
  registerGrid("store/heightmaps/0000000000000001.json", { w: 2, h: 2, data: new Uint16Array([0, 65535, 65535, 0]) });
  const S = shapeParams({ heightmap: { grid: "store/heightmaps/0000000000000001.json", min: -2, max: 8 } })!;
  const h = shapeHeight(flat, S, 10);
  check("black is min, white is max, at the corners", near(h(-5, -5), -2) && near(h(5, -5), 8) && near(h(-5, 5), 8) && near(h(5, 5), -2));
  check("between samples it is bilinear", near(h(0, 0), 3));
  check("outside the square the edge extends", near(h(-50, -5), -2));
}

console.log("\nexport → edit → import (server/heightmap.ts)");
{
  const args = { seed: 7, size: 120, amplitude: 4, flatRadius: 10,
    features: [{ type: "hill", x: 20, z: -15, radius: 14, height: 9 }, { type: "ridge", x1: -40, z1: 30, x2: 10, z2: 40, radius: 6, height: -4 }] };
  const truth = makeHeightField(terrainParams(args));
  const { png, meta } = exportHeightmap(args, 257, "t");
  const img = PNG.sync.read(Buffer.from(png), { skipRescale: true });
  check("export is a 257×257 16-bit grayscale PNG", img.width === 257 && img.height === 257 && img.data instanceof Uint16Array);
  check("...that spans the ground's real range", meta.max > meta.min && meta.size === 120);
  const up = ingestHeightmap(png, "00000000000000aa") as any;
  check("the export imports as-is, its range read back from the PNG", !up.error && near(up.meta.min, meta.min) && near(up.meta.max, meta.max), JSON.stringify(up).slice(0, 120));
  const back = makeHeightField(terrainParams({ size: 120, heightmap: { grid: up.grid, min: up.meta.min, max: up.meta.max } }));
  let worst = 0;
  for (let i = 0; i < 257; i++) for (let j = 0; j < 257; j++) {
    const x = (i / 256 - 0.5) * 120, z = (j / 256 - 0.5) * 120;
    worst = Math.max(worst, Math.abs(back(x, z) - truth(x, z)));
  }
  const step = (meta.max - meta.min) / 65535;
  check(`the round trip lands every sample back (within one 16-bit step, ${(step * 1000).toFixed(2)} mm)`, worst <= step, `worst ${(worst * 1000).toFixed(3)} mm`);
}
{
  const p = new PNG({ width: 4, height: 4, colorType: 0, inputColorType: 0, inputHasAlpha: false });
  p.data = Buffer.from(Array.from({ length: 16 }, (_, i) => i * 17));
  const png8 = PNG.sync.write(p, { colorType: 0, inputColorType: 0, inputHasAlpha: false });
  const up = ingestHeightmap(new Uint8Array(png8), "00000000000000bb") as any;
  check("an 8-bit grayscale PNG imports too (in 256 steps)", !up.error && up.bits === 8 && up.meta === null);
  const g = decodeGrid(JSON.parse(await Bun.file(join(process.env.OPT_DIR!, up.grid)).text()));
  check("...scaled to the full 16-bit range", g.data[0] === 0 && g.data[15] === 65535);
  const big = ingestHeightmap(new Uint8Array(PNG.sync.write(new PNG({ width: 1100, height: 2 }))), "00000000000000cc") as any;
  check("an oversized image is refused with the size it wants", big.status === 413 && /1025/.test(big.error));
  // a header that claims a huge image is refused from the header alone, before any pixel is decoded
  const lie = new Uint8Array(PNG.sync.write(new PNG({ width: 4, height: 4 })));
  new DataView(lie.buffer).setUint32(16, 60000); new DataView(lie.buffer).setUint32(20, 60000);
  const t0 = performance.now(), liar = ingestHeightmap(lie, "00000000000000dd") as any;
  check("a 60000×60000 header is refused before decoding", liar.status === 413 && performance.now() - t0 < 50 * WAIT_SCALE, JSON.stringify(liar));
  check("...and a body that is not a PNG says so", (ingestHeightmap(new Uint8Array(8), "00000000000000ee") as any).status === 415);
}
{
  const args = { seed: 3, size: 100, amplitude: 3 };
  resetExportBudget();
  const a = serveHeightmapExport(args, 4097, "cap", "1.1.1.1") as any;
  check(`an export's resolution is capped at ${EXPORT_MAX}`, a.ok && PNG.sync.read(Buffer.from(a.png)).width === EXPORT_MAX && !a.cached);
  check("...and the same export again is served from the cache", (serveHeightmapExport(args, 4097, "cap", "1.1.1.1") as any).cached);
  const r = heightRange(args);
  check("the json range answer agrees with the export's", Math.abs(r.min - a.meta.min) < 0.2 && Math.abs(r.max - a.meta.max) < 0.2, JSON.stringify([r, a.meta]));
}

console.log("\nthe export budget is checked before the work");
{
  resetExportBudget();
  const args = { seed: 5, size: 60, amplitude: 2 }, ip = "2.2.2.2";
  const answers = Array.from({ length: EXPORT_PER_ADDRESS }, (_, i) => serveHeightmapExport(args, 100 + i, "b", ip));
  check(`${EXPORT_PER_ADDRESS} new exports a minute are granted`, answers.every((x) => x.ok && !x.cached));
  const made = exportStats.made, refused = serveHeightmapExport(args, 300, "b", ip);
  check("the next is refused (429)…", !refused.ok && refused.status === 429 && refused.retryAfter > 0);
  check("…having sampled nothing and cached nothing", !exportIsCached(args, 300, "b") && exportStats.made === made, `${exportStats.made - made} sampled`);
  check("…so asking again is refused again, not served from a cache it filled", !serveHeightmapExport(args, 300, "b", ip).ok);
  check("an export already made is still served to the same address", (serveHeightmapExport(args, 102, "b", ip) as any).cached === true);
  check("another address has its own budget", serveHeightmapExport(args, 300, "b", "3.3.3.3").ok);
  check("a minute later the address may export again", serveHeightmapExport(args, 301, "b", ip, Date.now() + 61_000).ok);
  resetExportBudget();
  let n = 0;
  for (let i = 0; i < EXPORT_PER_MINUTE + 5; i++) if (serveHeightmapExport(args, 40 + i, "b", `10.0.0.${i}`).ok) n++;
  check(`many addresses together get ${EXPORT_PER_MINUTE} a minute, not one budget each`, n === EXPORT_PER_MINUTE, `${n}`);
  resetExportBudget();
}

console.log("\ngrid loading");
{
  const ref = (n: number) => `store/heightmaps/${n.toString(16).padStart(16, "0")}.json`;
  const one = { w: 2, h: 2, data: new Uint16Array([1, 2, 3, 4]) };
  for (let i = 0; i < 20; i++) registerGrid(ref(0x100 + i), one);
  check("only the most recent grids are kept", gridFor(ref(0x100)) === null && gridFor(ref(0x113)) === one);
  let calls = 0;
  setGridFetcher(async (r: string) => { calls++; if (r === ref(0x200)) return encodeGrid(one); throw new Error("404"); });
  const [p1, p2] = [requestGrid(ref(0x200)), requestGrid(ref(0x200))];
  const g = await p1; await p2;
  check("two requests for one grid fetch it once", calls === 1 && !!g && gridFor(ref(0x200)) !== null);
  calls = 0;
  await requestGrid(ref(0x201)); await requestGrid(ref(0x201));
  check("a grid that failed is not re-fetched at once", calls === 1);
  const S = shapeParams({ heightmap: { grid: ref(0x202), min: 0, max: 1 } });
  check("a shape whose grid is missing is not ready (the sim waits)", !shapeReady(S) && shapeReady(null) && shapeReady(shapeParams({ features: [{ type: "hill", x: 0, z: 0, radius: 3, height: 1 }] })));
  check("a failed fetch backs off by seconds, not half a minute", gridRetryIn(ref(0x201)) > 0 && gridRetryIn(ref(0x201)) <= 1000, `${gridRetryIn(ref(0x201))}`);
  // a built terrain holds its grid: the cache turning over does not turn its ground to noise
  const tall = { w: 2, h: 2, data: new Uint16Array([65535, 65535, 65535, 65535]) };
  registerGrid(ref(0x300), tall);
  const h = shapeHeight(() => -99, shapeParams({ heightmap: { grid: ref(0x300), min: 0, max: 5 } })!, 10);
  check("a shaped height reads its grid", near(h(1, 1), 5));
  for (let i = 0; i < 20; i++) registerGrid(ref(0x400 + i), one);
  check("...and keeps reading it after the cache has evicted it", gridFor(ref(0x300)) === null && near(h(1, 1), 5), `${h(1, 1)}`);
  setGridFetcher(null);
}

console.log("\nwater");
{
  check("no water key, no water", waterParams({ seed: 7 }) === null && waterParams({ water: null }) === null);
  const W = waterParams({ water: { level: -0.5 } })!;
  check("a level alone is enough, with a default colour and opacity", W.level === -0.5 && /^#/.test(W.color) && W.opacity > 0);
  check("a bad colour falls back, opacity is clamped", waterParams({ water: { level: 0, color: "red", opacity: 9 } })!.color !== "red"
    && waterParams({ water: { level: 0, opacity: 9 } })!.opacity === 1);
  check("a non-number level is no water", waterParams({ water: { level: "deep" } }) === null);
  check("water is not shaping: it never moves the ground", shapeParams({ water: { level: 3 } }) === null);
  // a 1.7 m body, water at 0
  const dry = waterStance(0, 0.5, 1.7);
  check("dry ground: the ground, at full speed", dry.y === 0.5 && dry.speedFactor === 1 && !dry.swimming);
  const knee = waterStance(0, -0.5, 1.7), waist = waterStance(0, -0.95, 1.7), chest = waterStance(0, -1.27, 1.7);
  check(`wading drags: knee ${knee.speedFactor!.toFixed(2)}, waist ${waist.speedFactor!.toFixed(2)}, chest ${chest.speedFactor!.toFixed(2)}`,
    knee.speedFactor! < 0.9 && knee.speedFactor! > waist.speedFactor! && waist.speedFactor! > chest.speedFactor! && chest.speedFactor! >= 0.5);
  check("...and the feet stay on the bed while wading", knee.y === -0.5 && !chest.swimming);
  const deep = waterStance(0, -4, 1.7);
  check(`past the chest (${(SWIM_AT * 1.7).toFixed(2)} m) the body floats, chest at the surface`, deep.swimming && Math.abs(deep.y + SWIM_AT * 1.7) < 1e-9 && deep.depth === 4);
  check("a taller body wades deeper before it swims", !waterStance(0, -1.5, 2.2).swimming && waterStance(0, -1.5, 1.7).swimming);
  check("nothing is walled off any more", waterBlocks() === false);
  check("the planner's price: 1 dry, more wading, ~1.7 swimming", waterCost(0, 1, 1.7) === 1 && waterCost(0, -1, 1.7) > 1.4 && Math.abs(waterCost(0, -5, 1.7) - 1.55 / SWIM_SPEED) < 1e-9);
  check("no water, no change", waterStance(null, -50, 1.7).y === -50 && waterStance(null, -50, 1.7).speedFactor === 1);
}

// a world's material layers (shared/terrainlayers.js): an authored array passes through; any older or other shape is
// ignored, never executed
{
  const { materialLayerSpecs } = await import("../../shared/terrainlayers.js");
  const authored = [{ color: "#123456", repeat: 7 }, { color: "#abcdef" }];
  check("material layers: an authored array passes through by identity", materialLayerSpecs(authored) === authored);
  for (const [what, v] of [["missing", undefined], ["null", null], ["a legacy number", 1], ["an object", { color: "#fff" }], ["a string", "grass"]] as const)
    check(`material layers: ${what} means none`, JSON.stringify(materialLayerSpecs(v)) === "[]");
}

// ---- shaping from beside the bag: named features (terrain-feature:<name>) and the sculpted layer (terrain-tile:<i>-<j>)
console.log("\nnamed features and sculpted tiles ride beside the bag");
{
  const { withShaping, groundArgs, shapingOf, shapeable, tileIndex, tileKey, tileAt, tileOf, tileSaid, layerFor, SCULPT, MAX_NAMED, MAX_TILES } = await import("../../shared/terrainshape.js");
  const { applyStroke, BRUSHES } = await import("../../shared/protocol/sculpt.js");
  const bag = { kind: "noise", seed: 1, size: 80, amplitude: 0 };
  const level = () => new Array(SCULPT.tile ** 2).fill(0);
  const H = (args: any) => makeHeightField(terrainParams(args));
  const hill = { type: "hill", x: 10, z: 0, radius: 4, height: 2 }, pad = { type: "flatten", x: 10, z: 0, radius: 2, height: 0.5 };

  check("with neither, the ground's args are the bag itself (an unshaped world reads as it did)", withShaping(bag, {}, {}) === bag && withShaping(bag, null, null) === bag && groundArgs({ terrain: bag, sky: {} }) === bag);
  check("a level ground is never shaped: no terrain, and kind flat, read neither", withShaping(null, { a: hill }, null) === null && !shapeable({ kind: "flat" }) && shapeParams(withShaping({ kind: "flat", height: 2 }, { a: hill }, { "128-128": { mm: level().fill(900) } })) === null
    && H(withShaping({ kind: "flat", height: 2 }, { a: hill }, null))(10, 0) === 2);
  const one = withShaping(bag, { cove: hill }, null);
  check("a named feature shapes the ground as a list feature does", H(one)(10, 0) === 2 && H(one)(14, 0) === 0 && JSON.stringify(shapeParams(one)!.features) === JSON.stringify(shapeParams({ ...bag, features: [hill] })!.features));
  check("…and the args' JSON is still the bag alone: nothing a stored bag could carry", JSON.stringify(one) === JSON.stringify(bag) && shapingOf(one)!.named.length === 1 && shapeParams({ ...bag, named: [hill], tiles: { "128-128": level().fill(900) } }) === null);
  // order: the bag's list first, then the named ones by order, then by name
  const listed = { ...bag, features: [{ type: "hill", x: 10, z: 0, radius: 4, height: 1 }] };
  check("named features apply after the bag's list", H(withShaping(listed, { pad }, null))(10, 0) === 0.5 && H(withShaping(bag, { pad }, null))(10, 0) === 0.5);
  check("…by name when no order says otherwise (a-pad levels, then b-hill rises on it; b-pad levels a-hill away)", H(withShaping(bag, { "a-pad": pad, "b-hill": hill }, null))(10, 0) === 2.5 && H(withShaping(bag, { "b-pad": pad, "a-hill": hill }, null))(10, 0) === 0.5);
  check("…and by order before name", H(withShaping(bag, { "b-pad": { ...pad, order: -1 }, "a-hill": hill }, null))(10, 0) === 2.5 && H(withShaping(bag, { "a-pad": { ...pad, order: 5 }, "b-hill": hill }, null))(10, 0) === 0.5);
  check("a malformed named feature is dropped, as in the list", shapeParams(withShaping(bag, { bad: { type: "dome", x: 0, z: 0, radius: 2, height: 1 }, thin: { type: "hill", x: 0, z: 0, radius: 0.01, height: 1 }, ok: hill }, null))!.features.length === 1);
  const many = Object.fromEntries(Array.from({ length: MAX_NAMED + 5 }, (_, i) => [`f${String(i).padStart(3, "0")}`, { type: "hill", x: i, z: 0, radius: 1, height: 1 }]));
  check(`at most ${MAX_NAMED} named features are read`, shapeParams(withShaping(bag, many, null))!.features.length === MAX_NAMED);

  // the lattice
  check("a tile's key is <i>-<j>, 0–255 each, written one way", JSON.stringify(tileIndex("128-128")) === "[128,128]" && tileIndex("0-255") !== null && tileIndex("256-0") === null && tileIndex("01-2") === null && tileIndex("-1-2") === null && tileIndex("3") === null && tileKey(3, 9) === "3-9");
  check("the world's centre is the corner of tile 128-128; a tile is 16 m a side", tileAt(0, 0) === "128-128" && tileAt(-0.01, 0) === "127-128" && tileAt(15.99, 16) === "128-129" && tileAt(-2048, -2048) === "0-0" && tileAt(2048, 0) === null && tileAt(-2048.01, 0) === null);
  check("a tile is 1024 whole millimetres within the limit, or it isn't one", tileOf({ mm: level() }) !== null && tileOf({ mm: [1, 2] }) === null && tileOf({ mm: level().fill(0.5) }) === null && tileOf({ mm: level().fill(SCULPT.limit + 1) }) === null && tileOf({}) === null);
  const mm = level(); mm[0] = 1000; mm[1] = 400; mm[SCULPT.tile] = -250;   // (gx, gz) = (0,0), (1,0), (0,1) of tile 128-128: x = 0, 0.5; z = 0, 0.5
  const sc = withShaping(bag, null, { "128-128": { mm } }), h = H(sc);
  check("a sample stands at its lattice point, in millimetres, row-major with rows along z", h(0, 0) === 1 && h(0.5, 0) === 0.4 && h(0, 0.5) === -0.25 && h(0.5, 0.5) === 0);
  check("between samples the layer is bilinear, and it fades into the level tile beside it", near(h(0.25, 0), 0.7) && near(h(0, 0.25), 0.375) && near(h(0.25, 0.25), (1000 + 400 - 250 + 0) / 4000) && near(h(-0.25, 0), 0.5) && near(h(0, -0.25), 0.5) && h(-0.5, 0) === 0 && h(8, 8) === 0);
  const over = withShaping({ ...bag, features: [{ type: "flatten", x: 0, z: 0, radius: 6, height: 3 }] }, { rise: { type: "hill", x: 0, z: 0, radius: 5, height: 1 } }, { "128-128": { mm } });
  check("the sculpted layer is added last: a flatten under it never levels a stroke away", H(over)(0, 0) === 5 && H(over)(0.5, 0) > 4.3);
  check("a tile that names no tile, or isn't one, is not read", shapeParams(withShaping(bag, null, { "300-1": { mm }, "128-128": { mm: [1] } })) === null);
  check("the sim's params name the layer and never carry it (they are hashed whole, at every digest)", typeof shapeParams(sc)!.sculpt === "string" && /^[0-9a-f]{32}$/.test(shapeParams(sc)!.sculpt!) && JSON.stringify(terrainParams(sc)).length < 400 && !("sculpt" in shapeParams(one)!));
  const again = withShaping(bag, null, { "128-128": { mm: mm.slice() } }), other = level(); other[5] = 1;
  check("the same sculpting has the same name on every machine, and other sculpting another", shapeParams(again)!.sculpt === shapeParams(sc)!.sculpt && shapeParams(withShaping(bag, null, { "128-128": { mm: other } }))!.sculpt !== shapeParams(sc)!.sculpt
    && shapeParams(withShaping(bag, null, { "128-129": { mm } }))!.sculpt !== shapeParams(sc)!.sculpt);
  check("params that crossed a wire (a sim's snapshot) find the layer by its name and stand on the same ground", makeHeightField(JSON.parse(JSON.stringify(terrainParams(sc))))(0.25, 0) === h(0.25, 0) && shapeReady(JSON.parse(JSON.stringify(shapeParams(sc)))));
  check("a layer this machine doesn't hold is not ready, as a heightmap's missing grid isn't", shapeReady({ features: [], heightmap: null, sculpt: "0".repeat(32) }) === false && layerFor("0".repeat(32)) === null);
  { const kept = shapeParams(sc)!.sculpt!; for (let i = 0; i < 300; i++) { const t = level(); t[0] = i + 1; shapeParams(withShaping(bag, null, { "1-1": { mm: t } })); }
    check("…and reading the ground's args again names a layer that had gone", layerFor(kept) === null && shapeParams(sc)!.sculpt === kept && layerFor(kept) !== null); }

  // from a fold's record of @world
  const wc: any = { terrain: bag, "terrain-feature:cove": hill, "terrain-tile:128-128": { mm }, sky: { hours: 3 }, "roles:u-x": { role: "builder" } };
  const g1 = groundArgs(wc), g2 = groundArgs({ ...wc, sky: { hours: 4 } }), g3 = groundArgs({ ...wc, "terrain-feature:cove": { ...hill } });
  check("groundArgs gathers @world's pieces: the same pieces give the same args (a cache keyed on them holds), a changed piece new ones", H(g1)(10, 0) === 2 && H(g1)(0, 0) === 1 && g1 === g2 && g3 !== g1);
  check("…and a world whose ground is level reads its terrain as it is, pieces or not", groundArgs({ ...wc, terrain: { kind: "flat", height: 1 } }).kind === "flat" && shapingOf(groundArgs({ ...wc, terrain: { kind: "flat", height: 1 } })) === null && groundArgs({ sky: {} }) === null);
  { resetExportBudget(); const base = { kind: "noise", seed: 3, size: 40, amplitude: 1 }, raised = level(); raised.fill(5000);
    const plain = serveHeightmapExport(base, 33, "clay", "10.0.0.1") as any, withHill = withShaping(base, { m: { type: "hill", x: 0, z: 0, radius: 15, height: 9 } }, null), withTile = withShaping(base, null, { "128-128": { mm: raised } });
    const cachedBefore = [exportIsCached(base, 33, "clay"), exportIsCached(withHill, 33, "clay"), exportIsCached(withTile, 33, "clay")];
    const a = serveHeightmapExport(withHill, 33, "clay", "10.0.0.1") as any, b = serveHeightmapExport(withTile, 33, "clay", "10.0.0.1") as any;
    check("the heightmap export is cached by the whole ground: a named feature or a stroke on the same bag is a new export, never the image from before it",
      plain.ok && JSON.stringify(cachedBefore) === "[true,false,false]" && a.ok && !a.cached && b.ok && !b.cached && a.meta.max > plain.meta.max + 5 && b.meta.max > plain.meta.max + 3 && exportIsCached(withHill, 33, "clay"),
      JSON.stringify({ cachedBefore, plain: plain.meta, a: a.meta, b: b.meta })); }
  check("a reply says a tile in a line, never its samples", JSON.stringify(tileSaid("terrain-tile:128-128", { mm })) === JSON.stringify({ samples: 1024, min: -250, max: 1000 }) && tileSaid("terrain", bag) === bag);

  // the brush (shared/protocol/sculpt.js): worked out once, on whole millimetres
  const tiles0 = new Map<string, number[]>(), flatGround = (extra = new Map<string, number[]>()) => H(withShaping(bag, null, Object.fromEntries([...extra].map(([k, v]) => [k, { mm: v }]))));
  const stroke = (tiles: Map<string, number[]>, a: any) => { const r: any = applyStroke(tiles, a, flatGround(tiles)); const next = new Map(tiles); for (const [k, v] of r.writes ?? []) { if (v) next.set(k, v); else next.delete(k); } return { ...r, tiles: next, h: flatGround(next) }; };
  const up = stroke(tiles0, { brush: "raise", path: [[8, 8]], radius: 3, strength: 0.5 });
  check("raise: the path's own height rises by the strength, falling to nothing at the radius", up.h(8, 8) === 0.5 && up.h(9.5, 8) > 0.2 && up.h(9.5, 8) < 0.4 && up.h(11, 8) === 0 && up.h(8, 4.9) === 0 && up.writes.size === 1 && !up.clamped);
  const down = stroke(up.tiles, { brush: "lower", path: [[8, 8]], radius: 3, strength: 0.5 });
  check("lower takes the same away, sample for sample, and a tile left level is given back as none", down.h(8, 8) === 0 && down.writes.get("128-128") === null && down.tiles.size === 0);
  const a = stroke(stroke(tiles0, { brush: "raise", path: [[8, 8]], radius: 3, strength: 0.5 }).tiles, { brush: "lower", path: [[9, 8], [12, 8]], radius: 2, strength: 0.2 });
  const b = stroke(stroke(tiles0, { brush: "lower", path: [[9, 8], [12, 8]], radius: 2, strength: 0.2 }).tiles, { brush: "raise", path: [[8, 8]], radius: 3, strength: 0.5 });
  check("a raise and a lower land the same in either order (each an integer add per sample)", JSON.stringify([...a.tiles]) === JSON.stringify([...b.tiles]));
  const line = stroke(tiles0, { brush: "raise", path: [[2, 2], [30, 2]], radius: 1.5, strength: 1 });
  check("a path of more points is one line the brush follows: the same height all along it, across tiles", line.h(2, 2) === 1 && line.h(16, 2) === 1 && line.h(30, 2) === 1 && line.h(16, 3.5) === 0 && line.writes.size === 2);
  const fl = stroke(up.tiles, { brush: "flatten", path: [[8, 8]], radius: 3, height: 2 });
  check("flatten brings the ground to one height at the path, by its strength elsewhere", fl.h(8, 8) === 2 && fl.h(9.5, 8) > 0.5 && fl.h(9.5, 8) < 2 && stroke(up.tiles, { brush: "flatten", path: [[8, 8]], radius: 3, height: 2, strength: 0.5 }).h(8, 8) === 1.25);
  check("…to the ground's own height at the path's first point when none is said", stroke(up.tiles, { brush: "flatten", path: [[8, 8], [10, 8]], radius: 1 }).h(10, 8) === 0.5);
  const sm = stroke(up.tiles, { brush: "smooth", path: [[8, 8]], radius: 3 });
  check("smooth brings a peak down toward the ground round it", sm.h(8, 8) < 0.5 && sm.h(8, 8) > 0);
  const top = stroke(new Map([["128-128", level().fill(SCULPT.limit - 100)]]), { brush: "raise", path: [[8, 8]], radius: 2, strength: 1 });
  check("a sample stops at the layer's limit, and the stroke says it did", top.clamped === true && Math.max(...top.tiles.get("128-128")!) === SCULPT.limit);
  check("a stroke over more ground than one stroke may is refused before it is worked out", (applyStroke(tiles0, { brush: "raise", path: [[-1500, 0], [1500, 0]], radius: 64, strength: 1 }, () => 0) as any).tooBig === true);
  check("a stroke off the lattice writes nothing", (applyStroke(tiles0, { brush: "raise", path: [[5000, 5000]], radius: 3, strength: 1 }, () => 0) as any).writes.size === 0 && BRUSHES.length === 4 && MAX_TILES === 1024);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : "\n\x1b[32mall passed\x1b[0m");
process.exit(failures ? 1 : 0);
