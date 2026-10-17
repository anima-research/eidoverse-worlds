// chat scrollback — paging history into an arrival window that has holes.
//
//   bun tools/chat-scrollback-test.ts
//
// The join window is what trimRecentChat (shared/fold.js) left, and it is
// fair rather than contiguous: the loudest voice loses its oldest lines
// first, so a quiet visitor's last line from yesterday can sit above hours of
// trimmed conversation. Scrollback used to page from the oldest line SHOWN —
// i.e. from below that visitor's line — so it jumped straight over the hole
// and the trimmed talk was never reachable from the browser. The contract
// now: scrolling up walks history from the present, fills the holes in seq
// order, never renders a line twice, and reaches the beginning with every
// say on screen exactly once. Also pinned (review of #243): a spoken row that
// logChat moved by t0 does not scramble the fill, the reader's view holds
// still when rows land above it, and a reconnect's new hole gets filled. And
// (its second review) a row that merged a spoken utterance's says gives every
// one of them back when it's trimmed, and a page that lands after a trim has
// restarted the walk neither moves the cursor past the new hole nor ends the
// walk. And (its third) a trim of a merged row that the walk's cursor sits
// inside restarts the walk, and a walk that ended at the present opens again
// once a trim makes history.
//
// Each scenario gets a FRESH chat.js (cache-busted specifier): the paging
// cursor is module state, and one scenario's walk must not leak into another.

import { plugin } from "bun";
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({
  name: "chat-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here("./chat-core-stub.mjs") }));
    b.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here("./chat-base-stub.mjs") }));
    b.onResolve({ filter: /^\.\/frames\.js$/ }, () => ({ path: here("./chat-frames-stub.mjs") }));
    b.onResolve({ filter: /^\.\/net\.js$/ }, () => ({ path: here("./chat-history-stub.mjs") }));
  },
});

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

const { setLog, holdNext, release, inFlight } = await import("./chat-history-stub.mjs");
const { frameStub } = await import("./chat-frames-stub.mjs");
const { emptyState, foldEntry } = await import("../shared/fold.js");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

let n = 0;
async function freshChat() {
  frameStub.el?.remove();
  const mod = await import(`../client/lib/chat.js?scenario=${++n}`);
  mod.initChat({ send: () => {}, whisper: () => {}, people: () => [{ id: "me", me: true }] });
  const logEl = frameStub.body!.querySelector("#chatlog") as HTMLElement;
  return { ...mod, logEl };
}

const rowsOf = (logEl: HTMLElement) => [...logEl.children].filter((c) => !c.classList.contains("sys")) as HTMLElement[];
const shownIn = (logEl: HTMLElement) => rowsOf(logEl).map((c) => c.querySelector(".body")?.textContent ?? "");
const num = (t: string) => +t.slice(1);
const isSorted = (xs: string[]) => xs.every((x, i) => !i || num(xs[i - 1]) < num(x));
const settle = () => Bun.sleep(20);   // the stub answers at once; let the async pass finish
const scrollUp = async (logEl: HTMLElement) => { logEl.dispatchEvent(new Event("scroll")); await settle(); };
const scrollToTop = async (logEl: HTMLElement) => {
  for (let i = 0; i < 30 && !logEl.textContent!.includes("beginning of this world"); i++) await scrollUp(logEl);
};
const say = (seq: number, actor: string, ts: number) => ({ seq, ts, actor, verb: "say", args: { text: `#${seq}` } });
const windowOf = (entries: any[]) => {
  const st = emptyState();
  for (const e of entries) foldEntry(st, e);
  return st.recentChat as { actor: string; text: string; ts: number; seq: number }[];
};
// no row grouped ("cont", name hidden) under a different speaker
const groupedOk = (rows: HTMLElement[]) => rows.every((c, i) =>
  !c.classList.contains("cont") || rows[i - 1]?.dataset.author === c.dataset.author);

