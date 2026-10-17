// The editor's whole-world History must never show a refused attempt as something that happened (Commons parity audit:
// "refused acts print as done"); the authority records a refused write as an act whose body carries refused {code}.
import { worldHistoryRows, mergeHistory } from "../../client/lib/historyrows.js";
let fails = 0; const ok = (c: boolean, n: string, d: any = "") => { console.log((c ? "ok   " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) fails++; };
const nameOf = (id: string) => ({ "u-a": "Ann", "u-b": "Bob" } as any)[id] ?? id;
const entries = [
  { seq: 7, kind: "act", actor: "u-a", verb: "set", ts: 1, body: { request: { id: "lamp", component: "light" } } },
  { seq: 8, kind: "change", actor: "u-a", verb: "set", ts: 1, cause: 7, body: {} },
  { seq: 9, kind: "act", actor: "u-b", verb: "delete", ts: 2, body: { request: { id: "lamp" }, refused: { code: "rights" } } },
  { seq: 10, kind: "say", actor: "u-b", verb: "say", ts: 3, body: { text: "hi" } },
];
const rows = worldHistoryRows(entries, nameOf);
ok(rows.length === 2, "H1 only acts are rows (state/say are not)", rows.map((r: any) => r.seq));
ok(rows[0].seq === 9 && rows[1].seq === 7, "H2 newest first", rows.map((r: any) => r.seq));
const refused = rows.find((r: any) => r.seq === 9);
ok(refused?.refused === "rights", "H3 a refused attempt is marked refused, with its code", refused);
ok(/refused/.test(refused?.text ?? "") && /tried/.test(refused?.text ?? ""), "H4 …and reads as an attempt, not a deed", refused?.text);
const done = rows.find((r: any) => r.seq === 7);
ok(done && !done.refused && !/refused|tried/.test(done.text) && /Ann/.test(done.text) && /light/.test(done.text), "H5 a real act reads as done, with who and what", done?.text);
// a thing's History pages (client-check HT6, 10-17): a refresh of the newest page that lands after an Older… read keeps the
// older rows and the deeper cursor; one that lands before it is extended by it; a refresh that doesn't meet what was read
// starts over (no gap a cursor would skip)
{ const page = (hi: number, lo: number) => Array.from({ length: hi - lo + 1 }, (_, i) => ({ seq: hi - i }));
  const first = mergeHistory({ entries: [], next: null }, page(40, 21), 21, false);
  const older = mergeHistory(first, page(20, 1), null, true);
  const late = mergeHistory(older, page(45, 26), 26, false);   // 5 new acts, the refresh answered after Older…
  ok(late.entries.length === 45 && late.entries[0].seq === 45 && late.entries.at(-1).seq === 1 && late.next === null, "H6 a refresh landing after Older… keeps the older rows and the deeper cursor", [late.entries.length, late.next]);
  const early = mergeHistory(mergeHistory(first, page(45, 26), 26, false), page(20, 1), null, true);
  ok(early.entries.length === 45 && early.next === null, "H7 …and Older… landing after a refresh extends it", [early.entries.length, early.next]);
  const gap = mergeHistory(older, page(90, 71), 71, false);
  ok(gap.entries.length === 20 && gap.entries.at(-1).seq === 71 && gap.next === 71, "H8 a refresh that doesn't meet what was read starts over (its own cursor, no gap)", [gap.entries.length, gap.next]);
  const dup = mergeHistory(first, page(25, 15), 15, true);
  ok(new Set(dup.entries.map((e: any) => e.seq)).size === dup.entries.length, "H9 rows are unique by seq", dup.entries.length); }
console.log(`[history-rows-check] ${fails ? fails + " failed" : "all pass"}`); process.exit(fails ? 1 : 0);
