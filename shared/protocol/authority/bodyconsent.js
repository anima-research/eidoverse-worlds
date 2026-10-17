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

// ---------- body consent (L6 as revised 21:45; research 42). Presence only: none of this is ever appended. ----------
// The authority keeps every body's table (consent.js) beside `bodies` and `holds`, refuses BEFORE delivery, and keeps an
// unlogged attempt ring. Delivery in the lab is the target's `inbox` (a stand-in for the relay to its client).
const ringPush = (P, r) => { (P.ring ??= []).push(r); if (P.ring.length > 200) P.ring.shift(); };
// bounded like ring (review 10-14 C2: browsers never drain it). Each message carries `n`, its person's own count, which
// survives both the cap's trimming and `inbox` draining it: the server forwards by `n`, never by the array's length (holes
// review 10-15 H1: a full queue stayed at 200, and its person heard nothing more)
const inboxPush = (P, who, m) => { const n = ((P.inboxN ??= {})[who] ?? 0) + 1; P.inboxN[who] = n; const q = (P.inbox ??= {})[who] ??= []; q.push({ ...m, n }); if (q.length > 200) q.shift(); };
const bodyRef = (x) => (typeof x === "string" ? x.replace(/^body:/, "") : x);
function expireAsks(w) { const P = w.presence, now = w.now();
  for (const [id, k] of Object.entries(P.asks ?? {})) if (k.expires <= now) { delete P.asks[id]; coolDown(P, k, now); inboxPush(P, k.from, { type: "body-reply", ask: id, ok: false, why: C.refusalWords(k.to, k.cls) }); w.presenceDirty = true; } }
function coolDown(P, k, now) { const key = `${k.from}>${k.to}:${k.cls}`; const n = (P.cool?.[key]?.n ?? 0) + 1; (P.cool ??= {})[key] = { n, until: now + C.COOL_MS * 2 ** (n - 1) }; }
// 42 §4.13 item 4: five refusals of one class from three distinct targets in 5 min puts the actor on a 10-minute
// cool-down for that class, world-wide, written as an automatic action in the MODERATOR log. Never a ban.
function noteRefusal(w, from, to, cls, now) { const P = w.presence; (P.refusals ??= []).push({ ts: now, from, to, cls }); P.refusals = P.refusals.filter((r) => now - r.ts < 300000);
  const mine = P.refusals.filter((r) => r.from === from && r.cls === cls);
  if (mine.length >= 5 && new Set(mine.map((r) => r.to)).size >= 3 && !(P.throttle?.[`${from}:${cls}`] > now)) {
    (P.throttle ??= {})[`${from}:${cls}`] = now + 600000; w.appendMod({ actor: "system", verb: "auto-cooldown", who: from, class: cls, minutes: 10, why: `${mine.length} refusals of ${cls} from ${new Set(mine.map((r) => r.to)).size} people in 5 min` }); } }
