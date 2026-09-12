// chat log — the spoken-utterance merge and unread accounting, run headless.
//
//   bun tools/chat-log-test.ts
//
// This exists because logChat's merge fast-path once keyed on nothing but
// "agent + same author + 15 seconds", which collapsed ordinary agent chat
// into unrelated rows and skipped the unread/mention counters entirely
// (found in review, PR#7). The contract now: a row merges ONLY as the
// continuation of one spoken utterance (spoken:true + author + utt), a
// mention arriving in a merged sentence counts exactly like one arriving
// as its own row, and `t0` may reorder display only inside the spoken
// protocol's bounded window.

import { plugin } from "bun";
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({
  name: "chat-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here("./chat-core-stub.mjs") }));
    // rimward: CONFIG/bus/report live in base.js (the renderer-free substrate) — same stub, or the
    // test's CONFIG.name never reaches chat.js and every mention assertion passes vacuously (PR #160 B6)
    b.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here("./chat-base-stub.mjs") }));
    b.onResolve({ filter: /^\.\/frames\.js$/ }, () => ({ path: here("./chat-frames-stub.mjs") }));
    b.onResolve({ filter: /^\.\/net\.js$/ }, () => ({ path: here("./chat-net-stub.mjs") }));
  },
});

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

const { logChat, logWhisper, initChat, chat } = await import("../client/lib/chat.js");
const { frameStub } = await import("./chat-frames-stub.mjs");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

// A self row + two others: the self row exercises the "no whispering yourself"
// skip, and two others let a DM tab open for each.
const whispers: any[] = [];
initChat({
  send: () => {},
  whisper: (to: string, text: string) => whispers.push({ to, text }),
  people: () => [{ id: "me", me: true }, { id: "keir", agent: true }, { id: "mica" }],
});
const log = () => document.getElementById("chatlog")!;
const rows = () => [...log().children].filter((c) => !c.classList.contains("sys"));
const texts = () => rows().map((r) => r.querySelector(".body")?.textContent);
const reset = () => { log().innerHTML = ""; chat.markRead?.(); };

// --- one spoken utterance -> one durable row (flush + continuation merge)
let ts = Date.now();
logChat("keir", "First aired half —", "agent", { seq: 1, ts, spoken: true, utt: 7, t0: ts - 3000 });
logChat("keir", "and the finish.", "agent", { seq: 2, ts: ts + 400, spoken: true, utt: 7 });
check("one utterance, two says, ONE row", rows().length === 1, `${rows().length} rows`);
check("merged row reads as a paragraph",
  texts()[0]?.includes("First aired half") && texts()[0]?.includes("and the finish."), texts()[0] ?? "");

// --- two distinct utterances stay two rows
logChat("keir", "A new thought.", "agent", { seq: 3, ts: ts + 900, spoken: true, utt: 8 });
check("a NEW utt is a new row", rows().length === 2, `${rows().length} rows`);

// --- ordinary agent says never merge (the review's core regression)
reset();
logChat("keir", "tool output one", "agent", { seq: 4, ts });
logChat("keir", "tool output two", "agent", { seq: 5, ts: ts + 100 });
check("ordinary agent says keep their own rows", rows().length === 2, `${rows().length} rows`);

// --- an interrupter breaks the continuation chain
reset();
logChat("keir", "I was saying —", "agent", { seq: 6, ts, spoken: true, utt: 9, t0: ts - 2000 });
logChat("rab", "wait!", "", { seq: 7, ts: ts + 100 });
logChat("keir", "…as I was saying.", "agent", { seq: 8, ts: ts + 200, spoken: true, utt: 9 });
check("continuation after an interrupter is its own row (no cross-merge)",
  rows().length === 3, `${rows().length} rows`);

// --- merged mention hits the counters exactly once while hidden
reset();
frameStub.visible = false;
logChat("keir", "quiet start", "agent", { seq: 9, ts, spoken: true, utt: 10 });
const before = chat.unreadCounts?.() ?? null;
logChat("keir", "hey tester, look", "agent", { seq: 10, ts: ts + 300, spoken: true, utt: 10 });
const after = chat.unreadCounts?.() ?? null;
check("mention in a merged sentence counts while away",
  after && before && after.mentions === before.mentions + 1,
  JSON.stringify({ before, after }));