// Yesterday a visitor said two things, with one regular's line between them;
// today the regulars talked a lot. The window keeps both visitor lines (now
// adjacent, so the second is grouped under the first's name) and trims the
// regular's line out from between them. 200 says, text = "#<seq>".
const day: any[] = [];
{
  const t0 = Date.now() - 86_400_000;
  const speak = (actor: string) => day.push(say(day.length + 1, actor, t0 + (day.length + 1) * 30_000));
  for (let i = 0; i < 20; i++) speak(i % 2 ? "cairn" : "mythos");
  speak("visitor"); speak("cairn"); speak("visitor");
  for (let i = 0; i < 177; i++) speak(["cairn", "mythos", "apricot"][i % 3]);
}
const all = day.map((e) => e.args.text);

console.log("scrollback over a fair-trimmed window");
{
  const { logChat, logEl } = await freshChat();
  const win = windowOf(day);
  const seqs = win.map((m) => m.seq);
  let contiguousFrom = seqs[seqs.length - 1];
  while (seqs.includes(contiguousFrom - 1)) contiguousFrom--;
  check("precondition: the fold's window has a hole (visitor kept, regulars trimmed)",
    seqs.includes(21) && seqs.includes(23) && !seqs.includes(22) && contiguousFrom > 24, seqs.join(","));
  setLog(day);
  for (const m of win) logChat(m.actor, m.text, "", { seq: m.seq, ts: m.ts });
  const windowCont = logEl.querySelectorAll(".line.cont").length;

  await scrollUp(logEl);
  const afterOne = shownIn(logEl);
  check("first scroll-up brings back the newest trimmed line",
    afterOne.includes(`#${contiguousFrom - 1}`), `missing #${contiguousFrom - 1}`);
  check("…and does not leap past the hole to the beginning", !afterOne.includes("#1"), "jumped to #1");
  check("lines stay in seq order after a gap fill", isSorted(afterOne), afterOne.join(" "));

  await scrollToTop(logEl);
  const final = shownIn(logEl);
  check("scrolling to the top reaches the beginning", logEl.textContent!.includes("beginning of this world"));
  check("every say is on screen exactly once",
    final.length === all.length && new Set(final).size === all.length,
    `${final.length} shown, ${new Set(final).size} distinct, want ${all.length}`);
  check("…in world order", final.join(" ") === all.join(" "));
  check("precondition: the window had grouped lines to displace", windowCont > 0, `${windowCont}`);
  check("no grouped line sits under a different speaker", groupedOk(rowsOf(logEl)));
}

console.log("a spoken row moved by t0 does not scramble the fill");
{
  // window rows #90 #95 #100 (5s apart per seq, all recent), the rest trimmed;
  // then a live spoken #101 whose speech BEGAN before #95 — logChat slots it
  // above #95 and #100, so the screen reads 90, 101, 95, 100
  const { logChat, logEl } = await freshChat();
  const now = Date.now();
  const tsOf = (s: number) => now - (101 - s) * 5_000;
  const log = [];
  for (let s = 80; s <= 100; s++) log.push(say(s, s % 2 ? "cairn" : "mythos", tsOf(s)));
  log.push(say(101, "apricot", now));
  setLog(log);
  for (const s of [90, 95, 100]) logChat(log[s - 80].actor, `#${s}`, "", { seq: s, ts: tsOf(s) });
  logChat("apricot", "#101", "agent", { seq: 101, ts: now, spoken: true, utt: 1, t0: tsOf(93) });
  check("precondition: the spoken row sits above older rows",
    shownIn(logEl).join(" ") === "#90 #101 #95 #100", shownIn(logEl).join(" "));
  await scrollToTop(logEl);
  const rest = shownIn(logEl).filter((t) => t !== "#101");
  check("every non-spoken row is in seq order around it", isSorted(rest), shownIn(logEl).join(" "));
  check("…and all of 80–100 arrived once", rest.length === 21 && new Set(rest).size === 21, `${rest.length}`);
}

