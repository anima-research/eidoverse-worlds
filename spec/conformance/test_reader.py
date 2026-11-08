#!/usr/bin/env python3
"""Hostile-log suite for reader.py. Writes each log to logs/ and checks it."""
import hashlib, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reader as R

HERE = os.path.dirname(os.path.abspath(__file__))
LOGS = os.path.join(HERE, "logs")
os.makedirs(LOGS, exist_ok=True)

# PROTOCOL §2.4 + §3d (C1, H5, H6): genesis body {dialect: "eidoverse-log", v: 4, nonce, rewindWindow?, parent?,
# owners: [[<key>…], …], quorum?, sequencer}. Keys are fixed test keys (ed25519 from sha256 seeds), nonce fixed.
K_OWNER = "ed25519:BP7aKo17f474DD1aBSLG0a3Pb29Qs3yqQ6Ve0wSRVD0"
K_SEQ = "ed25519:rRoIPhqlc8rDxC1GZlfHOe1IBJYWQ8MDNg9QuZzMsic"
K_TIER1 = "ed25519:iUs8tlcXt9q0Zq1OuuCX-llZgf5YdLA9vJ5aoaEFpkg"
NONCE, NONCE2 = "XWVu1u7BpaZTDFSETYiphg", "dLedD3Y4zEayxxDNGOBM6w"
GBODY = {"dialect": "eidoverse-log", "v": 4, "nonce": NONCE, "owners": [[K_OWNER]], "sequencer": K_SEQ}
GEN = {"kind": "genesis", "actor": "system", "body": GBODY}
GEN_LINE = json.dumps(GEN)
WID = "sha256:" + hashlib.sha256(R.jcs(R.parse_ijson(GEN_LINE.encode())).encode()).hexdigest()


def st(op, body, cause=1, **kw):
    e = {"world": WID, "kind": "change", "ts": 1, "actor": "system", "cause": cause,
         "op": op, "body": body}
    e.update(kw)
    return json.dumps(e)


ACT = json.dumps({"world": WID, "kind": "request", "ts": 1, "actor": "alice", "verb": "spawn", "body": {"args": {}}})


def _with_ts(line):
    # every entry after genesis carries ts (PROTOCOL 2.1); fixtures predate it, so add ts:1 unless present
    if line.startswith('{"world"') and '"ts"' not in line:
        return '{"ts": 1, ' + line[1:]
    return line


def run(name, lines, raw=None):
    data = raw if raw is not None else ("\n".join(_with_ts(l) for l in lines) + "\n").encode()
    with open(os.path.join(LOGS, name + ".jsonl"), "wb") as f:
        f.write(data)
    r = R.Reader(); r.read(data)
    return r


def codes(r):
    return [(s, c) for s, c, _ in r.diag]


def digest_of(view):
    return hashlib.sha256(R.jcs(view).encode()).hexdigest()


results = []


def check(name, cond, info=""):
    results.append((name, bool(cond), info))


# 1 baseline
r = run("01-baseline", [GEN_LINE, ACT,
    st("create", {"id": "lamp-1"}),
    st("set", {"id": "lamp-1", "comp": "light", "value": {"i": 2.5, "c": "#fff"}}),
    st("batch", {"ops": [{"op": "create", "id": "chair"},
                         {"op": "set", "id": "chair", "comp": "example.com/seat@2", "value": [1, 2]},
                         {"op": "set", "id": "@world", "comp": "roles:alice", "value": "owner"}]})])
exp = {"@world": {"roles:alice": {"v": "owner"}}, "chair": {"example.com/seat@2": {"v": [1, 2]}},
       "lamp-1": {"light": {"v": {"c": "#fff", "i": 2.5}}}}
check("01 baseline folds", r.status == "ok" and r.digest() == digest_of(exp) and not r.diag, r.diag)
BASE = r.digest()

# 2 key order / whitespace / number spelling must not change the digest
r2 = run("02-spelling", [GEN_LINE, ACT,
    st("create", {"id": "lamp-1"}),
    '{"body":{"value":{"c":"#fff","i":25e-1},"comp":"light","id":"lamp-1"},"op":"set","cause":1.0,"ts":1e0,"actor":"system","kind":"change","world":"%s"}' % WID,
    st("batch", {"ops": [{"op": "create", "id": "chair"},
                         {"op": "set", "id": "chair", "comp": "example.com/seat@2", "value": [1.0, 2e0]},
                         {"op": "set", "id": "@world", "comp": "roles:alice", "value": "own\u0065r"}]})])
check("02 spelling-invariant digest", r2.digest() == BASE, r2.diag)

