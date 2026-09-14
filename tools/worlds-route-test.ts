// worlds-route-test — GET /worlds, actually fetched: the discovery map the
// `worlds` tool reads before an agent decides where to `travel`.
//
//   bun tools/worlds-route-test.ts
//
// One real sequencer on a verified-free port with a scratch WORLDS_DIR:
//   A. on-disk worlds with a log are listed, junk dirs and log-less dirs are not
//   B. a joined body shows under its world; a spectator shows as nothing
//   C. a world that exists only because it was LOADED still lists
//   D. /worlds never founds a world (asking for the map leaves it unchanged)
// Port discipline per the stale-listener incident: nonce file served from
// THIS tree before any assertion counts.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

const REPO = join(import.meta.dir, "..");
const children: ChildProcess[] = [];
const nonces: string[] = [];
process.on("exit", () => {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  for (const n of nonces) { try { rmSync(n); } catch { /* ok */ } }
});

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const cand = 20000 + Math.floor(Math.random() * 20000);
    try { await fetch(`http://127.0.0.1:${cand}/`, { signal: AbortSignal.timeout(400) }); }
    catch { return cand; }
  }
  throw new Error("no free port");
}

const worldsDir = mkdtempSync(join(tmpdir(), "worlds-route-"));
// on disk: two real worlds, one dir with no log (never a world), one junk name
for (const n of ["commons", "annex"]) {
  mkdirSync(join(worldsDir, n), { recursive: true });
  writeFileSync(join(worldsDir, n, "log.jsonl"), JSON.stringify({ seq: 0, ts: 0, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } }) + "\n");
}
mkdirSync(join(worldsDir, "logless"), { recursive: true });
mkdirSync(join(worldsDir, ".clientlogs"), { recursive: true });

async function spawnServer(): Promise<{ port: number }> {
  const port = await freePort();
  const nonce = `wr-nonce-${crypto.randomUUID().slice(0, 8)}`;
  const noncePath = join(REPO, "client", `${nonce}.txt`);
  writeFileSync(noncePath, nonce); nonces.push(noncePath);
  const child = spawn(process.execPath, [join(REPO, "server", "server.ts")], {
    env: { HOME: process.env.HOME, PATH: process.env.PATH, PORT: String(port), WORLDS_DIR: worldsDir },
    stdio: "ignore",
  });
  children.push(child);
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  const own = await fetch(`http://127.0.0.1:${port}/${nonce}.txt`).then((r) => r.ok && r.text()).catch(() => false);
  if (own !== nonce) throw new Error(`listener on :${port} is not our child — refusing to test it`);
  return { port };
}

type Row = { name: string; loaded: boolean; people: string[]; agents: string[] };
const fetchWorlds = async (port: number) => {
  const r = await fetch(`http://127.0.0.1:${port}/worlds`);
  return { res: r, rows: ((await r.json()) as { worlds: Row[] }).worlds };
};
const byName = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.name, r]));

/** Join a world over the raw ws and wait for the snapshot. */
function joinBody(port: number, world: string, id: string, extra: Record<string, unknown> = {}): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const t = setTimeout(() => rej(new Error(`join ${id}@${world} timed out`)), 8000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, id, avatar: "", ...extra }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "snapshot") { clearTimeout(t); res(ws); }
      if (m.type === "error") { clearTimeout(t); rej(new Error(m.error)); }
    };
  });
}

const { port } = await spawnServer();

console.log("\n— A. on-disk worlds —");
{
  const { res, rows } = await fetchWorlds(port);
  const names = rows.map((r) => r.name);
  check("content-type json, no-store", res.headers.get("content-type")?.includes("json") === true && res.headers.get("cache-control") === "no-store");
  check("both logged worlds listed", names.includes("commons") && names.includes("annex"), names.join(","));
  check("a dir with no log is not a world", !names.includes("logless"), names.join(","));
  check("dot-dirs are not worlds", !names.some((n) => n.startsWith(".")), names.join(","));
  check("sorted by name", JSON.stringify(names) === JSON.stringify([...names].sort()), names.join(","));
  check("unloaded on-disk world says so, empty", rows.every((r) => r.loaded === false && r.people.length === 0 && r.agents.length === 0), JSON.stringify(rows));
}

console.log("\n— B. presence —");
{
  const alice = await joinBody(port, "annex", "alice");
  const bot = await joinBody(port, "annex", "bot", { agent: true });
  const ghost = await joinBody(port, "commons", "ghost", { spectate: true });
  await new Promise((r) => setTimeout(r, 200));
  const m = byName((await fetchWorlds(port)).rows);
  check("annex now loaded", m.annex?.loaded === true, JSON.stringify(m.annex));
  check("a person lists under people", JSON.stringify(m.annex?.people) === JSON.stringify(["alice"]), JSON.stringify(m.annex));
  check("an agent lists under agents, not people", JSON.stringify(m.annex?.agents) === JSON.stringify(["bot"]), JSON.stringify(m.annex));
  check("a spectator appears as nothing", m.commons?.people.length === 0 && m.commons?.agents.length === 0, JSON.stringify(m.commons));
  alice.close(); bot.close(); ghost.close();
  await new Promise((r) => setTimeout(r, 300));
  const after = byName((await fetchWorlds(port)).rows);
  check("leaving empties the row (still loaded)", after.annex?.loaded === true && after.annex?.people.length === 0 && after.annex?.agents.length === 0, JSON.stringify(after.annex));
}

console.log("\n— C. loaded-only worlds list; D. the map never founds —");
{
  // join founds "fresh" in memory; its log lands on first append/flush —
  // the route must list it from the registry regardless
  const w = await joinBody(port, "fresh", "founder");
  await new Promise((r) => setTimeout(r, 200));
  const m = byName((await fetchWorlds(port)).rows);
  check("a world that exists only as loaded state is listed", m.fresh?.loaded === true, Object.keys(m).join(","));
  w.close();
  const before = readdirSync(worldsDir).sort();
  await fetch(`http://127.0.0.1:${port}/worlds?world=never-made`);
  await fetch(`http://127.0.0.1:${port}/worlds`);
  const afterDirs = readdirSync(worldsDir).sort();
  check("/worlds creates nothing on disk", JSON.stringify(before) === JSON.stringify(afterDirs), afterDirs.join(","));
  check("no phantom world from the query string", !(await fetchWorlds(port)).rows.some((r) => r.name === "never-made"));
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(worldsDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
