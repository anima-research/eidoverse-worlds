// gates-check — body consent as the owner chose it (R 10-28): two gates (move, touch), each on or off, and two lists
// (allow, block) that carve out around them. Order: block > allow > my gate for the class > the world's body-default for
// that gate > move on, touch off. A stored switch or table becomes gates and lists only ever NARROWER (migratePresence).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/gates-check.ts
import * as C from "../../shared/protocol/consent.js";
let pass = 0, fail = 0;
const check = (id: string, what: string, ok: boolean, got?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${id} ${what}${ok ? "" : "  " + JSON.stringify(got)}`); };
const P = (): any => ({ consent: Object.create(null) });
const set = (p: any, a: any) => C.setConsent(p, "me", a);
const d = (p: any, cls: string, wd?: unknown, from = "pal") => C.decide(p, from, "me", cls, wd).mode;
const MOVE = ["shove", "displace"], TOUCH = ["touch", "intimate", "pose"];
const all = (p: any, cs: string[], want: string, wd?: unknown) => cs.every((c) => d(p, c, wd) === want);
const modes = (p: any, wd?: unknown) => Object.fromEntries([...MOVE, ...TOUCH].map((c) => [c, d(p, c, wd)]));

// ---- G: the gates ----
{ const p = P(); check("G1", "nothing chosen, no world default: move on (shove, displace allowed), touch off (touch, intimate, pose refused)", all(p, MOVE, "allow") && all(p, TOUCH, "deny"), modes(p)); }
{ const p = P(); const r = set(p, { move: false }); check("G2", "move off refuses shove and displace, and nothing under touch changes", r.ok && all(p, MOVE, "deny") && all(p, TOUCH, "deny"), { r, m: modes(p) }); }
{ const p = P(); const r = set(p, { touch: true }); check("G3", "touch on allows touch, intimate and pose; move stays on", r.ok && all(p, TOUCH, "allow") && all(p, MOVE, "allow"), { r, m: modes(p) }); }
{ const p = P(); set(p, { move: false, touch: true }); check("G4", "pose is under touch, never move: move off and touch on allows a pose and refuses a shove", d(p, "pose") === "allow" && d(p, "shove") === "deny" && d(p, "displace") === "deny", modes(p)); }
{ const p = P(); set(p, { move: true, touch: false }); check("G5", "…and move on, touch off allows a drag (displace: carry, occupy too) and refuses a pose", d(p, "displace") === "allow" && d(p, "pose") === "deny", modes(p)); }
{ check("G6", "the gate of each enforced class, and nothing else: shove/displace → move, touch/intimate/pose → touch; drag, occupy and carry are displace", JSON.stringify(C.GATE_OF) === JSON.stringify({ shove: "move", displace: "move", touch: "touch", intimate: "touch", pose: "touch" }) && ["drag", "occupy", "carry"].every((k) => C.KIND_CLASS[k] === "displace") && C.KIND_CLASS.pose === "pose" && C.KIND_CLASS.anim === "pose", C.GATE_OF); }
// ---- L: the lists beat the gates, both ways, and block beats allow ----
{ const p = P(); set(p, { move: false, touch: false }); set(p, { allow: "pal" }); check("L1", "allow beats both gates off: every enforced class is yes for that person", all(p, [...MOVE, ...TOUCH], "allow") && d(p, "pose", undefined, "stranger") === "deny", modes(p)); }
{ const p = P(); set(p, { move: true, touch: true }); set(p, { block: "pal" }); check("L2", "block beats both gates on: every enforced class is no for that person, and others still yes", all(p, [...MOVE, ...TOUCH], "deny") && d(p, "pose", undefined, "stranger") === "allow", modes(p)); }
{ const p = P(); set(p, { allow: "pal" }); p.consent.me.block = Object.assign(Object.create(null), { pal: true });   // both, somehow (a hand-edited plane)
  check("L3", "block beats allow if a person is somehow on both", all(p, [...MOVE, ...TOUCH], "deny"), modes(p)); }
{ const p = P(); set(p, { allow: "pal" }); set(p, { block: "pal" }); const t = C.tableOf(p, "me");
  check("L4", "block takes them off allow (and allow off block): a person is on one list at a time", JSON.stringify(t.allow) === "[]" && JSON.stringify(t.block) === '["pal"]', t);
  set(p, { allow: "pal" }); const t2 = C.tableOf(p, "me"); check("L4b", "…and allow takes them off block", JSON.stringify(t2.allow) === '["pal"]' && JSON.stringify(t2.block) === "[]", t2); }
{ const p = P(); set(p, { block: "pal" }); const r = set(p, { unlist: "pal" }); check("L5", "unlist puts them back under the gates", r.ok && d(p, "shove") === "allow" && d(p, "pose") === "deny" && C.tableOf(p, "me").block.length === 0, modes(p)); }
{ const p = P(); set(p, { allow: "pal" }); check("L6", "a list answers a world default too: allow beats a world with both gates off", d(p, "pose", { move: false, touch: false }) === "allow"); }
// ---- W: the world's body-default is the gates' default; my own gate beats it ----
{ const p = P(); check("W1", "a world default {touch: true} opens touch for a body that never chose; move keeps its default", all(p, TOUCH, "allow", { touch: true }) && all(p, MOVE, "allow", { touch: true }), modes(p, { touch: true })); }
{ const p = P(); check("W2", "a world default {move: false} closes move for a body that never chose", all(p, MOVE, "deny", { move: false }) && all(p, TOUCH, "deny", { move: false }), modes(p, { move: false })); }
{ const p = P(); set(p, { touch: false }); check("W3", "my touch off beats a world default of touch on", all(p, TOUCH, "deny", { touch: true })); }
{ const p = P(); set(p, { move: true }); check("W4", "my move on beats a world default of move off", all(p, MOVE, "allow", { move: false })); }
{ const p: any = P(); p.bodyDefault = { move: false, touch: true }; check("W5", "the authority's synced world default applies when the caller passes none", C.decide(p, "pal", "me", "shove").mode === "deny" && C.decide(p, "pal", "me", "pose").mode === "allow"); }
{ const g = ["refuse", "ask", "accept"].map((v) => C.worldGates(v)); check("W6", "a stored world default in the switch's words reads as a person's stored switch does: refuse and ask → both off, accept → move on (touch its default)", JSON.stringify(g) === JSON.stringify([{ move: false, touch: false }, { move: false, touch: false }, { move: true }]), g); }
// ---- R: the relay (server/messages.ts) reads the live @world.body-default, never a stale copy (review full-260 #1) ----
{ process.env.WORLDS_DIR ??= require("node:fs").mkdtempSync(require("node:os").tmpdir() + "/gates-relay-"); process.env.JOIN_TOKEN ??= "test-door";
  const { MESSAGES } = await import("../../server/messages.ts");
  const relay = (live: any, verb: string, msg: any) => { const got: string[] = [], err: string[] = [];
    const tc: any = { id: "bea", actorId: "u-bbbbbbbbbbbbbbbbbbbb", ws: { send: (s: string) => got.push(s) } };
    const c: any = { id: "al", actorId: "u-aaaaaaaaaaaaaaaaaaaa", world: { clients: new Set<any>(), log: { live, noteRefused: () => {} } } }; c.world.clients.add(c).add(tc);
    MESSAGES[verb]({ c, ws: { send: (s: string) => err.push(s) }, now: Date.now(), expel: () => {} } as any, { type: verb, targetActor: tc.actorId, ...msg }); return { got: got.length, err: err.length }; };
  const live = (bd: unknown, stale?: unknown) => ({ presence: { consent: Object.create(null), ...(stale !== undefined ? { bodyDefault: stale } : {}) }, state: () => ({ entities: { "@world": { c: bd === undefined ? {} : { "body-default": bd } } } }) });
  const a = relay(live({ move: false }), "puppet", { ragdoll: true }), b = relay(live({ move: false }), "bodydrag", { grab: { j: "hips" } });
  check("R1", "a fresh body-default {move: false}, no body verb since: a puppet knock-over and a bodydrag grab are refused, not forwarded", a.got === 0 && a.err === 1 && b.got === 0 && b.err === 1, { a, b });
  const e = relay(live(undefined, { touch: true }), "puppet", { anim: "wave" });
  check("R2", "a body-default removed since the last sync: the stale {touch: true} doesn't open a pose", e.got === 0 && e.err === 1, e);
  const f = relay(live({ move: true }), "puppet", { ragdoll: true });
  check("R3", "…and a world that leaves move on still forwards the knock-over", f.got === 1 && f.err === 0, f); }
// ---- S: the shape; only the owner ----
{ const p = P(); const r = set(p, { move: "yes" }); check("S1", "a gate is true or false; anything else is refused and changes nothing", !r.ok && r.code === "shape" && !p.consent.me, r); }
{ const p = P(); const bad = ["switch", "deny", "class", "for", "answer"].map((k) => set(p, { [k]: k === "switch" ? "refuse" : "pal" }));
  check("S2", "switch, deny, class, for and answer are retired: refused with the gates' pointer, nothing written", bad.every((r) => !r.ok && r.code === "shape" && /move/.test(r.fix ?? "") && /block/.test(r.fix ?? "")) && !p.consent.me, bad); }
{ const p = P(); const r = set(p, { allow: "pal", block: "kit" }); check("S3", "one list change at a time", !r.ok && !p.consent.me, r); }
{ const p = P(); const r = set(p, { block: "__proto__" }); check("S4", "a list names an identity (never a prototype key)", !r.ok && !(Object.prototype as any).true, r); }
{ const p = P(); const r = C.setConsent(p, "pal", { of: "me", move: false }); check("S5", "only the body's owner sets its gates (of is retired)", !r.ok && d(p, "shove") === "allow", r); }
// S6 (review 1.7): each list holds 1024 entries; the 1025th is refused with the limit and how to remove one; an entry for a thing or sponsor not here yet is taken
{ const p = P(); const r1 = Array.from({ length: 1024 }, (_, i) => set(p, { block: `u-${i}` })), over = set(p, { block: "u-1024" }), again = set(p, { block: "u-7" }), other = set(p, { allow: "script:t-later" }), sp = set(p, { allow: "scripts-by:u-later" }), keptOut = !C.tableOf(p, "me").block.includes("u-1024");
  const fit = (set(p, { unlist: "u-0" }), set(p, { block: "u-1024" }));
  check("S6", "a list's 1025th entry is refused (bounds, saying the limit and how to remove one), nothing written; re-listing one already there, the other list and a later entry once one is removed are taken; a script: or scripts-by: entry for a target not here yet is taken",
    r1.every((r) => r.ok) && !over.ok && over.code === "bounds" && /1024/.test(over.reason) && /unlist/.test(over.fix ?? "") && keptOut
    && again.ok && other.ok && sp.ok && fit.ok && C.tableOf(p, "me").block.length === 1024, { over, again: again.ok, other: other.ok, sp: sp.ok, fit, n: C.tableOf(p, "me").block.length }); }
// ---- M: a stored switch or table becomes gates and lists, only ever narrower ----
const mig = (consent: any) => { const p: any = { consent, consentShape: 3, asks: { a: 1 }, asked: { a: 1 }, askSeq: 3, cool: { k: 1 } }; C.migratePresence(p); return p; };
{ const p = mig({ me: { switch: "refuse" } }); check("M1", "a stored switch refuse → both gates off", p.consent.me.move === false && p.consent.me.touch === false && !("switch" in p.consent.me), p.consent.me); }
{ const p = mig({ me: { switch: "accept" } }); check("M2", "accept → move on, touch left to the world's default (off by default)", p.consent.me.move === true && p.consent.me.touch === undefined && d(p, "pose") === "deny" && d(p, "pose", { touch: true }) === "allow", p.consent.me); }
{ const p = mig({ me: { switch: "ask" } }); check("M3", "ask → both gates off (F3, R 10-28 16:02: ask was no until yes; a world default can't open either)", p.consent.me.move === false && p.consent.me.touch === false && d(p, "pose", { touch: true }) === "deny" && d(p, "shove", { move: true }) === "deny", p.consent.me); }
{ const full = { touch: { mode: "allow" }, intimate: { mode: "allow" }, pose: { mode: "allow" }, shove: { mode: "allow" }, move: { mode: "allow" } };   // move: displace's word to 10-17
  const p = mig({ me: { switch: "accept", over: { pal: full, kit: { pose: { mode: "allow" }, shove: { mode: "deny" } }, tim: { ...full, touch: { mode: "allow", until: 5 } } } } });
  const t = C.tableOf(p, "me"); check("M4", "per-person answers carry over: every enforced class allowed → allow, any denied → block (beats an allow), an allow with an end is dropped", JSON.stringify(t.allow) === '["pal"]' && JSON.stringify(t.block) === '["kit"]' && !("over" in p.consent.me), { t, raw: p.consent.me }); }
// M7–M9 (review F1, R 10-28 "opt-outs stay no"): allow grants every class, so only a row that already allowed every one becomes it
{ const p = mig({ me: { switch: "refuse", over: { bob: { touch: { mode: "allow" } } } } }); const t = C.tableOf(p, "me");
  check("M7", "a partial allow (touch only) is not allow-listed: under refuse Bob may not shove, drag, pose or touch", !t.allow.includes("bob") && !t.block.includes("bob") && ["shove", "displace", "pose", "intimate", "touch"].every((c) => d(p, c, undefined, "bob") === "deny"), { t, m: ["shove", "displace", "pose", "touch"].map((c) => d(p, c, undefined, "bob")) }); }
{ const p = mig({ me: { switch: "refuse", over: { bob: { touch: { mode: "allow" }, intimate: { mode: "allow" }, pose: { mode: "allow" }, shove: { mode: "allow" }, displace: { mode: "allow" } } } } }); const t = C.tableOf(p, "me");
  check("M8", "a full allow (every enforced class, no end) is allow-listed", JSON.stringify(t.allow) === '["bob"]' && ["shove", "displace", "pose"].every((c) => d(p, c, undefined, "bob") === "allow"), t); }
{ const full = Object.fromEntries(["near", "follow", "touch", "intimate", "pose", "shove", "displace", "voice"].map((c) => [c, { mode: "allow" }]));
  const paused = mig({ me: { preset: "normal", paused: true, over: { pal: full } } });
  const unpaused = mig({ me: { preset: "normal", paused: false, over: { pal: full } } });
  check("M11", "a paused stored table denies its standing full allowance; without pause it remains allowed",
    all(paused, [...MOVE, ...TOUCH], "deny") && !C.tableOf(paused, "me").allow.includes("pal")
    && all(unpaused, [...MOVE, ...TOUCH], "allow") && C.tableOf(unpaused, "me").allow.includes("pal"),
    { paused: paused.consent.me, unpaused: unpaused.consent.me }); }
{ const p = mig({ me: { switch: "accept", over: { bob: { touch: { mode: "allow" }, intimate: { mode: "allow" }, pose: { mode: "allow" }, shove: { mode: "allow" }, displace: { mode: "allow" }, voice: { mode: "deny" } } } } }); const t = C.tableOf(p, "me");
  check("M9", "a deny anywhere in the row (voice too) keeps them blocked, whatever else it allowed", JSON.stringify(t.block) === '["bob"]' && !t.allow.includes("bob") && d(p, "shove", undefined, "bob") === "deny", t); }
{ const p = mig({ me: { switch: "accept", over: { bob: { pose: { mode: "ask" } } } } }); const t = C.tableOf(p, "me");   // review full-260 L14
  check("M10", "a per-person ask (must ask first) becomes block, never may: under accept Bob may not pose or shove", JSON.stringify(t.block) === '["bob"]' && ["shove", "pose"].every((c) => d(p, c, undefined, "bob") === "deny"), t); }
{ const p = mig({ me: { cells: { strangers: { pose: "everyone" } }, friends: ["u-f"] }, eve: { preset: "open", cells: { everyone: { pose: "allow", shove: "allow", displace: "allow", touch: "allow", intimate: "allow" } }, paused: true } });
  check("M5", "a table from before the switch reads as the switch it became, then as gates: Normal's closed cells → both off; a pause → both off", p.consent.me.move === false && p.consent.me.touch === false && p.consent.eve.move === false && p.consent.eve.touch === false && !/cells|friends|preset|paused/.test(JSON.stringify(p.consent)), p.consent); }
{ const p = mig({ me: { switch: "refuse" } }); const once = JSON.stringify(p); C.migratePresence(p); set(p, { move: true });
  check("M6", "the asks, their cool-downs and rate are dropped, the plane is marked, and a second load changes nothing (a gate chosen since stays chosen)", !("asks" in p) && !("cool" in p) && !("asked" in p) && !("askSeq" in p) && p.consentShape === C.CONSENT_SHAPE && C.CONSENT_SHAPE === 4 && (C.migratePresence(p), p.consent.me.move === true) && JSON.parse(once).consent.me.move === false, p); }
// M12–M13 (#260, Stella item 2): "never wider" covers near, follow and voice too: an old no stays no after the migration
const UNG = ["near", "follow", "voice"], ung = (p: any, wd?: unknown, from = "pal") => UNG.map((c) => d(p, c, wd, from));
{ const paused = mig({ me: { preset: "normal", paused: true } }), refuse = mig({ me: { switch: "refuse" } }), ask = mig({ me: { switch: "ask" } }), accept = mig({ me: { switch: "accept" } });
  const open = mig({ me: { preset: "open", cells: { everyone: { pose: "allow", shove: "allow", displace: "allow", touch: "allow", intimate: "allow" } } } }), fresh = P();
  check("M12", "a paused table, a refuse or ask switch keep near, follow and voice deny after migration (kept in `closed`); accept, an untouched body and an open row's allows stay allow (open's follow ask → deny)",
    [paused, refuse, ask].every((p) => ung(p).every((m) => m === "deny") && all(p, [...MOVE, ...TOUCH], "deny")) && JSON.stringify(Object.keys(paused.consent.me.closed ?? {})) === JSON.stringify(UNG)
    && ung(accept).every((m) => m === "allow") && ung(fresh).every((m) => m === "allow") && JSON.stringify(ung(open)) === '["allow","deny","allow"]',
    { paused: ung(paused), refuse: ung(refuse), ask: ung(ask), accept: ung(accept), open: ung(open), closed: paused.consent.me.closed }); }
{ const p = P(); check("M13", "a world's stored body-default refuse or ask (the switch's words) keeps near, follow and voice deny; the gates' {move, touch} default leaves them allow",
    ung(p, "refuse").every((m) => m === "deny") && ung(p, "ask").every((m) => m === "deny") && ung(p, { move: true, touch: true }).every((m) => m === "allow") && ung(p, "accept").every((m) => m === "allow"),
    { refuse: ung(p, "refuse"), obj: ung(p, { move: true, touch: true }) }); }
console.log(`[gates-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