// The gate for every act on another body. extra: { cls?, spec?, why?, script?, sponsor? }.
function bodyGate(w, from, to, kind, extra = {}) {
  const P = w.presence, now = w.now(); to = bodyRef(to); const cls = extra.cls ?? C.KIND_CLASS[kind];
  if (!cls) return { ok: false, code: "shape", reason: `no body kind '${kind}'`, fix: Object.keys(C.KIND_CLASS).join(", ") };
  if (!P.bodies[to]) return { ok: false, code: "not-here", reason: `${to} isn't here` };
  if (from === to) return { ok: true, consent: "self", deliver: () => deliver(w, from, to, kind, cls, extra, "self") };
  const result = (verdict, r) => { ringPush(P, { ts: now, from, to, cls, verdict }); w.presenceDirty = true; return r; };
  if (P.throttle?.[`${from}:${cls}`] > now) return result("refused", { ok: false, code: "cool-down", class: cls, reason: `${from} is on a cool-down for ${cls} after repeated refusals (moderator log)`, fix: "ask people first; this lifts by itself" });
  let d = C.decide(P, from, to, cls, now);
  if (isScriptActor(from) && extra.sponsor && !C.tableOf(P, to).overrides[from]?.[cls] && C.tableOf(P, to).overrides[`scripts-by:${extra.sponsor}`]?.[cls]) d = C.decide(P, `scripts-by:${extra.sponsor}`, to, cls, now);
  if (d.mode === "nobody") { noteRefusal(w, from, to, cls, now); ringPush(P, { ts: now, from, to, cls, verdict: "refused", why: d.why }); w.presenceDirty = true;
    return { ok: false, code: "consent", class: cls, reason: C.refusalWords(to, cls), fix: C.REFUSAL_FIX }; }   // the why is the target's (ring) only
  if (d.mode === "ask") {
    if (isScriptActor(from)) return result("refused", { ok: false, code: "consent", class: cls, reason: `${to}'s ${cls} is 'ask'; a behaviour can't wait for an answer`, fix: `${to} may allow ${from} by name` });
    const key = `${from}>${to}:${cls}`; if (P.cool?.[key]?.until > now) return result("refused", { ok: false, code: "cool-down", class: cls, reason: `${to} said no (or didn't answer); you may ask again in ${Math.ceil((P.cool[key].until - now) / 60000)} min`, fix: "the wait doubles each time" });
    if (Object.values(P.asks ?? {}).some((k) => k.from === from && k.to === to)) return result("refused", { ok: false, code: "pending", class: cls, reason: `you already have an ask waiting with ${to}`, fix: "one at a time" });
    for (const [k, t] of Object.entries(P.asked ?? {})) if (now - t.ts >= 60000) delete P.asked[k];   // only ever grew (review 10-14 C2)
    if (Object.values(P.asked ?? {}).filter((t) => t.from === from && now - t.ts < 60000).length >= 2) return result("refused", { ok: false, code: "rate", class: cls, reason: "at most 2 asks a minute", fix: "" });
    const id = `ask-${now}-${Object.keys(P.asks ?? {}).length}`; (P.asks ??= {})[id] = { id, from, to, kind, cls, spec: extra.spec ?? null, why: extra.why ?? null, expires: now + C.ASK_MS };
    (P.asked ??= {})[id] = { from, ts: now };
    inboxPush(P, to, { type: "body-ask", ask: { id, from, kind, summary: `${from} asks to ${kind}${extra.spec?.point ? ` (${extra.spec.point})` : ""}`, why: extra.why ?? null, expires: now + C.ASK_MS } });
    return result("asked", { ok: true, asked: true, ask: id }); }
  return { ok: true, consent: d.standing === "allow" ? "allowed" : "standing", deliver: () => { ringPush(P, { ts: now, from, to, cls, verdict: "allowed" }); deliver(w, from, to, kind, cls, extra, "standing"); } };
}
// The relay's question about a reach DESCRIPTOR (shared/reachwire.js: a hand streamed in a pose toward another body, design
// review 10-15 item 1): may `from`'s hand rest on `to` as `cls` (touch | intimate) right now? Asked per presence packet, so it
// is presence only: nothing is appended, no ask is made (the relay can't wait; the `reach` verb asks), and the refusal
// counter that leads to a moderator-log cool-down is NOT fed (a stream of frames is one attempt, not fifty). Admitted when
// `to`'s table says everyone (a standing allow included), or when the `reach` verb already admitted this touch (an ask
// answered yes: P.reaches, which revokeAfter clears when the table closes). A refusal is said to the reacher in the body
// inbox, and to the target's attempt ring, once per (from, to, cls) per C.REACH_NOTE_MS; `noted` says whether it was now.
export function reachAdmits(w, from, to, cls, { point = null, limb = null } = {}) {
  const P = w.presence, now = w.now();
  if (from === to) return { ok: true, consent: "self" };
  if (!C.ENFORCED.includes(cls) || (cls !== "touch" && cls !== "intimate")) return { ok: false, code: "shape", class: cls, reason: `a reach is touch or intimate, not '${cls}'` };
  const granted = P.reaches?.[from];
  if (granted?.to && !(granted.until > now)) delete P.reaches[from];   // F3 (d): a yes lapses after C.REACH_GRANT_MS, held or not
  else if (granted && granted.to === to && (granted.cls === cls || (granted.cls === "intimate" && cls === "touch"))) { granted.seen = true; return { ok: true, consent: "asked" }; }
  let r;
  if (P.throttle?.[`${from}:${cls}`] > now) r = { code: "cool-down", reason: `${from} is on a cool-down for ${cls} after repeated refusals (moderator log)`, fix: "ask people first; this lifts by itself" };
  else { const d = C.decide(P, from, to, cls, now);
    if (d.mode === "everyone") return { ok: true, consent: d.standing === "allow" ? "allowed" : "standing" };
    r = d.mode === "ask"
      ? { code: "consent", reason: `${to}'s ${cls} for you is ask: a hand isn't streamed onto them until they say yes`, fix: `ask first with the reach request: reach {who: "${to}", point: "${point ?? "<point>"}"} (they have 20 s; silence is no)` }
      : { code: "consent", reason: C.refusalWords(to, cls), fix: C.REFUSAL_FIX, why: d.why }; }
  const key = `${from}>${to}:${cls}`, notes = (P.reachNotes ??= {});
  for (const [k, t] of Object.entries(notes)) if (now - t >= C.REACH_NOTE_MS) delete notes[k];
  const noted = !(notes[key] > now - C.REACH_NOTE_MS);
  const { why: cause, ...told } = r; r = told;
  if (noted) { notes[key] = now; ringPush(P, { ts: now, from, to, cls, verdict: "refused (reach not relayed)", ...(cause ? { why: cause } : {}) });
    inboxPush(P, from, { type: "reach-refused", to, class: cls, ...(point ? { point } : {}), ...(typeof limb === "string" ? { limb } : {}), why: r.reason, fix: r.fix, code: r.code }); w.presenceDirty = true; }
  return { ok: false, class: cls, ...r, noted };
}
// F3 (a): the relay, after gating one packet of `from`'s: `aimed` is the set of bodies a limb that RELAYED in it rests on.
// A grant (an ask answered yes) whose hand has landed (`seen`) and that no relayed limb rests on now was let go: it ends.
// A grant not yet landed waits (the reacher streams idle frames between the yes and the hand); the TTL bounds that wait.
export function reachLetGo(w, from, aimed) {
  const P = w.presence, g = P.reaches?.[from];
  if (!g?.to || !g.seen || aimed.has(g.to)) return false;
  delete P.reaches[from]; w.presenceDirty = true; return true;
}
const forgetReaches = (P, who) => { for (const [k, r] of Object.entries(P.reaches ?? {})) if (k === who || r?.to === who) delete P.reaches[k]; };
/** each grant resting on `to`: what `to`'s table says to its class now (revokeAfter compares before and after a change) */
const reachModes = (P, to, now) => Object.fromEntries(Object.entries(P.reaches ?? {}).filter(([, r]) => r?.to === to).map(([k, r]) => [k, C.decide(P, k, to, r.cls, now).mode]));
function deliver(w, from, to, kind, cls, extra, consent) {
  const P = w.presence, b = P.bodies[to];
  if (cls === "pose") { b.pose = extra.spec ?? {}; b.poseBy = from; }
  if (cls === "move") b.draggedBy = from;
  if (cls === "shove") b.tumble = { by: from, ts: w.now() };
  if (cls === "touch" || cls === "intimate") (P.reaches ??= {})[from] = { to, cls, point: extra.spec?.point ?? null, until: w.now() + C.REACH_GRANT_MS };
  inboxPush(P, to, { type: "body", from, kind, cls, consent, ...(extra.spec ? { spec: extra.spec } : {}) }); w.presenceDirty = true;
}
// After any change to `to`'s table: whatever someone is doing to them that the table now says nobody to ends NOW, and the
// actor hears body-revoked once (42 §4.6). A pose or drag granted by an ask outlives a later 'ask' cell; only 'nobody' ends
// it. A touch is held to more (r2 holes F3 (c)): its cell moving to anything but everyone is a change of mind, and ends it
// (`before`: reachModes before the change, so a change to some other class leaves a yes standing).
function revokeAfter(w, to, before = {}) { const P = w.presence, b = P.bodies[to], now = w.now(); if (!b) return [];
  const ended = []; const end = (actor, cls, clear) => { if (C.decide(P, actor, to, cls, now).mode !== "nobody") return; clear(); ended.push({ actor, class: cls }); inboxPush(P, actor, { type: "body-revoked", by: to, class: cls }); };
  if (b.poseBy) end(b.poseBy, "pose", () => { delete b.pose; delete b.poseBy; });
  if (b.draggedBy) end(b.draggedBy, "move", () => { delete b.draggedBy; });
  for (const [actor, r] of Object.entries(P.reaches ?? {})) if (r?.to === to) { const m = C.decide(P, actor, to, r.cls, now).mode;
    if (m === "nobody" || (m !== "everyone" && m !== before[actor])) { delete P.reaches[actor]; ended.push({ actor, class: r.cls }); inboxPush(P, actor, { type: "body-revoked", by: to, class: r.cls }); } }
  w.presenceDirty = true; return ended; }
