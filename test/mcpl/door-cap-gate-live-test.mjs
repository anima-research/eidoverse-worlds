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
//      (observer sees it) — allowed operations still work. Before that, a
//      grant leaving out channels.typing gets a degraded receipt naming
//      eidoverse.typing, and channels/typing then raises no dots; granted, the
//      same body's dots rise (observer sees the typing signal).
//   5. live mention routing: the observer says "@claude …" in-world and the
//      granted host receives channels/incoming tagged chat:mention with
//      metadata.mentioned — the mentionRegexFor path end to end.
//
// The harness owns its ports, its state and its children, the pattern of test/mcpl/join-rfc005-test.ts: free ports
// (harness kernelPort here; racy, so readiness checks ownership), a per-run nonce both children echo, OS port
// ownership as a Linux second opinion, scratch-bound tokens/worlds/state, verified termination, and a before/after
// receipt that the repository's mcpl/state.json was untouched.
//
// Run: bun test/mcpl/door-cap-gate-live-test.mjs
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundWorlds, kernelPort } from "../harness/harness.ts";
import { createServer as createHttpServer } from "node:http";
import { suite } from "../gate/suite.ts";
import { until, tryUntil, pause } from "../gate/wait.ts";
import { capabilityMatches, CAP, MCPL_ADVERTISEMENT, FEATURE_SETS } from "../../mcpl/declaration.ts";
import { helloOf } from "../../shared/protocol/hello.js";

// racy in principle, which is why readiness below verifies ownership rather than trusting whatever answers
const SEQ_PORT = kernelPort(), DOOR_PORT = kernelPort();
const JOIN = "cap-gate-test-door";
const NONCE = `t${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const scratch = mkdtempSync(join(process.env.PROTOCOL_SCRATCH || tmpdir(), "capgate-"));
const tokensPath = join(scratch, "tokens.json");
// the world exists before the run (joining never founds one)
foundWorlds(scratch, ["commons"]);
const statePath = join(scratch, "state.json");
writeFileSync(tokensPath, JSON.stringify({
  "gate-token": { id: "claude", name: "Claude", world: "commons" },
}));
// Repository state must be untouched by a run. Snapshot before, compare after.
const REPO_STATE = fileURLToPath(new URL("../../mcpl/state.json", import.meta.url));
const snapState = () => existsSync(REPO_STATE)
  ? { exists: true, mtimeMs: statSync(REPO_STATE).mtimeMs,
      hash: new Bun.CryptoHasher("sha256").update(readFileSync(REPO_STATE)).digest("hex") }
  : { exists: false, mtimeMs: 0, hash: "" };
const repoStateBefore = snapState();
const BUN = process.execPath.includes("bun") ? process.execPath : "bun";

const S = suite("door-cap-gate-live");
const check = (name, ok, extra) => S.check(name, ok, extra);

// Every child is registered before it can be lost; the exit hook is the
// last-resort net (process.exit does not run finally blocks).
const kids = [];
function child(args, env) {
  const p = spawn(BUN, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  p.stderr.on("data", (d) => { err += String(d); });
  p.errText = () => err.slice(-400);
  kids.push(p);
  return p;
}
process.on("exit", () => { for (const p of kids) { try { p.kill("SIGKILL"); } catch {} } });
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });

/** SIGTERM, AWAIT exit, escalate to SIGKILL only on timeout — a kill that does
 *  not wait races the child's own orderly shutdown (the #125 tmp-file class). */
function awaitExit(p, ms = 5000) {
  return new Promise((resolve) => {
    if (p.exitCode !== null) return resolve(true);
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, ms);
    p.once("exit", () => { clearTimeout(t); resolve(true); });
    try { p.kill("SIGTERM"); } catch { clearTimeout(t); resolve(true); }
  });
}

/** PIDs listening on a TCP port, from the OS: a Linux second opinion (elsewhere null, without spawning: the per-run
 *  nonce is the portable proof). A missing `ss` arrives as an async `error` event on the child, not a throw from
 *  spawn; unhandled it would crash the harness, so it resolves null too. */
async function listenerPids(port, cmd = "ss") {
  if (process.platform !== "linux") return null;
  try {
    const p = spawn(cmd, ["-lntpH"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => { out += String(d); });
    const code = await new Promise((r) => {
      p.once("error", () => r(-1));   // spawn failure (ENOENT) — not an exit code
      p.once("close", r);
    });
    if (code !== 0) return null;
    const pids = [];
    for (const line of out.split("\n")) {
      if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
      for (const m of line.matchAll(/pid=(\d+)/g)) pids.push(Number(m[1]));
    }
    return [...new Set(pids)];
  } catch { return null; }
}
function descendantsOf(root) {
  const out = [];
  if (!existsSync("/proc")) return out;
  const walk = (pid, depth = 0) => {
    if (depth > 6) return;
    let kidsStr = "";
    try { kidsStr = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8"); } catch { return; }
    for (const k of kidsStr.trim().split(/\s+/).filter(Boolean)) {
      const n = Number(k); out.push(n); walk(n, depth + 1);
    }
  };
  walk(root);
  return out;
}
// readiness on wait.ts's until: a child that died or a stale listener ends the wait at once, by name
async function ready(what, probe, deps, ms = 20000) {
  const r = await until(what, async () => {
    for (const d of deps) if (d.exitCode !== null) return { dead: `child exited early (${d.exitCode}) ${d.errText()}` };
    try { return (await probe()) && { ok: true }; } catch (e) { if (/stale listener/.test(e.message)) return { dead: e.message }; throw e; }
  }, { ms });
  if (r.dead) throw new Error(`${what}: ${r.dead}`);
}
function ownsPort(name, port, proc) {
  return async () => {
    const pids = await listenerPids(port);
    if (pids === null) return true;          // platform cannot answer; nonce already proved identity
    if (pids.length === 0) return false;
    const ours = new Set([proc.pid, ...descendantsOf(proc.pid)]);
    const foreign = pids.filter((p) => !ours.has(p));
    if (foreign.length) throw new Error(`${name} port ${port} held by pid(s) ${foreign.join(",")} — stale listener`);
    return true;
  };
}
/** Door readiness: identity, not liveness — a bare "ok" is a stale listener. */
const doorNonceProbe = (port) => async () => {
  const r = await fetch(`http://127.0.0.1:${port}/healthz`);
  if (!r.ok) return false;
  const body = (await r.text()).trim();
  if (body === "ok") throw new Error("a door answered but WITHOUT our nonce — stale listener");
  if (body.startsWith("ok ") && body !== `ok ${NONCE}`)
    throw new Error(`a door answered with a FOREIGN nonce (${body.slice(3, 20)}…) — stale listener`);
  return body === `ok ${NONCE}`;
};

