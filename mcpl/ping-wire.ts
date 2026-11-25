// ping-wire — the two renderings of a ping, kept out of net-server.ts (which listens at module load) so
// test/mcpl/door-unit-test.ts can import them. Both servers consume these.
//
//  - pingLine:     the pending_pings queue line (plain-MCP hosts, server.ts)
//  - pingDelivery: the channel frame (MCPL hosts, net-server.ts deliver())

import { CHAT, EIDO, tags, senderFacet } from "./declaration.ts";

export type WirePing = {
  ts: number;
  kind: "mention" | "approach" | "depart" | "reach" | "touch";
  who: string;
  text?: string;
};

/** One pending_pings line. Every kind renders as ITSELF; depart, reach and touch carry the agent's own wording
 *  (only the agent knows who moved; see stepApproach's anchor). */
export function pingLine(p: WirePing): string {
  switch (p.kind) {
    case "mention": return `@ ${p.who}: ${p.text}`;
    case "approach": return `≈ ${p.who} walked up to you`;
    case "depart": return `≈ ${p.who} ${p.text ?? "is no longer nearby"}`;
    default: return `≈ ${p.who} ${p.text}`;   // reach / touch carry their own phrasing
  }
}

/** The channel frame for a ping, or null for kinds that reach the channel as events (a mention rides its say).
 *   - approach / reach / touch: directed at this body but not speech: `chat:addressed` + `mentioned`.
 *   - depart: AMBIENT, not `mentioned` (being left isn't being addressed), and `chat:system` so the agent's plain
 *     speech never follows it.
 *  `declares` (PROTOCOL §6a rule 3): the sender's declared word or null, carried as data; only "agent" maps to a tag
 *  (§16.2 sender facet, declaration.ts senderFacet). */
export function pingDelivery(p: WirePing, declares: string | null):
  { text: string; tags: string[]; mentioned?: true; declares?: string } | null {
  const d = typeof declares === "string" && declares ? { declares } : {};
  const from = senderFacet(declares);
  switch (p.kind) {
    case "approach":
      return { text: `* ${p.who} walked up to you`, tags: tags(CHAT.addressed, EIDO.approach, from), mentioned: true, ...d };
    case "depart":
      return { text: `* ${p.who} ${p.text ?? "is no longer nearby"}`, tags: tags(CHAT.ambient, CHAT.system, EIDO.depart, from), ...d };
    case "reach":
    case "touch":
      return { text: `* ${p.who} ${p.text}`, tags: tags(CHAT.addressed, p.kind === "touch" ? EIDO.touch : EIDO.reach, from), mentioned: true, ...d };
    default:
      return null;
  }
}