# 3 duplicate keys (top-level and nested, and escaped-equal)
r = run("03-dupkeys", [GEN_LINE, ACT,
    st("create", {"id": "a"}),
    '{"world":"%s","kind":"change","actor":"system","cause":1,"op":"set","body":{"id":"a","comp":"x","value":1},"op":"delete"}' % WID,
    '{"world":"%s","kind":"change","actor":"system","cause":1,"op":"set","body":{"id":"a","comp":"x","value":{"k":1,"\\u006b":2}}}' % WID])
check("03 dup keys malformed, shape nothing", codes(r) == [(3, "malformed:ijson-dupkey"), (4, "malformed:ijson-dupkey")]
      and r.view() == {"@world": {}, "a": {}}, codes(r))

# 4 -0, NaN, Infinity, 1e400, -1e-400, huge int
bad = ["-0", "-0.0", "-0e3", "NaN", "Infinity", "-Infinity", "1e400", "-1e-400", "1" + "0" * 400]
lines = [GEN_LINE, ACT, st("create", {"id": "a"})]
for b in bad:
    lines.append('{"world":"%s","kind":"change","actor":"system","cause":1,"op":"set","body":{"id":"a","comp":"x","value":%s}}' % (WID, b))
lines.append(st("set", {"id": "a", "comp": "y", "value": 0}))
lines.append('{"world":"%s","kind":"change","actor":"system","cause":1,"op":"set","body":{"id":"a","comp":"z","value":9007199254740993}}' % WID)
r = run("04-numbers", lines)
mal = [c for s, c in codes(r) if c.startswith("malformed")]
check("04 all nine bad numbers + 2^53+1 malformed (PROTOCOL L1: big ints refused, not rounded)",
      len(mal) == 10 and (13, "malformed:ijson-bigint") in codes(r), codes(r))
check("04 0 ok; nothing from the bad lines lands",
      R.jcs(r.view()) == '{"@world":{},"a":{"y":{"v":0}}}', R.jcs(r.view()))
# salt is accepted on set and ignored by the fold
r = run("04b-salt", [GEN_LINE, ACT, st("create", {"id": "a"}),
                     st("set", {"id": "a", "comp": "x", "value": 1, "salt": "c2FsdA"})])
check("04b salt accepted and not folded", R.jcs(r.view()) == '{"@world":{},"a":{"x":{"v":1}}}', R.jcs(r.view()))

# 5 __proto__ / constructor / homoglyph / uppercase ids and names
r = run("05-names", [GEN_LINE, ACT,
    st("create", {"id": "__proto__"}),
    st("create", {"id": "constructor"}),     # grammar ALLOWS this
    st("create", {"id": "prototype"}),       # grammar ALLOWS this
    st("create", {"id": "l\u0430mp"}),       # Cyrillic a
    st("create", {"id": "Lamp"}),
    st("set", {"id": "constructor", "comp": "__proto__", "value": 1}),
    st("set", {"id": "constructor", "comp": "constructor", "value": {"__proto__": {"polluted": True}}}),
    st("create", {"id": "x" * 65}),
    st("create", {"id": "lamp\n"}),
    st("set", {"id": "constructor", "comp": "light@01", "value": 1}),
    st("set", {"id": "constructor", "comp": "roles:Alice", "value": 1}),
    st("create", {"id": "body:alice"}),
    st("create", {"id": "@World"}),
])
ok_ids = set(r.view())
check("05 __proto__/homoglyph/upper/65-char/newline/body: ids refused",
      ok_ids == {"@world", "constructor", "prototype"}, sorted(ok_ids))
check("05 'constructor' comp with __proto__ inside the value is kept as data",
      r.view()["constructor"] == {"constructor": {"v": {"__proto__": {"polluted": True}}}}, r.view()["constructor"])

# 6 nested batch
r = run("06-nested-batch", [GEN_LINE, ACT,
    st("batch", {"ops": [{"op": "create", "id": "a"},
                         {"op": "batch", "ops": [{"op": "create", "id": "b"}]}]})])
check("06 nested batch: whole entry shapes nothing", r.view() == {"@world": {}} and codes(r) == [(2, "malformed:nested-batch")], codes(r))

# 6b a batch's cascade (review r9 H1): the indices of the ops the authority derived from the asker's own, applied like any op; well formed or
# the whole entry is malformed (non-empty, strictly ascending integers, in range)
r = run("06b-cascade", [GEN_LINE, ACT,
    st("batch", {"ops": [{"op": "create", "id": "a"}, {"op": "set", "id": "a", "comp": "label", "value": "x"}], "cascade": [1]})])
check("06b cascade: a well-formed list folds like any batch", r.view() == {"@world": {}, "a": {"label": {"v": "x"}}} and not r.diag, codes(r))
for nm, f in [("06c-cascade-empty", []), ("06d-cascade-desc", [1, 0]), ("06e-cascade-range", [2]), ("06f-cascade-frac", [0.5]), ("06g-cascade-str", "1")]:
    r = run(nm, [GEN_LINE, ACT, st("batch", {"ops": [{"op": "create", "id": "a"}, {"op": "create", "id": "b"}], "cascade": f})])
    check("%s: malformed, the whole entry shapes nothing" % nm[:3], r.view() == {"@world": {}} and codes(r) == [(2, "malformed:batch-cascade")], codes(r))

