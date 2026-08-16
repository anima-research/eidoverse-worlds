// In-session world travel — integration test for the `travel` tool lane.
// Starts its own world + MCPL door on VERIFIED-FREE ports with a temp tokens
// file and a temp state file, then covers: join policy (denied / granted /
// listed-but-outside), founding vs joining, dial-time ?world=, epoch across
// transitions, host prepare/commit refusal, per-world door state, the
// plain-MCP lane, and attach failure.
//
// 🔴 THE HARNESS OWNS ITS PORTS, ITS STATE, AND ITS CHILDREN (2026-08-16).
// It previously hardcoded 8957/8958, waited by sleep, and never proved the
// responder was the process it spawned — and this project has already had a
// test answer green from a STALE listener on a fixed 89xx port. It also let
// the door write the REPOSITORY's mcpl/state.json. Both are false-receipt
// generators: the first reports on someone else's server, the second leaves
// artifacts that look like real failures. Everything below exists to make the
// suite's green mean "the code under test did this."
import { mkdtempSync, writeFileSync, existsSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

/** A port nothing is listening on RIGHT NOW: bind :0, read what the kernel
 *  gave us, release it. Racy in principle (someone could take it in the gap)
 *  — which is why readiness below verifies ownership rather than trusting
 *  that whatever answers is ours. */
async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}
const WPORT = await freePort(), MPORT = await freePort();
const worldsDir = mkdtempSync(join(tmpdir(), "eido-join-"));
const tokensPath = join(worldsDir, "tokens.json");
// Bound to worldsDir, per the review: the door's durable state lives with the
// rest of this run's scratch and dies with it.
const statePath = join(worldsDir, "state.json");
// Repository state must be untouched by a run. Snapshot before, compare after.
const REPO_STATE = new URL("../mcpl/state.json", import.meta.url).pathname;
const repoStateBefore = existsSync(REPO_STATE)
  ? { exists: true, mtimeMs: statSync(REPO_STATE).mtimeMs, size: statSync(REPO_STATE).size }
  : { exists: false, mtimeMs: 0, size: 0 };
writeFileSync(tokensPath, JSON.stringify({
  "bound-token":   { id: "bound",   name: "Bound",   world: "commons" },
  "roamer-token":  { id: "roamer",  name: "Roamer",  world: "commons", worlds: ["*"], create: true },
  "nofound-token": { id: "nofound", name: "NoFound", world: "commons", worlds: ["*"] },
  "roamer2-token": { id: "roamer2", name: "Roamer2", world: "commons", worlds: ["annex"] },
}));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};

// A nonce this run owns, echoed by the door's /healthz.
const NONCE = `t${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

// 🔴 EVERY CHILD IS REGISTERED BEFORE IT CAN BE LOST (adversarial review,
// 2026-08-17). Round 3 moved the readiness PROBES inside the try but left the
// ACQUISITIONS outside it, and the file then claimed "nothing that can throw
// sits outside it" — which was false about the two lines that matter most. If
// the second Bun.spawn throws (bad execPath resolution, EAGAIN), the first
// child runs forever holding a port, with no teardown and no owner.
//
// A live registry the finally block drains covers both children AND any future
// third one, rather than naming them individually and drifting again.
const spawned: { pid: number; kill: (sig?: string) => void; exitCode: number | null }[] = [];
function spawnChild(args: string[], env: Record<string, string>) {
  const child = Bun.spawn(args, { env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" });
  spawned.push(child as unknown as typeof spawned[number]);
  return child;
}
const world = spawnChild([process.execPath, "server/server.ts"], {
  PORT: String(WPORT), WORLDS_DIR: worldsDir, WORLD_INSTANCE_NONCE: NONCE,
});
const mcpl = spawnChild([process.execPath, "mcpl/net-server.ts"], {
  MCPL_PORT: String(MPORT), WORLD_URL: `ws://127.0.0.1:${WPORT}/ws`,
  MCPL_TOKENS: tokensPath, MCPL_STATE: statePath, MCPL_INSTANCE_NONCE: NONCE,
});
// Last-resort net: if anything between here and the try throws, or the process
// dies by signal, the children still go. process.exit does NOT run finally
// blocks, so this cannot be left to the one at the bottom.
const reap = () => { for (const c of spawned) { try { c.kill(); } catch { /* gone */ } } };
process.on("exit", reap);
process.on("uncaughtException", (e) => { reap(); console.error(e); process.exit(1); });

