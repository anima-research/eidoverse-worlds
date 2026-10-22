// tools/protocol/importer-check.ts — the v1 importer (tools/protocol/import-v1/) against the house's review of #260
// (comment 6291883302, "the v1 importer"): each row names the item it holds, and each was red before its fix.
//   IM-I1   the approval act is written inside translate: every change's cause is the act it answers
//   IM-I25  the writer refuses an approval (validly countersigned) of a report that isn't this log's
//   IM-I34  the dry-run report counts the renames the real run makes (and its hash is the writer's)
//   IM-I6   a v1 ban (lowercased by the v1 fold) lands on the person the grant named, not a fresh identity
//   IM-I9   on a TRUST_NAMES server a person's acts and their grant are one identity (a child process)
//   IM-I5   a v1 agent's home-node sub is filed as the account its live join wears (aid1:<iss>:<sub>)
//   IM-I35  a failure after world.jsonl lands removes what it made: the error says nothing was written, and a rerun works
//   IM-I10  the remembered places: a write that fails is reported, not counted; an unreadable file and dropped names are said
//   IM-I7   lines of the old log that don't parse are counted, in the report and in the result
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
  const r = translateV1World(argv[1], argv[2]);
  console.log(JSON.stringify({ planned: r.planned, identities: r.identities }));
  process.exit(0);
}
delete process.env.TRUST_NAMES;   // the in-process rows run as a public server does
const W1 = await import("./import-v1/world.ts");
const TV1 = await import("./import-v1/translate-v1.js");
const { readLog, fold } = await import("../../shared/protocol/fold.js");
const { custodyAt } = await import("../../server/custody.ts");
const { custodyFileIn } = await import("../../server/keyfiles.ts");
const { HN_ISS } = await import("../../server/auth.ts");

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

// ---- IM-I17: the oracle's lift check ----
{ const { liftFailures } = await import("./import-v1/snapshot-oracle.ts");
  const got = liftFailures([{ repairNeeded: { steps: ["repair-shapes"], blocking: [], optional: [] } }, { host: "h", made: [] }]);
  ok(got.length === 1 && got[0].repairNeeded, "IM-I17 the oracle counts a lifted world that still needs maintenance (liftWorld's repairNeeded) as a lift failure", got); }

console.log(`[importer-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
