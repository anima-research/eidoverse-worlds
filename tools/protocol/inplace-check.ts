// tools/protocol/inplace-check.ts — translating an old world IN PLACE (R 10-17 13:36: "translating should leave the world
// under its ORIGINAL name, so links keep working, with the old log kept beside it").
//   `bun tools/protocol/world.ts translate <world> --no-founder-key …` translates into a temporary
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
//   IP12 the snapshot oracle re-runs on a translated world's kept originals (log.original.jsonl, snapshot.original.json)
//   IP13 the process dies between swap steps (WORLD_TS_DIE_AT_STEP, no rollback): a re-run sees the half-swapped
//        directory and finishes the swap, saying so (review r11 L4)
//   IP14 an old log written to during the translation (a server still running): the swap refuses and moves nothing
//   IP15 a write that slips in mid-swap (injected: WORLD_TS_TOUCH_SOURCE_AT_STEP) undoes the swap
//   IP16 finishing an interrupted swap refuses when the old log changed since the translation read it
//   IP17 a failed in-place translation adds no identity to the shared directory; the clean run adds them once
//   IP18 the recovery of an interrupted swap writes the identities the interrupted run planned
//   IP11 a snapshot.json the oracle can't compare (a fold of part of the log) doesn't block the translation: it says,
//        in its output, that the snapshot was NOT compared and why, and keeps it as snapshot.original.json
//   —— review of PR #260 (Mica) item 6: the approval is bound to the dry-run report's hash; rollback is tested ——
//   IP19 `--dry-run` writes nothing and prints a report whose hash is the same on a second run (nothing random in it)
//   IP19t the report carries the trial-period line (hash-bound) and --dry-run prints it
//   IP20 `translate` with no --approved refuses, names the dry run, and changes nothing
//   IP21 an approval of a report that is no longer the world's (the old log changed since) is refused, both hashes named,
//        nothing moved
//   —— #260 rereview blocker 1: nothing can yet bind a key to the v1 world's owner, so a translation names no founder ——
//   IP21b the bytes translated are the bytes the approved report hashed (a write between the approval and the
//        importer's read is refused, both forms)
//   IP22 `--founder-key` (dry run, or with --approved and the key's GOOD signature) and `--approve-sig` are REFUSED, truthfully
//        (no key can be bound to the old owner: v1 logs record accounts, not keys; use --no-founder-key --operator-only-no-owner),
//        and nothing is written
//   IP23 the operator-only path translates: the act and translation.json record owner: null, the operator's countersignature,
//        and that no owner was attested; the genesis has tier 0 EMPTY
//   IP28 with --no-founder-key and no --operator-only-no-owner: REFUSED (no owner can sign)
//   IP29 the writer's own check (approvalProblem, translateV1World), without the CLI: an approval carrying an owner's signature
//        (even a verifying one) or a founder key is refused before anything is written; a missing/wrong operator
//        countersignature, an absent owner without NO_OWNER's exact text → refused by name; makeApproval makes the one form
//   IP31 FOUNDING a brand-new world is a different path: create-world still takes the founder's own ownerKey for tier 0, and
//        `world.ts found` still founds
//   IP24b rollback keeps an identity another world's log names (the second world reused the first one's id)
//   IP30 (r14 M3) a world.mod.jsonl the server made after the translation blocks rollback without --discard-changes, is removed with it, and the world translates again
//   IP24 `rollback <world>` restores the WHOLE operational set: the renamed originals back (same bytes, inode, mtime), the
//        made files (world.jsonl, poses.json, world.mod.jsonl, translation.json) removed, the minted identities forgotten: the
//        world directory and the shared directory are byte-identical to before the translation, and it translates again
//   IP25 a rollback that would lose history (the server wrote to world.jsonl since) refuses unless --discard-changes; a
//        directory with no manifest refuses with that reason
//   —— item 7: truthful refusals ——
//   IP26 a world using features this protocol doesn't carry yet (a water volume, air boxes, a climb route, a vehicle, a collision
//        toggle) is REFUSED, naming each feature and where it was used (seq, entity, actor); the dry run lists them under
//        `deferred`, and an approval of that report can't override the refusal; nothing is written. The world's water
//        level (water on @world) is not a volume and does not refuse (control)
//   IP27 a client that doesn't fold the log: a native (Unreal) session is told the Unreal client hasn't been ported to this protocol
//        yet; anyone else is told to reload or update (the wire carries the latter; the native text is the pure switch)
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/inplace-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ENGINE, scratch } from "./common.ts";
import { emptyState as v1Empty, foldEntry as v1Fold } from "./import-v1/fold.js";
import { oldWorldAt, oldWorldsIn, bootNotice, shellWord } from "../../server/oldworlds.ts";
import { isWorldDir, isPreNamesDir } from "../../server/livehost.ts";
import { noFoldRefusal } from "../../server/oldworlds.ts";
import { approvalText, approvalProblem, makeApproval, translateV1World, NO_OWNER } from "./import-v1/world.ts";
const operatorPub = () => JSON.parse(fs.readFileSync(path.join(W, ".custody.json"), "utf8")).operator?.pub as string;
const verifies = (key: string, msg: string, sig: string) => { try { return crypto.verify(null, Buffer.from(msg), crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key.slice(8), "base64url")]), format: "der", type: "spki" }), Buffer.from(sig, "base64url")); } catch { return false; } };
import { readLog } from "../../shared/protocol/fold.js";

