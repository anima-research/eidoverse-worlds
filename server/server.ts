// eidoverse-worlds sequencer.
// The server orders and keeps the log and runs the shared physics engine for rests (spec/PHYSICS.md); it never runs bodies:
//  - orders + persists per-world event logs (the authored plane)
//  - relays presence (the embodied plane, never persisted)
//  - serves the browser client and the eidoverse-video asset library
// No world manifest: everything about a world arrives through its log.

import { nameAtDoor } from "./display-names.ts";
import { existsSync, appendFileSync, readdirSync } from "node:fs";
import { fileIncludes } from "./durable.ts";
import { join } from "node:path";
// config first: import order is boot order (config's WORLDS_DIR mkdir → auth.ts session restore → moderation.ts ban restore)
import { TRUST_NAMES } from "./config.ts";
import { checkHello, missingFeatures, versionLine } from "../shared/protocol/hello.js";
import { featureDecision, KNOWN_FEATURES } from "../shared/protocol/features.js";
// how often a person may change the name they show (moderation: a name is how people recognise who did what)
const RENAME_COOLDOWN_MS = envNumber("RENAME_COOLDOWN_DAYS", 7) * 86400000;
import { PORT, HOST, JOIN_TOKEN, RENDERER_TOKEN, RECORD, ROOT, WORLDS_DIR, LIBRARY_DIR, OPT_DIR, MSG_RATE, FRAME_MS, FRAME_SKIP_BUFFERED, SNAP_TIMEOUT_MS, SNAP_SWEEP_GRACE_MS, SNAP_SWEEP_EVERY_MS } from "./config.ts";
import { type HnSession, agentTokens, accountOf } from "./auth.ts";
import { addrSanctionsFor, saveAddrSanctions, notPersisted } from "./moderation.ts";
import { entryFor, doorOfWorld, whoOf, settleAccess, sweepAccess, setLoadedWorlds, unavailable, unavailableClose, toldOf, type Told, type Expel } from "./access.ts";
import { isOperator, mintSetupToken } from "./operators.ts";
import { setupLine } from "./setup.ts";
import { resolveLibFile } from "./libfile.ts";
import { summarizeGlb } from "./geometry.ts";
// the world itself (a log + the embodied plane) and the registry; the boot sweep that wakes scripted worlds is here
import { World, type Client, worlds, getWorld, wireSettledPose, wireRights, authorityNow } from "./world.ts";
import { isWorldSaved } from "./worldlog.ts";
import { bootNotice, noFoldRefusal, interruptedVisitorText } from "./oldworlds.ts";
import { warmIndex } from "./worldindex.ts";
import { oldFormatRefused, provenWho } from "./upgrade.ts";
import { backupsDirProblem } from "./backups.ts";
import { isNativeSession } from "./native-login.ts";
import { custodyFileIn, directoryFileIn } from "./keyfiles.ts";
import { requestHandler, actorOf as actorIdOf, gagged, guestSanctionByAddress, requestAs } from "./requestwire.ts";
import { withoutOnceAnim } from "../shared/onceanim.js";
import { directoryFor, foldName, accountTag } from "./directory.ts";
// the HTTP surface: one route table (routes.ts; /upload in upload.ts); avatarRoster rides back for the join snapshot
import { route, avatarRoster } from "./routes.ts";
import { joinBriefing } from "./briefing.ts";
import { screenshots } from "./screenshots.ts";
import { registerSystem, startTick } from "./tick.ts";
import { MESSAGES } from "./messages.ts";
import { LIMITS, envNumber, WORLD_NAME_RE } from "./limits.ts";
import { defsFingerprint } from "./defs.ts";
// seat profiles: routes.ts owns the HTTP half, seats.ts the one store and the update push; the poll is here
import { seatStore } from "./seats.ts";
import { announceProfileUpdate } from "./seats.ts";
import { PATCH_DIR } from "./config.ts";
// relay-floor: transport selection + durable voice-service identity
import { relayEnabled, bootIncarnation, currentIncarnation, voiceTransport } from "./transport.ts";
import { installSfuTransportGuard } from "./sfuguard.ts";
import { onVoiceServiceChange, markVoiceDegraded, voiceServiceState } from "./sfusupervisor.ts";
import { isOwner } from "../shared/protocol/roles.js";
import { inForceOf } from "../shared/protocol/authority.js";
import { newBucket, admitMessage } from "./msgrate.ts";
import { DEFAULT_BODY } from "../shared/avatardefs.js";
import { mintSfuCredential, setSfuConsent, setSfuModeratorMute, revokeSfuLeg, sfuDiag,
  sfuAcceptAnswer, sfuAcceptIce, sfuNegotiate, sfuSetPosition, registerSfuSender, admitSfuLeg, liveLegState, sfuLegAdmitted, markSfuLegAdmitted } from "./sfuadapter.ts";
// the incarnation is durable (transport.ts): a restart strands every old credential. Scratch servers keep their counter beside their own logs.
bootIncarnation(process.env.RELAY_STATE_DIR ?? OPT_DIR);

// the transport guard is installed here, once, never by constructing an Sfu (sfuguard.ts)
installSfuTransportGuard((err, kind) => markVoiceDegraded(`${kind}: ${String(err).slice(0, 120)}`));

// voice service state reaches every client of every world, stamped with the incarnation so a client can tell "the service
// restarted" (one clean fresh join) from "it flapped".
onVoiceServiceChange((state, incarnation, why) => {
  const msg = JSON.stringify({ type: "voice-service", state, incarnation, reason: why });
  for (const w of worlds.values()) for (const t of w.clients) t.ws.send(msg);
  console.log(`[sfu] voice-service ${state} (${incarnation})`);
});

/** Retire an identity's relay leg through the SAME funnel every other surface death uses: revoke at the relay, burn
 *  the credential, broadcast the transition. Fire-and-forget: a relay outage must never wedge a close. */
function retireRelayLeg(w: World, id: string) {
  if (!relayEnabled()) return;
  // 🔴 the SFU leg must retire here too, or a voice-leg reconnect inherits a consent the fresh leg never gave
  const leg = revokeSfuLeg(w.name, id);
  if (leg) {
    const retire = JSON.stringify({ type: "surface-transition",
      id, surface: "voice-relay", gen: null, retired: leg.gen });
    for (const t of w.clients) t.ws.send(retire);
    console.log(`[world:${w.name}] ${id}/voice-relay revoked — gen ${leg.gen}`);
  }
}

/** A pose as it should be handed to someone else: the settled result rather than whatever frame the body was in. One rule
 *  for the join snapshot's `restore` (via rememberPose) and `present`. A once-anim is a moment, not a place (replayed at every
 *  wake, a wave becomes a tic); a ragdoll is physics in flight whose get-up path exists only in the session that fell, so
 *  the body sleeps standing. Held bones (pose.pose) survive both. */
function settledPose(pose: unknown): Record<string, unknown> | null {
  if (!pose) return null;
  // mic/hear are a live reading re-sent every packet; remembered, a client would replay a voice state its new session
  // never had
  // t/seq: a sample's capture time and count (spec/PHYSICS.md §5.1) belong to that one sample, never to a remembered body
  const { mic: _mic, hear: _hear, t: _t, seq: _seq, ...still } = withoutOnceAnim(pose as Record<string, unknown>);
  if (still.clip === "ragdoll") { still.clip = "idle"; delete still.pose; }
  return still;
}
// the log's rememberPose settles through this same function; world.ts takes it by injection (settled-pose-test pins the definition here)
wireSettledPose(settledPose);
// A role change re-sends everyone's rights.
// …and whoever may no longer be here (a closed door, an ended grant, a demotion in a world that admits only people
// listed) is removed (server/access.ts settleAccess, 4010).
wireRights(
  (w) => { for (const c of w.clients) { try { c.ws.send(JSON.stringify({ type: "your-rights", rights: rightsFor(w, c) })); } catch { /* gone */ } }
    settleAccess(w, expel as Expel); },
);

// ------------------------------------------------------------------ presence

// ---- surface-session retirement (one implementation) ------------------------
// One broadcast + one reap, called from every path a session can die on (close, expel, travel): a silent aux death
// costs the author the full TTS fallback window on every say until a re-snapshot.

/** Announce one accepted aux leg's death. Only a leg that was ACCEPTED ever
 *  was a session: the gen is issued exactly on acceptance — no gen, no
 *  session, no event (a refused impostor must leave zero trace in anyone's
 *  capability model). */
function retireAuxLeg(w: World, leg: Client, except?: Client) {
  if ((leg.surface ?? "world") === "world" || leg.gen == null) return;
  const retire = JSON.stringify({ type: "surface-transition",
    id: leg.id, surface: leg.surface, gen: null, retired: leg.gen ?? null });
  for (const t of w.clients) if (t !== leg && t !== except) t.ws.send(retire);
}

