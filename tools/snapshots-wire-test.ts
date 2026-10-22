// Real HTTP + WS integration; --native holds an isolated sequencer for the UE probe.
// (ported 10-17: worlds are founded first — joining never founds one — joins fold the log (replica: true), and the
// broker speaks capture / capture-result here (main: snap / snap-result))
import { foundWorlds } from "./harness.ts";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const scratch = mkdtempSync(join(tmpdir(), "ew-snapshots-"));
mkdirSync(join(scratch, "opt"));
foundWorlds(join(scratch, "worlds"), ["snapshot-test", "other-world"]);
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
  HN_ISSUER_KEY: "", HN_REQUIRE_LOGIN: "0",
}, stdout: "ignore", stderr: "pipe" });
const sockets: WebSocket[] = [];
let control: ReturnType<typeof Bun.serve> | undefined;
async function wait(fn: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await Bun.sleep(50); } throw Error(`Timeout: ${label}`);
}
async function connect(id: string, extras = {}, world = "snapshot-test") {
  const messages: any[] = []; const ws = new WebSocket(origin.replace("http:", "ws:") + "/ws"); sockets.push(ws);
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, id, token: "snapshot-test-door", replica: true, ...extras }));
  ws.onmessage = e => messages.push(JSON.parse(String(e.data)));
  await wait(() => messages.some(m => m.type === "snapshot"), id + " join");
  return { ws, messages, send: (m: object) => ws.send(JSON.stringify(m)) };
}
// a box with a door key keeps its world reads behind it (identity-check LC): every /snap carries the key
const KEY = { headers: { authorization: "Bearer snapshot-test-door" } };
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
const forged = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mP4z8DwH4QZYAwAR8oH+Rq28akAAAAASUVORK5CYII=";
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error("Scratch server exited: " + await new Response(child.stderr).text());
    try { ready = (await fetch(origin + "/version")).ok; } catch {} if (ready) break; await Bun.sleep(50);
  } assert.ok(ready);
  const target = await connect("snapshot-agent", { avatar: "eidoverse/assets/vrms/claude.vrm" });
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
    const response = fetch(url, KEY); await wait(() => donor.messages.some(m => m.type === "capture"), "capture dispatched");
    const request = donor.messages.find(m => m.type === "capture");
    // a renderer watches a world that EXISTS (watching an unfounded name is 4011, retried): other-world is founded above
    const other = await connect("other-renderer", { renderer: true }, "other-world");
    // a distinct image from the wrong renderer: were it taken, the response below would carry it (#260 house I338)
    other.send({ type: "capture-result", id: request.id, dataUrl: forged });
    assert.equal((await fetch(url, KEY)).status, 429);
    donor.send({ type: "capture-result", id: request.id, dataUrl: png });
    const r = await response; assert.equal(r.status, 200); assert.equal(r.headers.get("x-eidoverse-renderer"), "unreal");
    assert.equal(r.headers.get("x-eidoverse-scene"), "underwater-prototype");
    assert.equal(Buffer.from(await r.arrayBuffer()).toString("base64"), png.split(",")[1]);
    donor.send({ type: "capture-capabilities", capture: null }); await Bun.sleep(50); assert.equal((await fetch(url, KEY)).status, 503);
    const legacy = await connect("legacy", { renderer: true });
    const oldResponse = fetch(url + "&renderer=browser", KEY); await wait(() => legacy.messages.some(m => m.type === "capture"), "browser capture");
    legacy.send({ type: "capture-result", id: legacy.messages.find(m => m.type === "capture").id, dataUrl: png }); assert.equal((await oldResponse).status, 200);
    donor.send({ type: "capture-capabilities", capture: cap }); await Bun.sleep(2100);
    const pending = fetch(url + "&renderer=unreal", KEY); await wait(() => donor.messages.filter(m => m.type === "capture").length === 2, "second capture");
    donor.ws.close(); assert.equal((await pending).status, 503);
    const log = readFileSync(join(scratch, "worlds", "snapshot-test", "world.jsonl"), "utf8");
    assert.ok(!log.includes("capture-result") && !log.includes("capture-capabilities"), "capture is ephemeral");
    console.log("SNAPSHOTS_WIRE_PASS: embodied donor, PNG route, ownership, quota, opt-out, legacy browser, disconnect cleanup, no log writes");
  }
} finally { control?.stop(true); for (const ws of sockets) ws.close(); child.kill(); await child.exited; }
