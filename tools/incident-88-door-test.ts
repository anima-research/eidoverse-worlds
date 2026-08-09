// Does the DOOR actually refuse, at the surface a resident touches?
//
// The shipped incident test calls `rawShapeError` directly — a unit test of a
// pure function. Nothing exercises `world_verb`'s wiring, and nothing checks
// the string a resident gets back. Sill's clause is about exactly that string:
// "the tool/result must not say merely `sent place`".
//
// So: boot a world + the real MCPL door, connect a raw MCP host, and read the
// tool result for (a) the exact incident packet and (b) a well-formed place.
// A raw world watcher confirms nothing entered history on the refusal.
//
//   EIDOVERSE_DIR=... WPORT=8908 MPORT=8909 bun tools/incident-88-door-test.ts

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WPORT = Number(process.env.WPORT ?? 8908);
const MPORT = Number(process.env.MPORT ?? 8909);
const worldsDir = mkdtempSync(join(tmpdir(), "eido-i89door-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${extra ? `  — ${extra}` : ""}`);
  ok ? pass++ : fail++;
};

const world = Bun.spawn(["bun", "server/server.ts"], {
  env: { ...process.env, PORT: String(WPORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: "", VERB_RATE: "5000" },
  stdout: "ignore", stderr: "ignore",
});
const mcpl = Bun.spawn(["bun", "mcpl/net-server.ts"], {
  env: { ...process.env, MCPL_PORT: String(MPORT), WORLD_URL: `ws://127.0.0.1:${WPORT}/ws` },
  stdout: "ignore", stderr: "ignore",
});

try {
  await sleep(3000);

  // raw world watcher: what actually enters history
  const seen: any[] = [];
  const watcher = new WebSocket(`ws://127.0.0.1:${WPORT}/ws`);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("watcher join timeout")), 8000);
    watcher.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); seen.push(m);
      if (m.type === "snapshot") { clearTimeout(t); res(); } };
    watcher.onopen = () => watcher.send(JSON.stringify({ type: "join", world: "commons", id: "i89-watcher", avatar: "a.vrm" }));
  });

  const host = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=dev-token`);
  const pending = new Map<number, (m: any) => void>();
  let nextId = 10;
  const call = (name: string, args: any) => new Promise<any>((res, rej) => {
    const id = nextId++;
    pending.set(id, res);
    setTimeout(() => rej(new Error(`rpc ${name} timeout`)), 8000);
    host.send(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }));
  });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("mcpl init timeout")), 8000);
    host.onopen = () => host.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: { experimental: { mcpl: {} } }, clientInfo: { name: "i89", version: "0" } } }));
    host.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === 1) { host.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })); clearTimeout(t); return res(); }
      const w = pending.get(m.id); if (w) { pending.delete(m.id); w(m); }
    };
  });
  await sleep(2000);

  const textOf = (m: any) => String(m?.result?.content?.[0]?.text ?? JSON.stringify(m).slice(0, 200));

  // something to place
  const spawned = await call("world_verb", { verb: "spawn", args: { id: "tower", lib: "eidoverse/assets/models/crate_large_red.glb", pos: [3, 0, 0], yaw: 0 } });
  console.log(`     spawn -> ${textOf(spawned)}`);
  await sleep(800);

  // ---- the exact incident packet, through the real door -------------------
  seen.length = 0;
  const bad = await call("world_verb", { verb: "place", args: { id: "tower", x: 15, y: 0, z: -7, yaw: 2.4, scale: 0.5 } });
  const badText = textOf(bad);
  await sleep(800);
  check("the incident packet does NOT come back as `sent place`", !/^sent place/.test(badText), badText);
  check("...it comes back as an explicit refusal", /refused/.test(badText), badText);
  check("...and the refusal is machine-legible as an error", bad?.result?.isError === true, `isError=${bad?.result?.isError}`);
  check("...naming the shape the log wants", badText.includes("pos:[x,y,z]"), badText);
  const entered = seen.filter((m) => m.type === "log" && m.entry?.verb === "place");
  check("...and nothing entered history", entered.length === 0, `entries=${entered.length}`);

  // ---- the well-formed control -------------------------------------------
  seen.length = 0;
  const good = await call("world_verb", { verb: "place", args: { id: "tower", pos: [-4, 0, 0], yaw: 2.4, scale: 0.5 } });
  const goodText = textOf(good);
  await sleep(800);
  check("a well-formed raw place still passes the door", /^sent place/.test(goodText), goodText);
  const landed = seen.filter((m) => m.type === "log" && m.entry?.verb === "place");
  check("...and DOES enter history", landed.length >= 1, `entries=${landed.length}`);

  watcher.close(); host.close();
} catch (e) {
  fail++;
  console.log(`\x1b[31mFATAL\x1b[0m ${(e as Error).message}\n${(e as Error).stack}`);
} finally {
  world.kill(); mcpl.kill();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