/** A primary died (close, expel, travel): reap every aux leg of its identity.
 *  Retire BEFORE unmapping — this loop deletes the aux from `clients` before
 *  closing its socket, so the ws close handler finds nothing and would never
 *  broadcast (the exact silent-death hole, one caller upstream). */
function reapAuxLegs(w: World, primary: Client, closeReason: string) {
  // the identity's RELAY leg dies with its primary, same funnel (A1: primary retirement revokes the media credential)
  retireRelayLeg(w, primary.id);
  for (const t of [...w.clients]) {
    if (t !== primary && t.id === primary.id && (t.surface ?? "world") !== "world") {
      retireAuxLeg(w, t, primary);
      screenshots.retire(t);
      w.clients.delete(t); clients.delete(t.ws);
      t.ws.close?.(4007, closeReason);
      console.log(`[world:${w.name}] ${primary.id}/${t.surface} reaped — ${closeReason}`);
    }
  }
}

/** Remove a client from its world NOW: the kick/ban primitive, same shape as the identity takeover in `join`. Every
 *  bookkeeping step or a ghost is left behind: world roster, global client map, the socket, and the leave broadcast
 *  (close(ws) won't fire it: the client is already unmapped). */
function expel(w: World, target: Client, why: string, until?: number | null, code = 4006) {
  // `until`: when they may come back (a timed ban); an agent host reconnects then instead of never.
  // `code`: 4006 removed by moderation; 4010 (access.ts ACCESS_CLOSE) this world is no longer open to you — neither is redialled
  try { target.ws.send(JSON.stringify({ type: "error", error: why, ...(until ? { until } : {}) })); } catch { /* going anyway */ }
  const wasEmbodied = !target.spectator;
  screenshots.retire(target);
  // an expelled AUX leg announces its own death; an expelled PRIMARY takes its aux legs with it (kick/ban target the
  // identity, not one socket; the close handler never fires for an unmapped target)
  retireAuxLeg(w, target);
  if (wasEmbodied) reapAuxLegs(w, target, "primary removed by moderation");
  if (wasEmbodied && target.lastPose && target.actorId && !target.anonymous) w.rememberPose(target.actorId, target.lastPose); // they may be back (remembered by identity, never by name)
  target.superseded = true;   // the close path must not double-handle this body
  w.clients.delete(target);
  clients.delete(target.ws);
  target.world = null;
  target.ws.close?.(code, code === 4010 ? "access ended" : "removed by moderation");
  if (wasEmbodied) { w.broadcast({ type: "leave", id: target.id }); w.scripts.onPresence("leave", target.id, target.actorId); }
  if (wasEmbodied && target.actorId) w.log?.departed(target.actorId); // what they held drops into the world (design 20, orphans)
}

// Operator-log census: people are people, eyes are eyes.
function describe(w: World): string {
  const real = [...w.clients].filter((c) => !c.spectator).length;
  const eyes = w.clients.size - real;
  return `${real} present${eyes ? `, ${eyes} watching` : ""}`;
}

// World access expiry (access.ts): warn five minutes out, then the authority writes each passed `until` into the log
// (expire-roles) and whoever lost entry with it is removed, every second. A grant past its `until` is already absent.
setLoadedWorlds(() => worlds);
registerSystem({ name: "access-sweep", everyMs: Math.max(250, envNumber("ACCESS_SWEEP_MS", 1000)),
  fn: (now) => sweepAccess(worlds.values(), expel as Expel, now) });

// the operator's countersign (tools/operator/seat-accept.ts) edits the store from another process: noticed here, pushed as a proposal's event is
registerSystem({ name: "seat-store-poll", everyMs: 5000, fn: () => {
  const ext = seatStore.pollExternalChange();
  if (!ext) return;
  for (const ch of ext.changed) {
    const notified = announceProfileUpdate(ch.name, ch.pose, ext.rev);
    console.log(`[seats] external change ${ch.name}/${ch.pose} rev ${ext.rev} → ${notified} client(s)`);
  }
} });

// The engine's heartbeat: every world's sim advances and its rests log on this cadence, not only inside whoever's request comes
// next (a request still settles what is due before it writes: authority.js settleSim/returnDue). The pass is bounded by engine
// ticks, so a stall catches up over several beats.
registerSystem({ name: "physics", everyMs: FRAME_MS, fn: () => {
  for (const w of worlds.values()) { try { w.log?.settle(); } catch (err) { console.error(`[world:${w.name}] physics settle`, err); } }
} });
// one clock drives every world's script timers, so a behaviour keeps behaving with NOBODY connected
registerSystem({ name: "behaviors", everyMs: 1000, fn: (now) => {
  for (const w of worlds.values()) {
    try { w.scripts.tick(now); } catch (err) { console.error(`[world:${w.name}] behavior tick`, err); }
  }
} });

// Def hot-reload: defs/ is fingerprinted once a second and one `defs-updated` pushed when it moves (clients re-fetch /defs).
// The first fingerprint is the baseline, not a change.
let defsFp: string | null = null;
registerSystem({ name: "defs-watch", everyMs: 1000, fn: () => {
  const fp = defsFingerprint();
  if (defsFp !== null && fp !== defsFp) {
    const update = JSON.stringify({ type: "defs-updated" });
    let notified = 0;
    for (const w of worlds.values()) for (const c of w.clients) { c.ws.send(update); notified++; }
    console.log(`[defs] changed on disk → defs-updated pushed to ${notified} client(s)`);
  }
  defsFp = fp;
} });

// Boot: the worlds dir's shared key files under their current names (a dir saved before the names pass has
// them renamed once, server/keyfiles.ts), before any world or join reads them.
try { custodyFileIn(WORLDS_DIR); directoryFileIn(WORLDS_DIR); } catch (err) { console.error("[boot] key files", err); }

// Boot sweep: worlds load lazily, but a world with scripts wakes WITH the server (or its timers stay dark until a
// visitor). A cheap byte-scan of the log for a script component first; a false positive just loads once.
try {
  let woken = 0;
  for (const name of readdirSync(WORLDS_DIR)) {
    try {
      if (!WORLD_NAME_RE.test(name) || !isWorldSaved(name)) continue;
      if (fileIncludes(join(WORLDS_DIR, name, "world.jsonl"), '"script:')) { getWorld(name); woken++; }
    } catch (err) { console.error(`[boot] world ${name} peek failed`, err); }
  }
  if (woken) console.log(`[boot] ${woken} scripted world(s) woken — their scripts run without visitors`);
} catch (err) { console.error("[boot] world sweep failed", err); }
// Old-format worlds are not served, and the operator is TOLD (they were skipped in silence above): one block per world with
// the translator's command, this WORLDS_DIR filled in (server/oldworlds.ts).
try { const notice = bootNotice(WORLDS_DIR); if (notice) console.log(notice); } catch (err) { console.error("[boot] old-world notice failed", err); }
// the access index (worldindex.ts): every world's state, door and (an old one's) owners, read before the first request
try { await warmIndex((n) => worlds.has(n)); } catch (err) { console.error("[boot] access index failed", err); }
{ const bad = backupsDirProblem(WORLDS_DIR); if (bad) console.log(`[boot] ${bad}. Upgrades of old-format worlds refuse until it is moved.`); }

let nextClientNum = 1;
const clients = new Map<unknown, Client>();
screenshots.setClients(() => clients.values());   // roaming renderers are found across worlds
// …and sent only where they will be let in (a roamer with the renderers' credential goes anywhere — access.ts)
screenshots.setAdmission((w, c) => entryFor(doorOfWorld(w), whoOf(c), "watch") === null);
screenshots.setFrameTimeout(SNAP_TIMEOUT_MS);   // config.ts SNAP_TIMEOUT_SEC
screenshots.setSweepGrace(SNAP_SWEEP_GRACE_MS);   // config.ts SNAP_SWEEP_GRACE_SEC
// keep agents' worlds served (screenshots.ts sweep): on a timer, and at once when a roamer joins (below)
setInterval(() => { try { screenshots.sweep(); } catch (e) { console.error("[snap] sweep failed:", e); } }, SNAP_SWEEP_EVERY_MS);   // config.ts SNAP_SWEEP_EVERY_SEC
// transport-epoch source: global (never collides across worlds or a reload), never persisted
let GEN = 0;
// `session` on arrive and snapshot.present (what presence consumers scope a speaker's utterance counter by): the
// joining page's own id, else a fresh token for this leg. Opaque and observational: no authority reads it.
const PAGE_SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const presenceSession = (c: Client) => (c.presenceSession ??= crypto.randomUUID());

/** The placeholder tier's bbox side-channel, sent AFTER the snapshot as its own message: summaries are async, and the
 *  join handler stays synchronous (an awaited join would let the client's next messages interleave). */
