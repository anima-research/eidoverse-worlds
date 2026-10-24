// net — the wire. One socket carrying two planes: the world log (ordered,
// persisted, replayed on join) and presence (batched, lossy, never persisted).

import { CONFIG, report, bus, nameFromJoinAck } from './base.js';
import { avatarMounts } from './mounts.js';   // not world.js: that pulls core.js (the renderer) into lite
// The world as data (TEL0S_NOTES §11.2): every snapshot and live entry
// folds here — synchronously, through the same shared/fold.js the
// sequencer runs — and the realizers project it into the scene.
// EW.foldParity() measures fold-vs-scene drift on demand.
import { hydrate as shadowHydrate, reset as shadowReset, state as shadowState, applyView } from './state.js';
import { hear } from '../../shared/chatwindow.js';
import { refusalText } from '../../shared/protocol/refusal.js';
import { pending, P } from './scheduler.js';
// The realizers (TEL0S_NOTES §11.4) own the scene: state verbs realize
// FROM the fold, and fold-inert causes (use/punt/force, moderation
// narration, live say) dispatch over the bus as 'live-entry' (livechat.js
// listens — emitted rather than imported so this file adds no lap around
// the net → chat → net cycle). One writer per verb, always.

import { wingFoldPresence } from '../../shared/wingpresence.js';
import { presenceWire, voiceWire, bodyWire } from '../../shared/presencewire.js';
import { serverNow, localNow, noteRoundTrip, clockRtt, noteServerFloor, onClockDoubt } from './serverclock.js';
import { presence } from './presence.js';
import { logChat, noteTyping, noteHistoryContext, resyncChatAfter } from './chat.js';
import { markPhase, refuseBoot, waitBoot } from './boot.js';
// this client folds the authority's own stream (shared/protocol/replica.js) and derives the view the realizers draw from it,
// locally; edit mode sends requests (editwrites.js) and waits for the authority.
import { makeReplica } from '../../shared/protocol/replica.js';
import { redialer, REDIAL } from '../../shared/redial.js';
import { actorName } from '../../shared/protocol/names.js';
// the fold's records are frozen on a dev host (a reader that writes into one throws where it stands, C7); a visitor's
// browser skips the walk
export const replica = makeReplica({ freeze: CONFIG.dev });
/** Is this client in a world (it has adopted the authority's cut)? */
export const replicaActive = () => replica.active;
// ui.js is the desktop shell and reaches the engine through its panels (videopanel,
// profile). The wire only ever wanted to SAY something to the user, so it takes a
// notifier instead of importing a whole UI. Default logs: a dropped connection notice
// must not itself go missing in a client that wired nothing.
let toast = (m, kind) => console.log(`[net:${kind ?? 'info'}] ${m}`);

export const net = {
  ws: null,
  joined: false,
  myId: null,
  mySub: null,
  status: 'connecting',   // connecting | live | retrying | rejected
  latency: null,
};

let restoredPose = false;
let hydrating = false;
let pendingLive = [];
let lastSeq = -1;
// when to dial again after a close (shared/redial.js: exponential with full jitter, up to a minute; the agent's rule too).
// Reset only by a join the server ACCEPTED (the snapshot): a socket that opens and is refused again keeps backing off
// (review r4 F5: reset on open, a full world's waiting pages redialled every 5 s, in step).
const redial = redialer();

// Supplied by main.js so net can read/write body state without importing the
// controller (which imports ui, which imports assets…).
let hooks = {
  myAvatarPath: () => '',
  myState: null,
  me: () => null,
  onRestore: () => {},
  onSnapshotDone: () => {},
  myVoice: () => null,   // { mic, hear } — main.js reads the HUD glyphs' own state (mictoggle.js)
};

// The participant registry, the asset ledger and the capture renderer are INJECTED
// for the same reason the hooks above are: this file is the wire, and the wire is the
// one part of the client that a renderer-less client still needs in full. remotes.js
// builds three.js bodies, assets.js and capture.js reach the GPU — importing any of
// them here would drag the engine into lite.js through the side door and undo the
// point of having a lite client at all.
//
// They are `let` bindings with the ORIGINAL names on purpose: every call site below
// reads exactly as it did when these were imports, so this indirection costs the
// protocol code nothing and leaves almost no diff for the next merge to fight over.
//
// Defaults are inert rather than lite: an unwired net should do nothing surprising.
// Both entry points wire explicitly (main.js the real ones, lite.js the DOM-only
// registry in participants_lite.js).
let remotes = new Map();
let ensureRemote = async () => null;
let dropRemote = () => null;
let pushPose = () => {};
let noteServerTime = () => {};
let noteSpeaking = () => {};
let forgetBytes = () => {};
// reachnet.js reaches the engine through landmarks.js. Only sendPose() reads this, and
// a client with no body never sends a pose (hooks.myState is null, which returns early
// above) — so undefined here is both safe and correct: absence means "let go".
let myReachBag = () => undefined;
// A client with no renderer must still ANSWER a snap — the asker is blocked on the
// reply id — so the default is an honest error, not silence.
let capture = async () => ({ error: 'this client has no renderer' });

export function wireNet(h) {
  const { participants, forgetBytes: fb, capture: cap, myReachBag: rb, toast: tf, ...rest } = h;
  if (participants) ({ remotes, ensureRemote, dropRemote, pushPose, noteServerTime, noteSpeaking } = participants);
  if (fb) forgetBytes = fb;
  if (rb) myReachBag = rb;
  if (tf) toast = tf;
  if (cap) capture = cap;
  hooks = { ...hooks, ...rest };
}

// ---------------------------------------------------------------- sending

// Every write is a request (sendRequest below; edits go through editwrites.js sendOps). No verb crosses the wire.

/** People present, by the name they show → the identity the world knows them by (u-…, from the authority's directory;
 *  the server sends it on arrive and in the join roster). A role, a ban or a rollback goes to THIS, never to a typed
 *  name (round-2 R1/R2; security review 10-06 H2). */
export const identities = new Map();
/** A presence message names its person by IDENTITY too (security pass 3, H2): the server routes it to that identity, and
 *  a name someone else wears never catches it. `key` is the field the server reads (targetActor / toActor). */
const actorFor = (name, key) => { const a = name ? identities.get(name) : null; return a ? { [key]: a } : {}; };
// A message about someone's BODY or to them (puppet, bodydrag, typing) goes only to an identity: sent without one the
// server routes it by name (messages.ts presenceTarget), and a name is whatever someone else chose to wear (house I197).
const hasActor = (name) => !!(name && identities.get(name));
/** Display ids of people here without an account (the server marks them on arrive/present): the 'guest' badge. */
export const guests = new Set();
/** Who is muted here now, by identity → until (the server's mod-state; research roles S6: the muted glyph). */
net.modMuted = {};
export const identityOf = (name) => (name === CONFIG.name ? net.you ?? null : identities.get(name) ?? null);
/** Say something in the world (the authority's `say`). Resolves with the authority's reply. Never silent (Commons audit #6): a
 *  line typed while the connection is down is QUEUED and sent when the world is back, and a refused say (the rate
 *  limit, a ban, too long) is shown to the person in plain words. */
