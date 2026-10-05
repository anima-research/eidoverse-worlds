// tools/v4/door-check.ts — slice 2's in-process checks (the server-level ones over a real WebSocket are
// server-check.ts). usage: bun tools/v4/door-check.ts
//   N   names.js: one encoding for actors, ids and components; the lab's `0abc` / `n0abc` collision is gone
//   T   the engine translator's own name, and the v1 fold build it stamps
//   P   locks (PROTOCOL-v4 §5): v1's matrix (tools/locktest.ts), ancestors, through_lock, the gameplay lock inside
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
import { translate, TRANSLATOR } from "../../shared/v4/translate-v1.js";
import { legacyState, legacyDelta, foldLegacy, legacyDiff } from "../../shared/v4/legacy.js";
import { openWorld } from "../../server/v4/disk.ts";
import { openLive } from "../../server/v4/live.ts";
import { v1FoldBuild, v1FoldFiles } from "../../server/v4/build.ts";
import { emptyState as v1Empty, foldEntry as v1fold } from "../../shared/fold.js";
import { worldPose } from "../../shared/hierarchy.js";

const root = scratch("door");
let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const code = (r: any) => r?.refused?.code;
let T = 1800000000000;

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
  ok(r.out[0].body.translatedFrom.translator === TRANSLATOR && r.out[0].body.translatedFrom.fold === v1FoldBuild(), "T2 genesis names the translator and the v1 fold build", r.out[0].body.translatedFrom);
  const c = r.final.v4[enc("lamp_1")];
  ok(c && c["n0abc"] === 2 && c[encName("0abc")] === 1 && !r.stats.divergences, "T3 a translated world keeps comps '0abc' and 'n0abc' apart", c);
  ok(r.out[0].body.owners[0] === enc("Riannon"), "T4 genesis owners use the same encoding as the live door", r.out[0].body.owners);
  ok(v1FoldFiles().includes("shared/fold.js") && v1FoldFiles().length >= 5 && /^[0-9a-f]{16}$/.test(v1FoldBuild()), "T5 the fold build covers shared/fold.js and its imports", v1FoldFiles()); }

