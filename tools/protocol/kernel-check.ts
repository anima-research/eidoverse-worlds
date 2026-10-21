// tools/protocol/kernel-check.ts — the kernel is trial-kernel (reviewer item 5, 2026-10-18): a change to the log envelope, the
// kinds, the fold's operations, the identity grammar, the version, transform, parent, model, roles or access (each as its
// component shape; the ladder's vocabulary is the registry's since recut C11) is IMPOSSIBLE to land unless the same
// change carries (a) a translator change, (b) a REGISTRY-CHANGELOG.md line and (c) vectors an old reader refuses and the new
// reader folds. shared/protocol/kernelspec.js is the pure half; spec/kernel-pin.json the pin.
//   bun tools/protocol/kernel-check.ts                         the gate's check (CORE lane)
//   bun tools/protocol/kernel-check.ts --pin                   re-pin an unchanged kernel (companions kept) — a no-op when nothing moved
//   bun tools/protocol/kernel-check.ts --pin --ack "<why>" --vectors <dir> [--translator <step>] [--base <commit>]
//                                                              re-pin a CHANGED kernel: refused unless every companion is present and
//                                                              the vectors run red on the old reader (snapshotted from git at --base,
//                                                              default: the commit that last pinned) and green on the new
//   bun tools/protocol/kernel-check.ts --pin --ack "<why>"     a SCOPE EXTENSION only (10-18: model, roles, access joined the kernel):
//                                                              every change is a kernel component entering the pin with the shape
//                                                              spec/registry-pin.json already pinned for it; no byte changes meaning, so
//                                                              no translator or vectors are asked; the ack is, and the pin records the names
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
  if (!fs.existsSync(f)) return { ran: null, why: `${path.relative(T, f).split(path.sep).join("/")} is missing` };
  if (!fs.existsSync(path.join(d, "old-fold.js"))) return { ran: null, why: `${path.relative(T, d).split(path.sep).join("/")}/old-fold.js (the old reader's snapshot) is missing` };
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

/** A scope trim (recut C11): kernel components whose `grammar` left. Each leaving key is HELD when spec/registry-pin.json keeps the
 *  same value as `<name>.vocab.<key>` (so re-pin the registry first), or DROPPED by a repeatable --drop "<name>.<key>=<why>". */
function trimOf(now: any, rp: any) {
  if (!pin) return {}; const leaving = KS.KERNEL_COMPONENTS.filter((n: string) => pin.kernel[n]?.grammar && !now[n]?.grammar); if (!leaving.length) return {};
  const held: Record<string, string[]> = {}, dropped: Record<string, string> = {};
  for (const n of leaving) for (const k of Object.keys(pin.kernel[n].grammar)) if (rp[n]?.vocab && JSON.stringify(rp[n].vocab[k]) === JSON.stringify(pin.kernel[n].grammar[k])) (held[n] ??= []).push(k);
  argv.forEach((a, i) => { if (a === "--drop") { const m = /^([a-z][a-z0-9-]*\.[A-Za-z]+)=(.+)$/s.exec(argv[i + 1] ?? ""); if (m) dropped[m[1]] = m[2]; } });
  return { trim: { held, dropped } };
}

