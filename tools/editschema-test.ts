// editschema — the ONE declaration three surfaces read, proven pure.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/editschema-test.ts
//
// Binds: the schema is a function of the folded record (a lamp, a model, a
// mounted thing, a driven thing, unknown comps); channels() flattens every
// num with a dotted address; editOps turns dotted edits into the FEWEST
// door requests (three transform channels = one whole `set transform`; two
// socket fields = one merged `set sockets`), honours relative math on the face
// scale (degrees), hard limits, read-only fields, and never mutates the record
// it reads. Where the old test checked what an edit DOES (a pose, a lock), the
// ops go through the real door on a scratch world (tools/v4/scratchworld.ts)
// and the v4 state is read back as the view.
//
// v4 port (2026-10-06): light-verb lights (kind:'light') and guard/placer are gone from v4 — a lamp is a thing
// with a `light` component, guard merged into lock. A lock no longer makes the pose read-only in the schema: the
// door refuses the move (code `locked`), so that is now checked at the door.

import { inspectSchema, channels, editOps, describeSchema, fieldAt, parseEntry } from "../shared/editschema.js";
import { scratchWorld, flat } from "./v4/scratchworld.ts";
import { qHeading } from "../shared/rot.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;
// the door ops one edit planned: sets / deletes of one component
const sets = (r: any, comp: string) => flat(r.ops).filter((o: any) => o.verb === "set" && o.args.component === comp);
const dels = (r: any, comp: string) => flat(r.ops).filter((o: any) => o.verb === "delete" && o.args.component === comp);
const val = (r: any, comp: string) => sets(r, comp)[0]?.args.value;

const chair = { lib: "furniture/chair.glb", pos: [1, 0, 2], yaw: 1.5708, actor: "r", ts: 1,
  comp: { sockets: { seat: { pos: [0, 0.5, 0], body: {} }, side: { pos: [0.4, 0.5, 0], q: [0, 0.479425538604203, 0, 0.8775825618903728], body: {} } }, recipe: { wood: 2 }, lock: true } };   // side: heading 1 rad
// a lamp: a thing with a light component (v4 has no light-verb lights)
const lamp = { pos: [0, 2, 0], yaw: 0, actor: "r", ts: 1, comp: { light: { color: 0xff8800, intensity: 20, range: 6, important: true } } };
const swing = { lib: "swing.glb", pos: [5, 0, 5], yaw: 0, actor: "r", ts: 1, comp: { motion: { type: "pendulum", axis: [1, 0, 0], amp: 0.4, period: 3, t0: 123 }, "motion:plank": { type: "spin", rpm: 10 } } };
const cargo = { lib: "crate.glb", pos: [9, 9, 9], yaw: 0, actor: "r", ts: 1, parent: { to: "truck", offset: [0, 1, 0] } };

