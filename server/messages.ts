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
// Two suites regex THIS file's source now (they used to pin server.ts):
// tools/whisper-disable-test.ts and tools/voice-wiring-test.ts — moving a
// body again means moving their patterns with it.

import { WORLDS_DIR } from "./config.ts";
import { LIMITS } from "./limits.ts";
import { sanePose } from "./posecheck.ts";
import { currentIncarnation } from "./transport.ts";
import { isOperator } from "./operators.ts";
import { directoryFor } from "./directory.ts";
import { actorOf as actorIdOf, whois } from "./requestwire.ts";
// the authority's role ladder (shared/protocol/authority.js RANK), for the presence gates that mirror a door rule
const ROLE_RANK: Record<string, number> = { none: -1, visitor: 0, builder: 1, owner: 2 };
import { qNorm } from "../shared/rot.js";
import { worlds, type World, type Client } from "./world.ts";
import { pendingCaptures } from "./routes.ts";
import { globalBans, saveGlobalBans } from "./moderation.ts";

// ---- whispers: held-in-memory machinery (moved with its only writers) ------
// join's held-whisper delivery imports these back — one-way, like
// routes.ts's pendingCaptures.
export const pendingWhispers = new Map<string, unknown[]>();
/** Held whispers are keyed by the recipient's IDENTITY (their actor id), never a display name: anyone can join wearing an
 *  absent person's name (security review 10-06 pass 2, H-B: a second "Riannon" received the first one's whisper). */
export const whisperKey = (world: string, recipientId: string) => `${world}\u0000${recipientId}`;
export const WHISPERS_ENABLED = process.env.EIDO_WHISPERS_ENABLED !== "0";

export type MsgCtx = {
  c: Client;
  ws: { send(data: string): void; close?(code?: number, reason?: string): void };
  now: number;
  expel: (w: World, target: Client, why: string) => void;
};