// ---- P: locks (PROTOCOL-v4 §5), mirroring v1's lock matrix (tools/locktest.ts) plus what v4 adds ----
// v1: a lock refuses everything that would MOVE, REPLACE or REMOVE the thing, for everyone, its locker included;
// everything that doesn't relocate it stays open (sit, use, motion, other comps); any builder may unlock. v4 adds:
// it binds what's attached to it too; through_lock: true lets whoever may remove it act through it.
{ const name = "locks";
  const call = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, name), actor, tool, args); };
  const W = () => openWorld(root, name);
  call("olive", "new", { title: "locks" });
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
    ok(/through_lock: true/.test(r.refused.teach) && /delete \{id: 'tbl', component: 'lock'\}/.test(r.refused.teach), "P7 …and teaches both ways through: through_lock, or unlock", r.refused.teach); }
  ok(code(call("bob", "delete", { id: "cup" })) === "locked" && code(call("bob", "place", { id: "cup", at: [4, 4] })) === "locked", "P8 …nor deleted or placed elsewhere");
  ok(code(call("bob", "delete", { id: "cup", component: "parent" })) === "locked", "P9 …nor lifted off (deleting its parent)");
  ok(code(call("bob", "set", { id: "bell", component: "transform", value: { pos: [0, 0.6, 0] } })) === "locked", "P10 a grandchild is bound too (the lock is two levels up)");
  // what stays open: everything that doesn't relocate it (v1: "sit / use / motion / other comps all stay open while locked")
  ok(call("olive", "set", { id: "tbl", component: "label", value: "the long table" }).ok && call("bob", "set", { id: "cup", component: "label", value: "a crate" }).ok, "P11 a label stays open (the locker's and a builder's)");
  ok(call("olive", "set", { id: "tbl", component: "motion", value: { type: "spin", axis: [0, 1, 0], amp: 0.2, period: 4 } }).ok, "P12 motion stays open (v1's matrix; a v4 motion animates in place)");
  ok(call("olive", "set", { id: "tbl", component: "light", value: { range: 4 } }).ok && call("olive", "set", { id: "tbl", component: "physics", value: { kind: "static" } }).ok, "P13 a light and physics stay open (neither relocates it)");
  ok(call("bob", "set", { id: "tbl", component: "reactions", value: { knock: { kind: "set", component: "label", value: "knocked" } } }).ok && call("vic", "use", { id: "tbl", action: "knock" }).ok, "P14 reactions stay open, and a visitor may still `use` it");
  { const r = call("bob", "create", { id: "cup2", model: "ball", place: { on: "tbl" } }); ok(r.ok, "P15 a NEW thing may be put on a locked table (a lock guards what is attached, not the surface)", r); }
  // through_lock
  { const n = W().entries.length; const r = call("bob", "set", { id: "cup", component: "transform", value: { pos: [0.1, 0.75, 0] }, through_lock: true });
    const E = W().entries.slice(n); const st = E.filter((e) => e.kind === "state"); const ops = st.flatMap((e) => e.body.ops ?? [e.body]);
    ok(r.ok, "P16 through_lock: true lets a builder (who may remove the lock) act through it", r.refused);
    ok(E.length === 2 && ops.length && ops.every((o) => o.comp !== "lock") && W().state().entities.tbl.c.lock === true, "P17 …and the log records only the edit: one act, one state entry, no unlock or relock; the lock is still on", E.map((e) => [e.kind, e.verb, e.body?.comp]));
    ok(E[0].kind === "act" && E[0].body.request.through_lock === true, "P18 …the act carries the request as sent, flag and all (history shows who went through)", E[0].body); }
  ok(call("olive", "set", { id: "tbl", component: "transform", value: { pos: [0, 0, 3.1] }, through_lock: true }).ok, "P19 the locker herself acts through it the same way");
  ok(code(call("bob", "set", { id: "cup", component: "transform", value: { pos: [0, 0.75, 0] }, through_lock: "yes" })) === "shape", "P20 through_lock is a boolean");
  ok(call("bob", "set", { id: "cup2", component: "label", value: "x", through_lock: true }).ok, "P21 through_lock on an edit no lock guards is harmless");
  { // a capability never acts through a lock: a visitor's use of a handler that would move it, flag or not
    call("bob", "set", { id: "cup2", component: "reactions", value: { nudge: { kind: "set", component: "transform", value: { pos: [0.2, 0.75, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } } });
    const v = call("vic", "use", { id: "cup2", action: "nudge", through_lock: true }), b = call("bob", "use", { id: "cup2", action: "nudge", through_lock: true });
    ok(code(v) === "locked" && /not a handler/.test(v.refused.teach), "P22 a visitor can't move it through a handler with through_lock (they may not remove the lock)", v.refused);
    ok(code(b) === "locked", "P23 …nor can a builder through a handler (through_lock covers your own edits, not a capability)", b.refused); }
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
    const u = call("bob", "undo", { through_lock: true });
    ok(u.ok && JSON.stringify(W().state().entities.box.c.transform.pos) === "[6,0,6]" && W().state().entities.box.c.lock === true, "P32 …and undo {through_lock: true} reverts it, leaving the lock on", u.refused ?? W().state().entities.box.c); }
  { // the gameplay lock lives inside its own component: door {open, locked}
    call("bob", "create", { id: "gate", model: "door", components: { door: { open: false, locked: false }, reactions: { open: { kind: "toggle", unless: "locked" }, bolt: { kind: "set", component: "door", field: "locked", value: true, who: "builder" } } }, place: { at: [-4, 0] } });
    ok(call("vic", "use", { id: "gate", action: "open" }).ok && W().state().entities.gate.c.door.open === true, "P33 a visitor opens the door: toggle's default is door.open");
    ok(call("bob", "use", { id: "gate", action: "bolt" }).ok && JSON.stringify(W().state().entities.gate.c.door) === '{"open":true,"locked":true}', "P34 bolting sets door.locked, inside the door's own component");
    const r = call("vic", "use", { id: "gate", action: "open" });
    ok(code(r) === "barred" && !("locked" in W().state().entities.gate.c) && !("open" in W().state().entities.gate.c), "P35 …then opening is barred by door.locked; no top-level `locked` or `open` exists", r.refused);
    const i = call("vic", "inspect", { id: "gate" }); ok(i.notForYou?.some((x) => x.action === "open") && i.door?.locked === true, "P36 inspect shows why, and the door's state", i.notForYou);
    call("olive", "set", { id: "gate", component: "lock", value: true });
    ok(code(call("bob", "use", { id: "gate", action: "bolt" })) === undefined, "P37 an edit lock doesn't stop using the door (v1: use stays open)"); }
  { // §5: a held thing keeps its logged parent, but holding suspends parent constraints until it settles
    const hc = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "held"), actor, tool, args); };
    hc("olive", "new", { title: "held" }); hc("olive", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
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
    const r = translate(old); const f = r.final.v4;
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
  call(R, "new", { title: "names" });
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
  const st = call("bob", "set", { id: "pot", component: "transform", value: { ...t0, pos: [5, 0, 5] }, base: 1 });
  ok(code(st) === "stale" && /Riannon set it at/.test(st.refused.reason) && st.refused.by === R, "NR4 a stale-base refusal names them too", st.refused);
  call("bob", "create", { id: "cup", model: "crate", place: { at: [6, 2] } });
  const cupT = openWorld(root, name).state().entities.cup.c.transform;
  const mv = call("bob", "set", { id: "cup", component: "transform", value: { ...cupT, pos: [6, 0, 6] } });
  call(R, "set", { id: "cup", component: "transform", value: { ...cupT, pos: [7, 0, 7] } });
  const un = call("bob", "undo", { act: mv.act });
  ok(code(un) === "conflict" && /Riannon changed it since/.test(JSON.stringify(un.refused.skipped)) && un.refused.skipped?.[0]?.by === R, "NR5 an undo conflict names who changed it since (and by: the id)", un.refused);
  ok(refusalText("move x--4c616d70", { refused: { code: "locked", reason: "x--4c616d70 is locked (locked by x--5269616e6e6f6e at 9)", teach: "" } }) === "move Lamp refused by the door (locked): Lamp is locked (locked by Riannon at 9)",
    "NR6 the shared refusal text (what a person's toast and an agent's verb tools show) reads any escaped name back", refusalText("move x--4c616d70", { refused: { code: "locked", reason: "x--4c616d70 is locked (locked by x--5269616e6e6f6e at 9)" } }));
  ok(refusalText("x", { refused: { code: "c", reason: "h--abc and plain-id and x--zz stay" } }) === "x refused by the door (c): h--abc and plain-id and x--zz stay", "NR7 …a hashed name (h--) or a non-hex x-- is left as it is (it can't be read back)");
  { const V = (req) => lockVerb(req); const set = (component) => ({ tool: "set", args: { id: "a", component, value: 1 } });
    const got = [V(set("transform")), V(set("parent")), V({ tool: "place", args: { id: "a", at: [0, 0] } }), V({ tool: "delete", args: { id: "a" } }), V(set("model")),
      V({ tool: "batch", args: { ops: [set("transform"), { tool: "delete", args: { id: "b" } }] } }), V({ tool: "undo", args: { act: 3 } }), V(set("label")), V({ tool: "delete", args: { id: "a", component: "parent" } })];
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
  const r = translate(old); fs.writeFileSync(root + "worlds/tr-mounts.jsonl", r.out.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const v1 = v1Empty(); for (const e of old) v1fold(v1, e);
  const tc = (tool, args) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "tr-mounts"), "ann", tool, args); };
  ok(!r.stats.divergences && r.final.v4.box.parent?.order === "a0" && !("offset" in r.final.v4.box.parent), "M1 a translated mount is door-shaped: parent {to, order}, no offset copy (L2)", r.final.v4.box.parent);
  ok(JSON.stringify(r.final.v4.box.transform.pos) === "[0,0.75,0]" && JSON.stringify(r.final.v4.bell.transform.pos) === "[0.45,0.75,0.25]" && r.final.v4.bell.parent.slot === "perch",
    "M2 its transform is local: the offset, or (no offset) its socket's pos, and the slot is kept", [r.final.v4.box.transform, r.final.v4.bell.transform, r.final.v4.bell.parent]);
  const near = (a, b) => a && b && a.every((x, i) => Math.abs(x - b[i]) < 1e-6);
  for (const id of ["box", "bell", "stray", "jar"]) { const i = tc("inspect", { id }); const want = worldPose(v1.entities, id);
    ok(near(i.world?.pos, want.pos) && near(i.world?.q, want.q), `M3 the door sees ${id} where v1 draws it (world pose)`, [i.world, want]); }
  const p = tc("create", { id: "ball2", model: "ball", place: { on: "tbl" } }); const at = p.notes?.find((n) => n.placed)?.placed;
  const loc = openWorld(root, "tr-mounts").state().entities.ball2?.c.transform.pos; // local to tbl (it rides the table)
  ok(p.ok && loc && Math.max(Math.abs(loc[0]), Math.abs(loc[2])) > 0.4, "M4 place on the table avoids the riding crate at its centre (with @1's shape the door saw the crate 9 m away and the centre free)", [at, loc]);
  const chk = tc("check", {}).warnings ?? []; ok(!chk.some((x) => x.kind === "overlap" && [x.id, x.with].includes("box") && [x.id, x.with].includes("ball2")), "M5 …and check sees no overlap between them", chk);
  ok(chk.filter((x) => x.kind === "floating" && ["box", "bell", "jar"].includes(x.id)).length === 0, "M6 …nor calls a riding thing floating", chk); }

