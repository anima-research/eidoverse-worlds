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
//   BN1  a main-era world ban of a name nothing else in the log names: bound to main's one account for it, so that account is
//        still banned after the upgrade (the authority's ban check, as at join); the hashed report lists it, with "check it"
//   BN2  …a ban-only name main recorded no account for is listed unbound, with why and the bind command
//   OR1  operator-repair bind <world> <name> <account>: the imported owner is worn by that account (signing in is them, with
//        their roles); by id too; recorded in world.mod.jsonl as an operator repair, no account printed or logged
//   OR2  …refuses a target that isn't imported (an account's identity); OR3 a malformed account; OR4 an account already
//        wearing another id; OR5 an ambiguous or unknown name — each changing nothing
//   OR7  bind refuses an identity only a third party's entry names (a recipient of translated old speech); OR8 its own entry, role, ban or mute makes it bindable
//   OR9  …an entry counts only if the reader accepts it: a parseable but invalid row makes nobody bindable
//   OR6  a directory another process holds (the server, running) takes the bind: its next save keeps it, its next sign-in finds it
//   UN1  no owner bound to any account: the dry run, the report and the result warn, naming them, and the upgrade still runs
//   UN2  one owner bound: no warning; UN3 no owner at all and no --claim: refused, naming --claim (every translation ends with an owner)
//   OU1  world.ts owner-of: a signed-in account main's records bind to an owner is that owner ("bound"), whatever its name
//   OU2  an owner main recorded NO account for is recognised by the account's name, any case ("name": provisional, R 10-28)
//   OU3  a different name is refused; so is a bound owner's name on another account, and a builder's name
//   OU4  an owner main recorded several accounts for is never recognised (even by name or one of those accounts); no sign-in neither
//   OU5  (a) main's records bind the owner's name to another account (here on a TRUST_NAMES server): refused by name; that account is recognised
//   OU6  (b) another account on this server already holds the signed-in name: refused by name
//   OU7  a name is matched as the directory folds it (foldName), the same rule as OU6's check
//   OC1  ownerRecognised is computed once per log head in a process; OC2 a refused join's owner check is capped (JOIN_CHECKS)
//   CL1  --claim on an ownerless world: the upgrader's account is its owner, the report says so (claim), no warning, the result names them
//   CL2  …everyone else keeps main's ownerless rights (newcomers and guests build, edit others, generate; never fly)
//   CL3  …and rollback forgets the claimant's identity with the rest (the backup and undo as before)
//   CL4  --claim on a world that has an owner changes nothing: no claim, its owner stays the only owner
//   CL7  the splash's words for each claim (client/lib/upgradeview.js claimWords): ownerless, owner by account, owner by name
//   CL5  claimed: an ownerless world's locks (a v1 lock and a guard) are lifted by a regular, who is builder (no lockout)
//   CL8-10 (row 22) …a who: builder gate admits a regular, a regular's lock is lifted by another, moderation stays refused
//   CL11 the translation writes no imported:ownerless: a builder granted after the claim, once the owner leaves, reads member
//   CL6  …and operator-repair set of another owner keeps builder's generate (the translation's role-defs), in one write
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/owners-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { mainKnowledge } from "../../server/mainknew.ts";
import { directoryAt } from "../../server/directory.ts";
import { directoryFileIn } from "../../server/keyfiles.ts";
import { readLog, fold } from "../../shared/protocol/fold.js";
import * as R from "../../shared/protocol/roles.js";
import { openLive } from "../../server/livehost.ts";
import { ENGINE_CATALOGUE } from "../../server/modelcatalogue.ts";
import { request, operatorRepair } from "../../shared/protocol/authority.js";
import { banOf } from "../../shared/protocol/authority/rights.js";
import { claimWords } from "../../client/lib/upgradeview.js";

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
function upgrade(root: string, name: string, flags: string[] = [], env: Record<string, string> = {}) {
  const dry = tool(root, ["translate", "--dry-run", "--no-founder-key", ...flags, "--json", "--", name], env); const rj = tagged(dry.out, "report-json");
  const up = tool(root, ["translate", "--no-founder-key", "--operator-only-no-owner", ...flags, "--approved", rj?.hash ?? "none", "--json", "--", name], env);
  const dir = directoryAt(directoryFileIn(path.join(root, "worlds")));
  const f = path.join(root, "worlds", name, "world.jsonl");
  const c = fs.existsSync(f) ? fold(readLog(fs.readFileSync(f))).entities?.["@world"]?.c ?? {} : {};
  const roles: Record<string, [string, string]> = {};
  for (const [k, v] of Object.entries<any>(c)) if (k.startsWith("roles:")) roles[dir.nameOf(k.slice(6)) ?? k] = [k.slice(6), v?.role];
  return { dry, up, report: rj?.report, result: tagged(up.out, "result-json"), dir, roles, c };
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
  const no = (o: string) => /"shed" has no owner, and every translation ends with one: translate it with --claim and EIDO_UPGRADER_ACCOUNT=/.test(o);
  row("UN3", () => ok(s.dry.code !== 0 && no(s.dry.out) && s.up.code !== 0 && no(s.up.out) && !fs.existsSync(path.join(W, "shed", "world.jsonl")) && fs.existsSync(path.join(W, "shed", "log.jsonl")),
    "UN3 a world with no owner and no --claim: the dry run and the upgrade refuse, naming --claim and EIDO_UPGRADER_ACCOUNT; nothing is written (LEGACY-PINS item 9)", { dry: s.dry.out.slice(-300), up: s.up.out.slice(-300), code: s.up.code }));
}

