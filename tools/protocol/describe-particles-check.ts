// tools/protocol/describe-particles-check.ts — R's rulings of 10-07, through the real authority and the shared code the
// clients run:
//   D  description: how a thing is described to any text-based reader (alt text), and the reading every reader shares
//      (name, description, then what it can do and its state, GENERATED from its components: shared/a11y.js)
//   X  particles: a tiny instance {effect, part?, at?, seed?, playing?, scale?, params?} naming an effect document (an
//      Essential, or one stored in the world), the documents' bounds, the older bag read but never written, the translator
//   G  the simulation (shared/particlesim.js, Godot 4.7.2's CPUParticles3D ported): its modules do what Godot's do
//   K  kept (green at the base and now)
//   bun tools/protocol/describe-particles-check.ts              every case
//   bun tools/protocol/describe-particles-check.ts --control    at the base (f6777f13): every D/X/G case must be red, every K green
//   bun tools/protocol/describe-particles-check.ts --mutants    remove each gate in a copy of the tree: its cases go red; a no-op stays green
//   bun tools/protocol/describe-particles-check.ts --tree <dir> against another checkout
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = "f6777f13";
if (argv.includes("--control")) {
  const d = scratch("dpctl"); const r0 = Bun.spawnSync(["sh", "-c", `git archive ${BASE} shared server tools client/lib | tar -x -C ${d} && ln -s ${fs.realpathSync(path.join(ENGINE, "node_modules"))} ${d}/node_modules`], { cwd: ENGINE });
  if (r0.exitCode !== 0) { console.log(`FAIL can't extract ${BASE}: ${r0.stderr}`); process.exit(1); }
  const r = Bun.spawnSync(["bun", path.join(ENGINE, "tools/protocol/describe-particles-check.ts"), "--tree", d], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const lines = (r.stdout.toString() + r.stderr.toString()).split("\n").filter((l) => /^(ok|FAIL) /.test(l));
  const isKept = (l: string) => l.slice(5).trim().startsWith("K");
  const wrong = lines.filter((l) => (isKept(l) ? l.startsWith("FAIL") : l.startsWith("ok ")));
  console.log(lines.map((l) => `${(isKept(l) ? l.startsWith("ok ") : l.startsWith("FAIL")) ? (isKept(l) ? "kept at base:  " : "red at base:   ") : "WRONG AT BASE: "}${l.slice(0, 150)}`).join("\n"));
  console.log(`[describe-particles-check --control] at ${BASE}: ${lines.length} cases, ${wrong.length} wrong (new cases must be red there, K cases green)`);
  process.exit(wrong.length || !lines.length ? 1 : 0);
}

// [name, file, find, replace, cases that must turn red]
const MUTANTS: [string, string, string, string, string[]][] = [
  ["damping clamps at zero (Godot: v < 0 → 0)", "shared/particlesim.js", "if (v < 0) { vx[i] = 0; vy[i] = 0; vz[i] = 0; }", "if (false) {}", ["G4"]],
  ["explosiveness gathers the restart phases", "shared/particlesim.js", "restartPhase *= 1 - S.explosiveness;", "", ["G2"]],
  ["oneShot stops emitting after a cycle", "shared/particlesim.js", "if (S.oneShot && sim.cycle > 0) sim.emitting = false;", "", ["G3"]],
  ["preprocess runs before the first frame", "shared/particlesim.js", "let todo = S.preprocess;", "let todo = 0;", ["G1"]],
  ["a sphere's y is its own extent", "shared/particlesim.js", "oy[i] = s * ex[1] * x;", "oy[i] = s * ex[0] * x;", ["G6"]],
  ["the cone's spread is in degrees", "shared/particlesim.js", "const a1 = (rng() * 2 - 1) * V.spread * DEG,", "const a1 = (rng() * 2 - 1) * V.spread,", ["G5"]],
  ["not emitting: the living finish, none born", "shared/particlesim.js", "if (!sim.emitting) { active[i] = 0; continue; }", "", ["G7"]],
  ["the seed seeds each particle", "shared/particlesim.js", "pseed[i] = (base + 1 + i + Math.imul(sim.cycle, n)) >>> 0;", "pseed[i] = (1 + i + Math.imul(sim.cycle, n)) >>> 0;", ["G8"]],
  ["the older bag is refused in a write", "shared/particle_effects.js", "  if (legacy.length) return `${legacy.join", "  if (false) return `${legacy.join", ["X2"]],
  ["params are the effect's declared ones", "shared/particle_effects.js", "if (!Object.hasOwn(decl, k)) return `params.${k}:", "if (false) return `params.${k}:", ["X4"]],
  ["a document's amount is bounded", "shared/particle_effects.js", "S.amount >= 1 && S.amount <= L.amount)", "S.amount >= 1)", ["X6"]],
  ["a document's total is bounded", "shared/particle_effects.js", "if (total > L.totalAmount) return", "if (false) return", ["X6"]],
  ["the authority checks particles at all", "shared/protocol/authority.js", "if (!FORKING) for (const op of norm) if (op.verb === \"set\") particlesCheck(w, op);", "", ["X2", "X3", "X4", "X8"]],
  ["the translator modernizes particles", "tools/protocol/import-v1/translate-v1.js", ": k === \"particles\" ? newParticles(v) : v;", ": v;", ["X10"]],
  ["openable's state is generated", "shared/a11y.js", "if (isObj(c.openable)) out.state.push(", "if (false) out.state.push(", ["D2", "D3"]],
  ["openable's affordance is generated", "shared/a11y.js", "if (isObj(c.openable)) out.can.push(", "if (false) out.can.push(", ["D2"]],
  ["a description is bounded", "shared/protocol/authority.js", "if (def.maxLen !== undefined && graphemes(v) > def.maxLen) refuse(", "if (false) refuse(", ["D1"]],
  ["look clips a description", "shared/protocol/authority.js", "full || graphemes(ax.description) <= 200 ? ax.description", "true ? ax.description", ["D4"]],
  ["CONTROL (no-op: must stay green)", "shared/a11y.js", "// a11y — how", "//  a11y — how", []],
];
if (argv.includes("--mutants")) {
  let wrongs = 0;
  for (const [name, file, find, repl, want] of MUTANTS) {
    const d = scratch("dpmut");
    for (const sub of ["shared", "server", "tools", "defs", "client/lib"]) if (fs.existsSync(path.join(ENGINE, sub))) fs.cpSync(path.join(ENGINE, sub), path.join(d, sub), { recursive: true });
    fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
    const f = path.join(d, file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { wrongs++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file}`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = Bun.spawnSync(["bun", path.join(ENGINE, "tools/protocol/describe-particles-check.ts"), "--tree", d, ...(want.length ? ["--only", want.join(",")] : [])], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    const red = [...(r.stdout.toString()).matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);
    const good = want.length ? want.every((c) => red.includes(c)) : r.exitCode === 0;
    if (!good) wrongs++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${want.length ? `red: ${red.join(",") || "(none)"} (want ${want.join(",")})` : `exit ${r.exitCode} (want 0)`}`);
  }
  console.log(`[describe-particles-check --mutants] ${MUTANTS.length} mutations, ${wrongs} wrong`); process.exit(wrongs ? 1 : 0);
}
const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const none = () => ({});
const D = await import(TREE + "shared/protocol/authority.js");
const F = await import(TREE + "shared/protocol/fold.js");
const CS = await import(TREE + "shared/protocol/componentspec.js");
const PE = await import(TREE + "shared/particle_effects.js").catch(none);   // absent at the base
const PS = await import(TREE + "shared/particlesim.js").catch(none);
const AX = await import(TREE + "shared/a11y.js").catch(none);
const TV1 = await import(TREE + "tools/protocol/import-v1/translate-v1.js");
const root = scratch("dp");

function openWorld(name: string) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ name, entries,
    getBlob: (h: string) => { const s = fs.readFileSync(blobPath(h), "utf8"); if (`sha256:${F.sha256(s)}` !== h) throw new Error("blob mismatch"); return JSON.parse(s); },
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => Number(process.env.PROTOCOL_NOW), writeLine: (line: string) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: null,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
let T = 1800000000000, N = 0;
function session() {
  const name = `w${++N}`; let w: any = null; const W = () => (w ??= openWorld(name));
  const call = (actor: string, verb: string, args: any = {}, step = 100) => { T += step; process.env.PROTOCOL_NOW = String(T);
    try { return D.request(W(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, call, w: W };
}
const code = (r: any) => r?.refused?.code;
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 160)}`);
const comp = (s: any, id: string, c: string) => s.w().state().entities[id]?.c[c];
function cast(s: any) {
  s.call("olive", "create-world", { title: s.name });
  for (const [who, role] of [["bob", "builder"], ["vic", "visitor"]]) s.call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role } });
}
const thing = (s: any, id: string, components: any = {}) => s.call("olive", "create", { id, components: { transform: { pos: [0, 0, 0] }, ...components } });
const lookOf = (s: any, id: string, who = "olive") => (s.call(who, "look", {}).things ?? []).find((t: any) => t.id === id) ?? null;
const DOOR = { openable: { open: false, locked: true }, reactions: { open: { kind: "toggle", unless: "locked" }, knock: { kind: "impulse", strength: 0.2 } } };
const doc = (over: any = {}) => ({ kind: "particle-effect", v: 1, name: "lantern glow", reads: "a warm glow", emitters: [{ spawn: { amount: 40, lifetime: 2 }, shape: { type: "sphere", radius: 0.1 }, velocity: { direction: [0, 1, 0], spread: 20, speed: [0.1, 0.3] }, forces: { gravity: [0, 0.2, 0] }, size: { base: 0.08 }, color: { base: 0xffcc66, ramp: [[0, 0xffffff, 0], [0.2, 0xffffff, 1], [1, 0xffffff, 0]] }, render: { blend: "add" } }],
  params: { glow: { type: "number", min: 0, max: 1, to: [{ path: "emitters.0.color.alpha" }] } }, ...over });
const em = (over: any = {}) => PE.resolveEmitter({ spawn: { amount: 64, lifetime: 1 }, ...over });
const run = (e: any, secs: number, seed = 1) => { const s = PS.makeSim(e, { seed }); for (let t = 0; t < secs; t += 1 / 60) s.step(1 / 60); return s; };
const alive = (s: any) => [...Array(s.amount).keys()].filter((i) => s.alive[i]);

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean };
const cases: Case[] = [
  // ---------------- K: kept ----------------
  { id: "K1", what: "label is still a plain string name, and story is still the titled placard {title, text, marks?}", run(s) { cast(s); thing(s, "tree");
      return { l: show(s.call("olive", "set", { id: "tree", component: "label", value: "the first marker tree" })), st: show(s.call("olive", "set", { id: "tree", component: "story", value: { title: "The first marker tree", text: "Mica's fire." } })) }; },
    good: (o) => o.l === "ok" && o.st === "ok" },
  { id: "K2", what: "the particles name is still registered with every field the first protocol had (a stored value is read forever)", run() {
      return { f: Object.keys(CS.COMPONENTS.particles?.fields ?? {}) }; },
    good: (o) => ["preset", "seed", "origin", "count", "quality", "size", "area", "texture", "speed", "opacity", "lifetime"].every((k) => o.f.includes(k)) },

  // ---------------- D: description ----------------
  { id: "D1", what: "description is registered: a plain string (alt text) is taken; 501 characters, an object, or a direction override are refused", run(s) { cast(s); thing(s, "lamp");
      const set = (v: any) => s.call("olive", "set", { id: "lamp", component: "description", value: v });
      return { ok: show(set("A brass lantern, dented, its glass smoked.")), long: code(set("a".repeat(501))), obj: code(set({ text: "x" })), bidi: code(set("abc‮def")), on: code(s.call("olive", "set", { id: "@world", component: "description", value: "x" })) }; },
    good: (o) => o.ok === "ok" && o.long === "bounds" && o.obj === "shape" && o.bidi === "shape" && o.on === "thing-only" },
  { id: "D2", what: "look reads a thing as name, description, then GENERATED affordances and state: a door can be opened ('open'), is shut and locked, can be used to knock, is fixed in place", run(s) { cast(s);
      thing(s, "door", { label: "oak door", description: "A heavy oak door, iron-banded.", ...DOOR, lock: true });
      const t = lookOf(s, "door"); return { name: t?.name, description: t?.description, can: t?.can, state: t?.state }; },
    good: (o) => o.name === "oak door" && o.description === "A heavy oak door, iron-banded." && o.can?.[0] === "opens and shuts (use 'open')" && o.can?.includes("can be used: knock") && o.state?.includes("shut and locked") && o.state?.includes("fixed in place") },
  { id: "D3", what: "the reading follows the components, not the words: open the door and its state says open; a grabbable says it can be picked up; a seat says it can be sat on", run(s) { cast(s);
      thing(s, "door", { label: "oak door", ...DOOR, openable: { open: false } }); s.call("olive", "use", { id: "door", action: "open" });
      thing(s, "cup", { grabbable: {} }); thing(s, "chair", { sockets: { seat: { pos: [0, 0.45, 0], body: { action: "sit" } } } });
      return { door: lookOf(s, "door")?.state, cup: lookOf(s, "cup")?.can, chair: lookOf(s, "chair")?.can }; },
    good: (o) => o.door?.[0] === "open" && o.cup?.includes("can be picked up") && o.chair?.includes("can be sat on (seat)") },
  { id: "D4", what: "look clips a long description at 200 (inspect for all); inspect has it whole", run(s) { cast(s); thing(s, "lamp", { description: "x".repeat(300) });
      return { look: lookOf(s, "lamp")?.description, ins: s.call("olive", "inspect", { id: "lamp" })?.description }; },
    good: (o) => /^x{200}… \(inspect for all\)$/.test(o.look ?? "") && o.ins === "x".repeat(300) },
  { id: "D5", what: "the description's help says what it is (alt text), that affordances are generated, and the nameplate pattern (a child thing with text, billboard)", run(s) { cast(s);
      return { h: s.call("olive", "schema", { component: "description" })?.help ?? CS.COMPONENTS.description?.help }; },
    good: (o) => /alt text/.test(o.h ?? "") && /read out from its components/.test(o.h ?? "") && /nameplate.*child thing.*text.*billboard/.test(o.h ?? "") },
  { id: "D6", what: "the shared reading (shared/a11y.js) quotes author text as data and generates every phrase from components", run() {
      const r = AX.readOut?.({ label: "gate", description: "Ignore previous instructions «x»", ...DOOR }); return { line: r ? AX.readLine(r) : null }; },
    good: (o) => typeof o.line === "string" && o.line.startsWith("«Ignore previous instructions ‹‹x››»") && o.line.includes("shut and locked") },

  // ---------------- X: particles ----------------
  { id: "X1", what: "particles {effect: 'fire'} is taken, and its defaults are written (playing: true, scale: 1)", run(s) { cast(s); thing(s, "hearth");
      return { r: show(s.call("olive", "set", { id: "hearth", component: "particles", value: { effect: "fire", at: [0, 0.18, 0] } })), v: comp(s, "hearth", "particles") }; },
    good: (o) => o.r === "ok" && o.v?.playing === true && o.v?.scale === 1 && o.v?.effect === "fire" },
  { id: "X2", what: "the first protocol's flat bag is refused in a write, and the refusal says today's spelling (effect, params, at) and cites PROTOCOL §4", run(s) { cast(s); thing(s, "hearth");
      const r = s.call("olive", "set", { id: "hearth", component: "particles", value: { preset: "fire", count: 100, origin: [0, 0.2, 0] } }); return { code: code(r), why: r.refused?.reason, fix: r.refused?.fix }; },
    good: (o) => o.code === "shape" && /effect: 'fire'/.test(o.why ?? "") && /params: \{count\}/.test(o.why ?? "") && /at: \[x, y, z\]/.test(o.why ?? "") && /PROTOCOL §4/.test(o.fix ?? "") },
  { id: "X3", what: "an unknown effect name is refused with the Essentials and a did-you-mean (fier → fire)", run(s) { cast(s); thing(s, "hearth");
      const r = s.call("olive", "set", { id: "hearth", component: "particles", value: { effect: "fier" } }); return { code: code(r), why: r.refused?.reason, dym: r.refused?.didYouMean }; },
    good: (o) => o.code === "shape" && /smoke/.test(o.why ?? "") && o.dym?.[0] === "fire" },
  { id: "X4", what: "params are the effect's own: count 100 taken; count 601 refused (its declared bound); an undeclared param refused, naming the effect's params", run(s) { cast(s); thing(s, "hearth");
      const set = (params: any) => s.call("olive", "set", { id: "hearth", component: "particles", value: { effect: "fire", params } });
      const und = set({ wobble: 2 }); return { ok: show(set({ count: 100, quality: "low" })), big: code(set({ count: 601 })), und: code(und), undWhy: und.refused?.reason }; },
    good: (o) => o.ok === "ok" && o.big === "bounds" && o.und === "shape" && /no param 'wobble'/.test(o.undWhy ?? "") && /count/.test(o.undWhy ?? "") },
  { id: "X5", what: "upload {effect} stores a document by its content; particles names it (sha256: and eido:sha256/ alike); effect {name} returns it; its params are its own", run(s) { cast(s); thing(s, "lantern");
      const up = s.call("bob", "upload", { effect: doc() }); const h = up.effect; const hex = String(h).slice(7);
      const a = s.call("bob", "set", { id: "lantern", component: "particles", value: { effect: h, params: { glow: 0.5 } } });
      const b = s.call("bob", "set", { id: "lantern", component: "particles", value: { effect: `eido:sha256/${hex}` } });
      const bad = s.call("bob", "set", { id: "lantern", component: "particles", value: { effect: h, params: { count: 3 } } });
      const read = s.call("vic", "effect", { name: h });
      return { up: show(up), h, a: show(a), b: show(b), bad: code(bad), read: read?.effect?.name, ess: s.call("vic", "effect", { name: "smoke" })?.effect?.emitters?.length }; },
    good: (o) => o.up === "ok" && /^sha256:[0-9a-f]{64}$/.test(o.h ?? "") && o.a === "ok" && o.b === "ok" && o.bad === "shape" && o.read === "lantern glow" && o.ess === 1 },
  { id: "X6", what: "a document is bounded: 601 particles, 5 emitters, 1001 in all, a 31 s life, a texture outside the library, an unknown module, and a non-effect are each refused at upload", run(s) { cast(s);
      const up = (d: any) => code(s.call("bob", "upload", { effect: d }));
      const e0 = doc().emitters[0];
      return { good: show(s.call("bob", "upload", { effect: doc() })), amount: up(doc({ emitters: [{ ...e0, spawn: { amount: 601, lifetime: 1 } }] })), five: up(doc({ emitters: [e0, e0, e0, e0, e0] })),
        total: up(doc({ emitters: [{ ...e0, spawn: { amount: 600 } }, { ...e0, spawn: { amount: 401 } }] })), life: up(doc({ emitters: [{ ...e0, spawn: { amount: 4, lifetime: 31 } }] })),
        tex: up(doc({ emitters: [{ ...e0, render: { texture: "../../etc/passwd.png" } }] })), mod: up(doc({ emitters: [{ ...e0, turbulence: {} }] })), kind: up({ kind: "nope", v: 1, emitters: [] }) }; },
    good: (o) => o.good === "ok" && Object.entries(o).every(([k, c]) => k === "good" || c === "shape") },
  { id: "X7", what: "an address nothing here stores is not-found; a visitor can't upload a document but may read one", run(s) { cast(s); thing(s, "lantern");
      return { nf: code(s.call("olive", "set", { id: "lantern", component: "particles", value: { effect: `sha256:${"0".repeat(64)}` } })), vis: code(s.call("vic", "upload", { effect: doc() })), read: show(s.call("vic", "effect", { name: "fire" })) }; },
    good: (o) => o.nf === "not-found" && o.vis === "rights" && o.read === "ok" },
  { id: "X8", what: "a held thing's fx carries a particles value in today's shape: the older bag is refused there too", run(s) { cast(s); thing(s, "hose");
      return { old: code(s.call("olive", "set", { id: "hose", component: "grabbable", value: { fx: { particles: { preset: "smoke" } } } })), now: show(s.call("olive", "set", { id: "hose", component: "grabbable", value: { fx: { particles: { effect: "smoke" }, at: [0, 0, 0.5] } } })) }; },
    good: (o) => o.old === "shape" && o.now === "ok" },
  { id: "X9", what: "every Essential is a document that passes its own bounds, and every older bag reads exactly as its modern spelling (instanceOf), param by param", run() {
      const names = Object.keys(PE.ESSENTIALS ?? {}); const bad = names.filter((k) => PE.effectProblem(PE.ESSENTIALS[k]));
      const old = { preset: "fire", seed: 9, origin: [0, 0.18, 0], count: 120, size: 0.4, opacity: 0.8, speed: 1.5, lifetime: 0.7, area: [0.2, 0.1, 0.2], texture: "eidoverse/assets/particle_textures/flame_05.png", quality: "med" };
      const a = PE.resolveParticles(old, { entityId: "h" }), b = PE.resolveParticles(PE.modernize(old), { entityId: "h" });
      const e = a.emitters?.[0];
      return { names, bad, same: JSON.stringify(a) === JSON.stringify(b), knobs: e && [e.spawn.amount, e.size.base, e.color.alpha, e.spawn.speedScale, e.spawn.lifetime, e.shape.extents.join(), e.render.texture, e.spawn.ratio] }; },
    good: (o) => o.names.length === 9 && !o.bad.length && o.same && JSON.stringify(o.knobs) === JSON.stringify([120, 0.4, 0.8, 1.5, 0.7, "0.2,0.06,0.2", "eidoverse/assets/particle_textures/flame_05.png", 0.5]) },
  { id: "X10", what: "the translator writes a v1 particles bag in today's shape, losslessly: preset → effect, origin → at, knobs → params, an unknown key → imported:particles", run() {
      const L = [{ seq: 0, ts: 1, actor: "door", verb: "genesis", args: {} }, { seq: 1, ts: 2, actor: "mica", verb: "spawn", args: { id: "f78c7ab8", lib: "x.glb", pos: [0, 0, 0] } },
        { seq: 2, ts: 3, actor: "mica", verb: "comp", args: { id: "f78c7ab8", type: "particles", data: { preset: "fire", seed: 781526, origin: [0, 0.18, 0], count: 150, quality: "auto", glow: true } } }];
      const r = TV1.translate(L); const ents = r.final?.translated ?? {}; const c = Object.values<any>(ents).find((x) => x.particles) ?? {};
      return { tr: TV1.TRANSLATOR, p: c.particles, imp: c["imported:particles"], back: PE.instanceOf?.({ preset: "fire", seed: 781526, origin: [0, 0.18, 0], count: 150, quality: "auto" }) }; },
    good: (o) => /@9$/.test(o.tr) && JSON.stringify(o.p) === JSON.stringify({ effect: "fire", seed: 781526, at: [0, 0.18, 0], params: { count: 150, quality: "auto" } }) && o.imp?.glow === true && JSON.stringify(o.back) === JSON.stringify(o.p) },
  { id: "X11", what: "look says what an emitter is doing: emitting fire; can emit smoke (stopped) when playing is off", run(s) { cast(s);
      thing(s, "a", { particles: { effect: "fire" } }); thing(s, "b", { particles: { effect: "smoke", playing: false } });
      return { a: lookOf(s, "a")?.state, b: lookOf(s, "b")?.state }; },
    good: (o) => o.a?.includes("emitting fire") && o.b?.includes("can emit smoke (stopped)") },

  // ---------------- G: the simulation (Godot's modules) ----------------
  { id: "G1", what: "preprocess: a steady effect is in flight on its first frame (Godot's pre_process_time)", run() { const s = PS.makeSim(em({ spawn: { amount: 64, lifetime: 1, preprocess: 1 }, velocity: { speed: [1, 1] } }), { seed: 3 }); s.step(0); return { n: alive(s).length }; },
    good: (o) => o.n >= 60 },
  { id: "G2", what: "explosiveness 1: every particle is born in the same instant (all the same age)", run() { const s = run(em({ spawn: { amount: 32, lifetime: 2, explosiveness: 1 } }), 0.5); const ys = alive(s).map((i) => s.size[i]); return { n: alive(s).length, f: [...new Set(alive(s).map((i) => Math.round(s.color[i * 4 + 3] * 1000)))].length }; },
    good: (o) => o.n === 32 && o.f === 1 },
  { id: "G3", what: "oneShot: one cycle, then nothing is born and the living finish", run() { const s = run(em({ spawn: { amount: 16, lifetime: 0.5, oneShot: true } }), 1.5); return { n: alive(s).length, emitting: s.emitting }; },
    good: (o) => o.n === 0 && o.emitting === false },
  { id: "G4", what: "damping takes speed to zero and never past it (Godot: v -= damp·dt, clamped)", run() { const s = run(em({ velocity: { direction: [1, 0, 0], spread: 0, speed: [5, 5] }, forces: { gravity: [0, 0, 0], damping: [100, 100] }, spawn: { amount: 8, lifetime: 2 } }), 0.6);
      return { v: alive(s).map((i) => Math.hypot(s.vel[i * 3], s.vel[i * 3 + 1], s.vel[i * 3 + 2])) }; },
    good: (o) => o.v.length > 0 && o.v.every((x: number) => x === 0) },
  { id: "G5", what: "gravity integrates (a dropped particle falls about ½gt²), and a cone's spread holds its directions within the angle", run() {
      const s = run(em({ spawn: { amount: 1, lifetime: 5 }, forces: { gravity: [0, -9.8, 0] } }), 1);
      const c = run(em({ spawn: { amount: 200, lifetime: 5, explosiveness: 1 }, velocity: { direction: [0, 1, 0], spread: 10, speed: [1, 1] }, forces: { gravity: [0, 0, 0] } }), 0.05);
      const off = alive(c).map((i) => Math.acos(Math.min(1, c.vel[i * 3 + 1] / Math.hypot(c.vel[i * 3], c.vel[i * 3 + 1], c.vel[i * 3 + 2]))) * 180 / Math.PI);
      return { y: s.pos[1], max: Math.max(...off) }; },
    good: (o) => o.y < -4.2 && o.y > -5.6 && o.max <= 14.2 },
  { id: "G6", what: "shapes: a box's points are inside its extents, a sphere's inside its ellipsoid, a ring's at its radius", run() {
      const box = run(em({ spawn: { amount: 200, lifetime: 9, explosiveness: 1 }, shape: { type: "box", extents: [1, 0.1, 2] }, forces: { gravity: [0, 0, 0] } }), 0.02);
      const sph = run(em({ spawn: { amount: 200, lifetime: 9, explosiveness: 1 }, shape: { type: "sphere", extents: [2, 0.5, 2] }, forces: { gravity: [0, 0, 0] } }), 0.02);
      const ring = run(em({ spawn: { amount: 200, lifetime: 9, explosiveness: 1 }, shape: { type: "ring", radius: 1, inner: 1, height: 0, axis: [0, 1, 0] }, forces: { gravity: [0, 0, 0] } }), 0.02);
      const P = (s: any, i: number) => [s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]];
      return { box: alive(box).every((i) => { const [x, y, z] = P(box, i); return Math.abs(x) <= 1 && Math.abs(y) <= 0.1 && Math.abs(z) <= 2; }),
        sph: alive(sph).every((i) => { const [x, y, z] = P(sph, i); return (x / 2) ** 2 + (y / 0.5) ** 2 + (z / 2) ** 2 <= 1.0001; }),
        ring: alive(ring).every((i) => { const [x, y, z] = P(ring, i); return Math.abs(Math.hypot(x, z) - 1) < 1e-3 && Math.abs(y) < 1e-6; }), n: alive(ring).length }; },
    good: (o) => o.box && o.sph && o.ring && o.n === 200 },
  { id: "G7", what: "playing off (Godot's emitting): the living finish, none are born; on again, it emits", run() { const e = em({ spawn: { amount: 32, lifetime: 0.5, preprocess: 0.5 } }); const s = PS.makeSim(e, { seed: 2 });
      for (let i = 0; i < 30; i++) s.step(1 / 60); const before = alive(s).length; s.setEmitting(false); for (let i = 0; i < 60; i++) s.step(1 / 60); const off = alive(s).length;
      s.setEmitting(true); for (let i = 0; i < 40; i++) s.step(1 / 60); return { before, off, on: alive(s).length }; },
    good: (o) => o.before > 20 && o.off === 0 && o.on > 10 },
  { id: "G8", what: "the same seed is the same effect on two machines; another seed is another", run() { const e = em({ velocity: { spread: 180, speed: [0, 2] } });
      const a = run(e, 0.7, 11), b = run(e, 0.7, 11), c = run(e, 0.7, 12); return { same: a.pos.join() === b.pos.join(), diff: a.pos.join() !== c.pos.join() }; },
    good: (o) => o.same && o.diff },
];

const only = opt("only")?.split(",") ?? null;
let bad = 0;
for (const c of cases) {
  if (only && !only.includes(c.id)) continue;
  let o: any, g = false; try { o = c.run(session()); g = !!c.good(o); } catch (e) { o = { threw: String(e?.message ?? e).slice(0, 200) }; }
  if (!g) bad++;
  console.log(`${g ? "ok  " : "FAIL"} ${c.id} ${c.what}${g ? "" : `\n     ${JSON.stringify(o).slice(0, 400)}`}`);
}
console.log(`[describe-particles-check] ${cases.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
