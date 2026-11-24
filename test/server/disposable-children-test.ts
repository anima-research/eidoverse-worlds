// bun test/server/disposable-children-test.ts — the server's disposable children (a build check's worker, a one-shot)
// run at oom_score_adj 1000 on Linux, as the optimizer's does (optimize-pump-test 6): under the unit's MemoryMax= the
// kernel then kills one of them, not the server. Each reports the score it runs under.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "disposable-"));
process.env.OPT_DIR = join(dir, "opt"); process.env.WORLDS_DIR = join(dir, "worlds");
const { mkCheck } = await import("../harness/harness.ts");
const { check, tally } = mkCheck();

if (process.platform !== "linux") console.log("(non-Linux: no oom_score_adj — skipped)");
else {
  const score = `require("node:fs").readFileSync("/proc/self/oom_score_adj", "utf8").trim()`;
  const own = (await Bun.file("/proc/self/oom_score_adj").text()).trim();
  check("(this test itself does not run at 1000, or every row would pass)", own !== "1000", own);

  const Q = await import("../../server/buildcheck-queue.ts");
  const runner = join(dir, "oom-runner.ts"); writeFileSync(runner, `console.log(JSON.stringify({ levels: [${score}] }));`);
  Q.checkConfig.runner = runner;
  const f = join(dir, "model.glb"); writeFileSync(f, "a model");
  const r: any = await Q.checkFile(f).catch((e: Error) => ({ error: e.message }));
  check("a build check's worker runs at oom_score_adj 1000", r?.levels?.[0] === "1000", JSON.stringify(r));

  const { runOneShot } = await import("../../server/oneshot.ts");
  const o = await runOneShot([process.execPath, "-e", `console.log(${score})`], { cwd: dir, env: process.env, guardMs: 20_000, label: "oom" });
  check("a one-shot (an in-place upgrade, the world index) runs at oom_score_adj 1000", o.out.trim() === "1000", JSON.stringify({ out: o.out, code: o.code }));
}
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