check("merged sentence does not double-count unread rows",
  after && before && after.unread === before.unread,
  JSON.stringify({ before, after }));
frameStub.visible = true;

// --- t0 reorders only inside the spoken protocol's bounded window
reset();
ts = Date.now();
logChat("rab", "the interrupt", "", { seq: 11, ts: ts - 1000 });
logChat("keir", "speech that began first", "agent",
  { seq: 12, ts, spoken: true, utt: 11, t0: ts - 5000 });
check("valid spoken t0 slots the speech before the interrupt",
  texts()[0] === "speech that began first", JSON.stringify(texts()));

reset();
logChat("rab", "later line", "", { seq: 13, ts: ts - 1000 });
logChat("keir", "malicious ancient t0", "agent",
  { seq: 14, ts, spoken: true, utt: 12, t0: 1 });
check("out-of-window t0 cannot rewrite history order",
  texts()[1] === "malicious ancient t0", JSON.stringify(texts()));

reset();
logChat("rab", "later line", "", { seq: 15, ts: ts - 1000 });
logChat("keir", "unspoken t0 smuggle", "", { seq: 16, ts, t0: ts - 5000 });
check("t0 outside the spoken protocol is ignored",
  texts()[1] === "unspoken t0 smuggle", JSON.stringify(texts()));

// --- REGRESSION (#27 review): an inserted line derives its grouping from its
// VISUAL neighbor, not chronological arrival — and the displaced anchor
// reprints its name. All three fail on main (buildLine keys cont off
// lastAuthor; nothing re-derives after a t0 insert).
reset();
ts = Date.now();
logChat("rab", "alpha", "", { seq: 20, ts: ts - 4000 });
logChat("keir", "beta later", "agent", { seq: 21, ts: ts - 1000 });
logChat("keir", "aired earlier", "agent", { seq: 22, ts, spoken: true, utt: 20, t0: ts - 3000 });
check("stale-attribution setup: t0 insert lands between the speakers",
  texts()[1] === "aired earlier", JSON.stringify(texts()));
check("inserted line under ANOTHER speaker is NOT cont (nameplate reprints)",
  !rows()[1].classList.contains("cont"),
  `cont=${rows()[1].classList.contains("cont")} — keir's words would render under rab's nameplate`);

reset();
logChat("keir", "one", "agent", { seq: 25, ts: ts - 4000 });
logChat("rab", "later", "", { seq: 26, ts: ts - 1000 });
logChat("keir", "aired mid-thought", "agent", { seq: 27, ts, spoken: true, utt: 21, t0: ts - 3000 });
check("inserted line under the SAME speaker stays cont (no duplicate nameplate)",
  rows()[1].classList.contains("cont"),
  `cont=${rows()[1].classList.contains("cont")} though visual predecessor is keir`);

reset();
logChat("keir", "first", "agent", { seq: 30, ts: ts - 4000 });
logChat("keir", "second", "agent", { seq: 31, ts: ts - 1000 });
check("pre-insert: second groups under first", rows()[1].classList.contains("cont"));
logChat("rab", "spoken wedge", "", { seq: 32, ts, spoken: true, utt: 22, t0: ts - 3000 });
check("displaced anchor reprints its name when a different speaker wedges in",
  texts()[1] === "spoken wedge" && !rows()[2].classList.contains("cont"),
  JSON.stringify({ order: texts(), anchorCont: rows()[2].classList.contains("cont") }));


// ============================================================ DMs and the tab strip
// R, 2026-09-11: "Did we ever verify that DMs work and sort correctly in the
// chat bar? Or can you double-click on a name in the People Here pane and have a
// DM tab show up correctly". The machinery existed — convos, openConvo,
// setFilter('w:<name>'), per-convo unread, dataset.convo filtering — and NOTHING
// drove it. This is that coverage.
console.log("\nCHAT — DMs, the People Here pane, and the tab strip");
const tabs = () => frameStub.body!.querySelector(".chat-tabs") as HTMLElement;
// strip the close glyph: a DM tab now carries a visible × inside the button
const tabLabels = () => [...tabs().querySelectorAll(".tabscroll button")].map((b: any) => b.textContent.replace(/\u00d7/g, "").trim());
const openPane = () => (frameStub.body!.querySelector(".chat-side-tog") as HTMLElement)?.click();