function sendGeomFollowup(w: World, c: Client) {
  const libs = new Set<string>();
  for (const e of Object.values(w.state.entities)) if (e.model) libs.add(e.model);
  if (!libs.size) return;
  (async () => {
    const geom: Record<string, { bbox: unknown }> = {};
    for (const lib of libs) {
      try {
        const file = resolveLibFile(lib);
        const sum = file ? await summarizeGlb(file) : null;
        if (sum?.bbox) geom[lib] = { bbox: sum.bbox };
      } catch { /* a lib that won't parse simply has no placeholder */ }
    }
    if (Object.keys(geom).length && c.ws.readyState === 1) {
      c.ws.send(JSON.stringify({ type: "geom", geom }));
    }
  })().catch((err) => console.error(`[world:${w.name}] geom followup`, err));
}

// -------------------------------------------------------------- http + ws

// ---- join -------------------------------------------------------------------
// ADMISSION BEFORE TAKEOVER, structurally: admitJoin can only answer and refuse (it never touches the roster),
// installJoin is the only place a join mutates the roster, and buildSnapshot is a pure read.

/** A join's declared status (PROTOCOL §6a): one short lowercase word of its own ("agent", "ai", …; up to 32 characters — its own grammar, not a role id), else undeclared (null). */
function declarationOf(v: unknown): string | null {
  return typeof v === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(v) ? v : null;
}
function admitJoin(c: Client, ws: { send(d: string): void; close(code?: number, reason?: string): void }, msg: any, auth: HnSession | null): World | null {
    // a malformed world name is a bad LINK: refused with an explanation and a close code the client doesn't retry
    const wname = String(msg.world ?? "commons");
    if (!WORLD_NAME_RE.test(wname)) {
      ws.send(JSON.stringify({ type: "error", error: `"${wname}" is not a world name — check the link that brought you here` }));
      c.ws.close?.(4005, "bad world name");
      return null;
    }
    // what this join proves is decided from this join's own credentials: nothing a previous join on this socket proved carries
    // over (else a token presented once would let a second join wear any agent's name).
    c.tokenVerified = false; c.auxBound = false; c.actorId = undefined;
    // Identity: a verified session OWNS the id — the client's msg.id is
    // ignored (the name came from Discord via the home node, and the
    // sub underneath it survives renames).
    c.id = (auth ? auth.name : String(msg.id ?? c.id)).slice(0, LIMITS.ID_LEN);
    // Names are the log's ink: control characters are stripped, and names that forge system or script authorship
    // ("world", "script:*") are refused below
    c.id = c.id.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    // format characters (zero-width, bidi overrides) and compatibility forms are how one name passes for another
    c.id = c.id.normalize("NFKC").replace(/\p{Cf}/gu, "").trim();
    // no markup characters in a name: a typed one is refused in words, one the identity service gave becomes a look-alike (server/display-names.ts)
    {
      const n = nameAtDoor(c.id, { typed: !auth });
      if (n.refused) {
        ws.send(JSON.stringify({ type: "error", error: n.refused }));
        ws.close(4004, "name has markup");
        return null;
      }
      c.id = n.name;
    }
    // an identity is never a name: a name shaped like one (u-…) would pass for the person who wears it
    if (!c.id || /^(world|\*|system|sim)$/i.test(c.id) || /^script:/i.test(c.id) || /^u-[a-z2-7]{20}(?:[a-z2-7]{4})?$/i.test(c.id)) {
      ws.send(JSON.stringify({ type: "error", error: `that name is reserved for the world itself` }));
      ws.close(4004, "reserved name");
      return null;
    }
    {
    // a bare NAME resolves server-side against the same roster the
    // snapshot carries — the client no longer round-trips /avatars
    // before joining, and everyone else still sees the right body
    const a = String(msg.avatar ?? "");
    c.avatar = !a ? DEFAULT_BODY
      : a.includes("/") ? a
      : (avatarRoster().find((r) => r.name === a)?.path ?? DEFAULT_BODY);
  }
    // Surface: which leg of this identity is arriving. Sanitized like a world name; unknown values are allowed, but
    // "world" alone gets a body. One that sanitizes to EMPTY is refused, never defaulted to "world" (the one value with
    // takeover power over the body, and no aux-only admission gates).
    {
      const rawSurface = msg.surface == null ? "world" : String(msg.surface);
      c.surface = rawSurface.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, LIMITS.SURFACE_LEN);
      if (!c.surface) {
        ws.send(JSON.stringify({ type: "error", error: `unusable surface name — letters, digits, - and _ only` }));
        ws.close(4005, "bad surface");
        clients.delete(ws);
        return null;
      }
    }
    c.spectator = Boolean(msg.spectate) || c.surface !== "world";
    // a status the participant DECLARES (PROTOCOL §6a): optional, presence only, relayed with arrive and the snapshot's
    // present list, never inferred from the credential, the client or anything else, never logged, never read by a gate.
    // Absent is undeclared: no word is assumed. One short lowercase word; anything else is no declaration.
    c.declares = declarationOf(msg.declares) ?? undefined;
    // the joining page's own id (a page's typing and attention follow its own session), relayed as `session`
    if (typeof msg.session === "string" && PAGE_SESSION_RE.test(msg.session)) c.presenceSession = msg.session;
    c.renderer = Boolean(msg.renderer);
    c.roam = c.renderer && Boolean(msg.roam);
    // re-derived on every join, like the rest of identity: the renderers' own
    // credential, presented WITH the renderer flag on this very join
    c.trustedRenderer = c.renderer && Boolean(RENDERER_TOKEN) && String(msg.token ?? "") === RENDERER_TOKEN;
    screenshots.configure(c, msg.capture);
    if (c.renderer) c.spectator = true; // renderers are invisible by definition
    // ---- who this join is: an account, proven by this join's credential ----
    //   a verified session → its sub ("human:discord:…");
    //   an enrolled agent's bearer (mcpl/tokens.json) → "agent:token:<id>", and its name is that enrolment's id;
    //   a home-node aid1 credential of KIND agent → the enrolment that lists its subject, else "aid1:<iss>:<sub>";
    //   a private TRUST_NAMES door → "local:<typed name>"; otherwise none: anonymous.
    // A name reserved by an enrolment is claimable only with that enrolment's own proof. Never by a slug of a name.
    {
      const at = agentTokens();
      let account: string | null = auth && c.sub ? c.sub : null;
      let agentName: string | null = null;
      const proven = accountOf(String(msg.agentToken ?? ""));
      if (proven && "refused" in proven) {
        ws.send(JSON.stringify({ type: "error", error: proven.refused }));
        c.ws.close?.(4004, "bad agent credential");
        return null;
      }
      if (proven) { account = proven.account; agentName = proven.name; }
      if (agentName) { c.id = nameAtDoor(agentName.slice(0, LIMITS.ID_LEN), { typed: false }).name; c.tokenVerified = true; }   // an aid1 slug is the credential issuer's: no markup in it either. The credential proves WHO (the enrolment, the reserved name), never what kind: §6a
      // a reserved name is matched FOLDED (foldName: case, spaces, punctuation), as display collisions are — "Hes perus" and
      // "hesperus." are the enrolled name too ; the enrolment's own proof is the only way to wear it
      const reservedAs = [...at.names].find((n) => foldName(n) === foldName(c.id)) ?? null;
      if (reservedAs && account !== `agent:token:${reservedAs}`) {
        console.log(`[perm] join refused: "${c.id}" is a reserved agent name (no proof of that enrolment)`);
        ws.send(JSON.stringify({ type: "error", error: `"${c.id}" is a reserved agent name` }));
        c.ws.close?.(4004, "reserved name");
        return null;
      }
      // a private door: the account is the one the client keeps (msg.account), else the typed name — so a person can show a
      // new name and stay who they are. Typed, so the door's markup rule holds for it too.
      if (!account && TRUST_NAMES) { const keep = typeof msg.account === "string" ? nameAtDoor(msg.account.trim().slice(0, LIMITS.ID_LEN), { typed: false }).name : "";
        account = `local:${(keep || c.id).toLowerCase()}`; }
      // a connection that has joined stays who it proved it was: travel keeps the identity; a new one needs a new socket
      if (c.account !== undefined && c.account !== account) {
        ws.send(JSON.stringify({ type: "error", error: "this connection already joined as someone else — reconnect to join as another identity" }));
        c.ws.close?.(4004, "identity is fixed per connection");
        return null;
      }
      c.account = account;
      c.anonymous = !account;
    }
    // No existence oracle: a world that doesn't exist and one this principal may not discover get the same bytes
    // (access.ts unavailable). A watcher's close redials (an observer started early gets in once the world is founded).
    const unavailableHere = () => { const u = unavailable(wname);
      ws.send(JSON.stringify({ type: "error", code: u.code, error: u.message })); c.ws.close?.(unavailableClose(!!(msg.spectate || msg.renderer)), u.code); return null; };
    // What this joiner may be told (access.ts toldOf): a world discoverable to them opens; an interrupted conversion or an
    // old-format world is diagnosed only to the operator and (an old one) its recognised owner (server/upgrade.ts;
    // docs/reference/WIRE.md 4005); to anyone else it is world-unavailable. Asked of the door on disk, before loading: a refused
    // join never loads the world, and joining never founds one.
    { const dir = directoryFor(WORLDS_DIR);   // read-only: an undiscoverable world records nothing about who asked
      const answer = (t: Told) => {
        if (t.kind === "interrupted") { ws.send(JSON.stringify({ type: "error", error: interruptedVisitorText(wname) })); c.ws.close?.(4005, "interrupted conversion"); }
        else if (t.kind === "old") { ws.send(JSON.stringify({ type: "error", error: t.old.visitor, refused: oldFormatRefused(t.old.kind, t.old.visitor, t.operator, t.owner) })); c.ws.close?.(4005, "old-format world"); }
        else if (t.kind === "unavailable") unavailableHere();
        return null; };
      const told = toldOf(wname, { account: c.account ?? null, actorId: c.account ? dir.idOfSub(c.account) : null, trustedRenderer: !!c.trustedRenderer }, provenWho(c, msg));
      if (told instanceof Promise) { void told.then(answer); return null; }
      if (told.kind !== "door") return answer(told); }
    const w = getWorld(wname);
    // A display name is not proof of anything, so two people may never show the same one at once, and an anonymous visitor
    // may not wear a name an account has claimed here. Rename cooldown: a typed name that differs from the one this account
    // wore is a rename; inside the cooldown the old name stands and the client is told when it may change. A case change is
    // free; a sign-in's name is the provider's, not counted. The collision pass runs first, so the cooldown judges the name
    // the person will actually wear.
    c.renamed = false; c.renameRefused = undefined;
    const typed = c.id;
    if (!c.spectator) {
      const dir = directoryFor(WORLDS_DIR);
      const taken = (n: string) => [...w.clients].some((o) => o !== c && !o.spectator && foldName(o.id) === foldName(n) && (!c.account || o.account !== c.account))   // two guests are never one account
        || (!!c.anonymous && dir.claimedName(n))
        || (!!c.account && dir.claimedByOther(n, c.account));   // H2: nor an account under another account's name, here or not
      if (taken(c.id)) {
        const base = c.anonymous ? `${c.id} (guest)` : `${c.id}-${accountTag(c.account ?? "")}`;
        let n = base.slice(0, LIMITS.ID_LEN), k = 2;
        while (taken(n)) n = `${base.slice(0, LIMITS.ID_LEN - 3)} ${k++}`;
        c.id = n;
      }
    }
    if (!c.spectator && c.account && !auth && !c.tokenVerified) {
      const dir = directoryFor(WORLDS_DIR); const id0 = dir.idOfSub(c.account); const e0 = id0 ? dir.entry(id0) : null;
      if (e0 && foldName(e0.name) !== foldName(c.id)) {
        const until = (e0.renamedAt ?? 0) + RENAME_COOLDOWN_MS;
        if (Date.now() < until) { c.renameRefused = { tried: typed, until }; c.id = e0.name; }
        else c.renamed = foldName(c.id) === foldName(typed);   // a suffixed name wasn't their choice: no cooldown starts on it
      }
    }
    // A world's actor is an opaque id from the authority's directory (server/directory.ts, never logged), reached only through
    // an account; anonymous ids live in memory only. Typing someone's name never yields their id, so never their role.
    // a spectator skips the name checks above (it shows no name), so it mustn't record one either: its account keeps the
    // name it has, and a first sight takes the typed name only if no other account wears it
    { const dir = directoryFor(WORLDS_DIR);
      const kept = c.spectator && c.account ? dir.idOfSub(c.account) : null;
      c.actorId = kept ?? dir.resolve({ sub: c.account ?? null,
        name: c.spectator && c.account ? dir.spectatorName(c.id, c.account, LIMITS.ID_LEN) : c.id }); }
    if (c.renamed && c.actorId) directoryFor(WORLDS_DIR).markRenamed(c.actorId);
    // ENTRY, once identity is SETTLED, before the body enters: one decision (server/access.ts entryFor), the same every
    // other door asks. Bans first (watching counts), then @world.access, account age, capacity for a body. Operators
    // always get in (the unban path of last resort); listed owners and moderators pass every check but a ban (access.ts bypassOf).
    {
      const here = [...w.clients].filter((o) => !o.spectator && (o.surface ?? "world") === "world" && o.actorId !== c.actorId).length;
      const r = entryFor(doorOfWorld(w), whoOf(c), c.spectator ? "watch" : "embody", { here });
      if (r) {
        console.log(`[world:${w.name}] join refused: ${c.id} — ${r.reason}`);
        ws.send(JSON.stringify({ type: "error", error: r.why, ...(r.until ? { until: r.until } : {}) }));
        // "full" is its own close reason: it is transient, so a client waits and tries again; the others won't change
        c.ws.close?.(r.code, r.reason === "full" ? "full" : r.reason === "banned" ? "banned" : "no access");
        return null;
      }
    }
    if (w.log && c.actorId && !isOperator(c.account)) {
      // a guest is a fresh identity per connection: a mute a guest was given here is also filed against their
      // hashed address (moderation.ts), and every new guest from that address is given it too, written to the moderator
      // log as the moderator's own act on the new identity (so it shows, applies and lifts like any other)
      if (c.anonymous && c.addr && !c.spectator && (c.surface ?? "world") === "world") {
        let carried = 0;
        for (const s of addrSanctionsFor(w.name, c.addr)) {
          // only mutes are carried (a record of a kind no longer issued is ignored); one record per issuer, each carried as its own
          if (s.kind !== "mute" || inForceOf(w.log.live, c.actorId, "mute").some((m: any) => m.actor === s.actor)) continue;
          w.log.live.appendMod({ actor: s.actor, verb: s.kind, who: c.actorId, ...(s.kind === "mute" ? { channels: s.channels ?? ["voice", "chat"] } : {}), until: s.until, ...(s.reason ? { reason: s.reason } : {}), carried: "address" });
          if (!s.ids.includes(c.actorId)) s.ids.push(c.actorId); carried++;
        }
        if (carried) { saveAddrSanctions(); console.log(`[world:${w.name}] a guest's ${carried} sanction(s) carried to ${c.id} by address`); }
      }
    }
    c.world = w;
    // ADMISSION BEFORE TAKEOVER: every check that can refuse this join runs before the takeover kick, so only a join
    // that WILL be accepted may retire anyone (else an unauthenticated join kills the genuine leg it duels). The aux cap
    // is checked here too, leaving out a same-surface predecessor (the kick replaces it, it doesn't stack).
    if (c.surface !== "world") {
      // An aux leg without a living primary is an orphan mic: refuse it.
      const primary = [...w.clients].find(t => t !== c && t.id === c.id && (t.surface ?? "world") === "world" && !t.spectator);
      if (!primary) {
        ws.send(JSON.stringify({ type: "error", error: `no embodied "${c.id}" here to attach a ${c.surface} leg to — join the world first` }));
        ws.close(4008, "aux without primary");
        // (c is not in w.clients yet: only the global map needs cleaning)
        clients.delete(ws);
        return null;
      }
      // an aux leg binds to the primary's identity, or it does not attach (a same display name is presence, not authority).
      // It binds by account: the same proven account as its primary; a primary with no bindable credential gets none.
      const auxBound = !!c.account && c.account === primary.account;
      // remembered, so the attest gate admits the same identity this does
      if (auxBound) c.auxBound = true;
      if (!auxBound) {
        console.log(`[world:${w.name}] aux refused: "${c.id}"/${c.surface} has no binding to the primary's identity authority`);
        ws.send(JSON.stringify({ type: "error", error: `a ${c.surface} leg for "${c.id}" must present that identity's credential (agent bearer, or the primary's own login)` }));
        ws.close(4009, "unbindable aux");
        clients.delete(ws);
        return null;
      }
      // bounded legs per identity (takeover replaces, so 4 distinct surfaces is generous). Counted before the takeover kick,
      // excluding a same-surface predecessor (it would be replaced, not stacked).
      const auxCount = [...w.clients].filter(t => t !== c && t.id === c.id
        && (t.surface ?? "world") !== "world" && t.surface !== c.surface).length;
      if (auxCount >= LIMITS.AUX_LEGS) {
        ws.send(JSON.stringify({ type: "error", error: "too many auxiliary legs for this identity" }));
        ws.close(4008, "aux cap");
        // (c is not in w.clients yet: only the global map needs cleaning)
        clients.delete(ws);
        return null;
      }
    }
  return w;
}

