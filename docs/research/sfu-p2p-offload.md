# SFU: P2P offload — where it plugs in (future)

Notes for the deferred phase 2 of voice: relay floor first, P2P later. The SFU (`server/sfu.ts`) always works; a pair
that manages a direct connection stops paying for the relay hop. Basis has shipped exactly this
(BasisServerHandleEvents.cs, BasisServerP2PBroker.cs).

## The hook is the fanout loop

Basis checks `IsP2POffloaded(sender, client)` in its fanout (BasisServerHandleEvents.cs:995) and skips the send. Ours
would be one more `continue` beside the proximity gate in `Sfu.fanout`: the gate and the offload check answer the same
question ("does this packet need to traverse the relay?"), so they belong adjacent.

## Fast-path the common case

`HasOffloadedPairs` is a volatile int compare that short-circuits before any map lookup, because zero-offload is
overwhelmingly common (BasisServerP2PBroker.cs:44-58). At 12 people it hardly matters; at 1000 it removes a million hash
lookups a tick. The proximity gate should learn the same trick if `pos` is ever empty.

## Pairs are unordered

Basis packs (lo, hi) into a long so a pair has one identity regardless of direction. Ours must too, and this would be
the third pair key in sfu.ts after consent and inRange. If a fourth appears, extract a `PairMap<T>` rather than joining
strings: a NUL-joined key is not injective when ids may contain NUL.

## The hard part is the watchdog

A direct link that dies silently is worse than none: both ends think they are connected and neither hears anything.
Basis keeps that decision logic in BasisP2PLinkHealth.cs so it can be unit-tested headless (the same move as
relaydecision.ts). Its verdicts:

- `DemoteStale`: no inbound past staleMs, so the path is dead or one-way;
- `DemoteUnconfirmed`: reached Connected but the server never confirmed;
- `ClearFlapCounter`: healthy long enough to forget past flapping;

with a post-connect GRACE window where demotion is never allowed, and staleness checked before unconfirmed so the
reported reason is specific. Copy that structure into relaydecision.ts rather than inventing new thresholds.

## Demotion must be invisible

Falling back to the relay is the recovery path, so the relay route must still EXIST while offloaded: keep the
transceiver negotiated and starve it, exactly as consent already does (`ensureRoute`). That is why consent and routes
are separate concepts, and it makes demotion a memory write instead of an SDP round trip.

## Animation offload

The same broker with different traffic and a much lower stake: a dropped pose interpolates, a dropped voice packet is
an audible hole. If both are built, voice should be the last thing moved to a new direct link and the first moved back.
Basis routes both over one link; the asymmetry in failure cost argues we should not.