// ================= OU: who may upgrade as the world's owner (R 10-28: "owners or operators can update worlds") =================
{ const root = scratch("owners-ou"), W = path.join(root, "worlds"); fs.mkdirSync(path.join(root, "opt"), { recursive: true });
  principals(W, { "human:test:mica1": ["mica", "human"], "human:test:mica2": ["Mica", "human"] });
  v1(W, "loft", [["world", "grant", { id: "Bo", role: "owner", sub: "human:test:bo" }], ["world", "grant", { id: "Ann", role: "owner" }], ["world", "grant", { id: "mica", role: "owner" }],
    ["world", "grant", { id: "Cy", role: "builder" }], ["Ann", "say", { text: "hi" }]]);
  const of = (account: string, name: string) => { const r = tool(root, ["owner-of", "--", "loft"], { EIDO_UPGRADER_ACCOUNT: account, EIDO_UPGRADER_NAME: name }); return { ...(tagged(r.out, "owner-json") ?? { out: r.out.slice(-300) }), printed: /human:test:/.test(r.out) }; };
  const bo = of("human:test:bo", "Robert"), ann = of("human:test:new", "ann"), annie = of("human:test:new", "Annie"), boName = of("human:test:other", "Bo"), cy = of("human:test:cy", "Cy");
  const mica = of("human:test:mica1", "mica"), none = of("", "Ann");
  row("OU1", () => ok(bo.recognised === "bound" && bo.owner === "Bo" && !bo.printed, "OU1 owner-of: the signed-in account main's records bind to an owner (the grant's sub) is that owner, 'bound', whatever its name; no account printed", bo));
  row("OU2", () => ok(ann.recognised === "name" && ann.owner === "Ann", "OU2 an owner main recorded no account for (Ann) is recognised by the signed-in account's name, any case: 'name' (provisional)", ann));
  row("OU3", () => ok(annie.recognised === null && boName.recognised === null && cy.recognised === null && /don't make this account/.test(annie.why),
    "OU3 a different name (Annie) is refused; so is a bound owner's name (Bo) on another account, and a builder's name (Cy)", { annie, boName, cy }));
  row("OU4", () => ok(mica.recognised === null && /several accounts for the owner mica/.test(mica.why) && none.recognised === null && /not signed in/.test(none.why),
    "OU4 an owner main recorded several accounts for (mica) is not recognised, by name or by one of those accounts; no sign-in isn't either", { mica, none }));
  const dotted = of("human:test:new", "A.nn");
  row("OU7", () => ok(dotted.recognised === "name" && dotted.owner === "Ann", "OU7 the name is matched as the directory folds names (foldName: case, punctuation, format characters), one rule for both checks: 'A.nn' is owner Ann", dotted));
  directoryAt(directoryFileIn(W)).resolve({ sub: "human:test:ann2", name: "ANN" });   // someone else signed in here as "ANN"
  const ann2 = of("human:test:new", "Ann"), own2 = of("human:test:ann2", "ann");
  row("OU6", () => ok(ann2.recognised === null && /held by more than one account/.test(ann2.why ?? "") && own2.recognised === "name",
    "OU6 (b) once another account on this server holds the name (ANN), a second account by that name is refused; the one account holding it is still recognised", { ann2, own2 }));
}
{ const root = scratch("owners-ou5"), W = path.join(root, "worlds"); fs.mkdirSync(path.join(root, "opt"), { recursive: true });
  principals(W, { "human:test:lu": ["Lu", "human"] });
  v1(W, "shed", [["world", "grant", { id: "Lu", role: "owner" }]]);
  const of = (account: string, name: string) => tagged(tool(root, ["owner-of", "--", "shed"], { TRUST_NAMES: "1", EIDO_UPGRADER_ACCOUNT: account, EIDO_UPGRADER_NAME: name }).out, "owner-json") ?? {};
  const other = of("human:test:other", "Lu"), lu = of("human:test:lu", "Lu");
  row("OU5", () => ok(other.recognised === null && /bind the owner Lu to another account/.test(other.why ?? "") && lu.recognised === "name",
    "OU5 (a) main's .principals.json binds Lu to an account (a TRUST_NAMES server, where a name is its account): another account named Lu is refused; Lu's own account is recognised", { other, lu }));
}

