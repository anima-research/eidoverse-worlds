#!/usr/bin/env python3
"""chain.py -- PROTOCOL L3 hash chain, salted commitments and signed chain points.

  head(-1) = 32 zero bytes
  head(i)  = sha256( head(i-1) || sha256( UTF-8( JCS( skeleton(entry i) ) ) ) )
  skeleton = the entry without `head`/`sig`, where every set op's `value` + `salt` is replaced by
             `commitment` = hex sha256( UTF-8(salt) || UTF-8(JCS(value)) ), and every request/say/physics body by
             `{commitment}` = hex sha256( UTF-8(salt) || UTF-8(JCS(body without salt)) ). A redacted line already
             carries `commitment` in place of value+salt (or the body), so a redaction never changes a head.
  In a chained log (one carrying any chain point) every set value and request/say/physics body carries a `salt`
  of >= 16 random bytes, base64url (PROTOCOL "Salted commitments"): the verifier refuses one without.
  chain point = an entry carrying `head` (hex of head(i), this entry included) and `sig`
             (base64url Ed25519 over UTF-8 "eidoverse-head:<world id>:<seq>:<head hex>").
  The sequencer key is genesis body.sequencer = "ed25519:<base64url raw 32 bytes>".

Usage: python3 chain.py verify LOG.jsonl
"""
import base64, hashlib, json, os, re, sys
from reader import parse_ijson, jcs, Malformed, Reader, BODY_KINDS

ZERO = bytes(32)
SALT_MIN = 16   # bytes, once decoded (PROTOCOL "Salted commitments": >= 16 random bytes)
B64U = re.compile(r"[A-Za-z0-9_-]*")


def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def unb64u(s):
    # strict: urlsafe_b64decode discards characters outside the alphabet, so a sig with `!` in it still verified (#481)
    if not isinstance(s, str) or not B64U.fullmatch(s):
        raise Malformed("b64url")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def salt_ok(salt):
    """A salt a chained log may carry: base64url of >= SALT_MIN bytes (#480)."""
    try:
        return isinstance(salt, str) and len(unb64u(salt)) >= SALT_MIN
    except (Malformed, ValueError):
        return False


def short_salts(e):
    """The set values and request/say/physics body of a stored entry that carry no adequate salt (a redacted one carries none to check)."""
    out = []
    if e.get("kind") in BODY_KINDS:
        b = e.get("body")
        if isinstance(b, dict) and not (list(b) == ["commitment"]) and not salt_ok(b.get("salt")):
            out.append("body")
    elif e.get("kind") == "change":
        b = e.get("body", {})
        ops = b.get("ops", []) if e.get("op") == "batch" else [b] if e.get("op") == "set" else []
        for i, o in enumerate(ops):
            if isinstance(o, dict) and (e.get("op") != "batch" or o.get("op") == "set") and "value" in o and not salt_ok(o.get("salt")):
                out.append("op %d" % i)
    return out


def commitment_of(op):
    if "commitment" in op and "value" not in op:
        return op["commitment"]
    salt = op.get("salt", "")
    return hashlib.sha256(salt.encode() + jcs(op["value"]).encode()).hexdigest()


def skel_op(op):
    o = {k: v for k, v in op.items() if k not in ("value", "salt", "commitment")}
    if "value" in op or "commitment" in op:
        o["commitment"] = commitment_of(op)
    return o


def body_commitment(body):
    if "commitment" in body and len(body) == 1:
        return body["commitment"]
    b = {k: v for k, v in body.items() if k != "salt"}
    return hashlib.sha256(body.get("salt", "").encode() + jcs(b).encode()).hexdigest()


def skeleton(e):
    s = {k: v for k, v in e.items() if k not in ("head", "sig")}
    if e.get("kind") in BODY_KINDS:
        s["body"] = {"commitment": body_commitment(e["body"])}   # the whole body is purgeable
    elif e.get("kind") == "change":
        b = dict(e["body"])
        if e["op"] == "batch":
            b["ops"] = [skel_op(o) if o.get("op") == "set" else o for o in b.get("ops", [])]
        elif e["op"] == "set":
            b = skel_op(b)
        s["body"] = b
    return s


def step(head, e):
    return hashlib.sha256(head + hashlib.sha256(jcs(skeleton(e)).encode()).digest()).digest()


def sig_msg(world_id, seq, head_hex):
    return ("eidoverse-head:%s:%d:%s" % (world_id, seq, head_hex)).encode()


