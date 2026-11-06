// last-world-test — a person goes back to the last world they were in, headless.
//
//   bun tools/last-world-test.ts
//
// A bare link (a bookmark, the login's return to '/') used to mean the commons
// whatever world you had been in. Now base.js pickWorld chooses ?world=, else the
// world this TAB was last in (so a reload stays put whatever other tabs joined),
// else the world this browser was last IN as a person, else the commons; net.js
// writes that memory at the door's yes (not for a world nobody has built in: a typo
// founds one); and a door that refuses a remembered world forgets it, and (when the
// memory, not the link, brought the page there and it never got in) takes the person
// to the commons. Pinned here: the choice itself; that index.html's early-socket copy
// of it agrees, and that its boot tripwire keys on the world chosen, both extracted
// from the served HTML rather than copied; and the real net.js writing and
// forgetting, a fresh process per page load with only the DOM-touching UI modules
// stubbed.

import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = join(import.meta.dir, "..");

// ---- the choice ---------------------------------------------------------------------
console.log("pickWorld");
const { pickWorld } = await import("../client/lib/base.js");
const P = (q: string) => new URLSearchParams(q);
const CASES: [string, string | null, string | null, string, boolean][] = [
  // search, the browser's last world, this tab's, → world, remembered
  ["", null, null, "commons", false],
  ["", "garden", null, "garden", true],
  ["?world=lab", "garden", null, "lab", false],
  ["?world=lab", null, null, "lab", false],
  ["?world=", "garden", null, "garden", true],                       // an empty ?world= names nothing
  ["?spectate", "garden", null, "commons", false],
  ["?renderer&roam", "garden", null, "commons", false],
  ["?mintthumbs", "garden", null, "commons", false],
  ["?spectate&world=lab", "garden", null, "lab", false],
  ["?name=helen&avatar=claude", "garden", null, "garden", true],     // other params do not change it
  ["", "../etc", null, "commons", false],                             // a value no world can have is ignored
  ["", "x".repeat(65), null, "commons", false],
  ["", "", null, "commons", false],
  ["", "lab", "garden", "garden", true],                             // this tab's world beats the browser's
  ["", null, "garden", "garden", true],
  ["?world=lab", "x", "garden", "lab", false],                       // …and the link beats both
  ["?spectate", null, "garden", "commons", false],
  ["", "lab", "../bad", "lab", true],                                // a bad tab value falls through
];
const label = (q: string, last: string | null, tab: string | null) => `"${q}" last ${JSON.stringify(last)} tab ${JSON.stringify(tab)}`;
for (const [q, last, tab, world, remembered] of CASES) {
  const got = pickWorld(P(q), last, tab);
  check(`${label(q, last, tab)} → ${world}${remembered ? " (from memory)" : ""}`,
    got.world === world && got.remembered === remembered, JSON.stringify(got));
}

{
  const { isWorldName } = await import("../client/lib/base.js");
  check("isWorldName: the server's rule (letters, digits, _ -, 1–64)",
    isWorldName("garden") && isWorldName("Roam-lobby_1") && isWorldName("x".repeat(64))
      && !isWorldName("") && !isWorldName("x".repeat(65)) && !isWorldName("../etc") && !isWorldName("a b") && !isWorldName(null));
}