# 7 unknown / wrong-typed version (genesis {dialect, v}), and another log's dialect
for nm, field, v in [("07a-version-5", "v", 5), ("07b-version-str", "v", "4"), ("07c-version-missing", "v", None), ("07d-version-4.0", "v", 4.0),
                     ("07e-dialect-other", "dialect", "some-other-log"), ("07f-dialect-missing", "dialect", None)]:
    g = dict(GEN); g["body"] = dict(GBODY)
    if v is None: del g["body"][field]
    else: g["body"][field] = v
    r = run(nm, [json.dumps(g), ACT])
    want = "ok" if nm == "07d-version-4.0" else "unknown-version"
    check("07 %s %r -> %s" % (field, v, want), r.status == want and (want == "ok" or r.world is None), r.status)

# 8 set/delete on missing entity, set with no value, create on live id, delete-then-recreate
r = run("08-edges", [GEN_LINE, ACT,
    st("set", {"id": "ghost", "comp": "x", "value": 1}),
    st("delete", {"id": "ghost"}),
    st("delete", {"id": "ghost", "comp": "x"}),
    st("create", {"id": "a"}),
    st("set", {"id": "a", "comp": "x", "value": 1}),
    st("create", {"id": "a"}),
    st("set", {"id": "a", "comp": "y"}),
    st("set", {"id": "a", "comp": "n", "value": None}),
    st("delete", {"id": "a"}),
    st("create", {"id": "a"}),
    st("delete", {"id": "@world"}),
    st("delete", {"id": "a", "comp": "nope"}),
])
check("08 edge no-ops and recreate-empty", r.view() == {"@world": {}, "a": {}} and
      [c for s, c in codes(r)] == ["noop:set-missing-entity", "noop:delete-missing-entity", "noop:delete-missing-entity",
                                   "noop:create-live", "noop:set-no-value", "noop:delete-@world", "noop:delete-missing-comp"], codes(r))

# 9 redaction: whole set, batch op, value bytes physically removed, redaction-of-redaction, forward ref, later overwrite
r = run("09-redaction", [GEN_LINE, ACT,
    st("create", {"id": "a"}),                                                   # 2
    st("set", {"id": "a", "comp": "note", "value": "my phone is 555"}),          # 3
    st("batch", {"ops": [{"op": "set", "id": "a", "comp": "x", "value": 1},
                         {"op": "set", "id": "a", "comp": "y", "value": "secret"}]}),  # 4
    st("set", {"id": "a", "comp": "z"}),                                         # 5: value bytes already gone
    st("set", {"id": "a", "comp": "w", "value": "old"}),                         # 6
    st("set", {"id": "a", "comp": "w", "value": "new"}),                         # 7
    json.dumps({"world": WID, "kind": "redaction", "actor": "system",
                "body": {"values": [{"seq": 3}, {"seq": 4, "index": 1}, {"seq": 5}, {"seq": 6}, {"seq": 2}]}}),  # 8
    json.dumps({"world": WID, "kind": "redaction", "actor": "system",
                "body": {"values": [{"seq": 8}, {"seq": 99}]}}),                 # 9
])
v = r.view()["a"]
check("09 redaction -> absent(redacted), distinct from deleted",
      v == {"note": {"redacted": True}, "x": {"v": 1}, "y": {"redacted": True}, "z": {"redacted": True}, "w": {"v": "new"}}, v)
check("09 redaction-of-redaction and forward target refused; redaction of a create diagnosed",
      (9, "redaction-of-redaction-refused") in codes(r) and (9, "redaction-target-range") in codes(r)
      and (2, "redaction-target-not-a-value") in codes(r), codes(r))

# 10 genesis not first / second genesis / empty log / garbage line 0
r = run("10a-genesis-late", [ACT, GEN_LINE])
check("10a entry 0 not genesis -> no-world", r.status == "no-world", r.status)
r = run("10b-two-genesis", [GEN_LINE, ACT, GEN_LINE, st("create", {"id": "a"})])
check("10b second genesis malformed", (2, "malformed:genesis-not-first") in codes(r) and "a" in r.view(), codes(r))
r = run("10c-empty", [], raw=b"")
check("10c empty log -> no-world", r.status == "no-world")

