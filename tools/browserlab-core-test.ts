/**
 * browserlab_core — the arithmetic and the refusals, headless (#42 review).
 *
 *   bun run tools/browserlab-core-test.ts
 *
 * Every function under test decides whether a measurement may be PUBLISHED, so
 * each section carries MUTATIONS: the shapes that must be rejected, beside the
 * shapes that must be accepted. A guard that only ever sees good input is not a
 * guard, and this file exists because three of the harness's published numbers
 * were wrong in ways a happy-path test would have waved through:
 *
 *   · draw counts quoted from `render.calls`, a LIFETIME total, labelled
 *     "per-frame" — 6,186 reported for a scene that draws 92;
 *   · a "static foliage" arm that emptied the whole shared hook array, stopping
 *     the sky and every entity emitter and then charging grass for it;
 *   · a comparability gate that passed two runs of different scenes because
 *     camera, people count and triangle total happened to agree.
 *
 * No servers, no world, no network, no DOM.
 */

import {
  classifyCounter, summarize, throttleVerdict, sceneDigest, fnv1a,
  gateChecks, foliageCost, vsyncFloor,
} from "../client/lib/browserlab_core.js";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};

// ---- 1. which counter is a frame cost --------------------------------------

console.log("\nclassifying a renderer counter");
{
  // the real measurement, from six consecutive frames of the live client
  const drawCalls = [92, 92, 92, 92, 92, 92];
  const triangles = [2456705, 2456705, 2456705, 2456705];
  const lifetime = [1434, 1437, 1440, 1443, 1446];

  const d = classifyCounter(drawCalls);
  check("render.drawCalls reads as per-frame", d.kind === "per-frame" && d.value === 92, JSON.stringify(d));
  const t = classifyCounter(triangles);
  check("render.triangles reads as per-frame", t.kind === "per-frame" && t.value === 2456705, JSON.stringify(t));

  // THE BUG, as data: a lifetime total advancing 3 per frame. The published
  // receipts quoted the last value of this series as a frame cost.
  const l = classifyCounter(lifetime);
  check("render.calls is caught as CUMULATIVE, not a frame cost",
    l.kind === "cumulative" && l.value === 3, JSON.stringify(l));
  check("…and its per-frame meaning is the step, never the running total",
    l.value === 3 && l.value !== lifetime[lifetime.length - 1]);

  // the old heuristic, reconstructed, to show why it could not have caught it
  const oldHeuristic = (s: number[]) => (s[s.length - 1] - s[0]) > s[0] * 0.5;
  check("the old magnitude heuristic calls the lifetime counter per-frame (the defect)",
    oldHeuristic(lifetime) === false,
    "if this ever passes, the old test was fine and something else was wrong");
}

console.log("\nmutations: shapes that must NOT yield a number");
{
  const cases: [string, number[]][] = [
    ["a counter that shrinks", [100, 90, 80]],
    ["a counter that wobbles", [100, 105, 99, 104]],
    ["a counter that jumps unevenly", [0, 5, 500, 505]],
    ["two samples only", [92, 92]],
    ["nothing at all", []],
  ];
  for (const [name, samples] of cases) {
    const r = classifyCounter(samples);
    check(`${name} → unknown, value null`, r.kind === "unknown" && r.value === null, JSON.stringify(r));
  }
  // a steady-but-not-identical per-frame counter is still cumulative-shaped and
  // must be reported as the STEP, not the reading
  const near = classifyCounter([1000, 1004, 1008, 1011]);
  check("a near-steady running total yields its step", near.kind === "cumulative" && near.value === 4, JSON.stringify(near));
  const wild = classifyCounter([1000, 1001, 1400, 1401]);
  check("a wildly uneven one refuses instead", wild.kind === "unknown", JSON.stringify(wild));
}

// ---- 2. renderer or metronome ----------------------------------------------

console.log("\ntelling a renderer from a throttle");
{
  const real = summarize([16.6, 16.7, 16.8, 20.1, 33.4, 16.7, 16.6, 51.0]);
  check("a spread distribution is believed", throttleVerdict(real) === null, JSON.stringify(real));

  // the actual tainted arm from the first Chrome run
  const locked = { p50: 1000.06, p95: 1000.11, p99: 1000.11 };
  const v = throttleVerdict(locked);
  check("the 1000ms cadence lock is caught", !!v && /cadence lock/.test(v), String(v));

  check("a slow-but-varying renderer is NOT called a throttle",
    throttleVerdict({ p50: 250, p95: 400, p99: 900 }) === null);
  check("a fast identical run is not a throttle either (vsync is not a lock)",
    throttleVerdict({ p50: 16.67, p95: 16.67, p99: 16.67 }) === null);
  check("a slow lock just over the threshold is caught",
    !!throttleVerdict({ p50: 201, p95: 201.1, p99: 201.2 }));
}