const sayQueue = [];   // {args, resolve}: says typed while reconnecting, sent in order on the next snapshot
const SAY_QUEUE_MAX = 20;
const excerpt = (t) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return `“${s.length > 40 ? `${s.slice(0, 39)}…` : s}”`; };
export function sayRefusalWords(r, text) {
  const x = r?.refused ?? {}; const q = excerpt(text);
  switch (x.code) {
    case 'rate': return `slow down — you've said a lot in the last few seconds, so ${q} wasn't sent. Try again in a moment.`;
    case 'banned': return `${q} wasn't sent: you're banned from this world.`;
    case 'too-big': return `${q} is too long to send — ${x.reason ?? 'split it into shorter messages'}.`;
    case 'timeout': return `the world didn't confirm ${q} — it may still arrive; look before sending it again.`;
    case 'offline': return `${q} wasn't sent: not connected to the world.`;
    default: return `${q} wasn't sent: ${x.reason ?? x.code ?? 'the world refused it'}${x.fix ? ` (${x.fix})` : ''}.`;
  }
}
function sendSay(args) {
  return sendRequest('say', args).then((r) => { if (!r?.ok) logChat('*', sayRefusalWords(r, args.text)); return r; });
}
/** extra: to (a whisper); spoken/utt/t0 (the words were voice-performed: the authority logs the trio, display only);
 *  live: true for a transcript of speech (stt.js), which is never queued for a reconnect: sent later it would publish
 *  after the mic went off, with nothing to check it again, so offline it is dropped. */
export function say(text, extra = {}) {
  const args = { text: String(text ?? ''), ...(extra.to ? { to: extra.to } : {}),
    ...(extra.spoken === true && Number.isSafeInteger(extra.utt) ? { spoken: true, utt: extra.utt, ...(Number.isFinite(extra.t0) ? { t0: extra.t0 } : {}) } : {}) };
  if (net.joined && net.ws?.readyState === 1) return sendSay(args);
  if (extra.live) return Promise.resolve({ ok: false, refused: { code: 'offline', reason: 'not connected to the world' } });
  // removed, taken over, or refused at the authority: nothing will reconnect, so nothing is queued (it would wait forever)
  if (sayQueue.length >= SAY_QUEUE_MAX || net.status === 'rejected') { const r = { ok: false, refused: { code: 'offline', reason: 'not connected to the world' } }; logChat('*', sayRefusalWords(r, args.text)); return Promise.resolve(r); }
  logChat('*', `queued ${excerpt(args.text)} — reconnecting… it will be sent when the world is back`);
  return new Promise((resolve) => sayQueue.push({ args, resolve }));
}
/** The connection won't come back (a kick, a ban, a takeover, a refused join): what was queued is told so, not kept. */
function failSays() {
  while (sayQueue.length) { const { args, resolve } = sayQueue.shift(); const r = { ok: false, refused: { code: 'offline', reason: 'not connected to the world' } };
    logChat('*', sayRefusalWords(r, args.text)); resolve(r); }
}
/** Send what was typed while the connection was down, in order (called once the snapshot has landed). */
function flushSays() {
  while (sayQueue.length && net.joined && net.ws?.readyState === 1) { const { args, resolve } = sayQueue.shift(); sendSay(args).then(resolve); }
}
/** A one-off animation — sent once, relayed to everyone, never logged. */
export function sendAnim(data) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'anim', ...data }));
  }
}
/** Ask another body to hold a pose or play an animation. `merge`: pose only
 *  the bones sent, over what they already hold (a null bone releases it);
 *  without it the pose replaces theirs whole. */
export function sendPuppet(target, { pose = null, merge = false, anim = null, ragdoll = null } = {}) {
  if (net.joined && net.ws?.readyState === 1 && hasActor(target)) {
    net.ws.send(JSON.stringify({ type: 'puppet', target, ...actorFor(target, 'targetActor'), pose, ...(merge ? { merge: true } : {}), anim, ragdoll }));
  }
}

/** Ask the world for a page of its own history.
 *
 *  Folding bounds what a join costs, which necessarily means a joiner is not
 *  handed everything ever said. This is how the rest is reachable: scroll up
 *  and the client asks for what came before. A request that gets no answer,
 *  because no socket is joined or nothing came back within 8 s, rejects, so
 *  a caller can tell it from an empty page, which is an answer: there is
 *  nothing there. */
const pendingHistory = new Map();
let histId = 0;
export function requestHistory(opts = {}) {
  if (!net.joined || net.ws?.readyState !== 1) return Promise.reject(new Error('history: not connected'));
  const reqId = `h${++histId}`;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pendingHistory.delete(reqId); reject(new Error('history: no answer within 8 s')); }, 8000);
    pendingHistory.set(reqId, (m) => { clearTimeout(t); resolve(m); });
    net.ws.send(JSON.stringify({ type: 'history', reqId, ...opts }));
  });
}

/** The world's flight recorder: why things bounced (denials, rejections,
 *  rate limits, reaction outcomes). Same request shape as history. */
export function requestDebug(opts = {}) {
  if (!net.joined || net.ws?.readyState !== 1) return Promise.resolve({ events: [] });
  const reqId = `d${++histId}`;
  return new Promise((resolve) => {
    const t = setTimeout(() => { pendingHistory.delete(reqId); resolve({ events: [] }); }, 8000);
    pendingHistory.set(reqId, (m) => { clearTimeout(t); resolve(m); });
    net.ws.send(JSON.stringify({ type: 'debug', reqId, ...opts }));
  });
}

/** Copy the current world into a brand-new name (server: owner-only). */
export function sendWorldFork(to) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'world-fork', to }));
  } else logChat('*', 'not connected — try again in a moment');
}

/** Found a new, empty world you own (server: a signed-in person, within its caps). The reply is world-founded. */
export function sendWorldFound(name, title) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'world-found', name, ...(title ? { title } : {}) }));
  } else logChat('*', 'not connected — try again in a moment');
}

/** Erase the current world back to zero (server: owner-only, archived not
 *  destroyed). Carries the world's own name as the confirmation the server
 *  demands — the caller is responsible for having made the user type it. */
export function sendWorldReset() {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'world-reset', name: CONFIG.world }));
  } else logChat('*', 'not connected — try again in a moment');
}

/** Moderation messages that are not world verbs: 'world-bans' (list this
 *  world's bans — anyone), 'global-ban' / 'global-unban' / 'global-bans'
 *  (operator only; the server enforces). Replies arrive as `mod` messages. */
export function sendMod(type, extra = {}) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type, ...extra }));
  } else logChat('*', 'not connected — try again in a moment');
}

/** #104 phase-1: ask the sequencer to mint this body's media credential. */
export function sendRelayCredRequest(scopes = {}) {
  if (net.joined && net.ws?.readyState === 1) net.ws.send(JSON.stringify({ type: 'relay-cred', ...scopes }));
}
/** #104 amendment 3: listener-authored receive consent, server-enforced. */
export function sendVoiceConsent(recv) {
  if (net.joined && net.ws?.readyState === 1) net.ws.send(JSON.stringify({ type: 'voice-consent', recv: !!recv }));
}
export function sendTyping(to, state) {
  if (net.joined && net.ws?.readyState === 1 && (!to || hasActor(to))) net.ws.send(JSON.stringify({ type: 'typing', to, ...actorFor(to, 'toActor'), ...(state ? { state } : {}) }));
}

/** Transient, never-logged relay — used while a build drag is in flight so
 *  other people see the object moving before the single committed `place`. */
export function sendDrag(id, pos, yaw, q = null, { end = false, scale = null } = {}) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'drag', id, pos, yaw, ...(q ? { q } : {}), ...(scale ? { scale } : {}), ...(end ? { end: true } : {}) }));
  }
}

/** This page's presence session: one id for as long as the page lives, sent
 *  with every join, so listeners can tell a reconnect (the same page, whose
 *  utterance counter goes on) from a new page (whose counter starts again).
 *  index.html's early socket sends the first join, with the same id. */
