// server/request-capability.ts — one immutable capability per request (docs/decisions/TXN-CAPABILITY.md).
// capture() freezes who the connection was when the request arrived; recheck() asks at each await→commit seam whether the live
// connection, door and role still agree, and any difference refuses (nothing written). The authority gets cap.actorId, never
// the connection's actorId re-read after an await (a re-join on the same socket reassigns it).
// Seams: requestwire.ts, when the per-connection queue reaches the request; worldlog.ts request(), after warm().
import type { Client, World } from "./world.ts";
import { isOperator } from "./operators.ts";
import { entryFor, doorOfWorld } from "./access.ts";

export type ReqCap = Readonly<{
  c: Client; w: World; gen: number | null; actorId: string; account: string | null; spectator: boolean; operator: boolean;
  addr: string | null; trustedRenderer: boolean; role: string;
}>;

/** The connection's capability as it is now, frozen. Throws if it has no identity (it never joined: a server bug). */
export function capture(c: Client, w: World): ReqCap {
  if (!c.actorId) throw new Error(`request from ${c.id} with no directory id (join didn't resolve one)`);
  return Object.freeze({
    c, w, gen: c.gen ?? null, actorId: c.actorId, account: c.account ?? null, spectator: !!c.spectator, operator: isOperator(c.account),
    addr: c.addr ?? null, trustedRenderer: !!c.trustedRenderer, role: w.log.roleOf(c.actorId),
  });
}

/** null = the request may still proceed under `cap`; else the refusal's words (nothing is written). `role: false` for an
 *  operator's repair, whose right is the account's and never the world's role (the role compare would refuse an operator's
 *  second queued repair after its first changed their own role). */
export function recheck(cap: ReqCap, now = Date.now(), { role = true } = {}): string | null {
  const { c, w } = cap;
  // liveness: still in this world, not taken over, not closed (close takes it out of w.clients but leaves c.world set), the same leg
  if (!(c.world === w && !c.superseded && w.clients.has(c) && (c.gen ?? null) === cap.gen))
    return "this connection left the world, was closed or was taken over by a newer one while the request waited; nothing was written";
  // identity: the same who (a re-join over the same socket reassigns actorId; the account is the socket's, checked all the same)
  if (c.actorId !== cap.actorId || (c.account ?? null) !== cap.account || !!c.spectator !== cap.spectator)
    return "this connection is someone else now (it joined again while the request waited); nothing was written";
  // operator status (operator-repair's right, and the door's bypass); the words say which way it went (recheckFix reads them)
  if (isOperator(cap.account) !== cap.operator) return cap.operator
    ? "this account stopped being a server operator while the request waited (operator status changed); nothing was written"
    : "this account became a server operator while the request waited (operator status changed); nothing was written — send it again if you still mean it";
  // the door: the same decision the join made (access.ts entryFor), asked again with the captured who
  const door = entryFor(doorOfWorld(w), { account: cap.account, actorId: cap.actorId, addr: cap.addr, trustedRenderer: cap.trustedRenderer },
    cap.spectator ? "watch" : "embody", { now });
  if (door) return `this world's door no longer lets this connection in (${door.reason}): ${door.why}; nothing was written`;
  // the role it was admitted under: a change mid-request refuses (the asker chose under the old one)
  if (role && w.log.roleOf(cap.actorId) !== cap.role) return "your role here changed while the request waited; nothing was written — send it again if you still mean it";
  return null;
}
