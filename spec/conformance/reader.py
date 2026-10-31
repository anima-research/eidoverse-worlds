#!/usr/bin/env python3
"""reader.py -- an outside reader for the Eidoverse world log, the protocol.

Written from PROTOCOL.md alone. Standard library only.

Usage:  python3 reader.py LOG.jsonl [--json] [--world]

Every place the spec is silent, the choice made here is tagged GUESS-nn; the
numbers match the ambiguity list in 27-python-reader-from-spec.md.

Output:
  status   ok | unknown-version | no-world
  digest   sha256 hex of JCS(world-view)   (see DIGEST below)
  diagnostics, one per line: seq  code  detail

DIGEST (this reader's definition):
  world-view = { "<entity id>": { "<component name>": CELL, ... }, ... }
    over every LIVE entity (including live entities with no components, and
    the implicit @world), where CELL is
      {"v": <the I-JSON value>}    for a present component
      {"purged": true}             for a component whose current value is
                                   absent(purged)
  digest = lowercase hex sha256 of the UTF-8 bytes of RFC 8785 (JCS)
           serialization of world-view. Keys sort by UTF-16 code units.
  No version, world id or seq is mixed in (GUESS-20).
"""
import hashlib
import json
import math
import re
import sys
from decimal import Decimal

DIALECT = "eidoverse-log"      # spec 2.4: genesis says {dialect: "eidoverse-log", v: 4} (upstream's shape)
FOLD_VERSIONS = {4}            # GUESS-03: v is the integer 4
KNOWN_MINORS = {0}             # §3d H6: a reader that doesn't know the minor refuses the world
MAX_LINE_BYTES = 1 << 20       # GUESS-12: spec says "size caps", gives none
MAX_DEPTH = 64                 # GUESS-12
KINDS = {"genesis", "change", "act", "sim", "say", "purge", "sequencer"}
ENVELOPE = {"world", "kind", "ts", "actor", "for", "grant", "by", "cause",
            "verb", "body", "head", "sig"}   # head/sig: chain points (spec 2.4, chain.py)
OPS = {"create", "set", "delete", "batch"}

# ---- names and ids (spec 2.3) ----------------------------------------------
# GUESS-08: <identity> grammar is unspecified; use the opaque-id alphabet.
IDENT = r"[a-z0-9-]{1,64}"
ENTITY_RE = re.compile(r"\A(?:[a-z0-9-]{1,64}|@world)\Z")   # body:<id> is a reference, never an entity (2.3)
# GUESS-09: <domain> grammar unspecified; lowercase DNS-ish labels.
# GUESS-10: @<n> is a positive decimal without leading zeros.
# GUESS-11: :<key> uses the <identity> grammar.
COMP_RE = re.compile(
    r"\A(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*/)?"
    r"[a-z][a-z0-9-]*"
    r"(?:@[1-9][0-9]{0,8})?"
    r"(?::" + IDENT + r")?\Z")
# Python's re: \Z is true end-of-string (no trailing-newline loophole like $).


class Malformed(Exception):
    def __init__(self, code, detail=""):
        super().__init__(code)
        self.code, self.detail = code, detail


# ---- strict I-JSON parse ---------------------------------------------------
def _reject_const(name):
    raise Malformed("ijson-nonfinite", name)


def _num(text, val):
    if isinstance(val, float):
        if math.isinf(val) or math.isnan(val):
            raise Malformed("ijson-nonfinite", text)
        if val == 0.0 and math.copysign(1.0, val) < 0:
            # GUESS-05: also catches -1e-400, which underflows to -0
            raise Malformed("ijson-negzero", text)
    return val


def _parse_float(s):
    return _num(s, float(s))


def _parse_int(s):
    if s.startswith("-") and int(s) == 0:
        raise Malformed("ijson-negzero", s)
    # PROTOCOL §1 L1: an integer literal of magnitude above 2^53 is malformed (not rounded)
    n = int(s)
    try:
        f = float(n)
    except OverflowError:
        raise Malformed("ijson-nonfinite", s[:40])
    if int(f) != n:   # must be exactly representable as binary64 (JCS writes 1e20 as an integer literal)
        raise Malformed("ijson-bigint", s[:40])
    return _num(s, f)