# 11 envelope strictness: seq field, unknown field, missing cause, cause forward, unknown kind, `for` (D4: an unknown field), a change carrying `verb`, a request carrying `op`
r = run("11-envelope", [GEN_LINE, ACT,
    st("create", {"id": "a"}, seq=2),
    st("create", {"id": "b"}, extra=1),
    json.dumps({"world": WID, "kind": "change", "actor": "system", "op": "create", "body": {"id": "c"}}),
    st("create", {"id": "d"}, cause=99),
    json.dumps({"world": WID, "kind": "teleport", "actor": "system", "verb": "x", "body": {}}),
    st("create", {"id": "e"}, **{"for": "bob"}),
    st("create", {"id": "f"}, cause=1.5),
    st("create", {"id": "g"}, cause=0),       # cause = genesis: allowed by this reader
    st("create", {"id": "h"}, verb="create"),  # a change carrying the old `verb` beside `op` (D3)
    json.dumps({"world": WID, "kind": "request", "actor": "alice", "op": "spawn", "body": {"args": {}}}),  # a request carrying `op`
    json.dumps({"world": WID, "kind": "change", "actor": "system", "cause": 1, "verb": "create", "body": {"id": "i"}}),  # a change with `verb` and no `op`
])
check("11 only g survives", set(r.view()) == {"@world", "g"}, codes(r))
check("11 the old spellings are refused by name", (7, "malformed:unknown-field") in codes(r) and (10, "malformed:envelope") in codes(r) and (11, "malformed:envelope") in codes(r) and (12, "malformed:envelope") in codes(r), codes(r))

# 12 blank line occupies a seq; CRLF; BOM; invalid utf-8; lone surrogate; noncharacter
raw = (GEN_LINE + "\n" + ACT + "\n\n" + st("create", {"id": "a"}, cause=1) + "\r\n").encode()
r = run("12a-blank-crlf", None, raw=raw)
check("12a blank line is seq 2 (malformed); CRLF line still parses as seq 3",
      (2, "malformed:json-syntax") in codes(r) and "a" in r.view(), codes(r))
r = run("12b-bom", None, raw=b"\xef\xbb\xbf" + GEN_LINE.encode() + b"\n")
check("12b BOM on genesis -> no-world", r.status == "no-world", codes(r))
r = run("12c-text", [GEN_LINE, ACT, st("create", {"id": "a"})], raw=None)
data = (GEN_LINE + "\n" + ACT + "\n" + st("create", {"id": "a"}) + "\n").encode()
data += b'{"ts":1,"world":"' + WID.encode() + b'","kind":"change","actor":"\xff","cause":1,"op":"create","body":{"id":"b"}}\n'
data += ('{"ts":1,"world":"%s","kind":"change","actor":"system","cause":1,"op":"set","body":{"id":"a","comp":"s","value":"\\ud800"}}\n' % WID).encode()
data += ('{"ts":1,"world":"%s","kind":"change","actor":"system","cause":1,"op":"set","body":{"id":"a","comp":"s","value":"\\ufdd0"}}\n' % WID).encode()
r = run("12c-strings", None, raw=data)
check("12c bad utf-8 / lone surrogate / noncharacter malformed",
      [c for s, c in codes(r)] == ["malformed:ijson-utf8", "malformed:ijson-surrogate", "malformed:ijson-noncharacter"], codes(r))

# 13 depth cap and deep nesting that would blow a recursive parser
r = run("13-depth", [GEN_LINE, ACT, st("create", {"id": "a"}),
    '{"world":"%s","kind":"change","actor":"system","cause":1,"op":"set","body":{"id":"a","comp":"d","value":%s}}' % (WID, "[" * 100000 + "]" * 100000)])
check("13 100k-deep array malformed, not a crash", (3, "malformed:cap-depth") in codes(r), codes(r))

# 14 batch with one bad name: whole batch shapes nothing; batch with semantic no-op: rest applies
r = run("14-batch-partial", [GEN_LINE, ACT,
    st("batch", {"ops": [{"op": "create", "id": "a"}, {"op": "set", "id": "a", "comp": "BAD", "value": 1}]}),
    st("batch", {"ops": [{"op": "create", "id": "b"}, {"op": "set", "id": "ghost", "comp": "x", "value": 1},
                         {"op": "set", "id": "b", "comp": "x", "value": 2}]})])
check("14 grammar error kills the batch; semantic no-op does not", r.view() == {"@world": {}, "b": {"x": {"v": 2}}}, codes(r))

# 15 JCS number formatting vs RFC 8785 Appendix B samples
samples = {0.0: "0", 1e21: "1e+21", 1e20: "100000000000000000000", 5e-324: "5e-324",
           1.7976931348623157e308: "1.7976931348623157e+308", 333333333.3333333: "333333333.3333333",
           0.000001: "0.000001", 1e-7: "1e-7", 4.5: "4.5", 2e-3: "0.002", 0.1: "0.1",
           9007199254740992.0: "9007199254740992", 295147905179352830000.0: "295147905179352830000",
           -5e-324: "-5e-324", 1e23: "1e+23"}
