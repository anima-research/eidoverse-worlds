// shared/protocol/authority/blueprints.js — blueprints: publish, update, create {from}, duplicate (the read verbs are reads.js).
// The write path's resolve/mint are above it, reached through UP.
import { isEntityId, REDACTED } from "../fold.js";
import { isObj } from "../is.js";
import { COMPONENTS, mapRefs } from "../componentspec.js";
import { r3 } from "../round.js";
import { UP } from "./ctx.js";
import { refuse, said } from "./refuse.js";
import { clone, createOps, delOp, setOp } from "./storage.js";
import { descendants, worldT } from "./math.js";
import { creatorOf } from "./rights.js";
// the layers above this one, reached through UP (ctx.js; a leaf may not import them: authority-layers-check)
const guess = (...a) => UP.guess(...a);
const mint = (...a) => UP.mint(...a);
const resolve = (...a) => UP.resolve(...a);

// ---------- blueprints ----------
const BLUEPRINTS = "blueprints:";
const blueprintKey = (h) => `${BLUEPRINTS}${String(h).replace(/^sha256:/, "")}`;
const isPublished = (st, h) => !!st.entities["@world"]?.c[blueprintKey(h)];
// References across a copy: every typed reference in a components map (its
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
  const from = roots[0];   // a one-element list is that one root
  const ids = [from, ...descendants(ctx.st, from)];
  const keyOf = partKeys(ctx.st, ids, ctx.st.entities[from].c["copy-of"]?.from);
  const parts = publishLinks(ctx, a, new Set(ids), keyOf, (fix) => ids.map((id) => { const c = clone(ctx.st.entities[id].c); delete c["copy-of"];
    if (id === from) { delete c.parent; c.transform = { ...c.transform, pos: [0, 0, 0] }; }
    else if (c.parent) c.parent = { ...c.parent, to: keyOf(c.parent.to) };
    return { key: keyOf(id), components: fix(id, c) }; }));
  const record = { name: a.name ?? from, root: keyOf(from), parts, by: ctx.actor };
  const hash = w.putBlob(record);
  ctx.notes.push({ record: hash, parts: parts.length });
  ctx.refs.add("@world");
  return [setOp("@world", blueprintKey(hash), { name: record.name, parts: parts.length })]; // who published it is a view (creatorOf), never stored on @world (the record blob carries `by`: the copy's provenance)
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
  return [setOp("@world", blueprintKey(hash), { name: record.name, parts: parts.length })]; // who published it is a view (creatorOf), never stored on @world (the record blob carries `by`: the copy's provenance)
}
// A record's part keys, unique within it (a table holding two copies of a published leg). A part keeps the key it was
// copied as only when it comes from the same record (`lineage`, so update {copy, to} still matches part to part); a part
// nested from another record is keyed by its id. Lineage keys are assigned first; a taken key falls back to the id, then
// to the id with a number. Returns id → key.
function partKeys(st, ids, lineage, reserved = []) {
  const taken = new Set(reserved); const out = new Map();
  const own = (id) => { const b = st.entities[id].c["copy-of"]; return lineage !== undefined && b?.from === lineage && typeof b.key === "string" ? b.key : null; };
  for (const pass of [true, false]) for (const id of ids) { if (out.has(id) || !!own(id) !== pass) continue;
    const want = own(id) ?? id; const k = taken.has(want) ? null : want;
    let key = k ?? (taken.has(id) ? null : id); for (let n = 2; key === null; n++) if (!taken.has(`${id}-${n}`)) key = `${id}-${n}`;
    taken.add(key); out.set(id, key); }
  return (id) => out.get(id) ?? id;
}
// Ids for a copy's parts: minted and opaque (§2.3); which part is which lives in each part's copy-of.key.
function partIds(st, copy, rootKey, keys) {
  const map = new Map([[rootKey, copy]]); const used = new Set([copy]);
  for (const k of keys) { if (map.has(k)) continue; const id = mint(st, used); used.add(id); map.set(k, id); }
  return map;
}
// Offer a newer record to a copy: per-part, per-component, per-FIELD three-way merge (R13). base = the copy's record,
// mine = the copy now, theirs = the new record. Recorded as plain results; never re-derived on replay.
function buildUpdate(ctx, a, w) {
  const root = ctx.st.entities[a.copy]; if (!root?.c["copy-of"]) refuse("not-a-copy", `${a.copy} isn't a blueprint copy`, "update offers a newer record to a copy placed from a blueprint; inspect shows a copy's copy-of");
  let base, theirs; try { base = w.getBlob(root.c["copy-of"].from); theirs = w.getBlob(a.to); } catch { refuse("not-found", "unknown record", "find {kind: 'blueprint'}"); }
  if (!isPublished(ctx.st, a.to)) refuse("not-published", `${a.to} isn't one of this world's blueprints`, "find {kind: 'blueprint'} lists this world's blueprints");
  const have = new Map(); for (const id of [a.copy, ...descendants(ctx.st, a.copy)]) { const k = ctx.st.entities[id].c["copy-of"]?.key; if (k !== undefined && !have.has(k)) have.set(k, id); }
  const fresh = partIds(ctx.st, a.copy, base.root, theirs.parts.map((p) => p.key).filter((k) => !have.has(k)));
  const idOf = (key) => (key === base.root ? a.copy : have.get(key) ?? fresh.get(key));
  // references are merged as values in this world's ids: a part key → its id here (an unknown key is unbound, as on copy).
  // A part's parent too: it merges like any component, so a part reparented upstream is reparented here. The copy's
  // root has no parent in a record (where the copy sits is its own).
  const inIds = (c) => { const o = rebindAll(clone(c), (x) => idOf(x) ?? null); if (o.parent) o.parent = { ...o.parent, to: idOf(o.parent.to) }; return o; };
  const B = Object.fromEntries(base.parts.map((p) => [p.key, inIds(p.components)])), T = Object.fromEntries(theirs.parts.map((p) => [p.key, inIds(p.components)]));
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const ops = [], made = [], conflicts = [], kept = [], orphaned = [];
  const unstamp = (k, v) => (k === "physics" && v && typeof v === "object" && !Array.isArray(v) ? (({ shape, ...rest }) => rest)(v) : v);
  const onlyStamp = (k, v) => k === "physics" && eq(Object.keys(unstamp(k, v) ?? {}), ["kind"]) && (v.kind === "static" || v.kind === "kinematic");
  const skipComp = new Set(["copy-of", "parent"]);   // "is this gone part still as the record left it?" (copy-of, parent: placement)
  const unmerged = new Set(["copy-of"]);
  for (const key of new Set([...Object.keys(B), ...Object.keys(T)])) {
    const id = idOf(key), mineE = ctx.st.entities[id];
    if (!B[key]) { const c = clone(T[key]); c["copy-of"] = { from: a.to, key };   // its parent is already in ids (inIds)
      made.push(...createOps(id, c)); continue; }   // made first: an existing part may be reparented onto a new one
    // a part the newer version drops goes only if this copy left it as it came: each component it came with unchanged, and
    // none added since. What the authority stamps isn't this copy's change: physics.shape is its measure
    // of the model, and physics {kind: static | kinematic, shape} alone is what it gives every modelled thing in a world that
    // runs physics (followups.js stampShapes)
    if (!T[key]) { if (mineE && Object.keys(B[key]).every((k) => skipComp.has(k) || eq(unstamp(k, B[key][k]), unstamp(k, mineE.c[k]))) && Object.keys(mineE.c).every((k) => skipComp.has(k) || Object.hasOwn(B[key], k) || onlyStamp(k, mineE.c[k]))) ops.push(delOp(id)); else if (mineE) orphaned.push(id); continue; }
    if (!mineE) { kept.push({ id, why: "you deleted it in this copy" }); continue; }
    for (const comp of new Set([...Object.keys(B[key]), ...Object.keys(T[key])])) {
      if (unmerged.has(comp) || (key === base.root && (comp === "transform" || comp === "parent"))) continue;
      const b = B[key][comp], t = T[key][comp], m = mineE.c[comp];
      if (eq(b, t)) continue; // nothing new upstream
      if (eq(m, b)) { ops.push(t === undefined ? delOp(id, comp) : setOp(id, comp, t)); continue; }
      if (eq(m, t)) continue;
      if (isObj(b) && isObj(t) && isObj(m)) { // field level
        const out = clone(m); const clash = [];
        for (const f of new Set([...Object.keys(b), ...Object.keys(t)])) { if (eq(b[f], t[f])) continue; if (eq(m[f], b[f])) { if (t[f] === undefined) delete out[f]; else out[f] = clone(t[f]); } else if (!eq(m[f], t[f])) clash.push(f); }
        if (clash.length) conflicts.push({ id, component: comp, fields: clash, yours: Object.fromEntries(clash.map((f) => [f, m[f]])), theirs: Object.fromEntries(clash.map((f) => [f, t[f]])) });
        if (!eq(out, m)) ops.push(setOp(id, comp, out)); else if (!clash.length) kept.push({ id, component: comp });
      } else conflicts.push({ id, component: comp, yours: m, theirs: t });
    }
  }
  if (conflicts.length && !a.resolve) refuse("conflicts", `${conflicts.length} part(s) changed both here and upstream`, "re-send with resolve: {\"<id>.<component>.<field>\": \"yours\"|\"theirs\"} for a field, or {\"<id>.<component>\": …} for a whole value; conflicts lists each one with yours and theirs", { conflicts });
  // a resolve names every one of these conflicts, each "yours" or "theirs": a key that matches none, another word, or a
  // conflict left out would otherwise silently mean yours, so each is refused instead (null reads as no resolve)
  if (a.resolve != null) { const keys = new Set(conflicts.flatMap((c) => (c.fields ? c.fields.map((f) => `${c.id}.${c.component}.${f}`) : [`${c.id}.${c.component}`])));
    const res = a.resolve && typeof a.resolve === "object" && !Array.isArray(a.resolve) ? a.resolve : null;
    if (!res) refuse("shape", "resolve is an object of conflict keys", "resolve: {\"<id>.<component>.<field>\": \"yours\"|\"theirs\"}", { conflicts });
    const bad = Object.entries(res).filter(([k, v]) => !keys.has(k) || (v !== "yours" && v !== "theirs"));
    if (bad.length) refuse("shape", `resolve names ${bad.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")}, which ${bad.length === 1 ? "isn't" : "aren't"} one of this update's conflicts with "yours" or "theirs"`,
      keys.size ? `this update's conflict keys: ${[...keys].join(", ")}` : "this update has no conflicts: leave resolve out", { conflicts });
    const missing = [...keys].filter((k) => !Object.hasOwn(res, k));
    if (missing.length) refuse("shape", `resolve leaves out ${missing.join(", ")}: once you resolve, name every conflict`, `add each as "yours" or "theirs"; conflicts lists each one with yours and theirs`, { conflicts }); }
  for (const c of conflicts) { const id = c.id; for (const f of c.fields ?? [null]) { const choice = a.resolve?.[f ? `${id}.${c.component}.${f}` : `${id}.${c.component}`] ?? "yours";
      if (choice === "theirs") { const cur = ops.findLast((o) => o.id === id && o.comp === c.component)?.value ?? clone(ctx.st.entities[id].c[c.component]);
        const v = f ? { ...cur, [f]: c.theirs[f] } : c.theirs; ops.push(setOp(id, c.component, v)); } } }
  ops.push(setOp(a.copy, "copy-of", { ...root.c["copy-of"], from: a.to }));
  // every part of this lineage still in the record advances with the root (partKeys keys only the root record's parts by
  // key). A part nested from another record keeps its own lineage; one gone upstream (orphaned) is no longer the record's.
  const was = root.c["copy-of"].from;
  for (const [key, id] of have) { const c = ctx.st.entities[id]?.c["copy-of"];
    if (id !== a.copy && T[key] && c?.from === was) ops.push(setOp(id, "copy-of", { ...c, from: a.to })); }
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
  // a record published before part keys were unique may name a key twice: each later twin gets an id of its own
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

// Duplicate: create {from: <a live thing's id>} copies it and everything attached to it as one explicit batch (L1). The
// copy is a sibling of the source; `at` replaces fields of the root's (local) transform, else it sits 0.5 m along x.
// `lock` isn't copied: a copy is something you're about to move. Who made it is the create entry's actor (L2).
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
    for (const k of Object.keys(orig)) if (orig[k] === REDACTED) delete c[k]; // a purged value can't be copied
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

// a thing in a refusal's words: its label and its id (an id is opaque; the label is what a reader calls it)
const thingSaid = (st, id) => { const l = st?.entities?.[id]?.c?.label; return typeof l === "string" && l.trim() ? `${l.trim()} (${id})` : id; };
export { BLUEPRINTS, buildCreateFrom, buildPublish, buildUpdate, thingSaid };
