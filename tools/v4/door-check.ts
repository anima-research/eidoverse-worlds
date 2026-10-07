// tools/v4/door-check.ts — slice 2's in-process checks (the server-level ones over a real WebSocket are
// server-check.ts). usage: bun tools/v4/door-check.ts
//   N   names.js: one encoding for actors, ids and components; the lab's `0abc` / `n0abc` collision is gone
//   T   the engine translator's own name, and the v1 fold build it stamps
//   P   locks (PROTOCOL-v4 §5): v1's matrix (tools/locktest.ts), ancestors, throughLock, the gameplay lock inside
//       its own component, and v1 lock/guard through the translator
//   U   the act index (undo, wait): equals a fresh build after every request; entityBefore equals the fold at every
//       seq; a later write, a purge and a new act each change undo's answer the way a full scan would
//   M   translated mounts in the door's shape: where the door sees a riding thing, place-on and overlap warnings
//   L   the live world (server/v4/live.ts) equals a whole-log re-read after every request: state, sim, the id index
//   C   the engine catalogue's shape (an off-centre GLB box, measured surfaces) places things where they rest
//   X   the compatibility projection: the v1 verbs it sends, folded by the client's own fold, reproduce it
// @ts-nocheck
import fs from "node:fs";
import { scratch } from "./common.ts";
import { request, creatorOf, LAB_CATALOGUE, actIndexOf, actIndexFresh, entityBefore } from "../../shared/v4/door.js";
import { fold, readLog, digest, opsOf, PURGED } from "../../shared/v4/fold.js";
import { makeV4Client, stateView, stateFromView } from "../../shared/v4/client.js";
import { simFold, digestOf, restsOf } from "../../shared/v4/simlayer.js";
import { MODELS } from "../../shared/v4/catalogue.js";
import { enc, encName, dec } from "../../shared/v4/names.js";
import { refusalText, lockVerb, lockQuestion, lockChoices } from "../../shared/v4/refusal.js";
import { custodyAt } from "../../server/v4/custody.ts";
import { translate, TRANSLATOR } from "./import-v1/translate-v1.js";
import { openWorld } from "../../server/v4/disk.ts";
import { openLive } from "../../server/v4/live.ts";
import { v1FoldBuild, v1FoldFiles } from "./import-v1/build.ts";
import { emptyState as v1Empty, foldEntry as v1fold } from "./import-v1/fold.js";
import { worldPose } from "../../shared/hierarchy.js";

const root = scratch("door");
// lab worlds name people by bare test names; the directory a real server has would know them (roles:<key> checks it)
const LABKIND = (_id: string) => "human";
let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const code = (r: any) => r?.refused?.code;
let T = 1800000000000;

// a translation written into this door's worlds carries THIS door's keys: the door refuses to sign for a world whose
// genesis names another sequencer (round-2 R5); disk.ts keeps custody at <root>/keys/custody.json
const DOORKEYS = () => { const cu = custodyAt(root + "keys/custody.json"); return { key: cu.sequencer(), operator: cu.operator() }; };

// ---- N: names ----
ok(encName("0abc") !== encName("n0abc"), "N1 encName('0abc') and encName('n0abc') differ (the lab gave both 'n0abc')", [encName("0abc"), encName("n0abc")]);
ok(encName("n0abc") === "n0abc" && encName("0abc").startsWith("x--"), "N2 a valid component name is kept; an invalid one is always escaped", [encName("n0abc"), encName("0abc")]);
for (const s of ["Hesperus", "anon-3", "x--41", "h--zz", "é☃", "0abc", "a".repeat(64), "a".repeat(65), "Riannon Delanoy", "__proto__"])
  ok(dec(enc(s)) === s || (enc(s).startsWith("h--") && dec(enc(s)) === null), `N3 dec(enc(${JSON.stringify(s).slice(0, 20)})) gives it back (or says it was hashed)`, [enc(s), dec(enc(s))]);
{ const seen = new Map(); let clash = null;
  for (let i = 0; i < 3000 && !clash; i++) { const s = (i % 3 ? String.fromCharCode(48 + (i % 75)) : "x--") + i.toString(36) + (i % 7 ? "" : "Z");
    for (const f of [enc, encName]) { const k = `${f.name}:${f(s)}`; if (seen.has(k) && seen.get(k) !== s) clash = [s, seen.get(k), f(s)]; seen.set(k, s); } }
  ok(!clash, "N4 enc and encName are injective on 3,000 awkward names", clash); }
ok(enc("anon-3") === "anon-3" && enc("Riannon").startsWith("x--"), "N5 identities: the grammar's own names pass, others are escaped");

// ---- T: the translator's name and stamp ----
ok(TRANSLATOR !== "translate-v1@0.3" && /^eidoverse\//.test(TRANSLATOR), "T1 the engine translator has its own name (not the lab's)", TRANSLATOR);
{ const old = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log", roles: { Riannon: { role: "owner" } } } },
    { seq: 1, ts: 2, actor: "Riannon", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [1, 0, 1] } },
    { seq: 2, ts: 3, actor: "Riannon", verb: "comp", args: { id: "lamp_1", type: "0abc", data: 1 } },
    { seq: 3, ts: 4, actor: "Riannon", verb: "comp", args: { id: "lamp_1", type: "n0abc", data: 2 } }];
  const r = translate(old, { foldBuild: v1FoldBuild() });
  ok(r.out[1].verb === "translated" && r.out[1].body.from.translator === TRANSLATOR && r.out[1].body.from.fold === v1FoldBuild() && r.out[0].body.minor === 0, "T2 the act after genesis names the translator and the v1 fold build", r.out[1].body);
  const c = r.final.v4[enc("lamp_1")];
  ok(c && c["n0abc"] === 2 && c[encName("0abc")] === 1 && !r.stats.divergences, "T3 a translated world keeps comps '0abc' and 'n0abc' apart", c);
  ok(JSON.stringify(r.out[0].body.owners) === JSON.stringify([[], [r.out[0].body.sequencer]]) && r.out[1].body.from.roles?.Riannon?.role === "owner" && !r.final.v4["@world"]?.[`roles:${enc("Riannon")}`], "T4 genesis is custodial (tier 0 empty, the door's key in tier 1); v1 genesis roles, which v1 never folds, are kept verbatim in the translated act and grant nothing", [r.out[0].body.owners, r.out[1].body.from])
  ok(v1FoldFiles().includes("tools/v4/import-v1/fold.js") && v1FoldFiles().length >= 5 && /^[0-9a-f]{16}$/.test(v1FoldBuild()), "T5 the fold build covers the importer's v1 fold and its imports", v1FoldFiles()); }