console.log("\npercentiles over raw deltas");
{
  const s = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 1000]);
  check("p50 is a median, not a mean", s.p50 === 60, String(s.p50));
  // strictly greater: 50,60,70,80,90,1000 clear 40ms; the 40 itself does not
  check("the tail is counted, not smoothed", s.over40ms === 6 && s.over100ms === 1, JSON.stringify(s));
  check("fps comes from p50, so a burst cannot inflate it", s.fpsFromP50 === +(1000 / 60).toFixed(2), String(s.fpsFromP50));
  check("garbage deltas are dropped", summarize([0, -5, NaN, 16.7]).frames === 1);
}

// ---- 3. same scene, or not --------------------------------------------------

console.log("\nthe scene digest: what camera + triangle count cannot see");
{
  const base = {
    worldSeq: 42,
    entities: [
      { id: "a", lib: "tree.glb", pos: [1, 0, 2], yaw: 0.5, scale: 1, visible: true },
      { id: "b", lib: "rock.glb", pos: [3, 0, 4], yaw: 0, scale: 2, visible: true },
    ],
    people: [{ id: "ash", pos: [0, 0, 0], avatar: "claude.vrm" }],
  };
  const d0 = sceneDigest(base);

  const reordered = { ...base, entities: [base.entities[1], base.entities[0]] };
  check("entity order does not change the digest", sceneDigest(reordered)!.hash === d0!.hash);

  const jitter = { ...base, entities: [{ ...base.entities[0], pos: [1.0000001, 0, 2] }, base.entities[1]] };
  check("float noise below a millimetre does not change it", sceneDigest(jitter)!.hash === d0!.hash);

  // the mutations the OLD gate was blind to — same camera, same people count,
  // same triangle total, different world
  const moved = { ...base, entities: [{ ...base.entities[0], pos: [1.5, 0, 2] }, base.entities[1]] };
  check("an entity that MOVED changes it", sceneDigest(moved)!.hash !== d0!.hash);

  const hidden = { ...base, entities: [{ ...base.entities[0], visible: false }, base.entities[1]] };
  check("an entity that was HIDDEN changes it", sceneDigest(hidden)!.hash !== d0!.hash);

  const swapped = { ...base, entities: [{ ...base.entities[0], lib: "bush.glb" }, base.entities[1]] };
  check("a different ASSET at the same transform changes it", sceneDigest(swapped)!.hash !== d0!.hash);

  const walked = { ...base, people: [{ id: "ash", pos: [4, 0, 0], avatar: "claude.vrm" }] };
  check("a body that walked changes it", sceneDigest(walked)!.hash !== d0!.hash);

  const rebodied = { ...base, people: [{ id: "ash", pos: [0, 0, 0], avatar: "aletheia.vrm" }] };
  check("the same person in a different avatar changes it", sceneDigest(rebodied)!.hash !== d0!.hash);

  const advanced = { ...base, worldSeq: 43 };
  check("a world that advanced changes it", sceneDigest(advanced)!.hash !== d0!.hash);

  check("no scene digests to null, rather than to a lie", sceneDigest(null) === null);
  check("the hash is stable across runs", fnv1a("eidoverse") === fnv1a("eidoverse"));
  check("…and distinguishes near-identical input", fnv1a("eidoverse") !== fnv1a("eidoversf"));
}

// ---- 4. the gate ------------------------------------------------------------

const lab = (over: any = {}) => ({
  label: "x", secsPerArm: 25,
  camera: { pos: [0, 2, 0], yaw: 0, pitch: 0.3, fov: 55 },
  env: { drawingBuffer: [1280, 800] },
  scene: { people: 0, triangles: 100, grassDrawn: 500, digest: { hash: "abcd1234", worldSeq: 7 } },
  build: { digest: "deadbeefdeadbeef" },
  arms: [{ arm: "full", p50: 16.67 }, { arm: "off", p50: 16.67 }],
  tainted: null,
  ...over,
});

