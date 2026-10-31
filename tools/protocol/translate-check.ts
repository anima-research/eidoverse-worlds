// tools/protocol/translate-check.ts — the owner's translation rulings of 10-28 (MORNING-ASKS; SWEEP-3), one row each. Synthetic only.
//   R22a-h  main's effective rights written out: owned (no '*' → builder, guests too; '*' gen; '*' visitor; '*' none), ownerless
//           (everyone builder, rank and all; the cap at builder)
//   W1a-c   #260 item 1: a person's own watch grant (closed or open old world) is refused by name, never dropped or widened
//   W1d     @36: a person's own role none in an owned world is a ban (its end kept) in the moderator log: still kept out
//   P17a-f  main's particle knobs → a derived effect document stored in the world; what has no reading carried and listed
//   B24a-f  name-only global bans: bound to main's one account at boot (warned: check it), else kept pending, listed, never
//           enforced, liftable; a malformed record is refused and kept on disk
//   F50     the report says what becomes of vehicle minY/maxY/probes and water speed; sky audio is carried as sky.audio
//   F50b    the vehicle walls are pinned at [0, y, 0], spanning every legal x/z: a v1 move re-places nothing
//   F50c    the vehicle walls are locked (builder strength), and the report says so
//   F51     @37: main's slow water is physics-area {kind: speed, modes: [swim]} on the water's zone; no drag field anywhere
//   F52-53  @31: main's 78 m stage a bounds box; its inferred lamps light children
//   DT8     @34 (decision table row 8): main's ambient motes' count, range and colour in a derived dust document
//   DT9     @33 (decision table row 9): a seat with no pos sits at main's [0, 0.5, 0]
//   V5      the translator is @37, and a report reviewed under @36 is refused, naming the earlier translator
//   V6      the report's output digest: what would be written changed since the dry run (same counts) → refused, re-run the dry run
//   V7      a vehicle hull this host measures: the CLI's dry run → --approved applies (review delta-260 #1), walls set off by its box
//   S3-*    SWEEP-3: collide, seatAnchor, ranges, CSS colours, particle scale, pivot on a scaled thing, grass extras; light parity;
//           sky audio onto @world.sky.audio (SA); a light with no intensity brightened once, landing on the registry default (LD)
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/translate-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import * as TV1 from "./import-v1/translate-v1.js";
import { reportV1World } from "./import-v1/world.ts";
import * as LAMPS from "./import-v1/lamps.ts";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import * as PE from "../../shared/particle_effects.js";
import * as R from "../../shared/protocol/roles.js";
import { sha256 } from "../../shared/protocol/hash.js";
import { COMPONENTS } from "../../shared/protocol/componentspec.js";
import * as ACC from "../../shared/protocol/access.js";
import * as FOLD1 from "./import-v1/fold.js";
import * as RIGHTS from "../../shared/protocol/authority/rights.js";

let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 900)}` : ""}`); } };
const row = (what: string, fn: () => any) => { try { return fn(); } catch (e) { ok(false, what, `threw: ${e?.stack ?? e}`); } };
const T0 = 1790000000000;
const log = (L: [string, string, any][]) => [{ seq: 0, ts: T0, actor: "world", verb: "genesis", args: { v: 1, dialect: "eidoverse-log" } },
  ...L.map(([actor, verb, args], k) => ({ seq: k + 1, ts: T0 + (k + 1) * 1000, actor, verb, args }))];
