#!/usr/bin/env python3
"""Hostile-log suite for reader.py. Writes each log to logs/ and checks it."""
import hashlib, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reader as R

HERE = os.path.dirname(os.path.abspath(__file__))
LOGS = os.path.join(HERE, "logs")
os.makedirs(LOGS, exist_ok=True)

# PROTOCOL §2.4 + §3d (C1, H5, H6): genesis body {dialect: "eidoverse-log", v: 4, minor, nonce, rewind_window?, parent?,
# owners: [[<key>…], …], quorum?, sequencer}. Keys are fixed test keys (ed25519 from sha256 seeds), nonce fixed.
K_OWNER = "ed25519:BP7aKo17f474DD1aBSLG0a3Pb29Qs3yqQ6Ve0wSRVD0"
K_SEQ = "ed25519:rRoIPhqlc8rDxC1GZlfHOe1IBJYWQ8MDNg9QuZzMsic"
K_TIER1 = "ed25519:iUs8tlcXt9q0Zq1OuuCX-llZgf5YdLA9vJ5aoaEFpkg"
NONCE, NONCE2 = "XWVu1u7BpaZTDFSETYiphg", "dLedD3Y4zEayxxDNGOBM6w"
GBODY = {"dialect": "eidoverse-log", "v": 4, "minor": 0, "nonce": NONCE, "owners": [[K_OWNER]], "sequencer": K_SEQ}
GEN = {"kind": "genesis", "actor": "system", "verb": "genesis", "body": GBODY}
GEN_LINE = json.dumps(GEN)
WID = "sha256:" + hashlib.sha256(R.jcs(R.parse_ijson(GEN_LINE.encode())).encode()).hexdigest()


def st(verb, body, cause=1, **kw):
    e = {"world": WID, "kind": "change", "ts": 1, "actor": "system", "cause": cause,
         "verb": verb, "body": body}
    e.update(kw)
    return json.dumps(e)


ACT = json.dumps({"world": WID, "kind": "act", "ts": 1, "actor": "alice", "verb": "spawn", "body": {}})


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
    st("batch", {"ops": [{"verb": "create", "id": "chair"},
                         {"verb": "set", "id": "chair", "comp": "example.com/seat@2", "value": [1, 2]},
                         {"verb": "set", "id": "@world", "comp": "roles:alice", "value": "owner"}]})])
exp = {"@world": {"roles:alice": {"v": "owner"}}, "chair": {"example.com/seat@2": {"v": [1, 2]}},
       "lamp-1": {"light": {"v": {"c": "#fff", "i": 2.5}}}}
check("01 baseline folds", r.status == "ok" and r.digest() == digest_of(exp) and not r.diag, r.diag)
BASE = r.digest()

# 2 key order / whitespace / number spelling must not change the digest
r2 = run("02-spelling", [GEN_LINE, ACT,
    st("create", {"id": "lamp-1"}),
    '{"body":{"value":{"c":"#fff","i":25e-1},"comp":"light","id":"lamp-1"},"verb":"set","cause":1.0,"ts":1e0,"actor":"system","kind":"change","world":"%s"}' % WID,
    st("batch", {"ops": [{"verb": "create", "id": "chair"},
                         {"verb": "set", "id": "chair", "comp": "example.com/seat@2", "value": [1.0, 2e0]},
                         {"verb": "set", "id": "@world", "comp": "roles:alice", "value": "own\u0065r"}]})])
check("02 spelling-invariant digest", r2.digest() == BASE, r2.diag)

# 3 duplicate keys (top-level and nested, and escaped-equal)
r = run("03-dupkeys", [GEN_LINE, ACT,
    st("create", {"id": "a"}),
    '{"world":"%s","kind":"change","actor":"system","cause":1,"verb":"set","body":{"id":"a","comp":"x","value":1},"verb":"delete"}' % WID,
    '{"world":"%s","kind":"change","actor":"system","cause":1,"verb":"set","body":{"id":"a","comp":"x","value":{"k":1,"\\u006b":2}}}' % WID])
check("03 dup keys malformed, shape nothing", codes(r) == [(3, "malformed:ijson-dupkey"), (4, "malformed:ijson-dupkey")]
      and r.view() == {"@world": {}, "a": {}}, codes(r))

