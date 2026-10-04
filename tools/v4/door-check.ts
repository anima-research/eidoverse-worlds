// tools/v4/door-check.ts — slice 2's in-process checks (the server-level ones over a real WebSocket are
// server-check.ts). usage: bun tools/v4/door-check.ts
//   N   names.js: one encoding for actors, ids and components; the lab's `0abc` / `n0abc` collision is gone
//   T   the engine translator's own name, and the v1 fold build it stamps
//   P   locks (PROTOCOL-v4 §5): v1's matrix (tools/locktest.ts), ancestors, through_lock, the gameplay lock inside
//       its own component
//   L   the live world (server/v4/live.ts) equals a whole-log re-read after every request: state, sim, the id index
//   C   the engine catalogue's shape (an off-centre GLB box, measured surfaces) places things where they rest
//   X   the compatibility projection: the v1 verbs it sends, folded by the client's own fold, reproduce it
// @ts-nocheck
import fs from "node:fs";
import { scratch } from "./common.ts";
import { request, creatorOf, LAB_CATALOGUE } from "../../shared/v4/door.js";
import { fold, readLog, digest } from "../../shared/v4/fold.js";
import { simFold, digestOf } from "../../shared/v4/simlayer.js";
import { MODELS } from "../../shared/v4/catalogue.js";
import { enc, encName, dec } from "../../shared/v4/names.js";
import { translate, TRANSLATOR } from "../../shared/v4/translate-v1.js";
import { legacyState, legacyDelta, foldLegacy, legacyDiff } from "../../shared/v4/legacy.js";
import { openWorld } from "../../server/v4/disk.ts";
import { openLive } from "../../server/v4/live.ts";
import { v1FoldBuild, v1FoldFiles } from "../../server/v4/build.ts";

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
}

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
  call("rowan", "wait", {}, 6000); same("after the rest");
  call("rowan", "set", { id: "table-1", component: "label", value: "first" }); call("rowan", "undo", {}); same("after an undo");
  const st = w.state(); const held = st.entities["table-1"]; call("rowan", "set", { id: "table-1", component: "label", value: "t" });
  ok(held === st.entities["table-1"] && !("label" in held.c), "L a state a caller holds never changes under it (copy on write)"); same("after a label"); }

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
  ok(LAB_CATALOGUE.get("toString") === undefined, "C9 LAB_CATALOGUE.get('toString') is undefined"); }

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

console.log(`[door-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
