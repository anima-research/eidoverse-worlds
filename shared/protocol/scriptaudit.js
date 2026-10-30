// shared/protocol/scriptaudit.js — a READER's view of behaviour results (research 41 §3.6, §3.7, §7 #14, #15; ported from the
// lab's audit.js). It needs only the log, the fold, the source blobs and the sandbox: never the authority. For every
// `script:<id>` act (verb `script`) it checks
//   sponsor — the act's `sponsor` / `sponsorAt` equal the sponsor view of `script:<name>` at that point (§5 "Two views":
//             whose rights admitted the LATEST write to the key in its current life). An authority that names someone else is caught.
//   depth   — the number of behaviour acts in its cause chain (41 §3.9), recomputed here, and the limit (8 by default).
//   seed    — seed = H(world ‖ act seq ‖ entity/script key).
//   re-run  — fold to `head`, load `src`, re-run with the recorded event, ts (the frozen clock), seed and presence reads,
//             drop no-ops (scriptrules.elide, the authority's own rule), and compare with the change entry the act caused and
//             with its says. An authority that altered one op, or a script whose result depended on anything else, is caught.
//   reads   — an act records what its presence reads ASKED and how much came back ({near: [{r, n}], count, names: k}), never
//             who (consent gaps 6b): the ids near a script and display names stay out of the log. So a re-run answers each
//             near() with n opaque stand-ins and each name() with null. The reads are inputs the auditor can't replay, and
//             it treats them so: (1) the re-run must ask the SAME reads (radii, counts, how many names) — a different shape
//             is flagged `reads`; (2) when the re-run's writes and says equal the logged ones, the act is verified: a re-run
//             with stand-ins matched the log (not proof the result is the same whoever was there); (3) when they differ and the act read who was near or what someone
//             is called, the act is `skipped` with that reason, never flagged and never counted verified. An act with no
//             such reads that differs is still flagged `rerun`. Soundness: everything but the identities is still checked
//             (sponsor, depth, seed, src, the read shape), and a result matched with stand-ins is checked in full.
//   arrivals — an `enter` / `leave` activation records no identity (review r8 M4): the script heard `by` live, the act keeps
//             neither a trigger actor nor event.by. A re-run gets a stand-in identity; one that matches the log is verified
//             (it can't show the result is the same whoever came). One that differs from the log is re-run again with a SECOND stand-in of another shape (a minted-
//             shaped one, then one of another valid shape; review r9 M2, r10 M3): if the two re-runs differ from each other it is
//             `skipped`; if they agree, the mismatch is flagged `rerun-anon` (never `rerun`: two inputs can't prove a result is
//             the same for every identity, so it is a mismatch to look at, not proof of a forgery).
// Replay of the WORLD never runs code (L1); this re-run is an optional audit view.
import { fold, opsOf, followUpsOf, jcs } from "./fold.js";
import { elide, seedOf, stampMotions } from "./scriptrules.js";

const isE = (e) => e && typeof e === "object" && typeof e.kind === "string";
const isScriptActor = (a) => typeof a === "string" && a.startsWith("script:");
const quiet = (e) => { try { return opsOf(e); } catch { return []; } };
// a purged cause act (§12: its body is the {commit} stub, or a purge entry names it) says nothing about whose rights admitted
// it: unknown (null), as the authority's entryBy reads it (READBACK) — never its actor, which would be the visitor's
const purgedIn = (L) => { const p = new Set(); L.forEach((e, i) => { if (isE(e) && e.kind === "purge" && Array.isArray(e.body?.values)) for (const t of e.body.values) if (t && Number.isInteger(t.seq) && t.seq < i && t.op === undefined) p.add(t.seq); }); return p; };
const stub = (b) => !!b && typeof b === "object" && Object.keys(b).length > 0 && Object.keys(b).every((k) => k === "commit" || k === "salt");
const PURGED_OF = new WeakMap();
function by(L, seq) { const e = L[seq], c = L[e.cause];
  if (isE(c) && c.kind === "act") { let P = PURGED_OF.get(L); if (!P) PURGED_OF.set(L, (P = purgedIn(L)));
    if (P.has(e.cause) || stub(c.body)) return { seq, rights: null }; }
  const rights = isE(c) && c.kind === "act" ? (c.body?.capability?.author || (isScriptActor(c.actor) && c.body?.sponsor) || c.actor) : e.actor;
  return { seq, rights }; }
