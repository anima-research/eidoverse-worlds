// Clean diff (review #260, Antra's rereview at 22494b2c, blocker 3): `git diff --check <base>` over this branch's whole range
// reports no trailing whitespace and no blank line at end of file. Two files keep their whitespace on purpose and are excluded
// by .gitattributes (`-whitespace`), and only those two (D3): a conformance vector that tests readers against CRLF and blank
// lines, and a patch whose context lines end in spaces. Main's own older files outside the range are not this check's business.
//   bun test/gate/diffcheck.ts            (base: $DIFFCHECK_BASE, else the newest merge-base with origin/anima/upstream main)
import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import { spawnSync } from "node:child_process";
import { suite } from "./suite.ts";
import { newestBase } from "../harness/pinhistory.ts";
const ENGINE = path.resolve(import.meta.dir, "../.."); const { check, done } = suite("diffcheck", { cap: Infinity });
const git = (args: string[], cwd = ENGINE) => spawnSync("git", args, { cwd, encoding: "utf8" });

const EXEMPT = ["spec/conformance/logs/12a-blank-crlf.jsonl", "tools/water/native-coordinate-fix.patch"];

function base(): string | null {
  return process.env.DIFFCHECK_BASE || newestBase(ENGINE);   // shared with the pin rows (test/harness/pinhistory.ts)
}

const b = base();
if (!b) {
  check("D1 the range is clean under git diff --check", false,
    "no base to compare against: set DIFFCHECK_BASE=<commit>, or fetch main as origin/main (CI: actions/checkout with fetch-depth: 0)");
} else {
  // the working tree against the base, so an uncommitted fix counts and an uncommitted mess is caught too
  const r = git(["diff", "--check", b]);
  check(`D1 the range ${b.slice(0, 8)}..(working tree) is clean under git diff --check (trailing whitespace, blank line at EOF)`,
    r.status === 0, r.stdout.split("\n").filter((l) => /^\S.*:\d+: /.test(l)).slice(0, 20));
}

// D2 the instrument isn't blind: in a scratch repo, the same command flags a trailing space and a blank line at EOF
{
  const d = fs.mkdtempSync(path.join(process.env.PROTOCOL_SCRATCH ?? os.tmpdir(), "diffcheck-"));
  try {
    const g = (a: string[]) => git(["-c", "user.email=t@t", "-c", "user.name=t", ...a], d);
    g(["init", "-q"]); fs.writeFileSync(path.join(d, "a.js"), "x\n"); g(["add", "."]); g(["commit", "-qm", "a"]);
    fs.writeFileSync(path.join(d, "a.js"), "x \ny\n\n");
    const r = g(["diff", "--check", "HEAD"]);
    check("D2 (control) git diff --check flags a trailing space and a blank line at EOF in a scratch repo",
      r.status !== 0 && /trailing whitespace/.test(r.stdout) && /new blank line at EOF/.test(r.stdout), r.stdout);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

// D3 the only whitespace exemptions are the two named, documented files
{
  const attrs = fs.existsSync(path.join(ENGINE, ".gitattributes")) ? fs.readFileSync(path.join(ENGINE, ".gitattributes"), "utf8") : "";
  const exempt = attrs.split("\n").filter((l) => !l.trim().startsWith("#") && /(^|\s)-whitespace(\s|$)/.test(l)).map((l) => l.trim().split(/\s+/)[0]).sort();
  check("D3 .gitattributes exempts exactly the two documented files from whitespace checks", JSON.stringify(exempt) === JSON.stringify([...EXEMPT].sort()), exempt);
}

// D4 the base is the NEWEST merge-base: a stale origin/main (an old local ref) can't drag it back, even when every commit
// shares one timestamp. pinhistory's baseOf is the one both this check and the pin rows use.
{
  const { baseOf } = await import("../harness/pinhistory.ts");
  const d = fs.mkdtempSync(path.join(process.env.PROTOCOL_SCRATCH ?? os.tmpdir(), "diffcheck-base-"));
  const keep = process.env.PIN_BASE; delete process.env.PIN_BASE;
  try {
    const env = { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
    const g = (a: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d, encoding: "utf8", env }).stdout.trim();
    g(["init", "-q", "-b", "main"]);
    const sha = (m: string) => { fs.writeFileSync(path.join(d, "f"), m); g(["add", "."]); g(["commit", "-qm", m]); return g(["rev-parse", "HEAD"]); };
    const old = sha("a"); sha("b"); const now = sha("c"); g(["switch", "-q", "-c", "topic"]); sha("d");
    g(["update-ref", "refs/remotes/origin/main", old]); g(["update-ref", "refs/remotes/anima/main", now]);
    check("D4 the base is the newest merge-base: a stale origin/main can't drag it back (same-second commits too)", baseOf(d, []) === now, { got: baseOf(d, []), want: now, stale: old });
  } finally { if (keep !== undefined) process.env.PIN_BASE = keep; fs.rmSync(d, { recursive: true, force: true }); }
}

done();