const tr = (L: [string, string, any][]) => { const r = TV1.translate(log(L)); return { r, W: r.final.translated["@world"] ?? {}, E: r.final.translated }; };
const eff = (W: any, id: string, anon = false) => R.effectiveOf(W, id, { anon, owners: Object.keys(W).some((k) => k.startsWith("roles:") && W[k]?.role === "owner") });
const OWNER: [string, string, any] = ["world", "grant", { id: "olga", role: "owner" }];
/** An ownerless translation as the upgrade leaves it: its upgrader claims it (world.ts translate --claim), so it has an owner (LEGACY-PINS item 9). */
const claimed = (W: any) => ({ ...W, "roles:u-upgrader0000000000000": { role: "owner" } });

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
  const a = eff(claimed(W), "ann"), g = eff(claimed(W), "guest", true);
  ok(r.stats.divergences === 0 && a.role === "builder" && a.rank === R.RANK.builder && g.role === "builder" && ["build", "editOthers", "generate"].every((k) => a.can[k] && g.can[k]) && !a.can.fly && !g.can.fly && W.access === undefined
    && JSON.stringify(W["default-role"]) === JSON.stringify({ role: "builder", guests: "builder" }) && W["role-defs"]?.builder?.can?.generate === true && W["role-defs"]?.member === undefined
    && r.stats.rights.owned === false && r.stats.rights.newcomers === "builder" && r.stats.rights.guests === "builder" && !r.stats.rights.notes.some((x) => /Rank stays member/.test(x)) && r.stats.rights.notes.some((x) => /ignored '\*' none/.test(x)) && !("imported:ownerless" in W),
    "R22e an ownerless world, once its upgrader claims it: everyone else, guests too, is builder (rank and all: main let everyone build) and generates, never flies; its '*' none is unread, as main; no imported:ownerless", { a: [a.role, a.can], g: [g.role, g.can], dr: W["default-role"], rd: W["role-defs"], access: W.access, rights: r.stats.rights }); });
row("R22g", () => { const { r, W } = tr([["world", "grant", { id: "vee", role: "visitor" }], ["world", "grant", { id: "mo", role: "moderator" }], ["world", "grant", { id: "*", role: "visitor", fly: true }]]);
  const v = eff(claimed(W), "vee"), m = eff(claimed(W), "mo"), n = eff(claimed(W), "newcomer"), m0 = eff(W, "mo");
  ok(r.stats.divergences === 0 && v.role === "builder" && v.can.build && m.role === W["roles:mo"]?.role && !m.can.ban && m0.role === "member" && n.role === "builder" && !n.can.fly,
    "R22g …a person main named below builder there is builder (main read no grant without an owner), '*' visitor too, once the upgrader owns it; a moderator's grant is written as main read it (no ban); unowned, member caps everyone", { v: v.role, m: [m.role, m.permissions], m0: m0.role, n: [n.role, n.can.fly], roles: Object.keys(W).filter((k) => k.startsWith("roles:")).map((k) => [k, W[k]]) }); });
row("R22h", () => { const wc = (o: any) => ({ "default-role": { role: "builder", guests: "builder" }, ...o }), at = (o: any, id = "x", anon = false) => R.roleIdOf(wc(o), id, { anon });
  const W = TV1.translate(log([])).final.translated["@world"];
  ok(at({ "roles:x": { role: "moderator" } }) === "member" && at({}, "g", true) === "member" && at({ "imported:ownerless": { role: "builder" } }, "y") === "member"
    && at({ "roles:o": { role: "owner" }, "roles:x": { role: "moderator" } }) === "moderator" && at({ "roles:o": { role: "owner" } }, "n") === "builder"
    && !("imported:ownerless" in W) && R.effectiveOf(claimed(W), "n").role === "builder" && R.effectiveOf(W, "n").role === "member",
    "R22h roles.js: a world with no owner caps everyone at member, whatever it carries (an @30 imported:ownerless is inert); an owner lifts the cap; an empty old world's translation, claimed, makes newcomers builder"); });
row("R22f", () => { const { r } = tr([]); const first = r.out.find((e) => e.kind === "change");
  ok(first?.actor === "system" && r.out[first.cause]?.verb === "translated" && JSON.stringify(first.body).includes("role-defs"),
    "R22f an empty old world's open rights are one change by the system, caused by the translated act", first); });