console.log("the reader's view holds still while rows land above it");
{
  // happy-dom has no layout, so give it one: every row 20px tall, stacked in
  // DOM order, the log a 200px window at viewport y=100 scrolled by scrollTop.
  // offsetTop stays 0 (as in happy-dom) — measuring with it is the bug.
  const { logChat, logEl } = await freshChat();
  let scroll = 0;
  Object.defineProperty(logEl, "scrollTop", { get: () => scroll, set: (v) => { scroll = v; }, configurable: true });
  const LOG_TOP = 100, ROW = 20;
  // and a height: happy-dom's 0/0 would read as "following the bottom"
  Object.defineProperty(logEl, "scrollHeight", { get: () => logEl.children.length * ROW, configurable: true });
  Object.defineProperty(logEl, "clientHeight", { get: () => 200, configurable: true });
  const realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this === logEl) return { top: LOG_TOP, bottom: LOG_TOP + 200, height: 200 } as DOMRect;
    if (this.parentElement === logEl) {
      const i = [...logEl.children].indexOf(this);
      const top = LOG_TOP + i * ROW - scroll;
      return { top, bottom: top + ROW, height: ROW } as DOMRect;
    }
    return realRect.call(this);
  };
  try {
    const win = windowOf(day);
    setLog(day);
    for (const m of win) logChat(m.actor, m.text, "", { seq: m.seq, ts: m.ts });
    // scrolled a little: rows #21 and #23 are above the view, the reader is
    // looking at the third row; the first page lands between #23 and it
    scroll = 50;
    const reading = rowsOf(logEl)[2];
    const was = reading.getBoundingClientRect().top;
    await scrollUp(logEl);
    const added = shownIn(logEl).length - win.length;
    check("precondition: the fill landed above the row being read",
      added > 0 && [...logEl.children].indexOf(reading) > 2, `${added} added`);
    check("the row being read did not move on screen",
      reading.getBoundingClientRect().top === was, `${was} → ${reading.getBoundingClientRect().top}`);
  } finally { Element.prototype.getBoundingClientRect = realRect; }
}

console.log("a reconnect's new window does not leave a hole");
{
  // the reader scrolled all the way back, the socket dropped after #200, and
  // 60 more says happened before the re-join. The new window is trimmed the
  // same fair way, so some of #201–#260 are not in it.
  const { logChat, logEl, resyncChatAfter } = await freshChat();
  setLog(day);
  for (const m of windowOf(day)) logChat(m.actor, m.text, "", { seq: m.seq, ts: m.ts });
  await scrollToTop(logEl);
  const later = [...day];
  const t1 = Date.now();
  for (let s = 201; s <= 260; s++) later.push(say(s, s % 4 ? "cairn" : "visitor2", t1 + s * 1000));
  setLog(later);
  const win2 = windowOf(later);
  const missing = later.filter((e) => e.seq > 200 && !win2.some((m) => m.seq === e.seq)).length;
  check("precondition: the re-join window misses some of what was said", missing > 0, `${missing}`);
  // what net.js does on a re-join: resync from the last delivered seq, then
  // the realizer replays the new window (order between them is not promised)
  const pending = resyncChatAfter(200);
  for (const m of win2) logChat(m.actor, m.text, "", { seq: m.seq, ts: m.ts });
  await pending; await settle();
  const final = shownIn(logEl);
  const want = later.map((e) => e.args.text);
  check("every say, old and new, is on screen exactly once",
    final.length === want.length && new Set(final).size === want.length, `${final.length} of ${want.length}`);
  check("…in world order", final.join(" ") === want.join(" "));
  check("a first join (nothing on screen) resyncs nothing", await (async () => {
    const { logEl: el2, resyncChatAfter: r2 } = await freshChat();
    await r2(5); await settle();
    return shownIn(el2).length === 0;
  })());
}

