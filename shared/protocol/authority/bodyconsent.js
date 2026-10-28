// shared/protocol/authority/bodyconsent.js — body consent: every act on another body is gated here, before delivery, and
// the BODY_VERBS (consent, body, reach, inbox) answer for it (refactor split, 2026-10-17; moved from authority.js's "body
// consent" section unchanged). Presence only: nothing here is ever appended. The body's own track (body, dist, gripPoint)
// lives in the physics section above it, reached through UP.
import * as C from "../consent.js";
import { REACH, BODY_REACH } from "../physconst.js";
import { r3 } from "../round.js";
import { UP } from "./ctx.js";
import { refuse } from "./refuse.js";
import { isScriptActor } from "./rights.js";
// the layers above this one (a leaf may not import them: authority-layers-check), reached through UP (ctx.js), which
// authority.js binds at load
const body = (...a) => UP.body(...a);
const dist = (...a) => UP.dist(...a);
const gripPoint = (...a) => UP.gripPoint(...a);

// ---------- body consent (PROTOCOL §5; R 10-28: two gates and two lists). Presence only: none of this is ever appended. ----------
// The authority keeps every body's table (consent.js) beside `bodies` and `holds`, refuses BEFORE delivery, and keeps an
// unlogged attempt ring. Delivery is the target's `inbox` (the server forwards it to their socket).
const ringPush = (P, r) => { (P.ring ??= []).push(r); if (P.ring.length > 200) P.ring.shift(); };
// bounded like ring (review 10-14 C2: browsers never drain it). Each message carries `n`, its person's own count, which
// survives both the cap's trimming and `inbox` draining it: the server forwards by `n`, never by the array's length (holes
// review 10-15 H1: a full queue stayed at 200, and its person heard nothing more)
const inboxPush = (P, who, m) => { const n = ((P.inboxN ??= {})[who] ?? 0) + 1; P.inboxN[who] = n; const q = (P.inbox ??= {})[who] ??= []; q.push({ ...m, n }); if (q.length > 200) q.shift(); };
const bodyRef = (x) => (typeof x === "string" ? x.replace(/^body:/, "") : x);
// 42 §4.13 item 4: five refusals of one class from three distinct targets in 5 min puts the actor on a 10-minute
// cool-down for that class, world-wide, written as an automatic action in the MODERATOR log. Never a ban.
// `to` may be several bodies: one blast's refusals are ONE attempt (R 10-28), its people all counted as refusing
function noteRefusal(w, from, to, cls, now) { const P = w.presence; (P.refusals ??= []).push({ ts: now, from, to, cls }); P.refusals = P.refusals.filter((r) => now - r.ts < 300000);
  const mine = P.refusals.filter((r) => r.from === from && r.cls === cls), people = new Set(mine.flatMap((r) => [].concat(r.to))).size;
  if (mine.length >= 5 && people >= 3 && !(P.throttle?.[`${from}:${cls}`] > now)) {
    (P.throttle ??= {})[`${from}:${cls}`] = now + 600000; w.appendMod({ actor: "system", verb: "auto-cooldown", who: from, class: cls, minutes: 10, why: `${mine.length} refusals of ${cls} from ${people} people in 5 min` }); } }
/** A blast's refused bodies (bodyGate with uncounted), counted toward the cool-down once for the whole blast. */
export function noteBlastRefusals(w, from, tos, cls) { if (tos.length) noteRefusal(w, from, tos, cls, w.now()); }
const COOL_FIX = "leave people be who haven't opened to you; this lifts by itself";
// The TARGET hears a refusal too (parity with main's "X tried to knock you over"): body-refused {from, class, gate} in their
// own inbox, once per (asker, target) per C.TRIED_NOTE_MS, whatever the asker tries meanwhile. The asker never sees it.
function tellTarget(w, from, to, cls, d) { const P = w.presence, now = w.now(), key = `${from}>${to}`, n = (P.triedNotes ??= {});
  for (const [k, t] of Object.entries(n)) if (now - t >= C.TRIED_NOTE_MS) delete n[k];
  if (n[key] > now - C.TRIED_NOTE_MS) return false;
  n[key] = now; inboxPush(P, to, { type: "body-refused", from, class: cls, gate: d.gate ?? null }); w.presenceDirty = true; return true; }
/** The relay refused `from`'s act on `to` itself (server/messages.ts bodyRefusal: a puppet or a grab): the target is told as
 *  above. Decided again here, so the notice names the gate that answered. Returns whether it was said now. */
