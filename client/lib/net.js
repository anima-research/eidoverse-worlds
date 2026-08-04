// net — the wire. One socket carrying two planes: the world log (ordered,
// persisted, replayed on join) and presence (batched, lossy, never persisted).

import { THREE, CONFIG, camera, scene, renderer, report, bus, parallelMap } from './core.js';
import { fetchBytes, forgetBytes } from './assets.js';
import { applyEntry, stateToEntries } from './world.js';
import { remotes, ensureRemote, dropRemote, pushPose, noteServerTime, noteSpeaking } from './remotes.js';
import { logChat, logWhisper, noteTyping, noteHistoryContext } from './chat.js';
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
    bus.emit('verb:sent', { verb, args });   // the edit surface's echo line listens
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
  net.status = 'connecting';
  bus.emit('net', net);
  net.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

  net.ws.onopen = () => { retryDelay = 1200; sendJoin(); };

  net.ws.onclose = (ev) => {
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

  net.ws.onerror = () => { /* onclose always follows; nothing useful here */ };

  net.ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    try { await handle(msg); } catch (e) { report(`net ${msg.type}`, e); }
  };
}

// ---------------------------------------------------------------- handling

async function handle(msg) {
  switch (msg.type) {
    case 'snapshot': return onSnapshot(msg);

    case 'arrive':
      ensureRemote(msg.id, msg.avatar, { agent: msg.agent });
      logChat('*', `${msg.id} arrived`);
      bus.emit('roster');
      break;

    case 'leave':
      dropRemote(msg.id);
      logChat('*', `${msg.id} left`);
      bus.emit('roster');
      break;

    case 'pose': {
      if (!remotes.has(msg.id)) await ensureRemote(msg.id, null);
      pushPose(msg.id, msg.pose, msg.t);
      break;
    }

    case 'frame': {
      // Batched embodied plane: one message per server tick, latest pose per id.
      // Never awaits — a frame must not stall the queue behind an avatar
      // download; unknown bodies start loading and pick up later frames.
      noteServerTime(msg.t);
      for (const [id, pose] of Object.entries(msg.poses)) {
        if (id === net.myId) continue; // our own echo — local prediction owns this body
        if (remotes.has(id)) pushPose(id, pose, msg.t);
        else ensureRemote(id, null).then(() => pushPose(id, pose, msg.t)).catch(() => {});
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

    case 'whisper':
      logWhisper(msg);
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

    case 'log':
      if (hydrating) pendingLive.push(msg.entry);
      else if ((msg.entry.seq ?? -1) > lastSeq) {
        lastSeq = msg.entry.seq;
        await applyEntry(msg.entry, true);
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
      break;
  }
}

/** Verbs whose completion must never gate arrival. Anything reaching the sky
 *  belongs here — see the deadlock note in the replay loop. */
const NON_GATING = new Set(['spawn', 'sky', 'weather']);

async function onSnapshot(msg) {
  // what the server says you may do here; live grants keep it fresh via world.js
  net.myRights = msg.yourRights ?? { role: 'builder', gen: true };
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
    bus.emit('verb:sent', { verb, args });   // the edit surface's echo line listens
  }

  // reconcile: the snapshot is authoritative — dispose any remote no longer
  // present (stale ghosts otherwise survive reconnects forever)
  const present = new Set(msg.present.map((p) => p.id));
  for (const id of [...remotes.keys()]) if (!present.has(id)) dropRemote(id);

  // remote avatars build in parallel and never block log replay
  for (const p of msg.present) {
    ensureRemote(p.id, p.avatar, { agent: p.agent })
      .then(() => { if (p.pose) pushPose(p.id, p.pose); })
      .catch((e) => report(`present ${p.id}`, e));
  }

  // Warm the bytes for every still-live spawn in parallel BEFORE the ordered
  // replay — join time becomes the slowest asset, not the sum of all of them.
  hydrating = true; pendingLive = [];
  // A joiner is told the world as it IS (folded state) plus only what has
  // happened since. Both halves go through the same applyEntry.
  const oldestTailSeq = msg.entries.length
    ? Math.min(...msg.entries.map((e) => e.seq ?? Infinity))
    : Infinity;
  const folded = stateToEntries(msg.state, { skipChatFromSeq: oldestTailSeq });
  const replay = [...folded, ...msg.entries];
  const removed = new Set(replay.filter((e) => e.verb === 'remove').map((e) => e.args?.id));
  const libs = new Set(replay
    .filter((e) => e.verb === 'spawn' && e.args?.lib && !removed.has(e.args.id))
    .map((e) => e.args.lib));
  bus.emit('hydrating', { total: replay.length, libs: libs.size, folded: folded.length });
  // Warm the bytes, but do NOT wait for them. Blocking arrival on every model
  // in the world made a cold join cost the sum of its heaviest assets — 12s of
  // a 13s boot, spent staring at a splash while a crate downloaded. Objects
  // materialising around you over the next few seconds is what this world does
  // anyway; the log's ORDER is what has to be respected, not its bytes.
  parallelMap([...libs], (lib) => fetchBytes(`/library/${lib}`).catch(() => {}), 6);

  // Replay stays strictly ordered, but these verbs do not BLOCK the entries
  // behind them — world.js queues any place/remove that lands on a body still
  // in flight and applies it when the body arrives.
  //
  // `weather` belongs here for a sharper reason than cost. It routes into the
  // same sky build as `sky`, which waits for boot to finish so it stops
  // competing for bandwidth — and boot waits for replay. Awaiting a weather
  // verb therefore DEADLOCKED the join until the 45s boot ceiling broke it.
  // Anything that can reach the sky must not gate replay.
  const settling = [];
  for (let i = 0; i < replay.length; i++) {
    const entry = replay[i];
    // synthetic pre-history entries carry negative seq and must not advance it
    if ((entry.seq ?? -1) >= 0) lastSeq = Math.max(lastSeq, entry.seq);
    const p = applyEntry(entry, false);
    // Spawns and the sky do not gate arrival. The sky verb pulls ~7.5MB of
    // atmosphere and particle textures and then bakes an environment map —
    // that was most of a cold boot, spent so the world could look finished the
    // instant it appeared. Terrain still blocks (you need ground to stand on);
    // the sky resolves over your head a moment later.
    if (NON_GATING.has(entry.verb)) settling.push(p); else await p;
    if (replay.length > 4) markPhase('world', 0.5 + 0.49 * ((i + 1) / replay.length));
  }
  // Let the tray, not the splash, carry the tail of the asset stream.
  Promise.all(settling).then(() => bus.emit('entities-settled'));
  // flush the events that raced us, in order, once
  const backlog = pendingLive.filter((e) => (e.seq ?? -1) > lastSeq).sort((a, b) => a.seq - b.seq);
  pendingLive = []; hydrating = false;
  for (const e of backlog) { lastSeq = e.seq; await applyEntry(e, true); }

  const rc = msg.state?.recentChat ?? [];
  noteHistoryContext({
    total: msg.state?.chatTotal ?? null,
    shown: rc.length + msg.entries.filter((e) => e.verb === 'say').length,
    spanMs: rc.length > 1 ? rc[rc.length - 1].ts - rc[0].ts : null,
  });

  markPhase('world', 1);
  bus.emit('hydrated');
  bus.emit('roster');
  hooks.onSnapshotDone();
}

async function onSnapRequest(msg) {
  // The world asked us for a view of/from the target. Three framings:
  //   first  — the target's own eyes; the camera sits just outside their head
  //            mesh, so their body is never in frame.
  //   third  — chase cam over the shoulder: their body AND what it faces.
  //   selfie — from in front, facing them: the avatar itself is the subject.
  try {
    const r = remotes.get(msg.follow);
    if (!r?.avatar) throw new Error(`${msg.follow} not in local scene (still loading?)`);
    const root = r.avatar.root;
    const fwd = new THREE.Vector3(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
    if (msg.view === 'third') {
      const eye = root.position.clone().add(new THREE.Vector3(0, 2.1, 0)).addScaledVector(fwd, -3.4);
      camera.position.copy(eye);
      camera.lookAt(root.position.clone().add(new THREE.Vector3(0, 1.2, 0)).addScaledVector(fwd, 4));
    } else if (msg.view === 'selfie') {
      const eye = root.position.clone().add(new THREE.Vector3(0, 1.6, 0)).addScaledVector(fwd, 2.6);
      camera.position.copy(eye);
      camera.lookAt(root.position.clone().add(new THREE.Vector3(0, 1.25, 0)));
    } else {
      const eye = root.position.clone().add(new THREE.Vector3(0, 1.52, 0)).addScaledVector(fwd, 0.32);
      camera.position.copy(eye);
      camera.lookAt(eye.clone().addScaledVector(fwd, 8).add(new THREE.Vector3(0, -0.6, 0)));
    }
    renderer.render(scene, camera);   // completed frame, then read it
    const dataUrl = renderer.domElement.toDataURL('image/png');
    if (dataUrl.length < 2000) throw new Error('empty frame readback');
    net.ws.send(JSON.stringify({ type: 'snap-result', id: msg.id, dataUrl }));
  } catch (e) {
    net.ws.send(JSON.stringify({ type: 'snap-result', id: msg.id, error: e.message }));
  }
}
