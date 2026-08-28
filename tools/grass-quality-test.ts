// The resident's local grass cap (#60), run headless.
//
//   bun tools/grass-quality-test.ts
//
// The contract under test: the resident's chosen level (full/medium/low/off,
// persisted per browser) and the frame governor's session shed are separate
// dials, and the field draws their MIN — the governor may thin below the cap
// but can never silently raise above it, `off` genuinely draws zero without
// touching the shared field object, and the cap survives field replacement
// (re-grow) and arrives before the first field loads. None of it is ever a
// world verb.
//
// Negative control: this suite FAILS on the branch base. Most failures are
// necessarily novelty because main has no applied-truth report; the behavioral
// anchor is the source-extracted shipped dial below, which demonstrates the
// silent no-op live (request 0.35 while an incompatible stroke draws 800/800)
// before main proves it has no surface capable of naming that mismatch.
//
// The APPLIED-TRUTH sections (#74) extend the contract: the dial can
// silently no-op (wireDensityDial leaves a stroke without setDensity when
// its instanced attributes are absent; the composed dial optional-chains),
// so every inspection surface must distinguish chosen / governor shed /
// effective REQUESTED / effective APPLIED, read from live instance counts.
// Their negative control also runs on both trees: flora.js's shipped
// wireDensityDial (source-extracted) demonstrates the silent no-op LIVE, and
// main then fails the "can this tree name it?" checks with the false success
// it actually reports (policy 0.35, stroke drawing its full built count).

import { plugin } from "bun";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
// URL.pathname yields "/D:/…" on Windows, which nothing can open —
// fileURLToPath is the portable spelling
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
plugin({
  name: "grass-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here("./grass-terrain-stub.mjs") }));
  },
});

// terrain reads localStorage at module init — install the fake FIRST, with a
// value already present: the "setting exists before any field loads" case.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
};
store.set("ew-grass-quality", "low");
(globalThis as any)._autoParticleSystems = [];

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// ---- behavioral delta — runs on BOTH trees -------------------------------
// Evaluate the dial exactly as flora.js ships it, extracted from the tree's
// own source (not retyped), so this one assertion is a live A/B: main's
// inline expression floors at >=1 instance per stroke and keeps 50 of 1000
// at factor 0; the branch delegates to densityCount and keeps 0.
const gqMod = await import("../client/lib/grass_quality.js").then((m) => m, () => null);
console.log("\nflora's shipped density dial (source-extracted, both trees)");
{
  const src = await Bun.file(here("../client/lib/flora.js")).text();
  const dial = src.match(/const keep = ([^;\n]+);/);
  let keep: unknown = "dial expression not found in flora.js";
  if (dial) {
    try {
      keep = new Function("n", "f", "densityCount", `return (${dial[1]});`)(
        1000, 0, gqMod?.densityCount);
    } catch (e) { keep = `threw: ${e}`; }
  }
  check("factor 0 keeps ZERO of 1000 instances (main keeps 50)", keep === 0, `keep=${keep}`);
}

if (!gqMod) {
  console.log(`\n${pass} passed, ${fail} failed — client/lib/grass_quality.js absent` +
    ` (expected on main; that absence is novelty, the dial assertion above is the behavior)`);
  process.exit(1);
}
const { makeGrassQuality, densityCount, GRASS_QUALITY, QUALITY_DENSITY, GRASS_MOTION } = gqMod;
const terrain = await import("../client/lib/terrain.js");

// A field shaped to terrain's setGrass contract, recording what it was told.
const mkField = () => {
  const f: any = {
    mesh: { visible: true },
    calls: [] as number[],
    disposed: false,
    autoHooks: [],
  };
  f.setDensity = (k: number) => f.calls.push(k);
  f.dispose = () => { f.disposed = true; };
  return f;
};
const last = (f: any) => f.calls[f.calls.length - 1];

