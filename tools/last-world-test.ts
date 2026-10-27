// last-world-test — a person goes back to the last world they were in, headless.
//
//   bun tools/last-world-test.ts
//
// A bare link (a bookmark, the login's return to '/') used to mean the commons
// whatever world you had been in. Now base.js pickWorld chooses ?world=, else the
// world this browser was last IN as a person, else the commons; net.js onSnapshot
// writes that memory at the door's yes; and a door that refuses a remembered world
// forgets it, and (when the memory, not the link, brought the page there and it
// never got in) takes the person to the commons. Pinned here: the choice itself;
// that index.html's early-socket copy of it agrees, extracted from the served HTML
// rather than copied; and the real net.js writing and forgetting, a fresh process
// per page load with only the DOM-touching UI modules stubbed.

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
const CASES: [string, string | null, string, boolean][] = [
  // search, stored, world, remembered
  ["", null, "commons", false],
  ["", "garden", "garden", true],
  ["?world=lab", "garden", "lab", false],
  ["?world=lab", null, "lab", false],
  ["?world=", "garden", "garden", true],                       // an empty ?world= names nothing
  ["?spectate", "garden", "commons", false],
  ["?renderer&roam", "garden", "commons", false],
  ["?mintthumbs", "garden", "commons", false],
  ["?spectate&world=lab", "garden", "lab", false],
  ["?name=helen&avatar=claude", "garden", "garden", true],     // other params do not change it
  ["", "../etc", "commons", false],                             // a value no world can have is ignored
  ["", "x".repeat(65), "commons", false],
  ["", "", "commons", false],
];
for (const [q, stored, world, remembered] of CASES) {
  const got = pickWorld(P(q), stored);
  check(`"${q}" with ${JSON.stringify(stored)} remembered → ${world}${remembered ? " (from memory)" : ""}`,
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
const inline = (q: string, stored: string | null) => {
  const mem = new Map<string, string>(stored === null ? [] : [["ew-world", stored]]);
  const g: Record<string, unknown> = {
    location: { search: q, protocol: "http:", host: "x" },
    localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem() {}, removeItem() {} },
  };
  g.globalThis = g;
  new Function("globalThis", "location", "localStorage", "URLSearchParams", m![0].replace(/^<script>/, "").replace(/<\/script>$/, ""))
    (g, g.location, g.localStorage, URLSearchParams);
  return g.__ewWorld as { world: string; remembered: boolean } | undefined;
};
if (m) for (const [q, stored] of CASES) {
  const a = inline(q, stored), b = pickWorld(P(q), stored);
  check(`inline agrees on "${q}" with ${JSON.stringify(stored)}`, !!a && a.world === b.world && a.remembered === b.remembered,
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
    WebSocket: WS, crypto,
  };
  g.globalThis = g;
  if (m) new Function("globalThis", "location", "localStorage", "URLSearchParams", "WebSocket", m[0].replace(/^<script>/, "").replace(/<\/script>$/, ""))
    (g, g.location, g.localStorage, URLSearchParams, WS);
  await Promise.resolve();
  const join = sent.map((s) => JSON.parse(s)).find((j) => j.type === "join");
  check("the early socket joins the remembered world", join?.world === "garden", JSON.stringify(join));
  check("…and stashes it for net.js to compare", (g.__ewEarlySocket as { sent?: { world?: string } })?.sent?.world === "garden");
}

// ---- net.js: written at the door's yes, forgotten at its no -----------------------------
console.log("net.js");
type Step = "snapshot" | "connect" | { close: number } | "timers";
type Out = { world: string; stored: string | null; reloads: number; toasts: string[] };
function pageLoad(search: string, stored: string | null, steps: Step[]): Out {
  const L = join(ROOT, "client/lib") + "/";
  const code = `
    const mem = new Map([["ew-name", "helen"]${stored === null ? "" : `, ["ew-world", ${JSON.stringify(stored)}]`}]);
    let reloads = 0;
    globalThis.location = { search: ${JSON.stringify(search)}, host: "x", pathname: "/", protocol: "http:", reload: () => { reloads++; } };
    globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
    globalThis.sessionStorage = { getItem: () => null, setItem() {} };
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
      if (s === "snapshot") await net._dispatch({ type: "snapshot", you: "helen", present: [], entries: [], state: {} });
      else if (s === "connect") await net.connect();
      else if (s === "timers") timers.splice(0).forEach((f) => f());
      else sockets[sockets.length - 1].onclose({ code: s.close });
    }
    console.log(JSON.stringify({ world: CONFIG.world, stored: mem.get("ew-world") ?? null, reloads, toasts }));`;
  const r = Bun.spawnSync(["bun", "-e", code], { stdout: "pipe", stderr: "pipe" });
  try { return JSON.parse(r.stdout.toString().trim().split("\n").pop()!) as Out; }
  catch { return { world: `ERROR ${r.stderr.toString().slice(0, 400)}`, stored: null, reloads: 0, toasts: [] }; }
}
{
  const first = pageLoad("?world=garden", null, ["snapshot"]);
  check("a person let into ?world=garden remembers garden", first.stored === "garden", JSON.stringify(first));
  const back = pageLoad("", first.stored, ["snapshot"]);
  check("…and a bare link next time goes to garden", back.world === "garden" && back.stored === "garden", JSON.stringify(back));
  const moved = pageLoad("?world=lab", "garden", ["snapshot"]);
  check("going somewhere else by link moves the memory there", moved.world === "lab" && moved.stored === "lab", JSON.stringify(moved));
  const never = pageLoad("", null, []);
  check("a browser that has been nowhere goes to the commons", never.world === "commons" && never.stored === null, JSON.stringify(never));

  const spec = pageLoad("?spectate&world=lab", "garden", ["snapshot"]);
  check("watching ?spectate&world=lab leaves the memory at garden", spec.stored === "garden", JSON.stringify(spec));
  const rend = pageLoad("?renderer&world=lab", "garden", ["snapshot"]);
  check("a renderer in lab leaves the memory at garden", rend.stored === "garden", JSON.stringify(rend));

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

  const midway = pageLoad("", "garden", ["connect", "snapshot", { close: 4010 }, "timers"]);
  check("access ending mid-visit forgets garden but does not yank the page away",
    midway.stored === null && midway.reloads === 0, JSON.stringify(midway));
  const blip = pageLoad("", "garden", ["connect", { close: 1006 }, "timers"]);
  check("an ordinary disconnect forgets nothing", blip.stored === "garden" && blip.reloads === 0, JSON.stringify(blip));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
