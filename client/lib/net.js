// net — the wire. One socket carrying two planes: the world log (ordered,
// persisted, replayed on join) and presence (batched, lossy, never persisted).

import { CONFIG, report, bus, nameFromJoinAck, LAST_WORLD_KEY, TAB_WORLD_KEY, pickWorld, rememberedWorlds, isWorldName } from './base.js';
import { avatarMounts } from './mounts.js';   // not world.js: that pulls core.js (the renderer) into lite
// every snapshot and live entry folds here, synchronously, through shared/protocol/replica.js (the authority's own
// fold); state.js hands the realizers the view of it (parity.js foldParity measures drift)
import { hydrate as shadowHydrate, reset as shadowReset, state as shadowState, applyView } from './state.js';
import { hear } from '../../shared/chatwindow.js';
import { refusalText } from '../../shared/protocol/refusal.js';
import { helloOf, refusalWords } from '../../shared/protocol/hello.js';
import { pending, P } from './render/scheduler.js';
// chat lines (fold-inert) go over the bus as 'live-entry' (realize/livechat.js listens; emitted, not imported, to
// stay out of the net → chat → net cycle)
import { wingFoldPresence } from '../../shared/wingpresence.js';
import { presenceWire, voiceWire, bodyWire } from '../../shared/presencewire.js';
import { serverNow, localNow, noteRoundTrip, clockRtt, noteServerFloor, onClockDoubt } from './serverclock.js';
import { presence } from './ui/presence.js';
import { logChat, noteTyping, noteHistoryContext, resyncChatAfter, moderatorHeader } from './ui/chat.js';
import { markPhase, refuseBoot, waitBoot } from './boot.js';
import { showOldFormat } from './ui/upgradeview.js';
import { OLD_FORMAT_SPLASH } from '../../shared/oldformat.js';
import { makeReplica } from '../../shared/protocol/replica.js';
import { redialer, REDIAL } from '../../shared/redial.js';
import { actorName } from '../../shared/protocol/names.js';
// the fold's records are frozen on a dev host (a reader that writes into one throws where it stands); a visitor's
// browser skips the walk
export const replica = makeReplica({ freeze: CONFIG.dev });
/** Is this client in a world (it has adopted the authority's cut)? */
export const replicaActive = () => replica.active;
// a notifier instead of importing ui.js; the default logs, so a dropped-connection notice never goes missing
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
// when to dial again after a close (shared/redial.js); reset only by a join the server accepted (the snapshot)
const redial = redialer();

// supplied by main.js, so net reads body state without importing the controller
let hooks = {
  myAvatarPath: () => '',
  myState: null,
  me: () => null,
  onRestore: () => {},
  onSnapshotDone: () => {},
  myVoice: () => null,   // { mic, hear } — main.js reads the HUD glyphs' own state (mictoggle.js)
};

// The participant registry, the asset ledger and the capture renderer are injected too: importing remotes.js /
// assets.js / capture.js would drag the engine into the lite client. Defaults are inert; main.js and lite.js wire them.
let remotes = new Map();
let ensureRemote = async () => null;
let dropRemote = () => null;
let pushPose = () => {};
let noteServerTime = () => {};
let noteSpeaking = () => {};
let forgetBytes = () => {};
let myReachBag = () => undefined;   // only sendPose reads it; undefined means "let go"
// a client with no renderer must still answer a capture (the asker is blocked on the reply id)
const noRenderer = async () => ({ error: 'this client has no renderer' });
let capture = noRenderer;
let warnedNoRenderer = false;

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

// Every write is a request (sendRequest below; edits go through edit/writes.js sendOps). No verb crosses the wire.

/** People present, by the name they show → the identity the world knows them by (u-…; sent on arrive and in the
 *  join roster). A role, a ban or a rollback goes to this, never to a typed name. */
export const identities = new Map();
/** A person's name: as they show it here, else as the world last named them, else their id (the people panels read this). */
export const presentName = (id) => { for (const [n, v] of identities) if (v === id) return n; return null; };
export const personName = (id) => presentName(id) ?? net.names?.[id] ?? replica.nameOf?.(id) ?? id;
/** A presence message names its person by identity too (`key`: targetActor / toActor), so a name someone else wears
 *  never catches it. */
const actorFor = (name, key) => { const a = name ? identities.get(name) : null; return a ? { [key]: a } : {}; };
// a message about someone's body or to them (puppet, bodydrag, typing) goes only to a known identity: without one
// the server routes by name (server/messages.ts presenceTarget)
const hasActor = (name) => !!(name && identities.get(name));
/** Display ids of people here without an account (the server marks them on arrive/present): the 'guest' badge. */
export const guests = new Set();
/** Who is muted here now, by identity → until (the server's mod-state: the muted glyph). */
net.modMuted = {};
export const identityOf = (name) => (name === CONFIG.name ? net.you ?? null : identities.get(name) ?? null);
/** Say something in the world (the authority's `say`). Never silent: a line typed while the connection is down is
 *  queued and sent when the world is back, and a refused say is shown to the person in plain words. */
const sayQueue = [];   // {args, resolve}: says typed while reconnecting, sent in order on the next snapshot
const SAY_QUEUE_MAX = 20;
const excerpt = (t) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return `“${s.length > 40 ? `${s.slice(0, 39)}…` : s}”`; };
function sayRefusalWords(r, text) {
  const x = r?.refused ?? {}; const q = excerpt(text);
  switch (x.code) {
    case 'rate': return `slow down — you've said a lot in the last few seconds, so ${q} wasn't sent. Try again in a moment.`;
    case 'banned': return `${q} wasn't sent: you're banned from this world.`;
    case 'too-big': return `${q} is too long to send — ${x.reason ?? 'split it into shorter messages'}.`;
    case 'timeout': return `the world didn't confirm ${q} — it may still arrive; look before sending it again.`;
    case 'offline': return x.mayHaveLanded ? `the connection dropped before the world confirmed ${q} — it may have landed; look before sending it again.` : `${q} wasn't sent: not connected to the world.`;
    default: return `${q} wasn't sent: ${x.reason ?? x.code ?? 'the world refused it'}${x.fix ? ` (${x.fix})` : ''}.`;
  }
}
function sendSay(args) {
  return sendRequest('say', args).then((r) => { if (!r?.ok) logChat('*', sayRefusalWords(r, args.text)); return r; });
}
/** extra: to (addressed, still public); spoken/utt/t0 (voice-performed: the authority logs the trio, display only);
 *  live (a speech transcript, stt.js): never queued for a reconnect, since it would publish after the mic went off. */
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
/** Ask another body to hold a pose or play an animation. `merge`: pose only the bones sent (a null bone releases
 *  it); without it the pose replaces theirs whole. */