console.log("\nthe dial itself (makeGrassQuality)");
{
  const q = makeGrassQuality(undefined);
  check("no store → full, effective 1", q.quality === "full" && near(q.effective(), 1));
  const s = new Map([["ew-grass-quality", "medium"]]);
  const fake = { getItem: (k: string) => s.get(k) ?? null, setItem: (k: string, v: string) => s.set(k, v) };
  const q2 = makeGrassQuality(fake);
  check("persisted level loads", q2.quality === "medium" && near(q2.cap, 0.6));
  q2.setQuality("low");
  check("setQuality persists", s.get("ew-grass-quality") === "low");
  check("reload sees the change", makeGrassQuality(fake).quality === "low");
  check("unknown level refused, current stands",
    q2.setQuality("turbo") === "low" && q2.quality === "low");
  s.set("ew-grass-quality", "9000");
  check("garbage in the store → full", makeGrassQuality(fake).quality === "full");

  const g = makeGrassQuality(undefined);
  g.setQuality("medium");
  check("governor may lower below the cap", near((g.shedTo(0.35), g.effective()), 0.35));
  check("governor cannot raise above the cap", near((g.shedTo(1), g.effective()), 0.6));
  g.setQuality("full");
  g.shedTo(0.6);
  check("raising the cap does not un-shed the session", near(g.effective(), 0.6));
  g.setQuality("off");
  check("off is zero regardless of shed", near(g.effective(), 0));
  check("shed clamps to [0,1]", near(g.shedTo(2), 1) && near(g.shedTo(-1), 0) && near(g.shedTo(NaN), 1));
  check("levels and factors agree",
    GRASS_QUALITY.every((k: string) => QUALITY_DENSITY[k] !== undefined));
}

console.log("\nthe instance-count dial (densityCount)");
{
  check("full keeps the field", densityCount(1000, 1) === 1000);
  check("0.6 keeps 600", densityCount(1000, 0.6) === 600);
  check("tiny factors floor at 5%", densityCount(1000, 0.001) === 50);
  check("a thinned field never reads as mowed", densityCount(3, 0.01) === 1);
  check("off draws ZERO (main keeps ≥1 per stroke)", densityCount(1000, 0) === 0);
  check("negative is zero too", densityCount(1000, -0.5) === 0);
}

console.log("\nterrain lifecycle (the real setGrass/setGrassDensity path)");
{
  check("cap set BEFORE any field load is live", terrain.getGrassQuality() === "low");

  const a = mkField();
  terrain.setGrass(a);
  check("field arriving finds the cap waiting", near(last(a), 0.35), String(a.calls));

  check("chosen and effective are separately inspectable",
    terrain.getGrassQuality() === "low" && near(terrain.getGrassDensity(), 0.35)
    && near(terrain.getGrassShed(), 1));

  terrain.setGrassQuality("medium");
  check("cap change applies to the loaded field", near(last(a), 0.6), String(a.calls));

  const b = mkField();
  terrain.setGrass(b);
  check("replacement field inherits the cap (sticky re-grow)", near(last(b), 0.6), String(b.calls));
  check("replaced field was retired, not mutated", a.disposed === true);

  terrain.setGrassQuality("off");
  check("off tells the field to draw zero", near(last(b), 0));
  check("off hides the group locally", b.mesh.visible === false);
  check("off leaves the field object whole (shared state untouched)",
    b.disposed === false && typeof b.setDensity === "function");

  terrain.setGrassQuality("full");
  check("raising the cap restores in place", b.mesh.visible === true && near(last(b), 1));

  terrain.setGrassDensity(0.6);
  check("governor thins the live field", near(last(b), 0.6));
  terrain.setGrassQuality("low");
  terrain.setGrassDensity(1);
  check("governor recovery still honors the cap", near(last(b), 0.35), String(last(b)));

  check("the chosen level persisted for the next session",
    store.get("ew-grass-quality") === "low");

  check("unknown level via terrain refused",
    terrain.setGrassQuality("mega") === "low" && terrain.getGrassQuality() === "low");
}

