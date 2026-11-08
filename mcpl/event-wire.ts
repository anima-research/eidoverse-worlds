// event-wire — the tag set each world event goes out with, extracted so it is
// TESTABLE, as ping-wire.ts is for pings.
//
// net-server.ts cannot be imported by a test (it listens at module level), so
// the event→tags mapping used to live only inside its onEvent closure, and a
// test could only check tag sets it had built itself. The door's delivery
// decisions (door open or closed, held for pull-only hosts) stay in
// net-server.ts; what each event IS lives here, and tools/event-wire-test.ts
// holds it to that.
//
// The kind facet (RFC-001 rev 3): a notice nobody sent (weather, a visible
// change to the world, someone arriving or leaving, the activity digest, the
// catch-up header) carries `chat:system` beside `chat:ambient`, so a host that
// routes speech by the latest message doesn't follow a notice into the world,
// while rules written for ambient traffic keep matching. Speech and acts
// are people doing things and stay plain `chat:ambient`.

import { CHAT, EIDO, tags, speechTags } from "./declaration.ts";

export type WireEventKind =
  | "say" | "act" | "activity" | "weather" | "world-change" | "arrive" | "leave";

/** The tags a live world event is delivered with. `declares`: the speaker's own
 *  declared word (PROTOCOL §6a rule 3); only speech and acts carry a sender
 *  facet, through speechTags. Notices carry none: the world wrote them, and the
 *  declaration rides as metadata. `mention`: the speech named this agent. */
export function eventTags(kind: WireEventKind, opts: { declares?: string | null; mention?: boolean } = {}): string[] {
  switch (kind) {
    case "say":
      return speechTags("say", opts.declares, !!opts.mention);
    case "act":
      return speechTags("act", opts.declares);
    case "activity":
      // The door's own summary of what is happening nearby, written by the
      // world, not said by anyone: a notice, and the most frequent one.
      return tags(CHAT.ambient, CHAT.system, EIDO.activityDigest);
    case "weather":
      return tags(CHAT.ambient, CHAT.system, EIDO.weather);
    case "world-change":
      return tags(CHAT.ambient, CHAT.system, EIDO.worldChange, EIDO.particles);
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

/** A replayed mention: its ORIGINAL addressing plus the catch-up marker
 *  (issue #39), never a notice — someone did say it, to this agent. */
export function catchupReplayTags(): string[] {
  return tags(CHAT.mention, EIDO.catchup);
}
