// launchplan — the one place a release's velocity is shaped (PHYSICS §4.2): the authority's launch() and a client that
// predicts its own throw (client/lib/thingphysics.js planRelease) call the same function, so the guess and the entry are
// bit-equal by construction (second review 10-11 S3: the client had its own copy of this arithmetic).
//   v: [x, y, z] m/s as sent; g: the grabbable record (its `throw` multiplier, 1 = none); maxSpeed: the engine's cap;
//   verb: "throw" | "drop" | "punt" (the multiplier applies to a throw only).
// Returns {v, notes}: the velocity the launch carries and, for the authority's reply, what was changed and why.
export function planVelocity(v, g, maxSpeed, verb) {
  const notes = []; let out = v;
  if (g && typeof g.throw === "number" && g.throw !== 1 && verb === "throw") { out = out.map((n) => n * g.throw); notes.push({ field: "v", sent: v, kept: out.map(r3), why: `×${g.throw} (its grabbable.throw)` }); }
  const sp = Math.hypot(...out);
  if (Number.isFinite(maxSpeed) && sp > maxSpeed) { const was = out; out = out.map((n) => n * maxSpeed / sp); notes.push({ field: "v", sent: was, kept: out.map(r3), why: `capped at ${maxSpeed} m/s` }); }
  return { v: out, notes };
}
const r3 = (n) => Math.round(n * 1000) / 1000;
