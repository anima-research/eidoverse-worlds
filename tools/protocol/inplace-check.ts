// tools/protocol/inplace-check.ts — translating an old world IN PLACE (R 10-17 13:36: "translating should leave the world
// under its ORIGINAL name, so links keep working, with the old log kept beside it").
//   `bun tools/protocol/world.ts translate <world> (--founder-key … | --no-founder-key)` translates into a temporary
//   sibling, verifies (the importer's checks, the result opened as the server opens it, and the snapshot oracle where the
//   old server left a snapshot.json), and only then swaps: world.jsonl takes the original directory's name, and the old
//   files are renamed beside it (log.original.jsonl, snapshot.original.json, poses.original.json), never rewritten.
//   IP1  the happy path: the name is kept, the original log/snapshot/poses are the SAME files (bytes, inode, mtime), no
//        temporary directory is left, the snapshot oracle was consulted and agreed
//   IP2  the server: one running since before the translation (which refused it) serves it under its original name with no
//        restart; a fresh boot no longer flags it, and serves it too
//   IP3  boot ignores log.original.jsonl: a translated directory is not an old-format world (oldWorldAt, bootNotice,
//        isPreNamesDir), while a world still waiting is (control)
//   IP4  re-running translate on a translated world refuses cleanly, and changes nothing
//   IP5  a verification failure (a snapshot.json the translation disagrees with) moves nothing, leaves no temporary
//        directory and no identities, and says why
//   IP6  a failure at every step of the swap (injected: WORLD_TS_FAULT_AT_STEP) puts everything back; a clean run after works
//   IP7  `info` counts entities (not "things"), and says @world isn't counted
//   IP8  the two-name form still translates into a new name and leaves the old directory as it was
//   IP9  the world's own inventions are namespaced by its NAME, never by the temporary directory's
//   IP10 a name with no old log refuses with that reason
//   IP11 a snapshot.json the oracle can't compare (a fold of part of the log) doesn't block the translation: it says,
//        in its output, that the snapshot was NOT compared and why, and keeps it as snapshot.original.json
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/inplace-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ENGINE, scratch } from "./common.ts";
import { emptyState as v1Empty, foldEntry as v1Fold } from "./import-v1/fold.js";
import { oldWorldAt, oldWorldsIn, bootNotice } from "../../server/oldworlds.ts";
import { isWorldDir, isPreNamesDir } from "../../server/livehost.ts";

const root = scratch("inplace");
let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const W = path.join(root, "worlds"), OPT = path.join(root, "opt"); fs.mkdirSync(OPT, { recursive: true });
const tool = (args: string[], env: Record<string, string> = {}) => { const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", ...args], { cwd: ENGINE,
  env: { ...process.env, TRUST_NAMES: "1", WORLDS_DIR: W, OPT_DIR: OPT, PROTOCOL_SCRATCH: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...env } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };

// ---- an old (v1) world, as the old server left it: log.jsonl, a COMPLETE snapshot.json (the old fold of the whole log:
// its last seq, the log's byte size) and poses.json (where each name last stood) ----
const T0 = 1790000000000;
const L = [
  { actor: "world", verb: "grant", args: { id: "Ann", role: "owner", gen: true } },
  { actor: "Ann", verb: "spawn", args: { id: "table_1", lib: "test/table.glb", pos: [1, 0, 1], yaw: 0.5 } },
  { actor: "Ann", verb: "comp", args: { id: "table_1", type: "label", data: "the old table" } },
  { actor: "Ann", verb: "comp", args: { id: "table_1", type: "heart", data: { beats: 3 } } },   // an invention: namespaced (IP9)
  { actor: "Ann", verb: "spawn", args: { id: "cup_1", lib: "test/cup.glb", pos: [4, 0, 2] } },
  { actor: "Bob", verb: "say", args: { text: "hello from the old days" } }];