def _pairs(pairs):
    d = {}
    for k, v in pairs:
        if k in d:
            raise Malformed("ijson-dupkey", repr(k)[:60])
        d[k] = v
    return d


def _check_str(s):
    for ch in s:
        o = ord(ch)
        if 0xD800 <= o <= 0xDFFF:
            raise Malformed("ijson-surrogate", hex(o))
        if (0xFDD0 <= o <= 0xFDEF) or (o & 0xFFFE) == 0xFFFE:
            raise Malformed("ijson-noncharacter", hex(o))


def _walk(v, depth):
    if depth > MAX_DEPTH:
        raise Malformed("cap-depth", str(MAX_DEPTH))
    if isinstance(v, str):
        _check_str(v)
    elif isinstance(v, dict):
        for k, x in v.items():
            _check_str(k)
            _walk(x, depth + 1)
    elif isinstance(v, list):
        for x in v:
            _walk(x, depth + 1)


def parse_ijson(raw):
    if len(raw) > MAX_LINE_BYTES:
        raise Malformed("cap-size", str(len(raw)))
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as e:
        raise Malformed("ijson-utf8", str(e)[:60])
    if text.startswith("﻿"):
        raise Malformed("ijson-bom")
    try:
        v = json.loads(text, object_pairs_hook=_pairs, parse_float=_parse_float,
                       parse_int=_parse_int, parse_constant=_reject_const)
    except Malformed:
        raise
    except RecursionError:
        raise Malformed("cap-depth", "parser recursion")
    except ValueError as e:
        raise Malformed("json-syntax", str(e)[:60])
    _walk(v, 0)
    return v


# ---- JCS (RFC 8785) --------------------------------------------------------
def jcs_number(x):
    if x == 0:
        return "0"
    if x < 0:
        return "-" + jcs_number(-x)
    t = Decimal(repr(x)).normalize().as_tuple()
    digits = "".join(map(str, t.digits))
    k = len(digits)
    n = k + t.exponent
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + digits
    e = n - 1
    sign = "+" if e >= 0 else "-"
    mant = digits if k == 1 else digits[0] + "." + digits[1:]
    return mant + "e" + sign + str(abs(e))


_ESC = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n",
        "\r": "\\r", "\t": "\\t"}


def jcs_string(s):
    out = ['"']
    for ch in s:
        if ch in _ESC:
            out.append(_ESC[ch])
        elif ord(ch) < 0x20:
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _u16(s):
    return s.encode("utf-16-be")


def jcs(v):
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return jcs_number(float(v))
    if isinstance(v, str):
        return jcs_string(v)
    if isinstance(v, list):
        return "[" + ",".join(jcs(x) for x in v) + "]"
    if isinstance(v, dict):
        ks = sorted(v.keys(), key=_u16)
        return "{" + ",".join(jcs_string(k) + ":" + jcs(v[k]) for k in ks) + "}"
    raise TypeError(type(v))