console.log("\nschema is a function of the record:");
{
  const s = inspectSchema(chair, "c1");
  const G = s.groups.map((g) => g.group);
  // step 3: the channel box's Rotate channels are their own group, `rot` (tools/channelbox-test.ts)
  check("a chair: pos · rot · parent · flags · sockets · comp", JSON.stringify(G) === '["pos","rot","parent","flags","sockets","comp"]', JSON.stringify(G));
  check("locked → transform stays editable and says moving it asks first (the door decides, §5)", fieldAt(s, "pos.x")!.disabled !== true && /locked — moving it asks first/.test(fieldAt(s, "pos.x")!.hint), JSON.stringify(fieldAt(s, "pos.x")));
  // 09-23: raw rows are `json` fields (multi-line, validated as you type), no longer single-line text
  check("unknown comp 'recipe' is a raw-JSON field; sockets/lock are NOT duplicated there", fieldAt(s, "comp.recipe")?.t === "json" && !fieldAt(s, "comp.sockets") && !fieldAt(s, "comp.lock"));
  check("sockets: a list + per-slot channels", fieldAt(s, "sockets.slots")?.t === "list" && Math.abs(fieldAt(s, "sockets.side|rot|1")?.value - 1) < 1e-6);
  const l = inspectSchema(lamp, "lamp");
  check("a lamp: a light group from the component's values", fieldAt(l, "light.intensity")?.value === 20 && fieldAt(l, "light.important")?.value === true && fieldAt(l, "light.range")?.value === 6);
  const w = inspectSchema(swing, "s");
  check("a driven thing: transform tinted, rest pose", fieldAt(w, "pos.x")!.driven === "motion" && fieldAt(w, "pos.x")!.value === 5);
  check("motion group covers the whole comp AND the part", fieldAt(w, "motion.amp")?.t === "num" && fieldAt(w, "motion.plank|degPerSec")?.value === 60);
  check("axis vector reads back as a name", fieldAt(w, "motion.axis")?.value === "x");
  const m = inspectSchema(cargo, "k");
  // step 4 (design §3): a child's transform is LOCAL to its parent and editable — the mount's offset, not the fold's pre-mount pos
  check("mounted → transform is local (the mount offset), editable, and says which parent", !fieldAt(m, "pos.x")!.disabled && fieldAt(m, "pos.y")!.value === 1 && fieldAt(m, "pos.x")!.value === 0
    && m.groups.find((g: any) => g.group === "pos")!.local === "truck" && fieldAt(m, "parent.to")!.value === "truck");
  check("null record → empty", inspectSchema(null, "zz").groups.length === 0);
  const ch = channels(w);
  check("channels(): every num, dotted", ch.length >= 8 && ch.every((c) => c.t === "num" && c.key.includes(".")) && ch.some((c) => c.key === "motion.period"));
}

