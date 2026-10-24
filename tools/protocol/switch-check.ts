// Recut A2 (#260, R 10-20 15:37): one switch per body — accept | ask | refuse. Order: a personal never (deny for one
// person) > my switch > the world's body-default > accept. Every kind of act on a body gets the same answer.
import * as C from "../../shared/protocol/consent.js";
let pass = 0, fail = 0;
const check = (id: string, what: string, ok: boolean, got?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${id} ${what}${ok ? "" : "  " + JSON.stringify(got)}`); };
const P = () => ({ consent: Object.create(null) });
const now = 1000;
const d = (p: any, cls: string, wd?: string) => C.decide(p, "pal", "me", cls, now, wd).mode;
{ const p = P(); check("W1", "nothing set, no world default: accept (permissive default)", ["touch", "pose", "shove", "displace"].every((c) => d(p, c) === "allow"), ["touch","pose","shove"].map((c) => d(p, c))); }
{ const p = P(); check("W2", "world body-default ask: every kind asks", ["touch", "pose", "shove", "displace"].every((c) => d(p, c, "ask") === "ask"), d(p, "shove", "ask")); }
{ const p = P(); const r = C.setConsent(p, "me", { switch: "refuse" }, now); check("W3", "my switch refuse beats a world default of accept", r.ok && d(p, "pose", "accept") === "deny", r); }
{ const p = P(); C.setConsent(p, "me", { switch: "accept" }, now); check("W4", "my switch accept beats a world default of refuse", d(p, "shove", "refuse") === "allow", d(p, "shove", "refuse")); }
{ const p = P(); C.setConsent(p, "me", { switch: "accept" }, now); C.setConsent(p, "me", { deny: "pal" }, now); check("W5", "a never for one person beats my accept", d(p, "touch") === "deny"); }
{ const p = P(); const r = C.setConsent(p, "me", { switch: "maybe" }, now); check("W6", "a switch outside accept|ask|refuse is refused and changes nothing", !r.ok && C.decide(p, "pal", "me", "pose", now).mode === "allow", r); }
{ const p = P(); const r = C.setConsent(p, "pal", { of: "me", switch: "accept" }, now); check("W7", "only the body's owner sets its switch", !r.ok, r); }
{ const p: any = P(); p.bodyDefault = "refuse"; check("W8", "the authority's synced world default applies when the caller passes none", C.decide(p, "pal", "me", "pose", now).mode === "deny"); }
console.log(`[switch-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
