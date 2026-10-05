#!/usr/bin/env python3
"""gov.py -- governance as a reader check, the Python twin of v4-lab/governance.js (PROTOCOL-v4 §2.4 "Governance",
§3d C2 and H4). For each `kind: "sequencer"` entry: valid or not, its rank, and what a rewind would orphan.

The spec's hazard (review 47 C2) is language-level: all([]) is True in Python and [].every() is true in JS, so a reader
written straight from "every tier-0 key" lets anyone rewind past the window in a world whose tier 0 is empty. Here an
empty tier never acts, explicitly. The choices the spec leaves open are governance.js's GOV-1..GOV-4.

Usage:  python3 gov.py LOG.jsonl     prints one JSON object: {status, window, events: [...]}
"""
import base64, hashlib, json, sys
from v4read import Reader, parse_ijson, jcs, Malformed, check_genesis, key_ok, b64u_decode

DEFAULT_WINDOW = 1000
NONE = "none"   # GOV-2: a handoff signed only by the outgoing sequencer has rank "none" (lower than every tier)
GOV_FIELDS = {"key", "owners", "fork", "sigs"}


def gov_message(world_id, seq, body):
    rest = {k: v for k, v in body.items() if k != "sigs"}
    return ("eidoverse-v4-gov:%s:%d:%s" % (world_id, seq, jcs(rest))).encode("utf-8")   # GOV-1


def verifies(key, msg, v):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    sig = b64u_decode(v)
    if sig is None or len(sig) != 64:
        return False
    try:
        Ed25519PublicKey.from_public_bytes(b64u_decode(key[8:])).verify(sig, msg)
        return True
    except Exception:
        return False


def quorum_of(tiers, quorum, t):
    if quorum is not None:
        return int(quorum[t])
    return 1 if len(tiers[t]) == 1 else len(tiers[t]) // 2 + 1


def tier_acts(tiers, quorum, t, signed):
    """An empty tier never acts, whatever its quorum computes to (3d C2)."""
    if t >= len(tiers) or len(tiers[t]) == 0:
        return False
    return sum(1 for k in tiers[t] if k in signed) >= quorum_of(tiers, quorum, t)


def every_key(tiers, t, signed):
    """Every key of tier t signed. FALSE over an empty tier (all([]) would say True)."""
    return t < len(tiers) and len(tiers[t]) > 0 and all(k in signed for k in tiers[t])


def lower(a, b):
    """rank a is strictly higher than rank b (smaller number; NONE is the lowest)."""
    if a == NONE:
        return False
    return b == NONE or a < b


