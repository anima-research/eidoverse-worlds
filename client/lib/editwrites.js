// editwrites — edit mode's writes.
//
// Every edit is a REQUEST, the same request an agent sends ({type: 'request', verb, args}), and the person waits for
// the authority's answer: an act number to undo by, or a refusal in the same words an agent gets (shared/protocol/refusal.js).
//
//   send(req, opts)        one request; on a `locked` refusal by someone who may lift the lock, a centre dialog offers
//                          "Move anyway", which re-sends the SAME request with throughLock: true (§5: the log records
//                          only the edit; the lock stays on). A refusal reverts the local preview.
//   sendOps(ops, opts)     an edit's ops (shared/protocol/requests.js, planned by editschema.js, build.js…) as ONE request (a
//                          single tool, or a batch): one edit is one act, so one Ctrl+Z.
//   expectOf(ids, comps)   §3a: the values a gesture started from, as `expect`. A drag is presence until release; the
//                          release is one request with expect, refused `changed` if anyone wrote those since.
//   undo() / redo()        Ctrl+Z is the authority's `undo {act}` of MY last act; redo is `undo {act: <my undo>}`, which the
//                          authority refuses when someone changed it since (Figma's rule: never back over later work).
//   del(ids), duplicate(ids), lock(id, on), publish(ids, name), copyBlueprint(hash, at)
import { bus } from './base.js';
import { net, sendRequest, replica, replicaActive, sendDrag } from './net.js';
import { entities } from './world.js';
import * as OP from '../../shared/protocol/requests.js';
import { enc, dec, actorName } from '../../shared/protocol/names.js';
import { refusalText, lockVerb, lockQuestion, lockChoices, lockBody } from '../../shared/protocol/refusal.js';
import { plain, warnPlain, nameOf as thingName } from './plainwords.js';
import { chooseCenter } from './confirmcenter.js';
import { chooseXR, xrActive } from './xrask.js';
import { flashHint, toast, claimStatus } from './ui.js';
import { isOwner } from '../../shared/protocol/roles.js';

export { replicaActive };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const idIn = (id) => enc(String(id));
export const idOut = (id) => dec(id) ?? id;
/** a person's display name for an actor id (the authority directory's, via names.js; never the log's) */
export const nameOf = (id) => actorName(id);

// ---- my acts: what Ctrl+Z and redo walk (seeded at join from the server's act index, so it survives a reload) ----
const undoStack = [];   // my act seqs, newest last
const redoStack = [];   // my undo acts, newest last
bus.on('my-acts', (m) => { undoStack.splice(0, undoStack.length, ...(Array.isArray(m) ? m : [])); redoStack.length = 0; });
export const stacks = () => ({ undo: [...undoStack], redo: [...redoStack] });

/** A thing's components as this client folds them now (a copy), or null. */
export function compsOf(id) { const e = replica.st?.entities?.[idIn(id)]; return e ? clone({ ...e.c }) : null; }
/** expect entries for these things' components, from `base` (id → comps, a gesture's start) or the fold now. */
export function expectOf(ids, comps, base = null) {
  const out = [];
  for (const id of ids) { const c = base?.[id] ?? compsOf(id); if (!c) continue;
    for (const k of comps) out.push(k in c ? { id: idIn(id), component: k, value: clone(c[k]) } : { id: idIn(id), component: k }); }
  return out;
}

/** The (id, component) pairs a request sets: what a gesture's expect covers. */
export function writesOf(req) {
  const ops = req.verb === 'batch' ? req.args.ops : [req];
  return ops.filter((o) => o.verb === 'set').map((o) => [idOut(o.args.id), o.args.component]);
}

/** May this viewer lift a lock (§5: builders and owners)? The lock question and the Hierarchy's lock icons ask this. */
// may I lift a lock (so the page offers "move anyway")? A member never does (decided by the role:
// client-check's member case drives a member by the role alone); any other role by its build switch (a moderator, a custom role).
// The authority decides either way; this only chooses between the dialog and the refusal.
export const mayLift = () => { const r = net.myRights; if (!r) return false;
  return Array.isArray(r.permissions) ? r.permissions.includes('build') : isOwner(r); };   // recut B1: the build permission, never a role name