export function sendPuppet(target, { pose = null, merge = false, anim = null, ragdoll = null } = {}) {
  if (net.joined && net.ws?.readyState === 1 && hasActor(target)) {
    net.ws.send(JSON.stringify({ type: 'puppet', target, ...actorFor(target, 'targetActor'), pose, ...(merge ? { merge: true } : {}), anim, ragdoll }));
  }
}

/** Ask the world for a page of its chat history. No socket or no answer within 8 s rejects, so a caller can tell it
 *  from an empty page. */
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

/** The world's flight recorder: why things bounced. Same request shape as history. */
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

/** Erase the current world back to zero (server: owner-only, archived not destroyed). The world's own name is the
 *  confirmation the server demands; the caller has made the person type it. */
export function sendWorldReset() {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'world-reset', name: CONFIG.world }));
  } else logChat('*', 'not connected — try again in a moment');
}

/** Moderation messages that are not world verbs: 'world-bans' (moderators), 'server-ban' / 'server-unban' /
 *  'server-bans' (server operator only). Replies arrive as `mod` messages. */
export function sendMod(type, extra = {}) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type, ...extra }));
  } else logChat('*', 'not connected — try again in a moment');
}

/** A message for the world socket once joined (an open socket not yet joined is the early one, or a rejoin); true when sent. */
export function sendJoined(o) {
  if (!(net.joined && net.ws?.readyState === 1)) return false;
  net.ws.send(JSON.stringify(o)); return true;
}
/** Ask the sequencer to mint this body's media credential. */
export function sendRelayCredRequest(scopes = {}) {
  if (net.joined && net.ws?.readyState === 1) net.ws.send(JSON.stringify({ type: 'relay-cred', ...scopes }));
}
/** Listener-authored receive consent, server-enforced. */
export function sendVoiceConsent(recv) {
  if (net.joined && net.ws?.readyState === 1) net.ws.send(JSON.stringify({ type: 'voice-consent', recv: !!recv }));
}
export function sendTyping(to, state) {
  if (net.joined && net.ws?.readyState === 1 && (!to || hasActor(to))) net.ws.send(JSON.stringify({ type: 'typing', to, ...actorFor(to, 'toActor'), ...(state ? { state } : {}) }));
}

/** Transient, never-logged: a build drag in flight, so others see the object moving before the committed edit. */
export function sendDrag(id, pos, yaw, q = null, { end = false, scale = null } = {}) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'drag', id, pos, yaw, ...(q ? { q } : {}), ...(scale ? { scale } : {}), ...(end ? { end: true } : {}) }));
  }
}

/** A hull's pose from its helm (presence; the authority checks it and relays it: server/messages.ts drive). */
export function sendDrive(id, pos, q) {
  if (net.joined && net.ws?.readyState === 1) net.ws.send(JSON.stringify({ type: 'drive', id, pos, q }));
}

/** This page's presence session: one id for as long as the page lives, sent with every join (index.html's early
 *  socket too), so listeners can tell a reconnect from a new page. */
const PAGE_SESSION = (globalThis.__ewPageSession ??= globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

export function sendJoin() {
  const id = CONFIG.renderer ? `renderer-${CONFIG.name}`
    : CONFIG.spectate ? `retina-${CONFIG.name}` : CONFIG.name;
  // ?renderer asks to be a renderer; only a client with a capture renderer wired is one (the server takes the flag at
  // its word). lite.js claims neither flag: a door key admits it as a spectator, the renderers' credential refuses
  // it (4003). `capture` is read when the join is sent; main.js wires it before start() opens the socket
  // (test/client/renderer-join-test.ts).
  const rendering = CONFIG.renderer && capture !== noRenderer;
  if (CONFIG.renderer && !rendering && !warnedNoRenderer) {
    warnedNoRenderer = true;
    console.warn("[net] ?renderer, but this client has no renderer: it does not join as one. A door key admits it as a spectator; the renderers' credential admits renderers only, so with that it is refused.");
  }
  net.ws.send(JSON.stringify({
    type: 'join', world: CONFIG.world, id,
    avatar: hooks.myAvatarPath(),
    spectate: CONFIG.spectate || CONFIG.renderer,
    renderer: rendering,
    ...(rendering && CONFIG.roam ? { roam: true } : {}),
    token: CONFIG.token,
    ...(CONFIG.account ? { account: CONFIG.account } : {}),
    // this client folds the world's log stream itself (the server refuses a client that doesn't)
    replica: true,
    session: PAGE_SESSION,
    clock: true,   // the server's time just before the snapshot ('clock' below)
    hello: helloOf(),   // the protocol this client reads (docs/decisions/LOG-VOCABULARY.md §F F-3)
  }));
}

// ---- requests: {type: 'request', id, verb, args} → {type: 'reply', id, ok, reply} (server/requestwire.ts) ----
let requestSeq = 0;
const pendingRequests = new Map();   // id → {resolve, timer}
/** One request; resolves with the authority's own reply ({ok, …} or {ok: false, refused: {code, reason, fix}}).
 *  Never rejects: a lost socket or a timeout is a refusal like any other, carrying mayHaveLanded: true when the
 *  request did go out. */
export function sendRequest(verb, args = {}, { timeoutMs = 15000 } = {}) {
  if (!(net.joined && net.ws?.readyState === 1)) return Promise.resolve({ ok: false, refused: { code: 'offline', reason: 'not connected to the world', fix: 'wait for the connection to come back, then try again' } });
  const id = ++requestSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingRequests.delete(id); resolve({ ok: false, refused: { code: 'timeout', reason: `the authority didn't answer '${verb}' in ${timeoutMs / 1000} s`, fix: 'it may still land: look before trying again', mayHaveLanded: true } }); }, timeoutMs);
    pendingRequests.set(id, { resolve, timer, verb, ws: net.ws });   // the socket it went on: only that one's close fails it
    net.ws.send(JSON.stringify({ type: 'request', id, verb, args }));
  });
}
// the socket closed: no reply can come on it, so its in-flight requests are answered now, not by their timers
function failPending(ws = null) {
  for (const [id, p] of pendingRequests) { if (ws && p.ws !== ws) continue; pendingRequests.delete(id); clearTimeout(p.timer);
    p.resolve({ ok: false, refused: { code: 'offline', reason: `the connection dropped before the authority answered '${p.verb}'`, fix: 'it may have landed: look before trying again', mayHaveLanded: true } }); }
}
function onReply(msg) {
  const p = pendingRequests.get(msg.id); if (!p) return;
  pendingRequests.delete(msg.id); clearTimeout(p.timer);
  p.resolve(msg.reply ?? { ok: false, refused: { code: 'no-reply', reason: 'the authority sent no reply body' } });
}
/** The authority's fresh entries: fold them (replica.ingest), then hand state.js the new view (it tells the realizers
 *  what changed). Chat lines take the chat path: they aren't world state. */
