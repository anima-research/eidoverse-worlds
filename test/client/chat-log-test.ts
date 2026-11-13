// chat log — the spoken-utterance merge and unread accounting, run headless.
//
//   bun test/client/chat-log-test.ts
//
// This exists because logChat's merge fast-path once keyed on nothing but
// "agent + same author + 15 seconds", which collapsed ordinary agent chat
// into unrelated rows and skipped the unread/mention counters entirely
// (found in review, PR#7). The contract now: a row merges ONLY as the
// continuation of one spoken utterance (spoken:true + author + utt), a
// mention arriving in a merged sentence counts exactly like one arriving
// as its own row, and `t0` may reorder display only inside the spoken
// protocol's bounded window.
// Also (merged from chat-markdown-test): inline markdown builds elements but never parses HTML out of a message,
// the VR quad's `recent` tail cap, account() unread/mention counting, and People Here side swapping against mod decoys.

import { fileURLToPath } from "node:url";
import { plugin } from "bun";
import { stubResolve } from "../harness/stub.ts";
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
plugin({
  name: "chat-stubs",
  setup(b) {
    // rimward: CONFIG/bus/report live in base.js (the renderer-free substrate) — stubbed, or the
    // test's CONFIG.name never reaches chat.js and every mention assertion passes vacuously (PR #160 B6)
    stubResolve(b, /^(\.\.?\/)+base\.js$/, () => ({ path: here("../stubs/chat-base-stub.mjs") }));
    stubResolve(b, /^(\.\.?\/)+windows\.js$/, () => ({ path: here("../stubs/chat-frames-stub.mjs") }));
    stubResolve(b, /^(\.\.?\/)+net\.js$/, () => ({ path: here("../stubs/chat-net-stub.mjs") }));
  },
});

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { suite } from "../gate/suite.ts";
GlobalRegistrator.register();

// seeded BEFORE the import: chat.js reads ew-chat-fs at module load, so the boot-moment row below can see it
localStorage.setItem("ew-chat-fs", "17");
// /version is asked once per page (client/lib/version.js): chat.js reads that answer, never a fetch of its own
const versionAsks: string[] = []; const realFetch = globalThis.fetch;
globalThis.fetch = ((u: any) => { if (String(u).includes("/version")) versionAsks.push(String(u)); return Promise.resolve(new Response('{"sha":"abcdef1234"}')); }) as any;
await import("../../client/lib/version.js");
const { logChat, initChat, chat, recentChat, chatMarkdownOn } = await import("../../client/lib/chat.js");
globalThis.fetch = realFetch;
const { frameStub } = await import("../stubs/chat-frames-stub.mjs");

const S = suite("chat-log");
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);
check("/version is fetched once: chat.js reads version.js's answer", versionAsks.length === 1, JSON.stringify(versionAsks));

// A self row + two others: the self row exercises the "not yourself" skip of the
// People Here double-click (a mention now; it opened a DM tab until whisper was removed, R 10-18).
const says: any[] = [];   // the public say channel: everything typed into chat goes here (there is no other)
let roster: any[] = [{ id: "me", me: true }, { id: "keir", agent: true }, { id: "mica" }];
initChat({ send: (text: string) => says.push(text), people: () => roster });
const log = () => document.getElementById("chatlog")!;
// the boot moment: applyChatPrefs runs inside initChat, so a log handle captured after it never gets the saved size
check("the saved text size is on the log the moment initChat returns", log().style.fontSize === "17px", `"${log().style.fontSize}" (seeded 17)`);
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
  const A = await import("../../client/lib/actions.js");
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
  const { bus } = await import("../stubs/chat-core-stub.mjs");
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

