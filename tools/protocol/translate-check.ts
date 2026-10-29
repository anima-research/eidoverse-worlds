// tools/protocol/translate-check.ts — the owner's translation rulings of 10-28 (MORNING-ASKS; SWEEP-3), one row each. Synthetic only.
//   R22a-e  main's effective rights written out: owned (no '*' → builder, guests too; '*' gen; '*' visitor; '*' none), ownerless
//   P17a-f  main's particle knobs → a derived effect document stored in the world; what has no reading carried and listed
//   B24a-f  name-only global bans: bound to main's one account at boot (warned: check it), else kept pending, listed, never
//           enforced, liftable; a malformed record is refused and kept on disk
//   F50     the report says what becomes of vehicle minY/maxY/probes and water speed; sky audio is no longer carried
//   V5      the translator is @28, and a report reviewed under @27 is refused, naming the earlier translator
//   V6      the report's output digest: what would be written changed since the dry run (same counts) → refused, re-run the dry run
//   S3-*    SWEEP-3: collide, seatAnchor, ranges, CSS colours, particle scale, pivot on a scaled thing, grass extras; light parity;
//           sky audio onto @world.sky.audio (SA); a light with no intensity brightened once, landing on the registry default (LD)
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/translate-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import * as TV1 from "./import-v1/translate-v1.js";
import { reportV1World } from "./import-v1/world.ts";
import * as PE from "../../shared/particle_effects.js";
import * as R from "../../shared/protocol/roles.js";
import { sha256 } from "../../shared/protocol/hash.js";
import { COMPONENTS } from "../../shared/protocol/componentspec.js";

let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 900)}` : ""}`); } };
const row = (what: string, fn: () => any) => { try { return fn(); } catch (e) { ok(false, what, `threw: ${e?.stack ?? e}`); } };
const T0 = 1790000000000;
const log = (L: [string, string, any][]) => [{ seq: 0, ts: T0, actor: "world", verb: "genesis", args: { v: 1, dialect: "eidoverse-log" } },
  ...L.map(([actor, verb, args], k) => ({ seq: k + 1, ts: T0 + (k + 1) * 1000, actor, verb, args }))];
const tr = (L: [string, string, any][]) => { const r = TV1.translate(log(L)); return { r, W: r.final.translated["@world"] ?? {}, E: r.final.translated }; };
const eff = (W: any, id: string, anon = false) => R.effectiveOf(W, id, { anon, owners: Object.keys(W).some((k) => k.startsWith("roles:") && W[k]?.role === "owner") });
const OWNER: [string, string, any] = ["world", "grant", { id: "olga", role: "owner" }];

// ================= R22: main's effective rights, written out =================
row("R22a", () => { const { r, W } = tr([OWNER]); const n = eff(W, "newcomer"), g = eff(W, "guest", true);
  ok(r.stats.divergences === 0 && n.role === "builder" && n.can.build && !n.can.generate && g.role === "builder" && g.can.build && !g.can.fly,
    "R22a an owned world with no '*': newcomers and guests build, as main's default (builder, no gen, no fly)", { n, g, dr: W["default-role"] }); });
row("R22b", () => { const { r, W } = tr([OWNER, ["olga", "grant", { id: "*", gen: true }]]); const n = eff(W, "newcomer"), g = eff(W, "guest", true);
  ok(r.stats.divergences === 0 && n.role === "builder" && n.can.generate && g.role === "builder" && !g.can.generate && r.stats.rights.notes.some((x) => /guests .*generate/.test(x)),
    "R22b '*' +gen: newcomers build and generate; guests build, and the report says generate can't reach them", { n: n.can, g: g.can, notes: r.stats.rights.notes }); });
row("R22c", () => { const { W } = tr([OWNER, ["olga", "grant", { id: "*", role: "visitor" }]]); const n = eff(W, "newcomer"), g = eff(W, "guest", true);
  ok(n.role === "member" && !n.can.build && g.role === "member", "R22c '*' visitor: newcomers and guests are members (no building), as main", { n, g }); });