function installJoin(c: Client, w: World) {
    // identity takeover: ONE body per id per world, so a stale session (half-open socket, zombie reconnect) is kicked
    // when its identity reconnects. No leave broadcast: it is re-arriving. PER (id, surface); plain spectators never duel.
    let retiredGen: number | undefined;
    if (!(c.spectator && c.surface === "world")) {
      for (const other of [...w.clients]) {
        // a takeover is the same account re-arriving: a typed name never kicks anyone, and anonymous sessions
        // never take over (each is its own guest)
        // …and the same account under a NEW name is a takeover too (else the old socket's close departs the body)
        if (other !== c && !!c.account && other.account === c.account
            && (other.surface ?? "world") === c.surface
            && !(other.spectator && (other.surface ?? "world") === "world")) {
          other.superseded = true;
          screenshots.retire(other);
          retiredGen = other.gen;
          w.clients.delete(other);
          clients.delete(other.ws);
          other.ws.close?.(4002, "session takeover");
          console.log(`[world:${w.name}] ${c.id}/${c.surface} takeover — gen ${other.gen} retired`);
          // a world-surface takeover retires the predecessor's relay leg, under its own id: its credential is bound to the
          // retired primaryGen, and the successor mints fresh
          if ((c.surface ?? "world") === "world" && !other.spectator) retireRelayLeg(w, other.id);
          // …and under a new name, the old name's avatar leaves everyone's view (the superseded close says nothing)
          if ((c.surface ?? "world") === "world" && !other.spectator && other.id !== c.id) {
            w.dirty.delete(other.id);
            { w.broadcast({ type: "leave", id: other.id }); w.scripts.onPresence("leave", other.id, other.actorId); }
          }
        }
      }
    }
    c.gen = ++GEN;   // B2: this leg's surfaceSession, issued on acceptance
    c.legGen = w.legGen();   // the world-scoped generation caption entries carry (survives restarts)
    w.clients.add(c);
    screenshots.noteJoin(c);   // when it (re)joined: a roamer just arrived may still be loading the world
    // a body with an agent's enrolment (never a declaration: §6a): pre-warm a roaming renderer (screenshots.ts prewarm)
    if (c.tokenVerified && !c.spectator) screenshots.prewarm(w);
    // …and a roaming renderer joining is sent straight to an agent's world that has none, a second later (its own join
    // settled first)
    if (c.roam) setTimeout(() => { try { screenshots.sweep(); } catch (e) { console.error("[snap] sweep failed:", e); } }, 1_000);
    // every aux join is visible to subscribers (retired: null on a first join): listeners key hold-then-fallback TTS on a live
    // voice leg, and one that joined after their snapshot would otherwise be invisible. A world-body takeover re-arrives through presence.
    if (c.surface && c.surface !== "world") {
      const transition = JSON.stringify({ type: "surface-transition",
        id: c.id, surface: c.surface, gen: c.gen, retired: retiredGen ?? null });
      for (const t of w.clients) if (t !== c) t.ws.send(transition);
    }
    // (a world's owner is named when it is FOUNDED — tools/world.ts found, or the translator — never by being first in)
}

