// tools/protocol/kernel-check.ts — the kernel is trial-kernel (reviewer item 5, 2026-10-18): a change to the log envelope, the
// kinds, the fold's operations, the identity grammar, the version, transform or parent is IMPOSSIBLE to land unless the same
// change carries (a) a translator change, (b) a REGISTRY-CHANGELOG.md line and (c) vectors an old reader refuses and the new
// reader folds. shared/protocol/kernelspec.js is the pure half; spec/kernel-pin.json the pin.
//   bun tools/protocol/kernel-check.ts                         the gate's check (CORE lane)
//   bun tools/protocol/kernel-check.ts --pin                   re-pin an unchanged kernel (companions kept) — a no-op when nothing moved
//   bun tools/protocol/kernel-check.ts --pin --ack "<why>" --vectors <dir> [--translator <step>] [--base <commit>]
//                                                              re-pin a CHANGED kernel: refused unless every companion is present and
//                                                              the vectors run red on the old reader (snapshotted from git at --base,
//                                                              default: the commit that last pinned) and green on the new
// How the check finds "the change": the pin. Code ≠ pin is the change (K2 is red until a re-pin), and a re-pin is this
// command's alone, which refuses without the companions and RECORDS them in the pin; K3 then verifies them at every gate run
// (the changelog line is in the file, the translator moved, the vectors still run old-red/new-green), so dropping a companion
// after the re-pin is red too. Every row here was red before its code.
// Live proof (2026-10-18, on c36fc283): ENVELOPE + "note" → K2 red; `--pin` and `--pin --ack` refused naming the missing
// companions; with TRANSLATOR @14 → @15 and spec/kernel-vectors/proof-note (an act carrying note: old reader
// malformed:unknown-field, new reader ok) the re-pin wrote the `kernel:` changelog line and recorded the companions, and the
// check was 10/10; then the changelog line dropped → K3 red; the translator bump reverted → K3 red; everything reverted → 10/10.
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ENGINE } from "./common.ts";
const T = ENGINE;
const imp = async (p: string) => await import(path.join(T, p));
const KS = await imp("shared/protocol/kernelspec.js"), CAT = await imp("shared/protocol/componentspec.js"), FOLD = await imp("shared/protocol/fold.js");
const TV1 = await imp("tools/protocol/import-v1/translate-v1.js");
const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const read = (p: string) => fs.readFileSync(path.join(T, p), "utf8");
const PIN = "spec/kernel-pin.json", CHANGELOG = "spec/REGISTRY-CHANGELOG.md", VECTORS = "spec/kernel-vectors";
const pin = fs.existsSync(path.join(T, PIN)) ? JSON.parse(read(PIN)) : null;

/** Fold each vector's entries with a reader module: "ok" when it folds to a world with no diagnostics, else the first reason. */
function verdict(F: any, entries: any[]) {
  try { const parsed = F.readLog(entries.map((e: any) => JSON.stringify(e)).join("\n") + "\n"); const st = F.fold(parsed);
    if (st.status !== "ok") return st.status; if (st.diagnostics?.length) return `malformed:${st.diagnostics[0][1]}`.replace(/^malformed:malformed:/, "malformed:"); return "ok"; }
  catch (e) { return `threw: ${e?.code ?? e?.message ?? e}`; }
}
/** Run a vectors dir: {ran: [{name, old, new}], why?}. old-fold.js is the OLD reader's snapshot (beside old-hash.js). */
async function runVectors(dir: string) {
  const d = path.join(T, VECTORS, dir); const f = path.join(d, "vectors.json");
  if (!fs.existsSync(f)) return { ran: null, why: `${path.relative(T, f)} is missing` };
  if (!fs.existsSync(path.join(d, "old-fold.js"))) return { ran: null, why: `${path.relative(T, d)}/old-fold.js (the old reader's snapshot) is missing` };
  const spec = JSON.parse(fs.readFileSync(f, "utf8")); const OLD = await import(path.join(d, "old-fold.js") + `?t=${Date.now()}`);
  const ran = (spec.vectors ?? []).map((v: any) => ({ name: v.name, old: verdict(OLD, v.entries), new: verdict(FOLD, v.entries) }));
  return { ran, why: null };
}
/** The old reader, from git, into the vectors dir (old-fold.js importing ./old-hash.js). */
function snapshotOldReader(dir: string, base: string) {
  const d = path.join(T, VECTORS, dir); fs.mkdirSync(d, { recursive: true });
  // the reader and its two leaves (fold → hash → sha256), their imports rewritten to the snapshot's own names
  for (const [src, dst] of [["shared/protocol/fold.js", "old-fold.js"], ["shared/protocol/hash.js", "old-hash.js"], ["shared/sha256.js", "old-sha256.js"]]) {
    const r = spawnSync("git", ["-C", T, "show", `${base}:${src}`], { encoding: "utf8" }); if (r.status !== 0) throw new Error(`git show ${base}:${src}: ${r.stderr.trim()}`);
    fs.writeFileSync(path.join(d, dst), r.stdout.replace('from "./hash.js"', 'from "./old-hash.js"').replace("from '../sha256.js'", "from './old-sha256.js'")); }
}

