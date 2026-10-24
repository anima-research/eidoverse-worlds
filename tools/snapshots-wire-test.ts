// Real HTTP + WS integration; --native holds an isolated sequencer for the UE probe.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const scratch = mkdtempSync(join(tmpdir(), "ew-snapshots-"));
mkdirSync(join(scratch, "opt"));
const port = 18998, origin = `http://127.0.0.1:${port}`;
const native = process.argv.includes("--native");
for (const p of native ? [port, 18994] : [port]) {
  try { const probe = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } }); probe.stop(true); }
  catch { throw Error(`Port ${p} occupied; refusing to run`); }
}
const child = Bun.spawn([process.execPath, "server/server.ts"], { env: { ...process.env,
  HOST: "127.0.0.1", PORT: String(port), JOIN_TOKEN: "snapshot-test-door", WORLDS_DIR: join(scratch, "worlds"),
  OPT_DIR: join(scratch, "opt"), RELAY_STATE_DIR: join(scratch, "opt"), SKIP_OPT_SWEEP: "1", RECORD_FRAMES: "0",
  HN_SESSIONS_FILE: join(scratch, "sessions.json"), AGENT_TOKENS_PATH: join(scratch, "tokens.json"),
  HN_ISSUER_KEY: "", HN_REQUIRE_LOGIN: "0", SNAP_SWEEP_GRACE_SEC: "0", SNAP_SWEEP_EVERY_SEC: "600",   // only a roamer joining can sweep in this run
}, stdout: "ignore", stderr: "pipe" });
const sockets: WebSocket[] = [];
let control: ReturnType<typeof Bun.serve> | undefined;
async function wait(fn: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await Bun.sleep(50); } throw Error(`Timeout: ${label}`);
}
async function connect(id: string, extras = {}, world = "snapshot-test") {
  const messages: any[] = []; const ws = new WebSocket(origin.replace("http:", "ws:") + "/ws"); sockets.push(ws);
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, id, token: "snapshot-test-door", ...extras }));
  ws.onmessage = e => messages.push(JSON.parse(String(e.data)));
  await wait(() => messages.some(m => m.type === "snapshot"), id + " join");
  return { ws, messages, send: (m: object) => ws.send(JSON.stringify(m)) };
}
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error("Scratch server exited: " + await new Response(child.stderr).text());
    try { ready = (await fetch(origin + "/version")).ok; } catch {} if (ready) break; await Bun.sleep(50);
  } assert.ok(ready);
  const target = await connect("snapshot-agent", { agent: true, avatar: "eidoverse/assets/vrms/claude.vrm" });
  const pose = (p = [15, -29, 65], q = [0, 0, 0, 1]) => target.send({ type: "pose", pose: { p, q, yaw: 0, clip: "idle", locomotion: { mode: "swim" } } });
  pose();
  if (native) {
    control = Bun.serve({ hostname: "127.0.0.1", port: 18994, async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/pose" && req.method === "POST") { const b = await req.json(); pose(b.p, b.q); return new Response("ok"); }
      return Response.json({ ready: true, endpoint: origin, world: "snapshot-test", scratch });
    } });
    console.log("SNAPSHOT_NATIVE_READY " + scratch);
    await new Promise<void>(resolve => { process.on("SIGTERM", resolve); process.on("SIGINT", resolve); });
  } else {
    const cap = { version: 1, engine: "unreal", scene: "underwater-prototype" };
    const donor = await connect("unreal-player", { capture: cap });
    const observer = await connect("observer", { spectate: true });
    assert.ok(observer.messages[0].present.some((p: any) => p.id === "unreal-player"), "donor stays embodied");
    const url = origin + "/snap?world=snapshot-test&follow=snapshot-agent";
    const response = fetch(url); await wait(() => donor.messages.some(m => m.type === "snap"), "capture dispatched");
    const request = donor.messages.find(m => m.type === "snap");
    // a renderer watches a world that EXISTS — watching an unfounded name founds
    // nothing (server/access.ts: 4011, retried) — so someone founds it first
    await connect("other-founder", {}, "other-world");
    const other = await connect("other-renderer", { renderer: true }, "other-world");
    other.send({ type: "snap-result", id: request.id, dataUrl: png });
    // The stray reply finished nothing: the donor is still busy with the first ask, so a second one WAITS for it
    // (server/snapshots.ts: a busy renderer is waited for, not refused) instead of being served the stray frame.
    let queuedDone = false;
    const queued = fetch(url).then((q) => { queuedDone = true; return q; });
    await Bun.sleep(300); assert.equal(queuedDone, false, "a second ask waits while the donor is busy");
    donor.send({ type: "snap-result", id: request.id, dataUrl: png });
    const r = await response; assert.equal(r.status, 200); assert.equal(r.headers.get("x-eidoverse-renderer"), "unreal");
    assert.equal(r.headers.get("x-eidoverse-scene"), "underwater-prototype");
    assert.equal(Buffer.from(await r.arrayBuffer()).toString("base64"), png.split(",")[1]);
    // …and once the donor is free (after its cooldown), the waiting ask goes to it and is served: no "busy" on a first try
    await wait(() => donor.messages.filter(m => m.type === "snap").length === 2, "queued capture dispatched");
    donor.send({ type: "snap-result", id: donor.messages.filter(m => m.type === "snap")[1].id, dataUrl: png });
    assert.equal((await queued).status, 200, "the ask that waited is served");
    const snapsSoFar = () => donor.messages.filter(m => m.type === "snap");
    // Retry-After rides only a failure asking again soon can fix (snapshots.ts retryAfter): the MCPL tool's whole
    // retry policy reads it. A renderer's own "still loading" refusal carries it…
    await Bun.sleep(2100);   // the donor's cooldown
    const refusing = fetch(url); await wait(() => snapsSoFar().length === 3, "a capture to refuse");
    donor.send({ type: "snap-result", id: snapsSoFar()[2].id, error: "the renderer is still loading this world — 1 model still loading (0 in); try again in a few seconds" });
    const refused = await refusing;
    assert.equal(refused.status, 503); assert.equal(refused.headers.get("retry-after"), "2", "a renderer's refusal is retryable");
    // …a body that isn't there does not
    const nobody = await fetch(origin + "/snap?world=snapshot-test&follow=nobody");
    assert.equal(nobody.status, 404); assert.equal(nobody.headers.get("retry-after"), null, "a missing body is not retryable");
    // ?budget= bounds the ask: a donor that never answers is given up at ~1 s, not the 12 s frame window
    await Bun.sleep(2100);
    const t0 = Date.now(); const cut = await fetch(url + "&budget=1000");
    assert.equal(cut.status, 504); assert.equal(cut.headers.get("retry-after"), "2", "a timeout is retryable");
    assert.ok(Date.now() - t0 < 2500, `the caller's budget cut the wait (${Date.now() - t0} ms)`);
    // an out-of-range budget is ignored: the server's own window applies, so a frame at 1.2 s still arrives
    await Bun.sleep(2100);
    const ranged = fetch(url + "&budget=10"); await wait(() => snapsSoFar().length === 5, "a capture under an ignored budget");
    await Bun.sleep(1200); donor.send({ type: "snap-result", id: snapsSoFar()[4].id, dataUrl: png });
    assert.equal((await ranged).status, 200, "a budget under 1 s is ignored, not applied");
    donor.send({ type: "capture-capabilities", capture: null }); await Bun.sleep(50);
    const noRenderer = await fetch(url);
    assert.equal(noRenderer.status, 503); assert.equal(noRenderer.headers.get("retry-after"), null, "no renderer and no roamer is not retryable");
    const legacy = await connect("legacy", { renderer: true });
    const oldResponse = fetch(url + "&renderer=browser"); await wait(() => legacy.messages.some(m => m.type === "snap"), "browser capture");
    legacy.send({ type: "snap-result", id: legacy.messages.find(m => m.type === "snap").id, dataUrl: png }); assert.equal((await oldResponse).status, 200);
    donor.send({ type: "capture-capabilities", capture: cap }); await Bun.sleep(2100);
    const before = donor.messages.filter(m => m.type === "snap").length;
    const pending = fetch(url + "&renderer=unreal"); await wait(() => donor.messages.filter(m => m.type === "snap").length === before + 1, "the next capture");
    donor.ws.close(); assert.equal((await pending).status, 503);
    // THE SWEEP, as the server wires it: an agent alone in a world with no roamer anywhere gets none (pre-warm finds
    // none to send); a roamer that then joins its lobby is sent there at once, with no snapshot asked
    await connect("sweep-founder", {}, "sweep-lobby");
    await connect("sweep-agent", { agent: true }, "sweep-build");
    const roamer = await connect("sweep-roamer", { renderer: true, roam: true }, "sweep-lobby");
    // the timer sweep is 10 min away in this run (SNAP_SWEEP_EVERY_SEC), so only the join can have sent it, ~1 s after
    for (let i = 0; i < 60 && !roamer.messages.some(m => m.type === "renderer-travel" && m.world === "sweep-build"); i++) await Bun.sleep(50);
    assert.ok(roamer.messages.some(m => m.type === "renderer-travel" && m.world === "sweep-build"), "a roamer joining was swept to the agent's world within 3 s");
    const log = readFileSync(join(scratch, "worlds", "snapshot-test", "log.jsonl"), "utf8");
    assert.ok(!log.includes("snap-result") && !log.includes("capture-capabilities"), "capture is ephemeral");
    console.log("SNAPSHOTS_WIRE_PASS: embodied donor, PNG route, ownership, a busy renderer waited for, Retry-After only when retryable, ?budget= bounds an ask, opt-out, legacy browser, disconnect cleanup, a joining roamer swept to an agent, no log writes");
  }
} finally { control?.stop(true); for (const ws of sockets) ws.close(); child.kill(); await child.exited; }