// ---- what counts as built -----------------------------------------------------------------
// net.js builtIn decides what is remembered and forgotten, and main.js's empty-world
// notice asks it too. Imported in a child process: net.js pulls UI modules that need stubs.
console.log("builtIn");
{
  const L = join(ROOT, "client/lib") + "/";
  const r = Bun.spawnSync(["bun", "-e", `
    const { mock } = await import("bun:test");
    const L = ${JSON.stringify(L)};
    mock.module(L + "presence.js", () => ({ presence: {} }));
    mock.module(L + "chat.js", () => ({ logChat() {}, logWhisper() {}, noteTyping() {}, noteHistoryContext() {}, resyncChatAfter() {} }));
    mock.module(L + "boot.js", () => ({ markPhase() {} }));
    const { builtIn } = await import(L + "net.js");
    console.log(JSON.stringify([{}, { entities: {} }, { entities: { a: {} } }, { terrain: { seed: 1 } }, { grass: { density: 1 } }, { sky: { hours: 8 } }, null].map(builtIn)));`],
    { stdout: "pipe", stderr: "pipe" });
  const got = r.stdout.toString().trim().split("\n").pop();
  check("builtIn: nothing / no entities / an entity / ground / grass / sky / no state",
    got === JSON.stringify([false, false, true, true, true, true, false]), got ?? r.stderr.toString().slice(0, 300));
  const main = readFileSync(join(ROOT, "client/main.js"), "utf8");
  check("main.js's empty-world notice asks builtIn, as the memory does",
    /bus\.on\('hydrated', \(\) => \{[\s\S]{0,400}?builtIn\(worldState\.st\)\) return;\s*\n\s*logChat\('\*', emptyWorldNotice\(CONFIG\)\)/.test(main));
}

// ---- what arriving in an empty world says ------------------------------------------------
console.log("emptyWorldNotice");
{
  const { emptyWorldNotice } = await import("../client/lib/base.js");
  const say = (q: string, world: string, worldRemembered: boolean) => emptyWorldNotice({ world, params: P(q), worldRemembered });
  check("named by the link: nothing has ever been built here", say("?world=gardn", "gardn", false).includes("nothing has ever been built"));
  check("a memory chose it: says so, and how to reach the commons",
    say("", "garden", true).includes("the last world you were in") && say("", "garden", true).includes("?world=commons"));
  check("an empty ?world= names nothing: the memory's words, as pickWorld reads it",
    say("?world=", "garden", true).includes("the last world you were in"));
  check("the commons, remembered and empty, is not told to go to the commons",
    !say("", "commons", true).includes("?world=commons") && say("", "commons", true).includes("which is empty"));
  check("the commons by default: the plain words", say("", "commons", false).includes(`you are in "commons", which is empty`));
}

// ---- index.html's copy agrees ---------------------------------------------------------
// The early socket joins before any module loads, so it cannot import pickWorld; it
// makes the same choice inline and publishes __ewWorld, which base.js CONFIG takes. Run
// the real script with no name stored, so it publishes and returns before opening a socket.
console.log("index.html early-socket script");
const html = readFileSync(join(ROOT, "client/index.html"), "utf8");
const m = html.match(/<script>(?:(?!<\/script>)[\s\S])*?__ewEarlySocket[\s\S]*?<\/script>/);
check("found the early-socket script", !!m);
const storeOf = (entries: [string, string | null][]) => {
  const mem = new Map(entries.filter((e): e is [string, string] => e[1] !== null));
  return { getItem: (k: string) => mem.get(k) ?? null, setItem() {}, removeItem() {} };
};
const inline = (q: string, last: string | null, tab: string | null) => {
  const g: Record<string, unknown> = {
    location: { search: q, protocol: "http:", host: "x" },
    localStorage: storeOf([["ew-world", last]]),
    sessionStorage: storeOf([["ew-world-tab", tab]]),
  };
  g.globalThis = g;
  new Function("globalThis", "location", "localStorage", "sessionStorage", "URLSearchParams", m![0].replace(/^<script>/, "").replace(/<\/script>$/, ""))
    (g, g.location, g.localStorage, g.sessionStorage, URLSearchParams);
  return g.__ewWorld as { world: string; remembered: boolean } | undefined;
};
if (m) for (const [q, last, tab] of CASES) {
  const a = inline(q, last, tab), b = pickWorld(P(q), last, tab);
  check(`inline agrees on ${label(q, last, tab)}`, !!a && a.world === b.world && a.remembered === b.remembered,
    `inline ${JSON.stringify(a)} vs base ${JSON.stringify(b)}`);
}
{
  // and the early socket's join carries that world, when it does open one
  const mem = new Map([["ew-world", "garden"], ["ew-name-set", "1"], ["ew-name", "helen"]]);
  const sent: string[] = [];
  class WS { onopen?: () => void; constructor() { queueMicrotask(() => this.onopen?.()); } send(s: string) { sent.push(s); } close() {} }
  const g: Record<string, unknown> = {
    location: { search: "", protocol: "http:", host: "x" },
    localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem() {}, removeItem() {} },
    sessionStorage: storeOf([]),
    WebSocket: WS, crypto,
  };
  g.globalThis = g;
  if (m) new Function("globalThis", "location", "localStorage", "sessionStorage", "URLSearchParams", "WebSocket", m[0].replace(/^<script>/, "").replace(/<\/script>$/, ""))
    (g, g.location, g.localStorage, g.sessionStorage, URLSearchParams, WS);
  await Promise.resolve();
  const join = sent.map((s) => JSON.parse(s)).find((j) => j.type === "join");
  check("the early socket joins the remembered world", join?.world === "garden", JSON.stringify(join));
  check("…and stashes it for net.js to compare", (g.__ewEarlySocket as { sent?: { world?: string } })?.sent?.world === "garden");
}
// …and viewers never open one: spectators, renderers and the thumbnail minter take net.js's own path
if (m) for (const q of ["?spectate", "?renderer", "?renderer&roam", "?mintthumbs"]) {
  const mem = new Map([["ew-world", "garden"], ["ew-name-set", "1"], ["ew-name", "helen"]]);
  let opened = 0;
  class WS { constructor() { opened++; } send() {} close() {} }
  const g: Record<string, unknown> = {
    location: { search: q, protocol: "http:", host: "x" },
    localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem() {}, removeItem() {} },
    sessionStorage: storeOf([]), WebSocket: WS, crypto,
  };
  g.globalThis = g;
  new Function("globalThis", "location", "localStorage", "sessionStorage", "URLSearchParams", "WebSocket", m[0].replace(/^<script>/, "").replace(/<\/script>$/, ""))
    (g, g.location, g.localStorage, g.sessionStorage, URLSearchParams, WS);
  check(`${q}: no early socket`, opened === 0 && !g.__ewEarlySocket, `opened ${opened}`);
}