// ---- P: locks (PROTOCOL-v4 §5), mirroring v1's lock matrix (tools/locktest.ts) plus what v4 adds ----
// v1: a lock refuses everything that would MOVE, REPLACE or REMOVE the thing, for everyone, its locker included;
// everything that doesn't relocate it stays open (sit, use, motion, other comps); any builder may unlock. v4 adds:
// it binds what's attached to it too; throughLock: true lets whoever may remove it act through it.
{ const name = "locks";
  const call = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, name), actor, tool, args); };
  const W = () => openWorld(root, name);
  call("olive", "create-world", { title: "locks" });
  call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "visitor" } });
  call("olive", "create", { id: "tbl", model: "table", place: { at: [0, 3] } });
  ok(call("bob", "create", { id: "cup", model: "crate", place: { on: "tbl" } }).ok, "P0 a crate on the table");
  ok(call("bob", "create", { id: "bell", model: "ball", place: { on: "cup" } }).ok, "P0 a ball on the crate (two levels down)");
  const w0 = W().state(); ok(w0.entities.cup.c.parent?.to === "tbl" && w0.entities.bell.c.parent?.to === "cup", "P0 the chain is tbl ← cup ← bell", [w0.entities.cup.c.parent, w0.entities.bell.c.parent]);
  ok(call("olive", "set", { id: "tbl", component: "lock", value: true }).ok, "P1 olive locks the table (an ordinary set of `lock`)");
  // v1's refusal matrix, for the LOCKER (who is also the owner): place, remove, cargo-mount, replace
  ok(code(call("olive", "set", { id: "tbl", component: "transform", value: { pos: [9, 0, 9] } })) === "locked", "P2 the locker herself can't move it (v1: 'even for the locker')");
  ok(code(call("olive", "delete", { id: "tbl" })) === "locked", "P3 …nor remove it (and she is an owner: a lock binds owners too)");
  ok(code(call("olive", "set", { id: "tbl", component: "parent", value: { to: "cup" } })) !== undefined && code(call("olive", "place", { id: "tbl", at: [5, 5] })) === "locked", "P4 …nor place it, nor mount it on something (cargo-mount)");
  ok(code(call("olive", "set", { id: "tbl", component: "model", value: "crate" })) === "locked", "P5 …nor replace it (its model: v1's spawn onto its id)");
  ok(code(call("olive", "delete", { id: "tbl", component: "transform" })) === "locked", "P6 …nor send it to the origin by deleting its transform (25d H1)");
  { const r = call("bob", "set", { id: "cup", component: "transform", value: { pos: [0.1, 0.75, 0] } });
    ok(code(r) === "locked" && /attached to tbl, which is locked/.test(r.refused.reason) && /locked by olive/.test(r.refused.reason), "P7 what's attached is bound too, and the refusal names the lock and who set it", r.refused);
    ok(/throughLock: true/.test(r.refused.fix) && /delete \{id: 'tbl', component: 'lock'\}/.test(r.refused.fix), "P7 …and teaches both ways through: throughLock, or unlock", r.refused.fix); }
  ok(code(call("bob", "delete", { id: "cup" })) === "locked" && code(call("bob", "place", { id: "cup", at: [4, 4] })) === "locked", "P8 …nor deleted or placed elsewhere");
  ok(code(call("bob", "delete", { id: "cup", component: "parent" })) === "locked", "P9 …nor lifted off (deleting its parent)");
  ok(code(call("bob", "set", { id: "bell", component: "transform", value: { pos: [0, 0.6, 0] } })) === "locked", "P10 a grandchild is bound too (the lock is two levels up)");
  // what stays open: everything that doesn't relocate it (v1: "sit / use / motion / other comps all stay open while locked")
  ok(call("olive", "set", { id: "tbl", component: "label", value: "the long table" }).ok && call("bob", "set", { id: "cup", component: "label", value: "a crate" }).ok, "P11 a label stays open (the locker's and a builder's)");
  ok(call("olive", "set", { id: "tbl", component: "motion", value: { type: "spin", axis: [0, 1, 0], amp: 0.2, period: 4 } }).ok, "P12 motion stays open (v1's matrix; a v4 motion animates in place)");
  ok(call("olive", "set", { id: "tbl", component: "light", value: { range: 4 } }).ok && call("olive", "set", { id: "tbl", component: "physics", value: { kind: "static" } }).ok, "P13 a light and physics stay open (neither relocates it)");
  ok(call("bob", "set", { id: "tbl", component: "reactions", value: { knock: { kind: "set", component: "label", value: "knocked" } } }).ok && call("vic", "use", { id: "tbl", action: "knock" }).ok, "P14 reactions stay open, and a visitor may still `use` it");
  { const r = call("bob", "create", { id: "cup2", model: "ball", place: { on: "tbl" } }); ok(r.ok, "P15 a NEW thing may be put on a locked table (a lock guards what is attached, not the surface)", r); }
  // throughLock
  { const n = W().entries.length; const r = call("bob", "set", { id: "cup", component: "transform", value: { pos: [0.1, 0.75, 0] }, throughLock: true });
    const E = W().entries.slice(n); const st = E.filter((e) => e.kind === "change"); const ops = st.flatMap((e) => e.body.ops ?? [e.body]);
    ok(r.ok, "P16 throughLock: true lets a builder (who may remove the lock) act through it", r.refused);
    ok(E.length === 2 && ops.length && ops.every((o) => o.comp !== "lock") && W().state().entities.tbl.c.lock === true, "P17 …and the log records only the edit: one act, one change entry, no unlock or relock; the lock is still on", E.map((e) => [e.kind, e.verb, e.body?.comp]));
    ok(E[0].kind === "act" && E[0].body.request.throughLock === true, "P18 …the act carries the request as sent, flag and all (history shows who went through)", E[0].body); }
  ok(call("olive", "set", { id: "tbl", component: "transform", value: { pos: [0, 0, 3.1] }, throughLock: true }).ok, "P19 the locker herself acts through it the same way");
  ok(code(call("bob", "set", { id: "cup", component: "transform", value: { pos: [0, 0.75, 0] }, throughLock: "yes" })) === "shape", "P20 throughLock is a boolean");
  ok(call("bob", "set", { id: "cup2", component: "label", value: "x", throughLock: true }).ok, "P21 throughLock on an edit no lock guards is harmless");
  { // a capability never acts through a lock: a visitor's use of a handler that would move it, flag or not
    call("bob", "set", { id: "cup2", component: "reactions", value: { nudge: { kind: "set", component: "transform", value: { pos: [0.2, 0.75, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } } });
    const v = call("vic", "use", { id: "cup2", action: "nudge", throughLock: true }), b = call("bob", "use", { id: "cup2", action: "nudge", throughLock: true });
    ok(code(v) === "locked" && /not a handler/.test(v.refused.fix), "P22 a visitor can't move it through a handler with throughLock (they may not remove the lock)", v.refused);
    ok(code(b) === "locked", "P23 …nor can a builder through a handler (throughLock covers your own edits, not a capability)", b.refused); }
  ok(code(call("vic", "delete", { id: "tbl", component: "lock" })) === "rights" && code(call("vic", "set", { id: "cup2", component: "lock", value: true })) === "rights", "P24 a visitor may neither unlock nor lock");
  ok(code(call("olive", "set", { id: "@world", component: "lock", value: true })) === "world", "P25 @world can't be locked (even by its owner)");
  ok(code(call("bob", "set", { id: "cup2", component: "lock", value: 1 })) === "shape", "P26 the door writes a lock only as true (to unlock, delete it)");
  { call("bob", "set", { id: "cup2", component: "lock", value: true });
    ok(code(call("bob", "set", { id: "cup2", component: "transform", value: { pos: [0.3, 0.75, 0] } })) === "locked", "P27 a builder's own lock binds that builder (the locker, not an owner)"); }
  ok(call("bob", "delete", { id: "tbl", component: "lock" }).ok, "P28 any builder may unlock someone else's lock (olive's)");
  ok(call("bob", "set", { id: "cup", component: "transform", value: { pos: [0.1, 0.75, 0] } }).ok, "P29 …and then the crate moves");
  call("olive", "set", { id: "cup", component: "lock", value: true });
  ok(code(call("bob", "set", { id: "bell", component: "transform", value: { pos: [0, 0.6, 0] } })) === "locked" && call("bob", "set", { id: "tbl", component: "transform", value: { pos: [0, 0, 3.2] } }).ok,
    "P30 a lock binds what's attached to it, never what it stands on");
  { // undo through a lock: bob's move of a crate olive then locked
    call("bob", "create", { id: "box", model: "crate", place: { at: [6, 6] } }); call("bob", "set", { id: "box", component: "transform", value: { pos: [7, 0, 7] } });
    call("olive", "set", { id: "box", component: "lock", value: true });
    ok(code(call("bob", "undo", {})) === "locked", "P31 undo goes through admit: bob's undo of his move is refused while it's locked");
    const u = call("bob", "undo", { throughLock: true });
    ok(u.ok && JSON.stringify(W().state().entities.box.c.transform.pos) === "[6,0,6]" && W().state().entities.box.c.lock === true, "P32 …and undo {throughLock: true} reverts it, leaving the lock on", u.refused ?? W().state().entities.box.c); }
  { // the gameplay lock lives inside its own component: door {open, locked}
    call("bob", "create", { id: "gate", model: "door", components: { openable: { open: false, locked: false }, reactions: { open: { kind: "toggle", unless: "locked" }, bolt: { kind: "set", component: "openable", field: "locked", value: true, who: "builder" } } }, place: { at: [-4, 0] } });
    ok(call("vic", "use", { id: "gate", action: "open" }).ok && W().state().entities.gate.c.openable.open === true, "P33 a visitor opens the door: toggle's default is openable.open");
    ok(call("bob", "use", { id: "gate", action: "bolt" }).ok && JSON.stringify(W().state().entities.gate.c.openable) === '{"open":true,"locked":true}', "P34 bolting sets openable.locked, inside its own component");
    const r = call("vic", "use", { id: "gate", action: "open" });
    ok(code(r) === "barred" && !("locked" in W().state().entities.gate.c) && !("open" in W().state().entities.gate.c), "P35 …then opening is barred by door.locked; no top-level `locked` or `open` exists", r.refused);
    const i = call("vic", "inspect", { id: "gate" }); ok(i.notForYou?.some((x) => x.action === "open") && i.openable?.locked === true, "P36 inspect shows why, and the door's state", i.notForYou);
    call("olive", "set", { id: "gate", component: "lock", value: true });
    ok(code(call("bob", "use", { id: "gate", action: "bolt" })) === undefined, "P37 an edit lock doesn't stop using the door (v1: use stays open)"); }
  { // §5: a held thing keeps its logged parent, but holding suspends parent constraints until it settles
    const hc = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "held"), actor, tool, args); };
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
    const r = translate(old, DOORKEYS()); const f = r.final.v4;
    ok(f.statue.lock === true && !r.stats.divergences, "P38 a v1 lock translates to `lock` unchanged (the identity)", f.statue);
    ok(f.sign.lock === true && !("guard" in f.sign) && !("lock" in f.both), "P39 a v1 guard becomes a lock (and an unguarded thing has none)", [f.sign, f.both]);
    ok(r.stats.guards === 2 && r.stats.guardsLive === 1, "P40 the translator counts guards that became locks (2 ever, 1 still on), so the owners can be told", r.stats);
    fs.writeFileSync(root + "worlds/tr-locks.jsonl", r.out.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const tc = (actor, tool, args) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "tr-locks"), actor, tool, args); };
    ok(code(tc("ann", "set", { id: "sign", component: "transform", value: { pos: [0, 0, 0] } })) === "locked", "P41 in the translated world the old guard binds even its placer (by design, §5)"); }
}

