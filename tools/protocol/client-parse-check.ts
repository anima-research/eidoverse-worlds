// tools/protocol/client-parse-check.ts — every module the browser can load parses.
//
// A syntax error in any client module takes the whole client down with a blank page, and the commonest one is a merge
// that hoists the same import into a file twice (`"a" has already been declared`). Nothing in tools/ imports
// client/main.js, so every unit suite passes and only the browser lane, which needs Chromium and the asset library,
// sees it. tools/smoke.ts parses client/main.js and client/lib/*.js, but it isn't in the gate and it skips the
// subdirectories (lib/realize/, lib/commands/, lib/edit/…). This parses every .js/.mjs under client/ and shared/ (the
// browser loads shared/ as /shared/) with Bun's own parser, outside node_modules. Vendored code is parsed too: the page
// imports client/lib/vendor/htmlmesh.js statically (through xr.js), and it carries patches of ours.
//   C1  the parser refuses a duplicate top-level binding (so this check can't pass vacuously)
//   C2  the walk reaches the entry points and the subdirectories
//   C3  every module parses: one FAIL row per file that doesn't (the gate keeps the rows, not a long detail)
// usage: bun tools/protocol/client-parse-check.ts
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const DIRS = ["client", "shared"];
const SKIP_DIR = new Set(["node_modules", ".git"]);
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n         ${detail}` : ""}`);
};

const transpiler = new Bun.Transpiler({ loader: "js" });
const parseError = (src: string): string | null => {
  try { transpiler.scan(src); return null; } catch (e) { return String((e as Error)?.message ?? e); }
};

function walk(dir: string, out: string[] = []): string[] {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) { if (!SKIP_DIR.has(d.name)) walk(path.join(dir, d.name), out); }
    else if (/\.m?js$/.test(d.name)) out.push(path.join(dir, d.name));
  }
  return out;
}

const dup = parseError(`import { a } from "./x.js";\nimport { a } from "./y.js";\n`);
check("C1 the parser refuses a duplicate import binding", !!dup && /already been declared/.test(dup), dup ?? "parsed");

const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const rel = files.map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
check("C2 the walk reaches client/main.js, client/lite.js, the subdirectories and the vendored htmlmesh",
  rel.includes("client/main.js") && rel.includes("client/lite.js") && rel.includes("client/lib/vendor/htmlmesh.js") && rel.some((f) => /^client\/lib\/[^/]+\//.test(f)) && rel.some((f) => f.startsWith("shared/protocol/")),
  `${rel.length} files`);

let bad = 0;
for (let i = 0; i < files.length; i++) {
  const err = parseError(fs.readFileSync(files[i], "utf8"));
  if (err) { bad++; check(`C3 ${rel[i]} parses`, false, err); }
}
if (!bad) check(`C3 all ${files.length} client and shared modules parse`, true);
else console.log(`  ${bad} of ${files.length} modules don't parse`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
