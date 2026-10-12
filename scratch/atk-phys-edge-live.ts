// scratch/atk-phys-edge-live.ts — throw a ball past the bounds on the live door and watch whether it ever rests. usage: PORT=8985 bun scratch/atk-phys-edge-live.ts ball-7
// @ts-nocheck
import { client, sleep, show, arrive, walk, transformOf } from "./atk-phys-lib.ts";
const A = await client(+(process.env.PORT ?? 8985), "gym", "atk-phys-e"); const ID = process.argv[2] ?? "ball-7"; console.log("arrive", show(await arrive(A)));
const p = (await transformOf(A, ID)).pos; console.log(ID, "at", JSON.stringify(p)); console.log("walk", show(await walk(A, [p[0], 0, p[2] + 0.8])));
console.log("grab", show(await A.req("grab", { id: ID }))); const t0 = performance.now(); console.log("throw +x 19,6", show(await A.req("throw", { id: ID, v: [19, 6, 0] })));
for (const s of [1, 3, 5, 10, 20, 30, 45]) { await sleep(s * 1000 - (performance.now() - t0) > 0 ? s * 1000 - (performance.now() - t0) : 0); const w = await A.req("wait", {}); const f = w.inFlight?.[ID]; console.log(`  +${s}s`, f ? `FLYING pos ${JSON.stringify(f.pos.map((n) => +n.toFixed(1)))} |v| ${Math.hypot(...f.v).toFixed(2)}` : `rested: ${JSON.stringify((w.cameToRest ?? []).filter((r) => r.id === ID))}`); }
console.log("grab it:", show(await A.req("grab", { id: ID }))); A.close(); process.exit(0);
