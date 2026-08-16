// The `grass` verb's translation and lifecycle, without a browser.
//
// Two properties are load-bearing and neither is visible in a screenshot:
//
//   REPLAY — worlds persist an append-only log, so `grass` bags written by
//   the makeGrass era must keep meaning the same field forever. They are
//   mapped at the client edge (flora_args), never rewritten in the log.
//
//   RETIREMENT — a field is a GROUP of instanced strokes with per-stroke
//   materials, textures and per-frame hooks. Walking mesh.geometry on a
//   Group frees nothing, so re-growing a meadow used to leak all of it.
//   retireField must drain every hook and call the field's own dispose().
//
// Both modules are deliberately DOM-free and THREE-free so this runs as a
// plain bun script:  bun tools/flora.test.ts

import { mapGrassArgs, presetStrokes, hexToMultiplier, isLegacyArgs } from "../client/lib/flora_args.js";
import { composeField, retireField } from "../client/lib/flora_field.js";
import { bladeLodIndex, bladeCoarseIndex, BLADE_VERTS, BLADE_INDICES,
  BLADE_COARSE_INDICES } from "../client/lib/flora_lod.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

console.log("\nlegacy grass bags (world logs replay forever)");
{
  // the bag the old build UI wrote, and the one work/launch used
  const legacy = mapGrassArgs({
    width: 90, depth: 80, center: [0, 0], bladeHeight: 0.42, wind: 0.24,
    spacing: 0.26, perCell: 4, color: 0x3a5a2c, colorTip: 0xaec96a,
  });
  check("legacy bag becomes a grass stroke", legacy.species === "grass");
  check("bladeHeight → height", near(legacy.height, 0.42), String(legacy.height));
  check("its own defaults map to density 1", near(legacy.density, 1), String(legacy.density));
  check("its own default wind maps to 1", near(legacy.wind, 1), String(legacy.wind));
  check("extent is carried through", legacy.width === 90 && legacy.depth === 80);
  check("hex colour becomes an rgb multiplier", Array.isArray(legacy.color) && legacy.color.length === 3);
  check("no makeGrass keys survive into the new call",
    ["bladeHeight", "spacing", "perCell", "colorTip", "windSpeed"].every((k) => !(k in legacy)));

  // density is the interesting one: half the spacing = 4x the plants
  const dense = mapGrassArgs({ spacing: 0.13, perCell: 4 });
  check("half spacing ≈ 4x density", near(dense.density, 4, 1e-9) || dense.density === 2.2,
    String(dense.density));
  check("density is clamped to a sane ceiling", dense.density <= 2.2, String(dense.density));
  const sparse = mapGrassArgs({ spacing: 0.52, perCell: 2 });
  check("sparse bag thins below 1", sparse.density < 1, String(sparse.density));

  // a bag with NO legacy markers must pass through untouched
  const modern = mapGrassArgs({ species: "corn", width: 40, rows: { spacing: 0.9 } });
  check("modern bag passes through", modern.species === "corn" && modern.width === 40);
  check("modern bag keeps its rows", !!modern.rows);
  check("legacy detection needs a legacy marker",
    !isLegacyArgs({ species: "grass", height: 0.4 }) && isLegacyArgs({ bladeHeight: 0.4 }));

  // colour: a hex maps around the blade atlas mean, tip-weighted
  const mid = hexToMultiplier(0x5b8a23, 0x5b8a23);   // ≈ the atlas mean itself
  check("atlas-mean hex maps near 1,1,1", mid.every((v: number) => v > 0.6 && v < 1.6), mid.join(","));
  const clamped = hexToMultiplier(0xffffff, 0xffffff);
  check("bright hex stays clamped", clamped.every((v: number) => v <= 2.5), clamped.join(","));
}

