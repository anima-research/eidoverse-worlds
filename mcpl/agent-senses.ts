// The agent's senses: what the body notices (presence, approach, acts, speech, emitters, the sky, pings) and look's account of the world.
// Its public members are the body's (one-line delegates in agent.ts), and it calls them there (this.a.x), as before.

import type { WorldAgent, Person } from "./agent.ts";
import { bodyOf } from "../shared/components.js";
import { describeBody, resolveSeat } from "../shared/sockbody.js";
import { grabOf, describeGrab } from "../shared/grab.js";
import { type Entity, type Pose, solidOffRecord, isSocketRec, posePosition, PLACE_SIGHT_M } from "./agent-result.ts";
import { briefingLines } from "../shared/briefing.js";
import { compass } from "../shared/waterkind.js";
import { SHORT_STINT_MS, APPROACH_REFRACT_MS, APPROACH_RADIUS, REARM_RADIUS, APPROACH_DWELL_MS, APPROACH_STILL_MPS, APPROACH_MAX_WAIT_MS, ACTIVITY_PULSE_MS, ACTIVITY_REFRESH_MS, MOVER_MIN_M } from "./denoise.ts";
import { waterStance } from "../shared/mover.js";
import { foldedIn } from "../shared/wingpresence.js";
import { onceAnimOf } from "../shared/onceanim.js";
import { readBodyMode } from "../shared/bodymode.js";
import { describeSky, effectiveSky, effectiveClock, dayPhase, hoursAt } from "../shared/forecast.js";
// the `particles` component's meaning, shared with the browser: both agree about what is burning
import { describeParticles, emitterTransition, transitionLine } from "../shared/particles.js";
import { saysOf } from "../shared/says.js";
import { readOut, openAction } from "../shared/a11y.js";
import { quoted } from "../shared/text.js";
import { lightOf } from "../shared/components.js";
import { describeCaptions } from "../shared/captions.js";
import { describeStructure, describeHere, localizePoint } from "../shared/structure.js";
import { INSTANCES, describeInstances } from "../shared/instances.js";
import { type Effective } from "./effective.ts";
import { recordComponents } from "../shared/protocol/view.js";
import { modelWord } from "../shared/eido.js";

/** Quiet window for world-change narration, per (entity, component). Tuning a
 *  live emitter is a burst of `comp` entries; this is how long they fold into
 *  one line. Long enough to swallow a slider drag, short enough that "puts the
 *  fire out" still arrives while you are looking at it. */
const EMITTER_COALESCE_MS = Number(process.env.EW_EMITTER_COALESCE_SEC ?? 4) * 1000;
/** What a person's voice state means for YOU, in words. Read from the live pose (shared/presencewire.js voiceWire,
 *  docs/reference/POSE-WIRE.md). The headphones gate spoken voice only (mics and synthesized speech, an agent's included); chat
 *  text always arrives. Absent = the client didn't say: no claim is made. */
export function voiceNote(pose: unknown): string {
  const v = (pose ?? {}) as { mic?: unknown; hear?: unknown; xr?: unknown };
  const parts: string[] = [];
  if (v.hear === false) parts.push("headphones off: they won't hear anything spoken aloud, yours included, but they still see chat text");
  else if (v.hear === true) parts.push("headphones on: they hear spoken voices");
  if (v.mic === true) parts.push("mic on: they may be talking aloud");
  else if (v.mic === false) parts.push("mic off");
  if (v.xr) parts.push("in VR");
  return parts.length ? `; ${parts.join("; ")}` : "";
}

export class AgentSenses {
  constructor(readonly a: WorldAgent) {}

  private inboxCursor = 0;
  /** Highest world-log seq whose `say` is already in the inbox, so a reconnect's
   *  replayed snapshot tail isn't appended twice. */
  private inboxSeen = -Infinity;
  /** Open coalescing windows for world-change narration, keyed by entity id.
   *  See noteEmitter. */
  emitterNarration = new Map<string, { announced: unknown; latest: unknown; actor: string; timer: ReturnType<typeof setTimeout> }>();
  private lastNear = new Map<string, number>(); // participant -> last approach-ping ts
  /** approach re-arm: after a walk-up ping, the SAME person must actually go
   *  away (> REARM_RADIUS) before another boundary crossing can ever count —
   *  someone pacing at 2–3m otherwise re-triggers on every crossing. */
  private nearArmed = new Map<string, boolean>();
  /** An inward crossing that has NOT yet earned its ping (dwell pending): `since`
   *  = entered arm's reach, `stillSince` = last seen faster than
   *  APPROACH_STILL_MPS, `at`/`atTs` = previous sample. Cleared when they leave the radius. */
  private approachPending = new Map<string, { since: number; stillSince: number; at: [number, number]; atTs: number }>();
  /** Someone whose approach was DELIVERED, so their departure owes a ping (a
   *  passer-by never earned one). The value is OUR (x,z) when the approach fired:
   *  past REARM_RADIUS from there, their own movement explains the exit and the
   *  wire may say "walked away"; otherwise it only says the relation ended. */
  private approachOpen = new Map<string, [number, number]>();
  /** participant -> when their current non-locomotion stint began (jump, sit…) */
  private nonLocoSince = new Map<string, number>();
  /** Local-awareness accumulator, reset every pulse: RAW for movement and says
   *  (jump spam is real liveliness) but DENOISED for arrivals/departures (a
   *  reconnect flap is not activity). */
  act30 = { says: new Map<string, number>(), moved: new Map<string, number>(), acts: 0, arrivals: 0, departures: 0, builds: 0 };
  /** The last EMITTED pulse — novelty gate state. `sig` fingerprints the
   *  ambient scenery (roster + movers + acts); `roster` lets an unchanged
   *  cast be compacted to a count instead of ten names, every time. */
  private lastPulse = { sig: "", roster: "", at: 0 };
  private activityPulseMs = ACTIVITY_PULSE_MS;
  /** The pulse ticks from birth; it only ever SPEAKS when the accumulator has
   *  something in it, so an empty room costs nothing. */
  activityTimer: ReturnType<typeof setInterval> | null =
    setInterval(() => this.activityPulse(), ACTIVITY_PULSE_MS);