// ── the grant matcher (§5.4 path semantics), as the door's granted() applies it; absence is denial ──
{
  const withGrant = (grant, cap) => grant.some((g) => capabilityMatches(g, cap));
  check("matcher: exact path grants", withGrant(["channels.publish"], CAP.channelsPublish));
  check("matcher: one-segment wildcard grants", withGrant(["channels.*"], CAP.channelsPublish));
  check("matcher: ANCESTOR PREFIX DOES NOT GRANT — the fail-closed rule", !withGrant(["channels"], CAP.channelsPublish));
  check("matcher: tools does not confer channels", !withGrant(["tools"], CAP.channelsPublish));
  check("matcher: bare * does not span two segments", !withGrant(["*"], CAP.channelsPublish));
  check("matcher: an EMPTY grant list denies (declared, granted nothing)", !withGrant([], CAP.channelsPublish));
  // a host sends channels/typing only under a channels.typing grant and grants only what's advertised
  check("the door advertises channels.typing", MCPL_ADVERTISEMENT.channels.typing === true);
  check("eidoverse.typing uses channels.typing", FEATURE_SETS["eidoverse.typing"].uses.includes(CAP.channelsTyping));
  check("the door does not advertise channels.streaming", MCPL_ADVERTISEMENT.channels.streaming === false);
  check("no feature set uses channels.streaming", Object.values(FEATURE_SETS).every((fs) => !fs.uses.includes("channels.streaming")));
}

// ── NEGATIVE CONTROL 1: an impostor listener must be REFUSED, not adopted. ──
// A plain HTTP server answering the pre-nonce "ok" on a fresh port stands in
// for a stale door; the readiness probe must throw rather than proceed.
{
  const impostorPort = kernelPort();
  const impostor = createHttpServer((_q, res) => { res.writeHead(200); res.end("ok\n"); });
  await new Promise((r) => impostor.listen(impostorPort, "127.0.0.1", r));
  let refused = false;
  try { await ready("impostor", doorNonceProbe(impostorPort), [], 3000); }
  catch (e) { refused = /stale listener/.test(String(e)); }
  impostor.close();
  check("negative control: a nonce-less listener is refused as stale, never adopted", refused);
}