/** What a client is told it may do: the role the authority gives it (the authority admits every write), and the body and spend
 *  permissions its role record carries (@world roles:<id>, else the world's default-role; a guest never wears the
 *  default). `open` = the world has no owner. */
function rightsFor(w: World, c: Client) {
  // rights come from the authority alone ({role, rank, permissions}, by identity); gen and fly stay as the client's flags, read
  // off the permissions. A server operator (SERVER_OPERATORS, by account) flies and spends everywhere.
  const op = isOperator(c.account);
  const wc = (w.log.live.state().entities?.["@world"]?.c ?? {}) as Record<string, any>;
  const open = !Object.entries(wc).some(([k, v]) => k.startsWith("roles:") && isOwner(v));
  if (!c.actorId) return { role: "member", roleName: "Member", rank: 0, permissions: [] as string[], gen: op, fly: op, open };
  const e = w.log.rightsOf(c.actorId); const m = w.log.mutedHere(c.actorId);
  return { role: e.role, roleName: e.name, rank: e.rank, permissions: e.permissions, ...(c.anonymous ? { guest: true } : {}), gen: op || e.permissions.includes("generate"), fly: op || e.permissions.includes("fly"), open,
    ...(m ? { muted: { channels: m.channels, until: m.until } } : {}) };
}
/** The sanctions sweep: every couple of seconds, and right after a moderation act, make
 *  each world's live state match the moderator log by the authority's clock. Nothing is written when a sanction ends;
 *  this is what notices. Per connection it keeps what it last applied, so it acts only on a change:
 *   - voice: the SFU's moderator mute (enforced at ingress) is on while a voice mute is in force;
 *   - rights: the person is told their own state again (your-rights carries muted);
 *   - the muted badges every client draws (mod-state: identity → until), when the set changes. */
/** who is muted here now, by identity → until (the people list's muted glyph) */
function mutedIn(S: Record<string, unknown>): Record<string, number> {
  const muted: Record<string, number> = {}; for (const [id, x] of Object.entries(S)) if ((x as any).mute) muted[id] = (x as any).mute.until ?? 0;
  return muted;
}
export function sanctionSweep(w: World) {
  if (!w.log) return;
  const S = w.log.sanctions();   // one pass over the moderator log per world per sweep
  for (const c of [...w.clients]) {
    if (c.spectator || (c.surface ?? "world") !== "world" || !c.actorId) continue;
    const x = S[c.actorId] as any; const voice = !!x?.mute?.channels?.includes("voice");
    if (voice !== !!c.sfuMuted && (voice || c.sfuMuted !== undefined)) { try { setSfuModeratorMute(w.name, c.id, voice); } catch (err) { console.error(`[world:${w.name}] sfu mute`, err); } }
    c.sfuMuted = voice;
    const mine = JSON.stringify([x?.mute?.until ?? null, x?.mute?.channels ?? null]);
    if (c.sanctionKey !== mine) { const first = c.sanctionKey === undefined; c.sanctionKey = mine;
      if (!first) { try { c.ws.send(JSON.stringify({ type: "your-rights", rights: rightsFor(w, c) })); } catch { /* gone */ } } }
  }
  // the SFU keys its mute on the connection's display id: once that person is gone, release it, so a display id never
  // carries a mute across people (the next holder of the name is someone else; the identity's own return re-applies it)
  const live = new Set([...w.clients].filter((c) => c.sfuMuted).map((c) => c.id));
  for (const id of [...(w.sfuMutedIds ?? [])]) if (!live.has(id)) { try { setSfuModeratorMute(w.name, id, false); } catch { /* relay gone */ } }
  w.sfuMutedIds = live;
  const muted = mutedIn(S);
  const key = JSON.stringify(muted);
  if (w.modStateKey !== key) { w.modStateKey = key; w.broadcast({ type: "mod-state", muted }); }
}
registerSystem({ name: "sanctions", everyMs: 2000, fn: () => { for (const w of worlds.values()) { try { sanctionSweep(w); } catch (err) { console.error(`[world:${w.name}] sanction sweep`, err); }
  try { w.regateReaches(); } catch (err) { console.error(`[world:${w.name}] re-gating reaches`, err); } } } });   // a timed allow ends with no request

