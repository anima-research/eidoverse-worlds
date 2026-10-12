// scratch/atk-phys-wire3.ts — spin/punt/t/drop-with-v on the live door. usage: PORT=8985 bun scratch/atk-phys-wire3.ts
// @ts-nocheck
import { client, sleep, show, arrive, walk, settleAll, transformOf } from "./atk-phys-lib.ts";
const PORT = +(process.env.PORT ?? 8985); const say = (k, r) => console.log(k.padEnd(34), show(r));
const A = await client(PORT, "gym", "atk-phys-a"), B = await client(PORT, "gym", "atk-phys-b");
say("A arrive", await arrive(A)); say("B arrive", await arrive(B, [0.7, 0, 8]));
const p5 = (await transformOf(A, "ball-5")).pos, p6 = (await transformOf(A, "ball-6")).pos; console.log("ball-5", JSON.stringify(p5), "ball-6", JSON.stringify(p6));
say("A walk", await walk(A, [p5[0], 0, p5[2] + 0.8])); say("B walk", await walk(B, [p5[0] + 0.7, 0, p5[2] + 0.8]));
say("A grab ball-5", await A.req("grab", { id: "ball-5" }));
say("B punt A's held (beside A)", await B.req("punt", { id: "ball-5", power: 1 }));
say("B punt power 1e9", await B.req("punt", { id: "ball-6", power: 1e9 }));
say("B punt v huge", await B.req("punt", { id: "ball-6", v: [0, 1e6, 1e6] }));
say("B punt power -5", await B.req("punt", { id: "ball-6", power: -5 }));
say("B punt power NaN-ish string", await B.req("punt", { id: "ball-6", power: "9" }));
say("A drop with v (a drop carrying velocity)", await A.req("drop", { id: "ball-5", v: [0, 5, 5] }));
let w = await A.req("wait", {}); console.log("  ball-5 after drop:", JSON.stringify(w.inFlight?.["ball-5"] ?? "not in flight").slice(0, 120)); await settleAll(A);
const q5 = (await transformOf(A, "ball-5")).pos; console.log("  ball-5 rested", JSON.stringify(q5.map((n) => +n.toFixed(2))));
say("A walk to ball-5", await walk(A, [q5[0], 0, q5[2] + 0.8])); say("A grab ball-5", await A.req("grab", { id: "ball-5" }));
const th = await A.req("throw", { id: "ball-5", v: [0, 1, 0.5], w: [0, 0, 999], t: 1 }); say("A throw w=999 t=1", th);
await sleep(150); w = await A.req("wait", {}); console.log("  in flight:", JSON.stringify(w.inFlight?.["ball-5"] ?? null).slice(0, 160)); await settleAll(A);
const q5b = (await transformOf(A, "ball-5")); console.log("  ball-5 rested", JSON.stringify(q5b.pos.map((n) => +n.toFixed(2))), "q", JSON.stringify(q5b.q.map((n) => +n.toFixed(3))));
say("A grab ball-5", await A.req("grab", { id: "ball-5" })); if (!(await transformOf(A, "ball-5"))) {}
say("A throw t=1e15 (future)", await A.req("throw", { id: "ball-5", v: [0, 1, 0.5], t: 1e15 })); await settleAll(A);
A.close(); B.close(); process.exit(0);
