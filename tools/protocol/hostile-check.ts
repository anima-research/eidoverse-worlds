// The hostile-log suite (PROTOCOL §6 proof 1): every fold probe from 25d and 25e, run against the baseline fold
// (lab commit 4f62913, the control arm: only with PROTOCOL_LAB, see common.ts) and the strict fold. Each probe must be BAD
// on the baseline and GOOD now. Ported from the protocol lab's hostile-check.js @ 11db981; only paths changed.
// usage: bun tools/protocol/hostile-check.ts [--verbose]
// @ts-nocheck — lab code, kept as written
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { readLog, fold, digest, worldIdOf, parseLine, cloneState, PURGED } from "../../shared/protocol/fold.js";
import { carried } from "../../shared/protocol/simlayer.js";
import { elide } from "../../shared/protocol/scriptrules.js";
import { create as createRequest } from "../../shared/protocol/requests.js";
import { leftWords, listedIn } from "../../shared/protocol/access.js";
import { ENGINE, LAB, scratch, controlNote } from "./common.ts";
import * as AU from "../../shared/protocol/authority.js";

const root = scratch("hostile");
const basePath = root + "baseline-fold.mjs";
let base = null;
if (LAB) { fs.writeFileSync(basePath, Bun.spawnSync(["git", "show", "4f62913:fold.js"], { cwd: LAB }).stdout); base = await import(basePath); }
const verbose = process.argv.includes("--verbose");

// ---- builders for both formats ----
// §2.4 + §3d: genesis {dialect, v, minor, nonce, owners: tiers of keys, sequencer} (fixed test key and nonce; lab hostile-check)
const KEY = "ed25519:BP7aKo17f474DD1aBSLG0a3Pb29Qs3yqQ6Ve0wSRVD0";
const GEN = { kind: "genesis", actor: "system", verb: "genesis", body: { dialect: "eidoverse-log", v: 4, minor: 0, nonce: "XWVu1u7BpaZTDFSETYiphg", owners: [[KEY]], sequencer: KEY } };
const WID = worldIdOf(parseLine(JSON.stringify(GEN)));
const L = (o) => JSON.stringify(o);
const act = L({ world: WID, kind: "act", ts: 1, actor: "olive", verb: "set", body: {} }); // §2.1: every entry after genesis carries ts
const st = (verb, body, extra = {}) => L({ world: WID, kind: "change", ts: 1, actor: "olive", cause: 1, verb, body, ...extra });
const logOf = (...lines) => [L(GEN), act, ...lines].join("\n") + "\n";
const bGen = { kind: "genesis", actor: "world", verb: "genesis", args: { v: 4, fold: 1 }, seq: 0 };
const bst = (seq, verb, args) => ({ kind: "change", actor: "olive", cause: 1, verb, args, seq });
const baseText = (text, getBlob = () => { throw new Error("no blob"); }) => base.fold(text.split("\n").filter(Boolean).map((l) => JSON.parse(l)), getBlob);
const run = (f) => { try { return { ok: true, v: f() }; } catch (e) { return { ok: false, err: `${e.constructor.name}: ${e.message}`.slice(0, 120) }; } };
const now = (text) => fold(readLog(text));
const codes = (s) => s.diagnostics.map(([q, c]) => `${q}:${c}`);
const keys = (o) => (o ? Object.keys(o) : []);
// a deep batch as raw text (JSON.stringify itself overflows at this depth)
const deepLine = (n) => `{"world":"${WID}","kind":"change","ts":1,"actor":"olive","cause":1,"verb":"batch","body":{"ops":[` + '{"verb":"batch","ops":['.repeat(n) + '{"verb":"create","id":"deep"}' + "]}".repeat(n) + "]}}";
const deepBatch = (n, shape) => { let o = shape === "now" ? { verb: "create", id: "deep" } : { verb: "create", args: { id: "deep" } };
  for (let k = 0; k < n; k++) o = shape === "now" ? { verb: "batch", ops: [o] } : { verb: "batch", args: { ops: [o] } }; return o; };