function buildSnapshot(w: World, c: Client) {
    // snapshot = the authority's cut of the world (the joiner folds it, then the log stream) + who's present now
    return {
      type: "snapshot",
      briefing: joinBriefing(),
      you: c.id,
      // when this account may next change its name (and the name it just tried, if that was too soon)
      ...(c.account && !c.tokenVerified ? { renameAfter: (directoryFor(WORLDS_DIR).entry(c.actorId ?? "")?.renamedAt ?? 0) + RENAME_COOLDOWN_MS, renameCooldownDays: RENAME_COOLDOWN_MS / 86400000 } : {}),
      ...(c.renameRefused ? { renameRefused: c.renameRefused } : {}),
      // your durable subject, when the authority vouched for one
      ...(c.sub ? { yourSub: c.sub } : {}),
      gen: c.gen,   // your surfaceSession — echo it in attestations
      // your OWN live aux legs (people[] excludes self): a page that reconnects while its voice leg lives must not
      // double-speak next to its own voice
      yourSurfaces: [...w.clients]
        .filter(x => x !== c && x.id === c.id && (x.surface ?? "world") !== "world")
        .map(x => ({ surface: x.surface, gen: x.gen })),
      recording: RECORD,
      // the world: the authority's cut (its fold, head, your undoable acts, names, holds), which the joiner folds and then
      // advances with the `log` stream. A joiner's cost is the size of the WORLD, not the length of its history.
      ...w.log.info(), ...w.log.clientSnapshot(actorIdOf(c)),   // flat (D5): {dialect, v, world, name, seq, state, physics, names, holds, mine, you}
      ...versionLine(featureDecision(w.log.live?.entries ?? [], KNOWN_FEATURES).requires),   // F-3 step 5: the authoritative {dialect, v, requires}
      // chat isn't world state, and speech is arrival-only: a joiner is sent no line said before it came, so the
      // window is always empty. chatTotal is how many lines a history page could still show this joiner: for an admin
      // (owner, operator) every line the master log holds; for everyone else none
      chat: { recentChat: [], chatTotal: w.isAdmin(c) ? (w.state.chatTotal ?? 0) : 0 },
      throughSeq: w.log.snapSeq,
      // the body roster rides along — a joiner resolves names with no
      // extra round-trip (bbox geometry follows as its own message)
      avatars: avatarRoster(),
      // what YOU may do here, as of now (a role change re-sends it: your-rights)
      yourRights: rightsFor(w, c),
      // wake where you fell asleep — the world's memory of your body
      restore: c.spectator || !c.actorId ? null : (w.poses[c.actorId] ?? null),   // by identity: a name is anyone's to wear
      present: [...w.clients].filter(o => o !== c && !o.spectator).map(o => ({
        // settledPose, not lastPose: a joiner must not inherit someone else's mid-ragdoll frame (as `restore` above)
        id: o.id, avatar: o.avatar, pose: settledPose(o.lastPose), ...(o.declares ? { declares: o.declares } : {}), session: presenceSession(o),   // §6a: relayed as declared; absent = undeclared
        // a world: the identity the log and roles know them by (granting a role names this id, never a name)
        ...(o.actorId ? { actorId: o.actorId } : {}),
        ...(w.log && o.anonymous ? { guest: true } : {}),   // no account: the people list's 'guest' badge (research roles S6)
        // which aux legs this identity has live NOW: a surface summary on the one roster, never a second body
        surfaces: [...w.clients]
          .filter(x => x.id === o.id && (x.surface ?? "world") !== "world")
          .map(x => ({ surface: x.surface, gen: x.gen })),
      })),
    };
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  // Bun's default idleTimeout (10 s with no bytes moving, mid-response too) truncates a big download over a slow link;
  // 255 s is its maximum. The WebSocket has its own idle timer (left at Bun's default, 120 s).
  idleTimeout: 255,
  async fetch(req, srv) {
    // the whole HTTP surface is routes.ts's table (one row per endpoint, first match wins); /ws upgrades inside its row
    return route(req, srv);
  },
  websocket: {
    maxPayloadLength: LIMITS.WS_MESSAGE_BYTES,
    // every ws callback: a throw out of open/close would exit the process, and close reaches disk (a departure's drop,
    // rememberPose), so an EIO/ENOSPC there must be a log line, never an exit.
    open(ws) {
      try {
        const c: Client = { id: `anon-${nextClientNum++}`, ws, world: null, avatar: "", lastPose: null, spectator: false,
          msgs: newBucket(2 * MSG_RATE) };
        const data = (ws as unknown as { data?: { session?: HnSession | null; addr?: string } }).data;
        const sess = data?.session;
        if (sess && sess.exp > Date.now()) { c.auth = sess; c.sub = sess.sub; }
        c.addr = data?.addr ?? null;
        clients.set(ws, c);
      } catch (err) {
        console.error(`[ws] open failed server-side:`, err);
      }
    },
    close(ws) {
      try {
        const c = clients.get(ws);
        if (!c) return;
        screenshots.retire(c);
        clients.delete(ws);
        // dev crash forensics (?bc=1 clients): the last thing a dying renderer
        // was doing, printed at the only moment we learn it died
        if (c.bcRing?.length) {
          console.log(`[bc] ${c.id} last breadcrumbs: ${c.bcRing.join(" | ")}`);
        }
        if (c.world) {
          c.world.clients.delete(c);
          // AUX LEG DEATH IS AN EVENT, carrying the dying gen (a client that already saw a successor ignores it). Not on
          // takeover: the join-time transition announced the successor. retireAuxLeg owns "only an ACCEPTED leg was a session".
          if (!c.superseded) retireAuxLeg(c.world, c);
          if (!c.spectator) {
            if (!c.superseded) {
              try { if (c.actorId && !c.anonymous) c.world.rememberPose(c.actorId, c.lastPose); } // sleep where you stood (by identity; a guest's id is new each visit)
              catch (err) { console.error(`[world:${c.world.name}] rememberPose for ${c.id} on close`, err); }
            }
            c.world.broadcast({ type: "leave", id: c.id }); c.world.scripts.onPresence("leave", c.id, c.actorId);
            if (!c.superseded && c.actorId) c.world.log?.departed(c.actorId); // a takeover keeps the body; a departure drops what it held
            // the primary is gone: reap its aux legs, unless a successor took over (they transfer to it)
            if (!c.superseded) reapAuxLegs(c.world, c, "primary session gone");
          }
          console.log(`[world:${c.world.name}] ${describe(c.world)} — ${c.id} ${c.spectator ? "stopped watching" : "left"}`);
        }
      } catch (err) {
        console.error(`[ws] close failed server-side:`, err);
      }
    },
    message(ws, raw) {
      const c = clients.get(ws);
      if (!c) return;
      // a superseded generation is dead to the world even while its socket drains. Every superseding path also unmaps the
      // ws (the real protection); this is the backstop for one that doesn't.
      if (c.superseded) return;
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      // message-rate cap (server/msgrate.ts): a token bucket at MSG_RATE a second with two seconds of burst, so a backlog the
      // server's own busy thread caused isn't charged to the client. Over it, a REQUEST is answered (its client awaits a reply
      // by id: silence would leave it hanging), up to MSG_RATE answers a second; anything else is dropped.
      const now = Date.now();
      const verdict = admitMessage(c.msgs, now, MSG_RATE);
      if (verdict !== "run") {
        if (msg?.type === "request" && verdict === "refuse") { try { ws.send(JSON.stringify({ type: "reply", id: msg.id ?? null, verb: String(msg.verb ?? "").slice(0, 32), ok: false,
          reply: { ok: false, refused: { code: "rate", reason: `more than ${MSG_RATE} messages a second from this connection: this request wasn't run`, fix: "slow down and send it again" } } })); } catch { /* gone */ } }
        return;
      }

      // No message may ever kill the process: a throw in Bun's ws callback EXITS THE SERVER, and a client in a reconnect
      // loop turns one bad request into a crash loop for everyone. Refusals are messages, failures are logs.
      try {
      switch (msg.type) {
        case "join": {
          // a verified session (bound at upgrade) passes without the door key; everyone else needs JOIN_TOKEN. Both may
          // be live at once
          const auth = c.auth && c.auth.exp > Date.now() ? c.auth : null;
          // …and a renderer may come through on the RENDERERS' credential
          // instead (config.ts RENDERER_TOKEN) — only as a renderer
          const rendererKey = Boolean(RENDERER_TOKEN) && Boolean(msg.renderer) && String(msg.token ?? "") === RENDERER_TOKEN;
          if (!auth && JOIN_TOKEN && String(msg.token ?? "") !== JOIN_TOKEN && !rendererKey) {
            ws.send(JSON.stringify({ type: "error", error: "bad or missing join token" }));
            c.ws.close?.(4003, "bad token");
            return;
          }
          if (auth) {
            const need = msg.spectate ? ["worlds:spectate", "worlds:join"] : ["worlds:join"];
            if (!need.some((s) => auth.scopes.includes(s))) {
              ws.send(JSON.stringify({ type: "error", error: msg.spectate ? "your login lacks spectate access" : "your login lacks embodied access — try ?spectate" }));
              c.ws.close?.(4003, "insufficient scope");
              return;
            }
          }
          // the global hello, before any world lookup (docs/decisions/LOG-VOCABULARY.md §F F-3): the refusal names no world
          { const r = checkHello(msg.hello);   // always: a join with no hello is a client this server doesn't speak to
            if (r) { ws.send(JSON.stringify(r)); c.ws.close?.(4005, "update-required"); return; } }
          // leave the previous world (travel is: leave A, join B). Travel never runs the ws-close handler, so without the reap a
          // travelling primary would leave a live, credentialed orphan mic behind.
          if (c.world) {
            screenshots.retire(c);
            c.world.clients.delete(c);
            retireAuxLeg(c.world, c);
            if (!c.spectator) {
              c.world.broadcast({ type: "leave", id: c.id }); c.world.scripts.onPresence("leave", c.id, c.actorId);
              if (c.actorId) c.world.log?.departed(c.actorId);
              reapAuxLegs(c.world, c, "primary traveled");
            }
          }
          const w = admitJoin(c, ws, msg, auth);
          if (!w) return;
          // a world talks only to clients that fold its log. A client that doesn't (an old page, an old agent build) is refused with
          // the reason; 4005 = a refused join, which clients know not to redial. An aux surface carries no world state: it isn't asked.
          if (w.log && msg.replica !== true && (c.surface ?? "world") === "world") {
            ws.send(JSON.stringify({ type: "error", error: noFoldRefusal(w.name, !!auth && isNativeSession(auth)) }));
            ws.close(4005, "this client doesn't fold the log");
            clients.delete(ws);
            return;
          }
          // only after access is granted, the world's required features against the client's
          if (msg.hello !== undefined) {
            const r = missingFeatures(featureDecision(w.log?.live?.entries ?? [], KNOWN_FEATURES).requires, msg.hello.features);
            if (r) { ws.send(JSON.stringify(r)); ws.close(4005, "unsupported-feature"); clients.delete(ws); return; }
          }
          c.replica = msg.replica === true;
          installJoin(c, w);
          // speech is arrival-only: this connection hears says after the cut it is about to adopt, and reads back
          // none at or below it (history, the authority's history) unless it is an admin's (world.ts sayFloor)
          c.arrivedSeq = w.log.seq;
          // The server's clock, just before the snapshot, for a join that asks
          // (`clock: true`): the world's authority clock, the one frames and
          // clock replies carry (spec/PHYSICS.md §5.1). A browser seeks shared
          // sounds in it, and an agent evaluates motion in it (serverNow in
          // client/lib/serverclock.js and mcpl/agent.ts); both learn it from a
          // message's `t`, until a browser's first round trip lands. The snapshot's own transfer time would
          // bias the first sample, so a small message carries it first. A join
          // that doesn't ask gets the messages it always did, so a client that
          // takes the first message after a join as the snapshot still works.
          if (msg.clock === true) ws.send(JSON.stringify({ type: "clock", t: authorityNow(w) }));
          ws.send(JSON.stringify(buildSnapshot(w, c)));
          // the badges already in force: mod-state is broadcast only when the set changes, so a joiner is told it now
          if (w.log) ws.send(JSON.stringify({ type: "mod-state", muted: mutedIn(w.log.sanctions()) }));
          sendGeomFollowup(w, c);
          if (!c.spectator) w.broadcast({ type: "arrive", id: c.id, avatar: c.avatar, ...(c.declares ? { declares: c.declares } : {}), session: presenceSession(c), ...(c.actorId ? { actorId: c.actorId } : {}), ...(w.log && c.anonymous ? { guest: true } : {}) }, c);
          if (w.log) sanctionSweep(w);   // a voice mute in force is re-applied on join (keyed on the identity, never a name)
          if (!c.spectator) w.scripts.onPresence("enter", c.id, c.actorId);
          console.log(`[world:${w.name}] ${describe(w)}${c.spectator ? ` — ${c.id} watching` : ` — ${c.id} joined`}`);
          break;
        }
        // ── SFU signaling (VOICE_TRANSPORT=sfu) ──────────────────────────
        // one end IS the server: no recipient to address, no fanout. Never logged, SDP-sized cap, dropped if the leg is gone.
        case "sfu-answer": {
          if (!c.world || !relayEnabled()) return;
          // the same gate relay-cred uses: a spectator or aux leg keeps the primary's `c.id` (test/server/sfu-verb-gate-test.mjs)
          if (c.spectator || (c.surface ?? "world") !== "world") return;
          // the credential's refusals run here, at the first authenticated act after it is issued: the answer must prove it is
          // the leg the credential was minted for (admitSfuLeg)
          {
            // admit once per leg, not per answer: the nonce is single-use, but sfu-answer fires on every renegotiation
            if (sfuLegAdmitted(c.world.name, c.id)) {
              const sdpOk = String(msg.sdp ?? "");
              if (sdpOk.length > 20000) return;
              void sfuAcceptAnswer(c.world.name, c.id, sdpOk, Number((msg as { gen?: unknown }).gen ?? NaN) || undefined);
              return;
            }
            const cl = (msg as { cred?: Record<string, unknown> }).cred;
            const verdict = cl
              ? admitSfuLeg(c.world.name, {
                  world: String(cl.world ?? ""), id: String(cl.id ?? ""),
                  primaryGen: Number(cl.primaryGen ?? -1), mediaGen: Number(cl.mediaGen ?? -1),
                  incarnation: String(cl.incarnation ?? ""), nonce: String(cl.nonce ?? ""),
                }, liveLegState(c.world.name, c.id, c.gen))
              : { admit: false as const, reason: "no credential presented" };
            if (verdict.admit) markSfuLegAdmitted(c.world.name, c.id);
            if (!verdict.admit) {
              console.warn(`[sfu] answer REFUSED for ${c.id}: ${verdict.reason}`);
              ws.send(JSON.stringify({ type: "error", error: `voice leg refused: ${verdict.reason}` }));
              revokeSfuLeg(c.world.name, c.id);
              return;
            }
          }
          const sdp = String(msg.sdp ?? "");
          if (sdp.length > 20000) return;
          void sfuAcceptAnswer(c.world.name, c.id, sdp, Number((msg as { gen?: unknown }).gen ?? NaN) || undefined);
          return;
        }
        case "sfu-ice": {
          if (!c.world || !relayEnabled()) return;
          // the same gate relay-cred uses: a spectator or aux leg keeps the primary's `c.id` (test/server/sfu-verb-gate-test.mjs)
          if (c.spectator || (c.surface ?? "world") !== "world") return;
          // gen required end-to-end: the adapter refuses
          // missing or stale generations, mirroring sfu-answer.
          sfuAcceptIce(c.world.name, c.id, msg.candidate, typeof msg.gen === "number" ? msg.gen : undefined);
          return;
        }
        case "sfu-pos": {
          // position feed for the proximity gate, OPTIONAL (it fails open): withholding yours silences nobody
          if (!c.world || !relayEnabled()) return;
          // the same gate relay-cred uses: a spectator or aux leg keeps the primary's `c.id` (test/server/sfu-verb-gate-test.mjs)
          if (c.spectator || (c.surface ?? "world") !== "world") return;
          const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
          sfuSetPosition(c.world.name, c.id, n(msg.x), n(msg.y), n(msg.z));
          return;
        }
        case "sfu-want-negotiate": {
          // the client added a track and needs an offer: it ASKS, since the server owns every offer (glare)
          if (!c.world || !relayEnabled()) return;
          // the same gate relay-cred uses: a spectator or aux leg keeps the primary's `c.id` (test/server/sfu-verb-gate-test.mjs)
          if (c.spectator || (c.surface ?? "world") !== "world") return;
          sfuNegotiate(c.world.name, c.id, (payload) => ws.send(JSON.stringify(payload)));
          return;
        }
        case "relay-cred": {
          // mint the least-authority media credential for the embodied primary. The leg is a surface session: gen from the
          // same counter, the same transition event, the same retirement funnel.
          if (!c.world) return;
          if (!relayEnabled()) { ws.send(JSON.stringify({ type: "error", error: "no voice relay configured" })); return; }
          if (c.spectator || (c.surface ?? "world") !== "world") {
            ws.send(JSON.stringify({ type: "error", error: "relay-cred is the embodied primary's ask" }));
            return;
          }
          // scopes are designed askable-down, not yet enforced: every credential is a publishing credential
          const mediaGen = ++GEN;
          {
            // Mint FIRST: mintSfuCredential funnels through revokeSfuLeg (a re-mint inherits no consent/admission), which
            // unregisters the sender, so registering comes after
            const cred = mintSfuCredential(c.world.name, c.id, c.gen!, mediaGen);
            registerSfuSender(c.world.name, c.id, (payload) => ws.send(JSON.stringify(payload)));
            // the mint retired the old leg, and a retirement resets the id's mute at the SFU (sfuadapter.ts revokeSfuLeg):
            // forget what this connection last applied, its mute and deafness both, so the sweep applies the sanctions in
            // force to the new leg
            c.sfuMuted = undefined;
            if (c.world.log) sanctionSweep(c.world);
            const transition = JSON.stringify({ type: "surface-transition",
              id: c.id, surface: "voice-relay", gen: mediaGen, retired: null });
            for (const t of c.world.clients) if (t !== c) t.ws.send(transition);
            ws.send(JSON.stringify({ type: "relay-cred", ...cred, gen: mediaGen,
              service: { enabled: true, ...voiceServiceState(), transport: "sfu" } }));
            return;
          }
        }
        case "voice-moderate": {
          // The authority's `mute {channels: ['voice']}` (or `unmute`): keyed on the target's IDENTITY, logged in the
          // moderator log, gated like every person-act (the mute permission, a target ranked below you), and re-applied on
          // every join while it lasts (sanctionSweep). The SFU's moderator mute (enforced at ingress) is how it applies.
          // The target: msg.actorId (an identity), else the PRESENT person whose name is msg.id (never an absent name, so a
          // name someone typed to dodge or to frame can only ever reach the identity actually standing there).
          if (!c.world?.log) return;
          if (c.spectator || (c.surface ?? "world") !== "world") return;
          const w = c.world;
          const target = typeof msg.actorId === "string" ? msg.actorId : [...w.clients].find((t) => t.id === String(msg.id ?? "") && (t.surface ?? "world") === "world" && !t.spectator)?.actorId;
          if (!target) { ws.send(JSON.stringify({ type: "error", error: "nobody here by that name to mute" })); return; }
          const muted = msg.muted === true;
          const minutes = typeof msg.minutes === "number" ? msg.minutes : 60;
          // the voice control's unmute lifts a VOICE mute: one that also covers chat is lifted where its whole record is
          // (Moderation › Bans, /unmute), not ended quietly from a voice button
          if (!muted && w.log.mutedHere(target, "chat")) { ws.send(JSON.stringify({ type: "error", error: "that mute covers chat too: lift it in Moderation › Bans (or /unmute)" })); return; }
          // through the request path: one capability, the connection's queue, the meters, both recheck seams
          void requestAs(c, ws, w, muted ? "mute" : "unmute", muted ? { who: target, minutes, channels: ["voice"], ...(typeof msg.reason === "string" ? { reason: msg.reason } : {}) } : { who: target })
            .then((r: any) => {
              if (!r?.ok) { ws.send(JSON.stringify({ type: "error", error: r?.refused?.reason ?? "that mute was refused" })); return; }
              sanctionSweep(w);
              const unsaved = guestSanctionByAddress(w, actorIdOf(c), c.id, muted ? "mute" : "unmute", target, typeof msg.reason === "string" ? msg.reason : undefined);   // R 10-07
              if (unsaved) ws.send(JSON.stringify({ type: "mod", text: `that mute's address record is ${notPersisted(unsaved)}` }));
              if (muted) for (const t of w.clients) if (t.actorId === target) { try { t.ws.send(JSON.stringify({ type: "moderated", verb: "mute", by: c.id, you: true, channels: ["voice"], until: r.until })); } catch { /* gone */ } }
              // moderation is world-visible by design: a silence nobody can see the cause of is indistinguishable from a bug
              const name = [...w.clients].find((t) => t.actorId === target)?.id ?? target;
              const note = JSON.stringify({ type: "voice-moderated", id: name, actorId: target, muted, by: c.id, ...(muted ? { until: r.until } : {}) });
              for (const t of w.clients) { try { t.ws.send(note); } catch { /* gone */ } }
              console.log(`[world:${w.name}] ${c.id} ${muted ? "muted" : "unmuted"} ${name} (${target}) for everyone`);
            });
          return;
        }
        case "voice-consent": {
          // listener-authored receive consent: server-enforced, gen-bound (a reconnect starts fail-closed), idempotent.
          // Self-mute stays client-side; moderator mute is voice-moderate.
          if (!c.world || c.spectator) return;
          if (!relayEnabled()) return;
          const r = setSfuConsent(c.world.name, c.id, c.gen ?? 0, msg.recv === true);
          ws.send(JSON.stringify({ type: "voice-consent", recv: msg.recv === true,
            applied: r.changed, ...(r.reason ? { note: r.reason } : {}) }));
          return;
        }
        default: {
          // every other type lives in the handler table (server/messages.ts); unknown types fall through to silence.
          // OWN keys only: "__proto__" or "constructor" must never reach Object.prototype.
          // every world speaks the protocol: the authority's own types first (server/requestwire.ts), then the room's (presence, voice, chat lanes)
          const h = requestHandler(msg.type) ?? (typeof msg.type === "string" && Object.hasOwn(MESSAGES, msg.type) ? MESSAGES[msg.type] : undefined);
          if (h && !gagged(c, String(msg.type))) h({ c, ws, now, expel, sweep: sanctionSweep }, msg);
        }
      }
      } catch (err) {
        console.error(`[ws] "${String(msg?.type)}" from ${c.id} failed server-side:`, err);
        try { ws.send(JSON.stringify({ type: "error", error: "that request failed server-side — it has been logged" })); } catch { /* socket already gone */ }
      }
    },
  },
});