// ---- L: live world vs whole-log re-read ----
{ const dir = root + "live/"; T += 1000; let now = T;
  const w = openLive(dir, "live", { now: () => now, simModels: MODELS });
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
  call("rowan", "new", { title: "live" }); same("founded");
  call("rowan", "create", { id: "table-1", model: "table", place: { at: [0, 4] } });
  call("rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
  call("rowan", "set", { id: "@world", component: "roles:vic", value: { role: "visitor" } }); same("built");
  call("rowan", "set", { id: "@world", component: "sim", value: { engine: "eidosim@0.5.0" } });
  call("rowan", "move", { to: [0, 0, -0.5] }); call("rowan", "grab", { id: "ball" });
  ok(call("rowan", "throw", { id: "ball", v: [0, 2, 3] }).ok, "L throw accepted");
  call("rowan", "look", {}, 300); same("mid-flight (a read advanced the sim first)");
  { const r = call("rowan", "wait", {}, 6000); same("after the rest");
    const want = restsOf(w.entries).map((x) => ({ ...x, when: w.entries[x.seq].ts })).filter((x) => now - x.when < 60000).slice(-8).map((x) => [x.id, x.at.map((n) => Math.round(n * 1000) / 1000)]);
    ok(r.cameToRest?.length && JSON.stringify(r.cameToRest.map((x) => [x.id, x.at])) === JSON.stringify(want), "L wait's rests (from the act index) = restsOf over the whole log", [r.cameToRest, want]); }
  call("rowan", "set", { id: "table-1", component: "label", value: "first" }); call("rowan", "undo", {}); same("after an undo");
  const st = w.state(); const held = st.entities["table-1"]; call("rowan", "set", { id: "table-1", component: "label", value: "t" });
  ok(held === st.entities["table-1"] && !("label" in held.c), "L a state a caller holds never changes under it (copy on write)"); same("after a label"); }

// ---- U: the act index (research 37, slice 3 #5): undo and wait without scanning the log ----
{ const dir = root + "undo/"; let now = T + 3000;
  const w = openLive(dir, "undo", { now: () => now });
  const call = (actor, tool, args = {}) => { now += 100; return request(w, actor, tool, args); };
  const flat = (x) => JSON.stringify(Object.fromEntries(Object.entries(x).filter(([k]) => !["entries", "bad", "pt"].includes(k)).map(([k, v]) => [k, v instanceof Map ? [...v].sort((a, b) => String(a[0]).localeCompare(String(b[0]))) : v instanceof Set ? [...v].sort() : v])));
  let steps = 0, firstBad = null;
  const same = (what) => { steps++; const inc = flat(actIndexOf(w)), fresh = flat(actIndexFresh(readLog(fs.readFileSync(dir + "v4.jsonl"))));
    if (inc !== fresh && !firstBad) firstBad = [what, inc.slice(0, 300), fresh.slice(0, 300)]; };
  const step = (actor, tool, args = {}) => { const r = call(actor, tool, args); same(`${actor} ${tool}`); return r; };
  const purge = (values) => { now += 100; w.append({ kind: "purge", actor: "door", verb: "purge", body: { values } }); same("purge"); };
  const label = () => w.state().entities.crate?.c.label;
  step("rowan", "new", { title: "undo" }); step("rowan", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
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
  purge([{ seq: w.entries.findIndex((e, i) => i > s1.act && e.kind === "state" && e.cause === s1.act) }]);
  ok(w.state().entities.crate.c.label === "public", "U5 (the purge leaves the current value alone)");
  const u5 = step("bob", "undo", {});
  ok(code(u5) === "conflict" && /purged/.test(u5.refused.skipped?.[0]?.why) && w.state().entities.crate.c.label === "public", "U5 undoing the later label won't restore the purged one", [u5.refused, w.state().entities.crate.c.label]);
  // purge an act's whole body: its label can't be read, so undo {label} can't find it
  const b1 = step("bob", "batch", { label: "tidy", ops: [{ tool: "set", args: { id: "crate", component: "light", value: { range: 3 } } }] });
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
  const w = openLive(dir, "expect", { now: () => now });
  const call = (actor, tool, args = {}) => { now += 100; return request(w, actor, tool, args); };
  const n = () => w.entries.length;
  call("ann", "new", { title: "expect" }); call("ann", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  call("ann", "create", { id: "tbl", model: "table", place: { at: [0, 3] } });
  call("ann", "create", { id: "cup", model: "crate", place: { on: "tbl" } });
  const t0 = w.state().entities.tbl.c.transform;
  const moved = { ...t0, pos: [1, t0.pos[1], 3] };
  const e1 = call("ann", "set", { id: "tbl", component: "transform", value: moved, expect: [{ id: "tbl", component: "transform", value: t0 }] });
  ok(e1.ok && w.entries[e1.act].body.request.expect?.length === 1, "E1 expect equal to what's there: written, and the act records it as sent", e1.refused);
  call("bob", "set", { id: "tbl", component: "transform", value: { ...moved, pos: [2, t0.pos[1], 3] } });
  const before = n();
  const e2 = call("ann", "set", { id: "tbl", component: "transform", value: { ...moved, pos: [5, t0.pos[1], 5] }, expect: [{ id: "tbl", component: "transform", value: moved }] });
  ok(code(e2) === "changed" && e2.refused.by === "bob" && n() === before && w.state().entities.tbl.c.transform.pos[0] === 2, "E2 someone changed it since: refused `changed`, naming them, and nothing is written", [e2.refused, n() - before]);
  ok(code(call("ann", "set", { id: "tbl", component: "label", value: "x", expect: [{ id: "tbl", component: "label", value: "y" }] })) === "changed", "E3 expecting a value that isn't there");
  ok(call("ann", "set", { id: "tbl", component: "label", value: "x", expect: [{ id: "tbl", component: "label" }] }).ok, "E4 value left out = expect it absent");
  ok(code(call("ann", "set", { id: "tbl", component: "label", value: "z", expect: [{ id: "tbl", component: "label" }] })) === "changed", "E4b …and refused once it's there");
  ok(code(call("ann", "set", { id: "tbl", component: "label", value: "z", expect: { id: "tbl" } })) === "shape", "E5 a malformed expect is a shape refusal");
  ok(code(call("ann", "batch", { ops: [{ tool: "delete", args: { id: "tbl" } }], expect: [{ id: "gone", component: "transform", value: {} }] })) === "changed", "E6 expect guards a batch too (a thing that's gone)");
  // duplicate: create {from: <a thing>}
  call("ann", "set", { id: "tbl", component: "lock", value: true });
  const d1 = call("bob", "create", { from: "tbl" });
  const st = w.state(); const copy = d1.after && Object.keys(d1.after).find((k) => st.entities[k]?.c.model === "table" && k !== "tbl");
  const kid = copy && Object.keys(st.entities).find((k) => st.entities[k].c.parent?.to === copy);
  ok(d1.ok && copy && kid && !("lock" in st.entities[copy].c) && st.entities[kid].c.model === "crate", "D1 duplicate copies the thing and what's attached to it, as one act (the lock isn't copied)", [d1.refused, copy, kid]);
  ok(d1.ok && Math.abs(st.entities[copy].c.transform.pos[0] - (st.entities.tbl.c.transform.pos[0] + 0.5)) < 1e-9 && opsOf(w.entries[d1.seq]).filter((o) => o.verb === "create").length === 2, "D2 …0.5 m along x, in ONE state entry (two creates)", st.entities[copy]?.c.transform);
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
// server's after every request, and the v1 state the renderer draws equals the projection (verbs or a local re-draw) ----
{ let now = T + 12000; const w = openLive(root + "client/", "client", { now: () => now });
  const call = (actor, tool, args = {}) => { now += 100; return request(w, actor, tool, args); };
  call("ann", "new", { title: "client" }); call("ann", "create", { id: "tbl", model: "table", place: { at: [0, 3] } });
  const c = makeV4Client();
  c.adopt(JSON.parse(JSON.stringify({ state: stateView(w.state()), head: w.entries.length - 1, worldId: w.worldId })));
  let held = c.legacy({ recentChat: [], chatTotal: 0 }); let steps = 0, bad = null, rehydrated = 0, verbs = 0;
  const step = (what, actor, tool, args) => { const from = w.entries.length; const r = call(actor, tool, args);
    const fresh = JSON.parse(JSON.stringify(w.entries.slice(from))); // over the wire: plain JSON
    const k = c.ingest(fresh, from, held); steps++;
    if (k.resync) return { r, k };
    held = foldLegacy(held, k.v1); verbs += k.v1.length;
    if (k.rehydrate) { held = c.legacy(held); rehydrated++; }
    if (!bad && digest(c.st) !== digest(w.state())) bad = [what, "v4 state differs"];
    if (!bad && legacyDiff(held, legacyState(w.state()))) bad = [what, legacyDiff(held, legacyState(w.state()))];
    return { r, k }; };
  step("on", "ann", "create", { id: "cup", model: "crate", place: { on: "tbl" } });
  step("lock", "ann", "set", { id: "tbl", component: "lock", value: true });
  step("say", "ann", "say", { text: "hi" });
  step("move", "ann", "set", { id: "tbl", component: "transform", value: { pos: [1, 0, 3] }, through_lock: true });
  step("dup", "ann", "create", { from: "tbl" });
  const sky = step("sky", "ann", "set", { id: "@world", component: "sky", value: { hours: 3 } });
  step("del", "ann", "delete", { id: "tbl", through_lock: true });
  step("undo", "ann", "undo", {});
  step("publish", "ann", "publish", { from: "tbl", name: "table set" });
  ok(!bad, `K1 after each of ${steps} requests the client's v4 fold = the server's (digest), and what it draws = the projection`, bad);
  ok(verbs > 0 && sky.k.rehydrate && rehydrated === 1, "K2 a change with no v1 verb (the sky) is re-drawn locally, never a wrong delta; the rest went as verbs", { verbs, rehydrated });
  ok(c.ingest(JSON.parse(JSON.stringify(w.entries.slice(-1))), w.entries.length - 1, held).v1.length === 0, "K3 a re-delivered entry is ignored");
  call("ann", "set", { id: "cup", component: "label", value: "x" }); const from = w.entries.length; call("ann", "set", { id: "cup", component: "label", value: "y" });
  ok(c.ingest(JSON.parse(JSON.stringify(w.entries.slice(from))), from, held).resync, "K4 a gap (a missed entry) asks for a fresh snapshot, never folds past it");
  const c2 = makeV4Client(); c2.adopt(JSON.parse(JSON.stringify({ state: stateView(w.state()), head: w.entries.length - 1 })));
  now += 100; w.append({ kind: "purge", actor: "door", verb: "purge", body: { values: [{ seq: from + 1 }] } });
  ok(c2.ingest(JSON.parse(JSON.stringify(w.entries.slice(-1))), w.entries.length - 1, held).resync, "K5 a purge (retroactive, L1) asks for a fresh snapshot");
  // a drawing that drifted from the fold (here: the client drew the cup elsewhere) heals at the next write: the verbs are a
  // diff from what the client HOLDS to its fold, checked by folding them, and a re-draw when they can't say it
  { const c3 = makeV4Client(); c3.adopt(JSON.parse(JSON.stringify({ state: stateView(w.state()), head: w.entries.length - 1 })));
    const drifted = c3.legacy({ recentChat: [], chatTotal: 0 }); drifted.entities.cup.pos = [9, 9, 9]; if (drifted.entities.cup.parent) drifted.entities.cup.parent.offset = [9, 9, 9];
    const f3 = w.entries.length; call("ann", "set", { id: "cup", component: "light", value: { range: 2 } });
    const k3 = c3.ingest(JSON.parse(JSON.stringify(w.entries.slice(f3))), f3, drifted);
    const healed = k3.rehydrate ? c3.legacy(drifted) : foldLegacy(drifted, k3.v1);
    ok(!legacyDiff(healed, legacyState(w.state())), "K7 a drawing that drifted from the fold is healed at the next write (a diff from what it holds, checked)", legacyDiff(healed, legacyState(w.state()))); }
  const sv = stateFromView(JSON.parse(JSON.stringify(stateView(w.state()))));
  ok(digest(sv) === digest(w.state()) && sv.entities.cup.c.label === PURGED, "K6 stateView survives the wire both ways, a purged value still purged (not a value)", sv.entities.cup?.c); }

// ---- C: an off-centre catalogue box and measured surfaces ----
{ const cat = { get: (n) => ({ "lib/desk.glb": { label: "desk", box: [[-0.5, -0.4, -0.3], [0.7, 0.35, 0.5]], size: [1.2, 0.75, 0.8], surfaces: [{ y: 0.35, x: [-0.4, 0.6], z: [-0.2, 0.4] }] },
      "lib/cup.glb": { label: "cup", box: [[-0.05, 0, -0.05], [0.05, 0.1, 0.05]], size: [0.1, 0.1, 0.1], surfaces: [] }, "lib/ghost.glb": { label: "ghost", surfaces: [] } } as any)[n], list: () => [] };
  let now = T + 5000; const w = openLive(root + "cat/", "cat", { now: () => now, catalogue: cat });
  const call = (actor, tool, args = {}) => { now += 100; return request(w, actor, tool, args); };
  call("ann", "new", { title: "cat" });
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
  ok(code(request(openWorld(root, "c8"), "ann", "new", {})) === undefined && code(request(openWorld(root, "c8"), "ann", "create", { id: "q", model: "constructor" })) === "shape", "C8 the lab catalogue no longer answers prototype names (model 'constructor')");
  ok(LAB_CATALOGUE.get("toString") === undefined, "C9 LAB_CATALOGUE.get('toString') is undefined");
  // C10-C12: a target is aimed at by its BODY, not its origin (agent lab 10-04: Wren's chair faced air, Juniper's swing
  // hung from a corner). "far" is a desk whose origin sits 2.5 m off its body: its box spans x 2..3.2 in its own frame.
  const cat2 = { get: (n) => ({ "lib/far.glb": { label: "far desk", box: [[2, 0, -0.4], [3.2, 0.75, 0.4]], size: [1.2, 0.75, 0.8], surfaces: [] },
      "lib/chair.glb": { label: "chair", box: [[-0.25, 0, -0.25], [0.25, 0.9, 0.25]], size: [0.5, 0.9, 0.5], surfaces: [] },
      "lib/gate.glb": { label: "frame", box: [[4, 0, -0.1], [6, 2.2, 0.1]], size: [2, 2.2, 0.2], solids: [[[4, 0, -0.1], [4.1, 2.2, 0.1]], [[5.9, 0, -0.1], [6, 2.2, 0.1]], [[4, 2.1, -0.1], [6, 2.2, 0.1]]], surfaces: [] },
      "lib/seat.glb": { label: "seat", box: [[-0.3, 0, -0.15], [0.3, 0.05, 0.15]], size: [0.6, 0.05, 0.3], surfaces: [] } } as any)[n], list: () => [] };
  let now2 = T + 9000; const w2 = openLive(root + "cat2/", "cat2", { now: () => now2, catalogue: cat2 });
  const c2 = (actor, tool, args = {}) => { now2 += 100; return request(w2, actor, tool, args); };
  c2("ann", "new", { title: "cat2" });
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

// ---- X: the compatibility projection reproduces itself through the client's fold ----
{ let now = T + 9000; const w = openLive(root + "proj/", "proj", { now: () => now });
  const call = (actor, tool, args = {}) => { now += 100; return request(w, actor, tool, args); };
  let held = legacyState(w.state()); let resyncs = 0, steps = 0;
  const step = (what, actor, tool, args) => { const r = call(actor, tool, args); const next = legacyState(w.state()); const d = legacyDelta(held, next);
    const after = d && foldLegacy(held, d.map((v, k) => ({ seq: 1e6 + steps * 1000 + k, ts: now, actor: "a", ...v }))); steps++;
    if (!d || legacyDiff(after, next)) { resyncs++; held = next; return { r, resync: true, why: d ? legacyDiff(after, next) : "no verbs" }; } held = after; return { r, resync: false, d }; };
  step("found", "ann", "new", { title: "proj" });
  const s1 = step("create", "ann", "create", { id: "tbl", model: "table", place: { at: [0, 3] } });
  ok(!s1.resync && s1.d.some((v) => v.verb === "spawn"), "X1 a create is a spawn", s1);
  const s2 = step("on", "ann", "create", { id: "cup", model: "crate", place: { on: "tbl" } });
  ok(!s2.resync && s2.d.some((v) => v.verb === "mount"), "X2 a thing put ON another is a spawn + mount (its offset is the door's local transform)", s2);
  const s3 = step("lock", "ann", "set", { id: "tbl", component: "lock", value: true });
  ok(!s3.resync && s3.d.some((v) => v.verb === "comp" && v.args.type === "lock" && v.args.data === true), "X3 `lock` is the client's edit-mode lock, unchanged (the identity)", s3);
  const s4 = step("move", "ann", "set", { id: "tbl", component: "transform", value: { pos: [1, 0, 3] } });
  ok(s4.r.refused?.code === "locked", "X4 (the lock holds)");
  const s5 = step("role", "ann", "set", { id: "@world", component: `roles:${enc("Bob")}`, value: { role: "builder" } });
  ok(!s5.resync && s5.d.some((v) => v.verb === "grant"), "X5 a role is a grant", s5);
  const s6 = step("del", "ann", "delete", { id: "tbl", component: "lock" }); step("del2", "ann", "delete", { id: "tbl" });
  ok(!held.entities.tbl && !held.entities.cup, "X6 deleting the table takes the crate with it (the door deletes children)", Object.keys(held.entities));
  const s7 = step("undo", "ann", "undo", {});
  ok(s7.r.ok && held.entities.tbl, "X7 undo brings it back", s7.r);
  ok(resyncs === 0, "X8 no step needed a resync", resyncs);
  const s8 = step("about", "ann", "set", { id: "@world", component: "sky", value: { hours: 3 } });
  ok(s8.resync, "X9 a change with no v1 verb (the sky) is a resync, never a wrong delta", s8); }

// ---- S3: a stretched v4 thing in the projection (R 10-04 three-axis scale; Wren's agent-lab `look` failure) ----
{ const { legacyEntity } = await import("../../shared/v4/legacy.js");
  const { foldEntry, emptyState } = await import("../../shared/fold.js");
  const { effectiveWorldTransform } = await import("../../mcpl/effective.ts");
  const rec = legacyEntity("bench", { model: "x.glb", transform: { pos: [1, 0, 2], q: [0, 0, 0, 1], scale: [2, 0.4, 0.4] } });
  ok(typeof rec.scale === "number" && JSON.stringify(rec.scale3) === "[2,0.4,0.4]", "S3a a stretched thing projects `scale` as ONE number (every v1-era reader) and scale3 beside it", rec);
  ok(legacyEntity("box", { model: "x.glb", transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [3, 3, 3] } }).scale3 === undefined, "S3b a uniform one carries no scale3 (v1 worlds stay byte-identical)");
  const eff = effectiveWorldTransform("bench", { entity: (id: string) => (id === "bench" ? rec : undefined), mount: () => undefined } as any, 0);
  ok(eff.ok === true, "S3c the agent's pose reader (mcpl/effective) resolves it: no 'non-finite folded transform'", eff);
  const st = emptyState();
  foldEntry(st, { seq: 1, ts: 0, actor: "a", verb: "spawn", args: { id: "b", lib: "x.glb", pos: [0, 0, 0], scale: 0.4, scale3: [2, 0.4, 0.4] } });
  foldEntry(st, { seq: 2, ts: 0, actor: "a", verb: "place", args: { id: "b", pos: [0, 0, 0], scale: 1 } });
  ok(st.entities.b && st.entities.b.scale === 1 && st.entities.b.scale3 === undefined, "S3d the v1 fold carries scale3, and a plain scale makes it uniform again", st.entities.b);
  const { rawShapeError } = await import("../../mcpl/shape.ts");
  ok(rawShapeError("place", { id: "b", pos: [0, 0, 0], scale: [2, 0.4, 0.4] }) === null, "S3e the agent's raw place check takes a per-axis scale (Juniper: every rotate on a stretched thing was refused)");
  ok(rawShapeError("place", { id: "b", scale: [2, NaN, 1] }) !== null && rawShapeError("place", { id: "b", scale: "big" }) !== null, "S3f …and still refuses a broken one"); }

// ---- P: the pivot component (research 52: Roblox's PivotOffset; where it turns and scales from, never moves it) ----
{ const { editVerbs, inspectSchema, addVerbs } = await import("../../shared/editschema.js");
  const { componentsOf, entityOf } = await import("../../shared/components.js");
  const pw = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "pivots"), actor, tool, args); };
  pw("ann", "new", { title: "pivots" });
  pw("ann", "create", { id: "gate", model: "crate", components: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
  ok(pw("ann", "set", { id: "gate", component: "pivot", value: { pos: [0.3, 0, 0] } }).ok, "P1 the door takes a pivot {pos: [x,y,z]}");
  ok(code(pw("ann", "set", { id: "gate", component: "pivot", value: { pos: [1, 2] } })) === "shape" && code(pw("ann", "set", { id: "gate", component: "pivot", value: { pos: [0, 0, 0], q: [0, 0, 0, 1] } })) === "shape", "P2 …and refuses a bad one (two numbers; an extra field), saying the shape");
  const tr = openWorld(root, "pivots").state().entities.gate.c.transform;
  ok(JSON.stringify(tr.pos) === "[0,0,0]", "P3 setting a pivot never moved the thing", tr);
  const ent = { lib: "x.glb", pos: [0, 0, 0], comp: { pivot: { pos: [0.3, 0, 0] } } };
  const sortK = (v) => (Array.isArray(v) ? v.map(sortK) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortK(v[k])])) : v);
  ok(JSON.stringify(sortK(entityOf(componentsOf(ent)))) === JSON.stringify(sortK(ent)), "P4 pivot round-trips through the component view (componentsOf ∘ entityOf)", entityOf(componentsOf(ent)));
  const live = { box: [[2, 0, -0.4], [3.2, 0.75, 0.4]], doorLocks: true };
  const c1 = editVerbs(ent, "g", { "pivot.centre": true }, live).verbs[0]?.args?.data;
  ok(JSON.stringify(c1) === JSON.stringify({ pos: [2.6, 0.375, 0] }), "P5 'centre' snaps the pivot to the middle of the model's own box (an off-origin model)", c1);
  const c2 = editVerbs(ent, "g", { "pivot.base": true }, live).verbs[0]?.args?.data;
  ok(JSON.stringify(c2) === JSON.stringify({ pos: [2.6, 0, 0] }), "P6 'base' snaps it to the middle of the bottom face", c2);
  const c3 = editVerbs(ent, "g", { "pivot.reset": true }, live).verbs[0]?.args;
  ok(c3?.type === "pivot" && c3.data === null, "P7 'origin' removes it (turn about the origin again)", c3);
  const sc = inspectSchema(ent, "g", live);
  ok(sc.sections.list.some((c) => c.type === "Pivot" && c.fields.includes("pivot.x")), "P8 the Inspector draws a Pivot card with its channels");
  const a = addVerbs({ lib: "x.glb", pos: [0, 0, 0] }, "g", "Pivot");
  ok(a.verbs[0]?.args?.type === "pivot" && JSON.stringify(a.verbs[0].args.data) === '{"pos":[0,0,0]}', "P9 Add Component ▸ Pivot starts at the origin (then centre/base)", a);
  const bare = { lib: "x.glb", pos: [0, 0, 0] };
  const c4 = editVerbs(bare, "g", { "pivot.centre": true }, live);
  ok(!c4.errors.length && JSON.stringify(c4.verbs[0]?.args?.data) === JSON.stringify({ pos: [2.6, 0.375, 0] }), "P10 pivot.centre works on a thing with NO pivot yet (Hazel: needed a dummy pivot first)", c4);
  const c5 = editVerbs(bare, "g", { "pivot.y": 1.5 }, live);
  ok(!c5.errors.length && JSON.stringify(c5.verbs[0]?.args?.data) === JSON.stringify({ pos: [0, 1.5, 0] }), "P11 …as does pivot.y", c5);
  // the channel edits honour the pivot too (Maya's channel box; agent lab round 2, Rowan: 'edit rot.y +=90' swung the gate about its origin)
  const gate = { lib: "x.glb", pos: [10, 0, 10], yaw: 0, comp: { pivot: { pos: [1, 0, 0] } } };
  const placeOf = (r) => r.verbs.find((v) => v.verb === "place")?.args;
  const r1 = placeOf(editVerbs(gate, "g", { "rot.y": 90 }, live));
  ok(r1 && Math.abs(r1.pos[0] - 11) < 1e-6 && Math.abs(r1.pos[2] - 11) < 1e-6, "P12 rot.y = 90 on a pivoted thing turns it ABOUT the pivot: its origin goes to (11, 0, 11)", r1);
  const r2 = placeOf(editVerbs(gate, "g", { "pos.scale": 2 }, live));
  ok(r2 && Math.abs(r2.pos[0] - 9) < 1e-6 && Math.abs(r2.pos[2] - 10) < 1e-6, "P13 …and scale 2 grows it about the pivot (the pivot stays at 11): origin to (9, 0, 10)", r2);
  const r3 = placeOf(editVerbs(gate, "g", { "rot.y": 90, "pos.x": 5 }, live));
  ok(r3 && r3.pos[0] === 5 && r3.pos[2] === 10, "P14 …but a typed translate in the same edit wins (the pivot never second-guesses it)", r3);
  const r4 = placeOf(editVerbs({ lib: "x.glb", pos: [10, 0, 10], yaw: 0 }, "g", { "rot.y": 90 }, live));
  ok(r4 && r4.pos[0] === 10 && r4.pos[2] === 10, "P15 …and with no pivot, a turn stays about the origin, as before", r4); }

// ---- TN: turn {id, axis, deg, space, about} — the gizmo's rotate for agents (agent lab: Juniper #3) ----
{ const tw = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, "turns"), actor, tool, args); };
  const qm = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  const aa = (x, y, z, deg) => { const h = deg * Math.PI / 360; return [x * Math.sin(h), y * Math.sin(h), z * Math.sin(h), Math.cos(h)]; };
  const same = (a, b) => Math.abs(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) - 1) < 1e-6;
  const tq = (id) => openWorld(root, "turns").state().entities[id].c.transform;
  tw("ann", "new", { title: "turns" });
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
  uw("ann", "new", { title: "undoredo" });
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

console.log(`[door-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
