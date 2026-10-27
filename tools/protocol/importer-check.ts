// tools/protocol/importer-check.ts — the v1 importer (tools/protocol/import-v1/) against the house's review of #260
// (comment 6291883302, "the v1 importer"): each row names the item it holds, and each was red before its fix.
//   IM-I1   the approval act is written inside translate: every change's cause is the act it answers
//   IM-I25  the writer refuses an approval (validly countersigned) of a report that isn't this log's
//   IM-I34  the dry-run report counts the renames the real run makes (and its hash is the writer's)
//   IM-I6   a v1 ban (lowercased by the v1 fold) lands on the person the grant named, not a fresh identity
//   IM-I6b  …and two different names stay two people: v1 kept roles and acts under the exact name (Ann / ann. / ann_ /
//           A.N.N, two emoji, Ann and ann with two accounts); a lowered ban key that two names share stays its own
//   IM-H1   a long name and a raw name equal to its hashed form stay two (house 6340433633)
//   IM-I9   on a TRUST_NAMES server a person's acts and their grant are one identity (a child process)
//   IM-I5   a v1 agent's home-node sub is filed as the account its live join wears (aid1:<iss>:<sub>)
//   IM-I5b  an enrolled agent's home-node sub is filed as its enrolment's account (agent:token:<id>)
//   IM-I35  a failure after world.jsonl lands removes what it made: the error says nothing was written, and a rerun works
//   IM-I35b a model index that can't be written fails the translation with no identity added; a world.mod.jsonl or
//           poses.json that was already there gets its bytes back, and a destination directory that was there stays
//   IM-I10  the remembered places: a write that fails is reported, not counted; an unreadable file and dropped names are said
//   IM-I7   lines of the old log that don't parse are counted, in the report and in the result
//   IM-I15  a deferred feature removed on the old server (comp null, or the thing removed) no longer refuses
//   IM-C1/2 main #248's collision toggle → collider.enabled; its climb routes → climb children (the rest imported, listed)
//   IM-E1   main #248's environment → @world.spawn/bounds/sky.gradient/terrain (flat at the floor) + sun and particles things; the rest imported, listed
//   IM-E2   a floor where the world already has a terrain: the terrain kept, the floor listed as the conflict
//   IM-E3   (#248) a floor below @world.bounds.min.y lowers it to 2 m under the floor, listed under mapped
//   IM-E3   (#248) a floor below @world.bounds.min.y lowers it to 2 m under the floor, listed under mapped
//   IM-V1   main #248's vehicle → drive on its host + a helm child (station {action: 'drive', input: {move: 'drive'}, exit}); the rest imported, listed
//   IM-I36  a spin's rpm is read as the renderer read it ((rpm ?? 6) × 6, coerced); a rate that isn't a number is carried
//   IM-I37  a seat's yaw is read as the renderer read it (coerced); a yaw that can't turn is carried
//   IM-I13  a caption deed is a place in its screen's captioners; a stale or timed one stays carried
//   IM-I3   the old fold reads captions with main's frozen helpers (a window), and the translation holds its current line
//   IM-I3b  the old fold's whole import closure is frozen beside it (nothing it reads is a live runtime module)
//   IM-I14  a rest tick from an earlier epoch never dates a later epoch's rest
//   IM-I17  the oracle counts a lifted world's repairNeeded as a failure
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/importer-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratch } from "./common.ts";

const argv = process.argv.slice(2);
// IM-I9's child: one translation under TRUST_NAMES=1 (read at import), printed as JSON
if (argv[0] === "--child") {
  const { translateV1World } = await import("./import-v1/world.ts");
  try { const r = translateV1World(argv[1], argv[2]); console.log(JSON.stringify({ planned: r.planned, identities: r.identities })); }
  catch (x) { console.log(JSON.stringify({ error: String(x?.message ?? x) })); }
  process.exit(0);
}
delete process.env.TRUST_NAMES;   // the in-process rows run as a public server does
const W1 = await import("./import-v1/world.ts");
const TV1 = await import("./import-v1/translate-v1.js");
const { readLog, fold } = await import("../../shared/protocol/fold.js");
const { custodyAt } = await import("../../server/custody.ts");
const { custodyFileIn } = await import("../../server/keyfiles.ts");
const { HN_ISS } = await import("../../server/auth.ts");
const { emptyState: v1Empty, foldEntry: v1Fold } = await import("./import-v1/fold.js");

let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 600)}` : ""}`); } };
const row = (what: string, fn: () => void) => { try { fn(); } catch (e) { ok(false, what, `threw: ${e?.stack ?? e}`); } };
const root = scratch("importer");
let n = 0;
const T0 = 1790000000000;
const seqd = (L: any[]) => L.map((e, k) => ({ seq: k, ts: T0 + k * 1000, ...e }));
/** an old world dir in a fresh worlds dir: {src, dest, worlds} */
function oldWorld(L: any[], { raw = null as string | null, poses = null as any } = {}) {
  const worlds = path.join(root, `w${++n}`, "worlds"); const src = path.join(worlds, "old"); fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "log.jsonl"), raw ?? seqd(L).map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (poses !== null) fs.writeFileSync(path.join(src, "poses.json"), typeof poses === "string" ? poses : JSON.stringify(poses));
  return { src, dest: path.join(worlds, "new"), worlds };
}
const approvalFor = (w: any, report: string) => { const cust = custodyAt(custodyFileIn(w.worlds));
  return W1.makeApproval("new", report, { operator: { key: cust.operator(), sign: (m: string) => cust.signOperator(m) } }); };
/** one translation in a child process, under `env` (read at import: TRUST_NAMES, AGENT_TOKENS_PATH, OPT_DIR, EIDOVERSE_DIR) */
const child = (w: any, env: Record<string, string>) => { const p = Bun.spawnSync(["bun", import.meta.path, "--child", w.src, w.dest], { env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...env }, stdout: "pipe", stderr: "pipe" });
  try { return JSON.parse(p.stdout.toString().trim().split("\n").pop()!); } catch { return { err: p.stderr.toString().slice(-400) }; } };
const linesOf = (dest: string) => readLog(fs.readFileSync(path.join(dest, "world.jsonl"), "utf8"));
const threw = (f: () => any) => { try { f(); return null; } catch (x) { return String(x?.message ?? x); } };

