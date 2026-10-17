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
  const need = ["metres, kilograms, seconds", "epoch milliseconds", "radians", "[x, y, z, w]", "3-vectors", "names its frame", "sRGB", "content addresses", "treat the whole", "current default", "never written whole", "No person data", "refPaths", "role id", "falloff", "required"];
  return [/about a year/.test(alpha) && /no guarantee/i.test(alpha) && /repair/.test(alpha) && need.every((n) => conv.includes(n)), need.filter((n) => !conv.includes(n))]; });

// ---- C: citations (M5) ----
// every "§N" or "§N.M" inside a string literal of the files whose words reach people and agents names a heading of
// PROTOCOL.md (or PHYSICS.md when it says PHYSICS); lab-era names (§2.3, §3d, L1–L7, R8…) are gone from those words
const HEAD = new Set([...SPEC.matchAll(/^#{2,3} (\d+[a-z]?(?:\.\d+)?)\.?\s/gm)].map((m) => m[1]));   // "## 7a." is a section too
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

await C("K7", "no account subject is written (PROTOCOL §9.2): without a mapper the translation's roles:janus has no sub and the imported grant act's args don't either; the door refuses roles {sub}", () => {
  const r = TV1.translate(v1commons(), { founder: FOUNDER }); const w = r.final.translated["@world"];
  const acts = r.out.filter((e: any) => e.kind === "act" && e.verb === "imported" && e.body?.verb === "grant");
  const W = world(); const sub = W.call("set", { id: "@world", component: "roles:vic", value: { role: "visitor", sub: "human:discord:9" } });
  return [w[`roles:${TV1.enc("janus")}`]?.role === "owner" && !("sub" in w[`roles:${TV1.enc("janus")}`]) && acts.length >= 4 && !JSON.stringify(acts).includes("human:discord") && !sub.ok && sub.refused.code === "schema"
    && /@13$/.test(TV1.TRANSLATOR) && /@13$/.test(TV1.TRANSLATOR_SIM), [w[`roles:${TV1.enc("janus")}`], acts.map((a: any) => a.body.args), sub.refused, TV1.TRANSLATOR]]; });

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
await C("D3", "a grabbable's defaults are written (range 1.5, who visitor, steal, throw, release…) and the authority still takes it", () => {
  const W = world(); mk(W, "g"); const r = W.call("set", { id: "g", component: "grabbable", value: {} }); const g = stored(W, "g", "grabbable");
  return [r.ok && g?.range === 1.5 && g.who === "visitor" && g.steal === true && g.throw === 1 && g.release === "drop" && g.hold === "auto" && g.enabled === true, [why(r), g]]; });
await C("D4", "a motion's per-type defaults are written: spin's axis and rate, orbit's radius and rate, bob's amp and period, path's speed and loop", () => {
  const W = world(); for (const id of ["sp", "sp2", "or", "bo", "pa"]) mk(W, id);
  W.call("set", { id: "sp", component: "motion", value: { type: "spin" } }); W.call("set", { id: "sp2", component: "motion", value: { type: "spin", period: 10 } });
  W.call("set", { id: "or", component: "motion", value: { type: "orbit" } }); W.call("set", { id: "bo", component: "motion", value: { type: "bob" } });
  W.call("set", { id: "pa", component: "motion", value: { type: "path", points: [[0, 0, 0], [0, 0, 2]] } });
  const m = (id: string) => stored(W, id, "motion");
  return [JSON.stringify(m("sp").axis) === "[0,1,0]" && m("sp").degPerSec === 36 && m("sp").phase === 0 && !("degPerSec" in m("sp2")) && m("or").radius === 3 && m("or").degPerSec === 12 && m("or").face === true
    && m("bo").amp === 0.3 && m("bo").period === 4 && m("pa").speed === 1 && m("pa").loop === "loop" && m("pa").face === true, ["sp", "sp2", "or", "bo", "pa"].map(m)]; });
await C("D5", "a physics thing that flies says who may punt it (visitor); world settings set in part store ONLY what was written, even a value equal to today's default (capacity, script-settings: policy numbers, PROTOCOL §9.2)", () => {
  const W = world(); mk(W, "p"); W.call("set", { id: "p", component: "physics", value: { kind: "dynamic" } });
  W.call("set", { id: "@world", component: "capacity", value: { entities: 100 } }); W.call("set", { id: "@world", component: "script-settings", value: { max: 3 } });
  const cap1 = W.state().entities["@world"].c.capacity;
  const same = W.call("set", { id: "@world", component: "capacity", value: { guestEntities: CAPACITY.guestEntities } });
  W.call("set", { id: "@world", component: "default-role", value: { role: "builder" } });
  const w = W.state().entities["@world"].c, ss = w["script-settings"];
  return [stored(W, "p", "physics")?.who === "visitor" && JSON.stringify(cap1) === '{"entities":100}' && same.ok && JSON.stringify(w.capacity) === JSON.stringify({ guestEntities: CAPACITY.guestEntities }) && JSON.stringify(ss) === '{"max":3}'
    && W.call("set", { id: "@world", component: "default-role", value: { role: "none" } }).ok, [stored(W, "p", "physics"), cap1, w.capacity, ss]]; });
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
  const DYN = new Set(["motion.center", "grabbable.pose", "sockets.radius", "sockets.anchor", "reactions.component", "reactions.field", "reactions.strength", "default-role.guests"]);
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
const RESERVED_NAMES = ["joint", "physics-joint", "surface", "schemas", "terrain-grid", "terrain-tile", "terrain-paint", "sockets", "material", "anim-clip", "anim-states", "camera", "zone", "video", "spring-joint", "link", "tags", "body-owner", "edit-grant", "avatar-deny"];   // the last three: the avatar guard rails' names (PROTOCOL §7a, R 10-17 02:45)
await C("ST1", "every registered name has a status: the held names are reserved, every other one trial, none stable (v1 promises none)", () => {
  const bad = Object.entries<any>(CAT.COMPONENTS).filter(([k, d]) => d.status !== (RESERVED_NAMES.includes(k) ? "reserved" : "trial")).map(([k, d]) => `${k}: ${d.status}`);
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
await C("R7", "the spec scopes ids to their world and writes the merge duplicate-id rule down", () => {
  const need = ["(world id, entity id)", "fork-copy", "rename map", "typed reference"]; return [need.every((n) => SPEC.includes(n)), need.filter((n) => !SPEC.includes(n))]; });

// ---- P: privacy (M3) ----
const actsBy = (W: any, who: string, verb?: string) => W.entries().filter((e: any) => e.actor === who && e.kind === "act" && (!verb || e.verb === verb));
const POSKEYS = /"(at|hand|held|trackTs|from|to|client|presence)":/;
await C("P1", "arriving in a world writes nothing to its log (presence, never history)", () => {
  const W = world(); const n0 = W.entries().length; const r = W.call("move", { to: [0, 0, 0.5], client: "agent" }, "vic");
  return [r.ok && W.entries().length === n0 && !r.recorded, [why(r), W.entries().length - n0]]; });
await C("P2", "a teleport while present is an act on the record, without where from, where to, or what kind of client", () => {
  const W = world(); W.call("move", { to: [0, 0, 0.5] }, "olive"); const r = W.call("move", { to: [3, 0, 3], teleport: true, client: "human" }, "olive");
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
