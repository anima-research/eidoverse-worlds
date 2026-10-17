// platesize — the nameplate's size and fade against WORLD distance (client/lib/platesize.js, the function avatar.js
// calls every frame; this drives that very function, not a copy).
//
//   bun tools/platesize-test.ts
//
// What must hold (owner-approved recipe, 09-30): world-sized up close; the name's capitals held at 0.6° once they'd
// fall under it; growth capped at 3×; full opacity to 20 m, gone by 30 m. HELD (the reveal, k = 1): 0.6° at any range
// (no cap), full to 50 m, gone by 60; the ease between is monotone and hits its ends in REVEAL_EASE_MS. The own-body
// clearance: what counts, the clamp, and that a held plate's depth pull passes the eye. The angle is measured from the MEASURED
// cap height (PLATE_CAP_H) at the size the function returns — the check fails if either drifts from the other.

import * as PS from "../client/lib/platesize.js";
const { plateSize, PLATE_CAP_H, PLATE_W, TEXT_DEG, MAX_GROW } = PS as any;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
// the angle the name's capitals subtend at distance d, at the width the function chose
const capDeg = (d: number) => 2 * Math.atan((PLATE_CAP_H * plateSize(d).lw / PLATE_W) / 2 / d) * 180 / Math.PI;
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * b;

check("cap height is the measured one (30 px at 0.9 m per 512 px, ~0.053 m)", near(PLATE_CAP_H, 0.0527, 0.02), `${PLATE_CAP_H}`);
check("s = 1 at 2 m (world-sized up close)", plateSize(2).s === 1, JSON.stringify(plateSize(2)));
check("lw = 0.9 at 2 m", plateSize(2).lw === 0.9, JSON.stringify(plateSize(2)));
for (const d of [8, 12])
  check(`caps hold ${TEXT_DEG}° (±5%) at ${d} m`, near(capDeg(d), TEXT_DEG, 0.05), `${capDeg(d).toFixed(3)}°, s=${plateSize(d).s.toFixed(3)}`);
check(`s = ${MAX_GROW} at 20 m (capped)`, Math.abs(plateSize(20).s - MAX_GROW) < 1e-9, JSON.stringify(plateSize(20)));
check("past the cap it shrinks with perspective again (angle at 25 m < at 12 m)", capDeg(25) < capDeg(12) * 0.9,
  `${capDeg(25).toFixed(3)}° vs ${capDeg(12).toFixed(3)}°`);
check("size never falls as you walk away (monotone s)", [0, 1, 3, 5, 7, 10, 15, 20, 40].every((d, i, a) => i === 0 || plateSize(d).s >= plateSize(a[i - 1]).s));
check("vis = 1 at 19 m", plateSize(19).vis === 1, JSON.stringify(plateSize(19)));
check("vis = 1 at 20 m (full to 20)", plateSize(20).vis === 1, JSON.stringify(plateSize(20)));
check("vis between 0 and 1 at 25 m (fading)", plateSize(25).vis > 0.3 && plateSize(25).vis < 0.7, JSON.stringify(plateSize(25)));
check("vis = 0 at 30 m", plateSize(30).vis === 0, JSON.stringify(plateSize(30)));
check("vis = 0 at 60 m (stays gone)", plateSize(60).vis === 0, JSON.stringify(plateSize(60)));

// ---- HOLD-TO-REVEAL -------------------------------------------------------------------------------------------
const has = (n: string) => typeof (PS as any)[n] === "function" || typeof (PS as any)[n] === "number";
check("reveal API exists (plateClear, ownClearance, reachAbove, revealRamp, revealEase, REVEAL_EASE_MS)",
  ["plateClear", "ownClearance", "reachAbove", "revealRamp", "revealEase", "REVEAL_EASE_MS"].every(has));
const P = PS as any;
const capDegK = (d: number, k: number) => 2 * Math.atan((PLATE_CAP_H * plateSize(d, k).lw / PLATE_W) / 2 / d) * 180 / Math.PI;
check("k = 0 is exactly the normal plate (2, 12, 25 m)", [2, 12, 25].every((d) => JSON.stringify(plateSize(d, 0)) === JSON.stringify(plateSize(d))));
for (const d of [20, 40, 55])
  check(`held: caps hold ${TEXT_DEG}° (±5%) at ${d} m — no MAX_GROW shrink`, near(capDegK(d, 1), TEXT_DEG, 0.05), `${capDegK(d, 1).toFixed(3)}°`);
check("held: never under world size up close (s = 1 at 2 m)", plateSize(2, 1).s === 1, JSON.stringify(plateSize(2, 1)));
check("held: vis = 1 at 40 m and at 50 m (normal is gone by 30)", plateSize(40, 1).vis === 1 && plateSize(50, 1).vis === 1 && plateSize(40, 0).vis === 0);
check("held: fading at 55 m, gone at 60 m", plateSize(55, 1).vis > 0.3 && plateSize(55, 1).vis < 0.7 && plateSize(60, 1).vis === 0,
  JSON.stringify([plateSize(55, 1), plateSize(60, 1)]));
check("half-held sits between (size and fade at 40 m)", plateSize(40, 0.5).s > plateSize(40, 0).s && plateSize(40, 0.5).s < plateSize(40, 1).s
  && plateSize(40, 0.5).vis > 0 && plateSize(40, 0.5).vis < 1);
