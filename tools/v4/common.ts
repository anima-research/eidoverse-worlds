// tools/v4/common.ts — what the v4 suites share: where the engine is, a scratch root per run, and the optional
// control arm.
//
// The suites came from the v4 lab (code/v4-lab @ 11db981). There, each attack/probe ran twice: through the lab's
// door or fold BEFORE the fix (a commit extracted from the lab's git) and through today's. The "before" run is the
// control: it shows the probe really is an attack. Those commits live in the lab's repository, not this one, so
// here the control arm runs only when V4_LAB points at a lab checkout; without it the suites check today's code
// alone and say the control was skipped. Today's side is the gate either way.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ENGINE = path.resolve(new URL("../../", import.meta.url).pathname) + "/";
export const LAB = process.env.V4_LAB ? path.resolve(process.env.V4_LAB) + "/" : null;

/** A fresh scratch directory for one suite run (worlds/, store/ and probe files live here, never in the repo). */
export function scratch(tag: string) {
  const base = process.env.V4_SCRATCH ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const d = fs.mkdtempSync(path.join(base, `v4-${tag}-`)) + "/";
  fs.mkdirSync(d + "worlds", { recursive: true }); fs.mkdirSync(d + "store", { recursive: true });
  return d;
}

/** Extract lab files at a commit into a scratch dir (the control arm). Null when V4_LAB isn't set. */
export function labAt(commit: string, files: string[], tag: string) {
  if (!LAB) return null;
  const d = scratch(`lab-${tag}`);
  const r = Bun.spawnSync(["sh", "-c", `git archive ${commit} ${files.join(" ")} | tar -x -C ${d}`], { cwd: LAB });
  if (r.exitCode !== 0) throw new Error(`V4_LAB: git archive ${commit} failed: ${r.stderr.toString().slice(0, 200)}`);
  return d;
}

export const controlNote = () => (LAB ? `control arm: lab ${LAB}` : "control arm skipped (set V4_LAB=<v4-lab checkout> to run it)");
