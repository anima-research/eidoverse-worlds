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
// Negative control: this suite FAILS on current main — grass_quality.js does
// not exist there, terrain.js exports no quality surface, and main's inline
// density dial keeps ≥1 instance per stroke at factor 0 (the densityCount
// zero assertion is the behavioral delta, not just a missing module).

import { plugin } from "bun";
const here = (f: string) => new URL(f, import.meta.url).pathname;
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

const { makeGrassQuality, densityCount, GRASS_QUALITY, QUALITY_DENSITY } =
  await import("../client/lib/grass_quality.js");
const terrain = await import("../client/lib/terrain.js");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

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

console.log("\nnever a verb (source-level)");
{
  const src = await Bun.file(here("../client/lib/terrain.js")).text();
  const gq = await Bun.file(here("../client/lib/grass_quality.js")).text();
  check("terrain.js does not import net.js or send verbs",
    !src.includes("net.js") && !src.includes("sendVerb"));
  check("grass_quality.js is dependency-free",
    !gq.includes("import "));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
