// bun tools/frame-archive-live-test.ts — owned child, tiny archives, no assets.
// Real WS fanout through recording limits, I/O failure, and crash/restart.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";
import { archiveIndex, archiveInventory } from "../server/frame-archive.ts";
const root = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "ew-frame-live-"));
const worlds = join(scratch, "worlds");
mkdirSync(join(worlds, "legacy"), { recursive: true });
writeFileSync(join(worlds, "legacy", "frames-123.jsonl"), "x".repeat(30_000));
const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
const port = listener.port!; listener.stop(true);
const http = "http://127.0.0.1:" + port;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
let proc: Bun.Subprocess | null = null;
const sockets: WebSocket[] = [];
let checks = 0;
let completed = false;
function check(value: unknown, message: string) { assert.ok(value, message); checks++; console.log("✓ " + message); }
async function until(fn: () => unknown | Promise<unknown>, message: string) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await pause(30); }
  throw new Error("timeout: " + message);
}
async function boot(record = "1") {
  const nonce = crypto.randomUUID();
  proc = Bun.spawn([process.execPath, "run", join(root, "server/server.ts")], {
    cwd: root, env: { ...process.env, PORT: String(port), JOIN_TOKEN: "archive-test",
      WORLDS_DIR: worlds, OPT_DIR: join(scratch, "opt"), EIDOVERSE_DIR: join(scratch, "library"),
      SKIP_OPT_SWEEP: "1", RECORD_FRAMES: record, RECORD_SEGMENT_BYTES: "500",
      RECORD_SEGMENT_MS: "60000", RECORD_MAX_BYTES: "30000", RECORD_MAX_SEGMENTS: "3",
      RECORD_MIN_FREE_BYTES: "1", RECORD_PERFORMANCE_ID: "test-performance",
      HN_REQUIRE_LOGIN: "0", BENCH_NONCE: nonce, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    stdout: Bun.file(join(scratch, "server.log")), stderr: Bun.file(join(scratch, "server.log")),
  });
  await until(async () => {
    if (proc!.exitCode !== null) throw new Error("child exited: " + readFileSync(join(scratch, "server.log"), "utf8"));
    try { return (await (await fetch(http + "/health")).json() as any).nonce === nonce; } catch { return false; }
  }, "owned sequencer");
}
async function stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
  for (const s of sockets.splice(0)) s.close();
  if (proc) {
    proc.kill(signal);
    const child = proc;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
    await child.exited; clearTimeout(timeout); proc = null;
  }
}
async function connect(world: string, id: string, spectate = false) {
  const ws = new WebSocket(http.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const messages: any[] = [];
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", id, world, token: "archive-test", spectate, avatar: "body.vrm" }));
  ws.onmessage = ev => messages.push(JSON.parse(String(ev.data)));
  await until(() => messages.some(m => m.type === "snapshot"), "join " + id);
  return { ws, messages, snapshot: messages.find(m => m.type === "snapshot") };
}
async function move(s: Awaited<ReturnType<typeof connect>>, x: number) {
  const before = s.messages.filter(m => m.type === "frame").length;
  s.ws.send(JSON.stringify({ type: "pose", pose: { p: [x, 0, 0], yaw: 0 } }));
  await until(() => s.messages.filter(m => m.type === "frame").length > before, "live pose");
}
async function status(world: string) {
  const reply = await fetch(http + "/recordings");
  assert.equal(reply.headers.get("cache-control"), "no-store");
  return ((await reply.json()) as any).worlds.find((w: any) => w.world === world);
}
try {
  await boot();
  const legacy = await connect("legacy", "legacy-performer");
  check(!legacy.snapshot.recording && legacy.snapshot.recordingStatus.reason === "world-byte-limit", "legacy bytes stop admission before join notice");
  await move(legacy, 1);
  check(readFileSync(join(worlds, "legacy", "frames-123.jsonl"), "utf8").length === 30000, "legacy file is preserved while live frames flow");

  const performer = await connect("bounded", "performer");
  const viewer = await connect("bounded", "audience", true);
  check(performer.snapshot.recording, "active recording is disclosed at join");
  for (let i = 0; i < 30 && (await status("bounded")).state !== "stopped"; i++) await move(performer, i);
  check((await status("bounded")).reason === "segment-count-limit", "small configured segment count stops archive");
  check(viewer.messages.some(m => m.type === "recording-status" && m.recording === false && m.recordingStatus.reason === "segment-count-limit"), "existing clients receive the actual recording stop");
  const before = viewer.messages.filter(m => m.type === "frame").length;
  await move(performer, 100); await move(performer, 101);
  check(viewer.messages.filter(m => m.type === "frame").length >= before + 2, "spectator receives continued frames after recording cap");
  const bounded = archiveIndex(join(worlds, "bounded"));
  check(bounded.length === 3 && bounded.every(p => p.actualBytes <= 500), "real server rotates within byte boundary");
  check(bounded.every(p => JSON.parse(readFileSync(join(worlds, "bounded", p.file), "utf8").split("\n")[0]).roster.length === 1), "every segment starts with performer roster, excluding spectators");
  check(bounded.every(p => typeof p.metadata?.firstLogSeq === "number"), "index anchors frames to authored log sequence");
  performer.ws.send(JSON.stringify({ type: "debug", kinds: ["recording-stopped"] }));
  await until(() => performer.messages.some(m => m.type === "debug"), "recording debug");
  check(performer.messages.find(m => m.type === "debug").events.some((e: any) => e.kind === "recording-stopped"), "recording stop is visible in world_debug");
  const late = await connect("bounded", "late", true);
  check(!late.snapshot.recording && late.snapshot.recordingStatus.state === "stopped", "late join reports actual stopped state");
  performer.ws.send(JSON.stringify({ type: "verb", verb: "say", args: { text: "authored after archival stop" } }));
  await until(() => viewer.messages.some(m => m.type === "log" && m.entry?.args?.text === "authored after archival stop"), "live authored log");
  check(true, "authored world log keeps working after archival stop");

  const failing = await connect("iofail", "writer");
  await move(failing, 0);
  const current = (await status("iofail")).currentSegment;
  mkdirSync(join(worlds, "iofail", current.replace(/\.jsonl$/, ".index.json.tmp")));
  for (let i = 1; i < 12 && (await status("iofail")).state !== "stopped"; i++) await move(failing, i);
  check((await status("iofail")).reason.includes("archive-io"), "real index-write failure stops recording");
  await move(failing, 50); check(true, "live fanout survives archival filesystem failure");

  const crash = await connect("crash", "performer");
  await move(crash, 0);
  const old = archiveIndex(join(worlds, "crash"))[0];
  const oldBytes = readFileSync(join(worlds, "crash", old.file));
  await stop("SIGKILL");
  await boot();
  const after = await connect("crash", "performer");
  await move(after, 1);
  await stop();
  const index = archiveIndex(join(worlds, "crash"));
  check(index.length === 2, "restart creates a new boot segment without appending to old one");
  check(index[0].metadata?.state === "open" && index[1].metadata?.state === "closed", "crash leaves an explicitly unclosed index; shutdown closes the successor");
  check(index.every(p => p.metadata?.performance === "test-performance"), "operator performance ID groups segments across boots");
  check(readFileSync(join(worlds, "crash", old.file)).equals(oldBytes), "restart leaves interrupted archive bytes unchanged");

  await boot("0");
  const disabled = await connect("disabled", "performer");
  await move(disabled, 0);
  check(!disabled.snapshot.recording && (await status("disabled")).state === "disabled", "disabled recording stays disabled");
  check(archiveInventory(join(worlds, "disabled")).bytes === 0, "disabled recording writes no archive");
  console.log("PASS " + checks + " live archive checks");
  completed = true;
} catch (e) {
  console.error(readFileSync(join(scratch, "server.log"), "utf8").slice(-6000));
  throw e;
} finally {
  await stop();
  if (completed) rmSync(scratch, { recursive: true, force: true });
  else console.error("Failure artifacts retained at " + scratch);
}
