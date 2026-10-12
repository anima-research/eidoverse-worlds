// @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
const s = await sock();
const j = await s.join("gym", "riannon");
console.log("you=", j.snapshot?.you, "cut.you=", j.snapshot?.cut?.you, "role?", JSON.stringify(j.snapshot?.cut?.role||j.snapshot?.role));
const help = await s.req("help", {});
console.log("verbs:", JSON.stringify(help?.verbs||help).slice(0,600));
// try to create a thing as owner
const c = await s.req("create", { id: "atk-lock-target", model: "crate", place: { at: [8, 8] } });
console.log("create as riannon:", show(c));
s.close();