# 4 -0, NaN, Infinity, 1e400, -1e-400, huge int
bad = ["-0", "-0.0", "-0e3", "NaN", "Infinity", "-Infinity", "1e400", "-1e-400", "1" + "0" * 400]
lines = [GEN_LINE, ACT, st("create", {"id": "a"})]
for b in bad:
    lines.append('{"world":"%s","kind":"change","actor":"system","cause":1,"verb":"set","body":{"id":"a","comp":"x","value":%s}}' % (WID, b))
lines.append(st("set", {"id": "a", "comp": "y", "value": 0}))
lines.append('{"world":"%s","kind":"change","actor":"system","cause":1,"verb":"set","body":{"id":"a","comp":"z","value":9007199254740993}}' % WID)
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
    st("batch", {"ops": [{"verb": "create", "id": "a"},
                         {"verb": "batch", "ops": [{"verb": "create", "id": "b"}]}]})])
check("06 nested batch: whole entry shapes nothing", r.view() == {"@world": {}} and codes(r) == [(2, "malformed:nested-batch")], codes(r))

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

# 9 purge: whole set, batch op, value bytes physically removed, purge-of-purge, forward ref, later overwrite
r = run("09-purge", [GEN_LINE, ACT,
    st("create", {"id": "a"}),                                                   # 2
    st("set", {"id": "a", "comp": "note", "value": "my phone is 555"}),          # 3
    st("batch", {"ops": [{"verb": "set", "id": "a", "comp": "x", "value": 1},
                         {"verb": "set", "id": "a", "comp": "y", "value": "secret"}]}),  # 4
    st("set", {"id": "a", "comp": "z"}),                                         # 5: value bytes already gone
    st("set", {"id": "a", "comp": "w", "value": "old"}),                         # 6
    st("set", {"id": "a", "comp": "w", "value": "new"}),                         # 7
    json.dumps({"world": WID, "kind": "purge", "actor": "system", "verb": "purge",
                "body": {"values": [{"seq": 3}, {"seq": 4, "op": 1}, {"seq": 5}, {"seq": 6}, {"seq": 2}]}}),  # 8
    json.dumps({"world": WID, "kind": "purge", "actor": "system", "verb": "purge",
                "body": {"values": [{"seq": 8}, {"seq": 99}]}}),                 # 9
])
v = r.view()["a"]
check("09 purge -> absent(purged), distinct from deleted",
      v == {"note": {"purged": True}, "x": {"v": 1}, "y": {"purged": True}, "z": {"purged": True}, "w": {"v": "new"}}, v)
check("09 purge-of-purge and forward target refused; purge of a create diagnosed",
      (9, "purge-of-purge-refused") in codes(r) and (9, "purge-target-range") in codes(r)
      and (2, "purge-target-not-a-value") in codes(r), codes(r))

# 10 genesis not first / second genesis / empty log / garbage line 0
r = run("10a-genesis-late", [ACT, GEN_LINE])
check("10a entry 0 not genesis -> no-world", r.status == "no-world", r.status)
r = run("10b-two-genesis", [GEN_LINE, ACT, GEN_LINE, st("create", {"id": "a"})])
check("10b second genesis malformed", (2, "malformed:genesis-not-first") in codes(r) and "a" in r.view(), codes(r))
r = run("10c-empty", [], raw=b"")
check("10c empty log -> no-world", r.status == "no-world")

# 11 envelope strictness: seq field, unknown field, missing cause, cause forward, unknown kind, `for`
r = run("11-envelope", [GEN_LINE, ACT,
    st("create", {"id": "a"}, seq=2),
    st("create", {"id": "b"}, extra=1),
    json.dumps({"world": WID, "kind": "change", "actor": "system", "verb": "create", "body": {"id": "c"}}),
    st("create", {"id": "d"}, cause=99),
    json.dumps({"world": WID, "kind": "teleport", "actor": "system", "verb": "x", "body": {}}),
    st("create", {"id": "e"}, **{"for": "bob"}),
    st("create", {"id": "f"}, cause=1.5),
    st("create", {"id": "g"}, cause=0),       # cause = genesis: allowed by this reader
])
check("11 only g survives", set(r.view()) == {"@world", "g"}, codes(r))

# 12 blank line occupies a seq; CRLF; BOM; invalid utf-8; lone surrogate; noncharacter
raw = (GEN_LINE + "\n" + ACT + "\n\n" + st("create", {"id": "a"}, cause=1) + "\r\n").encode()
r = run("12a-blank-crlf", None, raw=raw)
check("12a blank line is seq 2 (malformed); CRLF line still parses as seq 3",
      (2, "malformed:json-syntax") in codes(r) and "a" in r.view(), codes(r))