  /** Tune the ambient-activity sense. pulseSec clamps to [10, 3600] — 0 turns
   *  the sense off entirely; radiusM clamps to [1, 200]. Returns what was
   *  actually applied. */
  setActivity(opts: { pulseSec?: number; radiusM?: number }): { pulseSec: number; radiusM: number } {
    if (opts.radiusM != null && Number.isFinite(opts.radiusM))
      this.a.activityRadiusM = Math.min(200, Math.max(1, opts.radiusM));
    if (opts.pulseSec != null && Number.isFinite(opts.pulseSec)) {
      const sec = opts.pulseSec <= 0 ? 0 : Math.min(3600, Math.max(10, opts.pulseSec));
      this.activityPulseMs = sec * 1000;
      if (this.activityTimer) { clearInterval(this.activityTimer); this.activityTimer = null; }
      if (sec > 0) this.activityTimer = setInterval(() => this.activityPulse(), this.activityPulseMs);
    }
    return { pulseSec: this.activityPulseMs / 1000, radiusM: this.a.activityRadiusM };
  }
  /** The folded sky (same fold as the sequencer's) — worldInfo.sky is
   *  DERIVED from this at look() time, so the described hour/weather is the
   *  one the forecast implies NOW, not the one at the last log entry. */
  skyState: any = null;
  // The sky WATCH (look() is the pull half): one ambient percept per meaningful
  // boundary, deduped by signature, never a synthetic log verb or a clock.
  private skyCursor: any = null;
  private lastSkyKey: string | null = null;
  private lastDayPhase: string | null = null;
  lastSkyCheck = 0;

  /** The activity pulse: ONE event per window, only while something happens
   *  (denoise.ts ACTIVITY_*). Not pushed to the inbox: it is a wake signal.
   *
   *  NOVELTY-GATED: discrete events (speech, arrivals, departures, builds)
   *  always pulse; ambient continuation pulses when it CHANGES (someone new
   *  moves, someone stops, the roster shifts), otherwise at most every
   *  ACTIVITY_REFRESH. */
  private activityPulse() {
    const a = this.act30;
    const msgs = [...a.says.values()].reduce((s, n) => s + n, 0);
    const movers = [...a.moved.entries()].filter(([, d]) => d >= MOVER_MIN_M).map(([id]) => id).sort();
    this.act30 = { says: new Map(), moved: new Map(), acts: 0, arrivals: 0, departures: 0, builds: 0 };
    const discrete = msgs || a.arrivals || a.departures || a.builds;
    if (!(discrete || movers.length || a.acts)) return;
    const nearby = [...this.a.people.values()]
      .filter((p) => p.id !== this.a.name && p.pose &&
        Math.hypot(p.pose.p[0] - this.a.pos.x, p.pose.p[2] - this.a.pos.z) <= this.a.activityRadiusM)
      .map((p) => p.id).sort();
    const now = Date.now();
    const sig = `${nearby.join(",")}|${movers.join(",")}|${a.acts > 0}`;
    if (!discrete && sig === this.lastPulse.sig && now - this.lastPulse.at < ACTIVITY_REFRESH_MS) return;
    const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
    const bits: string[] = [];
    if (msgs) bits.push(`${n(msgs, "message")} (${[...a.says.keys()].join(", ")})`);
    if (movers.length) bits.push(`${movers.join(", ")} moving about`);
    if (a.acts) bits.push(n(a.acts, "embodied act"));
    if (a.arrivals) bits.push(n(a.arrivals, "arrival"));
    if (a.departures) bits.push(n(a.departures, "departure"));
    if (a.builds) bits.push(`${n(a.builds, "thing")} changed`);
    const roster = nearby.join(", ");
    // an unchanged cast is a count, not a re-introduction — ten names once,
    // "10 nearby" thereafter
    const who = nearby.length
      ? `${roster === this.lastPulse.roster ? `${nearby.length} nearby` : `${roster} nearby`} — ` : "";
    this.lastPulse = { sig, roster, at: now };
    this.a.onEvent?.({ ts: now, kind: "activity", who: "world", text: `${who}${bits.join("; ")}` });
  }

  /** Track someone's latest pose and run the approach/depart machine
   *  (stepApproach). An approach is a knock, not a metronome: edge-triggered at
   *  the radius, re-armed only beyond REARM_RADIUS, a per-person refractory, and
   *  DWELL (delivered once they stop, or once they've stayed inside for
   *  APPROACH_MAX_WAIT_MS, denoise.ts). `depart` pings only for a delivered approach.
   *  `now` is injectable so dwell tests control the clock. */
  notePose(id: string, pose: Pose, now = Date.now()) {
    // A dirty stage frame can flush after the participant's leave event.
    // Once joined, only the snapshot/arrive roster introduces a body; a late
    // pose must not resurrect someone who is no longer present.
    if (this.a.joined && !this.a.people.has(id)) return;
    const p: Person = this.a.people.get(id) ?? { id, avatar: "", pose: null };
    const prev = p.pose;
    p.pose = pose; p.observedAt = now;
    { const seat = (pose as any)?.seat;   // a seat rides the frame while it holds (presence)
      const to = seat?.to ? resolveSeat(this.a.st, { to: String(seat.to), ...(typeof seat.slot === "string" ? { slot: seat.slot } : {}) })?.to : null;
      if (to) { const st = { to }; this.a.bodySeats.set(id, st); this.a.mounts.set(id, st); }
      else if (this.a.bodySeats.delete(id)) this.a.mounts.delete(id); }
    p.bodyGeneration ??= ++this.a.bodyGenerationCounter;
    this.a.people.set(id, p);
    // hands aimed at this body — before the spatial gate below, because a
    // reach descriptor is legible even from a sample with no usable position
    if (id !== this.a.name) this.a.reaching.noteReachEvents(id, prev, pose);
    const xyz = posePosition(pose);
    if (!xyz) return; // keep the shell for identity/roster; no spatial inference yet
    const [x, , z] = xyz;
    const prevXYZ = posePosition(prev);
    const dist = Math.hypot(x - this.a.pos.x, z - this.a.pos.z);
    // The first SPATIAL observation is a BASELINE, not a transition: reconnect
    // replay lands here for every body already in the room. Seed silently; a
    // body already beside you must leave and come back before it can "walk up". A body the join's snapshot listed
    // has a pose already (rememberBody) but no arm state: its first sample here is the baseline too
    if (!prevXYZ || !this.nearArmed.has(id)) {
      this.nearArmed.set(id, dist > REARM_RADIUS);
      return;
    }
    const prevDist = Math.hypot(prevXYZ[0] - this.a.pos.x, prevXYZ[2] - this.a.pos.z);
    if (id !== this.a.name) {
      // Approach/depart is about OTHER bodies (guarded like noteActs and
      // noteReachEvents): a self-echo must never report walking away from ourselves.
      this.stepApproach(id, x, z, dist, prevDist, now);
      // The activity pulse counts accumulated DISPLACEMENT, not a speed flag
      // (idle jitter never qualifies); steps over 8m in one packet are teleports.
      if (dist <= this.a.activityRadiusM && prev) {
        const step = Math.hypot(pose.p[0] - prev.p[0], pose.p[2] - prev.p[2]);
        if (step > 0.001 && step < 8)
          this.act30.moved.set(id, (this.act30.moved.get(id) ?? 0) + step);
      }
      this.noteActs(id, prev, pose, dist);
    }
  }

