// tools/protocol/authority-layers-check.ts — the authority's split is a DAG (refactor C11, 2026-10-12). authority.js is the
// gate and the public entry: it may import every leaf under shared/protocol/authority/. A leaf imports only ctx.js and
// leaves BELOW it in the order written here, never the gate and never a leaf above it, so a request's state has exactly
// one way in (CTX) and the import graph can't cycle. Seen red before it was trusted: a `import {} from "../authority.js"`
// inserted in rights.js, and a `import {} from "./spatial.js"` inserted in math.js, each failed one line below.
//   bun tools/protocol/authority-layers-check.ts
import { readFileSync, readdirSync } from "node:fs";
import { ENGINE } from "./common.ts";

let fails = 0;
const ok = (c: unknown, what: string) => { if (!c) { fails++; console.log("FAIL " + what); } };

const DIR = ENGINE + "shared/protocol/authority/";
const ORDER = ["ctx", "refuse", "catalogue", "storage", "math", "spatial", "sockets", "rights", "bodyconsent", "moderation", "use", "blueprints", "undo", "scripts", "scriptrun", "occupants", "physics", "manipulate", "bodyverbs", "capacity", "checks", "gate", "followups", "writes", "verbs"];   // sockets (10-12 branch, merged 10-14) sits on spatial/catalogue/math/storage/refuse   // leaf-most first; the gate is last
const rank = new Map(ORDER.map((n, i) => [n, i]));
const importsOf = (src: string) => [...src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/gm)].map((m) => m[1]);

const files = readdirSync(DIR).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3)).sort();
ok(files.every((f) => rank.has(f)), `every leaf is in the order: ${files.filter((f) => !rank.has(f)).join(", ") || "yes"}`);
ok(ORDER.every((n) => files.includes(n)), `every named leaf exists: ${ORDER.filter((n) => !files.includes(n)).join(", ") || "yes"}`);
ok(importsOf(readFileSync(DIR + "ctx.js", "utf8")).length === 0, "ctx.js imports nothing");

for (const leaf of files) {
  for (const spec of importsOf(readFileSync(DIR + leaf + ".js", "utf8"))) {
    ok(!/(^|\/)authority\.js$/.test(spec), `${leaf}.js does not import the gate (${spec})`);
    const m = spec.match(/^\.\/([\w-]+)\.js$/);
    if (!m) continue;   // ../something: the protocol's own modules, outside this DAG
    const to = m[1];
    ok(rank.has(to), `${leaf}.js imports a known leaf (${spec})`);
    if (rank.has(to) && rank.has(leaf)) ok(rank.get(to)! < rank.get(leaf)!, `${leaf}.js imports only leaves below it: ${to} is ${rank.get(to)! >= rank.get(leaf)! ? "not below" : "below"}`);
  }
}

// the gate reaches every leaf through the directory, and only the gate re-exports them to the world outside
const gate = readFileSync(ENGINE + "shared/protocol/authority.js", "utf8");
for (const leaf of ORDER.filter((n) => n !== "ctx")) ok(importsOf(gate).includes(`./authority/${leaf}.js`), `authority.js imports ./authority/${leaf}.js`);

console.log(`[authority-layers-check] ${fails === 0 ? "ok" : fails + " failed"}: ${files.length} leaves under shared/protocol/authority/, order ${ORDER.join(" → ")} → authority.js`);
if (fails) process.exit(1);