console.log("\nthe comparability gate");
{
  const ok = gateChecks([lab(), lab()]);
  check("two identical runs are comparable", ok.comparable, JSON.stringify(ok.rows.filter((r) => !r.ok)));

  const mut: [string, any][] = [
    ["a different camera pose", { camera: { pos: [0, 2, 5], yaw: 0, pitch: 0.3, fov: 55 } }],
    ["a different drawing buffer", { env: { drawingBuffer: [1249, 1285] } }],
    ["a different scene digest", { scene: { people: 0, triangles: 100, grassDrawn: 500, digest: { hash: "ffff0000", worldSeq: 7 } } }],
    ["a world that advanced", { scene: { people: 0, triangles: 100, grassDrawn: 500, digest: { hash: "abcd1234", worldSeq: 9 } } }],
    ["a shorter run", { secsPerArm: 10 }],
    ["a different build", { build: { digest: "0000000000000000" } }],
    ["a tainted run", { tainted: "the tab was backgrounded" }],
  ];
  for (const [name, over] of mut) {
    const g = gateChecks([lab(), lab(over)]);
    check(`${name} blocks the comparison`, !g.comparable, JSON.stringify(g.rows.filter((r) => !r.ok).map((r) => r.name)));
  }

  // the specific hole in the old gate: same camera, same people, same triangles
  const sneaky = gateChecks([lab(), lab({
    scene: { people: 0, triangles: 100, grassDrawn: 500, digest: { hash: "0badc0de", worldSeq: 7 } },
  })]);
  check("same camera + people + triangles is NOT enough on its own",
    !sneaky.comparable && sneaky.rows.find((r) => r.name === "scene digest")?.ok === false);

  const missing = gateChecks([lab(), lab({ build: {} })]);
  check("a receipt that cannot name its build is not comparable",
    !missing.comparable && missing.rows.find((r) => r.name === "code under test")?.known === false);
}

// ---- 5. what may be claimed -------------------------------------------------

console.log("\nrefusing to compute what cannot be computed");
{
  const full = { arm: "full", p50: 20, p95: 30 }, off = { arm: "off", p50: 16, p95: 17 };
  const good = foliageCost(full, off, { foliage: "present" });
  check("a clean pair yields a cost", good.ok && good.p50 === 4 && good.p95 === 13, JSON.stringify(good));
  check("a throttled arm refuses", !foliageCost({ ...full, suspect: "cadence lock" }, off, { foliage: "present" }).ok);
  check("an absent meadow refuses", !foliageCost(full, off, { foliage: "absent" }).ok);
  check("a missing arm refuses", !foliageCost(full, null as any, { foliage: "present" }).ok);

  const floor = vsyncFloor([lab(), lab()]);
  check("all-arms-on-the-interval is named a FLOOR", !!floor && floor.hz === 60, JSON.stringify(floor));
  check("a run with real spread is not called a floor",
    vsyncFloor([lab({ arms: [{ arm: "full", p50: 40 }, { arm: "off", p50: 16.67 }] })]) === null);
}

// ---- 6. the shipped harness still says what this file tests ------------------

console.log("\nsource-level: the arm is scoped, the cleanup is guaranteed");
{
  const src = await Bun.file(new URL("../client/lib/browserlab.js", import.meta.url)).text();

  // the static arm must never empty the shared array again
  check("the static arm never empties the shared hook array",
    !/_autoParticleSystems\s*\.length\s*=\s*0/.test(src) && !/autos\.length\s*=\s*0/.test(src),
    "that array's owners include the sky and every entity emitter");
  check("…it releases meadow-owned hooks by identity instead",
    /releaseHook\(\w+(\.\w+)?\)/.test(src) && src.includes("meadowHooks()"));
  // membership is not enough: the engine drains this array IN ORDER, so a
  // restore that appends hands it back rearranged. Raised on the sibling
  // change in #151 and fixed here the same way.
  check("…and puts them back at their original INDICES, not on the end",
    src.includes("live.splice(") && !/autoHooks\(\)\.push\(\.\.\./.test(src),
    "an appending restore reorders the array it claims to have left as found");
  check("…and reports how many foreign hooks it left running",
    src.includes("foreignHooksLeftRunning"));

  // the trouble watcher patches globals; its cleanup must be unconditional
  const runBody = src.slice(src.indexOf("const trouble = watchTrouble();"));
  const fin = runBody.indexOf("} finally {");
  check("trouble.stop() is inside the finally, not after the try",
    fin > 0 && runBody.indexOf("trouble.stop()") > fin,
    "a throw mid-arm would leave console.error/warn patched for the session");
  check("…and stop() is idempotent", src.includes("if (stopped) return collect();"));

  // the counter fix has to be in the shipped file, not only in core
  check("the harness reads render.drawCalls, not render.calls, for a frame cost",
    src.includes("renderer.info.render.drawCalls"));
  check("…and still records the lifetime counter without publishing it",
    src.includes("lifetimeCalls"));

  const seed = await Bun.file(new URL("../tools/browserlab-seed.mjs", import.meta.url)).text();
  check("the seeder has no hardcoded default world",
    !/argv\.world \?\? 'meadow'/.test(seed) && seed.includes("browserlab-$"),
    "a default world name is one typo away from rewriting a local resident world");
  check("…and refuses a named world that already holds anything",
    seed.includes("refusing to seed") && seed.includes("allow-existing"));
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : `\n\x1b[32mall green\x1b[0m\n`);
process.exit(failures ? 1 : 0);
