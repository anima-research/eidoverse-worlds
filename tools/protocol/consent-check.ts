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
// pause is true or false: any other value is refused, from a delegate as from anyone
{ const Q: any = {}; const A = "u-aaaaaaaaaaaaaaaaaaaa", D = "u-dddddddddddddddddddd";
  setConsent(Q, A, { delegate: D }, now);
  for (const v of [0, "", null, false]) { setConsent(Q, A, { pause: true }, now); const r = setConsent(Q, D, { of: A, pause: v }, now);
    ok(r.ok === false && Q.consent[A].paused === true, `C6 pause: ${JSON.stringify(v)} is refused and the table stays paused`, { r, paused: Q.consent[A].paused }); } }
// an allow's for is a positive number of ms
{ const Q: any = {}; const A = "u-aaaaaaaaaaaaaaaaaaaa", B = "u-bbbbbbbbbbbbbbbbbbbb";
  for (const f of ["soon", -5, 0, "60000"]) { const r = setConsent(Q, A, { allow: B, class: "touch", for: f }, now);
    ok(r.ok === false && !Q.consent?.[A]?.over?.[B], `C7 allow for: ${JSON.stringify(f)} is refused`, { r, over: Q.consent?.[A]?.over }); } }
// a refused change changes nothing: every argument is checked before any field is written
{ const Q: any = {}; const A = "u-aaaaaaaaaaaaaaaaaaaa", B = "u-bbbbbbbbbbbbbbbbbbbb";
  const before = JSON.stringify(setConsent(Q, A, {}, now) && Q.consent?.[A]);
  const r = setConsent(Q, A, { pause: true, allow: B, class: "touch", friend: "not an identity" }, now);
  ok(r.ok === false && JSON.stringify(Q.consent?.[A]) === before, "C8 a refused change leaves the table as it was", { r, table: Q.consent?.[A] }); }
console.log(`[consent-check] ${fails ? fails + " failed" : "all pass"}`); process.exit(fails ? 1 : 0);