/** creator of (id, comp) as of seq `upto` (inclusive): { seq, rights } or null */
export function creatorAt(L, id, comp, upto) {
  let found = null, restored = false;
  for (let i = upto; i >= 0; i--) { const e = L[i]; if (!isE(e) || e.kind !== "change") continue; const ops = quiet(e); const fu = followUpsOf(e);
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== id) continue;
      if (o.verb === "set" && fu.has(k)) { if (o.comp === comp) restored = true; continue; }   // the authority's follow-up authors nothing (the entry's followUps, review r9 H1)
      if (o.verb === "delete" && fu.has(k) && restored && (o.comp === comp || o.comp === undefined)) { restored = false; continue; }   // reversed by a follow-up restore (r10 M2)
      if (o.verb === "set" && o.comp === comp) { found = i; restored = false; }
      else if ((o.verb === "delete" && (o.comp === comp || o.comp === undefined)) || o.verb === "create") return found === null ? null : by(L, found); } }
  return found === null ? null : by(L, found);
}
/** sponsor of script key (id, comp) as of seq `upto`: the latest write to it in its current life that changed more than
 *  `paused` (§5 "Two views"; R on lab 49 F4: pausing adopts nothing). The authority's own rule (authority.js sponsorOf). */
export function sponsorAt(L, id, comp, upto) {
  if (!creatorAt(L, id, comp, upto)) return null;
  const W = []; // newest first, current life only
  let restored = false;
  scan: for (let i = upto; i >= 0; i--) { const e = L[i]; if (!isE(e) || e.kind !== "change") continue; const ops = quiet(e); const fu = followUpsOf(e);
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== id) continue;
      if (o.verb === "set" && fu.has(k)) { if (o.comp === comp) restored = true; continue; }
      if (o.verb === "delete" && fu.has(k) && restored && (o.comp === comp || o.comp === undefined)) { restored = false; continue; }   // r10 M2
      if (o.verb === "set" && o.comp === comp) { restored = false; W.push({ seq: i, value: o.value }); }
      else if (o.verb === "create" || (o.verb === "delete" && (o.comp === comp || o.comp === undefined))) break scan; } }
  const unp = (v) => { if (!v || typeof v !== "object" || Array.isArray(v)) return v; const { paused, ...rest } = v; return rest; };
  for (let k = 0; k < W.length; k++) if (k === W.length - 1 || W[k].value === undefined || W[k + 1].value === undefined || jcs(unp(W[k].value)) !== jcs(unp(W[k + 1].value))) return by(L, W[k].seq);
  return null;
}
export function depthOf(L, seq) { let n = 0, e = L[seq], g = 0; while (isE(e) && isScriptActor(e.actor) && g++ < 10000) { if (e.kind === "act" && e.verb === "script") n++; e = L[e.cause]; } return n; }
const norm = (ops) => jcs(ops.map(({ verb, id, comp, value }) => ({ verb, id, ...(comp !== undefined ? { comp } : {}), ...(value !== undefined ? { value } : {}) })));

/**
 * @param {any[]} L the log (readLog's entries)
 * @param {(h: string) => any} getBlob
 * @param {{run?: Function, depth?: number}} opts run = the sandbox's runScript (omit to skip re-runs)
 */