r = run("12b-bom", None, raw=b"\xef\xbb\xbf" + GEN_LINE.encode() + b"\n")
check("12b BOM on genesis -> no-world", r.status == "no-world", codes(r))
r = run("12c-text", [GEN_LINE, ACT, st("create", {"id": "a"})], raw=None)
data = (GEN_LINE + "\n" + ACT + "\n" + st("create", {"id": "a"}) + "\n").encode()
data += b'{"ts":1,"world":"' + WID.encode() + b'","kind":"change","actor":"\xff","cause":1,"verb":"create","body":{"id":"b"}}\n'
data += ('{"ts":1,"world":"%s","kind":"change","actor":"system","cause":1,"verb":"set","body":{"id":"a","comp":"s","value":"\\ud800"}}\n' % WID).encode()
data += ('{"ts":1,"world":"%s","kind":"change","actor":"system","cause":1,"verb":"set","body":{"id":"a","comp":"s","value":"\\ufdd0"}}\n' % WID).encode()
r = run("12c-strings", None, raw=data)
check("12c bad utf-8 / lone surrogate / noncharacter malformed",
      [c for s, c in codes(r)] == ["malformed:ijson-utf8", "malformed:ijson-surrogate", "malformed:ijson-noncharacter"], codes(r))

# 13 depth cap and deep nesting that would blow a recursive parser
r = run("13-depth", [GEN_LINE, ACT, st("create", {"id": "a"}),
    '{"world":"%s","kind":"change","actor":"system","cause":1,"verb":"set","body":{"id":"a","comp":"d","value":%s}}' % (WID, "[" * 100000 + "]" * 100000)])
check("13 100k-deep array malformed, not a crash", (3, "malformed:cap-depth") in codes(r), codes(r))

# 14 batch with one bad name: whole batch shapes nothing; batch with semantic no-op: rest applies
r = run("14-batch-partial", [GEN_LINE, ACT,
    st("batch", {"ops": [{"verb": "create", "id": "a"}, {"verb": "set", "id": "a", "comp": "BAD", "value": 1}]}),
    st("batch", {"ops": [{"verb": "create", "id": "b"}, {"verb": "set", "id": "ghost", "comp": "x", "value": 1},
                         {"verb": "set", "id": "b", "comp": "x", "value": 2}]})])
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

check("15 JCS key order by UTF-16 units", R.jcs({"\U0001f600": 1, "\ufb33": 2}) == '{"\U0001f600":1,"\ufb33":2}')

# 16 Python-specific: bool must not be a number; value True vs 1 differ
r = run("16-bool", [GEN_LINE, ACT, st("create", {"id": "a"}),
    st("set", {"id": "a", "comp": "t", "value": True}), st("set", {"id": "a", "comp": "o", "value": 1})])
check("16 true and 1 stay distinct", R.jcs(r.view()["a"]) == '{"o":{"v":1},"t":{"v":true}}', R.jcs(r.view()))

# 19 genesis shape (PROTOCOL §2.4, §3d C1/H5/H6). A malformed genesis means "no world"; an unknown minor
# means "unknown version" (L1), checked before the shape so a later minor may add fields.
def gen_with(**kw):
    b = dict(GBODY)
    for k, v in kw.items():
        if v is _DEL: b.pop(k, None)
        else: b[k] = v
    return json.dumps({"kind": "genesis", "actor": "system", "verb": "genesis", "body": b})
_DEL = object()
def wid_of(line):
    return "sha256:" + hashlib.sha256(R.jcs(R.parse_ijson(line.encode())).encode()).hexdigest()
def gen_log(name, gline):
    w = wid_of(gline)
    return run(name, [gline, json.dumps({"world": w, "kind": "act", "ts": 1, "actor": "alice", "verb": "spawn", "body": {}}),
                      json.dumps({"world": w, "kind": "change", "ts": 1, "actor": "system", "cause": 1, "verb": "create", "body": {"id": "a"}})])
