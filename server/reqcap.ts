// server/reqcap.ts — one immutable capability per request (reviewer item 2, 10-18; docs/DESIGN-txn-capability.md).
//
// A request is admitted under WHO the connection was when it arrived: its identity, account, spectator flag, operator
// status, the credential's world narrowing, the door's decision, its role here, its leg (gen). capture() freezes that once;
// recheck() asks, at each await→commit seam, whether the live connection and world still agree with it. Any difference is
// a refusal (nothing written), never a silent commit under someone else's identity or a door that has since closed. The
// authority receives cap.actorId — never actorOf(c) read again after an await (a re-join on the same socket reassigns it).
//
// Seams (the only awaits between admission and the authority's synchronous write; ctx.js says nothing in the authority
// awaits): (1) requestwire.ts, when the per-connection queue reaches the request; (2) worldlog.ts request(), after warm().
import type { Client, World } from "./world.ts";
import { isOperator } from "./operators.ts";
import { entryFor, doorOfWorld } from "./access.ts";

export type ReqCap = Readonly<{
  c: Client; w: World; gen: number | null; actorId: string; account: string | null; spectator: boolean; operator: boolean;
  nativeWorld: string | null; addr: string | null; trustedRenderer: boolean; role: string;
}>;

/** The connection's capability as it is now, frozen. Throws if it has no identity (it never joined: a server bug). */
export function capture(c: Client, w: World): ReqCap {
  if (!c.actorId) throw new Error(`request from ${c.id} with no directory id (join didn't resolve one)`);
  return Object.freeze({
    c, w, gen: c.gen ?? null, actorId: c.actorId, account: c.account ?? null, spectator: !!c.spectator, operator: isOperator(c.account),
    nativeWorld: c.auth?.nativeWorld ?? null, addr: c.addr ?? null, trustedRenderer: !!c.trustedRenderer, role: w.log.roleOf(c.actorId),
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
  if (c.actorId !== cap.actorId || (c.account ?? null) !== cap.account || !!c.spectator !== cap.spectator || (c.auth?.nativeWorld ?? null) !== cap.nativeWorld)
    return "this connection is someone else now (it joined again while the request waited); nothing was written";
  // operator status (operator-repair's right, and the door's bypass)
  if (isOperator(cap.account) !== cap.operator) return "this account's operator status changed while the request waited; nothing was written";
  // the door: the same decision the join made (access.ts entryFor), asked again with the captured who
  const door = entryFor(doorOfWorld(w), { account: cap.account, actorId: cap.actorId, addr: cap.addr, nativeWorld: cap.nativeWorld, trustedRenderer: cap.trustedRenderer },
    cap.spectator ? "watch" : "embody", { now });
  if (door) return `this world's door no longer lets this connection in (${door.reason}): ${door.why}; nothing was written`;
  // the role it was admitted under: a change mid-request refuses (the asker chose under the old one)
  if (role && w.log.roleOf(cap.actorId) !== cap.role) return "your role here changed while the request waited; nothing was written — send it again if you still mean it";
  return null;
}