// ---- the boot tripwire keys on the world the page opens ------------------------------
// Lite/full is decided per world (a phone can hold an empty world but not the commons).
// Run the early-socket script, then the decideLite script, on one globalThis.
console.log("boot tripwire keys");
const lite = html.match(/<script>\s*\n\s*\/\/ decideLite[\s\S]*?<\/script>/);
check("found the decideLite script", !!lite);
const tripKeys = (q: string, last: string | null, tab: string | null = null) => {
  const g: Record<string, unknown> = {
    navigator: { deviceMemory: 8, gpu: {} },
    location: { search: q, protocol: "http:", host: "x" },
    localStorage: storeOf([["ew-world", last]]),
    sessionStorage: storeOf([["ew-world-tab", tab]]),
    addEventListener() {},
    document: { documentElement: { classList: { toggle() {} } }, head: { appendChild() {} }, createElement: () => ({}) },
    console: { log() {} },
  };
  g.globalThis = g;
  const run = (src: string) => new Function("globalThis", "navigator", "location", "localStorage", "sessionStorage", "document", "console", "URLSearchParams", "addEventListener",
    src.replace(/^<script>/, "").replace(/<\/script>$/, ""))(g, g.navigator, g.location, g.localStorage, g.sessionStorage, g.document, g.console, URLSearchParams, g.addEventListener);
  run(m![0]); run(lite![0]);
  const p = new URLSearchParams(q);
  return [(g.__ewTripKey as (p: URLSearchParams) => string)(p), (g.__ewRetryKey as (p: URLSearchParams) => string)(p)];
};
if (m && lite) {
  for (const [q, last, tab, key] of [
    ["", null, null, "default"],                 // the commons is 'default', as its bare link always was…
    ["", "commons", null, "default"],            // …also once it is remembered (a crash there is found next load)
    ["?world=commons", null, null, "default"],   // …and by name
    ["", "garden", null, "garden"],              // a remembered world keys on that world…
    ["?world=garden", null, null, "garden"],     // …the same key its link has
    ["", "lab", "garden", "garden"],             // this tab's world, when it chose
    ["?world=lab", "garden", null, "lab"],
    ["?spectate", "garden", null, "default"],
  ] as const) {
    const [trip, retry] = tripKeys(q, last, tab);
    check(`${label(q, last, tab)} keys the tripwire on ${key}`,
      trip === `ew-boot-attempt:${key}` && retry === `ew-boot-retried:${key}`, `${trip} / ${retry}`);
  }
}

