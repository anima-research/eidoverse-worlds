// shared/protocol/authority/blueprints.js — blueprints (publish, update, create {from}, duplicate) and the reads: describe
// (a thing as an accessibility tree) and the read verbs (help, look, inspect, measure, find, lint, history) as READ_VERBS,
// which authority.js spreads into VERBS where they stood (refactor split, 2026-10-17; moved from authority.js's
// "blueprints" and "reads" sections and the VERBS table unchanged). schema stays in VERBS beside the capacity it reports.
// The write path's resolve/mint and the history readers are above it, reached through UP.
import { grabOf, describeGrab } from "../../grab.js";
import { isEntityId, PURGED } from "../fold.js";
import { COMPONENTS, mapRefs } from "../componentspec.js";
import { verbHelp, VERBSPEC } from "../verbspec.js";
import { graphemes } from "../../text.js";
import { saysOf } from "../../says.js";
import { readOut } from "../../a11y.js";
import { livePoses } from "../simlayer.js";
import { r3 } from "../round.js";
import { CTX, UP } from "./ctx.js";
import { refuse, said } from "./refuse.js";
import { modelOf } from "./catalogue.js";
import { readback, clone, createOps, delOp, isE, lockedC, setOp, versionOf, lockLevel } from "./storage.js";
import { aabb, descendants, qrot, surfacesOf, worldT } from "./math.js";
import { kidsMap } from "./spatial.js";
import { isSocketC, socketsOf, socketRole, modelSocketNames } from "./sockets.js";
import { backward, creatorOf, effective, ghostOf, madeBy, roleOf } from "./rights.js";
import { shieldOf } from "./bodyconsent.js";
import { actionsOf, offersFor, pivotOf } from "./use.js";
// the layers above this one (a leaf may not import them: authority-layers-check), reached through UP (ctx.js), which
// authority.js binds at load
const danglingRefs = (...a) => UP.danglingRefs(...a);
const guess = (...a) => UP.guess(...a);
const historyDiff = (...a) => UP.historyDiff(...a);
const lastTouch = (...a) => UP.lastTouch(...a);
const mint = (...a) => UP.mint(...a);
const opsTouching = (...a) => UP.opsTouching(...a);
const resolve = (...a) => UP.resolve(...a);
const touchedOf = (...a) => UP.touchedOf(...a);
const warnings = (...a) => UP.warnings(...a);