row("R22d", () => { const { W } = tr([OWNER, ["olga", "grant", { id: "*", role: "none" }]]);
  ok(W.access?.join === "listed" && W["role-defs"] === undefined, "R22d an owned world's '*' none still closes it (access listed)", { access: W.access }); });
row("R22e", () => { const { r, W } = tr([["ann", "spawn", { id: "c", lib: "x.glb" }], ["world", "grant", { id: "*", role: "none" }]]);
  const a = eff(W, "ann"), g = eff(W, "guest", true);
  ok(r.stats.divergences === 0 && a.role === "member" && a.can.build && a.can.editOthers && a.can.generate && !a.can.fly && g.can.build && g.can.generate && W.access === undefined
    && r.stats.rights.owned === false && r.stats.rights.notes.some((x) => /Rank stays member/.test(x)) && r.stats.rights.notes.some((x) => /ignored '\*' none/.test(x)),
    "R22e an ownerless world: everyone, guests too, builds and generates (member's role-defs, under roles.js's cap), never flies; its '*' none is unread, as main; the report names the rank it can't give", { a: a.can, g: g.can, access: W.access, notes: r.stats.rights.notes }); });
row("R22f", () => { const { r } = tr([]); const first = r.out.find((e) => e.kind === "change");
  ok(first?.actor === "system" && r.out[first.cause]?.verb === "translated" && JSON.stringify(first.body).includes("role-defs"),
    "R22f an empty old world's open rights are one change by the system, caused by the translated act", first); });

// ================= P17: main's particle knobs → a derived effect =================
const fire = (data: any, id = "hearth") => tr([OWNER, ["olga", "spawn", { id, lib: "x.glb" }], ["olga", "comp", { id, type: "particles", data }]]);
row("P17a", () => { const { r, E } = fire({ preset: "fire", wobble: 0.3, up: 1.2, spread: 0.4, color: "#ff8800", blending: "normal" }); const p = E.hearth?.particles ?? {};
  const doc = r.effects.get(p.effect), e = doc?.emitters?.[0];
  ok(r.stats.divergences === 0 && /^sha256:[0-9a-f]{64}$/.test(p.effect) && PE.effectAddress(doc) === p.effect && PE.effectProblem(doc) === null
    && e.drift.amount === 0.3 && e.velocity.min[1] === +(1.2 - 0.2 * 0.4).toFixed(4) && e.velocity.max[0] === 0.4 && e.color.base === 0xff8800 && e.render.blend === "alpha"
    && p.seed === PE.hashSeed("hearth:fire") && E.hearth["imported:particles"] === undefined,
    "P17a a retuned fire is a derived effect (its address names it): wobble → drift, up/spread → the launch box, colour → base, normal → alpha; main's seed; nothing left in imported:particles", { p, e }); });
row("P17b", () => { const { r, E } = fire({ preset: "fire", gravity: -2, rotate: 2, grow: 1 }); const e = r.effects.get(E.hearth.particles.effect)?.emitters?.[0];
  const flame = PE.ESSENTIALS.fire.emitters[0].size.curve;
  ok(JSON.stringify(e.forces.gravity) === "[0,-2,0]" && JSON.stringify(e.rotation.velocity) === "[-2,2]" && e.size.curve.every(([t, x], i) => Math.abs(x - flame[i][1] * (1 + t)) < 2e-4),
    "P17b gravity a number is [0, g, 0] (the world frame, as every Essential's); rotate rad/s is ±spin; grow on a flame multiplies its curve (1 + grow·t)", { g: e?.forces, r: e?.rotation, c: e?.size?.curve }); });
row("P17c", () => { const { r, E } = fire({ preset: "smoke", wobble: 3, twinkle: 0.5 }); const p = E.hearth.particles, u = r.stats.unmapped?.find((x) => x.component === "particles");
  ok(/^sha256:/.test(p.effect) && r.effects.get(p.effect).emitters[0].flicker.amount === 0.5 && E.hearth["imported:particles"]?.wobble === 3 && u?.fields?.includes("wobble") && /drift limit/.test(u.why),
    "P17c a knob with no faithful reading (a 3 m sway, past the document's 2 m drift) is carried in imported:particles and listed with why; the rest still derives", { p, imp: E.hearth["imported:particles"], u }); });
