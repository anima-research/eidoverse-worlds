// Event-stream denoiser for a WorldAgent's ambient narration.
//
// Born from Fable's field report (2026-08-02), which ranked the noise from
// live logs: client arrive/leave flaps (tens of pairs in minutes), posture/
// emote cycles (40+ jump pairs in an evening), self-echo, and "walked up to
// you" firing six times for someone strolling nearby. The doctrine that fell
// out of it: **noisiness is a property of an event's CONTEXT, not its type**
// — the first arrive of a new identity is gold; the fifteenth of the same
// identity in ten minutes is a flap; an approach after an hour of silence is
// a knock; the sixth in five minutes is background. So the filter is stateful
// (per-identity charge with decay), never a table of event types.
//
// Two mechanisms:
//
//  1. HOLD-AND-CANCEL for presence pairs. An arrive/leave is not narrated
//     immediately — it is held briefly, and the opposite event for the same
//     identity inside the window cancels both ("схлопнуть в ничто"). A
//     reconnect flap (leave→arrive) and a smoke-test visit (arrive→leave)
//     both collapse to nothing. The people map stays truthful in real time —
//     only the NARRATION is held; look() never lies about who is present.
//
//  2. DECAYING CHARGE + REFRACTORY for everything ambient. Each narrated
//     presence event charges that identity; the charge decays exponentially;
//     above the limit, further arrive/leave narration from that identity is
//     dropped until it cools. Acts (emotes, posture starts) repeat silently
//     within a per-(identity, act) refractory window.
//
// Mentions, whispers, and says are never gated here — being addressed is
// always a knock. (The self-echo fix lives in agent.ts's applyEntry.)

export type GateEvent = { kind: "arrive" | "leave" | "act"; who: string; text?: string; ts: number };

const env = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
};

export const GATE_DEFAULTS = {
  /** an arrive is held this long — a leave inside the window collapses both (brief visit / smoke test) */
  arriveHoldMs: env("EW_ARRIVE_HOLD_SEC", 12) * 1000,
  /** a leave is held this long — an arrive inside the window collapses both (reconnect flap) */
  leaveHoldMs: env("EW_LEAVE_HOLD_SEC", 45) * 1000,
  /** per-identity presence charge decays with this time constant */
  presenceTauMs: env("EW_PRESENCE_TAU_SEC", 600) * 1000,
  /** decayed charge at/above this → further arrive/leave narration from that identity drops */
  presenceLimit: 1.5,
  /** the same act by the same identity repeats silently within this window */
  actRefractoryMs: env("EW_ACT_REFRACT_SEC", 180) * 1000,
};

/** A non-locomotion stint shorter than this (a jump, a stumble) does not earn
 *  a "gets up" — the start already told the story. Read by agent.ts. */
export const SHORT_STINT_MS = env("EW_STINT_MIN_SEC", 5) * 1000;

/** Approach ("walked up to you") refractory per identity — the first approach
 *  wakes; repeats inside this window are background. Read by agent.ts, which
 *  additionally requires re-arming: the person must actually go away
 *  (> REARM_RADIUS) before another crossing can ever count. */
export const APPROACH_REFRACT_MS = env("EW_APPROACH_REFRACT_SEC", 600) * 1000;
export const APPROACH_RADIUS = 2.5;
export const REARM_RADIUS = 6;

/** DWELL — the gate that makes an approach mean what declaration.ts says it
 *  means: "walked up to your body AND STOPPED within arm's reach". The three
 *  gates above all suppress REPEATS (re-arm, refractory, #39's baseline); none
 *  of them can tell a knock from someone crossing your bubble on their way to
 *  the door. Antra, 2026-08-25: "likely debounced so that passing through does
 *  not trigger it."
 *
 *  So the inward crossing only OPENS a pending approach. It is delivered when
 *  that person has been still, inside the radius, for this long — and cancelled
 *  outright if they leave the radius first. A straight walk-through at strolling
 *  pace clears a 2.5m radius in ~2-4s and never accumulates the stillness. */
