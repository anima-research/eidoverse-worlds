// lite-graph-test — the lite client's static import graph never reaches the engine (house I10 / config I1, #260).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/lite-graph-test.ts
//
// lite.js exists so a phone that can't draw the world never downloads the renderer (lite-weight-test.mjs proves it
// with a browser's network ledger). This is the same claim read off the source, no browser: walk every static
// import/export-from from client/lite.js and check that none reaches core.js (which constructs the WebGPU renderer at
// import), world.js (which imports core.js), or a bare three/three-vrm specifier. net.js reached core.js through
// world.js for one Map (avatarMounts), which lives in the leaf mounts.js now.
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ""}`); }
};

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const entry = path.join(ROOT, "client/lite.js");
const RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const parent = new Map([[entry, null]]), bare = [];
const q = [entry];
while (q.length) {
  const f = q.shift();
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(RE)) {
    const sp = m[1];
    if (!sp.startsWith(".")) { bare.push(`${sp} (from ${path.relative(ROOT, f)})`); continue; }
    const r = path.resolve(path.dirname(f), sp);
    if (!parent.has(r)) { parent.set(r, f); q.push(r); }
  }
}
const chain = (f) => { const c = []; for (let x = f; x; x = parent.get(x)) c.unshift(path.relative(ROOT, x)); return c.join(" -> "); };
check("the walk found the graph (lite.js reaches net.js)", parent.has(path.join(ROOT, "client/lib/net.js")), `${parent.size} files`);
for (const bad of ["client/lib/core.js", "client/lib/world.js"]) {
  const f = path.join(ROOT, bad);
  check(`lite never imports ${bad}`, !parent.has(f), parent.has(f) ? chain(f) : "");
}
const engine = bare.filter((b) => /^three(\/|$)|three-vrm|three-mesh-bvh/.test(b));
check("lite imports no three / three-vrm module", engine.length === 0, engine.join(", "));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
