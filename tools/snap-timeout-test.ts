// snap-timeout-test — SNAP_TIMEOUT_SEC and the broker's [snap] drop logs (#222).
//
//   bun tools/snap-timeout-test.ts
//
// A scratch sequencer with SNAP_TIMEOUT_SEC=2, a body to follow, and a fake
// renderer leg whose reply delay each case sets. Checks: a reply inside the
// window → 200; a reply after it → 504 plus the timeout log and the late
// reply's "expired or unknown" drop log; a renderer's error reply is logged
// (escaped) and answers 503 with its text; a reply that is not a PNG is logged
// and answers 502; a reply from a non-renderer client is dropped without
// consuming the pending snap; a connection's dropped replies log at most one
// line per 10s, whether or not it claims to be a renderer; client-supplied ids
// are logged escaped (no forged log lines); out-of-range / junk values for
// SNAP_TIMEOUT_SEC fall back to 12 with a warning; and on a second sequencer
// with SNAP_TIMEOUT_SEC=20, a frame that takes ~13s still answers 200 — past
// Bun's 10s default idle timeout. The broker allows one snap per renderer per
// 2s, so the cases are spaced by that; the 13s case runs alongside the rest,
// and the whole file takes ~20s. Other waits are on events (the join snapshot,
// a log line, the renderer's own receipt of the snap), not fixed sleeps.

import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** A port nothing listens on right now (bind :0, release), as tools/access-test.ts takes one. */
const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer(); s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});
async function spawnSeq(timeoutSec: string) {
  const port = await freePort();
  const proc = Bun.spawn(["bun", "server/server.ts"], {
    // its own worlds and optimizer directories, and no door token inherited from the shell
    env: { ...process.env, PORT: String(port), SNAP_TIMEOUT_SEC: timeoutSec, SKIP_OPT_SWEEP: "1", JOIN_TOKEN: "",
      WORLDS_DIR: mkdtempSync(join(tmpdir(), "snap-timeout-")), OPT_DIR: mkdtempSync(join(tmpdir(), "snap-timeout-opt-")) },
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
const A = await spawnSeq("2");
const C = await spawnSeq("20");   // the long window, run alongside A's cases
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
// the broker's per-renderer cooldown (2s): space each snap past it, or it answers 429. The broker stamps the
// renderer at dispatch, so the spacing is stamped when each snap answers, which is never before its dispatch.
let lastSnap = 0;
const cooldown = () => Bun.sleep(Math.max(0, lastSnap + 2100 - Date.now()));
const snap = async () => {
  await cooldown();
  const r = await fetch(`http://127.0.0.1:${A.port}/snap?world=snapt&follow=target`);
  lastSnap = Date.now();
  return r;
};
/** Resolves once the server has handled everything `ws` sent before it: a socket's messages are handled in order,
 *  each synchronously, and access-state is answered as it is handled. Messages on other sockets have no such order. */
const handled = (ws: WebSocket) => new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error("no access-state answer in 5s")), 5000);
  ws.addEventListener("message", function answered(ev) {
    if (JSON.parse(String(ev.data)).type !== "access-state") return;
    ws.removeEventListener("message", answered); clearTimeout(t); res();
  });
  ws.send(JSON.stringify({ type: "access-state" }));
});
/** A dropped reply's line comes from a connection that has logged no drop in the last 10s, so each case that needs
 *  one line from a renderer gets a fresh fake renderer of its own. */
let freshN = 0;
const freshRenderer = async () => (await fakeRenderer(A.port, `renderer-fresh-${++freshN}`)).ws;

console.log("window (SNAP_TIMEOUT_SEC=2)");
renderer.reply = later(300);
let r = await snap();
check("reply inside the window → 200 PNG", r.status === 200 && r.headers.get("content-type") === "image/png", String(r.status));

// the renderer holds this snap, and its frame goes once the 504 has come back: late, whatever the host's load
renderer.reply = () => {};
const lateId = renderer.next();
let mark = A.log.length;
await cooldown();
const t0 = Date.now();
r = await snap();
const waited = Date.now() - t0;
check("reply after the window → 504", r.status === 504, String(r.status));
check("…answered at ~2s, not 12s", waited >= 1800 && waited < 10_000, `${waited}ms`);
check("timeout is logged with the snap, follow and renderer",
  await logLine(A.log, mark, (l) => l.includes("[snap]") && l.includes(`follow="target"`) && l.includes("renderer-fake") && l.includes("in 2s")));