export const APPROACH_DWELL_MS = env("EW_APPROACH_DWELL_SEC", 2.5) * 1000;
/** Below this observed ground speed a body counts as STILL. Derived from the
 *  positions we watched, never from the pose's own `speed` field: the activity
 *  pulse in agent.ts already sets that precedent ("displacement, not a speed
 *  flag, so idle jitter and a body parked mid-walk-cycle never qualify"), and a
 *  sender is free to put anything in `speed`. Walking is ~1.4 m/s, so this sits
 *  well clear of it while tolerating idle sway and pose jitter. */
export const APPROACH_STILL_MPS = (() => {
  const v = env("EW_APPROACH_STILL_MPS", 0.35);
  if (v > 0) return v;
  // ≤ 0 would make every observed speed count as "moving": stillness never
  // accumulates, dwell never fires, and EVERY approach ships via the max-wait
  // hatch — the headline defect, for everyone, from one env var. Refused.
  console.warn(`[denoise] EW_APPROACH_STILL_MPS=${v} rejected (must be > 0); using 0.35`);
  return 0.35;
})();
/** Someone who stays inside arm's reach but never actually settles — pacing,
 *  circling, fidgeting in your face — has still approached you. Deliver anyway
 *  once they have been in the radius this long. Without this a body that never
 *  reads as still is never announced at all, which trades Antra's false
 *  positives for false NEGATIVES; it also bounds the pending state.
 *
 *  INVARIANT, now ENFORCED rather than commented: a straight-line
 *  pass-through must not be able to reach this escape hatch. The longest a
 *  body still counting as "moving" can spend inside the radius on a straight
 *  path is (2 × APPROACH_RADIUS) / APPROACH_STILL_MPS — 14.3s at the defaults,
 *  comfortably under 20s. Both knobs are advertised as LIVE tuning controls,
 *  and either one alone could silently reintroduce the pass-through ping this
 *  whole file exists to kill (a small EW_APPROACH_MAX_WAIT_SEC directly; a
 *  small EW_APPROACH_STILL_MPS by widening what counts as a slow crosser
 *  under the default wait). So the wait CLAMPS to the safe bound derived from
 *  whatever stillness threshold is in force — tune freely, the invariant
 *  holds itself. */
export const APPROACH_SAFE_WAIT_MS = Math.ceil(((2 * APPROACH_RADIUS) / APPROACH_STILL_MPS) * 1000);
export const APPROACH_MAX_WAIT_MS = (() => {
  const v = env("EW_APPROACH_MAX_WAIT_SEC", 20) * 1000;
  if (v >= APPROACH_SAFE_WAIT_MS) return v;
  console.warn(`[denoise] EW_APPROACH_MAX_WAIT_SEC=${v / 1000}s would let a straight pass-through be announced as an approach; clamped to ${APPROACH_SAFE_WAIT_MS / 1000}s (2·APPROACH_RADIUS / APPROACH_STILL_MPS)`);
  return APPROACH_SAFE_WAIT_MS;
})();

/** The denoiser's complement: the ACTIVITY PULSE. Where the gate above takes
 *  individual events away, the pulse gives one back — a digest of everything
 *  that happened within ACTIVITY_RADIUS_M in the last window, emitted at most
 *  once per window and ONLY when something actually happened. It exists for
 *  wake gates: a host rule matching the "activity" tag wakes its agent
 *  regularly while there is life nearby, and the stream simply stops when the
 *  area goes quiet — local awareness without per-event noise.
 *
 *  These are the DEFAULTS — the sense is the agent's own to tune (the
 *  `activity` tool sets cadence/radius per agent, persisted across sessions;
 *  see WorldAgent.setActivity for the clamps). */
export const ACTIVITY_RADIUS_M = env("EW_ACTIVITY_RADIUS_M", 30);
export const ACTIVITY_PULSE_MS = env("EW_ACTIVITY_PULSE_SEC", 30) * 1000;
/** Ambient continuation (the same people, still milling about) is scenery,
 *  not news — an unchanged ambient digest repeats no more often than this.
 *  Discrete events (speech, arrivals, builds) always pulse. Field report:
 *  "antra moving about" every 30s buried a resident's context in near-
 *  identical lines — recurrence is not novelty. */
