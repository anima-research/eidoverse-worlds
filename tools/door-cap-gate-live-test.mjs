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
// 🔴 THE HARNESS OWNS ITS PORTS, ITS STATE, AND ITS CHILDREN (#129 re-review:
// "the owned-scratch harness is neither owned nor scratch-clean"). The first
// cut used random fixed ports, accepted readiness from unauthenticated
// endpoints, let the door write the REPOSITORY's mcpl/state.json, and its
// teardown SIGKILLed without awaiting exit — the same defect class #125 just
// closed. This is the repository's established pattern from
// tools/join-rfc005.test.ts, reused rather than re-invented: kernel-assigned
// ports, per-run instance nonces both children echo, OS port-ownership as a
// Linux second opinion, scratch-bound tokens/worlds/state, verified
// termination, and repo-state before/after byte receipts. Once both slices
// land, the shared pieces deserve extraction into one harness module.
//
// Run: bun tools/door-cap-gate-live-test.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";

/** A port nothing is listening on RIGHT NOW: bind :0, read what the kernel
 *  gave us, release it. Racy in principle — which is why readiness below
 *  verifies ownership rather than trusting that whatever answers is ours. */
async function freePort() {
  return await new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}
const SEQ_PORT = await freePort(), DOOR_PORT = await freePort();
const JOIN = "cap-gate-test-door";
const NONCE = `t${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const scratch = mkdtempSync(join(tmpdir(), "capgate-"));
const tokensPath = join(scratch, "tokens.json");
const statePath = join(scratch, "state.json");
writeFileSync(tokensPath, JSON.stringify({
  "gate-token": { id: "claude", name: "Claude", world: "commons" },
}));
// Repository state must be untouched by a run. Snapshot before, compare after.
const REPO_STATE = new URL("../mcpl/state.json", import.meta.url).pathname;
const snapState = () => existsSync(REPO_STATE)
  ? { exists: true, mtimeMs: statSync(REPO_STATE).mtimeMs,
      hash: new Bun.CryptoHasher("sha256").update(readFileSync(REPO_STATE)).digest("hex") }
  : { exists: false, mtimeMs: 0, hash: "" };
const repoStateBefore = snapState();
const BUN = process.execPath.includes("bun") ? process.execPath : "/home/claude/.bun/bin/bun";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};

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

/** PIDs listening on a TCP port, from the OS — Linux second opinion (no `ss`
 *  or /proc ⇒ null, and the per-run nonce remains the portable proof).
 *  Non-Linux returns null without spawning: the second opinion is Linux-only
 *  by design, and a macOS host must not pay a spawn to learn that. On Linux a
 *  missing `ss` surfaces as an ASYNC `error` event on the child (Node/Bun do
 *  not throw ENOENT synchronously from spawn) — an unhandled one is a process
 *  crash via `uncaughtException`, which is exactly the non-portability the
 *  #129 re-review caught. Handle it as: cannot answer ⇒ null. */
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
async function waitFor(what, probe, deps, ms = 20000) {
  const deadline = Date.now() + ms;
  let lastErr = "";
  while (Date.now() < deadline) {
    for (const d of deps) if (d.exitCode !== null) throw new Error(`${what}: child exited early (${d.exitCode}) ${d.errText()}`);
    try { if (await probe()) return; } catch (e) { lastErr = e.message; if (/stale listener/.test(lastErr)) throw e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what}: not ready within ${ms}ms${lastErr ? ` (last: ${lastErr})` : ""}`);
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

// ── NEGATIVE CONTROL 1: an impostor listener must be REFUSED, not adopted. ──
// A plain HTTP server answering the pre-nonce "ok" on a fresh port stands in
// for a stale door; the readiness probe must throw rather than proceed.
{
  const impostorPort = await freePort();
  const impostor = createHttpServer((_q, res) => { res.writeHead(200); res.end("ok\n"); });
  await new Promise((r) => impostor.listen(impostorPort, "127.0.0.1", r));
  let refused = false;
  try { await waitFor("impostor", doorNonceProbe(impostorPort), [], 3000); }
  catch (e) { refused = /stale listener/.test(String(e)); }
  impostor.close();
  check("negative control: a nonce-less listener is refused as stale, never adopted", refused);
}