// ---------- blueprints ----------
const BLUEPRINTS = "blueprints:";
const blueprintKey = (h) => `${BLUEPRINTS}${String(h).replace(/^sha256:/, "")}`;
const isPublished = (st, h) => !!st.entities["@world"]?.c[blueprintKey(h)];
// References across a copy (review 10-07 H5; RESEARCH-event-wiring §4.3): every typed reference in a components map (its
// parent excepted: copies place parents themselves) through f(id, path) → new id | null (drop) | the same id (keep).
// Returns the components with dropped references removed (a value whose required reference went is removed whole).
function rebindAll(c, f) {
  for (const k of Object.keys(c)) { if (k === "parent" || k === "copy-of") continue;
    const r = mapRefs(k, c[k], (x, at) => f(x, at, k)); if (r.value === undefined) delete c[k]; else c[k] = r.value; }
  return c;
}
// publish: a reference inside what's published becomes that part's key; one outside is refused (a raw id from this world
// means nothing, or something else, wherever the record lands) unless unwire: true, which drops it and says so
function publishLinks(ctx, a, inside, keyOf, partsOf) {
  const outside = [], unwired = [];
  const parts = partsOf((id, c) => rebindAll(c, (x, at) => { if (inside.has(x)) return keyOf(x); if (a.unwire) { unwired.push({ from: `${id}.${at}`, to: x }); return null; } outside.push({ from: `${id}.${at}`, to: x }); return x; }));
  if (outside.length) refuse("outside-link", `${outside.length} link(s) point outside what you're publishing: ${outside.slice(0, 6).map((o) => `${o.from} → ${o.to}`).join(", ")}`,
    "publish those things too (from: [them, …]), or send unwire: true to publish without those links (each is dropped and listed)", { links: outside });
  if (unwired.length) ctx.notes.push({ unwired, why: "these links pointed outside what you published: dropped from the record (unwire: true)" });
  return parts;
}
function buildPublish(ctx, a, w) {
  const roots = Array.isArray(a.from) ? a.from : [a.from];
  for (const r of roots) if (!ctx.st.entities[r]) refuse("not-found", `no '${r}'`, "look lists what's here", { didYouMean: guess(r, Object.keys(ctx.st.entities)) });
  if (roots.length > 1) return publishGroup(ctx, a, w, roots);
  const ids = [a.from, ...descendants(ctx.st, a.from)];
  const keyOf = partKeys(ctx.st, ids, ctx.st.entities[a.from].c["copy-of"]?.from);
  const parts = publishLinks(ctx, a, new Set(ids), keyOf, (fix) => ids.map((id) => { const c = clone(ctx.st.entities[id].c); delete c["copy-of"];
    if (id === a.from) { delete c.parent; c.transform = { ...c.transform, pos: [0, 0, 0] }; }
    else if (c.parent) c.parent = { ...c.parent, to: keyOf(c.parent.to) };
    return { key: keyOf(id), components: fix(id, c) }; }));
  const record = { name: a.name ?? a.from, root: keyOf(a.from), parts, by: ctx.actor };
  const hash = w.putBlob(record);
  ctx.notes.push({ record: hash, parts: parts.length });
  ctx.refs.add("@world");
  return [setOp("@world", blueprintKey(hash), { name: record.name, parts: parts.length })]; // who published it is a view (creatorOf), never stored (L2)
}
function publishGroup(ctx, a, w, roots) {
  // a group of siblings: the record gets a root part at their footprint centre on the ground; the world is untouched
  const all = [...new Set(roots.flatMap((r) => [r, ...descendants(ctx.st, r)]))];
  // re-publishing a group copy's members (siblings under one copy) keeps their keys, as a single publish does
  const up = roots.map((r) => ctx.st.entities[r].c.parent?.to); const lineage = up[0] && up.every((p) => p === up[0]) ? ctx.st.entities[up[0]]?.c["copy-of"]?.from : undefined;
  const keyOf = partKeys(ctx.st, all, lineage, ["root"]);
  const ws = roots.map((r) => worldT(ctx.st, r).pos); const cx = ws.reduce((t, p) => t + p[0], 0) / ws.length, cz = ws.reduce((t, p) => t + p[2], 0) / ws.length;
  const parts = [{ key: "root", components: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, label: a.name } },
    ...publishLinks(ctx, a, new Set(all), keyOf, (fix) => all.map((id) => { const c = clone(ctx.st.entities[id].c); delete c["copy-of"];
      if (roots.includes(id)) { const t = worldT(ctx.st, id); c.transform = { ...t, pos: [r3(t.pos[0] - cx), r3(t.pos[1]), r3(t.pos[2] - cz)] }; c.parent = { to: "root" }; }
      else c.parent = { ...c.parent, to: keyOf(c.parent.to) };
      return { key: keyOf(id), components: fix(id, c) }; }))];
  const record = { name: a.name ?? "group", root: "root", parts, by: ctx.actor };
  const hash = w.putBlob(record); ctx.notes.push({ record: hash, parts: parts.length, roots: roots.length }); ctx.refs.add("@world");
  return [setOp("@world", blueprintKey(hash), { name: record.name, parts: parts.length })]; // who published it is a view (creatorOf), never stored (L2)
}
// A record's part keys, unique within it (review 10-07 N1: a table holding two copies of a published leg got the keys
// [top, leg, leg], and no copy of it could ever be placed). A part keeps the key it was copied as (blueprint.key) only
// when it comes from the same record as what's being published (`lineage`: re-publishing an edited copy, so update {copy,
// to} still matches part to part); a part nested from another record (a leg inside the table) is keyed by its id. Those
// come first, so a nested part never takes a key the lineage needs; a key already taken falls back to the id, then to the
// id with a number. Returns id → key.
function partKeys(st, ids, lineage, reserved = []) {
  const taken = new Set(reserved); const out = new Map();
  const own = (id) => { const b = st.entities[id].c["copy-of"]; return lineage !== undefined && b?.from === lineage && typeof b.key === "string" ? b.key : null; };
  for (const pass of [true, false]) for (const id of ids) { if (out.has(id) || !!own(id) !== pass) continue;
    const want = own(id) ?? id; const k = taken.has(want) ? null : want;
    let key = k ?? (taken.has(id) ? null : id); for (let n = 2; key === null; n++) if (!taken.has(`${id}-${n}`)) key = `${id}-${n}`;
    taken.add(key); out.set(id, key); }
  return (id) => out.get(id) ?? id;
}
// Ids for a copy's parts: minted, so they follow §2.3; which part is which lives in each part's blueprint.key.
// each part of a copy gets a minted id of its own (R 10-17: opaque; a part's id was <copy>-<its key's slug>)
function partIds(st, copy, rootKey, keys) {
  const map = new Map([[rootKey, copy]]); const used = new Set([copy]);
  for (const k of keys) { if (map.has(k)) continue; const id = mint(st, used); used.add(id); map.set(k, id); }
  return map;
}
// Offer a newer record to a copy: per-part, per-component, per-FIELD three-way merge (R13). base = the copy's record,
// mine = the copy now, theirs = the new record. Recorded as plain results; never re-derived on replay.
function buildUpdate(ctx, a, w) {
  const root = ctx.st.entities[a.copy]; if (!root?.c["copy-of"]) refuse("not-a-copy", `${a.copy} isn't a blueprint copy`, "");
  let base, theirs; try { base = w.getBlob(root.c["copy-of"].from); theirs = w.getBlob(a.to); } catch { refuse("not-found", "unknown record", "find {kind: 'blueprint'}"); }
  if (!isPublished(ctx.st, a.to)) refuse("not-published", `${a.to} isn't one of this world's blueprints`, "");
  const have = new Map(); for (const id of [a.copy, ...descendants(ctx.st, a.copy)]) { const k = ctx.st.entities[id].c["copy-of"]?.key; if (k !== undefined && !have.has(k)) have.set(k, id); }
  const fresh = partIds(ctx.st, a.copy, base.root, theirs.parts.map((p) => p.key).filter((k) => !have.has(k)));
  const idOf = (key) => (key === base.root ? a.copy : have.get(key) ?? fresh.get(key));
  // references are merged as values in this world's ids: a part key → its id here (an unknown key is unbound, as on copy).
  // A part's parent too: it merges like any component, so a part reparented upstream is reparented here (Antra's review
  // of f91840e5: the merge skipped parent for every existing part, leaving a reparented part's new local transform under
  // its old parent, 3 m off). The copy's root has no parent in a record (where the copy sits is its own).
  const inIds = (c) => { const o = rebindAll(clone(c), (x) => idOf(x) ?? null); if (o.parent) o.parent = { ...o.parent, to: idOf(o.parent.to) }; return o; };
  const B = Object.fromEntries(base.parts.map((p) => [p.key, inIds(p.components)])), T = Object.fromEntries(theirs.parts.map((p) => [p.key, inIds(p.components)]));
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const ops = [], made = [], conflicts = [], kept = [], orphaned = [];
  const skipComp = new Set(["copy-of", "parent"]);   // "is this gone part still as the record left it?" (copy-of, parent: placement)
  const unmerged = new Set(["copy-of"]);
  for (const key of new Set([...Object.keys(B), ...Object.keys(T)])) {
    const id = idOf(key), mineE = ctx.st.entities[id];
    if (!B[key]) { const c = clone(T[key]); c["copy-of"] = { from: a.to, key };   // its parent is already in ids (inIds)
      made.push(...createOps(id, c)); continue; }   // made first: an existing part may be reparented onto a new one
    if (!T[key]) { if (mineE && Object.keys(B[key]).every((k) => skipComp.has(k) || eq(B[key][k], mineE.c[k]))) ops.push(delOp(id)); else if (mineE) orphaned.push(id); continue; }
    if (!mineE) { kept.push({ id, why: "you deleted it in this copy" }); continue; }
    for (const comp of new Set([...Object.keys(B[key]), ...Object.keys(T[key])])) {
      if (unmerged.has(comp) || (key === base.root && (comp === "transform" || comp === "parent"))) continue;
      const b = B[key][comp], t = T[key][comp], m = mineE.c[comp];
      if (eq(b, t)) continue; // nothing new upstream
      if (eq(m, b)) { ops.push(t === undefined ? delOp(id, comp) : setOp(id, comp, t)); continue; }
      if (eq(m, t)) continue;
      const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
      if (isObj(b) && isObj(t) && isObj(m)) { // field level
        const out = clone(m); const clash = [];
        for (const f of new Set([...Object.keys(b), ...Object.keys(t)])) { if (eq(b[f], t[f])) continue; if (eq(m[f], b[f])) { if (t[f] === undefined) delete out[f]; else out[f] = clone(t[f]); } else if (!eq(m[f], t[f])) clash.push(f); }
        if (clash.length) conflicts.push({ id, component: comp, fields: clash, yours: Object.fromEntries(clash.map((f) => [f, m[f]])), theirs: Object.fromEntries(clash.map((f) => [f, t[f]])) });
        if (!eq(out, m)) ops.push(setOp(id, comp, out)); else if (!clash.length) kept.push({ id, component: comp });
      } else conflicts.push({ id, component: comp, yours: m, theirs: t });
    }
  }
  if (conflicts.length && !a.resolve) refuse("conflicts", `${conflicts.length} part(s) changed both here and upstream`, "re-send with resolve: {\"<id>.<component>.<field>\": \"yours\"|\"theirs\"} or dry: true to see the merge", { conflicts });
  for (const c of conflicts) { const id = c.id; for (const f of c.fields ?? [null]) { const choice = a.resolve?.[f ? `${id}.${c.component}.${f}` : `${id}.${c.component}`] ?? "yours";
      if (choice === "theirs") { const cur = ops.findLast((o) => o.id === id && o.comp === c.component)?.value ?? clone(ctx.st.entities[id].c[c.component]);
        const v = f ? { ...cur, [f]: c.theirs[f] } : c.theirs; ops.push(setOp(id, c.component, v)); } } }
  ops.push(setOp(a.copy, "copy-of", { ...root.c["copy-of"], from: a.to }));
  ops.unshift(...made);
  if (orphaned.length) ctx.notes.push({ orphaned, why: "gone upstream but you changed them here: kept, still yours" });
  if (kept.length) ctx.notes.push({ keptYours: kept });
  for (const o of ops) ctx.refs.add(o.id);
  return ops;
}
// L1: a copy is expanded by the authority into an explicit batch. The fold never reads the record.
function buildCreateFrom(ctx, a) {
  if (a.at !== undefined && (!a.at || typeof a.at !== "object" || Array.isArray(a.at))) refuse("shape", `with from, at is {pos, yaw|q}: got ${JSON.stringify(a.at).slice(0, 80)}`, "create {from, at: {pos: [x, y, z], yaw}}");
  if (typeof a.from === "string" && !a.from.startsWith("sha256:")) return buildDuplicate(ctx, a);
  const w = ctx.w; let rec;
  try { rec = w.getBlob(a.from); } catch { refuse("not-found", `no blueprint ${a.from}`, "find {kind: 'blueprint'} lists this world's blueprints"); }
  if (!isPublished(ctx.st, a.from)) refuse("not-published", `${a.from} isn't one of this world's blueprints`, "publish it here first");
  const id = a.id ?? mint(ctx.st);
  if (!isEntityId(id) || id === "@world") refuse("shape", `'${id}' isn't an id you can make`, "§3.1: a–z, 0–9 and '-', up to 64; or leave id out");
  if (ctx.st.entities[id]) refuse("exists", `'${id}' already exists`, "choose another id for the copy");
  const ids = partIds(ctx.st, id, rec.root, rec.parts.map((p) => p.key));
  // a record published before part keys were unique (N1) may name a key twice: each later twin gets an id of its own
  // (a part that names a twin as its parent rides the first; there's no telling which was meant)
  const seen = new Set(), used = new Set([...ids.values()]); const idAt = rec.parts.map((p) => { if (!seen.has(p.key)) { seen.add(p.key); return ids.get(p.key); }
    const x = mint(ctx.st, used); used.add(x); return x; });
  const ops = [], unbound = [];
  for (const [i, p] of rec.parts.entries()) { const c = clone(p.components);
    if (p.key === rec.root && i === rec.parts.findIndex((q) => q.key === rec.root)) c.transform = resolve(ctx, id, "transform", { ...c.transform, ...(a.at ?? {}) });
    if (c.parent) c.parent = { ...c.parent, to: ids.get(c.parent.to) };
    // a reference to a part key is that part's new id; anything else (a record published before references were typed,
    // naming a raw id of the world it came from) is unbound here, and said: it would mean something else in this world
    rebindAll(c, (x, at) => { if (ids.has(x)) return ids.get(x); unbound.push({ from: `${idAt[i]}.${at}`, was: x }); return null; });
    c["copy-of"] = { from: a.from, key: p.key };
    ops.push(...createOps(idAt[i], c)); ctx.refs.add(idAt[i]); }
  if (unbound.length) ctx.notes.push({ unbound, why: "the record named things that aren't parts of it: those links aren't wired in the copy (set them again)" });
  return ops;
}