export function noteRefused(w, from, to, cls) { syncDefault(w); const d = C.decide(w.presence, from, to, cls); return d.mode === "deny" && tellTarget(w, from, to, cls, d); }
// The gate for every act on another body. extra: { cls?, spec?, script?, sponsor?, uncounted? (the caller counts: a blast) }.
function bodyGate(w, from, to, kind, extra = {}) { syncDefault(w);
  const P = w.presence, now = w.now(); to = bodyRef(to); const cls = extra.cls ?? C.KIND_CLASS[kind];
  if (!cls) return { ok: false, code: "shape", reason: `no body kind '${kind}'`, fix: Object.keys(C.KIND_CLASS).join(", ") };
  if (!P.bodies[to]) return { ok: false, code: "not-here", reason: `${to} isn't here` };
  if (from === to) return { ok: true, consent: "self", deliver: () => deliver(w, from, to, kind, cls, extra) };
  if (P.throttle?.[`${from}:${cls}`] > now) { ringPush(P, { ts: now, from, to, cls, verdict: "refused" }); w.presenceDirty = true;
    return { ok: false, code: "cool-down", class: cls, reason: `${from} is on a cool-down for ${cls} after repeated refusals (moderator log)`, fix: COOL_FIX }; }
  const d = decideAs(P, from, extra.sponsor, to, cls);
  if (d.mode === "deny") { if (!extra.uncounted) noteRefusal(w, from, to, cls, now); tellTarget(w, from, to, cls, d); ringPush(P, { ts: now, from, to, cls, verdict: "refused", why: d.why }); w.presenceDirty = true;
    return { ok: false, code: "consent", class: cls, reason: C.refusalWords(to, cls), fix: C.REFUSAL_FIX }; }   // the why is the target's (ring) only
  return { ok: true, consent: "allowed", deliver: () => { ringPush(P, { ts: now, from, to, cls, verdict: "allowed" }); deliver(w, from, to, kind, cls, extra); } };
}
// The relay's question about a reach DESCRIPTOR (shared/reachwire.js: a hand streamed in a pose toward another body, design
// review 10-15 item 1): may `from`'s hand rest on `to` as `cls` (touch | intimate) right now? Asked per presence packet, so it
// is presence only: nothing is appended, and the refusal counter that leads to a moderator-log cool-down is NOT fed (a stream
// of frames is one attempt, not fifty). Admitted when `to`'s table says allow; decided again at every packet, so a gate
// closing or a block ends it. A refusal is said to the reacher in the body inbox, and to the target's attempt ring, once per
// (from, to, cls) per C.REACH_NOTE_MS; `noted` says whether it was now. The target is told (tellTarget); `told` says whether now.
export function reachAdmits(w, from, to, cls, { point = null, limb = null, quiet = false } = {}) { syncDefault(w);
  const P = w.presence, now = w.now();
  if (from === to) return { ok: true, consent: "self" };
  if (cls !== "touch" && cls !== "intimate") return { ok: false, code: "shape", class: cls, reason: `a reach is touch or intimate, not '${cls}'` };
  const held = P.reaches?.[from];
  let r, toldTarget = false;
  if (P.throttle?.[`${from}:${cls}`] > now) r = { code: "cool-down", reason: `${from} is on a cool-down for ${cls} after repeated refusals (moderator log)`, fix: COOL_FIX };
  else { const d = C.decide(P, from, to, cls);
    if (d.mode === "allow") { if (held?.to === to) held.seen = true;   // landed: a hand let go of ends the record (reachLetGo)
      return { ok: true, consent: "allowed" }; }
    if (held?.to === to) delete P.reaches[from];   // recorded under a table that no longer admits it: not under way
    if (!quiet) toldTarget = tellTarget(w, from, to, cls, d);
    r = { code: "consent", reason: C.refusalWords(to, cls), fix: C.REFUSAL_FIX, why: d.why }; }
  const key = `${from}>${to}:${cls}`, notes = (P.reachNotes ??= {});
  for (const [k, t] of Object.entries(notes)) if (now - t >= C.REACH_NOTE_MS) delete notes[k];
  const noted = !quiet && !(notes[key] > now - C.REACH_NOTE_MS);   // quiet: the server re-holding a standing pose, not an attempt
  const { why: cause, ...told } = r; r = told;
  if (noted) { notes[key] = now; ringPush(P, { ts: now, from, to, cls, verdict: "refused (reach not relayed)", ...(cause ? { why: cause } : {}) });
    inboxPush(P, from, { type: "reach-refused", to, class: cls, ...(point ? { point } : {}), ...(typeof limb === "string" ? { limb } : {}), why: r.reason, fix: r.fix, code: r.code }); w.presenceDirty = true; }
  return { ok: false, class: cls, ...r, noted, told: toldTarget };
}
// F3 (a): the relay, after gating one packet of `from`'s: `aimed` is the set of bodies a limb that RELAYED in it rests on.
// A touch on record whose hand has landed (`seen`) and that no relayed limb rests on now was let go: its record ends.
export function reachLetGo(w, from, aimed) {
  const P = w.presence, g = P.reaches?.[from];
  if (!g?.to || !g.seen || aimed.has(g.to)) return false;
  delete P.reaches[from]; w.presenceDirty = true; return true;
}
const forgetReaches = (P, who) => { for (const [k, r] of Object.entries(P.reaches ?? {})) if (k === who || r?.to === who) delete P.reaches[k]; };
/** what `to`'s table says to `from` for `cls`: a behaviour that neither list names is answered by its sponsor's
 *  scripts-by: entry, when a list has one. Admission and revocation both ask here, so they agree on what stands. */
