// v4edit — edit mode's writes in a v4 world (protocol/v4 slice 3b).
//
// In a v4 world every edit is a door REQUEST, the same request an agent sends ({type: 'v4', tool, args}), and the
// person waits for the door's answer: an act number to undo by, or a refusal in the same words an agent gets
// (shared/v4/refusal.js). v1 worlds never reach this file: every caller asks isV4() first and keeps its old path.
//
//   send(req, opts)        one request; on a `locked` refusal by someone who may lift the lock, a centre dialog offers
//                          "Move anyway", which re-sends the SAME request with through_lock: true (§5: the log records
//                          only the edit; the lock stays on). A refusal reverts the local preview.
//   spell(verbs)           today's edit code plans v1 verbs (editschema.js, build.js); this turns them into ONE request
//                          (a single tool, or a batch) with shared/v4/fromv1.js, the mapping the server uses for old
//                          clients and agents' verb tools. One edit is one act, so one Ctrl+Z.
//   expectOf(ids, comps)   §3a: the values a gesture started from, as `expect`. A drag is presence until release; the
//                          release is one request with expect, refused `changed` if anyone wrote those since.
//   undo() / redo()        Ctrl+Z is the door's `undo {act}` of MY last act; redo is `undo {act: <my undo>}`, which the
//                          door refuses when someone changed it since (Figma's rule: never back over later work).
//   del(ids), duplicate(ids), lock(id, on), publish(ids, name), copyBlueprint(hash, at)
import { bus } from './base.js';
import { net, requestV4, v4, isV4, sendDrag } from './net.js';
import { entities } from './world.js';
import { toV4 } from '../../shared/v4/fromv1.js';
import { enc, dec } from '../../shared/v4/names.js';
import { refusalText, lockVerb, lockQuestion, lockChoices } from '../../shared/v4/refusal.js';
import { chooseCenter } from './confirmcenter.js';
import { flashHint, toast } from './ui.js';

export { isV4 };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const idIn = (id) => enc(String(id));
export const idOut = (id) => dec(id) ?? id;

// ---- my acts: what Ctrl+Z and redo walk (seeded at join from the server's act index, so it survives a reload) ----
const undoStack = [];   // my act seqs, newest last
const redoStack = [];   // my undo acts, newest last
bus.on('v4-mine', (m) => { undoStack.splice(0, undoStack.length, ...(Array.isArray(m) ? m : [])); redoStack.length = 0; });
export const stacks = () => ({ undo: [...undoStack], redo: [...redoStack] });

/** A thing's v4 components as this client folds them now (a copy), or null. */
export function compsOf(id) { const e = v4.st?.entities?.[idIn(id)]; return e ? clone({ ...e.c }) : null; }
/** expect entries for these things' components, from `base` (id → comps, a gesture's start) or the fold now. */
export function expectOf(ids, comps, base = null) {
  const out = [];
  for (const id of ids) { const c = base?.[id] ?? compsOf(id); if (!c) continue;
    for (const k of comps) out.push(k in c ? { id: idIn(id), component: k, value: clone(c[k]) } : { id: idIn(id), component: k }); }
  return out;
}

const yawQ = (y) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
const qArg = (a) => (Array.isArray(a?.q) && a.q.length === 4 ? a.q : Number.isFinite(a?.yaw) ? yawQ(a.yaw) : undefined);
/** v1 verbs (as edit code plans them) → one door request, or {refuse} / {noop}. */
export function spell(verbs) {
  const st = v4.st; const ops = [];
  for (const v of verbs) {
    const a = v.args ?? {}; const e = a.id != null ? st.entities[idIn(a.id)] : null;
    // a thing that already rides a parent moves in that parent's frame (what the scene shows it at): set transform,
    // local. A `mount` to the parent it already has is the same move (editschema spells a child's move as a mount).
    const sameParent = v.verb === 'mount' && e?.c.parent?.to === idIn(a.to) && (e.c.parent.slot ?? null) === (a.slot ?? null);
    if ((v.verb === 'place' && e?.c.parent) || sameParent) {
      const t = { ...(e.c.transform ?? {}) };
      const pos = v.verb === 'mount' ? a.offset : a.pos; if (Array.isArray(pos)) t.pos = pos;
      const q = qArg(a); if (q) t.q = q;
      if (Number.isFinite(a.scale)) t.scale = [a.scale, a.scale, a.scale];
      ops.push({ tool: 'set', args: { id: idIn(a.id), component: 'transform', value: t } });
      continue;
    }
    const m = toV4(st, v.verb, a);
    if ('noop' in m) continue;
    if ('refuse' in m) return { refuse: m.refuse };
    if (m.tool === 'batch') ops.push(...m.args.ops); else ops.push(m);
  }
  if (!ops.length) return { noop: true };
  return ops.length === 1 ? ops[0] : { tool: 'batch', args: { ops } };
}
/** The (id, component) pairs a request sets: what a gesture's expect covers. */
export function writesOf(req) {
  const ops = req.tool === 'batch' ? req.args.ops : [req];
  return ops.filter((o) => o.tool === 'set').map((o) => [idOut(o.args.id), o.args.component]);
}