// ---- net.js: written at the door's yes, forgotten at its no -----------------------------
console.log("net.js");
// "snapshot": the door's yes into a world with something built in it; "fresh": into one
// nobody has built in (what a mistyped name founds); "spawn": someone builds, live.
// {early: w}: the inline boot script's socket, which already sent a join to world w, for connect() to adopt
// only if that is byte-for-byte the join net.js would send. {set: [k, v]}: another tab writes localStorage.
// "ground": the door's yes into a world with ground and nothing placed. "authed": this page entered signed in.
type Step = "snapshot" | "fresh" | "ground" | "spawn" | "say" | "connect" | "timers" | "authed"
  | { close: number } | { early: string } | { set: [string, string] };
type Out = { world: string; stored: string | null; tab: string | null; reloads: number; toasts: string[]; sockets: number; authedReads: number };
function pageLoad(search: string, stored: string | null, steps: Step[], tab: string | null = null,
                  inline: { world: string; remembered: boolean } | null = null): Out {
  const L = join(ROOT, "client/lib") + "/";
  const code = `
    ${inline ? `globalThis.__ewWorld = ${JSON.stringify(inline)};   // the early-socket script's answer` : ""}
    const mem = new Map([["ew-name", "helen"]${stored === null ? "" : `, ["ew-world", ${JSON.stringify(stored)}]`}]);
    let reloads = 0;
    globalThis.location = { search: ${JSON.stringify(search)}, host: "x", pathname: "/", protocol: "http:", reload: () => { reloads++; } };
    let authedReads = 0;
    globalThis.localStorage = { getItem: (k) => { if (k === "ew-authed") authedReads++; return mem.get(k) ?? null; }, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
    const smem = new Map(${tab === null ? "" : `[["ew-world-tab", ${JSON.stringify(tab)}]]`});
    globalThis.sessionStorage = { getItem: (k) => smem.get(k) ?? null, setItem: (k, v) => smem.set(k, String(v)), removeItem: (k) => smem.delete(k) };
    globalThis.fetch = async () => ({ ok: false, json: async () => null });
    const sockets = [];
    globalThis.WebSocket = class { constructor() { sockets.push(this); this.readyState = 0; } send() {} close() {} };
    const timers = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => { timers.push(fn); return 0; };
    const { mock } = await import("bun:test");
    const L = ${JSON.stringify(L)};
    mock.module(L + "presence.js", () => ({ presence: {} }));
    mock.module(L + "chat.js", () => ({ logChat() {}, logWhisper() {}, noteTyping() {}, noteHistoryContext() {}, resyncChatAfter() {} }));
    mock.module(L + "boot.js", () => ({ markPhase() {} }));
    const net = await import(L + "net.js");
    const { CONFIG } = await import(L + "base.js");
    const toasts = [];
    net.wireNet({ toast: (m) => toasts.push(m) });
    net.net.ws = { send() {}, readyState: 1 };
    for (const s of ${JSON.stringify(steps)}) {
      if (s === "snapshot") await net._dispatch({ type: "snapshot", you: "helen", present: [], entries: [], state: { entities: { tree: { lib: "tree", pos: [0, 0, 0] } } } });
      else if (s === "fresh") await net._dispatch({ type: "snapshot", you: "helen", present: [], entries: [], state: {} });
      else if (s === "ground") await net._dispatch({ type: "snapshot", you: "helen", present: [], entries: [], state: { terrain: { seed: 7, size: 200 } } });
      else if (s === "authed") CONFIG.authed = true;
      else if (s === "spawn") await net._dispatch({ type: "log", entry: { seq: 1, actor: "helen", verb: "spawn", args: { id: "box1", lib: "box" } } });
      else if (s === "say") await net._dispatch({ type: "log", entry: { seq: 1, actor: "helen", verb: "say", args: { text: "hello?" } } });
      else if (s.early) {
        const ws = new globalThis.WebSocket(); ws.readyState = 1;
        globalThis.__ewEarlySocket = { ws, sent: { world: s.early, id: "helen", avatar: "", token: "" }, buffered: [], arrived: [], failed: false };
      }
      else if (s.set) mem.set(s.set[0], s.set[1]);
      else if (s === "connect") await net.connect();
      else if (s === "timers") timers.splice(0).forEach((f) => f());
      else sockets[sockets.length - 1].onclose({ code: s.close });
    }
    console.log(JSON.stringify({ world: CONFIG.world, stored: mem.get("ew-world") ?? null, tab: smem.get("ew-world-tab") ?? null, reloads, toasts, sockets: sockets.length, authedReads }));`;
  const r = Bun.spawnSync(["bun", "-e", code], { stdout: "pipe", stderr: "pipe" });
  try { return JSON.parse(r.stdout.toString().trim().split("\n").pop()!) as Out; }
  catch { return { world: `ERROR ${r.stderr.toString().slice(0, 400)}`, stored: null, tab: null, reloads: 0, toasts: [], sockets: 0, authedReads: 0 }; }
}
{
  const first = pageLoad("?world=garden", null, ["snapshot"]);
  check("a person let into ?world=garden remembers garden, for the browser and the tab",
    first.stored === "garden" && first.tab === "garden", JSON.stringify(first));
  const back = pageLoad("", first.stored, ["snapshot"]);
  check("…and a bare link next time goes to garden", back.world === "garden" && back.stored === "garden", JSON.stringify(back));
  const moved = pageLoad("?world=lab", "garden", ["snapshot"]);
  check("going somewhere else by link moves the memory there", moved.world === "lab" && moved.stored === "lab", JSON.stringify(moved));
  const never = pageLoad("", null, []);
  check("a browser that has been nowhere goes to the commons", never.world === "commons" && never.stored === null, JSON.stringify(never));

  const spec = pageLoad("?spectate&world=lab", "garden", ["snapshot"]);
  check("watching ?spectate&world=lab leaves the memory at garden, and pins no tab", spec.stored === "garden" && spec.tab === null, JSON.stringify(spec));
  const rend = pageLoad("?renderer&world=lab", "garden", ["snapshot"]);
  check("a renderer in lab leaves the memory at garden", rend.stored === "garden", JSON.stringify(rend));

  // a mistyped ?world= founds an empty world and is let in; it must not become home
  const typo = pageLoad("?world=gardn", "garden", ["fresh"]);
  check("let into an empty world (?world=gardn): the memory stays at garden", typo.stored === "garden", JSON.stringify(typo));
  const typoFirst = pageLoad("?world=gardn", null, ["fresh"]);
  check("…and a browser with no memory remembers nothing", typoFirst.stored === null, JSON.stringify(typoFirst));
  const newPlace = pageLoad("?world=atelier", "garden", ["fresh", "spawn"]);
  check("a new world is remembered the moment something is built in it", newPlace.stored === "atelier", JSON.stringify(newPlace));
  const chatter = pageLoad("?world=gardn", "garden", ["fresh", "say"]);
  check("…but not for something said in it: a say builds nothing", chatter.stored === "garden" && chatter.tab === null, JSON.stringify(chatter));
  // the memory only ever holds a world with something in it: one found empty is forgotten
  const wiped = pageLoad("", "garden", ["fresh"], "garden");
  check("a remembered world found empty (reset, wiped) is forgotten from tab and browser",
    wiped.stored === null && wiped.tab === null, JSON.stringify(wiped));
  check("…but the page stays in it: the person may be about to build", wiped.world === "garden" && wiped.reloads === 0, JSON.stringify(wiped));
  const ground = pageLoad("?world=meadow", "garden", ["ground"]);
  check("a world with ground and nothing placed counts as built: remembered", ground.stored === "meadow", JSON.stringify(ground));
  const keptGround = pageLoad("", "meadow", ["ground"], "meadow");
  check("…and a remembered one like it is not forgotten as empty", keptGround.stored === "meadow" && keptGround.tab === "meadow", JSON.stringify(keptGround));
  const rebuilt = pageLoad("", "garden", ["fresh", "spawn"]);
  check("…and building there remembers it again", rebuilt.stored === "garden", JSON.stringify(rebuilt));
  const linkedEmpty = pageLoad("?world=garden", "garden", ["fresh"]);
  check("an empty world by link is forgotten too, when it is the one remembered", linkedEmpty.stored === null, JSON.stringify(linkedEmpty));
  const watchEmpty = pageLoad("?spectate&world=garden", "garden", ["fresh"], "garden");
  check("a spectator finding garden empty leaves the person's memory alone",
    watchEmpty.stored === "garden" && watchEmpty.tab === "garden", JSON.stringify(watchEmpty));

  // tabs: each keeps its own world across a reload, whatever another tab joined since
  const tabA = pageLoad("", "lab", ["snapshot"], "garden");
  check("a tab in garden reloads into garden though another tab has since joined lab", tabA.world === "garden", JSON.stringify(tabA));
  check("…and, being the latest join, makes garden the browser's world again", tabA.stored === "garden" && tabA.tab === "garden", JSON.stringify(tabA));
  const newTab = pageLoad("", "lab", ["snapshot"]);
  check("a new tab (no tab memory) opens the browser's last world", newTab.world === "lab", JSON.stringify(newTab));

  // the door says no
  const shut = pageLoad("", "garden", ["connect", { close: 4010 }, "timers"]);
  check("a remembered world that refuses us (4010) is forgotten", shut.stored === null, JSON.stringify(shut));
  check("…and the page goes to the commons, once, saying why",
    shut.reloads === 1 && shut.toasts.some((t) => t.includes("commons")), JSON.stringify(shut));
  const early = pageLoad("", "garden", [{ early: "garden" }, "connect", { close: 4010 }, "timers"]);
  check("through the adopted early socket (a returning person's usual path): adopted, not replaced",
    early.sockets === 1, JSON.stringify(early));
  check("…and its 4010 forgets garden and goes to the commons, once",
    early.stored === null && early.reloads === 1 && early.toasts.some((t) => t.includes("the commons")), JSON.stringify(early));
  // the early socket's world and net.js's agree, so it is adopted (no arrive → leave → arrive)
  const adopt = pageLoad("", "garden", [{ early: "garden" }, "connect"]);
  check("a bare link to remembered garden: net.js adopts the early socket's join to garden", adopt.sockets === 1 && adopt.world === "garden", JSON.stringify(adopt));
  const inlineWins = pageLoad("", "lab", [{ early: "garden" }, "connect"], null, { world: "garden", remembered: true });
  check("CONFIG takes the early-socket script's answer over re-reading storage, and adopts its socket",
    inlineWins.world === "garden" && inlineWins.sockets === 1, JSON.stringify(inlineWins));
  const mismatch = pageLoad("", "garden", [{ early: "lab" }, "connect"]);
  check("(control) an early join to another world is not adopted: a fresh socket replaces it", mismatch.sockets === 2, JSON.stringify(mismatch));

  // a reconnect is not an arrival: an old tab waking must not take the browser's memory back
  const stale = pageLoad("", "garden", ["snapshot", { set: ["ew-world", "lab"] }, "snapshot"], "garden");
  check("an old garden tab reconnecting after another tab joined lab leaves the browser's world at lab",
    stale.stored === "lab", JSON.stringify(stale));
  check("…while its own tab memory stays garden", stale.tab === "garden" && stale.world === "garden", JSON.stringify(stale));
  const built = pageLoad("?world=atelier", "garden", ["fresh", { set: ["ew-world", "lab"] }, "fresh", "spawn"]);
  check("a page whose world was empty at first writes the browser's memory once something is built, reconnects or not",
    built.stored === "atelier", JSON.stringify(built));

  const banned = pageLoad("", "garden", ["connect", { close: 4006 }, "timers"]);
  check("removed from a remembered world (4006): forgotten, off to the commons", banned.stored === null && banned.reloads === 1, JSON.stringify(banned));

  const linked = pageLoad("?world=garden", "garden", ["connect", { close: 4010 }, "timers"]);
  check("the LINK's world refusing us is forgotten too, but the page stays and says so",
    linked.stored === null && linked.reloads === 0 && linked.toasts.some((t) => t.includes("not in") && t.includes("reload if your access changes")), JSON.stringify(linked));
  const other = pageLoad("?world=lab", "garden", ["connect", { close: 4010 }, "timers"]);
  check("a refusal elsewhere leaves the memory of garden alone", other.stored === "garden" && other.reloads === 0, JSON.stringify(other));

  const tabShut = pageLoad("", "lab", ["connect", { close: 4010 }, "timers"], "garden");
  check("this tab's world refusing us is forgotten from the tab, the browser's lab kept",
    tabShut.tab === null && tabShut.stored === "lab", JSON.stringify(tabShut));
  check("…and the page goes where a bare link now leads, and says so: lab",
    tabShut.reloads === 1 && tabShut.toasts.some((t) => t.includes('"lab"')), JSON.stringify(tabShut));
  const bothShut = pageLoad("", "garden", ["connect", { close: 4010 }, "timers"], "garden");
  check("garden in both memories: both forgotten, off to the commons", bothShut.tab === null && bothShut.stored === null
    && bothShut.reloads === 1 && bothShut.toasts.some((t) => t.includes("the commons")), JSON.stringify(bothShut));
  const midway = pageLoad("", "garden", ["connect", "snapshot", { close: 4010 }, "timers"]);
  check("access ending mid-visit forgets garden but does not yank the page away",
    midway.stored === null && midway.reloads === 0, JSON.stringify(midway));
  check("…and says a reload now goes to the commons, and how to come back, not 'reload if your access changes'",
    midway.toasts.some((t) => t.includes("a reload now takes you to the commons") && t.includes("?world=garden"))
      && !midway.toasts.some((t) => t.includes("reload if your access changes")), JSON.stringify(midway));
  const kicked = pageLoad("", "garden", ["connect", "snapshot", { set: ["ew-world", "lab"] }, { close: 4006 }, "timers"], "garden");
  check("removed mid-visit from this tab's garden, after another tab joined lab: a reload now goes to lab, and says so",
    kicked.reloads === 0 && kicked.toasts.some((t) => t.includes('a reload now takes you to "lab"')), JSON.stringify(kicked));
  for (const q of ["?spectate&world=garden", "?renderer&world=garden"]) for (const code of [4010, 4006]) {
    const watch = pageLoad(q, "garden", ["connect", { close: code }, "timers"], "garden");
    check(`${q} refused (${code}) leaves the person's garden alone`, watch.stored === "garden" && watch.tab === "garden" && watch.reloads === 0, JSON.stringify(watch));
  }
  // identity did not come through on a browser that was signed in: the refusal may be about who, not where
  const noId = pageLoad("", "garden", [{ set: ["ew-authed", "1"] }, "connect", { close: 4010 }, "timers"], "garden");
  check("a browser that was signed in, refused while its identity failed to load: memory kept, page stays",
    noId.stored === "garden" && noId.tab === "garden" && noId.reloads === 0, JSON.stringify(noId));
  check("…with the plain words (a reload with identity back may get in)",
    noId.toasts.some((t) => t.includes("reload if your access changes")), JSON.stringify(noId));

  // logged out in another tab: this still-open tab must not write the person's world back
  const after = pageLoad("?world=atelier", null, ["authed", "fresh", "spawn"]);
  check("a signed-in page, its browser logged out since (no ew-authed), building in a new world remembers nothing",
    after.stored === null && after.tab === null, JSON.stringify(after));
  const busy = pageLoad("?world=atelier", null, ["authed", "snapshot", "spawn", "spawn", "spawn", "spawn"]);
  check("…and it decides that once per join: later live entries do not ask again",
    busy.stored === null && busy.authedReads === 1, JSON.stringify(busy));
  const keyed = pageLoad("?key=door1", "garden", [{ set: ["ew-authed", "1"] }, "connect", { close: 4010 }, "timers"], "garden");
  check("a door-key visitor on a browser once signed in: a refused remembered world is still forgotten (the key is its identity)",
    keyed.stored === null && keyed.tab === null && keyed.reloads === 1, JSON.stringify(keyed));
  const still = pageLoad("?world=atelier", null, ["authed", { set: ["ew-authed", "1"] }, "fresh", "spawn"]);
  check("(control) still signed in: the same page remembers atelier", still.stored === "atelier", JSON.stringify(still));

  const blip = pageLoad("", "garden", ["connect", { close: 1006 }, "timers"]);
  check("an ordinary disconnect forgets nothing", blip.stored === "garden" && blip.reloads === 0, JSON.stringify(blip));
}

