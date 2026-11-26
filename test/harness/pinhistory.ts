// test/harness/pinhistory.ts — a pinned file's history in git, for rows that hold a rule against the record and not just
// against the live code. A pin edited together with the code it pins agrees with the code, so a row comparing the two can't
// see the break; only the pin's earlier version can. Shared by pretrans-check (registry-pin.json), normative-check
// (refusal-codes.json, readback.json) and the conformance files' version rule (engine-check, trig-check, laws-check).
//
// Two earlier versions are judged:
//   the base's: --base <rev> or PIN_BASE, else where this branch left main (the newest merge-base with origin/anima/upstream
//     main), else (a shallow or foreign checkout with none of them) the previous version below. A file new since the base has no base version.
//   the previous version: the file as it was before its newest change (the working tree's, if uncommitted; else the commit
//     before the newest commit that changed it, along first parents), which is how kernel-check finds its base. This holds
//     a branch that brought the file new: its latest change is judged even though the base never had it.
// The version rules (sameVersionChanged, engine-check EN4) judge both. The changelog rule (unacknowledged) judges both on
// main itself (the base is HEAD), with no base, or with a base that isn't an ancestor of HEAD; on a branch whose base is
// an ancestor of HEAD it judges only the base (see unacknowledged).
// @ts-nocheck
import fs from "node:fs";
import { spawnSync } from "node:child_process";

/** git's answer with its exit status and its own words on stderr, for the callers that report a failure. */
const gitR = (root: string, args: string[]) => { const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  return { ok: r.status === 0, status: r.status, out: r.stdout ?? "", err: (r.stderr ?? "").trim() || r.error?.message || `exit ${r.status}` }; };
const git = (root: string, args: string[]) => { const r = gitR(root, args); return r.ok ? r.out : null; };
/** A file at a commit, or null where it didn't exist (or there's no git). */
export const showAt = (root: string, rev: string, file: string) => git(root, ["show", `${rev}:${file}`]);

/** The base commit (full sha), or null where no main ref (origin, anima, upstream) and no asked base. */
export function baseOf(root: string, argv: string[] = process.argv.slice(2)) {
  const i = argv.indexOf("--base"); const asked = i >= 0 ? argv[i + 1] : process.env.PIN_BASE;
  if (asked) return git(root, ["rev-parse", "--verify", `${asked}^{commit}`])?.trim() || null;
  return newestBase(root);
}

/** The NEWEST merge-base of HEAD with origin/anima/upstream main: a stale remote must not drag the base back (diffcheck shares it). */
export function newestBase(root: string) {
  const found = ["origin/main", "anima/main", "upstream/main"].map((ref) => git(root, ["merge-base", "HEAD", ref])?.trim()).filter(Boolean) as string[];
  const under = (a: string, b: string) => spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", a, b]).status === 0;   // a is in b's history
  return found.find((c) => found.every((o) => under(o, c))) ?? found[0] ?? null;   // the one the others lead to (timestamps can tie)
}

/** Where a branch's own history starts: HEAD, except under a CI checkout of a pull request, where HEAD is a merge commit
 *  whose first parent is the base (GitHub's pull_request ref). There the branch is the SECOND parent: walking first parents
 *  would walk the base's history, where a pin the branch brought never existed, and judge nothing. */
export function tipOf(root: string, argv: string[] = process.argv.slice(2)) {
  const second = git(root, ["rev-parse", "--verify", "-q", "HEAD^2"])?.trim(); if (!second) return "HEAD";
  const first = git(root, ["rev-parse", "--verify", "-q", "HEAD^1"])?.trim(); const base = baseOf(root, argv);
  return first && base && first === base ? second : "HEAD";
}

/** The commit holding the files' version before their current one (current = the working tree), or null (never changed). */
export function previousOf(root: string, files: string[], readNow: (f: string) => string | null, argv?: string[]) {
  const now = files.map(readNow); const same = (rev: string) => files.every((f, k) => showAt(root, rev, f) === now[k]);
  if (!same("HEAD")) return git(root, ["rev-parse", "HEAD"])?.trim() || null;
  for (const r of (git(root, ["log", "--first-parent", "--format=%H", tipOf(root, argv), "--", ...files]) ?? "").split("\n").filter(Boolean)) {
    const p = git(root, ["rev-parse", "--verify", "-q", `${r}^1`])?.trim(); if (!p) return null; if (!same(p)) return p; }
  return null;
}