// Duplicate (slice 3b; PARITY (b)3): create {from: <a live thing's id>} copies it and everything attached to it, as one
// explicit batch (L1: the fold sees plain creates). The copy keeps the source's parent (a sibling of it), so its
// transform stays local to that parent; `at` replaces fields of the root's transform (local to that parent too), and
// without it the copy sits 0.5 m along x from the source. `lock` isn't copied: a copy is something you're about to
// move. Who made the copy is the create entry's actor (a view, L2).
function buildDuplicate(ctx, a) {
  const st = ctx.st, src = a.from;
  if (src === "@world" || !st.entities[src]) refuse("not-found", `no thing called '${src}' to copy`, "from takes a blueprint hash (sha256:…) or the id of a thing here", { didYouMean: guess(String(src), Object.keys(st.entities)) });
  const all = [src, ...descendants(st, src)];
  const sc = st.entities[src].c;
  const id = a.id ?? mint(st);
  if (!isEntityId(id) || id === "@world") refuse("shape", `'${id}' isn't an id you can make`, "§3.1: a–z, 0–9 and '-', up to 64; or leave id out");
  if (st.entities[id]) refuse("exists", `'${id}' already exists`, "choose another id for the copy");
  const ids = partIds(st, id, src, all);
  const ops = []; let locks = 0; const keptLinks = [];
  for (const sid of all) { const orig = st.entities[sid].c; const c = clone(orig);
    if ("lock" in c) { delete c.lock; locks++; }
    for (const k of Object.keys(orig)) if (orig[k] === PURGED) delete c[k]; // a purged value can't be copied
    if (c.parent && typeof c.parent.to === "string") c.parent = { ...c.parent, to: ids.get(c.parent.to) ?? c.parent.to };
    // every typed reference to something copied now points at its twin (a lamp that looks at its own switch looks at the
    // copy's switch; a script's scope drives the copy, never the original); one to something else is kept, and listed
    rebindAll(c, (x, at) => { if (ids.has(x)) return ids.get(x); keptLinks.push({ from: `${ids.get(sid)}.${at}`, to: x, why: `${x} wasn't copied` }); return x; });
    if (sid === src) { const t = { ...COMPONENTS.transform.defaults, ...(c.transform ?? {}) };
      c.transform = resolve(ctx, id, "transform", a.at ?? { pos: [t.pos[0] + 0.5, t.pos[1], t.pos[2]] }, t); }
    ops.push(...createOps(ids.get(sid), c)); ctx.refs.add(ids.get(sid)); }
  ctx.notes.push({ copied: src, as: id, parts: all.length, ...(locks ? { why: "a lock isn't copied: the copy is free to move" } : {}), ...(keptLinks.length ? { keptLinks } : {}) });
  return ops;
}