// ---- stage-frame tick: the embodied plane's heartbeat ----------------------
// One frame per world per tick carrying every pose that changed since the last
// tick. Frames are disposable (latest-value-wins): a client whose socket is
// backed up skips ticks instead of queueing history it will only fast-forward
// through. Idle worlds cost one Map.size check.
registerSystem({ name: "stage-frames", everyMs: FRAME_MS, fn: () => {
  // per-world guard: one world's failure (RECORD appends to disk) costs that world one tick, never the
  // process or another world's frames
  for (const w of worlds.values()) {
    try {
    if (w.dirty.size === 0) continue;
    // t is the AUTHORITY's clock (spec/PHYSICS.md §5.1: max(last entry ts, wall)), never raw wall time: a log can run
    // ahead of the wall clock (physseeds SV1)
    const data = JSON.stringify({ type: "frame", seq: w.frameSeq++, t: authorityNow(w), poses: Object.fromEntries(w.dirty) });
    w.dirty.clear();
    if (RECORD) {
      if (!w.recPath) {
        w.recPath = join(WORLDS_DIR, w.name, `frames-${Date.now()}.jsonl`);
        console.log(`[world:${w.name}] ⏺ recording stage frames → ${w.recPath}`);
      }
      const roster = JSON.stringify([...w.clients].filter((c) => !c.spectator).map((c) => ({ id: c.id, avatar: c.avatar })));
      if (roster !== w.lastRoster) { w.lastRoster = roster; appendFileSync(w.recPath, `{"type":"roster","t":${Date.now()},"roster":${roster}}\n`); }
      appendFileSync(w.recPath, data + "\n");
    }
    for (const c of w.clients) {
      if ((c.ws.getBufferedAmount?.() ?? 0) > FRAME_SKIP_BUFFERED) continue; // stale frames die here, not in the kernel
      c.ws.send(data);
    }
    } catch (err) { console.error(`[world:${w.name}] frame tick`, err); }
  }
} });