function decideAs(P, from, sponsor, to, cls) {
  const t = C.tableOf(P, to), named = (who) => t.allow.includes(who) || t.block.includes(who);
  return isScriptActor(from) && sponsor && !named(from) && named(`scripts-by:${sponsor}`) ? C.decide(P, `scripts-by:${sponsor}`, to, cls) : C.decide(P, from, to, cls);
}
function deliver(w, from, to, kind, cls, extra) {
  const P = w.presence, b = P.bodies[to];
  const sponsor = extra.sponsor ? { sponsor: extra.sponsor } : {};
  // who posed you, never the pose: the pose travels on the presence plane from the poser's client; a copy here was never read (recut A4)
  if (cls === "pose") { b.poseBy = from; if (extra.sponsor) b.poseSponsor = extra.sponsor; else delete b.poseSponsor; }
  if (cls === "displace") { b.draggedBy = from; if (extra.sponsor) b.dragSponsor = extra.sponsor; else delete b.dragSponsor; }
  if (cls === "shove") b.tumble = { by: from, ts: w.now() };
  // a touch under way is recorded (touchedBy, revokeAfter); the relay decides it again at every packet (review of #260, house Q1)
  if (cls === "touch" || cls === "intimate") (P.reaches ??= {})[from] = { to, cls, point: extra.spec?.point ?? null, ...sponsor };
  inboxPush(P, to, { type: "body", from, kind, cls, consent: from === to ? "self" : "allowed", ...(extra.spec ? { spec: extra.spec } : {}) }); w.presenceDirty = true;
}
// The world's body-default (@world.body-default: {move?, touch?}), read where a decision is made: absent = DEFAULT_GATES.
function syncDefault(w) { const v = w.state?.()?.entities?.["@world"]?.c?.["body-default"]; if (v !== undefined) w.presence.bodyDefault = v; else delete w.presence.bodyDefault; }
// After any change to `to`'s table: whatever someone is doing to them that the table now refuses ends NOW, and the actor
// hears body-revoked once (42 §4.6): a gate closed on it, or its actor blocked.
function revokeAfter(w, to) { syncDefault(w); const P = w.presence, b = P.bodies[to]; if (!b) return [];
  const ended = []; const end = (actor, sponsor, cls, clear) => { if (decideAs(P, actor, sponsor, to, cls).mode !== "deny") return; clear(); ended.push({ actor, class: cls }); inboxPush(P, actor, { type: "body-revoked", by: to, class: cls }); };
  if (b.poseBy) end(b.poseBy, b.poseSponsor, "pose", () => { delete b.poseBy; delete b.poseSponsor; });
  if (b.draggedBy) end(b.draggedBy, b.dragSponsor, "displace", () => { delete b.draggedBy; delete b.dragSponsor; });
  for (const [actor, r] of Object.entries(P.reaches ?? {})) if (r?.to === to) end(actor, r.sponsor, r.cls, () => { delete P.reaches[actor]; });
  w.presenceDirty = true; return ended; }
