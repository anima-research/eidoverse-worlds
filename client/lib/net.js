// net — the wire. One socket carrying two planes: the world log (ordered,
// persisted, replayed on join) and presence (batched, lossy, never persisted).

import { THREE, CONFIG, camera, scene, renderer, report, bus } from './core.js';
import { forgetBytes } from './assets.js';
// The world as data (TEL0S_NOTES §11.2): every snapshot and live entry
// folds here — synchronously, through the same shared/fold.js the
// sequencer runs — and the realizers project it into the scene.
// EW.foldParity() measures fold-vs-scene drift on demand.
import { hydrate as shadowHydrate, foldLive as shadowFold, reset as shadowReset } from './state.js';
import { pending, P } from './scheduler.js';
// The realizers (TEL0S_NOTES §11.4) own the scene: state verbs realize
// FROM the fold, and fold-inert causes (use/punt/force, moderation
// narration, live say) dispatch over the bus as 'live-entry' (causes.js
// listens — emitted rather than imported so this file adds no lap around
// the net → chat → net cycle). One writer per verb, always.
import { remotes, ensureRemote, dropRemote, pushPose, noteServerTime, noteSpeaking } from './remotes.js';
import { myReachBag } from './reachnet.js';
import { logChat, logWhisper, noteTyping, noteHistoryContext } from './chat.js';
import { composeFirstPerson } from './fp_view.js';
import { markPhase } from './boot.js';
import { toast } from './ui.js';

export const net = {
  ws: null,
  joined: false,
  myId: null,
  status: 'connecting',   // connecting | live | retrying | rejected
  latency: null,
};

let restoredPose = false;
let hydrating = false;
let pendingLive = [];
let lastSeq = -1;
let retryDelay = 1200;
const verbQueue = [];   // verbs issued while disconnected — flushed on rejoin

// Supplied by main.js so net can read/write body state without importing the
// controller (which imports ui, which imports assets…).
let hooks = {
  myAvatarPath: () => '',
  myState: null,
  me: () => null,
  onRestore: () => {},
  onSnapshotDone: () => {},
};
export function wireNet(h) { hooks = { ...hooks, ...h }; }

// ---------------------------------------------------------------- sending

export function sendVerb(verb, args) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'verb', verb, args }));
  } else {
    verbQueue.push({ verb, args });
    logChat('*', `queued ${verb} — reconnecting…`);
  }
}

/** A one-off animation — sent once, relayed to everyone, never logged. */
export function sendAnim(data) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'anim', ...data }));
  }
}
/** Ask another body to hold a pose or play an animation. */
export function sendPuppet(target, { pose = null, anim = null, ragdoll = null } = {}) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'puppet', target, pose, anim, ragdoll }));
  }
}

/** Ask the world for a page of its own history.
 *
 *  Folding bounds what a join costs, which necessarily means a joiner is not
 *  handed everything ever said. This is how the rest is reachable: scroll up
 *  and the client asks for what came before. */
const pendingHistory = new Map();
let histId = 0;
export function requestHistory(opts = {}) {
  if (!net.joined || net.ws?.readyState !== 1) return Promise.resolve({ entries: [], hasMore: false });
  const reqId = `h${++histId}`;
  return new Promise((resolve) => {
    const t = setTimeout(() => { pendingHistory.delete(reqId); resolve({ entries: [], hasMore: false }); }, 8000);
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

/** Private, point-to-point. Deliberately not a verb: verbs go in the world
 *  log, and the log is public forever. */
export function sendWhisper(to, text) {
  if (net.joined && net.ws?.readyState === 1) net.ws.send(JSON.stringify({ type: 'whisper', to, text }));
}
export function sendRtc(to, payload) {
  if (net.joined && net.ws?.readyState === 1) net.ws.send(JSON.stringify({ type: 'rtc', to, payload }));
}
export function sendTyping(to, state) {
  if (net.joined && net.ws?.readyState === 1) net.ws.send(JSON.stringify({ type: 'typing', to, ...(state ? { state } : {}) }));
}

/** Transient, never-logged relay — used while a build drag is in flight so
 *  other people see the object moving before the single committed `place`. */
export function sendDrag(id, pos, yaw) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'drag', id, pos, yaw }));
  }
}

