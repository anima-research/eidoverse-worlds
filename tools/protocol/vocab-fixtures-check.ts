// tools/protocol/vocab-fixtures-check.ts — docs/DESIGN-log-vocabulary.md §5: the fixtures that live outside the conformance logs
// (F1–F3, F8, F14 are spec/conformance/test_reader.py's; F6, F9 test_story.py's; the chain's F9 test_chain.py's).
//   F4  a physics checkpoint: body `seq` (was `at`); a checkpoint carrying `at` is skipped as malformed, never booted from
//   F5  a redaction entry resyncs a live client; the wire marker is `{redacted: true}` (an old `{purged: true}` cell is no redaction)
//   F7  replica.adopt refuses an unknown {dialect, v} whole: status unknown-version, no state (the live wire's D1)
//   F10 the v1 translator writes this vocabulary directly: the new kinds, no verb on genesis or says, no `by`, no actor `world`, no minor
//   F12 a checkpoint blob written as `snapshotJson` boots the engine; one keyed `cutJson` (the old spelling, read no more: S6 11-05) is skipped; new writes carry snapshotJson only
//   F20 a reader given the next v returns unknown-version: no world, nothing folded or cached; a stray minor is malformed (Mica 11-04)
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/vocab-fixtures-check.ts
// @ts-nocheck
import "./fixture-ids.ts";
import fs from "node:fs";
import path from "node:path";
import { scratch, ENGINE } from "./common.ts";

const root = scratch("vocab-fx"); const W = path.join(root, "worlds");
Object.assign(process.env, { WORLDS_DIR: W, BACKUPS_DIR: path.join(root, "backups"), OPT_DIR: path.join(root, "opt"), SKIP_OPT_SWEEP: "1" });
const F = await import("../../shared/protocol/fold.js"); const { readLog, fold, digest, REDACTED, VERSION } = F;
const { makeReplica, wireState, stateFromWire, snapshotVersion, clientSnapshotOf } = await import("../../shared/protocol/replica.js");
const { request, settle, checkpointNow } = await import("../../shared/protocol/authority.js");
const { simSnapshotOf, digestOf, simFold } = await import("../../shared/protocol/simlayer.js");
const { openLive } = await import("./labhost.ts");
const { translate } = await import("./import-v1/translate-v1.js");

