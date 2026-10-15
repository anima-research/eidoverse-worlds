// @ts-nocheck
import { sock } from "./atk-access-lib.ts";
let s=await sock(); await s.join("gym","marigold");
const look=await s.req("look",{});
const atk=(look?.things||[]).filter(t=>/^atk-/.test(t.id));
for (const t of atk) console.log("leftover entity:", t.id, "->", (await s.req("delete",{id:t.id}))?.ok?"deleted":"?");
const wi=await s.req("inspect",{id:"@world"});
const roles=Object.keys(wi?.components||{}).filter(k=>k.startsWith("roles:"));
// our granted builders were atk-* ids; leave the 3 original owner/builder roles. Check against baseline 3.
console.log("current role count:", roles.length, "(baseline was 3)");
for (const k of roles) { const v=wi.components[k]; if (v.role==="builder") { /* could be ours; only delete if not baseline */ } }
console.log("role keys:", JSON.stringify(roles));
s.close();
