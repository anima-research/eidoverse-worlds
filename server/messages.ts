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

import { runVerb } from "./verbs.ts";
import { coldLibs, warmBoxes, worldLibs } from "./boxes.ts";
import { LIMITS } from "./limits.ts";
import { currentIncarnation } from "./transport.ts";
import { rightsOf, isAdminId } from "./rights.ts";
import { ROLE_RANK } from "../shared/fold.js";
import { simSnapshot } from "../shared/sim.js";
import { worlds, forkWorld, type World, type Client } from "./world.ts";
import { pendingSnaps } from "./routes.ts";
import { globalBans, saveGlobalBans } from "./moderation.ts";

// ---- whispers: held-in-memory machinery (moved with its only writers) ------
// join's held-whisper delivery imports these back — one-way, like
// routes.ts's pendingSnaps.
export const pendingWhispers = new Map<string, unknown[]>();
export const whisperKey = (world: string, recipient: string) => `${world}\u0000${recipient}`;
export const WHISPERS_ENABLED = process.env.EIDO_WHISPERS_ENABLED !== "0";

export type MsgCtx = {
  c: Client;
  ws: { send(data: string): void; close?(code?: number, reason?: string): void };
  now: number;
  expel: (w: World, target: Client, why: string) => void;
};

export const MESSAGES: Record<string, (ctx: MsgCtx, msg: any) => void> = {
  "verb": ({ c, ws, now, expel }, msg) => {
    // The authored plane in one call — table + shell live in
    // server/verbs.ts (§15, 7b): preamble, validators, append +
    // broadcast, after hooks, byte-identical. expel rides in the ctx,
    // injected: verbs.ts must never import server.ts (the cycle break
    // §15.1 pinned).
    //
    // eidosim@0.3.0: a spawn (its lib) or an epoch (every standing lib)
    // needs the sequencer's box stamp, and summarizing a GLB is async
    // while validators are not — so the cache is warmed HERE, on the
    // wire. AUTHORED ORDER IS KEPT: a client whose verb is waiting on an
    // asset read has every later verb of its own queued behind it (PR
    // #160 review, B1 — a cold spawn followed by a place used to land as
    // place-then-spawn, wrong forever in the log). A client with nothing
    // in flight runs synchronously, in order, as before; only a lib this
    // process has never seen pays the wait, once.
    const w = c.world;
    if (!w) return;
    const gen = c.gen;
    // Admission issues a new generation even when this socket rejoins the
    // same world. Bind pending work to that acceptance, not just its name or
    // world pointer (takeover and ordinary close can leave the latter set).
    const current = () => gen != null && c.gen === gen && c.ws === ws
      && c.world === w && !c.superseded && w.clients.has(c) && c.ws.readyState === 1;
    const libs = () => msg.verb === "spawn" ? coldLibs([String(msg.args?.lib ?? "")])
      : msg.verb === "epoch" ? coldLibs(worldLibs(w.state)) : [];
    // Recheck immediately before the synchronous commit path, after any read.
    const run = () => { if (current()) runVerb({ w, c, now, expel }, msg.verb, msg.args); };
    if (!libs().length && !c.verbQueue) { run(); return; }
    // The callback's try/catch cannot catch a continuation. Contain both
    // validation and after-hook failures here, and leave a resolved queue so
    // the next authored request still runs. Never discard a rejecting finally.
    const tail: Promise<void> = (c.verbQueue ?? Promise.resolve())
      .then(async () => {
        if (!current()) return;
        // A preceding queued spawn may have changed the epoch's box domain.
        await warmBoxes(libs());
        run();
      })
      .catch((err) => {
        console.error(`[ws] "verb" from ${c.id} failed server-side:`, err);
        try { ws.send(JSON.stringify({ type: "error", error: "that request failed server-side — it has been logged" })); } catch { /* socket already gone */ }
      });
    c.verbQueue = tail;
    void tail.then(() => { if (c.verbQueue === tail) c.verbQueue = undefined; });
  },
  "history": ({ c, ws, now, expel }, msg) => {
    // Deliberately available to spectators too: watching a show and
    // reading back what was said before you arrived is the same act.
    if (!c.world) return;
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
    if (msg.sim) {
      // the sim fold's cut, on request — the determinism proof's
      // server leg (sim-smoke compares this against an independent
      // recompute), and any client's "what does the sequencer think"
      ws.send(JSON.stringify({ type: "debug", reqId: msg.reqId ?? null,
        sim: simSnapshot(c.world.sim) }));
      return;
    }
    if (msg.behavior != null) {
      // one script's own log ring + status — the author's console
      const b = c.world.bhv.inspect(String(msg.behavior));
      ws.send(JSON.stringify({ type: "debug", reqId: msg.reqId ?? null,
        behavior: String(msg.behavior),
        status: b?.status ?? "no such behavior",
        events: (b?.ring ?? []).slice(-limit).map((r) => ({ ts: r.ts, kind: "script-log", line: r.line })) }));
      return;
    }
    if (msg.behaviors) {   // the roster: what runs here, and is it alive
      ws.send(JSON.stringify({ type: "debug", reqId: msg.reqId ?? null,
        events: c.world.bhv.list().map((b) => ({ ts: 0, kind: "behavior", ...b })) }));
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
    const packet = { type: "whisper", from: c.id, to, text, ts: Date.now() };
    const targets = [...c.world.clients].filter((o) => o.id === to && !o.spectator);
    for (const t of targets) t.ws.send(JSON.stringify(packet));
    ws.send(JSON.stringify({ ...packet, echo: true })); // your own sent copy
    if (!targets.length) {
      const key = whisperKey(c.world.name, to);
      const q = pendingWhispers.get(key) ?? [];
      q.push(packet);
      while (q.length > LIMITS.WHISPER_HOLD) q.shift();
      pendingWhispers.set(key, q);
      ws.send(JSON.stringify({ type: "error", error: `${to} isn't here — they'll get it when they arrive` }));
    }
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
    c.world.broadcast({ type: "anim", id: c.id, dur: msg.dur, tracks: msg.tracks, loop: !!msg.loop }, c);
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
  },
  "bc": ({ c, ws, now, expel }, msg) => {
    // dev crash forensics: keep the client's last N breadcrumbs in
    // memory, printed on disconnect (see close). Never persisted.
    const ring = (c.bcRing ??= []);
    ring.push(String(msg.tag ?? "").slice(0, LIMITS.ID_LEN));
    if (ring.length > LIMITS.BC_RING) ring.shift();
    return;
  },
  "lease": ({ c, ws, now, expel }, msg) => {
    // Entity animation leases — docs/leases.md. The server arbitrates
    // (objects have no owning client), remembers the last streamed
    // transform, and COMMITS it when the holder releases, vanishes, or
    // goes stale. It never simulates: transforms in, transforms out,
    // one `place` verb at rest. Presence semantics: never logged.
    if (!c.world || c.spectator) return;
    const w = c.world;
    const id = String(msg.id ?? "").slice(0, LIMITS.ID_LEN);
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
        const stale = Date.now() - cur.lastAt > LIMITS.LEASE_STALE_MS;
        // proximity take: you can take what you can reach — the ball
        // being dribbled past you is kickable, the one across the
        // field is not. Distance vs the OBJECT's live position.
        const at = cur.lastState?.p ?? w.state.entities[id].pos;
        const me = c.lastPose?.p;
        const near = !!me && Math.hypot(me[0] - at[0], me[2] - at[2]) <= LIMITS.LEASE_TAKE_M;
        if (!stale && !(msg.take && near)) {
          ws.send(JSON.stringify({ type: "lease", op: "denied", id, why: `${cur.holder.id} is animating it` }));
          return;
        }
        cur.holder.ws.send(JSON.stringify({ type: "lease", op: "lost", id, to: c.id }));
      }
      // per-client cap: a runaway plugin must not lease a whole world
      let held = 0;
      for (const L of w.leases.values()) if (L.holder === c) held++;
      if (held >= LIMITS.LEASES_PER_CLIENT && !w.leases.has(id)) {
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
    c.world.broadcast({ type: "typing", id: c.id, to: msg.to ?? null, ...(st ? { state: st } : {}) }, c);
  },
  "drag": ({ c, ws, now, expel }, msg) => {
    // Transient build feedback. DESIGN.md is explicit that dragging is
    // presence traffic and only the RELEASE commits a log entry — so this
    // is relayed and never persisted, exactly like a pose. Without it,
    // everyone else sees objects teleport on release instead of move.
    if (!c.world || c.spectator) return;
    // the RELEASE is a `place` verb the gate above checks; the live drag
    // must agree with it or visitors can slide props they can't commit
    if (ROLE_RANK[rightsOf(c.world.state, c.id, c.sub).role] < 1) return;
    c.world.broadcast({ type: "drag", id: msg.id, pos: msg.pos, yaw: msg.yaw, by: c.id }, c);
  },
  "pose": ({ c, ws, now, expel }, msg) => {
    if (!c.world || c.spectator) return;
    c.lastPose = msg.pose;
    // presence: batched into stage frames by the tick loop, never persisted
    c.world.dirty.set(c.id, msg.pose);
  },
  "snap-result": ({ c, ws, now, expel }, msg) => {
    const pending = pendingSnaps.get(msg.id);
    if (!pending || !c.renderer) return;
    pendingSnaps.delete(msg.id);
    if (typeof msg.dataUrl === "string" && msg.dataUrl.startsWith("data:image/png;base64,")) {
      pending.resolve({ ok: true, png: Buffer.from(msg.dataUrl.slice("data:image/png;base64,".length), "base64") });
    } else {
      pending.resolve({ ok: false, err: String(msg.error ?? "renderer returned no image"), status: 502 });
    }
  },
  "world-fork": ({ c, ws, now, expel }, msg) => {
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
    const to = String(msg.to ?? "").slice(0, LIMITS.ID_LEN);
    const r = forkWorld(c.world, to);
    if (!r.ok) {
      ws.send(JSON.stringify({ type: "error", error: r.err }));
      return;
    }
    console.log(`[world:${c.world.name}] copied → "${to}" by ${c.id}`);
    ws.send(JSON.stringify({ type: "world-forked", from: c.world.name, to }));
  },
  "world-reset": ({ c, ws, now, expel }, msg) => {
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
      w.commit("world", "grant", { id, role: "owner", gen: true });
    }
    console.log(`[world:${w.name}] ERASED to zero by ${c.id} — history archived in ${arch}`);
    w.broadcast({ type: "world-reset", world: w.name, by: c.id });
  },
  "world-bans": ({ c, ws, now, expel }, msg) => {
    // Who is banned from the world you are standing in. Available to
    // anyone present — bans are log entries and the log is public; a
    // list nobody can read is not an audit trail.
    if (!c.world) return;
    const list = Object.entries(c.world.state.bans ?? {}).map(([id, b]) =>
      `${id} — by ${b.by}, ${new Date(b.ts).toISOString().slice(0, 10)}${b.reason ? `: ${b.reason}` : ""}`);
    ws.send(JSON.stringify({ type: "mod", text: list.length
      ? `banned from "${c.world.name}" (${list.length}):\n${list.join("\n")}`
      : `nobody is banned from "${c.world.name}"` }));
  },
  "global-mod": ({ c, ws, now, expel }, msg) => {
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
    if (isAdminId(id)) {
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
