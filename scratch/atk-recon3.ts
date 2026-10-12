// @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
const s = await sock();
await s.join("gym", "riannon");
const help = await s.req("help", {});
console.log("WRITE verbs:", JSON.stringify(help?.verbs?.write||[]));
console.log("ACT verbs:", JSON.stringify(help?.verbs?.act||help?.verbs?.presence||[]));
console.log("ALL keys:", Object.keys(help?.verbs||{}));
const fm = await s.req("find", { kind: "model", query: "crate" });
console.log("find crate:", JSON.stringify(fm).slice(0,300));
const fm2 = await s.req("find", { kind: "model", query: "cube" });
console.log("find cube:", JSON.stringify(fm2).slice(0,300));
// inspect an existing thing to copy a model path
const insp = await s.req("inspect", { id: "sign-welcome" });
console.log("sign model:", JSON.stringify(insp?.components?.model));
s.close();
