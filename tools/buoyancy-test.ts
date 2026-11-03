// buoyancy + waves — a floating column on the water surface, and the clock the surface runs on.
//   bun tools/buoyancy-test.ts
import { floatStep, footprintSurface, partWaterForce, waterCurrent, swellRise, PART_FLOAT } from "../shared/buoyancy.js";
import { surfaceOffset, waveClock, WAVE_PERIOD, OCEAN, STILL, riverSpeed, cyc } from "../shared/waves.js";
import { SWIM_AT } from "../shared/terrainshape.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const H = 1.74;
const run = (surface: (t: number) => number, seconds: number, dt: number, s0 = { y: -SWIM_AT * H, vy: 0 }) => {
  const s = { ...s0 }, trace: { t: number; y: number; surf: number }[] = [];
  for (let t = 0; t < seconds; t += dt) { floatStep(s, surface(t), H, dt); trace.push({ t, y: s.y, surf: surface(t) }); }
  return trace;
};

console.log("\nfloating");
{
  const tr = run(() => 0, 20, 1 / 60, { y: 0, vy: 0 });     // dropped in with its feet at the surface
  const end = tr.at(-1)!;
  check(`settles with its chest at the surface (feet at −${(SWIM_AT * H).toFixed(2)} m)`, Math.abs(end.y + SWIM_AT * H) < 0.01, `y ${end.y.toFixed(3)}`);
  const dip = Math.min(...tr.map((p) => p.y));
  check("...after one damped bob, not a long ring", dip > -SWIM_AT * H - 0.5 && tr.filter((p) => p.t > 6).every((p) => Math.abs(p.y + SWIM_AT * H) < 0.03), `lowest ${dip.toFixed(2)}`);
}
console.log("\nriding waves");
{
  const response = (A: number, w: number) => {
    const tr = run((t) => A * Math.sin(w * t), 40, 1 / 60).filter((p) => p.t > 20);
    return (Math.max(...tr.map((p) => p.y)) - Math.min(...tr.map((p) => p.y))) / (2 * A);
  };
  const swell = response(0.6, 0.5), steep = response(0.3, 4.5);
  check(`a long swell lifts it nearly all the way (${(swell * 100).toFixed(0)}% of the wave's height)`, swell > 0.85 && swell < 1.3, `${swell}`);
  check(`a short steep wave mostly passes over it (${(steep * 100).toFixed(0)}%) — the water climbs the body`, steep < 0.5, `${steep}`);
  const ocean = response(0.6, OCEAN.w1);
  check(`the sea's own swell (${OCEAN.w1.toFixed(2)} rad/s) lifts it most of the way, with a lag (${(ocean * 100).toFixed(0)}%)`, ocean > 0.5 && ocean < 1.4, `${ocean}`);
  const fast = run((t) => 0.6 * Math.sin(OCEAN.w1 * t), 20, 1 / 60).at(-1)!.y;
  const slow = run((t) => 0.6 * Math.sin(OCEAN.w1 * t), 20, 0.1).at(-1)!.y;
  check("a 10 Hz agent tick bobs where a 60 Hz browser frame does", Math.abs(fast - slow) < 0.03, `${fast.toFixed(3)} vs ${slow.toFixed(3)}`);
}
console.log("\nthe surface and its clock");
{
  check("the wave clock wraps every period", Math.abs(waveClock(WAVE_PERIOD * 1000 + 1500) - 1.5) < 1e-9 && waveClock(-500) > 0);
  const w = { kind: "ocean", depth: 6, toShore: [-1, 0] as [number, number] };
  const before = surfaceOffset(w, 12, 3, WAVE_PERIOD - 1e-6), after = surfaceOffset(w, 12, 3, 0);
  check("…and nothing jumps at the wrap (every frequency is a whole number of cycles a period)", Math.abs(before - after) < 1e-4, `${before} vs ${after}`);
  const amp = Math.max(...Array.from({ length: 200 }, (_, i) => Math.abs(surfaceOffset(w, i * 0.4, 0, 0))));
  check(`offshore the sea stands up to ~0.9 m (${amp.toFixed(2)})`, amp > 0.6 && amp < 1.0);
  const shallow = { ...w, depth: -0.5 };
  const ampS = Math.max(...Array.from({ length: 200 }, (_, i) => Math.abs(surfaceOffset(shallow, i * 0.4, 0, 0))));
  check(`at the shore its swash is smaller (${ampS.toFixed(2)})`, ampS < amp * 0.5);
  check("dry ground has no surface offset", surfaceOffset(null, 1, 2, 3) === 0);
  const wraps = (w: any) => Math.abs(surfaceOffset(w, 7, -3, WAVE_PERIOD - 1e-6) - surfaceOffset(w, 7, -3, 0)) < 1e-5;
  check("…nor a river's (at any speed it is given)", [0.5, 0.93, 1.37, 2.2].every((v) => wraps({ kind: "river", flow: [0.6, 0.8], waveSpeed: riverSpeed(v) })));
  check("…nor still water's", wraps({ kind: "still" }) && wraps({ kind: "ocean", depth: 6, toShore: [0, 1] }));
  // the shader's own terms: the river's 0.6 and 0.4 trains, and the fixed ripple rates
  const whole = (w: number) => Math.abs((w * WAVE_PERIOD) / (2 * Math.PI) - Math.round((w * WAVE_PERIOD) / (2 * Math.PI))) < 1e-6;
  const rk = 1.4 * riverSpeed(1.1);
  check("the drawn river's every train runs whole cycles a period", whole(rk) && whole(0.6 * rk) && whole(0.4 * rk));
  check("…and so do the sheet's ripples", [0.5, 0.4, 0.45, 0.35].every((w) => whole(cyc(w))) && whole(STILL.w));
  const flat = footprintSurface(() => 0.4, 0, 0);
  check("the footprint mean of a flat surface is the surface", Math.abs(flat - 0.4) < 1e-12);
}