// ================= OC: the owner check's cost (review full-260 L2) =================
{ const root = scratch("owners-oc"), W = path.join(root, "worlds"); fs.mkdirSync(path.join(root, "opt"), { recursive: true });
  const d = v1(W, "mews", [["world", "grant", { id: "Ann", role: "owner" }], ["Ann", "say", { text: "hi" }]]), logf = path.join(d, "log.jsonl");
  const { ownerRecognised } = await import("./import-v1/world.ts");
  const read0 = fs.readFileSync; let reads = 0; (fs as any).readFileSync = (f: any, ...a: any[]) => { if (path.resolve(String(f)) === logf) reads++; return (read0 as any)(f, ...a); };
  let a: any, b: any, n1 = 0; try { a = ownerRecognised(d, "human:test:x", "Ann"); n1 = reads; b = ownerRecognised(d, "human:test:x", "Ann"); } finally { (fs as any).readFileSync = read0; }
  row("OC1", () => ok(a?.recognised === "name" && same(a, b) && n1 >= 1 && reads === n1, "OC1 an apply asks twice (its report, then the write): the second answer is the first, by the log's head, with no second read and fold", { n1, reads, a }));
  const t0 = Date.now(), q = Bun.spawnSync(["bun", "-e", `const U = await import("./server/upgrade.ts"); const who = (k) => ({ account: "human:test:j" + k, name: "J" + k });
    const r = await Promise.all([0, 1, 2, 3, 4].map((k) => U.ownerOf("mews", who(k), { join: true }))); console.log("R " + JSON.stringify(r.map((x) => x === null ? "skipped" : "checked")) + " " + U.JOIN_CHECKS);`],
    { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(root, "opt"), BACKUPS_DIR: "", TRUST_NAMES: "", SERVER_OPERATORS: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 600_000 });   // two concurrent CLI children, cache off: a Windows runner overran 120 s (#260 run 41014925239)
  const got = /^R (\[.*\]) (\d+)$/m.exec(q.stdout.toString());
  row("OC2", () => ok(got && same(JSON.parse(got[1]), ["checked", "checked", "skipped", "skipped", "skipped"]) && got[2] === "2",
    "OC2 a burst of refused joins runs at most JOIN_CHECKS owner checks at once (each a CLI read and fold); the rest are skipped (may: false), not queued", { ms: Date.now() - t0, exit: q.exitCode, signal: q.signalCode ?? null, out: q.stdout.toString().slice(-300), err: q.stderr.toString().slice(-300) }));
}

