// tools/protocol/pretrans-check.ts — the protocol edges the Commons translation makes permanent (review 2026-10-07
// "protocol shape", H1–H5, M3, M5, M7, L2, L3; R's rulings the same day). Every case here was red before its fix.
//   bun tools/protocol/pretrans-check.ts               every case
//   bun tools/protocol/pretrans-check.ts --only J1,N2  just those
// Cases:
//   J   I-JSON: an integer the reader would refuse is refused by the authority's own check, with a fix (L2)
//   S   the spec says what the readers do: `by` is in the envelope table; the governance body is written down (L3, H4)
//   C   a refusal or help text cites a section PROTOCOL.md has, under the name it has there (M5)
//   A   the agent's words match the log's: translated acts are `imported` (M5)
//   G   governance: a lower tier can never add keys above itself (H4); gov.py runs here
//   K   the Commons' translation carries its owners; its tier 0 is EMPTY (#260 rereview blocker 1: no key can be bound to the
//       v1 owner); a world FOUNDED new takes its founder's own key (H4)
//   N   names: bare names belong to the registry; anyone else's carry a namespace; a registered alias works (H1, M7)
//   D   defaults: every parameter is written into the stored value at create/add time (H2); meanings are pinned
//   I   ids: minted ids are ≥ 128 random bits, everywhere (H5)
//   F   forks: genesis.parent {world, seq, head}; copied acts are marked (H5)
//   R   references: typed ref/refs/person fields; duplicate and publish rebind them (H5)
//   P   privacy: arrivals and grabs log what correctness needs, not where people stood or what they are (M3)
//   U   model values are content addresses after translation; the server and the client resolve them (H3)
// @ts-nocheck
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ENGINE, scratch } from "./common.ts";
import { CAPACITY } from "../../shared/protocol/authority.js";
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const only = opt("only")?.split(",") ?? null;
const T = ENGINE;
const imp = async (p: string) => await import(path.join(T, p));
const FOLD = await imp("shared/protocol/fold.js"), D = await imp("shared/protocol/authority.js"), CAT = await imp("shared/protocol/componentspec.js");
const SD = await imp("tools/protocol/scratchworld.ts");
const PH = await imp("tools/protocol/pinhistory.ts");
let pass = 0, fail = 0;
const ok = (id: string, cond: any, what: string, detail?: any) => {
  if (cond) { pass++; console.log(`  ok ${id} ${what}`); }
  else { fail++; console.log(`  FAIL ${id} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 600)}` : ""}`); } };
async function C(id: string, what: string, fn: () => any) {
  if (only && !only.includes(id)) return;
  try { const r = await fn(); if (Array.isArray(r)) ok(id, r[0], what, r[1]); else ok(id, r, what); }
  catch (e) { ok(id, false, what, `threw: ${e?.stack ?? e}`); }
}
const why = (r: any) => (r?.ok ? "ok" : `${r?.refused?.code}: ${r?.refused?.reason}`);
const world = (tag = "pre") => SD.scratchWorld(tag);
const read = (p: string) => fs.readFileSync(path.join(T, p), "utf8");
const SPEC = read("spec/PROTOCOL.md");
if (argv.includes("--pin")) {   // regenerate the registry pin: an addition re-pins freely; a break on a trial or reserved name
  // needs --ack "<why>" (a line in spec/REGISTRY-CHANGELOG.md); a stable name's break never re-pins (CAT.pinVerdict)
  const old = fs.existsSync(path.join(T, "spec/registry-pin.json")) ? JSON.parse(read("spec/registry-pin.json")) : {};
  const v = CAT.pinVerdict(old, CAT.pinOf(), opt("ack") ?? null);
  if (!v.ok) { console.log("refusing to re-pin: " + v.why); process.exit(1); }
  if (v.changelog) { const f = path.join(T, "spec/REGISTRY-CHANGELOG.md");
    if (!fs.existsSync(f)) fs.writeFileSync(f, "# Registry changelog\n\nEvery re-pin of spec/registry-pin.json that changed, removed or narrowed a trial or reserved component (PROTOCOL §4 Status;\ndocs/COMPONENT-LADDER.md). Written by `bun tools/protocol/pretrans-check.ts --pin --ack \"<why>\"`, newest last.\n\n");
    fs.appendFileSync(f, v.changelog); console.log(`spec/REGISTRY-CHANGELOG.md: ${v.breaks.length} acknowledged`); }
  fs.writeFileSync(path.join(T, "spec/registry-pin.json"), JSON.stringify(CAT.pinOf(), null, 1) + "\n"); console.log("spec/registry-pin.json written"); process.exit(0); }

// ---- J: I-JSON (L2) ----
const throws = (f: () => any) => { try { f(); return null; } catch (e) { return e; } };
await C("J1", "checkIJSON refuses 2^65 (it would be written 36893488147419103000, which the reader marks ijson-bigint)", () => {
  const e = throws(() => FOLD.checkIJSON({ n: 2 ** 65 })); return [e instanceof FOLD.Malformed && e.code === "ijson-bigint", e?.code ?? "accepted"]; });
await C("J2", "checkIJSON keeps what the reader keeps: 2^53, 2^54, 1e21, -2^54 (exactly spelled), 0.5", () => {
  const vals = [2 ** 53, 2 ** 54, 1e21, -(2 ** 54), 0.5, 123456789012];
  const bad = vals.filter((v) => throws(() => FOLD.checkIJSON(v)) || FOLD.readLog(JSON.stringify({ v }))[0] instanceof FOLD.Malformed);
  return [!bad.length, bad]; });
await C("J3", "the two checks agree on 2 000 large integers either side of 2^53", () => {
  const dis = []; for (let i = 0; i < 2000; i++) { const v = Math.round(2 ** (50 + (i % 20)) * (1 + i / 977)) * (i % 2 ? -1 : 1);
    const a = !throws(() => FOLD.checkIJSON(v)); const b = !(FOLD.readLog(JSON.stringify({ v }))[0] instanceof FOLD.Malformed);
    if (a !== b) dis.push([v, a, b]); } return [!dis.length, dis.slice(0, 5)]; });
await C("J4", "a set of 2^65 is refused by the authority as a shape, with a fix (not a server error)", () => {
  const W = world(); W.call("create", { id: "box", model: "crate" });
  const r = W.call("set", { id: "box", component: "params", value: { lean: 2 ** 65 } });
  return [!r.ok && r.refused.code === "shape" && /I-JSON/.test(r.refused.reason) && !!r.refused.fix, r]; });

// ---- S: the spec says what the readers do (L3) ----
await C("S1", "`by` is in the envelope table as a legacy field readers ignore", () => {
  const table = SPEC.slice(SPEC.indexOf("**The envelope.**"), SPEC.indexOf("**The kinds.**"));
  return [/^\| `by` \|.*ignore/im.test(table), table.split("\n").filter((l) => l.startsWith("|")).map((l) => l.slice(0, 30))]; });

await C("S2", "the spec carries the alpha note (no guarantee, we try not to break, repair paths) and §9.2's component conventions", () => {
  const alpha = SPEC.slice(SPEC.indexOf("**Alpha.**"), SPEC.indexOf("## 0."));
  const conv = SPEC.slice(SPEC.indexOf("### 9.2 Component conventions"), SPEC.indexOf("## 10."));
  const need = ["metres, kilograms, seconds", "epoch milliseconds", "radians", "[x, y, z, w]", "3-vectors", "names its frame", "sRGB", "content addresses", "drops that field", "current default", "never written whole", "No person data", "refPaths", "role id", "falloff", "required"];
  return [/about a year/.test(alpha) && /no guarantee/i.test(alpha) && /repair/.test(alpha) && need.every((n) => conv.includes(n)), need.filter((n) => !conv.includes(n))]; });