const PAGE_SESSION = (globalThis.__ewPageSession ??= globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

export function sendJoin() {
  const id = CONFIG.renderer ? `renderer-${CONFIG.name}`
    : CONFIG.spectate ? `retina-${CONFIG.name}` : CONFIG.name;
  net.ws.send(JSON.stringify({
    type: 'join', world: CONFIG.world, id,
    avatar: hooks.myAvatarPath(),
    spectate: CONFIG.spectate || CONFIG.renderer,
    renderer: CONFIG.renderer,
    ...(CONFIG.roam ? { roam: true } : {}),
    token: CONFIG.token,
    ...(CONFIG.account ? { account: CONFIG.account } : {}),
    // this client folds the world's log stream itself (the server refuses a client that doesn't)
    replica: true,
    session: PAGE_SESSION,
    clock: true,   // the server's time just before the snapshot ('clock' below)
  }));
}

// ---- requests: {type: 'request', id, verb, args} → {type: 'reply', id, ok, reply} (server/requestwire.ts) ----
let requestSeq = 0;
const pendingRequests = new Map();   // id → {resolve, timer}
/** One request; resolves with the authority's own reply ({ok, …} or {ok: false, refused: {code, reason, fix}}).
 *  Never rejects: a lost socket or a timeout is a refusal the caller shows like any other. When the request was sent
 *  and no answer came (a timeout, or the socket dropping after it went), the refusal also carries mayHaveLanded: true,
 *  since the authority may have done what it asked; one never sent (not connected) doesn't. */
export function sendRequest(verb, args = {}, { timeoutMs = 15000 } = {}) {
  if (!(net.joined && net.ws?.readyState === 1)) return Promise.resolve({ ok: false, refused: { code: 'offline', reason: 'not connected to the world', fix: 'wait for the connection to come back, then try again' } });
  const id = ++requestSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingRequests.delete(id); resolve({ ok: false, refused: { code: 'timeout', reason: `the authority didn't answer '${verb}' in ${timeoutMs / 1000} s`, fix: 'it may still land: look before trying again', mayHaveLanded: true } }); }, timeoutMs);
    pendingRequests.set(id, { resolve, timer, verb, ws: net.ws });   // the socket it went on: only that one's close fails it (I62)
    net.ws.send(JSON.stringify({ type: 'request', id, verb, args }));
  });
}
// The socket closed: no reply can come on it (request ids don't carry over to the next one), so every request still in flight
// is answered now, not by its 15 s timer (which held the body track that long after a reconnect, then spoke a stale timeout)
function failPending(ws = null) {
  for (const [id, p] of pendingRequests) { if (ws && p.ws !== ws) continue; pendingRequests.delete(id); clearTimeout(p.timer);
    p.resolve({ ok: false, refused: { code: 'offline', reason: `the connection dropped before the authority answered '${p.verb}'`, fix: 'it may have landed: look before trying again', mayHaveLanded: true } }); }
}
function onReply(msg) {
  const p = pendingRequests.get(msg.id); if (!p) return;
  pendingRequests.delete(msg.id); clearTimeout(p.timer);
  p.resolve(msg.reply ?? { ok: false, refused: { code: 'no-reply', reason: 'the authority sent no reply body' } });
}
/** The authority's fresh entries: fold them (replica.ingest), then hand state.js the new view of that fold (it tells the
 *  realizers what changed, in the protocol's terms). Chat lines take the chat path (they aren't world state). */
function onLog(msg) {
  if (!replica.active) return;
  // each entry's ts was the authority's clock no later than now: a floor that catches a clock step before the next ask
  for (const e of msg.entries ?? []) noteServerFloor(e?.ts);
  const r = replica.ingest(msg.entries ?? [], msg.from ?? -1, msg.names);
  if (r.resync) { console.warn(`[replica] can't continue this client's cut (${r.why}): asking for a fresh snapshot`); rejoin(); return; }
  // a chat line: into the window (the shared rule), then the live causes (bubbles, voice, chat log).
  // Numbered seq × 1000, as the server numbers it in its window and history.
  for (const x of r.says) {
    // the spoken trio (validated at the authority) rides along: chat merges a spoken utterance and places it by t0
    const e = { seq: x.seq * 1000, ts: x.ts, actor: x.actor, verb: 'say', args: { text: x.text, ...(x.to ? { to: x.to } : {}), ...(x.spoken ? { spoken: true, utt: x.utt, ...(x.t0 !== undefined ? { t0: x.t0 } : {}) } : {}) } };
    hear(shadowState.st, { actor: e.actor, text: x.text, ts: e.ts, seq: e.seq });
    if (hydrating) pendingLive.push(e);
    else if (e.seq > lastSeq) { lastSeq = e.seq; bus.emit('live-entry', e); noteSpeaking(e.actor); }
  }
  if (r.changed) narrate(applyView(replica.view(shadowState.st), { ts: r.ts ?? undefined }), r.actor);
  bus.emit('log-applied', { from: msg.from, n: msg.entries?.length ?? 0, entries: msg.entries ?? [] });
}
/** Say in chat who changed someone's role here, as the world's own narration (a ban or a kick arrives as `moderated`). */
function narrate(d, actor) {
  const who = actor === 'world' || !actor ? 'the world' : actor; const st = shadowState.st;
  // people by name (the directory's, sent beside the entries), never their u-… id (Commons audit #1); '*' is everyone
  const person = (id) => (id === '*' ? 'everyone without a role' : actorName(id));
  for (const id of d?.ids?.roles ?? []) {
    const rec = st.roles?.[id];
    if (!rec) { logChat('*', `${who} took away ${person(id)}'s role here`); continue; }
    const bits = [rec.role, rec.gen != null ? (rec.gen ? '+gen' : '-gen') : null].filter(Boolean);
    logChat('*', `${who} made ${person(id)} ${bits.join(' ')}`);
  }
}

let lastPoseSent = 0;
/** Targeted ragdoll-drag traffic (grab / sim stream / release). Presence
 *  semantics: fire-and-forget, never logged. The target's client decides. */
export function sendBodyDrag(target, payload) {
  if (net.joined && net.ws?.readyState === 1 && hasActor(target)) {
    net.ws.send(JSON.stringify({ type: 'bodydrag', target, ...actorFor(target, 'targetActor'), ...payload }));
  }
}