if (argv.includes("--pin")) {
  const now = KS.kernelPinOf();
  const base = opt("base") ?? (spawnSync("git", ["-C", T, "log", "-1", "--format=%H", "--", PIN], { encoding: "utf8" }).stdout.trim() || "HEAD");
  const vdir = opt("vectors"); let vectors = null;
  if (vdir) { if (!fs.existsSync(path.join(T, VECTORS, vdir, "old-fold.js"))) snapshotOldReader(vdir, base); const r = await runVectors(vdir); if (r.why) { console.log(`refusing to re-pin: ${r.why}`); process.exit(1); } vectors = { dir: vdir, ran: r.ran }; }
  const companions = { ack: opt("ack") ?? null, translator: { from: pin?.companions?.translator?.to ?? pin?.translator ?? null, to: TV1.TRANSLATOR, ...(opt("translator") ? { step: opt("translator") } : {}) }, vectors };
  const v = KS.kernelVerdict(pin, now, companions);
  if (!v.ok) { console.log("refusing to re-pin: " + v.why); process.exit(1); }
  if (v.changelog) { fs.appendFileSync(path.join(T, CHANGELOG), v.changelog); console.log(`${CHANGELOG}: kernel line written (${v.diff.length} change(s))`); }
  const out = { status: KS.TRIAL_KERNEL, translator: TV1.TRANSLATOR, companions: v.companions ?? null, kernel: now };
  fs.writeFileSync(path.join(T, PIN), JSON.stringify(out, null, 1) + "\n"); console.log(`${PIN} written${v.diff.length ? ` over ${v.diff.length} change(s), companions recorded` : " (unchanged kernel)"}`); process.exit(0);
}

