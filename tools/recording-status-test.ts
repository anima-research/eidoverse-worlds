// bun tools/recording-status-test.ts — actual MCPL socket and browser dispatch.
import { strict as assert } from "node:assert";
import { WorldAgent } from "../mcpl/agent.ts";
import { recordingState, recordingNotice } from "../shared/recording.js";
process.env.AGENT_BODY_ENGINE = "verlet";
let checks = 0;
function check(ok: unknown, name: string) { assert.ok(ok, name); checks++; console.log("✓ " + name); }
const stop = { type: "recording-status", recording: false, recordingStatus: { state: "stopped", reason: "disk-floor" } };
check(recordingState({ recording: true })?.state === "recording", "legacy active flag remains readable");
check(recordingState({ recording: false })?.state === "disabled", "legacy disabled flag remains readable");
check(recordingState({}) === null, "missing metadata means unknown, not active");
check(!("totalBytes" in recordingState({ recordingStatus: { state: "recording", totalBytes: 42 } })!), "client readback excludes stale byte counters");
let peer: any, current: any = { recording: true, recordingStatus: { state: "ready", performance: "show" } }, joins = 0;
const fake = Bun.serve({ port: 0, hostname: "127.0.0.1",
  fetch(req, server) { if (new URL(req.url).pathname === "/ws" && server.upgrade(req)) return; return Response.json([]); },
  websocket: { message(ws, msg) {
    if (JSON.parse(String(msg)).type !== "join") return;
    peer = ws; joins++;
    ws.send(JSON.stringify({ type: "snapshot", gen: joins, entries: [], present: [], state: {}, throughSeq: -1, ...current }));
  } },
});
const a = new WorldAgent({ name: "reader", world: "show", avatar: "", url: "ws://127.0.0.1:" + fake.port + "/ws" });
async function until(fn: () => boolean) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await Bun.sleep(25); }
  throw new Error("timed out");
}
try {
  await a.connect();
  check(a.look().includes('Stage recording: {"state":"ready","performance":"show"}'), "MCPL look shows admission state");
  peer.send(JSON.stringify(stop));
  await until(() => a.recordingStatus?.state === "stopped");
  check(a.look().includes('"reason":"disk-floor"'), "MCPL look changes on live stop");
  check(a.inbox.some(e => e.text?.includes("recording stopped")), "MCPL receives a stop notice");
  current = {};
  peer.close();
  await until(() => joins === 2 && a.joined);
  check(!a.look().includes("Stage recording:"), "reconnect to older server clears stale state");
} finally { a.close(); fake.stop(true); }

// net.js serves both full and lite clients. Substitute its UI dependencies,
// then dispatch the real wire messages into its exported test seam.
const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
GlobalRegistrator.register();
const stubs = await import("./remotes-stubs.mjs");
const { mock } = await import("bun:test");
const notices: string[] = [];
for (const m of ["core", "assets", "world", "chat", "fp_view", "boot", "ui", "avatar", "xrbody"])
  mock.module(import.meta.dir + "/../client/lib/" + m + ".js", () => ({ ...stubs,
    ...(m === "chat" ? { logChat: (_who: string, text: string) => notices.push(text) } : {}) }));
const { _dispatch, net } = await import("../client/lib/net.js");
await _dispatch({ type: "recording-status", recording: true, recordingStatus: { state: "ready" } });
await _dispatch(stop);
await _dispatch(stop);
check(net.recordingStatus?.state === "stopped", "browser/lite state changes to stopped");
check(notices.length === 2 && notices[0].includes("⏺") && notices[1].includes("disk-floor"), "browser/lite prints active then stop, without repeated notice");
await _dispatch({ type: "snapshot", you: "tester", yourRights: { role: "visitor" }, entries: [], present: [], avatars: [], ...current });
check(net.recordingStatus === null, "browser snapshot clears state absent on older server");
console.log("PASS " + checks + " recording readback checks");
process.exit(0);
