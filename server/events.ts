// eidoverse-worlds sequencer — the entry bus (overhaul charter §4, phase 1
// slice 4). The log stops being only persistence and becomes the event
// spine: ONE published event per appended entry, and systems SUBSCRIBE,
// instead of every append site hand-rolling its own fanout.
//
// Before this module, seven sites each carried their own copy of
// `append(...) + broadcast({type:"log", entry})`, and exactly one of them
// (runVerb) also remembered to tell the behavior host — so which systems
// heard an entry depended on where in the codebase it happened to be born.
// Now birth IS publication: World.commit() appends and publishes, and the
// subscribers registered at boot (client fanout, behaviors — later: seats,
// recorders, the sim core) hear every committed entry uniformly.
//
// Deliberate rulings, so absences stay decisions instead of drift:
//  - `genesis` stays a plain append, published to nobody — it is a birth
//    certificate written before or between audiences (constructor, reset),
//    and today's wire never carried it; the bus must not start carrying it
//    by accident.
//  - Listener order is registration order: client fanout FIRST (the wire's
//    seq stream must stay dense and ordered — an after-hook that commits an
//    effect entry publishes it after its cause has gone out), behaviors
//    second. This moves bhv.onEntry BEFORE a verb's after-hook (it used to
//    run after) — the one observable reordering, ruled acceptable: the only
//    verb both parties handle is `use`, and a script hearing `use` a
//    microtask before the reaction's effect entry lands sees the pre-push
//    motion comp, which is a legal moment of the world. behaviortest +
//    paritybench hold the line.
//  - Per-listener error isolation, house rule 3: one subscriber's throw
//    costs that subscriber that entry, never its neighbors, never the
//    append (the log is already written — truth does not roll back because
//    a fanout tripped).

import type { LogEntry } from "../shared/fold.js";

/** What a subscriber may lean on, structurally — the WorldLike seam. */
export type BusWorld = {
  name: string;
  broadcast(msg: unknown, except?: unknown): void;
  bhv: { onEntry(entry: LogEntry): void };
};

type Stat = { delivered: number; errors: number; lastError: string | null };
const listeners: { name: string; fn: (w: BusWorld, entry: LogEntry) => void; stat: Stat }[] = [];

/** Subscribe a system to every committed entry, in every world. */
export function onEntryCommitted(name: string, fn: (w: BusWorld, entry: LogEntry) => void) {
  listeners.push({ name, fn, stat: { delivered: 0, errors: 0, lastError: null } });
}

/** Publish one committed entry. Called by World.commit — nothing else. */
export function publishEntry(w: BusWorld, entry: LogEntry) {
  for (const l of listeners) {
    try {
      l.fn(w, entry);
      l.stat.delivered++;
    } catch (err) {
      l.stat.errors++;
      l.stat.lastError = String(err);
      console.error(`[bus:${l.name}] world ${w.name} seq ${entry.seq}`, err);
    }
  }
}

/** Gauges, served beside the heartbeat's at GET /tick. */
export function entryBusStats() {
  return listeners.map((l) => ({ name: l.name, ...l.stat }));
}
