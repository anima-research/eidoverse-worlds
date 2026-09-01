// sim-ground-smoke — the sim's presentation on HILLS, proven in a browser.
//
//   bun tools/sim-ground-smoke.ts             # headless Chrome, own scratch sequencer
//   bun tools/sim-ground-smoke.ts --headed
//
// sim-smoke proves the three-way bit identity of a flight on a FLAT world;
// this smoke covers what only a slope can show, sampling the realized
// entity every animation frame through two flights (one from the fold's
// word, one from a resting sim body — the live case):
//
//   1. the rendered ORIGIN never dips below the terrain law (interpolation
//      between tick poses never undercuts the ground, §24t-5);
//   2. a FAR-OFFSET model's visible cluster never sinks into its own ground —
//      the barrels group ships its mesh 1.95m from the origin, and the sim
//      grounds the origin, so on a slope the mesh sank 29cm at every landing
//      until the applier's visual grounding (§24t-6);
//   3. at rest the cluster stands ON its ground (within 5mm).
//
// The terrain is commons's own (seed 7, amplitude 6) and the launch is the
// spot where tel0s watched it happen. Presentation-only checks — the sim's
// numbers are sim-smoke's business.

import { SIM_ID } from "../shared/sim.js";
import { terrainParams, makeHeightField } from "../shared/terrainmath.js";
import { scratchBench, mkCheck, bold, dim, sleep } from "./harness.ts";

const HEADED = process.argv.includes("--headed");
const TERRAIN = { seed: 7, size: 160, segments: 200, amplitude: 6, flatRadius: 16, layers: [{ color: "#4a5d33", repeat: 16 }] };
const hf = makeHeightField(terrainParams(TERRAIN));
const MODEL = "eidoverse/assets/models/scifi_barrels_group_of_four.glb";
const OFF = [-0.001, -1.953];                    // the visible cluster, model-local (yaw 0)
const SPAWN = [-10.4749, -0.5047, 30.7654];      // commons seq 108's launch: cluster buried 0.28 there
const DIR = [-0.5934150204746177, 0.9, -0.8048966476977706];

console.log(`\n${bold("sim-ground-smoke")} — ${SIM_ID} on hills`);
const { PORT, BASE, cws, cdp, evalJson, cleanup, die } =
  await scratchBench("simground", { headed: HEADED, portFrom: 8970 });
const { check, tally } = mkCheck();

const WORLD = `simground-${Math.random().toString(36).slice(2, 7)}`;
const msgs: any[] = [];
const dws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
dws.onmessage = (ev) => { msgs.push(JSON.parse(String(ev.data))); };
await new Promise((r, j) => { dws.onopen = r as any; dws.onerror = j as any; });
dws.send(JSON.stringify({ type: "join", world: WORLD, id: "grounddriver", token: "" }));
await sleep(600);
const pose = (p: number[]) => dws.send(JSON.stringify({ type: "pose", pose: { p } }));
const verb = async (v: string, a: unknown) => { dws.send(JSON.stringify({ type: "verb", verb: v, args: a })); await sleep(350); };
await verb("terrain", TERRAIN);
await verb("epoch", { sim: SIM_ID, tickMs: 66 });
await verb("spawn", { id: "bar", lib: MODEL, pos: SPAWN, yaw: 0 });

let bootReady = "";
cws.addEventListener("message", (ev: any) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === "Runtime.consoleAPICalled") {
    const line = (m.params.args ?? []).map((a: any) => a?.value !== undefined ? String(a.value) : a?.description ?? "").join(" ");
    if (line.startsWith("[boot] ready")) bootReady = line;
  }
});
await cdp.send("Page.navigate", { url: `${BASE}/?name=groundbot&world=${WORLD}` });
for (let i = 0; i < 240 && !bootReady; i++) await sleep(250);
if (!bootReady) await die(2, "✗ client never booted");
await sleep(2500);   // the terrain lands, the model realizes