let pass = 0, fail = 0;
const ok = (id: string, cond: any, what: string, detail?: any) => { if (cond) { pass++; console.log(`  ok ${id} ${what}`); } else { fail++; console.log(`  FAIL ${id} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 700)}` : ""}`); } };
const C = async (id: string, what: string, fn: () => any) => { try { const r = await fn(); if (Array.isArray(r)) ok(id, r[0], what, r[1]); else ok(id, r, what); } catch (e) { ok(id, false, what, `threw: ${e?.stack ?? e}`); } };

await C("K1", "the kernel's shapes carry status trial-kernel: envelope, fold, identity, version, transform, parent (kernelPinOf); the registry says what it means (STATUSES, statusOf)", () => {
  const p = KS.kernelPinOf(); const names = ["envelope", "fold", "identity", "version", "transform", "parent"];
  return [names.every((n) => p[n]?.status === "trial-kernel") && Object.keys(p).length === names.length && typeof CAT.STATUSES["trial-kernel"] === "string" && CAT.statusOf("transform") === "trial-kernel" && CAT.statusOf("parent:x") === "trial-kernel" && CAT.statusOf("light") === "trial"
    && p.envelope.fields.includes("actor") && p.envelope.kinds.includes("purge") && p.fold.ops.set.includes("commit") && p.version.v === 4 && p.identity.identity === "[a-z0-9-]{1,64}", Object.fromEntries(names.map((n) => [n, p[n]?.status]))]; });

await C("K2", "the code's kernel is what spec/kernel-pin.json pins (a difference is THE change: red until `kernel-check.ts --pin` with its companions)", () => {
  const d = pin ? KS.kernelDiff(pin.kernel, KS.kernelPinOf()) : ["no pin: bun tools/protocol/kernel-check.ts --pin"]; return [!d.length && pin?.status === "trial-kernel", d.slice(0, 12)]; });

await C("K3", "the pin's recorded companions hold: the changelog line is in REGISTRY-CHANGELOG.md, the translator moved (and is still there), and the vectors still run red on the old reader and green on the new (the initial pin, before any change, records none)", async () => {
  const c = pin?.companions; if (!c) return [pin?.companions === null, "initial pin: no change yet, nothing to verify"];
  const log = read(CHANGELOG); const line = typeof c.changelog === "string" && log.includes(`- ${c.changelog}`);
  // the translator moved at re-pin time, AND is still at least there now (a bump reverted after the re-pin is red); a step names a file that exists
  const tr = (KS.translatorN(c.translator?.to) > KS.translatorN(c.translator?.from) && KS.translatorN(TV1.TRANSLATOR) >= KS.translatorN(c.translator?.to)) || (typeof c.translator?.step === "string" && fs.existsSync(path.join(T, c.translator.step)));
  const r = await runVectors(c.vectors?.dir ?? ""); const names = (c.vectors?.names ?? []);
  const vec = !!r.ran && r.ran.length >= 1 && r.ran.every((x: any) => x.old !== "ok" && x.new === "ok") && names.every((n: string) => r.ran.some((x: any) => x.name === n));
  return [line && tr && vec, { line, tr, vectors: r.ran ?? r.why }]; });

// ---- the verdict itself, on a mutated kernel (the proof the gate carries: red without the companions, green with them) ----
const mutated = () => { const now = KS.kernelPinOf(); now.envelope.fields = [...now.envelope.fields, "note"].sort(); return now; };
const pinned = pin ?? { kernel: KS.kernelPinOf(), companions: null, translator: TV1.TRANSLATOR };
await C("K4", "a kernel shape that changed (an envelope field added) is refused a re-pin with no companions, with an acknowledgement alone, with a translator alone, and with vectors alone; the refusal names each missing companion", () => {
  const good = { ack: "test: a note field", translator: { from: "eidoverse/translate-v1@14", to: "eidoverse/translate-v1@15" }, vectors: { dir: "x", ran: [{ name: "note", old: "malformed:unknown-field", new: "ok" }] } };
  const none = KS.kernelVerdict(pinned, mutated(), null), ackOnly = KS.kernelVerdict(pinned, mutated(), { ack: good.ack });
  const trOnly = KS.kernelVerdict(pinned, mutated(), { translator: good.translator }), vecOnly = KS.kernelVerdict(pinned, mutated(), { vectors: good.vectors });
  const same = KS.kernelVerdict(pinned, mutated(), { ...good, translator: { from: "eidoverse/translate-v1@14", to: "eidoverse/translate-v1@14" } });
  return [[none, ackOnly, trOnly, vecOnly, same].every((v) => !v.ok && v.diff.some((d: string) => /envelope\.fields/.test(d)))
    && /--ack/.test(none.why) && /translator/.test(none.why) && /--vectors/.test(none.why) && !/--ack/.test(ackOnly.why) && /translator/.test(ackOnly.why) && /vectors/.test(ackOnly.why)
    && /--ack/.test(trOnly.why) && !/translator change/.test(trOnly.why) && /--ack/.test(vecOnly.why) && !/--vectors/.test(vecOnly.why) && /translator change/.test(same.why), [none.why, same.why]]; });
await C("K5", "…vectors that prove nothing are refused too: one the old reader still accepts, one the new reader refuses", () => {
  const tr = { from: "eidoverse/translate-v1@14", to: "eidoverse/translate-v1@15" };
  const oldOk = KS.kernelVerdict(pinned, mutated(), { ack: "x", translator: tr, vectors: { dir: "x", ran: [{ name: "a", old: "ok", new: "ok" }] } });
  const newBad = KS.kernelVerdict(pinned, mutated(), { ack: "x", translator: tr, vectors: { dir: "x", ran: [{ name: "b", old: "malformed:unknown-field", new: "malformed:kind" }] } });
  return [!oldOk.ok && /OLD reader still accepts.*\ba\b/.test(oldOk.why) && !newBad.ok && /NEW reader refuses.*\bb\b/.test(newBad.why), [oldOk.why, newBad.why]]; });
await C("K6", "…and with all three (the acknowledgement, a translator that moved, vectors red-then-green) the re-pin is admitted, the changelog line says `kernel:` and lists the change, and the companions are recorded for K3", () => {
  const v = KS.kernelVerdict(pinned, mutated(), { ack: "test: a note field", translator: { from: "eidoverse/translate-v1@14", to: "eidoverse/translate-v1@15" }, vectors: { dir: "x", ran: [{ name: "note", old: "malformed:unknown-field", new: "ok" }] } }, "2026-10-18");
  return [v.ok && /^- 2026-10-18: kernel: test: a note field\n  - envelope\.fields: /.test(v.changelog) && v.companions?.changelog === "2026-10-18: kernel: test: a note field" && v.companions.translator.to === "eidoverse/translate-v1@15" && JSON.stringify(v.companions.vectors) === '{"dir":"x","names":["note"]}', v]; });
await C("K7", "an unchanged kernel re-pins freely and keeps the old companions; a changed transform (the component pin inside the kernel) is a kernel change too", () => {
  const same = KS.kernelVerdict(pinned, KS.kernelPinOf(), null); const now = KS.kernelPinOf(); now.transform.defaults.scale = [2, 2, 2];
  const t = KS.kernelVerdict(pinned, now, null); return [same.ok && !same.diff.length && same.companions === pinned.companions && !t.ok && t.diff.some((d: string) => /transform\.defaults\.scale/.test(d)), [same.diff, t.diff]]; });
await C("K8", "the real readers run as vectors run them: today's fold reads a clean two-entry log as ok, and refuses an envelope field it doesn't know (malformed:unknown-field) — the shape a kernel vector takes", () => {
  const g = { kind: "genesis", actor: "system", verb: "genesis", body: { dialect: "eidoverse-log", v: 4, minor: 0, nonce: "j1783lQSA7cL_W-K6NwvNw", owners: [[]], sequencer: "ed25519:NP1SCq4fthEWnhu_stdrB1gT8wu06eXvKTemf02lqSw" } };
  const wid = FOLD.worldIdOf(g); const a = { world: wid, kind: "act", actor: "olive", verb: "x", ts: 1, body: {} };
  return [verdict(FOLD, [g, a]) === "ok" && verdict(FOLD, [g, { ...a, "zz-no-such-field": 1 }]) === "malformed:unknown-field", [verdict(FOLD, [g, a]), verdict(FOLD, [g, { ...a, "zz-no-such-field": 1 }])]]; });
await C("K9", "the words: §4 of the spec and the ladder doc say what trial-kernel is and what a kernel change must carry; the gate runs this check in its core lane", () => {
  const spec = read("spec/PROTOCOL.md"), ladder = read("docs/COMPONENT-LADDER.md"), run = read("tools/protocol/run.ts");
  const need = ["trial-kernel", "kernel-pin.json", "translator", "REGISTRY-CHANGELOG", "vectors"];
  return [need.every((n) => spec.includes(n)) && need.every((n) => ladder.includes(n)) && /const CORE = \[[^\]]*"kernel"/.test(run), { spec: need.filter((n) => !spec.includes(n)), ladder: need.filter((n) => !ladder.includes(n)) }]; });
await C("K10", "the registry pin agrees: transform and parent are trial-kernel there (the status change was acknowledged in the changelog), and pretrans's status rule knows the kernel's two names", () => {
  const rp = JSON.parse(read("spec/registry-pin.json")); const pre = read("tools/protocol/pretrans-check.ts"); const log = read(CHANGELOG);
  return [rp.transform?.status === "trial-kernel" && rp.parent?.status === "trial-kernel" && /trial-kernel/.test(pre) && /trial-kernel/.test(log), [rp.transform?.status, rp.parent?.status]]; });

console.log(`\nkernel: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
