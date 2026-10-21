// shared/protocol/kernelspec.js — the KERNEL's shapes, pinned (reviewer item 5, 2026-10-18: "trial-kernel… must be impossible
// without same-commit translator + changelog + failing old-reader/new-reader vectors").
//
// The registry (componentspec.js) pins what each COMPONENT means, with statuses trial / reserved / stable. Below those sits
// the kernel: what every reader of every log agrees on before a single component is read. PROTOCOL §1–§3, §9.3, §13:
//   envelope   the entry's fields (§1 "The envelope") and its kinds
//   fold       the four operations and their fields; the batch body (§3)
//   identity   the grammar of an identity, an entity id and a component name (§3.1)
//   version    {dialect, v} and the minors this reader knows (§13; genesis's fields)
//   transform  the one placement component (§9.3: glTF's rule)
//   parent     the one attachment component (§9.3)
//   model      what a thing shows (its library path; §9.3) — reviewer item 5 (10-18): "envelope/fold/identity/version/transform/parent/model/roles/access"
//   roles      who may do what (§7): the component's shape. Its VOCABULARY (ranks, built-in ids, permissions, the custom-id
//              pattern, reserved ids) is the registry's (componentspec roles.vocab), not the kernel's (recut C11: the kernel
//              holds what the fold reads; the ladder is read by the authority, and a registry break still needs --ack)
//   access     who may come in (§7, access.js): the component's shape (the four doors are client presets that write it)
// Each has status `trial-kernel`: like trial it may still change during the alpha, but a change is never a re-pin with an
// acknowledgement. spec/kernel-pin.json holds the pin; tools/protocol/kernel-check.ts (the gate's CORE lane) is red the moment
// the code's kernel differs from the pin, and `kernel-check.ts --pin` re-pins ONLY when the same change brings its three
// companions, which the pin then records and the gate verifies forever after:
//   (a) a translator change: the translator's name moved (tools/protocol/import-v1/translate-v1.js TRANSLATOR @N → @N+1, or a
//       new translate step named with --translator), so a stored log has a path forward;
//   (b) a REGISTRY-CHANGELOG.md line (--ack "<why>"), prefixed `kernel:`, naming what changed and why;
//   (c) vectors (--vectors <dir>): spec/kernel-vectors/<dir>/vectors.json, entries the OLD reader refuses (a snapshot of the
//       old fold, old-fold.js, taken from git at --pin time) and the NEW reader folds clean. The gate RUNS them.
// Pure: this module knows no files; the check does the reading and writing.
import { ENVELOPE, KINDS, IDENT, ENTITY, COMP, OP_FIELDS, BATCH_FIELDS, GENESIS_FIELDS, DIALECT, VERSION, MINORS } from "./fold.js";
import { COMPONENTS, pinOf } from "./componentspec.js";

export const TRIAL_KERNEL = "trial-kernel";
/** The component names that belong to the kernel (their registry status is trial-kernel). */
export const KERNEL_COMPONENTS = Object.freeze(["transform", "parent", "model", "roles", "access"]);
/** The kernel's shapes that aren't components: the pin's other keys. */
export const KERNEL_SHAPES = Object.freeze(["envelope", "fold", "identity", "version"]);

/** The kernel's checkable shape, as the pin stores it. Deterministic (sorted where the source is a set). */
export function kernelPinOf() {
  const reg = pinOf();
  const comp = (name) => { const p = reg[name]; if (!p) return { missing: true }; const { vocab: _v, ...shape } = p; return { ...shape, status: COMPONENTS[name]?.status ?? p.status }; };   // vocab is the registry's (C11)
  return {
    envelope: { status: TRIAL_KERNEL, fields: [...ENVELOPE].sort(), kinds: [...KINDS].sort() },
    fold: { status: TRIAL_KERNEL, ops: Object.fromEntries(Object.entries(OP_FIELDS).map(([k, v]) => [k, [...v]])), batch: [...BATCH_FIELDS] },
    identity: { status: TRIAL_KERNEL, identity: IDENT, entity: ENTITY.source, component: COMP.source },
    version: { status: TRIAL_KERNEL, dialect: DIALECT, v: VERSION, minors: [...MINORS].sort((a, b) => a - b), genesis: [...GENESIS_FIELDS].sort() },
    transform: comp("transform"),
    parent: comp("parent"),
    model: comp("model"),
    roles: comp("roles"),
    access: comp("access"),
  };
}

