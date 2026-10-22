// eidoverse-worlds sequencer — the ws message table (R2, survey §2.2).
//
// The unsplit ws switch, as a handler table: one entry per message type,
// bodies moved VERBATIM from server.ts (the §15 verbs.ts precedent, and the
// same cycle break — this module never imports server.ts; what lives with
// the session, `expel`, arrives through the ctx). The preamble that guards
// every message (rate cap, superseded unmap, the never-throw envelope) and
// the `join` case (the session's front door — admission, takeover, the
// snapshot) stay in server.ts, where the source-text gates that pin
// settledPose expect them.
//
// A suite regexes THIS file's source now (it used to pin server.ts):
// tools/voice-wiring-test.ts — moving a body again means moving its patterns
// with it.

import { WORLDS_DIR } from "./config.ts";
import { LIMITS } from "./limits.ts";
import { sanePose } from "./posecheck.ts";
import { gateReach } from "./reachgate.ts";
import { BODY_RANGE } from "../shared/protocol/physconst.js";
import { currentIncarnation } from "./transport.ts";
import { isOperator } from "./operators.ts";
import { directoryFor, foldName } from "./directory.ts";
import { actorOf as actorIdOf } from "./requestwire.ts";
import { qNorm } from "../shared/rot.js";
import { decide as consentDecide, refusalWords } from "../shared/protocol/consent.js";
import { worlds, type World, type Client, authorityNow } from "./world.ts";
import { stateSampleError } from "../shared/presencewire.js";
import { snapshots } from "./snapshots.ts";
import { REMOVED_VERBS } from "../shared/protocol/verbspec.js";
import { globalBans, saveGlobalBans, banKey, ADDR_BAN_MS, bansLiftedBy } from "./moderation.ts";
import { isOwner } from "../shared/protocol/roles.js";

/** Who a presence message (puppet, bodydrag, typing) is FOR (security pass 3, H2). A sender that knows the
 *  identity names it by its opaque actor id (`targetActor` / `toActor` — every arrive carries one); then that identity's
 *  embodied leg is the target, whatever name anyone wears, and an actor who isn't here is simply not here (the name
 *  beside it is NOT a fallback: that would hand the message to whoever wears the name). A sender with no actor id (an
 *  agent, an older client) still reaches by name — names are unique among the people here and, for accounts, across
 *  the directory (server.ts join). A display name can't be shaped like an actor id (refused at join). */
const ACTOR_ID = /^u-[a-z2-7]{20}$/;

/** Body consent at the server (PROTOCOL L6; tools audit 10-07 "Body consent"): a presence act on someone else's body is
 *  checked against THEIR table in the authority's presence plane (shared/protocol/consent.js — a body that never sent
 *  one is Normal: everyone's shove, pose and displace are deny) and a sane range, BEFORE it's forwarded. The target's
 *  client still has the last word; this is so a stranger's packet never reaches a body that said no. 'ask' is refused
 *  with how to ask (the authority's `body` verb asks and delivers). Returns the refusal, or null to forward. */
export { BODY_RANGE };   // m between the two bodies' last frames
function bodyRefusal(c: Client, tc: Client, cls: "shove" | "pose" | "displace", kind: string): string | null {
  if (c.actorId && c.actorId === tc.actorId) return null;            // your own body
  const live = c.world?.log?.live;
  if (!live || !c.actorId || !tc.actorId) return `${tc.id}'s body isn't taking ${cls} right now`;
  const d = consentDecide(live.presence, c.actorId, tc.actorId, cls, live.now());
  if (d.mode === "deny") return refusalWords(tc.id, cls);   // one sentence whatever the cause (a pause, a per-person no, a tier): the real cause is theirs, not yours
  if (d.mode === "ask") return `${tc.id} asks first for ${cls}: ask with the body request — body {to: "${tc.actorId}", kind: "${kind}"}`;
  const a = c.lastPose?.p, b = tc.lastPose?.p, r = BODY_RANGE[cls];
  if (!Array.isArray(a) || !Array.isArray(b)) return `can't tell where you and ${tc.id} are yet — try again in a moment`;
  const m = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  if (!(m <= r)) return `${tc.id} is ${m.toFixed(1)} m away (${cls} reaches ${r} m) — walk closer`;
  return null;
}
function presenceTarget(w: World, actor: unknown, name: string, embodied = true): { tc: Client | null; byActor: boolean; actor: string | null } {
  const leg = (o: Client) => !o.spectator && (!embodied || (o.surface ?? "world") === "world");
  if (typeof actor === "string" && ACTOR_ID.test(actor)) return { tc: [...w.clients].find((o) => o.actorId === actor && leg(o)) ?? null, byActor: true, actor };
  return { tc: name ? [...w.clients].find((o) => o.id === name && leg(o)) ?? null : null, byActor: false, actor: null };
}