// ── NEGATIVE CONTROL 1b: the OS second opinion must DEGRADE, never crash. ──
// A command that cannot exist forces the spawn-ENOENT path: listenerPids must resolve null with the process still
// alive. On non-Linux the platform guard answers null before any spawn.
{
  const r = await listenerPids(1, "ss-absent-for-portability-vector");
  check("negative control: missing `ss` ⇒ listenerPids resolves null (no crash, nonce stays the proof)",
    r === null, `got ${JSON.stringify(r)}`);
}

// ── the rig ──────────────────────────────────────────────────────────────────
console.log(`sequencer :${SEQ_PORT}, door :${DOOR_PORT}, scratch ${scratch}`);
// Seed a stale state tmp as if a previous incarnation died mid-write: the
// door must sweep it at boot (receipt for the carried #125 machinery — and it
// cannot pass vacuously, because the tmp is ALWAYS there at boot).
writeFileSync(`${statePath}.tmp`, "");
const seq = child(["server/server.ts"],
  { PORT: String(SEQ_PORT), JOIN_TOKEN: JOIN, WORLDS_DIR: scratch, WORLD_INSTANCE_NONCE: NONCE, SKIP_OPT_SWEEP: "1",
    AGENT_TOKENS_PATH: tokensPath });   // the world honours the same enrolments the MCPL door does
const door = child(["mcpl/net-server.ts"], {
  MCPL_PORT: String(DOOR_PORT), WORLD_URL: `ws://127.0.0.1:${SEQ_PORT}/ws`, WORLD_TOKEN: JOIN,
  MCPL_TOKENS: tokensPath, MCPL_STATE: statePath, MCPL_INSTANCE_NONCE: NONCE,
});

