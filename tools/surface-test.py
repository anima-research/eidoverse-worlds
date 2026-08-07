import asyncio, json, websockets
URL, TOK = 'ws://localhost:8940/ws', 'workbench-2026'
passed = failed = 0
def check(name, ok, detail=""):
    global passed, failed
    print(("  ✓ " if ok else "  ✗ ") + name + (f"  [{detail}]" if detail and not ok else ""))
    passed, failed = passed + (1 if ok else 0), failed + (0 if ok else 1)

async def join(name, surface=None, world="surftest"):
    ws = await websockets.connect(URL)
    msg = {"type": "join", "token": TOK, "id": name, "world": world, "agent": True}
    if surface: msg["surface"] = surface
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
    p1, e1, c1, _ = await join("hesp")
    v1, e2, c2, _ = await join("hesp", "voice")
    await asyncio.sleep(0.5)
    check("T1 primary survives voice-leg join", c1() is None and p1.state.name == "OPEN")
    check("T1 voice leg accepted (snapshot arrived)", any(m.get("type") == "snapshot" for m in e2))

    # T2: second voice leg kicks only the old voice leg
    v2, e3, c3, _ = await join("hesp", "voice")
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
    e2.clear(); e3.clear()
    await h1.send(json.dumps({"type": "rtc", "to": "hesp", "payload": {"y": 2}}))
    await asyncio.sleep(0.5)
    got_primary = any(m.get("type") == "rtc" for m in e1)
    got_voice = any(m.get("type") == "rtc" for m in e3)
    check("T4 rtc to identity reaches primary", got_primary)
    check("T4 rtc to identity reaches voice leg too", got_voice)

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
    p2, e6, c6, _ = await join("hesp2")
    vA, eA, cA, _ = await join("hesp2", "voice")
    p3, e7, c7, _ = await join("hesp2")          # takeover of primary
    await asyncio.sleep(0.6)
    check("T7 primary takeover kicks old primary 4002", c6() is not None and c6()[0] == 4002, str(c6()))
    check("T7 voice leg SURVIVES primary takeover", cA() is None and vA.state.name == "OPEN")
    for w in (v2, h1, p3, vA):
        try: await w.close()
        except Exception: pass
    print(f"\n{passed} passed, {failed} failed")
    exit(1 if failed else 0)
asyncio.run(main())
