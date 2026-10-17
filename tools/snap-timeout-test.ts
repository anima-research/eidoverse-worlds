// snap-timeout-test — SNAP_TIMEOUT_SEC and the broker's [snap] drop logs (#222).
//
//   bun tools/snap-timeout-test.ts
//
// A scratch sequencer with SNAP_TIMEOUT_SEC=2, a body to follow, and a fake
// renderer leg whose reply delay each case sets. Checks: a reply inside the
// window → 200; a reply after it → 504 plus the timeout log and the late
// reply's "expired or unknown" drop log; a renderer's error reply is logged
// (escaped) and answers 503 with its text; a reply that is not a PNG is logged
// and answers 502; a reply from a non-renderer client is dropped (logged once
// per connection) without consuming the pending snap; client-supplied ids are
// logged escaped (no forged log lines); out-of-range / junk values for
// SNAP_TIMEOUT_SEC fall back to 12 with a warning; and on a second sequencer
// with SNAP_TIMEOUT_SEC=20, a frame that takes ~13s still answers 200 — past
// Bun's 10s default idle timeout. The broker allows one snap per renderer per
// 2s, so the cases are spaced by that; the 13s case runs alongside the rest,
// and the whole file takes ~20s. Other waits are on events (the join snapshot,
// a log line, the renderer's own receipt of the snap), not fixed sleeps.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