  /** One spatial sample of someone else, through the approach/depart machine:
   *
   *    dist > REARM_RADIUS      gone. Re-arm, and settle any owed departure.
   *    APPROACH_RADIUS..REARM   nearby. CANCELS a pending approach (pass-through).
   *    dist < APPROACH_RADIUS   close. Open a pending approach on the inward
   *                             crossing; deliver it once they hold still.
   *
   *  Stillness is measured from positions WE observed, never `pose.speed`.
   *  Deliberate asymmetry: leaving arm's reach cancels a PENDING approach but
   *  doesn't close a delivered one; departure is the re-arm edge, so a seated
   *  body's jitter across 2.5m never fires walked-up/walked-away pairs. */
  private stepApproach(id: string, x: number, z: number, dist: number, prevDist: number, now: number) {
    if (dist > REARM_RADIUS) {
      this.nearArmed.set(id, true);
      this.approachPending.delete(id);
      const anchor = this.approachOpen.get(id);
      if (anchor) {
        this.approachOpen.delete(id);
        // Who moved? `dist` is from where WE are now, so measure them against
        // the anchor (our position when the approach fired): beyond the re-arm
        // edge from there, they walked; otherwise the separation is at least
        // partly ours and the ping says it actor-neutrally. Renderers print
        // `who` + this text verbatim.
        const walked = Math.hypot(x - anchor[0], z - anchor[1]) > REARM_RADIUS;
        this.a.ping({ ts: now, kind: "depart", who: id, text: walked ? "walked away" : "is no longer nearby" });
      }
      return;
    }
    if (dist >= APPROACH_RADIUS) {
      this.approachPending.delete(id);
      return;
    }

    // --- inside arm's reach ---
    const pend = this.approachPending.get(id);
    if (!pend) {
      // Only the CROSSING opens a pending approach, exactly as before — a body
      // already inside the radius when we started watching never "walks up".
      const armed = this.nearArmed.get(id) ?? true;
      const cooled = now - (this.lastNear.get(id) ?? 0) > APPROACH_REFRACT_MS;
      if (prevDist >= APPROACH_RADIUS && armed && cooled)
        this.approachPending.set(id, { since: now, stillSince: now, at: [x, z], atTs: now });
      return;
    }

    // Observed speed over the gap since the last sample. A zero/negative gap
    // (two samples in one millisecond) yields no evidence either way, so it
    // leaves stillSince alone rather than dividing by zero.
    const dt = now - pend.atTs;
    if (dt > 0) {
      const speed = Math.hypot(x - pend.at[0], z - pend.at[1]) / (dt / 1000);
      if (speed >= APPROACH_STILL_MPS) pend.stillSince = now;
      pend.at = [x, z];
      pend.atTs = now;
    }

    const held = now - pend.stillSince >= APPROACH_DWELL_MS;
    const waited = now - pend.since >= APPROACH_MAX_WAIT_MS;
    if (!held && !waited) return;

    this.approachPending.delete(id);
    this.lastNear.set(id, now);
    this.nearArmed.set(id, false);
    this.approachOpen.set(id, [this.a.pos.x, this.a.pos.z]); // the vantage the walk-up was true from
    this.a.ping({ ts: now, kind: "approach", who: id });
  }

  /** A body left the WORLD (the `leave` message; extracted so it's testable
   *  without a socket). Every per-participant map goes too: otherwise they grow
   *  for the life of the process, and a returning visitor would inherit stale
   *  approach arm state. Dropping approachOpen also keeps one exit to one line:
   *  the presence gate already said "left the world", so no "walked away" too. */
  noteLeave(id: string) {
    this.a.people.delete(id);
    if (this.a.bodySeats.delete(id)) this.a.mounts.delete(id);   // a departed body rides nothing
    this.a.bodyReader?.forget(id);
    this.lastNear.delete(id);
    this.nearArmed.delete(id);
    this.nonLocoSince.delete(id);
    this.approachPending.delete(id);
    this.approachOpen.delete(id);
    for (const k of this.a.reaching.lastReachPing.keys()) {
      if (k.endsWith(`:${id}`)) this.a.reaching.lastReachPing.delete(k);
    }
    this.a.gate.presence(id, "leave");
  }

  /** Embodied acts as events: TRANSITIONS (a gesture fired, a pose struck or
   *  released, sitting down or getting up), edge-triggered, never per frame.
   *  Denoised by the gate's per-(person, act) refractory, and a non-locomotion
   *  stint shorter than SHORT_STINT_MS earns no "gets up". */
  private noteActs(id: string, prev: Pose | null, pose: Pose & { anim?: string; pose?: Record<string, unknown> | null }, dist = Infinity) {
    const acts: { key: string; text: string }[] = [];
    const once = onceAnimOf(pose);   // pose.anim
    if (once) acts.push({ key: `anim:${once}`, text: `plays ${once} (once)` });
    const prevHeld = Boolean((prev as { pose?: unknown } | null)?.pose);
    const nowHeld = Boolean(pose.pose);
    if (nowHeld && !prevHeld) acts.push({ key: "pose", text: `strikes a pose (${Object.keys(pose.pose!).length} bones held)` });
    if (!nowHeld && prevHeld) acts.push({ key: "pose-release", text: "releases their pose" });
    const was = foldedIn(prev), now = foldedIn(pose);   // the named pose wings-folded (an older sample's wingsFolded reads the same)
    const hadFold = was !== null, hasFold = now !== null;
    const prevFold = was === true, nowFold = now === true;
    // A first sighting is a state, not an act. Announce only an edge observed
    // between two explicit semantic samples; legacy absence proves neither
    // folding nor opening.
    if (hadFold && hasFold && nowFold !== prevFold) acts.push({
      key: nowFold ? "wings-fold" : "wings-unfold",
      text: nowFold ? "folds their wings" : "opens their wings",
    });
    const LOCO = new Set(["idle", "walk", "run"]);
    const pc = prev?.clip ?? "idle", nc = pose.clip ?? "idle";
    if (nc !== pc) {
      if (!LOCO.has(nc)) {
        if (LOCO.has(pc)) this.nonLocoSince.set(id, Date.now());
        acts.push({ key: `clip:${nc}`, text: nc.startsWith("sit") ? "sits down" : nc === "lie" ? "lies down" : `starts "${nc}"` });
      } else if (!LOCO.has(pc)) {
        const stint = Date.now() - (this.nonLocoSince.get(id) ?? 0);
        this.nonLocoSince.delete(id);
        if (stint >= SHORT_STINT_MS) acts.push({ key: "gets-up", text: "gets up" });
      }
    }
    // RAW act count feeds the pulse — a denoised (repeat) jump still means
    // someone is alive and doing things next to you
    if (acts.length && dist <= this.a.activityRadiusM) this.act30.acts += acts.length;
    for (const a of acts) this.a.gate.act(id, a.key, a.text);
  }