// W1 (#260, Stella item 1): a named watch grant on a closed world has no spelling in the new door: refused, named, never dropped or widened
const v1st = (L: [string, string, any][]) => { const st: any = FOLD1.emptyState(); for (const e of log(L).slice(1)) FOLD1.foldEntry(st, e); return st; };
const BOB = (role: string, more: any = {}): [string, string, any] => ["olga", "grant", { id: "Bob", role, sub: "human:test:bob", ...more }];
const NONE: [string, string, any] = ["olga", "grant", { id: "*", role: "none" }];
row("W1a", () => { const L = [OWNER, NONE, BOB("spectator")], { W } = tr(L), bob = TV1.enc("Bob");
  const vis = tr([OWNER, NONE, BOB("visitor")]).W, star = [OWNER, ["olga", "grant", { id: "*", role: "spectator" }], BOB("spectator")] as any;
  const names = TV1.watchGrants(v1st(L), T0), why = TV1.watchRefusal(names, '"den"');
  ok(v1st(L).roles.Bob?.role === "spectator" && ACC.entryOf(W, { actor: bob }).may === "none" && JSON.stringify(names) === '["Bob"]' && /'Bob'/.test(why) && /visitor/.test(why) && /'\*' spectator/.test(why) && /revoke/.test(why)
    && TV1.watchGrants(v1st([OWNER, NONE, BOB("visitor")]), T0).length === 0 && ACC.entryOf(vis, { actor: bob }).may === "embody"
    && TV1.watchGrants(v1st(star), T0).length === 0 && TV1.watchGrants(v1st([OWNER, NONE, BOB("spectator", { until: T0 - 1 })]), T0).length === 0,
    "W1a '*' none + Bob:spectator: the new door would give Bob none, so the grant is named with the owner's choices; Bob:visitor still embodies; '*' spectator or an ended grant refuses nothing", { names, why, door: ACC.entryOf(W, { actor: bob }) }); });
row("W1c", () => { const L = [OWNER, BOB("spectator")], { W } = tr(L), bob = TV1.enc("Bob"), names = TV1.watchGrants(v1st(L), T0);
  const vis = [OWNER, ["olga", "grant", { id: "*", role: "visitor" }], BOB("spectator")] as any;
  ok(ACC.entryOf(W, { actor: bob }).may === "embody" && JSON.stringify(names) === '["Bob"]' && JSON.stringify(TV1.watchGrants(v1st(vis), T0)) === '["Bob"]'
    && TV1.watchGrants(v1st([OWNER, BOB("visitor")]), T0).length === 0 && TV1.watchGrants(v1st([BOB("spectator")]), T0).length === 0,
    "W1c an owned world with no '*' restriction: Bob:spectator (who main held to watching) would embody after the upgrade, so he is named too; Bob:visitor and an ownerless world refuse nothing", { names, door: ACC.entryOf(W, { actor: bob }) }); });