row("P17d", () => { const { r, E } = fire({ preset: "lava", wobble: 0.2 }); const u = r.stats.unmapped?.find((x) => x.component === "particles");
  ok(E.hearth.particles.effect === "lava" && E.hearth["imported:particles"]?.wobble === 0.2 && /no Essential/.test(u?.why ?? ""), "P17d an unknown preset keeps its knobs carried and listed (main drew nothing)", { p: E.hearth.particles, u }); });
row("P17e", () => { const { r, E } = tr([OWNER, ["olga", "spawn", { id: "h", lib: "x.glb" }], ["olga", "comp", { id: "h", type: "particles:smoke", data: { preset: "smoke", color: "#334455" } }]]);
  const kid = Object.values<any>(E).find((c) => c.label === "smoke"), m = r.stats.mapped?.find((x) => x.component === "particles");
  ok(/^sha256:/.test(kid?.particles?.effect) && m?.emitter === "smoke" && m.effect === kid.particles.effect && JSON.stringify(m.knobs) === '["color"]',
    "P17e a named emitter's knobs derive too, and the report maps it (emitter, effect, knobs)", { kid: kid?.particles, m }); });
row("P17f", () => { const { r, E } = fire({ preset: "fire", scale: 50 }); const a = r.stats.adjusted?.find((x) => x.component === "particles" && x.field === "scale");
  ok(E.hearth.particles.scale === 20 && a?.was === 50 && a.now === 20, "P17f a particle scale past main's 20 is drawn as main drew it (20), listed", { s: E.hearth.particles.scale, a }); });
// through the writer: the derived document is a blob of the world, read back by its address, and resolves
row("P17g", () => { const root = scratch("translate-p17"), W = path.join(root, "worlds"), d = path.join(W, "old"); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "log.jsonl"), log([OWNER, ["olga", "spawn", { id: "hearth", lib: "x.glb" }], ["olga", "comp", { id: "hearth", type: "particles", data: { preset: "embers", up: 2 } }]]).map((e) => JSON.stringify(e)).join("\n") + "\n");
  const out = Bun.spawnSync(["bun", "-e", `import { translateV1World } from "./tools/protocol/import-v1/world.ts"; const r = translateV1World(${JSON.stringify(d)}, ${JSON.stringify(path.join(W, "new"))}); console.log("R " + JSON.stringify(r.effects));`],
    { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(root, "opt"), BACKUPS_DIR: "", TRUST_NAMES: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const said = out.stdout.toString() + out.stderr.toString(), effects = JSON.parse(said.split("\n").find((l) => l.startsWith("R "))?.slice(2) ?? "[]");
  const f = effects[0] && path.join(W, "new", "blobs", `${effects[0].replace(/[^a-z0-9]/g, "-")}.json`);
  const bytes = f && fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null, doc = bytes ? JSON.parse(bytes) : null;
  const res = doc && PE.resolveParticles({ effect: effects[0] }, { entityId: "hearth", lookup: (b) => (b === effects[0] ? doc : null) });
  ok(effects.length === 1 && bytes && `sha256:${sha256(bytes)}` === effects[0] && res?.ok && res.emitters.length === 1,
    "P17g the writer stores each derived effect in the world (blobs/, by its content address), and a reader resolves it", { said: said.slice(-600), effects, res: res?.why }); });