// The heartbeat starts once every system is on it — the base is the finest
// cadence in the registry (stage frames); everything coarser rides it.
startTick(FRAME_MS);

// On the way out, everyone connected sleeps where they stand (every log line is already on disk: the authority appends
// and fsyncs each one before its request returns).
let shuttingDown = false;
// Windows has no SIGTERM: Ctrl+C, Ctrl+Break (SIGBREAK) and closing the console (SIGHUP) run this; taskkill /F can't be caught
// (the next boot then folds the whole log: correct, slower). SIGHUP is Windows-only: nohup's ignore stays on POSIX
for (const sig of ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? ["SIGBREAK", "SIGHUP"] : [])]) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    for (const w of worlds.values()) {
      // ws close handlers never run on exit: everyone connected sleeps where they stand, as on a normal leave
      for (const c of w.clients) {
        if (!c.spectator && !c.superseded && c.lastPose && c.actorId && !c.anonymous) w.rememberPose(c.actorId, c.lastPose);
      }
      w.log.checkpointSim();    // a sim checkpoint, so the next boot replays little into the engine (authority checkpointSim)
      w.log.saveStateCache();   // the fold cache, so the next boot folds only what comes after (server/statecache.ts)
    }
    process.exit(0);
  });
}

console.log(`eidoverse-worlds sequencer on http://${HOST}:${PORT}`);
console.log(`  library: ${LIBRARY_DIR}`);
console.log(`  worlds:  ${WORLDS_DIR}`);
{ const t = mintSetupToken(); if (t) console.log(`  ${setupLine(t)}`); }   // first run: the one place the token is printed (server/setup.ts)
if (TRUST_NAMES) console.log(`  ⚠ TRUST_NAMES=1: a typed name IS an account here (local:<name>). Private servers only: anyone who can reach ${HOST}:${PORT} can be anyone.`);
if (!JOIN_TOKEN) console.log("  ⚠ NO JOIN_TOKEN — the server is OPEN. Fine on a tailnet, wrong on a public box.");
// a fresh clone without the client's install step serves a client that never wakes (every module import 404s): say it
// where the operator looks
if (!existsSync(join(ROOT, "client", "node_modules", "three"))) {
  console.log("  ⚠ client/node_modules is MISSING — browsers will hang at the splash. Run: cd client && bun install");
}
if (!existsSync(join(LIBRARY_DIR, "eidoverse"))) {
  console.log(`  ⚠ no eidoverse-video library at ${LIBRARY_DIR} — avatars/sky/vegetation will be absent. Set EIDOVERSE_DIR.`);
}