row("W1d", () => { const U = T0 + 86_400_000, bob = TV1.enc("Bob"), at = (L: any) => tr(L).W;
  const open = at([OWNER, BOB("none", { until: U })]), spec = at([OWNER, ["olga", "grant", { id: "*", role: "spectator" }], BOB("none")]), vis = at([OWNER, BOB("visitor")]), unowned = at([BOB("none")]);
  const root = scratch("translate-w1d"), Wd = path.join(root, "worlds"), d = path.join(Wd, "den"); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "log.jsonl"), log([OWNER, BOB("none", { until: U })]).map((e) => JSON.stringify(e)).join("\n") + "\n");
  const out = Bun.spawnSync(["bun", "-e", `import { translateV1World } from "./tools/protocol/import-v1/world.ts"; translateV1World(${JSON.stringify(d)}, ${JSON.stringify(path.join(Wd, "new"))}); console.log("T ok");`],
    { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: Wd, OPT_DIR: path.join(root, "opt"), BACKUPS_DIR: "", TRUST_NAMES: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const mf = path.join(Wd, "new", "world.mod.jsonl"), mod = fs.existsSync(mf) ? fs.readFileSync(mf, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const ban = mod.find((m) => m.verb === "ban"), w = (t: number) => ({ mod, now: () => t });
  ok(open[`imported-bans:${bob}`]?.until === U && !open[`roles:${bob}`] && spec[`imported-bans:${bob}`] && !vis[`imported-bans:${bob}`] && !unowned[`imported-bans:${bob}`]
    && ban?.until === U && RIGHTS.isBanned(w(U - 1), ban.who) && !RIGHTS.isBanned(w(U), ban.who),
    "W1d an owned world's Bob:none (no '*' restriction, or '*' spectator) is a ban with the grant's end, filed in the moderator log, so the door keeps him out until then; Bob:visitor and an ownerless world (main read no grant) ban no one",
    { open: open[`imported-bans:${bob}`], ban, said: (out.stdout.toString() + out.stderr.toString()).slice(-400) }); });
row("W1b", () => { const root = scratch("translate-w1"), Wd = path.join(root, "worlds"), d = path.join(Wd, "den"); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "log.jsonl"), log([OWNER, NONE, BOB("spectator")]).map((e) => JSON.stringify(e)).join("\n") + "\n");
  const out = Bun.spawnSync(["bun", "-e", `import { reportV1World, translateV1World } from "./tools/protocol/import-v1/world.ts"; const { report } = reportV1World(${JSON.stringify(d)}); console.log("R " + JSON.stringify({ refused: report.refused, watching: report.watching })); try { translateV1World(${JSON.stringify(d)}, ${JSON.stringify(path.join(Wd, "new"))}); console.log("T wrote"); } catch (e) { console.log("T " + JSON.stringify(String(e.message))); }`],
    { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: Wd, OPT_DIR: path.join(root, "opt"), BACKUPS_DIR: "", TRUST_NAMES: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const said = out.stdout.toString() + out.stderr.toString(), rep = JSON.parse(said.split("\n").find((l) => l.startsWith("R "))?.slice(2) ?? "{}"), t = said.split("\n").find((l) => l.startsWith("T ")) ?? "";
  ok(/'Bob'/.test(rep.refused ?? "") && JSON.stringify(rep.watching) === '["Bob"]' && /'Bob'/.test(t) && /Nothing was written/.test(t) && !fs.existsSync(path.join(Wd, "new", "world.jsonl")),
    "W1b the dry-run report refuses naming Bob's watch grant, and the translation refuses before writing anything", { said: said.slice(-800) }); });

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
  const json = JSON.stringify(r.out), walls = (json.match(/"blocks":\["hulls"\]/g) ?? []).length;
  ok(JSON.stringify(v?.fields) === '["probes"]' && /retired: the authority's hull sweep/.test(v?.becomes?.probes) && v?.becomes?.minY === undefined && w === undefined && !("vehicle.minY" in TV1.FATES) && !("water.speed" in TV1.FATES)
    && walls === 2 && (json.match(/"layer":\["band-[0-9a-f]{26}"\]/g) ?? []).length === 2 && (json.match(/"mask":\[1,"band-[0-9a-f]{26}"\]/g) ?? []).length === 1 && /only this vehicle meets/.test(TV1.CARRIED.vehicle.to) && /physics-area \{kind: 'speed', factor: speed \/ 2\.4\}/.test(TV1.VOLUMES.water.to) && /set off by the hull's measured box/.test(TV1.CARRIED.vehicle.to) && !json.includes("physics-area") && !json.includes('"drag"')
    && r.stats.mapped?.find((m) => m.component === "water")?.speed?.dropped !== undefined && s === undefined && !("sky.audio" in TV1.FATES),
    "F50 the report says, in words, what becomes of vehicle probes; minY/maxY are two hull-only walls in the vehicle's own layer, which its mask scans (@32); main's 2.4 water speed is today's stroke, so it is dropped and said (@31); sky audio is mapped, not carried (@25)", { v, w, s, walls }); });

row("F50b", () => { const { r, E } = tr([OWNER, ["olga", "spawn", { id: "boat", lib: "b.glb" }], ["olga", "comp", { id: "boat", type: "vehicle", data: { helm: [0, 1, 0], speed: 3, minY: 0, maxY: 9 } }],
    ["olga", "place", { id: "boat", pos: [5, 0, 5] }], ["olga", "place", { id: "boat", pos: [50, 0, 7] }], ["olga", "place", { id: "boat", pos: [90, 0, -3] }]]);
  const walls = Object.entries<any>(E).filter(([k]) => /^(floor|ceiling)-/.test(k)), touched = r.out.filter((e) => e.kind === "change" && /"(floor|ceiling)-[0-9a-f]{26}"/.test(JSON.stringify(e)));
  ok(r.stats.divergences === 0 && walls.length === 2 && walls.every(([, c]) => c.transform.pos[0] === 0 && c.transform.pos[2] === 0 && c.transform.scale[0] * 200 >= 2e5) && touched.length === 1,
    "F50b the vehicle walls stand at [0, y, 0] and span every legal x/z (±1e5 m): moving the vehicle in v1 re-places nothing (review delta-260 L-C)", { walls: walls.map(([k, c]) => [k, c.transform]), touched: touched.length }); });