console.log("\nedits → the fewest door ops:");
{
  const unlocked = { ...chair, comp: { ...chair.comp, lock: undefined } };
  const r = editOps(unlocked, "c1", { "pos.x": "+=1", "pos.z": 4, "pos.yaw": "45" });   // 45°: the chair faces 90° now, so the typed heading must land
  const p = sets(r, "transform");
  check("three transform edits = ONE whole set transform {pos, q, scale}", p.length === 1 && flat(r.ops).length === 1 && p[0].args.value.pos.length === 3 && p[0].args.value.q.length === 4 && p[0].args.value.scale.length === 3, JSON.stringify(r));
  check("…x relative, z absolute, yaw typed in degrees → a q whose heading is π/4", p[0] && p[0].args.value.pos[0] === 2 && p[0].args.value.pos[2] === 4 && near(qHeading(p[0].args.value.q), Math.PI / 4, 1e-4), JSON.stringify(p[0]?.args));
  check("…scale carried unchanged", JSON.stringify(p[0]?.args.value.scale) === "[1,1,1]");
  // the RESULT, through the door: the chair stands at (2, 0, 4) facing +45°
  const W = scratchWorld("editschema").seed({ c1: unlocked });
  const sent = W.send(r.ops[0]);
  const after = W.rec("c1");
  check("…through the door: the chair stands at (2,0,4), heading 45°", sent.ok && JSON.stringify(after.pos) === "[2,0,4]" && near(after.yaw, Math.PI / 4, 1e-3) && after.scale === 1, JSON.stringify([sent.refused, after]));
  // a lock: the planner lets the door ask (no doorLocks gate any more); the door refuses the move and nothing changes
  const rl = editOps(chair, "c1", { "pos.x": 3 });
  check("a locked thing still plans its move (one set transform, no planner error)", rl.errors.length === 0 && sets(rl, "transform").length === 1, JSON.stringify(rl));
  const WL = scratchWorld("editschema").seed({ c1: chair });
  const refused = WL.send(rl.ops[0]);
  check("…and the door refuses it `locked`; the chair hasn't moved", refused.ok === false && refused.refused?.code === "locked" && WL.rec("c1").pos[0] === 1, JSON.stringify(refused));
  const through = WL.send(rl.ops[0], { throughLock: true });
  check("…with throughLock (the person answered \"move anyway\") it moves, lock kept", through.ok && WL.rec("c1").pos[0] === 3 && WL.rec("c1").comp.lock === true, JSON.stringify(through.refused));
  const rs = editOps(chair, "c1", { "sockets.seat|pos|1": "+=0.1", "sockets.side|rot|1": "*=2" });
  const cs = sets(rs, "sockets");
  check("two socket edits = ONE merged set sockets keeping the other slot", cs.length === 1 && flat(rs.ops).length === 1 && near(cs[0].args.value.seat.pos[1], 0.6) && near(cs[0].args.value.side.q[1], Math.sin(1)) && near(cs[0].args.value.side.q[3], Math.cos(1)) && cs[0].args.value.side.pos[0] === 0.4, JSON.stringify(cs));
  const rd = editOps(chair, "c1", { "sockets.del": "seat" });
  check("del keeps the rest", val(rd, "sockets").seat === undefined && val(rd, "sockets").side);
  const rd2 = editOps({ ...chair, comp: { sockets: { seat: { pos: [0, 0.5, 0] } } } }, "c1", { "sockets.del": "seat" });
  check("deleting the last slot removes the comp (delete sockets)", dels(rd2, "sockets").length === 1 && sets(rd2, "sockets").length === 0, JSON.stringify(rd2));
  const rL = editOps(lamp, "lamp", { "light.intensity": "-=10%", "light.noon": true, "light.color": "#00ff00" });
  const lv = sets(rL, "light");
  check("light edits = ONE set light: intensity 18, day:false, color parsed, range and important kept", lv.length === 1 && flat(rL.ops).length === 1 && lv[0].args.value.intensity === 18 && lv[0].args.value.day === false && lv[0].args.value.color === 0x00ff00 && lv[0].args.value.range === 6 && lv[0].args.value.important === true, JSON.stringify(lv));
  const rM = editOps(swing, "s", { "motion.amp": "+=10", "motion.plank|degPerSec": 90 });
  const mv = sets(rM, "motion"), cv = sets(rM, "motion:plank");
  check("whole motion → set motion keeping t0; part → set motion:plank; rpm retired", mv.length === 1 && mv[0].args.value.t0 === 123 && near(mv[0].args.value.amp, 0.4 + 10 / 180 * Math.PI, 1e-4) && cv.length === 1 && cv[0].args.value.degPerSec === 90 && cv[0].args.value.rpm === undefined, JSON.stringify(rM));
  const rR = editOps(swing, "s", { "motion.rest": 1 });
  check("rest → delete motion", dels(rR, "motion").length === 1 && flat(rR.ops).length === 1, JSON.stringify(rR));
  const rF = editOps(swing, "s", { "flags.label": "  the swing ", "flags.hidden": "yes", "comp.+": "notice", "comp.nope": "{bad json" });
  check("label trimmed, hidden as comp true, + adds an empty comp, bad JSON reported", val(rF, "label") === "the swing" && val(rF, "hidden") === true && JSON.stringify(val(rF, "notice")) === "{}" && rF.errors.some((e: string) => /comp\.nope/.test(e)), JSON.stringify(rF));
  check("hard min clamps (scale 0.01)", JSON.stringify(val(editOps({ ...chair, comp: {} }, "c1", { "pos.scale": -3 }), "transform")?.scale) === "[0.01,0.01,0.01]");
  check("an unknown field is an error, not an op", (() => { const x = editOps(chair, "c1", { "light.intensity": 3 }); return x.errors.length === 1 && !x.ops.length; })());
  check("a viewport gesture (sockets.add) is refused with guidance", /gesture/.test(editOps(chair, "c1", { "sockets.add": 1 }).errors[0] ?? ""));
  const before = JSON.stringify(chair);
  editOps(chair, "c1", { "sockets.seat|pos|0": 9, "flags.lock": false, "comp.recipe": "{\"wood\":3}" });
  check("editOps never mutates the record", JSON.stringify(chair) === before);
}

