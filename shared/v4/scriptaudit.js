// shared/v4/scriptaudit.js — a READER's view of behaviour results (research 41 §3.6, §3.7, §7 #14, #15; ported from the
// lab's audit.js). It needs only the log, the fold, the source blobs and the sandbox: never the door. For every
// `script:<id>` act (verb `script`) it checks
//   sponsor — the act's `sponsor` / `sponsorAt` equal the sponsor view of `script:<name>` at that point (§5 "Two views":
//             whose rights admitted the LATEST write to the key in its current life). A door that names someone else is caught.
//   depth   — the number of behaviour acts in its cause chain (41 §3.9), recomputed here, and the limit (8 by default).
//   seed    — seed = H(world ‖ act seq ‖ entity/script key).
//   re-run  — fold to `head`, load `src`, re-run with the recorded event, ts (the frozen clock), seed and presence reads,
//             drop no-ops (scriptrules.elide, the door's own rule), and compare with the change entry the act caused and
//             with its says. A door that altered one op, or a script whose result depended on anything else, is caught.
// Replay of the WORLD never runs code (L1); this re-run is an optional audit view.
import { fold, opsOf, jcs } from "./fold.js";
import { elide, seedOf } from "./scriptrules.js";

const isE = (e) => e && typeof e === "object" && typeof e.kind === "string";
const isScriptActor = (a) => typeof a === "string" && a.startsWith("script:");
const quiet = (e) => { try { return opsOf(e); } catch { return []; } };
function by(L, seq) { const e = L[seq], c = L[e.cause];
  const rights = isE(c) && c.kind === "act" ? (c.body?.capability?.author || (isScriptActor(c.actor) && c.body?.sponsor) || c.actor) : e.actor;
  return { seq, rights }; }
/** creator of (id, comp) as of seq `upto` (inclusive): { seq, rights } or null */
export function creatorAt(L, id, comp, upto) {
  let found = null;
  for (let i = upto; i >= 0; i--) { const e = L[i]; if (!isE(e) || e.kind !== "change") continue; const ops = quiet(e);
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== id) continue;
      if (o.verb === "set" && o.comp === comp) found = i;
      else if ((o.verb === "delete" && (o.comp === comp || o.comp === undefined)) || o.verb === "create") return found === null ? null : by(L, found); } }
  return found === null ? null : by(L, found);
}
/** sponsor of script key (id, comp) as of seq `upto`: the latest write to it in its current life that changed more than
 *  `paused` (§5 "Two views"; R on lab 49 F4: pausing adopts nothing). The door's own rule (door.js sponsorOf). */
export function sponsorAt(L, id, comp, upto) {
  if (!creatorAt(L, id, comp, upto)) return null;
  const W = []; // newest first, current life only
  scan: for (let i = upto; i >= 0; i--) { const e = L[i]; if (!isE(e) || e.kind !== "change") continue; const ops = quiet(e);
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== id) continue;
      if (o.verb === "set" && o.comp === comp) W.push({ seq: i, value: o.value });
      else if (o.verb === "create" || (o.verb === "delete" && (o.comp === comp || o.comp === undefined))) break scan; } }
  const unp = (v) => { if (!v || typeof v !== "object" || Array.isArray(v)) return v; const { paused, ...rest } = v; return rest; };
  for (let k = 0; k < W.length; k++) if (k === W.length - 1 || W[k].value === undefined || W[k + 1].value === undefined || jcs(unp(W[k].value)) !== jcs(unp(W[k + 1].value))) return by(L, W[k].seq);
  return null;
}
export function depthOf(L, seq) { let n = 0, e = L[seq], g = 0; while (isE(e) && isScriptActor(e.actor) && g++ < 10000) { if (e.kind === "act") n++; e = L[e.cause]; } return n; }
const norm = (ops) => jcs(ops.map(({ verb, id, comp, value }) => ({ verb, id, ...(comp !== undefined ? { comp } : {}), ...(value !== undefined ? { value } : {}) })));

/**
 * @param {any[]} L the log (readLog's entries)
 * @param {(h: string) => any} getBlob
 * @param {{run?: Function, depth?: number}} opts run = the sandbox's runScript (omit to skip re-runs)
 */
export function auditScripts(L, getBlob, { run = null, depth: maxD = 8 } = {}) {
  const flags = []; let acts = 0, maxDepth = 0, reran = 0;
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
    // no wall clock on a re-run: fuel (deterministic) is the limit; the auditor's machine may be slower than the door's
    const res = run({ text: blob.text, self: id, key: b.script, event, knobs: v.knobs ?? {}, now: a.ts, seed: b.seed, st, reads: b.reads ?? { near: [], count: [], names: [] }, limits: { wallMs: 10000 } });
    if (!res.ok) { flags.push({ seq, check: "rerun", why: `the re-run failed: ${res.code}: ${res.why}` }); return; }
    reran++;
    const want = elide(st, res.ops);
    const outs = []; for (let i = seq + 1; i < L.length; i++) if (isE(L[i]) && L[i].cause === seq) outs.push(L[i]);
    const state = outs.find((e) => e.kind === "change");
    const got = state ? quiet(state) : [];
    if (norm(want) !== norm(got)) flags.push({ seq, check: "rerun", why: "the re-run's writes differ from the logged batch", want: want.length, got: got.length, at: state ? L.indexOf(state) : null });
    const says = outs.filter((e) => e.kind === "say").map((e) => e.body?.text);
    if (jcs(says) !== jcs(res.says)) flags.push({ seq, check: "rerun-say", why: "the re-run's says differ from the logged ones" });
  });
  return { acts, reran, maxDepth, flags };
}