// ================= CL: an ownerless world is claimed by whoever upgrades it (R 10-28) =================
{ const root = scratch("owners-cl"), W = path.join(root, "worlds"); fs.mkdirSync(path.join(root, "opt"), { recursive: true });
  v1(W, "barn", [["Pip", "say", { text: "nobody owns this" }], ["Pip", "spawn", { id: "c", lib: "x.glb" }]]);
  v1(W, "den", [["world", "grant", { id: "Ann", role: "owner", sub: "human:test:ann" }], ["Ann", "say", { text: "mine" }]]);
  const OPAL = { EIDO_UPGRADER_ACCOUNT: "human:test:op", EIDO_UPGRADER_NAME: "Opal" };
  const c = upgrade(root, "barn", ["--claim"], OPAL), d = upgrade(root, "den", ["--claim"], OPAL);
  const id = c.roles.Opal?.[0] ?? "";
  row("CL1", () => ok(c.up.code === 0 && c.roles.Opal?.[1] === "owner" && same(c.dir.entry(id)?.subs, ["human:test:op"]) && /no owner: whoever performs this upgrade becomes its owner/.test(c.report?.claim ?? "")
    && c.report.ownerWarning === null && c.result?.ownerWarning === null && c.result?.claimed?.name === "Opal" && c.result.people?.[0]?.claimed === true && /^claimed: "barn" had no owner; Opal/m.test(c.up.out) && !/human:test:op/.test(c.up.out + c.dry.out),
    "CL1 --claim on an ownerless world: the upgrader's account is its owner (their identity, owner role), the approved report says so (claim) and warns of nothing, the result names them; no account printed", { code: c.up.code, out: c.up.out.slice(-500), roles: c.roles, claim: c.report?.claim, claimed: c.result?.claimed }));
  const eff = (who: string, anon = false) => R.effectiveOf(c.c, who, { anon });
  const n = eff("u-somebodyelse00000000"), g = eff("guest", true), o = eff(id);
  row("CL2", () => ok(o.role === "owner" && ["build", "editOthers", "generate"].every((k) => n.can[k] && g.can[k]) && !n.can.fly && !g.can.fly && n.role !== "owner" && g.role !== "owner",
    "CL2 …everyone else keeps what main gave them in an ownerless world: newcomers and guests build, edit others' things and generate (builder gains generate), never fly", { n: n.permissions, g: g.permissions, o: o.role }));
  row("CL4", () => ok(d.up.code === 0 && d.report?.claim === undefined && same(Object.values(d.roles).map(([, r]) => r), ["owner"]) && !d.roles.Opal && d.result?.claimed === undefined,
    "CL4 --claim on a world that has an owner changes nothing: no claim in the report, Ann stays its only owner, nobody claimed it", { roles: d.roles, claim: d.report?.claim }));
  v1(W, "den2", [["world", "grant", { id: "Ann", role: "owner", sub: "human:test:ann" }], ["Ann", "say", { text: "mine" }]]);
  const own = tagged(tool(root, ["translate", "--dry-run", "--no-founder-key", "--claim", "--json", "--", "den2"], { EIDO_UPGRADER_ACCOUNT: "human:test:ann", EIDO_UPGRADER_NAME: "Ann" }).out, "report-json")?.report;
  const words = [claimWords(c.report?.claim), claimWords(own?.claim), claimWords({ by: "Ann", how: "name" }), claimWords(d.report?.claim)];
  row("CL7", () => ok(/has no owner: you will become its owner/.test(words[0] ?? "") && own?.claim?.how === "bound" && !/no owner/.test(words[1] ?? "x") && /owner Ann, by the account main recorded/.test(words[1] ?? "")
    && /owner Ann, recognised by your name/.test(words[2] ?? "") && !/no owner/.test(words[2] ?? "x") && words[3] === null,
    "CL7 the splash words each claim: an ownerless world's (you become its owner), an owner recognised by account or by name (never 'no owner'), none", { words, claim: own?.claim }));
  const rb = tool(root, ["rollback", "barn"]);
  row("CL3", () => ok(rb.code === 0 && directoryAt(directoryFileIn(W)).idOfSub("human:test:op") === null && !fs.existsSync(path.join(W, "barn", "world.jsonl")) && fs.existsSync(path.join(W, "barn", "log.jsonl"))
    && fs.readdirSync(path.join(root, "backups")).some((f) => f.startsWith("barn-")),
    "CL3 rollback of a claimed upgrade forgets the claimant's identity with the rest; the old world is back and its backup kept", { code: rb.code, out: rb.out.slice(-300) }));
}