console.log("lines the log trimmed off the top come back when paging");
{
  // 600 says arrive live (#601–#1200); the log keeps 400 rows, so #601–#800
  // are trimmed from the top. They are history now, not "already shown":
  // scrolling up must page them back in, in order, between #600 and #801.
  // A visitor spoke once at #650; the fair window keeps that line, so a
  // re-join's window replay offers #650 again after it was trimmed.
  const { logChat, logEl } = await freshChat();
  const t0 = Date.now() - 3_600_000;
  const log: any[] = [];
  for (let s = 1; s <= 1200; s++) log.push(say(s, s === 650 ? "visitor" : s % 2 ? "cairn" : "mythos", t0 + s * 1000));
  setLog(log);
  for (const e of log.slice(600)) logChat(e.actor, e.args.text, "", { seq: e.seq, ts: e.ts });
  check("precondition: the log trimmed to #801–#1200", shownIn(logEl)[0] === "#801" && rowsOf(logEl).length === 400,
    `${shownIn(logEl)[0]}, ${rowsOf(logEl).length} rows`);
  const win = windowOf(log);
  check("precondition: the re-join window holds the trimmed #650", win.some((m) => m.seq === 650));
  for (const m of win) logChat(m.actor, m.text, "", { seq: m.seq, ts: m.ts });
  check("a trimmed line replayed by a re-join window is not appended at the bottom",
    shownIn(logEl).at(-1) === "#1200" && !shownIn(logEl).includes("#650"), shownIn(logEl).slice(-3).join(" "));
  await scrollUp(logEl);
  const afterOne = shownIn(logEl);
  check("the first scroll-up brings back the newest trimmed line", afterOne.includes("#800"), afterOne.slice(0, 3).join(" "));
  check("…and nothing older than the trimmed lines", !afterOne.includes("#600"), afterOne.slice(0, 3).join(" "));
  await scrollToTop(logEl);
  const final = shownIn(logEl);
  const want = log.map((e) => e.args.text);
  check("every say comes back exactly once, in world order",
    final.length === want.length && final.join(" ") === want.join(" "),
    `${final.length} of ${want.length}; ${final.slice(598, 603).join(" ")}`);
}

console.log("a trim after paging does not strand the walk below a new hole");
{
  // the reader paged back to the beginning, then live talk trimmed the log
  // down to 400 again — taking the paged rows with it. The walk's cursor
  // sits at the beginning; the next scroll-up must start over from the
  // present rather than declare the world exhausted.
  const { logChat, logEl } = await freshChat();
  const t0 = Date.now() - 3_600_000;
  const log: any[] = [];
  for (let s = 1; s <= 450; s++) log.push(say(s, s % 2 ? "cairn" : "mythos", t0 + s * 1000));
  setLog(log);
  for (const e of log.slice(400)) logChat(e.actor, e.args.text, "", { seq: e.seq, ts: e.ts });
  await scrollToTop(logEl);
  check("precondition: paged to the beginning", shownIn(logEl).length === 450);
  const more: any[] = [];
  for (let s = 451; s <= 470; s++) more.push(say(s, "cairn", t0 + s * 1000));
  setLog([...log, ...more]);
  for (const e of more) logChat(e.actor, e.args.text, "", { seq: e.seq, ts: e.ts });
  check("precondition: the live lines trimmed the paged rows away", shownIn(logEl)[0] === "#71", shownIn(logEl)[0]);
  await scrollToTop(logEl);
  const final = shownIn(logEl);
  check("scrolling up again refills them, once each, in order",
    final.length === 470 && isSorted(final) && final[0] === "#1", `${final.length}, first ${final[0]}`);
}

