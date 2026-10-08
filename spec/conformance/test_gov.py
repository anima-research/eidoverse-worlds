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

def world(owners, seq_key, steps):
    """genesis with these owner tiers, then each step (body, [signers]) as a sequencer entry; gov.py's events"""
    g = {"kind": "genesis", "actor": "system", "verb": "genesis", "body": {"dialect": "eidoverse-log", "v": 4, "minor": 0,
         "nonce": b64u(b"0123456789abcdef"), "owners": owners, "sequencer": seq_key}}
    wid = "sha256:" + hashlib.sha256(jcs(g).encode()).hexdigest()
    lines = [g]
    for body, signers in steps:
        seq = len(lines); msg = gov_message(wid, seq, body)
        lines.append({"world": wid, "kind": "sequencer", "ts": seq, "actor": "system", "verb": "sequencer",
                      "body": dict(body, sigs=[{"key": pk, "v": b64u(sk.sign(msg))} for sk, pk in signers])})
    return governance(("\n".join(json.dumps(l) for l in lines) + "\n").encode())["events"]

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
# GV8: a new lower tier may be added by any tier at or above it
ev = world([[a], [b]], s, [({"owners": [[a], [b], [c1]]}, [(B, b)])])
check("GV8 tier 1 may add a tier 2 below itself", ev[0]["valid"], ev)

print("%d/%d passed" % (passed, passed + failed))
raise SystemExit(1 if failed else 0)