function spawnSeq(timeoutSec: string) {
  const port = 8000 + Math.floor(Math.random() * 900);
  const proc = Bun.spawn(["bun", "server/server.ts"], {
    env: { ...process.env, PORT: String(port), SNAP_TIMEOUT_SEC: timeoutSec, SKIP_OPT_SWEEP: "1",
      WORLDS_DIR: mkdtempSync(join(tmpdir(), "snap-timeout-")) },
    stdout: "pipe", stderr: "pipe",
  });
  const log: string[] = [];
  for (const s of [proc.stdout, proc.stderr]) (async () => { const d = new TextDecoder(); let buf = "";
    for await (const c of s as ReadableStream<Uint8Array>) { buf += d.decode(c); let nl;
      while ((nl = buf.indexOf("\n")) >= 0) { log.push(buf.slice(0, nl)); buf = buf.slice(nl + 1); } } })();
  return { port, proc, log };
}
async function waitUp(port: number) {
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/worlds`); return true; } catch { await Bun.sleep(200); } }
  return false;
}
function join_(port: number, msg: Record<string, unknown>) {
  // resolves on the join's own snapshot — the server has registered the leg
  return new Promise<WebSocket>((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const t = setTimeout(() => rej(new Error(`join ${msg.id}: no snapshot in 5s`)), 5000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: "snapt", ...msg }));
    ws.addEventListener("message", function hello(ev) {
      if (JSON.parse(String(ev.data)).type !== "snapshot") return;
      ws.removeEventListener("message", hello); clearTimeout(t); res(ws);
    });
  });
}
/** Resolve once some log line from index `from` on satisfies `pred` (or false after `ms`). */
async function logLine(log: string[], from: number, pred: (l: string) => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (log.slice(from).some(pred)) return true; await Bun.sleep(20); }
  return false;
}
/** A fake renderer leg: `reply(id)` decides each snap; `seen` resolves waiters on the next snap it receives. */
async function fakeRenderer(port: number, id: string) {
  const ws = await join_(port, { id, spectate: true, renderer: true });
  const r = { ws, reply: (_id: string) => {}, waiters: [] as ((id: string) => void)[],
    next: () => new Promise<string>((res) => r.waiters.push(res)) };
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.type !== "snap") return;
    r.waiters.splice(0).forEach((w) => w(m.id));
    r.reply(m.id);
  });
  return r;
}
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// the bystander's (refused) image differs from the renderer's, so a 200 says whose reply answered it
const PNG_BYSTANDER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const bytesOf = (dataUrl: string) => Buffer.from(dataUrl.split(",")[1], "base64");

// ---- the window ---------------------------------------------------------------
const A = spawnSeq("2");
const C = spawnSeq("20");   // the long window, run alongside A's cases
const procs = [A.proc, C.proc];
process.on("exit", () => procs.forEach((p) => p.kill()));
if (!(await waitUp(A.port)) || !(await waitUp(C.port))) { console.error("FATAL: scratch sequencer never came up (bun install in the repo root?)"); process.exit(2); }

// past Bun's 10s default: started first, checked last
const cBody = await join_(C.port, { id: "target" });
const cRenderer = await fakeRenderer(C.port, "renderer-slow");
cRenderer.reply = (id) => setTimeout(() => cRenderer.ws.send(JSON.stringify({ type: "snap-result", id, dataUrl: PNG })), 13_000);
const longT0 = Date.now();
const longSnap = fetch(`http://127.0.0.1:${C.port}/snap?world=snapt&follow=target`)
  .then(async (r) => ({ status: r.status, body: Buffer.from(await r.arrayBuffer()), ms: Date.now() - longT0 }),
        (e) => ({ status: -1, body: Buffer.alloc(0), ms: Date.now() - longT0, err: String(e) }));

const body = await join_(A.port, { id: "target" });
const renderer = await fakeRenderer(A.port, "renderer-fake");
const bystander = await join_(A.port, { id: "retina-bystander", spectate: true });
const later = (ms: number) => (id: string) => setTimeout(() => renderer.ws.send(JSON.stringify({ type: "snap-result", id, dataUrl: PNG })), ms);
// the broker's per-renderer cooldown (2s): space each snap past it, or it answers 429
let lastSnap = 0;
const cooldown = () => Bun.sleep(Math.max(0, lastSnap + 2100 - Date.now()));
const snap = async () => {
  await cooldown();
  lastSnap = Date.now();
  return fetch(`http://127.0.0.1:${A.port}/snap?world=snapt&follow=target`);
};

console.log("window (SNAP_TIMEOUT_SEC=2)");
renderer.reply = later(300);
let r = await snap();
check("reply inside the window → 200 PNG", r.status === 200 && r.headers.get("content-type") === "image/png", String(r.status));

renderer.reply = later(3000);
let mark = A.log.length;
await cooldown();
const t0 = Date.now();
r = await snap();
const waited = Date.now() - t0;
check("reply after the window → 504", r.status === 504, String(r.status));
check("…answered at ~2s, not 12s", waited >= 1800 && waited < 4000, `${waited}ms`);
check("timeout is logged with the snap, follow and renderer", A.log.slice(mark).some((l) => l.includes("[snap]") && l.includes(`follow="target"`) && l.includes("renderer-fake") && l.includes("in 2s")));
check("the late frame's drop is logged as expired/unknown",
  await logLine(A.log, mark, (l) => l.includes("[snap]") && l.includes("expired or unknown") && l.includes("renderer-fake")));

console.log("renderer error replies");
renderer.reply = (id) => renderer.ws.send(JSON.stringify({ type: "snap-result", id, error: "gpu lost\n[perm] forged by a renderer" }));
mark = A.log.length;
r = await snap();
check("a renderer's error reply → 503 with its text", r.status === 503 && (await r.text()).startsWith("gpu lost"), String(r.status));
check("…and is logged on one escaped line", await logLine(A.log, mark, (l) => l.includes("[snap]") && l.includes("renderer-fake") && l.includes("\\n[perm] forged") && l.includes("503"))
  && !A.log.slice(mark).some((l) => l.startsWith("[perm]")), A.log.slice(mark).join(" | "));
renderer.reply = (id) => renderer.ws.send(JSON.stringify({ type: "snap-result", id, dataUrl: "data:image/png;base64,bm90IGEgcG5n" }));
mark = A.log.length;
r = await snap();
check("a reply that is not a PNG → 502", r.status === 502, String(r.status));
check("…and is logged", await logLine(A.log, mark, (l) => l.includes("[snap]") && l.includes("renderer-fake") && l.includes("no valid PNG") && l.includes("502")), A.log.slice(mark).join(" | "));

console.log("non-renderer replies");
renderer.reply = () => {};   // the renderer holds the next snap
const seen = renderer.next();
const pendingSnap = snap();
const heldId = await seen;
mark = A.log.length;
bystander.send(JSON.stringify({ type: "snap-result", id: heldId, dataUrl: PNG_BYSTANDER }));
check("a non-renderer's reply is logged and dropped", await logLine(A.log, mark, (l) => l.includes("not a renderer") && l.includes("retina-bystander")));
renderer.ws.send(JSON.stringify({ type: "snap-result", id: heldId, dataUrl: PNG }));
const held = await pendingSnap;
check("…without consuming the pending snap (the renderer's frame answers it)",
  held.status === 200 && Buffer.from(await held.arrayBuffer()).equals(bytesOf(PNG)), String(held.status));
mark = A.log.length;
for (let i = 0; i < 50; i++) bystander.send(JSON.stringify({ type: "snap-result", id: `spam-${i}`, dataUrl: PNG_BYSTANDER }));
// a renderer reply sent after the spam is a marker: once it is logged, the spam has been handled
renderer.ws.send(JSON.stringify({ type: "snap-result", id: "marker", dataUrl: PNG }));
await logLine(A.log, mark, (l) => l.includes(`"marker"`));
check("…and only once per connection (50 more replies, no more lines)", !A.log.slice(mark).some((l) => l.includes("retina-bystander")), A.log.slice(mark).join(" | "));

console.log("log hygiene");
// unknown ids from a renderer are logged (a late frame matters), so they must be safe
mark = A.log.length;
renderer.ws.send(JSON.stringify({ type: "snap-result", id: "missing\n[perm] forged by a client\n", dataUrl: PNG }));
renderer.ws.send(JSON.stringify({ type: "snap-result", id: { not: "a string" }, dataUrl: PNG }));
renderer.ws.send(JSON.stringify({ type: "snap-result", id: "x".repeat(5000), dataUrl: PNG }));
await logLine(A.log, mark, (l) => l.includes("xxxx"));
const fresh = A.log.slice(mark);
check("an id with newlines cannot start its own log line", !fresh.some((l) => l.startsWith("[perm]")) && fresh.some((l) => l.includes("\\n[perm] forged")), fresh.join(" | "));
check("a non-string id logs as (invalid id)", fresh.some((l) => l.includes("(invalid id)")));
check("a huge id is bounded in the log", fresh.length > 0 && fresh.every((l) => l.length < 400), String(Math.max(...fresh.map((l) => l.length))));
[body, renderer.ws, bystander].forEach((w) => w.close());

console.log("long window (SNAP_TIMEOUT_SEC=20, frame at ~13s)");
const long = await longSnap;
check("a 13s frame answers 200, past Bun's 10s default", long.status === 200 && long.body.equals(bytesOf(PNG)),
  `${long.status} after ${long.ms}ms${"err" in long ? ` ${long.err}` : ""}`);
check("…after ~13s, not cut short", long.ms >= 12_500 && long.ms < 20_000, `${long.ms}ms`);
[cBody, cRenderer.ws].forEach((w) => w.close());
C.proc.kill();

// ---- config validation ----------------------------------------------------------
console.log("SNAP_TIMEOUT_SEC validation");
for (const bad of ["300", "abc", "0", "-5"]) {
  const B = spawnSeq(bad);
  procs.push(B.proc);
  await waitUp(B.port);
  check(`SNAP_TIMEOUT_SEC=${bad} falls back to 12 with a warning`, B.log.some((l) => l.includes(`SNAP_TIMEOUT_SEC=${JSON.stringify(bad)} is not valid — using 12`)), B.log.filter((l) => l.includes("config")).join(" | "));
  B.proc.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
