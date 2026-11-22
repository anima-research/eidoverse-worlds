// shared/protocol/authority/undo.js — the act index (undo and wait without scanning the log) and undo by act, with the
// sky, weather and sculpt builders that live beside it. The inverse goes through admit like any write; the write path's
// helpers it borrows (needThing, lastTouch, the reference clears) are above it, reached through UP.
import { fold, opsOf, isIdentity, jcs, REDACTED, redactionsIn, redactedBodies } from "../fold.js";
import { materialize, refsOf } from "../componentspec.js";
import { foldSkyEntry, forecastSpellingRefusal } from "../../forecast.js";
import { UP } from "./ctx.js";
import { refuse, said } from "./refuse.js";
import { readback, FOLLOW_UP, clone, createOps, delOp, cascadeOf, isE, opsQuiet, scratch, setOp, versionOf, versionSeq } from "./storage.js";
import { obbs, satDepth, worldT } from "./math.js";
import { isSocketC } from "./sockets.js";
import { RESERVED, admits, may, rankOf, roleOf } from "./rights.js";
import { reactionCap } from "./use.js";
import { idOut } from "../view.js";
import * as TR from "../sculpt.js";
import { SCULPT, shapeable, shapeParams, groundArgs } from "../../terrainshape.js";
import { groundOf, spend } from "./spatial.js";
// the layers above this one, reached through UP (ctx.js; a leaf may not import them: authority-layers-check)
const guess = (...a) => UP.guess(...a);
const holdsRefs = (...a) => UP.holdsRefs(...a);
const isNum = (...a) => UP.isNum(...a);
const lastTouch = (...a) => UP.lastTouch(...a);
const needThing = (...a) => UP.needThing(...a);
const withoutRefs = (...a) => UP.withoutRefs(...a);

// ---------- the act index: undo and wait without scanning the log ----------
// A view over the log, built once per world object and advanced per appended entry, so a live world (server,
// where `w` lives as long as the world is open) pays for each entry once. A purge is retroactive (§12), so a purge entry
// throws the index away and rebuilds it, as livehost.ts refolds the state. What it holds:
//   actsOf    actor → their act seqs, in order          resultOf  act seq → the first change entry it caused
//   undone    act seqs some `undo` act names (body.undoes)
//   purged    seqs whose request/say/physics BODY is purged; purgedOps `${seq}:${index|-}` → the redaction naming a set value (fold.js redactionsIn)
//   changes   every change seq, in order                touch     id → the change seqs that touch it, in order
//   rests     change seqs that are rests (caused by a sim launch); restAfter: `${rest seq}:${body id}` → the authority's
//             follow-up act for that body (a rest can carry several bodies, each with its own follow-up, as restsOf reads them)
//   lastAct   the latest act that isn't an undo or the authority's (for "the latest change was X's")
// A world object over a log that is re-read per request (the suites' disk worlds) rebuilds it per request.
function freshIndex() {
  return { n: 0, actsOf: new Map(), resultOf: new Map(), undone: new Set(), purged: new Set(), purgedOps: new Map(), changes: [], touch: new Map(),
    rests: [], restAfter: new Map(), lastAct: null };
}
function purgeTargets(E, x) { // the fold's own reading of redactions (fold.js redactionsIn), kept for views
  x.pt = E.length; // redactions below this seq are already in purged/purgedOps
  x.purgedOps = redactionsIn(E, { stubs: false }); x.purged = redactedBodies(E, x.purgedOps);
}
function indexEntry(x, E, i) {
  const e = E[i]; if (!isE(e) || x.bad.has(i)) return; // what the fold refuses (malformed) shapes no view either
  if (e.kind === "request") { let a = x.actsOf.get(e.actor); if (!a) x.actsOf.set(e.actor, (a = [])); a.push(i);
    const b = x.purged.has(i) ? null : e.body;
    if (e.verb === "undo" && b && b.undoes !== undefined) x.undone.add(b.undoes);
    if (e.verb === "undo" && b && Array.isArray(b.rollback?.acts)) for (const q of b.rollback.acts) x.undone.add(q);
    if (e.verb !== "undo" && e.actor !== "system") x.lastAct = i;
    if (e.actor === "system" && b && Number.isInteger(b.rest) && typeof b.id === "string" && !x.restAfter.has(`${b.rest}:${b.id}`)) x.restAfter.set(`${b.rest}:${b.id}`, i); }
  if (e.kind === "change") { x.changes.push(i);
    // what the sim writes (a rest) is physics, never an act's undoable result: live, a rest is caused by a launch entry;
    // in an imported world (translate-v1@11) by the old punt's act, which must not make it undoable
    if (Number.isInteger(e.cause) && e.actor !== "sim" && !x.resultOf.has(e.cause)) x.resultOf.set(e.cause, i);
    for (const id of new Set(opsQuiet(e).map((o) => o.id))) { let a = x.touch.get(id); if (!a) x.touch.set(id, (a = [])); a.push(i); }
    const c = E[e.cause]; if (isE(c) && c.kind === "physics" && c.verb === "launch") x.rests.push(i); }
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
    if (x.n >= x.pt && isE(E[x.n]) && E[x.n].kind === "redaction") { const n = x.n; x = fresh(); for (; x.n < n; x.n++) indexEntry(x, E, x.n); } // a purge is retroactive: start over
    indexEntry(x, E, x.n); }
  return x;
}
/** Seed the index for a log whose first `n` lines hold no purge and no malformed line, from a fold cache (server/foldviews.ts). */
export function seedActIndex(w, n, v, st) { w.__actIndex = Object.assign(freshIndex(), v, { n, pt: n, entries: w.entries, bad: malformedSeqs(st) }); }
/** The same index built from nothing over `entries` (the reference the incremental one must equal). */
export function actIndexFresh(entries) { return actIndexOf({ entries }); }
const firstAfter = (a, seq) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= seq) lo = m + 1; else hi = m; } return lo; };
/** A thing as it was just before entry `seq` (= fold(entries, {until: seq - 1}).entities[id]), from its own history
 *  through the index, never the whole log. Purged values are REDACTED at every point in time, as the fold has them. */
