// shared/protocol/authority/use.js — use (interaction): what a thing offers (reactions, toggles, sockets a body may take,
// the implicit open), buildUse that turns a use into ops or presence, and the use verb as USE_VERBS, which authority.js
// spreads into VERBS where it stood (refactor split, 2026-10-17; moved from authority.js's "use (interaction)" section
// and the VERBS table unchanged). The write path, scripts and seats it hands off to are above it, reached through UP.
import { bodyOf } from "../../components.js";
import { inOccupyReach, OCCUPY_REACH } from "../../sockbody.js";
import { grabOf } from "../../grab.js";
import { PURGED } from "../fold.js";
import { COMPONENTS, PENDULUM, unitTransform } from "../componentspec.js";
import { r3 } from "../round.js";
import { UP } from "./ctx.js";
import { refuse, said } from "./refuse.js";
import { delOp, isE, lockedC, setOp } from "./storage.js";
import { aabb, ancestors, qrot, worldT } from "./math.js";
import { implicitOpens, isSocketC, socketsOf, toggleOf } from "./sockets.js";
import { admits } from "./rights.js";
import { whoWords } from "../roles.js";
// the layers above this one (a leaf may not import them: authority-layers-check), reached through UP (ctx.js), which
// authority.js binds at load
const actOf = (...a) => UP.actOf(...a);
const activate = (...a) => UP.activate(...a);
const commit = (...a) => UP.commit(...a);
const guess = (...a) => UP.guess(...a);
const homeScale = (...a) => UP.homeScale(...a);
const lastTouch = (...a) => UP.lastTouch(...a);
const offRefuse = (...a) => UP.offRefuse(...a);
const rateCheck = (...a) => UP.rateCheck(...a);
const sameHome = (...a) => UP.sameHome(...a);
const occupantOf = (...a) => UP.occupantOf(...a);
const setOccupant = (...a) => UP.setOccupant(...a);
const occupantOn = (...a) => UP.occupantOn(...a);
const vec3s = (...a) => UP.vec3s(...a);

