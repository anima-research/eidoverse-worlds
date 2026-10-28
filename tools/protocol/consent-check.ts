// consent tool: names from the wire never reach a plain object's prototype (security pass 2, H-0); a refused change
// changes nothing; every retired argument says where to go (R 10-28: two gates, two lists)
import { setConsent, decide } from "../../shared/protocol/consent.js";
let fails = 0; const ok = (c: boolean, n: string, d: any = "") => { console.log((c ? "ok   " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) fails++; };
const P: any = {};
for (const op of ["allow", "block", "unlist"]) for (const who of ["__proto__", "constructor", "prototype"]) {
  const r = setConsent(P, "u-attacker", { [op]: who });
  ok(r.ok === false, `C1 ${op} '${who}' is refused (not a person)`, r);
}
ok(typeof Object.prototype.toString === "function" && !Object.getOwnPropertyNames(Object.prototype).some((k) => /^(true|allow|block)$/.test(k)), "C3 Object.prototype is untouched", Object.getOwnPropertyNames(Object.prototype));
const r3 = setConsent(P, "u-alice", { block: "u-bbbbbbbbbbbbbbbbbbbb" });
ok(r3.ok === true && Object.getPrototypeOf(P.consent["u-alice"].block) === null && Object.getPrototypeOf(P.consent["u-alice"]) === null, "C4 a real block works, on prototype-less tables", r3);
ok(decide(P, "u-bbbbbbbbbbbbbbbbbbbb", "u-alice", "shove").mode === "deny", "C5 …and is honoured (move's default is on)");
// C6: every retired argument (the switch and its asks, 10-28; the table before it, 10-20) is refused, says where to go, and changes nothing
{ const Q: any = {}; const A = "u-aaaaaaaaaaaaaaaaaaaa";
  for (const [k, v] of [["switch", "refuse"], ["deny", "u-bbbbbbbbbbbbbbbbbbbb"], ["class", "touch"], ["for", 60000], ["answer", "ask-1"], ["yes", true], ["preset", "open"], ["set", { class: "touch", tier: "everyone", mode: "allow" }], ["pause", true], ["friend", "u-bbbbbbbbbbbbbbbbbbbb"], ["delegate", "u-bbbbbbbbbbbbbbbbbbbb"], ["of", A]] as const) {
    const r: any = setConsent(Q, A, { [k]: v });
    ok(r.ok === false && r.code === "shape" && /move/.test(r.fix ?? "") && /block/.test(r.fix ?? "") && !Q.consent?.[A], `C6 ${k} is retired: refused, pointing at the gates and lists, nothing written`, r); } }
// a refused change changes nothing: every argument is checked before any field is written
{ const Q: any = {}; const A = "u-aaaaaaaaaaaaaaaaaaaa", B = "u-bbbbbbbbbbbbbbbbbbbb";
  setConsent(Q, A, { move: true }); const before = JSON.stringify(Q.consent?.[A]);
  for (const a of [{ move: false, allow: "__proto__" }, { touch: true, move: "no" }, { move: false, allow: B, block: B }]) {
    const r = setConsent(Q, A, a);
    ok(r.ok === false && JSON.stringify(Q.consent?.[A]) === before, `C8 a refused change (${JSON.stringify(a)}) leaves the table as it was`, { r, table: Q.consent?.[A] }); } }
console.log(`[consent-check] ${fails ? fails + " failed" : "all pass"}`); process.exit(fails ? 1 : 0);