def governance(data):
    lines = Reader.split_lines(data)
    entries = []
    for raw in lines:
        try:
            entries.append(parse_ijson(raw))
        except Malformed:
            entries.append(None)
    g = entries[0] if entries else None
    if not isinstance(g, dict) or g.get("kind") != "genesis" or not isinstance(g.get("body"), dict):
        return {"status": "no-world", "events": []}
    try:
        if check_genesis(g["body"]):
            return {"status": "unknown-version", "events": []}
    except Malformed:
        return {"status": "no-world", "events": []}
    world_id = "sha256:" + hashlib.sha256(jcs(g).encode()).hexdigest()
    N = int(g["body"].get("rewind_window", DEFAULT_WINDOW))
    tiers = [list(t) for t in g["body"]["owners"]]
    quorum = g["body"].get("quorum")
    sequencer = g["body"]["sequencer"]
    branches = [(1, 0)]   # (from seq, rank): the founding branch has rank 0 (3d H5)

    def rank_at(seq):
        r = 0
        for f, rk in branches:
            if f <= seq:
                r = rk
        return r

    events = []
    for seq, e in enumerate(entries):
        if seq == 0 or not isinstance(e, dict) or e.get("kind") != "sequencer":
            continue
        ev = {"seq": seq, "valid": False, "rank": None}
        events.append(ev)
        b = e.get("body")
        if not isinstance(b, dict):
            ev["why"] = "malformed"; continue
        if set(b) - GOV_FIELDS:
            ev["why"] = "unknown field"; continue
        sigs = b.get("sigs")
        if not isinstance(sigs, list) or len(sigs) == 0:
            ev["why"] = "sigs: [] is never valid"; continue
        if not all(isinstance(s, dict) and set(s) == {"key", "v"} and key_ok(s["key"]) for s in sigs) \
                or len({s["key"] for s in sigs}) != len(sigs):
            ev["why"] = "sigs must be distinct {key, v} with registrable keys"; continue
        if "key" in b and not key_ok(b["key"]):
            ev["why"] = "key isn't registrable"; continue
        if "owners" in b:
            o = b["owners"]
            flat = [k for t in o for k in t] if isinstance(o, list) and all(isinstance(t, list) for t in o) else None
            if flat is None or not all(key_ok(k) for k in flat) or len(set(flat)) != len(flat):
                ev["why"] = "owners must be tiers of distinct registrable keys"; continue
        if "fork" in b:
            f = b["fork"]
            if not (isinstance(f, dict) and set(f) == {"seq", "head"} and type(f["seq"]) is float and f["seq"].is_integer()
                    and 0 <= f["seq"] < seq and isinstance(f["head"], str) and len(f["head"]) == 64):
                ev["why"] = "fork must be {seq < this seq, head}"; continue
        if not ({"key", "owners", "fork"} & set(b)):
            ev["why"] = "changes nothing"; continue
        msg = gov_message(world_id, seq, b)
        signed = {s["key"] for s in sigs if verifies(s["key"], msg, s["v"])}
        rank = NONE
        for t in range(len(tiers) - 1, -1, -1):
            if tier_acts(tiers, quorum, t, signed):
                rank = t
        handoff = "key" in b and "owners" not in b and "fork" not in b and sequencer in signed
        if rank == NONE and not handoff:
            ev["why"] = "no tier's quorum signed it, and it isn't a handoff by the outgoing sequencer"; continue
        ev["rank"] = rank
        bad = None
        if "owners" in b:
            for t, tier in enumerate(tiers):
                for k in tier:
                    now = next((i for i, nt in enumerate(b["owners"]) if k in nt), -1)
                    if (now == -1 or now > t) and not (rank != NONE and rank <= t):
                        bad = "removing or demoting a tier-%d key needs rank %d or higher" % (t, t)
        if bad:
            ev["why"] = bad; continue
        current = rank_at(seq)
        if "fork" in b:
            frm, to = int(b["fork"]["seq"]) + 1, seq - 1
            state_count = sum(1 for i in range(frm, to + 1) if isinstance(entries[i], dict) and entries[i].get("kind") == "state")
            top = rank_at(frm)
            for f0, rk in branches:
                if frm <= f0 <= to and lower(rk, top):
                    top = rk
            ev["orphaned"] = {"from": frm, "to": to, "stateCount": state_count, "window": N}
            if not lower(rank, top):
                ev["why"] = "a rewind needs a higher rank than the branch it orphans"; continue
            if state_count >= N and not every_key(tiers, 0, signed):
                ev["why"] = "the orphaned branch holds %d state entries, not fewer than the window (%d): that needs every tier-0 key" % (state_count, N); continue
            ev["act"] = "rewind"
        elif "key" not in b:
            ev["act"] = "owners"
        elif lower(rank, current):
            ev["act"] = "reclaim"
        elif handoff:
            ev["act"] = "handoff"; ev["rank"] = NONE
        else:
            ev["why"] = "a reclaim needs a higher rank than the branch it takes"; continue
        ev["valid"] = True
        if "owners" in b:
            tiers = [list(t) for t in b["owners"]]
            if quorum is not None and len(quorum) != len(tiers):
                quorum = None
        if "key" in b:
            sequencer = b["key"]
        if ev["act"] != "owners":
            branches.append((seq, ev["rank"]))
    return {"status": "ok", "window": N, "events": events}


if __name__ == "__main__":
    print(json.dumps(governance(open(sys.argv[1], "rb").read())))