/** May this viewer lift a lock (§5: builders and owners)? The lock question and the Hierarchy's lock icons ask this. */
export const mayLift = () => ['builder', 'owner'].includes(net.myRights?.role);

/** Put a thing back where the log has it (a refused or cancelled gesture), and tell everyone who watched the drag. */
export function revertPose(id) {
  bus.emit('pose-revert', { id });
  const o = entities.get(id); if (!o) return;
  const q = o.quaternion; const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));
  sendDrag(id, [o.position.x, o.position.y, o.position.z], yaw, [q.x, q.y, q.z, q.w]);
}

/** Show a refusal: the same words an agent's tool returns. */
export function showRefusal(what, r) {
  const text = refusalText(what, r);
  toast(text, 'warn', 9000);
  bus.emit('v4-refused', { what, refused: r.refused, text });
  return text;
}

// writes still waiting for the door: Ctrl+Z waits for them, or a quick Ctrl+Z after a release would undo the act BEFORE
// it (the release's act isn't on the stack until its reply arrives)
const inflight = new Set();
const settled = () => Promise.allSettled([...inflight]);
/** One request, waiting for the door. opts: {what, revert(), record = true}. Returns the final reply. */
export function send(req, opts = {}) {
  const p = sendNow(req, opts); inflight.add(p); p.finally(() => inflight.delete(p));
  return p;
}
const remember = (act) => { undoStack.push(act); if (undoStack.length > 200) undoStack.shift(); redoStack.length = 0; };
async function sendNow(req, { what = req.tool, revert = null, record = true } = {}) {
  bus.emit('v4-sending', { req, what });
  let r = await requestV4(req.tool, req.args);
  // A lock (§5, R's dialog): someone who may lift it is asked "This is locked. Move anyway?" —
  //   ✓ through: the SAME request with through_lock: one act, the lock stays on;
  //   ✕ cancel:  nothing is written, and the thing goes back (revert);
  //   🔓 unlock: delete the lock, then the request as it was: two acts on my stack, so Ctrl+Z undoes the edit first.
  //     Undo and redo aren't offered it: their act isn't mine to stack under an unlock (Ctrl+Z would then undo the unlock).
  // A visitor (who may not lift locks) gets the refusal as a toast, no buttons. Another lock further up asks again.
  let cancelled = false;
  for (let round = 0; round < 8 && !r.ok && r.refused?.code === 'locked' && req.args?.through_lock !== true && mayLift(); round++) {
    const verb = lockVerb(req);
    const choices = lockChoices(verb).filter((c) => record || c.v !== 'unlock');
    const choice = await chooseCenter({ title: lockQuestion(verb), body: refusalText(what, r), choices, cancel: 'cancel' });
    bus.emit('v4-lock-asked', { what, yes: choice === 'through', choice });
    if (choice === 'through') { r = await requestV4(req.tool, { ...req.args, through_lock: true }); break; }
    if (choice !== 'unlock') { cancelled = true; break; }
    const k = r.refused.lock;
    const u = await requestV4('delete', { id: k, component: 'lock' });
    if (!u.ok) { r = u; what = `unlock ${idOut(k)}`; break; }
    if (Number.isInteger(u.act)) remember(u.act);
    bus.emit('v4-done', { what: `unlock ${idOut(k)}`, req: { tool: 'delete', args: { id: k, component: 'lock' } }, reply: u });
    r = await requestV4(req.tool, req.args);
  }
  if (r.ok) {
    if (record && Number.isInteger(r.act)) remember(r.act);
    bus.emit('v4-done', { what, req, reply: r });
  } else {
    try { revert?.(); } catch (e) { console.warn('[v4edit] revert', e); }
    if (cancelled) { flashHint('cancelled — nothing written'); bus.emit('v4-cancelled', { what, refused: r.refused }); }
    else showRefusal(what, r);
  }
  return r;
}
/** v1 verbs as one request (spell), sent; expect on what it sets, from `base` (a gesture's start) or now. */
export async function sendVerbsV4(verbs, { what, base = null, expect = true, revert = null } = {}) {
  const req = spell(verbs);
  if (req.noop) return { ok: true, noop: true };
  if (req.refuse) { const r = { ok: false, refused: { code: 'no-v4-spelling', reason: req.refuse, teach: 'the door tool takes the v4 request itself' } }; try { revert?.(); } catch { /* best effort */ } showRefusal(what, r); return r; }
  if (expect) {
    const pairs = writesOf(req); const ids = [...new Set(pairs.map(([i]) => i))];
    const ex = ids.flatMap((i) => expectOf([i], [...new Set(pairs.filter(([j]) => j === i).map(([, k]) => k))], base));
    if (ex.length) req.args = { ...req.args, expect: ex };
  }
  return send(req, { what, revert });
}

