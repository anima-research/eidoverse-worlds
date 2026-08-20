/**
 * Two-bone IK test — geometry only, no rig, no renderer, no server.
 *
 * Run: bun run tools/reach-test.ts
 *
 * Every expectation is HAND-COMPUTED from the law of cosines and written out
 * here, so a wrong solver cannot agree with a wrong test.
 *
 *   Isoceles case, L1 = L2 = 1, target 1.41421356 out:
 *     cos(interior) = (1 + 1 - 2) / (2·1·1) = 0            -> interior = 90°
 *     flex          = 180° - 90°                           -> 90°
 *     cos(alpha)    = (1 + 2 - 1) / (2·1·1.41421356) = 1/sqrt2 -> alpha = 45°
 *     elbow, pole down = [cos45, -sin45, 0] = [0.70710678, -0.70710678, 0]
 *
 *   Elbow at its stop, L1 = L2 = 1, target 0.1 out, maxFlex 145°:
 *     cos(interior) = (2 - 0.01) / 2 = 0.995               -> interior = 5.7320°
 *     flex          = 174.2680° > 145°, so the joint stops at 145°
 *     interior'     = 35°
 *     d'            = sqrt(2 - 2·cos35°) = sqrt(0.36169611) = 0.60141160
 *     gap           = 0.60141160 - 0.1 = 0.50141160
 */

import { solveTwoBone, clampToCone, clampBehind, rotateAbout } from "../shared/reach.js";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const near3 = (a: number[], b: number[], eps = 1e-6) => a.every((v, i) => near(v, b[i], eps));
const D = Math.PI / 180;
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

console.log("\nprimitives");
{
  // rotating +X about +Z by 90° gives +Y
  const r = rotateAbout([1, 0, 0], [0, 0, 1], Math.PI / 2);
  check("rotateAbout: +X about +Z by 90° = +Y", near3(r, [0, 1, 0]), JSON.stringify(r));
}
{
  const inside = clampToCone([1, 0, 0], [1, 0, 0], 85 * D);
  check("a direction inside the cone is untouched", !inside.clamped && near3(inside.v, [1, 0, 0]));
  const outside = clampToCone([-1, 0, 0], [1, 0, 0], 85 * D);
  check("a direction outside is put ON the boundary",
    outside.clamped && near(dot(outside.v, [1, 0, 0]), Math.cos(85 * D)),
    `dot=${dot(outside.v, [1, 0, 0])} want ${Math.cos(85 * D)}`);
  check("the clamped direction is still a unit vector", near(Math.hypot(...outside.v), 1));
}
{
  // antiparallel is the degenerate case: every plane is equally valid, so the
  // requirement is only that it is finite, unit, and on the boundary
  const anti = clampToCone([-1, 0, 0], [1, 0, 0], 30 * D);
  check("antiparallel input does not produce NaN",
    anti.v.every(Number.isFinite) && near(Math.hypot(...anti.v), 1) && near(dot(anti.v, [1, 0, 0]), Math.cos(30 * D)));
}
{
  const b = clampBehind([0, 0, -1], [0, 0, 1], -Math.sin(65 * D));
  check("frontal-plane stop holds the limb at -sin(65°) forward",
    b.clamped && near(dot(b.v, [0, 0, 1]), -Math.sin(65 * D)), `fwd=${dot(b.v, [0, 0, 1])}`);
  check("...and keeps it unit length", near(Math.hypot(...b.v), 1));
}

console.log("\nthe isoceles triangle (hand-computed)");
{
  const r = solveTwoBone({
    root: [0, 0, 0], target: [Math.SQRT2, 0, 0], L1: 1, L2: 1, pole: [0, -1, 0],
  }) as any;
  check("solved", r.ok);
  check("flex = 90°", near(r.flex, 90 * D), `${r.flex / D}°`);
  check("elbow = [0.70710678, -0.70710678, 0]", near3(r.elbow, [Math.SQRT1_2, -Math.SQRT1_2, 0]), JSON.stringify(r.elbow));
  check("hand lands ON the target", r.reached && near(r.gap, 0));
  check("upper bone is exactly L1 long", near(dist([0, 0, 0], r.elbow), 1));
  check("lower bone is exactly L2 long", near(dist(r.elbow, r.hand), 1));
  check("nothing was bound", r.bound.length === 0, JSON.stringify(r.bound));
}
{
  // the pole is what picks the bend plane: flip it, the elbow flips with it
  const up = solveTwoBone({
    root: [0, 0, 0], target: [Math.SQRT2, 0, 0], L1: 1, L2: 1, pole: [0, 1, 0],
  }) as any;
  check("pole up puts the elbow up", near3(up.elbow, [Math.SQRT1_2, Math.SQRT1_2, 0]), JSON.stringify(up.elbow));
}

