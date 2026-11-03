// splashes and ripples — when a body in the water rings it and throws it (client/lib/splashlogic.js).
//   bun tools/splash-test.ts
import { makeSplashTracker, SPLASH } from "../client/lib/splashlogic.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
// water everywhere x < 50 with its surface at 0; dry land beyond
const surfaceAt = (x: number) => (x < 50 ? 0 : null);
const run = (frames: (i: number) => any[], n: number, dt = 1 / 60) => {
  const out = { ripples: [] as number[][], splashes: [] as number[][] };
  const T = makeSplashTracker(surfaceAt, {
    ripple: (x: number, z: number, s: number) => out.ripples.push([x, z, s]),
    splash: (x: number, y: number, z: number, p: number, vx: number, vz: number) => out.splashes.push([x, y, z, p, vx, vz]),
  });
  for (let i = 0; i < n; i++) T.update(frames(i), dt);
  return { ...out, T };
};
const body = (key: string, root: number[], parts: Record<string, number[]> = {}, swimming = false) => ({ key, root, height: 1.7, parts, swimming });

console.log("\na body falling in");
{
  // hips dropping from 1 m above the water at 6 m/s, straight down
  const r = run((i) => [body("a", [0, 1 - i * 0.1 - 0.9, 0], { hips: [0, 1 - i * 0.1, 0] })], 20);
  check("it splashes once as the hips go through", r.splashes.length === 1, `${r.splashes.length}`);
  check(`...hard, for a 6 m/s fall (power ${r.splashes[0]?.[3]?.toFixed(2)})`, r.splashes[0]?.[3] > 0.6);
  check("...at the surface where it went in", Math.abs(r.splashes[0]?.[1]) < 1e-9 && r.splashes[0]?.[0] === 0);
  check("...and rings the water there", r.ripples.some(([x, z, s]) => x === 0 && z === 0 && s > 0.8));
}
{
  // the same hips lowered slowly (wading in, sitting down): a ring, no splash
  const r = run((i) => [body("a", [0, -0.9, 0], { hips: [0, 0.3 - i * 0.01, 0] })], 60);
  check("lowered slowly: rings the water, throws none", r.splashes.length === 0 && r.ripples.length >= 1, `${r.splashes.length} splashes`);
}
{
  // a hand stroking down through the surface at 2.5 m/s, every 0.8 s
  const hand = (i: number) => { const ph = (i % 48) / 48; return [0, ph < 0.5 ? 0.3 - ph * 2.4 : -0.9 + (ph - 0.5) * 2.4, 0]; };
  const r = run((i) => [body("a", [0, -1.3, 0], { rightHand: hand(i) }, true)], 48 * 5);
  check(`a swimmer's stroke throws a little water each time (${r.splashes.length} in 5 strokes)`, r.splashes.length >= 4 && r.splashes.length <= 5
    && r.splashes.every((s) => s[3] < 0.4), JSON.stringify(r.splashes.map((s) => +s[3].toFixed(2))));
}
{
  // a body that loads 3 m up and snaps to where it stands in the water, in one frame
  const r = run((i) => [body("t", i < 10 ? [0, 3, 0] : [0, -0.9, 0], { hips: i < 10 ? [0, 3.9, 0] : [0, 0, 0], leftFoot: i < 10 ? [0, 3, 0] : [0, -0.9, 0] })], 30);
  check("a body snapping into the water (a load, a teleport) throws none", r.splashes.length === 0 && r.ripples.length === 0, `${r.splashes.length} splashes, ${r.ripples.length} rings`);
}
{
  const r = run((i) => [body("d", [0, -3, 0], { hips: [0, -2 - i * 0.1, 0] })], 30);
  check("a diver deep under the surface troubles nothing up top", r.splashes.length === 0 && r.ripples.length === 0);
}
{
  const r = run((i) => [body("l", [60, 1 - i * 0.1, 0], { hips: [60, 1.9 - i * 0.1, 0] })], 30);
  check("a body falling on dry land: nothing", r.splashes.length === 0 && r.ripples.length === 0);
}

console.log("\nmoving through the water");
{
  // a swimmer at 1.2 m/s for 5 s
  const r = run((i) => [body("s", [i * 0.02, -1.3, 0], {}, true)], 300);
  const xs = r.ripples.map((p) => p[0]);
  check(`a swimmer leaves a wake behind it (${r.ripples.length} rings over 6 m)`, r.ripples.length >= 10 && r.ripples.length <= 16);
  check("...along the way it went", xs.every((x, i) => i === 0 || x > xs[i - 1]));
  const fast = run((i) => [body("s", [i * 0.05, -1.3, 0], {}, true)], 300);
  check("...stronger when it goes faster", Math.min(...fast.ripples.map((p) => p[2])) > Math.max(...r.ripples.map((p) => p[2])) - 1e-9);
}
{
  // a wader walking at 1.5 m/s, knee-deep, feet in the water
  const r = run((i) => { const x = i * 0.025; return [body("w", [x, -0.5, 0], { leftFoot: [x, -0.45, 0.1], rightFoot: [x, -0.45, -0.1] })]; }, 240);
  check("a wader sheds rings at its legs", r.ripples.length >= 8 && r.ripples.some((p) => p[1] === 0.1) && r.ripples.some((p) => p[1] === -0.1));
}
{
  // the same wader running at 5 m/s: the distance comes round every 0.09 s, but WAKE_MIN_GAP still holds
  const at: number[] = [];
  let t = 0;
  const T = makeSplashTracker(surfaceAt, { ripple: () => at.push(t), splash: () => {} });
  for (let i = 0; i < 120; i++) { t = i / 60; const x = (i * 5) / 60; T.update([body("r", [x, -0.5, 0], { leftFoot: [x, -0.45, 0.1] })], 1 / 60); }
  const gap = Math.min(...at.slice(1).map((v, i) => v - at[i]));
  check(`...never closer together than ${SPLASH.WAKE_MIN_GAP} s, even running (${gap.toFixed(3)} s apart at the closest)`, at.length >= 8 && gap >= SPLASH.WAKE_MIN_GAP - 1e-9);
}
{
  const r = run(() => [body("i", [0, -1, 0])], 60 * 10);
  const n = r.ripples.length;
  check(`a body standing in the water rings it faintly now and then (${n} in 10 s)`, n >= 3 && n <= 9 && r.ripples.every((p) => p[2] < 0.25));
}
{
  const r = run((i) => [body("x", [i * 0.03, 0.5, 0])], 300);
  check("a body walking beside the water (feet above it) leaves no wake", r.ripples.length === 0);
}
{
  const r = run((i) => (i < 30 ? [body("g", [0, -1, 0])] : []), 60);
  check("a body that leaves is forgotten", r.T.size === 0);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : "\n\x1b[32mall passed\x1b[0m");
process.exit(failures ? 1 : 0);
