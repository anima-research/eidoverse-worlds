// RFC-005 channel join — integration test. Starts its own world + MCPL door on
// temp ports with a temp tokens file, then exercises all four outcomes:
//   1. join DENIED (-32017) for a credential with no worlds policy (status quo)
//   2. join GRANTED for a credential with worlds: ["*"] — response carries the
//      new channel descriptor, and a channels/changed Request retires the old
//   3. unknown channelId form → -32023 (spec code, not legacy -32004)
//   4. dial-time ?world= honored under the same policy
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WPORT = 8957, MPORT = 8958;
const worldsDir = mkdtempSync(join(tmpdir(), "eido-join-"));
const tokensPath = join(worldsDir, "tokens.json");
writeFileSync(tokensPath, JSON.stringify({
  "bound-token":   { id: "bound",   name: "Bound",   world: "commons" },
  "roamer-token":  { id: "roamer",  name: "Roamer",  world: "commons", worlds: ["*"] },
  "roamer2-token": { id: "roamer2", name: "Roamer2", world: "commons", worlds: ["annex"] },
}));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};

const world = Bun.spawn([process.execPath, "server/server.ts"], {
  env: { ...process.env, PORT: String(WPORT), WORLDS_DIR: worldsDir },
  stdout: "ignore", stderr: "ignore",
});
const mcpl = Bun.spawn([process.execPath, "mcpl/net-server.ts"], {
  env: { ...process.env, MCPL_PORT: String(MPORT), WORLD_URL: `ws://127.0.0.1:${WPORT}/ws`, MCPL_TOKENS: tokensPath },
  stdout: "ignore", stderr: "ignore",
});

/** Minimal MCPL 0.5 host: initialize, grant, then request/notification I/O. */
async function connectHost(token: string, query = "") {
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
    if (m.id !== undefined && m.method) rpc({ jsonrpc: "2.0", id: m.id, result: {} }); // ack server Requests
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

try {
  await sleep(2500);

  // ── 1. no policy → deny, and the session survives the refusal ─────────────
  const bound = await connectHost("bound-token");
  await sleep(1200);
  const denied = await bound.request("channels/open", { type: "world", address: { world: "annex" } });
  check("unpoliced join denied with -32017", denied.error?.code === -32017, JSON.stringify(denied));
  const still = await bound.request("channels/list", {});
  check("denied session still attached to commons", still.result?.channels?.[0]?.id === "world:commons", JSON.stringify(still.result));

  // ── 3. unknown channelId form → -32023 ────────────────────────────────────
  const unk = await bound.request("channels/open", { channelId: "discord:#nope" });
  check("unknown channel is -32023 (not legacy -32004)", unk.error?.code === -32023, JSON.stringify(unk));
  bound.ws.close();

  // ── 2. worlds:["*"] → join granted, descriptor + changed ─────────────────
  const commonsWatch = await watchWorld("commons", "watcher");
  const roamer = await connectHost("roamer-token");
  await sleep(1200);
  const joined = await roamer.request("channels/open", { type: "world", address: { world: "annex" }, history: { limit: 5 } });
  check("policied join returns the NEW channel descriptor", joined.result?.channel?.id === "world:annex", JSON.stringify(joined));
  await sleep(800);
  const changed = roamer.inbound.find((m) => m.method === "channels/changed");
  check("channels/changed retires old world, adds new",
    changed?.params?.removed?.includes("world:commons") && changed?.params?.added?.[0]?.id === "world:annex",
    JSON.stringify(changed?.params));
  const after = await roamer.request("channels/list", {});
  check("channels/list agrees the session moved", after.result?.channels?.[0]?.id === "world:annex", JSON.stringify(after.result));
  // …and the same-channel open keeps its old meaning post-join
  const reopen = await roamer.request("channels/open", { type: "world", address: { world: "annex" } });
  check("current-channel open still plain-opens", reopen.result?.channel?.id === "world:annex", JSON.stringify(reopen));
  // atomicity, world-side: the commons watcher saw the body actually LEAVE
  await sleep(600);
  const left = commonsWatch.events.some((m) => (m.type === "leave" || m.type === "part" || m.type === "left") && (m.id === "roamer" || m.who === "roamer"));
  const ghost = commonsWatch.events.filter((m) => m.type === "say" && m.id === "roamer").length;
  check("old world saw the body leave (no dual presence)", left, "leave-ish events: " + JSON.stringify(commonsWatch.events.map((m) => m.type).slice(-12)) + ` ghost says: ${ghost}`);
  commonsWatch.ws.close();
  // in-session denial for a LISTED credential asking outside its list
  const roamer2 = await connectHost("roamer2-token");
  await sleep(1200);
  const outside = await roamer2.request("channels/open", { type: "world", address: { world: "elsewhere" } });
  check("worlds:[annex] credential denied for other worlds", outside.error?.code === -32017, JSON.stringify(outside));
  roamer2.ws.close();

  // ── 4. dial-time ?world= under the same policy ────────────────────────────
  const dialed = await connectHost("roamer2-token", "&world=annex");
  await sleep(1200);
  const dl = await dialed.request("channels/list", {});
  check("?world= honored for a policied credential", dl.result?.channels?.[0]?.id === "world:annex", JSON.stringify(dl.result));
  dialed.ws.close();
  const fallback = await connectHost("bound-token", "&world=annex");
  await sleep(1200);
  const fb = await fallback.request("channels/list", {});
  check("?world= falls back to minted world when unpoliced", fb.result?.channels?.[0]?.id === "world:commons", JSON.stringify(fb.result));
  fallback.ws.close();

  // ── 5. attach failure → -32024 and the connection surfaces CLOSED ─────────
  // (last: it kills the sequencer)
  const victim = await connectHost("roamer-token");
  await sleep(1200);
  world.kill();                        // the sequencer goes away mid-session
  await sleep(500);
  const failed = await victim.request("channels/open", { type: "world", address: { world: "faraway" } });
  check("attach failure is -32024", failed.error?.code === -32024, JSON.stringify(failed));
  const closed = await new Promise<boolean>((res) => {
    if (victim.ws.readyState === WebSocket.CLOSED) return res(true);
    victim.ws.onclose = () => res(true);
    setTimeout(() => res(victim.ws.readyState === WebSocket.CLOSED), 4000);
  });
  check("never half-attached: connection surfaced as closed", closed);
} finally {
  world.kill(); mcpl.kill();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
