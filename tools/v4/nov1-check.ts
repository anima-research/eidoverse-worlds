// tools/v4/nov1-check.ts — the branch is OFF the old protocol (R 2026-10-06: "off v1 protocol completely"). Every
// runtime file a client, an agent or the server runs is scanned; any import of a v1 module or any v1 verb on the wire
// fails it. The ONLY v1 code allowed is the one-way translator (an old log in, a v4 world out) and its reader.
// usage: bun tools/v4/nov1-check.ts        (prints each offence as file:line; exit 1 if any)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const RUNTIME = ["client", "mcpl", "server", "shared"];
// the translator reads an old log once to write a new world; it is the only reader of v1 left (and its fold)
const TRANSLATOR = new Set(["shared/v4/translate-v1.js", "shared/v4/translate-d3.js", "server/v4/build.ts", "shared/fold.js"]);
const SKIP_DIR = new Set(["node_modules", "vendor", "dist", ".git"]);
const isTest = (f) => /(^|\/)[^/]*[-.](test|bench|probe)\.[mc]?[jt]s$/.test(f) || f.includes("/test/") || f.includes("/tests/");

// the v1 modules, by resolved path: an import is judged by WHAT it resolves to (shared/v4/fold.js is v4's own fold)
const V1_MODULES = new Map([
  ["shared/fold.js", "imports the v1 fold"], ["shared/rightsfold.js", "imports the v1 rights fold"], ["shared/v4/fromv1.js", "imports fromv1"],
  ["server/verbs.ts", "imports the v1 verb handlers"], ["server/reactions.ts", "imports v1 reactions"], ["server/rights.ts", "imports v1 rights"],
  ["server/lint.ts", "imports the v1 log lint"], ["server/events.ts", "imports v1 log events"],
]);
const RULES = [
  [/\bsendVerbs?\s*\(/, "sends a v1 verb (sendVerb)"],
  [/type:\s*["']verb["']/, "puts a v1 `verb` message on the wire"],
  [/\bsendLease\s*\(/, "sends a v1 lease"],
];
const IMPORT = /(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
const offences = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = path.join(dir, name); const rel = path.relative(ROOT, p);
    if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.(m?js|ts)$/.test(name) || isTest(rel) || TRANSLATOR.has(rel)) continue;
    fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;   // a comment may name the old world; code may not use it
      for (const [re, what] of RULES) if (re.test(line)) offences.push(`${rel}:${i + 1}  ${what}`);
      for (const m of line.matchAll(IMPORT)) { const to = path.relative(ROOT, path.resolve(path.dirname(p), m[1]));
        if (V1_MODULES.has(to)) offences.push(`${rel}:${i + 1}  ${V1_MODULES.get(to)} (${to})`); }
    });
  }
};
for (const d of RUNTIME) walk(path.join(ROOT, d));
if (fs.existsSync(path.join(ROOT, "shared/v4/fromv1.js"))) offences.push("shared/v4/fromv1.js  still exists");
for (const o of offences) console.log("  " + o);
console.log(`[nov1-check] ${offences.length ? `${offences.length} v1 offence(s)` : "no v1 at runtime"}`);
process.exit(offences.length ? 1 : 0);