const shieldOf = (P, who) => { const t = C.tableOf(P, who); return { preset: t.preset, strangers: Object.fromEntries(C.ENFORCED.map((c) => [c, t.strangers[c]])), ...(t.paused ? { paused: true } : {}) }; };
const BODY_VERBS = {
  // L6: the person's own table. `of: <who>` acts on someone else's: closing only, and only if they named you trusted.
  consent(w, actor, a) { const P = w.presence, now = w.now(); expireAsks(w);
    if (a.answer !== undefined) { const k = P.asks?.[a.answer]; if (!k || k.to !== actor) refuse("not-found", `no ask '${a.answer}' waiting for you`, "consent {} lists them");
      delete P.asks[a.answer];
      if (a.yes === true) { if (a.for) C.setConsent(P, actor, { allow: k.from, class: k.cls, for: a.for }, now);
        deliver(w, k.from, actor, k.kind, k.cls, { spec: k.spec }, "asked"); ringPush(P, { ts: now, from: k.from, to: actor, cls: k.cls, verdict: "allowed (asked)" }); inboxPush(P, k.from, { type: "body-reply", ask: k.id, ok: true, applied: true }); }
      else { coolDown(P, k, now); ringPush(P, { ts: now, from: k.from, to: actor, cls: k.cls, verdict: "refused (asked)" }); inboxPush(P, k.from, { type: "body-reply", ask: k.id, ok: false, why: C.refusalWords(actor, k.cls) }); }
      w.presenceDirty = true; return { ok: true, answered: a.answer, yes: a.yes === true }; }
    const changing = ["preset", "set", "allow", "deny", "pause", "friend"].some((k) => a[k] !== undefined);
    if (changing) { const before = reachModes(P, typeof a.of === "string" ? a.of : actor, now); const r = C.setConsent(P, actor, a, now); if (!r.ok) refuse(r.code, r.reason, r.fix ?? "anyone you trust may close your shield; only you may open it (§5)");
      const ended = revokeAfter(w, r.target, before); w.presenceDirty = true; return { ok: true, recorded: false, of: r.target, ...(ended.length ? { ended } : {}), table: C.tableOf(P, r.target) }; }
    const t = C.tableOf(P, actor);
    return { ok: true, table: { preset: t.preset, strangers: t.strangers, friends: t.friends, paused: t.paused, trusted: t.friendsList }, asks: Object.values(P.asks ?? {}).filter((k) => k.to === actor),
      attempts: (P.ring ?? []).filter((r) => r.to === actor).slice(-10) }; },
  // one shape for every act on a body (42 §4.4): pose, anim, shove, drag. Waits for nothing in the lab; says what happened.
  body(w, actor, a) { const me = body(w, actor); const to = bodyRef(a.to); expireAsks(w);
    if (!["pose", "anim", "shove", "drag", "occupy", "carry"].includes(a.kind)) refuse("shape", `no body kind '${a.kind}'`, "body {to, kind: pose|anim|shove|drag|occupy|carry}");
    const t = w.presence.bodies[to]; if (t && ["shove", "drag", "carry"].includes(a.kind) && dist(me.at, t.at) > BODY_REACH) refuse("out-of-reach", `${to} is ${r3(dist(me.at, t.at))} m away`, "walk closer");
    const g = bodyGate(w, actor, to, a.kind, { spec: a.spec, why: a.why });
    if (!g.ok) refuse(g.code, g.reason, g.fix, { class: g.class });
    if (g.asked) return { ok: true, outcome: "asked", ask: g.ask, delivered: false, note: `${to} was asked; no answer in 20 s is no` };
    g.deliver(); return { ok: true, outcome: "allowed", delivered: true, consent: g.consent, recorded: false }; },
  // touch is judged by where the hand IS (42 P8): a named point, or a bare world point at someone's body
  reach(w, actor, a) { const me = body(w, actor); const P = w.presence; let to, cls, point = a.point ?? null; expireAsks(w);
    if (Array.isArray(a.at)) { if (a.at.length !== 3 || a.at.some((n) => !Number.isFinite(n))) refuse("shape", "at: [x, y, z]", "");
      for (const [k, b] of Object.entries(P.bodies)) { if (k === actor) continue; const c = C.pointClass(b.at, a.at); if (c) { to = k; cls = c; break; } }
      if (dist(gripPoint(me), a.at) > REACH) refuse("out-of-reach", `that point is ${r3(dist(gripPoint(me), a.at))} m from your hand`, "walk closer");
      if (!to) { (P.reaches ??= {})[actor] = { at: a.at.slice() }; w.presenceDirty = true; return { ok: true, touching: null, recorded: false }; } }
    else { to = bodyRef(a.who); if (!to || !point) refuse("shape", "reach {who, point} or {at: [x, y, z]}", "points: " + C.REACH_POINTS.join(", "));
      const np = C.namedPointClass(point); if (!np) refuse("shape", `no point '${point}'`, C.REACH_POINTS.join(", "));   // the relay's own classifier (F5)
      point = np.point; cls = np.cls;
      const t = P.bodies[to]; if (t && dist(me.at, t.at) > BODY_REACH) refuse("out-of-reach", `${to} is ${r3(dist(me.at, t.at))} m away`, "walk closer"); }
    delete P.reaches?.[actor];
    const g = bodyGate(w, actor, to, "touch", { cls, spec: { point, ...(a.at ? { at: a.at } : {}) }, why: a.why });
    if (!g.ok) { w.presenceDirty = true; refuse(g.code, g.reason, g.fix, { class: g.class, stripped: true }); }
    if (g.asked) return { ok: true, outcome: "asked", ask: g.ask, delivered: false };
    g.deliver(); return { ok: true, outcome: "allowed", touching: to, class: cls, recorded: false }; },
  inbox(w, actor) { const P = w.presence; expireAsks(w); const m = P.inbox?.[actor] ?? []; if (P.inbox) delete P.inbox[actor]; w.presenceDirty = true; return { ok: true, messages: m }; },
};
export { BODY_VERBS, bodyGate, expireAsks, forgetReaches, inboxPush, shieldOf };
