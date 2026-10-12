// scratch/atk-phys-wire2.ts — attack (2) continued + (4) world edge. usage: PORT=8985 bun scratch/atk-phys-wire2.ts
// @ts-nocheck
import { client, sleep, show, arrive, walk } from "./atk-phys-lib.ts";
const PORT = +(process.env.PORT ?? 8985), WORLD = process.env.WORLD ?? "gym";
const A = await client(PORT, WORLD, "atk-phys-a"), B = await client(PORT, WORLD, "atk-phys-b");
const say = (k, r) => console.log(k.padEnd(34), show(r));
say("A arrive", await arrive(A)); say("B arrive", await arrive(B, [0.6, 0, 8]));
say("A walk", await walk(A, [0, 0, -1.2])); say("B walk", await walk(B, [0.7, 0, -1.2]));
const settle = async (c) => { let w; for (let i = 0; i < 60; i++) { await sleep(250); w = await c.req("wait", {}); if (!Object.keys(w.inFlight ?? {}).length) break; } return w; };
await settle(A);
const inspT = async (id) => { const r = await A.req("inspect", { id }); return r?.components?.transform?.value ?? r?.components?.transform ?? r?.transform ?? r?.c?.transform ?? null; };
const insp = async (id) => JSON.stringify(await inspT(id)).slice(0, 200);
console.log("ball-0", await insp("ball-0")); console.log("ball-1", await insp("ball-1"));
// pull ball-0 back if it rolled: grab has range 1.5 from the hand
let g = await A.req("grab", { id: "ball-0" }); say("A grab ball-0", g);
if (!g.ok) { const p = (await inspT("ball-0")).pos; say("A walk to ball-0", await walk(A, [p[0], 0, p[2] + 0.8])); say("A grab ball-0", g = await A.req("grab", { id: "ball-0" })); }
say("v huge 1e9", await A.req("throw", { id: "ball-0", v: [0, 1e9, 1e9] }));
await settle(A); say("A grab again", await A.req("grab", { id: "ball-0" })); 
say("v 1e308x3 (hypot overflow)", await A.req("throw", { id: "ball-0", v: [1e308, 1e308, 1e308] }));
await settle(A); console.log("ball-0", await insp("ball-0"));
say("A grab again", await A.req("grab", { id: "ball-0" }));
say("w huge 1e6", await A.req("throw", { id: "ball-0", v: [0, 1, 1], w: [0, 1e6, 0] }));
say("w 999", await A.req("throw", { id: "ball-0", v: [0, 0.5, 0.5], w: [0, 0, 999] }));
await settle(A); console.log("ball-0 after w999", await insp("ball-0"));
say("A grab again", await A.req("grab", { id: "ball-0" }));
say("t negative", await A.req("throw", { id: "ball-0", v: [0, 0.5, 0.5], t: -1 })); await settle(A);
say("A grab again", await A.req("grab", { id: "ball-0" }));
say("pos far", await A.req("throw", { id: "ball-0", v: [0, 0.5, 0.5], pos: [10, 0, 10] }));
say("pos underground", await A.req("throw", { id: "ball-0", v: [0, 0.5, 0.5], pos: [0, -1.4, -1.2] }));
await settle(A); console.log("ball-0 after underground", await insp("ball-0"));
say("A grab again", await A.req("grab", { id: "ball-0" }));
say("B throw A's held", await B.req("throw", { id: "ball-0", v: [0, 2, 3] }));
say("B drop A's held", await B.req("drop", { id: "ball-0" }));
say("B put A's held", await B.req("put", { id: "ball-0", pos: [1, 0, -1] }));
say("B punt A's held", await B.req("punt", { id: "ball-0", power: 1 }));
say("B grab steal ball-0", await B.req("grab", { id: "ball-0" }));
say("A throw after theft", await A.req("throw", { id: "ball-0", v: [0, 1, 1] }));
say("A drop after theft", await A.req("drop", { id: "ball-0" }));
say("B drop", await B.req("drop", { id: "ball-0" })); await settle(B);
// (2c) race: both grab ball-1 in one tick
const p1 = (await inspT("ball-1")).pos; say("A walk ball-1", await walk(A, [p1[0], 0, p1[2] + 0.8])); say("B walk ball-1", await walk(B, [p1[0] + 0.6, 0, p1[2] + 0.8]));
let ra, rb; { const pa = A.req("grab", { id: "ball-1" }); const pb = B.req("grab", { id: "ball-1" }); [ra, rb] = await Promise.all([pa, pb]); }
say("race A grab ball-1", ra); say("race B grab ball-1", rb);
say("A throw ball-1", await A.req("throw", { id: "ball-1", v: [0, 1, 1] }));
say("B throw ball-1", await B.req("throw", { id: "ball-1", v: [0, 1, 1] }));
await settle(A);
const ev = (c) => c.msgs.filter((m) => m.type === "held").map((m) => JSON.stringify(m).slice(0, 140));
console.log("A held events:\n  " + ev(A).slice(-8).join("\n  ")); console.log("B held events:\n  " + ev(B).slice(-8).join("\n  "));
console.log("types", [...new Set(A.msgs.map((m) => m.type))].join(","));
// (4) edge
say("A step y 50", await A.req("move", { to: [p1[0], 50, p1[2] + 0.8] }));
say("A step y -5", await A.req("move", { to: [p1[0], -5, p1[2] + 0.8] }));
say("A walk to 19.9", await walk(A, [19.9, 0, 1])); say("A step 20.5", await A.req("move", { to: [20.5, 0, 1] })); say("A step 20.0", await A.req("move", { to: [20, 0, 1] }));
say("A walk ramp", await walk(A, [15.4, 0, 1.0])); say("A grab ramp-ball-0", await A.req("grab", { id: "ramp-ball-0" }));
say("A walk edge holding", await walk(A, [19.4, 0, 1.0]));
say("A put outside", await A.req("put", { id: "ramp-ball-0", pos: [20.5, 0, 1.0] }));
say("A put at 19.99 (half out)", await A.req("put", { id: "ramp-ball-0", pos: [19.99, 0, 1.0] }));
say("A throw out +x", await A.req("throw", { id: "ramp-ball-0", v: [19, 2, 0] }));
const w4 = await settle(A); say("wait", w4); console.log("ramp-ball-0 now", await insp("ramp-ball-0"));
const logs = A.msgs.filter((m) => m.type === "log"); const ents = logs.flatMap((m) => Array.isArray(m.entries) ? m.entries : m.entry ? [m.entry] : []);
const lost = ents.filter((e) => e?.verb === "return-lost"); console.log("return-lost:", lost.length, JSON.stringify(lost.slice(-1)).slice(0, 300), "log msg sample", JSON.stringify(logs[0]).slice(0, 200));
A.close(); B.close(); process.exit(0);