// XR: the wire carries the AVATAR's actual yaw (root + its own chase of the head) and the look
// pitch while presenting — porch-old sent head yaw (index.html:11066–11072); remotes turn with the head.
let poseOverride = null;
export const setPoseOverride = (fn) => { poseOverride = fn; };
// spec/PHYSICS.md §5.1: one time base. Each sample carries its capture time on the authority's clock (once a round trip
// has measured it: a one-way guess runs late) and this sender's own count; the clock is re-measured every CLOCK_MS.
let poseSeq = 0, clockTimer = null;
const CLOCK_MS = 10_000;
function askClock() { if (net.ws?.readyState === 1) net.ws.send(JSON.stringify({ type: 'clock', t0: localNow() })); }
onClockDoubt(askClock);   // a stamp from the authority says our clock estimate is stale (it stepped): measure it now
function startClock() { clearInterval(clockTimer); askClock(); setTimeout(askClock, 1000); clockTimer = setInterval(askClock, CLOCK_MS); }
export function sendPose(now) {
  const s = hooks.myState;
  if (!net.joined || !hooks.me() || !s || now - lastPoseSent < 66) return;
  lastPoseSent = now;
  const ov = poseOverride?.();
  const pose = {
    p: [s.pos.x, s.pos.y, s.pos.z],
    yaw: ov?.yaw ?? s.yaw, speed: s.speed, clip: s.clip,
    pitch: Math.round((ov?.pitch ?? s.pitch ?? 0) * 100) / 100,
    ...wingFoldPresence(s.wingsFolded),
    ...(s.bodyMode ? { bodyMode: s.bodyMode } : {}),   // the body-mode (shared/bodymode.js; R 10-17: was the posture, read off the clip)
    ...presenceWire(presence()),        // present / away / busy — for the Who panel (R, 09-05)
    ...voiceWire(hooks.myVoice()),      // mic live / headphones on — the hover card, agents' look
  };
  const avatar = hooks.me();
  Object.assign(pose, bodyWire({ scale: avatar.userScale, plateY: avatar.plateY }));   // this body's size / plate lift — only when not default
  if (!avatar.onceAnim && !avatar._limp && Number.isFinite(avatar.current?.time)) {
    pose.clipTime = avatar.current.time;
    pose.clipTimeSlot = avatar.currentSlot;
    pose.clipRate = avatar.current.paused ? 0 : avatar.current.timeScale ?? 1;
  }
  if (ov?.xr) pose.xr = ov.xr;   // C18: tracked head/hands, facing-relative (xrbody.js) — presence, never the log
  if (s.anim) { pose.anim = s.anim; s.anim = null; } // an anim played once (pose.anim): sent once
  // what I press while I hold a thing (grabbable's presence tier: every receiver draws its fx while this rides;
  // absent = not pressing). Never logged: a use.down/up that changes the world is a request of its own
  if (s.useHeld) pose.use = s.useHeld;
  // full-body orientation and a locomotion bag (docs/UNDERWATER-PRESENCE.md): presence only, optional, never authority
  if (s.q) pose.q = s.q;
  if (s.locomotion) pose.locomotion = s.locomotion;
  // A held custom pose rides the presence packet (and therefore lastPose, so
  // late joiners see it) — but never the log. `null` explicitly clears it.
  if (s.pose !== undefined) pose.pose = s.pose;
  // Persistent body pins (bodydrag nails) ride presence the same way: state
  // of a BODY, visible to everyone, never the log. Null clears.
  if (s.pins !== undefined) pose.pins = s.pins;
  // Reach descriptors (shared/reachwire.js): a relation, not bones — every
  // receiver re-solves it live. Rides while active; absence means let go.
  const reach = myReachBag();
  if (reach !== undefined) pose.reach = reach;
  // my seat rides every frame while I sit (presence; world.js setBodySeat): {to: <socket id>}; absence means standing
  const seat = avatarMounts.get(CONFIG.name);
  // …with the pose I chose from its menu (and when: a sync group follows the latest), and my input where the socket
  // routes it (throttle/steer, aimYaw/aimPitch: signals every client computes my pose from; client/lib/socksignals.js)
  if (seat?.to) pose.seat = { to: seat.to, ...(seat.pose ? { pose: seat.pose, at: seat.at ?? 0 } : {}),
    ...(seat.in && Object.keys(seat.in).length ? { in: Object.fromEntries(Object.entries(seat.in).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) } : {}) };
  if (clockRtt() !== null) pose.t = Math.round(serverNow());
  pose.seq = ++poseSeq;
  net.ws.send(JSON.stringify({ type: 'pose', pose }));
}

// ---------------------------------------------------------------- connecting

/** Re-enter the world as somebody else.
 *
 *  The server keys a client by its id, so a rename is genuinely a new
 *  identity: this session leaves and a new one arrives. That is honest —
 *  everyone present sees it happen, rather than a name silently mutating on a
 *  body they were talking to. What does NOT follow you is anything the world
 *  filed under the old name: your remembered sleeping place. */
/** Re-assert a KNOWN body verbatim, plus whatever one-shot rides along.
 *
 *  sendPose() above SAMPLES a live body: it reads position, clip, pitch, wings, held
 *  pose and pins off myState and composes a packet. A client with no body has nothing
 *  to sample, and composing one from defaults is how #188 B2 happened - a lite user
 *  tapping `wave` stood up out of a sit, unfolded their wings and dropped their held
 *  pose, because the composer emitted its own defaults for every field it did not know
 *  to carry.
 *
 *  A pose is the resident's WHOLE public body, not a delta. So the renderer-free path
 *  sends back the server's own settled pose (the join snapshot's `restore`) unchanged,
 *  adding only the one-shot. Fields this client has never heard of survive by
 *  construction, which is the property a field-by-field rebuild cannot have.
 *
 *  @returns {boolean} whether it went out. */
export function sendPoseExact(pose) {
  if (!net.joined || net.ws?.readyState !== 1) return false;
  net.ws.send(JSON.stringify({ type: 'pose', pose }));
  return true;
}

export function rejoin() {
  intentionalClose = net.ws ?? true;   // the socket being replaced: its close is the one rejoin() answers for
  try { net.ws?.close(); } catch { /* already gone */ }
  net.joined = false;
  connect();
}

let intentionalClose = false;   // false, or the socket whose close rejoin() drives (true: one with no socket to name)

// archipelago-home session (home-node.md §7): the server may know who we are
// from the ew_sess cookie (set by /auth after a Discord login). Fetched once;
// a verified name OVERRIDES whatever localStorage remembers — the server will
// ignore our self-asserted id anyway, so the label should match the identity.
let identity;   // undefined = not asked yet, null = no session
let authCfg = null;

