// tools/protocol/common.ts — what the protocol suites share: where the engine is, a scratch root per run, and the optional
// control arm.
//
// The suites came from the protocol lab (the protocol lab @ 11db981). There, each attack/probe ran twice: through the lab's
// door or fold BEFORE the fix (a commit extracted from the lab's git) and through today's. The "before" run is the
// control: it shows the probe really is an attack. Those commits live in the lab's repository, not this one, so
// here the control arm runs only when PROTOCOL_LAB points at a lab checkout; without it the suites check today's code
// alone and say the control was skipped. Today's side is the gate either way.
//
// Locks (slice 3a, PROTOCOL §5): the engine's door calls the edit lock `lock` and refuses with code `locked`; the
// lab's doors called it `pinned` and refused with `pinned`. The control arm stays meaningful WITHOUT a name map,
// because both lab doors the control extracts (4f62913 and c9b4a67) already read `lock` as their legacy alias of
// `pinned` (`pinnedC = c?.pinned === true || c?.lock === true`). So every suite sends the same `lock` request to both
// arms and it locks the thing in both. Only the refusal CODE differs, and no baseline predicate reads a code: they
// ask whether the attack was accepted (`ok`) or refused at all; the `now` predicates ask for `locked`. One case
// changed meaning on purpose: attack H1c (motion on a lock) is a guard now, since v1's matrix keeps motion open.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ENGINE = path.resolve(new URL("../../", import.meta.url).pathname) + "/";
export const LAB = process.env.PROTOCOL_LAB ? path.resolve(process.env.PROTOCOL_LAB) + "/" : null;

/** A fresh scratch directory for one suite run (worlds/, store/ and probe files live here, never in the repo). */
export function scratch(tag: string) {
  const base = process.env.PROTOCOL_SCRATCH ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const d = fs.mkdtempSync(path.join(base, `proto-${tag}-`)) + "/";
  fs.mkdirSync(d + "worlds", { recursive: true }); fs.mkdirSync(d + "store", { recursive: true });
  if (!process.env.PROTOCOL_KEEP) process.on("exit", () => fs.rmSync(d, { recursive: true, force: true })); // also when a suite throws part-way (PROTOCOL_KEEP=1 keeps it to read)
  return d;
}

/** Extract lab files at a commit into a scratch dir (the control arm). Null when PROTOCOL_LAB isn't set. */
export function labAt(commit: string, files: string[], tag: string) {
  if (!LAB) return null;
  const d = scratch(`lab-${tag}`);
  const r = Bun.spawnSync(["sh", "-c", `git archive ${commit} ${files.join(" ")} | tar -x -C ${d}`], { cwd: LAB });
  if (r.exitCode !== 0) throw new Error(`PROTOCOL_LAB: git archive ${commit} failed: ${r.stderr.toString().slice(0, 200)}`);
  return d;
}

// an OPTIONAL line (the gate counts and lists these: an optional extension that did not run, never a skip of the gate)
export const controlNote = () => (LAB ? `control arm: lab ${LAB}` : "OPTIONAL control-arm: not run (set PROTOCOL_LAB=<protocol lab checkout> to run the pre-fix control arm)");
