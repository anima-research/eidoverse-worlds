// tools/protocol/authority-check.ts — slice 2's in-process checks (the server-level ones over a real WebSocket are
// server-check.ts). usage: bun tools/protocol/authority-check.ts
//   N   names.js: one encoding for actors, ids and components; the lab's `0abc` / `n0abc` collision is gone
//   T   the engine translator's own name, and the v1 fold build it stamps
//   P   locks (PROTOCOL §5): v1's matrix (tools/locktest.ts), ancestors, throughLock, the gameplay lock inside
//       its own component, and v1 lock/guard through the translator
//   U   the act index (undo, wait): equals a fresh build after every request; entityBefore equals the fold at every
//       seq; a later write, a purge and a new act each change undo's answer the way a full scan would
//   M   translated mounts in the authority's shape: where the authority sees a riding thing, place-on and overlap warnings
//   L   the live world (server/livehost.ts) equals a whole-log re-read after every request: state, sim, the id index
//   C   the engine catalogue's shape (an off-centre GLB box, measured surfaces) places things where they rest
//   X   the compatibility projection: the v1 verbs it sends, folded by the client's own fold, reproduce it
// @ts-nocheck
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { scratch } from "./common.ts";
import { request, isBanned, worldOf, creatorOf, liftWorld, maintain, LAB_CATALOGUE, actIndexOf, actIndexFresh, entityBefore, fixtureIds } from "../../shared/protocol/authority.js";
fixtureIds(true);   // the fixtures below seed the ids they read (R 10-17: a writer never chooses one; ids-check covers the refusal)
import { fold, readLog, digest, opsOf, PURGED } from "../../shared/protocol/fold.js";
import * as AUTH from "../../shared/protocol/authority.js";
// the operator's repair path; before it existed an operator had only the ordinary request (OP rows are red there, not a crash)
const operatorRepair = AUTH.operatorRepair ?? ((w, a, v, x) => request(w, a, v, x));
import { makeReplica, wireState, stateFromWire } from "../../shared/protocol/replica.js";
import { simFold, digestOf, restsOf } from "../../shared/protocol/simlayer.js";
import { MODELS } from "../../shared/protocol/labmodels.js";
import { enc, encName, dec } from "../../shared/protocol/names.js";
import { refusalText, lockVerb, lockQuestion, lockChoices } from "../../shared/protocol/refusal.js";
import { VERBSPEC } from "../../shared/protocol/verbspec.js";
import { custodyAt } from "../../server/custody.ts";
import { translate, TRANSLATOR } from "./import-v1/translate-v1.js";
import { openWorld } from "../../server/filehost.ts";
import { openLive } from "../../server/livehost.ts";
import { v1FoldBuild, v1FoldFiles } from "./import-v1/build.ts";
import { emptyState as v1Empty, foldEntry as v1fold } from "./import-v1/fold.js";
import { worldPose } from "../../shared/hierarchy.js";
import { viewState } from "../../shared/protocol/view.js";
import { worldPose as worldT } from "../../shared/protocol/simlayer.js";
import { labClock } from "./clock.ts";

const root = scratch("door");
// lab worlds name people by bare test names; the directory a real server has would know them (roles:<key> checks it)
const LABKIND = (_id: string) => "human";
let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const code = (r: any) => r?.refused?.code;
const clock = labClock();
const callAt = (world: string) => (actor, verb, args = {}) => { clock.advance(100); return request(openWorld(root, world), actor, verb, args); };

// a translation written into this server's worlds carries THIS door's keys: the authority refuses to sign for a world whose
// genesis names another sequencer (round-2 R5); filehost.ts keeps custody at <root>/keys/custody.json
const DOORKEYS = () => { const cu = custodyAt(root + "keys/custody.json"); return { key: cu.sequencer(), operator: cu.operator() }; };

// ---- N: names ----
ok(encName("0abc") !== encName("n0abc"), "N1 encName('0abc') and encName('n0abc') differ (the lab gave both 'n0abc')", [encName("0abc"), encName("n0abc")]);
ok(encName("n0abc") === "n0abc" && encName("0abc").startsWith("x--"), "N2 a valid component name is kept; an invalid one is always escaped", [encName("n0abc"), encName("0abc")]);
for (const s of ["Hesperus", "anon-3", "x--41", "h--zz", "é☃", "0abc", "a".repeat(64), "a".repeat(65), "Marigold Thorne", "__proto__"])
  ok(dec(enc(s)) === s || (enc(s).startsWith("h--") && dec(enc(s)) === null), `N3 dec(enc(${JSON.stringify(s).slice(0, 20)})) gives it back (or says it was hashed)`, [enc(s), dec(enc(s))]);
// N3b: an id the view can't decode (h--, a hash) is what the reader holds and sends back: encoding it again must give it
// unchanged, or a thing with a long imported name can't be addressed from what the view shows
{ const long = "Ω".repeat(40), id = enc(long);
  ok(id.startsWith("h--") && enc(id) === id && encName(encName("Ω".repeat(40))) === encName("Ω".repeat(40)) && enc("h--zz") !== "h--zz" && enc("h--" + "a".repeat(60)) !== "h--" + "a".repeat(60),
    "N3b enc keeps a hashed id (h-- and 61 hex) as it is; other h--/x-- spellings are still escaped", [id, enc(id)]); }
{ const seen = new Map(); let clash = null;
  for (let i = 0; i < 3000 && !clash; i++) { const s = (i % 3 ? String.fromCharCode(48 + (i % 75)) : "x--") + i.toString(36) + (i % 7 ? "" : "Z");
    for (const f of [enc, encName]) { const k = `${f.name}:${f(s)}`; if (seen.has(k) && seen.get(k) !== s) clash = [s, seen.get(k), f(s)]; seen.set(k, s); } }
  ok(!clash, "N4 enc and encName are injective on 3,000 awkward names", clash); }
ok(enc("anon-3") === "anon-3" && enc("Marigold").startsWith("x--"), "N5 identities: the grammar's own names pass, others are escaped");

// ---- T: the translator's name and stamp ----
ok(TRANSLATOR !== "translate-v1@0.3" && /^eidoverse\//.test(TRANSLATOR), "T1 the engine translator has its own name (not the lab's)", TRANSLATOR);
{ const old = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log", roles: { Marigold: { role: "owner" } } } },
    { seq: 1, ts: 2, actor: "Marigold", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [1, 0, 1] } },
    { seq: 2, ts: 3, actor: "Marigold", verb: "comp", args: { id: "lamp_1", type: "0abc", data: 1 } },
    { seq: 3, ts: 4, actor: "Marigold", verb: "comp", args: { id: "lamp_1", type: "n0abc", data: 2 } }];
  const r = translate(old, { foldBuild: v1FoldBuild() });
  ok(r.out[1].verb === "translated" && r.out[1].body.from.translator === TRANSLATOR && r.out[1].body.from.fold === v1FoldBuild() && r.out[0].body.minor === 0, "T2 the act after genesis names the translator and the v1 fold build", r.out[1].body);
  const c = r.final.translated[enc("lamp_1")];
  ok(c && c["imported/n0abc"] === 2 && c[`imported/${encName("0abc")}`] === 1 && !r.stats.divergences, "T3 a translated world keeps comps '0abc' and 'n0abc' apart (each under the imported namespace: bare names are the registry's, PROTOCOL §4)", c);
  ok(JSON.stringify(r.out[0].body.owners) === JSON.stringify([[], [r.out[0].body.sequencer]]) && r.out[1].body.from.roles?.Marigold?.role === "owner" && !r.final.translated["@world"]?.[`roles:${enc("Marigold")}`], "T4 genesis is custodial (tier 0 empty, the authority's key in tier 1); v1 genesis roles, which v1 never folds, are kept verbatim in the translated act and grant nothing", [r.out[0].body.owners, r.out[1].body.from])
  ok(v1FoldFiles().includes("tools/protocol/import-v1/fold.js") && v1FoldFiles().length >= 5 && /^[0-9a-f]{16}$/.test(v1FoldBuild()), "T5 the fold build covers the importer's v1 fold and its imports", v1FoldFiles()); }

