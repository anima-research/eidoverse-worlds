// chatbridge-test — the Discord chat bridge (tools/chatbridge) against an owned scratch world, Discord played by
// the bridge's own DRY_RUN (stdin lines "Name: text" are Discord messages; world lines print as "→ discord [who]").
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/chatbridge-test.ts
//
// The world speaks the protocol: the bridge must join with replica, read chat from the log stream's `say` entries
// (actors are opaque ids, named by the stream), and speak through a door `say` request.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, foundWorlds, freePort, sleep, saysIn } from "./harness.ts";

const BRIDGE = process.env.CHATBRIDGE ?? "tools/chatbridge/index.ts";   // another build, for a red-first control
const W = mkdtempSync(join(tmpdir(), "ew-chatbridge-"));
foundWorlds(W, ["commons"]);
const PORT = freePort(9720);
const srv = Bun.spawn([process.execPath, "server/server.ts"], { cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: W, JOIN_TOKEN: "", SKIP_OPT_SWEEP: "1" }, stdout: "ignore", stderr: "ignore" });
let bridge: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
const done = (code: number) => { try { bridge?.kill(); } catch {} try { srv.kill(); } catch {} rmSync(W, { recursive: true, force: true }); process.exit(code); };
let up = false;
for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/worlds`)).status < 500   /* up = the door answers; with JOIN_TOKEN /worlds is 401 (public reads gated 10-14) */; } catch {} if (!up) await sleep(150); }
if (!up) { console.error("scratch server never came up"); done(2); }

const join_ = (id: string) => new Promise<{ ws: WebSocket; msgs: any[] }>((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); const msgs: any[] = [];
  const t = setTimeout(() => rej(new Error(`${id} join timed out`)), 8000);
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); msgs.push(m); if (m.type === "snapshot") { clearTimeout(t); res({ ws, msgs }); } if (m.type === "error") { clearTimeout(t); rej(new Error(m.error)); } };
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: "commons", id, replica: true }));
});
const say = (c: { ws: WebSocket }, text: string) => c.ws.send(JSON.stringify({ type: "request", id: `t-${Math.random()}`, verb: "say", args: { text } }));

let pass = 0, fail = 0;
const check = (what: string, c: boolean, detail = "") => { if (c) pass++; else fail++; console.log(`  ${c ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${what}${!c && detail ? `  — ${detail}` : ""}`); };

const alice = await join_("alice");
say(alice, "before the bridge (history: must not be mirrored)");
await sleep(300);
bridge = Bun.spawn([process.execPath, BRIDGE], { cwd: ROOT,
  env: { ...process.env, DRY_RUN: "1", WORLD_URL: `ws://127.0.0.1:${PORT}/ws`, WORLD_NAME: "commons", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  stdin: "pipe", stdout: "pipe", stderr: "pipe" });
let out = "";
(async () => { for await (const c of bridge!.stdout) out += Buffer.from(c).toString(); })();
for (let i = 0; i < 40 && !/joined "commons"/.test(out); i++) await sleep(100);
say(alice, "hello from the world");
bridge.stdin.write("Ann: hi from discord\n"); bridge.stdin.flush();
for (let i = 0; i < 40 && !(/→ discord \[alice\]/.test(out) && saysIn(alice.msgs).some((x) => x.actor === "discord")); i++) await sleep(100);
await sleep(500);   // room for a wrongly echoed line to show up

console.log("\nchatbridge — world ⇄ Discord (DRY_RUN) on a world\n");
check('the bridge joins (replica) embodied, as "discord"', /joined "commons" as discord/.test(out), out.slice(-300));
check("a world say reaches Discord, attributed to its speaker's display name (not the opaque id)", /→ discord \[alice\]: hello from the world/.test(out), out.slice(-300));
check("history from before the join is not mirrored", !/before the bridge/.test(out));
check("a Discord line enters the world as the bridge's door say, attributed inside the text", saysIn(alice.msgs).some((x) => x.actor === "discord" && x.text === "Ann: hi from discord"), JSON.stringify(saysIn(alice.msgs)));
check("the bridge's own say is not echoed back to Discord", !/→ discord \[discord\]/.test(out) && !/hi from discord\n.*→ discord/.test(out));
check("nothing was refused", !/refused/.test(out), out.slice(-300));
console.log(`\n${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);
