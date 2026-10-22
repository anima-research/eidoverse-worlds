// shared/protocol/authority/undo.js — the act index (undo and wait without scanning the log) and undo by act, with the
// sky, weather and sculpt builders that live beside it (refactor split, 2026-10-17; moved from authority.js's "the act
// index" and "undo" sections unchanged). The inverse goes through admit like any write; the write path's helpers it
// borrows (needThing, lastTouch, the reference clears) are above it, reached through UP.
import { fold, opsOf, isIdentity, jcs, PURGED } from "../fold.js";
import { materialize, refsOf } from "../componentspec.js";
import { foldSkyEntry } from "../../forecast.js";
import * as TR from "../sculpt.js";
import { UP } from "./ctx.js";
import { refuse, said } from "./refuse.js";
import { readback, FOLLOW_UP, clone, createOps, delOp, followUpsOf, isE, opsQuiet, scratch, setOp, versionOf, versionSeq } from "./storage.js";
import { obbs, satDepth, worldT } from "./math.js";
import { isLegacyParent, isSocketC, socketsOf } from "./sockets.js";
import { RESERVED, admits, may, rankOf, roleOf } from "./rights.js";
import { reactionCap } from "./use.js";
// the layers above this one (a leaf may not import them: authority-layers-check), reached through UP (ctx.js), which
// authority.js binds at load
const guess = (...a) => UP.guess(...a);
const holdsRefs = (...a) => UP.holdsRefs(...a);
const isNum = (...a) => UP.isNum(...a);
const lastTouch = (...a) => UP.lastTouch(...a);
const needThing = (...a) => UP.needThing(...a);
const withoutRefs = (...a) => UP.withoutRefs(...a);

