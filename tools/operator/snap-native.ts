// tools/operator/snap-native.ts — an isolated throwaway sequencer for the Unreal remote-capture probe
// (docs/operator/REMOTE-SCREENSHOTS.md "Validation"): a scratch server on 127.0.0.1:18998, a target agent in world
// screenshot-test, and a local-only pose controller on 127.0.0.1:18994 (POST /pose {p, q}; GET answers where to connect).
// Holds until SIGINT/SIGTERM. No production identity, world or state is used.
//   bun tools/operator/snap-native.ts
import { foundWorlds } from "../../test/harness/harness.ts";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helloOf } from "../../shared/protocol/hello.js";

const scratch = mkdtempSync(join(tmpdir(), "ew-snap-native-"));
mkdirSync(join(scratch, "opt"));
foundWorlds(join(scratch, "worlds"), ["screenshot-test"]);
const port = 18998, origin = `http://127.0.0.1:${port}`, CONTROL = 18994, DOOR = "screenshot-test-door";
for (const p of [port, CONTROL]) {
  try { Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } }).stop(true); }
  catch { throw Error(`Port ${p} occupied; refusing to run`); }
}
const child = Bun.spawn([process.execPath, "server/server.ts"], { env: { ...process.env,
  HOST: "127.0.0.1", PORT: String(port), JOIN_TOKEN: DOOR, WORLDS_DIR: join(scratch, "worlds"),
  OPT_DIR: join(scratch, "opt"), RELAY_STATE_DIR: join(scratch, "opt"), SKIP_OPT_SWEEP: "1", RECORD_FRAMES: "0",
  HN_SESSIONS_FILE: join(scratch, "sessions.json"), AGENT_TOKENS_PATH: join(scratch, "tokens.json"), HN_ISSUER_KEY: "", HN_REQUIRE_LOGIN: "0",
}, stdout: "ignore", stderr: "pipe" });
let control: ReturnType<typeof Bun.serve> | undefined, ws: WebSocket | undefined;
try {
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (child.exitCode !== null) throw Error("Scratch server exited: " + await new Response(child.stderr).text());
    try { ready = (await fetch(origin + "/version")).ok; } catch { /* not up yet */ }
    if (!ready) await Bun.sleep(50);
  }
  if (!ready) throw Error("the scratch server never answered /version");
  const target = new WebSocket(origin.replace("http:", "ws:") + "/ws"); ws = target;
  const joined = new Promise<void>((resolve, reject) => {
    target.onopen = () => target.send(JSON.stringify({ type: "join", hello: helloOf(), world: "screenshot-test", id: "screenshot-agent", token: DOOR, replica: true, avatar: "eidoverse/assets/vrms/claude.vrm" }));
    target.onmessage = (e) => { if (JSON.parse(String(e.data)).type === "snapshot") resolve(); };
    target.onclose = () => reject(Error("the target's socket closed before its snapshot"));
  });
  await joined;
  const pose = (p = [15, -29, 65], q = [0, 0, 0, 1]) => target.send(JSON.stringify({ type: "pose", pose: { p, q, yaw: 0, clip: "idle", locomotion: { mode: "swim" } } }));
  pose();
  control = Bun.serve({ hostname: "127.0.0.1", port: CONTROL, async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/pose" && req.method === "POST") { const b = await req.json(); pose(b.p, b.q); return new Response("ok"); }
    return Response.json({ ready: true, endpoint: origin, world: "screenshot-test", scratch });
  } });
  console.log("SCREENSHOT_NATIVE_READY " + scratch);
  await new Promise<void>((resolve) => { process.on("SIGTERM", resolve); process.on("SIGINT", resolve); });
} finally { control?.stop(true); ws?.close(); child.kill(); await child.exited; }