const j = (x) => JSON.stringify(x);
/** Every difference between a pinned kernel and now, as lines. [] = the kernel is as pinned. Any difference counts (a kernel
 *  addition is a change too: an old reader refuses an unknown envelope field, a new kind, a new op field). */
export function kernelDiff(pin, now = kernelPinOf()) {
  const out = [];
  const walk = (a, b, at) => {
    if (j(a) === j(b)) return;
    const bag = (x) => x && typeof x === "object" && !Array.isArray(x);
    if (bag(a) && bag(b)) { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${at}.${k}`); return; }
    out.push(`${at}: ${j(a) ?? "absent"} → ${j(b) ?? "absent"}`);
  };
  for (const k of new Set([...Object.keys(pin ?? {}), ...Object.keys(now)])) walk(pin?.[k], now[k], k);
  return out;
}

/** The translator's version number from its name (eidoverse/translate-v1@14 → 14), or null. */
export const translatorN = (name) => { const m = /@(\d+)$/.exec(String(name ?? "")); return m ? +m[1] : null; };

/** May `now` be pinned over `pin`? {ok, diff, why?, companions?}. With no diff: yes (the old companions are kept). With a
 *  diff, only with all three companions: {ack, translator: {from, to}, vectors: {dir, ran: {old: [...], new: [...]}}}, where
 *  each vector's `old` verdict is a refusal (not "ok") and its `new` verdict is "ok". `date` stamps the changelog line.
 *  The companions the pin will record: {changelog, translator, vectors}. */
export function kernelVerdict(pin, now = kernelPinOf(), companions = null, date = new Date().toISOString().slice(0, 10)) {
  if (!pin) return { ok: true, diff: [], companions: null, initial: true };   // the first pin: nothing changed yet, so nothing to carry
  const diff = kernelDiff(pin.kernel ?? pin, now);
  if (!diff.length) return { ok: true, diff, companions: pin.companions ?? null };
  const c = companions ?? {}; const missing = [];
  const ack = typeof c.ack === "string" ? c.ack.trim() : "";
  if (!ack) missing.push(`a changelog line: --ack "<why>" (written to spec/REGISTRY-CHANGELOG.md as "kernel: <why>")`);
  // A SCOPE TRIM (recut C11, the mirror of the extension below): the whole diff is kernel components' `grammar` leaving the pin.
  // Every leaving key must be HELD (the registry pin keeps the same value; the caller compares the files and names it in
  // companions.trim.held) or DROPPED with a why (companions.trim.dropped["<name>.<key>"]). No stored byte changes meaning, so no
  // translator or vectors could exist; the ack is still required. Anything else in the diff is a kernel change: all three.
  const leaving = diff.map((d) => /^([a-z][a-z0-9-]*)\.grammar: .* → absent$/.exec(d)?.[1] ?? null);
  const t = c.trim;
  if (t && diff.length && leaving.every((n) => n && KERNEL_COMPONENTS.includes(n))) {
    const base = pin.kernel ?? pin; const lines = [], unaccounted = [];
    for (const n of leaving) for (const k of Object.keys(base[n]?.grammar ?? {})) {
      const why = t.dropped?.[`${n}.${k}`];
      if (Array.isArray(t.held?.[n]) && t.held[n].includes(k)) lines.push(`  - ${n}.${k}: leaves the kernel; the registry pin holds it (${n}.vocab.${k})`);
      else if (typeof why === "string" && why.trim()) lines.push(`  - ${n}.${k}: leaves every pin: ${why.trim()}`);
      else unaccounted.push(`${n}.${k}`);
    }
    if (unaccounted.length) return { ok: false, diff, why: `a kernel grammar is leaving, but these keys are neither held by the registry pin (same value) nor dropped with a why (--drop "<name>.<key>=<why>"):\n  - ${unaccounted.join("\n  - ")}` };
    if (missing.length) return { ok: false, diff, why: `the kernel's scope shrank (${[...new Set(leaving)].join(", ")}: grammar leaves): no stored byte changes meaning, so no translator or vectors are asked, but the change still needs its changelog line:\n  - ${missing.join("\n  - ")}` };
    return { ok: true, diff, trimOnly: true, changelog: `- ${date}: kernel: ${ack}\n${lines.join("\n")}\n`, companions: { changelog: `${date}: kernel: ${ack}`, trim: { held: t.held ?? {}, dropped: t.dropped ?? {} }, translator: null, vectors: null } };
  }
  // A SCOPE EXTENSION (reviewer item 5, 10-18: model, roles and access joined transform and parent): the whole diff is kernel
  // component(s) entering the pin, each with the shape the registry ALREADY pinned (the caller checks that against
  // spec/registry-pin.json and names them in companions.scope). No stored byte changes meaning, so no translator and no
  // vectors could exist for it (the old reader folds the same log the same way); a changelog line is still required, and the
  // pin records the extension so K3 verifies the names stay in the kernel. Anything else in the diff (a shape change, a kernel
  // shape, a name leaving) is a kernel change and needs all three.
  const entering = diff.map((d) => /^([a-z][a-z0-9-]*): absent → /.exec(d)?.[1] ?? null);
  const scope = Array.isArray(c.scope?.names) ? c.scope.names : null;
  if (scope && diff.length && entering.every((n) => n && KERNEL_COMPONENTS.includes(n) && scope.includes(n)) && scope.every((n) => entering.includes(n)) && c.scope.registryPinned === true) {
    if (missing.length) return { ok: false, diff, why: `the kernel's scope grew (${scope.join(", ")} entered it, ${TRIAL_KERNEL}): no stored byte changes meaning, so no translator or vectors are asked, but the change still needs its changelog line:\n  - ${missing.join("\n  - ")}\nchanged:\n  ${diff.join("\n  ")}` };
    const changelog = `- ${date}: kernel: ${ack}\n${diff.map((d) => `  - ${d.replace(/ → .*$/, " → (the registry's pinned shape, now the kernel's)")}`).join("\n")}\n`;
    return { ok: true, diff, changelog, scopeOnly: true, companions: { changelog: `${date}: kernel: ${ack}`, scope: { names: [...scope].sort() }, translator: pin.companions?.translator ?? null, vectors: pin.companions?.vectors ?? null } };
  }
  const tFrom = translatorN(c.translator?.from), tTo = translatorN(c.translator?.to);
  if (!(tFrom !== null && tTo !== null && tTo > tFrom) && !(typeof c.translator?.step === "string" && c.translator.step))
    missing.push(`a translator change: translate-v1's TRANSLATOR moved @N → @N+1 (is ${c.translator?.to ?? "unknown"}, pinned ${c.translator?.from ?? "unknown"}), or --translator <a new translate step under tools/protocol/>`);
  const v = c.vectors;
  const ran = Array.isArray(v?.ran) ? v.ran : null;
  if (!v?.dir || !ran || !ran.length) missing.push(`vectors: --vectors <dir> (spec/kernel-vectors/<dir>/vectors.json with at least one entry the old reader refuses and the new reader folds)`);
  else { const badOld = ran.filter((r) => r.old === "ok"), badNew = ran.filter((r) => r.new !== "ok");
    if (badOld.length) missing.push(`vectors the OLD reader still accepts (they prove nothing): ${badOld.map((r) => r.name).join(", ")}`);
    if (badNew.length) missing.push(`vectors the NEW reader refuses (${badNew.map((r) => `${r.name}: ${r.new}`).join(", ")})`); }
  if (missing.length) return { ok: false, diff, why: `the kernel changed (${TRIAL_KERNEL}): a re-pin needs the same change to carry its companions, and these are missing:\n  - ${missing.join("\n  - ")}\nchanged:\n  ${diff.join("\n  ")}` };
  const changelog = `- ${date}: kernel: ${ack}\n${diff.map((d) => `  - ${d}`).join("\n")}\n`;
  return { ok: true, diff, changelog, companions: { changelog: `${date}: kernel: ${ack}`, translator: c.translator, vectors: { dir: v.dir, names: ran.map((r) => r.name) } } };
}