// ---------- the act index (slice 3a): undo and wait without scanning the log ----------
// A view over the log (L2), built once per world object and advanced per appended entry, so a live world (server,
// where `w` lives as long as the world is open) pays for each entry once. A purge is retroactive (L1), so a purge entry
// throws the index away and rebuilds it, as livehost.ts refolds the state. What it holds:
//   actsOf    actor → their act seqs, in order          resultOf  act seq → the first change entry it caused
//   undone    act seqs some `undo` act names (body.undoes)
//   purged    seqs whose act/say/sim BODY is purged; purgedOps `${seq}:${op|-}` → a purged set value (as the fold keys it)
//   changes   every change seq, in order                touch     id → the change seqs that touch it, in order
//   rests     change seqs that are rests (caused by a sim launch); restAfter: `${rest seq}:${body id}` → the authority's
//             follow-up act for that body (a rest can carry several bodies, each with its own follow-up, as restsOf reads them)
//   lastAct   the latest act that isn't an undo or the authority's (for "the latest change was X's")
// A world object over a log that is re-read per request (the suites' disk worlds) rebuilds it per request, as before.
function freshIndex() {
  return { n: 0, actsOf: new Map(), resultOf: new Map(), undone: new Set(), purged: new Set(), purgedOps: new Map(), changes: [], touch: new Map(),
    rests: [], restAfter: new Map(), lastAct: null };
}
function purgeTargets(E, x) { // the fold's own reading of purge entries (fold.js purgesOf), kept for views
  x.pt = E.length; // purges below this seq are already in purged/purgedOps
  E.forEach((e, pseq) => { if (!isE(e) || x.bad.has(pseq) || e.kind !== "purge" || !Array.isArray(e.body?.values)) return;
    for (const t of e.body.values) { if (!t || typeof t !== "object" || Array.isArray(t) || !Object.keys(t).every((k) => k === "seq" || k === "op")) continue;
      if (!Number.isInteger(t.seq) || t.seq <= 0 || t.seq >= pseq || (t.op !== undefined && !(Number.isInteger(t.op) && t.op >= 0))) continue;
      const tgt = E[t.seq]; if (!isE(tgt) || x.bad.has(t.seq) || tgt.kind === "purge") continue;
      if (t.op === undefined && ["act", "say", "sim"].includes(tgt.kind)) x.purged.add(t.seq);
      x.purgedOps.set(`${t.seq}:${t.op ?? "-"}`, pseq); } });
}
function indexEntry(x, E, i) {
  const e = E[i]; if (!isE(e) || x.bad.has(i)) return; // what the fold refuses (malformed) shapes no view either
  if (e.kind === "act") { let a = x.actsOf.get(e.actor); if (!a) x.actsOf.set(e.actor, (a = [])); a.push(i);
    const b = x.purged.has(i) ? null : e.body;
    if (e.verb === "undo" && b && b.undoes !== undefined) x.undone.add(b.undoes);
    if (e.verb === "undo" && b && Array.isArray(b.rollback?.acts)) for (const q of b.rollback.acts) x.undone.add(q);
    if (e.verb !== "undo" && e.actor !== "system") x.lastAct = i;
    if (e.actor === "system" && b && Number.isInteger(b.rest) && typeof b.id === "string" && !x.restAfter.has(`${b.rest}:${b.id}`)) x.restAfter.set(`${b.rest}:${b.id}`, i); }
  if (e.kind === "change") { x.changes.push(i);
    // what the sim writes (a rest) is physics, never an act's undoable result: live, a rest is caused by a launch entry;
    // in an imported world (translate-v1@11) by the old punt's act, which must not make it undoable (review of b398d7e3 #2)
    if (Number.isInteger(e.cause) && e.actor !== "sim" && !x.resultOf.has(e.cause)) x.resultOf.set(e.cause, i);
    for (const id of new Set(opsQuiet(e).map((o) => o.id))) { let a = x.touch.get(id); if (!a) x.touch.set(id, (a = [])); a.push(i); }
    const c = E[e.cause]; if (isE(c) && c.kind === "sim" && c.verb === "launch") x.rests.push(i); }
}
// The entries the fold calls malformed (it shapes nothing with them). The authority never writes one; an old or hand-made
// log may hold some, and they're known when the index is built (the authority re-reads every line it appends).
const malformedSeqs = (st) => new Set((st?.diagnostics ?? []).filter(([, c]) => String(c).startsWith("malformed")).map(([q]) => q));
/** The act index for a world, advanced to the log's end (rebuilt from scratch when a purge arrives). */
export function actIndexOf(w) {
  const E = w.entries; let x = w.__actIndex;
  const fresh = () => { const y = freshIndex(); y.entries = E; y.bad = malformedSeqs(w.state ? w.state() : fold(E)); purgeTargets(E, y); return (w.__actIndex = y); };
  if (!x || x.entries !== E || x.n > E.length) x = fresh();
  for (; x.n < E.length; x.n++) {
    if (x.n >= x.pt && isE(E[x.n]) && E[x.n].kind === "purge") { const n = x.n; x = fresh(); for (; x.n < n; x.n++) indexEntry(x, E, x.n); } // retroactive (L1): start over
    indexEntry(x, E, x.n); }
  return x;
}
/** The same index built from nothing over `entries` (the reference the incremental one must equal). */
export function actIndexFresh(entries) { return actIndexOf({ entries }); }
const firstAfter = (a, seq) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= seq) lo = m + 1; else hi = m; } return lo; };
/** A thing as it was just before entry `seq` (= fold(entries, {until: seq - 1}).entities[id]), from its own history
 *  through the index, never the whole log. Purged values are PURGED at every point in time, as the fold has them. */
export function entityBefore(w, id, seq, x = actIndexOf(w)) {
  let ent = id === "@world" ? { born: 0, c: Object.create(null) } : undefined; // @world is live from genesis (§2.3)
  const E = w.entries; const hist = x.touch.get(id) ?? [];
  for (let k = 0; k < hist.length && hist[k] < seq; k++) { const i = hist[k]; const e = E[i]; const ops = opsQuiet(e); const batch = e.verb === "batch";
    ops.forEach((o, j) => { if (o.id !== id) return;
      if (o.verb === "create") { if (!ent) ent = { born: i, c: Object.create(null) }; return; }
      if (!ent) return;
      // a value stripped to its commit reads PURGED whether or not a purge names it, as the fold reads it (§12, commit-unpurged)
      if (o.verb === "set") { if (o.stripped || x.purgedOps.has(`${i}:${batch ? j : "-"}`)) ent.c[o.comp] = PURGED; else if ("value" in o) ent.c[o.comp] = clone(o.value); return; }
      if (o.comp === undefined) { if (id !== "@world") ent = undefined; return; }
      delete ent.c[o.comp]; }); }
  return ent;
}

