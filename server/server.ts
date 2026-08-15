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
import { type HnSession, agentTokens, HN_ISSUER_KEY, HN_ISS, HN_AUD } from "./auth.ts";
import { globalBans, saveGlobalBans, findBan } from "./moderation.ts";
import { isAdminId, worldHasOwner, rightsOf, VERB_NEEDS, lockRefusal } from "./rights.ts";
import { resolveLibFile } from "./lint.ts";
// The authored plane's dispatch — table + shell (§15, 7b). It pulls in lint's
// linters, reactions, and the behavior cap itself; server.ts keeps only what
// the presence plane and HTTP surface still touch directly.
import { runVerb } from "./verbs.ts";
import { verifyToken } from "./aid1.ts";
import { wireBehaviorGate, wireBehaviorStore } from "./behaviors.ts";
import { summarizeGlb } from "./geometry.ts";
// The world itself — WorldLog + WorldSession behind the unsplit facade, with
// the registry (§15, 7c). The boot sweep below stays HERE: waking scripted
// worlds with the server is boot policy, not world mechanics.
import { World, type Client, worlds, getWorld, forkWorld, wireSettledPose } from "./world.ts";
// The HTTP surface — one route table, /upload behind it in upload.ts (§15,
// 7c). fetch() below delegates; avatarRoster rides back for the join
// snapshot, pendingSnaps for the renderer's snap-result replies.
import { route, avatarRoster, pendingSnaps } from "./routes.ts";
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
import { OPT_DIR } from "./config.ts";
// Relay-floor spike (#104 phase 1): the LiveKit adapter. Inert without
// RELAY_URL — the mesh stays the production path (amendment 6).
import { relayEnabled, bootRelayAdapter, mintRelayCredential, revokeRelayLeg,
  setListenerConsent, setLegRetiredHook, relayDiag, relayServiceState, currentIncarnation,
  voiceTransport } from "./relayadapter.ts";
// The in-process SFU (VOICE_TRANSPORT=sfu). Same surface as the LiveKit
// adapter, so every call site below branches on transport rather than on shape.
import { mintSfuCredential, setSfuConsent, revokeSfuLeg, sfuDiag,
  sfuAcceptAnswer, sfuAcceptIce, sfuNegotiate, sfuSetPosition, registerSfuSender } from "./sfuadapter.ts";
const seatStore = new SeatStore(OPT_DIR, LIBRARY_DIR);

// The resident-visible service chart (amendment 2): every voice-service
// transition reaches every client of every world, stamped with the
// incarnation so a client can tell "the relay restarted" from "it flapped".
bootRelayAdapter(OPT_DIR, (state, inc) => {
  const msg = JSON.stringify({ type: "voice-service", state, incarnation: inc });
  for (const w of worlds.values()) for (const t of w.clients) t.ws.send(msg);
  console.log(`[relay] voice-service ${state} (${inc})`);
});
// The relay told us (webhook participant_left / probe) a leg died: the
// SEQUENCER announces it — presence authority stays here in every topology.
setLegRetiredHook((worldName, id, gen) => {
  const w = worlds.get(worldName);
  if (!w) return;
  const retire = JSON.stringify({ type: "surface-transition",
    id, surface: "voice-relay", gen: null, retired: gen });
  for (const t of w.clients) t.ws.send(retire);
});
/** Retire an identity's relay leg through the SAME funnel every other surface
 *  death uses: revoke at the relay, burn the credential, broadcast the
 *  transition. Fire-and-forget — a relay outage must never wedge a close. */
function retireRelayLeg(w: World, id: string) {
  if (!relayEnabled()) return;
  revokeRelayLeg(w.name, id).then((leg) => {
    if (!leg) return;
    const retire = JSON.stringify({ type: "surface-transition",
      id, surface: "voice-relay", gen: null, retired: leg.gen });
    for (const t of w.clients) t.ws.send(retire);
    console.log(`[world:${w.name}] ${id}/voice-relay revoked — gen ${leg.gen}`);
  }).catch((err) => console.error(`[relay] revoke for ${id} failed`, err));
}

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
setInterval(() => {
  const ext = seatStore.pollExternalChange();
  if (!ext) return;
  for (const ch of ext.changed) {
    const update = JSON.stringify({ type: "avatar-profile-updated", name: ch.name, pose: ch.pose, rev: ext.rev });
    let notified = 0;
    for (const w of worlds.values()) for (const c of w.clients) { c.ws.send(update); notified++; }
    console.log(`[seats] external change ${ch.name}/${ch.pose} rev ${ext.rev} → ${notified} client(s)`);
  }
}, 5000);