/** Put a thing back where the log has it (a refused or cancelled gesture), and tell everyone who watched the drag. */
export function revertPose(id) {
  bus.emit('pose-revert', { id });
  const o = entities.get(id); if (!o) return;
  const q = o.quaternion; const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));
  sendDrag(id, [o.position.x, o.position.y, o.position.z], yaw, [q.x, q.y, q.z, q.w]);
}

/** Show a refusal in a person's words (plainwords.js: no code, no tool syntax, things by their labels). The authority's whole
 *  answer, as an agent's tool returns it, goes to the console and rides the event as agentText. */
export function showRefusal(what, r) {
  const text = plain(what, r), agentText = refusalText(what, r);
  console.info('[editwrites] refused:', agentText);
  toast(text, 'warn', 9000);
  bus.emit('edit-refused', { what, refused: r.refused, text, agentText });
  return text;
}
/** Show the authority's warnings on a write that went through (it overlaps, it floats…): they were only ever shown to agents. */
export function showWarnings(what, r) {
  const ws = Array.isArray(r?.warnings) ? r.warnings.filter((w) => w && w.kind !== 'unchecked') : [];
  if (!ws.length) return null;
  const text = `Done, but ${ws.slice(0, 3).map(warnPlain).join('; ')}${ws.length > 3 ? ` (and ${ws.length - 3} more)` : ''}`;
  claimStatus('warn', { priority: 3, content: text, ttl: 6000 });   // on the one status bar, about what I just did (not a toast: DESIGN-status-bar.md)
  bus.emit('edit-warned', { what, warnings: ws, text });
  return text;
}

// writes still waiting for the authority: Ctrl+Z waits for them, or a quick Ctrl+Z after a release would undo the act BEFORE
// it (the release's act isn't on the stack until its reply arrives)
const inflight = new Set();
const settled = () => Promise.allSettled([...inflight]);
/** One request, waiting for the authority. opts: {what, revert(), record = true}. Returns the final reply. */
export function send(req, opts = {}) {
  const p = sendNow(req, opts); inflight.add(p); p.finally(() => inflight.delete(p));
  return p;
}
const dropAct = (stack, act) => { const i = stack.lastIndexOf(act); if (i >= 0) stack.splice(i, 1); };
const remember = (act) => { undoStack.push(act); if (undoStack.length > 200) undoStack.shift(); redoStack.length = 0; };
async function sendNow(req, { what = req.verb, revert = null, record = true } = {}) {
  bus.emit('edit-sending', { req, what });
  let r = await sendRequest(req.verb, req.args);
  // A lock (§5, R's dialog): someone who may lift it is asked "This is locked. Move anyway?" —
  //   ✓ through: the SAME request with throughLock: one act, the lock stays on;
  //   ✕ cancel:  nothing is written, and the thing goes back (revert);
  //   🔓 unlock: delete the lock, then the request as it was: two acts on my stack, so Ctrl+Z undoes the edit first.
  //     Undo and redo aren't offered it: their act isn't mine to stack under an unlock (Ctrl+Z would then undo the unlock).
  // A member (who may not lift locks) gets the refusal as a toast, no buttons. Another lock further up asks again.
  let cancelled = false;
  // a lock above your level (lock {rank}, R 10-07: refused with mayLift: false) isn't yours to go through or lift: its
  // refusal shows as words, no buttons
  for (let round = 0; round < 8 && !r.ok && r.refused?.code === 'locked' && r.refused?.mayLift !== false && req.args?.throughLock !== true && mayLift(); round++) {
    const verb = lockVerb(req);
    // a delete or a replace through a lock is the destructive answer: styled so, and NOT the one Enter gives (S1)
    const destructive = verb === 'Delete' || verb === 'Replace';
    const choices = lockChoices(verb).filter((c) => record || c.v !== 'unlock').map((c) => (destructive && c.v === 'through' ? { ...c, danger: true } : c));
    console.info('[editwrites] lock:', refusalText(what, r));
    const choice = await (xrActive() ? chooseXR : chooseCenter)({ title: lockQuestion(verb), body: lockBody(r, req.args?.id, thingName), choices, cancel: 'cancel', ...(destructive ? { focus: 'cancel' } : {}) });   // a DOM card isn't drawn in a headset (xrask.js)
    bus.emit('edit-lock-asked', { what, yes: choice === 'through', choice });
    if (choice === 'through') { r = await sendRequest(req.verb, { ...req.args, throughLock: true }); break; }
    if (choice !== 'unlock') { cancelled = true; break; }
    const k = r.refused.lock;
    const u = await sendRequest('delete', { id: k, component: 'lock' });
    if (!u.ok) { r = u; what = `unlock ${idOut(k)}`; break; }
    if (Number.isInteger(u.act)) remember(u.act);
    bus.emit('edit-done', { what: `unlock ${idOut(k)}`, req: { verb: 'delete', args: { id: k, component: 'lock' } }, reply: u });
    r = await sendRequest(req.verb, req.args);
  }
  if (r.ok) {
    if (record && Number.isInteger(r.act)) remember(r.act);
    bus.emit('edit-done', { what, req, reply: r });
    showWarnings(what, r);
  } else {
    try { revert?.(); } catch (e) { console.warn('[editwrites] revert', e); }
    if (cancelled) { flashHint('cancelled — nothing written'); bus.emit('edit-cancelled', { what, refused: r.refused }); }
    else showRefusal(what, r);
  }
  return r;
}
/** A gesture's ops (shared/protocol/requests.js) as ONE request — one act, one Ctrl+Z — sent and waited for; `expect` covers
 *  what it sets, as this viewer saw it at `base` (a gesture's start: id → components) or now. */
