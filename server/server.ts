// eidoverse-worlds sequencer.
// The server is a sequencer and archivist, NOT a simulator:
//  - orders + persists per-world event logs (the authored plane)
//  - relays presence (the embodied plane, never persisted)
//  - serves the browser client and the eidoverse-video asset library
// No world manifest: everything about a world arrives through its log.

import { nameAtDoor } from "./names.ts";
import { existsSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// config FIRST — it carries the WORLDS_DIR mkdir, and auth.ts/moderation.ts
// carry their restore-at-boot blocks, so this import order IS the unsplit
// file's boot order: mkdir → session restore → ban restore (§15, step 7a).
import { TRUST_NAMES } from "./config.ts";
// how often a person may change the name they show (moderation: a name is how people recognise who did what)
const RENAME_COOLDOWN_MS = Math.max(0, Number(process.env.RENAME_COOLDOWN_DAYS ?? 7)) * 86400000;
import { PORT, HOST, JOIN_TOKEN, RENDERER_TOKEN, RECORD, ROOT, WORLDS_DIR, LIBRARY_DIR, OPT_DIR, MSG_RATE, FRAME_MS, FRAME_SKIP_BUFFERED, SNAP_TIMEOUT_MS } from "./config.ts";
import { type HnSession, agentTokens, aid1JoinIdentity } from "./auth.ts";
import { addrSanctionsFor, saveAddrSanctions } from "./moderation.ts";
import { entryFor, doorOfWorld, whoOf, settleAccess, sweepAccess, setLoadedWorlds, NOT_YET_CLOSE, type Expel } from "./access.ts";
import { isOperator } from "./operators.ts";
import { resolveLibFile } from "./libfile.ts";
import { summarizeGlb } from "./geometry.ts";
// The world itself (a log + the embodied plane) and the registry. The boot
// sweep below stays HERE: waking scripted worlds with the server is boot
// policy, not world mechanics.
import { World, type Client, worlds, getWorld, worldExists, wireSettledPose, wireRights, authorityNow } from "./world.ts";
import { isWorldSaved } from "./worldlog.ts";
import { oldWorldAt, bootNotice, noFoldRefusal } from "./oldworlds.ts";
import { custodyFileIn, directoryFileIn } from "./keyfiles.ts";
import { requestHandler, actorOf as actorIdOf, gagged, guestSanctionByAddress, requestAs } from "./requestwire.ts";
import { withoutOnceAnim } from "../shared/onceanim.js";
import { directoryFor, foldName } from "./directory.ts";
// The HTTP surface — one route table, /upload behind it in upload.ts (§15,
// 7c). fetch() below delegates; avatarRoster rides back for the join
// snapshot, pendingCaptures for the renderer's capture-result replies.
import { route, avatarRoster } from "./routes.ts";
import { snapshots } from "./snapshots.ts";
import { registerSystem, startTick } from "./tick.ts";
import { MESSAGES } from "./messages.ts";
import { LIMITS } from "./limits.ts";
import { defsFingerprint } from "./defs.ts";
// Seat profiles (#101, upstream; write-half ported §24r): the store, its
// external-change poll, the verdict lane on /avatars and the POST
// /seat-profile proposal door are all wired — routes.ts owns the HTTP half,
// seats.ts owns the one store instance and the update push. (The crash this
// import once healed: the poll timer auto-merged in while the declaration
// hunk fell on the fork side of a conflict — restart counter reached 15
// before anyone noticed, because /version kept answering from the brief
// up-windows.)
import { seatStore } from "./seats.ts";
import { announceProfileUpdate } from "./seats.ts";
import { OPT_DIR, PATCH_DIR } from "./config.ts";
// Relay-floor (#104): transport selection + durable voice-service identity.
import { relayEnabled, bootIncarnation, currentIncarnation, voiceTransport } from "./transport.ts";
import { installSfuTransportGuard } from "./sfuguard.ts";
import { onVoiceServiceChange, markVoiceDegraded, voiceServiceState } from "./sfusupervisor.ts";
import { isOwner } from "../shared/protocol/roles.js";
import { mintSfuCredential, setSfuConsent, setSfuModeratorMute, revokeSfuLeg, sfuDiag,
  sfuAcceptAnswer, sfuAcceptIce, sfuNegotiate, sfuSetPosition, registerSfuSender, admitSfuLeg, liveLegState, sfuLegAdmitted, markSfuLegAdmitted } from "./sfuadapter.ts";
// The resident-visible service chart (amendment 2): every voice-service
// transition reaches every client of every world, stamped with the
// incarnation so a client can tell "the relay restarted" from "it flapped".
// 🔴 The incarnation is DURABLE: an atomic tmp+rename file, so a restart
// strands every old credential structurally instead of resetting the counter
// to i1- (which sfuadapter.ts once did by passing a hardcoded null prev).
// Scratch sequencers keep their durable relay counter beside their own logs.
bootIncarnation(process.env.RELAY_STATE_DIR ?? OPT_DIR);

// 🔴 THE TRANSPORT GUARD IS INSTALLED HERE, ONCE, not as a side effect of
// constructing an Sfu (independent review 2026-08-16: a voice subsystem must
// not silently change process-wide crash semantics for a world server). It no
// longer exits either — a non-benign voice fault marks VOICE degraded and
// leaves text, presence and builds serving.
installSfuTransportGuard((err, kind) => markVoiceDegraded(`${kind}: ${String(err).slice(0, 120)}`));

// Amendment 2: voice service state is broadcast to every client of every world,
// stamped with the incarnation so a client can tell "the service restarted"
// from "it flapped". A restart advances the DURABLE incarnation, which is what
// makes every prior credential structurally stale — clients do one clean fresh
// join rather than resurrecting a leg the server has forgotten.
onVoiceServiceChange((state, incarnation, why) => {
  const msg = JSON.stringify({ type: "voice-service", state, incarnation, reason: why });
  for (const w of worlds.values()) for (const t of w.clients) t.ws.send(msg);
  console.log(`[sfu] voice-service ${state} (${incarnation})`);
});

// NOTE: there is no external service to probe, so there is no voice-service
// state machine and no leg-retired webhook. The in-process SFU cannot outlive
// or predecease the sequencer; retirement is driven directly by retireRelayLeg
// below, on the same close path every other surface uses.
/** Retire an identity's relay leg through the SAME funnel every other surface
 *  death uses: revoke at the relay, burn the credential, broadcast the
 *  transition. Fire-and-forget — a relay outage must never wedge a close. */
function retireRelayLeg(w: World, id: string) {
  if (!relayEnabled()) return;
  // 🔴 THE SFU PATH MUST RETIRE TOO. revokeSfuLeg was imported and never
  // called, so an SFU leg was NEVER retired on the live path: the old leg
  // lingered, its standingConsent survived, and a voice-leg reconnect INHERITED
  // a consent the fresh leg never gave. Fail-open on a privacy boundary.
  // Adapter tests missed it because they call revokeSfuLeg explicitly; only a
  // live-server probe reconnecting over real websockets could see it.
  const leg = revokeSfuLeg(w.name, id);
  if (leg) {
    const retire = JSON.stringify({ type: "surface-transition",
      id, surface: "voice-relay", gen: null, retired: leg.gen });
    for (const t of w.clients) t.ws.send(retire);
    console.log(`[world:${w.name}] ${id}/voice-relay revoked — gen ${leg.gen}`);
  }
}

/** A pose as it should be handed to SOMEONE ELSE — the settled result rather
 *  than whatever frame the body happened to be in.
 *
 *  Two callers, and they used to disagree, which was the bug (#61): the join
 *  snapshot's `restore` (your own body) went through rememberPose and came back
 *  normalized, while `present` (everyone else's bodies) shipped lastPose raw.
 *  So a resident mid-ragdoll looked fine to herself and arrived collapsed for
 *  every joiner — for weeks, with no way to tell from inside her own session.
 *
 *  - anim (played once, pose.anim): a moment, not a place. Replaying it at every wake
 *    would make a wave into a tic.
 *  - ragdoll: physics in flight, not an enacted pose. The get-up path only
 *    exists in the session that fell, so anyone receiving it is stuck with a
 *    body hung in tumble bones. Sleep standing.
 *  Held bones (pose.pose) survive both: an enacted pose is a place. */
function settledPose(pose: unknown): Record<string, unknown> | null {
  if (!pose) return null;
  // mic/hear are a live reading the sender re-sends every packet; remembered, they came back in `restore` and a
  // client replayed a voice state its new session never had (review 09-30 S2)
  // t/seq: a sample's capture time and count (spec/PHYSICS.md §5.1) belong to that one sample, never to a remembered body
  const { mic: _mic, hear: _hear, t: _t, seq: _seq, ...still } = withoutOnceAnim(pose as Record<string, unknown>);
  if (still.clip === "ragdoll") { still.clip = "idle"; delete still.pose; }
  return still;
}
// The log's rememberPose settles through this SAME function — one rule for
// both planes. world.ts takes it by injection because the source-text gates
// (§15.1: settled-pose-test regexes this file) pin the definition here.
wireSettledPose(settledPose);
// A role change re-sends everyone's rights.
// …and whoever may no longer be here (a closed door, an ended grant, a demotion in a world that admits only people
// listed) is removed (server/access.ts settleAccess, 4010), as upstream #258's settle pass did.
wireRights(
  (w) => { for (const c of w.clients) { try { c.ws.send(JSON.stringify({ type: "your-rights", rights: rightsFor(w, c) })); } catch { /* gone */ } }
    settleAccess(w, expel as Expel); },
);

// ------------------------------------------------------------------ presence

/** Remove a client from its world NOW — the kick/ban primitive, same shape as
 *  the identity-takeover block in `join`. All four bookkeeping steps or a ghost
 *  is left behind: world roster, global client map, the socket, and the leave
 *  broadcast (close(ws) will not fire it — the client is already unmapped).
 *  4006 is the "removed by moderation" close code; the browser client and
 *  WorldAgent both know not to auto-reconnect on it. */
// ---- surface-session retirement (#57, one implementation) ------------------
// Review finding 5/6: retirement existed as hand-rolled copies in the close
// handler, missing the OTHER death paths that exist today (expel via kick/ban,
// and travel — "leave A, join B" never runs A's close handler). Every listener
// keys hold-then-fallback TTS on voiceCapable, so any silent aux death costs
// the author the full performance window on every say until a re-snapshot.
// One broadcast + one reap, called from every path a session can die on.

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
  // the identity's RELAY leg dies with its primary, same funnel (#104 A1:
  // primary retirement revokes the media credential)
  retireRelayLeg(w, primary.id);
  for (const t of [...w.clients]) {
    if (t !== primary && t.id === primary.id && (t.surface ?? "world") !== "world") {
      retireAuxLeg(w, t, primary);
      snapshots.retire(t);
      w.clients.delete(t); clients.delete(t.ws);
      t.ws.close?.(4007, closeReason);
      console.log(`[world:${w.name}] ${primary.id}/${t.surface} reaped — ${closeReason}`);
    }
  }
}

