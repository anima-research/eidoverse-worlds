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
type Step = "snapshot" | "fresh" | "spawn" | "say" | "connect" | { close: number } | "timers";
type Out = { world: string; stored: string | null; tab: string | null; reloads: number; toasts: string[] };
function pageLoad(search: string, stored: string | null, steps: Step[], tab: string | null = null): Out {
  const L = join(ROOT, "client/lib") + "/";
  const code = `
    const mem = new Map([["ew-name", "helen"]${stored === null ? "" : `, ["ew-world", ${JSON.stringify(stored)}]`}]);
    let reloads = 0;
    globalThis.location = { search: ${JSON.stringify(search)}, host: "x", pathname: "/", protocol: "http:", reload: () => { reloads++; } };
    globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
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
      else if (s === "spawn") await net._dispatch({ type: "log", entry: { seq: 1, actor: "helen", verb: "spawn", args: { id: "box1", lib: "box" } } });
      else if (s === "say") await net._dispatch({ type: "log", entry: { seq: 1, actor: "helen", verb: "say", args: { text: "hello?" } } });
      else if (s === "connect") await net.connect();
      else if (s === "timers") timers.splice(0).forEach((f) => f());
      else sockets[sockets.length - 1].onclose({ code: s.close });
    }
    console.log(JSON.stringify({ world: CONFIG.world, stored: mem.get("ew-world") ?? null, tab: smem.get("ew-world-tab") ?? null, reloads, toasts }));`;
  const r = Bun.spawnSync(["bun", "-e", code], { stdout: "pipe", stderr: "pipe" });
  try { return JSON.parse(r.stdout.toString().trim().split("\n").pop()!) as Out; }
  catch { return { world: `ERROR ${r.stderr.toString().slice(0, 400)}`, stored: null, tab: null, reloads: 0, toasts: [] }; }
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
  const wiped = pageLoad("", "garden", ["fresh"]);
  check("a remembered world that comes back empty (reset) is still where a bare link goes, and stays remembered",
    wiped.world === "garden" && wiped.stored === "garden" && wiped.reloads === 0, JSON.stringify(wiped));

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
  const banned = pageLoad("", "garden", ["connect", { close: 4006 }, "timers"]);
  check("removed from a remembered world (4006): forgotten, off to the commons", banned.stored === null && banned.reloads === 1, JSON.stringify(banned));

  const linked = pageLoad("?world=garden", "garden", ["connect", { close: 4010 }, "timers"]);
  check("the LINK's world refusing us is forgotten too, but the page stays and says so",
    linked.stored === null && linked.reloads === 0 && linked.toasts.some((t) => t.includes("not in")), JSON.stringify(linked));
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
  for (const q of ["?spectate&world=garden", "?renderer&world=garden"]) for (const code of [4010, 4006]) {
    const watch = pageLoad(q, "garden", ["connect", { close: code }, "timers"], "garden");
    check(`${q} refused (${code}) leaves the person's garden alone`, watch.stored === "garden" && watch.tab === "garden" && watch.reloads === 0, JSON.stringify(watch));
  }
  const blip = pageLoad("", "garden", ["connect", { close: 1006 }, "timers"]);
  check("an ordinary disconnect forgets nothing", blip.stored === "garden" && blip.reloads === 0, JSON.stringify(blip));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