async function fetchIdentity() {
  if (identity !== undefined) return;
  [identity, authCfg] = await Promise.all([
    fetch('/whoami').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('/authcfg').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (identity) {
    CONFIG.authed = true;
    CONFIG.sub = identity.sub;
    // Remember that this browser entered verified — when the session later
    // expires (or a deploy predating session persistence dropped it), the
    // right move is back through the login, not the key door.
    localStorage.setItem('ew-authed', '1');
    if (identity.name && identity.name !== CONFIG.name) {
      CONFIG.name = identity.name;
      localStorage.setItem('ew-name', identity.name);
    }
  }
}

/** A logged-out returning Discord user goes back through the login — it
 *  round-trips without interaction while Discord still knows them. Key-link
 *  visitors (CONFIG.token) are never bounced, and one bounce per minute is
 *  the cap: if the identity node is down we fall through to the authority (which
 *  offers the same link) instead of redirect-looping. */
export function bounceToLogin() {
  if (identity || !authCfg?.login || CONFIG.token) return false;
  if (localStorage.getItem('ew-authed') !== '1') return false;
  const last = Number(sessionStorage.getItem('ew-login-bounce') ?? 0);
  if (Date.now() - last < 60_000) return false;
  sessionStorage.setItem('ew-login-bounce', String(Date.now()));
  location.href = authCfg.login;
  return true;
}

/** Resolve the verified identity BEFORE any UI reads CONFIG.name — main.js
 *  awaits this ahead of the front door, so the door greets the person Discord
 *  says they are instead of a stale localStorage name. Memoized. */
export async function initIdentity() {
  await fetchIdentity();
  return identity;
}

/** The deployment's login URL, if identity is wired up — the authority offers it as
 *  the keyless way in. Only meaningful after initIdentity()/connect(). */
export function loginUrl() {
  return authCfg?.login ?? null;
}

export async function connect() {
  await fetchIdentity();
  // Login-required deployment and we have neither a session nor a door key:
  // go get one. The home node round-trips through /auth back to here.
  if (!identity && authCfg?.required && authCfg?.login && !CONFIG.token) {
    location.href = authCfg.login;
    return;
  }
  // Not required, but this browser used to be logged in and isn't anymore —
  // re-login is silent while Discord still authorizes, so don't make them
  // rediscover the authority.
  if (bounceToLogin()) return;
  // The early socket (inline boot script in index.html): the HTML may have
  // already opened the WS and sent this exact join while the module graph
  // was still parsing — the snapshot downloaded DURING parse instead of
  // after it. Adopt it only when the join it sent is byte-for-byte the one
  // we would send now; on ANY mismatch (rename at the authority, avatar switch,
  // a login flow) close it and connect fresh. The early socket is an
  // optimization, never an authority.
  const early = globalThis.__ewEarlySocket;
  globalThis.__ewEarlySocket = null;
  if (early) {
    const wantJoin = JSON.stringify({ world: CONFIG.world, id: CONFIG.name,
      avatar: hooks.myAvatarPath(), token: CONFIG.token, ...(CONFIG.account ? { account: CONFIG.account } : {}) });
    const same = JSON.stringify(early.sent) === wantJoin;
    if (!early.failed && early.ws.readyState <= 1 && same) {
      net.status = 'connecting';
      bus.emit('net', net);
      net.ws = early.ws;
      joinRefusal = null;
      // Drain what raced ahead of us IN ORDER while the boot script's own
      // buffering handler still catches anything arriving mid-drain; the
      // rewire below is synchronous with the final empty check, so no
      // message can slip between the two.
      while (early.buffered.length) {
        const raw = early.buffered.shift();
        // When the boot script's message handler ran, so the server's `t` it
        // carries is sampled then rather than after the wait for this drain. Undefined
        // from a boot script older than `arrived`: the sample is taken now.
        const at = early.arrived?.shift();
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        try { await handle(msg, at); } catch (e) { report(`net ${msg.type}`, e); }
      }
      wireSocket(net.ws);   // live delivery takes over (onopen stays the boot script's)
      return;
    }
    // A socket mid-close (CLOSING) is about to say why: wait for its close (bounded) rather than dial over it.
    if (!early.closeInfo && early.ws.readyState === 2) await new Promise((res) => {
      const prev = early.ws.onclose; early.ws.onclose = (ev) => { try { prev?.(ev); } finally { res(); } }; setTimeout(res, 2000);
    });
    // The world REFUSED the early join (a 4xxx close: an old-format world, no such world, a removal, a bad key): that
    // refusal is the answer, not a reason to dial again. Read the server's words out of what the boot script buffered
    // and close exactly as a live socket would (R 10-16 00:02: this socket and its refusal were thrown away, the
    // redial's 4005 toasted a wrong "not a valid world name" under the splash, and she stepped into an empty world).
    // Only for the join this page would send (review r3 F6): a refusal of some OTHER join (a token, a name, a world the
    // page doesn't mean) is no answer to this page — it is discarded with the socket, and the page connects fresh.
    if (same && early.closeInfo?.code >= 4000) {
      net.status = 'connecting';
      for (const raw of early.buffered) {
        let msg; try { msg = JSON.parse(raw); } catch { continue; }
        if (msg?.type === 'error') noteRefusal(msg.error);
      }
      onSocketClosed(early.closeInfo);
      return;
    }
    try { early.ws.close(); } catch { /* already dead */ }
  }
  joinRefusal = null;
  net.status = 'connecting';
  bus.emit('net', net);
  net.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  net.ws.onopen = () => { sendJoin(); };
  wireSocket(net.ws);
}

/** close/error/message wiring, shared by a fresh connect and an adopted
 *  early socket (the inline boot script in index.html — see connect()). */
function wireSocket(ws) {
  ws.onclose = onSocketClosed;

  ws.onerror = () => { /* onclose always follows; nothing useful here */ };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    try { await handle(msg); } catch (e) { report(`net ${msg.type}`, e); }
  };
}

/** What the server said when it refused this join: the `error` that arrives before the snapshot is the refusal's own
 *  words, and the close (4005 …) that follows shows THEM rather than a guess from the code. Reset per connection. */
let joinRefusal = null;
function noteRefusal(text) { if (!net.joined && text) joinRefusal = String(text); }

/** A refused join, shown where the person is looking: the splash stays (or comes back) with the server's sentence on
 *  it (boot.js refuseBoot) — never a toast under the splash over an empty world. */
function showRefusal(text) {
  net.status = 'rejected';
  bus.emit('net', net);
  failSays();
  refuseBoot(text);
  bus.emit('join-refused', { text });
}

/** The socket's close, live or the early socket's (connect()). One place decides what each close code means. */
function onSocketClosed(ev) {
  // a socket already replaced (rejoin dials before the old close lands: it waits at most 2 s) answers its own requests
  // and nothing else: the live socket's requests, its join and its clock are not its to end (house review I62)
  const sock = ev?.target ?? null;
  failPending(sock);
  if (sock && net.ws && sock !== net.ws) { if (sock === intentionalClose) intentionalClose = false; return; }
  clearInterval(clockTimer); clockTimer = null;
  net.joined = false;
  // rejoin() drives its own reconnect, for the socket it replaced only: the NEW socket dropping before the old close
  // lands must still redial (review of I62: a shared flag let the new socket's close use it up, and nothing redialled)
  if (intentionalClose && (intentionalClose === true || intentionalClose === sock || !sock)) { intentionalClose = false; return; }
  // 4002 = session takeover: this identity re-arrived elsewhere. Retrying
  // would kick THAT session and ping-pong forever.
  if (ev.code === 4002) {
    net.status = 'rejected';
    bus.emit('net', net);
    failSays();
    toast(`"${CONFIG.name}" is connected in another tab. This one has yielded — reload to take over.`, 'warn', 60000);
    return;
  }
  // 4006 = removed by moderation (kicked or banned). The server already
  // explained itself in an error toast just before closing. No retry: a
  // banned door will not open, and auto-rejoining after a kick would make
  // the kick meaningless — coming back is a deliberate reload.
  if (ev.code === 4006) {
    net.status = 'rejected';
    bus.emit('net', net);
    failSays();
    toast('you were removed from this world — reload if you believe you may return', 'warn', 60000);
    return;
  }
  // 4010 = this world is not open to you (access.ts ACCESS_CLOSE): refused at the door (listed people only, watch only),
  // or your access just ended or was changed. The server said why in an `error` just before closing. No retry — the
  // door won't open on its own; coming back is a deliberate reload (or ?spectate, when it said you may watch).
  if (ev.code === 4010) {
    showRefusal(joinRefusal ?? `you're not in "${CONFIG.world}" — reload if your access changes`);
    return;
  }
  // 4011 = there's nothing to watch here YET (a spectator of a world nobody has founded): not a refusal — try again,
  // backing off, so an observer started early joins once the world exists.
  if (ev.code === 4011) {
    net.status = 'retrying';
    bus.emit('net', net);
    setTimeout(connect, redial.next(REDIAL.full));
    return;
  }
  // 4005 = a refused join: a malformed name, no such world, an old-format world, a client that doesn't fold the log.
  // No retry — the answer won't change, so reconnecting is just hammering the authority. The server says why in an `error` just before this close; that sentence is shown. Without one, the close
  // reason picks the words (the server's reasons: "old-format world", "no such world", "bad world name", …).
  // 4005 "full" = the world is at its access max: TRANSIENT — someone leaving makes room. Say the server's words (on
  // the splash if it is still up, else a toast) and try again, backing off; never pinned as the answer (review r3 F6).
  if (ev.code === 4005 && String(ev.reason ?? '') === 'full') {
    const text = `${joinRefusal ?? `"${CONFIG.world}" is full`} — trying again by itself`;
    if (!waitBoot(text)) toast(text, 'warn', 8000);
    net.status = 'retrying';
    bus.emit('net', net);
    setTimeout(connect, redial.next(REDIAL.full));
    return;
  }
  if (ev.code === 4005) {
    const why = String(ev.reason ?? '');
    showRefusal(joinRefusal ?? (
      /old-format/i.test(why) ? `"${CONFIG.world}" was saved by an older version of Eidoverse and needs a one-time conversion by whoever runs this server. Nothing is lost.`
      : /no such world/i.test(why) ? `there's no world called "${CONFIG.world}" here — check the link that brought you here`
      : /world name/i.test(why) ? `"${CONFIG.world}" is not a valid world name — check the link that brought you here`
      : `"${CONFIG.world}" refused this visit${why ? ` (${why})` : ''} — reload to try again`));
    return;
  }
  // 4003 = bad or missing door key. This used to fall through to the generic
  // retry, so a wrong key hammered the authority forever while the client said
  // "disconnected — retrying…" and never explained why.
  if (ev.code === 4003) {
    net.status = 'rejected';
    bus.emit('net', net);
    failSays();
    // If we entered verified, this refusal means the session died
    // server-side (TTL lapsed mid-visit). The cached identity is stale —
    // drop it and go back through the login rather than asking for a key
    // this person never had.
    if (CONFIG.authed) {
      identity = null;
      CONFIG.authed = false;
      if (bounceToLogin()) return;
    }
    bus.emit('bad-key');
    return;
  }
  net.status = 'retrying';
  bus.emit('net', net);
  setTimeout(connect, redial.next()); // back off instead of hammering
}

// ---------------------------------------------------------------- handling

/** ONE teardown for a departed participant — every leave-shaped exit
 *  (ordinary leave, kick/ban's broadcast leave, the reconnect snapshot's
 *  roster prune) funnels here so the whole generation dies together (#95):
 *  drag custody FIRST (a drag sim holds bone references into the avatar
 *  about to be disposed — the one-frame-late recovery double-disposed a
 *  VRM), then the voice peer and its analyser, then the body itself
 *  (avatar root, nameplate, bubbles, typing dots and held poses all hang
 *  off the avatar and dispose with it). Ownership stays explicit — each
 *  line names the table it clears. A body's seat (avatarMounts) is presence,
 *  fed by its frames: dropRemote clears it with the body.
 *  `expected` makes the drop generation-conditional (see dropRemote). */
export function teardownParticipant(id, expected) {
  // The generation check comes BEFORE any side effect: a predecessor's stale
  // cleanup must be a COMPLETE no-op — emitting the custody event first let
  // it strip the successor's drag state even though the drop itself refused
  // (#97 review B1). Only a caller who owns the current record may tear.
  if (expected && remotes.get(id) !== expected) return null;
  bus.emit('participant-teardown', id);   // bodydrag releases custody before the bones vanish
  const dropped = dropRemote(id, expected);
  // The voice peer (and its analyser) rides the 'roster' sweep every caller
  // emits right after this — voice.js imports net, so calling into it here
  // would close an import cycle; the sweep is the same teardown, one event
  // later in the same turn, and it is generation-safe because it keys on
  // absence from `remotes`, which this drop just established.
  return dropped;
}

/** Presence for an id the world never announced (or already dismissed) is
 *  dropped, counted, and said a few times — the flight-recorder spirit,
 *  the noteMalformed bound. */
let stalePresenceSeen = 0;
export const stalePresenceCount = () => stalePresenceSeen;
/** test seam — the wire, minus the socket (tools/remotes-lifecycle-test.ts
 *  drives the dispatch directly; the server's per-socket FIFO is the test's
 *  license to sequence messages by hand) */
export const _dispatch = (msg) => handle(msg);
function noteStalePresence(id) {
  if (stalePresenceSeen++ >= 5) return;
  console.warn(`[net] presence for unannounced id "${id}" dropped (straggler from a departed generation?)`);
}

/** `at`: the performance.now() when the boot script's handler took an
 *  early-socket message (the drain in connect()); undefined for a message
 *  handled as its event runs. */
async function handle(msg, at) {
  switch (msg.type) {
    case 'snapshot': startClock(); return onSnapshot(msg);

    // Two answers share the name: a round trip's ({t0, t}: the ask in askClock below), and the server's time sent
    // just before each snapshot to a join that asks ({t} alone: sendJoin's and the boot script's do), a one-way sample
    // taken before the snapshot's sounds are seeked, so the first seek isn't on this machine's own clock
    // (client/lib/serverclock.js says how each is kept).
    case 'clock': if (msg.t0 !== undefined) noteRoundTrip(msg.t0, msg.t, localNow()); else noteServerTime(msg.t, at); break;

    case 'your-rights': {
      // Personalized effective rights, folded by the authority after every
      // grant. This is the live answer for wildcard/sub/name precedence; the
      // browser never has to approximate it from one partial delta.
      if (msg.rights) {
        net.myRights = msg.rights;
        bus.emit('your-rights', net.myRights);
      }
      break;
    }

    case 'arrive':
      // `authority: true` — an arrive is the world SAYING this person exists.
      // On a takeover (same id re-arriving; the server suppresses the old
      // connection's leave) the predecessor generation RETIRES WHOLE before
      // the successor takes ownership (#97 review): the same generation-end
      // event a leave emits releases drag custody and drops the voice peer
      // + analyser — the roster sweep cannot, because the id remains
      // present — and ensureRemote resets the mesh's transient expressions
      // before transplanting it into a fresh record.
      if (remotes.has(msg.id)) bus.emit('participant-teardown', msg.id);
      bus.emit('participant-session', { id: msg.id, session: msg.session });
      ensureRemote(msg.id, msg.avatar, { declares: msg.declares ?? null, authority: true });   // §6a: a declared status (any word), absent = undeclared; shown as said, never sorted into kinds
      if (msg.actorId) identities.set(msg.id, msg.actorId);
      if (msg.guest) guests.add(msg.id); else guests.delete(msg.id);
      logChat('*', `${msg.id} arrived`);
      bus.emit('roster');
      break;

    case 'leave':
      teardownParticipant(msg.id);
      logChat('*', `${msg.id} left`);
      bus.emit('roster');
      break;

    case 'pose': {
      // Presence UPDATES bodies; it never creates them (#95). A pose for an
      // id we don't hold is a straggler from a departed generation — the
      // server's per-socket order guarantees a living body's authority
      // (snapshot roster or arrive) precedes its first sample, so there is
      // no legitimate frame-before-authority to buffer for. Creating here
      // is how one stale sample rebuilt the departed as a default-avatar
      // ghost with a live nametag (the sunflower specimen, and #56's
      // stand-forever race through the same door).
      if (remotes.has(msg.id)) pushPose(msg.id, msg.pose, msg.t);
      else noteStalePresence(msg.id);
      break;
    }

    case 'frame': {
      // Batched embodied plane: one message per server tick, latest pose per
      // id. Same law as `pose`: update-only, never create — and with no
      // creation there is no fire-and-forget load whose completion could
      // deliver a departed generation's sample into a successor's buffer.
      noteServerTime(msg.t, at);
      for (const [id, pose] of Object.entries(msg.poses)) {
        if (id === net.myId) continue; // our own echo — local prediction owns this body
        if (remotes.has(id)) pushPose(id, pose, msg.t);
        else noteStalePresence(id);
      }
      break;
    }

    case 'drag': {
      // transient build feedback — apply without logging anything
      bus.emit('drag', msg);
      break;
    }

    case 'history': case 'debug': {
      const p = pendingHistory.get(msg.reqId);
      if (p) { pendingHistory.delete(msg.reqId); p(msg); }
      break;
    }

    // SFU transport (VOICE_TRANSPORT=sfu). This switch has NO default branch —
    // an unrouted type is silently dropped — which is why the first version of
    // the SFU client sat at active:false forever: the server offered, the
    // browser never saw it, and nothing anywhere said so.
    case 'sfu-offer': bus.emit('sfu-offer', msg); break;
    case 'sfu-ice':   bus.emit('sfu-ice', msg);   break;
    case 'sfu-route': bus.emit('sfu-route', msg); break;
    case 'relay-cred':          // #104: the minted media credential (voicerelay.js)
      window.__voiceRelayAbsent = false;   // a relay answered: an earlier "no relay" (a server restarted without voice) is over
      bus.emit('relay-cred', msg);
      break;
    case 'voice-consent':       // #104: server's ack of a receive-consent change
      bus.emit('voice-consent-ack', msg);
      break;
    case 'voice-service':       // #104 A2: relay service state, incarnation-stamped
      bus.emit('voice-service', { state: msg.state, incarnation: msg.incarnation });
      break;
    // #57 B1/B4 presence messages (never logged):
    // performed — an authenticated voice leg attested it aired this say;
    // surface-transition — an aux leg joined or took over (capability signal).
    case 'performed':
      bus.emit('performed', { actor: msg.id, seq: msg.seq, gen: msg.gen });
      break;
    case 'surface-transition':
      bus.emit('surface-transition', { actor: msg.id, surface: msg.surface, gen: msg.gen, retired: msg.retired });
      break;

    case 'caption':
      // live speech pacing (presence, never logged) — the bubble speaks in
      // real time; the log gets the whole utterance as one say at the end
      bus.emit('caption', { actor: msg.id, text: msg.text });
      break;

    case 'typing':
      if (msg.id !== net.myId) {
        noteTyping(msg.id);                                // chat window "X is typing…"
        remotes.get(msg.id)?.avatar?.setTyping(msg.state); // dots — or a state glyph
      }
      break;

    case 'anim': {
      if (msg.id === net.myId) break;
      remotes.get(msg.id)?.avatar?.playAnimation(msg);
      break;
    }

    case 'puppet':
      // Someone wants to pose US. A puppet is an INPUT to our own body, not a
      // pose asserted onto it — main.js decides whether to honour it and then
      // drives our avatar through the normal presence path.
      bus.emit('puppet', msg);
      break;

    case 'bodydrag':
      // someone is (asking to be, or currently) dragging MY body — same
      // doctrine as puppet: an input my client applies to itself, or refuses
      bus.emit('bodydrag', msg);
      break;

    case 'holds':
      // who holds what (the authority's presence plane, design 20 P2): thingphysics.js draws each held thing in its holder's hand
      bus.emit('holds', msg.holds ?? {});
      break;

    case 'geom':
      // the placeholder tier's bbox side-channel — arrives a beat after the
      // snapshot (async summaries; the join send stays synchronous). Bus,
      // not import: the models realizer listens (net must not import it).
      bus.emit('lib-geom', msg.geom ?? {});
      break;

    case 'body-inbox':
      // the authority's body inbox (PROTOCOL L6): asks waiting for me, replies to my asks, acts delivered, revocations.
      // people.js holds them (consentinbox.js), marks the asker's row in People Here and offers Allow / Not now / Never.
      bus.emit('body-inbox', msg);
      break;
    case 'log': onLog(msg); break;
    case 'reply': onReply(msg); break;

    case 'renderer-travel':
      // a roaming renderer is wanted elsewhere (server/snapshots.ts summon): go there — the same in-page re-join a
      // person's travel uses. Only a roaming renderer obeys; anyone else ignores it.
      if (CONFIG.renderer && CONFIG.roam && typeof msg.world === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(msg.world) && msg.world !== CONFIG.world) {
        CONFIG.world = msg.world; rejoin();
      }
      return;

    case 'capture':
      // The reply is the snapshot's to produce and the wire's to send, so a client
      // without a renderer answers with an error instead of going quiet on an id
      // someone is waiting for. See net_capture.js (wired by main.js).
      capture(msg).then((r) => net.ws?.send(JSON.stringify({ type: 'capture-result', id: msg.id, ...r })));
      return;

    case 'avatar-updated': {
      // an avatar file was re-uploaded: drop stale bytes and hot-swap wearers
      const fresh = `${msg.path}?v=${msg.v}`;
      forgetBytes(msg.path);
      bus.emit('avatar-updated', { ...msg, fresh });
      for (const [id, r] of remotes) {
        if (r.avatarPath && r.avatarPath.split('?')[0] === msg.path) ensureRemote(id, fresh);
      }
      logChat('*', `avatar "${msg.name}" updated (v${msg.v})`);
      break;
    }

    case 'avatar-profile-updated': {
      // a seat profile was proposed or countersigned (#101) — occupants.js holds
      // the cache and the generation guard; this is just the wire → bus hop
      bus.emit('avatar-profile-updated', msg);
      break;
    }

    case 'defs-updated': {
      // a def changed on disk (§24 hot reload) — wire → bus hop; world.js
      // re-fetches the registry and regrows what the changed content shapes
      bus.emit('defs-updated', msg);
      break;
    }

    case 'world-forked': {
      // The link stands alone at the end of the line, never inside brackets —
      // naive linkifiers (ours included, once) swallow closing punctuation
      // into the URL, and ?world=name) points at a world that cannot exist.
      const link = `${location.origin}/?world=${encodeURIComponent(msg.to)}`;
      logChat('*', `world copied — "${msg.from}" → "${msg.to}" — visit: ${link}`);
      toast(`copied to "${msg.to}" — open ?world=${msg.to} to visit`, 'info', 12000);
      break;
    }

    case 'world-founded': {
      const link = `${location.origin}/?world=${encodeURIComponent(msg.name)}`;
      logChat('*', `your new world "${msg.name}" is ready — you own it — visit: ${link}`);
      toast(`founded "${msg.name}" — open ?world=${msg.name} to go there`, 'info', 12000);
      bus.emit('world-founded', msg);
      break;
    }

    case 'world-reset': {
      // The world we are standing in just ceased to exist as we know it.
      // Everything client-side — terrain, grass, sky, entities, chat — was
      // built from a log that is now empty; a reload through the normal join
      // path is the one rebuild that cannot disagree with the server.
      toast(`${msg.by} reset "${msg.world}" to zero — reloading…`, 'warn', 4000);
      logChat('*', `${msg.by} reset this world to zero`);
      shadowReset();
      setTimeout(() => location.reload(), 1800);
      break;
    }

    case 'mod':
      // Moderation replies (ban lists, global-ban confirmations) — chat is
      // where the person is looking when they issue the command.
      for (const line of String(msg.text ?? '').split('\n')) logChat('*', line);
      break;
    case 'moderated':
      // someone was removed or banned here (or a ban lifted): what everyone else is told (names only).
      // `you`: the act was on you (a mute): said to you, with how long
      if (msg.you) { const until = msg.until ? ` until ${new Date(msg.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
        const what = msg.verb === 'mute' ? `muted your ${(msg.channels ?? ['voice', 'chat']).join(' and ')}` : msg.verb;
        logChat('*', `${msg.by} ${what}${until}${msg.reason ? ` — ${msg.reason}` : ''}`); bus.emit('moderated-me', msg); }
      else logChat('*', String(msg.text ?? ''));
      break;
    case 'warned':
      // a warning (research roles §5): a notice you dismiss, and a line in chat to keep
      logChat('*', `${msg.by} warned you: ${String(msg.reason ?? '')}`);
      bus.emit('warned', msg);
      break;
    case 'mod-state':
      net.modMuted = msg.muted && typeof msg.muted === 'object' ? msg.muted : {};
      bus.emit('roster');
      break;

    case 'access-state':        // the world panel's 🔒 access tab (accesspanel.js)
    case 'access-directory':
      bus.emit(msg.type, msg);
      break;

    case 'notice':
      // The world telling YOU something that is not a refusal — today, that
      // your access here ends soon. Toast (it matters now) and chat (so it is
      // still there when you look). Not an `error`: that would also tell every
      // optimistic preview its verb was refused.
      toast(String(msg.text ?? ''), 'warn', 20000);
      logChat('*', String(msg.text ?? ''));
      break;

    case 'error':
      // the world tells us it has no voice relay only when we try to use one —
      // remember it, so the mic glyph can say WHY it stays off (R, 09-04)
      if (/no voice relay/i.test(String(msg.error ?? ''))) window.__voiceRelayAbsent = true;
      noteRefusal(msg.error);   // before the snapshot, an error is the join's refusal: its close shows these words
      // Server-side refusals are the user's problem to see, not the console's.
      toast(msg.error, 'warn');
      // ...and any module holding an optimistic preview needs to hear it: a
      // refused verb never folds, so a preview kept past this moment is a
      // world that never existed (lights.js rolls its edits back off this).
      // The wire names no verb — every refusal on this socket is ours.
      bus.emit('verb-refused', { error: String(msg.error ?? '') });
      break;
  }
}

async function onSnapshot(msg) {
  // what the server says you may do here; live grants keep it fresh via world.js
  net.myRights = msg.yourRights ?? { role: 'builder', gen: true };
  // the body roster rides the snapshot — resolveMyAvatarPath and the avatar
  // panel read it with no /avatars round-trip (older servers: field absent,
  // consumers fall back to the lazy fetch)
  if (msg.avatars) { net.avatars = msg.avatars; bus.emit('avatars', msg.avatars); }
  bus.emit('your-rights', net.myRights);
  markPhase('connect', 1);
  net.joined = true;
  redial.reset();
  net.status = 'live';
  net.myId = msg.you;
  net.mySub = msg.yourSub ?? null;
  net.renameAfter = msg.renameAfter ?? null; net.renameCooldownDays = msg.renameCooldownDays ?? null;   // profile.js's name dialog
  if (msg.renameRefused) { const d = new Date(msg.renameRefused.until);
    toast(`still “${msg.you}”: names change once every ${msg.renameCooldownDays} days — “${msg.renameRefused.tried}” can be yours from ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`, 'info', 12000); }   // the durable subject the authority vouched for, if any — what guarded things match on
  // The server's `you` is authoritative (verified identity, or a suffixed name
  // when two people share a nick). If it differs from what this client thinks,
  // adopt it — and say so, a silently different nameplate is confusing.
  // Renderer/spectator clients join under a transport prefix ("renderer-" /
  // "retina-", see sendJoin) that is part of the wire id, not the name. Strip
  // it before comparing and storing, or ew-name grows one prefix per reload
  // (renderer-renderer-…) — unless the ack is a verified identity, which the
  // server named itself (base.js nameFromJoinAck).
  const you = nameFromJoinAck(msg.you, { renderer: CONFIG.renderer, spectate: CONFIG.spectate, verified: !!msg.yourSub });
  if (you && you !== CONFIG.name && !msg.renameRefused) {
    CONFIG.name = you;
    localStorage.setItem('ew-name', you);
    toast(`you're appearing as “${msg.you}”`, 'info', 8000);
  } else if (msg.renameRefused) { CONFIG.name = msg.you; localStorage.setItem('ew-name', msg.you);
    try { const u = new URL(location.href); if (u.searchParams.has('name')) { u.searchParams.set('name', msg.you); history.replaceState(null, '', u); } } catch { /* fine */ } }
  // a RE-join: lastSeq is still the last entry the old socket delivered, and
  // what was said after it may be trimmed out of this snapshot's chat window
  // (fair, not contiguous). Fetch it before lastSeq moves on. A first join has rendered nothing and is a no-op.
  // lastSeq is already in the chat's numbering (seq × 1000: onLog, the server's window and readHistory alike).
  if (lastSeq >= 0) void resyncChatAfter(lastSeq);
  if (typeof msg.throughSeq === 'number' && msg.throughSeq > lastSeq) lastSeq = msg.throughSeq;
  bus.emit('net', net);
  bus.emit('participant-sessions', msg.present ?? []);
  // #57 matrix 7: who has which aux legs live NOW (surface-transition keeps it
  // current after this). Consumers key hold-then-fallback TTS on it.
  bus.emit('surfaces', [...(msg.present ?? []),
    ...(msg.yourSurfaces?.length ? [{ id: msg.you, surfaces: msg.yourSurfaces }] : [])]);

  if (msg.recording && !onSnapshot._noted) {
    onSnapshot._noted = true;
    logChat('*', '⏺ this performance is being recorded (movement + chat, for the archive)');
  }

  // wake where you fell asleep — but never teleport a body that has already
  // moved this session (mid-session reconnects keep local truth)
  const s = hooks.myState;
  // `s &&` used to be part of this test, which quietly made the restore undeliverable to
  // any client without a live body - and a renderer-free one has none by construction
  // (#188 B2: its gesture went out carrying defaults because the remembered body never
  // arrived to carry instead). What the guard actually protects is a body that has
  // ALREADY MOVED this session; no body cannot have moved, so it has nothing to protect
  // and the restore should land.
  if (msg.restore && !restoredPose && (!s || s.speed === 0)) {
    restoredPose = true;
    hooks.onRestore(msg.restore);
  }
  restoredPose = true; // first snapshot decides, restore or not

  // reconcile: the snapshot is authoritative — tear down any participant no
  // longer present, through the SAME funnel a leave uses (custody, then
  // body; the voice peer rides the roster emit below). Stale ghosts
  // otherwise survive reconnects forever — and before #95 they survived
  // with their side tables intact.
  const present = new Set(msg.present.map((p) => p.id));
  for (const id of [...remotes.keys()]) if (!present.has(id)) teardownParticipant(id);

  // remote avatars build in parallel and never block log replay — the
  // roster is an AUTHORITY: a same-id record here is a fresh generation
  identities.clear(); guests.clear(); if (msg.cut?.you) net.you = msg.cut.you;
  for (const p of msg.present) {
    if (p.actorId) identities.set(p.id, p.actorId);
    if (p.guest) guests.add(p.id);
    ensureRemote(p.id, p.avatar, { declares: p.declares ?? null, authority: true })
      .then(() => { if (p.pose) pushPose(p.id, p.pose); })
      .catch((e) => report(`present ${p.id}`, e));
  }

  // State adopts the snapshot FIRST, synchronously: the authority's own cut, drawn as the view of THIS client's fold of it
  // (the snapshot's `state` is the chat window: chat isn't world state).
  if (!msg.cut?.state) { replica.reset(); report('snapshot', new Error('the server sent no world cut (an old server?)')); return; }
  replica.adopt(msg.cut); bus.emit('my-acts', msg.cut.mine ?? []); bus.emit('cut-adopted'); bus.emit('holds', msg.cut.holds ?? {});
  shadowHydrate(replica.view(msg.state), typeof msg.throughSeq === 'number' ? msg.throughSeq : -1);

  hydrating = true; pendingLive = [];
  // flush the chat lines that raced us, in order, once, after the hydration window so a raced say lands below the
  // arrival chat window, not above it.
  const backlog = pendingLive.filter((e) => (e.seq ?? -1) > lastSeq).sort((a, b) => a.seq - b.seq);
  pendingLive = []; hydrating = false;
  for (const e of backlog) {
    lastSeq = e.seq;
    bus.emit('live-entry', e);
  }

  const rc = msg.state?.recentChat ?? [];
  noteHistoryContext({
    total: msg.state?.chatTotal ?? null,
    // what was ACTUALLY rendered: the window is exactly state.recentChat
    // (tail says beyond its 40-line cap are not re-played — they are
    // fetchable by paging, and this count is what makes the "showing N of
    // M" hint appear so a reader knows to page; review B2).
    shown: rc.length,
    spanMs: rc.length > 1 ? rc[rc.length - 1].ts - rc[0].ts : null,
  });

  // Honest world progress: the phase tracks the scheduler's outstanding
  // entity loads instead of jumping 0→1 (boot.js weights 'world' at 40 —
  // this is the bar's biggest segment actually moving with the loads).
  // The curtain does NOT wait on this; checkReady gates on body + state +
  // terrain + the first sky's capped pipeline warm (world.applySkyFolded).
  const initialPending = pending(P.FAR);
  if (initialPending > 0) {
    markPhase('world', Math.max(0.15, 1 - initialPending / (initialPending + 1)));
    const tickProgress = setInterval(() => {
      const left = pending(P.FAR);
      markPhase('world', 1 - 0.85 * (left / initialPending));
      if (!left) { clearInterval(tickProgress); markPhase('world', 1); }
    }, 200);
  } else markPhase('world', 1);
  bus.emit('hydrated');
  bus.emit('roster');
  hooks.onSnapshotDone();
  flushSays();   // what was typed while we were away, now that the world is back (after its chat window, so it reads in order)
}