// in place: the blobs/ the translation made are in its manifest, and a rollback removes them (the world byte-identical again)
row("P17h", () => { const root = scratch("translate-p17h"), W = path.join(root, "worlds"), d = path.join(W, "den"); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "log.jsonl"), log([OWNER, ["olga", "spawn", { id: "hearth", lib: "x.glb" }], ["olga", "comp", { id: "hearth", type: "particles", data: { preset: "fire", wobble: 0.2 } }]]).map((e) => JSON.stringify(e)).join("\n") + "\n");
  const env = { ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(root, "opt"), BACKUPS_DIR: path.join(root, "backups"), TRUST_NAMES: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  const cli = (...a: string[]) => { const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", ...a], { cwd: ENGINE, env }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  const before = fs.readdirSync(d).sort();
  const dry = cli("translate", "--dry-run", "--no-founder-key", "--json", "--", "den"), hash = /report-json (.*)/.exec(dry.out)?.[1] && JSON.parse(/report-json (.*)/.exec(dry.out)![1]).hash;
  const up = cli("translate", "--no-founder-key", "--operator-only-no-owner", "--approved", hash ?? "x", "--", "den");
  const made = JSON.parse(fs.readFileSync(path.join(d, "translation.json"), "utf8")).made, blobs = fs.existsSync(path.join(d, "blobs")) ? fs.readdirSync(path.join(d, "blobs")) : [];
  const back = cli("rollback", "den");
  ok(up.code === 0 && blobs.length === 1 && typeof made.blobs === "string" && back.code === 0 && JSON.stringify(fs.readdirSync(d).sort()) === JSON.stringify(before),
    "P17h in place: the derived effect lands in the world's blobs/, the manifest records it, and a rollback removes it", { up: up.out.slice(-300), blobs, made, back: back.out.slice(-300), now: fs.readdirSync(d) }); });

// ================= B24: name-only global bans, the Minecraft migration =================
const MOD = path.join(ENGINE, "server", "moderation.ts");
row("B24a", () => { const M = require(MOD); const known = (n: string) => (n.toLowerCase() === "griefer" ? { subs: ["human:test:g1"], from: [".principals.json"] } : n === "twin" ? { subs: ["human:test:t1", "human:test:t2"], from: [".principals.json", "garden's log"] } : null);
  const pending: any = {}; const out = M.restoreBans({ griefer: { by: "op", ts: T0, name: "Griefer" }, twin: { by: "op", ts: T0, name: "twin" }, ghost: { by: "op", ts: T0, name: "ghost" } }, {}, { known, pending });
  const hit = M.findBan(out, "human:test:g1"), namesake = M.findBan(out, "human:test:other"), t = M.findBan(out, "human:test:t1") ?? M.findBan(out, "human:test:t2");
  ok(hit?.boundFrom === "main's .principals.json" && !namesake && !t && pending.twin && /2 accounts/.test(pending.twin.why) && pending.ghost && /no account/.test(pending.ghost.why),
    "B24a a name-only ban binds to the one account main recorded for the name (and no namesake); two accounts, or none, keep it pending, why said", { out, pending }); });
row("B24b", () => { const M = require(MOD); const pending: any = { twin: { by: "op", ts: T0, name: "Twin", why: "main recorded 2 accounts under this name" } };
  const text = M.globalBansText({}, pending); const lifted = M.takePending("twin", (s: string) => s.toLowerCase(), pending);
  ok(/pre-account bans, not enforced \(1\)/.test(text) && text.includes("pre-account ban: bind to a person") && text.includes("Twin") && lifted.length === 1 && !Object.keys(pending).length,
    "B24b the operators' ban list shows a pending one ('pre-account ban: bind to a person or lift'), and an unban by its name lifts it", { text, lifted }); });