// ── NEGATIVE CONTROL 1b: the OS second opinion must DEGRADE, never crash. ──
// (#129 re-review: on a host without `ss`, spawn ENOENT arrives as an async
// `error` event; unhandled, it killed the whole harness before any behavioral
// vector ran.) Force that exact path with a command that cannot exist and
// require the documented contract: resolve null — the per-run nonce remains
// the portable proof — with the process still alive to say so. On non-Linux
// the platform guard answers null before any spawn; same contract, earlier.
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
  { PORT: String(SEQ_PORT), JOIN_TOKEN: JOIN, WORLDS_DIR: scratch, WORLD_INSTANCE_NONCE: NONCE });
const door = child(["mcpl/net-server.ts"], {
  MCPL_PORT: String(DOOR_PORT), WORLD_URL: `ws://127.0.0.1:${SEQ_PORT}/ws`, WORLD_TOKEN: JOIN,
  MCPL_TOKENS: tokensPath, MCPL_STATE: statePath, MCPL_INSTANCE_NONCE: NONCE,
});

let obs = null, gatedRef = null, fullRef = null;
try {
  await waitFor("world /version echoes our nonce", async () => {
    const r = await fetch(`http://127.0.0.1:${SEQ_PORT}/version`);
    if (!r.ok) return false;
    const body = await r.json().catch(() => null);
    if (body && !("instance" in body)) throw new Error("a world answered but WITHOUT our nonce — stale listener");
    return body?.instance === NONCE;
  }, [seq]);
  await waitFor("world port owned by OUR child", ownsPort("world", SEQ_PORT, seq), [seq]);
  await waitFor("door /healthz echoes our nonce", doorNonceProbe(DOOR_PORT), [seq, door]);
  await waitFor("door port owned by OUR child", ownsPort("door", DOOR_PORT, door), [seq, door]);
  const osOwnership = (await listenerPids(SEQ_PORT)) !== null && existsSync("/proc");
  console.log(osOwnership
    ? "  identity: per-run nonce + OS port ownership (linux)"
    : "  identity: per-run nonce only (no ss//proc on this platform — OS check skipped)");
  check("stale state tmp from a previous incarnation swept at boot", !existsSync(`${statePath}.tmp`));

  // Ground truth: a raw world-ws observer, embodied, remembering every say.
  const seen = [];
  obs = new WebSocket(`ws://127.0.0.1:${SEQ_PORT}/ws`);
  const obsJoined = new Promise((resolve) => {
    obs.onopen = () => obs.send(JSON.stringify({ type: "join", world: "commons", id: "observer", token: JOIN }));
    obs.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "snapshot") resolve(true);
      if (m.type === "log" && m.entry?.verb === "say") seen.push({ who: m.entry.actor, text: m.entry.args?.text });
    };
  });
  if (!(await Promise.race([obsJoined, new Promise((r) => setTimeout(() => r(false), 8000))]))) {
    throw new Error("observer could not join the world");
  }

  // ---- a minimal newline-JSON-RPC MCPL client over ws ----------------------
  class Rpc {
    constructor(url) {
      this.ws = new WebSocket(url);
      this.next = 1;
      this.pending = new Map();
      this.incoming = [];
      this.waiters = [];
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

  // ---- phase 1: a 0.5 host, deny-until-policy then incoming-only -----------
  const gated = gatedRef = new Rpc(`ws://127.0.0.1:${DOOR_PORT}/mcpl?token=gate-token`);
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

  // ---- phase 2: a granted host — allowed operations still work -------------
  const full = fullRef = new Rpc(`ws://127.0.0.1:${DOOR_PORT}/mcpl?token=gate-token`);
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

  // ---- phase 3: live mention routing (observer → world → door → host) ------
  obs.send(JSON.stringify({ type: "verb", verb: "say", args: { text: "hey @claude — live mention check" } }));
  const mention = await full.waitFor((m) =>
    m.method === "channels/incoming" &&
    JSON.stringify(m.params ?? {}).includes("live mention check"), 8000);
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

console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