// --- /audio: the shipped report survives missing subsystems and names the real failures (one guarded probe each)
{
  const w = window as any;
  const audio = (install: () => void) => {
    for (const k of ["__voiceTransport", "__sfuMicOn", "relayDiag", "__voiceSpeakerEls"]) delete w[k];
    install();
    chat.submit("/audio");
    return [...log().querySelectorAll("*")].map((e) => e.textContent ?? "").filter((x) => x.startsWith("audio ▸")).at(-1) ?? "";
  };
  const a = audio(() => {});
  check("/audio with nothing initialised answers every probe", /transport: \(none/.test(a) && /mic: unknown/.test(a)
    && /ice: unknown \(no diag\)/.test(a) && /build: /.test(a) && !/unreadable/.test(a), a);
  const b = audio(() => { w.__voiceTransport = "sfu"; w.__sfuMicOn = () => true;
    w.relayDiag = () => ({ iceConnectionState: "checking", connectionState: "connecting" }); });
  check("/audio names an ICE stall", /mic: ON/.test(b) && /ice: checking \/ conn=connecting/.test(b), b);
  const c = audio(() => { w.__voiceSpeakerEls = () => [{ id: "keir", audio: { paused: true } }, { id: "mica", audio: { paused: true } }]; });
  check("/audio names an autoplay block and who is held", /playback: 2 — 0 playing, 2 paused {2}← keir, mica held/.test(c), c);
  const d = audio(() => Object.defineProperty(w, "__voiceTransport", { configurable: true, get() { throw new Error("boom"); } }));
  check("/audio: a throwing probe is said unreadable once and the rest still answer",
    (d.match(/unreadable/g) ?? []).length === 1 && /transport: unreadable \(boom\)/.test(d) && /mic: unknown/.test(d) && /build: /.test(d), d);
  delete w.__voiceTransport;
}

// ============================================================ markdown, the quad tail, account(), side swap (from chat-markdown-test)
{
const { bus: mdBus } = await import("../stubs/chat-base-stub.mjs");   // the stub graph's bus: chat.js resolves ./base.js here
roster = [{ id: 'keir', declares: 'agent' }, { id: 'rab' }];
reset(); frameStub.visible = true;
const mdRows = () => [...log().children].filter((c) => !c.classList.contains('sys')) as HTMLElement[];
const lastBody = () => mdRows().at(-1)!.querySelector('.body')!;
let seq = 1000;
const say = (who: string, text: string, kind = '') => { logChat(who, text, kind, { seq: seq++, ts: Date.now() }); return lastBody(); };

console.log('CHAT MARKDOWN — a message is text; markup in it is literal');
check('markdown is on by default', chatMarkdownOn() === true);
{ const b = say('rab', 'look <b>bold?</b> no');
  check('an HTML tag in a message is literal text (no <b> element)', b.querySelector('b') === null && b.textContent === 'look <b>bold?</b> no', b.innerHTML); }
{ const b = say('rab', '<img src=x onerror="alert(1)">');
  check('<img onerror> never becomes an element', b.querySelector('img') === null && b.textContent === '<img src=x onerror="alert(1)">', b.innerHTML);
  check('…and the log holds no <img> anywhere', log().querySelector('img') === null); }
{ const b = say('rab', 'x <script>1</script> **y** <i>z</i>');
  check('markup beside real markdown stays literal', b.querySelector('script') === null && b.querySelector('i') === null && b.querySelector('b')?.textContent === 'y' && b.textContent === 'x <script>1</script> y <i>z</i>', b.innerHTML); }
{ const b = say('rab', '@keir <b>hi</b> https://x.test/a?b=1 <u>u</u>');
  check('mention + link runs: tags around them are literal too', b.querySelector('.mention')?.textContent === '@keir' && (b.querySelector('a.lnk') as HTMLAnchorElement)?.href === 'https://x.test/a?b=1' && !b.querySelector('b') && !b.querySelector('u') && b.textContent === '@keir <b>hi</b> https://x.test/a?b=1 <u>u</u>', b.innerHTML); }

console.log('CHAT MARKDOWN — **bold** / *i* / _i_ / `code` become elements');
{ const b = say('rab', 'say **loud** and *soft* and _low_ and `code` end');
  const tags = [...b.children].map((c) => `${c.tagName.toLowerCase()}:${c.textContent}`).join(' ');
  check('b / i / i / code elements, delimiters consumed', tags === 'b:loud i:soft i:low code:code' && b.textContent === 'say loud and soft and low and code end', `${tags} | ${b.textContent}`); }
{ const b = say('rab', 'a `<b>x</b>` b');
  check('markup INSIDE a code span is literal text of the <code>', b.querySelector('code')?.textContent === '<b>x</b>' && b.querySelector('b') === null, b.innerHTML); }
{ const b = say('rab', 'snake_case_name and 2*3*4 and **');
  check('intra-word _ and * are not markdown', b.children.length === 0 && b.textContent === 'snake_case_name and 2*3*4 and **', b.innerHTML); }
{ // the gear's markdown toggle: off = plain text, on again = elements
  const gear = frameStub.body.querySelector('.chat-gear') as HTMLButtonElement;
  gear.onclick!(Object.assign(new Event('click'), { stopPropagation() {} }));
  const pop = frameStub.body.querySelector('.chat-gearpop') as HTMLElement;
  check('the gear opens its popover', pop.hidden === false && !!pop.querySelector('[data-md="0"]'));
  pop.onclick!({ target: pop.querySelector('[data-md="0"]') } as any);
  check('markdown off is observable', chatMarkdownOn() === false);
  const b = say('rab', '**still literal** <b>and still no element</b>');
  check('off: markdown stays literal AND markup stays literal', b.children.length === 0 && b.textContent === '**still literal** <b>and still no element</b>', b.innerHTML);
  pop.onclick!({ target: pop.querySelector('[data-md="1"]') } as any);
  check('back on', chatMarkdownOn() === true && say('rab', '**b**').querySelector('b')?.textContent === 'b'); }

console.log('CHAT — the VR quad\'s recent tail');
reset();
for (let i = 0; i < 20; i++) say('rab', `line ${i}`);
{ const r = recentChat();
  check('recent tail never exceeds 12', r.length === 12, `${r.length}`);
  check('…and holds the LAST twelve, newest last', r[0].text === 'line 8' && r[11].text === 'line 19' && r[11].who === 'rab', JSON.stringify(r.map((x: any) => x.text)));
  check('recentChat() is a copy', (r.push({}), recentChat().length === 12));
  say('rab', 'x'.repeat(200));
  check('a line is cut to 140 chars for the quad', recentChat().at(-1).text.length === 140); }

console.log('CHAT — account(): unread only while the reader is away');
reset(); frameStub.visible = true;
say('rab', 'seen'); say('keir', 'tester hi', 'agent');
check('frame visible + at bottom: nothing counts', JSON.stringify(chat.unreadCounts()) === '{"unread":0,"mentions":0}', JSON.stringify(chat.unreadCounts()));
frameStub.visible = false;
// a mod's #chat-jump mounted ahead of chat's: the counts must still land on chat's own pill
const decoyJump = document.createElement('button'); decoyJump.id = 'chat-jump'; document.body.prepend(decoyJump);
// a browser resolves an id in document order (the decoy); happy-dom in registration order (chat's), so the lookup is pinned
const byId = document.getElementById.bind(document); document.getElementById = (id: string) => (id === 'chat-jump' ? decoyJump : byId(id));
check('the decoy #chat-jump is the one a document lookup finds', document.getElementById('chat-jump') === decoyJump);
const realJump = [...document.querySelectorAll('#chat-jump')].find((e) => e !== decoyJump) as HTMLElement;
check('chat\'s own pill is in the document too', !!realJump);
say('rab', 'one'); say('rab', 'two');
check('two plain lines while hidden → unread 2, mentions 0', JSON.stringify(chat.unreadCounts()) === '{"unread":2,"mentions":0}', JSON.stringify(chat.unreadCounts()));
say('keir', 'hey @tester', 'agent');
check('a mention → unread 3, mentions 1', JSON.stringify(chat.unreadCounts()) === '{"unread":3,"mentions":1}', JSON.stringify(chat.unreadCounts()));
say('keir', 'Tester, bare whole word', 'agent');
check('a bare whole-word name is a mention too (case-insensitive) → mentions 2', chat.unreadCounts().mentions === 2, JSON.stringify(chat.unreadCounts()));
say('keir', 'testers are not you', 'agent');
check('a longer word is NOT a mention → mentions stay 2, unread 5', JSON.stringify(chat.unreadCounts()) === '{"unread":5,"mentions":2}', JSON.stringify(chat.unreadCounts()));
say('*', 'the world turns');
check('a system line never counts', chat.unreadCounts().unread === 5, JSON.stringify(chat.unreadCounts()));
say('tester', 'my own line');
check('my own line counts as unread but never as a mention of me', JSON.stringify(chat.unreadCounts()) === '{"unread":6,"mentions":2}', JSON.stringify(chat.unreadCounts()));
{ const jump = realJump;
  check('the jump pill shows the counts', jump.style.display === 'block' && /6 new/.test(jump.textContent!) && /2 ✱/.test(jump.textContent!) && jump.classList.contains('ping'), jump.textContent!);
  check('the decoy #chat-jump is untouched', decoyJump.textContent === '' && !decoyJump.style.display, decoyJump.textContent!); }
chat.markRead();
check('markRead zeroes both', JSON.stringify(chat.unreadCounts()) === '{"unread":0,"mentions":0}' && realJump.style.display === 'none');
decoyJump.remove(); document.getElementById = byId;
frameStub.visible = true;
say('rab', 'back');
check('visible again: nothing counts', chat.unreadCounts().unread === 0);

console.log('CHAT — People Here swaps sides');
{ // A DECOY mod panel first, carrying the same PUBLIC classes, placed BEFORE
  // the real markup in the same body — mods.js/registerPanel mount into frame
  // bodies after initChat's innerHTML, so this is reachable. applySide must
  // still write onto the nodes initChat built, not onto these.
  const decoy = document.createElement('div');
  decoy.innerHTML = `<div class="chat-cols side-left"><button class="chat-side-tog">X</button><div class="chat-side"></div></div>`;
  frameStub.body.prepend(decoy);
  const dCols = decoy.querySelector('.chat-cols')!, dTog = decoy.querySelector('.chat-side-tog')!;
  const dBefore = { cls: dCols.className, txt: dTog.textContent };

  const cols = frameStub.body.querySelector(':scope > .chat-cols')!, tog = cols.querySelector(':scope > .chat-side-tog')!;
  check('default: pane on the LEFT, closed, chevron points right (›)', cols.classList.contains('side-left') && cols.querySelector(':scope > .chat-side')!.classList.contains('closed') && tog.textContent === '›', tog.textContent!);
  const pop = frameStub.body.querySelector('.chat-gearpop') as HTMLElement;
  pop.onclick!({ target: pop.querySelector('[data-side="right"]') } as any);
  check('right: side-left dropped, chevron mirrored (‹)', !cols.classList.contains('side-left') && tog.textContent === '‹', tog.textContent!);
  check('the choice persists', JSON.parse(localStorage.getItem('ew-chat-side')!).pos === 'right');
  check('the popover marks the live side', pop.querySelector('[data-side="right"]')!.classList.contains('on') && !pop.querySelector('[data-side="left"]')!.classList.contains('on'));
  (tog as HTMLElement).onclick!(new Event('click'));
  check('opening the pane on the right: › (it will close rightward), width applied', tog.textContent === '›' && (cols.querySelector(':scope > .chat-side') as HTMLElement).style.width === '150px' && !cols.classList.contains('side-closed'), tog.textContent!);
  pop.onclick!({ target: pop.querySelector('[data-side="left"]') } as any);
  check('back to the left while open: side-left, chevron ‹', cols.classList.contains('side-left') && tog.textContent === '‹' && JSON.parse(localStorage.getItem('ew-chat-side')!).pos === 'left', tog.textContent!);
  const realSide = cols.querySelector(':scope > .chat-side')! as HTMLElement;

  // S1/F4: a mod's markup INSIDE the real .chat-side. My earlier claim that a
  // mod cannot reach here was FALSE — mods.js:88 hands a mod makeFrame and
  // windows.js returns the LIVE chat frame for a bare id, so a local mod (an
  // in-page ES module, mods.js:5-8) can mount into this very body. Planted
  // FIRST so an unbounded lookup finds it before the real head: the captures
  // must address the nodes initChat wrote, not the first match by class.
  const nestedMod = document.createElement('div');
  nestedMod.className = 'mod-inside';
  nestedMod.innerHTML = `<div class="chat-side"><div class="chat-side-head">MOD-HEAD</div></div>`;
  // PREPENDED INTO cols, ahead of the real .chat-side — not nested inside it.
  // A descendant of the real pane can never win an unbounded lookup (its own
  // ancestor comes first in document order), so nesting it would leave the
  // capture's `:scope >` bound untested.
  cols.prepend(nestedMod);
  // TWO decoys, because S1 and F4 mutate DIFFERENT hops and each is only
  // visible from its own position:
  //   F4 mutates the `side:` capture (cols.querySelector -> unbounded), so its
  //     decoy must be an earlier SIBLING inside cols — above.
  //   S1 mutates sideEl('head') -> side.querySelector('.chat-side-head'), which
  //     resolves from the captured pane, so its decoy must sit INSIDE the real
  //     .chat-side. A sibling is invisible to it.
  const insideMod = document.createElement('div');
  insideMod.className = 'mod-inside';
  insideMod.innerHTML = `<div class="chat-side-head">MOD-INNER-HEAD</div>`;
  realSide.prepend(insideMod);
  const innerHead = insideMod.querySelector('.chat-side-head')!;
  const modHead = nestedMod.querySelector('.chat-side-head')!;
  roster = [{ id: 'keir', declares: 'agent' }, { id: 'rab' }, { id: 'zzz' }];
  // The pane is OPEN here (the check above read a painted head). paintSide bails
  // at `if (!side || !sideSt.open) return`, so a closed pane would skip the very
  // lines S1/F4 mutate and both mutants would survive — which is exactly what
  // happened when this drove chat.open() (that opens the FRAME, not the pane).
  mdBus.emit('roster');                                    // the real trigger, chat.js:714
  check('a mod .chat-side-head nested inside the real pane is never written to (S1)',
    innerHead.textContent === 'MOD-INNER-HEAD', innerHead.textContent!);
  check('...nor the one a mod mounts as an earlier sibling', modHead.textContent === 'MOD-HEAD', modHead.textContent!);
  // Exactly 3 — an alternation that also accepts the pre-repaint text cannot fail.
  check('...and the REAL head is the one that got the update (F4)',
    realSide.querySelector(':scope > .chat-side-head')!.textContent === '3 others here',
    realSide.querySelector(':scope > .chat-side-head')!.textContent!);
  // applySide is what WRITES through the captured pane (classList 'closed' +
  // style.width); paintSide only truthiness-checks it. Worth pinning on its own
  // merits — but note what it does NOT cover: unbounding the `side:` capture is
  // an EQUIVALENT mutation, because `cols` is created by the innerHTML write one
  // statement above the capture block, so nothing can be inside it at that
  // instant. That equivalence holds only while capture stays in the block that
  // writes the markup; move it later and this needs a real binding.
  (tog as HTMLElement).onclick!(new Event('click'));          // close
  check('applySide writes through the CAPTURED pane, never a mod\'s .chat-side',
    realSide.classList.contains('closed') && !(nestedMod.querySelector('.chat-side') as HTMLElement).classList.contains('closed'),
    `real=${realSide.className} decoy=${(nestedMod.querySelector('.chat-side') as HTMLElement).className}`);
  (tog as HTMLElement).onclick!(new Event('click'));          // re-open for later blocks
  check('...and re-opening restores the real pane width', realSide.style.width === '150px' && !realSide.classList.contains('closed'), realSide.style.width);
  insideMod.remove();
  nestedMod.remove();

  // LIFETIME (M-L): a capture fixes WHICH node, not that it still EXISTS. A mod
  // can remove it; the handle stays valid, writes land on an orphan, nothing
  // renders, no error. Quieter than the node-theft the capture was added to
  // stop. sideEl reads through ?.isConnected, so a detached pane reads as
  // absent and paintSide bails at its first line instead of painting a ghost.
  const detached = realSide;
  const headBefore = detached.querySelector(':scope > .chat-side-head')!.textContent;
  detached.remove();
  roster = [{ id: 'keir', declares: 'agent' }, { id: 'rab' }, { id: 'zzz' }, { id: 'qqq' }];
  let threw = '';
  try { mdBus.emit('roster'); } catch (e) { threw = String(e); }
  check('a DETACHED side pane is not painted: the orphan keeps its last text, and no throw',
    threw === '' && detached.querySelector(':scope > .chat-side-head')!.textContent === headBefore,
    `threw=${threw} head=${detached.querySelector(':scope > .chat-side-head')!.textContent}`);
  cols.append(detached);                                  // put it back for later blocks
  // M-D: paintSide's `!sideSt.open` guard. bus.on('roster'|'presence:me')
  // (chat.js:714-715) call paintSide with NO open-check of their own, so
  // dropping it repaints a CLOSED pane on every roster event. (The 2s tick at
  // :716 gates itself on sideSt.open — it is not the path.)
  // paintSide returns early when closed — it does NOT clear. So the binding is
  // "the text does not CHANGE", not "the text is empty". (An earlier draft
  // asserted === '' and failed: my assertion presumed a clean slate that never
  // existed. The product was right; the test was wrong.)
  (tog as HTMLElement).onclick!(new Event('click'));          // close it
  const frozen = realSide.querySelector(':scope > .chat-side-head')!.textContent;
  roster = [{ id: 'keir', declares: 'agent' }, { id: 'rab' }, { id: 'zzz' }];   // a roster CHANGE while closed
  mdBus.emit('roster');                                   // the REAL trigger (chat.js:714)
  check('a CLOSED pane is not repainted (roster events must respect the open guard)',
    realSide.classList.contains('closed') && realSide.querySelector(':scope > .chat-side-head')!.textContent === frozen,
    `${realSide.className} / "${realSide.querySelector(':scope > .chat-side-head')!.textContent}" (was "${frozen}")`);
  (tog as HTMLElement).onclick!(new Event('click'));          // reopen for the decoy check
  // applySide/paintSide/applyChatPrefs must never have touched the decoy
  check('applySide writes onto the nodes initChat built, never a mod panel carrying the same classes', dCols.className === dBefore.cls && dTog.textContent === dBefore.txt, `${dCols.className} / ${dTog.textContent}`);

  // applyChatPrefs was the ONE reader addressing a node by class at call time
  // (`frame.body.querySelector('.chat-log')`), so a mod prepending .chat-log
  // won the query: the size landed on the decoy, persisted, and the real log
  // never changed — silently, no error. It now writes through the captured
  // logEl. This binds the HIJACK only: the decoy must not get the size and the
  // real log must. It does NOT bind the ordering bug the fix first shipped with
  // (logEl captured after initChatGear, so the boot-time applyChatPrefs was a
  // no-op) — by the time this block clicks +A, initChat has long returned and
  // logEl is set either way. Instrumented to confirm: under that mutation the
  // FIRST applyChatPrefs logs logEl=NULL and every later one logs logEl=set.
  // The boot moment needs its own assertion; claiming this one covered both
  // was wrong.
  const dLog = document.createElement('div'); dLog.className = 'chat-log';
  frameStub.body.prepend(dLog);                            // a mod's log, earlier sibling
  const realLog = frameStub.body.querySelector('#chatlog') as HTMLElement;
  const gear2 = frameStub.body.querySelector('.chat-gear') as HTMLButtonElement;
  gear2.onclick!(Object.assign(new Event('click'), { stopPropagation() {} }));
  const pop2 = frameStub.body.querySelector('.chat-gearpop') as HTMLElement;
  (pop2.querySelector('[data-fs="1"]') as HTMLButtonElement).click();   // +A
  check('the text size lands on the log initChat captured, and never on a mod .chat-log',
    realLog.style.fontSize !== '' && dLog.style.fontSize === '',
    `real="${realLog.style.fontSize}" decoy="${dLog.style.fontSize}"`);
  dLog.remove();
  decoy.remove(); }

console.log('MODERATOR NOTICE — a warning says where it came from, and its text is never a link (TEACHING-FINDINGS spoofing item 1)');
{ const { moderatorHeader } = await import('../../client/lib/chat.js') as any;
  check('the header names the world and disowns Eidoverse, fixed words', typeof moderatorHeader === 'function' && moderatorHeader('garden') === 'From a moderator of world ‹garden›, not from Eidoverse', String(moderatorHeader?.('garden')));
  const sysRows = () => [...log().children].filter((c) => c.classList.contains('sys')) as HTMLElement[];
  logChat('*', `${moderatorHeader?.('garden') ?? ''} — mod warned you: sign in again at https://eidoverse.example.evil/login`, '', { seq: seq++, ts: Date.now(), links: false });
  const b = sysRows().at(-1)!.querySelector('.body')!;
  check('a system line with links:false auto-links nothing; the address stays literal text', b.querySelector('a') === null && b.textContent!.includes('https://eidoverse.example.evil/login'), b.innerHTML);
  logChat('*', 'the house says https://eidoverse.example/docs', '', { seq: seq++, ts: Date.now() });
  check('…and an ordinary system line still links (the flag, not the kind, decides)', sysRows().at(-1)!.querySelector('a.lnk') !== null); }
}

S.done();