export async function sendOps(ops, { what, base = null, expect = true, revert = null } = {}) {
  const req = OP.batch(Array.isArray(ops) ? ops : [ops]);
  if (!req) return { ok: true, noop: true };
  if (expect) {
    const pairs = OP.writesOf(req); const ids = [...new Set(pairs.map(([i]) => i))];
    const ex = ids.flatMap((i) => expectOf([idOut(i)], [...new Set(pairs.filter(([j]) => j === i).map(([, k]) => k))], base));
    if (ex.length) req.args = { ...req.args, expect: ex };
  }
  return send(req, { what, revert });
}

// ---- undo / redo: the authority's undo-by-act, of my own acts only ----
// one press at a time: two quick Ctrl+Z's both read the same top act, the second is refused "already undone", and the
// refusal pop then threw away the act BELOW it, never undone (review 10-14 K1). Presses queue; a drop checks the top.
let turn = Promise.resolve();
const inTurn = (fn) => { const r = turn.then(fn, fn); turn = r.catch(() => {}); return r; };
export function undo() { return inTurn(undo1); }
export function redo() { return inTurn(redo1); }
async function undo1() {
  await settled();
  const act = undoStack.at(-1);
  if (act === undefined) { flashHint('nothing of yours to undo here'); return { ok: false, refused: { code: 'nothing' } }; }
  const r = await send({ verb: 'undo', args: { act } }, { what: 'undo', record: false });
  // by value, not the top: an edit sent while this undo was in flight may have pushed its act above this one
  if (r.ok) { dropAct(undoStack, act); redoStack.push(r.act); flashHint(`undid your act ${act}${r.notes?.some((n) => n.skipped) ? ' (some of it had been changed since: kept theirs)' : ''}`); }
  // a refusal that can never change (already undone, or everything changed since) drops it, so the next Ctrl+Z reaches
  // the act before it; a lock or a rate limit leaves it for another try
  else if (['nothing', 'conflict', 'physical', 'founding'].includes(r.refused?.code) && undoStack.at(-1) === act) undoStack.pop();
  return r;
}
async function redo1() {
  await settled();
  const act = redoStack.at(-1);
  if (act === undefined) { flashHint('nothing to redo'); return { ok: false, refused: { code: 'nothing' } }; }
  const r = await send({ verb: 'undo', args: { act } }, { what: 'redo', record: false });
  if (r.ok) { dropAct(redoStack, act); undoStack.push(r.act); flashHint('redone'); }
  else if (['nothing', 'conflict'].includes(r.refused?.code) && redoStack.at(-1) === act) redoStack.pop();
  return r;
}

// ---- the whole-thing edits ----
/** Delete things: one id is `delete`, several are one `batch` (one act, one undo). A thing whose ancestor is also
 *  going is left out: the authority takes children with their parent. */