bad15 = {k: (R.jcs_number(k), v) for k, v in samples.items() if R.jcs_number(k) != v}
check("15 JCS numbers match ES formatting", not bad15, bad15)
# 18 ts: missing, fractional and decreasing are malformed; equal is fine
r = run("18-ts", [GEN_LINE, ACT, st("create", {"id": "a"}),
    st("set", {"id": "a", "comp": "x", "value": 1}, ts=5),
    st("set", {"id": "a", "comp": "x", "value": 2}, ts=5),
    st("set", {"id": "a", "comp": "x", "value": 3}, ts=4),
    st("set", {"id": "a", "comp": "x", "value": 4}, ts=6.5)])
check("18 decreasing / fractional ts malformed; equal ts fine",
      (5, "malformed:ts-decreasing") in codes(r) and (6, "malformed:ts") in codes(r)
      and r.view()["a"] == {"x": {"v": 2}}, (codes(r), r.view()))
NO_TS = json.dumps({"kind": "change", "world": WID, "actor": "system", "cause": 1, "op": "set",
                    "body": {"id": "a", "comp": "x", "value": 9}})   # starts with "kind" so _with_ts leaves it alone
r = run("18b-ts-missing", [GEN_LINE, ACT, st("create", {"id": "a"}), NO_TS])
check("18b missing ts malformed", (3, "malformed:ts") in codes(r) and r.view()["a"] == {}, (codes(r), r.view()))
# 18c another world's id: malformed, like a decreasing ts: it shapes nothing and doesn't move the clock (tel0s D2, 11-06)
OTHER = "sha256:" + "ab" * 32
r = run("18c-world-mismatch", [GEN_LINE, ACT, st("create", {"id": "a"}),
    st("create", {"id": "b"}, world=OTHER, ts=9),
    st("set", {"id": "a", "comp": "x", "value": 1}, ts=5)])
check("18c an entry carrying another world's id is malformed and shapes nothing",
      codes(r) == [(3, "malformed:world-mismatch")] and set(r.view()) == {"@world", "a"} and r.view()["a"] == {"x": {"v": 1}}, (codes(r), r.view()))

# 21 non-string kind / op word: malformed, not a TypeError (parity with fold.js checkEntry / shapeOne; bot #477)
r = run("21-nonstring-kind-op", [GEN_LINE, ACT, st("create", {"id": "a"}),
    json.dumps({"world": WID, "kind": [], "ts": 1, "actor": "system", "op": "set", "body": {}}),
    st("batch", {"ops": [{"op": [], "id": "a"}]}),
    st("set", {"id": "a", "comp": "x", "value": 1})])
check("21 kind=[] and op=[] are malformed, the log still folds",
      (3, "malformed:kind") in codes(r) and (4, "malformed:op") in codes(r) and r.view()["a"] == {"x": {"v": 1}}, (codes(r), r.view()))

# 22 redaction target {seq, index: null}: redaction-target-bad, not "the whole set" (parity with fold.js redactionsOf; bot #478)
r = run("22-redaction-index-null", [GEN_LINE, ACT, st("create", {"id": "a"}),
    st("set", {"id": "a", "comp": "x", "value": 1}),                                                       # 3
    json.dumps({"world": WID, "kind": "redaction", "actor": "system",
                "body": {"values": [{"seq": 3, "index": None}]}})])                                       # 4
check("22 redaction index:null is a bad target; the value stays",
      (4, "redaction-target-bad") in codes(r) and (4, "redaction") not in codes(r) and r.view()["a"] == {"x": {"v": 1}}, (codes(r), r.view()))

check("15 JCS key order by UTF-16 units", R.jcs({"\U0001f600": 1, "\ufb33": 2}) == '{"\U0001f600":1,"\ufb33":2}')

# 16 Python-specific: bool must not be a number; value True vs 1 differ
r = run("16-bool", [GEN_LINE, ACT, st("create", {"id": "a"}),
    st("set", {"id": "a", "comp": "t", "value": True}), st("set", {"id": "a", "comp": "o", "value": 1})])
check("16 true and 1 stay distinct", R.jcs(r.view()["a"]) == '{"o":{"v":1},"t":{"v":true}}', R.jcs(r.view()))

# 19 genesis shape (PROTOCOL §2.4, §3d C1/H5/H6). A malformed genesis means "no world"; an unknown v means "unknown
# version" (07a); the fields are exact, so a `minor` is a stray field (Mica 11-04: there is no minor).
def gen_with(**kw):
    b = dict(GBODY)
    for k, v in kw.items():
        if v is _DEL: b.pop(k, None)
        else: b[k] = v
    return json.dumps({"kind": "genesis", "actor": "system", "body": b})
_DEL = object()
def wid_of(line):
    return "sha256:" + hashlib.sha256(R.jcs(R.parse_ijson(line.encode())).encode()).hexdigest()