console.log("\nfloating parts (the ragdoll's law)");
{
  // one 5 kg part, 0.12 m either side of its centre, integrated as Bullet would with gravity separately
  const sim = (y0: number, vy0: number, seconds: number, surface = 0, current: number[] = [0, 0]) => {
    let y = y0, vy = vy0, x = 0, vx = 0, lowest = y0; const f = [0, 0, 0];
    for (let t = 0; t < seconds; t += 1 / 120) {
      partWaterForce(5, y, 0.12, [vx, vy, 0], surface, current, f);
      vy += (f[1] / 5 - 9.8) / 120; vx += (f[0] / 5) / 120; y += vy / 120; x += vx / 120; lowest = Math.min(lowest, y);
    }
    return { y, x, vx, lowest };
  };
  const rest = sim(0, 0, 20);
  const subAtRest = (0 - (rest.y - 0.12)) / 0.24;
  check(`a part floats with ${(PART_FLOAT * 100).toFixed(0)}% of itself under (${(subAtRest * 100).toFixed(0)}%)`, Math.abs(subAtRest - PART_FLOAT) < 0.02);
  const dunk = sim(1.0, -3.0, 6);
  check(`dropped in at 3 m/s it sinks only ${(-dunk.lowest).toFixed(2)} m before the water stops it`, dunk.lowest > -0.8, `${dunk.lowest}`);
  const drift = sim(0, 0, 10, 0, [0.8, 0]);
  check(`it drifts with the current (${drift.vx.toFixed(2)} m/s in a 0.8 m/s flow)`, drift.vx > 0.7 && drift.vx < 0.85);
  const dry = [0, 0, 0];
  check("a part clear of the water feels nothing", partWaterForce(5, 2, 0.12, [0, 0, 0], 0, [0, 0], dry) === 0 && dry[1] === 0);
  check("a river carries along its flow; the sea in toward shore; a pond not at all",
    waterCurrent({ kind: "river", flow: [1, 0], speed: 1.2 })[0] === 1.2
    && waterCurrent({ kind: "ocean", toShore: [-1, 0], depth: 0.5 })[0] < -0.3
    && waterCurrent({ kind: "still" })[0] === 0);
  const rising = swellRise((t) => Math.sin(t), 0, 0), deepRise = swellRise((t) => Math.sin(t), 0, 5);
  check("the swell's rise is the surface's, fading with depth", Math.abs(rising - 1) < 0.01 && deepRise < rising * 0.5 && deepRise > 0);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : "\n\x1b[32mall passed\x1b[0m");
process.exit(failures ? 1 : 0);