console.log("\npreset + variety strokes (one verb, several strokes)");
{
  const one = presetStrokes({ species: "grass", width: 30 });
  check("a plain grass bag is ONE stroke", one.length === 1);

  const mojave = presetStrokes({ preset: "mojave", width: 90, depth: 80, center: [0, 0] });
  check("mojave composes the full recipe", mojave.length === 7, String(mojave.length));
  const species = new Set(mojave.map((s: any) => s.species));
  check("mojave spans galleta + 3 shrubs + yucca",
    ["galleta_dry", "blackbrush", "creosote", "sagebrush", "yucca"].every((s) => species.has(s)));
  check("shrub stands are de-centred from each other",
    new Set(mojave.filter((s: any) => s.footprint === "organic")
      .map((s: any) => s.center.join(","))).size >= 4);
  check("every stroke carries its own seed",
    new Set(mojave.map((s: any) => s.seed)).size === mojave.length);

  const corn = presetStrokes({ species: "corn", width: 40, depth: 30 });
  check("a corn field interleaves variants", corn.length === 5, String(corn.length));
  check("every corn stroke is row-planted", corn.every((s: any) => s.rows?.stride === 5));
  check("the strokes tile the row grid without collision",
    new Set(corn.map((s: any) => s.rows.phase)).size === 5);
  check("one row in five is the opened-ear variant",
    corn.filter((s: any) => s.corn?.peel).length === 1);
  check("corn variants differ by seed", new Set(corn.map((s: any) => s.seed)).size === 5);

  // an explicit stride means the caller is driving: don't second-guess them
  const explicit = presetStrokes({ species: "corn", rows: { spacing: 1, plant: 0.3, stride: 2, phase: 0 } });
  check("an explicit stride is left alone", explicit.length === 1);

  const sun = presetStrokes({ species: "sunflower", width: 34, depth: 26 });
  check("a sunflower field interleaves variants", sun.length === 3, String(sun.length));
  check("every sunflower stroke is row-planted", sun.every((s: any) => s.rows?.stride === 3));
  check("the strokes tile the row grid without collision",
    new Set(sun.map((s: any) => s.rows.phase)).size === 3);
  check("sunflower variants differ by seed", new Set(sun.map((s: any) => s.seed)).size === 3);
  check("the field shares ONE heading (they face the sun together)",
    new Set(sun.map((s: any) => s.heading)).size === 1 && sun[0].heading !== undefined);
  const sunExplicit = presetStrokes({ species: "sunflower", heading: 1.2 });
  check("a caller's heading wins over the default",
    sunExplicit.every((s: any) => near(s.heading, 1.2)));

  // the sparse/normal/lush dial has to REACH the composed biomes: every
  // preset stroke carries an authored density, and a preset that dropped the
  // caller's factor left the dial doing nothing at all on mojave
  const base = presetStrokes({ preset: "mojave", width: 90, depth: 80 });
  const thin = presetStrokes({ preset: "mojave", width: 90, depth: 80, density: 0.5 });
  const lush = presetStrokes({ preset: "mojave", width: 90, depth: 80, density: 1.4 });
  check("density thins every mojave stroke",
    thin.every((s: any, i: number) => near(s.density, base[i].density * 0.5)));
  check("density enriches every mojave stroke",
    lush.every((s: any, i: number) => near(s.density, base[i].density * 1.4)));
  check("the strokes keep their RELATIVE fullness (it is a factor, not a set)",
    near(thin[0].density / thin[1].density, base[0].density / base[1].density));
  const cornDense = presetStrokes({ species: "corn", density: 1.4 });
  check("corn strokes carry density through too",
    cornDense.every((s: any) => near(s.density, 1.4)));
}