row("F50c", () => { const { E } = tr([OWNER, ["olga", "spawn", { id: "boat", lib: "b.glb" }], ["olga", "comp", { id: "boat", type: "vehicle", data: { helm: [0, 1, 0], minY: 0, maxY: 9 } }]]);
  const walls = Object.entries<any>(E).filter(([k]) => /^(floor|ceiling)-/.test(k));
  ok(walls.length === 2 && walls.every(([, c]) => c.lock === true) && /locked \(builder strength/.test(TV1.CARRIED.vehicle.to),
    "F50c the vehicle walls are locked (no builder moves or deletes one by accident; lifting it is a builder's deliberate act, said in the report: review delta-260 L-B)", { walls: walls.map(([k, c]) => [k, c.lock]) }); });

// ================= @31: main's results in today's shapes (LEGACY-PINS 10-29) =================
row("F51", () => { const pond = (speed: number) => tr([OWNER, ["olga", "spawn", { id: "pool", lib: "p.glb" }], ["olga", "comp", { id: "pool", type: "water", data: { center: [0, 0, 0], size: [4, 2, 4], speed } }]]);
  const slow = pond(1.2), near = pond(2.45), kid = (o: any) => Object.values<any>(o.E).find((c) => c.water && c.zone), M = (o: any) => o.r.stats.mapped?.find((m) => m.component === "water");
  const json = JSON.stringify([slow.r.out, near.r.out]);
  ok(JSON.stringify(kid(slow)?.["physics-area"]) === JSON.stringify({ kind: "speed", factor: 0.5, modes: ["swim"] }) && JSON.stringify(M(slow)?.speed?.["physics-area"]) === JSON.stringify({ kind: "speed", factor: 0.5, modes: ["swim"] })
    && kid(near) && kid(near)["physics-area"] === undefined && /within 5%/.test(M(near)?.speed?.dropped ?? "") && !json.includes('"drag"'),
    "F51 main's slow water (speed 1.2, half the 2.4 stroke a volume swims at here) is physics-area {kind: speed, factor: 0.5, modes: [swim]} on the water's zone (a swim only, as main: walking on the pond floor is not slowed), said in the report; 2.45 (within 5%) writes nothing and says so; no translated world carries a drag field", { slow: kid(slow), mapped: M(slow), near: M(near) }); });
row("F52", () => { const bare = tr([OWNER, ["olga", "spawn", { id: "far", lib: "x.glb", pos: [120, 70, 0] }]]), terr = tr([OWNER, ["olga", "terrain", { seed: 3, size: 300 }]]);
  const B = bare.W.bounds, M = bare.r.stats.mapped?.find((m) => m.component === "stage");
  ok(JSON.stringify(B) === JSON.stringify({ min: [-78, -2, -78], max: [122, 72, 78] }) && /78 m of the origin/.test(M?.feature ?? "") && terr.W.bounds === undefined && !terr.r.stats.mapped?.some((m) => m.component === "stage"),
    "F52 a main world with neither bounds nor terrain gets main's stage edge as its box: x/z ±78 m, 2 m under the floor to main's 60 m flight ceiling, grown 2 m past a thing outside it; said in the report; a world with a terrain gets none (item 2)", { B, M, terr: terr.W.bounds }); });
row("F53", () => { const L = [{ at: [0, 0.39, 0], color: 0xffe8c4, intensity: 11.2, range: 12, decay: 1.7 }], lampsOf = (lib: string) => (lib === "glow.glb" ? L : []);
  const r = TV1.translate(log([OWNER, ["olga", "spawn", { id: "lamp", lib: "glow.glb", pos: [3, 0, 4] }], ["olga", "spawn", { id: "dull", lib: "x.glb" }], ["olga", "light", { id: "lit", lib: "glow.glb", color: 0xff0000 }]]), { lampsOf }), E = r.final.translated;
  const kids = Object.entries<any>(E).filter(([, c]) => c.label === "lamp"), [kid, c] = kids[0] ?? [];
  ok(kids.length === 1 && c.parent?.to === "lamp" && JSON.stringify(c.transform.pos) === "[0,0.39,0]" && JSON.stringify(c.light) === JSON.stringify({ kind: "point", color: 0xffe8c4, intensity: TV1.parityIntensity(11.2, 12), range: 12, decay: 2, daytime: "dim" })
    && kid === TV1.lampChildId("lamp", 0) && r.stats.mapped?.some((m) => m.component === "lamp" && m.id === "lamp" && /infers none/.test(m.feature)),
    "F53 a glowing model main lit with an inferred lamp gets that lamp as a light child at its spot (main's colour, range 12, its brightness at 6 m under decay 2); a dull model and a light main placed get none; said in the report (item 6)", { kids, mapped: r.stats.mapped }); });

row("F53b", () => { const { Document } = require("@gltf-transform/core");   // main's attachLamps rule, measured from a GLB (import-v1/lamps.ts)
  const doc = new Document(), buf = doc.createBuffer(), scene = doc.createScene();
  const prim = (c: number[], lo: number[], hi: number[]) => doc.createPrimitive().setMaterial(c).setAttribute("POSITION", doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(new Float32Array([...lo, ...hi])));
  const mat = (e: number[], map = false) => { const m = doc.createMaterial().setEmissiveFactor(e); if (map) m.setEmissiveTexture(doc.createTexture()); return m; };
  const node = (t: number[], p: any) => { const n = doc.createNode().setTranslation(t).setMesh(doc.createMesh().addPrimitive(p)); scene.addChild(n); return n; };
  node([0, 0, 0], prim(mat([0.2, 0.2, 0.2]), [0, 0, 0], [1, 1, 1]));                    // dull: glow 0.2
  node([0, 0, 0], prim(mat([1, 1, 1], true), [0, 0, 0], [1, 1, 1]));                    // a toon map at strength 1: no lamp
  node([2, 1, 0], prim(mat([1, 0.9, 0.8]), [-0.1, 0, -0.1], [0.1, 0.4, 0.1]));         // whitish: lamp 1, main's warm bulb at its box centre
  node([0, 3, 0], prim(mat([0, 0, 1]), [0, 0, 0], [0.2, 0.2, 0.2]));                    // saturated blue: lamp 2, its own colour
  node([9, 9, 9], prim(mat([1, 1, 1]), [0, 0, 0], [1, 1, 1]));                          // a third: main took two
  const L = LAMPS.lampsOfDoc(doc), near = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-6);
  ok(L.length === 2 && JSON.stringify(L[0].at) === "[2,1.2,0]" && L[0].color === 0xffd9a0 && Math.abs(L[0].intensity - 8.6) < 1e-9 && near(L[1].at, [0.1, 3.1, 0.1]) && L[1].color === 0x0000ff && L.every((x: any) => x.range === 12 && x.decay === 1.7),
    "F53b the lamps main inferred, measured from a GLB as its rig did: an emitter is a flat emissive over 0.5 (a map only above strength 1), at most two in scene order, at each one's box centre in the model's frame; a saturated one keeps its colour, a whitish one is main's warm bulb; 6 + 2.6 × glow", L); });

