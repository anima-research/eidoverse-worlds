// tools/protocol/pinhistory.ts — a pinned file's history in git, for rows that hold a rule against the record and not just
// against the live code. A pin edited together with the code it pins agrees with the code, so a row comparing the two can't
// see the break; only the pin's earlier version can. Shared by pretrans-check (registry-pin.json), normative-check
// (refusal-codes.json, readback.json) and the conformance files' version rule (engine-check, trig-check, laws-check).
//
// Two earlier versions are judged:
//   the base's: --base <rev> or PIN_BASE, else where this branch left origin/main (git merge-base), else (a shallow or foreign
//     checkout with no origin/main) the previous version below. A file new since the base has no base version.
//   the previous version: the file as it was before its newest change (the working tree's, if uncommitted; else the commit
//     before the newest commit that changed it, along first parents), which is how kernel-check finds its base. This holds
//     a branch that brought the file new: its latest change is judged even though the base never had it.
// @ts-nocheck
import { spawnSync } from "node:child_process";

const git = (root: string, args: string[]) => { const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 1 << 28 }); return r.status === 0 ? r.stdout : null; };
/** A file at a commit, or null where it didn't exist (or there's no git). */
export const showAt = (root: string, rev: string, file: string) => git(root, ["show", `${rev}:${file}`]);

/** The base commit (full sha), or null where there's no origin/main and no asked base. */
export function baseOf(root: string, argv: string[] = process.argv.slice(2)) {
  const i = argv.indexOf("--base"); const asked = i >= 0 ? argv[i + 1] : process.env.PIN_BASE;
  if (asked) return git(root, ["rev-parse", "--verify", `${asked}^{commit}`])?.trim() || null;
  return git(root, ["merge-base", "HEAD", "origin/main"])?.trim() || null;
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

/** The earlier versions to judge: [{rev, why, was: {file: parsed|null}}], the base's and the previous one (deduplicated;
 *  an earlier version where none of the files existed is left out, since a file's first version changes nothing). */
export function earlier(root: string, files: string[], readNow: (f: string) => string | null, argv?: string[]) {
  const base = baseOf(root, argv); const prev = previousOf(root, files, readNow, argv);
  const out: { rev: string; why: string; was: Record<string, any> }[] = [];
  for (const [rev, why] of [[base, "the base"], [prev, "the previous version"]] as const) {
    if (!rev || out.some((o) => o.rev === rev)) continue;
    const was = Object.fromEntries(files.map((f) => { const t = showAt(root, rev, f); return [f, t == null ? null : JSON.parse(t)]; }));
    if (files.some((f) => was[f] != null)) out.push({ rev, why, was });
  }
  return { base, prev, out };
}

/** The breaks no changelog line acknowledges: for each earlier version, `breaksOf(was, now)` (texts), each of which must be a
 *  `  - <text>` line `changelog` gained since that version's commit. {judged: [rev why], out: [{rev, text}]}; out [] = held. */
export function unacknowledged(root: string, files: string[], changelog: string, readNow: (f: string) => string | null, breaksOf: (was: Record<string, any>, now: Record<string, any>) => string[], argv?: string[]) {
  const now = Object.fromEntries(files.map((f) => { const t = readNow(f); return [f, t == null ? null : JSON.parse(t)]; }));
  const e = earlier(root, files, readNow, argv); const out: { rev: string; text: string }[] = [];
  for (const { rev, was } of e.out) {
    const said = new Set(addedSince(root, rev, changelog).map((l) => l.trim()));
    for (const t of breaksOf(was, now)) if (!said.has(`- ${t}`)) out.push({ rev: rev.slice(0, 8), text: t });
  }
  return { judged: e.out.map((o) => `${o.rev.slice(0, 8)} (${o.why})`), base: e.base?.slice(0, 8) ?? null, out };
}

/** "A change meant to alter results is a new version" (the conformance files): for each law {law, versionOf, data} of a vector
 *  file, an earlier version of the file (the base's, the previous) whose versionOf(file) is the same string as now's must pin
 *  the same output in `data` (compared through `norm`, so a relabelled row is the same output). Each offence: {rev, law,
 *  version, field}. An earlier file that names no version for a law is no version, so there is nothing to hold it to. */
export function sameVersionChanged(root: string, file: string, readNow: (f: string) => string | null, laws: { law: string; versionOf: (x: any) => any; data: string[] }[], norm: (field: string, x: any) => any = (_f, x) => x, argv?: string[]) {
  const t = readNow(file); const now = t == null ? null : JSON.parse(t); const e = earlier(root, [file], readNow, argv);
  const j = (f: string, x: any) => JSON.stringify(norm(f, x));
  const out: { rev: string; law: string; version: string; field: string }[] = [];
  for (const { rev, was } of e.out) { const w = was[file]; if (!w || !now) continue;
    for (const L of laws) { const v = L.versionOf(w); if (typeof v !== "string" || v !== L.versionOf(now)) continue;
      for (const f of L.data) if (j(f, w[f]) !== j(f, now[f])) out.push({ rev: rev.slice(0, 8), law: L.law, version: v, field: f }); } }
  return { judged: e.out.map((o) => `${o.rev.slice(0, 8)} (${o.why})`), out };
}