check("the tab strip starts with the three fixed tabs", tabLabels().join("|") === "all|mentions|system", tabLabels().join("|"));
check("tabs live INSIDE the scroller, the gear outside it",
  !!tabs().querySelector(".tabscroll") && !!tabs().querySelector(":scope > .chat-gear") && !tabs().querySelector(".tabscroll .chat-gear"));
check("both scroll arrows exist", tabs().querySelectorAll(".tabarrow").length === 2);

// an inbound whisper opens a conversation, files the line, and bumps unread
logWhisper({ from: "keir", to: "me", text: "psst" });
check("an inbound whisper opens its tab", tabLabels().includes("@keir 1"), tabLabels().join("|"));
const wline = [...log().children].find((l: any) => l.dataset.convo === "keir");
check("...and files the line under that conversation", !!wline, "no line with dataset.convo=keir");
check("...and it renders as a whisper", !!wline?.classList.contains("whisper"));

// the People Here pane: double-click a name -> that DM tab
openPane();
const rows2 = () => [...frameStub.body!.querySelectorAll(".chat-side-list .who-row")];
check("the People Here pane lists everyone", rows2().length === 3, `${rows2().length} rows`);
// A BUTTON, not a div — this IS the fix. frames.js:_contentClaims exempts only
// BUTTON/INPUT/TEXTAREA/SELECT/A from the frame's drag surface, so a div row was
// claimed by the frame's pointerdown and the dblclick never arrived. R,
// 2026-09-11: "the Chat panel treats names in the roster as a
// grab-and-move-the-pane surface". The previous dblclick assertion passed
// against a div, so it could not see this at all.
check("each roster row is a BUTTON, so the frame cannot claim it as a drag surface",
  rows2().every((r: any) => r.tagName === "BUTTON"), rows2().map((r: any) => r.tagName).join(","));
const mica = rows2().find((r: any) => r.querySelector(".n")?.textContent?.trim() === "mica") as HTMLElement;
mica?.dispatchEvent(new Event("dblclick", { bubbles: true }));
check("double-clicking a name opens ITS DM tab", tabLabels().includes("@mica"), tabLabels().join("|"));

// ...but not your own row
const selfRow = rows2().find((r: any) => r.classList.contains("self")) as HTMLElement;
const tabsBefore = tabLabels().length;
selfRow?.dispatchEvent(new Event("dblclick", { bubbles: true }));
check("double-clicking YOURSELF opens nothing", tabLabels().length === tabsBefore, tabLabels().join("|"));

// SORTING: a DM tab shows only that conversation
(tabs().querySelector(".tabscroll button:last-child") as HTMLElement)?.click();
const visible = () => [...log().children].filter((l: any) => !l.classList.contains("filtered"));
logWhisper({ from: "keir", to: "me", text: "second" });
logChat("keir", "a room line", "agent", { seq: 99, ts: Date.now() });
const micaTab = [...tabs().querySelectorAll(".tabscroll button")].find((b: any) => b.textContent.includes("@keir")) as HTMLElement;
micaTab?.click();
check("a DM tab shows only that conversation",
  visible().every((l: any) => l.dataset.convo === "keir"), visible().map((l: any) => l.dataset.convo ?? "(room)").join(","));
const allTab = tabs().querySelector(".tabscroll button") as HTMLElement;
allTab?.click();
check("...and `all` shows the room again",
  visible().some((l: any) => !l.dataset.convo), visible().map((l: any) => l.dataset.convo ?? "(room)").join(","));