console.log("\nout of reach");
{
  const r = solveTwoBone({ root: [0, 0, 0], target: [5, 0, 0], L1: 1, L2: 1, pole: [0, -1, 0] }) as any;
  check("reports it did not reach", !r.reached && r.bound.includes("reach"));
  check("arm goes straight at the target", near3(r.upper, [1, 0, 0], 1e-3) && near3(r.lower, [1, 0, 0], 1e-3));
  check("hand stops at full extension, not at the target", near(dist([0, 0, 0], r.hand), 2, 1e-3), `${dist([0, 0, 0], r.hand)}`);
  check("gap is the honest shortfall (5 - 2 = 3)", near(r.gap, 3, 1e-3), `${r.gap}`);
}

console.log("\nthe elbow's stop (hand-computed)");
{
  const r = solveTwoBone({
    root: [0, 0, 0], target: [0.1, 0, 0], L1: 1, L2: 1, pole: [0, -1, 0],
    limits: { maxFlex: 145 * D },
  }) as any;
  check("the hinge is reported as binding", r.bound.includes("hinge"));
  check("flex stops at exactly 145°", near(r.flex, 145 * D), `${r.flex / D}°`);
  check("hand can get no closer than 0.60141160", near(dist([0, 0, 0], r.hand), 0.60141160, 1e-7),
    `${dist([0, 0, 0], r.hand)}`);
  check("gap = 0.50141160", near(r.gap, 0.50141160, 1e-7), `${r.gap}`);
  // THE bug this guards: obeying the elbow limit and then reaching anyway
  check("the forearm is NOT stretched to cheat the limit", near(dist(r.elbow, r.hand), 1, 1e-9),
    `forearm = ${dist(r.elbow, r.hand)}`);
  check("the upper arm is not stretched either", near(dist([0, 0, 0], r.elbow), 1, 1e-9));
}

console.log("\nthe cone and the frontal plane");
{
  // reaching straight backwards, with the cone centred forward-ish along +X
  const r = solveTwoBone({
    root: [0, 0, 0], target: [-2, 0, 0], L1: 1, L2: 1, pole: [0, -1, 0],
    coneAxis: [1, 0, 0], limits: { coneHalf: 85 * D },
  }) as any;
  check("cone reported as binding", r.bound.includes("cone"));
  // The cone constrains the SHOULDER, so it is the upper bone that lands on
  // the boundary — not the hand, which then reaches on from there as far as
  // the elbow allows. (This assertion used to check the hand and was simply
  // wrong about which vector the joint limit owns.)
  check("the UPPER BONE is pulled onto the cone boundary",
    near(dot(r.upper, [1, 0, 0]), Math.cos(85 * D), 1e-6), `dot=${dot(r.upper, [1, 0, 0])}`);
  check("the upper bone stays unit length", near(Math.hypot(...r.upper), 1));
}
{
  const r = solveTwoBone({
    root: [0, 0, 0], target: [0, 0, -2], L1: 1, L2: 1, pole: [0, -1, 0],
    fwd: [0, 0, 1], limits: { behind: 65 * D },
  }) as any;
  check("frontal stop reported as binding", r.bound.includes("behind"));
  const f = dot(r.upper, [0, 0, 1]);
  check("the upper bone sits exactly at the 65° stop", near(f, -Math.sin(65 * D), 1e-6), `fwd=${f}`);
}

