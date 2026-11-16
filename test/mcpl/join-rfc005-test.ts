// In-session world travel — integration test for the `travel` tool lane.
// Starts its own world + MCPL door on VERIFIED-FREE ports with a temp tokens
// file and a temp state file, then covers: join policy (denied / granted /
// listed-but-outside), founding vs joining, dial-time ?world=, epoch across
// transitions, host prepare/commit refusal, per-world door state, the
// plain-MCP lane, and travel while the world server is down (refused before
// detaching; a failure after detach is not staged).
//
// The harness owns its ports, its state and its children: readiness proves each responder is the child this run
// spawned (a per-run nonce, plus OS port ownership on Linux), and the door's state goes to a temp file, never the
// repository's mcpl/state.json. A green row then means the code under test did it.
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, existsSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundWorlds, freePort } from "../harness/harness.ts";
import { suite } from "../gate/suite.ts";
import { until, tryUntil, pause } from "../gate/wait.ts";
import { helloOf } from "../../shared/protocol/hello.js";

// probe-then-release is racy, which is why readiness below verifies ownership rather than trusting whatever answers
const WPORT = freePort(8950);
const MPORT = freePort(WPORT + 2000);
const worldsDir = mkdtempSync(join(tmpdir(), "eido-join-"));
const tokensPath = join(worldsDir, "tokens.json");
// the worlds an agent may join exist before the run (joining never founds one; a world is founded by its operator)
foundWorlds(worldsDir, ["commons", "annex"]);
// a world the roamer agent owns, for THE WORLD DECIDES below (its owner closes and opens it)
foundWorlds(worldsDir, ["keep"], "agent:token:roamer");
// The door's durable state lives with this run's scratch and dies with it.
const statePath = join(worldsDir, "state.json");
// Repository state must be untouched by a run. Snapshot before, compare after.
const REPO_STATE = fileURLToPath(new URL("../../mcpl/state.json", import.meta.url));
const repoStateBefore = existsSync(REPO_STATE)
  ? { exists: true, mtimeMs: statSync(REPO_STATE).mtimeMs, size: statSync(REPO_STATE).size }
  : { exists: false, mtimeMs: 0, size: 0 };
// A credential can only NARROW where its agent goes (docs/decisions/WORLD-ACCESS.md):
// `worlds` keeps it to a list, `create: false` stops it founding, and a
// credential with neither goes wherever the worlds themselves let it.
writeFileSync(tokensPath, JSON.stringify({
  "bound-token":   { id: "bound",   name: "Bound",   world: "commons", worlds: ["commons"] },
  "roamer-token":  { id: "roamer",  name: "Roamer",  world: "commons", worlds: ["*"], create: true },
  "nofound-token": { id: "nofound", name: "NoFound", world: "commons", worlds: ["*"], create: false },
  "roamer2-token": { id: "roamer2", name: "Roamer2", world: "commons", worlds: ["annex"] },
  "free-token":    { id: "free",    name: "Free",    world: "commons" },
}));
const S = suite("join-rfc005");
const check = (name: string, ok: unknown, extra?: unknown) => S.check(name, ok, extra);

// A nonce this run owns, echoed by the door's /healthz.
const NONCE = `t${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

// Every child is registered as it is spawned, so the finally block and the exit hook reach it even if a later spawn
// throws.
const spawned: { pid: number; kill: (sig?: string) => void; exitCode: number | null }[] = [];
function spawnChild(args: string[], env: Record<string, string>) {
  const child = Bun.spawn(args, { env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" });
  spawned.push(child as unknown as typeof spawned[number]);
  return child;
}
// Last-resort net: if anything between here and the try throws (a spawn included: installed before the first; bot #333 203), or the process
// dies by signal, the children still go. process.exit does NOT run finally
// blocks, so this cannot be left to the one at the bottom.
const reap = () => { for (const c of spawned) { try { c.kill(); } catch { /* gone */ } } };
process.on("exit", reap);
process.on("uncaughtException", (e) => { reap(); console.error(e); process.exit(1); });
const world = spawnChild([process.execPath, "server/server.ts"], {
  PORT: String(WPORT), WORLDS_DIR: worldsDir, WORLD_INSTANCE_NONCE: NONCE, SKIP_OPT_SWEEP: "1",
  // the sequencer reads the SAME credential file as the door (as in production, where both read mcpl/tokens.json): the
  // world honours the same enrolments, and the door asks it /access as the agent, so it must know the agent's bearer
  AGENT_TOKENS_PATH: tokensPath, HN_SESSIONS_FILE: join(worldsDir, "sessions.json"),
});
// Seed a stale tmp, as a previous incarnation killed between write and rename leaves: the door must sweep it at boot,
// so the "no temp file" rows exercise the cleanup on every run.
writeFileSync(`${statePath}.tmp`, "");
const doorEnv = {
  MCPL_PORT: String(MPORT), WORLD_URL: `ws://127.0.0.1:${WPORT}/ws`,
  MCPL_TOKENS: tokensPath, MCPL_STATE: statePath, MCPL_INSTANCE_NONCE: NONCE,
};
let mcpl = spawnChild([process.execPath, "mcpl/net-server.ts"], doorEnv);
/** Restart ONLY the door — same port, same state file, same nonce — and wait
 *  until the new process proves it is ours. (§4l: what a door restart keeps.) */
async function restartDoor() {
  try { mcpl.kill(); } catch { /* already gone */ }
  await tryUntil("the old door exits", () => mcpl.exitCode !== null || mcpl.signalCode !== null, { ms: 5000 });
  mcpl = spawnChild([process.execPath, "mcpl/net-server.ts"], doorEnv);
  await ready("restarted door /healthz echoes our nonce", async () => {
    const r = await fetch(`http://127.0.0.1:${MPORT}/healthz`);
    return r.ok && (await r.text()).trim() === `ok ${NONCE}`;
  });
}

/** PIDs listening on a TCP port, from the OS; null when this platform cannot answer (no `ss`), which is not the same
 *  as "nothing is listening". Linux-only, so it is the second opinion: the portable proof is the per-run nonce. */