if (argv.includes("--pin")) {
  const now = KS.kernelPinOf();
  const base = opt("base") ?? (spawnSync("git", ["-C", T, "log", "-1", "--format=%H", "--", PIN], { encoding: "utf8" }).stdout.trim() || "HEAD");
  const vdir = opt("vectors"); let vectors = null;
  if (vdir) { if (!fs.existsSync(path.join(T, VECTORS, vdir, "old-fold.js"))) snapshotOldReader(vdir, base); const r = await runVectors(vdir); if (r.why) { console.log(`refusing to re-pin: ${r.why}`); process.exit(1); } vectors = { dir: vdir, ran: r.ran }; }
  // a scope extension: names entering the kernel whose checkable shape (status aside) is exactly what the registry pin holds
  const rp = JSON.parse(read("spec/registry-pin.json")); const noStatus = (x: any) => { const { status: _s, grammar: _g, vocab: _v, ...rest } = x ?? {}; return JSON.stringify(rest); };
  const entering = pin ? KS.kernelDiff(pin.kernel, now).map((d: string) => /^([a-z][a-z0-9-]*): absent → /.exec(d)?.[1]).filter((n: any) => n && KS.KERNEL_COMPONENTS.includes(n) && rp[n] && noStatus(rp[n]) === noStatus(now[n])) : [];
  const companions = { ack: opt("ack") ?? null, translator: { from: pin?.companions?.translator?.to ?? pin?.translator ?? null, to: TV1.TRANSLATOR, ...(opt("translator") ? { step: opt("translator") } : {}) }, vectors,
    ...(entering.length && !vdir ? { scope: { names: entering, registryPinned: true } } : {}), ...trimOf(now, rp) };
  const v = KS.kernelVerdict(pin, now, companions);
  if (!v.ok) { console.log("refusing to re-pin: " + v.why); process.exit(1); }
  if (v.changelog) { fs.appendFileSync(path.join(T, CHANGELOG), v.changelog); console.log(`${CHANGELOG}: kernel line written (${v.diff.length} change(s)${v.scopeOnly ? `; a scope extension: ${v.companions.scope.names.join(", ")} entered the kernel with the registry's pinned shape, so no translator or vectors` : ""}${v.trimOnly ? "; a scope trim: grammar left the kernel, each key held by the registry pin or dropped with a why, so no translator or vectors" : ""})`); }
  const out = { status: KS.TRIAL_KERNEL, translator: TV1.TRANSLATOR, companions: v.companions ?? null, kernel: now };
  fs.writeFileSync(path.join(T, PIN), JSON.stringify(out, null, 1) + "\n"); console.log(`${PIN} written${v.diff.length ? ` over ${v.diff.length} change(s), companions recorded` : " (unchanged kernel)"}`); process.exit(0);
}

let pass = 0, fail = 0;
const ok = (id: string, cond: any, what: string, detail?: any) => { if (cond) { pass++; console.log(`  ok ${id} ${what}`); } else { fail++; console.log(`  FAIL ${id} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 700)}` : ""}`); } };
const C = async (id: string, what: string, fn: () => any) => { try { const r = await fn(); if (Array.isArray(r)) ok(id, r[0], what, r[1]); else ok(id, r, what); } catch (e) { ok(id, false, what, `threw: ${e?.stack ?? e}`); } };

await C("K1", "the kernel's shapes carry status trial-kernel: envelope, fold, identity, version, transform, parent, model, roles, access (kernelPinOf; reviewer item 5's nine); roles and access carry their COMPONENT shape only (recut C11: the ladder's vocabulary is the registry's, as roles.vocab; the doors are client presets); the registry says what it means (STATUSES, statusOf)", () => {
  const p = KS.kernelPinOf(); const names = [...KS.KERNEL_SHAPES, ...KS.KERNEL_COMPONENTS];
  return [names.every((n) => p[n]?.status === "trial-kernel") && Object.keys(p).length === names.length && names.length === 9 && typeof CAT.STATUSES["trial-kernel"] === "string" && /model, roles, access/.test(CAT.STATUSES["trial-kernel"])
    && ["transform", "parent:x", "model", "roles:u-1", "access"].every((n) => CAT.statusOf(n) === "trial-kernel") && CAT.statusOf("light") === "trial" && CAT.statusOf("default-role") === "trial"
    && p.envelope.fields.includes("actor") && p.envelope.kinds.includes("purge") && p.fold.ops.set.includes("commit") && p.version.v === 4 && p.identity.identity === "[a-z0-9-]{1,64}"
    && p.model.type === "string" && p.roles.fields.until === "int" && !("grammar" in p.roles) && !("vocab" in p.roles) && !("grammar" in p.access) && JSON.stringify(p.access.enums.join) === '["anyone","signed-in","listed"]'
    && CAT.pinOf().roles.vocab?.rank?.owner === 255 && CAT.pinOf().roles.vocab.permissions.includes("grantRoles") && CAT.pinOf().roles.vocab.reserved.includes("banned") && !CAT.pinOf().roles.vocab.reserved.includes("ghost") && !("lockLevels" in CAT.pinOf().roles.vocab),
    Object.fromEntries(names.map((n) => [n, p[n]?.status]))]; });

await C("K2", "the code's kernel is what spec/kernel-pin.json pins (a difference is THE change: red until `kernel-check.ts --pin` with its companions)", () => {
  const d = pin ? KS.kernelDiff(pin.kernel, KS.kernelPinOf()) : ["no pin: bun tools/protocol/kernel-check.ts --pin"]; return [!d.length && pin?.status === "trial-kernel", d.slice(0, 12)]; });

await C("K3", "the pin's recorded companions hold: the changelog line is in REGISTRY-CHANGELOG.md, the translator moved (and is still there), and the vectors still run red on the old reader and green on the new (the initial pin, before any change, records none)", async () => {
  const c = pin?.companions; if (!c) return [pin?.companions === null, "initial pin: no change yet, nothing to verify"];
  const log = read(CHANGELOG); const line = typeof c.changelog === "string" && log.includes(`- ${c.changelog}`);
  // a scope extension recorded (model, roles, access entered 10-18): its names are still the kernel's, in code and in the registry pin
  const rp = JSON.parse(read("spec/registry-pin.json")); const now = KS.kernelPinOf();
  const scope = !c.scope || (Array.isArray(c.scope.names) && c.scope.names.length >= 1 && c.scope.names.every((n: string) => KS.KERNEL_COMPONENTS.includes(n) && now[n]?.status === "trial-kernel" && rp[n]?.status === "trial-kernel" && CAT.statusOf(n) === "trial-kernel"));
  // a kernel CHANGE recorded (translator + vectors): the translator moved at re-pin time, AND is still at least there now (a bump
  // reverted after the re-pin is red); a step names a file that exists; the vectors still run old-red/new-green. A pin whose only
  // recorded change is a scope extension carries none of these (null) and is verified by `scope` alone
  const changed = !!(c.translator || c.vectors);
  const tr = !changed || (KS.translatorN(c.translator?.to) > KS.translatorN(c.translator?.from) && KS.translatorN(TV1.TRANSLATOR) >= KS.translatorN(c.translator?.to)) || (typeof c.translator?.step === "string" && fs.existsSync(path.join(T, c.translator.step)));
  const r = changed ? await runVectors(c.vectors?.dir ?? "") : { ran: null, why: "no kernel change recorded (a scope extension only)" }; const names = (c.vectors?.names ?? []);
  const vec = !changed || (!!r.ran && r.ran.length >= 1 && r.ran.every((x: any) => x.old !== "ok" && x.new === "ok") && names.every((n: string) => r.ran.some((x: any) => x.name === n)));
  // a scope trim recorded (C11): every key it says the registry holds is still in the registry pin's vocab, and still out of the kernel
  // (and every name it trims is still a kernel component: a name leaving the kernel since is a scope change, not this trim)
  const trim = !c.trim || (Object.entries(c.trim.held ?? {}).every(([n, ks]: [string, any]) => KS.KERNEL_COMPONENTS.includes(n) && Array.isArray(ks) && ks.every((k: string) => rp[n]?.vocab && Object.hasOwn(rp[n].vocab, k)) && !now[n]?.grammar)
    && Object.entries(c.trim.dropped ?? {}).every(([k, w]) => KS.KERNEL_COMPONENTS.includes(k.split(".")[0]) && typeof w === "string" && w.trim() && !now[k.split(".")[0]]?.grammar));
  return [line && tr && vec && scope && trim && (changed || !!c.scope || !!c.trim), { line, tr, vec, scope: c.scope ?? null, trim: c.trim ?? null, vectors: r.ran ?? r.why }]; });

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
await C("K10", "the registry pin agrees: transform, parent, model, roles and access are trial-kernel there (each status change acknowledged in the changelog), and pretrans's status rule knows the kernel's five names", () => {
  const rp = JSON.parse(read("spec/registry-pin.json")); const pre = read("tools/protocol/pretrans-check.ts"); const log = read(CHANGELOG);
  return [KS.KERNEL_COMPONENTS.every((n: string) => rp[n]?.status === "trial-kernel") && /KERNEL_COMPONENTS/.test(pre) && /model: status trial → trial-kernel/.test(log) && /roles: status trial → trial-kernel/.test(log) && /access: status trial → trial-kernel/.test(log), Object.fromEntries(KS.KERNEL_COMPONENTS.map((n: string) => [n, rp[n]?.status]))]; });

// ---- the three that joined (reviewer item 5: model, roles, access): a mutated shape of each is a kernel change, red without the companions ----
const mut = (f: (now: any) => void) => { const now = KS.kernelPinOf(); f(now); return now; };
await C("K11", "a mutated model, roles or access SHAPE is a kernel change (model's type, a roles field dropped, access's join enum narrowed: refused without the three companions); the ladder's VOCABULARY is the registry's since C11: a permission dropped, a reserved id freed, a rank moved, each is a registry break (pinBreaks) refused a re-pin without --ack, and NOT a kernel diff", () => {
  const ms: [string, any][] = [["model.type", mut((n) => { n.model.type = "object"; })], ["roles.fields.until", mut((n) => { delete n.roles.fields.until; })], ["access.enums.join", mut((n) => { n.access.enums.join = ["anyone", "listed"]; })]];
  const got = ms.map(([at, now]) => { const d = KS.kernelDiff(pinned.kernel, now); const v = KS.kernelVerdict(pinned, now, null); const vs = KS.kernelVerdict(pinned, now, { ack: "x", scope: { names: [at.split(".")[0]], registryPinned: true } });
    return { at, red: d.some((x: string) => x.startsWith(at)) && !v.ok && /translator/.test(v.why) && /--vectors/.test(v.why) && !vs.ok && /translator/.test(vs.why) }; });
  const reg = CAT.pinOf(); const vm = (f: (v: any) => void) => { const n = JSON.parse(JSON.stringify(reg)); f(n.roles.vocab); return n; };
  const vs: [string, any][] = [["permissions", vm((v) => { v.permissions = v.permissions.filter((p: string) => p !== "ban"); })], ["reserved", vm((v) => { v.reserved = v.reserved.filter((p: string) => p !== "banned"); })],
    ["rank", vm((v) => { v.rank.owner = 254; })], ["customId", vm((v) => { v.customId = "^[a-z]{1,8}$"; })]];
  const vgot = vs.map(([k, now]) => { const br = CAT.pinBreaks(reg, now); const bare = CAT.pinVerdict(reg, now, null); const acked = CAT.pinVerdict(reg, now, "x", "2026-10-21");
    return { k, red: br.some((t: string) => t.startsWith(`roles.${k}: vocabulary`)) && !bare.ok && /--ack/.test(bare.why) && acked.ok, kernel: KS.kernelDiff(KS.kernelPinOf(), KS.kernelPinOf()).length === 0 }; });
  return [got.every((g) => g.red) && vgot.every((g) => g.red && g.kernel), { got, vgot }]; });
await C("K12", "the scope path is not a loophole: a kernel component ENTERING the pin with the registry's shape re-pins on the ack alone (scope recorded, no translator/vectors asked), but entering with a changed shape, entering a name that isn't the kernel's, or a scope that doesn't name every entrant, needs all three", () => {
  const base = { kernel: Object.fromEntries(Object.entries(KS.kernelPinOf()).filter(([k]) => k !== "access")), companions: null, translator: TV1.TRANSLATOR };   // a pin from before access joined
  const now = KS.kernelPinOf(); const good = KS.kernelVerdict(base, now, { ack: "test: access joins", scope: { names: ["access"], registryPinned: true } }, "2026-10-18");
  const noAck = KS.kernelVerdict(base, now, { scope: { names: ["access"], registryPinned: true } });
  const unpinned = KS.kernelVerdict(base, now, { ack: "x", scope: { names: ["access"], registryPinned: false } });   // the shape isn't the registry's: a change
  const wrongName = KS.kernelVerdict(base, now, { ack: "x", scope: { names: ["light"], registryPinned: true } });
  const changedToo = KS.kernelVerdict(base, mut((n) => { n.transform.defaults.scale = [2, 2, 2]; }), { ack: "x", scope: { names: ["access"], registryPinned: true } });
  return [good.ok && good.scopeOnly === true && /^- 2026-10-18: kernel: test: access joins\n  - access: absent → \(the registry's pinned shape, now the kernel's\)/.test(good.changelog) && JSON.stringify(good.companions.scope) === '{"names":["access"]}' && good.companions.translator === null
    && !noAck.ok && /scope grew/.test(noAck.why) && /--ack/.test(noAck.why) && !/translator change/.test(noAck.why)
    && [unpinned, wrongName, changedToo].every((v) => !v.ok && /translator change/.test(v.why) && /--vectors/.test(v.why)), { good: good.changelog, noAck: noAck.why?.slice(0, 200), unpinned: unpinned.why?.slice(0, 120) }]; });

await C("K13", "the TRIM path (recut C11) is not a loophole: a kernel component's grammar leaving re-pins on the ack alone only when every leaving key is HELD (the registry pin keeps the same value) or DROPPED with a why; a key neither held nor dropped, a blank why, no ack, a non-kernel name, or any other change alongside, is refused (the last needs all three)", () => {
  const g = { rank: { owner: 255 }, permissions: ["build"], lockLevels: ["owner"] };
  const base = { kernel: { ...KS.kernelPinOf(), roles: { ...KS.kernelPinOf().roles, grammar: g }, access: { ...KS.kernelPinOf().access, grammar: { doors: ["open"] } } }, companions: null, translator: TV1.TRANSLATOR };
  const now = KS.kernelPinOf(); const trim = { held: { roles: ["rank", "permissions"] }, dropped: { "roles.lockLevels": "unread", "access.doors": "client presets" } };
  const good = KS.kernelVerdict(base, now, { ack: "test: grammar leaves", trim }, "2026-10-21");
  const noAck = KS.kernelVerdict(base, now, { trim });
  const unaccounted = KS.kernelVerdict(base, now, { ack: "x", trim: { held: { roles: ["rank"] }, dropped: trim.dropped } });
  const blank = KS.kernelVerdict(base, now, { ack: "x", trim: { held: trim.held, dropped: { "roles.lockLevels": "  ", "access.doors": "x" } } });
  const changedToo = KS.kernelVerdict(base, mut((n) => { n.transform.defaults.scale = [2, 2, 2]; }), { ack: "x", trim });
  const notTrim = KS.kernelVerdict(base, now, { ack: "x" });   // no trim companion: the grammar leaving is an ordinary kernel change
  return [good.ok && good.trimOnly === true && /^- 2026-10-21: kernel: test: grammar leaves\n/.test(good.changelog) && /roles\.permissions: leaves the kernel; the registry pin holds it \(roles\.vocab\.permissions\)/.test(good.changelog) && /access\.doors: leaves every pin: client presets/.test(good.changelog)
    && JSON.stringify(good.companions.trim) === JSON.stringify(trim) && good.companions.translator === null && good.companions.vectors === null
    && !noAck.ok && /--ack/.test(noAck.why) && !/translator change/.test(noAck.why)
    && !unaccounted.ok && /roles\.permissions/.test(unaccounted.why) && !blank.ok && /roles\.lockLevels/.test(blank.why)
    && [changedToo, notTrim].every((v) => !v.ok && /translator change/.test(v.why) && /--vectors/.test(v.why)), { good: good.changelog ?? good.why, unaccounted: unaccounted.why?.slice(0, 160), blank: blank.why?.slice(0, 160) }]; });

console.log(`\nkernel: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