/** what my own snapshot says I chose (look's `shield`): each gate as chosen, null = the world's default stands */
const shieldOf = (P, who) => { const t = C.tableOf(P, who); return { move: t.move ?? null, touch: t.touch ?? null }; };
const readTable = (P, who) => { const t = C.tableOf(P, who); return { move: t.move ?? null, touch: t.touch ?? null, allow: t.allow, block: t.block }; };
const BODY_VERBS = {
  // my body's two gates and my two lists; only I change them
  consent(w, actor, a) { const P = w.presence;
    const changing = [...C.GATES, ...C.PERSON_OPS, ...C.RETIRED_CONSENT].some((k) => a[k] !== undefined);
    if (changing) { const r = C.setConsent(P, actor, a); if (!r.ok) refuse(r.code, r.reason, r.fix ?? C.CONSENT_FIX);
      const ended = revokeAfter(w, actor); w.presenceDirty = true; return { ok: true, recorded: false, of: actor, ...(ended.length ? { ended } : {}), table: readTable(P, actor) }; }
    syncDefault(w);
    return { ok: true, table: readTable(P, actor), world: { ...C.DEFAULT_GATES, ...C.worldGates(P.bodyDefault) },
      attempts: (P.ring ?? []).filter((r) => r.to === actor).slice(-10) }; },
  // one shape for every act on a body (42 §4.4): pose, anim, shove, drag. Says what happened.
  body(w, actor, a) { const me = body(w, actor); const to = bodyRef(a.to);
    if (!["pose", "anim", "shove", "drag", "occupy", "carry"].includes(a.kind)) refuse("shape", `no body kind '${a.kind}'`, "body {to, kind: pose|anim|shove|drag|occupy|carry}");
    const t = w.presence.bodies[to]; if (t && ["shove", "drag", "carry"].includes(a.kind) && dist(me.at, t.at) > BODY_REACH) refuse("out-of-reach", `${to} is ${r3(dist(me.at, t.at))} m away`, "walk closer");
    const g = bodyGate(w, actor, to, a.kind, { spec: a.spec });
    if (!g.ok) refuse(g.code, g.reason, g.fix, { class: g.class });
    g.deliver(); return { ok: true, outcome: "allowed", delivered: true, consent: g.consent, recorded: false }; },
  // touch is judged by where the hand IS (42 P8): a named point, or a bare world point at someone's body
  reach(w, actor, a) { const me = body(w, actor); const P = w.presence; let to, cls, point = a.point ?? null;
    if (Array.isArray(a.at)) { if (a.at.length !== 3 || a.at.some((n) => !Number.isFinite(n))) refuse("shape", "at: [x, y, z]", "");
      for (const [k, b] of Object.entries(P.bodies)) { if (k === actor) continue; const c = C.pointClass(b.at, a.at); if (c) { to = k; cls = c; break; } }
      if (dist(gripPoint(me), a.at) > REACH) refuse("out-of-reach", `that point is ${r3(dist(gripPoint(me), a.at))} m from your hand`, "walk closer");
      if (!to) { (P.reaches ??= {})[actor] = { at: a.at.slice() }; w.presenceDirty = true; return { ok: true, touching: null, recorded: false }; } }
    else { to = bodyRef(a.who); if (!to || !point) refuse("shape", "reach {who, point} or {at: [x, y, z]}", "points: " + C.REACH_POINTS.join(", "));
      const np = C.namedPointClass(point); if (!np) refuse("shape", `no point '${point}'`, C.REACH_POINTS.join(", "));   // the relay's own classifier (F5)
      point = np.point; cls = np.cls;
      const t = P.bodies[to]; if (t && dist(me.at, t.at) > BODY_REACH) refuse("out-of-reach", `${to} is ${r3(dist(me.at, t.at))} m away`, "walk closer"); }
    delete P.reaches?.[actor];
    const g = bodyGate(w, actor, to, "touch", { cls, spec: { point, ...(a.at ? { at: a.at } : {}) } });
    if (!g.ok) { w.presenceDirty = true; refuse(g.code, g.reason, g.fix, { class: g.class, stripped: true }); }
    g.deliver(); return { ok: true, outcome: "allowed", touching: to, class: cls, recorded: false }; },
  inbox(w, actor) { const P = w.presence; const m = P.inbox?.[actor] ?? []; if (P.inbox) delete P.inbox[actor]; w.presenceDirty = true; return { ok: true, messages: m }; },
};
export { BODY_VERBS, bodyGate, forgetReaches, inboxPush, shieldOf };