// ---- NR: people's names in refusals (polish for R's first test, research 44 #3) ----
// A name outside the identity grammar ("Riannon": capitals) is stored escaped (x--5269…). A refusal is read by a person
// or an agent, so it says the name as the person spells it, and carries the id as a field for whoever needs to match it.
{ const name = "names";
  const R = enc("Riannon");
  const call = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, name), actor, tool, args); };
  call(R, "create-world", { title: "names" });
  call(R, "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  call(R, "create", { id: "statue", model: "crate", place: { at: [0, 2] } });
  call(R, "set", { id: "statue", component: "lock", value: true });
  const locked = call("bob", "set", { id: "statue", component: "transform", value: { pos: [1, 0, 1] } });
  ok(code(locked) === "locked" && /locked by Riannon at/.test(locked.refused.reason) && !/x--/.test(locked.refused.reason), "NR1 a lock refusal names who locked it as they spell it (Riannon, not x--5269…)", locked.refused);
  ok(locked.refused.by === R && locked.refused.lock === "statue", "NR2 …and carries the identity as a field (by), next to the lock", locked.refused);
  call(R, "create", { id: "pot", model: "crate", place: { at: [3, 2] } });
  const t0 = openWorld(root, name).state().entities.pot.c.transform;
  call(R, "set", { id: "pot", component: "transform", value: { ...t0, pos: [3, 0, 3] } });
  const ch = call("bob", "set", { id: "pot", component: "transform", value: { ...t0, pos: [4, 0, 4] }, expect: [{ id: "pot", component: "transform", value: t0 }] });
  ok(code(ch) === "changed" && /Riannon changed it at/.test(ch.refused.reason) && ch.refused.by === R, "NR3 an expect refusal names who changed it (and keeps by: the id)", ch.refused);
  const st = call("bob", "set", { id: "pot", component: "transform", value: { ...t0, pos: [5, 0, 5] }, base: { seq: 1, head: openWorld(root, name).headAt(1) } }); // §3d M7: a version is {seq, head}
  ok(code(st) === "stale" && /Riannon set it at/.test(st.refused.reason) && st.refused.by === R, "NR4 a stale-base refusal names them too", st.refused);
  call("bob", "create", { id: "cup", model: "crate", place: { at: [6, 2] } });
  const cupT = openWorld(root, name).state().entities.cup.c.transform;
  const mv = call("bob", "set", { id: "cup", component: "transform", value: { ...cupT, pos: [6, 0, 6] } });
  call(R, "set", { id: "cup", component: "transform", value: { ...cupT, pos: [7, 0, 7] } });
  const un = call("bob", "undo", { act: mv.act });
  ok(code(un) === "conflict" && /Riannon changed it since/.test(JSON.stringify(un.refused.skipped)) && un.refused.skipped?.[0]?.by === R, "NR5 an undo conflict names who changed it since (and by: the id)", un.refused);
  ok(refusalText("move x--4c616d70", { refused: { code: "locked", reason: "x--4c616d70 is locked (locked by x--5269616e6e6f6e at 9)", fix: "" } }) === "move Lamp refused by the door (locked): Lamp is locked (locked by Riannon at 9)",
    "NR6 the shared refusal text (what a person's toast and an agent's verb tools show) reads any escaped name back", refusalText("move x--4c616d70", { refused: { code: "locked", reason: "x--4c616d70 is locked (locked by x--5269616e6e6f6e at 9)" } }));
  ok(refusalText("x", { refused: { code: "c", reason: "h--abc and plain-id and x--zz stay" } }) === "x refused by the door (c): h--abc and plain-id and x--zz stay", "NR7 …a hashed name (h--) or a non-hex x-- is left as it is (it can't be read back)");
  { const V = (req) => lockVerb(req); const set = (component) => ({ verb: "set", args: { id: "a", component, value: 1 } });
    const got = [V(set("transform")), V(set("parent")), V({ verb: "place", args: { id: "a", at: [0, 0] } }), V({ verb: "delete", args: { id: "a" } }), V(set("model")),
      V({ verb: "batch", args: { ops: [set("transform"), { verb: "delete", args: { id: "b" } }] } }), V({ verb: "undo", args: { act: 3 } }), V(set("label")), V({ verb: "delete", args: { id: "a", component: "parent" } })];
    ok(JSON.stringify(got) === JSON.stringify(["Move", "Move", "Move", "Delete", "Replace", "Delete", "Undo", "Change", "Move"]) && lockQuestion("Delete") === "This is locked. Delete anyway?"
      && lockChoices("Move").map((c) => c.v).join() === "through,cancel,unlock", "NR8 the lock question names what the request would do: Move / Delete / Replace anyway? (R's three answers)", got); }
}

// ---- M: translated mounts in the door's shape (research 37, slice 3 #3) ----
// translate-v1@1 carried v1's parent record and v1's own pos; the door reads transform as LOCAL to parent, so it saw a
// riding crate wherever its unused pre-mount pos pointed. Now the door must see it where v1 draws it.
{ const old = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "ann", verb: "grant", args: { id: "ann", role: "owner" } },
    { seq: 2, ts: 3, actor: "ann", verb: "spawn", args: { id: "tbl", lib: "table", pos: [2, 0, 3] } },
    { seq: 2, ts: 3, actor: "ann", verb: "spawn", args: { id: "rack", lib: "table", pos: [-3, 0, 2], yaw: 0.5 } },
    { seq: 2, ts: 3, actor: "ann", verb: "spawn", args: { id: "jar", lib: "bell", pos: [0, 0, 0] } },
    { seq: 2, ts: 3, actor: "ann", verb: "mount", args: { id: "jar", to: "rack", offset: [0.3, 0.75, -0.1], q: [0, 0.3826834, 0, 0.9238795] } }, // a turned carrier, a turned rider
    { seq: 3, ts: 4, actor: "ann", verb: "spawn", args: { id: "box", lib: "crate", pos: [9, 4, -6] } },           // its pre-mount pose: far away
    { seq: 4, ts: 5, actor: "ann", verb: "mount", args: { id: "box", to: "tbl", offset: [0, 0.75, 0] } },          // rides at the table's centre
    { seq: 5, ts: 6, actor: "ann", verb: "comp", args: { id: "tbl", type: "sockets", data: { perch: { pos: [0.45, 0.75, 0.25], yaw: 1.2 } } } },
    { seq: 6, ts: 7, actor: "ann", verb: "spawn", args: { id: "bell", lib: "bell", pos: [-5, 0, -5] } },
    { seq: 7, ts: 8, actor: "ann", verb: "mount", args: { id: "bell", to: "tbl", slot: "perch" } },                // at a socket, no offset
    { seq: 8, ts: 9, actor: "ann", verb: "spawn", args: { id: "stray", lib: "ball", pos: [6, 0, 6] } },
    { seq: 9, ts: 10, actor: "ann", verb: "mount", args: { id: "stray", to: "nowhere", offset: [0, 5, 0] } }];      // its carrier doesn't exist
  const r = translate(old, DOORKEYS()); fs.writeFileSync(root + "worlds/tr-mounts.jsonl", r.out.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const v1 = v1Empty(); for (const e of old) v1fold(v1, e);
  const tc = (tool, args) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "tr-mounts"), "ann", tool, args); };
  ok(!r.stats.divergences && r.final.v4.box.parent?.order === "a0" && !("offset" in r.final.v4.box.parent), "M1 a translated mount is door-shaped: parent {to, order}, no offset copy (L2)", r.final.v4.box.parent);
  ok(JSON.stringify(r.final.v4.box.transform.pos) === "[0,0.75,0]" && JSON.stringify(r.final.v4.bell.transform.pos) === "[0.45,0.75,0.25]" && r.final.v4.bell.parent.socket === "perch",
    "M2 its transform is local: the offset, or (no offset) its socket's pos, and the socket is kept (v1's slot)", [r.final.v4.box.transform, r.final.v4.bell.transform, r.final.v4.bell.parent]);
  const near = (a, b) => a && b && a.every((x, i) => Math.abs(x - b[i]) < 1e-6);
  // v1's mount names its socket `slot`; shared/hierarchy.js (the renderer's reading) speaks v4's `socket`
  const v1asV4 = Object.fromEntries(Object.entries(v1.entities).map(([k, e]) => [k, e.parent && "slot" in e.parent ? { ...e, parent: (({ slot, ...p }) => ({ ...p, socket: slot }))(e.parent) } : e]));
  for (const id of ["box", "bell", "stray", "jar"]) { const i = tc("inspect", { id }); const want = worldPose(v1asV4, id);
    ok(near(i.world?.pos, want.pos) && near(i.world?.q, want.q), `M3 the door sees ${id} where v1 draws it (world pose)`, [i.world, want]); }
  const p = tc("create", { id: "ball2", model: "ball", place: { on: "tbl" } }); const at = p.notes?.find((n) => n.placed)?.placed;
  const loc = openWorld(root, "tr-mounts").state().entities.ball2?.c.transform.pos; // local to tbl (it rides the table)
  ok(p.ok && loc && Math.max(Math.abs(loc[0]), Math.abs(loc[2])) > 0.4, "M4 place on the table avoids the riding crate at its centre (with @1's shape the door saw the crate 9 m away and the centre free)", [at, loc]);
  const chk = tc("lint", {}).warnings ?? []; ok(!chk.some((x) => x.kind === "overlap" && [x.id, x.with].includes("box") && [x.id, x.with].includes("ball2")), "M5 …and check sees no overlap between them", chk);
  ok(chk.filter((x) => x.kind === "floating" && ["box", "bell", "jar"].includes(x.id)).length === 0, "M6 …nor calls a riding thing floating", chk); }

