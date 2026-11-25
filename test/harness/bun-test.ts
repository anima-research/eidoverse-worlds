// bun-test — runs a bun:test file as a gate suite (run.ts starts every suite as `bun <file>`; a bun:test file needs `bun test`).
//   bun test/harness/bun-test.ts test/server/screenshots-test.ts
const file = process.argv[2];
if (!file) { console.error("usage: bun test/harness/bun-test.ts <a bun:test file>"); process.exit(2); }
const r = Bun.spawnSync([process.execPath, "test", `./${file}`], { cwd: `${import.meta.dir}/../..`, stdout: "inherit", stderr: "inherit" });
process.exit(r.exitCode ?? 1);
