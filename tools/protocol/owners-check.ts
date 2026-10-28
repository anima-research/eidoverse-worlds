// tools/protocol/owners-check.ts — a translated world's owners are bound to the accounts main recorded for them (R 10-28:
// "MAKE SURE all current server operators are in fact the owners of their own worlds"). Synthetic fixtures only.
//   MK1  main's .principals.json: one account under a name (any case) is what main knew for it
//   MK2  two accounts under one name (principals and another world's log) are both returned: ambiguous
//   MK3  another world's grant / genesis / placer pairs count (log.jsonl, or log.original.jsonl once translated); the world itself doesn't
//   MK4  .bans.json and .sessions.json are not read
//   OB1  the Commons shape: a name-only owner grant whose account main's .principals.json holds is bound after the upgrade
//        (signing in as that account is the owner); a grant that carried its sub stays bound
//   OB2  an unknown name and an ambiguous one (two accounts) stay imported, and the dry run lists each with why and the bind command
//   OB3  the upgrade's result carries the same list (the approved report's)
//   OB4  a name another world's log on this server paired with an account is bound
//   OB5  an account that already wears an id here: the owner role goes to that id (one person, one identity)
//   OR1  operator-repair bind <world> <name> <account>: the imported owner is worn by that account (signing in is them, with
//        their roles); by id too; recorded in world.mod.jsonl as an operator repair, no account printed or logged
//   OR2  …refuses a target that isn't imported (an account's identity); OR3 a malformed account; OR4 an account already
//        wearing another id; OR5 an ambiguous or unknown name — each changing nothing
//   OR6  a directory another process holds (the server, running) takes the bind: its next save keeps it, its next sign-in finds it
//   UN1  no owner bound to any account: the dry run, the report and the result warn, naming them, and the upgrade still runs
//   UN2  one owner bound: no warning; UN3 no owner at all: warned too
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/owners-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { mainKnowledge } from "../../server/mainknew.ts";
import { directoryAt } from "../../server/directory.ts";
import { directoryFileIn } from "../../server/keyfiles.ts";
import { readLog, fold } from "../../shared/protocol/fold.js";

let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 700)}` : ""}`); } };
const row = (what: string, fn: () => any) => { try { return fn(); } catch (e) { ok(false, what, `threw: ${e?.stack ?? e}`); } };
const T0 = 1790000000000;
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
/** a main-era world: its log.jsonl from [actor, verb, args] triples */
function v1(W: string, name: string, L: [string, string, any][], file = "log.jsonl") {
  const d = path.join(W, name); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, file), L.map(([actor, verb, args], k) => JSON.stringify({ seq: k, ts: T0 + k * 1000, actor, verb, args })).join("\n") + "\n");
  return d;
}
const principals = (W: string, p: Record<string, [string, string]>) => fs.writeFileSync(path.join(W, ".principals.json"),
  JSON.stringify(Object.fromEntries(Object.entries(p).map(([sub, [name, kind]]) => [sub, { name, kind, first: T0, last: T0 }]))), { mode: 0o600 });

// ================= MK: what main recorded for a name, outside the world's own log =================
{ const root = scratch("owners-mk"), W = path.join(root, "worlds");
  principals(W, { "human:test:antra": ["Antra", "human"], "human:test:mica1": ["mica", "human"], "service:x": ["svc", "human"] });
  v1(W, "garden", [["world", "grant", { id: "Mica", role: "owner", sub: "human:test:mica2" }], ["Mica", "spawn", { id: "c", lib: "x.glb", placer: { id: "Pip", sub: "human:test:pip" } }]]);
  v1(W, "water", [["world", "genesis", { roles: { Rue: { role: "owner", sub: "human:test:rue" } } }]], "log.original.jsonl");
  fs.writeFileSync(path.join(W, "water", "world.jsonl"), "{}\n");
  v1(W, "commons", [["world", "grant", { id: "Self", role: "owner", sub: "human:test:self" }]]);
  fs.writeFileSync(path.join(W, ".bans.json"), JSON.stringify({ zed: { by: "Antra", ts: T0, sub: "human:test:zed" } }));
  fs.writeFileSync(path.join(root, ".sessions.json"), JSON.stringify({ ["a".repeat(64)]: { sub: "human:test:sess", name: "Sess", exp: T0 * 2 } }));
  const k = mainKnowledge(W, { self: "commons" });
  row("MK1", () => ok(same(k("antra"), { subs: ["human:test:antra"], from: [".principals.json"] }) && same(k("ANTRA"), k("antra")),
    "MK1 main's .principals.json: one account under a name, in any case, is what main knew for it", k("antra")));
  row("MK2", () => ok(same(k("mica")?.subs, ["human:test:mica1", "human:test:mica2"]) && same(k("mica")?.from, [".principals.json", "garden's log"]),
    "MK2 two accounts under one name (principals and another world's grant) are both returned: ambiguous", k("mica")));
  row("MK3", () => ok(same(k("pip")?.subs, ["human:test:pip"]) && same(k("rue")?.from, ["water's log"]) && k("self") === null,
    "MK3 another world's placer and genesis pairs count (log.jsonl, or log.original.jsonl once that world was translated); the world being translated is skipped", { pip: k("pip"), rue: k("rue"), self: k("self") }));
  row("MK4", () => ok(k("zed") === null && k("sess") === null, "MK4 .bans.json (a name the banner typed) and .sessions.json (bearer secrets) are not read", { zed: k("zed"), sess: k("sess") }));
}

