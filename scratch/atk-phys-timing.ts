// scratch/atk-phys-timing.ts — does a throw fly in real time, or does the engine run it to rest at once? usage: PORT=8985 bun scratch/atk-phys-timing.ts <ballId>
// @ts-nocheck
import { client, sleep, show, arrive, walk, settleAll, transformOf } from "./atk-phys-lib.ts";
const PORT = +(process.env.PORT ?? 8985), ID = process.argv[2] ?? "ball-2";
const A = await client(PORT, "gym", "atk-phys-t"); console.log("arrive", show(await arrive(A)));
const t = await transformOf(A, ID); console.log(ID, "at", JSON.stringify(t?.pos)); console.log("walk", show(await walk(A, [t.pos[0], 0, t.pos[2] + 0.8])));
console.log("grab", show(await A.req("grab", { id: ID })));
const t0 = performance.now(); const th = await A.req("throw", { id: ID, v: [0, 4, -4] }); console.log("throw", show(th), "reply ms", (performance.now() - t0).toFixed(0));
for (let i = 0; i < 14; i++) { const w = await A.req("wait", {}); const f = w.inFlight?.[ID]; console.log(`  +${(performance.now() - t0).toFixed(0)} ms`, f ? `pos ${JSON.stringify(f.pos.map((n) => +n.toFixed(2)))} v ${JSON.stringify(f.v.map((n) => +n.toFixed(2)))}` : `not in flight; rests: ${JSON.stringify((w.cameToRest ?? []).filter((r) => r.id === ID).map((r) => r.at))}`); await sleep(100); }
A.close(); process.exit(0);
