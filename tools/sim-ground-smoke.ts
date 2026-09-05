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
//   3. at rest the cluster stands ON its ground (within 5mm);
//   4. after a RELOAD — the body already resting in the join snapshot, seen
//      by the applier before its model has loaded — a far-offset model still
//      does not tumble, and its rendered mesh never goes below ground. The
//      arm gate once cached "origin-centred" from a not-yet-fitted collider
//      and the barrels swung on a 1.3m arm through the hillside on every
//      punt after a reload (§24t-7). This is the case the spawn-then-punt
//      flights above cannot see.
//
// The terrain is commons's own (seed 7, amplitude 6) and the launch is the
// spot where tel0s watched it happen. Presentation-only checks — the sim's
// numbers are sim-smoke's business.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SIM_ID } from "../shared/sim.js";
import { terrainParams, makeHeightField } from "../shared/terrainmath.js";
import { scratchBench, mkCheck, bold, dim, sleep, ROOT } from "./harness.ts";

const HEADED = process.argv.includes("--headed");
const TERRAIN = { seed: 7, size: 160, segments: 200, amplitude: 6, flatRadius: 16, layers: [{ color: "#4a5d33", repeat: 16 }] };
const hf = makeHeightField(terrainParams(TERRAIN));
const MODEL = "eidoverse/assets/models/scifi_barrels_group_of_four.glb";
const OFF = [-0.001, -1.953];                    // the visible cluster, model-local (yaw 0)
// THE ASSET THIS GATE WAS MEASURED AGAINST. OFF and the corner allowances are
// facts about one GLB's geometry; a different file under the same name would
// pass or fail for the wrong reasons (PR #160 review, B6). Bound by hash.
const MODEL_SHA256 = "26a0f4ccf4b225a493087552c8459e1078cb7056e421c542e1b6c87009f898ae";
{
  const dir = process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video");
  const file = join(dir, MODEL);
  if (!existsSync(file)) { console.error(`✗ ${file} missing — this gate needs the asset library`); process.exit(2); }
  const sha = createHash("sha256").update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex");
  if (sha !== MODEL_SHA256) {
    console.error(`✗ ${MODEL} is ${sha.slice(0, 16)}…, not the ${MODEL_SHA256.slice(0, 16)}… this gate's offsets were measured on — re-measure OFF/SPAWN (summarizeGlb) before trusting a verdict`);
    process.exit(2);
  }
}
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

// per frame: [shown x, y, z, sim resting?, q]. Samples UNTIL the sim has the
// body resting again (plus a beat), bounded at 8s — a frame count is a
// function of the machine's frame rate, and a slow headless Chrome sampled
// too few frames of a one-second flight to satisfy any fixed minimum
// (PR #160 review, B6: false negatives with zero undercuts).
const sample = (_frames: number) => evalJson(`new Promise((done) => { try {
  const out = []; const t0 = performance.now(); let flew = false, restedAt = 0;
  const step = () => {
    const o = EW.entities.get('bar'); const b = EW.simFold().bodies.bar;
    if (o) out.push([o.position.x, o.position.y, o.position.z, b ? (b.resting ? 1 : 0) : -1, o.quaternion.toArray()]);
    if (b && !b.resting) flew = true;
    if (flew && b && b.resting && !restedAt) restedAt = performance.now();
    const t = performance.now() - t0;
    if ((restedAt && t - (restedAt - t0) > 400) || t > 8000) done(out); else requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
} catch (e) { done({ err: String(e) }) } })`);

/** v rotated by unit quaternion q — the visual center sits at origin + rot(q, OFF)
 *  now that the applier composes about the center (slope tilt, §24t-10). */
function rot(q: number[], v: number[]): number[] {
  const [x, y, z, w] = q; const [vx, vy, vz] = v;
  const cx = y * vz - z * vy, cy = z * vx - x * vz, cz = x * vy - y * vx;          // q_v × v
  const ccx = y * cz - z * cy, ccy = z * cx - x * cz, ccz = x * cy - y * cx;       // q_v × (q_v × v)
  return [vx + 2 * w * cx + 2 * ccx, vy + 2 * w * cy + 2 * ccy, vz + 2 * w * cz + 2 * ccz];
}
const clusterOf = (r: any) => { const o = rot(r[4] ?? [0, 0, 0, 1], [OFF[0], 0, OFF[1]]); return [r[0] + o[0], r[1] + o[1], r[2] + o[2]]; };