// ================= V5: the version, and a stale review refused =================
row("V5", () => { const root = scratch("translate-v5"), W = path.join(root, "worlds"), d = path.join(W, "den"); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "log.jsonl"), log([OWNER]).map((e) => JSON.stringify(e)).join("\n") + "\n");
  const env = { ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(root, "opt"), BACKUPS_DIR: path.join(root, "backups"), TRUST_NAMES: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  const rep = Bun.spawnSync(["bun", "-e", `import { reportV1World } from "./tools/protocol/import-v1/world.ts"; import { sha256 } from "./shared/protocol/hash.js"; const { report } = reportV1World(${JSON.stringify(d)}); console.log("H " + sha256(JSON.stringify({ ...report, translator: "eidoverse/translate-v1@36" })));`], { cwd: ENGINE, env });
  const old = /H ([0-9a-f]{64})/.exec(rep.stdout.toString())?.[1];
  const up = Bun.spawnSync(["bun", "tools/protocol/world.ts", "translate", "--no-founder-key", "--operator-only-no-owner", "--approved", old ?? "x", "--", "den"], { cwd: ENGINE, env });
  const said = up.stdout.toString() + up.stderr.toString();
  ok(TV1.translatorVersion(TV1.TRANSLATOR) === 39 && TV1.translatorVersion(TV1.TRANSLATOR_SIM) === 39 && old && up.exitCode !== 0 && /is not the one that was approved/.test(said) && /earlier translator than eidoverse\/translate-v1@39/.test(said) && fs.existsSync(path.join(d, "log.jsonl")) && !fs.existsSync(path.join(d, "world.jsonl")),
    "V5 the translator is @39; a report reviewed under @38 is refused, saying an earlier translator's review never approves this one, and nothing moves", { v: TV1.TRANSLATOR, said: said.slice(-500) }); });

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

