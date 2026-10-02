// bun tools/frame-archive-live-test.ts — owned child, tiny archives, no assets.
// Real WS fanout through recording limits, I/O failure, and crash/restart.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, renameSync } from "node:fs";
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
async function boot(record = "1", extra: Record<string, string> = {}) {
  const nonce = crypto.randomUUID();
  proc = Bun.spawn([process.execPath, "run", join(root, "server/server.ts")], {
    cwd: root, env: { ...process.env, PORT: String(port), JOIN_TOKEN: "archive-test",
      WORLDS_DIR: worlds, OPT_DIR: join(scratch, "opt"), EIDOVERSE_DIR: join(scratch, "library"),
      SKIP_OPT_SWEEP: "1", RECORD_FRAMES: record, RECORD_SEGMENT_BYTES: "500",
      RECORD_SEGMENT_MS: "60000", RECORD_MAX_BYTES: "30000", RECORD_MAX_SEGMENTS: "3",
      RECORD_MIN_FREE_BYTES: "1", RECORD_PERFORMANCE_ID: "test-performance",
      HN_REQUIRE_LOGIN: "0", BENCH_NONCE: nonce, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...extra },
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
  check(viewer.messages.find(m => m.type === "recording-status").recordingStatus.performance === "test-performance",
    "live stop retains the affected performance identity");
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

  const resetter = await connect("reset-epochs", "owner");
  const resetDir = join(worlds, "reset-epochs");
  for (let epoch = 0; epoch < 3; epoch++) {
    await move(resetter, epoch);
    const before = resetter.messages.filter(m => m.type === "world-reset").length;
    resetter.ws.send(JSON.stringify({ type: "world-reset", name: "reset-epochs" }));
    await until(() => resetter.messages.filter(m => m.type === "world-reset").length > before, "reset " + epoch);
  }
  const epochs = archiveIndex(resetDir);
  check(epochs.length === 3 && new Set(epochs.map(p => p.metadata?.logId)).size === 3,
    "repeated live resets close segments and start distinct authored-log identities");
  check(epochs.every(p => p.metadata?.reason === "world-reset" && p.logState === "resolved" && p.logPaths[0].startsWith("erased-")),
    "offline index resolves each reset performance to its own archived log");
  check((await status("reset-epochs")).reason === "segment-count-limit", "reset preserves cumulative segment quota and latches stopped");
  const afterResetBytes = archiveInventory(resetDir).bytes;
  await move(resetter, 99);
  check(archiveInventory(resetDir).bytes === afterResetBytes, "reset cannot buy a new recording allowance");

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

  check(index.every(p => p.logState === "resolved" && p.logPaths[0] === "log.jsonl") &&
    index[0].metadata?.logId === index[1].metadata?.logId, "ordinary restart retains authored-log identity");

  // Crash at reset's first rename: old log has moved, old snapshot/poses have
  // not. The process restarts from that actual durable intermediate state.
  await boot();
  const partial = await connect("partial-reset", "owner");
  partial.ws.send(JSON.stringify({ type: "verb", verb: "spawn", args: { id: "old-epoch-object", lib: "x.glb", pos: [0,0,0] } }));
  await until(() => partial.messages.some(m => m.type === "log" && m.entry?.args?.id === "old-epoch-object"), "old epoch object");
  await move(partial, 6);
  await stop();
  const partialDir = join(worlds, "partial-reset");
  const priorPart = archiveIndex(partialDir)[0];
  const orphanBytes = new Map(["snapshot.json", "poses.json"].map(f => [f, readFileSync(join(partialDir, f))]));
  mkdirSync(join(partialDir, "erased-partial"));
  renameSync(join(partialDir, "log.jsonl"), join(partialDir, "erased-partial", "log.jsonl"));
  await boot();
  const fresh = await connect("partial-reset", "fresh-owner");
  check(!JSON.stringify({state:fresh.snapshot.state,entries:fresh.snapshot.entries}).includes("old-epoch-object"),
    "partial-reset restart discards the orphan snapshot from the moved log");
  const quarantine = readdirSync(partialDir).find(n => n.startsWith("orphaned-derived-"))!;
  check(!!quarantine && [...orphanBytes].every(([f, bytes]) => readFileSync(join(partialDir, quarantine, f)).equals(bytes)),
    "partial-reset recovery preserves orphan snapshot/poses byte-for-byte without attributing them");
  await stop("SIGKILL"); // recovery itself dies after fresh genesis, before fold
  await boot();
  const recoveredAgain = await connect("partial-reset", "fresh-owner");
  check(!JSON.stringify({state:recoveredAgain.snapshot.state,entries:recoveredAgain.snapshot.entries}).includes("old-epoch-object"),
    "second unclean recovery keeps old derived state retired");
  await move(recoveredAgain, 7); await stop();
  const recovered = archiveIndex(partialDir);
  check(recovered.length === 2 && recovered[0].metadata?.logId !== recovered[1].metadata?.logId,
    "partial-reset restart creates a distinct log identity without a sidecar pairing window");
  check(recovered[0].logPaths[0] === "erased-partial/log.jsonl" && recovered[1].logPaths[0] === "log.jsonl" &&
    recovered[0].metadata?.logId === priorPart.metadata?.logId,
    "offline recovery resolves both sides of a log-only reset rename");

  await boot("1", { RECORD_MAX_SEGMENTS: "1", RECORD_SEGMENT_MS: "100" });
  const idle = await connect("idle-cap", "performer");
  await move(idle, 0);
  await until(async () => (await status("idle-cap")).state === "stopped", "idle segment-cap stop");
  const idleJoin = await connect("idle-cap", "late", true);
  check(!idleJoin.snapshot.recording && idleJoin.snapshot.recordingStatus.reason === "segment-count-limit",
    "idle final-segment close reports stopped to a new join before another pose");
  check(idle.messages.some(m => m.type === "recording-status" && m.recordingStatus.performance === "test-performance"),
    "idle stop tells current clients the performance identity");
  await stop();

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
