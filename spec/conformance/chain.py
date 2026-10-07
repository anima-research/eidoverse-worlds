#!/usr/bin/env python3
"""chain.py -- PROTOCOL L3 hash chain, salted commitments and signed chain points.

  head(-1) = 32 zero bytes
  head(i)  = sha256( head(i-1) || sha256( UTF-8( JCS( skeleton(entry i) ) ) ) )
  skeleton = the entry without `head`/`sig`, where every set op's `value` + `salt` is replaced by
             `commit` = hex sha256( UTF-8(salt) || UTF-8(JCS(value)) ). A purged line already carries
             `commit` in place of value+salt, so purge never changes a head.
  chain point = an entry carrying `head` (hex of head(i), this entry included) and `sig`
             (base64url Ed25519 over UTF-8 "eidoverse-head:<world id>:<seq>:<head hex>").
  The sequencer key is genesis body.sequencer = "ed25519:<base64url raw 32 bytes>".

Usage: python3 chain.py verify LOG.jsonl
"""
import base64, hashlib, json, os, sys
from reader import parse_ijson, jcs, Malformed

ZERO = bytes(32)


def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def unb64u(s): return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def commit_of(op):
    if "commit" in op and "value" not in op:
        return op["commit"]
    salt = op.get("salt", "")
    return hashlib.sha256(salt.encode() + jcs(op["value"]).encode()).hexdigest()


def skel_op(op):
    o = {k: v for k, v in op.items() if k not in ("value", "salt", "commit")}
    if "value" in op or "commit" in op:
        o["commit"] = commit_of(op)
    return o


def body_commit(body):
    if "commit" in body and len(body) == 1:
        return body["commit"]
    b = {k: v for k, v in body.items() if k != "salt"}
    return hashlib.sha256(body.get("salt", "").encode() + jcs(b).encode()).hexdigest()


def skeleton(e):
    s = {k: v for k, v in e.items() if k not in ("head", "sig")}
    if e.get("kind") in ("act", "say", "sim"):
        s["body"] = {"commit": body_commit(e["body"])}   # the whole body is purgeable
    elif e.get("kind") == "change":
        b = dict(e["body"])
        if e["verb"] == "batch":
            b["ops"] = [skel_op(o) if o.get("verb") == "set" else o for o in b.get("ops", [])]
        elif e["verb"] == "set":
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
    g = entries[0]
    world_id = "sha256:" + hashlib.sha256(jcs(g).encode()).hexdigest()
    key = g.get("body", {}).get("sequencer")
    if not key:
        return {"status": "unchained", "detail": "genesis names no sequencer key"}
    pub = Ed25519PublicKey.from_public_bytes(unb64u(key.split(":", 1)[1]))
    head, last = ZERO, None
    for seq, e in enumerate(entries):
        head = step(head, e)
        if "head" in e or "sig" in e:
            if e.get("head") != head.hex():
                return {"status": "broken", "at": seq, "detail": "head mismatch (an earlier entry was altered)"}
            try:
                pub.verify(unb64u(e["sig"]), sig_msg(world_id, seq, head.hex()))
            except Exception:
                return {"status": "broken", "at": seq, "detail": "bad signature"}
            last = seq
    return {"status": "ok" if last is not None else "unchained", "last_signed": last,
            "unsigned_tail": len(entries) - 1 - (last if last is not None else -1), "head": head.hex(),
            "world": world_id}


def seal(entries, priv, every=1):
    """Door side: add salts to set values, and head+sig to every `every`-th entry and the last.
    Mutates and returns entries. Genesis must already name the sequencer key."""
    world_id = "sha256:" + hashlib.sha256(jcs(entries[0]).encode()).hexdigest()
    for e in entries:
        if e.get("kind") == "change":
            ops = e["body"]["ops"] if e["verb"] == "batch" else [e["body"]] if e["verb"] == "set" else []
            for o in ops:
                if "value" in o and "salt" not in o and (e["verb"] != "batch" or o.get("verb") == "set"):
                    o["salt"] = b64u(os.urandom(16))
        elif e.get("kind") in ("act", "say", "sim") and "salt" not in e["body"] and "commit" not in e["body"]:
            e["body"]["salt"] = b64u(os.urandom(16))
    head = ZERO
    for seq, e in enumerate(entries):
        head = step(head, e)
        if seq > 0 and (seq % every == 0 or seq == len(entries) - 1):
            e["head"] = head.hex()
            e["sig"] = b64u(priv.sign(sig_msg(world_id, seq, head.hex())))
    return entries


def purge_line(e, op_index=None):
    """Storage side of purge: replace value+salt (state) or the whole body (act/say/sim) with commit."""
    if e.get("kind") in ("act", "say", "sim"):
        e["body"] = {"commit": body_commit(e["body"])}
        return e
    o = e["body"]["ops"][op_index] if op_index is not None else e["body"]
    c = commit_of(o)
    o.pop("value", None); o.pop("salt", None); o["commit"] = c
    return e


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "verify":
        print(json.dumps(verify(open(sys.argv[2], "rb").read())))
    else:
        print(__doc__)
