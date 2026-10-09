// tools/protocol/nonumber-check.ts — the protocol's number is data, never a name (R 2026-10-07: "a version number isn't a
// name"). It lives in exactly one place: the log's genesis, `{dialect: "eidoverse-log", v: N}` (spec/PROTOCOL.md §2.4).
// Every file the repo tracks (code, tests, docs, fixtures, file names) is scanned, and the gate fails on the current
// protocol's number used as a name: `v` + the number as a word or a word's start (`vN`, `vN-log`, `vNid`), or as a
// camelCase part (`makeVNClient`, `asVN`), in a path or on any line.
// Not scanned, each with why:
//   - tools/protocol/import-v1/: the old-world importer, whose job is to say which protocol it translates FROM and TO;
//   - spec/history/: upstream's earlier protocol texts, kept verbatim as history;
//   - long base64 / hex runs (signatures, keys, lockfile integrity hashes): a run like `…hWhV…` is not a name.
// Other numbers aren't this gate's business: "v1" has nov1-check.ts, and IPv4 / a dependency's version / a format's
// own version (directory v2, blueprint v: 1) are not the protocol.
// usage: bun tools/protocol/nonumber-check.ts     (prints each offence as file:line; exit 1 if any)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "../..");
const N = "4";   // the current protocol number (the genesis `v`); spelled apart so this file doesn't name itself
// lines where the same spelling names something else: file → a pattern the line must match, and why
const UNRELATED = [
  ["server/keyfiles.ts", /^export const OLD_NAMES: Record/, "the one-time rename of a worlds dir's key files saved before the names pass names their old names (once, here)"],
  ["tools/protocol/scale-check.ts", /^const \w+ = await imp1\(/, "--tree <an older checkout>: the first path that loads, today's or the base commit's own (before the names pass)"],
  ["tools/protocol/authority-check.ts", new RegExp(`"V${N} a component set`), "a check id in the V series (V1, V2, …)"],
  ["tools/protocol/roles-check.ts", new RegExp(`\\["V${N}"\\]|id: "V${N}"`), "a check id in the V series (V1, V2, …)"]];
const EXEMPT = [["tools/protocol/import-v1/", "the old-world importer names the protocols it translates between"],
  ["spec/history/", "upstream's earlier protocol texts, verbatim"]];
// a word-start v/V + N not followed by another digit; or a camelCase part (lowercase, then V + N)
// (a dotted number after it, `vN.4` or `vN.4.2`, is some tool's release, not the protocol)
const NAME = new RegExp(`(?<![A-Za-z0-9])[vV]${N}(?![0-9]|\\.[0-9])|(?<=[a-z])V${N}(?![0-9])`);
// signatures, keys and integrity hashes: one unbroken run of 20+ base64/hex characters with no word separator in it
const OPAQUE = /[A-Za-z0-9+/=]{20,}/g;
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0").filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f)));
const offences = [];
const exempt = (rel) => EXEMPT.some(([p]) => rel.startsWith(p));
for (const rel of files) {
  if (exempt(rel)) continue;
  if (NAME.test(rel)) offences.push(`${rel}  the file's path carries the number`);
  const p = path.join(ROOT, rel);
  if (fs.statSync(p).isDirectory()) continue;
  const buf = fs.readFileSync(p);
  if (buf.subarray(0, 8192).includes(0)) continue;   // binary
  buf.toString("utf8").split("\n").forEach((line, i) => {
    const bare = line.replace(OPAQUE, (m) => (/[0-9]/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m) ? " " : m));
    if (NAME.test(bare) && !UNRELATED.some(([f, re]) => rel === f && re.test(line))) offences.push(`${rel}:${i + 1}  ${line.trim().slice(0, 120)}`);
  });
}
for (const o of offences) console.log("  " + o);
console.log(`[nonumber-check] ${offences.length ? `${offences.length} offence(s): the protocol's number used as a name` : "the protocol's number appears only as data (genesis {dialect, v}); no name carries it"}`);
process.exit(offences.length ? 1 : 0);
