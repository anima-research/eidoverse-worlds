// event-wire — the tag set each world event goes out with, kept out of net-server.ts (which listens at module load)
// so test/mcpl/event-wire-test.ts can import it. Delivery decisions stay in net-server.ts.
//
// Kind facet (RFC-001 rev 3): notices nobody sent (weather, world change, arrive/leave, activity digest, catch-up
// header) carry `chat:system` beside `chat:ambient`, so a host routing by the latest message doesn't follow a notice
// into the world. Acts and unaddressed speech stay plain `chat:ambient`; a say that mentions this agent is
// `chat:mention` + `chat:addressed` instead (declaration.ts speechTags).

import { CHAT, EIDO, tags, speechTags } from "./declaration.ts";

export type WireEventKind =
  | "say" | "act" | "activity" | "weather" | "world-change" | "arrive" | "leave";

/** The tags a live world event is delivered with. `declares`: the speaker's declared word (PROTOCOL §6a rule 3),
 *  a sender facet on speech and acts only. `mention`: the speech named this agent. */
export function eventTags(kind: WireEventKind, opts: { declares?: string | null; mention?: boolean; part?: "ground" } = {}): string[] {
  switch (kind) {
    case "say":
      return speechTags("say", opts.declares, !!opts.mention);
    case "act":
      return speechTags("act", opts.declares);
    case "activity":
      // the door's own summary of nearby activity: a notice
      return tags(CHAT.ambient, CHAT.system, EIDO.activityDigest);
    case "weather":
      return tags(CHAT.ambient, CHAT.system, EIDO.weather);
    case "world-change":   // an emitter, unless the event says the ground (agent-senses.ts noteGround)
      return tags(CHAT.ambient, CHAT.system, EIDO.worldChange, opts.part === "ground" ? EIDO.ground : EIDO.particles);
    case "arrive":
    case "leave":
      return tags(CHAT.ambient, CHAT.system, EIDO.presence);
  }
}

/** The "While you were away, N messages mentioned you:" header: the door's
 *  own notice, nobody's speech. */
export function catchupHeaderTags(): string[] {
  return tags(CHAT.ambient, CHAT.system, EIDO.catchup);
}

/** A replayed mention: its ORIGINAL addressing plus the catch-up marker; never a notice. */
export function catchupReplayTags(): string[] {
  return tags(CHAT.mention, EIDO.catchup);
}
