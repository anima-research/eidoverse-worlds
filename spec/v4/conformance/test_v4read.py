#!/usr/bin/env python3
"""Hostile-log suite for v4read.py. Writes each log to logs/ and checks it."""
import hashlib, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v4read as R

HERE = os.path.dirname(os.path.abspath(__file__))
LOGS = os.path.join(HERE, "logs")
os.makedirs(LOGS, exist_ok=True)

GEN = {"kind": "genesis", "actor": "door", "verb": "genesis",
       "body": {"version": 4, "owners": ["k-owner"]}}
GEN_LINE = json.dumps(GEN)
WID = "sha256:" + hashlib.sha256(R.jcs(R.parse_ijson(GEN_LINE.encode())).encode()).hexdigest()


def st(verb, body, cause=1, **kw):
    e = {"world": WID, "kind": "state", "ts": 1, "actor": "door", "cause": cause,
         "verb": verb, "body": body}
    e.update(kw)
    return json.dumps(e)


ACT = json.dumps({"world": WID, "kind": "act", "ts": 1, "actor": "alice", "verb": "spawn", "body": {}})


def _with_ts(line):
    # every entry after genesis carries ts (PROTOCOL-v4 2.1); fixtures predate it, so add ts:1 unless present
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
    '{"body":{"value":{"c":"#fff","i":25e-1},"comp":"light","id":"lamp-1"},"verb":"set","cause":1.0,"ts":1e0,"actor":"door","kind":"state","world":"%s"}' % WID,
    st("batch", {"ops": [{"verb": "create", "id": "chair"},
                         {"verb": "set", "id": "chair", "comp": "example.com/seat@2", "value": [1.0, 2e0]},
                         {"verb": "set", "id": "@world", "comp": "roles:alice", "value": "own\u0065r"}]})])
check("02 spelling-invariant digest", r2.digest() == BASE, r2.diag)

# 3 duplicate keys (top-level and nested, and escaped-equal)
r = run("03-dupkeys", [GEN_LINE, ACT,
    st("create", {"id": "a"}),
    '{"world":"%s","kind":"state","actor":"door","cause":1,"verb":"set","body":{"id":"a","comp":"x","value":1},"verb":"delete"}' % WID,
    '{"world":"%s","kind":"state","actor":"door","cause":1,"verb":"set","body":{"id":"a","comp":"x","value":{"k":1,"\\u006b":2}}}' % WID])
check("03 dup keys malformed, shape nothing", codes(r) == [(3, "malformed:ijson-dupkey"), (4, "malformed:ijson-dupkey")]
      and r.view() == {"@world": {}, "a": {}}, codes(r))

# 4 -0, NaN, Infinity, 1e400, -1e-400, huge int
bad = ["-0", "-0.0", "-0e3", "NaN", "Infinity", "-Infinity", "1e400", "-1e-400", "1" + "0" * 400]
lines = [GEN_LINE, ACT, st("create", {"id": "a"})]
for b in bad:
    lines.append('{"world":"%s","kind":"state","actor":"door","cause":1,"verb":"set","body":{"id":"a","comp":"x","value":%s}}' % (WID, b))
lines.append(st("set", {"id": "a", "comp": "y", "value": 0}))
lines.append('{"world":"%s","kind":"state","actor":"door","cause":1,"verb":"set","body":{"id":"a","comp":"z","value":9007199254740993}}' % WID)
r = run("04-numbers", lines)
mal = [c for s, c in codes(r) if c.startswith("malformed")]
check("04 all nine bad numbers + 2^53+1 malformed (PROTOCOL-v4 L1: big ints refused, not rounded)",
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

# 7 unknown / wrong-typed version
for nm, v in [("07a-version-5", 5), ("07b-version-str", "4"), ("07c-version-missing", None), ("07d-version-4.0", 4.0)]:
    g = dict(GEN); g["body"] = {"owners": []} if v is None else {"version": v}
    r = run(nm, [json.dumps(g), ACT])
    want = "ok" if nm == "07d-version-4.0" else "unknown-version"
    check("07 version %r -> %s" % (v, want), r.status == want and (want == "ok" or r.world is None), r.status)

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
    json.dumps({"world": WID, "kind": "purge", "actor": "door", "verb": "purge",
                "body": {"values": [{"seq": 3}, {"seq": 4, "op": 1}, {"seq": 5}, {"seq": 6}, {"seq": 2}]}}),  # 8
    json.dumps({"world": WID, "kind": "purge", "actor": "door", "verb": "purge",
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
    json.dumps({"world": WID, "kind": "state", "actor": "door", "verb": "create", "body": {"id": "c"}}),
    st("create", {"id": "d"}, cause=99),
    json.dumps({"world": WID, "kind": "teleport", "actor": "door", "verb": "x", "body": {}}),
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
data += b'{"ts":1,"world":"' + WID.encode() + b'","kind":"state","actor":"\xff","cause":1,"verb":"create","body":{"id":"b"}}\n'
data += ('{"ts":1,"world":"%s","kind":"state","actor":"door","cause":1,"verb":"set","body":{"id":"a","comp":"s","value":"\\ud800"}}\n' % WID).encode()
data += ('{"ts":1,"world":"%s","kind":"state","actor":"door","cause":1,"verb":"set","body":{"id":"a","comp":"s","value":"\\ufdd0"}}\n' % WID).encode()
r = run("12c-strings", None, raw=data)
check("12c bad utf-8 / lone surrogate / noncharacter malformed",
      [c for s, c in codes(r)] == ["malformed:ijson-utf8", "malformed:ijson-surrogate", "malformed:ijson-noncharacter"], codes(r))

# 13 depth cap and deep nesting that would blow a recursive parser
r = run("13-depth", [GEN_LINE, ACT, st("create", {"id": "a"}),
    '{"world":"%s","kind":"state","actor":"door","cause":1,"verb":"set","body":{"id":"a","comp":"d","value":%s}}' % (WID, "[" * 100000 + "]" * 100000)])
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

fails = 0
for n, ok, info in results:
    print(("PASS " if ok else "FAIL ") + n + ("" if ok else "   -> %s" % (info,)))
    fails += not ok
print("%d/%d passed" % (len(results) - fails, len(results)))
print("baseline digest", BASE)
sys.exit(1 if fails else 0)