const BASIC = [
  { actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
  { actor: "world", verb: "grant", args: { id: "Ann", role: "owner", sub: "human:discord:111" } },
  { actor: "Ann", verb: "spawn", args: { id: "table", lib: "a.glb", pos: [1, 0, 1] } },
  { actor: "Ann", verb: "comp", args: { id: "table", type: "label", data: "the old table" } },
  { actor: "Bob", verb: "say", args: { text: "hello" } },
  { actor: "Ann", verb: "place", args: { id: "table", pos: [2, 0, 2] } }];

// ---- IM-I1, IM-I25, IM-I34: the approval and the report it binds ----
row("IM-I1", () => {
  const w = oldWorld(BASIC); const { hash } = W1.reportV1World(w.src, { name: "new" });
  W1.translateV1World(w.src, w.dest, { approval: approvalFor(w, hash) });
  const L = linesOf(w.dest); const at = L.findIndex((e: any) => e.verb === "translation-approved");
  const bad = L.map((e: any, i: number) => [e, i]).filter(([e]: any) => e.kind === "change" && Number.isInteger(e.cause))
    .filter(([e]: any) => { const c = L[e.cause]; return !c || !(c.kind === "act" || c.kind === "say") || c.actor !== e.actor || c.verb === "translation-approved" || (c.ts ?? 0) !== (e.ts ?? 0); })
    .map(([e, i]: any) => ({ at: i, cause: e.cause, causeIs: L[e.cause]?.verb, actor: e.actor }));
  ok(at === 3 && L[2].verb === "repair-shapes" && L.some((e: any) => e.kind === "change") && !bad.length,
    "IM-I1 with an approval, translation-approved sits right after repair-shapes and every change's cause is the act it answers (its actor and time)", { at, bad });
});
row("IM-I25", () => {
  const w = oldWorld(BASIC); const other = oldWorld([...BASIC, { actor: "Ann", verb: "remove", args: { id: "table" } }]);
  const stale = W1.reportV1World(other.src, { name: "new" }).hash;
  const why = threw(() => W1.translateV1World(w.src, w.dest, { approval: approvalFor(w, stale) }));
  ok(why && /approval is refused/.test(why) && why.includes(stale) && /Nothing written/.test(why) && !fs.existsSync(w.dest),
    "IM-I25 a validly countersigned approval of another log's report is refused by the writer, both hashes named, nothing written", why);
  const good = W1.reportV1World(w.src, { name: "new" }).hash;
  ok(!threw(() => W1.translateV1World(w.src, w.dest, { approval: approvalFor(w, good) })), "IM-I25 …and the approval of this log's report translates (control)");
});
row("IM-I34", () => {
  const L = [BASIC[0], { actor: "world", verb: "grant", args: { id: "ann", role: "owner" } }, { actor: "ann", verb: "spawn", args: { id: "cup", lib: "c.glb", pos: [0, 0, 0] } }, { actor: "bob", verb: "say", args: { text: "hi" } }];
  const w = oldWorld(L); const rep = W1.reportV1World(w.src, { name: "new" });
  const r = W1.translateV1World(w.src, w.dest, { approval: approvalFor(w, rep.hash) });
  ok(rep.report.actorsRenamed === r.stats.renamed && r.stats.renamed === 2 && W1.reportV1World(w.src, { name: "new" }).hash === rep.hash,
    "IM-I34 the dry-run report counts the renames the real run makes (every person becomes an identity), and its hash is stable", { report: rep.report.actorsRenamed, real: r.stats.renamed });
});

// ---- IM-I6, IM-I9, IM-I5: one person, one identity ----
row("IM-I6", () => {
  const w = oldWorld([BASIC[0], { actor: "world", verb: "grant", args: { id: "Zed", role: "builder", sub: "human:discord:9" } },
    { actor: "Zed", verb: "spawn", args: { id: "box", lib: "b.glb", pos: [0, 0, 0] } }, { actor: "world", verb: "ban", args: { id: "Zed", reason: "spam" } }]);
  const r = W1.translateV1World(w.src, w.dest);
  const c = fold(linesOf(w.dest)).entities["@world"].c;
  const role = Object.keys(c).find((k) => k.startsWith("roles:"))?.slice(6), ban = Object.keys(c).find((k) => k.startsWith("imported-bans:"))?.slice(14);
  ok(r.identities === 1 && role && role === ban, "IM-I6 the v1 fold's lowercased ban ('zed') lands on Zed's identity, the one his grant made: one person, one identity", { identities: r.identities, role, ban, planned: r.planned });
});
row("IM-I6b", () => {
  const G = (id: string, role: string, sub?: string) => ({ actor: "world", verb: "grant", args: { id, role, ...(sub ? { sub } : {}) } });
  const S = (actor: string, id: string) => ({ actor, verb: "spawn", args: { id, lib: "x.glb", pos: [0, 0, 0] } });
  const run = (L: any[]) => { const w = oldWorld([BASIC[0], ...L]); const r = W1.translateV1World(w.src, w.dest); const ls = linesOf(w.dest);
    const c = fold(ls).entities["@world"].c; const actor = (id: string) => ls.find((e: any) => e.body?.verb === "spawn" && e.body?.args?.id === id)?.actor;
    const nameOf = (id: string) => r.planned[id]?.name; const subsOf = (id: string) => r.planned[id]?.subs ?? [];
    return { r, c, actor, nameOf, subsOf, roleOf: (id: string) => c[`roles:${id}`]?.role }; };
  const a = run([G("Ann", "owner", "human:discord:111"), G("ann.", "visitor")]);
  const ids = Object.keys(a.c).filter((k) => k.startsWith("roles:")).map((k) => k.slice(6));
  const ann = ids.find((i) => a.nameOf(i) === "Ann"), dot = ids.find((i) => a.nameOf(i) === "ann.");
  ok(a.r.identities === 2 && ann && dot && a.roleOf(ann) === "owner" && a.roleOf(dot) === "inhabitant", "IM-I6b Ann (owner, an account) and a later grant to 'ann.' are two people: Ann stays owner", { n: a.r.identities, roles: ids.map((i) => [a.nameOf(i), a.roleOf(i)]) });
  const b = run([G("Ann", "owner", "human:discord:111"), S("Ann", "p1"), S("ann_", "p2"), S("A.N.N", "p3")]);
  ok(b.r.identities === 3 && new Set([b.actor("p1"), b.actor("p2"), b.actor("p3")]).size === 3 && b.subsOf(b.actor("p1")!).includes("human:discord:111") && !b.subsOf(b.actor("p2")!).length,
    "IM-I6b acts by 'ann_' and 'A.N.N' are not Ann's: three names, three people", { n: b.r.identities, p: [b.actor("p1"), b.actor("p2"), b.actor("p3")] });
  const e = run([S("🦊", "f"), S("🐺", "g")]);
  ok(e.r.identities === 2 && e.actor("f") !== e.actor("g") && e.nameOf(e.actor("f")!) === "🦊", "IM-I6b two names of symbols only (two emoji) are two people, never one empty key", { n: e.r.identities, names: Object.values<any>(e.r.planned).map((x) => x.name) });
  const t = run([G("Ann", "owner", "human:discord:111"), G("ann", "builder", "human:discord:222"), S("Ann", "q1"), S("ann", "q2")]);
  ok(t.r.identities === 2 && t.subsOf(t.actor("q1")!).includes("human:discord:111") && t.subsOf(t.actor("q2")!).includes("human:discord:222"),
    "IM-I6b Ann (one account) and ann (another): each one's acts land on their own account", { q1: t.subsOf(t.actor("q1")!), q2: t.subsOf(t.actor("q2")!) });
  const z = run([S("Zed", "z1"), S("ZED", "z2"), { actor: "world", verb: "ban", args: { id: "Zed" } }]);
  const ban = Object.keys(z.c).find((k) => k.startsWith("imported-bans:"))?.slice(14);
  ok(z.r.identities === 3 && ban && ban !== z.actor("z1") && ban !== z.actor("z2") && z.nameOf(ban) === "zed",
    "IM-I6b a ban key the v1 fold lowercased ('zed') that two names share (Zed, ZED) is not pinned on either: it stays its own", { n: z.r.identities, ban, names: Object.values<any>(z.r.planned).map((x) => x.name) });
});
// house 6340433633: a name already in the hashed form h--<61 hex> isn't kept as an id by the translator (old logs never held
// one): a long name and a raw name equal to its hashed form are two people, and two things
row("IM-H1", () => {
  const long = "Marigold Thorne, keeper of the very long lantern road", hashed = `h--${new Bun.CryptoHasher("sha256").update(long).digest("hex").slice(0, 61)}`;
  const S = (actor: string, id: string) => ({ actor, verb: "spawn", args: { id, lib: "x.glb", pos: [0, 0, 0] } });
  const w = oldWorld([BASIC[0], S(long, "p1"), S(hashed, "p2"), S("Ann", long), S("Ann", hashed)]); const r = W1.translateV1World(w.src, w.dest); const ls = linesOf(w.dest);
  const actor = (id: string) => ls.find((e: any) => e.body?.verb === "spawn" && e.body?.args?.id === id)?.actor;
  const things = Object.keys(fold(ls).entities).filter((k) => k !== "@world");
  ok(TV1.enc(long) === hashed && r.identities === 3 && actor("p1") && actor("p2") && actor("p1") !== actor("p2") && things.length === 4 && new Set(things).size === 4,
    "IM-H1 a long name and a raw name equal to its hashed form are two people, and two things of those ids are two things", { n: r.identities, p1: actor("p1"), p2: actor("p2"), things }); });
row("IM-I9", () => {
  const w = oldWorld([BASIC[0], { actor: "world", verb: "grant", args: { id: "Ann", role: "owner", sub: "human:discord:111" } },
    { actor: "Ann", verb: "spawn", args: { id: "lamp", lib: "l.glb", pos: [0, 0, 0] } }]);
  const p = Bun.spawnSync(["bun", import.meta.path, "--child", w.src, w.dest], { env: { ...process.env, TRUST_NAMES: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe" });
  let out: any = null; try { out = JSON.parse(p.stdout.toString().trim().split("\n").pop()!); } catch { out = { err: p.stderr.toString().slice(-400) }; }
  const L = fs.existsSync(path.join(w.dest, "world.jsonl")) ? linesOf(w.dest) : [];
  const actor = L.find((e: any) => e.body?.verb === "spawn")?.actor; const c = L.length ? fold(L).entities["@world"].c : {};
  const role = Object.keys(c).find((k) => k.startsWith("roles:"))?.slice(6);
  ok(out?.identities === 1 && actor && actor === role, "IM-I9 on a TRUST_NAMES server Ann's acts and her grant are one identity (the name's binding comes before local:<name>)", { out, actor, role });
});
row("IM-I5", () => {
  const w = oldWorld([BASIC[0], { actor: "world", verb: "grant", args: { id: "Moth", role: "builder", sub: "agent:moth@home.test" } },
    { actor: "Moth", verb: "spawn", args: { id: "m", lib: "m.glb", pos: [0, 0, 0] } }]);
  const r = W1.translateV1World(w.src, w.dest); const subs = Object.values<any>(r.planned).flatMap((e) => e.subs);
  ok(r.identities === 1 && JSON.stringify(subs) === JSON.stringify([`aid1:${HN_ISS}:agent:moth@home.test`]),
    "IM-I5 a v1 agent's home-node sub is filed as the account a live join from this host's home node wears (aid1:<iss>:<sub>)", subs);
});

row("IM-I5b", () => {
  const w = oldWorld([BASIC[0], { actor: "world", verb: "grant", args: { id: "Moth", role: "builder", sub: "agent:moth@home.test" } }, { actor: "Moth", verb: "spawn", args: { id: "m", lib: "m.glb", pos: [0, 0, 0] } }]);
  const tok = path.join(w.worlds, "tokens.json"); fs.writeFileSync(tok, JSON.stringify({ "tok-moth": { id: "Moth", subs: ["agent:moth@home.test"] } }));
  const out = child(w, { AGENT_TOKENS_PATH: tok }); const subs = Object.values<any>(out.planned ?? {}).flatMap((e) => e.subs);
  ok(out.identities === 1 && JSON.stringify(subs) === JSON.stringify(["agent:token:moth"]), "IM-I5b an enrolled agent's home-node sub is filed as its enrolment's account (agent:token:<id>), the one its live join wears", out);
});

// ---- IM-I35, IM-I10, IM-I7: what a translation writes, and says ----
row("IM-I35", () => {
  const w = oldWorld([...BASIC, { actor: "Ann", verb: "ban", args: { id: "Troll", reason: "spam" } }]);
  fs.mkdirSync(path.join(w.dest, "world.mod.jsonl"), { recursive: true });   // the ban's file can't be written: a failure after world.jsonl lands
  const why = threw(() => W1.translateV1World(w.src, w.dest));
  const dirf = path.join(w.worlds, ".directory.json"); const ids = fs.existsSync(dirf) ? Object.keys(JSON.parse(fs.readFileSync(dirf, "utf8")).ids ?? {}) : [];
  ok(why && /Nothing written/.test(why) && !fs.existsSync(path.join(w.dest, "world.jsonl")) && !ids.length,
    "IM-I35 a failure after world.jsonl landed removes it again, adds no identity, and says nothing was written", { why, left: fs.existsSync(w.dest) ? fs.readdirSync(w.dest) : null });
  fs.rmSync(path.join(w.dest, "world.mod.jsonl"), { recursive: true });
  ok(!threw(() => W1.translateV1World(w.src, w.dest)), "IM-I35 …so a rerun isn't refused as 'already holds a world', and translates");
});
row("IM-I35b", () => {
  const lib = path.join(root, `lib${++n}`), opt = path.join(root, `opt${n}`); fs.mkdirSync(lib, { recursive: true }); fs.mkdirSync(path.join(opt, "eido-index.json"), { recursive: true });
  fs.writeFileSync(path.join(lib, "a.glb"), "glTF stand-in bytes " + n);
  const w = oldWorld(BASIC);   // BASIC spawns a.glb: its bytes are on this host, so the model index is written
  const out = child(w, { OPT_DIR: opt, EIDOVERSE_DIR: lib }); const dirf = path.join(w.worlds, ".directory.json");
  const ids = fs.existsSync(dirf) ? Object.keys(JSON.parse(fs.readFileSync(dirf, "utf8")).ids ?? {}) : [];
  ok(/Nothing written/.test(out.error ?? "") && !ids.length && !fs.existsSync(path.join(w.dest, "world.jsonl")), "IM-I35b a model index that can't be written fails the translation with no identity in the directory and no world.jsonl", { out, ids });
  const v = oldWorld([...BASIC, { actor: "Ann", verb: "ban", args: { id: "Troll" } }], { poses: { Ann: { p: [1, 0, 1] } } });
  fs.mkdirSync(v.dest, { recursive: true }); const MOD = JSON.stringify({ ts: T0, actor: "system", verb: "ban", who: "u-aaaaaaaaaaaaaaaaaaaa" }) + "\n"; fs.writeFileSync(path.join(v.dest, "world.mod.jsonl"), MOD); fs.writeFileSync(path.join(v.dest, "poses.json"), "POSES-BEFORE");
  const out2 = child(v, { OPT_DIR: opt, EIDOVERSE_DIR: lib });
  ok(/Nothing written/.test(out2.error ?? "") && fs.existsSync(v.dest) && fs.readFileSync(path.join(v.dest, "world.mod.jsonl"), "utf8") === MOD && /couldn't|EISDIR|EPERM/.test(out2.error ?? "") && fs.readFileSync(path.join(v.dest, "poses.json"), "utf8") === "POSES-BEFORE" && !fs.existsSync(path.join(v.dest, "world.jsonl")),
    "IM-I35b …a world.mod.jsonl and poses.json already there get their bytes back, and the destination directory that was there stays", { out2, left: fs.existsSync(v.dest) ? fs.readdirSync(v.dest) : null });
  const e = oldWorld([...BASIC, { actor: "Ann", verb: "ban", args: { id: "Troll" } }]); fs.mkdirSync(e.dest, { recursive: true });
  child(e, { OPT_DIR: opt, EIDOVERSE_DIR: lib });
  ok(fs.existsSync(e.dest) && !fs.readdirSync(e.dest).length, "IM-I35b …and an empty destination directory that was there is left there, empty", fs.existsSync(e.dest) ? fs.readdirSync(e.dest) : "removed");
});
row("IM-I10", () => {
  const w = oldWorld(BASIC, { poses: { Ann: { p: [1, 0, 1] }, Nobody: { p: [0, 0, 0] } } });
  fs.mkdirSync(path.join(w.dest, "poses.json"), { recursive: true });   // the place file can't be written
  const r = W1.translateV1World(w.src, w.dest);
  ok(r.poses === 0 && /couldn't be written/.test(r.posesUnread ?? "") && r.posesDropped === 1, "IM-I10 a places file that can't be written is reported (posesUnread), not counted as carried; the name nobody knew is counted as dropped", { poses: r.poses, unread: r.posesUnread, dropped: r.posesDropped });
  const u = oldWorld(BASIC, { poses: "{not json" }); const ru = W1.translateV1World(u.src, u.dest);
  ok(ru.poses === 0 && /couldn't be read/.test(ru.posesUnread ?? ""), "IM-I10 an unreadable poses.json is said, not silent", ru.posesUnread);
});
row("IM-I7", () => {
  const text = seqd(BASIC).map((e) => JSON.stringify(e)).join("\n") + "\n{torn line\n";
  const w = oldWorld([], { raw: text }); const rep = W1.reportV1World(w.src, { name: "new" }); const r = W1.translateV1World(w.src, w.dest, { approval: approvalFor(w, rep.hash) });
  ok(rep.report.source.unparsedLines === 1 && r.unparsed === 1 && r.source.unparsedLines === 1, "IM-I7 a line that doesn't parse is counted in the report the operator approves and in the result", { report: rep.report.source, result: r.unparsed });
});

// ---- IM-I15: the deferred refusal's remedy works ----
row("IM-I15", () => {
  const route = { boxes: [{ center: [0, 0, 0], size: [2, 2, 2] }] };   // an air box on @world: the one use still deferred (no frame to hold it)
  const set = [BASIC[0], { actor: "Ann", verb: "spawn", args: { id: "pool", lib: "p.glb", pos: [0, 0, 0] } }, { actor: "Ann", verb: "comp", args: { id: "@world", type: "air", data: route } }];
  const L1 = seqd([...set, { actor: "Ann", verb: "comp", args: { id: "@world", type: "air", data: null } }]);
  const L2 = seqd([...set, { actor: "Ann", verb: "remove", args: { id: "@world" } }]);
  const L3 = seqd(set);
  const L4 = seqd([...set, { actor: "Ann", verb: "comp", args: { id: "@world", type: "air", data: null } }, { actor: "Ann", verb: "comp", args: { id: "@world", type: "air", data: route } }]);
  const d = [L1, L2, L3, L4].map((L) => TV1.deferredFeatures(L));
  ok(d[0].length === 0 && d[1].length === 0 && d[2].length === 1 && d[2][0].seq === 2 && d[3].length === 1 && d[3][0].seq === 4,
    "IM-I15 an air box on @world removed later (comp null, or removed) no longer refuses; one still standing does, naming the use that stands", d.map((x) => x.map((u) => u.seq)));
});

// ---- IM-W: main #248's water volume and air boxes translate (zone + water / water-exclusion); traversal, vehicle, collision still refuse ----
row("IM-W1", () => {
  const water = { center: [0, -2, 0], size: [10, 4, 10], absorption: [0.1, 0.036, 0.018], scatter: [0.014, 0.11, 0.17], speed: 2.4, waves: [{ amplitude: 0.3, wavelength: 12, direction: [1, 0], phase: 0 }] };
  const L = seqd([BASIC[0], { actor: "Ann", verb: "spawn", args: { id: "pool", lib: "p.glb", pos: [5, 0, 0], yaw: 0.5 } }, { actor: "Ann", verb: "comp", args: { id: "pool", type: "water", data: water } },
    { actor: "Ann", verb: "spawn", args: { id: "pond", pos: [20, 0, 0] } }, { actor: "Ann", verb: "comp", args: { id: "pond", type: "water", data: { center: [0, 0, 0], size: [4, 2, 4] } } }]);
  const r = TV1.translate(L), T = r.final.translated, kid = T[TV1.waterChildId("pool")];
  const sigma = kid?.water?.attenuationColor?.map((c: number) => -Math.log(c) / kid.water.attenuationDistance);
  ok(TV1.deferredFeatures(L).length === 0 && r.stats.divergences === 0 && !T.pool.water && !T.pool.zone && kid?.parent?.to === "pool" && JSON.stringify(kid.transform.pos) === "[0,-2,0]"
    && JSON.stringify(kid.zone) === JSON.stringify({ shape: "box", size: [10, 4, 10] }) && sigma?.every((x: number, i: number) => Math.abs(x - water.absorption[i]) < 1e-15) && JSON.stringify(kid.water.scatterColor) === JSON.stringify(water.scatter)
    && JSON.stringify(kid.water.waves) === JSON.stringify(water.waves) && kid["imported:water"]?.speed === 2.4 && JSON.stringify(T.pond.zone) === JSON.stringify({ shape: "box", size: [4, 2, 4] }) && !!T.pond.water,
    "IM-W1 a water volume on a thing with a model becomes a child at its centre with zone {box, size} + water (σ as attenuationColor e^−σ over 1 m, scatter as scatterColor, waves as they were, speed in imported:water); on a bare thing at its origin, the thing itself", { pool: T.pool, kid, pond: T.pond, mapped: r.stats.mapped });
});
row("IM-W2", () => {
  const q = [0, Math.sin(0.3), 0, Math.cos(0.3)];
  const L = seqd([BASIC[0], { actor: "Ann", verb: "spawn", args: { id: "sub", lib: "s.glb", pos: [0, -10, 0] } },
    { actor: "Ann", verb: "comp", args: { id: "sub", type: "air", data: { boxes: [{ center: [0, 0, -2], size: [2, 2, 4] }, { center: [0, 1, 3], size: [1, 1, 1], q }] } } }]);
  const r = TV1.translate(L), T = r.final.translated, a0 = T[TV1.airChildId("sub", 0)], a1 = T[TV1.airChildId("sub", 1)];
  ok(TV1.deferredFeatures(L).length === 0 && r.stats.divergences === 0 && !("air" in T.sub) && !Object.keys(T.sub).some((k) => /air/.test(k))
    && a0?.parent?.to === "sub" && JSON.stringify(a0.zone) === JSON.stringify({ shape: "box", size: [2, 2, 4], priority: TV1.AIR_PRIORITY }) && JSON.stringify(a0["water-exclusion"]) === "{}" && JSON.stringify(a0.transform.pos) === "[0,0,-2]"
    && a1 && a1.transform.q.every((x: number, i: number) => Math.abs(x - q[i]) < 1e-12) && TV1.AIR_PRIORITY === 1
    && JSON.stringify(r.stats.mapped?.map((m: any) => [m.component, m.id, m.into.length])) === JSON.stringify([["air", "sub", 2]]),
    "IM-W2 an air {boxes} becomes one child per box: zone {box, size, priority 1 (above the bodies)} + water-exclusion {}, its centre and q its transform; the report's mapped lists them", { sub: T.sub, a0, a1, mapped: r.stats.mapped });
});
row("IM-W3", () => {
  const L = seqd([BASIC[0], { actor: "Ann", verb: "spawn", args: { id: "boat", lib: "b.glb", pos: [0, 0, 0] } },
    { actor: "Ann", verb: "comp", args: { id: "boat", type: "water", data: { center: [0, 0, 0], size: [4, 2, 4] } } }, { actor: "Ann", verb: "comp", args: { id: "boat", type: "air", data: { boxes: [{ center: [0, 0, 0], size: [1, 1, 1] }] } } },
    { actor: "Ann", verb: "comp", args: { id: "boat", type: "traversal", data: { routes: [] } } }, { actor: "Ann", verb: "comp", args: { id: "boat", type: "vehicle", data: { helm: [0, 0, 0] } } },
    { actor: "Ann", verb: "comp", args: { id: "boat", type: "collision", data: { enabled: false } } }]);
  const got = TV1.deferredFeatures(L).map((u: any) => u.component);
  ok(JSON.stringify(got) === JSON.stringify([]) && JSON.stringify(Object.keys(TV1.DEFERRED)) === JSON.stringify([]),
    "IM-W3 water, air, traversal, vehicle and collision are no longer deferred: DEFERRED is empty (only a volume on @world, which has no frame, still refuses)", got);
});
row("IM-V1", () => {
  const veh = { helm: [0, -1.7, -2.1], exit: [0, -1.7, -3.2], speed: 4, turnRate: 0.4, minY: -230, maxY: -4, probes: [[0, 0, 0], [2, 0, -10]] };
  const L = seqd([BASIC[0], { actor: "Ann", verb: "spawn", args: { id: "sub", lib: "s.glb", pos: [26, -18, 60], yaw: 1 } }, { actor: "Ann", verb: "comp", args: { id: "sub", type: "vehicle", data: veh } },
    { actor: "Ann", verb: "spawn", args: { id: "raft", lib: "r.glb", pos: [0, 0, 0] } }, { actor: "Ann", verb: "comp", args: { id: "raft", type: "vehicle", data: { helm: [0, 0.5, 0], speed: 99, turnRate: 0 } } }]);
  const r = TV1.translate(L), T = r.final.translated, h = T[TV1.helmChildId?.("sub")], h2 = T[TV1.helmChildId?.("raft")];
  ok(r.stats.divergences === 0 && JSON.stringify(T.sub?.drive) === JSON.stringify({ maxSpeed: 4, turnRate: 0.4, climbRate: 4 }) && !("vehicle" in (T.sub ?? {}))
    && JSON.stringify(T.sub["imported:vehicle"]) === JSON.stringify({ minY: -230, maxY: -4, probes: veh.probes })
    && h?.parent?.to === "sub" && h.socket?.name === "helm" && JSON.stringify(h.transform?.pos) === JSON.stringify(veh.helm) && h.station?.action === "drive" && JSON.stringify(h.station.input) === JSON.stringify({ move: "drive" }) && h.station.leaveBy === "menu" && JSON.stringify(h.station.exit) === JSON.stringify(veh.exit)
    && JSON.stringify(T.raft?.drive) === JSON.stringify({ maxSpeed: 15, turnRate: 0.1, climbRate: 15 }) && h2 && h2.station.exit === undefined
    && r.stats.mapped?.some((m: any) => m.component === "vehicle" && m.id === "sub" && m.into.length === 2)
    && JSON.stringify(r.stats.unmapped?.find((u: any) => u.component === "vehicle" && u.id === "sub")?.fields) === JSON.stringify(["minY", "maxY", "probes"]),
    "IM-V1 a vehicle becomes drive on its host (speed → maxSpeed, turnRate, climbRate = speed, main's clamps) + a helm child (a socket at helm, station {action: 'drive', input: {move: 'drive'}, leaveBy: 'menu' (Space rises, as main's), exit}); minY, maxY and probes ride imported:vehicle, listed under unmapped",
    { sub: T.sub, h, raft: T.raft, h2, mapped: r.stats.mapped, unmapped: r.stats.unmapped });
});
// ---- IM-C / IM-E: main #248's collision toggle, climb routes and environment, each to its home ----
row("IM-C1", () => {
  const L = seqd([BASIC[0], { actor: "Ann", verb: "spawn", args: { id: "rock", lib: "r.glb", pos: [0, 0, 0] } }, { actor: "Ann", verb: "comp", args: { id: "rock", type: "collider", data: { shape: "box" } } },
    { actor: "Ann", verb: "comp", args: { id: "rock", type: "collision", data: { enabled: false } } },
    { actor: "Ann", verb: "spawn", args: { id: "post", lib: "p.glb", pos: [2, 0, 0] } }, { actor: "Ann", verb: "comp", args: { id: "post", type: "collision", data: { enabled: true, layer: 3 } } }]);
  const r = TV1.translate(L), T = r.final.translated;
  ok(r.stats.divergences === 0 && JSON.stringify(T.rock.collider) === JSON.stringify({ shape: "box", enabled: false }) && !Object.keys(T.rock).some((k) => /collision/.test(k))
    && T.post.collider === undefined && JSON.stringify(T.post["imported:collision"]) === JSON.stringify({ enabled: true, layer: 3 })
    && JSON.stringify(r.stats.unmapped) === JSON.stringify([{ component: "collision", id: "post", fields: ["layer"], as: "post imported:collision" }]),
    "IM-C1 collision {enabled: false} becomes collider {enabled: false} beside its shape; enabled: true is the default; anything else it said rides imported:collision and the report lists it", { rock: T.rock, post: T.post, unmapped: r.stats.unmapped });
});
row("IM-C2", () => {
  const routes = [{ name: "hatch ladder", path: [[0, -3, -15], [0, -1.5, -15], [0, -1.7, -16.8]], radius: 1.6, speed: 1.25, grip: "rungs" }, { name: "rope", path: [[0, 0, 0], [0, 9, 0]], radius: 9, speed: 0.1 }, { name: "bad", path: [[0, 0, 0]] }];
  const L = seqd([BASIC[0], { actor: "Ann", verb: "spawn", args: { id: "sub", lib: "s.glb", pos: [0, -10, 0] } }, { actor: "Ann", verb: "comp", args: { id: "sub", type: "traversal", data: { routes } } }]);
  const r = TV1.translate(L), T = r.final.translated, c0 = T[TV1.climbChildId("sub", 0)], c1 = T[TV1.climbChildId("sub", 1)];
  ok(r.stats.divergences === 0 && TV1.deferredFeatures(L).length === 0 && c0?.parent?.to === "sub" && c0.label === "hatch ladder" && JSON.stringify(c0.climb) === JSON.stringify({ points: routes[0].path, reach: 1.6, speed: 1.25 })
    && JSON.stringify(c0["imported:climb"]) === JSON.stringify({ grip: "rungs" }) && c1?.climb?.reach === 3 && c1.climb.speed === 0.3 && !T[TV1.climbChildId("sub", 2)]
    && JSON.stringify(T.sub["imported:traversal"]) === JSON.stringify({ routes: [routes[2]] }) && !("traversal" in T.sub)
    && r.stats.mapped?.some((m: any) => m.component === "traversal" && m.into.length === 2) && r.stats.unmapped?.some((u: any) => u.component === "traversal" && u.id === "sub"),
    "IM-C2 each route becomes a child with climb {points (path), reach (radius, main's 0.3..3), speed (main's 0.3..4)} and label (name); a route no climb holds rides imported:traversal, listed", { c0, c1, sub: T.sub, mapped: r.stats.mapped, unmapped: r.stats.unmapped });
});
row("IM-E1", () => {
  const env = { floor: -260, spawn: [-29, -25, 89], particles: { count: 1400, range: 16, size: 0.018, color: "#aec8b4" }, sky: { horizon: "#bedce6", zenith: "#338ac1", sunIntensity: 3, ambient: 1.5 }, bounds: { min: [-800, -250, -800], max: [800, 100, 800] }, fogDensity: 0.2 };
  const L = seqd([BASIC[0], { actor: "Ann", verb: "spawn", args: { id: "land", lib: "t.glb", pos: [0, 0, 0] } }, { actor: "Ann", verb: "comp", args: { id: "land", type: "environment", data: env } },
    { actor: "Ann", verb: "spawn", args: { id: "zz", lib: "t.glb", pos: [0, 0, 0] } }, { actor: "Ann", verb: "comp", args: { id: "zz", type: "environment", data: { spawn: [1, 2, 3] } } }]);
  const r = TV1.translate(L), T = r.final.translated, W = T["@world"];
  const floorKid = T[TV1.envChildId("land", "floor")], sun = T[TV1.envChildId("land", "sun")], fx = T[TV1.envChildId("land", "particles")], sp2 = T[TV1.envChildId("zz", "spawn")];
  const lin = (h: number) => [16, 8, 0].map((k) => { const x = ((h >> k) & 255) / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  const near = (a: number[], b: number[]) => a?.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-5);
  const toward = sun ? (() => { const [x, y, z, w] = sun.transform.q; return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)]; })() : [];
  const d = Math.hypot(0.4, 0.8, 0.2);
  ok(r.stats.divergences === 0 && JSON.stringify(W.spawn) === JSON.stringify({ pos: [-29, -25, 89] }) && JSON.stringify(W.bounds) === JSON.stringify({ min: [-800, -262, -800], max: [800, 100, 800] })
    && near(W.sky?.gradient?.top, lin(0x338ac1)) && near(W.sky?.gradient?.horizon, lin(0xbedce6)) && W.sky.gradient.bottom === undefined
    && JSON.stringify(W.terrain) === JSON.stringify({ kind: "flat", height: -260 }) && floorKid === undefined && !Object.values(T).some((c: any) => c?.label === "floor")
    && sun?.light?.kind === "directional" && sun.light.color === 0xfff4df && sun.light.intensity === 3 && near(toward, [0.4 / d, 0.8 / d, 0.2 / d])
    && fx?.parent?.to === "land" && JSON.stringify(fx.particles) === JSON.stringify({ effect: "dust", params: { count: 600, size: 0.018, area: 8 } })
    && sp2?.["spawn-point"] && JSON.stringify(sp2.transform.pos) === "[1,2,3]" && !("environment" in T.land) && !Object.keys(T.land).some((k) => /^[^:]*\/environment/.test(k))
    && JSON.stringify(T.land["imported:environment"]) === JSON.stringify({ sky: { ambient: 1.5 }, particles: { count: 1400, range: 16, color: "#aec8b4" }, fogDensity: 0.2 })
    && JSON.stringify(r.stats.unmapped?.find((u: any) => u.component === "environment")?.fields) === JSON.stringify(["sky.ambient", "particles.count, particles.range, particles.color", "fogDensity"]),
    "IM-E1 environment: spawn → @world.spawn (a second one a spawn-point thing), bounds → @world.bounds (its min.y under the floor: IM-E3), floor → @world.terrain {kind: 'flat', height: floor} (no floor thing), sky → @world.sky.gradient (linear) + a directional sun thing (main's defaults), particles → a dust child; ambient, clamped particle values and unknown keys ride imported:environment, each listed in the report",
    { W: { spawn: W.spawn, bounds: W.bounds, sky: W.sky, terrain: W.terrain }, floorKid, sun, fx, sp2, land: T.land, unmapped: r.stats.unmapped });
});
row("IM-E2", () => {
  const L = seqd([BASIC[0], { actor: "Ann", verb: "terrain", args: { seed: 7, amplitude: 2 } }, { actor: "Ann", verb: "spawn", args: { id: "land", lib: "t.glb", pos: [0, 0, 0] } },
    { actor: "Ann", verb: "comp", args: { id: "land", type: "environment", data: { floor: -40 } } }]);
  const r = TV1.translate(L), T = r.final.translated, W = T["@world"];
  ok(W.terrain?.seed === 7 && W.terrain.kind !== "flat" && T.land?.["imported:environment"]?.floor === -40
    && JSON.stringify(r.stats.unmapped?.find((u: any) => u.component === "environment")?.fields) === JSON.stringify(["floor (the world already has a terrain)"]),
    "IM-E2 a floor in a world that already has a terrain: the terrain is kept, the floor rides imported:environment and the report lists the conflict under unmapped", { terrain: W.terrain, land: T.land, unmapped: r.stats.unmapped });
});
row("IM-E3", () => {
  const envL = (env: any) => seqd([BASIC[0], { actor: "Ann", verb: "spawn", args: { id: "land", lib: "t.glb", pos: [0, 0, 0] } }, { actor: "Ann", verb: "comp", args: { id: "land", type: "environment", data: env } }]);
  const low = TV1.translate(envL({ floor: -260, bounds: { min: [-800, -250, -800], max: [800, 100, 800] } }));
  const high = TV1.translate(envL({ floor: -10, bounds: { min: [-800, -250, -800], max: [800, 100, 800] } }));
  const Wl = low.final.translated["@world"], Wh = high.final.translated["@world"];
  const m = low.stats.mapped?.find((x: any) => x.component === "environment" && /bounds/.test(x.feature) && /floor/.test(x.feature));
  ok(low.stats.divergences === 0 && JSON.stringify(Wl.bounds) === JSON.stringify({ min: [-800, -262, -800], max: [800, 100, 800] }) && m?.id === "land" && JSON.stringify(m.into) === JSON.stringify(["@world.bounds"]) && m.was === -250 && m.now === -262
    && JSON.stringify(Wh.bounds) === JSON.stringify({ min: [-800, -250, -800], max: [800, 100, 800] }) && !high.stats.mapped?.some((x: any) => /floor/.test(x.feature ?? "")),
    "IM-E3 (#248) a floor below @world.bounds.min.y lowers it to 2 m under the floor (else everyone on the floor has fallen), listed under mapped; a floor inside the bounds leaves them", { low: Wl.bounds, high: Wh.bounds, mapped: low.stats.mapped });
});
const ZN = await import("../../shared/zone.js");
row("IM-W4", () => {
  const L = seqd([BASIC[0], { actor: "Ann", verb: "spawn", args: { id: "tank", lib: "t.glb", pos: [0, 0, 0] } }, { actor: "Ann", verb: "comp", args: { id: "tank", type: "water", data: { center: [0, -5, 0], size: [20, 10, 20] } } },
    { actor: "Ann", verb: "spawn", args: { id: "room", lib: "r.glb", pos: [0, -5, 0], yaw: Math.PI / 2 } }, { actor: "Ann", verb: "comp", args: { id: "room", type: "air", data: { boxes: [{ center: [0, 0, 2], size: [2, 2, 2] }] } } }]);
  const T = TV1.translate(L).final.translated, st = { entities: Object.fromEntries(Object.entries(T).map(([id, c]) => [id, { c }])) }, z = ZN.zonesOf(st);
  const at = (p: number[]) => ZN.mediumOf(p, z).body;
  const o = { open: at([5, -5, 5]), room: at([2, -5, 0]), unturned: at([0, -5, 2]), above: at([5, 1, 5]) };   // the room's yaw turns its box's centre +z → +x
  ok(o.open === TV1.waterChildId("tank") && o.room === null && o.unturned === TV1.waterChildId("tank") && o.above === null, "IM-W4 the translated world's medium (shared/zone.js mediumOf): open water wet, the air box dry where its thing's yaw puts it, above the surface dry", o);
});
row("IM-W5", () => {
  // main sized both by its host's scale (client/lib/watervolumes.js at ccd5c53fa: size × |matrixWorld scale|; an air box through the inverse matrixWorld)
  const L = seqd([BASIC[0], { actor: "Ann", verb: "spawn", args: { id: "big", lib: "b.glb", pos: [0, -10, 0], scale: 2 } },
    { actor: "Ann", verb: "comp", args: { id: "big", type: "water", data: { center: [1, 0, 0], size: [10, 2, 4] } } }, { actor: "Ann", verb: "comp", args: { id: "big", type: "air", data: { boxes: [{ center: [0, 0, 1], size: [1, 1, 1] }] } } }]);
  const r = TV1.translate(L), T = r.final.translated, st = { entities: Object.fromEntries(Object.entries(T).map(([id, c]) => [id, { c }])) }, z = ZN.zonesOf(st);
  const b = z.bodies.find((x: any) => x.id === TV1.waterChildId("big")), a = z.exclusions.find((x: any) => x.id === TV1.airChildId("big", 0));
  const o = { host: T.big?.transform?.scale, body: b && { center: b.center, size: b.size }, air: a && { center: a.center, size: a.size }, mapped: r.stats.mapped?.map((m: any) => m.feature) };
  ok(JSON.stringify(o.body) === JSON.stringify({ center: [2, -10, 0], size: [20, 4, 8] }) && JSON.stringify(o.air) === JSON.stringify({ center: [0, -10, 2], size: [2, 2, 2] }),
    "IM-W5 a scaled host's water and air boxes are main's size in metres: the host keeps its scale, its children's zones are read through it (main: size × the host's scale), no correction needed", o);
});

// ---- IM-I36, IM-I37, IM-I13, IM-I3: values read as v1 read them ----
const finalOf = (L: any[]) => TV1.translate(seqd(L)).final.translated;
row("IM-I36", () => {
  const F = finalOf([BASIC[0], { actor: "a", verb: "spawn", args: { id: "fan", lib: "f.glb", pos: [0, 0, 0] } },
    { actor: "a", verb: "comp", args: { id: "fan", type: "motion", data: { type: "spin", rpm: "10" } } },
    { actor: "a", verb: "spawn", args: { id: "mill", lib: "f.glb", pos: [2, 0, 0] } },
    { actor: "a", verb: "comp", args: { id: "mill", type: "motion", data: { type: "spin", rpm: "fast" } } }]);
  ok(F.fan?.motion?.degPerSec === 60 && !("rpm" in (F.fan?.motion ?? {})) && F.mill?.["imported:motion"]?.rpm === "fast" && F.mill?.motion?.degPerSec === undefined,
    "IM-I36 a numeric-string rpm spins at rpm × 6 as the renderer coerced it; a rate that isn't a number is carried in imported:motion", { fan: F.fan, mill: F.mill });
});
row("IM-I37", () => {
  const F = finalOf([BASIC[0], { actor: "a", verb: "spawn", args: { id: "bench", lib: "b.glb", pos: [0, 0, 0] } },
    { actor: "a", verb: "comp", args: { id: "bench", type: "sockets", data: { left: { pos: [0, 0.5, 0], yaw: "1.5" }, right: { pos: [1, 0.5, 0], yaw: "east" } } } }]);
  const s = F.bench?.sockets, q = s?.left?.q;
  ok(Array.isArray(q) && Math.abs(q[1] - Math.sin(0.75)) < 1e-12 && !s?.right?.q && F.bench?.["imported:sockets"]?.right?.yaw === "east",
    "IM-I37 a numeric-string seat yaw turns the seat as the renderer coerced it; a yaw that can't turn is carried in imported:sockets", { s, imp: F.bench?.["imported:sockets"] });
});
row("IM-I13", () => {
  const L = [BASIC[0], { actor: "a", verb: "spawn", args: { id: "tv", lib: "s.glb", pos: [0, 0, 0] } },
    { actor: "world", verb: "grant", args: { id: "cap", role: "builder", caption: { id: "tv", born: 1 } } },
    { actor: "world", verb: "grant", args: { id: "old", role: "builder", caption: { id: "tv", born: 99 } } },
    { actor: "world", verb: "grant", args: { id: "tmp", role: "builder", until: T0 + 9e9, caption: { id: "tv" } } }];
  const F = finalOf(L); const w = F["@world"]; const imp = (id: string) => w[`imported:${TV1.enc(`roles:${id}`)}`];
  ok(JSON.stringify(F.tv?.captioners) === JSON.stringify({ ids: ["cap"] }) && !w["roles:cap"]?.caption && !imp("cap") && imp("old")?.caption?.born === 99 && imp("tmp")?.caption?.id === "tv",
    "IM-I13 a caption deed on the screen it was granted for is a place in its captioners; one for a replaced incarnation, or on a timed grant, stays carried", { tv: F.tv?.captioners, cap: w["roles:cap"], old: imp("old"), tmp: imp("tmp") });
});
row("IM-I3", () => {
  const S = "2026-09-16T20:00:00.000Z-k3f9";
  const L = [BASIC[0], { actor: "a", verb: "spawn", args: { id: "tv", lib: "s.glb", pos: [0, 0, 0] } },
    { actor: "door", verb: "caption", args: { id: "tv", session: S, n: 1, t0: 0, t1: 2, text: "first" } },
    { actor: "door", verb: "caption", args: { id: "tv", session: S, n: 2, t0: 2, t1: 4, text: "second" } }];
  const st = v1Empty(); for (const e of seqd(L)) v1Fold(st, e);
  const bag = st.entities.tv?.comp?.captions; const F = finalOf(L);
  ok(Array.isArray(bag?.window) && bag.window.length === 2 && bag.mediaTime === 4 && F.tv?.captions?.line?.text === "second" && !("window" in (F.tv?.captions ?? {})) && !F.tv?.["imported:captions"],
    "IM-I3 the old fold reads captions as main did (its frozen helpers: a window of lines, the playhead), and the translation holds the current line", { bag, now: F.tv?.captions, imp: F.tv?.["imported:captions"] });
});

row("IM-I3b", () => {
  const { v1FoldFiles } = require("./import-v1/build.ts");
  const live = v1FoldFiles().filter((f: string) => !f.startsWith("tools/protocol/import-v1/"));
  ok(!live.length, "IM-I3b every module the old fold reads is a frozen copy under import-v1/ (none is a live runtime module)", live);
});

// ---- IM-I14: an earlier epoch's rest tick never dates a later epoch's rest ----
row("IM-I14", () => {
  const box = [[-0.5, 0, -0.5], [0.5, 1, 0.5]]; const E = (ts: number) => ({ verb: "epoch", actor: "fixture", ts, args: { sim: "eidosim@0.5.0", tickMs: 66, boxes: { "crate.glb": box } } });
  const head = [{ seq: 0, ts: T0, actor: "world", verb: "genesis", args: { v: 3, dialect: "eidoverse-log" } },
    { seq: 1, ts: T0 + 10, actor: "fixture", verb: "spawn", args: { id: "far", lib: "crate.glb", pos: [0, 0, 0], yaw: 0, box } },
    { seq: 2, ts: T0 + 20, actor: "fixture", verb: "spawn", args: { id: "near", lib: "crate.glb", pos: [0, 0, 20], yaw: 0, box } }];
  const tail = (s: number) => [{ seq: s, ...E(T0 + 60_000) }, { seq: s + 1, ts: T0 + 60_100, actor: "fixture", verb: "punt", args: { id: "near", power: 2, dir: [1, 0.2, 0] } }];
  const withFar = [...head, { seq: 3, ...E(T0 + 30) }, { seq: 4, ts: T0 + 100, actor: "fixture", verb: "punt", args: { id: "far", power: 25, dir: [1, 1, 0] } },
    { seq: 5, ts: T0 + 30_000, actor: "fixture", verb: "say", args: { text: "later" } }, ...tail(6)];
  const without = [...head, { seq: 3, ...E(T0 + 30) }, { seq: 4, ts: T0 + 30_000, actor: "fixture", verb: "say", args: { text: "later" } }, ...tail(5)];
  const restOf = (L: any[]) => { const r = TV1.translate(L); return r.out.filter((e: any) => e.kind === "change" && e.actor === "sim").map((e: any) => e.ts); };
  const a = restOf(withFar), b = restOf(without);
  ok(a.length === 2 && b.length === 1 && a[1] === b[0] && a[0] <= T0 + 30_000, "IM-I14 the later epoch's rest is dated by its own tick, whatever an earlier epoch's body left behind", { withFar: a, without: b });
});

// ---- IM-I17: the oracle's lift check ----
{ const { liftFailures } = await import("./import-v1/snapshot-oracle.ts");
  const got = liftFailures([{ repairNeeded: { steps: ["repair-shapes"], blocking: [], optional: [] } }, { host: "h", made: [] }]);
  ok(got.length === 1 && got[0].repairNeeded, "IM-I17 the oracle counts a lifted world that still needs maintenance (liftWorld's repairNeeded) as a lift failure", got); }

console.log(`[importer-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
