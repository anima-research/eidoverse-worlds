// readHistory — the pages are the same, the re-join is cheap.
//
//   bun tools/readhistory-test.ts
//
// Every browser re-join sends `history {after: lastSeq, limit: 40}` (chat.js
// resyncChatAfter). After a short drop fewer than 40 says follow lastSeq, so
// the memory leg comes up short and the file leg used to read and parse the
// WHOLE log back to genesis — its scan stopped only at `limit` (review of
// #243: 74–162 ms of synchronous sequencer time on a 200k-entry log, sent by
// every client at once after a restart). Pinned here: (a) when `after` is at
// or past the last fold, memory holds every entry after it and the file is
// not read; (b) the log is in seq order, so the backward scan stops at the
// first entry at or below `after`; and every page is the same as before.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ew-readhistory-"));
process.env.WORLDS_DIR = join(tmp, "worlds");
mkdirSync(process.env.WORLDS_DIR, { recursive: true });
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};

const { WorldLog } = await import("../server/world.ts");
const wl: any = new WorldLog("hist");
// genesis is seq 0. 3000 entries, every third a say; fold at 2000, so seqs
// 2001–3000 are in memory and 0–2000 only in the file.
for (let i = 1; i <= 2000; i++) wl.append(i % 3 ? "mover" : "talker", i % 3 ? "place" : "say", { i });
wl.fold("test");
for (let i = 2001; i <= 3000; i++) wl.append(i % 3 ? "mover" : "talker", i % 3 ? "place" : "say", { i });
check("precondition: folded at 2000, the tail in memory", wl.snapSeq === 2000 && wl.entries.length === 1000,
  `snapSeq ${wl.snapSeq}, ${wl.entries.length} in memory`);

// the contract, from first principles: the NEWEST `limit` matching entries
// strictly between after and before, handed back in world order
const truth: { seq: number; verb: string }[] = [{ seq: 0, verb: "genesis" }];
for (let i = 1; i <= 3000; i++) truth.push({ seq: i, verb: i % 3 ? "place" : "say" });
const expect = (before: number, after: number, limit: number, verbs: Set<string> | null) => {
  const m = truth.filter((e) => e.seq < before && e.seq > after && (!verbs || verbs.has(e.verb)));
  return m.slice(Math.max(0, m.length - limit)).map((e) => e.seq);
};

// count lines parsed: the file leg JSON.parses one line per step of its scan
const realParse = JSON.parse;
let parsed = 0;
const call = (opts: any) => {
  parsed = 0;
  JSON.parse = ((...a: any[]) => { parsed++; return (realParse as any)(...a); }) as typeof JSON.parse;
  try { return wl.readHistory(opts); } finally { JSON.parse = realParse; }
};

console.log("\nevery page is what it was");
{
  const says = new Set(["say"]);
  let bad: string[] = [];
  const cases: [number, number, number, Set<string> | null][] = [];
  for (const before of [Infinity, 3001, 2600, 2001, 2000, 1500, 40, 1])
    for (const after of [-Infinity, -1, 0, 100, 1990, 1999, 2000, 2001, 2500, 2999, 3000])
      for (const limit of [1, 40, 50, 5000])
        for (const verbs of [null, says]) cases.push([before, after, limit, verbs]);
  for (const [before, after, limit, verbs] of cases) {
    const r = call({ before, after, limit, verbs });
    const got = r.entries.map((e: any) => e.seq);
    const want = expect(before, after, limit, verbs);
    const oldest = want.length ? want[0] : null;
    if (got.join() !== want.join() || r.oldestSeq !== oldest || r.hasMore !== (oldest !== null && oldest > 0))
      bad.push(`before=${before} after=${after} limit=${limit} verbs=${verbs ? "say" : "*"}: got ${got.length} [${got.slice(0, 3)}…], want ${want.length} [${want.slice(0, 3)}…]`);
  }
  check(`${cases.length} pages match the contract`, !bad.length, bad.slice(0, 3).join("; "));
}

console.log("\na re-join's resync does not read the log");
{
  // a short drop: 10 says follow lastSeq, all in memory
  const r = call({ after: 2970, limit: 40, verbs: new Set(["say"]) });
  check("after past the fold: the 10 says came back", r.entries.length === 10, `${r.entries.length}`);
  check("…without parsing the file", parsed === 0, `${parsed} lines parsed`);
  const r2 = call({ after: 2000, limit: 40, verbs: new Set(["say"]) });
  check("after exactly at the fold: memory has it all, nothing parsed",
    r2.entries.length === 40 && parsed === 0, `${r2.entries.length} entries, ${parsed} parsed`);
  // reaching back across the fold: the file leg runs, but only back to `after`
  const r3 = call({ after: 1990, limit: 400, verbs: new Set(["say"]) });
  check("across the fold: says from both legs", r3.entries.length === 337 && r3.entries[0].seq === 1992,
    `${r3.entries.length}, first ${r3.entries[0]?.seq}`);
  check("…and the scan stops at `after`, not at genesis", parsed <= 1100, `${parsed} lines parsed of 3001`);
  call({ before: 1500, limit: 40 });
  check("a backward page still reads the file", parsed > 0 && parsed < 3001, `${parsed} parsed`);
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