// a thing in a refusal's words: its label and its id (R 10-17: an id is opaque; the label is what a reader calls it)
const thingSaid = (st, id) => { const l = st?.entities?.[id]?.c?.label; return typeof l === "string" && l.trim() ? `${l.trim()} (${id})` : id; };
// ---------- reads ----------
// R 10-07: a thing reads like an accessibility tree (PROTOCOL §4): its name, its description (alt text; a look clips it,
// inspect has it whole), then what it can do and its state, generated from its components by shared/a11y.js, the reading
// mcpl's look and the inspector share
function describe(st, id, live = {}, holds = {}, { full = false } = {}) {
  const e = st.entities[id]; const t = worldT(st, id); const g = grabOf(e.c); const name = e.c.label ?? modelOf(e.c.model)?.label ?? e.c.model ?? id;
  const ax = readOut(e.c, { name, heldBy: holds[id] ? said(holds[id].by) : null, sockets: socketsOf(st, id) });
  const desc = ax.description == null ? null : full || graphemes(ax.description) <= 200 ? ax.description : `${[...ax.description].slice(0, 200).join("")}… (inspect for all)`;
  return { id, name, ...(desc ? { description: desc } : {}), ...(ax.can.length ? { can: ax.can } : {}), ...(ax.state.length ? { state: ax.state } : {}), at: t.pos.map((n) => Math.round(n * 100) / 100),
    ...(live[id] ? { moving: live[id] } : {}), ...(holds[id] ? { heldBy: holds[id].by, heldAt: holds[id].pose.pos.map((n) => Math.round(n * 100) / 100), ...(holds[id].hand ? { heldIn: holds[id].hand } : {}) } : {}),
    ...(g ? { grab: describeGrab(g, typeof name === "string" ? name : id) } : {}),
    ...(actionsOf(st, id).length ? { actions: actionsOf(st, id) } : {}), ...socketsLine(st, id), ...(e.c.parent ? { in: e.c.parent.to } : {}), ...(lockedC(e.c) ? { lock: e.c.lock === true ? true : { rank: lockLevel(e.c.lock) } } : {}), ...(e.c.openable && typeof e.c.openable === "object" ? { openable: e.c.openable } : {}),
    ...sayOf(st, e.c) };
}
const socketsLine = (st, id) => { const socks = socketsOf(st, id).filter((x) => x.id); return socks.length ? { sockets: socks.map((x) => ({ id: x.id, name: x.name, as: socketRole(st.entities[x.id].c) })) } : {}; };
// batch 2: what its words and media say (shared/says.js, the same lines mcpl's look prints); things it names by their names
const sayOf = (st, c) => { const lines = saysOf(c, { nameOf: (x) => (st.entities[x] ? st.entities[x].c.label ?? modelOf(st.entities[x].c.model)?.label ?? x : said(x)), now: CTX.mintW?.now?.() ?? null });
  return lines.length ? { says: lines } : {}; };

