// tools/protocol/migrate-identities-check.ts — migrate-identities.ts (name identities -> directory ids) on a world made the
// way the old engine left one: actors, role keys, a say's `to`, a use's capability.author, a script's sponsor and the
// moderator log all naming people by name, one role carrying its person's account (`sub`).
//   bun tools/protocol/migrate-identities-check.ts
// Rows:
//   MI1  one id per person, everywhere: the account a role names holds that role AND the person's acts, says and
//        moderation; the role key, actor, say.to, capability.author and sponsor of one person agree (house #260 I3, I9)
//   MI2  script:<entity> actors, system and an address are left as they are (I8)
//   MI3  the moderator log is migrated with the same map and kept beside it (I10)
//   MI4  a second --apply is refused and the backups are untouched (I308)
//   MI5  the reference reader's malformed diagnostics stop the write even when its status is ok (I307)
//   MI6  a crash between the directory and the logs leaves the logs as they were and the directory already holding the
//        ids, so nothing names an id the directory lacks (I91)
// MIGRATE_TOOL=<path> runs another copy of the tool (a base, for the rows' red).
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { openLive } from "../../server/livehost.ts";
import { request } from "../../shared/protocol/authority.js";
import { readLog } from "../../shared/protocol/fold.js";

const TOOL = process.env.MIGRATE_TOOL ?? path.join(ENGINE, "tools/protocol/migrate-identities.ts");
let pass = 0, fail = 0;
const ok = (c: any, what: string, info?: unknown) => { if (c) { pass++; console.log(`ok   ${what}`); } else { fail++; console.log(`FAIL ${what}${info === undefined ? "" : ` — ${JSON.stringify(info).slice(0, 600)}`}`); } };
const minted = (s: unknown) => typeof s === "string" && /^u-[a-z2-7]{20}$/.test(s);

/** An old world: founded by ann; bob a builder whose role carries his account; acts, a say to ann, a use with ann as the
 *  handler's author, a script act sponsored by bob; a moderator log banning dave and muting bob. */
function oldWorld(root: string, name: string) {
  const W = path.join(root, "worlds"); let T = 1800000000000;
  const w: any = openLive(path.join(W, name), name, { now: () => (T += 1000), custodyFile: path.join(W, ".custody.json") });
  const r = request(w, "ann", "create-world", { title: name }); if (!r.ok) throw new Error(JSON.stringify(r));
  const f = path.join(W, name, "world.jsonl"); const L = readLog(fs.readFileSync(f, "utf8")); const world = L[1].world; let ts = T;
  const add = (e: any) => { L.push({ world, ts: (ts += 1000), ...e }); return L.length - 1; };
  const a1 = add({ kind: "act", actor: "ann", verb: "set", body: { request: { id: "@world", component: "roles:bob", value: { role: "builder" } } } });
  add({ kind: "change", actor: "ann", cause: a1, verb: "set", body: { id: "@world", comp: "roles:bob", value: { role: "builder", sub: "aid1:example.org:bob" } } });
  add({ kind: "say", actor: "bob", verb: "say", body: { text: "hello", to: "ann" } });
  const a2 = add({ kind: "act", actor: "bob", verb: "set", body: { request: { id: "@world", component: "about", value: { name, text: "bob's" } } } });
  add({ kind: "change", actor: "bob", cause: a2, verb: "set", body: { id: "@world", comp: "about", value: { name, text: "bob's" } } });
  add({ kind: "act", actor: "carl", verb: "use", body: { request: { id: "bell", action: "ring" }, capability: { reaction: "ring", author: "ann", grantedAt: 2 } } });
  add({ kind: "act", actor: "script:bell1", verb: "script", body: { script: "bell", sponsor: "bob", sponsorAt: a2 } });
  fs.writeFileSync(f, L.map((e: any) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(path.join(W, name, "world.mod.jsonl"), [{ ts: ts + 1, actor: "ann", verb: "ban", who: "dave" }, { ts: ts + 2, actor: "ann", verb: "mute", who: "bob", until: ts + 1e9 },
    { ts: ts + 3, actor: "system", verb: "ban", who: "addr:0f0f" }].map((m) => JSON.stringify(m)).join("\n") + "\n");
  return path.join(W, name);
}
const tool = (args: string[], env: Record<string, string> = {}) => { const r = Bun.spawnSync(["bun", TOOL, ...args], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...env } });
  const out = r.stdout.toString() + r.stderr.toString(); let o: any = null; try { o = JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1)!); } catch {}
  return { code: r.exitCode, out, o }; };