// ---- P: locks (PROTOCOL §5), mirroring v1's lock matrix (tools/locktest.ts) plus what the protocol adds ----
// v1: a lock refuses everything that would MOVE, REPLACE or REMOVE the thing, for everyone, its locker included;
// everything that doesn't relocate it stays open (sit, use, motion, other comps); any builder may unlock. The protocol adds:
// it binds what's attached to it too; throughLock: true lets whoever may remove it act through it.
{ const name = "locks";
  const call = callAt(name);
  const W = () => openWorld(root, name);
  call("olive", "create-world", { title: "locks" });
  call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "inhabitant" } });
  call("olive", "set", { id: "@world", component: "roles:bea", value: { role: "builder" } });   // recut B2: the locker is a builder, so a builder's lock is what bob acts through
  call("olive", "create", { id: "tbl", model: "table", place: { at: [0, 3] } });
  ok(call("bob", "create", { id: "cup", model: "crate", place: { on: "tbl" } }).ok, "P0 a crate on the table");
  ok(call("bob", "create", { id: "bell", model: "ball", place: { on: "cup" } }).ok, "P0 a ball on the crate (two levels down)");
  const w0 = W().state(); ok(w0.entities.cup.c.parent?.to === "tbl" && w0.entities.bell.c.parent?.to === "cup", "P0 the chain is tbl ← cup ← bell", [w0.entities.cup.c.parent, w0.entities.bell.c.parent]);
  ok(call("bea", "set", { id: "tbl", component: "lock", value: true }).ok, "P1 bea (a builder) locks the table (an ordinary set of `lock`)");
  // v1's refusal matrix, for the LOCKER (who is also the owner): place, remove, cargo-mount, replace
  ok(code(call("olive", "set", { id: "tbl", component: "transform", value: { pos: [9, 0, 9] } })) === "locked", "P2 the owner can't move it either (v1: 'even for the locker'; a lock binds everyone)");
  ok(code(call("olive", "delete", { id: "tbl" })) === "locked", "P3 …nor remove it (and she is an owner: a lock binds owners too)");
  ok(code(call("olive", "set", { id: "tbl", component: "parent", value: { to: "cup" } })) !== undefined && code(call("olive", "place", { id: "tbl", at: [5, 5] })) === "locked", "P4 …nor place it, nor mount it on something (cargo-mount)");
  ok(code(call("olive", "set", { id: "tbl", component: "model", value: "crate" })) === "locked", "P5 …nor replace it (its model: v1's spawn onto its id)");
  ok(code(call("olive", "delete", { id: "tbl", component: "transform" })) === "locked", "P6 …nor send it to the origin by deleting its transform (25d H1)");
  { const r = call("bob", "set", { id: "cup", component: "transform", value: { pos: [0.1, 0.75, 0] } });
    ok(code(r) === "locked" && /attached to tbl, which is locked/.test(r.refused.reason) && /locked by bea/.test(r.refused.reason), "P7 what's attached is bound too, and the refusal names the lock and who set it", r.refused);
    ok(/throughLock: true/.test(r.refused.fix) && /delete \{id: 'tbl', component: 'lock'\}/.test(r.refused.fix), "P7 …and teaches both ways through: throughLock, or unlock", r.refused.fix); }
  ok(code(call("bob", "delete", { id: "cup" })) === "locked" && code(call("bob", "place", { id: "cup", at: [4, 4] })) === "locked", "P8 …nor deleted or placed elsewhere");
  ok(code(call("bob", "delete", { id: "cup", component: "parent" })) === "locked", "P9 …nor lifted off (deleting its parent)");
  ok(code(call("bob", "set", { id: "bell", component: "transform", value: { pos: [0, 0.6, 0] } })) === "locked", "P10 a grandchild is bound too (the lock is two levels up)");
  // what stays open: everything that doesn't relocate it (v1: "sit / use / motion / other comps all stay open while locked")
  // a lock covers EVERYTHING (R 10-11 16:21; review C-S1-1): every component, on it and on what's attached; use stays open
  ok(code(call("bob", "set", { id: "tbl", component: "label", value: "the long table" })) === "locked" && code(call("bob", "set", { id: "cup", component: "label", value: "a crate" })) === "locked", "P11 a label is locked too (on it, and on what's attached to it)");
  ok(code(call("bob", "set", { id: "tbl", component: "motion", value: { type: "spin", axis: [0, 1, 0], amp: 0.2, period: 4 } })) === "locked", "P12 motion is locked");
  ok(code(call("bob", "set", { id: "tbl", component: "light", value: { range: 4 } })) === "locked" && code(call("bob", "set", { id: "tbl", component: "physics", value: { kind: "none" } })) === "locked"
    && code(call("bob", "set", { id: "tbl", component: "disabled", value: true })) === "locked" && code(call("bob", "set", { id: "tbl", component: "hidden", value: true })) === "locked", "P13 a light, physics, switching off and hiding are locked (the review's bypass)");
  ok(call("bob", "set", { id: "tbl", component: "reactions", value: { knock: { kind: "set", component: "label", value: "knocked" } }, throughLock: true }).ok && call("vic", "use", { id: "tbl", action: "knock" }).ok, "P14 through the lock a builder sets reactions, and a visitor may still `use` it (use stays open, its label write too)");
  ok(call("olive", "set", { id: "tbl", component: "label", value: "the long table", throughLock: true }).ok, "P14b the owner edits through it with throughLock");
  { const r = call("bob", "create", { id: "cup2", model: "ball", place: { on: "tbl" } }); ok(r.ok, "P15 a NEW thing may be put on a locked table (a lock guards what is attached, not the surface)", r); }
  // one place per thing (R 10-11): a light never shares an entity with a model; it goes on a child
  { call("bob", "create", { id: "pole", model: "crate", place: { at: [-9, 9] } });   // its own thing, under no lock, away from P32's spot
    const r1 = call("bob", "set", { id: "pole", component: "light", value: { color: 0xffd9a0, intensity: 16, range: 10 } });
    const r2 = call("bob", "create", { id: "pole-light", components: { light: { color: 0xffd9a0, intensity: 16, range: 10 }, parent: { to: "pole" }, transform: { pos: [0, 1, 0] } } });
    const r3 = call("bob", "set", { id: "pole-light", component: "model", value: "crate" });
    ok(code(r1) === "one-place" && r2.ok && code(r3) === "one-place", "P15b a light on a model is refused (one place per thing), a child light is fine, and a model on a light is refused too", { r1: r1.refused ?? null, r2: r2.refused ?? null, r3: r3.refused ?? null }); }
  // throughLock
  { const n = W().entries.length; const r = call("bob", "set", { id: "cup", component: "transform", value: { pos: [0.1, 0.75, 0] }, throughLock: true });
    const E = W().entries.slice(n); const st = E.filter((e) => e.kind === "change"); const ops = st.flatMap((e) => e.body.ops ?? [e.body]);
    ok(r.ok, "P16 throughLock: true lets a builder (who may remove the lock) act through it", r.refused);
    ok(E.length === 2 && ops.length && ops.every((o) => o.comp !== "lock") && W().state().entities.tbl.c.lock === true, "P17 …and the log records only the edit: one act, one change entry, no unlock or relock; the lock is still on (stored true: recut B2)", E.map((e) => [e.kind, e.verb, e.body?.comp]));
    ok(E[0].kind === "act" && E[0].body.request.throughLock === true, "P18 …the act carries the request as sent, flag and all (history shows who went through)", E[0].body); }
  ok(call("olive", "set", { id: "tbl", component: "transform", value: { pos: [0, 0, 3.1] }, throughLock: true }).ok, "P19 the owner acts through it the same way");
  ok(code(call("bob", "set", { id: "cup", component: "transform", value: { pos: [0, 0.75, 0] }, throughLock: "yes" })) === "shape", "P20 throughLock is a boolean");
  ok(call("bob", "set", { id: "cup2", component: "label", value: "x", throughLock: true }).ok, "P21 throughLock on an edit no lock guards is harmless");
  { // a capability never acts through a lock: a visitor's use of a handler that would move it, flag or not
    call("bob", "set", { throughLock: true, id: "cup2", component: "reactions", value: { nudge: { kind: "set", component: "transform", value: { pos: [0.2, 0.75, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } } });
    const v = call("vic", "use", { id: "cup2", action: "nudge", throughLock: true }), b = call("bob", "use", { id: "cup2", action: "nudge", throughLock: true });
    ok(code(v) === "locked" && /not a handler/.test(v.refused.fix), "P22 a visitor can't move it through a handler with throughLock (they may not remove the lock)", v.refused);
    ok(code(b) === "locked", "P23 …nor can a builder through a handler (throughLock covers your own edits, not a capability)", b.refused); }
  ok(code(call("vic", "delete", { id: "tbl", component: "lock" })) === "rights" && code(call("vic", "set", { id: "cup2", component: "lock", value: true })) === "rights", "P24 a visitor may neither unlock nor lock");
  ok(code(call("olive", "set", { id: "@world", component: "lock", value: true })) === "world", "P25 @world can't be locked (even by its owner)");
  ok(code(call("olive", "set", { id: "tbl", component: "lock", value: 1 })) === "shape", "P26 the authority writes a lock only as true (to unlock, delete it)");
  { call("bob", "set", { id: "cup2", component: "lock", value: true });
    ok(code(call("bob", "set", { id: "cup2", component: "transform", value: { pos: [0.3, 0.75, 0] } })) === "locked", "P27 a builder's own lock binds that builder (the locker, not an owner)"); }
  ok(call("bob", "delete", { id: "tbl", component: "lock" }).ok, "P28 any builder may unlock someone else's lock (olive's)");
  ok(call("bob", "set", { id: "cup", component: "transform", value: { pos: [0.1, 0.75, 0] } }).ok, "P29 …and then the crate moves");
  call("olive", "set", { id: "cup", component: "lock", value: true });
  ok(code(call("bob", "set", { id: "bell", component: "transform", value: { pos: [0, 0.6, 0] } })) === "locked" && call("bob", "set", { id: "tbl", component: "transform", value: { pos: [0, 0, 3.2] } }).ok,
    "P30 a lock binds what's attached to it, never what it stands on");
  { // undo through a lock: bob's move of a crate bea then locked
    call("bob", "create", { id: "box", model: "crate", place: { at: [6, 6] } }); call("bob", "set", { id: "box", component: "transform", value: { pos: [7, 0, 7] } });
    call("bea", "set", { id: "box", component: "lock", value: true });   // a builder's lock (recut B2: an owner's would be owners-only)
    ok(code(call("bob", "undo", {})) === "locked", "P31 undo goes through admit: bob's undo of his move is refused while it's locked");
    const u = call("bob", "undo", { throughLock: true });
    ok(u.ok && JSON.stringify(W().state().entities.box.c.transform.pos) === "[6,0,6]" && W().state().entities.box.c.lock === true, "P32 …and undo {throughLock: true} reverts it, leaving the lock on", u.refused ?? W().state().entities.box.c); }
  { // the gameplay lock lives inside its own component: door {open, locked}
    call("bob", "create", { id: "gate", model: "door", components: { openable: { open: false, locked: false }, reactions: { open: { kind: "toggle", unless: "locked" }, bolt: { kind: "set", component: "openable", field: "locked", value: true, who: "builder" } } }, place: { at: [-4, 0] } });
    ok(call("vic", "use", { id: "gate", action: "open" }).ok && W().state().entities.gate.c.openable.open === true, "P33 a visitor opens the door: toggle's default is openable.open");
    ok(call("bob", "use", { id: "gate", action: "bolt" }).ok && (({ open, locked }) => JSON.stringify({ open, locked }))(W().state().entities.gate.c.openable) === '{"open":true,"locked":true}', "P34 bolting sets openable.locked, inside its own component");
    const r = call("vic", "use", { id: "gate", action: "open" });
    ok(code(r) === "barred" && !("locked" in W().state().entities.gate.c) && !("open" in W().state().entities.gate.c), "P35 …then opening is barred by door.locked; no top-level `locked` or `open` exists", r.refused);
    const i = call("vic", "inspect", { id: "gate" }); ok(i.notForYou?.some((x) => x.action === "open") && i.openable?.locked === true, "P36 inspect shows why, and the authority's state", i.notForYou);
    call("olive", "set", { id: "gate", component: "lock", value: true });
    ok(code(call("bob", "use", { id: "gate", action: "bolt" })) === undefined, "P37 an edit lock doesn't stop using the authority (v1: use stays open)");
    // an openable thing with nothing that opens it offers 'open' on its own (R 10-11 23:17: the gym door had only openable)
    call("bob", "create", { id: "hatch", model: "door", components: { openable: { open: false } } });
    const u1 = call("vic", "use", { id: "hatch", action: "open" }), o1 = W().state().entities.hatch.c.openable.open;
    const u2 = call("vic", "use", { id: "hatch" }), o2 = W().state().entities.hatch.c.openable.open;
    ok(u1.ok && o1 === true && u2.ok && o2 === false, "P37b an openable thing with no reactions opens and shuts on its own 'open' (the implicit toggle), with or without the action named", { u1: code(u1), o1, u2: code(u2), o2 });
    // review of #260: a reaction that toggles another field of openable (its lock) leaves the implicit open in place
    call("bob", "create", { id: "hatch2", model: "door", components: { openable: { open: false, locked: false }, reactions: { latch: { kind: "toggle", component: "openable", field: "locked" } } } });
    const u3 = call("vic", "use", { id: "hatch2", action: "open" }), o3 = W().state().entities.hatch2.c.openable.open;
    ok(u3.ok && o3 === true, "P37c a toggle of openable.locked alone doesn't take away the implicit open", { u3: code(u3) ?? u3.ok, o3 });
    // …and the implicit open is barred while openable.locked is on, as an open handler with unless: 'locked' is
    const lk = call("vic", "use", { id: "hatch2", action: "latch" }), u4 = call("vic", "use", { id: "hatch2", action: "open" }), o4 = W().state().entities.hatch2.c.openable;
    const TAIL = `"open" won't change it while it's locked`;
    ok(lk.ok && o4.locked === true && code(u4) === "barred" && o4.open === true && u4.refused?.fix === `use {id: "hatch2", action: "latch"} unlocks it; then "open" shuts it. ${TAIL}`,
      "P37d the implicit open is barred while the thing's openable.locked is on, as the registry's locked says, and its fix names what unlocks it (the door is open, so 'open' then shuts it)", { lk: code(lk) ?? lk.ok, u4: code(u4) ?? u4.ok, fix: u4.refused?.fix, o4 });
    // …and where it sees nothing on the thing that unlocks it, the fix names the edit, and claims nothing more
    call("bob", "create", { id: "hatch3", model: "door", components: { openable: { open: false, locked: true } } });
    const u5 = call("vic", "use", { id: "hatch3", action: "open" });
    ok(code(u5) === "barred" && u5.refused?.fix === `someone who may edit it can unlock it: set {id: "hatch3", component: "openable", value: {locked: false}, merge: true}; then "open" opens it. ${TAIL}`,
      "P37e a locked openable with no reaction that unlocks it: its implicit open's fix names the edit that does", { u5: code(u5) ?? u5.ok, fix: u5.refused?.fix });
    // review of #260: a set of locked (gated to owners, its action named with a quote) and a set of the whole openable both
    // unlock it: the fix names both, quoted, with who may use each
    call("bob", "create", { id: "hatch4", model: "door", components: { openable: { open: false, locked: true }, reactions: {
      "it's": { kind: "set", component: "openable", field: "locked", value: false, who: "owner" }, reset: { kind: "set", component: "openable", value: { open: false, locked: false } } } } });
    const u6 = call("vic", "use", { id: "hatch4", action: "open" });
    ok(code(u6) === "barred" && u6.refused?.fix === `use {id: "hatch4", action: "it's"} unlocks it (only owners may); or use {id: "hatch4", action: "reset"} unlocks it; then "open" opens or shuts it. ${TAIL}`,
      "P37f a fix names every reaction it sees unlock the thing, a field set and a whole-component set alike, quoted, with who may use each", { u6: code(u6) ?? u6.ok, fix: u6.refused?.fix });
    // …a toggle of locked that is itself barred (unless: 'locked') isn't offered, and on an open door the open step shuts it
    call("bob", "create", { id: "hatch5", model: "door", components: { openable: { open: true, locked: true }, reactions: { latch: { kind: "toggle", component: "openable", field: "locked", unless: "locked" } } } });
    const u7 = call("vic", "use", { id: "hatch5", action: "open" }), u7b = call("vic", "use", { id: "hatch5", action: "latch" });
    ok(code(u7) === "barred" && code(u7b) === "barred" && u7.refused?.fix === `someone who may edit it can unlock it: set {id: "hatch5", component: "openable", value: {locked: false}, merge: true}; then "open" shuts it. ${TAIL}`,
      "P37g a barred toggle of locked isn't offered as the unlock, and on an open locked door the fix says 'open' then shuts it", { u7: code(u7) ?? u7.ok, u7b: code(u7b) ?? u7b.ok, fix: u7.refused?.fix });
    // …and an authored open handler barred by the lock keeps its own fix, or the general one: unlockFix is the implicit open's
    call("bob", "create", { id: "hatch6", model: "door", components: { openable: { open: false, locked: true }, reactions: { open: { kind: "toggle", unless: "locked", fix: "ring the bell" } } } });
    call("bob", "create", { id: "hatch7", model: "door", components: { openable: { open: false, locked: true }, reactions: { open: { kind: "toggle", unless: "locked" }, unbolt: { kind: "set", component: "openable", field: "locked", value: false } } } });
    const u8 = call("vic", "use", { id: "hatch6", action: "open" }), u9 = call("vic", "use", { id: "hatch7", action: "open" });
    ok(code(u8) === "barred" && u8.refused?.fix === "ring the bell" && code(u9) === "barred" && u9.refused?.fix === "someone allowed to may 'use' it with another action first",
      "P37h an authored open handler barred by the lock keeps its own fix, or the general one", { u8: u8.refused?.fix ?? u8.ok, u9: u9.refused?.fix ?? u9.ok });
    // review of #260: a set of locked to true and a whole set that keeps it on don't unlock it, and aren't offered; a whole
    // set that leaves locked off is, and since it also sets whether the door is open, the open step isn't predicted
    call("bob", "create", { id: "hatch8", model: "door", components: { openable: { open: false, locked: true }, reactions: {
      bolt: { kind: "set", component: "openable", field: "locked", value: true }, reseal: { kind: "set", component: "openable", value: { open: false, locked: true } },
      wipe: { kind: "set", component: "openable", value: { open: false } } } } });
    const u10 = call("vic", "use", { id: "hatch8", action: "open" });
    ok(code(u10) === "barred" && u10.refused?.fix === `use {id: "hatch8", action: "wipe"} unlocks it; then "open" opens or shuts it. ${TAIL}`,
      "P37i a fix leaves out a set that locks it and a whole set that keeps it locked, names a whole set that drops the lock, and doesn't predict the open step it sets", { u10: code(u10) ?? u10.ok, fix: u10.refused?.fix });
    // …and an action name holding a double quote or a backslash is quoted as JSON, so the example stays usable
    call("bob", "create", { id: "hatch9", model: "door", components: { openable: { open: false, locked: true }, reactions: { 'say "in" \\ go': { kind: "toggle", component: "openable", field: "locked" } } } });
    const u11 = call("vic", "use", { id: "hatch9", action: "open" });
    ok(code(u11) === "barred" && u11.refused?.fix === 'use {id: "hatch9", action: "say \\"in\\" \\\\ go"} unlocks it; then "open" opens it. ' + TAIL,
      "P37j an action name with a double quote and a backslash is quoted as JSON in the fix", { u11: code(u11) ?? u11.ok, fix: u11.refused?.fix }); }
  { // §5: a held thing keeps its logged parent, but holding suspends parent constraints until it settles
    const hc = callAt("held");
    hc("olive", "create-world", { title: "held" }); hc("olive", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
    hc("olive", "create", { id: "tbl", model: "table", place: { at: [0, 1] } });
    hc("olive", "create", { id: "cup", model: "ball", components: { physics: { kind: "dynamic", who: "builder" } }, place: { on: "tbl" } });
    hc("bob", "move", { to: [0, 0, 0.6] }); hc("olive", "set", { id: "tbl", component: "lock", value: true });
    ok(code(hc("bob", "grab", { id: "cup" })) === "locked", "P42 picking a cup up off a locked table is refused (the grab relocates what's attached)");
    hc("olive", "delete", { id: "tbl", component: "lock" }); const g = hc("bob", "grab", { id: "cup" });
    hc("olive", "set", { id: "tbl", component: "lock", value: true });
    const put = hc("bob", "put", { id: "cup" });
    ok(g.ok && put.ok, "P43 …but a lock set on the table while the cup is in a hand doesn't bind it there: the put settles it (§5: holding suspends parent constraints)", [g.refused, put.refused]);
    hc("bob", "grab", { id: "cup" }); hc("olive", "set", { id: "cup", component: "lock", value: true });
    ok(code(hc("bob", "put", { id: "cup" })) === "locked", "P44 …and its OWN lock, set while held, still binds it (attack H1h3)"); }
  { // lock levels (R, 10-07): lock {rank} — only that rank and above may change or remove it, or act through it; whoever set
    // it may always lift it. A plain `true` is a builder-level lock (what every existing lock already meant).
    const lc = callAt("levels");
    const LW = () => openWorld(root, "levels").state();
    lc("olive", "create-world", { title: "levels" });
    for (const [who, role] of [["mo", "moderator"], ["bob", "builder"], ["ben", "builder"], ["vic", "inhabitant"]]) lc("olive", "set", { id: "@world", component: `roles:${who}`, value: { role } });
    lc("olive", "create", { id: "stage", model: "table", place: { at: [0, 3] } });
    lc("olive", "create", { id: "mic", model: "ball", place: { on: "stage" } });
    lc("bob", "create", { id: "crate1", model: "crate", place: { at: [4, 3] } });
    lc("mo", "create", { id: "booth", model: "crate", place: { at: [8, 3] } });
    // recut B2 (R 10-20 "a soft barrier by rank"; house 21:59Z): a lock is true; its strength is its setter's rank NOW
    { const r = lc("olive", "set", { id: "stage", component: "lock", value: true });
      ok(r.ok && LW().entities.stage.c.lock === true, "PL1 an owner locks the stage: a lock is just true", r.refused); }
    { const r = lc("bob", "set", { id: "stage", component: "transform", value: { pos: [1, 0, 3] }, throughLock: true });
      ok(code(r) === "locked" && /owners only/.test(r.refused.fix) && r.refused.rank === 255, "PL2 a builder can't act through an owner's lock, and the refusal says it's owners only (its setter's rank)", r.refused); }
    ok(code(lc("bob", "delete", { id: "stage", component: "lock" })) === "rank", "PL3 …nor lift it (rank)");
    ok(code(lc("mo", "delete", { id: "stage", component: "lock" })) === "rank" && code(lc("mo", "delete", { id: "stage", throughLock: true })) === "locked", "PL4 …nor can a moderator, lift it or delete through it");
    ok(code(lc("bob", "set", { id: "stage", component: "lock", value: true })) === "rank", "PL5 a builder can't re-set it to make it theirs (changing a lock is lifting it)");
    ok(code(lc("bob", "set", { id: "mic", component: "transform", value: { pos: [0, 1, 0] }, throughLock: true })) === "locked", "PL6 what rides an owner's lock is held at its strength too (the mic on the stage)");
    ok(lc("olive", "set", { id: "stage", component: "transform", value: { pos: [0, 0, 3.5] }, throughLock: true }).ok && LW().entities.stage.c.lock === true, "PL7 an owner acts through it, and it stays on");
    ok(code(lc("bob", "set", { id: "crate1", component: "lock", value: { rank: "owner" } })) === "shape", "PL8 a lock has no level to choose: {rank} is refused (its strength is your rank)");
    ok(lc("bob", "set", { id: "crate1", component: "lock", value: true }).ok && lc("ben", "set", { id: "crate1", component: "transform", value: { pos: [4, 0, 4] }, throughLock: true }).ok,
      "PL9 a builder's lock: another builder acts through it");
    ok(lc("mo", "set", { id: "booth", component: "lock", value: true }).ok, "PL10 a moderator locks the booth");
    ok(code(lc("bob", "delete", { id: "booth", component: "lock" })) === "rank" && code(lc("bob", "set", { id: "booth", component: "transform", value: { pos: [8, 0, 4] }, throughLock: true })) === "locked",
      "PL11 …a builder can neither lift it nor act through it");
    lc("olive", "set", { id: "@world", component: "roles:mo", value: { role: "builder" } });   // the locker, demoted
    ok(lc("bob", "set", { id: "booth", component: "transform", value: { pos: [8, 0, 4.5] }, throughLock: true }).ok, "PL12 the setter demoted to builder takes the lock's strength down: now a builder acts through it");
    ok(lc("mo", "delete", { id: "booth", component: "lock" }).ok, "PL13 …and the setter may still lift it");
    ok(code(lc("bob", "set", { id: "crate1", component: "lock", value: { rank: "builder" } })) === "shape" && code(lc("bob", "set", { id: "crate1", component: "lock", value: false })) === "shape", "PL14 a lock is true, nothing else");
    ok(lc("ben", "delete", { id: "crate1", component: "lock" }).ok, "PL15 a builder's lock: any builder may lift it");
    const i = lc("vic", "inspect", { id: "stage" });
    ok(i.lock?.rank === 255, "PL16 inspect says the lock's strength (its setter's rank)", { lock: i.lock });
  }
  { // the trusted rung (R 10-12 10:09; docs/COMPONENT-LADDER.md): @world.trusted-components {components: [drafts]} is the owner's word,
    // gated like the rest of @world (never a permission); the list is namespaced draft names only, ≤ 64, distinct
    const tc = callAt("trust");
    const TW = () => openWorld(root, "trust").state();
    tc("olive", "create-world", { title: "trust" }); tc("olive", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
    tc("olive", "set", { id: "@world", component: "roles:mo", value: { role: "moderator", can: { editWorld: true } } });
    const good = { components: ["hesperus/material"] };
    ok(code(tc("bob", "set", { id: "@world", component: "trusted-components", value: good })) === "rights", "TR1 a builder can't trust a draft for the world");
    ok(code(tc("mo", "set", { id: "@world", component: "trusted-components", value: good })) === "rights", "TR2 …nor a moderator with editWorld (trust is the owner's, never a permission)");
    const r = tc("olive", "set", { id: "@world", component: "trusted-components", value: good });
    ok(r.ok && JSON.stringify(TW().entities["@world"].c["trusted-components"]) === JSON.stringify(good), "TR3 the owner trusts it, and the world carries the list", r.refused ?? TW().entities["@world"]?.c["trusted-components"]);
    for (const [v, what] of [[{ components: [1] }, "a non-string"], [{ components: ["light"] }, "a bare name"], [{ components: ["hesperus/material:slot"] }, "a keyed name"], [{ components: Array.from({ length: 65 }, (_, i) => `h/d${i}`) }, "65 entries"],
      [{ components: ["hesperus/material", "hesperus/material"] }, "a name twice"], [["hesperus/material"], "a bare list"], [{ components: ["hesperus/material"], note: "x" }, "an unknown key"], [{ components: "hesperus/material" }, "a string for the list"]])
      ok(code(tc("olive", "set", { id: "@world", component: "trusted-components", value: v })) === "shape", `TR4 refused (shape): ${what}`, tc("olive", "set", { id: "@world", component: "trusted-components", value: v }).refused);
    ok(tc("olive", "set", { id: "@world", component: "trusted-components", value: { components: Array.from({ length: 64 }, (_, i) => `h/d${i}`) } }).ok, "TR5 64 entries is the most, and fine");
    tc("olive", "create", { id: "plinth", model: "crate", place: { at: [2, 2] } });
    ok(code(tc("olive", "set", { id: "plinth", component: "trusted-components", value: good })) === "world-only", "TR6 trusted is a world setting: refused on a thing", tc("olive", "set", { id: "plinth", component: "trusted-components", value: good }).refused);
    ok(tc("olive", "delete", { id: "@world", component: "trusted-components" }).ok && TW().entities["@world"].c["trusted-components"] === undefined, "TR7 the owner removes the list (stop trusting the last one)");
  }
  { // translation: v1 lock is the identity; v1 guard becomes a lock, and is counted
    const old = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log", roles: { ann: { role: "owner" } } } },
      { seq: 1, ts: 2, actor: "ann", verb: "grant", args: { id: "ann", role: "owner" } },
      { seq: 1, ts: 2, actor: "ann", verb: "spawn", args: { id: "statue", lib: "crate", pos: [1, 0, 1] } },
      { seq: 2, ts: 3, actor: "ann", verb: "comp", args: { id: "statue", type: "lock", data: true } },
      { seq: 3, ts: 4, actor: "ann", verb: "spawn", args: { id: "sign", lib: "crate", pos: [3, 0, 1] } },
      { seq: 4, ts: 5, actor: "ann", verb: "comp", args: { id: "sign", type: "guard", data: true } },
      { seq: 5, ts: 6, actor: "ann", verb: "spawn", args: { id: "both", lib: "crate", pos: [5, 0, 1] } },
      { seq: 6, ts: 7, actor: "ann", verb: "comp", args: { id: "both", type: "guard", data: true } },
      { seq: 7, ts: 8, actor: "ann", verb: "comp", args: { id: "both", type: "guard", data: null } }];
    const r = translate(old, DOORKEYS()); const f = r.final.translated;
    ok(JSON.stringify(f.statue.lock) === '{"rank":"builder"}' && !r.stats.divergences, "P38 a v1 lock translates to `lock` in its one spelling, {rank: 'builder'} (@12; the same meaning)", f.statue);
    ok(JSON.stringify(f.sign.lock) === '{"rank":"builder"}' && !("guard" in f.sign) && !("lock" in f.both), "P39 a v1 guard becomes a lock (and an unguarded thing has none)", [f.sign, f.both]);
    ok(r.stats.guards === 2 && r.stats.guardsLive === 1, "P40 the translator counts guards that became locks (2 ever, 1 still on), so the owners can be told", r.stats);
    fs.writeFileSync(root + "worlds/tr-locks.jsonl", r.out.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const tc = (actor, verb, args) => { clock.advance(100); return request(openWorld(root, "tr-locks"), actor, verb, args); };
    ok(code(tc("ann", "set", { id: "sign", component: "transform", value: { pos: [0, 0, 0] } })) === "locked", "P41 in the translated world the old guard binds even its placer (by design, §5)"); }
}

// ---- NR: people's names in refusals (polish for R's first test, research 44 #3) ----
// A name outside the identity grammar ("Marigold": capitals) is stored escaped (x--5269…). A refusal is read by a person
// or an agent, so it says the name as the person spells it, and carries the id as a field for whoever needs to match it.
{ const name = "names";
  const R = enc("Marigold");
  const call = callAt(name);
  call(R, "create-world", { title: "names" });
  call(R, "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  call(R, "create", { id: "statue", model: "crate", place: { at: [0, 2] } });
  call(R, "set", { id: "statue", component: "lock", value: true });
  const locked = call("bob", "set", { id: "statue", component: "transform", value: { pos: [1, 0, 1] } });
  ok(code(locked) === "locked" && /locked by Marigold at/.test(locked.refused.reason) && !/x--/.test(locked.refused.reason), "NR1 a lock refusal names who locked it as they spell it (Marigold, not x--5269…)", locked.refused);
  ok(locked.refused.by === R && locked.refused.lock === "statue", "NR2 …and carries the identity as a field (by), next to the lock", locked.refused);
  call(R, "create", { id: "pot", model: "crate", place: { at: [3, 2] } });
  const t0 = openWorld(root, name).state().entities.pot.c.transform;
  call(R, "set", { id: "pot", component: "transform", value: { ...t0, pos: [3, 0, 3] } });
  const ch = call("bob", "set", { id: "pot", component: "transform", value: { ...t0, pos: [4, 0, 4] }, expect: [{ id: "pot", component: "transform", value: t0 }] });
  ok(code(ch) === "changed" && /Marigold changed it at/.test(ch.refused.reason) && ch.refused.by === R, "NR3 an expect refusal names who changed it (and keeps by: the id)", ch.refused);
  const st = call("bob", "set", { id: "pot", component: "transform", value: { ...t0, pos: [5, 0, 5] }, base: { seq: 1, head: openWorld(root, name).headAt(1) } }); // §3d M7: a version is {seq, head}
  ok(code(st) === "stale" && /Marigold set it at/.test(st.refused.reason) && st.refused.by === R, "NR4 a stale-base refusal names them too", st.refused);
  call("bob", "create", { id: "cup", model: "crate", place: { at: [6, 2] } });
  const cupT = openWorld(root, name).state().entities.cup.c.transform;
  const mv = call("bob", "set", { id: "cup", component: "transform", value: { ...cupT, pos: [6, 0, 6] } });
  call(R, "set", { id: "cup", component: "transform", value: { ...cupT, pos: [7, 0, 7] } });
  const un = call("bob", "undo", { act: mv.act });
  ok(code(un) === "conflict" && /Marigold changed it since/.test(JSON.stringify(un.refused.skipped)) && un.refused.skipped?.[0]?.by === R, "NR5 an undo conflict names who changed it since (and by: the id)", un.refused);
  ok(refusalText("move x--4c616d70", { refused: { code: "locked", reason: "x--4c616d70 is locked (locked by x--4d617269676f6c64 at 9)", fix: "" } }) === "move Lamp refused by the authority (locked): Lamp is locked (locked by Marigold at 9)",
    "NR6 the shared refusal text (what a person's toast and an agent's verb tools show) reads any escaped name back", refusalText("move x--4c616d70", { refused: { code: "locked", reason: "x--4c616d70 is locked (locked by x--4d617269676f6c64 at 9)" } }));
  ok(refusalText("x", { refused: { code: "c", reason: "h--abc and plain-id and x--zz stay" } }) === "x refused by the authority (c): h--abc and plain-id and x--zz stay", "NR7 …a hashed name (h--) or a non-hex x-- is left as it is (it can't be read back)");
  { const V = (req) => lockVerb(req); const set = (component) => ({ verb: "set", args: { id: "a", component, value: 1 } });
    const got = [V(set("transform")), V(set("parent")), V({ verb: "place", args: { id: "a", at: [0, 0] } }), V({ verb: "delete", args: { id: "a" } }), V(set("model")),
      V({ verb: "batch", args: { ops: [set("transform"), { verb: "delete", args: { id: "b" } }] } }), V({ verb: "undo", args: { act: 3 } }), V(set("label")), V({ verb: "delete", args: { id: "a", component: "parent" } })];
    ok(JSON.stringify(got) === JSON.stringify(["Move", "Move", "Move", "Delete", "Replace", "Delete", "Undo", "Change", "Move"]) && lockQuestion("Delete") === "This is locked. Delete anyway?"
      && lockChoices("Move").map((c) => c.v).join() === "through,cancel,unlock", "NR8 the lock question names what the request would do: Move / Delete / Replace anyway? (R's three answers)", got); }
}

// ---- M: translated mounts in the authority's shape (research 37, slice 3 #3) ----
// translate-v1@1 carried v1's parent record and v1's own pos; the authority reads transform as LOCAL to parent, so it saw a
// riding crate wherever its unused pre-mount pos pointed. Now the authority must see it where v1 draws it.
{ const old = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "ann", verb: "grant", args: { id: "ann", role: "owner" } },
    { seq: 2, ts: 3, actor: "ann", verb: "spawn", args: { id: "tbl", lib: "table", pos: [2, 0, 3] } },
    { seq: 2, ts: 3, actor: "ann", verb: "spawn", args: { id: "rack", lib: "table", pos: [-3, 0, 2], yaw: 0.5 } },
    { seq: 2, ts: 3, actor: "ann", verb: "spawn", args: { id: "jar", lib: "bell", pos: [0, 0, 0] } },
    { seq: 2, ts: 3, actor: "ann", verb: "mount", args: { id: "jar", to: "rack", offset: [0.3, 0.75, -0.1], q: [0, 0.3826834, 0, 0.9238795] } }, // a turned carrier, a turned occupant
    { seq: 3, ts: 4, actor: "ann", verb: "spawn", args: { id: "box", lib: "crate", pos: [9, 4, -6] } },           // its pre-mount pose: far away
    { seq: 4, ts: 5, actor: "ann", verb: "mount", args: { id: "box", to: "tbl", offset: [0, 0.75, 0] } },          // rides at the table's centre
    { seq: 5, ts: 6, actor: "ann", verb: "comp", args: { id: "tbl", type: "sockets", data: { perch: { pos: [0.45, 0.75, 0.25], yaw: 1.2 } } } },
    { seq: 6, ts: 7, actor: "ann", verb: "spawn", args: { id: "bell", lib: "bell", pos: [-5, 0, -5] } },
    { seq: 7, ts: 8, actor: "ann", verb: "mount", args: { id: "bell", to: "tbl", slot: "perch" } },                // at a socket, no offset
    { seq: 8, ts: 9, actor: "ann", verb: "spawn", args: { id: "stray", lib: "ball", pos: [6, 0, 6] } },
    { seq: 9, ts: 10, actor: "ann", verb: "mount", args: { id: "stray", to: "nowhere", offset: [0, 5, 0] } }];      // its carrier doesn't exist
  const r = translate(old, DOORKEYS()); fs.writeFileSync(root + "worlds/tr-mounts.jsonl", r.out.map((e) => JSON.stringify(e)).join("\n") + "\n");
  maintain(openWorld(root, "tr-mounts"));   // lead 10-18: the load writes nothing; the command lifts the pre-cut spelling before anyone writes
  const v1 = v1Empty(); for (const e of old) v1fold(v1, e);
  const tc = (verb, args) => { clock.advance(100); return request(openWorld(root, "tr-mounts"), "ann", verb, args); };
  ok(!r.stats.divergences && r.final.translated.box.parent?.to !== undefined && !("order" in r.final.translated.box.parent) && !("offset" in r.final.translated.box.parent), "M1 a translated mount is door-shaped: parent {to} (no order since the shape audit, 10-16), no offset copy (L2)", r.final.translated.box.parent);
  ok(JSON.stringify(r.final.translated.box.transform.pos) === "[0,0.75,0]" && JSON.stringify(r.final.translated.bell.transform.pos) === "[0.45,0.75,0.25]" && r.final.translated.bell.parent.socket === "perch",
    "M2 its transform is local: the offset, or (no offset) its socket's pos, and the socket is kept (v1's slot)", [r.final.translated.box.transform, r.final.translated.bell.transform, r.final.translated.bell.parent]);
  const near = (a, b) => a && b && a.every((x, i) => Math.abs(x - b[i]) < 1e-6);
  // v1's mount names its socket `slot`; shared/hierarchy.js (the renderer's reading) speaks the protocol's `socket`
  const drawn = viewState(openWorld(root, "tr-mounts").state()).entities;   // what the renderer draws: the door's fold, as the view says it (10-14: one vocabulary)
  for (const id of ["box", "bell", "stray", "jar"]) { const i = tc("inspect", { id }); const want = worldPose(drawn, id);
    ok(near(i.world?.pos, want.pos) && near(i.world?.q, want.q), `M3 the authority sees ${id} where v1 draws it (world pose)`, [i.world, want]); }
  const p = tc("create", { id: "ball2", model: "ball", place: { on: "tbl" } }); const at = p.notes?.find((n) => n.placed)?.placed;
  const loc = openWorld(root, "tr-mounts").state().entities.ball2?.c.transform.pos; // local to tbl (it rides the table)
  ok(p.ok && loc && Math.max(Math.abs(loc[0]), Math.abs(loc[2])) > 0.4, "M4 place on the table avoids the riding crate at its centre (with @1's shape the authority saw the crate 9 m away and the centre free)", [at, loc]);
  const chk = tc("lint", {}).warnings ?? []; ok(!chk.some((x) => x.kind === "overlap" && [x.id, x.with].includes("box") && [x.id, x.with].includes("ball2")), "M5 …and check sees no overlap between them", chk);
  ok(chk.filter((x) => x.kind === "floating" && ["box", "bell", "jar"].includes(x.id)).length === 0, "M6 …nor calls a riding thing floating", chk); }

// ---- L: live world vs whole-log re-read ----
{ const dir = root + "live/"; clock.t += 1000; let now = clock.t;
  const w = openLive(dir, "live", { kindOf: LABKIND, now: () => now, simModels: MODELS });
  const call = (actor, verb, args = {}, step = 100) => { now += step; return request(w, actor, verb, args); };
  const same = (what) => {
    const L = readLog(fs.readFileSync(dir + "world.jsonl")); const whole = fold(L);
    ok(digest(w.state()) === digest(whole), `L ${what}: incremental state = a whole-log fold`, [digest(w.state()), digest(whole)]);
    const a = w.sim(), b = simFold(L, now, { models: MODELS });
    const pick = (s) => JSON.stringify({ rested: s.rested.map((r) => [r.id, r.seq, r.p]), launched: Object.keys(s.launched).sort(), d: s.sim ? digestOf(s.sim) : null, chk: s.checks });
    ok(pick(a) === pick(b), `L ${what}: incremental sim = simFold of the whole log`, [pick(a).slice(0, 160), pick(b).slice(0, 160)]);
    const ids = Object.keys(w.state().entities); const plain = { ...w, touching: undefined };
    const bad = ids.flatMap((id) => [undefined, ...Object.keys(w.state().entities[id].c)].map((c) => [id, c])).find(([id, c]) => JSON.stringify(creatorOf(w, id, c)) !== JSON.stringify(creatorOf(plain, id, c)));
    ok(!bad, `L ${what}: the id index gives the same creators as a full scan`, bad);
  };
  call("rowan", "create-world", { title: "live" }); same("founded");
  call("rowan", "create", { id: "table-1", model: "table", place: { at: [0, 4] } });
  call("rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [0, 0] } });
  call("rowan", "set", { id: "@world", component: "roles:vic", value: { role: "inhabitant" } }); same("built");
  call("rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
  call("rowan", "move", { to: [0, 0, -0.5] }); call("rowan", "grab", { id: "ball" });
  { const th = call("rowan", "throw", { id: "ball", v: [0, 2, 3] }); ok(th.ok, "L throw accepted", th.refused ?? th); }
  call("rowan", "look", {}, 300); same("mid-flight (a read advanced the sim first)");
  { const r = call("rowan", "wait", {}, 6000); same("after the rest");
    const want = restsOf(w.entries).map((x) => ({ ...x, when: w.entries[x.seq].ts })).filter((x) => now - x.when < 60000).slice(-8).map((x) => [x.id, x.at.map((n) => Math.round(n * 1000) / 1000)]);
    ok(r.cameToRest?.length && JSON.stringify(r.cameToRest.map((x) => [x.id, x.at])) === JSON.stringify(want), "L wait's rests (from the act index) = restsOf over the whole log", [r.cameToRest, want]); }
  call("rowan", "set", { id: "table-1", component: "label", value: "first" }); call("rowan", "undo", {}); same("after an undo");
  const st = w.state(); const held = st.entities["table-1"]; call("rowan", "set", { id: "table-1", component: "label", value: "t" });
  ok(held === st.entities["table-1"] && !("label" in held.c), "L a state a caller holds never changes under it (copy on write)"); same("after a label"); }

// ---- U: the act index (research 37, slice 3 #5): undo and wait without scanning the log ----
{ const dir = root + "undo/"; let now = clock.t + 3000;
  const w = openLive(dir, "undo", { kindOf: LABKIND, now: () => now });
  const call = (actor, verb, args = {}) => { now += 100; return request(w, actor, verb, args); };
  const flat = (x) => JSON.stringify(Object.fromEntries(Object.entries(x).filter(([k]) => !["entries", "bad", "pt"].includes(k)).map(([k, v]) => [k, v instanceof Map ? [...v].sort((a, b) => String(a[0]).localeCompare(String(b[0]))) : v instanceof Set ? [...v].sort() : v])));
  let steps = 0, firstBad = null;
  const same = (what) => { steps++; const inc = flat(actIndexOf(w)), fresh = flat(actIndexFresh(readLog(fs.readFileSync(dir + "world.jsonl"))));
    if (inc !== fresh && !firstBad) firstBad = [what, inc.slice(0, 300), fresh.slice(0, 300)]; };
  const step = (actor, verb, args = {}) => { const r = call(actor, verb, args); same(`${actor} ${verb}`); return r; };
  const purge = (values) => { now += 100; w.append({ kind: "purge", actor: "system", verb: "purge", body: { values } }); same("purge"); };
  const label = () => w.state().entities.crate?.c.label;
  step("rowan", "create-world", { title: "undo" }); step("rowan", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  step("bob", "create", { id: "crate", model: "crate", place: { at: [0, 0] } });
  // a later act of my own: the index must have advanced, or the second undo finds the first again
  const a1 = step("bob", "set", { id: "crate", component: "label", value: "one" });
  const u1 = step("bob", "undo", {}); ok(u1.ok && label() === undefined, "U1 bob's undo reverts his label", u1.refused);
  const a2 = step("bob", "set", { id: "crate", component: "label", value: "two" });
  const u2 = step("bob", "undo", {});
  ok(u2.ok && label() === undefined && w.entries[u2.act].body.undoes === a2.act, "U2 a NEW act of mine is the next undo (not 'already undone', not the old one)", [u2.refused, w.entries[u2?.act]?.body]);
  ok(code(step("bob", "undo", { act: a1.act })) === "nothing", "U3 an act already undone stays undone");
  // someone else's later write: the per-thing history must include it
  const m = step("bob", "set", { id: "crate", component: "transform", value: { pos: [2, 0, 2] } });
  step("rowan", "set", { id: "crate", component: "transform", value: { pos: [3, 0, 3] } });
  const u3 = step("bob", "undo", {});
  ok(code(u3) === "conflict" && u3.refused.skipped?.[0]?.why === "rowan changed it since", "U4 a later write by someone else: undo refuses what they changed since", u3.refused);
  ok(code(step("bob", "undo", { act: m.act })) === "conflict", "U4 …by act too");
  // purge: a purged OLD value must never come back through undo (the index has to learn the purge)
  const s1 = step("bob", "set", { id: "crate", component: "label", value: "my phone number" });
  step("bob", "set", { id: "crate", component: "label", value: "public" });
  purge([{ seq: w.entries.findIndex((e, i) => i > s1.act && e.kind === "change" && e.cause === s1.act) }]);
  ok(w.state().entities.crate.c.label === "public", "U5 (the purge leaves the current value alone)");
  const u5 = step("bob", "undo", {});
  ok(code(u5) === "conflict" && /purged/.test(u5.refused.skipped?.[0]?.why) && w.state().entities.crate.c.label === "public", "U5 undoing the later label won't restore the purged one", [u5.refused, w.state().entities.crate.c.label]);
  // purge an act's whole body: its label can't be read, so undo {label} can't find it
  const b1 = step("bob", "batch", { label: "tidy", ops: [{ verb: "set", args: { id: "crate", component: "description", value: "a tidy crate" } }] });   // (a light on a model is refused since 10-11: one place per thing)
  purge([{ seq: b1.act }]);
  ok(code(step("bob", "undo", { label: "tidy" })) === "nothing", "U6 a purged act's label can't be matched any more", b1.refused);
  // entityBefore = the fold at every seq, for every thing (purged values included)
  const L = readLog(fs.readFileSync(dir + "world.jsonl")); let bad = null;
  for (let q = 1; q <= L.length && !bad; q++) { const st = fold(L, { until: q - 1 });
    for (const id of new Set([...Object.keys(st.entities), "crate"])) { const a = entityBefore(w, id, q), b = st.entities[id];
      const j = (e) => (e ? JSON.stringify({ born: e.born, c: Object.fromEntries(Object.keys(e.c).sort().map((k) => [k, e.c[k]])) }) : null);
      if (j(a) !== j(b)) { bad = [q, id, j(a), j(b)]; break; } } }
  ok(!bad, `U7 entityBefore(id, seq) = fold(until: seq - 1) for every thing at all ${L.length} seqs (it reads a thing's own history)`, bad);
  ok(!firstBad, `U8 the incremental index = a fresh build after each of ${steps} steps (writes, undos, refusals, two purges)`, firstBad);
  { const X = actIndexOf(w); ok(X.purged.has(b1.act) && X.purgedOps.size === 2, "U9 the index knows both purges (an act body and a set value)", [[...X.purged], [...X.purgedOps]]); } }

// ---- E: expect (§3a: a gesture settles as one act with expect on its starting values), duplicate, redo ----
{ const dir = root + "expect/"; let now = clock.t + 6000;
  const w = openLive(dir, "expect", { kindOf: LABKIND, now: () => now });
  const call = (actor, verb, args = {}) => { now += 100; return request(w, actor, verb, args); };
  const n = () => w.entries.length;
  call("ann", "create-world", { title: "expect" }); call("ann", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  call("ann", "create", { id: "tbl", model: "table", place: { at: [0, 3] } });
  call("ann", "create", { id: "cup", model: "crate", place: { on: "tbl" } });
  const t0 = w.state().entities.tbl.c.transform;
  const moved = { ...t0, pos: [1, t0.pos[1], 3] };
  const e1 = call("ann", "set", { id: "tbl", component: "transform", value: moved, expect: [{ id: "tbl", component: "transform", value: t0 }] });
  ok(e1.ok && w.entries[e1.act].body.request.expect?.length === 1, "E1 expect equal to what's there: written, and the act records it as sent", e1.refused);
  call("bob", "set", { id: "tbl", component: "transform", value: { ...moved, pos: [2, t0.pos[1], 3] } });
  const before = n();
  const e2 = call("ann", "set", { id: "tbl", component: "transform", value: { ...moved, pos: [5, t0.pos[1], 5] }, expect: [{ id: "tbl", component: "transform", value: moved }] });
  const rec = w.entries.slice(before);
  ok(code(e2) === "changed" && e2.refused.by === "bob" && rec.length === 1 && rec[0].kind === "act" && rec[0].body?.refused?.code === "changed" && w.state().entities.tbl.c.transform.pos[0] === 2,
    "E2 someone changed it since: refused `changed`, naming them; no change is written, only the attempt (an act carrying its refusal, round-2 R7)", [e2.refused, rec.map((e) => [e.kind, e.body?.refused])]);
  ok(code(call("ann", "set", { id: "tbl", component: "label", value: "x", expect: [{ id: "tbl", component: "label", value: "y" }] })) === "changed", "E3 expecting a value that isn't there");
  ok(call("ann", "set", { id: "tbl", component: "label", value: "x", expect: [{ id: "tbl", component: "label" }] }).ok, "E4 value left out = expect it absent");
  ok(code(call("ann", "set", { id: "tbl", component: "label", value: "z", expect: [{ id: "tbl", component: "label" }] })) === "changed", "E4b …and refused once it's there");
  ok(code(call("ann", "set", { id: "tbl", component: "label", value: "z", expect: { id: "tbl" } })) === "shape", "E5 a malformed expect is a shape refusal");
  ok(code(call("ann", "batch", { ops: [{ verb: "delete", args: { id: "tbl" } }], expect: [{ id: "gone", component: "transform", value: {} }] })) === "changed", "E6 expect guards a batch too (a thing that's gone)");
  // duplicate: create {from: <a thing>}
  call("ann", "set", { id: "tbl", component: "lock", value: true });
  const d1 = call("bob", "create", { from: "tbl" });
  const st = w.state(); const copy = d1.after && Object.keys(d1.after).find((k) => st.entities[k]?.c.model === "table" && k !== "tbl");
  const kid = copy && Object.keys(st.entities).find((k) => st.entities[k].c.parent?.to === copy);
  ok(d1.ok && copy && kid && !("lock" in st.entities[copy].c) && st.entities[kid].c.model === "crate", "D1 duplicate copies the thing and what's attached to it, as one act (the lock isn't copied)", [d1.refused, copy, kid]);
  ok(d1.ok && Math.abs(st.entities[copy].c.transform.pos[0] - (st.entities.tbl.c.transform.pos[0] + 0.5)) < 1e-9 && opsOf(w.entries[d1.seq]).filter((o) => o.verb === "create").length === 2, "D2 …0.5 m along x, in ONE change entry (two creates)", st.entities[copy]?.c.transform);
  ok(d1.ok && w.entries[d1.seq].actor === "bob" && w.entries[d1.act].body.request.from === "tbl", "D3 the copy is bob's (the act says what it copied)");
  const d4 = call("bob", "undo", { act: d1.act });
  ok(d4.ok && !w.state().entities[copy] && !w.state().entities[kid], "D4 undoing the duplicate removes both parts", d4.refused);
  ok(code(call("bob", "create", { from: "nope" })) === "not-found", "D5 duplicating nothing is not-found");
  // M1 (holes review 10-15): create {at} without from was never read; the thing landed at the origin with ok.
  // Mutation (must go red): drop the `a.at` branch in buildCreate.
  { const r = call("bob", "create", { id: "at-yaw", model: "crate", at: { pos: [-6, 0, -6], yaw: 1 } }); const t = w.state().entities["at-yaw"]?.c.transform; const qy = [0, Math.sin(0.5), 0, Math.cos(0.5)];
    ok(r.ok && t && t.pos.join() === "-6,0,-6" && t.q.every((n, i) => Math.abs(n - qy[i]) < 1e-3), "CA1 create {at: {pos, yaw}} (no from) puts it there, facing yaw", [r.refused, t]);
    const r3 = call("bob", "create", { id: "at-xyz", model: "crate", at: [-8, 0, -6] }); const t3 = w.state().entities["at-xyz"]?.c.transform;
    ok(r3.ok && t3 && t3.pos.join() === "-8,0,-6", "CA2 create {at: [x, y, z]} puts its origin exactly there", [r3.refused, t3]);
    const r2 = call("bob", "create", { id: "at-xz", model: "crate", at: [-6, -9] }); const t2 = w.state().entities["at-xz"]?.c.transform;
    ok(r2.ok && t2 && t2.pos[0] === -6 && t2.pos[2] === -9, "CA3 create {at: [x, z]} sets it on the ground there (place {at})", [r2.refused, t2]);
    const bad = [{ pos: [1, 2] }, { pos: [0, 0, 0], yaw: "north" }, { colour: 1 }, {}, "here", [1, 2, 3, 4], { pos: [0, 0, 0], yaw: 1, q: [0, 0, 0, 1] }];
    const codes = bad.map((at, i) => code(call("bob", "create", { id: `at-bad-${i}`, model: "crate", at })));
    ok(codes.every((c) => c === "shape") && bad.every((_, i) => !w.state().entities[`at-bad-${i}`]), "CA4 a malformed at is a shape refusal, and nothing is made", codes);
    ok(code(call("bob", "create", { id: "at-both", model: "crate", at: [1, 1], place: { at: [2, 2] } })) === "shape", "CA5 at and place together is a shape refusal (one way of saying where)");
    ok(code(call("bob", "create", { from: "tbl", at: [1, 2, 3] })) === "shape", "CA6 with from, at is {pos, yaw|q}: an array is a shape refusal (never spread into the transform)"); }
  // redo = undo of my undo (Figma's rule: never back over someone's later work)
  call("ann", "delete", { id: "tbl", component: "lock" });
  const a1 = call("bob", "set", { id: "cup", component: "label", value: "one" });
  const u1 = call("bob", "undo", { act: a1.act });
  const r1 = call("bob", "undo", { act: u1.act });
  ok(u1.ok && r1.ok && w.state().entities.cup.c.label === "one", "R1 redo (undo {act: <my undo>}) puts my change back", [u1.refused, r1.refused]);
  const u2 = call("bob", "undo", { act: r1.act });
  ok(u2.ok && w.state().entities.cup.c.label === undefined, "R2 …and undoing the redo takes it away again", u2.refused);
  call("ann", "set", { id: "cup", component: "label", value: "ann's" });
  const r2 = call("bob", "undo", { act: u2.act });
  ok(code(r2) === "conflict" && w.state().entities.cup.c.label === "ann's", "R3 redo never puts my change back over someone's later work (Figma's rule)", r2.refused); }

// ---- K: the client's own fold (shared/protocol/replica.js): adopt a cut, ingest the authority's entries; the state equals the
// server's after every request, and the VIEW the renderer draws is recomputed from it (slice 3c: no v1 verbs) ----
// review of #260: the view diff compares a timestamp exactly, and tells an absent world key from an empty one
{ const { diffView } = await import("../../shared/protocol/viewdiff.js");
  const t0 = 1800000000000, thing = (ts) => ({ entities: { s1: { model: "crate", pos: [0, 0, 0], sound: { clip: "bell", at: ts } } } });
  const restart = diffView(thing(t0), thing(t0 + 500)), grass = diffView({ entities: {} }, { entities: {}, grass: {} });
  ok(restart.things.some((x) => x.id === "s1" && x.comp === "sound") && grass.world.includes("grass"), "VD1 a sound restamped 500 ms later is a change, and grass going from absent to {} (the default lawn) is one", { restart, grass }); }
{ const { viewState } = await import("../../shared/protocol/view.js"); const { diffView } = await import("../../shared/protocol/viewdiff.js");
  let now = clock.t + 12000; const w = openLive(root + "client/", "client", { kindOf: LABKIND, now: () => now });
  const call = (actor, verb, args = {}) => { now += 100; return request(w, actor, verb, args); };
  call("ann", "create-world", { title: "client" }); call("ann", "create", { id: "tbl", model: "table", place: { at: [0, 3] } });
  const c = makeReplica();
  c.adopt(JSON.parse(JSON.stringify({ state: wireState(w.state()), head: w.entries.length - 1, worldId: w.worldId })));
  let steps = 0, bad = null; const same = (a, b) => { const d = diffView(a, b); return !d.things.length && !d.world.length; };
  const step = (what, actor, verb, args) => { const from = w.entries.length; const r = call(actor, verb, args);
    const fresh = JSON.parse(JSON.stringify(w.entries.slice(from))); // over the wire: plain JSON
    const before = c.view(); const k = c.ingest(fresh, from); steps++;
    if (k.resync) return { r, k };
    if (!bad && digest(c.st) !== digest(w.state())) bad = [what, "state differs"];
    if (!bad && !same(c.view(), viewState(w.state()))) bad = [what, diffView(c.view(), viewState(w.state()))];
    return { r, k, d: diffView(before, c.view()) }; };
  step("on", "ann", "create", { id: "cup", model: "crate", place: { on: "tbl" } });
  step("lock", "ann", "set", { id: "tbl", component: "lock", value: true });
  const said = step("say", "ann", "say", { text: "hi" });
  step("move", "ann", "set", { id: "tbl", component: "transform", value: { pos: [1, 0, 3] }, throughLock: true });
  step("dup", "ann", "create", { from: "tbl" });
  const sky = step("sky", "ann", "set", { id: "@world", component: "sky", value: { hours: 3 } });
  step("del", "ann", "delete", { id: "tbl", throughLock: true });
  step("undo", "ann", "undo", {});
  step("publish", "ann", "publish", { from: "tbl", name: "table set" });
  ok(!bad, `K1 after each of ${steps} requests the client's fold = the server's (digest), and its view = the server's`, bad);
  ok(sky.k.changed && sky.d.world.includes("sky") && !sky.d.things.length, "K2 the sky arrives as a world change (the v1 path had to re-draw everything for it)", sky.d);
  ok(!said.k.changed && said.k.says.length === 1 && said.k.says[0].text === "hi" && said.k.says[0].actor === "ann", "K7 a say comes back as a chat line, and changes no state", said.k);
  const re = c.ingest(JSON.parse(JSON.stringify(w.entries.slice(-1))), w.entries.length - 1);
  ok(!re.changed && !re.says.length && !re.resync, "K3 a re-delivered entry is ignored", re);
  // its own thing: cup left with tbl (deleting takes children, and undoing a delete is refused since lab F3)
  call("ann", "create", { id: "gap-1", model: "crate", place: { at: [3, 3] } }); c.ingest(JSON.parse(JSON.stringify(w.entries.slice(c.head + 1))), c.head + 1);
  call("ann", "set", { id: "gap-1", component: "label", value: "x" }); const from = w.entries.length; ok(call("ann", "set", { id: "gap-1", component: "label", value: "y" }).ok, "K4 (precondition) the edit after the missed one is written");
  ok(c.ingest(JSON.parse(JSON.stringify(w.entries.slice(from))), from).resync, "K4 a gap (a missed entry) asks for a fresh snapshot, never folds past it");
  const c2 = makeReplica(); c2.adopt(JSON.parse(JSON.stringify({ state: wireState(w.state()), head: w.entries.length - 1 })));
  now += 100; w.append({ kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: from + 1 }] } });
  ok(c2.ingest(JSON.parse(JSON.stringify(w.entries.slice(-1))), w.entries.length - 1).resync, "K5 a purge (retroactive, L1) asks for a fresh snapshot");
  const sv = stateFromWire(JSON.parse(JSON.stringify(wireState(w.state()))));
  ok(digest(sv) === digest(w.state()) && sv.entities["gap-1"]?.c.label === PURGED, "K6 wireState survives the wire both ways, a purged value still purged (not a value)", sv.entities["gap-1"]?.c); }

// ---- E: a handler whose author a purge erased acts for nobody (house 6340433633 Q2) ----
{ let now = clock.t + 7000; const w = openLive(root + "erased/", "erased", { kindOf: LABKIND, now: () => now });
  const call = (actor, verb, args = {}) => { now += 100; return request(w, actor, verb, args); };
  call("ann", "create-world", { title: "erased" });   // a new world: newcomers build
  call("bob", "create", { id: "box", model: "crate", place: { at: [3, 3] } });
  call("bob", "set", { id: "box", component: "reactions", value: { evolve: { kind: "set", component: "reactions", value: { tag: { kind: "set", component: "label", value: "tagged" } } } } });
  ok(call("vic", "use", { id: "box", action: "evolve" }).ok, "E1 (setup) vic's use of bob's evolve installs bob's tag handler");
  const useSeq = [...w.entries].reverse().find((e) => e?.kind === "act" && e.verb === "use" && e.actor === "vic")?.seq;
  now += 100; w.append({ kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: useSeq }] } });
  ok(call("ann", "set", { id: "@world", component: "roles:bob", value: { role: "inhabitant" } }).ok, "E1 (setup) bob is made an inhabitant");
  const r = call("vic", "use", { id: "box", action: "tag" });
  ok(!r.ok && r.refused?.code === "rights" && /erased/.test(r.refused?.reason ?? "") && w.state().entities.box.c.label !== "tagged",
    "E1 the purge erased whose rights installed tag: it acts for nobody (not as a newcomer, which here builds), and says why", r); }