let obs = null, gatedRef = null, fullRef = null;
try {
  await ready("world /version echoes our nonce", async () => {
    const r = await fetch(`http://127.0.0.1:${SEQ_PORT}/version`);
    if (!r.ok) return false;
    const body = await r.json().catch(() => null);
    if (body && !("instance" in body)) throw new Error("a world answered but WITHOUT our nonce — stale listener");
    return body?.instance === NONCE;
  }, [seq]);
  await ready("world port owned by OUR child", ownsPort("world", SEQ_PORT, seq), [seq]);
  await ready("door /healthz echoes our nonce", doorNonceProbe(DOOR_PORT), [seq, door]);
  await ready("door port owned by OUR child", ownsPort("door", DOOR_PORT, door), [seq, door]);
  const osOwnership = (await listenerPids(SEQ_PORT)) !== null && existsSync("/proc");
  console.log(osOwnership
    ? "  identity: per-run nonce + OS port ownership (linux)"
    : "  identity: per-run nonce only (no ss//proc on this platform — OS check skipped)");
  check("stale state tmp from a previous incarnation swept at boot", !existsSync(`${statePath}.tmp`));

  // Ground truth: a raw world-ws observer, embodied, remembering every say,
  // and when each of the door body's typing signals arrived.
  const seen = [], names = {};
  const typings = [];
  // the door body's arrivals, and whether it has posed since the latest one (a body that is in the world and ticking)
  let arrivals = 0, posedSinceArrival = false, obsJoined = false;
  obs = new WebSocket(`ws://127.0.0.1:${SEQ_PORT}/ws`);
  {
    obs.onopen = () => obs.send(JSON.stringify({ type: "join", hello: helloOf(), world: "commons", id: "observer", token: JOIN, replica: true }));
    obs.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "snapshot") obsJoined = true;
      if (m.type === "arrive" && m.id === "claude") { arrivals++; posedSinceArrival = false; }
      if (m.type === "frame" && m.poses?.claude) posedSinceArrival = true;
      // chat is the log stream's say entries; their actors are opaque ids, named by the stream
      if (m.type === "snapshot") Object.assign(names, m.names ?? {});
      if (m.type === "log") { Object.assign(names, m.names ?? {});
        for (const e of m.entries ?? []) if (e?.kind === "say") seen.push({ who: names[e.actor] ?? e.actor, text: e.body?.text }); }
      if (m.type === "typing" && m.id === "claude") typings.push(Date.now());
    };
  }
  const signalled = async (before, ms) => !!(await tryUntil("a typing signal from the door's body", () => typings.length > before, { ms, step: 50 }));
  // channels/typing for this world, then whether the observer saw a typing
  // signal from the door's body within the window. The body sends at most one
  // a second, so the caller waits that out before asking for "none".
  const typingRaised = async (rpc, ms) => {
    const before = typings.length;
    rpc.notify("channels/typing", { channelId: "world:commons", op: "start" });
    const raised = await signalled(before, ms);
    rpc.notify("channels/typing", { channelId: "world:commons", op: "stop" });
    return raised;
  };
  await until("the observer joins the world", () => obsJoined, { ms: 8000 });

  // ---- a minimal newline-JSON-RPC MCPL client over ws ----------------------
  class Rpc {
    constructor(url) {
      this.ws = new WebSocket(url);
      this.next = 1;
      this.pending = new Map();
      this.incoming = [];
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
    async init(mcpl = "0.5") {
      await this.open;
      const r = await this.request("initialize", {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "cap-gate-test", version: "0" },
        capabilities: mcpl ? { experimental: { mcpl: { version: mcpl } } } : {},
      });
      this.notify("notifications/initialized", {});
      return r;
    }
    close() { try { this.ws.close(); } catch {} }
  }

  // ---- phase 0: the fences before any grant: a plain-MCP host never, an 0.4 host keeps all
  {
    const plain = gatedRef = new Rpc(`ws://127.0.0.1:${DOOR_PORT}/mcpl?token=gate-token`);
    await plain.init(null);
    const p = await plain.request("channels/open", { channelId: "world:commons" });
    check("plain-MCP host (never declared MCPL) gets NO channel verbs: channels/open -32003", p.error?.code === -32003, JSON.stringify(p).slice(0, 160));
    plain.close();
    const legacy = gatedRef = new Rpc(`ws://127.0.0.1:${DOOR_PORT}/mcpl?token=gate-token`);
    await legacy.init("0.4");
    const l = await legacy.request("channels/open", { channelId: "world:commons" });
    check("legacy 0.4 MCPL host with no policy keeps everything: channels/open answers", !!l.result?.channel, JSON.stringify(l).slice(0, 160));
    legacy.close();
  }

  // ---- phase 1: a 0.5 host, deny-until-policy then incoming-only -----------
  const gated = gatedRef = new Rpc(`ws://127.0.0.1:${DOOR_PORT}/mcpl?token=gate-token`);
  await gated.init();

  let r = await gated.request("channels/publish", {
    channelId: "world:commons", content: [{ type: "text", text: "LEAK-prepolicy" }] });
  check("0.5 host: channels/publish is refused BEFORE policy (deny-until-policy window)",
    r.error?.code === -32003, JSON.stringify(r).slice(0, 120));

  r = await gated.request("featureSets/update", { effectiveCapabilities: ["channels.incoming"] });
  check("featureSets/update (incoming-only) is accepted with a degradation receipt",
    r.result?.accepted === true && r.result?.mode === "degraded", JSON.stringify(r).slice(0, 160));

  r = await gated.request("channels/publish", {
    channelId: "world:commons", content: [{ type: "text", text: "LEAK-postpolicy" }] });
  check("incoming-only: channels/publish -32003, saying posting again won't help",
    r.error?.code === -32003 && r.error?.message === "your host hasn't granted this door channels.publish, so nothing was posted, and posting again won't change that; if you need it, ask whoever runs your host",
    JSON.stringify(r).slice(0, 200));
  const lifecycleRefusal = "your host hasn't granted this door channels.lifecycle, so no channel was opened or closed, and calling again won't change that; if you need it, ask whoever runs your host";
  r = await gated.request("channels/open", { channelId: "world:commons" });
  check("incoming-only: channels/open -32003, naming the grant and whom to ask",
    r.error?.code === -32003 && r.error?.message === lifecycleRefusal, JSON.stringify(r).slice(0, 260));
  r = await gated.request("channels/close", { channelId: "world:commons" });
  check("incoming-only: channels/close -32003, naming the grant and whom to ask",
    r.error?.code === -32003 && r.error?.message === lifecycleRefusal, JSON.stringify(r).slice(0, 260));
  r = await gated.request("tools/list", {});
  check("incoming-only: tools/list is EMPTY (denied ⇒ as if never advertised)",
    Array.isArray(r.result?.tools) && r.result.tools.length === 0, JSON.stringify(r).slice(0, 120));
  r = await gated.request("tools/call", { name: "say", arguments: { text: "LEAK-tool" } });
  check("incoming-only: tools/call -32601, saying who can grant the tools",
    r.error?.code === -32601 && r.error?.message === "your host hasn't granted this door the tools capability, so the call didn't run, and calling it again won't change that; if you need it, ask whoever runs your host",
    JSON.stringify(r).slice(0, 200));
  gated.close();
  // "nothing leaked" is read after phase 2's say has landed: the world log is ordered, so a LEAK would be before it

  // ---- phase 2: a granted host — allowed operations still work -------------
  const arrivedBefore = arrivals;
  const full = fullRef = new Rpc(`ws://127.0.0.1:${DOOR_PORT}/mcpl?token=gate-token`);
  await full.init();
  // First, the grant a host gave this door before it used channels.typing:
  // everything else, the stream included. The typing feature set is then
  // unavailable for want of channels.typing, so the receipt is degraded and
  // names it, and channels/typing from that host raises no dots.
  r = await full.request("featureSets/update", {
    effectiveCapabilities: ["tools", "channels.register", "channels.lifecycle",
      "channels.publish", "channels.incoming", "channels.streaming"] });
  const typingSet = r.result?.unavailableFeatures?.find((u) => u.featureSet === "eidoverse.typing");
  check("a grant without channels.typing: mode degraded, eidoverse.typing alone unavailable, for want of channels.typing",
    r.result?.accepted === true && r.result?.mode === "degraded" && r.result?.unavailableFeatures?.length === 1 &&
      JSON.stringify(typingSet?.missingCapabilities) === JSON.stringify(["channels.typing"]),
    JSON.stringify(r).slice(0, 240));
  // the takeover from phase 1's dead session: the new body is in the world and ticking before "no dots" can mean anything
  await until("the door's new body arrives and poses", () => arrivals > arrivedBefore && posedSinceArrival);
  check("…and channels/typing from that host raises no dots (dropped at the grant gate)",
    !(await typingRaised(full, 1500)));
  // Then the grant a host gives this door now: everything it advertises.
  r = await full.request("featureSets/update", {
    effectiveCapabilities: ["tools", "channels.register", "channels.lifecycle",
      "channels.publish", "channels.incoming", "channels.typing"] });
  check("full grant accepted, mode full", r.result?.accepted === true && r.result?.mode === "full",
    JSON.stringify(r).slice(0, 160));
  await pause("the body's one-a-second typing throttle", 1200);
  check("granted: channels/typing raises the dots, from the same host and body",
    await typingRaised(full, 3000));
  // A grant that withdraws channels.typing while the dots are up ends them:
  // after a moment for a signal already in flight, no new one arrives.
  await pause("the body's one-a-second typing throttle", 1200);
  let before = typings.length;
  full.notify("channels/typing", { channelId: "world:commons", op: "start" });
  check("…and they're up again before the grant changes", await signalled(before, 3000));
  r = await full.request("featureSets/update", {
    effectiveCapabilities: ["tools", "channels.register", "channels.lifecycle",
      "channels.publish", "channels.incoming"] });
  check("a grant that withdraws channels.typing is accepted, eidoverse.typing unavailable",
    r.result?.accepted === true && r.result?.unavailableFeatures?.some((u) => u.featureSet === "eidoverse.typing"),
    JSON.stringify(r).slice(0, 200));
  await pause("a signal already in flight lands", 1000);
  before = typings.length;
  await pause("5.5 s spans the body's typing refresh: no new signal in it IS the row", 5500);
  check("…and the dots it was keeping up get no new signal", typings.length === before,
    `typing signals after the grant changed: ${typings.length - before}`);
  // Granted again for the rest of the run.
  r = await full.request("featureSets/update", {
    effectiveCapabilities: ["tools", "channels.register", "channels.lifecycle",
      "channels.publish", "channels.incoming", "channels.typing"] });
  check("granted again, mode full", r.result?.accepted === true && r.result?.mode === "full",
    JSON.stringify(r).slice(0, 160));
  await pause("the body's one-a-second typing throttle", 1200);
  check("…and a start under the restored grant raises the dots again", await typingRaised(full, 3000));
  r = await full.request("channels/publish", {
    channelId: "world:commons", content: [{ type: "text", text: "granted-hello-from-the-door" }] });
  check("granted: channels/publish delivers", r.result?.delivered === true, JSON.stringify(r).slice(0, 120));
  const landed = !!(await tryUntil("the granted say lands in the world log",
    () => seen.some((s) => s.who === "claude" && String(s.text).includes("granted-hello-from-the-door")), { ms: 6000, step: 200 }));
  check("…and the say actually LANDED in the world (observer ground truth)", landed,
    JSON.stringify(seen.slice(-3)));
  check("nothing leaked: the observer saw NO say from the gated session (read past the granted say)",
    landed && !seen.some((s) => String(s.text).includes("LEAK")), JSON.stringify(seen).slice(0, 160));
  // a publish is cut as the say tool cuts (tools.ts cutSpeech): never in half of a surrogate pair
  await pause("the say rate between two says", 1500);
  const long = "y".repeat(3999) + "\u{1F600}";
  r = await full.request("channels/publish", { channelId: "world:commons", content: [{ type: "text", text: long }] });
  const cut = await tryUntil("the long say lands", () => seen.find((s) => s.who === "claude" && String(s.text).startsWith("yyyy")), { ms: 6000, step: 200 });
  const t = String(cut?.text ?? "");
  check("a publish cut at 4000 never ends in half of a surrogate pair", r.result?.delivered === true && t.length === 3999 && !/[\uD800-\uDBFF]$/.test(t),
    JSON.stringify({ delivered: r.result?.delivered, len: t.length, tail: [...t.slice(-2)].map((c) => c.codePointAt(0).toString(16)) }));
  r = await full.request("channels/open", { channelId: "world:commons", history: { limit: 5 } });
  check("granted: channels/open answers with the channel", !!r.result?.channel, JSON.stringify(r).slice(0, 120));

  // ---- phase 3: live mention routing (observer → world → door → host) ------
  obs.send(JSON.stringify({ type: "request", id: "obs-say", verb: "say", args: { text: "hey @claude — live mention check" } }));
  const mention = await tryUntil("a channels/incoming carrying the mention", () => full.incoming.find((m) =>
    m.method === "channels/incoming" &&
    JSON.stringify(m.params ?? {}).includes("live mention check")), { ms: 8000 });
  check("a world say naming @claude arrives as channels/incoming", !!mention, "no incoming frame observed");
  if (mention) {
    const msg = mention.params?.messages?.[0] ?? {};
    check("…tagged chat:mention", Array.isArray(msg.tags) && msg.tags.includes("chat:mention"), JSON.stringify(msg.tags));
    check("…with metadata.mentioned (transition shim)", msg.metadata?.mentioned === true, JSON.stringify(msg.metadata));
  }

  // ── NEGATIVE CONTROL 2: the state override actually took. The door has
  // persisted by now (prelude persistState) — state must exist in SCRATCH.
  check("negative control: door state landed in the scratch dir, not the repository",
    existsSync(statePath), `no ${statePath}`);
} finally {
  if (gatedRef) gatedRef.close();
  if (fullRef) fullRef.close();
  if (obs) { try { obs.close(); } catch {} }
  // Verified termination: SIGTERM, await exit, SIGKILL only on timeout —
  // the door's signal handler needs the grace to sweep its own tmp.
  await Promise.all(kids.map((p) => awaitExit(p)));
  // Scratch receipts BEFORE removal: an orderly door leaves state, never tmp.
  check("teardown: no state tmp left in the owned state dir", !existsSync(`${statePath}.tmp`));
  const after = snapState();
  check("repository state untouched by this run (byte+mtime receipt)",
    after.exists === repoStateBefore.exists && after.mtimeMs === repoStateBefore.mtimeMs && after.hash === repoStateBefore.hash,
    JSON.stringify({ before: repoStateBefore, after }));
  check("repository has no state tmp", !existsSync(`${REPO_STATE}.tmp`));
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  check("scratch directory cleaned", !existsSync(scratch));
}

S.done();
