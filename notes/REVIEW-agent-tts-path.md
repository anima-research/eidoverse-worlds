# The agent TTS path — review before shipping (2026-08-16)

*R: "we're not on connectome so we probably can't test their tts procedure. But
we should try to review that in depth before we ship." Read the door's source
rather than the design docs.*

## What exists, verified in code

**`mcpl/agent.ts:165-176`** — the door forwards media-signalling frames and
nothing else. Its own words: *"The door NEVER synthesizes, encodes, or holds a
peer connection — it relays four message types and stays a text-tier
participant."*

```
out (server→sidecar): relay-cred · sfu-offer · sfu-ice · sfu-route
in  (sidecar→server): sfu-answer · sfu-ice · sfu-want-negotiate
                      (+ sfu-pos, voice-consent — agent.ts:1502)
```

Enforced at `agent.ts:1502` as a **whitelist by message TYPE**, not by field.

## Three things I checked because today's changes could have broken them

1. **The new credential survives the door.** `sfu-answer` now carries `cred`
   (six claims) and `gen`. Because the whitelist matches on `type` and forwards
   the whole frame, both ride through untouched. ✅ No door change needed —
   but note this is luck, not design: a field-level whitelist would have
   silently stripped them and every agent leg would be refused with a message
   about credentials it *did* send.

2. **The door passes the new spectator gate.** Today's `sfu-*` verbs refuse
   `c.spectator || surface !== "world"`. The door joins (`agent.ts:433`) with
   `{type:"join", world, id, avatar, agent:true, token, agentToken}` — **no
   `spectate`, no `surface`** — so it is the embodied primary and the gate
   admits it. ✅ Verified, not assumed.

3. **The door is the primary, which is what `relay-cred` requires.**
   `agent.ts:161` cites the server rule verbatim. ✅ Consistent.

## 🔴 What is NOT verifiable here, and must be said in the PR

**The sidecar that terminates this contract is not in this repository.**
`tools/voicebot/index.ts` contains no `RTCPeerConnection`, no werift, and no
`sfu-answer` handling. So the agent path as shipped is **a forwarding path to an
absent peer**: the door will relay frames correctly to something that does not
exist in this tree.

That is not a defect — topology B deliberately puts the peer in the sidecar
(`eido-agent-sidecar`, a separate repo) — but it means:

- **#104 row 5 ("agent/browser TTS publication through the same relay
  contract") is HALF proven.** The browser half is proven end-to-end by ear. The
  agent half is proven only as far as the door's whitelist.
- **Amendment 4's kill-questions are moot for us and should be said so.** They
  asked about `@livekit/rtc-node` under Bun (napi risk) and the LiveKit server
  SDK. We use neither. The equivalent risk for our stack is whether a werift
  peer in the sidecar can answer our offers — a real question, unanswered here.

## The specific thing to test when a Connectome agent is available

The door relays `sfu-offer` → sidecar → `sfu-answer`. Our server now:
1. runs the seven refusals on that answer (`server.ts`, admitSfuLeg), and
2. drops answers whose `gen` is not the leg's live generation.

A sidecar that does not echo `cred` and `gen` back will be **refused**, and the
refusal path **revokes the leg**. That is correct behaviour for a browser, and
it is the most likely way an agent leg breaks on first contact. Before shipping
the sidecar half, confirm it forwards both fields verbatim from `relay-cred`.

**This is the single highest-value thing to check with antra**, because it is
the one place our hardening could make a previously-working agent path fail.

## Amendment 5 and agent legs

`performed` now ships `rung: "authorized-claim"`. For an agent leg this matters
more than for a browser: the door mints the receipt *on the sidecar's behalf*
(`agent.ts:178-180`, `ownSays`), so the claim is two hops from the audio. The
rung name is doing real work there — it says "an authorized leg claimed this",
which is exactly and only what a door-minted receipt can support.