const root = scratch("inplace");
let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const W = path.join(root, "worlds"), OPT = path.join(root, "opt"); fs.mkdirSync(OPT, { recursive: true });
const tool = (args: string[], env: Record<string, string> = {}) => { const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", ...args], { cwd: ENGINE,
  env: { ...process.env, TRUST_NAMES: "1", WORLDS_DIR: W, OPT_DIR: OPT, PROTOCOL_SCRATCH: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...env } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
/** The dry run's report hash for a world (review of PR #260 item 6: a translation needs an approval bound to it). */
const dryHash = (words: string[], env: Record<string, string> = {}) => { const r = tool(["translate", ...words, "--dry-run", "--no-founder-key"], env); return /^report-hash ([0-9a-f]{64})$/m.exec(r.out)?.[1] ?? "no-hash"; };
/** `translate <words…> --no-founder-key`, approved: the dry run first, its hash typed back (the operator's act). */
const xlate = (words: string[], env: Record<string, string> = {}) => tool(["translate", ...words, "--no-founder-key", "--operator-only-no-owner", "--approved", dryHash(words, env)], env);
const MANIFEST = "translation.json";
const dirf = path.join(W, ".directory.json");   // the shared identity directory

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
function oldWorld(name: string, { tamper = false, extra = [] as any[] } = {}) {
  const d = path.join(W, name); fs.mkdirSync(d, { recursive: true });
  const text = [...L, ...extra].map((e, k) => JSON.stringify({ seq: k, ts: T0 + k * 1000, ...e })).join("\n") + "\n";
  fs.writeFileSync(path.join(d, "log.jsonl"), text);
  const st = v1Empty(); for (const l of text.split("\n").filter(Boolean)) v1Fold(st, JSON.parse(l));
  if (tamper) st.entities.cup_1.pos = [9, 0, 9];   // the old engine "said" the cup was elsewhere: the oracle must disagree
  fs.writeFileSync(path.join(d, "snapshot.json"), JSON.stringify({ v: 1, seq: L.length + extra.length - 1, bytes: Buffer.byteLength(text), ts: T0 + L.length * 1000, state: st }));
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
// IP27 (wire half): a browser-like joiner that doesn't say replica (not a native session) is told to reload or update
{ const ws = new WebSocket(`ws://127.0.0.1:${srv1.port}/ws`); const msgs: any[] = []; ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  // a current world to be refused at: found one
  tool(["found", "current", "--owner", "Ann"]);
  ws.send(JSON.stringify({ type: "join", world: "current", id: "Ann", avatar: "" }));
  for (let i = 0; i < 80 && !msgs.some((m) => m.type === "snapshot" || m.type === "error"); i++) await sleep(50); ws.close();
  const err = msgs.find((m) => m.type === "error")?.error ?? "";
  ok(err === noFoldRefusal("current", false) && /reload the page/.test(err) && !/Unreal/.test(err), "IP27 a joiner with no replica and no native session is told, on the wire, to reload the page or update the agent (the non-native text)", err); }
ok(/Unreal client hasn't been ported to it yet/.test(noFoldRefusal("current", true)) && /a world of the current protocol, and/.test(noFoldRefusal("current", true)) && /Nothing is wrong with your sign-in/.test(noFoldRefusal("current", true)) && !/reload the page/.test(noFoldRefusal("current", true)),
  "IP27 a native (Unreal) session gets the truthful text: the Unreal client hasn't been ported to this protocol yet, nothing is wrong with it or the world", noFoldRefusal("current", true));

// ================= IP19–IP21: the dry run and the approval it binds =================
{ const d = oldWorld("careful"); const fp = fingerprint(d);
  const a = tool(["translate", "careful", "--dry-run", "--no-founder-key"]), b = tool(["translate", "careful", "--dry-run", "--no-founder-key"]);
  const ha = /^report-hash ([0-9a-f]{64})$/m.exec(a.out)?.[1], hb = /^report-hash ([0-9a-f]{64})$/m.exec(b.out)?.[1];
  let rep: any = null; try { rep = JSON.parse(a.out.slice(a.out.indexOf("{"), a.out.lastIndexOf("}") + 1)); } catch {}
  ok(a.code === 0 && !!ha && ha === hb && same(fingerprint(d), fp) && !temps().length && !isWorldDir(d), "IP19 --dry-run prints the report hash, the same on a second run, and writes nothing (the directory is as it was, no temporary directory)", { code: a.code, ha, hb, keys: Object.keys(fingerprint(d)) });
  ok(rep && rep.source?.sha256 === fp["log.jsonl"][0] && rep.entries?.old === L.length && rep.guards && rep.dropped && Object.keys(rep.dropped).length >= 10 && Array.isArray(rep.deferred) && rep.deferred.length === 0 && rep.refused === null && rep.translator === "eidoverse/translate-v1@18",
    "IP19 the report names the old log's bytes (sha256), the counts, the translator, the DROPPED table (what every translation drops by design) and an empty deferred list", rep && { source: rep.source, entries: rep.entries, dropped: Object.keys(rep.dropped ?? {}).length, deferred: rep.deferred, refused: rep.refused });
  ok(rep && /trial period/.test(rep.trial ?? "") && /translate this world again/.test(rep.trial) && /^trial period: .*Approving this report accepts that/m.test(a.out),
    "IP19t the report (so the hash the owner signs) says the protocol is in a trial period and the world may be translated again, and --dry-run prints it (Mica, #260: alpha worlds should know they accepted translation churn)", rep && rep.trial);
  const no = tool(["translate", "careful", "--no-founder-key"]);
  ok(no.code !== 0 && /needs the operator's approval of its dry-run report first/.test(no.out) && /--dry-run/.test(no.out) && /Nothing was changed/.test(no.out) && same(fingerprint(d), fp) && !temps().length, "IP20 translate with no --approved refuses, says to dry-run first, and changes nothing", no.out.slice(-600));
  // the old log grows after the report was read: the approved hash is of a different log
  fs.appendFileSync(path.join(d, "log.jsonl"), JSON.stringify({ seq: L.length, ts: T0 + 100000, actor: "Bob", verb: "say", args: { text: "after the dry run" } }) + "\n");
  fs.rmSync(path.join(d, "snapshot.json"));   // (the snapshot is of the shorter log; not what this row is about)
  const fp2 = fingerprint(d);
  const stale = tool(["translate", "careful", "--no-founder-key", "--operator-only-no-owner", "--approved", ha!]);
  const now = dryHash(["careful"]);
  ok(stale.code !== 0 && /is not the one that was approved/.test(stale.out) && stale.out.includes(`approved ${ha}`) && stale.out.includes(`hashes to ${now}`) && now !== ha && /Nothing was changed/.test(stale.out) && same(fingerprint(d), fp2) && !temps().length && !isWorldDir(d),
    "IP21 an approval of a report the world has since outgrown is refused, both hashes named, nothing moved", { code: stale.code, out: stale.out.slice(-700) });
  const good = tool(["translate", "careful", "--no-founder-key", "--operator-only-no-owner", "--approved", now]);
  ok(good.code === 0 && isWorldDir(d), "IP21 …and approving the report as it stands now translates", good.out.slice(-300)); }

// ================= IP21b: the bytes translated are the bytes the approved report hashed =================
// the importer reads log.jsonl again after the approval was checked: a write between the two reads (WORLD_TS_TOUCH_SOURCE_AFTER_APPROVAL)
// would be translated, and stamped approved, from bytes nobody approved
for (const two of [false, true]) { const nm = two ? "racer2" : "racer"; const d = oldWorld(nm); fs.rmSync(path.join(d, "snapshot.json"));
  const words = two ? [nm, `${nm}-new`] : [nm]; const h = dryHash(words);
  const r = tool(["translate", ...words, "--no-founder-key", "--operator-only-no-owner", "--approved", h], { WORLD_TS_TOUCH_SOURCE_AFTER_APPROVAL: "1" });
  const destDir = path.join(W, two ? `${nm}-new` : nm), dirNow = fs.existsSync(dirf) ? fs.readFileSync(dirf, "utf8") : "";
  // two layers refuse it (the importer's own report of the bytes it read, house importer I25; and the byte compare, I206):
  // either one firing first is the property, refused with nothing written
  ok(r.code !== 0 && /not the bytes the approved report|the report of the log being translated hashes to/.test(r.out) && /Nothing was (changed|moved)/.test(r.out) && !isWorldDir(destDir) && !(two && fs.existsSync(destDir)) && !temps().length && !/local:late/.test(dirNow),
    `IP21b ${two ? "the two-name form" : "in place"}: a log written to after the approval was checked is refused, nothing written`, { code: r.code, out: r.out.slice(-500) }); }

// ================= IP22, IP28: a translation names no founder (#260 rereview, blocker 1) =================
// Nothing can yet bind a key to the v1 world's owner (v1 logs record accounts, not keys), so `--founder-key` would let the
// operator install any key as tier 0 and record it as "the owner approved". A translation takes no owner key at all.
const actsOf = (d: string) => readLog(fs.readFileSync(path.join(d, "world.jsonl"), "utf8")).filter((e: any) => e.kind === "act" && e.actor === "system").map((e: any) => [e.verb, e.body]);
const NO_KEY = (out: string) => /nothing can yet bind a key to the old world's owner/.test(out) && /v1 logs record accounts, not keys/.test(out) && /--no-founder-key --operator-only-no-owner/.test(out)
  && /tier 0 stays empty/.test(out) && /no owner was attested/.test(out) && /Nothing was changed/.test(out);
{ const d = oldWorld("founded"); const fp = fingerprint(d);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const KEY = "ed25519:" + (publicKey.export({ format: "jwk" }) as any).x;
  const sign = (msg: string) => crypto.sign(null, Buffer.from(msg), privateKey).toString("base64");
  const dr = tool(["translate", "founded", "--dry-run", "--founder-key", KEY]);
  ok(dr.code !== 0 && NO_KEY(dr.out) && !/report-hash/.test(dr.out) && same(fingerprint(d), fp) && !temps().length,
    "IP22 `translate --dry-run --founder-key K` is REFUSED: nothing can yet bind a key to the old world's owner, so a translation names no founder; it says to use --no-founder-key --operator-only-no-owner (tier 0 empty, no owner attested); nothing written", dr.out.slice(-600));
  // the strongest form of the old path: a hash the keyed dry run printed (where it still prints one) and K's GOOD signature of it
  const h = /^report-hash ([0-9a-f]{64})$/m.exec(dr.out)?.[1] ?? dryHash(["founded"]);
  const good = tool(["translate", "founded", "--founder-key", KEY, "--approved", h, "--approve-sig", sign(approvalText("founded", h))]);
  ok(good.code !== 0 && NO_KEY(good.out) && same(fingerprint(d), fp) && !isWorldDir(d) && !temps().length,
    "IP22 `translate --founder-key K --approved <hash> --approve-sig <K's good signature>` is REFUSED the same way: a valid signature by a key nothing binds to the owner is not the owner's approval, and K never becomes tier 0; nothing moved", { code: good.code, out: good.out.slice(-600), world: isWorldDir(d) });
  const sigOnly = tool(["translate", "founded", "--no-founder-key", "--operator-only-no-owner", "--approved", dryHash(["founded"]), "--approve-sig", sign("x")]);
  ok(sigOnly.code !== 0 && NO_KEY(sigOnly.out) && same(fingerprint(d), fp) && !isWorldDir(d), "IP22 --approve-sig (an owner's signature) is refused too, even beside --no-founder-key --operator-only-no-owner; nothing moved", sigOnly.out.slice(-400));
  // the one path still needs the operator to say, knowingly, that no owner approved
  oldWorld("founded2");
  const nf = tool(["translate", "founded2", "--no-founder-key", "--approved", dryHash(["founded2"])]);
  ok(nf.code !== 0 && /no owner can sign this approval/.test(nf.out) && /--operator-only-no-owner/.test(nf.out) && /Nothing was changed/.test(nf.out) && !isWorldDir(path.join(W, "founded2")) && !temps().length,
    "IP28 with --no-founder-key and no --operator-only-no-owner the translation is REFUSED: no owner can sign, and it says so and how to proceed knowingly; nothing moved", nf.out.slice(-500)); }
// ================= IP29: the writer's own check (approvalProblem, translateV1World), independent of the CLI =================
{ const src = oldWorld("sig-src"); const dst = path.join(W, "sig-dst"); const h = "a".repeat(64); const text = approvalText("sig-dst", h);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519"); const KEY = "ed25519:" + (publicKey.export({ format: "jwk" }) as any).x;
  const op = crypto.generateKeyPairSync("ed25519"); const OP = "ed25519:" + (op.publicKey.export({ format: "jwk" }) as any).x;
  const sign = (k: crypto.KeyObject, m: string) => crypto.sign(null, Buffer.from(m), k).toString("base64url");
  const good = { report: h, owner: null, operator: { key: OP, sig: sign(op.privateKey, text) }, noOwner: NO_OWNER };
  const signedOwner = { ...good, owner: { key: KEY, sig: sign(privateKey, text) } };   // a GOOD signature by a key nothing binds to the owner
  const cases: [string, any, RegExp][] = [
    ["no operator countersignature", { ...good, operator: { key: OP, sig: "" } }, /no operator countersignature/],
    ["operator signed another hash", { ...good, operator: { key: OP, sig: sign(op.privateKey, approvalText("sig-dst", "b".repeat(64))) } }, /operator's countersignature doesn't verify/],
    ["an owner's signature (verifying) is carried", signedOwner, /carries an owner's signature.*nothing can yet bind a key to the old world's owner/],
    ["an owner's signature, without NO_OWNER", { ...signedOwner, noOwner: undefined }, /carries an owner's signature/],
    ["owner field missing (not null)", { ...good, owner: undefined }, /carries an owner's signature/],
    ["no owner and no --operator-only-no-owner", { ...good, noOwner: undefined }, /--operator-only-no-owner/],
    ["no owner, the flag's text altered", { ...good, noOwner: NO_OWNER + " " }, /--operator-only-no-owner/],
  ];
  const got = cases.map(([name, a, re]) => ({ name, why: approvalProblem("sig-dst", a), re: re.test(approvalProblem("sig-dst", a) ?? "") }));
  ok(got.every((g) => g.re) && approvalProblem("sig-dst", good) === null,
    "IP29 approvalProblem (the one rule for the CLI and the writer): an approval carrying an owner's signature — even one that verifies — is refused, as are a missing or wrong operator countersignature and an absent owner without the flag's exact text; the operator-only form passes", got);
  let threw: any = null; try { translateV1World(src, dst, { name: "sig-dst", approval: cases[1][1] }); } catch (x) { threw = x; }
  ok(threw && /approval is refused: the operator's countersignature doesn't verify/.test(String(threw.message)) && !fs.existsSync(dst), "IP29 translateV1World itself refuses a bad countersignature before writing anything (the writer doesn't trust the CLI's check)", String(threw?.message).slice(0, 300));
  let threwO: any = null; try { translateV1World(src, dst, { name: "sig-dst", approval: signedOwner }); } catch (x) { threwO = x; }
  ok(threwO && /approval is refused: .*carries an owner's signature/.test(String(threwO.message)) && !fs.existsSync(dst), "IP29 translateV1World refuses an approval carrying an owner's signature handed straight to it (no CLI), before writing anything", String(threwO?.message).slice(0, 300));
  let threwK: any = null; try { translateV1World(src, dst, { name: "sig-dst", founderKey: KEY, approval: good }); } catch (x) { threwK = x; }
  ok(threwK && /takes no founder key/.test(String(threwK.message)) && /nothing can yet bind a key to the old world's owner/.test(String(threwK.message)) && !fs.existsSync(dst),
    "IP29 translateV1World refuses a founder key handed straight to it (no CLI), even with a good operator-only approval: nothing written", String(threwK?.message).slice(0, 300));
  const mk = makeApproval("sig-dst", h, { operator: { key: OP, sign: (m) => sign(op.privateKey, m) } });
  ok(approvalProblem("sig-dst", mk) === null && mk.owner === null && mk.noOwner === NO_OWNER && verifies(OP, text, mk.operator.sig), "IP29 makeApproval makes the one form: owner null, NO_OWNER recorded, the operator's countersignature over the approval text", mk); }
// ================= IP31: FOUNDING a brand-new world is a different path, and still takes its founder's own key =================
{ const { publicKey } = crypto.generateKeyPairSync("ed25519"); const KEY = "ed25519:" + (publicKey.export({ format: "jwk" }) as any).x;
  const { openWorld } = await import("../../server/filehost.ts"); const { request } = await import("../../shared/protocol/authority.js");
  const froot = path.join(root, "found-k"); const w1 = openWorld(froot, "keyed"), w2 = openWorld(froot, "plain");
  const r1 = request(w1, "kay", "create-world", { title: "keyed", ownerKey: KEY }), r2 = request(w2, "kay", "create-world", { title: "plain" });
  ok(r1.ok && JSON.stringify(w1.entries[0].body.owners[0]) === JSON.stringify([KEY]) && r2.ok && w2.entries[0].body.owners[0].length === 0,
    "IP31 founding a NEW world (create-world) still takes the founder's own key: ownerKey becomes tier 0 (no prior owner to bind); without one tier 0 is empty", [w1.entries[0]?.body?.owners, r1.refused, r2.refused]);
  const f = tool(["found", "fresh-founded", "--owner", "ann"]); const info = tool(["info", "fresh-founded"]);
  ok(f.code === 0 && /founded world "fresh-founded"/.test(f.out) && isWorldDir(path.join(W, "fresh-founded")) && /"roles:/.test(info.out), "IP31 `world.ts found <name> --owner <id>` founds a world as before", { f: f.out.slice(-300), info: info.out.slice(-300) }); }


// ================= IP24–IP25: rollback restores the whole operational set =================
{ const name = "undo"; const d = oldWorld(name, { extra: [{ actor: "Ann", verb: "ban", args: { id: "Troll", reason: "spam" } }] });   // a ban → world.mod.jsonl is made too
  const fp = fingerprint(d); const dirBefore = fs.readFileSync(dirf, "utf8"); const eidoBefore = fs.existsSync(path.join(OPT, "eido-index.json")) ? fs.readFileSync(path.join(OPT, "eido-index.json"), "utf8") : null;
  const t = xlate([name], { TRUST_NAMES: "" }); const mid = fingerprint(d);
  ok(t.code === 0 && isWorldDir(d) && !!mid["world.mod.jsonl"] && !!mid["poses.json"] && !!mid[MANIFEST] && fs.readFileSync(dirf, "utf8") !== dirBefore,
    "IP24 setup: translated in place (TRUST_NAMES off: identities minted), it made world.jsonl, poses.json, world.mod.jsonl (the ban) and translation.json, and grew the shared directory", { code: t.code, keys: Object.keys(mid) });
  const m = JSON.parse(fs.readFileSync(path.join(d, MANIFEST), "utf8"));
  ok(m.report === JSON.parse(fs.readFileSync(path.join(d, MANIFEST), "utf8")).approval.report && same(m.renamed, [["log.jsonl", "log.original.jsonl"], ["snapshot.json", "snapshot.original.json"], ["poses.json", "poses.original.json"]])
    && same(Object.keys(m.made).sort(), ["poses.json", MANIFEST, "world.jsonl", "world.mod.jsonl"]) && Object.keys(m.identities).length >= 2 && m.made["world.jsonl"] === mid["world.jsonl"][0],
    "IP24 the manifest names every rename, every made file with the sha256 it was made with, the minted identities and the approval", m);
  const r = tool(["rollback", name], { TRUST_NAMES: "" }); const after = fingerprint(d);
  ok(r.code === 0 && same(after, fp) && !isWorldDir(d) && oldWorldAt(W, name)?.kind === "translatable" && fs.readFileSync(dirf, "utf8") === dirBefore && !temps().length && /rolled back/.test(r.out) && /forgot 3 identities/.test(r.out),   // Ann, Bob and the banned Troll
    "IP24 rollback: every file is byte-identical to before (same bytes, inode, mtime; nothing made is left), the shared directory is byte-identical (the minted identities forgotten), and it is an old world again", { code: r.code, out: r.out.slice(-700), same: same(after, fp), dir: fs.readFileSync(dirf, "utf8") === dirBefore, keys: Object.keys(after) });
  ok((eidoBefore === null) === !fs.existsSync(path.join(OPT, "eido-index.json")) || fs.readFileSync(path.join(OPT, "eido-index.json"), "utf8") === eidoBefore, "IP24 the content-address index is left as it was (no model bytes on this host, so it never changed)");
  const again = xlate([name]);
  ok(again.code === 0 && isWorldDir(d), "IP24 …and it translates again after the rollback", again.out.slice(-300));
  // IP25: the server has written to the translated world since
  fs.appendFileSync(path.join(d, "world.jsonl"), "\n");
  const r2 = tool(["rollback", name]); const keep = fingerprint(d);
  ok(r2.code !== 0 && /without losing history: world\.jsonl changed since/.test(r2.out) && /--discard-changes/.test(r2.out) && same(fingerprint(d), keep) && isWorldDir(d), "IP25 a rollback that would lose history refuses, names the file, and offers --discard-changes; nothing changed", r2.out.slice(-500));
  const r3 = tool(["rollback", name, "--discard-changes"]);
  ok(r3.code === 0 && same(fingerprint(d), fp) && /changes since the translation discarded/.test(r3.out), "IP25 --discard-changes rolls back anyway, saying what was discarded; the directory is byte-identical to the original again", r3.out.slice(-400));
  const r4 = tool(["rollback", name]);
  ok(r4.code !== 0 && /holds no translation\.json/.test(r4.out) && /Nothing was changed/.test(r4.out) && same(fingerprint(d), fp), "IP25 a directory with no manifest refuses with that reason", r4.out.slice(-300)); }
// ================= IP24b: rollback keeps an identity another world's translation reused =================
// (TRUST_NAMES on: a name is an account, so a second world translated after the first wears the first one's id for Zed)
{ const zed = [{ actor: "Zed", verb: "say", args: { text: "here in both" } }];
  const d1 = oldWorld("share1", { extra: zed }), d2 = oldWorld("share2", { extra: zed });
  const t1 = xlate(["share1"]), t2 = xlate(["share2"]);
  const zedIn = (d: string) => readLog(fs.readFileSync(path.join(d, "world.jsonl"), "utf8")).find((e: any) => e.kind === "say" && e.body?.text === "here in both")?.actor;
  const id = zedIn(d1), m1 = JSON.parse(fs.readFileSync(path.join(d1, MANIFEST), "utf8"));
  const r = tool(["rollback", "share1"]); const dirNow = JSON.parse(fs.readFileSync(dirf, "utf8"));
  ok(t1.code === 0 && t2.code === 0 && !!id && id === zedIn(d2) && id in (m1.identities ?? {}) && r.code === 0 && !!(dirNow.ids ?? dirNow)[id] && /another world/.test(r.out),
    "IP24b rolling back the first world keeps the identity the second one's log names (minted by the first, reused by the second), and says so", { id, second: zedIn(d2), minted: id in (m1.identities ?? {}), code: r.code, kept: !!(dirNow.ids ?? dirNow)[id], out: r.out.slice(-400) }); }
// ================= IP30 (r14 M3): a file the server made AFTER the translation (its first ban → world.mod.jsonl) is history too =================
{ const name = "modlater"; const d = oldWorld(name); const fp = fingerprint(d); const r = xlate([name]);
  ok(r.code === 0 && isWorldDir(d) && !fs.existsSync(path.join(d, "world.mod.jsonl")), "IP30 setup: translated in place, no moderator log yet (this old world had no bans)", r.out.slice(-200));
  fs.writeFileSync(path.join(d, "world.mod.jsonl"), JSON.stringify({ ts: 1, actor: "u-x", verb: "ban", who: "u-y" }) + "\n");   // what the server's first ban writes
  const r2 = tool(["rollback", name]); const keep = fingerprint(d);
  ok(r2.code !== 0 && /without losing history: world\.mod\.jsonl was made since the translation/.test(r2.out) && /bans, mutes, kicks were filed/.test(r2.out) && /--discard-changes/.test(r2.out) && same(fingerprint(d), keep) && isWorldDir(d),
    "IP30 rollback refuses: the moderator log the server made since is named as history with nowhere to go; nothing changed", r2.out.slice(-500));
  const r3 = tool(["rollback", name, "--discard-changes"]);
  ok(r3.code === 0 && same(fingerprint(d), fp) && !fs.existsSync(path.join(d, "world.mod.jsonl")) && /removed world\.mod\.jsonl \(made by the server since the translation; discarded\)/.test(r3.out),
    "IP30 --discard-changes removes it too and says so; the directory is byte-identical to the original", { out: r3.out.slice(-300), keys: Object.keys(fingerprint(d)) });
  const again = xlate([name]);
  ok(again.code === 0 && isWorldDir(d), "IP30 …and the world translates again after (world.mod.jsonl no longer blocks the swap's names)", again.out.slice(-300)); }

// ================= IP26: features this protocol doesn't carry yet refuse, truthfully =================
{ const uses = [
    { actor: "Ann", verb: "comp", args: { id: "table_1", type: "water", data: { center: [0, -2, 0], size: [10, 4, 10] } } },
    { actor: "Ann", verb: "comp", args: { id: "table_1", type: "air", data: { boxes: [{ center: [0, 0, 0], size: [2, 2, 2] }] } } },
    { actor: "Bob", verb: "comp", args: { id: "cup_1", type: "traversal", data: { routes: [{ name: "ladder", path: [[0, 0, 0], [0, 3, 0]], radius: 0.5, speed: 1 }] } } },
    { actor: "Bob", verb: "comp", args: { id: "cup_1", type: "vehicle", data: { helm: [0, 1, 0], exit: [1, 0, 0], speed: 3, turnRate: 1 } } },
    { actor: "Ann", verb: "comp", args: { id: "table_1", type: "collision", data: { enabled: false } } },
    { actor: "Ann", verb: "comp", args: { id: "@world", type: "water", data: { level: 1.5 } } }];   // the world's water LEVEL: carried, not deferred (control)
  const d = oldWorld("sunk", { extra: uses }); fs.rmSync(path.join(d, "snapshot.json")); const fp = fingerprint(d); const dirBefore = fs.readFileSync(dirf, "utf8");
  const dr = tool(["translate", "sunk", "--dry-run", "--no-founder-key"]); let rep: any = null; try { rep = JSON.parse(dr.out.slice(dr.out.indexOf("{"), dr.out.lastIndexOf("}") + 1)); } catch {}
  const h = /^report-hash ([0-9a-f]{64})$/m.exec(dr.out)?.[1];
  const want = [["water volume", "table_1", 6, "Ann"], ["air box (dry interior)", "table_1", 7, "Ann"], ["climb route", "cup_1", 8, "Bob"], ["vehicle", "cup_1", 9, "Bob"], ["collision on/off toggle", "table_1", 10, "Ann"]];
  ok(dr.code !== 0 && !!h && rep && same(rep.deferred?.map((u: any) => [u.feature, u.id, u.seq, u.actor]), want) && typeof rep.refused === "string",
    "IP26 the dry run lists the five deferred uses (feature, entity, seq, actor) — and not the world's water level — and says the translation is refused (exit 1)", { code: dr.code, deferred: rep?.deferred });
  const text = rep?.refused ?? "";
  ok(/can't translate "sunk": it uses 5 thing\(s\) this protocol does not carry yet/.test(text) && /water volume, air box \(dry interior\), climb route, vehicle, collision on\/off toggle/.test(text) && /would drop them silently/.test(text) && /Nothing was written/.test(text)
    && want.every(([f, id, seq, who]) => text.includes(`seq ${seq}: ${f} (`) && text.includes(`on "${id}", set by ${who}`)) && /deferred in this protocol/.test(text) && /remove them from the old world first/.test(text),
    "IP26 the refusal names each feature, the component, the entity, the actor and the seq, says they came from main's merges and are deferred, and what to do", text);
  const forced = tool(["translate", "sunk", "--no-founder-key", "--operator-only-no-owner", "--approved", h!]);
  ok(forced.code !== 0 && /can't translate "sunk"/.test(forced.out) && /can't override this/.test(forced.out) && same(fingerprint(d), fp) && !temps().length && !isWorldDir(d) && fs.readFileSync(dirf, "utf8") === dirBefore,
    "IP26 approving the refused report doesn't override it: refused again, nothing written, no identities added", forced.out.slice(-400));
  const named = oldWorld("sunk-src", { extra: uses.slice(0, 1) }); const two = tool(["translate", "sunk-src", "sunk-new", "--no-founder-key", "--operator-only-no-owner", "--approved", dryHash(["sunk-src", "sunk-new"])]);
  ok(two.code !== 0 && /can't translate "sunk-new"|can't translate "sunk-src"/.test(two.out) && /water volume/.test(two.out) && !fs.existsSync(path.join(W, "sunk-new")) && same(fingerprint(named), fingerprint(named)),
    "IP26 the two-name form refuses the same way, and makes no new directory", two.out.slice(-300)); }

// ================= IP1: in place, the happy path (continued) =================
const r1 = xlate(["porch"]);
const after = fingerprint(porch);
ok(r1.code === 0 && /0 divergences/.test(r1.out) && /translated "porch" .*→ world "porch"/.test(r1.out), "IP1 translate <world> succeeds in place, 0 divergences", r1.out.slice(-1200));
ok(isWorldDir(porch) && !fs.existsSync(path.join(porch, "log.jsonl")), "IP1 the world keeps its name: porch/ is now a world (world.jsonl), and log.jsonl is no longer there", Object.keys(after));
ok(same(after["log.original.jsonl"], before["log.jsonl"]), "IP1 log.original.jsonl IS the original log: same bytes, same inode, same mtime (renamed, never rewritten)", [before["log.jsonl"], after["log.original.jsonl"]]);
ok(same(after["snapshot.original.json"], before["snapshot.json"]) && same(after["poses.original.json"], before["poses.json"]), "IP1 snapshot.json → snapshot.original.json and poses.json → poses.original.json, the same files", [after["snapshot.original.json"], after["poses.original.json"]]);
{ const P = JSON.parse(fs.readFileSync(path.join(porch, "poses.json"), "utf8"));
  ok(Object.keys(P).length === 1 && /^u-[a-z2-7]{20}$/.test(Object.keys(P)[0]), "IP1 the new poses.json is keyed by identity (the translated world's)", P); }
ok(!temps().length && same(Object.keys(after).sort(), ["log.original.jsonl", "poses.json", "poses.original.json", "snapshot.original.json", MANIFEST, "world.jsonl"]), "IP1 no temporary directory is left, and the directory holds exactly the new world, the kept originals and the rollback manifest", [temps(), Object.keys(after)]);
ok(/snapshot\.json agrees/.test(r1.out) && /mtime unchanged: true/.test(r1.out) && /keeps its name/.test(r1.out), "IP1 it says the snapshot oracle agreed, and that the original is kept with its mtime unchanged", r1.out.slice(-800));

{ const ap = actsOf(porch).find(([v]) => v === "translation-approved")?.[1]; const g0 = readLog(fs.readFileSync(path.join(porch, "world.jsonl"), "utf8"))[0];
  const man = JSON.parse(fs.readFileSync(path.join(porch, MANIFEST), "utf8"));
  ok(ap && /^[0-9a-f]{64}$/.test(ap.report) && ap.approval?.owner === null && ap.approval?.operator?.key === operatorPub() && verifies(ap.approval?.operator?.key ?? "", approvalText("porch", ap.report), ap.approval?.operator?.sig ?? "")
    && ap.approval?.noOwner === NO_OWNER && /no owner was attested/.test(NO_OWNER) && /v1 logs record accounts, not keys/.test(NO_OWNER) && man.approval?.owner === null && man.approval?.noOwner === NO_OWNER
    && /approved by the operator alone/.test(r1.out) && /no owner was attested/.test(r1.out),
    "IP23 the operator-only path: the act (and translation.json) records owner: null, the operator's countersignature (the custody operator key, verifying over the approval text) and, in words, that no owner was attested because nothing can bind a key to the v1 owner; the CLI says the same", { ap, out: r1.out.slice(-400) });
  ok(Array.isArray(g0?.body?.owners?.[0]) && g0.body.owners[0].length === 0 && JSON.stringify(g0.body.owners[1]) === JSON.stringify([operatorPub()]),
    "IP23 …and the translated world's genesis has tier 0 EMPTY (no founder), the host's operator key in tier 1", g0?.body?.owners); }

// ================= IP12: the oracle re-runs on the kept originals =================
{ const fp = fingerprint(porch);
  const o = Bun.spawnSync(["bun", "tools/protocol/import-v1/snapshot-oracle.ts", porch], { cwd: ENGINE, env: { ...process.env, ORACLE_SCRATCH: root, OPT_DIR: OPT, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const out = o.stdout.toString() + o.stderr.toString();
  ok(o.exitCode === 0 && /oracle: 1\/1 compared world\(s\) agree/.test(out) && same(fingerprint(porch), fp), "IP12 snapshot-oracle <translated world> compares its kept originals with the old engine (and agrees), touching nothing", out.slice(-600)); }

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
  ok(names.includes("waiting") && !names.includes("porch") && !/"porch"/.test(notice) && /"waiting"/.test(notice), "IP3 the boot notice names the world still waiting and not the translated one (control: a waiting world IS named)", [names, notice]);
  ok(notice.includes(`WORLDS_DIR=${shellWord(W)} bun tools/protocol/world.ts translate waiting --dry-run --no-founder-key`) && notice.includes(`translate waiting --no-founder-key --approved <the report hash the dry run printed> --operator-only-no-owner`)
    && !/--founder-key </.test(notice) && !/approve-sig/.test(notice) && /keeps its name, so links to it keep working/.test(notice), "IP3 …and its commands are the in-place form, the one path: the dry run, then the operator-only translation (no founder key: none can be bound to the owner)", notice); }

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
{ const fp = fingerprint(porch); const r = xlate(["porch"]);
  ok(r.code !== 0 && /already translated/.test(r.out) && /log\.original\.jsonl/.test(r.out) && /Nothing was changed/.test(r.out), "IP4 translating a translated world refuses: it says it's already translated, where the original is, and that nothing changed", r.out);
  ok(same(fingerprint(porch), fp) && !temps().length, "IP4 …and nothing changed on disk", temps()); }

// ================= IP5: a verification failure moves nothing =================
{ const d = oldWorld("crooked", { tamper: true }); const fp = fingerprint(d), dirf = path.join(W, ".directory.json"), dirBefore = fs.readFileSync(dirf, "utf8");
  const r = xlate(["crooked"]);
  ok(r.code !== 0 && /doesn't agree with the old engine's own snapshot\.json/.test(r.out) && /Nothing was moved/.test(r.out), "IP5 a translation that disagrees with snapshot.json is refused, and it says why (the snapshot oracle) and that nothing moved", r.out.slice(-1500));
  ok(same(fingerprint(d), fp) && !isWorldDir(d), "IP5 the original directory is exactly as it was (every file's bytes, inode, mtime)", fingerprint(d));
  ok(!temps().length && fs.readFileSync(dirf, "utf8") === dirBefore, "IP5 no temporary directory is left, and no identities were added (the oracle runs before anything is written)", temps()); }

// ================= IP6: a failure at each step of the swap puts everything back =================
{ const d = oldWorld("swapper"); const fp = fingerprint(d);
  // steps: world.jsonl in, log.jsonl → log.original.jsonl, snapshot.json → …, poses.json → …, poses.json in (the new one), translation.json in
  const results: any[] = [];
  for (let k = 0; k < 6; k++) { const r = xlate(["swapper"], { WORLD_TS_FAULT_AT_STEP: String(k) });
    results.push({ k, code: r.code, restored: same(fingerprint(d), fp), temps: temps().length, said: /the swap failed: \(injected\) step \d+ failed; everything that had moved was put back/.test(r.out) }); }
  ok(results.every((x) => x.code !== 0 && x.restored && x.temps === 0 && x.said), "IP6 a failure at any step of the swap (0..5) puts every moved file back, removes the temporary directory and says so", results);
  const r = xlate(["swapper"]);
  ok(r.code === 0 && isWorldDir(d) && same(fingerprint(d)["log.original.jsonl"], fp["log.jsonl"]), "IP6 …and a clean run afterwards translates it in place", r.out.slice(-600)); }

// ================= IP8: the two-name form still works =================
{ const d = oldWorld("elsewhere"); const fp = fingerprint(d);
  const r = xlate(["elsewhere", "elsewhere-new"]);
  ok(r.code === 0 && isWorldDir(path.join(W, "elsewhere-new")) && same(fingerprint(d), fp) && oldWorldAt(W, "elsewhere")?.kind === "translatable", "IP8 translate <old> <new> still makes a new world under the new name and leaves the old directory as it was", r.out.slice(-600)); }

// ================= IP10: no old log =================
{ fs.mkdirSync(path.join(W, "hollow"), { recursive: true });
  const r = xlate(["hollow"]);
  ok(r.code !== 0 && /holds no old log/.test(r.out) && !temps().length, "IP10 a directory with no old log refuses with that reason", r.out); }

// ================= IP11: a snapshot the oracle can't compare is reported, not compared =================
{ const d = oldWorld("partial"); const sf = path.join(d, "snapshot.json"); const S = JSON.parse(fs.readFileSync(sf, "utf8")); S.seq -= 1; fs.writeFileSync(sf, JSON.stringify(S));
  const fp = fingerprint(d); const r = xlate(["partial"]);
  ok(r.code === 0 && /snapshot\.json NOT compared: snapshot\.seq \d+ ≠ the log's last seq/.test(r.out) && isWorldDir(d) && same(fingerprint(d)["snapshot.original.json"], fp["snapshot.json"]),
    "IP11 a partial snapshot.json is reported as NOT compared (with the oracle's reason), and kept as snapshot.original.json", r.out.slice(-700)); }

// ================= IP13: the process dies between swap steps; a re-run finishes the swap (review r11 L4) =================
// WORLD_TS_DIE_AT_STEP=k (tests only) exits the process after k renames, with no rollback: a death, not a thrown error
// (IP6 covers those). k=1: world.jsonl has landed (the directory is a world) and log.jsonl is still beside it; k=3: the
// old snapshot is renamed and poses.json is not. The re-run notices (log.jsonl beside world.jsonl, or the temporary
// directory still there), finishes the renames and moves the rest of the translated files in, and says so; the original
// log is the untouched file throughout, and a third run says it's already translated
for (const k of [1, 3]) { const name = `halfway${k}`; const d = oldWorld(name); const fp = fingerprint(d);
  const died = xlate([name], { WORLD_TS_DIE_AT_STEP: String(k) }); const mid = fingerprint(d); const midTemps = temps().filter((t) => t.includes(name)).length;
  const r = tool(["translate", name, "--no-founder-key"]); const after = fingerprint(d);   // a recovery needs no new approval: it finishes the approved one
  const again = xlate([name]);
  const info = tool(["info", name]);
  ok(died.code !== 0 && !!mid["world.jsonl"] && (k === 1 ? !!mid["log.jsonl"] : !!mid["snapshot.original.json"] && !!mid["poses.json"] && !mid["poses.original.json"]) && midTemps === 1,
    `IP13 (k=${k}) a death after ${k} rename(s) leaves the half-swapped directory (world.jsonl landed, the rest not) and its temporary directory`, { code: died.code, mid: Object.keys(mid), midTemps });
  ok(r.code === 0 && /interrupted/.test(r.out) && /finished/.test(r.out) && same(after["log.original.jsonl"], fp["log.jsonl"]) && same(after["snapshot.original.json"], fp["snapshot.json"]) && same(after["poses.original.json"], fp["poses.json"])
    && same(Object.keys(after).sort(), ["log.original.jsonl", "poses.json", "poses.original.json", "snapshot.original.json", MANIFEST, "world.jsonl"]) && !temps().some((t) => t.includes(name)) && after["world.jsonl"][0] === mid["world.jsonl"][0],
    `IP13 (k=${k}) the re-run notices the interrupted swap and finishes it: the originals renamed beside it (the same files), the translated files moved in, no temporary directory left, and it says so`, { code: r.code, out: r.out.slice(-600), keys: Object.keys(after) });
  ok(again.code !== 0 && /already translated/.test(again.out) && info.code === 0 && /"status": "ok"/.test(info.out), `IP13 (k=${k}) …then it's a translated world like any other (a third run says so; info opens it)`, { again: again.out.slice(-300), info: info.out.slice(-300) }); }

// ================= IP14–IP16: the old log must not change under the translation (review of PR #260, world.ts:99) =================
// IP14 a writer (an old server still running) appends to log.jsonl the whole time the translation runs: the swap refuses
//      (it says the old log changed and to stop the old server), moves nothing, and every line the writer wrote is still there
{ const name = "stillwriting"; const d = oldWorld(name); fs.rmSync(path.join(d, "snapshot.json"));   // no oracle (it would refuse on a growing log for its own reason)
  const logf = path.join(d, "log.jsonl"); let n = 0;
  const writer = setInterval(() => { try { fs.appendFileSync(logf, JSON.stringify({ seq: 100 + n, ts: T0 + 100000 + n, actor: "Bob", verb: "say", args: { text: `late ${n}` } }) + "\n"); n++; } catch { /* gone */ } }, 2);
  const proc = Bun.spawn(["bun", "tools/protocol/world.ts", "translate", name, "--no-founder-key", "--operator-only-no-owner", "--approved", dryHash([name])], { cwd: ENGINE, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, TRUST_NAMES: "1", WORLDS_DIR: W, OPT_DIR: OPT, PROTOCOL_SCRATCH: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const code = await proc.exited; clearInterval(writer);
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  const lines = fs.readFileSync(logf, "utf8").split("\n").filter(Boolean).length;
  ok(code !== 0 && /changed while it was being translated|is not the one that was approved/.test(out) && !fs.existsSync(path.join(d, "world.jsonl")) && fs.existsSync(logf) && lines === L.length + n && !temps().some((t) => t.includes(name)),
    "IP14 an old log written to during the translation: the approval check or the swap refuses (the report changed / stop the old server), nothing moves, and every line written is still there", { code, out: out.slice(-500), world: fs.existsSync(path.join(d, "world.jsonl")), lines, wrote: n }); }
// IP15 a write that slips in mid-swap (injected after 2 renames: world.jsonl landed, log.jsonl renamed beside it) undoes the swap
{ const name = "midswap"; const d = oldWorld(name);
  const r = xlate([name], { WORLD_TS_TOUCH_SOURCE_AT_STEP: "2" }); const after = fingerprint(d);
  ok(r.code !== 0 && /changed while it was being translated/.test(r.out) && /put back/.test(r.out) && !after["world.jsonl"] && !!after["log.jsonl"] && !after["log.original.jsonl"] && !temps().some((t) => t.includes(name))
    && fs.readFileSync(path.join(d, "log.jsonl"), "utf8").includes("written during the swap"),
    "IP15 a write that slips in mid-swap: the swap is undone (everything put back, the late line kept in log.jsonl)", { code: r.code, out: r.out.slice(-500), keys: Object.keys(after) }); }
// IP16 the recovery of an interrupted swap checks the same: a death after world.jsonl landed, then the old log is written to;
//      the re-run refuses to finish (it would drop that write) and moves nothing
{ const name = "halfwritten"; const d = oldWorld(name);
  const died = xlate([name], { WORLD_TS_DIE_AT_STEP: "1" });
  fs.appendFileSync(path.join(d, "log.jsonl"), JSON.stringify({ seq: 50, ts: T0 + 50000, actor: "Bob", verb: "say", args: { text: "after the crash" } }) + "\n");
  const mid = fingerprint(d); const r = tool(["translate", name, "--no-founder-key"]); const after = fingerprint(d);
  ok(died.code !== 0 && r.code !== 0 && /changed while it was being translated/.test(r.out) && same(after, mid) && temps().some((t) => t.includes(name)),
    "IP16 finishing an interrupted swap refuses when the old log changed since it was read, and moves nothing", { died: died.code, code: r.code, out: r.out.slice(-500), same: same(after, mid) }); }

// ================= IP17–IP18: identities are written only once the world is in place (review of PR #260, import-v1/world.ts:86) =================
// IP17 with no TRUST_NAMES, Ann and Bob are imported people with no account: each attempt mints them anew. A failure before,
//      during or after the renames (injected at step 0, 2 and 6 — 6 is after the last rename) and a concurrent writer each
//      leave the shared directory exactly as it was; the clean run then adds them once
const actorsOf = (d: string) => [...new Set(fs.readFileSync(path.join(d, "world.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).actor).filter((a: string) => /^u-/.test(a)))];
{ const name = "nameless"; const d = oldWorld(name); const before = fs.readFileSync(dirf, "utf8");
  const runs = [0, 2, 6].map((k) => { const r = xlate([name], { TRUST_NAMES: "", WORLD_TS_FAULT_AT_STEP: String(k) });
    return { k, code: r.code, dirSame: fs.readFileSync(dirf, "utf8") === before, temps: temps().filter((t) => t.includes(name)).length }; });
  const ok1 = xlate([name], { TRUST_NAMES: "" });
  const ids = JSON.parse(fs.readFileSync(dirf, "utf8")).ids ?? {}; const was = JSON.parse(before).ids ?? {};
  const added = Object.keys(ids).filter((k) => !was[k]); const actors = actorsOf(d);
  ok(runs.every((x) => x.code !== 0 && x.dirSame && x.temps === 0), "IP17 a failed in-place translation (before, during or after the renames) adds no identity to the shared directory", runs);
  ok(ok1.code === 0 && actors.length >= 2 && actors.every((a) => ids[a]) && added.length === actors.filter((a) => !was[a]).length,
    "IP17 …and the clean run adds exactly the identities its world names, once (no leftovers from the failed attempts)", { code: ok1.code, out: ok1.out.slice(-300), added: added.length, actors: actors.length }); }
// IP18 the recovery of an interrupted swap writes the identities the interrupted run planned (it died before writing them)
{ const name = "nameless2"; const d = oldWorld(name);
  const died = xlate([name], { TRUST_NAMES: "", WORLD_TS_DIE_AT_STEP: "1" });
  const mid = JSON.parse(fs.readFileSync(dirf, "utf8")).ids ?? {}; const actors = actorsOf(d);
  const r = tool(["translate", name, "--no-founder-key"], { TRUST_NAMES: "" }); const ids = JSON.parse(fs.readFileSync(dirf, "utf8")).ids ?? {};
  ok(died.code !== 0 && actors.some((a) => !mid[a]) && r.code === 0 && actors.every((a) => ids[a]) && /identit/.test(r.out),
    "IP18 an interrupted swap's identities aren't in the directory until the recovery finishes it, which adds them", { died: died.code, missingMid: actors.filter((a) => !mid[a]).length, code: r.code, out: r.out.slice(-300) }); }

console.log(`inplace: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