console.log("a reader following the bottom keeps following through a re-join fill");
{
  // the same fixed layout as above, with scrollHeight/clientHeight and a
  // browser's clamping: a 60-row view (1200px) over 20px rows. The reader is
  // at the end when the socket drops; the re-join's resync lands rows BELOW
  // the first visible row, which the pin holds still — pushing the newest
  // lines below the fold. A reader who was following must still be.
  const { logChat, logEl, resyncChatAfter } = await freshChat();
  const LOG_TOP = 100, ROW = 20, VIEW = 1200;
  const height = () => logEl.children.length * ROW;
  let scroll = 0;
  Object.defineProperty(logEl, "scrollTop", { get: () => scroll,
    set: (v) => { scroll = Math.max(0, Math.min(v, height() - VIEW)); }, configurable: true });
  Object.defineProperty(logEl, "scrollHeight", { get: height, configurable: true });
  Object.defineProperty(logEl, "clientHeight", { get: () => VIEW, configurable: true });
  const realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this === logEl) return { top: LOG_TOP, bottom: LOG_TOP + VIEW, height: VIEW } as DOMRect;
    if (this.parentElement === logEl) {
      const i = [...logEl.children].indexOf(this);
      const top = LOG_TOP + i * ROW - scroll;
      return { top, bottom: top + ROW, height: ROW } as DOMRect;
    }
    return realRect.call(this);
  };
  try {
    const t0 = Date.now() - 3_600_000;
    const log: any[] = [];
    for (let s = 1; s <= 300; s++) log.push(say(s, s % 2 ? "cairn" : "mythos", t0 + s * 1000));
    setLog(log);
    for (const e of log.slice(0, 200)) logChat(e.actor, e.args.text, "", { seq: e.seq, ts: e.ts });
    logEl.scrollTop = 1e9;                           // clamped: the reader is at the end
    const gap = () => logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight;
    check("precondition: the reader is at the bottom", gap() === 0, `${gap()}px`);
    await resyncChatAfter(200); await settle();
    check("precondition: the fill landed below the view", shownIn(logEl).length === 300, `${shownIn(logEl).length}`);
    check("the reader is still at the bottom after the fill", gap() < 1, `${gap()}px above the end`);

    // …and a reader who had scrolled away is NOT yanked down
    const { logChat: lc2, logEl: el2, resyncChatAfter: r2 } = await freshChat();
    let scroll2 = 0;
    const h2 = () => el2.children.length * ROW;
    Object.defineProperty(el2, "scrollTop", { get: () => scroll2,
      set: (v) => { scroll2 = Math.max(0, Math.min(v, h2() - VIEW)); }, configurable: true });
    Object.defineProperty(el2, "scrollHeight", { get: h2, configurable: true });
    Object.defineProperty(el2, "clientHeight", { get: () => VIEW, configurable: true });
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this === el2) return { top: LOG_TOP, bottom: LOG_TOP + VIEW, height: VIEW } as DOMRect;
      if (this.parentElement === el2) {
        const i = [...el2.children].indexOf(this);
        const top = LOG_TOP + i * ROW - scroll2;
        return { top, bottom: top + ROW, height: ROW } as DOMRect;
      }
      return realRect.call(this);
    };
    for (const e of log.slice(0, 200)) lc2(e.actor, e.args.text, "", { seq: e.seq, ts: e.ts });
    scroll2 = 1000;                                  // reading mid-log
    const reading = rowsOf(el2).find((c) => c.getBoundingClientRect().bottom > LOG_TOP)!;
    const was = reading.getBoundingClientRect().top;
    await r2(200); await settle();
    check("a reader scrolled up stays on the row they were reading",
      reading.getBoundingClientRect().top === was && scroll2 === 1000, `${was} → ${reading.getBoundingClientRect().top}`);
  } finally { Element.prototype.getBoundingClientRect = realRect; }
}

const voices = ["cairn", "mythos", "apricot"];

console.log("a row that merged a spoken utterance gives back all of it when trimmed");
{
  // one utterance aired as three says, #501–#503 under the same utt, which
  // logChat merges into one row, and an aside with no seq merges after them.
  // 400 later says trim that row, and only it, off the top: all three of its
  // says are history again, and a live replay of the last one isn't appended
  // under the newer talk.
  const { logChat, logEl } = await freshChat();
  const t0 = Date.now() - 1_000_000;
  const ava = (s: number) => s >= 501 && s <= 503;
  const log = Array.from({ length: 903 }, (_, i) => say(i + 1, ava(i + 1) ? "ava" : voices[(i + 1) % 3], t0 + (i + 1) * 1000));
  setLog(log);
  for (const s of [501, 502, 503]) logChat("ava", `#${s}`, "agent", { seq: s, ts: log[s - 1].ts, spoken: true, utt: 7 });
  logChat("ava", "(aside)", "agent", { spoken: true, utt: 7 });
  check("precondition: the three says and the aside share one row",
    rowsOf(logEl).length === 1 && shownIn(logEl)[0] === "#501 #502 #503 (aside)", shownIn(logEl).join(" | "));
  check("the row keeps the three says' seqs, and the seq-less aside adds none",
    rowsOf(logEl)[0].dataset.seqs === "501,502,503", String(rowsOf(logEl)[0].dataset.seqs));
  for (const e of log.slice(503)) logChat(e.actor, e.args.text, "", { seq: e.seq, ts: e.ts });
  check("precondition: the merged row, and only it, was trimmed off the top",
    shownIn(logEl)[0] === "#504" && rowsOf(logEl).length === 400, `${shownIn(logEl)[0]}, ${rowsOf(logEl).length} rows`);
  logChat("ava", "#503", "agent", { seq: 503, ts: log[502].ts, spoken: true, utt: 7 });
  check("a live replay of the row's last say isn't appended under the newer talk",
    shownIn(logEl).at(-1) === "#903" && rowsOf(logEl).length === 400, `${shownIn(logEl).at(-1)}, ${rowsOf(logEl).length} rows`);
  await scrollUp(logEl);
  const back = shownIn(logEl);
  check("paging brings back all three of the trimmed row's says", ["#501", "#502", "#503"].every((s) => back.includes(s)),
    back.slice(0, 8).join(" "));
  check("…in world order", isSorted(back), back.slice(0, 8).join(" "));
}