def gen_log(name, gline):
    w = wid_of(gline)
    return run(name, [gline, json.dumps({"world": w, "kind": "request", "ts": 1, "actor": "alice", "verb": "spawn", "body": {"args": {}}}),
                      json.dumps({"world": w, "kind": "change", "ts": 1, "actor": "system", "cause": 1, "op": "create", "body": {"id": "a"}})])
SMALL_NEG = "ed25519:" + "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIA"  # same y, sign bit set ("-0")
import base64 as _b
_b64 = lambda raw: _b.urlsafe_b64encode(raw).rstrip(b"=").decode()
BIG_Y = "ed25519:" + _b64((2**255 - 19 + 1).to_bytes(32, "little"))     # y >= p
PROV = {"registry": {"id": "registry-pin", "sha256": "ab" * 32}, "writer": {"name": "eidoverse-server", "version": "4.1.0", "sourceRevision": "git:sha1:" + "cd" * 20, "sourceTreeSha256": "ef" * 32, "dirty": False}}
bad19 = {
    "19a-genesis-no-nonce": (gen_with(nonce=_DEL), "no-world", "malformed:genesis-nonce"),
    "19b-genesis-short-nonce": (gen_with(nonce=_b64(b"\x01" * 15)), "no-world", "malformed:genesis-nonce"),
    "19c-genesis-nonce-not-b64url": (gen_with(nonce="XWVu1u7BpaZTDFSETYiphg=="), "no-world", "malformed:genesis-nonce"),
    "19e-genesis-stray-minor": (gen_with(minor=1), "no-world", "malformed:genesis-field"),
    "19f-genesis-flat-owners": (gen_with(owners=[K_OWNER]), "no-world", "malformed:genesis-owners"),
    "19g-genesis-small-order-key": (gen_with(owners=[[SMALL_NEG]]), "no-world", "malformed:genesis-key"),
    "19h-genesis-key-y-ge-p": (gen_with(sequencer=BIG_Y), "no-world", "malformed:genesis-key"),
    "19i-genesis-no-sequencer": (gen_with(sequencer=_DEL), "no-world", "malformed:genesis-sequencer"),
    "19j-genesis-unknown-field": (gen_with(rewind_n=5), "no-world", "malformed:genesis-field"),
    "19k-genesis-key-twice": (gen_with(owners=[[K_OWNER], [K_OWNER]]), "no-world", "malformed:genesis-owners"),
    "19l-genesis-bad-quorum": (gen_with(quorum=[0]), "no-world", "malformed:genesis-quorum"),
    "19m-genesis-bad-window": (gen_with(rewindWindow=-1), "no-world", "malformed:genesis-window"),
    "19m2-genesis-old-window": (gen_with(rewind_window=5), "no-world", "malformed:genesis-field"),
    "19n-genesis-bad-parent": (gen_with(parent={"world": "sha256:00", "seq": 3, "head": "00" * 32}), "no-world", "malformed:genesis-parent"),
    # §F F-1/F-2: requires is sorted unique namespace:name@major ids; provenance is the exact writer object
    "19q-genesis-bad-requires": (gen_with(requires=["b:b@1", "a:a@1"]), "no-world", "malformed:genesis-requires"),
    "19r-genesis-bad-provenance": (gen_with(provenance=dict(PROV, writer={k: v for k, v in PROV["writer"].items() if k != "sourceTreeSha256"})), "no-world", "malformed:genesis-provenance"),
    "19s-genesis-unknown-feature": (gen_with(requires=["x:unknown@1"]), "unsupported-feature", "unsupported-feature"),
}
for nm, (gl, want, code) in bad19.items():
    r = gen_log(nm, gl)
    check("19 %s -> %s (%s)" % (nm, want, code), r.status == want and r.world is None and (0, code) in codes(r), (r.status, codes(r)))
r = gen_log("19o-genesis-full", gen_with(owners=[[], [K_TIER1, K_OWNER]], quorum=[1, 2], rewindWindow=500,
                                         parent={"world": "sha256:" + "ab" * 32, "seq": 12, "head": "cd" * 32}))
check("19o full genesis (empty tier 0, quorum, window, parent) folds", r.status == "ok" and "a" in r.view() and not r.diag, codes(r))
r = gen_log("19t-genesis-requires-provenance", gen_with(requires=[], provenance=PROV))
check("19t a genesis carrying an empty requires and a writer provenance folds", r.status == "ok" and "a" in r.view() and not r.diag, codes(r))
gl = gen_with(); w = wid_of(gl)
r = run("19u-requiresadd-unknown", [gl, json.dumps({"world": w, "kind": "change", "ts": 1, "actor": "system", "op": "create", "cause": 0, "body": {"id": "a"}}),
        json.dumps({"world": w, "kind": "governance", "ts": 2, "actor": "system", "body": {"requiresAdd": ["x:unknown@1"], "sigs": []}}),
        json.dumps({"world": w, "kind": "change", "ts": 3, "actor": "system", "op": "create", "cause": 0, "body": {"id": "b"}})])