// ---------- use (interaction) ----------
// A pendulum's pivot is a view: derived from what it hangs from, every time it's read (L2: never stored).
function pivotOf(st, id) {
  const pv = st.entities[id]?.c.pivot?.pos; if (Array.isArray(pv) && pv.length === 3) return pv.slice();   // the stored hinge (research 52)
  const t = worldT(st, id); const p = st.entities[id]?.c.parent?.to; const pb = p && aabb(st, p);
  return pb && pb.max[1] > t.pos[1] ? [0, r3((pb.max[1] - t.pos[1]) / t.scale[1]), 0] : null;
}
// L7: a `use` exercises a capability the handler holds. It is scoped to the component the handler names, and good
// only while the handler's author (whoever last set `reactions`) could still make that change themselves.
function reactionCap(ctx, id, comp, action) {
  const implicit = !ctx.st.entities[id]?.c.reactions?.[action] && action === "open" && implicitOpens(ctx.st.entities[id]);
  const lt = lastTouch(ctx.w, id, implicit ? "openable" : "reactions", { editsOnly: implicit, authored: true }); if (!lt) refuse("no-handler", `nobody set up '${action}' on ${id}`, `inspect {id: '${id}'} shows what it offers; a builder can set up '${action}' in its reactions, and asking again won't change it until then`);
  // a purge erased whose rights installed it: it acts for nobody, never as a newcomer would (house 6340433633 Q2)
  if (lt.actor == null) refuse("rights", `a purge erased who set up '${action}' on ${id}, so it acts for nobody`, `someone who may change ${id}'s reactions can set it up again`);
  ctx.actExtra = { capability: { reaction: action, author: lt.actor, grantedAt: lt.seq } };
  ctx.cap = { kind: "reaction", ids: [id], comps: [comp], author: lt.actor, action };
}
function buildUse(ctx, a) {
  const e = ctx.st.entities[a.id]; if (!e) refuse("not-found", `no '${a.id}'`, "", { didYouMean: guess(a.id, Object.keys(ctx.st.entities)) });
  offRefuse(ctx.st, a.id, "used");
  const offers = actionsOf(ctx.st, a.id);
  // no action named (Commons audit: "doesn't 'undefined'"): the thing's one action, or say what it offers
  // "one action" means one this asker may do: an owner-only lock beside an open-to-all door isn't a choice for a visitor
  if (a.action == null && !offers.length) refuse("no-action", `${a.id} has nothing to use: it offers no actions`, "inspect shows what a thing offers; a builder gives it reactions, or a seat (a socket child carrying a station)");
  const mine = a.action == null ? offersFor(ctx.st, a.id, ctx.actor).canDo : offers;
  if (a.action == null && mine.length > 1) refuse("no-action", `${a.id} offers ${mine.length} things to do: say which`, `it offers: ${mine.join(", ")} (use {id: '${a.id}', action: '${mine[0]}'})`, { offers: mine });
  const action = a.action ?? mine[0] ?? offers[0];   // none you may do: the first, so the refusal says why
  if (!offers.includes(action)) refuse("no-action", `${a.id} doesn't '${action}'`, `it offers: ${offers.join(", ") || "nothing"}`, { didYouMean: guess(action, offers) });
  const socks = bodySockets(ctx.st, a.id).filter((x) => x.body.action === action);
  if (socks.length && !e.c.reactions?.[action]) {
    const may = (x) => !x.body.who || admits(ctx.st, ctx.actor, x.body.who);
    const socket = a.args?.socket;
    if (socket != null) { const named = socks.find((x) => x.slot === socket);
      if (!named) refuse("no-action", `${a.id} has no '${action}' socket called '${socket}'`, `its ${action} sockets: ${socks.map((x) => x.slot).join(", ")}`, { didYouMean: guess(String(socket), socks.map((x) => x.slot)) });
      if (!may(named)) refuse("rights", `only a ${named.body.who} may ${action} ${a.id} (${socket})`, "ask someone who can"); }
    const ok = socks.filter(may);
    if (!ok.length) refuse("rights", `only a ${socks[0].body.who} may ${action} ${a.id}`, "ask someone who can");
    const taken = (x) => (ctx.w ? occupantOn(ctx.w, ctx.st, x.id, ctx.actor) : null);
    const pick = socket != null ? ok.find((x) => x.slot === socket) : ok.find((x) => !taken(x)) ?? ok[0];
    { const t = taken(pick); if (t) refuse("occupied", `${t.who ? said(t.who) : t.thing} ${t.who ? "sits" : "is"} in ${pick.host}'s ${pick.slot}${socket == null && ok.length > 1 ? `, and its other ${action} sockets are taken too` : ""}`, "one body per socket: wait till it's free, or pick another (args: {socket})", t.who ? { by: t.who } : { thing: t.thing }); }
    // within reach (review r10 M1): leaving a seat restarts the authority's track of the body at it, so a sit from afar would be an
    // unlogged teleport past the spawn rule and any wall. Measured from the tracked body (or, moving straight from another seat,
    // from that seat); a body the authority doesn't track yet (not arrived) may sit, and its first move is an arrival as ever
    let near = false;
    if (ctx.w) { const me = ctx.w.presence.bodies?.[ctx.actor], cur = occupantOf(ctx.w, ctx.st, ctx.actor);
      const from = cur && ctx.st.entities[cur.to] ? worldT(ctx.st, cur.to).pos : Array.isArray(me?.at) ? me.at : null;
      if (from) { const sp = worldT(ctx.st, pick.id).pos;
        if (!inOccupyReach(from, sp, OCCUPY_REACH.lag)) refuse("out-of-reach", `${pick.host}'s ${pick.slot} is ${r3(Math.hypot(sp[0] - from[0], sp[2] - from[2]))} m from you${Math.abs(sp[1] - from[1]) > 1 ? `, ${r3(sp[1] - from[1])} m up` : ""}; a seat is within ${OCCUPY_REACH.r} m to sit on`, `walk up to it first (move {to: '${pick.host}'})`);
        near = true; } }
    // attaching is presence (your frames say where you're attached; nothing is recorded), so the authority only answers: where,
    // and what the body does there (the socket's body block read with its defaults: shared/sockbody.js bodyOf)
    const { clip, ...body } = pick.body;
    return { presence: true, near, attach: { to: pick.id, host: pick.host, socket: pick.slot, ...body }, note: `you ${action} on ${pick.host} (${pick.slot}): presence — your frames carry it; nothing recorded${body.leaveBy === "script" ? " (this seat lets you go only when a script does)" : ""}` };
  }
  const h = handlerOf(e, action);
  if (h?.who && !admits(ctx.st, ctx.actor, h.who)) refuse("rights", `only ${whoWords(h.who)} may ${action} ${a.id}`, "ask someone who can");
  if (h?.kind === "script") return { script: h.script, action }; // VERBS.use logs the visitor's act, then activates it
  if (h?.kind === "reset") {
    reactionCap(ctx, a.id, "transform", action); ctx.refs.add(a.id);
    const ops = [], sent = [], skipped = []; let atHome = 0;
    for (const t of h.targets) { const te = ctx.st.entities[t];
      if (!te) { skipped.push({ id: t, why: "it isn't here any more" }); continue; }
      const home = te.c.home;
      if (!home) { skipped.push({ id: t, why: "it has no home" }); continue; }
      if ([t, ...ancestors(ctx.st, t)].some((k) => lockedC(ctx.st.entities[k]?.c))) { skipped.push({ id: t, why: "it is locked" }); continue; }
      const hp = home.parent; if (hp && !ctx.st.entities[hp.to]) { skipped.push({ id: t, why: `its home parent ${hp.to} is gone` }); continue; }
      // a launched thing is the engine's until it rests (no write may touch it: inFlight in admit); for now a reset skips it and says so
      { const sf = ctx.w.sim(), b = sf.sim?.bodies[t]; if (sf.launched[t] && b && !b.resting) { skipped.push({ id: t, why: "it is in flight; press again once it lands" }); continue; } }
      if (sameHome(ctx.st, t, home) && !ctx.w.presence.holds[t] && vec3s(te.c.transform?.scale).every((x, i) => Math.abs(x - homeScale(ctx.st, t, home)[i]) < 1e-4)) { atHome++; continue; }   // home already (and its size), in no hand
      ops.push(...(hp ? [setOp(t, "parent", { ...hp })] : te.c.parent ? [delOp(t, "parent")] : []),
        setOp(t, "transform", unitTransform({ pos: home.pos.slice(), q: (home.q ?? [0, 0, 0, 1]).slice(), scale: homeScale(ctx.st, t, home) })));
      sent.push(t); ctx.refs.add(t); }
    ctx.cap = { ...ctx.cap, ids: [a.id, ...sent], comps: ["transform", "parent"] };
    if (skipped.length) ctx.notes.push(...skipped.map((x) => ({ ...x, reset: "skipped" })));
    if (!ops.length) { const list = skipped.map((x) => `${x.id} (${x.why})`).join(", ");
      if (!skipped.length && !atHome) refuse("nothing-to-reset", `${a.id}'s '${action}' names no targets, so there is nothing to send home`, "someone who may edit it can give it targets (set its reactions); pressing again won't change that");
      if (!skipped.length) refuse("nothing-to-reset", `everything is already home (${atHome === 1 ? "its 1 target" : `all ${atHome} targets`})`, "there is nothing to send home: pressing again won't change that until one of them is moved");
      refuse("nothing-to-reset", `nothing was reset: skipped ${list}${atHome ? `; the rest ${atHome === 1 ? "is" : "are"} already home` : ""}`, "each skip says why; press again once that has changed"); }
    return ops;
  }
  if (h?.kind === "impulse") {
    if (e.c.motion && e.c.motion.type !== "pendulum") refuse("not-pushable", `${a.id} moves by '${e.c.motion.type}', which a push doesn't change`, "an impulse swings a pendulum (motion {type: 'pendulum'})");
    const mo = { ...(e.c.motion?.type === "pendulum" ? e.c.motion : PENDULUM) }; delete mo.pivot;
    if (!pivotOf(ctx.st, a.id)) refuse("no-pivot", `${a.id} swings but hangs from nothing above it`, `hang it first: place {id: '${a.id}', hang: <frame>}`);
    const raw = a.args?.impulse ?? qrot(worldT(ctx.st, a.id).q, [0, 0, h.strength ?? 0.5]);
    const fwd = qrot(worldT(ctx.st, a.id).q, [0, 0, 1]); const along = raw[0] * fwd[0] + raw[1] * fwd[1] + raw[2] * fwd[2];
    const mag = Math.hypot(...raw);
    if (mag > 0 && Math.abs(along) < 0.3 * mag) refuse("sideways", `${a.id} swings front-to-back; that push is mostly sideways`, `push along its front ${JSON.stringify(fwd.map(r3))} (or the opposite)`);
    // the first protocol's pendulum impulse: read angle and velocity AT the push instant, add the push,
    // re-express as (amp, phase, t0). No snap at the push; with the motion builds, against it damps. The client's
    // pendulumTheta (client/lib/motioneval.js) evaluates the result: keep the two in sync (review 10-06 #5).
    const now = ctx.w.now(), w0 = (2 * Math.PI) / (mo.period ?? 3.5), damp = mo.damp ?? 0;
    const t = mo.t0 != null ? Math.max(0, (now - mo.t0) / 1000) : 0;
    const a0 = (mo.amp ?? 0) * Math.exp(-damp * t), ph = w0 * t + (mo.phase ?? 0);
    // Δω = Δv / L: the push's speed at the thing's centre over its distance from the hinge (world metres)
    const pv = pivotOf(ctx.st, a.id), sc = worldT(ctx.st, a.id).scale;
    const L = Math.max(0.2, Math.hypot(pv[0] * sc[0], pv[1] * sc[1], pv[2] * sc[2]));
    const dw = a.args?.impulse == null && typeof h.angular === "number" ? h.angular : along / L;
    const th = a0 * Math.cos(ph), vel = -a0 * w0 * Math.sin(ph) + dw;
    const amp = Math.min(mo.maxAmp ?? 0.9, Math.hypot(th, vel / w0)), phase = Math.atan2(-(vel / w0), th);
    reactionCap(ctx, a.id, "motion", action);
    ctx.refs.add(a.id); return [setOp(a.id, "motion", { ...mo, amp: r3(amp), phase: r3(phase), t0: now })];
  }
  // §5: a thing's gameplay state lives inside its own component (a door is `openable: {open, locked}`), never as a top-level
  // name beside the edit `lock`. A handler names its component and, for an object component, the field it changes.
  // a handler that changes a field inside a component needs that component (it was there when the handler was written;
  // someone has removed it since): say so, rather than write a component nothing draws (review 10-07: a toggle on a crate
  // wrote an invisible door {open: true})
  if ((h?.kind === "set" && h.field !== undefined) || (h?.kind === "toggle" && toggleOf(h).field !== undefined)) { const comp = h.kind === "set" ? h.component : toggleOf(h).comp;
    if (!(e.c[comp] && typeof e.c[comp] === "object" && !Array.isArray(e.c[comp]))) refuse("no-handler", `${a.id} has no ${comp} any more, so '${action}' has nothing to change`, "someone who may edit it can add it back, or set its reactions again"); }
  if (h?.kind === "set") { const comp = h.component; reactionCap(ctx, a.id, comp, action); ctx.refs.add(a.id);
    const v = h.field === undefined ? h.value : { ...objOf(e.c[comp]), [h.field]: h.value };
    return [setOp(a.id, comp, comp === "transform" ? unitTransform(v) : v)]; }   // a stored rotation is a unit one, as a request's is
  // batch 2: play the thing's sound again from the top (a doorbell), playing or not; stampMedia sets t0 = now
  if (h?.kind === "play") { const cur = e.c.sound;
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) refuse("no-sound", `${a.id} has no sound to play`, `give it one: set {id: '${a.id}', component: 'sound', value: {src}}`);
    reactionCap(ctx, a.id, "sound", action); ctx.refs.add(a.id);
    const { t0, ...rest } = cur; return [setOp(a.id, "sound", { ...rest, playing: true })]; }
  if (h?.kind === "toggle") {
    const { comp, field } = toggleOf(h); ctx.refs.add(a.id);
    if (barredBy(e, h)) refuse("barred", `${a.id} is ${h.unless}`, h.fix ?? (h === IMPLICIT_OPEN ? unlockFix(e, a.id) : `someone allowed to may 'use' it with another action first`));
    reactionCap(ctx, a.id, comp, action);
    return [setOp(a.id, comp, field === undefined ? !e.c[comp] : { ...objOf(e.c[comp]), [field]: !objOf(e.c[comp])[field] })];
  }
  refuse("no-handler", `${a.id} declares '${action}' but its handler kind isn't one this engine runs`, `handler kinds: ${Object.keys(COMPONENTS.reactions.handlers).join(", ")} (schema {component: 'reactions'})`);
}
const objOf = (v) => (v && typeof v === "object" && !Array.isArray(v) && v !== PURGED ? v : {});
// toggle's defaults: an openable's `open` (component `openable`, field `open`); a named component with no field toggles
// the whole value (a plain boolean component). `unless` names a field of the same component that, when true, bars it.
const barredBy = (e, h) => !!h?.unless && objOf(e.c[toggleOf(h).comp])[h.unless] === true;
// the sockets a person can attach to: a host's (socketsOf), or a socket's own when it is the one asked
const bodySockets = (st, id) => { const e = st.entities[id]; const host = isSocketC(e?.c) ? e.c.parent?.to : id;
  return socketsOf(st, host).filter((x) => host === id || x.id === id).map((x) => ({ ...x, slot: x.name, body: bodyOf(x.station) })).filter((x) => x.body); };