export const MESSAGES: Record<string, (ctx: MsgCtx, msg: any) => void> = {
  "history": ({ c, ws, now, expel }, msg) => {
    // Deliberately available to spectators too: watching a show and
    // reading back what was said before you arrived is the same act.
    if (!c.world) return;
    // a ghost can't read chat (PLAN 10-06): its scrollback is empty, as its log stream's says are (review 10-07)
    if (c.world.log && c.world.isGhost(c)) { ws.send(JSON.stringify({ type: "history", reqId: msg.reqId ?? null, entries: [], oldestSeq: null, hasMore: false })); return; }
    const r = c.world.readHistory({
      before: typeof msg.before === "number" ? msg.before : Infinity,
      after: typeof msg.after === "number" ? msg.after : -Infinity,
      limit: Math.min(LIMITS.PAGE_MAX, Math.max(1, Number(msg.limit ?? LIMITS.PAGE_DEFAULT))),
      verbs: Array.isArray(msg.verbs) && msg.verbs.length ? new Set(msg.verbs.map(String)) : null,
    });
    ws.send(JSON.stringify({ type: "history", reqId: msg.reqId ?? null, ...r }));
  },
  "debug": ({ c, ws, now, expel }, msg) => {
    // The flight recorder (World.debugLog): why things bounced —
    // denials, rejections, rate limits, reaction outcomes. Open to
    // spectators for the same reason history is: the log is public,
    // so the reasons things failed to reach it are public too.
    if (!c.world) return;
    const limit = Math.min(LIMITS.PAGE_MAX, Math.max(1, Number(msg.limit ?? LIMITS.PAGE_DEFAULT)));
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
  "whisper": ({ c, ws, now, expel }, msg) => {
    if (!WHISPERS_ENABLED) {
      ws.send(JSON.stringify({ type: "error", error: "whispers are disabled in this world" }));
      return;
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
    const to = String(msg.to ?? "").slice(0, LIMITS.ID_LEN);
    const text = String(msg.text ?? "").slice(0, LIMITS.WHISPER_LEN);
    if (!to || !text) return;
    // a world's sanctions reach whispers too (research roles §5): a ghost or a role-less person doesn't talk, and a
    // chat mute leaves only whispers to someone holding a moderation power (so they can ask why); a ghost isn't sent any
    const log = c.world.log;
    if (log && c.actorId) {
      if (log.ghostHere(c.actorId) || log.rightsOf(c.actorId).role === "none") { ws.send(JSON.stringify({ type: "error", error: "ghosts and people without a role here don't talk" })); return; }
      const m = log.mutedHere(c.actorId, "chat");
      if (m) { const mod = [...c.world.clients].some((o) => o.id === to && o.actorId && (() => { const e = log.rightsOf(o.actorId); return e.role === "owner" || ["mute", "kick", "ban"].some((k) => e.permissions.includes(k)); })());
        if (!mod) { ws.send(JSON.stringify({ type: "error", error: `you're muted in this world's chat until ${new Date(m.until).toISOString().slice(11, 16)} UTC — you may whisper to a moderator` })); return; } }
    }
    const packet = { type: "whisper", from: c.id, to, text, ts: Date.now() };
    // present: names are unique among the people here, so the name finds them (their embodied leg, never an aux leg)
    const targets = [...c.world.clients].filter((o) => o.id === to && !o.spectator && (o.surface ?? "world") === "world" && !(log && c.world.isGhost(o)));   // never to a ghost (review 10-07)
    if (targets.length) {
      for (const t of targets) t.ws.send(JSON.stringify(packet));
      ws.send(JSON.stringify({ ...packet, echo: true })); // your own sent copy
      return;
    }
    // absent: held for the ONE identity this world knows by that name (whois), never for whoever next wears the name
    const r: any = whois(c.world, { name: to });
    const ids: string[] = r?.ok ? r.people.map((p: any) => p.id) : [];
    if (ids.length !== 1) {
      ws.send(JSON.stringify({ type: "error", error: ids.length ? `more than one person called ${to} has been here — whisper them when they're here` : `nobody called ${to} has been in this world` }));
      return;
    }
    const key = whisperKey(c.world.name, ids[0]);
    const q = pendingWhispers.get(key) ?? [];
    q.push(packet);
    while (q.length > LIMITS.WHISPER_HOLD) q.shift();
    pendingWhispers.set(key, q);
    ws.send(JSON.stringify({ ...packet, echo: true }));
    ws.send(JSON.stringify({ type: "error", error: `${to} isn't here — they'll get it when they arrive` }));
  },
  "anim": ({ c, ws, now, expel }, msg) => {
    // A one-off animation: relayed once to everyone, never logged. It is
    // a moment, not a fact about the world — presence, like a pose. Small
    // enough (a few KB of quaternions) that it needs no store; big enough
    // that it must not ride the 15Hz pose stream, so it is its own
    // message sent once.
    if (!c.world || c.spectator) return;
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
    const tc = [...c.world.clients].find((o) => o.id === to && !o.spectator && (o.surface ?? "world") === "world");
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
    // merge: pose only the bones sent, over what the target already holds.
    // Absent means replace — what every sender meant before the flag existed.
    tc.ws.send(JSON.stringify({ type: "puppet", by: c.id, pose: msg.pose ?? null, merge: msg.merge === true,
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
  },
  "caption": ({ c, ws, now, expel }, msg) => {
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
    const to = typeof msg.to === "string" && [...c.world.clients].some((o) => o.id === msg.to && !o.spectator) ? msg.to : null;
    c.world.broadcast({ type: "typing", id: c.id, to, ...(st ? { state: st } : {}) }, c);
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
    c.world.broadcast({ type: "drag", id: msg.id, pos: msg.pos, yaw: msg.yaw, ...(q ? { q } : {}), by: c.id }, c);
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
    c.lastPose = pose;
    // presence: batched into stage frames by the tick loop, never persisted
    c.world.dirty.set(c.id, pose);
  },
  "capture-result": ({ c, ws, now, expel }, msg) => {
    const pending = pendingCaptures.get(msg.id);
    if (!pending || !c.renderer) return;
    pendingCaptures.delete(msg.id);
    if (typeof msg.dataUrl === "string" && msg.dataUrl.startsWith("data:image/png;base64,")) {
      pending.resolve({ ok: true, png: Buffer.from(msg.dataUrl.slice("data:image/png;base64,".length), "base64") });
    } else {
      pending.resolve({ ok: false, err: String(msg.error ?? "renderer returned no image"), status: 502 });
    }
  },
  "world-bans": ({ c, ws, now, expel }, msg) => {
    // Who is banned from the world you are standing in. Available to
    // anyone present — the moderator's record is public in its outline (who,
    // when, by whom); a list nobody can read is not an audit trail.
    if (!c.world) return;
    // the moderation record is read by people holding a moderation power (research roles §7; review 10-07: anyone
    // here could read every ban and its reason), and by the authority's clock (a ban that ended isn't listed)
    if (c.world.log) { const e = c.actorId ? c.world.log.rightsOf(c.actorId) : null;
      if (!e || !(e.role === "owner" || ["mute", "kick", "ban", "pauseScripts"].some((k) => e.permissions.includes(k)))) { ws.send(JSON.stringify({ type: "mod", text: "the ban list is for people who hold a moderation power here" })); return; } }
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
      const list = Object.entries(globalBans).map(([id, b]) =>
        `${id}${b.sub ? ` (${b.sub})` : ""} — by ${b.by}, ${new Date(b.ts).toISOString().slice(0, 10)}${b.reason ? `: ${b.reason}` : ""}`);
      ws.send(JSON.stringify({ type: "mod", text: list.length ? `global bans (${list.length}):\n${list.join("\n")}` : "no global bans" }));
      return;
    }
    const id = String(msg.id ?? "").trim().slice(0, LIMITS.ID_LEN);
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
    const present = [...worlds.values()].flatMap((w) => [...w.clients]).find((o) => o.id.toLowerCase() === id.toLowerCase());
    if (isOperator(present?.account)) {
      ws.send(JSON.stringify({ type: "error", error: `${id} is a world operator — remove them from WORLD_ADMIN first` }));
      return;
    }
    if (id.toLowerCase() === c.id.toLowerCase()) {
      ws.send(JSON.stringify({ type: "error", error: "you cannot moderate yourself" }));
      return;
    }
    const reason = msg.reason != null ? String(msg.reason).slice(0, LIMITS.BAN_REASON_LEN) : undefined;
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
};

// the three global-moderation labels share one body that branches on msg.type
MESSAGES["global-ban"] = MESSAGES["global-mod"];
MESSAGES["global-unban"] = MESSAGES["global-mod"];
MESSAGES["global-bans"] = MESSAGES["global-mod"];
delete (MESSAGES as Record<string, unknown>)["global-mod"];
