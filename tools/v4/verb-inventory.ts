// @ts-nocheck
// tools/v4/verb-inventory.ts — slice 3b worklist: every v1 verb the client still sends (sendVerb/sendVerbs call sites),
// and whether fromv1 can spell it as a door request. UNMAPPED = refused in the page itself in a v4 world. 3b is done
// when this prints nothing (every caller sends door requests directly and fromv1.js is deleted). usage: bun tools/v4/verb-inventory.ts
import fs from "node:fs"; import path from "node:path";
import { toV4 } from "../../shared/v4/fromv1.js";
const dir = path.join(import.meta.dir, "../../client"); const hits = [];
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (f === "node_modules") continue; if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js")) fs.readFileSync(p, "utf8").split("\n").forEach((l, i) => { for (const m of l.matchAll(/sendVerbs?\(\s*['"]([a-z]+)['"]/g)) hits.push([m[1], `${path.relative(dir, p)}:${i + 1}`]); }); } };
walk(dir);
const st = { entities: {} }; const by = {};
for (const [v, at] of hits) { let r; try { r = toV4(st, v, {}); } catch (e) { r = { threw: String(e).slice(0, 60) }; } const k = r?.refuse && /no v4 request yet/.test(r.refuse) ? "UNMAPPED" : "mapped"; (by[v] ??= { k, at: [] }).at.push(at); }
for (const [v, o] of Object.entries(by).sort((a, b) => a[1].k.localeCompare(b[1].k))) console.log(o.k.padEnd(9), v.padEnd(10), o.at.join(" "));
