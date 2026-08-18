// door-cap-gate-live-test — the capability gates proven through REAL doors.
//
// (#129 review, item 3: "the capability tests currently inspect source slices.
// That pins spelling, not behavior.") This drives an OWNED scratch sequencer and
// an OWNED MCPL door over real websockets, with a raw world-ws observer as the
// ground truth for what actually reached the world:
//
//   1. deny-until-policy: a 0.5 host's channels/publish is refused BEFORE its
//      first featureSets/update — the window the comments claim is closed.
//   2. incoming-only grant: publish/open/close all -32003; tools/list is empty
//      and tools/call -32601 (denied ⇒ as if never advertised).
//   3. nothing leaked: the observer saw NO say from the gated session.
//   4. granted session: publish delivers AND the say lands in the world log
//      (observer sees it) — allowed operations still work.
//   5. live mention routing: the observer says "@claude …" in-world and the
//      granted host receives channels/incoming tagged chat:mention with
//      metadata.mentioned — the mentionRegex path end to end.
//
// Run: bun tools/door-cap-gate-live-test.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEQ_PORT = 8981 + Math.floor(Math.random() * 400);
const DOOR_PORT = SEQ_PORT + 400;
const JOIN = "cap-gate-test-door";
const scratch = mkdtempSync(join(tmpdir(), "capgate-"));
const BUN = process.execPath.includes("bun") ? process.execPath : "/home/claude/.bun/bin/bun";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};

const kids = [];
function child(args, env) {
  const p = spawn(BUN, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  p.stderr.on("data", (d) => { err += String(d); });
  p.errText = () => err.slice(-400);
  kids.push(p);
  return p;
}
async function up(url, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await fetch(url); return true; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  return false;
}
function shutdown() {
  for (const p of kids) { try { p.kill("SIGTERM"); } catch {} }
  // The sequencer's graceful shutdown can still be writing worlds/<name>/ when
  // rmSync races it (review nit: one in three runs left a /tmp/capgate-* dir).
  // exit handlers cannot await, so retry synchronously after a beat via SIGKILL.
  for (const p of kids) { try { p.kill("SIGKILL"); } catch {} }
  for (let i = 0; i < 2; i++) { try { rmSync(scratch, { recursive: true, force: true }); break; } catch {} }
}
process.on("exit", shutdown);

// ---- a minimal newline-JSON-RPC MCPL client over ws -------------------------
class Rpc {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.next = 1;
    this.pending = new Map();          // id -> resolve
    this.incoming = [];                // server→client requests/notifications
    this.waiters = [];                 // predicates waiting on incoming
    this.ws.onmessage = (ev) => {
      for (const line of String(ev.data).split("\n")) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && this.pending.has(m.id)) {
          this.pending.get(m.id)(m); this.pending.delete(m.id); continue;
        }
        // server→client request: auto-ack so the door never waits on us,
        // but keep it for assertions.
        if (m.id !== undefined && m.method) {
          this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n");
        }
        this.incoming.push(m);
        this.waiters = this.waiters.filter((w) => !(w.pred(m) && (w.resolve(m), true)));
      }
    };
    this.open = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
  }
  request(methodName, params = {}, ms = 8000) {
    const id = this.next++;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pending.delete(id); resolve({ error: { code: 0, message: "timeout" } }); }, ms);
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: methodName, params }) + "\n");
    });
  }
  notify(methodName, params = {}) {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: methodName, params }) + "\n");
  }
  waitFor(pred, ms = 8000) {
    const hit = this.incoming.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  async init(mcpl = true) {
    await this.open;
    const r = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "cap-gate-test", version: "0" },
      capabilities: mcpl ? { experimental: { mcpl: { version: "0.5" } } } : {},
    });
    this.notify("notifications/initialized", {});
    return r;
  }
  close() { try { this.ws.close(); } catch {} }
}

// ---- the rig ----------------------------------------------------------------
console.log(`sequencer :${SEQ_PORT}, door :${DOOR_PORT}, scratch ${scratch}`);
const seq = child(["server/server.ts"], { PORT: String(SEQ_PORT), JOIN_TOKEN: JOIN, WORLDS_DIR: scratch });
if (!(await up(`http://127.0.0.1:${SEQ_PORT}/avatars`))) {
  console.log("FAIL: sequencer never came up.", seq.errText()); process.exit(1);
}
const door = child(["mcpl/net-server.ts"], {
  MCPL_PORT: String(DOOR_PORT),
  WORLD_URL: `ws://127.0.0.1:${SEQ_PORT}/ws`,
  WORLD_TOKEN: JOIN,
});
if (!(await up(`http://127.0.0.1:${DOOR_PORT}/healthz`))) {
  console.log("FAIL: door never came up.", door.errText()); process.exit(1);
}