/** The lines a file gained between a commit and the working tree (a removed line is not "added"). */
export function addedSince(root: string, rev: string, file: string) {
  const d = git(root, ["diff", "--no-color", "-U0", rev, "--", file]) ?? "";
  return d.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
}

/** The earlier versions that could be judged, chosen before any of them is read: [{rev, why}], the base's and the previous
 *  one (deduplicated). A rule picks among them first and loads only those it judges, so a version it doesn't judge (a
 *  branch's discarded pin, under the changelog rule on a branch) is never parsed. */
export function revisions(root: string, files: string[], readNow: (f: string) => string | null, argv?: string[]) {
  const base = baseOf(root, argv); const prev = previousOf(root, files, readNow, argv);
  const revs: { rev: string; why: string }[] = [];
  for (const [rev, why] of [[base, "the base"], [prev, "the previous version"]] as const) if (rev && !revs.some((o) => o.rev === rev)) revs.push({ rev, why });
  return { base, prev, revs };
}

/** The files at one earlier version, parsed: {file: pin | null}, null where that revision's tree hasn't the path. A blob
 *  git can't read (a partial clone lacks it) always throws, naming the file and the revision (and git's own words): what
 *  it said is unknown, so it is never counted as "no file then". Text that isn't JSON, or JSON null, throws under the
 *  changelog rule (a pin it judges must be a pin); with `noVersion` (the version rules) it reads as null, a file that
 *  names no version, which is what sameVersionChanged makes of it: a branch's committed conflict markers, fixed later,
 *  must not hold the fix red. */
export function load(root: string, rev: string, why: string, files: string[], noVersion = false) { return readAt(root, rev, why, files, noVersion).was; }

/** load's work, with the files (under noVersion) that are in the tree but name no version: {was, unnamed}. */
function readAt(root: string, rev: string, why: string, files: string[], noVersion: boolean) {
  const at = `${rev.slice(0, 8)} (${why})`; const unnamed: string[] = [];
  const was = Object.fromEntries(files.map((f) => {
    const ls = gitR(root, ["ls-tree", "--name-only", rev, "--", f]); if (!ls.ok) throw new Error(`pinhistory: can't list ${f} at ${at}: git: ${ls.err}`);
    if (!ls.out.trim()) return [f, null];
    const t = gitR(root, ["show", `${rev}:${f}`]);
    if (!t.ok) throw new Error(`pinhistory: ${f} at ${at} is in its tree but can't be read: git: ${t.err}. A partial clone may lack the blob: fetch it (a full clone, or git fetch --refetch) and run again`);
    let v: any; try { v = JSON.parse(t.out); } catch (err: any) { if (noVersion) { unnamed.push(f); return [f, null]; } throw new Error(`pinhistory: ${f} at ${at} is not valid JSON (${err?.message ?? err}), so nothing can be judged from it`); }
    if (v == null) { if (noVersion) { unnamed.push(f); return [f, null]; } throw new Error(`pinhistory: ${f} at ${at} is JSON null, not a pin`); }
    return [f, v];
  }));
  return { was, unnamed };
}

/** The version before the one a revision holds, along first parents: the parent of the newest commit (at or before rev)
 *  that changed the files, or null where that commit has no parent (the files' first version). */
function olderOf(root: string, rev: string, files: string[]) {
  const c = git(root, ["log", "--first-parent", "-n", "1", "--format=%H", rev, "--", ...files])?.trim(); if (!c) return null;
  return git(root, ["rev-parse", "--verify", "-q", `${c}^1`])?.trim() || null;
}

/** Load the chosen versions; a version where none of the files existed is left out, since a file's first version changes nothing. */
const loaded = (root: string, revs: { rev: string; why: string }[], files: string[], noVersion = false) =>
  revs.map(({ rev, why }) => ({ rev, why, was: load(root, rev, why, files, noVersion) })).filter((o) => files.some((f) => o.was[f] != null));

/** The earlier versions to judge, both of them loaded (the version rules'): {base, prev, out: [{rev, why, was: {file:
 *  parsed|null}}], unnamed: [labels]}. An earlier file that isn't JSON, or is JSON null, names no version (see load). It
 *  must not hide the version before it: with no base, or on main (the base is HEAD), the previous version is all that
 *  judges a change, so where it names none the walk goes on along first parents to the newest version that names one
 *  (a branch's conflict markers committed, then v1's data changed: the v1 before the markers judges it). A version that
 *  names none and has none behind it is listed in unnamed, so a row can say so rather than "no earlier version". */