// ---- applied truth (#74) --------------------------------------------------
// flora.js's SHIPPED wireDensityDial, source-extracted so the silent-no-op
// mechanism is demonstrated on both trees, not retyped into the test.
const floraSrc = await Bun.file(here("../client/lib/flora.js")).text();
const wdMatch = floraSrc.match(/function wireDensityDial\(field\) \{[\s\S]*?\n\}/);
const wireDial = wdMatch
  ? new Function("densityCount", `${wdMatch[0]}; return wireDensityDial;`)(densityCount)
  : null;

/** A stroke shaped to createFlora's contract: instance total, live mesh
 *  count, and (when compatible) the instanced attributes the dial expects. */
const mkStroke = (n: number, { attrs = true, label = "", stem = false } = {}) => {
  const mk = (itemSize: number) => ({
    itemSize,
    array: Float32Array.from({ length: n * itemSize }, (_, i) => i),
    needsUpdate: false,
  });
  const table: any = attrs ? { aPosRot: mk(4), aScaleVar: mk(2), aPhase: mk(1) } : {};
  return {
    count: n,
    strokeLabel: label || undefined,
    mesh: { count: n, geometry: { getAttribute: (nm: string) => table[nm] } },
    ...(stem ? { stemMesh: { count: n } } : {}),
  } as any;
};

const ff = await import("../client/lib/flora_field.js");

console.log("\nthe silent no-op seam (flora's shipped wireDensityDial, both trees)");
{
  check("wireDensityDial extracted from flora.js", typeof wireDial === "function");
  const good = mkStroke(1000, { label: "0:grass" });
  const yucca = mkStroke(800, { attrs: false, label: "1:yucca" });
  wireDial?.(good); wireDial?.(yucca);
  check("a stroke with instanced attributes gets a dial", typeof good.setDensity === "function");
  check("missing attributes leave NO dial — the seam is real", yucca.setDensity === undefined);
  good.setDensity?.(0.35);
  check("a dialed stroke's LIVE count follows densityCount",
    good.mesh.count === densityCount(1000, 0.35), `count=${good.mesh.count}`);
  const shrub = mkStroke(1000, { label: "shrub", stem: true });
  wireDial?.(shrub); shrub.setDensity?.(0.35);
  check("shrub report covers both leaf and stem draw meshes",
    ff.strokeApplied?.(shrub, 0.35)?.ok === true
      && ff.strokeApplied?.(shrub, 0.35)?.stemDrawn === densityCount(1000, 0.35));
  shrub.stemMesh.count = 900;
  check("shrub stem mismatch makes the live report fail",
    ff.strokeApplied?.(shrub, 0.35)?.ok === false
      && ff.strokeApplied?.(shrub, 0.35)?.stemDrawn === 900,
    JSON.stringify(ff.strokeApplied?.(shrub, 0.35)));

  const group: any = { visible: true };
  const field: any = ff.composeField({ group, fields: [good, yucca], mask: null });
  field.setDensity(0.35);
  check("the composed dial silently no-ops on the dial-less stroke",
    yucca.mesh.count === 800, `count=${yucca.mesh.count}`);
  check("this tree can NAME that no-op (field.applied)",
    typeof field.applied === "function",
    "main claims density 0.35 while 1:yucca draws 800/800 — success from policy arithmetic alone");
  const rep = field.applied?.(0.35);
  check("mixed field reports PARTIAL and identifies the stroke",
    rep?.status === "partial"
      && rep.strokes.some((s: any) => !s.ok && s.stroke === "1:yucca" && s.why === "no-density-dial")
      && rep.strokes.some((s: any) => s.ok && s.stroke === "0:grass"),
    JSON.stringify(rep ?? "no applied() on this tree"));
  check("a planted-nothing stroke is vacuously applied, never a failure",
    ff.strokeApplied?.({ count: 0, mesh: { count: 0 } }, 0.35)?.ok === true);
}