const probes = [
  { id: "H3a", src: "25d H3", what: "batch {ops:[null]}",
    base: () => run(() => base.fold([bGen, bst(1, "batch", { ops: [null] })])),
    baseBad: (r) => !r.ok, now: () => now(logOf(st("batch", { ops: [null] }))), nowGood: (s) => s.status === "ok" && codes(s).includes("2:malformed:batch-op") },
  { id: "H3b", src: "25d H3", what: "a log line that is `null`",
    base: () => run(() => base.fold([bGen, null])), baseBad: (r) => !r.ok,
    now: () => now(logOf("null")), nowGood: (s) => s.status === "ok" && codes(s).includes("2:malformed:not-object") },
  { id: "H3c", src: "25d H3, 25e §0", what: "set on id `constructor` (resolves through Object.prototype)",
    base: () => run(() => base.fold([bGen, bst(1, "set", { id: "constructor", component: "x", value: 1 })])), baseBad: (r) => !r.ok,
    now: () => now(logOf(st("set", { id: "constructor", comp: "x", value: 1 }))), nowGood: (s) => codes(s).includes("2:noop:set-missing-entity") && keys(s.entities).join() === "@world" },
  { id: "H3d", src: "25d H3, 25e §0", what: "delete {id:'toString', component:'x'}",
    base: () => run(() => base.fold([bGen, bst(1, "delete", { id: "toString", component: "x" })])), baseBad: (r) => !r.ok,
    now: () => now(logOf(st("delete", { id: "toString", comp: "x" }))), nowGood: (s) => codes(s).includes("2:malformed:entity-id") },
  { id: "H3e", src: "25d H3", what: "an expanded kit whose blob is [null]",
    base: () => run(() => base.fold([bGen, bst(1, "create", { id: "kit", expanded: "h" })], () => [null])), baseBad: (r) => !r.ok,
    now: () => now(logOf(st("create", { id: "kit", expanded: "h" }))), nowGood: (s) => codes(s).includes("2:malformed:op-field") && !s.entities.kit },
  { id: "H3f", src: "25d H3", what: "a batch nested 50,000 deep (1.7 MB line)",
    base: () => run(() => base.fold([bGen, { kind: "change", seq: 1, ...deepBatch(50000, "base") }])), baseBad: (r) => !r.ok,
    now: () => now(logOf(deepLine(50000))),
    nowGood: (s) => s.status === "ok" && codes(s).some((c) => /^2:malformed:(cap-size|cap-depth|nested-batch)$/.test(c)) && !s.entities.deep },
  { id: "H3g", src: "25d H3", what: "component `__proto__` = {pinned:true}: a pin nobody can see",
    base: () => run(() => { const s = baseText([bGen, bst(1, "create", { id: "gate", components: {} }), bst(2, "set", { id: "gate", component: "__proto__", value: { pinned: true } })].map(L).join("\n"));
      const c = s.entities.gate.c; return { pinned: c.pinned, keys: Object.keys(c), json: JSON.stringify(c) }; }),
    baseBad: (r) => r.ok && r.v.pinned === true && r.v.keys.length === 0,
    now: () => now(logOf(st("create", { id: "gate" }), st("set", { id: "gate", comp: "__proto__", value: { pinned: true } }))),
    nowGood: (s) => codes(s).includes("3:malformed:comp-name") && s.entities.gate.c.pinned === undefined && Object.getPrototypeOf(s.entities.gate.c) === null },
  { id: "H3h", src: "25d H3, 25e §0", what: "an entity with id `__proto__` (invisible; phantom ids)",
    base: () => run(() => { const s = base.fold([bGen, bst(1, "create", { id: "__proto__", components: { a: 1 } })]); return { keys: Object.keys(s.entities), born: s.entities.born, c: s.entities.c }; }),
    baseBad: (r) => r.ok && r.v.keys.length === 0 && r.v.born !== undefined,
    now: () => now(logOf(st("create", { id: "__proto__" }))), nowGood: (s) => codes(s).includes("2:malformed:entity-id") && keys(s.entities).join() === "@world" },
  { id: "E0c", src: "25e §0", what: "set {id:e, component:'__proto__', value:{transform:…}} (phantom read)",
    base: () => run(() => { const s = base.fold([bGen, bst(1, "create", { id: "e", components: {} }), bst(2, "set", { id: "e", component: "__proto__", value: { transform: { p: [9, 9, 9] } } })]);
      return { keys: Object.keys(s.entities.e.c), t: s.entities.e.c.transform }; }), baseBad: (r) => r.ok && r.v.keys.length === 0 && r.v.t,
    now: () => now(logOf(st("create", { id: "e" }), st("set", { id: "e", comp: "__proto__", value: { transform: { p: [9, 9, 9] } } }))),
    nowGood: (s) => codes(s).includes("3:malformed:comp-name") && s.entities.e.c.transform === undefined },
  { id: "E0d", src: "25e §0", what: "a batch nested 20,000 deep: bun folds it, node overflows (readers disagree)",
    base: () => { const f = root + "probe-deep.mjs";
      fs.writeFileSync(f, `import { fold } from ${JSON.stringify(pathToFileURL(basePath).href)}; const o0 = { verb: "create", args: { id: "deep" } }; let o = o0; for (let k = 0; k < 20000; k++) o = { verb: "batch", args: { ops: [o] } };
        try { const s = fold([{ kind: "genesis", verb: "genesis", seq: 0, args: {} }, { kind: "change", seq: 1, ...o }], () => null); console.log("folded:" + Object.keys(s.entities)); } catch (e) { console.log("threw:" + e.constructor.name); }`);
      const out = ["bun", "node"].map((r) => Bun.spawnSync([r, f]).stdout.toString().trim()); fs.rmSync(f); return { ok: true, v: { bun: out[0], node: out[1] } }; },
    baseBad: (r) => r.v.bun !== r.v.node,
    now: () => { const f = root + "probe-deep2.mjs"; fs.writeFileSync(root + "probe-deep.jsonl", logOf(deepLine(20000)));
      fs.writeFileSync(f, `import fs from "node:fs"; import { readLog, fold, digest } from ${JSON.stringify(pathToFileURL(ENGINE + "shared/protocol/fold.js").href)}; const s = fold(readLog(fs.readFileSync(${JSON.stringify(root + "probe-deep.jsonl")}))); console.log(s.status + ":" + digest(s) + ":" + s.diagnostics.map((d) => d[1]).join());`);
      const out = ["bun", "node"].map((r) => Bun.spawnSync([r, f]).stdout.toString().trim()); fs.rmSync(f); fs.rmSync(root + "probe-deep.jsonl"); return { bun: out[0], node: out[1] }; },
    nowGood: (s) => s.bun === s.node && /^ok:.*malformed:(cap-depth|nested-batch)/.test(s.bun) },
  { id: "H5a", src: "25d H5", what: "genesis says another fold version, log uses its verb `move`",
    base: () => run(() => { const s = base.fold([{ ...bGen, args: { v: 4, fold: 2 } }, bst(1, "create", { id: "a", components: {} }), bst(2, "move", { id: "a", to: [1, 0, 0] })]); return { fold: s.fold, a: s.entities.a.c }; }),
    baseBad: (r) => r.ok && r.v.fold === 2, // folded under v1 anyway, no flag; the move silently vanished
    now: () => now([L({ ...GEN, body: { version: 5, owners: [] } }), act, st("create", { id: "a" }), st("move", { id: "a", to: [1, 0, 0] })].join("\n")),
    nowGood: (s) => s.status === "unknown-version" && s.entities === null },
  { id: "H5b", src: "25d H5", what: "a later entry with verb genesis rewrites the version mid-log",
    base: () => run(() => base.fold([bGen, { kind: "timeline", verb: "genesis", seq: 1, args: { fold: 99 } }]).fold), baseBad: (r) => r.ok && r.v === 99,
    now: () => now(logOf(L({ kind: "genesis", actor: "system", verb: "genesis", body: { dialect: "eidoverse-log", v: 99, owners: [] } }), st("create", { id: "a" }))),
    nowGood: (s) => s.status === "ok" && s.v === 4 && codes(s).includes("2:malformed:genesis-not-first") && s.entities.a },
  { id: "H5c", src: "PROTOCOL L1", what: "no genesis at entry 0 (genesis only as entry 0 of kind genesis)",
    base: () => run(() => keys(base.fold([bst(0, "create", { id: "a", components: {} })]).entities)), baseBad: (r) => r.ok && r.v.includes("a"),
    now: () => now([st("create", { id: "a" }).replace('"cause":1', '"cause":0'), L(GEN)].join("\n")), nowGood: (s) => s.status === "no-world" && s.entities === null },
  { id: "H6a", src: "25d H6, 25e §0", what: "blob tamper: the world changes when one store file is rewritten",
    base: () => run(() => { const e = [bGen, bst(1, "create", { id: "kit", expanded: "65405060835a8af9" })];
      const a = base.fold(e, () => [{ id: "kit", components: { model: "chair" } }]), b = base.fold(e, () => [{ id: "kit", components: { model: "wall" } }]);
      return [a.entities.kit.c.model, b.entities.kit.c.model]; }), baseBad: (r) => r.ok && r.v[0] !== r.v[1],
    now: () => { const s = now(logOf(st("create", { id: "kit", expanded: "65405060835a8af9" }))); return { s, arity: fold.length }; },
    nowGood: (r) => codes(r.s).includes("2:malformed:op-field") && !r.s.entities.kit && r.arity === 1 }, // fold(entries, opts): no blob reader to give it
  { id: "E0g", src: "25e §0", what: "create {id:'kit1', expanded} whose blob lists another author's id `victim`",
    base: () => run(() => base.fold([bGen, bst(1, "create", { id: "victim", components: { label: "mine" } }), bst(2, "create", { id: "kit1", expanded: "h" })], () => [{ id: "victim", components: { label: "pwned" } }]).entities.victim.c.label),
    baseBad: (r) => r.ok && r.v === "pwned",
    now: () => now(logOf(st("create", { id: "victim" }), st("set", { id: "victim", comp: "label", value: "mine" }), st("create", { id: "kit1", expanded: "h" }))),
    nowGood: (s) => s.entities.victim.c.label === "mine" && codes(s).includes("4:malformed:op-field") },
  { id: "M1a", src: "25d M1", what: "pos [1e400, 12345678901234567890, -0] in the log text",
    base: () => run(() => { const s = baseText([bGen, bst(1, "create", { id: "a", components: {} })].map(L).join("\n") + '\n{"kind":"change","actor":"olive","cause":1,"verb":"set","args":{"id":"a","component":"transform","value":{"pos":[1e400,12345678901234567890,-0]}},"seq":2}');
      return s.entities.a.c.transform.pos; }), baseBad: (r) => r.ok, // folded to [null, 12345678901234567000, 0]
    now: () => now(logOf(st("create", { id: "a" })) + `{"world":"${WID}","kind":"change","ts":1,"actor":"olive","cause":1,"verb":"set","body":{"id":"a","comp":"transform","value":{"pos":[1e400,12345678901234567890,-0]}}}\n`),
    nowGood: (s) => codes(s).some((c) => /^3:malformed:ijson-(nonfinite|bigint|negzero)$/.test(c)) && s.entities.a.c.transform === undefined },
  { id: "M1b", src: "25d M1", what: '{"component":"pinned","component":"label"} (duplicate keys)',
    base: () => run(() => { const s = baseText(L(bGen) + "\n" + L(bst(1, "create", { id: "g", components: {} })) + '\n{"kind":"change","actor":"olive","cause":1,"verb":"set","args":{"id":"g","component":"pinned","component":"label","value":true},"seq":2}');
      return keys(s.entities.g.c); }), baseBad: (r) => r.ok && r.v.length === 1, // one silently chosen; serde would refuse, a stream parser might take the first
    now: () => now(logOf(st("create", { id: "g" })) + `{"world":"${WID}","kind":"change","ts":1,"actor":"olive","cause":1,"verb":"set","body":{"id":"g","comp":"pinned","comp":"label","value":true}}\n`),
    nowGood: (s) => codes(s).includes("3:malformed:ijson-dupkey") && keys(s.entities.g.c).length === 0 },
  { id: "M1c", src: "25d M1", what: "seq field disagrees with file order (fold vs stateAt)",
    base: () => run(() => { const e = [bGen, bst(2, "create", { id: "a", components: { n: 1 } }), bst(1, "set", { id: "a", component: "n", value: 2 })];
      const all = base.fold(e).entities.a?.c.n, at1 = base.fold(e.filter((x) => x.seq <= 1)).entities.a?.c.n, prefix = base.fold(e.slice(0, 2)).entities.a?.c.n; return { all, at1, prefix }; }),
    baseBad: (r) => r.ok && r.v.at1 !== r.v.prefix,
    now: () => now(logOf(st("create", { id: "a" }, { seq: 7 }))), nowGood: (s) => codes(s).includes("2:malformed:seq-field") && !s.entities.a },
  { id: "M5a", src: "25d M5", what: "homoglyph component `lоcked` (Cyrillic о)",
    base: () => run(() => keys(base.fold([bGen, bst(1, "create", { id: "gate", components: {} }), bst(2, "set", { id: "gate", component: "lоcked", value: true })]).entities.gate.c)),
    baseBad: (r) => r.ok && r.v.length === 1,
    now: () => now(logOf(st("create", { id: "gate" }), st("set", { id: "gate", comp: "lоcked", value: true }))), nowGood: (s) => codes(s).includes("3:malformed:comp-name") && keys(s.entities.gate.c).length === 0 },
  { id: "M5b", src: "25d M5", what: "the fold invents a `missing` component for an unreadable blob",
    base: () => run(() => base.fold([bGen, bst(1, "create", { id: "kit", expanded: "gone" })], () => { throw new Error("404"); }).entities.kit.c),
    baseBad: (r) => r.ok && r.v.missing,
    now: () => now(logOf(st("create", { id: "kit", expanded: "gone" }))), nowGood: (s) => !s.entities.kit && !JSON.stringify(s.entities).includes("missing") },
  { id: "M6a", src: "25d M6", what: "create on a live id replaces it wholesale and resets born",
    base: () => run(() => { const s = base.fold([bGen, bst(1, "create", { id: "a", components: { label: "keep" } }), bst(2, "create", { id: "a", components: {} })]); return s.entities.a; }),
    baseBad: (r) => r.ok && r.v.c.label === undefined && r.v.born === 2,
    now: () => now(logOf(st("create", { id: "a" }), st("set", { id: "a", comp: "label", value: "keep" }), st("create", { id: "a" }))),
    nowGood: (s) => s.entities.a.c.label === "keep" && s.entities.a.born === 2 && codes(s).includes("4:noop:create-live") },
  { id: "M6b", src: "25d M6", what: "set with no value leaves a key that is present to `in` and absent from JSON",
    base: () => run(() => { const c = base.fold([bGen, bst(1, "create", { id: "a", components: {} }), bst(2, "set", { id: "a", component: "x" })]).entities.a.c; return { in: "x" in c, json: JSON.stringify(c) }; }),
    baseBad: (r) => r.ok && r.v.in && r.v.json === "{}",
    now: () => now(logOf(st("create", { id: "a" }), st("set", { id: "a", comp: "x" }))), nowGood: (s) => !("x" in s.entities.a.c) && codes(s).includes("3:noop:set-no-value") },
  { id: "E0e", src: "25e §0", what: "{x:-0, y:NaN, z:1e400} as values (in memory: a translator or tamper)",
    base: () => run(() => base.fold([bGen, bst(1, "create", { id: "a", components: { p: { x: -0, y: NaN, z: Infinity } } })]).entities.a.c.p), baseBad: (r) => r.ok,
    now: () => fold([parseLine(L(GEN)), parseLine(act), { world: WID, kind: "change", ts: 1, actor: "olive", cause: 1, verb: "create", body: { id: "a" } },
      { world: WID, kind: "change", ts: 1, actor: "olive", cause: 1, verb: "set", body: { id: "a", comp: "p", value: { x: -0, y: NaN, z: Infinity } } }]),
    nowGood: (s) => codes(s).some((c) => /^3:malformed:ijson-(negzero|nonfinite)$/.test(c)) && s.entities.a.c.p === undefined },
  { id: "H4f", src: "25d H4, PROTOCOL §2.3", what: "delete {id:'@world'} (bricks every right)",
    base: () => run(() => keys(base.fold([bGen, bst(1, "create", { id: "@world", components: { "roles:olive": { role: "owner" } } }), bst(2, "delete", { id: "@world" })]).entities)),
    baseBad: (r) => r.ok && !r.v.includes("@world"),
    now: () => now(logOf(st("set", { id: "@world", comp: "roles:olive", value: { role: "owner" } }), st("delete", { id: "@world" }))),
    nowGood: (s) => s.entities?.["@world"]?.c["roles:olive"]?.role === "owner" && codes(s).includes("3:noop:delete-@world") },
  { id: "H3i", src: "25d H3 (fix a)", what: "a batch inside a batch, two deep (no depth trick)",
    base: () => run(() => keys(base.fold([bGen, bst(1, "batch", { ops: [{ verb: "batch", args: { ops: [{ verb: "create", args: { id: "inner", components: {} } }] } }] })]).entities)),
    baseBad: (r) => r.ok && r.v.includes("inner"),
    now: () => now(logOf(st("batch", { ops: [{ verb: "batch", ops: [{ verb: "create", id: "inner" }] }] }))), nowGood: (s) => codes(s).includes("2:malformed:nested-batch") && !s.entities.inner },
  { id: "H3j", src: "25d H3, 25e §0", what: "a VALUE holding a `__proto__` key: kept as plain data, never a prototype",
    base: () => run(() => { const s = baseText([bGen, bst(1, "create", { id: "a", components: {} })].map(L).join("\n") + '\n{"kind":"change","actor":"olive","cause":1,"verb":"set","args":{"id":"a","component":"x","value":{"__proto__":{"pinned":true}}},"seq":2}');
      const v = s.entities.a.c.x; return { own: Object.keys(v), inherited: v.pinned }; }),
    baseBad: () => false, // JSON.parse keeps it as an own key; the baseline holds here (25d "tried, held")
    now: () => now(logOf(st("create", { id: "a" })) + `{"world":"${WID}","kind":"change","ts":1,"actor":"olive","cause":1,"verb":"set","body":{"id":"a","comp":"x","value":{"__proto__":{"pinned":true}}}}\n`),
    nowGood: (s) => JSON.stringify(s.entities.a.c.x) === '{"__proto__":{"pinned":true}}' && s.entities.a.c.x.pinned === undefined, held: true },
  { id: "S23", src: "PROTOCOL §2.3", what: "a state op on `body:<identity>` (bodies are presence)",
    base: () => run(() => keys(base.fold([bGen, bst(1, "create", { id: "body:vic", components: {} })]).entities)), baseBad: (r) => r.ok && r.v.includes("body:vic"),
    now: () => now(logOf(st("create", { id: "body:vic" }))), nowGood: (s) => codes(s).includes("2:malformed:entity-id") },
  { id: "S24", src: "PLAN-sockets-entities §3", what: "a hand-written line in the old spelling (a host's sockets map, a thing on parent {to, socket}) folds as written, and the load lifts it",
    base: () => ({ ok: true, v: "(the lift is the engine's)" }), held: true,
    now: () => { const text = logOf(st("batch", { ops: [{ verb: "create", id: "chair" }, { verb: "set", id: "chair", comp: "sockets", value: { seat: { pos: [0, 0.5, 0], body: { action: "sit" } } } },
      { verb: "create", id: "cat" }, { verb: "set", id: "cat", comp: "parent", value: { to: "chair", socket: "seat" } }, { verb: "set", id: "cat", comp: "transform", value: { pos: [0, 0.5, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } }] }));
      const s0 = now(text); const lines = []; const w = AU.worldOf({ name: "h", entries: readLog(text).map(AU.posAt), getBlob: () => { throw new Error(); }, putBlob: () => "", writeLine: (l) => lines.push(l), now: () => 10 });
      AU.maintain(w); const s1 = now(text + lines.map((l) => l + "\n").join("")); return { s0, s1, s: s1 }; },
    nowGood: (r) => r.s0.status === "ok" && !!r.s0.entities.chair.c.sockets && r.s1.status === "ok" && !r.s1.entities.chair.c.sockets && Object.values(r.s1.entities).some((e) => e.c.socket?.name === "seat" && e.c.parent?.to === "chair")
      && r.s1.entities[r.s1.entities.cat.c.parent?.to]?.c.socket?.name === "seat" && !("socket" in r.s1.entities.cat.c.parent) },
  // review of #260: regression guards for the fold's copy, its op table and the engine check
  { id: "R117", src: "review of #260", what: "cloneState keeps a purged value the PURGED sentinel (wireState and the digest read it by identity)",
    base: () => ({ ok: true, v: "(no cloneState in the baseline)" }), held: true,
    now: () => { const s = now(logOf(st("create", { id: "a" }), st("set", { id: "a", comp: "x", value: 1 }))); s.entities.a.c.x = PURGED; return cloneState(s); },
    nowGood: (s) => s.entities.a.c.x === PURGED },
  { id: "R118", src: "review of #260", what: "a change whose verb is `constructor` (an inherited name of the op table) is diagnosed, not thrown",
    base: () => ({ ok: true, v: "(the baseline has no op table)" }), held: true,
    now: () => now(logOf(st("constructor", { id: "a" }))), nowGood: (s) => s.status === "ok" && codes(s).includes("2:malformed:verb") },
  { id: "R120", src: "review of #260", what: "an engine this build doesn't have, with no build named, isn't carried",
    base: () => ({ ok: true, v: "(the baseline has no engines)" }), held: true,
    now: () => ({ unknown: carried({ engine: "no-such-engine" }), toString: carried({ engine: "toString" }) }),
    nowGood: (r) => r.unknown === false && r.toString === false },
  // review of #260: a script's no-op elision meets a set with no value (the fold's own no-op, noop:set-no-value)
  { id: "R173", src: "review of #260", what: "elide passes a set without value on to the gate instead of throwing on jcs(undefined)",
    base: () => ({ ok: true, v: "(the baseline has no elision)" }), held: true,
    now: () => { const s = now(logOf(st("create", { id: "a" }), st("set", { id: "a", comp: "x", value: 1 })));
      try { return { ops: elide(s, [{ verb: "set", id: "a", comp: "x" }]).length }; } catch (e) { return { threw: String(e) }; } },
    nowGood: (r) => r.ops === 1 },
  // review of #260: requests.js promises a transform is always written whole
  { id: "R228", src: "review of #260", what: "a create whose transform comes among its components still writes the whole transform",
    base: () => ({ ok: true, v: "(the baseline has no request builders)" }), held: true,
    now: () => createRequest(null, { components: { transform: { pos: [1, 2, 3] } } }).args.components.transform,
    nowGood: (t) => JSON.stringify(t) === JSON.stringify({ pos: [1, 2, 3], q: [0, 0, 0, 1], scale: [1, 1, 1] }) },
  // house 6340433633 (corrected 6343218893): the builder turned a malformed transform into a valid one at the origin, which
  // the authority then took. Absent fields still default; a malformed one goes through as it is, for the authority to refuse
  { id: "R228b", src: "house 6340433633", what: "a create whose transform is malformed (an array, a non-finite pos) is passed on as it is, never turned into the origin", held: false,
    base: () => ({ ok: true, v: "(the baseline has no request builders)" }),
    now: () => ({ arr: createRequest(null, { components: { transform: [1, 0, 2] } }).args.components.transform,
      arg: createRequest(null, { transform: [1, 0, 2] }).args.components.transform,
      pos: createRequest(null, { components: { transform: { pos: ["x", 0, 0] } } }).args.components.transform,
      absent: createRequest(null, { components: { transform: { q: [0, 0, 0, 1] } } }).args.components.transform }),
    nowGood: (r) => JSON.stringify(r.arr) === "[1,0,2]" && JSON.stringify(r.arg) === "[1,0,2]" && JSON.stringify(r.pos?.pos) === '["x",0,0]'
      && JSON.stringify(r.absent) === JSON.stringify({ pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }) },
  // review of #260: a timed grant past its end that the sweep hasn't removed yet is shown ended, and isn't listed at a clock
  { id: "R194", src: "review of #260", what: "a grant past its end reads 'ended' (not '1 min left'), and listedIn with a clock doesn't list it",
    base: () => ({ ok: true, v: "(the baseline has no timed grants)" }), held: true,
    now: () => ({ words: leftWords(1000, 61000), listed: listedIn({ "roles:u-a": { role: "builder", until: 1000 } }, "u-a", 61000) }),
    nowGood: (r) => r.words === "ended" && r.listed === false },
  // review of #260: a value stripped to its commit with no purge naming it isn't a purge, and reads as unknown
  { id: "RI1a", src: "review of #260", what: "a roles: value stripped to its commit, with no purge, folds as unknown: the fold flags it commit-unpurged", held: true,
    base: () => ({ ok: true, v: "(not in the baseline)" }),
    now: () => now(logOf(st("set", { id: "@world", comp: "roles:u-bbbbbbbbbbbbbbbbbbbb", value: { role: "owner" } }), st("set", { id: "@world", comp: "roles:u-bbbbbbbbbbbbbbbbbbbb", commit: "0".repeat(64) }))),
    nowGood: (s) => s.entities?.["@world"]?.c["roles:u-bbbbbbbbbbbbbbbbbbbb"]?.role !== "owner" && codes(s).includes("3:commit-unpurged") },
  { id: "RI1b", src: "review of #260", what: "…nor with a purge aimed at it that the fold refuses (a roles: value is never purged)", held: true,
    base: () => ({ ok: true, v: "(not in the baseline)" }),
    now: () => now(logOf(st("set", { id: "@world", comp: "roles:u-bbbbbbbbbbbbbbbbbbbb", value: { role: "owner" } }), st("set", { id: "@world", comp: "roles:u-bbbbbbbbbbbbbbbbbbbb", commit: "0".repeat(64) }),
      L({ world: WID, kind: "purge", ts: 1, actor: "system", verb: "purge", body: { values: [{ seq: 3 }] } }))),
    nowGood: (s) => s.entities?.["@world"]?.c["roles:u-bbbbbbbbbbbbbbbbbbbb"]?.role !== "owner" && codes(s).includes("3:commit-unpurged") },
  { id: "RI1c", src: "review of #260", what: "…while a value a valid purge names folds as absent(purged), status ok, with no such diagnostic", held: true,
    base: () => ({ ok: true, v: "(not in the baseline)" }),
    now: () => now(logOf(st("create", { id: "a" }), st("set", { id: "a", comp: "label", commit: "0".repeat(64) }), L({ world: WID, kind: "purge", ts: 1, actor: "system", verb: "purge", body: { values: [{ seq: 3 }] } }))),
    nowGood: (s) => s.status === "ok" && s.entities.a.c.label === PURGED && !codes(s).some((c) => c.includes("commit-unpurged")) },
];

let bad = 0;
for (const p of probes) {
  const b = base ? p.base() : { ok: true, v: "(control skipped)" }; const n = p.now();
  const baseIsBad = !base || p.held ? true : !!p.baseBad(b); let nowIsGood; try { nowIsGood = !!p.nowGood(n); } catch { nowIsGood = false; }
  if (!baseIsBad || !nowIsGood) bad++;
  const shownNow = n?.diagnostics ? `${n.status} ${codes(n).filter((c) => !/:purge$/.test(c)).join(" ")}` : JSON.stringify(n?.s ? { status: n.s.status, codes: codes(n.s) } : n);
  console.log(`${baseIsBad && nowIsGood ? "ok  " : "FAIL"} ${p.id.padEnd(4)} ${p.what}\n       baseline: ${b.ok === false ? b.err : JSON.stringify(b.v)}${baseIsBad ? "" : "   <- NOT bad on baseline"}\n       now:      ${shownNow.slice(0, 200)}${nowIsGood ? "" : "   <- NOT good now"}`);
  if (verbose && n?.entities) console.log("       digest", digest(n));
}
fs.rmSync(root, { recursive: true, force: true });
console.log(controlNote());
console.log(`${probes.length} probes (${probes.filter((p) => p.held).length} a regression guard where the baseline already held): ${probes.length - bad} pass, ${bad} fail`);
process.exit(bad ? 1 : 0);
