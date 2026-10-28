// tools/protocol/refusedjoin-check.ts — a join the server refuses (close 4005) is SHOWN in the browser, in the server's words.
// R 10-16 00:02: ?world=old-commons&name=Rab opened an empty world with her avatar on the grid and the normal hint bar —
// no message — though the server had refused the join in 13 ms with the old-format sentence and close 4005. The page
// lost it: the inline boot script's early socket caught the refusal, and connect() threw that socket away (and with it
// the refusal) and dialled again.
// One headless Chromium against a scratch sequencer (tools/harness.ts scratchBench) whose worlds dir holds:
//   old-x   a first-protocol log.jsonl (an old-format world: the server answers with the "translate" visitor sentence)
//   (nope)  nothing at all (no such world)
// For each world, by both boot paths (the early socket, and ?earlysock=0's fresh connect):
//   W1 the refusal is on screen (an old world: the one-line splash; else the server's sentence), and still there 6 s later (not a 4-second toast)
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
//   W10 an old-format world's splash (a guest): the headline, the server's words, the doc (served), no Upgrade world…
//   W11 the operator's splash: Upgrade world… → the report → Back up and upgrade → the backup and the rollback command
// Run under the house guards: code/scripts/eido-probe.sh -C <worktree> -t 300 tools/protocol/refusedjoin-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { OLD_FORMAT_SPLASH } from "../../shared/oldformat.js";
import { scratchBench, mkCheck, sleep } from "../harness.ts";
import { tryUntil } from "./wait.ts";

