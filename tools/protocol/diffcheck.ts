// Clean diff (review #260, Antra's rereview at 22494b2c, blocker 3): `git diff --check <base>` over this branch's whole range
// reports no trailing whitespace and no blank line at end of file. Two files keep their whitespace on purpose and are excluded
// by .gitattributes (`-whitespace`), and only those two (D3): a conformance vector that tests readers against CRLF and blank
// lines, and a patch whose context lines end in spaces. Main's own older files outside the range are not this check's business.
//   bun tools/protocol/diffcheck.ts            (base: $DIFFCHECK_BASE, else the merge-base with origin/main or anima/main)
import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import { spawnSync } from "node:child_process";
const ENGINE = path.resolve(import.meta.dir, "../.."); let pass = 0, fail = 0;
const check = (name: string, ok: unknown, info?: unknown) => { if (ok) { pass++; console.log(`ok   ${name}`); } else { fail++; console.log(`FAIL ${name}`); if (info !== undefined) console.log("     ", typeof info === "string" ? info : JSON.stringify(info)); } };
const git = (args: string[], cwd = ENGINE) => spawnSync("git", args, { cwd, encoding: "utf8" });

const EXEMPT = ["spec/conformance/logs/12a-blank-crlf.jsonl", "tools/water/native-coordinate-fix.patch"];

function base(): string | null {
  if (process.env.DIFFCHECK_BASE) return process.env.DIFFCHECK_BASE;
  // the NEWEST merge-base among the candidates: a stale remote (a checkout whose origin is an old local path) must not
  // drag the base back and blame this range for main's own later files
  const found = ["origin/main", "anima/main", "upstream/main"].map((ref) => git(["merge-base", "HEAD", ref]).stdout.trim()).filter(Boolean);
  const dated = found.map((c) => ({ c, t: Number(git(["log", "-1", "--format=%ct", c]).stdout.trim()) || 0 })).sort((a, b) => b.t - a.t);
  return dated[0]?.c ?? null;
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

console.log(`[diffcheck] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
