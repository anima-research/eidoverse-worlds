// consent tool: names and classes from the wire never reach a plain object's prototype (security pass 2, H-0)
import { setConsent, decide } from "../../shared/protocol/consent.js";
let fails = 0; const ok = (c: boolean, n: string, d: any = "") => { console.log((c ? "ok   " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) fails++; };
const P: any = {}; const now = 1e12;
for (const who of ["__proto__", "constructor", "prototype"]) {
  const r = setConsent(P, "u-attacker", { deny: who, class: "toString" }, now);
  ok(r.ok === false, `C1 deny '${who}' is refused (not a person)`, r);
}
const r2 = setConsent(P, "u-attacker", { allow: "u-bbbbbbbbbbbbbbbbbbbb", class: "__proto__" }, now);
ok(r2.ok === false, "C2 an unknown class is refused", r2);
ok(typeof Object.prototype.toString === "function" && !Object.getOwnPropertyNames(Object.prototype).some((k) => /^(touch|toString)$/.test(k) && typeof (Object.prototype as any)[k] !== "function"), "C3 Object.prototype is untouched (toString is still a function)", typeof Object.prototype.toString);
const r3 = setConsent(P, "u-alice", { deny: "u-bbbbbbbbbbbbbbbbbbbb", class: "touch" }, now);
ok(r3.ok === true && Object.getPrototypeOf(P.consent["u-alice"].over) === null, "C4 a real deny still works, on a prototype-less table", r3);
ok(decide(P, "u-bbbbbbbbbbbbbbbbbbbb", "u-alice", "touch", now) .mode === "deny", "C5 …and is honoured");
// C6 (recut A2): every retired table argument is refused, says where to go, and changes nothing
{ const Q: any = {}; const A = "u-aaaaaaaaaaaaaaaaaaaa";
  for (const [k, v] of [["preset", "open"], ["set", { class: "touch", tier: "everyone", mode: "allow" }], ["pause", true], ["friend", "u-bbbbbbbbbbbbbbbbbbbb"], ["delegate", "u-bbbbbbbbbbbbbbbbbbbb"], ["of", A]] as const) {
    const r: any = setConsent(Q, A, { [k]: v }, now);
    ok(r.ok === false && r.code === "shape" && /switch/.test(r.fix ?? "") && !Q.consent?.[A], `C6 ${k} is retired: refused, pointing at switch, nothing written`, r); } }
// an allow's for is a positive number of ms
{ const Q: any = {}; const A = "u-aaaaaaaaaaaaaaaaaaaa", B = "u-bbbbbbbbbbbbbbbbbbbb";
  for (const f of ["soon", -5, 0, "60000"]) { const r = setConsent(Q, A, { allow: B, class: "touch", for: f }, now);
    ok(r.ok === false && !Q.consent?.[A]?.over?.[B], `C7 allow for: ${JSON.stringify(f)} is refused`, { r, over: Q.consent?.[A]?.over }); } }
// a refused change changes nothing: every argument is checked before any field is written
{ const Q: any = {}; const A = "u-aaaaaaaaaaaaaaaaaaaa", B = "u-bbbbbbbbbbbbbbbbbbbb";
  const before = JSON.stringify(setConsent(Q, A, {}, now) && Q.consent?.[A]);
  const r = setConsent(Q, A, { switch: "refuse", allow: B, class: "nonsense" }, now);
  ok(r.ok === false && JSON.stringify(Q.consent?.[A]) === before, "C8 a refused change leaves the table as it was", { r, table: Q.consent?.[A] }); }
{ const Q: any = {}; const A = "u-aaaaaaaaaaaaaaaaaaaa", B = "u-bbbbbbbbbbbbbbbbbbbb", year = 365 * 24 * 3600000;
  // C9 (R 10-20): an allow with no `for` stands until you revoke it, like a deny; a `for` of any length is honoured as named
  setConsent(Q, A, { allow: B, class: "touch" }, now); const o = Q.consent?.[A]?.over?.[B]?.touch;
  ok(o?.mode === "allow" && o.until === undefined, "C9 an allow with no `for` has no end (until you revoke it)", o);
  setConsent(Q, A, { allow: B, class: "pose", for: year }, now); const p = Q.consent?.[A]?.over?.[B]?.pose;
  ok(p?.until === now + year, "C9b an allow for a year lasts a year (no hidden cap)", p);
  setConsent(Q, A, { deny: B, class: "touch" }, now); const d = Q.consent?.[A]?.over?.[B]?.touch;
  ok(d?.mode === "deny" && d.until === undefined, "C9c revoking (deny) replaces the standing allow at once", d); }
console.log(`[consent-check] ${fails ? fails + " failed" : "all pass"}`); process.exit(fails ? 1 : 0);
