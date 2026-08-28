// eidoverse-worlds sequencer.
// The server is a sequencer and archivist, NOT a simulator:
//  - orders + persists per-world event logs (the authored plane)
//  - relays presence (the embodied plane, never persisted)
//  - serves the browser client and the eidoverse-video asset library
// No world manifest: everything about a world arrives through its log.

import { existsSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// config FIRST — it carries the WORLDS_DIR mkdir, and auth.ts/moderation.ts
// carry their restore-at-boot blocks, so this import order IS the unsplit
// file's boot order: mkdir → session restore → ban restore (§15, step 7a).
import { PORT, JOIN_TOKEN, RECORD, ROOT, WORLDS_DIR, LIBRARY_DIR, MSG_RATE, FRAME_MS, FRAME_SKIP_BUFFERED } from "./config.ts";
import { type HnSession, agentTokens, aid1JoinIdentity } from "./auth.ts";
import { globalBans, findBan } from "./moderation.ts";
import { isAdminId, worldHasOwner, rightsOf, VERB_NEEDS, lockRefusal } from "./rights.ts";
import { resolveLibFile } from "./lint.ts";
// The authored plane's dispatch — table + shell (§15, 7b). It pulls in lint's
// linters, reactions, and the behavior cap itself; server.ts keeps only what
// the presence plane and HTTP surface still touch directly.
import { wireBehaviorGate, wireBehaviorStore } from "./behaviors.ts";
import { summarizeGlb } from "./geometry.ts";
// The world itself — WorldLog + WorldSession behind the unsplit facade, with
// the registry (§15, 7c). The boot sweep below stays HERE: waking scripted
// worlds with the server is boot policy, not world mechanics.
import { World, type Client, worlds, getWorld, wireSettledPose } from "./world.ts";
// The HTTP surface — one route table, /upload behind it in upload.ts (§15,
// 7c). fetch() below delegates; avatarRoster rides back for the join
// snapshot, pendingSnaps for the renderer's snap-result replies.
import { route, avatarRoster } from "./routes.ts";
import { registerSystem, startTick } from "./tick.ts";
import { MESSAGES, pendingWhispers, whisperKey } from "./messages.ts";
import { LIMITS } from "./limits.ts";
import { onEntryCommitted } from "./events.ts";
import { defsFingerprint } from "./defs.ts";
import { advanceSim, tickOf } from "../shared/sim.js";
// The reference fold lives in shared/ (house rule 1 by construction; the
// world folds with it in world.ts) — what remains here is the role ladder.
import { ROLE_RANK } from "../shared/fold.js";
// Seat profiles (#101, upstream): the store + its external-change poll are
// wired; the proposal/countersign HTTP routes are NOT ported into the route
// table yet — the feature is dormant here, not torn. (The crash this line
// heals: the poll timer auto-merged in while the declaration hunk fell on
// the fork side of a conflict — restart counter reached 15 before anyone
// noticed, because /version kept answering from the brief up-windows.)
import { SeatStore } from "./seats.ts";
import { OPT_DIR, PATCH_DIR } from "./config.ts";
const seatStore = new SeatStore(OPT_DIR, LIBRARY_DIR, {}, { patchDir: PATCH_DIR });

// Behavior sandbox wiring: a script's emit is gated by its AUTHOR's live
// rights (revoke the grant, the behavior loses its teeth) through the same
// table as everyone else. The store path is where `?as=script` uploads land.
wireBehaviorStore(join(ROOT, "assets", "opt"));
wireBehaviorGate((w, author, verb, args) => {
  const needs = VERB_NEEDS[verb];
  if (!needs) return `verb not allowed: ${verb}`;
  const rights = rightsOf((w as unknown as World).state, author);
  if (ROLE_RANK[rights.role] < needs.rank || (needs.gen && !rights.gen)) {
    return `"${verb}" needs more than ${author}'s "${rights.role}" role here`;
  }
  // a locked thing refuses scripts by the same rule as hands (a behavior
  // nudging a nailed-down bench is still an accident vector)
  return lockRefusal((w as unknown as World).state, verb, args);
});

/** A pose as it should be handed to SOMEONE ELSE — the settled result rather
 *  than whatever frame the body happened to be in.
 *
 *  Two callers, and they used to disagree, which was the bug (#61): the join
 *  snapshot's `restore` (your own body) went through rememberPose and came back
 *  normalized, while `present` (everyone else's bodies) shipped lastPose raw.
 *  So a resident mid-ragdoll looked fine to herself and arrived collapsed for
 *  every joiner — for weeks, with no way to tell from inside her own session.
 *
 *  - emote: a one-shot is a moment, not a place. Replaying it at every wake
 *    would make a wave into a tic.
 *  - ragdoll: physics in flight, not an enacted pose. The get-up path only
 *    exists in the session that fell, so anyone receiving it is stuck with a
 *    body hung in tumble bones. Sleep standing.
 *  Held bones (pose.pose) survive both: an enacted pose is a place. */
function settledPose(pose: unknown): Record<string, unknown> | null {
  if (!pose) return null;
  const { emote: _emote, ...still } = pose as Record<string, unknown>;
  if (still.clip === "ragdoll") { still.clip = "idle"; delete still.pose; }
  return still;
}
// The log's rememberPose settles through this SAME function — one rule for
// both planes. world.ts takes it by injection because the source-text gates
// (§15.1: settled-pose-test regexes this file) pin the definition here.
wireSettledPose(settledPose);

// The entry bus's boot-time subscribers (§24, events.ts): every committed
// entry reaches these, uniformly, in this order — the wire's seq stream
// first, then the scripts. Future systems (seats, recorders, the sim core)
// subscribe here instead of teaching another append site to fan out.
onEntryCommitted("client-fanout", (w, entry) => w.broadcast({ type: "log", entry }));
onEntryCommitted("behaviors", (w, entry) => w.bhv.onEntry(entry));

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
  for (const t of [...w.clients]) {
    if (t !== primary && t.id === primary.id && (t.surface ?? "world") !== "world") {
      retireAuxLeg(w, t, primary);
      w.clients.delete(t); clients.delete(t.ws);
      t.ws.close?.(4007, closeReason);
      console.log(`[world:${w.name}] ${primary.id}/${t.surface} reaped — ${closeReason}`);
    }
  }
}

