#!/usr/bin/env python3
"""Governance (PROTOCOL §13) as gov.py reads it, with real Ed25519 signatures. The case that matters most is GV1: a
lower tier may never put keys into a higher tier, because with that a tier-1 key can take tier 0 over in two steps
(review 2026-10-07 H4, the reviewer's gov_escalate.py)."""
import base64, hashlib, json
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from gov import governance, gov_message
from reader import jcs

passed = failed = 0
def check(name, ok, got=""):
    global passed, failed
    if ok: passed += 1; print("PASS", name)
    else: failed += 1; print("FAIL", name, "->", json.dumps(got)[:400])

def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def mk():
    k = Ed25519PrivateKey.generate()
    return k, "ed25519:" + b64u(k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))

def world(owners, seq_key, steps, full=False, **genesis):
    """genesis with these owner tiers, then each step (body, [signers]) as a governance entry; gov.py's events (full: its whole answer)"""
    g = {"kind": "genesis", "actor": "system", "body": dict({"dialect": "eidoverse-log", "v": 4,
         "nonce": b64u(b"0123456789abcdef"), "owners": owners, "sequencer": seq_key}, **genesis)}
    wid = "sha256:" + hashlib.sha256(jcs(g).encode()).hexdigest()
    lines = [g]
    for body, signers in steps:
        seq = len(lines); msg = gov_message(wid, seq, body)
        lines.append({"world": wid, "kind": "governance", "ts": seq, "actor": "system",
                      "body": dict(body, sigs=[{"key": pk, "v": b64u(sk.sign(msg))} for sk, pk in signers])})
    r = governance(("\n".join(json.dumps(l) for l in lines) + "\n").encode())
    return r if full else r["events"]

(A, a), (B, b), (C1, c1), (C2, c2), (S, s), (N, n) = mk(), mk(), mk(), mk(), mk(), mk()

# GV1: the reviewer's escalation. B (tier 1) adds C1, C2 to tier 0; then C1+C2 remove A. The first step must fail.
ev = world([[a], [b]], s, [({"owners": [[a, c1, c2], [b]]}, [(B, b)]), ({"owners": [[c1, c2], [b]]}, [(C1, c1), (C2, c2)])])
check("GV1 a tier-1 key can't add keys to tier 0 (and so can't take tier 0 over)", not ev[0]["valid"] and not ev[1]["valid"], ev)
# GV2: nor promote itself
ev = world([[a], [b]], s, [({"owners": [[a, b], []]}, [(B, b)])])
check("GV2 a tier-1 key can't promote itself into tier 0", not ev[0]["valid"], ev)
# GV3: a tier adds to its own tier and below
ev = world([[a], [b]], s, [({"owners": [[a], [b, n]]}, [(B, b)]), ({"owners": [[a, c1], [b, n]]}, [(A, a)])])
check("GV3 tier 1 may add a tier-1 key; tier 0 may add a tier-0 key", ev[0]["valid"] and ev[1]["valid"], ev)
# GV4: tier 0 may promote a tier-1 key
ev = world([[a], [b]], s, [({"owners": [[a, b], []]}, [(A, a)])])
check("GV4 tier 0 may promote a tier-1 key into tier 0", ev[0]["valid"], ev)
# GV5: an empty tier 0 can't be filled by anyone below it (so genesis must name the founder's key: the ceremony)
ev = world([[], [b]], s, [({"owners": [[b], []]}, [(B, b)]), ({"owners": [[n], [b]]}, [(B, b)])])
check("GV5 an empty tier 0 can never be filled from below", not ev[0]["valid"] and not ev[1]["valid"], ev)
# GV6: the outgoing sequencer alone can hand the writer role on, and nothing else
ev = world([[a], [b]], s, [({"key": n}, [(S, s)]), ({"owners": [[a], [b, c1]]}, [(N, n)])])
check("GV6 a handoff by the outgoing sequencer is valid; the new sequencer can't touch owners", ev[0]["valid"] and ev[0]["act"] == "handoff" and not ev[1]["valid"], ev)
# GV7: removal still needs rank (the rule that was already there)
ev = world([[a], [b]], s, [({"owners": [[], [b]]}, [(B, b)])])
check("GV7 a tier-1 key can't remove the tier-0 key", not ev[0]["valid"], ev)
# GV9: `checkpoint` is a reserved governance field (PROTOCOL §2: a trusted checkpoint will be a governance entry carrying it;
# its shape isn't specified, so a reader refuses it by name, never as an anonymous unknown field) — 10-17 engine-scars 4
ev = world([[a], [b]], s, [({"key": n, "checkpoint": {"at": 0, "head": "00" * 32, "digest": "00" * 32}}, [(A, a)])])
check("GV9 a governance body carrying `checkpoint` is refused as reserved (until the spec names its shape)", not ev[0]["valid"] and ev[0].get("why") == "checkpoint is reserved", ev)
# GV8: a new lower tier may be added by any tier at or above it
ev = world([[a], [b]], s, [({"owners": [[a], [b], [c1]]}, [(B, b)])])
check("GV8 tier 1 may add a tier 2 below itself", ev[0]["valid"], ev)

# GV10–GV12: requiresAdd (§F F-1) is a governance decision like any other: a tier's quorum signs it, the union only grows
r = world([[a], [b]], s, [({"requiresAdd": ["x:y@1"]}, [(B, b)]), ({"requiresAdd": ["a:b@1", "z:z@1"]}, [(A, a)])], full=True, requires=["m:n@1"])
check("GV10 a requiresAdd signed by a tier is valid, and the world's requires is the sorted union", r["events"][0]["valid"] and r["events"][0]["act"] == "requires" and r["events"][1]["valid"] and r["requires"] == ["a:b@1", "m:n@1", "x:y@1", "z:z@1"], r)
r = world([[a], [b]], s, [({"requiresAdd": ["m:n@1"]}, [(A, a)]), ({"requiresAdd": ["z:z@1", "a:b@1"]}, [(A, a)]), ({"requiresAdd": []}, [(A, a)]), ({"requiresAdd": ["A:b@1"]}, [(A, a)])], full=True, requires=["m:n@1"])
check("GV11 a requiresAdd that repeats a required id, is unsorted, empty or malformed is invalid; nothing is removed", not any(e["valid"] for e in r["events"]) and r["requires"] == ["m:n@1"], r)
r = world([[a], [b]], s, [({"requiresAdd": ["x:y@1"]}, [(S, s)]), ({"key": n, "requiresAdd": ["x:y@1"]}, [(S, s)])], full=True)
check("GV12 the sequencer alone can't declare a feature (not even inside a handoff): no system actor activates law", not any(e["valid"] for e in r["events"]) and r["requires"] == [], r)
r = world([[a], [b]], s, [], full=True, rewindWindow=5)
check("GV13 the window is read from genesis rewindWindow", r["window"] == 5, r)

print("%d/%d passed" % (passed, passed + failed))
raise SystemExit(1 if failed else 0)