setInterval(() => {
  const now = Date.now();
  for (const w of worlds.values()) {
    try { w.bhv.tick(now); } catch (err) { console.error(`[world:${w.name}] behavior tick`, err); }
  }
}, 1000);

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
const pendingWhispers = new Map<string, unknown[]>();
const whisperKey = (world: string, recipient: string) => `${world}\u0000${recipient}`;
const WHISPERS_ENABLED = process.env.EIDO_WHISPERS_ENABLED !== "0";

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
          // Two doors (home-node.md §7): a verified session (cookie at
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
          // A malformed world name is a bad LINK, not a bad actor — refuse it
          // with an explanation and a close code the client knows not to retry
          // (retrying a name that can never exist is just a polite DoS).
          const wname = String(msg.world ?? "commons");
          if (!/^[a-z0-9_-]{1,64}$/i.test(wname)) {
            ws.send(JSON.stringify({ type: "error", error: `"${wname}" is not a world name — check the link that brought you here` }));
            c.ws.close?.(4005, "bad world name");
            return;
          }
          const w = getWorld(wname);
          // Identity: a verified session OWNS the id — the client's msg.id is
          // ignored (the name came from Discord via the home node, and the
          // sub underneath it survives renames).
          c.id = (auth ? auth.name : String(msg.id ?? c.id)).slice(0, 64);
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
            return;
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
            c.surface = rawSurface.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 16);
            if (!c.surface) {
              ws.send(JSON.stringify({ type: "error", error: `unusable surface name — letters, digits, - and _ only` }));
              ws.close(4005, "bad surface");
              clients.delete(ws);
              return;
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
                c.id = `${c.id}-${c.sub!.replace(/\D/g, "").slice(-4) || "2"}`.slice(0, 64);
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
            if (!tokId && HN_ISSUER_KEY && tokStr.startsWith("aid1.")) {
              const v = verifyToken(tokStr, { issuerId: HN_ISSUER_KEY, iss: HN_ISS, aud: HN_AUD, requireScopes: ["worlds:join"] });
              if (v.ok) tokId = v.payload.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || v.payload.sub;
            }
            if (tokId && tokId.toLowerCase() === c.id.toLowerCase()) c.tokenVerified = true;
            if (at.names.has(c.id.toLowerCase()) && tokId?.toLowerCase() !== c.id.toLowerCase()) {
              console.log(`[perm] join refused: "${c.id}" is a reserved agent name (token ${tokStr ? "unrecognized" : "missing"})`);
              ws.send(JSON.stringify({ type: "error", error: `"${c.id}" is a reserved agent name` }));
              c.ws.close?.(4004, "reserved name");
              return;
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
              return;
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
              return;
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
              return;
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
            if (auxCount >= 4) {
              ws.send(JSON.stringify({ type: "error", error: "too many auxiliary legs for this identity" }));
              ws.close(4008, "aux cap");
              // (c is not yet in w.clients here — add happens after these
              // checks — so only the global map needs cleaning. A w.clients
              // delete would be a no-op that misreads as "joiner counted".)
              clients.delete(ws);
              return;
            }
          }
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
                // a WORLD-surface takeover retires the identity's relay leg:
                // its credential is bound to the retired primaryGen, and the
                // successor mints fresh (#104 amendment 1 — takeover→rotate;
                // measured target: old leg's packets refused ≤2s)
                if ((c.surface ?? "world") === "world" && !other.spectator) retireRelayLeg(w, c.id);
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
            const entry = w.append("world", "grant",
              { id: c.id, role: "owner", gen: true, ...(c.sub ? { sub: c.sub } : {}) });
            w.broadcast({ type: "log", entry });
            console.log(`[world:${w.name}] new world — ${c.id} is its owner`);
          }
          // snapshot = full log replay (folding comes later) + who's present now
          const jp = w.joinPayload();
          ws.send(JSON.stringify({
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
          }));
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
        case "verb": {
          // The authored plane in one call — table + shell live in
          // server/verbs.ts (§15, 7b): preamble, validators, append +
          // broadcast, after hooks, byte-identical. expel rides in the ctx,
          // injected: verbs.ts must never import server.ts (the cycle break
          // §15.1 pinned).
          runVerb({ w: c.world!, c, now, expel }, msg.verb, msg.args);
          break;
        }
        case "history": {
          // Deliberately available to spectators too: watching a show and
          // reading back what was said before you arrived is the same act.
          if (!c.world) return;
          const r = c.world.readHistory({
            before: typeof msg.before === "number" ? msg.before : Infinity,
            after: typeof msg.after === "number" ? msg.after : -Infinity,
            limit: Math.min(300, Math.max(1, Number(msg.limit ?? 50))),
            verbs: Array.isArray(msg.verbs) && msg.verbs.length ? new Set(msg.verbs.map(String)) : null,
          });
          ws.send(JSON.stringify({ type: "history", reqId: msg.reqId ?? null, ...r }));
          break;
        }
        case "debug": {
          // The flight recorder (World.debugLog): why things bounced —
          // denials, rejections, rate limits, reaction outcomes. Open to
          // spectators for the same reason history is: the log is public,
          // so the reasons things failed to reach it are public too.
          if (!c.world) return;
          const limit = Math.min(300, Math.max(1, Number(msg.limit ?? 50)));
          if (msg.behavior != null) {
            // one script's own log ring + status — the author's console
            const b = c.world.bhv.inspect(String(msg.behavior));
            ws.send(JSON.stringify({ type: "debug", reqId: msg.reqId ?? null,
              behavior: String(msg.behavior),
              status: b?.status ?? "no such behavior",
              events: (b?.ring ?? []).slice(-limit).map((r) => ({ ts: r.ts, kind: "script-log", line: r.line })) }));
            break;
          }
          if (msg.behaviors) {   // the roster: what runs here, and is it alive
            ws.send(JSON.stringify({ type: "debug", reqId: msg.reqId ?? null,
              events: c.world.bhv.list().map((b) => ({ ts: 0, kind: "behavior", ...b })) }));
            break;
          }
          const kinds = Array.isArray(msg.kinds) && msg.kinds.length ? new Set(msg.kinds.map(String)) : null;
          const events = c.world.debugLog
            .filter((e) => !kinds || kinds.has(String(e.kind)))
            .slice(-limit);
          ws.send(JSON.stringify({ type: "debug", reqId: msg.reqId ?? null, events }));
          break;
        }
        case "whisper": {
          if (!WHISPERS_ENABLED) {
            ws.send(JSON.stringify({ type: "error", error: "whispers are disabled in this world" }));
            break;
          }
          // A private message between two bodies.
          //
          // It must NEVER reach the world log. The log is append-only, public,
          // replayed in full to every future joiner, and forkable — a whisper
          // written there would be permanently readable by everyone who ever
          // enters this world, including people who weren't born yet when it
          // was sent. So whispers route point-to-point and are never appended.
          //
          // The cost of that choice is durability: there is no log to replay
          // from. So an undelivered whisper is held in MEMORY for a while and
          // handed over when its recipient next joins. Lost on restart, which
          // is the honest trade — a private message should be more willing to
          // vanish than to become permanent public record.
          if (!c.world || c.spectator) return;
          const to = String(msg.to ?? "").slice(0, 64);
          const text = String(msg.text ?? "").slice(0, 4000);
          if (!to || !text) return;
          const packet = { type: "whisper", from: c.id, to, text, ts: Date.now() };
          const targets = [...c.world.clients].filter((o) => o.id === to && !o.spectator);
          for (const t of targets) t.ws.send(JSON.stringify(packet));
          ws.send(JSON.stringify({ ...packet, echo: true })); // your own sent copy
          if (!targets.length) {
            const key = whisperKey(c.world.name, to);
            const q = pendingWhispers.get(key) ?? [];
            q.push(packet);
            while (q.length > 20) q.shift();
            pendingWhispers.set(key, q);
            ws.send(JSON.stringify({ type: "error", error: `${to} isn't here — they'll get it when they arrive` }));
          }
          break;
        }
        case "anim": {
          // A one-off animation: relayed once to everyone, never logged. It is
          // a moment, not a fact about the world — presence, like a pose. Small
          // enough (a few KB of quaternions) that it needs no store; big enough
          // that it must not ride the 15Hz pose stream, so it is its own
          // message sent once.
          if (!c.world || c.spectator) return;
          if (typeof msg.dur !== "number" || typeof msg.tracks !== "object") return;
          // one guard against a pathological payload — poses are tiny, so
          // anything approaching a real asset is a mistake or an attack
          if (JSON.stringify(msg.tracks).length > 64_000) {
            ws.send(JSON.stringify({ type: "error", error: "animation too large — keep custom clips small and sparse" }));
            return;
          }
          c.world.broadcast({ type: "anim", id: c.id, dur: msg.dur, tracks: msg.tracks, loop: !!msg.loop }, c);
          break;
        }
        case "puppet": {
          // Ask another body to hold a pose or play an animation. Deliberately
          // ROUTED to the target rather than broadcast: DESIGN.md's invariant
          // is that each client owns its own avatar, so a puppet is a REQUEST
          // its target applies to itself (and then broadcasts through its own
          // presence, like any other input) — not a pose asserted onto it from
          // outside. The target decides whether to honour it.
          if (!c.world || c.spectator) return;
          const to = String(msg.target ?? "").slice(0, 64);
          const tc = [...c.world.clients].find((o) => o.id === to && !o.spectator);
          if (!tc) { ws.send(JSON.stringify({ type: "error", error: `${to || "target"} isn't here to pose` })); return; }
          // ragdoll rides as `true` (undirected knock-over, the old wire) or
          // {lean:[x,y,z]} m/s — which way the shove sends them. Sanitize to
          // exactly those two shapes; the receiver caps magnitude for itself.
          let rag: true | { lean: number[] } | null = null;
          if (msg.ragdoll === true) rag = true;
          else if (msg.ragdoll && Array.isArray((msg.ragdoll as { lean?: unknown }).lean)) {
            const lean = ((msg.ragdoll as { lean: unknown[] }).lean).map(Number);
            if (lean.length === 3 && lean.every(Number.isFinite)) rag = { lean };
          }
          tc.ws.send(JSON.stringify({ type: "puppet", by: c.id, pose: msg.pose ?? null, anim: msg.anim ?? null, ragdoll: rag }));
          break;
        }
        case "bc": {
          // dev crash forensics: keep the client's last N breadcrumbs in
          // memory, printed on disconnect (see close). Never persisted.
          const ring = (c.bcRing ??= []);
          ring.push(String(msg.tag ?? "").slice(0, 64));
          if (ring.length > 40) ring.shift();
          return;
        }
        case "lease": {
          // Entity animation leases — docs/leases.md. The server arbitrates
          // (objects have no owning client), remembers the last streamed
          // transform, and COMMITS it when the holder releases, vanishes, or
          // goes stale. It never simulates: transforms in, transforms out,
          // one `place` verb at rest. Presence semantics: never logged.
          if (!c.world || c.spectator) return;
          const w = c.world;
          const id = String(msg.id ?? "").slice(0, 64);
          const op = String(msg.op ?? "");
          if (!id) return;

          const sane = (a: unknown, n: number): number[] | null => {
            if (!Array.isArray(a) || a.length !== n) return null;
            const v = (a as unknown[]).map(Number);
            return v.every(Number.isFinite) ? v : null;
          };
          if (op === "claim") {
            if (!w.state.entities[id]) {
              ws.send(JSON.stringify({ type: "lease", op: "denied", id, why: "no such entity" }));
              return;
            }
            // physical play is USING the world (rank 0), like `use` — a
            // per-world knob can gate this later without protocol changes
            const cur = w.leases.get(id);
            if (cur && cur.holder !== c) {
              const stale = Date.now() - cur.lastAt > 5000;
              // proximity take: you can take what you can reach — the ball
              // being dribbled past you is kickable, the one across the
              // field is not. Distance vs the OBJECT's live position.
              const at = cur.lastState?.p ?? w.state.entities[id].pos;
              const me = c.lastPose?.p;
              const near = !!me && Math.hypot(me[0] - at[0], me[2] - at[2]) <= 3.5;
              if (!stale && !(msg.take && near)) {
                ws.send(JSON.stringify({ type: "lease", op: "denied", id, why: `${cur.holder.id} is animating it` }));
                return;
              }
              cur.holder.ws.send(JSON.stringify({ type: "lease", op: "lost", id, to: c.id }));
            }
            // per-client cap: a runaway plugin must not lease a whole world
            let held = 0;
            for (const L of w.leases.values()) if (L.holder === c) held++;
            if (held >= 8 && !w.leases.has(id)) {
              ws.send(JSON.stringify({ type: "lease", op: "denied", id, why: "too many live leases — release something" }));
              return;
            }
            w.leases.set(id, { holder: c, lastState: w.leases.get(id)?.lastState ?? null, lastAt: Date.now() });
            ws.send(JSON.stringify({ type: "lease", op: "granted", id, ...(w.leases.get(id)!.lastState ? { from: w.leases.get(id)!.lastState } : {}) }));
            w.broadcast({ type: "lease", op: "claimed", id, by: c.id }, c);
            return;
          }

          const L = w.leases.get(id);
          if (!L || L.holder !== c) return;      // a lost holder's tail, dropped

          if (op === "state") {
            const p = sane(msg.p, 3);
            if (!p) return;
            const yaw = Number.isFinite(Number(msg.yaw)) ? Number(msg.yaw) : undefined;
            const q = sane(msg.q, 4) ?? undefined;
            L.lastState = { p, ...(yaw != null ? { yaw } : {}), ...(q ? { q } : {}) };
            L.lastAt = Date.now();
            w.broadcast({ type: "lease", op: "state", id, by: c.id, p, ...(yaw != null ? { yaw } : {}), ...(q ? { q } : {}) }, c);
            return;
          }
          if (op === "release") {
            w.settleLease(id, { p: sane(msg.p, 3), yaw: Number.isFinite(Number(msg.yaw)) ? Number(msg.yaw) : null });
            return;
          }
          return;
        }
        case "bodydrag": {
          const okSim = (v: any) => {
            if (!v || typeof v !== "object") return false;
            // §15.1's destructure bug lived here: `q: v.v` — a binding named
            // for quats fed the VELOCITIES. There are no quats anywhere on
            // this path: both engines' snapshot() (rapierdoll.js/ragdoll.js)
            // hand over {j, p, v} — joint names, positions and velocities,
            // three finite numbers per joint each — so validate exactly
            // that, under its real name. Accepted payloads are unchanged.
            const { j, p, v: vel } = { j: v.j, p: v.p, v: v.v };
            if (!Array.isArray(j) || j.length === 0 || j.length > 24) return false;
            if (!Array.isArray(p) || !Array.isArray(vel)) return false;
            if (p.length !== j.length * 3 || vel.length !== j.length * 3) return false;
            return j.every((n: unknown) => typeof n === "string" && n.length <= 24)
              && p.every((n: unknown) => Number.isFinite(n))
              && vel.every((n: unknown) => Number.isFinite(n));
          };
          // Interactive ragdoll drag — the takeover stream. A dragger runs the
          // body's sim on ITS machine and streams the result to the body's
          // owner, who applies it to itself and rebroadcasts through normal
          // presence (one source of truth; everyone else needs no new code).
          // Targeted like puppet, presence-plane semantics: never logged,
          // never queued, relayed as-is. The OWNER decides whether to honour
          // any of it — grab, stream and release are all just requests.
          if (!c.world || c.spectator) return;
          const raw = String(msg.pose ? JSON.stringify(msg.pose) : "");
          if (raw.length > 24_000) return;      // a pose is tiny; anything else is an attack
          const to = String(msg.target ?? "").slice(0, 64);
          const tc = [...c.world.clients].find((o) => o.id === to && !o.spectator);
          if (process.env.BD_DEBUG) console.log(`[bd] ${c.id} -> ${to} (${msg.grab ? "grab" : msg.end ? "end" : "sample"}) ${tc ? "relayed" : `NO TARGET among [${[...c.world.clients].map((o) => o.id).join(",")}]`}`);
          if (!tc) return;                       // dragging the departed: silently moot
          tc.ws.send(JSON.stringify({
            type: "bodydrag", by: c.id,
            ...(msg.grab != null ? { grab: msg.grab } : {}),
            ...(msg.end != null ? { end: true } : {}),
            ...(msg.pose != null ? { pose: msg.pose } : {}),
            ...(Array.isArray(msg.p) ? { p: (msg.p as unknown[]).slice(0, 3).map(Number) } : {}),
            ...(msg.yaw != null ? { yaw: Number(msg.yaw) } : {}),
            // persistent pins: nail-here (rides a release), pull-this-nail,
            // and the owner's current pin set (sent back on grab accept so
            // the dragger's takeover sim keeps enforcing the other nails)
            // the handover: joint names, positions and velocities, so the
            // receiver CONTINUES the sim instead of rebuilding a guess from
            // the bones. Bounded like everything else on this path — 24 joints,
            // three finite numbers each, or it does not travel.
            ...(okSim(msg.sim) ? { sim: msg.sim } : {}),
            ...(msg.pinAt != null ? { pinAt: msg.pinAt } : {}),
            ...(msg.unpin != null ? { unpin: msg.unpin } : {}),
            ...(Array.isArray(msg.pins) ? { pins: (msg.pins as unknown[]).slice(0, 16) } : {}),
          }));
          break;
        }
        case "caption": {
          // Live speech pacing: a voice agent STREAMS by nature, but streaming
          // into the log turns one utterance into six fragmentary pings for
          // every listening agent. So the sentences ride presence — relayed,
          // never persisted, same doctrine as typing — and the complete
          // utterance lands in the log as ONE say when the voice finishes.
          // Agents perceive a paragraph; humans watch it being spoken.
          // Presence lanes are the voice surface's pacing channel (#57, review
          // finding 8): the bound voice leg owns the audio clock, so it — not
          // the primary, which has no playback timing — paces captions and
          // raises the mic glyph. Same admission the attest gate uses: the
          // voice surface, bound to the identity's authority. All other aux
          // legs stay presence-mute spectators.
          const voiceLeg = c.surface === "voice" && c.auxBound === true;
          if (!c.world || (c.spectator && !voiceLeg)) return;
          const capText = String(msg.text ?? "").slice(0, 500);
          if (!capText) return;
          const capUtt = Number(msg.utt);
          c.world.broadcast({ type: "caption", id: c.id, text: capText,
            utt: Number.isSafeInteger(capUtt) && capUtt >= 0 ? capUtt : 0 }, c);
          break;
        }
        // ── SFU signaling (VOICE_TRANSPORT=sfu) ──────────────────────────
        // Deliberately SEPARATE verbs from `rtc`: rtc is client↔client and
        // routes by `to`, whereas here one end IS the sequencer, so there is no
        // recipient to address and no fanout to get wrong. Same properties
        // though — never logged, SDP-sized cap, dropped if the leg is gone.
        case "sfu-answer": {
          if (!c.world || voiceTransport() !== "sfu") return;
          if (typeof msg.sdp !== "string" || msg.sdp.length > 20000) return;
          sfuAcceptAnswer(c.world.name, c.id, msg.sdp);
          return;
        }
        case "sfu-ice": {
          if (!c.world || voiceTransport() !== "sfu") return;
          sfuAcceptIce(c.world.name, c.id, msg.candidate);
          return;
        }
        case "sfu-pos": {
          // Position feed for the proximity gate. OPTIONAL by design: the gate
          // fails open on unknown/stale positions, so a client that never sends
          // these is never gated — which is what keeps this from being a way to
          // silence someone by withholding data.
          if (!c.world || voiceTransport() !== "sfu") return;
          const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
          sfuSetPosition(c.world.name, c.id, n(msg.x), n(msg.y), n(msg.z));
          return;
        }
        case "sfu-want-negotiate": {
          // The client added a track and needs an offer. It ASKS rather than
          // offering, because the server must own every offer (glare).
          if (!c.world || voiceTransport() !== "sfu") return;
          sfuNegotiate(c.world.name, c.id, (payload) => ws.send(JSON.stringify(payload)));
          return;
        }
        case "rtc": {
          // Voice/media signaling: point-to-point like a whisper and never
          // logged for the same reason — but unlike a whisper, a stale SDP is
          // worthless (an offer for a peer who left answers nothing), so there
          // is no pending queue: absent recipient = silently dropped.
          const aux = c.surface && c.surface !== "world";
          if (!c.world || (c.spectator && !aux)) return;
          const rto = String(msg.to ?? "").slice(0, 64);
          if (!rto || msg.payload == null) return;
          if (JSON.stringify(msg.payload).length > 20000) return; // SDP-sized, not file-sized
          // Per-surface ADDRESSING (review finding 7): a voice leg IS an rtc
          // endpoint, but the old any-leg fanout delivered an offer meant for
          // X's voice leg to X's browser primary too — whose per-id state
          // machine answers offers unconditionally, so both of the offerer's
          // legs got answers: SDP glare precisely in the human-with-voice-leg
          // case the feature enables. `toSurface` names the target leg;
          // omitted = "world", which is byte-identical to today's mesh (the
          // current voice.js neither sends nor reads it). fromGen/fromSurface
          // are stamped for the receiving side's (id, surface, gen) peer
          // keying — today's mesh client reads neither (it keys by id alone);
          // the consumers arrive with the sidecar/relay client half (#104),
          // and stamping now means old servers never have to be told apart.
          const toSurface = String(msg.toSurface ?? "world").toLowerCase().slice(0, 16) || "world";
          const rpacket = JSON.stringify({ type: "rtc", from: c.id, to: rto, payload: msg.payload,
            fromGen: c.gen, fromSurface: c.surface ?? "world" });
          for (const t of c.world.clients)
            if (t.id === rto && (t.surface ?? "world") === toSurface
                && (!t.spectator || (t.surface && t.surface !== "world"))) t.ws.send(rpacket);
          return;
        }
        case "relay-cred": {
          // #104 phase-1: mint the least-authority media credential (A1). The
          // asker must be an ADMITTED identity — the embodied primary (its own
          // mic/tts publishes on its relay leg) — and the leg it earns is a
          // surface session: gen from the same counter as every leg, announced
          // by the same transition event, retired by the same funnel. The
          // LiveKit API secret never rides this reply; only the scoped JWT.
          if (!c.world) return;
          if (!relayEnabled()) { ws.send(JSON.stringify({ type: "error", error: "no voice relay configured" })); return; }
          if (c.spectator || (c.surface ?? "world") !== "world") {
            ws.send(JSON.stringify({ type: "error", error: "relay-cred is the embodied primary's ask" }));
            return;
          }
          const wantPub = msg.publish !== false;      // scopes are askable-down, never up
          const mediaGen = ++GEN;
          if (voiceTransport() === "sfu") {
            // No JWT to mint and no external service to reach, so this is
            // synchronous — but it announces through the SAME transition event
            // and takes a gen from the SAME counter, because a surface session
            // is a surface session regardless of what carries its audio.
            registerSfuSender(c.id, (payload) => ws.send(JSON.stringify(payload)));
            const cred = mintSfuCredential(c.world.name, c.id, c.gen!, mediaGen);
            const transition = JSON.stringify({ type: "surface-transition",
              id: c.id, surface: "voice-relay", gen: mediaGen, retired: null });
            for (const t of c.world.clients) if (t !== c) t.ws.send(transition);
            ws.send(JSON.stringify({ type: "relay-cred", ...cred, gen: mediaGen,
              service: { enabled: true, state: "live", transport: "sfu" } }));
            return;
          }
          mintRelayCredential(c.world.name, c.id, c.gen!, mediaGen,
            { publish: wantPub, subscribe: msg.subscribe !== false })
            .then((cred) => {
              if (!c.world) return;
              const transition = JSON.stringify({ type: "surface-transition",
                id: c.id, surface: "voice-relay", gen: mediaGen, retired: null });
              for (const t of c.world.clients) if (t !== c) t.ws.send(transition);
              ws.send(JSON.stringify({ type: "relay-cred", ...cred, gen: mediaGen,
                service: relayServiceState() }));
            })
            .catch((err) => {
              console.error(`[relay] mint for ${c.id} failed`, err);
              ws.send(JSON.stringify({ type: "error", error: "relay credential mint failed" }));
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
          if (voiceTransport() === "sfu") {
            const r = setSfuConsent(c.world.name, c.id, c.gen ?? 0, msg.recv === true);
            ws.send(JSON.stringify({ type: "voice-consent", recv: msg.recv === true,
              applied: r.changed, ...(r.reason ? { note: r.reason } : {}) }));
            return;
          }
          setListenerConsent(c.world.name, c.id, c.gen ?? 0, msg.recv === true)
            .then((r) => ws.send(JSON.stringify({ type: "voice-consent", recv: msg.recv === true, applied: r.changed, ...(r.reason ? { note: r.reason } : {}) })))
            .catch((err) => console.error(`[relay] consent for ${c.id} failed`, err));
          return;
        }
        case "attest": {
          // B1 (#57): the per-utterance performance receipt. ONLY message an
          // aux media leg is allowed beyond signalling — and only for its own
          // identity's says. The server verifies, then broadcasts `performed`
          // (presence-grade, unlogged — like typing): listeners that were
          // HOLDING local TTS on the author's voice capability now skip;
          // everyone else ignores it. No boolean is inferred from presence
          // anywhere: capability gates the hold, this receipt confirms the
          // performance, a timeout recovers the fallback.
          if (!c.world) return;
          // B3: performance attestation is the VOICE surface's privilege alone,
          // and only from a leg BOUND to the identity's authority (the same B1
          // admission test — token bearer OR the primary's own login sub). A
          // vr-hands or otherwise non-voice aux leg cannot mint a voice receipt;
          // and a sub-bound human's voice leg CAN (Opus-5 review: gating on
          // tokenVerified alone barred exactly that legitimate leg).
          if (c.surface !== "voice" || c.auxBound !== true) {
            ws.send(JSON.stringify({ type: "error", error: "attest is for the identity's bound voice leg" }));
            return;
          }
          const seq = Number(msg.seq);
          const digest = String(msg.digest ?? "").slice(0, 64);
          if (!Number.isSafeInteger(seq) || !digest) return;
          // B2: the leg must attest under the generation it currently holds. A
          // completion born under a RETIRED leg and submitted after reconnect
          // carries the old gen; without this it would be broadcast stamped with
          // the successor's c.gen and relabelled as the live generation.
          if (msg.gen !== c.gen) {
            ws.send(JSON.stringify({ type: "error", error: "attest surface-generation mismatch" }));
            return;
          }
          // the say must exist, be recent, and be THIS identity's
          // recentSays, not entries[]: fold() empties entries every FOLD_EVERY
          // appends, and a receipt for a folded-out say must still land
          // (review finding 3). Misses answer with an error frame — every
          // other refusal in this handler does, and a leg whose receipt was
          // discarded silently cannot even detect it.
          const e = c.world.recentSays.find((x) => x.seq === seq);
          if (!e || e.verb !== "say" || e.actor !== c.id) {
            ws.send(JSON.stringify({ type: "error", error: "attest names no recent say of yours" }));
            return;
          }
          if (Date.now() - (e.ts ?? 0) > 300_000) return;   // stale receipt: refuse
          const text = String((e.args as Record<string, unknown>)?.text ?? "");
          const want = new Bun.CryptoHasher("sha256").update(text).digest("hex");
          if (digest !== want) {
            ws.send(JSON.stringify({ type: "error", error: "attest digest mismatch" }));
            return;
          }
          const performed = JSON.stringify({ type: "performed",
            id: c.id, seq, gen: c.gen, surface: c.surface });
          for (const t of c.world.clients) t.ws.send(performed);
          return;
        }
        case "typing": {
          // Pure presence: who is composing, right now. Never logged, never
          // queued, and irrelevant a second later.
          // Presence lanes are the voice surface's pacing channel (#57, review
          // finding 8): the bound voice leg owns the audio clock, so it — not
          // the primary, which has no playback timing — paces captions and
          // raises the mic glyph. Same admission the attest gate uses: the
          // voice surface, bound to the identity's authority. All other aux
          // legs stay presence-mute spectators.
          const voiceLeg = c.surface === "voice" && c.auxBound === true;
          if (!c.world || (c.spectator && !voiceLeg)) return;
          // state: optional social affordance glyph for agents (ear = I hear
          // you, think = composing a reply, tool = working). Whitelisted so
          // presence stays presence.
          // mic = a live voice is coming from this body right now (R, 23:30)
          const st = typeof msg.state === "string" && ["ear", "think", "tool", "mic"].includes(msg.state) ? msg.state : null;
          c.world.broadcast({ type: "typing", id: c.id, to: msg.to ?? null, ...(st ? { state: st } : {}) }, c);
          break;
        }
        case "drag": {
          // Transient build feedback. DESIGN.md is explicit that dragging is
          // presence traffic and only the RELEASE commits a log entry — so this
          // is relayed and never persisted, exactly like a pose. Without it,
          // everyone else sees objects teleport on release instead of move.
          if (!c.world || c.spectator) return;
          // the RELEASE is a `place` verb the gate above checks; the live drag
          // must agree with it or visitors can slide props they can't commit
          if (ROLE_RANK[rightsOf(c.world.state, c.id, c.sub).role] < 1) return;
          c.world.broadcast({ type: "drag", id: msg.id, pos: msg.pos, yaw: msg.yaw, by: c.id }, c);
          break;
        }
        case "pose": {
          if (!c.world || c.spectator) return;
          c.lastPose = msg.pose;
          // presence: batched into stage frames by the tick loop, never persisted
          c.world.dirty.set(c.id, msg.pose);
          break;
        }
        case "snap-result": {
          const pending = pendingSnaps.get(msg.id);
          if (!pending || !c.renderer) return;
          pendingSnaps.delete(msg.id);
          if (typeof msg.dataUrl === "string" && msg.dataUrl.startsWith("data:image/png;base64,")) {
            pending.resolve({ ok: true, png: Buffer.from(msg.dataUrl.slice("data:image/png;base64,".length), "base64") });
          } else {
            pending.resolve({ ok: false, err: String(msg.error ?? "renderer returned no image"), status: 502 });
          }
          break;
        }
        case "world-fork": {
          // Copy the world you are standing in to a new name. Owner-only
          // (rank 2, like shaping terrain): the fork carries ALL history —
          // every chat line ever said here — so duplicating it is the owner's
          // call, not any visitor's. WORLD_ADMIN passes everywhere, which is
          // also the only door for pre-permissions OPEN worlds.
          if (!c.world) return;
          if (c.spectator) {
            ws.send(JSON.stringify({ type: "error", error: "spectators can't copy worlds — join embodied" }));
            return;
          }
          const rights = rightsOf(c.world.state, c.id, c.sub);
          if (ROLE_RANK[rights.role] < 2) {
            ws.send(JSON.stringify({ type: "error", error: `copying a world needs its owner — you are a ${rights.role} here` }));
            return;
          }
          const to = String(msg.to ?? "").slice(0, 64);
          const r = forkWorld(c.world, to);
          if (!r.ok) {
            ws.send(JSON.stringify({ type: "error", error: r.err }));
            return;
          }
          console.log(`[world:${c.world.name}] copied → "${to}" by ${c.id}`);
          ws.send(JSON.stringify({ type: "world-forked", from: c.world.name, to }));
          break;
        }
        case "world-reset": {
          // Erase the world you are standing in back to zero. Owner-only, and
          // the message must carry the world's own name — the client makes you
          // type it, the server refuses anything else, so a stray click can
          // never be the thing that empties a world. History is archived, not
          // destroyed (see World.reset).
          if (!c.world) return;
          if (c.spectator) {
            ws.send(JSON.stringify({ type: "error", error: "spectators can't erase worlds — join embodied" }));
            return;
          }
          const rights = rightsOf(c.world.state, c.id, c.sub);
          if (ROLE_RANK[rights.role] < 2) {
            ws.send(JSON.stringify({ type: "error", error: `erasing a world needs its owner — you are a ${rights.role} here` }));
            return;
          }
          if (String(msg.name ?? "") !== c.world.name) {
            ws.send(JSON.stringify({ type: "error", error: `confirmation mismatch — reset must name "${c.world.name}"` }));
            return;
          }
          const w = c.world;
          // Who owned it, before the log goes: a reset world must not become a
          // land-rush — the same owners hold the fresh one. (An ADMIN resetting
          // an OPEN world leaves it open: no owners existed, none are minted.)
          const owners = Object.entries(w.state.roles ?? {})
            .filter(([id, r2]) => id !== "*" && r2.role === "owner")
            .map(([id]) => id);
          const arch = w.reset();
          for (const id of owners) {
            const entry = w.append("world", "grant", { id, role: "owner", gen: true });
            w.broadcast({ type: "log", entry });
          }
          console.log(`[world:${w.name}] ERASED to zero by ${c.id} — history archived in ${arch}`);
          w.broadcast({ type: "world-reset", world: w.name, by: c.id });
          break;
        }
        case "world-bans": {
          // Who is banned from the world you are standing in. Available to
          // anyone present — bans are log entries and the log is public; a
          // list nobody can read is not an audit trail.
          if (!c.world) return;
          const list = Object.entries(c.world.state.bans ?? {}).map(([id, b]) =>
            `${id} — by ${b.by}, ${new Date(b.ts).toISOString().slice(0, 10)}${b.reason ? `: ${b.reason}` : ""}`);
          ws.send(JSON.stringify({ type: "mod", text: list.length
            ? `banned from "${c.world.name}" (${list.length}):\n${list.join("\n")}`
            : `nobody is banned from "${c.world.name}"` }));
          break;
        }
        case "global-ban":
        case "global-unban":
        case "global-bans": {
          // Instance-wide moderation. Not world verbs — there is no global log
          // — so these are messages, gated on WORLD_ADMIN and persisted in
          // .bans.json (same posture as .sessions.json). Replies come back as
          // `mod` messages; refusals as `error`, like everything else.
          if (!isAdminId(c.id, c.sub)) {
            ws.send(JSON.stringify({ type: "error", error: "global moderation needs WORLD_ADMIN — per-world /ban is the owner tool" }));
            return;
          }
          if (msg.type === "global-bans") {
            const list = Object.entries(globalBans).map(([id, b]) =>
              `${id}${b.sub ? ` (${b.sub})` : ""} — by ${b.by}, ${new Date(b.ts).toISOString().slice(0, 10)}${b.reason ? `: ${b.reason}` : ""}`);
            ws.send(JSON.stringify({ type: "mod", text: list.length ? `global bans (${list.length}):\n${list.join("\n")}` : "no global bans" }));
            return;
          }
          const id = String(msg.id ?? "").trim().slice(0, 64);
          if (!id || id === "*") {
            ws.send(JSON.stringify({ type: "error", error: `${msg.type} wants {id, reason?} — a specific participant, not everyone` }));
            return;
          }
          if (msg.type === "global-unban") {
            const key = id.toLowerCase();
            const had = key in globalBans || Object.values(globalBans).some((b) => b.sub === id);
            delete globalBans[key];
            for (const [k, b] of Object.entries(globalBans)) if (b.sub === id) delete globalBans[k];
            saveGlobalBans();
            console.log(`[mod] ${c.id} lifted global ban on ${id}${had ? "" : " (was not banned)"}`);
            ws.send(JSON.stringify({ type: "mod", text: had ? `${id} is no longer banned globally` : `${id} was not globally banned` }));
            return;
          }
          // global-ban
          if (isAdminId(id)) {
            ws.send(JSON.stringify({ type: "error", error: `${id} is a world operator — remove them from WORLD_ADMIN first` }));
            return;
          }
          if (id.toLowerCase() === c.id.toLowerCase()) {
            ws.send(JSON.stringify({ type: "error", error: "you cannot moderate yourself" }));
            return;
          }
          const reason = msg.reason != null ? String(msg.reason).slice(0, 200) : undefined;
          // catch the durable principal if the target is connected anywhere
          let tsub: string | undefined;
          for (const w2 of worlds.values()) {
            const t = [...w2.clients].find((o) => o.id.toLowerCase() === id.toLowerCase());
            if (t?.sub) { tsub = t.sub; break; }
          }
          globalBans[id.toLowerCase()] = { by: c.id, ts: Date.now(), ...(reason ? { reason } : {}), ...(tsub ? { sub: tsub } : {}) };
          saveGlobalBans();
          let expelled = 0;
          for (const w2 of worlds.values()) {
            for (const other of [...w2.clients]) {
              if (other === c) continue;
              if (other.id.toLowerCase() !== id.toLowerCase() && !(tsub && other.sub === tsub)) continue;
              expel(w2, other, `you were banned from these worlds by ${c.id}${reason ? ` — ${reason}` : ""}`);
              expelled++;
            }
          }
          console.log(`[mod] ${c.id} banned ${id} globally${reason ? ` (${reason})` : ""}${expelled ? ` — ${expelled} session(s) disconnected` : ""}`);
          ws.send(JSON.stringify({ type: "mod", text: `${id} is banned from all worlds${reason ? ` — ${reason}` : ""}${expelled ? ` (${expelled} live session${expelled === 1 ? "" : "s"} disconnected)` : ""}` }));
          return;
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
setInterval(() => {
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
}, FRAME_MS);

// Stale-lease sweep: a holder that stops streaming (hung tab, wedged plugin)
// loses the object — committed at its last known transform, like a
// disconnect. Nothing hovers forever; nothing stays possessed.
setInterval(() => {
  const now = Date.now();
  for (const w of worlds.values()) {
    // per-world guard (house rule 3): settleLease appends to disk
    try {
      for (const [id, L] of [...w.leases]) {
        if (now - L.lastAt > 10_000) {
          w.debug("lease-swept", { id, holder: L.holder.id });
          w.settleLease(id);
        }
      }
    } catch (err) { console.error(`[world:${w.name}] lease sweep`, err); }
  }
}, 5_000);

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
