// tools/v4/door-check.ts — slice 2's in-process checks (the server-level ones over a real WebSocket are
// server-check.ts). usage: bun tools/v4/door-check.ts
//   N   names.js: one encoding for actors, ids and components; the lab's `0abc` / `n0abc` collision is gone
//   T   the engine translator's own name, and the v1 fold build it stamps
//   P   ancestor pins, directly (research 35 #4: before this, one case in gaps went red when the rule was dropped)
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

// ---- P: ancestor pins ----
{ const name = "pins";
  const call = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T); return request(openWorld(root, name), actor, tool, args); };
  call("olive", "new", { title: "pins" });
  call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  call("olive", "create", { id: "tbl", model: "table", place: { at: [0, 3] } });
  ok(call("bob", "create", { id: "cup", model: "crate", place: { on: "tbl" } }).ok, "P0 a crate on the table");
  ok(call("bob", "create", { id: "bell", model: "ball", place: { on: "cup" } }).ok, "P0 a ball on the crate (two levels down)");
  const w0 = openWorld(root, name).state(); ok(w0.entities.cup.c.parent?.to === "tbl" && w0.entities.bell.c.parent?.to === "cup", "P0 the chain is tbl ← cup ← bell", [w0.entities.cup.c.parent, w0.entities.bell.c.parent]);
  ok(call("olive", "set", { id: "tbl", component: "pinned", value: true }).ok, "P1 olive pins the table");
  ok(code(call("bob", "set", { id: "cup", component: "transform", value: { pos: [0.1, 0.75, 0] } })) === "pinned", "P2 bob can't move the crate ON the pinned table");
  ok(code(call("bob", "delete", { id: "cup" })) === "pinned", "P3 …nor delete it");
  ok(code(call("bob", "place", { id: "cup", at: [4, 4] })) === "pinned", "P4 …nor place it elsewhere");
  ok(code(call("bob", "delete", { id: "cup", component: "parent" })) === "pinned", "P5 …nor lift it off (deleting its parent)");
  ok(code(call("bob", "set", { id: "bell", component: "transform", value: { pos: [0, 0.6, 0] } })) === "pinned", "P6 a grandchild is bound too (the pin is two levels up)");
  ok(code(call("bob", "delete", { id: "tbl" })) === "pinned", "P7 the pinned thing itself can't be deleted");
  ok(call("bob", "set", { id: "cup", component: "label", value: "a crate" }).ok, "P8 a pin guards transform/parent/model/motion/physics, not a label");
  { const r9 = call("bob", "create", { id: "cup2", model: "ball", place: { on: "tbl" } }); ok(r9.ok, "P9 a NEW thing may be put on a pinned table (a pin guards what is attached, not the surface)", r9); }
  ok(call("bob", "delete", { id: "tbl", component: "pinned" }).ok, "P10 anyone with build rights may unpin");
  ok(call("bob", "set", { id: "cup", component: "transform", value: { pos: [0.1, 0.75, 0] } }).ok, "P11 …and then the crate moves");
  call("olive", "set", { id: "cup", component: "pinned", value: true });
  ok(code(call("bob", "set", { id: "bell", component: "transform", value: { pos: [0, 0.6, 0] } })) === "pinned" && call("bob", "set", { id: "tbl", component: "transform", value: { pos: [0, 0, 3.2] } }).ok,
    "P12 a pin binds what's below it, never what it stands on"); }

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
  const s3 = step("pin", "ann", "set", { id: "tbl", component: "pinned", value: true });
  ok(!s3.resync && s3.d.some((v) => v.verb === "comp" && v.args.type === "lock"), "X3 pinned shows as the edit-mode lock", s3);
  const s4 = step("move", "ann", "set", { id: "tbl", component: "transform", value: { pos: [1, 0, 3] } });
  ok(s4.r.refused?.code === "pinned" , "X4 (the pin holds)");
  const s5 = step("role", "ann", "set", { id: "@world", component: `roles:${enc("Bob")}`, value: { role: "builder" } });
  ok(!s5.resync && s5.d.some((v) => v.verb === "grant"), "X5 a role is a grant", s5);
  const s6 = step("del", "ann", "delete", { id: "tbl", component: "pinned" }); step("del2", "ann", "delete", { id: "tbl" });
  ok(!held.entities.tbl && !held.entities.cup, "X6 deleting the table takes the crate with it (the door deletes children)", Object.keys(held.entities));
  const s7 = step("undo", "ann", "undo", {});
  ok(s7.r.ok && held.entities.tbl, "X7 undo brings it back", s7.r);
  ok(resyncs === 0, "X8 no step needed a resync", resyncs);
  const s8 = step("about", "ann", "set", { id: "@world", component: "sky", value: { hours: 3 } });
  ok(s8.resync, "X9 a change with no v1 verb (the sky) is a resync, never a wrong delta", s8); }

console.log(`[door-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
