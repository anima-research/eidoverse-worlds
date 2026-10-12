// scratch/atk-phys-climb.ts — can a body step above the world's bounds.max y? usage: PORT=8985 bun scratch/atk-phys-climb.ts
// @ts-nocheck
import { client, sleep, show, arrive } from "./atk-phys-lib.ts";
const A = await client(+(process.env.PORT ?? 8985), "gym", "atk-phys-c"); console.log("arrive", show(await arrive(A)));
for (const y of [3.5, 7, 10.5, 14, 17.5, 21]) { await sleep(800); console.log(`step to y=${y}`, show(await A.req("move", { to: [0, y, 8] }))); }
console.log("grab from 21 m up: ", show(await A.req("grab", { id: "ball-7" })));
await sleep(800); console.log("step back to ground in one go", show(await A.req("move", { to: [0, 0, 8] })));
A.close(); process.exit(0);