// ---- undo / redo: the door's undo-by-act, of my own acts only ----
export async function undo() {
  await settled();
  const act = undoStack.at(-1);
  if (act === undefined) { flashHint('nothing of yours to undo here'); return { ok: false, refused: { code: 'nothing' } }; }
  const r = await send({ tool: 'undo', args: { act } }, { what: 'undo', record: false });
  if (r.ok) { undoStack.pop(); redoStack.push(r.act); flashHint(`undid your act ${act}${r.notes?.some((n) => n.skipped) ? ' (some of it had been changed since: kept theirs)' : ''}`); }
  // a refusal that can never change (already undone, or everything changed since) drops it, so the next Ctrl+Z reaches
  // the act before it; a lock or a rate limit leaves it for another try
  else if (['nothing', 'conflict', 'physical', 'founding'].includes(r.refused?.code)) undoStack.pop();
  return r;
}
export async function redo() {
  await settled();
  const act = redoStack.at(-1);
  if (act === undefined) { flashHint('nothing to redo'); return { ok: false, refused: { code: 'nothing' } }; }
  const r = await send({ tool: 'undo', args: { act } }, { what: 'redo', record: false });
  if (r.ok) { redoStack.pop(); undoStack.push(r.act); flashHint('redone'); }
  else if (['nothing', 'conflict'].includes(r.refused?.code)) redoStack.pop();
  return r;
}

// ---- the whole-thing edits ----
/** Delete things: one id is `delete`, several are one `batch` (one act, one undo). A thing whose ancestor is also
 *  going is left out: the door takes children with their parent. */
export function del(ids) {
  const st = v4.st; const set = new Set(ids.map(idIn));
  const under = (x) => { let p = st.entities[x]?.c.parent?.to, n = 0; while (p && n++ < 32) { if (set.has(p)) return true; p = st.entities[p]?.c.parent?.to; } return false; };
  const go = [...set].filter((x) => st.entities[x] && !under(x));
  if (!go.length) return Promise.resolve({ ok: true, noop: true });
  const req = go.length === 1 ? { tool: 'delete', args: { id: go[0] } } : { tool: 'batch', args: { ops: go.map((id) => ({ tool: 'delete', args: { id } })) } };
  return send(req, { what: go.length === 1 ? `delete ${idOut(go[0])}` : `delete ${go.length} things` });
}
/** Duplicate: create {from: <the thing>} (the door copies it and what's attached to it; 0.5 m along x). */
export function duplicate(id, at = undefined) {
  return send({ tool: 'create', args: { from: idIn(id), ...(at ? { at } : {}) } }, { what: `duplicate ${id}` });
}
/** Lock or unlock: `set lock true` / `delete lock` (§5: the plain lock component, both ways). */
export function lock(id, on) {
  return send(on ? { tool: 'set', args: { id: idIn(id), component: 'lock', value: true } } : { tool: 'delete', args: { id: idIn(id), component: 'lock' } },
    { what: on ? `lock ${id}` : `unlock ${id}` });
}
/** Save as blueprint: the door's `publish {from, name}` (one root, or several siblings as a group). */
export function publish(ids, name) {
  const from = ids.length === 1 ? idIn(ids[0]) : ids.map(idIn);
  return send({ tool: 'publish', args: { from, ...(name ? { name } : {}) } }, { what: `save ${ids.length === 1 ? ids[0] : `${ids.length} things`} as a blueprint` });
}
/** Place a copy of a blueprint in this world's library: create {from: hash, at}. */
export function copyBlueprint(hash, at) {
  return send({ tool: 'create', args: { from: hash, ...(at ? { at } : {}) } }, { what: 'place a copy' });
}
/** This world's library, read from the v4 fold (@world library:<hash> → {name, parts}). */
export function library() {
  const c = v4.st?.entities?.['@world']?.c ?? {};
  return Object.keys(c).filter((k) => k.startsWith('library:')).map((k) => ({ hash: `sha256:${k.slice(8)}`, ...(c[k] && typeof c[k] === 'object' ? c[k] : {}) }));
}
/** Is this thing (or anything it rides) locked, as the door reads it (truthy, a purged value isn't)? */
export function lockedBy(id) {
  const st = v4.st; let x = idIn(id), n = 0;
  while (x && n++ < 33) { const v = st?.entities?.[x]?.c.lock; if (v !== undefined && !(v && v.purged === true) && !!v) return idOut(x); x = st?.entities?.[x]?.c.parent?.to; }
  return null;
}

// harness window: the stacks and the module, for the suites (tools/v4/client-check.ts)
globalThis.__v4edit = () => ({ undo: [...undoStack], redo: [...redoStack], active: isV4() });