{ const root = scratch("owners-cl5"), W = path.join(root, "worlds"); fs.mkdirSync(path.join(root, "opt"), { recursive: true });
  v1(W, "yard", [["Pip", "spawn", { id: "shed", lib: "x.glb" }], ["Pip", "comp", { id: "shed", type: "lock", data: true }],
    ["Pip", "spawn", { id: "gate", lib: "x.glb" }], ["Pip", "comp", { id: "gate", type: "guard", data: true }]]);
  const u = upgrade(root, "yard", ["--claim"], { EIDO_UPGRADER_ACCOUNT: "human:test:op", EIDO_UPGRADER_NAME: "Opal" }); const live = () => openLive(path.join(W, "yard"), "yard", { catalogue: ENGINE_CATALOGUE, scripts: null });
  const pip = u.roles.Pip?.[0] ?? u.dir.resolve({ sub: "human:test:pip", name: "Pip" }), rue = u.dir.resolve({ sub: "human:test:rue", name: "Rue" });
  const a = request(live(), rue, "delete", { id: "shed", component: "lock" }), b = request(live(), pip, "delete", { id: "gate", component: "lock" });
  row("CL5", () => ok(u.up.code === 0 && a?.ok && b?.ok && live().state().entities.shed.c.lock === undefined,
    "CL5 claimed by its upgrader: a regular (a newcomer, the placer) is builder and lifts the old world's lock and guard; nobody is locked out", { code: u.up.code, out: u.up.out.slice(-300), a: a?.refused, b: b?.refused }));
  { // (fixF, row 22) main let everyone build an ownerless world: here everyone is builder, rank and all; never moderator
    const w = live(), q = (who: string, verb: string, args: any) => request(w, who, verb, args);
    const mk = q(rue, "create", { id: "$lever", components: { label: "lever", reactions: { yank: { kind: "set", component: "label", value: "yanked", who: "builder" } } } });
    const lever = mk?.ok ? (mk.ids?.$lever ?? mk.id ?? Object.keys(w.state().entities).find((k) => w.state().entities[k].c.label === "lever")) : null;
    const use = lever ? q(pip, "use", { id: lever, action: "yank" }) : null;
    row("CL8", () => ok(mk?.ok && use?.ok && w.state().entities[lever]?.c.label === "yanked",
      "CL8 a who: builder gate admits a regular in a translated ownerless world (a newcomer made it, the placer of another thing used it)", { mk: mk?.refused ?? mk?.ok, use: use?.refused ?? use?.ok, lever }));
    const lk = q(rue, "set", { id: lever ?? "shed", component: "lock", value: true }), lift = q(pip, "delete", { id: lever ?? "shed", component: "lock" });
    row("CL9", () => ok(lk?.ok && lift?.ok, "CL9 …a lock a regular set (builder strength by its setter) is lifted by another regular: no lockout", { lk: lk?.refused, lift: lift?.refused }));
    const ban = q(rue, "ban", { who: pip, days: 1 }), up = q(rue, "set", { id: "@world", component: `roles:${rue}`, value: { role: "moderator" } });
    row("CL10", () => ok(ban?.ok === false && up?.ok === false && R.roleIdOf(w.state().entities["@world"].c, rue) === "builder",
      "CL10 …and moderation stays refused: a regular can't ban, nor make themselves moderator; their role is builder, never above", { ban: ban?.refused?.code, up: up?.refused?.code, role: R.roleIdOf(w.state().entities["@world"].c, rue) })); }
  const w = live(), n0 = w.entries.length, set = operatorRepair(w, rue, "set", { id: "@world", component: `roles:${rue}`, value: { role: "owner" } }), wrote = w.entries.slice(n0);
  const wc = w.state().entities["@world"].c, n = R.effectiveOf(wc, "u-somebodyelse00000000"), again = operatorRepair(w, rue, "set", { id: "@world", component: `roles:${pip}`, value: { role: "owner" } });
  row("CL6", () => ok(set?.ok && n.role === "builder" && n.can.generate && n.can.build && wc["role-defs"]?.builder?.can?.generate === true && again?.ok
    && wrote.filter((e: any) => e.kind === "change").length === 1 && wrote.filter((e: any) => e.kind === "act").length === 1 && JSON.stringify(wrote).includes(`roles:${rue}`) && !JSON.stringify(wrote).includes("role-defs"),
    "CL6 operator-repair set of another owner is one write (one act, one change), the role alone; builder keeps generate from the translation's role-defs", { set: set?.refused, n: n.permissions, rd: wc["role-defs"], wrote: wrote.map((e: any) => [e.kind, e.verb]) }));
}

