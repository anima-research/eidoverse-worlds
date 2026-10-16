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
// Run under the house guards: code/scripts/eido-probe.sh -C <worktree> -t 300 tools/protocol/refusedjoin-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, mkCheck, sleep } from "../harness.ts";

const V1 = process.env.V1_LOG ?? "/home/claude/eido/staging/worlds/staging/log.jsonl";
const { evalJson, cdp, cleanup, die, BASE, SCRATCH } = await scratchBench("refusedjoin", {
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
} catch (e) { check("the run threw", false, String(e?.stack ?? e)); }
console.log(`[refusedjoin-check] ${tally.passed} passed, ${tally.failed} failed${tally.note()}`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