// ---- C: an off-centre catalogue box and measured surfaces ----
{ const cat = { get: (n) => ({ "lib/desk.glb": { label: "desk", box: [[-0.5, -0.4, -0.3], [0.7, 0.35, 0.5]], size: [1.2, 0.75, 0.8], surfaces: [{ y: 0.35, x: [-0.4, 0.6], z: [-0.2, 0.4] }] },
      "lib/cup.glb": { label: "cup", box: [[-0.05, 0, -0.05], [0.05, 0.1, 0.05]], size: [0.1, 0.1, 0.1], surfaces: [] }, "lib/ghost.glb": { label: "ghost", surfaces: [] } } as any)[n], list: () => [] };
  let now = clock.t + 5000; const w = openLive(root + "cat/", "cat", { kindOf: LABKIND, now: () => now, catalogue: cat });
  const call = (actor, verb, args = {}) => { now += 100; return request(w, actor, verb, args); };
  call("ann", "create-world", { title: "cat" });
  ok(call("ann", "create", { id: "desk", model: "lib/desk.glb", place: { at: [0, 0] } }).ok, "C1 an off-centre model is placed");
  const d = w.state().entities.desk.c.transform.pos;
  ok(Math.abs(d[1] - 0.4) < 1e-9, "C2 …standing ON the ground: its box bottom (-0.4 in its own frame) lands at y = 0", d);
  const r = call("ann", "create", { id: "cup", model: "lib/cup.glb", place: { on: "desk" } });
  const n = r.notes?.find((x) => x.placed)?.placed;
  ok(r.ok && Math.abs(n.restsAt - 0.75) < 1e-9, "C3 a cup put ON it rests on the measured top (0.35 + 0.4 = 0.75)", n);
  ok(n && n.pos[0] >= -0.4 - 1e-9 && n.pos[0] <= 0.6 + 1e-9 && n.pos[2] >= -0.2 && n.pos[2] <= 0.4, "C4 …inside the measured zone, not the box's footprint", n?.pos);
  ok(code(call("ann", "create", { id: "g", model: "lib/ghost.glb", place: { at: [3, 3] } })) === "shape", "C5 a model the server couldn't measure can't be placed relationally (and says why)");
  ok(call("ann", "create", { id: "g", model: "lib/ghost.glb" }).ok, "C6 …but it can be named and set by transform");
  ok(code(call("ann", "set", { id: "g", component: "model", value: "nope" })) === "shape", "C7 a name the catalogue doesn't know is refused");
  ok(code(request(openWorld(root, "c8"), "ann", "create-world", {})) === undefined && code(request(openWorld(root, "c8"), "ann", "create", { id: "q", model: "constructor" })) === "shape", "C8 the lab catalogue no longer answers prototype names (model 'constructor')");
  ok(LAB_CATALOGUE.get("toString") === undefined, "C9 LAB_CATALOGUE.get('toString') is undefined");
  // C10-C12: a target is aimed at by its BODY, not its origin (agent lab 10-04: Wren's chair faced air, Juniper's swing
  // hung from a corner). "far" is a desk whose origin sits 2.5 m off its body: its box spans x 2..3.2 in its own frame.
  const cat2 = { get: (n) => ({ "lib/far.glb": { label: "far desk", box: [[2, 0, -0.4], [3.2, 0.75, 0.4]], size: [1.2, 0.75, 0.8], surfaces: [] },
      "lib/chair.glb": { label: "chair", box: [[-0.25, 0, -0.25], [0.25, 0.9, 0.25]], size: [0.5, 0.9, 0.5], surfaces: [] },
      "lib/gate.glb": { label: "frame", box: [[4, 0, -0.1], [6, 2.2, 0.1]], size: [2, 2.2, 0.2], solids: [[[4, 0, -0.1], [4.1, 2.2, 0.1]], [[5.9, 0, -0.1], [6, 2.2, 0.1]], [[4, 2.1, -0.1], [6, 2.2, 0.1]]], surfaces: [] },
      "lib/seat.glb": { label: "seat", box: [[-0.3, 0, -0.15], [0.3, 0.05, 0.15]], size: [0.6, 0.05, 0.3], surfaces: [] } } as any)[n], list: () => [] };
  let now2 = clock.t + 9000; const w2 = openLive(root + "cat2/", "cat2", { kindOf: LABKIND, now: () => now2, catalogue: cat2 });
  const c2 = (actor, verb, args = {}) => { now2 += 100; return request(w2, actor, verb, args); };
  c2("ann", "create-world", { title: "cat2" });
  c2("ann", "create", { id: "far", model: "lib/far.glb", place: { at: [0, 0] } });
  const fb = (() => { const t = w2.state().entities.far.c.transform; return [t.pos[0] + 2.6, t.pos[2]]; })();   // its body's centre in the world
  const ch = c2("ann", "create", { id: "ch", model: "lib/chair.glb", place: { near: "far", facing: "far" } });
  const chp = w2.state().entities.ch?.c.transform;
  const fwd = chp ? [2 * (chp.q[0] * chp.q[2] + chp.q[3] * chp.q[1]), 1 - 2 * (chp.q[0] ** 2 + chp.q[1] ** 2)] : null;   // +Z in the world
  const toBody = chp ? [fb[0] - chp.pos[0], fb[1] - chp.pos[2]] : null;
  const cosA = fwd && toBody ? (fwd[0] * toBody[0] + fwd[1] * toBody[1]) / Math.hypot(...toBody) : null;
  ok(ch.ok && cosA !== null && cosA > 0.99, "C10 near + facing an off-origin desk: the chair faces the desk's BODY, not its origin", { cosA, chp, fb });
  ok(ch.ok && Math.hypot(toBody[0], toBody[1]) < 1.6, "C11 …and stands near the body (within reach), not near the far origin", { dist: toBody && Math.hypot(toBody[0], toBody[1]) });
  c2("ann", "create", { id: "gate", model: "lib/gate.glb", place: { at: [10, 10] } });
  const gt = w2.state().entities.gate.c.transform.pos;
  const sw = c2("ann", "create", { id: "sw", model: "lib/seat.glb", place: { hang: "gate", height: 0.45 } });
  const swp = (() => { const e = w2.state().entities.sw; if (!e) return null; const s = w2.state(); const g = s.entities.gate.c.transform; return [g.pos[0] + e.c.transform.pos[0], g.pos[2] + e.c.transform.pos[2]]; })();
  ok(sw.ok && swp && Math.abs(swp[0] - (gt[0] + 5)) < 0.05, "C12 hang from an off-origin frame: the seat hangs under the beam's middle, not the frame's origin", { swp, beamMid: gt[0] + 5, r: sw.refused }); }

// ---- SKY (review of #260): a merge that sets the sky's hours or rate restarts its clock at the merge ----
{ const { ratedHoursAt } = await import("../../shared/forecast.js");
  let now = clock.t + 9000; const w = openLive(root + "skymerge/", "skymerge", { kindOf: LABKIND, now: () => now });
  request(w, "ann", "create-world", { title: "skymerge" });
  const sky = () => w.state().entities["@world"].c.sky; const at = () => Math.round(ratedHoursAt(sky(), now) * 1000) / 1000;
  const s0 = request(w, "ann", "set", { id: "@world", component: "sky", value: { hours: 6, rate: 24 } });
  now += 1800e3; const half = at();   // half an hour at 24 world hours an hour: 18
  const m1 = request(w, "ann", "set", { id: "@world", component: "sky", value: { hours: 9 }, merge: true }); const afterHours = at();
  now += 900e3; const later = at();   // a quarter hour more: 15
  const m2 = request(w, "ann", "set", { id: "@world", component: "sky", value: { rate: 0 }, merge: true }); const afterRate = at();
  now += 3600e3; const stood = at();
  ok(s0.ok && m1.ok && m2.ok && half === 18 && afterHours === 9 && later === 15 && afterRate === 15 && stood === 15,
    "SKY1 a merged sky hour holds from the merge (9 then, 15 a quarter hour on at 24×), and a merged rate keeps the hour it shows (15, standing still at rate 0)", { half, afterHours, later, afterRate, stood, sky: sky() }); }

// ---- V: what changed, said in the protocol's terms (slice 3c: the renderer reacts to these, not to v1 verbs) ----
{ const { viewState } = await import("../../shared/protocol/view.js"); const { diffView } = await import("../../shared/protocol/viewdiff.js");
  let now = clock.t + 9500; const w = openLive(root + "vdiff/", "vdiff", { kindOf: LABKIND, now: () => now });
  let held = viewState(w.state());
  const step = (actor, verb, args) => { now += 100; const r = request(w, actor, verb, args); const next = viewState(w.state()); const d = diffView(held, next); held = next; return { r, d,
    has: (id, what, comp) => d.things.some((c) => c.id === id && c.what === what && (comp === undefined || c.comp === comp)) }; };
  step("ann", "create-world", { title: "vdiff" });
  const v1 = step("ann", "create", { id: "tbl", model: "table", place: { at: [0, 3] } });
  ok(v1.has("tbl", "born") && !v1.has("tbl", "pose"), "V1 a create is one 'born' (nothing else said about it)", v1.d);
  const v2 = step("ann", "create", { id: "cup", model: "crate", place: { on: "tbl" } });
  ok(v2.has("cup", "born") && !v2.d.things.some((c) => c.id === "tbl"), "V2 a thing put on another: it's born (parent included), the table untouched", v2.d);
  const v3 = step("ann", "set", { id: "tbl", component: "transform", value: { pos: [1, 0, 3] } });
  ok(v3.has("tbl", "pose") && v3.d.things.length === 1, "V3 a move is one 'pose' (the child rides along; it isn't told)", v3.d);
  const replica = step("ann", "set", { id: "tbl", component: "lock", value: true });
  ok(replica.has("tbl", "comp", "lock") && replica.d.things.length === 1, "V4 a component set is 'comp' naming it", replica.d);
  step("ann", "delete", { id: "tbl", component: "lock" });
  const v5 = step("ann", "place", { id: "cup", at: [4, 0] });
  ok(v5.r.ok && v5.has("cup", "parent"), "V5 taking it off the table is 'parent'", { r: v5.r.refused, d: v5.d });
  const v6 = step("ann", "set", { id: "@world", component: "sky", value: { hours: 3 } });
  ok(v6.d.world.includes("sky") && !v6.d.things.length, "V6 the sky is a world change (the v1 projection could only resync for it)", v6.d);
  const v7 = step("ann", "set", { id: "@world", component: `roles:${enc("Bob")}`, value: { role: "builder" } });
  ok(v7.d.world.includes("roles") && JSON.stringify(v7.d.ids.roles) === '["Bob"]', "V7 a role is a world change, naming whose", v7.d);
  const v8 = step("ann", "delete", { id: "tbl" });
  ok(v8.has("tbl", "gone"), "V8 a delete is 'gone'", v8.d);
  const v9 = step("ann", "undo", {});
  ok(v9.r.ok && v9.has("tbl", "born"), "V9 undo brings it back: 'born' again", v9.d);
  ok(diffView(held, viewState(w.state())).things.length === 0 && !diffView(held, viewState(w.state())).world.length, "V10 nothing changed says nothing"); }

// ---- S3: a stretched thing in the view (R 10-04 three-axis scale; Wren's agent-lab `look` failure) ----
{ const { viewOf } = await import("../../shared/protocol/view.js");
  const { effectiveWorldTransform } = await import("../../mcpl/effective.ts");
  const rec = viewOf("bench", { model: "x.glb", transform: { pos: [1, 0, 2], q: [0, 0, 0, 1], scale: [2, 0.4, 0.4] } });
  ok(typeof rec.scale === "number" && JSON.stringify(rec.scale3) === "[2,0.4,0.4]", "S3a a stretched thing's view has `scale` as ONE number (every older reader) and scale3 beside it", rec);
  ok(viewOf("box", { model: "x.glb", transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [3, 3, 3] } }).scale3 === undefined, "S3b a uniform one carries no scale3");
  const eff = effectiveWorldTransform("bench", { entity: (id: string) => (id === "bench" ? rec : undefined), mount: () => undefined } as any, 0);
  ok(eff.ok === true, "S3c the agent's pose reader (mcpl/effective) resolves it: no 'non-finite folded transform'", eff);
  // what an imported world's translation carried (imported:<name>) fills only a name the record doesn't already hold:
  // the active component, the derived pose fields and the parent read as they are; a name nothing else holds still shows
  const imp = viewOf("lamp", { model: "x.glb", transform: { pos: [1, 0, 2], q: [0, 0, 0, 1], scale: [1, 1, 1] }, light: { color: "#fff", intensity: 2 },
    "imported:light": { flicker: true }, "imported:pos": [9, 9, 9], "imported:yaw": 1, "imported:scale": 7, "imported:parent": { to: "x" }, "imported:sway": { amp: 1 } });
  ok(JSON.stringify(imp.light) === JSON.stringify({ color: "#fff", intensity: 2 }) && JSON.stringify(imp.pos) === "[1,0,2]" && imp.yaw === 0 && imp.scale === 1 && imp.parent === undefined && imp.sway?.amp === 1,
    "S3d an imported: value never overwrites the active component or a derived field; one nothing holds still shows", imp);
  const { viewState } = await import("../../shared/protocol/view.js");
  const ws = viewState({ entities: { "@world": { c: { sky: { preset: "dusk" }, "imported:sky": { stars: 3 }, "imported:entities": { x: 1 }, "imported:fog": { d: 1 } } } } });
  ok(JSON.stringify(ws.sky) === JSON.stringify({ preset: "dusk" }) && JSON.stringify(ws.entities) === "{}" && ws.fog?.d === 1,
    "S3e …nor, on the world, its active sky or the view's own entities; one nothing holds still shows", { sky: ws.sky, entities: ws.entities, fog: ws.fog });
  // house 6340433633 (lead's decision): a request that sets or deletes the world's own sky, terrain, grass or water deletes
  // the translation's imported:<it> in the same change, so a deleted sky leaves the slot empty (it showed the leftovers)
  { const iw = callAt("imp-sky");
    const wc = () => openWorld(root, "imp-sky").state().entities["@world"].c; const vs = () => viewState(fold(openWorld(root, "imp-sky").entries));
    iw("ann", "create-world", { title: "imp-sky" });
    iw("ann", "set", { id: "@world", component: "imported:sky", value: { stars: 3 } }); iw("ann", "set", { id: "@world", component: "imported:water", value: { foam: 1 } });
    const other = iw("ann", "set", { id: "@world", component: "bounds", value: { min: [-90, 0, -90], max: [90, 40, 90] } }); const keptByOther = "imported:sky" in wc();
    const set = iw("ann", "set", { id: "@world", component: "sky", value: { hours: 12 } }); const goneBySet = !("imported:sky" in wc()) && "imported:water" in wc();
    iw("ann", "set", { id: "@world", component: "imported:sky", value: { stars: 4 } });
    const del = iw("ann", "delete", { id: "@world", component: "sky" }); const v = vs();
    ok(other.ok && keptByOther && set.ok && goneBySet && del.ok && !("imported:sky" in wc()) && v.sky == null && v.water?.foam === 1,
      "S3f setting or deleting the world's sky deletes its imported:sky with it: a deleted sky leaves the slot empty (other components and imported:water stay)", { other: other.ok, keptByOther, set: set.ok, goneBySet, del: del.ok, keys: Object.keys(wc()), sky: v.sky, water: v.water }); }
}