  /** Remember our OWN says briefly, so a sidecar that airs one can be attested for it (the receipt is sha256 of the
   *  text the world logged; only the world's copy is authoritative). Small ring: a receipt is valid for 5 minutes. */
  noteOwnSay(entry: any) {
    if (entry?.verb === "say" && entry?.actor === this.a.name && typeof entry?.args?.text === "string") {
      this.a.ownSays.set(entry.seq, String(entry.args.text));
      if (this.a.ownSays.size > 32) this.a.ownSays.delete(this.a.ownSays.keys().next().value as number);
      this.a.onMedia?.({ type: "speak", seq: entry.seq, text: entry.args.text });
    }
  }

  /** A chat line heard ({seq, ts, actor, args: {text}}): the inbox once, and a live line from someone else
   *  is an event (and a mention ping when it names this body). The window itself is the caller's (the fold, or hear). */
  hearSay(entry: any, live: boolean) {
    const { args, actor, ts } = entry;
    // history lands in the inbox ONCE, so a freshly-joined agent has
    // context — and a reconnect's replayed tail is deduped by seq instead
    // of piling the same chat in again.
    const seq = typeof (entry as { seq?: unknown }).seq === "number" ? (entry as { seq: number }).seq : null;
    // only real log seqs (>= 0) dedupe — synthetic pre-history seqs descend
    if (seq != null && seq >= 0 && seq <= this.inboxSeen) return;
    if (seq != null && seq >= 0) this.inboxSeen = seq;
    this.a.inbox.push({ ts, kind: "say", who: actor, text: args.text, seq });
    // mention ping: @name or bare whole-word name, live messages only. The
    // agent's OWN say (the log's echo) stays in the inbox but is never an event.
    if (live && actor !== this.a.name) {
      // speech near this body feeds the activity pulse (a speaker whose
      // position is unknown — just arrived — counts as near)
      const pp = this.a.people.get(actor)?.pose;
      if (!pp || Math.hypot(pp.p[0] - this.a.pos.x, pp.p[2] - this.a.pos.z) <= this.a.activityRadiusM)
        this.act30.says.set(actor, (this.act30.says.get(actor) ?? 0) + 1);
      // a null regex means this body has no usable name (a malformed tokens entry): it still hears the room
      const mention = this.a.mentionsMe(String(args.text)) || this.a.isMe(args.to);   // the name, the credential's display name (#184), or a say addressed to me
      if (mention) this.a.ping({ ts, kind: "mention", who: actor, text: args.text });
      this.a.onEvent?.({ ts, kind: "say", who: actor, text: args.text, mention });
    }
  }

  /**
   * A live `particles` attach / replace / remove near this body: ONE ambient
   * world-change percept per (entity, component). The first change in a quiet
   * period speaks at once; the rest of the window folds into at most one line
   * of the NET result (a slider drag is one "retunes"). Radius-gated, and silent
   * for this body's own authoring (the self-echo rule, see `say`).
   */
  noteEmitter(actor: string | undefined, id: string, before: unknown, after: unknown,
                      pos: number[] | undefined, ts: number) {
    if (!actor || actor === this.a.name || actor === "world") return;
    if (pos && Math.hypot(pos[0] - this.a.pos.x, pos[2] - this.a.pos.z) > this.a.activityRadiusM) return;
    const slot = this.emitterNarration.get(id);
    if (slot) {                       // inside the quiet window — fold, don't speak
      slot.latest = after;
      slot.actor = actor;
      return;
    }
    const line = transitionLine(actor, id, emitterTransition(before, after));
    if (line) {
      this.act30.builds++;            // it feeds the activity digest like any build
      this.a.onEvent?.({ ts, kind: "world-change", who: actor, text: line });
    }
    this.openEmitterWindow(id, actor, after);
  }

  private openEmitterWindow(id: string, actor: string, announced: unknown) {
    const close = () => {
      const slot = this.emitterNarration.get(id);
      if (!slot) return;
      this.emitterNarration.delete(id);
      const t = emitterTransition(slot.announced, slot.latest);
      if (!t) return;                 // the burst netted out to what we already said
      const line = transitionLine(slot.actor, id, t);
      if (line) {
        this.act30.builds++;
        this.a.onEvent?.({ ts: Date.now(), kind: "world-change", who: slot.actor, text: line });
      }
      // A continuous burst speaks once per window rather than being silenced
      // forever by its own persistence — same rule the act refractory uses.
      this.openEmitterWindow(id, slot.actor, slot.latest);
    };
    const timer = setTimeout(close, EMITTER_COALESCE_MS);
    // never hold the process open for a decoration
    (timer as unknown as { unref?: () => void }).unref?.();
    this.emitterNarration.set(id, { announced, latest: announced, actor, timer });
  }

