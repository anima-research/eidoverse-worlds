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
// The version rules (sameVersionChanged, engine-check EN4) judge both, each walked back along first parents to the newest
// version that names one (see earlier). In a shallow clone they can only judge the history it has. The changelog rule (unacknowledged) judges both on
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

/** The files at one earlier version, parsed, for the changelog rule: {file: pin | null}, null where that revision's tree
 *  hasn't the path. A path in the tree must read as a pin: a blob git can't read (a partial clone lacks it), text that
 *  isn't JSON, or JSON null throws, naming the file and the revision (and git's own words), and is never counted as "no
 *  file then". The version rules read the same way about blobs, but leniently about JSON (readAt, through reader). */
export function load(root: string, rev: string, why: string, files: string[]) { return readAt(root, rev, why, files, false).was; }

/** load's work: {was, present}: present lists the files in the tree. With lenient (the version rules), text that isn't
 *  JSON and JSON null read as null: a file that names no version, which the walk passes. */
function readAt(root: string, rev: string, why: string, files: string[], lenient: boolean) {
  const at = `${rev.slice(0, 8)} (${why})`; const present: string[] = [];
  const was = Object.fromEntries(files.map((f) => {
    const ls = gitR(root, ["ls-tree", "--name-only", rev, "--", f]); if (!ls.ok) throw new Error(`pinhistory: can't list ${f} at ${at}: git: ${ls.err}`);
    if (!ls.out.trim()) return [f, null]; present.push(f);
    const t = gitR(root, ["show", `${rev}:${f}`]);
    if (!t.ok) throw new Error(`pinhistory: ${f} at ${at} is in its tree but can't be read: git: ${t.err}. A partial clone may lack the blob: fetch it (a full clone, or git fetch --refetch) and run again`);
    let v: any; try { v = JSON.parse(t.out); } catch (err: any) { if (lenient) return [f, null]; throw new Error(`pinhistory: ${f} at ${at} is not valid JSON (${err?.message ?? err}), so nothing can be judged from it`); }
    if (v == null) { if (lenient) return [f, null]; throw new Error(`pinhistory: ${f} at ${at} is JSON null, not a pin`); }
    return [f, v];
  }));
  return { was, present };
}

/** The version before the one a revision holds, along first parents: the parent of the newest commit (at or before rev)
 *  that changed the files, or null where there is none (the files' first version, a root commit, or a shallow clone's
 *  edge: a shallow clone judges only the history it has). A git log that fails (a commit it needs is gone) throws: it is
 *  never the end of history. */
function olderOf(root: string, rev: string, files: string[]) {
  const l = gitR(root, ["log", "--first-parent", "-n", "1", "--format=%H", rev, "--", ...files]); if (!l.ok) throw new Error(`pinhistory: can't walk ${files.join(", ")} back from ${rev.slice(0, 8)}: git: ${l.err}`);
  const c = l.out.trim(); if (!c) return null;
  return git(root, ["rev-parse", "--verify", "-q", `${c}^1`])?.trim() || null;
}

/** Load the chosen versions; a version where none of the files existed is left out, since a file's first version changes nothing. */
const loaded = (root: string, revs: { rev: string; why: string }[], files: string[]) =>
  revs.map(({ rev, why }) => ({ rev, why, was: load(root, rev, why, files) })).filter((o) => files.some((f) => o.was[f] != null));

/** A JSON object that isn't an array: the only shape that can name a version. */
const isObj = (x: any) => x != null && typeof x === "object" && !Array.isArray(x);

/** earlier()'s default sense of "names a version": a file that is an object with at least one key. (EN4 walks per digest instead: versionsChanged.) */
const namesAny = (files: string[]) => (was: Record<string, any>) => files.some((f) => isObj(was[f]) && Object.keys(was[f]).length > 0);

/** The version rules' walk. From `start` (the base, or the previous version), the newest version along first parents,
 *  start itself first, for which `names(was)` holds. Every version that names none is passed, whatever the reason: text
 *  that isn't JSON, JSON null, {}, [], the file absent (deleted, then re-added), or no version for the law asked about.
 *  The base is walked too: its history is main's, so walking it back to main's last version that names one judges what
 *  main receives. {hit: {rev, why, was} | null, unnamed: [revs passed whose tree held a file]}. It stops where the
 *  history does: the files' first version or a root commit (nothing to hold it to), or a shallow clone's edge (a shallow
 *  clone judges only the history it has; CI checks out full history). */
