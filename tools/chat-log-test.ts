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

import { fileURLToPath } from "node:url";
import { plugin } from "bun";
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
plugin({
  name: "chat-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here("./chat-core-stub.mjs") }));
    // rimward: CONFIG/bus/report live in base.js (the renderer-free substrate) — same stub, or the
    // test's CONFIG.name never reaches chat.js and every mention assertion passes vacuously (PR #160 B6)
    b.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here("./chat-base-stub.mjs") }));
    b.onResolve({ filter: /^\.\/windows\.js$/ }, () => ({ path: here("./chat-frames-stub.mjs") }));
    b.onResolve({ filter: /^\.\/net\.js$/ }, () => ({ path: here("./chat-net-stub.mjs") }));
  },
});

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

const { logChat, initChat, chat } = await import("../client/lib/chat.js");
const { frameStub } = await import("./chat-frames-stub.mjs");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

// A self row + two others: the self row exercises the "not yourself" skip of the
// People Here double-click (a mention now; it opened a DM tab until whisper was removed, R 10-18).
const says: any[] = [];   // the public say channel: everything typed into chat goes here (there is no other)
initChat({
  send: (text: string) => says.push(text),
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


// ============================================================ the People Here pane and the tab strip
// (R, 2026-09-11 asked for DM tabs to be driven here; they left with whisper, R 10-18, and this is what remains: the
// fixed tabs, the pane, and the double-click that now mentions.)
console.log("\nCHAT — the People Here pane, and the tab strip");
const tabs = () => frameStub.body!.querySelector(".chat-tabs") as HTMLElement;
const tabLabels = () => [...tabs().querySelectorAll(".tabscroll button")].map((b: any) => b.textContent.replace(/\u00d7/g, "").trim());
const openPane = () => (frameStub.body!.querySelector(".chat-side-tog") as HTMLElement)?.click();

check("the tab strip starts with the three fixed tabs", tabLabels().join("|") === "all|mentions|system", tabLabels().join("|"));
check("tabs live INSIDE the scroller; the tab row holds the tabs and the people chip only (no gear)",
  !!tabs().querySelector(".tabscroll") && !tabs().querySelector(".chat-gear")
    && [...tabs().children].every((c: any) => c.matches(".tabscroll, .tabarrow, .chat-who")), [...tabs().children].map((c: any) => c.className).join(","));
check("the gear sits at the right end of the compose row, after the line", (() => {
  const compose = frameStub.body!.querySelector(".chat-compose")!;
  const g = compose.querySelector(":scope > .chat-gear");
  return !!g && compose.lastElementChild === g && g.previousElementSibling?.id === "chatline";
})());
check("both scroll arrows exist", tabs().querySelectorAll(".tabarrow").length === 2);

// WHISPER WAS REMOVED (R 10-18): world chat has no private channel. A typed /w (or /r) is answered locally in words and
// sends nothing; there are no conversation tabs to open
{ const inp = document.querySelector("#chatline") as HTMLInputElement; const n0 = says.length;
  for (const line of ["/w keir psst", "/r hello"]) { inp.value = line; inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }
  const sys = [...log().children].filter((l: any) => l.classList.contains("sys")).map((l: any) => l.textContent).join(" | ");
  check("/w and /r are answered: whisper was removed, nothing is sent", says.length === n0 && (sys.match(/whisper was removed/g) ?? []).length === 2, JSON.stringify({ said: says.slice(n0), sys: sys.slice(-200) }));
  check("...and no conversation tab opens", tabLabels().join("|") === "all|mentions|system", tabLabels().join("|")); }

// the People Here pane: double-click a name -> a mention of them in the compose box (it opened a DM tab until R 10-18)
openPane();
{ // OPEN: the tab-row chip steps out and the column's header is the way back (a chevron toward the edge it collapses to)
  const chip = tabs().querySelector(":scope > .chat-who") as HTMLElement;
  const head = frameStub.body!.querySelector(":scope > .chat-cols > .chat-side > .chat-side-head") as HTMLElement;
  const left = frameStub.body!.querySelector(":scope > .chat-cols")!.classList.contains("side-left");
  check("open: the people chip is hidden", chip?.hidden === true);
  check("…and the column's header is a button whose chevron points at its edge", head?.getAttribute("role") === "button"
    && head.dataset.chev === (left ? "‹" : "›") && !/[‹›]/.test(head.textContent!), JSON.stringify({ role: head?.getAttribute("role"), chev: head?.dataset.chev, text: head?.textContent, left }));
  head.click();
  check("clicking the header closes the column and brings the chip back",
    frameStub.body!.querySelector(".chat-side")!.classList.contains("closed") && chip.hidden === false);
  (tabs().querySelector(":scope > .chat-who") as HTMLElement).click();
  check("…and the chip opens it again", !frameStub.body!.querySelector(".chat-side")!.classList.contains("closed"));
}
const rows2 = () => [...frameStub.body!.querySelectorAll(".chat-side-list .who-row")];
check("the People Here pane lists everyone", rows2().length === 3, `${rows2().length} rows`);
// A BUTTON, not a div — this IS the fix. windows.js:_contentClaims exempts only
// BUTTON/INPUT/TEXTAREA/SELECT/A from the frame's drag surface, so a div row was
// claimed by the frame's pointerdown and the dblclick never arrived. R,
// 2026-09-11: "the Chat panel treats names in the roster as a
// grab-and-move-the-pane surface". The previous dblclick assertion passed
// against a div, so it could not see this at all.
check("each roster row is a BUTTON, so the frame cannot claim it as a drag surface",
  rows2().every((r: any) => r.tagName === "BUTTON"), rows2().map((r: any) => r.tagName).join(","));
const mica = rows2().find((r: any) => r.querySelector(".n")?.textContent?.trim() === "mica") as HTMLElement;
const inpM = document.querySelector("#chatline") as HTMLInputElement; inpM.value = "";
mica?.dispatchEvent(new Event("dblclick", { bubbles: true }));
check("double-clicking a name puts a mention of them in the compose box, and opens no tab", inpM.value === "@mica " && tabLabels().join("|") === "all|mentions|system", JSON.stringify({ v: inpM.value, tabs: tabLabels() }));

// ...but not your own row
const selfRow = rows2().find((r: any) => r.classList.contains("self")) as HTMLElement;
inpM.value = "";
selfRow?.dispatchEvent(new Event("dblclick", { bubbles: true }));
check("double-clicking YOURSELF does nothing", inpM.value === "", JSON.stringify(inpM.value));

// SORTING: `mentions` shows the lines that name you; `all` shows the room
const visible = () => [...log().children].filter((l: any) => !l.classList.contains("filtered"));
logChat("keir", "a room line", "agent", { seq: 99, ts: Date.now() });
logChat("keir", "hey tester, look", "agent", { seq: 100, ts: Date.now() });
([...tabs().querySelectorAll(".tabscroll button")].find((b: any) => b.textContent.trim().startsWith("mentions")) as HTMLElement)?.click();
check("`mentions` shows only the lines that name you", visible().length > 0 && visible().every((l: any) => l.dataset.kind === "mention"), visible().map((l: any) => l.dataset.kind).join(","));
const allTab = tabs().querySelector(".tabscroll button") as HTMLElement;
allTab?.click();
check("...and `all` shows the room again", visible().some((l: any) => l.textContent.includes("a room line")), visible().length + " visible");

// THE ACTIVE TAB IS SCROLLED INTO VIEW. R's screenshot showed `system| @H` —
// the open tab clipped to two characters while `all` and `mentions` held the
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

// (CLOSING A TAB and A DRAFT BELONGS TO ITS DESTINATION — antra #185 B3 — were about conversation tabs, which left with
// whisper, R 10-18: every tab is a view of the one public room now, so there is no destination for a draft to leak from.)

// ============================================================ commands as lantern actions
console.log("\nCHAT — a command that acts on whoever is nearest fills the lantern's line; it never runs on a default");
{
  const A = await import("../client/lib/actions.js");
  for (const n of ["push", "touch", "punt"])
    check(`/${n} fills "/${n} " and has no run`, A.get(`cmd:${n}`)?.fill === `/${n} ` && typeof A.get(`cmd:${n}`)?.run !== "function",
      JSON.stringify({ fill: A.get(`cmd:${n}`)?.fill, run: typeof A.get(`cmd:${n}`)?.run }));
  check("/who (no target) still runs", typeof A.get("cmd:who")?.run === "function");
  check("/boom (acts where you stand) still runs", typeof A.get("cmd:boom")?.run === "function");
  check("/w is no lantern action (unlisted since whisper was removed)", A.get("cmd:w") === null);
}

// ============================================================ MODDING-UI §3: our own nodes by handle
console.log("\nCHAT — a mod's markup carrying the public classes is never mistaken for ours");
{
  const { bus } = await import("./chat-core-stub.mjs");
  // the side pane must be closed for the chip to show; paintTabs builds the real chip
  if (!frameStub.body!.querySelector(".chat-side")!.classList.contains("closed")) (frameStub.body!.querySelector(".chat-side-tog") as HTMLElement).click();
  const decoy = document.createElement("div");
  decoy.className = "chat-cols";
  decoy.innerHTML = '<div class="chat-main"><div class="chat-tabs"><button class="chat-who"></button></div></div>';
  frameStub.body!.prepend(decoy);
  const real = [...frameStub.body!.querySelectorAll(".chat-who")].find((c) => !decoy.contains(c)) as HTMLElement;
  real.innerHTML = "";
  bus.emit("roster");
  const dChip = decoy.querySelector(".chat-who") as HTMLElement;
  check("a roster repaint paints OUR people chip", /here|just you/.test(real.textContent ?? ""), real.textContent ?? "");
  check("…and leaves a mod's prepended .chat-who alone", dChip.innerHTML === "" && !dChip.hasAttribute("aria-expanded"), dChip.outerHTML);
  const ours = [...frameStub.body!.querySelectorAll(".chat-tabs")].find((t) => !decoy.contains(t))!;
  ([...ours.querySelectorAll(".tabscroll button")].find((b) => b.textContent!.trim().startsWith("system")) as HTMLElement)?.click();   // a tab change repaints the tab row
  check("a tab repaint builds into OUR tab row, not a mod's .chat-tabs", !decoy.querySelector(".tabscroll")
    && [...[...frameStub.body!.querySelectorAll(".chat-tabs")].find((t) => !decoy.contains(t))!.querySelectorAll(".tabscroll button.on")].some((b) => b.textContent!.startsWith("system")),
    decoy.innerHTML.slice(0, 120));
  decoy.remove();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
