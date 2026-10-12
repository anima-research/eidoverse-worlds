// tools/protocol/sclock-check.ts — the client's server clock slews (DESIGN-physics-responsiveness §3; STRIKES PH-S2 'display
// clock jumps'): a new minimum-RTT sample moves the shown offset gradually, a large one at once. usage: bun tools/protocol/sclock-check.ts
// @ts-nocheck
import { noteRoundTrip, serverNow, localNow, clockDebug } from "../../client/lib/serverclock.js";
let fails = 0, passes = 0; const ok = (c, what, d) => { if (c) passes++; else { fails++; console.log("FAIL", what, d !== undefined ? JSON.stringify(d) : ""); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = localNow();
noteRoundTrip(t - 20, t + 1000 - 10, t);      // offset +1000 at rtt 20
serverNow(); const a = clockDebug();
noteRoundTrip(t - 10, t + 1100 - 5, t);       // a better sample (rtt 10) says +1100: a 100 ms correction
serverNow(); const b = clockDebug();
ok(Math.abs(b.best - 1100) < 1 && Math.abs(b.shown - 1000) < 5, "C1 a 100 ms correction is not taken in one read", { a, b });
await sleep(300); serverNow(); const c = clockDebug();
ok(c.shown > 1005 && c.shown < 1030, "C2 …after 300 ms it has moved about 15 ms (5% of elapsed)", c);
await sleep(2500); serverNow(); const d = clockDebug();
ok(Math.abs(d.shown - 1100) < 1, "C3 …and in a few seconds it is there", d);
noteRoundTrip(t - 8, t + 3000 - 4, t);        // a 1.9 s correction (and the best rtt yet): a resync, taken at once
serverNow(); const e = clockDebug();
ok(Math.abs(e.shown - 3000) < 1, "C4 a correction over half a second is taken at once", e);
console.log(`sclock: ${passes} ok, ${fails} failed`); process.exit(fails ? 1 : 0);