function walkFrom(root: string, start: string, why: string, files: string[], names: (was: Record<string, any>) => boolean, read: (rev: string, why: string) => any) {
  const unnamed: string[] = [], passed: string[] = []; let rev = start;
  for (;;) { const r = read(rev, why);
    if (names(r.was)) return { hit: { rev, why: passed.length ? `${why}, walked back past ${passed.join(", ")}, which don't hold what this walk looks for` : why, was: r.was }, unnamed };
    if (r.present.length) unnamed.push(rev); passed.push(rev.slice(0, 8));
    const older = olderOf(root, rev, files); if (!older) return { hit: null, unnamed }; rev = older; }
}

/** Each revision read once per rule (strictly about blobs; leniently about JSON: see load). */
const reader = (root: string, files: string[]) => { const seen = new Map<string, any>(); return (rev: string, why: string) => { if (!seen.has(rev)) seen.set(rev, readAt(root, rev, why, files, true)); return seen.get(rev); }; };

/** Walk each of revs (the base, the previous version) to the version that names one: {out: [{rev, why, was}] (deduplicated:
 *  the walks can meet), unnamed: [labels of the versions passed that held a file but named none]}. */
function walked(root: string, files: string[], revs: { rev: string; why: string }[], names: (was: Record<string, any>) => boolean, read: (rev: string, why: string) => any) {
  const out: { rev: string; why: string; was: Record<string, any> }[] = [], passed = new Set<string>();
  for (const { rev, why } of revs) { const w = walkFrom(root, rev, why, files, names, read); for (const u of w.unnamed) passed.add(u);
    if (w.hit && !out.some((x) => x.rev === w.hit!.rev)) out.push(w.hit); }
  return { out, unnamed: [...passed].map((r) => `${r.slice(0, 8)} (${files.join(", ")} there: not JSON, JSON null, or no version)`) };
}

/** The earlier versions to judge, walked for one `names` predicate: {base, prev, out: [{rev, why, was: {file: parsed|null}}], unnamed: [labels]}.
 *  Each of the base and the previous version is walked back to the newest version that names one (walkFrom), so no
 *  version that names none hides the one before it: a branch's conflict markers, a base of JSON null, a {} or [], a
 *  deletion and re-adding. What was passed is listed in unnamed, so a row can show "judged nothing, though a version named
 *  none" in its detail. `names` says what naming a version is (default: a file that
 *  is an object with a key). */
export function earlier(root: string, files: string[], readNow: (f: string) => string | null, argv?: string[], names = namesAny(files)) {
  const { base, prev, revs } = revisions(root, files, readNow, argv);
  return { base, prev, ...walked(root, files, revs, names, reader(root, files)) };
}

/** What a version rule judged, for its row's title: "<rev> (<why>), ..." plus any version that names none; "no earlier
 *  version" only when there was none at all. */
export const judgedText = (e: { out: { rev: string; why: string }[]; unnamed?: string[] }) =>
  [e.out.map((o) => `${o.rev.slice(0, 8)} (${o.why})`).join(", ") || (e.unnamed?.length ? "none" : "no earlier version"), ...(e.unnamed?.length ? [`naming no version: ${e.unnamed.join(", ")}`] : [])].join("; ");

/** A caught throw's words for a red row: pinhistory's own message as it is; anything else (a bug in a suite) with its
 *  stack; never empty, so `"threw" in r` and the message agree. */
export const reason = (err: any) => { const m = String(err?.message ?? err ?? ""); return (m.startsWith("pinhistory:") ? m : String(err?.stack || m)) || "a throw with no message"; };

/** A conformance file as it is now: {value, bad}: value null where it's missing (bad null), can't be read, or isn't JSON
 *  (bad says which, and why), so a suite can show a broken file as its red row rather than crash on it. */