console.log("\nblade LOD index subsets (far tiles thin blades per tuft, §17b)");
{
  // an index built exactly the way vegetation.js bunchGeometry builds one:
  // per blade, (LOOPS+1)×2 = 10 verts, then LOOPS×6 = 24 entries — two
  // triangles per horizontal segment, contiguous runs
  const buildIndex = (blades: number) => {
    const idx: number[] = [];
    for (let b = 0; b < blades; b++) {
      const s0 = b * BLADE_VERTS;
      for (let lp = 0; lp < 4; lp++) {
        const a = s0 + lp * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    return new Uint16Array(idx);
  };

  // galleta_dry: perBunch 34 → 340 verts / 816 index entries
  const galleta = buildIndex(34);
  check("galleta source is 34 × 24 entries", galleta.length === 816, String(galleta.length));
  const far: any = bladeLodIndex(galleta, 34 * BLADE_VERTS, 0.4);
  check("far index keeps ceil(34×0.4) = 14 whole blades",
    !!far && far.length === 14 * BLADE_INDICES, String(far?.length));
  check("the subset stays same-typed (no widening — vertices are never copied)",
    far instanceof Uint16Array);
  if (far) {
    const runs: number[] = [];
    let whole = true;
    for (let i = 0; i < far.length; i += BLADE_INDICES) {
      const b = Math.floor(far[i] / BLADE_VERTS);
      for (let e = 0; e < BLADE_INDICES; e++) {
        if (far[i + e] !== galleta[b * BLADE_INDICES + e]) whole = false;
      }
      runs.push(b);
    }
    check("every kept run is a VERBATIM whole-blade run from the source", whole);
    check("kept blades stride the tuft, not the first k (radial balance)",
      runs[0] === 0 && runs[runs.length - 1] >= 31 && new Set(runs).size === runs.length,
      runs.join(","));
    check("kept blades stay in construction order", runs.every((b, i) => i === 0 || b > runs[i - 1]));
    check("the subset references only kept blades' vertex ranges",
      runs.every((b, i) => {
        for (let e = 0; e < BLADE_INDICES; e++) {
          const v = far[i * BLADE_INDICES + e];
          if (v < b * BLADE_VERTS || v >= (b + 1) * BLADE_VERTS) return false;
        }
        return true;
      }));
  }

  // meadow grass: perBunch 8 → 80 verts / 192 entries, keeps every 2nd blade
  const grass = buildIndex(8);
  const gfar: any = bladeLodIndex(grass, 8 * BLADE_VERTS, 0.4);
  check("meadow grass keeps ceil(8×0.4) = 4 blades, every 2nd",
    !!gfar && gfar.length === 4 * BLADE_INDICES &&
    [0, 2, 4, 6].every((b, i) => gfar[i * BLADE_INDICES] === b * BLADE_VERTS));

  // guards: anything not blade-shaped degrades to "no LOD", never a torn tuft
  check("a vertex-count mismatch refuses", bladeLodIndex(galleta, 34 * BLADE_VERTS + 1, 0.4) === null);
  check("a non-multiple index length refuses",
    bladeLodIndex(galleta.subarray(0, 100), 34 * BLADE_VERTS, 0.4) === null);
  const torn = buildIndex(4);
  torn[0] = 39;   // blade 0's run reaching into blade 3's vertices
  check("a cross-blade reference refuses", bladeLodIndex(torn, 4 * BLADE_VERTS, 0.4) === null);
  check("keep ≥ 1 (nothing to drop) refuses", bladeLodIndex(galleta, 34 * BLADE_VERTS, 1) === null);
  check("keep ≤ 0 refuses", bladeLodIndex(galleta, 34 * BLADE_VERTS, 0) === null);

  // §22n — the coarse (vertex-LOD) far index: every blade, loops 0→2→4
  const coarse: any = bladeCoarseIndex(grass, 8 * BLADE_VERTS);
  check("coarse index keeps ALL 8 blades at 12 entries each",
    !!coarse && coarse.length === 8 * BLADE_COARSE_INDICES, String(coarse?.length));
  check("coarse index stays same-typed", coarse instanceof Uint16Array);
  if (coarse) {
    let ok = true;
    for (let b = 0; b < 8; b++) {
      const base = b * BLADE_VERTS, d = b * BLADE_COARSE_INDICES;
      // 2 quads with the source winding, spanning loops 0→2 and 2→4
      const want = [0, 1, 4, 1, 5, 4, 4, 5, 8, 5, 9, 8].map((o) => base + o);
      for (let e = 0; e < BLADE_COARSE_INDICES; e++) if (coarse[d + e] !== want[e]) ok = false;
    }
    check("every blade spans loops 0→2→4 with the source winding", ok);
    check("coarse references only loop-0/2/4 vertex pairs (6 of 10 per blade)",
      Array.from(coarse as Uint16Array).every((v: number) => [0, 1, 4, 5, 8, 9].includes(v % BLADE_VERTS)));
  }
  check("coarse: a cross-blade reference refuses", bladeCoarseIndex(torn, 4 * BLADE_VERTS) === null);
  check("coarse: a vertex-count mismatch refuses", bladeCoarseIndex(galleta, 34 * BLADE_VERTS + 1) === null);
}

console.log("\nfield lifecycle (grow → replace → mow)");
{
  // a fake engine stroke: records what got released
  const makeStroke = () => {
    const st: any = {
      mesh: { name: "stroke" }, material: {}, update: () => {},
      disposed: 0, pushed: null as any, density: 1,
      setPushers(l: any) { st.pushed = l; },
      setDensity(k: number) { st.density = k; },
      dispose() { st.disposed++; },
    };
    return st;
  };
  const makeMask = () => ({ disposed: 0, dispose() { this.disposed++; } });

  const autos: any[] = [];
  const removed: any[] = [];
  const scene = { remove: (m: any) => removed.push(m) };

  // grow: a three-stroke field
  const s1 = makeStroke(), s2 = makeStroke(), s3 = makeStroke();
  const mask = makeMask();
  const group = { name: "group" };
  const field: any = composeField({ group, fields: [s1, s2, s3], mask });
  check("the field presents the group as its mesh", field.mesh === group);
  check("every stroke's wind hook is registered", field.autoHooks.length === 3);
  for (const h of field.autoHooks) autos.push(h);
  autos.push(() => {});                 // the host's pusher hook
  field.autoHooks.push(autos[autos.length - 1]);
  check("host hooks join the field's own", field.autoHooks.length === 4);

  // the governor thins the WHOLE field, not just the first stroke
  field.setDensity(0.5);
  check("density reaches every stroke",
    s1.density === 0.5 && s2.density === 0.5 && s3.density === 0.5);
  // pushers likewise
  field.setPushers([{ x: 1, y: 0, z: 2, r: 1.1 }]);
  check("pushers reach every stroke",
    !!s1.pushed && !!s2.pushed && !!s3.pushed);

  // replace: retire the old field entirely
  retireField(field, autos, scene);
  check("EVERY stroke is disposed on retire",
    s1.disposed === 1 && s2.disposed === 1 && s3.disposed === 1,
    `${s1.disposed}/${s2.disposed}/${s3.disposed}`);
  check("the clearing mask is disposed (its bus listener unsubscribes)", mask.disposed === 1);
  check("no per-frame hook is left ticking", autos.length === 0, `${autos.length} left`);
  check("the group leaves the scene", removed.length === 1 && removed[0] === group);

  // mow: retiring nothing is not an error
  retireField(null, autos, scene);
  check("mowing an empty world is a no-op", autos.length === 0 && removed.length === 1);

  // a legacy single-mesh field (no dispose) must still be freed
  let geoFreed = 0, matFreed = 0;
  const legacyField: any = {
    mesh: { geometry: { dispose: () => { geoFreed++; } }, material: { dispose: () => { matFreed++; } } },
    update: () => {},
  };
  autos.push(legacyField.update);
  retireField(legacyField, autos, scene);
  check("a field without dispose() falls back to mesh teardown", geoFreed === 1 && matFreed === 1);
  check("its bare update is unhooked too", autos.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