function onLog(msg) {
  if (!replica.active) return;
  // each entry's ts was the authority's clock no later than now: a floor that catches a clock step before the next ask
  for (const e of msg.entries ?? []) noteServerFloor(e?.ts);
  const r = replica.ingest(msg.entries ?? [], msg.from ?? -1, msg.names);
  if (r.resync) { console.warn(`[replica] can't continue this client's cut (${r.why}): asking for a fresh snapshot`); rejoin(); return; }
  // a chat line: into the window (shared/chatwindow.js), then the live causes (bubbles, voice, chat log). Numbered
  // seq × 1000, as the server numbers its window and history; the spoken trio rides along for chat to place by t0.
  for (const x of r.says) {
    const e = { seq: x.seq * 1000, ts: x.ts, actor: x.actor, verb: 'say', args: { text: x.text, ...(x.to ? { to: x.to } : {}), ...(x.spoken ? { spoken: true, utt: x.utt, ...(x.t0 !== undefined ? { t0: x.t0 } : {}) } : {}) } };
    hear(shadowState.st, { actor: e.actor, text: x.text, ts: e.ts, seq: e.seq });
    if (hydrating) pendingLive.push(e);
    else if (e.seq > lastSeq) { lastSeq = e.seq; bus.emit('live-entry', e); noteSpeaking(e.actor); }
  }
  if (r.changed) narrate(applyView(replica.view(shadowState.st), { ts: r.ts ?? undefined }), r.actor);
  if (r.changed && !worldSaved) rememberWorld();   // a new world, the moment something is built in it
  bus.emit('log-applied', { from: msg.from, n: msg.entries?.length ?? 0, entries: msg.entries ?? [] });
}
/** Say in chat who changed someone's role here, as the world's own narration (a ban or a kick arrives as `moderated`). */
function narrate(d, actor) {
  const who = actor === 'world' || !actor ? 'the world' : actor; const st = shadowState.st;
  // people by name (the directory's, sent beside the entries), never their u-… id; '*' is everyone
  const person = (id) => (id === '*' ? 'everyone without a role' : actorName(id));
  for (const id of d?.ids?.roles ?? []) {
    const rec = st.roles?.[id];
    if (!rec) { logChat('*', `${who} took away ${person(id)}'s role here`); continue; }
    const bits = [rec.role, rec.gen != null ? (rec.gen ? '+gen' : '-gen') : null].filter(Boolean);
    logChat('*', `${who} made ${person(id)} ${bits.join(' ')}`);
  }
}

let lastPoseSent = 0;
/** Targeted ragdoll-drag traffic (grab / sim stream / release): presence, never logged. The target's client decides. */
export function sendBodyDrag(target, payload) {
  if (net.joined && net.ws?.readyState === 1 && hasActor(target)) {
    net.ws.send(JSON.stringify({ type: 'bodydrag', target, ...actorFor(target, 'targetActor'), ...payload }));
  }
}