console.log("\nref field (look-at.target): a pick names another entity as a value (batch 2: the wire name is look-at):");
{
  const looker = { pos: [0, 0, 0], yaw: 0, scale: 1, comp: { "look-at": { target: "lamp3" } } };
  const sl = inspectSchema(looker, "w1");
  check("a look-at comp declares a ref field carrying its target id", fieldAt(sl, "look-at.target")?.t === "ref" && fieldAt(sl, "look-at.target")?.value === "lamp3", JSON.stringify(fieldAt(sl, "look-at.target")));
  const viewer = inspectSchema({ pos: [0, 0, 0], yaw: 0, scale: 1, comp: { "look-at": { target: "@viewer" } } }, "w2");
  check("a look-at at the viewer → the ref is empty and the chip says the viewer", fieldAt(viewer, "look-at.target")?.value === null && fieldAt(viewer, "look-at.target@")?.value === "@viewer", JSON.stringify(fieldAt(viewer, "look-at.target@")));
  check("no look-at comp → no ref field", !fieldAt(inspectSchema({ pos: [0,0,0], yaw: 0, scale: 1, comp: {} }, "w3"), "look-at.target"));
  const rset = editOps({ pos: [0,0,0], yaw: 0, scale: 1, comp: { "look-at": { target: "@viewer" } } }, "w2", { "look-at.target": "lamp3" });
  const lv = sets(rset, "look-at");
  check("picking a target = ONE set look-at carrying the target", lv.length === 1 && flat(rset.ops).length === 1 && lv[0].args.value.target === "lamp3", JSON.stringify(rset));
  const rclr = editOps({ pos: [0,0,0], yaw: 0, scale: 1, comp: { "look-at": { target: "lamp3" } } }, "w1", { "look-at.target": null });
  check("clearing the target removes the look-at comp", dels(rclr, "look-at").length === 1, JSON.stringify(rclr));
}
console.log("\nthe survivors of the mutation sweep, bound:");
{
  const before = JSON.stringify(swing);
  const r = editOps(swing, "s", { "pos.x": "+=1", "motion.amp": "+=5", "motion.plank|degPerSec": 1 });
  check("editing pos and motion never mutates the record (pos array, motion bags)", JSON.stringify(swing) === before && val(r, "transform").pos[0] === 6);
  const unlocked = { ...chair, comp: { ...chair.comp, lock: undefined } };
  check("comp.<type> = '' REMOVES the component", dels(editOps(unlocked, "c1", { "comp.recipe": "" }), "recipe").length === 1);
  check("flags.lock false → delete lock; 'no'/'off'/'false' strings read as false", dels(editOps(chair, "c1", { "flags.lock": false }), "lock").length === 1
    && (() => { const h = { ...unlocked, comp: { ...unlocked.comp, hidden: true, lock: true } };
      return dels(editOps(h, "c1", { "flags.hidden": "no" }), "hidden").length === 1 && dels(editOps(h, "c1", { "flags.lock": "off" }), "lock").length === 1 && dels(editOps(h, "c1", { "flags.hidden": "false" }), "hidden").length === 1; })());
  check("…and clearing a flag that isn't set sends nothing (no delete of an absent component)", editOps(unlocked, "c1", { "flags.hidden": "no" }).ops.length === 0);
  check("comp.+ of a type already there is refused; comp.+ '' is ignored", /already has/.test(editOps(unlocked, "c1", { "comp.+": "recipe" }).errors[0] ?? "") && editOps(unlocked, "c1", { "comp.+": "" }).ops.length === 0);
  check("sockets.del of a missing slot is an error, nothing sent", editOps(unlocked, "c1", { "sockets.del": "nope" }).ops.length === 0 && /no slot/.test(editOps(unlocked, "c1", { "sockets.del": "nope" }).errors[0] ?? ""));
  const ns = val(editOps(unlocked, "c1", { "sockets.back|pos|1": 0.7 }), "sockets");
  check("a new slot name declares a seat (pos default [0,0.5,0], no rotation, body) and keeps the others", ns.back.pos[1] === 0.7 && ns.back.pos[0] === 0 && ns.back.q === undefined && ns.back.yaw === undefined && !!ns.back.body && !!ns.seat && !!ns.side, JSON.stringify(ns));
  const ch = channels(inspectSchema(swing, "s"));
  check("channels() carries the group and lists pos before motion", ch[0].group === "pos" && ch.findIndex((c) => c.group === "motion") > ch.findIndex((c) => c.group === "pos"));
  check("a label longer than 80 chars is cut", val(editOps(unlocked, "c1", { "flags.label": "x".repeat(100) }), "label").length === 80);
  const fire = { ...chair, comp: { particles: { preset: "fire", count: 150, origin: [0, 0.25, 0] } } };
  const pr = editOps(fire, "c1", { "particles.origin|1": "+=0.5", "particles.count": 900, "particles.quality": "low" });
  const pv = sets(pr, "particles");
  check("particles: origin cloned+edited, count hard-capped at 600, quality passes through — ONE set", pv.length === 1 && flat(pr.ops).length === 1 && pv[0].args.value.origin[1] === 0.75 && fire.comp.particles.origin[1] === 0.25 && pv[0].args.value.count === 600 && pv[0].args.value.quality === "low", JSON.stringify(pv));
  check("particles.out removes it", dels(editOps(fire, "c1", { "particles.out": 1 }), "particles").length === 1);
  const tc = val(editOps(swing, "s", { "motion.type": "spin" }), "motion");
  check("a motion type change keeps t0/axis, DROPS the old type's params, refuses an unknown type", tc.type === "spin" && tc.t0 === 123 && tc.axis && tc.amp === undefined && tc.period === undefined && /type must be/.test(editOps(swing, "s", { "motion.type": "wobble" }).errors[0] ?? ""), JSON.stringify(tc));
  const dm = describeSchema(inspectSchema(swing, "s"));
  check("describeSchema: degrees, enum options, the driven suffix, action lines", /motion\.amp = 23°/.test(dm) && /motion\.type = pendulum  \[pendulum\|spin/.test(dm) && /rest pose — driven by motion/.test(dm) && /motion\.rest: action/.test(dm), dm.split("\n").filter((l) => /motion\.(amp|type|rest)|pos\.x/.test(l)).join(" || "));
}

console.log("\ndescribeSchema reads like an inspector:");
{
  const t = describeSchema(inspectSchema(lamp, "lamp"));
  check("names dotted addresses with values and units", /light\.intensity = 20/.test(t) && /light\.range = 6 m/.test(t) && /pos\.y = 2 m/.test(t));
  check("says how to edit", /edit \{id, set:/.test(t));
  check("names what each group writes in v4 terms (set <component>), not a v1 verb", /light \(light\.\* → set light\)/.test(t) && /\(pos\.\* → set transform\)/.test(t) && !/→ (place|mount|comp|light)\)/.test(t), t.split("\n").filter((l) => /→/.test(l)).join(" || "));
  const t2 = describeSchema(inspectSchema(cargo, "k"));
  check("a child says its frame and its parent", /frame: local to its parent, truck/.test(t2) && /parent\.to = truck/.test(t2));
  // a read-only field in v4: a rider on a carrier's MOVING PART socket (its pose is baked at the part's phase)
  const world = { truck: { lib: "truck.glb", pos: [0, 0, 0], yaw: 0, comp: { sockets: { bed: { pos: [0, 1, 0], yaw: 0, part: "arm" } } } },
    k: { ...cargo, parent: { to: "truck", socket: "bed" } } };
  const t3 = describeSchema(inspectSchema(world.k, "k", { world }));
  check("read-only fields say why (a part-socket rider)", /read-only: rides truck's moving part arm/.test(t3), t3.split("\n").filter((l) => /pos\.x/.test(l)).join(" || "));
  const t4 = describeSchema(inspectSchema({ ...cargo, comp: { lock: true } }, "k"));
  check("a locked thing is NOT read-only in the description (the door asks; v4 §5)", !/read-only/.test(t4) && /pos\.x = 0/.test(t4), t4.split("\n").filter((l) => /pos\.x/.test(l)).join(" || "));
  check("parseEntry passes numbers and refuses garbage", parseEntry(4, 0) === 4 && parseEntry("x", 0) === null);
}

console.log("\nguard is merged into lock (PROTOCOL-v4 §5): an old habit is taught, never silently turned into a lock:");
{
  const g = editOps({ pos: [0, 0, 0], comp: {} }, "crate", { "flags.guard": true });
  check("flags.guard is refused, naming flags.lock; nothing sent", g.ops.length === 0 && /merged into `lock`/.test(g.errors[0] ?? "") && /flags\.lock/.test(g.errors[0] ?? ""), JSON.stringify(g));
  check("the schema has no guard field (Flags: lock, hidden, label)", !fieldAt(inspectSchema({ pos: [0, 0, 0], comp: { guard: true } }, "old"), "flags.guard"));
  check("flags.lock → set lock true / delete lock", JSON.stringify(editOps({ pos: [0, 0, 0], comp: {} }, "crate", { "flags.lock": true }).ops) === JSON.stringify([{ verb: "set", args: { id: "crate", component: "lock", value: true } }])
    && dels(editOps({ pos: [0, 0, 0], comp: { lock: true } }, "crate", { "flags.lock": false }), "lock").length === 1);
}

console.log("\npicture + sound: schema groups, validated before any op:");
{
  const PNG = "store/images/abc.png", MP3 = "store/audio/abc.mp3";
  const crate = { pos: [0, 0, 0], lib: "crate", comp: {} };
  const parts = ["screenplane", "frame"];
  const sch = inspectSchema(crate, "c", { parts });
  const addBtns = sch.groups.find((g: any) => g.group === "comp").fields.filter((f: any) => f.t === "btn").map((f: any) => f.k);
  check("no picture/sound yet: Components offers + picture… and + sound… (client gestures)", addBtns.includes("add:picture") && addBtns.includes("add:sound"), JSON.stringify(addBtns));
  check("…and on a thing with no parts list too (batch 2: a picture of its own needs no part)", ["add:picture", "add:sound"].every((k) => inspectSchema(crate, "c").groups.find((g: any) => g.group === "comp").fields.some((f: any) => f.k === k)));
  check("…and + seat… too (the first seat in one step)", addBtns.includes("add:seat"));
  check("…but not once it has sockets", !inspectSchema({ ...crate, comp: { sockets: { seat: { pos: [0, 0.5, 0] } } } }, "c", { parts }).groups.find((g: any) => g.group === "comp").fields.some((f: any) => f.k === "add:seat"));
  const gesture = editOps(crate, "c", { "comp.add:picture": true }, { parts });
  check("the add button is a gesture: editOps refuses it, sends nothing", !gesture.ops.length && /gesture/.test(gesture.errors[0] ?? ""), JSON.stringify(gesture));
  const hang = editOps(crate, "c", { "picture.src": PNG }, { parts });
  check("setting src on a fresh thing hangs a picture of its own (batch 2: no part = a quad), normalized", val(hang, "picture")?.part === undefined && val(hang, "picture").src === PNG && val(hang, "picture").lit === "scene" && val(hang, "picture").width === 1, JSON.stringify(hang));
  const url = editOps(crate, "c", { "picture.src": "http://evil.example.org/x.png" }, { parts });
  check("an http link is refused with the rule, and nothing is sent", !url.ops.length && /https/.test(url.errors[0] ?? ""), JSON.stringify(url.errors));
  check("an https link is taken (who sees it is each viewer's: shared/mediasrc.js)", val(editOps(crate, "c", { "picture.src": "https://i.imgur.com/x.png" }, { parts }), "picture")?.src === "https://i.imgur.com/x.png");
  const model = editOps(crate, "c", { "picture.src": PNG, "picture.part": "frame", "picture.alt": "a red square" });
  check("a model with no parts list creates one by setting src + part together (validated once, at the end)", val(model, "picture")?.part === "frame" && val(model, "picture").alt === "a red square", JSON.stringify(model));
  const hung = { ...crate, comp: { picture: { src: PNG, part: "screenplane", lit: "scene", flip: false } } };
  const g = inspectSchema(hung, "c", { parts }).groups.find((x: any) => x.group === "picture");
  check("a hung picture: where is a dropdown of its own + the model's parts", fieldAt({ groups: [g] }, "picture.part")?.t === "enum" && fieldAt({ groups: [g] }, "picture.part")?.options.length === 3);
  check("…and the normalizer's advice shows (no alt text)", g.fields.some((f: any) => f.t === "info" && /no alt text/.test(f.value)));
  check("…and picture is claimed (no raw-JSON row)", !fieldAt(inspectSchema(hung, "c", { parts }), "comp.picture"));
  const lit = editOps(hung, "c", { "picture.lit": "self" }, { parts });
  check("changing lit keeps src and part", val(lit, "picture")?.lit === "self" && val(lit, "picture").src === PNG && val(lit, "picture").part === "screenplane", JSON.stringify(lit));
  check("take down → delete picture", dels(editOps(hung, "c", { "picture.down": true }), "picture").length === 1);

  const snd = editOps(crate, "c", { "sound.src": MP3 }, { parts, now: 1000 });
  check("setting a file on a fresh thing makes a sound that plays (R 10-07: no start-paused; the door stamps t0)", val(snd, "sound")?.playing === true && val(snd, "sound").t0 === undefined && val(snd, "sound").src === MP3, JSON.stringify(snd));
  const paused = { ...crate, comp: { sound: { src: MP3, playing: false, loop: true, volume: 0.8, radius: 12 } } };
  const play = editOps(paused, "c", { "sound.play": true }, { now: 5000 });
  check("play sends no t0: the door stamps it on its clock, so everyone seeks together", val(play, "sound")?.playing === true && val(play, "sound").t0 === undefined, JSON.stringify(play));
  const playing = { ...crate, comp: { sound: { src: MP3, playing: true, loop: true, volume: 0.8, radius: 12, t0: 5000 } } };
  const vol = editOps(playing, "c", { "sound.volume": "*=0.5" }, { now: 9000 });
  check("tuning a PLAYING sound keeps its t0 (nobody's playhead jumps)", val(vol, "sound")?.t0 === 5000 && val(vol, "sound").volume === 0.4, JSON.stringify(vol));
  check("volume clamps to 1", val(editOps(playing, "c", { "sound.volume": 3 }), "sound")?.volume === 1);
  const pause = val(editOps(playing, "c", { "sound.pause": true }), "sound");
  check("pause keeps t0 (batch 2: a resume restarts on the door's clock)", pause?.playing === false && pause.t0 === 5000);
  check("silence → delete sound", dels(editOps(playing, "c", { "sound.silence": true }), "sound").length === 1);
  const sg = inspectSchema(playing, "c").groups.find((x: any) => x.group === "sound");
  check("a playing sound offers pause + restart, not play", sg.fields.some((f: any) => f.k === "pause") && sg.fields.find((f: any) => f.k === "play")?.label === "restart");
}

console.log("\nthe JSON escape hatch: every typed group, addressed to its comp, and never a way around the rules:");
{
  const ent = { pos: [0, 0, 0], comp: { sockets: { seat: { pos: [0, 0.5, 0], yaw: 0, part: "plank" } }, particles: { preset: "fire", seed: 7 }, "motion:arm": { type: "spin" } } };
  const sch = inspectSchema(ent, "x");
  const hatch = (g: string) => sch.groups.find((x: any) => x.group === g)?.fields.find((f: any) => f.t === "json");
  check("sockets carries a collapsed JSON hatch that commits comp.sockets", hatch("sockets")?.collapsed === true && hatch("sockets")?.commit === "comp.sockets" && /"part": "plank"/.test(hatch("sockets")?.value ?? ""));
  check("particles too (its seed has no field)", hatch("particles")?.commit === "comp.particles" && /"seed": 7/.test(hatch("particles")?.value ?? ""));
  check("a motion:<part> key gets its own hatch", hatch("motion")?.commit === "comp.motion:arm");
  check("a model's description doesn't dump the hatches (comp.<type> is the address)", !/\{ \"seat\"/.test(describeSchema(sch)));
  const part = editOps(ent, "x", { "comp.sockets": JSON.stringify({ seat: { pos: [0, 0.5, 0], yaw: 0, part: "seatboard" } }) });
  check("editing through the hatch replaces the comp wholesale", val(part, "sockets")?.seat?.part === "seatboard", JSON.stringify(part));
  const url = editOps(ent, "x", { "comp.picture": JSON.stringify({ src: "http://x.example.org/a.png", part: "screen" }) });
  check("comp.picture as JSON still runs normalizePicture: an http link is refused, nothing sent", !url.ops.length && /https/.test(url.errors[0] ?? ""), JSON.stringify(url));
  const bad = editOps(ent, "x", { "comp.recipe": "{ nope" });
  check("invalid JSON is an error, not an op", !bad.ops.length && /not valid JSON/.test(bad.errors[0] ?? ""));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