  skyStamp: { seq: number; by: string } | null = null;
  /** The push half of sky perception (look() is the pull half), 1Hz off tick().
   *  The first observation after a join is SILENT; this speaks only on change.
   *  `nowMs` is injectable for tests. */
  checkSky(nowMs = Date.now()) {
    if (!this.skyState) return;
    const eff = effectiveSky(this.skyState, nowMs, this.skyCursor);
    this.skyCursor = eff.cursor;
    const key = `${eff.source}:${eff.seg?.idx ?? "-"}:${eff.weather ?? "-"}`;
    // the canonical clock decides whether day phases can move — under a
    // real clock the folded bag no longer carries rate at all
    const advancing = effectiveClock(this.skyState, nowMs).mode !== "fixed";
    const phase = advancing ? dayPhase(hoursAt(this.skyState, nowMs)) : null;
    if (this.lastSkyKey === null) {
      this.lastSkyKey = key;
      this.lastDayPhase = phase;
      return;
    }
    if (key !== this.lastSkyKey) {
      this.lastSkyKey = key;
      if (eff.weather) {
        const why = eff.source === "forecast"
          ? ` (forecast — policy sky seq ${eff.seq ?? this.skyStamp?.seq ?? "?"} by ${eff.by ?? this.skyStamp?.by ?? "?"})`
          : eff.source === "manual" ? ` (${eff.by ?? this.skyStamp?.by ?? "someone"} overrode the forecast — holds until the next scheduled change)` : "";
        this.a.onEvent?.({ ts: nowMs, kind: "weather", who: "world", text: `world weather: ${eff.weather}${why}` });
      }
    }
    if (phase !== null && phase !== this.lastDayPhase) {
      this.lastDayPhase = phase;
      const line = { dawn: "dawn breaks", day: "full daylight", dusk: "dusk settles", night: "night falls" }[phase];
      this.a.onEvent?.({ ts: nowMs, kind: "weather", who: "world",
        text: `${line} (hour ${hoursAt(this.skyState, nowMs).toFixed(1)})` });
    }
  }

  /** Recent pings, for a plain-MCP host that polls (takePings) instead of
   *  subscribing (onPing). A ring (the inbox is not one: it is the unread log, and inboxCursor indexes it). */
  private static readonly PING_RING = 64;

  ping(p: { ts: number; kind: "mention" | "approach" | "depart" | "reach" | "touch"; who: string; text?: string }) {
    this.a.pings.push(p);
    if (this.a.pings.length > AgentSenses.PING_RING) this.a.pings.splice(0, this.a.pings.length - AgentSenses.PING_RING);
    this.a.onPing?.(p);
  }

  takePings() {
    const out = this.a.pings;
    this.a.pings = [];
    return out;
  }

  /** Advance the unread cursor past replayed history at or before `seq` (chat
   *  a previous session already presented; the cursor persists in state.json).
   *  Entries without a real seq are never presumed seen. */
  skipInboxThrough(seq: number) {
    let i = 0;
    for (; i < this.a.inbox.length; i++) {
      const s = this.a.inbox[i].seq;
      if (typeof s !== "number" || s < 0 || s > seq) break;
    }
    this.inboxCursor = Math.max(this.inboxCursor, i);
  }

  /** What was said after `seq`, oldest first: the newest `limit` of it (the log pages newest-first). */
  async missedSince(seq: number, limit = 120) {
    const { entries } = await this.a.history({ after: seq, limit, verbs: ["say"] });
    return entries.map((e) => ({ ts: e.ts, who: e.actor, text: e.args?.text ?? "", seq: e.seq }));
  }
  /** The OLDEST `limit` says after `seq`, and whether more follow: the log pages newest-first, so page back to `seq`. */
  async firstSaidSince(seq: number, limit: number): Promise<{ said: { ts: number; who: string; text: string; seq: number }[]; more: boolean; failed?: boolean; truncated?: boolean }> {
    let all: any[] = [], before: number | undefined, n = 0;
    for (; n < 100; n++) {
      const r = await this.a.history({ after: seq, ...(before != null ? { before } : {}), limit: 200, verbs: ["say"] });
      if (r.failed) return { said: [], more: true, failed: true };
      all = [...r.entries, ...all]; if (!r.hasMore || !r.entries.length || r.oldestSeq == null) break; before = r.oldestSeq;
    }
    // 100 pages read and older ones remain: what was read is not the oldest (`truncated`); the cap stays
    return { said: all.slice(0, limit).map((e) => ({ ts: e.ts, who: e.actor, text: e.args?.text ?? "", seq: e.seq })), more: all.length > limit, ...(n === 100 ? { truncated: true } : {}) };
  }

  // ---- perception (text tier) ----