// an openable thing with nothing that opens it offers 'open' on its own: the implicit toggle of openable.open (R 10-11
// 23:17: the gym door had only `openable`; clicking it did nothing, and inspect said "nothing here opens it"). It is barred
// while openable.locked is on, as the registry's `locked` reads: "bars opening while on (an open handler with unless: 'locked')"
const IMPLICIT_OPEN = Object.freeze({ kind: "toggle", component: "openable", field: "open", unless: "locked" });
// the barred implicit open's remedy, saying only what it can see: the reactions on the thing that unlock it (a toggle of
// openable.locked, a set of it to false, or a set of the whole openable that leaves it off) and that aren't barred
// themselves, with who may use each; else the edit that unlocks it. A script may unlock it too, unseen here, so the remedy
// never says nothing does. The open step is worded by state (on an open door the implicit open shuts it), except where a
// named unlocker sets the whole openable, and with it whether it's open: then it says only that "open" opens or shuts it
function unlockFix(e, id) {
  const q = (x) => JSON.stringify(String(x));
  const unlocks = (h) => (h?.kind === "toggle" && toggleOf(h).comp === "openable" && toggleOf(h).field === "locked" && !barredBy(e, h))
    || (h?.kind === "set" && h.component === "openable" && (h.field === "locked" ? h.value !== true
      : h.field === undefined && !!h.value && typeof h.value === "object" && !Array.isArray(h.value) && h.value.locked !== true));
  const keys = Object.entries(e.c.reactions ?? {}).filter(([, h]) => unlocks(h)), setsOpen = keys.some(([, h]) => h.kind === "set" && h.field === undefined);
  const may = (h) => { const w = h.who ? whoWords(h.who) : "anyone"; return w === "anyone" ? "" : ` (only ${w} may)`; };
  const first = keys.length ? keys.map(([k, h]) => `use {id: ${q(id)}, action: ${q(k)}} unlocks it${may(h)}`).join("; or ")
    : `someone who may edit it can unlock it: set {id: ${q(id)}, component: "openable", value: {locked: false}, merge: true}`;
  return `${first}; then "open" ${setsOpen ? "opens or shuts" : objOf(e.c.openable).open === true ? "shuts" : "opens"} it. "open" won't change it while it's locked`;
}
function handlerOf(e, action) { return e?.c.reactions?.[action] ?? (action === "open" && implicitOpens(e) ? IMPLICIT_OPEN : undefined); }
function actionsOf(st, id) {
  const e = st.entities[id];
  return [...new Set([...Object.keys(e?.c.reactions ?? {}), ...(implicitOpens(e) ? ["open"] : []), ...bodySockets(st, id).map((x) => x.body.action)])];
}
function offersFor(st, id, actor) {
  const e = st.entities[id]; const can = [], notForYou = [];
  for (const act of actionsOf(st, id)) { const h = handlerOf(e, act);
    // a seat's action is its stations', which buildUse admits through any one that seats you: offered unless none would
    const socks = h ? [] : bodySockets(st, id).filter((x) => x.body.action === act);
    const may = (who) => !who || admits(st, actor, who);
    const who = h ? h.who : socks.length && !socks.some((x) => may(x.body.who)) ? socks[0].body.who : undefined;
    if (who && !may(who)) notForYou.push({ action: act, why: `needs ${who}` });
    else if (h?.kind === "toggle" && barredBy(e, h)) notForYou.push({ action: act, why: `it is ${h.unless}` });
    else can.push(act); }
  return { canDo: can, ...(notForYou.length ? { notForYou } : {}) };
}

