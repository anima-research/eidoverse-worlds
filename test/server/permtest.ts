// Permission test matrix, the protocol-neutral legs: reserved agent names at the join, and the upload door's
// credentials. Self-booting: a scratch sequencer on a free port with its own WORLDS_DIR, OPT_DIR and agent
// enrolments (AGENT_TOKENS_PATH), so nothing depends on the checkout's mcpl/tokens.json.
//
//   bun test/server/permtest.ts
//
// Roles (the door's @world roles:<id> records) are tested in test/protocol/server-check.ts and test/protocol/identity-check.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundWorlds, freePort, sleep } from "../harness/harness.ts";
import { helloOf } from "../../shared/protocol/hello.js";

const DOOR = "test-door";
const scratch = mkdtempSync(join(tmpdir(), "ew-permtest-"));
const worlds = join(scratch, "worlds");
foundWorlds(worlds, ["permtest"]);
const tokensPath = join(scratch, "tokens.json");
await Bun.write(tokensPath, JSON.stringify({ "permtest-cl-bearer": { id: "claude" } }));
const PORT = freePort(9440);
const HTTP = `http://127.0.0.1:${PORT}`;
const srv = Bun.spawn([process.execPath, join(import.meta.dir, "..", "..", "server", "server.ts")], {
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worlds, OPT_DIR: join(scratch, "opt"), JOIN_TOKEN: DOOR,
    AGENT_TOKENS_PATH: tokensPath, SKIP_OPT_SWEEP: "1" },
  stdout: "ignore", stderr: "ignore",
});
let up = false;
// up = the door answers at all: with JOIN_TOKEN set, /worlds is behind the door (401)
for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`${HTTP}/worlds`)).status < 500; } catch {} if (!up) await sleep(150); }

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
type Sock = { ws: WebSocket; msgs: any[]; errors: string[]; closedWith: number | null };
const open = (joinMsg: Record<string, unknown>) => new Promise<Sock>((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const s: Sock = { ws, msgs: [], errors: [], closedWith: null };
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: "permtest", token: DOOR, replica: true, ...joinMsg }));
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); s.msgs.push(m); if (m.type === "error") s.errors.push(m.error); };
  ws.onclose = (ev) => { s.closedWith = ev.code; };
  setTimeout(() => resolve(s), 600);   // resolve regardless — rejection cases inspect closedWith
});

try {
  if (!up) throw new Error("scratch sequencer never came up");
  console.log("1. reserved agent names");
  {
    const fake = await open({ id: "claude" });
    check("an enrolled agent's name without its bearer is refused", fake.closedWith === 4004 || fake.errors.some((e) => e.includes("reserved")), JSON.stringify([fake.closedWith, fake.errors]));
    const real = await open({ id: "claude", agentToken: "permtest-cl-bearer", declares: "agent" });
    const snap = real.msgs.find((m) => m.type === "snapshot");
    check("the enrolled agent with its own bearer joins under its name", snap?.you === "claude", JSON.stringify(snap?.you ?? real.errors));
    check("…and is flagged an agent with a directory identity", /^u-/.test(snap?.actor ?? ""), snap?.actor);
    const other = await open({ id: "claude", agentToken: "not-a-bearer", declares: "agent" });
    check("a wrong bearer for the name is refused", other.closedWith === 4004, JSON.stringify([other.closedWith, other.errors]));
    for (const s of [fake, real, other]) try { s.ws.close(); } catch { /* closed */ }
  }

  console.log("2. the upload door's credentials");
  {
    const glb = new Uint8Array(16); new DataView(glb.buffer).setUint32(0, 0x46546c67, true);   // a glTF header
    const up = (q: string) => fetch(`${HTTP}/upload?${q}`, { method: "POST", body: glb });
    check("a wrong token is refused (401)", (await up("token=wrong")).status === 401);
    const agent = await up("token=permtest-cl-bearer&by=claude");
    check("an enrolled agent's bearer is accepted", agent.status === 200, `${agent.status}`);
    const door = await up(`token=${DOOR}`);
    check("the door key is accepted", door.status === 200, `${door.status}`);
  }
} finally {
  srv.kill();
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
