#!/usr/bin/env python3
"""The six-entry story of docs/DESIGN-log-vocabulary.md §3 as one chained, signed fixture: logs/25-story.jsonl (F1 + F2 + F6 + F8 + F9).
Keys are seeded (the genesis sequencer's private key must be held to sign the chain and the handoff), so the world id is this
fixture's own, not the design doc's example id. Writes the log, then checks it with reader.py, chain.py and gov.py."""
import copy, hashlib, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
import chain, gov, reader as R

HERE = os.path.dirname(os.path.abspath(__file__)); LOG = os.path.join(HERE, "logs", "25-story.jsonl")
passed = failed = 0
def check(name, ok, got=""):
    global passed, failed
    if ok: passed += 1; print("PASS", name)
    else: failed += 1; print("FAIL", name, "->", json.dumps(got, default=str)[:400])

def key(seed):
    k = Ed25519PrivateKey.from_private_bytes(hashlib.sha256(seed.encode()).digest())
    return k, "ed25519:" + chain.b64u(k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))

OWNER = "ed25519:BP7aKo17f474DD1aBSLG0a3Pb29Qs3yqQ6Ve0wSRVD0"   # test_reader's K_OWNER (a tier-0 owner; never signs here)
SEQ, SEQ_PUB = key("eidoverse story fixture: the outgoing sequencer")
NEW, NEW_PUB = key("eidoverse story fixture: the incoming sequencer")

G = {"kind": "genesis", "actor": "system", "body": {"dialect": "eidoverse-log", "v": 4, "nonce": "XWVu1u7BpaZTDFSETYiphg", "owners": [[OWNER]], "sequencer": SEQ_PUB}}
W = "sha256:" + hashlib.sha256(R.jcs(G).encode()).hexdigest()
L = [G,
     {"world": W, "kind": "request", "ts": 1001, "actor": "bob", "verb": "delete", "body": {"argNames": ["id"], "refused": {"code": "locked"}, "salt": "UWGy2eg11rNn2Sl6urvUTg"}},
     {"world": W, "kind": "request", "ts": 1002, "actor": "alice", "verb": "delete", "body": {"args": {"id": "shelf"}, "salt": "UUPZ_XwQSbZtpmdmt87bSQ"}},
     {"world": W, "kind": "change", "ts": 1002, "actor": "alice", "cause": 2, "op": "batch", "body": {"ops": [{"op": "delete", "id": "shelf"}, {"op": "set", "id": "vase", "comp": "transform", "value": {"pos": [0, 0.9, 0]}, "salt": "5hGJikDRuwCGCS7slx6mug"}], "cascade": [1]}},
     {"world": W, "kind": "physics", "ts": 1002, "actor": "alice", "cause": 2, "verb": "launch", "body": {"id": "vase", "p": [0, 0.9, 0], "yaw": 0, "q": [0, 0, 0, 1], "v": [0, 0, 0], "handled": ["alice"], "salt": "Gz4fypccq-7GOARwIgA8Vw"}},
     {"world": W, "kind": "redaction", "ts": 1003, "actor": "system", "body": {"values": [{"seq": 2}]}}]
gbody = {"key": NEW_PUB}
L.append({"world": W, "kind": "governance", "ts": 1004, "actor": "system", "body": dict(gbody, sigs=[{"key": SEQ_PUB, "v": chain.b64u(SEQ.sign(gov.gov_message(W, 6, gbody)))}])})

# the chain before the redaction's rewrite, then line 2 stripped to its commitment: same skeleton, same head (F9)
before = chain.seal(copy.deepcopy(L), SEQ, 1)
after = copy.deepcopy(L); chain.redact_line(after[2]); after = chain.seal(after, SEQ, 1)
check("F9 the head at the redacted seq is identical before and after the line is rewritten to its commitment", before[2]["head"] == after[2]["head"] and list(after[2]["body"]) == ["commitment"], (before[2].get("head"), after[2].get("head")))
# the fixture carries the chain of the stored (rewritten) log, as a server's file does
for b, a in zip(before, after):
    if "head" in b: a["head"], a["sig"] = b["head"], b["sig"]
data = ("\n".join(json.dumps(e, separators=(",", ":")) for e in after) + "\n").encode()
with open(LOG, "wb") as f: f.write(data)

rd = R.Reader(); rd.read(data)
check("story reads ok (as the design doc wrote it: the shelf and vase were never created, so lines 3 is two no-ops); the request is redacted", rd.status == "ok" and rd.view() == {"@world": {}} and (5, "redaction") in [(s, c) for s, c, _ in rd.diag], (rd.status, rd.diag))
ch = chain.verify(data)
check("F9 every chain point verifies on the stored log (the redaction changed no head)", ch["status"] == "ok" and ch["last_signed"] == 6, ch)
ev = gov.governance(data)["events"]
check("F6 the handoff is signed by the genesis sequencer and names a different key; gov.py reads it as a valid handoff", len(ev) == 1 and ev[0]["valid"] and ev[0]["act"] == "handoff" and NEW_PUB != SEQ_PUB and after[6]["body"]["key"] == NEW_PUB, ev)
bad = copy.deepcopy(after); bad[6]["body"]["sigs"] = [{"key": NEW_PUB, "v": chain.b64u(NEW.sign(gov.gov_message(W, 6, gbody)))}]
ev2 = gov.governance(("\n".join(json.dumps(e, separators=(",", ":")) for e in bad) + "\n").encode())["events"]
check("F6 mutation: the handoff signed by the NEW key alone is not a handoff by the outgoing sequencer", not ev2[0]["valid"] and "outgoing sequencer" in ev2[0]["why"], ev2)
check("F2 the refused request carries the argument's name and never bob's value", after[1]["body"]["argNames"] == ["id"] and "args" not in after[1]["body"] and "lamp" not in json.dumps(after[1]), after[1])

print("%d/%d passed" % (passed, passed + failed))
raise SystemExit(1 if failed else 0)