/** PIDs listening on a TCP port, from the OS. Returns null when this platform
 *  cannot answer — which is NOT the same as "nothing is listening", and
 *  conflating the two is how a portable-looking check silently stops checking.
 *
 *  🔴 LINUX-ONLY, AND THAT IS WHY IT IS THE SECOND OPINION (antra, 2026-08-16:
 *  the macOS review host has no `ss` and no /proc, so the exact-head run died
 *  before the first vector with `Executable not found in $PATH: "ss"`). The
 *  PORTABLE proof is the per-run nonce each child echoes; this is a stricter
 *  opinion offered where the platform can give one. */
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

/** Poll until `probe()` returns true, or throw. Replaces the fixed startup
 *  sleep: a sleep encodes a GUESS about startup time and fails in both
 *  directions — slow when it over-waits, flaky when it under-waits. Also fails
 *  FAST if either child dies, which is how a squatted port surfaces. */
async function waitFor(what: string, probe: () => Promise<boolean>, ms = 20_000) {
  const deadline = Date.now() + ms;
  let lastErr = "";
  while (Date.now() < deadline) {
    if (world.exitCode !== null) throw new Error(`${what}: world child exited early (code ${world.exitCode})`);
    if (mcpl.exitCode !== null) throw new Error(`${what}: door child exited early (code ${mcpl.exitCode})`);
    try { if (await probe()) return; } catch (e) { lastErr = (e as Error).message; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what}: not ready within ${ms}ms${lastErr ? ` (last: ${lastErr})` : ""}`);
}

/** The port must be held by the child we spawned (or a descendant). This is
 *  the OS's answer, not the app's — an app endpoint can only tell you what the
 *  app believes, and a stale listener believes it is fine. */
function ownsPort(name: string, port: number, child: { pid: number }) {
  return async () => {
    const pids = await listenerPids(port);
    // null = this platform cannot answer. Return true so the wait resolves: the
    // nonce challenge above has ALREADY proved identity, and refusing to
    // proceed here would make a portable receipt unrunnable on the very host
    // that reviews it. A skip is recorded loudly (see osOwnership below) — a
    // check that quietly stops checking is the failure mode this file exists
    // to prevent.
    if (pids === null) return true;
    if (pids.length === 0) return false;
    const ours = new Set([child.pid, ...descendantsOf(child.pid)]);
    // 🔴 THE GUARD I ADDED LAST ROUND DISABLED THIS CHECK IN ITS MOST COMMON
    // CONFIGURATION (adversarial review, 2026-08-17). It read
    // `if (foreign.length && ours.size > 1)`, and ours.size > 1 is true ONLY
    // when descendantsOf() found a forked child. When bun runs the .ts
    // in-process — the ordinary Linux case — the set is just {child.pid}, so a
    // genuinely foreign pid holding the port sailed through returning true.
    // The one check written to catch a squatted port was off exactly where it
    // was needed, and my reasoning for the guard ("no procfs but ss present")
    // described a configuration that barely occurs while breaking the one that
    // always does.
    //
    // A foreign listener is foreign regardless of how many pids we own. The
    // only honest exemption is not being able to enumerate at all, and that is
    // the `pids === null` early return above.
    const foreign = pids.filter((p) => !ours.has(p));
    if (foreign.length) {
      throw new Error(`${name} port ${port} held by pid(s) ${foreign.join(",")}, not our child ${child.pid} — stale listener`);
    }
    return true;
  };
}

/** Did the OS-level check actually run on this platform? Reported, never
 *  assumed — antra's macOS run must be able to see WHICH proofs it got. */
async function osOwnershipAvailable(): Promise<boolean> {
  return (await listenerPids(WPORT)) !== null && existsSync("/proc");
}

// 🔴 IDENTITY, NOT MERE LIVENESS. "The port answers" is exactly the check that
// lets a stale listener report green.
//
// 🔴 AND EVERY PROBE BELOW RUNS INSIDE THE try (antra, 2026-08-16): readiness
// and ownership used to run BEFORE the try/finally opened, so any startup or
// identity failure bypassed the very teardown this file guarantees. Their
// failed macOS run left both children to the shell. The `try` now opens here,
// before the first spawn-dependent assertion, so nothing that can throw sits
// outside it.
let osOwnership = false;
try {
await waitFor("world /version echoes our nonce", async () => {
  const r = await fetch(`http://127.0.0.1:${WPORT}/version`);
  if (!r.ok) return false;
  const body = await r.json().catch(() => null) as { instance?: string } | null;
  // A world answering WITHOUT our instance field is a stale listener, not a
  // slow start — say so rather than spinning until the deadline.
  if (body && !("instance" in body)) {
    throw new Error("a world answered but WITHOUT our nonce — stale listener on this port");
  }
  return body?.instance === NONCE;
});
await waitFor("world port is owned by OUR child", ownsPort("world", WPORT, world));
// Two independent proofs for the door: it echoes a nonce only we set, AND the
// OS says the port is our child's. The nonce is the PORTABLE one; the OS check
// is a stricter second opinion, and is skipped (loudly, below) where the
// platform cannot answer.
await waitFor("door /healthz echoes our nonce", async () => {
  const r = await fetch(`http://127.0.0.1:${MPORT}/healthz`);
  if (!r.ok) return false;
  const body = (await r.text()).trim();
  if (body === "ok") throw new Error("a door answered but WITHOUT our nonce — stale listener on this port");
  return body === `ok ${NONCE}`;
});
await waitFor("door port is owned by OUR child", ownsPort("door", MPORT, mcpl));

