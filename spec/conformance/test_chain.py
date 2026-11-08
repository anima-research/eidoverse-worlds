#!/usr/bin/env python3
"""Proofs 4 and 5 of PROTOCOL §6: a signed hash chain detects tampering; a redaction keeps the chain valid."""
import copy, json, os
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
import chain, reader

passed = failed = 0
def check(name, ok, got=""):
    global passed, failed
    if ok: passed += 1; print("PASS", name)
    else: failed += 1; print("FAIL", name, "->", got)

def raw(pub):
    return pub.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)

priv, other = Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()
KEY = "ed25519:" + chain.b64u(raw(priv.public_key()))

def build(every=2):
    g = {"kind": "genesis", "actor": "system", "body": {"dialect": "eidoverse-log", "v": 4, "nonce": chain.b64u(os.urandom(16)), "owners": [[KEY]], "sequencer": KEY}}  # §2.4 + §3d
    import hashlib
    wid = "sha256:" + hashlib.sha256(reader.jcs(g).encode()).hexdigest()
    st = lambda verb, body: {"world": wid, "kind": "change", "ts": 1, "actor": "system", "cause": 1, "op": verb, "body": body}
    es = [g, {"world": wid, "kind": "request", "ts": 1, "actor": "alice", "verb": "place", "body": {"args": {}}},
          st("create", {"id": "lamp-1"}),
          st("set", {"id": "lamp-1", "comp": "light", "value": {"i": 2.5}}),
          st("set", {"id": "lamp-1", "comp": "note", "value": "alice's phone is 555-0100"}),
          st("batch", {"ops": [{"op": "create", "id": "chair"}, {"op": "set", "id": "chair", "comp": "seat", "value": [1, 2]}]}),
          {"world": wid, "kind": "say", "ts": 2, "actor": "alice", "body": {"text": "hi"}}]
    return chain.seal(es, priv, every)

dump = lambda es: ("\n".join(json.dumps(e, separators=(",", ":")) for e in es) + "\n").encode()

es = build()
r = chain.verify(dump(es))
check("4a sealed log verifies", r["status"] == "ok" and r["unsigned_tail"] == 0, r)
rd = reader.Reader(); rd.read(dump(es))
check("4b salts don't change the world", rd.status == "ok" and rd.view()["lamp-1"]["light"] == {"v": {"i": 2.5}}, rd.view())

t = copy.deepcopy(es); t[3]["body"]["value"] = {"i": 9}
r = chain.verify(dump(t)); check("4c altered value in the middle is detected", r["status"] == "broken" and r["at"] == 4, r)

t = copy.deepcopy(es); t[1]["actor"] = "mallory"
r = chain.verify(dump(t)); check("4d altered actor of an act is detected", r["status"] == "broken", r)

t = copy.deepcopy(es); del t[3]
r = chain.verify(dump(t)); check("4e deleted entry is detected", r["status"] == "broken", r)

t = copy.deepcopy(es); t[3]["body"]["salt"] = chain.b64u(b"x" * 16)
r = chain.verify(dump(t)); check("4f a swapped salt is detected (salt is bound by the commitment)", r["status"] == "broken", r)

t = build(); t2 = chain.seal(copy.deepcopy(t), other, 2)   # a re-signed copy by a different key
r = chain.verify(dump(t2)); check("4g re-signing with a key other than genesis's is detected", r["status"] == "broken" and "signature" in r["detail"], r)

t = copy.deepcopy(es)
for e in t: e.pop("head", None); e.pop("sig", None)
t[3]["body"]["value"] = {"i": 9}; t = chain.seal(t, priv, 2)
r = chain.verify(dump(t)); check("4h LIMIT: the sequencer itself can rewrite and re-sign (only equivocation evidence catches it)", r["status"] == "ok", r)
h1, h2 = chain.verify(dump(es))["head"], r["head"]
check("4i two validly signed logs with the same length and different heads = equivocation evidence", h1 != h2, (h1, h2))

t = copy.deepcopy(es); t = t[:5]
r = chain.verify(dump(t)); check("4j LIMIT: truncation to an earlier chain point verifies (needs a witness of the later head)", r["status"] == "ok", r)

# --- redaction (proof 5) ---
t = copy.deepcopy(es)
chain.redact_line(t[4])
import hashlib
wid = t[1]["world"]
t.append({"world": wid, "kind": "redaction", "ts": 3, "actor": "system", "body": {"values": [{"seq": 4}]}})
t.append({"world": wid, "kind": "redaction", "ts": 3, "actor": "system", "body": {"values": [{"seq": 5, "index": 1}]}})
chain.redact_line(t[5], 1)
for e in t: e.pop("head", None) if e is t[-1] or e is t[-2] else None
body = dump(t)
check("5a the redacted value's bytes are gone from the stored log", b"555-0100" not in body and b'"seat"' in body, "")
# re-seal only the two new redaction entries' chain point: heads of old entries must be unchanged
old_heads = [e.get("head") for e in es]
new = chain.seal(copy.deepcopy(t), priv, 10_000)   # only signs the last entry
for i, e in enumerate(new[:len(es)]):
    if old_heads[i] is not None: e["head"], e["sig"] = old_heads[i], es[i]["sig"]
r = chain.verify(dump(new)); check("5b after redaction the old chain points still verify, and the new head is signed", r["status"] == "ok", r)
rd = reader.Reader(); rd.read(dump(new))
check("5c the fold shows both values as redacted", rd.view()["lamp-1"].get("note") == {"redacted": True} and rd.view()["chair"].get("seat") == {"redacted": True}, rd.view())