// XR: while presenting the wire carries the avatar's actual yaw and the look pitch (xr.js)
let poseOverride = null;
export const setPoseOverride = (fn) => { poseOverride = fn; };
// spec/PHYSICS.md §5.1: each pose sample carries its capture time on the authority's clock (once a round trip has
// measured it) and this sender's own count; the clock is re-measured every CLOCK_MS
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
    ...(s.bodyMode ? { bodyMode: s.bodyMode } : {}),   // the body-mode (shared/bodymode.js)
    ...presenceWire(presence()),        // present / away / busy — for the Who panel
    ...voiceWire(hooks.myVoice()),      // mic live / headphones on — the hover card, agents' look
  };
  const avatar = hooks.me();
  Object.assign(pose, bodyWire({ scale: avatar.userScale, plateY: avatar.plateY }));   // this body's size / plate lift — only when not default
  if (!avatar.onceAnim && !avatar._limp && Number.isFinite(avatar.current?.time)) {
    pose.clipTime = avatar.current.time;
    pose.clipTimeSlot = avatar.currentSlot;
    pose.clipRate = avatar.current.paused ? 0 : avatar.current.timeScale ?? 1;
  }
  if (ov?.xr) pose.xr = ov.xr;   // tracked head/hands, facing-relative (xrbody.js): presence, never the log
  if (s.anim) { pose.anim = s.anim; s.anim = null; } // an anim played once (pose.anim): sent once
  if (s.useHeld) pose.use = s.useHeld;   // what I press while holding a thing (receivers draw its fx); a use that changes the world is a request
  // full-body orientation and locomotion (docs/reference/UNDERWATER-PRESENCE.md): presence only, never authority
  if (s.q) pose.q = s.q;
  if (s.locomotion) pose.locomotion = s.locomotion;
  if (s.climb) pose.climb = s.climb;   // on a climb route: {host, progress} (shared/climb.js), resolved by each receiver through the host
  if (s.pose !== undefined) pose.pose = s.pose;   // a held pose rides presence (so late joiners see it), never the log; null clears
  if (s.pins !== undefined) pose.pins = s.pins;   // bodydrag nails, likewise
  const reach = myReachBag();   // shared/reachwire.js: a relation each receiver re-solves live; absence means let go
  if (reach !== undefined) pose.reach = reach;
  // my seat while I sit (world.js setBodySeat): the socket, the pose I chose from its menu and when, and my input
  // where the socket routes it (socksignals.js); absence means standing
  const seat = avatarMounts.get(CONFIG.name);
  if (seat?.to) pose.seat = { to: seat.to, ...(seat.pose ? { pose: seat.pose, at: seat.at ?? 0 } : {}),
    ...(seat.in && Object.keys(seat.in).length ? { in: Object.fromEntries(Object.entries(seat.in).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) } : {}) };
  if (clockRtt() !== null) pose.t = Math.round(serverNow());
  pose.seq = ++poseSeq;
  net.ws.send(JSON.stringify({ type: 'pose', pose }));
}

// ---------------------------------------------------------------- connecting

/** Send a known pose verbatim. A pose is the whole public body, not a delta, so a client with no body to sample
 *  (lite) sends back the server's settled pose (the snapshot's `restore`) plus its one-shot, rather than one composed
 *  from defaults.
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
let everJoined = false;   // has this page been let in at all (a snapshot arrived)
let worldSaved = false;   // has this join remembered its world yet (rememberWorld)
let browserSaved = false;   // has this PAGE written the browser's last world (once: see rememberWorld)

/** Has anyone made anything here. A join to an unused name founds that world (server.ts admitJoin), so a mistyped
 *  ?world= is let into an empty one; an empty world is not remembered, so a bare link stops leading to a typo. */
export const builtIn = (st) => {
  if (!st) return false;
  for (const _ in st.entities ?? {}) return true;   // one is enough: no key list built over a big world
  return st.terrain != null || st.grass != null || st.sky != null || st.water != null;
};

/** Where a bare link brings this browser next time (base.js pickWorld). Written once something is built here;
 *  watchers and renderers write nothing. The tab's memory refreshes on every join, the browser's once per page, so
 *  an old tab waking from sleep can't take the last world back. */
function rememberWorld() {
  if (worldSaved || CONFIG.spectate || CONFIG.renderer || !builtIn(shadowState.st)) return;
  worldSaved = true;   // decided for this join either way, so live entries stop asking
  if (loggedOutElsewhere()) return;   // the person this page was signed in as has left this browser
  try { sessionStorage.setItem(TAB_WORLD_KEY, CONFIG.world); } catch { /* private mode */ }
  if (browserSaved) return;
  browserSaved = true;
  try { localStorage.setItem(LAST_WORLD_KEY, CONFIG.world); } catch { /* private mode */ }
}

/** This page entered signed in and someone since logged this browser out (ui.js logOut clears ew-authed): a tab
 *  still open must not write that person's world back for the next visitor. */
function loggedOutElsewhere() {
  try { return !!CONFIG.authed && localStorage.getItem('ew-authed') !== '1'; } catch { return false; }
}
/** This browser was signed in and this page is not (/whoami failed, a bounce already spent this minute): a refusal
 *  may then be about who we are, not where, and must not cost the memory of the world. */
function identityMissing() {
  if (CONFIG.authed || CONFIG.token) return false;   // a door key is an identity of its own, never bounced to the login
  try { return localStorage.getItem('ew-authed') === '1'; } catch { return false; }
}

/** Forget a world from both memories (this tab's and the browser's) wherever it is the one held. */
function forgetWorld(name) {
  for (const [s, k] of [[globalThis.localStorage, LAST_WORLD_KEY], [globalThis.sessionStorage, TAB_WORLD_KEY]]) {
    try { if (s?.getItem(k) === name) s.removeItem(k); } catch { /* storage blocked */ }
  }
}

/** A world found empty at the door is forgotten, so bare links stop leading there. The page stays (the person may be
 *  about to build). */
function forgetEmptyWorld() {
  if (CONFIG.spectate || CONFIG.renderer || builtIn(shadowState.st)) return;
  forgetWorld(CONFIG.world);
}

/** A world's door refused us (4010 not open to you, 4006 removed): forget it from whichever memory would bring us
 *  back. If a memory, not the link, brought this page here and we never got in, go where a bare link now leads. */
function forgetRefusedWorld() {
  if (CONFIG.spectate || CONFIG.renderer) return false;   // their refusals are theirs: the memory is a person's
  if (identityMissing()) return false;   // maybe refused for who we are: keep the memory, say the old words
  forgetWorld(CONFIG.world);
  if (!CONFIG.worldRemembered || everJoined) return false;
  toast(`you can't go back into "${CONFIG.world}" — taking you to ${whereNext()}`, 'warn', 8000);
  setTimeout(() => location.reload(), 3000);
  return true;
}
/** Where a reload of this page leads now (after any forgetting), for the words. */
function whereNext() {
  const next = pickWorld(CONFIG.params, ...rememberedWorlds()).world;
  return next === 'commons' ? 'the commons' : `"${next}"`;
}
/** The tail of a refusal toast that leaves the page where it is: where a reload now goes, and how to come back on
 *  purpose. */