// Say which proofs this run actually obtained. A receipt that cannot be read
// as "nonce only" vs "nonce + OS" invites the reader to assume the stronger
// one — and on macOS they would be assuming a check that did not run.
osOwnership = await osOwnershipAvailable();
console.log(osOwnership
  ? "  identity: per-run nonce + OS port ownership (linux)"
  : "  identity: per-run nonce only (no ss//proc on this platform — OS check skipped)");

/** Minimal MCPL 0.5 host: initialize, grant, then request/notification I/O. */
async function connectHost(token: string, query = "", mode: "accept" | "decline" | "mute" = "accept") {
  const ws = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=${token}${query}`);
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

/** A PLAIN-MCP client: identical transport, but `initialize` omits
 *  capabilities.experimental.mcpl, so the server sets mcplClient=false and
 *  granted() returns false for every capability by construction. This is the
 *  vector antra's finding #1 asked for — without it, the "plain-MCP travel
 *  lane" was advertised and never once exercised, which is exactly how it
 *  shipped always-denied. */
async function connectPlain(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=${token}`);
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
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: w, id, avatar: "a.vrm" }));
  });
  return { ws, events };
}

const txt = (r:any) => r.result?.content?.[0]?.text ?? "";

  // (no startup sleep: readiness above already proved both children are up AND
  // are the processes we spawned. The `try` that guards teardown opens further
  // up, BEFORE those probes — see the note there.)

  // ── 1. no policy → deny, and the session survives the refusal ─────────────
  // Driven through the TOOL now: the channels/open sibling-join lane was
  // removed (antra #4), so the tool is the only lane and must carry the proof.
  const bound = await connectHost("bound-token");
  await sleep(1200);
  const denied = await bound.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("unpoliced travel refused", denied.result?.isError === true && /not in this credential/.test(denied.result?.content?.[0]?.text ?? ""), JSON.stringify(denied.result));
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
  await sleep(1200);
  const joined = await roamer.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("policied travel arrives", !joined.result?.isError && /(Arrived in|Founded and entered) "annex"/.test(txt(joined)), txt(joined));
  await sleep(800);
  const changed = roamer.inbound.find((m) => m.method === "channels/changed");
  check("channels/changed retires old world, adds new",
    changed?.params?.removed?.includes("world:commons") && changed?.params?.added?.[0]?.id === "world:annex",
    JSON.stringify(changed?.params));
  const after = await roamer.request("channels/list", {});
  check("channels/list agrees the session moved", after.result?.channels?.[0]?.id === "world:annex", JSON.stringify(after.result));
  // …and the same-channel open keeps its old meaning post-travel. This is the
  // half of channels/open that SURVIVED: opening the channel you are already
  // in, with optional history, is the ordinary MCPL operation and is untouched.
  const reopen = await roamer.request("channels/open", { type: "world", address: { world: "annex" }, history: { limit: 5 } });
  check("current-channel open still plain-opens (with history)", reopen.result?.channel?.id === "world:annex", JSON.stringify(reopen));
  // atomicity, world-side: the commons watcher saw the body actually LEAVE
  await sleep(600);
  const left = commonsWatch.events.some((m) => (m.type === "leave" || m.type === "part" || m.type === "left") && (m.id === "roamer" || m.who === "roamer"));
  const ghost = commonsWatch.events.filter((m) => m.type === "say" && m.id === "roamer").length;
  check("old world saw the body leave (no dual presence)", left, "leave-ish events: " + JSON.stringify(commonsWatch.events.map((m) => m.type).slice(-12)) + ` ghost says: ${ghost}`);
  commonsWatch.ws.close();
  // in-session denial for a LISTED credential asking outside its list
  const roamer2 = await connectHost("roamer2-token");
  await sleep(1200);
  const outside = await roamer2.request("tools/call", { name: "travel", arguments: { world: "elsewhere" } });
  check("worlds:[annex] credential denied for other worlds",
    outside.result?.isError === true && /not in this credential's join policy/.test(txt(outside)), txt(outside));
  roamer2.ws.close();

  // ── 4. dial-time ?world= under the same policy ────────────────────────────
  const dialed = await connectHost("roamer2-token", "&world=annex");
  await sleep(1200);
  const dl = await dialed.request("channels/list", {});
  check("?world= honored for a policied credential", dl.result?.channels?.[0]?.id === "world:annex", JSON.stringify(dl.result));
  dialed.ws.close();
  // §3.3 (Mica #3): a denied dial-time destination REFUSES the connection —
  // no silent fallback to the minted world.
  // 🔴 ASSERT THE REFUSAL, NOT "SOMETHING WENT WRONG" (adversarial review,
  // 2026-08-17). The previous version slept 1500ms and read `ws.readyState` —
  // but refuseWithGuidance (net-server.ts:1415) closes on a FIFTEEN second
  // timer, so that branch could never be true. The check passed only through a
  // bare `catch { refused = true }`, which accepts ANY failure as proof of the
  // specific behaviour under test: a door that OOM'd, timed out for an
  // unrelated reason, or refused while naming the WRONG world all scored the
  // identical green.
  //
  // The observable contract is narrow and worth pinning exactly: an
  // -32001 error whose message names the refusal, then close 4001 (:1424-1428).
  // So capture the error TEXT and require it to mention the world we were
  // refused for.
  // Dial RAW, not through connectHost(): its `request()` resolves on ANY reply
  // carrying the matching id — including the -32001 refusal — so it reports a
  // refused dial as a successful connect. (My first rewrite asserted on that
  // and read `admitted=true` against a door whose refusal path is correct: the
  // harness was wrong in the direction that looks like a product bug, which is
  // the same trap as the on-disk control below.)
  //
  // What §3.3 actually promises is observable and narrow: the -32001 body NAMES
  // the denied destination, and the socket then closes 4001 (net-server.ts
  // :1424-1428). Assert both, and give the close a real deadline rather than
  // the 1500ms sleep that could never have seen a 15s timer.
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
    /annex/.test(denial.err) && /policy|unauthorized|not permitted/i.test(denial.err) && denial.code === 4001,
    `close=${denial.code} err=${denial.err.slice(0, 110)}`);

  // ── 4b. §3.2.7 founding is not joining ───────────────────────────────────
  const nofound = await connectHost("nofound-token");
  await sleep(1200);
  const wouldFound = await nofound.request("tools/call", { name: "travel", arguments: { world: "brand-new-place" } });
  check("worlds:['*'] without create CANNOT found a world",
    wouldFound.result?.isError === true && /founding requires create authority/.test(txt(wouldFound)), txt(wouldFound));
  // …and prove it wasn't created as a side effect anyway (review F)
  // 🔴 PAIRED WITH ITS POSITIVE CONTROL (adversarial review, 2026-08-17).
  // `!existsSync(...)` alone passes for a build where founding writes NOTHING
  // anywhere — or where worlds land at a different path entirely — which makes
  // it indistinguishable from `!existsSync("/tmp/definitely-not-a-path")`. The
  // second assertion is what gives the first its meaning: a world that WAS
  // founded appears at exactly this path, so a world that was refused being
  // absent from it is now evidence rather than a tautology.
  check("refused founding left NOTHING on disk", !existsSync(join(worldsDir, "brand-new-place")));
  nofound.ws.close();
  const founder = await connectHost("roamer-token");
  await sleep(1200);
  const founded = await founder.request("tools/call", { name: "travel", arguments: { world: "founded-place" } });
  check("create:true CAN found, and says so",
    !founded.result?.isError && /Founded and entered "founded-place"/.test(txt(founded)), txt(founded));
  // 🔴 THE POSITIVE CONTROL FOR THE on-disk CHECK ABOVE (adversarial review,
  // 2026-08-17). `!existsSync(brand-new-place)` alone also passes for a build
  // where founding writes nothing anywhere, or writes somewhere else entirely
  // — indistinguishable from !existsSync("/tmp/not-a-real-path"). Pairing it
  // with a world that WAS founded, at the SAME parent path, is what turns the
  // negative into evidence.
  //
  // It has to run HERE, after the founding it controls for — my first attempt
  // put it beside the negative check twenty lines earlier and asserted the
  // directory existed before anything had created it. The control was itself
  // wrong in the direction that would have looked like a product bug.
  await sleep(400);              // the sequencer writes the log dir on join
  check("…and the CONTROL: a world that WAS founded IS on disk at that path",
    existsSync(join(worldsDir, "founded-place")), `worldsDir=${worldsDir}`);
  // ── 4c. §3.2.3d epoch across transitions ─────────────────────────────────
  // The epoch is read from the channels/changed descriptor the server pushes
  // to the HOST — which is where §3.2.3d says a client learns it, and the only
  // place it appears now that the sibling-open lane is gone.
  await sleep(600);
  const epochOf = (c: any) => c.inbound.filter((m: any) => m.method === "channels/changed")
    .map((m: any) => m.params?.added?.[0]?.metadata?.epoch).filter((e: any) => typeof e === "number");
  const e1s = epochOf(founder);
  check("founding announced an epoch to the host", e1s.length > 0, JSON.stringify(e1s));
  await founder.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  await sleep(600);
  const e2s = epochOf(founder);
  check("epoch increments across transitions", e2s.length > e1s.length && e2s[e2s.length - 1] > e1s[e1s.length - 1],
    `epochs=${JSON.stringify(e2s)}`);
  // 🔴 The above reads the PREPARE announcement, which carries `epoch + 1` —
  // the epoch the transition WOULD commit to (net-server.ts, §3.2.3d). A bug
  // that announced +1 and then never incremented at commit would pass it.
  // channels/list reports `metadata.epoch` from the live session, so read the
  // COMMITTED value back and prove the promise was kept.
  const committed = await founder.request("channels/list", {});
  const cEpoch = committed.result?.channels?.[0]?.metadata?.epoch;
  check("…and the COMMITTED epoch matches what prepare promised",
    typeof cEpoch === "number" && cEpoch === e2s[e2s.length - 1],
    `promised=${e2s[e2s.length - 1]} committed=${cEpoch}`);
  const conflict = await founder.request("channels/open", { channelId: "world:annex", type: "world", address: { world: "commons" } });
  check("conflicting channelId+address is -32602", conflict.error?.code === -32602, JSON.stringify(conflict.error));
  founder.ws.close();

  // ── 4d. REGRESSION (round-3 defect 1): dialing your OWN world must be fine ─
  // v3 gated `auth.world` whenever ?world= was present at all, so naming your
  // own home refused where omitting it admitted — bricking fresh deployments.
  const ownWorld = await connectHost("bound-token", "&world=commons");
  await sleep(1200);
  const ow = await ownWorld.request("channels/list", {});
  check("dialing your OWN minted world is not 'founding'", ow.result?.channels?.[0]?.id === "world:commons", JSON.stringify(ow.result));
  ownWorld.ws.close();

  // ── 4e. REGRESSION (round-3 defect 2): channels/changed carries the epoch ──
  // It is the client's ONLY epoch source; v3 dropped the field and froze every
  // client at 0 while the server advanced.
  const eh = await connectHost("roamer-token");
  await sleep(1200);
  await eh.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  await sleep(600);
  const ch = eh.inbound.find((m) => m.method === "channels/changed");
  check("channels/changed descriptor carries metadata.epoch (§3.2.3d)",
    typeof ch?.params?.added?.[0]?.metadata?.epoch === "number", JSON.stringify(ch?.params?.added?.[0]?.metadata));
  eh.ws.close();

  // ── 4f. prepare/commit REFUSAL — the path the suite never exercised ───────
  const decliner = await connectHost("roamer-token", "", "decline");
  await sleep(1200);
  const declined = await decliner.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("host decline aborts the join (refusal, nothing moved)",
    declined.result?.isError === true && /channel not permitted/.test(txt(declined)), txt(declined));
  const stillHome = await decliner.request("channels/list", {});
  check("declined join left the body where it was", stillHome.result?.channels?.[0]?.id === "world:commons", JSON.stringify(stillHome.result));
  decliner.ws.close();

  const mute = await connectHost("roamer-token", "", "mute");
  await sleep(1200);
  const timedOut = await mute.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("mute host is treated as declining (fail-closed)",
    timedOut.result?.isError === true && /channel not permitted/.test(txt(timedOut)), txt(timedOut));
  mute.ws.close();

  // ── 4g. LANE 1: the `travel` tool ─────────────────────────────────────────
  // Same mechanism as channels/open, reachable by a plain-MCP client that has
  // never heard of MCPL channels. Both lanes MUST share one policy.
  const tv = await connectHost("roamer-token");
  await sleep(1200);
  const listed = await tv.request("tools/list", {});
  check("travel is advertised as a tool", listed.result?.tools?.some((t: any) => t.name === "travel"), "no travel tool");

  const moved = await tv.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  const movedText = moved.result?.content?.[0]?.text ?? "";
  check("travel tool arrives", /Arrived in "annex"/.test(movedText), movedText);
  const whereNow = await tv.request("channels/list", {});
  check("travel tool actually moved the body", whereNow.result?.channels?.[0]?.id === "world:annex", JSON.stringify(whereNow.result));
  // it must ALSO tell the host, exactly like the channels/open lane
  check("travel tool emitted channels/changed to the host",
    tv.inbound.some((m) => m.method === "channels/changed"), "host never told");

  const noop = await tv.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("travel to where you already are is a no-op, not an error",
    !noop.result?.isError && /Already in/.test(noop.result?.content?.[0]?.text ?? ""), JSON.stringify(noop.result));
  tv.ws.close();

  // ── 4h. the tool honours join policy, and no second lane can disagree ─────
  // NOTE (review): this is no longer a policy-PARITY check. channels/open now
  // returns -32023 for any non-current channel whatever the credential, so that
  // half is a tautology — kept only to pin that the lane stays shut, not as
  // evidence about policy. The policy claim rests on the tool assertion above.
  const bound2 = await connectHost("bound-token");   // no `worlds` → may not roam
  await sleep(1200);
  const toolRefusal = await bound2.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("travel tool honours join policy", toolRefusal.result?.isError === true, JSON.stringify(toolRefusal.result));
  // channels/open cannot travel AT ALL any more, so the "one policy" property
  // is now stronger than matching codes: there is no second lane to disagree
  // with the first. Prove the door is shut rather than merely equally guarded.
  const openRefusal = await bound2.request("channels/open", { type: "world", address: { world: "annex" } });
  check("…and channels/open cannot travel at all (no second lane to disagree)",
    openRefusal.error?.code === -32023, JSON.stringify(openRefusal.error));
  const stayed = await bound2.request("channels/list", {});
  check("a refused travel moved nothing", stayed.result?.channels?.[0]?.id === "world:commons", JSON.stringify(stayed.result));

  const badName = await bound2.request("tools/call", { name: "travel", arguments: { world: "../etc/passwd" } });
  check("travel rejects a malformed world name", badName.result?.isError === true, JSON.stringify(badName.result));
  bound2.ws.close();

  // ── 4i. PLAIN-MCP travel: the lane the PR advertises and never tested ────
  // antra #1: travelGate() unconditionally required channels.lifecycle, and
  // granted() returns false for any non-MCPL client BY CONSTRUCTION — so every
  // plain-MCP travel died with -32002 while toolsAllowed() listed the tool.
  // These vectors are what makes the advertised lane real.
  {
    const plain = await connectPlain("roamer-token");     // NO experimental.mcpl
    await sleep(1200);
    const tools = await plain.request("tools/list", {});
    check("plain-MCP host is offered the travel tool",
      (tools.result?.tools ?? []).some((t: any) => t.name === "travel"), "travel not listed");
    const moved = await plain.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("plain-MCP travel ACTUALLY WORKS (was always -32002)",
      !moved.result?.isError && /(Arrived in|Founded and entered) "annex"/.test(txt(moved)), txt(moved));
    plain.ws.close();

    // …and the credential still gates it. Authority moved from a capability
    // plain MCP cannot hold to the credential it does hold — it did not vanish.
    const plainBound = await connectPlain("bound-token");  // no `worlds` policy
    await sleep(1200);
    const refused = await plainBound.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("plain-MCP travel still obeys the join policy",
      refused.result?.isError === true && /not in this credential's join policy/.test(txt(refused)), txt(refused));
    const noCreate = await plainBound.request("tools/call", { name: "travel", arguments: { world: "never-made" } });
    check("plain-MCP founding still needs create authority",
      noCreate.result?.isError === true, txt(noCreate));
    check("…and refused founding left nothing on disk", !existsSync(join(worldsDir, "never-made")));
    plainBound.ws.close();
  }

  // ── 4j. THE FIX FOR #1 MUST NOT WIDEN MCPL AUTHORITY ─────────────────────
  // Relaxing the capability gate for plain-MCP hosts is only safe if an MCPL
  // host that DECLARES mcpl but is denied channels.lifecycle is still refused.
  // Reading `this.mcplClient && !granted(...)` and believing it is exactly the
  // habit that shipped the original bug, so: prove it.
  {
    const stingy = await connectHost("roamer-token");
    await sleep(1200);
    // Re-declare an effective capability set WITHOUT channels.lifecycle.
    await stingy.request("featureSets/update", {
      effectiveCapabilities: ["tools", "channels.register", "channels.publish", "channels.incoming"],
    });
    const denied2 = await stingy.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("MCPL host WITHOUT channels.lifecycle is still refused (#1 did not widen)",
      denied2.result?.isError === true && /capability denied/.test(txt(denied2)), txt(denied2));
    const where = await stingy.request("channels/list", {});
    check("…and that refusal moved nothing", where.result?.channels?.[0]?.id === "world:commons", JSON.stringify(where.result));
    stingy.ws.close();

    // 🔴 DISCRIMINATING HALF. The check above passes even for a mutant that
    // changed `this.mcplClient &&` to `true &&`, because the refusal message
    // would be identical. What distinguishes the branch is that the SAME
    // credential, declared as PLAIN MCP, must SUCCEED — capability-denied is a
    // property of the host class, not of the token.
    const samecred = await connectPlain("roamer-token");
    await sleep(1200);
    const plainOk = await samecred.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("…while the SAME credential as plain-MCP travels fine (the mcplClient conjunct is load-bearing)",
      !plainOk.result?.isError && /(Arrived in|Founded and entered) "annex"/.test(txt(plainOk)), txt(plainOk));
    samecred.ws.close();
  }

  // ── 4k. the door must be OPEN in the new world (state-desync regression) ──
  // channelOpen was session-long, but the new world's descriptor announces
  // initiallyOpen:true — so an agent who closed their door and then travelled
  // arrived with it shut while the host had been told otherwise, and nothing
  // reconciled them. Per-world state, like the chat cursor.
  {
    const shutter = await connectHost("roamer-token");
    await sleep(1200);
    await shutter.request("channels/close", { channelId: "world:commons" });
    const moved2 = await shutter.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("travel after closing the door still arrives", !moved2.result?.isError, txt(moved2));
    // The door being open again is observable: a plain re-open of the CURRENT
    // channel succeeds and reports the channel the host was promised.
    const reopened = await shutter.request("channels/open", { type: "world", address: { world: "annex" } });
    check("…and the new world's door is OPEN, as its descriptor promised the host",
      reopened.result?.channel?.id === "world:annex" && reopened.result?.channel?.initiallyOpen === true,
      JSON.stringify(reopened.result?.channel));
    shutter.ws.close();
  }

  // ── 5. attach failure → -32024 and the connection surfaces CLOSED ─────────
  // (last: it kills the sequencer)
  const victim = await connectHost("roamer-token");
  await sleep(1200);
  world.kill();                        // the sequencer goes away mid-session
  await sleep(500);
  const failed = await victim.request("tools/call", { name: "travel", arguments: { world: "annex" } });  // exists, so this tests ATTACH failure
  // The TOOL lane reports failure as isError + text (the MCP contract), not as
  // a JSON-RPC error code — but it must say plainly that the seat is gone, or
  // an agent would keep issuing verbs into a closed connection. The -32024 code
  // is still what the channels/open lane returns; both end in the same close.
  check("attach failure is reported, and names the closure",
    failed.result?.isError === true
    && /past the point of no return/.test(txt(failed))
    && /CLOSED/.test(txt(failed)), txt(failed));
  const closed = await new Promise<boolean>((res) => {
    if (victim.ws.readyState === WebSocket.CLOSED) return res(true);
    victim.ws.onclose = () => res(true);
    setTimeout(() => res(victim.ws.readyState === WebSocket.CLOSED), 4000);
  });
  check("never half-attached: connection surfaced as closed", closed);
} finally {
  // Verified termination: kill(), then AWAIT the exit. `kill()` alone returns
  // immediately, so the old teardown could return while children still held
  // ports and were mid-write — which is how a zero-byte state.json.tmp
  // survived a run. Escalate to SIGKILL rather than hang the suite.
  for (const [name, child] of [["world", world], ["door", mcpl]] as const) {
    try { child.kill(); } catch { /* already gone */ }
    const outcome = await Promise.race([
      child.exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5000)),
    ]);
    if (outcome === "timeout") {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      await Promise.race([child.exited, new Promise((r) => setTimeout(r, 2000))]);
    }
    check(`${name} child terminated`, child.exitCode !== null || child.signalCode !== null,
      "still running after SIGTERM+SIGKILL");
  }

  // 🔴 SOURCE-TREE CLEANLINESS. The whole point of MCPL_STATE. A run that
  // mutates repository state is not a receipt, it is contamination — and its
  // leftovers are indistinguishable from a real failure to the next reader.
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

  try { rmSync(worldsDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