check("19u a governance requiresAdd naming an unknown feature: unsupported-feature at its seq, no world (never a partial fold)", r.status == "unsupported-feature" and r.world is None and (2, "unsupported-feature") in codes(r), (r.status, codes(r)))
g1, g2 = gen_with(), gen_with(nonce=NONCE2)
check("19p same keys, different nonce -> different world ids (C1)", wid_of(g1) != wid_of(g2) and R.parse_ijson(g1.encode())["body"]["owners"] == R.parse_ijson(g2.encode())["body"]["owners"])

# 20 a redaction never targets roles: (PROTOCOL §3d M11): diagnosed and ignored; other targets in the same redaction still apply
r = run("20-redaction-roles", [GEN_LINE, ACT,
    st("batch", {"ops": [{"op": "set", "id": "@world", "comp": "roles:alice", "value": {"role": "owner"}},
                         {"op": "set", "id": "@world", "comp": "note", "value": "a phone number"}]}),          # 2
    st("set", {"id": "@world", "comp": "roles:bob", "value": {"role": "builder"}}),                               # 3
    json.dumps({"world": WID, "kind": "redaction", "actor": "system",
                "body": {"values": [{"seq": 2, "index": 0}, {"seq": 2, "index": 1}, {"seq": 3}]}})])              # 4
check("20 redaction of roles: ignored (diagnosed), the note redacted",
      r.view()["@world"] == {"roles:alice": {"v": {"role": "owner"}}, "note": {"redacted": True}, "roles:bob": {"v": {"role": "builder"}}}
      and [c for s_, c in codes(r)].count("redaction-target-governance") == 2, (r.view(), codes(r)))


# ---- docs/DESIGN-log-vocabulary.md §5: the positive fixtures F1–F3, F8 and the negative set F14 ----
# F1 an admitted request: kind request, verb, body.args an object (the readback keys on args.*)
r = run("23a-f1-request-admitted", [GEN_LINE,
    json.dumps({"world": WID, "kind": "request", "ts": 1, "actor": "alice", "verb": "set", "body": {"args": {"id": "@world", "component": "label", "value": "x"}, "salt": "UUPZ_XwQSbZtpmdmt87bSQ"}}),
    st("set", {"id": "@world", "comp": "label", "value": "x", "salt": "5hGJikDRuwCGCS7slx6mug"})])
check("F1 an admitted request folds beside its change; the fold never reads it", r.status == "ok" and not r.diag and r.view()["@world"] == {"label": {"v": "x"}}, codes(r))
# F2 a refused request: body.argNames lists names, never a value; refused.code
F2 = {"world": WID, "kind": "request", "ts": 1, "actor": "bob", "verb": "delete", "body": {"argNames": ["id"], "refused": {"code": "locked"}, "salt": "UWGy2eg11rNn2Sl6urvUTg"}}
r = run("23b-f2-request-refused", [GEN_LINE, json.dumps(F2)])
check("F2 a refused request is a request entry (argNames, refused.code) the fold never reads", r.status == "ok" and not r.diag and r.view() == {"@world": {}}, codes(r))
# F3 a say: no verb
r = run("23c-f3-say", [GEN_LINE, json.dumps({"world": WID, "kind": "say", "ts": 1, "actor": "alice", "body": {"text": "hi", "salt": "Gz4fypccq-7GOARwIgA8Vw"}})])
check("F3 a say carries no verb and folds nothing", r.status == "ok" and not r.diag and r.view() == {"@world": {}}, codes(r))
# F8 cascade: the batch folds whole; the marked op is the authority's (readers of authorship skip it: tools/protocol/r9-check)
r = run("23d-f8-cascade", [GEN_LINE, ACT,
    st("batch", {"ops": [{"op": "delete", "id": "shelf"}, {"op": "create", "id": "vase"}, {"op": "set", "id": "vase", "comp": "transform", "value": {"pos": [0, 0.9, 0]}, "salt": "5hGJikDRuwCGCS7slx6mug"}], "cascade": [2]})])