export function entityBefore(w, id, seq, x = actIndexOf(w)) {
  let ent = id === "@world" ? { born: 0, c: Object.create(null) } : undefined; // @world is live from genesis (§2.3)
  const E = w.entries; const hist = x.touch.get(id) ?? [];
  for (let k = 0; k < hist.length && hist[k] < seq; k++) { const i = hist[k]; const e = E[i]; const ops = opsQuiet(e); const batch = e.op === "batch";
    ops.forEach((o, j) => { if (o.id !== id) return;
      if (o.op === "create") { if (!ent) ent = { born: i, c: Object.create(null) }; return; }
      if (!ent) return;
      // a value stripped to its commit reads REDACTED whether or not a purge names it, as the fold reads it (§12, commitment-unredacted)
      if (o.op === "set") { if (o.stripped || x.purgedOps.has(`${i}:${batch ? j : "-"}`)) ent.c[o.comp] = REDACTED; else if ("value" in o) ent.c[o.comp] = clone(o.value); return; }
      if (o.comp === undefined) { if (id !== "@world") ent = undefined; return; }
      delete ent.c[o.comp]; }); }
  return ent;
}

// ---------- sky and weather: the sky panel's builders (verbs.js BATCH_VERBS) ----------
function skyValue(prev, verb, args, now) {
  if (!args || typeof args !== "object" || Array.isArray(args)) refuse("shape", `${verb} takes the sky's fields {hours, rate, weather, clouds…}`, "");
  const { dry, ...a } = args;
  const bad = forecastSpellingRefusal(a.forecast, verb); if (bad) refuse(bad.code, bad.reason, bad.fix, { didYouMean: bad.didYouMean });   // the door translates nothing
  const out = clone(foldSkyEntry(prev, { verb, args: a, ts: Math.floor(now), seq: 0, actor: "system" }));
  delete out.seq; delete out.by;
  for (const k of ["forecast", "override"]) if (out[k] && typeof out[k] === "object") { delete out[k].seq; delete out[k].by; }
  return materialize("sky", out).value;   // every parameter written down (the sky's defaults are the registry's)
}
function buildSky(ctx, a, w) { return [setOp("@world", "sky", skyValue(null, "sky", a, w.now()))]; }
function buildWeather(ctx, a, w) { return [setOp("@world", "sky", skyValue(ctx.st.entities["@world"]?.c.sky ?? null, "weather", a, w.now()))]; }
// ---------- undo (by act; the inverse goes through admit like any write: rank and locks NOW) ----------
function buildUndo(ctx, a, w) {
  const X = actIndexOf(w); const E = w.entries;
  const mine = X.actsOf.get(ctx.actor) ?? [];
  const readBody = (seq) => readback(w, seq); // READBACK: a purged act's request can't be read, or matched by label (null: unknown)
  const result = (seq) => { const r = X.resultOf.get(seq); return r === undefined ? undefined : E[r]; };
  // the inverse of one act against `now`: what to write, and what to leave because someone changed it since. A function
  // so an owner's rollback can run it over many acts in a row, each against what the previous inverses left
  const inverseOf = (target, res, now) => {
  const beforeOf = new Map(); const before = (id) => { if (!beforeOf.has(id)) beforeOf.set(id, entityBefore(w, id, target.seq, X)); return beforeOf.get(id); };
  const flat = opsOf(res);
  // what others wrote since: a thing's own later history (touch), and, for the spatial check, every change entry since
  // the result (never the log before it). Later work by anyone but the act's own author stands
  const others = (i) => E[i].actor !== target.actor;
  const touchedBy = (id, comp) => { const h = X.touch.get(id) ?? []; for (let k = firstAfter(h, res.seq); k < h.length; k++) { const e = E[h[k]]; if (!others(h[k])) continue;
    for (const o of opsQuiet(e)) if (o.id === id && (comp === undefined || o.comp === comp || o.comp === undefined || o.op === "create")) return e.actor; } return null; };
  const later = X.changes.slice(firstAfter(X.changes, res.seq)).filter(others).map((i) => E[i]);
  // a host's seats are its socket children (nobody writes a `sockets` key): later work by others on one, deleted ones
  // included, stops undoing the host's creation. A socket made under it counts whichever half (parent, socket) a change
  // sets, when the thing the whole change leaves is a socket under the host
  const socketWorkBy = (host) => {
    for (const i of X.changes.slice(firstAfter(X.changes, res.seq))) { if (!others(i)) continue; const ops = opsQuiet(E[i]);
      for (const o of ops) {
        const was = o.op === "create" ? null : entityBefore(w, o.id, i, X);
        if (was && isSocketC(was.c) && was.c.parent?.to === host) return E[i].actor;
        if (o.op !== "set" || (o.comp !== "parent" && o.comp !== "socket")) continue;
        const now = entityBefore(w, o.id, i + 1, X);
        if (now && isSocketC(now.c) && now.c.parent?.to === host) return E[i].actor; } }
    return null; };
  const groups = [], skipped = [];
  const keys = new Map();
  const madeHere = new Set(flat.filter((o) => o.op === "create").map((o) => o.id)); // undone as one unit: the whole thing goes
  // what the act's delete cleared in others' things (clearRefsTo, the authority's follow-up) comes back as a follow-up
  // too, put back exactly as it was (touchedBy skips it if anyone but the act's author changed it since), so the referrer's lock or key can't
  // veto the undo any more than it could the delete
  // Only an op the target entry itself marks as a follow-up (its `cascade`) is restored as one: the
  // asker's own write in the same batch is theirs, and putting it back meets their rights and the locks now, like any undo.
  const goneHere = new Set(flat.filter((o) => o.op === "delete" && o.comp === undefined).map((o) => o.id));
  const fuHere = new Set([...cascadeOf(res)].map((k) => flat[k]).filter(Boolean));
  const leftoverFU = (o) => fuHere.has(o) && typeof o.comp === "string" && o.comp.startsWith("imported:");
  const ownerOf = new Map(), owned = new Map();
  flat.forEach((o, i) => { if (!leftoverFU(o)) return; const n = idOut(o.comp.slice("imported:".length));
    const fills = (x) => x.id === o.id && typeof x.comp === "string" && !fuHere.has(x) && idOut(x.comp) === n;
    const x = flat.slice(0, i).reverse().find(fills) ?? flat.slice(i + 1).find(fills);
    if (x) { const k = `${o.id}|${x.comp}`; ownerOf.set(o, k); owned.set(k, [...(owned.get(k) ?? []), o]); } });
  const leftoversBack = (id, comp) => (owned.get(`${id}|${comp}`) ?? []).flatMap((o) => {
    const by = touchedBy(o.id, o.comp); if (by) { skipped.push({ id: o.id, component: o.comp, why: `${said(by)} changed it since`, by }); return []; }
    const old = before(o.id)?.c[o.comp]; if (old === REDACTED) return [];
    const g = old === undefined ? (o.comp in (now.entities[o.id]?.c ?? {}) ? delOp(o.id, o.comp) : null) : setOp(o.id, o.comp, old);
    if (g) g[FOLLOW_UP] = true; return g ? [g] : []; });
  const refRestore = (o) => { if (!goneHere.size || !fuHere.has(o) || o.comp === undefined || o.op === "create" || goneHere.has(o.id) || !holdsRefs(o.comp)) return false;
    const old = before(o.id)?.c[o.comp]; return old !== undefined && old !== REDACTED && refsOf(o.comp, old).some((r) => goneHere.has(r.id)); };
  for (const o of flat) { if (madeHere.has(o.id) && o.op !== "create") continue;
    const k = o.id + "|" + (o.op === "set" || (o.op === "delete" && o.comp !== undefined) ? o.comp : "*"); if (!keys.has(k)) keys.set(k, o); }
  for (const [, o] of [...keys].reverse()) {
    const { id, comp } = o; const whole = o.op === "create" || (o.op === "delete" && comp === undefined);
    if (ownerOf.has(o)) continue;
    // work by others on a host's sockets since stops undoing its creation (socketWorkBy)
    const by = touchedBy(id, whole ? undefined : comp) ?? (o.op === "create" ? socketWorkBy(id) : null);
    if (by) { skipped.push({ id, component: comp, why: `${said(by)} changed it since`, by }); continue; }
    // undoing a create: what others hung on it since is THEIR work. It stays, let go where it is, never
    // deleted with it and never left pointing at a thing that's gone
    if (o.op === "create") { if (now.entities[id]) { const kidsOf = (p) => Object.keys(now.entities).filter((k) => now.entities[k].c.parent?.to === p && !madeHere.has(k));
        // its sockets are its parts: they go with it, and what others put in them is let go like the rest
        const parts = kidsOf(id).filter((k) => isSocketC(now.entities[k].c)); const kids = [...kidsOf(id).filter((k) => !parts.includes(k)), ...parts.flatMap(kidsOf)];
        groups.push([...kids.flatMap((k) => [setOp(k, "transform", worldT(now, k)), delOp(k, "parent")]), ...parts.map((k) => delOp(k)), delOp(id)]); kids.forEach((k) => ctx.refs.add(k)); } }
    else if (whole) { const old = before(id); if (old && !now.entities[id]) (ctx.restores ??= new Set()).add(id), groups.push(createOps(id, Object.fromEntries(Object.entries(old.c).filter(([, v]) => v !== REDACTED)))); }
    else { const old = before(id)?.c[comp];
      if (old === REDACTED) { skipped.push({ id, component: comp, why: "its old value was purged" }); continue; }
      if (old === undefined) { if (now.entities[id] && comp in now.entities[id].c) { const g = delOp(id, comp); if (leftoverFU(o)) g[FOLLOW_UP] = true; groups.push([...leftoversBack(id, comp), g]); } }
      else if (now.entities[id]) {
        if (!refRestore(o)) { const g = setOp(id, comp, old); if (leftoverFU(o)) g[FOLLOW_UP] = true; groups.push([...leftoversBack(id, comp), g]); }
        // a follow-up restore names what this undo brings back; a reference to anything else gone since stays cleared
        else { const since = new Set(refsOf(comp, old).map((r) => r.id).filter((x) => !now.entities[x] && !goneHere.has(x)));
          const nv = since.size ? withoutRefs(id, comp, old, since) : old;
          if (since.size) (ctx.notes ??= []).push({ id, component: comp, kept: [...since], why: `${[...since].join(", ")} ${since.size > 1 ? "are" : "is"} gone since, so ${since.size > 1 ? "their references stay" : "its reference stays"} cleared` });
          if (nv !== undefined) { const g = setOp(id, comp, nv); g[FOLLOW_UP] = true; groups.push([g]); } } } }
    ctx.refs.add(id);
  }
  // an undo must not land my old state on someone else's later work (spatial conflict, not just same-component)
  const othersSince = new Set(later.flatMap((e) => opsQuiet(e).map((o) => o.id)));
  for (let i = groups.length - 1; i >= 0; i--) { const g = groups[i]; const o = g.at(-1);
    if (!(g[0].op === "create" || (o.op === "set" && ["transform", "parent"].includes(o.comp)))) continue;
    const trial = scratch(now, g); const mine = obbs(trial, o.id);
    const hit = [...othersSince].find((x) => x !== o.id && trial.entities[x] && obbs(trial, x).some((sb) => mine.some((ma) => satDepth(ma, sb) > 0.02)));
    if (hit) { const who = later.find((e) => opsQuiet(e).some((q) => q.id === hit))?.actor;
      skipped.push({ id: o.id, component: o.comp, why: `putting it back would land it on ${hit}, which ${said(who)} has placed since`, by: who }); groups.splice(i, 1); } }
  return { groups, skipped }; };
  // An act the import's tail lift-sockets rewrote (its value before is the old world's spelling, which the door refuses) can't be undone
  // in part: the whole request refuses, naming the act and its ops
  const isLift = (i) => { const e = E[i], c = E[e.cause]; return e.actor === "system" && isE(c) && c.kind === "request" && c.verb === "lift-sockets" && c.actor === "system"; };
  const liftedOps = (res) => { const lifts = X.changes.slice(firstAfter(X.changes, res.seq)).filter(isLift); if (!lifts.length) return [];
    const ops = opsQuiet(res), hit = [];
    ops.forEach((o, j) => { const whole = o.op === "create" || (o.op === "delete" && o.comp === undefined);
      const by = lifts.find((i) => opsQuiet(E[i]).some((x) => (x.id === o.id && (whole || x.comp === o.comp || x.comp === undefined || x.op === "create"))
        || (o.op === "create" && x.op === "set" && x.comp === "parent" && x.value?.to === o.id)));
      if (by !== undefined) hit.push({ index: j, op: o.op, id: o.id, ...(o.comp !== undefined ? { component: o.comp } : {}), lift: E[by].cause }); });
    return hit; };
  const refuseLifted = (seq) => { const r = X.resultOf.get(seq); const ops = r === undefined ? [] : liftedOps(E[r]); if (!ops.length) return;
    refuse("undo-unavailable", `act ${seq} was imported, and the import rewrote ${ops.map((o) => `op ${o.index} (${o.id}${o.component ? ` ${o.component}` : ""})`).join(", ")} into today's spelling: its old value can't be put back, so nothing is undone`,
      "change it yourself; history shows the imported act and the lift that rewrote it", { cause: "migration-transformed", act: seq, ops }); };
  // an act whose result leaves every thing it touched as it was (set then delete of a component it lacked) changed nothing: not undoable
  const changedNothing = (seq) => { const r = X.resultOf.get(seq); if (r === undefined) return false;
    return [...new Set(opsQuiet(E[r]).map((o) => o.id))].every((id) => JSON.stringify(entityBefore(w, id, r, X)) === JSON.stringify(entityBefore(w, id, r + 1, X))); };
  const pick = (pred) => { for (let k = mine.length - 1; k >= 0; k--) if (pred(mine[k])) return E[mine[k]]; return undefined; };
  // an undo's depth along its `undoes` chain: 0 = an ordinary act, 1 = an undo of one, 2 = a redo (an undo of an undo)…
  // A bare undo takes back my latest live act of EVEN depth: an ordinary act or a redo. Skipping only plain undos keeps
  // Ctrl+Z walking back, while a redo is undone first.
  // READBACK: the chain reads each undo's `undoes`; a purged undo is unknown, read as the index reads it (it undoes nothing
  // we can name: the chain ends there, and its target isn't counted undone)
  const depthOf = (seq) => { let d = 0, q = seq; while (q !== undefined && E[q]?.verb === "undo" && d < 64) { d++; q = readBody(q)?.undoes; } return d; };
  const undoneBy = (seq) => { for (let k = mine.length - 1; k >= 0; k--) if (E[mine[k]].verb === "undo" && readBody(mine[k])?.undoes === seq) return mine[k]; return undefined; };
  // an owner's rollback (CoreProtect's rollback by player and time): undo {actor, since} takes back every
  // act that person made since a version, newest first, each inverse against what the previous ones left; later work by
  // anyone else still stands. It says how many acts it would take back, and above 20 it needs confirm: true.
  if (a.actor !== undefined || a.since !== undefined) {
    if (roleOf(ctx.st, ctx.actor) !== "owner") refuse("rights", "rolling back someone's work needs owner", "undo {act} takes back one act, along rank");
    if (!isIdentity(a.actor) || RESERVED.has(a.actor)) refuse("shape", "rollback is undo {actor, since}: actor is a person's identity", "history shows who did what");
    const from = versionSeq(w, a.since, "since");
    const acts = (X.actsOf.get(a.actor) ?? []).filter((q) => q >= from && X.resultOf.has(q) && !X.undone.has(q) && !["create-world", "undo", "throw", "drop", "leave"].includes(E[q].verb)).reverse();
    if (!acts.length) refuse("nothing", `${said(a.actor)} has made no change since act ${from} that's still in force`, "");
    for (const q of acts) refuseLifted(q);
    if (acts.length > 20 && a.confirm !== true && a.dry !== true) refuse("confirm", `that rolls back ${acts.length} acts by ${said(a.actor)} since act ${from}`, "dry: true lists them; confirm: true does it", { acts: acts.length });
    let st = ctx.st; const all = []; const skippedAll = [], done = [];
    for (const q of acts) { const { groups, skipped } = inverseOf(E[q], result(q), st); const ops = groups.flat();
      skippedAll.push(...skipped); if (ops.length) { all.push(...ops); st = scratch(st, ops); done.push(q); } }
    if (!all.length) refuse("conflict", `everything ${said(a.actor)} did since then has been changed by others since`, "their later work stands");
    if (skippedAll.length) ctx.notes.push({ skipped: skippedAll });
    ctx.actExtra = { rollback: { actor: a.actor, since: from, acts: done } };
    ctx.undid = { kind: "rollback", acts: done.length, of: said(a.actor) };
    return all; }
  // revert goes along rank, never upward. Someone else's act may be undone by a builder (a builder's or a visitor's)
  // or an owner (anyone's, owners included). Roles as they are NOW.
  const othersAct = (seq) => { const e = E[seq]; if (!(isE(e) && e.kind === "request")) return undefined;
    if (RESERVED.has(e.actor)) refuse("rank", `act ${seq} was the authority's own, not a person's`, "undo takes back people's acts");
    // undoing another person's act needs editOthers, and still goes only along rank (custom roles included)
    const me = rankOf(ctx.st, ctx.actor), them = rankOf(ctx.st, e.actor), eo = may(ctx.st, ctx.actor, "editOthers");
    if (!eo || me < them) refuse("rank", `act ${seq} was ${said(e.actor)}'s; ${!eo ? "undoing someone else's work needs a role that may edit others' work (by default, builder and above)" : `they're ${roleOf(ctx.st, e.actor)}, above you`}`, "revert goes along rank, never upward: ask an owner");
    return e; };
  const target = a.act !== undefined ? (mine.includes(a.act) ? E[a.act] : othersAct(a.act))
    : a.label ? pick((q) => readBody(q)?.args?.label === a.label && !X.undone.has(q) && X.resultOf.has(q))
    : pick((q) => E[q].verb !== "create-world" && depthOf(q) % 2 === 0 && !X.undone.has(q) && X.resultOf.has(q) && !changedNothing(q));
  if (!target) { const last = X.lastAct === null ? null : E[X.lastAct];
    refuse("nothing", "nothing of yours to undo" + (last && last.actor !== ctx.actor ? ` (the latest change was ${said(last.actor)}'s; bare undo takes your own; undo {act: <seq>} takes theirs if your rank allows)` : ""), "history shows who did what; to change someone else's work, edit it (they'll see it)"); }
  if (target.verb === "create-world") refuse("founding", "founding a world can't be undone", "§2: @world can't be deleted or undone as a whole; to hand it over, give the new owner their role first");
  if (X.undone.has(target.seq)) { let head = target.seq; const chain = []; for (let i = 0; i < 64; i++) { const u = undoneBy(head); if (u === undefined) break; chain.push(u); head = u; }
    const live = head !== target.seq && depthOf(head) % 2 === 0 ? head : null;
    refuse("nothing", `act ${target.seq} was already undone${chain.length ? ` (by ${chain.map((c) => `${depthOf(c) % 2 ? "undo" : "redo"} ${c}`).join(", then ")})` : ""}`,
      live !== null ? `it's back in force through redo ${live}: undo {act: ${live}} (or a bare undo) takes it back` : "a bare undo takes back your latest change; history shows the chain"); }
  if (["throw", "drop", "leave"].includes(target.verb)) refuse("physical", `that was a ${target.verb}: what it changed is where things came to rest, which physics decided`, "put it back yourself: grab it, then put {id, pos}");
  const res = result(target.seq); if (!res || changedNothing(target.seq)) refuse("nothing", "that act changed nothing", "");
  refuseLifted(target.seq);
  // a raise or a lower comes back out from under whatever was sculpted since (sculptInverse); any other stroke, or one
  // that met the layer's limit, is put back as any write is
  if (target.verb === "sculpt" && TR.ADDITIVE.has(readBody(target.seq)?.args?.brush) && readBody(target.seq)?.clamped !== true) {
    const inv = sculptInverse(w, ctx, target, res, X);
    if (inv) { ctx.actExtra = { undoes: target.seq, inverse: true }; ctx.undid = { act: target.seq, kind: "undo", what: "sculpt" }; ctx.refs.add("@world"); return inv; } }
  const { groups, skipped } = inverseOf(target, res, ctx.st);
  if (!groups.length) refuse("conflict", "everything that act touched has been changed by someone else since", "their later change stands (undo never writes over it); if you still want yours, make the change again yourself, and history shows who did what", { skipped });
  if (skipped.length) ctx.notes.push({ skipped });
  ctx.actExtra = { undoes: target.seq };
  // undoing my own `use` is admitted under the same reaction capability the use was (a visitor may open
  // a door through its handler, so they may close it again by undo), asked for again NOW: no handler, no undo
  const ureq = readBody(target.seq)?.args;
  const ucap = readBody(target.seq)?.capability;
  // …and only while the handler's who still admits them, as a use is judged (a raised who stops future acts, undo included)
  const uh = ureq?.id ? ctx.st.entities[ureq.id]?.c.reactions?.[ucap?.reaction] : undefined;
  if (target.verb === "use" && target.actor === ctx.actor && ucap?.reaction && uh && (!uh.who || admits(ctx.st, ctx.actor, uh.who))) {
    const comps = [...new Set(groups.flat().map((o) => o.comp).filter(Boolean))];
    if (groups.flat().every((o) => o.id === ureq.id && o.comp !== undefined)) { reactionCap(ctx, ureq.id, comps[0], ucap.reaction); ctx.cap.comps = comps;
      ctx.actExtra = { undoes: target.seq, capability: ctx.actExtra.capability }; } }
  // say what came back: which act, what it was, and whether this undoes it or redoes it
  const req = readBody(target.seq)?.args ?? {}; const dz = depthOf(target.seq);
  const base = dz ? (() => { let q = target.seq; for (let i = 0; i < dz; i++) q = readBody(q)?.undoes; return E[q]; })() : target;
  const breq = base ? (readBody(base.seq)?.args ?? {}) : req;
  const what = `${base?.verb ?? target.verb}${breq.id ? ` ${breq.id}` : ""}${breq.component ? ` ${breq.component}` : ""}${breq.label ? ` "${breq.label}"` : ""}`;
  ctx.undid = { act: target.seq, kind: dz % 2 ? "redo" : "undo", what, ...(dz ? { of: base?.seq } : {}) };
  return groups.flat();
}

// ---------- sculpt: one brush stroke on the ground's sculpted layer (verbs.js BATCH_VERBS; shared/protocol/sculpt.js) ----------
const TILE = "terrain-tile:";
const LEVEL = () => new Array(SCULPT.tile ** 2).fill(0);
const tilesAt = (st) => new Map(Object.entries(st.entities["@world"]?.c ?? {}).filter(([k, v]) => k.startsWith(TILE) && Array.isArray(v?.mm)).map(([k, v]) => [k.slice(TILE.length), v.mm]));
// One act per stroke, worked out against the ground AT HEAD (never a client's copy), writing the tiles it changes, whole;
// a tile it leaves level is deleted (a tile that isn't there is level).
function buildSculpt(ctx, a) {
  const t = ctx.st.entities["@world"]?.c.terrain;
  if (!shapeable(t)) refuse("level-ground", `this world's ground is the level floor (${t ? "its terrain is kind flat" : "it has no terrain"}), which nothing sculpts`,
    "give the world a ground that isn't level first: set {id: '@world', component: 'terrain', value: {kind: 'noise', amplitude: 0}} is flat ground you can sculpt (amplitude rolls hills)");
  // with no path the brush works where the asker's body stands, as the authority tracks it (the act records no position:
  // what it wrote says where)
  if (a.path === undefined) { const at = ctx.w.presence?.bodies?.[ctx.actor]?.at;
    if (!Array.isArray(at)) refuse("missing-arg", "sculpt needs a path: you have no body here for the brush to work under", "path: [[x, z], …] in world metres, e.g. path: [[12, -4]]");
    a = { ...a, path: [[at[0], at[2]]] }; }
  const pt = (p) => Array.isArray(p) && p.length === 2 && p.every((n) => isNum(n) && Math.abs(n) <= 100000);
  if (!Array.isArray(a.path) || !a.path.length || a.path.length > TR.MAX_POINTS || !a.path.every(pt)) refuse("shape", `path is [[x, z], …]: 1–${TR.MAX_POINTS} points in world metres`, "one point is a dab where it stands: path: [[12, -4]]");
  if (!(a.radius >= 0.25 && a.radius <= TR.MAX_RADIUS)) refuse("bounds", `radius is ${a.radius}; it must be 0.25–${TR.MAX_RADIUS} (m)`, "a wider change is the terrain's own: a terrain-feature, or its heightmap");
  if (TR.ADDITIVE.has(a.brush) ? !(a.strength > 0 && a.strength <= TR.MAX_STRENGTH) : !(a.strength === undefined || (a.strength > 0 && a.strength <= 1)))
    refuse(a.strength === undefined ? "missing-arg" : "bounds", TR.ADDITIVE.has(a.brush) ? `a ${a.brush} needs strength: how many metres at the path, more than 0 and at most ${TR.MAX_STRENGTH}` : `a ${a.brush}'s strength is how far to go, more than 0 and at most 1 (absent: all the way)`, "e.g. strength: 0.4");
  if (a.height !== undefined && (a.brush !== "flatten" || Math.abs(a.height) > 500)) refuse(a.brush !== "flatten" ? "doesnt-apply" : "bounds", a.brush !== "flatten" ? `height is a flatten's (the height it brings the ground to); a ${a.brush} takes strength` : `height is ${a.height}; it must be within ±500 (m)`, "");
  // Rights and the work's price come BEFORE the work: a stroke is the one write whose building is costly (admit would
  // refuse the tiles it wrote anyway, after the brush had run). What a stroke costs is the samples its path covers, and for
  // a flatten or a smooth each of those reads the ground, feature by feature (a smooth ten times a sample).
  if (!ctx.cap && !may(ctx.st, ctx.actor, "build")) refuse("rights", `sculpting the ground needs builder; you are ${roleOf(ctx.st, ctx.actor)}`, "ask a moderator or an owner for build; help shows your role and permissions", { needs: "build" });
  const g = groundOf(ctx.st);
  { const visits = TR.strokeVisits(a.path, a.radius), reads = TR.strokeReads(a.brush, visits), per = 2 + (shapeParams(groundArgs(ctx.st.entities["@world"]?.c))?.features.length ?? 0);
    spend((visits + reads * per) / 64, `a ${a.brush} over that much ground`, "a shorter path or a smaller radius (a smooth reads the ground ten times a sample; every feature of the ground makes each read dearer)"); }
  const { writes, clamped, tooBig, reached } = TR.applyStroke(tilesAt(ctx.st), a, (x, z) => g.height(x, z));
  if (tooBig) refuse("too-big", "that stroke covers more ground than one stroke may", "a shorter path or a smaller radius; a change that wide is the terrain's own (a terrain-feature, or its heightmap)");
  if (!writes.size) refuse("nothing", !reached ? "the brush reaches no part of the ground there" : TR.ADDITIVE.has(a.brush) ? `the ${a.brush} changes nothing there: every sample it reaches is at the sculpted layer's limit already, or the strength is under a millimetre` : `the ground there is already as a ${a.brush} would leave it`,
    !reached ? "the ground's sculpted layer runs ±2048 m from the world's centre" : "");
  const bytes = [...writes.values()].reduce((n, mm) => n + (mm ? jcs(mm).length + 60 : 60), 0);
  if (bytes > 1000000) refuse("too-big", `that stroke rewrites ${writes.size} tiles of the ground (about ${bytes.toLocaleString("en")} bytes); one change is at most 1 MiB`, "a shorter path or a smaller radius; a change that wide is the terrain's own (a terrain-feature, or its heightmap)");
  ctx.actExtra = { tiles: writes.size, ...(clamped ? { clamped: true } : {}) }; ctx.refs.add("@world");
  const ops = [...writes].map(([k, mm]) => (mm ? setOp("@world", TILE + k, { mm }) : delOp("@world", TILE + k)));
  // what the stroke did where it began: the ground there before and after (m), for whoever can't see it
  const [x0, z0] = a.path[0], mm3 = (h) => Math.round(h * 1000) / 1000;
  ctx.reply = { sculpted: { tiles: writes.size, at: [x0, z0], was: mm3(g.height(x0, z0)), now: mm3(groundOf(scratch(ctx.st, ops)).height(x0, z0)) } };
  if (clamped) ctx.notes.push({ id: "@world", why: `part of the stroke met the sculpted layer's limit (±${SCULPT.limit / 1000} m from the ground under it) and stops there` });
  return ops;
}
// Undo of a raise or a lower writes head − (after − before) per sample, so what was sculpted since stays. That is exact
// only while everything written to these tiles since is an add too: a later raise or lower that stayed inside the layer's
// limit, or the undo of one. After anything else (a flatten or a smooth, which read the ground this stroke had raised; a
// tile written or levelled by hand; a stroke that met the limit), or where the result would pass the limit: null, and the
// undo falls back to putting the tiles back as they were (refused where someone else changed them since).
function sculptInverse(w, ctx, target, res, X) {
  const ops = opsOf(res), mine = new Set(ops.map((o) => o.comp)), E = w.entries, hist = X.touch.get("@world") ?? [];
  for (let n = firstAfter(hist, res.seq); n < hist.length; n++) { const i = hist[n]; if (!opsQuiet(E[i]).some((o) => o.id === "@world" && mine.has(o.comp))) continue;
    const c = E[E[i].cause], b = isE(c) && c.kind === "request" ? readback(w, E[i].cause) : null;   // READBACK: a purged later request is unknown: not exact
    if (!(b && !b.clamped && ((c.verb === "sculpt" && TR.ADDITIVE.has(b.args?.brush)) || (c.verb === "undo" && b.inverse === true)))) return null; }
  // the tiles before the stroke, as it left them and now, each read as the log lets them be read (entityBefore: a purged
  // value is REDACTED there, never the bytes the entry still holds). A tile that isn't there is level; one that can't be
  // read is unknown, and nothing is undone by an unknown amount
  const was = entityBefore(w, "@world", target.seq, X)?.c ?? {}, left = entityBefore(w, "@world", res.seq + 1, X)?.c ?? {}, now = ctx.st.entities["@world"]?.c ?? {}, out = [];
  const read = (c, k) => (c[k] === undefined ? LEVEL() : c[k] === REDACTED ? null : c[k]?.mm);
  for (const o of ops) { if (o.id !== "@world" || !o.comp?.startsWith(TILE) || (o.op !== "set" && o.op !== "delete")) return null;
    const b = read(was, o.comp), a = read(left, o.comp), h = read(now, o.comp);
    if (![b, a, h].every((m) => Array.isArray(m) && m.length === SCULPT.tile ** 2)) return null;   // a purged value, or a tile written by hand in another shape
    const v = h.map((x, k) => x - (a[k] - b[k]));
    if (v.some((x) => x > SCULPT.limit || x < -SCULPT.limit)) return null;
    if (v.every((x, k) => x === h[k])) continue;
    out.push(v.every((x) => x === 0) ? delOp("@world", o.comp) : setOp("@world", o.comp, { mm: v })); }
  if (!out.length) refuse("nothing", "undoing that stroke changes nothing now", "");
  return out;
}
export { buildSculpt, buildSky, buildUndo, buildWeather };
