// physconst — the reach and hand numbers the authority admits by and a client predicts by, one binding for both, so a
// client that reads these predicts exactly what the authority will grant.
export const REACH = 1.5;      // m from the hand: arm plus a step (grab, put, drop, throw)
export const BODY_MASS = 70;   // kg: every body's presumptive mass, as REACH is its presumptive reach (one, until bodies are simulated whole)
export const HAND_Y = 1.1;     // where a held thing sits above the feet; reach is measured from there
export const KILL_MARGIN = 50;   // m below @world.bounds.min.y where KillZ sends a body back (Unreal KillZ / Roblox FallenPartsDestroyHeight sit well below play); a world setting later
export const MAX_HELD = 2;     // things in two hands at once
export const KICK = Object.freeze({ reach: 2.5, below: -0.5, above: 2.0, lift: 0.9 });   // a punt, from the body's origin
// a contact push (shared/shove.js): a punt {contact: true} from a body moving into a loose thing. Admitted only with
// the feet within `reach` (largest body radius + track lag) of the thing's oriented box, the thing not `beneath` nor
// `above` the body, lifted ≤ `lift` × ground speed, away from the feet, and at most what BODY_MASS running at `run` m/s
// passes elastically, never above `maxV`.
// `mu`: the slide's friction (shared/sim.js FRICTION).
export const SHOVE = Object.freeze({ reach: 0.9, beneath: 0.1, above: 2.0, maxV: 3, lift: 0.3, run: 4.0, mu: 0.6 });
// a shove or drag at another body: the authority admits it within BODY_REACH; a client offers it within SHOVE_REACH.
// The server forwards a presence act on another body within BODY_RANGE (null = any distance; consent still decides),
// or the world's @world.body-default.range (m).
export const BODY_REACH = REACH + 0.5;
export const SHOVE_REACH = 2.5;
export const BODY_RANGE = null;
/** a world's @world.body-default value → the range (m) the server forwards a presence act on another body within, or null */
export const bodyRangeOf = (bd) => (bd && typeof bd === "object" && typeof bd.range === "number" && bd.range > 0 ? bd.range : BODY_RANGE);
/** the range in words, for help text: the one place it is said */
export const bodyRangeWords = (r = BODY_RANGE) => (r == null ? "from any distance unless the world sets a range (@world.body-default.range)" : `within ${r} m`);
// a blast (force {at, radius, power}): radius m and power m/s at ground zero, falling off linearly to the rim; below
// `min` it is a breeze, not a blow; a body is sent at most `body` m/s (the receiver caps it too); at most `things` punts each
export const BLAST = Object.freeze({ radius: Object.freeze({ min: 0.5, max: 30, dflt: 4 }), power: Object.freeze({ min: 0.2, max: 12, dflt: 3 }), min: 0.3, body: 6, things: 32, eps: 0.05 });
export const USE_REACH = 2.5;  // m, feet to a thing the use prompt offers (Roblox's prompt reaches ~10 studs ≈ 2.8 m)