export function earlier(root: string, files: string[], readNow: (f: string) => string | null, argv?: string[]) {
  const { base, prev, revs } = revisions(root, files, readNow, argv);
  const out: { rev: string; why: string; was: Record<string, any> }[] = [], unnamed: string[] = [];
  for (const o of revs) { let { rev, why } = o; let r = readAt(root, rev, why, files, true); const passed: string[] = [];
    if (why === "the previous version") while (r.unnamed.length) { const older = olderOf(root, rev, files); if (!older) break;
      passed.push(rev.slice(0, 8)); rev = older; r = readAt(root, rev, why, files, true); }
    if (passed.length && !r.unnamed.length) why = `the previous version that names one, before ${passed.join(", ")}`;
    if (r.unnamed.length) unnamed.push(`${rev.slice(0, 8)} (${why}: ${r.unnamed.join(", ")} not JSON, or JSON null)`);
    if (!out.some((x) => x.rev === rev) && files.some((f) => r.was[f] != null)) out.push({ rev, why, was: r.was }); }   // the walk can reach the base
  return { base, prev, out, unnamed };
}

/** What a version rule judged, for its row's title: "<rev> (<why>), ..." plus any version that names none; "no earlier
 *  version" only when there was none at all. */
export const judgedText = (e: { out: { rev: string; why: string }[]; unnamed?: string[] }) =>
  [e.out.map((o) => `${o.rev.slice(0, 8)} (${o.why})`).join(", ") || (e.unnamed?.length ? "none" : "no earlier version"), ...(e.unnamed?.length ? [`naming no version: ${e.unnamed.join(", ")}`] : [])].join("; ");

/** A caught throw's words for a red row: pinhistory's own message as it is; anything else (a bug in a suite) with its
 *  stack; never empty, so `"threw" in r` and the message agree. */
export const reason = (err: any) => { const m = String(err?.message ?? err ?? ""); return (m.startsWith("pinhistory:") ? m : String(err?.stack || m)) || "a throw with no message"; };

/** A conformance file as it is now: {value, bad}: value null where it's missing (bad null) or isn't JSON (bad says why),
 *  so a suite can show a broken file as its red row rather than crash on it. */
export function parsedNow(file: string) {
  if (!fs.existsSync(file)) return { value: null, bad: null };
  try { return { value: JSON.parse(fs.readFileSync(file, "utf8")), bad: null }; } catch (err: any) { return { value: null, bad: `${file}: not valid JSON (${err?.message ?? err})` }; }
}

/** On a branch: the base is an ancestor of HEAD and not HEAD itself. A git failure is a throw, never read as an answer. */
function onBranchOf(root: string, base: string) {
  const head = gitR(root, ["rev-parse", "HEAD"]); if (!head.ok) throw new Error(`pinhistory: can't read HEAD: git: ${head.err}`);
  if (head.out.trim() === base) return false;
  const a = gitR(root, ["merge-base", "--is-ancestor", base, "HEAD"]); if (a.status === 0) return true; if (a.status === 1) return false;
  throw new Error(`pinhistory: can't tell whether the base ${base.slice(0, 8)} is an ancestor of HEAD: git: ${a.err}`);
}