# --- redaction a say (doxxing) and a blob ---
t = copy.deepcopy(es)
r0 = chain.verify(dump(t))
chain.redact_line(t[6])
t.append({"world": t[1]["world"], "kind": "redaction", "ts": 3, "actor": "system", "body": {"values": [{"seq": 6}]}})
t = chain.seal(t, priv, 10_000)
for i, e in enumerate(t[:len(es)]):
    if es[i].get("head"): e["head"], e["sig"] = es[i]["head"], es[i]["sig"]
body = dump(t)
r = chain.verify(body)
check("5d a redacted say: text gone, old heads + new head verify", r["status"] == "ok" and b'"hi"' not in body, r)
rd = reader.Reader(); rd.read(body)
check("5e a say redaction is a valid redaction target, not a diagnostic", rd.status == "ok" and not any(c == "redaction-target-not-a-value" for _, c, _ in rd.diag), rd.diag)
t2 = copy.deepcopy(es); t2[6]["body"]["text"] = "forged"
check("5f an altered say is detected", chain.verify(dump(t2))["status"] == "broken", "")

# --- stripping outside the redaction rule (PROTOCOL 12: a redaction is the one rule that changes the record) ---
def strip_unnamed(make):
    t = copy.deepcopy(es); make(t)
    for e in t: e.pop("head", None); e.pop("sig", None)
    return chain.verify(dump(chain.seal(t, priv, 2)))   # re-sealed: the heads hold, so only the redaction rule can catch it
r = strip_unnamed(lambda t: chain.redact_line(t[3]))
check("4k a value stripped to its commitment with no redaction naming it is detected, though every head verifies", r["status"] == "broken" and r["at"] == 3 and "redaction" in r["detail"], r)
r = strip_unnamed(lambda t: chain.redact_line(t[6]))
check("4l a say body stripped to its commitment with no redaction naming it is detected", r["status"] == "broken" and r["at"] == 6, r)
def roles_stripped(t):
    t.append({"world": t[1]["world"], "kind": "change", "ts": 2, "actor": "system", "cause": 1, "op": "set", "body": {"id": "@world", "comp": "roles:u-bbbbbbbbbbbbbbbbbbbb", "value": {"role": "member"}}})
    chain.redact_line(t[-1])
    t.append({"world": t[1]["world"], "kind": "redaction", "ts": 3, "actor": "system", "body": {"values": [{"seq": len(t) - 1}]}})
r = strip_unnamed(roles_stripped)
check("4m a roles: value stripped, named only by a redaction the fold refuses, is detected", r["status"] == "broken" and r["at"] == len(es), r)

# --- the verifier is as strict as the spec () ---
t = copy.deepcopy(es); t[3]["body"]["salt"] = chain.b64u(b"x" * 8)
for e in t: e.pop("head", None); e.pop("sig", None)
r = chain.verify(dump(chain.seal(t, priv, 2)))
check("4n a chained log's set with a short salt (8 bytes) is refused", r["status"] == "broken" and r["at"] == 3 and "salt" in r["detail"], r)
t = copy.deepcopy(es); t[1]["body"]["salt"] = chain.b64u(b"y" * 4)
for e in t: e.pop("head", None); e.pop("sig", None)
r = chain.verify(dump(chain.seal(t, priv, 2)))
check("4o …and an act body with a short salt is refused", r["status"] == "broken" and r["at"] == 1 and "salt" in r["detail"], r)
t = copy.deepcopy(es)
for e in t: e.pop("head", None); e.pop("sig", None)
t[3]["body"]["salt"] = "short"
r = chain.verify(dump(t))
check("4p an unchained log (no chain point) is not held to the salt rule", r["status"] == "unchained", r)
t = copy.deepcopy(es); i = next(i for i, e in enumerate(t) if "sig" in e); t[i]["sig"] = t[i]["sig"][:-2] + "!" + t[i]["sig"][-2:]
r = chain.verify(dump(t))
check("4q a sig with a non-base64url character is refused as encoding, not decoded leniently", r["status"] == "broken" and r["at"] == i and "encoding" in r["detail"], r)
r = chain.verify(b"")
check("4r an empty log is unchained, not a crash", r["status"] == "unchained", r)
t = copy.deepcopy(es); t[0]["body"]["sequencer"] = "ed25519:AAAA"
r = chain.verify(dump(t))
check("4s a malformed sequencer key is broken at 0, not a crash", r["status"] == "broken" and r["at"] == 0 and "sequencer" in r["detail"], r)
t = copy.deepcopy(es); t[0]["body"]["sequencer"] = "nokey"
r = chain.verify(dump(t))
check("4t …a key without its ed25519: prefix likewise", r["status"] == "broken" and r["at"] == 0, r)

t = copy.deepcopy(es); i = next(i for i, e in enumerate(t) if "sig" in e); t[i]["sig"] = t[i]["sig"][:-1]
r = chain.verify(dump(t))
check("4u a sig whose length base64 can't pad (85 chars) is broken at its entry, not a crash", r["status"] == "broken" and r["at"] == i and "encoding" in r["detail"], r)
for body, where in ((b"5\n", "as genesis"), (dump(es[:1]) + b'"x"\n' + dump(es[1:]), "before the first chain point")):
    r = chain.verify(body)
    check("4v a line that is JSON but not an object (%s) is broken at its line, not a crash" % where, r["status"] == "broken" and "not an object" in r["detail"], r)

print("%d/%d passed" % (passed, passed + failed))
raise SystemExit(1 if failed else 0)