const USE_VERBS = {
  use(w, actor, a) {
    // use while held (grabbable.use; research grab §3): the holder's use with no action fires the thing's own: its down,
    // or its up with args.phase 'up' (a hose turns on, then off: each one act). The request is logged as sent; the act
    // and the script's event say it was held, in which hand, and which phase. Rapid or continuous effects while pressed
    // (a muzzle flash, a spray) are presence, never a stream of acts: grabbable.fx, drawn by every client.
    const hold = w.presence.holds[a.id]; let held = null; const sent = a;
    // review 10-06: the up of a press is taken from whoever pressed down, even when the thing has left their hand since
    // (taken by someone, dropped with the button still down): a hose that was turned on gets turned off. Once.
    const P = (w.presence.pressed ??= {}); const lateUp = a.args?.phase === "up" && P[a.id]?.by === actor && hold?.by !== actor;
    const holding = hold?.by === actor || lateUp;
    if (a.args?.held === true && !holding) refuse("not-holding", `you aren't holding ${a.id}`, `grab {id: '${a.id}'} first, or leave held out`);
    if (holding) {
      const g = grabOf(w.state().entities[a.id]?.c); const phase = a.args?.phase === "up" ? "up" : "down";
      held = { held: true, hand: (lateUp ? P[a.id].hand : hold.hand) ?? "right", phase };
      if (!a.dry) { if (phase === "down") P[a.id] = { by: actor, hand: held.hand }; else delete P[a.id]; w.presenceDirty = true; }   // a dry use presses nothing
      if (a.action === undefined && g?.use) { const action = phase === "up" ? g.use.up : g.use.down;
        if (!action) return { ok: true, recorded: false, held, note: `${a.id} does nothing on use ${phase} (its grabbable.use names no ${phase})` };
        a = { ...a, action }; }
    }
    const probe = buildUse({ st: w.state(), actor, w, notes: [], refs: new Set() }, a);
    if (probe.presence) {
      // a seat is presence (nothing recorded), but the authority keeps who sits where: a thing someone sits on, or anything
      // carrying it, isn't punted, pushed, grabbed or thrown out from under them (occupant)
      if (probe.attach?.to && !a.dry) setOccupant(w, actor, probe.attach.to, probe.near);   // a dry use seats no one
      return { ok: true, recorded: false, ...(a.dry ? { dry: true } : {}), ...(probe.attach ? { attach: probe.attach } : {}), note: probe.note };   // attach: where your frames now say you are
    }
    if (probe.script) { // L7 (41 §3.6): the visitor's use is ITS act, on its own rate; the behaviour runs with its sponsor's rights
      const key = `script:${probe.script}`; const v = w.state().entities[a.id].c[key];
      if (!v || typeof v !== "object") { const wc = w.state().entities["@world"]?.c ?? {};
        // an imported world: the reaction names an old binding (@world imported-behavior:<name>), which the authority never runs
        // (a binding there, or the handler itself written by the translation: its cause is an `imported` act)
        const old = Object.entries(wc).find(([k, b]) => k.startsWith("imported-behavior:") && (k === `imported-behavior:${probe.script}` || b?.attach === a.id));
        const lt = lastTouch(w, a.id, "reactions", { authored: true }); const ce = lt ? w.entries[w.entries[lt.seq]?.cause] : null;
        if (old || (isE(ce) && ce.kind === "act" && ce.verb === "imported"))
          refuse("no-runtime", `${a.id}'s '${probe.action}' runs the imported behaviour '${old ? old[0].slice("imported-behavior:".length) : probe.script}', carried by translation; the authority doesn't run the old script API`, `re-install it as script:${probe.script} on ${a.id} (docs/SCRIPTS.md); scripts lists imported behaviours as needs-reinstall`);
        refuse("no-handler", `${a.id}'s '${probe.action}' runs ${key}, which isn't installed on it`, "scripts {id} lists what runs here"); }
      const ev = { on: "use", action: probe.action, ...(a.args !== undefined ? { args: a.args } : {}), ...(held ?? {}) };
      if (a.dry) return { ok: true, dry: true, script: activate(w, a.id, probe.script, { ...ev, by: actor, dry: true, requester: actor }) };
      rateCheck(w, actor); const act = w.append(actOf(w, actor, "use", sent, { runs: key, ...(held ? { held, action: probe.action } : {}) }));
      return { ok: true, act, recorded: true, ...(held ? { held } : {}), script: activate(w, a.id, probe.script, { ...ev, by: actor, seq: act, cause: act }) };
    }
    return commit(w, actor, "use", sent, (ctx) => { const ops = buildUse(ctx, a); if (held) ctx.actExtra = { ...(ctx.actExtra ?? {}), held, action: a.action }; return ops; });
  },
};
export { USE_VERBS, actionsOf, offersFor, pivotOf, reactionCap, toggleOf };