export function sendJoin() {
  const id = CONFIG.renderer ? `renderer-${CONFIG.name}`
    : CONFIG.spectate ? `retina-${CONFIG.name}` : CONFIG.name;
  net.ws.send(JSON.stringify({
    type: 'join', world: CONFIG.world, id,
    avatar: hooks.myAvatarPath(),
    spectate: CONFIG.spectate || CONFIG.renderer,
    renderer: CONFIG.renderer,
    token: CONFIG.token,
  }));
}

let lastPoseSent = 0;
/** Targeted ragdoll-drag traffic (grab / sim stream / release). Presence
 *  semantics: fire-and-forget, never logged. The target's client decides. */
export function sendBodyDrag(target, payload) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'bodydrag', target, ...payload }));
  }
}

/** Entity animation leases (docs/leases.md): claim / state / release. The
 *  server arbitrates and answers on the same channel (bus 'lease'). */
export function sendLease(op, id, payload = {}) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'lease', op, id, ...payload }));
  }
}

export function sendPose(now) {
  const s = hooks.myState;
  if (!net.joined || !hooks.me() || !s || now - lastPoseSent < 66) return;
  lastPoseSent = now;
  const pose = {
    p: [s.pos.x, s.pos.y, s.pos.z],
    yaw: s.yaw, speed: s.speed, clip: s.clip,
    pitch: Math.round((s.pitch ?? 0) * 100) / 100,
  };
  if (s.emote) { pose.emote = s.emote; s.emote = null; } // one-shot: send once
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
  net.ws.send(JSON.stringify({ type: 'pose', pose }));
}

// ---------------------------------------------------------------- connecting

/** Re-enter the world as somebody else.
 *
 *  The server keys a client by its id, so a rename is genuinely a new
 *  identity: this session leaves and a new one arrives. That is honest —
 *  everyone present sees it happen, rather than a name silently mutating on a
 *  body they were talking to. What does NOT follow you is anything the world
 *  filed under the old name: your remembered sleeping place, and any whisper
 *  held for you while you were away. */
export function rejoin() {
  intentionalClose = true;
  try { net.ws?.close(); } catch { /* already gone */ }
  net.joined = false;
  connect();
}

let intentionalClose = false;

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
 *  the cap: if the identity node is down we fall through to the door (which
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

/** The deployment's login URL, if identity is wired up — the door offers it as
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
  // rediscover the door.
  if (bounceToLogin()) return;
  // The early socket (inline boot script in index.html): the HTML may have
  // already opened the WS and sent this exact join while the module graph
  // was still parsing — the snapshot downloaded DURING parse instead of
  // after it. Adopt it only when the join it sent is byte-for-byte the one
  // we would send now; on ANY mismatch (rename at the door, avatar switch,
  // a login flow) close it and connect fresh. The early socket is an
  // optimization, never an authority.
  const early = globalThis.__ewEarlySocket;
  globalThis.__ewEarlySocket = null;
  if (early) {
    const wantJoin = JSON.stringify({ world: CONFIG.world, id: CONFIG.name,
      avatar: hooks.myAvatarPath(), token: CONFIG.token });
    if (!early.failed && early.ws.readyState <= 1 && JSON.stringify(early.sent) === wantJoin) {
      net.status = 'connecting';
      bus.emit('net', net);
      net.ws = early.ws;
      retryDelay = 1200;
      // Drain what raced ahead of us IN ORDER while the boot script's own
      // buffering handler still catches anything arriving mid-drain; the
      // rewire below is synchronous with the final empty check, so no
      // message can slip between the two.
      while (early.buffered.length) {
        const raw = early.buffered.shift();
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        try { await handle(msg); } catch (e) { report(`net ${msg.type}`, e); }
      }
      wireSocket(net.ws);   // live delivery takes over (onopen stays the boot script's)
      return;
    }
    try { early.ws.close(); } catch { /* already dead */ }
  }
  net.status = 'connecting';
  bus.emit('net', net);
  net.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  net.ws.onopen = () => { retryDelay = 1200; sendJoin(); };
  wireSocket(net.ws);
}

/** close/error/message wiring, shared by a fresh connect and an adopted
 *  early socket (the inline boot script in index.html — see connect()). */
