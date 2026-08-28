// ping-wire — the two renderings of a ping, extracted so they are TESTABLE.
//
// net-server.ts cannot be imported by a test (it listens at module level), so
// the ping→channel mapping used to exist only as source assertions inside its
// onPing closure — declaration.ts promised "approach is addressed, depart is
// ambient" and nothing executable held it to that. Both servers now consume
// these two pure functions, and tools/approach-wire-test.ts is the receipt.
//
//  - pingLine:     the pending_pings queue line (plain-MCP hosts, server.ts)
//  - pingDelivery: the channel frame (MCPL hosts, net-server.ts deliver())

import { CHAT, EIDO, tags } from "./declaration.ts";

export type WirePing = {
  ts: number;
  kind: "mention" | "approach" | "depart" | "whisper" | "reach" | "touch";
  who: string;
  text?: string;
};

/** One pending_pings line. Every kind renders as ITSELF. This used to be a
 *  binary — mention, or else "walked up to you" — which quietly mislabelled
 *  whispers, reaches and touches as approaches, discarding the wording each
 *  of them had already built for itself (`touches your head_top (left
 *  hand)`). Depart carries its own wording too, because the agent is the only
 *  party that knows who moved (see stepApproach's anchor). */
export function pingLine(p: WirePing): string {
  switch (p.kind) {
    case "mention": return `@ ${p.who}: ${p.text}`;
    case "whisper": return `@ ${p.who} whispers: ${p.text}`;
    case "approach": return `≈ ${p.who} walked up to you`;
    case "depart": return `≈ ${p.who} ${p.text ?? "is no longer nearby"}`;
    default: return `≈ ${p.who} ${p.text}`;   // reach / touch carry their own phrasing
  }
}

/** The channel frame for a ping, or null for the kinds that reach the channel
 *  through the EVENT path instead (a mention rides its say, a whisper its own
 *  delivery) — pushing them from here too would say everything twice.
 *
 *  The two product decisions live here, executably:
 *   - approach: directed at this body, but nothing was said, so it is not chat
 *     and not a mention. `chat:addressed` is the honest umbrella (+ the shim's
 *     `mentioned`); the specific event lives in this world's namespace.
 *   - depart: the closing bracket. AMBIENT and NOT `mentioned` — being left is
 *     not being addressed, and this pair exists to spend fewer interruptions,
 *     not more. The text is the agent's own (who-moved evidence), rendered
 *     verbatim.
 *   - reach / touch: a hand aimed at (or resting on) this body — directed like
 *     an approach, worded by the agent. */
export function pingDelivery(p: WirePing, fromAgent: boolean):
  { text: string; tags: string[]; mentioned?: true } | null {
  const from = fromAgent ? CHAT.fromAgent : null;
  switch (p.kind) {
    case "approach":
      return { text: `* ${p.who} walked up to you`, tags: tags(CHAT.addressed, EIDO.approach, from), mentioned: true };
    case "depart":
      return { text: `* ${p.who} ${p.text ?? "is no longer nearby"}`, tags: tags(CHAT.ambient, EIDO.depart, from) };
    case "reach":
    case "touch":
      return { text: `* ${p.who} ${p.text}`, tags: tags(CHAT.addressed, p.kind === "touch" ? EIDO.touch : EIDO.reach, from), mentioned: true };
    default:
      return null;
  }
}