process.env.AGENT_BODY_ENGINE = "verlet";
// any first-protocol log will do (a v1 world is recognised by its genesis line): the repo's own fixture unless V1_LOG names one
const V1 = process.env.V1_LOG ?? path.resolve(import.meta.dir, "../../spec/fixtures/01-build/log.jsonl");
// W10/W11: a signed-in server operator (SERVER_OPERATORS) and its session, beside the guest the other rows are
const OP_SID = "e".repeat(64), SESS = path.join(fs.mkdtempSync(path.join(process.env.PROTOCOL_SCRATCH ?? os.tmpdir(), "refusedjoin-sess-")), "sessions.json");
fs.writeFileSync(SESS, JSON.stringify({ [OP_SID]: { sub: "human:test:op", name: "Opal", scopes: ["worlds:join"], exp: Date.now() + 3600_000 } }), { mode: 0o600 });
const { evalJson, cdp, cleanup, die, BASE, SCRATCH } = await scratchBench("refusedjoin", { worlds: ["here"], owner: "keeper", serverEnv: { TRUST_NAMES: "1", SERVER_OPERATORS: "human:test:op", SESSIONS_PATH: SESS, BACKUPS_DIR: "" },
  prepare: (scratch) => {
    // a first-protocol log, cut to its first lines (a v1 world is recognised by its genesis line); old-y is W11's to upgrade
    const lines = fs.readFileSync(V1, "utf8").split("\n").slice(0, 200).filter(Boolean);
    for (const n of ["old-x", "old-y"]) { const d = path.join(scratch, "worlds", n); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "log.jsonl"), lines.join("\n") + "\n"); }
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
      const visible = `(() => { const want = ${JSON.stringify(world === "old-x" ? OLD_FORMAT_SPLASH : said.error)};
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
      check(`W1 ${tag}: the refusal is on screen, and still there 6 s later`, seen && stays, { seen, stays, ...st });
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
  // W10: an old-format world's splash for someone who can't upgrade it: the headline, the server's words, the doc, no button
  {
    await cdp.send("Page.navigate", { url: `${BASE}/?world=old-x&name=T10&earlysock=0` });
    const probe = `(() => { const s = document.getElementById('splash'); const a = s?.querySelector('a.sp-up-doc');
      return { head: s?.querySelector('.sp-phase')?.textContent, doc: a ? a.getAttribute('href') : null, review: !!s?.querySelector('.sp-up-review') }; })()`;
    const st: any = await tryUntil("the old-format splash shows its doc link", async () => { const v = await evalJson(probe).catch(() => null); return v?.doc ? v : null; }, { ms: 20000, step: 250 });
    const doc = st?.doc ? await fetch(new URL(st.doc, BASE)).then(async (r) => ({ status: r.status, text: (await r.text()).slice(0, 200) })).catch((e) => ({ err: String(e) })) : null;
    check("W10 old-x as a guest: the splash says the world was saved by an older version of the engine and needs a one-time upgrade, links the doc (served), and offers no Upgrade world…",
      st?.head === OLD_FORMAT_SPLASH && st.doc === "/docs/TRANSLATING-OLD-WORLDS.md" && doc?.status === 200 && /Translating a first-protocol world/.test(doc.text) && st.review === false, { st, doc });
  }
  // W11: the operator's splash: Upgrade world… → the report → Back up and upgrade (the only action) → the backup and the rollback command
  {
    await cdp.send("Network.enable", {});
    await cdp.send("Network.setCookie", { name: "ew_sess", value: OP_SID, url: BASE });
    await cdp.send("Page.navigate", { url: `${BASE}/?world=old-y&name=Opal&earlysock=0` });
    const shows = (js: string, ms = 30000) => tryUntil(`the page shows ${js.slice(0, 60)}`, () => evalJson(js).catch(() => null), { ms, step: 250 });
    const btn = await shows(`(() => { const b = document.querySelector('#splash .sp-up-review'); if (!b) return null; const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); const doc = document.querySelector('#splash a.sp-up-doc'); return { text: b.textContent, top: top === b, first: !!doc && !!(b.compareDocumentPosition(doc) & Node.DOCUMENT_POSITION_FOLLOWING) }; })()`);
    check("W11b the operator's Upgrade world… comes before the How upgrading works link (R 10-28)", btn?.first === true, btn);
    await evalJson(`(document.querySelector('#splash .sp-up-review')?.click(), true)`).catch(() => null);
    const rep = await shows(`(() => { const r = document.querySelector('#splash .sp-up-report'); if (!r) return null; return { text: r.innerText, buttons: [...document.querySelectorAll('#splash .sp-up-area button')].map((b) => b.textContent) }; })()`, 60000);
    check("W11 old-y as the operator: Upgrade world… (on top) shows the report — carried, mapped, unmapped, dropped, refused, each counted, and its hash — and Back up and upgrade is the only action",
      btn?.text === "Upgrade world…" && btn.top && /Carried \(\d+\)/.test(rep?.text ?? "") && /Mapped \(\d+\)/.test(rep.text) && /Unmapped[^\n]*\(\d+\)/.test(rep.text) && /Dropped by design \(\d+\)/.test(rep.text) && /Refused \(0\)/.test(rep.text)
      && /report [0-9a-f]{64}/.test(rep.text) && JSON.stringify(rep.buttons) === JSON.stringify(["Back up and upgrade"]), { btn, rep: rep && { ...rep, text: rep.text.slice(0, 300) } });
    await evalJson(`(document.querySelector('#splash .sp-up-go')?.click(), true)`).catch(() => null);
    const done = await shows(`(() => { const d = document.querySelector('#splash .sp-up-done'); return d ? { backup: d.querySelector('.sp-up-backup')?.textContent, rollback: d.querySelector('.sp-up-rollback')?.textContent, enter: !!d.querySelector('.sp-up-enter'), head: document.querySelector('#splash .sp-phase')?.textContent, doc: !!document.querySelector('#splash a.sp-up-doc'), enterFirst: d.firstElementChild?.classList.contains('sp-up-enter') } : null; })()`, 120000);
    check("W11c after the upgrade the old-world words and the doc link are gone, and Enter the world comes first (R 10-28)", done?.head === 'Upgraded. The world is ready.' && done.doc === false && done.enterFirst === true, done);
    const onDisk = done?.backup ? fs.existsSync(path.join(done.backup, "SHA256SUMS")) && fs.existsSync(path.join(done.backup, "log.jsonl")) : false;
    check("W11 …Back up and upgrade: the result names the verified backup (on disk, with SHA256SUMS) and the rollback command, and old-y is a world now",
      onDisk && /^\S*backups\/old-y-\d{8}T\d{6}Z$/.test(done.backup.split(path.sep).join("/")) && /world\.ts rollback old-y/.test(done.rollback ?? "") && done.enter && fs.existsSync(path.join(SCRATCH, "worlds", "old-y", "world.jsonl")), done);
    await cdp.send("Network.deleteCookies", { name: "ew_sess", url: BASE });
  }
} catch (e) { check("the run threw", false, String(e?.stack ?? e)); }
console.log(`[refusedjoin-check] ${tally.passed} passed, ${tally.failed} failed${tally.note()}`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