# ---- genesis (spec 2.4, 3d C1/H5/H6) -----------------------------------------
GENESIS_FIELDS = {"dialect", "v", "minor", "nonce", "rewind_window", "parent", "owners", "quorum", "sequencer"}
_B64U = re.compile(r"\A[A-Za-z0-9_-]*\Z")
_HEX64 = re.compile(r"\A[0-9a-f]{64}\Z")
# the 8 small-order points' y (sign bit cleared): conformance/ed25519/test_vectors.py, spec 2.4 "Keys"
_SMALL_Y = {bytes.fromhex(h) for h in [
    "0100000000000000000000000000000000000000000000000000000000000000",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"]}
_P = 2 ** 255 - 19


def b64u_decode(s):
    """Canonical unpadded base64url, or None. Canonical = re-encoding gives the same text (no spare bits set),
    so one byte string has exactly one spelling (GUESS-26: the spec says base64url, not which spelling)."""
    import base64
    if not isinstance(s, str) or not _B64U.match(s) or len(s) % 4 == 1:
        return None
    raw = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    return raw if base64.urlsafe_b64encode(raw).rstrip(b"=").decode() == s else None


def key_ok(k):
    """spec 2.4 Keys, registration: ed25519:<base64url 32 bytes>, not small-order in any sign-bit encoding, y < p."""
    if not isinstance(k, str) or not k.startswith("ed25519:"):
        return False
    raw = b64u_decode(k[8:])
    if raw is None or len(raw) != 32:
        return False
    y = raw[:31] + bytes([raw[31] & 0x7F])
    return y not in _SMALL_Y and int.from_bytes(y, "little") < _P


def _int(v, lo=0):
    return type(v) is float and v.is_integer() and v >= lo


def check_genesis(b):
    """Returns None if the genesis body is well formed, "unknown-minor" if this reader doesn't know its minor, else
    raises Malformed. The minor is checked before the shape: a later minor may add fields (L1)."""
    if "minor" not in b or not _int(b["minor"]):
        raise Malformed("genesis-minor", repr(b.get("minor"))[:40])
    if int(b["minor"]) not in KNOWN_MINORS:
        return "unknown-minor"
    extra = set(b) - GENESIS_FIELDS
    if extra:
        raise Malformed("genesis-field", ",".join(sorted(extra)))   # GUESS-27: a known minor's fields are exact
    n = b64u_decode(b.get("nonce"))
    if n is None or len(n) < 16:
        raise Malformed("genesis-nonce", repr(b.get("nonce"))[:40])
    tiers = b.get("owners")
    if not isinstance(tiers, list) or not all(isinstance(t, list) for t in tiers):
        raise Malformed("genesis-owners", "owners is a list of tiers, each a list of keys")
    seen = set()
    for t in tiers:
        for k in t:
            if not key_ok(k):
                raise Malformed("genesis-key", repr(k)[:60])
            if k in seen:
                raise Malformed("genesis-owners", "a key in two places: " + k[:60])   # GUESS-28
            seen.add(k)
    if "sequencer" not in b:
        raise Malformed("genesis-sequencer", "missing")
    if not key_ok(b["sequencer"]):
        raise Malformed("genesis-key", repr(b["sequencer"])[:60])
    if "quorum" in b:
        q = b["quorum"]
        if not isinstance(q, list) or len(q) != len(tiers) or not all(_int(x, 1) for x in q):
            raise Malformed("genesis-quorum", repr(q)[:60])
    if "rewind_window" in b and not _int(b["rewind_window"]):
        raise Malformed("genesis-window", repr(b["rewind_window"])[:40])
    if "parent" in b:
        p = b["parent"]
        if not (isinstance(p, dict) and set(p) == {"world", "seq", "head"} and isinstance(p["world"], str)
                and p["world"].startswith("sha256:") and _HEX64.match(p["world"][7:]) and _int(p["seq"])
                and isinstance(p["head"], str) and _HEX64.match(p["head"])):
            raise Malformed("genesis-parent", repr(p)[:60])
    return None


# ---- the fold --------------------------------------------------------------
PURGED = object()   # absent(purged): a defined value, distinct from "deleted"


class Reader:
    def __init__(self):
        self.diag = []          # (seq, code, detail)
        self.world = None       # dict: id -> dict(comp -> value | PURGED)
        self.status = None
        self.world_id = None

    def d(self, seq, code, detail=""):
        self.diag.append((seq, code, detail))

    # -- line splitting: GUESS-01 --
    @staticmethod
    def split_lines(data):
        # Every LF-terminated line is one entry, one seq. A blank line is still
        # an entry (malformed). A final unterminated line counts; a final empty
        # string after the last LF does not. CR before LF is NOT stripped (it is
        # legal JSON whitespace, so json accepts it).
        lines = data.split(b"\n")
        if lines and lines[-1] == b"":
            lines.pop()
        return lines

    def read(self, data):
        lines = self.split_lines(data)
        entries = []
        for seq, raw in enumerate(lines):
            try:
                e = parse_ijson(raw)
                self.check_envelope(seq, e)
                entries.append(e)
            except Malformed as m:
                self.d(seq, "malformed:" + m.code, m.detail)
                entries.append(None)

        # -- genesis and version (L1 Versions) --
        if not entries or entries[0] is None:
            self.status = "no-world"
            self.d(0, "no-genesis", "entry 0 missing or malformed")  # GUESS-02
            return
        g = entries[0]
        if g.get("kind") != "genesis":
            self.status = "no-world"
            self.d(0, "no-genesis", "entry 0 kind=%r" % g.get("kind"))
            return
        body = g["body"] if isinstance(g.get("body"), dict) else {}
        ver = body.get("v")
        # GUESS-03: the number lives at body.v beside body.dialect; both must match exactly.
        if body.get("dialect") != DIALECT or type(ver) is not float or ver not in FOLD_VERSIONS:
            self.status = "unknown-version"
            self.d(0, "unknown-version", repr(ver))
            return
        try:
            if check_genesis(g["body"]) == "unknown-minor":
                self.status = "unknown-version"
                self.d(0, "unknown-minor", repr(g["body"]["minor"]))
                return
        except Malformed as m:
            self.status = "no-world"
            self.d(0, "malformed:" + m.code, m.detail)
            return
        # GUESS-21: world id = sha256 of JCS(genesis entry). Reported, and
        # every later entry's `world` must equal it.
        self.world_id = "sha256:" + hashlib.sha256(jcs(g).encode()).hexdigest()

        for seq, e in enumerate(entries):
            if e is None or seq == 0:
                continue
            if e.get("kind") == "genesis":
                self.d(seq, "malformed:genesis-not-first")
                entries[seq] = None
                continue
            w = e.get("world")
            if w != self.world_id:
                # GUESS-21: soft: diagnose, do not reject (no hashing rule given)
                self.d(seq, "world-mismatch", str(w)[:80])

        # -- ts: integer ms, required after genesis, never decreasing (2.1) --
        last_ts = None
        for seq, e in enumerate(entries):
            if e is None or seq == 0:
                continue
            t = e.get("ts")
            if not (type(t) is float and t.is_integer() and t >= 0):
                self.d(seq, "malformed:ts", repr(t)); entries[seq] = None; continue
            if last_ts is not None and t < last_ts:
                self.d(seq, "malformed:ts-decreasing", "%d < %d" % (t, last_ts)); entries[seq] = None; continue
            last_ts = t

        # -- purge first (L1 Purge: "applied before anything else") --
        purged = self.collect_purges(entries)
        self.unnamed_stubs(entries, purged)
        self.purges, self.entries = purged, entries   # for chain.verify: which stubs a purge the fold accepts names

        # -- fold change entries in seq order --
        self.world = {"@world": {}}       # GUESS-07: @world live from genesis
        for seq, e in enumerate(entries):
            if e is None or e.get("kind") != "change":
                continue
            try:
                ops = self.shape_ops(seq, e, purged)
            except Malformed as m:      # whole entry shapes nothing (GUESS-13)
                self.d(seq, "malformed:" + m.code, m.detail)
                continue
            for i, op in enumerate(ops):
                self.apply(seq, i, op)
        self.status = "ok"

    # -- envelope (2.1) --
    def check_envelope(self, seq, e):
        if not isinstance(e, dict):
            raise Malformed("not-object")
        if "seq" in e:
            raise Malformed("seq-field")   # L1: position is the seq; no field
        extra = set(e) - ENVELOPE
        if extra:
            raise Malformed("unknown-field", ",".join(sorted(extra)))  # GUESS-14
        kind = e.get("kind")
        if kind not in KINDS:
            raise Malformed("kind", repr(kind))
        for f in ("kind", "actor", "verb"):
            if not isinstance(e.get(f), str):
                raise Malformed("envelope", f + " missing or not a string")
        if kind != "genesis" and not isinstance(e.get("world"), str):
            raise Malformed("envelope", "world")  # GUESS-21: genesis may omit
        if not isinstance(e.get("body"), dict):
            raise Malformed("envelope", "body not an object")   # GUESS-15
        if "for" in e:
            # L4 / 5: "until identities have keys, for is not written at all"
            raise Malformed("for-before-keys")   # GUESS-16
        if kind == "change":
            c = e.get("cause")
            # L3: every change entry has a cause; GUESS-17: integer, earlier seq
            if not (type(c) is float and c.is_integer() and 0 <= c < seq):
                raise Malformed("cause", repr(c))
        elif "cause" in e:
            c = e["cause"]
            if not (type(c) is float and c.is_integer() and 0 <= c < seq):
                raise Malformed("cause", repr(c))

    # -- purge --
    def collect_purges(self, entries):
        """Returns {(seq, op_index): purge_seq}. GUESS-18 for the body shape:
        body = {"values": [{"seq": N}, {"seq": N, "op": k}, ...]}
        `op` indexes into a batch; absent means the entry's own single op."""
        purged = {}
        for pseq, e in enumerate(entries):
            if e is None or e.get("kind") != "purge":
                continue
            vals = e["body"].get("values")
            if not isinstance(vals, list):
                self.d(pseq, "purge-ignored", "body.values not a list")
                continue
            for t in vals:
                if not isinstance(t, dict) or set(t) - {"seq", "op"}:
                    self.d(pseq, "purge-target-bad", jcs(t)[:60])
                    continue
                s, k = t.get("seq"), t.get("op", None)
                if not (type(s) is float and s.is_integer()) or (
                        k is not None and not (type(k) is float and k.is_integer() and k >= 0)):
                    self.d(pseq, "purge-target-bad", jcs(t)[:60])
                    continue
                s = int(s)
                k = None if k is None else int(k)
                if s >= pseq or s <= 0:          # GUESS-19: only earlier entries
                    self.d(pseq, "purge-target-range", str(s))
                    continue
                tgt = entries[s]
                if tgt is not None and tgt.get("kind") == "purge":
                    self.d(pseq, "purge-of-purge-refused", str(s))  # L1
                    continue
                if self.governance_target(tgt, k):   # 3d M11: purge never targets roles: (reversed by acts)
                    self.d(pseq, "purge-target-governance", "seq %d%s" % (s, "" if k is None else " op %d" % k))
                    continue
                purged[(s, k)] = pseq
                self.d(pseq, "purge", "seq %d%s" % (s, "" if k is None else " op %d" % k))
        return purged

    def unnamed_stubs(self, entries, purged):
        """PROTOCOL 12: a purge is the one rule that changes the record. A set whose value is stripped to its
        commit (`commit`, no `value`) is a purge's work; one that no purge the fold accepts names (none does, or
        only a refused one, as any aimed at a roles: value) was changed outside that rule. It folds as
        absent(purged), unknown as every purged value is (PROTOCOL 1), never as the value before it, and is
        diagnosed `commit-unpurged`. The line still shapes, so the code has no `malformed:` prefix."""
        for seq, e in enumerate(entries):
            if e is None or e.get("kind") != "change":
                continue
            try:
                self.shape_ops(seq, e, {})      # an entry that shapes nothing is diagnosed by the fold, not here
            except Malformed:
                continue
            batch = e["verb"] == "batch"
            ops = e["body"]["ops"] if batch else [e["body"]] if e["verb"] == "set" else []
            for i, op in enumerate(ops):
                if (batch and op.get("verb") != "set") or "value" in op or "commit" not in op:
                    continue
                k = (seq, i if batch else None)
                if k not in purged:
                    purged[k] = 0
                    self.d(seq, "commit-unpurged", "%s.%s" % (op.get("id"), op.get("comp")))

    @staticmethod
    def governance_target(e, k):
        if e is None or e.get("kind") != "change" or not isinstance(e.get("body"), dict):
            return False
        b = e["body"]
        if e.get("verb") == "batch":
            ops = b.get("ops")
            o = ops[k] if isinstance(ops, list) and k is not None and 0 <= k < len(ops) else None
        else:
            o = dict(b, verb=e.get("verb")) if k is None else None
        return isinstance(o, dict) and o.get("verb") == "set" and isinstance(o.get("comp"), str) and o["comp"].startswith("roles:")

    # -- turning a change entry into a flat op list --
    def shape_ops(self, seq, e, purged):
        verb, body = e["verb"], e["body"]
        if verb not in OPS:
            raise Malformed("verb", verb)
        if verb == "batch":
            # GUESS-06: body = {"ops": [ {verb, id, comp?, value?}, ... ]}
            if set(body) - {"ops", "followUps"}:
                raise Malformed("batch-field", ",".join(sorted(set(body) - {"ops", "followUps"})))
            ops = body.get("ops")
            if not isinstance(ops, list):
                raise Malformed("batch-ops")
            if "followUps" in body:
                # the authority's follow-up ops in this batch (strictly ascending indices, in range): applied like any op
                f = body["followUps"]
                if not isinstance(f, list) or not f:
                    raise Malformed("batch-followups", "not a non-empty array")
                for i, k in enumerate(f):
                    if not _int(k) or k >= len(ops) or (i > 0 and k <= f[i - 1]):
                        raise Malformed("batch-followups", repr(k))
            out = []
            for i, op in enumerate(ops):
                if not isinstance(op, dict):
                    raise Malformed("batch-op", str(i))
                if op.get("verb") == "batch":
                    raise Malformed("nested-batch", "op %d" % i)
                out.append(self.shape_one(op.get("verb"), op, purged.get((seq, i)),
                                          inner=True, where="op %d" % i))
            return out
        return [self.shape_one(verb, body, purged.get((seq, None)), inner=False,
                               where="")]

    def shape_one(self, verb, b, purge_seq, inner, where):
        allowed = {"create": {"id"}, "delete": {"id", "comp"},
                   "set": {"id", "comp", "value", "salt", "commit"}}
        if verb not in allowed:
            raise Malformed("verb", "%s %r" % (where, verb))
        keys = set(b) - ({"verb"} if inner else set())
        if keys - allowed[verb]:
            raise Malformed("op-field", "%s %s" % (where, ",".join(sorted(keys - allowed[verb]))))
        eid = b.get("id")
        if not isinstance(eid, str) or not ENTITY_RE.match(eid):
            raise Malformed("entity-id", "%s %r" % (where, eid))
        comp = b.get("comp")
        if verb == "set" or "comp" in b:
            if not isinstance(comp, str) or not COMP_RE.match(comp):
                raise Malformed("comp-name", "%s %r" % (where, comp))
        op = {"verb": verb, "id": eid, "comp": comp}
        if verb == "set":
            if purge_seq is not None:
                op["value"] = PURGED       # purge wins even if bytes are gone
            elif "value" in b:
                op["value"] = b["value"]   # GUESS-22: null is a value
            # else: no value -> no-op (L1)
        elif purge_seq is not None:
            op["purge_on_valueless"] = purge_seq
        return op

    def apply(self, seq, i, op):
        w, eid, comp, verb = self.world, op["id"], op["comp"], op["verb"]
        at = "seq %d op %d" % (seq, i)
        if "purge_on_valueless" in op:
            self.d(seq, "purge-target-not-a-value", at)
        if verb == "create":
            if eid in w:
                self.d(seq, "noop:create-live", eid)
            else:
                w[eid] = {}                 # GUESS-23: recreate starts empty
            return
        if eid not in w:
            self.d(seq, "noop:%s-missing-entity" % verb, eid)
            return
        if verb == "set":
            if "value" not in op:
                self.d(seq, "noop:set-no-value", "%s.%s" % (eid, comp))
                return
            w[eid][comp] = op["value"]
            return
        # delete
        if comp is None:
            if eid == "@world":
                self.d(seq, "noop:delete-@world", "")  # GUESS-24: fold enforces 2.3
                return
            del w[eid]
        elif comp in w[eid]:
            del w[eid][comp]
        else:
            self.d(seq, "noop:delete-missing-comp", "%s.%s" % (eid, comp))

    # -- digest --
    def view(self):
        return {eid: {c: ({"purged": True} if v is PURGED else {"v": v})
                      for c, v in comps.items()}
                for eid, comps in self.world.items()}

    def digest(self):
        return hashlib.sha256(jcs(self.view()).encode("utf-8")).hexdigest()


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    with open(argv[1], "rb") as f:
        data = f.read()
    r = Reader()
    r.read(data)
    if "--json" in argv:
        print(json.dumps({"status": r.status,
                          "digest": r.digest() if r.status == "ok" else None,
                          "world_id": r.world_id,
                          "diagnostics": [list(x) for x in r.diag]}))
    else:
        print("status", r.status)
        if r.status == "ok":
            print("digest", r.digest())
            if "--world" in argv:
                print("world ", jcs(r.view()))
        for seq, code, det in r.diag:
            print("  %4d  %-28s %s" % (seq, code, det))
    return 0 if r.status == "ok" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
