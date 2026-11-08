// round — the roundings and the −0 scrub every side of the protocol applies, one binding (debt survey 10-12 #14: each
// side had its own, and a 4-dp one hid under the 3-dp name). I-JSON has no −0; an engine can make one, and a client's
// prediction must fold the bits the log will carry, so the scrub runs on both sides.
export const r3 = (n) => Math.round(n * 1000) / 1000;
export const r2 = (n) => Math.round(n * 100) / 100;
export const r9 = (v) => +(+v).toFixed(9);
export const noNeg0 = (n) => (n === 0 ? 0 : n);
export const unNegZero = (v) => (Object.is(v, -0) ? 0 : Array.isArray(v) ? v.map(unNegZero) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unNegZero(x)])) : v);