// ---- P: the pivot component (research 52: Roblox's PivotOffset; where it turns and scales from, never moves it) ----
{ const { editOps, inspectSchema, addOps } = await import("../../shared/editschema.js");
  // the planner's ops: a set's value / a delete of the component
  const val = (r) => r.ops[0]?.verb === "set" ? r.ops[0].args.value : r.ops[0]?.verb === "delete" ? null : undefined;
  const { componentsOf, entityOf } = await import("../../shared/components.js");
  const pw = callAt("pivots");
  pw("ann", "create-world", { title: "pivots" });
  pw("ann", "create", { id: "gate", model: "crate", components: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  ok(pw("ann", "set", { id: "gate", component: "pivot", value: { pos: [0.3, 0, 0] } }).ok, "P1 the authority takes a pivot {pos: [x,y,z]}");
  ok(code(pw("ann", "set", { id: "gate", component: "pivot", value: { pos: [1, 2] } })) === "shape" && code(pw("ann", "set", { id: "gate", component: "pivot", value: { pos: [0, 0, 0], q: [0, 0, 0, 1] } })) === "shape", "P2 …and refuses a bad one (two numbers; an extra field), saying the shape");
  const tr = openWorld(root, "pivots").state().entities.gate.c.transform;
  ok(JSON.stringify(tr.pos) === "[0,0,0]", "P3 setting a pivot never moved the thing", tr);
  const ent = { model: "x.glb", pos: [0, 0, 0], pivot: { pos: [0.3, 0, 0] } };
  const sortK = (v) => (Array.isArray(v) ? v.map(sortK) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortK(v[k])])) : v);
  ok(JSON.stringify(sortK(entityOf(componentsOf(ent)))) === JSON.stringify(sortK(ent)), "P4 pivot round-trips through the component view (componentsOf ∘ entityOf)", entityOf(componentsOf(ent)));
  const live = { box: [[2, 0, -0.4], [3.2, 0.75, 0.4]], doorLocks: true };
  const c1 = val(editOps(ent, "g", { "pivot.centre": true }, live));
  ok(JSON.stringify(c1) === JSON.stringify({ pos: [2.6, 0.375, 0] }), "P5 'centre' snaps the pivot to the middle of the model's own box (an off-origin model)", c1);
  const c2 = val(editOps(ent, "g", { "pivot.base": true }, live));
  ok(JSON.stringify(c2) === JSON.stringify({ pos: [2.6, 0, 0] }), "P6 'base' snaps it to the middle of the bottom face", c2);
  const c3 = editOps(ent, "g", { "pivot.reset": true }, live).ops[0];
  ok(c3?.verb === "delete" && c3.args.component === "pivot", "P7 'origin' removes it (turn about the origin again)", c3);
  const sc = inspectSchema(ent, "g", live);
  ok(sc.sections.list.some((c) => c.type === "Pivot" && c.fields.includes("pivot.x")), "P8 the Inspector draws a Pivot card with its channels");
  const a = addOps({ model: "x.glb", pos: [0, 0, 0] }, "g", "Pivot");
  ok(a.ops[0]?.args?.component === "pivot" && JSON.stringify(a.ops[0].args.value) === '{"pos":[0,0,0]}', "P9 Add Component ▸ Pivot starts at the origin (then centre/base)", a);
  const bare = { model: "x.glb", pos: [0, 0, 0] };
  const c4 = editOps(bare, "g", { "pivot.centre": true }, live);
  ok(!c4.errors.length && JSON.stringify(val(c4)) === JSON.stringify({ pos: [2.6, 0.375, 0] }), "P10 pivot.centre works on a thing with NO pivot yet (Hazel: needed a dummy pivot first)", c4);
  const c5 = editOps(bare, "g", { "pivot.y": 1.5 }, live);
  ok(!c5.errors.length && JSON.stringify(val(c5)) === JSON.stringify({ pos: [0, 1.5, 0] }), "P11 …as does pivot.y", c5);
  // the channel edits honour the pivot too (Maya's channel box; agent lab round 2, Rowan: 'edit rot.y +=90' swung the gate about its origin)
  const gate = { model: "x.glb", pos: [10, 0, 10], yaw: 0, pivot: { pos: [1, 0, 0] } };
  const placeOf = (r) => r.ops.find((o) => o.verb === "set" && o.args.component === "transform")?.args.value;   // the whole transform
  const r1 = placeOf(editOps(gate, "g", { "rot.y": 90 }, live));
  ok(r1 && Math.abs(r1.pos[0] - 11) < 1e-6 && Math.abs(r1.pos[2] - 11) < 1e-6, "P12 rot.y = 90 on a pivoted thing turns it ABOUT the pivot: its origin goes to (11, 0, 11)", r1);
  const r2 = placeOf(editOps(gate, "g", { "pos.scale": 2 }, live));
  ok(r2 && Math.abs(r2.pos[0] - 9) < 1e-6 && Math.abs(r2.pos[2] - 10) < 1e-6, "P13 …and scale 2 grows it about the pivot (the pivot stays at 11): origin to (9, 0, 10)", r2);
  const r3 = placeOf(editOps(gate, "g", { "rot.y": 90, "pos.x": 5 }, live));
  ok(r3 && r3.pos[0] === 5 && r3.pos[2] === 10, "P14 …but a typed translate in the same edit wins (the pivot never second-guesses it)", r3);
  const r4 = placeOf(editOps({ model: "x.glb", pos: [10, 0, 10], yaw: 0 }, "g", { "rot.y": 90 }, live));
  ok(r4 && r4.pos[0] === 10 && r4.pos[2] === 10, "P15 …and with no pivot, a turn stays about the origin, as before", r4); }