// ---- L: live world vs whole-log re-read ----
{ const dir = root + "live/"; T += 1000; let now = T;
  const w = openLive(dir, "live", { kindOf: LABKIND, now: () => now, simModels: MODELS });
  const call = (actor, tool, args = {}, step = 100) => { now += step; return request(w, actor, tool, args); };
  const same = (what) => {
    const L = readLog(fs.readFileSync(dir + "v4.jsonl")); const whole = fold(L);
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
  call("rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
  call("rowan", "set", { id: "@world", component: "roles:vic", value: { role: "visitor" } }); same("built");
  call("rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@0.5.0" } });
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
{ const dir = root + "undo/"; let now = T + 3000;
  const w = openLive(dir, "undo", { kindOf: LABKIND, now: () => now });
  const call = (actor, tool, args = {}) => { now += 100; return request(w, actor, tool, args); };
  const flat = (x) => JSON.stringify(Object.fromEntries(Object.entries(x).filter(([k]) => !["entries", "bad", "pt"].includes(k)).map(([k, v]) => [k, v instanceof Map ? [...v].sort((a, b) => String(a[0]).localeCompare(String(b[0]))) : v instanceof Set ? [...v].sort() : v])));
  let steps = 0, firstBad = null;
  const same = (what) => { steps++; const inc = flat(actIndexOf(w)), fresh = flat(actIndexFresh(readLog(fs.readFileSync(dir + "v4.jsonl"))));
    if (inc !== fresh && !firstBad) firstBad = [what, inc.slice(0, 300), fresh.slice(0, 300)]; };
  const step = (actor, tool, args = {}) => { const r = call(actor, tool, args); same(`${actor} ${tool}`); return r; };
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
  const b1 = step("bob", "batch", { label: "tidy", ops: [{ verb: "set", args: { id: "crate", component: "light", value: { range: 3 } } }] });
  purge([{ seq: b1.act }]);
  ok(code(step("bob", "undo", { label: "tidy" })) === "nothing", "U6 a purged act's label can't be matched any more", b1.refused);
  // entityBefore = the fold at every seq, for every thing (purged values included)
  const L = readLog(fs.readFileSync(dir + "v4.jsonl")); let bad = null;
  for (let q = 1; q <= L.length && !bad; q++) { const st = fold(L, { until: q - 1 });
    for (const id of new Set([...Object.keys(st.entities), "crate"])) { const a = entityBefore(w, id, q), b = st.entities[id];
      const j = (e) => (e ? JSON.stringify({ born: e.born, c: Object.fromEntries(Object.keys(e.c).sort().map((k) => [k, e.c[k]])) }) : null);
      if (j(a) !== j(b)) { bad = [q, id, j(a), j(b)]; break; } } }
  ok(!bad, `U7 entityBefore(id, seq) = fold(until: seq - 1) for every thing at all ${L.length} seqs (it reads a thing's own history)`, bad);
  ok(!firstBad, `U8 the incremental index = a fresh build after each of ${steps} steps (writes, undos, refusals, two purges)`, firstBad);
  { const X = actIndexOf(w); ok(X.purged.has(b1.act) && X.purgedOps.size === 2, "U9 the index knows both purges (an act body and a set value)", [[...X.purged], [...X.purgedOps]]); } }

// ---- E: expect (§3a: a gesture settles as one act with expect on its starting values), duplicate, redo ----
{ const dir = root + "expect/"; let now = T + 6000;
  const w = openLive(dir, "expect", { kindOf: LABKIND, now: () => now });
  const call = (actor, tool, args = {}) => { now += 100; return request(w, actor, tool, args); };
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

// ---- K: the client's own fold (shared/v4/client.js): adopt a cut, ingest the door's entries; the v4 state equals the
// server's after every request, and the VIEW the renderer draws is recomputed from it (slice 3c: no v1 verbs) ----
{ const { viewState } = await import("../../shared/v4/record.js"); const { diffView } = await import("../../shared/v4/viewdiff.js");
  let now = T + 12000; const w = openLive(root + "client/", "client", { kindOf: LABKIND, now: () => now });
  const call = (actor, tool, args = {}) => { now += 100; return request(w, actor, tool, args); };
  call("ann", "create-world", { title: "client" }); call("ann", "create", { id: "tbl", model: "table", place: { at: [0, 3] } });
  const c = makeV4Client();
  c.adopt(JSON.parse(JSON.stringify({ state: stateView(w.state()), head: w.entries.length - 1, worldId: w.worldId })));
  let steps = 0, bad = null; const same = (a, b) => { const d = diffView(a, b); return !d.things.length && !d.world.length; };
  const step = (what, actor, tool, args) => { const from = w.entries.length; const r = call(actor, tool, args);
    const fresh = JSON.parse(JSON.stringify(w.entries.slice(from))); // over the wire: plain JSON
    const before = c.view(); const k = c.ingest(fresh, from); steps++;
    if (k.resync) return { r, k };
    if (!bad && digest(c.st) !== digest(w.state())) bad = [what, "v4 state differs"];
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
  ok(!bad, `K1 after each of ${steps} requests the client's v4 fold = the server's (digest), and its view = the server's`, bad);
  ok(sky.k.changed && sky.d.world.includes("sky") && !sky.d.things.length, "K2 the sky arrives as a world change (the v1 path had to re-draw everything for it)", sky.d);
  ok(!said.k.changed && said.k.says.length === 1 && said.k.says[0].text === "hi" && said.k.says[0].actor === "ann", "K7 a say comes back as a chat line, and changes no state", said.k);
  const re = c.ingest(JSON.parse(JSON.stringify(w.entries.slice(-1))), w.entries.length - 1);
  ok(!re.changed && !re.says.length && !re.resync, "K3 a re-delivered entry is ignored", re);
  // its own thing: cup left with tbl (deleting takes children, and undoing a delete is refused since lab F3)
  call("ann", "create", { id: "gap-1", model: "crate", place: { at: [3, 3] } }); c.ingest(JSON.parse(JSON.stringify(w.entries.slice(c.head + 1))), c.head + 1);
  call("ann", "set", { id: "gap-1", component: "label", value: "x" }); const from = w.entries.length; ok(call("ann", "set", { id: "gap-1", component: "label", value: "y" }).ok, "K4 (precondition) the edit after the missed one is written");
  ok(c.ingest(JSON.parse(JSON.stringify(w.entries.slice(from))), from).resync, "K4 a gap (a missed entry) asks for a fresh snapshot, never folds past it");
  const c2 = makeV4Client(); c2.adopt(JSON.parse(JSON.stringify({ state: stateView(w.state()), head: w.entries.length - 1 })));
  now += 100; w.append({ kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: from + 1 }] } });
  ok(c2.ingest(JSON.parse(JSON.stringify(w.entries.slice(-1))), w.entries.length - 1).resync, "K5 a purge (retroactive, L1) asks for a fresh snapshot");
  const sv = stateFromView(JSON.parse(JSON.stringify(stateView(w.state()))));
  ok(digest(sv) === digest(w.state()) && sv.entities["gap-1"]?.c.label === PURGED, "K6 stateView survives the wire both ways, a purged value still purged (not a value)", sv.entities["gap-1"]?.c); }