renderer.ws.send(JSON.stringify({ type: "snap-result", id: await lateId, dataUrl: PNG }));
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
// a snap refused before dispatch answers without the renderer ever seeing it: fail, rather than wait for it
const first = await Promise.race([seen.then((id) => ({ id })), pendingSnap.then((res) => ({ refused: res.status }))]);
check("the held snap reached the renderer", "id" in first, "refused" in first ? `answered ${first.refused} before dispatch` : "");
if ("id" in first) {
  const heldId = first.id;
  mark = A.log.length;
  bystander.send(JSON.stringify({ type: "snap-result", id: heldId, dataUrl: PNG_BYSTANDER }));
  check("a non-renderer's reply is logged and dropped", await logLine(A.log, mark, (l) => l.includes("not a renderer") && l.includes("retina-bystander")));
  renderer.ws.send(JSON.stringify({ type: "snap-result", id: heldId, dataUrl: PNG }));
  const held = await pendingSnap;
  check("…without consuming the pending snap (the renderer's frame answers it)",
    held.status === 200 && Buffer.from(await held.arrayBuffer()).equals(bytesOf(PNG)), String(held.status));
}
mark = A.log.length;
for (let i = 0; i < 50; i++) bystander.send(JSON.stringify({ type: "snap-result", id: `spam-${i}`, dataUrl: PNG_BYSTANDER }));
// once the bystander's own socket says the spam is handled, a reply from a connection that has logged nothing yet is a
// marker: its line is written after any line the spam wrote
await handled(bystander);
(await freshRenderer()).send(JSON.stringify({ type: "snap-result", id: "marker", dataUrl: PNG }));
const marked = await logLine(A.log, mark, (l) => l.includes(`"marker"`));
check("…and its next 50 replies inside 10s write no more lines", marked && !A.log.slice(mark).some((l) => l.includes("retina-bystander")),
  `${marked ? "" : "no marker line; "}${A.log.slice(mark).join(" | ")}`);

console.log("a client that claims to be a renderer");
// renderer:true with no credential: receive() takes it for a renderer, and its drops are bounded all the same
const claimant = (await fakeRenderer(A.port, "renderer-claimed")).ws;
mark = A.log.length;
for (let i = 0; i < 50; i++) claimant.send(JSON.stringify({ type: "snap-result", id: `flood-${i}`, dataUrl: PNG }));
await handled(claimant);
(await freshRenderer()).send(JSON.stringify({ type: "snap-result", id: "marker2", dataUrl: PNG }));
const marked2 = await logLine(A.log, mark, (l) => l.includes(`"marker2"`));
const claimed = A.log.slice(mark).filter((l) => l.includes("renderer-claimed"));
check("50 unknown-id replies from an uncredentialed 'renderer' write one line", marked2 && claimed.length === 1 && claimed[0].includes(`"flood-0"`),
  `${marked2 ? "" : "no marker line; "}${claimed.join(" | ")}`);

console.log("log hygiene");
// unknown ids from a renderer are logged (a late frame matters), so they must be safe; each from a connection of its
// own, since a connection logs one dropped reply per 10s
mark = A.log.length;
(await freshRenderer()).send(JSON.stringify({ type: "snap-result", id: "missing\n[perm] forged by a client\n", dataUrl: PNG }));
(await freshRenderer()).send(JSON.stringify({ type: "snap-result", id: { not: "a string" }, dataUrl: PNG }));
(await freshRenderer()).send(JSON.stringify({ type: "snap-result", id: "x".repeat(5000), dataUrl: PNG }));
await logLine(A.log, mark, (l) => l.includes("forged") && A.log.slice(mark).some((m) => m.includes("(invalid id)")) && A.log.slice(mark).some((m) => m.includes("xxxx")));
const fresh = A.log.slice(mark);
check("an id with newlines cannot start its own log line", !fresh.some((l) => l.startsWith("[perm]")) && fresh.some((l) => l.includes("\\n[perm] forged")), fresh.join(" | "));
check("a non-string id logs as (invalid id)", fresh.some((l) => l.includes("(invalid id)")));
check("a huge id is bounded in the log", fresh.some((l) => l.includes("xxxx")) && fresh.every((l) => l.length < 400), String(Math.max(0, ...fresh.map((l) => l.length))));
[body, renderer.ws, bystander].forEach((w) => w.close());

console.log("long window (SNAP_TIMEOUT_SEC=20, frame at ~13s)");
const long = await longSnap;
check("a 13s frame answers 200, past Bun's 10s default", long.status === 200 && long.body.equals(bytesOf(PNG)),
  `${long.status} after ${long.ms}ms${"err" in long ? ` ${long.err}` : ""}`);
check("…after ~13s, not cut short", long.ms >= 12_500, `${long.ms}ms`);
[cBody, cRenderer.ws].forEach((w) => w.close());
C.proc.kill();

// ---- config validation ----------------------------------------------------------
// (the values these fall back to, and the cap's own boundary, are read from config.ts in tools/config-env-test.ts)
console.log("SNAP_TIMEOUT_SEC validation");
for (const bad of ["300", "abc", "0", "-5"]) {
  const B = await spawnSeq(bad);
  procs.push(B.proc);
  const up = await waitUp(B.port);
  check(`SNAP_TIMEOUT_SEC=${bad} falls back to 12 with a warning`, up && await logLine(B.log, 0, (l) => l.includes(`SNAP_TIMEOUT_SEC=${JSON.stringify(bad)} is not valid — using 12`)),
    up ? B.log.filter((l) => l.includes("config")).join(" | ") : "the sequencer never came up");
  B.proc.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