{ // CL11 (fixF): the translation's ownerless lift (imported:ownerless) ends with the first owner; grants made after it count only while owned
  const root = scratch("owners-cl11"), W = path.join(root, "worlds"); fs.mkdirSync(path.join(root, "opt"), { recursive: true });
  v1(W, "loft", [["Pip", "spawn", { id: "c", lib: "x.glb" }]]);
  const OPAL = { EIDO_UPGRADER_ACCOUNT: "human:test:op", EIDO_UPGRADER_NAME: "Opal" };
  const u = upgrade(root, "loft", ["--claim"], OPAL), opal = u.roles.Opal?.[0] ?? "", xid = u.dir.resolve({ sub: "human:test:xan", name: "Xan" });   // known before the world opens
  const w = openLive(path.join(W, "loft"), "loft", { catalogue: ENGINE_CATALOGUE, scripts: null }), wc = () => w.state().entities["@world"].c;
  const lifted = "imported:ownerless" in wc();   // @30 wrote it; @31 doesn't
  const k = request(w, opal, "set", { id: "@world", component: "keep-owner", value: false }), g = request(w, opal, "set", { id: "@world", component: `roles:${xid}`, value: { role: "builder" } });
  const asOwner = R.roleIdOf(wc(), xid), leave = request(w, opal, "delete", { id: "@world", component: `roles:${opal}` });
  row("CL11", () => ok(u.up.code === 0 && !lifted && k?.ok && g?.ok && asOwner === "builder" && leave?.ok && !Object.keys(wc()).some((c) => c.startsWith("roles:") && R.isOwner(wc()[c])) && R.roleIdOf(wc(), xid) === "member" && R.roleIdOf(wc(), "u-newcomer000000000000") === "member",
    "CL11 claimed: the translation carries no imported:ownerless; a builder the owner granted, once the owner leaves (keep-owner false), reads member again, newcomers too", { code: u.up.code, lifted, k: k?.refused, g: g?.refused, asOwner, leave: leave?.refused, now: R.roleIdOf(wc(), xid) })); }