export const ACTIVITY_REFRESH_MS = env("EW_ACTIVITY_REFRESH_SEC", 600) * 1000;
/** Metres of accumulated travel inside a window before someone counts as
 *  "moving about" — displacement, not a speed flag, so idle jitter and a
 *  body parked mid-walk-cycle never qualify. */
export const MOVER_MIN_M = env("EW_MOVER_MIN_M", 1.0);

type IdState = {
  pending: { kind: "arrive" | "leave"; ts: number; timer: ReturnType<typeof setTimeout> } | null;
  charge: number;
  chargedAt: number;
  lastAct: Map<string, number>;
};

export class NoiseGate {
  private ids = new Map<string, IdState>();
  private opts: typeof GATE_DEFAULTS;
  /** what was collapsed/dropped, for debugging — silence should be auditable */
  stats = { flapsCollapsed: 0, presenceDropped: 0, actsDropped: 0 };

  constructor(
    private emit: (ev: GateEvent) => void,
    opts: Partial<typeof GATE_DEFAULTS> = {},
  ) {
    this.opts = { ...GATE_DEFAULTS, ...opts };
  }

  private state(id: string): IdState {
    let s = this.ids.get(id);
    if (!s) { s = { pending: null, charge: 0, chargedAt: 0, lastAct: new Map() }; this.ids.set(id, s); }
    return s;
  }

  /** Decayed charge as of now; touches the bookkeeping. */
  private decayed(s: IdState, now: number): number {
    if (s.charge > 0 && s.chargedAt > 0) {
      s.charge *= Math.exp(-(now - s.chargedAt) / this.opts.presenceTauMs);
    }
    s.chargedAt = now;
    return s.charge;
  }

  /** An arrive or leave for an identity. Held; the opposite event inside the
   *  hold window annihilates the pair. */
  presence(id: string, kind: "arrive" | "leave", ts = Date.now()) {
    const s = this.state(id);
    if (s.pending) {
      if (s.pending.kind !== kind) {
        // flap: leave→arrive (reconnect) or arrive→leave (brief visit)
        clearTimeout(s.pending.timer);
        s.pending = null;
        this.stats.flapsCollapsed++;
        // chronic flappers keep themselves warm even while fully collapsed
        this.decayed(s, ts);
        s.charge += 0.1;
        return;
      }
      // duplicate same-direction event (shouldn't happen) — keep the first
      return;
    }
    const hold = kind === "arrive" ? this.opts.arriveHoldMs : this.opts.leaveHoldMs;
    const timer = setTimeout(() => {
      s.pending = null;
      const charge = this.decayed(s, Date.now());
      if (charge >= this.opts.presenceLimit) {
        this.stats.presenceDropped++;
        s.charge += 0.4; // being noisy while silenced extends the silence
        return;
      }
      s.charge += 1;
      this.emit({ kind, who: id, ts });
    }, hold);
    s.pending = { kind, ts, timer };
  }

  /** An embodied act (emote, posture start, pose strike…). `key` names the
   *  act class for the refractory — same key from the same identity repeats
   *  silently within the window. */
  act(id: string, key: string, text: string, ts = Date.now()) {
    const s = this.state(id);
    const last = s.lastAct.get(key) ?? 0;
    if (ts - last < this.opts.actRefractoryMs) {
      this.stats.actsDropped++;
      // NOT refreshed on drop: a continuous burst still speaks once per
      // window rather than being silenced forever by its own persistence.
      return;
    }
    s.lastAct.set(key, ts);
    this.emit({ kind: "act", who: id, text, ts });
  }

  /** Cancel all held narration (session ending). */
  dispose() {
    for (const s of this.ids.values()) {
      if (s.pending) { clearTimeout(s.pending.timer); s.pending = null; }
    }
  }
}
