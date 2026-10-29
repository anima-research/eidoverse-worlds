// tools/protocol/shiplist-check.ts — the ship list's group A (audit 10-07, AUDIT-shiplist-blockers-2026-10-07.md), through the
// real door, the real importer, the shared evaluators and the editor's own planners:
//   bun tools/protocol/shiplist-check.ts                 every case
//   bun tools/protocol/shiplist-check.ts --only O3,R2    just those
//   bun tools/protocol/shiplist-check.ts --tree <dir>    the cases against another checkout (a mutant, the base)
//   bun tools/protocol/shiplist-check.ts --control       the base (staging 7f1f1934): every case must be red there except the
//                                                  KEEP cases (today's behaviour, kept), which must be green
//   bun tools/protocol/shiplist-check.ts --mutants       remove each gate in turn (a copy of the tree): its cases must go red;
//                                                  a no-op control mutation must stay green
// Cases:
//   O   openable (R 10-07: the behaviour, not the asset; it was `door`): the authority's shape and ranges, toggle's default,
//       what look says, the importer's rename, the pose and the tween every client draws, the editor's card and Add
//   R   reactions: Add Component offers only what the authority takes; handlers are checked when WRITTEN (a value the authority
//       would refuse, a field in a component the thing hasn't got, a toggle of a number, a push on a spinner); a use
//       whose component was removed since says so and writes nothing
//   M   motion: the authority takes spin/orbit/path's conventional fields; the evaluator honours an orbit's period; the
//       importer translates rpm and keeps center/face/period/points instead of parking them in imported:motion
//   H   help text: physics.who and grabbable.who default to visitor (3b3ad8e2), and every place an agent reads says so
//   P   people: a refusal in a person's words (no code, no tool syntax, things by label); warnings by label
// @ts-nocheck
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch, copyTree } from "./common.ts";
import { recordComponents } from "../../shared/protocol/view.js";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = "7f1f1934";
// cases that hold at the base too (today's behaviour, kept): the control requires them GREEN there
const KEEP = new Set(["R7", "O0"]);