// ================= BN: a main-era ban still holds after the upgrade =================
{ const root = scratch("owners-bn"), W = path.join(root, "worlds"); fs.mkdirSync(path.join(root, "opt"), { recursive: true });
  principals(W, { "human:test:zed": ["Zed", "human"] });
  v1(W, "hall", [["world", "grant", { id: "Ann", role: "owner", sub: "human:test:ann" }], ["Ann", "ban", { id: "Zed", reason: "griefing" }], ["Ann", "ban", { id: "Nemo" }]]);
  const u = upgrade(root, "hall"); const zed = u.dir.resolve({ sub: "human:test:zed", name: "Zed" });
  const live = openLive(path.join(W, "hall"), "hall", { catalogue: ENGINE_CATALOGUE, scripts: null }); const B = Object.fromEntries((u.report?.bans ?? []).map((b) => [b.name, b]));
  row("BN1", () => ok(u.up.code === 0 && banOf(live, zed)?.reason === "griefing" && B.Zed?.account === "human:test" && /principals/.test(B.Zed?.from) && /check|someone else/.test(B.Zed?.check ?? "") && /^banned Zed: holds against their account/m.test(u.dry.out),
    "BN1 banned in main (a name nothing else in the log names) → after the upgrade that account is still banned (the authority's check, as at join); the approved report and the dry run list it, saying to check a by-name binding", { code: u.up.code, ban: banOf(live, zed), B, out: u.up.code ? u.up.out.slice(-400) : undefined }));
  row("BN2", () => ok(B.Nemo?.account === null && /no account/.test(B.Nemo?.why ?? "") && /operator-repair\.ts bind hall "Nemo"/.test(B.Nemo?.bind ?? ""),
    "BN2 a ban-only name main recorded no account for is listed unbound, with why and the bind command", B.Nemo));
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

// OR7/OR8 (#260 Stella q3): only the identity's own record in the world makes it bindable: an entry it wrote, a role, a ban or mute on it
{ const root = scratch("owners-or7"), W = path.join(root, "worlds"); fs.mkdirSync(path.join(root, "opt"), { recursive: true });
  v1(W, "yard", [["world", "grant", { id: "fable", role: "owner", sub: "human:test:fable" }], ["fable", "say", { text: "psst", to: "Echo" }],
    ["Talker", "say", { text: "hi" }], ["fable", "grant", { id: "Roley", role: "builder" }], ["fable", "ban", { id: "Banned" }]]);
  const u = upgrade(root, "yard"); const file = directoryFileIn(W), d0 = directoryAt(file);
  const mutey = d0.imported("Mutey"), modf = path.join(W, "yard", "world.mod.jsonl");
  fs.appendFileSync(modf, JSON.stringify({ ts: T0, actor: u.roles.fable?.[0], verb: "mute", who: mutey }) + "\n");
  const bind = (...a: string[]) => { const r = Bun.spawnSync(["bun", "tools/operator-repair.ts", "bind", ...a], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(root, "opt"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 30_000 });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  const echo = Object.entries<any>(JSON.parse(fs.readFileSync(file, "utf8")).ids).find(([, e]) => e.name === "Echo")?.[0];
  const before = fs.readFileSync(file, "utf8"), mod0 = fs.readFileSync(modf, "utf8");
  const r7 = [bind("yard", "Echo", "human:test:echo"), bind("yard", String(echo), "human:test:echo")];
  const still = fs.readFileSync(file, "utf8") === before && fs.readFileSync(modf, "utf8") === mod0;
  row("OR7", () => ok(u.up.code === 0 && !!echo && r7.every((r) => r.code === 1 && /nobody called/.test(r.out)) && still,
    "OR7 bind refuses an identity only another person's entry names (Echo, the recipient of fable's translated old speech), by name and by id, nothing changed", { code: u.up.code, echo, r7 }));
  const r8 = ["Talker", "Roley", "Banned", "Mutey"].map((n) => bind("yard", n, `human:test:${n.toLowerCase()}`));
  row("OR8", () => ok(r8.every((r) => r.code === 0 && /^bound /m.test(r.out)), "OR8 …while its own record makes it bindable: an entry it wrote (Talker), a role (Roley), a ban (Banned), a mute (Mutey)", r8.map((r) => r.out.slice(0, 160))));
  // OR9 (#260 Stella 10-30): an entry counts only if the reader accepts it; Kept's same row, valid, is the control
  const wl = path.join(W, "yard", "world.jsonl"), rows = fs.readFileSync(wl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const said = rows.find((e) => e.kind === "say"), ts = Math.max(...rows.map((e) => e.ts ?? 0)), d9 = directoryAt(file);
  const stray = d9.imported("Stray"), kept = d9.imported("Kept");
  fs.appendFileSync(wl, JSON.stringify({ ...said, actor: stray, ts: ts + 1, stray: true }) + "\n" + JSON.stringify({ ...said, actor: kept, ts: ts + 2 }) + "\n");
  const r9 = bind("yard", "Stray", "human:test:stray"), k9 = bind("yard", "Kept", "human:test:kept");
  row("OR9", () => ok(!!said && r9.code === 1 && /nobody called/.test(r9.out) && k9.code === 0 && /^bound /m.test(k9.out),
    "OR9 bind refuses an identity whose only entry the reader rejects (Stray: a parseable row with an unknown field); the same row, valid, makes Kept bindable", { said: !!said, r9, k9 }));
}

console.log(`[owners-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