function expel(w: World, target: Client, why: string, until?: number | null, code = 4006) {
  // `until`: when they may come back (a kick's cooldown, a timed ban); an agent host reconnects then instead of never.
  // `code`: 4006 removed by moderation; 4010 (access.ts ACCESS_CLOSE) this world is no longer open to you — neither is redialled
  try { target.ws.send(JSON.stringify({ type: "error", error: why, ...(until ? { until } : {}) })); } catch { /* going anyway */ }
  const wasEmbodied = !target.spectator;
  snapshots.retire(target);
  // an expelled AUX leg announces its own death; an expelled PRIMARY takes
  // its aux legs with it (kick/ban target the identity, not one socket) —
  // review finding 5: expel unmapped + superseded the target, so the close
  // handler's copy could never fire and the legs died silently
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

// One clock drives every world's script timers. This is what makes a
// behavior keep behaving with NOBODY connected — the ferry runs, the
// lighthouse blinks, the greeter is ready — which is the point of scripts
// living server-side rather than in any client.
// Countersign has no HTTP path (an accepted profile is operator provenance,
// #101 B4) — tools/seat-accept.ts edits the store from another process, and
// the running server notices here: reload, diff, and push the same
// generation-bearing event a proposal gets. Late profile arrival is
// event-driven for every consumer, not wishful polling.
// World access expiry (access.ts): warn five minutes out, then the authority writes each passed `until` into the log
// (expire-roles) and whoever lost entry with it is removed. Every second: between `until` and the sweep the grant still
// stands (it ends when its end is written, so a replay agrees).
setLoadedWorlds(() => worlds);
registerSystem({ name: "access-sweep", everyMs: Math.max(250, Number(process.env.ACCESS_SWEEP_MS ?? 1000)),
  fn: (now) => sweepAccess(worlds.values(), expel as Expel, now) });

registerSystem({ name: "seat-store-poll", everyMs: 5000, fn: () => {
  const ext = seatStore.pollExternalChange();
  if (!ext) return;
  for (const ch of ext.changed) {
    const notified = announceProfileUpdate(ch.name, ch.pose, ext.rev);
    console.log(`[seats] external change ${ch.name}/${ch.pose} rev ${ext.rev} → ${notified} client(s)`);
  }
} });

// The engine's heartbeat: every world's sim advances and its rests log on this cadence, not inside whoever's request
// comes next (DESIGN-physics-responsiveness §1). FRAME_MS is the finest beat the scheduler has; the pass is bounded by
// engine ticks, so a stall catches up over several beats.
registerSystem({ name: "physics", everyMs: FRAME_MS, fn: () => {
  for (const w of worlds.values()) { try { w.log?.settle(); } catch (err) { console.error(`[world:${w.name}] physics settle`, err); } }
} });
registerSystem({ name: "behaviors", everyMs: 1000, fn: (now) => {
  for (const w of worlds.values()) {
    try { w.scripts.tick(now); } catch (err) { console.error(`[world:${w.name}] behavior tick`, err); }
  }
} });

// Def hot-reload (charter §3): a def edited on disk reaches every LIVE
// client — the watch fingerprints defs/ once a second and pushes one
// `defs-updated` when it moves; clients re-fetch /defs and regrow what the
// changed content shapes. The first fingerprint is the baseline, not a change.
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

// Boot: the worlds dir's shared key files under their current names (a dir saved before the 2026-10-07 names pass has
// them renamed once, server/keyfiles.ts), before any world or join reads them.
try { custodyFileIn(WORLDS_DIR); directoryFileIn(WORLDS_DIR); } catch (err) { console.error("[boot] key files", err); }

// Boot sweep: worlds load lazily on first touch, but a world with scripts
// must wake WITH the server, not with its first visitor — otherwise a
// restart leaves every timer dark until someone happens to sail past. Cheap
// peek before paying for a real load: a byte-scan of the log for a script
// component. (A world whose scripts were all since removed may load once for
// nothing — harmless.)
try {
  let woken = 0;
  for (const name of readdirSync(WORLDS_DIR)) {
    try {
      if (!/^[a-z0-9_-]{1,64}$/i.test(name) || !isWorldSaved(name)) continue;
      if (readFileSync(join(WORLDS_DIR, name, "world.jsonl"), "utf8").includes('"script:')) { getWorld(name); woken++; }
    } catch (err) { console.error(`[boot] world ${name} peek failed`, err); }
  }
  if (woken) console.log(`[boot] ${woken} scripted world(s) woken — their scripts run without visitors`);
} catch (err) { console.error("[boot] world sweep failed", err); }
// Old-format worlds are not served, and the operator is TOLD (they were skipped in silence above): one block per world with
// the translator's command, this WORLDS_DIR filled in (server/oldworlds.ts).
try { const notice = bootNotice(WORLDS_DIR); if (notice) console.log(notice); } catch (err) { console.error("[boot] old-world notice failed", err); }

let nextClientNum = 1;
const clients = new Map<unknown, Client>();
snapshots.setClients(() => clients.values());   // roaming renderers are found across worlds
// …and sent only where they will be let in (a roamer with the renderers' credential goes anywhere — access.ts)
snapshots.setAdmission((w, c) => entryFor(doorOfWorld(w), whoOf(c), "watch") === null);
snapshots.setFrameTimeout(SNAP_TIMEOUT_MS);   // config.ts SNAP_TIMEOUT_SEC
// #57 B2: transport-epoch source. Global (not per-world) so a generation number
// never collides across worlds or after a world reload; never persisted — an
// epoch outliving the process would defeat its purpose.
let GEN = 0;
// The sender lifetime presence consumers scope a speaker's utterance counter
// by (`session` on arrive and snapshot.present): the joining page's own id,
// which outlives a reconnect as its counter does, else a fresh token for this
// leg. Opaque and observational: authority still uses the credential and leg
// checks, and nothing here reveals the process's connection count.
const PAGE_SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const presenceSession = (c: Client) => (c.presenceSession ??= crypto.randomUUID());

/** The placeholder tier's bbox side-channel, sent AFTER the snapshot as its
 *  own message: summaries are async, and the join handler's synchronous
 *  ordering is a guarantee (an awaited join would let the same client's
 *  next messages interleave — the exact hazard the client's fold just
 *  finished escaping). geometry.ts caches per lib+mtime, so the steady
 *  state is microtasks and the message lands a beat after the snapshot,
 *  long before any GLB. */
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

// ---- join, split (R2, survey §2.3) -----------------------------------------
// The 321-line case held its central invariant — "ADMISSION BEFORE
// TAKEOVER: every check that can refuse this join runs before the takeover
// kick" (review finding 2) — by comment and vigilance across straight-line
// code. It is STRUCTURAL now: admitJoin can only answer and refuse (it
// never touches the roster; the one c.world assignment predates the aux
// checks exactly as the unsplit case had it), installJoin is the only
// place a join mutates the roster, and buildSnapshot is a pure read that
// can finally be exercised without a live socket. Bodies moved verbatim;
// refusal `return`s became `return null`.

/** A join's declared status (PROTOCOL §6a): one short lowercase word of its own ("agent", "ai", …; up to 32 characters — its own grammar, not a role id), else undeclared (null). */
function declarationOf(v: unknown): string | null {
  return typeof v === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(v) ? v : null;
}
function admitJoin(c: Client, ws: { send(d: string): void; close(code?: number, reason?: string): void }, msg: any, auth: HnSession | null): World | null {
    // A malformed world name is a bad LINK, not a bad actor — refuse it
    // with an explanation and a close code the client knows not to retry
    // (retrying a name that can never exist is just a polite DoS).
    const wname = String(msg.world ?? "commons");
    if (auth?.nativeWorld && auth.nativeWorld !== "*" && wname !== auth.nativeWorld) {
      ws.send(JSON.stringify({ type: "error", error: "this native session is limited to its approved world; sign in again for multi-world access" }));
      ws.close(4003, "native session world restriction");
      return null;
    }
    if (!/^[a-z0-9_-]{1,64}$/i.test(wname)) {
      ws.send(JSON.stringify({ type: "error", error: `"${wname}" is not a world name — check the link that brought you here` }));
      c.ws.close?.(4005, "bad world name");
      return null;
    }
    // Joining never FOUNDS a world (security review 10-06 H3; RFC-005 §3.2.7 "founding is not joining"): a name with no
    // world behind it is refused, and only a world is served (the old protocol has no runtime here: an old log is
    // translated once, by the operator, into a new world).
    if (worldExists(wname) && !isWorldSaved(wname)) {   // a world saved in an old format: it is translated once, by the operator
      // (server/oldworlds.ts: a first-protocol log.jsonl is translatable; a log saved before the 2026-10-07 names pass is
      // re-translated from its original log, or refounded). The visitor is told in plain words that nothing is lost and
      // who converts it; the command line is the operator's, in the boot notice. A directory holding no old log at all
      // (an empty one) is no world: it is refused as one.
      const old = oldWorldAt(WORLDS_DIR, wname);
      ws.send(JSON.stringify({ type: "error", error: old ? old.visitor : `there's no world called "${wname}" here — check the link that brought you here` }));
      c.ws.close?.(4005, old ? "old-format world" : "no such world");
      return null;
    }
    if (!worldExists(wname)) {
      // nothing to watch YET is not a refusal (upstream #258: 4011, redialled): an observer started before the world is
      // founded gets in once someone founds it. A body is refused as before (joining never founds).
      if (msg.spectate || msg.renderer) {
        ws.send(JSON.stringify({ type: "error", error: `there's no world called "${wname}" yet — nothing to watch` }));
        c.ws.close?.(NOT_YET_CLOSE, "no such world yet");
        return null;
      }
      ws.send(JSON.stringify({ type: "error", error: `there's no world called "${wname}" here — check the link that brought you here` }));
      c.ws.close?.(4005, "no such world");
      return null;
    }
    const w = getWorld(wname);
    // C1 (security review 10-06): what this join proves is decided from THIS join's own credentials. Nothing a previous
    // join on this socket proved carries over (a token presented once used to make every later join on the socket
    // "verified", so a second join could wear any agent's name).
    c.tokenVerified = false; c.auxBound = false; c.actorId = undefined;
    // Identity: a verified session OWNS the id — the client's msg.id is
    // ignored (the name came from Discord via the home node, and the
    // sub underneath it survives renames).
    c.id = (auth ? auth.name : String(msg.id ?? c.id)).slice(0, LIMITS.ID_LEN);
    // Actor names are the log's ink — refuse the ones that forge system
    // or script authorship ("world" authors grants; "script:*" authors
    // script effects; the behavior loop-guard trusts that prefix), and
    // strip control characters that would corrupt every future reader.
    // (Hesperus finding #3: an unauthenticated join as "world" produced
    // entries indistinguishable from the sequencer's own.)
    c.id = c.id.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    // M3: format characters (zero-width, bidi overrides) and compatibility forms are how one name passes for another
    c.id = c.id.normalize("NFKC").replace(/\p{Cf}/gu, "").trim();
    // security pass 3 (H1): no markup characters in a name — a typed one is refused in words, one the identity service
    // gave becomes a look-alike (‹ › ″; server/names.ts)
    {
      const n = nameAtDoor(c.id, { typed: !auth });
      if (n.refused) {
        ws.send(JSON.stringify({ type: "error", error: n.refused }));
        ws.close(4004, "name has markup");
        return null;
      }
      c.id = n.name;
    }
    // H2: an identity is never a name — a name shaped like one (u-…) would pass for the person who wears it
    if (!c.id || /^(world|\*|system|sim)$/i.test(c.id) || /^script:/i.test(c.id) || /^u-[a-z2-7]{20}$/i.test(c.id)) {
      ws.send(JSON.stringify({ type: "error", error: `that name is reserved for the world itself` }));
      ws.close(4004, "reserved name");
      return null;
    }
    {
    // a bare NAME resolves server-side against the same roster the
    // snapshot carries — the client no longer round-trips /avatars
    // before joining, and everyone else still sees the right body
    const a = String(msg.avatar ?? "");
    c.avatar = !a ? "eidoverse/assets/vrms/claude.vrm"
      : a.includes("/") ? a
      : (avatarRoster().find((r) => r.name === a)?.path ?? "eidoverse/assets/vrms/claude.vrm");
  }
    // Surface: which leg of this identity is arriving. Sanitized like a
    // world name; unknown values are allowed (the vocabulary belongs to
    // clients), but "world" alone gets a body.
    // A surface that sanitizes to EMPTY is refused, never defaulted
    // (review finding 4): "world" is the one value with takeover power
    // over the body, so promoting a malformed aux surface to it lets a
    // malfunctioning sidecar kick its own user's embodied session — and
    // skip every aux-only admission gate on the way in.
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
    // the joining page's own id (#234/#217: a page's typing and attention follow its own session), relayed as `session`
    if (typeof msg.session === "string" && PAGE_SESSION_RE.test(msg.session)) c.presenceSession = msg.session;
    c.renderer = Boolean(msg.renderer);
    c.roam = c.renderer && Boolean(msg.roam);
    // re-derived on every join, like the rest of identity: the renderers' own
    // credential, presented WITH the renderer flag on this very join
    c.trustedRenderer = c.renderer && Boolean(RENDERER_TOKEN) && String(msg.token ?? "") === RENDERER_TOKEN;
    snapshots.configure(c, msg.capture);
    if (c.renderer) c.spectator = true; // renderers are invisible by definition
    // ---- who this join is: an ACCOUNT, proven by this join's credential (C1/C2) ----
    //   a verified session → its sub ("human:discord:…");
    //   an enrolled agent's bearer (mcpl/tokens.json) → "agent:token:<id>", and its name is that enrolment's id;
    //   a home-node aid1 credential of KIND agent → the enrolment that lists its subject, else "aid1:<iss>:<sub>";
    //   a private TRUST_NAMES door → "local:<typed name>"; otherwise none: anonymous.
    // A name reserved by an enrolment is claimable only with that enrolment's own proof. Never by a slug of a name.
    {
      const at = agentTokens();
      const tokStr = String(msg.agentToken ?? "");
      let account: string | null = auth && c.sub ? c.sub : null;
      let agentName: string | null = null;
      const enrolled = at.byToken.get(tokStr);
      if (enrolled) { account = `agent:token:${enrolled.toLowerCase()}`; agentName = enrolled; }
      else if (tokStr) {
        const a = aid1JoinIdentity(tokStr);
        if (!a || a.payload.kind !== "agent") {
          ws.send(JSON.stringify({ type: "error", error: a ? "that credential isn't an agent's — sign in as yourself instead" : "that agent credential didn't verify" }));
          c.ws.close?.(4004, "bad agent credential");
          return null;
        }
        const viaEnrolment = at.bySub.get(a.payload.sub);
        account = viaEnrolment ? `agent:token:${viaEnrolment.toLowerCase()}` : `aid1:${a.payload.iss}:${a.payload.sub}`;
        agentName = viaEnrolment ?? a.slug;
      }
      if (agentName) { c.id = nameAtDoor(agentName.slice(0, LIMITS.ID_LEN), { typed: false }).name; c.tokenVerified = true; }   // an aid1 slug is the credential issuer's: no markup in it either. The credential proves WHO (the enrolment, the reserved name), never what kind: §6a
      // a reserved name is matched FOLDED (foldName: case, spaces, punctuation), as display collisions are — "Hes perus" and
      // "hesperus." are the enrolled name too (security review 10-18 L11); the enrolment's own proof is the only way to wear it
      const reservedAs = [...at.names].find((n) => foldName(n) === foldName(c.id)) ?? null;
      if (reservedAs && account !== `agent:token:${reservedAs}`) {
        console.log(`[perm] join refused: "${c.id}" is a reserved agent name (no proof of that enrolment)`);
        ws.send(JSON.stringify({ type: "error", error: `"${c.id}" is a reserved agent name` }));
        c.ws.close?.(4004, "reserved name");
        return null;
      }
      // a private door: the account is the one the client keeps (msg.account), else the typed name — so a person can show a
      // new name and stay who they are (R 10-11). Typed, so the door's markup rule holds for it too.
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
    // A display name is not proof of anything, so two people may never show the same one at once, and an anonymous
    // visitor may not wear a name an account has claimed here (H1/M3: typing someone's name to stand in for them).
    // RENAME COOLDOWN (R 10-11: "you can only rename yourself every so often (moderation reasons)"): a typed name that
    // differs from the one this account wore is a rename; inside the cooldown the old name stands and the client is told
    // when it may change. A case change is free; a sign-in's name (Discord's) is the provider's, not counted here.
    c.renamed = false; c.renameRefused = undefined;
    // The newcomer is the one renamed; an anonymous one is marked as a guest. The collision pass runs FIRST, so the
    // cooldown below judges the name the person will actually wear (STRIKES P-S2-5: judged on the typed name, then
    // suffixed, then stamped, it trapped someone under a name they never asked for).
    const typed = c.id;
    if (!c.spectator) {
      const dir = directoryFor(WORLDS_DIR);
      const taken = (n: string) => [...w.clients].some((o) => o !== c && !o.spectator && foldName(o.id) === foldName(n) && (!c.account || o.account !== c.account))   // two guests are never one account (review of #260, server I10)
        || (!!c.anonymous && dir.claimedName(n))
        || (!!c.account && dir.claimedByOther(n, c.account));   // H2 (pass 3): nor an account under another account's name, here or not
      if (taken(c.id)) {
        const base = c.anonymous ? `${c.id} (guest)` : `${c.id}-${(c.account ?? "").replace(/[^a-z0-9]/gi, "").slice(-4) || "2"}`;
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
    // A world's actor is an OPAQUE id from the authority's directory (server/directory.ts, never logged), reached only
    // through an account; one per account across the authority's worlds; anonymous ids live in memory only (M2). Typing someone's name
    // never yields their id, so it never yields their role.
    // a spectator skips the name checks above (it shows no name), so it mustn't record one either: its account keeps the
    // name it has, and a first sight takes the typed name only if no other account wears it (review of #260, server I42)
    { const dir = directoryFor(WORLDS_DIR);
      const kept = c.spectator && c.account ? dir.idOfSub(c.account) : null;
      c.actorId = kept ?? dir.resolve({ sub: c.account ?? null,
        name: c.spectator && c.account ? dir.spectatorName(c.id, c.account, LIMITS.ID_LEN) : c.id }); }
    if (c.renamed && c.actorId) directoryFor(WORLDS_DIR).markRenamed(c.actorId);
    // ENTRY — checked once identity is SETTLED (account, actor id, reserved names all resolved above), before the body
    // enters. One decision, server/access.ts entryFor, the same one every other door asks (a listing, an HTTP read, the
    // settle after a role change): bans first (a global ban closes every door, a world's ban this one; watching counts —
    // a ban is exclusion, not just silencing), a kick's cooldown, then the world's own @world.access (who may come in
    // with a body; watch: anyone lets the rest spectate), account age, and capacity for a body. Operators, owners and
    // holders of a moderation power always get in — an operator can never be locked out, which is also the unban path
    // of last resort.
    {
      const here = [...w.clients].filter((o) => !o.spectator && (o.surface ?? "world") === "world" && o.actorId !== c.actorId).length;
      const r = entryFor(doorOfWorld(w), whoOf(c), c.spectator ? "watch" : "embody", { here });
      if (r) {
        console.log(`[world:${w.name}] join refused: ${c.id} — ${r.reason}`);
        ws.send(JSON.stringify({ type: "error", error: r.why, ...(r.until ? { until: r.until } : {}) }));
        // "full" is its own close reason: it is transient (someone leaves), so a client waits and tries again rather than
        // showing it as the answer (review r3 F6); the other refusals won't change by retrying
        c.ws.close?.(r.code, r.reason === "full" ? "full" : r.reason === "banned" ? "banned" : r.reason === "kicked" ? "kicked" : "no access");
        return null;
      }
    }
    if (w.log && c.actorId && !isOperator(c.account)) {
      // a guest is a fresh identity per connection: a mute a guest was given here is also filed against their
      // hashed address (moderation.ts), and every new guest from that address is given it too, written to the moderator
      // log as the moderator's own act on the new identity (so it shows, applies and lifts like any other) (R 10-07)
      if (c.anonymous && c.addr && !c.spectator && (c.surface ?? "world") === "world") {
        let carried = 0;
        for (const s of addrSanctionsFor(w.name, c.addr)) {
          if (s.kind !== "mute" || w.log.mutedHere(c.actorId)) continue;   // a guest ghost stored before 10-20 is ignored: ghost is gone
          w.log.live.appendMod({ actor: s.actor, verb: s.kind, who: c.actorId, ...(s.kind === "mute" ? { channels: s.channels ?? ["voice", "chat"] } : {}), until: s.until, ...(s.reason ? { reason: s.reason } : {}), carried: "address" });
          if (!s.ids.includes(c.actorId)) s.ids.push(c.actorId); carried++;
        }
        if (carried) { saveAddrSanctions(); console.log(`[world:${w.name}] a guest's ${carried} sanction(s) carried to ${c.id} by address`); }
      }
    }
    c.world = w;
    // ADMISSION BEFORE TAKEOVER (review finding 2): every check that can
    // refuse this join runs before the takeover kick. The old order let
    // a join that would be refused (no credential, orphan) first destroy
    // the genuine leg it duels — an unauthenticated voice-leg kill, with
    // no retirement broadcast from any path (the kicked leg is unmapped
    // and superseded, so its close handler no-ops; the refused join
    // never reaches the join-time transition). Only a join that WILL be
    // accepted may retire anyone. (The aux cap alone stays after the
    // kick, because takeover-replaces means the predecessor it removes
    // must not count against its successor.)
    if (c.surface !== "world") {
      // An aux leg without a living primary is an orphan mic: refuse it.
      const primary = [...w.clients].find(t => t !== c && t.id === c.id && (t.surface ?? "world") === "world" && !t.spectator);
      if (!primary) {
        ws.send(JSON.stringify({ type: "error", error: `no embodied "${c.id}" here to attach a ${c.surface} leg to — join the world first` }));
        ws.close(4008, "aux without primary");
        // (c is not yet in w.clients here — add happens after these
        // checks — so only the global map needs cleaning. A w.clients
        // delete would be a no-op that misreads as "joiner counted".)
        clients.delete(ws);
        return null;
      }
      // B1 (#57 review): an aux leg binds to the PRIMARY'S IDENTITY
      // AUTHORITY, or it does not attach. Same-display-name existence is
      // presence, not authority: without this check, anyone could join
      // surface:"voice" under an unreserved human's name — every
      // listener marks that person voiceCapable (adding hold latency to
      // each of their says) and RTC packets go out stamped as them.
      // Impersonation and denial in one seam. The binding, per review:
      //   · reserved agents: this leg presented the agent's own bearer
      //     (tokenVerified — same rule attest already uses);
      //   · authenticated humans: this leg's verified session subject
      //     equals the PRIMARY's (same person, proven, not asserted);
      //   · self-asserted primary with no bindable credential: REFUSE.
      //     Guessing would bless exactly the impostor this exists to
      //     stop; the primary can log in and rejoin to earn aux legs.
      // an aux leg binds by ACCOUNT: the same proven account as its primary (a token-verified agent, or the same login)
      const auxBound = !!c.account && c.account === primary.account;
      // Remember the binding so the attest gate (B3) admits the SAME
      // identity authority B1 does — a sub-bound human's voice leg, not
      // only a token-verified agent leg (Opus-5 review: gating attest on
      // tokenVerified alone silently barred a logged-in human's own voice
      // leg, holding then double-speaking every say they voiced).
      if (auxBound) c.auxBound = true;
      if (!auxBound) {
        console.log(`[world:${w.name}] aux refused: "${c.id}"/${c.surface} has no binding to the primary's identity authority`);
        ws.send(JSON.stringify({ type: "error", error: `a ${c.surface} leg for "${c.id}" must present that identity's credential (agent bearer, or the primary's own login)` }));
        ws.close(4009, "unbindable aux");
        clients.delete(ws);
        return null;
      }
      // B3 (#57): bounded legs per identity — takeover replaces, it does
      // not stack, so 4 DISTINCT surfaces is generous; more is a leak or
      // an attack, and either wants a refusal, not a collection. Counted
      // here — before the takeover kick, like every admission gate — but
      // EXCLUDING any same-surface predecessor: that leg would be
      // replaced, not stacked, so it must not count against its own
      // successor (and a cap refusal must never have kicked it first).
      const auxCount = [...w.clients].filter(t => t !== c && t.id === c.id
        && (t.surface ?? "world") !== "world" && t.surface !== c.surface).length;
      if (auxCount >= LIMITS.AUX_LEGS) {
        ws.send(JSON.stringify({ type: "error", error: "too many auxiliary legs for this identity" }));
        ws.close(4008, "aux cap");
        // (c is not yet in w.clients here — add happens after these
        // checks — so only the global map needs cleaning. A w.clients
        // delete would be a no-op that misreads as "joiner counted".)
        clients.delete(ws);
        return null;
      }
    }
  return w;
}

function installJoin(c: Client, w: World) {
    // identity takeover: ONE body per id per world — a stale session
    // (half-open socket, zombie reconnect) is kicked when its identity
    // reconnects, instead of the two rubberbanding over one avatar.
    // No leave broadcast: the identity isn't leaving, it's re-arriving.
    // Takeover is PER (id, surface): a fresh world session kicks only the
    // stale world session; a fresh voice leg kicks only the stale voice
    // leg. Plain spectators (surface "world" + spectate flag) never duel.
    let retiredGen: number | undefined;
    if (!(c.spectator && c.surface === "world")) {
      for (const other of [...w.clients]) {
        // a takeover is the SAME ACCOUNT re-arriving (H1): a typed name never kicks anyone, and anonymous sessions
        // never take over (each is its own guest)
        // …and the same account under a NEW name is a takeover too (R 10-10 18:13, "Body not in the world yet. I just changed
        // my name": the renamed connection wasn't superseded, so its old socket's close departed the body under her feet)
        if (other !== c && !!c.account && other.account === c.account
            && (other.surface ?? "world") === c.surface
            && !(other.spectator && (other.surface ?? "world") === "world")) {
          other.superseded = true;
          snapshots.retire(other);
          retiredGen = other.gen;
          w.clients.delete(other);
          clients.delete(other.ws);
          other.ws.close?.(4002, "session takeover");
          console.log(`[world:${w.name}] ${c.id}/${c.surface} takeover — gen ${other.gen} retired`);
          // a WORLD-surface takeover retires the identity's relay leg:
          // its credential is bound to the retired primaryGen, and the
          // successor mints fresh (#104 amendment 1 — takeover→rotate;
          // measured target: old leg's packets refused ≤2s)
          // the leg is the PREDECESSOR's, under its own id: a successor that arrived under a new name has none yet
          // (review of #260, server I12)
          if ((c.surface ?? "world") === "world" && !other.spectator) retireRelayLeg(w, other.id);
          // …and under a new name, the old name's avatar leaves everyone's view: the superseded close says nothing, and
          // the successor arrives under its own name (review of #260, server I47)
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
    // a body arriving with an agent's enrolment (its credential, never a declaration: §6a) where no renderer serves: send a
    // roaming renderer now, so its first snapshot finds the world loaded (server/snapshots.ts prewarm; a no-op when one
    // already serves or none roams)
    if (c.tokenVerified && !c.spectator) snapshots.prewarm(w);
    // B4 (#57): a same-surface takeover must be VISIBLE to subscribers —
    // the lab found a listener bound to a dead voice leg until page
    // reload. This event is the no-reload path: "retire the old peer,
    // negotiate the current generation." Aux surfaces only: a world-body
    // takeover already re-arrives through presence.
    // Broadcast on EVERY aux join, not only takeovers (retired: null on a
    // first join): listeners key their hold-then-fallback TTS on "does
    // the author have a live voice leg", and a leg that joins after
    // their snapshot would otherwise be invisible — stale capability in
    // the exact direction that causes double-speak.
    if (c.surface && c.surface !== "world") {
      const transition = JSON.stringify({ type: "surface-transition",
        id: c.id, surface: c.surface, gen: c.gen, retired: retiredGen ?? null });
      for (const t of w.clients) if (t !== c) t.ws.send(transition);
    }
    // (a world's owner is named when it is FOUNDED — tools/protocol/world.ts found, or the translator — never by being first in)
}

/** What a client is told it may do: the role the authority gives it (the authority admits every write), and the body and spend
 *  permissions its role record carries (@world roles:<id>, else the world's default-role; a guest never wears the
 *  default). `open` = the world has no owner. */
function rightsFor(w: World, c: Client) {
  // research roles S4: rights come from the authority alone ({role, rank, permissions}, by identity); gen and fly stay as the
  // client's flags, read off the permissions. An operator (WORLD_ADMIN, by account) flies and spends everywhere, as before.
  const op = isOperator(c.account);
  const wc = (w.log.live.state().entities?.["@world"]?.c ?? {}) as Record<string, any>;
  const open = !Object.entries(wc).some(([k, v]) => k.startsWith("roles:") && isOwner(v));
  if (!c.actorId) return { role: "inhabitant", roleName: "Inhabitant", rank: 0, permissions: [] as string[], gen: op, fly: op, open };
  const e = w.log.rightsOf(c.actorId); const m = w.log.mutedHere(c.actorId);
  return { role: e.role, roleName: e.name, rank: e.rank, permissions: e.permissions, ...(c.anonymous ? { guest: true } : {}), gen: op || e.permissions.includes("generate"), fly: op || e.permissions.includes("fly"), open,
    ...(m ? { muted: { channels: m.channels, until: m.until } } : {}) };
}
/** Does this identity hold a power that lets it in past access rules (research: moderators and owners bypass max)? */

/** The sanctions sweep (research roles S4): every couple of seconds, and right after a moderation act, make
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
  const S = w.log.sanctions();   // one pass over the moderator log per world per sweep (review 10-07: it was one per client)
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
  try { w.regateReaches(); } catch (err) { console.error(`[world:${w.name}] re-gating reaches`, err); } } } });   // a timed allow ends with no request (review of #260)

function buildSnapshot(w: World, c: Client) {
    // snapshot = the authority's cut of the world (the joiner folds it, then the log stream) + who's present now
    return {
      type: "snapshot",
      // (no renderSceneVersion: upstream #248's render-scene projection isn't served here — server/render-scene.ts reads the
      // first protocol's fold — so a native client isn't told to ask for it)
      world: w.name,
      you: c.id,
      // when this account may next change its name (and the name it just tried, if that was too soon)
      ...(c.account && !c.tokenVerified ? { renameAfter: (directoryFor(WORLDS_DIR).entry(c.actorId ?? "")?.renamedAt ?? 0) + RENAME_COOLDOWN_MS, renameCooldownDays: RENAME_COOLDOWN_MS / 86400000 } : {}),
      ...(c.renameRefused ? { renameRefused: c.renameRefused } : {}),
      // your durable subject, when the authority vouched for one
      ...(c.sub ? { yourSub: c.sub } : {}),
      gen: c.gen,   // your surfaceSession — echo it in attestations
      // your OWN live aux legs — people[] excludes self, and a page that
      // reconnects while its voice leg lives must still hold-then-fallback
      // its own says rather than double-speak next to its own voice.
      yourSurfaces: [...w.clients]
        .filter(x => x !== c && x.id === c.id && (x.surface ?? "world") !== "world")
        .map(x => ({ surface: x.surface, gen: x.gen })),
      recording: RECORD,
      // the world: the authority's cut (its fold, head, your undoable acts, names, holds), which the joiner folds and then
      // advances with the `log` stream. A joiner's cost is the size of the WORLD, not the length of its history.
      cut: { ...w.log.info(), ...w.log.clientCut(actorIdOf(c)) },
      // chat isn't world state, and speech is arrival-only (R 10-18): a joiner is sent no line said before it came, so the
      // window is always empty. chatTotal is how many lines a history page could still show this joiner: for an admin
      // (owner, operator) every line the master log holds; for everyone else none
      state: { recentChat: [], chatTotal: w.isAdmin(c) ? (w.state.chatTotal ?? 0) : 0 },
      throughSeq: w.log.snapSeq,
      // the body roster rides along — a joiner resolves names with no
      // extra round-trip (bbox geometry follows as its own message)
      avatars: avatarRoster(),
      // what YOU may do here, as of now (a role change re-sends it: your-rights)
      yourRights: rightsFor(w, c),
      // wake where you fell asleep — the world's memory of your body
      restore: c.spectator || !c.actorId ? null : (w.poses[c.actorId] ?? null),   // by identity: a name is anyone's to wear
      present: [...w.clients].filter(o => o !== c && !o.spectator).map(o => ({
        // settledPose, not lastPose: a joiner must not inherit someone
        // else's mid-ragdoll frame (#61). Same normalization `restore`
        // above already gets via rememberPose.
        id: o.id, avatar: o.avatar, pose: settledPose(o.lastPose), ...(o.declares ? { declares: o.declares } : {}), session: presenceSession(o),   // §6a: relayed as declared; absent = undeclared
        // a world: the identity the log and roles know them by (granting a role names this id, never a name)
        ...(o.actorId ? { actorId: o.actorId } : {}),
        ...(w.log && o.anonymous ? { guest: true } : {}),   // no account: the people list's 'guest' badge (research roles S6)
        // #57 matrix 7: which aux legs this identity has live NOW —
        // inspectable surface summary on the one roster, never a second body
        surfaces: [...w.clients]
          .filter(x => x.id === o.id && (x.surface ?? "world") !== "world")
          .map(x => ({ surface: x.surface, gen: x.gen })),
      })),
    };
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  // Bun closes a connection after 10s with no bytes moving (its default
  // idleTimeout) — and that includes a response mid-stream. Over a relayed or
  // transcontinental link a big download (a VRM, an unoptimized library glb)
  // routinely stalls longer than that, so the transfer was cut short and the
  // client saw a truncated body. 255s is Bun's maximum: a stalled transfer
  // rides it out, and an HTTP connection that stays silent is still closed
  // after 255s (by this same timer; TCP alone would take far longer to
  // notice). A WebSocket has its own idle timer, websocket.idleTimeout, which
  // the websocket block below leaves at Bun's default of 120s.
  idleTimeout: 255,
  async fetch(req, srv) {
    // The whole HTTP surface is routes.ts's table (§15, 7c) — one row per
    // endpoint, first match wins, in exactly the order the if-chain had.
    // /ws upgrades inside its row: a successful upgrade returns no Response,
    // same contract as before.
    return route(req, srv);
  },
  websocket: {
    maxPayloadLength: LIMITS.WS_MESSAGE_BYTES,
    // House rule 3 applies to EVERY ws callback, not just message: an
    // uncaught throw out of open/close exits the process the same way (the
    // 4f82250 crash loop), and close reaches disk (a departure's drop → the authority,
    // rememberPose → write+rename) — an EIO/ENOSPC there must be a log line,
    // never an exit.
    open(ws) {
      try {
        const c: Client = { id: `anon-${nextClientNum++}`, ws, world: null, avatar: "", lastPose: null, spectator: false,
          msgWin: 0, msgCount: 0 };
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
        snapshots.retire(c);
        clients.delete(ws);
        // dev crash forensics (?bc=1 clients): the last thing a dying renderer
        // was doing, printed at the only moment we learn it died
        if (c.bcRing?.length) {
          console.log(`[bc] ${c.id} last breadcrumbs: ${c.bcRing.join(" | ")}`);
        }
        if (c.world) {
          c.world.clients.delete(c);
          // AUX LEG DEATH IS AN EVENT (r-review): aux legs ride the spectator
          // path, so their close used to broadcast NOTHING — voiceCapable on
          // every other client kept the dead leg's gen forever, and each say
          // from that actor waited the full performance window against a leg
          // that could never perform. Retirement carries the dying gen so a
          // client that already saw a successor's transition (out-of-order
          // delivery) knows to ignore it. Not on takeover (`superseded`): the
          // join-time transition already announced the successor. retireAuxLeg
          // owns the "only an ACCEPTED leg was ever a session" rule (a refused
          // impostor must leave zero trace — the B1 impostor vector).
          if (!c.superseded) retireAuxLeg(c.world, c);
          if (!c.spectator) {
            if (!c.superseded) {
              try { if (c.actorId && !c.anonymous) c.world.rememberPose(c.actorId, c.lastPose); } // sleep where you stood (by identity; a guest's id is new each visit)
              catch (err) { console.error(`[world:${c.world.name}] rememberPose for ${c.id} on close`, err); }
            }
            c.world.broadcast({ type: "leave", id: c.id }); c.world.scripts.onPresence("leave", c.id, c.actorId);
            if (!c.superseded && c.actorId) c.world.log?.departed(c.actorId); // a takeover keeps the body; a departure drops what it held
            // The primary is gone: reap every aux leg of this identity, unless a
            // successor took over (its auxes transfer to the new primary — same
            // identity, and takeover means re-arrival, not departure).
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
      // B2 (#57, matrix 3): a superseded generation is DEAD to the world even
      // while its socket drains. NOTE (review): every current superseding path
      // (takeover, expel) also unmaps the ws from `clients`, so the lookup
      // above already returns undefined and this line is presently
      // unreachable — the real protection is the unmap. It stays as a
      // backstop for any future path that marks superseded without unmapping;
      // a drained socket's rtc/SDP reaching the successor's peers is the
      // wedge this whole flag exists to prevent.
      if (c.superseded) return;
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      // message-rate cap: 15Hz poses + verbs + slack. Excess is dropped
      // silently — closing would just trigger the client's auto-reconnect.
      const now = Date.now();
      if (now - c.msgWin > 1000) { c.msgWin = now; c.msgCount = 0; }
      if (++c.msgCount > MSG_RATE) {
        // a REQUEST over the cap is answered, never dropped silently: its client awaits a reply by id, and silence left it
        // waiting out its own timeout while the request never reached the authority (client-check HT, 10-17: a burst of
        // label sets, each with its history re-read, lost a set and then hung 15 s). Bounded: past twice the cap even a
        // request is dropped (a flood must not buy itself a stream of replies)
        if (msg?.type === "request" && c.msgCount <= 2 * MSG_RATE) { try { ws.send(JSON.stringify({ type: "reply", id: msg.id ?? null, verb: String(msg.verb ?? "").slice(0, 32), ok: false,
          reply: { ok: false, refused: { code: "rate", reason: `more than ${MSG_RATE} messages in a second from this connection: this request wasn't run`, fix: "slow down and send it again" } } })); } catch { /* gone */ } }
        return;
      }

      // No message may ever kill the process. An uncaught throw in Bun's ws
      // callback EXITS THE SERVER, and a client in a reconnect loop turns one
      // bad request into a crash loop for everyone (measured 2026-08-02: a
      // world name carrying a stray ")" from a chat-linkified URL took prod
      // down 16 restarts in a row). Refusals are messages, failures are logs —
      // neither is an exit.
      try {
      switch (msg.type) {
        case "join": {
          // upgrade) passes without the authority key; everyone else needs
          // JOIN_TOKEN as before. Both may be live at once — invite links for
          // the show, Discord login for everyone with the role.
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
          // leave previous world (travel is: leave A, join B). Review finding
          // 6: travel never runs the ws-close handler, so without the reap a
          // traveling primary left a live, credentialed orphan mic behind —
          // still rtc- and attest-capable with no living primary, the exact
          // state the 4008 orphan refusal exists to prevent.
          if (c.world) {
            snapshots.retire(c);
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
          // slice 3c: a world talks only to clients that fold its log. A client that doesn't (an old page, an old agent build) is refused
          // with the reason; 4005 = a refused join, which clients know not to redial
          // (an aux surface, e.g. a voice leg, carries presence and audio, never world state: it isn't asked to)
          if (w.log && msg.replica !== true && (c.surface ?? "world") === "world") {
            ws.send(JSON.stringify({ type: "error", error: noFoldRefusal(w.name, !!auth?.nativeWorld) }));
            ws.close(4005, "this client doesn't fold the log");
            clients.delete(ws);
            return;
          }
          c.replica = msg.replica === true;
          installJoin(c, w);
          // speech is arrival-only (R 10-18): this connection hears says after the cut it is about to adopt, and reads back
          // none at or below it (history, the authority's history) unless it is an admin's (world.ts sayFloor)
          c.arrivedSeq = w.log.head;
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
          // (review of #260, server I48)
          if (w.log) ws.send(JSON.stringify({ type: "mod-state", muted: mutedIn(w.log.sanctions()) }));
          sendGeomFollowup(w, c);
          if (!c.spectator) w.broadcast({ type: "arrive", id: c.id, avatar: c.avatar, ...(c.declares ? { declares: c.declares } : {}), session: presenceSession(c), ...(c.actorId ? { actorId: c.actorId } : {}), ...(w.log && c.anonymous ? { guest: true } : {}) }, c);
          if (w.log) sanctionSweep(w);   // a voice mute in force is re-applied on join (keyed on the identity, never a name)
          if (!c.spectator) w.scripts.onPresence("enter", c.id, c.actorId);
          console.log(`[world:${w.name}] ${describe(w)}${c.spectator ? ` — ${c.id} watching` : ` — ${c.id} joined`}`);
          break;
        }
        // ── SFU signaling (VOICE_TRANSPORT=sfu) ──────────────────────────
        // Deliberately SEPARATE verbs from `rtc`: rtc is client↔client and
        // routes by `to`, whereas here one end IS the sequencer, so there is no
        // recipient to address and no fanout to get wrong. Same properties
        // though — never logged, SDP-sized cap, dropped if the leg is gone.
        case "sfu-answer": {
          if (!c.world || !relayEnabled()) return;
          // 🔴 THE SAME GATE relay-cred USES (:1120). A spectator or an aux leg
          // keeps the PRIMARY'S `c.id` (:509 sets spectator from surface, it does
          // not rename), so without this check any such socket reaches a real
          // participant's SFU leg. Found by an independent reviewer, 2026-08-16.
          if (c.spectator || (c.surface ?? "world") !== "world") return;
          // 🔴 AMENDMENT 1's SEVEN REFUSALS, ACTUALLY RUN (2026-08-16).
          // admitSfuLeg implemented all seven and had NO CALLER outside its own
          // test, and the client never returned its nonce — so usedNonces was
          // never populated and "the refusals hold under our transport" was a
          // claim about code that did not execute. This is the first
          // authenticated act after the credential is issued, so it is where
          // admission belongs: the server offers, the client answers, and the
          // answer must prove it is the leg the credential was minted for.
          {
            // 🔴 ADMIT ONCE PER LEG, NOT ONCE PER ANSWER. The nonce is
            // single-use by design (it closes the removed-participant replay
            // hole), but sfu-answer fires on EVERY renegotiation — and the
            // server renegotiates whenever anyone else joins. So the second
            // answer presented the same, now-burned nonce, was refused as
            // "credential replay", and the refusal path revoked a working leg:
            // the first person in a room lost voice the moment a second person
            // arrived. Caught by an independent reviewer reading the path, not
            // by a test — the suites only ever negotiate once.
            //
            // An already-admitted leg has proven its credential; subsequent
            // answers are ordinary negotiation traffic on an established,
            // gen-checked session, exactly like sfu-ice.
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
          // 🔴 THE SAME GATE relay-cred USES (:1120). A spectator or an aux leg
          // keeps the PRIMARY'S `c.id` (:509 sets spectator from surface, it does
          // not rename), so without this check any such socket reaches a real
          // participant's SFU leg. Found by an independent reviewer, 2026-08-16.
          //
          // sfu-pos was the sharp one: writing a distant position for someone
          // else's id moves them out of every listener's proximity gate — a
          // REMOTE MUTE available to any connected client. The old comment here
          // reasoned only about withholding one's own data ("cannot silence
          // someone by withholding"), which is true and answers the wrong threat:
          // the risk is FORGING another identity's data, not omitting your own.
          if (c.spectator || (c.surface ?? "world") !== "world") return;
          // gen required end-to-end (#130 item 4) — the adapter refuses
          // missing or stale generations, mirroring sfu-answer.
          sfuAcceptIce(c.world.name, c.id, msg.candidate, typeof msg.gen === "number" ? msg.gen : undefined);
          return;
        }
        case "sfu-pos": {
          // Position feed for the proximity gate. OPTIONAL by design: the gate
          // fails open on unknown/stale positions, so a client that never sends
          // these is never gated — which is what keeps this from being a way to
          // silence someone by withholding data.
          if (!c.world || !relayEnabled()) return;
          // 🔴 THE SAME GATE relay-cred USES (:1120). A spectator or an aux leg
          // keeps the PRIMARY'S `c.id` (:509 sets spectator from surface, it does
          // not rename), so without this check any such socket reaches a real
          // participant's SFU leg. Found by an independent reviewer, 2026-08-16.
          //
          // sfu-pos was the sharp one: writing a distant position for someone
          // else's id moves them out of every listener's proximity gate — a
          // REMOTE MUTE available to any connected client. The old comment here
          // reasoned only about withholding one's own data ("cannot silence
          // someone by withholding"), which is true and answers the wrong threat:
          // the risk is FORGING another identity's data, not omitting your own.
          if (c.spectator || (c.surface ?? "world") !== "world") return;
          const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
          sfuSetPosition(c.world.name, c.id, n(msg.x), n(msg.y), n(msg.z));
          return;
        }
        case "sfu-want-negotiate": {
          // The client added a track and needs an offer. It ASKS rather than
          // offering, because the server must own every offer (glare).
          if (!c.world || !relayEnabled()) return;
          // 🔴 THE SAME GATE relay-cred USES (:1120). A spectator or an aux leg
          // keeps the PRIMARY'S `c.id` (:509 sets spectator from surface, it does
          // not rename), so without this check any such socket reaches a real
          // participant's SFU leg. Found by an independent reviewer, 2026-08-16.
          //
          // sfu-pos was the sharp one: writing a distant position for someone
          // else's id moves them out of every listener's proximity gate — a
          // REMOTE MUTE available to any connected client. The old comment here
          // reasoned only about withholding one's own data ("cannot silence
          // someone by withholding"), which is true and answers the wrong threat:
          // the risk is FORGING another identity's data, not omitting your own.
          if (c.spectator || (c.surface ?? "world") !== "world") return;
          sfuNegotiate(c.world.name, c.id, (payload) => ws.send(JSON.stringify(payload)));
          return;
        }
        // 🔴 THE `rtc` VERB IS GONE (#104 phase-1 cutover, 2026-08-16). It was the
        // MESH's point-to-point SDP/ICE lane and its only client was voice.js,
        // now deleted. It was also deliberately UNGATED on transport — kept open
        // so ?mesh=1 could still roll back on an SFU server — which made it an
        // unauthenticated relay with no consumer: a sidecar signalled through it
        // for an hour, ICE completing happily, heard by NOBODY. Its per-surface
        // addressing (toSurface/fromSurface/fromGen) never functioned either, by
        // the server's own admission: no browser ever sent those fields.
        case "relay-cred": {
          // #104 phase-1: mint the least-authority media credential (A1). The
          // asker must be an ADMITTED identity — the embodied primary (its own
          // mic/tts publishes on its relay leg) — and the leg it earns is a
          // surface session: gen from the same counter as every leg, announced
          // by the same transition event, retired by the same funnel. No API
          // secret and no bearer token exist to leak into this reply (A1).
          if (!c.world) return;
          if (!relayEnabled()) { ws.send(JSON.stringify({ type: "error", error: "no voice relay configured" })); return; }
          if (c.spectator || (c.surface ?? "world") !== "world") {
            ws.send(JSON.stringify({ type: "error", error: "relay-cred is the embodied primary's ask" }));
            return;
          }
          // "Scopes are askable-down" (A1) is DESIGNED and not yet ENFORCED:
          // msg.publish was read into a variable that nothing consumed, which
          // made the code claim a property it does not have. Named honestly
          // until the SFU carries a per-leg publish flag at ingress — every
          // credential is currently a publishing credential.
          const mediaGen = ++GEN;
          {
            // No JWT to mint and no external service to reach, so this is
            // synchronous — but it announces through the SAME transition event
            // and takes a gen from the SAME counter, because a surface session
            // is a surface session regardless of what carries its audio.
            // Mint FIRST: mintSfuCredential funnels through revokeSfuLeg (a
            // re-mint must not inherit its predecessor's consent/admission),
            // and revoke unregisters the sender — registering before it would
            // hand the fresh leg a deleted send path.
            const cred = mintSfuCredential(c.world.name, c.id, c.gen!, mediaGen);
            registerSfuSender(c.world.name, c.id, (payload) => ws.send(JSON.stringify(payload)));
            // the mint retired the old leg, and a retirement resets the id's mute at the SFU (sfuadapter.ts revokeSfuLeg):
            // forget what this connection last applied, its mute and deafness both, so the sweep applies the sanctions in
            // force to the new leg (review of #260)
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
          // Research roles S4 (finding 1): this muted a typed DISPLAY NAME, kept no record, and was lost on a reconnect.
          // It is now the authority's `mute {channels: ['voice']}` (or `unmute`): keyed on the target's IDENTITY, logged in the
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
          // (Moderation › Bans, /unmute), not ended quietly from a voice button (review 10-07)
          if (!muted && w.log.mutedHere(target, "chat")) { ws.send(JSON.stringify({ type: "error", error: "that mute covers chat too: lift it in Moderation › Bans (or /unmute)" })); return; }
          // through the request path (review r14 M1, 10-18): one capability, the connection's queue, the meters, both recheck seams
          void requestAs(c, ws, w, muted ? "mute" : "unmute", muted ? { who: target, minutes, channels: ["voice"], ...(typeof msg.reason === "string" ? { reason: msg.reason } : {}) } : { who: target })
            .then((r: any) => {
              if (!r?.ok) { ws.send(JSON.stringify({ type: "error", error: r?.refused?.reason ?? "that mute was refused" })); return; }
              sanctionSweep(w);
              guestSanctionByAddress(w, actorIdOf(c), c.id, muted ? "mute" : "unmute", target, typeof msg.reason === "string" ? msg.reason : undefined);   // R 10-07
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
          // Listener-authored receive consent (amendment 3): server-enforced
          // via subscriptions, gen-bound (this leg's gen — a reconnect starts
          // fail-closed and cannot resurrect its predecessor's yes),
          // idempotent. Publisher self-mute stays pre-encode client-side;
          // moderator mute is a different verb with a different rank.
          if (!c.world || c.spectator) return;
          if (!relayEnabled()) return;
          const r = setSfuConsent(c.world.name, c.id, c.gen ?? 0, msg.recv === true);
          ws.send(JSON.stringify({ type: "voice-consent", recv: msg.recv === true,
            applied: r.changed, ...(r.reason ? { note: r.reason } : {}) }));
          return;
        }
        default: {
          // Every other message type lives in the handler table
          // (server/messages.ts, R2 — the verbs.ts precedent). Unknown
          // types fall through to silence, exactly as the switch did.
          // OWN keys only: a type such as "__proto__" or "constructor" must
          // fall through to silence like any unknown type, never reach
          // Object.prototype and fail server-side (PR #160 review, B5).
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
  // per-world guard, same idiom as the behavior tick: one world's failure
  // (the RECORD path appends to disk) must cost that world one tick, not
  // exit the process or stall every other world's frames (house rule 3 —
  // module-level intervals can take the sequencer down exactly like a ws
  // callback)
  for (const w of worlds.values()) {
    try {
    if (w.dirty.size === 0) continue;
    // t is the AUTHORITY's clock (spec/PHYSICS.md §5.1: max(last entry ts, wall), the one that stamps entries' ts), never
    // raw wall time: in a world whose log runs ahead of the wall clock, a client drawing flights at serverNow() drew them
    // at the wrong tick (physseeds SV1)
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
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    for (const w of worlds.values()) {
      // ws close handlers never run on exit — everyone connected right now
      // sleeps where they stand, same as a normal leave. Without this, a
      // client that also vanished during the restart window woke at its
      // PREVIOUS remembered spot instead of where it stood.
      for (const c of w.clients) {
        if (!c.spectator && !c.superseded && c.lastPose && c.actorId && !c.anonymous) w.rememberPose(c.actorId, c.lastPose);
      }
    }
    process.exit(0);
  });
}

console.log(`eidoverse-worlds sequencer on http://${HOST}:${PORT}`);
console.log(`  library: ${LIBRARY_DIR}`);
console.log(`  worlds:  ${WORLDS_DIR}`);
if (TRUST_NAMES) console.log(`  ⚠ TRUST_NAMES=1: a typed name IS an account here (local:<name>). Private servers only: anyone who can reach ${HOST}:${PORT} can be anyone.`);
if (!JOIN_TOKEN) console.log("  ⚠ NO JOIN_TOKEN — the server is OPEN. Fine on a tailnet, wrong on a public box.");
// A fresh clone without the client's install step serves a client that can
// never wake: the importmap points `three` at client/node_modules, every
// module import 404s, and the splash used to sit at "waking the engine"
// forever with nothing in THIS terminal. Say it where the operator looks.
if (!existsSync(join(ROOT, "client", "node_modules", "three"))) {
  console.log("  ⚠ client/node_modules is MISSING — browsers will hang at the splash. Run: cd client && bun install");
}
if (!existsSync(join(LIBRARY_DIR, "eidoverse"))) {
  console.log(`  ⚠ no eidoverse-video library at ${LIBRARY_DIR} — avatars/sky/vegetation will be absent. Set EIDOVERSE_DIR.`);
}
