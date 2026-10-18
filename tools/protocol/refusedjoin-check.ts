// tools/protocol/refusedjoin-check.ts — a join the server refuses (close 4005) is SHOWN in the browser, in the server's words.
// R 10-16 00:02: ?world=old-commons&name=Rab opened an empty world with her avatar on the grid and the normal hint bar —
// no message — though the server had refused the join in 13 ms with the old-format sentence and close 4005. The page
// lost it: the inline boot script's early socket caught the refusal, and connect() threw that socket away (and with it
// the refusal) and dialled again.
// One headless Chromium against a scratch sequencer (tools/harness.ts scratchBench) whose worlds dir holds:
//   old-x   a first-protocol log.jsonl (an old-format world: the server answers with the "translate" visitor sentence)
//   (nope)  nothing at all (no such world)
// For each world, by both boot paths (the early socket, and ?earlysock=0's fresh connect):
//   W1 the server's own sentence is on screen, and still there 6 s later (not a 4-second toast)
//   W2 the bad-LINK wording ("is not a valid world name") is not shown — the name is fine
//   W3 the client knows it is refused (net.status 'rejected') and never says it joined (net.joined false)
//   W4 it didn't redial: one join reached the server for this page load
//   W5 (old-x, early socket) still there after the splash's 45 s ceiling, and no "go in anyway" into an empty world
// and, on a world that exists (here, founded by keeper):
//   W6 an early socket whose join was NOT the page's (it asked for "nope") is refused: that refusal is not the page's
//      answer — the page connects fresh and joins (review r3 F6: "the early socket is never an authority")
//   W7 a FULL world (access max) is a transient refusal: the words are shown but the splash isn't pinned, and the page
//      gets in by itself once there is room (review r3 F6)
//   W8 while it stays full, the redials back off (each wait longer than the last), not every 5 s in step (review r4 F5)
//   W9 an agent (mcpl/agent.ts) dialling a full world waits and dials again too, and gets in when a seat frees (r4 C2)
// Run under the house guards: code/scripts/eido-probe.sh -C <worktree> -t 300 tools/protocol/refusedjoin-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, mkCheck, sleep } from "../harness.ts";

process.env.AGENT_BODY_ENGINE = "verlet";
// any first-protocol log will do (a v1 world is recognised by its genesis line): the repo's own fixture unless V1_LOG names one
const V1 = process.env.V1_LOG ?? path.resolve(import.meta.dir, "../../spec/fixtures/01-build/log.jsonl");
const { evalJson, cdp, cleanup, die, BASE, SCRATCH } = await scratchBench("refusedjoin", { worlds: ["here"], owner: "keeper", serverEnv: { TRUST_NAMES: "1" },
  prepare: (scratch) => {
    const d = path.join(scratch, "worlds", "old-x"); fs.mkdirSync(d, { recursive: true });
    // a first-protocol log, cut to its first lines (a v1 world is recognised by its genesis line)
    const lines = fs.readFileSync(V1, "utf8").split("\n").slice(0, 200).filter(Boolean);
    fs.writeFileSync(path.join(d, "log.jsonl"), lines.join("\n") + "\n");
  },
});
const { check: check0, tally } = mkCheck();
const check = (name: string, ok: any, detail?: any) => check0(name, !!ok, detail === undefined ? "" : typeof detail === "string" ? detail.slice(0, 500) : (JSON.stringify(detail) ?? "").slice(0, 500));

// what the server says to a joiner of each world (a plain socket: the source of truth for the words)
const serverSays = (world: string) => new Promise<{ error: string; code: number; reason: string }>((res) => {
  const ws = new WebSocket(BASE.replace("http", "ws") + "/ws"); let error = "";
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, id: "probe", avatar: "", replica: true }));
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "error") error = m.error; };
  ws.onclose = (ev) => res({ error, code: ev.code, reason: ev.reason });
});