// ---- logging out forgets where you have been -------------------------------------------
console.log("log out");
{
  const { forgetRememberedWorlds } = await import("../client/lib/base.js");
  const lm = new Map([["ew-world", "garden"], ["ew-name", "helen"]]), sm = new Map([["ew-world-tab", "garden"]]);
  const st = (m: Map<string, string>) => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => m.set(k, v), removeItem: (k: string) => m.delete(k) });
  const g = globalThis as Record<string, unknown>;
  const was = [g.localStorage, g.sessionStorage];
  g.localStorage = st(lm); g.sessionStorage = st(sm);
  forgetRememberedWorlds();
  [g.localStorage, g.sessionStorage] = was;
  check("forgetRememberedWorlds clears the browser's and the tab's world, and nothing else",
    !lm.has("ew-world") && !sm.has("ew-world-tab") && lm.get("ew-name") === "helen");
  // ui.js is the DOM shell and does not import headless; read logOut from source instead
  const ui = readFileSync(join(ROOT, "client/lib/ui.js"), "utf8");
  const logOut = ui.match(/async function logOut\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  // a statement of its own at the function's top level (two-space indent, not in a comment or a branch), before the reload
  check("ui.js logOut forgets the remembered worlds, unconditionally, then goes to the bare path",
    /\n  forgetRememberedWorlds\(\);[\s\S]*\n  location\.replace\(location\.pathname\);/.test(logOut), logOut.slice(0, 300));
  // a reload keeps ?world=, which would rejoin the logged-out person's world and remember it again
  check("…not a reload, which would keep ?world= and remember it again", !/location\.reload\(/.test(logOut), logOut.slice(-200));
  // and what that buys: the next bare load, in this tab or a new one, is the commons
  lm.set("ew-world", "garden"); sm.set("ew-world-tab", "garden");
  g.localStorage = st(lm); g.sessionStorage = st(sm);
  const { rememberedWorlds } = await import("../client/lib/base.js");
  forgetRememberedWorlds();
  const after = pickWorld(P(""), ...rememberedWorlds());
  [g.localStorage, g.sessionStorage] = was;
  check("after logging out, a bare link opens the commons", after.world === "commons" && !after.remembered, JSON.stringify(after));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