/** The breaks no changelog line acknowledges: for each earlier version judged, `breaksOf(was, now)` (texts), each of which
 *  must be a `  - <text>` line `changelog` gained since that version's commit. {judged: [rev why], out: [{rev, text}]}.
 *  Held is out [] AND judged non-empty: callers (D13, N10) refuse an empty judged as "judged nothing". The versions to
 *  judge are chosen first and only those are read (load), so a branch's discarded pin, even one that isn't JSON, plays no
 *  part; a version that is judged and holds a file that can't be read as a pin (a blob missing from a partial clone, text
 *  that isn't JSON, JSON null) throws, naming the file and the revision.
 *  On a branch (the base an ancestor of HEAD and not HEAD itself, as under CI's pull_request ref, where it is HEAD^1) only
 *  the base is judged: main only ever receives a branch's net change, and the base judges all of it. The previous version
 *  would judge states main never holds, and where main has the path it composes main's own steps since into breaks no
 *  line names (#363: main's light.decay A → B → C, a line each, judged from the branch's pre-merge pin as A → C).
 *  ASSUMPTIONS: a branch's intermediate steps are not judged, only what reaches main, so a stacked PR, or a staging server
 *  that keeps data across a branch's commits, is not protected by this rule. The base is the newest of the local
 *  origin/anima/upstream main refs, so a stale local main ref can make a local run wrong either way: lenient (a path main
 *  added since the stale ref is new to it, so a break of it goes unjudged) or falsely red (main's own acknowledged steps
 *  since the stale ref compose into a break no line names, as #363's did). CI's fresh fetch is authoritative.
 *  A base whose tree has none of the paths (the branch brings them new, #260) still counts as judged: nothing in main can
 *  break.
 *  On main itself (the base is HEAD), with no base, or with a --base / PIN_BASE that isn't an ancestor of HEAD, the
 *  previous version is judged too; on main that is main's newest pin-changing commit (a rebase-merge, or several commits
 *  pushed together, gets only its last one judged, as before). The version rules (sameVersionChanged, engine-check EN4)
 *  compare for equality under a version's name, where an older version can't compose into a false break; they judge
 *  both, as before. */
export function unacknowledged(root: string, files: string[], changelog: string, readNow: (f: string) => string | null, breaksOf: (was: Record<string, any>, now: Record<string, any>) => string[], argv?: string[]) {
  const now = Object.fromEntries(files.map((f) => { const t = readNow(f); return [f, t == null ? null : JSON.parse(t)]; }));
  const e = revisions(root, files, readNow, argv); const out: { rev: string; text: string }[] = [];
  const onBranch = !!e.base && onBranchOf(root, e.base);
  const judging = loaded(root, onBranch ? e.revs.filter((o) => o.why === "the base") : e.revs, files);   // chosen first, then read
  for (const { rev, was } of judging) {
    const said = new Set(addedSince(root, rev, changelog).map((l) => l.trim()));
    for (const t of breaksOf(was, now)) if (!said.has(`- ${t}`)) out.push({ rev: rev.slice(0, 8), text: t });
  }
  const judged = judging.map((o) => `${o.rev.slice(0, 8)} (${o.why})`);
  if (onBranch && !judging.length) judged.push(`${e.base!.slice(0, 8)} (the base, whose tree has none of these files: they are new)`);
  return { judged, base: e.base?.slice(0, 8) ?? null, out };
}

/** "A change meant to alter results is a new version" (the conformance files): for each law {law, versionOf, data} of a vector
 *  file, an earlier version of the file (the base's, the previous) whose versionOf(file) is the same string as now's must pin
 *  the same output in `data` (compared through `norm`, so a relabelled row is the same output). Each offence: {rev, law,
 *  version, field}. An earlier file that names no version for a law is no version, so there is nothing to hold it to; an
 *  earlier file that isn't JSON (or is JSON null) names none, and the walk in earlier passes it to the version before. The
 *  file as it is now must parse, or this throws; so does an
 *  earlier blob git can't read, since what it named is unknown. Callers catch a throw as one red row (TRV, LWV, EN4; N10). */
export function sameVersionChanged(root: string, file: string, readNow: (f: string) => string | null, laws: { law: string; versionOf: (x: any) => any; data: string[] }[], norm: (field: string, x: any) => any = (_f, x) => x, argv?: string[]) {
  const t = readNow(file); let now: any; try { now = t == null ? null : JSON.parse(t); } catch (err: any) { throw new Error(`pinhistory: ${file} as it is now is not valid JSON (${err?.message ?? err})`); }
  const e = earlier(root, [file], readNow, argv);
  const j = (f: string, x: any) => JSON.stringify(norm(f, x));
  const out: { rev: string; law: string; version: string; field: string }[] = [];
  for (const { rev, was } of e.out) { const w = was[file]; if (!w || !now) continue;
    for (const L of laws) { const v = L.versionOf(w); if (typeof v !== "string" || v !== L.versionOf(now)) continue;
      for (const f of L.data) if (j(f, w[f]) !== j(f, now[f])) out.push({ rev: rev.slice(0, 8), law: L.law, version: v, field: f }); } }
  return { judged: e.out.map((o) => `${o.rev.slice(0, 8)} (${o.why})`), unnamed: e.unnamed, out };
}
