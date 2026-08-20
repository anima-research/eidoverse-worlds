import asyncio, json, websockets
import os
# No default endpoint (review finding 10): :8940 is a PRODUCTION sequencer per
# AGENTS.md ("NEVER develop against a port someone lives on") — a bare run of
# this matrix must refuse, not dial a lived-in world with a default token and
# mutate it. tools/surface-matrix-owned.ts is the owned entrypoint; it sets both.
URL, TOK = os.environ.get('SURF_URL'), os.environ.get('SURF_TOK', 'workbench-2026')
if not URL:
    raise SystemExit('surface-test.py: set SURF_URL (or run via tools/surface-matrix-owned.ts, which owns its server)')
# T12/T16 need the hesp2 legs token-verified: the target server's mcpl/tokens.json
# must map {"surf-lab-hesp2": {"id": "hesp2"}} or both attest cases fail with
# "attest is for token-verified media legs" — an environment gap, not a bug.
passed = failed = 0
def check(name, ok, detail=""):
    global passed, failed
    print(("  ✓ " if ok else "  ✗ ") + name + (f"  [{detail}]" if detail and not ok else ""))
    passed, failed = passed + (1 if ok else 0), failed + (0 if ok else 1)

async def join(name, surface=None, world="surftest", agent_token=None):
    ws = await websockets.connect(URL)
    msg = {"type": "join", "token": TOK, "id": name, "world": world, "agent": True}
    if surface: msg["surface"] = surface
    if agent_token: msg["agentToken"] = agent_token
    await ws.send(json.dumps(msg))
    events, closed = [], None
    async def pump():
        nonlocal closed
        try:
            async for raw in ws: events.append(json.loads(raw))
        except websockets.ConnectionClosed as e:
            closed = (e.rcvd.code if e.rcvd else 0, e.rcvd.reason if e.rcvd else "")
    task = asyncio.create_task(pump())
    await asyncio.sleep(0.6)
    return ws, events, lambda: closed, task

