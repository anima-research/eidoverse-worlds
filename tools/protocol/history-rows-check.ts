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
// a thing's History pages (client-check HT4-HT6, 10-17), against REAL authority replies: a scratch world, a thing with a few
// acts and then 25 label sets, read as the panel reads it (history {id, limit: 20, before?}); the panel's merge on top
{ const { scratchWorld } = await import("./scratchworld.ts");
  const W = scratchWorld("histpages");
  const mk = W.call("create", { model: "crate" }); const id = mk.refs[0].id;
  W.call("set", { id, component: "pivot", value: { pos: [0.5, 0, 0] } });
  const mo = W.call("set", { id, component: "motion", value: { type: "pendulum", axis: [0, 0, 1], amp: 0.1, period: 3 } }); if (!mo.ok) throw new Error("motion: " + JSON.stringify(mo.refused)); W.call("delete", { id, component: "motion" });
  const H = (before?: number) => W.call("history", { id, limit: 20, ...(before != null ? { before } : {}) });
  const r0 = H();
  // the panel re-reads its newest page after every change: so do we, merging each answer as the panel does
  let st = mergeHistory({ entries: [], next: null, paged: false }, r0.entries, r0.next ?? null, false);
  for (let k = 0; k < 25; k++) { W.call("set", { id, component: "label", value: `pt ${k}` }); const rk = H(); st = mergeHistory(st, rk.entries, rk.next ?? null, false); }
  const r1 = H(), r2 = H(r1.next);
  // no row lost or fused: each label row's from-value is the to-value of the label row below it (the first set reads 'set "pt 0"')
  const to = (d: string) => (d.includes(" → ") ? d.split(" → ")[1] : d.replace(/^set /, ""));
  const chain = (rows: any[]) => { const L = rows.filter((e) => e.diff?.label); return L.every((e, i) => i === L.length - 1 || !e.diff.label.includes(" → ") || e.diff.label.split(" → ")[0] === to(L[i + 1].diff.label)); };
  ok(r0.ok && r0.next == null && r1.entries.length === 20 && r1.next === r1.entries.at(-1).seq && r2.entries.every((e: any) => e.seq < r1.next) && /"pt 23" → "pt 24"/.test(r1.entries[0].diff?.label ?? ""),
    "H6 the reply: 20 rows newest first, next = the last row's seq, a before page holds seq < before, and a diff is the authority's against the whole log", [r0.next, r1.entries.length, r1.next, r1.entries[0].diff]);
  // (st: the panel after a refresh per set, r1 the same newest page)
  ok(st.entries.length === 20 && st.next === r1.next && !st.entries.some((e: any) => /motion/.test(JSON.stringify(e.changed))) && chain(st.entries),
    "H7 a refresh shows the newest page and its Older… cursor (the motion acts are a page down), every row its own act", [st.entries.length, st.next]);
  st = mergeHistory(st, r2.entries, r2.next ?? null, true);   // Older…
  W.call("set", { id, component: "label", value: "pt 25" }); const r3 = H();
  const late = mergeHistory(st, r3.entries, r3.next ?? null, false);   // a refresh answered after the Older… read
  ok(late.entries.some((e: any) => /motion/.test(JSON.stringify(e.changed))) && late.entries[0].seq === r3.entries[0].seq && new Set(late.entries.map((e: any) => e.seq)).size === late.entries.length && chain(late.entries) && late.next === st.next,
    "H8 Older… reaches the motion acts, and a refresh landing after it keeps them (and the deeper cursor), no row lost or fused", [late.entries.length, late.next, st.next, late.entries.some((e: any) => /motion/.test(JSON.stringify(e.changed))), late.entries[0].seq === r3.entries[0].seq, chain(late.entries), late.entries.slice(0, 3).map((e: any) => e.diff)]);
  const fresh = mergeHistory({ entries: [], next: null, paged: false }, r3.entries, r3.next ?? null, false);
  ok(fresh.entries.length === 20 && fresh.next === r3.next, "H9 without an Older… read, a refresh is the newest page alone", fresh.entries.length); }
console.log(`[history-rows-check] ${fails ? fails + " failed" : "all pass"}`); process.exit(fails ? 1 : 0);