// ---- C: citations (M5) ----
// every "§N" or "§N.M" inside a string literal of the files whose words reach people and agents names a heading of
// PROTOCOL.md (or PHYSICS.md when it says PHYSICS); lab-era names (§2.3, §3d, L1–L7, R8…) are gone from those words
const HEAD = new Set([...SPEC.matchAll(/^#{2,3} (\d+[a-z]?(?:\.\d+)?)\.?\s/gm)].map((m) => m[1]));   // "## 7a." is a section too
const PHYS = new Set([...read("spec/PHYSICS.md").matchAll(/^#{2,3} (\d+(?:\.\d+)?)\./gm)].map((m) => m[1]));
const SAID = ["shared/protocol/authority.js", ...fs.readdirSync(path.join(T, "shared/protocol/authority")).filter((f) => f.endsWith(".js")).map((f) => `shared/protocol/authority/${f}`), "shared/protocol/componentspec.js", "shared/protocol/verbspec.js", "shared/protocol/refusal.js", "shared/protocol/roles.js", "mcpl/tools.ts", "shared/grab.js", "shared/sockbody.js"];
function literals(src: string) {   // string literals, comments skipped (a small scanner: enough for these files)
  const out: string[] = []; let i = 0;
  while (i < src.length) { const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2); if (i < 0) break; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") { let j = i + 1, s = ""; while (j < src.length && src[j] !== c) { if (src[j] === "\\") { s += src[j + 1]; j += 2; continue; } if (c !== "`" && src[j] === "\n") break; s += src[j++]; } out.push(s); i = j + 1; continue; }
    i++; }
  return out;
}
await C("C1", "every § a person or agent reads names a section the spec has", () => {
  const bad = [];
  for (const f of SAID) { if (!fs.existsSync(path.join(T, f))) continue;
    for (const s of literals(read(f))) for (const m of s.matchAll(/(PHYSICS )?§(\d+[a-z]?(?:\.\d+)?)/g))
      if (!(m[1] ? PHYS : HEAD).has(m[2])) bad.push(`${f}: ${m[0]} in "${s.slice(Math.max(0, m.index - 30), m.index + 30)}"`); }
  if (process.env.VERBOSE) for (const b of bad) console.log("    " + b);
  return [!bad.length, bad.slice(0, 8)]; });
await C("C2", "no lab-era law names (L1–L7, R7, §3d…) in what a person or agent reads", () => {
  const bad = [];
  for (const f of SAID) { if (!fs.existsSync(path.join(T, f))) continue;
    for (const s of literals(read(f))) { const m = /\b(L[1-7]|R(?:7|8|9|10)|§3d)\b/.exec(s); if (m && /[a-z] /.test(s)) bad.push(`${f}: ${m[0]} in "${s.slice(Math.max(0, m.index - 30), m.index + 30)}"`); } }
  if (process.env.VERBOSE) for (const b of bad) console.log("    " + b);
  return [!bad.length, bad.slice(0, 8)]; });

await C("C3", "a lock's words cite §7 (Locks), where the spec keeps them, not §5 (Two planes)", () => {
  const bad = [];
  for (const f of SAID) { if (!fs.existsSync(path.join(T, f))) continue;
    for (const s of literals(read(f))) if (/\block/i.test(s) && /§5\b/.test(s)) bad.push(`${f}: "${s.slice(0, 90)}"`); }
  return [!bad.length && /\*\*Locks\.\*\*/.test(SPEC.slice(SPEC.indexOf("## 7."), SPEC.indexOf("## 8."))), bad]; });

// ---- A: the agent's words (M5) ----
await C("A1", "the agent tools call a translated act what the log calls it: imported", () => {
  const src = read("mcpl/tools.ts"); const bad = literals(src).filter((s) => /\blegacy\b/.test(s));
  return [!bad.length, bad.map((s) => s.slice(0, 120))]; });

// ---- G: governance (H4) ----
const py = (args: string[], cwd = path.join(T, "spec/conformance")) => Bun.spawnSync(["python3", "-B", ...args], { cwd, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
await C("G1", "gov.py: a lower tier can't add or promote keys into a higher tier (test_gov.py, with the reviewer's escalation as GV1)", () => {
  const r = py(["test_gov.py"]); const out = r.stdout.toString() + r.stderr.toString(); return [r.exitCode === 0, out.split("\n").filter((l) => /FAIL|passed|Error/.test(l))]; });
await C("G2", "the suite runs the governance tests (compare.ts lists test_gov.py)", () => /"test_gov\.py"/.test(read("tools/protocol/compare.ts")));
await C("G3", "§13 marks governance RESERVED (review #260 item 8): the server never writes a `sequencer` entry and refuses a log holding one; the draft rules (GOV-1..5, the signed message) live on the wishlist and in gov.py, not in the spec", () => {
  const g = SPEC.slice(SPEC.indexOf("## 13."), SPEC.indexOf("## 14."));
  const need = ["Governance is RESERVED", "refuses to serve a log that holds one", "conformance/gov.py", "not normative"]; const gone = ["eidoverse-gov:", "GOV-3"];
  return [need.every((n) => g.includes(n)) && gone.every((n) => !g.includes(n)), { missing: need.filter((n) => !g.includes(n)), stillThere: gone.filter((n) => g.includes(n)) }]; });

// ---- K: the Commons' keys and owners (H4) ----
const TV1 = await imp("tools/protocol/import-v1/translate-v1.js");
const KEYS = await imp("shared/protocol/fold.js");
const FOUNDER_KP = require("node:crypto").generateKeyPairSync("ed25519");   // a founder's own key: create-world takes it (K5); a translation refuses it (K1, K3)
const FOUNDER = "ed25519:" + Buffer.from(FOUNDER_KP.publicKey.export({ format: "der", type: "spki" })).subarray(12).toString("base64url");
const v1commons = () => [{ seq: 0, ts: 1, actor: "world", verb: "grant", args: { id: "antra", role: "owner", gen: true } },
  { seq: 1, ts: 2, actor: "antra", verb: "grant", args: { id: "Digi_Rat", role: "builder" } },
  { seq: 2, ts: 3, actor: "antra", verb: "grant", args: { id: "fable", role: "owner" } },
  { seq: 3, ts: 4, actor: "antra", verb: "grant", args: { id: "janus", role: "owner", sub: "human:discord:1" } },
  { seq: 4, ts: 5, actor: "antra", verb: "grant", args: { id: "mica", role: "owner" } },
  { seq: 5, ts: 6, actor: "antra", verb: "spawn", args: { id: "rock_1", lib: "store/0123456789abcdef.glb", pos: [0, 0, 0] } }];
await C("K1", "a translation's genesis has tier 0 EMPTY and the operator's key in tier 1; translate() refuses a founder key (#260 rereview blocker 1: nothing can bind a key to the v1 owner)", () => {
  const r = TV1.translate(v1commons(), { operator: TV1.LAB_DOOR_KEY });
  let threw = ""; try { TV1.translate(v1commons(), { founder: FOUNDER }); } catch (x) { threw = String((x as Error).message); }
  const g = r.out[0].body; return [JSON.stringify(g.owners) === JSON.stringify([[], [TV1.LAB_DOOR_KEY]]) && KEYS.checkGenesis(g) === null && /names no founder/.test(threw), { owners: g.owners, threw }]; });
await C("K2", "the Commons' roles come across: antra, fable, janus, mica owners; Digi_Rat builder", () => {
  const r = TV1.translate(v1commons()); const w = r.final.translated["@world"];
  const role = (n: string) => w[`roles:${TV1.enc(n)}`]?.role;
  return [["antra", "fable", "janus", "mica"].every((n) => role(n) === "owner") && role("Digi_Rat") === "builder", Object.keys(w).filter((k) => k.startsWith("roles:"))]; });
await C("K3", "the translate command refuses --founder-key (no key can be bound to the v1 owner) and translates only knowingly, --no-founder-key --operator-only-no-owner, with tier 0 empty", () => {
  const W = scratch("ktr"); fs.mkdirSync(path.join(W, "old"), { recursive: true });
  fs.writeFileSync(path.join(W, "old", "log.jsonl"), v1commons().map((e) => JSON.stringify(e)).join("\n") + "\n");
  const run = (...extra: string[]) => Bun.spawnSync(["bun", path.join(T, "tools/protocol/world.ts"), "translate", "old", ...extra], { cwd: T, env: { ...process.env, WORLDS_DIR: W, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  // review of PR #260 item 6 and its rereview blocker 1: the dry run, then the operator's countersignature alone, bound to its hash
  const bare = run("new1"); const keyed = run("new2", "--dry-run", "--founder-key", FOUNDER);
  const dry = run("new2", "--dry-run", "--no-founder-key"); const hash = /^report-hash ([0-9a-f]{64})$/m.exec(dry.stdout.toString())?.[1] ?? "no-hash";
  const noKey = run("new2", "--no-founder-key", "--approved", hash, "--operator-only-no-owner");
  const g = fs.existsSync(path.join(W, "new2", "world.jsonl")) ? JSON.parse(fs.readFileSync(path.join(W, "new2", "world.jsonl"), "utf8").split("\n")[0]).body : null;
  return [bare.exitCode !== 0 && !fs.existsSync(path.join(W, "new1", "world.jsonl")) && keyed.exitCode !== 0 && /nothing can yet bind a key to the old world's owner/.test(keyed.stderr.toString())
    && noKey.exitCode === 0 && Array.isArray(g?.owners?.[0]) && g.owners[0].length === 0,
    { bare: bare.exitCode, bareSaid: bare.stderr.toString().slice(0, 200), keyed: keyed.stderr.toString().slice(0, 300), noKey: noKey.exitCode, said: noKey.stderr.toString().slice(0, 300), owners: g?.owners }]; });
await C("K4", "the founder proves the key is theirs before it's baked in: world.ts owner-key checks a signature over the ceremony text", () => {
  const kp = require("node:crypto").generateKeyPairSync("ed25519");
  const pub = "ed25519:" + Buffer.from(kp.publicKey.export({ format: "der", type: "spki" })).subarray(12).toString("base64url");
  const msg = `eidoverse-owner-key:${pub}`; const sig = require("node:crypto").sign(null, Buffer.from(msg), kp.privateKey).toString("base64");
  const run = (s: string) => Bun.spawnSync(["bun", path.join(T, "tools/protocol/world.ts"), "owner-key", pub, s], { cwd: T, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const good = run(sig), bad = run(Buffer.from(sig, "base64").map((x, i) => (i === 3 ? x ^ 1 : x)).toString("base64"));
  return [good.exitCode === 0 && bad.exitCode !== 0, [good.exitCode, good.stdout.toString().slice(0, 200), bad.exitCode]]; });
await C("K5", "create-world takes the founder's own key for tier 0 (ownerKey); without one, tier 0 stays empty and the reply says so", async () => {
  const { openWorld } = await imp("server/filehost.ts"); const root = scratch("k5"); process.env.PROTOCOL_NOW = String(1800000000000);
  const w1 = openWorld(root, "a"), w2 = openWorld(root, "b"), w3 = openWorld(root, "c");
  const r1 = D.request(w1, "kay", "create-world", { title: "a", ownerKey: FOUNDER });
  const r2 = D.request(w2, "kay", "create-world", { title: "b" });
  const r3 = D.request(w3, "kay", "create-world", { title: "c", ownerKey: "ed25519:AAAA" });
  return [r1.ok && JSON.stringify(w1.entries[0].body.owners[0]) === JSON.stringify([FOUNDER]) && r2.ok && w2.entries[0].body.owners[0].length === 0 && /tier 0/.test(JSON.stringify(r2))
    && !r3.ok && r3.refused.code === "shape", [w1.entries[0]?.body?.owners, r2, r3.refused]]; });
await C("K6", "the import README documents the Commons translation (no founder key, tier 0 empty, no owner attested) and the founder's own key for a world founded new", () => {
  const t = read("tools/protocol/import-v1/README.md"); const need = ["owner-key", "openssl", "custody.json", "antra", "--no-founder-key --operator-only-no-owner", "tier 0 stays empty", "no owner was attested", "ownerKey"]; return [need.every((n) => t.includes(n)), need.filter((n) => !t.includes(n))]; });

await C("K7", "no account subject is written (PROTOCOL §9.2): without a mapper the translation's roles:janus has no sub and the imported grant act's args don't either; the door refuses roles {sub}", () => {
  const r = TV1.translate(v1commons()); const w = r.final.translated["@world"];
  const acts = r.out.filter((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === "grant");
  const W = world(); const sub = W.call("set", { id: "@world", component: "roles:vic", value: { role: "inhabitant", sub: "human:discord:9" } });
  return [w[`roles:${TV1.enc("janus")}`]?.role === "owner" && !("sub" in w[`roles:${TV1.enc("janus")}`]) && acts.length >= 4 && !JSON.stringify(acts).includes("human:discord") && !sub.ok && sub.refused.code === "schema"
    && /@1[4-9]$/.test(TV1.TRANSLATOR) && /@1[4-9]$/.test(TV1.TRANSLATOR_SIM), [w[`roles:${TV1.enc("janus")}`], acts.map((a: any) => a.body.args), sub.refused, TV1.TRANSLATOR]]; });
await C("K8", "no account subject is written wherever it sits (PROTOCOL §9.2): a v1 placer's sub and a behaviour binding's bySub reach neither an imported act nor @world's state, with a mapper or without one; with a mapper, the placer and the binding are the same identity as the person's grant; a sub or *Sub that isn't an account (a comp's own data) is kept as it was, and the mapper is never asked about it", () => {
  // the two places main's server stamped an account below the top level (server/verbs.ts at 306a00b0): a spawn's or light's
  // placer {id, sub}, and a behaviour binding's bySub (which the v1 fold keeps as the binding's authorSub). janus's grant
  // carries the same account (v1commons), so a mapper must land all three on one identity
  const SRC = "sha256:" + "c".repeat(64), SIGN = { title: "The Inn", sub: "rooms upstairs", menuSub: "soup today" };
  const log = [...v1commons(),
    { seq: 6, ts: 7, actor: "janus", verb: "spawn", args: { id: "lamp_2", lib: "store/0123456789abcdef.glb", pos: [1, 0, 0], placer: { id: "janus", sub: "human:discord:1" } } },
    { seq: 7, ts: 8, actor: "janus", verb: "behavior", args: { id: "bell", src: SRC, bySub: "human:discord:1" } },
    // v1's comp folded its data blindly: a sign's subtitle under `sub` is data, not an account
    { seq: 8, ts: 9, actor: "antra", verb: "comp", args: { id: "rock_1", type: "sign", data: SIGN } }];
  // a mapper keyed by the account when one is given, else by the name: an identity reached through an account, not a name,
  // which is what joins a person's acts to their grant on a server where names don't (TRUST_NAMES, an agent's token name)
  const idOf = (k: string) => "u-" + [...require("node:crypto").createHash("sha256").update(k).digest("hex").slice(0, 20)].map((c) => "abcdefghijklmnop"[parseInt(c, 16)]).join("");
  const asked: string[] = [];
  const who = (name: string, { sub }: { sub?: string } = {}) => { asked.push(name, sub ?? ""); return idOf(sub ?? `name:${name}`); };
  const plain = TV1.translate(log), mapped = TV1.translate(log, { who });
  const sign = (r: any) => [act(r, "comp", "rock_1")?.data, Object.values(r.final.translated[TV1.enc("rock_1")] ?? {}).find((v: any) => v?.title === SIGN.title)];
  const signKept = (r: any) => sign(r).every((v: any) => JSON.stringify(v) === JSON.stringify(SIGN));
  const leaked = (r: any) => JSON.stringify(r.out).includes("human:discord");
  const act = (r: any, verb: string, id: string) => r.out.find((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === verb && e.body.args?.id === id)?.body.args;
  const binding = (r: any) => Object.values(r.final.translated["@world"] ?? {}).find((v: any) => v?.src === SRC) as any;
  const janus = idOf("human:discord:1");
  const mp = act(mapped, "spawn", "lamp_2")?.placer, pp = act(plain, "spawn", "lamp_2")?.placer, mb = binding(mapped), pb = binding(plain);
  return [!leaked(plain) && !leaked(mapped) && plain.stats.divergences === 0 && mapped.stats.divergences === 0
    && pp?.id === "janus" && !("sub" in pp) && !("bySub" in (act(plain, "behavior", "bell") ?? { bySub: 1 })) && pb && !("authorSub" in pb)
    && act(mapped, "grant", "janus")?.sub === janus && mp?.sub === janus && act(mapped, "behavior", "bell")?.bySub === janus
    && mb?.author === janus && !("authorSub" in mb) && mapped.final.translated["@world"][`roles:${janus}`]?.role === "owner"
    && TV1.accountIn(plain.out) === null && TV1.accountIn(mapped.out) === null && TV1.accountIn(log.map((e) => ({ kind: "act", verb: "imported", body: { verb: e.verb, args: e.args } })))?.path === "body.args.sub"
    && signKept(plain) && signKept(mapped) && !asked.some((s) => [SIGN.sub, SIGN.menuSub].includes(s)),
    { plain: { leaked: leaked(plain), placer: pp, binding: pb, sign: sign(plain) }, mapped: { leaked: leaked(mapped), placer: mp, binding: mb, grant: act(mapped, "grant", "janus"), janus, sign: sign(mapped) }, asked, accountIn: typeof TV1.accountIn }]; });
await C("K9", "K8 through the writer with the real identity mapper (translateV1World): the written log carries no account, the one person the log knows by an account is one identity holding it (their grant's role, their placer, their binding's author), the sign's sub is kept, and no identity is minted from it", async () => {
  const { translateV1World } = await imp("tools/protocol/import-v1/world.ts");
  const W = scratch("k9"), src = path.join(W, "old"); fs.mkdirSync(src, { recursive: true });
  const SRC = "sha256:" + "d".repeat(64), SIGN = { title: "The Inn", sub: "rooms upstairs", menuSub: "soup today" };
  fs.writeFileSync(path.join(src, "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "world", verb: "grant", args: { id: "Ann", role: "owner", gen: true, sub: "human:discord:42" } },
    { seq: 2, ts: 3, actor: "Ann", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [1, 0, 1], placer: { id: "Ann", sub: "human:discord:42" } } },
    { seq: 3, ts: 4, actor: "Ann", verb: "behavior", args: { id: "bell", src: SRC, bySub: "human:discord:42" } },
    { seq: 4, ts: 5, actor: "Ann", verb: "comp", args: { id: "lamp_1", type: "sign", data: SIGN } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = translateV1World(src, path.join(W, "new"));
  const text = fs.readFileSync(path.join(W, "new", "world.jsonl"), "utf8"); const lines = text.split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const ann = Object.entries<any>(r.planned).filter(([, e]) => (e.subs ?? []).includes("human:discord:42")).map(([id]) => id);
  const minted = Object.values<any>(r.planned).filter((e) => (e.subs ?? []).some((s: string) => [SIGN.sub, SIGN.menuSub].includes(s)));
  const args = (verb: string) => lines.find((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === verb)?.body?.args;
  const st = FOLD.fold(FOLD.readLog(text)); const w = st.entities?.["@world"]?.c ?? {};
  const binding: any = Object.values(w).find((v: any) => v?.src === SRC);
  const signed = Object.values<any>(st.entities?.[TV1.enc("lamp_1")]?.c ?? {}).find((v: any) => v?.title === SIGN.title);
  return [!/human:discord/.test(text) && ann.length === 1 && w[`roles:${ann[0]}`]?.role === "owner" && args("spawn")?.placer?.sub === ann[0] && args("behavior")?.bySub === ann[0]
    && binding?.author === ann[0] && JSON.stringify(args("comp")?.data) === JSON.stringify(SIGN) && JSON.stringify(signed) === JSON.stringify(SIGN) && !minted.length,
    { ann, planned: r.planned, placer: args("spawn")?.placer, bySub: args("behavior")?.bySub, binding, sign: [args("comp")?.data, signed], leaked: /human:discord/.test(text) }]; });
await C("K10", "an account in a value that nothing beside it names is resolved by the account alone (translateV1World's mapper): a sign of antra's naming someone else's account moves neither antra's later acts nor antra's role to that person, and the other person's identity takes no name from antra", async () => {
  const { translateV1World } = await imp("tools/protocol/import-v1/world.ts");
  const W = scratch("k10"), src = path.join(W, "old"); fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    // antra is known by name only (no account in this log), so nothing but her name joins her acts and her role
    { seq: 1, ts: 2, actor: "world", verb: "grant", args: { id: "antra", role: "owner", gen: true } },
    { seq: 2, ts: 3, actor: "antra", verb: "spawn", args: { id: "board_1", lib: "a.glb", pos: [0, 0, 0] } },
    // a guestbook line: whose account it holds isn't the writer's, and nothing beside it says whose
    { seq: 3, ts: 4, actor: "antra", verb: "comp", args: { id: "board_1", type: "guestbook", data: { line: "thanks for visiting", ownerSub: "human:discord:9" } } },
    { seq: 4, ts: 5, actor: "antra", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [1, 0, 1] } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = translateV1World(src, path.join(W, "new"));
  const text = fs.readFileSync(path.join(W, "new", "world.jsonl"), "utf8"); const lines = text.split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const idHolding = (s: string) => Object.entries<any>(r.planned).filter(([, e]) => (e.subs ?? []).includes(s)).map(([id]) => id);
  const antra = Object.entries<any>(r.planned).filter(([, e]) => e.name === "antra").map(([id]) => id), other = idHolding("human:discord:9");
  const after = lines.find((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === "spawn" && e.body.args?.id === "lamp_1");
  const w = FOLD.fold(FOLD.readLog(text)).entities?.["@world"]?.c ?? {};
  return [antra.length === 1 && other.length === 1 && antra[0] !== other[0] && after?.actor === antra[0] && w[`roles:${antra[0]}`]?.role === "owner" && !w[`roles:${other[0]}`]
    && !/human:discord/.test(text),
    { antra, other, after: after?.actor, planned: r.planned, roles: Object.keys(w).filter((k) => k.startsWith("roles:")) }]; });

await C("K11", "a name is joined to an account only where v1's server wrote the pair: a builder's data pairing the owner's name with the builder's account, and a behaviour whose own `by` names the owner, move neither the owner's later acts nor the owner's role, and the builder's identity takes no name from them; the builder's placer and both bindings, one sent with by: door, are the builder's", async () => {
  const { translateV1World } = await imp("tools/protocol/import-v1/world.ts");
  const W = scratch("k11"), src = path.join(W, "old"); fs.mkdirSync(src, { recursive: true });
  const BOB = "human:discord:77", SRC = "sha256:" + "e".repeat(64);
  fs.writeFileSync(path.join(src, "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    // Ann is known by name only: nothing in this log gives her an account
    { seq: 1, ts: 2, actor: "world", verb: "grant", args: { id: "Ann", role: "owner", gen: true } },
    { seq: 2, ts: 3, actor: "world", verb: "grant", args: { id: "bob", role: "builder", gen: true, sub: BOB } },
    { seq: 3, ts: 4, actor: "bob", verb: "spawn", args: { id: "board_1", lib: "a.glb", pos: [0, 0, 0], placer: { id: "bob", sub: BOB } } },
    // bob's data names Ann beside bob's own account, in the shape main's server stamps (a placer's id and sub)
    { seq: 4, ts: 5, actor: "bob", verb: "comp", args: { id: "board_1", type: "guestbook", data: { line: "hi", id: "Ann", sub: BOB, ownerSub: BOB, owner: "Ann" } } },
    // a binding: the server stamped bob's account as bySub; the `by` beside it is what bob sent
    { seq: 5, ts: 6, actor: "bob", verb: "behavior", args: { id: "bell", src: SRC, by: "Ann", bySub: BOB } },
    { seq: 6, ts: 6, actor: "bob", verb: "behavior", args: { id: "gong", src: SRC, by: "door", bySub: BOB } },
    { seq: 7, ts: 7, actor: "Ann", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [1, 0, 1] } },
    { seq: 8, ts: 8, actor: "world", verb: "grant", args: { id: "Ann", role: "owner", gen: true } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = translateV1World(src, path.join(W, "new"));
  const text = fs.readFileSync(path.join(W, "new", "world.jsonl"), "utf8"); const lines = text.split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const ann = Object.entries<any>(r.planned).filter(([, e]) => e.name === "Ann").map(([id]) => id);
  const bob = Object.entries<any>(r.planned).filter(([, e]) => (e.subs ?? []).includes(BOB)).map(([id]) => id);
  const spawn = (id: string) => lines.find((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === "spawn" && e.body.args?.id === id);
  const w = FOLD.fold(FOLD.readLog(text)).entities?.["@world"]?.c ?? {};
  // every change, a batch or a single op (fold.js opsOf)
  const roleDeletes = lines.filter((e: any) => e.kind === "change").flatMap((e: any) => FOLD.opsOf(e)).filter((o: any) => o.verb === "delete" && String(o.comp ?? o.component ?? "").startsWith("roles:"));
  const authors = Object.values<any>(w).filter((v) => v?.src === SRC).map((v) => v.author);
  return [ann.length === 1 && bob.length === 1 && ann[0] !== bob[0] && r.planned[bob[0]].name === "bob"
    && spawn("lamp_1")?.actor === ann[0] && spawn("board_1")?.actor === bob[0] && spawn("board_1")?.body?.args?.placer?.sub === bob[0]
    && w[`roles:${ann[0]}`]?.role === "owner" && w[`roles:${bob[0]}`]?.role === "builder"
    && authors.length === 2 && authors.every((a) => a === bob[0]) && !roleDeletes.length && !/human:discord/.test(text),
    { ann, bob, planned: r.planned, lamp: spawn("lamp_1")?.actor, placer: spawn("board_1")?.body?.args?.placer, authors, roles: Object.fromEntries(Object.entries<any>(w).filter(([k]) => k.startsWith("roles:")).map(([k, v]) => [k, v?.role])), roleDeletes }]; });

await C("K12", "an old genesis whose roles carry an account translates (translateV1World): the translated act's copy of it holds the person's id where the account was, and the role and the person's acts are that one identity", async () => {
  const { translateV1World } = await imp("tools/protocol/import-v1/world.ts");
  const W = scratch("k12"), src = path.join(W, "old"); fs.mkdirSync(src, { recursive: true });
  const ANN = "human:discord:42";
  fs.writeFileSync(path.join(src, "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log", roles: { Ann: { role: "owner", sub: ANN } } } },
    { seq: 1, ts: 2, actor: "Ann", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [1, 0, 1] } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  let r: any, threw: string | null = null;
  try { r = translateV1World(src, path.join(W, "new")); } catch (e: any) { threw = String(e?.message ?? e); }
  if (threw) return [false, { threw }];
  const text = fs.readFileSync(path.join(W, "new", "world.jsonl"), "utf8"); const lines = text.split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const ann = Object.entries<any>(r.planned).filter(([, e]) => (e.subs ?? []).includes(ANN)).map(([id]) => id);
  const from = lines.find((e: any) => e.kind === "act" && e.verb === "translated")?.body?.from;
  const spawn = lines.find((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === "spawn");
  // (v1's fold never granted a genesis role: only the identity is read from it, before the translation, world.ts)
  return [ann.length === 1 && from?.roles?.Ann?.sub === ann[0] && from?.roles?.Ann?.role === "owner" && spawn?.actor === ann[0] && !/human:discord/.test(text),
    { ann, from: from?.roles, spawn: spawn?.actor, planned: r.planned, leaked: /human:discord/.test(text) }]; });

await C("K13", "a component named as an account is (ownerSub) whose whole value is an account (translateV1World): the account reaches neither the state nor the old comp request, and the writer's check reads a change's op and an old comp request of that shape", async () => {
  const { translateV1World } = await imp("tools/protocol/import-v1/world.ts");
  const W = scratch("k13"), src = path.join(W, "old"); fs.mkdirSync(src, { recursive: true });
  const ANN = "human:discord:42";
  fs.writeFileSync(path.join(src, "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "world", verb: "grant", args: { id: "Ann", role: "owner", gen: true, sub: ANN } },
    { seq: 2, ts: 3, actor: "Ann", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [1, 0, 1] } },
    { seq: 3, ts: 4, actor: "Ann", verb: "comp", args: { id: "lamp_1", type: "ownerSub", data: ANN } },
    { seq: 4, ts: 5, actor: "Ann", verb: "comp", args: { id: "lamp_1", type: "menuSub", data: "soup today" } },
    // a v1 name that is itself an escape (x-- and ownerSub's hex): read the one way the writer's check reads it, so dropped, not refused
    { seq: 5, ts: 6, actor: "Ann", verb: "comp", args: { id: "lamp_1", type: "x--" + Buffer.from("ownerSub", "utf8").toString("hex"), data: ANN } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  let r: any; try { r = translateV1World(src, path.join(W, "new")); } catch (e: any) { return [false, { threw: String(e?.message ?? e).slice(0, 300) }]; }
  const text = fs.readFileSync(path.join(W, "new", "world.jsonl"), "utf8"); const lines = text.split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const ann = Object.entries<any>(r.planned).filter(([, e]) => (e.subs ?? []).includes(ANN)).map(([id]) => id);
  const comps = lines.filter((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === "comp").map((e: any) => e.body.args);
  const lamp = FOLD.fold(FOLD.readLog(text)).entities?.[TV1.enc("lamp_1")]?.c ?? {};
  const hex = (n: string) => "x--" + Buffer.from(n, "utf8").toString("hex");
  const seen = [TV1.accountIn([{ seq: 7, kind: "change", ops: [{ verb: "set", id: "x", comp: "ownerSub", value: ANN }] }]), TV1.accountIn([{ seq: 8, body: { verb: "comp", args: { id: "x", type: "ownerSub", data: ANN } } }]),
    TV1.accountIn([{ seq: 9, ops: [{ verb: "set", id: "x", comp: "menuSub", value: "soup today" }] }]),
    // the name as the log writes it: under a namespace, escaped, or as `component`
    TV1.accountIn([{ seq: 10, ops: [{ verb: "set", id: "x", comp: `new/${hex("ownerSub")}`, value: ANN }] }]), TV1.accountIn([{ seq: 11, ops: [{ verb: "set", id: "x", component: "imported/ownerSub", value: ANN }] }])];
  // the component itself is gone, not only its value: no name of the lamp's reads as ownerSub
  const names = Object.keys(lamp).map((k) => TV1.dec?.(k.slice(k.lastIndexOf("/") + 1)) ?? k);
  return [ann.length === 1 && !/human:discord/.test(text) && comps[0]?.data === ann[0] && comps[1]?.data === "soup today" && comps[2]?.data === ann[0]
    && !Object.values(lamp).includes(ANN) && Object.values(lamp).includes("soup today") && !names.includes("ownerSub") && names.includes("menuSub")
    && seen[0]?.seq === 7 && seen[0]?.path === "ops[0].value" && seen[1]?.seq === 8 && seen[1]?.path === "body.args.data" && seen[2] === null
    && seen[3]?.seq === 10 && seen[4]?.seq === 11,
    { ann, comps, lamp: Object.keys(lamp), names, seen, leaked: /human:discord/.test(text) }]; });

await C("K14", "a private server's local: account is an account (translateV1World): a placer's local: sub reaches no value, and is its person's identity", async () => {
  const { translateV1World } = await imp("tools/protocol/import-v1/world.ts");
  const W = scratch("k14"), src = path.join(W, "old"); fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "Ann", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [0, 0, 0], placer: { id: "Ann", sub: "local:ann" } } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = translateV1World(src, path.join(W, "new"));
  const text = fs.readFileSync(path.join(W, "new", "world.jsonl"), "utf8"); const lines = text.split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const ann = Object.entries<any>(r.planned).filter(([, e]) => (e.subs ?? []).includes("local:ann")).map(([id]) => id);
  const spawn = lines.find((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === "spawn");
  return [ann.length === 1 && spawn?.body?.args?.placer?.sub === ann[0] && !/local:ann/.test(text) && TV1.accountIn([{ seq: 3, args: { placer: { id: "x", sub: "local:x" } } }])?.seq === 3,
    { ann, placer: spawn?.body?.args?.placer, planned: r.planned, leaked: /local:ann/.test(text) }]; });

await C("K15", "a person v1 knew by an aid1 account is one identity (translateV1World): a genesis role keyed by the account, and acts whose placer the server stamped with it, land on the one id, and no copy keeps the account, as a key or a value", async () => {
  const { translateV1World } = await imp("tools/protocol/import-v1/world.ts");
  const W = scratch("k15"), src = path.join(W, "old"); fs.mkdirSync(src, { recursive: true });
  const ZED = "aid1:iss:zed";
  fs.writeFileSync(path.join(src, "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log", roles: { [ZED]: { role: "builder" } } } },
    { seq: 1, ts: 2, actor: "zed", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [0, 0, 0], placer: { id: "zed", sub: ZED } } },
    { seq: 2, ts: 3, actor: "zed", verb: "spawn", args: { id: "lamp_2", lib: "a.glb", pos: [1, 0, 0] } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = translateV1World(src, path.join(W, "new"));
  const text = fs.readFileSync(path.join(W, "new", "world.jsonl"), "utf8"); const lines = text.split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const zeds = Object.entries<any>(r.planned).filter(([, e]) => e.name === "zed" || (e.subs ?? []).includes(ZED)).map(([id]) => id);
  const spawns = lines.filter((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === "spawn").map((e: any) => e.actor);
  const from = lines.find((e: any) => e.kind === "act" && e.verb === "translated")?.body?.from;
  return [zeds.length === 1 && r.planned[zeds[0]].subs?.includes(ZED) && spawns.every((a: string) => a === zeds[0])
    && from?.roles?.[zeds[0]]?.role === "builder" && !text.includes(ZED) && TV1.accountIn([{ seq: 4, body: { roles: { [ZED]: { role: "builder" } } } }])?.seq === 4,
    { zeds, planned: r.planned, spawns, from: from?.roles, leaked: text.includes(ZED) }]; });

await C("K16", "a ban keyed by an account that the old fold lowercased is that account's person (translateV1World): a role and a ban keyed by aid1:issuer:Alice are one identity, its case restored, and a ban's own {id, sub} joins the banned name to its account before any act is read", async () => {
  const { translateV1World } = await imp("tools/protocol/import-v1/world.ts");
  const W = scratch("k16"), src = path.join(W, "old"); fs.mkdirSync(src, { recursive: true });
  const ALICE = "aid1:issuer:Alice", CAROL = "human:discord:55";
  fs.writeFileSync(path.join(src, "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "world", verb: "grant", args: { id: ALICE, role: "builder", gen: true } },
    { seq: 2, ts: 3, actor: "world", verb: "ban", args: { id: ALICE, reason: "spam" } },
    // Carol acts before the ban the server filed with her account: her acts and the ban are one identity
    { seq: 3, ts: 4, actor: "Carol", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [0, 0, 0] } },
    { seq: 4, ts: 5, actor: "world", verb: "ban", args: { id: "Carol", sub: CAROL } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = translateV1World(src, path.join(W, "new"));
  const text = fs.readFileSync(path.join(W, "new", "world.jsonl"), "utf8"); const lines = text.split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const holding = (s: string) => Object.entries<any>(r.planned).filter(([, e]) => (e.subs ?? []).includes(s)).map(([id]) => id);
  const alice = holding(ALICE), carol = holding(CAROL), lower = holding(ALICE.toLowerCase());
  const w = FOLD.fold(FOLD.readLog(text)).entities?.["@world"]?.c ?? {};
  const spawn = lines.find((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === "spawn");
  return [alice.length === 1 && !lower.length && w[`roles:${alice[0]}`]?.role === "builder" && w[`imported-bans:${alice[0]}`] !== undefined
    && carol.length === 1 && spawn?.actor === carol[0] && w[`imported-bans:${carol[0]}`] !== undefined && Object.keys(r.planned).length === 2,
    { alice, lower, carol, planned: r.planned, spawn: spawn?.actor, keys: Object.keys(w).filter((k) => /roles:|bans:/.test(k)) }]; });

await C("K17", "an old request names a person by their account (translateV1World): a grant, ban and unban keyed by an account carry the person's id, not the account, and a top-level sub joins its id only on a grant or a ban: a comp sent with {id: <someone's name>, sub: <own account>} moves no one", async () => {
  const { translateV1World } = await imp("tools/protocol/import-v1/world.ts");
  const W = scratch("k17"), src = path.join(W, "old"); fs.mkdirSync(src, { recursive: true });
  const ZOE = "human:discord:61", BOB = "human:discord:77";
  fs.writeFileSync(path.join(src, "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "world", verb: "grant", args: { id: "Ann", role: "owner", gen: true } },
    { seq: 2, ts: 3, actor: "world", verb: "grant", args: { id: ZOE, role: "builder", gen: true } },
    { seq: 3, ts: 4, actor: "world", verb: "ban", args: { id: ZOE, reason: "spam" } },
    { seq: 4, ts: 5, actor: "world", verb: "unban", args: { id: ZOE } },
    { seq: 5, ts: 6, actor: "world", verb: "grant", args: { id: "bob", role: "builder", gen: true, sub: BOB } },
    { seq: 6, ts: 7, actor: "bob", verb: "spawn", args: { id: "board_1", lib: "a.glb", pos: [0, 0, 0] } },
    { seq: 7, ts: 8, actor: "bob", verb: "comp", args: { id: "Ann", sub: BOB, type: "guestbook", data: { line: "hi" } } },
    { seq: 8, ts: 9, actor: "Ann", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [1, 0, 1] } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = translateV1World(src, path.join(W, "new"));
  const text = fs.readFileSync(path.join(W, "new", "world.jsonl"), "utf8"); const lines = text.split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const holding = (a: string) => Object.entries<any>(r.planned).filter(([, e]) => (e.subs ?? []).includes(a)).map(([id]) => id);
  const zoe = holding(ZOE), bob = holding(BOB), ann = Object.entries<any>(r.planned).filter(([, e]) => e.name === "Ann").map(([id]) => id);
  const acts = (verb: string) => lines.filter((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === verb);
  const lamp = acts("spawn").find((e: any) => e.body.args?.id === "lamp_1");
  return [zoe.length === 1 && ["grant", "ban", "unban"].every((v) => acts(v).some((e: any) => e.body.args?.id === zoe[0]))
    && ann.length === 1 && !(r.planned[ann[0]].subs ?? []).length && lamp?.actor === ann[0] && acts("comp")[0]?.body?.args?.sub === bob[0]
    && !/human:discord/.test(text) && TV1.accountIn([{ seq: 9, body: { verb: "grant", args: { id: ZOE } } }])?.path === "body.args.id",
    { zoe, ann, bob, planned: r.planned, ids: ["grant", "ban", "unban"].map((v) => acts(v).map((e: any) => e.body.args?.id)), lamp: lamp?.actor, comp: acts("comp")[0]?.body?.args }]; });
await C("K18", "the pairs v1's server stamped join a name to its account before any act is read (translateV1World): acts by a name before the light that carries its account, its only stamp, are that one identity", async () => {
  const { translateV1World } = await imp("tools/protocol/import-v1/world.ts");
  const W = scratch("k18"), src = path.join(W, "old"); fs.mkdirSync(src, { recursive: true });
  const DEE = "human:discord:88";
  fs.writeFileSync(path.join(src, "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "dee", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [0, 0, 0] } },
    { seq: 2, ts: 3, actor: "dee", verb: "light", args: { id: "glow_1", pos: [1, 2, 1], color: "#ffcc88", placer: { id: "dee", sub: DEE } } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = translateV1World(src, path.join(W, "new"));
  const text = fs.readFileSync(path.join(W, "new", "world.jsonl"), "utf8"); const lines = text.split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const dee = Object.entries<any>(r.planned).filter(([, e]) => e.name === "dee" || (e.subs ?? []).includes(DEE)).map(([id]) => id);
  const actors = lines.filter((e: any) => e.kind === "act" && e.verb === "imported").map((e: any) => e.actor);
  const light = lines.find((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === "light");
  return [dee.length === 1 && r.planned[dee[0]].subs?.includes(DEE) && actors.length === 2 && actors.every((a: string) => a === dee[0]) && light?.body?.args?.placer?.sub === dee[0] && !text.includes(DEE),
    { dee, actors, planned: r.planned, placer: light?.body?.args?.placer }]; });
await C("K19", "with no identity mapper (the pure translation), every account is dropped where it sits: a genesis role's sub, a component an account names and fills (under a name read as written where it isn't a real escape), an entry keyed by an account, an old grant's, ban's and unban's id; and with a mapper an entry keyed by an account whose id is already a key keeps that one", () => {
  const ANN = "human:discord:42";
  const log = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log", roles: { Ann: { role: "owner", sub: ANN }, [ANN]: { role: "builder" } } } },
    { seq: 1, ts: 2, actor: "Ann", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [0, 0, 0] } },
    { seq: 2, ts: 3, actor: "Ann", verb: "comp", args: { id: "lamp_1", type: "ownerSub", data: ANN } },
    { seq: 3, ts: 4, actor: "Ann", verb: "comp", args: { id: "lamp_1", type: "ledger", data: { [ANN]: "paid", note: "kept" } } },
    // a name shaped like an escape that isn't one (x--qq…) is read as written, so it still has an account's name
    { seq: 4, ts: 5, actor: "Ann", verb: "comp", args: { id: "lamp_1", type: "x--qqSub", data: ANN } },
    // a person named by their account, in an old grant, ban and unban
    { seq: 5, ts: 6, actor: "world", verb: "grant", args: { id: ANN, role: "builder", gen: true } },
    { seq: 6, ts: 7, actor: "world", verb: "ban", args: { id: ANN, reason: "spam" } },
    { seq: 7, ts: 8, actor: "world", verb: "unban", args: { id: ANN } }];
  const pure = TV1.translate(log); const ptext = pure.out.map((e: any) => JSON.stringify(e)).join("\n");
  const personArgs = pure.out.filter((e: any) => e.kind === "act" && ["grant", "ban", "unban"].includes(e.body?.verb)).map((e: any) => e.body.args);
  const st = FOLD.fold(FOLD.readLog(ptext + "\n")); const lamp = st.entities?.[TV1.enc("lamp_1")]?.c ?? {};
  const ledger: any = Object.values(lamp).find((v: any) => v && typeof v === "object" && v.note === "kept");
  // a mapper whose id for ANN is fixed, so a map can already hold it as a key beside the account
  const ID = "u-aaaaaaaaaaaaaaaaaaaa";
  const who = (n: string, o: any = {}) => (o.sub === ANN || n === ANN ? ID : TV1.enc(n));
  const both = TV1.withoutAccounts({ [ANN]: "the account's", [ID]: "the id's" }, (sub: string) => who(sub, { sub }));
  const mapped = TV1.translate(log, { who }); const from = mapped.out.find((e: any) => e.verb === "translated")?.body?.from;
  return [!ptext.includes(ANN) && ledger && !(ANN in ledger) && !Object.values(lamp).includes(ANN) && JSON.stringify(both) === JSON.stringify({ [ID]: "the id's" })
    && personArgs.length === 3 && personArgs.every((a: any) => a && !("id" in a))
    && from?.roles?.Ann?.sub === ID && from?.roles?.[ID]?.role === "builder" && !Object.keys(from?.roles ?? {}).includes(ANN),
    { leaked: ptext.split("\n").filter((l: string) => l.includes(ANN)).map((l: string) => l.slice(0, 200)), personArgs, ledger, lamp: Object.keys(lamp), both, from: from?.roles }]; });
await C("K20", "a person whose name begins local: is a name, not an account (translateV1World): a private server's local: account is one only where an account sits (a sub), so 'local:ann' keeps their acts on one named identity with no account", async () => {
  const { translateV1World } = await imp("tools/protocol/import-v1/world.ts");
  const W = scratch("k20"), src = path.join(W, "old"); fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "world", verb: "grant", args: { id: "local:ann", role: "builder", gen: true } },
    { seq: 2, ts: 3, actor: "local:ann", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [0, 0, 0] } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = translateV1World(src, path.join(W, "new"));
  const text = fs.readFileSync(path.join(W, "new", "world.jsonl"), "utf8"); const lines = text.split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const ann = Object.entries<any>(r.planned).filter(([, e]) => e.name === "local:ann").map(([id]) => id);
  const w = FOLD.fold(FOLD.readLog(text)).entities?.["@world"]?.c ?? {};
  const spawn = lines.find((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === "spawn");
  return [ann.length === 1 && Object.keys(r.planned).length === 1 && !(r.planned[ann[0]].subs ?? []).length && spawn?.actor === ann[0] && w[`roles:${ann[0]}`]?.role === "builder",
    { ann, planned: r.planned, spawn: spawn?.actor, roles: Object.keys(w).filter((k) => k.startsWith("roles:")) }]; });
await C("K21", "the sweep's independent reading agrees with the translator on accounts (tools/protocol/sweep.ts over a world with a local: placer, an entry keyed by an account, a component an account names and fills, its only one, the same under an escaped name, a role kept by its account, and a local: account in a kept value): no loss, and the snapshot oracle's reading of the directory finds a local: sub's person", async () => {
  const { spawnSync } = await import("node:child_process");
  const W = scratch("k21"), dir = path.join(W, "worlds", "acct"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "Ann", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [0, 0, 0], placer: { id: "Ann", sub: "local:ann" } } },
    { seq: 2, ts: 3, actor: "Ann", verb: "spawn", args: { id: "box_1", lib: "a.glb", pos: [1, 0, 0] } },
    { seq: 3, ts: 4, actor: "Ann", verb: "comp", args: { id: "box_1", type: "ownerSub", data: "human:discord:42" } },
    { seq: 4, ts: 5, actor: "Ann", verb: "comp", args: { id: "lamp_1", type: "ledger", data: { "human:discord:42": "paid", note: "kept" } } },
    // a role kept by its account (the translator keys it by its person), a component whose escaped name has an account's,
    // and a local: account inside a value the state keeps
    { seq: 5, ts: 6, actor: "world", verb: "grant", args: { id: "human:discord:43", role: "builder", gen: true } },
    { seq: 6, ts: 7, actor: "Ann", verb: "comp", args: { id: "lamp_1", type: "x--" + Buffer.from("ownerSub", "utf8").toString("hex"), data: "human:discord:42" } },
    { seq: 7, ts: 8, actor: "Ann", verb: "comp", args: { id: "lamp_1", type: "tag", data: { ownerSub: "local:ann", note: "kept" } } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const p = spawnSync(process.execPath, [path.join(T, "tools/protocol/sweep.ts")], { cwd: T, env: { ...process.env, PROTOCOL_WORLDS: path.join(W, "worlds") }, encoding: "utf8", timeout: 120000 });
  const out = `${p.stdout}${p.stderr}`; const fails = out.split("\n").filter((l) => /FAIL/.test(l));
  // the sweep counts this world beside the repo's own fixture logs (distinct by content, as it reads them)
  const seen = new Set<string>(); const walk = (d: string, depth = 0) => { if (depth > 5) return; for (const n of fs.readdirSync(d)) { const q = path.join(d, n);
    if (n === "log.jsonl") { const t = fs.readFileSync(q, "utf8"); if (t.trim()) seen.add(t); } else if (fs.statSync(q).isDirectory()) walk(q, depth + 1); } };
  walk(path.join(T, "spec/fixtures")); const counted = out.includes(`[sweep] ${seen.size + 1} distinct world logs`);
  const { translateV1World } = await imp("tools/protocol/import-v1/world.ts"); const OR = await imp("tools/protocol/import-v1/snapshot-oracle.ts");
  const r = translateV1World(dir, path.join(W, "worlds", "acct-new"));
  const ann = Object.entries<any>(r.planned).filter(([, e]) => (e.subs ?? []).includes("local:ann")).map(([id]) => id);
  const got = OR.whoFrom?.(path.join(W, "worlds"))?.who("Ann", { sub: "local:ann" });
  return [p.status === 0 && counted && / lossy 0,/.test(out) && !fails.length && ann.length === 1 && got === ann[0], { status: p.status, counted, fails: fails.slice(0, 4), tail: out.slice(-400), ann, got }]; });

await C("K22", "a ban's key, which the old fold lowercased, is the person it names whatever case its sender typed (translateV1World): 'ann' banned after 'Ann' was granted bans Ann, an account granted as written and banned and unbanned in lowercase is one identity, and a name only its ban gives keeps its case", async () => {
  const { translateV1World } = await imp("tools/protocol/import-v1/world.ts");
  const W = scratch("k22"), src = path.join(W, "old"); fs.mkdirSync(src, { recursive: true });
  const ALICE = "aid1:issuer:Alice";
  fs.writeFileSync(path.join(src, "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "world", verb: "grant", args: { id: "Ann", role: "owner", gen: true } },
    { seq: 2, ts: 3, actor: "Ann", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [0, 0, 0] } },
    { seq: 3, ts: 4, actor: "world", verb: "ban", args: { id: "ann", reason: "spam" } },
    { seq: 4, ts: 5, actor: "world", verb: "grant", args: { id: ALICE, role: "builder", gen: true } },
    { seq: 5, ts: 6, actor: "world", verb: "ban", args: { id: ALICE.toLowerCase(), reason: "spam" } },
    { seq: 6, ts: 7, actor: "world", verb: "unban", args: { id: ALICE.toLowerCase() } },
    { seq: 7, ts: 8, actor: "world", verb: "ban", args: { id: "Zed", reason: "spam" } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = translateV1World(src, path.join(W, "new"));
  const text = fs.readFileSync(path.join(W, "new", "world.jsonl"), "utf8"); const lines = text.split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const named = (n: string) => Object.entries<any>(r.planned).filter(([, e]) => e.name === n).map(([id]) => id);
  const holding = (a: string) => Object.entries<any>(r.planned).filter(([, e]) => (e.subs ?? []).includes(a)).map(([id]) => id);
  const ann = named("Ann"), alice = holding(ALICE), zed = named("Zed");
  const ids = (verb: string) => lines.filter((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === verb).map((e: any) => e.body.args?.id);
  const w = FOLD.fold(FOLD.readLog(text)).entities?.["@world"]?.c ?? {};
  return [ann.length === 1 && !named("ann").length && w[`imported-bans:${ann[0]}`] !== undefined
    && alice.length === 1 && !holding(ALICE.toLowerCase()).length && ids("ban").includes(alice[0]) && ids("unban")[0] === alice[0]
    && zed.length === 1 && w[`imported-bans:${zed[0]}`] !== undefined && Object.keys(r.planned).length === 3,
    { planned: r.planned, bans: Object.keys(w).filter((k) => k.startsWith("imported-bans:")), ban: ids("ban"), unban: ids("unban") }]; });
await C("K23", "the snapshot oracle reads the translated world's people as the importer filed them (snapshot-oracle.ts whoFrom): a lowered ban key that is an account finds the account filed in its case; a person named 'local:ann' is the person of that name, not the local:ann account; and an account seen alone takes no name, so that person is their own identity", async () => {
  const { translateV1World } = await imp("tools/protocol/import-v1/world.ts"); const OR = await imp("tools/protocol/import-v1/snapshot-oracle.ts");
  const W = scratch("k23"), src = path.join(W, "worlds", "old"); fs.mkdirSync(src, { recursive: true });
  const ALICE = "aid1:issuer:Alice";
  fs.writeFileSync(path.join(src, "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "world", verb: "grant", args: { id: ALICE, role: "builder", gen: true } },
    { seq: 2, ts: 3, actor: "world", verb: "ban", args: { id: ALICE, reason: "spam" } },
    { seq: 3, ts: 4, actor: "Bea", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [0, 0, 0] } },
    // the local:ann account, alone: a component that names it, with no name beside it
    { seq: 4, ts: 5, actor: "Bea", verb: "comp", args: { id: "lamp_1", type: "ownerSub", data: "local:ann" } },
    // someone whose name is local:ann
    { seq: 5, ts: 6, actor: "local:ann", verb: "spawn", args: { id: "lamp_2", lib: "a.glb", pos: [1, 0, 0] } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = translateV1World(src, path.join(W, "worlds", "new"));
  const text = fs.readFileSync(path.join(W, "worlds", "new", "world.jsonl"), "utf8"); const lines = text.split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const holding = (a: string) => Object.entries<any>(r.planned).filter(([, e]) => (e.subs ?? []).includes(a)).map(([id]) => id);
  const alice = holding(ALICE), acct = holding("local:ann"), named = Object.entries<any>(r.planned).filter(([, e]) => e.name === "local:ann").map(([id]) => id);
  const lamp2 = lines.find((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === "spawn" && e.body.args?.id === "lamp_2");
  const o = OR.whoFrom(path.join(W, "worlds"));
  const got = { ban: o.who(ALICE.toLowerCase(), { lowered: true }), name: o.who("local:ann", {}), sub: o.who("someone", { sub: "local:ann" }) };
  return [alice.length === 1 && acct.length === 1 && named.length === 1 && acct[0] !== named[0] && !(r.planned[named[0]].subs ?? []).length && lamp2?.actor === named[0]
    && got.ban === alice[0] && got.name === named[0] && got.sub === acct[0] && !o.unresolved.length,
    { planned: r.planned, got, unresolved: o.unresolved, lamp2: lamp2?.actor }]; });
await C("K24", "an account's place in a request is read as the scrub reads it (translateV1World): a placer whose name is itself an account is that person's id, name and account alike; an id elsewhere in a value is data, as any key not named sub or *Sub; a top-level sub that isn't an account stays, with a mapper or without; and a key naming a person called 'local:ann' stays", async () => {
  const { translateV1World } = await imp("tools/protocol/import-v1/world.ts");
  const W = scratch("k24"), src = path.join(W, "old"); fs.mkdirSync(src, { recursive: true });
  const A = "human:discord:42", B = "human:discord:44";
  const log = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: A, verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [0, 0, 0], placer: { id: A, sub: A } } },
    { seq: 2, ts: 3, actor: "Ann", verb: "spawn", args: { id: "board_1", lib: "a.glb", pos: [1, 0, 0], sub: "bob" } },
    { seq: 3, ts: 4, actor: "Ann", verb: "comp", args: { id: "board_1", type: "guestbook", data: { entries: [{ id: B, line: "hi" }] } } },
    { seq: 4, ts: 5, actor: "Ann", verb: "comp", args: { id: "board_1", type: "ledger", data: { "local:ann": "paid", note: "kept" } } }];
  fs.writeFileSync(path.join(src, "log.jsonl"), log.map((e) => JSON.stringify(e)).join("\n") + "\n");
  let r: any; try { r = translateV1World(src, path.join(W, "new")); } catch (e: any) { return [false, { threw: String(e?.message ?? e).slice(0, 300) }]; }
  const text = fs.readFileSync(path.join(W, "new", "world.jsonl"), "utf8"); const lines = text.split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const a = Object.entries<any>(r.planned).filter(([, e]) => (e.subs ?? []).includes(A)).map(([id]) => id);
  const act = (verb: string, id: string) => lines.find((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === verb && e.body.args?.id === id);
  const comps = lines.filter((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === "comp").map((e: any) => e.body.args?.data);
  const board = FOLD.fold(FOLD.readLog(text)).entities?.[TV1.enc("board_1")]?.c ?? {};
  const ledger: any = Object.values(board).find((v: any) => v && typeof v === "object" && v.note === "kept");
  const pure = TV1.translate(log).out.find((e: any) => e.kind === "act" && e.body?.verb === "spawn" && e.body.args?.id === "board_1");
  return [a.length === 1 && act("spawn", "lamp_1")?.actor === a[0] && JSON.stringify(act("spawn", "lamp_1")?.body?.args?.placer) === JSON.stringify({ id: a[0], sub: a[0] }) && !text.includes(A)
    && comps[0]?.entries?.[0]?.id === B && act("spawn", "board_1")?.body?.args?.sub === "bob" && pure?.body?.args?.sub === "bob" && ledger?.["local:ann"] === "paid",
    { a, placer: act("spawn", "lamp_1")?.body?.args?.placer, guest: comps[0], sub: [act("spawn", "board_1")?.body?.args?.sub, pure?.body?.args?.sub], ledger }]; });

// ---- N: names (H1, M7) ----
const mk = (W: any, id = "box") => { const r = W.call("create", { id, model: "crate" }); if (!r.ok) throw new Error(why(r)); return id; };
await C("N1", "an unregistered bare name is refused: bare names are the registry's; the fix shows the namespaced form", () => {
  const W = world(); mk(W); const r = W.call("set", { id: "box", component: "heart", value: { beat: 1 } });
  return [!r.ok && r.refused.code === "schema" && /namespace|example\.org\/heart/.test(r.refused.fix + r.refused.reason) && (r.refused.didYouMean ?? []).some((x: string) => x.endsWith("/heart")), r.refused ?? r]; });
await C("N2", "a namespaced name is anyone's: example.org/heart and mica/heart are admitted (and a create's components too)", () => {
  const W = world(); mk(W); const a = W.call("set", { id: "box", component: "example.org/heart", value: { beat: 1 } });
  const b = W.call("set", { id: "box", component: "mica/heart:left", value: 2 }); const c = W.call("create", { id: "c2", model: "crate", components: { "mica/inscription": "here" } });
  return [a.ok && b.ok && c.ok, [why(a), why(b), why(c)]]; });
await C("N3", "an unregistered bare name in a create's components is refused too", () => {
  const W = world(); const r = W.call("create", { id: "c3", model: "crate", components: { inscription: "here" } }); return [!r.ok && r.refused.code === "schema", r.refused ?? r]; });
await C("N4", "a typo of a registered name still says 'did you mean' (ligth → light)", () => {
  const W = world(); mk(W); const r = W.call("set", { id: "box", component: "ligth", value: {} }); return [!r.ok && r.refused.didYouMean?.[0] === "light", r.refused]; });
await C("N5", "light@2 before it's registered: refused as unregistered (a new meaning is registered first), not as a typo of light", () => {
  const W = world(); mk(W); const r = W.call("set", { id: "box", component: "light@2", value: { kind: "point" } });
  return [!r.ok && r.refused.code === "schema" && /regist/.test(r.refused.reason + r.refused.fix) && !/did you mean 'light'/.test(r.refused.reason), r.refused]; });
await C("N6", "a registered name@N is a legal name: checked against its own definition, which says what it supersedes", () => {
  CAT.COMPONENTS["light@2"] = { ...CAT.COMPONENTS.light, supersedes: "light", fields: { ...CAT.COMPONENTS.light.fields, falloff: "string" }, help: "test: light with a falloff" };
  try { const W = world(); mk(W); const a = W.call("set", { id: "box", component: "light@2", value: { kind: "point", falloff: "quadratic" } });
    const b = W.call("set", { id: "box", component: "light@2", value: { kind: "point", bogus: 1 } });
    return [a.ok && !b.ok && b.refused.code === "schema" && CAT.supersedes?.("light@2") === "light", [why(a), b.refused, typeof CAT.supersedes]]; }
  finally { delete CAT.COMPONENTS["light@2"]; } });
await C("N7", "a promoted name keeps its namespaced spelling as an alias: same definition, same checks, one canonical name", () => {
  CAT.COMPONENTS["test-heart"] = { on: "thing", fields: { beat: "number" }, defaults: { beat: 60 }, aliases: ["example.org/heart"], help: "test" };
  try { const W = world(); mk(W); const a = W.call("set", { id: "box", component: "example.org/heart", value: {} });
    const b = W.call("set", { id: "box", component: "example.org/heart", value: { bpm: 1 } });
    return [a.ok && W.state().entities.box.c["example.org/heart"]?.beat === 60 && !b.ok && b.refused.code === "schema" && CAT.canonicalName?.("example.org/heart:x") === "test-heart:x",
      [why(a), W.state().entities.box.c["example.org/heart"], b.refused, typeof CAT.canonicalName]]; }
  finally { delete CAT.COMPONENTS["test-heart"]; } });
await C("N8", "the translator moves an old world's own inventions under a namespace; registered names stay bare", () => {
  const old = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log", roles: { olive: { role: "owner" } } } },
    { seq: 1, ts: 2, actor: "olive", verb: "spawn", args: { id: "rock_1", lib: "a.glb", pos: [0, 0, 0] } },
    { seq: 2, ts: 3, actor: "olive", verb: "comp", args: { id: "rock_1", type: "heart", data: { beat: 1 } } },
    { seq: 3, ts: 4, actor: "olive", verb: "comp", args: { id: "rock_1", type: "label", data: "a rock" } }];
  const r = TV1.translate(old, { namespace: "commons" }); const c = r.final.translated[TV1.enc("rock_1")];
  const bare = Object.keys(c).filter((k) => !k.includes("/") && !CAT.COMPONENTS[k.split(":")[0]]);
  return [r.stats.divergences === 0 && c["commons/heart"]?.beat === 1 && c.label === "a rock" && !bare.length, [Object.keys(c), r.stats.divergences]]; });
await C("N9", "§4 says it: bare names are refused unless registered, a namespace is a prefix with '/', promotion keeps an alias, name@N is registered first", () => {
  const g = SPEC.slice(SPEC.indexOf("## 4."), SPEC.indexOf("### 4.1")); const need = ["refuses an unregistered bare name", "alias", "supersedes", "custom elements"];
  return [need.every((n) => g.includes(n)), need.filter((n) => !g.includes(n))]; });

// ---- D: every parameter written down (H2) ----
const stored = (W: any, id: string, comp: string) => W.state().entities[id]?.c[comp];
await C("D1", "a spot light's cone is written into it (angle π/4, inner 0); a point light carries no cone; important, decay and daytime are written", () => {
  const W = world(); for (const id of ["a", "b"]) if (!W.call("create", { id, components: { label: id } }).ok) throw new Error("create");   // bare things: a light never shares a thing with a model (one place per thing, 10-11)
  const ra = W.call("set", { id: "a", component: "light", value: { kind: "spot" } }), rb = W.call("set", { id: "b", component: "light", value: { kind: "point" } });
  const a = stored(W, "a", "light"), b = stored(W, "b", "light");
  return [ra.ok && rb.ok && a.angle === Math.PI / 4 && a.inner === 0 && !("angle" in b) && a.important === false && a.daytime === "dim" && a.decay === 2 && b.intensity === 16, [a, b]]; });   // day → daytime, +decay (shape audit 10-16)
await C("D2", "an openable's turn is written (angle π/2, axis [0,1,0], time 1, locked false); a sliding one gets no turn", () => {
  const W = world(); mk(W, "d"); mk(W, "s");
  W.call("set", { id: "d", component: "openable", value: { open: false } }); W.call("set", { id: "s", component: "openable", value: { open: false, slide: [1, 0, 0] } });
  const d = stored(W, "d", "openable"), sl = stored(W, "s", "openable");
  return [d?.angle === Math.PI / 2 && JSON.stringify(d.axis) === "[0,1,0]" && d.time === 1 && d.locked === false && sl && !("angle" in sl) && !("axis" in sl) && sl.time === 1, [d, sl]]; });
await C("D3", "a grabbable's defaults are written (range 1.5, who inhabitant, steal, throw, release…) and the authority still takes it", () => {
  const W = world(); mk(W, "g"); const r = W.call("set", { id: "g", component: "grabbable", value: {} }); const g = stored(W, "g", "grabbable");
  return [r.ok && g?.range === 1.5 && g.who === "inhabitant" && g.steal === true && g.throw === 1 && g.release === "drop" && g.hold === "auto" && g.enabled === true, [why(r), g]]; });
await C("D4", "a motion's per-type defaults are written: spin's axis and rate, orbit's radius and rate, oscillate's amp and period, path's speed and loop", () => {
  const W = world(); for (const id of ["sp", "sp2", "or", "bo", "pa"]) mk(W, id);
  W.call("set", { id: "sp", component: "motion", value: { type: "spin" } }); W.call("set", { id: "sp2", component: "motion", value: { type: "spin", period: 10 } });
  W.call("set", { id: "or", component: "motion", value: { type: "orbit" } }); W.call("set", { id: "bo", component: "motion", value: { type: "oscillate" } });
  W.call("set", { id: "pa", component: "motion", value: { type: "path", points: [[0, 0, 0], [0, 0, 2]] } });
  const m = (id: string) => stored(W, id, "motion");
  return [JSON.stringify(m("sp").axis) === "[0,1,0]" && m("sp").degPerSec === 36 && m("sp").phase === 0 && !("degPerSec" in m("sp2")) && m("or").radius === 3 && m("or").degPerSec === 12 && m("or").face === true
    && m("bo").amp === 0.3 && m("bo").period === 4 && m("pa").speed === 1 && m("pa").loop === "loop" && m("pa").face === true, ["sp", "sp2", "or", "bo", "pa"].map(m)]; });
await C("D5", "a physics thing that flies says who may punt it (inhabitant); world settings set in part store ONLY what was written, even a value equal to today's default (capacity, script-settings: policy numbers, PROTOCOL §9.2)", () => {
  const W = world(); mk(W, "p"); W.call("set", { id: "p", component: "physics", value: { kind: "dynamic" } });
  W.call("set", { id: "@world", component: "capacity", value: { entities: 100 } }); W.call("set", { id: "@world", component: "script-settings", value: { max: 3 } });
  const cap1 = W.state().entities["@world"].c.capacity;
  const same = W.call("set", { id: "@world", component: "capacity", value: { guestEntities: CAPACITY.guestEntities } });
  W.call("set", { id: "@world", component: "default-role", value: { role: "builder" } });
  const w = W.state().entities["@world"].c, ss = w["script-settings"];
  return [stored(W, "p", "physics")?.who === "inhabitant" && JSON.stringify(cap1) === '{"entities":100}' && same.ok && JSON.stringify(w.capacity) === JSON.stringify({ guestEntities: CAPACITY.guestEntities }) && JSON.stringify(ss) === '{"max":3}'
    && W.call("set", { id: "@world", component: "default-role", value: { role: "inhabitant" } }).ok, [stored(W, "p", "physics"), cap1, w.capacity, ss]]; });
await C("D6", "policy numbers pin no default: the registry holds none for capacity or script-settings; schema reports this server's defaults and ceilings, the ones the authority enforces", () => {
  const W = world(); const r = W.call("schema", { component: "capacity" }); const sv = r.server ?? {};
  return [!CAT.COMPONENTS.capacity.defaults && !CAT.COMPONENTS["script-settings"].defaults && JSON.stringify(sv.defaults?.capacity) === JSON.stringify(D.CAPACITY) && JSON.stringify(sv.ceilings?.capacity) === JSON.stringify(D.CAPACITY_CEILING)
    && JSON.stringify(sv.defaults?.["script-settings"]) === JSON.stringify(D.scriptDefaults()) && JSON.stringify(sv.ceilings?.["script-settings"]) === JSON.stringify(D.scriptCeiling())
    && JSON.stringify(Object.keys(CAT.COMPONENTS["script-settings"].fields)) === '["run","max","budget","cpu"]', sv]; });
await C("D6b", "an owner sets a policy number at or below the server's ceiling, never above (bounds); the budgets only tighten; a dropped script-settings field (install, rate, depth, fails, runs) is refused", () => {
  const W = world(); const top = D.CAPACITY_CEILING.entities, sc = D.scriptCeiling();
  const over = W.call("set", { id: "@world", component: "capacity", value: { entities: top + 1 } }), at = W.call("set", { id: "@world", component: "capacity", value: { entities: top } });
  const cpuUp = W.call("set", { id: "@world", component: "script-settings", value: { cpu: sc.cpu + 1 } }), cpuDown = W.call("set", { id: "@world", component: "script-settings", value: { cpu: 25, budget: 10 } });
  const gone = ["install", "rate", "depth", "fails", "runs"].map((k) => W.call("set", { id: "@world", component: "script-settings", value: { [k]: k === "install" ? "owner" : 3 } }));
  return [!over.ok && over.refused.code === "bounds" && new RegExp(`at most ${top}`).test(over.refused.reason) && at.ok && !cpuUp.ok && cpuUp.refused.code === "bounds" && cpuDown.ok && gone.every((g) => !g.ok && g.refused.code === "schema"),
    [over.refused, why(at), cpuUp.refused, why(cpuDown), gone.map(why)]]; });
await C("D7", "no default lives only in help text: every 'default …' a help string names for a field is in the definition's data", () => {
  // defaults that aren't a fixed number: where it stands, a size-chosen pose; and nested ones (a socket's, a handler's args)
  // default-role.guests: absent is visitor whatever the role, which no stored value can say under a role of none (known gap)
  const DYN = new Set(["motion.center", "grabbable.anim", "sockets.radius", "sockets.anchor", "reactions.component", "reactions.field", "reactions.strength", "default-role.guests"]);
  const bad = [];
  for (const [name, def] of Object.entries<any>(CAT.COMPONENTS)) { const h = def.help ?? ""; const all = CAT.defaultsOf?.(name) ?? {};
    for (const m of h.matchAll(/(\b[a-zA-Z]+)\??:? ?\(([^()]*\bdefault\b[^()]*)\)/g)) { const f = m[1]; if (DYN.has(`${name}.${f}`) || DYN.has(`${def.on === "world" ? name : name}.${f}`)) continue;
      if (!(f in all) && Object.keys(def.fields ?? {}).includes(f)) bad.push(`${name}.${f}: "${m[0].slice(0, 60)}"`); } }
  return [!bad.length && typeof CAT.defaultsOf === "function", bad]; });
await C("D8s", "the old spelling of sockets is marked, not changed: sockets is lifted to socket children, parent.socket a legacy field; the pin holds (a mark is not a meaning)", () => {
  const pin = JSON.parse(read("spec/registry-pin.json")); const breaks = CAT.pinBreaks?.(pin, CAT.pinOf()) ?? ["no pinBreaks"];
  return [typeof CAT.COMPONENTS.sockets?.lifted === "string" && /socket children/.test(CAT.COMPONENTS.sockets.lifted) && (CAT.COMPONENTS.parent?.legacy ?? []).includes("socket") && CAT.COMPONENTS.parent.fields.socket === "string" && !breaks.length && !!CAT.COMPONENTS.socket, { lifted: CAT.COMPONENTS.sockets?.lifted, legacy: CAT.COMPONENTS.parent?.legacy, breaks }]; });
await C("D8", "a definition's meaning is pinned: a changed default, type or enum is caught (spec/registry-pin.json); additions are fine", () => {
  const pin = JSON.parse(read("spec/registry-pin.json")); const now = CAT.pinOf?.(); const g = CAT.pinBreaks?.(pin, now) ?? ["no pinBreaks"];
  const was = CAT.COMPONENTS.light.defaults.intensity; CAT.COMPONENTS.light.defaults.intensity = 17;
  const moved = CAT.pinBreaks?.(pin, CAT.pinOf()) ?? []; CAT.COMPONENTS.light.defaults.intensity = was;
  // an addition (with its meaning of absence stated: D11) is fine
  const am0 = CAT.COMPONENTS.light.absentMeans;   // light has its own absentMeans since the shape audit (10-16): put them back after the probe
  CAT.COMPONENTS.light.fields.extra = "number"; CAT.COMPONENTS.light.absentMeans = { ...(am0 ?? {}), extra: "no extra" }; const added = CAT.pinBreaks?.(pin, CAT.pinOf()) ?? ["x"]; delete CAT.COMPONENTS.light.fields.extra; if (am0) CAT.COMPONENTS.light.absentMeans = am0; else delete CAT.COMPONENTS.light.absentMeans;
  return [!g.length && moved.some((x: string) => /light\.intensity/.test(x)) && !added.length, { now: g.slice(0, 4), moved, added }]; });
await C("D12", "every field of an open component has a written meaning, every meaning is pinned (spec/registry-pin.json docs: the normative home of what a field means, the house's view #260 10-20), and a changed meaning is a break (this row checks meanings, not units)", () => {
  const pin = JSON.parse(read("spec/registry-pin.json")); const now = CAT.pinOf();
  const bare = Object.entries(now).filter(([, p]: any) => p.status !== "reserved" && p.status !== "retired").flatMap(([n, p]: any) => Object.keys(p.fields ?? {}).filter((f) => !(typeof p.docs?.[f] === "string" && p.docs[f].trim())).map((f) => `${n}.${f}`));
  const unpinned = Object.entries(now).flatMap(([n, p]: any) => Object.keys(p.docs ?? {}).filter((f) => pin[n]?.docs?.[f] !== p.docs[f]).map((f) => `${n}.${f}`));
  const changed = JSON.parse(JSON.stringify(pin)); const lit = changed.light; const f0 = Object.keys(lit?.docs ?? {})[0]; if (f0) lit.docs[f0] = lit.docs[f0] + " (it once meant something else)";
  const caught = f0 ? CAT.pinBreakList(changed).some((b: any) => b.text.startsWith(`light.${f0}: its meaning`)) : false;
  return [!bare.length && !unpinned.length && caught, { bare: bare.slice(0, 8), unpinned: unpinned.length, caught }];
});
await C("D13", "a pin break is acknowledged in the record, not just against the live code: every break between an earlier spec/registry-pin.json (the base's, where this branch left origin/main; and the pin's previous version, before its newest change) and the working tree's is a `  - <break>` line spec/REGISTRY-CHANGELOG.md gained since then (D8 compares the pin to the code, so the code and the pin edited together, with no line, passed it)", () => {
  const F = "spec/registry-pin.json"; const now = (f: string) => (fs.existsSync(path.join(T, f)) ? read(f) : null);
  const r = PH.unacknowledged(T, [F], "spec/REGISTRY-CHANGELOG.md", now, (was, is) => CAT.pinBreakList(was[F] ?? {}, is[F] ?? {}).map((b: any) => b.text), argv);
  return [r.judged.length >= 1 && !r.out.length, { judged: r.judged, base: r.base, unacknowledged: r.out.slice(0, 8) }]; });
await C("D11", "a field added after its name's first registration states its meaning of absence (absentMeans), and that meaning is pinned (PROTOCOL §4)", () => {
  const pin = JSON.parse(read("spec/registry-pin.json")); const L = CAT.COMPONENTS.light;
  L.fields.extra = "number"; const bare = CAT.pinBreaks?.(pin, CAT.pinOf()) ?? [];
  L.absentMeans = { ...(L.absentMeans ?? {}), extra: "no extra: what the light did before extra existed" }; const said = CAT.pinBreaks?.(pin, CAT.pinOf()) ?? ["x"];
  const pinned = CAT.pinOf(); L.absentMeans.extra = "something else"; const moved = CAT.pinBreaks?.(pinned, CAT.pinOf()) ?? [];
  delete L.fields.extra; delete L.absentMeans.extra; if (!Object.keys(L.absentMeans).length) delete L.absentMeans;
  const g = SPEC.slice(SPEC.indexOf("## 4."), SPEC.indexOf("### 4.1"));
  return [bare.some((x: string) => /light\.extra/.test(x) && /absen/.test(x)) && !said.length && moved.some((x: string) => /light\.extra/.test(x)) && /meaning of absence/i.test(g) && /absentMeans/.test(g), { bare, said, moved }]; });
await C("D10", "grabbable's written defaults are shared/grab.js's own (the hand's reader and the registry can't drift)", async () => {
  const G = await imp("shared/grab.js"); const reg = CAT.COMPONENTS.grabbable.defaults;
  const want = Object.fromEntries(Object.entries(G.DEFAULTS).filter(([, v]) => v !== null && !(typeof v === "object" && !Object.keys(v).length)));
  return [JSON.stringify(Object.keys(want).sort().map((k) => [k, want[k]])) === JSON.stringify(Object.keys(reg).sort().map((k) => [k, reg[k]])), { want, reg }]; });
await C("D9", "§4 explains schemas: reserved (no definition format yet), and the stamped parameters and the pinned registry carry meaning without it", () => {
  const g = SPEC.slice(SPEC.indexOf("## 4."), SPEC.indexOf("### 4.1")); return [/schemas:<name>/.test(g) && /reserved/i.test(g) && !/\*\*optional\*\*/.test(g) && /registry-pin/.test(g) && CAT.COMPONENTS.schemas.status === "reserved", g.slice(g.indexOf("Meaning travels"), g.indexOf("Meaning travels") + 300)]; });

// ---- ST: status (shape audit 10-16; R: every component trial for the alpha) ----
// + the shape audit's wave 2 (attach-interact): sockets (the old map, lift-only) and the names R held (15:16 LOCKED)
// + wave 2 (physics-motion): physics-joint (the constraint, renamed from joint) and surface (closed with physics' reserved fields)
const RESERVED_NAMES = ["joint", "physics-joint", "surface", "schemas", "terrain-grid", "terrain-tile", "terrain-paint", "sockets", "material", "anim-pose", "anim-clip", "anim-states", "camera", "zone", "video", "spring-joint", "link", "tags", "body-owner", "edit-grant", "avatar-deny"];   // the last three: the avatar guard rails' names (PROTOCOL §7a, R 10-17 02:45)
const KSPEC = await import("../../shared/protocol/kernelspec.js");
await C("ST1", "every registered name has a status: the held names are reserved, the kernel's (roles, access) trial-kernel, every other one trial, none stable (v1 promises none)", () => {
  // the kernel's components are trial-kernel (kernel-check.ts guards their change): roles and access since C11b; transform, parent and model
  // left it (the fold never reads them; house plan #260 10-20)
  const KERNEL_COMPONENTS: readonly string[] = KSPEC.KERNEL_COMPONENTS;   // the kernel's own list, never a copy that can drift
  const bad = Object.entries<any>(CAT.COMPONENTS).filter(([k, d]) => d.status !== (RESERVED_NAMES.includes(k) ? "reserved" : KERNEL_COMPONENTS.includes(k) ? "trial-kernel" : "trial")).map(([k, d]) => `${k}: ${d.status}`);
  return [!bad.length && typeof CAT.STATUSES?.trial === "string" && typeof CAT.statusOf === "function" && CAT.statusOf("script:bell") === "trial" && CAT.statusOf("physics-joint:h") === "reserved" && CAT.statusOf("example.org/heart") === null, bad]; });
await C("ST2", "a write of any reserved name is refused at the door, one code and one wording for all of them (an owner's too); physics-joint's fix still says what to use", () => {
  const W = world(); mk(W);
  const tries = [["@world", "schemas:light", "sha256:" + "0".repeat(64)], ["@world", "terrain-grid", { spacing: 1, tile: 8, origin: [0, 0], extent: [1, 1] }], ["@world", "terrain-tile:0-0", { mm: [0] }],
    ["@world", "terrain-paint:0-0", {}], ["box", "physics-joint:h", { to: "@world" }]];
  const rs = tries.map(([id, component, value]) => W.call("set", { id, component, value }));
  const words = rs.map((r) => r.refused?.reason?.replace(/^\S+: '[^']+'/, "X"));
  return [rs.every((r) => !r.ok && r.refused.code === "reserved") && new Set(words).size === 1 && /parent \{to\}/.test(rs[4].refused.fix), rs.map((r) => r.refused ?? r)]; });
await C("ST3", "schema says each name's status and what the statuses mean", () => {
  const W = world(); const r = W.call("schema", {}); const one = W.call("schema", { component: "joint" });
  return [r.ok && r.components.light.status === "trial" && one.components.joint.status === "reserved" && typeof r.statuses?.reserved === "string", [r.statuses, one.components?.joint?.status]]; });

// ---- PN: the pin is a tripwire (shape audit 10-16): trial/reserved breaks re-pin only acknowledged; stable never ----
await C("PN1", "the pin records each name's status, ranges and required fields", () => {
  const p = CAT.pinOf(); return [p.light?.status === "trial" && p.joint?.status === "reserved" && p.sound?.ranges?.volume?.max === 1 && JSON.stringify(p.sound?.required) === '["src"]', [p.light?.status, p.joint?.status, p.sound?.ranges?.volume, p.sound?.required]]; });
await C("PN2", "a break on a trial name (a narrowed range, a removed enum member, a gone name) is refused without --ack and admitted with one, the changelog line naming it and why", () => {
  const pin = CAT.pinOf(), now = CAT.pinOf();
  now.sound.ranges.volume = { min: 0, max: 0.5 }; now.light.enums.kind = ["point"]; delete now.stage;
  const bare = CAT.pinVerdict(pin, now, null), acked = CAT.pinVerdict(pin, now, "test: why", "2026-10-16");
  return [!bare.ok && /--ack/.test(bare.why) && bare.breaks.length === 3 && acked.ok && /^- 2026-10-16: test: why\n/.test(acked.changelog) && /sound\.volume: its range narrowed/.test(acked.changelog) && /light\.kind: "spot" is no longer allowed/.test(acked.changelog) && /stage: the name is gone/.test(acked.changelog), [bare, acked]]; });
await C("PN3", "a stable name's break is never re-pinned, acknowledged or not; an addition or a widened range needs no acknowledgement", () => {
  const pin = CAT.pinOf(); pin.light.status = "stable"; const now = CAT.pinOf(); now.light.status = "stable"; now.light.defaults.intensity = 17;
  const st = CAT.pinVerdict(pin, now, "please"); const wide = CAT.pinOf(); wide.sound.ranges.volume = { min: 0, max: 2 }; wide.sound.fields.extra = "number"; wide.sound.absentMeans = { ...(wide.sound.absentMeans ?? {}), extra: "none" };
  const add = CAT.pinVerdict(CAT.pinOf(), wide, null);
  return [!st.ok && /STABLE/.test(st.why) && add.ok && !add.breaks.length && !add.changelog, [st.why, add]]; });
await C("PN4", "the ladder doc says trial isn't draft, and how a break is acknowledged", () => {
  const t = read("docs/COMPONENT-LADDER.md"); const need = ["trial", "reserved", "stable", "--ack", "REGISTRY-CHANGELOG"]; return [need.every((n) => t.includes(n)) && /draft[^\n]*not[^\n]*admitted|not admitted/i.test(t), need.filter((n) => !t.includes(n))]; });

// ---- W: world-meta tightenings (shape audit 10-16) ----
await C("W1", "about: a name over 80 or a blurb over 2000 characters is refused at the door (the client's limits, now the registry's)", () => {
  const W = world(); const ok80 = W.call("set", { id: "@world", component: "about", value: { name: "n".repeat(80), text: "t".repeat(2000) } });
  const n81 = W.call("set", { id: "@world", component: "about", value: { name: "n".repeat(81), text: "" } }), t2001 = W.call("set", { id: "@world", component: "about", value: { name: "n", text: "t".repeat(2001) } });
  return [ok80.ok && n81.refused?.code === "bounds" && t2001.refused?.code === "bounds", [why(ok80), why(n81), why(t2001)]]; });
await C("W2", "bounds: both corners are required and in metres (units); absence of the component is said (no bounds)", () => {
  const B = CAT.COMPONENTS.bounds; return [JSON.stringify(B.required) === '["min","max"]' && B.units?.min === "m" && B.units?.max === "m" && /Absent/.test(B.help), [B.required, B.units]]; });
await C("W3", "copy-of is server-written: a builder's hand set or create with it is refused (server-written); an owner's needs sha256:<64 hex> from and both fields; a blueprint copy and a duplicate still carry it", () => {
  const W = world(); W.call("set", { id: "@world", component: "default-role", value: { role: "builder" } }); W.call("create", { id: "crate1", model: "crate" }, "bob");
  const H = "sha256:" + "a".repeat(64);
  const hand = W.call("set", { id: "crate1", component: "copy-of", value: { from: H, key: "k" } }, "bob");
  const handC = W.call("create", { id: "c2", model: "crate", components: { "copy-of": { from: H, key: "k" } } }, "bob");
  const bad = W.call("set", { id: "crate1", component: "copy-of", value: { from: "nope", key: "k" } }), half = W.call("set", { id: "crate1", component: "copy-of", value: { from: H } });
  const pub = W.call("publish", { from: "crate1", name: "crate" }, "bob"); const h = Object.keys(W.state().entities["@world"].c).find((k) => k.startsWith("blueprints:"))?.replace("blueprints:", "sha256:");
  const cp = W.call("create", { from: h, id: "cp1" }, "bob"); const dup = W.call("create", { from: "cp1", id: "cp2" }, "bob");
  const st = W.state().entities;
  return [hand.refused?.code === "server-written" && handC.refused?.code === "server-written" && bad.refused?.code === "shape" && half.refused?.code === "schema" && pub.ok && cp.ok && st.cp1?.c["copy-of"]?.from === h && dup.ok,
    [why(hand), why(handC), why(bad), why(half), why(pub), why(cp), why(dup), st.cp1?.c["copy-of"], st.cp2?.c["copy-of"]]]; });
await C("W4", "script: the install check reads its lists from the registry (itemEnums, scopeFields, both pinned); scope.launch is gone (an unknown scope key, refused by the schema); src is a sha256 grammar", () => {
  const W = world(); W.call("create", { id: "bell", model: "crate" });
  const src = W.call("upload", { text: 'world.on("use", () => {});\n' }).src;
  const launch = W.call("set", { id: "bell", component: "script:a", value: { src, scope: { ids: "self", comps: ["t/x"], launch: true }, on: ["use"] } });
  const ev = W.call("set", { id: "bell", component: "script:b", value: { src, scope: { ids: "self", comps: ["t/x"] }, on: ["poke"] } });
  const good = W.call("set", { id: "bell", component: "script:c", value: { src, scope: { ids: "self", comps: ["t/x"], bodies: ["pose"] }, on: ["use", "changed:label"] } });
  const p = CAT.pinOf().script;
  return [launch.refused?.code === "schema" && /unknown key 'launch'/.test(launch.refused.reason) && ev.refused?.code === "shape" && good.ok && !("launch" in CAT.COMPONENTS.script.scopeFields)
    && p.itemEnums?.on?.includes("changed:*") && p.scopeFields?.ids === "scope" && p.grammar?.src === "sha256" && JSON.stringify(p.required) === '["src","scope"]', [why(launch), why(ev), why(good), p.itemEnums]]; });

// ---- I: ids (H5) ----
const RAND = /^[a-z2-7]{26}$/;   // R 10-17: opaque, no slug (ids-check O1/O2)
await C("I1", "the authority mints ids with 128+ random bits (26 base32, nothing else), never <slug>-<count>", () => {
  const W = world(); const ids = []; for (let i = 0; i < 40; i++) { const r = W.call("create", { model: "crate" }); ids.push(r.refs?.[0]?.id); }
  const dup = W.call("create", { from: ids[0] }); const dupId = dup.refs?.[0]?.id;
  return [ids.every((x) => typeof x === "string" && RAND.test(x) && FOLD.isEntityId(x)) && new Set(ids).size === ids.length && RAND.test(dupId ?? ""), [ids.slice(0, 3), dupId]]; });
await C("I2", "no client mints an id (R 10-17: writers never choose ids): each create sends a $placeholder and reads the reply's ids map; the agent door mints nothing; no 8-hex or coordinate ids remain", () => {
  const files = ["client/lib/build.js", "client/lib/worldquad.js", "client/lib/structure_ui.js", "client/lib/facemedia.js"];
  // the agent door mints NOTHING since the 10-14 tools rewrite: create {id omitted} lets the authority mint (mcpl/tools.ts #216
  // note). A client-side mint reappearing there — by any spelling — is the regression this guards.
  const doorMints = /mintId\(|randomUUID\(|randomPart\(|Math\.random\(\)\.toString\(36\)/.test(read("mcpl/tools.ts"));
  const bad = files.filter((f) => /randomUUID\(\)\.slice\(0, 8\)|`house-\$\{Math\.floor/.test(read(f)) || /mintId\(/.test(read(f)) || !/'\$[a-z]+'/.test(read(f)) || !/r\??\.ids\?\.|\.ids\?\.\[/.test(read(f)));
  if (doorMints) bad.push("mcpl/tools.ts (mints client-side; the authority mints)");
  return [!bad.length && fs.existsSync(path.join(T, "shared/protocol/ids.js")), bad]; });
await C("I3", "mintId: 26 base32 characters of randomness, and no slug even when one is offered (R 10-17)", async () => {
  const I = await imp("shared/protocol/ids.js"); const xs = Array.from({ length: 2000 }, () => I.mintId("a".repeat(80)));
  const bare = I.mintId(); return [xs.every((x) => FOLD.isEntityId(x) && x.length <= 64 && RAND.test(x)) && new Set(xs).size === xs.length && /^[a-z2-7]{26}$/.test(bare), [xs[0], bare]]; });
await C("I4", "an entity id shaped like a person's identity (u- + 20 base32) is refused: a reference to it could mean either", () => {
  const W = world(); const r = W.call("create", { id: "u-abcdefghijklmnopqrst", model: "crate" }); return [!r.ok && r.refused.code === "shape", r.refused ?? r]; });

// ---- R: references (H5) ----
await C("R1", "the registry types every reference: parent.to ref, look-at.target target, story.marks refs, captioners.ids people, a script's scope.ids scope, home.parent.to, every reset's targets (shape audit 10-16)", () => {
  const C0 = CAT.COMPONENTS; const got = [C0.parent.fields.to, C0["look-at"].fields.target, C0.story.fields.marks, C0.captioners.fields.ids, C0.script.scopeFields.ids, C0.home.refPaths?.["parent.to"], C0.reactions.refPaths?.["*.targets"]];
  return [JSON.stringify(got) === JSON.stringify(["ref", "target", "refs", "people", "scope", "ref", "refs"]) && typeof CAT.refsOf === "function" && typeof CAT.mapRefs === "function", got]; });
await C("R2", "a reference field holds ids: story.marks [42] and captioners.ids ['Not An Id'] are refused", () => {
  const W = world(); mk(W); const a = W.call("set", { id: "box", component: "story", value: { title: "t", text: "x", marks: [42] } });
  const b = W.call("set", { id: "box", component: "captioners", value: { ids: ["Not An Id"] } }); return [!a.ok && !b.ok, [a.refused, b.refused]]; });
await C("R3", "duplicate rebinds references inside the copy to their twins, keeps outside ones and lists them (keptLinks)", () => {
  const W = world();   // a rig holding a lamp that turns to its sibling switch, and a label marking the switch and something far off
  W.call("create", { id: "rig", model: "crate" }); W.call("create", { id: "lamp", model: "crate", components: { parent: { to: "rig" } } });
  W.call("create", { id: "switch", model: "crate", components: { parent: { to: "rig" } } }); W.call("create", { id: "far", model: "crate" });
  const r1 = W.call("set", { id: "lamp", component: "look-at", value: { target: "switch" } });
  const r2 = W.call("set", { id: "rig", component: "story", value: { title: "rig", text: "x", marks: ["switch", "far"] } });
  const d = W.call("create", { from: "rig", id: "rig2" }); const st = W.state().entities;
  const kids = Object.keys(st).filter((k) => st[k].c.parent?.to === "rig2"); const lamp2 = kids.find((k) => st[k].c["look-at"]), sw2 = kids.find((k) => !st[k].c["look-at"]);
  const kept = (d.notes ?? []).flatMap((n: any) => n.keptLinks ?? []);
  return [r1.ok && r2.ok && d.ok && !!lamp2 && st[lamp2].c["look-at"].target === sw2 && JSON.stringify(st.rig2.c.story.marks) === JSON.stringify([sw2, "far"])
    && kept.some((k: any) => k.to === "far" && /story\.marks/.test(k.from)) && st.lamp.c["look-at"].target === "switch", [why(r1), lamp2 && st[lamp2].c["look-at"], st.rig2?.c.story, kept]]; });
await C("R4", "a script's scope.ids are rebound on duplicate (the copy drives its own twin, never the original)", async () => {
  const W = world(); W.call("create", { id: "bell", model: "crate" }); W.call("create", { id: "bulb", model: "crate", components: { parent: { to: "bell" } } });
  const src = W.call("upload", { text: 'world.on("use", () => world.set("bulb", "t/lit", true));\n' }).src;
  const i = W.call("set", { id: "bell", component: "script:ring", value: { src, scope: { ids: ["bell", "bulb"], comps: ["t/lit"] }, on: ["use"] } });
  const d = W.call("create", { from: "bell", id: "bell2" }); const st = W.state().entities; const twin = Object.keys(st).find((k) => st[k].c.parent?.to === "bell2");
  return [i.ok && d.ok && JSON.stringify(st.bell2.c["script:ring"].scope.ids) === JSON.stringify(["bell2", twin]), [why(i), why(d), st.bell2?.c["script:ring"]?.scope]]; });
await C("R5", "publish refuses a link to a thing outside what's published (outside-link, each listed); unwire: true drops them and says so", () => {
  const W = world(); W.call("create", { id: "sw", model: "crate" }); W.call("create", { id: "lamp", model: "crate" });
  W.call("set", { id: "sw", component: "story", value: { title: "switch", text: "x", marks: ["lamp"] } });
  const a = W.call("publish", { from: "sw", name: "switch" }); const b = W.call("publish", { from: "sw", name: "switch", unwire: true });
  const rec = b.ok ? W.getBlob(Object.keys(W.state().entities["@world"].c).find((k) => k.startsWith("blueprints:"))!.replace("blueprints:", "sha256:")) : null;
  return [!a.ok && a.refused.code === "outside-link" && JSON.stringify(a.refused).includes("lamp") && b.ok && (b.notes ?? []).some((n: any) => n.unwired?.length)
    && rec && !JSON.stringify(rec).includes('"lamp"'), [a.refused, why(b), rec?.parts?.[0]?.components?.story]]; });
await C("R6", "a blueprint's inside links become the copy's own ids (parts' keys → fresh ids); a raw id from another world is unbound and said", () => {
  const W = world(); W.call("create", { id: "rig", model: "crate" }); W.call("create", { id: "lamp", model: "crate", components: { parent: { to: "rig" } } });
  W.call("create", { id: "switch", model: "crate", components: { parent: { to: "rig" } } }); W.call("set", { id: "lamp", component: "look-at", value: { target: "switch" } });
  const p = W.call("publish", { from: "rig", name: "rig" }); const h = Object.keys(W.state().entities["@world"].c).find((k) => k.startsWith("blueprints:"))!.replace("blueprints:", "sha256:");
  const c = W.call("create", { from: h, id: "copy" }); const st = W.state().entities; const kids = Object.keys(st).filter((k) => st[k].c.parent?.to === "copy");
  const l2 = kids.find((k) => st[k].c["look-at"]), s2 = kids.find((k) => !st[k].c["look-at"]);
  return [p.ok && c.ok && !!l2 && st[l2].c["look-at"].target === s2 && s2 !== "switch", [why(p), why(c), l2 && st[l2].c["look-at"]]]; });
await C("R7", "the spec scopes ids to their world and says fork-copy; merging a fork back is RESERVED with governance (its draft rule is on the wishlist)", () => {
  const need = ["(world id, entity id)", "fork-copy", "Merging a fork back into its\n  parent is RESERVED"]; return [need.every((n) => SPEC.includes(n)), need.filter((n) => !SPEC.includes(n))]; });

// ---- P: privacy (M3) ----
const actsBy = (W: any, who: string, verb?: string) => W.entries().filter((e: any) => e.actor === who && e.kind === "act" && (!verb || e.verb === verb));
const POSKEYS = /"(at|hand|held|trackTs|from|to|client|presence)":/;
await C("P1", "arriving in a world writes nothing to its log (presence, never history)", () => {
  const W = world(); const n0 = W.entries().length; const r = W.call("move", { to: [0, 0, 0.5] }, "vic");
  return [r.ok && W.entries().length === n0 && !r.recorded, [why(r), W.entries().length - n0]]; });
await C("P2", "a teleport while present is an act on the record, without where from, where to, or what kind of client", () => {
  const W = world(); W.call("move", { to: [0, 0, 0.5] }, "olive"); const r = W.call("move", { to: [3, 0, 3], teleport: true }, "olive");
  const a = actsBy(W, "olive", "move").at(-1); return [r.ok && !!a && !POSKEYS.test(JSON.stringify(a.body)) && a.body.request?.teleport === true, a?.body]; });
await C("P3", "grab, put, throw and punt acts record the request about the thing, never the body's position or hand", () => {
  const W = world(); W.call("set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
  W.call("create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic" } }, place: { at: [0, 0] } });
  W.call("move", { to: [0, 0, 0.5] }, "vic"); const g = W.call("grab", { id: "ball" }, "vic"); const p = W.call("put", { id: "ball" }, "vic");
  W.call("grab", { id: "ball" }, "vic"); const t = W.call("throw", { id: "ball", v: [0, 1, 1] }, "vic");
  const acts = actsBy(W, "vic").filter((e: any) => ["grab", "put", "throw", "punt", "drop"].includes(e.verb));
  const bad = acts.filter((e: any) => JSON.stringify(e.body).match(/"presence"|"hand"|"held"|"trackTs"/));
  return [g.ok && p.ok && t.ok && acts.length >= 3 && !bad.length, [why(g), why(p), why(t), bad.map((e: any) => e.body)]]; });
await C("P4", "§5 says what touches the log and what doesn't: arrivals don't; a teleport does, with no position; hands never", () => {
  const g = SPEC.slice(SPEC.indexOf("## 5."), SPEC.indexOf("## 6.")); const need = ["Arriving is presence", "never logged", "client"];
  return [need.every((n) => g.includes(n)) && !/Arriving,\s+teleporting, putting something down/.test(g), need.filter((n) => !g.includes(n))]; });

console.log(`\npretrans: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