console.log("a trim of a merged row that the walk's cursor sits inside restarts the walk");
{
  // #500 and #501 are one utterance, merged into one row at the top of the
  // log, and #502–#506 are missing below it. One scroll-up walks down from the
  // present to the page that ends at #501 and slots #502–#506 in, so the
  // walk's cursor is #501, inside the merged row. A live line then trims that
  // row alone. #501 is at the cursor, a seq the walk has passed, so the walk
  // starts over, or #501 would never be paged back.
  const { logChat, logEl } = await freshChat();
  const t0 = Date.now() - 1_000_000;
  const log = Array.from({ length: 901 }, (_, i) => say(i + 1, i + 1 === 500 || i + 1 === 501 ? "ava" : voices[(i + 1) % 3], t0 + (i + 1) * 1000));
  setLog(log.slice(0, 900));
  for (const s of [500, 501]) logChat("ava", `#${s}`, "agent", { seq: s, ts: log[s - 1].ts, spoken: true, utt: 9 });
  for (const e of log.slice(506, 900)) logChat(e.actor, e.args.text, "", { seq: e.seq, ts: e.ts });
  await scrollUp(logEl);
  check("precondition: one scroll-up slotted #502–#506 in below the merged row",
    shownIn(logEl)[0] === "#500 #501" && shownIn(logEl)[1] === "#502" && rowsOf(logEl).length === 400,
    `${shownIn(logEl).slice(0, 3).join(" | ")}, ${rowsOf(logEl).length} rows`);
  setLog(log);
  logChat(log[900].actor, "#901", "", { seq: 901, ts: log[900].ts });
  check("precondition: the live line trimmed the merged row alone",
    shownIn(logEl)[0] === "#502" && rowsOf(logEl).length === 400, `${shownIn(logEl)[0]}, ${rowsOf(logEl).length} rows`);
  await scrollToTop(logEl);
  const final = shownIn(logEl);
  check("scrolling up brings both of its says back: every say once, in order",
    final.length === 901 && isSorted(final) && final.includes("#500") && final.includes("#501"),
    `${final.length}, first ${final.slice(0, 3).join(" ")}`);
}

console.log("a walk that ended at the present opens again once a trim makes history");
{
  // the reader scrolls up before anyone has said anything, so the walk's
  // first page is empty and it ends at the present. 401 says later, a live
  // line has trimmed #1 off the top: that is history now, and scrolling up
  // must bring it back.
  const { logChat, logEl } = await freshChat();
  const t0 = Date.now() - 500_000;
  const log = Array.from({ length: 401 }, (_, i) => say(i + 1, voices[(i + 1) % 3], t0 + (i + 1) * 1000));
  setLog([]);
  await scrollUp(logEl);
  check("precondition: the empty world's first page ended the walk", logEl.textContent!.includes("beginning of this world"));
  setLog(log);
  for (const e of log) logChat(e.actor, e.args.text, "", { seq: e.seq, ts: e.ts });
  check("precondition: the trim took #1 off the top", shownIn(logEl)[0] === "#2" && rowsOf(logEl).length === 400,
    `${shownIn(logEl)[0]}, ${rowsOf(logEl).length} rows`);
  await scrollUp(logEl);
  const shown = shownIn(logEl);
  check("scrolling up brings #1 back: every say once, in order",
    shown[0] === "#1" && shown.length === 401 && isSorted(shown), `${shown[0]}, ${shown.length}`);
}

