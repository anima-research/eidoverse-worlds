// chat-catchup-probe — what a reader can scroll back to after a long drop, in
// the real chat client: Chromium, joined to an owned scratch world, with a raw
// socket beside it saying what the reader misses while disconnected.
//
//   bun tools/chat-catchup-probe.ts
//
// Needs a Chromium that tools/probe-harness.mjs can find.
//
// The reader's socket is dropped by closing net.js's own socket from inside
// the page, and held down by pointing each reconnect the client attempts at a
// closed port, while the raw socket talks. Then the client reconnects on its
// own and its re-join catches up, newest first, 1,000 lines at most. Each
// reader's world holds 200 lines before the drop:
//  - one had scrolled back a page, and misses 1,100. A scroll-up while it's
//    disconnected must try to load a page and not show "the beginning of this
//    world". After the re-join, scrolling up must bring back every line once,
//    in order, the 100 past the catch-up's cap too;
//  - one had scrolled to the beginning, and misses 1,100: the same after the
//    re-join;
//  - one had scrolled back a page, and misses 200, and the page drops the
//    answer to its catch-up's second request, so requestHistory's own 8 s
//    timer rejects it: the same after the re-join.
// The page follows each history request it sends until its answer arrives or
// requestHistory's 8 s timer for it fires, so a wait for the log to settle
// waits for every request to end one way or the other.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scratchSequencer, mkCheck, sleep } from "./harness.ts";
import { launchBrowser } from "./probe-harness.mjs";

const { check, tally } = mkCheck();
const BEFORE = 200, END = "— the beginning of this world —", LOADING = "… loading earlier messages";
const data = mkdtempSync(join(tmpdir(), "catchup-data-"));
// MSG_RATE and VERB_RATE lifted: the raw socket says 1,100 lines in one burst
const h = await scratchSequencer("catchup", { serverEnv: {
  SKIP_OPT_SWEEP: "1", JOIN_TOKEN: "test-door", MSG_RATE: "100000", VERB_RATE: "100000",
  OPT_DIR: join(data, "opt"), STORE_DIR: join(data, "store"), EIDOVERSE_DIR: join(data, "library"),
} });

