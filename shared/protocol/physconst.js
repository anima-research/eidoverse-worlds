// physconst — the reach and hand numbers the authority admits by and a client predicts by, one binding for both (debt
// survey 10-12 #8: each side kept its own copy). A client that reads these predicts exactly what the authority will grant.
export const REACH = 1.5;      // m from the hand: arm plus a step (grab, put, drop, throw)
export const BODY_MASS = 70;   // kg: every body's presumptive mass, as REACH is its presumptive reach (R 10-12: one, until bodies are simulated whole)
export const HAND_Y = 1.1;     // where a held thing sits above the feet; reach is measured from there
export const MAX_HELD = 2;     // things in two hands at once
export const KICK = Object.freeze({ reach: 1.6, below: -0.5, above: 2.0, lift: 0.9 });   // a punt, from the feet
// a shove: a punt {shove: true} that a walking body sends when it walks into a loose thing (shared/shove.js). The authority
// admits one only from a body standing against the thing: its feet within `reach` of the thing's oriented box (a body's
// radius at the largest size, plus the track's lag), the thing not beneath the body (`beneath`) nor over the head
// (`above`), lifted at most `lift` × its speed along the ground, pushed away from the feet, at most what a body of BODY_MASS
// running at `walk` m/s passes elastically to the thing's mass, never above `maxV`. `mu`: the slide's friction, for how
// far a shoved thing goes (eidosim's own, shared/sim.js FRICTION).
export const SHOVE = Object.freeze({ reach: 0.9, beneath: 0.1, above: 2.0, maxV: 3, lift: 0.3, walk: 4.0, mu: 0.6 });
// a shove or drag at another body is gated three times, by design (handlers.js: "honesty, not security"): the authority
// admits it within BODY_REACH, a client offers the command within SHOVE_REACH, the server forwards a presence packet within
// BODY_RANGE. Three layers, three numbers, each named here so none is a stray literal.
export const BODY_REACH = REACH + 0.5;
export const SHOVE_REACH = 2.5;
export const BODY_RANGE = Object.freeze({ shove: 3, move: 3, pose: 10 });
export const USE_REACH = 2.5;  // m, feet to a thing the use prompt offers (Roblox's prompt reaches ~10 studs ≈ 2.8 m)
