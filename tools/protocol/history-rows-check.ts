// The editor's whole-world History must never show a refused attempt as something that happened (Commons parity audit:
// "refused acts print as done"); the authority records a refused write as an act whose body carries refused {code}.
import { worldHistoryRows } from "../../client/lib/historyrows.js";
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
console.log(`[history-rows-check] ${fails ? fails + " failed" : "all pass"}`); process.exit(fails ? 1 : 0);