// ---------- undo (by act; the inverse goes through admit like any write: rank and locks NOW) ----------
function skyValue(prev, verb, args, now) {
  if (!args || typeof args !== "object" || Array.isArray(args)) refuse("shape", `${verb} takes the sky's fields {hours, rate, weather, clouds…}`, "");
  const { dry, ...a } = args;
  const out = clone(foldSkyEntry(prev, { verb, args: a, ts: Math.floor(now), seq: 0, actor: "system" }));
  delete out.seq; delete out.by;
  for (const k of ["forecast", "override"]) if (out[k] && typeof out[k] === "object") { delete out[k].seq; delete out[k].by; }
  return materialize("sky", out).value;   // every parameter written down (shape audit 10-16: the sky's defaults are the registry's)
}
function buildSky(ctx, a, w) { return [setOp("@world", "sky", skyValue(null, "sky", a, w.now()))]; }
function buildWeather(ctx, a, w) { return [setOp("@world", "sky", skyValue(ctx.st.entities["@world"]?.c.sky ?? null, "weather", a, w.now()))]; }
function buildUndo(ctx, a, w) {
  const X = actIndexOf(w); const E = w.entries;
  const mine = X.actsOf.get(ctx.actor) ?? [];
  const bodyOf = (seq) => readback(w, seq); // READBACK: a purged act's request can't be read, or matched by label (null: unknown)
  const result = (seq) => { const r = X.resultOf.get(seq); return r === undefined ? undefined : E[r]; };
  // the inverse of one act against `now`: what to write, and what to leave because someone changed it since. A function
  // so an owner's rollback can run it over many acts in a row, each against what the previous inverses left
  const inverseOf = (target, res, now) => {
  const beforeOf = new Map(); const before = (id) => { if (!beforeOf.has(id)) beforeOf.set(id, entityBefore(w, id, target.seq, X)); return beforeOf.get(id); };
  const flat = opsOf(res);
  // what others wrote since: a thing's own later history (touch), and, for the spatial check, every change entry since
  // the result (bounded by what happened after the act, never the log before it)
  // later work by anyone but the act's own author stands; the maintenance command's lift isn't work (it respells, and its old values
  // are translated again on the way back in)
  const others = (i) => E[i].actor !== target.actor && E[E[i].cause]?.verb !== "lift-sockets";
  const touchedBy = (id, comp) => { const h = X.touch.get(id) ?? []; for (let k = firstAfter(h, res.seq); k < h.length; k++) { const e = E[h[k]]; if (!others(h[k])) continue;
    for (const o of opsQuiet(e)) if (o.id === id && (comp === undefined || o.comp === comp || o.comp === undefined || o.verb === "create")) return e.actor; } return null; };
  const later = X.changes.slice(firstAfter(X.changes, res.seq)).filter(others).map((i) => E[i]);
  // a host's seats after the cut are its socket children, and nobody writes its `sockets` key (review 10-12 S2-2): later
  // work by others on them (a socket made under it, or any write to one of its socket children, deleted ones included)
  // is a change to what a pre-cut `sockets` edit set, so undoing that edit skips, as it did before the cut
  const socketWorkBy = (host) => {
    for (const i of X.changes.slice(firstAfter(X.changes, res.seq))) { if (!others(i)) continue; const ops = opsQuiet(E[i]);
      for (const o of ops) {
        if (o.verb === "set" && o.comp === "parent" && o.value?.to === host && ops.some((b) => b.id === o.id && b.comp === "socket")) return E[i].actor;
        const was = o.verb === "create" ? null : entityBefore(w, o.id, i, X); if (was && isSocketC(was.c) && was.c.parent?.to === host) return E[i].actor; } }
    return null; };
  const groups = [], skipped = [];
  const keys = new Map();
  const madeHere = new Set(flat.filter((o) => o.verb === "create").map((o) => o.id)); // undone as one unit: the whole thing goes
  // review r8 M1: what the act's delete cleared in others' things (clearRefsTo, the authority's follow-up) comes back as a
  // follow-up too: a value that named a thing this act removed, put back exactly as it was (touchedBy has already skipped
  // it if anyone changed it since), so the referrer's lock or key can't veto the undo any more than it could the delete
  // Only an op the target entry itself marks as a follow-up (its `followUps`) is restored as one (review r9 holes L2): the
  // asker's own write in the same batch is theirs, and putting it back meets their rights and the locks now, like any undo.
  const goneHere = new Set(flat.filter((o) => o.verb === "delete" && o.comp === undefined).map((o) => o.id));
  const fuHere = new Set([...followUpsOf(res)].map((k) => flat[k]).filter(Boolean));
  const refRestore = (o) => { if (!goneHere.size || !fuHere.has(o) || o.comp === undefined || o.verb === "create" || goneHere.has(o.id) || !holdsRefs(o.comp)) return false;
    const old = before(o.id)?.c[o.comp]; return old !== undefined && old !== PURGED && refsOf(o.comp, old).some((r) => goneHere.has(r.id)); };
  for (const o of flat) { if (madeHere.has(o.id) && o.verb !== "create") continue;
    const k = o.id + "|" + (o.verb === "set" || (o.verb === "delete" && o.comp !== undefined) ? o.comp : "*"); if (!keys.has(k)) keys.set(k, o); }
  const paired = new Set();
  for (const [, o] of [...keys].reverse()) {
    const { id, comp } = o; const whole = o.verb === "create" || (o.verb === "delete" && comp === undefined);
    // where a thing sat on a socket before the cut, its transform was in the HOST's frame (review 10-12 S2-1): its parent
    // and its transform go back as one group, so the door lifts the parent and re-expresses the pose in the socket child's
    // frame (liftOps' `via`); a bare transform would be read in the socket's frame and land it elsewhere
    const ob = !whole && (comp === "transform" || comp === "parent") ? before(id) : null;
    if (ob && isLegacyParent(ob.c.parent)) { if (paired.has(id)) continue; paired.add(id);
      const by = touchedBy(id, "parent") ?? touchedBy(id, "transform");
      if (by) { skipped.push({ id, component: comp, why: `${said(by)} changed it since`, by }); continue; }
      if (ob.c.transform === PURGED) { skipped.push({ id, component: "transform", why: "its old value was purged" }); continue; }
      if (now.entities[id]) groups.push([setOp(id, "parent", ob.c.parent), ...(ob.c.transform ? [setOp(id, "transform", ob.c.transform)] : [])]);
      ctx.refs.add(id); continue; }
    // a host's seats are its socket children: work by others on them since stops undoing its `sockets` and its creation alike
    // (undoing the create would delete a socket someone made on it since)
    const by = touchedBy(id, whole ? undefined : comp) ?? ((comp === "sockets" && !whole) || o.verb === "create" ? socketWorkBy(id) : null);
    if (by) { skipped.push({ id, component: comp, why: `${said(by)} changed it since`, by }); continue; }
    // undoing a create: what others hung on it since is THEIR work. It stays, let go where it is (round-1 F3), never
    // deleted with it and never left pointing at a thing that's gone
    if (o.verb === "create") { if (now.entities[id]) { const kidsOf = (p) => Object.keys(now.entities).filter((k) => now.entities[k].c.parent?.to === p && !madeHere.has(k));
        // its sockets are its parts (a lift made them): they go with it, and what others put in them is let go like the rest
        const parts = kidsOf(id).filter((k) => isSocketC(now.entities[k].c)); const kids = [...kidsOf(id).filter((k) => !parts.includes(k)), ...parts.flatMap(kidsOf)];
        groups.push([...kids.flatMap((k) => [setOp(k, "transform", worldT(now, k)), delOp(k, "parent")]), ...parts.map((k) => delOp(k)), delOp(id)]); kids.forEach((k) => ctx.refs.add(k)); } }
    else if (whole) { const old = before(id); if (old && !now.entities[id]) (ctx.restores ??= new Set()).add(id), groups.push(createOps(id, Object.fromEntries(Object.entries(old.c).filter(([, v]) => v !== PURGED)))); }
    else { const old = before(id)?.c[comp];
      if (old === PURGED) { skipped.push({ id, component: comp, why: "its old value was purged" }); continue; }
      // (sockets: a host's socket children stand for the map it held before the cut; their delete is translated at the door)
      if (old === undefined) { if (now.entities[id] && (comp in now.entities[id].c || (comp === "sockets" && socketsOf(now, id, { off: true }).some((x) => x.id)))) groups.push([delOp(id, comp)]); }
      else if (now.entities[id]) {
        if (!refRestore(o)) groups.push([setOp(id, comp, old)]);
        // a follow-up restore names what this undo brings back; a reference to anything else gone since stays cleared (holes r10 L1:
        // a second delete no longer refuses the whole undo)
        else { const since = new Set(refsOf(comp, old).map((r) => r.id).filter((x) => !now.entities[x] && !goneHere.has(x)));
          const nv = since.size ? withoutRefs(id, comp, old, since) : old;
          if (since.size) (ctx.notes ??= []).push({ id, component: comp, kept: [...since], why: `${[...since].join(", ")} ${since.size > 1 ? "are" : "is"} gone since, so ${since.size > 1 ? "their references stay" : "its reference stays"} cleared` });
          if (nv !== undefined) { const g = setOp(id, comp, nv); g[FOLLOW_UP] = true; groups.push([g]); } } } }
    ctx.refs.add(id);
  }
  // an undo must not land my old state on someone else's later work (spatial conflict, not just same-component)
  const othersSince = new Set(later.flatMap((e) => opsQuiet(e).map((o) => o.id)));
  for (let i = groups.length - 1; i >= 0; i--) { const g = groups[i]; const o = g.at(-1);
    if (!(g[0].verb === "create" || (o.verb === "set" && ["transform", "parent"].includes(o.comp)))) continue;
    const trial = scratch(now, g); const mine = obbs(trial, o.id);
    const hit = [...othersSince].find((x) => x !== o.id && trial.entities[x] && obbs(trial, x).some((sb) => mine.some((ma) => satDepth(ma, sb) > 0.02)));
    if (hit) { const who = later.find((e) => opsQuiet(e).some((q) => q.id === hit))?.actor;
      skipped.push({ id: o.id, component: o.comp, why: `putting it back would land it on ${hit}, which ${said(who)} has placed since`, by: who }); groups.splice(i, 1); } }
  return { groups, skipped }; };
  const pick = (pred) => { for (let k = mine.length - 1; k >= 0; k--) if (pred(mine[k])) return E[mine[k]]; return undefined; };
  // an undo's depth along its `undoes` chain: 0 = an ordinary act, 1 = an undo of one, 2 = a redo (an undo of an undo)…
  // A bare undo takes back my latest live act of EVEN depth: an ordinary act or a redo. Skipping only plain undos keeps
  // Ctrl+Z walking back, while a redo is undone first (agent lab round 2, Hazel: a bare undo after a redo reached past
  // it into older work).
  // READBACK: the chain reads each undo's `undoes`; a purged undo is unknown, read as the index reads it (it undoes nothing
  // we can name: the chain ends there, and its target isn't counted undone)
  const depthOf = (seq) => { let d = 0, q = seq; while (q !== undefined && E[q]?.verb === "undo" && d < 64) { d++; q = bodyOf(q)?.undoes; } return d; };
  const undoneBy = (seq) => { for (let k = mine.length - 1; k >= 0; k--) if (E[mine[k]].verb === "undo" && bodyOf(mine[k])?.undoes === seq) return mine[k]; return undefined; };
  // an owner's rollback (round-2 R11, CoreProtect's rollback by player and time): undo {actor, since} takes back every
  // act that person made since a version, newest first, each inverse against what the previous ones left; later work by
  // anyone else still stands. It says how many acts it would take back, and above 20 it needs confirm: true.
  if (a.actor !== undefined || a.since !== undefined) {
    if (roleOf(ctx.st, ctx.actor) !== "owner") refuse("rights", "rolling back someone's work needs owner", "undo {act} takes back one act, along rank");
    if (!isIdentity(a.actor) || RESERVED.has(a.actor)) refuse("shape", "rollback is undo {actor, since}: actor is a person's identity", "history shows who did what");
    const from = versionSeq(w, a.since, "since");
    const acts = (X.actsOf.get(a.actor) ?? []).filter((q) => q >= from && X.resultOf.has(q) && !X.undone.has(q) && !["create-world", "undo", "throw", "drop", "leave"].includes(E[q].verb)).reverse();
    if (!acts.length) refuse("nothing", `${said(a.actor)} has made no change since act ${from} that's still in force`, "");
    if (acts.length > 20 && a.confirm !== true && a.dry !== true) refuse("confirm", `that rolls back ${acts.length} acts by ${said(a.actor)} since act ${from}`, "dry: true lists them; confirm: true does it", { acts: acts.length });
    let st = ctx.st; const all = []; const skippedAll = [], done = [];
    for (const q of acts) { const { groups, skipped } = inverseOf(E[q], result(q), st); const ops = groups.flat();
      skippedAll.push(...skipped); if (ops.length) { all.push(...ops); st = scratch(st, ops); done.push(q); } }
    if (!all.length) refuse("conflict", `everything ${said(a.actor)} did since then has been changed by others since`, "their later work stands");
    if (skippedAll.length) ctx.notes.push({ skipped: skippedAll });
    ctx.actExtra = { rollback: { actor: a.actor, since: from, acts: done } };
    ctx.undid = { kind: "rollback", acts: done.length, of: said(a.actor) };
    return all; }
  // F2 (decided 10-05): revert goes along rank, never upward. Someone else's act may be undone by a builder (a builder's
  // or a visitor's) or an owner (anyone's, owners included: round-2 R11, owners revert owners). Roles as they are NOW.
  const othersAct = (seq) => { const e = E[seq]; if (!(isE(e) && e.kind === "act")) return undefined;
    if (RESERVED.has(e.actor)) refuse("rank", `act ${seq} was the authority's own, not a person's`, "undo takes back people's acts");
    // research S2: undoing another person's act needs editOthers, and still goes only along rank (custom roles included)
    const me = rankOf(ctx.st, ctx.actor), them = rankOf(ctx.st, e.actor), eo = may(ctx.st, ctx.actor, "editOthers");
    if (!eo || me < them) refuse("rank", `act ${seq} was ${said(e.actor)}'s; ${!eo ? "undoing someone else's work needs a role that may edit others' work (by default, builder and above)" : `they're ${roleOf(ctx.st, e.actor)}, above you`}`, "revert goes along rank, never upward: ask an owner");
    return e; };
  const target = a.act !== undefined ? (mine.includes(a.act) ? E[a.act] : othersAct(a.act))
    : a.label ? pick((q) => bodyOf(q)?.request?.label === a.label && !X.undone.has(q) && X.resultOf.has(q))
    : pick((q) => E[q].verb !== "create-world" && depthOf(q) % 2 === 0 && !X.undone.has(q) && X.resultOf.has(q));
  if (!target) { const last = X.lastAct === null ? null : E[X.lastAct];
    refuse("nothing", "nothing of yours to undo" + (last && last.actor !== ctx.actor ? ` (the latest change was ${said(last.actor)}'s; undo only reverts your own)` : ""), "history shows who did what; to change someone else's work, edit it (they'll see it)"); }
  if (target.verb === "create-world") refuse("founding", "founding a world can't be undone", "§2: @world can't be deleted or undone as a whole; to hand it over, give the new owner their role first");
  if (X.undone.has(target.seq)) { let head = target.seq; const chain = []; for (let i = 0; i < 64; i++) { const u = undoneBy(head); if (u === undefined) break; chain.push(u); head = u; }
    const live = head !== target.seq && depthOf(head) % 2 === 0 ? head : null;
    refuse("nothing", `act ${target.seq} was already undone${chain.length ? ` (by ${chain.map((c) => `${depthOf(c) % 2 ? "undo" : "redo"} ${c}`).join(", then ")})` : ""}`,
      live !== null ? `it's back in force through redo ${live}: undo {act: ${live}} (or a bare undo) takes it back` : "a bare undo takes back your latest change; history shows the chain"); }
  if (["throw", "drop", "leave"].includes(target.verb)) refuse("physical", `that was a ${target.verb}: what it changed is where things came to rest, which physics decided`, "put it back yourself: grab it, then put {id, pos}");
  const res = result(target.seq); if (!res) refuse("nothing", "that act changed nothing", "");
  if (target.verb === "sculpt" && TR.ADDITIVE.has(bodyOf(target.seq)?.request?.brush) && bodyOf(target.seq)?.clamped !== true) { const inv = sculptInverse(w, ctx, target, res); if (inv) { ctx.actExtra = { undoes: target.seq, inverse: true }; return inv; } }
  const { groups, skipped } = inverseOf(target, res, ctx.st);
  if (!groups.length) refuse("conflict", "everything that act touched has been changed by someone else since", "their later change stands (undo never writes over it); if you still want yours, make the change again yourself, and history shows who did what", { skipped });
  if (skipped.length) ctx.notes.push({ skipped });
  // round-2 R11: a brake on revert wars (Wikipedia's 3RR): reverting someone else's work on a thing that has already been
  // reverted across people twice within the hour is refused below owner rank: that's a dispute, and owners settle it
  if (target.actor !== ctx.actor && roleOf(ctx.st, ctx.actor) !== "owner") {
    const mine2 = new Set(groups.flat().map((o) => o.id)); const t0 = w.now() - 3600000; let n = 0;
    for (let i = E.length - 1; i >= 0; i--) { const e = E[i]; if (!isE(e)) continue; if (Number.isInteger(e.ts) && e.ts < t0) break;
      if (e.kind !== "act" || e.verb !== "undo" || !Number.isInteger(e.body?.undoes) || E[e.body.undoes]?.actor === e.actor) continue;
      const r = result(i); if (r && opsQuiet(r).some((o) => mine2.has(o.id))) n++; }
    if (n >= 2) refuse("revert-war", `${[...mine2].join(", ")} has been reverted across people ${n} times in the last hour`, "that's a disagreement, not a fix: ask an owner (owners may still revert), or talk it out"); }
  ctx.actExtra = { undoes: target.seq };
  // round-2 R11: undoing my own `use` is admitted under the same reaction capability the use was (a visitor may open
  // a door through its handler, so they may close it again by undo), asked for again NOW: no handler, no undo
  const ureq = bodyOf(target.seq)?.request;
  const ucap = bodyOf(target.seq)?.capability;
  // …and only while the handler's who still admits them, as a use is judged (a raised who stops future acts, undo included)
  const uh = ureq?.id ? ctx.st.entities[ureq.id]?.c.reactions?.[ucap?.reaction] : undefined;
  if (target.verb === "use" && target.actor === ctx.actor && ucap?.reaction && uh && (!uh.who || admits(ctx.st, ctx.actor, uh.who))) {
    const comps = [...new Set(groups.flat().map((o) => o.comp).filter(Boolean))];
    if (groups.flat().every((o) => o.id === ureq.id && o.comp !== undefined)) { reactionCap(ctx, ureq.id, comps[0], ucap.reaction); ctx.cap.comps = comps;
      ctx.actExtra = { undoes: target.seq, capability: ctx.actExtra.capability }; } }
  // say what came back: which act, what it was, and whether this undoes it or redoes it (Hazel: the reply named nothing)
  const req = bodyOf(target.seq)?.request ?? {}; const dz = depthOf(target.seq);
  const base = dz ? (() => { let q = target.seq; for (let i = 0; i < dz; i++) q = bodyOf(q)?.undoes; return E[q]; })() : target;
  const breq = base ? (bodyOf(base.seq)?.request ?? {}) : req;
  const what = `${base?.verb ?? target.verb}${breq.id ? ` ${breq.id}` : ""}${breq.component ? ` ${breq.component}` : ""}${breq.label ? ` "${breq.label}"` : ""}`;
  ctx.undid = { act: target.seq, kind: dz % 2 ? "redo" : "undo", what, ...(dz ? { of: base?.seq } : {}) };
  return groups.flat();
}

// §3b / 40 §6.2: undo of an additive stroke writes head − (after − before) per touched sample, so strokes made since
// survive. If that would cross the grid's limits (clamping), it is not exact: fall back to restore-before (refused if
// changed since). Returns null to fall back.
function sculptInverse(w, ctx, target, res) {
  const before = w.stateAt(target.seq - 1), ops = [];
  // a LATER stroke that clamped on these tiles makes the inverse inexact too (40 says "at either time"; this is a third)
  const mine = new Set(opsOf(res).map((o) => `${o.id}|${o.comp}`));
  for (const e of w.entries) if (isE(e) && e.kind === "act" && e.verb === "sculpt" && e.seq > target.seq && (readback(w, e.seq) === null || !!readback(w, e.seq).clamped)) {   // READBACK: a purged later stroke may have clamped: inexact
    const ri = actIndexOf(w).resultOf.get(e.seq), r = ri === undefined ? undefined : w.entries[ri];   // the act index, as undo reads results: no scan
    if (r && opsQuiet(r).some((o) => mine.has(`${o.id}|${o.comp}`))) return null; }
  for (const o of opsOf(res)) { const g = ctx.st.entities[o.id]?.c["terrain-grid"]; if (!g || !o.comp?.startsWith("terrain-tile:") || o.verb !== "set") return null;
    const zeros = () => new Array(g.tile ** 2).fill(0); const b = before.entities[o.id]?.c[o.comp]?.mm ?? zeros(), a = o.value.mm, h = ctx.st.entities[o.id]?.c[o.comp]?.mm ?? zeros();
    const lo = -(g.limits?.lower ?? Infinity), hi = g.limits?.raise ?? Infinity; const v = h.map((x, k) => x - (a[k] - b[k]));
    if (v.some((x) => x < lo || x > hi)) return null;
    if (v.some((x, k) => x !== h[k])) ops.push(setOp(o.id, o.comp, { mm: v })); ctx.refs.add(o.id); }
  if (!ops.length) refuse("nothing", "undoing that stroke changes nothing now", "");
  return ops;
}
// `sculpt`: one act per stroke, applied by the authority to the tiles AT HEAD (never the client's copy), writing only the
// touched tiles, whole. Additive brushes commute; smooth reads its neighbours at head and may carry expect {id,
// component, at} (expect by version) to be refused instead of re-applied.
function buildSculpt(ctx, a) {
  const e = needThing(ctx, a.on); const g = e.c["terrain-grid"];
  // terrain-grid is a reserved name (nothing may write it), so naming a set of it as the remedy sent the reader to a refusal
  if (!g) refuse("no-grid", `${a.on} has no terrain-grid, so there is nothing to sculpt on it`, "sculpt works on a thing that already carries a terrain-grid; terrain-grid is reserved on this server, so nobody can add one, and asking again won't change that");
  if (!TR.BRUSHES.includes(a.brush)) refuse("shape", `no brush '${a.brush}'`, TR.BRUSHES.join(", "), { didYouMean: guess(String(a.brush), TR.BRUSHES) });
  if (!Array.isArray(a.path) || !a.path.length || a.path.length > 256 || !a.path.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum))) refuse("shape", "path: [[x, z], …] (1–256 points)", "");
  if (!(a.radius > 0 && a.radius <= 64) || (TR.ADDITIVE.has(a.brush) && !(Number.isInteger(a.strength) && a.strength > 0 && a.strength <= 100000))) refuse("shape", "radius (m, ≤ 64) and strength (whole mm, > 0)", "");
  for (const x of a.expect ?? []) { const lt = lastTouch(ctx.w, x.id, x.component); const at = versionSeq(ctx.w, x.at, `expect ${x.id}.${x.component} at`);
    if (lt && lt.seq > at) refuse("stale", `${x.id}.${x.component} changed since ${at}: ${lt.actor} at ${lt.seq}`, "look again, then stroke (or send it without expect to apply at head)", { version: versionOf(ctx.w, lt.seq) }); }
  const tiles = new Map(Object.entries(e.c).filter(([k]) => k.startsWith("terrain-tile:")).map(([k, v]) => [k, v.mm]));
  const { writes, clamped } = TR.applyStroke(g, tiles, a);
  if (!writes.size) refuse("nothing", "the brush touches no sample of the grid", "check the path against terrain-grid.origin and extent");
  const bytes = [...writes.values()].reduce((t, mm) => t + jcs(mm).length + 60, 0);
  if (bytes > 1000000) refuse("too-big", `that stroke rewrites ${writes.size} tiles (about ${bytes} bytes); a log line is at most 1 MiB, and a stroke is one entry`, "use the base (terrain) or import a raster for big changes; or use a smaller brush");
  ctx.actExtra = { tiles: writes.size, ...(clamped ? { clamped: true } : {}) }; ctx.refs.add(a.on);
  return [...writes].map(([c, mm]) => setOp(a.on, c, { mm }));
}
export { buildSculpt, buildSky, buildUndo, buildWeather };