row("V7", () => { const root = scratch("translate-v7"), W = path.join(root, "worlds"), d = path.join(W, "den"); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "log.jsonl"), log([OWNER, ["olga", "spawn", { id: "sub", lib: "props/ball.glb" }], ["olga", "comp", { id: "sub", type: "vehicle", data: { helm: [0, 1, 0], speed: 3, minY: 0, maxY: 9 } }]]).map((e) => JSON.stringify(e)).join("\n") + "\n");
  const env = { ...process.env, WORLDS_DIR: W, BACKUPS_DIR: path.join(root, "backups"), TRUST_NAMES: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };   // OPT_DIR: the repo's, so the real ball.glb is measured
  const run = (a: string[]) => { const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", ...a], { cwd: ENGINE, env }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  const dry = run(["translate", "--dry-run", "--no-founder-key", "--", "den"]), hash = /^report-hash ([0-9a-f]{64})$/m.exec(dry.out)?.[1] ?? "x";
  const up = run(["translate", "--no-founder-key", "--operator-only-no-owner", "--approved", hash, "--", "den"]);
  const text = fs.existsSync(path.join(d, "world.jsonl")) ? fs.readFileSync(path.join(d, "world.jsonl"), "utf8") : "";
  const ys = (which: string) => [...text.matchAll(new RegExp(`"(${which}-[0-9a-f]{26})"[^\\n]*?"transform","value":\\{"pos":\\[[^,]+,([^,]+),`, "g"))].map((m) => +m[2]);
  const [floor] = ys("floor"), [ceil] = ys("ceiling");
  ok(up.code === 0 && Math.abs(floor - (0 - 0.35 - 10)) < 1e-6 && Math.abs(ceil - (9 + 0.35)) < 1e-6,   // ball.glb box ±0.35 m
    "V7 a vehicle with minY/maxY and a hull this host measures (the repo's ball.glb): the CLI's dry run then --approved applies (one digest for both), and the walls are set off by the ball's box", { code: up.code, out: up.out.slice(-400), floor, ceil }); });

// ================= SWEEP-3: the rest of main's meaning =================
row("S3-T1", () => { const { E } = tr([OWNER, ["olga", "spawn", { id: "a", lib: "x.glb", collide: "exact" }], ["olga", "spawn", { id: "b", lib: "x.glb", collide: "box" }], ["olga", "spawn", { id: "c", lib: "x.glb", collide: "boxy" }]]);
  ok(E.a.collider?.shape === "mesh" && E.b.collider?.shape === "box" && E.c.collider === undefined && E.c["imported:collide"] === "boxy", "S3-T1 main's spawn collide: exact → collider mesh, box → box; anything else carried", { a: E.a.collider, b: E.b.collider, c: E.c }); });