export type MsgCtx = {
  c: Client;
  ws: { send(data: string): void; close?(code?: number, reason?: string): void };
  now: number;
  expel: (w: World, target: Client, why: string) => void;
};

/** A page size asked for on the wire: a whole number from 1 to PAGE_MAX, else the default (NaN or 1.5 never equals a
 *  page's length, so readHistory's ceiling would never stop it). */
export const pageLimit = (v: unknown): number => { const n = Number(v ?? LIMITS.PAGE_DEFAULT); return Number.isInteger(n) && n >= 1 ? Math.min(LIMITS.PAGE_MAX, n) : LIMITS.PAGE_DEFAULT; };

export const MESSAGES: Record<string, (ctx: MsgCtx, msg: any) => void> = {
  "history": ({ c, ws, now, expel }, msg) => {
    // Speech is arrival-only (R 10-18): the log keeps every say, but a page holds only the lines said since this
    // connection arrived, unless it is an admin's (owner, operator: world.ts sayFloorFor), who reads the master log.
    // Spectators page like anyone else: what they were present for.
    if (!c.world) return;
    const r = c.world.readHistory({
      before: typeof msg.before === "number" ? msg.before : Infinity,
      after: typeof msg.after === "number" ? msg.after : -Infinity,
      limit: pageLimit(msg.limit),
      verbs: Array.isArray(msg.verbs) && msg.verbs.length ? new Set(msg.verbs.map(String)) : null,
      floor: c.world.sayFloorFor(c),
    });
    ws.send(JSON.stringify({ type: "history", reqId: msg.reqId ?? null, ...r }));
  },
  "debug": ({ c, ws, now, expel }, msg) => {
    // The flight recorder (World.debugLog): why things bounced —
    // denials, rejections, rate limits, reaction outcomes. Open to
    // spectators for the same reason history is: the log is public,
    // so the reasons things failed to reach it are public too.
    if (!c.world) return;
    const limit = pageLimit(msg.limit);
    if (msg.script != null) {
      // one script's own log ring + status — the author's console
      const b = c.world.scripts.inspect(String(msg.script));
      ws.send(JSON.stringify({ type: "debug", reqId: msg.reqId ?? null,
        script: String(msg.script),
        status: b?.status ?? "no such script",
        events: (b?.ring ?? []).slice(-limit).map((r) => ({ ts: r.ts, kind: "script-log", line: r.line })) }));
      return;
    }
    if (msg.scripts) {   // the roster: what runs here, and is it alive
      ws.send(JSON.stringify({ type: "debug", reqId: msg.reqId ?? null,
        events: c.world.scripts.list().map((b) => ({ ts: 0, kind: "script", ...b })) }));
      return;
    }
    const kinds = Array.isArray(msg.kinds) && msg.kinds.length ? new Set(msg.kinds.map(String)) : null;
    const events = c.world.debugLog
      .filter((e) => !kinds || kinds.has(String(e.kind)))
      .slice(-limit);
    ws.send(JSON.stringify({ type: "debug", reqId: msg.reqId ?? null, events }));
  },
  // whisper was removed (R 10-18): speech is public and arrival-only, and direct messages will live at the identity level
  // (client/profile), not in world chat. A client still sending one is told so in the registry's words (refusalcodes.js
  // `removed`); its text goes nowhere — not delivered, not held, not logged.
  "whisper": ({ ws }, msg) => {
    const r = REMOVED_VERBS.whisper;
    ws.send(JSON.stringify({ type: "error", error: `whisper was removed: ${r.why}`, about: "whisper", refused: { code: "removed", reason: `whisper was removed: ${r.why}`, fix: r.fix }, ...(msg?.reqId !== undefined ? { reqId: msg.reqId } : {}) }));
  },
  "anim": ({ c, ws, now, expel }, msg) => {
    // A one-off animation: relayed once to everyone, never logged. It is
    // a moment, not a fact about the world — presence, like a pose. Small
    // enough (a few KB of quaternions) that it needs no store; big enough
    // that it must not ride the 15Hz pose stream, so it is its own
    // message sent once.
    if (!c.world || c.spectator) return;
    // {stop: true} (R 10-17 16:26): every animation this body is playing fades out, back to what it holds beneath
    if (msg.stop === true) { c.world.broadcast({ type: "anim", id: c.id, stop: true }, c); return; }
    if (typeof msg.dur !== "number" || typeof msg.tracks !== "object") return;
    // one guard against a pathological payload — poses are tiny, so
    // anything approaching a real asset is a mistake or an attack
    if (JSON.stringify(msg.tracks).length > LIMITS.ANIM_TRACKS_BYTES) {
      ws.send(JSON.stringify({ type: "error", error: "animation too large — keep custom clips small and sparse" }));
      return;
    }
    // Legacy packets omit replace and replace the previous animation.
    // Modern merge requests must carry an explicit false.
    c.world.broadcast({ type: "anim", id: c.id, dur: msg.dur, tracks: msg.tracks, loop: !!msg.loop, replace: msg.replace !== false }, c);
  },
  "puppet": ({ c, ws, now, expel }, msg) => {
    // Ask another body to hold a pose or play an animation. Deliberately
    // ROUTED to the target rather than broadcast: DESIGN.md's invariant
    // is that each client owns its own avatar, so a puppet is a REQUEST
    // its target applies to itself (and then broadcasts through its own
    // presence, like any other input) — not a pose asserted onto it from
    // outside. The target decides whether to honour it.
    if (!c.world || c.spectator) return;
    const to = String(msg.target ?? "").slice(0, LIMITS.ID_LEN);
    const { tc } = presenceTarget(c.world, msg.targetActor, to);   // the identity named, or the name (H2)
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
    // consent and range at the server (L6): a knock-over is a shove, a pose or an animation is a pose
    const why = (rag ? bodyRefusal(c, tc, "shove", "shove") : null) ?? (msg.pose || msg.anim ? bodyRefusal(c, tc, "pose", msg.anim ? "anim" : "pose") : null);
    if (why) { ws.send(JSON.stringify({ type: "error", error: why })); return; }
    // merge: pose only the bones sent, over what the target already holds.
    // Absent means replace — what every sender meant before the flag existed.
    tc.ws.send(JSON.stringify({ type: "puppet", by: c.id, ...(c.actorId ? { byActor: c.actorId } : {}), pose: msg.pose ?? null, merge: msg.merge === true,
      anim: msg.anim ? { ...msg.anim, replace: msg.anim.replace !== false } : null, ragdoll: rag }));
  },
  "bc": ({ c, ws, now, expel }, msg) => {
    // dev crash forensics: keep the client's last N breadcrumbs in
    // memory, printed on disconnect (see close). Never persisted.
    const ring = (c.bcRing ??= []);
    ring.push(String(msg.tag ?? "").slice(0, LIMITS.ID_LEN));
    if (ring.length > LIMITS.BC_RING) ring.shift();
    return;
  },
  "bodydrag": ({ c, ws, now, expel }, msg) => {
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
    if (raw.length > LIMITS.BODYDRAG_POSE_BYTES) return;      // a pose is tiny; anything else is an attack
    const to = String(msg.target ?? "").slice(0, LIMITS.ID_LEN);
    const { tc } = presenceTarget(c.world, msg.targetActor, to, false);   // the identity named, or the name (H2)
    if (process.env.BD_DEBUG) console.log(`[bd] ${c.id} -> ${to} (${msg.grab ? "grab" : msg.end ? "end" : "sample"}) ${tc ? "relayed" : `NO TARGET among [${[...c.world.clients].map((o) => o.id).join(",")}]`}`);
    if (!tc) return;                       // dragging the departed: silently moot
    // a grab takes someone's body (move, L6): their consent and reach, at the server; the stream and release that follow
    // only ever go to a body that accepted the grab (its client answers with end otherwise)
    if (msg.grab != null) { const why = bodyRefusal(c, tc, "displace", "drag"); if (why) { ws.send(JSON.stringify({ type: "error", error: why })); return; } }
    // what follows a grab is held to the same table (review of #260): pulling a nail (unpin) takes the body as a
    // grab does, so it needs displace allowed or a drag this person granted; and once displace is deny, nothing more of a
    // drag reaches them ("only deny ends it": a grant by an ask outlives a later ask cell). An end always goes through.
    else if (msg.end == null && !(c.actorId && c.actorId === tc.actorId)) {
      // fails closed as bodyRefusal does: with no live log or no identity on either side, nothing can say yes
      const live = c.world.log?.live;
      if (!live || !c.actorId || !tc.actorId) { if (msg.unpin != null) ws.send(JSON.stringify({ type: "error", error: `${tc.id}'s body isn't taking displace right now` })); return; }
      const d = consentDecide(live.presence, c.actorId, tc.actorId, "displace", live.now());
      const granted = (live.presence as any)?.bodies?.[tc.actorId]?.draggedBy === c.actorId;
      if (d.mode === "deny" || (msg.unpin != null && d.mode !== "allow" && !granted)) {
        if (msg.unpin != null) ws.send(JSON.stringify({ type: "error", error: d.mode === "deny" ? refusalWords(tc.id, "displace") : `${tc.id} asks first for displace: ask with the body request — body {to: "${tc.actorId}", kind: "drag"}` }));
        return;
      }
    }
    tc.ws.send(JSON.stringify({
      type: "bodydrag", by: c.id, ...(c.actorId ? { byActor: c.actorId } : {}),
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
  },
  "caption": ({ c, ws, now, expel }, msg) => {
    // Live speech pacing: a voice agent STREAMS by nature, but streaming
    // into the log turns one utterance into six fragmentary pings for
    // every listening agent. So the sentences ride presence — relayed,
    // never persisted, same doctrine as typing — and the complete
    // utterance lands in the log as ONE say when the voice finishes.
    // A reader of the log gets one paragraph; a listener watches it spoken.
    // Any participant's voice paces this way (a person's TTS as well as a program's).
    // Presence lanes are the voice surface's pacing channel (#57, review
    // finding 8): the bound voice leg owns the audio clock, so it — not
    // the primary, which has no playback timing — paces captions and
    // raises the mic glyph. Same admission the attest gate uses: the
    // voice surface, bound to the identity's authority. All other aux
    // legs stay presence-mute spectators.
    const voiceLeg = c.surface === "voice" && c.auxBound === true;
    if (!c.world || (c.spectator && !voiceLeg)) return;
    const capText = String(msg.text ?? "").slice(0, LIMITS.CAPTION_LEN);
    if (!capText) return;
    const capUtt = Number(msg.utt);
    c.world.broadcast({ type: "caption", id: c.id, text: capText,
      utt: Number.isSafeInteger(capUtt) && capUtt >= 0 ? capUtt : 0 }, c);
  },
  // 🔴 the `rtc` handler is GONE (#104 phase-1 cutover, upstream 2026-08-16,
  // adopted in the anima merge): it was the MESH's point-to-point SDP lane
  // and its only client was voice.js, now deleted. It was deliberately
  // ungated on transport, which made it an unauthenticated relay with no
  // consumer. SFU signaling is separate verbs, inline in server.ts's switch
  // (they mint gens and ride upstream's active development).
  "attest": ({ c, ws, now, expel }, msg) => {
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
    if (Date.now() - (e.ts ?? 0) > LIMITS.ATTEST_FRESH_MS) return;   // stale receipt: refuse
    const text = String((e.args as Record<string, unknown>)?.text ?? "");
    const want = new Bun.CryptoHasher("sha256").update(text).digest("hex");
    if (digest !== want) {
      ws.send(JSON.stringify({ type: "error", error: "attest digest mismatch" }));
      return;
    }
    // 🔴 AMENDMENT 5: NAME THE RUNG (antra, 2026-08-13). What this receipt
    // proves is that an AUTHORIZED LEG CLAIMED it performed the utterance —
    // nothing about SFU ingress, forwarding, decoding, rendering, or
    // hearing. `rung` says so on the wire, so a consumer cannot quietly
    // read it as "this was heard"; the incarnation scopes the claim.
    const performed = JSON.stringify({ type: "performed",
      rung: "authorized-claim",
      incarnation: currentIncarnation(),
      id: c.id, seq, gen: c.gen, surface: c.surface });
    for (const t of c.world.clients) t.ws.send(performed);
    return;
  },
  "typing": ({ c, ws, now, expel }, msg) => {
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
    // `to` names someone present (presence is about the people here), or nobody
    // …by identity when the sender names one (toActor, H2), else by name
    const tt = presenceTarget(c.world, msg.toActor, typeof msg.to === "string" ? msg.to : "", false).tc;
    c.world.broadcast({ type: "typing", id: c.id, to: tt?.id ?? null, ...(tt?.actorId ? { toActor: tt.actorId } : {}), ...(st ? { state: st } : {}) }, c);
  },
  "drag": ({ c, ws, now, expel }, msg) => {
    // Transient build feedback. DESIGN.md is explicit that dragging is
    // presence traffic and only the RELEASE commits a log entry — so this
    // is relayed and never persisted, exactly like a pose. Without it,
    // everyone else sees objects teleport on release instead of move.
    if (!c.world || c.spectator) return;
    // the RELEASE is a `place` verb the gate above checks; the live drag
    // must agree with it or visitors can slide props they can't commit
    // (the authority's rights for the person's identity)
    // the build switch (roles S2), never the old protocol's rank table: an unknown role (moderator, a custom role) read undefined < 1 → false and passed
    if (!c.world.log!.rightsOf(actorIdOf(c)).can.build) return;   // the person's directory identity, never their name
    // q: the rotate gizmo turns about any axis (design §5); relayed only when
    // it is a usable quaternion (normalized), so a malformed one is never seen
    const q = qNorm(msg.q);
    // `end: true` is the last sample of a drag: receivers drop the claim it carried (docs/WIRE.md: a live drag is a claim)
    const scale = Array.isArray(msg.scale) && msg.scale.length === 3 && msg.scale.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1000) ? msg.scale : null;   // a scrubbed size
    c.world.broadcast({ type: "drag", id: msg.id, pos: msg.pos, yaw: msg.yaw, ...(q ? { q } : {}), ...(scale ? { scale } : {}), ...(msg.end === true ? { end: true } : {}), by: c.id }, c);
  },
  // spec/PHYSICS.md §5.1: a round-trip clock. {t0} (the asker's own clock, echoed untouched) → {t0, t}: t on the
  // world's AUTHORITY clock, the one that stamps entries' ts and frames' t. The asker's offset is t − (t0 + t1) / 2.
  "clock": ({ c, ws }, msg) => {
    const t0 = typeof msg.t0 === "number" && Number.isFinite(msg.t0) ? msg.t0 : null;
    ws.send(JSON.stringify({ type: "clock", t0, t: c.world ? authorityNow(c.world) : Date.now() }));
  },
  // spec/PHYSICS.md §4.3: the state-sync lane, RESERVED. {s: [sample, …]}, each {id, by, aseq, oseq, t, p, q, v, w, sleep}.
  // Checked now, so no client ships another shape under this name; refused until a live simulation authority exists.
  "state": ({ c, ws }, msg) => {
    if (!c.world || c.spectator) return;
    const list = Array.isArray(msg.s) ? msg.s : null;
    const why = !list || !list.length || list.length > 64 ? "state is {s: [sample, …]} (1–64 samples)" : list.map(stateSampleError).find((x) => x) ?? null;
    ws.send(JSON.stringify({ type: "error", error: why ? `state: ${why}` : "state samples are reserved: no live simulation authority runs here yet (PHYSICS §4.3)" }));
  },
  "pose": ({ c, ws, now, expel }, msg) => {
    if (!c.world || c.spectator) return;
    const pose = sanePose(msg.pose);
    if (!pose) {                                  // non-finite / malformed: never relayed (posecheck.ts)
      const cc = c as Client & { badPose?: number };
      cc.badPose = (cc.badPose ?? 0) + 1;
      if (cc.badPose === 1 || cc.badPose % 600 === 0)
        console.log(`[world:${c.world.name}] dropped non-finite pose from ${c.id} (×${cc.badPose})`);
      return;
    }
    gateReach(c, pose);                           // a hand on another body relays only with their consent (reachgate.ts)
    c.lastPose = pose;
    // presence: batched into stage frames by the tick loop, never persisted
    c.world.dirty.set(c.id, pose);
  },
  // a renderer (or an opt-in native donor) says what it can capture, and answers a `capture` request (server/snapshots.ts,
  // the broker: roaming renderers, PNG validation, the generation check)
  "capture-capabilities": ({ c }, msg) => { if (c.world) snapshots.configure(c, msg.capture); },
  "capture-result": ({ c }, msg) => { snapshots.receive(c, msg); },
  "world-bans": ({ c, ws, now, expel }, msg) => {
    // Who is banned from the world you are standing in. Available to
    // anyone present — the moderator's record is public in its outline (who,
    // when, by whom); a list nobody can read is not an audit trail.
    if (!c.world) return;
    // the moderation record is read by people holding a moderation power (research roles §7; review 10-07: anyone
    // here could read every ban and its reason), and by the authority's clock (a ban that ended isn't listed)
    if (c.world.log) { const e = c.actorId ? c.world.log.rightsOf(c.actorId) : null;
      if (!e || !(isOwner(e) || ["mute", "kick", "ban", "pauseScripts"].some((k) => e.permissions.includes(k)))) { ws.send(JSON.stringify({ type: "error", error: "the ban list is for people who hold a moderation power here" })); return; } }
    const S = c.world.log!.sanctions();
    const dir = directoryFor(WORLDS_DIR);
    const list = Object.entries(S).filter(([, x]) => (x as any).ban).map(([, x]) => (x as any).ban).map((m) =>
      `${dir.entry(m.who)?.name ?? m.who} — ${new Date(m.ts).toISOString().slice(0, 10)}${m.reason ? `: ${m.reason}` : ""}`);
    ws.send(JSON.stringify({ type: "mod", text: list.length
      ? `banned from "${c.world.name}" (${list.length}):\n${list.join("\n")}`
      : `nobody is banned from "${c.world.name}"` }));
  },
  "global-mod": ({ c, ws, now, expel }, msg) => {
    // Instance-wide moderation. Not world verbs — there is no global log
    // — so these are messages, gated on WORLD_ADMIN and persisted in
    // .bans.json (same posture as .sessions.json). Replies come back as
    // `mod` messages; refusals as `error`, like everything else.
    if (!isOperator(c.account)) {   // WORLD_ADMIN names ACCOUNTS (security review C3), never a typed name
      ws.send(JSON.stringify({ type: "error", error: "global moderation needs WORLD_ADMIN — per-world /ban is the owner tool" }));
      return;
    }
    if (msg.type === "global-bans") {
      const list = Object.entries(globalBans).map(([k, b]) =>
        `${b.name ?? k}${b.account ? ` (${b.account})` : b.addr ? " (a guest's connection)" : ""} — by ${b.by}, ${new Date(b.ts).toISOString().slice(0, 10)}${b.reason ? `: ${b.reason}` : ""}`);
      ws.send(JSON.stringify({ type: "mod", text: list.length ? `global bans (${list.length}):\n${list.join("\n")}` : "no global bans" }));
      return;
    }
    // an account selector keeps its whole length (an aid1 account carries its issuer's URL): cut to a display name's 64
    // it named no one, and an unban couldn't find it (review of #260, server I30)
    const raw = String(msg.id ?? "").trim(), id = /^(human|agent|aid1|local):/.test(raw) ? raw.slice(0, 512) : raw.slice(0, LIMITS.ID_LEN);
    if (!id || id === "*") {
      ws.send(JSON.stringify({ type: "error", error: `${msg.type} wants {id, reason?} — a specific participant, not everyone` }));
      return;
    }
    const fold = (x: string) => foldName(x);
    const dir = directoryFor(WORLDS_DIR);
    if (msg.type === "global-unban") {
      // by the name it was filed under, by the account named, or by an account wearing that name here
      const accts = new Set([id, ...dir.accountsNamed(id)]);
      const gone = bansLiftedBy(globalBans, id, accts, fold);
      for (const k of gone) delete globalBans[k];
      saveGlobalBans();
      console.log(`[mod] ${c.id} lifted global ban on ${id}${gone.length ? ` (${gone.length} record(s))` : " (was not banned)"}`);
      ws.send(JSON.stringify({ type: "mod", text: gone.length ? `${id} is no longer banned globally` : `${id} was not globally banned` }));
      return;
    }
    // global-ban (security review 10-18 H1): a ban is filed against what the DOOR checks — the target's proven account, or a
    // guest's hashed address — never a display name alone (findBan matches account/addr; a name-keyed record bound nothing until
    // a restart rewrote it). Present anywhere: their account (or, a guest, their address); absent: every account the directory
    // knows under that name. Nothing to bind → refused, said plainly.
    const present = [...worlds.values()].flatMap((w) => [...w.clients]).filter((o) => fold(o.id) === fold(id) || (typeof msg.id === "string" && o.account === msg.id));
    if (present.some((o) => isOperator(o.account))) {
      ws.send(JSON.stringify({ type: "error", error: `${id} is a world operator — remove them from WORLD_ADMIN first` }));
      return;
    }
    if (fold(id) === fold(c.id) || present.some((o) => o === c)) {
      ws.send(JSON.stringify({ type: "error", error: "you cannot moderate yourself" }));
      return;
    }
    const reason = msg.reason != null ? String(msg.reason).slice(0, LIMITS.BAN_REASON_LEN) : undefined;
    const accounts = new Set<string>([...present.map((o) => o.account).filter((a): a is string => !!a), ...dir.accountsNamed(id), ...(/^(human|agent|aid1|local):/.test(id) ? [id] : [])]);
    if ([...accounts].some((a) => isOperator(a))) { ws.send(JSON.stringify({ type: "error", error: `${id} is a world operator — remove them from WORLD_ADMIN first` })); return; }
    const guestAddrs = new Set<string>(present.filter((o) => !o.account && o.addr).map((o) => o.addr as string));
    if (!accounts.size && !guestAddrs.size) {
      ws.send(JSON.stringify({ type: "error", error: `can't ban "${id}" globally: nobody by that name is here, and no account wears it in the directory, so there is nothing a ban could bind to (bans bind to accounts, or a present guest's connection)` }));
      return;
    }
    const ts = Date.now();
    for (const account of accounts) globalBans[banKey(account)] = { by: c.id, ts, name: id, account, ...(reason ? { reason } : {}) };
    for (const addr of guestAddrs) globalBans[banKey(null, addr)] = { by: c.id, ts, name: id, addr, until: ts + ADDR_BAN_MS, ...(reason ? { reason } : {}) };
    saveGlobalBans();
    let expelled = 0;
    for (const w2 of worlds.values()) {
      for (const other of [...w2.clients]) {
        if (other === c) continue;
        if (!((other.account && accounts.has(other.account)) || (!other.account && other.addr && guestAddrs.has(other.addr)))) continue;
        expel(w2, other, `you were banned from these worlds by ${c.id}${reason ? ` — ${reason}` : ""}`);
        expelled++;
      }
    }
    console.log(`[mod] ${c.id} banned ${id} globally (${accounts.size} account(s), ${guestAddrs.size} guest address(es))${reason ? ` (${reason})` : ""}${expelled ? ` — ${expelled} session(s) disconnected` : ""}`);
    ws.send(JSON.stringify({ type: "mod", text: `${id} is banned from all worlds${reason ? ` — ${reason}` : ""}${expelled ? ` (${expelled} live session${expelled === 1 ? "" : "s"} disconnected)` : ""}` }));
    return;
  }
};

// the three global-moderation labels share one body that branches on msg.type
MESSAGES["global-ban"] = MESSAGES["global-mod"];
MESSAGES["global-unban"] = MESSAGES["global-mod"];
MESSAGES["global-bans"] = MESSAGES["global-mod"];
delete (MESSAGES as Record<string, unknown>)["global-mod"];
