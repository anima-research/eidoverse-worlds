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
// change to the world, someone arriving or leaving, the catch-up header)
// carries `chat:system` beside `chat:ambient`, so a host never sends the
// agent's plain speech into the world because a notice arrived there last,
// while rules written for ambient traffic keep matching. Speech, emotes and
// the activity digest are people doing things and stay plain `chat:ambient`.

import { CHAT, EIDO, tags } from "./declaration.ts";

export type WireEventKind =
  | "say" | "whisper" | "act" | "activity" | "weather" | "world-change" | "arrive" | "leave";

/** The tags a live world event is delivered with. `fromAgent`: the world
 *  reports this body as model-driven (§16.2 sender facet; there is no
 *  evidence for `chat:from-human`, so it is never claimed). `mention`: the
 *  speech named this agent. */
export function eventTags(kind: WireEventKind, opts: { fromAgent: boolean; mention?: boolean }): string[] {
  const from = opts.fromAgent ? CHAT.fromAgent : null;
  switch (kind) {
    case "say":
      return opts.mention ? tags(CHAT.mention, CHAT.addressed, from) : tags(CHAT.ambient, from);
    case "whisper":
      // A DM, not a mention: `chat:dm` ⇒ addressed + private (§16.3), emitted directly.
      return tags(CHAT.dm, CHAT.private, CHAT.addressed, EIDO.whisper, from);
    case "act":
      return tags(CHAT.ambient, EIDO.act, from);
    case "activity":
      // A digest of what people near this body are saying and doing: overheard
      // conversation, summarized, so answering it in-world is answering them.
      return tags(CHAT.ambient, EIDO.activityDigest);
    case "weather":
      return tags(CHAT.ambient, CHAT.system, EIDO.weather);
    case "world-change":
      return tags(CHAT.ambient, CHAT.system, EIDO.worldChange, EIDO.particles, from);
    case "arrive":
    case "leave":
      return tags(CHAT.ambient, CHAT.system, EIDO.presence, from);
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