function judge(label: string, rows: any) {
  const frames: number[][] = Array.isArray(rows) ? rows : [];
  let originBelow = 0, clusterBelow = 0, worstO = 0, worstC = 0, inFlight = 0;
  for (const r of frames) {
    if (r[3] !== 0) continue;                      // frames where the sim has it moving
    inFlight++;
    const dO = r[1] - hf(r[0], r[2]);
    const c = clusterOf(r);
    const dC = c[1] - hf(c[0], c[2]);
    if (dO < -0.005) originBelow++;
    if (dC < -0.01) clusterBelow++;
    worstO = Math.min(worstO, dO); worstC = Math.min(worstC, dC);
  }
  check(`${label}: the rendered origin never undercuts the terrain law`,
    inFlight >= 8 && originBelow === 0,
    rows?.err ?? `${inFlight} in-flight frames, ${originBelow} below, worst ${worstO.toFixed(4)}m`);
  check(`${label}: the visible cluster never sinks into ITS ground`,
    inFlight >= 8 && clusterBelow === 0,
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
// the client's applier reaches rest too — and its slerp toward the settled
// orientation converges at 6/s in FRAME time: wait for the quaternion to
// stop moving (≤0.05° over 200ms) rather than assume a fixed delay
const settledShown = async () => {
  let last: any = null;
  for (let i = 0; i < 25; i++) {
    const cur = await evalJson(`(() => { const o = EW.entities.get('bar'); return o ? [o.position.x, o.position.y, o.position.z, 1, o.quaternion.toArray()] : null })()`);
    if (last && cur) {
      const [a, b] = [last[4], cur[4]]; const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
      if (2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI < 0.05 && Math.abs(cur[1] - last[1]) < 1e-4) return cur;
    }
    last = cur; await sleep(200);
  }
  return last;
};
{
  const shown = await settledShown();
  const cc = shown ? clusterOf(shown) : null;
  const dC = cc ? cc[1] - hf(cc[0], cc[2]) : NaN;
  check("at rest the cluster stands ON its ground (±5mm)", Number.isFinite(dC) && Math.abs(dC) < 0.005,
    shown ? `cluster ${dC >= 0 ? "+" : ""}${dC.toFixed(4)}m over its ground; origin y=${shown[1].toFixed(4)} vs sim ${sb?.p?.[1]?.toFixed(4)} (terrain under origin ${hf(shown[0], shown[2]).toFixed(4)})` : "no entity");
}

// ---- flight 3: after a reload, the body rides in the join snapshot ----------
console.log(`\n${bold("── flight 3: after a reload (body resting in the join snapshot)")}`);
bootReady = "";
await cdp.send("Page.navigate", { url: `${BASE}/?name=groundbot2&world=${WORLD}` });
for (let i = 0; i < 240 && !bootReady; i++) await sleep(250);
if (!bootReady) await die(2, "✗ client never re-booted");
await sleep(4000);   // model + collider land; the applier has been running since hydrate
// rendered-mesh sampler: lowest world point of any mesh (as-rendered
// matrixWorld) and the object's tilt from upright, per frame
const sampleMesh = (frames: number) => evalJson(`new Promise((done) => { try {
  const o = EW.entities.get('bar'); const T = EW.THREE; const v = new T.Vector3(); const up = new T.Vector3(0, 1, 0); const u = new T.Vector3();
  const out = []; const t0 = performance.now(); let flew = false, restedAt = 0;
  const step = () => { const b = EW.simFold().bodies.bar; let m = Infinity;
    o.traverse((nd) => { if (!nd.isMesh || !nd.geometry) return; if (!nd.geometry.boundingBox) nd.geometry.computeBoundingBox(); const bb = nd.geometry.boundingBox;
      for (let i = 0; i < 8; i++) { v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(nd.matrixWorld); if (v.y < m) m = v.y; } });
    const tilt = Math.acos(Math.min(1, Math.max(-1, u.copy(up).applyQuaternion(o.quaternion).dot(up)))) * 180 / Math.PI;
    out.push([o.position.x, o.position.z, m, tilt, b ? (b.resting ? 1 : 0) : -1, b ? b.v[1] : null, o.quaternion.toArray()]);
    if (b && !b.resting) flew = true;
    if (flew && b && b.resting && !restedAt) restedAt = performance.now();
    const t = performance.now() - t0;
    if ((restedAt && t - (restedAt - t0) > 400) || t > 8000) done(out); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
} catch (e) { done({ err: String(e) }) } })`);
pose([sb.p[0] + 1, 0, sb.p[2] + 1]);
await sleep(300);
const mp = sampleMesh(150);
await verb("punt", { id: "bar", power: 4, dir: DIR });
{
  const rows: any = await mp;
  const frames: number[][] = Array.isArray(rows) ? rows : [];
  let inFlight = 0, airborne = 0, maxTilt = 0, worstMesh = 0;
  for (const r of frames) {
    if (r[4] !== 0) continue;
    inFlight++;
    // tumble is judged AIRBORNE only (v[1] ≠ 0): a grounded body may lean
    // onto the slope by design (§24t-10), a flying one must stay upright
    if (r[5] !== 0) { airborne++; maxTilt = Math.max(maxTilt, r[3]); }
    // the mesh footprint is ~1.2m: allow the slope across it, judge against the ground under the cluster center
    const o = rot(r[6] as unknown as number[], [OFF[0], 0, OFF[1]]);
    const gc = hf(r[0] + o[0], r[1] + o[2]);
    worstMesh = Math.min(worstMesh, r[2] - gc);
  }
  check("flight 3: a far-offset model does NOT tumble after a reload (arm fitted once the box exists)",
    inFlight >= 8 && airborne >= 4 && maxTilt < 20,   // a tumble on a 1.3m arm is 90° in a blink; the un-tilt off a slope is a few degrees
    rows?.err ?? `${airborne} airborne frames, max tilt from upright ${maxTilt.toFixed(1)}°`);
  check("flight 3: the rendered mesh never swings below its ground",
    inFlight >= 8 && worstMesh > -0.15,
    rows?.err ?? `lowest mesh point vs ground under the cluster: ${worstMesh.toFixed(3)}m (footprint slope allowance 0.15)`);
  // SLOPE TILT at rest (§24t-10): the thing lies on the hill it rests on —
  // its up vector within 3° of the terrain normal under its visual center
  // judge the lean once the applier's slerp has converged, not at the last
  // sampled frame (a slow machine sampled it mid-lean: 3.3° — PR #160 B6)
  const settled = await settledShown();
  const last = settled ? [settled[0], settled[2], 0, 0, 1, 0, settled[4]] : (frames.length ? frames[frames.length - 1] : null);
  if (last) {
    const [qx, qy, qz, qw] = last[6] as unknown as number[];
    const upv = [2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qw * qx + qy * qz)];   // (0,1,0) rotated by q
    const oc = rot(last[6] as unknown as number[], [OFF[0], 0, OFF[1]]);
    const x = last[0] + oc[0], z = last[1] + oc[2], e = 0.5;
    const n = [-(hf(x + e, z) - hf(x - e, z)) / (2 * e), 1, -(hf(x, z + e) - hf(x, z - e)) / (2 * e)];
    const nl = Math.hypot(n[0], n[1], n[2]); n[0] /= nl; n[1] /= nl; n[2] /= nl;
    const ang = Math.acos(Math.min(1, Math.max(-1, upv[0] * n[0] + upv[1] * n[1] + upv[2] * n[2]))) * 180 / Math.PI;
    const slope = Math.acos(Math.min(1, n[1])) * 180 / Math.PI;
    check("at rest on a slope the model LEANS onto the terrain normal under its center (≤3°)",
      last[4] === 1 && ang <= 3,
      `up vs normal ${ang.toFixed(1)}° (the slope there is ${slope.toFixed(1)}°; resting ${last[4] === 1})`);
  }
}

console.log(`\n${bold(tally.failed ? "RED" : "GREEN")} — ${tally.passed} passed, ${tally.failed} failed\n`);
await cleanup();
process.exit(tally.failed ? 1 : 0);