const logOf = (d: string) => readLog(fs.readFileSync(path.join(d, "world.jsonl"), "utf8"));
const modOf = (d: string) => fs.readFileSync(path.join(d, "world.mod.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const dirOf = (root: string) => { try { return JSON.parse(fs.readFileSync(path.join(root, "worlds", ".directory.json"), "utf8")); } catch { return {}; } };
const entriesOf = (dj: any) => dj.entries ?? dj.ids ?? dj;   // the directory file's map id -> entry
const idWithSub = (root: string, sub: string) => Object.entries<any>(entriesOf(dirOf(root))).find(([, e]) => Array.isArray(e?.subs) && e.subs.includes(sub))?.[0] ?? null;

// ================= MI1–MI4: a migration, applied =================
{ const root = scratch("migid"); const d = oldWorld(root, "porch");
  const dry = tool([d]);
  const r = tool(["--apply", d]); const L = logOf(d);
  ok(r.code === 0 && r.o?.written === true, "MI0 the migration of an old world is applied (dry run first, then --apply)", { dry: dry.o, applied: r.o, tail: r.out.slice(-400) });
  const bobAcct = idWithSub(root, "aid1:example.org:bob");
  const ann = L[1].actor; const roleKeys = new Set<string>();
  for (const e of L as any[]) if (e.kind === "change") for (const o of e.verb === "batch" ? e.body.ops : [e.body]) if (String(o?.comp).startsWith("roles:")) roleKeys.add(o.comp);
  const roleKey = [...roleKeys].find((k) => k !== `roles:${ann}`) ?? null;
  const say = L.find((e: any) => e.kind === "say" && e.body?.text === "hello"), bobSet = L.find((e: any) => e.kind === "act" && e.body?.request?.component === "about");
  const use = L.find((e: any) => e.kind === "act" && e.verb === "use"), scr = L.find((e: any) => e.kind === "act" && e.verb === "script");
  ok(minted(bobAcct) && roleKey === `roles:${bobAcct}` && say?.actor === bobAcct && bobSet?.actor === bobAcct && scr?.body?.sponsor === bobAcct,
    "MI1 bob is one id everywhere: the id holding his account holds his role, his say, his act and his script's sponsorship (I3, I9)", { bobAcct, roleKey, say: say?.actor, act: bobSet?.actor, sponsor: scr?.body?.sponsor });
  ok(minted(ann) && say?.body?.to === ann && use?.body?.capability?.author === ann, "MI1 ann is one id: the founder's actor, the say's to and the use's capability.author (I9)", { ann, to: say?.body?.to, author: use?.body?.capability?.author });
  ok(scr?.actor === "script:bell1" && L.some((e: any) => e.actor === "system"), "MI2 a script:<entity> actor and the system are left as they are (I8)", { script: scr?.actor });
  const M = fs.existsSync(path.join(d, "world.mod.jsonl")) ? modOf(d) : [];
  const dave = M.find((m: any) => m.verb === "ban" && m.who !== "addr:0f0f");
  ok(M.length === 3 && minted(dave?.who) && M.find((m: any) => m.verb === "mute")?.who === bobAcct && M.every((m: any) => m.actor === "system" || m.actor === ann) && M.some((m: any) => m.who === "addr:0f0f")
    && fs.existsSync(path.join(d, "world.mod.jsonl.before-identities")),
    "MI3 the moderator log names the same ids (dave's ban, bob's mute, ann as moderator; an address left alone) and the old one is kept beside it (I10)", M);
  const keep = fs.readFileSync(path.join(d, "world.jsonl.before-identities")); const now = fs.readFileSync(path.join(d, "world.jsonl"));
  const again = tool(["--apply", d]);
  ok(again.o?.skipped && /backup is already here/.test(again.o.skipped) && fs.readFileSync(path.join(d, "world.jsonl.before-identities")).equals(keep) && fs.readFileSync(path.join(d, "world.jsonl")).equals(now),
    "MI4 a second --apply is refused, and the backup and the log are untouched (I308)", { again: again.o ?? again.out.slice(-300) }); }

// ================= MI5: the reader's malformed diagnostics are a refusal =================
{ const root = scratch("migmal"); const d = oldWorld(root, "yard"); const before = fs.readFileSync(path.join(d, "world.jsonl"));
  // a python3 that answers the reference reader with status ok and one malformed diagnostic, and runs everything else
  // the fake is TS behind a launcher (.cmd on Windows: a #!/bin/sh file is no executable there, and the row passed vacuously)
  const js = path.join(root, "fake-python.ts"); fs.writeFileSync(js, `const a = process.argv.slice(2);
if (a.some((x) => x.endsWith("reader.py"))) { console.log(JSON.stringify({ status: "ok", digest: "x", diagnostics: [[5, "malformed:shape", "a line it skipped"]] })); process.exit(0); }
process.exit(Bun.spawnSync([${JSON.stringify(process.env.PYTHON || "python3")}, ...a], { stdio: ["inherit", "inherit", "inherit"] }).exitCode ?? 1);
`);
  const fake = path.join(root, process.platform === "win32" ? "python3.cmd" : "python3");
  if (process.platform === "win32") fs.writeFileSync(fake, `@echo off\r\n"${process.execPath}" run "${js}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  else { fs.writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" run "${js}" "$@"\n`); fs.chmodSync(fake, 0o755); }
  const r = tool(["--apply", d], { PYTHON: fake });
  ok(r.code !== 0 && r.o?.written === false && r.o?.reader === "ok" && r.o?.malformed === 1 && fs.readFileSync(path.join(d, "world.jsonl")).equals(before) && !fs.existsSync(path.join(d, "world.jsonl.before-identities")),
    "MI5 a rewritten log the reader says ok to but reports malformed is not written (I307)", r.o ?? r.out.slice(-300)); }

// ================= MI6: the directory before the logs =================
{ const root = scratch("migcrash"); const d = oldWorld(root, "shed"); const before = fs.readFileSync(path.join(d, "world.jsonl"));
  const r = tool(["--apply", d], { MIGRATE_IDENTITIES_DIE_BEFORE_LOGS: "1" });
  ok(r.code === 9 && fs.readFileSync(path.join(d, "world.jsonl")).equals(before) && minted(idWithSub(root, "aid1:example.org:bob")),
    "MI6 a crash between the directory and the logs: the logs are as they were and the directory already holds the ids (I91)", { code: r.code, bob: idWithSub(root, "aid1:example.org:bob"), out: r.out.slice(-300) }); }

console.log(`[migrate-identities-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