// ================= OB: the upgrade binds what main knew, and lists the rest =================
const tool = (root: string, args: string[], env: Record<string, string> = {}) => { const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", ...args], { cwd: ENGINE,
  env: { ...process.env, WORLDS_DIR: path.join(root, "worlds"), OPT_DIR: path.join(root, "opt"), BACKUPS_DIR: "", PROTOCOL_SCRATCH: root, AGENT_TOKENS_PATH: path.join(root, "tokens.json"), TRUST_NAMES: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...env }, timeout: 60_000 });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
const tagged = (out: string, tag: string) => { const l = out.split("\n").find((x) => x.startsWith(`${tag} `)); try { return l ? JSON.parse(l.slice(tag.length + 1)) : null; } catch { return null; } };
/** dry run, then the approved in-place upgrade: {dry, up, report, result, dir, roles: name → [id, role]} */
function upgrade(root: string, name: string) {
  const dry = tool(root, ["translate", "--dry-run", "--no-founder-key", "--json", "--", name]); const rj = tagged(dry.out, "report-json");
  const up = tool(root, ["translate", "--no-founder-key", "--operator-only-no-owner", "--approved", rj?.hash ?? "none", "--json", "--", name]);
  const dir = directoryAt(directoryFileIn(path.join(root, "worlds")));
  const f = path.join(root, "worlds", name, "world.jsonl");
  const c = fs.existsSync(f) ? fold(readLog(fs.readFileSync(f))).entities?.["@world"]?.c ?? {} : {};
  const roles: Record<string, [string, string]> = {};
  for (const [k, v] of Object.entries<any>(c)) if (k.startsWith("roles:")) roles[dir.nameOf(k.slice(6)) ?? k] = [k.slice(6), v?.role];
  return { dry, up, report: rj?.report, result: tagged(up.out, "result-json"), dir, roles };
}
const commonsShape: [string, string, any][] = [["world", "grant", { id: "antra", role: "owner", gen: true }], ["antra", "grant", { id: "Digi_Rat", role: "builder" }],
  ["antra", "grant", { id: "fable", role: "owner" }], ["antra", "grant", { id: "janus", role: "owner", sub: "human:test:janus" }], ["antra", "grant", { id: "mica", role: "owner" }],
  ["antra", "grant", { id: "lark", role: "owner" }], ["antra", "grant", { id: "svc", role: "builder" }], ["antra", "say", { text: "hello" }], ["Pip", "say", { text: "hi" }]];
{ const root = scratch("owners-ob"), W = path.join(root, "worlds"); fs.mkdirSync(path.join(root, "opt"), { recursive: true });
  principals(W, { "human:test:antra": ["Antra", "human"], "human:test:mica1": ["mica", "human"], "human:test:mica2": ["Mica", "human"],
    "human:test:janus-namesake": ["janus", "human"], "service:svc": ["svc", "human"] });   // a namesake of a grant that carried its sub; a sub that is no account here
  v1(W, "garden", [["world", "grant", { id: "Lark", role: "owner", sub: "human:test:lark" }]]);
  v1(W, "commons", commonsShape);
  const u = upgrade(root, "commons"); const P = Object.fromEntries((u.report?.people ?? []).map((p) => [p.name, p]));
  const at = (n: string) => u.dir.entry(u.roles[n]?.[0] ?? "") ?? {};
  row("OB1", () => ok(u.up.code === 0 && u.roles.antra?.[1] === "owner" && same(at("antra").subs, ["human:test:antra"]) && at("antra").kind === "account"
    && u.dir.resolve({ sub: "human:test:antra", name: "Antra" }) === u.roles.antra?.[0] && u.roles.janus?.[1] === "owner" && same(at("janus").subs, ["human:test:janus"]) && u.dir.idOfSub("human:test:janus-namesake") === null && P.antra?.from === "main's .principals.json",
    "OB1 the Commons shape: antra's name-only owner grant, with main's .principals.json holding one account for the name, is bound after the upgrade (signing in as it is the owner); janus's grant carried its sub and stays bound to it (a namesake in main's principals doesn't override the world's own record)",
    { code: u.up.code, out: u.up.code ? u.up.out.slice(-600) : undefined, roles: Object.keys(u.roles), antra: at("antra"), P: P.antra }));
  row("OB2", () => ok(at("fable").kind === "imported" && same(at("fable").subs, []) && at("mica").kind === "imported" && at("Digi_Rat").kind === "imported"
    && P.fable?.account === null && /no account/.test(P.fable?.why) && /2 accounts/.test(P.mica?.why) && P.Digi_Rat?.role === "builder"
    && /^owner fable has no account yet \(main recorded no account for this name\): bind with bun tools\/operator-repair\.ts bind commons "fable" <their account>$/m.test(u.dry.out)
    && /^owner mica has no account yet \(main recorded 2 accounts/m.test(u.dry.out) && /isn't one here \(service:…\)/.test(P.svc?.why) && at("svc").kind === "imported" && !/human:test:[a-z]/.test(u.dry.out),
    "OB2 an unknown name (fable, Digi_Rat), an ambiguous one (mica: two accounts) and one main paired with no account shape (svc) stay imported; the dry run lists each with why and the bind command, and prints no account", { P, fable: at("fable"), dry: u.dry.out.split("\n").filter((l) => /account/.test(l)) }));
  row("OB3", () => ok(same(u.result?.people, u.report?.people) && u.report.people.length === 7 && u.report.people[0].role === "owner",
    "OB3 the upgrade's result carries the approved report's list of who holds a role, owners first", { result: u.result?.people, report: u.report?.people }));
  row("UN2", () => ok(u.report?.ownerWarning === null && !/^WARNING/m.test(u.dry.out) && u.result && !("ownerWarning" in u.result && u.result.ownerWarning),
    "UN2 a world with an owner bound to an account (antra, janus, lark): no warning, though fable and mica are not", { w: u.report?.ownerWarning }));
  row("OB4", () => ok(u.roles.lark?.[1] === "owner" && same(at("lark").subs, ["human:test:lark"]) && P.lark?.from === "main's garden's log",
    "OB4 a name another world's log on this server paired with an account (garden's grant to Lark) is bound", { lark: at("lark"), P: P.lark, roles: Object.keys(u.roles) }));
}
{ const root = scratch("owners-ob5"), W = path.join(root, "worlds"); fs.mkdirSync(path.join(root, "opt"), { recursive: true });
  principals(W, { "human:test:antra": ["antra", "human"] });
  const pre = directoryAt(directoryFileIn(W)).resolve({ sub: "human:test:antra", name: "Antra Now" });
  v1(W, "den", [["world", "grant", { id: "antra", role: "owner" }], ["antra", "say", { text: "mine" }]]);
  const u = upgrade(root, "den");
  row("OB5", () => ok(u.up.code === 0 && u.roles["Antra Now"]?.[0] === pre && u.roles["Antra Now"]?.[1] === "owner" && Object.keys(u.roles).length === 1,
    "OB5 an account that already wears an id on this server: the old owner's role goes to that id, no second identity", { pre, roles: u.roles, out: u.up.code ? u.up.out.slice(-400) : undefined }));
}

// ================= UN: the safety net, a warning that names them =================
{ const root = scratch("owners-un"), W = path.join(root, "worlds"); fs.mkdirSync(path.join(root, "opt"), { recursive: true });
  v1(W, "attic", [["world", "grant", { id: "fable", role: "owner" }], ["fable", "grant", { id: "mica", role: "owner" }], ["fable", "grant", { id: "Digi_Rat", role: "builder" }], ["fable", "say", { text: "hi" }]]);
  v1(W, "shed", [["Pip", "say", { text: "nobody owns this" }]]);
  const a = upgrade(root, "attic"), s = upgrade(root, "shed");
  const named = (w: any) => typeof w === "string" && /no owner of "attic" is bound to an account: fable, mica\./.test(w) && /operator-repair\.ts bind attic /.test(w) && !/Digi_Rat/.test(w);
  row("UN1", () => ok(named(a.report?.ownerWarning) && a.dry.out.includes(`WARNING: ${a.report.ownerWarning}`) && a.up.code === 0 && fs.existsSync(path.join(W, "attic", "world.jsonl")) && named(a.result?.ownerWarning) && /^WARNING: no owner of "attic"/m.test(a.up.out),
    "UN1 no owner bound to any account: the dry run, the approved report and the upgrade's result warn, naming the owners (not the builder) and the bind; the upgrade still runs", { w: a.report?.ownerWarning, r: a.result?.ownerWarning, code: a.up.code }));
  row("UN3", () => ok(/"shed" has no owner at all/.test(s.report?.ownerWarning ?? "") && s.up.code === 0 && /has no owner at all/.test(s.result?.ownerWarning ?? ""),
    "UN3 a world with no owner at all after the upgrade is warned about too, and still upgraded", { w: s.report?.ownerWarning, code: s.up.code }));
}

// ================= OR: the operator binds an imported identity to an account =================
{ const root = scratch("owners-or"), W = path.join(root, "worlds"); fs.mkdirSync(path.join(root, "opt"), { recursive: true });
  v1(W, "porch", [["world", "grant", { id: "fable", role: "owner" }], ["fable", "grant", { id: "janus", role: "owner", sub: "human:test:janus" }],
    ["fable", "grant", { id: "Digi_Rat", role: "builder" }], ["fable", "grant", { id: "Twin", role: "builder" }], ["fable", "grant", { id: "twin", role: "builder" }], ["Twin", "say", { text: "hi" }]]);
  const u = upgrade(root, "porch"); const file = directoryFileIn(W);
  const bind = (...a: string[]) => { const r = Bun.spawnSync(["bun", "tools/operator-repair.ts", "bind", ...a], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(root, "opt"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 30_000 });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  const modOf = () => { const f = path.join(W, "porch", "world.mod.jsonl"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""; };
  const held = directoryAt(file);   // as a running server holds it: read before the bind
  const fableId = u.roles.fable?.[0], digiId = u.roles.Digi_Rat?.[0], twins = [u.roles.Twin?.[0], u.roles.twin?.[0]];
  const b1 = bind("porch", "Fable", "human:test:fable"); const e1 = directoryAt(file).entry(fableId) ?? {};
  const rec = modOf().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).at(-1) ?? {};
  row("OR1", () => ok(u.up.code === 0 && b1.code === 0 && same(e1.subs, ["human:test:fable"]) && e1.kind === "account" && directoryAt(file).resolve({ sub: "human:test:fable", name: "fable" }) === fableId
    && u.roles.fable?.[1] === "owner" && rec.verb === "bind" && rec.who === fableId && rec.operator === true && !/human:test:fable/.test(modOf()) && !/human:test:fable/.test(b1.out) && /operator repair/.test(b1.out),
    "OR1 operator-repair bind porch Fable human:test:fable: the imported owner (any case of the name) is worn by that account, so signing in with it is them, owner; recorded in world.mod.jsonl as an operator repair; the account is neither printed nor logged",
    { up: u.up.code, b1, e1, rec }));
  const before = fs.readFileSync(file, "utf8"), mod0 = modOf();
  const r2 = bind("porch", "janus", "human:test:other");
  const r3 = ["discord:1", "human:", "agent:fable", "human:test:a b", "service:x"].map((a) => bind("porch", "Digi_Rat", a));
  const r4 = bind("porch", "Digi_Rat", "human:test:janus");
  const r5 = [bind("porch", "twin", "human:test:twin"), bind("porch", "nobody", "human:test:nobody")];
  const still = fs.readFileSync(file, "utf8") === before && modOf() === mod0;
  row("OR2", () => ok(r2.code === 1 && /isn't an imported identity/.test(r2.out) && still, "OR2 bind refuses a target that isn't imported (janus's identity wears an account), nothing changed", r2));
  row("OR3", () => ok(r3.every((r) => r.code === 1 && /isn't an account/.test(r.out)) && still, "OR3 bind refuses a malformed account (no provider, empty, main's agent:<name>, a space, a shape that isn't one here), nothing changed", r3.map((r) => r.out.slice(0, 120))));
  row("OR4", () => ok(r4.code === 1 && /already wears janus/.test(r4.out) && still, "OR4 bind refuses an account that already wears another identity here (it can't be two people), nothing changed", r4));
  row("OR5", () => ok(r5[0].code === 1 && /2 imported identities/.test(r5[0].out) && twins.every((id) => r5[0].out.includes(id)) && r5[1].code === 1 && /nobody called "nobody"/.test(r5[1].out) && still,
    "OR5 bind refuses an ambiguous name (Twin and twin: two imported people), naming their ids, and an unknown one, nothing changed", r5));
  const b6 = bind("porch", twins[0], "human:test:twin"); held.markRenamed(digiId);   // the held directory writes after the bind
  const e6 = directoryAt(file).entry(fableId) ?? {}, t6 = directoryAt(file).entry(twins[0]) ?? {};
  row("OR6", () => ok(b6.code === 0 && same(e6.subs, ["human:test:fable"]) && same(t6.subs, ["human:test:twin"]) && held.resolve({ sub: "human:test:fable", name: "fable" }) === fableId && held.entry(fableId)?.kind === "account",
    "OR6 a directory another process held from before (a running server) takes the binds: its next save keeps them, and signing in with a bound account there finds the identity; a bind by id works too", { b6: b6.out.slice(0, 200), e6, t6 }));
}

console.log(`[owners-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
