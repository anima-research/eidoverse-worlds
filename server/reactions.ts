// eidoverse-worlds sequencer — reactions (TEL0S_NOTES §15, step 7a).
// The reaction slice of the behavior runtime and the pendulum math it emits.
// Takes a structural world — the same seam as behaviors.ts's WorldLike — so
// this module imports nothing server-side and can never cycle back into
// server.ts.

import type { LogEntry, WorldState } from "../shared/fold.js";

/** What a reaction needs from the world it fires in: the folded state, the
 *  log, the fanout, and the flight recorder. server.ts's World satisfies it
 *  structurally (the wireBehaviorGate/WorldLike precedent — §15.1). */
export type ReactionWorld = {
  name: string;
  state: WorldState;
  append(actor: string, verb: string, args: Record<string, unknown>): LogEntry;
  broadcast(msg: unknown): void;
  debug(kind: string, detail: Record<string, unknown>): void;
};

// ---------------------------------------------------------------- reactions
//
// The first slice of the behavior runtime: an entity's `reactions` component
// maps a use-action to an effect. The shape is the general one — triggers in,
// ordinary logged verbs out, cause carried in the entry — even though only one
// effect kind exists so far (a pendulum impulse: the swing). Reactions run
// with WORLD authority precisely because the trigger is rank 0: a visitor may
// push the swing, and the push moving the swing is the AUTHOR's standing
// decision (they attached the component), not the visitor's rights.
//
// Wrapped whole in try/catch: no reaction may ever take the server down
// (lesson of the 4f82250 crash loop — a ws handler must never leak a throw).

export function reactToUse(w: ReactionWorld, cause: LogEntry): void {
  const a = cause.args as Record<string, unknown>;
  const id = String(a?.id ?? "");
  const action = String(a?.action ?? "use");
  try {
    const ent = w.state.entities[id];
    if (!ent) {
      w.debug("reaction-skip", { entity: id, action, by: cause.actor, why: "no such entity" });
      return;
    }
    const rx = (ent.comp?.reactions as Record<string, any> | undefined)?.[action];
    if (!rx) {
      w.debug("reaction-skip", { entity: id, action, by: cause.actor,
        why: ent.comp?.reactions ? `no reaction for "${action}" (has: ${Object.keys(ent.comp.reactions as object).join(", ")})`
          : "entity has no reactions component" });
      return;
    }
    if (rx.impulse != null) {
      const m = (ent.comp?.motion as Record<string, unknown>) ?? {};
      if (m.type != null && m.type !== "pendulum") {   // impulses push pendulums (so far)
        w.debug("reaction-skip", { entity: id, action, by: cause.actor,
          why: `impulse needs a pendulum motion, found "${m.type}"` });
        return;
      }
      const next = pendulumImpulse(m, Number(rx.impulse), cause.ts);
      const entry = w.append("world", "motion",
        { id: a.id, ...next, cause: cause.seq, by: cause.actor });
      w.broadcast({ type: "log", entry });
      w.debug("reaction", { entity: id, action, by: cause.actor, cause: cause.seq, effect: entry.seq });
      return;
    }
    w.debug("reaction-skip", { entity: id, action, by: cause.actor,
      why: `reaction has no effect this server knows (${Object.keys(rx).join(", ")})` });
  } catch (err) {
    console.error(`[world:${w.name}] reaction failed (never fatal)`, err);
    w.debug("reaction-error", { entity: id, action, by: cause.actor, error: String(err) });
  }
}

/** Closed-form pendulum push: evaluate angle and angular velocity at the push
 *  instant, add the impulse to velocity, re-express as fresh (amp, phase, t0).
 *  Pushing against the motion does little; pushing with it builds — a real
 *  swing's feel, in one logged entry. Damping is applied to amplitude between
 *  pushes and ignored in the instantaneous velocity term (small for the damp
 *  values that look right).
 *  ⚠ MIRRORED in client/lib/motion.js (evalPendulum) — keep the math in sync,
 *  or joiners see a swing that disagrees with the one being pushed. */
export function pendulumImpulse(m: Record<string, unknown>, impulse: number, ts: number) {
  const period = Number(m.period ?? 3.5);
  const w0 = (2 * Math.PI) / period;
  // mirrored with pendulumTheta: missing damp = 0 = perpetual. Friction is
  // opt-in; pushable-swing recipes set it explicitly because decay-between-
  // pushes is part of that design.
  const damp = Number(m.damp ?? 0);
  const t = m.t0 != null ? Math.max(0, (ts - Number(m.t0)) / 1000) : 0;
  // generous reader, mirrored with the client: `amplitude` is amp too
  const amp = Number(m.amp ?? (m as any).amplitude ?? 0) * Math.exp(-damp * t);
  const ph = w0 * t + Number(m.phase ?? 0);
  const theta = amp * Math.cos(ph);
  const vel = -amp * w0 * Math.sin(ph) + (Number.isFinite(impulse) ? impulse : 0);
  const maxAmp = Number(m.maxAmp ?? 1.1);
  const namp = Math.min(maxAmp, Math.hypot(theta, vel / w0));
  const nphase = Math.atan2(-(vel / w0), theta);
  return {
    type: "pendulum",
    axis: (m.axis as number[]) ?? [1, 0, 0],
    pivot: (m.pivot as number[]) ?? [0, 2, 0],
    period, damp,
    ...(m.maxAmp != null ? { maxAmp } : {}),
    amp: Math.round(namp * 1000) / 1000,
    phase: Math.round(nphase * 1000) / 1000,
    t0: ts,
  };
}
