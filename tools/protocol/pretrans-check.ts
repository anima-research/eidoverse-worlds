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
//   K   the Commons' translation carries its owners, and its tier 0 is the founder's own key (H4)
//   N   names: bare names belong to the registry; anyone else's carry a namespace; a registered alias works (H1, M7)
//   D   defaults: every parameter is written into the stored value at create/add time (H2); meanings are pinned
//   I   ids: minted ids are ≥ 128 random bits, everywhere (H5)
//   F   forks: genesis.parent {world, seq, head}; copied acts are marked (H5)
//   R   references: typed ref/refs/person fields; duplicate and publish rebind them (H5)
//   P   privacy: arrivals and grabs log what correctness needs, not where people stood or what they are (M3)
//   U   model values are content addresses after translation; the server and the client resolve them (H3)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ENGINE, scratch } from "./common.ts";
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const only = opt("only")?.split(",") ?? null;
const T = ENGINE;
const imp = async (p: string) => await import(path.join(T, p));
const FOLD = await imp("shared/protocol/fold.js"), D = await imp("shared/protocol/authority.js"), CAT = await imp("shared/protocol/componentspec.js");
const SD = await imp("tools/protocol/scratchworld.ts");
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

// ---- C: citations (M5) ----
// every "§N" or "§N.M" inside a string literal of the files whose words reach people and agents names a heading of
// PROTOCOL.md (or PHYSICS.md when it says PHYSICS); lab-era names (§2.3, §3d, L1–L7, R8…) are gone from those words
const HEAD = new Set([...SPEC.matchAll(/^#{2,3} (\d+(?:\.\d+)?)\.?\s/gm)].map((m) => m[1]));
const PHYS = new Set([...read("spec/PHYSICS.md").matchAll(/^#{2,3} (\d+(?:\.\d+)?)\./gm)].map((m) => m[1]));
const SAID = ["shared/protocol/authority.js", "shared/protocol/componentspec.js", "shared/protocol/verbspec.js", "shared/protocol/refusal.js", "shared/protocol/roles.js", "mcpl/tools.ts", "shared/grab.js", "shared/sockbody.js"];
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
await C("G3", "§13 writes the governance body down: {key?, owners?, fork?, sigs}, the signed message, and the add-key rule", () => {
  const g = SPEC.slice(SPEC.indexOf("## 13."), SPEC.indexOf("## 14."));
  const need = ["`sigs`", "eidoverse-gov:", "GOV-5", "adding", "empty tier"]; return [need.every((n) => g.includes(n)), need.filter((n) => !g.includes(n))]; });

// ---- K: the Commons' keys and owners (H4) ----
const TV1 = await imp("tools/protocol/import-v1/translate-v1.js");
const KEYS = await imp("shared/protocol/fold.js");
const FOUNDER = "ed25519:" + Buffer.from(require("node:crypto").generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" })).subarray(12).toString("base64url");
const v1commons = () => [{ seq: 0, ts: 1, actor: "world", verb: "grant", args: { id: "antra", role: "owner", gen: true } },
  { seq: 1, ts: 2, actor: "antra", verb: "grant", args: { id: "Digi_Rat", role: "builder" } },
  { seq: 2, ts: 3, actor: "antra", verb: "grant", args: { id: "fable", role: "owner" } },
  { seq: 3, ts: 4, actor: "antra", verb: "grant", args: { id: "janus", role: "owner", sub: "human:discord:1" } },
  { seq: 4, ts: 5, actor: "antra", verb: "grant", args: { id: "mica", role: "owner" } },
  { seq: 5, ts: 6, actor: "antra", verb: "spawn", args: { id: "rock_1", lib: "store/0123456789abcdef.glb", pos: [0, 0, 0] } }];
await C("K1", "a translation with the founder's key puts it in tier 0 and the operator's in tier 1", () => {
  const r = TV1.translate(v1commons(), { founder: FOUNDER, operator: TV1.LAB_DOOR_KEY });
  const g = r.out[0].body; return [JSON.stringify(g.owners) === JSON.stringify([[FOUNDER], [TV1.LAB_DOOR_KEY]]) && KEYS.checkGenesis(g) === null, g.owners]; });
await C("K2", "the Commons' roles come across: antra, fable, janus, mica owners; Digi_Rat builder", () => {
  const r = TV1.translate(v1commons(), { founder: FOUNDER }); const w = r.final.translated["@world"];
  const role = (n: string) => w[`roles:${TV1.enc(n)}`]?.role;
  return [["antra", "fable", "janus", "mica"].every((n) => role(n) === "owner") && role("Digi_Rat") === "builder", Object.keys(w).filter((k) => k.startsWith("roles:"))]; });
await C("K3", "the translate command refuses to found a world without the founder's key (or an explicit --no-founder-key)", () => {
  const W = scratch("ktr"); fs.mkdirSync(path.join(W, "old"), { recursive: true });
  fs.writeFileSync(path.join(W, "old", "log.jsonl"), v1commons().map((e) => JSON.stringify(e)).join("\n") + "\n");
  const run = (...extra: string[]) => Bun.spawnSync(["bun", path.join(T, "tools/protocol/world.ts"), "translate", "old", ...extra], { cwd: T, env: { ...process.env, WORLDS_DIR: W, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const bare = run("new1"); const withKey = run("new2", "--founder-key", FOUNDER);
  const g = fs.existsSync(path.join(W, "new2", "world.jsonl")) ? JSON.parse(fs.readFileSync(path.join(W, "new2", "world.jsonl"), "utf8").split("\n")[0]).body : null;
  return [bare.exitCode !== 0 && !fs.existsSync(path.join(W, "new1", "world.jsonl")) && withKey.exitCode === 0 && g?.owners?.[0]?.[0] === FOUNDER,
    { bare: bare.exitCode, bareSaid: bare.stderr.toString().slice(0, 200), withKey: withKey.exitCode, said: withKey.stderr.toString().slice(0, 300), owners: g?.owners }]; });
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
await C("K6", "the import README documents the Commons ceremony: key made on the founder's machine, checked, then translated", () => {
  const t = read("tools/protocol/import-v1/README.md"); const need = ["owner-key", "--founder-key", "openssl", "custody.json", "antra"]; return [need.every((n) => t.includes(n)), need.filter((n) => !t.includes(n))]; });

console.log(`\npretrans: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