// Ground truth: a raw world-ws observer, embodied, remembering every say.
const seen = [];
const obs = new WebSocket(`ws://127.0.0.1:${SEQ_PORT}/ws`);
const obsJoined = new Promise((resolve) => {
  obs.onopen = () => obs.send(JSON.stringify({ type: "join", world: "commons", id: "observer", token: JOIN }));
  obs.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.type === "snapshot") resolve(true);
    if (m.type === "log" && m.entry?.verb === "say") seen.push({ who: m.entry.actor, text: m.entry.args?.text });
  };
});
if (!(await Promise.race([obsJoined, new Promise((r) => setTimeout(() => r(false), 8000))]))) {
  console.log("FAIL: observer could not join the world"); process.exit(1);
}

// ---- phase 1: a 0.5 host, deny-until-policy then incoming-only --------------
const gated = new Rpc(`ws://127.0.0.1:${DOOR_PORT}/mcpl?token=dev-token`);
await gated.init(true);

let r = await gated.request("channels/publish", {
  channelId: "world:commons", content: [{ type: "text", text: "LEAK-prepolicy" }] });
check("0.5 host: channels/publish is refused BEFORE policy (deny-until-policy window)",
  r.error?.code === -32003, JSON.stringify(r).slice(0, 120));

r = await gated.request("featureSets/update", { effectiveCapabilities: ["channels.incoming"] });
check("featureSets/update (incoming-only) is accepted with a degradation receipt",
  r.result?.accepted === true && r.result?.mode === "degraded", JSON.stringify(r).slice(0, 160));

r = await gated.request("channels/publish", {
  channelId: "world:commons", content: [{ type: "text", text: "LEAK-postpolicy" }] });
check("incoming-only: channels/publish -32003", r.error?.code === -32003, JSON.stringify(r).slice(0, 120));
r = await gated.request("channels/open", { channelId: "world:commons" });
check("incoming-only: channels/open -32003", r.error?.code === -32003, JSON.stringify(r).slice(0, 120));
r = await gated.request("channels/close", { channelId: "world:commons" });
check("incoming-only: channels/close -32003", r.error?.code === -32003, JSON.stringify(r).slice(0, 120));
r = await gated.request("tools/list", {});
check("incoming-only: tools/list is EMPTY (denied ⇒ as if never advertised)",
  Array.isArray(r.result?.tools) && r.result.tools.length === 0, JSON.stringify(r).slice(0, 120));
r = await gated.request("tools/call", { name: "say", arguments: { text: "LEAK-tool" } });
check("incoming-only: tools/call -32601", r.error?.code === -32601, JSON.stringify(r).slice(0, 120));
gated.close();
await new Promise((s) => setTimeout(s, 1500));
check("nothing leaked: the observer saw NO say from the gated session",
  !seen.some((s) => String(s.text).includes("LEAK")), JSON.stringify(seen).slice(0, 160));

// ---- phase 2: a granted host — allowed operations still work ---------------
const full = new Rpc(`ws://127.0.0.1:${DOOR_PORT}/mcpl?token=dev-token`);
await full.init(true);
r = await full.request("featureSets/update", {
  effectiveCapabilities: ["tools", "channels.register", "channels.lifecycle",
    "channels.publish", "channels.incoming", "channels.streaming"] });
check("full grant accepted, mode full", r.result?.accepted === true && r.result?.mode === "full",
  JSON.stringify(r).slice(0, 160));
// the takeover from phase 1's dead session needs a beat to settle the body
await new Promise((s) => setTimeout(s, 1500));
r = await full.request("channels/publish", {
  channelId: "world:commons", content: [{ type: "text", text: "granted-hello-from-the-door" }] });
check("granted: channels/publish delivers", r.result?.delivered === true, JSON.stringify(r).slice(0, 120));
const landed = await (async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    if (seen.some((s) => s.who === "claude" && String(s.text).includes("granted-hello-from-the-door"))) return true;
    await new Promise((s) => setTimeout(s, 200));
  }
  return false;
})();
check("…and the say actually LANDED in the world (observer ground truth)", landed,
  JSON.stringify(seen.slice(-3)));
r = await full.request("channels/open", { channelId: "world:commons", history: { limit: 5 } });
check("granted: channels/open answers with the channel", !!r.result?.channel, JSON.stringify(r).slice(0, 120));

// ---- phase 3: live mention routing (observer → world → door → host) --------
obs.send(JSON.stringify({ type: "verb", verb: "say", args: { text: "hey @claude — live mention check" } }));
const mention = await full.waitFor((m) =>
  m.method === "channels/incoming" &&
  JSON.stringify(m.params ?? {}).includes("live mention check"), 8000);
check("a world say naming @claude arrives as channels/incoming", !!mention,
  "no incoming frame observed");
if (mention) {
  const msg = mention.params?.messages?.[0] ?? {};
  check("…tagged chat:mention", Array.isArray(msg.tags) && msg.tags.includes("chat:mention"), JSON.stringify(msg.tags));
  check("…with metadata.mentioned (transition shim)", msg.metadata?.mentioned === true, JSON.stringify(msg.metadata));
}
full.close();
obs.close();

console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
