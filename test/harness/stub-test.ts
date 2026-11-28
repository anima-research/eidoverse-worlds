// test/harness/stub-test.ts — the stub helper (test/harness/stub.ts) can't be fooled by a move: a stub that never applied
// fails the run, and so does a stub that applied to a relative import naming a file that isn't there (a stale path the
// stub's regex still accepts, such as `(xr/)?xrpanels` matching the old flat `./xrpanels.js`).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/harness/stub-test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { suite } from "../gate/suite.ts";
const { check, done } = suite("stub-guard");
const STUB_TS = path.resolve(import.meta.dir, "stub.ts");

// a child that stubs /^\.\/(sub\/)?thing\.js$/ and imports `spec` from a file in `dir`; returns its exit code and output
function child(dir: string, spec: string, extra = "") {
  fs.writeFileSync(path.join(dir, "stubbed.js"), "export const stubbed = true;\n");
  fs.writeFileSync(path.join(dir, "importer.js"), `import { stubbed } from ${JSON.stringify(spec)};\nexport { stubbed };\n`);
  fs.writeFileSync(path.join(dir, "run.ts"), `import { plugin } from "bun";
import { stubResolve } from ${JSON.stringify(STUB_TS)};
plugin({ name: "t", setup(b) {
  stubResolve(b, /^\\.\\/(sub\\/)?thing\\.js$/, () => ({ path: ${JSON.stringify(path.join(dir, "stubbed.js"))} }));
  ${extra}
} });
const m = await import(${JSON.stringify(path.join(dir, "importer.js"))});
console.log("imported", m.stubbed);
`);
  const r = spawnSync("bun", [path.join(dir, "run.ts")], { encoding: "utf8", env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const scratch = (n: string) => fs.mkdtempSync(path.join(process.env.PROTOCOL_SCRATCH ?? os.tmpdir(), `stub-${n}-`));
{
  const d = scratch("live"); fs.mkdirSync(path.join(d, "sub")); fs.writeFileSync(path.join(d, "sub", "thing.js"), "export const stubbed = false;\n");
  try { const r = child(d, "./sub/thing.js");
    check("SG1 a stub on an import whose file exists applies and the run passes", r.status === 0 && /imported true/.test(r.out) && !/FAIL/.test(r.out), r.out);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
{
  const d = scratch("stale");
  try { const r = child(d, "./thing.js");
    check("SG2 a stub that applied to a relative import naming no file fails the run, naming the specifier and importer", r.status === 1 && /FAIL stub applied to a path that isn't there: \.\/thing\.js from .*importer\.js/.test(r.out), r.out);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
{
  const d = scratch("dead"); fs.mkdirSync(path.join(d, "sub")); fs.writeFileSync(path.join(d, "sub", "thing.js"), "export const stubbed = false;\n");
  try { const r = child(d, "./sub/thing.js", `stubResolve(b, /^\\.\\/nothing-imports-this\\.js$/, () => ({ path: "x" }));`);
    check("SG3 (control) a stub that never applied still fails the run", r.status === 1 && /FAIL stub never applied/.test(r.out), r.out);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
done();