// ---- C: an off-centre catalogue box and measured surfaces ----
{ const cat = { get: (n) => ({ "lib/desk.glb": { label: "desk", box: [[-0.5, -0.4, -0.3], [0.7, 0.35, 0.5]], size: [1.2, 0.75, 0.8], surfaces: [{ y: 0.35, x: [-0.4, 0.6], z: [-0.2, 0.4] }] },
      "lib/cup.glb": { label: "cup", box: [[-0.05, 0, -0.05], [0.05, 0.1, 0.05]], size: [0.1, 0.1, 0.1], surfaces: [] }, "lib/ghost.glb": { label: "ghost", surfaces: [] } } as any)[n], list: () => [] };
  let now = T + 5000; const w = openLive(root + "cat/", "cat", { kindOf: LABKIND, now: () => now, catalogue: cat });
  const call = (actor, tool, args = {}) => { now += 100; return request(w, actor, tool, args); };
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
  let now2 = T + 9000; const w2 = openLive(root + "cat2/", "cat2", { kindOf: LABKIND, now: () => now2, catalogue: cat2 });
  const c2 = (actor, tool, args = {}) => { now2 += 100; return request(w2, actor, tool, args); };
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

// ---- V: what changed, said in v4 terms (slice 3c: the renderer reacts to these, not to v1 verbs) ----
{ const { viewState } = await import("../../shared/v4/record.js"); const { diffView } = await import("../../shared/v4/viewdiff.js");
  let now = T + 9500; const w = openLive(root + "vdiff/", "vdiff", { kindOf: LABKIND, now: () => now });
  let held = viewState(w.state());
  const step = (actor, tool, args) => { now += 100; const r = request(w, actor, tool, args); const next = viewState(w.state()); const d = diffView(held, next); held = next; return { r, d,
    has: (id, what, comp) => d.things.some((c) => c.id === id && c.what === what && (comp === undefined || c.comp === comp)) }; };
  step("ann", "create-world", { title: "vdiff" });
  const v1 = step("ann", "create", { id: "tbl", model: "table", place: { at: [0, 3] } });
  ok(v1.has("tbl", "born") && !v1.has("tbl", "pose"), "V1 a create is one 'born' (nothing else said about it)", v1.d);
  const v2 = step("ann", "create", { id: "cup", model: "crate", place: { on: "tbl" } });
  ok(v2.has("cup", "born") && !v2.d.things.some((c) => c.id === "tbl"), "V2 a thing put on another: it's born (parent included), the table untouched", v2.d);
  const v3 = step("ann", "set", { id: "tbl", component: "transform", value: { pos: [1, 0, 3] } });
  ok(v3.has("tbl", "pose") && v3.d.things.length === 1, "V3 a move is one 'pose' (the child rides along; it isn't told)", v3.d);
  const v4c = step("ann", "set", { id: "tbl", component: "lock", value: true });
  ok(v4c.has("tbl", "comp", "lock") && v4c.d.things.length === 1, "V4 a component set is 'comp' naming it", v4c.d);
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

// ---- S3: a stretched v4 thing in the view (R 10-04 three-axis scale; Wren's agent-lab `look` failure) ----
{ const { viewOf } = await import("../../shared/v4/record.js");
  const { effectiveWorldTransform } = await import("../../mcpl/effective.ts");
  const rec = viewOf("bench", { model: "x.glb", transform: { pos: [1, 0, 2], q: [0, 0, 0, 1], scale: [2, 0.4, 0.4] } });
  ok(typeof rec.scale === "number" && JSON.stringify(rec.scale3) === "[2,0.4,0.4]", "S3a a stretched thing's view has `scale` as ONE number (every older reader) and scale3 beside it", rec);
  ok(viewOf("box", { model: "x.glb", transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [3, 3, 3] } }).scale3 === undefined, "S3b a uniform one carries no scale3");
  const eff = effectiveWorldTransform("bench", { entity: (id: string) => (id === "bench" ? rec : undefined), mount: () => undefined } as any, 0);
  ok(eff.ok === true, "S3c the agent's pose reader (mcpl/effective) resolves it: no 'non-finite folded transform'", eff);
}

// ---- P: the pivot component (research 52: Roblox's PivotOffset; where it turns and scales from, never moves it) ----
{ const { editOps, inspectSchema, addOps } = await import("../../shared/editschema.js");
  // the planner's door ops: a set's value / a delete of the component
  const val = (r) => r.ops[0]?.verb === "set" ? r.ops[0].args.value : r.ops[0]?.verb === "delete" ? null : undefined;
  const { componentsOf, entityOf } = await import("../../shared/components.js");
  const pw = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "pivots"), actor, tool, args); };
  pw("ann", "create-world", { title: "pivots" });
  pw("ann", "create", { id: "gate", model: "crate", components: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  ok(pw("ann", "set", { id: "gate", component: "pivot", value: { pos: [0.3, 0, 0] } }).ok, "P1 the door takes a pivot {pos: [x,y,z]}");
  ok(code(pw("ann", "set", { id: "gate", component: "pivot", value: { pos: [1, 2] } })) === "shape" && code(pw("ann", "set", { id: "gate", component: "pivot", value: { pos: [0, 0, 0], q: [0, 0, 0, 1] } })) === "shape", "P2 …and refuses a bad one (two numbers; an extra field), saying the shape");
  const tr = openWorld(root, "pivots").state().entities.gate.c.transform;
  ok(JSON.stringify(tr.pos) === "[0,0,0]", "P3 setting a pivot never moved the thing", tr);
  const ent = { lib: "x.glb", pos: [0, 0, 0], comp: { pivot: { pos: [0.3, 0, 0] } } };
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
  const a = addOps({ lib: "x.glb", pos: [0, 0, 0] }, "g", "Pivot");
  ok(a.ops[0]?.args?.component === "pivot" && JSON.stringify(a.ops[0].args.value) === '{"pos":[0,0,0]}', "P9 Add Component ▸ Pivot starts at the origin (then centre/base)", a);
  const bare = { lib: "x.glb", pos: [0, 0, 0] };
  const c4 = editOps(bare, "g", { "pivot.centre": true }, live);
  ok(!c4.errors.length && JSON.stringify(val(c4)) === JSON.stringify({ pos: [2.6, 0.375, 0] }), "P10 pivot.centre works on a thing with NO pivot yet (Hazel: needed a dummy pivot first)", c4);
  const c5 = editOps(bare, "g", { "pivot.y": 1.5 }, live);
  ok(!c5.errors.length && JSON.stringify(val(c5)) === JSON.stringify({ pos: [0, 1.5, 0] }), "P11 …as does pivot.y", c5);
  // the channel edits honour the pivot too (Maya's channel box; agent lab round 2, Rowan: 'edit rot.y +=90' swung the gate about its origin)
  const gate = { lib: "x.glb", pos: [10, 0, 10], yaw: 0, comp: { pivot: { pos: [1, 0, 0] } } };
  const placeOf = (r) => r.ops.find((o) => o.verb === "set" && o.args.component === "transform")?.args.value;   // the whole transform
  const r1 = placeOf(editOps(gate, "g", { "rot.y": 90 }, live));
  ok(r1 && Math.abs(r1.pos[0] - 11) < 1e-6 && Math.abs(r1.pos[2] - 11) < 1e-6, "P12 rot.y = 90 on a pivoted thing turns it ABOUT the pivot: its origin goes to (11, 0, 11)", r1);
  const r2 = placeOf(editOps(gate, "g", { "pos.scale": 2 }, live));
  ok(r2 && Math.abs(r2.pos[0] - 9) < 1e-6 && Math.abs(r2.pos[2] - 10) < 1e-6, "P13 …and scale 2 grows it about the pivot (the pivot stays at 11): origin to (9, 0, 10)", r2);
  const r3 = placeOf(editOps(gate, "g", { "rot.y": 90, "pos.x": 5 }, live));
  ok(r3 && r3.pos[0] === 5 && r3.pos[2] === 10, "P14 …but a typed translate in the same edit wins (the pivot never second-guesses it)", r3);
  const r4 = placeOf(editOps({ lib: "x.glb", pos: [10, 0, 10], yaw: 0 }, "g", { "rot.y": 90 }, live));
  ok(r4 && r4.pos[0] === 10 && r4.pos[2] === 10, "P15 …and with no pivot, a turn stays about the origin, as before", r4); }

// ---- TN: turn {id, axis, deg, space, about} — the gizmo's rotate for agents (agent lab: Juniper #3) ----
{ const tw = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "turns"), actor, tool, args); };
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
{ const uw = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "undoredo"), actor, tool, args); };
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
{ const hw = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "hinge"), actor, tool, args); };
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