async function listenerPids(port: number): Promise<number[] | null> {
  try {
    const p = Bun.spawn(["ss", "-lntpH"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return null;
    const pids: number[] = [];
    for (const line of out.split("\n")) {
      if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
      for (const m of line.matchAll(/pid=(\d+)/g)) pids.push(Number(m[1]));
    }
    return [...new Set(pids)];
  } catch { return null; }          // no `ss` on this platform
}

/** Transitive children of a pid, via /proc — Bun.spawn of a .ts file may exec
 *  a child that does the actual listening, so "port pid === our pid" is too
 *  strict. */
function descendantsOf(root: number): number[] {
  const out: number[] = [];
  if (!existsSync("/proc")) return out;   // no procfs: caller falls back to the nonce
  const walk = (pid: number, depth = 0) => {
    if (depth > 6) return;
    let kids = "";
    try { kids = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8"); } catch { return; }
    for (const k of kids.trim().split(/\s+/).filter(Boolean)) {
      const n = Number(k); out.push(n); walk(n, depth + 1);
    }
  };
  walk(root);
  return out;
}

/** until() on a readiness probe, failing FAST (not at the deadline) when a child dies or the probe names a stale
 *  listener: the probe returns true when ready, a string when it never will be. */
async function ready(what: string, probe: () => Promise<boolean | string>, ms = 20_000) {
  const r = await until(what, async () => {
    if (world.exitCode !== null) return `world child exited early (code ${world.exitCode})`;
    if (mcpl.exitCode !== null) return `door child exited early (code ${mcpl.exitCode})`;
    return await probe();
  }, { ms });
  if (r !== true) throw new Error(`${what}: ${r}`);
}

/** The port must be held by the child we spawned (or a descendant). This is
 *  the OS's answer, not the app's — an app endpoint can only tell you what the
 *  app believes, and a stale listener believes it is fine. */
function ownsPort(name: string, port: number, child: { pid: number }) {
  return async () => {
    const pids = await listenerPids(port);
    // null = this platform cannot answer: the nonce has already proved identity, so the wait resolves, and the skip
    // is printed (osOwnership below).
    if (pids === null) return true;
    if (pids.length === 0) return false;
    const ours = new Set([child.pid, ...descendantsOf(child.pid)]);
    // A foreign listener is foreign however many pids we own (bun running the .ts in-process owns just one); the only
    // exemption is not being able to enumerate at all, the `pids === null` return above.
    const foreign = pids.filter((p) => !ours.has(p));
    if (foreign.length) {
      return `${name} port ${port} held by pid(s) ${foreign.join(",")}, not our child ${child.pid} — stale listener`;
    }
    return true;
  };
}

/** Whether the OS-level check ran on this platform: printed, so a reader knows which proofs the run got. */
async function osOwnershipAvailable(): Promise<boolean> {
  return (await listenerPids(WPORT)) !== null && existsSync("/proc");
}

// Identity, not liveness: "the port answers" is the check a stale listener passes. Every probe runs inside the try,
// so a startup or identity failure still reaches the teardown.
let osOwnership = false;
try {
await ready("world /version echoes our nonce", async () => {
  const r = await fetch(`http://127.0.0.1:${WPORT}/version`);
  if (!r.ok) return false;
  const body = await r.json().catch(() => null) as { instance?: string } | null;
  // A world answering WITHOUT our instance field is a stale listener, not a
  // slow start — say so rather than spinning until the deadline.
  if (body && !("instance" in body)) {
    return "a world answered but WITHOUT our nonce — stale listener on this port";
  }
  return body?.instance === NONCE;
});
await ready("world port is owned by OUR child", ownsPort("world", WPORT, world));
// Two independent proofs for the door: it echoes a nonce only we set, AND the
// OS says the port is our child's. The nonce is the PORTABLE one; the OS check
// is a stricter second opinion, and is skipped (loudly, below) where the
// platform cannot answer.
await ready("door /healthz echoes our nonce", async () => {
  const r = await fetch(`http://127.0.0.1:${MPORT}/healthz`);
  if (!r.ok) return false;
  const body = (await r.text()).trim();
  if (body === "ok") return "a door answered but WITHOUT our nonce — stale listener on this port";
  return body === `ok ${NONCE}`;
});
await ready("door port is owned by OUR child", ownsPort("door", MPORT, mcpl));

// Say which proofs this run got: nonce only, or nonce + OS.
osOwnership = await osOwnershipAvailable();
console.log(osOwnership
  ? "  identity: per-run nonce + OS port ownership (linux)"
  : "  identity: per-run nonce only (no ss//proc on this platform — OS check skipped)");

// The seeded stale tmp (above, before the spawn) must be gone once the door
// answers /healthz: interrupted atomic writes are cleaned at boot, not left as
// artifacts indistinguishable from live failures.
check("stale state tmp from a previous incarnation swept at boot", !existsSync(`${statePath}.tmp`));

/** Every connection here starts at the credential's HOME unless it names a
 *  world: an agent with no world asked for now RESUMES where it last was
 *  (§4l), and these sections are about what happens from home. RESUME (the
 *  marker) dials with no world at all, which is what §4l tests. */
const RESUME = "__resume";
const startAt = (query: string) => query === RESUME ? "" : /[?&]world=/.test(query) ? query : `${query}&world=commons`;
/** Minimal MCPL 0.5 host: initialize, grant, then request/notification I/O. */
async function connectHost(token: string, query = "", mode: "accept" | "decline" | "mute" | "error" = "accept") {
  const ws = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=${token}${startAt(query)}`);
  let nextId = 10;
  const pending = new Map<number, (m: any) => void>();
  const inbound: any[] = [];
  const rpc = (obj: any) => ws.send(JSON.stringify(obj));
  const request = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => {
    const id = nextId++; pending.set(id, resolve); rpc({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, 15_000);
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
    inbound.push(m);
    if (m.id !== undefined && m.method) {
      if (m.method === "channels/changed" && mode !== "accept") {
        if (mode === "mute") return;                       // never answer: server must fail closed
        if (mode === "error") {                            // answer with an error, not a verdict
          rpc({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "policy store unavailable" } });
          return;
        }
        const added = (m.params?.added ?? []) as { id: string }[];
        rpc({ jsonrpc: "2.0", id: m.id, result: { results: added.map((c) => ({ id: c.id, accepted: false, reason: "test_decline" })) } });
        return;
      }
      rpc({ jsonrpc: "2.0", id: m.id, result: {} });       // ack server Requests
    }
  };
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("open timeout")), 6000);
    ws.onopen = () => { clearTimeout(t); res(); };
  });
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { experimental: { mcpl: { version: "0.5", channels: { register: true, incoming: true } } } },
    clientInfo: { name: "join-test", version: "0" },
  });
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  await request("featureSets/update", {
    effectiveCapabilities: ["tools", "channels.register", "channels.lifecycle", "channels.join", "channels.publish", "channels.incoming"],
  });
  return { ws, request, inbound, init };
}

/** A plain-MCP client: the same transport, but `initialize` omits capabilities.experimental.mcpl, so the server sets
 *  mcplClient = false and granted() is false for every capability. The plain-MCP travel rows (4i, 4j) use it. */
async function connectPlain(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=${token}${startAt("")}`);
  let nextId = 10;
  const pending = new Map<number, (m: any) => void>();
  const inbound: any[] = [];
  const rpc = (obj: any) => ws.send(JSON.stringify(obj));
  const request = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => {
    const id = nextId++; pending.set(id, resolve); rpc({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, 15_000);
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
    inbound.push(m);
    if (m.id !== undefined && m.method) rpc({ jsonrpc: "2.0", id: m.id, result: {} });
  };
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("open timeout")), 6000);
    ws.onopen = () => { clearTimeout(t); res(); };
  });
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},                       // ← NO experimental.mcpl. This is the point.
    clientInfo: { name: "plain-mcp-test", version: "0" },
  });
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { ws, request, inbound };
}