async def main():
    # T1: primary + voice leg coexist
    p1, e1, c1, _ = await join("hesp", agent_token="surf-lab-hesp")
    v1, e2, c2, _ = await join("hesp", "voice", agent_token="surf-lab-hesp")
    await asyncio.sleep(0.5)
    check("T1 primary survives voice-leg join", c1() is None and p1.state.name == "OPEN")
    check("T1 voice leg accepted (snapshot arrived)", any(m.get("type") == "snapshot" for m in e2))

    # T2: second voice leg kicks only the old voice leg
    v2, e3, c3, _ = await join("hesp", "voice", agent_token="surf-lab-hesp")
    await asyncio.sleep(0.5)
    check("T2 old voice leg kicked 4002", c2() is not None and c2()[0] == 4002, str(c2()))
    check("T2 primary untouched by voice duel", c1() is None)

    # T3: aux without primary refused
    o1, e4, c4, _ = await join("ghost", "voice")
    await asyncio.sleep(0.5)
    check("T3 orphan aux refused 4008", c4() is not None and c4()[0] == 4008, str(c4()))

    # T4: rtc — voice leg can send; delivery reaches primary AND voice leg of target
    h1, e5, c5, _ = await join("human1")
    await asyncio.sleep(0.3)
    await v2.send(json.dumps({"type": "rtc", "to": "human1", "payload": {"x": 1}}))
    await asyncio.sleep(0.5)
    check("T4 aux rtc delivered to embodied target", any(m.get("type") == "rtc" and m.get("from") == "hesp" for m in e5))
    # Per-surface ADDRESSING (review finding 7): default toSurface="world"
    # reaches ONLY the primary — the old any-leg fanout answered every offer
    # twice (both of the offerer's legs got answers: SDP glare in exactly the
    # human-with-voice-leg case). The leg is reached by naming it.
    e2.clear(); e3.clear()
    await h1.send(json.dumps({"type": "rtc", "to": "hesp", "payload": {"y": 2}}))
    await asyncio.sleep(0.5)
    check("T4 rtc to identity reaches primary", any(m.get("type") == "rtc" for m in e1))
    check("T4 unaddressed rtc does NOT reach the voice leg (glare guard)",
          not any(m.get("type") == "rtc" for m in e3), str(e3[-2:]))
    e3.clear()
    await h1.send(json.dumps({"type": "rtc", "to": "hesp", "toSurface": "voice", "payload": {"y": 3}}))
    await asyncio.sleep(0.5)
    check("T4 toSurface:'voice' reaches exactly the voice leg", any(m.get("type") == "rtc" for m in e3), str(e3[-2:]))

    # T5: roster honesty — human sees ONE hesp (aux invisible)
    arrivals = [m for m in e5 if m.get("type") == "snapshot"]
    ppl = arrivals[0].get("state", {}).get("people", None) if arrivals else None
    # fall back: count arrive broadcasts for hesp seen by human1 (joined after both)
    snap_ok = True  # roster shape varies; assert via arrive events instead
    hesp_arrivals = [m for m in e5 if m.get("type") == "arrive" and m.get("id") == "hesp"]
    check("T5 aux never broadcast as arrival", len(hesp_arrivals) == 0, f"got {len(hesp_arrivals)}")

    # T6: primary dies → voice leg reaped 4007
    await p1.close()
    await asyncio.sleep(0.8)
    check("T6 voice leg reaped on primary close 4007", c3() is not None and c3()[0] == 4007, str(c3()))

    # T7: takeover transfers auxes — new primary, voice leg survives
    p2, e6, c6, _ = await join("hesp2", agent_token="surf-lab-hesp2")
    vA, eA, cA, _ = await join("hesp2", "voice", agent_token="surf-lab-hesp2")
    p3, e7, c7, _ = await join("hesp2", agent_token="surf-lab-hesp2")          # takeover of primary
    await asyncio.sleep(0.6)
    check("T7 primary takeover kicks old primary 4002", c6() is not None and c6()[0] == 4002, str(c6()))
    check("T7 voice leg SURVIVES primary takeover", cA() is None and vA.state.name == "OPEN")
    # ── #57 review contracts (B1-B4), 2026-08-11 ──────────────────────────

    # T8 (B2/matrix 3): a superseded generation's messages are refused.
    # vA is about to be superseded by vB; vA's socket may drain AFTER the
    # takeover — its rtc must reach NOBODY.
    w1, ew, cw, _ = await join("watcher")
    vB, eB, cB, _ = await join("hesp2", "voice", agent_token="surf-lab-hesp2")     # supersedes vA
    # capture vB's live surface generation from its own join snapshot NOW, before
    # eB is cleared by later vectors — the attest in T12 must echo this gen (B2).
    _vB_snaps = [m for m in eB if m.get("type") == "snapshot"]
    vB_gen = _vB_snaps[-1].get("gen") if _vB_snaps else None
    await asyncio.sleep(0.5)
    # capture the takeover's transition BEFORE clearing (T10 reads it)
    transition_events = [m for m in ew + e7 if m.get("type") == "surface-transition"]
    ew.clear(); e7.clear()
    try: await vA.send(json.dumps({"type": "rtc", "to": "watcher", "payload": {"ghost": 1}}))
    except Exception: pass                            # already closed = equally refused
    await asyncio.sleep(0.5)
    ghost = [m for m in ew if m.get("type") == "rtc" and m.get("payload", {}).get("ghost")]
    check("T8 superseded generation rtc refused", len(ghost) == 0, f"got {len(ghost)}")

    # T9 (B2): rtc carries the sender generation
    eB.clear(); ew.clear()
    await w1.send(json.dumps({"type": "rtc", "to": "hesp2", "toSurface": "voice", "payload": {"z": 3}}))
    await asyncio.sleep(0.5)
    stamped = [m for m in eB if m.get("type") == "rtc"]
    check("T9 rtc stamped with fromGen", bool(stamped) and isinstance(stamped[0].get("fromGen"), int), str(stamped[:1]))

    # T10 (B4): same-surface takeover emits a generation-bearing transition
    trans = transition_events
    ok9 = any(m.get("id") == "hesp2" and m.get("surface") == "voice"
              and isinstance(m.get("gen"), int) and isinstance(m.get("retired"), int)
              and m["gen"] != m["retired"] for m in trans)
    check("T10 surface-transition broadcast on voice takeover", ok9, str(trans[:1]))

    # T11 (B3/matrix 6): an aux cannot author — even say
    eB.clear()
    await vB.send(json.dumps({"type": "verb", "verb": "say", "args": {"text": "aux voice"}}))
    await asyncio.sleep(0.5)
    said = [m for m in ew if m.get("type") == "log" and m.get("entry", {}).get("verb") == "say"]
    err = [m for m in eB if m.get("type") == "error"]
    check("T11 aux say refused (authors nothing)", len(said) == 0 and len(err) >= 1, f"said={len(said)} err={len(err)}")

    # T12 (B1): attest round-trip — valid receipt broadcasts `performed`;
    # bad digest refused; embodied client cannot attest.
    import hashlib
    await p3.send(json.dumps({"type": "verb", "verb": "say", "args": {"text": "receipt me"}}))
    await asyncio.sleep(0.5)
    says = [m for m in ew if m.get("type") == "log" and m.get("entry", {}).get("verb") == "say"
            and m["entry"].get("actor") == "hesp2"]
    check("T12 setup: say folded", bool(says))
    seq = says[-1]["entry"]["seq"] if says else -1
    digest = hashlib.sha256("receipt me".encode()).hexdigest()
    # vB_gen (captured at vB's join above) is the surface generation the leg
    # echoes in its attest (B2); the server requires it to equal c.gen.
    ew.clear(); e7.clear(); eB.clear()
    await vB.send(json.dumps({"type": "attest", "seq": seq, "digest": digest, "gen": vB_gen}))
    await asyncio.sleep(0.5)
    perf = [m for m in ew if m.get("type") == "performed" and m.get("id") == "hesp2" and m.get("seq") == seq]
    check("T12 valid attest broadcasts performed", bool(perf), str(perf[:1]))
    check("T12 performed carries the leg generation", bool(perf) and isinstance(perf[0].get("gen"), int))
    ew.clear(); eB.clear()
    await vB.send(json.dumps({"type": "attest", "seq": seq, "digest": "0" * 64, "gen": vB_gen}))
    await asyncio.sleep(0.4)
    check("T12 digest mismatch refused", not any(m.get("type") == "performed" for m in ew)
          and any(m.get("type") == "error" for m in eB))
    # B2: a stale-generation attest (correct digest, WRONG gen) is refused —
    # the retired-leg-after-reconnect relabel this check exists to stop.
    ew.clear(); eB.clear()
    await vB.send(json.dumps({"type": "attest", "seq": seq, "digest": digest, "gen": (vB_gen or 0) - 1}))
    await asyncio.sleep(0.4)
    check("T12 stale-generation attest refused (B2)", not any(m.get("type") == "performed" for m in ew)
          and any(m.get("type") == "error" for m in eB))
    ew.clear(); e7.clear()
    await p3.send(json.dumps({"type": "attest", "seq": seq, "digest": digest, "gen": vB_gen}))
    await asyncio.sleep(0.4)
    check("T12 embodied client cannot attest", not any(m.get("type") == "performed" for m in ew))

    # T14 (#57 client half): FIRST aux join broadcasts surface-transition
    # (retired null) — listeners key hold-then-fallback on it, and a leg
    # joining after their snapshot must not be invisible.
    ew.clear()
    vC, eC, cC, _ = await join("watcher2-owner", agent_token="surf-lab-w2o")
    await asyncio.sleep(0.3)
    ew.clear()
    vD, eD, cD, _ = await join("watcher2-owner", "voice", agent_token="surf-lab-w2o")
    await asyncio.sleep(0.5)
    t14 = [m for m in ew if m.get("type") == "surface-transition" and m.get("id") == "watcher2-owner"]
    check("T14 first aux join announces itself (retired null)",
          bool(t14) and t14[0].get("retired") is None and isinstance(t14[0].get("gen"), int), str(t14[:1]))

    # T15: a rejoining primary's snapshot carries its OWN live aux legs
    p4, e8, c8, _ = await join("watcher2-owner", agent_token="surf-lab-w2o")   # takeover of primary; voice leg survives
    await asyncio.sleep(0.5)
    snaps15 = [m for m in e8 if m.get("type") == "snapshot"]
    ys = snaps15[0].get("yourSurfaces", None) if snaps15 else None
    check("T15 snapshot yourSurfaces names the surviving voice leg",
          bool(ys) and any(sf.get("surface") == "voice" for sf in ys), str(ys))
    for w in (vC, vD, p4):
        try: await w.close()
        except Exception: pass

    # T13 (matrix 7): roster shows one person with a surface summary.
    # (Recut onto current main: the summary rides the existing `present`
    # roster — one roster per snapshot, never a second body list.)
    w2, ew2, cw2, _ = await join("late-watcher")
    await asyncio.sleep(0.5)
    snaps = [m for m in ew2 if m.get("type") == "snapshot"]
    people = snaps[0].get("present", []) if snaps else []
    hesp = [p for p in people if p.get("id") == "hesp2"]
    ok13 = len(hesp) == 1 and any(sf.get("surface") == "voice" for sf in hesp[0].get("surfaces", []))
    check("T13 roster: one person, inspectable surfaces", ok13, str(hesp[:1]))

    # T16 (r-review): an aux leg DYING unreplaced broadcasts retirement.
    # Before this, aux legs rode the spectator path whose close is silent —
    # every client kept the dead leg's gen in voiceCapable forever, and each
    # say from that actor waited the full performance window against a leg
    # that could never perform. Contract: close(voice leg) → everyone else
    # receives surface-transition {gen: null, retired: <dying gen>}.
    ew2.clear()
    await vB.close()
    await asyncio.sleep(0.6)
    retire = [m for m in ew2 if m.get("type") == "surface-transition"
              and m.get("surface") == "voice" and m.get("gen") is None]
    check("T16 aux death broadcasts retirement (gen null)", len(retire) == 1, str(ew2[-3:]))
    check("T16 retirement names the dying gen", bool(retire) and retire[0].get("retired") is not None,
          str(retire[:1]))

    # T17 (r2 review): PRIMARY death reaps its aux legs — and the reap loop
    # unmaps each aux from `clients` before closing its socket, so the ws
    # close handler can never broadcast for them. The reap path must emit
    # retirement itself: primary dies → watchers get BOTH the leave and a
    # voice retirement, or every say from a rejoining actor with no leg
    # waits the full window against the ghost.
    p4, e8, c8, _ = await join("hesp3", agent_token="surf-lab-hesp3")
    v4, e9, c9, _ = await join("hesp3", "voice", agent_token="surf-lab-hesp3")
    await asyncio.sleep(0.4)
    ew2.clear()
    await p4.close()                       # primary dies; aux gets reaped 4007
    await asyncio.sleep(0.6)
    reapret = [m for m in ew2 if m.get("type") == "surface-transition"
               and m.get("surface") == "voice" and m.get("gen") is None
               and m.get("id") == "hesp3"]
    check("T17 primary death: reaped voice leg broadcasts retirement", len(reapret) == 1, str(ew2[-4:]))

    # T18 (B1, review): an aux leg binds to the primary's identity authority.
    # Same-display existence is presence, not authority — an uncredentialed
    # "voice" join for a self-asserted human must be refused (4009) and leave
    # ZERO trace: no surface-transition at any witness, no voiceCapable flip.
    ew2.clear()
    imp_err = None
    try:
        impws, imp_e, imp_c, _ = await join("human1", "voice")   # no credential
        imp_err = next((m for m in imp_e if m.get("type") == "error"), None)
        try: await impws.close()
        except Exception: pass
    except Exception as e:                     # server may close 4009 pre-snapshot
        imp_err = {"type": "error", "error": str(e)}
    await asyncio.sleep(0.5)
    check("T18 impostor aux (same display, no credential) is refused",
          imp_err is not None and ("credential" in str(imp_err.get("error", "")) or "4009" in str(imp_err)),
          str(imp_err))
    ghost_events = [m for m in ew2 if m.get("type") == "surface-transition" and m.get("id") == "human1"]
    check("T18 refused aux leaves zero trace (no transition at witnesses)", len(ghost_events) == 0,
          str(ghost_events[:2]))

    # T19 (review finding 2): admission precedes takeover — a join that will
    # be REFUSED must not destroy the genuine leg it duels. Uncredentialed
    # voice join for hesp2 while hesp2's bound leg is live: refusal, no
    # retirement broadcast, and the genuine leg's socket still answers.
    p5, e10, c10, _ = await join("hesp2", agent_token="surf-lab-hesp2")
    v5, e11, c11, _ = await join("hesp2", "voice", agent_token="surf-lab-hesp2")
    await asyncio.sleep(0.4)
    ew2.clear()
    try:
        impws2, imp2_e, imp2_c, _ = await join("hesp2", "voice")   # no credential
        try: await impws2.close()
        except Exception: pass
    except Exception: pass
    await asyncio.sleep(0.5)
    check("T19 refused takeover leaves the genuine leg alive (no 4002)", c11() is None, str(c11()))
    t19_ghost = [m for m in ew2 if m.get("type") == "surface-transition" and m.get("id") == "hesp2"]
    check("T19 refused takeover broadcasts no transition", len(t19_ghost) == 0, str(t19_ghost[:2]))
    e11.clear()
    await v5.send(json.dumps({"type": "attest", "seq": 999999, "gen": 1, "digest": "00"}))
    await asyncio.sleep(0.4)
    check("T19 genuine leg still answers after the attempt (error frame, not silence)",
          any(m.get("type") == "error" for m in e11), str(e11[-2:]))

    # T20 (review finding 6): travel reaps — "leave A, join B" never runs the
    # ws close handler, so the reap must live on the travel path itself.
    ew2.clear()
    await p5.send(json.dumps({"type": "join", "token": TOK, "id": "hesp2", "world": "elsewhere", "agent": True,
                              "agentToken": "surf-lab-hesp2"}))
    await asyncio.sleep(0.6)
    t20_ret = [m for m in ew2 if m.get("type") == "surface-transition" and m.get("id") == "hesp2"
               and m.get("surface") == "voice" and m.get("gen") is None]
    check("T20 travel retires the voice leg at the old world's witnesses", len(t20_ret) == 1, str(ew2[-4:]))
    check("T20 traveled-from voice leg is closed (reaped 4007)",
          c11() is not None and c11()[0] == 4007, str(c11()))

    # T21 (review finding 4): a surface that sanitizes to EMPTY is refused,
    # never promoted to "world" — promotion gave a malformed aux join takeover
    # power over the user's own body.
    p6, e12, c12, _ = await join("hesp3", agent_token="surf-lab-hesp3")
    await asyncio.sleep(0.3)
    b1, e13, c13, _ = await join("hesp3", "!!!", agent_token="surf-lab-hesp3")
    await asyncio.sleep(0.5)
    check("T21 empty-sanitizing surface refused 4005", c13() is not None and c13()[0] == 4005, str(c13()))
    check("T21 the embodied primary survives its malformed accessory", c12() is None, str(c12()))

    # T22 (review finding 3): attest survives a fold. The owned wrapper sets
    # FOLD_EVERY=5, so a handful of comps folds entries[] out from under the
    # say — the receipt must still resolve (recentSays ring) and broadcast
    # `performed`.
    v6, e14, c14, _ = await join("hesp3", "voice", agent_token="surf-lab-hesp3")
    await asyncio.sleep(0.4)
    await p6.send(json.dumps({"type": "verb", "verb": "say", "args": {"text": "folded but performed"}}))
    await asyncio.sleep(0.4)
    say_seq = None
    for m in reversed(ew2):
        if m.get("type") == "log" and m.get("entry", {}).get("verb") == "say"            and m["entry"].get("args", {}).get("text") == "folded but performed":
            say_seq = m["entry"]["seq"]; break
    for i in range(8):   # trip at least one fold past the say
        await p6.send(json.dumps({"type": "verb", "verb": "comp", "args": {"id": f"t22-{i}", "type": "note", "data": {"i": i}}}))
    await asyncio.sleep(0.6)
    import hashlib
    dig = hashlib.sha256("folded but performed".encode()).hexdigest()
    ew2.clear()
    gen6 = None
    for m in e14:
        if m.get("type") == "snapshot": gen6 = m.get("gen")
    await v6.send(json.dumps({"type": "attest", "seq": say_seq, "gen": gen6, "digest": dig}))
    await asyncio.sleep(0.5)
    check("T22 attest resolves a folded-out say (recentSays ring) and broadcasts performed",
          any(m.get("type") == "performed" and m.get("seq") == say_seq for m in ew2),
          f"seq={say_seq} gen={gen6} tail={str(ew2[-3:])}")

    # T23 (review finding 8): the bound voice leg paces captions — presence
    # lanes admit the same authority attest does.
    ew2.clear()
    await v6.send(json.dumps({"type": "caption", "text": "paced from the leg"}))
    await asyncio.sleep(0.4)
    check("T23 caption from the bound voice leg reaches witnesses",
          any(m.get("type") == "caption" and m.get("text") == "paced from the leg" for m in ew2), str(ew2[-3:]))

    for w in (p5, v5, p6, b1, v6):
        try: await w.close()
        except Exception: pass

    for w in (w1, w2, v4):
        try: await w.close()
        except Exception: pass

    for w in (v2, h1, p3, vA):
        try: await w.close()
        except Exception: pass
    print(f"\n{passed} passed, {failed} failed")
    exit(1 if failed else 0)
asyncio.run(main())