// ---------------- the mutation and control drivers (they re-run this file as child processes) ----------------
const MUTANTS: [string, string, string, string, string[]][] = [
  ["a named openable toggles open", "shared/protocol/authority/use.js", "field: h.field ?? (comp === \"openable\" ? \"open\" : undefined)", "field: h.field ?? (h.component === undefined ? \"open\" : undefined)", ["R3b"]],
  ["toggle's default is openable", "shared/protocol/authority/use.js", "const comp = h.component ?? \"openable\";", "const comp = h.component ?? \"door\";", ["O3", "R3"]],
  ["openable: angle or slide", "shared/protocol/authority/checks.js", "if (v.angle !== undefined && v.slide !== undefined) refuse(", "if (false) refuse(", ["O2"]],
  ["openable: slide bounds", "shared/protocol/authority/checks.js", "if (v.slide !== undefined && !nums(v.slide, 3, 10)) refuse(", "if (false) refuse(", ["O2"]],
  ["openable: the catalogue's ranges", "shared/protocol/componentspec.js", "ranges: { angle: { min: -Math.PI, max: Math.PI }, time: { min: 0, max: 10 } },", "", ["O2"]],
  ["`door` is called openable", "shared/protocol/authority/checks.js", "if (name === \"door\") refuse(", "if (false) refuse(", ["O1"]],
  ["look shows the openable", "shared/protocol/authority.js", "...(e.c.openable && typeof e.c.openable === \"object\" ? { openable: e.c.openable } : {}) };", "};", ["O4"]],
  ["the importer renames door", "tools/protocol/import-v1/translate-v1.js", "c[encName(k === \"door\" && !e.openable ? \"openable\" : k)]", "c[encName(k)]", ["O5"]],
  ["the importer renames a reaction's door", "tools/protocol/import-v1/translate-v1.js", "} else if (h && typeof h === \"object\" && h.component === \"door\") out[k] = { ...h, component: \"openable\" };", "}", ["O5"]],
  ["a turn keeps the hinge", "client/lib/motioneval.js", "const shift = qApply(q0, [pv[0] - rp[0], pv[1] - rp[1], pv[2] - rp[2]]);\n  return { pos: base.pos.map((v, i) => v + shift[i]), q: qMul(q0, q) };", "return { pos: [...base.pos], q: qMul(q0, q) };", ["O6"]],
  ["the tween eases from where it was", "client/lib/motioneval.js", "return tw.from + (tw.to - tw.from) * u * u * (3 - 2 * u);", "return tw.to;", ["O6"]],
  ["Add Openable brings its open action", "shared/editschema.js", "...(rx.open ? [] : [OP.set(id, 'reactions', { ...rx, open: { kind: 'toggle', unless: 'locked' } })])], errors: [] };", "], errors: [] };", ["O7"]],
  ["the hinge button", "shared/editschema.js", "comps.set('pivot', { pos: [round(k === 'hingeL' ? box[0][0] : box[1][0], 4)", "comps.set('pivot', { pos: [round(0 && k === 'hingeL' ? box[0][0] : box[1][0], 4)", ["O7"]],
  ["Add Component doesn't offer LookAt", "shared/editschema.js", "const NOT_OFFERED = new Set(['LookAt']);", "const NOT_OFFERED = new Set([]);", ["R1"]],
  ["a handler's effect is checked at write", "shared/protocol/authority/checks.js", "handlerCheck(at, act, h); effectCheck(s, id, act, h); } }", "handlerCheck(at, act, h); } }", ["R2", "R3", "R4"]],
  ["…the value it would write", "shared/protocol/authority/checks.js", "else would(comp, field === undefined ? h.value : { ...c[comp], [field]: h.value });", "", ["R2"]],
  ["…a field needs its component", "shared/protocol/authority/checks.js", "if (field !== undefined && !isObj(c[comp])) refuse(\"no-target\"", "if (false) refuse(\"no-target\"", ["R3"]],
  ["…a toggle flips true/false", "shared/protocol/authority/checks.js", "if (h.kind === \"toggle\" && field !== undefined && ftype && ftype !== \"bool\" && ftype !== \"any\") refuse(", "if (false) refuse(", ["R4"]],
  ["…an impulse is a reserved kind", "shared/protocol/authority/checks.js", "if (!carry && Object.hasOwn(held, h?.kind)) refuse(\"reserved\"", "if (false) refuse(\"reserved\"", ["R6"]],
  ["a use with its component gone says so", "shared/protocol/authority/use.js", "if (!(e.c[comp] && typeof e.c[comp] === \"object\" && !Array.isArray(e.c[comp]))) refuse(\"no-handler\"", "if (false) refuse(\"no-handler\"", ["R5"]],
  ["motion: path is a type", "shared/protocol/componentspec.js", "enums: { type: [\"pendulum\", \"spin\", \"orbit\", \"oscillate\", \"path\"],", "enums: { type: [\"pendulum\", \"spin\", \"orbit\", \"oscillate\"],", ["M1", "R1"]],
  ["motion: rpm is taught", "shared/protocol/authority/checks.js", "if (\"rpm\" in v) refuse(\"schema\"", "if (false) refuse(\"schema\"", ["M2"]],
  ["motion: one speed", "shared/protocol/authority/checks.js", "if ((v.type === \"spin\" || v.type === \"orbit\") && v.degPerSec !== undefined && v.period !== undefined) refuse(", "if (false) refuse(", ["M2"]],
  ["motion: a path's points", "shared/protocol/authority/checks.js", "if (v.type === \"path\" && !(Array.isArray(v.points)", "if (false && !(Array.isArray(v.points)", ["M2"]],
  ["motion: a part's enums", "shared/protocol/authority/checks.js", "for (const [f, allowed] of Object.entries(COMPONENTS[comp.split(\":\")[0]]?.enums ?? {})) if (obj", "for (const [f, allowed] of Object.entries(COMPONENTS[comp]?.enums ?? {})) if (obj", ["M2"]],
  ["the orbit's period", "client/lib/motioneval.js", "if (Number.isFinite(m.period) && m.period > 0) return 360 / m.period;", "", ["M3"]],
  ["the editor reads the rate as the evaluator does", "shared/editschema.js", "Number.isFinite(m.period) && m.period > 0 ? 360 / m.period : ", "", ["M3"]],
  ["the importer: rpm → degPerSec", "tools/protocol/import-v1/translate-v1.js", "k === \"motion\" || k.startsWith(\"motion:\") ? newMotion(v) : v;", "v;", ["M4"]],
  ["the editor's rate drops the period", "shared/editschema.js", "if (param === 'degPerSec') { delete next.rpm; delete next.period; }", "if (param === 'degPerSec') { delete next.rpm; }", ["M5"]],
  ["Add Path starts where it stands", "shared/editschema.js", "Path: { type: 'path', points: [p0, [p0[0], p0[1], round(p0[2] + 2, 4)]], speed: 1 } };", "Path: { type: 'path', points: [[0, 0, 0], [0, 0, 2]], speed: 1 } };", ["M5"]],
  ["help: physics.who's default", "shared/protocol/componentspec.js", "when it has no grabbable; default member)", "when it has no grabbable; default builder)", ["H1"]],
  ["help: punt's default", "shared/protocol/verbspec.js", "who may is physics.who (default member)", "who may is physics.who (default builder)", ["H1"]],
  ["an open door is out of the way", "shared/protocol/authority/physics.js", "except.has(id) || openNow(st, id)) continue;", "except.has(id)) continue;", ["O8"]],
  ["a person's refusal drops tool syntax", "shared/protocol/refusal.js", "const fix = typeof r.fix === \"string\" && r.fix && !TOOLISH.test(r.fix) ? r.fix : \"\";", "const fix = r.fix ?? \"\";", ["P1"]],
  ["a person's refusal names things", "shared/protocol/refusal.js", "const n = nameOf(id); if (!n) return m;", "const n = null; if (!n) return m;", ["P1", "P2"]],
  ["CONTROL (no-op: must stay green)", "shared/protocol/refusal.js", "// ---- for people (ship list 10-07", "// ----  for people (ship list 10-07", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const r = Bun.spawnSync(["bun", path.join(ENGINE, "tools/protocol/shiplist-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
const SUBS = ["shared", "server", "tools", "defs", "client/lib"];
function mutantTree(tag: string) {
  const d = scratch(tag);
  for (const sub of SUBS) if (fs.existsSync(path.join(ENGINE, sub))) copyTree(path.join(ENGINE, sub), path.join(d, sub));
  for (const f of ["package.json", "tsconfig.json", "bunfig.toml", "AGENTS.md"]) if (fs.existsSync(path.join(ENGINE, f))) fs.copyFileSync(path.join(ENGINE, f), path.join(d, f));
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  return d;
}
if (argv.includes("--mutants")) {
  let bad = 0;
  const only = opt("only")?.split(",") ?? null;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    if (only && !cases.some((c) => only.includes(c))) continue;
    const d = mutantTree("smut"); const f = path.join(d, file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the gate moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const red = [...r.out.matchAll(/^\s*FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? r.code !== 0 && cases.every((c) => red.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${[...new Set(red)].join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
  }
  console.log(`\nshiplist mutants: ${MUTANTS.length - bad}/${MUTANTS.length} as they should be`);
  process.exit(bad ? 1 : 0);
}
if (argv.includes("--control")) {
  const d = scratch("sbase");
  const ar = Bun.spawnSync(["bash", "-c", `git -C ${ENGINE} archive ${BASE} ${SUBS.join(" ")} package.json AGENTS.md | tar -x -C ${d}`]);
  if (ar.exitCode !== 0) { console.log(`FAIL control: git archive ${BASE}: ${ar.stderr}`); process.exit(1); }
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  // this file and the scratch door it needs, as they are now (the base has no shiplist-check)
  fs.copyFileSync(path.join(ENGINE, "tools/protocol/shiplist-check.ts"), path.join(d, "tools/protocol/shiplist-check.ts"));
  const r = await runSelf(d, null);
  const red = new Set([...r.out.matchAll(/^\s*FAIL (\S+)/gm)].map((m) => m[1])); const all = new Set([...r.out.matchAll(/^\s*(?:ok|FAIL) (\S+)/gm)].map((m) => m[1]));
  let bad = 0;
  for (const c of all) { const want = KEEP.has(c) ? "green" : "red"; const got = red.has(c) ? "red" : "green"; if (want !== got) { bad++; console.log(`FAIL control ${c}: ${got} at ${BASE} (want ${want})`); } else console.log(`ok   control ${c}: ${got} at ${BASE}`); }
  console.log(`\nshiplist control at ${BASE}: ${all.size - bad}/${all.size} as they should be`);
  process.exit(bad || !all.size ? 1 : 0);
}

// ---------------- the cases ----------------
const T = opt("tree") ?? ENGINE;
const only = opt("only")?.split(",") ?? null;
const imp = async (p: string) => { try { return await import(path.join(T, p)); } catch (e) { return { __err: String(e?.message ?? e) }; } };
const D = await imp("shared/protocol/authority.js"), CAT = await imp("shared/protocol/componentspec.js"), LAB = await imp("shared/protocol/labmodels.js"), TS = await imp("shared/protocol/verbspec.js");
const SD = await imp("tools/protocol/scratchworld.ts"), TV1 = await imp("tools/protocol/import-v1/translate-v1.js"), FOLD = await imp("shared/protocol/fold.js");
const ME = await imp("client/lib/motioneval.js"), ES = await imp("shared/editschema.js"), RF = await imp("shared/protocol/refusal.js");
let pass = 0, fail = 0;
const ok = (id: string, cond: any, what: string, detail?: any) => {
  if (cond) { pass++; console.log(`  ok ${id} ${what}`); }
  else { fail++; console.log(`  FAIL ${id} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 500)}` : ""}`); } };
async function C(id: string, what: string, fn: () => any) {
  if (only && !only.includes(id)) return;
  try { const r = await fn(); if (Array.isArray(r)) ok(id, r[0], what, r[1]); else ok(id, r, what); }
  catch (e) { ok(id, false, what, `threw: ${e?.message ?? e}`); }
}
const why = (r: any) => (r?.ok ? "ok" : `${r?.refused?.code}: ${r?.refused?.reason}`);
const world = (tag = "ship") => SD.scratchWorld(tag);
// a v1 log (the importer's input): genesis, then entries as the old server wrote them
const v1 = (...entries: any[]) => [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log", roles: { olive: { role: "owner" } } } },
  ...entries.map((e, i) => ({ seq: i + 1, ts: 10 + i, actor: "olive", ...e }))];
const finalOf = (r: any) => r.final.translated;

// ---- O: openable ----
await C("O0", "the door model is still in the lab models (the asset keeps its name)", () => !!LAB.MODELS?.door);
await C("O1", "openable is a registered component; `door` is refused with 'did you mean openable'", () => {
  const W = world(); W.call("create", { id: "gate", model: "door", place: { at: [0, 0] } });
  const r = W.call("set", { id: "gate", component: "door", value: { open: false } });
  const sch = W.call("schema", { component: "openable" });
  return [!!CAT.COMPONENTS?.openable && !r.ok && r.refused.didYouMean?.includes("openable") && sch.ok !== false, { r: why(r), sch: JSON.stringify(sch).slice(0, 120) }];
});
await C("O2", "the authority takes openable {open, locked, angle, axis, time} and {slide}; refuses both, time > 10, angle > π, slide > 10 m", () => {
  const W = world(); W.call("create", { id: "gate", model: "door", place: { at: [0, 0] } });
  const good = [{ open: false, locked: false, angle: 1.5708, axis: "y", time: 0.8 }, { open: true, slide: [0.9, 0, 0], time: 0.5 }, { open: false, part: "leaf", angle: -1 }].map((v) => why(W.call("set", { id: "gate", component: "openable", value: v })));
  const bad = [{ open: false, angle: 1, slide: [1, 0, 0] }, { open: false, time: 11 }, { open: false, angle: 4 }, { open: false, slide: [20, 0, 0] }, { open: "yes" }].map((v) => why(W.call("set", { id: "gate", component: "openable", value: v })));
  return [good.every((x) => x === "ok") && bad.every((x) => x !== "ok"), { good, bad }];
});
await C("O3", "a visitor's use opens it (toggle's default is openable.open) and closes it again", () => {
  const W = world(); W.call("create", { id: "gate", model: "door", components: { openable: { open: false, locked: false }, reactions: { open: { kind: "toggle", unless: "locked" } } }, place: { at: [0, 0] } });
  const u1 = W.call("use", { id: "gate" }, "vic"); const o1 = W.state().entities.gate.c.openable?.open;
  const u2 = W.call("use", { id: "gate" }, "vic"); const o2 = W.state().entities.gate.c.openable?.open;
  return [u1.ok && o1 === true && u2.ok && o2 === false && !("door" in W.state().entities.gate.c), { u1: why(u1), o1, o2, c: Object.keys(W.state().entities.gate.c) }];
});
await C("O4", "look tells an agent the openable's state", () => {
  const W = world(); W.call("create", { id: "gate", model: "door", components: { openable: { open: true } }, place: { at: [0, 0] } });
  const l = W.call("look", {}, "vic"); const t = JSON.stringify(l);
  return [/"openable":\{"open":true,/.test(t), t.slice(0, 300)];   // its other parameters are written down too (PROTOCOL §4)
});
await C("O5", "the importer: a v1 `door` component is `openable`, a reaction's component 'door' is 'openable'; the authority takes them", () => {
  const r = TV1.translate(v1({ verb: "spawn", args: { id: "gate", lib: "door", pos: [0, 0, 0] } }, { verb: "comp", args: { id: "gate", type: "door", data: { open: false, locked: false } } },
    { verb: "comp", args: { id: "gate", type: "reactions", data: { open: { kind: "toggle", component: "door", field: "open", unless: "locked" } } } }));
  const c = finalOf(r).gate;
  const refusals = Object.entries(c).map(([k, v]) => D.schemaRefusal(k, v)).filter(Boolean);
  return [r.stats.divergences === 0 && c.openable?.open === false && !c.door && c.reactions?.open?.component === "openable" && !refusals.length, { c, refusals, div: r.stats.divergences }];
});
await C("O6", "every client's pose: a quarter turn about a hinge keeps the hinge still; a slide moves along its own frame; the tween eases and reverses from where it is", () => {
  const P = ME.openPose, F = ME.openFraction; if (!P || !F) return [false, "no openPose/openFraction"];
  const base = { pos: [2, 0, 3], q: [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)] };   // turned 90° about y
  const hinge = [-0.45, 0, 0];
  const at = (p: any) => { const w = ME.qApply(p.q, hinge); return p.pos.map((v: number, i: number) => +(v + w[i]).toFixed(6)); };
  const shut = P(base, { angle: Math.PI / 2 }, 0, hinge), open = P(base, { angle: Math.PI / 2 }, 1, hinge);
  const hingeStill = JSON.stringify(at(shut)) === JSON.stringify(at(open));
  const turned = Math.abs(ME.yawOfQuat(open.q) - ME.yawOfQuat(base.q)) > 1.5;
  const sl = P(base, { slide: [1, 0, 0] }, 1);   // its own +x, turned 90° about y, is world -z
  const slid = Math.abs(sl.pos[2] - 2) < 1e-9 && Math.abs(sl.pos[0] - 2) < 1e-9;
  const tw = { from: 0, to: 1, t0: 0, dur: 1000 };
  const ease = F(tw, 0) === 0 && F(tw, 500) === 0.5 && F(tw, 1000) === 1 && F(tw, 250) < 0.25 && F({ from: 0.5, to: 0, t0: 0, dur: 500 }, 250) === 0.25;
  return [hingeStill && turned && slid && ease, { hingeStill, turned, slid, sl, ease }];
});
await C("O7", "the editor: Add Component offers Openable; it writes the openable and its open action (the authority takes them, a visitor opens it); the card has its fields; a hinge button puts the pivot on an edge; removing it takes its action along", () => {
  const ent = { model: "door", pos: [0, 0, 0] }; const sc = ES.inspectSchema(ent, "gate", {});
  const offered = (sc.sections?.add ?? []).some((a: any) => a.name === "Openable" && !a.blocked);
  const add = ES.addOps(ent, "gate", "Openable");
  const W = world(); W.call("create", { id: "gate", model: "door", place: { at: [0, 0] } });
  const sent = W.sendAll(add.ops); const used = W.call("use", { id: "gate" }, "vic");
  const opened = W.state().entities.gate.c.openable?.open === true;
  const rec = { model: "door", pos: [0, 0, 0], openable: W.state().entities.gate.c.openable, reactions: W.state().entities.gate.c.reactions };
  const box = [[-0.45, 0, -0.03], [0.45, 2.1, 0.03]];
  const card = ES.inspectSchema(rec, "gate", { box }); const g = card.groups.find((x: any) => x.group === "openable");
  const keys = (g?.fields ?? []).map((f: any) => f.k);
  const hinge = ES.editOps(rec, "gate", { "openable.hingeL": 1 }, { box }); const pv = hinge.ops.find((o: any) => o.args.component === "pivot")?.args.value.pos;
  const hs = W.sendAll(hinge.ops);
  const rm = ES.editOps(rec, "gate", { "remove.openable": 1 }); const rs = W.sendAll(rm.ops);
  const after = W.state().entities.gate.c;
  return [offered && !add.errors.length && sent.ok && used.ok && opened && ["open", "locked", "by", "angle", "axis", "time", "hingeL"].every((k) => keys.includes(k)) && pv?.[0] === -0.45 && hs.ok && rs.ok && !after.openable && !after.reactions?.open,
    { offered, add: add.errors, sent: why(sent), used: why(used), keys, pv, hs: why(hs), rs: why(rs), after: Object.keys(after) }];
});

await C("O8", "a body walks through an open door, not a shut one (the authority's own body track, as an agent walks)", () => {
  const W = world(); W.call("create", { id: "gate", model: "wall", components: { openable: { open: false }, reactions: { open: { kind: "toggle" } } }, place: { at: [0, 0] } });
  W.call("move", { to: [0, 0, -1] }, "vic");
  const shut = W.call("move", { to: [0, 0, 1] }, "vic");
  W.call("use", { id: "gate" }, "vic");
  const open = W.call("move", { to: [0, 0, 1] }, "vic");
  return [!shut.ok && shut.refused.code === "solid" && open.ok, { shut: why(shut), open: why(open) }];
});

// ---- R: reactions ----
await C("R1", "every entry Add Component offers (a modelled thing; a swinging one; a part) is one the authority takes", () => {
  const out: any[] = [];
  for (const [label, ent, value] of [["plain", { model: "crate", pos: [0, 0, 0] }, undefined], ["swing", { model: "crate", pos: [0, 0, 0], motion: { type: "pendulum", amp: 0, period: 3.5 } }, undefined]] as any) {
    const sc = ES.inspectSchema(ent, "thing", { box: [[-0.3, 0, -0.3], [0.3, 0.6, 0.3]], parts: ["lid"] });
    for (const a of sc.sections.add) { if (a.blocked) continue;
      const v = a.name === "Annotation" ? "local/recipe" : a.name === "Label" ? "x" : value;
      const r0 = ES.addOps(ent, "thing", a.name, a.asks ? (a.asks === "Pendulum" ? "replace" : v) : v); if (r0.choice || r0.errors.length) continue;
      const W = world("r1"); const made = W.call("create", { id: "thing", model: "crate", components: Object.fromEntries(Object.entries(recordComponents(ent)).filter(([k]) => k !== "pos")), place: { at: [0, 0] } });
      const r = W.sendAll(r0.ops); if (!r.ok) out.push(`${label}/${a.name}: ${why(r)}`); }
  }
  return [!out.length, out];
});
await C("R2", "a set handler whose value the authority would refuse is refused when it's written, in plain terms", () => {
  const W = world(); W.call("create", { id: "lamp", components: { label: "lamp", light: { intensity: 4 }, transform: { pos: [0, 0, 0] } } });
  const r = W.call("set", { id: "lamp", component: "reactions", value: { glow: { kind: "set", component: "light", field: "intensity", value: "bright" } } });
  const good = W.call("set", { id: "lamp", component: "reactions", value: { glow: { kind: "set", component: "light", field: "intensity", value: 40 } } });
  return [!r.ok && /intensity/.test(r.refused.reason) && good.ok && W.call("use", { id: "lamp" }, "vic").ok, { r: why(r), good: why(good) }];
});
await C("R3", "a toggle on a plain crate (no openable) is refused when it's written, and nothing invisible is ever written", () => {
  const W = world(); W.call("create", { id: "crate", model: "crate", place: { at: [0, 0] } });
  const r = W.call("set", { id: "crate", component: "reactions", value: { open: { kind: "toggle" } } });
  W.call("use", { id: "crate" }, "vic");
  const c = W.state().entities.crate.c;
  return [!r.ok && /openable/.test(r.refused.reason + r.refused.fix) && !c.door && !c.openable, { r: why(r), comps: Object.keys(c) }];
});
await C("R3b", "a toggle naming the openable without a field opens and closes it (the Commons' {component: 'openable'} form, merge 10-07)", () => {
  const W = world(); W.call("create", { id: "gate", model: "crate", components: { openable: { open: false } }, place: { at: [0, 0] } });
  const r = W.call("set", { id: "gate", component: "reactions", value: { use: { kind: "toggle", component: "openable" } } });
  W.call("use", { id: "gate" }, "vic"); const open1 = W.state().entities.gate.c.openable?.open;
  W.call("use", { id: "gate" }, "vic"); const open2 = W.state().entities.gate.c.openable?.open;
  return [r.ok && open1 === true && open2 === false, { r: why(r), open1, open2 }];
});
await C("R4", "a toggle of a number (light.intensity) is refused when written, saying a toggle flips true/false; of a true/false field (openable.locked), taken", () => {
  const W = world(); W.call("create", { id: "lamp", components: { label: "lamp", light: { intensity: 4 }, openable: { open: false }, transform: { pos: [0, 0, 0] } } });
  const n = W.call("set", { id: "lamp", component: "reactions", value: { t: { kind: "toggle", component: "light", field: "intensity" } } });
  const b = W.call("set", { id: "lamp", component: "reactions", value: { t: { kind: "toggle", component: "openable", field: "locked" } } });
  return [!n.ok && /true\/false/.test(n.refused.reason) && b.ok, { n: why(n), b: why(b) }];   // says why in a toggle's terms
});
await C("R5", "a use whose component was removed since says so, and writes nothing", () => {
  const W = world(); W.call("create", { id: "gate", model: "door", components: { openable: { open: false } }, place: { at: [0, 0] } });
  W.call("set", { id: "gate", component: "reactions", value: { open: { kind: "toggle" } } });
  W.call("delete", { id: "gate", component: "openable" });
  const u = W.call("use", { id: "gate" }, "vic"); const c = W.state().entities.gate.c;
  return [!u.ok && /no openable/.test(u.refused.reason) && !c.openable && !c.door, { u: why(u), comps: Object.keys(c) }];
});
await C("R6", "a push (impulse) is refused when written: a reserved kind since the shape audit (10-16), on a spinning thing or any", () => {
  const W = world(); W.call("create", { id: "fan", model: "crate", components: { motion: { type: "spin", degPerSec: 30 } }, place: { at: [0, 0] } });
  const r = W.call("set", { id: "fan", component: "reactions", value: { push: { kind: "impulse", strength: 0.5 } } });
  return [!r.ok && r.refused.code === "reserved", why(r)];
});
await C("R7", "what was right stays right: a door made with its state and handler in one write, a bell that sets its label, a world's own invented flag", () => {
  const W = world();
  const a = W.call("create", { id: "gate2", model: "door", components: { openable: { open: false, locked: false }, reactions: { open: { kind: "toggle", unless: "locked" }, bolt: { kind: "set", component: "openable", field: "locked", value: true, who: "builder" } } }, place: { at: [0, 0] } });
  const b = W.call("create", { id: "bell", model: "bell", components: { reactions: { ring: { kind: "set", component: "label", value: "rung" } } }, place: { at: [2, 0] } });
  const c = W.call("create", { id: "lever", model: "crate", components: { reactions: { pull: { kind: "set", component: "t/tag:pulled", value: true } } }, place: { at: [4, 0] } });
  const u = W.call("use", { id: "bell" }, "vic");
  return [b.ok && c.ok && u.ok && W.state().entities.bell.c.label === "rung" && (a.ok || CAT.COMPONENTS?.door), { a: why(a), b: why(b), c: why(c), u: why(u) }];
});

// ---- M: motion ----
await C("M1", "the authority takes spin {degPerSec | period}, orbit {center, radius, period, face}, path {points, speed | duration, loop, face}", () => {
  const W = world(); W.call("create", { id: "m", model: "crate", place: { at: [0, 0] } });
  const vs = [{ type: "spin", degPerSec: 30 }, { type: "spin", period: 12 }, { type: "orbit", center: [1, 0, 1], radius: 2, period: 8, face: false },
    { type: "path", points: [[0, 0, 0], [0, 0, 3], [2, 0, 3]], speed: 1, loop: "pingpong", face: true }, { type: "path", points: [[0, 0, 0], [1, 0, 0]], duration: 4, loop: "once" }];
  const rs = vs.map((v) => why(W.call("set", { id: "m", component: "motion", value: v })));
  return [rs.every((x) => x === "ok"), rs];
});
await C("M2", "…and refuses, saying how: rpm (degPerSec = rpm × 6), two speeds, a path of one point, an unknown loop, a part's unknown type", () => {
  const W = world(); W.call("create", { id: "m", model: "crate", place: { at: [0, 0] } });
  const rs = [{ c: "motion", v: { type: "spin", rpm: 3 } }, { c: "motion", v: { type: "orbit", radius: 1, period: 4, degPerSec: 90 } }, { c: "motion", v: { type: "path", points: [[0, 0, 0]] } },
    { c: "motion", v: { type: "path", points: [[0, 0, 0], [1, 0, 0]], loop: "bounce" } }, { c: "motion:arm", v: { type: "wobble" } }].map(({ c, v }) => W.call("set", { id: "m", component: c, value: v }));
  return [rs.every((r) => !r.ok) && /18/.test(rs[0].refused?.fix ?? ""), rs.map(why)];
});
await C("M3", "an orbit's period sets its speed (a 4 s lap turns 90° in 1 s), everywhere: the renderer's evaluator and the editor's rate", () => {
  const T0 = 1e12; const base = { pos: [0, 0, 0], yaw: 0 };
  const o = ME.evalWholeMotion(base, { type: "orbit", radius: 1, center: [0, 0, 0], period: 4, phase: 0, t0: T0 }, T0 + 1000);
  const quarter = Math.abs(o.pos[0] - 1) < 1e-6 && Math.abs(o.pos[2]) < 1e-6;   // sin(90°), cos(90°)
  const s = ME.evalWholeMotion(base, { type: "spin", period: 4, t0: T0 }, T0 + 1000);
  const spin = Math.abs(Math.abs(ME.yawOfQuat(s.quat)) - Math.PI / 2) < 1e-6;
  const sc = ES.inspectSchema({ model: "crate", pos: [0, 0, 0], motion: { type: "orbit", radius: 1, period: 4 } }, "m", {});
  const rate = sc.groups.find((g: any) => g.group === "motion")?.fields.find((f: any) => f.k === "degPerSec")?.value;
  return [quarter && spin && rate === 90, { o: o.pos, spin, rate }];
});
await C("M4", "the importer: spin rpm → degPerSec (× 6); orbit center/face/period and a path's points/speed/loop stay in the motion (no imported:motion); the authority takes each", () => {
  const r = TV1.translate(v1(
    { verb: "spawn", args: { id: "fan", lib: "crate", pos: [0, 0, 0] } }, { verb: "motion", args: { id: "fan", type: "spin", rpm: 3, axis: "y" } },
    { verb: "spawn", args: { id: "boat", lib: "crate", pos: [5, 0, 0] } }, { verb: "motion", args: { id: "boat", type: "orbit", center: [5, 0, 5], radius: 3, period: 20, face: false } },
    { verb: "spawn", args: { id: "cart", lib: "crate", pos: [9, 0, 0] } }, { verb: "motion", args: { id: "cart", type: "path", points: [[9, 0, 0], [9, 0, 6]], speed: 0.5, loop: "pingpong", face: true } }));
  const v = finalOf(r); const imported = Object.entries(v).flatMap(([id, c]: any) => Object.keys(c).filter((k) => k.startsWith("imported:")).map((k) => `${id}.${k}`)).filter((k) => k !== "@world.imported:ownerless"); // ownerless worlds are opened by the translation (row 22)
  const W = world(); const made = ["fan", "boat", "cart"].map((id) => why(W.call("create", { id, model: "crate", components: { motion: (({ t0, ...m }) => m)(v[id].motion) }, place: { at: [id.length, 0] } })));
  return [r.stats.divergences === 0 && v.fan.motion.degPerSec === 18 && !("rpm" in v.fan.motion) && v.boat.motion.period === 20 && v.boat.motion.face === false && v.boat.motion.center?.[2] === 5
    && v.cart.motion.points?.length === 2 && v.cart.motion.loop === "pingpong" && !imported.length && made.every((x) => x === "ok"), { fan: v.fan.motion, boat: v.boat.motion, cart: v.cart.motion, imported, made, div: r.stats.divergences }];
});
await C("M5", "the editor: a rate typed on an orbit drops its period (one speed); Add Path starts where the thing stands", () => {
  const ent = { model: "crate", pos: [3, 0, -2], motion: { type: "orbit", radius: 1, period: 4 } };
  const e = ES.editOps(ent, "m", { "motion.degPerSec": 30 }); const m = e.ops.find((o: any) => o.args.component === "motion")?.args.value;
  const p = ES.addOps({ model: "crate", pos: [3, 0, -2] }, "m", "Path").ops[0]?.args.value;
  return [m?.degPerSec === 30 && !("period" in m) && JSON.stringify(p?.points?.[0]) === "[3,0,-2]", { m, p }];
});

// ---- H: help text ----
await C("H1", "what agents read says physics.who and grabbable.who default to member (3b3ad8e2; visitor until R 10-21), never builder", () => {
  const texts = [CAT.COMPONENTS.physics.help, CAT.COMPONENTS.grabbable.help, JSON.stringify(TS), fs.readFileSync(path.join(T, "AGENTS.md"), "utf8").split("Humans have T")[1]?.slice(0, 400) ?? ""];
  const bad = texts.filter((t) => /default builder/.test(t)).map((t) => t.slice(0, 80));
  return [!bad.length && /default member/.test(texts[0]) && /default member/.test(texts[1]), bad];
}).catch(() => {});

// ---- P: people ----
await C("P1", "a refusal for a person: what they tried and why, no refusal code, no tool syntax, things by their labels; the agents' words unchanged", () => {
  const nameOf = (id: string) => ({ "3485c78e0a1b": "“Front door”", lamp: "“Desk lamp”" })[id] ?? null;
  const r = { refused: { code: "locked", reason: "3485c78e0a1b is locked by Ann (§5)", fix: "unlock it first: delete {id: '3485c78e0a1b', component: 'lock'}, or send throughLock: true" } };
  const p = RF.plainRefusal?.("move 3485c78e0a1b", r, nameOf) ?? "";
  const plainTeach = RF.plainRefusal?.("use lamp", { refused: { code: "rights", reason: "only a builder may bolt lamp", fix: "ask someone who can" } }, nameOf) ?? "";
  const agent = RF.refusalText("move 3485c78e0a1b", r);
  return [p.includes("“Front door”") && !/3485c78e|\(locked\)|\{|throughLock|§/.test(p) && /ask someone who can/i.test(plainTeach) && plainTeach.includes("“Desk lamp”") && agent.includes("(locked)") && agent.includes("throughLock"), { p, plainTeach, agent }];
});
await C("P2", "a warning for a person names things by label (an agent's still by id)", () => {
  const nameOf = (id: string) => ({ "3485c78e0a1b": "“Front door”", lamp: "“Desk lamp”" })[id] ?? null;
  const w = { id: "lamp", kind: "floating", gap: 0.3, above: "3485c78e0a1b" };
  const p = RF.warningText(w, nameOf), a = RF.warningText(w);
  return [p === "“Desk lamp” floats 0.3 m above “Front door”" && a === "lamp floats 0.3 m above 3485c78e0a1b", { p, a }];
});
await C("P3", "the client shows a person the plain words and the authority's warnings (edit sends), and a moderator's warning on the XR quad in a headset", () => {
  const src = (f: string) => { try { return fs.readFileSync(path.join(T, f), "utf8"); } catch { return ""; } };
  const editSrc = src("client/lib/editwrites.js"), ppl = src("client/lib/people.js"), xr = src("client/lib/xrask.js");
  return [/toast\(text, 'warn'/.test(editSrc) && /const text = plain\(what, r\)/.test(editSrc) && /showWarnings\(what, r\)/.test(editSrc) && /xrActive\(\)\s*\n?\s*\? chooseXR/.test(ppl) && /bus\.on\('edit-warned'/.test(xr),
    "(the browser stages in tools/protocol/shiplist-probe.ts watch these happen)"];
});

console.log(`\nshiplist: ${pass} passed, ${fail} failed${T !== ENGINE ? ` (tree ${T})` : ""}`);
process.exit(fail ? 1 : 0);