try {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__joins = 0; { const send = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { try { if (JSON.parse(d)?.type === 'join') __joins++; } catch {} return send.call(this, d); }; }` });
  for (const world of ["old-x", "nope"]) {
    const said = await serverSays(world);
    check(`(setup) ${world}: the server refuses with words and 4005`, said.code === 4005 && said.error.length > 10, said);
    for (const early of [true, false]) {
      const tag = `${world} ${early ? "early socket" : "fresh connect"}`;
      await cdp.send("Page.navigate", { url: `${BASE}/?world=${world}&name=T${early ? "" : "&earlysock=0"}` });
      // on screen = in the page's text AND the topmost thing where it is drawn (a toast UNDER the splash is in the text
      // and invisible: that was the bug)
      const visible = `(() => { const want = ${JSON.stringify(said.error)};
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
        while ((n = w.nextNode())) { if (!n.textContent.includes(want)) continue; const host = n.parentElement; const r = host.getBoundingClientRect();
          if (r.width < 1 || r.height < 1 || getComputedStyle(host).visibility === 'hidden') continue;
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); if (top && (host === top || host.contains(top) || top.contains(host))) return true; }
        return false; })()`;
      let seen = false; const t0 = Date.now();
      while (!seen && Date.now() - t0 < 20000) { seen = !!(await evalJson(visible).catch(() => false)); if (!seen) await sleep(250); }
      await sleep(6000);
      const stays = !!(await evalJson(visible).catch(() => false));
      const st = await evalJson(`import('/lib/net.js').then((m) => ({ status: m.net.status, joined: m.net.joined, joins: window.__joins,
        toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.slice(0, 160)),
        badLink: /is not a valid world name/.test(document.body.innerText) }))`).catch((e) => ({ err: String(e) }));
      check(`W1 ${tag}: the server's sentence is on screen, and still there 6 s later`, seen && stays, { seen, stays, ...st });
      check(`W2 ${tag}: no "not a valid world name" (the link is fine)`, st.badLink === false, st);
      check(`W3 ${tag}: the client is refused (status 'rejected'), never joined`, st.status === "rejected" && st.joined === false, st);
      check(`W4 ${tag}: no redial (one join sent)`, st.joins === 1, st);
      if (world === "old-x" && early) {   // the splash's 45 s ceiling and its "go in anyway" never lift it onto an empty world
        const skip = await evalJson(`(() => { const b = document.querySelector('.sp-skip'); return !!b && getComputedStyle(b).display !== 'none' && getComputedStyle(b).pointerEvents !== 'none'; })()`).catch(() => null);
        while (Date.now() - t0 < 48000) await sleep(1000);
        const late = !!(await evalJson(visible).catch(() => false));
        check(`W5 ${tag}: still on screen past the splash's 45 s ceiling, with no "go in anyway"`, late && skip === false, { late, skipOffered: skip });
      }
    }
  }
  // W6: the early socket's join differs from the page's (here: it asked for "nope"); its refusal must not be the page's
  {
    const said = await serverSays("nope");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `if (/[?&]w6=1/.test(location.search)) {
      let first = true; const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (first && m?.type === 'join') { first = false; m.world = 'nope'; d = JSON.stringify(m); } } catch {} return send.call(this, d); };
      let held = null; Object.defineProperty(globalThis, '__ewEarlySocket', { configurable: true, get() { return held; }, set(v) { if (v && v.sent) v.sent.world = 'nope'; held = v; } }); }` });
    await cdp.send("Page.navigate", { url: `${BASE}/?world=here&name=T6&w6=1` });
    let st: any = null; const t0 = Date.now();
    while (Date.now() - t0 < 20000) { st = await evalJson(`import('/lib/net.js').then((m) => ({ status: m.net.status, joined: m.net.joined, joins: window.__joins, early: !!window.__ewEarlySocket || null,
      refusalShown: document.body.innerText.includes(${JSON.stringify(said.error)}) }))`).catch((e) => ({ err: String(e) })); if (st?.joined) break; await sleep(300); }
    check(`W6 here: an early refusal for a join the page didn't send ("nope") is discarded — the page connects fresh and joins`,
      st?.joined === true && st.joins === 2 && !st.refusalShown, st);
  }
  // W7: a full world is transient — not pinned, and the page gets in once there is room
  {
    const { WorldAgent } = await import("../../mcpl/agent.ts");
    const keeper: any = new WorldAgent({ name: "keeper", world: "here", url: BASE.replace("http", "ws") + "/ws" });
    await keeper.connect();
    const set: any = await keeper.request("set", { id: "@world", component: "access", value: { join: "anyone", max: 1 } });
    const full = await serverSays("here");
    check("(setup) here is full: max 1, and keeper is in", set?.ok !== false && full.code === 4005 && /is full/.test(full.error), { set: JSON.stringify(set).slice(0, 200), full });
    await cdp.send("Page.navigate", { url: `${BASE}/?world=here&name=T7` });
    const probe = `import('/lib/net.js').then((m) => ({ status: m.net.status, joined: m.net.joined, joins: window.__joins,
      shown: document.body.innerText.includes(${JSON.stringify(full.error)}) }))`;
    let st: any = null; const t0 = Date.now();
    while (Date.now() - t0 < 8000) { st = await evalJson(probe).catch((e) => ({ err: String(e) })); if (st?.shown) break; await sleep(250); }
    await sleep(1500);
    st = await evalJson(probe).catch((e) => ({ err: String(e) }));
    check("W7 here (full): the server's words are shown, and the page is not refused for good (it will try again)",
      st?.shown === true && st.status !== "rejected" && st.joined === false, st);
    try { keeper.close(); } catch { /* gone */ }
    const t1 = Date.now();
    while (Date.now() - t1 < 30000) { st = await evalJson(probe).catch((e) => ({ err: String(e) })); if (st?.joined) break; await sleep(500); }
    check("W7 ...and once there is room it gets in by itself, no reload", st?.joined === true && st.joins >= 2, { ...st, waited: Date.now() - t1 });
  }
  // W8 (review r4 F5): while it stays full, the page's redials back off — each wait longer than the last (exponential, with
  // jitter: the page's Math.random is pinned to 0.5 here so the schedule is exact), not a fixed 5 s for as long as it's full
  {
    await cdp.send("Page.navigate", { url: "about:blank" }); await sleep(1500);   // W7's page leaves: its seat is free for keeper
    const { WorldAgent } = await import("../../mcpl/agent.ts");
    const keeper: any = new WorldAgent({ name: "keeper", world: "here", url: BASE.replace("http", "ws") + "/ws" });
    await keeper.connect();
    const full = await serverSays("here");
    check("(W8 setup) here is full again", full.code === 4005 && /is full/.test(full.error), full);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `if (/[?&]w8=1/.test(location.search)) { Math.random = () => 0.5;
      window.__joinAt = []; const send = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { try { if (JSON.parse(d)?.type === 'join') __joinAt.push(performance.now()); } catch {} return send.call(this, d); }; }` });
    await cdp.send("Page.navigate", { url: `${BASE}/?world=here&name=T8&w8=1` });
    let at: number[] = []; const t0 = Date.now();
    while (Date.now() - t0 < 45000) { at = await evalJson(`window.__joinAt ?? []`).catch(() => []); if (at.length >= 4) break; await sleep(500); }
    const gaps = at.slice(1).map((t, i) => Math.round(t - at[i]));
    // the schedule the page must keep, from the shared rule itself at rand 0.5 (5000, 7500, 12500 ms today). Each observed gap
    // is at least its scheduled wait (a page redialling every 5 s fails the second); only lower bounds, because a gap also
    // holds the page's own work (the first one its boot), which a slower host stretches. The schedule itself must grow.
    const { redialer, REDIAL } = await import("../../shared/redial.js"); const R = redialer();
    const want = [0, 1, 2].map(() => R.next(REDIAL.full, () => 0.5));
    check("W8 here (stays full): the redials back off — each wait at least its scheduled, growing, wait", gaps.length >= 3 && want[1] > want[0] * 1.2 && want[2] > want[1] * 1.2
      && want.every((w, i) => gaps[i] >= w - 50), { gaps, want });
    await cdp.send("Page.navigate", { url: "about:blank" }); await sleep(500);   // the page stops dialling: the seat is the agent's
    // W9 (review r4 claims C2): an AGENT dialling a full world waits too — refused in the server's words, it dials again by
    // itself (the same backoff, shared/redial.js) and gets in once a seat frees; it never gives the world up
    const ag9: any = new WorldAgent({ name: "A9", world: "here", url: BASE.replace("http", "ws") + "/ws" });
    let said9 = "";
    try { await ag9.connect(); said9 = "(joined)"; } catch (e) { said9 = String((e as Error)?.message ?? e); }
    check("W9 an agent dialling a full world: refused in the server's words, and it says it will try again (not closed for good)",
      said9.includes(full.error) && /trying again/.test(said9) && !ag9.closed, { said9, closed: ag9.closed });
    try { keeper.close(); } catch { /* gone */ }
    const t9 = Date.now(); while (Date.now() - t9 < 20000 && !ag9.joined) await sleep(250);
    check("W9 ...and once a seat frees it gets in by itself", ag9.joined === true, { waited: Date.now() - t9, closed: ag9.closed });
    try { ag9.close(); } catch { /* gone */ }
  }
} catch (e) { check("the run threw", false, String(e?.stack ?? e)); }
console.log(`[refusedjoin-check] ${tally.passed} passed, ${tally.failed} failed${tally.note()}`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