SMALL_NEG = "ed25519:" + "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIA"  # same y, sign bit set ("-0")
import base64 as _b
_b64 = lambda raw: _b.urlsafe_b64encode(raw).rstrip(b"=").decode()
BIG_Y = "ed25519:" + _b64((2**255 - 19 + 1).to_bytes(32, "little"))     # y >= p
bad19 = {
    "19a-genesis-no-nonce": (gen_with(nonce=_DEL), "no-world", "malformed:genesis-nonce"),
    "19b-genesis-short-nonce": (gen_with(nonce=_b64(b"\x01" * 15)), "no-world", "malformed:genesis-nonce"),
    "19c-genesis-nonce-not-b64url": (gen_with(nonce="XWVu1u7BpaZTDFSETYiphg=="), "no-world", "malformed:genesis-nonce"),
    "19d-genesis-no-minor": (gen_with(minor=_DEL), "no-world", "malformed:genesis-minor"),
    "19e-genesis-minor-1": (gen_with(minor=1, future=True), "unknown-version", "unknown-minor"),
    "19f-genesis-flat-owners": (gen_with(owners=[K_OWNER]), "no-world", "malformed:genesis-owners"),
    "19g-genesis-small-order-key": (gen_with(owners=[[SMALL_NEG]]), "no-world", "malformed:genesis-key"),
    "19h-genesis-key-y-ge-p": (gen_with(sequencer=BIG_Y), "no-world", "malformed:genesis-key"),
    "19i-genesis-no-sequencer": (gen_with(sequencer=_DEL), "no-world", "malformed:genesis-sequencer"),
    "19j-genesis-unknown-field": (gen_with(rewind_n=5), "no-world", "malformed:genesis-field"),
    "19k-genesis-key-twice": (gen_with(owners=[[K_OWNER], [K_OWNER]]), "no-world", "malformed:genesis-owners"),
    "19l-genesis-bad-quorum": (gen_with(quorum=[0]), "no-world", "malformed:genesis-quorum"),
    "19m-genesis-bad-window": (gen_with(rewind_window=-1), "no-world", "malformed:genesis-window"),
    "19n-genesis-bad-parent": (gen_with(parent={"world": "sha256:00", "seq": 3, "head": "00" * 32}), "no-world", "malformed:genesis-parent"),
}
for nm, (gl, want, code) in bad19.items():
    r = gen_log(nm, gl)
    check("19 %s -> %s (%s)" % (nm, want, code), r.status == want and r.world is None and (0, code) in codes(r), (r.status, codes(r)))
r = gen_log("19o-genesis-full", gen_with(owners=[[], [K_TIER1, K_OWNER]], quorum=[1, 2], rewind_window=500,
                                         parent={"world": "sha256:" + "ab" * 32, "seq": 12, "head": "cd" * 32}))
check("19o full genesis (empty tier 0, quorum, window, parent) folds", r.status == "ok" and "a" in r.view() and not r.diag, codes(r))
g1, g2 = gen_with(), gen_with(nonce=NONCE2)
check("19p same keys, different nonce -> different world ids (C1)", wid_of(g1) != wid_of(g2) and R.parse_ijson(g1.encode())["body"]["owners"] == R.parse_ijson(g2.encode())["body"]["owners"])

# 20 purge never targets roles: (PROTOCOL §3d M11): diagnosed and ignored; other targets in the same purge still apply
r = run("20-purge-roles", [GEN_LINE, ACT,
    st("batch", {"ops": [{"verb": "set", "id": "@world", "comp": "roles:alice", "value": {"role": "owner"}},
                         {"verb": "set", "id": "@world", "comp": "note", "value": "a phone number"}]}),          # 2
    st("set", {"id": "@world", "comp": "roles:bob", "value": {"role": "builder"}}),                               # 3
    json.dumps({"world": WID, "kind": "purge", "actor": "system", "verb": "purge",
                "body": {"values": [{"seq": 2, "op": 0}, {"seq": 2, "op": 1}, {"seq": 3}]}})])                    # 4
check("20 purge of roles: ignored (diagnosed), the note purged",
      r.view()["@world"] == {"roles:alice": {"v": {"role": "owner"}}, "note": {"purged": True}, "roles:bob": {"v": {"role": "builder"}}}
      and [c for s_, c in codes(r)].count("purge-target-governance") == 2, (r.view(), codes(r)))

fails = 0
for n, ok, info in results:
    print(("PASS " if ok else "FAIL ") + n + ("" if ok else "   -> %s" % (info,)))
    fails += not ok
print("%d/%d passed" % (len(results) - fails, len(results)))
print("baseline digest", BASE)
sys.exit(1 if fails else 0)
