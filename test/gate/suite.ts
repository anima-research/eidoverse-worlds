// test/gate/suite.ts: the one scaffold a protocol suite counts its rows with: `ok   `/`FAIL ` lines, --only, the
// `[tag] N passed, M failed` summary run.ts reads, exit 1 on any fail. Usage: const { ok, check, done } = suite("x-check").
//   --only A1,B2   a row whose first word is a row id (A1, SH2, D6b) is printed and counted only if named (its case still
//                  executes unless the suite skips it with runs(id)); a row with no id always counts
//   --verbose      a passing row prints its detail too
//   RED=C5         red("C5") is true: a suite's documented self-mutation of one row
import fs from "node:fs";
const argv = process.argv.slice(2);
const at = argv.indexOf("--only");
export const only: string[] | null = at >= 0 ? (argv[at + 1] ?? "").split(",").filter(Boolean) : null;
// a row id is a capital, then capitals/digits (dash-joined groups allowed) with at least one digit, then an optional suffix: N1, SH2, D6b, H2-P1a, IM-I1
const ID = /^[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*\d[A-Za-z0-9-]*$/;
export const rowId = (what: string) => { const t = String(what).trimStart().split(/\s/)[0]?.replace(/[:,]$/, "") ?? ""; return ID.test(t) ? t : null; };
export const runs = (id: string) => !only || only.includes(id);
const verbose = argv.includes("--verbose");

export type Opts = { quiet?: boolean; cap?: number };   // quiet: print only the fails; cap: a detail's length
/** Why a POSIX file-mode row can't apply here, or null where modes exist. */
export const NO_MODES = process.platform === "win32" ? "Windows has no POSIX file modes (stat says 666 for any writable file); the file is only as private as its directory's ACL" : null;
export function suite(tag: string, o: Opts = {}) {
  let pass = 0, fail = 0, nas = 0;
  const cap = o.cap ?? 400;
  const fmt = (d: unknown) => (typeof d === "string" ? d : JSON.stringify(d) ?? String(d)).slice(0, cap);
  const tail = (d: unknown) => (d === undefined || d === "" ? "" : ` — ${fmt(d)}`);
  const ok = (cond: unknown, what: string, detail?: unknown): void => {
    const id = rowId(what); if (id && !runs(id)) return;
    if (cond) { pass++; if (verbose) console.log(`ok   ${what}${tail(detail)}`); else if (!o.quiet) console.log(`ok   ${what}`); }
    else { fail++; console.log(`FAIL ${what}${tail(detail)}`); }
  };
  /** A row that can't apply on this host: printed and counted as not applicable, never as a pass. */
  const na = (what: string, why: string): void => { const id = rowId(what); if (id && !runs(id)) return; nas++; console.log(`n/a  ${what} — ${why}`); };
  return {
    ok,
    check: (what: string, cond: unknown, detail?: unknown): void => ok(cond, what, detail),
    na,
    /** `file`'s POSIX mode is `want`; not applicable where there are no modes (NO_MODES). */
    mode: (what: string, file: string, want: number): void => {
      if (NO_MODES) return na(what, NO_MODES);
      const got = fs.statSync(file).mode & 0o777; ok(got === want, what, got.toString(8));
    },
    only, runs,
    red: (id: string) => (process.env.RED ?? "") === id,
    get pass() { return pass; }, get fail() { return fail; },
    // the summary line and the exit: 1 on any failed row, or when the suite says so (red: e.g. nothing was read)
    done(note = "", red = false): never {
      console.log(`[${tag}] ${pass} passed, ${fail} failed${nas ? `, ${nas} not applicable` : ""}${note}`);
      process.exit(fail || red ? 1 : 0);
    },
  };
}