function wireSocket(ws) {
  ws.onclose = (ev) => {
    net.joined = false;
    if (intentionalClose) { intentionalClose = false; return; } // rejoin() drives its own reconnect
    // 4002 = session takeover: this identity re-arrived elsewhere. Retrying
    // would kick THAT session and ping-pong forever.
    if (ev.code === 4002) {
      net.status = 'rejected';
      bus.emit('net', net);
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
      toast('you were removed from this world — reload if you believe you may return', 'warn', 60000);
      return;
    }
    // 4005 = the world name itself is malformed (a mangled link). No retry —
    // the name can never exist, so reconnecting is just hammering the door.
    if (ev.code === 4005) {
      net.status = 'rejected';
      bus.emit('net', net);
      toast(`"${CONFIG.world}" is not a valid world name — check the link that brought you here`, 'warn', 60000);
      return;
    }
    // 4003 = bad or missing door key. This used to fall through to the generic
    // retry, so a wrong key hammered the door forever while the client said
    // "disconnected — retrying…" and never explained why.
    if (ev.code === 4003) {
      net.status = 'rejected';
      bus.emit('net', net);
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
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(15000, retryDelay * 1.6); // back off instead of hammering
  };

  ws.onerror = () => { /* onclose always follows; nothing useful here */ };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    try { await handle(msg); } catch (e) { report(`net ${msg.type}`, e); }
  };
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
 *  line names the table it clears. Logged body-mounts are deliberately NOT
 *  touched: avatarMounts mirrors folded world state, and the seat renders
 *  through the remote, which is now gone.
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

async function handle(msg) {
  switch (msg.type) {
    case 'snapshot': return onSnapshot(msg);

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
      ensureRemote(msg.id, msg.avatar, { agent: msg.agent, authority: true });
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
      noteServerTime(msg.t);
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

    case 'rtc':
      bus.emit('rtc', msg);
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

    case 'whisper':
      logWhisper(msg);
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

    case 'lease':
      // entity animation traffic: grants/denials for MY claims, and other
      // holders' streamed transforms for everyone to render
      bus.emit('lease', msg);
      break;

    case 'geom':
      // the placeholder tier's bbox side-channel — arrives a beat after the
      // snapshot (async summaries; the join send stays synchronous). Bus,
      // not import: the models realizer listens (net must not import it).
      bus.emit('lib-geom', msg.geom ?? {});
      break;

    case 'log':
      // shadow fold first, synchronously — seq-guarded, so the backlog
      // flush after hydration can never double-fold what landed here. When
      // the realizers are active this IS the delivery: the fold event
      // drives state realization, and 'live-entry' carries the causes.
      shadowFold(msg.entry);
      if (hydrating) pendingLive.push(msg.entry);
      else if ((msg.entry.seq ?? -1) > lastSeq) {
        lastSeq = msg.entry.seq;
        bus.emit('live-entry', msg.entry);
        if (msg.entry.verb === 'say') noteSpeaking(msg.entry.actor);
      }
      break;

    case 'snap': return onSnapRequest(msg);

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
      // a seat profile was proposed or countersigned (#101) — seats.js holds
      // the cache and the generation guard; this is just the wire → bus hop
      bus.emit('avatar-profile-updated', msg);
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

    case 'error':
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
  net.status = 'live';
  net.myId = msg.you;
  // The server's `you` is authoritative (verified identity, or a suffixed name
  // when two people share a nick). If it differs from what this client thinks,
  // adopt it — and say so, a silently different nameplate is confusing.
  if (msg.you && msg.you !== CONFIG.name) {
    CONFIG.name = msg.you;
    localStorage.setItem('ew-name', msg.you);
    toast(`you're appearing as “${msg.you}”`, 'info', 8000);
  }
  if (typeof msg.throughSeq === 'number' && msg.throughSeq > lastSeq) lastSeq = msg.throughSeq;
  bus.emit('net', net);
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
  if (msg.restore && !restoredPose && s && s.speed === 0) {
    restoredPose = true;
    hooks.onRestore(msg.restore);
  }
  restoredPose = true; // first snapshot decides, restore or not

  while (verbQueue.length) {
    const { verb, args } = verbQueue.shift();
    net.ws.send(JSON.stringify({ type: 'verb', verb, args }));
  }

  // reconcile: the snapshot is authoritative — tear down any participant no
  // longer present, through the SAME funnel a leave uses (custody, then
  // body; the voice peer rides the roster emit below). Stale ghosts
  // otherwise survive reconnects forever — and before #95 they survived
  // with their side tables intact.
  const present = new Set(msg.present.map((p) => p.id));
  for (const id of [...remotes.keys()]) if (!present.has(id)) teardownParticipant(id);

  // remote avatars build in parallel and never block log replay — the
  // roster is an AUTHORITY: a same-id record here is a fresh generation
  for (const p of msg.present) {
    ensureRemote(p.id, p.avatar, { agent: p.agent, authority: true })
      .then(() => { if (p.pose) pushPose(p.id, p.pose); })
      .catch((e) => report(`present ${p.id}`, e));
  }

  // Shadow state adopts the snapshot FIRST, synchronously — before the
  // legacy replay's first await can let a live entry interleave. Today's
  // server sends live-folded state (it already contains the tail's effects;
  // the tail rides along for the chat overlap), so the shadow folds nothing
  // twice: it marks the highest covered seq and lets foldLive take over.
  shadowHydrate(msg.state, [], Math.max(
    typeof msg.throughSeq === 'number' ? msg.throughSeq : -1,
    ...(msg.entries?.length ? msg.entries.map((e) => e.seq ?? -1) : [-1]),
  ));

  // Warm the bytes for every still-live spawn in parallel BEFORE the ordered
  // replay — join time becomes the slowest asset, not the sum of all of them.
  hydrating = true; pendingLive = [];
  // Every tail seq counts as delivered whether or not legacy replays it —
  // the realizer's entries are filtered out below, and an under-advanced
  // lastSeq would let the backlog re-apply what state already holds.
  for (const e of msg.entries) if ((e.seq ?? -1) > lastSeq) lastSeq = e.seq;
  // flush the events that raced us, in order, once. Their folds already
  // landed at arrival (seq-guarded); under the realizers this delivers
  // their live causes, after the hydration window so a raced say lands
  // below the arrival chat window, not above it.
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
}

const _snapHead = new THREE.Vector3();
const _snapBox = new THREE.Box3();
async function onSnapRequest(msg) {
  // The world asked us for a view of/from the target. Three framings:
  //   first  — the target's own eyes: the eye anchors on their LIVE head bone
  //            (mesh bounds when the rig has none) and their own body is
  //            hidden for the frame, the same exclusion the local
  //            first-person applies to `me` (#75). The root carries the
  //            socket transform while mounted, so the eye rides the seat.
  //   third  — chase cam over the shoulder: their body AND what it faces.
  //   selfie — from in front, facing them: the avatar itself is the subject.
  try {
    const r = remotes.get(msg.follow);
    if (!r?.avatar) throw new Error(`${msg.follow} not in local scene (still loading?)`);
    const root = r.avatar.root;
    const fwd = new THREE.Vector3(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
    let dataUrl;
    const shoot = () => {
      renderer.render(scene, camera);   // completed frame, then read it
      const url = renderer.domElement.toDataURL('image/png');
      if (url.length < 2000) throw new Error('empty frame readback');
      return url;
    };
    if (msg.view === 'third') {
      const eye = root.position.clone().add(new THREE.Vector3(0, 2.1, 0)).addScaledVector(fwd, -3.4);
      camera.position.copy(eye);
      camera.lookAt(root.position.clone().add(new THREE.Vector3(0, 1.2, 0)).addScaledVector(fwd, 4));
      dataUrl = shoot();
    } else if (msg.view === 'selfie') {
      const eye = root.position.clone().add(new THREE.Vector3(0, 1.6, 0)).addScaledVector(fwd, 2.6);
      camera.position.copy(eye);
      camera.lookAt(root.position.clone().add(new THREE.Vector3(0, 1.25, 0)));
      dataUrl = shoot();
    } else {
      const head = r.avatar.headWorldPosition(_snapHead);
      const box = head ? null : r.avatar.visualBounds(_snapBox);
      dataUrl = composeFirstPerson({
        camera,
        yaw: root.rotation.y,
        head: head ? [head.x, head.y, head.z] : null,
        bounds: box ? { min: box.min.toArray(), max: box.max.toArray() } : null,
        name: msg.follow,
        setOwnVisible: (v) => { root.visible = v; },
        render: shoot,
      });
    }
    net.ws.send(JSON.stringify({ type: 'snap-result', id: msg.id, dataUrl }));
  } catch (e) {
    net.ws.send(JSON.stringify({ type: 'snap-result', id: msg.id, error: e.message }));
  }
}
