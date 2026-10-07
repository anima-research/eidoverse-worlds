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
ok(decide(P, "u-bbbbbbbbbbbbbbbbbbbb", "u-alice", "touch", now) !== "everyone", "C5 …and is honoured");
console.log(`[consent-check] ${fails ? fails + " failed" : "all pass"}`); process.exit(fails ? 1 : 0);