function reloadHint(plain) {
  if (!CONFIG.worldRemembered || CONFIG.spectate || CONFIG.renderer || identityMissing()) return plain;
  return `a reload now takes you to ${whereNext()} — ?world=${CONFIG.world} comes back here`;
}

// the server may know us from the ew_sess cookie (/auth after a Discord login); a verified name overrides localStorage's
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
    localStorage.setItem('ew-authed', '1');   // when the session later expires, the way back is the login, not the key door
    if (identity.name && identity.name !== CONFIG.name) {
      CONFIG.name = identity.name;
      localStorage.setItem('ew-name', identity.name);
    }
  }
}

/** A logged-out returning Discord user goes back through the login (silent while Discord still knows them). Key-link
 *  visitors are never bounced; one bounce per minute, so a dead identity node can't redirect-loop. */
function bounceToLogin() {
  if (identity || !authCfg?.login || CONFIG.token) return false;
  if (localStorage.getItem('ew-authed') !== '1') return false;
  const last = Number(sessionStorage.getItem('ew-login-bounce') ?? 0);
  if (Date.now() - last < 60_000) return false;
  sessionStorage.setItem('ew-login-bounce', String(Date.now()));
  location.href = authCfg.login;
  return true;
}

/** Resolve the verified identity before any UI reads CONFIG.name (main.js awaits this ahead of the front door). */
export async function initIdentity() {
  await fetchIdentity();
  return identity;
}

/** The deployment's login URL, if identity is wired up. Only meaningful after initIdentity()/connect(). */
export function loginUrl() {
  return authCfg?.login ?? null;
}

export async function connect() {
  await fetchIdentity();
  // login required and we have neither a session nor a door key: go get one (/auth round-trips back here)
  if (!identity && authCfg?.required && authCfg?.login && !CONFIG.token) {
    location.href = authCfg.login;
    return;
  }
  if (bounceToLogin()) return;
  // The early socket (inline boot script in index.html) may already have sent this exact join while the module graph
  // parsed. Adopt it only when its join is byte-for-byte the one we would send now; otherwise close it and connect
  // fresh.
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
      joinRefusal = null; joinRefused = null;
      // drain what raced ahead in order; the rewire below is synchronous with the final empty check
      while (early.buffered.length) {
        const raw = early.buffered.shift();
        // when the boot script took the message, so a server `t` it carries is sampled then, not after this drain
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
    // the world refused the early join (a 4xxx close): read the server's words out of what the boot script buffered
    // and close as a live socket would. Only for the join this page would send; another join's refusal is discarded.
    if (same && early.closeInfo?.code >= 4000) {
      net.status = 'connecting';
      for (const raw of early.buffered) {
        let msg; try { msg = JSON.parse(raw); } catch { continue; }
        if (msg?.type === 'error') noteRefusal(msg.error, msg.refused);
        if (msg?.type === 'refused') noteRefusal(refusalWords(msg), { code: msg.code });
      }
      onSocketClosed(early.closeInfo);
      return;
    }
    try { early.ws.close(); } catch { /* already dead */ }
  }
  joinRefusal = null; joinRefused = null;
  net.status = 'connecting';
  bus.emit('net', net);
  net.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  net.ws.onopen = () => { sendJoin(); };
  wireSocket(net.ws);
}

/** close/error/message wiring, shared by a fresh connect and an adopted early socket (connect()). */
function wireSocket(ws) {
  ws.onclose = onSocketClosed;

  ws.onerror = () => { /* onclose always follows; nothing useful here */ };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    try { await handle(msg); } catch (e) { report(`net ${msg.type}`, e); }
  };
}

/** What the server said when it refused this join: the `error` before the snapshot is the refusal's own words, and
 *  the close that follows shows them rather than a guess from the code. Reset per connection. */
let joinRefusal = null, joinRefused = null;   // …and its structured reason, where the wire carries one (docs/reference/WIRE.md 4005)
function noteRefusal(text, refused) { if (!net.joined && text) { joinRefusal = String(text); joinRefused = refused && typeof refused === 'object' ? refused : null; } }

/** A refused join, shown on the splash (boot.js refuseBoot), never as a toast under it. */
function showRefusal(text) {
  net.status = 'rejected';
  bus.emit('net', net);
  failSays();
  refuseBoot(text);
  bus.emit('join-refused', { text });
}