function oldWorld(name: string, { tamper = false } = {}) {
  const d = path.join(W, name); fs.mkdirSync(d, { recursive: true });
  const text = L.map((e, k) => JSON.stringify({ seq: k, ts: T0 + k * 1000, ...e })).join("\n") + "\n";
  fs.writeFileSync(path.join(d, "log.jsonl"), text);
  const st = v1Empty(); for (const l of text.split("\n").filter(Boolean)) v1Fold(st, JSON.parse(l));
  if (tamper) st.entities.cup_1.pos = [9, 0, 9];   // the old engine "said" the cup was elsewhere: the oracle must disagree
  fs.writeFileSync(path.join(d, "snapshot.json"), JSON.stringify({ v: 1, seq: L.length - 1, bytes: Buffer.byteLength(text), ts: T0 + L.length * 1000, state: st }));
  fs.writeFileSync(path.join(d, "poses.json"), JSON.stringify({ Ann: { p: [4, 0, 4], yaw: 0 } }));
  return d;
}
/** Every file under `d` (and the worlds dir's own files): name → [sha256, inode, mtimeMs, size]. Plus any temp dirs. */
function fingerprint(d: string) {
  const out: Record<string, any> = {};
  for (const f of fs.readdirSync(d).sort()) { const p = path.join(d, f); const s = fs.statSync(p);
    out[f] = s.isDirectory() ? "dir" : [crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"), s.ino, s.mtimeMs, s.size]; }
  return out;
}
const temps = () => fs.readdirSync(W).filter((f) => f.startsWith(".translating-"));
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

// ---- a real server on the scratch worlds dir ----
async function freePort(from: number) { for (let p = from; p < from + 200; p++) { if (p === 8968 || p === 8970) continue;
  const free = await new Promise((res) => { try { const s = Bun.listen({ hostname: "0.0.0.0", port: p, socket: { data() {} } }); s.stop(true); res(true); } catch { res(false); } }); if (free) return p; } throw new Error("no free port"); }
async function boot(tag: string) {
  const port = await freePort(9240); const log = path.join(root, `${tag}.log`);
  const proc = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: { ...process.env, PORT: String(port), WORLDS_DIR: W, OPT_DIR: OPT, SKIP_OPT_SWEEP: "1", TRUST_NAMES: "1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", EIDO_FLIGHT_REHEARSAL: "" }, stdout: Bun.file(log), stderr: Bun.file(log + ".err") });
  process.on("exit", () => { try { proc.kill(); } catch {} });
  for (let i = 0; i < 100; i++) { await sleep(150); try { if ((await fetch(`http://127.0.0.1:${port}/worlds`, { signal: AbortSignal.timeout(1000) })).ok) return { port, proc, log }; } catch {} }
  throw new Error(`${tag}: the server didn't come up: ${fs.existsSync(log + ".err") ? fs.readFileSync(log + ".err", "utf8").slice(-500) : ""}`);
}
async function joinAs(port: number, world: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs: any[] = [];
  ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ type: "join", world, id: "Ann", avatar: "", replica: true }));
  for (let i = 0; i < 80 && !msgs.some((m) => m.type === "snapshot" || m.type === "error"); i++) await sleep(50);
  ws.close();
  return { snap: msgs.find((m) => m.type === "snapshot"), err: msgs.find((m) => m.type === "error")?.error, types: msgs.map((m) => m.type === "error" ? m.error : m.type).slice(0, 6) };
}

// ================= IP1: in place, the happy path =================
const porch = oldWorld("porch");
const before = fingerprint(porch);
// the server is running before the translation, and refuses the old world as it is (control)
const srv1 = await boot("boot1");
{ const j = await joinAs(srv1.port, "porch");
  ok(!j.snap && /older version of Eidoverse/.test(j.err ?? "") && /old-format world "porch"/.test(fs.readFileSync(srv1.log, "utf8")), "IP2 setup: before the translation, the running server flags \"porch\" at boot and refuses a visitor in plain words", j.types); }
const r1 = tool(["translate", "porch", "--no-founder-key"]);
const after = fingerprint(porch);
ok(r1.code === 0 && /0 divergences/.test(r1.out) && /translated "porch" .*→ world "porch"/.test(r1.out), "IP1 translate <world> succeeds in place, 0 divergences", r1.out.slice(-1200));
ok(isWorldDir(porch) && !fs.existsSync(path.join(porch, "log.jsonl")), "IP1 the world keeps its name: porch/ is now a world (world.jsonl), and log.jsonl is no longer there", Object.keys(after));
ok(same(after["log.original.jsonl"], before["log.jsonl"]), "IP1 log.original.jsonl IS the original log: same bytes, same inode, same mtime (renamed, never rewritten)", [before["log.jsonl"], after["log.original.jsonl"]]);
ok(same(after["snapshot.original.json"], before["snapshot.json"]) && same(after["poses.original.json"], before["poses.json"]), "IP1 snapshot.json → snapshot.original.json and poses.json → poses.original.json, the same files", [after["snapshot.original.json"], after["poses.original.json"]]);
{ const P = JSON.parse(fs.readFileSync(path.join(porch, "poses.json"), "utf8"));
  ok(Object.keys(P).length === 1 && /^u-[a-z2-7]{20}$/.test(Object.keys(P)[0]), "IP1 the new poses.json is keyed by identity (the translated world's)", P); }