let pass = 0, fail = 0;
const ok = (cond, what, detail?) => { if (cond) { pass++; console.log(`ok   ${what}`); } else { fail++; console.log(`FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const read = (p) => readLog(fs.readFileSync(p));

// ---- F20 (Mica 11-04): a reader given the next v returns unknown-version: no usable world, no entry folded or cached ----
{ const C = path.join(ENGINE, "spec/conformance"); const exp = JSON.parse(fs.readFileSync(path.join(C, "expected.json"), "utf8"));
  const L = read(path.join(C, "EXAMPLE-01.jsonl")); const v5 = [{ ...L[0], body: { ...L[0].body, v: VERSION + 1 } }, ...L.slice(1)];
  const st = fold(v5), acc = F.acceptedEntries(v5);
  ok(st.status === "unknown-version" && st.entities === null && acc.length === 0 && st.diagnostics.length === 1 && st.diagnostics[0][1] === "unknown-version",
    "F20 a reader given a log at the next v: unknown-version, no world, no entry folded (the fold's one diagnostic is the version) and nothing accepted to cache", { status: st.status, acc: acc.length, d: st.diagnostics });
  const stray = [{ ...L[0], body: { ...L[0].body, minor: 1 } }, ...L.slice(1)]; const s2 = fold(stray);
  ok(s2.status === "no-world" && s2.entities === null && s2.diagnostics.some(([q, c]) => q === 0 && c === "malformed:genesis-field"), "F20 …and a genesis carrying a minor is malformed (there is none): no world", s2.diagnostics);
  const files = fs.readdirSync(path.join(C, "logs")).map((f) => `logs/${f}`);
  const fresh = files.filter((f) => exp[f]).filter((f) => { const s = fold(read(path.join(C, f))); const e = exp[f]; return !(s.status === e.status && (s.status !== "ok" || digest(s) === e.digest)); });
  ok(!fresh.length, "F20 …and this branch's reader folds each conformance log to its pinned status and digest", fresh); }

// ---- F7: the live wire's version gate ----
{ const st = fold(read(path.join(ENGINE, "spec/conformance/EXAMPLE-01.jsonl")));
  const good = { ...snapshotVersion(), state: wireState(st), seq: 5, world: st.worldId, physics: null, actor: "alice" };
  const a = makeReplica(); const took = a.adopt(good);
  ok(took === true && a.active && a.status === "ok" && a.seq === 5 && a.world === st.worldId && a.you === "alice" && digest(a.st) === digest(st), "F7 (control) a snapshot carrying this reader's {dialect, v} is adopted: the fold, its seq, the world id, the actor", { took, status: a.status });
  for (const [what, snap] of [["v 5", { ...good, v: 5 }], ["v 3", { ...good, v: 3 }], ["no v", (({ v: _v, ...r }) => r)(good)], ["another dialect", { ...good, dialect: "some-other-log" }], ["the old nested shape", { cut: good }]]) {
    const r = makeReplica(); const t = r.adopt(snap);
    ok(t === false && !r.active && r.status === "unknown-version" && r.st === null && r.seq === -1, `F7 a snapshot with ${what} is refused whole: unknown-version, no state, nothing folded`, { t, status: r.status, active: r.active }); }
  ok(!("minor" in snapshotVersion()) && !("MINORS" in F), "F7 there is no minor: the snapshot's version is {dialect, v}, and the fold exports no MINORS", snapshotVersion()); }

// ---- F5: a redaction resyncs a live client; the wire marker is redacted ----
{ const st = fold(read(path.join(ENGINE, "spec/conformance/logs/09-redaction.jsonl")));
  const w = wireState(st); const cells = Object.values(w).flatMap((e) => Object.values(e.c));
  ok(cells.some((c) => c.redacted === true && !("v" in c)) && !cells.some((c) => "purged" in c), "F5 the wire carries a redacted value as {redacted: true} (never purged)", cells);
  const back = stateFromWire(w); ok(digest(back) === digest(st) && Object.values(back.entities).some((e) => Object.values(e.c).includes(REDACTED)), "F5 …and a client folds it back to the same digest, the sentinel restored", { a: digest(back), b: digest(st) });
  const oldMarker = JSON.parse(JSON.stringify(w).replace(/"redacted":true/g, '"purged":true'));
  let dOld; try { dOld = digest(stateFromWire(oldMarker)); } catch (x) { dOld = `threw ${x?.constructor?.name}`; }
  ok(dOld !== digest(st), "F5 mutation: an old {purged: true} cell is no redaction to this reader (no value, no sentinel: the digest never agrees)", { a: dOld, b: digest(st) });
  const r = makeReplica(); r.adopt({ ...snapshotVersion(), state: w, seq: 9, world: st.worldId, physics: null });
  const red = { world: st.worldId, kind: "redaction", ts: 2, actor: "system", body: { values: [{ seq: 3 }] } };
  const ing = r.ingest([red], 10, {}); ok(ing.resync === true && ing.why === "redaction", "F5 a live client resyncs on a redaction entry (retroactive by law, L1)", ing);
  const r2 = makeReplica(); r2.adopt({ ...snapshotVersion(), state: w, seq: 9, world: st.worldId, physics: null });
  const ing2 = r2.ingest([{ ...red, kind: "purge" }], 10, {}); ok(ing2.resync === false && r2.seq === 10 && !ing2.changed, "F5 mutation: the old kind `purge` is no redaction: a malformed line, folded past (status ok, nothing resynced): only the kind rename makes F5 hold", ing2); }

// ---- F10: the translator writes this vocabulary ----
{ const v1 = fs.readFileSync(path.join(ENGINE, "spec/fixtures/01-build/log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const r = translate(v1, { foldBuild: "x" }); const out = r.out; const g = out[0];
  const text = out.map((e) => JSON.stringify(e)).join("\n") + "\n"; const st = fold(readLog(text));
  const KINDS = new Set(["genesis", "change", "request", "physics", "say", "redaction", "governance"]);
  ok(g.kind === "genesis" && !("minor" in g.body) && !("verb" in g) && !("op" in g), "F10 the translated genesis carries no minor and no verb", g);
  ok(out.every((e) => KINDS.has(e.kind)) && out.filter((e) => e.kind === "say").every((e) => !("verb" in e)) && out.filter((e) => e.kind === "change").every((e) => typeof e.op === "string" && !("verb" in e)) && out.filter((e) => e.kind === "request").every((e) => typeof e.verb === "string" && !("op" in e)),
    "F10 every translated entry wears this vocabulary's kind: op on changes, verb on requests, neither on says", out.map((e) => [e.kind, e.op ?? e.verb ?? null]).slice(0, 12));
  ok(!out.some((e) => "by" in e || "for" in e || "grant" in e) && !out.some((e) => e.actor === "world") && out.some((e) => e.kind === "request" && e.verb === "imported" && typeof e.body?.verb === "string"), "F10 no envelope by/for/grant, no actor `world`; the v1 verb rides in the imported request's body", out.filter((e) => e.actor === "world").length);
  ok(st.status === "ok" && !st.diagnostics.some(([, c]) => String(c).startsWith("malformed")), "F10 the reader folds the translation clean", st.diagnostics.slice(0, 5));
  { const withMinor = readLog(text); withMinor[0] = { ...withMinor[0], body: { ...withMinor[0].body, minor: 1 } };
    ok(fold(withMinor).status === "no-world", "F10 mutation: a translator writing a minor would be refused by the reader (no world)"); } }

// ---- F4 + F12: checkpoints ----
{ const TICK = 33; let T = 1800000000000;
  const opts = (extra = {}) => ({ now: () => T, custodyFile: path.join(W, ".custody.json"), nameOf: () => null, kindOf: () => "human", scripts: null, ...extra });
  const world = (name) => { const dir = path.join(W, name); fs.mkdirSync(dir, { recursive: true }); const w = openLive(dir, name, opts());
    const call = (verb, args = {}) => { T += 100; return request(w, "rowan", verb, args); };
    call("create-world", { title: name }); call("set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0", tickMs: TICK } });
    for (let i = 0; i < 3; i++) call("create", { id: `cr-${i}`, model: "crate", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [i * 2, 3] } });
    for (let k = 0; k < 400 && Object.values(w.simPeek().sim?.bodies ?? {}).some((b) => !b.resting); k++) { T += TICK; settle(w); }
    return { dir, w, call }; };
  const isCk = (e) => e?.kind === "physics" && e.verb === "checkpoint";
  const blobOf = (dir, h) => JSON.parse(fs.readFileSync(path.join(dir, "blobs", `${String(h).replace(/[^a-z0-9]/g, "-")}.json`), "utf8"));
  const reopen = (dir) => openLive(dir, path.basename(dir), opts());
  { const x = world("ck"); x.call("set", { id: "cr-0", component: "label", value: "a" }); T += TICK; settle(x.w); const n = checkpointNow(x.w, { every: 1 });
    const ck = x.w.entries.find(isCk); const blob = ck && blobOf(x.dir, ck.body.state);
    ok(n === 1 && ck && ck.body.seq === x.w.entries.indexOf(ck) - 1 && !("at" in ck.body) && typeof ck.body.sim === "string", "F4 a checkpoint the authority writes names its position as body.seq (the sim-layer digest stays `sim`)", ck?.body);
    ok(blob && typeof blob.snapshotJson === "string" && !("cutJson" in blob), "F12 …and its blob is written as snapshotJson, never cutJson", blob && Object.keys(blob));
    const b = reopen(x.dir); ok(b.bootedFrom === x.w.entries.indexOf(ck), "F4 (control) a boot resumes from it", { from: b.bootedFrom });
    // mutation F4: the old spelling `at` in the body
    const sf = x.w.sim(); const cut = simSnapshotOf(sf, x.w.entries); cut.clock = null; cut.sim.tick = null; const state = x.w.putBlob({ snapshotJson: JSON.stringify(cut) });
    const s2 = x.w.append({ kind: "physics", actor: "sim", verb: "checkpoint", body: { at: x.w.entries.length - 1, engine: { engine: sf.spec.engine }, tick: sf.sim.tick, clock: sf.clock, sim: digestOf(sf.sim), state } });
    const b2 = reopen(x.dir);
    ok(b2.bootedFrom !== s2 && b2.bootedFrom === x.w.entries.indexOf(ck), "F4 mutation: a checkpoint carrying `at` is 'checkpoint at N malformed; skipped' (livehost.ts:136): the boot resumes from the last well-formed one instead", { from: b2.bootedFrom, s2 }); }
  { const x = world("dual"); x.call("set", { id: "cr-1", component: "label", value: "b" }); T += TICK; settle(x.w);
    const sf = x.w.sim(); const cut = simSnapshotOf(sf, x.w.entries); cut.clock = null; cut.sim.tick = null;
    const old = x.w.putBlob({ cutJson: JSON.stringify(cut) });   // the old key: no reader reads it since S6 (11-05)
    const sA = x.w.append({ kind: "physics", actor: "sim", verb: "checkpoint", body: { seq: x.w.entries.length - 1, engine: { engine: sf.spec.engine }, tick: sf.sim.tick, clock: sf.clock, sim: digestOf(sf.sim), state: old } });
    const bA = reopen(x.dir); const dA = digestOf(bA.sim().sim), dGA = digestOf(simFold(bA.entries, bA.now(), { models: {} }).sim);
    x.call("set", { id: "cr-1", component: "label", value: "c" }); T += TICK; settle(x.w);
    const sf2 = x.w.sim(); const cut2 = simSnapshotOf(sf2, x.w.entries); cut2.clock = null; cut2.sim.tick = null; const nu = x.w.putBlob({ snapshotJson: JSON.stringify(cut2) });
    const sB = x.w.append({ kind: "physics", actor: "sim", verb: "checkpoint", body: { seq: x.w.entries.length - 1, engine: { engine: sf2.spec.engine }, tick: sf2.sim.tick, clock: sf2.clock, sim: digestOf(sf2.sim), state: nu } });
    const bB = reopen(x.dir); const dB = digestOf(bB.sim().sim); const dG = digestOf(simFold(bB.entries, bB.now(), { models: {} }).sim);
    ok(bA.bootedFrom !== sA && bB.bootedFrom === sB && dA === dGA && dB === dG, "F12 a blob keyed cutJson (the old spelling) is skipped, never booted from (the boot still reaches the from-genesis fold's digest); one with snapshotJson boots the physics layer to it", { a: bA.bootedFrom, sA, b: bB.bootedFrom, sB, dA, dGA, dB, dG }); } }

console.log(`[vocab-fixtures-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