const readShape = (r) => ({ near: (r?.near ?? []).map((x) => [x.r, Array.isArray(x.ids) ? x.ids.length : x.n]), count: r?.count ?? [], names: Array.isArray(r?.names) ? r.names.length : r?.names ?? 0 });
/** did these recorded reads ask who was near, or what someone is called? (inputs a re-run gets only as stand-ins) */
// Two stand-ins of different SHAPES (review r10 M3, L3): a minted-shaped one (u- and 20 lowercase, as the directory mints) and
// one of another valid shape (a short lowercase name, no u-: an imported name, another server's id). Both are valid
// identities (§3.1) and nobody's, and neither says what holds it (§6a rule 2), so a script that treats ids of one shape
// differently, or reads an identity's length or prefix, answers differently for the two and is listed as not re-runnable.
export const ARRIVAL_STAND_IN = "u-" + "a".repeat(20);
export const ARRIVAL_STAND_IN_2 = "zq-stand-in";
const whoReads = (r) => (r?.near ?? []).some((x) => !Array.isArray(x.ids) && x.n > 0) || (typeof r?.names === "number" && r.names > 0);
export function auditScripts(L, getBlob, { run = null, depth: maxD = 8 } = {}) {
  const flags = [], skipped = []; let acts = 0, maxDepth = 0, reran = 0;
  L.forEach((a, seq) => {
    if (!isE(a) || a.kind !== "act" || !isScriptActor(a.actor) || a.verb !== "script") return; acts++;
    const id = a.actor.slice("script:".length), b = a.body ?? {};
    const c = sponsorAt(L, id, b.script, seq - 1);
    if (!c || c.rights !== b.sponsor || c.seq !== b.sponsorAt) flags.push({ seq, check: "sponsor", claimed: { sponsor: b.sponsor, sponsorAt: b.sponsorAt }, view: c });
    const d = depthOf(L, seq); maxDepth = Math.max(maxDepth, d);
    if (d !== b.depth) flags.push({ seq, check: "depth", claimed: b.depth, view: d });
    if (d > maxD) flags.push({ seq, check: "depth-limit", view: d });
    if (seedOf(a.world, seq, `${id}/${b.script}`) !== b.seed) flags.push({ seq, check: "seed", why: "seed isn't H(world, act seq, script key)" });
    if (!run) return;
    const st = fold(L, { until: b.head }); const v = st.entities[id]?.c[b.script];
    if (!v || v.src !== b.src) { flags.push({ seq, check: "src", claimed: b.src, view: v?.src ?? null }); return; }
    let blob; try { blob = getBlob(b.src); } catch { flags.push({ seq, check: "src", why: "the source blob is missing" }); return; }
    // the event as recorded, plus what the act points at instead of copying (a say's text, a use's args: purgeable there)
    const trig = Number.isInteger(b.trigger?.seq) ? L[b.trigger.seq] : null; const event = { ...b.event };
    if (b.on === "say") { if (!isE(trig) || typeof trig.body?.text !== "string") { flags.push({ seq, check: "input", why: "the say it heard is gone (purged?): it can't be re-run" }); return; }
      event.text = trig.body.text; if (trig.body.to !== undefined) event.to = trig.body.to; }
    if (b.on === "use" && isE(trig) && trig.body?.request?.args !== undefined) event.args = trig.body.request.args;
    const anonWho = ["enter", "leave", "grab", "release"].includes(b.on) && event.by === undefined; if (anonWho) event.by = ARRIVAL_STAND_IN;   // an unlogged grab records no identity either (r9 O2)
    // no wall clock on a re-run: fuel (deterministic) is the limit; the auditor's machine may be slower than the authority's
    const rerun = (ev) => run({ text: blob.text, self: id, key: b.script, event: ev, knobs: v.knobs ?? {}, now: a.ts, seed: b.seed, api: b.api ?? 1, st, reads: b.reads ?? { near: [], count: [], names: 0 }, limits: { wallMs: 10000 } });
    const res = rerun(event);
    if (!res.ok) { flags.push({ seq, check: "rerun", why: `the re-run failed: ${res.code}: ${res.why}` }); return; }
    if (jcs(readShape(res.reads)) !== jcs(readShape(b.reads))) { flags.push({ seq, check: "reads", why: "the re-run asked different presence reads than the act records", want: readShape(res.reads), got: readShape(b.reads) }); return; }
    const want = elide(st, stampMotions(st, res.ops, a.ts));   // as the authority stamped and elided it (scriptrun)
    const outs = []; for (let i = seq + 1; i < L.length; i++) if (isE(L[i]) && L[i].cause === seq) outs.push(L[i]);
    const state = outs.find((e) => e.kind === "change");
    const got = state ? quiet(state) : [];
    const says = outs.filter((e) => e.kind === "say").map((e) => e.body?.text);
    const sameW = norm(want) === norm(got), sameS = jcs(says) === jcs(res.says);
    // world.use proposals are recorded in the act (each target's outcome is its own act): a re-run must propose the same
    if (jcs(res.uses ?? []) !== jcs(b.uses ?? [])) { flags.push({ seq, check: "rerun-use", why: "the re-run's world.use calls differ from the act's" }); return; }
    if (sameW && sameS) { reran++; return; }
    if (whoReads(b.reads)) { skipped.push({ seq, why: "its result depends on who was near or what someone is called, which the act doesn't record (only how many): it can't be re-run to the same result" }); return; }
    if (anonWho) { const r2 = rerun({ ...event, by: ARRIVAL_STAND_IN_2 });   // does the result depend on who came? two stand-ins agree → no
      const agree = r2.ok && jcs(readShape(r2.reads)) === jcs(readShape(res.reads)) && norm(elide(st, stampMotions(st, r2.ops, a.ts))) === norm(want) && jcs(r2.says) === jcs(res.says);
      if (!agree) { skipped.push({ seq, why: "its result depends on who arrived or left, which the act doesn't record: it can't be re-run to the same result" }); return; } }
    // an arrival's mismatch is named as one (review r10 M3): two stand-ins that agree can't prove the result is the same for
    // every identity, so it is never reported as plain `rerun` (a forgery): `rerun-anon` says it differs and the re-run can't know who came
    if (anonWho) { flags.push({ seq, check: "rerun-anon", why: `the re-run's ${!sameW ? "writes" : "says"} differ from the log; it can't know who arrived or left (two stand-ins of different shapes agreed), so this is a mismatch to look at, not proof of a forgery`, ...(!sameW ? { want: want.length, got: got.length, at: state ? L.indexOf(state) : null } : {}) }); return; }
    if (!sameW) flags.push({ seq, check: "rerun", why: "the re-run's writes differ from the logged batch", want: want.length, got: got.length, at: state ? L.indexOf(state) : null });
    if (!sameS) flags.push({ seq, check: "rerun-say", why: "the re-run's says differ from the logged ones" });
  });
  return { acts, reran, skipped, maxDepth, flags };
}