// ---- SW: a push re-expresses the swing at the push instant, as v1's pendulumImpulse does (v4-vs-v1 review 10-06 #5):
// no jump at the push, and pushing in rhythm builds. v4 kept the old phase with a new t0 and halved amp (a snap). ----
{ const sw = (actor, tool, args = {}) => { process.env.V4_NOW = String(T); return request(openWorld(root, "swingpush"), actor, tool, args); };
  const { pendulumTheta } = await import("../../client/lib/motioneval.js");
  T += 100; sw("ann", "create-world", { title: "swingpush" });
  T += 100; sw("ann", "create", { id: "frame", model: "swing-frame", components: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  T += 100; sw("ann", "create", { id: "seat", model: "swing-seat", place: { hang: "frame", height: 0.45 } });
  T += 100; sw("ann", "set", { id: "seat", component: "reactions", value: { push: { kind: "impulse", strength: 0.5 } } });
  const mo = () => openWorld(root, "swingpush").state().entities.seat.c.motion;
  const theta = (m, at) => m ? pendulumTheta(m, Math.max(0, (at - m.t0) / 1000)) : 0;
  T += 100; const p1 = sw("bob", "use", { id: "seat", action: "push", args: { impulse: [0, 0, 1] } });
  const m1 = mo();
  ok(p1.ok && Math.abs(theta(m1, T)) < 1e-3, "SW1 a swing at rest doesn't jump on the first push (it starts moving from where it hangs)", { p1: p1.refused, m1, th: theta(m1, T) });
  const w0 = 2 * Math.PI / (m1?.period ?? 2.4);
  // push again a quarter period later, mid-swing: the angle at that instant must be the same before and after
  T += Math.round(250 * (m1?.period ?? 2.4)) + 37;
  const before = theta(m1, T);
  sw("bob", "use", { id: "seat", action: "push", args: { impulse: [0, 0, 1] } });
  const m2 = mo();
  ok(Math.abs(theta(m2, T) - before) < 2e-3, "SW2 a mid-swing push keeps the angle at the push instant (no snap)", { before, after: theta(m2, T), m2 });
  // rhythm: push at each forward pass through the bottom; amplitude grows push after push
  let m = mo(), amps = [];
  for (let k = 0; k < 4; k++) {
    let t = T; for (let i = 0; i < 4000; i++) { t += 5; const a = theta(m, t), b = theta(m, t + 5); if (a <= 0 && b > 0) break }   // next upward zero crossing
    T = t + 5; sw("bob", "use", { id: "seat", action: "push", args: { impulse: [0, 0, 1] } }); m = mo(); amps.push(m.amp);
  }
  ok(amps.every((a, i) => i === 0 || a > amps[i - 1] - 1e-9) && amps[3] > amps[0] + 0.05, "SW3 pushing in rhythm builds the swing", amps);
  // SW4 the angular form (v1's {impulse: x}, translated): from rest, a push adds exactly x rad/s of turn rate, so the
  // amplitude is x / ω0. The linear form divides by the hinge distance; both are the general impulse (Godot
  // apply_impulse / apply_torque_impulse)
  T += 100; sw("ann", "create", { id: "seat2", model: "swing-seat", place: { hang: "frame", height: 0.45 } });
  T += 100; sw("ann", "set", { id: "seat2", component: "reactions", value: { push: { kind: "impulse", angular: 0.35 } } });
  T += 100; const p4 = sw("bob", "use", { id: "seat2", action: "push" });
  const m4 = openWorld(root, "swingpush").state().entities.seat2.c.motion; const w4 = 2 * Math.PI / m4.period;
  ok(p4.ok && Math.abs(m4.amp - 0.35 / w4) < 2e-3, "SW4 an angular impulse adds exactly its turn rate (amp = angular / ω0)", { p4: p4.refused, amp: m4?.amp, want: 0.35 / w4 });
  const tx = (await import("./import-v1/translate-v1.js")).translate(
    [{ seq: 0, ts: 1, actor: "a", verb: "spawn", args: { id: "s", lib: "swing-seat" } }, { seq: 1, ts: 2, actor: "a", verb: "comp", args: { id: "s", type: "reactions", data: { push: { impulse: 0.35 } } } }], {});
  ok(/"reactions":\{"push":\{"kind":"impulse","angular":0.35\}\}/.test(JSON.stringify(tx)), "SW4 v1's {impulse: x} translates to the angular impulse, exactly", JSON.stringify(tx).match(/"reactions":[^}]*\}/)?.[0]);
}