// ---- TN: turn {id, axis, deg, space, about} — the gizmo's rotate for agents (agent lab: Juniper #3) ----
{ const tw = callAt("turns");
  const qm = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  const aa = (x, y, z, deg) => { const h = deg * Math.PI / 360; return [x * Math.sin(h), y * Math.sin(h), z * Math.sin(h), Math.cos(h)]; };
  const same = (a, b) => Math.abs(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) - 1) < 1e-6;
  const tq = (id) => openWorld(root, "turns").state().entities[id].c.transform;
  tw("ann", "create-world", { title: "turns" });
  tw("ann", "create", { id: "plank", model: "crate", components: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  ok(tw("ann", "turn", { id: "plank", axis: "x", deg: 90 }).ok && same(tq("plank").q, aa(1, 0, 0, 90)), "TN1 turn about its own x by 90°", tq("plank"));
  tw("ann", "create", { id: "plank2", model: "crate", components: { transform: { pos: [3, 0, 0], q: aa(1, 0, 0, 90), scale: [1, 1, 1] } } });
  tw("ann", "turn", { id: "plank", axis: "y", deg: 90, space: "object" });
  tw("ann", "turn", { id: "plank2", axis: "y", deg: 90, space: "world" });
  ok(same(tq("plank").q, qm(aa(0, 0, 1, 90), aa(1, 0, 0, 90))), "TN2 tilted, then about its OWN y: that's the world's z now (Rz·Rx)", tq("plank").q);
  ok(same(tq("plank2").q, qm(aa(0, 1, 0, 90), aa(1, 0, 0, 90))) && !same(tq("plank").q, tq("plank2").q), "TN3 …while space 'world' turns about the world's y (Ry·Rx): a different answer, as it should be", tq("plank2").q);
  tw("ann", "create", { id: "gate", model: "crate", components: { transform: { pos: [10, 0, 10], q: [0, 0, 0, 1], scale: [1, 1, 1] }, pivot: { pos: [1, 0, 0] } } });
  tw("ann", "turn", { id: "gate", axis: "y", deg: 90 });
  const g = tq("gate");
  ok(Math.abs(g.pos[0] - 11) < 1e-3 && Math.abs(g.pos[2] - 11) < 1e-3, "TN4 with a pivot it turns ABOUT the pivot (11, 0, 10): its origin swings to (11, 0, 11)", g);
  const dry = tw("ann", "turn", { id: "gate", axis: "y", deg: 45, dry: true });
  ok(dry.ok && dry.dry === true && Math.abs(tq("gate").pos[0] - 11) < 1e-3, "TN7 turn takes dry: true (a preview; help promises it on every write) and writes nothing (Hazel)", dry);
  ok(JSON.stringify(tw("ann", "help", {})).includes("turn {id, axis, deg"), "TN8 help's list names turn (Hazel found it only in a refusal)");
  ok(tw("ann", "turn", { id: "gate", axis: "y", deg: 0, about: "origin" }).ok, "TN5 about: 'origin' is there when you want the old behaviour");
  ok(code(tw("ann", "turn", { id: "plank", axis: "sideways", deg: 10 })) === "shape" && code(tw("ann", "turn", { id: "plank", axis: "x", deg: 10, space: "screen" })) === "shape" && code(tw("ann", "turn", { id: "plank", axis: "x", deg: 10, about: "pivot" })) === "shape", "TN6 a bad axis, space, or about-pivot without one is refused, naming the fix"); }

// ---- UR: undo after a redo, and an undo that says what it undid (agent lab round 2, Hazel #1) ----
{ const uw = callAt("undoredo");
  const px = () => openWorld(root, "undoredo").state().entities.box?.c.transform.pos[0];
  uw("ann", "create-world", { title: "undoredo" });
  uw("ann", "create", { id: "box", model: "crate", components: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  const mv = uw("ann", "set", { id: "box", component: "transform", value: { pos: [5, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } });
  const u1 = uw("ann", "undo", {});
  ok(u1.ok && px() === 0 && u1.undid?.act === mv.act && u1.undid.kind === "undo" && /set box transform/.test(u1.undid.what), "UR1 a bare undo says what it undid: {act, kind: 'undo', what: 'set box transform'}", u1.undid);
  const r1 = uw("ann", "undo", { act: u1.act });
  ok(r1.ok && px() === 5 && r1.undid?.kind === "redo" && r1.undid.of === mv.act, "UR2 undoing that undo is a redo, and says so (kind 'redo', of the move)", r1.undid);
  const u2 = uw("ann", "undo", {});
  ok(u2.ok && px() === 0 && u2.undid?.act === r1.act, "UR3 a bare undo after a redo takes back the REDO (not older work: the box goes back, and still exists)", { undid: u2.undid, x: px() });
  const u3 = uw("ann", "undo", {});
  ok(u3.ok && openWorld(root, "undoredo").state().entities.box === undefined, "UR4 …and the next bare undo walks on back past it (the create), not round the undo/redo loop", u3.undid);
  const again = uw("ann", "undo", { act: mv.act });
  ok(again.refused?.code === "nothing" && /already undone \(by undo \d+, then redo \d+, then undo \d+\)/.test(again.refused.reason), "UR5 undo {act} of something already undone names the chain", again.refused); }

// ---- HG: a hung thing swings from the underside of what's above it, and everyone reads the same hinge (Rowan) ----
{ const hw = callAt("hinge");
  const { evalWholeMotion, qApply } = await import("../../client/lib/motioneval.js");
  hw("ann", "create-world", { title: "hinge" });
  hw("ann", "create", { id: "frame", model: "swing-frame", components: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  const r = hw("ann", "create", { id: "seat", model: "swing-seat", place: { hang: "frame", height: 0.45 } });
  const W = () => openWorld(root, "hinge").state();
  const piv = W().entities.seat?.c.pivot?.pos;
  const st = W(); const sp = st.entities.seat.c.transform; const fp = st.entities.frame.c.transform;
  const pivWorldY = piv ? fp.pos[1] + sp.pos[1] + piv[1] * sp.scale[1] : null;
  ok(r.ok && piv && Math.abs(pivWorldY - 2.1) < 1e-3, "HG1 hanging writes the seat's pivot at the beam's UNDERSIDE (y 2.1), not the frame's top (2.2)", { piv, pivWorldY, notes: r.notes });
  hw("ann", "set", { id: "seat", component: "motion", value: { type: "pendulum", axis: [1, 0, 0], amp: 0.3, period: 3, t0: 0 } });
  const ins = hw("ann", "inspect", { id: "seat" });
  ok(JSON.stringify(ins.derived?.pivot) === JSON.stringify(piv), "HG2 inspect reports that same hinge as the pendulum's pivot", ins.derived);
  const base = { pos: [0, 0.45, 0], yaw: 0, pivot: piv };
  const mid = evalWholeMotion(base, { type: "pendulum", axis: [1, 0, 0], amp: 0.3, period: 3, t0: 0 }, 1000);
  const fixed = mid.ok && mid.pos.map((v, i) => v + qApply(mid.quat, piv)[i]);
  ok(fixed && fixed.every((v, i) => Math.abs(v - (base.pos[i] + piv[i])) < 1e-6) && Math.abs(mid.quat[3]) < 0.9999, "HG3 the renderer's (and look's) evaluator swings ABOUT it: mid-swing, the hinge point hasn't moved", { mid, fixed });
  hw("ann", "create", { id: "seat2", model: "swing-seat", components: { transform: { pos: [5, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, pivot: { pos: [0, 9, 0] } } });
  hw("ann", "place", { id: "seat2", hang: "frame", height: 0.45, along: 0.5 });
  ok(JSON.stringify(W().entities.seat2?.c.pivot?.pos) === "[0,9,0]", "HG4 a pivot someone already set is left alone by a hang"); }

// ---- SW: a push (old-vs-new review 10-06 #5) — the impulse kind is reserved since the shape audit (10-16): what remains is
// the refusal, and the v1 mapping a translated world carries ----
{ const sw = callAt("swingpush");
  const { pendulumTheta } = await import("../../client/lib/motioneval.js");
  sw("ann", "create-world", { title: "swingpush" });
  sw("ann", "create", { id: "frame", model: "swing-frame", components: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  sw("ann", "create", { id: "seat", model: "swing-seat", place: { hang: "frame", height: 0.45 } });
  // shape audit 10-16: `impulse` is a reserved handler kind (a general name with a pendulum-only meaning; it returns with its
  // general one when an engine carries impulses). A new one is refused; the push rows that wrote one (SW1-SW4) are retired
  // with it. A stored one (a translated v1 swing) is carried as it was and its use path is unchanged code.
  const p0 = sw("ann", "set", { id: "seat", component: "reactions", value: { push: { kind: "impulse", strength: 0.5 } } });
  ok(p0.refused?.code === "reserved", "SW1 an impulse handler is refused as a reserved kind, even on a swing (shape audit 10-16)", p0.refused);
  void pendulumTheta;
  const tx = (await import("./import-v1/translate-v1.js")).translate(
    [{ seq: 0, ts: 1, actor: "a", verb: "spawn", args: { id: "s", lib: "swing-seat" } }, { seq: 1, ts: 2, actor: "a", verb: "comp", args: { id: "s", type: "reactions", data: { push: { impulse: 0.35 } } } }], {});
  ok(/"reactions":\{"push":\{"kind":"impulse","angular":0.35\}\}/.test(JSON.stringify(tx)), "SW4 v1's {impulse: x} translates to the angular impulse, exactly", JSON.stringify(tx).match(/"reactions":[^}]*\}/)?.[0]);
}

// ---- DU: disk practice (platforms review 10-06 #5): a torn last line is cut at open, not kept as a malformed entry
// forever; a blob whose bytes don't match its name is rewritten, not skipped forever ----
{ const du = callAt("durable");
  du("ann", "create-world", { title: "durable" });
  du("ann", "create", { id: "box", model: "crate", components: { transform: { pos: [1, 0, 1], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  const lp = root + "worlds/durable.jsonl"; const n0 = openWorld(root, "durable").entries.length;
  fs.appendFileSync(lp, '{"world":"durable","kind":"say","ts":1,"body":{"te');   // a crash mid-write
  const w1 = openWorld(root, "durable");
  ok(w1.entries.length === n0 && !w1.state().diagnostics.some(([, c]) => String(c).startsWith("malformed")) && fs.readFileSync(lp).at(-1) === 0x0a,
    "DU1 a torn last line is cut off at open: same entries, no malformed diagnostic, the file ends on a newline", { n0, n1: w1.entries.length, diag: w1.state().diagnostics.slice(-2) });
  ok(du("ann", "set", { id: "box", component: "label", value: "after the crash" }).ok && openWorld(root, "durable").entries.length > n0, "DU2 the world writes on after the cut");
  const w2 = openWorld(root, "durable"); const h = w2.putBlob({ note: "a blob" });
  const bf = root + "store/" + h.replace(/[^a-z0-9]/g, "-") + ".json";
  fs.writeFileSync(bf, '{"note":"a bl');   // torn blob
  openWorld(root, "durable").putBlob({ note: "a blob" });
  let good = false; try { good = JSON.stringify(openWorld(root, "durable").getBlob(h)) === '{"note":"a blob"}'; } catch {}
  ok(good, "DU3 putting a blob whose stored copy is torn rewrites it (it used to be skipped because the name existed)", fs.readFileSync(bf, "utf8")); }

// ---- WT: a warning as a sentence (agent lab: out-of-bounds "doesn't say out of what") ----
{ const { warningText } = await import("../../shared/protocol/refusal.js");
  ok(warningText({ id: "box", kind: "out-of-bounds", bounds: { min: [-20, 0, -20], max: [20, 12, 20] } }) === "box is outside the world's bounds (x -20…20, y 0…12, z -20…20 m)", "WT1 out-of-bounds says which bounds");
  ok(warningText({ id: "cup", kind: "overlap", with: "x--4d617269676f6c64", by: 0.1 }) === "cup overlaps Marigold by 0.1 m", "WT2 an overlap reads as a sentence, names decoded");
  const ww = callAt("warnwords");
  ww("ann", "create-world", { title: "warnwords" });
  const far = ww("ann", "create", { id: "far", model: "crate", components: { transform: { pos: [500, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  ok((far.warnings ?? []).some((w) => w.kind === "out-of-bounds" && w.bounds?.max), "WT3 the authority's out-of-bounds warning carries the bounds", far.warnings);
  const { enc } = await import("../../shared/protocol/names.js");
  ww("ann", "set", { id: "@world", component: "roles:" + enc("Hazel"), value: { role: "builder" } });
  ww(enc("Hazel"), "create", { id: "hz", model: "crate", components: { transform: { pos: [1, 0, 1], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  const other = ww("ann", "set", { id: "hz", component: "label", value: "hazel's crate" });
  const nt = (other.notes ?? []).find((x) => x.madeBy);
  ok(nt && /this is Hazel's/.test(nt.why), "WT4 the 'this is X's' note names a person, not an encoded id (x--48617a656c)", nt); }

// ---- HS: where a value came from, and one thing's history (R 10-04: recent by default, deeper on request) ----
{ const { enc } = await import("../../shared/protocol/names.js");
  const hw = callAt("histw");
  hw("ann", "create-world", { title: "histw" });
  hw("ann", "set", { id: "@world", component: "roles:" + enc("Rowan"), value: { role: "builder" } });
  hw("ann", "create", { id: "box", model: "crate", components: { label: "box", transform: { pos: [1, 0, 1], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  const tSet = clock.t + 100; hw(enc("Rowan"), "set", { id: "box", component: "transform", value: { pos: [2, 0, 1], q: [0, 0, 0, 1], scale: [1, 1, 1] } });
  const ins = hw("ann", "inspect", { id: "box" });
  ok(ins.touched?.transform?.by === enc("Rowan") && ins.touched.transform.ts === tSet, "HS1 inspect says who last changed the transform, and when", ins.touched);
  ok(ins.touched?.transform?.who === "Rowan", "HS1b …by a name a person reads (who), beside the id (by)", ins.touched?.transform);
  ok(ins.touched?.label?.by === "ann" && ins.touched.label.created === true, "HS2 …and that the label is as it was made, by its maker", ins.touched?.label);
  for (let k = 0; k < 6; k++) hw("ann", "set", { id: "box", component: "label", value: `box ${k}` });
  const p1 = hw("ann", "history", { id: "box", limit: 3 });
  ok(p1.entries?.length === 3 && p1.entries[0].seq > p1.entries[1].seq && p1.entries.every((x) => x.changed.includes("label")) && typeof p1.next === "number", "HS3 history {id} is that thing's acts, newest first, a page at a time, with next", p1);
  const all = []; let page = p1; all.push(...page.entries); while (page.next !== undefined) { page = hw("ann", "history", { id: "box", limit: 3, before: page.next }); all.push(...page.entries); }
  ok(all.length === 8 && all.at(-1).changed.includes("(created)") && all.some((x) => x.by === enc("Rowan") && x.changed.includes("transform")), "HS4 …paging back reaches its creation, every act once", all.map((x) => [x.seq, x.changed.join()]));
  const { TOUCH_HORIZON } = await import("../../shared/protocol/authority.js");
  let landed = 0; for (let k = 0; k < TOUCH_HORIZON + 2; k++) { clock.t += 5000; if (hw("ann", "set", { id: "box", component: "label", value: `n${k}` }).ok) landed++; }   // spaced past the rate limit
  ok(landed === TOUCH_HORIZON + 2, "HS5a (setup) every edit past the horizon landed", landed);
  const deep = hw("ann", "inspect", { id: "box" });
  ok(deep.touched?.transform?.beyond > 0 && deep.touched.transform.by === undefined && deep.touched.label?.by === "ann", "HS5 past the horizon it says 'unchanged since before #N' (beyond), never pretends it found nothing", deep.touched);
  const far = []; let pg = hw("ann", "history", { id: "box", limit: 50 }); far.push(...pg.entries); while (pg.next !== undefined) { pg = hw("ann", "history", { id: "box", limit: 50, before: pg.next }); far.push(...pg.entries); }
  ok(far.some((x) => x.by === enc("Rowan") && x.changed.includes("transform")), "HS6 …and the deep search (history paging) still finds the transform change behind the horizon", far.length); }

// ---- H7 (review F3, 2026-10-05): an id is never reused by a NEW thing, but undo brings back the same thing ----
{ let now = clock.t + 40000; const w = openLive(root + "h7/", "h7", { kindOf: LABKIND, now: () => now });
  const call = (actor, verb, args = {}) => { now += 100; return request(w, actor, verb, args); };
  call("ann", "create-world", { title: "h7" }); call("ann", "create", { id: "desk", model: "table", place: { at: [0, 3] } });
  call("ann", "create", { id: "mug", model: "crate", place: { on: "desk" } });
  const del = call("ann", "delete", { id: "desk" });
  ok(del.ok && !w.state().entities.desk && !w.state().entities.mug, "H7a deleting a thing takes what rides it", del.refused);
  const again = call("ann", "create", { id: "desk", model: "table", place: { at: [4, 3] } });
  ok(again.refused?.code === "reused", "H7b a NEW thing can't take a deleted id (it would inherit the old one's references)", again);
  const back = call("ann", "undo", {});
  ok(back.ok && w.state().entities.desk && w.state().entities.mug?.c.parent?.to === "desk", "H7c undo of the delete brings back the same thing, and what rode it, still riding it", [back.refused, w.state().entities.mug?.c.parent]);
  call("ann", "delete", { id: "desk" });
  ok(call("bob", "create", { id: "mug", model: "crate", place: { at: [6, 3] } }).refused?.code === "reused", "H7d …and after a second delete a stranger's create of a child's id is still refused"); }

// LT: the light every engine shares — a spot's cone (half-angles, rad), and bounds the authority holds for any component
{ clock.advance(100); const L = (a) => request(openWorld(root, "lights"), "ann", "set", { id: "lamp", component: "light", value: a });
  request(openWorld(root, "lights"), "ann", "create-world", { title: "lights" });
  request(openWorld(root, "lights"), "ann", "create", { id: "lamp", components: { label: "lamp" } });   // a light is its own thing (one place per thing, 10-11)
  ok(L({ kind: "spot", angle: 0.5, inner: 0.3, range: 8, intensity: 20 }).ok, "LT1 a spot light with its cone (glTF/Godot half-angles) is taken");
  ok(L({ kind: "point", intensity: -1 }).refused?.code === "bounds", "LT2 a negative intensity is refused (bounds)");
  ok(L({ kind: "point", range: 0 }).refused?.code === "bounds", "LT2 a range of 0 is refused");
  ok(L({ kind: "spot", angle: 2 }).refused?.code === "bounds", "LT2 a cone wider than a hemisphere (half-angle > π/2) is refused");
  ok(L({ kind: "point", color: 0x1000000 }).refused?.code === "bounds", "LT2 a color past 0xffffff is refused"); }
// SK: sockets — a named attachment point; with body, a person attaches by using it (chair, swing, saddle, car seat)
{ clock.advance(100); const R = (actor, verb, args) => request(openWorld(root, "sockets"), actor, verb, args);
  R("ann", "create-world", { title: "sockets" });
  R("ann", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  R("ann", "create", { id: "chair1", model: "chair" });
  // review of #260: a dry use is a preview: it seats no one and presses nothing
  { const before = JSON.stringify(openWorld(root, "sockets").presence.occupants ?? {});
    const dry = R("bob", "use", { id: "chair1", action: "sit", dry: true }), after = JSON.stringify(openWorld(root, "sockets").presence.occupants ?? {});
    ok(dry.ok && after === before, "SK0 a dry sit seats no one: the occupants are as they were", { dry: dry.ok ?? dry.refused, before, after }); }
  const sit = R("bob", "use", { id: "chair1", action: "sit" });
  ok(sit.ok && sit.recorded === false && sit.attach?.host === "chair1" && openWorld(root, "sockets").state().entities[sit.attach.to]?.c.socket?.name === "seat" && sit.attach.socket === "seat" && sit.attach.pose === "sitchair", "SK1 a chair's model socket: use {sit} attaches you (presence), at its seat child (made when the chair was), in its pose", sit);
  ok(R("ann", "create", { id: "horse", model: "crate", components: { sockets: { saddle: { pos: [0, 1.2, 0], body: { action: "ride", pose: "sit", exit: [0.8, 0, 0] } }, pannier: { pos: [0.4, 0.8, 0] } } } }).ok, "SK2 sockets with and without a body are taken");
  const look = R("bob", "inspect", { id: "horse" });
  const offers = JSON.stringify(look);
  ok(JSON.stringify(look.actions) === '["ride"]', "SK2 …it offers 'ride' (its body socket's action), and the bare attach point offers nothing", look.actions);
  const ride = R("bob", "use", { id: "horse", action: "ride" });
  ok(ride.ok && ride.attach?.socket === "saddle" && ride.attach.pose === "sit", "SK2 use {ride} attaches you at the saddle", ride);
  R("ann", "create", { id: "throne", model: "crate", components: { sockets: { seat: { pos: [0, 0.5, 0], body: { who: "owner" } } } } });
  ok(R("bob", "use", { id: "throne", action: "sit" }).refused?.code === "rights" && R("ann", "use", { id: "throne", action: "sit" }).ok, "SK3 body.who: a builder may not sit on the owner's throne; the owner may");
  { const seen = R("bob", "inspect", { id: "throne" }); ok(!(seen.canDo ?? []).includes("sit") && (seen.notForYou ?? []).some((x) => x.action === "sit"), "SK3b …and inspect doesn't offer the builder that seat: it's under notForYou (review of #260)", { canDo: seen.canDo, notForYou: seen.notForYou }); }
  R("ann", "create", { id: "bench", model: "crate", components: { sockets: { a: { pos: [-0.3, 0.5, 0], body: { who: "owner" } }, b: { pos: [0.3, 0.5, 0], body: {} } } } });
  { const seen = R("bob", "inspect", { id: "bench" }); ok((seen.canDo ?? []).includes("sit") && !(seen.notForYou ?? []).some((x) => x.action === "sit"), "SK3c …but a bench with an owner's seat and an open one offers the builder 'sit', as use would seat them on the open one", { canDo: seen.canDo, notForYou: seen.notForYou }); }
  // review of #260: a host whose sockets are all switched off still has them, to delete
  { R("ann", "create", { id: "stool", model: "crate" }); const mk = R("ann", "create", { id: "stool-seat", components: { parent: { to: "stool" }, transform: { pos: [0, 0.5, 0] }, socket: { name: "top" } } });
    const off = R("ann", "set", { id: "stool-seat", component: "disabled", value: true }); const del = R("ann", "delete", { id: "stool", component: "sockets" });
    ok(mk.ok && off.ok && del.ok && !openWorld(root, "sockets").state().entities["stool-seat"], "SK5 delete sockets on a host whose only socket is switched off deletes it, not 'has no sockets'", { mk: mk.ok ?? mk.refused, off: off.ok, del: del.ok ?? del.refused }); }
  { R("ann", "create", { id: "cab", model: "crate", components: { openable: { open: false } } });
    const st = R("ann", "create", { id: "cab-seat", components: { parent: { to: "cab" }, transform: { pos: [0, 0.5, 0] }, socket: { name: "in" }, station: { action: "open" } } });
    ok(st.refused?.code === "action-taken", "SK6 a station named 'open' on an openable host is refused: 'open' is the host's own (review of #260)", st.refused ?? st.ok);
    R("ann", "create", { id: "gate", model: "crate", components: { openable: { open: false }, reactions: { swing: { kind: "toggle", component: "openable", field: "open" } } } });
    const st2 = R("ann", "create", { id: "gate-seat", components: { parent: { to: "gate" }, transform: { pos: [0, 0.5, 0] }, socket: { name: "in" }, station: { action: "open" } } });
    ok(st2.ok, "SK6b …but where the host's opening is named something else (swing), 'open' is free for the station", st2.refused ?? st2.ok); }
  { R("ann", "create", { id: "chair2", model: "chair" }); const seat = Object.keys(openWorld(root, "sockets").state().entities).find((k) => openWorld(root, "sockets").state().entities[k].c.parent?.to === "chair2");
    const del = R("ann", "delete", { id: seat }); const again = R("ann", "set", { id: "chair2", component: "model", value: "chair" });
    const back = Object.values(openWorld(root, "sockets").state().entities).some((e) => e.c.parent?.to === "chair2" && e.c.socket);
    ok(!!seat && del.ok && again.ok && !back, "SK7 a chair's seat someone deleted isn't made again by the next write of its model (review of #260)", { seat, del: del.ok ?? del.refused, again: again.ok ?? again.refused, back }); }
  // review of #260: a socket the old spelling's write takes away has the references to it cleared, as a delete's are
  { const S = () => openWorld(root, "sockets").state(); const pannier = Object.keys(S().entities).find((k) => S().entities[k].c.parent?.to === "horse" && S().entities[k].c.socket?.name === "pannier");
    const eye = R("ann", "create", { id: "eye", model: "crate", components: { "look-at": { target: pannier } } });
    const drop = R("ann", "set", { id: "horse", component: "sockets", value: { saddle: { pos: [0, 1.2, 0], body: { action: "ride", pose: "sit", exit: [0.8, 0, 0] } } } });
    const la = S().entities.eye?.c["look-at"];
    ok(!!pannier && eye.ok && drop.ok && !S().entities[pannier] && !(la && la.target === pannier), "SK8 a socket an old-spelling sockets write takes away leaves no reference to it behind (look-at cleared)", { pannier, eye: eye.ok ?? eye.refused, drop: drop.ok ?? drop.refused, gone: !S().entities[pannier], la }); }
  const bad = (v) => R("ann", "set", { id: "horse", component: "sockets", value: v }).refused?.code;
  ok(bad({ s: { pos: [0, 1, 0], pose: "sit" } }) === "schema", "SK4 a socket's pose lives in body (an unknown socket key is refused, with a did-you-mean)");
  ok(bad({ s: { pos: [0, 1, 0], body: { action: "Ride Now" } } }) === "shape", "SK4 body.action is a lower-case verb");
  ok(bad({ s: { body: {} } }) === "shape", "SK4 a socket needs its pos");
  ok(bad({ s: { pos: [0, 1, 0], body: { who: "king" } } }) === "shape", "SK4 body.who is visitor, builder or owner");
  // SK5-8: the body block (shared/sockbody.js), through the authority's own request path: its core is the station (shape
  // audit 10-16); the rest of the research shape (reach, look, input, fromSeat…) is reserved, refused as such
  ok(R("ann", "set", { id: "horse", component: "sockets", value: { saddle: { pos: [0, 1.2, 0], body: { action: "ride", anchor: "hips", pose: { by: "speed", clips: [[0, "idle"], [2, "walk"], [6, "run"]] }, leaveBy: "jump" } } } }).ok
    && bad({ saddle: { pos: [0, 1.2, 0], body: { action: "ride", reach: { leftHand: { at: [-0.2, 1.4, 0.5], vr: "near" } }, look: { yaw: [-90, 90] }, input: { move: "drive", look: "aim" }, fromSeat: true } } }) === "reserved", "SK5 a saddle with a blend by speed and leaveBy is taken; reins, look limits, a driver's input are reserved");
  ok(bad({ s: { pos: [0, 1, 0], body: { anchr: "hips" } } }) === "schema" && bad({ s: { pos: [0, 1, 0], body: { reach: { leftHand: { at: [0, 1, 0], grip: 1 } } } } }) === "schema"
    && bad({ s: { pos: [0, 1, 0], body: { reach: { tail: { at: [0, 1, 0] } } } } }) === "schema", "SK6 closed keys: the body, a reach, the reach limbs (the reach chains)");
  ok(bad({ s: { pos: [0, 1, 0], body: { leaveBy: "teleport" } } }) === "shape" && bad({ s: { pos: [0, 1, 0], body: { look: { pitch: [10, -10] } } } }) === "shape"
    && bad({ s: { pos: [0, 1, 0], body: { pose: { by: "mood", clips: [[0, "idle"], [1, "walk"]] } } } }) === "shape" && bad({ s: { pos: [0, 1, 0], body: { enter: 42 } } }) === "shape", "SK7 enums, ranges, signals and clip names");
  ok(bad({ a: { pos: [0, 1, 0], body: { input: { move: "drive" } } }, b: { pos: [1, 1, 0], body: { input: { move: "drive" } } } }) === "shape", "SK8 at most one drive per thing");
  const att = R("bob", "use", { id: "horse", action: "ride" }).attach;
  // SK9: a part's motion runs on the authority's clock too (a seat locked to its phase needs every client to agree on it)
  const pm = R("ann", "create", { id: "swingset", model: "crate", components: { "motion:plank": { type: "pendulum", amp: 0.4, period: 3 }, motion: { type: "pendulum", amp: 0.1, period: 2 } } });
  const pmc = R("ann", "inspect", { id: "swingset" });
  ok(pm.ok && Number.isFinite(pmc.components?.["motion:plank"]?.t0) && Number.isFinite(pmc.components?.motion?.t0), "SK9 the authority stamps t0 on a part's motion (motion:<part>) as on the whole thing's", pmc.components);
  ok(att?.anchor === "hips" && att.leaveBy === "jump" && att.pose?.by === "speed", "SK8 use {ride} answers attach with what the station does there", att); }
const w0 = () => openWorld(root, "tier0");
// T0 (component review, tier 0): values that would freeze or break every visitor, or wedge the world, are refused
{ clock.advance(100); const R = (verb, args) => request(openWorld(root, "tier0"), "ann", verb, args);
  R("create-world", { title: "tier0" }); R("create", { id: "hearth", model: "crate" });
  const S = (id, comp, value) => R("set", { id, component: comp, value }).refused?.code;
  ok(S("@world", "terrain", { kind: "noise", segments: 100000 }) === "bounds", "T0a terrain segments past 512 (10^10 vertices on every client) is refused");
  ok(S("@world", "terrain", { kind: "noise", size: 0 }) === "bounds", "T0a a terrain of size 0 is refused");
  ok(S("@world", "terrain", { kind: "noise", octaves: 0 }) === "bounds", "T0a terrain octaves outside 1–8 is refused (the engine clamps; the authority agrees)");
  // T0b (review 10-15 #5, after upstream #237/#242): the shaped-terrain and water keys are bounded at the door — the readers clamp
  // features and water but passed a heightmap's min/max through raw, and ±1e308 made everyone's ground NaN
  const grid = "store/heightmaps/" + "a".repeat(16) + ".json";
  ok(S("@world", "terrain", { kind: "noise", heightmap: { grid, min: -1e308, max: 1e308 } }) === "bounds", "T0b a heightmap with min/max ±1e308 (NaN ground for every client) is refused");
  ok(S("@world", "terrain", { kind: "noise", heightmap: { grid, min: 10, max: 0 } }) === "bounds", "T0b heightmap min above max is refused");
  ok(S("@world", "terrain", { kind: "noise", heightmap: { grid: "../../etc/passwd", min: 0, max: 10 } }) === "shape", "T0b a heightmap grid that isn't a store/heightmaps/<hash>.json ref is refused");
  ok(S("@world", "terrain", { kind: "noise", heightmap: { grid, min: 0, max: 10 } }) === undefined, "T0b a sane heightmap is accepted");
  // water is its own component (shape audit 10-16, render-media-env §15): the same bounds, on @world.water
  ok(S("@world", "terrain", { kind: "noise", heightmap: null }) === undefined, "T0b heightmap: null is accepted (removed; a merge patch can take one away)");
  ok(S("@world", "terrain", { kind: "noise", water: { level: 1 } }) === "schema", "T0b terrain.water is refused: water is its own component");
  ok(S("@world", "water", { level: 1e9 }) === "bounds", "T0b water a billion metres deep is refused");
  ok(S("@world", "water", { level: "deep" }) === "shape", "T0b water.level must be a number");
  ok(S("@world", "water", { level: 2, kind: "lava" }) === "shape", "T0b water.kind must be still | river | ocean");
  ok(S("@world", "terrain", { kind: "noise", features: Array.from({ length: 65 }, () => ({ type: "hill", x: 0, z: 0, radius: 5, height: 2 })) }) === "bounds", "T0b 65 features is refused (64 is the readers' cap)");
  ok(S("@world", "terrain", { kind: "noise", features: [{ type: "hill", x: 0, z: 0, radius: 5, height: 1e6 }] }) === "bounds", "T0b a feature a million metres high is refused");
  ok(S("@world", "terrain", { kind: "noise", features: [{ type: "volcano", x: 0, z: 0, radius: 5, height: 2 }] }) === "shape", "T0b an unknown feature type is refused (the readers would drop it silently)");
  ok(S("@world", "terrain", { kind: "noise", features: [{ type: "ridge", x1: 0, z1: 0, x2: 10, z2: 10, radius: 3, height: 2 }, { type: "flatten", x: 0, z: 0, radius: 8, height: 1, edge: 2 }] }) === undefined, "T0b sane features are accepted");
  ok(S("@world", "grass", { width: 1e9, depth: 10 }) === "bounds", "T0b a grass field a million km wide is refused");
  // R 10-07: the knobs are the effect's params now (an Essential's: count, size, opacity, lifetime…), with the same bounds
  ok(S("hearth", "particles", { effect: "fire", params: { count: 1e9 } }) === "bounds", "T0c a billion particles is refused (600 is the renderer's ceiling)");
  ok(S("hearth", "particles", { effect: "fire", params: { size: -3 } }) === "bounds" && S("hearth", "particles", { effect: "fire", params: { opacity: 7 } }) === "bounds", "T0c negative size, opacity past 1: refused");
  ok(R("set", { id: "hearth", component: "particles", value: { effect: "fire", params: { count: 150, size: 0.3, opacity: 0.8, lifetime: 1.2 } } }).ok, "T0c …an ordinary fire is still taken");
  ok(S("@world", "bounds", {}) === "shape" && S("@world", "bounds", { min: [5, 0, 5], max: [-5, 10, -5] }) === "shape", "T0d bounds needs min and max, with min ≤ max on every axis");
  ok(R("create", { id: "c-after", model: "crate" }).ok, "T0d …and creating still answers (an empty bounds used to commit the create, then crash its reply)");
  ok(S("hearth", "transform", { pos: [0, 0, 0], q: [0, 0, 0, 0], scale: [1, 1, 1] }) === "shape", "T0e a zero quaternion is refused (it isn't a rotation)");
  ok(S("hearth", "transform", { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [0, 1, 1] }) === "shape", "T0e a zero scale is refused (its children's transforms divide by it)");
  const nq = R("set", { id: "hearth", component: "transform", value: { pos: [0, 0, 0], q: [0, 0, 0, 0.5], scale: [1, 1, 1] } });
  const q = w0().state().entities.hearth?.c.transform?.q;
  ok(nq.ok && Math.abs(Math.hypot(...q) - 1) < 1e-9, "T0e a non-unit quaternion is stored normalized (the authority and the renderer then agree)", q); }
// T1 (component review, tier 1): components say what they are, where they go, and nothing the renderer reads is refused
{ clock.advance(100); const R = (verb, args) => request(openWorld(root, "tier1"), "ann", verb, args);
  R("create-world", { title: "tier1" }); R("create", { id: "chair", model: "crate" });
  const S = (id, comp, value) => R("set", { id, component: comp, value });
  for (const [comp, value] of [["about", { name: "x" }], ["spawn", { pos: [0, 0, 0], radius: 2 }], ["roles:u-aaaaaaaaaaaaaaaaaaaa", { role: "builder" }], ["blueprints:foo", { name: "f" }], ["sky", { hours: 7 }]])
    ok(S("chair", comp, value).refused?.code === "world-only", `T1a ${comp} belongs to the world: on a chair it's refused, and told where it goes`);
  for (const [comp, value] of [["transform", { pos: [1, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }], ["model", "crate"], ["parent", { to: "chair" }]])
    ok(S("@world", comp, value).refused?.code === "thing-only", `T1b ${comp} belongs to a thing: on @world it's refused (the authority and renderer disagreed about where its children were)`);
  ok(S("chair", "structure", { tile: 1, wallH: 2.6, wallT: 0.12, slabT: 0.15, levels: [], labels: {} }).ok, "T1d structure.slabT, which the renderer reads, is taken");
  ok(S("chair", "particles", { effect: "fire", params: { texture: "eidoverse/assets/particle_textures/flame_05.png" } }).ok, "T1e particles' texture param (in AGENTS.md's own example) is taken");
  ok(S("chair", "particles", { effect: "dust", params: { area: [2, 0.5, 2] } }).ok && S("chair", "particles", { effect: "dust", params: { area: [2, 99, 2] } }).refused?.code === "bounds", "T1e particles' area param [x,y,z] is taken, and bounded per axis");
  ok(S("chair", "particles", { effect: "fire", params: { texture: "../../etc/x.png" } }).refused?.code === "shape", "T1e a texture outside the particle library is refused"); }
// CP (Commons parity audit (old world → new), 10-06): use with no action, the whole log's history paged and filtered, the spoken trio
{ const R = callAt("cp");
  R("ann", "create-world", { title: "cp" }); R("ann", "set", { id: "@world", component: "roles:vic", value: { role: "inhabitant" } });   // vic plays, can't build (R 10-21: newcomers build in a new world)
  R("ann", "create", { id: "rock", model: "crate" });
  const u0 = R("ann", "use", { id: "rock" });
  ok(u0.refused?.code === "no-action" && !/undefined/.test(JSON.stringify(u0)) && /nothing to use/.test(u0.refused.reason), "CP1 use with no action on a thing that offers nothing says so (not \"doesn't 'undefined'\")", u0);
  R("ann", "create", { id: "gate", model: "crate", components: { openable: { open: false }, reactions: { open: { kind: "toggle" } } } });
  const u1 = R("ann", "use", { id: "gate" });
  ok(u1.ok && openWorld(root, "cp").state().entities.gate.c.openable.open === true, "CP2 …on a thing with one action, it does that action", u1);
  R("ann", "set", { id: "gate", component: "reactions", value: { open: { kind: "toggle" }, knock: { kind: "set", component: "label", value: "knocked" } } });
  const u2 = R("ann", "use", { id: "gate" });
  ok(u2.refused?.code === "no-action" && /open, knock/.test(u2.refused.fix) && !/undefined/.test(JSON.stringify(u2)), "CP3 …on a thing with several, it asks which, naming them", u2);
  R("ann", "create", { id: "hatch", model: "crate", components: { openable: { open: false, locked: false }, reactions: { open: { kind: "toggle", unless: "locked" }, bolt: { kind: "set", component: "openable", field: "locked", value: true, who: "owner" } } } });
  const u3 = R("vic", "use", { id: "hatch" });
  ok(u3.ok && openWorld(root, "cp").state().entities.hatch.c.openable.open === true, "CP3 …\"one action\" is one the asker may do: a visitor's bare use opens the hatch (its owner-only bolt isn't a choice for them)", u3);
  for (let i = 0; i < 6; i++) R("ann", "set", { id: "rock", component: "label", value: `r${i}` });
  R("ann", "say", { text: "hello" }); R("vic", "create", { id: "nope", model: "crate" });   // vic: a visitor's refused attempt, on the record
  const all = R("ann", "history", { limit: 200 }).entries;
  const h1 = R("ann", "history", { verbs: ["say"], limit: 5 });
  ok(h1.ok && h1.entries.length === 1 && h1.entries[0].kind === "say" && h1.entries[0].body?.text === "hello", "CP4 history {verbs} filters the whole log (it reached nobody: only limit was read)", h1);
  const p1 = R("ann", "history", { verbs: ["set"], limit: 3 }); const p2 = R("ann", "history", { verbs: ["set"], limit: 3, before: p1.next });
  ok(p1.entries.length === 3 && p1.next === p1.entries[0].seq && p2.entries.length === 3 && p2.entries.at(-1).seq < p1.entries[0].seq && p2.entries.every((e) => e.verb === "set"),
    "CP5 history {before} pages back through the whole log, oldest first within a page, with next", [p1.entries.map((e) => e.seq), p1.next, p2.entries.map((e) => e.seq)]);
  const a1 = R("ann", "history", { after: all[0].seq, limit: 2 });
  ok(a1.entries.length === 2 && a1.entries[0].seq > all[0].seq && a1.next === a1.entries[1].seq, "CP5 …and {after} forward", a1);
  ok(R("ann", "history", { verbs: [], limit: 5 }).entries?.length === 5, "CP5 verbs: [] is no filter (it matched nothing)");
  ok(R("ann", "history", { verbs: "say" }).refused?.code === "shape" && R("ann", "history", { id: "rock", verbs: ["set"] }).refused?.code === "shape", "CP5 a malformed verbs, or verbs on one thing's history, is refused, not ignored");
  const ref = R("ann", "history", { verbs: ["create"], limit: 10 }).entries.find((e) => e.actor === "vic");
  ok(ref?.body?.refused?.code === "rights", "CP6 a refused attempt reads as refused in history (its body says so)", ref);
  // a translated world: a v1 entry is an act `legacy` naming its v1 verb; verbs: ['comp'] finds it
  { const old = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log", roles: { ann: { role: "owner" } } } },
      { seq: 1, ts: 2, actor: "ann", verb: "spawn", args: { id: "lamp_1", lib: "crate", pos: [1, 0, 1] } },
      { seq: 2, ts: 3, actor: "ann", verb: "comp", args: { id: "lamp_1", type: "label", data: "old" } },
      { seq: 3, ts: 4, actor: "ann", verb: "say", args: { text: "from v1" } }];
    const r = translate(old, { foldBuild: v1FoldBuild(), ...DOORKEYS() });
    fs.writeFileSync(root + "worlds/cp-tr.jsonl", r.out.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const hv = request(openWorld(root, "cp-tr"), "ann", "history", { verbs: ["comp"] });
    ok(hv.ok && hv.entries.length === 1 && hv.entries[0].verb === "imported" && hv.entries[0].body?.verb === "comp" && hv.entries[0].body?.args?.type === "label", "CP7 a translated v1 entry is found by its v1 verb, its args intact", hv); }
  // the spoken trio rides a say (validated, t0 clamped to the utterance window); anything malformed is a plain say
  const now = clock.t + 100;
  const s1 = R("ann", "say", { text: "spoken one", spoken: true, utt: 3, t0: now - 1000 });
  const s2 = R("ann", "say", { text: "late t0", spoken: true, utt: 4, t0: now - 10_000_000 });
  const s3 = R("ann", "say", { text: "bad utt", spoken: true, utt: -1, t0: now });
  const s4 = R("ann", "say", { text: "no spoken", utt: 5 });
  const s5 = R("ann", "say", { text: "future t0", spoken: true, utt: 6, t0: now + 10_000_000 });
  const E = openWorld(root, "cp").entries; const b = (r) => E[r.seq]?.body;
  ok(s1.ok && b(s1).spoken === true && b(s1).utt === 3 && b(s1).t0 === now - 1000, "CP8 a spoken say keeps spoken/utt/t0 (the port dropped them)", b(s1));
  ok(b(s2).t0 >= now + 100 - 300_000 && b(s2).utt === 4, "CP8 …t0 is clamped into the 5-minute utterance window", b(s2));
  ok(b(s5).t0 <= now + 600 && b(s5).t0 >= now, "CP8 …a t0 in the future is clamped to now", b(s5));
  ok(!("spoken" in b(s3)) && !("utt" in b(s3)) && !("t0" in b(s3)) && !("utt" in b(s4)), "CP8 …a malformed trio (utt -1, or no spoken) leaves a plain say", [b(s3), b(s4)]);
  const k = makeReplica(); k.adopt({ state: wireState(fold(E.slice(0, s1.seq))), head: s1.seq - 1 });
  const got = k.ingest([E[s1.seq]], s1.seq).says[0];
  ok(got?.spoken === true && got.utt === 3 && got.t0 === now - 1000, "CP8 …and a client's fold hands it on with the chat line", got); }
// ---- CA: captions (one line of what a screen said). The rights live on the SCREEN (captioners {ids}); the tool writes
// the bag by shared/captions.js's rules; nobody forges the bag with a plain set ----
{ const cw = callAt("captions");
  cw("ann", "create-world", { title: "captions" }); cw("ann", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  cw("ann", "set", { id: "@world", component: "roles:vic", value: { role: "inhabitant" } });   // vic plays (R 10-21: a new world's newcomers build)
  cw("ann", "create", { id: "screen", model: "crate", place: { at: [0, 0] } });
  const sess = "2026-10-07T00:00:00.000Z-abc123";
  const line = (n, extra = {}) => ({ id: "screen", session: sess, n, t0: n, t1: n + 1, text: `line ${n}`, ...extra });
  const v1r = cw("vic", "caption", line(1));
  ok(code(v1r) === "rights", "CA1 an inhabitant who isn't one of the screen's captioners can't caption it", v1r.refused);
  ok(cw("bob", "set", { id: "screen", component: "captioners", value: { ids: ["vic"] } }).ok, "CA2 whoever may edit the screen names its captioners");
  const c1 = cw("vic", "caption", line(1, { title: "the talk" }));
  const bag = () => openWorld(root, "captions").state().entities.screen.c.captions;
  ok(c1.ok && bag()?.line?.text === "line 1" && bag().title === "the talk" && bag().n === 1, "CA3 …and a listed captioner (an inhabitant) writes a line", [c1.refused, bag()]);
  const dup = cw("vic", "caption", line(1));
  ok(code(dup) === "caption" && bag().n === 1, "CA4 a resend of a line already written is refused (that refusal is the bot's receipt), nothing written twice", dup.refused);
  ok(cw("vic", "caption", line(2)).ok && bag().line?.text !== undefined && bag().n === 2 && !("window" in bag()), "CA5 the next n is the screen's line now (each line logged once: shape audit 10-16)");
  ok(cw("vic", "caption", line(3, { gen: 5 })).ok, "CA6 (setup) a newer leg (the server stamps each connection's generation) writes");
  const stale = cw("vic", "caption", line(4, { gen: 2 }));
  ok(code(stale) === "caption" && /newer leg/.test(stale.refused?.reason), "CA6 a superseded leg (a lower generation) can't write over its successor", stale.refused);
  const forged = cw("bob", "set", { id: "screen", component: "captions", value: { session: sess, n: 99, gen: 99, line: { t0: 0, t1: 1, text: "forged" } } });
  ok(code(forged) === "caption-only" && bag().n === 3, "CA7 a builder can't forge the bag with a plain set (only the caption request writes it)", forged.refused);
  ok(code(cw("vic", "caption", { id: "screen", session: "nope", n: 1, t0: 0, t1: 1, text: "x" })) === "shape", "CA8 a malformed line is refused by shape (the session's form, shared/captions.js)");
  const end = cw("vic", "caption", { id: "screen", session: sess, end: true, gen: 5 });
  ok(end.ok && bag() === undefined, "CA9 end clears the screen (the history keeps every line)", [end.refused, bag()]);
  ok(cw("bob", "set", { id: "screen", component: "captioners", value: { ids: [] } }).ok && code(cw("vic", "caption", line(1, { session: "2026-10-07T00:00:01.000Z-def456" }))) === "rights", "CA10 taken off the list, they can't caption it any more"); }

// ---- IM: an imported world's records are carried, never written by hand (review 10-07 M1: a request could plant a guard,
// imported-bans:<id>, imported-behavior:<name> or imported:* and wake readers that no longer mean anything) ----
{ const iw = callAt("imported");
  iw("ann", "create-world", { title: "imported" }); iw("ann", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  iw("ann", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
  const tries = [["box", "imported:kind", "light"], ["@world", "imported-behavior:x", { src: "store/scripts/x.js" }], ["@world", "imported-bans:u-aaaaaaaaaaaaaaaaaaaa", { reason: "x" }], ["@world", "imported:epoch", { sim: "eidosim@1.0.0" }]];
  const by = tries.map(([id, component, value]) => code(iw("bob", "set", { id, component, value })));
  ok(by.every((c) => c === "imported"), "IM1 a builder can't write an imported field, an old binding, an imported ban or an imported epoch (imported:epoch)", by);
  // the shape audit (10-16): imported-epoch merged into imported:epoch, and imported-guard was never registered (a dead branch of
  // the imported-only rule): each is now just an unregistered bare name, refused for everyone as one
  const gone = [["box", "imported-guard", true], ["@world", "imported-epoch", { sim: "eidosim@1.0.0" }]].map(([id, component, value]) => code(iw("ann", "set", { id, component, value })));
  ok(gone.every((c) => c === "schema"), "IM1b imported-guard and imported-epoch aren't components: refused as unregistered names, an owner's write too", gone);
  ok(iw("ann", "set", { id: "box", component: "imported:note", value: "kept" }).ok, "IM2 …an owner can (a copy of an imported world writes them; a repair)");
  { const d = iw("ann", "delete", { id: "box", component: "imported:note" }); ok(d.ok, "IM3 …and deleting one is an ordinary edit (a keyed record is its creator's or an owner's to delete)", d.refused); } }

// BZ: bounds must enclose a volume. World Settings › Places once saved {min:[0,0,0],max:[0,0,0]} on a world with none
// (every translated world): accepted, it refused every agent move and sent every landing throw back as "lost" (audit 10-09 A).
{ const name = "bounds-zero";
  const call = callAt(name);
  call("olive", "create-world", { title: "bounds" });
ok(code(call("olive", "set", { id: "@world", component: "bounds", value: { min: [0, 0, 0], max: [0, 0, 0] } })) === "shape", "BZ1 a zero-size bounds box is refused");
ok(code(call("olive", "set", { id: "@world", component: "bounds", value: { min: [-5, 0, -5], max: [5, 0, 5] } })) === "shape", "BZ2 a box flat on one axis (min = max) is refused");
ok(call("olive", "set", { id: "@world", component: "bounds", value: { min: [-50, -10, -50], max: [50, 40, 50] } }).ok, "BZ3 a real box is accepted"); }

// ---- MS: mesh (R 10-12, primitives): a registered parametric body on a model-less thing. One place per thing with a model
// and a light; it has a size to place and stack on; its physics shape is stamped from the component and re-stamped on resize
{ const name = "mesh"; clock.t += 1000;
  const call = callAt(name);
  const W = () => openWorld(root, name); const E = (id) => W().state().entities[id]?.c;
  call("rowan", "create-world", { title: name }); call("rowan", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  { const r = call("bob", "create", { id: "mb", components: { mesh: { shape: "box" }, transform: { pos: [0, 0, 0] } } });
    ok(r.ok && JSON.stringify(E("mb")?.mesh) === JSON.stringify({ shape: "box", size: [1, 1, 1] }), "MS1 a mesh thing is created with its defaults written down (box 1×1×1)", r.refused ?? E("mb")?.mesh); }
  { const r1 = call("bob", "set", { id: "mb", component: "model", value: "crate" }); const r2 = call("bob", "set", { id: "mb", component: "light", value: { color: 0xffd9a0, intensity: 16, range: 10 } });
    call("bob", "create", { id: "cr", model: "crate", place: { at: [5, 5] } }); const r3 = call("bob", "set", { id: "cr", component: "mesh", value: { shape: "sphere", size: [1, 1, 1] } });
    call("bob", "create", { id: "lt", components: { light: { color: 0xffd9a0, intensity: 16, range: 10 }, transform: { pos: [7, 1, 7] } } }); const r4 = call("bob", "set", { id: "lt", component: "mesh", value: { shape: "box", size: [1, 1, 1] } });
    ok([r1, r2, r3, r4].every((r) => code(r) === "one-place"), "MS2 one place per thing: a model or a light on a mesh, a mesh on a model or a light, are all refused", [r1, r2, r3, r4].map((r) => r.refused?.code ?? "ok")); }
  { const r1 = call("bob", "set", { id: "mb", component: "mesh", value: { shape: "box", size: [0.01, 1, 1] } }); const r2 = call("bob", "set", { id: "mb", component: "mesh", value: { shape: "cone", size: [1, 1, 1] } });
    ok(code(r1) === "bounds" && code(r2) === "shape" && /each must be/.test(r1.refused?.reason ?? ""), "MS3 a size outside 0.05..200 (the definition's ranges, per element) and an unknown shape are refused", [r1.refused, r2.refused]); }
  { const r = call("bob", "create", { id: "cup", model: "ball", place: { on: "mb" } }); const y = E("cup")?.transform?.pos?.[1];
    ok(r.ok && Math.abs(y - 1) < 1e-3, "MS4 place {on} a mesh box works: it has a size, and the ball lands on its top (y = 1)", r.refused ?? E("cup")?.transform);
    const b = call("bob", "create", { id: "mb2", components: { mesh: { shape: "box", size: [2, 0.5, 2] } }, place: { beside: "mb" } }); ok(b.ok, "MS4b place {beside} works for a mesh too", b.refused); }
  { const m = call("bob", "measure", { id: "mb" }); ok(m.ok && m.size.every((x) => Math.abs(x - 1) < 1e-6), "MS5 measure reads a mesh box as 1×1×1", m); }
  call("rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
  { const sh = E("mb")?.physics?.shape; ok(E("mb")?.physics?.kind === "static" && JSON.stringify(sh) === JSON.stringify([[-0.5, 0, -0.5], [0.5, 1, 0.5]]), "MS6 physics on: a mesh box is a static collider with its box stamped (base-centred)", E("mb")?.physics); }
  { call("bob", "create", { id: "ms", components: { mesh: { shape: "sphere", size: [0.4, 9, 9] }, physics: { kind: "dynamic" }, transform: { pos: [-3, 2, -3] } } });
    call("bob", "create", { id: "mc", components: { mesh: { shape: "cylinder", size: [0.6, 1.2, 9] }, transform: { pos: [-3, 0, 3] } } });
    const s = E("ms")?.physics?.shape, c = E("mc")?.physics?.shape;
    ok(s?.type === "sphere" && s.radius === 0.2 && s.pos[1] === 0.2, "MS7 a mesh sphere stamps a sphere (radius = size[0]/2, centred r up)", s);
    ok(JSON.stringify(c) === JSON.stringify([[-0.3, 0, -0.3], [0.3, 1.2, 0.3]]), "MS8 a mesh cylinder stamps its bounding box (no carried engine reads a cylinder; review S1.1), size[0] wide and size[1] tall", c);
    call("bob", "create", { id: "mp", components: { mesh: { shape: "capsule", size: [1, 0.2, 1] }, transform: { pos: [3, 0, -3] } } });
    const m = call("bob", "measure", { id: "mp" }); const ps = E("mp")?.physics?.shape;
    ok(m.ok && Math.abs(m.size[1] - 1) < 1e-6 && ps?.[1]?.[1] === 1, "MS8b a capsule shorter than its diameter is its diameter tall (review S2.3): measure and the stamp both say 1 m", { size: m.size, ps });
    const rn = call("bob", "set", { id: "mc", component: "mesh", value: { shape: "cylinder", size: [0.6, 1.4, 9] } });
    ok(rn.ok && (rn.notes ?? []).some((n) => n.field === "shape" && /bounding BOX/.test(n.why ?? "") && n.ids?.includes("mc")), "MS8c the reply says a cylinder is stamped as its bounding box (r2 S3), not left to read as round", rn.notes); }
  { const r = call("bob", "set", { id: "mb", component: "mesh", value: { shape: "box", size: [2, 3, 4] } }); const sh = E("mb")?.physics?.shape;
    ok(r.ok && JSON.stringify(sh) === JSON.stringify([[-1, 0, -2], [1, 3, 2]]), "MS9 a mesh size change re-stamps its physics shape", r.refused ?? sh); }
}
// ---- MS (no engine): a resized host sets its resting occupants down from above its new top (r2 S1.1: a grown host buried them);
// a host that loses its body frees them (r2 S2.3); a socketed child is never an occupant (r2 S2.2); a no-op write re-drops nothing (r2 S2.1)
{ const name = "mesh-noeng"; clock.t += 1000;
  const call = callAt(name);
  const W = () => openWorld(root, name); const E = (id) => W().state().entities[id]?.c; const wy = (id) => call("bob", "measure", { id }).bounds?.min?.[1];
  call("rowan", "create-world", { title: name }); call("rowan", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  call("bob", "create", { id: "plinth", components: { mesh: { shape: "box", size: [1.5, 0.8, 1.5] }, sockets: { perch: { pos: [0.5, 0.8, 0.5] } }, transform: { pos: [0, 0, 0] } } });
  const c = call("bob", "create", { id: "crate", model: "crate", components: { physics: { kind: "dynamic" } }, place: { on: "plinth" } });
  call("bob", "create", { id: "cup", model: "ball", components: { physics: { kind: "dynamic" }, parent: { to: "plinth", socket: "perch" }, transform: { pos: [0, 0, 0] } } });
  const perch = Object.keys(W().state().entities).find((k) => E(k)?.parent?.to === "plinth" && E(k)?.socket?.name === "perch"); const cup0 = JSON.stringify(E("cup")?.transform);
  ok(c.ok && E("crate")?.parent?.to === "plinth" && Math.abs(wy("crate") - 0.8) < 1e-3, "MS10 a crate placed on the plinth rides it at 0.8", { c: c.refused ?? null, y: wy("crate"), parent: E("crate")?.parent });
  const s1 = call("bob", "set", { id: "plinth", component: "mesh", value: { shape: "box", size: [1.5, 0.3, 1.5] } });
  ok(s1.ok && Math.abs(wy("crate") - 0.3) < 1e-3 && (s1.notes ?? []).some((n) => n.setDown?.includes("crate")), "MS10a shrunk to 0.3: the crate is set down to 0.3 (no engine)", { y: wy("crate"), notes: s1.notes });
  const s2 = call("bob", "set", { id: "plinth", component: "mesh", value: { shape: "box", size: [1.5, 1.0, 1.5] } });
  ok(s2.ok && Math.abs(wy("crate") - 1.0) < 1e-3 && E("crate")?.parent?.to === "plinth", "MS10b grown to 1.0: the crate is set down from ABOVE the new top, at 1.0, not buried inside (r2 S1.1)", { y: wy("crate"), notes: s2.notes });
  ok(!!perch && E("cup")?.parent?.to === perch && JSON.stringify(E("cup")?.transform) === cup0, "MS10c the cup on the perch socket was never an occupant: it stays on its socket (r2 S2.2; the socket is the plinth's perch child since the cut)", E("cup"));
  const n0 = W().entries.length; const s3 = call("bob", "set", { id: "plinth", component: "mesh", value: { shape: "box", size: [1.5, 1.0, 1.5] } });
  ok(s3.ok && W().entries.length - n0 === 2 && !(s3.notes ?? []).some((n) => n.setDown || n.fell), "MS10d re-asserting the same mesh value writes 2 rows and re-drops nothing (r2 S2.1)", { rows: W().entries.length - n0, notes: s3.notes });
  const d = call("bob", "delete", { id: "plinth", component: "mesh" });
  ok(d.ok && !E("crate")?.parent && Math.abs(wy("crate")) < 1e-3 && !(d.notes ?? []).some((n) => n.stamped), "MS10e deleting the plinth's mesh frees the crate to the world and sets it on the ground; the reply doesn't say 'stamped' (r2 S2.3)", { y: wy("crate"), parent: E("crate")?.parent ?? null, notes: d.notes });
}

// SKE: a socket is a child entity {transform, parent: {to: host}, socket: {name, …}} (PLAN-sockets-entities 2026-10-12 §1)
{ clock.advance(100); const R = (actor, verb, args) => request(openWorld(root, "socketents"), actor, verb, args);
  const E = (id) => openWorld(root, "socketents").state().entities[id]?.c;
  R("ann", "create-world", { title: "socketents" });
  R("ann", "create", { id: "bench", model: "crate" });
  const sock = (id, extra = {}, socket = {}) => R("ann", "create", { id, components: { parent: { to: "bench" }, transform: { pos: [0, 0.5, 0] }, socket: { name: "seat", body: { action: "sit" }, ...socket }, ...extra } });
  const s1 = sock("bench-seat");
  ok(s1.ok && E("bench-seat")?.socket?.name === "seat" && E("bench-seat")?.parent?.to === "bench", "SKE1 a socket child of a thing is taken", s1.refused ?? E("bench-seat"));
  ok(code(sock("bench-lamp", { light: { kind: "point" } }, { name: "lamp" })) === "one-place" && code(sock("bench-crate", { model: "crate" }, { name: "c2" })) === "one-place" && code(sock("bench-phys", { physics: { kind: "dynamic" } }, { name: "p2" })) === "one-place", "SKE2 a socket carries no model, light or physics: one-place");
  ok(sock("bench-swing", { motion: { type: "oscillate", amp: 0.1, period: 2 } }, { name: "swing" }).ok, "SKE2 …but a motion of its own is allowed (R 10-12 20:44)");
  const dup = sock("bench-seat2");
  ok(code(dup) === "name-taken" && dup.refused?.taken === "bench-seat", "SKE3 a second socket called 'seat' on the same host is refused: name-taken, naming the first", dup);
  ok(R("ann", "create", { id: "stool", model: "crate" }).ok && R("ann", "create", { id: "stool-seat", components: { parent: { to: "stool" }, socket: { name: "seat" } } }).ok, "SKE3 …the same name on another host is fine");
  const root0 = R("ann", "create", { id: "loose", components: { socket: { name: "seat" } } });
  ok(code(root0) === "shape" && /needs a host/.test(root0.refused?.reason), "SKE4 a socket with no host (a root socket) is refused", root0);
  ok(code(R("ann", "delete", { id: "bench-seat", component: "parent" })) === "shape" && E("bench-seat")?.parent?.to === "bench", "SKE4 …and a socket can't be unparented to the root");
  ok(code(R("ann", "create", { id: "nested", components: { parent: { to: "bench-seat" }, socket: { name: "inner" } } })) === "shape", "SKE4 …nor hang under another socket");
  ok(code(R("ann", "set", { id: "bench-seat", component: "transform", value: { pos: [0, 0.5, 0], q: [0, 0, 0, 1], scale: [2, 2, 2] } })) === "shape", "SKE5 a socket's scale is [1, 1, 1]: scale 2 is refused");
  const drive = (id, name) => R("ann", "create", { id, components: { parent: { to: "stool" }, socket: { name, body: { input: { move: "drive" } } } } });
  ok(code(drive("stool-d1", "d1")) === "shape" && !E("stool-d1"), "SKE6 a driver's input belongs to a drive station on a host with drive: on a plain seat it is refused (station.input opened for the helm: drive-check D1)");
  ok(code(R("ann", "create", { id: "badsock", components: { parent: { to: "stool" }, socket: { name: "x", pos: [0, 1, 0] } } })) === "schema", "SKE6 a socket's pose is its transform: socket.pos is an unknown key (did you mean)");
  ok(code(R("ann", "create", { id: "badbody", components: { parent: { to: "stool" }, socket: { name: "z", body: { anchr: "hips" } } } })) === "schema" && code(R("ann", "create", { id: "badname", components: { parent: { to: "stool" }, socket: { name: "two words" } } })) === "shape", "SKE6 the body block is checked whole (an unknown body key; a name that isn't one)");
  R("ann", "create", { id: "bench-arm", components: { parent: { to: "bench" } } }); R("ann", "create", { id: "bench-arm-rest", components: { parent: { to: "bench-arm" }, socket: { name: "rest" } } });
  ok(code(R("ann", "set", { id: "bench-arm", component: "socket", value: { name: "arm" } })) === "shape" && !E("bench-arm")?.socket, "SKE4 …nor may a thing holding a socket become a socket itself");
  ok(code(R("ann", "create", { id: "badwho", components: { parent: { to: "stool" }, socket: { name: "y", body: { who: "king" } } } })) === "shape", "SKE6 body.who is a role here");
  // R 10-15 22:48: ONE entity budget, sockets included ("aren't sockets child entities anyway?")
  const have = Object.keys(openWorld(root, "socketents").state().entities).length - 1;
  R("ann", "set", { id: "@world", component: "capacity", value: { entities: have + 2 } });
  const third = R("ann", "create", { id: "third", model: "crate" });
  const sockAtCap = R("ann", "create", { id: "third-seat", components: { parent: { to: "third" }, socket: { name: "seat" } } });
  const full = R("ann", "create", { id: "fourth", model: "crate" });
  const fullSock = R("ann", "create", { id: "third-arm", components: { parent: { to: "third" }, socket: { name: "arm" } } });
  ok(third.ok && sockAtCap.ok && code(full) === "full" && full.refused?.entities === have + 2 && code(fullSock) === "full" && fullSock.refused?.entities === have + 2 && /@world\.capacity\.entities/.test(fullSock.refused?.reason ?? ""), "SKE7 capacity.entities counts every entity, sockets too (R 10-15): a limit of have+2 takes a thing and a socket on it, then refuses a thing and a socket alike", { have, r: [third.refused, sockAtCap.refused, full.refused, fullSock.refused] });
}

// SKE8-10: the verbs read socket children (socketsOf): use, look, inspect; and a socket is never a thing a hand takes
{ clock.advance(100); const R = (actor, verb, args) => request(openWorld(root, "socketuse"), actor, verb, args);
  R("ann", "create-world", { title: "socketuse" }); R("ann", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  R("ann", "create", { id: "sofa", model: "crate" });
  R("ann", "create", { id: "sofa-l", components: { parent: { to: "sofa" }, transform: { pos: [-0.4, 0.5, 0] }, socket: { name: "left", body: { action: "sit", anchor: "hips" } } } });
  R("ann", "create", { id: "sofa-r", components: { parent: { to: "sofa" }, transform: { pos: [0.4, 0.5, 0] }, socket: { name: "right", body: { action: "sit" } } } });
  R("ann", "create", { id: "sofa-hook", components: { parent: { to: "sofa" }, transform: { pos: [0, 1, 0] }, socket: { name: "hook", accepts: ["coat"] } } });
  const u = R("bob", "use", { id: "sofa", action: "sit" });
  ok(u.ok && u.attach?.to === "sofa-l" && u.attach.host === "sofa" && u.attach.socket === "left" && u.attach.anchor === "hips", "SKE8 use {id: host} sits on its first seat child: attach {to: <the socket>, host, socket: its name}", u);
  const ur = R("bob", "use", { id: "sofa", action: "sit", args: { socket: "right" } });
  ok(ur.ok && ur.attach?.to === "sofa-r", "SKE8 …args.socket names a child by its name", ur);
  const us = R("bob", "use", { id: "sofa-r" });
  ok(us.ok && us.attach?.to === "sofa-r" && us.attach.host === "sofa", "SKE8 use {id: <a socket>} is the direct form (its one action)", us);
  ok(code(R("bob", "use", { id: "sofa-hook" })) === "no-action", "SKE8 …a socket with no body offers nothing to use");
  const ins = R("bob", "inspect", { id: "sofa" });
  ok(JSON.stringify(ins.actions) === '["sit"]' && JSON.stringify(ins.sockets?.map((x) => [x.id, x.name, x.as])) === '[["sofa-l","left","station"],["sofa-r","right","station"],["sofa-hook","hook","snap"]]', "SKE9 inspect {host}: its actions come from its stations, and it lists its sockets (id, name, station | snap | attach)", [ins.actions, ins.sockets]);
  const lk = R("bob", "look", {});
  ok(lk.things.some((t) => t.id === "sofa" && t.sockets?.length === 3) && !lk.things.some((t) => ["sofa-l", "sofa-r", "sofa-hook"].includes(t.id)), "SKE9 look lists the host with its sockets, never a socket as a thing", lk.things.map((t) => t.id));
  R("ann", "set", { id: "sofa-l", component: "disabled", value: true });
  ok(R("bob", "use", { id: "sofa", action: "sit" }).attach?.to === "sofa-r", "SKE9 a switched-off socket is a closed seat: use picks the next");
  R("bob", "move", { to: [0, 0, 0.8] }); const g = R("bob", "grab", { id: "sofa-r" });
  ok(code(g) === "not-a-thing" && /sofa/.test(g.refused?.reason), "SKE10 grab of a socket is not-a-thing, naming its host", g); }

// LS2: a world written before the cut (translate-v1 still writes the old spelling): undoing its last sockets edit lands
// on socket children. The door lifts the host first (its stored map to children, the bell on its perch into the perch's
// child, where it was), then the old value is a diff against them.
{ const old = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "ann", verb: "grant", args: { id: "ann", role: "owner" } },
    { seq: 1, ts: 2, actor: "ann", verb: "spawn", args: { id: "tbl", lib: "table", pos: [2, 0, 3], yaw: 0.7 } },
    { seq: 2, ts: 3, actor: "ann", verb: "comp", args: { id: "tbl", type: "sockets", data: { perch: { pos: [0.45, 0.75, 0.25], yaw: 1.2 } } } },
    { seq: 3, ts: 4, actor: "ann", verb: "spawn", args: { id: "bell", lib: "bell", pos: [-5, 0, -5] } },
    { seq: 4, ts: 5, actor: "ann", verb: "mount", args: { id: "bell", to: "tbl", slot: "perch" } },
    { seq: 5, ts: 6, actor: "ann", verb: "spawn", args: { id: "rack", lib: "crate", pos: [-2, 0, 1] } },
    { seq: 6, ts: 7, actor: "ann", verb: "comp", args: { id: "rack", type: "sockets", data: { hook: { pos: [0, 0.8, 0.1] } } } },
    { seq: 7, ts: 8, actor: "ann", verb: "spawn", args: { id: "coin", lib: "ball", pos: [3, 0, 3] } },
    { seq: 8, ts: 9, actor: "ann", verb: "comp", args: { id: "tbl", type: "sockets", data: { perch: { pos: [0.45, 0.75, 0.25], yaw: 1.2 }, seat: { pos: [0, 0.5, 0], sit: true } } } }];
  const r = translate(old, DOORKEYS());
  // a home naming a socket, as a pre-cut door stored it (v1 had no homes: written as that door wrote it, an act and its change)
  // (before the last sockets edit, which stays the latest act: the one the undo below takes back)
  const home = { pos: [0.1, 0, 0], q: [0, 0, 0, 1], parent: { to: "tbl", socket: "perch" } }; const wid = r.out[1].world; const n = r.out.length - 2;
  const last = r.out.splice(n, 2); last[1] = { ...last[1], cause: last[1].cause + 2 };
  r.out.push({ world: wid, kind: "act", actor: "ann", verb: "set", body: { request: { id: "coin", component: "home", value: home } }, ts: last[0].ts }, { world: wid, kind: "change", actor: "ann", cause: n, verb: "batch", body: { ops: [{ verb: "set", id: "coin", comp: "home", value: home }, { verb: "set", id: "coin", comp: "grabbable", value: { who: "inhabitant", home } }] }, ts: last[0].ts }, ...last);
  fs.writeFileSync(root + "worlds/tr-lift.jsonl", r.out.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const tc = (verb, args) => { clock.advance(100); return request(openWorld(root, "tr-lift"), "ann", verb, args); };
  const homeAt = (st, h) => worldT({ entities: { ...st.entities, x: { c: { parent: { to: h.parent.to }, transform: { pos: h.pos, q: h.q } } } } }, "x").pos;
  const home0 = homeAt(openWorld(root, "tr-lift").state(), home);
  const S = () => openWorld(root, "tr-lift").state();
  const was = worldT(S(), "bell");
  ok(S().entities.tbl.c.sockets?.seat && S().entities.bell.c.parent?.socket === "perch", "LS2 (the fixture) the translated world stores the old spelling: tbl.sockets {perch, seat}, bell on parent {to: tbl, socket: perch}", [S().entities.tbl.c.sockets, S().entities.bell.c.parent]);
  maintain(openWorld(root, "tr-lift"));   // lead 10-18: the lift is the command's (the load refuses writes until it has run: repair-needed)
  const u = tc("undo", {});
  const st = S(); const socks = Object.entries(st.entities).filter(([, e]) => e.c.parent?.to === "tbl" && e.c.socket).map(([k, e]) => [k, e.c.socket.name]);
  const now = worldT(st, "bell"); const near = (a, b, e = 1e-8) => a.every((v, i) => Math.abs(v - b[i]) < e);
  ok(u.ok && st.entities.tbl.c.sockets === undefined && JSON.stringify(socks.map((x) => x[1])) === '["perch"]', "LS2 undo of the pre-cut sockets edit lands on the children: tbl stores no map and has one socket child, perch (the seat it added is gone)", [u.refused, st.entities.tbl.c.sockets, socks]);
  ok(st.entities.bell.c.parent?.to === socks[0]?.[0] && !("socket" in st.entities.bell.c.parent) && near(now.pos, was.pos) && near(now.q, was.q), "LS2 …and the bell rides the perch's child, where it was in the world (within 1e-8)", [st.entities.bell.c.parent, was, now]);
  const ch = st.entities.coin.c.home;
  const gh = st.entities.coin.c.grabbable?.home;
  // (a stored grabbable.home is no longer read — home is the one home since the shape audit, 10-16 — so the lift leaves it as stored)
  ok(ch?.parent?.to === socks[0]?.[0] && !("socket" in ch.parent) && near(homeAt(st, ch), home0) && gh?.parent?.socket === "perch", "LS2 …a stored home naming the perch now names its child, the same place in the world", [ch, gh, home0]);
  const coin0 = worldT(S(), "coin"); const pc = tc("set", { id: "coin", component: "parent", value: { to: "rack", socket: "hook" } }); const s2 = S();
  const hook = Object.keys(s2.entities).find((k) => s2.entities[k].c.parent?.to === "rack" && s2.entities[k].c.socket?.name === "hook");
  ok(pc.ok && s2.entities.rack.c.sockets === undefined && !!hook && s2.entities.coin.c.parent?.to === hook && near(worldT(s2, "coin").pos, coin0.pos), "LS2 a parent {to, socket} on a host still holding its map lifts that host first: rack's hook is a child, and the coin rides it where it was", [pc.refused, s2.entities.rack.c.sockets, s2.entities.coin.c.parent]);
  ok(!openWorld(root, "tr-lift").entries.slice(r.out.length).some((e) => e.kind === "change" && opsOf(e).some((o) => o.comp === "sockets" && o.verb === "set" || (o.comp === "parent" && o.value?.socket !== undefined))), "LS2 …and nothing written after the cut holds the old spelling");
}

// SR1 (review 10-12 S1-1): a socket child is part of its host. Creating one, re-parenting one, or setting its socket or
// transform is an edit of the host's seats: the host's rights (a builder without editOthers can't seat ann's car) and the
// locks over the host's chain, in either spelling (the legacy map lifts to creates, and those are judged the same).
{ clock.advance(100); const W = () => openWorld(root, "seatrights");
  const R = (actor, verb, args) => { clock.advance(2000); return request(W(), actor, verb, args); };
  const E = (id) => W().state().entities[id]?.c;
  R("ann", "create-world", { title: "seatrights" });
  R("ann", "set", { id: "@world", component: "role-defs", value: { builder: { can: { editOthers: false } }, crew: { name: "Crew", rank: 150, can: { build: true, editOthers: true } } } });
  R("ann", "set", { id: "@world", component: "roles:dee", value: { role: "crew" } });
  R("ann", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } }); R("ann", "set", { id: "@world", component: "roles:cy", value: { role: "owner" } });
  R("ann", "create", { id: "car", model: "crate", components: { sockets: { seat: { pos: [0, 0.5, 0], body: { action: "sit" } } } } });
  const kids = (h) => Object.keys(W().state().entities).filter((k) => E(k)?.parent?.to === h && E(k)?.socket).map((k) => E(k).socket.name).sort();
  const drv = { name: "drv", body: { action: "drive" } };
  // 1. a foreign drive seat: neither spelling, and bob can't drive ann's car
  const nat = R("bob", "create", { id: "bobdrv", components: { parent: { to: "car" }, transform: { pos: [0, 0.6, 0.3] }, socket: drv } });
  const leg = R("bob", "set", { id: "car", component: "sockets", value: { seat: { pos: [0, 0.5, 0], body: { action: "sit" } }, drv: { pos: [0, 0.6, 0.3], body: { action: "drive" } } } });
  R("bob", "move", { to: [0, 0, 0.8] }); const dr = R("bob", "use", { id: "car", action: "drive" });
  ok(code(nat) === "rights" && code(leg) === "rights" && code(dr) !== undefined && JSON.stringify(kids("car")) === '["seat"]', "SR1a a builder without editOthers can't add a drive seat to the owner's car (native and legacy map), so can't drive it", [nat.refused, leg.refused, dr.attach ?? dr.refused, kids("car")]);
  // 2. under an owner-level lock: a builder and another owner are both refused a new socket
  R("ann", "create", { id: "chair", model: "crate", components: { sockets: { seat: { pos: [0, 0.5, 0], body: { action: "sit" } } } } });
  R("ann", "set", { id: "chair", component: "lock", value: true });
  R("ann", "create", { id: "cyshelf", model: "crate" }); R("ann", "set", { id: "cyshelf", component: "lock", value: true });
  const lb = R("dee", "create", { id: "deeseat", components: { parent: { to: "chair" }, socket: { name: "s2", body: { action: "sit" } } } });
  const lc = R("cy", "create", { id: "cyseat", components: { parent: { to: "chair" }, socket: { name: "s3", body: { action: "sit" } } } });
  const lm = R("cy", "set", { id: "chair", component: "sockets", value: { seat: { pos: [0, 0.5, 0], body: { action: "sit" } }, s5: { pos: [0, 1, 0] } } });
  ok(code(lb) === "locked" && code(lc) === "locked" && code(lm) === "locked" && JSON.stringify(kids("chair")) === '["seat"]', "SR1b an owner-locked host refuses a new socket: a builder with editOthers, another owner, and the legacy map alike", [lb.refused, lc.refused, lm.refused, kids("chair")]);
  // 3. squatting a name or the one driver on someone else's host: refused, so the owner's own later seat is taken
  R("bob", "create", { id: "bobcrate", model: "crate", components: { transform: { pos: [4, 0, 0] } } });
  const mine = R("bob", "create", { id: "bobhook", components: { parent: { to: "bobcrate" }, socket: { name: "drv", body: { action: "drive" } } } });
  const re = R("bob", "set", { id: "bobhook", component: "parent", value: { to: "car" } });
  const own = R("ann", "create", { id: "anndrv", components: { parent: { to: "car" }, socket: drv } });
  ok(mine.ok && code(re) === "rights" && own.ok && E("anndrv")?.socket?.name === "drv", "SR1c re-parenting your own socket onto someone else's host is refused (rights), so it can't squat a name or the driver: the owner's own drv is taken", [mine.refused, re.refused, own.refused]);
  const mk = R("bob", "create", { id: "bobmark", components: { parent: { to: "car" }, transform: { pos: [0, 1, 0] } } });
  const be = R("bob", "set", { id: "bobmark", component: "socket", value: { name: "mark", accepts: ["key"] } });
  ok(mk.ok && code(be) === "rights" && !E("bobmark")?.socket, "SR1c …nor make a bare thing of yours, hung on someone else's host, into a socket of it", [mk.refused, be.refused]);
  const rl = R("cy", "create", { id: "cyhook", components: { parent: { to: "car" }, socket: { name: "cyh" } } });
  const rl2 = R("cy", "set", { id: "cyhook", component: "parent", value: { to: "cyshelf" } });
  ok(rl.ok && code(rl2) === "locked" && E("cyhook")?.parent?.to === "car", "SR1c …and onto a host locked above you (locked)", [rl.refused, rl2.refused]);
  // 4. accepts capture: a foreign snap point on your thing, or a foreign socket's accepts rewritten
  R("ann", "create", { id: "rack", model: "crate", components: { transform: { pos: [-4, 0, 0] } } });
  const ac = R("bob", "create", { id: "bobsnap", components: { parent: { to: "rack" }, transform: { pos: [0, 1, 0] }, socket: { name: "grab", accepts: ["key"] } } });
  R("ann", "create", { id: "rack-hook", components: { parent: { to: "rack" }, transform: { pos: [0, 1, 0] }, socket: { name: "hook", accepts: ["coat"] } } });
  const as = R("bob", "set", { id: "rack-hook", component: "socket", value: { name: "hook", accepts: ["key"] } });
  const at = R("bob", "set", { id: "rack-hook", component: "transform", value: { pos: [0, 2, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } });
  ok(code(ac) === "rights" && code(as) === "rights" && code(at) === "rights" && JSON.stringify(E("rack-hook")?.socket?.accepts) === '["coat"]', "SR1d a builder without editOthers can't hang a snap point (accepts) on the owner's thing, nor rewrite or move the owner's socket", [ac.refused, as.refused, at.refused]);
  // the host's owner still may: bob seats his own crate, in either spelling; ann (owner) seats hers
  const ob = R("bob", "create", { id: "bobseat2", components: { parent: { to: "bobcrate" }, socket: { name: "back", body: { action: "sit" } } } });
  const om = R("bob", "set", { id: "bobcrate", component: "sockets", value: { drv: { pos: [0, 0.6, 0], body: { action: "drive" } }, back: { pos: [0, 0.5, 0], body: { action: "sit" } }, side: { pos: [0.5, 0.5, 0] } } });
  const hm = R("bob", "create", { id: "bobnew", model: "crate", components: { transform: { pos: [6, 0, 0] } } }) && R("bob", "batch", { ops: [{ verb: "create", args: { id: "bobnew2", model: "crate" } }, { verb: "create", args: { id: "bobnew2-s", components: { parent: { to: "bobnew2" }, socket: { name: "s" } } } }] });
  ok(ob.ok && om.ok && hm.ok && JSON.stringify(kids("bobcrate")) === '["back","drv","side"]', "SR1e the host's own builder still adds seats (natively, by the legacy map, and on a host made in the same batch)", [ob.refused, om.refused, hm.refused, kids("bobcrate")]);
}

// SR2 (review 10-12 S1-2, re-cut by R 10-15 22:48): a socket is an entity, so it meets the one entity budget like any
// other: capacity.entities for the world, capacity.guestEntities for all account-less people together (a guest is a fresh
// identity per connection), and at most SOCKETS_PER_HOST on one host. Only a write that adds is refused (full).
// review of #260: the byte limits count the UTF-8 bytes the log stores, not JavaScript's UTF-16 string length, so a value
// whose characters take two bytes each meets the same cap as ASCII
{ const W = () => openWorld(root, "utf8cap"); const R = (actor, verb, args) => { clock.advance(20000); const w = W(); w.kindOf = (id) => (id.startsWith("g") ? "anon" : "human"); return request(w, actor, verb, args); };
  R("ann", "create-world", { title: "utf8cap" }); R("ann", "set", { id: "@world", component: "default-role", value: { role: "builder", guests: "builder" } });
  R("ann", "create", { id: "u1", model: "crate" });
  const big = R("ann", "set", { id: "u1", component: "t/note", value: "é".repeat(40000) });   // 40 000 characters, 80 000 bytes: over the 64 KiB value cap
  const ascii = R("ann", "set", { id: "u1", component: "t/note", value: "e".repeat(40000) });   // the same length in ASCII fits
  // a set's act carries the request and its change the value, so 9 000 two-byte characters write about 36 000 bytes: over a
  // guest's 32 KiB a window, where the same length in ASCII (about 18 000) fits
  const guest = R("g1", "set", { id: "u1", component: "t/note", value: "é".repeat(9000) });
  const gAscii = R("g2", "set", { id: "u1", component: "t/note", value: "e".repeat(9000) });
  ok(code(big) === "too-big" && /80\d{3} bytes/.test(big.refused?.reason ?? "") && ascii.ok && code(guest) === "rate" && gAscii.ok,
    "UB1 a value's 64 KiB and a guest's 32 KiB a window are counted in UTF-8 bytes: two-byte characters reach them at half the length ASCII does", { big: big.refused ?? big.ok, ascii: ascii.ok ?? ascii.refused, guest: guest.refused ?? guest.ok, gAscii: gAscii.ok ?? gAscii.refused }); }
// review of #260: the index audit expects a switched-off thing to be out of the index, as buildIx leaves it
{ const R = (actor, verb, args) => { clock.advance(1000); return request(openWorld(root, "ixoff"), actor, verb, args); };
  R("ann", "create-world", { title: "ixoff" }); R("ann", "create", { id: "box1", model: "crate" }); const off = R("ann", "set", { id: "box1", component: "disabled", value: true });
  const audit = AUTH.indexAudit(openWorld(root, "ixoff"));
  ok(off.ok && Array.isArray(audit) && audit.length === 0, "IX1 a switched-off thing isn't an index defect", audit); }
// review of #260: following the full refusal's fix raises the one limit and keeps the others
{ const W = () => openWorld(root, "capfix"); const R = (actor, verb, args) => { clock.advance(2000); return request(W(), actor, verb, args); };
  R("ann", "create-world", { title: "capfix" }); R("ann", "set", { id: "@world", component: "capacity", value: { entities: 2, guestEntities: 7 } });
  R("ann", "create", { id: "c1", model: "crate" }); R("ann", "create", { id: "c2", model: "crate" }); const full = R("ann", "create", { id: "c3", model: "crate" });
  const m = /set (\{.*\})/.exec(full.refused?.fix ?? ""); const args = m ? Function(`return (${m[1].replace("<n>", "5")})`)() : null;
  const raised = args ? R("ann", "set", args) : null; const cap = W().state().entities["@world"].c.capacity;
  ok(full.refused?.code === "full" && raised?.ok && cap?.entities === 5 && cap?.guestEntities === 7, "SR0 the full refusal's fix, followed as written, raises entities and keeps guestEntities", { fix: full.refused?.fix, raised: raised?.ok ?? raised?.refused, cap }); }
{ const W = () => openWorld(root, "sockcap"); const R = (actor, verb, args) => { clock.advance(2000); const w = W(); w.kindOf = (id) => (id.startsWith("g") ? "anon" : "human"); return request(w, actor, verb, args); };
  const nSock = () => Object.values(W().state().entities).filter((e) => e.c.socket).length;
  const nEnt = () => Object.keys(W().state().entities).length - 1;
  R("ann", "create-world", { title: "sockcap" }); R("ann", "set", { id: "@world", component: "default-role", value: { role: "builder", guests: "builder" } });
  R("ann", "set", { id: "@world", component: "capacity", value: { guestEntities: 1000, entities: 2000 } });
  // the review's C1: fresh guest identities, one batch of 20 described sockets each, onto one guest's crate
  R("g1", "create", { id: "gbox", model: "crate" }); let n = 0, last = null;
  for (let i = 0; i < 40; i++) { const x = R(`g${i + 2}`, "batch", { ops: Array.from({ length: 20 }, (_, j) => ({ verb: "create", args: { id: `gs-${i}-${j}`, components: { parent: { to: "gbox" }, socket: { name: `n${i}x${j}` }, description: "x".repeat(500) } } })) }); if (x.ok) n += 20; else { last = x; break; } }
  ok(code(last) === "full" && n <= 64 && nSock() === n, "SR2a the review's C1 (a pool of guests, 20 described sockets a batch onto one crate) is refused full, at the host's ceiling", { n, last: last?.refused, sockets: nSock() });
  // the guests' pool, across hosts: their sockets and their things are one pool
  const guests0 = 1 + n; R("ann", "set", { id: "@world", component: "capacity", value: { guestEntities: guests0 + 30 } });
  let gn = 0, glast = null;
  for (let i = 0; i < 10; i++) { const host = `gh${i}`; R("ann", "create", { id: host, model: "crate", components: { transform: { pos: [i * 2, 0, 5] } } });
    const x = R(`g${100 + i}`, "batch", { ops: Array.from({ length: 8 }, (_, j) => ({ verb: "create", args: { id: `gp-${i}-${j}`, components: { parent: { to: host }, socket: { name: `p${j}` } } } })) }); if (x.ok) gn += 8; else { glast = x; break; } }
  const room = guests0 + 30 - (guests0 + gn);   // what the pool still holds: things fill it, and then a thing is refused like a socket
  const gFill = R("g200", "batch", { ops: Array.from({ length: room }, (_, j) => ({ verb: "create", args: { id: `gt-${j}`, model: "crate", components: { transform: { pos: [j * 2, 0, 9] } } } })) });
  const gThing = R("g201", "create", { id: "gthing", model: "crate", components: { transform: { pos: [0, 0, 12] } } });
  ok(code(glast) === "full" && /@world\.capacity\.guestEntities/.test(glast?.refused?.reason ?? "") && gn === 24 && room === 6 && gFill.ok && code(gThing) === "full", "SR2b account-less people together have at most capacity.guestEntities entities standing, sockets and things in one pool, across hosts (each a fresh identity)", { gn, room, glast: glast?.refused, gFill: gFill.refused, gThing: gThing.refused });
  const acct = R("ann", "create", { id: "acct-s", components: { parent: { to: "gh0" }, socket: { name: "a" } } });
  ok(acct.ok, "SR2b …an account still adds one", acct.refused);
  // …and a restart doesn't empty the pool: a guest's id lives only in the process that minted it (the directory never writes
  // one), so after a restart the earlier guests are ids nobody knows, and what they made still counts
  { const Wr = () => openWorld(root, "guestrestart"); let gone = new Set<string>();
    const Rr = (actor, verb, args) => { clock.advance(2000); const w = Wr(); w.kindOf = (id) => (gone.has(id) ? null : id.startsWith("g") ? "anon" : "human"); return request(w, actor, verb, args); };
    Rr("ann", "create-world", { title: "guestrestart" }); Rr("ann", "set", { id: "@world", component: "default-role", value: { role: "builder", guests: "builder" } });
    Rr("ann", "set", { id: "@world", component: "capacity", value: { guestEntities: 3 } });
    const before = ["g1", "g2", "g3"].map((g, i) => Rr(g, "create", { id: `gr-${i}`, model: "crate", components: { transform: { pos: [i * 2, 0, 0] } } }));
    gone = new Set(["g1", "g2", "g3"]);   // the restart: those three guests' ids are now unknown here
    const after = Rr("g4", "create", { id: "gr-4", model: "crate", components: { transform: { pos: [0, 0, 6] } } });
    const acct2 = Rr("ann", "create", { id: "gr-a", model: "crate", components: { transform: { pos: [2, 0, 6] } } });
    ok(before.every((x) => x.ok) && code(after) === "full" && /3 by creators this server doesn't know/.test(after.refused?.reason ?? "") && acct2.ok, "SR2c after a restart, what earlier guests made still counts against the guests' pool (their ids are unknown here now), and the refusal says so; an account still adds one", { before: before.map((x) => x.ok ?? x.refused), after: after.ok ?? after.refused, acct: acct2.ok ?? acct2.refused }); }
  // review of #260: the guests' pool is read as the world's own cap is, on the net change: a write that deletes as many of
  // the guests' things as it makes is never refused, and one that grows the pool past its limit is, saying by how much
  { const Wn = () => openWorld(root, "guestnet");
    const Rn = (actor, verb, args) => { clock.advance(2000); const w = Wn(); w.kindOf = (id) => (id.startsWith("g") ? "anon" : "human"); return request(w, actor, verb, args); };
    Rn("ann", "create-world", { title: "guestnet" }); Rn("ann", "set", { id: "@world", component: "default-role", value: { role: "builder", guests: "builder" } });
    Rn("ann", "set", { id: "@world", component: "capacity", value: { guestEntities: 2 } });
    const made = ["gn-0", "gn-1"].map((id, i) => Rn("g1", "create", { id, model: "crate", components: { transform: { pos: [i * 2, 0, 0] } } }));
    const swap = Rn("g1", "batch", { ops: [{ verb: "delete", args: { id: "gn-0" } }, { verb: "create", args: { id: "gn-2", model: "crate", components: { transform: { pos: [4, 0, 0] } } } }] });
    const grow = Rn("g1", "batch", { ops: [{ verb: "delete", args: { id: "gn-1" } }, ...["gn-3", "gn-4"].map((id, i) => ({ verb: "create", args: { id, model: "crate", components: { transform: { pos: [6 + i * 2, 0, 0] } } } }))] });
    // a pool already past a lowered cap still takes a delete-and-make; a make is refused against the lowered cap
    Rn("ann", "set", { id: "@world", component: "capacity", value: { guestEntities: 1 } });
    const swap2 = Rn("g1", "batch", { ops: [{ verb: "delete", args: { id: "gn-1" } }, { verb: "create", args: { id: "gn-5", model: "crate", components: { transform: { pos: [10, 0, 0] } } } }] });
    const over = Rn("g1", "create", { id: "gn-6", model: "crate", components: { transform: { pos: [12, 0, 0] } } });
    ok(made.every((x) => x.ok) && swap.ok && code(grow) === "full" && /1 more won't fit/.test(grow.refused?.reason ?? "") && /delete/.test(grow.refused?.fix ?? "")
      && swap2.ok && code(over) === "full" && /lets them have 1 \(/.test(over.refused?.reason ?? "") && /1 more won't fit/.test(over.refused?.reason ?? ""),
      "SR2d a guest's write that deletes as many of the guests' things as it makes is never refused full, even past a lowered cap; one that grows the pool past its limit is, saying how many it adds, and its fix names a delete", { made: made.map((x) => x.ok), swap: swap.refused ?? swap.ok, grow: grow.refused, swap2: swap2.refused ?? swap2.ok, over: over.refused }); }
  // the world's own budget: a socket meets it like a thing, and deleting frees room
  const have = nEnt(); R("ann", "set", { id: "@world", component: "capacity", value: { entities: have + 2 } });
  R("ann", "create", { id: "w-host", model: "crate", components: { transform: { pos: [0, 0, -5] } } });
  const one = R("ann", "create", { id: "w-s1", components: { parent: { to: "w-host" }, socket: { name: "a" } } });
  const two = R("ann", "create", { id: "w-s2", components: { parent: { to: "w-host" }, socket: { name: "b" } } });
  const thing = R("ann", "create", { id: "w-thing", model: "crate" });
  R("ann", "delete", { id: "w-s1" }); const three = R("ann", "create", { id: "w-s3", components: { parent: { to: "w-host" }, socket: { name: "c" } } });
  ok(one.ok && code(two) === "full" && /@world\.capacity\.entities/.test(two.refused?.reason ?? "") && code(thing) === "full" && three.ok && nEnt() === have + 2, "SR2c capacity.entities caps the world's entities, a socket the same as a thing (an owner sets it); a delete frees room", [one.refused, two.refused, thing.refused, three.refused]);
  ok(code(R("ann", "set", { id: "@world", component: "capacity", value: { entities: 1e6 } })) !== undefined && W().state().entities["@world"]?.c.capacity?.entities === have + 2, "SR2c …under the server's ceiling: an owner can't raise it past it");
  // one host's ceiling: an owner too
  R("ann", "set", { id: "@world", component: "capacity", value: { entities: 5000 } });
  R("ann", "create", { id: "big", model: "crate", components: { transform: { pos: [0, 0, -9] } } });
  const fill = R("ann", "batch", { ops: Array.from({ length: 64 }, (_, j) => ({ verb: "create", args: { id: `big-${j}`, components: { parent: { to: "big" }, socket: { name: `s${j}` } } } })) });
  const over = R("ann", "create", { id: "big-64", components: { parent: { to: "big" }, socket: { name: "s64" } } });
  const map = R("ann", "set", { id: "w-host", component: "sockets", value: Object.fromEntries(Array.from({ length: 70 }, (_, j) => [`m${j}`, { pos: [0, 1, 0] }])) });
  ok(fill.ok && code(over) === "full" && over.refused?.limit === 64 && code(map) === "full", "SR2d one host holds at most 64 sockets (SOCKETS_PER_HOST), whoever asks and in either spelling", [fill.refused, over.refused, map.refused]);
}
// SR2e: the load's lift carries what the log already holds: a pre-cut host with 70 slots keeps all 70 (a carry, not a request)
{ const slots = Object.fromEntries(Array.from({ length: 70 }, (_, j) => [`m${j}`, { pos: [0, 1, j * 0.01] }]));
  const old = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } }, { seq: 1, ts: 2, actor: "ann", verb: "grant", args: { id: "ann", role: "owner" } },
    { seq: 2, ts: 3, actor: "ann", verb: "spawn", args: { id: "wall", lib: "crate", pos: [0, 0, 0] } }, { seq: 3, ts: 4, actor: "ann", verb: "comp", args: { id: "wall", type: "sockets", data: slots } }];
  const out = translate(old, DOORKEYS()).out; const n0 = out.length;   // and the world's entity budget is already spent: 1 (the wall)
  const capv = { entities: 1, guestEntities: 0, avatar: 2000 }, ts = out[n0 - 1].ts + 1;   // an act and its change, as the precut helper below writes them
  out.push({ world: out[1].world, kind: "act", actor: "ann", verb: "set", body: { request: { id: "@world", component: "capacity", value: capv } }, ts },
    { world: out[1].world, kind: "change", actor: "ann", cause: n0, verb: "batch", body: { ops: [{ verb: "set", id: "@world", comp: "capacity", value: capv }] }, ts });
  fs.writeFileSync(root + "worlds/sockcap-lift.jsonl", out.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const lw = openWorld(root, "sockcap-lift"); const cap0 = lw.state().entities["@world"]?.c.capacity?.entities; let threw = null; try { maintain(lw); } catch (x) { threw = String(x?.message ?? x); }
  const st = openWorld(root, "sockcap-lift").state(); const n = Object.values(st.entities).filter((e) => e.c.parent?.to === "wall" && e.c.socket).length;
  ok(!threw && cap0 === 1 && n === 70 && st.entities.wall.c.sockets === undefined, "SR2e the load's lift is a carry: a pre-cut host of 70 slots lifts whole, past the per-host ceiling and past a spent capacity.entities (1)", { threw, n, cap0 }); }

// SRU (review 10-12 S2): undo across the load's lift. A pre-cut world: tbl has sockets {perch}, the bell is mounted on the
// perch. Its writer is the door's own (translate-v1, then acts appended as a pre-cut door stored them); the load lifts it.
const precut = (name, extra = [], acts = []) => {
  const old = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "ann", verb: "grant", args: { id: "ann", role: "owner" } }, { seq: 1, ts: 2, actor: "ann", verb: "grant", args: { id: "bob", role: "owner" } },
    { seq: 2, ts: 2, actor: "ann", verb: "spawn", args: { id: "tbl", lib: "table", pos: [2, 0, 3], yaw: 0.7 } },
    { seq: 3, ts: 3, actor: "ann", verb: "comp", args: { id: "tbl", type: "sockets", data: { perch: { pos: [0.45, 0.75, 0.25], yaw: 1.2 } } } },
    { seq: 4, ts: 4, actor: "ann", verb: "spawn", args: { id: "bell", lib: "bell", pos: [-5, 0, -5] } },
    { seq: 5, ts: 5, actor: "ann", verb: "mount", args: { id: "bell", to: "tbl", slot: "perch" } }, ...extra];
  const out = translate(old, DOORKEYS()).out; const wid = out[1].world;
  for (const [actor, ops] of acts) { const n = out.length; const ts = out[n - 1].ts + 1;   // an act and its change, as a pre-cut door wrote them
    out.push({ world: wid, kind: "act", actor, verb: ops.length > 1 ? "batch" : "set", body: { request: ops.length > 1 ? { ops } : { id: ops[0].id, component: ops[0].comp, value: ops[0].value } }, ts },
      { world: wid, kind: "change", actor, cause: n, verb: "batch", body: { ops: ops.map((o) => ({ verb: "set", ...o })) }, ts }); }
  fs.writeFileSync(root + `worlds/${name}.jsonl`, out.map((e) => JSON.stringify(e)).join("\n") + "\n"); return out; };
const nearly = (a, b, e = 1e-8) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) < e);
// SRU1 (S2-1): a pre-cut act moved the bell up 0.2 m on its perch (the transform in the HOST's frame, as stored then)
{ const W = () => openWorld(root, "sru1"); precut("sru1");
  const b0 = fold(readLog(fs.readFileSync(root + "worlds/sru1.jsonl"))).entities.bell.c;
  const moved = { pos: [b0.transform.pos[0], b0.transform.pos[1] + 0.2, b0.transform.pos[2]], q: b0.transform.q, scale: b0.transform.scale };
  precut("sru1", [], [["ann", [{ id: "bell", comp: "transform", value: moved }]]]);
  const before = worldT(fold(readLog(fs.readFileSync(root + "worlds/sru1.jsonl")).slice(0, -2)), "bell");
  maintain(W()); clock.advance(100); const u = request(W(), "ann", "undo", {});
  const st = W().state(); const after = worldT(st, "bell"); const on = st.entities[st.entities.bell.c.parent?.to]?.c.socket?.name;
  ok(u.ok && !(u.skipped?.length) && nearly(after.pos, before.pos) && nearly(after.q, before.q) && on === "perch", "SRU1 undo of a pre-cut move of cargo on a socket puts the bell back exactly (within 1e-8), still on the perch", { u: u.refused ?? u.skipped, before: before.pos, after: after.pos, on }); }

// SRU2 (S2-2): ann's pre-cut `set tbl.sockets {perch, seat}`; after the cut nobody writes that key, so other people's work on
// tbl's seats is creates and sets on its socket children. Undoing ann's edit must skip, as base did, not retire bob's work.
for (const [name, work] of [["sru2a", "hook"], ["sru2b", "perch"], ["sru2c", "delete"]]) {
  const W = () => openWorld(root, name);
  precut(name, [{ seq: 6, ts: 6, actor: "ann", verb: "comp", args: { id: "tbl", type: "sockets", data: { perch: { pos: [0.45, 0.75, 0.25], yaw: 1.2 }, seat: { pos: [0, 0.5, 0], sit: true } } } }]);
  maintain(W()); const R = (actor, verb, args) => { clock.advance(2000); return request(W(), actor, verb, args); };
  const kidOf = (n) => { const st = W().state(); return Object.keys(st.entities).find((k) => st.entities[k].c.parent?.to === "tbl" && st.entities[k].c.socket?.name === n); };
  const perch = kidOf("perch"), seat = kidOf("seat");
  const b = work === "hook" ? R("bob", "create", { id: "bobhook", components: { parent: { to: "tbl" }, transform: { pos: [0, 1, 0] }, socket: { name: "hook" } } })
    : work === "perch" ? R("bob", "set", { id: perch, component: "transform", value: { pos: [0.45, 0.95, 0.25], q: W().state().entities[perch].c.transform.q, scale: [1, 1, 1] } })
    : R("bob", "delete", { id: seat });
  const snap = JSON.stringify(Object.keys(W().state().entities).filter((k) => W().state().entities[k].c.parent?.to === "tbl").sort().map((k) => [k, W().state().entities[k].c]));
  const u = R("ann", "undo", {}); const st = W().state();
  const kept = JSON.stringify(Object.keys(st.entities).filter((k) => st.entities[k].c.parent?.to === "tbl").sort().map((k) => [k, st.entities[k].c])) === snap;
  ok(b.ok && kept && (code(u) === "conflict" || (u.notes ?? []).some((n) => n.skipped?.some((x) => x.id === "tbl" && x.component === "sockets" && x.by === "bob"))), `SRU2 ${work === "hook" ? "bob adds a socket" : work === "perch" ? "bob moves the perch" : "bob deletes the seat"} after the cut; ann's undo of her pre-cut sockets edit skips (bob changed it since), and every child of tbl is as bob left it`, { b: b.refused, u: u.ok ? { ok: true, skipped: u.skipped, notes: u.notes } : u.refused, kept }); }

// SRW (S2-3): the load's lift of a host the door would refuse today. Pre-cut: role-defs crew; a-chair's seat has body.who
// 'crew'; b-chair has a plain seat; crew is deleted. The lift re-spells what the log holds (a carry: no re-judging
// historical values), and one host that fails anyway doesn't stop the hosts after it: it's said, per host, to the caller.
{ const old = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } }, { seq: 1, ts: 2, actor: "ann", verb: "grant", args: { id: "ann", role: "owner" } },
    { seq: 2, ts: 3, actor: "ann", verb: "spawn", args: { id: "a-chair", lib: "crate", pos: [0, 0, 0] } }, { seq: 3, ts: 4, actor: "ann", verb: "spawn", args: { id: "b-chair", lib: "crate", pos: [3, 0, 0] } },
    { seq: 4, ts: 5, actor: "ann", verb: "spawn", args: { id: "c-chair", lib: "crate", pos: [6, 0, 0] } }];
  const write = (name, ops) => { const out = translate(old, DOORKEYS()).out; const wid = out[1].world;
    for (const o of ops) { const n = out.length; const ts = out[n - 1].ts + 1; const req = o.verb === "delete" ? { id: o.id, component: o.comp } : { id: o.id, component: o.comp, value: o.value };
      out.push({ world: wid, kind: "act", actor: "ann", verb: o.verb, body: { request: req }, ts }, { world: wid, kind: "change", actor: "ann", cause: n, verb: o.verb, body: { id: o.id, comp: o.comp, ...(o.verb === "set" ? { value: o.value } : {}) }, ts }); }
    fs.writeFileSync(root + `worlds/${name}.jsonl`, out.map((e) => JSON.stringify(e)).join("\n") + "\n"); };
  const seat = (extra = {}) => ({ seat: { pos: [0, 0.5, 0], body: { action: "sit", ...extra } } });
  write("srw1", [{ verb: "set", id: "@world", comp: "role-defs", value: { crew: { name: "Crew", rank: 150, can: { build: true } } } },
    { verb: "set", id: "a-chair", comp: "sockets", value: seat({ who: "crew" }) }, { verb: "set", id: "b-chair", comp: "sockets", value: seat() }, { verb: "delete", id: "@world", comp: "role-defs" }]);
  let threw = null, out = null; try { out = maintain(openWorld(root, "srw1")).steps.lift; } catch (x) { threw = String(x?.message ?? x).slice(0, 200); }
  const st = openWorld(root, "srw1").state(); const kids = (h) => Object.values(st.entities).filter((e) => e.c.parent?.to === h && e.c.socket).length;
  clock.advance(100); const sit = request(openWorld(root, "srw1"), "ann", "use", { id: "b-chair", action: "sit" });
  ok(!threw && kids("a-chair") === 1 && kids("b-chair") === 1 && !st.entities["a-chair"].c.sockets && !st.entities["b-chair"].c.sockets && sit.ok, "SRW1 a seat whose who names a role since deleted lifts anyway (the lift is a carry), and so does the healthy host after it", { threw, out, a: kids("a-chair"), b: kids("b-chair"), sit: sit.refused });
  // a host the lift can't WRITE (here: the first append for it throws, as a full disk would) is not a refused host: the line's
  // disk state is unknown, so the throw PROPAGATES out of maintain (review r14 H1, 10-18; the caller reports ambiguous) and
  // nothing is lifted in that run. A refusal (the door's) is still per host: SRW1 above.
  write("srw2", [{ verb: "set", id: "a-chair", comp: "sockets", value: seat() }, { verb: "set", id: "b-chair", comp: "sockets", value: seat() }, { verb: "set", id: "c-chair", comp: "sockets", value: seat() }]);
  const w2 = openWorld(root, "srw2"); const real = w2.append.bind(w2); let n = 0; w2.append = (e, ...more) => { if (e.kind === "act" && e.verb === "lift-sockets" && e.body?.id === "a-chair" && !n++) throw new Error("disk full"); return real(e, ...more); };
  let t2 = null, o2 = null; try { const m2 = maintain(w2).steps.lift; o2 = [...m2.made, ...m2.failed]; } catch (x) { t2 = String(x?.message ?? x); }
  const s2 = openWorld(root, "srw2").state(); const k2 = (h) => Object.values(s2.entities).filter((e) => e.c.parent?.to === h && e.c.socket).length;
  ok(/disk full/.test(t2 ?? "") && o2 === null && k2("a-chair") === 0 && k2("b-chair") === 0 && k2("c-chair") === 0 && !!s2.entities["a-chair"].c.sockets, "SRW2 a host whose lift's WRITE throws (disk full) is not reported as a refused host: the throw propagates out of maintain (ambiguous to the caller, r14 H1), and nothing was written in that run", { t2, o2, a: k2("a-chair"), b: k2("b-chair"), c: k2("c-chair") });
  const again = maintain(openWorld(root, "srw2")).steps.lift.made; const s3 = openWorld(root, "srw2").state();
  ok(["a-chair", "b-chair", "c-chair"].every((h) => again.some((x) => x.host === h && x.made) && Object.values(s3.entities).filter((e) => e.c.parent?.to === h && e.c.socket).length === 1), "SRW2 …and the next maintenance run (the disk back) lifts all three", again); }

// LG1 (a grep-pin, as nonumber-check is): past the door nothing reads the old spelling. The authority's state readers name
// socket children; only authority/sockets.js (the translator and the load's lift) reads a stored `sockets` map, a
// parent {to, socket} or a home's socket
{ const dir = fileURLToPath(new URL("../../shared/protocol/", import.meta.url));
  const files = ["authority.js", ...fs.readdirSync(dir + "authority").filter((f) => f.endsWith(".js") && f !== "sockets.js").map((f) => `authority/${f}`)];
  const OLD = /\bc\??\.sockets\b|\bparent\??\.socket\b|\bhome\??\.parent\??\.socket\b|\.sockets\?\.\[|modelOf\([^)]*\)\??\.sockets\b|\bm\??\.sockets\b/;
  const hits = files.flatMap((f) => fs.readFileSync(dir + f, "utf8").split("\n").map((l, i) => [f, i + 1, l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/ .*$/, "")]).filter(([, , l]) => OLD.test(l)));
  ok(!hits.length, `LG1 no reader of the old spelling outside authority/sockets.js (${files.length} files)`, hits.map(([f, n, l]) => `${f}:${n}: ${String(l).trim().slice(0, 100)}`)); }
// LG1b (review 10-12 S3-4): …nor anywhere a client, an agent or a shared reader looks: shared/, client/lib, mcpl. The few
// that read a map on purpose are named, each with why: the Inspector's Sockets card reads (and writes) the map that
// socketMapIn builds FROM the children until the Parts UI (12b); a blueprint's own records keep their spelling (11/12);
// hierarchy.js socketOf/localOf read a record in the old spelling (a v1 fold's: the M checks draw v1 by it; a blueprint's
// parts); grab.js's home shape check accepts the old field (the door lifts it first)
{ const root = fileURLToPath(new URL("../../", import.meta.url));
  const walk = (d) => fs.readdirSync(root + d, { withFileTypes: true }).flatMap((x) => x.isDirectory() ? (x.name === "node_modules" || x.name === "vendor" ? [] : walk(`${d}/${x.name}`)) : /\.(js|mjs|ts)$/.test(x.name) ? [`${d}/${x.name}`] : []);
  const files = [...walk("shared"), ...walk("client/lib"), ...walk("mcpl")].filter((f) => f !== "shared/protocol/authority/sockets.js");
  const OLD = /\b(c|comp|m)\??\.sockets\b|\.sockets\?\.\[|modelOf\([^)]*\)\??\.sockets\b|\b(parent|rel)\??\.socket\b|\bhome\??\.parent\??\.socket\b/;
  const ON_PURPOSE = [["shared/editschema.js", /withSocketMap|ent\.comp\?\.sockets\)|c\.sockets\b/], ["shared/blueprint.js", /rel\.socket/], ["shared/hierarchy.js", /rel\??\.socket/], ["shared/grab.js", /h\.parent\.socket/]];
  const hits = files.flatMap((f) => fs.readFileSync(root + f, "utf8").split(/\r?\n/).map((l, i) => [f, i + 1, l.replace(/^\s*(\/\/|\*|\/\*\*).*$/, "").replace(/\s\/\/ .*$/, "")])
    .filter(([, , l]) => OLD.test(l) && !ON_PURPOSE.some(([pf, re]) => pf === f && re.test(l))));
  ok(files.length > 100 && !hits.length, `LG1b no reader of the old spelling in shared/, client/lib or mcpl but the named ones (${files.length} files)`, hits.map(([f, n, l]) => `${f}:${n}: ${String(l).trim().slice(0, 100)}`)); }

// ---- TC: training-consent is gone (R 10-16 14:16: what a server may do with a world's log is that server's terms, not a
// component). The name is refused like any unregistered bare name, keyed or bare, for everyone; an owner's rollback of a
// person takes back all of their work (no own-word skip remains).
{ const name = "trainconsent";
  const call = callAt(name);
  const c = () => openWorld(root, name).state().entities["@world"]?.c ?? {};
  call("olive", "create-world", { title: "consent" });
  call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "inhabitant" } });
  const bare = call("olive", "set", { id: "@world", component: "training-consent", value: { allow: true } });
  const own = call("vic", "set", { id: "@world", component: "training-consent:vic", value: { allow: true } });
  const ownerKeyed = call("olive", "set", { id: "@world", component: "training-consent:olive", value: { allow: true } });
  ok(code(bare) === "schema" && code(ownerKeyed) === "schema" && !own.ok && !Object.keys(c()).some((k) => k.startsWith("training-consent")),
    "TC1 training-consent isn't a component: bare or keyed, by an owner or by the person it names, it's refused", [bare.refused, own.refused, ownerKeyed.refused]);
  call("olive", "set", { id: "@world", component: "default-role", value: { role: "builder" } });
  const mark = call("olive", "set", { id: "@world", component: "about", value: { name: "mark", text: "" } });
  for (let i = 0; i < 3; i++) call("gil", "create", { id: `junk-${i}`, model: "crate" });
  const rb = call("olive", "undo", { actor: "gil", since: { seq: mark.seq, head: mark.head } });
  const left = Object.keys(openWorld(root, name).state().entities).filter((k) => k.startsWith("junk-"));
  ok(rb.ok && !left.length && !JSON.stringify(rb).includes("skipped"), "TC2 the owner's rollback of someone takes back all their work, nothing skipped", [rb.refused ?? rb.notes, left]); }

// ---- BT: a batch checks every child request against its verb's arguments before building anything (review of PR #260,
// verbs.js:127; Antra's repro): a delete with a misspelt `componnent` was ok:true and deleted the whole entity, children too
{ const name = "batchtypo";
  const call = callAt(name);
  const ents = () => openWorld(root, name).state().entities;
  call("olive", "create-world", { title: "batch typo" });
  call("olive", "create", { id: "lamp", model: "crate", components: { description: "a lamp" } });
  call("olive", "create", { id: "shade", model: "crate", components: { parent: { to: "lamp" } } });
  const n0 = openWorld(root, name).entries.length;
  const r = call("olive", "batch", { ops: [{ verb: "delete", args: { id: "lamp", componnent: "description" } }] });
  ok(!r.ok && code(r) === "unknown-arg" && r.refused?.op === 0 && ents().lamp && ents().shade, "BT1 batch delete {id, componnent} is refused unknown-arg (op 0), as it is outside a batch; the entity and its child stay", [r.refused ?? r, !!ents().lamp, !!ents().shade]);
  const r2 = call("olive", "batch", { ops: [{ verb: "set", args: { id: "lamp", component: "description", value: "ok" } }, { verb: "create", args: { model: "crate", place: { on: "lamp", oops: 1 } } }] });
  ok(!r2.ok && code(r2) === "unknown-arg" && r2.refused?.op === 1 && ents().lamp?.c?.description === "a lamp", "BT2 a nested create.place is checked too, and an earlier valid op isn't written", [r2.refused ?? r2, ents().lamp?.c?.description]);
  const changes = openWorld(root, name).entries.slice(n0).filter((e) => e.kind === "change").length;
  ok(changes === 0, "BT3 neither refused batch wrote a change", changes);
  // the verbs batch's help names are the verbs it takes (review of #260): help listed turn, which the batch refused
  const q = () => ents().lamp?.c?.transform?.q;
  const q0 = JSON.stringify(q()), n1 = openWorld(root, name).entries.length;
  const tr = call("olive", "batch", { ops: [{ verb: "turn", args: { id: "lamp", axis: "y", deg: 90 } }, { verb: "set", args: { id: "lamp", component: "description", value: "turned" } }], label: "spin" });
  const acts = openWorld(root, name).entries.slice(n1).filter((e) => e.kind === "change").length;
  const turned = JSON.stringify(q()) !== q0 && Math.abs(Math.abs(q()?.[1] ?? 0) - Math.SQRT1_2) < 1e-6;
  const un = call("olive", "undo", { label: "spin" });
  ok(tr.ok && turned && acts === 1 && un.ok && JSON.stringify(q()) === q0 && ents().lamp?.c?.description === "a lamp",
    "BT4 a batch takes turn: the turn and a set are one act, and one undo takes both back", { tr: tr.refused ?? tr.ok, q: q(), acts, un: un.refused ?? un.ok });
  // a turn reads the batch's working copy: a thing made earlier in the same batch is found and turned
  const ct = call("olive", "batch", { ops: [{ verb: "create", args: { id: "crate-bt", model: "crate", components: { transform: { pos: [3, 0, 3] } } } }, { verb: "turn", args: { id: "crate-bt", axis: "y", deg: 90 } }] });
  const cq = ents()["crate-bt"]?.c?.transform?.q;
  ok(ct.ok && Math.abs(Math.abs(cq?.[1] ?? 0) - Math.SQRT1_2) < 1e-6, "BT4b a batch's turn finds a thing made earlier in the same batch and turns it", { ct: ct.refused ?? ct.ok, q: cq });
  // each verb the help names, with args it accepts alone, dry: a verb named here without args below fails the row too
  const ARGS = { create: { model: "crate" }, set: { id: "lamp", component: "description", value: "x" }, delete: { id: "shade" }, place: { id: "shade", on: "lamp" },
    turn: { id: "lamp", axis: "y", deg: 10 }, sky: { hours: 7 }, weather: { hours: 7 } };
  const named = (VERBSPEC.batch.doc.match(/ of ([a-z-]+(?:, [a-z-]+)*)$/)?.[1] ?? "").split(", ").filter(Boolean);
  const alone = Object.fromEntries(named.map((v) => [v, ARGS[v] ? call("olive", v, { ...ARGS[v], dry: true }) : null]));
  const inBatch = Object.fromEntries(named.map((v) => [v, ARGS[v] ? call("olive", "batch", { ops: [{ verb: v, args: ARGS[v] }], dry: true }) : null]));
  const turnedAway = named.filter((v) => !alone[v]?.ok || !inBatch[v]?.ok);
  ok(named.length >= 5 && !turnedAway.length, "BT5 every verb batch's help names goes in a batch, dry, as it goes alone", { named, turnedAway: turnedAway.map((v) => [v, alone[v]?.refused ?? alone[v]?.ok, inBatch[v]?.refused ?? inBatch[v]?.ok]) }); }

// ---- RA (review of #260): a log changed outside the purge rule refuses writes, but not the operator's or a read ----
{ const name = "altered"; const file = `${root}worlds/${name}.jsonl`;
  const call = callAt(name);
  const opr = (actor, verb, args = {}) => { clock.advance(100); return operatorRepair(openWorld(root, name), actor, verb, args); };
  call("olive", "create-world", { title: "altered" }); call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "owner" } });
  call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "inhabitant" } });
  // strip the roles: value to a commit, with no purge: as a copy of the log changed by hand would hold it
  const lines = fs.readFileSync(file, "utf8").split("\n"); const k = lines.findLastIndex((l) => l.includes('"roles:bob"') && l.includes('"kind":"change"'));
  const e = JSON.parse(lines[k]); const { value, salt, ...rest } = e.body; e.body = { ...rest, commit: "0".repeat(64) }; lines[k] = JSON.stringify(e); fs.writeFileSync(file, lines.join("\n"));
  const w = openWorld(root, name); const role = w.state().entities["@world"].c["roles:bob"];
  const before = entityBefore(w, "@world", w.entries.length)?.c["roles:bob"];   // undo's reading of the past agrees with the fold
  const write = call("olive", "create", { model: "crate" }), read = call("olive", "look", {});
  const op = opr("opal", "set", { id: "@world", component: "access", value: { join: "anyone" } });
  // the house's markup (#260 10-20), accepted: detecting the stripped value is §12's bone; refusing everyone's writes on that
  // record until it's restored was a policy no world asked for, so it came out with the recut
  ok(role === PURGED && before === PURGED && write.ok && read.ok && op.ok && w.state().diagnostics.some(([q, c]) => q === k && c === "commit-unpurged"),
    "RA1 a value stripped to its commit with no purge reads as unknown and the fold names the line (commit-unpurged); writes and reads go on, and so does the operator's repair", { role, before, write: write.refused, read: read.ok, op: op.ok ?? op.refused, k }); }
// ---- RA2 (review of #260): a state view that already folded the log meets a new line holding a value stripped to its
// commit: it reads the whole log again, as the fold reads such a line, rather than throwing out of the state getter ----
{ const name = "altered-live";
  const call = callAt(name);
  call("olive", "create-world", { title: name }); call("olive", "create", { id: "sign", model: "crate", components: { label: "hello" } });
  const w = openWorld(root, name); w.state();   // folded once: the next new plain lines are applied incrementally
  const L = w.entries, last = L[L.length - 1], at = L.length;
  const line = (e) => { const x = readLog(JSON.stringify(e) + "\n")[0]; Object.defineProperty(x, "seq", { value: L.length, enumerable: false, configurable: true }); L.push(x); };
  line({ world: last.world, kind: "change", ts: last.ts + 1, actor: "olive", cause: at - 1, verb: "set", body: { id: "sign", comp: "label", commit: "0".repeat(64) } });
  let st1 = null, err = null; try { st1 = w.state(); } catch (x) { err = `${x?.constructor?.name}: ${x?.message}`.slice(0, 120); }
  line({ world: last.world, kind: "purge", ts: last.ts + 2, actor: "system", verb: "purge", body: { values: [{ seq: at }] } });
  const st2 = err ? null : w.state();
  ok(!err && st1?.entities.sign.c.label === PURGED && st1.diagnostics.some(([q, c]) => q === at && c === "commit-unpurged") && st2?.entities.sign.c.label === PURGED && !st2.diagnostics.some(([, c]) => c === "commit-unpurged"),
    "RA2 a new line with a value stripped to its commit, after the state was folded, reads as unknown (commit-unpurged until a purge names it), not a throw from the state view", { err, label: st1?.entities?.sign?.c?.label, d1: st1?.diagnostics?.slice(-2), d2: st2?.diagnostics?.slice(-2) }); }
// ---- OP: a server operator's recorded repair (review of PR #260, server.ts:742: a server operator entered but could mend nothing).
// operatorRepair is NARROW (@world's roles/access/default-role/role-defs, unban) and RECORDED (the operator's act, body
// operator: true; the moderator-log record likewise); the operator's ordinary requests stay what their role here allows.
{ const name = "oprepair";
  const call = callAt(name);
  const opr = (actor, verb, args = {}) => { clock.advance(100); return operatorRepair(openWorld(root, name), actor, verb, args); };
  const wc = () => openWorld(root, name).state().entities["@world"]?.c ?? {};
  call("olive", "create-world", { title: "orphaned" });
  call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "inhabitant" } });
  call("olive", "ban", { who: "opal", reason: "a mistake" });
  call("olive", "set", { id: "@world", component: "access", value: { join: "listed" } });
  // the operator as an ordinary asker: banned here, so refused; and as a visitor they could not grant ownership anyway
  const plain = call("opal", "set", { id: "@world", component: "roles:bob", value: { role: "owner" } });
  const plainUnban = call("opal", "unban", { who: "opal" });
  ok(code(plain) === "banned" && code(plainUnban) === "banned" && wc()["roles:bob"]?.role === "inhabitant", "OP1 (control) the operator's ordinary requests are the world's to judge: banned here, refused", [plain.refused, plainUnban.refused]);
  const grant = opr("opal", "set", { id: "@world", component: "roles:bob", value: { role: "owner" } });
  const lift = opr("opal", "unban", { who: "opal" });
  const door = opr("opal", "set", { id: "@world", component: "access", value: { join: "anyone" } });
  const w2 = openWorld(root, name); const acts = w2.entries.filter((e) => e.kind === "act" && e.actor === "opal" && e.body?.operator === true);
  const modRec = w2.mod.find((m) => m.verb === "unban" && m.who === "opal");
  ok(grant.ok && lift.ok && door.ok && wc()["roles:bob"]?.role === "owner" && wc().access?.join === "anyone" && !isBanned(w2, "opal"),
    "OP2 operatorRepair mends roles (grants an owner), lifts a ban (their own, too) and repairs access", [grant.refused, lift.refused, door.refused, wc()["roles:bob"], wc().access]);
  ok(acts.length === 2 && acts.every((e) => ["set"].includes(e.verb)) && modRec?.actor === "opal" && modRec?.operator === true,
    "OP3 every repair is recorded with operator authorship: the operator's act carries operator: true, the unban's moderator-log record too", [acts.map((e) => [e.verb, e.body]), modRec]);
  const narrow = [opr("opal", "create", { model: "crate" }), opr("opal", "set", { id: "@world", component: "about", value: { name: "x", text: "" } }),
    opr("opal", "ban", { who: "bob" }), opr("opal", "set", { id: "lamp", component: "roles:bob", value: { role: "owner" } })];
  ok(narrow.every((r) => code(r) === "rights"), "OP4 it is narrow: a create, another @world component, a ban, a roles key off @world are all refused (rights)", narrow.map((r) => r.refused?.reason ?? r));
  const last = opr("opal", "delete", { id: "@world", component: "roles:olive" }), last2 = opr("opal", "delete", { id: "@world", component: "roles:bob" });
  const afterOwners = Object.entries(wc()).filter(([k, v]) => k.startsWith("roles:") && v?.role === "owner").length;
  ok(last.ok && code(last2) === "last-owner" && afterOwners === 1, "OP5 not god mode: the world's own checks still hold (the last owner can't be removed)", [last.refused, last2.refused, afterOwners]); }

// ---- ST: persist before publishing (review of PR #260, storage.js:110; Antra's repro): a line whose durable write throws
// never reaches memory (the live chain never runs ahead of the disk), and the file, its state now unknown, takes no more
// writes until it is reopened. The moderator log likewise.
{ let failing = true; const lines: string[] = [], mods: object[] = [];
  const w = worldOf({ name: "st", entries: [], custody: custodyAt(root + "keys/custody.json"), getBlob: () => { throw new Error("no blobs"); }, putBlob: () => "sha256:" + "0".repeat(64), now: () => clock.t,
    writeLine: (l: string) => { if (failing) throw new Error("EIO: disk gone"); lines.push(l); },
    appendMod: (r: object) => { if (failing) throw new Error("EIO: disk gone"); mods.push(r); } });
  let threw: any = null; try { request(w, "olive", "create-world", { title: "st" }); } catch (x) { threw = x; }
  ok(threw && /EIO/.test(String(threw?.message)) && w.entries.length === 0 && !w.exists, "ST1 writeLine throws: the append throws and the entry never reaches memory (entries.length stays 0)", [String(threw?.message), w.entries.length]);
  failing = false; let again: any = null; try { request(w, "olive", "create-world", { title: "st" }); } catch (x) { again = x; }
  ok(again && /earlier write failed/.test(String(again?.message)) && w.entries.length === 0 && lines.length === 0, "ST2 after a failed write the log takes no more lines (its state on disk is unknown) until the world is reopened", [String(again?.message), w.entries.length, lines.length]);
  failing = true; let mthrew: any = null; try { w.appendMod({ actor: "olive", verb: "warn", who: "bob" }); } catch (x) { mthrew = x; }
  ok(mthrew && w.mod.length === 0, "ST3 a moderator-log write that throws never reaches the live moderation list", [String(mthrew?.message), w.mod.length]); }
// ST4 (r14 M2, 10-18): the transaction outcome reads the MODERATOR log's wedge too: a ban/mute/kick writes world.mod.jsonl only, so a
// throw from that durable write is ambiguous (its bytes may be on disk), never "rolled-back"
{ const { txnOutcome, txnRefusal } = await import("../../shared/protocol/authority/storage.js");
  let failing = false; const lines: string[] = [];
  const w = worldOf({ name: "st4", entries: [], custody: custodyAt(root + "keys/custody.json"), getBlob: () => { throw new Error("no blobs"); }, putBlob: () => "sha256:" + "0".repeat(64), now: () => clock.t,
    writeLine: (l: string) => { lines.push(l); }, appendMod: () => { if (failing) throw new Error("EIO: disk gone"); } });
  request(w, "olive", "create-world", { title: "st4" }); const from = w.entries.length;
  failing = true; let threw: any = null; try { w.appendMod({ actor: "olive", verb: "ban", who: "bob" }); } catch (x) { threw = x; }
  const o = txnOutcome(w, from, { threw: true, refused: false, wedgedBefore: { log: false, mod: false } }); const r = txnRefusal(o);
  ok(!!threw && o.outcome === "ambiguous" && o.wedged === true && o.file === "moderator log" && r.ok === false && r.txn === "ambiguous" && r.refused.code === "ambiguous" && /moderator log/.test(r.refused.reason),
    "ST4 a moderator-log write that throws makes the request AMBIGUOUS (txnOutcome reads the mod log's wedge; the refusal names the moderator log), never rolled-back", [o, r.refused]);
  const o2 = txnOutcome(w, w.entries.length, { threw: true, refused: false, wedgedBefore: { log: false, mod: true } });
  ok(o2.outcome === "rolled-back", "ST4 …and a throw on a world already wedged (its refusal before any write) is rolled back", o2);
  // …and only the wedge's own refusal is answered as the wedge: another throw on the same world (a bug elsewhere) is a plain
  // failure, so its reply doesn't say the world refuses writes, nor that asking again won't help
  let again: any = null; try { w.appendMod({ actor: "olive", verb: "ban", who: "bob" }); } catch (x) { again = x; }
  const oW = txnOutcome(w, w.entries.length, { threw: true, error: again, refused: false, wedgedBefore: { log: false, mod: true } }), rW = txnRefusal(oW);
  const oX = txnOutcome(w, w.entries.length, { threw: true, error: new Error("a handler's bug"), refused: false, wedgedBefore: { log: false, mod: true } }), rX = txnRefusal(oX);
  ok(again?.wedged === "moderator log" && oW.wedged === true && oW.file === "moderator log" && /moderation writes/.test(rW.refused.reason) && /whoever runs this server/.test(rW.refused.fix)
    && !oX.wedged && /send it again/.test(rX.refused.fix) && !/refuses/.test(rX.refused.reason),
    "ST4b the moderator log's wedge refusal is answered as the wedge (who can reopen it); another throw while it is wedged is a plain failure", { oW, w: rW.refused, oX, x: rX.refused }); }
// ST5: which file was wedged matters: with the moderator log wedged before the request, a world-log write that throws in it
// is ambiguous, not the old wedge's rolled-back refusal
{ const { txnOutcome, wedgedOf } = await import("../../shared/protocol/authority/storage.js");
  let modFails = false, logFails = false;
  const w = worldOf({ name: "st5", entries: [], custody: custodyAt(root + "keys/custody.json"), getBlob: () => { throw new Error("no blobs"); }, putBlob: () => "sha256:" + "0".repeat(64), now: () => clock.t,
    writeLine: () => { if (logFails) throw new Error("EIO: disk gone"); }, appendMod: () => { if (modFails) throw new Error("EIO: disk gone"); } });
  request(w, "olive", "create-world", { title: "st5" });
  modFails = true; try { w.appendMod({ actor: "olive", verb: "ban", who: "bob" }); } catch {}
  const before = wedgedOf(w); const from = w.entries.length;
  logFails = true; let threw: any = null; try { request(w, "olive", "set", { id: "@world", component: "about", value: { name: "st5b", text: "" } }); } catch (x) { threw = x; }
  const o = txnOutcome(w, from, { threw: true, refused: false, wedgedBefore: before });
  ok(o.outcome === "ambiguous" && o.wedged === true && o.file === undefined, "ST5 a world-log failure while only the moderator log was wedged is ambiguous, and names the world log", { o, threw: String(threw) }); }

// RF1: a reactions key that is itself "*" is a key, not a second wildcard: refsOf names both handlers' targets and ends
{ const { refsOf } = await import("../../shared/protocol/componentspec.js"); let refs: any = null, threw: any = null;
  try { refs = refsOf("reactions", { "*": { kind: "set", targets: ["lamp"] }, ring: { kind: "set", targets: ["bell"] } }); } catch (x) { threw = String(x).slice(0, 80); }
  ok(!threw && JSON.stringify(refs?.map((r: any) => r.id).sort()) === '["bell","lamp"]', "RF1 refsOf reads a handler keyed \"*\" as that key, and ends", { refs, threw }); }
// RF2: …reached from requests: a handler keyed "*", set by request, that resets a ball, then the ball's delete, whose follow-ups read
// every reference to it
{ const name = "rf2";
  const call = callAt(name);
  call("olive", "create-world", { title: "rf2" }); call("olive", "create", { id: "box", model: "crate", place: { at: [1, 1] } }); call("olive", "create", { id: "ball", model: "crate", place: { at: [2, 2] } });
  const set = call("olive", "set", { id: "box", component: "reactions", value: { "*": { kind: "reset", targets: ["ball"] } } }); let del: any = null, threw: any = null;
  try { del = call("olive", "delete", { id: "ball" }); } catch (x) { threw = String(x).slice(0, 80); }
  ok(set.ok && !threw && del?.ok, "RF2 deleting a thing a handler keyed \"*\" names is answered", { set: set.ok, del: del?.ok ?? del, threw }); }
// RX1: a refusal's remedy is one the asker can follow: a dynamic thing's look-at names a kind of body that may turn to
// face something (a part's look-at is refused alike, so "put it on a part" was no remedy)
{ const name = "rx1";
  const call = callAt(name);
  call("olive", "create-world", { title: "rx1" }); call("olive", "create", { id: "ball", model: "crate", components: { physics: { kind: "dynamic" } }, place: { at: [1, 1] } });
  const look = call("olive", "set", { id: "ball", component: "look-at", value: { target: "@viewer" } });
  const kin = call("olive", "set", { id: "ball", component: "physics", value: { kind: "kinematic" } }); const look2 = call("olive", "set", { id: "ball", component: "look-at", value: { target: "@viewer" } });
  ok(look?.refused?.code === "conflict" && !/on a part/.test(look.refused.fix) && /kinematic/.test(look.refused.fix) && kin.ok && look2.ok,
    "RX1 the dynamic look-at refusal names static or kinematic, and a kinematic one may look", { look: look?.refused, kin: kin.ok, look2: look2.ok ? "ok" : look2.refused }); }
// RX2: sculpt on a thing with no grid says there's nothing to sculpt, and doesn't send the reader to write terrain-grid,
// a reserved name the gate refuses
{ const name = "rx2";
  const call = callAt(name);
  call("olive", "create-world", { title: "rx2" }); call("olive", "create", { id: "hill", model: "crate", place: { at: [1, 1] } });
  const sc = call("olive", "sculpt", { on: "hill", brush: { kind: "raise" }, path: [[1, 1]] });
  const grid = call("olive", "set", { id: "hill", component: "terrain-grid", value: { spacing: 0.5, tile: 32, origin: [0, 0], extent: [1, 1], limits: { raise: 100, lower: 100 } } });
  ok(sc?.refused?.code === "no-grid" && !/set \{id, component: 'terrain-grid'/.test(sc.refused.fix ?? "") && grid?.refused?.code === "reserved", "RX2 the no-grid refusal names no write of terrain-grid, which is refused as reserved", { sc: sc?.refused, grid: grid?.refused?.code }); }
// CAR: a captioner's lines are its own requests, charged to it like any write: past the entries cap in the window, refused rate
{ const name = "car";
  const cw = callAt(name);
  cw("ann", "create-world", { title: "car" }); cw("ann", "create", { id: "screen", model: "crate", place: { at: [0, 0] } });
  cw("ann", "set", { id: "screen", component: "captioners", value: { ids: ["vic"] } });
  const sess = "2026-10-07T00:00:00.000Z-abc123"; let first = null, n = 0;
  for (n = 1; n <= 70 && !first; n++) { const r = cw("vic", "caption", { id: "screen", session: sess, n, t0: n, t1: n + 1, text: `line ${n}` }); if (!r.ok) first = { n, code: r.refused?.code }; }
  ok(first?.code === "rate" && first.n <= 61, "CAR a captioner past the entries cap in the window is refused rate", first); }
// SP1: a thing so far out that its cells aren't safe integers goes on the big list, not into a loop that can't advance
// (x++ at 2^53 stays put), nor under a key that collides (cellKey covers ±1e6 cells)
{ const { cellsOf } = await import("../../shared/protocol/authority/spatial.js");
  const far = cellsOf({ q: { min: [1e17, 0, 0], max: [1e17 + 64, 0, 1] } }), out = cellsOf({ q: { min: [4e7, 0, 0], max: [4e7 + 1, 0, 1] } }), here = cellsOf({ q: { min: [0, 0, 0], max: [1, 0, 1] } });
  const { near } = await import("../../shared/protocol/authority/spatial.js");
  const st = { entities: Object.create(null) } as any; const found = near(st, [1e17, 0, 0], [1e17 + 64, 1, 1]);
  ok(far === null && out === null && Array.isArray(here) && here.length > 0 && Array.isArray(found), "SP1 cells past the grid's safe range file the thing as big, and a query out there ends; ordinary ones still get cells", { far, out, here, found }); }
// G1: a guess's work doesn't grow with how long the unknown name is. 2,000 ids against an 80,000-character name took
// over 15 s (15.6 s in our run) when the whole name was compared; the 2 s bound is a wide margin either side (it reads the clock)
{ const { UP } = await import("../../shared/protocol/authority/ctx.js");
  const ids = Array.from({ length: 2000 }, (_, i) => `thing-${i}`); const t0 = performance.now();
  const near = UP.guess("x".repeat(80000), ids), ms = performance.now() - t0;
  ok(ms < 2000 && UP.guess("thing-12x", ids).includes("thing-12"), "G1 an unknown 80,000-character name is guessed against 2,000 ids in under 2 s, and a near name still finds its match", { ms: Math.round(ms), near }); }
// SRU3: undoing a host's creation leaves a socket someone else made under it since: their work, so the undo skips
{ const name = "sru3";
  const call = callAt(name);
  call("olive", "create-world", { title: "sru3" });
  for (const who of ["ann", "bob"]) call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role: "builder" } });
  const mk = call("ann", "create", { id: "shelf", model: "crate", place: { at: [2, 2] } });
  const hook = call("bob", "create", { id: "bobhook", components: { parent: { to: "shelf" }, transform: { pos: [0, 1, 0] }, socket: { name: "hook" } } });
  const u = call("ann", "undo", {}); const st = openWorld(root, name).state();
  ok(mk.ok && hook.ok && !!st.entities.bobhook && !!st.entities.shelf, "SRU3 undoing ann's shelf leaves bob's socket on it, and the shelf with it", { mk: mk.ok, hook, u, shelf: !!st.entities.shelf, bobhook: !!st.entities.bobhook }); }
// SRU3b: the same when bob's socket is made in two writes: a child under the shelf, then its socket component, or (SRU3c)
// a socket made on another thing, then hung on the shelf, or (SRU3d) both in one batch
for (const [name, steps] of [
  ["sru3b", [["create", { id: "bobhook", components: { parent: { to: "shelf" }, transform: { pos: [0, 1, 0] } } }], ["set", { id: "bobhook", component: "socket", value: { name: "hook" } }]]],
  ["sru3c", [["create", { id: "post", model: "crate", place: { at: [5, 5] } }], ["create", { id: "bobhook", components: { parent: { to: "post" }, transform: { pos: [0, 1, 0] }, socket: { name: "hook" } } }],
    ["set", { id: "bobhook", component: "parent", value: { to: "shelf" } }]]],
  // SRU3d: one batch makes the socket on another thing and then hangs it on the shelf
  ["sru3d", [["create", { id: "post", model: "crate", place: { at: [5, 5] } }], ["batch", { ops: [
    { verb: "create", args: { id: "bobhook", components: { parent: { to: "post" }, transform: { pos: [0, 1, 0] }, socket: { name: "hook" } } } },
    { verb: "set", args: { id: "bobhook", component: "parent", value: { to: "shelf" } } }] }]]],
] as const) {
  const call = callAt(name);
  call("olive", "create-world", { title: name });
  for (const who of ["ann", "bob"]) call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role: "builder" } });
  const mk = call("ann", "create", { id: "shelf", model: "crate", place: { at: [2, 2] } });
  const made = steps.map(([verb, args]) => call("bob", verb, args));
  const u = call("ann", "undo", {}); const st = openWorld(root, name).state();
  // the undo's own skip, for bob's work on the shelf: nothing else stopped it
  const skip = u?.refused?.code === "conflict" && (u.refused.skipped ?? []).some((x) => x.id === "shelf" && x.by === "bob");
  ok(mk.ok && made.every((r) => r.ok) && skip && !!st.entities.bobhook && !!st.entities.shelf, `${name.toUpperCase()} undoing ann's shelf leaves bob's socket on it, made in two writes or one batch, and the shelf with it: the undo skips it for bob's work`, { mk: mk.ok, made, u, shelf: !!st.entities.shelf, bobhook: !!st.entities.bobhook }); }
// SRU3e: the control: one batch makes a socket under the shelf and hangs it on another thing before it ends. The change
// leaves no socket under the shelf, so it's no work on the shelf, and ann's undo removes the shelf, the socket staying put
{ const name = "sru3e";
  const call = callAt(name);
  call("olive", "create-world", { title: name });
  for (const who of ["ann", "bob"]) call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role: "builder" } });
  const mk = call("ann", "create", { id: "shelf", model: "crate", place: { at: [2, 2] } });
  const made = [call("bob", "create", { id: "post", model: "crate", place: { at: [5, 5] } }), call("bob", "batch", { ops: [
    { verb: "create", args: { id: "bobhook", components: { parent: { to: "shelf" }, transform: { pos: [0, 1, 0] }, socket: { name: "hook" } } } },
    { verb: "set", args: { id: "bobhook", component: "parent", value: { to: "post" } } }] })];
  const u = call("ann", "undo", {}); const st = openWorld(root, name).state();
  ok(mk.ok && made.every((r) => r.ok) && u.ok && !st.entities.shelf && st.entities.bobhook?.c.parent?.to === "post",
    "SRU3E a socket made under the shelf and hung elsewhere in the same batch is no work on the shelf: ann's undo removes the shelf, and the socket stays on its new host", { mk: mk.ok, made: made.map((r) => r.ok ?? r.refused), u: u.ok ?? u.refused, shelf: !!st.entities.shelf, parent: st.entities.bobhook?.c.parent }); }
// F1: a founding the authority refuses leaves no world behind: the name can still be founded, and its founder owns it
{ const name = "refused-founding";
  const call = callAt(name);
  const bad = call("olive", "create-world", { title: "x".repeat(5000) });
  const again = call("olive", "create-world", { title: "second try" });
  ok(bad?.ok === false && again?.ok === true && again.you === "owner", "F1 a refused founding leaves nothing: the next founding of that name succeeds", { bad, again }); }
console.log(`[authority-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