// the ramp and the ease
if (has("revealRamp")) {
  const E = P.REVEAL_EASE_MS;
  check("REVEAL_EASE_MS ≈ 120 ms", E >= 80 && E <= 200, `${E}`);
  check("ramp: press from 0 → 0.5 at half the ease, 1 at the end, clamped after", P.revealRamp(true, 0, 0, E / 2) === 0.5
    && P.revealRamp(true, 0, 0, E) === 1 && P.revealRamp(true, 0, 0, E * 5) === 1);
  check("ramp: release from 1 → 0 at the end", P.revealRamp(false, 0, 1, E) === 0 && P.revealRamp(false, 0, 1, E / 4) === 0.75);
  check("ramp: a reversal continues from where it was (0.4 → back down)", Math.abs(P.revealRamp(false, 10, 0.4, 10 + E * 0.1) - 0.3) < 1e-9);
  check("ease: 0→0, ½→½, 1→1, monotone", P.revealEase(0) === 0 && P.revealEase(1) === 1 && Math.abs(P.revealEase(0.5) - 0.5) < 1e-9
    && [0, 0.1, 0.3, 0.6, 0.9, 1].every((r, i, a) => i === 0 || P.revealEase(r) >= P.revealEase(a[i - 1])));
}
// the own-body clearance
if (has("ownClearance")) {
  check("clearance: an unmeasured body still clears a head (≥ 0.3 m)", P.ownClearance(0) >= 0.3 && P.ownClearance(NaN) >= 0.3);
  check("clearance: reach + margin in the middle", P.ownClearance(0.5) > 0.5 && P.ownClearance(0.5) < 0.75, `${P.ownClearance(0.5)}`);
  check("clearance: capped (a 5 m reach does not see through walls)", P.ownClearance(5) <= 1.25, `${P.ownClearance(5)}`);
  // the 'claude'-shaped head: joint 1.37, a crown of tentacles to 2.21 and 0.45 m out; T-pose hands at 1.35, feet at 0
  const pts = [0, 2.21, 0,  0.45, 2.0, 0.1,  -0.3, 1.8, -0.35,  0.8, 1.35, 0,  -0.8, 1.35, 0,  0.1, 0, 0.1];
  const r = P.reachAbove(pts, 1.95);
  const tent = Math.hypot(0.45, 0.05, 0.1), hind = Math.hypot(0.3, 0.15, 0.35);
  check("reachAbove: counts the crown around the plate (the farthest tentacle)", Math.abs(r - Math.max(tent, hind)) < 1e-9, `${r}`);
  check("reachAbove: skips hands and feet well under the plate", r < 0.8, `${r}`);
  check("reachAbove: empty → 0", P.reachAbove([], 1.95) === 0);
}
if (has("plateClear")) {
  check("plateClear: not held = the body's own clearance", P.plateClear(0.6, 10, 0) === 0.6);
  check("plateClear: held pulls past the eye (≥ d) from halfway on", P.plateClear(0.6, 10, 1) >= 10 && P.plateClear(0.6, 10, 0.5) >= 10
    && P.plateClear(0.6, 40, 0.5) >= 40);
  check("plateClear: monotone in k", [0, 0.2, 0.4, 0.6, 1].every((k, i, a) => i === 0 || P.plateClear(0.5, 8, k) >= P.plateClear(0.5, 8, a[i - 1])));
}


// the plate's box (owner, 10-01: "only a whisper of room between the g's and the edge"): the pill is sized from the
// glyphs' measured ink, so the padding is the same above the tallest glyph and below the lowest descender, and a name
// of capitals and a name of descenders get the same height (the font's reference glyphs set it)
if (typeof P.plateBox === "function") {
  const ref = { asc: 31.2, desc: 9.4 };   // ~ 'Hdgjpqy' at 600 40px system-ui, measured
  const g = P.plateBox({ asc: 22, desc: 9.4, width: 210.5 }, ref), H = P.plateBox({ asc: 29.1, desc: 0, width: 140 }, ref);
  const above = (b: any, asc: number) => b.baseline - Math.ceil(asc) - b.top, below = (b: any, desc: number) => b.top + b.pillH - (b.baseline + Math.ceil(desc));
  check("box: 'ggg' and 'HHH' plates are the same height", g.h === H.h && g.pillH === H.pillH, JSON.stringify({ g, H }));
  check(`box: ≥ ${P.PLATE_PAD_Y} px clear above the font's tallest ink and below its lowest descender, the same both ways`,
    above(g, ref.asc) >= P.PLATE_PAD_Y && below(g, ref.desc) >= P.PLATE_PAD_Y && above(g, ref.asc) === below(g, ref.desc), JSON.stringify(g));
  check(`box: ≥ ${P.PLATE_PAD_X} px either side of the name`, g.pillW >= Math.ceil(210.5) + 2 * P.PLATE_PAD_X, JSON.stringify(g));
  check("box: the pill sits inside the canvas with a margin all round", g.top > 0 && g.top + g.pillH < g.h && g.pillW < g.w, JSON.stringify(g));
  const tall = P.plateBox({ asc: 38, desc: 12, width: 100 }, ref);
  check("box: a name whose ink reaches past the font's (Å, emoji) grows its pill rather than touching the edge",
    above(tall, 38) >= P.PLATE_PAD_Y && below(tall, 12) >= P.PLATE_PAD_Y, JSON.stringify(tall));
  check("box: a long name is clamped to the canvas", P.plateBox({ asc: 30, desc: 9, width: 900 }, ref).pillW <= 512 - 2 * P.PLATE_MARGIN);
} else check("plateBox exists", false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