/** Raw world-WS watcher parked in a world, recording leave/join broadcasts. */
async function watchWorld(w: string, id: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${WPORT}/ws`);
  const events: any[] = [];
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("watcher join timeout")), 6000);
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); events.push(m);
      if (m.type === "snapshot") { clearTimeout(t); res(); } };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: w, id, avatar: "a.vrm", replica: true }));
  });
  return { ws, events };
}

const txt = (r:any) => r.result?.content?.[0]?.text ?? "";
/** Close a host connection and wait for the close to complete, so the next dial on the credential starts clean. */
async function shut(h: { ws: WebSocket }) {
  h.ws.close();
  await tryUntil("the host socket closes", () => h.ws.readyState === WebSocket.CLOSED, { ms: 5000 });
}

  // (no startup sleep: readiness above proved both children are up and are the processes we spawned)

  // ── 1. a credential limited to its home → deny, and the session survives ──
  // Driven through the tool: the channels/open sibling-join lane was removed, so the tool is the only lane.
  const bound = await connectHost("bound-token");
  const denied = await bound.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("a credential limited to commons is refused elsewhere", denied.result?.isError === true && /outside the worlds this credential is limited to/.test(denied.result?.content?.[0]?.text ?? ""), JSON.stringify(denied.result));
  const still = await bound.request("channels/list", {});
  check("denied session still attached to commons", still.result?.channels?.[0]?.id === "world:commons", JSON.stringify(still.result));

  // ── 3. a sibling world id through channels/open is now an unknown channel ─
  // The lane is gone, so this must be a clean -32023 rather than a silent join.
  const sib = await bound.request("channels/open", { channelId: "world:annex" });
  check("sibling channels/open is -32023 (lane removed, not silently joining)",
    sib.error?.code === -32023 && /travel/.test(sib.error?.message ?? ""), JSON.stringify(sib.error));
  const unk = await bound.request("channels/open", { channelId: "discord:#nope" });
  check("unknown channel is -32023 (not legacy -32004)", unk.error?.code === -32023, JSON.stringify(unk));
  const home = await bound.request("channels/list", {});
  check("…and the session did NOT move on either refusal", home.result?.channels?.[0]?.id === "world:commons", JSON.stringify(home.result));
  bound.ws.close();

  // ── 2. worlds:["*"] → travel granted, and the host is told ───────────────
  const commonsWatch = await watchWorld("commons", "watcher");
  const roamer = await connectHost("roamer-token");
  const joined = await roamer.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("policied travel arrives", !joined.result?.isError && /(Arrived in|Founded and entered) "annex"/.test(txt(joined)), txt(joined));
  await tryUntil("the host hears the commit (removed: world:commons)", () =>
    roamer.inbound.some((m) => m.method === "channels/changed" && m.params?.removed?.includes("world:commons")));
  // A successful travel tells the host both halves in two frames: the prepare asks (`added` only: a question asserts
  // nothing) and the commit states the departure once it is a fact (4f: a declining host must never see a removal).
  const changedFrames = roamer.inbound.filter((m) => m.method === "channels/changed");
  const addedAnnex = changedFrames.some((m) => m.params?.added?.[0]?.id === "world:annex");
  const retiredCommons = changedFrames.some((m) => m.params?.removed?.includes("world:commons"));
  check("channels/changed retires old world, adds new",
    addedAnnex && retiredCommons,
    JSON.stringify(changedFrames.map((m) => m.params)));
  const after = await roamer.request("channels/list", {});
  check("channels/list agrees the session moved", after.result?.channels?.[0]?.id === "world:annex", JSON.stringify(after.result));
  // …and opening the channel you are already in, with optional history, is the ordinary MCPL operation, untouched.
  const reopen = await roamer.request("channels/open", { type: "world", address: { world: "annex" }, history: { limit: 5 } });
  check("current-channel open still plain-opens (with history)", reopen.result?.channel?.id === "world:annex", JSON.stringify(reopen));
  // atomicity, world-side: the commons watcher saw the body actually LEAVE
  const leftEv = (m: any) => (m.type === "leave" || m.type === "part" || m.type === "left") && (m.id === "roamer" || m.who === "roamer");
  await tryUntil("the commons watcher sees roamer leave", () => commonsWatch.events.some(leftEv));
  const left = commonsWatch.events.some(leftEv);
  const ghost = commonsWatch.events.filter((m) => m.type === "say" && m.id === "roamer").length;
  check("old world saw the body leave (no dual presence)", left, "leave-ish events: " + JSON.stringify(commonsWatch.events.map((m) => m.type).slice(-12)) + ` ghost says: ${ghost}`);
  commonsWatch.ws.close();
  // in-session denial for a LISTED credential asking outside its list
  const roamer2 = await connectHost("roamer2-token");
  const outside = await roamer2.request("tools/call", { name: "travel", arguments: { world: "elsewhere" } });
  check("worlds:[annex] credential denied for other worlds",
    outside.result?.isError === true && /^travel refused, so you're still in "commons": world "elsewhere" is outside the worlds this credential is limited to/.test(txt(outside)), txt(outside));
  roamer2.ws.close();

  // ── 4. dial-time ?world= under the same policy ────────────────────────────
  const dialed = await connectHost("roamer2-token", "&world=annex");
  const dl = await dialed.request("channels/list", {});
  check("?world= honored for a policied credential", dl.result?.channels?.[0]?.id === "world:annex", JSON.stringify(dl.result));
  dialed.ws.close();
  // §3.3: a denied dial-time destination refuses the connection, with no silent fallback to the minted world. The
  // contract: a -32001 error whose message names the denied destination, then close 4001 (net-server.ts
  // refuseWithGuidance: 100 ms after the taught answer; 15 s if the client never asks). Dialled raw, since
  // connectHost's request() resolves on any reply with the matching id, the refusal included, and would report a
  // refused dial as connected.
  const denial = await new Promise<{ err: string; code: number }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=bound-token&world=annex`);
    let err = "";
    const done = (code: number) => resolve({ err, code });
    ws.onopen = () => ws.send(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "denied", version: "0" } },
    }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.error?.message) err = String(m.error.message);
    };
    ws.onclose = (ev) => done(ev.code);
    setTimeout(() => { try { ws.close(); } catch { /* gone */ } done(-1); }, 8000);
  });
  check("denied ?world= refuses the connection (no silent fallback)",
    /annex/.test(denial.err) && /limited to|policy|unauthorized|not permitted/i.test(denial.err) && denial.code === 4001,
    `close=${denial.code} err=${denial.err.slice(0, 110)}`);

  // ── 4b. §3.2.7 founding is not joining ───────────────────────────────────
  const nofound = await connectHost("nofound-token");
  const wouldFound = await nofound.request("tools/call", { name: "travel", arguments: { world: "brand-new-place" } });
  check("create:false CANNOT found a world",
    wouldFound.result?.isError === true && /^travel refused, so you're still in "commons": no accessible world is named "brand-new-place", and this credential may not found one/.test(txt(wouldFound)), txt(wouldFound));
  // (act forwarding an unknown verb to the authority: door-wording-test "act passes a verb…", directory-check B5)
  // …and prove it wasn't created as a side effect anyway
  // 🔴 PAIRED WITH ITS POSITIVE CONTROL (below: annex's log grows at this path), so a server writing worlds elsewhere
  // can't pass these absence checks.
  check("refused founding left NOTHING on disk", !existsSync(join(worldsDir, "brand-new-place")));
  nofound.ws.close();
  const founder = await connectHost("roamer-token");
  // joining never founds a world on this server, whatever the credential: the door asks the world (/access) and
  // refuses before anything moves, saying so
  const founded = await founder.request("tools/call", { name: "travel", arguments: { world: "founded-place" } });
  check("create:true doesn't found by travelling either: the reply says no accessible world has that name",
    founded.result?.isError === true && /no accessible world is named "founded-place"/.test(txt(founded)), txt(founded));
  check("…and that refusal left nothing on disk", !existsSync(join(worldsDir, "founded-place")));
  // The positive control for the on-disk checks above: nothing founds here, so it shows the server writes worlds at
  // THIS path. It reads something the server wrote (bot #320): the harness founded annex before the server ran, so a
  // line said in annex must land in this path's log.
  const annexLog = join(worldsDir, "annex", "world.jsonl");
  const annexBefore = statSync(annexLog).size;
  // (ported) the first transition is a travel to an existing world, the second back
  await founder.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  const said = await founder.request("tools/call", { name: "act", arguments: { verb: "say", args: { text: "control line" } } });
  await tryUntil("the control line lands in annex's log", () => statSync(annexLog).size > annexBefore, { ms: 5000 });
  check("…and the CONTROL: a line said in a world lands in its log at that path (a server-side write)",
    !said.result?.isError && statSync(annexLog).size > annexBefore, `${annexLog} ${annexBefore}→${statSync(annexLog).size} ${txt(said).slice(0, 200)}`);
  // ── 4c. §3.2.3d epoch across transitions ─────────────────────────────────
  // The epoch is read from the channels/changed descriptor the server pushes to the host, where §3.2.3d says a
  // client learns it.
  const epochOf = (c: any) => c.inbound.filter((m: any) => m.method === "channels/changed")
    .map((m: any) => m.params?.added?.[0]?.metadata?.epoch).filter((e: any) => typeof e === "number");
  await tryUntil("the host hears an epoch", () => epochOf(founder).length > 0);
  const e1s = epochOf(founder);
  check("a transition announced an epoch to the host", e1s.length > 0, JSON.stringify(e1s));
  await founder.request("tools/call", { name: "travel", arguments: { world: "commons" } });
  await tryUntil("the host hears a second epoch", () => epochOf(founder).length > e1s.length);
  const e2s = epochOf(founder);
  check("epoch increments across transitions", e2s.length > e1s.length && e2s[e2s.length - 1] > e1s[e1s.length - 1],
    `epochs=${JSON.stringify(e2s)}`);
  // The above reads the PREPARE announcement, which carries `epoch + 1`, the epoch the transition would commit to
  // (net-server.ts, §3.2.3d). channels/list reports the live session's metadata.epoch: read the committed value back.
  const committed = await founder.request("channels/list", {});
  const cEpoch = committed.result?.channels?.[0]?.metadata?.epoch;
  check("…and the COMMITTED epoch matches what prepare promised",
    typeof cEpoch === "number" && cEpoch === e2s[e2s.length - 1],
    `promised=${e2s[e2s.length - 1]} committed=${cEpoch}`);
  const conflict = await founder.request("channels/open", { channelId: "world:annex", type: "world", address: { world: "commons" } });
  check("conflicting channelId+address is -32602", conflict.error?.code === -32602, JSON.stringify(conflict.error));
  founder.ws.close();

  // ── 4d. dialing your OWN world must be fine ───────────────────────────────
  // Naming your own home in ?world= admits, as omitting it does: it is not founding.
  const ownWorld = await connectHost("bound-token", "&world=commons");
  const ow = await ownWorld.request("channels/list", {});
  check("dialing your OWN minted world is not 'founding'", ow.result?.channels?.[0]?.id === "world:commons", JSON.stringify(ow.result));
  ownWorld.ws.close();

  // ── 4e. channels/changed carries the epoch ────────────────────────────────
  // It is the client's only epoch source.
  const eh = await connectHost("roamer-token");
  await eh.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  await tryUntil("the host hears channels/changed", () => eh.inbound.some((m) => m.method === "channels/changed"));
  const ch = eh.inbound.find((m) => m.method === "channels/changed");
  check("channels/changed descriptor carries metadata.epoch (§3.2.3d)",
    typeof ch?.params?.added?.[0]?.metadata?.epoch === "number", JSON.stringify(ch?.params?.added?.[0]?.metadata));
  eh.ws.close();

  // ── 4f. prepare/commit REFUSAL ────────────────────────────────────────────
  const decliner = await connectHost("roamer-token", "", "decline");
  const declined = await decliner.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("host decline aborts the join (refusal, nothing moved)",
    declined.result?.isError === true && /your host declined the move/.test(txt(declined))
      && /still in "commons"/.test(txt(declined)), txt(declined));
  const stillHome = await decliner.request("channels/list", {});
  check("declined join left the body where it was", stillHome.result?.channels?.[0]?.id === "world:commons", JSON.stringify(stillHome.result));
  // …and the host was not told otherwise. A prepare is a question: it carries no `removed`, or a declining (or merely
  // slow: the 5 s timeout) host would believe its current channel gone while still receiving deliveries on it.
  const prepareFrames = decliner.inbound.filter((m: any) =>
    m.method === "channels/changed" && Array.isArray(m.params?.removed) && m.params.removed.length);
  check("…and the host was never told its channel was removed",
    prepareFrames.length === 0,
    `saw ${prepareFrames.length} removal claim(s): ${JSON.stringify(prepareFrames.map((f: any) => f.params.removed))}`);
  decliner.ws.close();

  const mute = await connectHost("roamer-token", "", "mute");
  const timedOut = await mute.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("mute host is treated as declining (fail-closed)",
    timedOut.result?.isError === true && /didn't confirm the move to "annex" within 5 seconds, so trying again may work/.test(txt(timedOut)), txt(timedOut));
  mute.ws.close();

  // A host that answers the move with an error refuses it too, and only the
  // timeout above suggests trying again.
  const erring = await connectHost("roamer-token", "", "error");
  const errored = await erring.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("an error answer is a refusal in the host's words, without its JSON-RPC code or a retry hint",
    errored.result?.isError === true
      && txt(errored) === `travel refused, so you're still in "commons": your host didn't accept the move to "annex" (policy store unavailable)`,
    txt(errored));
  erring.ws.close();

  // ── 4g. the `travel` tool: the only lane ──────────────────────────────────
  // Reachable by a plain-MCP client that has never heard of MCPL channels (4i); channels/open never moves the body (4h).
  const tv = await connectHost("roamer-token");
  const listed = await tv.request("tools/list", {});
  check("travel is advertised as a tool", listed.result?.tools?.some((t: any) => t.name === "travel"), "no travel tool");

  const moved = await tv.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  const movedText = moved.result?.content?.[0]?.text ?? "";
  check("travel tool arrives", /Arrived in "annex"/.test(movedText), movedText);
  const whereNow = await tv.request("channels/list", {});
  check("travel tool actually moved the body", whereNow.result?.channels?.[0]?.id === "world:annex", JSON.stringify(whereNow.result));
  // it must ALSO tell the host (channels/changed); channels/open never moves the body (-32023, net-server.ts)
  check("travel tool emitted channels/changed to the host",
    tv.inbound.some((m) => m.method === "channels/changed"), "host never told");

  // the map: `worlds` lists where you are and what your policy allows —
  // the same joinAllowed travel applies, answered before a move is attempted
  check("worlds is advertised as a tool", listed.result?.tools?.some((t: any) => t.name === "worlds"), "no worlds tool");
  const map = await tv.request("tools/call", { name: "worlds", arguments: {} });
  const mapText = txt(map);
  check("worlds marks the current world", /^- annex ←[^:\n]*: .*you are here/m.test(mapText), mapText);
  check("worlds lists the world you came from as travelable (worlds:[\"*\"])", /^- commons[^:\n]*: .*may travel/m.test(mapText), mapText);
  check("worlds shows the body in its row", /^- annex ←[^:\n]*: .*roamer \(agent\)/m.test(mapText), mapText);
  check("worlds says joining never founds a world here", /joining never founds one here/.test(mapText), mapText);

  const noop = await tv.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("travel to where you already are is a no-op, not an error",
    !noop.result?.isError && /Already in/.test(noop.result?.content?.[0]?.text ?? ""), JSON.stringify(noop.result));
  tv.ws.close();

  // ── 4h. the tool honours join policy, and no second lane can disagree ─────
  // channels/open answers -32023 for any non-current channel whatever the credential, so its row below pins only that
  // the lane stays shut; the policy claim rests on the tool rows.
  const bound2 = await connectHost("bound-token");   // worlds: ["commons"] → may not roam
  const toolRefusal = await bound2.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("travel tool honours join policy", toolRefusal.result?.isError === true, JSON.stringify(toolRefusal.result));
  const boundMap = txt(await bound2.request("tools/call", { name: "worlds", arguments: {} }));
  check("worlds tells a narrowed credential it may not travel", /^- annex[^:\n]*: .*outside the worlds your credential is limited to/m.test(boundMap), boundMap);
  const openRefusal = await bound2.request("channels/open", { type: "world", address: { world: "annex" } });
  check("…and channels/open cannot travel at all (no second lane to disagree)",
    openRefusal.error?.code === -32023, JSON.stringify(openRefusal.error));
  const stayed = await bound2.request("channels/list", {});
  check("a refused travel moved nothing", stayed.result?.channels?.[0]?.id === "world:commons", JSON.stringify(stayed.result));

  const badName = await bound2.request("tools/call", { name: "travel", arguments: { world: "../etc/passwd" } });
  check("travel rejects a malformed world name, with the rule, and the body stays",
    badName.result?.isError === true && txt(badName) === `travel refused, so you're still in "commons": "../etc/passwd" isn't a valid world name; a name is 1 to 64 lowercase letters, digits, _ or -`, JSON.stringify(badName.result));
  bound2.ws.close();

  // ── 4i. PLAIN-MCP travel ──────────────────────────────────────────────────
  // granted() is false for any non-MCPL client by construction, so travelGate() asks channels.lifecycle of MCPL hosts
  // only: a plain-MCP host, which toolsAllowed() lists the tool to, travels on its credential.
  {
    const plain = await connectPlain("roamer-token");     // NO experimental.mcpl
    const tools = await plain.request("tools/list", {});
    check("plain-MCP host is offered the travel tool",
      (tools.result?.tools ?? []).some((t: any) => t.name === "travel"), "travel not listed");
    const moved = await plain.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("plain-MCP travel ACTUALLY WORKS (was always -32002)",
      !moved.result?.isError && /(Arrived in|Founded and entered) "annex"/.test(txt(moved)), txt(moved));
    const frames = plain.inbound.filter((m: any) => /^channels\//.test(m.method ?? ""));
    check("...and the plain-MCP host gets no MCPL frame for it (no channels/changed; bot #333 62)", !frames.length, JSON.stringify(frames));
    plain.ws.close();

    // …and the credential still gates it: plain MCP's authority is the credential it holds, not a capability it can't.
    const plainBound = await connectPlain("bound-token");  // worlds: ["commons"]
    const refused = await plainBound.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("plain-MCP travel still obeys the join policy",
      refused.result?.isError === true && /^travel refused, so you're still in "commons": world "annex" is outside the worlds this credential is limited to/.test(txt(refused)), txt(refused));
    const noCreate = await plainBound.request("tools/call", { name: "travel", arguments: { world: "never-made" } });
    check("plain-MCP founding outside the credential's narrowing is refused",
      noCreate.result?.isError === true && /^travel refused, so you're still in "commons": .*outside the worlds this credential is limited to/.test(txt(noCreate)), txt(noCreate));
    check("…and refused founding left nothing on disk", !existsSync(join(worldsDir, "never-made")));
    plainBound.ws.close();
  }

  // ── 4k. THE WORLD DECIDES (docs/decisions/WORLD-ACCESS.md) ───────────────────
  // A credential with no list goes where worlds let it; an owner closing a
  // world refuses it BEFORE anything moves; a grant from inside lets it in.
  {
    const free = await connectHost("free-token");          // no `worlds`, no `create`
    // (no founding by travel; an owner changes who may come in with ordinary requests on @world, access and
    // roles:<id>, through act; whois finds the identity a role names)
    const fm = txt(await free.request("tools/call", { name: "travel", arguments: { world: "free-place" } }));
    check("a credential with no list still can't found by travelling", /no accessible world is named "free-place"/.test(fm), fm);
    const there = txt(await free.request("tools/call", { name: "travel", arguments: { world: "keep" } }));
    check("…and travels to an open world it was never listed for", /Arrived in "keep"/.test(there), there);
    // says hello while there: a world's lookup (whois) knows the people it has seen act or be remembered, never everyone
    await free.request("tools/call", { name: "say", arguments: { text: "hello, keep" } });
    const home = txt(await free.request("tools/call", { name: "travel", arguments: { world: "commons" } }));
    check("…and back", /Arrived in "commons"/.test(home), home);

    const owner = await connectHost("roamer-token");       // keep was founded for the roamer agent, so it owns it
    const ot = txt(await owner.request("tools/call", { name: "travel", arguments: { world: "keep" } }));
    check("the owner goes to its world", /Arrived in "keep"|Already in/.test(ot), ot);
    const closed = await owner.request("tools/call", { name: "act", arguments: { verb: "set", args: { id: "@world", component: "access", value: { join: "listed" } } } });
    check("the owner agent closes it (set @world.access {join: listed})", !closed.result?.isError, txt(closed));
    const refused = await free.request("tools/call", { name: "travel", arguments: { world: "keep" } });
    check("travel into the closed world is refused, saying only that no world it may enter has that name",
      refused.result?.isError === true && /no accessible world is named "keep"/.test(txt(refused)), txt(refused));
    const still = await free.request("channels/list", {});
    check("…and nothing moved", still.result?.channels?.[0]?.id === "world:commons", JSON.stringify(still.result));
    const fmap = txt(await free.request("tools/call", { name: "worlds", arguments: {} }));
    check("the closed world is not on the outsider's map", !/^- keep/m.test(fmap), fmap);
    const whois = async () => txt(await owner.request("tools/call", { name: "whois", arguments: { name: "free" } }));
    const whoText = (await tryUntil("keep's whois knows free (it said hello there)", async () => { const t = await whois(); return /u-[a-z2-7]{20}/.test(t) && t; })) ?? await whois();
    const freeId = (whoText.match(/u-[a-z2-7]{20}/) ?? [])[0];
    const granted = await owner.request("tools/call", { name: "act", arguments: { verb: "set", args: { id: "@world", component: `roles:${freeId}`, value: { role: "member" } } } });
    check("the owner lets it in from inside the world (roles:<its identity>, found by whois)", !!freeId && !granted.result?.isError, `${whoText.slice(0, 200)} / ${txt(granted).slice(0, 300)}`);
    const inNow = txt(await free.request("tools/call", { name: "travel", arguments: { world: "keep" } }));
    check("…and now it travels in", /Arrived in "keep"/.test(inNow), inNow);
    // a member reads the closed world's geometry AS ITSELF (Greptile #258: measure
    // fetched /geom anonymously, and a closed world answers that as nonexistent)
    const made = txt(await owner.request("tools/call", { name: "create", arguments: { model: "eidoverse/assets/models/crate_large_red.glb", at: [2, 2], components: { label: "accbox" } } }));
    const measure = async () => txt(await free.request("tools/call", { name: "measure", arguments: { id: "accbox" } }));
    const measured = (t: string) => !/no such world/.test(t) && /accbox|geometry|bbox|crate/.test(t);
    const meas = (await tryUntil("free can measure accbox", async () => { const t = await measure(); return measured(t) && t; })) || await measure();
    check("measure works for a member of a closed world", measured(meas), `${made.slice(0, 120)} / ${meas.slice(0, 300)}`);
    const reopened = await owner.request("tools/call", { name: "act", arguments: { verb: "delete", args: { id: "@world", component: "access" } } });
    check("the owner opens it again", !reopened.result?.isError, txt(reopened));
    free.ws.close(); owner.ws.close();
  }

  // ── 4l. AN AGENT RESUMES WHERE IT WAS ─────────────────────────────────────
  // A reconnect with no world asked for lands where the agent last was, not
  // at its home — unless that world no longer lets it in, or its home claim
  // changed since. An explicit ?world= always wins.
  {
    const where = async (h: any) => (await h.request("channels/list", {})).result?.channels?.[0]?.id;
    const a1 = await connectHost("nofound-token");           // home commons, worlds ["*"]
    const t1 = txt(await a1.request("tools/call", { name: "travel", arguments: { world: "annex" } }));
    check("an agent travels to annex", /Arrived in "annex"/.test(t1), t1);
    await shut(a1);
    const a2 = await connectHost("nofound-token", RESUME);
    check("reconnecting with no world asked for resumes in annex", (await where(a2)) === "world:annex", String(await where(a2)));
    await shut(a2);
    const a3 = await connectHost("nofound-token", "&world=commons");
    check("an explicit ?world= still wins", (await where(a3)) === "world:commons", String(await where(a3)));
    await shut(a3);
    const a4 = await connectHost("nofound-token", RESUME);
    check("…and is remembered: the next plain reconnect starts there (commons)", (await where(a4)) === "world:commons", String(await where(a4)));
    // (ported: the world it leaves is `keep`, the one the roamer agent owns, and its owner closes it with this
    // protocol's ordinary request on @world, as THE WORLD DECIDES above does; upstream used annex and world_access)
    const t4 = txt(await a4.request("tools/call", { name: "travel", arguments: { world: "keep" } }));
    check("on to keep", /Arrived in "keep"/.test(t4), t4);
    await shut(a4);
    // the world it left no longer lets it in → home, not a refusal
    const owner = await connectHost("roamer-token", "&world=keep");
    const closedKeep = await owner.request("tools/call", { name: "act", arguments: { verb: "set", args: { id: "@world", component: "access", value: { join: "listed" } } } });
    check("the owner closes keep (set @world.access {join: listed})", !closedKeep.result?.isError, txt(closedKeep));
    const a5 = await connectHost("nofound-token", RESUME);
    check("an agent whose last world is now closed to it wakes up at home", (await where(a5)) === "world:commons", String(await where(a5)));
    a5.ws.close();
    const reopenedKeep = await owner.request("tools/call", { name: "act", arguments: { verb: "delete", args: { id: "@world", component: "access" } } });
    check("the owner reopens keep", !reopenedKeep.result?.isError, txt(reopenedKeep));
    await shut(owner);
    // an operator who changes the agent's HOME has said where it lives now
    const a6 = await connectHost("nofound-token");
    const t6 = txt(await a6.request("tools/call", { name: "travel", arguments: { world: "annex" } }));
    check("annex once more", /Arrived in "annex"/.test(t6), t6);
    await shut(a6);
    const reg = JSON.parse(readFileSync(tokensPath, "utf8"));
    // (ported: the new home is `keep`, a world that exists; joining never founds one here, and upstream's free-place
    // must stay unfounded for THE WORLD DECIDES above)
    reg["nofound-token"].world = "keep";
    writeFileSync(tokensPath, JSON.stringify(reg));
    const a7 = await connectHost("nofound-token", RESUME);
    check("after its home claim changes, it starts at the new home, not the old memory", (await where(a7)) === "world:keep", String(await where(a7)));
    a7.ws.close();
    reg["nofound-token"].world = "commons";
    writeFileSync(tokensPath, JSON.stringify(reg));   // read per connection attempt: the next dial sees it
    // the trip HOME stays allowed after a resume: roamer2 is limited to
    // ["annex"] with home commons, and its home must not be read from where it
    // resumed (Greptile #261)
    const b1 = await connectHost("roamer2-token");
    const tb1 = txt(await b1.request("tools/call", { name: "travel", arguments: { world: "annex" } }));
    check("roamer2 (limited to annex) travels to annex", /Arrived in "annex"/.test(tb1), tb1);
    await shut(b1);
    const b2 = await connectHost("roamer2-token", RESUME);
    check("roamer2 resumes in annex", (await where(b2)) === "world:annex", String(await where(b2)));
    const homeTrip = txt(await b2.request("tools/call", { name: "travel", arguments: { world: "commons" } }));
    check("…and may still travel home (its credential's home, not where it resumed)", /Arrived in "commons"/.test(homeTrip), homeTrip);
    const backTrip = txt(await b2.request("tools/call", { name: "travel", arguments: { world: "annex" } }));
    check("…and back to annex", /Arrived in "annex"/.test(backTrip), backTrip);
    await shut(b2);
    // a DOOR RESTART: the memory is on disk, so it outlives the process
    await restartDoor();
    const b3 = await connectHost("roamer2-token", RESUME);
    check("after the door itself restarts, roamer2 resumes in annex", (await where(b3)) === "world:annex", String(await where(b3)));
    await shut(b3);
  }

  // ── 4j. THE PLAIN-MCP LANE MUST NOT WIDEN MCPL AUTHORITY ──────────────────
  // Relaxing the capability gate for plain-MCP hosts is only safe if a host that DECLARES mcpl but is denied
  // channels.lifecycle is still refused.
  {
    const stingy = await connectHost("roamer-token");
    // Re-declare an effective capability set WITHOUT channels.lifecycle.
    await stingy.request("featureSets/update", {
      effectiveCapabilities: ["tools", "channels.register", "channels.publish", "channels.incoming"],
    });
    const denied2 = await stingy.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("MCPL host WITHOUT channels.lifecycle is still refused (#1 did not widen)",
      denied2.result?.isError === true && txt(denied2) === `travel refused, so you're still in "commons": your host hasn't granted this door channels.lifecycle, which travel needs, and calling again won't change that; if you need it, ask whoever runs your host`, txt(denied2));
    const where = await stingy.request("channels/list", {});
    check("…and that refusal moved nothing", where.result?.channels?.[0]?.id === "world:commons", JSON.stringify(where.result));
    stingy.ws.close();

    // The discriminating half: the row above passes even for a mutant with `this.mcplClient &&` as `true &&` (the
    // refusal reads the same). The SAME credential, declared as plain MCP, must succeed: capability-denied is a
    // property of the host class, not of the token.
    const samecred = await connectPlain("roamer-token");
    const plainOk = await samecred.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("…while the SAME credential as plain-MCP travels fine (the mcplClient conjunct is load-bearing)",
      !plainOk.result?.isError && /(Arrived in|Founded and entered) "annex"/.test(txt(plainOk)), txt(plainOk));
    samecred.ws.close();

    // What makes the conjunct sound: MCPL-ness is fixed at initialize. mcplClient comes from a client-supplied field,
    // but it is assigned at one site, in the one-shot handshake (net-server.ts handshake(), which awaits initialize
    // before the read loop starts), so a second initialize never reaches it and a denied host can't shed the denial
    // by ceasing to declare MCPL. This row fails if that assignment moves where a later initialize reaches it.
    const escapee = await connectHost("roamer-token");
    await escapee.request("featureSets/update", {
      effectiveCapabilities: ["tools", "channels.register", "channels.publish", "channels.incoming"],
    });
    // Try to become "plain MCP" mid-session. The door must not honour this.
    await escapee.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},                       // <- no experimental.mcpl
      clientInfo: { name: "escapee", version: "0" },
    }).catch(() => { /* refusing a re-initialize outright is equally fine */ });
    const escape = await escapee.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("a denied host stays denied — MCPL-ness is fixed at initialize, not re-declarable",
      escape.result?.isError === true && /your host hasn't granted this door channels\.lifecycle/.test(txt(escape)), txt(escape));
    const stillOpen = await escapee.request("channels/list", {});
    check("…and the refused host is still in its own world, undisturbed",
      stillOpen.result?.channels?.[0]?.id === "world:commons", JSON.stringify(stillOpen.result));
    escapee.ws.close();
  }

  // ── 4m. the door must be OPEN in the new world ────────────────────────────
  // The new world's descriptor announces initiallyOpen: true, so whether the door is open is per-world state, like
  // the chat cursor: an agent who closed its door and then travelled arrives with it open, as the host was told.
  {
    const shutter = await connectHost("roamer-token");
    await shutter.request("channels/close", { channelId: "world:commons" });
    const moved2 = await shutter.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("travel after closing the door still arrives", !moved2.result?.isError, txt(moved2));
    // The door being open again is observable: a plain re-open of the CURRENT
    // channel succeeds and reports the channel the host was promised.
    const reopened = await shutter.request("channels/open", { type: "world", address: { world: "annex" } });
    check("…and the new world's door is OPEN, as its descriptor promised the host",
      reopened.result?.channel?.id === "world:annex" && reopened.result?.channel?.initiallyOpen === true,
      JSON.stringify(reopened.result?.channel));
    // The world it left is no longer this connection's channel, and the
    // refusals say which one is.
    const stalePublish = await shutter.request("channels/publish", { channelId: "world:commons", content: [{ type: "text", text: "hello" }] });
    check("a publish to the world it left names the current channel, and that nothing was posted",
      stalePublish.error?.code === -32023 && /this connection's channel is "world:annex", and the publish named "world:commons", so nothing was posted/.test(stalePublish.error?.message ?? ""),
      JSON.stringify(stalePublish.error));
    const staleClose = await shutter.request("channels/close", { channelId: "world:commons" });
    check("…and so does a close of it",
      staleClose.error?.code === -32023 && /this connection's channel is "world:annex", and the request named "world:commons", so nothing was closed/.test(staleClose.error?.message ?? ""),
      JSON.stringify(staleClose.error));
    const namelessClose = await shutter.request("channels/close", {});
    check("…and a close naming no channel says so, not \"undefined\"",
      namelessClose.error?.code === -32023 && /and the request named nothing, so nothing was closed/.test(namelessClose.error?.message ?? ""),
      JSON.stringify(namelessClose.error));
    const crossed = await shutter.request("channels/open", { channelId: "world:annex", type: "world", address: { world: "commons" } });
    check("an open naming two different worlds says so, and opens nothing",
      crossed.error?.code === -32602 && /name different worlds, so nothing was opened/.test(crossed.error?.message ?? ""),
      JSON.stringify(crossed.error));
    shutter.ws.close();
  }

  // ── 5. world server down → travel refused before detaching; connection kept ─
  // (last: it kills the sequencer)
  const victim = await connectHost("roamer-token");
  world.kill();                        // the sequencer goes away mid-session
  await until("the world server exits", () => world.exitCode !== null || world.signalCode !== null, { ms: 5000 });
  const failed = await victim.request("tools/call", { name: "travel", arguments: { world: "annex" } });  // exists, so this tests ATTACH failure
  // The tool lane reports failure as isError + text (the MCP contract), not a JSON-RPC error code. The travel gate
  // asks the world (/access) before detaching, so a dead sequencer is caught there: nothing moves, and the agent is
  // told to try again. (A join that fails AFTER the gate is a race this harness can't stage, so it isn't covered.)
  check("an unreachable world server refuses travel before anything moves",
    failed.result?.isError === true
    && /didn't say whether you may go to "annex", so nothing moved/.test(txt(failed)), txt(failed));
  // nothing detached, so the host's connection to the door is still there
  await pause("a teardown would follow the refusal at once; the connection must still be open after it", 500);
  check("…and the host's connection to the door was not torn down", victim.ws.readyState === WebSocket.OPEN, `readyState=${victim.ws.readyState}`);
  // a reconnect while the world server is DOWN must not move the memory: the
  // resume check cannot run and nothing joins, so where the agent was is kept
  // for when the server is back (Greptile #261)
  {
    const before = JSON.parse(readFileSync(statePath, "utf8")).__world?.roamer2?.world;
    // dial raw: the session can't embody (agent.connect fails), so the door ends it; a memory write would precede that
    const c5 = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=roamer2-token`);
    c5.onopen = () => {
      c5.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "down", version: "0" } } }));
      c5.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    };
    const ended = await tryUntil("the door ends the session it can't embody", () => c5.readyState === WebSocket.CLOSED, { ms: 20_000 });
    const after = JSON.parse(readFileSync(statePath, "utf8")).__world?.roamer2?.world;
    check("a reconnect while the world server is down keeps where the agent was", !!ended && before === "annex" && after === "annex", `${before} → ${after}, session ended=${!!ended}`);
    try { c5.close(); } catch { /* gone */ }
  }
} finally {
  // Verified termination: kill(), then AWAIT the exit (kill() alone returns while a child still holds its port or is
  // mid-write). Escalate to SIGKILL rather than hang the suite.
  for (const [name, child] of [["world", world], ["door", mcpl]] as const) {
    try { child.kill(); } catch { /* already gone */ }
    const gone = () => child.exitCode !== null || child.signalCode !== null;
    if (!(await tryUntil(`${name} child exits on SIGTERM`, gone, { ms: 5000 }))) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      await tryUntil(`${name} child exits on SIGKILL`, gone, { ms: 2000 });
    }
    check(`${name} child terminated`, child.exitCode !== null || child.signalCode !== null,
      "still running after SIGTERM+SIGKILL");
  }

  // Source-tree cleanliness, the point of MCPL_STATE: a run must not touch the repository's state.
  const after = existsSync(REPO_STATE)
    ? { exists: true, mtimeMs: statSync(REPO_STATE).mtimeMs, size: statSync(REPO_STATE).size }
    : { exists: false, mtimeMs: 0, size: 0 };
  check("repository mcpl/state.json untouched",
    after.exists === repoStateBefore.exists && after.mtimeMs === repoStateBefore.mtimeMs && after.size === repoStateBefore.size,
    `before=${JSON.stringify(repoStateBefore)} after=${JSON.stringify(after)}`);
  check("no repository mcpl/state.json.tmp left behind", !existsSync(`${REPO_STATE}.tmp`));
  // …and our own temp state exists, proving the override was HONOURED rather
  // than silently ignored — otherwise "untouched" would also pass if the door
  // simply never persisted at all.
  check("the door persisted to OUR state path", existsSync(statePath), statePath);
  check("no temp file left in our state dir", !existsSync(`${statePath}.tmp`));
  // No -1 watermark reaches disk. WorldAgent.lastSeq is -1 until the first snapshot lands, and joinWorld assigns
  // this.agent before awaiting connect(): a 60 s tick or the disconnect path landing in that window must not persist
  // it, since a stored -1 replays a world's whole history as mentions on the next connect. The suite has travelled
  // many times by now, so any such write would be on disk here.
  {
    // The watermarks are persisted under `__seq` (persistState, mcpl/net-server.ts). The non-emptiness row guards the
    // read: the suite has travelled, so an empty map means the check is reading the wrong key.
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as
      { __seq?: Record<string, number> };
    const seqs = persisted.__seq ?? {};
    check("watermarks were actually persisted (the check is reading the live key)",
      Object.keys(seqs).length > 0,
      `state file keys: ${JSON.stringify(Object.keys(persisted))}`);
    const negatives = Object.entries(seqs).filter(([, v]) => typeof v === "number" && v < 0);
    check("no unsynced (-1) watermark was persisted for any world",
      negatives.length === 0,
      `negatives: ${JSON.stringify(negatives)} | all: ${JSON.stringify(seqs)}`);
  }

  try { rmSync(worldsDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
S.done();