row("B24c", () => { const root = scratch("translate-b24"), W = path.join(root, "worlds"); fs.mkdirSync(path.join(W, "garden"), { recursive: true });
  fs.writeFileSync(path.join(W, ".principals.json"), JSON.stringify({ "human:test:g1": { name: "Griefer", kind: "human", first: T0, last: T0 } }));
  fs.writeFileSync(path.join(W, "garden", "log.jsonl"), log([["world", "grant", { id: "twin", role: "builder", sub: "human:test:t1" }]]).map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(path.join(W, ".principals.json"), JSON.stringify({ "human:test:g1": { name: "Griefer", kind: "human", first: T0, last: T0 }, "human:test:t2": { name: "twin", kind: "human", first: T0, last: T0 } }));
  fs.writeFileSync(path.join(W, ".bans.json"), JSON.stringify({ griefer: { by: "op", ts: T0, name: "griefer", reason: "spam" }, twin: { by: "op", ts: T0, name: "twin" } }));
  const r = Bun.spawnSync(["bun", "-e", `const M = await import(${JSON.stringify(MOD)}); console.log("G " + JSON.stringify(Object.keys(M.globalBans)) + " P " + JSON.stringify(Object.keys(M.pendingBans)));`],
    { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: W, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const said = r.stdout.toString() + r.stderr.toString(), disk = JSON.parse(fs.readFileSync(path.join(W, ".bans.json"), "utf8"));
  ok(/G \["acct:human:test:g1"\] P \["twin"\]/.test(said) && /1 pre-account global ban\(s\) bound/.test(said) && /pre-account global ban\(s\): bind to a person/.test(said)
    && disk["acct:human:test:g1"]?.reason === "spam" && disk.twin && !disk.griefer,
    "B24c at boot: main's .principals.json and another world's log bind 'griefer' to its account (written back, reason kept); 'twin' (two accounts) stays on disk, pending, said in the boot log", { said: said.slice(-700), disk }); });
row("B24e", () => { const root = scratch("translate-b24e"), W = path.join(root, "worlds"); fs.mkdirSync(W, { recursive: true });
  fs.writeFileSync(path.join(W, ".bans.json"), JSON.stringify({ odd: { by: 7, ts: T0, name: "Odd" }, junk: "x", "acct:human:test:z": { by: "op", ts: T0, account: "human:test:z" } }));
  const r = Bun.spawnSync(["bun", "-e", `const M = await import(${JSON.stringify(MOD)}); M.saveGlobalBans(); console.log("G " + JSON.stringify(Object.keys(M.globalBans)));`],
    { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: W, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const said = r.stdout.toString() + r.stderr.toString(), disk = JSON.parse(fs.readFileSync(path.join(W, ".bans.json"), "utf8"));
  ok(/G \["acct:human:test:z"\]/.test(said) && disk.odd?.by === 7 && disk.junk === "x" && /2 global ban\(s\) refused \(malformed/.test(said),
    "B24e a malformed ban record (no string by, not an object) is refused, said at boot, and still on disk after a save (never dropped)", { said: said.slice(-400), disk }); });
row("B24f", () => { const M = require(MOD); const known = (n: string) => (n === "griefer" ? { subs: ["human:test:g1"], from: [".principals.json"] } : null);
  const log0 = console.log; const lines: string[] = []; console.log = (...a: any[]) => lines.push(a.join(" "));
  let out: any; try { out = M.restoreBans({ griefer: { by: "op", ts: T0, name: "griefer" } }, {}, { known, pending: {} }); } finally { console.log = log0; }
  const text = M.globalBansText(out, {});
  ok(lines.some((l) => /WARNING 1 pre-account global ban\(s\) bound .*check it: the name was typed, so a guest who wore it may have been someone else/.test(l)) && /griefer \(human:test:g1\).*check it/.test(text),
    "B24f a ban bound by name alone is never silent: the boot line is a WARNING saying check it (a guest namesake was someone else), and the operators' list marks it", { lines, text }); });
row("B24d", () => { const src = fs.readFileSync(MOD, "utf8");
  ok(!/name-only global ban\(s\) from before accounts dropped/.test(src), "B24d no name-only ban is dropped at boot any more"); });

// ================= F50: the report says what becomes of carried fields =================
row("F50", () => { const { r } = tr([OWNER, ["olga", "spawn", { id: "boat", lib: "b.glb" }], ["olga", "comp", { id: "boat", type: "vehicle", data: { helm: [0, 1, 0], speed: 3, minY: 0, maxY: 9, probes: 4 } }],
    ["olga", "spawn", { id: "pool", lib: "p.glb" }], ["olga", "comp", { id: "pool", type: "water", data: { center: [0, 0, 0], size: [4, 2, 4], speed: 2.4 } }], ["olga", "sky", { world: "earth", audio: true }]]);
  const v = r.stats.unmapped?.find((x) => x.component === "vehicle"), w = r.stats.unmapped?.find((x) => x.component === "water"), s = r.stats.unmapped?.find((x) => x.component === "sky");
  ok(/invisible wall below/.test(v?.becomes?.minY) && /invisible wall above/.test(v?.becomes?.maxY) && /retired: the authority's hull sweep/.test(v?.becomes?.probes)
    && /physics-area/.test(w?.becomes?.speed) && s === undefined && !("sky.audio" in TV1.FATES),
    "F50 the report says, in words, what becomes of vehicle minY/maxY/probes and water speed; sky audio is mapped, not carried (@25)", { v, w, s }); });

// ================= V5: the version, and a stale review refused =================
row("V5", () => { const root = scratch("translate-v5"), W = path.join(root, "worlds"), d = path.join(W, "den"); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "log.jsonl"), log([OWNER]).map((e) => JSON.stringify(e)).join("\n") + "\n");
  const env = { ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(root, "opt"), BACKUPS_DIR: path.join(root, "backups"), TRUST_NAMES: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  const rep = Bun.spawnSync(["bun", "-e", `import { reportV1World } from "./tools/protocol/import-v1/world.ts"; import { sha256 } from "./shared/protocol/hash.js"; const { report } = reportV1World(${JSON.stringify(d)}); console.log("H " + sha256(JSON.stringify({ ...report, translator: "eidoverse/translate-v1@27" })));`], { cwd: ENGINE, env });
  const old = /H ([0-9a-f]{64})/.exec(rep.stdout.toString())?.[1];
  const up = Bun.spawnSync(["bun", "tools/protocol/world.ts", "translate", "--no-founder-key", "--operator-only-no-owner", "--approved", old ?? "x", "--", "den"], { cwd: ENGINE, env });
  const said = up.stdout.toString() + up.stderr.toString();
  ok(TV1.translatorVersion(TV1.TRANSLATOR) === 28 && TV1.translatorVersion(TV1.TRANSLATOR_SIM) === 28 && old && up.exitCode !== 0 && /is not the one that was approved/.test(said) && /earlier translator than eidoverse\/translate-v1@28/.test(said) && fs.existsSync(path.join(d, "log.jsonl")) && !fs.existsSync(path.join(d, "world.jsonl")),
    "V5 the translator is @28; a report reviewed under @27 is refused, saying an earlier translator's review never approves this one, and nothing moves", { v: TV1.TRANSLATOR, said: said.slice(-500) }); });

row("V6", () => { const root = scratch("translate-v6"), W = path.join(root, "worlds"), d = path.join(W, "den"), opt = path.join(root, "opt"); fs.mkdirSync(d, { recursive: true }); fs.mkdirSync(path.join(opt, "store"), { recursive: true });
  fs.writeFileSync(path.join(d, "log.jsonl"), log([OWNER, ["olga", "spawn", { id: "boat", lib: "store/boat.glb" }]]).map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(path.join(opt, "store", "boat.glb"), "the model the owner reviewed");
  const env = { ...process.env, WORLDS_DIR: W, OPT_DIR: opt, BACKUPS_DIR: path.join(root, "backups"), TRUST_NAMES: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  const run = (a: string[]) => { const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", ...a], { cwd: ENGINE, env }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  const dry = run(["translate", "--dry-run", "--no-founder-key", "--", "den"]), hash = /^report-hash ([0-9a-f]{64})$/m.exec(dry.out)?.[1] ?? "x";
  fs.writeFileSync(path.join(opt, "store", "boat.glb"), "other bytes, the same count");   // the output changes, the report's counts don't
  const up = run(["translate", "--no-founder-key", "--operator-only-no-owner", "--approved", hash, "--", "den"]);
  ok(/"output": "sha256:[0-9a-f]{64}"/.test(dry.out) && up.code !== 0 && /is not the one that was approved/.test(up.out) && /output digest/.test(up.out) && /Run --dry-run again/.test(up.out) && !fs.existsSync(path.join(d, "world.jsonl")),
    "V6 the approved report pins the output (its digest): model bytes changed between the dry run and the apply (same counts) refuse it, saying run the dry run again; nothing written", { code: up.code, out: up.out.slice(-500) }); });

// ================= SWEEP-3: the rest of main's meaning =================
row("S3-T1", () => { const { E } = tr([OWNER, ["olga", "spawn", { id: "a", lib: "x.glb", collide: "exact" }], ["olga", "spawn", { id: "b", lib: "x.glb", collide: "box" }], ["olga", "spawn", { id: "c", lib: "x.glb", collide: "boxy" }]]);
  ok(E.a.collider?.shape === "mesh" && E.b.collider?.shape === "box" && E.c.collider === undefined && E.c["imported:collide"] === "boxy", "S3-T1 main's spawn collide: exact → collider mesh, box → box; anything else carried", { a: E.a.collider, b: E.b.collider, c: E.c }); });
row("S3-T2", () => { const { E } = tr([OWNER, ["olga", "spawn", { id: "s", lib: "x.glb" }], ["olga", "comp", { id: "s", type: "sockets", data: { a: { pos: [0, 0.5, 0], seatAnchor: "surface" }, b: { pos: [1, 0.5, 0], seatAnchor: "hips" } } }]]);
  const S = E.s.sockets ?? {}, kids = Object.values<any>(E).filter((c) => c.socket);
  const body = (n: string) => S[n]?.body ?? kids.find((k) => k.socket?.name === n)?.station;
  ok(body("a")?.anchor === "surface" && body("b")?.anchor !== "surface" && E.s["imported:sockets"]?.b?.seatAnchor === "hips", "S3-T2 a socket's seatAnchor surface is its body's anchor; any other value (main read it as root) is carried", { S, imp: E.s["imported:sockets"] }); });
row("S3-X1", () => { const pts = Array.from({ length: 70 }, (_, i) => [i, 0, 0]);
  const { r, E } = tr([OWNER, ["olga", "spawn", { id: "m", lib: "x.glb", scale: 5000 }], ["olga", "comp", { id: "m", type: "sound", data: { src: "store/audio/a.ogg", radius: 250 } }],
    ["olga", "comp", { id: "m", type: "motion", data: { type: "path", points: pts, speed: 1 } }], ["olga", "light", { id: "l", range: 0, intensity: 4 }]]);
  const A = (id: string, c: string, f: string) => r.stats.adjusted?.find((x) => x.id === id && x.component === c && x.field === f);
  ok(E.m.sound.radius === 200 && E.m.motion.points.length === 64 && JSON.stringify(E.m.motion.points[63]) === "[69,0,0]" && E.m.transform.scale[0] === 1000 && E.l.light.range === undefined
    && A("m", "sound", "radius")?.now === 200 && A("m", "motion", "points") && A("m", "transform", "scale") && A("l", "light", "range"),
    "S3-X1 values outside the registry's ranges are brought inside (sound radius 250 → 200, a 70-point path → 64, scale 5000 → 1000, light range 0 → its default) and each is listed", { s: E.m.sound, n: E.m.motion.points.length, t: E.m.transform.scale, l: E.l.light, adj: r.stats.adjusted }); });
row("S3-L2", () => { const { E } = tr([OWNER, ["olga", "light", { id: "l", color: "Red" }], ["olga", "light", { id: "k", color: "rebeccapurple" }]]);
  ok(E.l.light.color === 0xff0000 && E.k.light.color === 0x663399, "S3-L2 a light's CSS colour name is its colour, as three.js read it", { l: E.l.light.color, k: E.k.light.color }); });
row("S3-M1", () => { const { r, E } = tr([OWNER, ["olga", "spawn", { id: "bell", lib: "x.glb", scale: 2 }], ["olga", "comp", { id: "bell", type: "motion", data: { type: "pendulum", amp: 0.3, pivot: [0, 3, 0] } }]]);
  ok(JSON.stringify(E.bell.pivot?.pos) === "[0,1.5,0]" && r.stats.adjusted?.some((x) => x.component === "pivot"), "S3-M1 a pivot on a scaled thing is divided by its scale (main's was unscaled, today's scales), listed", { pv: E.bell.pivot }); });
row("S3-G1", () => { const { r, W } = tr([OWNER, ["olga", "grass", { species: "grass", width: 20, depth: 20, maxSlope: 0.4, windDir: [1, 0], variant: "dry", footprint: "tuft" }]]);
  const st = W.grass?.strokes?.[0], m = r.stats.mapped?.find((x) => x.component === "grass");
  ok(st?.maxSlope === 0.4 && JSON.stringify(st.windDir) === "[1,0]" && st.variant === "dry" && st.footprint === "tuft" && W["imported:grass"] === undefined && m?.fields?.includes("maxSlope"),
    "S3-G1 main's createFlora extras (maxSlope, windDir, variant, footprint…) ride in the field's one stroke, which hands them to createFlora as main did; the report lists them", { g: W.grass, m }); });
row("S3-RP", () => { const root = scratch("translate-rp"), d = path.join(root, "worlds", "den"); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "log.jsonl"), log([OWNER, ["olga", "light", { id: "l", intensity: 16 }], ["olga", "spawn", { id: "h", lib: "x.glb" }], ["olga", "comp", { id: "h", type: "particles", data: { preset: "fire", up: 1 } }]]).map((e) => JSON.stringify(e)).join("\n") + "\n");
  const { report } = reportV1World(d);
  ok(report.adjusted?.some((x) => x.component === "light") && report.effects?.length === 1 && report.rights?.newcomers === "builder" && report.mapped?.some((x) => x.component === "particles"),
    "S3-RP the dry-run report (what the operator approves) carries the adjustments, the derived effects, the rights and the particle mapping", { keys: Object.keys(report) }); });
row("S3-LP", () => { const { r, E } = tr([OWNER, ["olga", "light", { id: "l", intensity: 16, range: 10 }], ["olga", "light", { id: "k", intensity: 4, range: 2 }]]);
  ok(E.l.light.decay === 2 && E.l.light.intensity === +(16 * 5 ** 0.3).toPrecision(4) && E.k.light.intensity === 4 && r.stats.adjusted?.some((x) => x.id === "l" && x.field === "intensity" && /half its range/.test(x.why)),
    "S3-LP a translated light falls off at decay 2 and is brightened once to main's brightness at half its range (× (range/2)^0.3), listed", { l: E.l.light, k: E.k.light }); });

row("S3-SA", () => { const { r, W } = tr([OWNER, ["olga", "sky", { world: "earth", audio: true }]]), b = tr([OWNER, ["olga", "sky", { world: "earth", audio: 1 }]]).W;
  ok(W.sky?.audio === true && b.sky?.audio === true && W["imported:sky"] === undefined && !r.stats.unmapped?.some((x) => x.component === "sky") && COMPONENTS.sky.fields.audio === "bool",
    "S3-SA main's sky.audio (rain and thunder) is @world.sky.audio, as makeSky read it (Boolean); nothing carried", { sky: W.sky, b: b.sky, imp: W["imported:sky"] }); });
row("S3-LD", () => { const { E } = tr([OWNER, ["olga", "spawn", { id: "lamp", lib: "x.glb" }], ["olga", "comp", { id: "lamp", type: "light", data: { color: 0xffd9a0 } }]]);
  ok(E.lamp.light?.decay === 2 && E.lamp.light.intensity === COMPONENTS.light.defaults.intensity && E.lamp.light.intensity === TV1.parityIntensity(16, 10),
    "S3-LD a main light with no intensity is main's 16 brightened once (never the registry default brightened again): a new default light's intensity", { l: E.lamp.light, d: COMPONENTS.light.defaults.intensity }); });

console.log(`[translate-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