check("F8 a batch with a cascade folds like any batch", r.status == "ok" and r.view()["vase"] == {"transform": {"v": {"pos": [0, 0.9, 0]}}} and codes(r) == [(2, "noop:delete-missing-entity")], codes(r))
# F14 the new reader refuses every old spelling by name, status ok, the rest of the log folded
GEN_OLD_VERB = json.dumps({"kind": "genesis", "actor": "system", "verb": "genesis", "body": GBODY})
F14 = {
    "24a-old-change-verb": ([GEN_LINE, ACT, st("create", {"id": "a"}), json.dumps({"world": WID, "kind": "change", "ts": 1, "actor": "system", "cause": 1, "verb": "create", "body": {"id": "b"}})], (3, "malformed:envelope"), {"@world", "a"}),
    "24b-old-request-op": ([GEN_LINE, json.dumps({"world": WID, "kind": "request", "ts": 1, "actor": "alice", "op": "spawn", "body": {"args": {}}}), st("create", {"id": "a"}, cause=0)], (1, "malformed:envelope"), {"@world", "a"}),
    "24c-old-say-verb": ([GEN_LINE, ACT, json.dumps({"world": WID, "kind": "say", "ts": 1, "actor": "alice", "verb": "say", "body": {"text": "hi"}})], (2, "malformed:envelope"), {"@world"}),
    "24d-old-redaction-verb": ([GEN_LINE, ACT, st("create", {"id": "a"}), json.dumps({"world": WID, "kind": "redaction", "ts": 1, "actor": "system", "verb": "purge", "body": {"values": [{"seq": 2}]}})], (3, "malformed:envelope"), {"@world", "a"}),
    "24e-old-governance-verb": ([GEN_LINE, ACT, json.dumps({"world": WID, "kind": "governance", "ts": 1, "actor": "system", "verb": "sequencer", "body": {"key": K_TIER1, "sigs": []}})], (2, "malformed:envelope"), {"@world"}),
    "24f-old-batch-followUps": ([GEN_LINE, ACT, st("batch", {"ops": [{"op": "create", "id": "a"}, {"op": "create", "id": "b"}], "followUps": [1]})], (2, "malformed:batch-field"), {"@world"}),
    "24g-old-batch-item-verb": ([GEN_LINE, ACT, st("batch", {"ops": [{"verb": "create", "id": "a"}]})], (2, "malformed:op"), {"@world"}),
    "24h-old-set-commit": ([GEN_LINE, ACT, st("create", {"id": "a"}), st("set", {"id": "a", "comp": "x", "commit": "00" * 32})], (3, "malformed:op-field"), {"@world", "a"}),
    "24i-old-redaction-target-op": ([GEN_LINE, ACT, st("create", {"id": "a"}), st("set", {"id": "a", "comp": "x", "value": 1}),
                                     json.dumps({"world": WID, "kind": "redaction", "ts": 1, "actor": "system", "body": {"values": [{"seq": 3, "op": 0}]}})], (4, "redaction-target-bad"), {"@world", "a"}),
    "24j-old-envelope-for": ([GEN_LINE, ACT, st("create", {"id": "a"}, **{"for": "bob"})], (2, "malformed:unknown-field"), {"@world"}),
    "24k-old-envelope-grant": ([GEN_LINE, ACT, st("create", {"id": "a"}, grant="x")], (2, "malformed:unknown-field"), {"@world"}),
    "24l-old-envelope-by": ([GEN_LINE, ACT, st("create", {"id": "a"}, by="alice")], (2, "malformed:unknown-field"), {"@world"}),
    "24m-old-kind-act": ([GEN_LINE, json.dumps({"world": WID, "kind": "act", "ts": 1, "actor": "alice", "verb": "spawn", "body": {}})], (1, "malformed:kind"), {"@world"}),
    "24n-old-kind-sim": ([GEN_LINE, ACT, json.dumps({"world": WID, "kind": "sim", "ts": 1, "actor": "sim", "verb": "digest", "body": {}})], (2, "malformed:kind"), {"@world"}),
    "24o-old-kind-purge": ([GEN_LINE, ACT, json.dumps({"world": WID, "kind": "purge", "ts": 1, "actor": "system", "body": {"values": []}})], (2, "malformed:kind"), {"@world"}),
    "24p-old-kind-sequencer": ([GEN_LINE, ACT, json.dumps({"world": WID, "kind": "sequencer", "ts": 1, "actor": "system", "body": {"key": K_TIER1, "sigs": []}})], (2, "malformed:kind"), {"@world"}),
    "24q-old-genesis-verb": ([GEN_OLD_VERB, ACT], (0, "malformed:envelope"), None),
}
for nm, (lines, code, live) in F14.items():
    r = run(nm, lines)
    if live is None:
        check("F14 %s: a genesis carrying verb is no world" % nm, r.status == "no-world" and code in codes(r), (r.status, codes(r)))
    else:
        check("F14 %s refused by name, status ok, the rest folded" % nm, r.status == "ok" and code in codes(r) and set(r.view()) == live, (r.status, codes(r), sorted(r.view())))

fails = 0
for n, ok, info in results:
    print(("PASS " if ok else "FAIL ") + n + ("" if ok else "   -> %s" % (info,)))
    fails += not ok
print("%d/%d passed" % (len(results) - fails, len(results)))
print("baseline digest", BASE)
sys.exit(1 if fails else 0)