def verify(data):
    """Returns dict: status (unchained|ok|broken), last_signed, unsigned_tail, detail."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    lines = data.split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()
    entries = []
    for seq, raw in enumerate(lines):
        try:
            entries.append(parse_ijson(raw))
        except Malformed as m:
            return {"status": "broken", "at": seq, "detail": "malformed line in a chained log: " + m.code}
        if not isinstance(entries[-1], dict):
            return {"status": "broken", "at": seq, "detail": "malformed line in a chained log: not an object"}
    if not entries:
        return {"status": "unchained", "detail": "empty log"}
    g = entries[0]
    world_id = "sha256:" + hashlib.sha256(jcs(g).encode()).hexdigest()
    key = g.get("body", {}).get("sequencer") if isinstance(g.get("body"), dict) else None
    if not key:
        return {"status": "unchained", "detail": "genesis names no sequencer key"}
    try:
        if not isinstance(key, str) or not key.startswith("ed25519:"):
            raise ValueError("not ed25519:<base64url>")
        pub = Ed25519PublicKey.from_public_bytes(unb64u(key[len("ed25519:"):]))
    except (Malformed, ValueError):
        return {"status": "broken", "at": 0, "detail": "sequencer key malformed"}
    chained = any("head" in e or "sig" in e for e in entries)
    head, last = ZERO, None
    for seq, e in enumerate(entries):
        try:
            head = step(head, e)
        except (Malformed, ValueError, TypeError, KeyError, AttributeError):
            return {"status": "broken", "at": seq, "detail": "entry can't be hashed (malformed skeleton)"}
        if chained and short_salts(e):
            return {"status": "broken", "at": seq, "detail": "set without a >= 16-byte base64url salt (%s)" % ", ".join(short_salts(e))}
        if "head" in e or "sig" in e:
            if e.get("head") != head.hex():
                return {"status": "broken", "at": seq, "detail": "head mismatch (an earlier entry was altered)"}
            try:
                sig = unb64u(e.get("sig"))
            except (Malformed, ValueError):
                return {"status": "broken", "at": seq, "detail": "bad signature encoding (not base64url)"}
            try:
                pub.verify(sig, sig_msg(world_id, seq, head.hex()))
            except Exception:
                return {"status": "broken", "at": seq, "detail": "bad signature"}
            last = seq
    # PROTOCOL 12: a redaction is the one rule that changes the record, and a redacted line verifies by design (its skeleton
    # is unchanged). So a set value or a request/say/physics body stripped to its commitment must be a redaction's work: one that
    # no redaction the fold accepts names (none does, or only a refused one, as any aimed at a roles: value) was changed outside it
    altered = unredacted_stubs(data, entries)
    if altered:
        return {"status": "broken", "at": altered[0], "detail": "stripped to its commitment, but no redaction names it (changed outside the redaction rule)"}
    return {"status": "ok" if last is not None else "unchained", "last_signed": last,
            "unsigned_tail": len(entries) - 1 - (last if last is not None else -1), "head": head.hex(),
            "world": world_id}


def unredacted_stubs(data, entries):
    """The seqs holding a value or body stripped to its commitment that no redaction the fold accepts names, in order."""
    rd = Reader(); rd.read(data)
    if rd.status != "ok":
        return []
    out = {s for s, c, _ in rd.diag if c == "commitment-unredacted"}
    for seq, e in enumerate(entries):
        b = e.get("body")
        if e.get("kind") in BODY_KINDS and isinstance(b, dict) and list(b) == ["commitment"] and (seq, None) not in rd.redactions:
            out.add(seq)
    return sorted(out)


def seal(entries, priv, every=1):
    """Door side: add salts to set values, and head+sig to every `every`-th entry and the last (genesis is never a
    chain point). Mutates and returns entries. Genesis must already name the sequencer key."""
    world_id = "sha256:" + hashlib.sha256(jcs(entries[0]).encode()).hexdigest()
    for e in entries:
        if e.get("kind") == "change":
            ops = e["body"]["ops"] if e["op"] == "batch" else [e["body"]] if e["op"] == "set" else []
            for o in ops:
                if "value" in o and "salt" not in o and (e["op"] != "batch" or o.get("op") == "set"):
                    o["salt"] = b64u(os.urandom(16))
        elif e.get("kind") in BODY_KINDS and "salt" not in e["body"] and "commitment" not in e["body"]:
            e["body"]["salt"] = b64u(os.urandom(16))
    head = ZERO
    for seq, e in enumerate(entries):
        head = step(head, e)
        if seq > 0 and (seq % every == 0 or seq == len(entries) - 1):
            e["head"] = head.hex()
            e["sig"] = b64u(priv.sign(sig_msg(world_id, seq, head.hex())))
    return entries


def redact_line(e, op_index=None):
    """Storage side of a redaction: replace value+salt (state) or the whole body (request/say/physics) with commitment."""
    if e.get("kind") in BODY_KINDS:
        e["body"] = {"commitment": body_commitment(e["body"])}
        return e
    o = e["body"]["ops"][op_index] if op_index is not None else e["body"]
    c = commitment_of(o)
    o.pop("value", None); o.pop("salt", None); o["commitment"] = c
    return e


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "verify":
        print(json.dumps(verify(open(sys.argv[2], "rb").read())))
    else:
        print(__doc__)