export function parsedNow(file: string) {
  if (!fs.existsSync(file)) return { value: null, bad: null };
  let t: string; try { t = fs.readFileSync(file, "utf8"); } catch (err: any) { return { value: null, bad: `${file}: can't be read (${err?.message ?? err})` }; }
  try { return { value: JSON.parse(t), bad: null }; } catch (err: any) { return { value: null, bad: `${file}: not valid JSON (${err?.message ?? err})` }; }
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
 *  version, field}. Each law walks on its own (walkFrom): from the base and from the previous version, back to the newest
 *  version that names that law's version, past any that names none (not JSON, JSON null, {}, [], absent, or no version for
 *  this law). A law judged from nothing although some version named none (its history starts with no version: a new law,
 *  a new file's placeholder first commit) has nothing to hold it to: it is listed in `unheld`, for the green row's detail.
 *  In a shallow clone the rule can only judge the history it has. A reused version name (v1, then v2, then v1
 *  with other data) compares the newest v1-naming version only against the base and the previous one: a limit of this
 *  design. The file as it is now must parse, or this throws; so does an
 *  earlier blob git can't read, since what it named is unknown. Its callers, TRV and LWV, catch a throw as one red row. */
export function sameVersionChanged(root: string, file: string, readNow: (f: string) => string | null, laws: { law: string; versionOf: (x: any) => any; data: string[] }[], norm: (field: string, x: any) => any = (_f, x) => x, argv?: string[]) {
  const t = readNow(file); let now: any; try { now = t == null ? null : JSON.parse(t); } catch (err: any) { throw new Error(`pinhistory: ${file} as it is now is not valid JSON (${err?.message ?? err})`); }
  const { revs } = revisions(root, [file], readNow, argv); const read = reader(root, [file]);
  const j = (f: string, x: any) => JSON.stringify(norm(f, x));
  const out: { rev: string; law: string; version: string; field: string }[] = [], judged: string[] = [], unheld: string[] = [], unnamed = new Set<string>();
  for (const L of laws) { const w = walked(root, [file], revs, (was) => isObj(was[file]) && typeof L.versionOf(was[file]) === "string", read); w.unnamed.forEach((u) => unnamed.add(u));
    if (!w.out.length && w.unnamed.length) unheld.push(`${L.law}: ${judgedText(w)}`);
    for (const { rev, why, was } of w.out) { const label = `${rev.slice(0, 8)} (${why})`; if (!judged.includes(label)) judged.push(label);
      const v = L.versionOf(was[file]); if (!isObj(now) || v !== L.versionOf(now)) continue;
      for (const f of L.data) if (j(f, was[file][f]) !== j(f, now[f])) out.push({ rev: rev.slice(0, 8), law: L.law, version: v, field: f }); } }
  return { out, judged, unheld, unnamed: [...unnamed] };   // out first: TRV and LWV print the first 400 characters
}

/** EN4's rule, per digest, for a file of {engine version: {scenario: digest}}: "a version's digests never change under its
 *  name". Each (version, scenario) found now, or in the newest version at or behind the base or the previous version that
 *  holds any digest ({v1:{}} holds none), walks on its own (walkFrom), back to
 *  the newest version that holds that digest: a version left out for a commit, an empty version entry, a scenario left out,
 *  {}, JSON null, text that isn't JSON or an absent file holds none, so none of them hides the digest before it. Where the
 *  digest found differs from now's (or is gone now), it is changed. {out: [{rev, why}] (what was judged, for judgedText),
 *  unnamed: [labels], changed: [{rev, version, entry (that version's entry there), keys: [[scenario, digest there]]}]}. The
 *  file as it is now must parse, or this throws; so does an earlier blob git can't read. */
export function versionsChanged(root: string, file: string, readNow: (f: string) => string | null, argv?: string[]) {
  const t = readNow(file); let now: any; try { now = t == null ? null : JSON.parse(t); } catch (err: any) { throw new Error(`pinhistory: ${file} as it is now is not valid JSON (${err?.message ?? err})`); }
  const { revs } = revisions(root, [file], readNow, argv); const read = reader(root, [file]);
  const keys = new Map<string, [string, string]>(); const add = (o: any) => { if (isObj(o)) for (const [v, d] of Object.entries<any>(o)) if (isObj(d)) for (const sc of Object.keys(d)) keys.set(JSON.stringify([v, sc]), [v, sc]); };
  const holdsAny = (was: Record<string, any>) => isObj(was[file]) && Object.values<any>(was[file]).some((d) => isObj(d) && Object.values(d).some((x) => x != null));   // {v1:{}} holds none, as {} doesn't
  add(now); const whole = walked(root, [file], revs, holdsAny, read); for (const o of whole.out) add(o.was[file]);   // and from the newest version at or behind the base and the previous version that holds any digest: a digest gone now behind {} or a deletion is still found
  const out: { rev: string; why: string }[] = [], changed = new Map<string, { rev: string; version: string; entry: any; keys: [string, any][] }>();
  for (const [v, sc] of keys.values()) {
    const w = walked(root, [file], revs, (was) => isObj(was[file]) && isObj(was[file][v]) && was[file][v][sc] != null, read);
    for (const { rev, why, was } of w.out) { if (!out.some((o) => o.rev === rev && o.why === why)) out.push({ rev, why });
      const x = was[file][v][sc]; if (now?.[v]?.[sc] === x) continue;
      const g = changed.get(`${rev} ${v}`) ?? { rev, version: v, entry: was[file][v], keys: [] }; g.keys.push([sc, x]); changed.set(`${rev} ${v}`, g); } }
  return { out, unnamed: whole.unnamed, changed: [...changed.values()] };   // naming none: only a version whose whole file names none (not one that just lacks a key)
}