console.log("\nthe applied report through terrain (getGrassApplied)");
{
  const gApplied = (terrain as any).getGrassApplied;
  check("terrain exports getGrassApplied", typeof gApplied === "function",
    "no applied surface on this tree — getGrassDensity() reports intent only");
  const rep0 = gApplied?.() ?? null;

  terrain.setGrassQuality("low");

  // acceptance 1+2: a compatible field under `low`
  const g2 = mkStroke(1000, { label: "0:grass" }); wireDial?.(g2);
  terrain.setGrass(ff.composeField({ group: { visible: true }, fields: [g2], mask: null }));
  let rep = gApplied?.();
  check("low on a compatible field: APPLIED, consistent with live mesh.count",
    rep?.status === "applied" && rep.strokes[0]?.drawn === g2.mesh.count
      && g2.mesh.count === densityCount(1000, 0.35),
    JSON.stringify(rep ?? rep0));
  check("the report carries the whole chain: chosen, cap, shed, requested",
    rep?.quality === "low" && near(rep?.cap, 0.35) && near(rep?.shed, 1) && near(rep?.requested, 0.35));

  // acceptance 3: an incompatible field must not read as success at 0.35
  const g3 = mkStroke(800, { attrs: false, label: "0:yucca" }); wireDial?.(g3);
  terrain.setGrass(ff.composeField({ group: { visible: true }, fields: [g3], mask: null }));
  rep = gApplied?.();
  check("low on an incompatible field: UNAVAILABLE, not success at 0.35",
    rep?.status === "unavailable" && rep.strokes[0]?.drawn === 800,
    JSON.stringify(rep ?? `getGrassDensity()=${terrain.getGrassDensity()} with stroke drawing 800/800`));
  check("getGrassDensity still names the REQUEST — truth lives in the report",
    near(terrain.getGrassDensity(), 0.35));

  // acceptance 5: off and restore where count dialing is unsupported
  terrain.setGrassQuality("off");
  rep = gApplied?.();
  check("off is honestly APPLIED via visibility even without a dial",
    rep?.status === "applied" && rep?.via === "visibility", JSON.stringify(rep));
  terrain.setGrassQuality("low");
  rep = gApplied?.();
  check("restore from off re-evaluates: UNAVAILABLE again, not remembered success",
    rep?.status === "unavailable", JSON.stringify(rep));

  // full asks for every instance — an undialed stroke drawing all of them is truth
  terrain.setGrassQuality("full");
  rep = gApplied?.();
  check("full on an incompatible field is honestly applied (it IS drawing full)",
    rep?.status === "applied", JSON.stringify(rep));
  terrain.setGrassQuality("low");

  // acceptance 6: re-grow preserves the choice, re-evaluates capability
  const g4 = mkStroke(600, { label: "0:grass" }); wireDial?.(g4);
  terrain.setGrass(ff.composeField({ group: { visible: true }, fields: [g4], mask: null }));
  rep = gApplied?.();
  check("re-grow preserves the choice and re-evaluates applied capability",
    rep?.quality === "low" && rep?.status === "applied"
      && g4.mesh.count === densityCount(600, 0.35), JSON.stringify(rep));

  // a field that predates draw-state reporting must fail legibly
  terrain.setGrass(mkField());
  rep = gApplied?.();
  check("a field that cannot report draw state is UNKNOWN, not success",
    rep?.status === "unknown", JSON.stringify(rep));

  terrain.clearGrass();
  rep = gApplied?.();
  check("no field at all says so", rep?.status === "no-field" && rep?.field === false);
}
// The SECOND local dial: does the meadow move? Orthogonal to the cap on
// purpose — density and motion are different costs for different reasons (one
// is "my poor gpu", the other can be "the swaying makes me ill"), so they are
// two dials with three named points between them, not one five-rung ladder.
console.log("\nthe motion dial, and the three names over both dials");
{
  const q = makeGrassQuality(undefined);
  check("motion defaults to on", q.motion === "on" && q.animates() === true);
  check("GRASS_MOTION is the whole vocabulary", JSON.stringify(GRASS_MOTION) === '["on","off"]');

  const s2 = new Map<string, string>();
  const fake = { getItem: (k: string) => s2.get(k) ?? null, setItem: (k: string, v: string) => s2.set(k, v) };
  const q2 = makeGrassQuality(fake);
  q2.setMotion("off");
  check("setMotion persists under its own key", s2.get("ew-grass-motion") === "off");
  check("reload sees it", makeGrassQuality(fake).motion === "off");
  check("unknown motion refused, current stands",
    q2.setMotion("swirly") === "off" && q2.motion === "off");
  s2.set("ew-grass-motion", "sideways");
  check("garbage in the store -> on", makeGrassQuality(fake).motion === "on");

  // nothing drawn cannot be animated — reporting motion 'on' for an invisible
  // meadow is a claim the UI would then have to explain away
  const q3 = makeGrassQuality(undefined);
  q3.setQuality("off");
  check("animates() is false at cap off even with motion on",
    q3.motion === "on" && q3.animates() === false);
  q3.setQuality("full");
  check("...and true again when there is something to move", q3.animates() === true);

  // the two dials are independent: motion survives a cap change and vice versa
  const q4 = makeGrassQuality(undefined);
  q4.setMotion("off"); q4.setQuality("low");
  check("the dials do not overwrite each other",
    q4.motion === "off" && q4.quality === "low" && near(q4.cap, 0.35));

  // #42's three names, as points in the two-dial space
  const q5 = makeGrassQuality(undefined);
  check("full = cap full + motion on",
    JSON.stringify(q5.setPreset("full")) === '{"quality":"full","motion":"on"}' && q5.preset() === "full");
  check("static = cap full + motion OFF, and the meadow is still drawn",
    JSON.stringify(q5.setPreset("static")) === '{"quality":"full","motion":"off"}'
    && q5.preset() === "static" && q5.effective() > 0 && q5.animates() === false);
  q5.setPreset("off");
  check("off = nothing drawn", q5.preset() === "off" && near(q5.effective(), 0));
  q5.setQuality("medium");
  check("a cap between the names has no name, and does not invent one", q5.preset() === null);
  check("an unknown preset changes nothing",
    (q5.setPreset("cinematic"), q5.quality === "medium"));
  // a governor shed reports what the RESIDENT set, not what load did to it
  q5.setPreset("full"); q5.shedTo(0.35);
  check("a governor shed does not rebrand the resident's preset",
    q5.preset() === "full" && near(q5.effective(), 0.35));
}


