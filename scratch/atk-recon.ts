// @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
const s = await sock();
const j = await s.join("gym", "marigold");
console.log("marigold join:", j.snapshot ? "snapshot ok, you="+j.snapshot.you : "NO SNAP", j.errors);
const rights = await s.req("your-rights", {});
console.log("your-rights:", JSON.stringify(rights).slice(0,300));
const look = await s.req("look", {});
const ents = look?.world?.entities || look?.entities || look?.cut?.entities;
if (ents) { const ids = Object.keys(ents); console.log("entity count:", ids.length, "sample:", ids.slice(0,12)); }
else console.log("look reply keys:", Object.keys(look||{}), JSON.stringify(look).slice(0,300));
// world roles
const wi = await s.req("inspect", { id: "@world" });
console.log("@world comps:", Object.keys(wi?.components||{}).filter(k=>k.startsWith('roles')||k==='default-role'));
console.log("roles vals:", JSON.stringify(Object.fromEntries(Object.entries(wi?.components||{}).filter(([k])=>k.startsWith('roles')||k==='default-role'))).slice(0,300));
s.close();