async function until(what: string, test: () => boolean | Promise<boolean>, timeout = 30000) {
  const end = performance.now() + timeout;
  while (!(await test())) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** A raw socket in `world`, as the one who talks. */
async function speaker(world: string) {
  const ws = new WebSocket(h.BASE.replace("http", "ws") + "/ws");
  const seen: any[] = [];
  ws.onmessage = (e) => { try { seen.push(JSON.parse(String(e.data))); } catch { /* not JSON */ } };
  await until("the speaker's socket", () => ws.readyState === 1);
  ws.send(JSON.stringify({ type: "join", token: "test-door", world, id: "speaker" }));
  await until("the speaker's join", () => seen.some((m) => m.type === "snapshot"));
  const logged = (text: string) => seen.some((m) => m.type === "log" && m.entry?.verb === "say" && m.entry.args?.text === text);
  return {
    ws, seen,
    async say(from: number, to: number) {
      for (let s = from; s <= to; s++) ws.send(JSON.stringify({ type: "verb", verb: "say", args: { text: `#${s}` } }));
      await until(`the world to log #${to}`, () => logged(`#${to}`), 60000);
    },
    left: (id: string) => seen.some((m) => m.type === "leave" && m.id === id),
  };
}

let browser: { close(): Promise<void> } | undefined;
const speakers: WebSocket[] = [];
let completed = false;
try {
  const launched = await launchBrowser();
  browser = launched.browser;
  console.log(`  browser: Chromium ${launched.browser.version()}, headless`);

  async function reader(world: string) {
    const page = await launched.page();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.addInitScript((loading) => {
      const g = globalThis as any;
      // __hist follows each history request the page sends, by its reqId, until
      // its answer arrives or requestHistory's own 8 s timer for it fires; `open`
      // holds the reqIds still waiting. Once dropCatchup is set, the answer to
      // the catch-up's request of that number is dropped (only resyncChatAfter
      // sends `after`, so `catchups` counts its requests).
      g.__hist = { sent: 0, answered: 0, dropped: 0, timedOut: 0, open: new Set(), catchups: 0, dropCatchup: 0, dropId: null, armed: null };
      // requestHistory arms its timer and then sends, in one synchronous run,
      // so the last timer armed before a history request goes out is that
      // request's own: every timer is tagged here, and a history send names
      // the latest tag. Only a named tag counts when its timer fires.
      const setT = g.setTimeout;
      g.setTimeout = (fn: any, ...rest: any[]) => {
        if (typeof fn === "function") {
          const tag = { reqId: null as string | null }, f = fn;
          g.__hist.armed = tag;
          fn = (...a: any[]) => {
            if (tag.reqId !== null) { g.__hist.timedOut++; g.__hist.open.delete(tag.reqId); }
            return f(...a);
          };
        }
        return setT.call(g, fn, ...rest);
      };
      // While __holdSockets is set, every socket the page opens goes to a
      // closed port: the client's own reconnects fail, and it keeps retrying.
      const WS = WebSocket;
      const setOnMessage = Object.getOwnPropertyDescriptor(WS.prototype, "onmessage")!.set!;
      g.WebSocket = new Proxy(WS, { construct(t, args: any[]) {
        const s = new t(...(g.__holdSockets ? ["ws://127.0.0.1:9/held", ...args.slice(1)] : args));
        const send = s.send.bind(s);
        s.send = (d: any) => {
          let m: any = null;
          try { m = JSON.parse(String(d)); } catch { /* not JSON */ }
          if (m?.type === "history") {
            const h = g.__hist;
            h.sent++; h.open.add(m.reqId);
            if (h.armed) { h.armed.reqId = m.reqId; h.armed = null; }
            if (m.after != null && ++h.catchups === h.dropCatchup) h.dropId = m.reqId;
          }
          return send(d);
        };
        Object.defineProperty(s, "onmessage", { configurable: true, get: () => null, set(fn: any) {
          setOnMessage.call(s, (ev: MessageEvent) => {
            let m: any = null;
            try { m = JSON.parse(String(ev.data)); } catch { /* not JSON */ }
            if (m?.type === "history") {
              if (m.reqId != null && m.reqId === g.__hist.dropId) { g.__hist.dropped++; return; }
              if (g.__hist.open.delete(m.reqId)) g.__hist.answered++;
            }
            return fn?.call(s, ev);
          });
        } });
        return s;
      } });
      // loadOlder shows its loading row while it asks for a page: count them
      g.__loadingRows = 0;
      new MutationObserver((muts) => {
        for (const mu of muts) for (const n of mu.addedNodes) if ((n as Element).textContent === loading) g.__loadingRows++;
      }).observe(document, { childList: true, subtree: true });
    }, LOADING);
    await page.setViewportSize({ width: 900, height: 500 });
    await page.goto(`${h.BASE}/?world=${world}&name=reader&key=test-door&lite=1`);
    await page.waitForFunction(() => document.getElementById("splash")?.classList.contains("gone"), null, { timeout: 60000 });
    const lines = () => page.evaluate(() => [...document.querySelectorAll("#chatlog > .line:not(.sys)")]
      .map((r) => r.querySelector(".body")?.textContent ?? ""));
    const endMarkers = () => page.evaluate((end) => [...document.querySelectorAll("#chatlog > .line.sys")]
      .filter((r) => r.textContent === end).length, END);
    const joined = () => page.evaluate(async () => (await import("/lib/net.js")).net.joined === true);
    const hist = () => page.evaluate(() => {
      const g = globalThis as any, h = g.__hist;
      return { sent: h.sent, answered: h.answered, dropped: h.dropped, timedOut: h.timedOut, open: h.open.size, loadingRows: g.__loadingRows };
    });
    // Settled: every history request the page sent has its answer or has had
    // requestHistory's 8 s timer for it fire, no loading row is up, and the
    // log's row count is the same on two reads in a row.
    const settle = async () => {
      let last = -1;
      await until("the chat log to settle", async () => {
        const s = await page.evaluate((loading) => {
          const g = globalThis as any, el = document.getElementById("chatlog")!;
          const quiet = g.__hist.open.size === 0 && !el.textContent!.includes(loading);
          return quiet ? el.children.length : -1;
        }, LOADING);
        const settled = s >= 0 && s === last;
        last = s;
        return settled;
      }, 30000);
    };
    // One scroll to the top, as a reader's: the log moves down and back up,
    // which fires the log's own scroll events, and loadOlder runs from those.
    const scrollUp = async () => {
      await page.evaluate(() => new Promise<void>((done) => {
        const el = document.getElementById("chatlog")!;
        el.scrollTop = 200;
        requestAnimationFrame(() => { el.scrollTop = 0; requestAnimationFrame(() => requestAnimationFrame(() => done())); });
      }));
      await settle();
    };
    // Scroll up until three scrolls in a row land nothing, not stopping at an
    // end marker, so a stale one shows as a second marker.
    const scrollAll = async (max = 80) => {
      for (let i = 0, still = 0; i < max && still < 3; i++) {
        const was = (await lines()).length;
        await scrollUp();
        still = (await lines()).length === was ? still + 1 : 0;
      }
    };
    const drop = async () => {
      await page.evaluate(async () => { (globalThis as any).__holdSockets = true; (await import("/lib/net.js")).net.ws.close(); });
    };
    const rejoin = async () => {
      await page.evaluate(() => { (globalThis as any).__holdSockets = false; });
      await page.waitForFunction(async () => (await import("/lib/net.js")).net.joined === true, null, { timeout: 60000 });
    };
    return { page, errors, lines, endMarkers, joined, hist, settle, scrollUp, scrollAll, drop, rejoin };
  }

  const want = (n: number) => Array.from({ length: n }, (_, i) => `#${i + 1}`);
  const missingOf = (shown: string[], from: number, to: number) => {
    const s = new Set(shown);
    const m: number[] = [];
    for (let i = from; i <= to; i++) if (!s.has(`#${i}`)) m.push(i);
    return m.length ? `${m.length} missing, #${m[0]}–#${m.at(-1)}` : "none missing";
  };

  const readers = [
    { world: "catchup-page", walk: "one page", missed: 1100, says: "back a page", scrollWhileDown: true },
    { world: "catchup-begin", walk: "beginning", missed: 1100, says: "to the beginning", scrollWhileDown: false },
    { world: "catchup-lost", walk: "one page", missed: 200, says: "back a page, its catch-up's second request unanswered", scrollWhileDown: false, lose: 2 },
  ] as const;
  for (const c of readers) {
    console.log(`a reader who had scrolled ${c.says} (${c.world})`);
    const talk = await speaker(c.world);
    speakers.push(talk.ws);
    await talk.say(1, BEFORE);
    const r = await reader(c.world);
    await until("the reader's join", r.joined, 60000);
    await until(`#${BEFORE} on screen`, async () => (await r.lines()).includes(`#${BEFORE}`));
    await r.settle();
    const lowest = async () => Math.min(...(await r.lines()).map((t) => Number(t.slice(1))));
    const was = await lowest();
    if (c.walk === "one page") await r.scrollUp();
    else await r.scrollAll();
    const now = await lowest(), markers = await r.endMarkers();
    check(`precondition: the walk ${c.walk === "one page" ? "has moved and not ended" : "has ended at the beginning"}`,
      c.walk === "one page" ? now < was && markers === 0 : now === 1 && markers === 1,
      `lowest #${now}, #${was} before, ${markers} end markers`);

    await r.drop();
    await until("the world to see the reader leave", () => talk.left("reader"));
    // the world can broadcast the leave before the page's own close event runs
    await until("the page to see its socket close", async () => !(await r.joined()));
    if (c.scrollWhileDown) {
      const before = await r.hist();
      await r.scrollUp();
      const after = await r.hist();
      check("a scroll-up while disconnected tries to load a page, and doesn't show the beginning of the world",
        after.loadingRows > before.loadingRows && (await r.endMarkers()) === 0,
        `${after.loadingRows - before.loadingRows} loading rows, ${after.sent - before.sent} sent, ${await r.endMarkers()} end markers`);
    }
    const top = BEFORE + c.missed;
    await talk.say(BEFORE + 1, top);
    if ("lose" in c) await r.page.evaluate((n) => { const h = (globalThis as any).__hist; h.dropCatchup = h.catchups + n; }, c.lose);
    await r.rejoin();
    if ("lose" in c) {
      await until("the catch-up's second answer to be dropped", async () => (await r.hist()).dropped === 1, 60000);
      // net.js gives up on that request when its own 8 s timer fires, and the
      // catch-up's catch restarts the walk
      await until("requestHistory's 8 s timer for it to fire", async () => (await r.hist()).timedOut === 1, 20000);
      await r.settle();
      const caught = await r.lines();
      check(`precondition: the catch-up's first page, #${top - 39}–#${top}, landed, and lines before it are still missing`,
        missingOf(caught, top - 39, top) === "none missing" && missingOf(caught, BEFORE + 1, top - 40) !== "none missing",
        missingOf(caught, BEFORE + 1, top));
    } else {
      await until(`the catch-up to reach #${top - 999}`, async () => (await r.lines()).includes(`#${top - 999}`), 60000);
      await r.settle();
      const caught = await r.lines();
      check(`precondition: the catch-up stopped at its cap, short of #${BEFORE + 1}–#${top - 1000}`,
        missingOf(caught, BEFORE + 1, top - 1000) === `${top - 1000 - BEFORE} missing, #${BEFORE + 1}–#${top - 1000}`
          && missingOf(caught, top - 999, top) === "none missing",
        missingOf(caught, BEFORE + 1, top));
    }
    await r.scrollAll();
    const final = await r.lines();
    check("scrolling up brings back every line once, in world order",
      final.join(" ") === want(top).join(" "), `${final.length} of ${top} shown; ${missingOf(final, 1, top)}`);
    check("…and the walk ends once, with one end marker", (await r.endMarkers()) === 1, `${await r.endMarkers()} end markers`);
    check("the page threw nothing", r.errors.length === 0, r.errors.join("; "));
    await r.page.context().close();
  }
  completed = true;
} finally {
  for (const ws of speakers) { try { ws.close(); } catch { /* gone */ } }
  await browser?.close();
  await h.cleanup(completed && !tally.failed ? 0 : 1);
  rmSync(data, { recursive: true, force: true });
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