console.log("a trim while a page is in flight does not send the walk past the new hole");
{
  // #601–#1000 arrive live, and one scroll-up pages #561–#600 in on top. The
  // next page (#521–#560) is in flight when a live line trims the top rows,
  // #561–#601 among them, so the walk restarts. The page that lands after
  // that must not set the cursor below the hole it just left.
  const { logChat, logEl } = await freshChat();
  const t0 = Date.now() - 1_100_000;
  const log = Array.from({ length: 1001 }, (_, i) => say(i + 1, voices[(i + 1) % 3], t0 + (i + 1) * 1000));
  setLog(log.slice(0, 1000));
  for (const e of log.slice(600, 1000)) logChat(e.actor, e.args.text, "", { seq: e.seq, ts: e.ts });
  await scrollUp(logEl);
  check("precondition: one scroll-up paged #561–#600 in on top",
    shownIn(logEl)[0] === "#561" && rowsOf(logEl).length === 440, `${shownIn(logEl)[0]}, ${rowsOf(logEl).length} rows`);
  holdNext();
  logEl.dispatchEvent(new Event("scroll"));
  await Bun.sleep(5);
  check("precondition: the next page is in flight", inFlight());
  setLog(log);
  logChat(log[1000].actor, "#1001", "", { seq: 1001, ts: log[1000].ts });
  check("precondition: the live line trimmed #561–#601", shownIn(logEl)[0] === "#602", shownIn(logEl)[0]);
  release(); await settle();
  for (let i = 0; i < 4; i++) await scrollUp(logEl);
  const shown = shownIn(logEl);
  const missing = log.filter((e) => e.seq >= 481 && !shown.includes(e.args.text)).map((e) => e.seq);
  check("every say from #481 to #1001 is back on screen", !missing.length,
    `${missing.length} missing, #${missing[0]}–#${missing.at(-1)}`);
  check("…once each, in world order", isSorted(shown) && new Set(shown).size === shown.length);
}

console.log("a page that lands after a trim restarted the walk does not end it");
{
  // the walk has paged down to #1, the first say there is, and its next page
  // (before #1, which will come back empty) is in flight when a live line
  // trims #1–#41 off the top. That empty page belongs to the old walk: it
  // must not declare the beginning reached while #1–#41 are history again.
  const { logChat, logEl } = await freshChat();
  const t0 = Date.now() - 600_000;
  const log = Array.from({ length: 441 }, (_, i) => say(i + 1, voices[(i + 1) % 3], t0 + (i + 1) * 1000));
  setLog(log.slice(0, 440));
  for (const e of log.slice(40, 440)) logChat(e.actor, e.args.text, "", { seq: e.seq, ts: e.ts });
  await scrollUp(logEl);
  check("precondition: one scroll-up paged #1–#40 in on top",
    shownIn(logEl)[0] === "#1" && rowsOf(logEl).length === 440, `${shownIn(logEl)[0]}, ${rowsOf(logEl).length} rows`);
  holdNext();
  logEl.dispatchEvent(new Event("scroll"));
  await Bun.sleep(5);
  check("precondition: the page before #1 is in flight", inFlight());
  setLog(log);
  logChat(log[440].actor, "#441", "", { seq: 441, ts: log[440].ts });
  check("precondition: the live line trimmed #1–#41", shownIn(logEl)[0] === "#42", shownIn(logEl)[0]);
  release(); await settle();
  check("the old walk's empty page doesn't declare the beginning", !logEl.textContent!.includes("beginning of this world"));
  check("…and the same scroll-up walks on from the restart, bringing back #2–#41",
    shownIn(logEl)[0] === "#2" && rowsOf(logEl).length === 440, `${shownIn(logEl)[0]}, ${rowsOf(logEl).length} rows`);
  await scrollToTop(logEl);
  const final = shownIn(logEl);
  check("scrolling up brings #1–#41 back: every say once, in order",
    final.length === 441 && isSorted(final) && final[0] === "#1", `${final.length}, first ${final[0]}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