const READ_VERBS = {
  help(w, actor, a) {
    if (a?.verb) return verbHelp(a.verb) ? { ok: true, ...verbHelp(a.verb) } : { ok: false, refused: { code: "no-detail", reason: `no detailed help for '${a.verb}' yet`, fix: `detailed: ${Object.keys(VERBSPEC).join(", ")}` } };
    const st = w.exists ? w.state() : null; const role = st ? roleOf(st, actor) : "none"; const eff = st ? effective(st, actor) : null;
    return { ok: true, world: st?.entities?.["@world"]?.c.about, you: { id: actor, role, ...(eff ? { rank: eff.rank, permissions: eff.permissions } : {}) },
      verbs: { read: ["look", "inspect {id}", "measure {id}", "find {kind: 'model'|'blueprint', query?}", "lint {id?}", "history {id?, limit?, before?, after?, verbs?}", "schema {component?}"],
        world: ["create-world {title, text?} — found this world if it doesn't exist (you become its owner)"],
        write: ["create {model?, components?, id?: '$name'} | {from: <blueprint hash | a thing to duplicate>, at?} — the authority mints ids; a '$name' placeholder names the new thing within one request (the reply's ids map it)", "set {id, component, value, merge?}", "delete {id} | {id, component}",
          "place {id, on|beside|hang|against|near|at, facing?, height?, along?, level?, offset?, side?, gap?, attach?}", "turn {id, axis, deg, space?: object|parent|world, about?: pivot|origin}", "batch {ops: [{verb, args}…], label?}", "use {id, action?, args?}", "say {text, to?}",
          "undo {label?|act?}: a bare undo takes back your latest change (a redo first); the reply names what it undid", "publish {from, name}", "update {copy, to, resolve?}"],
        people: ["warn {who, reason}", "mute {who, minutes, channels?: ['voice','chat'], reason?} / unmute {who}", "kick {who, minutes?, reason?} (default 10, ≤ 60)", "ban {who, days?, reason?} (≤ 30 days below owner; owners: leave days out for until lifted) / unban {who}",
          "ghost {on} (you: unseen, no interaction or chat) | ghost {who, minutes, reason?} / unghost {who}", "modlog {who?, before?, limit?}", "bans {}", "who may: your permissions (you.permissions); act only on ranks below yours"],
        scripts: ["upload {text} → src (JavaScript; docs/SCRIPTS.md)", "set {id, component: 'script:<name>', value: {src, scope, on, every?, knobs?}}", "scripts {id?} — what runs here and why not", "scripts {id, script, test: {on: 'use'}} — a dry run", "adopt {id, script, base?} — become a dormant script's sponsor"],
        body: ["move {to: [x, y, z]}", "grab {id, hand?, grip?}", "put {id, pos?}", "throw {id, v: [x, y, z], pos?}", "drop {id, pos?, hand?}", "use {id} while holding it: its grabbable.use (args {phase: 'up'} for the release)", "punt {id, power? | v?}", "leave", "wait"],
        physics: "the world runs physics when @world has a physics-engine component: set {id: '@world', component: 'physics-engine', value: {engine: 'eidosim@1.0.0'}} (owner). A thing can be picked up when it has a grabbable component (schema {component: 'grabbable'}: who may, grips, where it goes when let go, use while held), or physics {kind: 'dynamic', who?}. Grabbable makes it carryable; physics makes it fall", every_write: "may add dry: true to preview, expect: [{id, component, value?}] to be refused (code changed) if any of those isn't what you started from, and throughLock: true to act through a lock you may remove (§7: a lock stops accidents and binds everyone, its locker included)", details: "help {verb: 'place'} (or create, set, delete, use, grab, put, throw, punt) shows every argument with its type and an example" },
      world: st?.entities?.["@world"]?.c.about ?? { name: w.name } };
  },
  look(w, actor, a) {
    const st = w.state(); const ids = Object.keys(st.entities).filter((k) => k !== "@world" && !st.entities[k].c.parent);
    const lim = a.limit ?? 40;
    const live = livePoses(w.sim());
    // the tree in the same order as ever, through the index's children map; only what's shown is described (review 10-06:
    // a child scan per node and a description of every thing made look O(N²) on a big world)
    // a socket is listed with its host (describe's sockets), not as a thing; what sits in it shows at its place
    const kids = kidsMap(st); const order = []; const tree = (id, d, n = 0) => { if (n > 64) return; const sock = isSocketC(st.entities[id]?.c); if (!sock) order.push([id, d]); for (const k of kids.get(id) ?? []) tree(k, sock ? d : d + 1, n + 1); };
    ids.forEach((id) => tree(id, 0));
    const all = order.slice(0, lim).map(([id, d]) => ({ ...describe(st, id, live, w.presence.holds), depth: d })); const total = order.length;
    // a ghost's body is unseen by everyone else (review 10-07)
    // consent is each person's own (consent gaps 6a, R 10-17 02:45): a viewer sees THEIR table, and who poses, drags or touches
    // them; of anyone else only where they stand, plus what the viewer is doing to them. Another body's stranger cells and
    // pause would undo the uniform refusal words (a stranger who reads touch: everyone and is then refused learns they
    // personally are denied), and who touches whom is nobody else's business
    const P = w.presence; const bodies = Object.entries(P.bodies).filter(([id]) => id === actor || !ghostOf(w, id)).map(([id, b]) => ({ id, at: b.at,
      ...(id === actor ? { shield: shieldOf(P, id) } : {}),
      ...(b.poseBy && (id === actor || b.poseBy === actor) ? { posedBy: b.poseBy } : {}), ...(b.draggedBy && (id === actor || b.draggedBy === actor) ? { draggedBy: b.draggedBy } : {}),
      touchedBy: Object.entries(P.reaches ?? {}).filter(([k, r]) => r.to === id && (id === actor || k === actor)).map(([k]) => k) }));
    return { ok: true, things: all.slice(0, lim), ...(total > lim ? { truncated: true, total } : {}), bodies };
  },
  inspect(w, actor, a) {
    const st = w.state(); const e = st.entities[a.id];
    if (!e) return { ok: false, refused: { code: "not-found", reason: `no '${a.id}'`, didYouMean: guess(String(a.id), Object.keys(st.entities)) } };
    const piv = e.c.motion?.type === "pendulum" ? pivotOf(st, a.id) : undefined;
    return { ok: true, ...describe(st, a.id, livePoses(w.sim()), w.presence.holds, { full: true }), born: e.born, components: e.c, versions: Object.fromEntries(Object.keys(e.c).map((k) => [k, versionOf(w, lastTouch(w, a.id, k)?.seq)])), touched: touchedOf(w, a.id, Object.keys(e.c)), world: worldT(st, a.id),
      derived: { madeBy: madeBy(w, a.id), ...(piv !== undefined ? { pivot: piv } : {}), ...(modelOf(e.c.model)?.credits ? { asset: modelOf(e.c.model).credits } : {}) },
      children: Object.keys(st.entities).filter((k) => st.entities[k].c.parent?.to === a.id), ...offersFor(st, a.id, actor), yourRole: roleOf(st, actor) };
  },
  measure(w, actor, a) {
    const st = w.state(); const b = aabb(st, a.id); if (!b) return { ok: false, refused: { code: "no-model", reason: `${a.id} has no model or mesh to measure` } };
    const t = worldT(st, a.id);
    return { ok: true, id: a.id, bounds: { min: b.min.map(r3), max: b.max.map(r3) }, size: b.max.map((v, i) => r3(v - b.min[i])),
      front: qrot(t.q, [0, 0, 1]).map(r3), surfaces: surfacesOf(st, a.id).map((s) => ({ level: s.level, y: r3(s.y), size: [r3(s.max[0] - s.min[0]), r3(s.max[1] - s.min[1])] })) };
  },
  find(w, actor, a) {
    const q = (a.query ?? "").toLowerCase();
    if (a.kind === "blueprint") { const lib = w.state().entities["@world"]?.c ?? {};
      return { ok: true, blueprints: Object.entries(lib).filter(([k]) => k.startsWith(BLUEPRINTS)).map(([k, v]) => ({ hash: `sha256:${k.slice(BLUEPRINTS.length)}`, ...v, by: creatorOf(w, "@world", k)?.rights ?? null })).filter((b) => String(b.name ?? "").toLowerCase().includes(q)) }; }
    return { ok: true, models: CTX.cat.list(q).slice(0, 50).map(([k, m]) => ({ model: k, ...(m.size ? { size: m.size } : { size: null, note: "not measured here" }), about: m.label, surfaces: (m.surfaces ?? []).map((s) => s.y), ...(modelSocketNames(m) ? { seats: modelSocketNames(m) } : {}) })) };
  },
  lint(w, actor, a) { const st = w.state(); const ids = a.id ? [a.id] : Object.keys(st.entities);
    return { ok: true, warnings: [...warnings(st, ids, true), ...danglingRefs(st, ids)] }; },
  history(w, actor, a) {
    // one thing's history, newest first, paged backwards (R 10-04: recent by default, deeper on request): before = the seq
    // to continue from (the reply's `next`), limit = how many acts per page
    if (a.id != null) {
      if (a.verbs !== undefined || a.after !== undefined) refuse("shape", "one thing's history pages back with before only", "leave id out to filter the whole log by verbs, or page it with after");
      const id = String(a.id); const lim = Math.max(1, Math.min(50, a.limit ?? 5)); const before = a.before ?? Infinity; const out = [];
      let next = null;
      for (const i of backward(w, id)) { if (i >= before) continue; const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue;
        const ops = opsTouching(e, id); if (!ops.length) continue;
        if (out.length === lim) { next = out.at(-1).seq; break; }
        const act = Number.isInteger(e.cause) ? w.entries[e.cause] : null;
        // an imported act reads as what it was (spawn, place, comp), never "imported" (batch 2: Credits in History)
        out.push({ seq: i, by: e.actor, who: said(e.actor), ts: e.ts, verb: (isE(act) && act.kind === "act" ? (act.verb === "imported" && typeof act.body?.verb === "string" ? act.body.verb : act.verb) : null) ?? ops[0].verb,
          changed: [...new Set(ops.map((o) => o.verb === "create" ? "(created)" : o.verb === "delete" && o.comp === undefined ? "(deleted)" : o.comp))],
          ...(() => { const d = historyDiff(w, id, i, ops); return d ? { diff: d } : {}; })(),
          ...(isE(act) && readback(w, e.cause)?.undoes !== undefined ? { undoes: readback(w, e.cause).undoes } : {}), ...(Number.isInteger(e.cause) ? { act: e.cause } : {}) }); }
      return { ok: true, id, entries: out, ...(next !== null ? { next, more: "send the same with before: next for older" } : {}) };
    }
    // the whole world's log, a page at a time (Commons audit, agents #3: `verbs` and `before` reached nobody). verbs
    // matches an entry's verb or kind, and an imported act's original verb (its body names it); before/after page by seq
    if (a.verbs !== undefined && !(Array.isArray(a.verbs) && a.verbs.length <= 32 && a.verbs.every((v) => typeof v === "string"))) refuse("shape", "verbs is a list of verb names (at most 32)", "e.g. history {verbs: ['set', 'use']} — an imported entry matches its original verb too ('comp', 'mount')");
    if (a.before !== undefined && a.after !== undefined) refuse("shape", "page one way: before or after, not both", "before: older than that seq (the reply's next); after: newer than it");
    const lim = Math.max(1, Math.min(200, a.limit ?? 12)); const vs = a.verbs?.length ? new Set(a.verbs) : null;   // [] = no filter
    const ghost = !!ghostOf(w, actor); // a ghost can't read chat (PLAN 10-06): says leave the page
    const match0 = (e) => !vs || !isE(e) ? !vs : vs.has(e.verb) || vs.has(e.kind) || (e.verb === "imported" && vs.has(e.body?.verb));
    const match = (e) => match0(e) && !(ghost && isE(e) && e.kind === "say");
    const row = (e, seq) => isE(e) ? { seq, actor: e.actor, ts: e.ts, kind: e.kind, verb: e.verb, ...(e.cause !== undefined ? { cause: e.cause } : {}), body: e.kind === "act" || e.kind === "say" ? e.body : JSON.stringify(e.body).slice(0, 160) } : { seq, malformed: e.code };
    const out = []; let more = false;
    if (a.after !== undefined) { for (let i = Math.max(0, a.after + 1); i < w.entries.length; i++) { if (!match(w.entries[i])) continue; if (out.length === lim) { more = true; break; } out.push(row(w.entries[i], i)); } }
    else { for (let i = Math.min(w.entries.length, a.before ?? Infinity) - 1; i >= 0; i--) { if (!match(w.entries[i])) continue; if (out.length === lim) { more = true; break; } out.push(row(w.entries[i], i)); } out.reverse(); }
    return { ok: true, entries: out, ...(more ? a.after !== undefined ? { next: out.at(-1).seq, more: "send after: next for newer" } : { next: out[0].seq, more: "send before: next for older" } : {}) }; },
};
export { READ_VERBS, buildCreateFrom, buildPublish, buildUpdate, thingSaid };