// ---- DU: disk practice (platforms review 10-06 #5): a torn last line is cut at open, not kept as a malformed entry
// forever; a blob whose bytes don't match its name is rewritten, not skipped forever ----
{ const du = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "durable"), actor, tool, args); };
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
{ const { warningText } = await import("../../shared/v4/refusal.js");
  ok(warningText({ id: "box", kind: "out-of-bounds", bounds: { min: [-20, 0, -20], max: [20, 12, 20] } }) === "box is outside the world's bounds (x -20…20, y 0…12, z -20…20 m)", "WT1 out-of-bounds says which bounds");
  ok(warningText({ id: "cup", kind: "overlap", with: "x--5269616e6e6f6e", by: 0.1 }) === "cup overlaps Riannon by 0.1 m", "WT2 an overlap reads as a sentence, names decoded");
  const ww = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "warnwords"), actor, tool, args); };
  ww("ann", "create-world", { title: "warnwords" });
  const far = ww("ann", "create", { id: "far", model: "crate", components: { transform: { pos: [500, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  ok((far.warnings ?? []).some((w) => w.kind === "out-of-bounds" && w.bounds?.max), "WT3 the door's out-of-bounds warning carries the bounds", far.warnings);
  const { enc } = await import("../../shared/v4/names.js");
  ww("ann", "set", { id: "@world", component: "roles:" + enc("Hazel"), value: { role: "builder" } });
  ww(enc("Hazel"), "create", { id: "hz", model: "crate", components: { transform: { pos: [1, 0, 1], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  const other = ww("ann", "set", { id: "hz", component: "label", value: "hazel's crate" });
  const nt = (other.notes ?? []).find((x) => x.madeBy);
  ok(nt && /this is Hazel's/.test(nt.why), "WT4 the 'this is X's' note names a person, not an encoded id (x--48617a656c)", nt); }

// ---- HS: where a value came from, and one thing's history (R 10-04: recent by default, deeper on request) ----
{ const { enc } = await import("../../shared/v4/names.js");
  const hw = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "histw"), actor, tool, args); };
  hw("ann", "create-world", { title: "histw" });
  hw("ann", "set", { id: "@world", component: "roles:" + enc("Rowan"), value: { role: "builder" } });
  hw("ann", "create", { id: "box", model: "crate", components: { label: "box", transform: { pos: [1, 0, 1], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  const tSet = T + 100; hw(enc("Rowan"), "set", { id: "box", component: "transform", value: { pos: [2, 0, 1], q: [0, 0, 0, 1], scale: [1, 1, 1] } });
  const ins = hw("ann", "inspect", { id: "box" });
  ok(ins.touched?.transform?.by === enc("Rowan") && ins.touched.transform.ts === tSet, "HS1 inspect says who last changed the transform, and when", ins.touched);
  ok(ins.touched?.transform?.who === "Rowan", "HS1b …by a name a person reads (who), beside the id (by)", ins.touched?.transform);
  ok(ins.touched?.label?.by === "ann" && ins.touched.label.created === true, "HS2 …and that the label is as it was made, by its maker", ins.touched?.label);
  for (let k = 0; k < 6; k++) hw("ann", "set", { id: "box", component: "label", value: `box ${k}` });
  const p1 = hw("ann", "history", { id: "box", limit: 3 });
  ok(p1.entries?.length === 3 && p1.entries[0].seq > p1.entries[1].seq && p1.entries.every((x) => x.changed.includes("label")) && typeof p1.next === "number", "HS3 history {id} is that thing's acts, newest first, a page at a time, with next", p1);
  const all = []; let page = p1; all.push(...page.entries); while (page.next !== undefined) { page = hw("ann", "history", { id: "box", limit: 3, before: page.next }); all.push(...page.entries); }
  ok(all.length === 8 && all.at(-1).changed.includes("(created)") && all.some((x) => x.by === enc("Rowan") && x.changed.includes("transform")), "HS4 …paging back reaches its creation, every act once", all.map((x) => [x.seq, x.changed.join()]));
  const { TOUCH_HORIZON } = await import("../../shared/v4/door.js");
  let landed = 0; for (let k = 0; k < TOUCH_HORIZON + 2; k++) { T += 5000; if (hw("ann", "set", { id: "box", component: "label", value: `n${k}` }).ok) landed++; }   // spaced past the rate limit
  ok(landed === TOUCH_HORIZON + 2, "HS5a (setup) every edit past the horizon landed", landed);
  const deep = hw("ann", "inspect", { id: "box" });
  ok(deep.touched?.transform?.beyond > 0 && deep.touched.transform.by === undefined && deep.touched.label?.by === "ann", "HS5 past the horizon it says 'unchanged since before #N' (beyond), never pretends it found nothing", deep.touched);
  const far = []; let pg = hw("ann", "history", { id: "box", limit: 50 }); far.push(...pg.entries); while (pg.next !== undefined) { pg = hw("ann", "history", { id: "box", limit: 50, before: pg.next }); far.push(...pg.entries); }
  ok(far.some((x) => x.by === enc("Rowan") && x.changed.includes("transform")), "HS6 …and the deep search (history paging) still finds the transform change behind the horizon", far.length); }

// ---- H7 (review F3, 2026-10-05): an id is never reused by a NEW thing, but undo brings back the same thing ----
{ let now = T + 40000; const w = openLive(root + "h7/", "h7", { kindOf: LABKIND, now: () => now });
  const call = (actor, tool, args = {}) => { now += 100; return request(w, actor, tool, args); };
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

// LT: the light every engine shares — a spot's cone (half-angles, rad), and bounds the door holds for any component
{ T += 100; process.env.V4_NOW = String(T); const L = (a) => request(openWorld(root, "lights"), "ann", "set", { id: "lamp", component: "light", value: a });
  request(openWorld(root, "lights"), "ann", "create-world", { title: "lights" });
  request(openWorld(root, "lights"), "ann", "create", { id: "lamp", model: "table-lamp" });
  ok(L({ kind: "spot", angle: 0.5, inner: 0.3, range: 8, intensity: 20 }).ok, "LT1 a spot light with its cone (glTF/Godot half-angles) is taken");
  ok(L({ kind: "point", intensity: -1 }).refused?.code === "bounds", "LT2 a negative intensity is refused (bounds)");
  ok(L({ kind: "point", range: 0 }).refused?.code === "bounds", "LT2 a range of 0 is refused");
  ok(L({ kind: "spot", angle: 2 }).refused?.code === "bounds", "LT2 a cone wider than a hemisphere (half-angle > π/2) is refused");
  ok(L({ kind: "point", color: 0x1000000 }).refused?.code === "bounds", "LT2 a color past 0xffffff is refused"); }
// SK: sockets — a named attachment point; with body, a person attaches by using it (chair, swing, saddle, car seat)
{ T += 100; process.env.V4_NOW = String(T); const R = (actor, tool, args) => request(openWorld(root, "sockets"), actor, tool, args);
  R("ann", "create-world", { title: "sockets" });
  R("ann", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  R("ann", "create", { id: "chair1", model: "chair" });
  const sit = R("bob", "use", { id: "chair1", action: "sit" });
  ok(sit.ok && sit.recorded === false && sit.attach?.to === "chair1" && sit.attach.socket === "seat" && sit.attach.pose === "sitchair", "SK1 a chair's model socket: use {sit} attaches you (presence), at its seat, in its pose", sit);
  ok(R("ann", "create", { id: "horse", model: "crate", components: { sockets: { saddle: { pos: [0, 1.2, 0], body: { action: "ride", pose: "sit", exit: [0.8, 0, 0] } }, pannier: { pos: [0.4, 0.8, 0] } } } }).ok, "SK2 sockets with and without a body are taken");
  const look = R("bob", "inspect", { id: "horse" });
  const offers = JSON.stringify(look);
  ok(JSON.stringify(look.actions) === '["ride"]', "SK2 …it offers 'ride' (its body socket's action), and the bare attach point offers nothing", look.actions);
  const ride = R("bob", "use", { id: "horse", action: "ride" });
  ok(ride.ok && ride.attach?.socket === "saddle" && ride.attach.pose === "sit", "SK2 use {ride} attaches you at the saddle", ride);
  R("ann", "create", { id: "throne", model: "crate", components: { sockets: { seat: { pos: [0, 0.5, 0], body: { who: "owner" } } } } });
  ok(R("bob", "use", { id: "throne", action: "sit" }).refused?.code === "rights" && R("ann", "use", { id: "throne", action: "sit" }).ok, "SK3 body.who: a builder may not sit on the owner's throne; the owner may");
  const bad = (v) => R("ann", "set", { id: "horse", component: "sockets", value: v }).refused?.code;
  ok(bad({ s: { pos: [0, 1, 0], pose: "sit" } }) === "schema", "SK4 a socket's pose lives in body (an unknown socket key is refused, with a did-you-mean)");
  ok(bad({ s: { pos: [0, 1, 0], body: { action: "Ride Now" } } }) === "shape", "SK4 body.action is a lower-case verb");
  ok(bad({ s: { body: {} } }) === "shape", "SK4 a socket needs its pos");
  ok(bad({ s: { pos: [0, 1, 0], body: { who: "king" } } }) === "shape", "SK4 body.who is visitor, builder or owner");
  // SK5-8: the whole body block (shared/sockbody.js), through the door's own request path
  ok(R("ann", "set", { id: "horse", component: "sockets", value: { saddle: { pos: [0, 1.2, 0], body: { action: "ride", anchor: "hips", pose: { by: "speed", clips: [[0, "idle"], [2, "walk"], [6, "run"]] },
    reach: { leftHand: { at: [-0.2, 1.4, 0.5], vr: "near" } }, look: { yaw: [-90, 90] }, input: { move: "drive", look: "aim" }, leaveBy: "jump", fromSeat: true } } } }).ok, "SK5 a saddle with a blend by speed, reins, look limits, a driver's input and leaveBy is taken");
  ok(bad({ s: { pos: [0, 1, 0], body: { anchr: "hips" } } }) === "schema" && bad({ s: { pos: [0, 1, 0], body: { reach: { leftHand: { at: [0, 1, 0], grip: 1 } } } } }) === "schema"
    && bad({ s: { pos: [0, 1, 0], body: { reach: { tail: { at: [0, 1, 0] } } } } }) === "schema", "SK6 closed keys: the body, a reach, the reach limbs (the reach chains)");
  ok(bad({ s: { pos: [0, 1, 0], body: { leaveBy: "teleport" } } }) === "shape" && bad({ s: { pos: [0, 1, 0], body: { look: { pitch: [10, -10] } } } }) === "shape"
    && bad({ s: { pos: [0, 1, 0], body: { pose: { by: "mood", clips: [[0, "idle"], [1, "walk"]] } } } }) === "shape" && bad({ s: { pos: [0, 1, 0], body: { enter: 42 } } }) === "shape", "SK7 enums, ranges, signals and clip names");
  ok(bad({ a: { pos: [0, 1, 0], body: { input: { move: "drive" } } }, b: { pos: [1, 1, 0], body: { input: { move: "drive" } } } }) === "shape", "SK8 at most one drive per thing");
  const att = R("bob", "use", { id: "horse", action: "ride" }).attach;
  // SK9: a part's motion runs on the door's clock too (a seat locked to its phase needs every client to agree on it)
  const pm = R("ann", "create", { id: "swingset", model: "crate", components: { "motion:plank": { type: "pendulum", amp: 0.4, period: 3 }, motion: { type: "pendulum", amp: 0.1, period: 2 } } });
  const pmc = R("ann", "inspect", { id: "swingset" });
  ok(pm.ok && Number.isFinite(pmc.components?.["motion:plank"]?.t0) && Number.isFinite(pmc.components?.motion?.t0), "SK9 the door stamps t0 on a part's motion (motion:<part>) as on the whole thing's", pmc.components);
  ok(att?.anchor === "hips" && att.leaveBy === "jump" && att.input?.move === "drive" && att.reach?.leftHand?.vr === "near" && att.fromSeat === true && att.pose?.by === "speed", "SK8 use {ride} answers attach with what the body does there", att); }
const w0 = () => openWorld(root, "tier0");
// T0 (component review, tier 0): values that would freeze or break every visitor, or wedge the world, are refused
{ T += 100; process.env.V4_NOW = String(T); const R = (tool, args) => request(openWorld(root, "tier0"), "ann", tool, args);
  R("create-world", { title: "tier0" }); R("create", { id: "hearth", model: "crate" });
  const S = (id, comp, value) => R("set", { id, component: comp, value }).refused?.code;
  ok(S("@world", "terrain", { kind: "noise", segments: 100000 }) === "bounds", "T0a terrain segments past 512 (10^10 vertices on every client) is refused");
  ok(S("@world", "terrain", { kind: "noise", size: 0 }) === "bounds", "T0a a terrain of size 0 is refused");
  ok(S("@world", "terrain", { kind: "noise", octaves: 0 }) === "bounds", "T0a terrain octaves outside 1–8 is refused (the engine clamps; the door agrees)");
  ok(S("@world", "grass", { width: 1e9, depth: 10 }) === "bounds", "T0b a grass field a million km wide is refused");
  ok(S("hearth", "particles", { preset: "fire", count: 1e9 }) === "bounds", "T0c a billion particles is refused (600 is the renderer's ceiling)");
  ok(S("hearth", "particles", { preset: "fire", size: -3 }) === "bounds" && S("hearth", "particles", { preset: "fire", opacity: 7 }) === "bounds", "T0c negative size, opacity past 1: refused");
  ok(R("set", { id: "hearth", component: "particles", value: { preset: "fire", count: 150, size: 0.3, opacity: 0.8, lifetime: 1.2 } }).ok, "T0c …an ordinary fire is still taken");
  ok(S("@world", "bounds", {}) === "shape" && S("@world", "bounds", { min: [5, 0, 5], max: [-5, 10, -5] }) === "shape", "T0d bounds needs min and max, with min ≤ max on every axis");
  ok(R("create", { id: "c-after", model: "crate" }).ok, "T0d …and creating still answers (an empty bounds used to commit the create, then crash its reply)");
  ok(S("hearth", "transform", { pos: [0, 0, 0], q: [0, 0, 0, 0], scale: [1, 1, 1] }) === "shape", "T0e a zero quaternion is refused (it isn't a rotation)");
  ok(S("hearth", "transform", { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [0, 1, 1] }) === "shape", "T0e a zero scale is refused (its children's transforms divide by it)");
  const nq = R("set", { id: "hearth", component: "transform", value: { pos: [0, 0, 0], q: [0, 0, 0, 0.5], scale: [1, 1, 1] } });
  const q = w0().state().entities.hearth?.c.transform?.q;
  ok(nq.ok && Math.abs(Math.hypot(...q) - 1) < 1e-9, "T0e a non-unit quaternion is stored normalized (the door and the renderer then agree)", q); }
// T1 (component review, tier 1): components say what they are, where they go, and nothing the renderer reads is refused
{ T += 100; process.env.V4_NOW = String(T); const R = (tool, args) => request(openWorld(root, "tier1"), "ann", tool, args);
  R("create-world", { title: "tier1" }); R("create", { id: "chair", model: "crate" });
  const S = (id, comp, value) => R("set", { id, component: comp, value });
  for (const [comp, value] of [["about", { name: "x" }], ["spawn", { pos: [0, 0, 0], radius: 2 }], ["roles:u-aaaaaaaaaaaaaaaaaaaa", { role: "builder" }], ["blueprints:foo", { name: "f" }], ["sky", { hours: 7 }]])
    ok(S("chair", comp, value).refused?.code === "world-only", `T1a ${comp} belongs to the world: on a chair it's refused, and told where it goes`);
  for (const [comp, value] of [["transform", { pos: [1, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }], ["model", "crate"], ["parent", { to: "chair" }]])
    ok(S("@world", comp, value).refused?.code === "thing-only", `T1b ${comp} belongs to a thing: on @world it's refused (the door and renderer disagreed about where its children were)`);
  ok(S("chair", "structure", { tile: 1, wallH: 2.6, wallT: 0.12, slabT: 0.15, levels: [], labels: {} }).ok, "T1d structure.slabT, which the renderer reads, is taken");
  ok(S("chair", "particles", { preset: "fire", texture: "eidoverse/assets/particle_textures/flame.png" }).ok, "T1e particles.texture (in AGENTS.md's own example) is taken");
  ok(S("chair", "particles", { preset: "dust", area: [2, 0.5, 2] }).ok && S("chair", "particles", { preset: "dust", area: [2, 99, 2] }).refused?.code === "bounds", "T1e particles.area [x,y,z] is taken, and bounded per axis");
  ok(S("chair", "particles", { preset: "fire", texture: "../../etc/x.png" }).refused?.code === "shape", "T1e a texture outside the particle library is refused"); }
// CP (Commons v1→v4 parity audit, 10-06): use with no action, the whole log's history paged and filtered, the spoken trio
{ const R = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "cp"), actor, tool, args); };
  R("ann", "create-world", { title: "cp" });
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
  const now = T + 100;
  const s1 = R("ann", "say", { text: "spoken one", spoken: true, utt: 3, t0: now - 1000 });
  const s2 = R("ann", "say", { text: "late t0", spoken: true, utt: 4, t0: now - 10_000_000 });
  const s3 = R("ann", "say", { text: "bad utt", spoken: true, utt: -1, t0: now });
  const s4 = R("ann", "say", { text: "no spoken", utt: 5 });
  const s5 = R("ann", "say", { text: "future t0", spoken: true, utt: 6, t0: now + 10_000_000 });
  const E = openWorld(root, "cp").entries; const b = (r) => E[r.seq]?.body;
  ok(s1.ok && b(s1).spoken === true && b(s1).utt === 3 && b(s1).t0 === now - 1000, "CP8 a spoken say keeps spoken/utt/t0 (they were dropped on v4)", b(s1));
  ok(b(s2).t0 >= now + 100 - 300_000 && b(s2).utt === 4, "CP8 …t0 is clamped into the 5-minute utterance window", b(s2));
  ok(b(s5).t0 <= now + 600 && b(s5).t0 >= now, "CP8 …a t0 in the future is clamped to now", b(s5));
  ok(!("spoken" in b(s3)) && !("utt" in b(s3)) && !("t0" in b(s3)) && !("utt" in b(s4)), "CP8 …a malformed trio (utt -1, or no spoken) leaves a plain say", [b(s3), b(s4)]);
  const k = makeV4Client(); k.adopt({ state: stateView(fold(E.slice(0, s1.seq))), head: s1.seq - 1 });
  const got = k.ingest([E[s1.seq]], s1.seq).says[0];
  ok(got?.spoken === true && got.utt === 3 && got.t0 === now - 1000, "CP8 …and a client's fold hands it on with the chat line", got); }
// ---- CA: captions (one line of what a screen said). The rights live on the SCREEN (captioners {ids}); the tool writes
// the bag by shared/captions.js's rules; nobody forges the bag with a plain set ----
{ const cw = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "captions"), actor, tool, args); };
  cw("ann", "create-world", { title: "captions" }); cw("ann", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  cw("ann", "create", { id: "screen", model: "crate", place: { at: [0, 0] } });
  const sess = "2026-10-07T00:00:00.000Z-abc123";
  const line = (n, extra = {}) => ({ id: "screen", session: sess, n, t0: n, t1: n + 1, text: `line ${n}`, ...extra });
  const v1r = cw("vic", "caption", line(1));
  ok(code(v1r) === "rights", "CA1 a visitor who isn't one of the screen's captioners can't caption it", v1r.refused);
  ok(cw("bob", "set", { id: "screen", component: "captioners", value: { ids: ["vic"] } }).ok, "CA2 whoever may edit the screen names its captioners");
  const c1 = cw("vic", "caption", line(1, { title: "the talk" }));
  const bag = () => openWorld(root, "captions").state().entities.screen.c.captions;
  ok(c1.ok && bag()?.window?.[0]?.text === "line 1" && bag().title === "the talk" && bag().n === 1, "CA3 …and a listed captioner (a visitor) writes a line", [c1.refused, bag()]);
  const dup = cw("vic", "caption", line(1));
  ok(code(dup) === "caption" && bag().n === 1, "CA4 a resend of a line already written is refused (that refusal is the bot's receipt), nothing written twice", dup.refused);
  ok(cw("vic", "caption", line(2)).ok && bag().window.length === 2, "CA5 the next n appends");
  ok(cw("vic", "caption", line(3, { gen: 5 })).ok, "CA6 (setup) a newer leg (the server stamps each connection's generation) writes");
  const stale = cw("vic", "caption", line(4, { gen: 2 }));
  ok(code(stale) === "caption" && /newer leg/.test(stale.refused?.reason), "CA6 a superseded leg (a lower generation) can't write over its successor", stale.refused);
  const forged = cw("bob", "set", { id: "screen", component: "captions", value: { session: sess, n: 99, gen: 99, window: [{ t0: 0, t1: 1, text: "forged" }] } });
  ok(code(forged) === "caption-only" && bag().n === 3, "CA7 a builder can't forge the bag with a plain set (only the caption request writes it)", forged.refused);
  ok(code(cw("vic", "caption", { id: "screen", session: "nope", n: 1, t0: 0, t1: 1, text: "x" })) === "shape", "CA8 a malformed line is refused by shape (the session's form, shared/captions.js)");
  const end = cw("vic", "caption", { id: "screen", session: sess, end: true, gen: 5 });
  ok(end.ok && bag() === undefined, "CA9 end clears the screen (the history keeps every line)", [end.refused, bag()]);
  ok(cw("bob", "set", { id: "screen", component: "captioners", value: { ids: [] } }).ok && code(cw("vic", "caption", line(1, { session: "2026-10-07T00:00:01.000Z-def456" }))) === "rights", "CA10 taken off the list, they can't caption it any more"); }

// ---- IM: an imported world's records are carried, never written by hand (review 10-07 M1: a request could plant a guard,
// imported-bans:<id>, imported-behavior:<name> or imported:* and wake readers that no longer mean anything) ----
{ const iw = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "imported"), actor, tool, args); };
  iw("ann", "create-world", { title: "imported" }); iw("ann", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  iw("ann", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
  const tries = [["box", "imported-guard", true], ["box", "imported:kind", "light"], ["@world", "imported-behavior:x", { src: "store/scripts/x.js" }], ["@world", "imported-bans:u-aaaaaaaaaaaaaaaaaaaa", { reason: "x" }], ["@world", "imported-epoch", { sim: "eidosim@0.5.0" }]];
  const by = tries.map(([id, component, value]) => code(iw("bob", "set", { id, component, value })));
  ok(by.every((c) => c === "imported"), "IM1 a builder can't write an imported guard, an imported field, an old binding, an imported ban or an imported epoch", by);
  ok(iw("ann", "set", { id: "box", component: "imported:note", value: "kept" }).ok, "IM2 …an owner can (a copy of an imported world writes them; a repair)");
  { const d = iw("ann", "delete", { id: "box", component: "imported:note" }); ok(d.ok, "IM3 …and deleting one is an ordinary edit (a keyed record is its creator's or an owner's to delete)", d.refused); } }

console.log(`[door-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