{
  // cone AND frontal stop together — one projection each is not enough, which
  // is why the solver alternates them to a fixed point
  const r = solveTwoBone({
    root: [0, 0, 0], target: [-2, 0, -2], L1: 1, L2: 1, pole: [0, -1, 0],
    coneAxis: [1, 0, 0], fwd: [0, 0, 1],
    limits: { coneHalf: 85 * D, behind: 65 * D, maxFlex: 145 * D },
  }) as any;
  check("BOTH are satisfied at once, not just the last one applied",
    dot(r.upper, [1, 0, 0]) >= Math.cos(85 * D) - 1e-6 && dot(r.upper, [0, 0, 1]) >= -Math.sin(65 * D) - 1e-6,
    `cone=${dot(r.upper, [1, 0, 0])} fwd=${dot(r.upper, [0, 0, 1])}`);
  check("and it did not give up as infeasible", !r.bound.includes("infeasible"));
  // Here only the frontal stop is active at the fixed point — the cone fires
  // during alternation and the final arm ends up well inside it (0.42 against
  // a boundary of 0.087). `bound` must say what is true AT THE END.
  check("reports only the limit that is actually active", r.bound.includes("behind") && !r.bound.includes("cone"));
}
{
  // report honesty as a property: over many targets, every limit named in
  // `bound` is genuinely on its boundary, and every limit NOT named is
  // genuinely satisfied with room to spare
  let lies = 0, coneHits = 0, behindHits = 0;
  let seed = 4242;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 5000; i++) {
    const t = [(rnd() - 0.5) * 5, (rnd() - 0.5) * 5, (rnd() - 0.5) * 5];
    const r = solveTwoBone({
      root: [0, 0, 0], target: t, L1: 1, L2: 0.9, pole: [(rnd() - 0.5), -1, (rnd() - 0.5)],
      coneAxis: [1, 0, 0], fwd: [0, 0, 1],
      limits: { coneHalf: 85 * D, behind: 65 * D, maxFlex: 145 * D },
    }) as any;
    if (!r.ok) continue;
    const cd = dot(r.upper, [1, 0, 0]), fd = dot(r.upper, [0, 0, 1]);
    const coneOn = Math.abs(cd - Math.cos(85 * D)) < 1e-6;
    const behindOn = Math.abs(fd - -Math.sin(65 * D)) < 1e-6;
    if (r.bound.includes("cone") !== coneOn) lies++;
    if (r.bound.includes("behind") !== behindOn) lies++;
    if (cd < Math.cos(85 * D) - 1e-6 || fd < -Math.sin(65 * D) - 1e-6) lies++;
    if (coneOn) coneHits++;
    if (behindOn) behindHits++;
  }
  check(`bound[] never lies over 5000 targets (cone active ${coneHits}, behind active ${behindHits})`,
    lies === 0, `${lies} discrepancies`);
  check("...and both limits were exercised", coneHits > 0 && behindHits > 0);
}

console.log("\nrefusals rather than NaN");
{
  const a = solveTwoBone({ root: [0, 0, 0], target: [0, 0, 0], L1: 1, L2: 1, pole: [0, -1, 0] }) as any;
  check("target on the joint is refused, not solved", !a.ok && /on the joint/.test(a.why));
  const b = solveTwoBone({ root: [0, 0, 0], target: [1, 0, 0], L1: 0, L2: 1, pole: [0, -1, 0] }) as any;
  check("a zero-length bone is refused", !b.ok);
  const c = solveTwoBone({ root: [0, 0, 0], target: [1, 0, 0], L1: 1, L2: 1, pole: [1, 0, 0] }) as any;
  check("a pole parallel to the aim still solves (fallback plane)",
    c.ok && c.elbow.every(Number.isFinite));
}

console.log("\nevery result is finite (fuzz)");
{
  let bad = 0, solved = 0;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 20000; i++) {
    const t = [(rnd() - 0.5) * 6, (rnd() - 0.5) * 6, (rnd() - 0.5) * 6];
    const p = [(rnd() - 0.5) * 2, (rnd() - 0.5) * 2, (rnd() - 0.5) * 2];
    const r = solveTwoBone({
      root: [0, 0, 0], target: t, L1: 0.3, L2: 0.28, pole: p,
      fwd: [0, 0, 1], coneAxis: [1, 0, 0],
      limits: { coneHalf: 85 * D, behind: 65 * D, maxFlex: 145 * D },
    }) as any;
    if (!r.ok) continue;
    solved++;
    const okFinite = [...r.upper, ...r.lower, ...r.elbow, ...r.hand, r.gap, r.flex].every(Number.isFinite);
    // the invariant that matters: bones never stretch, whatever the limits did
    const okLen = near(dist([0, 0, 0], r.elbow), 0.3, 1e-6) && near(dist(r.elbow, r.hand), 0.28, 1e-6);
    if (!okFinite || !okLen) bad++;
  }
  check(`20000 random targets: all finite, no bone ever stretched (${solved} solved)`, bad === 0, `${bad} bad`);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : "\n\x1b[32mall passed\x1b[0m\n");
process.exit(failures ? 1 : 0);