const serverBody = async () => {
  dws.send(JSON.stringify({ type: "debug", sim: true, reqId: `q${Math.random()}` }));
  await sleep(250);
  return msgs.filter((x) => x.type === "debug" && x.sim).pop()?.sim?.bodies?.bar ?? null;
};

// per frame: [shown x, y, z, sim resting?]
const sample = (frames: number) => evalJson(`new Promise((done) => { try {
  const out = []; let n = 0;
  const step = () => {
    const o = EW.entities.get('bar'); const b = EW.simFold().bodies.bar;
    if (o) out.push([o.position.x, o.position.y, o.position.z, b ? (b.resting ? 1 : 0) : -1]);
    if (++n < ${frames}) requestAnimationFrame(step); else done(out);
  };
  requestAnimationFrame(step);
} catch (e) { done({ err: String(e) }) } })`);

function judge(label: string, rows: any) {
  const frames: number[][] = Array.isArray(rows) ? rows : [];
  let originBelow = 0, clusterBelow = 0, worstO = 0, worstC = 0, inFlight = 0;
  for (const r of frames) {
    if (r[3] !== 0) continue;                      // frames where the sim has it moving
    inFlight++;
    const dO = r[1] - hf(r[0], r[2]);
    const dC = r[1] - hf(r[0] + OFF[0], r[2] + OFF[1]);
    if (dO < -0.005) originBelow++;
    if (dC < -0.01) clusterBelow++;
    worstO = Math.min(worstO, dO); worstC = Math.min(worstC, dC);
  }
  check(`${label}: the rendered origin never undercuts the terrain law`,
    inFlight >= 20 && originBelow === 0,
    rows?.err ?? `${inFlight} in-flight frames, ${originBelow} below, worst ${worstO.toFixed(4)}m`);
  check(`${label}: the visible cluster never sinks into ITS ground`,
    inFlight >= 20 && clusterBelow === 0,
    rows?.err ?? `${clusterBelow} below, worst ${worstC.toFixed(4)}m`);
}

console.log(`\n${bold("── flight 1: from the fold's word")}  ${dim(`world ${WORLD}`)}`);
pose([SPAWN[0] + 1, 0, SPAWN[2] + 1]);
await sleep(200);
let fp = sample(150);
await verb("punt", { id: "bar", power: 4, dir: DIR });
judge("flight 1", await fp);
let sb: any = null;
for (let i = 0; i < 30 && !sb?.resting; i++) { await sleep(400); sb = await serverBody(); }
if (!sb?.resting) await die(1, "✗ the sequencer never brought the barrels to rest");

console.log(`\n${bold("── flight 2: from a resting sim body")}`);
pose([sb.p[0] + 1, 0, sb.p[2] + 1]);
await sleep(300);
fp = sample(150);
await verb("punt", { id: "bar", power: 4, dir: DIR });
judge("flight 2", await fp);
sb = null;
for (let i = 0; i < 30 && !sb?.resting; i++) { await sleep(400); sb = await serverBody(); }
await sleep(600);   // the client's applier reaches rest too
{
  const shown = await evalJson(`(() => { const o = EW.entities.get('bar'); return o ? [o.position.x, o.position.y, o.position.z] : null })()`);
  const dC = shown ? shown[1] - hf(shown[0] + OFF[0], shown[2] + OFF[1]) : NaN;
  check("at rest the cluster stands ON its ground (±5mm)", Number.isFinite(dC) && Math.abs(dC) < 0.005,
    shown ? `cluster ${dC >= 0 ? "+" : ""}${dC.toFixed(4)}m over its ground; origin y=${shown[1].toFixed(4)} vs sim ${sb?.p?.[1]?.toFixed(4)} (terrain under origin ${hf(shown[0], shown[2]).toFixed(4)})` : "no entity");
}

console.log(`\n${bold(tally.failed ? "RED" : "GREEN")} — ${tally.passed} passed, ${tally.failed} failed\n`);
await cleanup();
process.exit(tally.failed ? 1 : 0);