export function del(ids) {
  const st = replica.st; const set = new Set(ids.map(idIn));
  const under = (x) => { let p = st.entities[x]?.c.parent?.to, n = 0; while (p && n++ < 32) { if (set.has(p)) return true; p = st.entities[p]?.c.parent?.to; } return false; };
  const go = [...set].filter((x) => st.entities[x] && !under(x));
  if (!go.length) return Promise.resolve({ ok: true, noop: true });
  const req = go.length === 1 ? { verb: 'delete', args: { id: go[0] } } : { verb: 'batch', args: { ops: go.map((id) => ({ verb: 'delete', args: { id } })) } };
  return send(req, { what: go.length === 1 ? `delete ${idOut(go[0])}` : `delete ${go.length} things` });
}
/** Duplicate: create {from: <the thing>} (the authority copies it and what's attached to it; 0.5 m along x). */
export function duplicate(id, at = undefined) {
  return send({ verb: 'create', args: { from: idIn(id), ...(at ? { at } : {}) } }, { what: `duplicate ${id}` });
}
/** Lock or unlock: `set lock true` / `delete lock` (§5: the plain lock component, both ways). */
export function lock(id, on) {
  return send(on ? { verb: 'set', args: { id: idIn(id), component: 'lock', value: true } } : { verb: 'delete', args: { id: idIn(id), component: 'lock' } },
    { what: on ? `lock ${id}` : `unlock ${id}` });
}
/** Save as blueprint: the authority's `publish {from, name}` (one root, or several siblings as a group). */
export function publish(ids, name) {
  const from = ids.length === 1 ? idIn(ids[0]) : ids.map(idIn);
  return send({ verb: 'publish', args: { from, ...(name ? { name } : {}) } }, { what: `save ${ids.length === 1 ? ids[0] : `${ids.length} things`} as a blueprint` });
}
/** Place a copy of one of this world's blueprints: create {from: hash, at}. */
export function copyBlueprint(hash, at) {
  return send({ verb: 'create', args: { from: hash, ...(at ? { at } : {}) } }, { what: 'place a copy' });
}
/** This world's blueprints, read from the fold (@world blueprints:<hash> → {name, parts}). */
export function blueprints() {
  const c = replica.st?.entities?.['@world']?.c ?? {};
  return Object.keys(c).filter((k) => k.startsWith('blueprints:')).map((k) => ({ hash: `sha256:${k.slice('blueprints:'.length)}`, ...(c[k] && typeof c[k] === 'object' ? c[k] : {}) }));
}
/** Is this thing (or anything it rides) locked, as the authority reads it (truthy, a purged value isn't)? */
export function lockedBy(id) {
  const st = replica.st; let x = idIn(id), n = 0;
  while (x && n++ < 33) { const v = st?.entities?.[x]?.c.lock; if (v !== undefined && !(v && v.purged === true) && !!v) return idOut(x); x = st?.entities?.[x]?.c.parent?.to; }
  return null;
}

// harness window: the stacks and the module, for the suites (tools/protocol/client-check.ts)
globalThis.__editWrites = () => ({ undo: [...undoStack], redo: [...redoStack], active: replicaActive() });

/** Set home here (R, 10-10): where each selected thing goes back to when a reset sends it home: where it stands now. */
export function setHomeHere(ids) {
  const ops = ids.map((id) => { const c = compsOf(id); if (!c) return null; const t = c.transform ?? {};
    return OP.set(id, 'home', { pos: (t.pos ?? [0, 0, 0]).slice(), q: (t.q ?? [0, 0, 0, 1]).slice(), ...(c.parent?.to ? { parent: { to: c.parent.to } } : {}) }); }).filter(Boolean);
  return ops.length ? sendOps(ops, { what: ids.length > 1 ? `set ${ids.length} homes here` : `set ${ids[0]}'s home here` }) : Promise.resolve({ ok: true, noop: true });
}
/** Make a reset button: the button's reactions gain 'reset', sending the targets home (each gets a home where it stands, by the authority). */
export function makeResetButton(button, targets) {
  const c = compsOf(button) ?? {}; const reactions = { ...(c.reactions ?? {}), reset: { kind: 'reset', targets: targets.map(idIn) } };
  return sendOps([OP.set(button, 'reactions', reactions)], { what: `make ${button} a reset button for ${targets.length} thing${targets.length > 1 ? 's' : ''}` });
}
/** One component written whole (the grip editor's grabbable), with expect, undoable. */
export function setComp(id, comp, value, what) { return sendOps([OP.set(id, comp, value)], { what }); }