function expel(w: World, target: Client, why: string) {
  try { target.ws.send(JSON.stringify({ type: "error", error: why })); } catch { /* going anyway */ }
  const wasEmbodied = !target.spectator;
  // an expelled AUX leg announces its own death; an expelled PRIMARY takes
  // its aux legs with it (kick/ban target the identity, not one socket) —
  // review finding 5: expel unmapped + superseded the target, so the close
  // handler's copy could never fire and the legs died silently
  retireAuxLeg(w, target);
  if (wasEmbodied) reapAuxLegs(w, target, "primary removed by moderation");
  if (wasEmbodied && target.lastPose) w.rememberPose(target.id, target.lastPose); // they may be back
  target.superseded = true;   // the close path must not double-handle this body
  w.clients.delete(target);
  clients.delete(target.ws);
  target.world = null;
  target.ws.close?.(4006, "removed by moderation");
  if (wasEmbodied) { w.broadcast({ type: "leave", id: target.id }); w.bhv.onPresence("leave", target.id); }
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
registerSystem({ name: "seat-store-poll", everyMs: 5000, fn: () => {
  const ext = seatStore.pollExternalChange();
  if (!ext) return;
  for (const ch of ext.changed) {
    const update = JSON.stringify({ type: "avatar-profile-updated", name: ch.name, pose: ch.pose, rev: ext.rev });
    let notified = 0;
    for (const w of worlds.values()) for (const c of w.clients) { c.ws.send(update); notified++; }
    console.log(`[seats] external change ${ch.name}/${ch.pose} rev ${ext.rev} → ${notified} client(s)`);
  }
} });

registerSystem({ name: "behaviors", everyMs: 1000, fn: (now) => {
  for (const w of worlds.values()) {
    try { w.bhv.tick(now); } catch (err) { console.error(`[world:${w.name}] behavior tick`, err); }
  }
} });

// The sim heartbeat (PROTOCOL_v2 §5): advance every epoch world's sim fold
// to the tick "now" quantizes to. Advancement is schedule-independent, so
// this cadence is presentation-freshness policy, not physics — a slower
// beat computes the same states later, never different ones.
registerSystem({ name: "sim", everyMs: 250, fn: (now) => {
  for (const w of worlds.values()) {
    try {
      if (w.sim.epoch && !w.sim.epoch.foreign) advanceSim(w.sim, tickOf(w.sim, now));
    } catch (err) { console.error(`[world:${w.name}] sim advance`, err); }
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

// Boot sweep: worlds load lazily on first touch, but a world with scripts
// must wake WITH the server, not with its first visitor — otherwise a
// restart leaves every lighthouse dark until someone happens to sail past.
// Cheap peek before paying for a real load: the snapshot names its
// behaviors; a world with no snapshot yet gets a byte-scan of its log for
// the verb. (A world whose behaviors were all since removed may load once
// for nothing — harmless, and it folds a fresh snapshot on shutdown.)
try {
  let woken = 0;
  for (const name of readdirSync(WORLDS_DIR)) {
    try {
      if (!/^[a-z0-9_-]{1,64}$/i.test(name)) continue;
      const dir = join(WORLDS_DIR, name);
      if (!existsSync(join(dir, "log.jsonl"))) continue;
      let hasScripts = false;
      const snapPath = join(dir, "snapshot.json");
      if (existsSync(snapPath)) {
        try {
          const snap = JSON.parse(readFileSync(snapPath, "utf8"));
          hasScripts = Object.keys(snap?.state?.behaviors ?? {}).length > 0;
        } catch { /* corrupt snapshot: fall through to the log scan */ }
      }
      if (!hasScripts && readFileSync(join(dir, "log.jsonl"), "utf8").includes('"verb":"behavior"')) {
        hasScripts = true;
      }
      if (hasScripts) { getWorld(name); woken++; }
    } catch (err) { console.error(`[boot] world ${name} peek failed`, err); }
  }
  if (woken) console.log(`[boot] ${woken} scripted world(s) woken — their behaviors run without visitors`);
} catch (err) { console.error("[boot] world sweep failed", err); }

/** Whispers waiting for someone who wasn't here. Memory only, deliberately:
 *  see the `whisper` message case.
 *
 *  The key is built in ONE place because it is written on one code path and
 *  read on another — they drifted once already (a stray separator character
 *  made every held whisper unreachable, silently), and the failure mode is a
 *  private message that simply never arrives. */
// held-whisper machinery lives with its writers in messages.ts now (R2);
// join's delivery of held whispers imports it back, one-way.

let nextClientNum = 1;
const clients = new Map<unknown, Client>();
// #57 B2: transport-epoch source. Global (not per-world) so a generation number
// never collides across worlds or after a world reload; never persisted — an
// epoch outliving the process would defeat its purpose.
let GEN = 0;

/** The placeholder tier's bbox side-channel, sent AFTER the snapshot as its
 *  own message: summaries are async, and the join handler's synchronous
 *  ordering is a guarantee (an awaited join would let the same client's
 *  next messages interleave — the exact hazard the client's fold just
 *  finished escaping). geometry.ts caches per lib+mtime, so the steady
 *  state is microtasks and the message lands a beat after the snapshot,
 *  long before any GLB. */
function sendGeomFollowup(w: World, c: Client) {
  const libs = new Set<string>();
  for (const e of Object.values(w.state.entities)) if (e.lib && e.kind !== "light") libs.add(e.lib);
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

function admitJoin(c: Client, ws: { send(d: string): void; close(code?: number, reason?: string): void }, msg: any, auth: HnSession | null): World | null {
    // A malformed world name is a bad LINK, not a bad actor — refuse it
    // with an explanation and a close code the client knows not to retry
    // (retrying a name that can never exist is just a polite DoS).
    const wname = String(msg.world ?? "commons");
    if (!/^[a-z0-9_-]{1,64}$/i.test(wname)) {
      ws.send(JSON.stringify({ type: "error", error: `"${wname}" is not a world name — check the link that brought you here` }));
      c.ws.close?.(4005, "bad world name");
      return null;
    }
    const w = getWorld(wname);
    // Identity: a verified session OWNS the id — the client's msg.id is
    // ignored (the name came from Discord via the home node, and the
    // sub underneath it survives renames).
    c.id = (auth ? auth.name : String(msg.id ?? c.id)).slice(0, LIMITS.ID_LEN);
    // Actor names are the log's ink — refuse the ones that forge system
    // or script authorship ("world" authors grants; "bhv:*" authors
    // script effects; the behavior loop-guard trusts that prefix), and
    // strip control characters that would corrupt every future reader.
    // (Hesperus finding #3: an unauthenticated join as "world" produced
    // entries indistinguishable from the sequencer's own.)
    c.id = c.id.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!c.id || /^(world|\*)$/i.test(c.id) || /^bhv:/i.test(c.id)) {
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
    c.agent = Boolean(msg.agent);
    c.renderer = Boolean(msg.renderer);
    if (c.renderer) c.spectator = true; // renderers are invisible by definition
    // Same display name, different PERSON (two guild members can share a
    // nick): suffix the newcomer rather than letting takeover fight.
    if (auth && !c.spectator) {
      for (const other of w.clients) {
        if (other !== c && !other.spectator && other.id === c.id && other.sub && other.sub !== c.sub) {
          c.id = `${c.id}-${c.sub!.replace(/\D/g, "").slice(-4) || "2"}`.slice(0, LIMITS.ID_LEN);
          break;
        }
      }
    }
    // Agent names are RESERVED: an id that appears in mcpl/tokens.json
    // is claimable only with that agent's own bearer token (the MCPL
    // door forwards it). Closes the "fable spoofable" hole for names we
    // actually know; humans stay self-asserted until archipelago-home.
    {
      const at = agentTokens();
      const tokStr = String(msg.agentToken ?? "");
      let tokId = at.byToken.get(tokStr);
      // The archipelago door forwards the agent's aid1 credential. An
      // identity the home node vouches for satisfies the reservation
      // exactly like a tokens.json bearer — same slug derivation as the
      // MCPL door, so the two doors agree on who "fable" is.
      if (!tokId) tokId = aid1JoinIdentity(tokStr)?.slug;
      if (tokId && tokId.toLowerCase() === c.id.toLowerCase()) c.tokenVerified = true;
      if (at.names.has(c.id.toLowerCase()) && tokId?.toLowerCase() !== c.id.toLowerCase()) {
        console.log(`[perm] join refused: "${c.id}" is a reserved agent name (token ${tokStr ? "unrecognized" : "missing"})`);
        ws.send(JSON.stringify({ type: "error", error: `"${c.id}" is a reserved agent name` }));
        c.ws.close?.(4004, "reserved name");
        return null;
      }
    }
    // Bans — checked once identity is SETTLED (id/sub/reserved names all
    // resolved above), before the body enters. A global ban closes every
    // door; a per-world ban closes this one. Spectating counts: a ban is
    // exclusion, not just silencing. WORLD_ADMIN passes everywhere — an
    // operator can never be locked out, which is also the unban path of
    // last resort.
    {
      const gb = findBan(globalBans, c.id, c.sub);
      const ban = gb ?? findBan(w.state.bans, c.id, c.sub);
      if (ban && !isAdminId(c.id, c.sub)) {
        console.log(`[world:${w.name}] join refused: ${c.id} is banned ${gb ? "globally" : "here"} (by ${ban.by})`);
        ws.send(JSON.stringify({ type: "error", error: `you are banned from ${gb ? "these worlds" : `"${w.name}"`}${ban.reason ? ` — ${ban.reason}` : ""} (by ${ban.by})` }));
        c.ws.close?.(4006, "banned");
        return null;
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
      const auxBound = c.tokenVerified === true
        || (typeof primary.sub === "string" && primary.sub.length > 0 && c.sub === primary.sub);
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
        if (other !== c && other.id === c.id
            && (other.surface ?? "world") === c.surface
            && !(other.spectator && (other.surface ?? "world") === "world")) {
          other.superseded = true;
          retiredGen = other.gen;
          w.clients.delete(other);
          clients.delete(other.ws);
          other.ws.close?.(4002, "session takeover");
          console.log(`[world:${w.name}] ${c.id}/${c.surface} takeover — gen ${other.gen} retired`);
        }
      }
    }
    c.gen = ++GEN;   // B2: this leg's surfaceSession, issued on acceptance
    w.clients.add(c);
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
    // A brand-new world belongs to whoever first walks into it embodied:
    // the grant goes through the log like any other fact, actor "world".
    // (Pre-existing ownerless worlds stay OPEN — granting their first
    // owner is a deliberate act by a WORLD_ADMIN, not a land-rush.)
    // ("brand-new" tolerates the genesis dialect marker every fresh log
    // now opens with — a world whose only history is its birth certificate
    // still belongs to whoever steps in first)
    if (!c.spectator && w.snapSeq < 0
      && w.entries.every((e) => e.verb === "genesis")) {
      w.commit("world", "grant",
        { id: c.id, role: "owner", gen: true, ...(c.sub ? { sub: c.sub } : {}) });
      console.log(`[world:${w.name}] new world — ${c.id} is its owner`);
    }
}

function buildSnapshot(w: World, c: Client) {
    // snapshot = full log replay (folding comes later) + who's present now
    const jp = w.joinPayload();
    return {
      type: "snapshot",
      world: w.name,
      you: c.id,
      gen: c.gen,   // your surfaceSession — echo it in attestations
      // your OWN live aux legs — people[] excludes self, and a page that
      // reconnects while its voice leg lives must still hold-then-fallback
      // its own says rather than double-speak next to its own voice.
      yourSurfaces: [...w.clients]
        .filter(x => x !== c && x.id === c.id && (x.surface ?? "world") !== "world")
        .map(x => ({ surface: x.surface, gen: x.gen })),
      recording: RECORD,
      // The world as it is, then only what has happened since. A joiner's
      // cost is now the size of the WORLD, not the length of its history.
      state: jp.state,
      throughSeq: jp.throughSeq,
      entries: jp.tail,
      // dialect 3: the sim fold's cut, adopted by the joiner (absent
      // pre-epoch — see joinPayload)
      ...("sim" in jp ? { sim: (jp as { sim?: unknown }).sim } : {}),
      // the body roster rides along — a joiner resolves names with no
      // extra round-trip (bbox geometry follows as its own message)
      avatars: avatarRoster(),
      // what YOU may do here, as of now (live grants update it client-side).
      // `open` = no owner exists, so rights are the everyone-builds default.
      yourRights: { ...rightsOf(w.state, c.id, c.sub), open: !worldHasOwner(w.state) },
      // wake where you fell asleep — the world's memory of your body
      restore: c.spectator ? null : (w.poses[c.id] ?? null),
      present: [...w.clients].filter(o => o !== c && !o.spectator).map(o => ({
        // settledPose, not lastPose: a joiner must not inherit someone
        // else's mid-ragdoll frame (#61). Same normalization `restore`
        // above already gets via rememberPose.
        id: o.id, avatar: o.avatar, pose: settledPose(o.lastPose), agent: o.agent,
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
  hostname: "0.0.0.0",
  async fetch(req, srv) {
    // The whole HTTP surface is routes.ts's table (§15, 7c) — one row per
    // endpoint, first match wins, in exactly the order the if-chain had.
    // /ws upgrades inside its row: a successful upgrade returns no Response,
    // same contract as before.
    return route(req, srv);
  },
  websocket: {
    // House rule 3 applies to EVERY ws callback, not just message: an
    // uncaught throw out of open/close exits the process the same way (the
    // 4f82250 crash loop), and close reaches disk (settleLease → append,
    // rememberPose → write+rename) — an EIO/ENOSPC there must be a log line,
    // never an exit.
    open(ws) {
      try {
        const c: Client = { id: `anon-${nextClientNum++}`, ws, world: null, avatar: "", lastPose: null, spectator: false,
          msgWin: 0, msgCount: 0, verbWin: 0, verbCount: 0 };
        const sess = (ws as unknown as { data?: { session?: HnSession | null } }).data?.session;
        if (sess && sess.exp > Date.now()) { c.auth = sess; c.sub = sess.sub; }
        clients.set(ws, c);
      } catch (err) {
        console.error(`[ws] open failed server-side:`, err);
      }
    },
    close(ws) {
      try {
        const c = clients.get(ws);
        if (!c) return;
        clients.delete(ws);
        // dev crash forensics (?bc=1 clients): the last thing a dying renderer
        // was doing, printed at the only moment we learn it died
        if (c.bcRing?.length) {
          console.log(`[bc] ${c.id} last breadcrumbs: ${c.bcRing.join(" | ")}`);
        }
        // a vanished simulator's objects land exactly where its last frame put
        // them — the lease's whole promise (docs/leases.md). Per-lease guard:
        // a failed settle (disk) must not abandon the OTHER leases or the
        // leave cleanup below — a ghost body standing forever (#56) is worse
        // than one object hovering at its last streamed transform.
        if (c.world) for (const [lid, L] of [...c.world.leases]) if (L.holder === c) {
          try { c.world.settleLease(lid); } catch (err) { console.error(`[world:${c.world.name}] lease settle for ${lid} on close`, err); }
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
              try { c.world.rememberPose(c.id, c.lastPose); } // sleep where you stood
              catch (err) { console.error(`[world:${c.world.name}] rememberPose for ${c.id} on close`, err); }
            }
            c.world.broadcast({ type: "leave", id: c.id });
            c.world.bhv.onPresence("leave", c.id);
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
      if (++c.msgCount > MSG_RATE) return;

      // No message may ever kill the process. An uncaught throw in Bun's ws
      // callback EXITS THE SERVER, and a client in a reconnect loop turns one
      // bad request into a crash loop for everyone (measured 2026-08-02: a
      // world name carrying a stray ")" from a chat-linkified URL took prod
      // down 16 restarts in a row). Refusals are messages, failures are logs —
      // neither is an exit.
      try {
      switch (msg.type) {
        case "join": {
          // upgrade) passes without the door key; everyone else needs
          // JOIN_TOKEN as before. Both may be live at once — invite links for
          // the show, Discord login for everyone with the role.
          const auth = c.auth && c.auth.exp > Date.now() ? c.auth : null;
          if (!auth && JOIN_TOKEN && String(msg.token ?? "") !== JOIN_TOKEN) {
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
            c.world.clients.delete(c);
            retireAuxLeg(c.world, c);
            if (!c.spectator) {
              c.world.broadcast({ type: "leave", id: c.id });
              c.world.bhv.onPresence("leave", c.id);
              reapAuxLegs(c.world, c, "primary traveled");
            }
          }
          const w = admitJoin(c, ws, msg, auth);
          if (!w) return;
          installJoin(c, w);
          ws.send(JSON.stringify(buildSnapshot(w, c)));
          sendGeomFollowup(w, c);
          if (!c.spectator) w.broadcast({ type: "arrive", id: c.id, avatar: c.avatar, agent: c.agent }, c);
          if (!c.spectator) w.bhv.onPresence("enter", c.id);
          // Whispers that arrived while this identity was away. Held in memory
          // only — see the `whisper` case for why they must never reach the log.
          if (!c.spectator) {
            const held = pendingWhispers.get(whisperKey(w.name, c.id));
            if (held?.length) {
              for (const m of held) ws.send(JSON.stringify(m));
              pendingWhispers.delete(whisperKey(w.name, c.id));
              console.log(`[world:${w.name}] delivered ${held.length} held whisper(s) to ${c.id}`);
            }
          }
          console.log(`[world:${w.name}] ${describe(w)}${c.spectator ? ` — ${c.id} watching` : ` — ${c.id} joined`}`);
          break;
        }
        default: {
          // Every other message type lives in the handler table
          // (server/messages.ts, R2 — the verbs.ts precedent). Unknown
          // types fall through to silence, exactly as the switch did.
          const h = MESSAGES[msg.type];
          if (h) h({ c, ws, now, expel }, msg);
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
    const data = JSON.stringify({ type: "frame", seq: w.frameSeq++, t: Date.now(), poses: Object.fromEntries(w.dirty) });
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

// Stale-lease sweep: a holder that stops streaming (hung tab, wedged plugin)
// loses the object — committed at its last known transform, like a
// disconnect. Nothing hovers forever; nothing stays possessed.
registerSystem({ name: "lease-sweep", everyMs: 5_000, fn: (now) => {
  for (const w of worlds.values()) {
    // per-world guard (house rule 3): settleLease appends to disk
    try {
      for (const [id, L] of [...w.leases]) {
        if (now - L.lastAt > LIMITS.LEASE_SWEEP_MS) {
          w.debug("lease-swept", { id, holder: L.holder.id });
          w.settleLease(id);
        }
      }
    } catch (err) { console.error(`[world:${w.name}] lease sweep`, err); }
  }
} });

// The heartbeat starts once every system is on it — the base is the finest
// cadence in the registry (stage frames); everything coarser rides it.
startTick(FRAME_MS);

// Fold on the way out so a restart resumes from the snapshot rather than
// re-reading a tail that was already folded in memory.
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
        if (!c.spectator && !c.superseded && c.lastPose) w.rememberPose(c.id, c.lastPose);
      }
      if (w.entries.length) w.fold("shutdown");
      // fold only runs on a non-empty tail — a world whose batch is armed
      // but whose tail was just folded still owes the file its last lines
      try { w.flushLog(); } catch (err) { console.error(`[world:${w.name}] shutdown flush failed`, err); }
    }
    process.exit(0);
  });
}

console.log(`eidoverse-worlds sequencer on http://0.0.0.0:${PORT}`);
console.log(`  library: ${LIBRARY_DIR}`);
console.log(`  worlds:  ${WORLDS_DIR}`);
if (!JOIN_TOKEN) console.log("  ⚠ NO JOIN_TOKEN — the door is OPEN. Fine on a tailnet, wrong on a public box.");
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