// decision table row 8 (@34): main's ambient motes keep their count, range and colour in a derived dust document
row("DT8", () => { const env = (particles: any) => tr([OWNER, ["olga", "spawn", { id: "land", lib: "t.glb" }], ["olga", "comp", { id: "land", type: "environment", data: { particles } }]]);
  const fx = (o: any) => o.E[TV1.envChildId("land", "particles")]?.particles, em = (o: any) => o.r.effects.get(fx(o)?.effect)?.emitters?.[0];
  const a = env({ count: 450, range: 24, color: "#336699" }), b = env({ count: 3000, range: 60 }), c = env({}), d = env({ count: 9000, range: 90 });
  ok(/^sha256:/.test(fx(a)?.effect) && em(a)?.spawn?.amount === 450 && em(a).shape.extents[0] === 24 && em(a).color.base === 0x336699 && a.E.land["imported:environment"] === undefined
    && em(b)?.spawn?.amount === 3000 && em(b).shape.extents[0] === 60 && em(b).color.base === 0xaec8b4 && b.E.land["imported:environment"] === undefined
    && em(d)?.spawn?.amount === PE.EFFECT_LIMITS.amount && em(d).shape.extents[0] === PE.EFFECT_LIMITS.extent && JSON.stringify(d.E.land["imported:environment"]) === JSON.stringify({ particles: { count: 9000, range: 90 } })
    && em(c)?.shape?.extents?.[0] === 16 && em(c).color.base === 0xaec8b4 && !PE.effectProblem(a.r.effects.get(fx(a).effect)),
    "DT8 main's motes: count, range and colour ride in a derived dust document (main's 16 m and #aec8b4 where unset); main's largest (3,000, 60 m) fit unclamped; past the effect limits they're clamped and carried", { a: em(a), b: [em(b)?.spawn, b.E.land["imported:environment"]], d: em(d)?.spawn }); });
// decision table row 9 (@33): main sat a socket with no pos at [0, 0.5, 0] (client/lib/world.js); the translation writes it
row("DT9", () => { const { E } = tr([OWNER, ["olga", "spawn", { id: "s", lib: "x.glb" }], ["olga", "comp", { id: "s", type: "sockets", data: { bare: { pose: "sit" }, nul: { pos: null }, set: { pos: [1, 0.2, 0] } } }]]);
  const S = E.s?.sockets ?? {};
  ok(JSON.stringify(S.bare?.pos) === "[0,0.5,0]" && JSON.stringify(S.nul?.pos) === "[0,0.5,0]" && JSON.stringify(S.set?.pos) === "[1,0.2,0]",
    "DT9 a seat with no pos (or a null one) sits at main's [0, 0.5, 0]; a written pos is kept", S); });
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
// decision table (R 10-30): main's sun and fill sliders are kept (the renderer still reads both; fill is the bounce light opposite the sun, not ambient)
row("S3-SF", () => { const { W } = tr([OWNER, ["olga", "sky", { world: "earth", sun: 1.4, fill: 0.6, ambient: 0.9 }]]);
  ok(W.sky?.sun === 1.4 && W.sky?.fill === 0.6 && W.sky?.ambient === 0.9 && W["imported:sky"] === undefined,
    "S3-SF main's sun and fill sliders arrive on @world.sky as they were", { sky: W.sky, imp: W["imported:sky"] }); });
row("S3-LD", () => { const { E } = tr([OWNER, ["olga", "spawn", { id: "lamp", lib: "x.glb" }], ["olga", "comp", { id: "lamp", type: "light", data: { color: 0xffd9a0 } }]]);
  ok(E.lamp.light?.decay === 2 && E.lamp.light.intensity === COMPONENTS.light.defaults.intensity && E.lamp.light.intensity === TV1.parityIntensity(16, 10),
    "S3-LD a main light with no intensity is main's 16 brightened once (never the registry default brightened again): a new default light's intensity", { l: E.lamp.light, d: COMPONENTS.light.defaults.intensity }); });

console.log(`[translate-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
