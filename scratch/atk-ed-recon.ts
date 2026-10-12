// @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
const me = await sock(); await me.join("gym", "atk-ed-1");
const sc = await me.req("schema", { component: "sockets" }); console.log("sockets help:", JSON.stringify(sc.components?.sockets).slice(0, 900));
const lk = await me.req("look", {}); const models = {}; 
const snap = me.msgs.find((m) => m.type === "snapshot"); const ents = snap?.cut?.entities ?? snap?.entities ?? {};
for (const [k, e] of Object.entries(ents)) { const m = e?.c?.model ?? e?.model ?? e?.lib; if (m) models[m] = (models[m] ?? 0) + 1; }
console.log("entities:", Object.keys(ents).length, "models:", JSON.stringify(models).slice(0, 600));
const seats = Object.entries(ents).filter(([k, e]) => e?.c?.sockets).map(([k, e]) => [k, Object.keys(e.c.sockets)]); console.log("seats:", JSON.stringify(seats).slice(0, 400));
const grabs = Object.entries(ents).filter(([k, e]) => e?.c?.grabbable).map(([k]) => k); console.log("grabbables:", grabs.slice(0, 10));
console.log("help use:", JSON.stringify(await me.req("help", { verb: "use" })).slice(0, 500));
console.log("help body:", JSON.stringify(await me.req("help", { verb: "body" })).slice(0, 600));
console.log("help undo:", JSON.stringify(await me.req("help", { verb: "undo" })).slice(0, 400));
console.log("help create:", JSON.stringify(await me.req("help", { verb: "create" })).slice(0, 700));
console.log("snapshot keys:", Object.keys(snap ?? {}), "cut keys:", Object.keys(snap?.cut ?? {}));
const own = await sock(); await own.join("gym", "rab");
console.log("grant can:", show(await own.req("set", { id: "@world", component: "roles:u-r6mcsu5yvwf4azlcjogo", value: { role: "builder", can: { editWorld: true } } })));
own.close(); me.close(); process.exit(0);