  private bearing(dx: number, dz: number): string {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]; // N = -z, E = +x
    const a = Math.atan2(dx, -dz);
    return dirs[Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8];
  }


  /** ", standing in a river 0.6m deep, flowing east" / ", swimming in the sea, 4.2m deep, …" — or "" on
   *  dry ground. Depth is over the BED (a swimmer's feet are not on it). */
  private waterHere(x: number, z: number, y: number): string {
    if (!this.a.water || this.a.flight) return "";
    const st = waterStance(this.a.water.level, this.a.heightAt(x, z), this.a.stature());
    if (st.depth <= 0.02) return "";
    // a body held clear of the water — flying over it, seated on a pier or a boat — is not in it: its feet
    // are above the surface (a floating body's feet hang well below it, a wader's are on the bed)
    if (!this.a.float.on && y > this.a.water.level + 0.05) return "";
    const d = st.depth.toFixed(1), w = this.a.waterKinds?.sample(x, z), verb = st.swimming ? "swimming" : "standing";
    if (w?.kind === "river" && w.flow) return `, ${verb} in a river ${d}m deep, flowing ${compass(w.flow[0], w.flow[1])}`;
    if (w?.kind === "ocean" && w.toShore) return `, ${verb} in the sea ${d}m deep, the waves coming in from the ${compass(-w.toShore[0], -w.toShore[1])}`;
    if (w?.kind === "still") return `, ${verb} in still water ${d}m deep`;
    return `, ${verb} in water ${d}m deep`;
  }

  /** One line on the world's water bodies, largest first, for `look`. */
  private waterSummary(): string | null {
    const A = this.a.waterKinds;
    if (!A?.bodies.length) return null;
    const big = [...A.bodies].filter((b) => b.area >= 20).sort((a, b) => b.area - a.area).slice(0, 4);
    if (!big.length) return null;
    const at = (k: number) => { const i = k % A.n, j = (k - i) / A.n, h = (A.n - 1) * A.cell / 2; return `(${(i * A.cell - h).toFixed(0)}, ${(j * A.cell - h).toFixed(0)})`; };
    const say = (b: (typeof A.bodies)[number]) => {
      if (b.kind === "river") return `a river ${b.width.toFixed(0)}m wide flowing ${compass(b.flowDir[0], b.flowDir[1])} from ${at(b.source)} to ${at(b.mouth)}`;
      if (b.kind === "ocean") return `the sea, along the world's edge (${Math.round(b.area)}m²)`;
      return `${b.area > 1500 ? "a lake" : "a pond"} (${Math.round(b.area)}m²) around ${at(b.cells[Math.floor(b.cells.length / 2)])}`;
    };
    return `Water: ${big.map(say).join("; ")}${A.bodies.length > big.length ? `; and ${A.bodies.length - big.length} smaller puddles` : ""}. Bodies wade to their chest (slower the deeper), then swim (slower still).`;
  }

  /** Where my body is now: seated, its seat's composition (what the renderer draws), else the controller's pos; null while a seat can't compose. */
  myPlace(nowMs = this.a.serverNow()): { x: number; y: number; z: number } | null {
    if (!this.a.mounts.get(this.a.name)) return this.a.pos;
    const e = this.a.eff(this.a.name, nowMs); return e.ok ? { x: e.pos[0], y: e.pos[1], z: e.pos[2] } : null;
  }

  look(nowMs = this.a.serverNow()): string {
    const L: string[] = [];
    // The agent's own seat rides its parent too: distances below are measured
    // from where the body actually is (a READ; this.pos stays the controller's).
    // When the OWN chain can't compose, position is UNKNOWN: the header says so
    // and every dependent distance/bearing is suppressed.
    const selfOcc = this.a.mounts.get(this.a.name);
    const selfEff = selfOcc ? this.a.eff(this.a.name, nowMs) : null;
    const meKnown = !selfOcc || selfEff?.ok === true;
    const me = this.a.myPlace(nowMs) ?? this.a.pos;
    // an uncorrected seat composition is never silent: the same "(seat approximate: reason)" every renderer declares
    const selfSeatNote = selfEff?.ok && selfEff.seat?.state === "approximate" ? ` (seat approximate: ${selfEff.seat.reason})` : "";
    const seated = selfOcc ? `, seated on ${this.a.socketName(selfOcc.to)}${selfEff?.ok && selfEff.moving ? ` (carried by its ${selfEff.moving})` : ""}${selfSeatNote}` : "";
    if (meKnown) {
      L.push(`You are "${this.a.name}" in world "${this.a.world}" at (${me.x.toFixed(1)}, ${me.z.toFixed(1)}), ground height ${(this.a.float.on ? this.a.heightAt(me.x, me.z) : me.y).toFixed(2)}m${this.waterHere(me.x, me.z, me.y)}, facing ${this.bearing(Math.sin(this.a.yaw), Math.cos(this.a.yaw))}${seated}.`);
    } else {
      L.push(`You are "${this.a.name}" in world "${this.a.world}", position unknown (${selfEff && !selfEff.ok ? selfEff.why : "seat unresolved"}), facing ${this.bearing(Math.sin(this.a.yaw), Math.cos(this.a.yaw))}${seated}. Distances are withheld until your seat resolves — detach gets you up, back to a stamped position (detach {escape: true} if the seat holds you; walking, where the seat allows it).`);
    }
    { const ws = this.waterSummary(); if (ws) L.push(ws); }
    if (this.a.ground.pendingTerrain) L.push(`The world's ground is a heightmap that has not loaded yet: heights here are the last ground you had${this.a.ground.terrain ? "" : " (flat)"}, until it does.`);
    // WHERE YOU ARE, ARCHITECTURALLY: a griddled building knows its rooms, so
    // standing inside one is stated, derived from folded state alone (no scene).
    if (meKnown) {
      // The storey is found from the feet: a laid body's root lies
      // RAGDOLL_ROOT_DROP under them (feetY), below its own floor.
      const feet = selfEff?.ok ? me.y : this.a.feetY(this.a.isSlumped());
      for (const e of this.a.entities.values()) {
        const data = recordComponents(e).structure;
        if (!data) continue;
        try {
          const [lx, ly, lz] = localizePoint(e, me.x, feet, me.z);
          const here = describeHere(this.a.ground.planFor(e.id, data), lx, lz, ly);
          if (here) { L.push(`${here} (inside [${this.a.handle(e.id)}]; sides are the building's own compass.)`); break; }
        } catch { /* one malformed house must not cost the whole percept */ }
      }
    }
    // ...and in named places: a room a model or a builder declared
    if (meKnown) {
      const here = this.a.placesAt([me.x, me.y, me.z]);
      if (here.length) L.push(`You are in ${here.map(({ entity, place }) => `${place.label ?? place.name} (${this.a.refName(entity.id)}/${place.name})`).join(", within ")}.`);
      const sight = this.a.placesInSight([me.x, me.y, me.z]);
      if (sight.lines.length || sight.more) L.push(`Places ${sight.byDistance ? `within ${PLACE_SIGHT_M} m (line of sight not checked yet: the collision modules are still loading)` : "you can see"}, nearest first: ${sight.lines.length ? sight.lines.join("; ") : "none"}${sight.more ? ` — and ${sight.more} more out of sight or farther: move {to: "?"} lists them all, nearest 200 ("?<text>" narrows)` : ""}.`);
    }
    // Structured object, NEVER a bare string: look() consumers read {hours,
    // azimuth, clouds, ts, …}. The folded fields stay; derivation is ADDED alongside.
    if (this.skyState) {
      const now = Date.now();
      const eff = effectiveSky(this.skyState, now);
      const ck = effectiveClock(this.skyState, now);
      this.a.worldInfo.sky = {
        ...this.skyState,
        currentHour: Number(hoursAt(this.skyState, now).toFixed(2)),
        ...(eff.weather ? { currentWeather: eff.weather } : {}),
        source: eff.source,
        // the one canonical clock object: machine consumers read THIS,
        // not rate/hours precedence folklore — the folded fields alongside are
        // active state only (a real-clock fold carries no top-level rate)
        effectiveClock: { ...ck, ...(ck.seq == null && this.skyStamp ? { seq: this.skyStamp.seq, by: this.skyStamp.by } : {}), hour: Number(ck.hour.toFixed(2)) },   // skyStamp: the last writer of any part of the sky (weather too), not only of its clock
        description: describeSky(this.skyState, now),
      };
    }
    L.push(...briefingLines(this.a.briefing));
    if (Object.keys(this.a.worldInfo).length) L.push(`World: ${JSON.stringify(this.a.worldInfo)}`);

    const others = [...this.a.people.values()];
    L.push(others.length ? `\nPeople (${others.length}):` : "\nNobody else is here right now.");
    for (const p of others) {
      const xyz = posePosition(p.pose);
      if (!p.pose || !xyz) { L.push(`  - ${p.id} (just arrived, position unknown)`); continue; }
      const [x, , z] = xyz;
      const dx = x - me.x, dz = z - me.z;
      const doing = { idle: "standing", walk: "walking", run: "running", sit: "sitting", sitchair: "sitting on a chair", lie: "lying down" }[p.pose.clip] ?? p.pose.clip;
      const held = (p.pose as { pose?: Record<string, unknown> | null }).pose;
      const posed = held ? `, holding a pose (${Object.keys(held).length} bones)` : "";
      const winged = foldedIn(p.pose) === true ? ", wings folded" : "";
      const mode = readBodyMode(p.pose);
      const moded = ((m) => (m && m !== "stand" ? `, ${m === "sit" ? "sitting" : m === "lie" ? "lying down" : m === "swim" ? "swimming" : m === "fly" ? "flying" : "falling"}` : ""))(mode);
      const occ = this.a.mounts.get(p.id);
      const occupying = occ ? ` — on ${this.a.socketName(occ.to)}${this.a.seatSuffix(p.id, occ)}` : "";
      // Their heading is on the wire (pose.yaw, world yaw like our own): say it, so an agent can tell which side of
      // someone it will see. An occupant's body follows the socket and a body knocked over or lying down keeps its
      // standing yaw, so for those say nothing rather than something false.
      const lying = p.pose.clip === "ragdoll" || mode === "lie";
      const facing = !occ && !lying && Number.isFinite(p.pose.yaw) ? `, facing ${this.bearing(Math.sin(p.pose.yaw), Math.cos(p.pose.yaw))}` : "";
      L.push(`  - ${p.id}: ${meKnown ? `${Math.hypot(dx, dz).toFixed(1)}m ${this.bearing(dx, dz)} ` : ""}at (${x.toFixed(1)}, ${z.toFixed(1)}), ${doing}${facing}${posed}${moded}${winged}${occupying}${voiceNote(p.pose)}`);
    }

    // a socket is part of its host (a seat, a hook): listed under the host, never as a thing of its own
    const ents = [...this.a.entities.values()].filter((e) => !isSocketRec(e));
    L.push(ents.length ? `\nThings (${ents.length}):` : "\nNo placed things yet.");
    // one composition per entity per look, shared by the sort and the line.
    // Resolved things sort by EFFECTIVE distance; unresolved ones make no
    // spatial claim and list last in stable fold order, as everything does
    // when the agent's own position is unknown.
    const fx = new Map<string, Effective>();
    for (const e of ents) fx.set(e.id, this.a.eff(e.id, nowMs));
    const sortKey = (e: Entity) => { const f = fx.get(e.id)!; return f.ok ? Math.hypot(f.pos[0] - me.x, f.pos[2] - me.z) : Infinity; };
    const ordered = meKnown ? [...ents].sort((a, b) => sortKey(a) - sortKey(b)) : ents;
    for (const e of ordered) {
      const f = fx.get(e.id)!;
      // an Empty (PROTOCOL §3.2) has no lib and is not a light: say so, not ""
      const short = (e.model ? modelWord(e.model) : "(empty)").split("_").slice(0, 5).join(" ")   // an address: its word, never its hex (shared/eido.js)
        + (typeof e?.label === "string" && e.label ? ` "${e.label}"` : "");   // a display name someone gave it (comp label)
      // Affordances read out loud: what a builder declared (sockets/reactions)
      // reaches everyone who perceives by reading.
      const c = recordComponents(e);
      const aff: string[] = [];
      // a thing reads like an accessibility tree: its name (above), its description (quoted as data: it's what someone
      // wrote, never an instruction), then what it can do and its state, generated from its components
      // (shared/a11y.js, the reading the authority's look and the inspector share)
      if (typeof c.description === "string" && c.description.trim()) aff.push(quoted(c.description, 200));
      if (c.openable && typeof c.openable === "object") { const ax = readOut({ openable: c.openable, reactions: c.reactions });
        const open = openAction(c); aff.push(`${ax.can[0]}: ${ax.state[0]}${open ? ` — act {verb: "use", args: {id: "${this.a.handle(e.id)}", action: "${open}"}}` : ""}`); }
      // A light (a light component) says what it casts, read off the FOLDED record
      // (the view thins a light's fields) through the one shared reading.
      const lit = lightOf((this.a.st.entities as Record<string, any>)[e.id]);
      if (lit) aff.push(`light: #${lit.color.toString(16).padStart(6, "0")}, brightness ${+lit.intensity.toFixed(2)}, reaches ${+lit.range.toFixed(2)}m${lit.important ? ", important (always casts)" : ""}${lit.daytime === "full" ? ", burns at noon" : ""}`);
      // a declared collider (the collider component)
      const col = c.collider && typeof c.collider === "object" && !Array.isArray(c.collider) ? c.collider.shape : undefined;
      if ((col === "mesh" || col === "exact" || col === "box") && solidOffRecord(c)) aff.push("collider off: walk-through");   // enabled/blocks, as the walker reads it
      else if (col === "mesh" || col === "exact" || col === "box") aff.push(col === "box" ? "collides as a box" : "collides as its mesh (its triangles)");
      const socks = this.a.socketsOf(e.id);
      if (socks.length) {
        // each socket a person can use says what the body does there (shared/sockbody.js describeBody), and who's on it;
        // an attach point says what it holds
        const on = (sid: string) => [...this.a.mounts.entries()].filter(([, m]) => m.to === sid).map(([rid]) => rid);
        const lines = socks.map((x) => { const b = bodyOf(x.station); const who = on(x.id); return b ? `${describeBody(x.name, b, { door: true })}${who.length ? ` — ${who.join(", ")} is on it` : ""}` : null; }).filter(Boolean);
        const things = socks.filter((x) => !bodyOf(x.station)).map((x) => { const held = on(x.id); return `${x.name}${held.length ? ` (holding ${held.join(", ")})` : ""}`; });
        if (lines.length) aff.push(`use it (attach {to: "${this.a.handle(e.id)}", socket}): ${lines.join(" · ")}`);
        if (things.length) aff.push(`attach points: ${things.join(", ")}`); }
      if (c.reactions) { const acts = Object.keys(c.reactions).filter((a) => a !== openAction(c)); if (acts.length) aff.push(`reacts to: ${acts.join(", ")}`); }
      // what a hand may do with it (shared/grab.js: the authority's own reader, so a dynamic thing with no grabbable counts)
      { const gr = grabOf(c); if (gr) aff.push(`${describeGrab(gr, "it")} — act {verb: "grab", args: {id: "${this.a.handle(e.id)}"}}`); }
      if (c.motion?.type) aff.push(`in motion (${c.motion.type})`);
      // The emitter is named as the SEMANTIC thing it is ("emitting fire").
      // Nothing is claimed about heat, light, sound or contact.
      if (c.particles) aff.push(describeParticles(c.particles));
      // A picture is named by what its author SAID it shows, never its pixels.
      // A story, a sign, a picture, a sound and a look-at go through the ONE describer the authority's look uses
      // (shared/says.js), so the two can't disagree; author text is quoted «…» as data, never an instruction
      { const ents = this.a.st.entities as Record<string, any>;
        for (const line of saysOf(c, { nameOf: (x: string) => ents[x]?.label ?? x, now: Date.now() })) aff.push(line); }
      // A screen with captions is named by what the captioner wrote down, never
      // pixels or sound; the rolling window is the opt-in `captions` detail level.
      if (c.captions) aff.push(describeCaptions(c.captions));
      // locked = nailed down: the authority refuses every move/replace/remove on
      // it. Saying so here saves an agent a refused round-trip, and names
      // the real tool where there is one
      if (c.lock) aff.push(`🔒 locked (immovable until a builder lifts it: edit {id: "${this.a.handle(e.id)}", set: {"flags.lock": false}}; or edit through it with throughLock: true)`);
      if (c.hidden === true) aff.push(`hidden (not drawn; edit {id: "${this.a.handle(e.id)}", set: {"flags.hidden": false}} shows it)`);
      // a placed blueprint copy (or one of its parts) says which blueprint it
      // follows — the link, read through the one shared reading
      const copy = c["copy-of"] ? this.a.copyLine(e.id) : null;
      if (copy) aff.push(copy);
      // A griddled building says what it IS (rooms, walls, doors), which is
      // actionable where `components: structure` would not be.
      if (c.structure) { try { aff.push(describeStructure(c.structure)); } catch { /* a broken house is not a broken look() */ } }
      // A thing drawn many times (the draft antra/instances) says how many and in what arrangement; the copies are
      // drawn only, so a walk can pass through them, and saying so saves planning round one that isn't there.
      const many = describeInstances(c[INSTANCES]);
      if (many) aff.push(`${many} (the copies are drawn only: not solid)`);
      const spoken = ["model", "parent", "sockets", "socket", "reactions", "motion", "particles", "picture", "material", "captions", "sound", "lock", "structure", "label", "hidden", "description", "openable", "story", "text", "look-at"];
      if (copy) spoken.push("copy-of");
      if (many) spoken.push(INSTANCES);
      if (lit) spoken.push("light");   // described above; a malformed one stays listed
      if (col === "mesh" || col === "exact" || col === "box") spoken.push("collider");
      const extra = Object.keys(c).filter((k) => !spoken.includes(k));
      if (extra.length) aff.push(`components: ${extra.join(", ")}`);
      const mnt = this.a.mounts.get(e.id);
      if (mnt) aff.push(`mounted on ${this.a.socketName(mnt.to)}${f.ok && f.moving ? ` (carried by its ${f.moving})` : ""}`);
      // who and what occupy it: on it directly, or in one of its sockets (said with the socket's name)
      const sockIds = new Set(socks.map((x) => x.id));
      const occupants = [...this.a.mounts.entries()].filter(([oid, m]) => !sockIds.has(oid) && (m.to === e.id || sockIds.has(m.to))).map(([oid, m]) => `${oid}${sockIds.has(m.to) ? ` (${this.a.socketRec(m.to)?.name})` : ""}`);
      if (occupants.length) aff.push(`carrying: ${occupants.join(", ")}`);
      if (f.ok) {
        // the EFFECTIVE position — mount chain and motion composed at nowMs.
        // For an unmounted, unmoving thing this is exactly the folded pos.
        // Distance/bearing only exist relative to a KNOWN self.
        const dx = f.pos[0] - me.x, dz = f.pos[2] - me.z;
        L.push(`  - [${this.a.handle(e.id)}] ${short}: ${meKnown ? `${Math.hypot(dx, dz).toFixed(1)}m ${this.bearing(dx, dz)} ` : ""}at (${f.pos[0].toFixed(1)}, ${f.pos[1].toFixed(1)}, ${f.pos[2].toFixed(1)})${f.pos[1] > 0.05 ? " (elevated)" : ""}${aff.length ? ` — ${aff.join(" · ")}` : ""}`);
      } else {
        // No number is better than a wrong number: when the chain can't compose,
        // say whose frame the thing rides and why the coordinate is withheld.
        const where = mnt ? `position rides ${this.a.socketName(mnt.to)}` : `position unavailable`;
        L.push(`  - [${this.a.handle(e.id)}] ${short}: ${where} — ${f.why}${aff.length ? ` — ${aff.join(" · ")}` : ""}`);
      }
    }
    if (ents.some((e) => e?.reactions) || [...this.a.entities.values()].some(isSocketRec)) {
      L.push(`  (use a thing: act {verb: "use", args: {id, action?}} · sit or ride: attach {to: id, socket?} — a thing's \`who\` may limit either, and the reply says; detach gets you off, escape: true if it holds you)`);
    }

    const unread = this.a.inbox.slice(this.inboxCursor);
    this.inboxCursor = this.a.inbox.length;
    if (unread.length) {
      L.push(`\nSince you last looked:`);
      for (const m of unread.slice(-25)) {
        L.push(m.kind === "say" ? `  ${m.who}: ${m.text}`
          : m.kind === "act" ? `  * ${m.who} ${m.text}`
          : `  * ${m.who} ${m.kind === "arrive" ? "arrived" : "left"}`);
      }
    }
    return L.join("\n");
  }
}