ok(!temps().length && same(Object.keys(after).sort(), ["log.original.jsonl", "poses.json", "poses.original.json", "snapshot.original.json", "world.jsonl"]), "IP1 no temporary directory is left, and the directory holds exactly the new world and the kept originals", [temps(), Object.keys(after)]);
ok(/snapshot\.json agrees/.test(r1.out) && /mtime unchanged: true/.test(r1.out) && /keeps its name/.test(r1.out), "IP1 it says the snapshot oracle agreed, and that the original is kept with its mtime unchanged", r1.out.slice(-800));

// ================= IP7: info counts entities =================
{ const r = tool(["info", "porch"]); let j: any = null; try { j = JSON.parse(r.out); } catch {}
  const { readLog, fold } = await import("../../shared/protocol/fold.js");
  const n = Object.keys(fold(readLog(fs.readFileSync(path.join(porch, "world.jsonl")))).entities).filter((k) => k !== "@world").length;
  ok(j && j.entities === n && n === 2 && !("things" in j) && /not counting @world/.test(j.entitiesNote ?? ""), "IP7 info says `entities` (every entity but @world, and says so), never `things`", j ?? r.out); }

// ================= IP9: the namespace is the world's name =================
{ const text = fs.readFileSync(path.join(porch, "world.jsonl"), "utf8");
  ok(text.includes('"porch/heart"') && !text.includes("translating"), "IP9 the world's own inventions are namespaced by its name (porch/heart), never by the temporary directory", text.match(/"[^"]*\/heart"/g)); }

// ================= IP3: boot ignores log.original.jsonl =================
const waiting = oldWorld("waiting");
{ ok(oldWorldAt(W, "porch") === null && !isPreNamesDir(porch), "IP3 a translated directory (world.jsonl + log.original.jsonl) is no old-format world: oldWorldAt null, not pre-names", oldWorldAt(W, "porch"));
  const names = oldWorldsIn(W).map((o) => o.name); const notice = bootNotice(W);
  ok(same(names, ["waiting"]) && !/"porch"/.test(notice) && /"waiting"/.test(notice), "IP3 the boot notice names the world still waiting and not the translated one (control: a waiting world IS named)", [names, notice]);
  ok(notice.includes(`WORLDS_DIR=${W} bun tools/protocol/world.ts translate waiting --founder-key <the founder's ed25519 key>`) && /keeps its name, so links to it keep working/.test(notice), "IP3 …and its command is the in-place form", notice); }

// ================= IP2: the server serves it under its original name =================
// (the server running since before the translation picks it up with no restart — R's walkthrough keeps it running —
// and a fresh boot no longer flags it)
{ const live = await joinAs(srv1.port, "porch");
  ok(live.snap && !live.err && JSON.stringify(live.snap).includes(JSON.parse(tool(["info", "porch"]).out).worldId), "IP2 the server that refused \"porch\" before the translation serves it now under the same name (the old link), with no restart", live.types);
  srv1.proc.kill(); await sleep(300);
  const srv2 = await boot("boot2");
  const bootLog = fs.readFileSync(srv2.log, "utf8");
  ok(!/old-format world "porch"/.test(bootLog) && /old-format world "waiting"/.test(bootLog), "IP2 at a fresh boot the translated world isn't flagged as old-format (the waiting one is)", bootLog.split("\n").filter((l) => /old-format|need translating/.test(l)));
  const j = await joinAs(srv2.port, "porch");
  ok(j.snap && !j.err, "IP2 …and a visitor joining \"porch\" after the fresh boot is served it", j.types);
  srv2.proc.kill(); await sleep(200); }

// ================= IP4: re-running refuses, and changes nothing =================
{ const fp = fingerprint(porch); const r = tool(["translate", "porch", "--no-founder-key"]);
  ok(r.code !== 0 && /already translated/.test(r.out) && /log\.original\.jsonl/.test(r.out) && /Nothing was changed/.test(r.out), "IP4 translating a translated world refuses: it says it's already translated, where the original is, and that nothing changed", r.out);
  ok(same(fingerprint(porch), fp) && !temps().length, "IP4 …and nothing changed on disk", temps()); }

// ================= IP5: a verification failure moves nothing =================
{ const d = oldWorld("crooked", { tamper: true }); const fp = fingerprint(d), dirf = path.join(W, ".directory.json"), dirBefore = fs.readFileSync(dirf, "utf8");
  const r = tool(["translate", "crooked", "--no-founder-key"]);
  ok(r.code !== 0 && /doesn't agree with the old engine's own snapshot\.json/.test(r.out) && /Nothing was moved/.test(r.out), "IP5 a translation that disagrees with snapshot.json is refused, and it says why (the snapshot oracle) and that nothing moved", r.out.slice(-1500));
  ok(same(fingerprint(d), fp) && !isWorldDir(d), "IP5 the original directory is exactly as it was (every file's bytes, inode, mtime)", fingerprint(d));
  ok(!temps().length && fs.readFileSync(dirf, "utf8") === dirBefore, "IP5 no temporary directory is left, and no identities were added (the oracle runs before anything is written)", temps()); }

// ================= IP6: a failure at each step of the swap puts everything back =================
{ const d = oldWorld("swapper"); const fp = fingerprint(d);
  // steps: world.jsonl in, log.jsonl → log.original.jsonl, snapshot.json → …, poses.json → …, poses.json in (the new one)
  const results: any[] = [];
  for (let k = 0; k < 5; k++) { const r = tool(["translate", "swapper", "--no-founder-key"], { WORLD_TS_FAULT_AT_STEP: String(k) });
    results.push({ k, code: r.code, restored: same(fingerprint(d), fp), temps: temps().length, said: /the swap failed: \(injected\) step \d+ failed; everything that had moved was put back/.test(r.out) }); }
  ok(results.every((x) => x.code !== 0 && x.restored && x.temps === 0 && x.said), "IP6 a failure at any step of the swap (0..4) puts every moved file back, removes the temporary directory and says so", results);
  const r = tool(["translate", "swapper", "--no-founder-key"]);
  ok(r.code === 0 && isWorldDir(d) && same(fingerprint(d)["log.original.jsonl"], fp["log.jsonl"]), "IP6 …and a clean run afterwards translates it in place", r.out.slice(-600)); }

// ================= IP8: the two-name form still works =================
{ const d = oldWorld("elsewhere"); const fp = fingerprint(d);
  const r = tool(["translate", "elsewhere", "elsewhere-new", "--no-founder-key"]);
  ok(r.code === 0 && isWorldDir(path.join(W, "elsewhere-new")) && same(fingerprint(d), fp) && oldWorldAt(W, "elsewhere")?.kind === "translatable", "IP8 translate <old> <new> still makes a new world under the new name and leaves the old directory as it was", r.out.slice(-600)); }

// ================= IP10: no old log =================
{ fs.mkdirSync(path.join(W, "hollow"), { recursive: true });
  const r = tool(["translate", "hollow", "--no-founder-key"]);
  ok(r.code !== 0 && /holds no old log/.test(r.out) && !temps().length, "IP10 a directory with no old log refuses with that reason", r.out); }

// ================= IP11: a snapshot the oracle can't compare is reported, not compared =================
{ const d = oldWorld("partial"); const sf = path.join(d, "snapshot.json"); const S = JSON.parse(fs.readFileSync(sf, "utf8")); S.seq -= 1; fs.writeFileSync(sf, JSON.stringify(S));
  const fp = fingerprint(d); const r = tool(["translate", "partial", "--no-founder-key"]);
  ok(r.code === 0 && /snapshot\.json NOT compared: snapshot\.seq \d+ ≠ the log's last seq/.test(r.out) && isWorldDir(d) && same(fingerprint(d)["snapshot.original.json"], fp["snapshot.json"]),
    "IP11 a partial snapshot.json is reported as NOT compared (with the oracle's reason), and kept as snapshot.original.json", r.out.slice(-700)); }

console.log(`inplace: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