console.log("\none report for every surface (source-level)");
{
  const bsrc = await Bun.file(here("../client/lib/build.js")).text();
  check("the browser grass⚙ row reads the SAME report (getGrassApplied) as code does",
    /getGrassApplied\(\)/.test(bsrc),
    "build.js renders dial state from policy arithmetic only");
}

console.log("\nnever a verb (source-level)");
{
  const src = await Bun.file(here("../client/lib/terrain.js")).text();
  const gq = await Bun.file(here("../client/lib/grass_quality.js")).text();
  check("terrain.js does not import net.js or send verbs",
    !src.includes("net.js") && !src.includes("sendVerb"));
  check("grass_quality.js is dependency-free",
    !gq.includes("import "));
  // the motion freeze must reach the meadow's OWN hooks and nothing else: the
  // shared per-frame array also carries the sky and every entity emitter
  check("terrain.js freezes motion by IDENTITY, never by emptying the hook array",
    src.includes("releaseHook(") && !/_autoParticleSystems\s*.length\s*=\s*0/.test(src),
    "emptying the shared array would stop the clouds and every emitter too");
  check("the per-tile ticks are NOT frozen (a still meadow must not be a stale one)",
    !src.includes("_tileTick"));
  // Sliced to the handler's OWN body, not a byte window: the next handler in
  // the file is /boom, which sends `force`, and a generous window happily
  // convicted this one of it.
  {
    const hsrc = readFileSync(here("../client/lib/commands/handlers.js"), "utf8");
    const start = hsrc.indexOf("register('foliage'");
    const end = hsrc.indexOf("\nregister(", start + 10);
    const body = start >= 0 ? hsrc.slice(start, end > start ? end : undefined) : "";
    check("the /foliage handler exists", start >= 0);
    check("...and its body sends no verb of any kind",
      !!body && !body.includes("sendVerb") && !body.includes("sendMod") && !body.includes("sendPuppet"),
      body.slice(0, 120));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