/** The socket's close, live or the early socket's (connect()). One place decides what each close code means. */
function onSocketClosed(ev) {
  // a socket already replaced (rejoin dials before the old close lands) answers its own requests and nothing else
  const sock = ev?.target ?? null;
  failPending(sock);
  if (sock && net.ws && sock !== net.ws) { if (sock === intentionalClose) intentionalClose = false; return; }
  clearInterval(clockTimer); clockTimer = null;
  net.joined = false;
  // rejoin() drives its own reconnect, for the socket it replaced only
  if (intentionalClose && (intentionalClose === true || intentionalClose === sock || !sock)) { intentionalClose = false; return; }
  // 4002 = session takeover: this identity re-arrived elsewhere; retrying would kick that session and ping-pong
  if (ev.code === 4002) {
    net.status = 'rejected';
    bus.emit('net', net);
    failSays();
    toast(`"${CONFIG.name}" is connected in another tab. This one has yielded — reload to take over.`, 'warn', 60000);
    return;
  }
  // 4006 = removed by moderation; the server explained itself in an error toast just before. No retry: coming back
  // is a deliberate reload.
  if (ev.code === 4006) {
    net.status = 'rejected';
    bus.emit('net', net);
    failSays();
    if (forgetRefusedWorld()) return;
    toast(`you were removed from this world — ${reloadHint('reload if you believe you may return')}`, 'warn', 60000);
    return;
  }
  // 4010 = this world is not open to you (server/access.ts ACCESS_CLOSE), at the door or because your access just
  // changed. No retry: the door won't open on its own.
  if (ev.code === 4010) {
    if (forgetRefusedWorld()) return;
    showRefusal(joinRefusal ?? `you're not in "${CONFIG.world}" — ${reloadHint('reload if your access changes')}`);
    return;
  }
  // 4011 = nothing to watch here yet (a spectator of a world not founded): retry with backoff
  if (ev.code === 4011) {
    net.status = 'retrying';
    bus.emit('net', net);
    setTimeout(connect, redial.next(REDIAL.full));
    return;
  }
  // 4005 = a refused join (docs/reference/WIRE.md): final, except reason "full", which is transient and retried
  // with backoff. The server's `error` just before the close is shown; without one the close reason picks the words.
  if (ev.code === 4005 && String(ev.reason ?? '') === 'full') {
    const text = `${joinRefusal ?? `"${CONFIG.world}" is full`} — trying again by itself`;
    if (!waitBoot(text)) toast(text, 'warn', 8000);
    net.status = 'retrying';
    bus.emit('net', net);
    setTimeout(connect, redial.next(REDIAL.full));
    return;
  }
  if (ev.code === 4005 && joinRefused?.code === 'old-format') {   // the splash says it, links the doc, and offers the operator the upgrade
    showRefusal(OLD_FORMAT_SPLASH);
    showOldFormat(document.getElementById('splash'), joinRefused, CONFIG.world);
    return;
  }
  if (ev.code === 4005) {
    const why = String(ev.reason ?? '');
    showRefusal(joinRefusal ?? (
      /old-format/i.test(why) ? `"${CONFIG.world}" was saved by an older version of Eidoverse and needs a one-time conversion by whoever runs this server. Nothing is lost.`
      : /world-unavailable/i.test(why) ? `No accessible world named ${CONFIG.world}.`
      : /world name/i.test(why) ? `"${CONFIG.world}" is not a valid world name — check the link that brought you here`
      : `"${CONFIG.world}" refused this visit${why ? ` (${why})` : ''} — reload to try again`));
    return;
  }
  // 4003 = bad or missing door key: no retry, say why.
  if (ev.code === 4003) {
    net.status = 'rejected';
    bus.emit('net', net);
    failSays();
    // entered verified: the session died server-side, so drop the stale identity and go back through the login
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

/** One teardown for a departed participant (leave, kick/ban, the reconnect snapshot's roster prune), so the whole
 *  generation dies together: drag custody first (a drag sim holds bone references into the avatar about to be
 *  disposed), then the body and what hangs off it. `expected` makes the drop generation-conditional (dropRemote). */
export function teardownParticipant(id, expected) {
  if (expected && remotes.get(id) !== expected) return null;   // a predecessor's stale cleanup is a no-op
  bus.emit('participant-teardown', id);   // bodydrag releases custody before the bones vanish
  const dropped = dropRemote(id, expected);
  // the voice peer rides the 'roster' sweep every caller emits right after (voice.js imports net: a cycle)
  return dropped;
}

/** Presence for an id the world never announced (or already dismissed) is dropped, counted, and said a few times. */
let stalePresenceSeen = 0;
export const stalePresenceCount = () => stalePresenceSeen;
/** test seam: the wire minus the socket (test/client/remotes-lifecycle-test.ts drives the dispatch directly) */
export const _dispatch = (msg) => handle(msg);
function noteStalePresence(id) {
  if (stalePresenceSeen++ >= 5) return;
  console.warn(`[net] presence for unannounced id "${id}" dropped (straggler from a departed generation?)`);
}

/** `at`: performance.now() when the boot script took an early-socket message (connect()'s drain); undefined for a
 *  message handled as its event runs. */
async function handle(msg, at) {
  switch (msg.type) {
    case 'snapshot': startClock(); return onSnapshot(msg);

    // two answers share the name: a round trip's ({t0, t}: askClock), and the one-way sample sent just before each
    // snapshot to a join that asks ({t} alone), so the first sound seek isn't on this machine's clock (serverclock.js)
    case 'clock': if (msg.t0 !== undefined) noteRoundTrip(msg.t0, msg.t, localNow()); else noteServerTime(msg.t, at); break;

    case 'your-rights': {
      // effective rights, folded by the authority after every grant: the browser never approximates precedence
      if (msg.rights) {
        net.myRights = msg.rights;
        bus.emit('your-rights', net.myRights);
      }
      break;
    }

    case 'arrive':
      // an arrive is the world saying this person exists (`authority: true`). On a takeover (same id re-arriving) the
      // predecessor retires whole first: the roster sweep can't, since the id stays present.
      if (remotes.has(msg.id)) bus.emit('participant-teardown', msg.id);
      bus.emit('participant-session', { id: msg.id, session: msg.session });
      ensureRemote(msg.id, msg.avatar, { declares: msg.declares ?? null, authority: true });   // declares: PROTOCOL §6a, shown as said, never sorted into kinds
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
      // presence updates bodies, never creates them: the roster or arrive always precedes a body's first sample, so
      // a pose for an unknown id is a straggler (creating here would rebuild the departed as a ghost)
      if (remotes.has(msg.id)) pushPose(msg.id, msg.pose, msg.t);
      else noteStalePresence(msg.id);
      break;
    }

    case 'frame': {
      // batched presence: one message per server tick, latest pose per id; the same update-only law as `pose`
      noteServerTime(msg.t, at);
      for (const [id, pose] of Object.entries(msg.poses)) {
        if (id === net.myId) continue; // our own echo — local prediction owns this body
        if (remotes.has(id)) pushPose(id, pose, msg.t);
        else noteStalePresence(id);
      }
      break;
    }

    case 'drag': {   // transient build feedback, never logged
      bus.emit('drag', msg);
      break;
    }
    case 'drive': { bus.emit('drive', msg); break; }   // a hull's live pose, or my refused step's snap (client/lib/vehicles.js)

    case 'history': case 'debug': {
      const p = pendingHistory.get(msg.reqId);
      if (p) { pendingHistory.delete(msg.reqId); p(msg); }
      break;
    }

    // voice transport. This switch has no default branch: an unrouted type is silently dropped, so every new type
    // needs its case.
    case 'sfu-offer': bus.emit('sfu-offer', msg); break;
    case 'sfu-ice':   bus.emit('sfu-ice', msg);   break;
    case 'sfu-route': bus.emit('sfu-route', msg); break;
    case 'relay-cred':          // the minted media credential (voicesfubridge.js)
      window.__voiceRelayAbsent = false;   // a relay answered: an earlier "no relay" (a server restarted without voice) is over
      bus.emit('relay-cred', msg);
      break;
    case 'voice-consent':       // server's ack of a receive-consent change
      bus.emit('voice-consent-ack', msg);
      break;
    case 'voice-service':       // relay service state, incarnation-stamped
      bus.emit('voice-service', { state: msg.state, incarnation: msg.incarnation });
      break;
    // presence messages (never logged):
    // performed — an authenticated voice leg attested it aired this say;
    // surface-transition — an aux leg joined or took over (capability signal).
    case 'performed':
      bus.emit('performed', { actor: msg.id, seq: msg.seq, gen: msg.gen });
      break;
    case 'surface-transition':
      bus.emit('surface-transition', { actor: msg.id, surface: msg.surface, gen: msg.gen, retired: msg.retired });
      break;

    case 'caption':   // live speech pacing (presence): the bubble speaks in real time, the log gets one say at the end
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
      // someone wants to pose me: an input to my own body (localbody.js applyPuppet), not a pose asserted onto it
      bus.emit('puppet', msg);
      break;

    case 'bodydrag':   // someone is dragging my body: an input my client applies to itself, or refuses, as puppet
      bus.emit('bodydrag', msg);
      break;

    case 'holds':
      // who holds what (the authority's presence plane): thingphysics.js draws each held thing in its holder's hand
      bus.emit('holds', msg.holds ?? {});
      break;

    case 'geom':   // the placeholder tier's bbox side-channel, a beat after the snapshot; the models realizer listens
      bus.emit('lib-geom', msg.geom ?? {});
      break;

    case 'body-inbox':
      // the authority's body inbox (PROTOCOL §5): acts delivered (localbody.js applies them), revocations, a seat let go.
      bus.emit('body-inbox', msg);
      break;
    case 'log': onLog(msg); break;
    case 'reply': onReply(msg); break;

    case 'renderer-travel':   // a roaming renderer is wanted elsewhere (server/screenshots.ts): only a roaming renderer obeys
      if (CONFIG.renderer && CONFIG.roam && isWorldName(msg.world) && msg.world !== CONFIG.world) {
        CONFIG.world = msg.world; rejoin();
      }
      return;

    case 'capture':   // net_capture.js, wired by main.js; a client without a renderer answers with an error
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

    case 'avatar-profile-updated': {   // a seat profile was proposed or countersigned (occupants.js)
      bus.emit('avatar-profile-updated', msg);
      break;
    }

    case 'defs-updated': {   // a def changed on disk; world.js re-fetches the registry
      bus.emit('defs-updated', msg);
      break;
    }

    case 'world-forked': {
      // the link ends the line: naive linkifiers swallow closing punctuation into the URL
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

    case 'world-reset': {   // the world we stand in is now empty: a reload is the one rebuild that cannot disagree
      toast(`${msg.by} reset "${msg.world}" to zero — reloading…`, 'warn', 4000);
      logChat('*', `${msg.by} reset this world to zero`);
      shadowReset();
      setTimeout(() => location.reload(), 1800);
      break;
    }

    case 'mod':   // moderation replies (ban lists, confirmations) go to chat, where the command was typed
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
    case 'warned':   // a moderator's warning: a notice you dismiss, and a line in chat to keep
      logChat('*', `${moderatorHeader(CONFIG.world)} — ${msg.by} warned you: ${String(msg.reason ?? '')}`, '', { links: false });   // their text is never a link
      bus.emit('warned', msg);
      break;
    case 'mod-state':
      net.modMuted = msg.muted && typeof msg.muted === 'object' ? msg.muted : {};
      bus.emit('roster');
      break;

    case 'notice':
      // the world telling you something that is not a refusal (your access ends soon): toast and chat. Not an
      // `error`, which would also read as a refused verb.
      toast(String(msg.text ?? ''), 'warn', 20000);
      logChat('*', String(msg.text ?? ''));
      break;

    case 'refused':
      // the hello refused (update-required, unsupported-feature): the join's answer, in words; its close shows them
      noteRefusal(refusalWords(msg), { code: msg.code });
      toast(refusalWords(msg), 'warn');
      break;

    case 'error':
      // "no voice relay" is said only when we try to use one: remembered so the mic glyph can say why it stays off
      if (/no voice relay/i.test(String(msg.error ?? ''))) window.__voiceRelayAbsent = true;
      noteRefusal(msg.error, msg.refused);   // before the snapshot, an error is the join's refusal: its close shows these words
      toast(msg.error, 'warn');
      bus.emit('verb-refused', { error: String(msg.error ?? '') });   // the wire names no verb: every refusal on this socket is ours
      break;
  }
}

async function onSnapshot(msg) {
  // no fold, no join: refused before any joined state is published (the voice bridge arms on it)
  if (!msg.state) {
    replica.reset(); report('snapshot', new Error('the server sent no world snapshot (an old server?)'));
    // an older server: say so, fail the queued says, hang up without a redial
    net.joined = false; net.status = 'rejected'; bus.emit('net', net); failSays();
    toast('this server is older than the page: nothing will load — reload once it is updated', 'warn', 60000);
    intentionalClose = net.ws ?? true; try { net.ws?.close(4000); } catch { /* already gone */ }
    return;
  }
  // what the server says you may do here; live grants keep it fresh via world.js
  net.myRights = msg.yourRights ?? { role: 'builder', gen: true };
  // the body roster rides the snapshot: the avatar panel reads it with no /avatars round-trip (absent on older servers)
  if (msg.avatars) { net.avatars = msg.avatars; bus.emit('avatars', msg.avatars); }
  bus.emit('your-rights', net.myRights);
  markPhase('connect', 1);
  net.joined = true;
  redial.reset();
  everJoined = true;
  worldSaved = false;   // every join remembers afresh (after the shadow adopts the snapshot, below)
  net.status = 'live';
  net.myId = msg.you;
  net.mySub = msg.yourSub ?? null;
  net.renameAfter = msg.renameAfter ?? null; net.renameCooldownDays = msg.renameCooldownDays ?? null;   // profile.js's name dialog
  if (msg.renameRefused) { const d = new Date(msg.renameRefused.until);
    toast(`still “${msg.you}”: names change once every ${msg.renameCooldownDays} days — “${msg.renameRefused.tried}” can be yours from ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`, 'info', 12000); }   // the durable subject the authority vouched for, if any — what guarded things match on
  // the server's `you` is authoritative (a verified identity, or a suffixed name when two people share a nick):
  // adopt it and say so. Renderer/spectator clients strip their transport prefix (base.js nameFromJoinAck).
  const you = nameFromJoinAck(msg.you, { renderer: CONFIG.renderer, spectate: CONFIG.spectate, verified: !!msg.yourSub });
  if (you && you !== CONFIG.name && !msg.renameRefused) {
    CONFIG.name = you;
    localStorage.setItem('ew-name', you);
    toast(`you're appearing as “${msg.you}”`, 'info', 8000);
  } else if (msg.renameRefused) { CONFIG.name = msg.you; localStorage.setItem('ew-name', msg.you);
    try { const u = new URL(location.href); if (u.searchParams.has('name')) { u.searchParams.set('name', msg.you); history.replaceState(null, '', u); } } catch { /* fine */ } }
  // a re-join: what was said after the old socket's last entry may be trimmed out of this snapshot's chat window,
  // so fetch it before lastSeq moves on (a first join is a no-op). lastSeq is in the chat's numbering (seq × 1000).
  if (lastSeq >= 0) void resyncChatAfter(lastSeq);
  if (typeof msg.throughSeq === 'number' && msg.throughSeq > lastSeq) lastSeq = msg.throughSeq;
  bus.emit('net', net);
  bus.emit('participant-sessions', msg.present ?? []);
  // who has which aux legs live now (surface-transition keeps it current after this)
  bus.emit('surfaces', [...(msg.present ?? []),
    ...(msg.yourSurfaces?.length ? [{ id: msg.you, surfaces: msg.yourSurfaces }] : [])]);

  if (msg.recording && !onSnapshot._noted) {
    onSnapshot._noted = true;
    logChat('*', '⏺ this performance is being recorded (movement + chat, for the archive)');
  }

  // wake where you fell asleep, but never teleport a body that has already moved this session (a renderer-free
  // client has no body: `!s` passes)
  const s = hooks.myState;
  if (msg.restore && !restoredPose && (!s || s.speed === 0)) {
    restoredPose = true;
    hooks.onRestore(msg.restore);
  }
  restoredPose = true; // first snapshot decides, restore or not

  // the snapshot's roster is authoritative: tear down anyone no longer present, through the funnel a leave uses
  const present = new Set(msg.present.map((p) => p.id));
  for (const id of [...remotes.keys()]) if (!present.has(id)) teardownParticipant(id);

  // remote avatars build in parallel and never block log replay; a same-id record here is a fresh generation
  identities.clear(); guests.clear(); if (msg.actor) net.you = msg.actor;
  for (const p of msg.present) {
    if (p.actorId) identities.set(p.id, p.actorId);
    if (p.guest) guests.add(p.id);
    ensureRemote(p.id, p.avatar, { declares: p.declares ?? null, authority: true })
      .then(() => { if (p.pose) pushPose(p.id, p.pose); })
      .catch((e) => report(`present ${p.id}`, e));
  }

  // the replica adopts the snapshot first, synchronously (the snapshot's `chat` is the chat window, not world state).
  // A {dialect, v} this page doesn't read is refused whole (docs/decisions/LOG-VOCABULARY.md D5).
  if (!replica.adopt(msg)) {
    report('snapshot', new Error(`unknown-version: the world speaks ${msg.dialect} v${msg.v}; this page reads another`));
    net.joined = false; net.status = 'rejected'; bus.emit('net', net); failSays();
    toast(`this world's log is a version this page doesn't read (${msg.dialect} v${msg.v}): nothing will load — reload once the page is updated`, 'warn', 60000);
    return;
  }
  bus.emit('my-acts', msg.mine ?? []); bus.emit('snapshot-adopted'); bus.emit('holds', msg.holds ?? {});
  shadowHydrate(replica.view(msg.chat), typeof msg.throughSeq === 'number' ? msg.throughSeq : -1);
  rememberWorld();   // the door said yes, and the shadow now holds what is here
  forgetEmptyWorld();   // …or holds nothing, and a bare link should stop leading here

  hydrating = true; pendingLive = [];
  // chat lines that raced us land below the arrival chat window, in order
  const backlog = pendingLive.filter((e) => (e.seq ?? -1) > lastSeq).sort((a, b) => a.seq - b.seq);
  pendingLive = []; hydrating = false;
  for (const e of backlog) {
    lastSeq = e.seq;
    bus.emit('live-entry', e);
  }

  const rc = msg.chat?.recentChat ?? [];
  noteHistoryContext({
    total: msg.chat?.chatTotal ?? null,
    shown: rc.length,   // what was rendered: the "showing N of M" hint tells a reader to page for the rest
    spanMs: rc.length > 1 ? rc[rc.length - 1].ts - rc[0].ts : null,
  });

  // the progress bar's 'world' segment tracks the scheduler's outstanding entity loads; the curtain does not wait on it
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