// CLOSING A TAB. R, 2026-09-11: "there should be a way of getting rid of extra
// tabs you don't want." Right-click already worked and announced itself only in
// a title attribute, so a DM tab now carries a visible x as well.
// THE ACTIVE TAB IS SCROLLED INTO VIEW. R's screenshot showed `system| @H` —
// the open whisper clipped to two characters while `all` and `mentions` held the
// full left. R, 2026-09-11: "should probably always preferentially display the
// tab that it's on".
//
// The PIXELS are unbindable here and I checked that BEFORE writing this:
// happy-dom performs no layout, so a deliberately overflowing row reports
// scrollWidth=0 clientWidth=0 and scrollIntoView leaves scrollLeft at 0. What IS
// bindable is the mechanism — that setFilter finds the active tab and asks for
// it. Verified separately in real Chromium (clipped by 44px before, fully
// visible after).
{ const calls: string[] = [];
  const proto = (globalThis as any).HTMLElement?.prototype;
  const orig = proto?.scrollIntoView;
  if (proto) proto.scrollIntoView = function () { calls.push((this as HTMLElement).textContent?.trim() ?? "?"); };
  const sysTab = [...tabs().querySelectorAll(".tabscroll button")].find((b: any) => b.textContent.includes("system")) as HTMLElement;
  sysTab?.click();
  check("switching tabs asks the ACTIVE one to scroll into view",
    calls.some((t) => t.includes("system")), JSON.stringify(calls));
  if (proto) proto.scrollIntoView = orig; }

{ const keirTab = [...tabs().querySelectorAll(".tabscroll button")].find((b: any) => b.textContent.includes("@keir")) as HTMLElement;
  const x = keirTab?.querySelector(".tabx") as HTMLElement;
  check("a DM tab carries a visible close", !!x, keirTab?.innerHTML.slice(0, 80) ?? "(no tab)");
    // A DRAFT BELONGS TO ITS DESTINATION (antra-tess #185 rereview B3). Typing in a
    // conversation tab and then closing it left the PRIVATE line in the box while
    // the destination became public — reproduced in the real client before the
    // fix: the canary went out as {verb:"say"}. The draft must be typed INSIDE the
    // DM for this to mean anything; my first version typed it while `system` was
    // active and then blamed the DM close, which asserted the wrong rule — a
    // public draft rightly survives an unrelated tab closing.
    keirTab?.click();
    const inp = document.querySelector("#chatline") as HTMLInputElement;
    const SECRET = "DRAFT_MUST_NOT_SURVIVE_CLOSE";
    inp.value = SECRET;
  x?.click();
  check("...and clicking it removes that tab", !tabLabels().some((t: string) => t.includes("@keir")), tabLabels().join("|"));
  check("...and the fixed tabs are untouched",
    tabLabels().slice(0, 3).join("|") === "all|mentions|system", tabLabels().join("|")); }

  { // A CLOSED CONVERSATION'S PARKED DRAFT MUST NOT COME BACK (antra #185 B3).
    // The two checks that stood here were VACUOUS: closing the ACTIVE tab goes
    // through setFilter, which parks and clears the box on the way in, so the
    // input was already empty at assertion time and BOTH mutations — removing
    // drafts.delete(key), and removing the active-close clear — still returned
    // 33/33. The only observable drafts.delete(key) controls is the parked draft
    // RETURNING, so this reopens the conversation and looks.
    const inp = document.querySelector("#chatline") as HTMLInputElement;
    const SECRET = "PARKED_DRAFT_MUST_NOT_RETURN";
    const mica = [...tabs().querySelectorAll(".tabscroll button")].find((b: any) => b.textContent.includes("@mica")) as HTMLElement;
    check("the @mica tab is present for the parked-draft check", !!mica, tabLabels().join("|"));
    mica?.click();                     // into the private conversation
    inp.value = SECRET;                // a draft that belongs to @mica
    const allTab = [...tabs().querySelectorAll(".tabscroll button")].find((b: any) => b.textContent.trim().startsWith("all")) as HTMLElement;
    allTab?.click();                   // switch away -> setFilter PARKS it
    (mica?.querySelector(".tabx") as HTMLElement)?.click();   // close from the BACKGROUND
    mica?.click();                     // try to return to it
    check("a closed conversation's parked draft does not come back",
      inp.value !== SECRET, `input=${JSON.stringify(inp.value)}`);
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    check("...and nothing carrying those bytes is sent afterwards",
      !whispers.some((w: any) => String(w?.text).includes(SECRET)), JSON.stringify(whispers.slice(-2))); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
