// scratch/atk-phys-wire.ts — attack (2) and (4) against a running door. usage: PORT=8985 bun scratch/atk-phys-wire.ts
// @ts-nocheck
import { client, sleep, show, arrive, walk } from "./atk-phys-lib.ts";
const PORT = +(process.env.PORT ?? 8985), WORLD = process.env.WORLD ?? "gym";
const A = await client(PORT, WORLD, "atk-phys-a"), B = await client(PORT, WORLD, "atk-phys-b");
console.log("joined", !!A.snapshot, !!B.snapshot, A.error, B.error);
const say = (k, r) => console.log(k.padEnd(34), show(r));
say("A arrive", await arrive(A)); say("B arrive", await arrive(B, [0.6, 0, 8]));
const l = await A.req("look", {}); console.log("look keys", Object.keys(l ?? {}).join(","), JSON.stringify(l).slice(0, 200));
say("A walk to balls", await walk(A, [0, 0, -1.2])); say("B walk to balls", await walk(B, [0.6, 0, -1.2]));
// (2a) throw a thing I don't hold
say("A throw unheld", await A.req("throw", { id: "ball-0", v: [0, 2, 3] }));
say("A grab ball-0", await A.req("grab", { id: "ball-0" }));
say("q non-unit [0,0,0,2]", await A.req("throw", { id: "ball-0", v: [0, 2, 3], q: [0, 0, 0, 2] }));
say("q zero", await A.req("throw", { id: "ball-0", v: [0, 2, 3], q: [0, 0, 0, 0] }));
say("q NaN (text)", await A.reqText('{"type":"request","id":"__RID__","verb":"throw","args":{"id":"ball-0","v":[0,2,3],"q":[0,0,0,NaN]}}'));
say("q NaN again (text)", await A.reqText('{"type":"request","id":"__RID__","verb":"throw","args":{"id":"ball-0","v":[0,2,3],"q":[0,0,0,NaN]}}'));
say("q 1.0005 off unit", await A.req("throw", { id: "ball-0", v: [0, 2, 3], q: [0, 0, 0, 1.0005] }));
say("v huge 1e9", await A.req("throw", { id: "ball-0", v: [0, 1e9, 1e9], pos: [0, 1.1, -1.2] }));
