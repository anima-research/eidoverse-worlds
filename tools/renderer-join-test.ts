// renderer-join-test — a page claims to be a renderer only when it can render, headless.
//
//   bun tools/renderer-join-test.ts
//
// The server takes a join's `renderer` flag at its word: it sends that client snapshots, and if the
// join also says `roam`, sends it into worlds that have no renderer (server/snapshots.ts summon). A
// lite page with ?renderer used to send both flags. A roaming one was sent into a world and
// answered every snapshot there "this client has no renderer", and because the world then had a
// renderer, no working one was ever sent (2026-10-24). net.js sendJoin now claims the role only when a
// snapshot renderer is wired (main.js wires net_snap.js; lite.js wires none). A page that claims neither
// flag still asks to be invisible (spectate). A door key admits it as a spectator; the renderers'
// credential admits renderers only and refuses it (4003, pinned in tools/access-test.ts 11b). Either way,
// the broker never routes a snapshot to it.
//
// Real net.js + base.js, fresh process per page load, as tools/name-snowball-test.ts does it; only the
// DOM-touching UI modules are stubbed.

import { join } from "node:path";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = join(import.meta.dir, "..");

type Join = { id: string; spectate: boolean; renderer: boolean; roam?: boolean };
/** One page load at `search`: wire net.js as `wire` says (none = lite.js, which passes no snapshot),
 *  join `joins` times (a reconnect sends the join again), and return what went on the wire. */
function pageLoad(search: string, wire: "none" | "snapshot" | "other-hooks", joins = 1) {
  const L = join(ROOT, "client/lib") + "/";
  const code = `
    const mem = new Map([["ew-name", "helen"]]);
    globalThis.location = { search: ${JSON.stringify(search)}, host: "x", pathname: "/", protocol: "http:" };
    globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
    const warnings = [];
    console.warn = (...a) => warnings.push(a.join(" "));
    const { mock } = await import("bun:test");
    const L = ${JSON.stringify(L)};
    mock.module(L + "presence.js", () => ({ presence: {} }));
    mock.module(L + "chat.js", () => ({ logChat() {}, logWhisper() {}, noteTyping() {}, noteHistoryContext() {}, resyncChatAfter() {} }));
    mock.module(L + "boot.js", () => ({ markPhase() {} }));
    const net = await import(L + "net.js");
    const wire = ${JSON.stringify(wire)};
    if (wire === "snapshot") net.wireNet({ snapshot: async () => ({ dataUrl: "data:image/png;base64," }) });
    if (wire === "other-hooks") net.wireNet({ toast: () => {}, myAvatarPath: () => "claude" });   // what lite.js passes: no snapshot
    const sent = [];
    net.net.ws = { send: (s) => { const m = JSON.parse(s); if (m.type === "join") sent.push(m); }, readyState: 1 };
    for (let i = 0; i < ${joins}; i++) net.sendJoin();
    console.log(JSON.stringify({ sent, warnings }));`;
  const r = Bun.spawnSync(["bun", "-e", code], { stdout: "pipe", stderr: "pipe" });
  try { return JSON.parse(r.stdout.toString().trim().split("\n").pop()!) as { sent: Join[]; warnings: string[] }; }
  catch { return { sent: [] as Join[], warnings: [`ERROR ${r.stderr.toString().slice(0, 300)}`] }; }
}

console.log("a renderer that can render");
{
  const r = pageLoad("?renderer&roam&world=roam-lobby-1", "snapshot");
  const j = r.sent[0];
  check("joins as a renderer", j?.renderer === true, JSON.stringify(r));
  check("…and a roaming one says roam", j?.roam === true, JSON.stringify(j));
  check("…invisible, under its renderer- name", j?.spectate === true && j?.id === "renderer-helen", JSON.stringify(j));
  check("…with nothing to warn about", r.warnings.length === 0, JSON.stringify(r.warnings));
  const plain = pageLoad("?renderer", "snapshot").sent[0];
  check("a renderer that does not roam says no roam", plain?.renderer === true && !("roam" in plain), JSON.stringify(plain));
}

console.log("a ?renderer page with no renderer (lite.js)");
for (const wire of ["none", "other-hooks"] as const) {
  const r = pageLoad("?renderer&roam&world=roam-lobby-1", wire, 3);
  const all = r.sent;
  check(`${wire}: claims no renderer on any of 3 joins (reconnects included)`, all.length === 3 && all.every((j) => j.renderer === false), JSON.stringify(all));
  check(`${wire}: claims no roam, so it is never sent to another world`, all.every((j) => !("roam" in j)), JSON.stringify(all));
  check(`${wire}: still asks to be invisible (spectate), under the name it was given`, all.every((j) => j.spectate === true && j.id === "renderer-helen"), JSON.stringify(all));
  check(`${wire}: says so once on the console, not once per join`,
    r.warnings.length === 1 && /no renderer/.test(r.warnings[0]), JSON.stringify(r.warnings));
}

console.log("everyone else is unchanged");
{
  const person = pageLoad("", "snapshot").sent[0];
  check("a person with a renderer joins as a person", person?.renderer === false && person?.spectate === false && person?.id === "helen", JSON.stringify(person));
  const spect = pageLoad("?spectate", "snapshot").sent[0];
  check("a spectator joins as a spectator, not a renderer", spect?.renderer === false && spect?.spectate === true && spect?.id === "retina-helen", JSON.stringify(spect));
  const roamNoRenderer = pageLoad("?roam", "snapshot").sent[0];
  check("?roam without ?renderer claims neither", roamNoRenderer?.renderer === false && !("roam" in roamNoRenderer), JSON.stringify(roamNoRenderer));
}

console.log("the entry points wire what this test assumes");
{
  const lite = readFileSync(join(ROOT, "client/lite.js"), "utf8");
  const main = readFileSync(join(ROOT, "client/main.js"), "utf8");
  // comments mention these names too; strip only a // that starts a line or follows whitespace, so a URL survives
  const code = (src: string) => src.replace(/(^|\s)\/\/.*$/gm, "$1");
  const calls = (src: string) => [...code(src).matchAll(/wireNet\(\{([\s\S]*?)\}\);/g)].map((m) => m[1]);
  check("lite.js wires net.js with no snapshot renderer", calls(lite).length > 0 && calls(lite).every((c) => !/\bsnapshot\b/.test(c)), JSON.stringify(calls(lite).length));
  // sendJoin reads the wiring when the join is sent, and a renderer starts at once: the snapshot must be wired
  // before main.js first calls start() or connect(), not merely somewhere in the module
  const m = code(main);
  const wiredAt = m.search(/wireNet\(\{\s*snapshot\s*\}\)/);
  // a call with or without arguments; if neither is found the check FAILS, it does not pass vacuously
  const starts = [m.search(/\bstart\(\s*\)/), m.search(/\bconnect\(\s*\)/)].filter((i) => i >= 0);
  const firstStart = starts.length ? Math.min(...starts) : -1;
  check("main.js still calls start() or connect() (what the next check measures against)", firstStart >= 0, "found neither");
  check("main.js wires net_snap.js's snapshot before it first calls start() or connect()", wiredAt >= 0 && firstStart >= 0 && wiredAt < firstStart, `wired at ${wiredAt}, first start/connect at ${firstStart}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
